/**
 * Execution runtime — polls the canonical Atticus feed, computes current
 * combined option value, tracks peak, asks tpEngine for a decision, and
 * executes the close when "sell" is returned.
 *
 * Runs ONE pair at a time per instance (each triggered pair gets its own
 * runtime). The trigger detector's onTrigger callback spawns a runtime
 * via `startExecutionForTriggeredPair`.
 *
 * Lifecycle:
 *   1. Pair transitions to `triggered` (by trigger detector).
 *   2. Runtime is spawned.
 *   3. Loop: poll feed → compute value → update peak → tpEvaluate → if sell:
 *      transition `triggered` → `unwinding` → close executor → finalize → settled.
 *   4. On Foxify early-close: caller invokes runtime.forceClose() and the next
 *      tick decision will be foxify_close → sell at current.
 *
 * Concurrent-unwind throttle (PR 9 will own the global throttle; this runtime
 * just respects an injected isUnwindSlotAvailable() check before posting sells).
 */

import type { Pool } from "pg";
import {
  CAPTURE_WINDOW_MS,
  tpEvaluate,
  type TpDecision
} from "./tpEngine";
import {
  getLegsForPair,
  getPairById,
  recordPairEvent,
  updatePairStatus
} from "./db";
import type { ExitMode, PairRecord, PairLegRecord } from "./types";
import type { CloseExecutor, CloseStrangleResult } from "./closeExecutor";
import { getMetrics, METRIC_NAMES } from "./metrics";
import type { AggregatedFeed } from "./feedAggregator";
import type { LiquidChainCache } from "./liquidChainCache";
import { priceStrangle } from "./optionPricing";

export type RuntimeDeps = {
  pool: Pool;
  getFeed: () => AggregatedFeed | null;
  closeExecutor: CloseExecutor;
  /** Returns σ to price the strangle at current moment. Production: from DVOL feed.
   * Tests: injected constant. */
  getCurrentSigma: () => number;
  /** Returns slippage haircut to apply (depth-aware). Production: from live depth probes.
   * Tests: injected constant (default 0.85). */
  getCurrentSlippageHaircut: () => number;
  /** PR 9 hook — if returns false, runtime waits for next tick before posting close. */
  isUnwindSlotAvailable?: () => boolean;
  /** PR B1: production unwind queue. Takes precedence over isUnwindSlotAvailable. */
  unwindQueue?: { requestSlot: (pairId: string, triggeredAtMs: number, nowMs?: number) => { granted: boolean; reason?: string; queueDepth: number; waitMs: number; forceGranted?: boolean }; releaseSlot: (pairId: string) => void; };
  /** Poll period in ms (default 5_000). Lower in tests for speed. */
  pollPeriodMs?: number;
  /** Logger. */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Calibration multipliers captured at activation; passed in per pair so the
   * runtime doesn't have to re-pull anchors. Caller derives from pair_leg
   * (live_anchor_ask / BS_at_anchor_sigma).
   * NOTE: post-Phase-1 (unified pricing), calibration multipliers are only
   * used when priceOption falls all the way to bs_only. When real bids are
   * available, they take priority over BS+calibration. */
  calibrationFor: (pair: PairRecord) => Promise<{ putCalib: number; callCalib: number; riskFreeRate: number }>;
  /** Liquid chain cache for bid lookups in priceOption. Optional; when omitted,
   * priceOption falls straight to BS+calibration (legacy behavior). */
  liquidChainCache?: LiquidChainCache | null;
};

const RFR_DEFAULT = 0.045;
const MS_PER_YEAR = 365 * 86_400_000;

export type RuntimeState = {
  pairId: string;
  status: "running" | "closed" | "failed";
  triggeredAtMs: number;
  peakValueUsdc: number;
  lastTickMs: number;
  lastDecision: TpDecision | null;
  ticks: number;
  exitMode: ExitMode | null;
  finalSalvageUsdc: number | null;
};

export class ExecutionRuntime {
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: RuntimeState;
  private forceCloseRequested = false;
  private pair: PairRecord;
  private legs: PairLegRecord[] = [];

  constructor(private readonly deps: RuntimeDeps, pair: PairRecord) {
    this.pair = pair;
    this.state = {
      pairId: pair.pairId,
      status: "running",
      triggeredAtMs: pair.triggeredAt ? Date.parse(pair.triggeredAt) : Date.now(),
      peakValueUsdc: 0,
      lastTickMs: 0,
      lastDecision: null,
      ticks: 0,
      exitMode: null,
      finalSalvageUsdc: null
    };
  }

