import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { newDb } from "pg-mem";
import Decimal from "decimal.js";

const originalFetch = global.fetch;

const buildPriceFetch = (): typeof fetch =>
  (async () =>
    ({
      ok: true,
      text: async () =>
        JSON.stringify({
          product_id: "BTC-USD",
          price: 100000,
          timestamp: Date.now()
        })
    }) as any) as typeof fetch;

const buildDeribitExecutionFailureStub = (): any => {
  const instrument = "BTC-31MAR26-80000-P";
  return {
    getIndexPrice: async () => ({
      result: { index_price: 100000 }
    }),
    listInstruments: async () => ({
      result: [
        {
          instrument_name: instrument,
          option_type: "put",
          strike: 80000,
          expiration_timestamp: Date.now() + 7 * 86400000
        }
      ]
    }),
    getOrderBook: async () => ({
      result: { asks: [[0.01, 5]], bids: [[0.009, 5]], mark_price: 0.0095 }
    }),
    placeOrder: async () => ({
      status: "rejected",
      id: "paper-reject",
      fillPrice: 0,
      filledAmount: 0
    })
  };
};

const defaultQuotePayload = (protectedNotional = 1000) => ({
  protectedNotional,
  foxifyExposureNotional: protectedNotional,
  instrumentId: "BTC-USD-7D-P",
  marketId: "BTC-USD",
  tierName: "Pro (Bronze)",
  drawdownFloorPct: 0.2
});

const activationPayload = (quoteId: string, protectedNotional = 1000) => ({
  ...defaultQuotePayload(protectedNotional),
  quoteId,
  autoRenew: false,
  tenorDays: 7
});

