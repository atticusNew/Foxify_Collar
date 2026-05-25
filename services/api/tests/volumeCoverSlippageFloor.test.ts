/**
 * Unit tests for the TP slippage-floor decision logic (2026-05-21).
 *
 * The slippage floor is a Layer 1 / Layer 2 routing decision: discretionary
 * TP rules (5/6/10/11 by default) attempt a limit-IOC sell at a BS-derived
 * floor; emergency rules (1/7/9/12/W1) and disabled-feature/unsupported-
 * venue cases fall straight through to a market sell.
 *
 * `decideOrderTypeAndFloor` is a pure function — these tests cover all six
 * reason codes deterministically without DB or network setup.
 *
 * Default-OFF guarantee: with slippageFloorEnabled=false (production
 * default), every call returns market+feature_disabled regardless of
 * other inputs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  decideOrderTypeAndFloor,
  type HedgeManagerConfig
} from "../src/volumeCover/volumeCoverHedgeManager";
import type { HedgeLegRow } from "../src/volumeCover/volumeCoverDb";

const baseConfig = (overrides: Partial<HedgeManagerConfig> = {}): HedgeManagerConfig => ({
  tickIntervalMs: 60_000,
  useStub: false,
  timeDecayExitHours: 4,
  thinWindowUtcStart: 4,
  thinWindowUtcEnd: 6,
  gammaBandPct: 0.005,
  followthroughMinutes: 30,
  trailRetracePct: 0.20,
  thetaRateMult: 1.5,
  loserFloorPct: 0.20,
  loserGraceHours: 4,
  loserReversalPct: 0.5,
  staleHours: 1,
  nearAtmFloorPct: 0.65,
  nearAtmDaysRemaining: 5,
  volSpikeIvPct: 0.25,
  volSpikeValueMult: 1.2,
  hardFloorPct: 0.10,
  stubWinnerTimecapHours: 24,
  riskFreeRate: 0.045,
  fallbackIv: 0.45,
  slippageFloorEnabled: true,
  slippageBsTolerance: 0.15,
  slippageDiscretionaryRules: ["5_trail_retrace", "6_theta_vs_momentum", "10_near_atm", "11_vol_spike"],
  slippageMaxDefers: 3,
  slippageEnabledVenues: ["deribit"],
  ...overrides
});

const baseLeg = (overrides: Partial<HedgeLegRow> = {}): HedgeLegRow => ({
  id: "leg-1",
  positionId: "pos-1",
  venue: "deribit",
  optionKind: "put",
  strikeUsdc: 80_000,
  expiryIso: "2026-05-25T08:00:00Z",
  contracts: 1.0,
  buyPriceUsdc: 100,
  buyOrderId: null,
  sellPriceUsdc: null,
  sellOrderId: null,
  status: "open",
  openedAt: "2026-05-20T08:00:00Z",
  closedAt: null,
  metadata: {},
  retained: true,
  retainedAt: "2026-05-21T08:00:00Z",
  retainedReason: "post_trigger",
  retainedRole: "loser_post_trigger",
  repurposedFromPositionId: null,
  ladderHopCount: 0,
  runningMaxValueUsdc: 200,
  lastValueUsdc: 150,
  lastValueAt: "2026-05-22T08:00:00Z",
  tpDeferCount: 0,
  ...overrides
});

// ─── Default-off guarantee ───────────────────────────────────────────

test("Default OFF: any input returns market+feature_disabled when slippageFloorEnabled=false", () => {
  const cfg = baseConfig({ slippageFloorEnabled: false });
  const decision = decideOrderTypeAndFloor({
    cfg,
    ruleName: "5_trail_retrace", // would be discretionary
    venue: "deribit",
    leg: baseLeg(),
    currentValueUsdc: 200
  });
  assert.equal(decision.orderType, "market");
  assert.equal(decision.floorPriceUsdcPerBtc, undefined);
  assert.equal(decision.reason, "feature_disabled");
});

// ─── Layer 1 (limit IOC) happy path ──────────────────────────────────

test("Layer 1: discretionary rule + supported venue + value > 0 → limit_ioc with BS-floor", () => {
  const cfg = baseConfig({ slippageBsTolerance: 0.15 });
  const decision = decideOrderTypeAndFloor({
    cfg,
    ruleName: "5_trail_retrace",
    venue: "deribit",
    leg: baseLeg({ contracts: 1.0 }),
    currentValueUsdc: 200
  });
  assert.equal(decision.orderType, "limit_ioc");
  assert.equal(decision.reason, "discretionary");
  // floor = currentValue × (1 - tolerance) / contracts = 200 × 0.85 / 1.0 = 170
  assert.ok(decision.floorPriceUsdcPerBtc !== undefined);
  assert.equal(Number(decision.floorPriceUsdcPerBtc!.toFixed(4)), 170);
});

test("Layer 1: floor scales correctly with contracts > 1 and tolerance", () => {
  const cfg = baseConfig({ slippageBsTolerance: 0.25 });
  const decision = decideOrderTypeAndFloor({
    cfg,
    ruleName: "10_near_atm",
    venue: "deribit",
    leg: baseLeg({ contracts: 0.8 }),
    currentValueUsdc: 400
  });
  // floor = 400 × 0.75 / 0.8 = 375 USDC/BTC
  assert.equal(decision.orderType, "limit_ioc");
  assert.equal(Number(decision.floorPriceUsdcPerBtc!.toFixed(4)), 375);
});

test("Layer 1: matches discretionary rule by prefix (full rule names with descriptions still match)", () => {
  const cfg = baseConfig();
  const decision = decideOrderTypeAndFloor({
    cfg,
    ruleName: "6_theta_vs_momentum_decay_rate_exceeds",
    venue: "deribit",
    leg: baseLeg(),
    currentValueUsdc: 100
  });
  assert.equal(decision.orderType, "limit_ioc");
  assert.equal(decision.reason, "discretionary");
});

// ─── Layer 2 fall-through paths ──────────────────────────────────────

test("Layer 2: emergency rule (1_time_decay) always falls through to market", () => {
  const cfg = baseConfig();
  const decision = decideOrderTypeAndFloor({
    cfg,
    ruleName: "1_time_decay_exit",
    venue: "deribit",
    leg: baseLeg(),
    currentValueUsdc: 200
  });
  assert.equal(decision.orderType, "market");
  assert.equal(decision.reason, "emergency_rule");
});

test("Layer 2: emergency rule (7_loser_floor) always falls through", () => {
  const decision = decideOrderTypeAndFloor({
    cfg: baseConfig(),
    ruleName: "7_loser_floor",
    venue: "deribit",
    leg: baseLeg(),
    currentValueUsdc: 50
  });
  assert.equal(decision.orderType, "market");
  assert.equal(decision.reason, "emergency_rule");
});

test("Layer 2: emergency rule (9_stale_exit) always falls through", () => {
  const decision = decideOrderTypeAndFloor({
    cfg: baseConfig(),
    ruleName: "9_stale_exit",
    venue: "deribit",
    leg: baseLeg(),
    currentValueUsdc: 30
  });
  assert.equal(decision.orderType, "market");
  assert.equal(decision.reason, "emergency_rule");
});

test("Layer 2: emergency rule (12_hard_floor) always falls through", () => {
  const decision = decideOrderTypeAndFloor({
    cfg: baseConfig(),
    ruleName: "12_hard_floor",
    venue: "deribit",
    leg: baseLeg(),
    currentValueUsdc: 8
  });
  assert.equal(decision.orderType, "market");
  assert.equal(decision.reason, "emergency_rule");
});

test("Layer 2: emergency rule (W1_stub_winner_timecap) always falls through", () => {
  const decision = decideOrderTypeAndFloor({
    cfg: baseConfig(),
    ruleName: "W1_stub_winner_timecap",
    venue: "deribit",
    leg: baseLeg(),
    currentValueUsdc: 100
  });
  assert.equal(decision.orderType, "market");
  assert.equal(decision.reason, "emergency_rule");
});

test("Layer 2: unsupported venue (falconx) falls through to market", () => {
  // PR-B (2026-05-24): pilot Bullish `sellOption` now honors limit_ioc
  // + floor through the shared executeBullishIocLimit primitive, so
  // bullish is in the default `slippageEnabledVenues` list. FalconX
  // still does not implement limit_ioc — kept as the unsupported
  // sentinel here to assert the venue-gating path stays live.
  const decision = decideOrderTypeAndFloor({
    cfg: baseConfig({ slippageEnabledVenues: ["deribit", "bullish"] }),
    ruleName: "5_trail_retrace",
    venue: "falconx",
    leg: baseLeg({ venue: "falconx" }),
    currentValueUsdc: 200
  });
  assert.equal(decision.orderType, "market");
  assert.equal(decision.reason, "venue_unsupported");
});

test("Layer 2: venue case-insensitive match (FALCONX treated same as falconx)", () => {
  const decision = decideOrderTypeAndFloor({
    cfg: baseConfig({ slippageEnabledVenues: ["deribit", "bullish"] }),
    ruleName: "5_trail_retrace",
    venue: "FALCONX",
    leg: baseLeg({ venue: "FALCONX" }),
    currentValueUsdc: 200
  });
  assert.equal(decision.reason, "venue_unsupported");
});

test("PR-B Layer 2: bullish IS supported now (limit_ioc + floor wired)", () => {
  // Inverse of the legacy bullish-unsupported test: with the default
  // venue list (which now includes bullish), a discretionary rule on a
  // bullish leg goes through the slippage floor (limit_ioc + floor)
  // instead of falling through to a market sell.
  const decision = decideOrderTypeAndFloor({
    cfg: baseConfig({ slippageEnabledVenues: ["deribit", "bullish"] }),
    ruleName: "5_trail_retrace",
    venue: "bullish",
    leg: baseLeg({ venue: "bullish" }),
    currentValueUsdc: 200
  });
  assert.equal(decision.orderType, "limit_ioc");
  assert.equal(typeof decision.floorPriceUsdcPerBtc, "number");
});

test("Layer 2: defer-cap-reached (tpDeferCount >= maxDefers) falls through to market", () => {
  const decision = decideOrderTypeAndFloor({
    cfg: baseConfig({ slippageMaxDefers: 3 }),
    ruleName: "5_trail_retrace",
    venue: "deribit",
    leg: baseLeg({ tpDeferCount: 3 }), // hit the cap
    currentValueUsdc: 200
  });
  assert.equal(decision.orderType, "market");
  assert.equal(decision.reason, "fallthrough_cap");
});

test("Layer 2: zero value (currentValueUsdc <= 0) falls through to market", () => {
  const decision = decideOrderTypeAndFloor({
    cfg: baseConfig(),
    ruleName: "5_trail_retrace",
    venue: "deribit",
    leg: baseLeg(),
    currentValueUsdc: 0
  });
  assert.equal(decision.orderType, "market");
  assert.equal(decision.reason, "zero_value");
});

test("Layer 2: negative value also falls through to market", () => {
  const decision = decideOrderTypeAndFloor({
    cfg: baseConfig(),
    ruleName: "5_trail_retrace",
    venue: "deribit",
    leg: baseLeg(),
    currentValueUsdc: -10
  });
  assert.equal(decision.orderType, "market");
  assert.equal(decision.reason, "zero_value");
});

test("Layer 2: zero-contracts leg falls through (cannot floor 0 BTC)", () => {
  const decision = decideOrderTypeAndFloor({
    cfg: baseConfig(),
    ruleName: "5_trail_retrace",
    venue: "deribit",
    leg: baseLeg({ contracts: 0 }),
    currentValueUsdc: 100
  });
  assert.equal(decision.orderType, "market");
  assert.equal(decision.reason, "zero_value");
});

// ─── Custom configuration ────────────────────────────────────────────

test("Custom slippageDiscretionaryRules list: ruleName not in list → emergency_rule", () => {
  const cfg = baseConfig({
    slippageDiscretionaryRules: ["10_near_atm"] // ONLY 10_near_atm is discretionary
  });
  const decision = decideOrderTypeAndFloor({
    cfg,
    ruleName: "5_trail_retrace",
    venue: "deribit",
    leg: baseLeg(),
    currentValueUsdc: 200
  });
  assert.equal(decision.orderType, "market");
  assert.equal(decision.reason, "emergency_rule");
});

test("Custom slippageEnabledVenues: deribit not in list → venue_unsupported", () => {
  const cfg = baseConfig({
    slippageEnabledVenues: ["someothervenue"]
  });
  const decision = decideOrderTypeAndFloor({
    cfg,
    ruleName: "5_trail_retrace",
    venue: "deribit",
    leg: baseLeg(),
    currentValueUsdc: 200
  });
  assert.equal(decision.orderType, "market");
  assert.equal(decision.reason, "venue_unsupported");
});

// ─── Decision precedence ─────────────────────────────────────────────

test("Precedence: feature_disabled wins over emergency_rule and venue_unsupported", () => {
  const cfg = baseConfig({ slippageFloorEnabled: false });
  // Even with a non-discretionary rule on an unsupported venue, the
  // disabled flag short-circuits to feature_disabled.
  const decision = decideOrderTypeAndFloor({
    cfg,
    ruleName: "1_time_decay_exit",
    venue: "bullish",
    leg: baseLeg({ venue: "bullish" }),
    currentValueUsdc: 200
  });
  assert.equal(decision.reason, "feature_disabled");
});

test("Precedence: venue_unsupported wins over emergency_rule", () => {
  const decision = decideOrderTypeAndFloor({
    cfg: baseConfig(),
    ruleName: "1_time_decay_exit", // emergency
    venue: "bullish", // unsupported
    leg: baseLeg({ venue: "bullish" }),
    currentValueUsdc: 200
  });
  assert.equal(decision.reason, "venue_unsupported");
});

test("Precedence: fallthrough_cap wins over zero_value", () => {
  const decision = decideOrderTypeAndFloor({
    cfg: baseConfig({ slippageMaxDefers: 3 }),
    ruleName: "5_trail_retrace",
    venue: "deribit",
    leg: baseLeg({ tpDeferCount: 3 }), // cap hit
    currentValueUsdc: 0 // also zero
  });
  assert.equal(decision.reason, "fallthrough_cap");
});
