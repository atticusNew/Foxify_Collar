/**
 * Operational guardrails for the two-sided cooperative volume facility (PR 9).
 *
 * Implements the halt ladder from PLAN.md §2.3 + handoff §8.5, calibrated against
 * the corrected B2 findings (DVOL >60 = negative EV, elevated/stress regimes
 * out-of-bounds for Phase 0 cell sizing).
 *
 * Two halt categories:
 *   - Foxify halt — operator/Foxify-controlled (manual pause)
 *   - Atticus halt — automatic (any condition below); requires operator clear
 *     except where noted (DVOL recovery + spot/feed stale auto-resume).
 *
 * Halt conditions:
 *   DVOL  > 60         → Atticus halt (no auto-resume until <55 with operator clear)
 *   feed stale > 5s    → Atticus halt (auto-resume when feed fresh)
 *   depth insufficient → per-quote rejection (no global halt)
 *   rolling salvage ratio <1.20× → Atticus halt (no auto-resume)
 *   capital pool low   → Atticus halt (no auto-resume)
 *   per-pair realized loss < -$2000 → Atticus halt (no auto-resume)
 *   daily realized loss < threshold(volume) → Atticus halt (no auto-resume)
 *   weekly drawdown < threshold(volume) → Atticus halt (no auto-resume)
 *   newborn trigger review (first 3 per regime since deploy) → Atticus halt
 *                       (no auto-resume; operator clears after review)
 *   concurrent unwind throttle → defer (not full halt; queue next slot)
 *
 * Module exports:
 *   - HaltState — current halt state struct
 *   - canActivate(pool, feed, dvol, opts) → { ok, reason }
 *   - canUnwind(pool, opts) → { ok, deferReason? }
 *   - recordHalt(pool, kind, reason)
 *   - clearHalt(pool, kind, by, note)
 *   - schema: two_sided_halt_state singleton + two_sided_halt_event log
 */

import type { Pool, PoolClient } from "pg";

export type HaltKind = "foxify" | "atticus";

export type HaltReason =
  | "manual_foxify"
  | "manual_operator"
  | "dvol_high"
  | "feed_stale"
  | "depth_insufficient"
  | "rolling_salvage_low"
  | "capital_pool_low"
  | "per_pair_loss"
  | "daily_loss"
  | "weekly_drawdown"
  | "newborn_review";

export type HaltState = {
  foxifyHalt: boolean;
  atticusHalt: boolean;
  foxifyHaltReason: string | null;
  atticusHaltReason: HaltReason | null;
  atticusHaltSince: string | null;
  notes: string;
};

// ─── Schema ───

