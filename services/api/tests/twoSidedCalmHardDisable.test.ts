/**
 * Calm hard-disable gate (2026-05-31).
 *
 * Calm is a validated permanent stand-down (no structure profitable: long loses
 * to theta+friction; short premium is negative-EV and worsens with size). The
 * activate handler blocks calm BEFORE the allowlist/override lookup, so a DB
 * override cannot re-enable it. Escape hatch: SS_TWO_SIDED_ALLOW_CALM=true.
 *
 * Also asserts the moderate sweep winner cell (pair_150k_3pct_atm_3d) is wired
 * into the config + allowlist, and that calm's allowlist is empty.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { ensureTwoSidedSchema } from "../src/singleSide/twoSided/db";
import { handleActivate, isCalmActivationAllowed, isCalmShadowAllowed } from "../src/singleSide/twoSided/activateHandler";
import { MockStrangleExecutor } from "../src/singleSide/twoSided/executor";
import { PHASE_0_CELLS } from "../src/singleSide/twoSided/cellConfig";
import { DEFAULT_CELL_ALLOWLIST, ensureCellAllowlistSchema } from "../src/singleSide/twoSided/cellAllowlist";
import type { AggregatedFeed } from "../src/singleSide/twoSided/feedAggregator";
import type { LiveAnchorProvider } from "../src/singleSide/twoSided/quoteEngine";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  await ensureCellAllowlistSchema(pool);
  return pool;
};

const makeFeed = (price = 76_000, asOfMs = Date.now()): AggregatedFeed => ({
  canonicalPrice: price, asOfMs,
  sources: [{ source: "bullish", price, ts: asOfMs }, { source: "deribit", price: price + 1, ts: asOfMs }],
  rejected: [], expired: [], health: "healthy", medianCalcDescription: `median=${price}`
});

const anchorProvider: LiveAnchorProvider = {
  getAnchorForLeg: async (strike, optionType) => optionType === "put"
    ? { bullish: { venue: "bullish", symbol: `BTC-${strike}-P`, askUsdcPerBtc: 1_150, depthWithin2pctBtc: 5.0, pulledAt: new Date().toISOString() }, deribit: null }
    : { bullish: null, deribit: { venue: "deribit", symbol: `BTC-${strike}-C`, askUsdcPerBtc: 1_162, depthWithin2pctBtc: 5.0, pulledAt: new Date().toISOString() } }
};

const depsWithRegime = (pool: import("pg").Pool, regime: "calm" | "moderate" | "elevated" | "stress" | null) => ({
  pool, anchorProvider, executor: new MockStrangleExecutor(),
  getFeed: () => makeFeed(), feedVersion: "v1.0.0",
  nowMs: () => Date.parse("2026-05-27T18:00:00Z"),
  getCurrentRegime: () => regime
});

const withEnv = async (val: string | undefined, fn: () => Promise<void>) => {
  const prev = process.env.SS_TWO_SIDED_ALLOW_CALM;
  if (val === undefined) delete process.env.SS_TWO_SIDED_ALLOW_CALM;
  else process.env.SS_TWO_SIDED_ALLOW_CALM = val;
  try { await fn(); } finally {
    if (prev === undefined) delete process.env.SS_TWO_SIDED_ALLOW_CALM;
    else process.env.SS_TWO_SIDED_ALLOW_CALM = prev;
  }
};

test("isCalmActivationAllowed: default false; true only when env === 'true'", async () => {
  await withEnv(undefined, async () => assert.equal(isCalmActivationAllowed(), false));
  await withEnv("false", async () => assert.equal(isCalmActivationAllowed(), false));
  await withEnv("TRUE", async () => assert.equal(isCalmActivationAllowed(), true));
  await withEnv("true", async () => assert.equal(isCalmActivationAllowed(), true));
});

test("isCalmShadowAllowed: default TRUE (calm shadow data accrues); false only when explicitly disabled", () => {
  const prev = process.env.SS_TWO_SIDED_ALLOW_CALM_SHADOW;
  try {
    delete process.env.SS_TWO_SIDED_ALLOW_CALM_SHADOW;
    assert.equal(isCalmShadowAllowed(), true, "default allows calm shadow (zero-risk data)");
    process.env.SS_TWO_SIDED_ALLOW_CALM_SHADOW = "true";
    assert.equal(isCalmShadowAllowed(), true);
    process.env.SS_TWO_SIDED_ALLOW_CALM_SHADOW = "false";
    assert.equal(isCalmShadowAllowed(), false, "operator can suppress calm shadow");
  } finally {
    if (prev === undefined) delete process.env.SS_TWO_SIDED_ALLOW_CALM_SHADOW;
    else process.env.SS_TWO_SIDED_ALLOW_CALM_SHADOW = prev;
  }
});

test("handleActivate: calm is hard-disabled by default (503 calm_regime_disabled, before allowlist)", async () => {
  const pool = await buildPool();
  await withEnv(undefined, async () => {
    const res = await handleActivate(
      { cellId: "pair_50k_2pct", maxAcceptableHedgeCostUsdc: 3_500, foxifyPairRef: "calm-block-1" },
      depsWithRegime(pool, "calm")
    );
    assert.equal(res.status, 503);
    if (res.status !== 503) return;
    assert.equal(res.body.error, "calm_regime_disabled");
  });
});

test("handleActivate: SS_TWO_SIDED_ALLOW_CALM=true bypasses the calm hard-gate (falls through to allowlist)", async () => {
  const pool = await buildPool();
  await withEnv("true", async () => {
    const res = await handleActivate(
      { cellId: "pair_50k_2pct", maxAcceptableHedgeCostUsdc: 3_500, foxifyPairRef: "calm-allow-1" },
      depsWithRegime(pool, "calm")
    );
    // Past the calm hard-gate now → normal regime allowlist applies. Calm allowlist
    // is empty, so this becomes cell_disabled_in_regime — NOT calm_regime_disabled.
    assert.equal(res.status, 503);
    if (res.status !== 503) return;
    assert.equal(res.body.error, "cell_disabled_in_regime");
  });
});

test("handleActivate: non-calm (moderate) is unaffected by the calm gate (201)", async () => {
  const pool = await buildPool();
  await withEnv(undefined, async () => {
    // Use an allowlisted moderate cell (pair_50k_2pct was pruned 2026-06-01).
    const res = await handleActivate(
      { cellId: "pair_50k_3pct_atm_3d", maxAcceptableHedgeCostUsdc: 6_000, foxifyPairRef: "mod-ok-1" },
      depsWithRegime(pool, "moderate")
    );
    assert.equal(res.status, 201, `expected 201, got ${res.status} ${JSON.stringify((res as { body: unknown }).body)}`);
  });
});

test("moderate winner pair_150k_3pct_atm_3d is wired (config + allowlist); calm allowlist empty", () => {
  const cell = PHASE_0_CELLS.pair_150k_3pct_atm_3d;
  assert.ok(cell, "cell exists");
  assert.equal(cell.enabled, true);
  assert.equal(cell.notionalUsdcPerLeg, 150_000);
  assert.equal(cell.putStrikeItmPct, 0, "ATM put");
  assert.equal(cell.callStrikeItmPct, 0, "ATM call");
  assert.equal(cell.hedgeTenorDays, 3);
  assert.equal(cell.triggerPctDown, 0.03);
  assert.ok(DEFAULT_CELL_ALLOWLIST.moderate.includes("pair_150k_3pct_atm_3d"), "in moderate allowlist");
  assert.ok(DEFAULT_CELL_ALLOWLIST.elevated.includes("pair_150k_3pct_atm_3d"), "in elevated allowlist");
  assert.ok(DEFAULT_CELL_ALLOWLIST.stress.includes("pair_150k_3pct_atm_3d"), "in stress allowlist");
  assert.equal(DEFAULT_CELL_ALLOWLIST.calm.length, 0, "calm allowlist stays empty");
});
