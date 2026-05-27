/**
 * Trigger detector for the two-sided cooperative volume facility.
 *
 * Subscribes to the canonical Atticus feed (via injected `getFeed` callback)
 * and watches all `active` pairs for ±2% boundary crossings against
 * `trigger_down_price` / `trigger_up_price`. On a crossing:
 *
 *   1. Append `trigger_detected` event with the canonical feed snapshot to
 *      two_sided_pair_event (full audit trail per spec §3.4).
 *   2. Transition pair status `active → triggered` via the state machine.
 *   3. Invoke `onTrigger(pair, side, snapshot)` callback so the executor (PR 5)
 *      can kick in.
 *
 * Design:
 *   - Tick-based: caller (production = setInterval 1s; tests = manual) invokes
 *     `tick(nowMs?)`. The detector polls active pairs once per tick.
 *   - Stateless w.r.t. pair set — re-queries DB each tick. Safe across restarts.
 *   - Handles feed-unavailable by emitting `atticus_halt` event and skipping
 *     trigger checks (does NOT auto-trigger pairs without canonical price).
 *   - Idempotent: if a tick observes a pair already in `triggered` state
 *     (race with parallel detector or manual operation), it skips silently.
 */

import type { Pool } from "pg";
import type { AggregatedFeed } from "./feedAggregator";
import { getEventsForPair, recordPairEvent, updatePairStatus } from "./db";
import type { PairRecord, TriggerSide } from "./types";

