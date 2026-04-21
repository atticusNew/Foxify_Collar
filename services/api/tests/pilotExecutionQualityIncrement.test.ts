import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  __setPilotPoolForTests,
  ensurePilotSchema,
  incrementExecutionQualityDaily,
  listExecutionQualityRecent
} from "../src/pilot/db.js";

// Regression test for the per-trade aggregation bug discovered after PR #31:
// the activate path was calling upsertExecutionQualityDaily with hardcoded
// quotes:1 / fills:1 / sampleCount:1, which made every activation OVERWRITE
// the day's row instead of accumulating into it. Operator placed three
// trades and the dashboard kept showing sampleCount:1.
//
// Fix: new incrementExecutionQualityDaily() reads the existing row, computes
// weighted averages and running totals in code, and writes back the
// accumulated state.
//
// Note: pg-mem has known quirks with `INSERT ... ON CONFLICT DO UPDATE` for
// certain repeated-conflict statement shapes. We exercise the core aggregation
// logic here with a single test that proves accumulation works; the multi-row
// distinct-key and reject-vs-fill paths run cleanly in production against
// real Postgres but are awkward to assert under pg-mem's parser quirks.

const buildMemPool = async () => {
  // Reset module-level schemaReady so each test re-creates tables in
  // its own pg-mem instance.
  __setPilotPoolForTests(null);
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensurePilotSchema(pool);
  return pool;
};

test("incrementExecutionQualityDaily accumulates per-trade observations into one daily row, with signed slippage and reject-isolation", async () => {
  const pool = await buildMemPool();

  // Mix of fills and rejects with mixed-sign slippage. Asserts:
  //   1. sample_count advances on every call (was the original PR #34 bug).
  //   2. quotes / fills / rejects accumulate distinctly in metadata.
  //   3. fill_success_rate_pct reflects fills/quotes ratio.
  //   4. Weighted-average slippage and p95 are computed FROM FILLED TRADES ONLY
  //      (a reject's slippageBps:0 must NOT pollute the slippage distribution).
  //   5. Signed slippage is preserved (positive = paid above ask; negative =
  //      price improvement). Math.max(0, ...) clamp removed.
  //   6. Latency average uses fills-only denominator.

  // 3 fills with mixed-sign slippage:  +10, -20, +30  →  filled-mean = +6.67
  await incrementExecutionQualityDaily(pool, {
    day: "2026-04-18", venue: "deribit_live", hedgeMode: "options_native",
    slippageBps: 10, latencyMs: 500, filled: true,
    protectionId: "p1", quoteId: "q1"
  });
  await incrementExecutionQualityDaily(pool, {
    day: "2026-04-18", venue: "deribit_live", hedgeMode: "options_native",
    slippageBps: -20, latencyMs: 700, filled: true,
    protectionId: "p2", quoteId: "q2"
  });
  await incrementExecutionQualityDaily(pool, {
    day: "2026-04-18", venue: "deribit_live", hedgeMode: "options_native",
    slippageBps: 30, latencyMs: 600, filled: true,
    protectionId: "p3", quoteId: "q3"
  });

  // 1 reject — must NOT change slippage distribution but MUST change fill rate
  // and sample_count.
  await incrementExecutionQualityDaily(pool, {
    day: "2026-04-18", venue: "deribit_live", hedgeMode: "options_native",
    slippageBps: 0, latencyMs: 9999, filled: false, quoteId: "rejected"
  });

  const recs = await listExecutionQualityRecent(pool, { lookbackDays: 30 });
  assert.equal(recs.length, 1, "one rolled-up day row");
  const row = recs[0] as any;

  // 3 fills + 1 reject = 4 observations
  assert.equal(Number(row.sampleCount), 4, "sample_count = 4 (3 fills + 1 reject)");
  assert.equal(Number(row.fillSuccessRatePct), 75, "75% fill rate (3 of 4 quotes filled)");

  // Slippage average = (10 + -20 + 30) / 3 = 6.67. The reject's 0 must NOT
  // be averaged in.
  assert.ok(
    Math.abs(Number(row.avgSlippageBps) - 6.6666667) < 0.001,
    `expected ~6.67 bps weighted avg over fills only, got ${row.avgSlippageBps}`
  );

  // Sign preservation: -20 must remain in the sample array.
  const md = row.metadata as Record<string, unknown>;
  assert.deepEqual(md.slippageSamples, [10, -20, 30], "samples preserve sign and order; reject excluded");

  // p95 over [10, -20, 30] sorted = [-20, 10, 30] → idx floor(0.95 * 2) = 1 → 10
  assert.equal(Number(row.p95SlippageBps), 10, "p95 from filled-only sample array");

  // Counters
  assert.equal(md.quotes, 4, "quotes accumulated to 4 (all 4 calls counted)");
  assert.equal(md.fills, 3, "fills = 3");
  assert.equal(md.rejects, 1, "rejects = 1");

  // Latency average = (500 + 700 + 600) / 3 = 600 (reject's 9999 excluded)
  assert.ok(
    Math.abs(Number(md.avgLatencyMs) - 600) < 0.5,
    `expected ~600ms latency avg over fills only, got ${md.avgLatencyMs}`
  );

  // Trade audit trail captures all 4 (fills + rejects) for traceability
  assert.ok(Array.isArray(md.tradeIds));
  assert.equal((md.tradeIds as any[]).length, 4, "all 4 events in audit trail");
  assert.equal(md.lastProtectionId, "p3", "lastProtectionId = newest filled trade");
});

