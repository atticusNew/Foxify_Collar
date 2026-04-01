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

export type PriceSource = "reference_oracle" | "fallback_oracle";

export type VenueExecutionStatus = "success" | "failure";
export type VenueName = "falconx" | "deribit_test" | "mock_falconx" | "ibkr_cme_live" | "ibkr_cme_paper";
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

