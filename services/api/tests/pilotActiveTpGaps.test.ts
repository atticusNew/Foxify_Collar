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

// PR C — active TP gap regression tests.
//
// We drive synthetic spot history into the spotHistory ring buffer and
// then run a single hedge cycle, capturing log lines to verify the
// expected gap fired (or correctly didn't fire when in observe-only
// mode).

const HOUR_MS = 3600 * 1000;

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
  const calls: Array<{ instrumentId: string; quantity: number }> = [];
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

const seedTriggeredLong = async (
  pool: any,
  opts: {
    triggerAtMs: number;
    expiryAtMs: number;
    entry: number;
    strike: number;
    payoutDueAmount?: number;
    hedgeQty?: number;
  }
) => {
  const seeded = await insertProtection(pool, {
    userHash: "hh-tp-c",
    hashVersion: 1,
    status: "triggered" as any,
    tierName: "SL 2%",
    drawdownFloorPct: "0.02",
    slPct: 2,
    hedgeStatus: "active",
    marketId: "BTC-USD",
    protectedNotional: "10000",
    foxifyExposureNotional: "10000",
    expiryAt: new Date(opts.expiryAtMs).toISOString(),
    autoRenew: false,
    renewWindowMinutes: 1440,
    metadata: {
      protectionType: "long",
      triggerMonitorAt: new Date(opts.triggerAtMs).toISOString(),
      triggerAt: new Date(opts.triggerAtMs).toISOString()
    }
  });
  const floorPrice = (opts.entry * 0.98).toFixed(10);
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
      `BTC-19APR26-${opts.strike}-P`,
      String(opts.hedgeQty ?? 0.1),
      String(opts.payoutDueAmount ?? 200),
      floorPrice,
      seeded.id
    ]
  );
  return seeded.id;
};

test("Gap 1 — observe-only: logs would-fire on volatility spike, does NOT execute sell", async () => {
  __resetSpotHistoryForTests();
  delete process.env.PILOT_TP_GAP1_ENFORCE;
  const pool = await buildPool();
  const now = Date.now();

  // Seed spot history: 100k two hours ago, 96k now → -4% move (above
  // default 3% threshold).
  recordSpotSample(100_000, now - 2 * HOUR_MS);
  recordSpotSample(98_000, now - 1 * HOUR_MS);
  recordSpotSample(96_000, now);

  // Seed a triggered long position with an ITM put that's worth >= $50.
  // Strike $98,000 with current spot $96,000 → intrinsic $2,000 per BTC × 0.1 = $200.
  await seedTriggeredLong(pool, {
    triggerAtMs: now - 0.5 * HOUR_MS,
    expiryAtMs: now + 18 * HOUR_MS,
    entry: 100_000,
    strike: 98_000,
    payoutDueAmount: 200,
    hedgeQty: 0.1
  });

  const recorder = buildSellRecorder();
  const log = await captureCycle({ pool, sellOption: recorder.sellOption, currentSpot: 96_000, currentIV: 45 });

  const observeLine = log.find((l) => l.includes("Gap 1 OBSERVE"));
  assert.ok(observeLine, "Gap 1 should log observe-only line");
  assert.ok(observeLine!.includes("would force-sell"), `observe line content: ${observeLine}`);
  // Either zero sells, or the existing TP tree fired for some other reason
  // (e.g. deep_drop_tp). We just need to verify Gap 1 did NOT fire its
  // own enforcement sell.
  const gap1EnforceLine = log.find((l) => l.includes("Gap 1 ENFORCE"));
  assert.equal(gap1EnforceLine, undefined, "Gap 1 should NOT enforce in observe-only mode");
});

test("Gap 1 — enforce mode: forces sell on volatility spike with vol_spike_forced_exit reason", async () => {
  __resetSpotHistoryForTests();
  process.env.PILOT_TP_GAP1_ENFORCE = "true";
  const pool = await buildPool();
  const now = Date.now();

  recordSpotSample(100_000, now - 2 * HOUR_MS);
  recordSpotSample(96_000, now);

  // Seed a position that would otherwise be in cooling (triggered 5 min
  // ago, well under the 30-min cooling window). Without Gap 1, no sell
  // would fire. With Gap 1 enforced, a vol_spike_forced_exit sell should.
  await seedTriggeredLong(pool, {
    triggerAtMs: now - 0.083 * HOUR_MS, // 5 min ago
    expiryAtMs: now + 18 * HOUR_MS,
    entry: 100_000,
    strike: 98_000,
    payoutDueAmount: 200,
    hedgeQty: 0.1
  });

  const recorder = buildSellRecorder();
  const log = await captureCycle({ pool, sellOption: recorder.sellOption, currentSpot: 96_000, currentIV: 45 });

  try {
    const enforceLine = log.find((l) => l.includes("Gap 1 ENFORCE"));
    assert.ok(enforceLine, `Gap 1 should log ENFORCE — captured: ${log.join("\n  ")}`);
    assert.ok(enforceLine!.includes("Forcing sale"), "enforce line should announce sale");
    assert.equal(recorder.calls.length, 1, "exactly one sell call");
  } finally {
    delete process.env.PILOT_TP_GAP1_ENFORCE;
  }
});

