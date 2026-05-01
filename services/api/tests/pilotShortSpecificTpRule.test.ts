import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  __setPilotPoolForTests,
  ensurePilotSchema,
  insertProtection
} from "../src/pilot/db.js";
import { runHedgeManagementCycle } from "../src/pilot/hedgeManager.js";
import {
  recordSpotSample,
  __resetSpotHistoryForTests
} from "../src/pilot/spotHistory.js";

// PR B — SHORT-specific TP rule (Gap 5) regression coverage.
//
// Gap 5a: barely-graze fast exit for SHORT triggers (the c84dbbe9
// pattern — sell immediately rather than wait for a "bounce" that
// won't favor us).
//
// Gap 5b: clear-breakout extended hold for SHORT triggers (let
// momentum continuation play out instead of selling at standard
// cooling boundary).
//
// Both default to observe-only. We test:
//   - LONG triggers DO NOT fire either rule (SHORT-specific guard works)
//   - SHORT barely-graze logs OBSERVE line, does not execute
//   - SHORT clear-breakout logs OBSERVE line for cooling extension
//   - With ENFORCE=true, SHORT barely-graze actually executes the sell
//   - SHORT trigger that's neither barely-graze nor clear-breakout
//     does not fire either rule

const HOUR_MS = 3600 * 1000;
const MIN_MS = 60 * 1000;

const buildPool = async () => {
  __setPilotPoolForTests(null);
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensurePilotSchema(pool);
  return pool;
};

const fakeVenue = {} as any;

const buildSellRecorder = () => {
  const calls: Array<{ instrumentId: string; quantity: number; reason?: string }> = [];
  const sellOption = async (p: { instrumentId: string; quantity: number }) => {
    calls.push({ instrumentId: p.instrumentId, quantity: p.quantity });
    return {
      status: "sold",
      fillPrice: 100,
      totalProceeds: 100 * p.quantity,
      orderId: `mock-${calls.length}`,
      details: { mock: true }
    };
  };
  return { sellOption, calls };
};

const captureCycle = async (params: {
  pool: any;
  sellOption: any;
  currentSpot: number;
  currentIV: number;
}) => {
  const captured: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: any[]) => captured.push(args.map(String).join(" "));
  console.warn = (...args: any[]) => captured.push(args.map(String).join(" "));
  console.error = (...args: any[]) => captured.push(args.map(String).join(" "));
  try {
    await runHedgeManagementCycle({
      pool: params.pool,
      venue: fakeVenue,
      sellOption: params.sellOption,
      currentSpot: params.currentSpot,
      currentIV: params.currentIV
    });
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
  return captured;
};

const seedTriggered = async (
  pool: any,
  opts: {
    direction: "long" | "short";
    triggerAtMs: number;
    expiryAtMs: number;
    entry: number;
    triggerPrice: number;
    triggerReferencePrice: number; // BTC spot at moment trigger fired
    strike: number;
    payoutDueAmount?: number;
    hedgeQty?: number;
  }
) => {
  const seeded = await insertProtection(pool, {
    userHash: "hh-tp-short",
    hashVersion: 1,
    status: "triggered" as any,
    tierName: "SL 2%",
    drawdownFloorPct: "0.02",
    slPct: 2,
    hedgeStatus: "active",
    marketId: "BTC-USD",
    protectedNotional: "20000",
    foxifyExposureNotional: "20000",
    expiryAt: new Date(opts.expiryAtMs).toISOString(),
    autoRenew: false,
    renewWindowMinutes: 1440,
    metadata: {
      protectionType: opts.direction,
      triggerMonitorAt: new Date(opts.triggerAtMs).toISOString(),
      triggerAt: new Date(opts.triggerAtMs).toISOString(),
      triggerReferencePrice: opts.triggerReferencePrice
    }
  });
  const optionLetter = opts.direction === "short" ? "C" : "P";
  await pool.query(
    `UPDATE pilot_protections SET
       venue = 'deribit_test',
       instrument_id = $1,
       side = 'buy',
       size = $2,
       execution_price = '0.001',
       premium = '60',
       payout_due_amount = $3,
       floor_price = $4
     WHERE id = $5`,
    [
      `BTC-22APR26-${opts.strike}-${optionLetter}`,
      String(opts.hedgeQty ?? 0.27),
      String(opts.payoutDueAmount ?? 400),
      String(opts.triggerPrice.toFixed(10)),
      seeded.id
    ]
  );
  return seeded.id;
};

