/**
 * Fee-Recovery backtest — pure analysis (realized vs implied touch, grid × signal).
 * Deterministic synthetic series; no network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  normCdf, impliedTouchProb, runFeeRecoveryBacktest, blockBootstrap,
  type Candle, type DvolPoint
} from "../src/singleSide/twoSided/feeRecoveryBacktest";

test("normCdf basic anchors", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normCdf(1.645) - 0.95) < 1e-3);
  assert.ok(Math.abs(normCdf(-1.645) - 0.05) < 1e-3);
});

test("impliedTouchProb matches reflection principle and live ~19% @ DVOL 44, 3%/24h", () => {
  const t = impliedTouchProb(0.03, 0.44, 24 / (365 * 24));
  // 0.03/(0.44*sqrt(1/365)) ≈ 1.303 → 2*Φ(-1.303) ≈ 0.193
  assert.ok(t > 0.17 && t < 0.21, `got ${t}`);
  // monotonic: wider trigger → lower touch prob
  assert.ok(impliedTouchProb(0.04, 0.44, 24 / (365 * 24)) < t);
  // higher vol → higher touch prob
  assert.ok(impliedTouchProb(0.03, 0.60, 24 / (365 * 24)) > t);
});

// Build 200 hourly candles. A downside -3% touch is forced on exactly half the entries.
const buildSeries = (): { candles: Candle[]; dvol: DvolPoint[] } => {
  const candles: Candle[] = [];
  const dvol: DvolPoint[] = [];
  const t0 = Date.UTC(2026, 0, 1);
  let price = 100000;
  for (let i = 0; i < 200; i++) {
    const tsMs = t0 + i * 3_600_000;
    // On even indices, the NEXT hour dips -3.5% (a touch for a 3% long cover); odd indices stay flat.
    const dip = i % 2 === 0;
    const low = dip ? price * 0.965 : price * 0.999;
    const high = price * 1.001;
    candles.push({ tsMs, close: price, high, low });
    dvol.push({ tsMs, dvol: 40 }); // constant DVOL → constant implied
  }
  return { candles, dvol };
};

test("realized touch rate reflects actual highs/lows; tenor=1h isolates next candle", () => {
  const { candles, dvol } = buildSeries();
  const rep = runFeeRecoveryBacktest(candles, dvol, {
    triggers: [0.03], tenorHours: 1, sides: ["long"], payoutUsdc: 60, opsFeeUsdc: 1, minBucketN: 10
  });
  const all = rep.rows.find((r) => r.signal === "all" && r.side === "long");
  assert.ok(all);
  // Entry i touches iff candle i+1 dips. Half the candles dip (even i) → entry odd i sees next(even) dip.
  // Over the entry range the touch rate should be ~0.5.
  assert.ok(all!.realized_touch_rate > 0.4 && all!.realized_touch_rate < 0.6, `got ${all!.realized_touch_rate}`);
});

test("foxify EV = edge×payout − ops; positive when realized >> implied", () => {
  const { candles, dvol } = buildSeries();
  const rep = runFeeRecoveryBacktest(candles, dvol, {
    triggers: [0.03], tenorHours: 1, sides: ["long"], payoutUsdc: 60, opsFeeUsdc: 1, minBucketN: 10, tradesPerDay: 1000
  });
  const all = rep.rows.find((r) => r.signal === "all" && r.side === "long")!;
  // implied (DVOL 40, 3%, 1h) is tiny; realized ~0.5 → big positive edge → strongly +EV.
  assert.ok(all.implied_touch_rate < 0.05, `implied ${all.implied_touch_rate}`);
  assert.ok(all.foxify_ev_per_trade_usdc > 0, `ev ${all.foxify_ev_per_trade_usdc}`);
  const expectedEv = +(all.edge * 60 - 1).toFixed(3);
  assert.ok(Math.abs(all.foxify_ev_per_trade_usdc - expectedEv) < 0.01);
  assert.equal(all.atticus_margin_per_trade_usdc, 1);
  assert.ok(Math.abs((all.foxify_ev_per_day_usdc ?? 0) - all.foxify_ev_per_trade_usdc * 1000) < 1);
  assert.equal(all.verdict, "FOXIFY_POSITIVE");
});

test("short side uses highs; no upside touch in this series → realized ~0", () => {
  const { candles, dvol } = buildSeries();
  const rep = runFeeRecoveryBacktest(candles, dvol, {
    triggers: [0.03], tenorHours: 1, sides: ["short"], payoutUsdc: 60, opsFeeUsdc: 1, minBucketN: 10
  });
  const all = rep.rows.find((r) => r.signal === "all" && r.side === "short")!;
  assert.equal(all.realized_touch_rate, 0); // highs never reach +3%
  assert.ok(all.foxify_ev_per_trade_usdc < 0);
});

test("term-structure uplift raises implied touch and lowers Foxify edge", () => {
  // Build a high-vol series (DVOL 90 = stress) where -3% touches happen often.
  const candles: Candle[] = [];
  const dvol: DvolPoint[] = [];
  const t0 = Date.UTC(2026, 0, 1);
  const price = 100000;
  for (let i = 0; i < 120; i++) {
    const tsMs = t0 + i * 3_600_000;
    const dip = i % 2 === 0;
    candles.push({ tsMs, close: price, high: price * 1.001, low: dip ? price * 0.96 : price * 0.999 });
    dvol.push({ tsMs, dvol: 90 }); // stress regime
  }
  const base = { triggers: [0.03], tenorHours: 24, sides: ["long"] as const, payoutUsdc: 60, opsFeeUsdc: 1, minBucketN: 5 };
  const raw = runFeeRecoveryBacktest(candles, dvol, { ...base, termStructure: { stress: 1.0 } });
  const corrected = runFeeRecoveryBacktest(candles, dvol, { ...base, termStructure: { stress: 1.5 } });
  const rawAll = raw.rows.find((r) => r.signal === "all")!;
  const corrAll = corrected.rows.find((r) => r.signal === "all")!;
  assert.ok(corrAll.implied_touch_rate > rawAll.implied_touch_rate, "uplift should raise implied");
  assert.ok(corrAll.foxify_ev_per_trade_usdc < rawAll.foxify_ev_per_trade_usdc, "uplift should lower Foxify edge");
});

test("blockBootstrap: all-positive series → p_positive=1, CI above 0; reproducible", () => {
  const series = Array.from({ length: 500 }, () => 2 + Math.random()); // strictly positive
  const a = blockBootstrap(series, { blockLen: 24, resamples: 1000, seed: 42 });
  const b = blockBootstrap(series, { blockLen: 24, resamples: 1000, seed: 42 });
  assert.equal(a.p_positive, 1);
  assert.ok(a.ci_low > 0);
  assert.equal(a.mean, b.mean); // deterministic
  assert.equal(a.ci_low, b.ci_low);
});

test("blockBootstrap: exactly-zero-mean shuffled series → CI straddles 0, non-degenerate", () => {
  // 400×(+1), 400×(−1) → mean exactly 0; deterministically shuffled so blocks aren't periodic.
  const vals = Array.from({ length: 800 }, (_, i) => (i < 400 ? 1 : -1));
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = vals.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; }
  const r = blockBootstrap(vals, { blockLen: 48, resamples: 2000, seed: 7 });
  assert.equal(r.mean, 0);
  assert.ok(r.ci_low < r.ci_high, "CI must have width (RNG not degenerate)");
  assert.ok(r.ci_low < 0 && r.ci_high > 0, `CI should straddle 0: [${r.ci_low}, ${r.ci_high}]`);
  assert.ok(r.p_positive > 0.3 && r.p_positive < 0.7, `p_positive ${r.p_positive}`);
});

test("runFeeRecoveryBacktest collects per-trade series when requested", () => {
  const { candles, dvol } = buildSeries();
  const rep = runFeeRecoveryBacktest(candles, dvol, {
    triggers: [0.03], tenorHours: 1, sides: ["long"], payoutUsdc: 60, opsFeeUsdc: 1, minBucketN: 10,
    collectSeriesFor: [{ side: "long", trigger: 0.03, signal: "all" }]
  });
  const s = rep.series?.["long|0.03|all"];
  assert.ok(s && s.length > 100);
  const boot = blockBootstrap(s!, { resamples: 500, seed: 1 });
  assert.equal(boot.n, s!.length);
});

test("report carries window + signal buckets (all, dvol quintile, regime)", () => {
  const { candles, dvol } = buildSeries();
  const rep = runFeeRecoveryBacktest(candles, dvol, {
    triggers: [0.03], tenorHours: 1, sides: ["long"], payoutUsdc: 60, opsFeeUsdc: 1, minBucketN: 10
  });
  const signals = new Set(rep.rows.map((r) => r.signal));
  assert.ok(signals.has("all"));
  assert.ok([...signals].some((s) => s.startsWith("dvol_q")));
  assert.ok([...signals].some((s) => s.startsWith("regime:")));
  assert.ok(rep.window.entries > 100);
});