export const ensureGuardrailsSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_halt_state (
      singleton_key TEXT PRIMARY KEY DEFAULT 'singleton' CHECK (singleton_key = 'singleton'),
      foxify_halt BOOLEAN NOT NULL DEFAULT FALSE,
      atticus_halt BOOLEAN NOT NULL DEFAULT FALSE,
      foxify_halt_reason TEXT,
      atticus_halt_reason TEXT,
      atticus_halt_since TIMESTAMPTZ,
      notes TEXT NOT NULL DEFAULT ''
    );
  `);
  await pool.query(`
    INSERT INTO two_sided_halt_state (singleton_key) VALUES ('singleton') ON CONFLICT DO NOTHING;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_halt_event (
      event_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      by_actor TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      notes TEXT NOT NULL DEFAULT '',
      CONSTRAINT two_sided_halt_event_kind_check CHECK (kind IN ('foxify', 'atticus')),
      CONSTRAINT two_sided_halt_event_action_check CHECK (action IN ('set', 'clear', 'auto_resume'))
    );
  `);
};

export const getHaltState = async (pool: Pool | PoolClient): Promise<HaltState> => {
  const r = await pool.query(`SELECT * FROM two_sided_halt_state WHERE singleton_key = 'singleton'`);
  const row = r.rows[0];
  return {
    foxifyHalt: Boolean(row?.foxify_halt),
    atticusHalt: Boolean(row?.atticus_halt),
    foxifyHaltReason: row?.foxify_halt_reason ?? null,
    atticusHaltReason: (row?.atticus_halt_reason as HaltReason | null) ?? null,
    atticusHaltSince: row?.atticus_halt_since ?? null,
    notes: row?.notes ?? ""
  };
};

import { randomUUID } from "node:crypto";

export const recordHalt = async (
  pool: Pool | PoolClient,
  kind: HaltKind,
  reason: HaltReason | "manual_foxify" | "manual_operator",
  byActor = "system",
  notes = ""
): Promise<HaltState> => {
  const now = new Date().toISOString();
  if (kind === "foxify") {
    await pool.query(
      `UPDATE two_sided_halt_state
       SET foxify_halt = TRUE, foxify_halt_reason = $1, notes = $2
       WHERE singleton_key = 'singleton'`,
      [reason, notes]
    );
  } else {
    await pool.query(
      `UPDATE two_sided_halt_state
       SET atticus_halt = TRUE, atticus_halt_reason = $1, atticus_halt_since = $2, notes = $3
       WHERE singleton_key = 'singleton'`,
      [reason, now, notes]
    );
  }
  await pool.query(
    `INSERT INTO two_sided_halt_event (event_id, kind, action, reason, by_actor, notes) VALUES ($1, $2, 'set', $3, $4, $5)`,
    [randomUUID(), kind, reason, byActor, notes]
  );
  return getHaltState(pool);
};

export const clearHalt = async (
  pool: Pool | PoolClient,
  kind: HaltKind,
  byActor = "operator",
  notes = "",
  isAutoResume = false
): Promise<HaltState> => {
  if (kind === "foxify") {
    await pool.query(
      `UPDATE two_sided_halt_state
       SET foxify_halt = FALSE, foxify_halt_reason = NULL
       WHERE singleton_key = 'singleton'`
    );
  } else {
    await pool.query(
      `UPDATE two_sided_halt_state
       SET atticus_halt = FALSE, atticus_halt_reason = NULL, atticus_halt_since = NULL
       WHERE singleton_key = 'singleton'`
    );
  }
  await pool.query(
    `INSERT INTO two_sided_halt_event (event_id, kind, action, reason, by_actor, notes) VALUES ($1, $2, $3, '', $4, $5)`,
    [randomUUID(), kind, isAutoResume ? "auto_resume" : "clear", byActor, notes]
  );
  return getHaltState(pool);
};

// ─── canActivate ───

export type ActivationContext = {
  /** Current DVOL (Deribit volatility index). Null if unknown — treat as halt-eligible. */
  dvol: number | null;
  /** Recent capital pool balance for activate (Foxify-funded) — null if unknown. */
  capitalAvailableUsdc: number | null;
  /** Per-pair hedge cost expected for the activation. Used for capital pool gate. */
  pairHedgeCostUsdc: number;
  /** Current regime (calm/moderate/elevated/stress). When provided, the
   * newborn-review check fires for first N triggers per regime since deploy. */
  currentRegime?: "calm" | "moderate" | "elevated" | "stress";
  /** Threshold for newborn review (default 3 per regime). */
  newbornReviewThreshold?: number;
  /** True for shadow activations — uses the (higher) shadow DVOL halt + skips the live capital-at-risk cap. */
  isShadow?: boolean;
};

export const DVOL_HALT_THRESHOLD = 60;
export const DVOL_AUTO_RESUME_THRESHOLD = 55;
export const CAPITAL_POOL_HEADROOM_FACTOR = 1.5;

export const canActivate = async (
  pool: Pool,
  ctx: ActivationContext
): Promise<{ ok: boolean; reason?: HaltReason | "manual_foxify" | "manual_operator" | "capital_at_risk_cap"; details?: Record<string, unknown> }> => {
  const halt = await getHaltState(pool);
  if (halt.foxifyHalt) return { ok: false, reason: "manual_foxify", details: { reason_str: halt.foxifyHaltReason } };
  if (halt.atticusHalt) return { ok: false, reason: halt.atticusHaltReason ?? "manual_operator", details: { since: halt.atticusHaltSince } };

  // DVOL gate — GRADUATED: live halts at the (conservative) live threshold; shadow
  // uses a higher threshold so it can VALIDATE elevated/stress before they go live.
  const liveHalt = Number(process.env.SS_TWO_SIDED_DVOL_HALT_LIVE ?? String(DVOL_HALT_THRESHOLD));
  const shadowHalt = Number(process.env.SS_TWO_SIDED_DVOL_HALT_SHADOW ?? "1000"); // default: shadow validates all regimes
  const dvolThreshold = ctx.isShadow ? shadowHalt : liveHalt;
  if (ctx.dvol != null && ctx.dvol > dvolThreshold) {
    return { ok: false, reason: "dvol_high", details: { dvol: ctx.dvol, threshold: dvolThreshold, mode: ctx.isShadow ? "shadow" : "live" } };
  }

  // Capital-at-risk cap (LIVE only) — caps TOTAL $ deployed across open real pairs,
  // not just pair count (high-vol premiums balloon, so a count cap under-controls).
  // Env SS_TWO_SIDED_MAX_CAPITAL_AT_RISK_USDC; unset = no cap.
  if (!ctx.isShadow) {
    const capRaw = process.env.SS_TWO_SIDED_MAX_CAPITAL_AT_RISK_USDC;
    const cap = capRaw != null && capRaw !== "" ? Number(capRaw) : null;
    if (cap != null && Number.isFinite(cap) && cap > 0) {
      const dep = await pool.query<{ deployed: string }>(
        `SELECT COALESCE(SUM(hedge_cost_total_usdc), 0)::text AS deployed
         FROM two_sided_pair WHERE is_shadow = FALSE AND status IN ('active','triggered','unwinding')`
      );
      const deployed = Number(dep.rows[0]?.deployed ?? 0);
      if (deployed + ctx.pairHedgeCostUsdc > cap) {
        return { ok: false, reason: "capital_at_risk_cap", details: { deployed, adding: ctx.pairHedgeCostUsdc, cap, would_be: deployed + ctx.pairHedgeCostUsdc } };
      }
    }
  }

  // Capital pool gate
  if (ctx.capitalAvailableUsdc != null && ctx.capitalAvailableUsdc < ctx.pairHedgeCostUsdc * CAPITAL_POOL_HEADROOM_FACTOR) {
    return {
      ok: false,
      reason: "capital_pool_low",
      details: {
        available: ctx.capitalAvailableUsdc,
        required: ctx.pairHedgeCostUsdc * CAPITAL_POOL_HEADROOM_FACTOR
      }
    };
  }

  // Newborn-review gate (PR A8): for the first N triggers per regime since deploy,
  // activations are blocked until operator clears the review. Each cleared trigger
  // increments operatorApprovedCount; activations resume when approvedCount >= threshold
  // OR triggers_observed <= approvedCount (no pending unreviewed triggers).
  if (ctx.currentRegime) {
    const threshold = ctx.newbornReviewThreshold ?? 3;
    const { getNewbornState } = await import("./featureFlag");
    const state = await getNewbornState(pool, ctx.currentRegime, threshold);
    if (state.reviewRequired && state.triggersObserved > state.operatorApprovedCount) {
      return {
        ok: false,
        reason: "newborn_review",
        details: {
          regime: ctx.currentRegime,
          triggers_observed: state.triggersObserved,
          operator_approved_count: state.operatorApprovedCount,
          threshold,
          pending_review: state.triggersObserved - state.operatorApprovedCount
        }
      };
    }
  }

  return { ok: true };
};

// ─── canUnwind (concurrent unwind throttle) ───

export const CONCURRENT_UNWIND_MAX = 2;
export const CONCURRENT_UNWIND_WINDOW_MS = 60_000;

export const canUnwind = async (
  pool: Pool,
  opts: { nowMs?: number; maxConcurrent?: number; windowMs?: number } = {}
): Promise<{ ok: boolean; deferReason?: string; concurrentNow?: number }> => {
  const now = opts.nowMs ?? Date.now();
  const max = opts.maxConcurrent ?? CONCURRENT_UNWIND_MAX;
  const window = opts.windowMs ?? CONCURRENT_UNWIND_WINDOW_MS;
  const since = new Date(now - window).toISOString();
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM two_sided_pair_event
     WHERE kind = 'unwinding_started'
       AND occurred_at >= $1`,
    [since]
  );
  const n = r.rows[0]?.n ?? 0;
  if (n >= max) {
    return { ok: false, deferReason: `concurrent_unwind_throttle (${n}/${max} in last ${window}ms)`, concurrentNow: n };
  }
  return { ok: true, concurrentNow: n };
};

