import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import Decimal from "decimal.js";
import { randomUUID } from "node:crypto";
import { DeribitConnector, IbkrConnector } from "@foxify/connectors";
import { buildUserHash } from "./hash";
import { pilotConfig, resolvePilotWindow, type PilotPricingMode } from "./config";
import { PilotMonitor, parseMonitorConfig } from "./monitor";
import {
  archiveProtectionsByUserHashExcept,
  creditSimPositionForTrigger,
  createPilotTermsAcceptanceIfMissing,
  extractLatestPremiumPolicyDiagnostics,
  ensurePilotSchema,
  getDailyProtectedNotionalForUser,
  getDailyTreasurySubsidyUsageForUser,
  getEssentialProofPayload,
  getPilotAdminMetrics,
  getPilotTermsAcceptance,
  getPilotPool,
  getProtection,
  getSimPosition,
  getVenueQuoteByQuoteIdForUpdate,
  insertAdminAction,
  consumeVenueQuote,
  insertLedgerEntry,
  insertPriceSnapshot,
  insertProtection,
  insertVenueExecution,
  insertVenueQuote,
  listRecentTenorPolicyRows,
  listLedgerForProtection,
  listProtectionsByUserHashForAdmin,
  listProtectionsByUserHash,
  listSimOpenProtectedPositionsByUserHash,
  listSimPositionsByUserHash,
  listSimTreasuryLedgerByUserHash,
  listExecutionQualityRecent,
  listRecentQuoteDiagnostics,
  patchSimPosition,
  upsertExecutionQualityDaily,
  reserveDailyTreasurySubsidyCapacity,
  releaseDailyTreasurySubsidyCapacity,
  reserveDailyActivationCapacity,
  releaseDailyActivationCapacity,
  patchProtection,
  insertSimPosition,
  insertSimTreasuryLedgerEntry,
  getSimPlatformMetrics
} from "./db";
import { resolvePriceSnapshot, type PriceSnapshotOutput } from "./price";
import { createPilotVenueAdapter, mapVenueFailureReason } from "./venue";
import { registerPilotTriggerMonitor } from "./triggerMonitor";
import { runAutoRenewCycle } from "./autoRenew";
import {
  buildPremiumPolicyDiagnostics,
  estimateBrokerFeesUsd,
  resolvePilotRoundedPremiumDisplay,
  resolvePremiumPricing,
  type PremiumPricingResult
} from "./pricingPolicy";
import {
  applyPremiumRegimeOverlay,
  resolvePremiumRegime,
  type PremiumRegimeMetrics
} from "./premiumRegime";
import {
  computeTriggerPrice,
  computePayoutDue,
  normalizeProtectionType,
  normalizeTierName,
  resolveDrawdownFloorPct,
  resolveExpiryDays,
  resolveRenewWindowMinutes,
  slPctToTierName
} from "./floor";
import { computeDrawdownLossBudgetUsd } from "./protectionMath";
import type { PremiumPolicyDiagnostics, TenorPolicyEntry, TenorPolicyResponse, TenorPolicyTenorRow, TenorPolicyReason } from "./types";
import { isValidSlTier, computeV7Premium, slPctToDrawdownFloor, slPctToTierLabel, getV7AvailableTiers, getV7TenorDays } from "./v7Pricing";
import { getCurrentRegime, configureRegimeClassifier } from "./regimeClassifier";
import type { V7SlTier, V7PremiumQuote } from "./types";

const deriveHedgeMode = (quoteDetails?: Record<string, unknown>): "options_native" | "futures_synthetic" => {
  const raw = String(quoteDetails?.hedgeMode || "");
  return raw === "futures_synthetic" ? "futures_synthetic" : "options_native";
};

const resolveTenorReason = (params: {
  requestedTenorDays: number;
  venueRequestedTenorDays: number;
  selectedTenorDays: number | null;
  policyFallbackApplied: boolean;
  policyFallbackReason: string | null;
}): "tenor_exact" | "tenor_within_2d" | "tenor_fallback_policy" | "tenor_fallback_liquidity" => {
  const selected = params.selectedTenorDays ?? params.venueRequestedTenorDays;
  const drift = Math.abs(selected - params.requestedTenorDays);
  if (drift <= 0.5) return "tenor_exact";
  if (drift <= 2) return "tenor_within_2d";
  if (params.policyFallbackApplied || Boolean(params.policyFallbackReason)) return "tenor_fallback_policy";
  return "tenor_fallback_liquidity";
};

const getRequestIp = (req: FastifyRequest): string => {
  // Prefer Fastify-resolved client IP; optionally honor a trusted proxy header for deployments behind edge proxies.
  const trustedHeader = String(process.env.PILOT_ADMIN_TRUSTED_IP_HEADER || "").trim().toLowerCase();
  if (trustedHeader) {
    const raw = req.headers[trustedHeader as keyof typeof req.headers];
    const headerValue = Array.isArray(raw) ? raw[0] : raw;
    if (typeof headerValue === "string" && headerValue.trim()) {
      const forwarded = headerValue.split(",")[0]?.trim();
      if (forwarded) return forwarded;
    }
  }
  return req.ip;
};

const parseBoolean = (value: unknown, fallback = false): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
};

const parsePositiveDecimal = (value: unknown): Decimal | null => {
  try {
    const parsed = new Decimal(value as Decimal.Value);
    if (!parsed.isFinite() || parsed.lte(0)) return null;
    return parsed;
  } catch {
    return null;
  }
};

const parseBoundedDecimal = (value: unknown, min: Decimal.Value, max: Decimal.Value): Decimal | null => {
  try {
    const parsed = new Decimal(value as Decimal.Value);
    if (!parsed.isFinite()) return null;
    if (parsed.lt(min) || parsed.gt(max)) return null;
    return parsed;
  } catch {
    return null;
  }
};

const resolveReferenceVenueLabel = (url: string, fallbackLabel = "Reference Feed"): string => {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes("coinbase")) return "Coinbase";
    if (hostname.includes("deribit")) return "Deribit";
    if (hostname.includes("falconx")) return "FalconX";
    return hostname.replace(/^www\./, "") || fallbackLabel;
  } catch {
    return fallbackLabel;
  }
};


const toFixedString = (value: Decimal.Value, dp = 10): string => new Decimal(value).toFixed(dp);

const toFiniteNumber = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const resolveQuoteMinNotionalFloor = (): Decimal => new Decimal(pilotConfig.quoteMinNotionalUsdc);
const isLockedBullishProfile = pilotConfig.lockedProfile.name === "bullish_locked_v1";
const lockedProfileTenorDays = pilotConfig.lockedProfile.fixedTenorDays;
const lockedProfilePricingMode: PilotPricingMode = pilotConfig.lockedProfile.fixedPricingMode;
const SIM_DAYS = 7;
const DEFAULT_SIM_STARTING_EQUITY_USD = new Decimal(10000);
const PREMIUM_REGIME_SCOPE_KEY = "global";

const buildSimLifecycleMetadata = (base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> => ({
  ...base,
  ...patch
});

const resolveLiveReferencePrice = async (requestId: string, marketId: string): Promise<PriceSnapshotOutput> =>
  withTimeout(
    resolvePriceSnapshot(
      {
        primaryUrl: pilotConfig.referencePriceUrl,
        fallbackUrl: pilotConfig.singlePriceSource ? "" : pilotConfig.fallbackPriceUrl,
        primaryTimeoutMs: pilotConfig.pricePrimaryTimeoutMs,
        fallbackTimeoutMs: pilotConfig.priceFallbackTimeoutMs,
        freshnessMaxMs: pilotConfig.priceFreshnessMaxMs,
        requestRetryAttempts: pilotConfig.priceRequestRetryAttempts,
        requestRetryDelayMs: pilotConfig.priceRequestRetryDelayMs
      },
      {
        marketId,
        now: new Date(),
        requestId,
        endpointVersion: pilotConfig.endpointVersion
      }
    ),
    Math.max(1500, pilotConfig.pricePrimaryTimeoutMs + pilotConfig.priceFallbackTimeoutMs + 1000),
    "price"
  );

const resolveBullishReferencePrice = async (requestId: string, marketId: string): Promise<PriceSnapshotOutput> => {
  const bullishSymbol =
    pilotConfig.bullish.symbolByMarketId[marketId] ||
    (marketId === "BTC-USD" ? "BTCUSDC" : pilotConfig.bullish.defaultSymbol);
  const orderbookPath = pilotConfig.bullish.orderbookPathTemplate.replace(":symbol", encodeURIComponent(bullishSymbol));
  const payload = await withTimeout(
    (async () => {
      const response = await fetch(new URL(orderbookPath, pilotConfig.bullish.restBaseUrl).toString(), {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`bullish_reference_http_${response.status}:${text}`);
      }
      const text = await response.text();
      return text ? (JSON.parse(text) as Record<string, unknown>) : ({} as Record<string, unknown>);
    })(),
    Math.max(1200, pilotConfig.pricePrimaryTimeoutMs),
    "bullish_reference_price"
  );
  const topBid = Number(
    ((payload.bids as Array<Record<string, unknown>> | undefined)?.[0]?.price ??
      (payload.bids as Array<Record<string, unknown>> | undefined)?.[0]?.px ??
      NaN) as number
  );
  const topAsk = Number(
    ((payload.asks as Array<Record<string, unknown>> | undefined)?.[0]?.price ??
      (payload.asks as Array<Record<string, unknown>> | undefined)?.[0]?.px ??
      NaN) as number
  );
  let price: Decimal | null = null;
  if (Number.isFinite(topBid) && topBid > 0 && Number.isFinite(topAsk) && topAsk > 0) {
    price = new Decimal(topBid).plus(topAsk).div(2);
  } else if (Number.isFinite(topAsk) && topAsk > 0) {
    price = new Decimal(topAsk);
  } else if (Number.isFinite(topBid) && topBid > 0) {
    price = new Decimal(topBid);
  }
  if (!price) {
    throw new Error("bullish_reference_no_top_of_book");
  }
  const timestampRaw = String(payload.timestamp || payload.datetime || "");
  const parsedTimestamp = Number(timestampRaw);
  const timestampIso =
    Number.isFinite(parsedTimestamp) && parsedTimestamp > 0
      ? new Date(parsedTimestamp).toISOString()
      : new Date().toISOString();
  return {
    price,
    priceTimestamp: timestampIso,
    marketId,
    priceSource: "bullish_orderbook_mid",
    priceSourceDetail: "bullish_hybrid_orderbook_mid",
    endpointVersion: pilotConfig.endpointVersion,
    requestId
  };
};

const resolveLockedDrawdownFloorPct = (tierName: string): Decimal => {
  if (tierName === "Pro (Silver)") return new Decimal(0.15);
  if (tierName === "Pro (Gold)" || tierName === "Pro (Platinum)") return new Decimal(0.12);
  return new Decimal(0.2);
};

const resolveReferencePriceForPilot = async (requestId: string, marketId: string): Promise<PriceSnapshotOutput> => {
  if (isLockedBullishProfile) {
    return await resolveBullishReferencePrice(requestId, marketId);
  }
  return await resolveLiveReferencePrice(requestId, marketId);
};

const resolveSimStartingEquityUsd = (): Decimal => {
  const raw = Number(process.env.PILOT_SIM_STARTING_EQUITY_USD ?? DEFAULT_SIM_STARTING_EQUITY_USD.toString());
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SIM_STARTING_EQUITY_USD;
  return new Decimal(raw);
};

const runSimTriggerMonitorCycle = async (params: {
  pool: ReturnType<typeof getPilotPool>;
  tenant: { userHash: string; hashVersion: number };
  maxRows?: number;
}): Promise<{ scanned: number; triggered: number }> => {
  const candidates = await listSimOpenProtectedPositionsByUserHash(params.pool, params.tenant.userHash, {
    limit: Math.max(1, Math.min(Number(params.maxRows || 200), 1000))
  });
  let triggered = 0;
  for (const simPosition of candidates) {
    const protectionId = String(simPosition.protectionId || "");
    if (!protectionId) continue;
    const protection = await getProtection(params.pool, protectionId);
    if (!protection) continue;
    const requestId = pilotConfig.nextRequestId();
    let snapshot: PriceSnapshotOutput;
    try {
      snapshot = await resolveLiveReferencePrice(requestId, simPosition.marketId);
    } catch {
      continue;
    }
    const entryPrice = parsePositiveDecimal(simPosition.entryPrice);
    const drawdownFloorPct = parsePositiveDecimal(simPosition.drawdownFloorPct);
    const protectedLossUsd = parsePositiveDecimal(simPosition.protectedLossUsd);
    if (!entryPrice || !drawdownFloorPct || !protectedLossUsd) continue;
    const triggerPrice = parsePositiveDecimal(simPosition.floorPrice) || computeTriggerPrice(entryPrice, drawdownFloorPct, "long");
    const breached = snapshot.price.lessThanOrEqualTo(triggerPrice);
    if (!breached) continue;
    const lifecycle = buildSimLifecycleMetadata(simPosition.metadata || {}, {
      triggerPrice: triggerPrice.toFixed(10),
      triggerReferencePrice: snapshot.price.toFixed(10),
      triggerPriceSource: snapshot.priceSource,
      triggerPriceTimestamp: snapshot.priceTimestamp,
      triggerRequestId: requestId,
      triggerMonitorAt: new Date().toISOString()
    });
    const credited = await creditSimPositionForTrigger(params.pool, {
      id: simPosition.id,
      triggerCreditUsd: protectedLossUsd.toFixed(10),
      metadata: lifecycle
    });
    if (!credited) continue;
    await insertLedgerEntry(params.pool, {
      protectionId,
      entryType: "trigger_payout_due",
      amount: protectedLossUsd.toFixed(10),
      reference: `sim_trigger:${simPosition.id}:${snapshot.priceTimestamp}`
    });
    await insertSimTreasuryLedgerEntry(params.pool, {
      simPositionId: simPosition.id,
      userHash: params.tenant.userHash,
      protectionId,
      entryType: "trigger_credit",
      amountUsd: protectedLossUsd.toFixed(10),
      metadata: {
        requestId,
        referencePrice: snapshot.price.toFixed(10),
        triggerPrice: triggerPrice.toFixed(10),
        priceSource: snapshot.priceSource,
        priceTimestamp: snapshot.priceTimestamp
      }
    });
    triggered += 1;
  }
  return { scanned: candidates.length, triggered };
};

const resolveMedian = (values: number[]): number | null => {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 === 1 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
};

const round6 = (value: number): number => Number(value.toFixed(6));

const resolvePremiumRegimeMetrics = async (
  pool: ReturnType<typeof getPilotPool>,
  userHash: string
): Promise<PremiumRegimeMetrics> => {
  const diagnostics = await listRecentQuoteDiagnostics(pool, {
    lookbackMinutes: pilotConfig.premiumRegime.lookbackMinutes,
    limit: Math.max(200, pilotConfig.premiumRegime.minSamples * 5)
  });
  const sampleCount = diagnostics.length;
  const triggerHits = diagnostics.filter((row) => {
    const ratio = Number(row.premiumRatio ?? 0);
    return Number.isFinite(ratio) && ratio >= 0.02;
  }).length;
  const triggerHitRatePct = sampleCount > 0 ? (triggerHits / sampleCount) * 100 : 0;
  const subsidyUtilizationPct =
    sampleCount > 0
      ? diagnostics.reduce((acc, row) => acc + Number(row.subsidyUtilizationPct || 0), 0) / sampleCount
      : 0;
  let treasuryDrawdownPct =
    sampleCount > 0
      ? diagnostics.reduce((acc, row) => acc + Number(row.treasuryDrawdownPct || 0), 0) / sampleCount
      : 0;
  try {
    const treasurySnapshot = await getPilotAdminMetrics(pool, {
      userHash,
      scope: "open",
      startingReserveUsdc: pilotConfig.startingReserveUsdc
    });
    const startingReserve = toFiniteNumber(treasurySnapshot.startingReserveUsdc) || 0;
    const reserveAfterOpenLiability = toFiniteNumber(treasurySnapshot.reserveAfterOpenPayoutLiabilityUsdc) || 0;
    if (startingReserve > 0) {
      const drawdownNow = ((startingReserve - reserveAfterOpenLiability) / startingReserve) * 100;
      treasuryDrawdownPct = Math.max(0, Math.min(100, drawdownNow));
    }
  } catch {
    // Keep diagnostics-derived fallback when admin metrics are temporarily unavailable.
  }
  return {
    sampleCount,
    triggerHitRatePct: round6(triggerHitRatePct),
    subsidyUtilizationPct: round6(subsidyUtilizationPct),
    treasuryDrawdownPct: round6(treasuryDrawdownPct)
  };
};

const resolveDynamicTenorPolicy = async (params: {
  pool: ReturnType<typeof getPilotPool>;
  nowIso: string;
}): Promise<TenorPolicyResponse> => {
  const candidates = pilotConfig.tenorPolicyCandidateDays;
  const rows = await listRecentTenorPolicyRows(params.pool, {
    lookbackMinutes: pilotConfig.tenorPolicyLookbackMinutes,
    candidateTenors: candidates
  });
  const rowsByTenor = new Map<number, TenorPolicyTenorRow>();
  for (const row of rows) rowsByTenor.set(row.tenorDays, row);
  const tenors: TenorPolicyEntry[] = [];
  for (const tenor of candidates) {
    const row = rowsByTenor.get(tenor);
    const sampleCount = row?.sampleCount || 0;
    const metrics = row?.metrics || {
      okRate: 0,
      optionsNativeRate: 0,
      futuresSyntheticRate: 0,
      medianPremiumRatio: null,
      medianDriftDays: null,
      negativeMatchedTenorRate: 0,
      medianMatchedTenorDays: null
    };
    const medianPremiumRatio = metrics.medianPremiumRatio;
    const medianDriftDays = metrics.medianDriftDays;
    const reasons: TenorPolicyReason[] = [];
    if (sampleCount < pilotConfig.tenorPolicyMinSamples) reasons.push("insufficient_samples");
    if (metrics.okRate < pilotConfig.tenorPolicyMinOkRate) reasons.push("ok_rate_below_min");
    if (metrics.optionsNativeRate < pilotConfig.tenorPolicyMinOptionsNativeRate) {
      reasons.push("options_native_rate_below_min");
    }
    if (medianPremiumRatio === null || medianDriftDays === null) reasons.push("policy_data_unavailable");
    if (medianPremiumRatio !== null && medianPremiumRatio > pilotConfig.tenorPolicyMaxMedianPremiumRatio) {
      reasons.push("premium_ratio_above_max");
    }
    if (medianDriftDays !== null && medianDriftDays > pilotConfig.tenorPolicyMaxMedianDriftDays) {
      reasons.push("drift_above_max");
    }
    if (metrics.negativeMatchedTenorRate > pilotConfig.tenorPolicyMaxNegativeMatchedRate) {
      reasons.push("negative_matched_tenor_rate_above_max");
    }
    if (tenor < pilotConfig.pilotTenorMinDays || tenor > pilotConfig.pilotTenorMaxDays) {
      reasons.push("tenor_clamped_by_backend_bounds");
    }
    const score =
      medianPremiumRatio === null || medianDriftDays === null
        ? null
        : 100 * medianPremiumRatio +
          2 * medianDriftDays +
          8 * metrics.futuresSyntheticRate +
          10 * metrics.negativeMatchedTenorRate;
    tenors.push({
      tenorDays: tenor,
      sampleCount,
      metrics,
      score: score === null ? null : round6(score),
      eligible: reasons.length === 0,
      reasons
    });
  }
  const enabledTenorsDays = tenors.filter((entry) => entry.eligible).map((entry) => entry.tenorDays);
  const sortedEnabled = tenors
    .filter((entry) => entry.eligible)
    .sort((a, b) => {
      const aScore = a.score ?? Number.POSITIVE_INFINITY;
      const bScore = b.score ?? Number.POSITIVE_INFINITY;
      return aScore !== bScore ? aScore - bScore : a.tenorDays - b.tenorDays;
    });
  const defaultTenorDays =
    sortedEnabled[0]?.tenorDays ||
    (candidates.includes(pilotConfig.tenorPolicyDefaultFallbackDays)
      ? pilotConfig.tenorPolicyDefaultFallbackDays
      : candidates[0] || pilotConfig.pilotTenorDefaultDays);
  const selectionStatus = enabledTenorsDays.length > 0 ? "ok" : "degraded";
  return {
    status: "ok",
    asOf: params.nowIso,
    policyVersion: pilotConfig.tenorPolicyVersion,
    window: {
      lookbackMinutes: pilotConfig.tenorPolicyLookbackMinutes,
      minSamplesPerTenor: pilotConfig.tenorPolicyMinSamples
    },
    config: {
      candidateTenorsDays: candidates,
      thresholds: {
        minOkRate: pilotConfig.tenorPolicyMinOkRate,
        minOptionsNativeRate: pilotConfig.tenorPolicyMinOptionsNativeRate,
        maxMedianPremiumRatio: pilotConfig.tenorPolicyMaxMedianPremiumRatio,
        maxMedianDriftDays: pilotConfig.tenorPolicyMaxMedianDriftDays,
        maxNegativeMatchedTenorRate: pilotConfig.tenorPolicyMaxNegativeMatchedRate
      },
      enforce: pilotConfig.tenorPolicyEnforce,
      autoRoute: pilotConfig.tenorPolicyAutoRoute,
      defaultFallbackTenorDays: pilotConfig.tenorPolicyDefaultFallbackDays
    },
    selection: {
      enabledTenorsDays,
      defaultTenorDays,
      status: selectionStatus
    },
    tenors
  };
};

const sanitizeQuoteForClient = (quote: {
  venue: string;
  quoteId: string;
  rfqId?: string | null;
  instrumentId: string;
  side: "buy";
  quantity: number;
  premium: number;
  expiresAt: string;
  quoteTs: string;
  details?: Record<string, unknown>;
}): {
  venue: string;
  quoteId: string;
  rfqId?: string | null;
  instrumentId: string;
  side: "buy";
  quantity: number;
  premium: number;
  expiresAt: string;
  quoteTs: string;
  details?: Record<string, unknown>;
} => {
  const details = quote.details || {};
  const allowedDetails: Record<string, unknown> = {};
  const allowedKeys = [
    "mode",
    "source",
    "pricing",
    "askPriceBtc",
    "askSource",
    "askSize",
    "spotPriceUsd",
    "optionType",
    "selectedStrike",
    "targetTriggerPrice",
    "strikeGapToTriggerUsd",
    "strikeGapToTriggerPct",
    "selectedTenorDays",
    "tenorDriftDays",
    "tenorReason",
    "deribitQuotePolicy",
    "strikeSelectionMode",
    "hedgeMode",
    "hedgeInstrumentFamily",
    "selectionReason",
    "pricingBreakdown",
    "triggerPayoutCreditUsd",
    "expectedTriggerCostUsd",
    "expectedTriggerCreditUsd",
    "premiumProfitabilityTargetUsd",
    "premiumPricingMode",
    "rankedAlternatives",
    "candidateFailureCounts"
  ];
  for (const key of allowedKeys) {
    if (key in details) allowedDetails[key] = details[key];
  }
  const base = {
    venue: quote.venue,
    quoteId: quote.quoteId,
    instrumentId: quote.instrumentId,
    side: quote.side,
    quantity: quote.quantity,
    premium: quote.premium,
    expiresAt: quote.expiresAt,
    quoteTs: quote.quoteTs
  };
  return {
    ...base,
    ...(quote.rfqId !== undefined ? { rfqId: quote.rfqId } : {}),
    details: Object.keys(allowedDetails).length > 0 ? allowedDetails : undefined
  };
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const resolvePilotVenueHealth = async (): Promise<Record<string, unknown>> => {
  if (!String(pilotConfig.venueMode || "").startsWith("ibkr_")) {
    return {
      mode: pilotConfig.venueMode,
      status: "not_applicable"
    };
  }
  const connector = new IbkrConnector({
    baseUrl: pilotConfig.ibkrBridgeBaseUrl,
    timeoutMs: pilotConfig.ibkrBridgeTimeoutMs,
    accountId: pilotConfig.ibkrAccountId || "PILOT_HEALTHCHECK",
    auth: {
      token: pilotConfig.ibkrBridgeToken
    }
  });
  try {
    const health = await withTimeout(
      connector.getHealth(),
      Math.max(500, Number(pilotConfig.ibkrBridgeTimeoutMs || 0)),
      "ibkr_bridge_health"
    );
    return {
      mode: pilotConfig.venueMode,
      status: "ok",
      transport: String((health as any)?.transport || "unknown"),
      activeTransport: String((health as any)?.activeTransport || "unknown"),
      session: String((health as any)?.session || "unknown"),
      fallbackEnabled: Boolean((health as any)?.fallbackEnabled),
      asOf: String((health as any)?.asOf || "")
    };
  } catch (error: any) {
    return {
      mode: pilotConfig.venueMode,
      status: "degraded",
      detail: String(error?.message || "ibkr_bridge_health_failed")
    };
  }
};

type AdminBrokerBalanceSnapshot = {
  source: "ibkr_account_summary";
  readOnly: true;
  accountId: string | null;
  currency: string;
  netLiquidationUsd: string;
  availableFundsUsd: string;
  excessLiquidityUsd: string;
  buyingPowerUsd: string;
  asOf: string;
} | null;

const resolveAdminBrokerBalanceSnapshot = async (): Promise<AdminBrokerBalanceSnapshot> => {
  if (!String(pilotConfig.venueMode || "").startsWith("ibkr_")) {
    return null;
  }
  const connector = new IbkrConnector({
    baseUrl: pilotConfig.ibkrBridgeBaseUrl,
    timeoutMs: pilotConfig.ibkrBridgeTimeoutMs,
    accountId: pilotConfig.ibkrAccountId || "PILOT_ADMIN_SNAPSHOT",
    auth: {
      token: pilotConfig.ibkrBridgeToken
    }
  });
  const summary = await withTimeout(
    connector.getAccountSummarySnapshot(),
    Math.max(500, Number(pilotConfig.ibkrBridgeTimeoutMs || 0)),
    "ibkr_account_summary"
  );
  return {
    source: "ibkr_account_summary",
    readOnly: true,
    accountId: summary.accountId,
    currency: String(summary.currency || "USD"),
    netLiquidationUsd: String(summary.netLiquidationUsd || "0"),
    availableFundsUsd: String(summary.availableFundsUsd || "0"),
    excessLiquidityUsd: String(summary.excessLiquidityUsd || "0"),
    buyingPowerUsd: String(summary.buyingPowerUsd || "0"),
    asOf: String(summary.asOf || new Date().toISOString())
  };
};

const isIbkrLiveTransportHealthy = (venueHealth: Record<string, unknown>): boolean => {
  if (venueHealth.status !== "ok") return false;
  const mode = String(venueHealth.mode || "");
  if (!mode.startsWith("ibkr_")) return true;
  const session = String(venueHealth.session || "").toLowerCase();
  const activeTransport = String(venueHealth.activeTransport || "").toLowerCase();
  const fallbackEnabled = Boolean(venueHealth.fallbackEnabled);
  return session === "connected" && activeTransport === "ib_socket" && fallbackEnabled === false;
};

const inferProtectionTypeFromInstrument = (instrumentId: string | null | undefined): "long" | "short" => {
  const normalized = String(instrumentId || "").toUpperCase();
  return normalized.endsWith("-C") ? "short" : "long";
};

const resolveProtectionTypeFromRecord = (protection: { instrumentId?: string | null; metadata?: Record<string, unknown> }): "long" | "short" =>
  normalizeProtectionType(
    String(protection.metadata?.protectionType || inferProtectionTypeFromInstrument(protection.instrumentId))
  );

const sanitizeProtectionForTrader = (protection: Record<string, unknown>): Record<string, unknown> => {
  const { userHash: _userHash, hashVersion: _hashVersion, ...safe } = protection;
  return safe;
};

const assertProtectionOwnership = (
  protection: { userHash?: string | null },
  tenant: { userHash: string }
): boolean => String(protection.userHash || "") === tenant.userHash;

const isAdminAuthorized = (req: FastifyRequest): boolean => {
  const token = String(req.headers["x-admin-token"] || "");
  if (!pilotConfig.adminToken || token !== pilotConfig.adminToken) return false;
  const actorIp = getRequestIp(req);
  if (
    pilotConfig.adminIpAllowlist.entries.length > 0 &&
    !pilotConfig.adminIpAllowlist.entries.includes(actorIp)
  ) {
    return false;
  }
  return true;
};

const isProofAuthorized = (req: FastifyRequest): boolean => {
  if (!pilotConfig.proofToken) return false;
  const headerToken = String(req.headers["x-proof-token"] || "");
  const auth = String(req.headers.authorization || "");
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const token = headerToken || bearer;
  return Boolean(token && token === pilotConfig.proofToken);
};

const requireAdmin = async (
  req: FastifyRequest,
  reply: FastifyReply
): Promise<{ actor: string; actorIp: string } | null> => {
  const actor = String(req.headers["x-admin-actor"] || "pilot-ops");
  const actorIp = getRequestIp(req);
  if (!isAdminAuthorized(req)) {
    reply.code(401).send({ status: "error", reason: "unauthorized_admin" });
    return null;
  }
  return { actor, actorIp };
};

const requireProofAccess = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
  if (!pilotConfig.proofToken) {
    reply.code(503).send({ status: "error", reason: "proof_auth_not_configured" });
    return false;
  }
  if (!isProofAuthorized(req)) {
    reply.code(401).send({ status: "error", reason: "unauthorized_proof_access" });
    return false;
  }
  return true;
};

const resolveTenantScopeHash = (): { userHash: string; hashVersion: number } =>
  buildUserHash({
    rawUserId: pilotConfig.tenantScopeId,
    secret: pilotConfig.hashSecret,
    hashVersion: pilotConfig.hashVersion
  });

const requireInternalOrAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
  const internalToken = String(req.headers["x-internal-token"] || "");
  if (pilotConfig.internalToken && internalToken === pilotConfig.internalToken) {
    return true;
  }
  const admin = await requireAdmin(req, reply);
  return Boolean(admin);
};

