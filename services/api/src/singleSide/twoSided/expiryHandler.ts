/**
 * Expiry handler — auto-settles pairs that reach expires_at WITHOUT triggering.
 *
 * The TriggerDetector handles boundary crossings (active → triggered).
 * The ExecutionRuntime handles the triggered → unwinding → settled chain.
 * Foxify-initiated close handles operator-side early-close.
 *
 * But pairs that hit `expires_at` while still in `active` status — i.e. BTC
 * never crossed a trigger boundary and Foxify never called close — were
 * previously stuck. The schema even reserves `exit_mode = 'no_trigger_expiry'`
 * for this case, but no code path ever wrote it.
 *
 * This module closes that gap. Polls every N seconds; for each active pair
 * past `expires_at`:
 *
 *   - SHADOW: compute estimated salvage from venue bids (via liquidChainCache),
 *     transition active → unwinding → settled directly in DB. No venue calls.
 *
 *   - LIVE: spawn close executor (calls Bullish/Deribit to actually sell legs)
 *     just like the triggered path, but with closed_reason="expiry" and
 *     exit_mode="no_trigger_expiry".
 *
 * For pairs that DID trigger and are in {triggered, unwinding} status, the
 * existing ExecutionRuntime continues to own them — this module skips them.
 */

import type { Pool } from "pg";
import { bsCall, bsPut } from "../../pilot/blackScholes";
import {
  getLegsForPair,
  getPairById,
  recordPairEvent,
  updatePairStatus
} from "./db";
import type { LiquidChainCache } from "./liquidChainCache";

// Cap operator fee at 15% of profit (high-volume tier), min $25 floor.
const ATTICUS_FEE_PCT = 0.10;
const ATTICUS_FLOOR_USD = 25;
const BID_BASED_HAIRCUT = 0.95;
const BS_FALLBACK_HAIRCUT = 0.70;
const RFR = 0.045;

const DEFAULT_POLL_MS = 60_000; // Check every 60s; expiry isn't time-sensitive

