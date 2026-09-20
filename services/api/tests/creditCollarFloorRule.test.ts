import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_FLOOR_BAND,
  evaluateFloorRule,
  floorCandidates,
  floorRuleFromEnv,
  floorRuleText,
  pickFloor,
  type FloorRule,
  type FloorTrial,
} from "../src/singleSide/twoSided/creditCollar/floorRule";

const trial = (floorPct: number, creditUsdc: number | null, notionalUsdc = 10_000): FloorTrial => ({ floorPct, creditUsdc, notionalUsdc });

// ── configuration ────────────────────────────────────────────────────────────

test("floor rule from env: default is FIXED at the live depth (nothing changes until the flag flips)", () => {
  assert.deepEqual(floorRuleFromEnv({}, 0.06), { kind: "fixed", floorPct: 0.06 });
  assert.deepEqual(floorRuleFromEnv({ EP_FLOOR_RULE: "nonsense" }, 0.055), { kind: "fixed", floorPct: 0.055 });
  assert.equal(floorRuleText(floorRuleFromEnv({}, 0.06)), "fixed floor 6.0% under the live price");
});

test("floor rule from env: tightest_paying reads the band and clamps it to sane values", () => {
  assert.deepEqual(floorRuleFromEnv({ EP_FLOOR_RULE: "tightest_paying" }, 0.06), { kind: "tightest_paying", ...DEFAULT_FLOOR_BAND });
  const r = floorRuleFromEnv(
    { EP_FLOOR_RULE: "TIGHTEST_PAYING", EP_FLOOR_MIN_PCT: "0.04", EP_FLOOR_MAX_PCT: "0.02", EP_FLOOR_STEP_PCT: "0.0001", EP_FLOOR_MIN_CREDIT_BPS: "-3" },
    0.06
  );
  assert.equal(r.kind, "tightest_paying");
  if (r.kind !== "tightest_paying") throw new Error("unreachable");
  assert.equal(r.minPct, 0.04);
  assert.equal(r.maxPct, 0.04, "max never below min");
  assert.equal(r.stepPct, 0.0025, "step never finer than a quarter point");
  assert.equal(r.minCreditBps, 0, "minimum never negative");
  assert.match(floorRuleText(r), /tightest floor in 4–4% whose credit clears 0 bps/);
});

test("floor candidates: fixed is one depth; the band is enumerated most protective first", () => {
  assert.deepEqual(floorCandidates({ kind: "fixed", floorPct: 0.06 }), [0.06]);
  assert.deepEqual(floorCandidates({ kind: "tightest_paying", ...DEFAULT_FLOOR_BAND }), [0.05, 0.06, 0.07, 0.08]);
  assert.deepEqual(floorCandidates({ kind: "tightest_paying", minPct: 0.05, maxPct: 0.06, stepPct: 0.005, minCreditBps: 5 }), [0.05, 0.055, 0.06]);
});

// ── the pick ─────────────────────────────────────────────────────────────────

test("pickFloor fixed: takes the configured depth when it pays, refuses when it does not", () => {
  const fixed: FloorRule = { kind: "fixed", floorPct: 0.06 };
  assert.deepEqual(pickFloor(fixed, [trial(0.06, 12)]).floorPct, 0.06);
  assert.equal(pickFloor(fixed, [trial(0.06, 12)]).by, "fixed");
  assert.equal(pickFloor(fixed, [trial(0.06, 0)]).floorPct, null, "zero credit is not a quote");
  assert.equal(pickFloor(fixed, [trial(0.06, null)]).by, "none");
  assert.equal(pickFloor(fixed, []).by, "none");
});

test("pickFloor tightest_paying: the shallowest depth whose credit clears the minimum wins, even if a deeper one pays more", () => {
  const r: FloorRule = { kind: "tightest_paying", ...DEFAULT_FLOOR_BAND }; // 5 bps of $10k = $5
  const p = pickFloor(r, [trial(0.05, 4.99), trial(0.06, 5.0), trial(0.07, 9), trial(0.08, 14)]);
  assert.equal(p.floorPct, 0.06, "5% misses the minimum by a cent; 6% clears it; the richer 7–8% are not taken");
  assert.equal(p.by, "clears_minimum");
  assert.equal(p.tried.length, 4);
});