  async init(): Promise<void> {
    this.legs = await getLegsForPair(this.deps.pool, this.pair.pairId);
    if (this.legs.length !== 2) {
      throw new Error(`Pair ${this.pair.pairId} expected 2 legs, got ${this.legs.length}`);
    }
  }

  state_(): RuntimeState {
    return { ...this.state };
  }

  /** Foxify early-close request — handled at next tick. */
  forceClose(): void {
    this.forceCloseRequested = true;
  }

  start(): void {
    if (this.timer) return;
    const periodMs = this.deps.pollPeriodMs ?? 5_000;
    this.timer = setInterval(() => {
      void this.tick().catch((e) =>
        this.log(`tick error for ${this.pair.pairId}: ${(e as Error).message}`, { error: String(e) })
      );
    }, periodMs);
    if (this.timer && typeof (this.timer as { unref?: () => void }).unref === "function") (this.timer as { unref: () => void }).unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Single tick. Exposed for tests. Returns the current decision. */
  async tick(nowMsOverride?: number): Promise<TpDecision> {
    const nowMs = nowMsOverride ?? Date.now();
    this.state.lastTickMs = nowMs;
    this.state.ticks++;

    // 1. Snapshot feed for current spot; price each leg via unified pricing
    //    primitive. purpose="fair_value" → uses MID (or raw BS if no bid) so
    //    the TP curve tracks the same value that other consumers (MTM, EV)
    //    would see. Calibration multipliers are still derived but only become
    //    relevant when priceOption falls to bs_only (rare; means chain cache
    //    has no quote for either the exact instrument or fuzzy strike+tenor).
    const feed = this.deps.getFeed();
    let currentValue = 0;
    if (feed?.canonicalPrice != null) {
      const sigma = this.deps.getCurrentSigma();
      const putLeg = this.legs.find((l) => l.legRole === "long_put")!;
      const callLeg = this.legs.find((l) => l.legRole === "long_call")!;
      const tenorRemainingMs = Math.max(0, Date.parse(this.pair.expiresAt) - nowMs);
      const strangle = priceStrangle({
        put: {
          spot: feed.canonicalPrice,
          strike: Number(putLeg.strikeUsdc),
          contractsBtc: putLeg.contractsBtc,
          tenorRemainingMs,
          optType: "put",
          venue: putLeg.venue,
          instrumentSymbol: putLeg.symbol,
          liquidChainCache: this.deps.liquidChainCache ?? null,
          ivAnnualOverride: sigma,
          nowMs
        },
        call: {
          spot: feed.canonicalPrice,
          strike: Number(callLeg.strikeUsdc),
          contractsBtc: callLeg.contractsBtc,
          tenorRemainingMs,
          optType: "call",
          venue: callLeg.venue,
          instrumentSymbol: callLeg.symbol,
          liquidChainCache: this.deps.liquidChainCache ?? null,
          ivAnnualOverride: sigma,
          nowMs
        },
        purpose: "fair_value"
      });
      currentValue = strangle.combined_value_total;
    }
    if (currentValue > this.state.peakValueUsdc) this.state.peakValueUsdc = currentValue;

    // 2. Ask TP engine
    const decision = tpEvaluate({
      hedgeCostUsdc: this.pair.hedgeCostTotalUsdc,
      triggeredAtMs: this.state.triggeredAtMs,
      tpForceExitAtMs: Date.parse(this.pair.tpForceExitAt),
      currentMs: nowMs,
      currentValueUsdc: currentValue,
      peakValueSinceTriggerUsdc: this.state.peakValueUsdc,
      slippageHaircut: this.deps.getCurrentSlippageHaircut(),
      foxifyForceClose: this.forceCloseRequested
    });
    this.state.lastDecision = decision;

    if (decision.action === "wait") return decision;

    // 3. Throttle gate — PR B1 unwindQueue takes precedence over PR 9 legacy hook
    if (this.deps.unwindQueue) {
      const grant = this.deps.unwindQueue.requestSlot(this.pair.pairId, this.state.triggeredAtMs);
      if (!grant.granted) {
        this.log(`unwind slot denied for ${this.pair.pairId}: ${grant.reason ?? "unknown"} (queue_depth=${grant.queueDepth}, wait=${grant.waitMs}ms)`);
        return { ...decision, action: "wait" };
      }
      if (grant.forceGranted) {
        this.log(`unwind slot force-granted for ${this.pair.pairId} after ${grant.waitMs}ms wait (deadline override)`);
      }
    } else if (this.deps.isUnwindSlotAvailable && !this.deps.isUnwindSlotAvailable()) {
      this.log(`unwind slot not available for ${this.pair.pairId}; waiting`);
      return { ...decision, action: "wait" };
    }

    // 4. Execute close
    await this.executeClose(decision, currentValue);
    return decision;
  }

  private async executeClose(decision: TpDecision, currentValue: number): Promise<void> {
    // Transition triggered → unwinding
    const fresh = await getPairById(this.deps.pool, this.pair.pairId);
    if (!fresh || fresh.status !== "triggered") {
      this.log(`pair ${this.pair.pairId} is not triggered (status=${fresh?.status}); aborting close`);
      this.state.status = "failed";
      this.stop();
      return;
    }
    await updatePairStatus(this.deps.pool, this.pair.pairId, "unwinding");
    await recordPairEvent(this.deps.pool, {
      pairId: this.pair.pairId,
      kind: "unwinding_started",
      details: { exitMode: decision.reason, currentValue, peakValue: this.state.peakValueUsdc }
    });

    // Compose close request (sell at current px × slip for trail/floor/force/foxify,
    // sell at peak × slip for capture window)
    const slip = this.deps.getCurrentSlippageHaircut();
    const isPeakSnap = decision.reason === "capture_window_peak";
    const referenceValue = isPeakSnap ? this.state.peakValueUsdc : currentValue;
    // Per-leg expected sell px: split the combined value pro-rata to each leg's intrinsic+TV.
    // For simplicity in PR 5 we split by per-leg buy cost ratio (approximates value share at trigger).
    const putLeg = this.legs.find((l) => l.legRole === "long_put")!;
    const callLeg = this.legs.find((l) => l.legRole === "long_call")!;
    const totalBuyCost = Number(putLeg.buyCostUsdc) + Number(callLeg.buyCostUsdc);
    const putShare = totalBuyCost > 0 ? Number(putLeg.buyCostUsdc) / totalBuyCost : 0.5;
    const callShare = 1 - putShare;
    const expectedPutValue = referenceValue * putShare * slip;
    const expectedCallValue = referenceValue * callShare * slip;

    // Compute tenor remaining (hours) so the close executor can match bids
    // from LiquidChainCache at the leg's effective expiry.
    const nowForExpiry = Date.now();
    const tenorRemainingHoursForExpiry = Math.max(0, (Date.parse(this.pair.expiresAt) - nowForExpiry) / 3_600_000);

    const closeResult: CloseStrangleResult = await this.deps.closeExecutor.closeStrangle({
      pairId: this.pair.pairId,
      putLeg: {
        legRole: "long_put",
        venue: putLeg.venue,
        symbol: putLeg.symbol,
        contractsBtc: putLeg.contractsBtc,
        expectedSellPxUsdcPerBtc: expectedPutValue / putLeg.contractsBtc,
        // PR A5 slippage floor: at worst, accept 0.65× expected (depth-aware worst case)
        minAcceptablePxUsdcPerBtc: (expectedPutValue / putLeg.contractsBtc) * 0.65,
        // Bid-based valuation lookup inputs (ShadowCloseExecutor uses these
        // to fetch the actual venue bid rather than relying on BS estimate)
        strikeUsdc: Number(putLeg.strikeUsdc),
        optType: "put",
        tenorRemainingHours: tenorRemainingHoursForExpiry
      },
      callLeg: {
        legRole: "long_call",
        venue: callLeg.venue,
        symbol: callLeg.symbol,
        contractsBtc: callLeg.contractsBtc,
        expectedSellPxUsdcPerBtc: expectedCallValue / callLeg.contractsBtc,
        minAcceptablePxUsdcPerBtc: (expectedCallValue / callLeg.contractsBtc) * 0.65,
        strikeUsdc: Number(callLeg.strikeUsdc),
        optType: "call",
        tenorRemainingHours: tenorRemainingHoursForExpiry
      }
    });

    if (!closeResult.ok) {
      await recordPairEvent(this.deps.pool, {
        pairId: this.pair.pairId,
        kind: "execution_stuck",
        details: { reason: closeResult.reason, put: closeResult.putLegResult, call: closeResult.callLegResult }
      });
      this.state.status = "failed";
      this.log(`close failed for ${this.pair.pairId}: ${closeResult.reason}`);
      this.stop();
      if (this.deps.unwindQueue) this.deps.unwindQueue.releaseSlot(this.pair.pairId);
      getMetrics().incrementCounter(METRIC_NAMES.EXECUTION_STUCK_TOTAL, { cell_id: this.pair.cellId, reason: closeResult.reason });
      return;
    }

    const salvage = closeResult.totalProceedsUsdc;
    const closedReason =
      decision.reason === "foxify_close"
        ? "foxify_close"
        : decision.reason === "force_expiry"
        ? "expiry"
        : "trigger";
    const exitMode: ExitMode = decision.reason ?? "no_trigger_expiry";

    // Update legs with sell info
    for (const [leg, fill] of [
      [putLeg, closeResult.putLeg],
      [callLeg, closeResult.callLeg]
    ] as const) {
      await this.deps.pool.query(
        `UPDATE two_sided_pair_leg
         SET sell_ask_usdc_per_btc = $1,
             sell_proceeds_usdc = $2,
             sell_filled_at = $3
         WHERE leg_id = $4`,
        [fill.filledPxUsdcPerBtc, fill.filledPxUsdcPerBtc * leg.contractsBtc, fill.filledAtIso, leg.legId]
      );
    }

    // Compute split via PR 6 settlementEngine (canonical math).
    const { computeSplit, assertSplitInvariant } = await import("./settlementEngine");
    // Use getTierByLabel so the SS_ATTICUS_SPLIT_PCT single-knob override applies
    // at settlement too (floor stays pinned to activation below).
    const { getTierByLabel } = await import("./tierResolver");
    const tier = getTierByLabel(this.pair.tierAtActivation);
    // Override floor with pair.atticusFloorUsdc (recorded at activation — pinned to
    // tier-at-activation policy, not retroactive).
    const tierWithPinnedFloor = { ...tier, atticusFloorUsdc: this.pair.atticusFloorUsdc };
    const split = computeSplit({
      salvageProceedsUsdc: salvage,
      hedgeCostUsdc: this.pair.hedgeCostTotalUsdc,
      tier: tierWithPinnedFloor
    });
    assertSplitInvariant(split);
    const atticusShare = split.atticusShareUsdc;
    const foxifyShare = split.foxifyShareUsdc;
    const uplift = split.upliftUsdc;

    // If deferred-pool is active, accrue Atticus share into the ledger (no payout).
    // Foxify share still flows back to Foxify; pool tracks what Atticus is owed.
    if (atticusShare > 0) {
      try {
        const { getPoolState, recordAccrual } = await import("./deferredPool");
        const poolState = await getPoolState(this.deps.pool).catch(() => null);
        if (poolState && poolState.active) {
          const { randomUUID } = await import("node:crypto");
          await recordAccrual(this.deps.pool, {
            ledgerId: randomUUID(),
            pairId: this.pair.pairId,
            atticusShareUsdc: atticusShare,
            upliftUsdc: uplift
          });
        }
      } catch (e) {
        this.log(`deferred-pool accrual skipped for ${this.pair.pairId}: ${(e as Error).message}`);
      }
    }

    await updatePairStatus(this.deps.pool, this.pair.pairId, "settled", {
      closedAt: new Date(Date.now()).toISOString(),
      closedReason,
      salvageProceedsUsdc: salvage,
      upliftUsdc: uplift,
      foxifyShareUsdc: foxifyShare,
      atticusShareUsdc: atticusShare,
      exitMode
    });
    await recordPairEvent(this.deps.pool, {
      pairId: this.pair.pairId,
      kind: "settled",
      details: {
        salvage,
        uplift,
        foxifyShare,
        atticusShare,
        exitMode,
        closedReason,
        // Audit trail: how was each leg's sell price derived?
        //   "venue_bid"   = real Bullish/Deribit bid × slippage haircut (realistic)
        //   "bs_expected" = Black-Scholes theoretical (fallback when bid unavailable)
        put_valuation_method: closeResult.putLeg.valuationMethod ?? null,
        call_valuation_method: closeResult.callLeg.valuationMethod ?? null,
        put_raw_venue_bid_usdc_per_btc: closeResult.putLeg.rawVenueBidUsdcPerBtc ?? null,
        call_raw_venue_bid_usdc_per_btc: closeResult.callLeg.rawVenueBidUsdcPerBtc ?? null
      }
    });

    // PR C6: counterparty ledger entries
    try {
      const { recordSettleEntries } = await import("./counterpartyLedger");
      const { getPoolState } = await import("./deferredPool");
      const poolState = await getPoolState(this.deps.pool).catch(() => null);
      await recordSettleEntries(this.deps.pool, {
        pairId: this.pair.pairId,
        salvageProceedsUsdc: salvage,
        foxifyShareUsdc: foxifyShare,
        atticusShareUsdc: atticusShare,
        upliftUsdc: uplift,
        isDeferredPoolActive: poolState?.active ?? false
      });
    } catch (e) {
      this.log(`ledger settle entries failed: ${(e as Error).message}`);
    }

    this.state.exitMode = exitMode;
    this.state.finalSalvageUsdc = salvage;
    this.state.status = "closed";
    this.stop();
    if (this.deps.unwindQueue) this.deps.unwindQueue.releaseSlot(this.pair.pairId);

    const m = getMetrics();
    m.incrementCounter(METRIC_NAMES.PAIRS_SETTLED_TOTAL, { cell_id: this.pair.cellId, closed_reason: closedReason, exit_mode: exitMode });
    m.decrementGauge(METRIC_NAMES.ACTIVE_PAIRS, { cell_id: this.pair.cellId });
    m.observeHistogram(METRIC_NAMES.SALVAGE_UPLIFT_USDC, uplift, { cell_id: this.pair.cellId });
    m.observeHistogram(METRIC_NAMES.UNWIND_LATENCY_MS, Date.now() - this.state.triggeredAtMs, { cell_id: this.pair.cellId });

    // PR A7: deliver Foxify webhook (fire-and-forget; retry chain runs in background)
    try {
      const { deliverPairClosed } = await import("./webhookDelivery");
      void deliverPairClosed(this.deps.pool, {
        pair_id: this.pair.pairId,
        foxify_pair_ref: this.pair.foxifyPairRef,
        closed_at: new Date(Date.now()).toISOString(),
        closed_reason: closedReason,
        trigger_side: this.pair.triggerSide,
        salvage_proceeds_usdc: salvage,
        uplift_usdc: uplift,
        foxify_share_usdc: foxifyShare,
        atticus_share_usdc: atticusShare,
        exit_mode: exitMode,
        tier_at_settlement: this.pair.tierAtActivation
      }).catch((e) => this.log(`webhook delivery failed: ${(e as Error).message}`));
    } catch (e) {
      this.log(`webhook module load failed: ${(e as Error).message}`);
    }
  }

  private log(msg: string, meta?: Record<string, unknown>): void {
    const fn = this.deps.log ?? ((m, _meta) => console.log(`[execRuntime] ${m}`, _meta ?? ""));
    fn(msg, meta);
  }
}

/** Helper: derive per-leg calibration from pair legs (anchor / BS@anchor). */
export const deriveCalibrationFromLegs = async (
  pool: Pool,
  pair: PairRecord
): Promise<{ putCalib: number; callCalib: number; riskFreeRate: number }> => {
  const legs = await getLegsForPair(pool, pair.pairId);
  if (legs.length !== 2) throw new Error(`Pair ${pair.pairId} legs missing`);
  const { bsPut, bsCall } = await import("../../../scripts/backtest/singleSide/coreEngine");
  const putLeg = legs.find((l) => l.legRole === "long_put")!;
  const callLeg = legs.find((l) => l.legRole === "long_call")!;
  // Anchor σ is stored implicitly via the activation feed snapshot; for now, use 0.36
  // as a conservative default (matches DVOL ~36 at activation time for the embedded anchors).
  // PR 6 / Phase 1 enhancement: store sigma_at_anchor on the leg row.
  const anchorSigma = 0.36;
  const T = pair.hedgeTenorDays / 365;
  const bsP = bsPut(pair.spotAtActivation, Number(putLeg.strikeUsdc), T, RFR_DEFAULT, anchorSigma);
  const bsC = bsCall(pair.spotAtActivation, Number(callLeg.strikeUsdc), T, RFR_DEFAULT, anchorSigma);
  return {
    putCalib: bsP > 0 ? Number(putLeg.liveAnchorAskUsdcPerBtc) / bsP : 1.0,
    callCalib: bsC > 0 ? Number(callLeg.liveAnchorAskUsdcPerBtc) / bsC : 1.0,
    riskFreeRate: RFR_DEFAULT
  };
};
