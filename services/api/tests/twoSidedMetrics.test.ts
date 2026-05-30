/**
 * PR B3 tests — Metrics + structured logging.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Metrics, getMetrics, __resetMetricsForTests, METRIC_NAMES } from "../src/singleSide/twoSided/metrics";
import { slog } from "../src/singleSide/twoSided/structuredLog";

test("Metrics: counter increments and snapshots correctly", () => {
  const m = new Metrics();
  m.incrementCounter("test_counter", { cell: "x" });
  m.incrementCounter("test_counter", { cell: "x" });
  m.incrementCounter("test_counter", { cell: "y" }, 3);
  const snap = m.snapshot();
  assert.equal(snap.counters.test_counter['{cell="x"}'], 2);
  assert.equal(snap.counters.test_counter['{cell="y"}'], 3);
});

test("Metrics: gauge set/increment/decrement", () => {
  const m = new Metrics();
  m.setGauge("g", 10);
  assert.equal(m.snapshot().gauges.g[""], 10);
  m.incrementGauge("g");
  m.incrementGauge("g", {}, 5);
  m.decrementGauge("g", {}, 2);
  assert.equal(m.snapshot().gauges.g[""], 14);
});

test("Metrics: histogram observations bucket correctly", () => {
  const m = new Metrics();
  for (const v of [5, 15, 75, 200, 5000]) {
    m.observeHistogram("h", v);
  }
  const snap = m.snapshot();
  const h = snap.histograms.h[""];
  assert.equal(h.count, 5);
  assert.equal(h.sum, 5 + 15 + 75 + 200 + 5000);
  // Buckets: 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000
  // value 5 fits le 10, 25, 50, ... all
  // value 15 fits le 25, 50, ...
  // value 75 fits le 100, ...
  // value 200 fits le 250, ...
  // value 5000 fits le 5000, ...
  assert.equal(h.buckets[10], 1);    // only 5
  assert.equal(h.buckets[100], 3);   // 5, 15, 75
  assert.equal(h.buckets[250], 4);   // + 200
  assert.equal(h.buckets[5000], 5);  // all
});

test("Metrics: renderPrometheus emits valid format", () => {
  const m = new Metrics();
  m.incrementCounter("two_sided_pairs_activated_total", { cell_id: "pair_50k_2pct", tier: "tier_1" });
  m.setGauge("two_sided_active_pairs", 5, { cell_id: "pair_50k_2pct" });
  m.observeHistogram("two_sided_activate_latency_ms", 120, { cell_id: "pair_50k_2pct" });
  const text = m.renderPrometheus();
  assert.match(text, /^# TYPE two_sided_pairs_activated_total counter/m);
  assert.match(text, /two_sided_pairs_activated_total\{cell_id="pair_50k_2pct",tier="tier_1"\} 1/);
  assert.match(text, /^# TYPE two_sided_active_pairs gauge/m);
  assert.match(text, /two_sided_active_pairs\{cell_id="pair_50k_2pct"\} 5/);
  assert.match(text, /^# TYPE two_sided_activate_latency_ms histogram/m);
  assert.match(text, /two_sided_activate_latency_ms_bucket\{cell_id="pair_50k_2pct",le="250"\} 1/);
});

test("Metrics: METRIC_NAMES exports standard names", () => {
  assert.equal(METRIC_NAMES.PAIRS_ACTIVATED_TOTAL, "two_sided_pairs_activated_total");
  assert.equal(METRIC_NAMES.UNWIND_QUEUE_DEPTH, "two_sided_unwind_queue_depth");
});

test("getMetrics: singleton reset works for tests", () => {
  __resetMetricsForTests();
  const m1 = getMetrics();
  m1.incrementCounter("x");
  __resetMetricsForTests();
  const m2 = getMetrics();
  assert.equal(Object.keys(m2.snapshot().counters).length, 0);
});

test("structuredLog: emits JSON lines at expected severities", () => {
  // Capture stdout
  const origLog = console.log;
  const lines: string[] = [];
  console.log = (msg: string) => lines.push(msg);
  try {
    slog.info("test message", { pair_id: "p1", extra: 42 });
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.severity, "info");
    assert.equal(parsed.msg, "test message");
    assert.equal(parsed.pair_id, "p1");
    assert.equal(parsed.extra, 42);
    assert.ok(parsed.ts);
  } finally {
    console.log = origLog;
  }
});

test("structuredLog: respects TWO_SIDED_LOG_LEVEL=warn (filters debug+info)", () => {
  const orig = process.env.TWO_SIDED_LOG_LEVEL;
  process.env.TWO_SIDED_LOG_LEVEL = "warn";
  const origLog = console.log;
  const lines: string[] = [];
  console.log = (msg: string) => lines.push(msg);
  try {
    slog.debug("noisy");
    slog.info("also noisy");
    slog.warn("important");
    slog.error("very important");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).severity, "warn");
    assert.equal(JSON.parse(lines[1]).severity, "error");
  } finally {
    console.log = origLog;
    if (orig === undefined) delete process.env.TWO_SIDED_LOG_LEVEL;
    else process.env.TWO_SIDED_LOG_LEVEL = orig;
  }
});
