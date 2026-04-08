import { randomUUID } from "node:crypto";

export type PilotVenueMode =
  | "falconx"
  | "deribit_test"
  | "mock_falconx"
  | "ibkr_cme_live"
  | "ibkr_cme_paper"
  | "bullish_testnet";
export type PilotWindowStatus = "open" | "not_started" | "closed" | "config_invalid";
export type DeribitQuotePolicy = "ask_only" | "ask_or_mark_fallback";
export type DeribitStrikeSelectionMode = "legacy" | "trigger_aligned";
export type PilotHedgePolicy = "options_primary_futures_fallback" | "options_only_native";
export type IbkrOrderTif = "IOC" | "DAY";
export type IbkrProductFamily = "MBT" | "BFF";
export type PremiumPolicyMode = "legacy" | "pass_through_markup";
export type PilotPricingMode = "actuarial_strict" | "hybrid_otm_treasury";
export type PilotSelectorMode = "strict_profitability" | "hybrid_treasury";
export type HybridStrictMultiplierScheduleName = "current" | "cheaper" | "strict_band_low" | "strict_band_mid" | "strict_band_high";
export type BullishAuthMode = "hmac" | "ecdsa";
export type BullishOrderTif = "IOC" | "DAY" | "GTC";
export type PilotRuntimeProfileName = "default" | "bullish_locked_v1";
export type PilotProfile = "default" | "bullish_locked_v1";
export type BullishRuntimeConfig = {
  enabled: boolean;
  restBaseUrl: string;
  publicWsUrl: string;
  privateWsUrl: string;
  authMode: BullishAuthMode;
  hmacPublicKey: string;
  hmacSecret: string;
  ecdsaPublicKey: string;
  ecdsaPrivateKey: string;
  ecdsaMetadata: string;
  tradingAccountId: string;
  defaultSymbol: string;
  symbolByMarketId: Record<string, string>;
  hmacLoginPath: string;
  ecdsaLoginPath: string;
  tradingAccountsPath: string;
  noncePath: string;
  commandPath: string;
  orderbookPathTemplate: string;
  enableExecution: boolean;
  orderTimeoutMs: number;
  orderTif: BullishOrderTif;
  allowMargin: boolean;
};

export type PilotLockedPricingProfile = {
  enabled: boolean;
  name: PilotRuntimeProfileName;
  venueMode: "bullish_testnet";
  forceOnlyBullishVenue: boolean;
  fixedTenorDays: number;
  enforceTierDrawdownOnly: boolean;
  fixedPricingMode: PilotPricingMode;
  premiumPolicyMode: PremiumPolicyMode;
  selectorMode: PilotSelectorMode;
  hybridStrictMultiplierSchedule: HybridStrictMultiplierScheduleName;
  strictTenor: boolean;
  fixedDrawdownFloorPctByTier: Record<string, number>;
};
export type HedgeOptimizerRuntimeConfig = {
  enabled: boolean;
  version: string;
  normalization: {
    expectedSubsidyUsd: { min: number; max: number };
    cvar95Usd: { min: number; max: number };
    liquidityPenalty: { min: number; max: number };
    fillRiskPenalty: { min: number; max: number };
    basisPenalty: { min: number; max: number };
    carryPenalty: { min: number; max: number };
    pnlRewardUsd: { min: number; max: number };
    mtpdReward: { min: number; max: number };
    tenorDriftDays: { min: number; max: number };
    strikeDistancePct: { min: number; max: number };
  };
  weights: {
    expectedSubsidy: number;
    cvar95: number;
    liquidityPenalty: number;
    fillRiskPenalty: number;
    basisPenalty: number;
    carryPenalty: number;
    pnlReward: number;
    mtpdReward: number;
    tenorDriftPenalty: number;
    strikeDistancePenalty: number;
  };
  hardConstraints: {
    maxPremiumRatio: number;
    maxSpreadPct: number;
    minAskSize: number;
    maxTenorDriftDays: number;
    minTailProtectionScore: number;
    maxExpectedSubsidyUsd: number;
  };
  regimePolicy: {
    calm: {
      preferCloserStrikeBias: number;
      maxStrikeDistancePct: number;
      minTenorDays: number;
      maxTenorDays: number;
    };
    neutral: {
      preferCloserStrikeBias: number;
      maxStrikeDistancePct: number;
      minTenorDays: number;
      maxTenorDays: number;
    };
    stress: {
      preferCloserStrikeBias: number;
      maxStrikeDistancePct: number;
      minTenorDays: number;
      maxTenorDays: number;
    };
  };
};

export type RolloutGuardRuntimeConfig = {
  fallbackTriggerHitRatePct: number;
  fallbackSubsidyUtilizationPct: number;
  fallbackTreasuryDrawdownPct: number;
  pauseTriggerHitRatePct: number;
  pauseSubsidyUtilizationPct: number;
  pauseTreasuryDrawdownPct: number;
  pauseOnBlockedSubsidy: boolean;
};

export type TierBatchingTenorRuntimeConfig = {
  enabled: boolean;
  batchWindowSeconds: number;
  maxBatchQuotes: number;
  tierGroupingEnabled: boolean;
  tenorLadderEnabled: boolean;
  tenorLadderDays: number[];
};

export type PremiumRegimeRuntimeConfig = {
  enabled: boolean;
  applyToActuarialStrict: boolean;
  lookbackMinutes: number;
  minSamples: number;
  minDwellMinutes: number;
  maxOverlayPctOfBasePremium: number;
  watchAddUsdPer1k: number;
  watchMultiplier: number;
  stressAddUsdPer1k: number;
  stressMultiplier: number;
  enterWatchTriggerHitRatePct: number;
  enterWatchSubsidyUtilizationPct: number;
  enterWatchTreasuryDrawdownPct: number;
  enterStressTriggerHitRatePct: number;
  enterStressSubsidyUtilizationPct: number;
  enterStressTreasuryDrawdownPct: number;
  exitWatchTriggerHitRatePct: number;
  exitWatchSubsidyUtilizationPct: number;
  exitWatchTreasuryDrawdownPct: number;
  exitStressTriggerHitRatePct: number;
  exitStressSubsidyUtilizationPct: number;
  exitStressTreasuryDrawdownPct: number;
};

export type PilotWindowState = {
  enforced: boolean;
  startAt: string | null;
  endAt: string | null;
  durationDays: number;
  status: PilotWindowStatus;
  reason?: string;
};

type ParsedAllowlist = {
  raw: string;
  entries: string[];
};

const parseAllowlist = (raw: string | undefined): ParsedAllowlist => {
  const normalized = (raw || "").trim();
  if (!normalized) return { raw: "", entries: [] };
  return {
    raw: normalized,
    entries: normalized
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  };
};

export const parsePilotVenueMode = (raw: string | undefined): PilotVenueMode => {
  const normalized = (raw || "bullish_testnet").trim();
  if (
    normalized === "falconx" ||
    normalized === "deribit_test" ||
    normalized === "mock_falconx" ||
    normalized === "ibkr_cme_live" ||
    normalized === "ibkr_cme_paper" ||
    normalized === "bullish_testnet"
  ) {
    return normalized;
  }
  throw new Error(`invalid_pilot_venue_mode:${normalized || "empty"}`);
};

export const parsePilotHedgePolicy = (raw: string | undefined): PilotHedgePolicy => {
  const normalized = String(raw || "options_primary_futures_fallback").trim();
  if (normalized === "options_primary_futures_fallback" || normalized === "options_only_native") {
    return normalized;
  }
  throw new Error(`invalid_pilot_hedge_policy:${normalized || "empty"}`);
};

export const parseDeribitQuotePolicy = (raw: string | undefined): DeribitQuotePolicy => {
  const normalized = String(raw || "ask_or_mark_fallback").trim();
  if (normalized === "ask_only" || normalized === "ask_or_mark_fallback") {
    return normalized;
  }
  throw new Error(`invalid_deribit_quote_policy:${normalized || "empty"}`);
};

export const parseDeribitStrikeSelectionMode = (
  raw: string | undefined
): DeribitStrikeSelectionMode => {
  const normalized = String(raw || "trigger_aligned").trim();
  if (normalized === "legacy" || normalized === "trigger_aligned") {
    return normalized;
  }
  throw new Error(`invalid_deribit_strike_selection_mode:${normalized || "empty"}`);
};

export const parseDeribitMaxTenorDriftDays = (raw: string | undefined): number => {
  const parsed = Number(raw || "1.5");
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 14) {
    return parsed;
  }
  throw new Error(`invalid_deribit_max_tenor_drift_days:${String(raw || "").trim() || "empty"}`);
};

export const parsePositiveIntInRange = (
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  errorCode: string
): number => {
  const parsed = Number(raw ?? String(fallback));
  if (Number.isFinite(parsed) && parsed >= min && parsed <= max) {
    return Math.floor(parsed);
  }
  throw new Error(`${errorCode}:${String(raw || "").trim() || "empty"}`);
};

