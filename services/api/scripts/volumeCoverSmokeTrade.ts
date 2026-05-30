/**
 * Volume Cover end-to-end smoke trade — exercises the full lifecycle
 * against an in-memory pg-mem DB and the mock hedge executor.
 *
 * Demonstrates:
 *   1. Schema migration + cell seed
 *   2. HMAC-signed quote request
 *   3. HMAC-signed activate request (full hedge buy)
 *   4. Trigger detector cycle (price moves to trigger boundary)
 *   5. Hedge sell + salvage event recorded
 *   6. Foxify daily report
 *   7. Salvage telemetry + guard state
 *
 * Usage:
 *   tsx scripts/volumeCoverSmokeTrade.ts
 *
 * Output is a step-by-step trace; non-zero exit if any step fails.
 */

import Fastify from "fastify";
import { newDb } from "pg-mem";
import { createHmac } from "node:crypto";

import {
  ensureCapitalPoolSchema,
  seedCapitalPoolsIfNeeded
} from "../src/pilot/capitalPoolSchema";
import { registerVolumeCoverRoutes } from "../src/volumeCover/volumeCoverRoutes";
import { __resetVolumeCoverGuardrailsForTests } from "../src/volumeCover/volumeCoverGuardrails";
import { __resetCircuitBreakerForTests } from "../src/pilot/circuitBreaker";
import { runOneDetectionCycle } from "../src/volumeCover/triggerDetector";
import { readSalvageMetrics } from "../src/volumeCover/salvageTracker";
import type { HedgeExecutor } from "../src/volumeCover/tightHedge";
import type { SpotPriceSource } from "../src/volumeCover/triggerDetector";

const ADMIN_TOKEN = "smoke-admin-token-1234567890abcdef";
const HMAC_SECRET = "smoke-hmac-secret-foxify-1234567890";

// Mutable spot for trigger simulation
let currentSpot = 80_000;

const mockExecutor: HedgeExecutor = {
  buyOptionLeg: async (params) => {
    console.log(
      `  [executor] BUY ${params.optionKind.toUpperCase()} strike=$${params.strikeUsdc.toFixed(0)} ` +
        `${params.contractsBtc} BTC on ${params.venue} @ $90/BTC`
    );
    return {
      venue: params.venue,
      fillPriceUsdcPerBtc: 90,
      totalCostUsdc: 90 * params.contractsBtc,
      orderId: `SMOKE-BUY-${Math.random().toString(36).slice(2, 8)}`
    };
  },
  sellOptionLeg: async (params) => {
    // Winning leg salvages near full intrinsic ($800/BTC for ±2% TIGHT @ trigger)
    // Losing leg salvages near zero
    const isWinningSide =
      (currentSpot < 80_000 && params.optionKind === "put") ||
      (currentSpot >= 80_000 && params.optionKind === "call");
    const proceedsPerBtc = isWinningSide ? 770 : 8;
    console.log(
      `  [executor] SELL ${params.optionKind.toUpperCase()} strike=$${params.strikeUsdc.toFixed(0)} ` +
        `${params.contractsBtc} BTC on ${params.venue} @ $${proceedsPerBtc}/BTC ` +
        `(${isWinningSide ? "WINNING" : "losing"} leg)`
    );
    return {
      venue: params.venue,
      fillPriceUsdcPerBtc: proceedsPerBtc,
      totalProceedsUsdc: proceedsPerBtc * params.contractsBtc,
      orderId: `SMOKE-SELL-${Math.random().toString(36).slice(2, 8)}`
    };
  }
};

const mockSpotSource: SpotPriceSource = async () => ({
  spotBtcPrice: currentSpot,
  asOfMs: Date.now(),
  source: "smoke_mock"
});

const signFoxifyRequest = (params: { method: string; path: string; body?: any }) => {
  const timestamp = String(Date.now());
  const bodyStr = params.body ? JSON.stringify(params.body) : "";
  const message = `${timestamp}\n${params.method.toUpperCase()}\n${params.path}\n${bodyStr}`;
  const signature = createHmac("sha256", HMAC_SECRET).update(message).digest("hex");
  return { signature, timestamp };
};

const foxifyHeaders = (params: { method: string; path: string; body?: any }) => {
  const { signature, timestamp } = signFoxifyRequest(params);
  return {
    "x-foxify-signature": signature,
    "x-foxify-timestamp": timestamp,
    "content-type": "application/json"
  };
};

const adminHeaders = () => ({
  "x-admin-token": ADMIN_TOKEN,
  "content-type": "application/json"
});

const log = (label: string, data?: any) => {
  if (data === undefined) {
    console.log(`\n=== ${label} ===`);
  } else {
    console.log(`\n=== ${label} ===`);
    console.log(JSON.stringify(data, null, 2));
  }
};

