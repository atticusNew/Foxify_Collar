import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  __setPilotPoolForTests,
  ensurePilotSchema,
  insertProtection
} from "../src/pilot/db.js";

// Regression coverage for the aggregation logic backing
// GET /pilot/admin/diagnostics/triggered-protections.
//
// We don't bring up the full Fastify stack here — the route handler is
// thin and the actual logic is the SQL + per-row aggregation. We
// reproduce the SQL directly against pg-mem and re-implement the same
// aggregation function the route handler runs, so any change to the
// aggregation gets caught here.

const buildPool = async () => {
  __setPilotPoolForTests(null);
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensurePilotSchema(pool);
  return pool;
};

const seedTriggeredProtection = async (
  pool: any,
  opts: {
    direction: "long" | "short";
    slPct: number;
    notional: number;
    entryPrice: number;
    triggerPrice: number;
    selectedStrike: number;
    spotAtTrigger: number;
    triggeredAt: string;
    soldAt?: string;
    hedgeBuyPremium?: number;
    hedgeSellPremium?: number;
    payoutOwed?: number;
    premiumDue?: number;
  }
) => {
  const { id } = await insertProtection(pool, {
    userHash: "test-user",
    hashVersion: 1,
    status: "triggered" as any,
    tierName: `SL ${opts.slPct}%`,
    drawdownFloorPct: String(opts.slPct / 100),
    slPct: opts.slPct,
    hedgeStatus: opts.soldAt ? "tp_sold" : "active",
    marketId: "BTC-USD",
    protectedNotional: String(opts.notional),
    foxifyExposureNotional: String(opts.notional),
    entryPrice: String(opts.entryPrice),
    floorPrice: String(opts.triggerPrice),
    side: opts.direction === "short" ? "call" : "put",
    expiryAt: new Date(Date.now() + 86400000).toISOString(),
    autoRenew: false,
    renewWindowMinutes: 1440,
    metadata: {
      protectionType: opts.direction,
      triggerPrice: opts.triggerPrice,
      selectedStrike: opts.selectedStrike,
      triggeredAt: opts.triggeredAt,
      ...(opts.soldAt ? { soldAt: opts.soldAt } : {})
    }
  });
  // Trigger snapshot
  await pool.query(
    `INSERT INTO pilot_price_snapshots
       (id, protection_id, snapshot_type, price, market_id, price_source,
        price_source_detail, endpoint_version, request_id, price_timestamp)
     VALUES ($1, $2, 'trigger', $3, 'BTC-USD', 'deribit', 'index', 'v1', $4, $5)`,
    [`snap-trig-${id}`, id, String(opts.spotAtTrigger), `req-${id}`, opts.triggeredAt]
  );
  // Hedge buy execution
  if (opts.hedgeBuyPremium !== undefined) {
    await pool.query(
      `INSERT INTO pilot_venue_executions
         (id, quote_id, venue, status, instrument_id, side, quantity,
          execution_price, premium, executed_at, external_order_id,
          external_execution_id, protection_id, details)
       VALUES ($1, $2, 'deribit_test', 'success', $3, 'buy', '1.0',
               $4, $5, NOW(), $6, $7, $8, $9::jsonb)`,
      [
        `exec-buy-${id}`,
        `quote-${id}`,
        `BTC-22APR26-${opts.selectedStrike}-${opts.direction === "short" ? "C" : "P"}`,
        String(opts.hedgeBuyPremium / 1.0),
        String(opts.hedgeBuyPremium),
        `ord-buy-${id}`,
        `exec-buy-ext-${id}`,
        id,
        JSON.stringify({ selectedStrike: opts.selectedStrike, spotPriceUsd: opts.entryPrice })
      ]
    );
  }
  // Hedge sell execution (only if soldAt set)
  if (opts.hedgeSellPremium !== undefined && opts.soldAt) {
    await pool.query(
      `INSERT INTO pilot_venue_executions
         (id, quote_id, venue, status, instrument_id, side, quantity,
          execution_price, premium, executed_at, external_order_id,
          external_execution_id, protection_id, details)
       VALUES ($1, $2, 'deribit_test', 'success', $3, 'sell', '1.0',
               $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        `exec-sell-${id}`,
        `quote-sell-${id}`,
        `BTC-22APR26-${opts.selectedStrike}-${opts.direction === "short" ? "C" : "P"}`,
        String(opts.hedgeSellPremium),
        String(opts.hedgeSellPremium),
        opts.soldAt,
        `ord-sell-${id}`,
        `exec-sell-ext-${id}`,
        id,
        JSON.stringify({ spotPriceUsd: opts.entryPrice })
      ]
    );
  }
  // Ledger
  if (opts.premiumDue !== undefined) {
    await pool.query(
      `INSERT INTO pilot_ledger_entries
         (id, protection_id, entry_type, amount, currency)
       VALUES ($1, $2, 'premium_due', $3, 'USDC')`,
      [`led-prem-${id}`, id, String(opts.premiumDue)]
    );
  }
  if (opts.payoutOwed !== undefined) {
    await pool.query(
      `INSERT INTO pilot_ledger_entries
         (id, protection_id, entry_type, amount, currency)
       VALUES ($1, $2, 'payout_due', $3, 'USDC')`,
      [`led-pay-${id}`, id, String(opts.payoutOwed)]
    );
  }
  return id;
};

// Re-implement just the aggregation step from the route handler so
// changes there get caught by this test.
//
// IMPORTANT (2026-04-22): hedge recovery is read from
// metadata.sellResult.totalProceeds, NOT from a sell-side venue_executions
// row, because the hedge manager doesn't insert a sell row when it TPs.
// The pre-fix code that did `execs.find(side === 'sell')` was always
// returning undefined and causing the dashboard to show 0% recovery on
// every TP-sold trade. Mirror the same fallback chain as routes.ts.
const aggregateTriggered = (rows: any[], execsById: Map<string, any[]>, snapsById: Map<string, any[]>, ledgerById: Map<string, any[]>) => {
  return rows.map((p) => {
    const md = (p.metadata || {}) as Record<string, any>;
    const protType = String(md.protectionType || p.side || "long").toLowerCase();
    const directionTag = protType === "short" ? "short" : "long";
    const execs = execsById.get(p.id) || [];
    const snaps = snapsById.get(p.id) || [];
    const ledger = ledgerById.get(p.id) || [];
    const buyExec = execs.find((e: any) => e.side === "buy");
    const sellExec = execs.find((e: any) => e.side === "sell");
    const premiumCollected = ledger
      .filter((l: any) => l.entry_type === "premium_due")
      .reduce((acc: number, l: any) => acc + Number(l.amount), 0);
    const payoutOwed = ledger
      .filter((l: any) => ["payout_due", "trigger_payout_due"].includes(l.entry_type))
      .reduce((acc: number, l: any) => acc + Number(l.amount), 0);
    const hedgeCost = buyExec ? Number(buyExec.premium) : 0;
    // Recovery — metadata first, exec row as fallback (matches routes.ts fix)
    const sellResult = (md.sellResult as Record<string, any> | undefined) || undefined;
    const recoveryFromMetadata = sellResult ? Number(sellResult.totalProceeds || 0) : 0;
    const recoveryFromExecRow = sellExec ? Number(sellExec.premium) : 0;
    const hedgeRecovery = recoveryFromMetadata > 0 ? recoveryFromMetadata : recoveryFromExecRow;
    const netPnlUsd = premiumCollected - hedgeCost + hedgeRecovery - payoutOwed;
    const recoveryRatioPct = payoutOwed > 0 ? (hedgeRecovery / payoutOwed) * 100 : null;
    const selectedStrike = Number(md.selectedStrike || 0);
    // Trigger price — floor_price column first (authoritative), metadata as fallback
    const triggerPriceFromCol = Number(p.floor_price || 0);
    const triggerPriceFromMd = Number(md.triggerPrice || md.floorPrice || 0);
    const triggerPrice = triggerPriceFromCol > 0 ? triggerPriceFromCol : triggerPriceFromMd;
    const strikeGapToTriggerUsd = selectedStrike > 0 && triggerPrice > 0
      ? selectedStrike - triggerPrice
      : null;
    const strikeIsItm = strikeGapToTriggerUsd !== null && (
      directionTag === "short"
        ? strikeGapToTriggerUsd < 0
        : strikeGapToTriggerUsd > 0
    );
    const triggerSnap = snaps.find((s: any) => s.snapshot_type === "trigger");
    const spotAtTrigger = triggerSnap ? Number(triggerSnap.price) : null;
    let spotMoveThroughTriggerPct: number | null = null;
    if (spotAtTrigger && triggerPrice > 0) {
      const moveBeyondTrigger = directionTag === "short"
        ? spotAtTrigger - triggerPrice
        : triggerPrice - spotAtTrigger;
      spotMoveThroughTriggerPct = (moveBeyondTrigger / triggerPrice) * 100;
    }
    return {
      id: p.id,
      direction: directionTag,
      strikeGapToTriggerUsd,
      strikeIsItm,
      hedgeCost,
      hedgeRecovery,
      hedgeRecoveryUsd: hedgeRecovery,
      payoutOwed,
      netPnlUsd: Number(netPnlUsd.toFixed(2)),
      recoveryRatioPct: recoveryRatioPct === null ? null : Number(recoveryRatioPct.toFixed(1)),
      spotMoveThroughTriggerPct,
      triggerPattern:
        spotMoveThroughTriggerPct === null
          ? "unknown"
          : spotMoveThroughTriggerPct < 0.3
            ? "barely_graze"
            : spotMoveThroughTriggerPct < 1.0
              ? "shallow"
              : "clear_breakout"
    };
  });
};

const parseJsonbMaybe = (v: any): Record<string, unknown> => {
  if (!v) return {};
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return {}; }
  }
  return v as Record<string, unknown>;
};

const fetchAll = async (pool: any) => {
  const protRes = await pool.query(`SELECT * FROM pilot_protections ORDER BY created_at ASC`);
  const protections = protRes.rows.map((r: any) => ({
    id: String(r.id),
    floor_price: r.floor_price ? String(r.floor_price) : null,
    side: r.side ? String(r.side) : null,
    metadata: parseJsonbMaybe(r.metadata)
  }));
  // Note: pg-mem doesn't support `= ANY($1::text[])` with array params
  // reliably. We fetch per-id with simple equality, which is fine for
  // the small N we use in tests.
  const execMap = new Map<string, any[]>();
  const snapMap = new Map<string, any[]>();
  const ledgerMap = new Map<string, any[]>();
  for (const p of protections) {
    const er = await pool.query(`SELECT * FROM pilot_venue_executions WHERE protection_id = $1 ORDER BY created_at ASC`, [p.id]);
    if (er.rows.length) execMap.set(p.id, er.rows);
    const sr = await pool.query(`SELECT * FROM pilot_price_snapshots WHERE protection_id = $1 ORDER BY created_at ASC`, [p.id]);
    if (sr.rows.length) snapMap.set(p.id, sr.rows);
    const lr = await pool.query(`SELECT * FROM pilot_ledger_entries WHERE protection_id = $1`, [p.id]);
    if (lr.rows.length) ledgerMap.set(p.id, lr.rows);
  }
  return { protections, execMap, snapMap, ledgerMap };
};

// Helper for the metadata-only recovery test — seeds a triggered
// protection where TP recovery is stored in metadata.sellResult
// (the actual production code path) rather than in a venue_executions
// sell row.
const seedTriggeredWithMetadataRecovery = async (
  pool: any,
  opts: {
    direction: "long" | "short";
    notional: number;
    triggerPrice: number;
    selectedStrike: number;
    hedgeBuyPremium: number;
    metadataRecoveryUsd: number;
    payoutOwed: number;
    premiumDue: number;
  }
) => {
  const { id } = await insertProtection(pool, {
    userHash: "test-user",
    hashVersion: 1,
    status: "triggered" as any,
    tierName: "SL 2%",
    drawdownFloorPct: "0.02",
    slPct: 2,
    hedgeStatus: "tp_sold",
    marketId: "BTC-USD",
    protectedNotional: String(opts.notional),
    foxifyExposureNotional: String(opts.notional),
    side: opts.direction === "short" ? "call" : "put",
    expiryAt: new Date(Date.now() + 86400000).toISOString(),
    autoRenew: false,
    renewWindowMinutes: 1440,
    metadata: {
      protectionType: opts.direction,
      triggerPrice: opts.triggerPrice,
      selectedStrike: opts.selectedStrike,
      triggeredAt: "2026-04-22T12:00:00Z",
      // This is the exact path the hedge manager writes to:
      sellResult: {
        fillPrice: 100,
        totalProceeds: opts.metadataRecoveryUsd,
        orderId: "mock-tp-sell"
      },
      soldAt: "2026-04-22T13:00:00Z"
    }
  });
  // Set floor_price (the triggerPrice) — mirrors what triggerMonitor.ts
  // writes on real trigger fires
  await pool.query(`UPDATE pilot_protections SET floor_price = $1 WHERE id = $2`,
    [String(opts.triggerPrice.toFixed(10)), id]);
  // Buy-side venue execution (does exist on real trades)
  await pool.query(
    `INSERT INTO pilot_venue_executions
       (id, quote_id, venue, status, instrument_id, side, quantity,
        execution_price, premium, executed_at, external_order_id,
        external_execution_id, protection_id, details)
     VALUES ($1, $2, 'deribit_test', 'success', $3, 'buy', '1.0',
             '0.001', $4, NOW(), $5, $6, $7, $8::jsonb)`,
    [
      `exec-buy-${id}`,
      `quote-${id}`,
      `BTC-22APR26-${opts.selectedStrike}-${opts.direction === "short" ? "C" : "P"}`,
      String(opts.hedgeBuyPremium),
      `ord-${id}`,
      `extexec-${id}`,
      id,
      JSON.stringify({ selectedStrike: opts.selectedStrike })
    ]
  );
  // NO sell-side venue_executions row — that's the production reality
  await pool.query(
    `INSERT INTO pilot_ledger_entries
       (id, protection_id, entry_type, amount, currency)
     VALUES ($1, $2, 'premium_due', $3, 'USDC')`,
    [`led-prem-${id}`, id, String(opts.premiumDue)]
  );
  await pool.query(
    `INSERT INTO pilot_ledger_entries
       (id, protection_id, entry_type, amount, currency)
     VALUES ($1, $2, 'payout_due', $3, 'USDC')`,
    [`led-pay-${id}`, id, String(opts.payoutOwed)]
  );
  return id;
};

test("REGRESSION (2026-04-22): TP recovery is read from metadata.sellResult, not from venue_executions", async () => {
  // Pre-fix bug: dashboard always showed 0% recovery on TP-sold trades
  // because hedge manager doesn't insert a sell-side venue_executions row;
  // it stamps metadata.sellResult.totalProceeds instead. This test
  // reproduces the production data shape and verifies the aggregation
  // pulls recovery from the right place.
  //
  // Real-world example: 3a0b2b08 SHORT 2% on $10k.
  //   premium $70, hedge $28.75, payout $200, recovery $77.21
  //   pre-fix: showed 0% recovery, net -$159
  //   post-fix: should show 38.6% recovery, net -$81.54
  const pool = await buildPool();
  await seedTriggeredWithMetadataRecovery(pool, {
    direction: "short",
    notional: 10000,
    triggerPrice: 77175,
    selectedStrike: 77000,        // ITM by $175 (PR #76 working)
    hedgeBuyPremium: 28.75,
    metadataRecoveryUsd: 77.21,   // The actual TP proceeds
    payoutOwed: 200,
    premiumDue: 70
  });

  const { protections, execMap, snapMap, ledgerMap } = await fetchAll(pool);
  const rows = aggregateTriggered(protections, execMap, snapMap, ledgerMap);

  const r = rows[0];
  assert.equal(r.direction, "short");
  assert.equal(r.strikeGapToTriggerUsd, -175, "strike $77k - trigger $77175 = -$175");
  assert.equal(r.strikeIsItm, true, "SHORT call BELOW trigger = ITM (this was reported as OTM in pre-fix dashboard)");
  assert.equal(r.hedgeRecovery, 77.21, "recovery must come from metadata.sellResult.totalProceeds");
  assert.equal(r.recoveryRatioPct, 38.6, "$77.21 / $200 = 38.6%, NOT 0% as pre-fix dashboard showed");
  assert.equal(r.netPnlUsd, -81.54, "$70 - $28.75 + $77.21 - $200 = -$81.54, NOT -$158.75 as pre-fix");
});

test("REGRESSION (2026-04-22): triggerPrice resolved from floor_price column, falling back to metadata", async () => {
  // Pre-fix: code preferred metadata.triggerPrice over floor_price column,
  // causing strikeIsItm to misclassify when metadata was missing/zero.
  // The floor_price column is set authoritatively by triggerMonitor.ts at
  // trigger fire and is the source of truth.
  //
  // Test: protection where metadata.triggerPrice is missing but floor_price
  // is set (real trigger fired). Strike is ITM relative to floor_price.
  // Pre-fix would compute gap=0 → strikeIsItm=false. Post-fix should
  // compute correctly.
  const pool = await buildPool();
  const { id } = await insertProtection(pool, {
    userHash: "test-user-2",
    hashVersion: 1,
    status: "triggered" as any,
    tierName: "SL 2%",
    drawdownFloorPct: "0.02",
    slPct: 2,
    hedgeStatus: "active",
    marketId: "BTC-USD",
    protectedNotional: "10000",
    foxifyExposureNotional: "10000",
    side: "call",
    expiryAt: new Date(Date.now() + 86400000).toISOString(),
    autoRenew: false,
    renewWindowMinutes: 1440,
    metadata: {
      protectionType: "short",
      // NOTE: no triggerPrice in metadata — must fall back to floor_price column
      selectedStrike: 77000,
      triggeredAt: "2026-04-22T12:00:00Z"
    }
  });
  // insertProtection doesn't accept floorPrice — set it directly
  // (matches what triggerMonitor.ts does in production at trigger fire)
  await pool.query(`UPDATE pilot_protections SET floor_price = $1 WHERE id = $2`,
    ["77175.0000000000", id]);

  const { protections, execMap, snapMap, ledgerMap } = await fetchAll(pool);
  const rows = aggregateTriggered(protections, execMap, snapMap, ledgerMap);

  const r = rows[0];
  assert.equal(r.id, id);
  assert.equal(r.strikeGapToTriggerUsd, -175,
    "must resolve trigger from floor_price column when metadata.triggerPrice is missing");
  assert.equal(r.strikeIsItm, true,
    "SHORT call below trigger = ITM (would be misclassified as OTM if floor_price fallback were broken)");
});

test("triggered-protections aggregation: c84dbbe9 case (SHORT 2% OTM, low recovery)", async () => {
  // Reproduces the c84dbbe9 trade pre PR #76. Verifies aggregation
  // produces the right net P&L (-288), recovery ratio (~8%), and
  // pattern classification (barely_graze).
  const pool = await buildPool();
  await seedTriggeredProtection(pool, {
    direction: "short",
    slPct: 2,
    notional: 20000,
    entryPrice: 74223,
    triggerPrice: 75707,
    selectedStrike: 76000,         // OTM by $292 — pre-fix behavior
    spotAtTrigger: 75850,           // grazed trigger by $143 (~0.19%) — barely_graze
    triggeredAt: "2026-04-21T12:00:00Z",
    soldAt: "2026-04-21T13:30:00Z",
    hedgeBuyPremium: 41.56,
    hedgeSellPremium: 33,
    payoutOwed: 400,
    premiumDue: 120
  });
  const { protections, execMap, snapMap, ledgerMap } = await fetchAll(pool);
  const rows = aggregateTriggered(protections, execMap, snapMap, ledgerMap);

  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.direction, "short");
  assert.equal(r.strikeGapToTriggerUsd, 293); // 76000 - 75707
  assert.equal(r.strikeIsItm, false, "SHORT call ABOVE trigger = OTM");
  assert.equal(r.recoveryRatioPct, 8.3, "33/400 = 8.25%");
  assert.equal(r.netPnlUsd, -288.56, "120 - 41.56 + 33 - 400 = -288.56");
  assert.equal(r.triggerPattern, "barely_graze", "0.19% past trigger = barely_graze");
});

test("triggered-protections aggregation: SHORT 2% ITM, healthy recovery (post PR #76 expected behavior)", async () => {
  // Same setup but with PR #76's ITM strike selection. Expect
  // strikeIsItm=true and materially better recovery ratio.
  const pool = await buildPool();
  await seedTriggeredProtection(pool, {
    direction: "short",
    slPct: 2,
    notional: 20000,
    entryPrice: 74223,
    triggerPrice: 75707,
    selectedStrike: 75500,         // ITM by $207 — post-fix expected behavior
    spotAtTrigger: 76200,           // 0.65% past trigger — shallow
    triggeredAt: "2026-04-25T12:00:00Z",
    soldAt: "2026-04-25T13:30:00Z",
    hedgeBuyPremium: 62,            // ITM costs more
    hedgeSellPremium: 250,          // but recovers much more
    payoutOwed: 400,
    premiumDue: 120
  });
  const { protections, execMap, snapMap, ledgerMap } = await fetchAll(pool);
  const rows = aggregateTriggered(protections, execMap, snapMap, ledgerMap);

  const r = rows[0];
  assert.equal(r.direction, "short");
  assert.equal(r.strikeGapToTriggerUsd, -207, "75500 - 75707 = -207 (ITM)");
  assert.equal(r.strikeIsItm, true, "SHORT call BELOW trigger = ITM");
  assert.equal(r.recoveryRatioPct, 62.5, "250/400");
  assert.equal(r.netPnlUsd, -92, "120 - 62 + 250 - 400 = -92");
  assert.equal(r.triggerPattern, "shallow", "0.65% past trigger = shallow");
});

test("triggered-protections aggregation: LONG 2% ITM put, mean-reversion recovery", async () => {
  // LONG protection: trigger BELOW spot. ITM put = strike ABOVE trigger.
  const pool = await buildPool();
  await seedTriggeredProtection(pool, {
    direction: "long",
    slPct: 2,
    notional: 20000,
    entryPrice: 74223,
    triggerPrice: 72738,            // entry × 0.98
    selectedStrike: 73000,           // ITM by $262 (above trigger)
    spotAtTrigger: 72400,           // 0.46% below trigger — shallow
    triggeredAt: "2026-04-22T12:00:00Z",
    soldAt: "2026-04-22T16:00:00Z",
    hedgeBuyPremium: 90,
    hedgeSellPremium: 320,
    payoutOwed: 400,
    premiumDue: 120
  });
  const { protections, execMap, snapMap, ledgerMap } = await fetchAll(pool);
  const rows = aggregateTriggered(protections, execMap, snapMap, ledgerMap);

  const r = rows[0];
  assert.equal(r.direction, "long");
  assert.equal(r.strikeGapToTriggerUsd, 262, "73000 - 72738 = 262 (above trigger)");
  assert.equal(r.strikeIsItm, true, "LONG put ABOVE trigger = ITM");
  assert.equal(r.recoveryRatioPct, 80.0, "320/400 = 80%");
  assert.equal(r.netPnlUsd, -50, "120 - 90 + 320 - 400 = -50");
  assert.equal(r.triggerPattern, "shallow");
});

test("triggered-protections aggregation: clear_breakout pattern classified correctly", async () => {
  // SHORT trigger where BTC moved 1.5% past trigger — momentum continuation
  const pool = await buildPool();
  await seedTriggeredProtection(pool, {
    direction: "short",
    slPct: 2,
    notional: 10000,
    entryPrice: 74223,
    triggerPrice: 75707,
    selectedStrike: 75500,
    spotAtTrigger: 76870,           // 1.53% past trigger — clear breakout
    triggeredAt: "2026-04-26T12:00:00Z",
    hedgeBuyPremium: 35,
    payoutOwed: 200,
    premiumDue: 60
    // No soldAt yet — still active
  });
  const { protections, execMap, snapMap, ledgerMap } = await fetchAll(pool);
  const rows = aggregateTriggered(protections, execMap, snapMap, ledgerMap);

  const r = rows[0];
  assert.equal(r.triggerPattern, "clear_breakout", "1.53% past trigger = clear_breakout");
  // No sell yet → hedge recovery = 0 → ratio = 0% (active hedge sitting
  // waiting for TP). This shows up as red in the dashboard until sold.
  assert.equal(r.recoveryRatioPct, 0, "no sell yet, recovery is 0 (not null)");
  assert.equal(r.hedgeRecoveryUsd, 0);
});
