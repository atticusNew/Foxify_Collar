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

/**
 * How the close fill price was determined.
 *   - "exact_symbol"      → real bid for the specific instrument we hold (best)
 *   - "fuzzy_strike_tenor"→ real bid for a similar instrument (proxy; less accurate)
 *   - "bs_expected"       → BS-derived expected from the runtime (fallback)
 *
 * Backward-compatible alias "venue_bid" is preserved at type level for any
 * older readers; new code should distinguish exact vs fuzzy.
 */
export type ValuationMethod = "exact_symbol" | "fuzzy_strike_tenor" | "bs_expected" | "venue_bid";

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
      const lookup = this.lookupBidForLeg(leg);
      let fillPx: number;
      let method: ValuationMethod;
      let rawBid: number | undefined;
      if (lookup != null) {
        fillPx = lookup.bid * haircut;
        method = lookup.method;
        rawBid = lookup.bid;
        this.log(`shadow_close ${leg.legRole}: ${lookup.method} bid=${lookup.bid.toFixed(4)} USDC/BTC × ${haircut} haircut → fill=${fillPx.toFixed(4)} (symbol=${leg.symbol})`);
      } else {
        // No reachable bid — fall back to BS-derived expected (legacy behavior).
        // This is INTENTIONALLY conservative: if we can't get a real bid, we
        // honor the runtime's BS estimate so we don't break unwinding entirely.
        fillPx = leg.expectedSellPxUsdcPerBtc;
        method = "bs_expected";
        this.log(`shadow_close ${leg.legRole}: NO venue bid found (symbol=${leg.symbol} venue=${leg.venue} strike=${leg.strikeUsdc} type=${leg.optType} tenor=${leg.tenorRemainingHours}h) — falling back to bs_expected=${fillPx.toFixed(4)}`);
      }
      // Floor check: ONLY enforced when using BS-expected fallback.
      //
      // For real venue bids (exact_symbol / fuzzy_strike_tenor) the bid IS the
      // market price. Rejecting it as "below min" doesn't make sense in shadow
      // because we're simulating what the market would pay, not gating live
      // execution. (In LiveCloseExecutor the floor is correct because it
      // catches bad fills / stale books that would lose us real money.)
      //
      // We still require fillPx > 0 to record a sane settlement — a 0 bid
      // would mean "nobody will buy this at any price" which the runtime
      // should treat as a fall-back-to-BS situation, not a successful close.
      const isRealBid = method === "exact_symbol" || method === "fuzzy_strike_tenor";
      if (isRealBid) {
        if (fillPx <= 0) {
          return {
            ok: false,
            reason: "min_px_violated",
            detail: `${method} returned non-positive fill px ${fillPx.toFixed(4)} — treat as no liquidity`
          };
        }
        if (fillPx < leg.minAcceptablePxUsdcPerBtc) {
          this.log(`shadow_close ${leg.legRole}: real-bid fill ${fillPx.toFixed(4)} is below BS-derived floor ${leg.minAcceptablePxUsdcPerBtc.toFixed(4)} — ACCEPTING anyway (real bid is the market). ratio=${(fillPx / leg.minAcceptablePxUsdcPerBtc).toFixed(3)}. This indicates BS theoretical is overstating value relative to live bids (vol skew or stale BS inputs).`);
        }
      } else {
        // BS-expected fallback: still enforce the floor — these numbers are
        // estimates and a too-low estimate means our model is broken.
        if (fillPx < leg.minAcceptablePxUsdcPerBtc) {
          return {
            ok: false,
            reason: "min_px_violated",
            detail: `${method} fill px ${fillPx.toFixed(4)} below min ${leg.minAcceptablePxUsdcPerBtc.toFixed(4)}`
          };
        }
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

  /**
   * Bid lookup strategy (tiered for correctness + safety):
   *   1. EXACT symbol match — the right answer when the chain has fresh
   *      data on the SPECIFIC instrument we hold (e.g. BTC-1JUN26-73000-P).
   *      Returns a true sellable bid.
   *   2. Fuzzy strike+tenor match on the same venue — fallback when the
   *      exact symbol isn't in the snapshot (e.g. chain window doesn't
   *      include this strike, or the fetch was partial). Less accurate
   *      because the matched quote may be a different expiry.
   *   3. null — caller falls back to BS-derived expected.
   *
   * We deliberately split the two paths so the audit trail can record
   * which one fired. "venue_bid" should ideally be "exact_symbol" in
   * practice; if we see lots of "fuzzy_match" in production it tells us
   * the chain window is too narrow.
   */
  private lookupBidForLeg(leg: CloseLegRequest): { bid: number; method: "exact_symbol" | "fuzzy_strike_tenor" } | null {
    if (this.deps.bidLookup) {
      const b = this.deps.bidLookup(leg);
      if (b != null && b > 0) return { bid: b, method: "exact_symbol" };
      return null;
    }
    if (!this.deps.chainCache) return null;
    // Tier 1: exact instrument symbol on the venue we hold the leg on
    const exact = this.deps.chainCache.getBidForSymbol({
      venue: leg.venue,
      instrumentSymbol: leg.symbol
    });
    if (exact && exact.bidUsdcPerBtc > 0) {
      return { bid: exact.bidUsdcPerBtc, method: "exact_symbol" };
    }
    // Tier 2: fuzzy strike+tenor — only if we have the required metadata
    if (leg.strikeUsdc == null || leg.optType == null || leg.tenorRemainingHours == null) {
      return null;
    }
    const fuzzy = this.deps.chainCache.getBidForLeg({
      strike: leg.strikeUsdc,
      optType: leg.optType,
      tenorRemainingHours: leg.tenorRemainingHours,
      preferVenue: leg.venue,
      maxTenorDriftHours: this.deps.maxTenorDriftHours
    });
    if (fuzzy && fuzzy.bidUsdcPerBtc > 0) {
      return { bid: fuzzy.bidUsdcPerBtc, method: "fuzzy_strike_tenor" };
    }
    return null;
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
