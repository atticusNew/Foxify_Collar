/**
 * Live cutover feature flag + cell allowlist (PR 11).
 *
 * Phase 0 production traffic is gated by:
 *   - SS_TWO_SIDED_LIVE_ENABLED env var (default: false)
 *   - SS_TWO_SIDED_CELL_ALLOWLIST env var (default: "pair_50k_2pct" only)
 *   - SS_TWO_SIDED_MAX_PAIRS_PER_DAY env var (default: 2 — the conservative
 *     Phase 0 launch cap; operator raises after 30d soak)
 *   - SS_TWO_SIDED_BOOT_HALT env var (default: "true" — server boots with
 *     atticus_halt active; operator clears manually after sanity checks)
 *   - SS_TWO_SIDED_NEWBORN_REVIEW_PER_REGIME env var (default: 3 — count of
 *     triggered pairs per regime that auto-halt for operator review)
 *
 * checkLiveEnabled(cellId, todayCount) → { allowed: boolean, reason?: string }
 *   is the canonical gate. Call from handleActivate after preActivateGuard.
 */

import type { Pool } from "pg";
import { recordHalt } from "./guardrails";

export type LiveFlagConfig = {
  liveEnabled: boolean;
  cellAllowlist: ReadonlySet<string>;
  maxPairsPerDay: number;
  bootHalt: boolean;
  newbornReviewCountPerRegime: number;
};

export const getLiveFlagConfig = (env: NodeJS.ProcessEnv = process.env): LiveFlagConfig => ({
  liveEnabled: env.SS_TWO_SIDED_LIVE_ENABLED === "true",
  cellAllowlist: new Set(
    (env.SS_TWO_SIDED_CELL_ALLOWLIST ?? "pair_50k_2pct")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  ),
  maxPairsPerDay: Number(env.SS_TWO_SIDED_MAX_PAIRS_PER_DAY ?? "2"),
  bootHalt: env.SS_TWO_SIDED_BOOT_HALT !== "false",
  newbornReviewCountPerRegime: Number(env.SS_TWO_SIDED_NEWBORN_REVIEW_PER_REGIME ?? "3")
});

export const checkLiveEnabled = (
  cfg: LiveFlagConfig,
  cellId: string,
  todayPairsCount: number
): { allowed: boolean; reason?: string; details?: Record<string, unknown> } => {
  if (!cfg.liveEnabled) return { allowed: false, reason: "live_flag_disabled" };
  if (!cfg.cellAllowlist.has(cellId)) {
    return {
      allowed: false,
      reason: "cell_not_in_allowlist",
      details: { cellId, allowlist: Array.from(cfg.cellAllowlist) }
    };
  }
  if (todayPairsCount >= cfg.maxPairsPerDay) {
    return {
      allowed: false,
      reason: "daily_cap_reached",
      details: { todayCount: todayPairsCount, cap: cfg.maxPairsPerDay }
    };
  }
  return { allowed: true };
};

/**
 * Apply boot-time halt. Called once during server startup if cfg.bootHalt is true.
 * The halt requires manual operator clear before any production activations succeed.
 */
export const applyBootHalt = async (pool: Pool, cfg: LiveFlagConfig): Promise<void> => {
  if (!cfg.bootHalt) return;
  await recordHalt(pool, "atticus", "manual_operator", "boot_halt_system", "Phase 0 boot halt — operator must clear manually after sanity checks");
};

// ─── Newborn-trigger review (D3 per PLAN.md §4) ───
//
// Each regime gets a counter of triggered pairs since deploy. While the counter
// is below `newbornReviewCountPerRegime`, every trigger automatically activates
// a halt + records a review request. Operator clears halt + increments the
// approved count via clearNewbornReview().

export type Regime = "calm" | "moderate" | "elevated" | "stress";

