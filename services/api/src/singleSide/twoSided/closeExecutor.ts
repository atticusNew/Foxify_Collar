/**
 * Close executor — sells the strangle legs at TP-decided exit.
 *
 * Interface keeps PR 5 testable without live venue credentials. Two
 * implementations ship in Phase 0:
 *
 *   - MockCloseExecutor (tests; fills at requested sell px × optional slip)
 *   - ShadowCloseExecutor (mirrors mock — pair is_shadow=true uses this)
 *
 * Real impl (LiveCloseExecutor) is a follow-up commit that wires the existing
 * VC patterns (bullishSpreadAdapter, fillOptimizer, deep-cross retry, 8s poll
 * ceiling, slippage floor). It's intentionally NOT in this PR because it
 * requires live Bullish/Deribit credentials to validate end-to-end.
 */

import type { LegRole, Venue } from "./types";

export type CloseLegRequest = {
  legRole: LegRole;
  venue: Venue;
  symbol: string;
  contractsBtc: number;
  /** Target sell ask in USDC/BTC; executor may fill below (worse for us). */
  expectedSellPxUsdcPerBtc: number;
  /** Reject any fill below this px (slippage floor). */
  minAcceptablePxUsdcPerBtc: number;
};

export type CloseLegResult =
  | {
      ok: true;
      filledPxUsdcPerBtc: number;
      filledAtIso: string;
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
  putLeg: { filledPxUsdcPerBtc: number; filledAtIso: string };
  callLeg: { filledPxUsdcPerBtc: number; filledAtIso: string };
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

// ─── Mock (tests) ───

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
      return { ok: true, filledPxUsdcPerBtc: px, filledAtIso: now };
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
      putLeg: { filledPxUsdcPerBtc: putR.filledPxUsdcPerBtc, filledAtIso: putR.filledAtIso },
      callLeg: { filledPxUsdcPerBtc: callR.filledPxUsdcPerBtc, filledAtIso: callR.filledAtIso },
      totalProceedsUsdc:
        putR.filledPxUsdcPerBtc * req.putLeg.contractsBtc + callR.filledPxUsdcPerBtc * req.callLeg.contractsBtc
    };
  }
}

// ─── Shadow (used when pair.is_shadow=true) ───

/** Identical to MockCloseExecutor for Phase 0; kept as a distinct class so future
 * shadow-only logic (e.g. PnL logging, alert routing) has a clean home. */
export class ShadowCloseExecutor extends MockCloseExecutor {}

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
