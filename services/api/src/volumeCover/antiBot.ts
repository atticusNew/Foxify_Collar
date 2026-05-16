/**
 * P1g — Volume Cover anti-bot (Layers 1+2 deployed pre-launch).
 *
 * Layer 1 — same-asset opposite-side / repeat-cell block per fingerprint:
 *   For VC the cells are SYMMETRIC strangles (both sides), so the
 *   pilot's "long+short pair" rule maps to: same fingerprint may not
 *   open the same cell more than once within
 *   VC_ANTIBOT_LAYER1_WINDOW_MIN minutes.
 *
 * Layer 2 — random-jitter activation cooldown:
 *   After ANY successful activation by a fingerprint, set
 *   next_allowed_activate_at = now + base + uniform(0, jitter_max).
 *   Default base 60s, jitter 30-300s. Bot can't predict next allowed
 *   slot; real traders rarely activate twice in <5min.
 *
 * Layers 3+4 (trigger-induced cooldown + premium surcharge) are
 * deployed in P3 at Hour 36-48.
 *
 * Schema: volume_cover_fingerprint_state — single row per fingerprint
 * with throttling metadata. Additive migration via ensureSchema.
 *
 * Bypass header: X-Bypass-Antibot: <admin token> — used in staging
 * smoke + emergency unblock.
 */

import type { Pool } from "pg";

export type AntiBotConfig = {
  layer1Enabled: boolean;
  layer1WindowMs: number;
  layer2Enabled: boolean;
  layer2BaseMs: number;
  layer2JitterMaxMs: number;
};

const DEFAULTS: AntiBotConfig = {
  layer1Enabled: true,
  layer1WindowMs: 60 * 60_000, // 60 minutes
  layer2Enabled: true,
  layer2BaseMs: 60_000, // 60 seconds
  layer2JitterMaxMs: 300_000 // 5 minutes
};

const readConfig = (): AntiBotConfig => {
  const cfg = { ...DEFAULTS };
  const env = process.env;
  if (env.VOLUME_COVER_ANTIBOT_LAYER1_ENABLED === "false") cfg.layer1Enabled = false;
  if (env.VOLUME_COVER_ANTIBOT_LAYER2_ENABLED === "false") cfg.layer2Enabled = false;
  const num = (s: string | undefined, fallback: number): number => {
    if (!s) return fallback;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  cfg.layer1WindowMs = num(env.VOLUME_COVER_ANTIBOT_LAYER1_WINDOW_MS, cfg.layer1WindowMs);
  cfg.layer2BaseMs = num(env.VOLUME_COVER_ANTIBOT_LAYER2_BASE_MS, cfg.layer2BaseMs);
  cfg.layer2JitterMaxMs = num(env.VOLUME_COVER_ANTIBOT_LAYER2_JITTER_MS_MAX, cfg.layer2JitterMaxMs);
  return cfg;
};

// ─── Schema ──────────────────────────────────────────────────

export const ensureAntiBotSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS volume_cover_fingerprint_state (
      fingerprint_hash TEXT PRIMARY KEY,
      last_activate_at TIMESTAMPTZ,
      last_activate_cell_id TEXT,
      next_allowed_activate_at TIMESTAMPTZ,
      last_trigger_at TIMESTAMPTZ,
      pattern_strikes INTEGER NOT NULL DEFAULT 0,
      surcharge_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const safeIdx = async (sql: string): Promise<void> => {
    try { await pool.query(sql); } catch { /* idx exists */ }
  };
  await safeIdx(`CREATE INDEX idx_vc_fp_next_allowed ON volume_cover_fingerprint_state (next_allowed_activate_at)`);
};

// ─── Decision API ────────────────────────────────────────────

export type AntiBotCheckResult =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "layer1_repeat_cell_window"
        | "layer2_cooldown_active";
      message: string;
      retryAfterMs?: number;
    };

/**
 * Check whether a new activation is allowed. PURE READ — call this
 * before openPosition. On allow, caller must call recordActivation
 * after successful open.
 */
