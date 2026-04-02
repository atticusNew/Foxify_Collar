import Decimal from "decimal.js";
import { pilotConfig } from "./config";
import { computeDrawdownLossBudgetUsd } from "./protectionMath";

export type PricingMode = "actuarial_strict" | "hybrid_otm_treasury";
export type PremiumPolicyMode = "legacy" | "pass_through_markup";

export type PremiumMethod =
  | "markup"
  | "floor_usd"
  | "floor_bps"
  | "floor_trigger_credit"
  | "floor_profitability"
  | "hybrid_markup"
  | "hybrid_position_floor"
  | "hybrid_claims_floor";

export type PremiumPricingBreakdown = {
  hedgePremiumUsd: Decimal;
  brokerFeesUsd: Decimal;
  passThroughUsd: Decimal;
  markupPct: Decimal;
  markupUsd: Decimal;
  premiumFloorUsdAbsolute: Decimal;
  premiumFloorUsdFromBps: Decimal;
  premiumFloorBps: Decimal;
  premiumFloorUsd: Decimal;
  premiumFloorUsdTriggerCredit: Decimal;
  expectedTriggerCreditUsd: Decimal;
  expectedTriggerCostUsd: Decimal;
  profitabilityBufferUsd: Decimal;
  profitabilityFloorUsd: Decimal;
  selectionFeasibilityPenaltyUsd: Decimal;
  premiumProfitabilityTargetUsd: Decimal;
  premiumProfitabilityTargetRatio: Decimal;
  positionFloorUsd: Decimal;
  claimsFloorUsd: Decimal;
  expectedTriggerProbRaw: Decimal;
  expectedTriggerProbCapped: Decimal;
  expectedClaimsUsd: Decimal;
  markupPremiumUsd: Decimal;
  clientPremiumUsd: Decimal;
  method: PremiumMethod;
  pricingMode: PricingMode;
};

export type PricingPolicyConfig = {
  mode: PricingMode;
  premiumPolicyMode: PremiumPolicyMode;
  premiumMarkupPct: Decimal;
  premiumFloorUsd: Decimal;
  premiumFloorBps: Decimal;
  triggerCreditFloorPct: Decimal;
  expectedTriggerBreachProb: Decimal;
  triggerCreditWeight: Decimal;
  profitabilityBufferPct: Decimal;
  baseFeeUsd: Decimal;
  markupFactor: Decimal;
  claimsCoverageFactor: Decimal;
  triggerProbCap: Decimal;
  notionalBands: Array<{ maxNotionalUsd: Decimal | null; floorUsd: Decimal }>;
  selectionFeasibilityPenaltyScale: Decimal;
};

const resolveTierPremiumFloorBps = (tierName: string): Decimal => {
  const raw = Number(pilotConfig.premiumFloorBpsByTier[tierName] ?? 100);
  if (!Number.isFinite(raw) || raw < 0) return new Decimal(0);
  return new Decimal(raw);
};

const resolveTierPremiumFloorUsd = (tierName: string): Decimal => {
  const raw = Number(pilotConfig.premiumFloorUsdByTier[tierName] ?? 0);
  if (!Number.isFinite(raw) || raw < 0) return new Decimal(0);
  return new Decimal(raw);
};

const resolveTierProfitabilityBufferPct = (tierName: string): Decimal => {
  const raw = Number(pilotConfig.premiumProfitabilityBufferPctByTier[tierName] ?? 0);
  if (!Number.isFinite(raw) || raw < 0) return new Decimal(0);
  return new Decimal(raw);
};

const resolveTierExpectedTriggerBreachProb = (tierName: string): Decimal => {
  const raw = Number(pilotConfig.premiumExpectedTriggerBreachProbByTier[tierName] ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return new Decimal(0);
  return Decimal.min(new Decimal(1), new Decimal(raw));
};

const resolveTierTriggerCreditWeight = (tierName: string): Decimal => {
  const raw = Number(pilotConfig.premiumTriggerCreditWeightByTier[tierName] ?? 0);
  if (!Number.isFinite(raw) || raw < 0) return new Decimal(0);
  return Decimal.min(new Decimal(1), new Decimal(raw));
};

const resolveTierTriggerCreditFloorPct = (tierName: string): Decimal => {
  const raw = Number(pilotConfig.premiumTriggerCreditFloorPctByTier[tierName] ?? 0);
  if (!Number.isFinite(raw) || raw < 0) return new Decimal(0);
  return Decimal.min(new Decimal(1), new Decimal(raw));
};

const resolveTierMarkupPct = (tierName: string): Decimal => {
  const raw = Number(pilotConfig.premiumMarkupPctByTier[tierName] ?? pilotConfig.premiumMarkupPct);
  return Number.isFinite(raw) && raw > 0 ? new Decimal(raw) : new Decimal(0);
};

export const resolvePricingPolicyMode = (raw: string | undefined): PricingMode => {
  const normalized = String(raw || "actuarial_strict").trim().toLowerCase();
  if (normalized === "hybrid_otm_treasury" || normalized === "actuarial_strict") {
    return normalized;
  }
  return "actuarial_strict";
};

const resolvePricingMode = (): PricingMode => {
  const raw = String(process.env.PILOT_PREMIUM_PRICING_MODE || "actuarial_strict").trim().toLowerCase();
  return raw === "hybrid_otm_treasury" ? "hybrid_otm_treasury" : "actuarial_strict";
};

const parsePositiveFiniteWithDefault = (value: unknown, fallback: Decimal): Decimal => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return new Decimal(parsed);
};