test("incrementExecutionQualityDaily aggregates avg_slippage_usd alongside bps (regression for tick-noise inflation)", async () => {
  // Why this test exists: bps-denominated slippage is sensitive to
  // option price denomination on Deribit. A 1-tick (0.0001 BTC) move
  // on a cheap deep-OTM put quoted at 0.0033 BTC = ~300 bps, but
  // dollar-immaterial (~$0.75). Operators were misled by a -50.51 bps
  // day average that was actually one trade's tick noise. The USD
  // metric gives an economically meaningful signal alongside.
  const pool = await buildMemPool();

  // Three fills with realistic USD slippage:
  //   trade 1: filled $0.20 cheaper than quoted (-$0.20)
  //   trade 2: filled $0.10 worse than quoted (+$0.10)
  //   trade 3: filled exactly at quote ($0.00)
  // Filled-only USD avg = (-0.20 + 0.10 + 0.00) / 3 = -0.0333
  await incrementExecutionQualityDaily(pool, {
    day: "2026-04-21", venue: "deribit_live", hedgeMode: "options_native",
    slippageBps: -100, slippageUsd: -0.20, filled: true,
    protectionId: "u1", quoteId: "qu1"
  });
  await incrementExecutionQualityDaily(pool, {
    day: "2026-04-21", venue: "deribit_live", hedgeMode: "options_native",
    slippageBps: 50, slippageUsd: 0.10, filled: true,
    protectionId: "u2", quoteId: "qu2"
  });
  await incrementExecutionQualityDaily(pool, {
    day: "2026-04-21", venue: "deribit_live", hedgeMode: "options_native",
    slippageBps: 0, slippageUsd: 0, filled: true,
    protectionId: "u3", quoteId: "qu3"
  });

  const recs = await listExecutionQualityRecent(pool, { lookbackDays: 30 });
  const row = recs.find((r) => r.day === "2026-04-21");
  assert.ok(row, "row for the test day");
  assert.equal(Number(row!.sampleCount), 3);
  assert.ok(
    Math.abs(Number(row!.avgSlippageUsd) - -0.0333) < 0.001,
    `expected ~-$0.0333 avg USD slippage, got ${row!.avgSlippageUsd}`
  );

  // Per-trade audit also carries slippageUsd for spot-check
  const md = row!.metadata as Record<string, unknown>;
  const tradeIds = md.tradeIds as Array<Record<string, unknown>>;
  assert.equal(tradeIds.length, 3);
  assert.equal(tradeIds[0].slippageUsd, -0.20, "first trade USD slippage in audit");
  assert.equal(tradeIds[1].slippageUsd, 0.10, "second trade USD slippage in audit");
  assert.equal(tradeIds[2].slippageUsd, 0, "third trade USD slippage = 0");
});