export const checkAntiBot = async (params: {
  pool: Pool;
  fingerprintHash: string;
  cellId: string;
  bypass?: boolean;
  /** Test override of "now". */
  nowMs?: number;
  cfgOverride?: Partial<AntiBotConfig>;
}): Promise<AntiBotCheckResult> => {
  if (params.bypass) return { allowed: true };
  const cfg = { ...readConfig(), ...(params.cfgOverride ?? {}) };
  const nowMs = params.nowMs ?? Date.now();

  const r = await params.pool.query(
    `SELECT last_activate_at, last_activate_cell_id, next_allowed_activate_at
     FROM volume_cover_fingerprint_state
     WHERE fingerprint_hash = $1`,
    [params.fingerprintHash]
  );
  if (r.rows.length === 0) {
    return { allowed: true };
  }
  const row = r.rows[0];

  // Layer 1: same cell within window
  if (cfg.layer1Enabled && row.last_activate_at && row.last_activate_cell_id === params.cellId) {
    const lastMs = new Date(row.last_activate_at).getTime();
    const elapsed = nowMs - lastMs;
    if (elapsed < cfg.layer1WindowMs) {
      return {
        allowed: false,
        reason: "layer1_repeat_cell_window",
        message: `Repeat ${params.cellId} activation by same fingerprint blocked (${Math.round(elapsed / 1000)}s ago, window ${cfg.layer1WindowMs / 60_000}min).`,
        retryAfterMs: cfg.layer1WindowMs - elapsed
      };
    }
  }

  // Layer 2: cooldown
  if (cfg.layer2Enabled && row.next_allowed_activate_at) {
    const nextMs = new Date(row.next_allowed_activate_at).getTime();
    if (nowMs < nextMs) {
      return {
        allowed: false,
        reason: "layer2_cooldown_active",
        message: `Activation cooldown active. Retry in ${Math.round((nextMs - nowMs) / 1000)}s.`,
        retryAfterMs: nextMs - nowMs
      };
    }
  }

  return { allowed: true };
};

/**
 * Record a successful activation; updates last_activate + sets next
 * allowed activation = now + base + uniform(0, jitterMax).
 */
export const recordActivation = async (params: {
  pool: Pool;
  fingerprintHash: string;
  cellId: string;
  nowMs?: number;
  /** Test override of jitter for deterministic tests. */
  jitterFnForTest?: () => number;
  cfgOverride?: Partial<AntiBotConfig>;
}): Promise<{ nextAllowedAtIso: string }> => {
  const cfg = { ...readConfig(), ...(params.cfgOverride ?? {}) };
  const nowMs = params.nowMs ?? Date.now();
  const jitter = params.jitterFnForTest
    ? params.jitterFnForTest()
    : Math.floor(Math.random() * cfg.layer2JitterMaxMs);
  const nextAllowedMs = cfg.layer2Enabled ? nowMs + cfg.layer2BaseMs + jitter : nowMs;
  const nextAllowedAtIso = new Date(nextAllowedMs).toISOString();
  const lastActivateAtIso = new Date(nowMs).toISOString();

  // Upsert
  await params.pool.query(
    `INSERT INTO volume_cover_fingerprint_state
       (fingerprint_hash, last_activate_at, last_activate_cell_id, next_allowed_activate_at)
     VALUES ($1, $2::timestamptz, $3, $4::timestamptz)
     ON CONFLICT (fingerprint_hash) DO UPDATE SET
       last_activate_at = EXCLUDED.last_activate_at,
       last_activate_cell_id = EXCLUDED.last_activate_cell_id,
       next_allowed_activate_at = EXCLUDED.next_allowed_activate_at,
       updated_at = NOW()`,
    [params.fingerprintHash, lastActivateAtIso, params.cellId, nextAllowedAtIso]
  );
  return { nextAllowedAtIso };
};

/**
 * Record a trigger event for a fingerprint (Layer 3 prereq, deployed
 * in P3 — exposed now so positionLifecycle can populate the column
 * which P3 then enforces against).
 */
export const recordTriggerForFingerprint = async (params: {
  pool: Pool;
  fingerprintHash: string;
  nowMs?: number;
}): Promise<void> => {
  const ts = new Date(params.nowMs ?? Date.now()).toISOString();
  await params.pool.query(
    `INSERT INTO volume_cover_fingerprint_state (fingerprint_hash, last_trigger_at)
     VALUES ($1, $2::timestamptz)
     ON CONFLICT (fingerprint_hash) DO UPDATE SET
       last_trigger_at = EXCLUDED.last_trigger_at,
       updated_at = NOW()`,
    [params.fingerprintHash, ts]
  );
};