export const resolveDefaultPricingPolicyConfig = (params: {
  policyMode: PremiumPolicyMode;
  pricingMode: PricingMode;
  markupPct: number;
  floorUsd: number;
  floorBps: number;
  triggerCreditFloorPct: number;
  expectedTriggerBreachProb: number;
  triggerCreditWeight: number;
  profitabilityBufferPct: number;
  selectionFeasibilityPenaltyScale?: number;
}): PricingPolicyConfig => ({
  mode: params.pricingMode,
  premiumPolicyMode: params.policyMode,
  premiumMarkupPct: parsePositiveFiniteWithDefault(params.markupPct, new Decimal("0.06")),
  premiumFloorUsd: new Decimal(Number.isFinite(params.floorUsd) && params.floorUsd >= 0 ? params.floorUsd : 20),
  premiumFloorBps: new Decimal(Number.isFinite(params.floorBps) && params.floorBps >= 0 ? params.floorBps : 6),
  triggerCreditFloorPct: new Decimal(
    Number.isFinite(params.triggerCreditFloorPct) && params.triggerCreditFloorPct >= 0
      ? params.triggerCreditFloorPct
      : 0.03
  ),
  expectedTriggerBreachProb: new Decimal(
    Number.isFinite(params.expectedTriggerBreachProb) && params.expectedTriggerBreachProb >= 0
      ? params.expectedTriggerBreachProb
      : 0.25
  ),
  triggerCreditWeight: new Decimal(
    Number.isFinite(params.triggerCreditWeight) && params.triggerCreditWeight >= 0 ? params.triggerCreditWeight : 0.35
  ),
  profitabilityBufferPct: new Decimal(
    Number.isFinite(params.profitabilityBufferPct) && params.profitabilityBufferPct >= 0
      ? params.profitabilityBufferPct
      : 0.015
  ),
  baseFeeUsd: Decimal.max(new Decimal(0), new Decimal(pilotConfig.hybridBaseFeeUsd)),
  markupFactor: parsePositiveFiniteWithDefault(pilotConfig.hybridMarkupFactor, new Decimal("1.5")),
  claimsCoverageFactor: Decimal.min(
    new Decimal(1),
    Decimal.max(new Decimal(0), new Decimal(pilotConfig.hybridClaimsCoverageFactor))
  ),
  triggerProbCap: Decimal.min(new Decimal(1), Decimal.max(new Decimal(0), new Decimal(pilotConfig.hybridTriggerProbCap))),
  notionalBands: [
    { maxNotionalUsd: new Decimal("1500"), floorUsd: new Decimal("10") },
    { maxNotionalUsd: new Decimal("3000"), floorUsd: new Decimal("15") },
    { maxNotionalUsd: new Decimal("6000"), floorUsd: new Decimal("20") },
    { maxNotionalUsd: new Decimal("10000"), floorUsd: new Decimal("25") },
    { maxNotionalUsd: null, floorUsd: new Decimal("35") }
  ],
  selectionFeasibilityPenaltyScale: parsePositiveFiniteWithDefault(
    params.selectionFeasibilityPenaltyScale,
    new Decimal(1)
  )
});

const resolvePositionFloorUsdForConfig = (notionalUsd: Decimal, config: PricingPolicyConfig): Decimal => {
  for (const band of config.notionalBands) {
    if (band.maxNotionalUsd === null || notionalUsd.lt(band.maxNotionalUsd)) {
      return band.floorUsd;
    }
  }
  return new Decimal(35);
};

