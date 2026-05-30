/**
 * Shadow auto-TP handler — simulates Foxify-style "close early on TP" behavior.
 *
 * Background loop that watches active SHADOW pairs (is_shadow=true) and
 * automatically closes them when their MTM recommendation hits a TP threshold.
 * This is the missing piece for realistic PnL measurement: without this, all
 * shadow pairs ride to expiry (where most decay to small salvage), and the
 * data doesn't represent what a real Foxify bot would do.
 *
 * IMPORTANT — SHADOW ONLY:
 *   This handler operates STRICTLY on is_shadow=true pairs. For real-money
 *   pairs, Foxify's actual bot would be calling /foxify/v2/close based on
 *   its own MTM polling. We don't auto-close live pairs because that would
 *   bypass the operator's intentional decision-making AND we'd be settling
 *   in DB without actually selling on venues (corrupts state).
 *
 * Decision logic:
 *   For each active shadow pair:
 *     1. Pull MTM (uses venue bid via cache)
 *     2. If pnl_pct >= TP threshold (default 50%, configurable)
 *        AND tenor not expired (let expiry handler own that)
 *        AND not currently in another state transition
 *     → close it via the same settlement path the expiry handler uses
 *     → closed_reason: "foxify_close" (simulating Foxify's bot decision)
 *     → exit_mode: "foxify_close"
 *     → audit event includes "auto_tp_capture" detail flag
 *
 * Cadence: polls every 60s by default. Bounded by re-entrant guard.
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

const ATTICUS_FEE_PCT = 0.10;
const ATTICUS_FLOOR_USD = 25;
const BID_BASED_HAIRCUT = 0.95;
const BS_FALLBACK_HAIRCUT = 0.70;
const RFR = 0.045;

const DEFAULT_POLL_MS = 60_000;
const DEFAULT_TP_THRESHOLD_PCT = 0.50; // close shadow when pnl >= +50%

export type AutoTpHandlerConfig = {
  enabled: boolean;
  pollMs: number;
  /** Minimum pnl_pct to auto-close on (default 0.50 = +50%). */
  tpThresholdPct: number;
  /** Max pairs to close per tick (avoid bursty settlements). */
  maxPerTick: number;
};

export const readAutoTpConfig = (env: NodeJS.ProcessEnv = process.env): AutoTpHandlerConfig => ({
  enabled: env.SHADOW_AUTO_TP_ENABLED === "true",
  pollMs: Number(env.SHADOW_AUTO_TP_POLL_MS ?? DEFAULT_POLL_MS),
  tpThresholdPct: Number(env.SHADOW_AUTO_TP_THRESHOLD_PCT ?? DEFAULT_TP_THRESHOLD_PCT),
  maxPerTick: Number(env.SHADOW_AUTO_TP_MAX_PER_TICK ?? 20)
});

