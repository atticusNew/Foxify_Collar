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
  /** P3: Layer 3 — trigger-induced cooldown duration. */
  layer3Enabled: boolean;
  layer3CooldownMs: number;
  /** P3: Layer 4 — premium surcharge on suspicious patterns. */
  layer4Enabled: boolean;
  layer4SurchargeMultiplier: number;
  layer4SurchargeDurationMs: number;
  layer4PatternStrikeThreshold: number;
};

const DEFAULTS: AntiBotConfig = {
  layer1Enabled: true,
  layer1WindowMs: 60 * 60_000, // 60 minutes
  layer2Enabled: true,
  layer2BaseMs: 60_000, // 60 seconds
  layer2JitterMaxMs: 300_000, // 5 minutes
  // P3
  layer3Enabled: true,
  layer3CooldownMs: 4 * 3_600_000, // 4 hours
  layer4Enabled: true,
  layer4SurchargeMultiplier: 1.5,
  layer4SurchargeDurationMs: 24 * 3_600_000, // 24h
  layer4PatternStrikeThreshold: 3
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
  if (env.VOLUME_COVER_ANTIBOT_LAYER3_ENABLED === "false") cfg.layer3Enabled = false;
  if (env.VOLUME_COVER_ANTIBOT_LAYER4_ENABLED === "false") cfg.layer4Enabled = false;
  cfg.layer3CooldownMs = num(env.VOLUME_COVER_ANTIBOT_LAYER3_COOLDOWN_MS, cfg.layer3CooldownMs);
  if (env.VOLUME_COVER_ANTIBOT_LAYER4_SURCHARGE_MULT) {
    const m = Number(env.VOLUME_COVER_ANTIBOT_LAYER4_SURCHARGE_MULT);
    if (Number.isFinite(m) && m > 1) cfg.layer4SurchargeMultiplier = m;
  }
  cfg.layer4SurchargeDurationMs = num(env.VOLUME_COVER_ANTIBOT_LAYER4_SURCHARGE_DURATION_MS, cfg.layer4SurchargeDurationMs);
  cfg.layer4PatternStrikeThreshold = num(env.VOLUME_COVER_ANTIBOT_LAYER4_PATTERN_STRIKES, cfg.layer4PatternStrikeThreshold);
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
  | {
      allowed: true;
      /** P3: surcharge multiplier applied to premium quote (default 1.0). */
      surchargeMultiplier?: number;
    }
  | {
      allowed: false;
      reason:
        | "layer1_repeat_cell_window"
        | "layer2_cooldown_active"
        | "layer3_post_trigger_cooldown";
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
    `SELECT last_activate_at, last_activate_cell_id, next_allowed_activate_at,
            last_trigger_at, surcharge_until
     FROM volume_cover_fingerprint_state
     WHERE fingerprint_hash = $1`,
    [params.fingerprintHash]
  );
  if (r.rows.length === 0) {
    return { allowed: true, surchargeMultiplier: 1.0 };
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

  // Layer 3 (P3): trigger-induced cooldown — block any activation
  // for cfg.layer3CooldownMs after this fingerprint had a trigger.
  if (cfg.layer3Enabled && row.last_trigger_at) {
    const triggerMs = new Date(row.last_trigger_at).getTime();
    const elapsed = nowMs - triggerMs;
    if (elapsed < cfg.layer3CooldownMs) {
      return {
        allowed: false,
        reason: "layer3_post_trigger_cooldown",
        message: `Post-trigger cooldown active (${Math.round(elapsed / 60_000)}min ago, window ${cfg.layer3CooldownMs / 3_600_000}h). Retry later.`,
        retryAfterMs: cfg.layer3CooldownMs - elapsed
      };
    }
  }

  // Layer 4 (P3): premium surcharge if surcharge_until > now.
  let surchargeMultiplier = 1.0;
  if (cfg.layer4Enabled && row.surcharge_until) {
    const surchargeUntilMs = new Date(row.surcharge_until).getTime();
    if (nowMs < surchargeUntilMs) {
      surchargeMultiplier = cfg.layer4SurchargeMultiplier;
    }
  }

  return { allowed: true, surchargeMultiplier };
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
 * P3 Layer 3: Record a trigger event for a fingerprint. Layer 3 reads
 * last_trigger_at to enforce cooldown at next activation attempt.
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

/**
 * P3 Layer 4: Record a "pattern strike" against a fingerprint and apply
 * surcharge if threshold reached. Pattern strikes are e.g.:
 *   - rapid open/close cycle (<60s)
 *   - quote/activate ratio > 5:1 over 50 quotes
 *   - Layer 1 block (attempted same-cell repeat)
 */
export const recordPatternStrike = async (params: {
  pool: Pool;
  fingerprintHash: string;
  nowMs?: number;
  cfgOverride?: Partial<AntiBotConfig>;
}): Promise<{ strikes: number; surchargeUntilIso: string | null }> => {
  const cfg = { ...readConfig(), ...(params.cfgOverride ?? {}) };
  const nowMs = params.nowMs ?? Date.now();

  // Atomic increment first, then conditionally apply surcharge.
  // Two-step to avoid pg-mem's CASE-with-self-reference quirks.
  const incResult = await params.pool.query(
    `INSERT INTO volume_cover_fingerprint_state (fingerprint_hash, pattern_strikes)
     VALUES ($1, 1)
     ON CONFLICT (fingerprint_hash) DO UPDATE SET
       pattern_strikes = volume_cover_fingerprint_state.pattern_strikes + 1,
       updated_at = NOW()
     RETURNING pattern_strikes, surcharge_until`,
    [params.fingerprintHash]
  );
  const newStrikes = Number(incResult.rows[0].pattern_strikes);
  let surchargeUntilIso = incResult.rows[0].surcharge_until
    ? String(incResult.rows[0].surcharge_until)
    : null;

  if (newStrikes >= cfg.layer4PatternStrikeThreshold) {
    const surchargeUntilMs = nowMs + cfg.layer4SurchargeDurationMs;
    surchargeUntilIso = new Date(surchargeUntilMs).toISOString();
    await params.pool.query(
      `UPDATE volume_cover_fingerprint_state
       SET surcharge_until = $2::timestamptz, updated_at = NOW()
       WHERE fingerprint_hash = $1`,
      [params.fingerprintHash, surchargeUntilIso]
    );
  }

  return {
    strikes: newStrikes,
    surchargeUntilIso
  };
};