test("incrementExecutionQualityDaily aggregates strike-floor gap + per-direction roll-up", async () => {
  // Regression for PR 4: strike-gap metric was added to surface the
  // dead-zone effect that caused the c84dbbe9 trade loss. After
  // PR #76's ITM aggressiveness fix, the metric should trend more
  // negative (ITM = strike inside trigger = no dead zone).
  const pool = await buildMemPool();

  // Three trades with mixed direction + gap profiles:
  //   t1: SHORT + ITM (gap = -207, strike below trigger)
  //   t2: SHORT + OTM (gap = +292, the c84dbbe9 pattern pre-fix)
  //   t3: LONG  + ITM (gap = -150)
  await incrementExecutionQualityDaily(pool, {
    day: "2026-04-23", venue: "deribit_live", hedgeMode: "options_native",
    slippageBps: 0, slippageUsd: 0, filled: true,
    strikeGapUsd: -207, strikeGapPct: -0.139,
    protectionType: "short",
    protectionId: "g1", quoteId: "gq1"
  });
  await incrementExecutionQualityDaily(pool, {
    day: "2026-04-23", venue: "deribit_live", hedgeMode: "options_native",
    slippageBps: 0, slippageUsd: 0, filled: true,
    strikeGapUsd: 292, strikeGapPct: 0.197,
    protectionType: "short",
    protectionId: "g2", quoteId: "gq2"
  });
  await incrementExecutionQualityDaily(pool, {
    day: "2026-04-23", venue: "deribit_live", hedgeMode: "options_native",
    slippageBps: 0, slippageUsd: 0, filled: true,
    strikeGapUsd: -150, strikeGapPct: -0.10,
    protectionType: "long",
    protectionId: "g3", quoteId: "gq3"
  });

  const recs = await listExecutionQualityRecent(pool, { lookbackDays: 30 });
  const row = recs.find((r) => r.day === "2026-04-23");
  assert.ok(row, "row for the test day");

  // Aggregate gap = (-207 + 292 - 150) / 3 = -21.67
  assert.ok(
    Math.abs(Number(row!.avgStrikeGapUsd) - -21.67) < 0.5,
    `expected aggregate gap ≈ -$21.67; got ${row!.avgStrikeGapUsd}`
  );

  // Per-direction roll-up
  const md = row!.metadata as Record<string, unknown>;
  const dirRollup = md.directionalRollup as Record<string, Record<string, unknown>>;
  assert.ok(dirRollup, "directionalRollup is present");
  assert.equal(dirRollup.short?.fills, 2, "2 SHORT fills");
  assert.equal(dirRollup.long?.fills, 1, "1 LONG fill");
  assert.ok(
    Math.abs(Number(dirRollup.short?.avgStrikeGapUsd) - 42.5) < 0.5,
    `SHORT avg gap = (-207+292)/2 = +42.5; got ${dirRollup.short?.avgStrikeGapUsd}`
  );
  assert.equal(dirRollup.long?.avgStrikeGapUsd, -150);

  // Per-trade audit retains the new fields
  const tradeIds = md.tradeIds as Array<Record<string, unknown>>;
  assert.equal(tradeIds.length, 3);
  assert.equal(tradeIds[0].protectionType, "short");
  assert.equal(tradeIds[0].strikeGapUsd, -207);
  assert.equal(tradeIds[2].protectionType, "long");
});

test("incrementExecutionQualityDaily handles missing slippageUsd gracefully (USD column stays null)", async () => {
  // Backwards compat: if a caller doesn't supply slippageUsd, the bps
  // metric still aggregates and the USD column stays null. Activates
  // before this PR deployed produce no USD data; the new column must
  // not block the bps path.
  const pool = await buildMemPool();
  await incrementExecutionQualityDaily(pool, {
    day: "2026-04-22", venue: "deribit_live", hedgeMode: "options_native",
    slippageBps: 25, filled: true, protectionId: "n1", quoteId: "nq1"
    // slippageUsd intentionally omitted
  });
  const recs = await listExecutionQualityRecent(pool, { lookbackDays: 30 });
  const row = recs.find((r) => r.day === "2026-04-22");
  assert.ok(row);
  assert.equal(Number(row!.avgSlippageBps), 25, "bps still aggregates");
  assert.equal(row!.avgSlippageUsd, null, "USD stays null when no caller supplies it");
});
