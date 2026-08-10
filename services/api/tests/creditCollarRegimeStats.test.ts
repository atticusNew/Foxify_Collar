import assert from "node:assert/strict";
import test from "node:test";
import type { SettlementOutcome } from "../src/singleSide/twoSided/creditCollar/forwardSettlement";
import { buildRegimeStats } from "../src/singleSide/twoSided/creditCollar/regimeStats";

const DAY = 86_400_000;
const ENTRY = 60_000;

const oc = (over: Partial<SettlementOutcome> = {}): SettlementOutcome => ({
  ref: "p", side: "long", notionalUsdc: 50_000, spotAtEntry: ENTRY, settlePriceUsd: ENTRY, movePct: 0,
  putIntrinsicUsd: 0, callIntrinsicUsd: 0, payoutToFoxifyUsdc: 0, foxifyCreditUsdc: 80, netToFoxifyUsdc: 80,
  serviceFeeUsdc: 10, floorBreached: false, capBreached: false, oracleVerified: true,
  openedAtMs: 1_800_000_000_000, settledAtMs: 1_800_000_000_000, heldMs: DAY,
  hedgeReceiptUsdc: 0, atticusOptionNetUsdc: 0, shortLegMarginUsdc: 0, capitalCostUsdc: 0, optionFeesUsdc: 0,
  atticusNetAfterCapitalUsdc: 10, atticusNetAfterFeesAndCapitalUsdc: 10, ...over
});

test("realized vol is the stdev of 24h moves, annualized by √365", () => {
  // moves of ±2% ⟹ daily vol 2%, annualized ~38.2%
  const day = 1_800_000_000_000;
  const r = buildRegimeStats([
    oc({ movePct: 0.02, settledAtMs: day }),
    oc({ movePct: -0.02, settledAtMs: day })
  ]);
  assert.equal(r.realizedDailyVolPct, 2);
  assert.ok(Math.abs(r.realizedAnnualVolPct - 2 * Math.sqrt(365)) < 0.1);
});

test("groups P&L by settlement day and reports the spread + cumulative net", () => {
  const d1 = Date.parse("2026-07-01T12:00:00Z");
  const d2 = Date.parse("2026-07-02T12:00:00Z");
  // Day 1 calm (no breach): keeps credit. Day 2 rally: cap breach costs more than credit.
  const r = buildRegimeStats(
    [
      oc({ settledAtMs: d1, movePct: 0.003, payoutToFoxifyUsdc: 0, foxifyCreditUsdc: 80 }),
      oc({ settledAtMs: d2, movePct: 0.02, payoutToFoxifyUsdc: -600, foxifyCreditUsdc: 80 })
    ],
    { perpFeeUsdc: 0 } // isolate credit + collar (+ perp)
  );
  assert.equal(r.days, 2);
  // Day 1 net positive (kept credit + small perp gain), day 2 negative (cap cost > credit).
  const day1 = r.recentDays.find((d) => d.dayIso === "2026-07-01")!;
  const day2 = r.recentDays.find((d) => d.dayIso === "2026-07-02")!;
  assert.ok(day1.netUsdc > 0, `calm day should be positive, got ${day1.netUsdc}`);
  assert.ok(day2.netUsdc < 0, `rally day should be negative, got ${day2.netUsdc}`);
  assert.ok(r.dayNetStdUsdc > 0, "spread across days is non-zero");
  assert.equal(r.pctDaysPositive, 0.5);
});

test("creditClearsBleed flips with cumulative net", () => {
  const day = 1_800_000_000_000;
  const bleeding = buildRegimeStats([oc({ settledAtMs: day, movePct: 0.02, payoutToFoxifyUsdc: -600, foxifyCreditUsdc: 80 })], { perpFeeUsdc: 80 });
  assert.equal(bleeding.creditClearsBleed, false);
  const clearing = buildRegimeStats([oc({ settledAtMs: day, movePct: 0.001, payoutToFoxifyUsdc: 0, foxifyCreditUsdc: 80 })], { perpFeeUsdc: 25 });
  assert.equal(clearing.creditClearsBleed, true);
});

test("empty ledger is safe", () => {
  const r = buildRegimeStats([]);
  assert.equal(r.settledPositions, 0);
  assert.equal(r.days, 0);
  assert.equal(r.realizedDailyVolPct, 0);
  assert.equal(r.recentDays.length, 0);
  assert.equal(r.signal, null);
});

test("signal: day-level hit-rate with Bayesian posterior (same-day positions = one observation)", () => {
  const d = (n: number) => Date.parse("2026-07-01T12:00:00Z") + n * DAY;
  // 3 days: day0 two longs on an up-move (correct), day1 one short on an up-move (wrong),
  // day2 one long + one short (perfect split ⟹ no directional info, skipped).
  const r = buildRegimeStats([
    oc({ ref: "a", side: "long", settledAtMs: d(0), movePct: 0.01 }),
    oc({ ref: "b", side: "long", settledAtMs: d(0), movePct: 0.01 }),
    oc({ ref: "c", side: "short", settledAtMs: d(1), movePct: 0.02 }),
    oc({ ref: "d", side: "long", settledAtMs: d(2), movePct: 0.01 }),
    oc({ ref: "e", side: "short", settledAtMs: d(2), movePct: 0.01 })
  ]);
  assert.ok(r.signal, "signal block present");
  const s = r.signal!;
  assert.equal(s.days, 2, "split day excluded; 2 informative days");
  assert.equal(s.correctDays, 1);
  assert.equal(s.dayHitRate, 0.5);
  // Beta(2,2) posterior: mean 0.5, wide CI at N=2, and P(p > 0.52) < wide-but-sane bounds.
  assert.ok(Math.abs(s.posteriorMean - 0.5) < 1e-9);
  assert.ok(s.pAboveBreakeven > 0.2 && s.pAboveBreakeven < 0.8, `tiny sample ⟹ wide posterior (got ${s.pAboveBreakeven})`);
  assert.ok(s.ci95[0] < 0.2 && s.ci95[1] > 0.8, "95% CI is honest about N=2");
});
