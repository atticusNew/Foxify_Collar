import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
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

const buildDeribitStub = (): any => {
  const now = Date.now();
  return {
    getIndexPrice: async () => ({
      result: { index_price: 100000 }
    }),
    listInstruments: async () => ({
      result: [
        {
          instrument_name: "BTC-31MAR26-80000-P",
          option_type: "put",
          strike: 80000,
          expiration_timestamp: now + 7 * 86400000
        }
      ]
    }),
    getOrderBook: async () => ({
      result: { asks: [[0.01, 5]], bids: [[0.009, 5]], mark_price: 0.0095 }
    })
  };
};

const createHarness = async (opts?: {
  env?: Record<string, string | undefined>;
}): Promise<{
  app: Fastify.FastifyInstance;
  close: () => Promise<void>;
}> => {
  process.env.PILOT_API_ENABLED = "true";
  process.env.PILOT_ACTIVATION_ENABLED = "true";
  process.env.PILOT_HEDGE_POLICY = "options_primary_futures_fallback";
  process.env.PILOT_VENUE_MODE = "deribit_test";
  process.env.POSTGRES_URL = "postgres://unused";
  process.env.USER_HASH_SECRET = "test_hash_secret";
  process.env.PILOT_ADMIN_TOKEN = "admin-local";
  process.env.PILOT_ADMIN_IP_ALLOWLIST = "127.0.0.1";
  process.env.PILOT_INTERNAL_TOKEN = "internal-local";
  process.env.PRICE_REFERENCE_MARKET_ID = "BTC-USD";
  process.env.PRICE_REFERENCE_URL = "https://example.com/ticker";
  process.env.PRICE_SINGLE_SOURCE = "true";
  process.env.PILOT_ENFORCE_WINDOW = "false";
  process.env.PILOT_QUOTE_TTL_MS = "120000";
  process.env.PILOT_TRIGGER_MONITOR_ENABLED = "false";
  process.env.PILOT_TENOR_MIN_DAYS = "1";
  process.env.PILOT_TENOR_MAX_DAYS = "7";
  process.env.PILOT_TENOR_DEFAULT_DAYS = "7";
  process.env.PILOT_DYNAMIC_TENOR_ENABLED = "false";
  process.env.PILOT_PREMIUM_PRICING_MODE = "hybrid_otm_treasury";
  process.env.PILOT_SELECTOR_MODE = "hybrid_treasury";
  process.env.PILOT_TREASURY_SUBSIDY_CAP_PCT = "1";
  process.env.PILOT_TREASURY_DAILY_SUBSIDY_CAP_USDC = "1000000";
  process.env.PILOT_TREASURY_STRICT_FALLBACK_ENABLED = "true";
  process.env.PILOT_PREMIUM_REGIME_ENABLED = "true";
  process.env.PILOT_PREMIUM_REGIME_MIN_SAMPLES = "1";
  process.env.PILOT_PREMIUM_REGIME_MIN_DWELL_MINUTES = "1";
  process.env.PILOT_PREMIUM_REGIME_ENTER_WATCH_TRIGGER_HIT_RATE_PCT = "1000";
  process.env.PILOT_PREMIUM_REGIME_ENTER_WATCH_SUBSIDY_UTILIZATION_PCT = "0";
  process.env.PILOT_PREMIUM_REGIME_WATCH_ADD_USD_PER_1K = "2";
  process.env.PILOT_PREMIUM_REGIME_WATCH_MULTIPLIER = "1";
  process.env.PILOT_PREMIUM_REGIME_MAX_OVERLAY_PCT_OF_BASE = "1";
  if (opts?.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  global.fetch = buildPriceFetch();

  const db = newDb();
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();
  const dbModule = await import("../src/pilot/db");
  dbModule.__setPilotPoolForTests(pool as any);
  const triggerMonitorModule = await import("../src/pilot/triggerMonitor");
  triggerMonitorModule.__setTriggerMonitorEnabledForTests(false);
  const premiumRegimeModule = await import("../src/pilot/premiumRegime");
  premiumRegimeModule.__resetPremiumRegimeStateForTests();
  const { registerPilotRoutes } = await import("../src/pilot/routes");
  const app = Fastify();
  await registerPilotRoutes(app, { deribit: buildDeribitStub() as any });
  await dbModule.insertVenueQuote(pool as any, {
    venue: "deribit_test",
    quoteId: "seed-premium-regime-watch",
    rfqId: null,
    instrumentId: "BTC-31MAR26-80000-P",
    side: "buy",
    quantity: 0.05,
    premium: 50,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    quoteTs: new Date().toISOString(),
    details: {
      pricingBreakdown: {
        clientPremiumUsd: "50.0000000000",
        treasuryQuoteSubsidyUsd: "0.0000000000",
        treasuryPerQuoteSubsidyCapUsd: "100.0000000000",
        treasuryStartingReserveUsdc: "25000.0000000000",
        treasuryReserveAfterOpenLiabilityUsdc: "20000.0000000000"
      },
      lockContext: {
        requestedTenorDays: 7,
        protectedNotional: "5000.0000000000"
      }
    }
  });
  return {
    app,
    close: async () => {
      await app.close();
      await pool.end();
      triggerMonitorModule.__setTriggerMonitorEnabledForTests(true);
      dbModule.__setPilotPoolForTests(null);
      global.fetch = originalFetch;
      premiumRegimeModule.__resetPremiumRegimeStateForTests();
    }
  };
};

test("quote applies premium regime overlay in watch regime", async () => {
  const harness = await createHarness();
  try {
    const response = await harness.app.inject({
      method: "POST",
      url: "/pilot/protections/quote",
      payload: {
        protectedNotional: 5000,
        foxifyExposureNotional: 5000,
        instrumentId: "BTC-USD-7D-P",
        marketId: "BTC-USD",
        tierName: "Pro (Bronze)",
        drawdownFloorPct: 0.2
      }
    });
    assert.equal(response.statusCode, 200, response.body);
    const body: any = response.json();
    assert.equal(body.status, "ok");
    const breakdown = body?.quote?.details?.pricingBreakdown || {};
    assert.equal(breakdown.premiumRegimeOverlayApplied, true);
    assert.equal(breakdown.premiumRegimeLevel, "watch");
    assert.equal(Number(breakdown.strictClientPremiumUsd), 212.5);
    assert.equal(Number(breakdown.hybridStrictMultiplier), 0.6);
    assert.equal(Number(breakdown.premiumRegimeOverlayAddUsdPer1k), 2);
    assert.equal(Number(breakdown.premiumRegimeOverlayUsd), 10);
    assert.equal(Number(breakdown.clientPremiumUsd), Number(breakdown.premiumRegimeAdjustedPremiumUsd));
    assert.equal(Number(breakdown.displayedPremiumPer1kUsd), 11);
    assert.equal(Number(breakdown.displayedPremiumUsd), 55);
  } finally {
    await harness.close();
  }
});

