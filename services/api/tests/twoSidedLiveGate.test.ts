/**
 * LIVE-ACTIVATION SAFETY RAILS.
 *
 * Rail 1 — checkLiveEnabled is ENFORCED in handleActivate for non-shadow (live)
 *   activations, but ONLY when the server is in live-execution mode
 *   (FOXIFY_V2_LIVE_EXECUTION=true). It gates on SS_TWO_SIDED_LIVE_ENABLED +
 *   SS_TWO_SIDED_CELL_ALLOWLIST + SS_TWO_SIDED_MAX_PAIRS_PER_DAY.
 * Rail 2 — a request with isShadow=true ALWAYS uses the shadow executor (paper),
 *   even when the live executor is wired → is_shadow=true can never place real orders.
 *
 * Backward-compat: when FOXIFY_V2_LIVE_EXECUTION is unset (the normal/shadow deploy),
 * the gate is skipped entirely so existing flows are unchanged.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { handleActivate, type ActivateDeps } from "../src/singleSide/twoSided/activateHandler";
import { ensureTwoSidedSchema } from "../src/singleSide/twoSided/db";
import { ensureCellAllowlistSchema } from "../src/singleSide/twoSided/cellAllowlist";
import type { AggregatedFeed } from "../src/singleSide/twoSided/feedAggregator";
import type { LiveAnchorProvider } from "../src/singleSide/twoSided/quoteEngine";
import type { StrangleExecutor } from "../src/singleSide/twoSided/executor";

const CELL = "pair_50k_3pct_atm_3d"; // moderate-allowlisted ATM straddle

const buildPool = async (): Promise<Pool> => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, impure: true, implementation: () => randomUUID() });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  await ensureCellAllowlistSchema(pool);
  return pool;
};

const makeFeed = (price = 76_000): AggregatedFeed => ({
  canonicalPrice: price, asOfMs: Date.now(),
  sources: [{ source: "deribit", price, ts: Date.now() }, { source: "bullish", price: price + 1, ts: Date.now() }],
  rejected: [], expired: [], health: "healthy", medianCalcDescription: `m=${price}`
});

const anchorProvider: LiveAnchorProvider = {
  getAnchorForLeg: async (strike, optionType) => optionType === "put"
    ? { bullish: { venue: "bullish", symbol: `BTC-${strike}-P`, askUsdcPerBtc: 1_150, depthWithin2pctBtc: 5.0, pulledAt: new Date().toISOString() }, deribit: null }
    : { bullish: null, deribit: { venue: "deribit", symbol: `BTC-${strike}-C`, askUsdcPerBtc: 1_162, depthWithin2pctBtc: 5.0, pulledAt: new Date().toISOString() } }
};

/** A marker executor that records whether it was used. */
const markerExecutor = (tag: { used: boolean }): StrangleExecutor => ({
  executeStrangle: async () => {
    tag.used = true;
    const iso = new Date().toISOString();
    return { ok: true, putLeg: { filledAskUsdcPerBtc: 1_150, filledAtIso: iso }, callLeg: { filledAskUsdcPerBtc: 1_162, filledAtIso: iso } };
  }
} as unknown as StrangleExecutor);

const baseDeps = (pool: Pool, executor: StrangleExecutor, shadowExecutor?: StrangleExecutor): ActivateDeps => ({
  pool, anchorProvider, executor, shadowExecutor,
  getFeed: () => makeFeed(), feedVersion: "v1.0.0",
  nowMs: () => Date.parse("2026-06-01T12:00:00Z"),
  getCurrentRegime: () => "moderate"
});

const ENV_KEYS = ["FOXIFY_V2_LIVE_EXECUTION", "SS_TWO_SIDED_LIVE_ENABLED", "SS_TWO_SIDED_CELL_ALLOWLIST", "SS_TWO_SIDED_MAX_PAIRS_PER_DAY"] as const;
const withEnv = async (env: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => Promise<void>) => {
  const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]!; }
  try { await fn(); } finally {
    for (const k of ENV_KEYS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!; }
  }
};

const activate = (deps: ActivateDeps, extra: Record<string, unknown> = {}) =>
  handleActivate({ cellId: CELL, maxAcceptableHedgeCostUsdc: 10_000, foxifyPairRef: `t-${Math.random()}`, ...extra }, deps);

test("backward-compat: live gate SKIPPED when FOXIFY_V2_LIVE_EXECUTION unset (non-shadow still activates)", async () => {
  const pool = await buildPool();
  const tag = { used: false };
  await withEnv({}, async () => {
    const r = await activate(baseDeps(pool, markerExecutor(tag)));
    assert.equal(r.status, 201, `expected 201, got ${r.status} ${JSON.stringify((r as { body: unknown }).body)}`);
    assert.equal(tag.used, true, "configured executor used");
  });
});

test("Rail 1: live execution ON + LIVE_ENABLED unset → 503 live_flag_disabled", async () => {
  const pool = await buildPool();
  await withEnv({ FOXIFY_V2_LIVE_EXECUTION: "true" }, async () => {
    const r = await activate(baseDeps(pool, markerExecutor({ used: false })));
    assert.equal(r.status, 503);
    if (r.status === 503) assert.equal(r.body.error, "live_flag_disabled");
  });
});

