/**
 * PR C10 tests — Wave C ship-readiness integration sweep.
 *
 * Final gate test exercising the multi-cell registry, allowlist enforcement,
 * ledger entries, and end-to-end lifecycle. Verifies all 7 cells are
 * accessible and that DVOL halt + cell allowlist work as designed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { newDb } from "pg-mem";
import { ensureTwoSidedSchema, getPairById } from "../src/singleSide/twoSided/db";
import { ensureGuardrailsSchema } from "../src/singleSide/twoSided/guardrails";
import { ensureDeferredPoolSchema } from "../src/singleSide/twoSided/deferredPool";
import { ensureNewbornReviewSchema } from "../src/singleSide/twoSided/featureFlag";
import { ensureWebhookConfigSchema } from "../src/singleSide/twoSided/webhookConfig";
import { ensureWebhookAttemptSchema } from "../src/singleSide/twoSided/webhookDelivery";
import { ensureCellAllowlistSchema, DEFAULT_CELL_ALLOWLIST } from "../src/singleSide/twoSided/cellAllowlist";
import { ensureCounterpartyLedgerSchema, getBalance, getStatement } from "../src/singleSide/twoSided/counterpartyLedger";
import { registerFoxifyV2Routes } from "../src/singleSide/twoSided/routes";
import { FeedService } from "../src/singleSide/twoSided/feedService";
import { DvolService } from "../src/singleSide/twoSided/dvolService";
import { MockStrangleExecutor } from "../src/singleSide/twoSided/executor";
import { PHASE_0_CELLS } from "../src/singleSide/twoSided/cellConfig";
import type { LiveAnchorProvider } from "../src/singleSide/twoSided/quoteEngine";
import type { Regime } from "../src/singleSide/twoSided/featureFlag";

const FOXIFY_TOKEN = "test-foxify-ship";
const ADMIN_TOKEN = "test-admin-ship";
const REGIME_DVOL: Record<Regime, number> = { calm: 38, moderate: 50, elevated: 70, stress: 90 };

const buildShipRig = async () => {
  process.env.FOXIFY_API_KEY = FOXIFY_TOKEN;
  process.env.PILOT_ADMIN_TOKEN = ADMIN_TOKEN;
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  for (const f of [ensureTwoSidedSchema, ensureGuardrailsSchema, ensureDeferredPoolSchema, ensureNewbornReviewSchema, ensureWebhookConfigSchema, ensureWebhookAttemptSchema, ensureCellAllowlistSchema, ensureCounterpartyLedgerSchema]) await f(pool);

  let currentRegime: Regime = "calm";
  const feedService = new FeedService({
    pollOverride: async ({ nowMs }) => ({
      samples: [{ source: "deribit", price: 75_000, ts: nowMs }],
      attempted: 1, succeeded: 1, perSourceStatus: { deribit: "ok" }, pollLatencyMs: 1
    }),
    log: () => {}
  });
  await feedService.tick();
  const dvolService = new DvolService({ fetchOverride: async () => REGIME_DVOL[currentRegime], log: () => {} });
  await dvolService.tick();
  const anchorProvider: LiveAnchorProvider = {
    getAnchorForLeg: async (strike, optionType) => ({
      bullish: optionType === "put" ? { venue: "bullish", symbol: `X-${strike}-P`, askUsdcPerBtc: 1_000, depthWithin2pctBtc: 10, pulledAt: new Date().toISOString() } : null,
      deribit: optionType === "call" ? { venue: "deribit", symbol: `X-${strike}-C`, askUsdcPerBtc: 1_000, depthWithin2pctBtc: 10, pulledAt: new Date().toISOString() } : null
    })
  };
  const app = Fastify({ logger: false });
  await app.register(registerFoxifyV2Routes, { pool, feedService, dvolService, anchorProvider, executor: new MockStrangleExecutor() });
  await app.ready();
  return {
    app, pool,
    setRegime: async (r: Regime) => { currentRegime = r; await dvolService.tick(); },
    cleanup: async () => { feedService.stop(); dvolService.stop(); await app.close(); }
  };
};

test("ship readiness: cells allowed in calm/moderate activate (DVOL halt blocks elevated/stress)", async () => {
  // DVOL halt at >60 blocks elevated/stress. This is correct production behavior
  // until operator relaxes the threshold based on Wave C5 live validation.
  const { app, setRegime, cleanup } = await buildShipRig();
  try {
    const results: Array<{ regime: Regime; cellId: string; status: number }> = [];
    for (const regime of ["calm", "moderate"] as Regime[]) {
      await setRegime(regime);
      for (const cellId of DEFAULT_CELL_ALLOWLIST[regime]) {
        const r = await app.inject({
          method: "POST", url: "/foxify/v2/activate",
          headers: { "x-foxify-token": FOXIFY_TOKEN, "content-type": "application/json" },
          payload: { cellId, maxAcceptableHedgeCostUsdc: 20_000, foxifyPairRef: `fxy-${regime}-${cellId}-${Date.now()}-${Math.random()}` }
        });
        results.push({ regime, cellId, status: r.statusCode });
      }
    }
    const failures = results.filter((x) => x.status !== 201);
    assert.equal(failures.length, 0, `Calm/moderate failures: ${JSON.stringify(failures)}`);
  } finally { await cleanup(); }
});

test("ship readiness: elevated regime correctly halts (DVOL >60 guardrail)", async () => {
  const { app, setRegime, cleanup } = await buildShipRig();
  try {
    await setRegime("elevated");
    const r = await app.inject({
      method: "POST", url: "/foxify/v2/activate",
      headers: { "x-foxify-token": FOXIFY_TOKEN, "content-type": "application/json" },
      payload: { cellId: "pair_50k_5pct_otm", maxAcceptableHedgeCostUsdc: 20_000, foxifyPairRef: "fxy-elev" }
    });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().error, "atticus_halt");
  } finally { await cleanup(); }
});

test("ship readiness: cell NOT in regime allowlist → 503 cell_disabled_in_regime", async () => {
  const { app, setRegime, cleanup } = await buildShipRig();
  try {
    await setRegime("moderate");
    // pair_100k_3pct_itm_short is enabled but NOT in any default allowlist (V5/V6 broken)
    const r = await app.inject({
      method: "POST", url: "/foxify/v2/activate",
      headers: { "x-foxify-token": FOXIFY_TOKEN, "content-type": "application/json" },
      payload: { cellId: "pair_100k_3pct_itm_short", maxAcceptableHedgeCostUsdc: 20_000, foxifyPairRef: `fxy-block-${Date.now()}` }
    });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().error, "cell_disabled_in_regime");
    assert.ok(Array.isArray(r.json().details.suggested_cells));
  } finally { await cleanup(); }
});

test("ship readiness: deprecated cell (enabled: false) → 400 invalid_request", async () => {
  const { app, setRegime, cleanup } = await buildShipRig();
  try {
    await setRegime("moderate");
    // pair_25k_1pct_atm_micro is enabled: false (deprecated 2026-05-28)
    const r = await app.inject({
      method: "POST", url: "/foxify/v2/activate",
      headers: { "x-foxify-token": FOXIFY_TOKEN, "content-type": "application/json" },
      payload: { cellId: "pair_25k_1pct_atm_micro", maxAcceptableHedgeCostUsdc: 20_000, foxifyPairRef: `fxy-dep-${Date.now()}` }
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, "invalid_request");
    assert.match(r.json().message, /disabled/);
  } finally { await cleanup(); }
});

test("ship readiness: counterparty ledger records activate entries", async () => {
  const { app, pool, setRegime, cleanup } = await buildShipRig();
  try {
    // moderate regime (calm allowlist is empty post-V3) and use moderate-allowed cell
    await setRegime("moderate");
    const r = await app.inject({
      method: "POST", url: "/foxify/v2/activate",
      headers: { "x-foxify-token": FOXIFY_TOKEN, "content-type": "application/json" },
      payload: { cellId: "pair_25k_5pct_otm_3d", maxAcceptableHedgeCostUsdc: 20_000, foxifyPairRef: `fxy-ledger-${Date.now()}` }
    });
    assert.equal(r.statusCode, 201);
    const stmt = await getStatement(pool, "foxify");
    assert.ok(stmt.some((e) => e.kind === "hedge_funded"));
    const bal = await getBalance(pool, "foxify");
    assert.ok(bal < 0, "Foxify balance negative after funding hedge");
  } finally { await cleanup(); }
});

test("ship readiness: cell registry contains at least baseline + new 3d winner", () => {
  const cellIds = Object.keys(PHASE_0_CELLS);
  assert.ok(cellIds.length >= 7, `expected ≥7 cells, got ${cellIds.length}`);
  assert.ok(cellIds.includes("pair_25k_5pct_otm_3d"), "moderate winner must be registered");
  for (const id of cellIds) {
    const c = PHASE_0_CELLS[id];
    // Validate shape; some cells are intentionally enabled:false (deprecated but
    // kept for backward compat with shadow pairs referencing them).
    assert.ok(typeof c.enabled === "boolean");
    assert.ok(c.notionalUsdcPerLeg > 0);
    assert.ok(c.contractsBtc > 0);
    assert.ok(c.hedgeTenorDays > 0);
  }
  // At least the known winners should be enabled
  const enabledIds = cellIds.filter((id) => PHASE_0_CELLS[id].enabled);
  assert.ok(enabledIds.includes("pair_50k_2pct"));
  assert.ok(enabledIds.includes("pair_25k_5pct_otm_3d"));
  assert.ok(enabledIds.includes("pair_50k_5pct_otm"));
});

test("ship readiness: diagnostics surfaces all key system components", async () => {
  const { app, cleanup } = await buildShipRig();
  try {
    const r = await app.inject({ method: "GET", url: "/admin/foxify/v2/diagnostics", headers: { "x-admin-token": ADMIN_TOKEN } });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.ok(body.halt);
    assert.ok(body.status);
    assert.ok(body.dvol);
    assert.ok(body.feed);
    assert.ok(body.env);
  } finally { await cleanup(); }
});
