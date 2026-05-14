import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { newDb } from "pg-mem";
import { createHmac } from "node:crypto";

import { ensureCapitalPoolSchema, seedCapitalPoolsIfNeeded } from "../src/pilot/capitalPoolSchema";
import {
  registerVolumeCoverRoutes,
  __resetVolumeCoverRoutesForTests
} from "../src/volumeCover/volumeCoverRoutes";
import { __resetCircuitBreakerForTests } from "../src/pilot/circuitBreaker";
import { __resetVolumeCoverGuardrailsForTests } from "../src/volumeCover/volumeCoverGuardrails";
import type { HedgeExecutor } from "../src/volumeCover/tightHedge";
import type { SpotPriceSource } from "../src/volumeCover/triggerDetector";

const ADMIN_TOKEN = "test-admin-token-1234567890abcdef";
const HMAC_SECRET = "test-hmac-secret-foxify-1234567890";

const mockExecutor: HedgeExecutor = {
  buyOptionLeg: async (params) => ({
    venue: params.venue,
    fillPriceUsdcPerBtc: 90,
    totalCostUsdc: 90 * params.contractsBtc,
    orderId: `MOCK-${Math.random()}`
  }),
  sellOptionLeg: async (params) => ({
    venue: params.venue,
    fillPriceUsdcPerBtc: params.optionKind === "put" ? 800 : 5,
    totalProceedsUsdc: (params.optionKind === "put" ? 800 : 5) * params.contractsBtc,
    orderId: `MOCK-SELL-${Math.random()}`
  })
};

const mockSpotSource: SpotPriceSource = async () => ({
  spotBtcPrice: 80_000,
  asOfMs: Date.now(),
  source: "test_mock"
});

const buildHarness = async () => {
  process.env.PILOT_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.FOXIFY_API_KEY_HMAC_SECRET = HMAC_SECRET;
  process.env.PILOT_GUARDS_ALL_DISABLED = "true";
  process.env.VOLUME_COVER_GUARDS_ALL_DISABLED = "false";
  __resetVolumeCoverRoutesForTests();
  __resetVolumeCoverGuardrailsForTests();
  __resetCircuitBreakerForTests();

  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensureCapitalPoolSchema(pool);
  await seedCapitalPoolsIfNeeded(pool);

  const app = Fastify();
  await registerVolumeCoverRoutes(app, {
    pool,
    hedgeExecutor: mockExecutor,
    spotSource: mockSpotSource
  });
  await app.ready();

  return {
    app,
    pool,
    close: async () => {
      await app.close();
      await pool.end?.();
    }
  };
};

const signFoxifyRequest = (params: {
  method: string;
  path: string;
  body?: any;
}): { signature: string; timestamp: string } => {
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

test("/volume-cover/health returns 200 with cell + position counts", async () => {
  const harness = await buildHarness();
  try {
    const r = await harness.app.inject({ method: "GET", url: "/volume-cover/health" });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.status, "ok");
    assert.equal(body.cellsConfigured, 6);
    assert.equal(body.cellsEnabled, 6);
    assert.equal(body.activePositions, 0);
  } finally {
    await harness.close();
  }
});

test("/volume-cover/admin/cells requires admin token", async () => {
  const harness = await buildHarness();
  try {
    const noAuth = await harness.app.inject({ method: "GET", url: "/volume-cover/admin/cells" });
    assert.equal(noAuth.statusCode, 403);
    const wrong = await harness.app.inject({
      method: "GET",
      url: "/volume-cover/admin/cells",
      headers: { "x-admin-token": "wrong" }
    });
    assert.equal(wrong.statusCode, 403);
    const ok = await harness.app.inject({
      method: "GET",
      url: "/volume-cover/admin/cells",
      headers: adminHeaders()
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().cells.length, 6);
  } finally {
    await harness.close();
  }
});

test("/volume-cover/admin/cells/:cellId/toggle disables and re-enables", async () => {
  const harness = await buildHarness();
  try {
    const off = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/admin/cells/50k_2pct_1k/toggle",
      headers: adminHeaders(),
      payload: { enabled: false }
    });
    assert.equal(off.statusCode, 200);
    assert.equal(off.json().cell.enabled, false);
    const on = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/admin/cells/50k_2pct_1k/toggle",
      headers: adminHeaders(),
      payload: { enabled: true, throttleMaxPerDay: 10, dailyPremiumUsdc: 425 }
    });
    assert.equal(on.statusCode, 200);
    assert.equal(on.json().cell.throttleMaxPerDay, 10);
    assert.equal(on.json().cell.dailyPremiumUsdc, 425);
  } finally {
    await harness.close();
  }
});

