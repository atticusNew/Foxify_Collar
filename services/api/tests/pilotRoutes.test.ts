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

const createPilotHarness = async (): Promise<{
  app: FastifyInstance;
  pool: { query: (sql: string, params?: unknown[]) => Promise<any>; end: () => Promise<void> };
  close: () => Promise<void>;
}> => {
  process.env.PILOT_API_ENABLED = "true";
  process.env.PILOT_VENUE_MODE = "mock_falconx";
  process.env.POSTGRES_URL = "postgres://unused";
  process.env.USER_HASH_SECRET = "test_hash_secret";
  process.env.PILOT_ADMIN_TOKEN = "admin-local";
  process.env.PILOT_ADMIN_IP_ALLOWLIST = "127.0.0.1";
  process.env.PILOT_PROOF_TOKEN = "proof-local";
  process.env.PRICE_REFERENCE_MARKET_ID = "BTC-USD";
  process.env.PRICE_REFERENCE_URL = "https://example.com/ticker";
  process.env.PRICE_SINGLE_SOURCE = "true";
  process.env.PILOT_START_AT = "";
  process.env.PILOT_DURATION_DAYS = "30";
  process.env.PILOT_ENFORCE_WINDOW = "true";
  process.env.PILOT_QUOTE_TTL_MS = "120000";
  process.env.PILOT_INTERNAL_TOKEN = "internal-local";

  global.fetch = buildPriceFetch();

  const db = newDb();
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();

  const dbModule = await import("../src/pilot/db");
  dbModule.__setPilotPoolForTests(pool as any);
  const { registerPilotRoutes } = await import("../src/pilot/routes");

  const app = Fastify();
  await registerPilotRoutes(app, { deribit: {} as any });

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