const enforcePilotWindow = (reply: FastifyReply): boolean => {
  const window = resolvePilotWindow(new Date());
  if (window.status === "open") return true;
  if (window.status === "config_invalid") {
    reply.code(500).send({
      status: "error",
      reason: "pilot_window_config_invalid",
      detail: window.reason || "pilot_window_invalid"
    });
    return false;
  }
  if (window.status === "not_started") {
    reply.code(403).send({
      status: "error",
      reason: "pilot_not_started",
      startAt: window.startAt,
      endAt: window.endAt
    });
    return false;
  }
  if (window.status === "closed") {
    reply.code(403).send({
      status: "error",
      reason: "pilot_window_closed",
      startAt: window.startAt,
      endAt: window.endAt
    });
    return false;
  }
  return true;
};

const toCsv = (rows: Array<Record<string, unknown>>): string => {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]);
  const escape = (value: unknown): string => {
    const str = value === null || value === undefined ? "" : String(value);
    if (str.includes(",") || str.includes("\"") || str.includes("\n")) {
      return `"${str.replace(/"/g, "\"\"")}"`;
    }
    return str;
  };
  const header = columns.join(",");
  const body = rows.map((row) => columns.map((col) => escape(row[col])).join(",")).join("\n");
  return `${header}\n${body}`;
};