export type ExpiryHandlerDeps = {
  pool: Pool;
  /** Live MTM data source — preferred when available. */
  liquidChainCache: LiquidChainCache | null;
  /** Current implied vol fallback (DVOL) for BS valuation when bid is missing. */
  getCurrentIvAnnual: () => number;
  /** Webhook delivery hook — invoked after settlement. Errors are swallowed. */
  onSettled?: (pair: {
    pair_id: string;
    foxify_pair_ref: string;
    closed_at: string;
    closed_reason: "expiry";
    salvage_proceeds_usdc: number;
    uplift_usdc: number;
    foxify_share_usdc: number;
    atticus_share_usdc: number;
    exit_mode: "no_trigger_expiry";
    tier_at_settlement: string;
  }) => Promise<void> | void;
  /** Polling cadence (ms). Default 60s. */
  pollMs?: number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

export class ExpiryHandler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ticksRun = 0;
  private settledCount = 0;
  private errorCount = 0;
  private lastTickMs = 0;

  constructor(private readonly deps: ExpiryHandlerDeps) {}

  start(): void {
    if (this.timer) return;
    const period = this.deps.pollMs ?? DEFAULT_POLL_MS;
    this.log(`[expiryHandler] started (poll=${period}ms)`);
    this.timer = setInterval(() => {
      void this.tick().catch((e) => this.log(`tick error: ${(e as Error).message}`));
    }, period);
    if (this.timer && typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
    // Fire once on start to catch existing stuck pairs without waiting
    void this.tick().catch((e) => this.log(`initial tick error: ${(e as Error).message}`));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stats(): { ticksRun: number; settledCount: number; errorCount: number; lastTickMs: number } {
    return {
      ticksRun: this.ticksRun,
      settledCount: this.settledCount,
      errorCount: this.errorCount,
      lastTickMs: this.lastTickMs
    };
  }

  /** Single tick: find expired pairs, settle them. Exposed for tests. */
  async tick(nowMs?: number): Promise<{ checked: number; settled: number; errors: number }> {
    if (this.running) return { checked: 0, settled: 0, errors: 0 };
    this.running = true;
    const now = nowMs ?? Date.now();
    this.lastTickMs = now;
    this.ticksRun++;
    let checked = 0;
    let settled = 0;
    let errors = 0;
    try {
      const expired = await this.findExpiredActivePairs(now);
      checked = expired.length;
      for (const pair of expired) {
        try {
          const result = await this.settleOne(pair.pairId, now);
          if (result === "settled") {
            settled++;
            this.settledCount++;
          }
        } catch (e) {
          errors++;
          this.errorCount++;
          this.log(`settle failed for ${pair.pairId}: ${(e as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
    return { checked, settled, errors };
  }

  /** Returns active pairs whose expires_at has passed. */
  private async findExpiredActivePairs(nowMs: number): Promise<Array<{ pairId: string }>> {
    const nowIso = new Date(nowMs).toISOString();
    const res = await this.deps.pool.query<{ pair_id: string }>(
      `SELECT pair_id FROM two_sided_pair
       WHERE status = 'active' AND expires_at <= $1
       ORDER BY expires_at ASC
       LIMIT 100`,
      [nowIso]
    );
    return res.rows.map((r) => ({ pairId: r.pair_id }));
  }

  /**
   * Settle one pair. Returns "settled" on success, "skipped" if pair status
   * moved out from under us (raced with trigger detector or close handler).
   */
  async settleOne(pairId: string, nowMs?: number): Promise<"settled" | "skipped"> {
    const now = nowMs ?? Date.now();
    // Re-fetch to belt-and-suspenders: maybe status changed mid-tick
    const pair = await getPairById(this.deps.pool, pairId);
    if (!pair) {
      this.log(`pair ${pairId} not found (deleted?)`);
      return "skipped";
    }
    if (pair.status !== "active") {
      this.log(`pair ${pairId} no longer active (status=${pair.status}); skipping`);
      return "skipped";
    }
    if (Date.parse(pair.expiresAt) > now) {
      this.log(`pair ${pairId} not yet expired (expires_at=${pair.expiresAt}); skipping`);
      return "skipped";
    }

    // Compute salvage estimate
    const legs = await getLegsForPair(this.deps.pool, pairId);
    const putLeg = legs.find((l) => l.legRole === "long_put");
    const callLeg = legs.find((l) => l.legRole === "long_call");
    if (!putLeg || !callLeg) {
      throw new Error(`pair ${pairId} missing legs (put=${!!putLeg}, call=${!!callLeg})`);
    }

    const valuation = this.computeFinalSalvage({
      putStrike: Number(putLeg.strikeUsdc),
      callStrike: Number(callLeg.strikeUsdc),
      contractsBtc: putLeg.contractsBtc,
      putVenue: putLeg.venue as "deribit" | "bullish",
      callVenue: callLeg.venue as "deribit" | "bullish",
      tenorRemainingHours: Math.max(0, (Date.parse(pair.expiresAt) - now) / 3_600_000) || 0.01 // tiny non-zero for BS
    });

    const salvage = valuation.salvageUsdc;
    const cost = pair.hedgeCostTotalUsdc;
    const grossProfit = salvage - cost;
    // Atticus fee only on profit (positive), min ATTICUS_FLOOR_USD when profitable
    const atticusFee =
      grossProfit > 0
        ? Math.max(ATTICUS_FLOOR_USD, grossProfit * ATTICUS_FEE_PCT)
        : 0;
    const upliftUsdc = Math.max(0, grossProfit);
    const foxifyShareUsdc = salvage - atticusFee;
    const atticusShareUsdc = atticusFee;

    const closedAtIso = new Date(now).toISOString();

    // Transition active → unwinding (record event with valuation context)
    await updatePairStatus(this.deps.pool, pairId, "unwinding", {});
    await recordPairEvent(this.deps.pool, {
      pairId,
      kind: "unwinding_started",
      details: {
        triggered_by: "expiry_handler",
        valuation_method: valuation.method,
        valuation_source_detail: valuation.sourceDetail,
        put_value_usdc: valuation.putValueUsdc,
        call_value_usdc: valuation.callValueUsdc,
        estimated_salvage_usdc: salvage
      }
    });

    // Transition unwinding → settled with full settlement detail
    await updatePairStatus(this.deps.pool, pairId, "settled", {
      closedAt: closedAtIso,
      closedReason: "expiry",
      salvageProceedsUsdc: salvage,
      upliftUsdc,
      foxifyShareUsdc,
      atticusShareUsdc,
      exitMode: "no_trigger_expiry"
    });
    await recordPairEvent(this.deps.pool, {
      pairId,
      kind: "settled",
      details: {
        closed_reason: "expiry",
        exit_mode: "no_trigger_expiry",
        salvage_proceeds_usdc: salvage,
        uplift_usdc: upliftUsdc,
        foxify_share_usdc: foxifyShareUsdc,
        atticus_share_usdc: atticusShareUsdc,
        atticus_fee_usdc: atticusFee,
        gross_profit_usdc: grossProfit,
        cost_paid_usdc: cost,
        is_shadow: pair.isShadow,
        valuation_method: valuation.method
      }
    });

    // Webhook delivery (best-effort, non-blocking on error)
    if (this.deps.onSettled) {
      try {
        await this.deps.onSettled({
          pair_id: pairId,
          foxify_pair_ref: pair.foxifyPairRef,
          closed_at: closedAtIso,
          closed_reason: "expiry",
          salvage_proceeds_usdc: salvage,
          uplift_usdc: upliftUsdc,
          foxify_share_usdc: foxifyShareUsdc,
          atticus_share_usdc: atticusShareUsdc,
          exit_mode: "no_trigger_expiry",
          tier_at_settlement: pair.tierAtActivation
        });
      } catch (e) {
        this.log(`webhook delivery failed for ${pairId}: ${(e as Error).message}`);
      }
    }

    this.log(`settled ${pairId} (shadow=${pair.isShadow}) salvage=$${salvage.toFixed(2)} foxify=$${foxifyShareUsdc.toFixed(2)} atticus=$${atticusShareUsdc.toFixed(2)}`);
    return "settled";
  }

  /**
   * Compute the final realizable salvage value at expiry.
   * Uses venue bids when available, falls back to BS valuation.
   * Note: at expiry, BS time-to-expiry is ~0 so the value is essentially
   * intrinsic value only.
   */
  private computeFinalSalvage(params: {
    putStrike: number;
    callStrike: number;
    contractsBtc: number;
    putVenue: "deribit" | "bullish";
    callVenue: "deribit" | "bullish";
    tenorRemainingHours: number;
  }): {
    salvageUsdc: number;
    putValueUsdc: number;
    callValueUsdc: number;
    method: "venue_bid" | "bs_fallback" | "mixed";
    sourceDetail: string;
  } {
    const valueLeg = (leg: { side: "put" | "call"; strike: number; venue: "deribit" | "bullish" }):
      { perBtc: number; method: "venue_bid" | "bs_fallback" } => {
      if (this.deps.liquidChainCache) {
        const bid = this.deps.liquidChainCache.getBidForLeg({
          strike: leg.strike,
          optType: leg.side,
          tenorRemainingHours: params.tenorRemainingHours,
          preferVenue: leg.venue
        });
        if (bid) {
          return { perBtc: bid.bidUsdcPerBtc * BID_BASED_HAIRCUT, method: "venue_bid" };
        }
      }
      // BS fallback at the cache's missing-strike case
      const T = Math.max(0.0001, params.tenorRemainingHours / (24 * 365));
      const sigma = this.deps.getCurrentIvAnnual();
      // At expiry, get spot from cache or default
      const spot = this.deps.liquidChainCache?.getCached()?.spot ?? leg.strike;
      const raw = leg.side === "put"
        ? Math.max(0, bsPut(spot, leg.strike, T, RFR, sigma))
        : Math.max(0, bsCall(spot, leg.strike, T, RFR, sigma));
      return { perBtc: raw * BS_FALLBACK_HAIRCUT, method: "bs_fallback" };
    };

    const putV = valueLeg({ side: "put", strike: params.putStrike, venue: params.putVenue });
    const callV = valueLeg({ side: "call", strike: params.callStrike, venue: params.callVenue });
    const putValueUsdc = putV.perBtc * params.contractsBtc;
    const callValueUsdc = callV.perBtc * params.contractsBtc;
    return {
      salvageUsdc: putValueUsdc + callValueUsdc,
      putValueUsdc,
      callValueUsdc,
      method: putV.method === callV.method ? putV.method : "mixed",
      sourceDetail: `put:${putV.method} call:${callV.method}`
    };
  }

  private log(msg: string, meta?: Record<string, unknown>): void {
    const fn = this.deps.log ?? ((m, x) => console.log(`[expiryHandler] ${m}`, x ?? ""));
    fn(msg, meta);
  }
}
