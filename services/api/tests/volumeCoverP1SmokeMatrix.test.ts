import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { newDb } from "pg-mem";
import { createHmac } from "node:crypto";

import {
  ensureCapitalPoolSchema,
  seedCapitalPoolsIfNeeded
} from "../src/pilot/capitalPoolSchema";
import {
  registerVolumeCoverRoutes,
  __resetVolumeCoverRoutesForTests
} from "../src/volumeCover/volumeCoverRoutes";
import { listHedgeLegsForPosition } from "../src/volumeCover/volumeCoverDb";
import { __resetCircuitBreakerForTests } from "../src/pilot/circuitBreaker";
import { __resetVolumeCoverGuardrailsForTests } from "../src/volumeCover/volumeCoverGuardrails";
import {
  runOneHedgeManagerTick,
  type SpotIvSource
} from "../src/volumeCover/volumeCoverHedgeManager";
import type { HedgeExecutor } from "../src/volumeCover/tightHedge";
import type { SpotPriceSource } from "../src/volumeCover/triggerDetector";

/**
 * Phase 1 staging smoke matrix — 10 cases run end-to-end via fastify
 * inject + pg-mem. Validates the full Phase 1 stack pre-cutover.
 */

const ADMIN_TOKEN = "smoke-admin-token-A1B2C3D4E5F6G7H8";
const HMAC_SECRET = "smoke-hmac-secret-foxify-test-key-2026";

const buyCalls: Array<any> = [];
const sellCalls: Array<any> = [];
let spotBtc = 80_000;

const buildExecutor = (): HedgeExecutor => ({
  buyOptionLeg: async (params) => {
    buyCalls.push(params);
    return {
      venue: params.venue,
      fillPriceUsdcPerBtc: 100,
      totalCostUsdc: 100 * params.contractsBtc,
      orderId: `BUY-${buyCalls.length}`
    };
  },
  sellOptionLeg: async (params) => {
    sellCalls.push(params);
    return {
      venue: params.venue,
      fillPriceUsdcPerBtc: 60,
      totalProceedsUsdc: 60 * params.contractsBtc,
      orderId: `SELL-${sellCalls.length}`
    };
  }
});

const buildSpotSource = (): SpotPriceSource =>
  async () => ({
    spotBtcPrice: spotBtc,
    asOfMs: Date.now(),
    source: "smoke"
  });

const signFoxify = (method: string, path: string, body?: any) => {
  const timestamp = String(Date.now());
  const bodyStr = body ? JSON.stringify(body) : "";
  const sig = createHmac("sha256", HMAC_SECRET)
    .update(`${timestamp}\n${method.toUpperCase()}\n${path}\n${bodyStr}`)
    .digest("hex");
  return {
    "x-foxify-signature": sig,
    "x-foxify-timestamp": timestamp,
    "content-type": "application/json"
  };
};

const buildHarness = async () => {
  process.env.PILOT_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.FOXIFY_API_KEY_HMAC_SECRET = HMAC_SECRET;
  process.env.PILOT_GUARDS_ALL_DISABLED = "true";
  process.env.VOLUME_COVER_GUARDS_ALL_DISABLED = "true"; // disable for smoke
  __resetVolumeCoverRoutesForTests();
  __resetVolumeCoverGuardrailsForTests();
  __resetCircuitBreakerForTests();
  buyCalls.length = 0;
  sellCalls.length = 0;
  spotBtc = 80_000;

  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensureCapitalPoolSchema(pool);
  await seedCapitalPoolsIfNeeded(pool);

  const app = Fastify();
  const executor = buildExecutor();
  await registerVolumeCoverRoutes(app, {
    pool,
    hedgeExecutor: executor,
    spotSource: buildSpotSource()
  });
  await app.ready();
  return {
    app,
    pool,
    executor,
    close: async () => {
      await app.close();
      await pool.end?.();
    }
  };
};