const main = async () => {
  console.log("Volume Cover end-to-end smoke trade\n");

  process.env.PILOT_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.FOXIFY_API_KEY_HMAC_SECRET = HMAC_SECRET;
  process.env.PILOT_GUARDS_ALL_DISABLED = "true";
  process.env.VOLUME_COVER_GUARDS_ALL_DISABLED = "false";
  __resetVolumeCoverGuardrailsForTests();
  __resetCircuitBreakerForTests();

  // 1. DB
  log("STEP 1 — In-memory DB + schema migration");
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensureCapitalPoolSchema(pool);
  await seedCapitalPoolsIfNeeded(pool);

  // 2. Server
  log("STEP 2 — Fastify server with Volume Cover routes");
  const app = Fastify({ logger: false });
  await registerVolumeCoverRoutes(app, {
    pool,
    hedgeExecutor: mockExecutor,
    spotSource: mockSpotSource
  });
  await app.ready();

  // 3. Health
  const health = await app.inject({ method: "GET", url: "/volume-cover/health" });
  log("STEP 3 — Health check", health.json());

  // 4. Quote
  const quoteBody = {
    foxifyPairId: "SMOKE-PAIR-001",
    pairNotionalUsdc: 50_000,
    triggerPct: 0.02
  };
  const quote = await app.inject({
    method: "POST",
    url: "/volume-cover/quote",
    headers: foxifyHeaders({ method: "POST", path: "/volume-cover/quote", body: quoteBody }),
    payload: quoteBody
  });
  log("STEP 4 — Quote ($50k pair / ±2% / $1k payout)", quote.json());
  if (quote.statusCode !== 200) throw new Error(`Quote failed: ${quote.statusCode}`);

  // 5. Activate
  const activateBody = {
    foxifyPairId: "SMOKE-PAIR-001",
    cellId: "50k_2pct_1k",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  };
  const activate = await app.inject({
    method: "POST",
    url: "/volume-cover/activate",
    headers: foxifyHeaders({ method: "POST", path: "/volume-cover/activate", body: activateBody }),
    payload: activateBody
  });
  log("STEP 5 — Activate (live hedge buy)", activate.json());
  if (activate.statusCode !== 201) throw new Error(`Activate failed: ${activate.statusCode}`);
  const positionId = activate.json().positionId;

  // 6. Move spot toward trigger boundary
  log("STEP 6 — BTC moves to trigger low ($78,400 = -2% from $80k entry)");
  currentSpot = 78_400;

  // 7. Run trigger detector
  const cycleResult = await runOneDetectionCycle({
    pool,
    executor: mockExecutor,
    spotSource: mockSpotSource
  });
  log("STEP 7 — Trigger detector cycle", cycleResult);
  if (cycleResult.positionsTriggered !== 1) {
    throw new Error(`Expected 1 trigger, got ${cycleResult.positionsTriggered}`);
  }

  // 8. Salvage metrics
  const metrics = await readSalvageMetrics(pool);
  log("STEP 8 — Salvage metrics after trigger", metrics);
  if (metrics.rolling5TriggerSampleCount !== 1) {
    throw new Error("Expected 1 salvage event recorded");
  }

  // 9. Foxify daily report
  const today = new Date().toISOString().slice(0, 10);
  const report = await app.inject({
    method: "GET",
    url: `/volume-cover/admin/foxify-report?date=${today}`,
    headers: adminHeaders()
  });
  log("STEP 9 — Foxify daily report", report.json());

  // 10. Position lookup
  const lookup = await app.inject({
    method: "GET",
    url: `/volume-cover/positions/${positionId}`,
    headers: foxifyHeaders({ method: "GET", path: `/volume-cover/positions/${positionId}` })
  });
  log("STEP 10 — Position lookup post-trigger", lookup.json());
  if (lookup.json().status !== "triggered") {
    throw new Error(`Expected status=triggered, got ${lookup.json().status}`);
  }

  // 11. Dashboard
  const dashboard = await app.inject({
    method: "GET",
    url: "/volume-cover/admin/dashboard",
    headers: adminHeaders()
  });
  log("STEP 11 — Admin markdown dashboard");
  console.log(dashboard.body);

  await app.close();
  await pool.end();

  console.log("\n✅ End-to-end smoke trade SUCCESSFUL");
  console.log("\nSalvage rate observed:", (metrics.rolling5TriggerSalvagePct! * 100).toFixed(1) + "%");
  console.log("Net Atticus loss for trigger: $" + metrics.rolling7dayAtticusLossUsdc.toFixed(2));
};

main().catch((err) => {
  console.error("\n❌ Smoke trade FAILED:", err);
  process.exit(1);
});
