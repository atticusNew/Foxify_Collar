/**
 * Close executor — sells the strangle legs at TP-decided exit.
 *
 * Interface keeps PR 5 testable without live venue credentials. Implementations:
 *
 *   - MockCloseExecutor     — tests; fills at requested sell px × optional slip
 *   - ShadowCloseExecutor   — production for is_shadow=true pairs; uses REAL
 *                              venue bid prices from LiquidChainCache when
 *                              available (falls back to BS-derived expected
 *                              price only when no bid is reachable). This
 *                              produces realistic shadow PnL that matches
 *                              what a live trade would actually receive.
 *   - LiveCloseExecutor     — follow-up commit (placeholder below)
 *
 * Why bid-based shadow matters:
 *   The runtime computes a Black-Scholes "expected" sell price and passes it
 *   in via expectedSellPxUsdcPerBtc. BS uses market-wide IV which often
 *   OVERSTATES bid-side value (vol skew). For shadow pairs this inflates
 *   reported PnL; for live pairs the same inflation would still happen if
 *   we used BS, but live actually transacts so the gap gets exposed instantly.
 *   To make shadow == live we read the real venue bid each time we close.
 */

import type { LegRole, Venue } from "./types";
import type { LiquidChainCache } from "./liquidChainCache";

export type CloseLegRequest = {
  legRole: LegRole;
  venue: Venue;
  symbol: string;
  contractsBtc: number;
  /** Target sell ask in USDC/BTC; executor may fill below (worse for us). */
  expectedSellPxUsdcPerBtc: number;
  /** Reject any fill below this px (slippage floor). */
  minAcceptablePxUsdcPerBtc: number;
  /** Required for bid-based valuation lookup. Runtime always populates these
   * from the leg row. Optional only for back-compat with old call sites. */
  strikeUsdc?: number;
  optType?: "put" | "call";
  tenorRemainingHours?: number;
};

export type ValuationMethod = "venue_bid" | "bs_expected";

export type CloseLegResult =
  | {
      ok: true;
      filledPxUsdcPerBtc: number;
      filledAtIso: string;
      /** How the fill price was derived. Shadow executors surface this so
       * audit can distinguish realistic (venue_bid) vs estimated (bs_expected)
       * PnL. Optional for back-compat with non-shadow implementations. */
      valuationMethod?: ValuationMethod;
      /** Raw venue bid used (if valuationMethod=venue_bid). USDC/BTC. */
      rawVenueBidUsdcPerBtc?: number;
    }
  | {
      ok: false;
      reason: "venue_error" | "min_px_violated" | "timeout" | "halted" | "not_implemented";
      detail: string;
    };

export type CloseStrangleRequest = {
  pairId: string;
  putLeg: CloseLegRequest;
  callLeg: CloseLegRequest;
};

export type CloseStrangleResult = {
  ok: true;
  putLeg: { filledPxUsdcPerBtc: number; filledAtIso: string; valuationMethod?: ValuationMethod; rawVenueBidUsdcPerBtc?: number };
  callLeg: { filledPxUsdcPerBtc: number; filledAtIso: string; valuationMethod?: ValuationMethod; rawVenueBidUsdcPerBtc?: number };
  totalProceedsUsdc: number;
} | {
  ok: false;
  reason: "put_failed" | "call_failed" | "both_failed";
  putLegResult: CloseLegResult;
  callLegResult: CloseLegResult;
};

export type CloseExecutor = {
  closeStrangle: (req: CloseStrangleRequest) => Promise<CloseStrangleResult>;
};

// ─── Mock (tests only — does NOT use bids) ───

export type MockCloseBehavior = {
  fillSlippageMultiplier?: number;  // 1.0 = fill exactly at expected, 0.95 = 5% worse
  failPutLeg?: { reason: "venue_error" | "min_px_violated" | "timeout" | "halted"; detail: string };
  failCallLeg?: { reason: "venue_error" | "min_px_violated" | "timeout" | "halted"; detail: string };
};

export class MockCloseExecutor implements CloseExecutor {
  constructor(private readonly behavior: MockCloseBehavior = {}) {}