const createPilotHarness = async (opts?: {
  venueMode?: "mock_falconx" | "deribit_test" | "falconx" | "ibkr_cme_paper" | "ibkr_cme_live";
  deribit?: any;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<{
  app: FastifyInstance;
  pool: { query: (sql: string, params?: unknown[]) => Promise<any>; end: () => Promise<void> };
  close: () => Promise<void>;
}> => {
  process.env.PILOT_API_ENABLED = "true";
  process.env.PILOT_ACTIVATION_ENABLED = "true";
  process.env.PILOT_HEDGE_POLICY = "options_primary_futures_fallback";
  process.env.PILOT_VENUE_MODE = opts?.venueMode || "mock_falconx";
  process.env.POSTGRES_URL = "postgres://unused";
  process.env.USER_HASH_SECRET = "test_hash_secret";
  process.env.PILOT_ADMIN_TOKEN = "admin-local";
  process.env.PILOT_ADMIN_IP_ALLOWLIST = "127.0.0.1";
  delete process.env.PILOT_ADMIN_TRUSTED_IP_HEADER;
  process.env.PILOT_PROOF_TOKEN = "proof-local";
  process.env.PRICE_REFERENCE_MARKET_ID = "BTC-USD";
  process.env.PRICE_REFERENCE_URL = "https://example.com/ticker";
  process.env.PRICE_SINGLE_SOURCE = "true";
  process.env.PILOT_START_AT = "";
  process.env.PILOT_DURATION_DAYS = "30";
  process.env.PILOT_ENFORCE_WINDOW = "true";
  process.env.PILOT_QUOTE_TTL_MS = "120000";
  process.env.PILOT_TRIGGER_MONITOR_ENABLED = "false";
  process.env.PILOT_TRIGGER_MONITOR_INTERVAL_MS = "5000";
  process.env.PILOT_TRIGGER_MONITOR_BATCH_SIZE = "50";
  process.env.PILOT_TENOR_MIN_DAYS = "1";
  process.env.PILOT_TENOR_MAX_DAYS = "7";
  process.env.PILOT_TENOR_DEFAULT_DAYS = "7";
  process.env.PILOT_DYNAMIC_TENOR_ENABLED = "false";
  process.env.PILOT_TENOR_ENFORCE = "false";
  process.env.PILOT_TENOR_POLICY_ENFORCE = "false";
  process.env.PILOT_TENOR_AUTO_ROUTE = "false";
  process.env.PILOT_TENOR_CANDIDATES = "1,2,4,7,10,12,14";
  process.env.PILOT_TENOR_MIN_SAMPLES = "5";
  process.env.PILOT_TENOR_MIN_OK_RATE = "0.8";
  process.env.PILOT_TENOR_MIN_OPTIONS_NATIVE_RATE = "0.8";
  process.env.PILOT_TENOR_MAX_MEDIAN_PREMIUM_RATIO = "0.02";
  process.env.PILOT_TENOR_MAX_MEDIAN_DRIFT_DAYS = "3";
  process.env.PILOT_TENOR_MAX_NEGATIVE_MATCH_RATE = "0";
  process.env.PILOT_TENOR_DEFAULT_FALLBACK = "14";
  process.env.PILOT_TENOR_POLICY_LOOKBACK_MINUTES = "60";
  process.env.PILOT_INTERNAL_TOKEN = "internal-local";
  process.env.IBKR_REQUIRE_OPTIONS_NATIVE = "false";
  if (opts?.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  global.fetch = opts?.fetchImpl || buildPriceFetch();

  const configModule = await import("../src/pilot/config");
  configModule.pilotConfig.enabled = true;
  configModule.pilotConfig.activationEnabled = process.env.PILOT_ACTIVATION_ENABLED === "true";
  configModule.pilotConfig.pilotHedgePolicy = configModule.parsePilotHedgePolicy(process.env.PILOT_HEDGE_POLICY);
  configModule.pilotConfig.venueMode = (opts?.venueMode || "mock_falconx") as any;
  configModule.pilotConfig.tenantScopeId = process.env.PILOT_TENANT_SCOPE_ID || "foxify-pilot";
  configModule.pilotConfig.adminToken = process.env.PILOT_ADMIN_TOKEN || "";
  configModule.pilotConfig.adminIpAllowlist = {
    raw: process.env.PILOT_ADMIN_IP_ALLOWLIST || "",
    entries: String(process.env.PILOT_ADMIN_IP_ALLOWLIST || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  };
  configModule.pilotConfig.proofToken = process.env.PILOT_PROOF_TOKEN || "";
  configModule.pilotConfig.internalToken = process.env.PILOT_INTERNAL_TOKEN || "";
  configModule.pilotConfig.hashSecret = process.env.USER_HASH_SECRET || "";
  configModule.pilotConfig.dynamicTenorEnabled = process.env.PILOT_DYNAMIC_TENOR_ENABLED === "true";
  configModule.pilotConfig.tenorPolicyEnforce =
    (process.env.PILOT_TENOR_ENFORCE ?? process.env.PILOT_TENOR_POLICY_ENFORCE) === "true";
  configModule.pilotConfig.tenorPolicyAutoRoute = process.env.PILOT_TENOR_AUTO_ROUTE === "true";
  configModule.pilotConfig.pilotTenorMinDays = Number(process.env.PILOT_TENOR_MIN_DAYS || "1");
  configModule.pilotConfig.pilotTenorMaxDays = Number(process.env.PILOT_TENOR_MAX_DAYS || "7");
  configModule.pilotConfig.pilotTenorDefaultDays = Number(process.env.PILOT_TENOR_DEFAULT_DAYS || "7");
  configModule.pilotConfig.tenorPolicyCandidateDays = String(process.env.PILOT_TENOR_CANDIDATES || "1,2,4,7,10,12,14")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((n) => Number.isFinite(n) && n > 0) as number[];
  configModule.pilotConfig.tenorPolicyMinSamples = Number(process.env.PILOT_TENOR_MIN_SAMPLES || "5");
  configModule.pilotConfig.tenorPolicyMinOkRate = Number(process.env.PILOT_TENOR_MIN_OK_RATE || "0.8");
  configModule.pilotConfig.tenorPolicyMinOptionsNativeRate = Number(
    process.env.PILOT_TENOR_MIN_OPTIONS_NATIVE_RATE || "0.8"
  );
  configModule.pilotConfig.tenorPolicyMaxMedianPremiumRatio = Number(
    process.env.PILOT_TENOR_MAX_MEDIAN_PREMIUM_RATIO || "0.02"
  );
  configModule.pilotConfig.tenorPolicyMaxMedianDriftDays = Number(
    process.env.PILOT_TENOR_MAX_MEDIAN_DRIFT_DAYS || "3"
  );
  configModule.pilotConfig.tenorPolicyMaxNegativeMatchedRate = Number(
    process.env.PILOT_TENOR_MAX_NEGATIVE_MATCH_RATE || "0"
  );
  configModule.pilotConfig.tenorPolicyDefaultFallbackDays = Number(
    process.env.PILOT_TENOR_DEFAULT_FALLBACK || "14"
  );
  configModule.pilotConfig.tenorPolicyLookbackMinutes = Number(
    process.env.PILOT_TENOR_POLICY_LOOKBACK_MINUTES || "60"
  );
  configModule.pilotConfig.ibkrBridgeBaseUrl =
    process.env.IBKR_BRIDGE_BASE_URL || "http://127.0.0.1:18080";
  configModule.pilotConfig.ibkrBridgeTimeoutMs = Number(process.env.IBKR_BRIDGE_TIMEOUT_MS || "4000");
  configModule.pilotConfig.ibkrBridgeToken = process.env.IBKR_BRIDGE_TOKEN || "";
  configModule.pilotConfig.ibkrAccountId = process.env.IBKR_ACCOUNT_ID || "";
  configModule.pilotConfig.ibkrEnableExecution = process.env.IBKR_ENABLE_EXECUTION === "true";
  configModule.pilotConfig.ibkrOrderTimeoutMs = Number(process.env.IBKR_ORDER_TIMEOUT_MS || "8000");
  configModule.pilotConfig.ibkrMaxRepriceSteps = Number(process.env.IBKR_MAX_REPRICE_STEPS || "4");
  configModule.pilotConfig.ibkrRepriceStepTicks = Number(process.env.IBKR_REPRICE_STEP_TICKS || "2");
  configModule.pilotConfig.ibkrMaxSlippageBps = Number(process.env.IBKR_MAX_SLIPPAGE_BPS || "25");
  configModule.pilotConfig.ibkrRequireLiveTransport = process.env.IBKR_REQUIRE_LIVE_TRANSPORT === "true";
  configModule.pilotConfig.ibkrMaxTenorDriftDays = Number(process.env.IBKR_MAX_TENOR_DRIFT_DAYS || "7");
  configModule.pilotConfig.ibkrPreferTenorAtOrAbove = process.env.IBKR_PREFER_TENOR_AT_OR_ABOVE !== "false";
  configModule.pilotConfig.ibkrOrderTif =
    (process.env.IBKR_ORDER_TIF || "IOC").toUpperCase() === "DAY" ? "DAY" : "IOC";
  configModule.pilotConfig.ibkrPrimaryProductFamily =
    String(process.env.IBKR_PRIMARY_PRODUCT_FAMILY || "MBT").toUpperCase() === "BFF" ? "BFF" : "MBT";
  configModule.pilotConfig.ibkrBffFallbackEnabled = process.env.IBKR_BFF_FALLBACK_ENABLED === "true";
  configModule.pilotConfig.ibkrBffProductFamily =
    String(process.env.IBKR_BFF_PRODUCT_FAMILY || "BFF").toUpperCase() === "MBT" ? "MBT" : "BFF";
  configModule.pilotConfig.ibkrRequireOptionsNative =
    process.env.IBKR_REQUIRE_OPTIONS_NATIVE
      ? process.env.IBKR_REQUIRE_OPTIONS_NATIVE === "true"
      : true;
  configModule.pilotConfig.ibkrMaxFuturesSyntheticPremiumRatio = Number(
    process.env.IBKR_MAX_FUTURES_SYNTHETIC_PREMIUM_RATIO || "0.05"
  );
  configModule.pilotConfig.ibkrMaxOptionPremiumRatio = Number(process.env.IBKR_MAX_OPTION_PREMIUM_RATIO || "0.15");
  configModule.pilotConfig.ibkrOptionLiquiditySelectionEnabled =
    process.env.IBKR_OPTION_LIQUIDITY_SELECTION_ENABLED === "true";
  configModule.pilotConfig.ibkrQualifyCacheTtlMs = Number(process.env.IBKR_QUALIFY_CACHE_TTL_MS || "120000");
  configModule.pilotConfig.ibkrQualifyCacheMaxKeys = Number(process.env.IBKR_QUALIFY_CACHE_MAX_KEYS || "2000");
  configModule.pilotConfig.venueQuoteTimeoutMs = Number(process.env.PILOT_VENUE_QUOTE_TIMEOUT_MS || "10000");
  configModule.pilotConfig.quoteMinNotionalUsdc = Number(process.env.PILOT_QUOTE_MIN_NOTIONAL_USDC || "1000");
  configModule.pilotConfig.premiumPolicyMode =
    process.env.PILOT_PREMIUM_POLICY_MODE === "pass_through_markup"
      ? "pass_through_markup"
      : "hedge_only_markup";
  configModule.pilotConfig.premiumPricingMode =
    process.env.PILOT_PREMIUM_PRICING_MODE === "hybrid_otm_treasury"
      ? "hybrid_otm_treasury"
      : "actuarial_strict";
  configModule.pilotConfig.pilotSelectorMode =
    process.env.PILOT_SELECTOR_MODE === "hybrid_treasury" ? "hybrid_treasury" : "strict_profitability";
  configModule.pilotConfig.premiumPolicyVersion =
    String(process.env.PILOT_PREMIUM_POLICY_VERSION || "v2").trim() || "v2";
  configModule.pilotConfig.premiumMarkupPct = Number(process.env.PILOT_PREMIUM_MARKUP_PCT || "0.045");
  configModule.pilotConfig.premiumMarkupPctByTier = {
    "Pro (Bronze)": Number(process.env.PILOT_PREMIUM_MARKUP_PCT_BRONZE || "0.06"),
    "Pro (Silver)": Number(process.env.PILOT_PREMIUM_MARKUP_PCT_SILVER || "0.05"),
    "Pro (Gold)": Number(process.env.PILOT_PREMIUM_MARKUP_PCT_GOLD || "0.04"),
    "Pro (Platinum)": Number(process.env.PILOT_PREMIUM_MARKUP_PCT_PLATINUM || "0.03")
  };
  configModule.pilotConfig.premiumFloorUsdByTier = {
    "Pro (Bronze)": Number(process.env.PILOT_PREMIUM_FLOOR_USD_BRONZE || "20"),
    "Pro (Silver)": Number(process.env.PILOT_PREMIUM_FLOOR_USD_SILVER || "17"),
    "Pro (Gold)": Number(process.env.PILOT_PREMIUM_FLOOR_USD_GOLD || "14"),
    "Pro (Platinum)": Number(process.env.PILOT_PREMIUM_FLOOR_USD_PLATINUM || "12")
  };
  configModule.pilotConfig.premiumFloorBpsByTier = {
    "Pro (Bronze)": Number(process.env.PILOT_PREMIUM_FLOOR_BPS_BRONZE || "6"),
    "Pro (Silver)": Number(process.env.PILOT_PREMIUM_FLOOR_BPS_SILVER || "5"),
    "Pro (Gold)": Number(process.env.PILOT_PREMIUM_FLOOR_BPS_GOLD || "4"),
    "Pro (Platinum)": Number(process.env.PILOT_PREMIUM_FLOOR_BPS_PLATINUM || "4")
  };
  configModule.pilotConfig.premiumTriggerCreditFloorPctByTier = {
    "Pro (Bronze)": Number(process.env.PILOT_PREMIUM_TRIGGER_CREDIT_FLOOR_PCT_BRONZE || "0.03"),
    "Pro (Silver)": Number(process.env.PILOT_PREMIUM_TRIGGER_CREDIT_FLOOR_PCT_SILVER || "0.025"),
    "Pro (Gold)": Number(process.env.PILOT_PREMIUM_TRIGGER_CREDIT_FLOOR_PCT_GOLD || "0.02"),
    "Pro (Platinum)": Number(process.env.PILOT_PREMIUM_TRIGGER_CREDIT_FLOOR_PCT_PLATINUM || "0.018")
  };
  configModule.pilotConfig.premiumExpectedTriggerBreachProbByTier = {
    "Pro (Bronze)": Number(process.env.PILOT_PREMIUM_EXPECTED_TRIGGER_BREACH_PROB_BRONZE || "0.25"),
    "Pro (Silver)": Number(process.env.PILOT_PREMIUM_EXPECTED_TRIGGER_BREACH_PROB_SILVER || "0.2"),
    "Pro (Gold)": Number(process.env.PILOT_PREMIUM_EXPECTED_TRIGGER_BREACH_PROB_GOLD || "0.16"),
    "Pro (Platinum)": Number(process.env.PILOT_PREMIUM_EXPECTED_TRIGGER_BREACH_PROB_PLATINUM || "0.14")
  };
  configModule.pilotConfig.premiumProfitabilityBufferPctByTier = {
    "Pro (Bronze)": Number(process.env.PILOT_PREMIUM_PROFITABILITY_BUFFER_PCT_BRONZE || "0.015"),
    "Pro (Silver)": Number(process.env.PILOT_PREMIUM_PROFITABILITY_BUFFER_PCT_SILVER || "0.012"),
    "Pro (Gold)": Number(process.env.PILOT_PREMIUM_PROFITABILITY_BUFFER_PCT_GOLD || "0.01"),
    "Pro (Platinum)": Number(process.env.PILOT_PREMIUM_PROFITABILITY_BUFFER_PCT_PLATINUM || "0.01")
  };
  configModule.pilotConfig.premiumTriggerCreditWeightByTier = {
    "Pro (Bronze)": Number(process.env.PILOT_PREMIUM_TRIGGER_CREDIT_WEIGHT_BRONZE || "0.35"),
    "Pro (Silver)": Number(process.env.PILOT_PREMIUM_TRIGGER_CREDIT_WEIGHT_SILVER || "0.32"),
    "Pro (Gold)": Number(process.env.PILOT_PREMIUM_TRIGGER_CREDIT_WEIGHT_GOLD || "0.28"),
    "Pro (Platinum)": Number(process.env.PILOT_PREMIUM_TRIGGER_CREDIT_WEIGHT_PLATINUM || "0.25")
  };
  configModule.pilotConfig.treasuryPerQuoteSubsidyCapPct = Number(
    process.env.PILOT_TREASURY_PER_QUOTE_SUBSIDY_CAP_PCT || process.env.PILOT_TREASURY_SUBSIDY_CAP_PCT || "0.7"
  );
  configModule.pilotConfig.treasuryDailySubsidyCapUsdc = Number(
    process.env.PILOT_TREASURY_DAILY_SUBSIDY_CAP_USDC || "15000"
  );
  configModule.pilotConfig.treasuryStrictFallbackEnabled =
    process.env.PILOT_TREASURY_STRICT_FALLBACK_ENABLED !== "false";
  configModule.pilotConfig.ibkrFeePerContractUsd = Math.max(0, Number(process.env.IBKR_FEE_PER_CONTRACT_USD || "2.02"));
  configModule.pilotConfig.ibkrFeePerOrderUsd = Math.max(0, Number(process.env.IBKR_FEE_PER_ORDER_USD || "0"));
  configModule.pilotConfig.triggerMonitorEnabled = process.env.PILOT_TRIGGER_MONITOR_ENABLED !== "false";
  configModule.pilotConfig.triggerMonitorIntervalMs = Number(process.env.PILOT_TRIGGER_MONITOR_INTERVAL_MS || "5000");
  configModule.pilotConfig.triggerMonitorBatchSize = Number(process.env.PILOT_TRIGGER_MONITOR_BATCH_SIZE || "50");

  const db = newDb();
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();

  const dbModule = await import("../src/pilot/db");
  dbModule.__setPilotPoolForTests(pool as any);
  const triggerMonitorModule = await import("../src/pilot/triggerMonitor");
  triggerMonitorModule.__setTriggerMonitorEnabledForTests(false);
  const { registerPilotRoutes } = await import("../src/pilot/routes");

  const app = Fastify();
  await registerPilotRoutes(app, { deribit: (opts?.deribit || {}) as any });

  return {
    app,
    pool,
    close: async () => {
      await app.close();
      await pool.end();
      triggerMonitorModule.__setTriggerMonitorEnabledForTests(true);
      dbModule.__setPilotPoolForTests(null);
      global.fetch = originalFetch;
    }
  };
};

const quoteAndActivate = async (
  app: FastifyInstance,
  protectedNotional = 1000
): Promise<{ protectionId: string; quoteId: string }> => {
  const quoteRes = await app.inject({
    method: "POST",
    url: "/pilot/protections/quote",
    payload: defaultQuotePayload(protectedNotional)
  });
  assert.equal(quoteRes.statusCode, 200);
  const quotePayload = quoteRes.json();
  assert.equal(quotePayload.status, "ok");
  const quoteId = String(quotePayload.quote?.quoteId || "");
  assert.ok(quoteId);

  const activateRes = await app.inject({
    method: "POST",
    url: "/pilot/protections/activate",
    payload: activationPayload(quoteId, protectedNotional)
  });
  assert.equal(activateRes.statusCode, 200, activateRes.body);
  const activatePayloadJson = activateRes.json();
  assert.equal(activatePayloadJson.status, "ok");
  assert.equal(Number(activatePayloadJson.protection?.entryPrice), 100000);
  const protectionId = String(activatePayloadJson.protection?.id || "");
  assert.ok(protectionId);
  return { protectionId, quoteId };
};

const withFixedNow = async <T>(iso: string, fn: () => Promise<T>): Promise<T> => {
  const realNow = Date.now;
  Date.now = () => new Date(iso).getTime();
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
};

test("pilot route hardening A-H", async (t) => {
  await t.test("A) tenant-scoped read works without user id and userHash is removed", async () => {
    const harness = await createPilotHarness();
    try {
      const { app } = harness;
      const { protectionId } = await quoteAndActivate(app);

      const scopedRes = await app.inject({
        method: "GET",
        url: `/pilot/protections/${protectionId}`
      });
      assert.equal(scopedRes.statusCode, 200);
      const scoped = scopedRes.json();
      assert.equal(scoped.status, "ok");
      assert.equal(Object.prototype.hasOwnProperty.call(scoped.protection, "userHash"), false);

      const monitorScoped = await app.inject({
        method: "GET",
        url: `/pilot/protections/${protectionId}/monitor`
      });
      assert.equal(monitorScoped.statusCode, 200);
      assert.equal(monitorScoped.json().status, "ok");

      const adminMonitorUnauthorized = await app.inject({
        method: "GET",
        url: `/pilot/admin/protections/${protectionId}/monitor`
      });
      assert.equal(adminMonitorUnauthorized.statusCode, 401);

      const adminMonitorAuthorized = await app.inject({
        method: "GET",
        url: `/pilot/admin/protections/${protectionId}/monitor`,
        headers: { "x-admin-token": "admin-local" }
      });
      assert.equal(adminMonitorAuthorized.statusCode, 200);
      assert.equal(adminMonitorAuthorized.json().status, "ok");
    } finally {
      await harness.close();
    }
  });

  await t.test("B) renewal decision is user-id free and internal expiry requires privileged auth", async () => {
    const harness = await createPilotHarness();
    try {
      const { app } = harness;
      const { protectionId } = await quoteAndActivate(app);

      const renewOk = await app.inject({
        method: "POST",
        url: `/pilot/protections/${protectionId}/renewal-decision`,
        payload: { decision: "expire" }
      });
      assert.equal(renewOk.statusCode, 200);

      const internalNoAuth = await app.inject({
        method: "POST",
        url: `/pilot/internal/protections/${protectionId}/resolve-expiry`,
        payload: {}
      });
      assert.equal(internalNoAuth.statusCode, 401);

      const internalAdmin = await app.inject({
        method: "POST",
        url: `/pilot/internal/protections/${protectionId}/resolve-expiry`,
        headers: { "x-admin-token": "admin-local" },
        payload: {}
      });
      assert.equal(internalAdmin.statusCode, 200);
    } finally {
      await harness.close();
    }
  });

  await t.test("C) quote lock is single-use with idempotent activation replay", async () => {
    const harness = await createPilotHarness();
    try {
      const { app, pool } = harness;
      const quoteRes = await app.inject({
        method: "POST",
        url: "/pilot/protections/quote",
        payload: defaultQuotePayload(1200)
      });
      assert.equal(quoteRes.statusCode, 200);
      const quoteId = String(quoteRes.json().quote.quoteId);

      const firstActivate = await app.inject({
        method: "POST",
        url: "/pilot/protections/activate",
        payload: activationPayload(quoteId, 1200)
      });
      assert.equal(firstActivate.statusCode, 200);
      const first = firstActivate.json();
      const firstProtectionId = String(first.protection.id);
      assert.equal(Object.prototype.hasOwnProperty.call(first.quote, "id"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(first.quote, "protectionId"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(first.quote, "consumedAt"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(first.quote, "consumedByProtectionId"), false);

      const secondActivate = await app.inject({
        method: "POST",
        url: "/pilot/protections/activate",
        payload: activationPayload(quoteId, 1200)
      });
      assert.equal(secondActivate.statusCode, 200);
      const second = secondActivate.json();
      assert.equal(second.idempotentReplay, true);
      assert.equal(String(second.protection.id), firstProtectionId);
      assert.equal(Object.prototype.hasOwnProperty.call(second.quote, "id"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(second.quote, "protectionId"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(second.quote, "consumedAt"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(second.quote, "consumedByProtectionId"), false);

      const protectionCount = await pool.query(`SELECT COUNT(*)::int AS n FROM pilot_protections`);
      const executionCount = await pool.query(`SELECT COUNT(*)::int AS n FROM pilot_venue_executions`);
      assert.equal(Number(protectionCount.rows[0].n), 1);
      assert.equal(Number(executionCount.rows[0].n), 1);
    } finally {
      await harness.close();
    }
  });

  await t.test("D) daily cap enforcement is atomic under concurrent activate requests", async () => {
    const harness = await createPilotHarness();
    try {
      const { app } = harness;
      const q1 = await app.inject({
        method: "POST",
        url: "/pilot/protections/quote",
        payload: defaultQuotePayload(30000)
      });
      const q2 = await app.inject({
        method: "POST",
        url: "/pilot/protections/quote",
        payload: defaultQuotePayload(30000)
      });
      assert.equal(q1.statusCode, 200);
      assert.equal(q2.statusCode, 200);
      const q1Id = String(q1.json().quote.quoteId);
      const q2Id = String(q2.json().quote.quoteId);

      const [a1, a2] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/pilot/protections/activate",
          payload: activationPayload(q1Id, 30000)
        }),
        app.inject({
          method: "POST",
          url: "/pilot/protections/activate",
          payload: activationPayload(q2Id, 30000)
        })
      ]);

      const p1 = a1.json();
      const p2 = a2.json();
      const okCount = [p1, p2].filter((item) => item.status === "ok").length;
      const capCount = [p1, p2].filter((item) => item.reason === "daily_notional_cap_exceeded").length;
      assert.equal(okCount, 1);
      assert.equal(capCount, 1);
    } finally {
      await harness.close();
    }
  });

  await t.test("E) activation ignores client expiry override and enforces fixed 7-day tenor", async () => {
    const harness = await createPilotHarness();
    try {
      const { app } = harness;
      const quoteRes = await app.inject({
        method: "POST",
        url: "/pilot/protections/quote",
        payload: defaultQuotePayload(1500)
      });
      assert.equal(quoteRes.statusCode, 200);
      const quoteId = String(quoteRes.json().quote.quoteId);
      const requestedOverride = new Date(Date.now() + 30 * 86400000).toISOString();

      const activateRes = await app.inject({
        method: "POST",
        url: "/pilot/protections/activate",
        payload: {
          ...activationPayload(quoteId, 1500),
          expiryAt: requestedOverride
        }
      });
      assert.equal(activateRes.statusCode, 200);
      const payload = activateRes.json();
      const expiryMs = Date.parse(payload.protection.expiryAt);
      const days = (expiryMs - Date.now()) / 86400000;
      assert.ok(days > 6.5 && days < 7.5, `expected ~7d tenor, got ${days.toFixed(4)} days`);
    } finally {
      await harness.close();
    }
  });

  await t.test("F) pilot window enforces start and hard stop", async () => {
    const harness = await createPilotHarness();
    const previousStart = process.env.PILOT_START_AT;
    const previousDuration = process.env.PILOT_DURATION_DAYS;
    const previousEnforce = process.env.PILOT_ENFORCE_WINDOW;
    const dayMs = 86400000;
    try {
      const { app } = harness;
      process.env.PILOT_ENFORCE_WINDOW = "true";
      process.env.PILOT_DURATION_DAYS = "30";
      process.env.PILOT_START_AT = new Date(Date.now() + dayMs).toISOString();

      const notStarted = await app.inject({
        method: "POST",
        url: "/pilot/protections/quote",
        payload: defaultQuotePayload(1000)
      });
      assert.equal(notStarted.statusCode, 403);
      assert.equal(notStarted.json().reason, "pilot_not_started");

      process.env.PILOT_START_AT = new Date(Date.now() - 31 * dayMs).toISOString();
      const closed = await app.inject({
        method: "POST",
        url: "/pilot/protections/quote",
        payload: defaultQuotePayload(1000)
      });
      assert.equal(closed.statusCode, 403);
      assert.equal(closed.json().reason, "pilot_window_closed");

      process.env.PILOT_START_AT = new Date(Date.now() - dayMs).toISOString();
      const open = await app.inject({
        method: "POST",
        url: "/pilot/protections/quote",
        payload: defaultQuotePayload(1000)
      });
      assert.equal(open.statusCode, 200);
      assert.equal(open.json().status, "ok");
    } finally {
      process.env.PILOT_START_AT = previousStart;
      process.env.PILOT_DURATION_DAYS = previousDuration;
      process.env.PILOT_ENFORCE_WINDOW = previousEnforce;
      await harness.close();
    }
  });

  await t.test("G) admin allowlist uses trusted request IP (x-forwarded-for spoof ignored)", async () => {
    const harness = await createPilotHarness();
    try {
      const { app } = harness;
      const res = await app.inject({
        method: "GET",
        url: "/pilot/admin/metrics",
        headers: {
          "x-admin-token": "admin-local",
          "x-forwarded-for": "8.8.8.8"
        }
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().status, "ok");

      const { protectionId } = await quoteAndActivate(app, 1000);
      const monitorRes = await app.inject({
        method: "GET",
        url: `/pilot/admin/protections/${protectionId}/monitor`,
        headers: {
          "x-admin-token": "admin-local",
          "x-forwarded-for": "8.8.8.8"
        }
      });
      assert.equal(monitorRes.statusCode, 200);
      assert.equal(monitorRes.json().status, "ok");
    } finally {
      await harness.close();
    }
  });

  await t.test("G2) admin export is tenant scoped and supports scope/status/archive filters", async () => {
    const harness = await createPilotHarness();
    try {
      const { app, pool } = harness;
      const first = await quoteAndActivate(app, 1000);
      const second = await quoteAndActivate(app, 1500);
      await pool.query(`UPDATE pilot_protections SET status = 'activation_failed' WHERE id = $1`, [second.protectionId]);

      const activeRes = await app.inject({
        method: "GET",
        url: "/pilot/protections/export?format=json&scope=active",
        headers: { "x-admin-token": "admin-local" }
      });
      assert.equal(activeRes.statusCode, 200);
      const activePayload = activeRes.json();
      assert.equal(activePayload.status, "ok");
      assert.equal(String(activePayload.scope || ""), "active");
      assert.equal(Number(activePayload.rows?.length || 0), 1);
      assert.equal(String(activePayload.rows?.[0]?.status || ""), "active");

      const failedRes = await app.inject({
        method: "GET",
        url: "/pilot/protections/export?format=json&scope=all&status=activation_failed",
        headers: { "x-admin-token": "admin-local" }
      });
      assert.equal(failedRes.statusCode, 200);
      const failedPayload = failedRes.json();
      assert.equal(failedPayload.status, "ok");
      assert.equal(String(failedPayload.scope || ""), "all");
      assert.equal(String(failedPayload.statusFilter || ""), "activation_failed");
      assert.equal(Number(failedPayload.rows?.length || 0), 1);
      assert.equal(String(failedPayload.rows?.[0]?.protection_id || ""), second.protectionId);

      const archiveRes = await app.inject({
        method: "POST",
        url: "/pilot/admin/protections/archive-except-current",
        headers: { "x-admin-token": "admin-local" },
        payload: { keepProtectionId: first.protectionId, reason: "test-archive" }
      });
      assert.equal(archiveRes.statusCode, 200);
      assert.equal(archiveRes.json().status, "ok");
      assert.equal(String(archiveRes.json().keepProtectionId || ""), first.protectionId);
      assert.ok(Number(archiveRes.json().archivedCount || 0) >= 1);

      const postArchiveDefaultRes = await app.inject({
        method: "GET",
        url: "/pilot/protections/export?format=json&scope=all",
        headers: { "x-admin-token": "admin-local" }
      });
      assert.equal(postArchiveDefaultRes.statusCode, 200);
      const postArchiveDefault = postArchiveDefaultRes.json();
      assert.equal(postArchiveDefault.status, "ok");
      assert.equal(Number(postArchiveDefault.rows?.length || 0), 1);
      assert.equal(String(postArchiveDefault.rows?.[0]?.protection_id || ""), first.protectionId);

      const postArchiveIncludeRes = await app.inject({
        method: "GET",
        url: "/pilot/protections/export?format=json&scope=all&includeArchived=true",
        headers: { "x-admin-token": "admin-local" }
      });
      assert.equal(postArchiveIncludeRes.statusCode, 200);
      const postArchiveInclude = postArchiveIncludeRes.json();
      assert.equal(postArchiveInclude.status, "ok");
      assert.ok(Number(postArchiveInclude.rows?.length || 0) >= 2);
    } finally {
      await harness.close();
    }
  });

  await t.test("H) terms acceptance is server-side, auditable, and one-time per tenant+version", async () => {
    const harness = await createPilotHarness();
    try {
      const { app, pool } = harness;
      const statusBefore = await app.inject({
        method: "GET",
        url: `/pilot/terms/status?termsVersion=v1.0`
      });
      assert.equal(statusBefore.statusCode, 200);
      assert.equal(statusBefore.json().status, "ok");
      assert.equal(statusBefore.json().accepted, false);

      const acceptFirst = await app.inject({
        method: "POST",
        url: "/pilot/terms/accept",
        headers: {
          "user-agent": "pilot-tests/1.0"
        },
        payload: {
          termsVersion: "v1.0",
          accepted: true
        }
      });
      assert.equal(acceptFirst.statusCode, 200);
      assert.equal(acceptFirst.json().status, "ok");
      assert.equal(acceptFirst.json().firstAcceptance, true);
      const firstAcceptanceId = String(acceptFirst.json().acceptanceId || "");
      assert.ok(firstAcceptanceId);

      const acceptSecond = await app.inject({
        method: "POST",
        url: "/pilot/terms/accept",
        payload: {
          termsVersion: "v1.0",
          accepted: true
        }
      });
      assert.equal(acceptSecond.statusCode, 200);
      assert.equal(acceptSecond.json().status, "ok");
      assert.equal(acceptSecond.json().firstAcceptance, false);
      assert.equal(String(acceptSecond.json().acceptanceId || ""), firstAcceptanceId);

      const statusAfter = await app.inject({
        method: "GET",
        url: `/pilot/terms/status?termsVersion=v1.0`
      });
      assert.equal(statusAfter.statusCode, 200);
      assert.equal(statusAfter.json().status, "ok");
      assert.equal(statusAfter.json().accepted, true);
      assert.ok(statusAfter.json().acceptedAt);

      const acceptanceRows = await pool.query(
        `SELECT COUNT(*)::int AS n FROM pilot_terms_acceptances WHERE terms_version = 'v1.0'`
      );
      assert.equal(Number(acceptanceRows.rows[0].n), 1);
      const acceptanceAudit = await pool.query(
        `SELECT accepted_ip, user_agent FROM pilot_terms_acceptances WHERE terms_version = 'v1.0' LIMIT 1`
      );
      assert.equal(String(acceptanceAudit.rows[0].accepted_ip || ""), "127.0.0.1");
      assert.equal(String(acceptanceAudit.rows[0].user_agent || ""), "pilot-tests/1.0");
    } finally {
      await harness.close();
    }
  });

  await t.test("I) settlement posting is idempotent per protection", async () => {
    const harness = await createPilotHarness();
    try {
      const { app, pool } = harness;
      const { protectionId } = await quoteAndActivate(app, 1200);

      const firstPremium = await app.inject({
        method: "POST",
        url: `/pilot/admin/protections/${protectionId}/premium-settled`,
        headers: { "x-admin-token": "admin-local" },
        payload: { amount: 12.34, reference: "pilot-premium-1" }
      });
      assert.equal(firstPremium.statusCode, 200);
      assert.equal(firstPremium.json().status, "ok");

      const replayPremium = await app.inject({
        method: "POST",
        url: `/pilot/admin/protections/${protectionId}/premium-settled`,
        headers: { "x-admin-token": "admin-local" },
        payload: { amount: 12.34, reference: "pilot-premium-1" }
      });
      assert.equal(replayPremium.statusCode, 200);
      assert.equal(replayPremium.json().status, "ok");
      assert.equal(replayPremium.json().idempotentReplay, true);

      await pool.query(`UPDATE pilot_protections SET expiry_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [
        protectionId
      ]);
      const resolveExpiry = await app.inject({
        method: "POST",
        url: `/pilot/internal/protections/${protectionId}/resolve-expiry`,
        headers: { "x-admin-token": "admin-local" },
        payload: {}
      });
      assert.equal(resolveExpiry.statusCode, 200);
      const settledAmount = Number(resolveExpiry.json().protection?.payoutDueAmount ?? 0);

      const firstPayout = await app.inject({
        method: "POST",
        url: `/pilot/admin/protections/${protectionId}/payout-settled`,
        headers: { "x-admin-token": "admin-local" },
        payload: { amount: settledAmount, payoutTxRef: "pilot-payout-1" }
      });
      assert.equal(firstPayout.statusCode, 200);
      assert.equal(firstPayout.json().status, "ok");

      const replayPayout = await app.inject({
        method: "POST",
        url: `/pilot/admin/protections/${protectionId}/payout-settled`,
        headers: { "x-admin-token": "admin-local" },
        payload: { amount: settledAmount, payoutTxRef: "pilot-payout-1" }
      });
      assert.equal(replayPayout.statusCode, 200);
      assert.equal(replayPayout.json().status, "ok");
      assert.equal(replayPayout.json().idempotentReplay, true);

      const premiumSettledCount = await pool.query(
        `SELECT COUNT(*)::int AS n FROM pilot_ledger_entries WHERE protection_id = $1 AND entry_type = 'premium_settled'`,
        [protectionId]
      );
      assert.equal(Number(premiumSettledCount.rows[0].n), 1);

      const payoutSettledCount = await pool.query(
        `SELECT COUNT(*)::int AS n FROM pilot_ledger_entries WHERE protection_id = $1 AND entry_type = 'payout_settled'`,
        [protectionId]
      );
      assert.equal(Number(payoutSettledCount.rows[0].n), 1);
    } finally {
      await harness.close();
    }
  });

  await t.test("I2) admin metrics reconcile pending receivable and open liability", async () => {
    const harness = await createPilotHarness();
    try {
      const { app } = harness;
      const { protectionId } = await quoteAndActivate(app, 1200);

      const preMetricsRes = await app.inject({
        method: "GET",
        url: "/pilot/admin/metrics?scope=all",
        headers: { "x-admin-token": "admin-local" }
      });
      assert.equal(preMetricsRes.statusCode, 200);
      assert.equal(String(preMetricsRes.json().scope || ""), "all");
      const preMetrics = preMetricsRes.json().metrics || {};

      // Settle only part of premium and payout so pending/open metrics remain non-zero.
      const settlePremium = await app.inject({
        method: "POST",
        url: `/pilot/admin/protections/${protectionId}/premium-settled`,
        headers: { "x-admin-token": "admin-local" },
        payload: { amount: 5, reference: "partial-premium" }
      });
      assert.equal(settlePremium.statusCode, 200);

      const { pool } = harness;
      await pool.query(`UPDATE pilot_protections SET expiry_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [
        protectionId
      ]);
      const resolveExpiry = await app.inject({
        method: "POST",
        url: `/pilot/internal/protections/${protectionId}/resolve-expiry`,
        headers: { "x-admin-token": "admin-local" },
        payload: {}
      });
      assert.equal(resolveExpiry.statusCode, 200);
      const payoutDue = Number(resolveExpiry.json().protection?.payoutDueAmount ?? 0);

      const settlePayout = await app.inject({
        method: "POST",
        url: `/pilot/admin/protections/${protectionId}/payout-settled`,
        headers: { "x-admin-token": "admin-local" },
        payload: { amount: Math.max(0, payoutDue / 2), payoutTxRef: "partial-payout" }
      });
      assert.equal(settlePayout.statusCode, 200);

      const postMetricsRes = await app.inject({
        method: "GET",
        url: "/pilot/admin/metrics?scope=all",
        headers: { "x-admin-token": "admin-local" }
      });
      assert.equal(postMetricsRes.statusCode, 200);
      const postMetrics = postMetricsRes.json().metrics || {};

      const premiumDue = Number(postMetrics.premiumDueTotalUsdc || 0);
      const premiumSettled = Number(postMetrics.premiumSettledTotalUsdc || 0);
      const pendingPremiumReceivable = Number(postMetrics.pendingPremiumReceivableUsdc || 0);
      assert.ok(Math.abs((premiumDue - premiumSettled) - pendingPremiumReceivable) < 1e-6);

      const payoutDueTotal = Number(postMetrics.payoutDueTotalUsdc || 0);
      const payoutSettledTotal = Number(postMetrics.payoutSettledTotalUsdc || 0);
      const openPayoutLiability = Number(postMetrics.openPayoutLiabilityUsdc || 0);
      assert.ok(Math.abs((payoutDueTotal - payoutSettledTotal) - openPayoutLiability) < 1e-6);

      const startingReserve = Number(postMetrics.startingReserveUsdc || 0);
      const hedgePremium = Number(postMetrics.hedgePremiumTotalUsdc || 0);
      const availableReserve = Number(postMetrics.availableReserveUsdc || 0);
      assert.ok(Math.abs((startingReserve - hedgePremium + premiumSettled - payoutSettledTotal) - availableReserve) < 1e-6);

      const reserveAfterOpen = Number(postMetrics.reserveAfterOpenPayoutLiabilityUsdc || 0);
      assert.ok(Math.abs((availableReserve - openPayoutLiability) - reserveAfterOpen) < 1e-6);

      const netSettledCash = Number(postMetrics.netSettledCashUsdc || 0);
      assert.ok(Math.abs((premiumSettled - payoutSettledTotal) - netSettledCash) < 1e-6);

      // sanity: metrics actually changed
      assert.notEqual(
        String(preMetrics.premiumSettledTotalUsdc || "0"),
        String(postMetrics.premiumSettledTotalUsdc || "0")
      );
    } finally {
      await harness.close();
    }
  });

  await t.test("I3) admin metrics scope=active excludes activation_failed protections", async () => {
    const harness = await createPilotHarness();
    try {
      const { app } = harness;
      const active = await quoteAndActivate(app, 1000);
      assert.ok(active.protectionId);

      const failedQuoteRes = await app.inject({
        method: "POST",
        url: "/pilot/protections/quote",
        payload: defaultQuotePayload(1000)
      });
      assert.equal(failedQuoteRes.statusCode, 200);
      const failedQuoteId = String(failedQuoteRes.json().quote?.quoteId || "");
      assert.ok(failedQuoteId);
      // Force this protection into activation_failed to verify scope filtering.
      const failedActivation = await app.inject({
        method: "POST",
        url: "/pilot/protections/activate",
        payload: activationPayload(failedQuoteId, 1000)
      });
      assert.equal(failedActivation.statusCode, 200);
      const failedProtectionId = String(failedActivation.json().protection?.id || "");
      assert.ok(failedProtectionId);
      const { pool } = harness;
      // Force the latest protection into activation_failed to verify scope behavior.
      await pool.query(
        `UPDATE pilot_protections SET status = 'activation_failed' WHERE id = (SELECT id FROM pilot_protections ORDER BY created_at DESC LIMIT 1)`
      );
      const protectionRows = await pool.query(`SELECT status FROM pilot_protections ORDER BY created_at ASC`);
      const statuses = protectionRows.rows.map((row) => String(row.status));
      const allExpected = statuses.length;
      const activeScopeExpected = statuses.filter((status) => status === "active" || status === "awaiting_expiry_price").length;
      const failedCount = statuses.filter((status) => status === "activation_failed").length;
      assert.ok(failedCount >= 1);

      const activeScopeRes = await app.inject({
        method: "GET",
        url: "/pilot/admin/metrics",
        headers: { "x-admin-token": "admin-local" }
      });
      assert.equal(activeScopeRes.statusCode, 200);
      const activeScope = activeScopeRes.json();
      assert.equal(String(activeScope.scope || ""), "active");
      assert.equal(Number(activeScope.metrics?.totalProtections || 0), activeScopeExpected);

      const allScopeRes = await app.inject({
        method: "GET",
        url: "/pilot/admin/metrics?scope=all",
        headers: { "x-admin-token": "admin-local" }
      });
      assert.equal(allScopeRes.statusCode, 200);
      const allScope = allScopeRes.json();
      assert.equal(String(allScope.scope || ""), "all");
      assert.equal(Number(allScope.metrics?.totalProtections || 0), allExpected);
      assert.ok(Number(activeScope.metrics?.totalProtections || 0) < Number(allScope.metrics?.totalProtections || 0));
      assert.equal(Number(allScope.metrics?.protectedNotionalTotalUsdc || 0), 2000);
    } finally {
      await harness.close();
    }
  });

  await t.test("J) reference price endpoint returns live anchor metadata", async () => {
    const harness = await createPilotHarness();
    try {
      const { app } = harness;
      const res = await app.inject({
        method: "GET",
        url: "/pilot/reference-price?marketId=BTC-USD"
      });
      assert.equal(res.statusCode, 200);
      const payload = res.json();
      assert.equal(payload.status, "ok");
      assert.equal(String(payload.reference?.marketId || ""), "BTC-USD");
      assert.equal(Number(payload.reference?.price || 0), 100000);
      assert.ok(String(payload.reference?.venue || "").length > 0);
      assert.ok(String(payload.reference?.source || "").length > 0);
      assert.ok(String(payload.reference?.timestamp || "").length > 0);
    } finally {
      await harness.close();
    }
  });
});

test.after(() => {
  global.fetch = originalFetch;
});

test("K) quote diagnostics surface venue strike/tenor selection", async () => {
  const harness = await createPilotHarness();
  try {
    const quoteRes = await harness.app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: defaultQuotePayload(1000)
    });
    assert.equal(quoteRes.statusCode, 200);
    const payload = quoteRes.json();
    assert.equal(payload.status, "ok");
    assert.ok(payload.diagnostics?.venueSelection);
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.diagnostics.venueSelection, "selectedStrike"),
      true
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.diagnostics.venueSelection, "tenorDriftDays"),
      true
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.diagnostics.venueSelection, "deribitQuotePolicy"),
      true
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.diagnostics.venueSelection, "strikeSelectionMode"),
      true
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.diagnostics.venueSelection, "requestedTenorDays"),
      true
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.diagnostics.venueSelection, "selectedTenorDaysActual"),
      true
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.diagnostics.venueSelection, "selectedExpiry"),
      true
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.diagnostics.venueSelection, "selectionAlgorithm"),
      true
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.diagnostics.venueSelection, "candidateCountEvaluated"),
      true
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.diagnostics.venueSelection, "selectedScore"),
      true
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.diagnostics.venueSelection, "selectedRank"),
      true
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.diagnostics.venueSelection, "matchedTenorHoursEstimate"),
      true
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.diagnostics.venueSelection, "matchedTenorDisplay"),
      true
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.diagnostics.venueSelection, "selectionTrace"),
      true
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.diagnostics.venueSelection, "rankedAlternatives"),
      true
    );
  } finally {
    await harness.close();
  }
});