export const parsePositiveFinite = (raw: string | undefined, fallback: number, errorCode: string): number => {
  const parsed = Number(raw ?? String(fallback));
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  throw new Error(`${errorCode}:${String(raw || "").trim() || "empty"}`);
};

export const parseHybridStrictMultiplier = (raw: string | undefined, fallback: number, errorCode: string): number =>
  parseFractionRange(raw, fallback, 0.25, 1, errorCode);

const resolveCurrentHybridStrictMultiplierByTier = (): Record<string, number> => ({
  "Pro (Bronze)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_BRONZE,
    0.65,
    "invalid_pilot_hybrid_strict_multiplier_bronze"
  ),
  "Pro (Silver)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_SILVER,
    0.7,
    "invalid_pilot_hybrid_strict_multiplier_silver"
  ),
  "Pro (Gold)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_GOLD,
    0.75,
    "invalid_pilot_hybrid_strict_multiplier_gold"
  ),
  "Pro (Platinum)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_PLATINUM,
    0.75,
    "invalid_pilot_hybrid_strict_multiplier_platinum"
  )
});

const resolveCheaperHybridStrictMultiplierByTier = (): Record<string, number> => ({
  "Pro (Bronze)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_CHEAPER_BRONZE,
    0.6,
    "invalid_pilot_hybrid_strict_multiplier_cheaper_bronze"
  ),
  "Pro (Silver)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_CHEAPER_SILVER,
    0.67,
    "invalid_pilot_hybrid_strict_multiplier_cheaper_silver"
  ),
  "Pro (Gold)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_CHEAPER_GOLD,
    0.72,
    "invalid_pilot_hybrid_strict_multiplier_cheaper_gold"
  ),
  "Pro (Platinum)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_CHEAPER_PLATINUM,
    0.72,
    "invalid_pilot_hybrid_strict_multiplier_cheaper_platinum"
  )
});

// Structured bands aligned to drawdown-floor tiers:
// Bronze(20%): 0.60-0.70, Silver(15%): 0.65-0.75, Gold/Plat(12%): 0.70-0.80
const resolveStrictBandLowHybridStrictMultiplierByTier = (): Record<string, number> => ({
  "Pro (Bronze)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_STRICT_BAND_LOW_BRONZE,
    0.6,
    "invalid_pilot_hybrid_strict_multiplier_strict_band_low_bronze"
  ),
  "Pro (Silver)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_STRICT_BAND_LOW_SILVER,
    0.65,
    "invalid_pilot_hybrid_strict_multiplier_strict_band_low_silver"
  ),
  "Pro (Gold)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_STRICT_BAND_LOW_GOLD,
    0.7,
    "invalid_pilot_hybrid_strict_multiplier_strict_band_low_gold"
  ),
  "Pro (Platinum)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_STRICT_BAND_LOW_PLATINUM,
    0.7,
    "invalid_pilot_hybrid_strict_multiplier_strict_band_low_platinum"
  )
});

const resolveStrictBandMidHybridStrictMultiplierByTier = (): Record<string, number> => ({
  "Pro (Bronze)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_STRICT_BAND_MID_BRONZE,
    0.65,
    "invalid_pilot_hybrid_strict_multiplier_strict_band_mid_bronze"
  ),
  "Pro (Silver)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_STRICT_BAND_MID_SILVER,
    0.7,
    "invalid_pilot_hybrid_strict_multiplier_strict_band_mid_silver"
  ),
  "Pro (Gold)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_STRICT_BAND_MID_GOLD,
    0.75,
    "invalid_pilot_hybrid_strict_multiplier_strict_band_mid_gold"
  ),
  "Pro (Platinum)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_STRICT_BAND_MID_PLATINUM,
    0.75,
    "invalid_pilot_hybrid_strict_multiplier_strict_band_mid_platinum"
  )
});

const resolveStrictBandHighHybridStrictMultiplierByTier = (): Record<string, number> => ({
  "Pro (Bronze)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_STRICT_BAND_HIGH_BRONZE,
    0.7,
    "invalid_pilot_hybrid_strict_multiplier_strict_band_high_bronze"
  ),
  "Pro (Silver)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_STRICT_BAND_HIGH_SILVER,
    0.75,
    "invalid_pilot_hybrid_strict_multiplier_strict_band_high_silver"
  ),
  "Pro (Gold)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_STRICT_BAND_HIGH_GOLD,
    0.8,
    "invalid_pilot_hybrid_strict_multiplier_strict_band_high_gold"
  ),
  "Pro (Platinum)": parseHybridStrictMultiplier(
    process.env.PILOT_HYBRID_STRICT_MULTIPLIER_STRICT_BAND_HIGH_PLATINUM,
    0.8,
    "invalid_pilot_hybrid_strict_multiplier_strict_band_high_platinum"
  )
});

export const resolveHybridStrictMultiplierSchedules = (): Record<HybridStrictMultiplierScheduleName, Record<string, number>> => ({
  current: resolveCurrentHybridStrictMultiplierByTier(),
  cheaper: resolveCheaperHybridStrictMultiplierByTier(),
  strict_band_low: resolveStrictBandLowHybridStrictMultiplierByTier(),
  strict_band_mid: resolveStrictBandMidHybridStrictMultiplierByTier(),
  strict_band_high: resolveStrictBandHighHybridStrictMultiplierByTier()
});

export const DEFAULT_LIVE_HYBRID_STRICT_MULTIPLIER_SCHEDULE: HybridStrictMultiplierScheduleName = "cheaper";

export const parseNonNegativeFinite = (raw: string | undefined, fallback: number, errorCode: string): number => {
  const parsed = Number(raw ?? String(fallback));
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  throw new Error(`${errorCode}:${String(raw || "").trim() || "empty"}`);
};