test("pickFloor tightest_paying: order of trials does not matter", () => {
  const r: FloorRule = { kind: "tightest_paying", ...DEFAULT_FLOOR_BAND };
  const p = pickFloor(r, [trial(0.08, 14), trial(0.05, 1), trial(0.07, 9), trial(0.06, 6)]);
  assert.equal(p.floorPct, 0.06);
});

test("pickFloor tightest_paying: when nothing clears the minimum, the depth that pays the most per dollar protected", () => {
  const r: FloorRule = { kind: "tightest_paying", ...DEFAULT_FLOOR_BAND };
  const p = pickFloor(r, [trial(0.05, 0.5), trial(0.06, 2.1), trial(0.07, 1.9), trial(0.08, null)]);
  assert.equal(p.floorPct, 0.06);
  assert.equal(p.by, "best_paying");
});

test("pickFloor tightest_paying: nothing pays ⟹ refuse (never write a collar for zero or negative credit)", () => {
  const r: FloorRule = { kind: "tightest_paying", ...DEFAULT_FLOOR_BAND };
  const p = pickFloor(r, [trial(0.05, null), trial(0.06, 0), trial(0.07, -1), trial(0.08, null)]);
  assert.equal(p.floorPct, null);
  assert.equal(p.by, "none");
});

test("pickFloor tightest_paying: the minimum is judged in bps of THIS quote's notional", () => {
  const r: FloorRule = { kind: "tightest_paying", ...DEFAULT_FLOOR_BAND };
  // $2 on $1,000 is 20 bps — clears; $2 on $100,000 is 0.2 bps — does not
  assert.equal(pickFloor(r, [trial(0.05, 2, 1_000)]).by, "clears_minimum");
  assert.equal(pickFloor(r, [trial(0.05, 2, 100_000)]).by, "best_paying");
});

// ── evaluating against a live quoter ─────────────────────────────────────────

type Q = { ok: boolean; credit?: number; notional?: number };

test("evaluateFloorRule fixed: exactly one probe, the depth is the configured one", async () => {
  const asked: number[] = [];
  const { pick, quotes } = await evaluateFloorRule<Q>(
    { kind: "fixed", floorPct: 0.06 },
    async (fp) => {
      asked.push(fp);
      return { ok: true, credit: 8, notional: 10_000 };
    },
    (q) => ({ creditUsdc: q.credit ?? null, notionalUsdc: q.notional ?? 0 })
  );
  assert.deepEqual(asked, [0.06]);
  assert.equal(pick.floorPct, 0.06);
  assert.equal(quotes.size, 1);
});

test("evaluateFloorRule tightest_paying: stops at the first depth that clears — the common case is one or two probes", async () => {
  const asked: number[] = [];
  const book: Record<string, Q> = { "0.05": { ok: true, credit: 3, notional: 10_000 }, "0.06": { ok: true, credit: 7, notional: 10_000 }, "0.07": { ok: true, credit: 12, notional: 10_000 } };
  const { pick, quotes } = await evaluateFloorRule<Q>(
    { kind: "tightest_paying", ...DEFAULT_FLOOR_BAND },
    async (fp) => {
      asked.push(fp);
      return book[fp.toFixed(2)] ?? { ok: false };
    },
    (q) => ({ creditUsdc: q.credit ?? null, notionalUsdc: q.notional ?? 0 })
  );
  assert.deepEqual(asked, [0.05, 0.06], "the 7% and 8% depths were never priced");
  assert.equal(pick.floorPct, 0.06);
  assert.equal(pick.by, "clears_minimum");
  assert.equal(quotes.get(0.06)?.credit, 7);
});

test("evaluateFloorRule tightest_paying: a refused depth is a null trial, not a crash; the rule keeps walking", async () => {
  const asked: number[] = [];
  const { pick } = await evaluateFloorRule<Q>(
    { kind: "tightest_paying", ...DEFAULT_FLOOR_BAND },
    async (fp) => {
      asked.push(fp);
      if (fp < 0.07) return { ok: false };
      return { ok: true, credit: 1, notional: 10_000 }; // 1 bps: never clears
    },
    (q) => ({ creditUsdc: q.credit ?? null, notionalUsdc: q.notional ?? 0 })
  );
  assert.deepEqual(asked, [0.05, 0.06, 0.07, 0.08], "nothing cleared, so the whole band was tried");
  assert.equal(pick.by, "best_paying");
  assert.equal(pick.floorPct, 0.07, "the two paying depths tie per dollar; the shallower wins the sort");
});