test("L) post-execution persistence failure marks protection reconcile_pending", async () => {
  const harness = await createPilotHarness();
  try {
    const originalQuery = harness.pool.query.bind(harness.pool);
    let injectedFailure = false;
    harness.pool.query = async (sql: string, params?: unknown[]) => {
      const text = String(sql || "");
      const hasActiveStatus = Array.isArray(params) && params.some((value) => value === "active");
      if (!injectedFailure && text.includes("UPDATE pilot_protections") && hasActiveStatus) {
        injectedFailure = true;
        throw new Error("db_write_after_execution_failed");
      }
      return originalQuery(sql, params);
    };
    const quoteRes = await harness.app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: defaultQuotePayload(1000)
    });
    assert.equal(quoteRes.statusCode, 200);
    const quoteId = String(quoteRes.json().quote.quoteId);
    const activateRes = await harness.app.inject({
      method: "POST",
      url: "/pilot/protections/activate",
      payload: activationPayload(quoteId, 1000)
    });
    harness.pool.query = originalQuery;
    // debug
    assert.equal(activateRes.statusCode, 409);
    const activatePayload = activateRes.json();
    assert.equal(activatePayload.reason, "reconcile_pending");
    const protections = await harness.pool.query(
      `SELECT status, metadata FROM pilot_protections ORDER BY created_at DESC LIMIT 1`
    );
    assert.equal(String(protections.rows[0]?.status || ""), "reconcile_pending");
    const metadata = protections.rows[0]?.metadata || {};
    assert.ok(String(metadata.externalOrderId || "").length > 0);
    assert.ok(String(metadata.reconcileReason || "").length > 0);
  } finally {
    await harness.close();
  }
});

