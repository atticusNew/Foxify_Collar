/**
 * LiveCloseExecutor — real Bullish + Deribit close (sell) for the unwind path (PR A5).
 *
 * Implements CloseExecutor interface. Replaces the NotImplementedLiveCloseExecutor stub
 * that ships in PR 5.
 *
 * OD-3 partial-fill retry sequence per leg:
 *   Attempt 1: limit-IOC at expectedSellPx (best estimate from TP engine)
 *   Attempt 2: limit-IOC at expectedSellPx × 0.95 (5% deeper cross)
 *   Attempt 3: limit-IOC at minAcceptablePx (slippage floor — last chance)
 *   All-fail: returns failure; runtime emits execution_stuck + escalates to operator
 *
 * Each attempt has 8s poll ceiling (inherited from leg adapter).
 *
 * Concurrent leg execution: both put + call sell run in Promise.all-style.
 * No synthetic perp replacement on partial fail (decided against per OD-3 reasoning).
 */

import type {
  CloseExecutor,
  CloseLegRequest,
  CloseLegResult,
  CloseStrangleRequest,
  CloseStrangleResult
} from "./closeExecutor";
import type { LegExecutionResult } from "./executor";
import type { BullishLegClient, DeribitLegClient } from "./liveStrangleExecutor";

const RETRY_DEEPER_CROSS_MULTIPLIER = 0.95;
const MAX_ATTEMPTS = 3;

export type LiveCloseExecutorOpts = {
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

const safeLog = (opts: LiveCloseExecutorOpts, msg: string, meta?: Record<string, unknown>) => {
  const fn = opts.log ?? ((m, _meta) => console.log(`[liveCloseExecutor] ${m}`, _meta ?? ""));
  fn(msg, meta);
};

/** Convert internal sell adapter result (LegExecutionResult shape, ask-named field) to CloseLegResult. */
const toCloseResult = (r: LegExecutionResult): CloseLegResult => {
  if (r.ok) return { ok: true, filledPxUsdcPerBtc: r.filledAskUsdcPerBtc, filledAtIso: r.filledAtIso };
  // Map LegExecutionResult.reason (5 values) to CloseLegResult.reason (5 values).
  // venue_error/timeout/halted pass through; ask_exceeded + depth_insufficient
  // collapse to venue_error (they don't apply on sell side, but keep type-safe).
  const mappedReason: CloseLegResult & { ok: false } extends infer X ? X extends { reason: infer R } ? R : never : never =
    r.reason === "venue_error" || r.reason === "timeout" || r.reason === "halted"
      ? r.reason
      : "venue_error";
  return { ok: false, reason: mappedReason, detail: r.detail };
};

export class LiveCloseExecutor implements CloseExecutor {
  constructor(
    private readonly bullish: BullishLegClient,
    private readonly deribit: DeribitLegClient,
    private readonly opts: LiveCloseExecutorOpts = {}
  ) {}

  async closeStrangle(req: CloseStrangleRequest): Promise<CloseStrangleResult> {
    // SEQUENTIAL when both legs are Bullish (strictly-increasing nonce per request;
    // concurrent submission races the nonce → "invalid nonce"). Concurrent otherwise.
    const bothBullish = req.putLeg.venue === "bullish" && req.callLeg.venue === "bullish";
    let putR: CloseLegResult;
    let callR: CloseLegResult;
    if (bothBullish) {
      putR = await this.sellLegWithRetry(req.pairId, "put", req.putLeg);
      callR = await this.sellLegWithRetry(req.pairId, "call", req.callLeg);
    } else {
      [putR, callR] = await Promise.all([
        this.sellLegWithRetry(req.pairId, "put", req.putLeg),
        this.sellLegWithRetry(req.pairId, "call", req.callLeg)
      ]);
    }

    if (putR.ok && callR.ok) {
      const totalProceeds =
        putR.filledPxUsdcPerBtc * req.putLeg.contractsBtc + callR.filledPxUsdcPerBtc * req.callLeg.contractsBtc;
      return {
        ok: true,
        putLeg: { filledPxUsdcPerBtc: putR.filledPxUsdcPerBtc, filledAtIso: putR.filledAtIso },
        callLeg: { filledPxUsdcPerBtc: callR.filledPxUsdcPerBtc, filledAtIso: callR.filledAtIso },
        totalProceedsUsdc: totalProceeds
      };
    }
    if (!putR.ok && !callR.ok) {
      safeLog(this.opts, `both close legs failed after retries for pair=${req.pairId}`);
      return { ok: false, reason: "both_failed", putLegResult: putR, callLegResult: callR };
    }
    if (!putR.ok) {
      safeLog(this.opts, `put close failed for pair=${req.pairId}`);
      return { ok: false, reason: "put_failed", putLegResult: putR, callLegResult: callR };
    }
    safeLog(this.opts, `call close failed for pair=${req.pairId}`);
    return { ok: false, reason: "call_failed", putLegResult: putR, callLegResult: callR };
  }

  private async sellLegWithRetry(
    pairId: string,
    role: "put" | "call",
    leg: CloseLegRequest
  ): Promise<CloseLegResult> {
    const expected = leg.expectedSellPxUsdcPerBtc;
    const floor = leg.minAcceptablePxUsdcPerBtc;
    // Attempt prices: best → 5% deeper → floor. Each non-increasing, deduplicated.
    const prices: number[] = [expected];
    const deeper = expected * RETRY_DEEPER_CROSS_MULTIPLIER;
    if (deeper > floor && deeper < expected) prices.push(deeper);
    if (floor > 0 && floor < prices[prices.length - 1]) prices.push(floor);

    let lastRaw: LegExecutionResult = {
      ok: false,
      reason: "venue_error",
      detail: "no attempts made"
    };

    for (let attempt = 1; attempt <= Math.min(MAX_ATTEMPTS, prices.length); attempt++) {
      const px = prices[attempt - 1];
      const clientId = `${pairId}-${role}-sell-a${attempt}-${Date.now()}`;
      try {
        if (leg.venue === "bullish") {
          lastRaw = await this.bullish.sellLeg({
            symbol: leg.symbol,
            contractsBtc: leg.contractsBtc,
            minAcceptableBidUsdcPerBtc: px,
            clientOrderId: clientId
          });
        } else {
          lastRaw = await this.deribit.sellLeg({
            instrument: leg.symbol,
            contractsBtc: leg.contractsBtc,
            minAcceptableBidUsdcPerBtc: px,
            clientOrderId: clientId
          });
        }
      } catch (e) {
        lastRaw = { ok: false, reason: "venue_error", detail: `${role} attempt ${attempt} threw: ${(e as Error).message}` };
      }
      if (lastRaw.ok) {
        safeLog(this.opts, `${role} close filled on attempt ${attempt}/${MAX_ATTEMPTS} at $${lastRaw.filledAskUsdcPerBtc.toFixed(2)} for pair=${pairId}`);
        return toCloseResult(lastRaw);
      }
      safeLog(this.opts, `${role} close attempt ${attempt}/${MAX_ATTEMPTS} failed at $${px.toFixed(2)} for pair=${pairId}: ${(lastRaw as { reason: string }).reason}`);
    }
    // All attempts failed — convert and decorate with retry count detail
    const final = toCloseResult(lastRaw);
    if (!final.ok) {
      return { ...final, detail: `all ${MAX_ATTEMPTS} attempts failed; last=${final.detail}` };
    }
    return final;
  }
}
