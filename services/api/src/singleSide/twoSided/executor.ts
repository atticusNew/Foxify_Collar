/**
 * Strangle executor interface.
 *
 * PR 3 (this PR) defines the interface and ships a MockStrangleExecutor for tests.
 * PR 5 implements the real RoutedStrangleExecutor against Bullish + Deribit.
 *
 * The executor is injected into the activate route so PR 3 can be tested end-to-end
 * without touching live venues.
 */

import type { Venue } from "./types";

export type LegExecutionRequest = {
  venue: Venue;
  symbol: string;
  strikeUsdc: number;
  contractsBtc: number;
  maxAcceptableAskUsdcPerBtc: number;  // do not pay more than this per BTC
  legRole: "long_put" | "long_call";
};

export type LegExecutionResult = {
  ok: true;
  filledAskUsdcPerBtc: number;
  filledAtIso: string;
} | {
  ok: false;
  reason: "venue_error" | "ask_exceeded" | "depth_insufficient" | "timeout" | "halted";
  detail: string;
};

export type StrangleOrder = {
  pairId: string;
  putLeg: LegExecutionRequest;
  callLeg: LegExecutionRequest;
};

export type StrangleExecutionResult = {
  ok: true;
  putLeg: { filledAskUsdcPerBtc: number; filledAtIso: string };
  callLeg: { filledAskUsdcPerBtc: number; filledAtIso: string };
} | {
  ok: false;
  reason: "put_failed" | "call_failed" | "both_failed";
  putLegResult: LegExecutionResult;
  callLegResult: LegExecutionResult;
};

export type StrangleExecutor = {
  executeStrangle: (order: StrangleOrder) => Promise<StrangleExecutionResult>;
};

// ─── Mock implementation for tests ───

export type MockExecutorBehavior = {
  /** If set, force this leg to fail with the given reason. */
  failPutLeg?: { reason: LegExecutionResult & { ok: false }; detail: string };
  failCallLeg?: { reason: LegExecutionResult & { ok: false }; detail: string };
  /** Pretend the fill came in at this offset from max acceptable (1.0 = exactly at cap, 0.95 = 5% better). */
  fillPriceMultiplier?: number;
};

export class MockStrangleExecutor implements StrangleExecutor {
  constructor(private readonly behavior: MockExecutorBehavior = {}) {}

  async executeStrangle(order: StrangleOrder): Promise<StrangleExecutionResult> {
    const now = new Date().toISOString();
    const mult = this.behavior.fillPriceMultiplier ?? 1.0;

    const putResult: LegExecutionResult = this.behavior.failPutLeg
      ? { ok: false, reason: "venue_error", detail: this.behavior.failPutLeg.detail }
      : { ok: true, filledAskUsdcPerBtc: order.putLeg.maxAcceptableAskUsdcPerBtc * mult, filledAtIso: now };

    const callResult: LegExecutionResult = this.behavior.failCallLeg
      ? { ok: false, reason: "venue_error", detail: this.behavior.failCallLeg.detail }
      : { ok: true, filledAskUsdcPerBtc: order.callLeg.maxAcceptableAskUsdcPerBtc * mult, filledAtIso: now };

    if (!putResult.ok && !callResult.ok) {
      return { ok: false, reason: "both_failed", putLegResult: putResult, callLegResult: callResult };
    }
    if (!putResult.ok) {
      return { ok: false, reason: "put_failed", putLegResult: putResult, callLegResult: callResult };
    }
    if (!callResult.ok) {
      return { ok: false, reason: "call_failed", putLegResult: putResult, callLegResult: callResult };
    }
    return {
      ok: true,
      putLeg: { filledAskUsdcPerBtc: putResult.filledAskUsdcPerBtc, filledAtIso: putResult.filledAtIso },
      callLeg: { filledAskUsdcPerBtc: callResult.filledAskUsdcPerBtc, filledAtIso: callResult.filledAtIso }
    };
  }
}