test("M) quote with failed prior protection returns quote_not_activatable", async () => {
  const harness = await createPilotHarness({
    venueMode: "deribit_test",
    deribit: buildDeribitExecutionFailureStub()
  });
  try {
    const { app } = harness;
    const quoteRes = await app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: defaultQuotePayload(1000)
    });
    assert.equal(quoteRes.statusCode, 200);
    const quoteId = String(quoteRes.json().quote.quoteId);

    // First activation attempt will fail and mark protection activation_failed.
    const failedActivation = await app.inject({
      method: "POST",
      url: "/pilot/protections/activate",
      payload: activationPayload(quoteId, 1000)
    });
    assert.equal(failedActivation.statusCode, 502);
    assert.equal(failedActivation.json().reason, "execution_failed");

    // Re-activating same quote should now surface non-activatable state.
    const replay = await app.inject({
      method: "POST",
      url: "/pilot/protections/activate",
      payload: activationPayload(quoteId, 1000)
    });
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.json().reason, "quote_not_activatable");
  } finally {
    await harness.close();
  }
});

test("M2) activation can be disabled during quote-only validation mode", async () => {
  const harness = await createPilotHarness({
    env: {
      PILOT_ACTIVATION_ENABLED: "false"
    }
  });
  try {
    const { app } = harness;
    const quoteRes = await app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: defaultQuotePayload(1000)
    });
    assert.equal(quoteRes.statusCode, 200);
    const quoteId = String(quoteRes.json().quote.quoteId || "");
    assert.ok(quoteId.length > 0);

    const activateRes = await app.inject({
      method: "POST",
      url: "/pilot/protections/activate",
      payload: activationPayload(quoteId, 1000)
    });
    assert.equal(activateRes.statusCode, 503);
    const payload = activateRes.json();
    assert.equal(payload.status, "error");
    assert.equal(payload.reason, "activation_disabled");
  } finally {
    await harness.close();
  }
});

test("N) execution failure marks protection activation_failed and releases daily capacity", async () => {
  const harness = await createPilotHarness({
    venueMode: "deribit_test",
    deribit: buildDeribitExecutionFailureStub()
  });
  try {
    const { app, pool } = harness;
    const quoteRes = await app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: defaultQuotePayload(1000)
    });
    assert.equal(quoteRes.statusCode, 200);
    const quoteId = String(quoteRes.json().quote.quoteId);

    const activateRes = await app.inject({
      method: "POST",
      url: "/pilot/protections/activate",
      payload: activationPayload(quoteId, 1000)
    });
    assert.equal(activateRes.statusCode, 502);
    const activatePayload = activateRes.json();
    assert.equal(activatePayload.reason, "execution_failed");

    const protectionRows = await pool.query(
      `SELECT status, metadata FROM pilot_protections ORDER BY created_at DESC LIMIT 1`
    );
    assert.equal(String(protectionRows.rows[0]?.status || ""), "activation_failed");
    assert.equal(Boolean(protectionRows.rows[0]?.metadata?.capReleased), true);

    const usageRows = await pool.query(`SELECT used_notional::text AS used_now FROM pilot_daily_usage LIMIT 1`);
    assert.equal(String(usageRows.rows[0]?.used_now || "0"), "0");

    const quoteRes2 = await app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: defaultQuotePayload(50000)
    });
    assert.equal(quoteRes2.statusCode, 200);
    const quoteId2 = String(quoteRes2.json().quote.quoteId);

    const activateRes2 = await app.inject({
      method: "POST",
      url: "/pilot/protections/activate",
      payload: activationPayload(quoteId2, 50000)
    });
    assert.equal(activateRes2.statusCode, 502);
    assert.equal(activateRes2.json().reason, "execution_failed");
  } finally {
    await harness.close();
  }
});

test("N2) activation execution_failed surfaces fillStatus and rejectionReason detail", async () => {
  const harness = await createPilotHarness({
    venueMode: "deribit_test",
    deribit: buildDeribitExecutionFailureStub()
  });
  try {
    const { app } = harness;
    const quoteRes = await app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: defaultQuotePayload(1000)
    });
    assert.equal(quoteRes.statusCode, 200);
    const quoteId = String(quoteRes.json().quote.quoteId);

    const activateRes = await app.inject({
      method: "POST",
      url: "/pilot/protections/activate",
      payload: activationPayload(quoteId, 1000)
    });
    assert.equal(activateRes.statusCode, 502);
    const activatePayload = activateRes.json();
    assert.equal(activatePayload.reason, "execution_failed");
    assert.equal(activatePayload.detail, "fillStatus=rejected");
  } finally {
    await harness.close();
  }
});

test("N3) activation metadata persists tenor selection context from lock quote", async () => {
  const harness = await createPilotHarness({
    env: {
      PILOT_DYNAMIC_TENOR_ENABLED: "true",
      PILOT_TENOR_CANDIDATES: "10,12,14",
      PILOT_TENOR_MIN_DAYS: "10",
      PILOT_TENOR_MAX_DAYS: "14",
      PILOT_TENOR_DEFAULT_DAYS: "12",
      PILOT_TENOR_MIN_SAMPLES: "1",
      PILOT_TENOR_MIN_OK_RATE: "0",
      PILOT_TENOR_MIN_OPTIONS_NATIVE_RATE: "0",
      PILOT_TENOR_MAX_MEDIAN_PREMIUM_RATIO: "10",
      PILOT_TENOR_MAX_MEDIAN_DRIFT_DAYS: "30",
      PILOT_TENOR_MAX_NEGATIVE_MATCH_RATE: "1",
      PILOT_TENOR_ENFORCE: "false",
      PILOT_TENOR_AUTO_ROUTE: "true",
      PILOT_TENOR_DEFAULT_FALLBACK: "12"
    }
  });
  try {
    const { app, pool } = harness;
    const policyRes = await app.inject({
      method: "GET",
      url: "/pilot/tenor-policy"
    });
    assert.equal(policyRes.statusCode, 200);
    const policyPayload = policyRes.json();
    const expectedDefaultTenor = Number(policyPayload?.selection?.defaultTenorDays || 12);

    const quoteRes = await app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: {
        ...defaultQuotePayload(1000),
        instrumentId: "BTC-USD-12D-P",
        tenorDays: 12
      }
    });
    assert.equal(quoteRes.statusCode, 200);
    const quotePayload = quoteRes.json();
    assert.equal(quotePayload.status, "ok");
    const quoteId = String(quotePayload.quote?.quoteId || "");
    assert.ok(quoteId);

    const activateRes = await app.inject({
      method: "POST",
      url: "/pilot/protections/activate",
      payload: {
        ...activationPayload(quoteId, 1000),
        instrumentId: "BTC-USD-12D-P",
        tenorDays: 12
      }
    });
    assert.equal(activateRes.statusCode, 200);
    const protectionId = String(activateRes.json()?.protection?.id || "");
    assert.ok(protectionId);

    const persisted = await pool.query(`SELECT metadata FROM pilot_protections WHERE id = $1`, [protectionId]);
    const metadata = (persisted.rows[0]?.metadata || {}) as Record<string, unknown>;
    assert.equal(Number(metadata.requestedTenorDays), 12);
    assert.equal(Number(metadata.venueRequestedTenorDays), expectedDefaultTenor);
    assert.equal(typeof metadata.tenorPolicyStatus, "string");
    assert.equal(metadata.selectedExpiry === null || typeof metadata.selectedExpiry === "string", true);
    assert.equal(
      metadata.selectedTenorDays === null || Number.isFinite(Number(metadata.selectedTenorDays)),
      true
    );
  } finally {
    await harness.close();
  }
});

test("N4) activation premium diagnostics preserve estimated vs realized fee components", async () => {
  const harness = await createPilotHarness({
    env: {
      PILOT_PREMIUM_POLICY_MODE: "pass_through_markup",
      PILOT_PREMIUM_MARKUP_PCT_BRONZE: "0.1",
      IBKR_FEE_PER_CONTRACT_USD: "2.02",
      IBKR_FEE_PER_ORDER_USD: "0"
    }
  });
  try {
    const { app } = harness;
    const quoteRes = await app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: {
        ...defaultQuotePayload(1000),
        tenorDays: 7
      }
    });
    assert.equal(quoteRes.statusCode, 200);
    const quotePayload = quoteRes.json();
    const quoteId = String(quotePayload.quote?.quoteId || "");
    assert.ok(quoteId);

    const activateRes = await app.inject({
      method: "POST",
      url: "/pilot/protections/activate",
      payload: activationPayload(quoteId, 1000)
    });
    assert.equal(activateRes.statusCode, 200);
    const payload = activateRes.json();
    assert.equal(payload.status, "ok");
    const estimated = payload?.diagnostics?.premiumPolicy?.estimated || {};
    const realized = payload?.diagnostics?.premiumPolicy?.realized || {};
    assert.equal(Number(estimated.brokerFeesUsd), 0);
    // In this mock venue harness there is no external commission report, so realized fee falls back to estimate.
    assert.equal(Number(realized.brokerFeesUsd), Number(estimated.brokerFeesUsd));
    assert.equal(Number(realized.passThroughUsd), Number(realized.hedgeCostUsd) + Number(realized.brokerFeesUsd));
    assert.equal(Number(realized.clientPremiumUsd), Number(payload?.protection?.premium || 0));
  } finally {
    await harness.close();
  }
});

test("N4b) activation premium diagnostics include profitability floor economics", async () => {
  const harness = await createPilotHarness({
    env: {
      PILOT_PREMIUM_POLICY_MODE: "pass_through_markup",
      PILOT_PREMIUM_MARKUP_PCT_BRONZE: "0.02",
      PILOT_PREMIUM_TRIGGER_CREDIT_FLOOR_PCT_BRONZE: "0.03",
      PILOT_PREMIUM_EXPECTED_TRIGGER_BREACH_PROB_BRONZE: "0.25",
      PILOT_PREMIUM_PROFITABILITY_BUFFER_PCT_BRONZE: "0.015",
      PILOT_PREMIUM_TRIGGER_CREDIT_WEIGHT_BRONZE: "0.35"
    }
  });
  try {
    const { app } = harness;
    const quoteRes = await app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: defaultQuotePayload(1000)
    });
    assert.equal(quoteRes.statusCode, 200, quoteRes.body);
    const quotePayload = quoteRes.json();
    assert.equal(quotePayload.status, "ok");
    const estimated = quotePayload?.diagnostics?.premiumPolicy?.estimated || {};
    assert.equal(Number.isFinite(Number(estimated.hedgeCostUsd)), true);
    assert.equal(Number.isFinite(Number(estimated.brokerFeesUsd)), true);
    assert.equal(Number.isFinite(Number(estimated.passThroughUsd)), true);
    assert.equal(Number.isFinite(Number(estimated.markupUsd)), true);
    const pricingBreakdown = quotePayload?.quote?.details?.pricingBreakdown || {};
    assert.equal(Number.isFinite(Number(pricingBreakdown.expectedTriggerCostUsd)), true);
    assert.equal(Number.isFinite(Number(pricingBreakdown.profitabilityFloorUsd)), true);
    assert.equal(Number.isFinite(Number(pricingBreakdown.selectionFeasibilityPenaltyUsd)), true);
    assert.equal(Number.isFinite(Number(pricingBreakdown.premiumProfitabilityTargetUsd)), true);
    assert.equal(Number.isFinite(Number(pricingBreakdown.premiumProfitabilityTargetRatio)), true);
    assert.equal(
      Number(pricingBreakdown.profitabilityFloorUsd) >= Number(pricingBreakdown.expectedTriggerCostUsd),
      true
    );
    assert.equal(
      Number(pricingBreakdown.selectionFeasibilityPenaltyUsd),
      Number(pricingBreakdown.expectedTriggerCostUsd)
    );
  } finally {
    await harness.close();
  }
});

test("Q) tenor-policy endpoint returns structured policy payload", async () => {
  const harness = await createPilotHarness({
    env: {
      PILOT_DYNAMIC_TENOR_ENABLED: "true",
      PILOT_TENOR_CANDIDATES: "1,2,4",
      PILOT_TENOR_MIN_SAMPLES: "1",
      PILOT_TENOR_MIN_OK_RATE: "0",
      PILOT_TENOR_MIN_OPTIONS_NATIVE_RATE: "0",
      PILOT_TENOR_MAX_MEDIAN_PREMIUM_RATIO: "10",
      PILOT_TENOR_MAX_MEDIAN_DRIFT_DAYS: "30",
      PILOT_TENOR_MAX_NEGATIVE_MATCH_RATE: "1",
      PILOT_TENOR_ENFORCE: "true",
      PILOT_TENOR_AUTO_ROUTE: "true"
    }
  });
  try {
    const policyRes = await harness.app.inject({
      method: "GET",
      url: "/pilot/tenor-policy"
    });
    assert.equal(policyRes.statusCode, 200);
    const payload = policyRes.json();
    assert.equal(payload.status, "ok");
    assert.equal(Array.isArray(payload?.config?.candidateTenorsDays), true);
    assert.equal(Array.isArray(payload?.selection?.enabledTenorsDays), true);
    assert.equal(Array.isArray(payload?.tenors), true);
  } finally {
    await harness.close();
  }
});