test("Gap 5a OBSERVE — SHORT barely-graze logs would-fire, does NOT execute sell", async () => {
  __resetSpotHistoryForTests();
  delete process.env.PILOT_TP_GAP5_ENFORCE;
  const pool = await buildPool();
  const now = Date.now();

  // Steady spot history (no Gap 1/3 firing): keeps last 24h flat at ~$75,500
  for (let h = 24; h >= 0; h--) {
    recordSpotSample(75500, now - h * HOUR_MS);
  }

  // SHORT 2% protection: entry $74,000, trigger $75,480 (entry × 1.02),
  // BTC at trigger fire was $75,500, current spot is $75,700
  // (0.29% past trigger — within 0.3% graze threshold).
  // Strike $75,500 (ITM by trigger, post-PR-#76 selection style).
  // With qty 1.0 BTC and spot $75,700: intrinsic = $200 × 1.0 = $200
  // (well above $15 grazeMinValueUsd).
  // Triggered 10 min ago, in the early grazeWindow (30 min default).
  await seedTriggered(pool, {
    direction: "short",
    triggerAtMs: now - 10 * MIN_MS,
    expiryAtMs: now + 20 * HOUR_MS,
    entry: 74000,
    triggerPrice: 75480,
    triggerReferencePrice: 75500,
    strike: 75500,
    payoutDueAmount: 400,
    hedgeQty: 1.0  // larger qty so intrinsic clears the $15 minimum
  });

  const { sellOption, calls } = buildSellRecorder();
  const logs = await captureCycle({
    pool, sellOption,
    currentSpot: 75700, // 0.29% past trigger of 75480
    currentIV: 0.45
  });

  const observeLine = logs.find((l) => l.includes("Gap 5a OBSERVE"));
  assert.ok(observeLine, `expected Gap 5a OBSERVE log line; got: ${logs.filter((l) => l.includes("Gap 5")).join("\n")}`);
  assert.equal(calls.length, 0, "no sell should execute in observe mode");
});

test("Gap 5a ENFORCE — SHORT barely-graze actually executes the sell", async () => {
  __resetSpotHistoryForTests();
  process.env.PILOT_TP_GAP5_ENFORCE = "true";
  try {
    const pool = await buildPool();
    const now = Date.now();
    for (let h = 24; h >= 0; h--) {
      recordSpotSample(75500, now - h * HOUR_MS);
    }
    await seedTriggered(pool, {
      direction: "short",
      triggerAtMs: now - 10 * MIN_MS,
      expiryAtMs: now + 20 * HOUR_MS,
      entry: 74000,
      triggerPrice: 75480,
      triggerReferencePrice: 75500,
      strike: 75500,
      payoutDueAmount: 400,
      hedgeQty: 1.0
    });

    const { sellOption, calls } = buildSellRecorder();
    const logs = await captureCycle({
      pool, sellOption,
      currentSpot: 75700,
      currentIV: 0.45
    });

    const enforceLine = logs.find((l) => l.includes("Gap 5a ENFORCE"));
    assert.ok(enforceLine, `expected Gap 5a ENFORCE log; got: ${logs.filter((l) => l.includes("Gap 5")).join("\n")}`);
    assert.equal(calls.length, 1, "exactly one sell should execute in enforce mode");
  } finally {
    delete process.env.PILOT_TP_GAP5_ENFORCE;
  }
});

