export type ProtectionStatus =
  | "pending_activation"
  | "activation_failed"
  | "active"
  | "triggered"
  | "reconcile_pending"
  | "awaiting_renew_decision"
  | "awaiting_expiry_price"
  | "expired_itm"
  | "expired_otm"
  | "cancelled";

export type LedgerEntryType =
  | "premium_due"
  | "premium_settled"
  | "trigger_payout_due"
  | "payout_due"
  | "payout_settled";

export type PriceSnapshotType = "entry" | "expiry" | "trigger";

export type PriceSource = "reference_oracle" | "fallback_oracle" | "bullish_orderbook_mid";

export type VenueExecutionStatus = "success" | "failure";
export type VenueName =
  | "falconx"
  | "deribit_test"
  | "mock_falconx"
  | "ibkr_cme_live"
  | "ibkr_cme_paper"
  | "bullish_testnet";
export type HedgeMode = "options_native" | "futures_synthetic";

export type ProtectionType = "long" | "short";
export type PremiumPolicyMode = "legacy" | "pass_through_markup";

export type PremiumPolicyComponentBreakdown = {
  hedgeCostUsd: string;
  brokerFeesUsd: string;
  passThroughUsd: string;
  markupPct: string;
  markupUsd: string;
  clientPremiumUsd: string;
};

export type PremiumPolicyCaps = {
  maxHedgeCostUsd: string;
  maxBrokerFeesUsd: string;
  maxClientPremiumUsd: string;
  toleranceUsd: string;
};

export type PremiumPolicyDelta = {
  clientPremiumUsd: string;
  clientPremiumPct: string;
};

export type PremiumPolicyDiagnostics = {
  mode: PremiumPolicyMode;
  version: string;
  currency: "USD";
  estimated: PremiumPolicyComponentBreakdown;
  realized: PremiumPolicyComponentBreakdown | null;
  caps: PremiumPolicyCaps;
  delta?: PremiumPolicyDelta | null;
};

export type TenorPolicyReason =
  | "insufficient_samples"
  | "ok_rate_below_min"
  | "options_native_rate_below_min"
  | "premium_ratio_above_max"
  | "drift_above_max"
  | "negative_matched_tenor_rate_above_max"
  | "tenor_clamped_by_backend_bounds"
  | "policy_data_unavailable";

export type TenorPolicyTenorRow = {
  tenorDays: number;
  sampleCount: number;
  metrics: {
    okRate: number;
    optionsNativeRate: number;
    futuresSyntheticRate: number;
    medianPremiumRatio: number | null;
    medianDriftDays: number | null;
    negativeMatchedTenorRate: number;
    medianMatchedTenorDays: number | null;
  };
  score: number | null;
  eligible: boolean;
  reasons: TenorPolicyReason[];
};

export type TenorPolicyEntry = TenorPolicyTenorRow;

export type TenorPolicyResponse = {
  status: "ok" | "error";
  asOf?: string;
  policyVersion?: string;
  window?: {
    lookbackMinutes: number;
    minSamplesPerTenor: number;
  };
  config?: {
    candidateTenorsDays: number[];
    thresholds: {
      minOkRate: number;
      minOptionsNativeRate: number;
      maxMedianPremiumRatio: number;
      maxMedianDriftDays: number;
      maxNegativeMatchedTenorRate: number;
    };
    enforce: boolean;
    autoRoute: boolean;
    defaultFallbackTenorDays: number;
  };
  selection?: {
    enabledTenorsDays: number[];
    defaultTenorDays: number;
    status: "ok" | "degraded";
  };
  tenors?: TenorPolicyTenorRow[];
  reason?: string;
  message?: string;
  detail?: string;
};

export type PriceSnapshotRecord = {
  id: string;
  protectionId: string;
  snapshotType: PriceSnapshotType;
  price: string;
  marketId: string;
  priceSource: PriceSource;
  priceSourceDetail: string;
  endpointVersion: string;
  requestId: string;
  priceTimestamp: string;
  createdAt: string;
};

