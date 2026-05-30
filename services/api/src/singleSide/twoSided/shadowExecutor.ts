/**
 * Shadow strangle executor.
 *
 * Implements the StrangleExecutor interface but does NOT place real venue orders.
 * Returns "fills" at the live anchor ask prices (which the activate handler
 * passes via maxAcceptableAskUsdcPerBtc). The pair is otherwise treated
 * identically to a live pair throughout the lifecycle:
 *
 *   - Goes through full activate flow (DB writes, events, state transitions)
 *   - Triggers via the canonical Atticus feed (no special handling needed)
 *   - On close, will use a ShadowCloseHandler (delivered in PR 5/4)
 *
 * The only differentiator from live is the `is_shadow=true` flag on the pair
 * row, which downstream components (PR 5 execution, PR 8 dashboard, PR 9
 * guardrails) check to skip real venue calls and to segregate shadow vs live
 * metrics.
 *
 * Use with the activate handler by passing executor=new ShadowStrangleExecutor()
 * and setting request.isShadow=true.
 */

import type { LegExecutionResult, StrangleExecutionResult, StrangleExecutor, StrangleOrder } from "./executor";

export type ShadowOptions = {
  /** Simulated fill slippage vs max acceptable (default 1.0 = fill at exact cap).
   * Lower than 1 means hypothetical "better" fill. */
  fillPriceMultiplier?: number;
  /** Inject a forced failure on shadow legs (e.g. to test alert paths). */
  forceFailReason?: "venue_error" | "depth_insufficient" | "halted";
};

export class ShadowStrangleExecutor implements StrangleExecutor {
  constructor(private readonly opts: ShadowOptions = {}) {}

  async executeStrangle(order: StrangleOrder): Promise<StrangleExecutionResult> {
    const now = new Date().toISOString();
    if (this.opts.forceFailReason) {
      const fail: LegExecutionResult = { ok: false, reason: this.opts.forceFailReason, detail: "shadow_forced_failure" };
      return { ok: false, reason: "both_failed", putLegResult: fail, callLegResult: fail };
    }
    const mult = this.opts.fillPriceMultiplier ?? 1.0;
    return {
      ok: true,
      putLeg: {
        filledAskUsdcPerBtc: order.putLeg.maxAcceptableAskUsdcPerBtc * mult,
        filledAtIso: now
      },
      callLeg: {
        filledAskUsdcPerBtc: order.callLeg.maxAcceptableAskUsdcPerBtc * mult,
        filledAtIso: now
      }
    };
  }
}