test("Rail 1: live ON + LIVE_ENABLED=true but cell NOT in SS_TWO_SIDED_CELL_ALLOWLIST → 503 cell_not_in_allowlist", async () => {
  const pool = await buildPool();
  await withEnv({ FOXIFY_V2_LIVE_EXECUTION: "true", SS_TWO_SIDED_LIVE_ENABLED: "true", SS_TWO_SIDED_CELL_ALLOWLIST: "some_other_cell" }, async () => {
    const r = await activate(baseDeps(pool, markerExecutor({ used: false })));
    assert.equal(r.status, 503);
    if (r.status === 503) assert.equal(r.body.error, "cell_not_in_allowlist");
  });
});

test("Rail 1: live ON + LIVE_ENABLED=true + cell allowlisted + under cap → 201 via LIVE executor", async () => {
  const pool = await buildPool();
  const tag = { used: false };
  await withEnv({ FOXIFY_V2_LIVE_EXECUTION: "true", SS_TWO_SIDED_LIVE_ENABLED: "true", SS_TWO_SIDED_CELL_ALLOWLIST: CELL, SS_TWO_SIDED_MAX_PAIRS_PER_DAY: "1" }, async () => {
    const r = await activate(baseDeps(pool, markerExecutor(tag)));
    assert.equal(r.status, 201, `expected 201, got ${r.status} ${JSON.stringify((r as { body: unknown }).body)}`);
    assert.equal(tag.used, true, "LIVE executor used for non-shadow live activation");
  });
});

test("Rail 1: daily cap enforced — second live pair blocked with daily_cap_reached", async () => {
  const pool = await buildPool();
  await withEnv({ FOXIFY_V2_LIVE_EXECUTION: "true", SS_TWO_SIDED_LIVE_ENABLED: "true", SS_TWO_SIDED_CELL_ALLOWLIST: CELL, SS_TWO_SIDED_MAX_PAIRS_PER_DAY: "1" }, async () => {
    const first = await activate(baseDeps(pool, markerExecutor({ used: false })));
    assert.equal(first.status, 201, "first live pair activates");
    const second = await activate(baseDeps(pool, markerExecutor({ used: false })));
    assert.equal(second.status, 503);
    if (second.status === 503) assert.equal(second.body.error, "daily_cap_reached");
  });
});

test("Rail 3 (Phase C): live ON + balance reader reports insufficient venue funds → 503 insufficient_venue_balance, executor NOT used", async () => {
  const pool = await buildPool();
  const tag = { used: false };
  await withEnv({ FOXIFY_V2_LIVE_EXECUTION: "true", SS_TWO_SIDED_LIVE_ENABLED: "true", SS_TWO_SIDED_CELL_ALLOWLIST: CELL, SS_TWO_SIDED_MAX_PAIRS_PER_DAY: "5" }, async () => {
    const deps: ActivateDeps = {
      ...baseDeps(pool, markerExecutor(tag)),
      venueBalanceReader: {
        getBullishAvailableUsdc: async () => 10, // way short of the bullish put-leg premium
        getDeribitAvailableBtc: async () => 100  // ample on deribit
      }
    };
    const r = await activate(deps);
    assert.equal(r.status, 503, `expected 503, got ${r.status} ${JSON.stringify((r as { body: unknown }).body)}`);
    if (r.status === 503) assert.equal(r.body.error, "insufficient_venue_balance");
    assert.equal(tag.used, false, "no order should fire when a venue is underfunded");
  });
});

test("Rail 3 (Phase C): live ON + balance reader reports ample funds → 201 (guard passes through)", async () => {
  const pool = await buildPool();
  const tag = { used: false };
  await withEnv({ FOXIFY_V2_LIVE_EXECUTION: "true", SS_TWO_SIDED_LIVE_ENABLED: "true", SS_TWO_SIDED_CELL_ALLOWLIST: CELL, SS_TWO_SIDED_MAX_PAIRS_PER_DAY: "5" }, async () => {
    const deps: ActivateDeps = {
      ...baseDeps(pool, markerExecutor(tag)),
      venueBalanceReader: {
        getBullishAvailableUsdc: async () => 1_000_000,
        getDeribitAvailableBtc: async () => 100
      }
    };
    const r = await activate(deps);
    assert.equal(r.status, 201, `expected 201, got ${r.status} ${JSON.stringify((r as { body: unknown }).body)}`);
    assert.equal(tag.used, true, "executor fires once balances are sufficient");
  });
});

test("Rail 2: isShadow=true uses the SHADOW executor (paper), never the live executor — and skips the live gate", async () => {
  const pool = await buildPool();
  const live = { used: false };
  const shadow = { used: false };
  // Live execution ON, but LIVE_ENABLED unset → a non-shadow request would be blocked.
  // A shadow request must BYPASS the gate AND route to the shadow executor.
  await withEnv({ FOXIFY_V2_LIVE_EXECUTION: "true" }, async () => {
    const deps = baseDeps(pool, markerExecutor(live), markerExecutor(shadow));
    const r = await activate(deps, { isShadow: true });
    assert.equal(r.status, 201, `shadow request should activate, got ${r.status} ${JSON.stringify((r as { body: unknown }).body)}`);
    assert.equal(shadow.used, true, "shadow executor used");
    assert.equal(live.used, false, "LIVE executor MUST NOT be used for an is_shadow=true request");
  });
});