test("/volume-cover/quote rejects without HMAC", async () => {
  const harness = await buildHarness();
  try {
    const r = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/quote",
      payload: {
        foxifyPairId: "FX-Q-1",
        pairNotionalUsdc: 50_000,
        triggerPct: 0.02
      }
    });
    assert.equal(r.statusCode, 401);
  } finally {
    await harness.close();
  }
});

test("/volume-cover/quote returns price + trigger boundaries with valid HMAC", async () => {
  const harness = await buildHarness();
  try {
    const body = {
      foxifyPairId: "FX-Q-2",
      pairNotionalUsdc: 50_000,
      triggerPct: 0.02
    };
    const r = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/quote",
      headers: foxifyHeaders({ method: "POST", path: "/volume-cover/quote", body }),
      payload: body
    });
    assert.equal(r.statusCode, 200);
    const json = r.json();
    assert.equal(json.cellId, "50k_2pct_1k");
    assert.equal(json.dailyPremiumUsdc, 350);
    assert.equal(json.payoutUsdc, 1_000);
    assert.equal(json.triggerHighBtc, 81_600);
    assert.equal(json.triggerLowBtc, 78_400);
    assert.ok(json.hedgeStructure.putStrikeBtc < 80_000);
    assert.ok(json.hedgeStructure.callStrikeBtc > 80_000);
  } finally {
    await harness.close();
  }
});

test("/volume-cover/quote rejects disabled cell", async () => {
  const harness = await buildHarness();
  try {
    await harness.app.inject({
      method: "POST",
      url: "/volume-cover/admin/cells/50k_2pct_1k/toggle",
      headers: adminHeaders(),
      payload: { enabled: false }
    });
    const body = {
      foxifyPairId: "FX-Q-DIS",
      pairNotionalUsdc: 50_000,
      triggerPct: 0.02
    };
    const r = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/quote",
      headers: foxifyHeaders({ method: "POST", path: "/volume-cover/quote", body }),
      payload: body
    });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().error, "cell_disabled");
  } finally {
    await harness.close();
  }
});

test("/volume-cover/activate full happy path: 201 with hedge legs + ledger entries", async () => {
  const harness = await buildHarness();
  try {
    const body = {
      foxifyPairId: "FX-A-1",
      cellId: "50k_2pct_1k",
      pairLongNotionalUsdc: 50_000,
      pairShortNotionalUsdc: 50_000,
      pairEntryBtcPrice: 80_000
    };
    const r = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers: foxifyHeaders({ method: "POST", path: "/volume-cover/activate", body }),
      payload: body
    });
    assert.equal(r.statusCode, 201);
    const json = r.json();
    assert.ok(json.positionId);
    assert.equal(json.status, "active");
    assert.equal(json.hedgeLegs.length, 2);
    assert.equal(json.salvageState, "normal");
  } finally {
    await harness.close();
  }
});

test("/volume-cover/activate is idempotent on foxifyPairId retry", async () => {
  const harness = await buildHarness();
  try {
    const body = {
      foxifyPairId: "FX-IDEMP-1",
      cellId: "50k_2pct_1k",
      pairLongNotionalUsdc: 50_000,
      pairShortNotionalUsdc: 50_000,
      pairEntryBtcPrice: 80_000
    };
    const r1 = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers: foxifyHeaders({ method: "POST", path: "/volume-cover/activate", body }),
      payload: body
    });
    const r2 = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers: foxifyHeaders({ method: "POST", path: "/volume-cover/activate", body }),
      payload: body
    });
    assert.equal(r1.statusCode, 201);
    assert.equal(r2.statusCode, 200);
    assert.equal(r2.json().idempotent, true);
    assert.equal(r1.json().positionId, r2.json().positionId);
  } finally {
    await harness.close();
  }
});