test("Gap 1 — does not fire when option value below min_value_usd threshold", async () => {
  __resetSpotHistoryForTests();
  process.env.PILOT_TP_GAP1_ENFORCE = "true";
  process.env.PILOT_TP_GAP1_MIN_VALUE_USD = "500"; // unrealistically high so we can never satisfy it
  const pool = await buildPool();
  const now = Date.now();

  recordSpotSample(100_000, now - 2 * HOUR_MS);
  recordSpotSample(96_000, now);

  await seedTriggeredLong(pool, {
    triggerAtMs: now - 0.083 * HOUR_MS,
    expiryAtMs: now + 18 * HOUR_MS,
    entry: 100_000,
    strike: 98_000,
    payoutDueAmount: 200,
    hedgeQty: 0.1
  });

  const recorder = buildSellRecorder();
  const log = await captureCycle({ pool, sellOption: recorder.sellOption, currentSpot: 96_000, currentIV: 45 });
  try {
    const enforceLine = log.find((l) => l.includes("Gap 1 ENFORCE"));
    assert.equal(enforceLine, undefined, "Gap 1 should not fire when value < threshold");
  } finally {
    delete process.env.PILOT_TP_GAP1_ENFORCE;
    delete process.env.PILOT_TP_GAP1_MIN_VALUE_USD;
  }
});

test("Gap 3 — observe-only: logs would-shrink on sustained drop, does NOT change effective cooling", async () => {
  __resetSpotHistoryForTests();
  delete process.env.PILOT_TP_GAP3_ENFORCE;
  // Compress lookback window to 2h for testability — placing a sample
  // at exactly the production 24h boundary fights the cleanup pass.
  process.env.PILOT_TP_GAP3_WINDOW_HOURS = "2";
  const pool = await buildPool();
  const now = Date.now();

  // 100k 2h ago, 92k now → -8% drop (above default 5%).
  recordSpotSample(100_000, now - 2 * HOUR_MS);
  recordSpotSample(96_000, now - 1 * HOUR_MS);
  recordSpotSample(92_000, now);

  await seedTriggeredLong(pool, {
    triggerAtMs: now - 0.25 * HOUR_MS,
    expiryAtMs: now + 18 * HOUR_MS,
    entry: 100_000,
    strike: 98_000,
    payoutDueAmount: 200,
    hedgeQty: 0.1
  });

  const recorder = buildSellRecorder();
  const log = await captureCycle({ pool, sellOption: recorder.sellOption, currentSpot: 92_000, currentIV: 45 });

  try {
    const observeLine = log.find((l) => l.includes("Gap 3 OBSERVE"));
    assert.ok(observeLine, `Gap 3 should log observe-only line; captured tail: ${log.slice(-5).join(" | ")}`);
    assert.ok(observeLine!.includes("would shrink"), `observe content: ${observeLine}`);
    const enforceLine = log.find((l) => l.includes("Gap 3 ENFORCE"));
    assert.equal(enforceLine, undefined, "Gap 3 should NOT enforce in observe-only mode");
  } finally {
    delete process.env.PILOT_TP_GAP3_WINDOW_HOURS;
  }
});

test("Gap 3 — enforce mode: shrinks cooling window for long protections", async () => {
  __resetSpotHistoryForTests();
  process.env.PILOT_TP_GAP3_ENFORCE = "true";
  process.env.PILOT_TP_GAP3_WINDOW_HOURS = "2";
  const pool = await buildPool();
  const now = Date.now();

  recordSpotSample(100_000, now - 2 * HOUR_MS);
  recordSpotSample(92_000, now);

  await seedTriggeredLong(pool, {
    triggerAtMs: now - 0.25 * HOUR_MS,
    expiryAtMs: now + 18 * HOUR_MS,
    entry: 100_000,
    strike: 98_000,
    payoutDueAmount: 200,
    hedgeQty: 0.1
  });

  const recorder = buildSellRecorder();
  const log = await captureCycle({ pool, sellOption: recorder.sellOption, currentSpot: 92_000, currentIV: 45 });
  try {
    const enforceLine = log.find((l) => l.includes("Gap 3 ENFORCE"));
    assert.ok(enforceLine, `Gap 3 should log ENFORCE — captured: ${log.slice(-10).join("\n  ")}`);
    assert.ok(/cooling .* → /.test(enforceLine!), "enforce line should show old → new cooling");
  } finally {
    delete process.env.PILOT_TP_GAP3_ENFORCE;
    delete process.env.PILOT_TP_GAP3_WINDOW_HOURS;
  }
});

test("Gap 3 — does not fire when spot drop below threshold", async () => {
  __resetSpotHistoryForTests();
  process.env.PILOT_TP_GAP3_ENFORCE = "true";
  process.env.PILOT_TP_GAP3_WINDOW_HOURS = "2";
  const pool = await buildPool();
  const now = Date.now();

  // Spot only down 1% — below default 5% threshold
  recordSpotSample(100_000, now - 2 * HOUR_MS);
  recordSpotSample(99_000, now);

  await seedTriggeredLong(pool, {
    triggerAtMs: now - 0.25 * HOUR_MS,
    expiryAtMs: now + 18 * HOUR_MS,
    entry: 100_000,
    strike: 98_000,
    payoutDueAmount: 200,
    hedgeQty: 0.1
  });

  const recorder = buildSellRecorder();
  const log = await captureCycle({ pool, sellOption: recorder.sellOption, currentSpot: 99_000, currentIV: 45 });
  try {
    const enforceLine = log.find((l) => l.includes("Gap 3 ENFORCE"));
    assert.equal(enforceLine, undefined, "Gap 3 should not fire when below threshold");
  } finally {
    delete process.env.PILOT_TP_GAP3_ENFORCE;
    delete process.env.PILOT_TP_GAP3_WINDOW_HOURS;
  }
});