// Gap 5a-fix-1 regression — the 3df5cfa1 failure mode.
// Real-world sequence: TriggerMonitor (3s cadence) detected spot crossing
// the trigger ceiling at $77,663.61. By the time HedgeManager (60s cadence)
// next evaluated the trade, BTC had already retraced back below the trigger.
// The original code computed spotMoveThroughTriggerPct from CURRENT spot,
// which was negative once retraced, so the `>= 0` guard killed Gap 5a even
// though the trade was a textbook barely-graze.
//
// After the fix, Gap 5a classifies the pattern from triggerReferencePrice
// (the spot at the moment the trigger fired, saved in metadata by
// triggerMonitor.buildTriggerMetadata). The pattern doesn't change
// retroactively when spot retraces — it was a barely-graze at fire time
// and remains one for purposes of the rule.
test("Gap 5a fix — fires on barely-graze SHORT even after BTC retraces back below trigger", async () => {
  __resetSpotHistoryForTests();
  process.env.PILOT_TP_GAP5_ENFORCE = "true";
  try {
    const pool = await buildPool();
    const now = Date.now();
    // Steady spot history at the post-retrace level so Gap 1/3 don't fire.
    // Mirrors a quick barely-graze where BTC briefly touched $77,663 then
    // fell back to just under the $77,621.84 trigger within 60s.
    for (let h = 24; h >= 0; h--) {
      recordSpotSample(77620, now - h * HOUR_MS);
    }

    // SHORT 2% protection mirroring 3df5cfa1's pattern: entry $76,099.84,
    // trigger $77,621.84, triggerReferencePrice $77,663.61 (spot AT
    // trigger fire, 0.054% past trigger — clearly a barely-graze).
    // Strike $77,500 (ITM relative to trigger, per PR #76).
    //
    // By the time HedgeManager runs, BTC has retraced to $77,620 — just
    // BELOW the trigger of $77,621.84. The OLD code would have computed
    // spotMoveThroughTriggerPct = (77620 - 77621.84) / 77621.84 * 100 =
    // -0.0024% (negative), failed the `>= 0` guard, and never fired
    // Gap 5a. The 3df5cfa1 trade hit exactly this failure mode.
    //
    // The strike $77,500 is still below current spot $77,620, so the call
    // hedge retains intrinsic = $120 × 1.0 BTC = $120, well above the
    // $15 grazeMinValueUsd threshold. There IS still value to capture.
    await seedTriggered(pool, {
      direction: "short",
      triggerAtMs: now - 5 * MIN_MS,
      expiryAtMs: now + 9 * HOUR_MS,
      entry: 76099.84,
      triggerPrice: 77621.84,
      triggerReferencePrice: 77663.61,
      strike: 77500,
      payoutDueAmount: 200,
      hedgeQty: 1.0
    });

    const { sellOption, calls } = buildSellRecorder();
    const logs = await captureCycle({
      pool,
      sellOption,
      currentSpot: 77620, // BELOW trigger 77621.84 — the retrace condition
      currentIV: 0.40
    });

    const enforceLine = logs.find((l) => l.includes("Gap 5a ENFORCE"));
    assert.ok(
      enforceLine,
      `expected Gap 5a ENFORCE log — fix should classify barely-graze from triggerReferencePrice, not currentSpot. Got: ${logs.filter((l) => l.includes("Gap 5")).join("\n")}`
    );
    assert.equal(calls.length, 1, "exactly one sell should execute on the retrace-then-evaluate sequence");
    // The log should include both the at-trigger pct and the live pct
    // for operator audit clarity.
    assert.ok(
      enforceLine!.includes("at-trigger") && enforceLine!.includes("live"),
      `enforce log should report both at-trigger and live spot context. Got: ${enforceLine}`
    );
  } finally {
    delete process.env.PILOT_TP_GAP5_ENFORCE;
  }
});

test("Gap 5 does NOT fire on LONG protections (SHORT-only guard)", async () => {
  __resetSpotHistoryForTests();
  process.env.PILOT_TP_GAP5_ENFORCE = "true";
  try {
    const pool = await buildPool();
    const now = Date.now();
    for (let h = 24; h >= 0; h--) {
      recordSpotSample(74000 - h * 5, now - h * HOUR_MS);
    }

    // LONG 2% protection: entry $74,000, trigger $72,520, current $72,500
    // (barely graze in the LONG direction). Even with all the right
    // conditions, Gap 5 should NOT fire on a LONG protection.
    await seedTriggered(pool, {
      direction: "long",
      triggerAtMs: now - 10 * MIN_MS,
      expiryAtMs: now + 20 * HOUR_MS,
      entry: 74000,
      triggerPrice: 72520,
      triggerReferencePrice: 72510,
      strike: 72500,
      payoutDueAmount: 400
    });

    const { sellOption, calls } = buildSellRecorder();
    const logs = await captureCycle({
      pool, sellOption,
      currentSpot: 72500,
      currentIV: 0.45
    });

    const gap5Lines = logs.filter((l) => l.includes("Gap 5"));
    assert.equal(gap5Lines.length, 0, `Gap 5 should never log on LONG; got: ${gap5Lines.join("\n")}`);
    // The LONG trade may or may not sell via standard branches — Gap 5 just shouldn't be involved.
  } finally {
    delete process.env.PILOT_TP_GAP5_ENFORCE;
  }
});

