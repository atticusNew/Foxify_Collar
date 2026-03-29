import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { newDb } from "pg-mem";

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
  configModule.pilotConfig.venueQuoteTimeoutMs = Number(process.env.PILOT_VENUE_QUOTE_TIMEOUT_MS || "10000");

  const db = newDb();
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();

  const dbModule = await import("../src/pilot/db");
  dbModule.__setPilotPoolForTests(pool as any);
  const { registerPilotRoutes } = await import("../src/pilot/routes");

  const app = Fastify();
  await registerPilotRoutes(app, { deribit: (opts?.deribit || {}) as any });

  return {
    app,
    pool,
    close: async () => {
      await app.close();
      await pool.end();
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
  assert.equal(activateRes.statusCode, 200);
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
        url: "/pilot/admin/metrics",
        headers: { "x-admin-token": "admin-local" }
      });
      assert.equal(preMetricsRes.statusCode, 200);
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
        url: "/pilot/admin/metrics",
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
      assert.notEqual(String(preMetrics.premiumSettledTotalUsdc || "0"), String(postMetrics.premiumSettledTotalUsdc || "0"));
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
                    expiry: "20260330",
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
      assert.equal(quoteRes.statusCode, 503);
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

