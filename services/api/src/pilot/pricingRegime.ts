/**
 * Design A — Daily-anchored dynamic pricing module (PR A).
 *
 * Maps current DVOL to one of four pricing regimes (low / moderate /
 * elevated / high), each with its own per-tier premium schedule. The
 * 1-hour rolling DVOL average + 5-minute refresh cadence smooths noise
 * while remaining responsive to genuine regime changes.
 *
 * Rationale (recorded in CFO discussion 2026-04-19):
 *   The previous static $6/$5/$3/$2 schedule is structurally
 *   loss-making in normal-and-stress regimes (~70% of historical days).
 *   Design A keeps "fixed price + instant payout" from the trader's
 *   perspective — the price they see at quote time is what they pay —
 *   while letting the schedule update with realized market volatility.
 *   Trader-acceptance ceiling is held at $9/$1k for the 2% tier (just
 *   under the $80-on-$10k threshold the CEO flagged).
 *
 * Hysteresis: once a band is entered, exit requires DVOL to cross
 * a 2-point threshold past the boundary in the opposite direction.
 * Prevents constant flipping when DVOL hovers at a band edge.
 *
 * Fallback: when DVOL is unavailable (Deribit outage), default to
 * "moderate" — the modal regime and a reasonable middle.
 *
 * Note: this module is intentionally orthogonal to V7Regime
 * (calm / normal / stress) used by the hedge manager. The hedge
 * manager's TP thresholds and the pricing schedule answer different
 * questions and update on different cadences; coupling them would
 * conflate two unrelated decisions.
 */

import type { V7SlTier } from "./types";

export type PricingRegime = "low" | "moderate" | "elevated" | "high";

export type PricingRegimeStatus = {
  regime: PricingRegime;
  dvol: number | null;
  source: "dvol" | "rvol" | "fallback";
  rollingWindowMinutes: number;
  timestamp: string;
};

export type PricingRegimeBands = {
  /** DVOL < lowMaxBelow → low */
  lowMaxBelow: number;
  /** DVOL < moderateMaxBelow → moderate */
  moderateMaxBelow: number;
  /** DVOL < elevatedMaxBelow → elevated; otherwise → high */
  elevatedMaxBelow: number;
  /** Hysteresis padding (DVOL points) when crossing a boundary downward */
  hysteresisPoints: number;
};

const DEFAULT_BANDS: PricingRegimeBands = {
  lowMaxBelow: 50,
  moderateMaxBelow: 65,
  elevatedMaxBelow: 80,
  hysteresisPoints: 2
};

export type RegimeSchedule = Record<V7SlTier, number>;

/**
 * Design A schedule, USD per $1k notional, 1-day tenor.
 *
 *   low (DVOL ≤ 50):     $6 / $5 / $3 / $2  (calm pricing)
 *   moderate (DVOL 50-65): $7 / $5.50 / $3 / $2
 *   elevated (DVOL 65-80): $8 / $6 / $3.50 / $2
 *   high (DVOL > 80):     $10 / $7 / $4 / $2 (2% ceiling raised from $9 → $10)
 *
 * 2026-04-20 — Raised the 2% high-regime ceiling from $9 → $10.
 * Rationale: $9 was overly conservative on the platform-exposure side.
 * BS hedge cost on a 2% put at DVOL 80 = $8.54, so $10 puts the platform
 * within $1 of breakeven at stress entry (vs −$2.54 at $9). Trader-side
 * return on trigger drops from 2.2× to 2.0× — at the 2× line but not
 * below it. Reversible to $9 in one config change. The 1% / 3% / 5% / 10%
 * tiers remain unchanged. See CFO report §5 for full reasoning.
 *
 * 1% SL is defined for forward compatibility but unlaunched
 * (excluded from V7_LAUNCHED_TIERS in v7Pricing.ts).
 */
export const REGIME_SCHEDULES: Record<PricingRegime, RegimeSchedule> = {
  low:      { 1: 6, 2: 6,  3: 5,    5: 3,    10: 2 },
  moderate: { 1: 7, 2: 7,  3: 5.5,  5: 3,    10: 2 },
  elevated: { 1: 8, 2: 8,  3: 6,    5: 3.5,  10: 2 },
  high:     { 1: 9, 2: 10, 3: 7,    5: 4,    10: 2 }
};

export const DEFAULT_PRICING_REGIME: PricingRegime = "moderate";

let configuredBands: PricingRegimeBands = { ...DEFAULT_BANDS };
let lastRegime: PricingRegime | null = null;

const dvolHistory: Array<{ ms: number; dvol: number }> = [];
const ROLLING_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const QUOTE_REFRESH_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedStatus: { status: PricingRegimeStatus; expiresAtMs: number } | null = null;

export const configurePricingRegime = (params: {
  bands?: Partial<PricingRegimeBands>;
}): void => {
  if (params.bands) {
    configuredBands = {
      lowMaxBelow: params.bands.lowMaxBelow ?? DEFAULT_BANDS.lowMaxBelow,
      moderateMaxBelow: params.bands.moderateMaxBelow ?? DEFAULT_BANDS.moderateMaxBelow,
      elevatedMaxBelow: params.bands.elevatedMaxBelow ?? DEFAULT_BANDS.elevatedMaxBelow,
      hysteresisPoints: params.bands.hysteresisPoints ?? DEFAULT_BANDS.hysteresisPoints
    };
  }
};

/**
 * Pure classifier: DVOL → PricingRegime, with hysteresis applied to
 * downward transitions only (upward transitions are immediate so we
 * never under-charge during a fast vol spike).
 */