  async closeStrangle(req: CloseStrangleRequest): Promise<CloseStrangleResult> {
    const now = new Date().toISOString();
    const slip = this.behavior.fillSlippageMultiplier ?? 1.0;

    const legFill = (leg: CloseLegRequest, forced?: { reason: "venue_error" | "min_px_violated" | "timeout" | "halted"; detail: string }): CloseLegResult => {
      if (forced) return { ok: false, reason: forced.reason, detail: forced.detail };
      const px = leg.expectedSellPxUsdcPerBtc * slip;
      if (px < leg.minAcceptablePxUsdcPerBtc) {
        return { ok: false, reason: "min_px_violated", detail: `fill px ${px} below min ${leg.minAcceptablePxUsdcPerBtc}` };
      }
      return { ok: true, filledPxUsdcPerBtc: px, filledAtIso: now, valuationMethod: "bs_expected" };
    };

    const putR = legFill(req.putLeg, this.behavior.failPutLeg);
    const callR = legFill(req.callLeg, this.behavior.failCallLeg);

    if (!putR.ok && !callR.ok) {
      return { ok: false, reason: "both_failed", putLegResult: putR, callLegResult: callR };
    }
    if (!putR.ok) return { ok: false, reason: "put_failed", putLegResult: putR, callLegResult: callR };
    if (!callR.ok) return { ok: false, reason: "call_failed", putLegResult: putR, callLegResult: callR };
    return {
      ok: true,
      putLeg: { filledPxUsdcPerBtc: putR.filledPxUsdcPerBtc, filledAtIso: putR.filledAtIso, valuationMethod: putR.valuationMethod },
      callLeg: { filledPxUsdcPerBtc: callR.filledPxUsdcPerBtc, filledAtIso: callR.filledAtIso, valuationMethod: callR.valuationMethod },
      totalProceedsUsdc:
        putR.filledPxUsdcPerBtc * req.putLeg.contractsBtc + callR.filledPxUsdcPerBtc * req.callLeg.contractsBtc
    };
  }
}

// ─── Shadow (production for is_shadow=true) ───

