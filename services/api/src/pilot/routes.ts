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
  archiveTestProtectionsByIds,
  creditSimPositionForTrigger,
  createPilotTermsAcceptanceIfMissing,
  extractLatestPremiumPolicyDiagnostics,
  ensurePilotSchema,
  resetPilotData,
  getDailyProtectedNotionalForUser,
  sumActiveProtectionNotional,
  getDailyTierUsageForUser,
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
  incrementExecutionQualityDaily,
  reserveDailyTreasurySubsidyCapacity,
  releaseDailyTreasurySubsidyCapacity,
  reserveDailyActivationCapacity,
  releaseDailyActivationCapacity,
  patchProtection,
  patchProtectionForStatus,
  insertSimPosition,
  insertSimTreasuryLedgerEntry,
  getSimPlatformMetrics
} from "./db";
import { resolvePriceSnapshot, type PriceSnapshotOutput } from "./price";
import { createPilotVenueAdapter, mapVenueFailureReason } from "./venue";
import { registerPilotTriggerMonitor } from "./triggerMonitor";
import { runAutoRenewCycle } from "./autoRenew";
import { runHedgeManagementCycle } from "./hedgeManager";
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
import { isValidSlTier, computeV7Premium, slPctToDrawdownFloor, slPctToTierLabel, getV7AvailableTiers, getV7TenorDays, getV7PremiumPer1k } from "./v7Pricing";
import { getCurrentRegime, configureRegimeClassifier } from "./regimeClassifier";
import {
  getCurrentPricingRegime,
  type PricingRegime
} from "./pricingRegime";
import {
  configureCircuitBreaker,
  getCircuitBreakerConfig,
  getCircuitBreakerState,
  isCircuitBreakerActive,
  recordBalanceSample,
  resetCircuitBreaker
} from "./circuitBreaker";

// Format a USD amount as a comma-separated whole-dollar string for
// inclusion in user-facing error messages. Examples:
//   100000     → "100,000"
//   60000.4    → "60,000"
//   "200000"   → "200,000"
// Use this in every cap/limit message so the trader sees "$200,000"
// instead of "$200000".
const fmtUsdWhole = (value: number | string | { toFixed: (n: number) => string }): string => {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    n = Number(value);
  } else if (value && typeof (value as any).toFixed === "function") {
    n = Number((value as { toFixed: (n: number) => string }).toFixed(2));
  } else {
    n = NaN;
  }
  if (!Number.isFinite(n)) return String(value);
  return Math.round(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
};