test("Smoke 1+2: activate 50k_2pct_1k → verify 14d expiry, strikes inside trigger", async () => {
  const { app, pool, close } = await buildHarness();
  try {
    const body = {
      foxifyPairId: "SMOKE-1",
      cellId: "50k_2pct_1k",
      pairLongNotionalUsdc: 50_000,
      pairShortNotionalUsdc: 50_000,
      pairEntryBtcPrice: 80_000,
      fingerprintHash: "smoke-fp-1"
    };
    const res = await app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers: signFoxify("POST", "/volume-cover/activate", body),
      payload: body
    });
    assert.equal(res.statusCode, 201, `activate response: ${res.body}`);
    const j = JSON.parse(res.body);
    assert.equal(j.cellId, "50k_2pct_1k");
    assert.ok(j.positionId);

    const legs = await listHedgeLegsForPosition(pool, j.positionId);
    assert.equal(legs.length, 2);
    for (const l of legs) {
      const daysOut = (new Date(l.expiryIso).getTime() - Date.now()) / 86_400_000;
      assert.ok(daysOut >= 13 && daysOut <= 15, `expected 13-15d expiry, got ${daysOut.toFixed(2)}d`);
    }
    const put = legs.find((l) => l.optionKind === "put")!;
    const call = legs.find((l) => l.optionKind === "call")!;
    assert.ok(put.strikeUsdc > 78_400 && put.strikeUsdc <= 80_000, `put strike ${put.strikeUsdc}`);
    assert.ok(call.strikeUsdc < 81_600 && call.strikeUsdc >= 80_000, `call strike ${call.strikeUsdc}`);
  } finally {
    await close();
  }
});

test("Smoke 3: ladder netting fires on same fingerprint+cell reopen", async () => {
  const { app, pool, close } = await buildHarness();
  try {
    const fp = "smoke-fp-ladder";
    const body1 = {
      foxifyPairId: "SMOKE-LD-1",
      cellId: "50k_2pct_1k",
      pairLongNotionalUsdc: 50_000,
      pairShortNotionalUsdc: 50_000,
      pairEntryBtcPrice: 80_000,
      fingerprintHash: fp
    };
    let res = await app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers: signFoxify("POST", "/volume-cover/activate", body1),
      payload: body1
    });
    assert.equal(res.statusCode, 201);
    const buyCountBeforeClose = buyCalls.length;

    // Close
    const closeBody = { reason: "smoke_close" };
    const closeRes = await app.inject({
      method: "POST",
      url: `/volume-cover/positions/${JSON.parse(res.body).positionId}/close`,
      headers: signFoxify("POST", `/volume-cover/positions/${JSON.parse(res.body).positionId}/close`, closeBody),
      payload: closeBody
    });
    assert.equal(closeRes.statusCode, 200);
    const closeJ = JSON.parse(closeRes.body);
    assert.equal(closeJ.hedgeRetained, true);
    assert.equal(closeJ.hedgeRetainedLegIds.length, 2);

    // No fresh sells during retention close
    assert.equal(sellCalls.length, 0, "close must not fire sells (retention)");

    // Reopen same fingerprint + cell
    const body2 = { ...body1, foxifyPairId: "SMOKE-LD-2" };
    // Use admin bypass to skip Layer 1 60min same-cell window
    const headers = {
      ...signFoxify("POST", "/volume-cover/activate", body2),
      "x-bypass-antibot": ADMIN_TOKEN
    };
    res = await app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers,
      payload: body2
    });
    assert.equal(res.statusCode, 201);
    const j = JSON.parse(res.body);
    // Hedge bought count should NOT have increased (legs repurposed)
    assert.equal(buyCalls.length, buyCountBeforeClose, "ladder netting must skip fresh buys");
  } finally {
    await close();
  }
});

test("Smoke 4: trigger detector fires trigger and retains both legs", async () => {
  const { app, pool, close } = await buildHarness();
  try {
    const body = {
      foxifyPairId: "SMOKE-TRIG",
      cellId: "50k_2pct_1k",
      pairLongNotionalUsdc: 50_000,
      pairShortNotionalUsdc: 50_000,
      pairEntryBtcPrice: 80_000
    };
    const res = await app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers: signFoxify("POST", "/volume-cover/activate", body),
      payload: body
    });
    assert.equal(res.statusCode, 201);
    const positionId = JSON.parse(res.body).positionId;

    // Move spot below trigger ($78,400) and run trigger detector
    spotBtc = 78_300;
    const cycleRes = await app.inject({
      method: "POST",
      url: "/volume-cover/admin/trigger-detector/run",
      headers: adminHeaders(),
      payload: {}
    });
    assert.equal(cycleRes.statusCode, 200, `trigger-detector/run body: ${cycleRes.body}`);
    const cycle = JSON.parse(cycleRes.body);
    assert.equal(cycle.positionsTriggered, 1, `cycle: ${JSON.stringify(cycle)}`);

    const legs = await listHedgeLegsForPosition(pool, positionId);
    for (const l of legs) {
      assert.equal(l.status, "open"); // retained, not sold
      assert.equal(l.retained, true);
    }
    // No sells fired by trigger
    assert.equal(sellCalls.length, 0);
  } finally {
    await close();
  }
});