export const parsePilotQuoteMinNotionalUsdc = (raw: string | undefined): number => {
  const parsed = Number(raw ?? "1000");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid_pilot_quote_min_notional_usdc:${String(raw || "").trim() || "empty"}`);
  }
  // Pilot safety floor: configurable target (default 1000), but never below 500.
  return Math.max(500, parsed);
};

export const parseBooleanEnv = (raw: string | undefined, fallback: boolean): boolean => {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
};

export const parseIbkrOrderTif = (raw: string | undefined): IbkrOrderTif => {
  const normalized = String(raw || "IOC").trim().toUpperCase();
  if (normalized === "IOC" || normalized === "DAY") return normalized;
  throw new Error(`invalid_ibkr_order_tif:${normalized || "empty"}`);
};

export const parseIbkrProductFamily = (raw: string | undefined, fallback: IbkrProductFamily): IbkrProductFamily => {
  const normalized = String(raw || fallback)
    .trim()
    .toUpperCase();
  if (normalized === "MBT" || normalized === "BFF") {
    return normalized;
  }
  throw new Error(`invalid_ibkr_product_family:${normalized || "empty"}`);
};

export const parsePremiumPolicyMode = (raw: string | undefined): PremiumPolicyMode => {
  const normalized = String(raw || "legacy").trim().toLowerCase();
  if (normalized === "legacy" || normalized === "pass_through_markup") {
    return normalized;
  }
  throw new Error(`invalid_pilot_premium_policy_mode:${normalized || "empty"}`);
};

export const parsePilotPricingMode = (raw: string | undefined): PilotPricingMode => {
  const normalized = String(raw || "actuarial_strict").trim().toLowerCase();
  if (normalized === "actuarial_strict" || normalized === "hybrid_otm_treasury") {
    return normalized;
  }
  throw new Error(`invalid_pilot_pricing_mode:${normalized || "empty"}`);
};

export const parseBullishAuthMode = (raw: string | undefined): BullishAuthMode => {
  const normalized = String(raw || "ecdsa").trim().toLowerCase();
  if (normalized === "hmac" || normalized === "ecdsa") return normalized;
  throw new Error(`invalid_bullish_auth_mode:${normalized || "empty"}`);
};

export const parseBullishOrderTif = (raw: string | undefined): BullishOrderTif => {
  const normalized = String(raw || "IOC").trim().toUpperCase();
  if (normalized === "IOC" || normalized === "DAY" || normalized === "GTC") return normalized;
  throw new Error(`invalid_bullish_order_tif:${normalized || "empty"}`);
};

export const parsePilotSelectorMode = (raw: string | undefined): PilotSelectorMode => {
  const normalized = String(raw || "strict_profitability").trim().toLowerCase();
  if (normalized === "strict_profitability" || normalized === "hybrid_treasury") {
    return normalized;
  }
  throw new Error(`invalid_pilot_selector_mode:${normalized || "empty"}`);
};

export const parsePilotProfile = (raw: string | undefined): PilotProfile => {
  const normalized = String(raw || "default").trim().toLowerCase();
  if (normalized === "default" || normalized === "bullish_locked_v1") {
    return normalized;
  }
  throw new Error(`invalid_pilot_profile:${normalized || "empty"}`);
};

const parseFiniteWithFallback = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw ?? String(fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseNonNegativeFiniteWithFallback = (raw: string | undefined, fallback: number): number => {
  const parsed = parseFiniteWithFallback(raw, fallback);
  return Math.max(0, parsed);
};

const parsePositiveFiniteWithFallback = (raw: string | undefined, fallback: number): number => {
  const parsed = parseFiniteWithFallback(raw, fallback);
  return parsed > 0 ? parsed : fallback;
};

const parseProbabilityWithFallback = (raw: string | undefined, fallback: number): number =>
  parseFractionRange(raw, fallback, 0, 1, "invalid_probability_range");

const parseHedgeOptimizerRuntimeConfig = (): HedgeOptimizerRuntimeConfig => ({
  enabled: parseBooleanEnv(process.env.PILOT_HEDGE_OPTIMIZER_ENABLED, false),
  version: String(process.env.PILOT_HEDGE_OPTIMIZER_VERSION || "optimizer_v1").trim() || "optimizer_v1",
  normalization: {
    expectedSubsidyUsd: {
      min: Number(process.env.PILOT_HEDGE_NORM_EXPECTED_SUBSIDY_MIN || "0"),
      max: Number(process.env.PILOT_HEDGE_NORM_EXPECTED_SUBSIDY_MAX || "5000")
    },
    cvar95Usd: {
      min: Number(process.env.PILOT_HEDGE_NORM_CVAR95_MIN || "0"),
      max: Number(process.env.PILOT_HEDGE_NORM_CVAR95_MAX || "7000")
    },
    liquidityPenalty: {
      min: Number(process.env.PILOT_HEDGE_NORM_LIQUIDITY_MIN || "0"),
      max: Number(process.env.PILOT_HEDGE_NORM_LIQUIDITY_MAX || "50")
    },
    fillRiskPenalty: {
      min: Number(process.env.PILOT_HEDGE_NORM_FILL_RISK_MIN || "0"),
      max: Number(process.env.PILOT_HEDGE_NORM_FILL_RISK_MAX || "30")
    },
    basisPenalty: {
      min: Number(process.env.PILOT_HEDGE_NORM_BASIS_MIN || "0"),
      max: Number(process.env.PILOT_HEDGE_NORM_BASIS_MAX || "20")
    },
    carryPenalty: {
      min: Number(process.env.PILOT_HEDGE_NORM_CARRY_MIN || "0"),
      max: Number(process.env.PILOT_HEDGE_NORM_CARRY_MAX || "20")
    },
    pnlRewardUsd: {
      min: Number(process.env.PILOT_HEDGE_NORM_PNL_REWARD_MIN || "0"),
      max: Number(process.env.PILOT_HEDGE_NORM_PNL_REWARD_MAX || "7000")
    },
    mtpdReward: {
      min: Number(process.env.PILOT_HEDGE_NORM_MTPD_REWARD_MIN || "0"),
      max: Number(process.env.PILOT_HEDGE_NORM_MTPD_REWARD_MAX || "100")
    },
    tenorDriftDays: {
      min: Number(process.env.PILOT_HEDGE_NORM_TENOR_DRIFT_MIN || "0"),
      max: Number(process.env.PILOT_HEDGE_NORM_TENOR_DRIFT_MAX || "14")
    },
    strikeDistancePct: {
      min: Number(process.env.PILOT_HEDGE_NORM_STRIKE_DISTANCE_MIN || "0"),
      max: Number(process.env.PILOT_HEDGE_NORM_STRIKE_DISTANCE_MAX || "0.2")
    }
  },
  weights: {
    expectedSubsidy: Number(process.env.PILOT_HEDGE_WEIGHT_EXPECTED_SUBSIDY || "0.28"),
    cvar95: Number(process.env.PILOT_HEDGE_WEIGHT_CVAR95 || "0.14"),
    liquidityPenalty: Number(process.env.PILOT_HEDGE_WEIGHT_LIQUIDITY || "0.1"),
    fillRiskPenalty: Number(process.env.PILOT_HEDGE_WEIGHT_FILL_RISK || "0.08"),
    basisPenalty: Number(process.env.PILOT_HEDGE_WEIGHT_BASIS || "0.05"),
    carryPenalty: Number(process.env.PILOT_HEDGE_WEIGHT_CARRY || "0.05"),
    pnlReward: Number(process.env.PILOT_HEDGE_WEIGHT_PNL_REWARD || "0.12"),
    mtpdReward: Number(process.env.PILOT_HEDGE_WEIGHT_MTPD_REWARD || "0.08"),
    tenorDriftPenalty: Number(process.env.PILOT_HEDGE_WEIGHT_TENOR_DRIFT || "0.05"),
    strikeDistancePenalty: Number(process.env.PILOT_HEDGE_WEIGHT_STRIKE_DISTANCE || "0.05")
  },
  hardConstraints: {
    maxPremiumRatio: Number(process.env.PILOT_HEDGE_CONSTRAINT_MAX_PREMIUM_RATIO || "0.2"),
    maxSpreadPct: Number(process.env.PILOT_HEDGE_CONSTRAINT_MAX_SPREAD_PCT || "0.35"),
    minAskSize: Number(process.env.PILOT_HEDGE_CONSTRAINT_MIN_ASK_SIZE || "0.2"),
    maxTenorDriftDays: Number(process.env.PILOT_HEDGE_CONSTRAINT_MAX_TENOR_DRIFT_DAYS || "7"),
    minTailProtectionScore: Number(process.env.PILOT_HEDGE_CONSTRAINT_MIN_TAIL_SCORE || "1"),
    maxExpectedSubsidyUsd: Number(process.env.PILOT_HEDGE_CONSTRAINT_MAX_EXPECTED_SUBSIDY_USD || "10000")
  },
  regimePolicy: {
    calm: {
      preferCloserStrikeBias: Number(process.env.PILOT_HEDGE_REGIME_CALM_CLOSER_BIAS || "1.0"),
      maxStrikeDistancePct: Number(process.env.PILOT_HEDGE_REGIME_CALM_MAX_STRIKE_DISTANCE_PCT || "0.1"),
      minTenorDays: Number(process.env.PILOT_HEDGE_REGIME_CALM_MIN_TENOR_DAYS || "5"),
      maxTenorDays: Number(process.env.PILOT_HEDGE_REGIME_CALM_MAX_TENOR_DAYS || "21")
    },
    neutral: {
      preferCloserStrikeBias: Number(process.env.PILOT_HEDGE_REGIME_NEUTRAL_CLOSER_BIAS || "0.7"),
      maxStrikeDistancePct: Number(process.env.PILOT_HEDGE_REGIME_NEUTRAL_MAX_STRIKE_DISTANCE_PCT || "0.12"),
      minTenorDays: Number(process.env.PILOT_HEDGE_REGIME_NEUTRAL_MIN_TENOR_DAYS || "3"),
      maxTenorDays: Number(process.env.PILOT_HEDGE_REGIME_NEUTRAL_MAX_TENOR_DAYS || "14")
    },
    stress: {
      preferCloserStrikeBias: Number(process.env.PILOT_HEDGE_REGIME_STRESS_CLOSER_BIAS || "0.25"),
      maxStrikeDistancePct: Number(process.env.PILOT_HEDGE_REGIME_STRESS_MAX_STRIKE_DISTANCE_PCT || "0.2"),
      minTenorDays: Number(process.env.PILOT_HEDGE_REGIME_STRESS_MIN_TENOR_DAYS || "1"),
      maxTenorDays: Number(process.env.PILOT_HEDGE_REGIME_STRESS_MAX_TENOR_DAYS || "10")
    }
  }
});

const parseRolloutGuardRuntimeConfig = (): RolloutGuardRuntimeConfig => ({
  fallbackTriggerHitRatePct: parseNonNegativeFinite(
    process.env.PILOT_GUARD_FALLBACK_TRIGGER_HIT_RATE_PCT,
    8,
    "invalid_pilot_guard_fallback_trigger_hit_rate_pct"
  ),
  fallbackSubsidyUtilizationPct: parseNonNegativeFinite(
    process.env.PILOT_GUARD_FALLBACK_SUBSIDY_UTILIZATION_PCT,
    50,
    "invalid_pilot_guard_fallback_subsidy_utilization_pct"
  ),
  fallbackTreasuryDrawdownPct: parseNonNegativeFinite(
    process.env.PILOT_GUARD_FALLBACK_TREASURY_DRAWDOWN_PCT,
    25,
    "invalid_pilot_guard_fallback_treasury_drawdown_pct"
  ),
  pauseTriggerHitRatePct: parseNonNegativeFinite(
    process.env.PILOT_GUARD_PAUSE_TRIGGER_HIT_RATE_PCT,
    15,
    "invalid_pilot_guard_pause_trigger_hit_rate_pct"
  ),
  pauseSubsidyUtilizationPct: parseNonNegativeFinite(
    process.env.PILOT_GUARD_PAUSE_SUBSIDY_UTILIZATION_PCT,
    85,
    "invalid_pilot_guard_pause_subsidy_utilization_pct"
  ),
  pauseTreasuryDrawdownPct: parseNonNegativeFinite(
    process.env.PILOT_GUARD_PAUSE_TREASURY_DRAWDOWN_PCT,
    50,
    "invalid_pilot_guard_pause_treasury_drawdown_pct"
  ),
  pauseOnBlockedSubsidy: parseBooleanEnv(process.env.PILOT_GUARD_PAUSE_ON_BLOCKED_SUBSIDY, true)
});

const parseTierBatchingTenorRuntimeConfig = (): TierBatchingTenorRuntimeConfig => ({
  enabled: parseBooleanEnv(process.env.PILOT_TIER_BATCHING_ENABLED, false),
  batchWindowSeconds: parsePositiveIntInRange(
    process.env.PILOT_TIER_BATCHING_WINDOW_SECONDS,
    30,
    1,
    300,
    "invalid_pilot_tier_batching_window_seconds"
  ),
  maxBatchQuotes: parsePositiveIntInRange(
    process.env.PILOT_TIER_BATCHING_MAX_QUOTES,
    50,
    1,
    500,
    "invalid_pilot_tier_batching_max_quotes"
  ),
  tierGroupingEnabled: parseBooleanEnv(process.env.PILOT_TIER_GROUPING_ENABLED, true),
  tenorLadderEnabled: parseBooleanEnv(process.env.PILOT_TENOR_LADDER_ENABLED, false),
  tenorLadderDays: parseCommaSeparatedInts(
    process.env.PILOT_TENOR_LADDER_DAYS,
    [7, 14, 21],
    1,
    30,
    "invalid_pilot_tenor_ladder_days"
  )
});

const parseBullishRuntimeConfig = (forceEnabled = false): BullishRuntimeConfig => ({
  enabled: forceEnabled || parseBooleanEnv(process.env.PILOT_BULLISH_ENABLED, false),
  restBaseUrl: String(
    process.env.PILOT_BULLISH_REST_BASE_URL ||
      process.env.PILOT_BULLISH_API_HOSTNAME ||
      process.env.BULLISH_TESTNET_API_HOSTNAME ||
      process.env.BULLISH_API_HOSTNAME ||
      "https://api.exchange.bullish.com"
  ).trim(),
  publicWsUrl: String(
    process.env.PILOT_BULLISH_PUBLIC_WS_URL || "wss://api.exchange.bullish.com/trading-api/v1/market-data/orderbook"
  ).trim(),
  privateWsUrl: String(
    process.env.PILOT_BULLISH_PRIVATE_WS_URL || "wss://api.exchange.bullish.com/trading-api/v1/private-data"
  ).trim(),
  authMode: parseBullishAuthMode(process.env.PILOT_BULLISH_AUTH_MODE),
  hmacPublicKey: String(process.env.PILOT_BULLISH_HMAC_PUBLIC_KEY || "").trim(),
  hmacSecret: String(process.env.PILOT_BULLISH_HMAC_SECRET || "").trim(),
  ecdsaPublicKey: String(process.env.PILOT_BULLISH_ECDSA_PUBLIC_KEY || "").trim(),
  ecdsaPrivateKey: String(process.env.PILOT_BULLISH_ECDSA_PRIVATE_KEY || "").trim(),
  ecdsaMetadata: String(process.env.PILOT_BULLISH_ECDSA_METADATA || "").trim(),
  tradingAccountId: String(process.env.PILOT_BULLISH_TRADING_ACCOUNT_ID || "").trim(),
  defaultSymbol: String(process.env.PILOT_BULLISH_DEFAULT_SYMBOL || "BTCUSDC").trim() || "BTCUSDC",
  symbolByMarketId: parseSymbolMap(
    process.env.PILOT_BULLISH_SYMBOL_MAP,
    { "BTC-USD": "BTCUSDC" },
    "invalid_pilot_bullish_symbol_map"
  ),
  hmacLoginPath: String(process.env.PILOT_BULLISH_HMAC_LOGIN_PATH || "/trading-api/v1/users/hmac/login").trim(),
  ecdsaLoginPath: String(process.env.PILOT_BULLISH_ECDSA_LOGIN_PATH || "/trading-api/v2/users/login").trim(),
  tradingAccountsPath: String(
    process.env.PILOT_BULLISH_TRADING_ACCOUNTS_PATH || "/trading-api/v1/accounts/trading-accounts"
  ).trim(),
  noncePath: String(process.env.PILOT_BULLISH_NONCE_PATH || "/nonce").trim(),
  commandPath: String(process.env.PILOT_BULLISH_COMMAND_PATH || "/trading-api/v2/command").trim(),
  orderbookPathTemplate: String(
    process.env.PILOT_BULLISH_ORDERBOOK_PATH_TEMPLATE || "/trading-api/v1/markets/:symbol/orderbook/hybrid"
  ).trim(),
  enableExecution: parseBooleanEnv(process.env.PILOT_BULLISH_ENABLE_EXECUTION, false),
  orderTimeoutMs: parsePositiveIntInRange(
    process.env.PILOT_BULLISH_ORDER_TIMEOUT_MS,
    8000,
    1000,
    60000,
    "invalid_pilot_bullish_order_timeout_ms"
  ),
  orderTif: parseBullishOrderTif(process.env.PILOT_BULLISH_ORDER_TIF),
  allowMargin: parseBooleanEnv(process.env.PILOT_BULLISH_ALLOW_MARGIN, false)
});

const parsePremiumRegimeRuntimeConfig = (): PremiumRegimeRuntimeConfig => ({
  enabled: parseBooleanEnv(process.env.PILOT_PREMIUM_REGIME_ENABLED, false),
  applyToActuarialStrict: parseBooleanEnv(process.env.PILOT_PREMIUM_REGIME_APPLY_TO_ACTUARIAL, false),
  lookbackMinutes: parsePositiveIntInRange(
    process.env.PILOT_PREMIUM_REGIME_LOOKBACK_MINUTES,
    360,
    5,
    7 * 24 * 60,
    "invalid_pilot_premium_regime_lookback_minutes"
  ),
  minSamples: parsePositiveIntInRange(
    process.env.PILOT_PREMIUM_REGIME_MIN_SAMPLES,
    24,
    1,
    10000,
    "invalid_pilot_premium_regime_min_samples"
  ),
  minDwellMinutes: parsePositiveIntInRange(
    process.env.PILOT_PREMIUM_REGIME_MIN_DWELL_MINUTES,
    180,
    1,
    24 * 60,
    "invalid_pilot_premium_regime_min_dwell_minutes"
  ),
  maxOverlayPctOfBasePremium: parseFractionRange(
    process.env.PILOT_PREMIUM_REGIME_MAX_OVERLAY_PCT_OF_BASE,
    0.3,
    0,
    5,
    "invalid_pilot_premium_regime_max_overlay_pct_of_base"
  ),
  watchAddUsdPer1k: parseNonNegativeFinite(
    process.env.PILOT_PREMIUM_REGIME_WATCH_ADD_USD_PER_1K,
    1.5,
    "invalid_pilot_premium_regime_watch_add_usd_per_1k"
  ),
  watchMultiplier: parsePositiveFinite(
    process.env.PILOT_PREMIUM_REGIME_WATCH_MULTIPLIER,
    1.05,
    "invalid_pilot_premium_regime_watch_multiplier"
  ),
  stressAddUsdPer1k: parseNonNegativeFinite(
    process.env.PILOT_PREMIUM_REGIME_STRESS_ADD_USD_PER_1K,
    3,
    "invalid_pilot_premium_regime_stress_add_usd_per_1k"
  ),
  stressMultiplier: parsePositiveFinite(
    process.env.PILOT_PREMIUM_REGIME_STRESS_MULTIPLIER,
    1.15,
    "invalid_pilot_premium_regime_stress_multiplier"
  ),
  enterWatchTriggerHitRatePct: parseNonNegativeFinite(
    process.env.PILOT_PREMIUM_REGIME_ENTER_WATCH_TRIGGER_HIT_RATE_PCT,
    7,
    "invalid_pilot_premium_regime_enter_watch_trigger_hit_rate_pct"
  ),
  enterWatchSubsidyUtilizationPct: parseNonNegativeFinite(
    process.env.PILOT_PREMIUM_REGIME_ENTER_WATCH_SUBSIDY_UTILIZATION_PCT,
    35,
    "invalid_pilot_premium_regime_enter_watch_subsidy_utilization_pct"
  ),
  enterWatchTreasuryDrawdownPct: parseNonNegativeFinite(
    process.env.PILOT_PREMIUM_REGIME_ENTER_WATCH_TREASURY_DRAWDOWN_PCT,
    15,
    "invalid_pilot_premium_regime_enter_watch_treasury_drawdown_pct"
  ),
  enterStressTriggerHitRatePct: parseNonNegativeFinite(
    process.env.PILOT_PREMIUM_REGIME_ENTER_STRESS_TRIGGER_HIT_RATE_PCT,
    12,
    "invalid_pilot_premium_regime_enter_stress_trigger_hit_rate_pct"
  ),
  enterStressSubsidyUtilizationPct: parseNonNegativeFinite(
    process.env.PILOT_PREMIUM_REGIME_ENTER_STRESS_SUBSIDY_UTILIZATION_PCT,
    60,
    "invalid_pilot_premium_regime_enter_stress_subsidy_utilization_pct"
  ),
  enterStressTreasuryDrawdownPct: parseNonNegativeFinite(
    process.env.PILOT_PREMIUM_REGIME_ENTER_STRESS_TREASURY_DRAWDOWN_PCT,
    30,
    "invalid_pilot_premium_regime_enter_stress_treasury_drawdown_pct"
  ),
  exitWatchTriggerHitRatePct: parseNonNegativeFinite(
    process.env.PILOT_PREMIUM_REGIME_EXIT_WATCH_TRIGGER_HIT_RATE_PCT,
    4,
    "invalid_pilot_premium_regime_exit_watch_trigger_hit_rate_pct"
  ),
  exitWatchSubsidyUtilizationPct: parseNonNegativeFinite(
    process.env.PILOT_PREMIUM_REGIME_EXIT_WATCH_SUBSIDY_UTILIZATION_PCT,
    25,
    "invalid_pilot_premium_regime_exit_watch_subsidy_utilization_pct"
  ),
  exitWatchTreasuryDrawdownPct: parseNonNegativeFinite(
    process.env.PILOT_PREMIUM_REGIME_EXIT_WATCH_TREASURY_DRAWDOWN_PCT,
    8,
    "invalid_pilot_premium_regime_exit_watch_treasury_drawdown_pct"
  ),
  exitStressTriggerHitRatePct: parseNonNegativeFinite(
    process.env.PILOT_PREMIUM_REGIME_EXIT_STRESS_TRIGGER_HIT_RATE_PCT,
    8,
    "invalid_pilot_premium_regime_exit_stress_trigger_hit_rate_pct"
  ),
  exitStressSubsidyUtilizationPct: parseNonNegativeFinite(
    process.env.PILOT_PREMIUM_REGIME_EXIT_STRESS_SUBSIDY_UTILIZATION_PCT,
    45,
    "invalid_pilot_premium_regime_exit_stress_subsidy_utilization_pct"
  ),
  exitStressTreasuryDrawdownPct: parseNonNegativeFinite(
    process.env.PILOT_PREMIUM_REGIME_EXIT_STRESS_TREASURY_DRAWDOWN_PCT,
    20,
    "invalid_pilot_premium_regime_exit_stress_treasury_drawdown_pct"
  )
});

export const parseFractionRange = (
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  errorCode: string
): number => {
  const parsed = Number(raw ?? String(fallback));
  if (Number.isFinite(parsed) && parsed >= min && parsed <= max) return parsed;
  throw new Error(`${errorCode}:${String(raw || "").trim() || "empty"}`);
};

export const parseCommaSeparatedInts = (
  raw: string | undefined,
  fallback: number[],
  min: number,
  max: number,
  errorCode: string
): number[] => {
  const input = String(raw || "")
    .trim()
    .replace(/\s+/g, "");
  if (!input) return fallback.slice();
  const parsed = input
    .split(",")
    .filter(Boolean)
    .map((item) => Number(item));
  if (!parsed.length) {
    throw new Error(`${errorCode}:empty`);
  }
  const normalized = parsed.map((value) => {
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${errorCode}:${String(value)}`);
    }
    return Math.floor(value);
  });
  return Array.from(new Set(normalized)).sort((a, b) => a - b);
};

