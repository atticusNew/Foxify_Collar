import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import Decimal from "decimal.js";
import { randomUUID } from "node:crypto";
import { DeribitConnector } from "@foxify/connectors";
import { buildUserHash } from "./hash";
import { pilotConfig, resolvePilotWindow } from "./config";
import {
  createPilotTermsAcceptanceIfMissing,
  ensurePilotSchema,
  getDailyProtectedNotionalForUser,
  getEssentialProofPayload,
  getPilotAdminMetrics,
  getPilotTermsAcceptance,
  getPilotPool,
  getProtection,
  getVenueQuoteByQuoteIdForUpdate,
  insertAdminAction,
  consumeVenueQuote,
  insertLedgerEntry,
  insertPriceSnapshot,
  insertProtection,
  insertVenueExecution,
  insertVenueQuote,
  reserveDailyActivationCapacity,
  releaseDailyActivationCapacity,
  listLedgerForProtection,
  listProtections,
  listProtectionsByUserHash,
  patchProtection
} from "./db";
import { resolvePriceSnapshot, type PriceSnapshotOutput } from "./price";
import { createPilotVenueAdapter, mapVenueFailureReason } from "./venue";
import {
  computeTriggerPrice,
  computePayoutDue,
  normalizeProtectionType,
  normalizeTierName,
  resolveDrawdownFloorPct,
  resolveExpiryDays,
  resolveRenewWindowMinutes
} from "./floor";

const deriveHedgeMode = (quoteDetails?: Record<string, unknown>): "options_native" | "futures_synthetic" => {
  const raw = String(quoteDetails?.hedgeMode || "");
  return raw === "futures_synthetic" ? "futures_synthetic" : "options_native";
};

