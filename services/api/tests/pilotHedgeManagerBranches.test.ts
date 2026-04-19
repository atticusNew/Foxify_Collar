import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { ensurePilotSchema, insertProtection } from "../src/pilot/db.js";
import { runHedgeManagementCycle } from "../src/pilot/hedgeManager.js";

// R5 — Pre-live-pilot TP-branch coverage tests.
//
// Per the TP optimization analysis (PR #38), 100% of the n=9 post-switch
// triggers we've seen on the paper account hit the bounce-recovery branch.
// Three branches in the decision tree have NEVER been exercised live:
//   - deep_drop_tp           (≥ 1.5% past floor + cooling + ≥ prime threshold)
//   - near_expiry_salvage    (< 6h to expiry + ≥ $3 value)
//   - take_profit_late       (> primeWindowEnd hours post-trigger + ≥ late threshold)
//
// We can't make the market actually go deep / late in a controlled way, but
// we CAN seed a synthetic protection row + drive the hedge manager with
// chosen (spot, IV, time) inputs and observe whether it fires a sell call.
//
// pg-mem has known issues with the `metadata = metadata || $::jsonb` jsonb
// concatenation pattern that updateHedgeStatus uses (production Postgres
// handles it fine; we use it elsewhere already, e.g. the trigger monitor).
// So we observe branch firing via captured sellOption() calls and via the
// captured console.log lines that the hedge manager emits BEFORE the post-
// sell metadata write — those are unaffected by the pg-mem JSON quirk.
//
// All branches are exercised in a SINGLE test against ONE pool (sequentially)
// because pg-mem schema persistence across multiple tests in the same file
// is unreliable. Sequential exercise with assertion-per-branch is equivalent.

const HOUR_MS = 3600 * 1000;

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensurePilotSchema(pool);
  return pool;
};

const fakeVenue = {} as any; // venue is a dead parameter in runHedgeManagementCycle

type SellCall = { instrumentId: string; quantity: number };
const buildSellRecorder = () => {
  const calls: SellCall[] = [];
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

// Capture stdout for the duration of one cycle so we can grep for which branch
// fired. The hedge manager emits "[HedgeManager] TP decision (REASON):" or
// "[HedgeManager] Selling (REASON):" which we parse out.
const runCycleWithCapture = async (params: {
  pool: any;
  sellOption: any;
  currentSpot: number;
  currentIV: number;
}) => {
  const captured: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
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
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  // Find the first "Selling (REASON):" or "TP decision (REASON):" line.
  for (const line of captured) {
    const m =
      line.match(/Selling \(([^)]+)\):/) ??
      line.match(/TP decision \(([^)]+)\):/);
    if (m) return { firedReason: m[1], allLog: captured };
  }
  return { firedReason: null, allLog: captured };
};

const seedHedge = async (
  pool: any,
  opts: {
    status: "triggered" | "active";
    protectionType: "long" | "short";
    slPct: number;
    notional: number;
    entry: number;
    strike: number;
    triggerAtMs: number;
    expiryAtMs: number;
    payoutDueAmount?: number;
    hedgeQty?: number;
    premium?: number;
  }
) => {
  const optType = opts.protectionType === "short" ? "C" : "P";
  const instrument = `BTC-19APR26-${opts.strike}-${optType}`;
  const drawdownFloorPct = String(opts.slPct / 100);
  const floorPrice =
    opts.protectionType === "short"
      ? (opts.entry * (1 + opts.slPct / 100)).toFixed(10)
      : (opts.entry * (1 - opts.slPct / 100)).toFixed(10);
  const md: Record<string, unknown> = { protectionType: opts.protectionType };
  if (opts.triggerAtMs > 0) {
    md.triggerMonitorAt = new Date(opts.triggerAtMs).toISOString();
    md.triggerAt = new Date(opts.triggerAtMs).toISOString();
  }
  const seeded = await insertProtection(pool, {
    userHash: "hh-test",
    hashVersion: 1,
    status: opts.status,
    tierName: `SL ${opts.slPct}%`,
    drawdownFloorPct,
    slPct: opts.slPct,
    hedgeStatus: "active",
    marketId: "BTC-USD",
    protectedNotional: String(opts.notional),
    foxifyExposureNotional: String(opts.notional),
    expiryAt: new Date(opts.expiryAtMs).toISOString(),
    autoRenew: false,
    renewWindowMinutes: 1440,
    metadata: md
  });
  await pool.query(
    `UPDATE pilot_protections SET
       venue = 'deribit_test',
       instrument_id = $1,
       side = 'buy',
       size = $2,
       execution_price = '0.001',
       premium = $3,
       payout_due_amount = $4,
       floor_price = $5
     WHERE id = $6`,
    [
      instrument,
      String(opts.hedgeQty ?? 0.1),
      String(
        opts.premium ?? (opts.notional / 1000) * (opts.slPct === 2 ? 6 : opts.slPct === 3 ? 4 : opts.slPct === 5 ? 3 : 2)
      ),
      String(opts.payoutDueAmount ?? opts.notional * (opts.slPct / 100)),
      floorPrice,
      seeded.id
    ]
  );
  return seeded.id;
};