export const classifyPricingRegime = (
  dvol: number,
  previousRegime: PricingRegime | null = null,
  bands: PricingRegimeBands = configuredBands
): PricingRegime => {
  const naive: PricingRegime =
    dvol < bands.lowMaxBelow
      ? "low"
      : dvol < bands.moderateMaxBelow
        ? "moderate"
        : dvol < bands.elevatedMaxBelow
          ? "elevated"
          : "high";

  if (previousRegime === null) return naive;

  // Allow upward transitions (riskier regime) immediately — never
  // under-charge during a vol spike.
  const ORDER: PricingRegime[] = ["low", "moderate", "elevated", "high"];
  const prevIdx = ORDER.indexOf(previousRegime);
  const naiveIdx = ORDER.indexOf(naive);
  if (naiveIdx > prevIdx) return naive;
  if (naiveIdx === prevIdx) return previousRegime;

  // Downward transition — require crossing the boundary by hysteresisPoints
  // before stepping down.
  // Boundary that previousRegime sits above:
  //   previousRegime=high -> elevatedMaxBelow
  //   previousRegime=elevated -> moderateMaxBelow
  //   previousRegime=moderate -> lowMaxBelow
  const downBoundary =
    previousRegime === "high"
      ? bands.elevatedMaxBelow
      : previousRegime === "elevated"
        ? bands.moderateMaxBelow
        : previousRegime === "moderate"
          ? bands.lowMaxBelow
          : 0;
  if (dvol >= downBoundary - bands.hysteresisPoints) {
    return previousRegime; // hysteresis holds us in the higher regime
  }
  return naive;
};

export const getRegimeSchedule = (regime: PricingRegime): RegimeSchedule => {
  return REGIME_SCHEDULES[regime];
};

export const getPremiumPer1kForRegime = (
  slPct: V7SlTier,
  regime: PricingRegime
): number => {
  return REGIME_SCHEDULES[regime][slPct];
};

/**
 * Recording function called whenever we get a fresh DVOL reading
 * (e.g., from the regime classifier or hedge manager cycle). Maintains
 * the rolling 1-hour buffer used to smooth band classification.
 */
export const recordDvolSample = (dvol: number, atMs: number = Date.now()): void => {
  dvolHistory.push({ ms: atMs, dvol });
  // Drop samples outside the rolling window.
  const cutoff = atMs - ROLLING_WINDOW_MS;
  while (dvolHistory.length && dvolHistory[0].ms < cutoff) {
    dvolHistory.shift();
  }
  // Invalidate cache so next quote rebuilds.
  cachedStatus = null;
};

/**
 * Compute the 1-hour rolling average DVOL from samples. Returns null
 * if no samples in the window.
 */
const rollingAverageDvol = (atMs: number = Date.now()): number | null => {
  const cutoff = atMs - ROLLING_WINDOW_MS;
  const window = dvolHistory.filter((s) => s.ms >= cutoff);
  if (window.length === 0) return null;
  const sum = window.reduce((acc, s) => acc + s.dvol, 0);
  return sum / window.length;
};

/**
 * Get the current pricing regime status. Cached for QUOTE_REFRESH_TTL_MS
 * to avoid recomputing on every quote during high traffic.
 *
 * If liveDvolFallback is provided, it's used as the current spot DVOL
 * when no rolling history exists yet (e.g., on first quote after restart).
 * This lets the regime classifier feed the pricing module synchronously
 * without each call waiting on Deribit.
 */
export const getCurrentPricingRegime = (
  liveDvolFallback?: number | null,
  atMs: number = Date.now()
): PricingRegimeStatus => {
  if (cachedStatus && cachedStatus.expiresAtMs > atMs) {
    return cachedStatus.status;
  }

  let dvol = rollingAverageDvol(atMs);
  let source: "dvol" | "rvol" | "fallback" = "dvol";

  if (dvol === null && liveDvolFallback !== null && liveDvolFallback !== undefined && Number.isFinite(liveDvolFallback)) {
    dvol = liveDvolFallback;
    // Source remains "dvol" — the live value is still a real DVOL reading,
    // just not yet smoothed by the rolling window.
  }

  let regime: PricingRegime;
  if (dvol === null) {
    regime = DEFAULT_PRICING_REGIME;
    source = "fallback";
    console.warn(
      `[PricingRegime] no DVOL available — defaulting to '${DEFAULT_PRICING_REGIME}' regime`
    );
  } else {
    regime = classifyPricingRegime(dvol, lastRegime);
    if (lastRegime !== null && lastRegime !== regime) {
      console.log(
        `[PricingRegime] *** REGIME CHANGED: ${lastRegime} → ${regime} *** (rolling DVOL ${dvol.toFixed(2)}, schedule now ${JSON.stringify(REGIME_SCHEDULES[regime])})`
      );
    }
    lastRegime = regime;
  }

  const status: PricingRegimeStatus = {
    regime,
    dvol,
    source,
    rollingWindowMinutes: 60,
    timestamp: new Date(atMs).toISOString()
  };

  cachedStatus = { status, expiresAtMs: atMs + QUOTE_REFRESH_TTL_MS };
  return status;
};

/**
 * Test/reset helpers.
 */
export const __resetPricingRegimeForTests = (): void => {
  configuredBands = { ...DEFAULT_BANDS };
  dvolHistory.length = 0;
  cachedStatus = null;
  lastRegime = null;
};

export const __getDvolHistoryLength = (): number => dvolHistory.length;

export const __setLastRegimeForTests = (regime: PricingRegime | null): void => {
  lastRegime = regime;
};
