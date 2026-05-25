/**
 * Phase A3 — cross-reference Deribit open positions vs DB protections + ledger.
 *
 * Confirms: are these orphans (protection closed, hedge left open)?
 * Builds the unwind decision table.
 *
 * READ ONLY.
 */

import pg from "pg";

const url = process.env.PROD_POSTGRES_URL_EXTERNAL;
if (!url) { console.error("PROD_POSTGRES_URL_EXTERNAL not set"); process.exit(1); }

const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  max: 2,
  statement_timeout: 15_000
});

const ORPHAN_HEDGES = [
  { instrument: "BTC-22MAY26-78000-P", protectionId: "763d4750-4d93-4a4b-9fff-62913cb20d6c" },
  { instrument: "BTC-22MAY26-83000-C", protectionId: "dfb0810a-dcf7-4f01-acb2-6944b8c66d6d" },
  { instrument: "BTC-22MAY26-84000-C", protectionId: "0cb9375b-5937-4a71-948e-a67741bdcf9b" }
];

const main = async () => {
  console.log("# Phase A3 — Cross-reference DB vs Deribit positions\n");

  for (const { instrument, protectionId } of ORPHAN_HEDGES) {
    console.log(`\n=== ${instrument} (protection ${protectionId}) ===`);

    // Protection state in DB
    const p = await pool.query(
      `SELECT id, status, side, sl_pct, tier_name,
              protected_notional, expiry_at, created_at, closed_at, closed_by,
              hedge_status, hedge_retained_for_platform,
              instrument_id, premium, payout_due_amount, payout_settled_at,
              expiry_price, metadata->>'closeReason' as close_reason
       FROM pilot_protections WHERE id = $1`,
      [protectionId]
    );
    if (p.rows.length === 0) {
      console.log("  (no protection row found — pure orphan?)");
    } else {
      const r = p.rows[0];
      console.log("  Protection:");
      console.log(`    status:          ${r.status}`);
      console.log(`    side:            ${r.side}`);
      console.log(`    sl_pct:          ${r.sl_pct}`);
      console.log(`    tier:            ${r.tier_name}`);
      console.log(`    notional:        $${r.protected_notional}`);
      console.log(`    created_at:      ${r.created_at}`);
      console.log(`    expiry_at:       ${r.expiry_at}`);
      console.log(`    closed_at:       ${r.closed_at ?? "(not closed in DB)"}`);
      console.log(`    closed_by:       ${r.closed_by ?? "(n/a)"}`);
      console.log(`    close_reason:    ${r.close_reason ?? "(n/a)"}`);
      console.log(`    hedge_status:    ${r.hedge_status}`);
      console.log(`    hedge_retained:  ${r.hedge_retained_for_platform}`);
      console.log(`    primary instr:   ${r.instrument_id}`);
      console.log(`    premium paid:    $${r.premium}`);
      console.log(`    payout_due:      $${r.payout_due_amount ?? "n/a"}`);
      console.log(`    payout_settled:  ${r.payout_settled_at ?? "(n/a)"}`);
      console.log(`    expiry_price:    $${r.expiry_price ?? "n/a"}`);
    }

    // Venue executions for this protection (all sides)
    const v = await pool.query(
      `SELECT id, instrument_id, side, quantity, premium, status, executed_at
       FROM pilot_venue_executions WHERE protection_id = $1 ORDER BY executed_at`,
      [protectionId]
    );
    console.log(`  Venue executions (${v.rows.length}):`);
    for (const e of v.rows) {
      console.log(
        `    [${e.side}] ${e.instrument_id} qty=${e.quantity} premium=${e.premium} status=${e.status} at=${e.executed_at}`
      );
    }

    // Ledger entries
    const l = await pool.query(
      `SELECT id, entry_type, amount, currency, reference, created_at, settled_at
       FROM pilot_ledger_entries WHERE protection_id = $1 ORDER BY created_at`,
      [protectionId]
    );
    console.log(`  Ledger entries (${l.rows.length}):`);
    for (const e of l.rows) {
      console.log(
        `    ${e.entry_type}: ${e.amount} ${e.currency} ref=${e.reference} created=${e.created_at} settled=${e.settled_at ?? "(unsettled)"}`
      );
    }
  }

  // Also: any protection with hedge_retained_for_platform = true OR hedge_status != 'sold'
  console.log("\n\n=== Other protections with retained-or-active hedge status ===");
  const orphansSql = await pool.query(
    `SELECT id, status, instrument_id, hedge_status, hedge_retained_for_platform,
            premium, expiry_at, closed_at
     FROM pilot_protections
     WHERE (hedge_retained_for_platform = true OR hedge_status NOT IN ('sold','expired_otm','none','closed'))
       AND created_at >= NOW() - INTERVAL '60 days'
     ORDER BY created_at DESC`
  );
  console.log(`Found ${orphansSql.rows.length} other rows:`);
  for (const r of orphansSql.rows) {
    console.log(
      `  ${r.id} | status=${r.status} | hedge_status=${r.hedge_status} | retained=${r.hedge_retained_for_platform} | instrument=${r.instrument_id} | expiry=${r.expiry_at}`
    );
  }

  // Pilot economic rollup (life-of-pilot)
  console.log("\n\n=== Pilot life-to-date rollup ===");
  const rollup = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status NOT IN ('activation_failed','cancelled')) as protections_sold,
       SUM(premium) FILTER (WHERE status NOT IN ('activation_failed','cancelled')) as total_premium_collected,
       SUM(payout_settled_amount) FILTER (WHERE payout_settled_amount IS NOT NULL) as total_payouts_settled,
       SUM(payout_due_amount) FILTER (WHERE payout_due_amount IS NOT NULL AND payout_settled_amount IS NULL) as payouts_owed_unsettled,
       MIN(created_at) FILTER (WHERE status NOT IN ('activation_failed','cancelled')) as first_protection,
       MAX(created_at) FILTER (WHERE status NOT IN ('activation_failed','cancelled')) as last_protection
     FROM pilot_protections`
  );
  console.log(JSON.stringify(rollup.rows[0], null, 2));

  const hedgeSpend = await pool.query(
    `SELECT
       venue,
       SUM(premium) FILTER (WHERE side='buy') as total_buys_premium_btc,
       SUM(premium) FILTER (WHERE side='sell') as total_sells_premium_btc,
       COUNT(*) FILTER (WHERE side='buy') as buy_count,
       COUNT(*) FILTER (WHERE side='sell') as sell_count
     FROM pilot_venue_executions
     GROUP BY venue`
  );
  console.log("\nVenue execution rollup:");
  for (const r of hedgeSpend.rows) {
    console.log(`  ${r.venue}: ${r.buy_count} buys / ${r.sell_count} sells | BUY total=${r.total_buys_premium_btc} | SELL total=${r.total_sells_premium_btc}`);
  }

  await pool.end();
};

main().catch((e) => { console.error(e); pool.end().catch(() => {}); process.exit(1); });