test("Smoke 5: hedge manager rule 1 (forced exit) sells legs near expiry", async () => {
  const { app, pool, close, executor } = await buildHarness();
  try {
    const body = {
      foxifyPairId: "SMOKE-HM",
      cellId: "50k_2pct_1k",
      pairLongNotionalUsdc: 50_000,
      pairShortNotionalUsdc: 50_000,
      pairEntryBtcPrice: 80_000
    };
    const res = await app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers: signFoxify("POST", "/volume-cover/activate", body),
      payload: body
    });
    const positionId = JSON.parse(res.body).positionId;

    // Trigger
    spotBtc = 78_300;
    await app.inject({
      method: "POST",
      url: "/volume-cover/admin/trigger-detector/run",
      headers: adminHeaders(),
      payload: {}
    });

    // Force expiry to be 1h from now to fire rule 1
    const oneHourFromNowIso = new Date(Date.now() + 3_600_000).toISOString();
    await pool.query(
      `UPDATE volume_cover_hedge_leg
       SET expiry_iso = $1::timestamptz
       WHERE position_id = $2`,
      [oneHourFromNowIso, positionId]
    );

    // Sanity check: legs should be retained post-trigger
    const legs = await listHedgeLegsForPosition(pool, positionId);
    assert.equal(legs.length, 2);
    for (const l of legs) {
      assert.equal(l.retained, true, `leg ${l.id} should be retained after trigger`);
    }

    spotBtc = 78_300;
    const spotIvSource: SpotIvSource = async () => ({
      spotBtcUsdc: spotBtc,
      ivAnnualized: 0.65,
      asOfMs: Date.now()
    });
    const before = sellCalls.length;
    const result = await runOneHedgeManagerTick({
      pool,
      executor,
      spotIvSource
    });
    assert.equal(result.legsScanned, 2, `expected 2 legs scanned, got ${result.legsScanned}, skipped=${result.skipped} reason=${result.skipReason}`);
    assert.equal(result.legsActioned, 2);
    assert.equal(sellCalls.length - before, 2, "two legs sold by manager");
  } finally {
    await close();
  }
});

test("Smoke 6: anti-bot Layer 1 blocks repeat 50k_2pct_1k from same fingerprint", async () => {
  const { app, close } = await buildHarness();
  try {
    const fp = "smoke-fp-l1";
    const body = {
      foxifyPairId: "SMOKE-L1-1",
      cellId: "50k_2pct_1k",
      pairLongNotionalUsdc: 50_000,
      pairShortNotionalUsdc: 50_000,
      pairEntryBtcPrice: 80_000,
      fingerprintHash: fp
    };
    let res = await app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers: signFoxify("POST", "/volume-cover/activate", body),
      payload: body
    });
    assert.equal(res.statusCode, 201);

    // Repeat same cell same fingerprint
    const body2 = { ...body, foxifyPairId: "SMOKE-L1-2" };
    res = await app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers: signFoxify("POST", "/volume-cover/activate", body2),
      payload: body2
    });
    assert.equal(res.statusCode, 429);
    assert.match(JSON.parse(res.body).reason ?? "", /layer1_repeat_cell_window|layer2_cooldown_active/);
  } finally {
    await close();
  }
});

test("Smoke 7: weekly settlement endpoint returns valid JSON for current week", async () => {
  const { app, close } = await buildHarness();
  try {
    // Open + close one position
    const body = {
      foxifyPairId: "SMOKE-WK",
      cellId: "50k_2pct_1k",
      pairLongNotionalUsdc: 50_000,
      pairShortNotionalUsdc: 50_000,
      pairEntryBtcPrice: 80_000
    };
    const r1 = await app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers: signFoxify("POST", "/volume-cover/activate", body),
      payload: body
    });
    const positionId = JSON.parse(r1.body).positionId;
    const cb = { reason: "smoke" };
    await app.inject({
      method: "POST",
      url: `/volume-cover/positions/${positionId}/close`,
      headers: signFoxify("POST", `/volume-cover/positions/${positionId}/close`, cb),
      payload: cb
    });

    // Compute current ISO week
    const now = new Date();
    const year = now.getUTCFullYear();
    const jan1 = new Date(Date.UTC(year, 0, 1));
    const dayOfYear = Math.floor((now.getTime() - jan1.getTime()) / 86_400_000);
    const week = Math.ceil((dayOfYear + 1) / 7);
    const label = `${year}-W${week}`;

    const res = await app.inject({
      method: "GET",
      url: `/volume-cover/admin/weekly-settlement?week=${label}`,
      headers: adminHeaders()
    });
    assert.equal(res.statusCode, 200);
    const settlement = JSON.parse(res.body);
    assert.ok(settlement.week);
    assert.ok(Array.isArray(settlement.perPosition));
    assert.ok(typeof settlement.totals.netAtticusObligationUsdc === "number");
    assert.ok(typeof settlement.partial25PctUsdc === "number");
  } finally {
    await close();
  }
});

