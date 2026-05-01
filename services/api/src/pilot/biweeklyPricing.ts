/**
 * Biweekly per-day subscription pricing module.
 *
 * Backs the biweekly product replacement for the 1-day product. This
 * module is ADDITIVE — it does not touch the existing pricingRegime.ts
 * or v7Pricing.ts modules that serve the live 1-day product. The
 * cutover from 1-day to biweekly happens in PR 3 (activate path) and
 * PR 5 (widget UX); until then, this module is dormant and the live
 * platform is unaffected.
 *
 * Design (per docs/cfo-report/phase0/D3_RESULTS_SUMMARY.md and
 * 2026-04-30 implementation plan):
 *
 *   - Per-day rate, locked at activation
 *   - Flat across vol regimes (deliberate: simpler trader UX, easier
 *     to find the absolute pricing floor; regime-variation can be
 *     re-enabled later by the same hook used today in pricingRegime.ts)
 *   - Trader's "premium" is accumulated daily during the protection
 *     life, not paid upfront. Settled on close, trigger, or expiry.
 *   - Maximum tenor 14 days
 *   - Single payout per protection (handled by triggerMonitor.ts existing logic)
 *
 * Starting rates (deliberately aggressive — see CEO direction
 * 2026-04-30): build the floor, raise if proven unsustainable.
 *
 *   2% SL: $2.50 / $1k notional / day
 *   3% SL: $2.50 / $1k notional / day
 *   5% SL: $2.00 / $1k notional / day
 *  10% SL: $1.50 / $1k notional / day
 *
 * On a typical $10k position these are $25/day for 2-3%, $20/day for
 * 5%, $15/day for 10%. Compared to the current 1-day product's $65/day
 * for low/2% on $10k, this is a ~60% reduction in trader-facing price.
 *
 * Adjustability
 * -------------
 * Two override paths, no deploy required for either:
 *   1. Env vars: PILOT_BIWEEKLY_RATE_2PCT, PILOT_BIWEEKLY_RATE_3PCT,
 *      PILOT_BIWEEKLY_RATE_5PCT, PILOT_BIWEEKLY_RATE_10PCT
 *      (any subset; missing falls through to the literal default below)
 *   2. setBiweeklyRateOverride() / clearBiweeklyRateOverride() for
 *      tests and future-runtime tuning
 *
 * If we want to re-introduce regime-variable rates (the D3-style
 * regime-aware table) later, the rate function's signature already
 * accepts an optional regime parameter — currently ignored. Wiring
 * regime back in is a one-line change.
 *
 * Feature flag
 * ------------
 * PILOT_BIWEEKLY_ENABLED gates the entire product path. Defaults to
 * false. PR 3 (activate) and PR 5 (widget) check this flag; when off,
 * the activate path falls through to the existing 1-day product.
 *
 * Render rollout flow:
 *   1. PRs 1-6 deploy with PILOT_BIWEEKLY_ENABLED unset (= false).
 *      Live platform continues running the 1-day product.
 *   2. Confirm Deribit account funded ≥ $1,500 added.
 *   3. Run pilot:migrate (if not auto-run on deploy).
 *   4. Set PILOT_BIWEEKLY_ENABLED=true in Render env. Save → Render
 *      restarts → biweekly is live for new activations.
 *   5. Existing 1-day trades continue to expire on the legacy path.
 */

import type { V7SlTier } from "./types";

// ─────────────────────────────────────────────────────────────────────
// Rate table (USD per $1k notional per day)
// ─────────────────────────────────────────────────────────────────────

/**
 * Default biweekly rates. Flat across regimes per CEO direction
 * 2026-04-30. Tuneable via env or setBiweeklyRateOverride().
 */
export const BIWEEKLY_DEFAULT_RATES: Readonly<Record<V7SlTier, number>> = Object.freeze({
  1: 2.5,   // 1% defined for forward compatibility (matches V7_LAUNCHED_TIERS exclusion)
  2: 2.5,
  3: 2.5,
  5: 2.0,
  10: 1.5
});