export const ensureNewbornReviewSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_newborn_review (
      regime TEXT PRIMARY KEY,
      triggers_observed INTEGER NOT NULL DEFAULT 0,
      operator_approved_count INTEGER NOT NULL DEFAULT 0,
      last_trigger_at TIMESTAMPTZ,
      last_approved_at TIMESTAMPTZ,
      CONSTRAINT two_sided_newborn_review_regime_check CHECK (regime IN ('calm','moderate','elevated','stress'))
    );
  `);
  for (const r of ["calm", "moderate", "elevated", "stress"]) {
    await pool.query(`INSERT INTO two_sided_newborn_review (regime) VALUES ($1) ON CONFLICT DO NOTHING`, [r]);
  }
};

export type NewbornState = {
  regime: Regime;
  triggersObserved: number;
  operatorApprovedCount: number;
  reviewRequired: boolean;
};

export const getNewbornState = async (
  pool: Pool,
  regime: Regime,
  reviewThreshold: number
): Promise<NewbornState> => {
  const r = await pool.query(`SELECT * FROM two_sided_newborn_review WHERE regime = $1`, [regime]);
  const row = r.rows[0];
  const triggersObserved = row?.triggers_observed ?? 0;
  const approvedCount = row?.operator_approved_count ?? 0;
  return {
    regime,
    triggersObserved,
    operatorApprovedCount: approvedCount,
    reviewRequired: approvedCount < reviewThreshold
  };
};

export const recordNewbornTrigger = async (pool: Pool, regime: Regime): Promise<void> => {
  await pool.query(
    `UPDATE two_sided_newborn_review
     SET triggers_observed = triggers_observed + 1,
         last_trigger_at = NOW()
     WHERE regime = $1`,
    [regime]
  );
};

export const clearNewbornReview = async (pool: Pool, regime: Regime): Promise<void> => {
  await pool.query(
    `UPDATE two_sided_newborn_review
     SET operator_approved_count = operator_approved_count + 1,
         last_approved_at = NOW()
     WHERE regime = $1`,
    [regime]
  );
};

/**
 * AUTO-GRADUATE a regime's newborn review — lifts the manual-review requirement by
 * setting operator_approved_count to (at least) the threshold. Sticky (won't re-block).
 * Used by the auto-approve gate once a regime has accrued enough validated settlements,
 * so a production Foxify bot isn't blocked on its first fire in a proven regime.
 */
export const graduateNewbornReview = async (pool: Pool, regime: Regime, threshold: number): Promise<void> => {
  await pool.query(
    `UPDATE two_sided_newborn_review
     SET operator_approved_count = GREATEST(operator_approved_count, $2),
         last_approved_at = NOW()
     WHERE regime = $1`,
    [regime, threshold]
  );
};

/**
 * N validated settlements after which newborn review auto-graduates (env
 * SS_NEWBORN_AUTO_APPROVE_AFTER_N). Default 0 = DISABLED (manual review only,
 * unchanged behavior). Set > 0 to make a regime self-graduate once proven.
 */
export const newbornAutoApproveAfterN = (env: NodeJS.ProcessEnv = process.env): number => {
  const v = Number(env.SS_NEWBORN_AUTO_APPROVE_AFTER_N ?? "0");
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
};

/**
 * Is v2 LIVE execution armed? Controls whether the server wires the REAL
 * Bullish/Deribit executor vs the shadow (paper) executor.
 *
 * Accepts common truthy tokens — `true | live | 1 | yes | on` (case-insensitive).
 * RATIONALE: previously this was a strict `=== "true"` check, so a value like
 * `FOXIFY_V2_LIVE_EXECUTION=live` SILENTLY fell back to the shadow executor — an
 * isShadow=false activate then paper-filled (recorded the routed venue + a quote-ask
 * "fill") with NO real venue order, looking live but trading nothing. Accepting the
 * obvious truthy tokens prevents that silent-paper footgun. Default (unset/false/
 * anything-else) = shadow, so going live still requires an explicit truthy value.
 */
export const isLiveExecutionEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const v = String(env.FOXIFY_V2_LIVE_EXECUTION ?? "false").toLowerCase().trim();
  return v === "true" || v === "live" || v === "1" || v === "yes" || v === "on";
};

/** Classify DVOL into regime band — matches calibrateRegimeVolMarkup.ts and the validation MD. */
export const classifyRegime = (dvol: number): Regime => {
  if (dvol < 40) return "calm";
  if (dvol < 60) return "moderate";
  if (dvol < 85) return "elevated";
  return "stress";
};
