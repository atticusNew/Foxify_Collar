/**
 * PR 11 tests — feature flag + cell allowlist + newborn review.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import {
  getLiveFlagConfig,
  checkLiveEnabled,
  applyBootHalt,
  ensureNewbornReviewSchema,
  getNewbornState,
  recordNewbornTrigger,
  clearNewbornReview,
  classifyRegime
} from "../src/singleSide/twoSided/featureFlag";
import { ensureGuardrailsSchema, getHaltState } from "../src/singleSide/twoSided/guardrails";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureGuardrailsSchema(pool);
  await ensureNewbornReviewSchema(pool);
  return pool;
};

test("getLiveFlagConfig: defaults when env unset", () => {
  const cfg = getLiveFlagConfig({});
  assert.equal(cfg.liveEnabled, false);
  assert.ok(cfg.cellAllowlist.has("pair_50k_2pct"));
  assert.equal(cfg.maxPairsPerDay, 2);
  assert.equal(cfg.bootHalt, true);
  assert.equal(cfg.newbornReviewCountPerRegime, 3);
});

test("getLiveFlagConfig: env overrides", () => {
  const cfg = getLiveFlagConfig({
    SS_TWO_SIDED_LIVE_ENABLED: "true",
    SS_TWO_SIDED_CELL_ALLOWLIST: "pair_50k_2pct,pair_100k_3pct",
    SS_TWO_SIDED_MAX_PAIRS_PER_DAY: "10",
    SS_TWO_SIDED_BOOT_HALT: "false",
    SS_TWO_SIDED_NEWBORN_REVIEW_PER_REGIME: "5"
  });
  assert.equal(cfg.liveEnabled, true);
  assert.ok(cfg.cellAllowlist.has("pair_100k_3pct"));
  assert.equal(cfg.maxPairsPerDay, 10);
  assert.equal(cfg.bootHalt, false);
  assert.equal(cfg.newbornReviewCountPerRegime, 5);
});

test("checkLiveEnabled: blocked when live_flag_disabled (default)", () => {
  const cfg = getLiveFlagConfig({});
  const r = checkLiveEnabled(cfg, "pair_50k_2pct", 0);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "live_flag_disabled");
});

test("checkLiveEnabled: blocked when cell not in allowlist", () => {
  const cfg = getLiveFlagConfig({ SS_TWO_SIDED_LIVE_ENABLED: "true" });
  const r = checkLiveEnabled(cfg, "pair_unauthorized", 0);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "cell_not_in_allowlist");
});

test("checkLiveEnabled: blocked when daily cap reached", () => {
  const cfg = getLiveFlagConfig({ SS_TWO_SIDED_LIVE_ENABLED: "true" });
  const r = checkLiveEnabled(cfg, "pair_50k_2pct", 2); // cap is 2
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "daily_cap_reached");
});

test("checkLiveEnabled: allowed when all gates pass", () => {
  const cfg = getLiveFlagConfig({ SS_TWO_SIDED_LIVE_ENABLED: "true" });
  const r = checkLiveEnabled(cfg, "pair_50k_2pct", 1);
  assert.equal(r.allowed, true);
});

test("applyBootHalt: when bootHalt=true, records atticus halt", async () => {
  const pool = await buildPool();
  await applyBootHalt(pool, getLiveFlagConfig({}));
  const s = await getHaltState(pool);
  assert.equal(s.atticusHalt, true);
  assert.equal(s.atticusHaltReason, "manual_operator");
});

test("applyBootHalt: when bootHalt=false, no halt", async () => {
  const pool = await buildPool();
  await applyBootHalt(pool, getLiveFlagConfig({ SS_TWO_SIDED_BOOT_HALT: "false" }));
  const s = await getHaltState(pool);
  assert.equal(s.atticusHalt, false);
});

test("Newborn review: starts at 0 approved, requires review", async () => {
  const pool = await buildPool();
  const s = await getNewbornState(pool, "calm", 3);
  assert.equal(s.triggersObserved, 0);
  assert.equal(s.operatorApprovedCount, 0);
  assert.equal(s.reviewRequired, true);
});

test("Newborn review: recordNewbornTrigger increments observed count", async () => {
  const pool = await buildPool();
  await recordNewbornTrigger(pool, "calm");
  await recordNewbornTrigger(pool, "calm");
  const s = await getNewbornState(pool, "calm", 3);
  assert.equal(s.triggersObserved, 2);
});

test("Newborn review: clearNewbornReview marks approval; after threshold no review required", async () => {
  const pool = await buildPool();
  await recordNewbornTrigger(pool, "calm");
  await clearNewbornReview(pool, "calm");
  await recordNewbornTrigger(pool, "calm");
  await clearNewbornReview(pool, "calm");
  await recordNewbornTrigger(pool, "calm");
  await clearNewbornReview(pool, "calm");
  const s = await getNewbornState(pool, "calm", 3);
  assert.equal(s.operatorApprovedCount, 3);
  assert.equal(s.reviewRequired, false);
});

test("Newborn review: regimes tracked independently", async () => {
  const pool = await buildPool();
  await recordNewbornTrigger(pool, "calm");
  await recordNewbornTrigger(pool, "moderate");
  const calmState = await getNewbornState(pool, "calm", 3);
  const modState = await getNewbornState(pool, "moderate", 3);
  assert.equal(calmState.triggersObserved, 1);
  assert.equal(modState.triggersObserved, 1);
});

test("classifyRegime: correct bands", () => {
  assert.equal(classifyRegime(20), "calm");
  assert.equal(classifyRegime(39.99), "calm");
  assert.equal(classifyRegime(40), "moderate");
  assert.equal(classifyRegime(59.99), "moderate");
  assert.equal(classifyRegime(60), "elevated");
  assert.equal(classifyRegime(84.99), "elevated");
  assert.equal(classifyRegime(85), "stress");
  assert.equal(classifyRegime(120), "stress");
});
