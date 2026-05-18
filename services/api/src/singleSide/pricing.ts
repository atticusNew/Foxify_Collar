/**
 * Single-Side pricing — three layers stack at quote time:
 *
 *   1. Cell base price ($X/day calm regime, locked in matrix.ts)
 *   2. IV-aware scaling: base × (current_iv / reference_iv)^elasticity
 *      Reference IV = 33% (current short-dated Bullish IV at the
 *      pricing-data anchor point, 2026-05-16). When current IV jumps,
 *      hedge cost rises proportionally; this scaler keeps margin
 *      stable. Elasticity 0.7 calibrated so a 2× IV move ≈ 1.6×
 *      premium (slightly sub-linear because trigger probability
 *      doesn't quite double when IV doubles).
 *   3. Regime overlay: × {1.0, 1.4, 2.0, pause} for {calm, moderate,
 *      elevated, stress}.
 *   4. Anti-bot Layer 4 surcharge applies AFTER on top of all above.
 *
 * Pricing precedence:
 *   - Cell base (matrix) → IV-scaled → regime-overlay-multiplied → final daily rate
 *   - DB override (admin cell toggle) replaces cell base; IV + regime
 *     scaling still applied on top.
 *   - VC_REGIME_OVERLAY_JSON adapted to SS_REGIME_OVERLAY_JSON for SS.
 *
 * Operator levers (env):
 *   SS_IV_REFERENCE: reference IV used in scaling (default 0.33)
 *   SS_IV_ELASTICITY: scaling exponent (default 0.7)
 *   SS_IV_SCALING_ENABLED: false to disable IV scaling (default true)
 *   SS_REGIME_OVERLAY_JSON: per-cell-per-regime overlay JSON
 *   SS_PRICING_FLOOR_USD: minimum daily premium (default 50)
 *   SS_PRICING_CEILING_USD: maximum daily premium (default 25000)
 */

import type { SingleSideCellDefinition } from "./matrix";
import type { VolRegime } from "../volumeCover/strikeGrid";

export type SingleSidePremiumQuote = {
  cellId: string;
  /** Final daily premium charged (post all scaling). */
  dailyPremiumUsdc: number;
  /** Base premium before IV/regime scaling. */
  basePremiumUsdc: number;
  /** Multiplier applied for IV scaling (1.0 means at reference IV). */
  ivMultiplier: number;
  /** Multiplier applied for regime overlay (1.0 = calm). */
  regimeMultiplier: number;
  /** Reference IV used in scaling. */
  referenceIv: number;
  /** Current IV used in scaling (may be null if not provided). */
  currentIv: number | null;
  /** Regime detected. */
  regime: VolRegime | null;
  /** Source of the base price (matrix vs DB override). */
  baseSource: "matrix" | "db_override";
  /** Stress regime auto-pauses; if true, do NOT activate. */
  stressPause: boolean;
};

const DEFAULT_REGIME_OVERLAY: Record<VolRegime, number> = {
  calm: 1.0,
  moderate: 1.4,
  elevated: 2.0,
  stress: 0 // sentinel — pause
};

const SS_PRICING_FLOOR_USD_DEFAULT = 50;
const SS_PRICING_CEILING_USD_DEFAULT = 25_000;
const SS_IV_REFERENCE_DEFAULT = 0.33;
const SS_IV_ELASTICITY_DEFAULT = 0.7;

let cachedOverlayMap: { json: string; map: Partial<Record<string, Partial<Record<VolRegime, number>>>> } | null = null;

const readOverlayMap = (): Partial<Record<string, Partial<Record<VolRegime, number>>>> => {
  const raw = process.env.SS_REGIME_OVERLAY_JSON;
  if (!raw || raw.trim() === "") return {};
  if (cachedOverlayMap && cachedOverlayMap.json === raw) return cachedOverlayMap.map;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    cachedOverlayMap = { json: raw, map: parsed };
    return cachedOverlayMap.map;
  } catch {
    return {};
  }
};