// Design A — Volatility label shown next to the price in the widget.
// Maps internal regime IDs to user-facing strings. "Low / Moderate /
// Elevated / High" was selected over "Calm / Active / Choppy /
// Stressed" because "Volatility" is universally understood by traders
// and the labels form a clear monotonic scale.
const pricingRegimeLabel = (regime: PricingRegime): string => {
  switch (regime) {
    case "low":
      return "Low";
    case "moderate":
      return "Moderate";
    case "elevated":
      return "Elevated";
    case "high":
      return "High";
  }
};
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
    } catch (err: any) {
      console.warn(`[SimTriggerMonitor] Price error for sim=${simPosition.id}: ${err?.message || "unknown"}`);
      continue;
    }
    const entryPrice = parsePositiveDecimal(simPosition.entryPrice);
    const drawdownFloorPct = parsePositiveDecimal(simPosition.drawdownFloorPct);
    const protectedLossUsd = parsePositiveDecimal(simPosition.protectedLossUsd);
    if (!entryPrice || !drawdownFloorPct || !protectedLossUsd) continue;
    const triggerPrice = parsePositiveDecimal(simPosition.floorPrice) || computeTriggerPrice(entryPrice, drawdownFloorPct, "long");
    const breached = snapshot.price.lessThanOrEqualTo(triggerPrice);
    if (!breached) continue;
    console.log(`[SimTriggerMonitor] TRIGGERED: sim=${simPosition.id} protection=${protectionId} spot=$${snapshot.price.toFixed(2)} floor=$${triggerPrice.toFixed(2)} payout=$${protectedLossUsd.toFixed(2)}`);
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
  deps: { deribit: DeribitConnector; deribitLive?: DeribitConnector }
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
      message: "Too many requests. Try again shortly."
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

  const deribitLivePricingVenue = deps.deribitLive ? createPilotVenueAdapter({
    mode: "deribit_live",
    falconx: { baseUrl: "", apiKey: "", secret: "", passphrase: "" },
    deribit: deps.deribitLive,
    quoteTtlMs: pilotConfig.quoteTtlMs,
    deribitQuotePolicy: "ask_or_mark_fallback",
    deribitStrikeSelectionMode: "trigger_aligned",
    deribitMaxTenorDriftDays: 7
  }) : deribitVenue;

  if (pilotConfig.v7.enabled) {
    // DVOL/RVOL must come from Deribit MAINNET regardless of trading-account
    // environment. Testnet's volatility-index endpoint serves synthetic flat
    // values (~133 as of 2026-04 — not a real market reading) which would
    // mis-tune the DVOL-adaptive TP logic and the BS recovery model.
    // deps.deribitLive is the read-only mainnet connector wired in
    // services/api/src/server.ts. Falls back to deps.deribit only if no
    // separate mainnet connector was provided (e.g. in some tests).
    const regimeConnector = deps.deribitLive ?? deps.deribit;
    configureRegimeClassifier({
      deribitConnector: regimeConnector,
      thresholds: {
        calmBelow: pilotConfig.v7.dvolCalmThreshold,
        stressAbove: pilotConfig.v7.dvolStressThreshold
      }
    });
    console.log(`[V7] Regime classifier configured: calm<${pilotConfig.v7.dvolCalmThreshold}% stress>${pilotConfig.v7.dvolStressThreshold}% tenor=${pilotConfig.v7.defaultTenorDays}d source=${deps.deribitLive ? "deribit_mainnet" : "deribit_default"}`);
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
        message: "Quote temporarily unavailable. Tap Refresh Quote.",
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
        message: "Quote temporarily unavailable. Tap Refresh Quote.",
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
        message: "Quote temporarily unavailable. Tap Refresh Quote.",
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
      // Design A — expose the pricing regime so the widget can display
      // "Volatility: Moderate" next to the price.
      const pricingRegimeStatus = getCurrentPricingRegime(regimeStatus.dvol);
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
        },
        pricingRegime: pricingRegimeStatus.regime,
        pricingRegimeLabel: pricingRegimeLabel(pricingRegimeStatus.regime),
        pricingRegimeSource: pricingRegimeStatus.source,
        pricingRegimeRollingWindowMinutes: pricingRegimeStatus.rollingWindowMinutes
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
      const pricingConnector = deps.deribitLive || deps.deribit;
      const spot = await (async () => {
        const ticker = await pricingConnector.getIndexPrice("btc_usd");
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
          const dq = await deribitLivePricingVenue.quote({
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
    const venueMode = String(venue.mode || "");
    const venueHealthy = venueMode.startsWith("ibkr_") ? isIbkrLiveTransportHealthy(venue) : true;
    const overallOk = db.status === "ok" && price.status === "ok" && venueHealthy;
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

  /**
   * GET /pilot/admin/diagnostics/per-trade-fills?limit=20
   *
   * Per-trade execution diagnostic. Returns, for each recent
   * pilot_venue_execution row, the captured-at-quote `askPriceBtc`,
   * the realized `fillPriceBtc`, the source of the ask snapshot
   * (live ask vs mark-fallback), and the implied slippage in basis
   * points. This is what the daily-rollup /execution-quality
   * endpoint averages — exposing the per-row data lets operators
   * diagnose whether observed slippage is real microstructure
   * (timing artifact, sub-ask fills) or a measurement artifact
   * (e.g., quote captured against mark-price not real ask).
   *
   * Default limit 20 rows, max 200.
   */
  app.get("/pilot/admin/diagnostics/per-trade-fills", async (req, reply) => {
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const limitRaw = Number((req.query as { limit?: string })?.limit || "20");
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(200, Math.floor(limitRaw)))
      : 20;
    try {
      const result = await pool.query(
        `
          SELECT
            e.id,
            e.protection_id,
            e.venue,
            e.instrument_id,
            e.quantity::text AS quantity,
            e.execution_price::text AS execution_price_usd,
            e.executed_at,
            e.details AS execution_details,
            q.details AS quote_details,
            q.expires_ts AS quote_expires_at
          FROM pilot_venue_executions e
          LEFT JOIN pilot_venue_quotes q ON q.quote_id = e.quote_id
          ORDER BY e.executed_at DESC
          LIMIT $1
        `,
        [limit]
      );
      const rows = result.rows.map((row: Record<string, unknown>) => {
        const exec = (row.execution_details as Record<string, unknown> | null) || {};
        const quote = (row.quote_details as Record<string, unknown> | null) || {};
        const askPriceBtc = Number(quote.askPriceBtc);
        const fillPriceBtc = Number(exec.fillPriceBtc);
        const askSource = String(quote.askSource || "");
        const slippageBps =
          Number.isFinite(askPriceBtc) && askPriceBtc > 0 && Number.isFinite(fillPriceBtc) && fillPriceBtc > 0
            ? ((fillPriceBtc - askPriceBtc) / askPriceBtc) * 10_000
            : null;
        return {
          executionId: String(row.id),
          protectionId: String(row.protection_id),
          venue: String(row.venue),
          instrumentId: String(row.instrument_id),
          executedAt: row.executed_at ? new Date(String(row.executed_at)).toISOString() : null,
          quoteExpiresAt: row.quote_expires_at ? new Date(String(row.quote_expires_at)).toISOString() : null,
          quantity: String(row.quantity),
          executionPriceUsd: String(row.execution_price_usd),
          quotedAskBtc: Number.isFinite(askPriceBtc) ? askPriceBtc : null,
          fillPriceBtc: Number.isFinite(fillPriceBtc) ? fillPriceBtc : null,
          askSource: askSource || null,
          slippageBps: slippageBps !== null ? Number(slippageBps.toFixed(4)) : null,
          slippageInterpretation:
            slippageBps === null
              ? "unknown_missing_fields"
              : slippageBps > 5
                ? "filled_worse_than_quoted"
                : slippageBps < -5
                  ? "filled_better_than_quoted"
                  : "fill_matched_quote"
        };
      });
      return {
        status: "ok",
        rows,
        summary: {
          count: rows.length,
          mean_slippage_bps:
            rows.length === 0
              ? null
              : Number(
                  (
                    rows
                      .filter((r) => r.slippageBps !== null)
                      .reduce((acc, r) => acc + (r.slippageBps || 0), 0) /
                    Math.max(1, rows.filter((r) => r.slippageBps !== null).length)
                  ).toFixed(4)
                ),
          ask_source_breakdown: rows.reduce(
            (acc, r) => {
              const k = r.askSource || "unknown";
              acc[k] = (acc[k] || 0) + 1;
              return acc;
            },
            {} as Record<string, number>
          )
        }
      };
    } catch (error: any) {
      reply.code(500);
      return {
        status: "error",
        reason: String(error?.message || "per_trade_diagnostic_failed")
      };
    }
  });

  /**
   * GET /pilot/admin/diagnostics/triggered-protections?limit=20&direction=all
   *
   * One row per protection that has reached `status='triggered'` (regardless
   * of whether the hedge has been sold yet). Designed to be the primary
   * day-to-day surface the operator uses to validate option-selection
   * quality, TP performance, and SHORT-vs-LONG behavior post PR #76.
   *
   * For each triggered protection, returns:
   *   - identity:        id, direction (long/short), SL%, notional, entry, trigger
   *   - hedge geometry:  selected strike, strike gap to trigger (signed: + OTM, - ITM)
   *   - hedge timeline:  triggered_at, hedge_status, sold_at, time_from_trigger_to_sell_min
   *   - cash flows:      premium, hedge cost, hedge recovery, payout owed, net P&L
   *   - recovery ratio:  hedge_recovery / payout_owed × 100 (vs R1 baseline 68.3%)
   *   - trajectory hint: spot_at_trigger, spot_at_sell, spot_move_through_trigger_pct
   *                      (e.g., +0.15% = barely grazed, +1.2% = clear breakout)
   *
   * Sort: most recently triggered first. Default limit 20, max 100.
   *
   * Query params:
   *   - limit:     1-100 (default 20)
   *   - direction: 'all' | 'long' | 'short' (default 'all')
   *
   * Used by:
   *   - Admin dashboard "Triggered Trades" tab (visual review)
   *   - scripts/pilot-trade-investigate (deep-dive on a single ID)
   *   - Post-pilot calibration analyses (recovery distribution by direction)
   */
  app.get("/pilot/admin/diagnostics/triggered-protections", async (req, reply) => {
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const q = req.query as { limit?: string; direction?: string };
    const limitRaw = Number(q?.limit || "20");
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(100, Math.floor(limitRaw)))
      : 20;
    const direction = q?.direction === "long" || q?.direction === "short" ? q.direction : "all";
    try {
      // Pull triggered protections + their executions in one round-trip.
      // We use LATERAL join so per-protection execution aggregation is
      // pushed into Postgres rather than N+1 queries from Node.
      const triggeredResult = await pool.query(
        `
          SELECT
            p.id, p.status, p.hedge_status,
            p.tier_name, p.sl_pct, p.drawdown_floor_pct,
            p.protected_notional::text   AS protected_notional,
            p.entry_price::text          AS entry_price,
            p.floor_price::text          AS floor_price,
            p.execution_price::text      AS execution_price,
            p.size::text                 AS size,
            p.expiry_at, p.executed_at, p.created_at, p.side,
            p.metadata
          FROM pilot_protections p
          WHERE p.status IN ('triggered', 'reconcile_pending')
             OR (p.metadata->>'triggeredAt') IS NOT NULL
             OR (p.hedge_status IN ('tp_sold', 'expired_settled', 'expired_worthless'))
          ORDER BY COALESCE(
            (p.metadata->>'triggeredAt')::timestamptz,
            p.executed_at,
            p.created_at
          ) DESC
          LIMIT $1
        `,
        [Math.max(limit * 3, 60)] // overfetch then filter for direction client-side
      );

      const protections = (triggeredResult.rows as Array<Record<string, unknown>>).map((row) => ({
        id: String(row.id),
        status: String(row.status || ""),
        hedgeStatus: row.hedge_status ? String(row.hedge_status) : null,
        tierName: row.tier_name ? String(row.tier_name) : null,
        slPct: row.sl_pct === null || row.sl_pct === undefined ? null : Number(row.sl_pct),
        drawdownFloorPct: row.drawdown_floor_pct === null || row.drawdown_floor_pct === undefined
          ? null : Number(row.drawdown_floor_pct),
        protectedNotional: row.protected_notional ? String(row.protected_notional) : "0",
        entryPrice: row.entry_price ? String(row.entry_price) : null,
        floorPrice: row.floor_price ? String(row.floor_price) : null,
        executionPrice: row.execution_price ? String(row.execution_price) : null,
        size: row.size ? String(row.size) : null,
        expiryAt: row.expiry_at ? new Date(String(row.expiry_at)).toISOString() : null,
        executedAt: row.executed_at ? new Date(String(row.executed_at)).toISOString() : null,
        createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null,
        side: row.side ? String(row.side) : null,
        metadata: (row.metadata as Record<string, unknown>) || {}
      }));

      // Per-protection executions
      const ids = protections.map((p) => p.id);
      let executionsByProtection: Map<string, Array<Record<string, unknown>>> = new Map();
      if (ids.length > 0) {
        const execResult = await pool.query(
          `
            SELECT protection_id, side, premium, execution_price, quantity,
                   executed_at, status, details, instrument_id
            FROM pilot_venue_executions
            WHERE protection_id = ANY($1::text[])
            ORDER BY created_at ASC
          `,
          [ids]
        );
        executionsByProtection = new Map();
        for (const r of execResult.rows as Array<Record<string, unknown>>) {
          const key = String(r.protection_id);
          const list = executionsByProtection.get(key) || [];
          list.push(r);
          executionsByProtection.set(key, list);
        }
      }

      // Per-protection price snapshots (entry + trigger)
      let snapshotsByProtection: Map<string, Array<Record<string, unknown>>> = new Map();
      if (ids.length > 0) {
        const snapResult = await pool.query(
          `
            SELECT protection_id, snapshot_type, price, price_timestamp, created_at
            FROM pilot_price_snapshots
            WHERE protection_id = ANY($1::text[])
            ORDER BY created_at ASC
          `,
          [ids]
        );
        snapshotsByProtection = new Map();
        for (const r of snapResult.rows as Array<Record<string, unknown>>) {
          const key = String(r.protection_id);
          const list = snapshotsByProtection.get(key) || [];
          list.push(r);
          snapshotsByProtection.set(key, list);
        }
      }

      // Per-protection ledger entries (for premium / payout)
      let ledgerByProtection: Map<string, Array<Record<string, unknown>>> = new Map();
      if (ids.length > 0) {
        const lr = await pool.query(
          `
            SELECT protection_id, entry_type, amount, settled_at, created_at
            FROM pilot_ledger_entries
            WHERE protection_id = ANY($1::text[])
          `,
          [ids]
        );
        ledgerByProtection = new Map();
        for (const r of lr.rows as Array<Record<string, unknown>>) {
          const key = String(r.protection_id);
          const list = ledgerByProtection.get(key) || [];
          list.push(r);
          ledgerByProtection.set(key, list);
        }
      }

      const rows = protections
        .map((p) => {
          const md = (p.metadata || {}) as Record<string, unknown>;
          const protType = String(md.protectionType || p.side || "long").toLowerCase();
          const directionTag = protType === "short" ? "short" : "long";

          const execs = executionsByProtection.get(p.id) || [];
          const snaps = snapshotsByProtection.get(p.id) || [];
          const ledger = ledgerByProtection.get(p.id) || [];

          const buyExec = execs.find((e) => String(e.side).toLowerCase() === "buy");
          const sellExec = execs.find((e) => String(e.side).toLowerCase() === "sell");

          // Cash flows
          const premiumCollected = ledger
            .filter((l) => String(l.entry_type) === "premium_due")
            .reduce((acc, l) => acc + Number(l.amount || 0), 0);
          const payoutOwed = ledger
            .filter((l) => ["payout_due", "trigger_payout_due"].includes(String(l.entry_type)))
            .reduce((acc, l) => acc + Number(l.amount || 0), 0);
          const hedgeCost = buyExec ? Number(buyExec.premium || 0) : 0;
          const hedgeRecovery = sellExec ? Number(sellExec.premium || 0) : 0;
          const netPnlUsd = premiumCollected - hedgeCost + hedgeRecovery - payoutOwed;
          const recoveryRatioPct = payoutOwed > 0 ? (hedgeRecovery / payoutOwed) * 100 : null;

          // Strike geometry
          const buyDetails = (buyExec?.details as Record<string, unknown>) || {};
          const selectedStrike = Number(md.selectedStrike || buyDetails.selectedStrike || 0);
          const triggerPriceFromMd = Number(md.triggerPrice || md.floorPrice || 0);
          const triggerPrice = triggerPriceFromMd > 0
            ? triggerPriceFromMd
            : Number(p.floorPrice || 0);
          const strikeGapToTriggerUsd = selectedStrike > 0 && triggerPrice > 0
            ? selectedStrike - triggerPrice
            : null;
          const strikeIsItm = strikeGapToTriggerUsd !== null && (
            directionTag === "short"
              ? strikeGapToTriggerUsd < 0    // call strike below trigger = ITM
              : strikeGapToTriggerUsd > 0    // put strike above trigger = ITM
          );

          // Timing
          const triggeredAtIso = md.triggeredAt ? String(md.triggeredAt) : null;
          const soldAtIso = md.soldAt ? String(md.soldAt) : (sellExec?.executed_at ? new Date(String(sellExec.executed_at)).toISOString() : null);
          let timeFromTriggerToSellMin: number | null = null;
          if (triggeredAtIso && soldAtIso) {
            const delta = new Date(soldAtIso).getTime() - new Date(triggeredAtIso).getTime();
            if (Number.isFinite(delta) && delta >= 0) {
              timeFromTriggerToSellMin = Math.round(delta / 60000);
            }
          }

          // Trajectory: spot at trigger vs spot at sell.
          // Falls back to entry_price snapshot when trigger snapshot is missing.
          const triggerSnap = snaps.find((s) => String(s.snapshot_type) === "trigger");
          const entrySnap = snaps.find((s) => String(s.snapshot_type) === "entry");
          const spotAtTrigger = triggerSnap ? Number(triggerSnap.price) : null;
          const entrySpot = entrySnap ? Number(entrySnap.price) : Number(p.entryPrice || 0);
          const spotAtSell = sellExec ? Number(buyDetails.spotPriceUsd || 0) : null;
          // "spot move through trigger" = how far past the trigger BTC went
          // before starting to retrace. Critical signal for whether barely-graze
          // (small move, expect retrace) or clear breakout (large move, expect continuation).
          let spotMoveThroughTriggerPct: number | null = null;
          if (spotAtTrigger && triggerPrice > 0) {
            const moveBeyondTrigger = directionTag === "short"
              ? spotAtTrigger - triggerPrice
              : triggerPrice - spotAtTrigger;
            spotMoveThroughTriggerPct = (moveBeyondTrigger / triggerPrice) * 100;
          }

          return {
            id: p.id,
            createdAt: p.createdAt,
            direction: directionTag as "long" | "short",
            slPct: p.slPct,
            tierName: p.tierName,
            protectedNotionalUsd: Number(p.protectedNotional || 0),
            entryPrice: entrySpot,
            triggerPrice,
            expiryAt: p.expiryAt,
            status: p.status,
            hedgeStatus: p.hedgeStatus,

            // Hedge geometry (the PR #76 success metric)
            selectedStrike: selectedStrike || null,
            strikeGapToTriggerUsd,
            strikeIsItm,

            // Timing (the SHORT TP rule research signal)
            triggeredAt: triggeredAtIso,
            soldAt: soldAtIso,
            timeFromTriggerToSellMin,

            // Trajectory (barely-graze detection)
            spotAtTrigger,
            spotAtSell,
            spotMoveThroughTriggerPct,
            // Convenient classification for UI badges:
            triggerPattern:
              spotMoveThroughTriggerPct === null
                ? "unknown"
                : spotMoveThroughTriggerPct < 0.3
                  ? "barely_graze"
                  : spotMoveThroughTriggerPct < 1.0
                    ? "shallow"
                    : "clear_breakout",

            // Cash
            premiumCollectedUsd: premiumCollected,
            hedgeCostUsd: hedgeCost,
            hedgeRecoveryUsd: hedgeRecovery,
            payoutOwedUsd: payoutOwed,
            netPnlUsd: Number(netPnlUsd.toFixed(2)),
            recoveryRatioPct: recoveryRatioPct === null ? null : Number(recoveryRatioPct.toFixed(1))
          };
        })
        .filter((r) => direction === "all" || r.direction === direction)
        .slice(0, limit);

      // Summary aggregates (across the displayed rows). Caller-friendly
      // — keeps the dashboard from re-aggregating in JS.
      const sold = rows.filter((r) => r.recoveryRatioPct !== null);
      const longSold = sold.filter((r) => r.direction === "long");
      const shortSold = sold.filter((r) => r.direction === "short");
      const avg = (xs: number[]) =>
        xs.length === 0 ? null : Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2));

      return {
        status: "ok",
        rows,
        summary: {
          totalTriggered: rows.length,
          totalSold: sold.length,
          avgRecoveryRatioPct: avg(sold.map((r) => r.recoveryRatioPct as number)),
          avgRecoveryRatioLongPct: avg(longSold.map((r) => r.recoveryRatioPct as number)),
          avgRecoveryRatioShortPct: avg(shortSold.map((r) => r.recoveryRatioPct as number)),
          avgNetPnlUsd: avg(rows.map((r) => r.netPnlUsd)),
          netPnlUsdSum: Number(rows.reduce((acc, r) => acc + r.netPnlUsd, 0).toFixed(2)),
          baselineRecoveryRatioPct: 68.3, // R1 LONG-only baseline
          patternBreakdown: rows.reduce(
            (acc, r) => {
              acc[r.triggerPattern] = (acc[r.triggerPattern] || 0) + 1;
              return acc;
            },
            {} as Record<string, number>
          ),
          itmStrikeRatePct:
            rows.length === 0
              ? null
              : Number(((rows.filter((r) => r.strikeIsItm).length / rows.length) * 100).toFixed(1))
        }
      };
    } catch (error: any) {
      reply.code(500);
      return {
        status: "error",
        reason: String(error?.message || "triggered_protections_diagnostic_failed")
      };
    }
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
        message: `Minimum quote notional is $${fmtUsdWhole(quoteMinNotional)} during pilot.`,
        minQuoteNotionalUsdc: quoteMinNotional.toFixed(2)
      };
    }
    const maxProtection = new Decimal(pilotConfig.maxProtectionNotionalUsdc);
    const maxDailyProtection = new Decimal(pilotConfig.maxDailyProtectedNotionalUsdc);
    const maxAggregateActive = new Decimal(pilotConfig.maxAggregateActiveNotionalUsdc);
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
        message: "Quote temporarily unavailable. Tap Refresh Quote.",
        detail: String(error?.message || "daily_limit_query_failed")
      };
    }
    // R2.B — Aggregate active notional cap (Pilot Agreement §3.1: $200k).
    // Quote-side check is informational only (the binding atomic check is in
    // the activate path inside the activation transaction). We surface here
    // to fail-fast before quoting, so the trader's UI can show a friendly
    // error instead of letting the quote succeed and the activate fail.
    try {
      const activeAgg = new Decimal(
        await sumActiveProtectionNotional(pool, userHash.userHash)
      );
      const projectedAgg = activeAgg.plus(protectedNotional);
      if (projectedAgg.gt(maxAggregateActive)) {
        reply.code(400);
        return {
          status: "error",
          reason: "aggregate_active_notional_cap_exceeded",
          capUsdc: maxAggregateActive.toFixed(2),
          currentActiveUsdc: activeAgg.toFixed(2),
          projectedAfterUsdc: projectedAgg.toFixed(2),
          message:
            `You'd have $${fmtUsdWhole(projectedAgg)} of protection open. ` +
            `Pilot limit is $${fmtUsdWhole(maxAggregateActive)}. ` +
            `Close one or wait for it to expire.`
        };
      }
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "storage_unavailable",
        message: "Quote temporarily unavailable. Tap Refresh Quote.",
        detail: String(error?.message || "aggregate_active_query_failed")
      };
    }
    // R2.D — Per-tier daily concentration cap (defense-in-depth, not in
    // agreement). Caps the fraction of daily new-protection notional that
    // may be in any single SL tier. Default 60%. Goal: prevent the
    // single-event simultaneous-trigger pattern that produced the −$2,127
    // paper outcome on 2026-04-18 (n=9 R1 analysis).
    // Only enforced when the v7 pricing path is in use (we know slPct).
    {
      const slPctEarly = body?.slPct != null ? Number(body.slPct) : null;
      const validSlPctEarly =
        pilotConfig.v7.enabled && slPctEarly !== null && isValidSlTier(slPctEarly)
          ? (slPctEarly as V7SlTier)
          : null;
      if (validSlPctEarly !== null && pilotConfig.perTierDailyCapPct < 1) {
        try {
          const tierUsed = new Decimal(
            await getDailyTierUsageForUser(
              pool,
              userHash.userHash,
              validSlPctEarly,
              dayStart.toISOString(),
              dayEnd.toISOString()
            )
          );
          const tierCap = maxDailyProtection.mul(pilotConfig.perTierDailyCapPct);
          const projectedTier = tierUsed.plus(protectedNotional);
          if (projectedTier.gt(tierCap)) {
            reply.code(400);
            return {
              status: "error",
              reason: "per_tier_daily_concentration_cap_exceeded",
              tierSlPct: validSlPctEarly,
              capPct: pilotConfig.perTierDailyCapPct,
              tierCapUsdc: tierCap.toFixed(2),
              currentTierUsageUsdc: tierUsed.toFixed(2),
              projectedAfterUsdc: projectedTier.toFixed(2),
              message:
                `${validSlPctEarly}% protection is full for today ` +
                `(would reach $${fmtUsdWhole(projectedTier)}, limit is $${fmtUsdWhole(tierCap)}). ` +
                `Try a different level or wait until tomorrow.`
            };
          }
        } catch (error: any) {
          reply.code(503);
          return {
            status: "error",
            reason: "storage_unavailable",
            message: "Quote temporarily unavailable. Tap Refresh Quote.",
            detail: String(error?.message || "tier_concentration_query_failed")
          };
        }
      }
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
        message: "Quote temporarily unavailable. Tap Refresh Quote.",
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
      let v7ClientPremiumHint = 0;
      if (v7Enabled && resolvedSlPct) {
        const ratePer1k = getV7PremiumPer1k(resolvedSlPct);
        v7ClientPremiumHint = protectedNotional.div(1000).mul(ratePer1k).toNumber();
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
          clientPremiumUsd: v7ClientPremiumHint > 0 ? v7ClientPremiumHint : undefined,
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
          available: v7Quote.available,
          // Design A — surface the pricing regime label and human-friendly
          // text the widget displays next to the premium so the trader
          // sees the volatility context behind the price.
          pricingRegime: getCurrentPricingRegime(v7Quote.dvol).regime,
          pricingRegimeLabel: pricingRegimeLabel(
            getCurrentPricingRegime(v7Quote.dvol).regime
          )
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
          ? "Quote temporarily unavailable. Tap Refresh Quote."
          : isTransportNotLive
            ? "Exchange connection isn't live. Try again."
            : isTenorTemporarilyUnavailable
              ? "That length is temporarily unavailable. Try the suggested length."
            : isVenueQuoteTimeout
              ? "Quote timed out. Tap Refresh Quote."
            : isNoViableOption
              ? noViableReason === "quote_economics_unacceptable"
                ? "Hedge cost is uneconomical right now. Try a different length."
                : noViableReason === "quote_min_notional_not_met"
                  ? "Below the exchange minimum. Increase amount."
                : "No matching option found. Try a different length."
            : isNoTopOfBook
              ? "Exchange order book temporarily unavailable. Try again."
            : isNoEconomicalOption
              ? "Hedge cost is uneconomical right now. Try a different length."
            : isNoProtectionCompliantOption
              ? "No option meets the protection threshold. Try a different length."
            : isOptionsRequired
              ? "No tradeable option available right now. Try again shortly."
            : isNoLiquidityWindow
              ? "Market closed for options. Try again during active session."
            : isNoContract
              ? "No matching contract right now. Try again."
            : isPremiumGuardrail
              ? "Hedge cost outside our safety limit. Try a different length."
            : isTenorDriftExceeded
              ? "No option matched that length. Try the suggested one."
          : "Couldn't get a quote right now. Try again.",
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
    const quoteStartedAt = Date.now();
    if (!enforcePilotWindow(reply)) return;
    if (!pilotConfig.activationEnabled) {
      reply.code(503);
      return {
        status: "error",
        reason: "activation_disabled",
        message: "Activation is paused while quotes are validated. Quoting still works."
      };
    }
    // PR B (Gap 2) — circuit breaker: refuse new sales if Deribit
    // equity has dropped > threshold in the rolling window. Returns
    // a 503 so clients understand the platform is temporarily
    // unavailable, not that their request was malformed.
    if (isCircuitBreakerActive()) {
      const cbState = getCircuitBreakerState();
      reply.code(503);
      return {
        status: "error",
        reason: "circuit_breaker_active",
        message: "Platform paused for safety review. Please try again later.",
        circuitBreaker: cbState
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
        message: `Minimum quote notional is $${fmtUsdWhole(quoteMinNotional)} during pilot.`,
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
      // R2.B (binding) — Aggregate active notional cap. Run inside the
      // activation transaction so two concurrent activations cannot both
      // pass a stale read. Postgres serializes the SUM under the same
      // client/transaction ordering as the subsequent INSERT.
      // The check is read-then-decide, so true atomicity requires that
      // reads from this client see committed inserts from any earlier
      // concurrent transaction (default READ COMMITTED). At pilot single-
      // user scale this is bulletproof; at multi-user prod scale a
      // SELECT … FOR UPDATE on a per-user lock row would be stronger.
      const maxAggregateActiveAct = new Decimal(pilotConfig.maxAggregateActiveNotionalUsdc);
      const activeAggAct = new Decimal(
        await sumActiveProtectionNotional(client, userHash.userHash)
      );
      const projectedAggAct = activeAggAct.plus(protectedNotional);
      if (projectedAggAct.gt(maxAggregateActiveAct)) {
        const aggErr = new Error("aggregate_active_notional_cap_exceeded");
        (aggErr as any).capUsdc = maxAggregateActiveAct.toFixed(2);
        (aggErr as any).currentActiveUsdc = activeAggAct.toFixed(2);
        (aggErr as any).projectedAfterUsdc = projectedAggAct.toFixed(2);
        throw aggErr;
      }

      // R2.D (binding) — Per-tier daily concentration cap. Same scoping
      // story as above. Only enforced when pricing path is V7 with a
      // launched tier (i.e. we have a numeric slPct).
      if (
        v7EnabledActivate &&
        activateSlPct !== null &&
        pilotConfig.perTierDailyCapPct < 1
      ) {
        const dayEndAct = new Date(dayStart.getTime() + 86400000);
        const tierUsedAct = new Decimal(
          await getDailyTierUsageForUser(
            client,
            userHash.userHash,
            activateSlPct,
            dayStart.toISOString(),
            dayEndAct.toISOString()
          )
        );
        const tierCapAct = maxDailyProtection.mul(pilotConfig.perTierDailyCapPct);
        const projectedTierAct = tierUsedAct.plus(protectedNotional);
        if (projectedTierAct.gt(tierCapAct)) {
          const tierErr = new Error("per_tier_daily_concentration_cap_exceeded");
          (tierErr as any).tierSlPct = activateSlPct;
          (tierErr as any).capPct = pilotConfig.perTierDailyCapPct;
          (tierErr as any).tierCapUsdc = tierCapAct.toFixed(2);
          (tierErr as any).currentTierUsageUsdc = tierUsedAct.toFixed(2);
          (tierErr as any).projectedAfterUsdc = projectedTierAct.toFixed(2);
          throw tierErr;
        }
      }

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
      const venueStepSize = pilotConfig.venueMode === "deribit_live" || pilotConfig.venueMode === "deribit_test" ? 10 : 100;
      const effectiveRequestedQty = v7EnabledActivate
        ? Math.floor(requestedQuantity * venueStepSize) / venueStepSize
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
      // Compute realized HEDGE slippage = (fill_unit_price - quoted_ask) / quoted_ask × 10_000
      //
      // The prior implementation compared execution.premium vs lockedQuote.premium —
      // but both of those are the V7 client-facing premium ($notional/1000 × ratePer1k),
      // which is fixed and identical at quote and execute time. That formula was
      // mathematically guaranteed to be 0 for every pilot activation (PR #34 surfaced
      // the bug; PR is the fix).
      //
      // Real slippage is the gap between what we quoted (the venue ask seen at quote
      // time) and what we actually paid Deribit (the fill price). This number can be
      // signed: positive = paid above ask (slipped against us); negative = price
      // improvement (good fill). We track the SIGNED value so improvements aren't
      // hidden behind a Math.max(0, ...) clamp.
      //
      // Deribit adapter populates askPriceBtc + fillPriceBtc in details. Other
      // venues (legacy IBKR/Bullish, dormant in the pilot) fall back to the USD-
      // unit-price comparison.
      const quoteDetails = (lockedQuote.details || {}) as Record<string, unknown>;
      const execDetails = (execution.details || {}) as Record<string, unknown>;
      const quotedAskBtc = Number(quoteDetails.askPriceBtc);
      const fillPriceBtc = Number(execDetails.fillPriceBtc);
      let realizedSlippageBps = 0;
      let slippageSource: "deribit_btc_units" | "usd_unit_fallback" | "unavailable" = "unavailable";
      if (Number.isFinite(quotedAskBtc) && quotedAskBtc > 0 && Number.isFinite(fillPriceBtc) && fillPriceBtc > 0) {
        realizedSlippageBps = ((fillPriceBtc - quotedAskBtc) / quotedAskBtc) * 10_000;
        slippageSource = "deribit_btc_units";
      } else if (
        Number.isFinite(execution.executionPrice) && execution.executionPrice > 0 &&
        Number.isFinite(Number(quoteDetails.quotedUnitPriceUsd)) && Number(quoteDetails.quotedUnitPriceUsd) > 0
      ) {
        const quotedUnitUsd = Number(quoteDetails.quotedUnitPriceUsd);
        realizedSlippageBps = ((execution.executionPrice - quotedUnitUsd) / quotedUnitUsd) * 10_000;
        slippageSource = "usd_unit_fallback";
      }
      // USD-denominated slippage. Same sign convention as bps: negative
      // = filled cheaper than quoted (in our favor). Computed in USD so
      // operators can interpret outliers economically without bps-on-
      // small-denomination distortion. Single-tick fills on cheap
      // deep-OTM puts inflate bps but produce dollar-immaterial
      // numbers (e.g., 1 tick on a 0.0033 BTC quote ≈ -300 bps but
      // only ~$0.75 of real impact).
      let realizedSlippageUsd: number | undefined;
      const spotForSlippage = Number(quoteDetails.spotPriceUsd);
      const filledQty = Number(execution.quantity);
      if (
        slippageSource === "deribit_btc_units" &&
        Number.isFinite(spotForSlippage) && spotForSlippage > 0 &&
        Number.isFinite(filledQty) && filledQty > 0
      ) {
        realizedSlippageUsd = (fillPriceBtc - quotedAskBtc) * spotForSlippage * filledQty;
      } else if (
        slippageSource === "usd_unit_fallback" &&
        Number.isFinite(filledQty) && filledQty > 0
      ) {
        const quotedUnitUsd = Number(quoteDetails.quotedUnitPriceUsd);
        realizedSlippageUsd = (Number(execution.executionPrice) - quotedUnitUsd) * filledQty;
      }
      try {
        // Per-trade observation; the function accumulates into the day's
        // rollup (sample_count += 1, weighted-average slippage / spread,
        // running fill rate from quotes/fills, p95 from a kept-sample array).
        // Replaces the prior overwrite-style upsertExecutionQualityDaily call
        // which was clobbering the row on every activation (PR #34).
        const spreadPctRaw = Number(quoteDetails.spreadPct);
        // Strike-floor gap diagnostics — surfaces how often the
        // option-selection algorithm picks strikes that create a
        // dead-zone between trigger and option strike. Fed by the
        // venue.ts quote response; null on legacy quote shapes.
        const gapUsdRaw = Number(quoteDetails.strikeGapToTriggerUsd);
        const gapPctRaw = Number(quoteDetails.strikeGapToTriggerPct);
        // Direction tagging for SHORT-vs-LONG empirical comparison
        // (added 2026-04-21 alongside the ITM aggressiveness fix in
        // PR #76 — needed to validate that SHORT recovery improves
        // post-fix relative to LONG R1 baseline).
        const ptype = String(body.protectionType || "").toLowerCase() === "short" ? "short" : "long";
        await incrementExecutionQualityDaily(pool, {
          dayIso: new Date().toISOString(),
          venue: execution.venue,
          hedgeMode: contextHedgeMode || deriveHedgeMode(lockedQuote.details),
          slippageBps: realizedSlippageBps,
          slippageUsd: realizedSlippageUsd,
          strikeGapUsd: Number.isFinite(gapUsdRaw) ? gapUsdRaw : undefined,
          strikeGapPct: Number.isFinite(gapPctRaw) ? gapPctRaw : undefined,
          protectionType: ptype as "long" | "short",
          latencyMs: Date.now() - quoteStartedAt,
          spreadPct: Number.isFinite(spreadPctRaw) ? spreadPctRaw : undefined,
          filled: true,
          protectionId: reservedProtection.id,
          quoteId: lockedQuote.quoteId,
          notes: {
            slippageSource,
            quotedAskBtc: Number.isFinite(quotedAskBtc) ? quotedAskBtc : null,
            fillPriceBtc: Number.isFinite(fillPriceBtc) ? fillPriceBtc : null,
            slippageUsd: realizedSlippageUsd ?? null
          }
        });
      } catch (eqErr: any) {
        console.warn(`[Activate] Execution quality increment failed: ${eqErr?.message}`);
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
        errMsg === "aggregate_active_notional_cap_exceeded" ||
        errMsg === "per_tier_daily_concentration_cap_exceeded" ||
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
            const failQuoteDetails = (lockedQuote?.details || {}) as Record<string, unknown>;
            const spreadPctRawFail = Number(failQuoteDetails.spreadPct);
            // No fill happened, so there's no slippage to record. We pass 0 here
            // and rely on filled:false so the rollup correctly counts the reject
            // (running fill-rate denominator advances; numerator does not).
            await incrementExecutionQualityDaily(pool, {
              dayIso: new Date().toISOString(),
              venue: pilotConfig.venueMode,
              hedgeMode: contextHedgeMode,
              slippageBps: 0,
              latencyMs: Date.now() - quoteStartedAt,
              spreadPct: Number.isFinite(spreadPctRawFail) ? spreadPctRawFail : undefined,
              filled: false,
              quoteId: lockedQuote?.quoteId || body.quoteId,
              notes: {
                rejection: executionFailureDetail || "execution_failed",
                slippageSource: "no_fill"
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
        // Brevity-pass copy. Style: ≤ 15 words, plain language, state then
        // action, no jargon (notional, venue, transport, RFQ). The widget's
        // friendlyError() carries the user-facing version; this fallback
        // is for clients that bypass the widget (curl, scripts).
        message:
          reason === "price_unavailable"
            ? "Quote temporarily unavailable. Tap Refresh Quote."
            : reason === "storage_unavailable"
              ? "Quote temporarily unavailable. Tap Refresh Quote."
              : reason === "daily_notional_cap_exceeded"
                ? "Daily limit reached. Resets at midnight UTC (8pm ET)."
                : reason === "protection_notional_cap_exceeded"
                  ? `Amount exceeds the pilot per-position max ($${fmtUsdWhole(
                      pilotConfig.maxProtectionNotionalUsdc
                    )}). Reduce it.`
                  : reason === "aggregate_active_notional_cap_exceeded"
                    ? `Pilot's open-protection limit ($${fmtUsdWhole(
                        pilotConfig.maxAggregateActiveNotionalUsdc
                      )}) is full. Close one or wait for it to expire.`
                  : reason === "per_tier_daily_concentration_cap_exceeded"
                    ? `This protection level is full for today. Try a different level or wait until tomorrow.`
                  : reason === "quote_already_consumed"
                    ? "Quote already used. Refresh protections list."
                    : reason === "quote_not_activatable"
                      ? "This quote is no longer usable. Tap Refresh Quote."
                      : reason === "venue_execute_timeout"
                        ? "Exchange timed out. Tap Refresh Quote."
                        : reason === "execution_failed"
                          ? "Exchange rejected the trade. Tap Refresh Quote."
                          : reason === "premium_cap_exceeded_post_fill"
                            ? "Hedge cost exceeded our safety limit. Protection not opened. No charge."
                          : reason === "ibkr_transport_not_live"
                            ? "Exchange connection isn't live. Try again shortly."
                          : reason === "quote_expired"
                            ? "Quote expired. Tap Refresh Quote."
                            : reason.startsWith("quote_mismatch")
                              ? "Terms changed after quoting. Tap Refresh Quote."
                              : "Couldn't open protection. Try again.",
        ...(reason === "daily_notional_cap_exceeded"
          ? {
              capUsdc: maxDailyProtection.toFixed(2),
              usedUsdc: (error as any)?.usedUsdc || capUsedUsdc,
              projectedUsdc: (error as any)?.projectedUsdc || capProjectedUsdc
            }
          : {}),
        ...(reason === "aggregate_active_notional_cap_exceeded"
          ? {
              capUsdc: (error as any)?.capUsdc,
              currentActiveUsdc: (error as any)?.currentActiveUsdc,
              projectedAfterUsdc: (error as any)?.projectedAfterUsdc
            }
          : {}),
        ...(reason === "per_tier_daily_concentration_cap_exceeded"
          ? {
              tierSlPct: (error as any)?.tierSlPct,
              capPct: (error as any)?.capPct,
              tierCapUsdc: (error as any)?.tierCapUsdc,
              currentTierUsageUsdc: (error as any)?.currentTierUsageUsdc,
              projectedAfterUsdc: (error as any)?.projectedAfterUsdc
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
    const query = req.query as { limit?: string; scope?: string };
    let userHash: { userHash: string; hashVersion: number };
    try {
      userHash = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    // Optional scope filter so the admin dashboard can request only currently
    // open protections (statuses where the platform is still on the hook)
    // instead of dumping the full lifecycle history including expired_otm /
    // expired_itm / cancelled rows. Default behavior unchanged ("all") so
    // existing callers see the same payload.
    //   - "open": pending_activation, active, triggered, reconcile_pending,
    //             awaiting_renew_decision, awaiting_expiry_price
    //   - "active": just status='active'
    //   - "all" (default): full history (excluding archived rows per PR #55)
    const scopeRaw = String(query.scope || "all").toLowerCase();
    const scope: "open" | "active" | "all" =
      scopeRaw === "open" || scopeRaw === "active" ? (scopeRaw as "open" | "active") : "all";
    const OPEN_STATUSES = new Set([
      "pending_activation",
      "active",
      "triggered",
      "reconcile_pending",
      "awaiting_renew_decision",
      "awaiting_expiry_price"
    ]);
    try {
      const all = await listProtectionsByUserHash(pool, userHash.userHash, {
        limit: Number(query.limit || 20)
      });
      const filtered =
        scope === "open"
          ? all.filter((p: any) => OPEN_STATUSES.has(String(p.status)))
          : scope === "active"
            ? all.filter((p: any) => p.status === "active")
            : all;
      return {
        status: "ok",
        scope,
        protections: filtered.map((item) =>
          sanitizeProtectionForTrader(item as unknown as Record<string, unknown>)
        )
      };
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "storage_unavailable",
        message: "Quote temporarily unavailable. Tap Refresh Quote.",
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
        renewedTo: protection.metadata?.renewedTo ? String(protection.metadata.renewedTo) : null,
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
        message: "Quote temporarily unavailable. Tap Refresh Quote.",
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
        message: "Quote temporarily unavailable. Tap Refresh Quote.",
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

  /**
   * Toggle auto-renew on/off for an active protection AFTER it has been opened.
   *
   * Per Pilot Agreement §3.3, auto-renewal is "available at Client's discretion" —
   * the activation-time checkbox already supports turning it ON; this endpoint
   * supports turning it ON or OFF at any point during the protection's life
   * without closing the underlying perp position.
   *
   * Semantics:
   *   - The current protection cycle ALWAYS runs to its natural expiry
   *     regardless of this toggle. This endpoint only affects whether the
   *     auto-renew scheduler creates a NEW protection at expiry.
   *   - Optimistic-lock guard: only `status = 'active'` rows are toggleable.
   *     A protection that has already triggered, expired, or been cancelled
   *     cannot be toggled (404 / 409 — see below).
   *   - Race window with the auto-renew scheduler (runs every 5 min): if the
   *     scheduler has already initiated a renewal at the moment the trader
   *     toggles OFF, that renewal may complete. The next cycle will respect
   *     the new setting. This is documented in the response message and the
   *     frontend toast.
   *   - Audit trail: every toggle appends an entry to metadata.autoRenewToggles
   *     with timestamp + new value, so admin/operators can reconstruct intent
   *     post-hoc.
   *
   * Request:
   *   POST /pilot/protections/:id/auto-renew
   *   body: { enabled: true | false }
   *
   * Responses:
   *   200 { status: "ok", protection, autoRenew: boolean, message: string }
   *   400 { status: "error", reason: "invalid_enabled_value" }
   *   404 { status: "error", reason: "not_found" }
   *   409 { status: "error", reason: "protection_not_active",
   *         currentStatus, message }
   *   200 (no-op) { status: "ok", protection, autoRenew, idempotentReplay: true,
   *                 message }
   */
  app.post("/pilot/protections/:id/auto-renew", async (req, reply) => {
    const params = req.params as { id: string };
    const body = (req.body || {}) as { enabled?: unknown };
    const enabled = typeof body.enabled === "boolean" ? body.enabled : null;
    if (enabled === null) {
      reply.code(400);
      return {
        status: "error",
        reason: "invalid_enabled_value",
        message: "Body must include { \"enabled\": true | false }."
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
    const protection = await getProtection(pool, params.id);
    if (!protection) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    if (!assertProtectionOwnership(protection, userHash)) {
      // Hide existence of other tenants' protections behind 404, not 403.
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    if (protection.status !== "active") {
      reply.code(409);
      return {
        status: "error",
        reason: "protection_not_active",
        currentStatus: protection.status,
        message:
          "Auto-renew can only be toggled on an active protection. " +
          `This protection is currently '${protection.status}'.`
      };
    }
    if (Boolean(protection.autoRenew) === enabled) {
      // Idempotent replay — already in requested state. Return 200 with the
      // existing protection so the frontend can settle without surprise.
      return {
        status: "ok",
        idempotentReplay: true,
        autoRenew: enabled,
        protection: sanitizeProtectionForTrader(protection as unknown as Record<string, unknown>),
        message: enabled
          ? "Auto-renew is already enabled for this protection."
          : "Auto-renew is already disabled for this protection."
      };
    }
    const auditEntry = {
      ts: new Date().toISOString(),
      enabled,
      previous: Boolean(protection.autoRenew)
    };
    const updated = await patchProtectionForStatus(pool, {
      id: params.id,
      expectedStatus: "active",
      patch: {
        auto_renew: enabled,
        // Append to an array of toggle events on metadata jsonb. Passing a
        // plain object follows the existing convention in triggerMonitor.ts
        // (pg driver serializes jsonb-bound objects automatically).
        metadata: {
          ...(protection.metadata || {}),
          autoRenewToggles: [
            ...((protection.metadata?.autoRenewToggles as Array<unknown> | undefined) || []),
            auditEntry
          ],
          lastAutoRenewToggleAt: auditEntry.ts,
          lastAutoRenewToggleValue: enabled
        }
      }
    });
    if (!updated) {
      // Lost the optimistic lock — protection status changed between our
      // read and our write (e.g. it just triggered). Surface as 409.
      reply.code(409);
      return {
        status: "error",
        reason: "protection_status_changed",
        message:
          "Protection status changed during the toggle attempt. " +
          "Refresh and try again — the protection may have triggered or expired."
      };
    }
    const message = enabled
      ? "Auto-renew enabled. A new protection will be created at expiry."
      : "Auto-renew disabled. The current protection will run to expiry; no new protection will be created. " +
        "If a renewal was already in flight (5-min scheduler window), one more cycle may complete.";
    return {
      status: "ok",
      autoRenew: enabled,
      protection: sanitizeProtectionForTrader(updated as unknown as Record<string, unknown>),
      message
    };
  });

  /**
   * R7 — Test-alert endpoint. Lets the operator verify their webhook
   * configuration (Telegram / Slack / Discord / generic) without waiting
   * for a real alert to fire. Sends a single info-level alert with a
   * unique code so dedup doesn't suppress repeated tests.
   *
   * POST /pilot/admin/test-alert
   *   body: { level?: "info"|"warning"|"critical", message?: string }
   * 200 { status: "ok", alert, dispatchResult }
   */
  app.post("/pilot/admin/test-alert", async (req, reply) => {
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const body = (req.body || {}) as { level?: string; message?: string };
    const lvl = body.level === "critical" || body.level === "warning" ? body.level : "info";
    const stamp = new Date().toISOString();
    const alert = {
      level: lvl as "info" | "warning" | "critical",
      code: `test_alert_${Date.now()}`, // unique code per call → never deduped
      message: body.message || `Test alert from /pilot/admin/test-alert at ${stamp}`,
      timestamp: stamp
    };
    monitor.recordEvent(alert);
    // Wait briefly so dispatch results are available in the response.
    await new Promise((r) => setTimeout(r, 250));
    return {
      status: "ok",
      alert,
      message: "Alert emitted. Check Telegram / Slack / Discord and /pilot/monitor/alerts to confirm receipt."
    };
  });

  /**
   * GET /pilot/admin/circuit-breaker
   * Returns current state + config of the max-loss circuit breaker.
   */
  app.get("/pilot/admin/circuit-breaker", async (req, reply) => {
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    return {
      status: "ok",
      state: getCircuitBreakerState(),
      config: getCircuitBreakerConfig(),
      active: isCircuitBreakerActive()
    };
  });

  /**
   * POST /pilot/admin/circuit-breaker/reset
   * Manually clears a tripped circuit breaker. Re-enables new
   * protection sales immediately. The breaker will continue to
   * monitor balance and may re-trip if the underlying drawdown
   * pattern recurs.
   */
  app.post("/pilot/admin/circuit-breaker/reset", async (req, reply) => {
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const wasTripped = resetCircuitBreaker(auth.actor);
    await insertAdminAction(pool, {
      action: "circuit_breaker_reset",
      actor: auth.actor,
      actorIp: auth.actorIp,
      details: { wasTripped }
    });
    if (wasTripped) {
      monitor.recordEvent({
        level: "info",
        code: "circuit_breaker_manual_reset",
        message: `Circuit breaker manually reset by ${auth.actor}.`
      });
    }
    return {
      status: "ok",
      wasTripped,
      message: wasTripped
        ? "Circuit breaker reset. Platform accepting new protection sales again."
        : "Circuit breaker was already in normal state. No action taken."
    };
  });

  app.post("/pilot/admin/reset", async (req, reply) => {
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    try {
      const result = await resetPilotData(pool);
      await insertAdminAction(pool, {
        action: "pilot_data_reset",
        actor: auth.actor,
        actorIp: auth.actorIp,
        details: result
      });
      console.log(`[Admin] Pilot data reset by ${auth.actor} from ${auth.actorIp}`);
      return { status: "ok", ...result };
    } catch (error: any) {
      reply.code(500);
      return { status: "error", reason: String(error?.message || "reset_failed") };
    }
  });

  // Surgical reset for paper-test protections. Use this — not the heavy
  // /pilot/admin/reset — when you need to clear cap headroom mid-pilot
  // without destroying audit data (execution-quality samples, ledger,
  // hedge decisions, admin actions all stay intact).
  //
  // Request body:
  //   {
  //     "protectionIds": ["uuid", "uuid", ...],   // required
  //     "reason": "string"                         // optional, default
  //                                                // "admin_test_reset"
  //   }
  //
  // Effect per protection ID:
  //   1. status set to 'cancelled'
  //   2. metadata.archivedAt / archivedReason / archivedBy stamped for audit
  //   3. notional released from pilot_daily_usage for the day the
  //      protection was created
  //   4. aggregate-active and per-tier-daily caps automatically see the
  //      row drop out of their queries (both filter on
  //      metadata.archivedAt = '')
  //
  // Constraints:
  //   - admin token required
  //   - only protections owned by the same tenant userHash are touched
  //   - rows already archived are no-ops
  //   - rows in non-open statuses (expired_*, cancelled) are still
  //     archived for cleanliness but daily release is a no-op for them
  app.post("/pilot/admin/test-reset-protections", async (req, reply) => {
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const body = (req.body || {}) as { protectionIds?: unknown; reason?: string };
    const ids = Array.isArray(body.protectionIds)
      ? body.protectionIds
          .map((v) => (typeof v === "string" ? v.trim() : ""))
          .filter((v) => v.length > 0)
      : [];
    if (ids.length === 0) {
      reply.code(400);
      return {
        status: "error",
        reason: "missing_protection_ids",
        message: "Provide protectionIds: string[] in the request body."
      };
    }
    if (ids.length > 200) {
      reply.code(400);
      return {
        status: "error",
        reason: "too_many_ids",
        message: "Limit 200 IDs per request."
      };
    }
    try {
      const tenant = resolveTenantScopeHash();
      const result = await archiveTestProtectionsByIds(pool, {
        userHash: tenant.userHash,
        protectionIds: ids,
        actor: auth.actor,
        reason: body.reason ? String(body.reason) : undefined
      });
      await insertAdminAction(pool, {
        action: "pilot_test_reset_protections",
        actor: auth.actor,
        actorIp: auth.actorIp,
        details: {
          requestedIds: ids,
          archivedCount: result.archivedCount,
          archivedIds: result.archivedIds,
          releasedDailyByDay: result.releasedDailyByDay,
          reason: body.reason || "admin_test_reset"
        }
      });
      console.log(
        `[Admin] Test-reset ${result.archivedCount}/${ids.length} protections by ${auth.actor} from ${auth.actorIp}`
      );
      return {
        status: "ok",
        archivedCount: result.archivedCount,
        archivedIds: result.archivedIds,
        skippedIds: ids.filter((id) => !result.archivedIds.includes(id)),
        releasedDailyByDay: result.releasedDailyByDay,
        message:
          result.archivedCount === ids.length
            ? `Archived ${result.archivedCount} protection(s). Caps released.`
            : `Archived ${result.archivedCount}/${ids.length}. Skipped IDs were already archived or not found.`
      };
    } catch (error: any) {
      reply.code(500);
      return {
        status: "error",
        reason: String(error?.message || "test_reset_failed")
      };
    }
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

  /**
   * GET /pilot/admin/protections/:id/lifecycle
   *
   * Comprehensive read-only diagnostic for a single protection's entire
   * lifecycle. Combines:
   *   - protection record (status, sl, notional, entry, floor, strike, expiry, metadata)
   *   - ledger entries (premium_due, premium_settled, payout_due, payout_settled)
   *   - venue executions (open + close fills, prices, fees, raw response details)
   *   - price snapshots (entry, mid-cycle, expiry/trigger snapshots)
   *
   * Used by scripts/pilot-trade-investigate.sh to produce a readable
   * timeline for a specific protection. Especially useful for
   * triggered + TP-sold trades where we want to understand why TP
   * recovered what it recovered.
   *
   * Sample use: investigating the c84dbbe9 trade (first SHORT 2%
   * trigger in production; recovery 8% vs R1 baseline 68%).
   */
  app.get("/pilot/admin/protections/:id/lifecycle", async (req, reply) => {
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
    const [ledger, executionsResult, snapshotsResult] = await Promise.all([
      listLedgerForProtection(pool, params.id),
      pool.query(
        `SELECT id, venue, status, quote_id, instrument_id, side, quantity, execution_price,
                premium, executed_at, external_order_id, external_execution_id, details, created_at
           FROM pilot_venue_executions
          WHERE protection_id = $1
          ORDER BY created_at ASC`,
        [params.id]
      ),
      pool.query(
        `SELECT id, snapshot_type, price, market_id, price_source, price_source_detail,
                price_timestamp, created_at
           FROM pilot_price_snapshots
          WHERE protection_id = $1
          ORDER BY created_at ASC`,
        [params.id]
      )
    ]);
    return {
      status: "ok",
      protection,
      ledger,
      executions: executionsResult.rows.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        venue: String(row.venue),
        status: String(row.status),
        quoteId: String(row.quote_id || ""),
        instrumentId: String(row.instrument_id || ""),
        side: String(row.side || ""),
        quantity: String(row.quantity || ""),
        executionPrice: String(row.execution_price || ""),
        premium: String(row.premium || ""),
        executedAt: row.executed_at ? new Date(String(row.executed_at)).toISOString() : null,
        externalOrderId: String(row.external_order_id || ""),
        externalExecutionId: String(row.external_execution_id || ""),
        details: row.details || {},
        createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null
      })),
      priceSnapshots: snapshotsResult.rows.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        snapshotType: String(row.snapshot_type),
        price: String(row.price || ""),
        marketId: String(row.market_id || ""),
        priceSource: String(row.price_source || ""),
        priceSourceDetail: String(row.price_source_detail || ""),
        priceTimestamp: row.price_timestamp ? new Date(String(row.price_timestamp)).toISOString() : null,
        createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null
      }))
    };
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
    // R7 — wire trigger-monitor alerts to the PilotMonitor → webhook
    // dispatcher pipeline. trigger_fired (info), trigger_monitor_price_errors
    // (critical), trigger_monitor_cycle_error (critical).
    registerPilotTriggerMonitor(pool, (alert) => monitor.recordEvent(alert));
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

  const hedgeMgmtIntervalMs = Number(process.env.PILOT_HEDGE_MGMT_INTERVAL_MS || "60000");
  // Use mainnet for spot index AND DVOL — both feed the hedge-management
  // decision tree (DVOL via resolveAdaptiveParams + BS recovery sigma; spot
  // via computeOptionValue). Testnet returns synthetic data on both. Falls
  // back to deps.deribit if no separate mainnet connector was wired.
  const dataConnector = deps.deribitLive ?? deps.deribit;
  const hedgeMgmtInterval = setInterval(async () => {
    try {
      // R3.A — wrap getIndexPrice in explicit error handling. Without this,
      // a Deribit outage causes the cycle to silently return with no log
      // output, making the hedge manager appear idle in Render logs while
      // triggered positions go unsold. With the wrap, every failed cycle
      // emits a [HedgeManager] no-spot warning that is greppable.
      // R7 — additionally fan out a hedge_no_spot alert to configured
      // webhooks so an operator is paged on persistent outages (dedup
      // window throttles a steady stream of 60s skips to one alert).
      const spot = await (async () => {
        try {
          const ticker = await dataConnector.getIndexPrice("btc_usd");
          return Number((ticker as any)?.result?.index_price ?? 0);
        } catch (priceErr: any) {
          console.warn(
            `[HedgeManager] getIndexPrice FAILED — cycle skipped: ${priceErr?.message || "unknown"}`
          );
          return 0;
        }
      })();
      if (!spot || spot <= 0) {
        console.warn(`[HedgeManager] no spot price available — cycle skipped`);
        monitor.recordEvent({
          level: "warning",
          code: "hedge_no_spot",
          message: "Hedge manager could not fetch BTC index price; cycle skipped. Check Deribit status."
        });
        return;
      }
      const dvolResult = await dataConnector.getDVOL("BTC");
      const iv = dvolResult.dvol ?? 50;
      const sellOptionDirect = async (p: { instrumentId: string; quantity: number }) => {
        try {
          const sellSpot = spot;
          const book = await deps.deribit.getOrderBook(p.instrumentId);
          const bidBtc = Number((book as any)?.result?.best_bid_price ?? 0);
          if (!bidBtc || bidBtc <= 0) {
            return { status: "failed", fillPrice: 0, totalProceeds: 0, orderId: null, details: { reason: "no_bid" } };
          }
          const sellQty = Math.max(0.1, Math.floor(p.quantity * 10) / 10);
          const order = await deps.deribit.placeOrder({ instrument: p.instrumentId, amount: sellQty, side: "sell", type: "market" }) as any;
          const orderData = order?.result?.order ?? order;
          const isFilled = String(orderData?.order_state || orderData?.status || "").match(/filled|closed|paper_filled/i);
          const fillPriceBtc = Number(order?.result?.trades?.[0]?.price ?? orderData?.average_price ?? bidBtc);
          const fillQty = Number(orderData?.filled_amount ?? orderData?.filledAmount ?? sellQty);
          console.log(`[HedgeManager] sellOption direct: instrument=${p.instrumentId} filled=${!!isFilled} priceBtc=${fillPriceBtc} qty=${fillQty}`);
          return {
            status: isFilled ? "sold" : "failed",
            fillPrice: fillPriceBtc * sellSpot,
            totalProceeds: fillPriceBtc * sellSpot * fillQty,
            orderId: String(orderData?.order_id ?? orderData?.id ?? null),
            details: { raw: order, bidBtc, spot: sellSpot }
          };
        } catch (err: any) {
          console.error(`[HedgeManager] sellOption direct FAILED: ${err?.message}`);
          return { status: "failed", fillPrice: 0, totalProceeds: 0, orderId: null, details: { reason: err?.message } };
        }
      };
      await runHedgeManagementCycle({
        pool,
        venue,
        sellOption: sellOptionDirect,
        currentSpot: spot,
        currentIV: iv
      });

      // PR B (Gap 2) — sample Deribit equity each cycle and feed the
      // circuit breaker. The breaker owns its own trip detection,
      // baseline tracking, and cooldown logic; we just supply data.
      // Wrapped to never fail the cycle if balance fetch errors.
      try {
        const acctSummary: any = await deps.deribit.getAccountSummary("BTC");
        const equityBtc = Number(acctSummary?.result?.equity ?? 0);
        if (Number.isFinite(equityBtc) && equityBtc >= 0) {
          const post = recordBalanceSample(equityBtc);
          if (post.tripped) {
            // Surface the trip via the existing alert dispatcher so an
            // operator gets paged on the same channel as other warnings.
            monitor.recordEvent({
              level: "critical",
              code: "circuit_breaker_tripped",
              message:
                `Deribit equity drawdown ${(post.lossPct * 100).toFixed(1)}% exceeded threshold ` +
                `(baseline ${post.baselineBtc.toFixed(6)} BTC, current ${post.currentBtc.toFixed(6)} BTC). ` +
                `New protection sales blocked until cooldown expires at ${post.cooldownExpiresAt} or admin reset.`
            });
          }
        }
      } catch (balanceErr: any) {
        console.warn(
          `[CircuitBreaker] Could not sample Deribit balance this cycle: ${balanceErr?.message || "unknown"}`
        );
      }
    } catch (err: any) {
      console.error(`[HedgeManager] Scheduler error: ${err?.message}`);
    }
  }, hedgeMgmtIntervalMs);
  hedgeMgmtInterval.unref?.();
  console.log(`[HedgeManager] Scheduler started: interval=${hedgeMgmtIntervalMs}ms`);

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

