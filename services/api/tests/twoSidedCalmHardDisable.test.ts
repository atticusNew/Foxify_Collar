/**
 * Calm hard-disable gate (2026-05-31).
 *
 * Calm is a validated permanent stand-down (no structure profitable: long loses
 * to theta+friction; short premium is negative-EV and worsens with size). The
 * activate handler blocks calm BEFORE the allowlist/override lookup, so a DB
 * override cannot re-enable it. Escape hatch: SS_TWO_SIDED_ALLOW_CALM=true.
 *
 * Also asserts the moderate sweep winner cell (pair_150k_3pct_atm_3d) is wired
 * into the config + allowlist, and that calm's allowlist holds ONLY the budgeted
 * loss-leader cells (pair_25k_5otm_strangle_2d/1d) — which remain hard-gated.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { ensureTwoSidedSchema } from "../src/singleSide/twoSided/db";
import { handleActivate, isCalmActivationAllowed, isCalmShadowAllowed, isCalmLossLeaderEnabled, calmMaxLossUsdc } from "../src/singleSide/twoSided/activateHandler";
import { MockStrangleExecutor } from "../src/singleSide/twoSided/executor";
import { PHASE_0_CELLS } from "../src/singleSide/twoSided/cellConfig";
import { DEFAULT_CELL_ALLOWLIST, ensureCellAllowlistSchema, setCellOverride } from "../src/singleSide/twoSided/cellAllowlist";
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

// ── Phase 3: calm loss-leader (budgeted) ──

const withLossLeader = async (enabled: boolean, maxLoss: string | undefined, fn: () => Promise<void>) => {
  const prevLL = process.env.SS_TWO_SIDED_CALM_LOSS_LEADER;
  const prevMax = process.env.SS_TWO_SIDED_CALM_MAX_LOSS_USDC;
  const prevAllow = process.env.SS_TWO_SIDED_ALLOW_CALM;
  delete process.env.SS_TWO_SIDED_ALLOW_CALM; // ensure NOT blanket-allow
  process.env.SS_TWO_SIDED_CALM_LOSS_LEADER = enabled ? "true" : "false";
  if (maxLoss === undefined) delete process.env.SS_TWO_SIDED_CALM_MAX_LOSS_USDC;
  else process.env.SS_TWO_SIDED_CALM_MAX_LOSS_USDC = maxLoss;
  try { await fn(); } finally {
    if (prevLL === undefined) delete process.env.SS_TWO_SIDED_CALM_LOSS_LEADER; else process.env.SS_TWO_SIDED_CALM_LOSS_LEADER = prevLL;
    if (prevMax === undefined) delete process.env.SS_TWO_SIDED_CALM_MAX_LOSS_USDC; else process.env.SS_TWO_SIDED_CALM_MAX_LOSS_USDC = prevMax;
    if (prevAllow === undefined) delete process.env.SS_TWO_SIDED_ALLOW_CALM; else process.env.SS_TWO_SIDED_ALLOW_CALM = prevAllow;
  }
};

test("isCalmLossLeaderEnabled default false; calmMaxLossUsdc default 25", () => {
  const prev = process.env.SS_TWO_SIDED_CALM_LOSS_LEADER, prevM = process.env.SS_TWO_SIDED_CALM_MAX_LOSS_USDC;
  try {
    delete process.env.SS_TWO_SIDED_CALM_LOSS_LEADER; delete process.env.SS_TWO_SIDED_CALM_MAX_LOSS_USDC;
    assert.equal(isCalmLossLeaderEnabled(), false);
    assert.equal(calmMaxLossUsdc(), 25);
    process.env.SS_TWO_SIDED_CALM_LOSS_LEADER = "true"; process.env.SS_TWO_SIDED_CALM_MAX_LOSS_USDC = "40";
    assert.equal(isCalmLossLeaderEnabled(), true);
    assert.equal(calmMaxLossUsdc(), 40);
  } finally {
    if (prev === undefined) delete process.env.SS_TWO_SIDED_CALM_LOSS_LEADER; else process.env.SS_TWO_SIDED_CALM_LOSS_LEADER = prev;
    if (prevM === undefined) delete process.env.SS_TWO_SIDED_CALM_MAX_LOSS_USDC; else process.env.SS_TWO_SIDED_CALM_MAX_LOSS_USDC = prevM;
  }
});

test("calm loss-leader: mode relaxes the calm hard-gate (reaches allowlist instead of calm_regime_disabled)", async () => {
  const pool = await buildPool();
  await withLossLeader(true, "5000", async () => {
    // pair_50k_2pct is NOT in the (empty) calm allowlist → with the gate relaxed we
    // should fall through to the allowlist check, not the calm hard-disable.
    const res = await handleActivate(
      { cellId: "pair_50k_2pct", maxAcceptableHedgeCostUsdc: 6000, foxifyPairRef: "ll-gate-1" },
      depsWithRegime(pool, "calm")
    );
    assert.equal(res.status, 503);
    if (res.status !== 503) return;
    assert.equal(res.body.error, "cell_disabled_in_regime", "gate relaxed → allowlist enforced (not calm_regime_disabled)");
  });
});

test("calm loss-leader: enforces per-pair budget (over → blocked, within → activates)", async () => {
  const pool = await buildPool();
  // Allow pair_50k_2pct in calm so we reach the budget check.
  await setCellOverride(pool, "calm", "pair_50k_2pct", true, "loss-leader test", "test");
  // Premium ~ 0.658 BTC * (1150+1162) ≈ $1,521 at the harness anchors.
  await withLossLeader(true, "50", async () => {
    const over = await handleActivate(
      { cellId: "pair_50k_2pct", maxAcceptableHedgeCostUsdc: 6000, foxifyPairRef: "ll-over-1" },
      depsWithRegime(pool, "calm")
    );
    assert.equal(over.status, 503);
    if (over.status === 503) assert.equal(over.body.error, "calm_loss_exceeds_budget", "premium > $50 budget → blocked");
  });
  await withLossLeader(true, "5000", async () => {
    const within = await handleActivate(
      { cellId: "pair_50k_2pct", maxAcceptableHedgeCostUsdc: 6000, foxifyPairRef: "ll-within-1" },
      depsWithRegime(pool, "calm")
    );
    assert.equal(within.status, 201, `within budget → activates; got ${within.status} ${JSON.stringify((within as { body: unknown }).body)}`);
  });
});

test("moderate winner pair_150k_3pct_atm_3d is wired (config + allowlist); calm holds only loss-leader cells", () => {
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
  // calm = ONLY the budgeted loss-leader cells (still hard-gated); the straddle winner is never calm-allowed.
  assert.deepEqual(
    [...DEFAULT_CELL_ALLOWLIST.calm].sort(),
    ["pair_25k_5otm_strangle_1d", "pair_25k_5otm_strangle_2d"],
    "calm allowlist = loss-leader cells only"
  );
  assert.ok(!DEFAULT_CELL_ALLOWLIST.calm.includes("pair_150k_3pct_atm_3d"));
});

// ── Calm loss-leader cells: full wiring (config + allowlist + gate) ──

test("loss-leader cells pair_25k_5otm_strangle_2d/1d are wired in config (5% OTM strangle geometry)", () => {
  for (const [id, tenor] of [["pair_25k_5otm_strangle_2d", 2], ["pair_25k_5otm_strangle_1d", 1]] as const) {
    const cell = PHASE_0_CELLS[id];
    assert.ok(cell, `${id} exists in registry`);
    assert.equal(cell.enabled, true, `${id} enabled`);
    assert.equal(cell.notionalUsdcPerLeg, 25_000, `${id} is 25k`);
    assert.equal(cell.hedgeTenorDays, tenor, `${id} tenor`);
    assert.equal(cell.triggerPctDown, 0.03);
    assert.equal(cell.triggerPctUp, 0.03);
    // 5% OTM strangle: put 5% below spot, call 5% above spot (computeStrikes uses
    // 1+putItm for put and 1-callItm for call, so both = -0.05 → ±5% OTM).
    assert.equal(cell.putStrikeItmPct, -0.05, `${id} put 5% OTM`);
    assert.equal(cell.callStrikeItmPct, -0.05, `${id} call 5% OTM`);
  }
});

test("loss-leader cells are calm-allowlisted (default), so loss-leader mode reaches the BUDGET gate (not cell_disabled_in_regime)", async () => {
  const pool = await buildPool();
  // Tiny budget → allowlist passes (cell IS calm-allowed) but budget rejects.
  // This proves the cell is wired into the calm allowlist (otherwise we'd get
  // cell_disabled_in_regime BEFORE the budget check).
  await withLossLeader(true, "1", async () => {
    const res = await handleActivate(
      { cellId: "pair_25k_5otm_strangle_2d", maxAcceptableHedgeCostUsdc: 6000, foxifyPairRef: "ll-cell-2d-budget" },
      depsWithRegime(pool, "calm")
    );
    assert.equal(res.status, 503);
    if (res.status !== 503) return;
    assert.equal(
      res.body.error,
      "calm_loss_exceeds_budget",
      `expected budget gate (cell is calm-allowlisted), got ${res.body.error}`
    );
  });
});

test("loss-leader cell activates in calm when budget covers the premium (full wiring end-to-end)", async () => {
  const pool = await buildPool();
  // Huge budget → past calm gate + allowlist + budget → 201.
  await withLossLeader(true, "100000", async () => {
    const res = await handleActivate(
      { cellId: "pair_25k_5otm_strangle_1d", maxAcceptableHedgeCostUsdc: 100000, foxifyPairRef: "ll-cell-1d-ok" },
      depsWithRegime(pool, "calm")
    );
    assert.equal(res.status, 201, `expected 201, got ${res.status} ${JSON.stringify((res as { body: unknown }).body)}`);
    if (res.status !== 201) return;
    assert.equal(res.body.cell_id, "pair_25k_5otm_strangle_1d");
  });
});