test("R) quote diagnostics include premiumPolicy and tenorPolicy", async () => {
  const harness = await createPilotHarness({
    env: {
      PILOT_DYNAMIC_TENOR_ENABLED: "true",
      PILOT_TENOR_CANDIDATES: "1,2,4",
      PILOT_TENOR_MIN_SAMPLES: "1",
      PILOT_TENOR_MIN_OK_RATE: "0",
      PILOT_TENOR_MIN_OPTIONS_NATIVE_RATE: "0",
      PILOT_TENOR_MAX_MEDIAN_PREMIUM_RATIO: "10",
      PILOT_TENOR_MAX_MEDIAN_DRIFT_DAYS: "30",
      PILOT_TENOR_MAX_NEGATIVE_MATCH_RATE: "1",
      PILOT_TENOR_ENFORCE: "false",
      PILOT_TENOR_AUTO_ROUTE: "true"
    }
  });
  try {
    const quoteRes = await harness.app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: {
        ...defaultQuotePayload(1000),
        tenorDays: 7
      }
    });
    assert.equal(quoteRes.statusCode, 200);
    const payload = quoteRes.json();
    assert.equal(payload.status, "ok");
    assert.ok(payload?.diagnostics?.premiumPolicy);
    assert.equal(payload?.diagnostics?.premiumPolicy?.currency, "USD");
    assert.ok(payload?.diagnostics?.tenorPolicy);
    assert.equal(
      typeof payload?.diagnostics?.tenorPolicy?.requestedTenorDays === "number",
      true
    );
  } finally {
    await harness.close();
  }
});

test("S) dynamic tenor enforce blocks unavailable requested tenor", async () => {
  const harness = await createPilotHarness({
    env: {
      PILOT_DYNAMIC_TENOR_ENABLED: "true",
      PILOT_TENOR_CANDIDATES: "1,2,4",
      PILOT_TENOR_MIN_SAMPLES: "100",
      PILOT_TENOR_ENFORCE: "true",
      PILOT_TENOR_AUTO_ROUTE: "false"
    }
  });
  try {
    const quoteRes = await harness.app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: {
        ...defaultQuotePayload(1000),
        tenorDays: 7
      }
    });
    assert.equal(quoteRes.statusCode, 409);
    const payload = quoteRes.json();
    assert.equal(payload.status, "error");
    assert.equal(payload.reason, "tenor_temporarily_unavailable");
  } finally {
    await harness.close();
  }
});

test("T) dynamic tenor auto-route rewrites venue requested tenor", async () => {
  const harness = await createPilotHarness({
    env: {
      PILOT_DYNAMIC_TENOR_ENABLED: "true",
      PILOT_TENOR_CANDIDATES: "1,2,4",
      PILOT_TENOR_MIN_SAMPLES: "1",
      PILOT_TENOR_MIN_OK_RATE: "0",
      PILOT_TENOR_MIN_OPTIONS_NATIVE_RATE: "0",
      PILOT_TENOR_MAX_MEDIAN_PREMIUM_RATIO: "10",
      PILOT_TENOR_MAX_MEDIAN_DRIFT_DAYS: "30",
      PILOT_TENOR_MAX_NEGATIVE_MATCH_RATE: "1",
      PILOT_TENOR_ENFORCE: "false",
      PILOT_TENOR_AUTO_ROUTE: "true",
      PILOT_TENOR_DEFAULT_FALLBACK: "2"
    }
  });
  try {
    // Seed a successful sample for tenor=2 so it becomes enabled.
    const seedRes = await harness.app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: {
        ...defaultQuotePayload(1000),
        tenorDays: 2
      }
    });
    assert.equal(seedRes.statusCode, 200);

    const rerouteRes = await harness.app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: {
        ...defaultQuotePayload(1000),
        tenorDays: 7
      }
    });
    assert.equal(rerouteRes.statusCode, 200);
    const payload = rerouteRes.json();
    assert.equal(payload.status, "ok");
    assert.equal(payload?.diagnostics?.tenorPolicy?.requestedTenorDays, 7);
    assert.equal(payload?.diagnostics?.tenorPolicy?.venueRequestedTenorDays, 2);
  } finally {
    await harness.close();
  }
});

test("U) degraded tenor policy with no enabled tenors falls back to default candidate", async () => {
  const harness = await createPilotHarness({
    env: {
      PILOT_DYNAMIC_TENOR_ENABLED: "true",
      PILOT_TENOR_CANDIDATES: "10,12,14",
      PILOT_TENOR_MIN_DAYS: "10",
      PILOT_TENOR_MAX_DAYS: "14",
      PILOT_TENOR_DEFAULT_DAYS: "12",
      PILOT_TENOR_MIN_SAMPLES: "100",
      PILOT_TENOR_ENFORCE: "true",
      PILOT_TENOR_AUTO_ROUTE: "true",
      PILOT_TENOR_DEFAULT_FALLBACK: "12"
    }
  });
  try {
    const quoteRes = await harness.app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: {
        ...defaultQuotePayload(1000),
        tenorDays: 12
      }
    });
    assert.equal(quoteRes.statusCode, 200);
    const payload = quoteRes.json();
    // Ensure no seed data from earlier tests leaked into this harness and changed policy state.
    assert.deepEqual(payload?.diagnostics?.tenorPolicy?.enabledTenorsDays || [], []);
    assert.equal(payload.status, "ok");
    assert.equal(payload?.diagnostics?.tenorPolicy?.status, "ok");
    assert.equal(payload?.diagnostics?.tenorPolicy?.requestedTenorDays, 12);
    assert.equal(payload?.diagnostics?.tenorPolicy?.venueRequestedTenorDays, 12);
    assert.equal(payload?.diagnostics?.tenorPolicy?.fallbackApplied, true);
    assert.equal(payload?.diagnostics?.tenorPolicy?.fallbackReason, "degraded_policy_allow_requested_candidate");
  } finally {
    await harness.close();
  }
});