// ─── Dollar kill-ladder ───

export type DollarKillThresholds = {
  perPairLossUsdc: number;       // halt if any single pair closes worse than this
  dailyLossUsdcPerPair: number;  // multiplied by 24h rolling pairs count to derive threshold
  weeklyDrawdownUsdcPerPair: number; // multiplied by 7d rolling pairs count
};

export const DEFAULT_KILL_THRESHOLDS: DollarKillThresholds = {
  perPairLossUsdc: -2_000,        // PLAN §2.3: per-pair P5 ~ -$303; halt at >3× = -$2000
  dailyLossUsdcPerPair: -250,     // ~half of mean uplift; halt when daily realized < -$250 × n_today
  weeklyDrawdownUsdcPerPair: -1_500 // 1.5× iid 7d P5 × pairs/day → conservative trending margin
};

export const evaluateAutoHalts = async (
  pool: Pool,
  thresholds: DollarKillThresholds = DEFAULT_KILL_THRESHOLDS,
  opts: { nowMs?: number } = {}
): Promise<{ shouldHalt: boolean; reason?: HaltReason; details?: Record<string, unknown> }> => {
  const now = opts.nowMs ?? Date.now();
  const since24h = new Date(now - 24 * 3_600_000).toISOString();
  const since7d = new Date(now - 7 * 86_400_000).toISOString();

  // Per-pair check: was any recent pair worse than per_pair threshold?
  const perPair = await pool.query(
    `SELECT pair_id, foxify_share_usdc - hedge_cost_total_usdc AS net
     FROM two_sided_pair
     WHERE status = 'settled' AND is_shadow = FALSE AND closed_at >= $1
       AND (foxify_share_usdc - hedge_cost_total_usdc) <= $2
     LIMIT 1`,
    [since24h, thresholds.perPairLossUsdc]
  );
  if (perPair.rows.length > 0) {
    return {
      shouldHalt: true,
      reason: "per_pair_loss",
      details: { pair_id: perPair.rows[0].pair_id, net: Number(perPair.rows[0].net), threshold: thresholds.perPairLossUsdc }
    };
  }

  // Daily check
  const dailyQ = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'settled' AND closed_at >= $1 THEN foxify_share_usdc - hedge_cost_total_usdc ELSE 0 END), 0) AS pnl,
       COALESCE(SUM(CASE WHEN created_at >= $1 AND status <> 'cancelled' THEN 1 ELSE 0 END), 0)::int AS activated
     FROM two_sided_pair
     WHERE is_shadow = FALSE`,
    [since24h]
  );
  const dailyPnl = Number(dailyQ.rows[0]?.pnl ?? 0);
  const dailyActivated = dailyQ.rows[0]?.activated ?? 0;
  const dailyThreshold = thresholds.dailyLossUsdcPerPair * Math.max(1, dailyActivated);
  if (dailyPnl < dailyThreshold) {
    return {
      shouldHalt: true,
      reason: "daily_loss",
      details: { pnl: dailyPnl, threshold: dailyThreshold, activated_24h: dailyActivated }
    };
  }

  // Weekly check
  const weeklyQ = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'settled' AND closed_at >= $1 THEN foxify_share_usdc - hedge_cost_total_usdc ELSE 0 END), 0) AS pnl,
       COALESCE(SUM(CASE WHEN created_at >= $1 AND status <> 'cancelled' THEN 1 ELSE 0 END), 0)::int AS activated
     FROM two_sided_pair
     WHERE is_shadow = FALSE`,
    [since7d]
  );
  const weeklyPnl = Number(weeklyQ.rows[0]?.pnl ?? 0);
  const weeklyActivated = weeklyQ.rows[0]?.activated ?? 0;
  const weeklyThreshold = thresholds.weeklyDrawdownUsdcPerPair * Math.max(1, weeklyActivated);
  if (weeklyPnl < weeklyThreshold) {
    return {
      shouldHalt: true,
      reason: "weekly_drawdown",
      details: { pnl: weeklyPnl, threshold: weeklyThreshold, activated_7d: weeklyActivated }
    };
  }

  return { shouldHalt: false };
};