// Reset everything between sub-cases by deleting all rows. (Schema lives.)
const reset = async (pool: any) => pool.query(`DELETE FROM pilot_protections`);

test("R5: hedge manager TP decision tree exercises all 5 branches correctly (deep_drop, near_expiry, late, bounce-threshold, active_salvage, cooling)", async () => {
  const pool = await buildPool();

  // ── R5.1: deep_drop_tp ──────────────────────────────────────────────────
  // Setup: triggered 0.25h ago. Floor at $75,460. Spot $74,200 (1.67% past
  // floor — above 1.5% deep-drop threshold). Past 0.167h deep-drop cooling.
  // Strike $75,500 ITM put with intrinsic $1,300/BTC × 0.1 = $130 (well
  // above prime threshold of 0.25 × $200 = $50). Expect deep_drop_tp.
  await reset(pool);
  await seedHedge(pool, {
    status: "triggered", protectionType: "long", slPct: 2,
    notional: 10000, entry: 77000, strike: 75500,
    triggerAtMs: Date.now() - 0.25 * HOUR_MS,
    expiryAtMs: Date.now() + 18 * HOUR_MS,
    payoutDueAmount: 200, hedgeQty: 0.1
  });
  let recorder = buildSellRecorder();
  let result = await runCycleWithCapture({ pool, sellOption: recorder.sellOption, currentSpot: 74200, currentIV: 45 });
  assert.equal(result.firedReason, "deep_drop_tp", `R5.1 expected deep_drop_tp, got ${result.firedReason}`);
  assert.equal(recorder.calls.length, 1, "R5.1 should produce one sell call");

  // ── R5.2: near_expiry_salvage ───────────────────────────────────────────
  // 4h to expiry (< 6h near-expiry window). Triggered 12h ago (well past prime).
  // Strike $76,000 put, spot $76,500 OTM. BS time value should still be > $3.
  // Near-expiry is checked FIRST in tree; should fire even though late branch
  // would also qualify.
  await reset(pool);
  await seedHedge(pool, {
    status: "triggered", protectionType: "long", slPct: 2,
    notional: 10000, entry: 77500, strike: 76000,
    triggerAtMs: Date.now() - 12 * HOUR_MS,
    expiryAtMs: Date.now() + 4 * HOUR_MS,
    payoutDueAmount: 200, hedgeQty: 0.1
  });
  recorder = buildSellRecorder();
  result = await runCycleWithCapture({ pool, sellOption: recorder.sellOption, currentSpot: 76500, currentIV: 45 });
  assert.equal(result.firedReason, "near_expiry_salvage", `R5.2 expected near_expiry_salvage, got ${result.firedReason}`);
  assert.equal(recorder.calls.length, 1, "R5.2 should produce one sell call");

  // ── R5.3: take_profit_late ──────────────────────────────────────────────
  // Triggered 10h ago (past 8h primeWindowEnd). Expiry 14h away (NOT in
  // < 6h near-expiry window). Spot must NOT be ≥ 1.5% past floor (would
  // hit deep_drop branch first in the decision tree). Setup: SL 2% long,
  // entry $77,500 → floor $75,950. Spot $75,500 = ($75,950 - $75,500)/
  // $75,950 = 0.59% past floor (below 1.5% deep-drop threshold). Strike
  // $76,000 → intrinsic = ($76,000 - $75,500) × 0.1 = $50/contract × 0.1
  // BTC = $5/BTC, but BS at T=14h with sigma=0.45 should add another
  // $40-50 of time value. Total option value ≥ $40-55 (well above late
  // threshold of 0.10 × $200 = $20).
  await reset(pool);
  await seedHedge(pool, {
    status: "triggered", protectionType: "long", slPct: 2,
    notional: 10000, entry: 77500, strike: 76000,
    triggerAtMs: Date.now() - 10 * HOUR_MS,
    expiryAtMs: Date.now() + 14 * HOUR_MS,
    payoutDueAmount: 200, hedgeQty: 0.1
  });
  recorder = buildSellRecorder();
  result = await runCycleWithCapture({ pool, sellOption: recorder.sellOption, currentSpot: 75500, currentIV: 45 });
  assert.equal(result.firedReason, "take_profit_late", `R5.3 expected take_profit_late, got ${result.firedReason}`);
  assert.equal(recorder.calls.length, 1, "R5.3 should produce one sell call");

  // ── R5.4: bounce_recovery threshold respected ($5 post-PR-#39) ──────────
  // Triggered 1h ago (past 0.5h cooling). Spot $77,500 — pushed FAR above
  // $75,460 floor and well above strike → deeply OTM = nearly-zero time
  // value. Combined with 1.5h to expiry = minimal residual value. Hedge
  // qty = 0.005 BTC (very small) keeps total option value × qty below
  // the $5 threshold. Expect NO sell.
  // Pre-fix (when threshold was $3): would have sold for ~$2 net = always
  // a paper loss after fees. Post-fix (threshold $5): correctly held.
  await reset(pool);
  await seedHedge(pool, {
    status: "triggered", protectionType: "long", slPct: 2,
    notional: 10000, entry: 77000, strike: 76000,
    triggerAtMs: Date.now() - 1 * HOUR_MS,
    expiryAtMs: Date.now() + 1.5 * HOUR_MS,
    payoutDueAmount: 200, hedgeQty: 0.005
  });
  recorder = buildSellRecorder();
  result = await runCycleWithCapture({ pool, sellOption: recorder.sellOption, currentSpot: 77500, currentIV: 45 });
  if (recorder.calls.length !== 0) {
    process.stderr.write("\nR5.4 DEBUG — captured cycle log:\n" + result.allLog.join("\n") + "\n");
  }
  assert.equal(recorder.calls.length, 0, "R5.4 sub-threshold bounce-recovery must NOT sell");

  // ── R5.5: active_salvage ────────────────────────────────────────────────
  // Active (never triggered) position. 3h to expiry (< 4h salvage window).
  // Bought 76000-P while spot was 77k; spot now $74,000 → deep ITM,
  // intrinsic $200 × 0.1 = $20 (above $5 active-salvage min).
  await reset(pool);
  await seedHedge(pool, {
    status: "active", protectionType: "long", slPct: 5,
    notional: 10000, entry: 77000, strike: 76000,
    triggerAtMs: 0,
    expiryAtMs: Date.now() + 3 * HOUR_MS,
    payoutDueAmount: 0, hedgeQty: 0.1
  });
  recorder = buildSellRecorder();
  result = await runCycleWithCapture({ pool, sellOption: recorder.sellOption, currentSpot: 74000, currentIV: 45 });
  assert.equal(result.firedReason, "active_salvage", `R5.5 expected active_salvage, got ${result.firedReason}`);
  assert.equal(recorder.calls.length, 1, "R5.5 should fire active_salvage");

  // ── R5.6: cooling period blocks any sell ────────────────────────────────
  // Triggered 5 minutes ago. Normal cooling 0.5h. Should hold.
  await reset(pool);
  await seedHedge(pool, {
    status: "triggered", protectionType: "long", slPct: 2,
    notional: 10000, entry: 77000, strike: 76000,
    triggerAtMs: Date.now() - 5 * 60 * 1000,
    expiryAtMs: Date.now() + 23 * HOUR_MS,
    payoutDueAmount: 200, hedgeQty: 0.1
  });
  recorder = buildSellRecorder();
  result = await runCycleWithCapture({ pool, sellOption: recorder.sellOption, currentSpot: 75000, currentIV: 45 });
  assert.equal(recorder.calls.length, 0, "R5.6 cooling period must block sells");

  // ── R5.7: high-DVOL regime parameters apply (cooling → 1h, prime → 0.35) ─
  // Same setup as R5.6 (triggered 5 min ago, ITM put). With currentIV=70
  // (high regime → cooling = 1h). Should still hold.
  // Then jump time forward by changing triggerAtMs to 1.5h ago AND keep
  // ITM well above prime threshold of 0.35 × $200 = $70 (intrinsic = $1000
  // × 0.1 = $100). Expect take_profit_prime under high regime.
  await reset(pool);
  await seedHedge(pool, {
    status: "triggered", protectionType: "long", slPct: 2,
    notional: 10000, entry: 77000, strike: 76000,
    triggerAtMs: Date.now() - 1.5 * HOUR_MS,
    expiryAtMs: Date.now() + 22 * HOUR_MS,
    payoutDueAmount: 200, hedgeQty: 0.1
  });
  recorder = buildSellRecorder();
  result = await runCycleWithCapture({ pool, sellOption: recorder.sellOption, currentSpot: 75000, currentIV: 70 });
  assert.equal(result.firedReason, "take_profit_prime", `R5.7 high-regime prime expected, got ${result.firedReason}`);
  assert.equal(recorder.calls.length, 1, "R5.7 high-regime prime should fire one sell");
});