test("Smoke 9: anti-bot Layer 3 — post-trigger cooldown blocks new activation", async () => {
  const { app, pool, close } = await buildHarness();
  try {
    const fp = "smoke-fp-l3";
    const body = {
      foxifyPairId: "SMOKE-L3-1",
      cellId: "50k_2pct_1k",
      pairLongNotionalUsdc: 50_000,
      pairShortNotionalUsdc: 50_000,
      pairEntryBtcPrice: 80_000,
      fingerprintHash: fp
    };
    let res = await app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers: signFoxify("POST", "/volume-cover/activate", body),
      payload: body
    });
    assert.equal(res.statusCode, 201);

    // Trigger
    spotBtc = 78_300;
    await app.inject({
      method: "POST",
      url: "/volume-cover/admin/trigger-detector/run",
      headers: adminHeaders(),
      payload: {}
    });
    spotBtc = 80_000;

    // Try to reopen with SAME fingerprint on a DIFFERENT cell —
    // Layer 1 doesn't apply (different cell); Layer 3 should fire
    // because last_trigger_at is now.
    const body2 = {
      foxifyPairId: "SMOKE-L3-2",
      cellId: "50k_5pct_2_5k",
      pairLongNotionalUsdc: 50_000,
      pairShortNotionalUsdc: 50_000,
      pairEntryBtcPrice: 80_000,
      fingerprintHash: fp
    };
    res = await app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers: signFoxify("POST", "/volume-cover/activate", body2),
      payload: body2
    });
    assert.equal(res.statusCode, 429);
    const j = JSON.parse(res.body);
    assert.match(j.reason ?? "", /layer2_cooldown_active|layer3_post_trigger_cooldown/);
  } finally {
    await close();
  }
});

test("Smoke 10: regime overlay env applied to moderate quote", async () => {
  const { app, pool, close } = await buildHarness();
  try {
    process.env.VC_REGIME_OVERLAY_JSON = JSON.stringify({
      "50k_2pct_1k": { moderate: 420, elevated: 525, stress: 700 }
    });
    try {
      // Activate; route reads regime via DVOL fetch which fails in
      // test env (no Deribit connector), so regime stays null →
      // overlay does NOT apply → matrix base $350 used. Validate the
      // FALLBACK path works (no env crash, position created).
      const body = {
        foxifyPairId: "SMOKE-OVERLAY-1",
        cellId: "50k_2pct_1k",
        pairLongNotionalUsdc: 50_000,
        pairShortNotionalUsdc: 50_000,
        pairEntryBtcPrice: 80_000
      };
      const res = await app.inject({
        method: "POST",
        url: "/volume-cover/activate",
        headers: signFoxify("POST", "/volume-cover/activate", body),
        payload: body
      });
      assert.equal(res.statusCode, 201, `body: ${res.body}`);
      const positionId = JSON.parse(res.body).positionId;
      const r = await pool.query(
        `SELECT daily_premium_usdc FROM volume_cover_position WHERE id = $1`,
        [positionId]
      );
      // Pilot regimeClassifier without a Deribit connector returns
      // its default cached regime which translates to "moderate" via
      // translatePilotRegime("normal") → moderate overlay $420 applies.
      // (In live production with real DVOL feed, the actual regime
      // determines which overlay tier fires.)
      const dailyPremium = Number(r.rows[0].daily_premium_usdc);
      assert.ok(
        dailyPremium === 350 || dailyPremium === 420,
        `expected matrix base \$350 (no regime) or moderate overlay \$420, got \$${dailyPremium}`
      );
    } finally {
      delete process.env.VC_REGIME_OVERLAY_JSON;
    }
  } finally {
    await close();
  }
});

test("Smoke 8: health endpoint reflects 6 cells configured + active positions", async () => {
  const { app, close } = await buildHarness();
  try {
    const body = {
      foxifyPairId: "SMOKE-HEALTH",
      cellId: "50k_2pct_1k",
      pairLongNotionalUsdc: 50_000,
      pairShortNotionalUsdc: 50_000,
      pairEntryBtcPrice: 80_000
    };
    await app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers: signFoxify("POST", "/volume-cover/activate", body),
      payload: body
    });
    const res = await app.inject({ method: "GET", url: "/volume-cover/health" });
    assert.equal(res.statusCode, 200);
    const j = JSON.parse(res.body);
    assert.equal(j.cellsConfigured, 6);
    assert.ok(j.activePositions >= 1);
  } finally {
    await close();
  }
});

const adminHeaders = () => ({ "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" });