test("V) quote maps no_top_of_book to 503 liquidity-unavailable reason", async () => {
  const originalFetch = global.fetch;
  try {
    const now = Date.now();
    const optionExpiry = new Date(now + 5 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
    const futureExpiry = new Date(now + 6 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
      if (path === "health") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              ok: true,
              session: "connected",
              transport: "ib_socket",
              activeTransport: "ib_socket",
              fallbackEnabled: false,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("contracts/qualify")) {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (payload.kind === "mbt_option") {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                contracts: [
                  {
                    conId: 11111,
                    secType: "FOP",
                    localSymbol: "W5AH6 P55000",
                    expiry: optionExpiry,
                    strike: 55000,
                    right: "P",
                    multiplier: "0.1",
                    minTick: 5
                  }
                ]
              })
          } as any;
        }
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 22222,
                  secType: "FUT",
                  localSymbol: "MBTH6",
                  expiry: futureExpiry,
                  multiplier: "0.1",
                  minTick: 5
                }
              ]
            })
        } as any;
      }
      if (path.startsWith("marketdata/top")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: null,
              ask: null,
              bidSize: null,
              askSize: null,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("marketdata/depth")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ bids: [], asks: [], asOf: new Date().toISOString() })
        } as any;
      }
      if (url.includes("/ticker")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              product_id: "BTC-USD",
              price: 100000,
              timestamp: Date.now()
            })
        } as any;
      }
      return {
        ok: false,
        status: 404,
        text: async () => "not_found"
      } as any;
    }) as typeof fetch;

    const harness = await createPilotHarness({
      venueMode: "ibkr_cme_paper",
      fetchImpl,
      env: {
        IBKR_BRIDGE_BASE_URL: "http://127.0.0.1:18080",
        IBKR_BRIDGE_TIMEOUT_MS: "4000",
        IBKR_ACCOUNT_ID: "DU123456",
        IBKR_ENABLE_EXECUTION: "false",
        IBKR_ORDER_TIMEOUT_MS: "4000",
        IBKR_MAX_REPRICE_STEPS: "3",
        IBKR_REPRICE_STEP_TICKS: "1",
        IBKR_MAX_SLIPPAGE_BPS: "25",
        IBKR_REQUIRE_LIVE_TRANSPORT: "true",
        IBKR_MAX_TENOR_DRIFT_DAYS: "7",
        IBKR_PREFER_TENOR_AT_OR_ABOVE: "true",
        IBKR_ORDER_TIF: "IOC",
        PILOT_VENUE_QUOTE_TIMEOUT_MS: "12000"
      }
    });
    try {
      const quoteRes = await harness.app.inject({
        method: "POST",
        url: "/pilot/protections/quote",
        payload: defaultQuotePayload(1000)
      });
      assert.equal(quoteRes.statusCode, 503, quoteRes.body);
      const payload = quoteRes.json();
      assert.equal(payload.status, "error");
      assert.equal(payload.reason, "quote_liquidity_unavailable");
      assert.match(String(payload.detail || ""), /no_top_of_book/);
    } finally {
      await harness.close();
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test("V2) quote maps no-economical-option diagnostics to economics-unacceptable reason", async () => {
  const originalFetch = global.fetch;
  try {
    const now = Date.now();
    const optionExpiry = new Date(now + 5 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
    const futureExpiry = new Date(now + 6 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
      if (path === "health") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              ok: true,
              session: "connected",
              transport: "ib_socket",
              activeTransport: "ib_socket",
              fallbackEnabled: false,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("contracts/qualify")) {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (payload.kind === "mbt_option") {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                contracts: [
                  {
                    conId: 31111,
                    secType: "FOP",
                    localSymbol: "W5AH6 P50000",
                    expiry: optionExpiry,
                    strike: 50000,
                    right: "P",
                    multiplier: "0.1",
                    minTick: 5
                  }
                ]
              })
          } as any;
        }
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 32222,
                  secType: "FUT",
                  localSymbol: "MBTH6",
                  expiry: futureExpiry,
                  multiplier: "0.1",
                  minTick: 5
                }
              ]
            })
        } as any;
      }
      if (path.startsWith("marketdata/top")) {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (payload.conId === 32222) {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                bid: null,
                ask: null,
                bidSize: null,
                askSize: null,
                asOf: new Date().toISOString()
              })
          } as any;
        }
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 95,
              ask: 96,
              bidSize: 5,
              askSize: 6,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("marketdata/depth")) {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (payload.conId === 32222) {
          return {
            ok: true,
            text: async () => JSON.stringify({ bids: [], asks: [], asOf: new Date().toISOString() })
          } as any;
        }
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bids: [{ level: 0, price: 95, size: 5 }],
              asks: [{ level: 0, price: 96, size: 6 }],
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (url.includes("/ticker")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              product_id: "BTC-USD",
              price: 100000,
              timestamp: Date.now()
            })
        } as any;
      }
      return {
        ok: false,
        status: 404,
        text: async () => "not_found"
      } as any;
    }) as typeof fetch;

    const harness = await createPilotHarness({
      venueMode: "ibkr_cme_paper",
      fetchImpl,
      env: {
        IBKR_BRIDGE_BASE_URL: "http://127.0.0.1:18080",
        IBKR_BRIDGE_TIMEOUT_MS: "4000",
        IBKR_ACCOUNT_ID: "DU123456",
        IBKR_ENABLE_EXECUTION: "false",
        IBKR_ORDER_TIMEOUT_MS: "4000",
        IBKR_MAX_REPRICE_STEPS: "3",
        IBKR_REPRICE_STEP_TICKS: "1",
        IBKR_MAX_SLIPPAGE_BPS: "25",
        IBKR_REQUIRE_LIVE_TRANSPORT: "true",
        IBKR_MAX_TENOR_DRIFT_DAYS: "7",
        IBKR_PREFER_TENOR_AT_OR_ABOVE: "true",
        IBKR_ORDER_TIF: "IOC",
        IBKR_REQUIRE_OPTIONS_NATIVE: "false",
        IBKR_OPTION_LIQUIDITY_SELECTION_ENABLED: "true",
        IBKR_MAX_OPTION_PREMIUM_RATIO: "0.002",
        IBKR_MAX_FUTURES_SYNTHETIC_PREMIUM_RATIO: "2.0",
        PILOT_VENUE_QUOTE_TIMEOUT_MS: "12000"
      }
    });
    try {
      const quoteRes = await harness.app.inject({
        method: "POST",
        url: "/pilot/protections/quote",
        payload: defaultQuotePayload(20000)
      });
      assert.equal(quoteRes.statusCode, 503);
      const payload = quoteRes.json();
      assert.equal(payload.status, "error");
      assert.equal(payload.reason, "quote_economics_unacceptable");
      assert.match(String(payload.detail || ""), /no_economical_option|no_viable_option/);
    } finally {
      await harness.close();
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test("V6) admin metrics include broker balance snapshot when available", async () => {
  const originalFetch = global.fetch;
  try {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
      if (path === "account/summary") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              source: "ibkr_account_summary",
              accountId: "DU555111",
              currency: "USD",
              netLiquidationUsd: "1996.1200000000",
              availableFundsUsd: "1200.5000000000",
              excessLiquidityUsd: "980.7500000000",
              buyingPowerUsd: "2401.0000000000",
              asOf: "2026-03-31T06:00:00.000Z"
            })
        } as any;
      }
      if (path === "health") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              ok: true,
              session: "connected",
              transport: "ib_socket",
              activeTransport: "ib_socket",
              fallbackEnabled: false,
              asOf: "2026-03-31T06:00:00.000Z"
            })
        } as any;
      }
      if (url.includes("/ticker")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              product_id: "BTC-USD",
              price: 100000,
              timestamp: Date.now()
            })
        } as any;
      }
      return {
        ok: true,
        text: async () => JSON.stringify({})
      } as any;
    }) as typeof fetch;

    const harness = await createPilotHarness({
      venueMode: "ibkr_cme_paper",
      fetchImpl,
      env: {
        IBKR_BRIDGE_BASE_URL: "http://127.0.0.1:18080",
        IBKR_BRIDGE_TIMEOUT_MS: "2500",
        IBKR_ACCOUNT_ID: "DU555111"
      }
    });
    try {
      const res = await harness.app.inject({
        method: "GET",
        url: "/pilot/admin/metrics?scope=all",
        headers: { "x-admin-token": "admin-local" }
      });
      assert.equal(res.statusCode, 200);
      const payload = res.json();
      assert.equal(payload.status, "ok");
      assert.equal(payload.scope, "all");
      assert.equal(payload.brokerBalanceSnapshot?.source, "ibkr_account_summary");
      assert.equal(payload.brokerBalanceSnapshot?.readOnly, true);
      assert.equal(payload.brokerBalanceSnapshot?.accountId, "DU555111");
      assert.equal(payload.brokerBalanceSnapshot?.currency, "USD");
      assert.equal(payload.brokerBalanceSnapshot?.availableFundsUsd, "1200.5000000000");
      assert.equal(payload.brokerBalanceSnapshot?.netLiquidationUsd, "1996.1200000000");
    } finally {
      await harness.close();
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test("W) quote diagnostics include explicit tenorReason attribution", async () => {
  const originalFetch = global.fetch;
  try {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
      if (path === "health") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              ok: true,
              session: "connected",
              transport: "ib_socket",
              activeTransport: "ib_socket",
              fallbackEnabled: false,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("contracts/qualify")) {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (payload.kind === "mbt_option") {
          return {
            ok: true,
            text: async () => JSON.stringify({ contracts: [] })
          } as any;
        }
        if (payload.kind === "mbt_future" && payload.productFamily === "MBT") {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                contracts: [
                  {
                    conId: 33331,
                    secType: "FUT",
                    localSymbol: "MBTH6",
                    expiry: "20260331",
                    multiplier: "0.1",
                    minTick: 5
                  }
                ]
              })
          } as any;
        }
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 22222,
                  secType: "FUT",
                  localSymbol: "MBTH6",
                  expiry: "20260331",
                  multiplier: "0.1",
                  minTick: 5
                }
              ]
            })
        } as any;
      }
      if (path.startsWith("marketdata/top")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: null,
              ask: null,
              bidSize: null,
              askSize: null,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("marketdata/depth")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bids: [{ level: 0, price: 95, size: 4 }],
              asks: [{ level: 0, price: 96, size: 6 }],
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (url.includes("/ticker")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              product_id: "BTC-USD",
              price: 100000,
              timestamp: Date.now()
            })
        } as any;
      }
      return {
        ok: false,
        status: 404,
        text: async () => "not_found"
      } as any;
    }) as typeof fetch;

    const harness = await createPilotHarness({
      venueMode: "ibkr_cme_paper",
      fetchImpl,
      env: {
        IBKR_BRIDGE_BASE_URL: "http://127.0.0.1:18080",
        IBKR_BRIDGE_TIMEOUT_MS: "6000",
        IBKR_ACCOUNT_ID: "DU123456",
        IBKR_ENABLE_EXECUTION: "false",
        IBKR_ORDER_TIMEOUT_MS: "6000",
        IBKR_MAX_REPRICE_STEPS: "3",
        IBKR_REPRICE_STEP_TICKS: "1",
        IBKR_MAX_SLIPPAGE_BPS: "25",
        IBKR_REQUIRE_LIVE_TRANSPORT: "true",
        IBKR_MAX_TENOR_DRIFT_DAYS: "40",
        IBKR_PREFER_TENOR_AT_OR_ABOVE: "true",
        IBKR_ORDER_TIF: "IOC",
        IBKR_REQUIRE_OPTIONS_NATIVE: "false",
        IBKR_MAX_FUTURES_SYNTHETIC_PREMIUM_RATIO: "2",
        PILOT_VENUE_QUOTE_TIMEOUT_MS: "12000"
      }
    });
    try {
      const quoteRes = await harness.app.inject({
        method: "POST",
        url: "/pilot/protections/quote",
        payload: defaultQuotePayload(1000)
      });
      assert.equal(quoteRes.statusCode, 200);
      const payload = quoteRes.json();
      assert.equal(payload.status, "ok");
      assert.equal(
        typeof payload?.diagnostics?.venueSelection?.tenorReason === "string",
        true
      );
      assert.equal(
        typeof payload?.quote?.details?.tenorReason === "string",
        true
      );
      assert.equal(
        ["tenor_exact", "tenor_within_2d", "tenor_fallback_policy", "tenor_fallback_liquidity"].includes(
          String(payload?.diagnostics?.venueSelection?.tenorReason || "")
        ),
        true
      );
    } finally {
      await harness.close();
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test("W3) quote diagnostics expose BFF fallback family and reason when enabled", async () => {
  const originalFetch = global.fetch;
  try {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
      if (path === "health") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              ok: true,
              session: "connected",
              transport: "ib_socket",
              activeTransport: "ib_socket",
              fallbackEnabled: false,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("contracts/qualify")) {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (payload.kind === "mbt_option") {
          return {
            ok: true,
            text: async () => JSON.stringify({ contracts: [] })
          } as any;
        }
        if (payload.kind === "mbt_future" && payload.productFamily === "MBT") {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                contracts: [
                  {
                    conId: 44111,
                    secType: "FUT",
                    localSymbol: "MBTH6",
                    expiry: "20260331",
                    multiplier: "0.1",
                    minTick: 5
                  }
                ]
              })
          } as any;
        }
        if (payload.kind === "mbt_future" && payload.productFamily === "BFF") {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                contracts: [
                  {
                    conId: 55222,
                    secType: "FUT",
                    localSymbol: "BFFH6",
                    expiry: "20260328",
                    multiplier: "0.1",
                    minTick: 5
                  }
                ]
              })
          } as any;
        }
        return { ok: true, text: async () => JSON.stringify({ contracts: [] }) } as any;
      }
      if (path.startsWith("marketdata/top")) {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (payload.conId === 44111) {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                bid: null,
                ask: null,
                bidSize: null,
                askSize: null,
                asOf: new Date().toISOString()
              })
          } as any;
        }
        if (payload.conId === 55222) {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                bid: 88,
                ask: 89,
                bidSize: 3,
                askSize: 5,
                asOf: new Date().toISOString()
              })
          } as any;
        }
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: null,
              ask: null,
              bidSize: null,
              askSize: null,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("marketdata/depth")) {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (payload.conId === 44111) {
          return {
            ok: true,
            text: async () => JSON.stringify({ bids: [], asks: [], asOf: new Date().toISOString() })
          } as any;
        }
        if (payload.conId === 55222) {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                bids: [{ level: 0, price: 88, size: 3 }],
                asks: [{ level: 0, price: 89, size: 5 }],
                asOf: new Date().toISOString()
              })
          } as any;
        }
        return {
          ok: true,
          text: async () => JSON.stringify({ bids: [], asks: [], asOf: new Date().toISOString() })
        } as any;
      }
      if (url.includes("/ticker")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              product_id: "BTC-USD",
              price: 100000,
              timestamp: Date.now()
            })
        } as any;
      }
      return {
        ok: false,
        status: 404,
        text: async () => "not_found"
      } as any;
    }) as typeof fetch;

    const harness = await createPilotHarness({
      venueMode: "ibkr_cme_paper",
      fetchImpl,
      env: {
        IBKR_BRIDGE_BASE_URL: "http://127.0.0.1:18080",
        IBKR_BRIDGE_TIMEOUT_MS: "6000",
        IBKR_ACCOUNT_ID: "DU123456",
        IBKR_ENABLE_EXECUTION: "false",
        IBKR_ORDER_TIMEOUT_MS: "6000",
        IBKR_MAX_REPRICE_STEPS: "3",
        IBKR_REPRICE_STEP_TICKS: "1",
        IBKR_MAX_SLIPPAGE_BPS: "25",
        IBKR_REQUIRE_LIVE_TRANSPORT: "true",
        IBKR_MAX_TENOR_DRIFT_DAYS: "40",
        IBKR_PREFER_TENOR_AT_OR_ABOVE: "true",
        IBKR_ORDER_TIF: "IOC",
        IBKR_PRIMARY_PRODUCT_FAMILY: "MBT",
        IBKR_BFF_FALLBACK_ENABLED: "true",
        IBKR_BFF_PRODUCT_FAMILY: "BFF",
        IBKR_REQUIRE_OPTIONS_NATIVE: "false",
        IBKR_MAX_FUTURES_SYNTHETIC_PREMIUM_RATIO: "2.0",
        PILOT_VENUE_QUOTE_TIMEOUT_MS: "12000"
      }
    });
    try {
      const quoteRes = await harness.app.inject({
        method: "POST",
        url: "/pilot/protections/quote",
        payload: defaultQuotePayload(1000)
      });
      assert.equal(quoteRes.statusCode, 200);
      const payload = quoteRes.json();
      assert.equal(payload.status, "ok");
      assert.equal(String(payload?.quote?.details?.hedgeInstrumentFamily), "BFF");
      assert.equal(
        String(payload?.quote?.details?.selectionReason),
        "options_and_mbt_unavailable_bff_fallback"
      );
      assert.equal(String(payload?.diagnostics?.venueSelection?.hedgeInstrumentFamily), "BFF");
      assert.equal(
        String(payload?.diagnostics?.venueSelection?.selectionReason),
        "options_and_mbt_unavailable_bff_fallback"
      );
    } finally {
      await harness.close();
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test("W2) health reports degraded when IBKR transport is not live socket", async () => {
  const originalFetch = global.fetch;
  try {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
      if (path === "health") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              ok: true,
              session: "connected",
              transport: "http",
              activeTransport: "http",
              fallbackEnabled: true,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (url.includes("/ticker")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              product_id: "BTC-USD",
              price: 100000,
              timestamp: Date.now()
            })
        } as any;
      }
      return {
        ok: false,
        status: 404,
        text: async () => "not_found"
      } as any;
    }) as typeof fetch;
    const harness = await createPilotHarness({
      venueMode: "ibkr_cme_paper",
      fetchImpl,
      env: {
        IBKR_BRIDGE_BASE_URL: "http://127.0.0.1:18080",
        IBKR_BRIDGE_TIMEOUT_MS: "4000",
        IBKR_ACCOUNT_ID: "DU123456",
        IBKR_ENABLE_EXECUTION: "false",
        IBKR_ORDER_TIMEOUT_MS: "4000",
        IBKR_MAX_REPRICE_STEPS: "3",
        IBKR_REPRICE_STEP_TICKS: "1",
        IBKR_MAX_SLIPPAGE_BPS: "25",
        IBKR_REQUIRE_LIVE_TRANSPORT: "true",
        IBKR_MAX_TENOR_DRIFT_DAYS: "7",
        IBKR_PREFER_TENOR_AT_OR_ABOVE: "true",
        IBKR_ORDER_TIF: "IOC"
      }
    });
    try {
      const healthRes = await harness.app.inject({
        method: "GET",
        url: "/pilot/health"
      });
      assert.equal(healthRes.statusCode, 503);
      const payload = healthRes.json();
      assert.equal(payload.status, "degraded");
      assert.equal(String(payload?.checks?.venue?.activeTransport || ""), "http");
    } finally {
      await harness.close();
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test("O) monitor/detail/proof routes are tenant scoped", async () => {
  const harnessA = await createPilotHarness({ env: { PILOT_TENANT_SCOPE_ID: "tenant-a" } });
  const harnessB = await createPilotHarness({ env: { PILOT_TENANT_SCOPE_ID: "tenant-b" } });
  try {
    const { app: appA } = harnessA;
    const { app: appB } = harnessB;
    const { protectionId } = await quoteAndActivate(appA, 1000);

    const detail = await appB.inject({
      method: "GET",
      url: `/pilot/protections/${protectionId}`
    });
    assert.equal(detail.statusCode, 404);

    const monitor = await appB.inject({
      method: "GET",
      url: `/pilot/protections/${protectionId}/monitor`
    });
    assert.equal(monitor.statusCode, 404);

    const proof = await appB.inject({
      method: "GET",
      url: `/pilot/protections/${protectionId}/proof`,
      headers: { "x-proof-token": "proof-local" }
    });
    assert.equal(proof.statusCode, 404);
  } finally {
    await harnessA.close();
    await harnessB.close();
  }
});

test("P) own proof route works with proof token", async () => {
  const harness = await createPilotHarness();
  try {
    const { app } = harness;
    const { protectionId } = await quoteAndActivate(app, 1000);
    const proof = await app.inject({
      method: "GET",
      url: `/pilot/protections/${protectionId}/proof`,
      headers: { "x-proof-token": "proof-local" }
    });
    assert.equal(proof.statusCode, 200);
    assert.equal(proof.json().status, "ok");
  } finally {
    await harness.close();
  }
});

test("X) options-required errors map to explicit quote_options_required reason", async () => {
  const originalFetch = global.fetch;
  try {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
      if (path === "health") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              ok: true,
              session: "connected",
              transport: "ib_socket",
              activeTransport: "ib_socket",
              fallbackEnabled: false,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("contracts/qualify")) {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (payload.kind === "mbt_option") {
          return {
            ok: true,
            text: async () => JSON.stringify({ contracts: [] })
          } as any;
        }
        if (payload.kind === "mbt_future") {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                contracts: [
                  {
                    conId: 77881,
                    secType: "FUT",
                    localSymbol: "MBTH6",
                    expiry: "20260331",
                    multiplier: "0.1",
                    minTick: 5
                  }
                ]
              })
          } as any;
        }
      }
      if (path.startsWith("marketdata/top")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 90,
              ask: 91,
              bidSize: 2,
              askSize: 3,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("marketdata/depth")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ bids: [], asks: [], asOf: new Date().toISOString() })
        } as any;
      }
      if (url.includes("/ticker")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              product_id: "BTC-USD",
              price: 100000,
              timestamp: Date.now()
            })
        } as any;
      }
      return { ok: false, status: 404, text: async () => "not_found" } as any;
    }) as typeof fetch;
    const harness = await createPilotHarness({
      venueMode: "ibkr_cme_paper",
      fetchImpl,
      env: {
        IBKR_BRIDGE_BASE_URL: "http://127.0.0.1:18080",
        IBKR_BRIDGE_TIMEOUT_MS: "6000",
        IBKR_ACCOUNT_ID: "DU123456",
        IBKR_ENABLE_EXECUTION: "false",
        IBKR_ORDER_TIMEOUT_MS: "6000",
        IBKR_MAX_REPRICE_STEPS: "3",
        IBKR_REPRICE_STEP_TICKS: "1",
        IBKR_MAX_SLIPPAGE_BPS: "25",
        IBKR_REQUIRE_LIVE_TRANSPORT: "true",
        IBKR_MAX_TENOR_DRIFT_DAYS: "40",
        IBKR_PREFER_TENOR_AT_OR_ABOVE: "true",
        IBKR_ORDER_TIF: "IOC",
        IBKR_REQUIRE_OPTIONS_NATIVE: "true",
        PILOT_VENUE_QUOTE_TIMEOUT_MS: "12000"
      }
    });
    try {
      const quoteRes = await harness.app.inject({
        method: "POST",
        url: "/pilot/protections/quote",
        payload: defaultQuotePayload(1000)
      });
      assert.equal(quoteRes.statusCode, 503);
      const payload = quoteRes.json();
      assert.equal(payload.status, "error");
      assert.equal(payload.reason, "quote_options_required");
      assert.match(String(payload.detail || ""), /options_required/);
    } finally {
      await harness.close();
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test("Y) selector diagnostics endpoint requires admin and returns quote-stage counters", async () => {
  const originalFetch = global.fetch;
  try {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
      if (path === "health") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              ok: true,
              session: "connected",
              transport: "ib_socket",
              activeTransport: "ib_socket",
              fallbackEnabled: false,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("contracts/qualify")) {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (payload.kind === "mbt_option") {
          return {
            ok: true,
            text: async () => JSON.stringify({ contracts: [] })
          } as any;
        }
        if (payload.kind === "mbt_future") {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                contracts: [
                  {
                    conId: 88111,
                    secType: "FUT",
                    localSymbol: "MBTH6",
                    expiry: "20260331",
                    multiplier: "0.1",
                    minTick: 5
                  }
                ]
              })
          } as any;
        }
      }
      if (path.startsWith("marketdata/top")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 100,
              ask: 101,
              bidSize: 2,
              askSize: 2,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("marketdata/depth")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ bids: [], asks: [], asOf: new Date().toISOString() })
        } as any;
      }
      if (url.includes("/ticker")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              product_id: "BTC-USD",
              price: 100000,
              timestamp: Date.now()
            })
        } as any;
      }
      return { ok: false, status: 404, text: async () => "not_found" } as any;
    }) as typeof fetch;
    const harness = await createPilotHarness({
      venueMode: "ibkr_cme_paper",
      fetchImpl,
      env: {
        IBKR_BRIDGE_BASE_URL: "http://127.0.0.1:18080",
        IBKR_BRIDGE_TIMEOUT_MS: "6000",
        IBKR_ACCOUNT_ID: "DU123456",
        IBKR_ENABLE_EXECUTION: "false",
        IBKR_ORDER_TIMEOUT_MS: "6000",
        IBKR_MAX_REPRICE_STEPS: "3",
        IBKR_REPRICE_STEP_TICKS: "1",
        IBKR_MAX_SLIPPAGE_BPS: "25",
        IBKR_REQUIRE_LIVE_TRANSPORT: "true",
        IBKR_MAX_TENOR_DRIFT_DAYS: "40",
        IBKR_PREFER_TENOR_AT_OR_ABOVE: "true",
        IBKR_ORDER_TIF: "IOC",
        IBKR_REQUIRE_OPTIONS_NATIVE: "false",
        IBKR_MAX_FUTURES_SYNTHETIC_PREMIUM_RATIO: "2.0",
        PILOT_VENUE_QUOTE_TIMEOUT_MS: "12000"
      }
    });
    try {
      const unauthorized = await harness.app.inject({
        method: "GET",
        url: "/pilot/admin/diagnostics/selector"
      });
      assert.equal(unauthorized.statusCode, 401);

      const quoteRes = await harness.app.inject({
        method: "POST",
        url: "/pilot/protections/quote",
        payload: defaultQuotePayload(1000)
      });
      assert.equal(quoteRes.statusCode, 200);

      const diagnosticsRes = await harness.app.inject({
        method: "GET",
        url: "/pilot/admin/diagnostics/selector",
        headers: { "x-admin-token": "admin-local", "x-forwarded-for": "127.0.0.1" }
      });
      assert.equal(diagnosticsRes.statusCode, 200);
      const diagnosticsPayload = diagnosticsRes.json();
      assert.equal(diagnosticsPayload.status, "ok");
      assert.equal(typeof diagnosticsPayload.diagnostics?.asOf === "string", true);
      assert.equal(typeof diagnosticsPayload.diagnostics?.counters?.qualifyCalls === "number", true);
      assert.equal(typeof diagnosticsPayload.diagnostics?.timingsMs?.total === "number", true);
      assert.equal(
        typeof diagnosticsPayload.diagnostics?.optionCandidateFailureCounts?.nTotalCandidates === "number",
        true
      );
      assert.equal(typeof diagnosticsPayload.diagnostics?.counters?.qualifyCacheHits === "number", true);
    } finally {
      await harness.close();
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test("Y2) quote enforces configurable minimum notional floor", async () => {
  const harness = await createPilotHarness({
    env: {
      PILOT_QUOTE_MIN_NOTIONAL_USDC: "1000"
    }
  });
  try {
    const belowMin = await harness.app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: defaultQuotePayload(900)
    });
    assert.equal(belowMin.statusCode, 400);
    const belowMinPayload = belowMin.json();
    assert.equal(belowMinPayload.status, "error");
    assert.equal(belowMinPayload.reason, "quote_min_notional_not_met");
    assert.equal(Number(belowMinPayload.minQuoteNotionalUsdc), 1000);

    const atMin = await harness.app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: defaultQuotePayload(1000)
    });
    assert.equal(atMin.statusCode, 200);
    const atMinPayload = atMin.json();
    assert.equal(atMinPayload.status, "ok");
    assert.equal(Number(atMinPayload?.limits?.minQuoteNotionalUsdc || 0), 1000);
  } finally {
    await harness.close();
  }
});