test("Gap 5b OBSERVE — SHORT clear-breakout logs would-extend cooling", async () => {
  __resetSpotHistoryForTests();
  delete process.env.PILOT_TP_GAP5_ENFORCE;
  const pool = await buildPool();
  const now = Date.now();
  for (let h = 24; h >= 0; h--) {
    recordSpotSample(74000 + h * 5, now - h * HOUR_MS);
  }

  // SHORT 2% protection where BTC has moved 1.5% past trigger
  // (clear breakout). Strike $75,500 with spot $76,610 → intrinsic
  // = $1,110 × 0.27 = $300 (>= $50 minimum).
  await seedTriggered(pool, {
    direction: "short",
    triggerAtMs: now - 10 * MIN_MS,
    expiryAtMs: now + 20 * HOUR_MS,
    entry: 74000,
    triggerPrice: 75480,
    triggerReferencePrice: 75500,
    strike: 75500,
    payoutDueAmount: 400
  });

  const { sellOption, calls } = buildSellRecorder();
  const logs = await captureCycle({
    pool, sellOption,
    currentSpot: 76610,  // 1.5% past trigger of 75480
    currentIV: 0.45
  });

  const observeLine = logs.find((l) => l.includes("Gap 5b OBSERVE"));
  assert.ok(observeLine, `expected Gap 5b OBSERVE log; got: ${logs.filter((l) => l.includes("Gap 5")).join("\n")}`);
  // No sell expected — we're still inside the cooling window
  assert.equal(calls.length, 0);
});

test("Gap 5 does not fire on SHORT trigger that's neither graze nor breakout", async () => {
  __resetSpotHistoryForTests();
  process.env.PILOT_TP_GAP5_ENFORCE = "true";
  try {
    const pool = await buildPool();
    const now = Date.now();
    for (let h = 24; h >= 0; h--) {
      recordSpotSample(74000 + h * 5, now - h * HOUR_MS);
    }

    // SHORT 2% trade where BTC was 0.6% past trigger AT trigger fire and
    // remains 0.6% past now. "Shallow" — beyond the 0.3% barely-graze
    // threshold but below the 1.0% clear-breakout threshold. Neither
    // Gap 5a nor 5b should fire.
    //
    // Note: post Gap 5a-fix-1, the at-trigger spot (triggerReferencePrice)
    // is what classifies barely-graze, so we set it to genuinely 0.6%
    // past the trigger of $75,480 = $75,933.
    await seedTriggered(pool, {
      direction: "short",
      triggerAtMs: now - 10 * MIN_MS,
      expiryAtMs: now + 20 * HOUR_MS,
      entry: 74000,
      triggerPrice: 75480,
      triggerReferencePrice: 75933,  // 0.6% past trigger at fire — shallow
      strike: 75500,
      payoutDueAmount: 400
    });

    const { sellOption, calls } = buildSellRecorder();
    const logs = await captureCycle({
      pool, sellOption,
      currentSpot: 75933,  // still 0.6% past trigger
      currentIV: 0.45
    });

    const gap5aLine = logs.find((l) => l.includes("Gap 5a ENFORCE") || l.includes("Gap 5a OBSERVE"));
    const gap5bLine = logs.find((l) => l.includes("Gap 5b ENFORCE") || l.includes("Gap 5b OBSERVE"));
    assert.ok(!gap5aLine, "Gap 5a should not fire — spot is past graze threshold");
    assert.ok(!gap5bLine, "Gap 5b should not fire — spot is below breakout threshold");
    assert.equal(calls.length, 0, "no Gap 5 sell expected for shallow pattern");
  } finally {
    delete process.env.PILOT_TP_GAP5_ENFORCE;
  }
});