export type ProtectionRecord = {
  id: string;
  userHash: string;
  hashVersion: number;
  status: ProtectionStatus;
  tierName: string | null;
  drawdownFloorPct: string | null;
  floorPrice: string | null;
  marketId: string;
  protectedNotional: string;
  entryPrice: string | null;
  entryPriceSource: string | null;
  entryPriceTimestamp: string | null;
  expiryAt: string;
  expiryPrice: string | null;
  expiryPriceSource: string | null;
  expiryPriceTimestamp: string | null;
  autoRenew: boolean;
  renewWindowMinutes: number;
  venue: string | null;
  instrumentId: string | null;
  side: string | null;
  size: string | null;
  executionPrice: string | null;
  premium: string | null;
  executedAt: string | null;
  externalOrderId: string | null;
  externalExecutionId: string | null;
  payoutDueAmount: string | null;
  payoutSettledAmount: string | null;
  payoutSettledAt: string | null;
  payoutTxRef: string | null;
  foxifyExposureNotional: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type VenueQuote = {
  venue: VenueName;
  quoteId: string;
  rfqId?: string | null;
  instrumentId: string;
  side: "buy";
  quantity: number;
  premium: number;
  expiresAt: string;
  quoteTs: string;
  details?: Record<string, unknown>;
};

export type VenueExecution = {
  venue: VenueName;
  status: VenueExecutionStatus;
  quoteId: string;
  rfqId?: string | null;
  instrumentId: string;
  side: "buy";
  quantity: number;
  executionPrice: number;
  premium: number;
  executedAt: string;
  externalOrderId: string;
  externalExecutionId: string;
  details?: Record<string, unknown>;
};

export type SimPositionStatus = "open" | "closed" | "triggered";

export type SimTreasuryEntryType = "premium_collected" | "trigger_credit";

export type SimPositionRecord = {
  id: string;
  userHash: string;
  hashVersion: number;
  status: SimPositionStatus;
  marketId: string;
  side: ProtectionType;
  notionalUsd: string;
  entryPrice: string;
  tierName: string | null;
  drawdownFloorPct: string | null;
  floorPrice: string | null;
  protectionEnabled: boolean;
  protectionId: string | null;
  protectionPremiumUsd: string | null;
  protectedLossUsd: string | null;
  triggerCreditedUsd: string;
  triggerCreditedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type SimTreasuryLedgerRecord = {
  id: string;
  simPositionId: string;
  userHash: string;
  protectionId: string | null;
  entryType: SimTreasuryEntryType;
  amountUsd: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type HedgeSelectionRegime = "calm" | "neutral" | "stress";

export type HedgeCandidate = {
  candidateId: string;
  hedgeMode: HedgeMode;
  hedgeInstrumentFamily: "MBT" | "BFF";
  strike: number | null;
  triggerPrice: number | null;
  strikeGapToTriggerPct: number | null;
  tenorDays: number | null;
  tenorDriftDays: number | null;
  belowTargetTenor: boolean;
  ask: number;
  bid: number | null;
  askSize: number | null;
  spreadPct: number | null;
  premiumUsd: number;
  premiumRatio: number;
  expectedTriggerCostUsd: number;
  expectedTriggerCreditUsd: number;
  premiumProfitabilityTargetUsd: number;
  expectedSubsidyUsd: number;
  liquidityPenalty: number;
  carryPenalty: number;
  basisPenalty: number;
  fillRiskPenalty: number;
  tailProtectionScore: number;
};

export type HedgeScoreBreakdown = {
  totalScore: number;
  normalized: {
    expectedSubsidy: number;
    cvar95Proxy: number;
    liquidityPenalty: number;
    fillRiskPenalty: number;
    basisPenalty: number;
    carryPenalty: number;
    pnlReward: number;
    mtpdReward: number;
    tenorDriftPenalty: number;
    strikeDistancePenalty: number;
  };
  weighted: {
    expectedSubsidy: number;
    cvar95Proxy: number;
    liquidityPenalty: number;
    fillRiskPenalty: number;
    basisPenalty: number;
    carryPenalty: number;
    pnlReward: number;
    mtpdReward: number;
    tenorDriftPenalty: number;
    strikeDistancePenalty: number;
  };
};

export type HedgeSelectionDecision = {
  selectedCandidateId: string;
  regime: HedgeSelectionRegime;
  reason: string;
  score: HedgeScoreBreakdown;
  topAlternatives: Array<{
    candidateId: string;
    score: number;
    hedgeMode: HedgeMode;
    strike: number | null;
    tenorDays: number | null;
  }>;
};

export type MarketLiquiditySnapshot = {
  asOfIso: string;
  spreadPct: number | null;
  topAskSize: number | null;
  topBidSize: number | null;
  staleTopMs: number | null;
  depthScore: number | null;
};

export type GreeksSnapshot = {
  asOfIso: string;
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
  iv: number | null;
  skew: number | null;
};

export type HedgeOptimizerNormalizationRanges = {
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

export type HedgeOptimizerWeights = {
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

export type HedgeOptimizerHardConstraints = {
  maxPremiumRatio: number;
  maxSpreadPct: number;
  minAskSize: number;
  maxTenorDriftDays: number;
  minTailProtectionScore: number;
  maxExpectedSubsidyUsd: number;
};

export type HedgeOptimizerRegimePolicy = {
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

export type HedgeOptimizerConfig = {
  enabled: boolean;
  version: string;
  normalization: HedgeOptimizerNormalizationRanges;
  weights: HedgeOptimizerWeights;
  hardConstraints: HedgeOptimizerHardConstraints;
  regimePolicy: HedgeOptimizerRegimePolicy;
};

export type RolloutGuardConfig = {
  fallbackTriggerHitRatePct: number;
  fallbackSubsidyUtilizationPct: number;
  fallbackTreasuryDrawdownPct: number;
  pauseTriggerHitRatePct: number;
  pauseSubsidyUtilizationPct: number;
  pauseTreasuryDrawdownPct: number;
  pauseOnBlockedSubsidy: boolean;
};

export type OptionsChainSnapshotRecord = {
  id: string;
  source: string;
  venue: string;
  marketId: string;
  instrumentId: string;
  tsIso: string;
  expiryIso: string | null;
  strike: string | null;
  right: "P" | "C" | null;
  bid: string | null;
  ask: string | null;
  mark: string | null;
  iv: string | null;
  delta: string | null;
  gamma: string | null;
  vega: string | null;
  theta: string | null;
  openInterest: string | null;
  bidSize: string | null;
  askSize: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type RfqQuoteHistoryRecord = {
  id: string;
  source: string;
  venue: string;
  rfqId: string | null;
  quoteId: string | null;
  marketId: string;
  instrumentId: string | null;
  side: "buy" | "sell" | null;
  quantity: string | null;
  premium: string | null;
  quoteTsIso: string;
  expiresAtIso: string | null;
  status: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type RfqFillHistoryRecord = {
  id: string;
  source: string;
  venue: string;
  rfqId: string | null;
  quoteId: string | null;
  fillId: string | null;
  marketId: string;
  instrumentId: string | null;
  side: "buy" | "sell" | null;
  quantity: string | null;
  executionPrice: string | null;
  premium: string | null;
  executedAtIso: string;
  slippageBps: string | null;
  latencyMs: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type HedgeDecisionRecord = {
  id: string;
  decisionTsIso: string;
  requestId: string | null;
  venueMode: string;
  selectorMode: string;
  regime: string | null;
  selectedCandidateId: string | null;
  selectedHedgeMode: string | null;
  selectedInstrumentFamily: string | null;
  selectedStrike: string | null;
  selectedTenorDays: string | null;
  selectedScore: string | null;
  reason: string | null;
  candidates: unknown[];
  scoreBreakdown: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type ExecutionQualityDailyRecord = {
  dayStart: string;
  venue: string;
  hedgeMode: HedgeMode;
  tradesCount: number;
  fillsCount: number;
  meanSlippageBps: string;
  p95SlippageBps: string;
  meanLatencyMs: string;
  p95LatencyMs: string;
  optionFillRate: string;
  futuresFillRate: string;
  metadata: Record<string, unknown>;
  updatedAt: string;
};

export type VenueQuoteRecord = {
  day: string;
  venue: string;
  quoteId: string;
  rfqId: string | null;
  marketId: string;
  instrumentId: string | null;
  side: "buy" | "sell";
  quantity: string;
  quotePxUsd: string;
  quoteTs: string;
  expiresTs: string | null;
  source: string | null;
  metadata: Record<string, unknown>;
};

export type VenueFillRecord = {
  day: string;
  venue: string;
  fillId: string;
  quoteId: string | null;
  rfqId: string | null;
  marketId: string;
  instrumentId: string | null;
  side: "buy" | "sell";
  quantity: string;
  fillPxUsd: string;
  fillTs: string;
  feeUsd: string | null;
  slippageBps: string | null;
  source: string | null;
  metadata: Record<string, unknown>;
};

export type ExecutionQualityRecord = {
  day: string;
  venue: string;
  hedgeMode: HedgeMode;
  avgSlippageBps: string | null;
  p95SlippageBps: string | null;
  fillSuccessRatePct: string | null;
  avgSpreadPct: string | null;
  avgTopBookDepth: string | null;
  sampleCount: number;
  metadata: Record<string, unknown>;
  updatedAt: string;
};