test("Y3) selector diagnostics include extended candidate failure counters", async () => {
  const originalFetch = global.fetch;
  try {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
      if (path === "health") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              ok: true,
              session: "connected",
              transport: "ib_socket",
              activeTransport: "ib_socket",
              fallbackEnabled: false,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("contracts/qualify")) {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (payload.kind === "mbt_option") {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                contracts: [
                  {
                    conId: 91111,
                    secType: "FOP",
                    localSymbol: "W5AH6 P60000",
                    expiry: "20260330",
                    strike: 60000,
                    right: "P",
                    multiplier: "0.1",
                    minTick: 5
                  }
                ]
              })
          } as any;
        }
        if (payload.kind === "mbt_future") {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                contracts: [
                  {
                    conId: 92222,
                    secType: "FUT",
                    localSymbol: "MBTH6",
                    expiry: "20260331",
                    multiplier: "0.1",
                    minTick: 5
                  }
                ]
              })
          } as any;
        }
      }
      if (path.startsWith("marketdata/top")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 10,
              ask: 20,
              bidSize: 0.1,
              askSize: 0.2,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("marketdata/depth")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bids: [{ level: 0, price: 10, size: 0.1 }],
              asks: [{ level: 0, price: 20, size: 0.2 }],
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (url.includes("/ticker")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              product_id: "BTC-USD",
              price: 100000,
              timestamp: Date.now()
            })
        } as any;
      }
      return { ok: false, status: 404, text: async () => "not_found" } as any;
    }) as typeof fetch;
    const harness = await createPilotHarness({
      venueMode: "ibkr_cme_paper",
      fetchImpl,
      env: {
        IBKR_BRIDGE_BASE_URL: "http://127.0.0.1:18080",
        IBKR_BRIDGE_TIMEOUT_MS: "6000",
        IBKR_ACCOUNT_ID: "DU123456",
        IBKR_ENABLE_EXECUTION: "false",
        IBKR_ORDER_TIMEOUT_MS: "6000",
        IBKR_MAX_REPRICE_STEPS: "3",
        IBKR_REPRICE_STEP_TICKS: "1",
        IBKR_MAX_SLIPPAGE_BPS: "25",
        IBKR_REQUIRE_LIVE_TRANSPORT: "true",
        IBKR_MAX_TENOR_DRIFT_DAYS: "40",
        IBKR_PREFER_TENOR_AT_OR_ABOVE: "true",
        IBKR_ORDER_TIF: "IOC",
        IBKR_REQUIRE_OPTIONS_NATIVE: "true",
        IBKR_OPTION_LIQUIDITY_SELECTION_ENABLED: "true",
        IBKR_MAX_OPTION_PREMIUM_RATIO: "0.05",
        PILOT_VENUE_QUOTE_TIMEOUT_MS: "12000"
      }
    });
    try {
      const quoteRes = await harness.app.inject({
        method: "POST",
        url: "/pilot/protections/quote",
        payload: defaultQuotePayload(1000)
      });
      assert.equal(quoteRes.statusCode === 503 || quoteRes.statusCode === 409, true);

      const diagnosticsRes = await harness.app.inject({
        method: "GET",
        url: "/pilot/admin/diagnostics/selector",
        headers: { "x-admin-token": "admin-local", "x-forwarded-for": "127.0.0.1" }
      });
      assert.equal(diagnosticsRes.statusCode, 200);
      const diagnosticsPayload = diagnosticsRes.json();
      assert.equal(diagnosticsPayload.status, "ok");
      assert.equal(
        typeof diagnosticsPayload.diagnostics?.optionCandidateFailureCounts?.nFailedWideSpread === "number",
        true
      );
      assert.equal(
        typeof diagnosticsPayload.diagnostics?.optionCandidateFailureCounts?.nFailedThinDepth === "number",
        true
      );
      assert.equal(
        typeof diagnosticsPayload.diagnostics?.optionCandidateFailureCounts?.nFailedStaleTop === "number",
        true
      );
    } finally {
      await harness.close();
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test("Y4) quote premium policy in pass-through mode includes broker fees for IBKR", async () => {
  const originalFetch = global.fetch;
  try {
    const now = Date.now();
    const futureExpiry = new Date(now + 6 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
      if (path === "health") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              ok: true,
              session: "connected",
              transport: "ib_socket",
              activeTransport: "ib_socket",
              fallbackEnabled: false,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("contracts/qualify")) {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (payload.kind === "mbt_option") {
          return { ok: true, text: async () => JSON.stringify({ contracts: [] }) } as any;
        }
        if (payload.kind === "mbt_future") {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                contracts: [
                  {
                    conId: 93333,
                    secType: "FUT",
                    localSymbol: "MBTH6",
                    expiry: futureExpiry,
                    multiplier: "0.1",
                    minTick: 5
                  }
                ]
              })
          } as any;
        }
      }
      if (path.startsWith("marketdata/top")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 95,
              ask: 96,
              bidSize: 4,
              askSize: 5,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("marketdata/depth")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bids: [{ level: 0, price: 95, size: 4 }],
              asks: [{ level: 0, price: 96, size: 5 }],
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (url.includes("/ticker")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              product_id: "BTC-USD",
              price: 100000,
              timestamp: Date.now()
            })
        } as any;
      }
      return { ok: false, status: 404, text: async () => "not_found" } as any;
    }) as typeof fetch;
    const harness = await createPilotHarness({
      venueMode: "ibkr_cme_paper",
      fetchImpl,
      env: {
        PILOT_PREMIUM_POLICY_MODE: "pass_through_markup",
        PILOT_PREMIUM_MARKUP_PCT_BRONZE: "0.1",
        IBKR_FEE_PER_CONTRACT_USD: "2.02",
        IBKR_FEE_PER_ORDER_USD: "0",
        IBKR_BRIDGE_BASE_URL: "http://127.0.0.1:18080",
        IBKR_BRIDGE_TIMEOUT_MS: "4000",
        IBKR_ACCOUNT_ID: "DU123456",
        IBKR_ENABLE_EXECUTION: "false",
        IBKR_ORDER_TIMEOUT_MS: "4000",
        IBKR_MAX_REPRICE_STEPS: "3",
        IBKR_REPRICE_STEP_TICKS: "1",
        IBKR_MAX_SLIPPAGE_BPS: "25",
        IBKR_REQUIRE_LIVE_TRANSPORT: "true",
        IBKR_MAX_TENOR_DRIFT_DAYS: "7",
        IBKR_PREFER_TENOR_AT_OR_ABOVE: "true",
        IBKR_ORDER_TIF: "IOC",
        IBKR_REQUIRE_OPTIONS_NATIVE: "false",
        IBKR_OPTION_LIQUIDITY_SELECTION_ENABLED: "true",
        IBKR_MAX_OPTION_PREMIUM_RATIO: "0.2",
        IBKR_MAX_FUTURES_SYNTHETIC_PREMIUM_RATIO: "2.0",
        PILOT_VENUE_QUOTE_TIMEOUT_MS: "12000"
      }
    });
    try {
      const quoteRes = await harness.app.inject({
        method: "POST",
        url: "/pilot/protections/quote",
        payload: defaultQuotePayload(1000)
      });
      assert.equal(quoteRes.statusCode, 200, quoteRes.body);
      const payload = quoteRes.json();
      assert.equal(payload.status, "ok");
      assert.equal(String(payload.quote?.venue || ""), "ibkr_cme_paper");
      const estimated = payload?.diagnostics?.premiumPolicy?.estimated || {};
      const hedge = Number(estimated.hedgeCostUsd ?? 0);
      const broker = Number(estimated.brokerFeesUsd ?? 0);
      const passThrough = Number(estimated.passThroughUsd ?? 0);
      const clientPremium = Number(estimated.clientPremiumUsd ?? 0);
      assert.equal(Number.isFinite(hedge), true);
      assert.equal(Number.isFinite(broker), true);
      assert.equal(Number.isFinite(passThrough), true);
      assert.equal(Number.isFinite(clientPremium), true);
      assert.equal(broker > 0, true);
      assert.ok(Math.abs(passThrough - (hedge + broker)) < 1e-9);
      assert.equal(clientPremium >= passThrough, true);
      const breakdown = payload?.quote?.details?.pricingBreakdown || {};
      assert.equal(Number.isFinite(Number(breakdown.expectedTriggerCostUsd ?? NaN)), true);
      assert.equal(Number.isFinite(Number(breakdown.premiumProfitabilityTargetUsd ?? NaN)), true);
      assert.equal(Number.isFinite(Number(breakdown.triggerPayoutCreditUsd ?? NaN)), true);
      const profitabilityTarget = Number(breakdown.premiumProfitabilityTargetUsd ?? 0);
      assert.equal(clientPremium >= profitabilityTarget || !Number.isFinite(profitabilityTarget), true);
    } finally {
      await harness.close();
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test("Y4b) quote supports hybrid pricing mode and reports mode diagnostics", async () => {
  const harness = await createPilotHarness({
    env: {
      PILOT_PREMIUM_PRICING_MODE: "hybrid_otm_treasury",
      PILOT_PREMIUM_POLICY_MODE: "pass_through_markup",
      PILOT_PREMIUM_MARKUP_PCT_BRONZE: "0.06"
    }
  });
  try {
    const quoteRes = await harness.app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: defaultQuotePayload(5000)
    });
    assert.equal(quoteRes.statusCode, 200, quoteRes.body);
    const payload = quoteRes.json();
    assert.equal(payload.status, "ok");
    const breakdown = payload?.quote?.details?.pricingBreakdown || {};
    assert.equal(String(breakdown.pricingMode || ""), "hybrid_otm_treasury");
    assert.equal(
      String(payload?.diagnostics?.premiumPolicy?.mode || "") === "pass_through_markup" ||
        String(payload?.diagnostics?.premiumPolicy?.mode || "") === "legacy",
      true
    );
    assert.equal(Number.isFinite(Number(breakdown.clientPremiumUsd ?? NaN)), true);
  } finally {
    await harness.close();
  }
});

test("Y4c) quote rejects when per-quote treasury subsidy cap is exceeded", async () => {
  const harness = await createPilotHarness({
    env: {
      PILOT_PREMIUM_PRICING_MODE: "hybrid_otm_treasury",
      PILOT_TREASURY_SUBSIDY_CAP_PCT: "0.01",
      PILOT_TREASURY_STRICT_FALLBACK_ENABLED: "false"
    }
  });
  try {
    const quoteRes = await harness.app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: defaultQuotePayload(5000)
    });
    assert.equal(quoteRes.statusCode, 409, quoteRes.body);
    const payload = quoteRes.json();
    assert.equal(payload.status, "error");
    assert.equal(payload.reason, "treasury_subsidy_per_quote_cap_exceeded");
    assert.equal(Number.isFinite(Number(payload.quoteSubsidyUsd ?? NaN)), true);
    assert.equal(Number.isFinite(Number(payload.subsidyCapUsd ?? NaN)), true);
  } finally {
    await harness.close();
  }
});

test("Y4d) quote rejects when daily treasury subsidy cap is exceeded", async () => {
  const harness = await createPilotHarness({
    env: {
      PILOT_PREMIUM_PRICING_MODE: "hybrid_otm_treasury",
      PILOT_TREASURY_SUBSIDY_CAP_PCT: "1.0",
      PILOT_TREASURY_DAILY_SUBSIDY_CAP_USDC: "1",
      PILOT_TREASURY_STRICT_FALLBACK_ENABLED: "false"
    }
  });
  try {
    const quoteRes = await harness.app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: defaultQuotePayload(5000)
    });
    assert.equal(quoteRes.statusCode, 409, quoteRes.body);
    const payload = quoteRes.json();
    assert.equal(payload.status, "error");
    assert.equal(payload.reason, "treasury_subsidy_daily_cap_exceeded");
    assert.equal(Number.isFinite(Number(payload.subsidyUsedUsd ?? NaN)), true);
    assert.equal(Number.isFinite(Number(payload.subsidyProjectedUsd ?? NaN)), true);
    assert.equal(Number.isFinite(Number(payload.subsidyCapUsd ?? NaN)), true);
  } finally {
    await harness.close();
  }
});

test("Y4e) quote falls back to strict pricing mode when treasury rails trip", async () => {
  const harness = await createPilotHarness({
    env: {
      PILOT_PREMIUM_PRICING_MODE: "hybrid_otm_treasury",
      PILOT_TREASURY_SUBSIDY_CAP_PCT: "0.01",
      PILOT_TREASURY_STRICT_FALLBACK_ENABLED: "true"
    }
  });
  try {
    const quoteRes = await harness.app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: defaultQuotePayload(5000)
    });
    assert.equal(quoteRes.statusCode, 200, quoteRes.body);
    const payload = quoteRes.json();
    const breakdown = payload?.quote?.details?.pricingBreakdown || {};
    assert.equal(String(breakdown.pricingMode || ""), "actuarial_strict");
    assert.equal(String(breakdown.treasuryFallbackApplied || ""), "per_quote_cap");
    assert.equal(Number.isFinite(Number(breakdown.treasuryQuoteSubsidyUsd ?? NaN)), true);
    assert.equal(Number.isFinite(Number(breakdown.treasuryPerQuoteSubsidyCapUsd ?? NaN)), true);
  } finally {
    await harness.close();
  }
});

