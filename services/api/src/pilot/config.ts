import { randomUUID } from "node:crypto";

export type PilotVenueMode =
  | "falconx"
  | "deribit_test"
  | "mock_falconx"
  | "ibkr_cme_live"
  | "ibkr_cme_paper";
export type PilotWindowStatus = "open" | "not_started" | "closed" | "config_invalid";
export type DeribitQuotePolicy = "ask_only" | "ask_or_mark_fallback";
export type DeribitStrikeSelectionMode = "legacy" | "trigger_aligned";
export type PilotHedgePolicy = "options_primary_futures_fallback";

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
  const normalized = (raw || "deribit_test").trim();
  if (
    normalized === "falconx" ||
    normalized === "deribit_test" ||
    normalized === "mock_falconx" ||
    normalized === "ibkr_cme_live" ||
    normalized === "ibkr_cme_paper"
  ) {
    return normalized;
  }
  throw new Error(`invalid_pilot_venue_mode:${normalized || "empty"}`);
};

export const parsePilotHedgePolicy = (raw: string | undefined): PilotHedgePolicy => {
  const normalized = String(raw || "options_primary_futures_fallback").trim();
  if (normalized === "options_primary_futures_fallback") {
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

export const parseBooleanEnv = (raw: string | undefined, fallback: boolean): boolean => {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
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

export const pilotConfig = {
  enabled: process.env.PILOT_API_ENABLED === "true",
  venueMode: parsePilotVenueMode(process.env.PILOT_VENUE_MODE),
  deribitQuotePolicy: parseDeribitQuotePolicy(process.env.PILOT_DERIBIT_QUOTE_POLICY),
  deribitStrikeSelectionMode: parseDeribitStrikeSelectionMode(process.env.PILOT_STRIKE_SELECTION_MODE),
  deribitMaxTenorDriftDays: parseDeribitMaxTenorDriftDays(process.env.PILOT_DERIBIT_MAX_TENOR_DRIFT_DAYS),
  pilotHedgePolicy: parsePilotHedgePolicy(process.env.PILOT_HEDGE_POLICY),
  ...(() => {
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
  maxProtectionNotionalUsdc: Number(process.env.PILOT_MAX_PROTECTION_NOTIONAL_USDC || "50000"),
  maxDailyProtectedNotionalUsdc: Number(process.env.PILOT_MAX_DAILY_PROTECTED_NOTIONAL_USDC || "50000"),
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
  startingReserveUsdc: Number(process.env.PILOT_STARTING_RESERVE_USDC || "25000"),
  pricePrimaryTimeoutMs: Number(process.env.PRICE_TIMEOUT_PRIMARY_MS || "1400"),
  priceFallbackTimeoutMs: Number(process.env.PRICE_TIMEOUT_FALLBACK_MS || "1400"),
  priceFreshnessMaxMs: Number(process.env.PRICE_FRESHNESS_MAX_MS || "5000"),
  priceRequestRetryAttempts: Number(process.env.PRICE_REQUEST_RETRY_ATTEMPTS || "3"),
  priceRequestRetryDelayMs: Number(process.env.PRICE_REQUEST_RETRY_DELAY_MS || "180"),
  venueQuoteTimeoutMs: Number(process.env.PILOT_VENUE_QUOTE_TIMEOUT_MS || "10000"),
  quoteTtlMs: Number(process.env.PILOT_QUOTE_TTL_MS || "30000"),
  venueExecuteTimeoutMs: Number(process.env.PILOT_VENUE_EXEC_TIMEOUT_MS || "8000"),
  venueMarkTimeoutMs: Number(process.env.PILOT_VENUE_MARK_TIMEOUT_MS || "3000"),
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
  nextRequestId: () => randomUUID()
};

export const isPilotAdminConfigured = (): boolean =>
  Boolean(pilotConfig.adminToken) && pilotConfig.adminIpAllowlist.entries.length > 0;