export const parseSymbolMap = (
  raw: string | undefined,
  fallback: Record<string, string>,
  errorCode: string
): Record<string, string> => {
  const input = String(raw || "").trim();
  if (!input) return { ...fallback };
  const entries = input
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean);
  if (!entries.length) return { ...fallback };
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const [left, right] = entry.split(":").map((part) => part?.trim() || "");
    if (!left || !right) {
      throw new Error(`${errorCode}:${entry}`);
    }
    out[left] = right;
  }
  return out;
};

const resolveTenorBounds = (): {
  minDays: number;
  maxDays: number;
  defaultDays: number;
} => {
  const minDays = parsePositiveIntInRange(
    process.env.PILOT_TENOR_MIN_DAYS,
    1,
    1,
    30,
    "invalid_pilot_tenor_min_days"
  );
  const maxDays = parsePositiveIntInRange(
    process.env.PILOT_TENOR_MAX_DAYS,
    7,
    1,
    30,
    "invalid_pilot_tenor_max_days"
  );
  const defaultDays = parsePositiveIntInRange(
    process.env.PILOT_TENOR_DEFAULT_DAYS,
    7,
    1,
    30,
    "invalid_pilot_tenor_default_days"
  );
  if (minDays > maxDays) {
    throw new Error(`invalid_pilot_tenor_bounds:min_${minDays}_gt_max_${maxDays}`);
  }
  if (defaultDays < minDays || defaultDays > maxDays) {
    throw new Error(`invalid_pilot_tenor_default_out_of_bounds:${defaultDays}`);
  }
  return { minDays, maxDays, defaultDays };
};