/**
 * Maximum protection duration in days. Hardcoded because the hedge
 * tenor (14-day option) and the trader-facing max tenor must match
 * to avoid roll cost / basis risk.
 */
export const BIWEEKLY_MAX_TENOR_DAYS = 14;

/**
 * Hedge tenor in days. Same as max tenor by design (no rolls).
 */
export const BIWEEKLY_HEDGE_TENOR_DAYS = 14;

/**
 * Tenor-drift bound (in days) for biweekly hedge quotes.
 *
 * Deribit weekly options settle Friday 08:00 UTC, so the grid spacing
 * around a 14-day target is 7 days. The nearest weekly expiry to any
 * given 14-day target is therefore at most ~3.5 days off (and usually
 * closer to 0–3 days). 4d = grid_spacing/2 + ~0.5d safety margin —
 * tight enough that the venue can never silently land on the 7d or
 * 21d expiry (>50% tenor mismatch, not a "small drift") yet wide
 * enough to always have a valid in-bound candidate on the weekly grid.
 *
 * This is the per-request override the biweekly handler passes to the
 * Deribit venue adapter. It does NOT change the global default
 * PILOT_DERIBIT_MAX_TENOR_DRIFT_DAYS=1.5 used by the legacy 1-day
 * product.
 *
 * Tunable in code if Deribit ever introduces denser grids at this
 * tenor (e.g. mid-week expiries); no env-var override on purpose
 * because misconfiguration here is hard to detect from logs and could
 * cause silent grid mismatches.
 */
export const BIWEEKLY_TENOR_DRIFT_BOUND_DAYS = 4;

/** Minimum days held to bill (anti-abuse: trader can't spam open/close to avoid charges). */
export const BIWEEKLY_MIN_DAYS_BILLED = 1;

// ─────────────────────────────────────────────────────────────────────
// Override mechanism (env + runtime)
// ─────────────────────────────────────────────────────────────────────

let runtimeOverride: Partial<Record<V7SlTier, number>> = {};

const ENV_KEY_BY_TIER: Record<V7SlTier, string> = {
  1: "PILOT_BIWEEKLY_RATE_1PCT",
  2: "PILOT_BIWEEKLY_RATE_2PCT",
  3: "PILOT_BIWEEKLY_RATE_3PCT",
  5: "PILOT_BIWEEKLY_RATE_5PCT",
  10: "PILOT_BIWEEKLY_RATE_10PCT"
};

/**
 * Parse an env var as a positive number. Returns null on missing,
 * non-numeric, or non-positive (so a typo in env doesn't silently
 * give traders free protection).
 */
const parseEnvRate = (envKey: string): number | null => {
  const raw = process.env[envKey];
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
};

/**
 * Set (or override) a per-tier rate at runtime. Intended for tests
 * and future operational tuning. Does not mutate the default table.
 */
export const setBiweeklyRateOverride = (tier: V7SlTier, ratePerDayPer1k: number): void => {
  if (!Number.isFinite(ratePerDayPer1k) || ratePerDayPer1k <= 0) {
    throw new Error(`biweekly rate must be a positive number, got ${ratePerDayPer1k}`);
  }
  runtimeOverride[tier] = ratePerDayPer1k;
};

/**
 * Clear runtime overrides. After this, the resolution order is
 * env-var → default. Intended for test cleanup.
 */
export const clearBiweeklyRateOverride = (): void => {
  runtimeOverride = {};
};

/**
 * Get the per-day USD-per-$1k-notional rate for a given SL tier.
 *
 * Resolution order (highest to lowest priority):
 *   1. Runtime override (set via setBiweeklyRateOverride)
 *   2. Env var (PILOT_BIWEEKLY_RATE_<N>PCT)
 *   3. Default literal in BIWEEKLY_DEFAULT_RATES
 *
 * The optional `regime` parameter is currently ignored (rate is
 * regime-flat by design). Accepting it now means re-enabling
 * regime-variation later is a one-line change to this function
 * rather than a signature change across the codebase.
 *
 * NOTE: The unused regime parameter is intentional API surface for
 * future use — see header comment.
 */
