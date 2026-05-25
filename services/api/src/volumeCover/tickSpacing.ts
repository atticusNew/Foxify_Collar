/**
 * Volume Cover tick-spacing gate (PR-G, 2026-05-25).
 *
 * Anti-bursty-open guard for Foxify pair activations. Rejects a new
 * `/volume-cover/activate` when the most recent position on the SAME
 * cell was opened too recently AND at a near-identical spot.
 *
 * The gate is a logical AND of two conditions; either one alone passes:
 *
 *   - cooldown: now − lastOpenedAt < `minMs`    (default 60s)
 *   - co-located: |spot − lastEntryBtc| < `minBtcUsdc`  (default $400)
 *
 * Pass when EITHER:
 *   • cooldown elapsed (enough time has passed),
 *   • OR BTC has moved enough that this is a meaningfully different setup.
 *
 * Reject only when BOTH gates are still tight (rapid same-spot opens).
 *
 * Tunable via env:
 *   VC_TICK_SPACING_MIN_MS         (default 60000)
 *   VC_TICK_SPACING_MIN_BTC_USDC   (default 400)
 *   VC_TICK_SPACING_ENABLED        (default true; "false" disables)
 *
 * Pure logic; no DB or HTTP. The route layer handles the SQL lookup
 * and the 429 response shape.
 */

export type TickSpacingConfig = {
  enabled: boolean;
  minMs: number;
  minBtcUsdc: number;
};

const DEFAULTS: TickSpacingConfig = {
  enabled: true,
  minMs: 60_000,
  minBtcUsdc: 400
};

const readNumber = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const readBool = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  return String(raw).trim().toLowerCase() !== "false";
};

export const getConfiguredTickSpacing = (): TickSpacingConfig => ({
  enabled: readBool("VC_TICK_SPACING_ENABLED", DEFAULTS.enabled),
  minMs: readNumber("VC_TICK_SPACING_MIN_MS", DEFAULTS.minMs),
  minBtcUsdc: readNumber("VC_TICK_SPACING_MIN_BTC_USDC", DEFAULTS.minBtcUsdc)
});

export type TickSpacingDecision =
  | { allowed: true; reason: null; retryAfterMs: 0 }
  | {
      allowed: false;
      reason: "tick_spacing_violation";
      message: string;
      retryAfterMs: number;
      lastOpenedAtIso: string;
      lastEntryBtcUsdc: number;
      currentEntryBtcUsdc: number;
      elapsedMs: number;
      btcDeltaUsdc: number;
      minMs: number;
      minBtcUsdc: number;
    };

/**
 * Evaluate the tick-spacing gate. Returns `allowed: true` when no prior
 * position exists OR the cooldown elapsed OR BTC moved enough.
 *
 * Inputs are explicit so this is a pure function — caller resolves
 * the DB row and timestamps.
 */
export const evaluateTickSpacing = (params: {
  lastOpenedAtIso: string | null;
  lastEntryBtcUsdc: number | null;
  currentEntryBtcUsdc: number;
  nowMs?: number;
  cfg?: TickSpacingConfig;
}): TickSpacingDecision => {
  const cfg = params.cfg ?? getConfiguredTickSpacing();
  if (!cfg.enabled) {
    return { allowed: true, reason: null, retryAfterMs: 0 };
  }
  if (params.lastOpenedAtIso === null || params.lastEntryBtcUsdc === null) {
    return { allowed: true, reason: null, retryAfterMs: 0 };
  }
  const nowMs = params.nowMs ?? Date.now();
  const lastMs = new Date(params.lastOpenedAtIso).getTime();
  if (!Number.isFinite(lastMs)) {
    return { allowed: true, reason: null, retryAfterMs: 0 };
  }
  const elapsedMs = Math.max(0, nowMs - lastMs);
  const btcDeltaUsdc = Math.abs(params.currentEntryBtcUsdc - params.lastEntryBtcUsdc);
  const cooldownMet = elapsedMs >= cfg.minMs;
  const movedEnough = btcDeltaUsdc >= cfg.minBtcUsdc;
  if (cooldownMet || movedEnough) {
    return { allowed: true, reason: null, retryAfterMs: 0 };
  }
  // Both gates tight → block. retry-after is the remaining cooldown.
  const retryAfterMs = Math.max(0, cfg.minMs - elapsedMs);
  return {
    allowed: false,
    reason: "tick_spacing_violation",
    message:
      `same-cell open ${elapsedMs}ms ago at $${params.lastEntryBtcUsdc.toFixed(2)} BTC ` +
      `(now $${params.currentEntryBtcUsdc.toFixed(2)}, Δ $${btcDeltaUsdc.toFixed(2)}); ` +
      `tick-spacing gate requires either ${cfg.minMs}ms elapsed OR ` +
      `$${cfg.minBtcUsdc} BTC move`,
    retryAfterMs,
    lastOpenedAtIso: params.lastOpenedAtIso,
    lastEntryBtcUsdc: params.lastEntryBtcUsdc,
    currentEntryBtcUsdc: params.currentEntryBtcUsdc,
    elapsedMs,
    btcDeltaUsdc,
    minMs: cfg.minMs,
    minBtcUsdc: cfg.minBtcUsdc
  };
};