const parsePilotDurationDays = (raw: string | undefined): number => {
  const parsed = Number(raw || "30");
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= 3650) {
    return Math.floor(parsed);
  }
  return 30;
};

const parsePilotStartAt = (raw: string | undefined): Date | null => {
  const value = String(raw || "").trim();
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

export const resolvePilotWindow = (now: Date = new Date()): PilotWindowState => {
  const enforced = process.env.PILOT_ENFORCE_WINDOW !== "false";
  const durationDays = parsePilotDurationDays(process.env.PILOT_DURATION_DAYS);
  const startRaw = process.env.PILOT_START_AT;
  const startAtDate = parsePilotStartAt(startRaw);
  if (!enforced) {
    return {
      enforced: false,
      startAt: null,
      endAt: null,
      durationDays,
      status: "open"
    };
  }
  if (!String(startRaw || "").trim()) {
    return {
      enforced: true,
      startAt: null,
      endAt: null,
      durationDays,
      status: "open"
    };
  }
  if (!startAtDate) {
    return {
      enforced: true,
      startAt: null,
      endAt: null,
      durationDays,
      status: "config_invalid",
      reason: "pilot_start_at_invalid"
    };
  }
  const endAtDate = new Date(startAtDate.getTime() + durationDays * 86400000);
  if (now.getTime() < startAtDate.getTime()) {
    return {
      enforced: true,
      startAt: startAtDate.toISOString(),
      endAt: endAtDate.toISOString(),
      durationDays,
      status: "not_started"
    };
  }
  if (now.getTime() >= endAtDate.getTime()) {
    return {
      enforced: true,
      startAt: startAtDate.toISOString(),
      endAt: endAtDate.toISOString(),
      durationDays,
      status: "closed"
    };
  }
  return {
    enforced: true,
    startAt: startAtDate.toISOString(),
    endAt: endAtDate.toISOString(),
    durationDays,
    status: "open"
  };
};

const pilotProfileName = parsePilotProfile(process.env.PILOT_PROFILE);
const isBullishLockedProfile = pilotProfileName === "bullish_locked_v1";

export type V7PricingConfig = {
  enabled: boolean;
  defaultTenorDays: number;
  dvolCalmThreshold: number;
  dvolStressThreshold: number;
  dvolCacheTtlMs: number;
  tpThresholdMultiplier: number;
  hedgeManagementIntervalMs: number;
  premiumSchedule: Record<number, Record<string, number | null>>;
};

const parseV7PricingConfig = (): V7PricingConfig => ({
  enabled: parseBooleanEnv(process.env.V7_PRICING_ENABLED, true),
  defaultTenorDays: parsePositiveIntInRange(
    process.env.V7_DEFAULT_TENOR_DAYS,
    2,
    1,
    30,
    "invalid_v7_default_tenor_days"
  ),
  dvolCalmThreshold: parseNonNegativeFinite(
    process.env.V7_DVOL_CALM_THRESHOLD,
    40,
    "invalid_v7_dvol_calm_threshold"
  ),
  dvolStressThreshold: parseNonNegativeFinite(
    process.env.V7_DVOL_STRESS_THRESHOLD,
    65,
    "invalid_v7_dvol_stress_threshold"
  ),
  dvolCacheTtlMs: parsePositiveIntInRange(
    process.env.V7_DVOL_CACHE_TTL_MS,
    300000,
    10000,
    3600000,
    "invalid_v7_dvol_cache_ttl_ms"
  ),
  tpThresholdMultiplier: parsePositiveFinite(
    process.env.V7_TP_THRESHOLD_MULTIPLIER,
    1.3,
    "invalid_v7_tp_threshold_multiplier"
  ),
  hedgeManagementIntervalMs: parsePositiveIntInRange(
    process.env.V7_HEDGE_MANAGEMENT_INTERVAL_MS,
    60000,
    5000,
    600000,
    "invalid_v7_hedge_management_interval_ms"
  ),
  premiumSchedule: {
    1:  { calm: 5,  normal: 9,  stress: null },
    2:  { calm: 3,  normal: 6,  stress: 13 },
    3:  { calm: 2,  normal: 5,  stress: 12 },
    5:  { calm: 2,  normal: 4,  stress: 10 },
    10: { calm: 1,  normal: 2,  stress: 6 }
  }
});

export const pilotConfig = {
  v7: parseV7PricingConfig(),
  profile: pilotProfileName,
  bullishLockedProfile: isBullishLockedProfile,
  enabled: process.env.PILOT_API_ENABLED === "true",
  activationEnabled: parseBooleanEnv(process.env.PILOT_ACTIVATION_ENABLED, false),
  venueMode: isBullishLockedProfile ? "bullish_testnet" : parsePilotVenueMode(process.env.PILOT_VENUE_MODE),
  deribitQuotePolicy: parseDeribitQuotePolicy(process.env.PILOT_DERIBIT_QUOTE_POLICY),
  deribitStrikeSelectionMode: parseDeribitStrikeSelectionMode(process.env.PILOT_STRIKE_SELECTION_MODE),
  deribitMaxTenorDriftDays: parseDeribitMaxTenorDriftDays(process.env.PILOT_DERIBIT_MAX_TENOR_DRIFT_DAYS),
  pilotHedgePolicy: parsePilotHedgePolicy(process.env.PILOT_HEDGE_POLICY),
  premiumPolicyMode: isBullishLockedProfile
    ? "pass_through_markup"
    : parsePremiumPolicyMode(process.env.PILOT_PREMIUM_POLICY_MODE),
  premiumPricingMode: isBullishLockedProfile
    ? "hybrid_otm_treasury"
    : parsePilotPricingMode(process.env.PILOT_PREMIUM_PRICING_MODE),
  pilotSelectorMode: isBullishLockedProfile ? "strict_profitability" : parsePilotSelectorMode(process.env.PILOT_SELECTOR_MODE),
  bullish: parseBullishRuntimeConfig(isBullishLockedProfile),
  hedgeOptimizer: parseHedgeOptimizerRuntimeConfig(),
  rolloutGuards: parseRolloutGuardRuntimeConfig(),
  tierBatchingTenor: parseTierBatchingTenorRuntimeConfig(),
  premiumRegime: parsePremiumRegimeRuntimeConfig(),
  premiumPolicyVersion: String(process.env.PILOT_PREMIUM_POLICY_VERSION || "v2").trim() || "v2",
  premiumPolicyEnforce: parseBooleanEnv(process.env.PILOT_PREMIUM_ENFORCE, false),
  premiumCapEnforce: parseBooleanEnv(process.env.PILOT_ENFORCE_PREMIUM_CAP, false),
  premiumCapToleranceUsd: parsePositiveFinite(
    process.env.PILOT_PREMIUM_CAP_TOLERANCE_USD,
    0.5,
    "invalid_pilot_premium_cap_tolerance_usd"
  ),
  ibkrFeePerContractUsd: parsePositiveFinite(
    process.env.IBKR_FEE_PER_CONTRACT_USD,
    2.02,
    "invalid_ibkr_fee_per_contract_usd"
  ),
  ibkrFeePerOrderUsd: Number.isFinite(Number(process.env.IBKR_FEE_PER_ORDER_USD ?? "0"))
    ? Math.max(0, Number(process.env.IBKR_FEE_PER_ORDER_USD ?? "0"))
    : 0,
  dynamicTenorEnabled: isBullishLockedProfile ? false : parseBooleanEnv(process.env.PILOT_DYNAMIC_TENOR_ENABLED, false),
  tenorPolicyVersion: String(process.env.PILOT_TENOR_POLICY_VERSION || "tenor_policy_v1").trim() || "tenor_policy_v1",
  tenorPolicyLookbackMinutes: parsePositiveIntInRange(
    process.env.PILOT_TENOR_POLICY_LOOKBACK_MINUTES,
    60,
    1,
    24 * 60,
    "invalid_pilot_tenor_policy_lookback_minutes"
  ),
  tenorPolicyMinSamples: parsePositiveIntInRange(
    process.env.PILOT_TENOR_MIN_SAMPLES,
    5,
    1,
    500,
    "invalid_pilot_tenor_min_samples"
  ),
  tenorPolicyMinOkRate: Number(process.env.PILOT_TENOR_MIN_OK_RATE ?? "0.8"),
  tenorPolicyMinOptionsNativeRate: Number(process.env.PILOT_TENOR_MIN_OPTIONS_NATIVE_RATE ?? "0.8"),
  tenorPolicyMaxMedianPremiumRatio: Number(process.env.PILOT_TENOR_MAX_MEDIAN_PREMIUM_RATIO ?? "0.02"),
  tenorPolicyMaxMedianDriftDays: Number(process.env.PILOT_TENOR_MAX_MEDIAN_DRIFT_DAYS ?? "3"),
  tenorPolicyMaxNegativeMatchedRate: Number(process.env.PILOT_TENOR_MAX_NEGATIVE_MATCH_RATE ?? "0"),
  tenorPolicyEnforce: isBullishLockedProfile
    ? false
    : parseBooleanEnv(process.env.PILOT_TENOR_ENFORCE ?? process.env.PILOT_TENOR_POLICY_ENFORCE, false),
  tenorPolicyAutoRoute: isBullishLockedProfile ? false : parseBooleanEnv(process.env.PILOT_TENOR_AUTO_ROUTE, false),
  tenorPolicyDefaultFallbackDays: parsePositiveIntInRange(
    process.env.PILOT_TENOR_DEFAULT_FALLBACK,
    14,
    1,
    30,
    "invalid_pilot_tenor_default_fallback"
  ),
  tenorPolicyCandidateDays: parseCommaSeparatedInts(
    process.env.PILOT_TENOR_CANDIDATES,
    [1, 2, 4, 7, 10, 12, 14],
    1,
    30,
    "invalid_pilot_tenor_candidates"
  ),
  ...(() => {
    const v7 = parseV7PricingConfig();
    if (v7.enabled) {
      return {
        pilotTenorMinDays: 1,
        pilotTenorMaxDays: 14,
        pilotTenorDefaultDays: v7.defaultTenorDays
      };
    }
    if (isBullishLockedProfile) {
      return {
        pilotTenorMinDays: 7,
        pilotTenorMaxDays: 7,
        pilotTenorDefaultDays: 7
      };
    }
    const tenor = resolveTenorBounds();
    return {
      pilotTenorMinDays: tenor.minDays,
      pilotTenorMaxDays: tenor.maxDays,
      pilotTenorDefaultDays: tenor.defaultDays
    };
  })(),
  ibkrBridgeBaseUrl: String(process.env.IBKR_BRIDGE_BASE_URL || "http://127.0.0.1:18080").trim(),
  ibkrBridgeTimeoutMs: parsePositiveFinite(
    process.env.IBKR_BRIDGE_TIMEOUT_MS,
    4000,
    "invalid_ibkr_bridge_timeout_ms"
  ),
  ibkrBridgeToken: String(process.env.IBKR_BRIDGE_TOKEN || "").trim(),
  ibkrAccountId: String(process.env.IBKR_ACCOUNT_ID || "").trim(),
  ibkrEnableExecution: process.env.IBKR_ENABLE_EXECUTION === "true",
  ibkrOrderTif: parseIbkrOrderTif(process.env.IBKR_ORDER_TIF),
  ibkrPrimaryProductFamily: parseIbkrProductFamily(process.env.IBKR_PRIMARY_PRODUCT_FAMILY, "MBT"),
  ibkrBffFallbackEnabled: parseBooleanEnv(process.env.IBKR_BFF_FALLBACK_ENABLED, false),
  ibkrBffProductFamily: parseIbkrProductFamily(process.env.IBKR_BFF_PRODUCT_FAMILY, "BFF"),
  ibkrOrderTimeoutMs: parsePositiveFinite(
    process.env.IBKR_ORDER_TIMEOUT_MS,
    8000,
    "invalid_ibkr_order_timeout_ms"
  ),
  ibkrMaxRepriceSteps: parsePositiveIntInRange(
    process.env.IBKR_MAX_REPRICE_STEPS,
    4,
    1,
    20,
    "invalid_ibkr_max_reprice_steps"
  ),
  ibkrRepriceStepTicks: parsePositiveFinite(
    process.env.IBKR_REPRICE_STEP_TICKS,
    2,
    "invalid_ibkr_reprice_step_ticks"
  ),
  ibkrMaxSlippageBps: parsePositiveFinite(
    process.env.IBKR_MAX_SLIPPAGE_BPS,
    25,
    "invalid_ibkr_max_slippage_bps"
  ),
  ibkrMaxTenorDriftDays: parsePositiveFinite(
    process.env.IBKR_MAX_TENOR_DRIFT_DAYS,
    7,
    "invalid_ibkr_max_tenor_drift_days"
  ),
  ibkrMaxFuturesSyntheticPremiumRatio: parsePositiveFinite(
    process.env.IBKR_MAX_FUTURES_SYNTHETIC_PREMIUM_RATIO,
    0.05,
    "invalid_ibkr_max_futures_synthetic_premium_ratio"
  ),
  ibkrMaxOptionPremiumRatio: parsePositiveFinite(
    process.env.IBKR_MAX_OPTION_PREMIUM_RATIO,
    0.15,
    "invalid_ibkr_max_option_premium_ratio"
  ),
  ibkrOptionProbeParallelism: parsePositiveIntInRange(
    process.env.IBKR_OPTION_PROBE_PARALLELISM,
    3,
    1,
    8,
    "invalid_ibkr_option_probe_parallelism"
  ),
  ibkrOptionLiquiditySelectionEnabled: parseBooleanEnv(process.env.IBKR_OPTION_LIQUIDITY_SELECTION_ENABLED, false),
  ibkrRequireOptionsNative: parseBooleanEnv(process.env.IBKR_REQUIRE_OPTIONS_NATIVE, true),
  ibkrQualifyCacheTtlMs: parsePositiveIntInRange(
    process.env.IBKR_QUALIFY_CACHE_TTL_MS,
    120000,
    1000,
    3600000,
    "invalid_ibkr_qualify_cache_ttl_ms"
  ),
  ibkrQualifyCacheMaxKeys: parsePositiveIntInRange(
    process.env.IBKR_QUALIFY_CACHE_MAX_KEYS,
    2000,
    100,
    20000,
    "invalid_ibkr_qualify_cache_max_keys"
  ),
  ibkrOptionLiquidityTenorWindowDays: parsePositiveIntInRange(
    process.env.IBKR_OPTION_LIQUIDITY_TENOR_WINDOW_DAYS,
    3,
    0,
    30,
    "invalid_ibkr_option_liquidity_tenor_window_days"
  ),
  ibkrOptionProtectionTolerancePct: Number.isFinite(Number(process.env.IBKR_OPTION_PROTECTION_TOLERANCE_PCT ?? "0.03"))
    ? Math.max(0, Number(process.env.IBKR_OPTION_PROTECTION_TOLERANCE_PCT ?? "0.03"))
    : 0.03,
  optionSelectionCoverageWeight: Number.isFinite(Number(process.env.PILOT_OPTION_SELECTION_COVERAGE_WEIGHT ?? "18"))
    ? Math.max(0, Number(process.env.PILOT_OPTION_SELECTION_COVERAGE_WEIGHT ?? "18"))
    : 18,
  optionSelectionPremiumWeight: Number.isFinite(Number(process.env.PILOT_OPTION_SELECTION_PREMIUM_WEIGHT ?? "14"))
    ? Math.max(0, Number(process.env.PILOT_OPTION_SELECTION_PREMIUM_WEIGHT ?? "14"))
    : 14,
  optionSelectionLiquidityWeight: Number.isFinite(Number(process.env.PILOT_OPTION_SELECTION_LIQUIDITY_WEIGHT ?? "7.5"))
    ? Math.max(0, Number(process.env.PILOT_OPTION_SELECTION_LIQUIDITY_WEIGHT ?? "7.5"))
    : 7.5,
  optionSelectionTenorWeight: Number.isFinite(Number(process.env.PILOT_OPTION_SELECTION_TENOR_WEIGHT ?? "20"))
    ? Math.max(0, Number(process.env.PILOT_OPTION_SELECTION_TENOR_WEIGHT ?? "20"))
    : 20,
  premiumTriggerCostShare: Number.isFinite(Number(process.env.PILOT_PREMIUM_TRIGGER_COST_SHARE ?? "0.15"))
    ? Math.max(0, Number(process.env.PILOT_PREMIUM_TRIGGER_COST_SHARE ?? "0.15"))
    : 0.15,
  premiumExpectedTriggerProbabilityByTier: {
    "Pro (Bronze)": Number(process.env.PILOT_PREMIUM_TRIGGER_PROB_BRONZE || "0.28"),
    "Pro (Silver)": Number(process.env.PILOT_PREMIUM_TRIGGER_PROB_SILVER || "0.22"),
    "Pro (Gold)": Number(process.env.PILOT_PREMIUM_TRIGGER_PROB_GOLD || "0.18"),
    "Pro (Platinum)": Number(process.env.PILOT_PREMIUM_TRIGGER_PROB_PLATINUM || "0.15")
  } as Record<string, number>,
  ibkrPreferTenorAtOrAbove: parseBooleanEnv(process.env.IBKR_PREFER_TENOR_AT_OR_ABOVE, true),
  ibkrRequireLiveTransport: parseBooleanEnv(
    process.env.IBKR_REQUIRE_LIVE_TRANSPORT,
    parsePilotVenueMode(process.env.PILOT_VENUE_MODE) === "ibkr_cme_live"
  ),
  tenantScopeId: (process.env.PILOT_TENANT_SCOPE_ID || "foxify-pilot").trim() || "foxify-pilot",
  termsVersion: (process.env.PILOT_TERMS_VERSION || "v1.0").trim() || "v1.0",
  postgresUrl: process.env.POSTGRES_URL || process.env.DATABASE_URL || "",
  adminToken: process.env.PILOT_ADMIN_TOKEN || "",
  internalToken: process.env.PILOT_INTERNAL_TOKEN || "",
  pilotStartAt: process.env.PILOT_START_AT || "",
  pilotDurationDays: parsePilotDurationDays(process.env.PILOT_DURATION_DAYS),
  pilotEnforceWindow: process.env.PILOT_ENFORCE_WINDOW !== "false",
  proofToken: process.env.PILOT_PROOF_TOKEN || "",
  hashVersion: Number(process.env.USER_HASH_VERSION || "1"),
  hashSecret: process.env.USER_HASH_SECRET || "",
  quoteMinNotionalUsdc: parsePilotQuoteMinNotionalUsdc(process.env.PILOT_QUOTE_MIN_NOTIONAL_USDC),
  maxProtectionNotionalUsdc: Number(process.env.PILOT_MAX_PROTECTION_NOTIONAL_USDC || "50000"),
  maxDailyProtectedNotionalUsdc: Number(process.env.PILOT_MAX_DAILY_PROTECTED_NOTIONAL_USDC || "50000"),
  treasuryPerQuoteSubsidyCapPct: parseFractionRange(
    process.env.PILOT_TREASURY_SUBSIDY_CAP_PCT,
    0.7,
    0,
    1,
    "invalid_pilot_treasury_subsidy_cap_pct"
  ),
  treasuryDailySubsidyCapUsdc: parsePositiveFinite(
    process.env.PILOT_TREASURY_DAILY_SUBSIDY_CAP_USDC,
    15000,
    "invalid_pilot_treasury_daily_subsidy_cap_usdc"
  ),
  treasuryStrictFallbackEnabled: parseBooleanEnv(process.env.PILOT_TREASURY_STRICT_FALLBACK_ENABLED, true),
  hybridTriggerProbCap: parseFractionRange(
    process.env.PILOT_HYBRID_TRIGGER_PROB_CAP,
    0.2,
    0,
    1,
    "invalid_pilot_hybrid_trigger_prob_cap"
  ),
  hybridClaimsCoverageFactor: parseFractionRange(
    process.env.PILOT_HYBRID_CLAIMS_COVERAGE_FACTOR,
    0.3,
    0,
    1,
    "invalid_pilot_hybrid_claims_coverage_factor"
  ),
  hybridMarkupFactor: parsePositiveFinite(
    process.env.PILOT_HYBRID_MARKUP_FACTOR,
    1.5,
    "invalid_pilot_hybrid_markup_factor"
  ),
  hybridBaseFeeUsd: parseNonNegativeFinite(
    process.env.PILOT_HYBRID_BASE_FEE_USD,
    5,
    "invalid_pilot_hybrid_base_fee_usd"
  ),
  hybridStrictMultiplierSchedules: resolveHybridStrictMultiplierSchedules(),
  hybridStrictMultiplierByTier: resolveCheaperHybridStrictMultiplierByTier(),
  premiumMarkupPct: Number(process.env.PILOT_PREMIUM_MARKUP_PCT || "0.045"),
  premiumMarkupPctByTier: {
    "Pro (Bronze)": Number(process.env.PILOT_PREMIUM_MARKUP_PCT_BRONZE || "0.06"),
    "Pro (Silver)": Number(process.env.PILOT_PREMIUM_MARKUP_PCT_SILVER || "0.05"),
    "Pro (Gold)": Number(process.env.PILOT_PREMIUM_MARKUP_PCT_GOLD || "0.04"),
    "Pro (Platinum)": Number(process.env.PILOT_PREMIUM_MARKUP_PCT_PLATINUM || "0.03")
  } as Record<string, number>,
  premiumFloorUsdByTier: {
    "Pro (Bronze)": Number(process.env.PILOT_PREMIUM_FLOOR_USD_BRONZE || "20"),
    "Pro (Silver)": Number(process.env.PILOT_PREMIUM_FLOOR_USD_SILVER || "17"),
    "Pro (Gold)": Number(process.env.PILOT_PREMIUM_FLOOR_USD_GOLD || "14"),
    "Pro (Platinum)": Number(process.env.PILOT_PREMIUM_FLOOR_USD_PLATINUM || "12")
  } as Record<string, number>,
  premiumFloorBpsByTier: {
    "Pro (Bronze)": Number(process.env.PILOT_PREMIUM_FLOOR_BPS_BRONZE || "6"),
    "Pro (Silver)": Number(process.env.PILOT_PREMIUM_FLOOR_BPS_SILVER || "5"),
    "Pro (Gold)": Number(process.env.PILOT_PREMIUM_FLOOR_BPS_GOLD || "4"),
    "Pro (Platinum)": Number(process.env.PILOT_PREMIUM_FLOOR_BPS_PLATINUM || "4")
  } as Record<string, number>,
  premiumTriggerCreditFloorPctByTier: {
    "Pro (Bronze)": Number(process.env.PILOT_PREMIUM_TRIGGER_CREDIT_FLOOR_PCT_BRONZE || "0.03"),
    "Pro (Silver)": Number(process.env.PILOT_PREMIUM_TRIGGER_CREDIT_FLOOR_PCT_SILVER || "0.025"),
    "Pro (Gold)": Number(process.env.PILOT_PREMIUM_TRIGGER_CREDIT_FLOOR_PCT_GOLD || "0.02"),
    "Pro (Platinum)": Number(process.env.PILOT_PREMIUM_TRIGGER_CREDIT_FLOOR_PCT_PLATINUM || "0.018")
  } as Record<string, number>,
  premiumExpectedTriggerBreachProbByTier: {
    "Pro (Bronze)": Number(process.env.PILOT_PREMIUM_EXPECTED_TRIGGER_BREACH_PROB_BRONZE || "0.25"),
    "Pro (Silver)": Number(process.env.PILOT_PREMIUM_EXPECTED_TRIGGER_BREACH_PROB_SILVER || "0.2"),
    "Pro (Gold)": Number(process.env.PILOT_PREMIUM_EXPECTED_TRIGGER_BREACH_PROB_GOLD || "0.16"),
    "Pro (Platinum)": Number(process.env.PILOT_PREMIUM_EXPECTED_TRIGGER_BREACH_PROB_PLATINUM || "0.14")
  } as Record<string, number>,
  premiumProfitabilityBufferPctByTier: {
    "Pro (Bronze)": Number(process.env.PILOT_PREMIUM_PROFITABILITY_BUFFER_PCT_BRONZE || "0.015"),
    "Pro (Silver)": Number(process.env.PILOT_PREMIUM_PROFITABILITY_BUFFER_PCT_SILVER || "0.012"),
    "Pro (Gold)": Number(process.env.PILOT_PREMIUM_PROFITABILITY_BUFFER_PCT_GOLD || "0.01"),
    "Pro (Platinum)": Number(process.env.PILOT_PREMIUM_PROFITABILITY_BUFFER_PCT_PLATINUM || "0.01")
  } as Record<string, number>,
  premiumTriggerCreditWeightByTier: {
    "Pro (Bronze)": Number(process.env.PILOT_PREMIUM_TRIGGER_CREDIT_WEIGHT_BRONZE || "0.35"),
    "Pro (Silver)": Number(process.env.PILOT_PREMIUM_TRIGGER_CREDIT_WEIGHT_SILVER || "0.32"),
    "Pro (Gold)": Number(process.env.PILOT_PREMIUM_TRIGGER_CREDIT_WEIGHT_GOLD || "0.28"),
    "Pro (Platinum)": Number(process.env.PILOT_PREMIUM_TRIGGER_CREDIT_WEIGHT_PLATINUM || "0.25")
  } as Record<string, number>,
  startingReserveUsdc: Number(process.env.PILOT_STARTING_RESERVE_USDC || "25000"),
  pricePrimaryTimeoutMs: Number(process.env.PRICE_TIMEOUT_PRIMARY_MS || "1400"),
  priceFallbackTimeoutMs: Number(process.env.PRICE_TIMEOUT_FALLBACK_MS || "1400"),
  priceFreshnessMaxMs: Number(process.env.PRICE_FRESHNESS_MAX_MS || "5000"),
  priceRequestRetryAttempts: Number(process.env.PRICE_REQUEST_RETRY_ATTEMPTS || "3"),
  priceRequestRetryDelayMs: Number(process.env.PRICE_REQUEST_RETRY_DELAY_MS || "180"),
  venueQuoteTimeoutMs: Number(process.env.PILOT_VENUE_QUOTE_TIMEOUT_MS || "30000"),
  quoteTtlMs: Number(process.env.PILOT_QUOTE_TTL_MS || "30000"),
  venueExecuteTimeoutMs: Number(process.env.PILOT_VENUE_EXEC_TIMEOUT_MS || "25000"),
  venueMarkTimeoutMs: Number(process.env.PILOT_VENUE_MARK_TIMEOUT_MS || "3000"),
  triggerMonitorEnabled: parseBooleanEnv(process.env.PILOT_TRIGGER_MONITOR_ENABLED, true),
  triggerMonitorIntervalMs: parsePositiveIntInRange(
    process.env.PILOT_TRIGGER_MONITOR_INTERVAL_MS,
    5000,
    1000,
    60000,
    "invalid_pilot_trigger_monitor_interval_ms"
  ),
  triggerMonitorBatchSize: parsePositiveIntInRange(
    process.env.PILOT_TRIGGER_MONITOR_BATCH_SIZE,
    50,
    1,
    500,
    "invalid_pilot_trigger_monitor_batch_size"
  ),
  singlePriceSource: process.env.PRICE_SINGLE_SOURCE === "true",
  expiryInitialWindowMs: Number(process.env.EXPIRY_PRICE_INITIAL_WINDOW_MS || "5000"),
  fullCoverageTolerancePct: Number(process.env.FULL_COVERAGE_TOLERANCE_PCT || "0.005"),
  requireFullCoverage: process.env.REQUIRE_FULL_POSITION_COVERAGE !== "false",
  requireFullExecutionFill: process.env.REQUIRE_FULL_EXECUTION_FILL !== "false",
  referencePriceUrl:
    process.env.PRICE_REFERENCE_URL ||
    process.env.DYDX_PRICE_URL ||
    "https://api.exchange.coinbase.com/products/BTC-USD/ticker",
  referenceMarketId: process.env.PRICE_REFERENCE_MARKET_ID || process.env.DYDX_BTC_MARKET_ID || "BTC-USD",
  fallbackPriceUrl:
    process.env.FALLBACK_PRICE_URL ||
    "https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL",
  falconxBaseUrl: process.env.FALCONX_BASE_URL || "https://api.falconx.io",
  falconxApiKey: process.env.FALCONX_API_KEY || "",
  falconxSecret: process.env.FALCONX_SECRET || "",
  falconxPassphrase: process.env.FALCONX_PASSPHRASE || "",
  adminIpAllowlist: parseAllowlist(process.env.PILOT_ADMIN_IP_ALLOWLIST),
  endpointVersion: process.env.PILOT_ENDPOINT_VERSION || "v1",
  lockedProfile: {
    enabled: isBullishLockedProfile,
    name: pilotProfileName,
    venueMode: "bullish_testnet",
    forceOnlyBullishVenue: isBullishLockedProfile,
    fixedTenorDays: isBullishLockedProfile ? 7 : parsePositiveIntInRange(process.env.PILOT_FIXED_TENOR_DAYS, 7, 1, 30, "invalid_pilot_fixed_tenor_days"),
    enforceTierDrawdownOnly: isBullishLockedProfile,
    fixedPricingMode: isBullishLockedProfile ? "hybrid_otm_treasury" : parsePilotPricingMode(process.env.PILOT_FIXED_PRICING_MODE),
    premiumPolicyMode: isBullishLockedProfile ? "pass_through_markup" : parsePremiumPolicyMode(process.env.PILOT_FIXED_PREMIUM_POLICY_MODE),
    selectorMode: isBullishLockedProfile ? "strict_profitability" : parsePilotSelectorMode(process.env.PILOT_FIXED_SELECTOR_MODE),
    hybridStrictMultiplierSchedule: isBullishLockedProfile
      ? DEFAULT_LIVE_HYBRID_STRICT_MULTIPLIER_SCHEDULE
      : (() => {
          const raw = String(process.env.PILOT_HYBRID_STRICT_MULTIPLIER_SCHEDULE || DEFAULT_LIVE_HYBRID_STRICT_MULTIPLIER_SCHEDULE)
            .trim()
            .toLowerCase();
          if (raw === "current" || raw === "cheaper") return raw;
          throw new Error(`invalid_pilot_hybrid_strict_multiplier_schedule:${raw || "empty"}`);
        })(),
    strictTenor: isBullishLockedProfile,
    fixedDrawdownFloorPctByTier: {
      "Pro (Bronze)": 0.2,
      "Pro (Silver)": 0.15,
      "Pro (Gold)": 0.12,
      "Pro (Platinum)": 0.12
    }
  },
  nextRequestId: () => randomUUID()
};

export const isPilotAdminConfigured = (): boolean =>
  Boolean(pilotConfig.adminToken) && pilotConfig.adminIpAllowlist.entries.length > 0;