export const getBiweeklyRatePerDayPer1k = (
  tier: V7SlTier,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _regime?: string
): number => {
  // Runtime override
  if (runtimeOverride[tier] !== undefined) {
    return runtimeOverride[tier] as number;
  }
  // Env var
  const envRate = parseEnvRate(ENV_KEY_BY_TIER[tier]);
  if (envRate !== null) return envRate;
  // Default
  return BIWEEKLY_DEFAULT_RATES[tier];
};

// ─────────────────────────────────────────────────────────────────────
// Subscription billing math
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the accumulated subscription charge for a protection given
 * the days held, position notional, and SL tier.
 *
 *   charge = days_held × rate_per_day_per_1k × (notional / 1000)
 *
 * Days are rounded UP to the nearest whole day (a fractional day
 * counts as a full day for billing purposes — the platform pays
 * Deribit by the day, the trader bills by the day).
 *
 * The minimum is 1 day (BIWEEKLY_MIN_DAYS_BILLED) to prevent abuse
 * (trader opens then immediately closes to dodge charges; we still
 * paid Deribit for the option).
 *
 * The maximum is BIWEEKLY_MAX_TENOR_DAYS (14) — protection
 * automatically ends at max tenor.
 *
 * @returns charge in USD
 */
export const computeAccumulatedCharge = (params: {
  daysHeld: number;
  notionalUsd: number;
  slPct: V7SlTier;
}): number => {
  const { daysHeld, notionalUsd, slPct } = params;
  if (!Number.isFinite(daysHeld) || daysHeld < 0) return 0;
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) return 0;
  // Round up to whole days, clamp to [min, max]
  const billedDays = Math.min(
    BIWEEKLY_MAX_TENOR_DAYS,
    Math.max(BIWEEKLY_MIN_DAYS_BILLED, Math.ceil(daysHeld))
  );
  const ratePerDayPer1k = getBiweeklyRatePerDayPer1k(slPct);
  const charge = billedDays * ratePerDayPer1k * (notionalUsd / 1000);
  // Round to cents to avoid sub-penny floating drift in DB writes
  return Math.round(charge * 100) / 100;
};

/**
 * Compute the projected MAXIMUM charge if the trader holds to the
 * full BIWEEKLY_MAX_TENOR_DAYS. Used in widget UX to show "max if
 * held to expiry: $X" so the trader sees their upper exposure
 * upfront.
 */
export const computeMaxProjectedCharge = (params: {
  notionalUsd: number;
  slPct: V7SlTier;
}): number => {
  return computeAccumulatedCharge({
    daysHeld: BIWEEKLY_MAX_TENOR_DAYS,
    notionalUsd: params.notionalUsd,
    slPct: params.slPct
  });
};

/**
 * Day-boundary grace window (seconds). A close that fires within
 * BIWEEKLY_DAY_BOUNDARY_GRACE_SEC of an integer-day boundary doesn't
 * tip into the next billed day. Protects traders from being charged
 * an extra day due to network latency, clock drift, or a few seconds
 * of post-day-N click delay.
 *
 * Default 5 minutes. Generous enough to absorb realistic latency
 * (most close requests round-trip in < 1 second), tight enough that
 * actually intentional "I held it for an extra hour" closes still
 * bill correctly.
 *
 * Tunable via env PILOT_BIWEEKLY_DAY_GRACE_SEC for ops if 5 min
 * proves wrong in either direction.
 */
const BIWEEKLY_DAY_BOUNDARY_GRACE_SEC_DEFAULT = 300;

const resolveGraceSec = (): number => {
  const raw = process.env.PILOT_BIWEEKLY_DAY_GRACE_SEC;
  if (raw == null || raw === "") return BIWEEKLY_DAY_BOUNDARY_GRACE_SEC_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 86400) return BIWEEKLY_DAY_BOUNDARY_GRACE_SEC_DEFAULT;
  return n;
};