test("Y5) quote strictTenor maps drifted options to tenor_drift_exceeded", async () => {
  const originalFetch = global.fetch;
  try {
    const now = Date.now();
    const driftedExpiry = new Date(now + 6 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
      if (path === "health") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              ok: true,
              session: "connected",
              transport: "ib_socket",
              activeTransport: "ib_socket",
              fallbackEnabled: false,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("contracts/qualify")) {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (payload.kind === "mbt_option") {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                contracts: [
                  {
                    conId: 95551,
                    secType: "FOP",
                    localSymbol: "W5AH6 P55000",
                    expiry: driftedExpiry,
                    strike: 55000,
                    right: "P",
                    multiplier: "0.1",
                    minTick: 5
                  }
                ]
              })
          } as any;
        }
        return { ok: true, text: async () => JSON.stringify({ contracts: [] }) } as any;
      }
      if (path.startsWith("marketdata/top")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 94,
              ask: 95,
              bidSize: 4,
              askSize: 5,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("marketdata/depth")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bids: [{ level: 0, price: 94, size: 4 }],
              asks: [{ level: 0, price: 95, size: 5 }],
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (url.includes("/ticker")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              product_id: "BTC-USD",
              price: 100000,
              timestamp: Date.now()
            })
        } as any;
      }
      return { ok: false, status: 404, text: async () => "not_found" } as any;
    }) as typeof fetch;
    const harness = await createPilotHarness({
      venueMode: "ibkr_cme_paper",
      fetchImpl,
      env: {
        PILOT_HEDGE_POLICY: "options_only_native",
        IBKR_BRIDGE_BASE_URL: "http://127.0.0.1:18080",
        IBKR_BRIDGE_TIMEOUT_MS: "4000",
        IBKR_ACCOUNT_ID: "DU123456",
        IBKR_ENABLE_EXECUTION: "false",
        IBKR_ORDER_TIMEOUT_MS: "4000",
        IBKR_MAX_REPRICE_STEPS: "3",
        IBKR_REPRICE_STEP_TICKS: "1",
        IBKR_MAX_SLIPPAGE_BPS: "25",
        IBKR_REQUIRE_LIVE_TRANSPORT: "true",
        IBKR_MAX_TENOR_DRIFT_DAYS: "7",
        IBKR_PREFER_TENOR_AT_OR_ABOVE: "true",
        IBKR_ORDER_TIF: "IOC",
        IBKR_REQUIRE_OPTIONS_NATIVE: "true",
        IBKR_OPTION_LIQUIDITY_SELECTION_ENABLED: "true",
        IBKR_OPTION_LIQUIDITY_TENOR_WINDOW_DAYS: "3",
        IBKR_MAX_OPTION_PREMIUM_RATIO: "0.5",
        PILOT_VENUE_QUOTE_TIMEOUT_MS: "12000"
      }
    });
    try {
      const strictRes = await harness.app.inject({
        method: "POST",
        url: "/pilot/protections/quote",
        payload: {
          ...defaultQuotePayload(1000),
          tenorDays: 3,
          strictTenor: true
        }
      });
      assert.equal(strictRes.statusCode, 409, strictRes.body);
      const strictPayload = strictRes.json();
      assert.equal(strictPayload.status, "error");
      assert.equal(strictPayload.reason, "tenor_drift_exceeded");
    } finally {
      await harness.close();
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test("Z2) sim open/list/trigger lifecycle credits treasury for protected breach", async () => {
  const harness = await createPilotHarness({
    venueMode: "deribit_test",
    env: {
      PILOT_ENFORCE_WINDOW: "false",
      PILOT_PREMIUM_PRICING_MODE: "hybrid_otm_treasury",
      PILOT_SELECTOR_MODE: "hybrid_treasury"
    },
    deribit: {
      async getIndexPrice() {
        return { result: { index_price: 100000 } };
      },
      async listInstruments() {
        return {
          result: [
            {
              instrument_name: "BTC-10APR26-80000-P",
              option_type: "put",
              strike: 80000,
              expiration_timestamp: Date.now() + 7 * 86400000
            }
          ]
        };
      },
      async getOrderBook() {
        return {
          result: {
            asks: [[0.01, 5]],
            bids: [[0.009, 5]],
            mark_price: 0.0095
          }
        };
      },
      async placeOrder() {
        return {
          status: "filled",
          id: "sim-order-1",
          fillPrice: 0.01,
          filledAmount: 0.05,
          amount: 0.05
        };
      }
    } as any
  });
  try {
    const { app } = harness;
    const quoteRes = await app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: defaultQuotePayload(5000)
    });
    assert.equal(quoteRes.statusCode, 200, quoteRes.body);
    const quoteId = String(quoteRes.json().quote?.quoteId || "");
    assert.ok(quoteId.length > 0);

    const simOpen = await app.inject({
      method: "POST",
      url: "/pilot/sim/positions/open",
      payload: {
        protectedNotional: 5000,
        tierName: "Pro (Bronze)",
        drawdownFloorPct: 0.2,
        side: "long",
        marketId: "BTC-USD",
        withProtection: true,
        quoteId,
        tenorDays: 7
      }
    });
    assert.equal(simOpen.statusCode, 200, simOpen.body);
    const simOpenPayload = simOpen.json();
    assert.equal(simOpenPayload.status, "ok");
    const simPositionId = String(simOpenPayload.simPosition?.id || "");
    assert.ok(simPositionId.length > 0);
    assert.equal(simOpenPayload.simPosition.protectionEnabled, true);
    assert.equal(Number(simOpenPayload.simPosition.protectedLossUsd), 1000);

    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/ticker")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              product_id: "BTC-USD",
              price: 79000,
              timestamp: Date.now()
            })
        } as any;
      }
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            product_id: "BTC-USD",
            price: 79000,
            timestamp: Date.now()
          })
      } as any;
    }) as typeof fetch;

    const runTrigger = await app.inject({
      method: "POST",
      url: "/pilot/internal/sim/trigger-monitor/run",
      headers: {
        "x-internal-token": "internal-local"
      },
      payload: { maxRows: 50 }
    });
    assert.equal(runTrigger.statusCode, 200, runTrigger.body);
    const triggerPayload = runTrigger.json();
    assert.equal(triggerPayload.status, "ok");
    assert.equal(Number(triggerPayload.result?.triggered || 0) >= 1, true);

    const simList = await app.inject({
      method: "GET",
      url: "/pilot/sim/positions?limit=20"
    });
    assert.equal(simList.statusCode, 200, simList.body);
    const simListPayload = simList.json();
    const updated = (simListPayload.positions || []).find((item: any) => item.id === simPositionId);
    assert.ok(updated);
    assert.equal(updated.status, "triggered");
    assert.equal(Number(updated.triggerCreditedUsd), 1000);

    const metricsRes = await app.inject({
      method: "GET",
      url: "/pilot/sim/platform/metrics"
    });
    assert.equal(metricsRes.statusCode, 200, metricsRes.body);
    const metricsPayload = metricsRes.json();
    assert.equal(metricsPayload.status, "ok");
    assert.equal(Number(metricsPayload.metrics.premiumCollectedUsd) > 0, true);
    assert.equal(Number(metricsPayload.metrics.triggerCreditPaidUsd), 1000);
    assert.equal(Number(metricsPayload.metrics.triggeredPositions) >= 1, true);
    assert.equal(
      (metricsPayload.recentLedger || []).some((entry: any) => entry.entryType === "trigger_credit"),
      true
    );
  } finally {
    await harness.close();
    global.fetch = originalFetch;
  }
});

test("Z3) sim position close marks closed and stores realized pnl metadata", async () => {
  const harness = await createPilotHarness({
    venueMode: "deribit_test",
    env: {
      PILOT_ENFORCE_WINDOW: "false"
    },
    deribit: {
      async getIndexPrice() {
        return { result: { index_price: 100000 } };
      },
      async listInstruments() {
        return {
          result: [
            {
              instrument_name: "BTC-10APR26-80000-P",
              option_type: "put",
              strike: 80000,
              expiration_timestamp: Date.now() + 7 * 86400000
            }
          ]
        };
      },
      async getOrderBook() {
        return {
          result: {
            asks: [[0.01, 5]],
            bids: [[0.009, 5]],
            mark_price: 0.0095
          }
        };
      },
      async placeOrder() {
        return {
          status: "filled",
          id: "sim-order-2",
          fillPrice: 0.01,
          filledAmount: 0.05,
          amount: 0.05
        };
      }
    } as any
  });
  try {
    const { app } = harness;
    const opened = await app.inject({
      method: "POST",
      url: "/pilot/sim/positions/open",
      payload: {
        protectedNotional: 5000,
        tierName: "Pro (Bronze)",
        drawdownFloorPct: 0.2,
        side: "long",
        marketId: "BTC-USD",
        withProtection: false
      }
    });
    assert.equal(opened.statusCode, 200, opened.body);
    const openPayload = opened.json();
    const simPositionId = String(openPayload.simPosition?.id || "");
    assert.ok(simPositionId.length > 0);

    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/ticker")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              product_id: "BTC-USD",
              price: 105000,
              timestamp: Date.now()
            })
        } as any;
      }
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            product_id: "BTC-USD",
            price: 105000,
            timestamp: Date.now()
          })
      } as any;
    }) as typeof fetch;

    const closeRes = await app.inject({
      method: "POST",
      url: `/pilot/sim/positions/${simPositionId}/close`
    });
    assert.equal(closeRes.statusCode, 200, closeRes.body);
    const closePayload = closeRes.json();
    assert.equal(closePayload.status, "ok");
    assert.equal(closePayload.simPosition.status, "closed");
    const metadata = (closePayload.simPosition.metadata || {}) as Record<string, unknown>;
    assert.equal(Number.isFinite(Number(metadata.closePrice ?? NaN)), true);
    assert.equal(Number.isFinite(Number(metadata.realizedPnlUsd ?? NaN)), true);

    const closeAgain = await app.inject({
      method: "POST",
      url: `/pilot/sim/positions/${simPositionId}/close`
    });
    assert.equal(closeAgain.statusCode, 200, closeAgain.body);
    assert.equal(closeAgain.json().status, "ok");
    assert.equal(closeAgain.json().idempotent, true);
  } finally {
    await harness.close();
    global.fetch = originalFetch;
  }
});

test("Z4) sim account summary returns equity and pnl aggregates", async () => {
  const harness = await createPilotHarness({
    venueMode: "deribit_test",
    env: {
      PILOT_ENFORCE_WINDOW: "false"
    },
    deribit: {
      async getIndexPrice() {
        return { result: { index_price: 100000 } };
      },
      async listInstruments() {
        return {
          result: [
            {
              instrument_name: "BTC-10APR26-80000-P",
              option_type: "put",
              strike: 80000,
              expiration_timestamp: Date.now() + 7 * 86400000
            }
          ]
        };
      },
      async getOrderBook() {
        return {
          result: {
            asks: [[0.01, 5]],
            bids: [[0.009, 5]],
            mark_price: 0.0095
          }
        };
      },
      async placeOrder() {
        return {
          status: "filled",
          id: "sim-order-3",
          fillPrice: 0.01,
          filledAmount: 0.05,
          amount: 0.05
        };
      }
    } as any
  });
  try {
    const { app } = harness;
    const openA = await app.inject({
      method: "POST",
      url: "/pilot/sim/positions/open",
      payload: {
        protectedNotional: 10000,
        tierName: "Pro (Bronze)",
        drawdownFloorPct: 0.2,
        side: "long",
        marketId: "BTC-USD",
        withProtection: false
      }
    });
    assert.equal(openA.statusCode, 200, openA.body);

    const openB = await app.inject({
      method: "POST",
      url: "/pilot/sim/positions/open",
      payload: {
        protectedNotional: 5000,
        tierName: "Pro (Bronze)",
        drawdownFloorPct: 0.2,
        side: "long",
        marketId: "BTC-USD",
        withProtection: false
      }
    });
    assert.equal(openB.statusCode, 200, openB.body);
    const simPositionId = String(openB.json().simPosition?.id || "");
    assert.ok(simPositionId.length > 0);

    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/ticker")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              product_id: "BTC-USD",
              price: 105000,
              timestamp: Date.now()
            })
        } as any;
      }
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            product_id: "BTC-USD",
            price: 105000,
            timestamp: Date.now()
          })
      } as any;
    }) as typeof fetch;

    const closeRes = await app.inject({
      method: "POST",
      url: `/pilot/sim/positions/${simPositionId}/close`
    });
    assert.equal(closeRes.statusCode, 200, closeRes.body);

    const summaryRes = await app.inject({
      method: "GET",
      url: "/pilot/sim/account/summary"
    });
    assert.equal(summaryRes.statusCode, 200, summaryRes.body);
    const summaryPayload = summaryRes.json();
    assert.equal(summaryPayload.status, "ok");
    assert.equal(summaryPayload.summary.openPositions, "1");
    assert.equal(summaryPayload.summary.closedPositions, "1");
    assert.equal(summaryPayload.summary.totalPositions, undefined);
    assert.equal(Number(summaryPayload.summary.realizedPnlUsd) > 0, true);
    assert.equal(Number(summaryPayload.summary.unrealizedPnlUsd) > 0, true);
    assert.equal(
      Number(summaryPayload.summary.currentEquityUsd) > Number(summaryPayload.summary.startingEquityUsd),
      true
    );
  } finally {
    await harness.close();
    global.fetch = originalFetch;
  }
});

test("Z1) trigger monitor marks breached active protection as triggered", async () => {
  const harness = await createPilotHarness({
    env: {
      PILOT_TRIGGER_MONITOR_ENABLED: "false",
      PILOT_TRIGGER_MONITOR_BATCH_SIZE: "10"
    }
  });
  try {
    const { app, pool } = harness;
    const { protectionId } = await quoteAndActivate(app, 1000);
    const { processTriggerMonitorCycleWithResolver } = await import("../src/pilot/triggerMonitor");

    const triggerSnapshotResolver = async () => ({
      price: new Decimal(79000),
      priceTimestamp: new Date().toISOString(),
      marketId: "BTC-USD",
      priceSource: "reference_oracle" as const,
      priceSourceDetail: "reference_oracle_api",
      endpointVersion: "v1",
      requestId: "trigger-test"
    });
    const monitorResult = await processTriggerMonitorCycleWithResolver(
      pool as any,
      triggerSnapshotResolver as any,
      new Date()
    );
    assert.equal(monitorResult.scanned >= 1, true);
    assert.equal(monitorResult.triggered, 1);
    const monitorResultReplay = await processTriggerMonitorCycleWithResolver(
      pool as any,
      triggerSnapshotResolver as any,
      new Date()
    );
    assert.equal(monitorResultReplay.triggered, 0);

    const protectionState = await pool.query(
      `SELECT status, payout_due_amount, metadata FROM pilot_protections WHERE id = $1`,
      [protectionId]
    );
    assert.equal(String(protectionState.rows[0].status), "triggered");
    assert.equal(Number(protectionState.rows[0].payout_due_amount), 200);
    assert.equal(String(protectionState.rows[0].metadata?.triggerStatus || ""), "breached");

    const triggerLedger = await pool.query(
      `SELECT entry_type, amount FROM pilot_ledger_entries WHERE protection_id = $1 ORDER BY created_at ASC`,
      [protectionId]
    );
    const triggerEntries = triggerLedger.rows.filter((row: any) => row.entry_type === "trigger_payout_due");
    assert.equal(triggerEntries.length, 1);
    assert.equal(Number(triggerEntries[0].amount), 200);

    const triggerSnapshots = await pool.query(
      `SELECT snapshot_type, price FROM pilot_price_snapshots WHERE protection_id = $1 AND snapshot_type = 'trigger'`,
      [protectionId]
    );
    assert.equal(Number(triggerSnapshots.rowCount || 0), 1);
    assert.equal(Number(triggerSnapshots.rows[0].price), 79000);
  } finally {
    await harness.close();
  }
});