const numEnv = (key: string, fallback: number): number => {
  const v = process.env[key];
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Compute the IV-scaling multiplier.
 *   multiplier = (current_iv / reference_iv)^elasticity
 *
 * If currentIv unknown, returns 1.0 (no scaling — use base).
 * If IV scaling disabled, returns 1.0.
 */
export const computeIvMultiplier = (params: {
  currentIv: number | null | undefined;
  referenceIv?: number;
  elasticity?: number;
}): number => {
  if (process.env.SS_IV_SCALING_ENABLED === "false") return 1.0;
  if (params.currentIv === null || params.currentIv === undefined) return 1.0;
  if (!Number.isFinite(params.currentIv) || params.currentIv <= 0) return 1.0;
  const ref = params.referenceIv ?? numEnv("SS_IV_REFERENCE", SS_IV_REFERENCE_DEFAULT);
  const exp = params.elasticity ?? numEnv("SS_IV_ELASTICITY", SS_IV_ELASTICITY_DEFAULT);
  if (ref <= 0) return 1.0;
  const ratio = params.currentIv / ref;
  if (!Number.isFinite(ratio) || ratio <= 0) return 1.0;
  return Math.pow(ratio, exp);
};

/**
 * Resolve regime overlay multiplier for a (cell, regime) pair.
 * Reads SS_REGIME_OVERLAY_JSON if present; falls back to default.
 *
 * Calm regime ALWAYS uses 1.0 (calm price is locked at matrix base).
 * Stress regime returns 0 as sentinel for "pause"; caller checks
 * stressPause flag to short-circuit activation.
 */
export const resolveRegimeMultiplier = (params: {
  cellId: string;
  regime: VolRegime | null;
}): number => {
  if (!params.regime || params.regime === "calm") return 1.0;
  const overlay = readOverlayMap();
  const cellOverlay = overlay[params.cellId];
  if (cellOverlay) {
    const m = cellOverlay[params.regime];
    if (typeof m === "number" && Number.isFinite(m) && m >= 0) {
      return m;
    }
  }
  return DEFAULT_REGIME_OVERLAY[params.regime] ?? 1.0;
};

/**
 * Resolve the premium to charge for a single-side cover.
 *
 * Stacks: cell base (or DB override) → IV multiplier → regime multiplier
 * → bounded to [floor, ceiling].
 *
 * For stress regime: returns dailyPremiumUsdc=0 with stressPause=true.
 * Caller MUST check stressPause and reject activation accordingly.
 */
export const resolveSingleSidePremium = (params: {
  cell: SingleSideCellDefinition;
  dbOverrideDailyPremiumUsdc?: number | null;
  currentIv?: number | null;
  regime?: VolRegime | null;
}): SingleSidePremiumQuote => {
  const base =
    typeof params.dbOverrideDailyPremiumUsdc === "number" &&
    Number.isFinite(params.dbOverrideDailyPremiumUsdc) &&
    params.dbOverrideDailyPremiumUsdc > 0
      ? params.dbOverrideDailyPremiumUsdc
      : params.cell.dailyPremiumUsdc;
  const baseSource: "matrix" | "db_override" =
    params.dbOverrideDailyPremiumUsdc &&
    params.dbOverrideDailyPremiumUsdc !== params.cell.dailyPremiumUsdc
      ? "db_override"
      : "matrix";

  const referenceIv = numEnv("SS_IV_REFERENCE", SS_IV_REFERENCE_DEFAULT);
  const ivMultiplier = computeIvMultiplier({
    currentIv: params.currentIv ?? null,
    referenceIv
  });
  const regimeMultiplier = resolveRegimeMultiplier({
    cellId: params.cell.cellId,
    regime: params.regime ?? null
  });

  // Stress regime: pause
  const isStress = params.regime === "stress" && regimeMultiplier === 0;
  if (isStress) {
    return {
      cellId: params.cell.cellId,
      dailyPremiumUsdc: 0,
      basePremiumUsdc: base,
      ivMultiplier,
      regimeMultiplier: 0,
      referenceIv,
      currentIv: params.currentIv ?? null,
      regime: params.regime ?? null,
      baseSource,
      stressPause: true
    };
  }

  const scaled = base * ivMultiplier * regimeMultiplier;
  const floor = numEnv("SS_PRICING_FLOOR_USD", SS_PRICING_FLOOR_USD_DEFAULT);
  const ceiling = numEnv("SS_PRICING_CEILING_USD", SS_PRICING_CEILING_USD_DEFAULT);
  const bounded = Math.min(ceiling, Math.max(floor, Math.round(scaled)));

  return {
    cellId: params.cell.cellId,
    dailyPremiumUsdc: bounded,
    basePremiumUsdc: base,
    ivMultiplier,
    regimeMultiplier,
    referenceIv,
    currentIv: params.currentIv ?? null,
    regime: params.regime ?? null,
    baseSource,
    stressPause: false
  };
};

export const __resetSingleSidePricingCacheForTests = (): void => {
  cachedOverlayMap = null;
};