export type AutoTpDeps = {
  pool: Pool;
  liquidChainCache: LiquidChainCache | null;
  getCurrentIvAnnual: () => number;
  config: AutoTpHandlerConfig;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

export class ShadowAutoTpHandler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ticksRun = 0;
  private tpClosedCount = 0;
  private errorCount = 0;
  private lastTickMs = 0;

  constructor(private readonly deps: AutoTpDeps) {}

  start(): void {
    if (!this.deps.config.enabled) {
      this.log(`DISABLED (SHADOW_AUTO_TP_ENABLED != true). No-op.`);
      return;
    }
    if (this.timer) return;
    this.log(`started (poll=${this.deps.config.pollMs}ms, tp_threshold=${(this.deps.config.tpThresholdPct * 100).toFixed(0)}%, max_per_tick=${this.deps.config.maxPerTick})`);
    this.timer = setInterval(() => {
      void this.tick().catch((e) => this.log(`tick error: ${(e as Error).message}`));
    }, this.deps.config.pollMs);
    if (this.timer && typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
    void this.tick().catch((e) => this.log(`initial tick error: ${(e as Error).message}`));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stats(): { ticksRun: number; tpClosedCount: number; errorCount: number; lastTickMs: number } {
    return { ticksRun: this.ticksRun, tpClosedCount: this.tpClosedCount, errorCount: this.errorCount, lastTickMs: this.lastTickMs };
  }

  /** Single tick — exposed for tests. */
  async tick(nowMs?: number): Promise<{ checked: number; closed: number; errors: number }> {
    if (this.running) return { checked: 0, closed: 0, errors: 0 };
    this.running = true;
    const now = nowMs ?? Date.now();
    this.lastTickMs = now;
    this.ticksRun++;
    let checked = 0;
    let closed = 0;
    let errors = 0;
    try {
      // Find SHADOW active pairs with venue + strike info
      const candidates = await this.findShadowCandidates(now);
      checked = candidates.length;

      // For each candidate, compute MTM and check TP threshold
      const tpThreshold = this.deps.config.tpThresholdPct;
      const toClose: Array<{ pairId: string; pnlPct: number; estimatedSalvage: number; valuationMethod: string }> = [];
      for (const c of candidates) {
        try {
          const mtm = await this.computePairMtm(c, now);
          if (mtm == null) continue;
          if (mtm.pnlPct < tpThreshold) continue;
          toClose.push({ pairId: c.pairId, pnlPct: mtm.pnlPct, estimatedSalvage: mtm.salvage, valuationMethod: mtm.method });
          if (toClose.length >= this.deps.config.maxPerTick) break;
        } catch (e) {
          errors++;
          this.errorCount++;
          this.log(`mtm calc failed for ${c.pairId}: ${(e as Error).message}`);
        }
      }

      // Close each pair
      for (const t of toClose) {
        try {
          await this.closeOne(t.pairId, t.estimatedSalvage, t.valuationMethod, t.pnlPct, now);
          closed++;
          this.tpClosedCount++;
        } catch (e) {
          errors++;
          this.errorCount++;
          this.log(`close failed for ${t.pairId}: ${(e as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
    return { checked, closed, errors };
  }

  private async findShadowCandidates(nowMs: number): Promise<Array<{
    pairId: string;
    putStrike: number;
    callStrike: number;
    contractsBtc: number;
    putVenue: "deribit" | "bullish";
    callVenue: "deribit" | "bullish";
    cost: number;
    expiresAt: string;
  }>> {
    const nowIso = new Date(nowMs).toISOString();
    // Active shadow pairs whose expires_at is still in the future
    // (let expiry handler own the past-expiry ones).
    const res = await this.deps.pool.query<{
      pair_id: string;
      put_strike: string;
      call_strike: string;
      put_venue: string;
      call_venue: string;
      contracts_btc: string;
      hedge_cost_total_usdc: string;
      expires_at: string;
    }>(
      `SELECT
         p.pair_id,
         p.hedge_cost_total_usdc,
         p.expires_at,
         MAX(CASE WHEN l.leg_role IN ('long_put', 'put') THEN l.strike_usdc ELSE NULL END) AS put_strike,
         MAX(CASE WHEN l.leg_role IN ('long_call', 'call') THEN l.strike_usdc ELSE NULL END) AS call_strike,
         MAX(CASE WHEN l.leg_role IN ('long_put', 'put') THEN l.venue ELSE NULL END) AS put_venue,
         MAX(CASE WHEN l.leg_role IN ('long_call', 'call') THEN l.venue ELSE NULL END) AS call_venue,
         MAX(l.contracts_btc) AS contracts_btc
       FROM two_sided_pair p
       JOIN two_sided_pair_leg l ON p.pair_id = l.pair_id
       WHERE p.status = 'active' AND p.is_shadow = TRUE AND p.expires_at > $1
       GROUP BY p.pair_id, p.hedge_cost_total_usdc, p.expires_at`,
      [nowIso]
    );
    return res.rows
      .map((r) => ({
        pairId: r.pair_id,
        putStrike: Number(r.put_strike),
        callStrike: Number(r.call_strike),
        contractsBtc: Number(r.contracts_btc),
        putVenue: (r.put_venue as "deribit" | "bullish") ?? "deribit",
        callVenue: (r.call_venue as "deribit" | "bullish") ?? "deribit",
        cost: Number(r.hedge_cost_total_usdc),
        expiresAt: r.expires_at
      }))
      .filter((c) =>
        Number.isFinite(c.putStrike) &&
        Number.isFinite(c.callStrike) &&
        Number.isFinite(c.contractsBtc) &&
        c.contractsBtc > 0
      );
  }

  private async computePairMtm(
    pair: { putStrike: number; callStrike: number; contractsBtc: number; putVenue: "deribit" | "bullish"; callVenue: "deribit" | "bullish"; cost: number; expiresAt: string },
    nowMs: number
  ): Promise<{ pnlPct: number; salvage: number; method: string } | null> {
    const tenorRemainingHours = Math.max(0.01, (Date.parse(pair.expiresAt) - nowMs) / 3_600_000);
    const valueLeg = (side: "put" | "call", strike: number, venue: "deribit" | "bullish"): { valueUsdc: number; method: "venue_bid" | "bs_fallback" } => {
      if (this.deps.liquidChainCache) {
        const bid = this.deps.liquidChainCache.getBidForLeg({
          strike,
          optType: side,
          tenorRemainingHours,
          preferVenue: venue
        });
        if (bid) {
          return {
            valueUsdc: bid.bidUsdcPerBtc * BID_BASED_HAIRCUT * pair.contractsBtc,
            method: "venue_bid"
          };
        }
      }
      const T = tenorRemainingHours / (24 * 365);
      const sigma = this.deps.getCurrentIvAnnual();
      const spot = this.deps.liquidChainCache?.getCached()?.spot ?? strike;
      const raw = side === "put"
        ? Math.max(0, bsPut(spot, strike, T, RFR, sigma))
        : Math.max(0, bsCall(spot, strike, T, RFR, sigma));
      return { valueUsdc: raw * BS_FALLBACK_HAIRCUT * pair.contractsBtc, method: "bs_fallback" };
    };
    const put = valueLeg("put", pair.putStrike, pair.putVenue);
    const call = valueLeg("call", pair.callStrike, pair.callVenue);
    const salvage = put.valueUsdc + call.valueUsdc;
    const pnlPct = pair.cost > 0 ? (salvage - pair.cost) / pair.cost : 0;
    const method = put.method === call.method ? put.method : "mixed";
    return { pnlPct, salvage, method };
  }

  /** Close one pair by TP — same lifecycle as expiry handler but reason=foxify_close. */
  async closeOne(pairId: string, estimatedSalvage: number, valuationMethod: string, pnlPctAtTrigger: number, nowMs?: number): Promise<"closed" | "skipped"> {
    const now = nowMs ?? Date.now();
    // Belt-and-suspenders: re-check the pair is still active and is_shadow
    const pair = await getPairById(this.deps.pool, pairId);
    if (!pair) return "skipped";
    if (pair.status !== "active") {
      this.log(`pair ${pairId} no longer active (status=${pair.status}); skipping`);
      return "skipped";
    }
    if (!pair.isShadow) {
      // Defensive: this handler must NEVER touch live pairs
      this.log(`pair ${pairId} is NOT shadow (is_shadow=false) — refusing to auto-close. This is a real-money pair.`);
      return "skipped";
    }

    const cost = pair.hedgeCostTotalUsdc;
    const grossProfit = estimatedSalvage - cost;
    const atticusFee =
      grossProfit > 0
        ? Math.max(ATTICUS_FLOOR_USD, grossProfit * ATTICUS_FEE_PCT)
        : 0;
    const upliftUsdc = Math.max(0, grossProfit);
    const foxifyShareUsdc = estimatedSalvage - atticusFee;
    const atticusShareUsdc = atticusFee;
    const closedAtIso = new Date(now).toISOString();

    await updatePairStatus(this.deps.pool, pairId, "unwinding", {});
    await recordPairEvent(this.deps.pool, {
      pairId,
      kind: "unwinding_started",
      details: {
        triggered_by: "auto_tp_handler",
        pnl_pct_at_trigger: pnlPctAtTrigger,
        valuation_method: valuationMethod,
        estimated_salvage_usdc: estimatedSalvage
      }
    });

    await updatePairStatus(this.deps.pool, pairId, "settled", {
      closedAt: closedAtIso,
      closedReason: "foxify_close",
      salvageProceedsUsdc: estimatedSalvage,
      upliftUsdc,
      foxifyShareUsdc,
      atticusShareUsdc,
      exitMode: "foxify_close"
    });
    await recordPairEvent(this.deps.pool, {
      pairId,
      kind: "settled",
      details: {
        closed_reason: "foxify_close",
        exit_mode: "foxify_close",
        salvage_proceeds_usdc: estimatedSalvage,
        uplift_usdc: upliftUsdc,
        foxify_share_usdc: foxifyShareUsdc,
        atticus_share_usdc: atticusShareUsdc,
        atticus_fee_usdc: atticusFee,
        gross_profit_usdc: grossProfit,
        cost_paid_usdc: cost,
        is_shadow: true,
        valuation_method: valuationMethod,
        auto_tp_capture: true,
        pnl_pct_at_trigger: pnlPctAtTrigger
      }
    });

    this.log(`AUTO-TP closed ${pairId} pnl=${(pnlPctAtTrigger * 100).toFixed(0)}% salvage=$${estimatedSalvage.toFixed(0)} foxify=$${foxifyShareUsdc.toFixed(0)} atticus=$${atticusShareUsdc.toFixed(0)}`);
    return "closed";
  }

  private log(msg: string, meta?: Record<string, unknown>): void {
    const fn = this.deps.log ?? ((m, x) => console.log(`[shadowAutoTp] ${m}`, x ?? ""));
    fn(msg, meta);
  }
}