export const resolvePremiumPricing = (params: {
  pricingMode?: PricingMode;
  tierName: string;
  protectedNotional: Decimal;
  drawdownFloorPct: Decimal;
  hedgePremium: Decimal;
  brokerFees?: Decimal;
  markupPctOverride?: Decimal | null;
  config?: PricingPolicyConfig;
}): PremiumPricingBreakdown => {
  const mode = params.pricingMode || params.config?.mode || resolvePricingMode();
  const config =
    params.config ||
    resolveDefaultPricingPolicyConfig({
      policyMode: pilotConfig.premiumPolicyMode,
      pricingMode: mode,
      markupPct: Number(pilotConfig.premiumMarkupPctByTier[params.tierName] ?? pilotConfig.premiumMarkupPct),
      floorUsd: Number(pilotConfig.premiumFloorUsdByTier[params.tierName] ?? 20),
      floorBps: Number(pilotConfig.premiumFloorBpsByTier[params.tierName] ?? 6),
      triggerCreditFloorPct: Number(pilotConfig.premiumTriggerCreditFloorPctByTier[params.tierName] ?? 0.03),
      expectedTriggerBreachProb: Number(
        pilotConfig.premiumExpectedTriggerBreachProbByTier[params.tierName] ?? 0.25
      ),
      triggerCreditWeight: Number(pilotConfig.premiumTriggerCreditWeightByTier[params.tierName] ?? 0.35),
      profitabilityBufferPct: Number(pilotConfig.premiumProfitabilityBufferPctByTier[params.tierName] ?? 0.015),
      selectionFeasibilityPenaltyScale: 1
    });
  const hedgePremiumUsd = params.hedgePremium;
  const brokerFeesUsd = params.brokerFees || new Decimal(0);
  const passThroughUsd =
    config.premiumPolicyMode === "pass_through_markup"
      ? hedgePremiumUsd.plus(brokerFeesUsd)
      : hedgePremiumUsd;
  const markupPct = params.markupPctOverride || config.premiumMarkupPct;
  const markupUsd = passThroughUsd.mul(markupPct);
  const markedUpPremium = passThroughUsd.plus(markupUsd);
  const triggerCreditUsd = computeDrawdownLossBudgetUsd(params.protectedNotional, params.drawdownFloorPct);
  const expectedTriggerProbRaw = config.expectedTriggerBreachProb;
  const expectedTriggerProbCapped =
    mode === "hybrid_otm_treasury"
      ? Decimal.min(expectedTriggerProbRaw, config.triggerProbCap)
      : expectedTriggerProbRaw;
  const expectedClaimsUsd = triggerCreditUsd.mul(expectedTriggerProbCapped);
  const expectedTriggerCreditUsd = expectedClaimsUsd;
  const triggerCreditWeight = config.triggerCreditWeight;
  const expectedTriggerCostUsd = expectedTriggerCreditUsd.mul(triggerCreditWeight);
  const selectionFeasibilityPenaltyUsd = expectedTriggerCostUsd.mul(config.selectionFeasibilityPenaltyScale);
  const premiumFloorBps = config.premiumFloorBps;
  const premiumFloorUsdFromBps = params.protectedNotional.mul(premiumFloorBps).div(10000);
  const premiumFloorUsdAbsolute = config.premiumFloorUsd;
  const premiumFloorUsdTriggerCredit = triggerCreditUsd.mul(config.triggerCreditFloorPct);
  const profitabilityBufferUsd = params.protectedNotional.mul(config.profitabilityBufferPct);
  const profitabilityFloorUsd = passThroughUsd.plus(selectionFeasibilityPenaltyUsd).plus(profitabilityBufferUsd);
  const premiumProfitabilityTargetUsd = profitabilityFloorUsd;
  const premiumProfitabilityTargetRatio =
    params.protectedNotional.gt(0)
      ? premiumProfitabilityTargetUsd.div(params.protectedNotional)
      : new Decimal(0);
  const positionFloorUsd = resolvePositionFloorUsdForConfig(params.protectedNotional, config);
  const claimsFloorUsd = expectedClaimsUsd.mul(config.claimsCoverageFactor);

  if (mode === "hybrid_otm_treasury") {
    const markupFactor = config.markupFactor;
    const baseFeeUsd = config.baseFeeUsd;
    const hybridMarkupPremium = passThroughUsd.mul(markupFactor).plus(baseFeeUsd);
    const clientPremiumUsd = Decimal.max(hybridMarkupPremium, positionFloorUsd, claimsFloorUsd);
    const method: PremiumMethod = clientPremiumUsd.eq(hybridMarkupPremium)
      ? "hybrid_markup"
      : clientPremiumUsd.eq(positionFloorUsd)
        ? "hybrid_position_floor"
        : "hybrid_claims_floor";
    return {
      hedgePremiumUsd,
      brokerFeesUsd,
      passThroughUsd,
      markupPct,
      markupUsd,
      premiumFloorUsdAbsolute,
      premiumFloorUsdFromBps,
      premiumFloorBps,
      premiumFloorUsd: Decimal.max(positionFloorUsd, claimsFloorUsd),
      premiumFloorUsdTriggerCredit,
      expectedTriggerCreditUsd,
      expectedTriggerCostUsd,
      profitabilityBufferUsd,
      profitabilityFloorUsd,
      selectionFeasibilityPenaltyUsd,
      premiumProfitabilityTargetUsd,
      premiumProfitabilityTargetRatio,
      positionFloorUsd,
      claimsFloorUsd,
      expectedTriggerProbRaw,
      expectedTriggerProbCapped,
      expectedClaimsUsd,
      markupPremiumUsd: hybridMarkupPremium,
      clientPremiumUsd,
      method,
      pricingMode: mode
    };
  }

  const premiumFloorUsd = Decimal.max(
    premiumFloorUsdAbsolute,
    premiumFloorUsdFromBps,
    premiumFloorUsdTriggerCredit,
    profitabilityFloorUsd
  );
  const clientPremiumUsd = Decimal.max(markedUpPremium, premiumFloorUsd);
  const method: PremiumMethod = clientPremiumUsd.eq(markedUpPremium)
    ? "markup"
    : premiumFloorUsd.eq(profitabilityFloorUsd)
      ? "floor_profitability"
      : premiumFloorUsd.eq(premiumFloorUsdTriggerCredit)
        ? "floor_trigger_credit"
        : premiumFloorUsdAbsolute.greaterThanOrEqualTo(premiumFloorUsdFromBps)
          ? "floor_usd"
          : "floor_bps";
  return {
    hedgePremiumUsd,
    brokerFeesUsd,
    passThroughUsd,
    markupPct,
    markupUsd,
    premiumFloorUsdAbsolute,
    premiumFloorUsdFromBps,
    premiumFloorBps,
    premiumFloorUsd,
    premiumFloorUsdTriggerCredit,
    expectedTriggerCreditUsd,
    expectedTriggerCostUsd,
    profitabilityBufferUsd,
    profitabilityFloorUsd,
    selectionFeasibilityPenaltyUsd,
    premiumProfitabilityTargetUsd,
    premiumProfitabilityTargetRatio,
    positionFloorUsd,
    claimsFloorUsd,
    expectedTriggerProbRaw,
    expectedTriggerProbCapped,
    expectedClaimsUsd,
    markupPremiumUsd: markedUpPremium,
    clientPremiumUsd,
    method,
    pricingMode: mode
  };
};