test("/volume-cover/activate rejects entry price >1% off live spot", async () => {
  const harness = await buildHarness();
  try {
    const body = {
      foxifyPairId: "FX-DRIFT-1",
      cellId: "50k_2pct_1k",
      pairLongNotionalUsdc: 50_000,
      pairShortNotionalUsdc: 50_000,
      pairEntryBtcPrice: 90_000 // 12.5% above mock spot ($80k)
    };
    const r = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers: foxifyHeaders({ method: "POST", path: "/volume-cover/activate", body }),
      payload: body
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, "entry_price_drift_too_high");
  } finally {
    await harness.close();
  }
});

test("/volume-cover/activate enforces per-cell daily throttle", async () => {
  const harness = await buildHarness();
  try {
    // Default throttle = 5; open 5 then 6th should fail
    for (let i = 0; i < 5; i++) {
      const body = {
        foxifyPairId: `FX-THROT-${i}`,
        cellId: "50k_2pct_1k",
        pairLongNotionalUsdc: 50_000,
        pairShortNotionalUsdc: 50_000,
        pairEntryBtcPrice: 80_000
      };
      const r = await harness.app.inject({
        method: "POST",
        url: "/volume-cover/activate",
        headers: foxifyHeaders({ method: "POST", path: "/volume-cover/activate", body }),
        payload: body
      });
      assert.equal(r.statusCode, 201, `expected 201 on activation ${i}, got ${r.statusCode}: ${r.body}`);
    }
    const overflow = {
      foxifyPairId: "FX-THROT-OVERFLOW",
      cellId: "50k_2pct_1k",
      pairLongNotionalUsdc: 50_000,
      pairShortNotionalUsdc: 50_000,
      pairEntryBtcPrice: 80_000
    };
    const r = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers: foxifyHeaders({ method: "POST", path: "/volume-cover/activate", body: overflow }),
      payload: overflow
    });
    assert.equal(r.statusCode, 429);
    assert.equal(r.json().error, "daily_throttle_exceeded");
  } finally {
    await harness.close();
  }
});

test("/volume-cover/admin/halt blocks new activations", async () => {
  const harness = await buildHarness();
  try {
    const haltR = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/admin/halt",
      headers: adminHeaders(),
      payload: { reason: "test_halt" }
    });
    assert.equal(haltR.statusCode, 200);

    const body = {
      foxifyPairId: "FX-HALT-1",
      cellId: "50k_2pct_1k",
      pairLongNotionalUsdc: 50_000,
      pairShortNotionalUsdc: 50_000,
      pairEntryBtcPrice: 80_000
    };
    const r = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers: foxifyHeaders({ method: "POST", path: "/volume-cover/activate", body }),
      payload: body
    });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().reason, "manual_halt");

    // Clear and verify activation succeeds again
    const clearR = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/admin/halt/clear",
      headers: adminHeaders(),
      payload: {}
    });
    assert.equal(clearR.statusCode, 200);

    const r2 = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers: foxifyHeaders({ method: "POST", path: "/volume-cover/activate", body }),
      payload: body
    });
    assert.equal(r2.statusCode, 201);
  } finally {
    await harness.close();
  }
});

test("/volume-cover/admin/foxify-report builds a report for today", async () => {
  const harness = await buildHarness();
  try {
    // Open one position so the report has something
    const body = {
      foxifyPairId: "FX-REPORT-1",
      cellId: "50k_2pct_1k",
      pairLongNotionalUsdc: 50_000,
      pairShortNotionalUsdc: 50_000,
      pairEntryBtcPrice: 80_000
    };
    await harness.app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers: foxifyHeaders({ method: "POST", path: "/volume-cover/activate", body }),
      payload: body
    });
    const r = await harness.app.inject({
      method: "GET",
      url: "/volume-cover/admin/foxify-report",
      headers: adminHeaders()
    });
    assert.equal(r.statusCode, 200);
    const report = r.json();
    assert.equal(report.positionsOpenedToday, 1);
    assert.equal(report.totalPremiumBilledToFoxifyUsdc, 350);
    assert.equal(report.cellsStatus.length, 6);
  } finally {
    await harness.close();
  }
});

test("/volume-cover/admin/dashboard returns markdown", async () => {
  const harness = await buildHarness();
  try {
    const r = await harness.app.inject({
      method: "GET",
      url: "/volume-cover/admin/dashboard",
      headers: adminHeaders()
    });
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /Volume Cover Dashboard/);
    assert.match(r.body, /Cells/);
  } finally {
    await harness.close();
  }
});
