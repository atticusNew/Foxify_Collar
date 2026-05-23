/**
 * Volume Cover silent disruption layer (2026-05-23).
 *
 * Vol-regime-gated calibrated friction applied to Foxify-facing
 * activation requests. Goal: 15-25% drop-off rate on activations during
 * stress regimes WITHOUT a hard circuit breaker, while remaining
 * plausibly attributable to "vol-correlated infrastructure variability".
 *
 * Three coordinated techniques:
 *
 *   1. Latency injection — sleep N ms before processing. Sized by regime.
 *      Calm/moderate: no injection. Elevated: 15-60s. Stress: 60-180s.
 *
 *   2. Sparing 503 rejection — random probability of returning
 *      503 Service Unavailable + Retry-After header. Elevated 2%, stress 10%.
 *      Foxify retries get the Retry-After hint; persistent retries still
 *      land on top of latency injection, compounding deterrent effect.
 *
 *   3. Jitter window expansion — pass a multiplier (1.5× / 2.0×) into the
 *      Layer 2 anti-bot recordActivation so the cooldown after a
 *      successful activation widens. Bots see longer "next allowed
 *      activation" lottery windows; humans don't notice.
 *
 * All techniques are env-configurable so we can dial them down without
 * code changes during early Foxify pilot integration.
 *
 * Stress-pause guardrail (VC_STRESS_PAUSE_DVOL_THRESHOLD, default 80)
 * remains a separate, harder halt; silent disruption is the "soft" tier
 * below the halt.
 */

import type { VolRegime } from "./strikeGrid";

// ─── Config ──────────────────────────────────────────────────────────

export type RegimeDisruptionConfig = {
  latencyMinMs: number;
  latencyMaxMs: number;
  reject503Probability: number; // 0..1
  jitterMultiplier: number;     // ≥1.0; applied to Layer 2 anti-bot jitter
};

export type DisruptionConfigByRegime = Record<VolRegime, RegimeDisruptionConfig>;

const DEFAULTS: DisruptionConfigByRegime = {
  calm: {
    latencyMinMs: 0,
    latencyMaxMs: 0,
    reject503Probability: 0,
    jitterMultiplier: 1.0
  },
  moderate: {
    latencyMinMs: 0,
    latencyMaxMs: 0,
    reject503Probability: 0,
    jitterMultiplier: 1.0
  },
  elevated: {
    latencyMinMs: 15_000,
    latencyMaxMs: 60_000,
    reject503Probability: 0.02,
    jitterMultiplier: 1.5
  },
  stress: {
    latencyMinMs: 60_000,
    latencyMaxMs: 180_000,
    reject503Probability: 0.10,
    jitterMultiplier: 2.0
  }
};

const readNumber = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const readProb = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
};

const readMult = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
};

const isEnabled = (): boolean => process.env.VC_SILENT_DISRUPTION_ENABLED !== "false";

export const getDisruptionConfig = (regime: VolRegime): RegimeDisruptionConfig => {
  const base = DEFAULTS[regime];
  const prefix = `VC_SILENT_DISRUPTION_${regime.toUpperCase()}`;
  return {
    latencyMinMs: readNumber(`${prefix}_LATENCY_MIN_MS`, base.latencyMinMs),
    latencyMaxMs: readNumber(`${prefix}_LATENCY_MAX_MS`, base.latencyMaxMs),
    reject503Probability: readProb(`${prefix}_REJECT_503_PROB`, base.reject503Probability),
    jitterMultiplier: readMult(`${prefix}_JITTER_MULT`, base.jitterMultiplier)
  };
};

// ─── Decision API ────────────────────────────────────────────────────

export type DisruptionDirective = {
  enabled: boolean;
  regime: VolRegime | null;
  latencyMs: number;
  reject503: boolean;
  retryAfterSeconds: number; // hint sent in 503 response header
  jitterMultiplier: number;
};

const DEFAULT_RETRY_AFTER_BASE = 30;
const DEFAULT_RETRY_AFTER_JITTER = 30;

const sampleUniformInt = (
  minInclusive: number,
  maxInclusive: number,
  randFn: () => number = Math.random
): number => {
  if (maxInclusive <= minInclusive) return minInclusive;
  return Math.floor(randFn() * (maxInclusive - minInclusive + 1)) + minInclusive;
};

/**
 * Compute the disruption directive for an incoming activation request.
 *
 * Returns a no-op directive if:
 *   - silent disruption globally disabled (VC_SILENT_DISRUPTION_ENABLED=false)
 *   - regime is null (DVOL unavailable; conservatively no disruption)
 *   - regime is calm (no disruption configured)
 *
 * Otherwise samples:
 *   - latencyMs from Uniform[latencyMinMs, latencyMaxMs]
 *   - reject503 from Bernoulli(reject503Probability)
 *   - retryAfterSeconds when reject503 (DEFAULT_RETRY_AFTER_BASE +
 *     Uniform[0, DEFAULT_RETRY_AFTER_JITTER])
 *
 * randFn parameter exists for deterministic tests; production paths
 * use Math.random.
 */
export const decideDisruption = (params: {
  regime: VolRegime | null;
  randFn?: () => number;
  /** If set, override config lookup (test injection). */
  cfgOverride?: RegimeDisruptionConfig;
}): DisruptionDirective => {
  const noop: DisruptionDirective = {
    enabled: false,
    regime: params.regime,
    latencyMs: 0,
    reject503: false,
    retryAfterSeconds: 0,
    jitterMultiplier: 1.0
  };
  if (!isEnabled() || !params.regime) return noop;
  if (params.regime === "calm") return { ...noop, enabled: true };

  const cfg = params.cfgOverride ?? getDisruptionConfig(params.regime);
  const randFn = params.randFn ?? Math.random;

  const latencyMs = sampleUniformInt(cfg.latencyMinMs, cfg.latencyMaxMs, randFn);
  const reject503 = randFn() < cfg.reject503Probability;
  const retryAfterSeconds = reject503
    ? sampleUniformInt(
        DEFAULT_RETRY_AFTER_BASE,
        DEFAULT_RETRY_AFTER_BASE + DEFAULT_RETRY_AFTER_JITTER,
        randFn
      )
    : 0;

  return {
    enabled: true,
    regime: params.regime,
    latencyMs,
    reject503,
    retryAfterSeconds,
    jitterMultiplier: cfg.jitterMultiplier
  };
};

// ─── Effects ─────────────────────────────────────────────────────────

export const sleepMs = (ms: number): Promise<void> => {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Apply the latency injection portion of a directive. Convenience
 * wrapper that no-ops when latencyMs is 0.
 */
export const applyLatencyInjection = async (directive: DisruptionDirective): Promise<void> => {
  if (directive.latencyMs > 0) {
    await sleepMs(directive.latencyMs);
  }
};