export type ShadowCloseExecutorDeps = {
  /**
   * Liquid chain cache for venue-bid lookups. When provided, the executor
   * uses ACTUAL bid prices from Bullish/Deribit for sell-side valuation
   * (matches what a live trade would actually receive). When omitted or
   * cache misses a strike, falls back to expectedSellPxUsdcPerBtc (BS).
   */
  chainCache?: LiquidChainCache | null;
  /** Slippage haircut applied to the venue bid. Default 0.95 (5% slip from
   * top-of-book bid to realistic fill). */
  bidSlippageHaircut?: number;
  /** Max tenor drift when matching bid in chain (hours). Default 36 (1.5d). */
  maxTenorDriftHours?: number;
  /** Test injection: synchronous bid lookup overriding chainCache. */
  bidLookup?: (leg: CloseLegRequest) => number | null;
  /** Optional logger for transparency. */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

const DEFAULT_BID_SLIPPAGE_HAIRCUT = 0.95;

export class ShadowCloseExecutor implements CloseExecutor {
  constructor(private readonly deps: ShadowCloseExecutorDeps = {}) {}

  async closeStrangle(req: CloseStrangleRequest): Promise<CloseStrangleResult> {
    const now = new Date().toISOString();
    const haircut = this.deps.bidSlippageHaircut ?? DEFAULT_BID_SLIPPAGE_HAIRCUT;

    const fillLeg = (leg: CloseLegRequest): CloseLegResult => {
      const bid = this.lookupBidForLeg(leg);
      let fillPx: number;
      let method: ValuationMethod;
      let rawBid: number | undefined;
      if (bid != null && bid > 0) {
        fillPx = bid * haircut;
        method = "venue_bid";
        rawBid = bid;
        this.log(`shadow_close ${leg.legRole}: venue_bid=${bid.toFixed(4)} USDC/BTC × ${haircut} haircut → fill=${fillPx.toFixed(4)} (symbol=${leg.symbol})`);
      } else {
        // No reachable bid — fall back to BS-derived expected (legacy behavior).
        // This is INTENTIONALLY conservative: if we can't get a real bid, we
        // honor the runtime's BS estimate so we don't break unwinding entirely.
        fillPx = leg.expectedSellPxUsdcPerBtc;
        method = "bs_expected";
        this.log(`shadow_close ${leg.legRole}: NO venue bid found (strike=${leg.strikeUsdc} type=${leg.optType} tenor=${leg.tenorRemainingHours}h) — falling back to bs_expected=${fillPx.toFixed(4)} (symbol=${leg.symbol})`);
      }
      if (fillPx < leg.minAcceptablePxUsdcPerBtc) {
        return {
          ok: false,
          reason: "min_px_violated",
          detail: `${method} fill px ${fillPx.toFixed(4)} below min ${leg.minAcceptablePxUsdcPerBtc.toFixed(4)}`
        };
      }
      return {
        ok: true,
        filledPxUsdcPerBtc: fillPx,
        filledAtIso: now,
        valuationMethod: method,
        rawVenueBidUsdcPerBtc: rawBid
      };
    };

    const putR = fillLeg(req.putLeg);
    const callR = fillLeg(req.callLeg);

    if (!putR.ok && !callR.ok) {
      return { ok: false, reason: "both_failed", putLegResult: putR, callLegResult: callR };
    }
    if (!putR.ok) return { ok: false, reason: "put_failed", putLegResult: putR, callLegResult: callR };
    if (!callR.ok) return { ok: false, reason: "call_failed", putLegResult: putR, callLegResult: callR };
    return {
      ok: true,
      putLeg: { filledPxUsdcPerBtc: putR.filledPxUsdcPerBtc, filledAtIso: putR.filledAtIso, valuationMethod: putR.valuationMethod, rawVenueBidUsdcPerBtc: putR.rawVenueBidUsdcPerBtc },
      callLeg: { filledPxUsdcPerBtc: callR.filledPxUsdcPerBtc, filledAtIso: callR.filledAtIso, valuationMethod: callR.valuationMethod, rawVenueBidUsdcPerBtc: callR.rawVenueBidUsdcPerBtc },
      totalProceedsUsdc:
        putR.filledPxUsdcPerBtc * req.putLeg.contractsBtc + callR.filledPxUsdcPerBtc * req.callLeg.contractsBtc
    };
  }

  private lookupBidForLeg(leg: CloseLegRequest): number | null {
    if (this.deps.bidLookup) return this.deps.bidLookup(leg);
    if (!this.deps.chainCache) return null;
    if (leg.strikeUsdc == null || leg.optType == null || leg.tenorRemainingHours == null) {
      return null;
    }
    const got = this.deps.chainCache.getBidForLeg({
      strike: leg.strikeUsdc,
      optType: leg.optType,
      tenorRemainingHours: leg.tenorRemainingHours,
      preferVenue: leg.venue,
      maxTenorDriftHours: this.deps.maxTenorDriftHours
    });
    return got?.bidUsdcPerBtc ?? null;
  }

  private log(msg: string, meta?: Record<string, unknown>): void {
    const fn = this.deps.log ?? ((m, _meta) => console.log(`[shadowCloseExecutor] ${m}`, _meta ?? ""));
    fn(msg, meta);
  }
}

// ─── Live (placeholder for follow-up commit requiring venue credentials) ───

export class NotImplementedLiveCloseExecutor implements CloseExecutor {
  async closeStrangle(_req: CloseStrangleRequest): Promise<CloseStrangleResult> {
    const fail: CloseLegResult = {
      ok: false,
      reason: "not_implemented",
      detail:
        "LiveCloseExecutor is not implemented yet. Wire bullishSpreadAdapter + Deribit close in a follow-up commit. Phase 0 live cutover (PR 11) gates this behind SS_TWO_SIDED_LIVE_ENABLED + venue allowlist."
    };
    return { ok: false, reason: "both_failed", putLegResult: fail, callLegResult: fail };
  }
}