export type PremiumPricingResult = PremiumPricingBreakdown;

export const estimateBrokerFeesUsd = (params: {
  venue: string;
  quantity: number;
  details?: Record<string, unknown>;
}): Decimal => {
  if (!String(params.venue || "").startsWith("ibkr_")) return new Decimal(0);
  const rawMultiplier = Number(params.details?.multiplier ?? 0);
  const multiplier = Number.isFinite(rawMultiplier) && rawMultiplier > 0 ? rawMultiplier : 0.1;
  const contracts = Math.max(1, Math.ceil(Math.max(0, Number(params.quantity || 0)) / multiplier));
  return new Decimal(contracts)
    .mul(new Decimal(pilotConfig.ibkrFeePerContractUsd))
    .plus(new Decimal(pilotConfig.ibkrFeePerOrderUsd));
};

export const buildPremiumPolicyDiagnostics = (params: {
  estimated: PremiumPricingResult;
  realized?: PremiumPricingResult | null;
}) => {
  const tolerance = new Decimal(pilotConfig.premiumCapToleranceUsd);
  const estimated = params.estimated;
  const realized = params.realized || null;
  const caps = {
    maxHedgeCostUsd: estimated.hedgePremiumUsd.plus(tolerance).toFixed(10),
    maxBrokerFeesUsd: estimated.brokerFeesUsd.plus(tolerance).toFixed(10),
    maxClientPremiumUsd: estimated.clientPremiumUsd.plus(tolerance).toFixed(10),
    toleranceUsd: tolerance.toFixed(10)
  };
  const delta =
    realized && estimated.clientPremiumUsd.gt(0)
      ? {
          clientPremiumUsd: realized.clientPremiumUsd.minus(estimated.clientPremiumUsd).toFixed(10),
          clientPremiumPct: realized.clientPremiumUsd
            .minus(estimated.clientPremiumUsd)
            .div(estimated.clientPremiumUsd)
            .toFixed(10)
        }
      : null;
  const toComponent = (breakdown: PremiumPricingResult) => ({
    hedgeCostUsd: breakdown.hedgePremiumUsd.toFixed(10),
    brokerFeesUsd: breakdown.brokerFeesUsd.toFixed(10),
    passThroughUsd: breakdown.passThroughUsd.toFixed(10),
    markupPct: breakdown.markupPct.toFixed(10),
    markupUsd: breakdown.markupUsd.toFixed(10),
    clientPremiumUsd: breakdown.clientPremiumUsd.toFixed(10)
  });
  return {
    mode: pilotConfig.premiumPolicyMode,
    version: pilotConfig.premiumPolicyVersion,
    currency: "USD" as const,
    estimated: toComponent(estimated),
    realized: realized ? toComponent(realized) : null,
    caps,
    delta
  };
};