export const registerPilotRoutes = async (
  app: FastifyInstance,
  deps: { deribit: DeribitConnector }
): Promise<void> => {
  if (!pilotConfig.enabled) return;

  await app.register(rateLimit, {
    max: Number(process.env.PILOT_RATE_LIMIT_MAX || "60"),
    timeWindow: Number(process.env.PILOT_RATE_LIMIT_WINDOW_MS || "60000"),
    keyGenerator: (req: FastifyRequest) => {
      const forwarded = req.headers["x-forwarded-for"];
      return typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.ip;
    },
    errorResponseBuilder: () => ({
      status: "error",
      reason: "rate_limit_exceeded",
      message: "Too many requests. Please retry after a short delay."
    })
  });

  const monitorConfig = parseMonitorConfig();
  const monitor = new PilotMonitor(monitorConfig);

  const pool = getPilotPool(pilotConfig.postgresUrl);
  await ensurePilotSchema(pool);
  const venue = createPilotVenueAdapter({
    mode: pilotConfig.venueMode,
    bullishEnabled: pilotConfig.bullish.enabled,
    bullish: pilotConfig.bullish,
    quoteTtlMs: pilotConfig.quoteTtlMs,
    deribitQuotePolicy: pilotConfig.deribitQuotePolicy,
    deribitStrikeSelectionMode: pilotConfig.deribitStrikeSelectionMode,
    deribitMaxTenorDriftDays: pilotConfig.deribitMaxTenorDriftDays,
    falconx: {
      baseUrl: pilotConfig.falconxBaseUrl,
      apiKey: pilotConfig.falconxApiKey,
      secret: pilotConfig.falconxSecret,
      passphrase: pilotConfig.falconxPassphrase
    },
    ibkr: {
      bridgeBaseUrl: pilotConfig.ibkrBridgeBaseUrl,
      bridgeTimeoutMs: pilotConfig.ibkrBridgeTimeoutMs,
      bridgeToken: pilotConfig.ibkrBridgeToken,
      accountId: pilotConfig.ibkrAccountId,
      enableExecution: pilotConfig.ibkrEnableExecution,
      orderTimeoutMs: pilotConfig.ibkrOrderTimeoutMs,
      maxRepriceSteps: pilotConfig.ibkrMaxRepriceSteps,
      repriceStepTicks: pilotConfig.ibkrRepriceStepTicks,
      maxSlippageBps: pilotConfig.ibkrMaxSlippageBps,
      orderTif: pilotConfig.ibkrOrderTif,
      primaryProductFamily: pilotConfig.ibkrPrimaryProductFamily,
      enableBffFallback: pilotConfig.ibkrRequireOptionsNative ? false : pilotConfig.ibkrBffFallbackEnabled,
      bffProductFamily: pilotConfig.ibkrBffProductFamily,
      requireLiveTransport: pilotConfig.ibkrRequireLiveTransport,
      maxTenorDriftDays: pilotConfig.ibkrMaxTenorDriftDays,
      preferTenorAtOrAbove: pilotConfig.ibkrPreferTenorAtOrAbove,
      maxFuturesSyntheticPremiumRatio: pilotConfig.ibkrMaxFuturesSyntheticPremiumRatio,
      maxOptionPremiumRatio: pilotConfig.ibkrMaxOptionPremiumRatio,
      optionProbeParallelism: pilotConfig.ibkrOptionProbeParallelism,
      optionLiquiditySelectionEnabled: pilotConfig.ibkrOptionLiquiditySelectionEnabled,
      qualifyCacheTtlMs: pilotConfig.ibkrQualifyCacheTtlMs,
      qualifyCacheMaxKeys: pilotConfig.ibkrQualifyCacheMaxKeys,
      optionTenorWindowDays: pilotConfig.ibkrOptionLiquidityTenorWindowDays,
      optionProtectionTolerancePct: pilotConfig.ibkrOptionProtectionTolerancePct,
      requireOptionsNative: pilotConfig.ibkrRequireOptionsNative,
      selectorMode: pilotConfig.pilotSelectorMode,
      hedgeOptimizer: pilotConfig.hedgeOptimizer
    },
    ibkrQuoteBudgetMs: pilotConfig.venueQuoteTimeoutMs,
    deribit: deps.deribit
  });

  const deribitVenue = createPilotVenueAdapter({
    mode: "deribit_live",
    falconx: { baseUrl: "", apiKey: "", secret: "", passphrase: "" },
    deribit: deps.deribit,
    quoteTtlMs: pilotConfig.quoteTtlMs,
    deribitQuotePolicy: pilotConfig.deribitQuotePolicy,
    deribitStrikeSelectionMode: "trigger_aligned",
    deribitMaxTenorDriftDays: 7
  });

  if (pilotConfig.v7.enabled) {
    configureRegimeClassifier({
      deribitConnector: deps.deribit,
      thresholds: {
        calmBelow: pilotConfig.v7.dvolCalmThreshold,
        stressAbove: pilotConfig.v7.dvolStressThreshold
      }
    });
    console.log(`[V7] Regime classifier configured: calm<${pilotConfig.v7.dvolCalmThreshold}% stress>${pilotConfig.v7.dvolStressThreshold}% tenor=${pilotConfig.v7.defaultTenorDays}d`);
  }

  const resolveAndPersistExpiry = async (protectionId: string): Promise<void> => {
    const protection = await getProtection(pool, protectionId);
    if (!protection) return;
    if (!["active", "awaiting_expiry_price"].includes(protection.status)) return;
    const expiryAt = new Date(protection.expiryAt);
    if (Date.now() < expiryAt.getTime()) return;
    const requestId = pilotConfig.nextRequestId();
    try {
      const snapshot = isLockedBullishProfile
        ? await resolveBullishReferencePrice(requestId, protection.marketId)
        : await resolvePriceSnapshot(
          {
            primaryUrl: pilotConfig.referencePriceUrl,
            fallbackUrl: pilotConfig.singlePriceSource ? "" : pilotConfig.fallbackPriceUrl,
            primaryTimeoutMs: pilotConfig.pricePrimaryTimeoutMs,
            fallbackTimeoutMs: pilotConfig.priceFallbackTimeoutMs,
            freshnessMaxMs: pilotConfig.priceFreshnessMaxMs,
            requestRetryAttempts: pilotConfig.priceRequestRetryAttempts,
            requestRetryDelayMs: pilotConfig.priceRequestRetryDelayMs
          },
          {
            marketId: protection.marketId,
            now: new Date(),
            expiryAt,
            requestId,
            endpointVersion: pilotConfig.endpointVersion
          }
        );
      await insertPriceSnapshot(pool, {
        protectionId,
        snapshotType: "expiry",
        price: snapshot.price.toFixed(10),
        marketId: snapshot.marketId,
        priceSource: snapshot.priceSource,
        priceSourceDetail: snapshot.priceSourceDetail,
        endpointVersion: snapshot.endpointVersion,
        requestId: snapshot.requestId,
        priceTimestamp: snapshot.priceTimestamp
      });
      const entryPrice = new Decimal(protection.entryPrice || "0");
      const protectedNotional = new Decimal(protection.protectedNotional);
      const expiryPrice = snapshot.price;
      const drawdownFloorPct = new Decimal(protection.drawdownFloorPct || "0.2");
      const protectionType = resolveProtectionTypeFromRecord(protection);
      const triggerPrice = protection.floorPrice
        ? new Decimal(protection.floorPrice)
        : computeTriggerPrice(entryPrice, drawdownFloorPct, protectionType);
      const payoutDue = computePayoutDue({
        protectedNotional,
        entryPrice,
        triggerPrice,
        expiryPrice,
        protectionType
      });
      const nextStatus = payoutDue.gt(0) ? "expired_itm" : "expired_otm";
      const hedgeStatus = payoutDue.gt(0) ? "expired" : "expired";
      await patchProtection(pool, protectionId, {
        status: nextStatus,
        expiry_price: snapshot.price.toFixed(10),
        expiry_price_source: snapshot.priceSource,
        expiry_price_timestamp: snapshot.priceTimestamp,
        floor_price: triggerPrice.toFixed(10),
        payout_due_amount: payoutDue.toFixed(10),
        metadata: {
          ...(protection.metadata || {}),
          hedge_status: hedgeStatus,
          hedgeExpiryResolvedAt: new Date().toISOString(),
        }
      });
      if (payoutDue.gt(0)) {
        await insertLedgerEntry(pool, {
          protectionId,
          entryType: "payout_due",
          amount: payoutDue.toFixed(10),
          reference: `expiry:${snapshot.priceTimestamp}`
        });
      }
    } catch (error: any) {
      await patchProtection(pool, protectionId, {
        status: "awaiting_expiry_price",
        metadata: {
          ...protection.metadata,
          expiryError: String(error?.message || "expiry_price_unavailable")
        }
      });
    }
  };

  app.get("/pilot/terms/status", async (req, reply) => {
    const query = req.query as { termsVersion?: string };
    if (query.termsVersion && String(query.termsVersion) !== pilotConfig.termsVersion) {
      reply.code(400);
      return {
        status: "error",
        reason: "terms_version_mismatch",
        expectedTermsVersion: pilotConfig.termsVersion
      };
    }
    let userHash: { userHash: string; hashVersion: number };
    try {
      userHash = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    try {
      const acceptance = await getPilotTermsAcceptance(pool, {
        userHash: userHash.userHash,
        termsVersion: pilotConfig.termsVersion
      });
      return {
        status: "ok",
        termsVersion: pilotConfig.termsVersion,
        accepted: Boolean(acceptance),
        acceptedAt: acceptance?.acceptedAt || null
      };
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "storage_unavailable",
        message: "Storage temporarily unavailable, please retry.",
        detail: String(error?.message || "terms_status_failed")
      };
    }
  });

  app.post("/pilot/terms/accept", async (req, reply) => {
    const body = req.body as { termsVersion?: string; accepted?: boolean };
    if (body.termsVersion && String(body.termsVersion) !== pilotConfig.termsVersion) {
      reply.code(400);
      return {
        status: "error",
        reason: "terms_version_mismatch",
        expectedTermsVersion: pilotConfig.termsVersion
      };
    }
    if (body.accepted === false) {
      reply.code(400);
      return { status: "error", reason: "acceptance_required" };
    }
    let userHash: { userHash: string; hashVersion: number };
    try {
      userHash = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    const userAgent = String(req.headers["user-agent"] || "").trim() || null;
    try {
      const accepted = await createPilotTermsAcceptanceIfMissing(pool, {
        userHash: userHash.userHash,
        hashVersion: userHash.hashVersion,
        termsVersion: pilotConfig.termsVersion,
        acceptedIp: getRequestIp(req),
        userAgent,
        source: "pilot_web",
        details: {
          endpointVersion: pilotConfig.endpointVersion,
          requestId: pilotConfig.nextRequestId()
        }
      });
      return {
        status: "ok",
        termsVersion: pilotConfig.termsVersion,
        acceptanceId: accepted.record.id,
        acceptedAt: accepted.record.acceptedAt,
        firstAcceptance: accepted.created
      };
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "storage_unavailable",
        message: "Storage temporarily unavailable, please retry.",
        detail: String(error?.message || "terms_accept_failed")
      };
    }
  });

  app.get("/pilot/reference-price", async (req, reply) => {
    const query = req.query as { marketId?: string };
    const marketId = String(query.marketId || pilotConfig.referenceMarketId || "BTC-USD");
    const requestId = pilotConfig.nextRequestId();
    try {
      const snapshot = await resolveLiveReferencePrice(requestId, marketId);
      const ageMs = Math.max(0, Date.now() - Date.parse(snapshot.priceTimestamp));
      const venue =
        snapshot.priceSource === "bullish_orderbook_mid"
          ? "Bullish"
          : snapshot.priceSource === "fallback_oracle"
            ? resolveReferenceVenueLabel(pilotConfig.fallbackPriceUrl)
            : resolveReferenceVenueLabel(pilotConfig.referencePriceUrl);
      return {
        status: "ok",
        reference: {
          price: snapshot.price.toFixed(10),
          marketId: snapshot.marketId,
          venue,
          source: snapshot.priceSource,
          timestamp: snapshot.priceTimestamp,
          requestId: snapshot.requestId,
          ageMs,
          freshnessMaxMs: pilotConfig.priceFreshnessMaxMs
        }
      };
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "price_unavailable",
        message: "Price temporarily unavailable, please retry.",
        detail: String(error?.message || "reference_price_unavailable")
      };
    }
  });

  app.post("/pilot/sim/positions/open", async (req, reply) => {
    if (!enforcePilotWindow(reply)) return;
    const body = req.body as {
      protectedNotional?: number;
      tierName?: string;
      drawdownFloorPct?: number;
      side?: "long" | "short";
      marketId?: string;
      withProtection?: boolean;
      quoteId?: string;
      tenorDays?: number;
    };
    const protectedNotional = parsePositiveDecimal(body?.protectedNotional);
    if (!protectedNotional) {
      reply.code(400);
      return { status: "error", reason: "invalid_notional" };
    }
    const side = String(body?.side || "long").toLowerCase() === "short" ? "short" : "long";
    const tierName = normalizeTierName(body?.tierName);
    const drawdownFloorPct = resolveDrawdownFloorPct({
      tierName,
      drawdownFloorPct: Number(body?.drawdownFloorPct)
    });
    const marketId = String(body?.marketId || "BTC-USD");
    const withProtection = parseBoolean(body?.withProtection, false);
    const tenant = resolveTenantScopeHash();
    const requestId = pilotConfig.nextRequestId();
    let snapshot: PriceSnapshotOutput;
    try {
      snapshot = await resolveLiveReferencePrice(requestId, marketId);
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "price_unavailable",
        detail: String(error?.message || "sim_open_price_unavailable")
      };
    }
    const floorPrice = computeTriggerPrice(snapshot.price, drawdownFloorPct, side);
    let protectionId: string | null = null;
    let protectionPremiumUsd: Decimal | null = null;
    if (withProtection) {
      const quoteId = String(body?.quoteId || "").trim();
      if (!quoteId) {
        reply.code(400);
        return { status: "error", reason: "quote_id_required_for_protection" };
      }
      const activationPayload = {
        quoteId,
        protectedNotional: protectedNotional.toNumber(),
        foxifyExposureNotional: protectedNotional.toNumber(),
        instrumentId: "BTC-USD-7D-P",
        marketId,
        tierName,
        drawdownFloorPct: drawdownFloorPct.toNumber(),
        protectionType: side,
        autoRenew: false,
        tenorDays: Number(body?.tenorDays || SIM_DAYS)
      };
      const activation = await app.inject({
        method: "POST",
        url: "/pilot/protections/activate",
        payload: activationPayload
      });
      if (activation.statusCode !== 200) {
        reply.code(activation.statusCode);
        return activation.json();
      }
      const activationJson = activation.json() as {
        status: string;
        protection?: { id?: string; premium?: string | number };
      };
      protectionId = String(activationJson.protection?.id || "");
      protectionPremiumUsd = parsePositiveDecimal(activationJson.protection?.premium ?? 0);
      if (!protectionId || !protectionPremiumUsd) {
        reply.code(500);
        return { status: "error", reason: "sim_protection_activation_incomplete" };
      }
    }
    const protectedLossUsd = computeDrawdownLossBudgetUsd(protectedNotional, drawdownFloorPct);
    const simPosition = await insertSimPosition(pool, {
      userHash: tenant.userHash,
      hashVersion: tenant.hashVersion,
      status: "open",
      marketId,
      side,
      notionalUsd: protectedNotional.toFixed(10),
      entryPrice: snapshot.price.toFixed(10),
      tierName,
      drawdownFloorPct: drawdownFloorPct.toFixed(6),
      floorPrice: floorPrice.toFixed(10),
      protectionEnabled: withProtection,
      protectionId,
      protectionPremiumUsd: protectionPremiumUsd?.toFixed(10) ?? null,
      protectedLossUsd: withProtection ? protectedLossUsd.toFixed(10) : null,
      metadata: {
        requestId,
        source: "sim_position_open",
        referencePriceSource: snapshot.priceSource,
        referencePriceTimestamp: snapshot.priceTimestamp
      }
    });
    if (withProtection && protectionPremiumUsd) {
      await insertSimTreasuryLedgerEntry(pool, {
        simPositionId: simPosition.id,
        userHash: tenant.userHash,
        protectionId,
        entryType: "premium_collected",
        amountUsd: protectionPremiumUsd.toFixed(10),
        metadata: {
          requestId,
          source: "sim_position_open",
          quoteId: String(body?.quoteId || "")
        }
      });
    }
    return {
      status: "ok",
      simPosition,
      entrySnapshot: {
        price: snapshot.price.toFixed(10),
        marketId: snapshot.marketId,
        source: snapshot.priceSource,
        timestamp: snapshot.priceTimestamp,
        requestId: snapshot.requestId
      }
    };
  });

  app.get("/pilot/sim/positions", async (req, reply) => {
    const query = req.query as { limit?: string };
    let tenant: { userHash: string; hashVersion: number };
    try {
      tenant = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    const limit = Number(query.limit || 100);
    let positions;
    try {
      positions = await listSimPositionsByUserHash(pool, tenant.userHash, { limit });
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "storage_unavailable",
        detail: String(error?.message || "sim_positions_list_failed")
      };
    }
    const marketIds = Array.from(new Set(positions.map((item) => item.marketId)));
    const marks = new Map<string, PriceSnapshotOutput>();
    await Promise.all(
      marketIds.map(async (marketId) => {
        try {
          const snapshot = await resolveLiveReferencePrice(pilotConfig.nextRequestId(), marketId);
          marks.set(marketId, snapshot);
        } catch {
          // best effort mark pricing for dashboard
        }
      })
    );
    const enriched = positions.map((position) => {
      const mark = marks.get(position.marketId);
      const entry = parsePositiveDecimal(position.entryPrice) || new Decimal(0);
      const notional = parsePositiveDecimal(position.notionalUsd) || new Decimal(0);
      const markPrice = mark?.price || entry;
      const pnlUsd = entry.gt(0)
        ? notional.mul(markPrice.minus(entry)).div(entry)
        : new Decimal(0);
      const drawdownPct = entry.gt(0) ? entry.minus(markPrice).div(entry) : new Decimal(0);
      return {
        ...position,
        markPrice: mark ? mark.price.toFixed(10) : null,
        markSource: mark?.priceSource || null,
        markTimestamp: mark?.priceTimestamp || null,
        pnlUsd: pnlUsd.toFixed(10),
        drawdownPct: drawdownPct.toFixed(10)
      };
    });
    return { status: "ok", positions: enriched };
  });

  app.post("/pilot/sim/positions/:id/close", async (req, reply) => {
    const params = req.params as { id: string };
    let tenant: { userHash: string; hashVersion: number };
    try {
      tenant = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    const simPosition = await getSimPosition(pool, params.id);
    if (!simPosition || !assertProtectionOwnership(simPosition, tenant)) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    if (simPosition.status === "closed") {
      return { status: "ok", simPosition, idempotent: true };
    }
    const requestId = pilotConfig.nextRequestId();
    let snapshot: PriceSnapshotOutput;
    try {
      snapshot = await resolveLiveReferencePrice(requestId, simPosition.marketId);
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "price_unavailable",
        detail: String(error?.message || "sim_close_price_unavailable")
      };
    }
    const entryPrice = parsePositiveDecimal(simPosition.entryPrice) || new Decimal(0);
    const notionalUsd = parsePositiveDecimal(simPosition.notionalUsd) || new Decimal(0);
    const realizedPnlUsd =
      entryPrice.gt(0) && notionalUsd.gt(0)
        ? notionalUsd.mul(snapshot.price.minus(entryPrice)).div(entryPrice)
        : new Decimal(0);
    const closedAtIso = new Date().toISOString();
    const closed = await patchSimPosition(pool, params.id, {
      status: "closed",
      metadata: buildSimLifecycleMetadata(simPosition.metadata || {}, {
        closedAt: closedAtIso,
        closePrice: snapshot.price.toFixed(10),
        closePriceSource: snapshot.priceSource,
        closePriceTimestamp: snapshot.priceTimestamp,
        closeRequestId: requestId,
        realizedPnlUsd: realizedPnlUsd.toFixed(10)
      })
    });
    if (!closed) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    return {
      status: "ok",
      simPosition: closed,
      closeSnapshot: {
        price: snapshot.price.toFixed(10),
        marketId: snapshot.marketId,
        source: snapshot.priceSource,
        timestamp: snapshot.priceTimestamp,
        requestId: snapshot.requestId
      }
    };
  });

  app.post("/pilot/internal/sim/trigger-monitor/run", async (req, reply) => {
    const allowed = await requireInternalOrAdmin(req, reply);
    if (!allowed) return;
    const body = req.body as { maxRows?: number } | undefined;
    let tenant: { userHash: string; hashVersion: number };
    try {
      tenant = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    try {
      const result = await runSimTriggerMonitorCycle({
        pool,
        tenant,
        maxRows: Number(body?.maxRows || 200)
      });
      return { status: "ok", result };
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "storage_unavailable",
        detail: String(error?.message || "sim_trigger_monitor_failed")
      };
    }
  });

  app.get("/pilot/sim/platform/metrics", async (_req, reply) => {
    let tenant: { userHash: string; hashVersion: number };
    try {
      tenant = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    try {
      const [metrics, recentLedger] = await Promise.all([
        getSimPlatformMetrics(pool, tenant.userHash),
        listSimTreasuryLedgerByUserHash(pool, tenant.userHash, { limit: 100 })
      ]);
      return {
        status: "ok",
        metrics,
        recentLedger
      };
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "storage_unavailable",
        detail: String(error?.message || "sim_platform_metrics_failed")
      };
    }
  });

  app.get("/pilot/sim/account/summary", async (_req, reply) => {
    let tenant: { userHash: string; hashVersion: number };
    try {
      tenant = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    try {
      const [positions, recentLedger] = await Promise.all([
        listSimPositionsByUserHash(pool, tenant.userHash, { limit: 500 }),
        listSimTreasuryLedgerByUserHash(pool, tenant.userHash, { limit: 2000 })
      ]);
      const marketIds = Array.from(new Set(positions.map((item) => item.marketId)));
      const marks = new Map<string, Decimal>();
      await Promise.all(
        marketIds.map(async (marketId) => {
          try {
            const snapshot = await resolveLiveReferencePrice(pilotConfig.nextRequestId(), marketId);
            marks.set(marketId, snapshot.price);
          } catch {
            // best effort marks for account summary
          }
        })
      );
      const ledgerPremiumPaid = recentLedger
        .filter((entry) => entry.entryType === "premium_collected")
        .reduce((acc, entry) => acc.plus(new Decimal(entry.amountUsd)), new Decimal(0));
      const ledgerTriggerCredits = recentLedger
        .filter((entry) => entry.entryType === "trigger_credit")
        .reduce((acc, entry) => acc.plus(new Decimal(entry.amountUsd)), new Decimal(0));
      const closedRealizedPnl = positions
        .filter((position) => position.status === "closed")
        .reduce((acc, position) => {
          const lifecycle = position.metadata || {};
          const realized = toFiniteNumber(lifecycle.realizedPnlUsd);
          if (realized === null) return acc;
          return acc.plus(realized);
        }, new Decimal(0));
      const openUnrealizedPnl = positions
        .filter((position) => position.status === "open")
        .reduce((acc, position) => {
          const entry = parsePositiveDecimal(position.entryPrice) || new Decimal(0);
          const notional = parsePositiveDecimal(position.notionalUsd) || new Decimal(0);
          const mark = marks.get(position.marketId) || entry;
          if (entry.lte(0) || notional.lte(0)) return acc;
          const pnl = notional.mul(mark.minus(entry)).div(entry);
          return acc.plus(pnl);
        }, new Decimal(0));
      const startingEquityUsd = resolveSimStartingEquityUsd();
      const currentEquityUsd = startingEquityUsd
        .plus(closedRealizedPnl)
        .plus(openUnrealizedPnl)
        .plus(ledgerTriggerCredits)
        .minus(ledgerPremiumPaid);
      return {
        status: "ok",
        summary: {
          startingEquityUsd: startingEquityUsd.toFixed(10),
          premiumPaidUsd: ledgerPremiumPaid.toFixed(10),
          triggerCreditsUsd: ledgerTriggerCredits.toFixed(10),
          realizedPnlUsd: closedRealizedPnl.toFixed(10),
          unrealizedPnlUsd: openUnrealizedPnl.toFixed(10),
          currentEquityUsd: currentEquityUsd.toFixed(10),
          openPositions: String(positions.filter((item) => item.status === "open").length),
          closedPositions: String(positions.filter((item) => item.status === "closed").length),
          triggeredPositions: String(positions.filter((item) => item.status === "triggered").length)
        }
      };
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "storage_unavailable",
        detail: String(error?.message || "sim_account_summary_failed")
      };
    }
  });

  app.get("/pilot/regime", async (req, reply) => {
    const query = req.query as { refresh?: string };
    const forceRefresh = query.refresh === "true";
    try {
      const regimeStatus = await getCurrentRegime({ forceRefresh });
      const tiers = getV7AvailableTiers(regimeStatus.regime);
      return {
        status: "ok",
        regime: regimeStatus.regime,
        dvol: regimeStatus.dvol,
        rvol: regimeStatus.rvol,
        source: regimeStatus.source,
        timestamp: regimeStatus.timestamp,
        tiers,
        v7Enabled: pilotConfig.v7.enabled,
        defaultTenorDays: pilotConfig.v7.defaultTenorDays,
        thresholds: {
          calmBelow: pilotConfig.v7.dvolCalmThreshold,
          stressAbove: pilotConfig.v7.dvolStressThreshold
        }
      };
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "regime_unavailable",
        message: String(error?.message || "Failed to fetch regime status")
      };
    }
  });

  app.get("/pilot/deribit/pricing", async (req, reply) => {
    const query = req.query as { notional?: string; tenorDays?: string; protectionType?: string };
    const notional = Number(query.notional || 10000);
    const tenorDays = Number(query.tenorDays || pilotConfig.v7.defaultTenorDays);
    const protectionType = String(query.protectionType || "long") as "long" | "short";
    if (!Number.isFinite(notional) || notional <= 0) {
      reply.code(400);
      return { status: "error", reason: "invalid_notional" };
    }
    try {
      const spot = await (async () => {
        const ticker = await deps.deribit.getIndexPrice("btc_usd");
        const price = Number((ticker as any)?.result?.index_price ?? 0);
        if (!Number.isFinite(price) || price <= 0) throw new Error("deribit_spot_unavailable");
        return price;
      })();
      const quantity = notional / spot;
      const slTiers = [1, 2, 3, 5, 10] as const;
      const results: Record<number, {
        slPct: number;
        triggerPrice: number;
        strike: number | null;
        instrument: string | null;
        askBtc: number | null;
        hedgeCostUsd: number | null;
        hedgeCostPer1kUsd: number | null;
        available: boolean;
        reason: string | null;
      }> = {};

      for (const slPct of slTiers) {
        const drawdown = slPct / 100;
        const triggerPrice = protectionType === "short"
          ? spot * (1 + drawdown)
          : spot * (1 - drawdown);
        try {
          const dq = await deribitVenue.quote({
            marketId: "BTC-USD",
            instrumentId: `BTC-USD-${tenorDays}D-P`,
            protectedNotional: notional,
            quantity,
            side: "buy",
            protectionType,
            drawdownFloorPct: drawdown,
            triggerPrice,
            requestedTenorDays: tenorDays
          });
          const details = (dq.details || {}) as Record<string, unknown>;
          const askBtc = Number(details.askPriceBtc ?? 0);
          const hedgeCostUsd = dq.premium;
          const hedgeCostPer1kUsd = hedgeCostUsd / (notional / 1000);
          results[slPct] = {
            slPct,
            triggerPrice: Number(triggerPrice.toFixed(2)),
            strike: Number(details.selectedStrike ?? 0) || null,
            instrument: dq.instrumentId || null,
            askBtc: Number.isFinite(askBtc) && askBtc > 0 ? askBtc : null,
            hedgeCostUsd: Number(hedgeCostUsd.toFixed(2)),
            hedgeCostPer1kUsd: Number(hedgeCostPer1kUsd.toFixed(2)),
            available: true,
            reason: null
          };
        } catch (err: any) {
          results[slPct] = {
            slPct,
            triggerPrice: Number(triggerPrice.toFixed(2)),
            strike: null,
            instrument: null,
            askBtc: null,
            hedgeCostUsd: null,
            hedgeCostPer1kUsd: null,
            available: false,
            reason: String(err?.message || "unavailable")
          };
        }
      }

      let regimeStatus;
      try { regimeStatus = await getCurrentRegime(); } catch { regimeStatus = null; }

      return {
        status: "ok",
        venue: "deribit_live",
        btcSpot: Number(spot.toFixed(2)),
        notionalUsd: notional,
        tenorDays,
        protectionType,
        regime: regimeStatus?.regime ?? "normal",
        dvol: regimeStatus?.dvol ?? null,
        slTiers: results,
        timestamp: new Date().toISOString()
      };
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "deribit_pricing_unavailable",
        message: String(error?.message || "Failed to fetch Deribit pricing")
      };
    }
  });

  app.get("/pilot/health", async (_req, reply) => {
    const requestId = pilotConfig.nextRequestId();
    let db: Record<string, unknown>;
    try {
      await withTimeout(pool.query("SELECT 1"), 2000, "db_health");
      db = { status: "ok" };
    } catch (error: any) {
      db = {
        status: "degraded",
        detail: String(error?.message || "db_health_failed")
      };
    }

    let price: Record<string, unknown>;
    try {
      const snapshot = await withTimeout(
        resolvePriceSnapshot(
          {
            primaryUrl: pilotConfig.referencePriceUrl,
            fallbackUrl: pilotConfig.singlePriceSource ? "" : pilotConfig.fallbackPriceUrl,
            primaryTimeoutMs: pilotConfig.pricePrimaryTimeoutMs,
            fallbackTimeoutMs: pilotConfig.priceFallbackTimeoutMs,
            freshnessMaxMs: pilotConfig.priceFreshnessMaxMs,
            requestRetryAttempts: pilotConfig.priceRequestRetryAttempts,
            requestRetryDelayMs: pilotConfig.priceRequestRetryDelayMs
          },
          {
            marketId: pilotConfig.referenceMarketId || "BTC-USD",
            now: new Date(),
            requestId,
            endpointVersion: pilotConfig.endpointVersion
          }
        ),
        Math.max(
          1000,
          Math.max(
            Number(pilotConfig.pricePrimaryTimeoutMs || 0),
            Number(pilotConfig.priceFallbackTimeoutMs || 0)
          ) + 1000
        ),
        "price_health"
      );
      price = {
        status: "ok",
        marketId: snapshot.marketId,
        source: snapshot.priceSource,
        timestamp: snapshot.priceTimestamp
      };
    } catch (error: any) {
      price = {
        status: "degraded",
        detail: String(error?.message || "price_health_failed")
      };
    }

    const venue = await resolvePilotVenueHealth();
    const overallOk = db.status === "ok" && price.status === "ok" && isIbkrLiveTransportHealthy(venue);
    reply.code(overallOk ? 200 : 503);
    return {
      status: overallOk ? "ok" : "degraded",
      requestId,
      checks: {
        db,
        price,
        venue
      }
    };
  });

  app.get("/pilot/tenor-policy", async (_req, reply) => {
    try {
      const policy = await resolveDynamicTenorPolicy({
        pool,
        nowIso: new Date().toISOString()
      });
      return policy;
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "tenor_policy_unavailable",
        message: "Tenor policy unavailable, using static tenor controls.",
        detail: String(error?.message || "tenor_policy_unavailable")
      };
    }
  });

  app.get("/pilot/admin/diagnostics/selector", async (req, reply) => {
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const diagnosticsRaw =
      pilotConfig.venueMode === "ibkr_cme_live" || pilotConfig.venueMode === "ibkr_cme_paper"
        ? venue.getDiagnostics()
        : null;
    const diagnostics =
      diagnosticsRaw && typeof diagnosticsRaw === "object"
        ? diagnosticsRaw
        : {
            asOf: new Date().toISOString(),
            requestId: null,
            venueMode: pilotConfig.venueMode,
            timingsMs: { total: 0, qualify: 0, top: 0, depth: 0, score: 0 },
            counters: {
              qualifyCalls: 0,
              qualifyCacheHits: 0,
              qualifyCacheMisses: 0,
              topCalls: 0,
              depthCalls: 0,
              depthRetries: 0,
              optionsFamiliesTried: 0,
              optionsLegTimedOut: 0
            },
            optionCandidateFailureCounts: {
              nTotalCandidates: 0,
              nNoTop: 0,
              nNoAsk: 0,
              nFailedProtection: 0,
              nFailedEconomics: 0,
              nFailedWideSpread: 0,
              nFailedThinDepth: 0,
              nFailedStaleTop: 0,
              nTimedOut: 0,
              nPassed: 0
            }
          };
    return {
      status: "ok",
      diagnostics
    };
  });

  app.get("/pilot/admin/diagnostics/execution-quality", async (req, reply) => {
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const lookbackDaysRaw = Number((req.query as { lookbackDays?: string })?.lookbackDays || "30");
    const lookbackDays = Number.isFinite(lookbackDaysRaw)
      ? Math.max(1, Math.min(365, Math.floor(lookbackDaysRaw)))
      : 30;
    const rows = await listExecutionQualityRecent(pool, { lookbackDays, limit: 365 });
    return {
      status: "ok",
      lookbackDays,
      rows
    };
  });

  app.get("/pilot/admin/governance/rollout-guards", async (req, reply) => {
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const lookbackMinutesRaw = Number((req.query as { lookbackMinutes?: string })?.lookbackMinutes || "1440");
    const lookbackMinutes = Number.isFinite(lookbackMinutesRaw)
      ? Math.max(60, Math.min(7 * 24 * 60, Math.floor(lookbackMinutesRaw)))
      : 1440;
    const diagnostics = await listRecentQuoteDiagnostics(pool, {
      lookbackMinutes,
      limit: 5000
    });
    const total = diagnostics.length;
    const triggerHits = diagnostics.filter((row) => Number(row.treasuryQuoteSubsidyUsd || 0) > 0).length;
    const triggerHitRatePct = total > 0 ? (triggerHits / total) * 100 : 0;
    const subsidyUtilizationPct =
      total > 0
        ? diagnostics.reduce((acc, row) => acc + Number(row.subsidyUtilizationPct || 0), 0) / total
        : 0;
    const treasuryDrawdownPct =
      total > 0
        ? diagnostics.reduce((acc, row) => acc + Number(row.treasuryDrawdownPct || 0), 0) / total
        : 0;
    const fallback =
      triggerHitRatePct >= pilotConfig.rolloutGuards.fallbackTriggerHitRatePct ||
      subsidyUtilizationPct >= pilotConfig.rolloutGuards.fallbackSubsidyUtilizationPct ||
      treasuryDrawdownPct >= pilotConfig.rolloutGuards.fallbackTreasuryDrawdownPct;
    const pause =
      triggerHitRatePct >= pilotConfig.rolloutGuards.pauseTriggerHitRatePct ||
      subsidyUtilizationPct >= pilotConfig.rolloutGuards.pauseSubsidyUtilizationPct ||
      treasuryDrawdownPct >= pilotConfig.rolloutGuards.pauseTreasuryDrawdownPct;
    const action = pause ? "issuance_pause" : fallback ? "strict_fallback" : "normal_hybrid_ok";
    return {
      status: "ok",
      lookbackMinutes,
      sampleCount: total,
      action,
      metrics: {
        triggerHitRatePct,
        subsidyUtilizationPct,
        treasuryDrawdownPct
      },
      thresholds: pilotConfig.rolloutGuards
    };
  });

  app.post("/pilot/protections/quote", async (req, reply) => {
    if (!enforcePilotWindow(reply)) return;
    const body = req.body as {
      protectedNotional?: number;
      foxifyExposureNotional?: number;
      entryPrice?: number;
      tenorDays?: number;
      strictTenor?: boolean | string;
      instrumentId?: string;
      marketId?: string;
      clientOrderId?: string;
      tierName?: string;
      slPct?: number;
      drawdownFloorPct?: number;
      protectionType?: "long" | "short";
      venue?: string;
    };
    const quoteStartedAt = Date.now();
    const requestedVenue = body.venue === "deribit" ? deribitVenue : venue;
    const protectedNotional = parsePositiveDecimal(body.protectedNotional);
    const exposureNotional = parsePositiveDecimal(body.foxifyExposureNotional);
    const entryInputPrice = parsePositiveDecimal(body.entryPrice);
    if (!protectedNotional) {
      reply.code(400);
      return { status: "error", reason: "invalid_protected_notional" };
    }
    if (!exposureNotional) {
      reply.code(400);
      return { status: "error", reason: "invalid_exposure_notional" };
    }
    const quoteMinNotional = resolveQuoteMinNotionalFloor();
    if (protectedNotional.lt(quoteMinNotional)) {
      reply.code(400);
      return {
        status: "error",
        reason: "quote_min_notional_not_met",
        message: `Minimum quote notional is $${quoteMinNotional.toFixed(0)} during pilot.`,
        minQuoteNotionalUsdc: quoteMinNotional.toFixed(2)
      };
    }
    const maxProtection = new Decimal(pilotConfig.maxProtectionNotionalUsdc);
    const maxDailyProtection = new Decimal(pilotConfig.maxDailyProtectedNotionalUsdc);
    if (protectedNotional.gt(maxProtection)) {
      reply.code(400);
      return {
        status: "error",
        reason: "protection_notional_cap_exceeded",
        capUsdc: maxProtection.toFixed(2)
      };
    }
    if (protectedNotional.gt(exposureNotional)) {
      reply.code(400);
      return { status: "error", reason: "protected_notional_exceeds_exposure" };
    }
    let userHash: { userHash: string; hashVersion: number };
    try {
      userHash = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    let dailyUsed: Decimal;
    try {
      dailyUsed = new Decimal(
        await getDailyProtectedNotionalForUser(
          pool,
          userHash.userHash,
          dayStart.toISOString(),
          dayEnd.toISOString()
        )
      );
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "storage_unavailable",
        message: "Storage temporarily unavailable, please retry.",
        detail: String(error?.message || "daily_limit_query_failed")
      };
    }
    const projectedDaily = dailyUsed.plus(protectedNotional);
    const marketId = pilotConfig.referenceMarketId;
    const protectionType = normalizeProtectionType(body.protectionType);
    const optionType = protectionType === "short" ? "C" : "P";
    const triggerLabel = protectionType === "short" ? "ceiling_price" : "floor_price";
    const v7Enabled = pilotConfig.v7.enabled;
    const rawSlPct = Number(body.slPct ?? body.drawdownFloorPct ? undefined : undefined);
    const slPctInput = body.slPct != null ? Number(body.slPct) : null;
    const validSlPct = slPctInput !== null && isValidSlTier(slPctInput) ? slPctInput as V7SlTier : null;
    let tierName: string;
    let drawdownFloorPct: Decimal;
    let resolvedSlPct: V7SlTier | null = null;
    let v7Quote: V7PremiumQuote | null = null;
    if (v7Enabled && validSlPct) {
      resolvedSlPct = validSlPct;
      tierName = slPctToTierLabel(validSlPct);
      drawdownFloorPct = slPctToDrawdownFloor(validSlPct);
    } else if (v7Enabled && !validSlPct && body.slPct != null) {
      reply.code(400);
      return { status: "error", reason: "invalid_sl_pct", message: "slPct must be one of: 1, 2, 3, 5, 10" };
    } else {
      tierName = normalizeTierName(body.tierName);
      drawdownFloorPct = isLockedBullishProfile
        ? resolveLockedDrawdownFloorPct(tierName)
        : resolveDrawdownFloorPct({
            tierName,
            drawdownFloorPct: body.drawdownFloorPct
          });
    }
    const defaultTenorDays = v7Enabled && resolvedSlPct ? getV7TenorDays(resolvedSlPct) : v7Enabled ? pilotConfig.v7.defaultTenorDays : 7;
    const quoteInstrumentId = body.instrumentId || `${marketId}-${defaultTenorDays}D-${optionType}`;
    const requestId = pilotConfig.nextRequestId();
    let priceMs = 0;
    let venueMs = 0;
    let tenorPolicy: TenorPolicyResponse | null = null;
    let snapshot: PriceSnapshotOutput;
    try {
      const priceStartedAt = Date.now();
      snapshot = await resolvePriceSnapshot(
        {
          primaryUrl: pilotConfig.referencePriceUrl,
          fallbackUrl: pilotConfig.singlePriceSource ? "" : pilotConfig.fallbackPriceUrl,
          primaryTimeoutMs: pilotConfig.pricePrimaryTimeoutMs,
          fallbackTimeoutMs: pilotConfig.priceFallbackTimeoutMs,
          freshnessMaxMs: pilotConfig.priceFreshnessMaxMs,
          requestRetryAttempts: pilotConfig.priceRequestRetryAttempts,
          requestRetryDelayMs: pilotConfig.priceRequestRetryDelayMs
        },
        {
          marketId,
          now: new Date(),
          requestId,
          endpointVersion: pilotConfig.endpointVersion
        }
      );
      priceMs = Date.now() - priceStartedAt;
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "price_unavailable",
        message: "Price temporarily unavailable, please retry.",
        detail: String(error?.message || "price_chain_error"),
        diagnostics: { requestId, stage: "price_snapshot", elapsedMs: Date.now() - quoteStartedAt }
      };
    }
    try {
      const entryAnchorPrice = snapshot.price;
      const quantity = protectedNotional.div(entryAnchorPrice).toDecimalPlaces(8).toNumber();
      const triggerPrice = computeTriggerPrice(entryAnchorPrice, drawdownFloorPct, protectionType);
      const triggerPayoutCreditUsd = computeDrawdownLossBudgetUsd(protectedNotional, drawdownFloorPct);
      const requestedTenorDays = isLockedBullishProfile
        ? lockedProfileTenorDays
        : resolveExpiryDays({
            tierName,
            requestedDays: Number((body as { tenorDays?: number }).tenorDays),
            minDays: pilotConfig.pilotTenorMinDays,
            maxDays: pilotConfig.pilotTenorMaxDays,
            defaultDays: pilotConfig.pilotTenorDefaultDays
          });
      let venueRequestedTenorDays = requestedTenorDays;
      let tenorPolicyFallbackApplied = false;
      let tenorPolicyFallbackReason: string | null = null;
      if (pilotConfig.dynamicTenorEnabled && !isLockedBullishProfile) {
        tenorPolicy = await resolveDynamicTenorPolicy({
          pool,
          nowIso: new Date().toISOString()
        });
        const enabledTenors = tenorPolicy.selection?.enabledTenorsDays || [];
        const defaultTenor = tenorPolicy.selection?.defaultTenorDays || requestedTenorDays;
        const requestedIsCandidate = pilotConfig.tenorPolicyCandidateDays.includes(requestedTenorDays);
        const degradedWithNoEnabled =
          tenorPolicy.selection?.status === "degraded" && Array.isArray(enabledTenors) && enabledTenors.length === 0;
        if (!enabledTenors.includes(requestedTenorDays)) {
          if (pilotConfig.tenorPolicyAutoRoute && enabledTenors.length > 0) {
            venueRequestedTenorDays = enabledTenors.includes(defaultTenor) ? defaultTenor : enabledTenors[0];
          } else if (degradedWithNoEnabled && pilotConfig.tenorPolicyEnforce && requestedIsCandidate) {
            // Deadlock guard: allow candidate tenor quotes when policy has no enabled tenors during warmup/degraded windows.
            venueRequestedTenorDays = requestedTenorDays;
            tenorPolicyFallbackApplied = true;
            tenorPolicyFallbackReason = "degraded_policy_allow_requested_candidate";
          } else if (pilotConfig.tenorPolicyEnforce) {
            throw new Error("tenor_temporarily_unavailable");
          }
        }
      }
      const venueStartedAt = Date.now();
      const quote = await withTimeout(
        requestedVenue.quote({
          marketId,
          protectedNotional: protectedNotional.toNumber(),
          quantity,
          side: "buy",
          instrumentId: quoteInstrumentId,
          protectionType,
          drawdownFloorPct: drawdownFloorPct.toNumber(),
          triggerPrice: triggerPrice.toNumber(),
          requestedTenorDays: venueRequestedTenorDays,
          tenorMinDays: pilotConfig.pilotTenorMinDays,
          tenorMaxDays: pilotConfig.pilotTenorMaxDays,
          hedgePolicy: pilotConfig.pilotHedgePolicy,
          clientOrderId: body.clientOrderId,
          strictTenor: isLockedBullishProfile ? true : parseBoolean(body.strictTenor, false),
          details: {
            triggerPayoutCreditUsd: triggerPayoutCreditUsd.toNumber()
          }
        }),
        pilotConfig.venueQuoteTimeoutMs,
        "venue_quote"
      );
      venueMs = Date.now() - venueStartedAt;
      const selectedTenorDaysRaw =
        quote.details && Number.isFinite(Number((quote.details as Record<string, unknown>).selectedTenorDays))
          ? Number((quote.details as Record<string, unknown>).selectedTenorDays)
          : null;
      const tenorReason = resolveTenorReason({
        requestedTenorDays,
        venueRequestedTenorDays,
        selectedTenorDays: selectedTenorDaysRaw,
        policyFallbackApplied: tenorPolicyFallbackApplied,
        policyFallbackReason: tenorPolicyFallbackReason
      });
      const pricingModeForSelection = isLockedBullishProfile
        ? lockedProfilePricingMode
        : pilotConfig.premiumPricingMode;
      let premiumPricing = resolvePremiumPricing({
        tierName,
        pricingMode: pricingModeForSelection,
        protectedNotional,
        drawdownFloorPct,
        hedgePremium: new Decimal(quote.premium),
        brokerFees: estimateBrokerFeesUsd({
          venue: quote.venue,
          quantity: quote.quantity,
          details: quote.details as Record<string, unknown> | undefined
        })
      });
      const roundedPremiumDisplay = resolvePilotRoundedPremiumDisplay({
        tierName,
        protectedNotionalUsd: protectedNotional,
        drawdownFloorPct
      });
      let premiumRegimeMetrics: PremiumRegimeMetrics = {
        sampleCount: 0,
        triggerHitRatePct: 0,
        subsidyUtilizationPct: 0,
        treasuryDrawdownPct: 0
      };
      try {
        premiumRegimeMetrics = await resolvePremiumRegimeMetrics(pool);
      } catch {
        // Fail-open: do not block quotes on telemetry/diagnostics availability.
      }
      const premiumRegimeDecision = resolvePremiumRegime({
        scopeKey: PREMIUM_REGIME_SCOPE_KEY,
        config: pilotConfig.premiumRegime,
        metrics: premiumRegimeMetrics
      });
      let premiumRegimeOverlay = applyPremiumRegimeOverlay({
        basePremiumUsd: premiumPricing.clientPremiumUsd,
        protectedNotionalUsd: protectedNotional,
        regime: premiumRegimeDecision.regime,
        config: pilotConfig.premiumRegime,
        enabledForPricingMode:
          premiumPricing.pricingMode === "hybrid_otm_treasury" || pilotConfig.premiumRegime.applyToActuarialStrict
      });
      if (premiumRegimeOverlay.applied) {
        premiumPricing = {
          ...premiumPricing,
          clientPremiumUsd: premiumRegimeOverlay.adjustedPremiumUsd
        };
      }
      // V7 Flat Pricing Override — $8/1k, all tiers, all conditions
      if (v7Enabled && resolvedSlPct) {
        v7Quote = computeV7Premium({
          slPct: resolvedSlPct,
          notionalUsd: protectedNotional.toNumber()
        });
        console.log(`[V7Pricing] slPct=${resolvedSlPct} premium=$${v7Quote.premiumUsd.toFixed(2)} per1k=$${v7Quote.premiumPer1kUsd}`);
        premiumPricing = {
          ...premiumPricing,
          clientPremiumUsd: new Decimal(v7Quote.premiumUsd)
        };
      }
      const selectionPremiumInputsFromPricing = () => ({
        triggerPayoutCreditUsd: triggerPayoutCreditUsd.toNumber(),
        expectedTriggerCostUsd: Number(premiumPricing.expectedTriggerCostUsd.toFixed(10)),
        expectedTriggerCreditUsd: Number(premiumPricing.expectedTriggerCreditUsd.toFixed(10)),
        premiumProfitabilityTargetUsd: Number(premiumPricing.premiumProfitabilityTargetUsd.toFixed(10))
      });
      let selectionPremiumInputs = selectionPremiumInputsFromPricing();
      let treasuryFallbackApplied: "none" | "per_quote_cap" | "daily_cap" = "none";
      const applyStrictPricingFallback = (reason: "per_quote_cap" | "daily_cap"): void => {
        premiumPricing = resolvePremiumPricing({
          tierName,
          pricingMode: "actuarial_strict",
          protectedNotional,
          drawdownFloorPct,
          hedgePremium: new Decimal(quote.premium),
          brokerFees: estimateBrokerFeesUsd({
            venue: quote.venue,
            quantity: quote.quantity,
            details: quote.details as Record<string, unknown> | undefined
          })
        });
        premiumRegimeOverlay = applyPremiumRegimeOverlay({
          basePremiumUsd: premiumPricing.clientPremiumUsd,
          protectedNotionalUsd: protectedNotional,
          regime: premiumRegimeDecision.regime,
          config: pilotConfig.premiumRegime,
          enabledForPricingMode:
            premiumPricing.pricingMode === "hybrid_otm_treasury" || pilotConfig.premiumRegime.applyToActuarialStrict
        });
        if (premiumRegimeOverlay.applied) {
          premiumPricing = {
            ...premiumPricing,
            clientPremiumUsd: premiumRegimeOverlay.adjustedPremiumUsd
          };
        }
        selectionPremiumInputs = selectionPremiumInputsFromPricing();
        treasuryFallbackApplied = reason;
      };
      const requestedByUserHash = String((req.headers["x-user-id"] as string | undefined) || userHash.userHash);
      let quoteSubsidyUsd = new Decimal(0);
      const quoteSubsidyCapUsd = triggerPayoutCreditUsd.mul(new Decimal(pilotConfig.treasuryPerQuoteSubsidyCapPct));
      if (!v7Enabled) {
      quoteSubsidyUsd = Decimal.max(
        new Decimal(0),
        premiumPricing.premiumProfitabilityTargetUsd.minus(premiumPricing.clientPremiumUsd)
      );
      if (quoteSubsidyUsd.gt(quoteSubsidyCapUsd)) {
        const strictFallbackEnabled =
          pilotConfig.treasuryStrictFallbackEnabled && pricingModeForSelection === "hybrid_otm_treasury";
        if (!strictFallbackEnabled) {
          reply.code(409);
          return {
            status: "error",
            reason: "treasury_subsidy_per_quote_cap_exceeded",
            quoteSubsidyUsd: quoteSubsidyUsd.toFixed(10),
            subsidyCapUsd: quoteSubsidyCapUsd.toFixed(10)
          };
        }
        applyStrictPricingFallback("per_quote_cap");
        quoteSubsidyUsd = Decimal.max(
          new Decimal(0),
          premiumPricing.premiumProfitabilityTargetUsd.minus(premiumPricing.clientPremiumUsd)
        );
      }
      if (quoteSubsidyUsd.gt(0)) {
        const subsidyUsage = await reserveDailyTreasurySubsidyCapacity(pool, {
          userHash: requestedByUserHash,
          dayStartIso: dayStart.toISOString(),
          subsidyAmount: quoteSubsidyUsd.toFixed(10),
          maxDailySubsidy: new Decimal(pilotConfig.treasuryDailySubsidyCapUsdc).toFixed(10)
        });
        if (!subsidyUsage.ok) {
          const strictFallbackEnabled =
            pilotConfig.treasuryStrictFallbackEnabled && pricingModeForSelection === "hybrid_otm_treasury";
          if (!strictFallbackEnabled) {
            reply.code(409);
            return {
              status: "error",
              reason: "treasury_subsidy_daily_cap_exceeded",
              subsidyUsedUsd: subsidyUsage.usedNow,
              subsidyProjectedUsd: new Decimal(subsidyUsage.usedNow).plus(quoteSubsidyUsd).toFixed(10),
              subsidyCapUsd: new Decimal(pilotConfig.treasuryDailySubsidyCapUsdc).toFixed(10)
            };
          }
          applyStrictPricingFallback("daily_cap");
          quoteSubsidyUsd = Decimal.max(
            new Decimal(0),
            premiumPricing.premiumProfitabilityTargetUsd.minus(premiumPricing.clientPremiumUsd)
          );
          if (quoteSubsidyUsd.gt(0)) {
            reply.code(409);
            return {
              status: "error",
              reason: "treasury_subsidy_daily_cap_exceeded",
              subsidyUsedUsd: subsidyUsage.usedNow,
              subsidyProjectedUsd: new Decimal(subsidyUsage.usedNow).plus(quoteSubsidyUsd).toFixed(10),
              subsidyCapUsd: new Decimal(pilotConfig.treasuryDailySubsidyCapUsdc).toFixed(10)
            };
          }
        } else {
          await releaseDailyTreasurySubsidyCapacity(pool, {
            userHash: requestedByUserHash,
            dayStartIso: dayStart.toISOString(),
            subsidyAmount: quoteSubsidyUsd.toFixed(10)
          });
        }
      }
      } // end if (!v7Enabled) treasury subsidy check
      let treasuryStartingReserveUsdc = new Decimal(pilotConfig.startingReserveUsdc);
      let treasuryReserveAfterOpenLiabilityUsdc = new Decimal(pilotConfig.startingReserveUsdc);
      try {
        const treasurySnapshot = await getPilotAdminMetrics(pool, {
          startingReserveUsdc: pilotConfig.startingReserveUsdc,
          userHash: userHash.userHash,
          scope: "open"
        });
        treasuryStartingReserveUsdc = new Decimal(treasurySnapshot.startingReserveUsdc || pilotConfig.startingReserveUsdc);
        treasuryReserveAfterOpenLiabilityUsdc = new Decimal(
          treasurySnapshot.reserveAfterOpenPayoutLiabilityUsdc || treasuryStartingReserveUsdc
        );
      } catch {
        // Keep defaults when treasury snapshot is unavailable.
      }
      const treasuryDrawdownPct = treasuryStartingReserveUsdc.gt(0)
        ? Decimal.max(
            new Decimal(0),
            Decimal.min(
              new Decimal(100),
              treasuryStartingReserveUsdc
                .minus(treasuryReserveAfterOpenLiabilityUsdc)
                .div(treasuryStartingReserveUsdc)
                .mul(100)
            )
          )
        : new Decimal(0);
      const estimatedPremiumPolicyDiagnostics = buildPremiumPolicyDiagnostics({
        estimated: premiumPricing
      });
      if (!v7Enabled) {
        const FIXED_PREMIUM_PER_1K = new Decimal(11);
        if (isLockedBullishProfile) {
          const fixedClientPremium = protectedNotional.div(1000).mul(FIXED_PREMIUM_PER_1K);
          premiumPricing = {
            ...premiumPricing,
            clientPremiumUsd: fixedClientPremium,
          };
        }
      }
      const pricingBreakdown = {
        pricingMode: premiumPricing.pricingMode,
        hedgePremiumUsd: premiumPricing.hedgePremiumUsd.toFixed(10),
        brokerFeesUsd: premiumPricing.brokerFeesUsd.toFixed(10),
        passThroughUsd: premiumPricing.passThroughUsd.toFixed(10),
        expectedTriggerCreditUsd: premiumPricing.expectedTriggerCreditUsd.toFixed(10),
        expectedTriggerCostUsd: premiumPricing.expectedTriggerCostUsd.toFixed(10),
        selectionFeasibilityPenaltyUsd: premiumPricing.selectionFeasibilityPenaltyUsd.toFixed(10),
        profitabilityBufferUsd: premiumPricing.profitabilityBufferUsd.toFixed(10),
        profitabilityFloorUsd: premiumPricing.profitabilityFloorUsd.toFixed(10),
        premiumProfitabilityTargetUsd: premiumPricing.premiumProfitabilityTargetUsd.toFixed(10),
        premiumProfitabilityTargetRatio: premiumPricing.premiumProfitabilityTargetRatio.toFixed(10),
        premiumFloorUsdTriggerCredit: premiumPricing.premiumFloorUsdTriggerCredit.toFixed(10),
        markupPct: premiumPricing.markupPct.toFixed(6),
        markupUsd: premiumPricing.markupUsd.toFixed(10),
        premiumFloorUsdAbsolute: premiumPricing.premiumFloorUsdAbsolute.toFixed(10),
        premiumFloorUsdFromBps: premiumPricing.premiumFloorUsdFromBps.toFixed(10),
        premiumFloorBps: premiumPricing.premiumFloorBps.toFixed(2),
        premiumFloorUsd: premiumPricing.premiumFloorUsd.toFixed(10),
        strictClientPremiumUsd: premiumPricing.strictClientPremiumUsd.toFixed(10),
        hybridStrictMultiplier: premiumPricing.hybridStrictMultiplier.toFixed(6),
        hybridDiscountedStrictPremiumUsd: premiumPricing.hybridDiscountedStrictPremiumUsd.toFixed(10),
        clientPremiumUsd: premiumPricing.clientPremiumUsd.toFixed(10),
        displayedPremiumPer1kUsd: roundedPremiumDisplay.roundedPremiumPer1kUsd.toFixed(2),
        displayedPremiumUsd: roundedPremiumDisplay.roundedClientPremiumUsd.toFixed(2),
        method: premiumPricing.method,
        treasuryQuoteSubsidyUsd: quoteSubsidyUsd.toFixed(10),
        treasuryPerQuoteSubsidyCapUsd: quoteSubsidyCapUsd.toFixed(10),
        treasuryDailySubsidyCapUsdc: new Decimal(pilotConfig.treasuryDailySubsidyCapUsdc).toFixed(10),
        treasuryStartingReserveUsdc: treasuryStartingReserveUsdc.toFixed(10),
        treasuryReserveAfterOpenLiabilityUsdc: treasuryReserveAfterOpenLiabilityUsdc.toFixed(10),
        treasuryDrawdownPct: treasuryDrawdownPct.toFixed(6),
        treasuryFallbackApplied,
        treasuryStrictFallbackEnabled: pilotConfig.treasuryStrictFallbackEnabled,
        premiumRegimeEnabled: pilotConfig.premiumRegime.enabled,
        premiumRegimeLevel: premiumRegimeDecision.regime,
        premiumRegimePreviousLevel: premiumRegimeDecision.previousRegime,
        premiumRegimeChanged: premiumRegimeDecision.changed,
        premiumRegimeReason: premiumRegimeDecision.reason,
        premiumRegimeHoldMinutesRemaining: premiumRegimeDecision.holdMinutesRemaining,
        premiumRegimeSampleCount: premiumRegimeDecision.metrics.sampleCount,
        premiumRegimeTriggerHitRatePct: Number(premiumRegimeDecision.metrics.triggerHitRatePct.toFixed(6)),
        premiumRegimeSubsidyUtilizationPct: Number(premiumRegimeDecision.metrics.subsidyUtilizationPct.toFixed(6)),
        premiumRegimeTreasuryDrawdownPct: Number(premiumRegimeDecision.metrics.treasuryDrawdownPct.toFixed(6)),
        premiumRegimeOverlayApplied: premiumRegimeOverlay.applied,
        premiumRegimeOverlayUsd: premiumRegimeOverlay.overlayUsd.toFixed(10),
        premiumRegimeOverlayPctOfBase: premiumRegimeOverlay.overlayPctOfBase.toFixed(10),
        premiumRegimeOverlayMultiplier: premiumRegimeOverlay.multiplier.toFixed(10),
        premiumRegimeOverlayAddUsdPer1k: premiumRegimeOverlay.addUsdPer1k.toFixed(10),
        premiumRegimeBasePremiumUsd: premiumRegimeOverlay.basePremiumUsd.toFixed(10),
        premiumRegimeAdjustedPremiumUsd: premiumRegimeOverlay.adjustedPremiumUsd.toFixed(10),
        ...selectionPremiumInputs
      };
      await insertVenueQuote(pool, {
        ...quote,
        details: {
          ...(quote.details || {}),
          ...selectionPremiumInputs,
          tenorReason,
          pricingBreakdown,
          lockContext: {
            requestedInstrumentId: quoteInstrumentId,
            quoteInstrumentId: quote.instrumentId,
            selectedInstrumentId:
              quote.details && typeof (quote.details as Record<string, unknown>).selectedInstrumentId === "string"
                ? String((quote.details as Record<string, unknown>).selectedInstrumentId)
                : null,
            bullishSymbol:
              quote.details && typeof (quote.details as Record<string, unknown>).bullishSymbol === "string"
                ? String((quote.details as Record<string, unknown>).bullishSymbol)
                : null,
            marketId,
            tierName,
            profile: pilotConfig.lockedProfile.name,
            fixedTenorDays: lockedProfileTenorDays,
            fixedPricingMode: lockedProfilePricingMode,
            drawdownFloorPct: drawdownFloorPct.toFixed(6),
            protectedNotional: protectedNotional.toFixed(10),
            quoteMinNotionalUsdc: quoteMinNotional.toFixed(10),
            foxifyExposureNotional: exposureNotional.toFixed(10),
            entryPrice: entryAnchorPrice.toFixed(10),
            entryAnchorPrice: entryAnchorPrice.toFixed(10),
            entryPriceSource: "reference_snapshot_quote",
            entryPriceTimestamp: snapshot.priceTimestamp,
            entryInputPrice: entryInputPrice ? entryInputPrice.toFixed(10) : null,
            protectionType,
            optionType,
            requestedTenorDays,
            venueRequestedTenorDays,
            tenorPolicyStatus:
              tenorPolicy && pilotConfig.dynamicTenorEnabled
                ? String(tenorPolicy.selection?.status || "")
                : null,
            tenorPolicyFallbackApplied,
            tenorPolicyFallbackReason,
            triggerPrice: triggerPrice.toFixed(10),
            triggerLabel,
            floorPrice: triggerPrice.toFixed(10),
            selectedStrike:
              quote.details && Number.isFinite(Number((quote.details as Record<string, unknown>).selectedStrike))
                ? Number((quote.details as Record<string, unknown>).selectedStrike).toFixed(10)
                : null,
            strikeGapToTriggerUsd:
              quote.details &&
              Number.isFinite(Number((quote.details as Record<string, unknown>).strikeGapToTriggerUsd))
                ? Number((quote.details as Record<string, unknown>).strikeGapToTriggerUsd).toFixed(10)
                : null,
            strikeGapToTriggerPct:
              quote.details &&
              Number.isFinite(Number((quote.details as Record<string, unknown>).strikeGapToTriggerPct))
                ? Number((quote.details as Record<string, unknown>).strikeGapToTriggerPct).toFixed(10)
                : null,
            selectedTenorDays:
              quote.details && Number.isFinite(Number((quote.details as Record<string, unknown>).selectedTenorDays))
                ? Number((quote.details as Record<string, unknown>).selectedTenorDays).toFixed(10)
                : null,
            tenorReason,
            selectedExpiry:
              quote.details && typeof (quote.details as Record<string, unknown>).selectedExpiry === "string"
                ? String((quote.details as Record<string, unknown>).selectedExpiry)
                : null,
            tenorDriftDays:
              quote.details && Number.isFinite(Number((quote.details as Record<string, unknown>).tenorDriftDays))
                ? Number((quote.details as Record<string, unknown>).tenorDriftDays).toFixed(10)
                : null,
            deribitQuotePolicy:
              quote.details && typeof (quote.details as Record<string, unknown>).deribitQuotePolicy === "string"
                ? String((quote.details as Record<string, unknown>).deribitQuotePolicy)
                : null,
            strikeSelectionMode:
              quote.details && typeof (quote.details as Record<string, unknown>).strikeSelectionMode === "string"
                ? String((quote.details as Record<string, unknown>).strikeSelectionMode)
                : null,
            selectionReason:
              quote.details && typeof (quote.details as Record<string, unknown>).selectionReason === "string"
                ? String((quote.details as Record<string, unknown>).selectionReason)
                : null,
            hedgeInstrumentFamily:
              quote.details &&
              ((quote.details as Record<string, unknown>).hedgeInstrumentFamily === "BFF" ||
                (quote.details as Record<string, unknown>).hedgeInstrumentFamily === "MBT")
                ? String((quote.details as Record<string, unknown>).hedgeInstrumentFamily)
                : null,
            hedgeMode: deriveHedgeMode(quote.details as Record<string, unknown> | undefined),
            premiumPolicy: estimatedPremiumPolicyDiagnostics,
            premiumRegimeLevel: premiumRegimeDecision.regime,
            premiumRegimePreviousLevel: premiumRegimeDecision.previousRegime,
            premiumRegimeChanged: premiumRegimeDecision.changed,
            premiumRegimeReason: premiumRegimeDecision.reason,
            premiumRegimeOverlayApplied: premiumRegimeOverlay.applied,
            premiumRegimeOverlayUsd: premiumRegimeOverlay.overlayUsd.toFixed(10),
            premiumRegimeBasePremiumUsd: premiumRegimeOverlay.basePremiumUsd.toFixed(10),
            premiumRegimeAdjustedPremiumUsd: premiumRegimeOverlay.adjustedPremiumUsd.toFixed(10),
            displayRoundedPremiumPer1kUsd: roundedPremiumDisplay.roundedPremiumPer1kUsd.toFixed(2),
            displayRoundedClientPremiumUsd: roundedPremiumDisplay.roundedClientPremiumUsd.toFixed(2),
            ...pricingBreakdown
          }
        }
      });
      const clientQuote = sanitizeQuoteForClient({
        ...quote,
        details: {
          ...(quote.details || {}),
          ...selectionPremiumInputs,
          tenorReason,
          pricingBreakdown
        },
        premium: Number(premiumPricing.clientPremiumUsd.toFixed(4)),
      });
      return {
        status: "ok",
        protectionType,
        tierName,
        slPct: resolvedSlPct,
        v7: v7Quote ? {
          regime: v7Quote.regime,
          regimeSource: v7Quote.regimeSource,
          dvol: v7Quote.dvol,
          premiumPer1kUsd: v7Quote.premiumPer1kUsd,
          premiumUsd: v7Quote.premiumUsd,
          payoutPer10kUsd: v7Quote.payoutPer10kUsd,
          available: v7Quote.available
        } : null,
        profile: {
          name: pilotConfig.lockedProfile.name,
          fixedTenorDays: v7Enabled ? pilotConfig.v7.defaultTenorDays : lockedProfileTenorDays,
          fixedPricingMode: lockedProfilePricingMode,
          fixedDrawdownFloorPctByTier: pilotConfig.lockedProfile.fixedDrawdownFloorPctByTier
        },
        drawdownFloorPct: drawdownFloorPct.toFixed(6),
        triggerPrice: triggerPrice.toFixed(10),
        triggerLabel,
        floorPrice: triggerPrice.toFixed(10),
        quote: clientQuote,
        entrySnapshot: {
          price: snapshot.price.toFixed(10),
          marketId: snapshot.marketId,
          source: snapshot.priceSource,
          timestamp: snapshot.priceTimestamp,
          requestId: snapshot.requestId
        },
        entryInputPrice: entryInputPrice ? entryInputPrice.toFixed(10) : null,
        limits: {
          minQuoteNotionalUsdc: quoteMinNotional.toFixed(2),
          maxProtectionNotionalUsdc: maxProtection.toFixed(2),
          maxDailyProtectedNotionalUsdc: maxDailyProtection.toFixed(2),
          dailyUsedUsdc: dailyUsed.toFixed(2),
          projectedDailyUsdc: projectedDaily.toFixed(2),
          dailyCapExceededOnActivate: projectedDaily.gt(maxDailyProtection)
        },
        diagnostics: {
          requestId,
          timingsMs: {
            price: priceMs,
            venue: venueMs,
            total: Date.now() - quoteStartedAt
          },
          premiumPolicy: estimatedPremiumPolicyDiagnostics,
          tenorPolicy:
            tenorPolicy && pilotConfig.dynamicTenorEnabled
              ? {
                  status: tenorPolicy.status,
                  enabledTenorsDays: tenorPolicy.selection?.enabledTenorsDays || [],
                  defaultTenorDays: tenorPolicy.selection?.defaultTenorDays || requestedTenorDays,
                  requestedTenorDays,
                  venueRequestedTenorDays,
                  fallbackApplied: tenorPolicyFallbackApplied,
                  fallbackReason: tenorPolicyFallbackReason
                }
              : null,
          venueSelection: {
            selectedStrike:
              quote.details && Number.isFinite(Number((quote.details as Record<string, unknown>).selectedStrike))
                ? Number((quote.details as Record<string, unknown>).selectedStrike).toFixed(10)
                : null,
            strikeGapToTriggerUsd:
              quote.details &&
              Number.isFinite(Number((quote.details as Record<string, unknown>).strikeGapToTriggerUsd))
                ? Number((quote.details as Record<string, unknown>).strikeGapToTriggerUsd).toFixed(10)
                : null,
            strikeGapToTriggerPct:
              quote.details &&
              Number.isFinite(Number((quote.details as Record<string, unknown>).strikeGapToTriggerPct))
                ? Number((quote.details as Record<string, unknown>).strikeGapToTriggerPct).toFixed(10)
                : null,
            selectedTenorDays:
              quote.details && Number.isFinite(Number((quote.details as Record<string, unknown>).selectedTenorDays))
                ? Number((quote.details as Record<string, unknown>).selectedTenorDays).toFixed(10)
                : null,
            tenorDriftDays:
              quote.details && Number.isFinite(Number((quote.details as Record<string, unknown>).tenorDriftDays))
                ? Number((quote.details as Record<string, unknown>).tenorDriftDays).toFixed(10)
                : null,
            deribitQuotePolicy:
              quote.details && typeof (quote.details as Record<string, unknown>).deribitQuotePolicy === "string"
                ? String((quote.details as Record<string, unknown>).deribitQuotePolicy)
                : null,
            strikeSelectionMode:
              quote.details && typeof (quote.details as Record<string, unknown>).strikeSelectionMode === "string"
                ? String((quote.details as Record<string, unknown>).strikeSelectionMode)
                : null,
            requestedTenorDays:
              quote.details && Number.isFinite(Number((quote.details as Record<string, unknown>).requestedTenorDays))
                ? Number((quote.details as Record<string, unknown>).requestedTenorDays).toFixed(10)
                : null,
            selectedTenorDaysActual:
              quote.details && Number.isFinite(Number((quote.details as Record<string, unknown>).selectedTenorDays))
                ? Number((quote.details as Record<string, unknown>).selectedTenorDays).toFixed(10)
                : null,
            tenorReason,
            selectedExpiry:
              quote.details && typeof (quote.details as Record<string, unknown>).selectedExpiry === "string"
                ? String((quote.details as Record<string, unknown>).selectedExpiry)
                : null,
            selectionAlgorithm:
              quote.details && typeof (quote.details as Record<string, unknown>).selectionAlgorithm === "string"
                ? String((quote.details as Record<string, unknown>).selectionAlgorithm)
                : null,
            candidateCountEvaluated:
              quote.details &&
              Number.isFinite(Number((quote.details as Record<string, unknown>).candidateCountEvaluated))
                ? Number((quote.details as Record<string, unknown>).candidateCountEvaluated)
                : null,
            selectedScore:
              quote.details && Number.isFinite(Number((quote.details as Record<string, unknown>).selectedScore))
                ? Number((quote.details as Record<string, unknown>).selectedScore)
                : null,
            selectedRank:
              quote.details && Number.isFinite(Number((quote.details as Record<string, unknown>).selectedRank))
                ? Number((quote.details as Record<string, unknown>).selectedRank)
                : null,
            selectedIsBelowTarget:
              quote.details && typeof (quote.details as Record<string, unknown>).selectedIsBelowTarget === "boolean"
                ? Boolean((quote.details as Record<string, unknown>).selectedIsBelowTarget)
                : null,
            matchedTenorHoursEstimate:
              quote.details &&
              Number.isFinite(Number((quote.details as Record<string, unknown>).matchedTenorHoursEstimate))
                ? Number((quote.details as Record<string, unknown>).matchedTenorHoursEstimate).toFixed(4)
                : null,
            matchedTenorDisplay:
              quote.details && typeof (quote.details as Record<string, unknown>).matchedTenorDisplay === "string"
                ? String((quote.details as Record<string, unknown>).matchedTenorDisplay)
                : null,
            selectionTrace:
              quote.details && Array.isArray((quote.details as Record<string, unknown>).selectionTrace)
                ? (quote.details as Record<string, unknown>).selectionTrace
                : null,
            hedgeMode: deriveHedgeMode(quote.details as Record<string, unknown> | undefined),
            hedgeInstrumentFamily:
              quote.details &&
              ((quote.details as Record<string, unknown>).hedgeInstrumentFamily === "BFF" ||
                (quote.details as Record<string, unknown>).hedgeInstrumentFamily === "MBT")
                ? String((quote.details as Record<string, unknown>).hedgeInstrumentFamily)
                : null,
            selectionReason:
              quote.details && typeof (quote.details as Record<string, unknown>).selectionReason === "string"
                ? String((quote.details as Record<string, unknown>).selectionReason)
                : null,
            rankedAlternatives:
              quote.details && Array.isArray((quote.details as Record<string, unknown>).rankedAlternatives)
                ? (quote.details as Record<string, unknown>).rankedAlternatives
                : null,
            candidateFailureCounts:
              quote.details &&
              typeof (quote.details as Record<string, unknown>).candidateFailureCounts === "object" &&
              (quote.details as Record<string, unknown>).candidateFailureCounts
                ? (quote.details as Record<string, unknown>).candidateFailureCounts
                : null
          }
        }
      };
    } catch (error: any) {
      const message = String(error?.message || "quote_generation_failed");
      const isTransportNotLive = message.startsWith("ibkr_transport_not_live");
      const isTenorDriftExceeded = message.includes("tenor_drift_exceeded");
      const isTenorTemporarilyUnavailable = message.includes("tenor_temporarily_unavailable");
      const isNoTopOfBook =
        message.includes("no_top_of_book") && !message.includes("no_top_of_book:no_viable_option");
      const noViableOptionMatch = message.match(/no_viable_option:(\{.*\})/);
      const isNoViableOption = message.includes("no_viable_option");
      const isNoEconomicalOption = message.includes("no_economical_option");
      const isNoProtectionCompliantOption = message.includes("no_protection_compliant_option");
      const isOptionsRequired = message.includes("options_required");
      const isNoLiquidityWindow = message.includes("no_liquidity_window");
      const isPremiumGuardrail = message.includes("premium_ratio_exceeded");
      const isNoContract = message.includes("no_contract");
      const isTimeout = message.includes("timeout") || message.includes("AbortError");
      const isVenueQuoteTimeout = message.includes("venue_quote_timeout");
      const isStorageFailure =
        message.includes("postgres") || message.includes("ECONN") || message.includes("pool") || message.includes("db");
      reply.code(
        isTimeout || isVenueQuoteTimeout
          ? 504
          : isStorageFailure ||
              isTransportNotLive ||
              isNoTopOfBook ||
              isNoViableOption ||
              isNoEconomicalOption ||
              isNoProtectionCompliantOption ||
              isOptionsRequired ||
              isNoLiquidityWindow ||
              isNoContract ||
              isPremiumGuardrail
            ? 503
            : isTenorTemporarilyUnavailable || isTenorDriftExceeded
              ? 409
              : 502
      );
      const noViableReasonPrefix = message.match(
        /ibkr_quote_unavailable:(min_tradable_notional_exceeded|no_economical_option|no_protection_compliant_option|no_top_of_book):no_viable_option/
      )?.[1];
      const noViableOptionRaw = noViableOptionMatch?.[1];
      const noViableOptionDiagnostics = (() => {
        if (!noViableOptionRaw) return null;
        try {
          return JSON.parse(noViableOptionRaw) as Record<string, unknown>;
        } catch {
          return null;
        }
      })();
      const noViableReason =
        Number(noViableOptionDiagnostics?.nFailedMinTradableNotional || 0) > 0
          ? "quote_min_notional_not_met"
          : Number(noViableOptionDiagnostics?.nFailedWideSpread || 0) > 0 ||
              Number(noViableOptionDiagnostics?.nFailedThinDepth || 0) > 0 ||
              Number(noViableOptionDiagnostics?.nFailedStaleTop || 0) > 0
            ? "quote_liquidity_unavailable"
            : noViableReasonPrefix === "min_tradable_notional_exceeded" ||
                noViableReasonPrefix === "no_economical_option"
              ? "quote_economics_unacceptable"
              : noViableReasonPrefix === "no_protection_compliant_option" || noViableReasonPrefix === "no_top_of_book"
                ? "quote_liquidity_unavailable"
                : null;
      return {
        status: "error",
        reason: isStorageFailure
          ? "storage_unavailable"
          : isTransportNotLive
            ? "ibkr_transport_not_live"
            : isTenorTemporarilyUnavailable
              ? "tenor_temporarily_unavailable"
            : isVenueQuoteTimeout
              ? "quote_generation_timeout"
            : isNoViableOption
              ? noViableReason || "quote_liquidity_unavailable"
            : isNoTopOfBook
              ? "quote_liquidity_unavailable"
            : isNoEconomicalOption
              ? "quote_economics_unacceptable"
            : isNoProtectionCompliantOption
              ? "quote_liquidity_unavailable"
            : isOptionsRequired
              ? "quote_options_required"
            : isNoLiquidityWindow
              ? "quote_liquidity_unavailable"
            : isNoContract
              ? "quote_contract_unavailable"
            : isPremiumGuardrail
              ? "quote_economics_unacceptable"
            : isTenorDriftExceeded
              ? "tenor_drift_exceeded"
            : "quote_generation_failed",
        message: isStorageFailure
          ? "Storage temporarily unavailable, please retry."
          : isTransportNotLive
            ? "IBKR live transport is not active. Verify bridge transport health and retry."
            : isTenorTemporarilyUnavailable
              ? "Requested tenor is temporarily unavailable. Select an enabled tenor and retry."
            : isVenueQuoteTimeout
              ? "Venue quote timed out while evaluating options liquidity. Please retry."
            : isNoViableOption
              ? noViableReason === "quote_economics_unacceptable"
                ? "No option contract met pilot economics guardrails within quote budget."
                : noViableReason === "quote_min_notional_not_met"
                  ? "Requested protection amount is below the minimum tradable option notional for current liquidity."
                : "No viable option contract met liquidity/protection/economics constraints within quote budget."
            : isNoTopOfBook
              ? "Venue top-of-book is temporarily unavailable for the requested hedge. Please retry."
            : isNoEconomicalOption
              ? "No option contract met pilot economics guardrails within quote budget."
            : isNoProtectionCompliantOption
              ? "No option contract met minimum protection effectiveness within quote budget."
            : isOptionsRequired
              ? "Options-native quotes are required and no viable option contract was available within quote budget."
            : isNoLiquidityWindow
              ? "CME options liquidity appears unavailable for the current market window. Please retry during active session."
            : isNoContract
              ? "No venue contract is currently available for the requested hedge. Please retry."
            : isPremiumGuardrail
              ? "Venue premium is currently outside pilot guardrails for this tenor. Please retry or choose another tenor."
            : isTenorDriftExceeded
              ? "No IBKR contract matched the requested tenor within configured drift."
          : "Unable to generate a venue quote right now. Please retry.",
        detail: message,
        diagnostics: {
          requestId,
          stage: "venue_quote",
          timingsMs: {
            price: priceMs,
            total: Date.now() - quoteStartedAt
          },
          ...(noViableOptionRaw
            ? {
                optionCandidateFailureCounts: noViableOptionDiagnostics
              }
            : {}),
          ...(message.includes("selector_diag:") && message.match(/selector_diag:(\{.*\})/)
            ? {
                selectorDiagnostics: (() => {
                  const match = message.match(/selector_diag:(\{.*\})/);
                  if (!match) return null;
                  try {
                    return JSON.parse(match[1]);
                  } catch {
                    return null;
                  }
                })()
              }
            : {})
        }
      };
    }
  });

  app.post("/pilot/protections/activate", async (req, reply) => {
    if (!enforcePilotWindow(reply)) return;
    if (!pilotConfig.activationEnabled) {
      reply.code(503);
      return {
        status: "error",
        reason: "activation_disabled",
        message: "Activation is disabled while quote-only pilot validation is in progress."
      };
    }
    const body = req.body as {
      protectedNotional?: number;
      foxifyExposureNotional?: number;
      instrumentId?: string;
      marketId?: string;
      tenorDays?: number;
      expiryAt?: string;
      autoRenew?: boolean;
      renewWindowMinutes?: number;
      clientOrderId?: string;
      tierName?: string;
      slPct?: number;
      drawdownFloorPct?: number;
      protectionType?: "long" | "short";
      entryPrice?: number;
      quoteId?: string;
    };
    if (!body.quoteId) {
      reply.code(400);
      return { status: "error", reason: "missing_quote_id" };
    }
    const protectedNotional = parsePositiveDecimal(body.protectedNotional);
    const exposureNotional = parsePositiveDecimal(body.foxifyExposureNotional);
    const entryInputPrice = parsePositiveDecimal(body.entryPrice);
    if (!protectedNotional) {
      reply.code(400);
      return { status: "error", reason: "invalid_protected_notional" };
    }
    if (!exposureNotional) {
      reply.code(400);
      return { status: "error", reason: "invalid_exposure_notional" };
    }
    const quoteMinNotional = resolveQuoteMinNotionalFloor();
    if (protectedNotional.lt(quoteMinNotional)) {
      reply.code(400);
      return {
        status: "error",
        reason: "quote_min_notional_not_met",
        message: `Minimum quote notional is $${quoteMinNotional.toFixed(0)} during pilot.`,
        minQuoteNotionalUsdc: quoteMinNotional.toFixed(2)
      };
    }
    const maxProtection = new Decimal(pilotConfig.maxProtectionNotionalUsdc);
    const maxDailyProtection = new Decimal(pilotConfig.maxDailyProtectedNotionalUsdc);
    if (protectedNotional.gt(maxProtection)) {
      reply.code(400);
      return {
        status: "error",
        reason: "protection_notional_cap_exceeded",
        capUsdc: maxProtection.toFixed(2)
      };
    }
    if (protectedNotional.gt(exposureNotional)) {
      reply.code(400);
      return { status: "error", reason: "protected_notional_exceeds_exposure" };
    }
    let userHash: { userHash: string; hashVersion: number };
    try {
      userHash = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const marketId = pilotConfig.referenceMarketId;
    const protectionType = normalizeProtectionType(body.protectionType);
    const optionType = protectionType === "short" ? "C" : "P";
    const triggerLabel = protectionType === "short" ? "ceiling_price" : "floor_price";
    const v7EnabledActivate = pilotConfig.v7.enabled;
    const activateSlPctInput = body.slPct != null ? Number(body.slPct) : null;
    const activateValidSlPct = activateSlPctInput !== null && isValidSlTier(activateSlPctInput) ? activateSlPctInput as V7SlTier : null;
    let activateTierName: string;
    let activateDrawdownFloorPct: Decimal;
    let activateSlPct: V7SlTier | null = null;
    if (v7EnabledActivate && activateValidSlPct) {
      activateSlPct = activateValidSlPct;
      activateTierName = slPctToTierLabel(activateValidSlPct);
      activateDrawdownFloorPct = slPctToDrawdownFloor(activateValidSlPct);
    } else {
      activateTierName = normalizeTierName(body.tierName);
      activateDrawdownFloorPct = resolveDrawdownFloorPct({
        tierName: activateTierName,
        drawdownFloorPct: body.drawdownFloorPct
      });
    }
    const tierName = activateTierName;
    const drawdownFloorPct = activateDrawdownFloorPct;
    const activateDefaultTenor = v7EnabledActivate && activateSlPct ? getV7TenorDays(activateSlPct) : v7EnabledActivate ? pilotConfig.v7.defaultTenorDays : 7;
    const instrumentId = body.instrumentId || `${marketId}-${activateDefaultTenor}D-${optionType}`;
    const tenorDays = resolveExpiryDays({
      tierName,
      requestedDays: body.tenorDays ?? activateDefaultTenor,
      minDays: pilotConfig.pilotTenorMinDays,
      maxDays: pilotConfig.pilotTenorMaxDays,
      defaultDays: pilotConfig.pilotTenorDefaultDays
    });
    const expiryAt = new Date(Date.now() + tenorDays * 86400000).toISOString();
    const requestId = pilotConfig.nextRequestId();
    const client = await pool.connect();
    let capUsedUsdc: string | null = null;
    let capProjectedUsdc: string | null = null;
    let transactionOpen = false;
    let capReserved = false;
    let capReleased = false;
    let quoteEntryAnchorPrice: Decimal | null = null;
    let triggerPrice: Decimal | null = null;
    let quoteEntryInputPrice: string | null = null;
    let quoteEntryPriceSource = "reference_snapshot_quote";
    let quoteEntryPriceTimestamp: string | null = null;
    let lockedQuoteRecord: Awaited<ReturnType<typeof getVenueQuoteByQuoteIdForUpdate>> | null = null;
    let reservedProtection: Awaited<ReturnType<typeof insertProtection>> | null = null;
    let execution: Awaited<ReturnType<typeof venue.execute>> | null = null;
    let executionFailureDetail: string | null = null;
    let premiumPolicyDiagnostics: PremiumPolicyDiagnostics | null = null;
    let premiumPricing: PremiumPricingResult | null = null;
    let requestedQuantity = 0;
    let contextHedgeMode: "options_native" | "futures_synthetic" = "options_native";
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const lockedQuote = await getVenueQuoteByQuoteIdForUpdate(client, body.quoteId);
      lockedQuoteRecord = lockedQuote;
      if (!lockedQuote) {
        throw new Error("quote_not_found");
      }
      if (lockedQuote.consumedByProtectionId) {
        const existing = await getProtection(client, lockedQuote.consumedByProtectionId);
        if (existing) {
          if (!assertProtectionOwnership(existing, userHash)) {
            throw new Error("quote_already_consumed");
          }
          if (existing.status === "active" || existing.status === "reconcile_pending") {
            await client.query("COMMIT");
            transactionOpen = false;
            const replayCoverageRatio =
              existing.metadata && typeof existing.metadata["coverageRatio"] === "string"
                ? String(existing.metadata["coverageRatio"])
                : null;
            const replayQuote = sanitizeQuoteForClient({
              ...lockedQuote,
              premium: Number(new Decimal(existing.premium || lockedQuote.premium).toFixed(4))
            });
            return {
              status: "ok",
              protection: sanitizeProtectionForTrader(existing as unknown as Record<string, unknown>),
              coverageRatio: replayCoverageRatio,
              quote: replayQuote,
              idempotentReplay: true
            };
          }
          throw new Error(`quote_not_activatable:${existing.status}`);
        }
        throw new Error("quote_already_consumed");
      }
      if (Date.now() > Date.parse(lockedQuote.expiresAt)) {
        throw new Error("quote_expired");
      }
      const lockContext = (lockedQuote.details?.lockContext || {}) as Record<string, unknown>;
      const requestedInstrumentId = String(lockContext.requestedInstrumentId || instrumentId);
      if (requestedInstrumentId !== instrumentId) {
        throw new Error("quote_mismatch_instrument");
      }
      const contextProtected = parsePositiveDecimal(lockContext.protectedNotional);
      const contextExposure = parsePositiveDecimal(lockContext.foxifyExposureNotional);
      const contextEntryAnchor = parsePositiveDecimal(lockContext.entryAnchorPrice ?? lockContext.entryPrice);
      const contextDrawdown = parsePositiveDecimal(lockContext.drawdownFloorPct);
      const contextProtectionType = normalizeProtectionType(
        String(lockContext.protectionType || inferProtectionTypeFromInstrument(requestedInstrumentId))
      );
      contextHedgeMode =
        String(lockContext.hedgeMode || "") === "futures_synthetic"
          ? "futures_synthetic"
          : "options_native";
      const computedTriggerFromContext =
        contextEntryAnchor && contextDrawdown
          ? computeTriggerPrice(contextEntryAnchor, contextDrawdown, contextProtectionType)
          : null;
      const contextTrigger = parsePositiveDecimal(lockContext.triggerPrice ?? lockContext.floorPrice);
      const rawRequestedQty = contextEntryAnchor
        ? protectedNotional.div(contextEntryAnchor).toDecimalPlaces(8).toNumber()
        : 0;
      requestedQuantity = rawRequestedQty;
      const quantityMismatchTolerance = v7EnabledActivate
        ? new Decimal("0.15")
        : new Decimal(pilotConfig.fullCoverageTolerancePct);
      const quantityDeltaPct =
        requestedQuantity > 0
          ? new Decimal(lockedQuote.quantity).minus(requestedQuantity).abs().div(new Decimal(requestedQuantity))
          : new Decimal(0);
      if (quantityDeltaPct.gt(quantityMismatchTolerance)) {
        console.warn(`[Activate] quote_mismatch_quantity: quoteQty=${lockedQuote.quantity} requestedQty=${requestedQuantity} delta=${quantityDeltaPct.toFixed(4)} tolerance=${quantityMismatchTolerance.toFixed(4)}`);
        throw new Error("quote_mismatch_quantity");
      }
      if (contextProtectionType !== protectionType) {
        throw new Error("quote_mismatch_type");
      }
      if (
        String(lockContext.marketId || marketId) !== marketId ||
        String(lockContext.tierName || tierName) !== tierName ||
        !contextProtected ||
        !contextExposure ||
        !contextEntryAnchor ||
        !contextDrawdown ||
        !contextTrigger ||
        !computedTriggerFromContext ||
        contextProtected.minus(protectedNotional).abs().gt(new Decimal("0.000001")) ||
        contextExposure.minus(exposureNotional).abs().gt(new Decimal("0.000001")) ||
        contextDrawdown.minus(drawdownFloorPct).abs().gt(new Decimal("0.000001")) ||
        contextTrigger.minus(computedTriggerFromContext).abs().gt(new Decimal("0.000001"))
      ) {
        throw new Error("quote_mismatch_context");
      }
      quoteEntryAnchorPrice = contextEntryAnchor;
      triggerPrice = computedTriggerFromContext;
      quoteEntryInputPrice =
        typeof lockContext.entryInputPrice === "string" ? String(lockContext.entryInputPrice) : null;
      quoteEntryPriceSource =
        typeof lockContext.entryPriceSource === "string"
          ? String(lockContext.entryPriceSource)
          : "reference_snapshot_quote";
      quoteEntryPriceTimestamp =
        typeof lockContext.entryPriceTimestamp === "string"
          ? String(lockContext.entryPriceTimestamp)
          : null;
      const capReservation = await reserveDailyActivationCapacity(client, {
        userHash: userHash.userHash,
        dayStartIso: dayStart.toISOString(),
        protectedNotional: protectedNotional.toFixed(10),
        maxDailyNotional: maxDailyProtection.toFixed(10)
      });
      if (!capReservation.ok) {
        const capError = new Error("daily_notional_cap_exceeded");
        const usedNow = new Decimal(capReservation.usedNow);
        capUsedUsdc = usedNow.toFixed(2);
        capProjectedUsdc = usedNow.plus(protectedNotional).toFixed(2);
        (capError as any).usedUsdc = capUsedUsdc;
        (capError as any).projectedUsdc = capProjectedUsdc;
        throw capError;
      }
      capReserved = true;
      const usedAfter = new Decimal(capReservation.usedAfter);
      capProjectedUsdc = usedAfter.toFixed(2);
      capUsedUsdc = usedAfter.minus(protectedNotional).toFixed(2);
      const protection = await insertProtection(client, {
        userHash: userHash.userHash,
        hashVersion: userHash.hashVersion,
        status: "pending_activation",
        tierName,
        drawdownFloorPct: drawdownFloorPct.toFixed(6),
        slPct: activateSlPct,
        hedgeStatus: "active",
        marketId,
        protectedNotional: protectedNotional.toFixed(10),
        foxifyExposureNotional: exposureNotional.toFixed(10),
        expiryAt,
        autoRenew: parseBoolean(body.autoRenew, false),
        renewWindowMinutes: resolveRenewWindowMinutes({
          tierName,
          requestedMinutes: body.renewWindowMinutes
        }),
        metadata: {
          mode: "pilot",
          venueMode: pilotConfig.venueMode,
          tierName,
          slPct: activateSlPct,
          drawdownFloorPct: drawdownFloorPct.toFixed(6),
          protectionType,
          optionType
        }
      });
      reservedProtection = protection;
      const consumed = await consumeVenueQuote(client, lockedQuote.id, protection.id);
      if (!consumed) {
        throw new Error("quote_already_consumed");
      }
      const contextHedgePremium =
        parsePositiveDecimal(lockContext.hedgePremiumUsd) || new Decimal(lockedQuote.premium);
      const contextMarkupPct = parsePositiveDecimal(lockContext.markupPct);
      const contextMarkupUsd = parsePositiveDecimal(lockContext.markupUsd);
      const contextFloorUsd = parsePositiveDecimal(lockContext.premiumFloorUsd) || parseBoundedDecimal(lockContext.premiumFloorUsd, 0, Number.MAX_SAFE_INTEGER);
      const contextFloorUsdAbsolute =
        parsePositiveDecimal(lockContext.premiumFloorUsdAbsolute) ||
        parseBoundedDecimal(lockContext.premiumFloorUsdAbsolute, 0, Number.MAX_SAFE_INTEGER);
      const contextFloorUsdFromBps =
        parsePositiveDecimal(lockContext.premiumFloorUsdFromBps) ||
        parseBoundedDecimal(lockContext.premiumFloorUsdFromBps, 0, Number.MAX_SAFE_INTEGER);
      const contextFloorBps =
        parsePositiveDecimal(lockContext.premiumFloorBps) ||
        parseBoundedDecimal(lockContext.premiumFloorBps, 0, Number.MAX_SAFE_INTEGER);
      const contextClientPremium = parsePositiveDecimal(lockContext.clientPremiumUsd);
      const contextStrictClientPremium =
        parsePositiveDecimal(lockContext.strictClientPremiumUsd) ||
        parseBoundedDecimal(lockContext.strictClientPremiumUsd, 0, Number.MAX_SAFE_INTEGER);
      const contextHybridStrictMultiplier =
        parsePositiveDecimal(lockContext.hybridStrictMultiplier) ||
        parseBoundedDecimal(lockContext.hybridStrictMultiplier, 0, Number.MAX_SAFE_INTEGER);
      const contextHybridDiscountedStrictPremiumUsd =
        parsePositiveDecimal(lockContext.hybridDiscountedStrictPremiumUsd) ||
        parseBoundedDecimal(lockContext.hybridDiscountedStrictPremiumUsd, 0, Number.MAX_SAFE_INTEGER);
      const contextRequestedTenorDays = parsePositiveDecimal(lockContext.requestedTenorDays);
      const contextVenueRequestedTenorDays = parsePositiveDecimal(lockContext.venueRequestedTenorDays);
      const contextSelectedTenorDays = parsePositiveDecimal(lockContext.selectedTenorDays);
      const contextSelectedExpiry =
        typeof lockContext.selectedExpiry === "string" ? String(lockContext.selectedExpiry) : null;
      const contextTenorPolicyStatus =
        typeof lockContext.tenorPolicyStatus === "string" ? String(lockContext.tenorPolicyStatus) : null;
      const fallbackPremiumPricing = resolvePremiumPricing({
        tierName,
        pricingMode: pilotConfig.premiumPricingMode,
        protectedNotional,
        drawdownFloorPct,
        hedgePremium: contextHedgePremium,
        brokerFees: parsePositiveDecimal(lockContext.brokerFeesUsd) || new Decimal(0),
        markupPctOverride: contextMarkupPct
      });
      const contextBrokerFeesUsd = parsePositiveDecimal(lockContext.brokerFeesUsd);
      const contextPassThroughUsd = parsePositiveDecimal(lockContext.passThroughUsd);
      const contextExpectedClaimsUsd =
        parsePositiveDecimal(lockContext.expectedClaimsUsd) ||
        parseBoundedDecimal(lockContext.expectedClaimsUsd, 0, Number.MAX_SAFE_INTEGER);
      const contextExpectedTriggerProbRaw = parseBoundedDecimal(lockContext.expectedTriggerProbRaw, 0, 1);
      const contextExpectedTriggerProbCapped = parseBoundedDecimal(lockContext.expectedTriggerProbCapped, 0, 1);
      const contextPositionFloorUsd =
        parsePositiveDecimal(lockContext.positionFloorUsd) ||
        parseBoundedDecimal(lockContext.positionFloorUsd, 0, Number.MAX_SAFE_INTEGER);
      const contextClaimsFloorUsd =
        parsePositiveDecimal(lockContext.claimsFloorUsd) ||
        parseBoundedDecimal(lockContext.claimsFloorUsd, 0, Number.MAX_SAFE_INTEGER);
      const contextMarkupPremiumUsd =
        parsePositiveDecimal(lockContext.markupPremiumUsd) ||
        parseBoundedDecimal(lockContext.markupPremiumUsd, 0, Number.MAX_SAFE_INTEGER);
      premiumPricing = {
        hedgePremiumUsd: contextHedgePremium,
        brokerFeesUsd: contextBrokerFeesUsd || fallbackPremiumPricing.brokerFeesUsd,
        passThroughUsd: contextPassThroughUsd || fallbackPremiumPricing.passThroughUsd,
        selectionFeasibilityPenaltyUsd:
          parsePositiveDecimal(lockContext.selectionFeasibilityPenaltyUsd) ||
          fallbackPremiumPricing.selectionFeasibilityPenaltyUsd,
        premiumProfitabilityTargetUsd:
          parsePositiveDecimal(lockContext.premiumProfitabilityTargetUsd) ||
          fallbackPremiumPricing.premiumProfitabilityTargetUsd,
        premiumProfitabilityTargetRatio:
          parsePositiveDecimal(lockContext.premiumProfitabilityTargetRatio) ||
          fallbackPremiumPricing.premiumProfitabilityTargetRatio,
        premiumFloorUsdTriggerCredit:
          parsePositiveDecimal(lockContext.premiumFloorUsdTriggerCredit) ||
          fallbackPremiumPricing.premiumFloorUsdTriggerCredit,
        expectedTriggerCreditUsd:
          parsePositiveDecimal(lockContext.expectedTriggerCreditUsd) ||
          fallbackPremiumPricing.expectedTriggerCreditUsd,
        expectedTriggerCostUsd:
          parsePositiveDecimal(lockContext.expectedTriggerCostUsd) ||
          fallbackPremiumPricing.expectedTriggerCostUsd,
        profitabilityBufferUsd:
          parsePositiveDecimal(lockContext.profitabilityBufferUsd) ||
          fallbackPremiumPricing.profitabilityBufferUsd,
        profitabilityFloorUsd:
          parsePositiveDecimal(lockContext.profitabilityFloorUsd) ||
          fallbackPremiumPricing.profitabilityFloorUsd,
        markupPct: contextMarkupPct || fallbackPremiumPricing.markupPct,
        markupUsd: contextMarkupUsd || fallbackPremiumPricing.markupUsd,
        premiumFloorUsdAbsolute: contextFloorUsdAbsolute || fallbackPremiumPricing.premiumFloorUsdAbsolute,
        premiumFloorUsdFromBps: contextFloorUsdFromBps || fallbackPremiumPricing.premiumFloorUsdFromBps,
        premiumFloorBps: contextFloorBps || fallbackPremiumPricing.premiumFloorBps,
        premiumFloorUsd: contextFloorUsd || fallbackPremiumPricing.premiumFloorUsd,
        strictClientPremiumUsd: contextStrictClientPremium || fallbackPremiumPricing.strictClientPremiumUsd,
        hybridStrictMultiplier: contextHybridStrictMultiplier || fallbackPremiumPricing.hybridStrictMultiplier,
        hybridDiscountedStrictPremiumUsd:
          contextHybridDiscountedStrictPremiumUsd || fallbackPremiumPricing.hybridDiscountedStrictPremiumUsd,
        clientPremiumUsd: contextClientPremium || fallbackPremiumPricing.clientPremiumUsd,
        method: (() => {
          const rawMethod = String(lockContext.method || fallbackPremiumPricing.method);
          if (rawMethod === "hybrid_strict_discount") return "hybrid_strict_discount";
          if (rawMethod === "hybrid_markup") return "hybrid_strict_discount";
          if (rawMethod === "hybrid_position_floor") return "hybrid_strict_discount";
          if (rawMethod === "hybrid_claims_floor") return "hybrid_strict_discount";
          if (rawMethod === "floor_profitability") return "floor_profitability";
          if (rawMethod === "floor_trigger_credit") return "floor_trigger_credit";
          if (rawMethod === "floor_usd") return "floor_usd";
          if (rawMethod === "floor_bps") return "floor_bps";
          return "markup";
        })(),
        expectedClaimsUsd:
          parsePositiveDecimal(lockContext.expectedClaimsUsd) || fallbackPremiumPricing.expectedClaimsUsd,
        expectedTriggerProbRaw:
          parsePositiveDecimal(lockContext.expectedTriggerProbRaw) || fallbackPremiumPricing.expectedTriggerProbRaw,
        expectedTriggerProbCapped:
          parsePositiveDecimal(lockContext.expectedTriggerProbCapped) || fallbackPremiumPricing.expectedTriggerProbCapped,
        positionFloorUsd: parsePositiveDecimal(lockContext.positionFloorUsd) || fallbackPremiumPricing.positionFloorUsd,
        claimsFloorUsd: parsePositiveDecimal(lockContext.claimsFloorUsd) || fallbackPremiumPricing.claimsFloorUsd,
        markupPremiumUsd: parsePositiveDecimal(lockContext.markupPremiumUsd) || fallbackPremiumPricing.markupPremiumUsd,
        pricingMode:
          lockContext.pricingMode === "hybrid_otm_treasury" || lockContext.pricingMode === "actuarial_strict"
            ? lockContext.pricingMode
            : fallbackPremiumPricing.pricingMode
      };
      if (v7EnabledActivate && activateSlPct) {
        const v7ActivateQuote = computeV7Premium({
          slPct: activateSlPct,
          notionalUsd: protectedNotional.toNumber()
        });
        premiumPricing = {
          ...premiumPricing,
          clientPremiumUsd: new Decimal(v7ActivateQuote.premiumUsd)
        };
      } else if (!v7EnabledActivate && isLockedBullishProfile) {
        const FIXED_PREMIUM_PER_1K_ACTIVATE = new Decimal(11);
        premiumPricing = {
          ...premiumPricing,
          clientPremiumUsd: protectedNotional.div(1000).mul(FIXED_PREMIUM_PER_1K_ACTIVATE),
        };
      }
      premiumPolicyDiagnostics = buildPremiumPolicyDiagnostics({ estimated: premiumPricing });
      await client.query("COMMIT");
      transactionOpen = false;

      const snapshot = await resolvePriceSnapshot(
        {
          primaryUrl: pilotConfig.referencePriceUrl,
          fallbackUrl: pilotConfig.singlePriceSource ? "" : pilotConfig.fallbackPriceUrl,
          primaryTimeoutMs: pilotConfig.pricePrimaryTimeoutMs,
          fallbackTimeoutMs: pilotConfig.priceFallbackTimeoutMs,
          freshnessMaxMs: pilotConfig.priceFreshnessMaxMs,
          requestRetryAttempts: pilotConfig.priceRequestRetryAttempts,
          requestRetryDelayMs: pilotConfig.priceRequestRetryDelayMs
        },
        {
          marketId,
          now: new Date(),
          requestId,
          endpointVersion: pilotConfig.endpointVersion
        }
      );
      execution = await withTimeout(
        venue.execute(lockedQuote),
        pilotConfig.venueExecuteTimeoutMs,
        "venue_execute"
      );
      if (execution.status !== "success") {
        const fillStatus =
          execution.details && typeof execution.details.fillStatus === "string"
            ? String(execution.details.fillStatus)
            : null;
        const rejectionReason =
          execution.details && typeof execution.details.rejectionReason === "string"
            ? String(execution.details.rejectionReason)
            : null;
        executionFailureDetail = [fillStatus ? `fillStatus=${fillStatus}` : null, rejectionReason]
          .filter((part): part is string => Boolean(part && part.trim()))
          .join(" | ");
        throw new Error("execution_failed");
      }
      const effectiveRequestedQty = v7EnabledActivate
        ? Math.floor(requestedQuantity * 100) / 100
        : requestedQuantity;
      const coverageRatio =
        effectiveRequestedQty > 0
          ? new Decimal(execution.quantity).div(new Decimal(effectiveRequestedQty))
          : new Decimal(0);
      const baseTolerance = new Decimal(pilotConfig.fullCoverageTolerancePct);
      const v7CoverageTolerance = new Decimal("0.15");
      const optionQtyTolerance = v7EnabledActivate
        ? v7CoverageTolerance
        : isLockedBullishProfile ? new Decimal("0.06") : baseTolerance;
      const threshold = new Decimal(1).minus(optionQtyTolerance);
      if (
        (pilotConfig.requireFullCoverage || pilotConfig.requireFullExecutionFill) &&
        coverageRatio.lt(threshold)
      ) {
        console.warn(`[Activate] Coverage ratio ${coverageRatio.toFixed(4)} below threshold ${threshold.toFixed(4)} (requested=${requestedQuantity} filled=${execution.quantity})`);
        throw new Error("full_coverage_not_met");
      }
      if (!reservedProtection || !quoteEntryAnchorPrice || !triggerPrice || !premiumPricing) {
        throw new Error("activation_failed");
      }
      const realizedBrokerFeesUsd =
        parsePositiveDecimal(execution.details?.realizedBrokerFeesUsd) ||
        parsePositiveDecimal(execution.details?.commissionUsd) ||
        premiumPricing.brokerFeesUsd;
      const realizedPricing = resolvePremiumPricing({
        tierName,
        pricingMode: pilotConfig.premiumPricingMode,
        protectedNotional,
        drawdownFloorPct,
        hedgePremium: new Decimal(execution.premium),
        brokerFees: realizedBrokerFeesUsd,
        markupPctOverride: premiumPricing.markupPct
      });
      premiumPolicyDiagnostics = buildPremiumPolicyDiagnostics({
        estimated: premiumPricing,
        realized: realizedPricing
      });
      if (pilotConfig.premiumCapEnforce && premiumPolicyDiagnostics.caps) {
        const maxClientPremiumUsd = new Decimal(premiumPolicyDiagnostics.caps.maxClientPremiumUsd);
        if (realizedPricing.clientPremiumUsd.gt(maxClientPremiumUsd)) {
          throw new Error("premium_cap_exceeded_post_fill");
        }
      }
      try {
        await insertPriceSnapshot(pool, {
          protectionId: reservedProtection.id,
          snapshotType: "entry",
          price: snapshot.price.toFixed(10),
          marketId: snapshot.marketId,
          priceSource: snapshot.priceSource,
          priceSourceDetail: snapshot.priceSourceDetail,
          endpointVersion: snapshot.endpointVersion,
          requestId: snapshot.requestId,
          priceTimestamp: snapshot.priceTimestamp
        });
      } catch (snapErr: any) {
        console.error(`[Activate] insertPriceSnapshot FAILED: ${snapErr?.message}`);
        throw snapErr;
      }
      try {
        await insertVenueExecution(pool, reservedProtection.id, execution);
      } catch (execErr: any) {
        console.error(`[Activate] insertVenueExecution FAILED: ${execErr?.message}`);
        throw execErr;
      }
      const realizedSlippageBps =
        execution.premium > 0
          ? Math.max(0, ((execution.premium - lockedQuote.premium) / execution.premium) * 10_000)
          : 0;
      try {
        await upsertExecutionQualityDaily(pool, {
          dayIso: new Date().toISOString(),
          venue: execution.venue,
          hedgeMode: contextHedgeMode || deriveHedgeMode(lockedQuote.details),
          quotes: 1,
          fills: 1,
          rejects: 0,
          avgSlippageBps: realizedSlippageBps,
          avgLatencyMs: Date.now() - quoteStartedAt,
          avgSpreadPct:
            Number.isFinite(Number((lockedQuote.details as Record<string, unknown>)?.spreadPct))
              ? Number((lockedQuote.details as Record<string, unknown>)?.spreadPct)
              : null,
          notes: {
            quoteId: lockedQuote.quoteId,
            protectionId: reservedProtection.id
          }
        });
      } catch {
        // Execution-quality telemetry must never block successful activation.
      }
      try {
        await insertLedgerEntry(pool, {
          protectionId: reservedProtection.id,
          entryType: "premium_due",
          amount: premiumPricing.clientPremiumUsd.toFixed(10),
          reference: execution.externalOrderId
        });
      } catch (ledgerErr: any) {
        console.error(`[Activate] insertLedgerEntry FAILED: ${ledgerErr?.message}`);
        throw ledgerErr;
      }
      let updated;
      try {
        updated = await patchProtection(pool, reservedProtection.id, {
        status: "active",
        entry_price: quoteEntryAnchorPrice.toFixed(10),
        entry_price_source: quoteEntryPriceSource,
        entry_price_timestamp: quoteEntryPriceTimestamp || snapshot.priceTimestamp,
        floor_price: triggerPrice.toFixed(10),
        venue: execution.venue,
        instrument_id: execution.instrumentId,
        side: execution.side,
        size: new Decimal(execution.quantity).toFixed(10),
        execution_price: new Decimal(execution.executionPrice).toFixed(10),
        premium: premiumPricing.clientPremiumUsd.toFixed(10),
        executed_at: execution.executedAt,
        external_order_id: execution.externalOrderId,
        external_execution_id: execution.externalExecutionId,
        metadata: {
          ...(reservedProtection.metadata || {}),
          quoteId: lockedQuote.quoteId,
          rfqId: lockedQuote.rfqId || null,
          tierName,
          protectionType,
          optionType,
          triggerLabel,
          drawdownFloorPct: drawdownFloorPct.toFixed(6),
          triggerPrice: triggerPrice.toFixed(10),
          floorPrice: triggerPrice.toFixed(10),
          requestedTenorDays: contextRequestedTenorDays ? contextRequestedTenorDays.toFixed(10) : null,
          venueRequestedTenorDays: contextVenueRequestedTenorDays
            ? contextVenueRequestedTenorDays.toFixed(10)
            : null,
          selectedTenorDays: contextSelectedTenorDays ? contextSelectedTenorDays.toFixed(10) : null,
          selectedExpiry: contextSelectedExpiry,
          tenorPolicyStatus: contextTenorPolicyStatus,
          hedgeMode: contextHedgeMode,
          coverageRatio: coverageRatio.toFixed(6),
          hedgePremiumUsd: premiumPricing.hedgePremiumUsd.toFixed(10),
          brokerFeesUsd: premiumPricing.brokerFeesUsd.toFixed(10),
          passThroughUsd: premiumPricing.passThroughUsd.toFixed(10),
          markupPct: premiumPricing.markupPct.toFixed(6),
          markupUsd: premiumPricing.markupUsd.toFixed(10),
          premiumFloorUsdAbsolute: premiumPricing.premiumFloorUsdAbsolute.toFixed(10),
          premiumFloorUsdFromBps: premiumPricing.premiumFloorUsdFromBps.toFixed(10),
          premiumFloorBps: premiumPricing.premiumFloorBps.toFixed(2),
          premiumFloorUsd: premiumPricing.premiumFloorUsd.toFixed(10),
          clientPremiumUsd: premiumPricing.clientPremiumUsd.toFixed(10),
          displayedPremiumUsd:
            parsePositiveDecimal(lockContext.displayedPremiumUsd) ||
            new Decimal(lockContext.displayedPremiumUsd || NaN).isFinite()
              ? String(lockContext.displayedPremiumUsd)
              : premiumPricing.clientPremiumUsd.toFixed(10),
          displayedPremiumPer1kUsd:
            parsePositiveDecimal(lockContext.displayedPremiumPer1kUsd) ||
            new Decimal(lockContext.displayedPremiumPer1kUsd || NaN).isFinite()
              ? String(lockContext.displayedPremiumPer1kUsd)
              : premiumPricing.clientPremiumUsd.div(protectedNotional.div(1000)).toFixed(10),
          premiumMethod: premiumPricing.method,
          entryAnchorPrice: quoteEntryAnchorPrice.toFixed(10),
          entryAnchorSource: quoteEntryPriceSource,
          entryAnchorTimestamp: quoteEntryPriceTimestamp || snapshot.priceTimestamp,
          entryInputPrice: entryInputPrice?.toFixed(10) || quoteEntryInputPrice,
          entrySnapshotPrice: snapshot.price.toFixed(10),
          entrySnapshotSource: snapshot.priceSource,
          entrySnapshotTimestamp: snapshot.priceTimestamp,
          premiumPolicy: premiumPolicyDiagnostics
        }
      });
      } catch (patchErr: any) {
        console.error(`[Activate] patchProtection FAILED: ${patchErr?.message}`);
        throw patchErr;
      }
      const activatedQuote = sanitizeQuoteForClient({
        ...lockedQuote,
        premium: Number(premiumPricing.clientPremiumUsd.toFixed(4))
      });
      return {
        status: "ok",
        protection: updated
          ? sanitizeProtectionForTrader(updated as unknown as Record<string, unknown>)
          : null,
        coverageRatio: coverageRatio.toFixed(6),
        quote: activatedQuote,
        diagnostics: {
          requestId,
          premiumPolicy: premiumPolicyDiagnostics
        }
      };
    } catch (error: any) {
      console.error(`[Activate] ERROR in activation flow: ${error?.message}`, {
        hasProtection: !!reservedProtection,
        hasExecution: !!execution,
        executionStatus: execution?.status,
        stack: error?.stack?.split("\n").slice(0, 5).join(" | ")
      });
      if (transactionOpen) {
        await client.query("ROLLBACK");
        transactionOpen = false;
      }
      const shouldMarkReconcilePending = Boolean(
        reservedProtection && execution && execution.status === "success"
      );
      const shouldMarkActivationFailed = Boolean(
        reservedProtection && (!execution || execution.status !== "success")
      );
      if (capReserved && !capReleased && !shouldMarkReconcilePending) {
        try {
          await releaseDailyActivationCapacity(pool, {
            userHash: userHash.userHash,
            dayStartIso: dayStart.toISOString(),
            protectedNotional: protectedNotional.toFixed(10)
          });
          capReleased = true;
        } catch {
          // Best-effort cap release on failed activation path.
        }
      }
      if (shouldMarkReconcilePending && reservedProtection && execution) {
        try {
          await patchProtection(pool, reservedProtection.id, {
            status: "reconcile_pending",
            metadata: {
              reconcileReason: String(error?.message || "post_execution_persistence_failed"),
              reconcileAt: new Date().toISOString(),
              quoteId: execution.quoteId,
              externalOrderId: execution.externalOrderId,
              externalExecutionId: execution.externalExecutionId
            }
          });
        } catch {
          // Best-effort reconcile marker. Do not mask original error.
        }
      } else if (shouldMarkActivationFailed && reservedProtection) {
        try {
          await patchProtection(pool, reservedProtection.id, {
            status: "activation_failed",
            metadata: {
              activationFailedReason: String(error?.message || "activation_failed"),
              activationFailedAt: new Date().toISOString(),
              quoteId: lockedQuoteRecord?.quoteId || body.quoteId,
              externalOrderId: execution?.externalOrderId || null,
              externalExecutionId: execution?.externalExecutionId || null,
              capReleased
            }
          });
        } catch {
          // Best-effort failed status marker. Do not mask original error.
        }
      }
      const errMsg = String(error?.message || "");
      let reason = "activation_failed";
      if (shouldMarkReconcilePending) {
        reason = "reconcile_pending";
      } else if (errMsg.includes("price_unavailable")) {
        reason = "price_unavailable";
      } else if (errMsg.startsWith("quote_not_activatable")) {
        reason = "quote_not_activatable";
      } else if (
        [
          "quote_not_found",
          "quote_expired",
          "quote_already_consumed",
          "quote_mismatch_instrument",
          "quote_mismatch_type",
          "quote_mismatch_quantity",
          "quote_mismatch_context",
          "full_coverage_not_met",
          "storage_unavailable",
          "reconcile_pending",
          "execution_failed",
          "premium_cap_exceeded_post_fill",
          "activation_failed"
        ].includes(errMsg)
      ) {
        reason = errMsg;
      } else if (
        errMsg === "protection_notional_cap_exceeded" ||
        errMsg === "daily_notional_cap_exceeded" ||
        errMsg === "user_hash_secret_missing" ||
        errMsg === "venue_execute_timeout"
      ) {
        reason = errMsg;
      } else if (
        errMsg.includes("postgres") ||
        errMsg.includes("ECONN") ||
        errMsg.includes("pool") ||
        errMsg.includes("connection terminated")
      ) {
        reason = "storage_unavailable";
      } else if (errMsg.startsWith("ibkr_transport_not_live")) {
        reason = "ibkr_transport_not_live";
      } else {
        reason = mapVenueFailureReason(error);
      }
      if (reason === "price_unavailable") {
        reply.code(503);
      } else if (reason === "storage_unavailable") {
        reply.code(503);
      } else if (reason === "reconcile_pending") {
        reply.code(409);
      } else if (reason === "venue_execute_timeout") {
        reply.code(504);
      } else if (reason === "user_hash_secret_missing") {
        reply.code(500);
      } else if (reason === "quote_not_found") {
        reply.code(404);
      } else if (reason === "quote_already_consumed" || reason === "quote_not_activatable") {
        reply.code(409);
      } else if (reason === "ibkr_transport_not_live") {
        reply.code(503);
      } else if (reason === "execution_failed") {
        if (reservedProtection && contextHedgeMode) {
          try {
            await upsertExecutionQualityDaily(pool, {
              dayIso: new Date().toISOString(),
              venue: pilotConfig.venueMode,
              hedgeMode: contextHedgeMode,
              quotes: 1,
              fills: 0,
              rejects: 1,
              avgSlippageBps: 0,
              avgLatencyMs: Date.now() - quoteStartedAt,
              avgSpreadPct:
                Number.isFinite(Number((lockedQuote?.details as Record<string, unknown>)?.spreadPct))
                  ? Number((lockedQuote?.details as Record<string, unknown>)?.spreadPct)
                  : null,
              notes: {
                quoteId: lockedQuote?.quoteId || body.quoteId,
                rejection: executionFailureDetail || "execution_failed"
              }
            });
          } catch {
            // Best-effort telemetry only on failed executions.
          }
        }
        reply.code(502);
      } else if (reason === "premium_cap_exceeded_post_fill") {
        reply.code(502);
      } else {
        reply.code(400);
      }
      return {
        status: "error",
        reason,
        detail: reason === "execution_failed" ? executionFailureDetail : null,
        message:
          reason === "price_unavailable"
            ? "Price temporarily unavailable, please retry."
            : reason === "storage_unavailable"
              ? "Storage temporarily unavailable, please retry."
              : reason === "daily_notional_cap_exceeded"
                ? "Daily protection limit reached for pilot operations. Try again next UTC day."
                : reason === "protection_notional_cap_exceeded"
                  ? `Protection amount exceeds pilot cap (${new Decimal(
                      pilotConfig.maxProtectionNotionalUsdc
                    ).toFixed(2)} USDC).`
                  : reason === "quote_already_consumed"
                    ? "Quote has already been activated. Refresh protections before retrying."
                    : reason === "quote_not_activatable"
                      ? "Quote is linked to a non-active protection state. Request a fresh quote."
                      : reason === "venue_execute_timeout"
                        ? "Venue execution timed out. Please request a fresh quote."
                        : reason === "execution_failed"
                          ? "Venue execution failed. Please request a fresh quote."
                          : reason === "premium_cap_exceeded_post_fill"
                            ? "Realized premium exceeded configured cap. Activation was rejected."
                          : reason === "ibkr_transport_not_live"
                            ? "IBKR live transport is not active. Verify bridge transport health and retry."
                          : reason === "quote_expired"
                            ? "Quote expired. Please request a new quote."
                            : reason.startsWith("quote_mismatch")
                              ? "Quote does not match activation parameters. Please request a new quote."
                              : "Protection activation failed.",
        ...(reason === "daily_notional_cap_exceeded"
          ? {
              capUsdc: maxDailyProtection.toFixed(2),
              usedUsdc: (error as any)?.usedUsdc || capUsedUsdc,
              projectedUsdc: (error as any)?.projectedUsdc || capProjectedUsdc
            }
          : {}),
        ...(body.quoteId
          ? {
              diagnostics: {
                requestId,
                premiumPolicy:
                  premiumPolicyDiagnostics || (await extractLatestPremiumPolicyDiagnostics(pool, body.quoteId))
              }
            }
          : {})
      };
    } finally {
      client.release();
    }
  });

  app.get("/pilot/protections", async (req, reply) => {
    const query = req.query as { limit?: string };
    let userHash: { userHash: string; hashVersion: number };
    try {
      userHash = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    try {
      const protections = await listProtectionsByUserHash(pool, userHash.userHash, {
        limit: Number(query.limit || 20)
      });
      return {
        status: "ok",
        protections: protections.map((item) =>
          sanitizeProtectionForTrader(item as unknown as Record<string, unknown>)
        )
      };
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "storage_unavailable",
        message: "Storage temporarily unavailable, please retry.",
        detail: String(error?.message || "list_protections_failed")
      };
    }
  });

  const buildProtectionMonitorPayload = async (protection: Awaited<ReturnType<typeof getProtection>>) => {
    if (!protection) throw new Error("not_found");
    const requestId = pilotConfig.nextRequestId();
    let snapshot: PriceSnapshotOutput;
    try {
      snapshot = await resolvePriceSnapshot(
        {
          primaryUrl: pilotConfig.referencePriceUrl,
          fallbackUrl: pilotConfig.singlePriceSource ? "" : pilotConfig.fallbackPriceUrl,
          primaryTimeoutMs: pilotConfig.pricePrimaryTimeoutMs,
          fallbackTimeoutMs: pilotConfig.priceFallbackTimeoutMs,
          freshnessMaxMs: pilotConfig.priceFreshnessMaxMs,
          requestRetryAttempts: pilotConfig.priceRequestRetryAttempts,
          requestRetryDelayMs: pilotConfig.priceRequestRetryDelayMs
        },
        {
          marketId: protection.marketId,
          now: new Date(),
          requestId,
          endpointVersion: pilotConfig.endpointVersion
        }
      );
    } catch (error: any) {
      const priceError = new Error("price_unavailable");
      (priceError as any).detail = String(error?.message || "monitor_price_unavailable");
      throw priceError;
    }
    const protectionType = resolveProtectionTypeFromRecord(protection);
    const entryPrice = parsePositiveDecimal(protection.entryPrice) || snapshot.price;
    const drawdownFloorPct = parsePositiveDecimal(protection.drawdownFloorPct) || new Decimal("0.2");
    const triggerPrice =
      parsePositiveDecimal(protection.floorPrice) ||
      computeTriggerPrice(entryPrice, drawdownFloorPct, protectionType);
    const referencePrice = snapshot.price;
    const distanceToTriggerPct = referencePrice.gt(0)
      ? protectionType === "short"
        ? triggerPrice.minus(referencePrice).div(referencePrice).mul(100)
        : referencePrice.minus(triggerPrice).div(referencePrice).mul(100)
      : new Decimal(0);
    const protectedNotional = parsePositiveDecimal(protection.protectedNotional) || new Decimal(0);
    const estimatedTriggerValue = protectedNotional.mul(drawdownFloorPct);
    const quantity = parsePositiveDecimal(protection.size)?.toNumber() || 0;
    const metadataHedgePremium =
      protection.metadata && typeof protection.metadata["hedgePremiumUsd"] === "string"
        ? parsePositiveDecimal(protection.metadata["hedgePremiumUsd"])
        : null;
    let optionMarkUsd = metadataHedgePremium?.toNumber() || parsePositiveDecimal(protection.premium)?.toNumber() || 0;
    let markSource = metadataHedgePremium ? "stored_hedge_premium" : "stored_premium";
    let markDetails: Record<string, unknown> | null = null;
    if (protection.instrumentId && quantity > 0) {
      try {
        const mark = await withTimeout(
          venue.getMark({
            instrumentId: protection.instrumentId,
            quantity
          }),
          pilotConfig.venueMarkTimeoutMs,
          "venue_mark"
        );
        optionMarkUsd = mark.markPremium;
        markSource = mark.source;
        markDetails = mark.details || null;
      } catch (error: any) {
        markDetails = { error: String(error?.message || "mark_unavailable") };
      }
    }
    const expiryMs = Date.parse(protection.expiryAt);
    const timeRemainingMs = Number.isFinite(expiryMs) ? Math.max(0, expiryMs - Date.now()) : 0;
    const hours = Math.floor(timeRemainingMs / 3600000);
    const mins = Math.floor((timeRemainingMs % 3600000) / 60000);
    const timeHuman = timeRemainingMs <= 0 ? "Expired"
      : hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h`
      : `${hours}h ${mins}m`;

    const distanceUsd = protectionType === "short"
      ? triggerPrice.minus(referencePrice).abs()
      : referencePrice.minus(triggerPrice).abs();

    return {
      protectionId: protection.id,
      status: protection.status,
      protectionType,
      protection: {
        id: protection.id,
        status: protection.status,
        tierName: protection.tierName,
        protectedNotional: protection.protectedNotional,
        entryPrice: protection.entryPrice,
        floorPrice: triggerPrice.toFixed(10),
        drawdownFloorPct: protection.drawdownFloorPct,
        expiryAt: protection.expiryAt,
        premium: protection.premium,
        autoRenew: protection.autoRenew,
        payoutDueAmount: protection.payoutDueAmount,
        payoutSettledAmount: protection.payoutSettledAmount,
        venue: protection.venue,
        instrumentId: protection.instrumentId,
        createdAt: protection.createdAt,
      },
      currentPrice: referencePrice.toFixed(10),
      currentPriceSource: snapshot.priceSource,
      currentPriceTimestamp: snapshot.priceTimestamp,
      timeRemaining: {
        ms: timeRemainingMs,
        human: timeHuman
      },
      distanceToFloor: {
        pct: distanceToTriggerPct.toFixed(4),
        usd: distanceUsd.toFixed(2),
        direction: protectionType === "short" ? "above" : "below"
      },
      referencePrice: referencePrice.toFixed(10),
      referenceSource: snapshot.priceSource,
      referenceTimestamp: snapshot.priceTimestamp,
      triggerPrice: triggerPrice.toFixed(10),
      distanceToTriggerPct: distanceToTriggerPct.toFixed(4),
      optionMarkUsd: new Decimal(optionMarkUsd).toFixed(10),
      markSource,
      markDetails,
      estimatedTriggerValue: estimatedTriggerValue.toFixed(10),
      asOf: new Date().toISOString()
    };
  };

  app.get("/pilot/protections/:id/monitor", async (req, reply) => {
    const params = req.params as { id: string };
    let userHash: { userHash: string; hashVersion: number };
    try {
      userHash = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    const protection = await getProtection(pool, params.id);
    if (!protection) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    if (!assertProtectionOwnership(protection, userHash)) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    try {
      const monitor = await buildProtectionMonitorPayload(protection);
      return { status: "ok", monitor };
    } catch (error: any) {
      if (String(error?.message || "") !== "price_unavailable") {
        reply.code(500);
        return {
          status: "error",
          reason: "monitor_unavailable",
          detail: String(error?.message || "monitor_unavailable")
        };
      }
      reply.code(503);
      return {
        status: "error",
        reason: "price_unavailable",
        message: "Price temporarily unavailable, please retry.",
        detail: String((error as any)?.detail || "monitor_price_unavailable")
      };
    }
  });

  app.get("/pilot/admin/protections/:id/monitor", async (req, reply) => {
    const params = req.params as { id: string };
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const protection = await getProtection(pool, params.id);
    if (!protection) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    if (!assertProtectionOwnership(protection, resolveTenantScopeHash())) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    try {
      const monitor = await buildProtectionMonitorPayload(protection);
      return { status: "ok", monitor };
    } catch (error: any) {
      if (String(error?.message || "") !== "price_unavailable") {
        reply.code(500);
        return {
          status: "error",
          reason: "monitor_unavailable",
          detail: String(error?.message || "monitor_unavailable")
        };
      }
      reply.code(503);
      return {
        status: "error",
        reason: "price_unavailable",
        message: "Price temporarily unavailable, please retry.",
        detail: String((error as any)?.detail || "monitor_price_unavailable")
      };
    }
  });

  app.get("/pilot/protections/:id", async (req, reply) => {
    const params = req.params as { id: string };
    let userHash: { userHash: string; hashVersion: number };
    try {
      userHash = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    const protection = await getProtection(pool, params.id);
    if (!protection) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    if (!assertProtectionOwnership(protection, userHash)) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    return {
      status: "ok",
      protection: sanitizeProtectionForTrader(protection as unknown as Record<string, unknown>)
    };
  });

  app.get("/pilot/protections/:id/proof", async (req, reply) => {
    const allowed = await requireProofAccess(req, reply);
    if (!allowed) return;
    const params = req.params as { id: string };
    let userHash: { userHash: string; hashVersion: number };
    try {
      userHash = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    const protection = await getProtection(pool, params.id);
    if (!protection || !assertProtectionOwnership(protection, userHash)) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    const payload = await getEssentialProofPayload(pool, params.id);
    if (!payload) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    return { status: "ok", proof: payload };
  });

  app.get("/pilot/protections/export", async (req, reply) => {
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const query = req.query as {
      format?: string;
      limit?: string;
      scope?: "active" | "open" | "all";
      status?: string;
      includeArchived?: string;
    };
    const scope =
      query.scope === "all" || query.scope === "open" || query.scope === "active" ? query.scope : "active";
    const includeArchived = String(query.includeArchived || "").toLowerCase() === "true";
    const statusRaw = String(query.status || "all").trim().toLowerCase();
    const allowedStatuses = new Set([
      "pending_activation",
      "activation_failed",
      "active",
      "triggered",
      "reconcile_pending",
      "awaiting_renew_decision",
      "awaiting_expiry_price",
      "expired_itm",
      "expired_otm",
      "cancelled",
      "all"
    ]);
    const status = allowedStatuses.has(statusRaw) ? statusRaw : "all";
    const tenant = resolveTenantScopeHash();
    const protections = await listProtectionsByUserHashForAdmin(pool, tenant.userHash, {
      limit: Number(query.limit || 200),
      scope,
      status: status as any,
      includeArchived
    });
    const rows = protections.map((item) => ({
      protection_id: item.id,
      status: item.status,
      tier_name: item.tierName,
      drawdown_floor_pct: item.drawdownFloorPct,
      created_at: item.createdAt,
      expiry_at: item.expiryAt,
      market_id: item.marketId,
      entry_price: item.entryPrice,
      floor_price: item.floorPrice,
      expiry_price: item.expiryPrice,
      protected_notional: item.protectedNotional,
      premium: item.premium,
      payout_due_amount: item.payoutDueAmount,
      payout_settled_amount: item.payoutSettledAmount,
      venue: item.venue,
      instrument_id: item.instrumentId,
      external_order_id: item.externalOrderId,
      external_execution_id: item.externalExecutionId
    }));
    if (String(query.format || "json").toLowerCase() === "csv") {
      reply.header("Content-Type", "text/csv");
      return toCsv(rows);
    }
    return { status: "ok", scope, statusFilter: status, includeArchived, rows };
  });

  app.post("/pilot/admin/protections/archive-except-current", async (req, reply) => {
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const tenant = resolveTenantScopeHash();
    const body = req.body as { keepProtectionId?: string; reason?: string };
    const keepProtectionId = String(body.keepProtectionId || "").trim() || null;
    if (keepProtectionId) {
      const keep = await getProtection(pool, keepProtectionId);
      if (!keep || !assertProtectionOwnership(keep, tenant)) {
        reply.code(404);
        return { status: "error", reason: "keep_protection_not_found" };
      }
    }
    const archivedCount = await archiveProtectionsByUserHashExcept(pool, {
      userHash: tenant.userHash,
      keepProtectionId,
      reason: body.reason || "admin_archive_except_current",
      actor: auth.actor
    });
    await insertAdminAction(pool, {
      protectionId: keepProtectionId,
      action: "archive_except_current",
      actor: auth.actor,
      actorIp: auth.actorIp,
      details: { keepProtectionId, archivedCount, reason: body.reason || "admin_archive_except_current" }
    });
    return { status: "ok", archivedCount, keepProtectionId };
  });

  app.post("/pilot/protections/:id/renewal-decision", async (req, reply) => {
    const params = req.params as { id: string };
    const body = req.body as { decision?: "renew" | "expire" };
    let userHash: { userHash: string; hashVersion: number };
    try {
      userHash = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    const protection = await getProtection(pool, params.id);
    if (!protection) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    if (!assertProtectionOwnership(protection, userHash)) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    if (body.decision === "expire") {
      const updated = await patchProtection(pool, params.id, { status: "cancelled" });
      return {
        status: "ok",
        protection: updated
          ? sanitizeProtectionForTrader(updated as unknown as Record<string, unknown>)
          : null
      };
    }
    if (body.decision === "renew") {
      const now = new Date();
      const previousExpiry = new Date(protection.expiryAt).getTime();
      const nextExpiry = Number.isFinite(previousExpiry)
        ? new Date(previousExpiry + 7 * 86400000)
        : new Date(now.getTime() + 7 * 86400000);
      const cloned = await insertProtection(pool, {
        userHash: protection.userHash,
        hashVersion: protection.hashVersion,
        status: "awaiting_renew_decision",
        tierName: protection.tierName,
        drawdownFloorPct: protection.drawdownFloorPct,
        marketId: protection.marketId,
        protectedNotional: protection.protectedNotional,
        foxifyExposureNotional: protection.foxifyExposureNotional,
        expiryAt: nextExpiry.toISOString(),
        autoRenew: protection.autoRenew,
        renewWindowMinutes: protection.renewWindowMinutes,
        metadata: { renewalOf: protection.id }
      });
      return {
        status: "ok",
        protection: sanitizeProtectionForTrader(cloned as unknown as Record<string, unknown>)
      };
    }
    reply.code(400);
    return { status: "error", reason: "invalid_decision" };
  });

  app.get("/pilot/admin/metrics", async (req, reply) => {
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const query = req.query as { scope?: string };
    const scopeRaw = String(query.scope || "active").toLowerCase();
    const scope = scopeRaw === "all" || scopeRaw === "open" ? scopeRaw : "active";
    const [metrics, brokerSnapshotResult] = await Promise.allSettled([
      getPilotAdminMetrics(pool, {
        startingReserveUsdc: pilotConfig.startingReserveUsdc,
        userHash: resolveTenantScopeHash().userHash,
        scope
      }),
      resolveAdminBrokerBalanceSnapshot()
    ]);
    if (metrics.status !== "fulfilled") {
      throw metrics.reason;
    }
    const brokerBalanceSnapshot =
      brokerSnapshotResult.status === "fulfilled"
        ? brokerSnapshotResult.value
        : {
            status: "error",
            reason: String((brokerSnapshotResult as PromiseRejectedResult).reason?.message || "snapshot_unavailable")
          };
    return { status: "ok", scope, metrics: metrics.value, brokerBalanceSnapshot };
  });

  app.post("/pilot/admin/protections/:id/premium-settled", async (req, reply) => {
    const params = req.params as { id: string };
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const body = req.body as { amount?: number; reference?: string };
    const protection = await getProtection(pool, params.id);
    if (!protection) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    if (!assertProtectionOwnership(protection, resolveTenantScopeHash())) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    const existingLedger = await listLedgerForProtection(pool, params.id);
    const existingPremiumSettlement = existingLedger.find((entry) => entry.entryType === "premium_settled");
    if (existingPremiumSettlement) {
      return {
        status: "ok",
        idempotentReplay: true,
        settledAmount: existingPremiumSettlement.amount,
        settledAt: existingPremiumSettlement.settledAt,
        reference: existingPremiumSettlement.reference
      };
    }
    const amount = Number(body.amount ?? protection.premium ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      reply.code(400);
      return { status: "error", reason: "invalid_amount" };
    }
    await insertLedgerEntry(pool, {
      protectionId: params.id,
      entryType: "premium_settled",
      amount: new Decimal(amount).toFixed(10),
      reference: body.reference || null,
      settledAt: new Date().toISOString()
    });
    await insertAdminAction(pool, {
      protectionId: params.id,
      action: "premium_settled",
      actor: auth.actor,
      actorIp: auth.actorIp,
      details: { amount, reference: body.reference || null }
    });
    return { status: "ok" };
  });

  app.post("/pilot/admin/protections/:id/payout-settled", async (req, reply) => {
    const params = req.params as { id: string };
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const body = req.body as { amount?: number; payoutTxRef?: string };
    const protection = await getProtection(pool, params.id);
    if (!protection) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    if (!assertProtectionOwnership(protection, resolveTenantScopeHash())) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    if (!protection.expiryPrice) {
      reply.code(409);
      return { status: "error", reason: "expiry_price_missing" };
    }
    const existingLedger = await listLedgerForProtection(pool, params.id);
    const existingPayoutSettlement = existingLedger.find((entry) => entry.entryType === "payout_settled");
    if (existingPayoutSettlement) {
      return {
        status: "ok",
        idempotentReplay: true,
        settledAmount: existingPayoutSettlement.amount,
        settledAt: existingPayoutSettlement.settledAt,
        reference: existingPayoutSettlement.reference
      };
    }
    if (new Decimal(protection.payoutSettledAmount || "0").gt(0)) {
      return {
        status: "ok",
        idempotentReplay: true,
        settledAmount: String(protection.payoutSettledAmount),
        settledAt: protection.payoutSettledAt || null,
        reference: protection.payoutTxRef || null
      };
    }
    const amount = Number(body.amount ?? protection.payoutDueAmount ?? 0);
    if (!Number.isFinite(amount) || amount < 0) {
      reply.code(400);
      return { status: "error", reason: "invalid_amount" };
    }
    const payoutDue = new Decimal(protection.payoutDueAmount || "0");
    if (new Decimal(amount).gt(payoutDue)) {
      reply.code(400);
      return {
        status: "error",
        reason: "payout_settlement_exceeds_due",
        payoutDueAmount: payoutDue.toFixed(10)
      };
    }
    await insertLedgerEntry(pool, {
      protectionId: params.id,
      entryType: "payout_settled",
      amount: new Decimal(amount).toFixed(10),
      reference: body.payoutTxRef || null,
      settledAt: new Date().toISOString()
    });
    await patchProtection(pool, params.id, {
      payout_settled_amount: new Decimal(amount).toFixed(10),
      payout_settled_at: new Date().toISOString(),
      payout_tx_ref: body.payoutTxRef || null
    });
    await insertAdminAction(pool, {
      protectionId: params.id,
      action: "payout_settled",
      actor: auth.actor,
      actorIp: auth.actorIp,
      details: { amount, payoutTxRef: body.payoutTxRef || null }
    });
    return { status: "ok" };
  });

  app.get("/pilot/admin/protections/:id/ledger", async (req, reply) => {
    const params = req.params as { id: string };
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const [protection, ledger] = await Promise.all([
      getProtection(pool, params.id),
      listLedgerForProtection(pool, params.id)
    ]);
    if (!protection) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    if (!assertProtectionOwnership(protection, resolveTenantScopeHash())) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    return { status: "ok", protection, ledger };
  });

  app.post("/pilot/internal/protections/:id/resolve-expiry", async (req, reply) => {
    const allowed = await requireInternalOrAdmin(req, reply);
    if (!allowed) return;
    const params = req.params as { id: string };
    await resolveAndPersistExpiry(params.id);
    const protection = await getProtection(pool, params.id);
    if (!protection) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    return { status: "ok", protection };
  });

  const retryEveryMs = Math.max(5000, Number(process.env.EXPIRY_RETRY_INTERVAL_MS || "30000"));
  const expiryInterval = setInterval(async () => {
    try {
      const pending = await pool.query(
        `
          SELECT id FROM pilot_protections
          WHERE status IN ('active', 'awaiting_expiry_price')
            AND expiry_at <= NOW()
            AND expiry_price IS NULL
          ORDER BY expiry_at ASC
          LIMIT 50
        `
      );
      for (const row of pending.rows) {
        await resolveAndPersistExpiry(String(row.id));
      }
    } catch {
      // intentionally swallow to avoid crashing scheduler loop
    }
  }, retryEveryMs);
  expiryInterval.unref?.();
  if (pilotConfig.triggerMonitorEnabled) {
    registerPilotTriggerMonitor(pool);
  }

  const autoRenewIntervalMs = Number(process.env.PILOT_AUTO_RENEW_INTERVAL_MS || "300000");
  const autoRenewInterval = setInterval(async () => {
    try {
      await runAutoRenewCycle({ pool, venue });
    } catch (err: any) {
      console.error(`[AutoRenew] Scheduler error: ${err?.message}`);
    }
  }, autoRenewIntervalMs);
  autoRenewInterval.unref?.();
  console.log(`[AutoRenew] Scheduler started: interval=${autoRenewIntervalMs}ms`);

  app.get("/pilot/monitor/status", async (req, reply) => {
    if (!isAdminAuthorized(req)) {
      reply.code(401);
      return { status: "error", reason: "unauthorized" };
    }
    return { status: "ok", ...monitor.getStatus() };
  });

  app.get("/pilot/monitor/alerts", async (req, reply) => {
    if (!isAdminAuthorized(req)) {
      reply.code(401);
      return { status: "error", reason: "unauthorized" };
    }
    const limit = Math.max(1, Math.min(200, Number((req.query as Record<string, string>).limit || "50")));
    return { status: "ok", alerts: monitor.getRecentAlerts(limit) };
  });

  app.post("/pilot/monitor/treasury-check", async (req, reply) => {
    if (!isAdminAuthorized(req)) {
      reply.code(401);
      return { status: "error", reason: "unauthorized" };
    }
    if (!pilotConfig.bullish.enabled || !pilotConfig.bullish.privateWsUrl) {
      return { status: "error", reason: "bullish_not_configured" };
    }
    try {
      const { BullishTradingClient } = await import("./bullish");
      const client = new BullishTradingClient(pilotConfig.bullish);
      const snapshot = await monitor.checkTreasuryBalance(client);
      return { status: "ok", treasury: snapshot };
    } catch (error) {
      return {
        status: "error",
        reason: "treasury_check_failed",
        message: String((error as Error)?.message || error)
      };
    }
  });
};