const getRequestIp = (req: FastifyRequest): string => {
  // Use Fastify-resolved client IP. Raw x-forwarded-for is not trusted by default.
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

const resolvePremiumPricing = (params: {
  tierName: string;
  protectedNotional: Decimal;
  hedgePremium: Decimal;
}): {
  hedgePremiumUsd: Decimal;
  markupPct: Decimal;
  markupUsd: Decimal;
  premiumFloorUsdAbsolute: Decimal;
  premiumFloorUsdFromBps: Decimal;
  premiumFloorBps: Decimal;
  premiumFloorUsd: Decimal;
  clientPremiumUsd: Decimal;
  method: "markup" | "floor_usd" | "floor_bps";
} => {
  const markupPctRaw = Number(
    pilotConfig.premiumMarkupPctByTier[params.tierName] ?? pilotConfig.premiumMarkupPct
  );
  const markupPct = Number.isFinite(markupPctRaw) && markupPctRaw > 0 ? new Decimal(markupPctRaw) : new Decimal(0);
  const hedgePremiumUsd = params.hedgePremium;
  const markupUsd = hedgePremiumUsd.mul(markupPct);
  const markedUpPremium = hedgePremiumUsd.plus(markupUsd);
  const premiumFloorBps = resolveTierPremiumFloorBps(params.tierName);
  const premiumFloorUsdFromBps = params.protectedNotional.mul(premiumFloorBps).div(10000);
  const premiumFloorUsdAbsolute = resolveTierPremiumFloorUsd(params.tierName);
  const premiumFloorUsd = Decimal.max(premiumFloorUsdAbsolute, premiumFloorUsdFromBps);
  const clientPremiumUsd = Decimal.max(markedUpPremium, premiumFloorUsd);
  const method: "markup" | "floor_usd" | "floor_bps" = clientPremiumUsd.eq(markedUpPremium)
    ? "markup"
    : premiumFloorUsdAbsolute.greaterThanOrEqualTo(premiumFloorUsdFromBps)
      ? "floor_usd"
      : "floor_bps";
  return {
    hedgePremiumUsd,
    markupPct,
    markupUsd,
    premiumFloorUsdAbsolute,
    premiumFloorUsdFromBps,
    premiumFloorBps,
    premiumFloorUsd,
    clientPremiumUsd,
    method
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
    "deribitQuotePolicy",
    "strikeSelectionMode",
    "hedgeMode"
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
  const pool = getPilotPool(pilotConfig.postgresUrl);
  await ensurePilotSchema(pool);
  const venue = createPilotVenueAdapter({
    mode: pilotConfig.venueMode,
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
      requireLiveTransport: pilotConfig.ibkrRequireLiveTransport,
      maxTenorDriftDays: pilotConfig.ibkrMaxTenorDriftDays,
      preferTenorAtOrAbove: pilotConfig.ibkrPreferTenorAtOrAbove
    },
    ibkrQuoteBudgetMs: pilotConfig.venueQuoteTimeoutMs,
    deribit: deps.deribit
  });

  const resolveAndPersistExpiry = async (protectionId: string): Promise<void> => {
    const protection = await getProtection(pool, protectionId);
    if (!protection) return;
    if (!["active", "awaiting_expiry_price"].includes(protection.status)) return;
    const expiryAt = new Date(protection.expiryAt);
    if (Date.now() < expiryAt.getTime()) return;
    const requestId = pilotConfig.nextRequestId();
    try {
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
      await patchProtection(pool, protectionId, {
        status: nextStatus,
        expiry_price: snapshot.price.toFixed(10),
        expiry_price_source: snapshot.priceSource,
        expiry_price_timestamp: snapshot.priceTimestamp,
        floor_price: triggerPrice.toFixed(10),
        payout_due_amount: payoutDue.toFixed(10)
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
      const ageMs = Math.max(0, Date.now() - Date.parse(snapshot.priceTimestamp));
      const venue =
        snapshot.priceSource === "fallback_oracle"
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

  app.post("/pilot/protections/quote", async (req, reply) => {
    if (!enforcePilotWindow(reply)) return;
    const body = req.body as {
      protectedNotional?: number;
      foxifyExposureNotional?: number;
      entryPrice?: number;
      tenorDays?: number;
      instrumentId?: string;
      marketId?: string;
      clientOrderId?: string;
      tierName?: string;
      drawdownFloorPct?: number;
      protectionType?: "long" | "short";
    };
    const quoteStartedAt = Date.now();
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
    const quoteInstrumentId = body.instrumentId || `${marketId}-7D-${optionType}`;
    const triggerLabel = protectionType === "short" ? "ceiling_price" : "floor_price";
    const tierName = normalizeTierName(body.tierName);
    const drawdownFloorPct = resolveDrawdownFloorPct({
      tierName,
      drawdownFloorPct: body.drawdownFloorPct
    });
    const requestId = pilotConfig.nextRequestId();
    let priceMs = 0;
    let venueMs = 0;
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
      const requestedTenorDays = resolveExpiryDays({
        tierName,
        requestedDays: Number((body as { tenorDays?: number }).tenorDays),
        minDays: pilotConfig.pilotTenorMinDays,
        maxDays: pilotConfig.pilotTenorMaxDays,
        defaultDays: pilotConfig.pilotTenorDefaultDays
      });
      const venueStartedAt = Date.now();
      const quote = await withTimeout(
        venue.quote({
          marketId,
          protectedNotional: protectedNotional.toNumber(),
          quantity,
          side: "buy",
          instrumentId: quoteInstrumentId,
          protectionType,
          triggerPrice: triggerPrice.toNumber(),
          requestedTenorDays,
          tenorMinDays: pilotConfig.pilotTenorMinDays,
          tenorMaxDays: pilotConfig.pilotTenorMaxDays,
          hedgePolicy: pilotConfig.pilotHedgePolicy,
          clientOrderId: body.clientOrderId
        }),
        pilotConfig.venueQuoteTimeoutMs,
        "venue_quote"
      );
      venueMs = Date.now() - venueStartedAt;
      const premiumPricing = resolvePremiumPricing({
        tierName,
        protectedNotional,
        hedgePremium: new Decimal(quote.premium)
      });
      const pricingBreakdown = {
        hedgePremiumUsd: premiumPricing.hedgePremiumUsd.toFixed(10),
        markupPct: premiumPricing.markupPct.toFixed(6),
        markupUsd: premiumPricing.markupUsd.toFixed(10),
        premiumFloorUsdAbsolute: premiumPricing.premiumFloorUsdAbsolute.toFixed(10),
        premiumFloorUsdFromBps: premiumPricing.premiumFloorUsdFromBps.toFixed(10),
        premiumFloorBps: premiumPricing.premiumFloorBps.toFixed(2),
        premiumFloorUsd: premiumPricing.premiumFloorUsd.toFixed(10),
        clientPremiumUsd: premiumPricing.clientPremiumUsd.toFixed(10),
        method: premiumPricing.method
      };
      await insertVenueQuote(pool, {
        ...quote,
        details: {
          ...(quote.details || {}),
          pricingBreakdown,
          lockContext: {
            requestedInstrumentId: quoteInstrumentId,
            quoteInstrumentId: quote.instrumentId,
            marketId,
            tierName,
            drawdownFloorPct: drawdownFloorPct.toFixed(6),
            protectedNotional: protectedNotional.toFixed(10),
            foxifyExposureNotional: exposureNotional.toFixed(10),
            entryPrice: entryAnchorPrice.toFixed(10),
            entryAnchorPrice: entryAnchorPrice.toFixed(10),
            entryPriceSource: "reference_snapshot_quote",
            entryPriceTimestamp: snapshot.priceTimestamp,
            entryInputPrice: entryInputPrice ? entryInputPrice.toFixed(10) : null,
            protectionType,
            optionType,
            requestedTenorDays,
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
            hedgeMode: deriveHedgeMode(quote.details as Record<string, unknown> | undefined),
            ...pricingBreakdown
          }
        }
      });
      const clientQuote = sanitizeQuoteForClient({
        ...quote,
        premium: Number(premiumPricing.clientPremiumUsd.toFixed(4)),
      });
      return {
        status: "ok",
        protectionType,
        tierName,
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
            hedgeMode: deriveHedgeMode(quote.details as Record<string, unknown> | undefined)
          }
        }
      };
    } catch (error: any) {
      const message = String(error?.message || "quote_generation_failed");
      const isTransportNotLive = message.startsWith("ibkr_transport_not_live");
      const isTenorDriftExceeded = message.includes("tenor_drift_exceeded");
      const isTimeout = message.includes("timeout") || message.includes("AbortError");
      const isStorageFailure =
        message.includes("postgres") || message.includes("ECONN") || message.includes("pool") || message.includes("db");
      reply.code(isTimeout ? 504 : isStorageFailure || isTransportNotLive ? 503 : 502);
      return {
        status: "error",
        reason: isStorageFailure
          ? "storage_unavailable"
          : isTransportNotLive
            ? "ibkr_transport_not_live"
            : isTenorDriftExceeded
              ? "tenor_drift_exceeded"
            : "quote_generation_failed",
        message: isStorageFailure
          ? "Storage temporarily unavailable, please retry."
          : isTransportNotLive
            ? "IBKR live transport is not active. Verify bridge transport health and retry."
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
          }
        }
      };
    }
  });

  app.post("/pilot/protections/activate", async (req, reply) => {
    if (!enforcePilotWindow(reply)) return;
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
    const instrumentId = body.instrumentId || `${marketId}-7D-${optionType}`;
    const tierName = normalizeTierName(body.tierName);
    const drawdownFloorPct = resolveDrawdownFloorPct({
      tierName,
      drawdownFloorPct: body.drawdownFloorPct
    });
    const tenorDays = resolveExpiryDays({
      tierName,
      requestedDays: body.tenorDays,
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
    let premiumPricing:
      | ReturnType<typeof resolvePremiumPricing>
      | {
          hedgePremiumUsd: Decimal;
          markupPct: Decimal;
          markupUsd: Decimal;
          premiumFloorUsdAbsolute: Decimal;
          premiumFloorUsdFromBps: Decimal;
          premiumFloorBps: Decimal;
          premiumFloorUsd: Decimal;
          clientPremiumUsd: Decimal;
          method: "markup" | "floor_usd" | "floor_bps";
        }
      | null = null;
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
      requestedQuantity = contextEntryAnchor
        ? protectedNotional.div(contextEntryAnchor).toDecimalPlaces(8).toNumber()
        : 0;
      const quantityDeltaPct =
        requestedQuantity > 0
          ? new Decimal(lockedQuote.quantity).minus(requestedQuantity).abs().div(new Decimal(requestedQuantity))
          : new Decimal(0);
      if (quantityDeltaPct.gt(new Decimal(pilotConfig.fullCoverageTolerancePct))) {
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
      const contextFloorUsd = parsePositiveDecimal(lockContext.premiumFloorUsd);
      const contextFloorUsdAbsolute = parsePositiveDecimal(lockContext.premiumFloorUsdAbsolute);
      const contextFloorUsdFromBps = parsePositiveDecimal(lockContext.premiumFloorUsdFromBps);
      const contextFloorBps = parsePositiveDecimal(lockContext.premiumFloorBps);
      const contextClientPremium = parsePositiveDecimal(lockContext.clientPremiumUsd);
      const fallbackPremiumPricing = resolvePremiumPricing({
        tierName,
        protectedNotional,
        hedgePremium: contextHedgePremium
      });
      premiumPricing = {
        hedgePremiumUsd: contextHedgePremium,
        markupPct: contextMarkupPct || fallbackPremiumPricing.markupPct,
        markupUsd: contextMarkupUsd || fallbackPremiumPricing.markupUsd,
        premiumFloorUsdAbsolute: contextFloorUsdAbsolute || fallbackPremiumPricing.premiumFloorUsdAbsolute,
        premiumFloorUsdFromBps: contextFloorUsdFromBps || fallbackPremiumPricing.premiumFloorUsdFromBps,
        premiumFloorBps: contextFloorBps || fallbackPremiumPricing.premiumFloorBps,
        premiumFloorUsd: contextFloorUsd || fallbackPremiumPricing.premiumFloorUsd,
        clientPremiumUsd: contextClientPremium || fallbackPremiumPricing.clientPremiumUsd,
        method: (() => {
          const rawMethod = String(lockContext.method || fallbackPremiumPricing.method);
          if (rawMethod === "floor_usd") return "floor_usd";
          if (rawMethod === "floor_bps") return "floor_bps";
          return "markup";
        })()
      };
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
      const coverageRatio =
        requestedQuantity > 0
          ? new Decimal(execution.quantity).div(new Decimal(requestedQuantity))
          : new Decimal(0);
      const threshold = new Decimal(1).minus(new Decimal(pilotConfig.fullCoverageTolerancePct));
      if (
        (pilotConfig.requireFullCoverage || pilotConfig.requireFullExecutionFill) &&
        coverageRatio.lt(threshold)
      ) {
        throw new Error("full_coverage_not_met");
      }
      if (!reservedProtection || !quoteEntryAnchorPrice || !triggerPrice || !premiumPricing) {
        throw new Error("activation_failed");
      }
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
      await insertVenueExecution(pool, reservedProtection.id, execution);
      await insertLedgerEntry(pool, {
        protectionId: reservedProtection.id,
        entryType: "premium_due",
        amount: premiumPricing.clientPremiumUsd.toFixed(10),
        reference: execution.externalOrderId
      });
      const updated = await patchProtection(pool, reservedProtection.id, {
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
          hedgeMode: contextHedgeMode,
          coverageRatio: coverageRatio.toFixed(6),
          hedgePremiumUsd: premiumPricing.hedgePremiumUsd.toFixed(10),
          markupPct: premiumPricing.markupPct.toFixed(6),
          markupUsd: premiumPricing.markupUsd.toFixed(10),
          premiumFloorUsdAbsolute: premiumPricing.premiumFloorUsdAbsolute.toFixed(10),
          premiumFloorUsdFromBps: premiumPricing.premiumFloorUsdFromBps.toFixed(10),
          premiumFloorBps: premiumPricing.premiumFloorBps.toFixed(2),
          premiumFloorUsd: premiumPricing.premiumFloorUsd.toFixed(10),
          clientPremiumUsd: premiumPricing.clientPremiumUsd.toFixed(10),
          premiumMethod: premiumPricing.method,
          entryAnchorPrice: quoteEntryAnchorPrice.toFixed(10),
          entryAnchorSource: quoteEntryPriceSource,
          entryAnchorTimestamp: quoteEntryPriceTimestamp || snapshot.priceTimestamp,
          entryInputPrice: entryInputPrice?.toFixed(10) || quoteEntryInputPrice,
          entrySnapshotPrice: snapshot.price.toFixed(10),
          entrySnapshotSource: snapshot.priceSource,
          entrySnapshotTimestamp: snapshot.priceTimestamp
        }
      });
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
        quote: activatedQuote
      };
    } catch (error: any) {
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
      reply.code(503);
      return {
        status: "error",
        reason: "price_unavailable",
        message: "Price temporarily unavailable, please retry.",
        detail: String(error?.message || "monitor_price_unavailable")
      };
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
    return {
      status: "ok",
      monitor: {
        protectionId: protection.id,
        status: protection.status,
        protectionType,
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
      }
    };
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
    const query = req.query as { format?: string; limit?: string };
    const protections = await listProtections(pool, { limit: Number(query.limit || 200) });
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
    return { status: "ok", rows };
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
    const metrics = await getPilotAdminMetrics(pool, {
      startingReserveUsdc: pilotConfig.startingReserveUsdc
    });
    return { status: "ok", metrics };
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
};