export type DetectorDeps = {
  pool: Pool;
  /** Returns the most-recent aggregated feed snapshot. May be stale; detector
   * applies its own staleness check. */
  getFeed: () => AggregatedFeed | null;
  /** Invoked after pair transitions to `triggered`. Errors are swallowed +
   * logged so a downstream failure doesn't block other pairs in the same tick. */
  onTrigger: (pair: PairRecord, side: TriggerSide, feedSnapshot: AggregatedFeed) => Promise<void> | void;
  /** Optional: returns current regime for newborn-review counter tracking (PR A8). */
  getCurrentRegime?: () => "calm" | "moderate" | "elevated" | "stress" | null;
  /** Optional: invoked with regime when a trigger fires; used to increment newborn counter. */
  recordNewbornForRegime?: (regime: "calm" | "moderate" | "elevated" | "stress") => Promise<void>;
  /** Stale threshold in ms (default 5000ms healthy, 2000ms degraded). */
  staleHealthyMs?: number;
  staleDegradedMs?: number;
  /** Logger (default console). */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

export class TriggerDetector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickMs = 0;
  private ticksRun = 0;
  private triggersFiredCount = 0;
  private haltCount = 0;
  private staleCount = 0;

  constructor(private readonly deps: DetectorDeps) {}

  /** Start polling on a 1-second interval. */
  start(periodMs = 1_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((e) => this.log(`tick error: ${(e as Error).message}`, { error: String(e) }));
    }, periodMs);
    if (this.timer && typeof (this.timer as { unref?: () => void }).unref === "function") (this.timer as { unref: () => void }).unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Stats for monitoring/admin endpoint. */
  stats(): { ticksRun: number; lastTickMs: number; triggersFiredCount: number; haltCount: number; staleCount: number } {
    return {
      ticksRun: this.ticksRun,
      lastTickMs: this.lastTickMs,
      triggersFiredCount: this.triggersFiredCount,
      haltCount: this.haltCount,
      staleCount: this.staleCount
    };
  }

  /**
   * Single tick: poll feed → enumerate active pairs → detect crossings →
   * record events + transition state + invoke onTrigger.
   *
   * Exposed for tests.
   */
  async tick(nowMs?: number): Promise<{ checked: number; triggered: number; skipped: number }> {
    const now = nowMs ?? Date.now();
    this.lastTickMs = now;
    this.ticksRun++;

    const feed = this.deps.getFeed();
    const staleMs =
      feed?.health === "degraded" ? (this.deps.staleDegradedMs ?? 2_000) : (this.deps.staleHealthyMs ?? 5_000);

    if (!feed || feed.canonicalPrice == null) {
      this.haltCount++;
      this.log("feed unavailable; skipping trigger check this tick", { feedHealth: feed?.health ?? "missing" });
      return { checked: 0, triggered: 0, skipped: 0 };
    }
    if (now - feed.asOfMs > staleMs) {
      this.staleCount++;
      this.log("feed stale; skipping trigger check this tick", {
        ageMs: now - feed.asOfMs,
        staleMs,
        feedHealth: feed.health
      });
      return { checked: 0, triggered: 0, skipped: 0 };
    }

    const activePairs = await this.queryActivePairs();
    let triggered = 0;
    let skipped = 0;

    for (const pair of activePairs) {
      const side = this.detectSide(pair, feed.canonicalPrice);
      if (side == null) continue;

      // Belt-and-suspenders: re-check status hasn't moved out from under us
      // (e.g. Foxify early-close raced this tick).
      const fresh = await this.refetchStatus(pair.pairId);
      if (fresh !== "active") {
        skipped++;
        continue;
      }

      try {
        await recordPairEvent(this.deps.pool, {
          pairId: pair.pairId,
          kind: "trigger_detected",
          details: {
            side,
            canonical_price: feed.canonicalPrice,
            trigger_down_price: pair.triggerDownPrice,
            trigger_up_price: pair.triggerUpPrice,
            feed_snapshot: this.feedToAudit(feed)
          }
        });
        await updatePairStatus(this.deps.pool, pair.pairId, "triggered", {
          triggeredAt: new Date(now).toISOString(),
          triggerSide: side,
          triggerFeedSnapshot: this.feedToAudit(feed)
        });

        this.triggersFiredCount++;
        triggered++;

        // PR A8: record newborn-review trigger so subsequent activations halt
        if (this.deps.getCurrentRegime && this.deps.recordNewbornForRegime) {
          const regime = this.deps.getCurrentRegime();
          if (regime) {
            try {
              await this.deps.recordNewbornForRegime(regime);
            } catch (e) {
              this.log(`newborn record failed for ${regime}: ${(e as Error).message}`);
            }
          }
        }

        try {
          await this.deps.onTrigger({ ...pair, status: "triggered", triggeredAt: new Date(now).toISOString(), triggerSide: side }, side, feed);
        } catch (cbErr) {
          this.log(`onTrigger callback failed for ${pair.pairId}: ${(cbErr as Error).message}`, {
            pairId: pair.pairId,
            error: String(cbErr)
          });
        }
      } catch (txErr) {
        this.log(`failed to fire trigger for ${pair.pairId}: ${(txErr as Error).message}`, {
          pairId: pair.pairId,
          error: String(txErr)
        });
        skipped++;
      }
    }

    return { checked: activePairs.length, triggered, skipped };
  }

  // ───── private helpers ─────

  private detectSide(pair: PairRecord, canonicalPrice: number): TriggerSide | null {
    if (canonicalPrice <= pair.triggerDownPrice) return "down";
    if (canonicalPrice >= pair.triggerUpPrice) return "up";
    return null;
  }

  private async queryActivePairs(): Promise<PairRecord[]> {
    const res = await this.deps.pool.query(`SELECT * FROM two_sided_pair WHERE status = 'active'`);
    return res.rows.map((r) => ({
      pairId: r.pair_id,
      cellId: r.cell_id,
      status: r.status,
      foxifyPairRef: r.foxify_pair_ref,
      spotAtActivation: Number(r.spot_at_activation),
      feedSnapshotAtActivation: r.feed_snapshot_at_activation ?? {},
      triggerDownPrice: Number(r.trigger_down_price),
      triggerUpPrice: Number(r.trigger_up_price),
      hedgeTenorDays: Number(r.hedge_tenor_days),
      expiresAt: r.expires_at,
      tpForceExitAt: r.tp_force_exit_at,
      hedgeCostTotalUsdc: Number(r.hedge_cost_total_usdc),
      foxifyCapitalFundedUsdc: Number(r.foxify_capital_funded_usdc),
      tierAtActivation: r.tier_at_activation,
      atticusFloorUsdc: Number(r.atticus_floor_usdc),
      triggeredAt: r.triggered_at ?? null,
      triggerSide: r.trigger_side ?? null,
      triggerFeedSnapshot: r.trigger_feed_snapshot ?? null,
      closedAt: r.closed_at ?? null,
      closedReason: r.closed_reason ?? null,
      salvageProceedsUsdc: r.salvage_proceeds_usdc == null ? null : Number(r.salvage_proceeds_usdc),
      upliftUsdc: r.uplift_usdc == null ? null : Number(r.uplift_usdc),
      foxifyShareUsdc: r.foxify_share_usdc == null ? null : Number(r.foxify_share_usdc),
      atticusShareUsdc: r.atticus_share_usdc == null ? null : Number(r.atticus_share_usdc),
      exitMode: r.exit_mode ?? null,
      isShadow: Boolean(r.is_shadow),
      metadata: r.metadata ?? {},
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
  }

  private async refetchStatus(pairId: string): Promise<string | null> {
    const r = await this.deps.pool.query(`SELECT status FROM two_sided_pair WHERE pair_id = $1`, [pairId]);
    return r.rows[0]?.status ?? null;
  }

  private feedToAudit(feed: AggregatedFeed): Record<string, unknown> {
    return {
      canonical_price: feed.canonicalPrice,
      as_of_ms: feed.asOfMs,
      health: feed.health,
      sources: feed.sources.map((s) => ({ source: s.source, price: s.price, ts: s.ts })),
      rejected: feed.rejected,
      median_calc: feed.medianCalcDescription
    };
  }

  private log(msg: string, meta?: Record<string, unknown>): void {
    const fn = this.deps.log ?? ((m, _meta) => console.log(`[triggerDetector] ${m}`, _meta ?? ""));
    fn(msg, meta);
  }
}

// Re-export for convenience
export { getEventsForPair };