/**
 * Compute days held given activation timestamp and a "now" timestamp.
 * Returns a fractional day count (e.g. 2.5 = 2 days 12 hours). The
 * caller (typically computeAccumulatedCharge) handles rounding.
 *
 * Defensive: if now < activatedAt (clock skew, bad data), returns 0.
 *
 * Day-boundary grace: closes within ~5 minutes of an integer-day
 * boundary are credited to the lower day count. Prevents traders
 * being charged for an extra day due to network latency or
 * sub-second timing. Tunable via PILOT_BIWEEKLY_DAY_GRACE_SEC env.
 *
 * Examples (with default 300s = 5min grace):
 *   3 days + 0 seconds   → 3 billed days
 *   3 days + 1 second    → 3 billed days (grace)
 *   3 days + 4 minutes   → 3 billed days (grace)
 *   3 days + 6 minutes   → 4 billed days (outside grace)
 *   3 days + 1 hour      → 4 billed days
 */
export const computeDaysHeld = (params: {
  activatedAtMs: number;
  nowMs?: number;
}): number => {
  const now = params.nowMs ?? Date.now();
  const elapsedMs = now - params.activatedAtMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  // Subtract grace window so sub-grace closes round down to the
  // prior integer-day boundary.
  const graceMs = resolveGraceSec() * 1000;
  const adjustedMs = Math.max(0, elapsedMs - graceMs);
  return adjustedMs / (24 * 60 * 60 * 1000);
};

// ─────────────────────────────────────────────────────────────────────
// Feature flag
// ─────────────────────────────────────────────────────────────────────

/**
 * Master feature flag for the biweekly product. When false (the
 * default), the activate endpoint falls through to the legacy 1-day
 * product. When true, new activations go through the biweekly path.
 *
 * Set via env var PILOT_BIWEEKLY_ENABLED=true. Recommended cutover
 * sequence:
 *   1. Deploy all 6 PRs with the flag unset.
 *   2. Verify migration ran successfully (PR 2 schema columns present).
 *   3. Confirm Deribit funded.
 *   4. Set PILOT_BIWEEKLY_ENABLED=true in Render env, save.
 *   5. Render restarts → biweekly live for new activations.
 *
 * If anything goes wrong, set the flag back to false (or unset) and
 * Render restarts → activate falls through to legacy 1-day.
 */
export const isBiweeklyEnabled = (): boolean => {
  const raw = String(process.env.PILOT_BIWEEKLY_ENABLED ?? "")
    .trim()
    .toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
};

// ─────────────────────────────────────────────────────────────────────
// Quote payload helper
// ─────────────────────────────────────────────────────────────────────

export type BiweeklyQuotePreview = {
  /** USD per $1k notional per day (the trader-facing rate) */
  ratePerDayPer1kUsd: number;
  /** Charge per day on this specific position (= rate × notional/1000) */
  ratePerDayUsd: number;
  /** Max projected charge if held to BIWEEKLY_MAX_TENOR_DAYS (= rate × max × notional/1000) */
  maxProjectedChargeUsd: number;
  /** Max protection duration in days */
  maxTenorDays: number;
  /** Payout owed to trader on trigger (= notional × slPct/100) */
  payoutOnTriggerUsd: number;
};

/**
 * Build a complete quote preview for the widget. Single function so
 * the UX has one source of truth for the displayed numbers.
 */
export const buildBiweeklyQuotePreview = (params: {
  notionalUsd: number;
  slPct: V7SlTier;
}): BiweeklyQuotePreview => {
  const { notionalUsd, slPct } = params;
  const ratePerDayPer1kUsd = getBiweeklyRatePerDayPer1k(slPct);
  const ratePerDayUsd = ratePerDayPer1kUsd * (notionalUsd / 1000);
  const maxProjectedChargeUsd = computeMaxProjectedCharge({ notionalUsd, slPct });
  const payoutOnTriggerUsd = notionalUsd * (slPct / 100);
  return {
    ratePerDayPer1kUsd,
    ratePerDayUsd: Math.round(ratePerDayUsd * 100) / 100,
    maxProjectedChargeUsd,
    maxTenorDays: BIWEEKLY_MAX_TENOR_DAYS,
    payoutOnTriggerUsd: Math.round(payoutOnTriggerUsd * 100) / 100
  };
};
