/**
 * Pilot exit assessment — Phase A1: read-only DB inventory.
 *
 * Pulls the current state of the live pilot from production Postgres:
 *   - Live protections by status
 *   - Recent triggered protections + payout settlement state
 *   - Capital pool balances
 *   - Recent ledger activity
 *   - Any orphan-suspect rows
 *
 * READ ONLY. No INSERT/UPDATE/DELETE. Connection is read-only by virtue
 * of running SELECTs only; we do NOT issue any DDL or DML.
 *
 * Usage:
 *   PROD_POSTGRES_URL_EXTERNAL=... tsx scripts/exit-assessment/01_db_inventory.ts
 */

import pg from "pg";

const url = process.env.PROD_POSTGRES_URL_EXTERNAL;
if (!url) {
  console.error("PROD_POSTGRES_URL_EXTERNAL not set");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  max: 2,
  // Aggressively short statement timeout — we're doing simple SELECTs only
  statement_timeout: 15_000
});

const log = (label: string, data?: any) => {
  console.log(`\n=== ${label} ===`);
  if (data !== undefined) console.log(JSON.stringify(data, null, 2));
};

const safeQuery = async (label: string, sql: string, params: any[] = []): Promise<any[]> => {
  try {
    const r = await pool.query(sql, params);
    console.log(`\n--- ${label} (${r.rows.length} rows) ---`);
    if (r.rows.length === 0) {
      console.log("  (none)");
    } else {
      for (const row of r.rows) {
        console.log("  " + JSON.stringify(row));
      }
    }
    return r.rows;
  } catch (err) {
    console.error(`\n!!! ${label} FAILED: ${(err as Error).message}`);
    return [];
  }
};

const main = async () => {
  console.log("# Pilot Exit Assessment — Phase A1 DB Inventory");
  console.log(`# Generated: ${new Date().toISOString()}`);

  // 0. Schema sanity
  await safeQuery(
    "Tables present (pilot_*)",
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND (table_name LIKE 'pilot_%' OR table_name LIKE 'volume_cover_%')
     ORDER BY table_name`
  );

  // 1. Protection status counts (overall)
  await safeQuery(
    "Protection counts by status",
    `SELECT status, COUNT(*) as count FROM pilot_protections GROUP BY status ORDER BY count DESC`
  );

  // 2. Active + pending_activation protections (still live)
  const activeRows = await safeQuery(
    "ACTIVE / PENDING_ACTIVATION protections",
    `SELECT id, user_hash, status, tier_name, sl_pct, market_id,
            protected_notional, expiry_at, opened_at, hedge_status,
            auto_renew, metadata
     FROM pilot_protections
     WHERE status IN ('active','pending_activation')
     ORDER BY opened_at DESC NULLS LAST
     LIMIT 50`
  );

  // 3. Triggered but unsettled
  const triggeredRows = await safeQuery(
    "TRIGGERED protections (any settlement state)",
    `SELECT id, user_hash, status, tier_name, sl_pct, market_id,
            protected_notional, triggered_at, payout_settled_at,
            premium_settled_at, closed_at
     FROM pilot_protections
     WHERE status = 'triggered' OR triggered_at IS NOT NULL
     ORDER BY triggered_at DESC NULLS LAST
     LIMIT 50`
  );

  // 4. Recent venue executions (these contain the actual hedge orders)
  await safeQuery(
    "Recent venue executions (last 30 days, last 50)",
    `SELECT id, protection_id, venue, instrument_id, side, quantity,
            premium, executed_at, external_order_id
     FROM pilot_venue_executions
     WHERE executed_at >= NOW() - INTERVAL '30 days'
     ORDER BY executed_at DESC LIMIT 50`
  );

  // 5. Hedge legs that look STILL OPEN (not sold + recent)
  // pilot may not have a 'hedge_status' table; query venue_executions for buys with no matching sell
  await safeQuery(
    "Buy executions with NO matching sell (potentially open hedges) — last 60 days",
    `SELECT b.id, b.protection_id, b.venue, b.instrument_id, b.quantity,
            b.premium, b.executed_at, b.external_order_id
     FROM pilot_venue_executions b
     WHERE b.side = 'buy'
       AND b.executed_at >= NOW() - INTERVAL '60 days'
       AND NOT EXISTS (
         SELECT 1 FROM pilot_venue_executions s
         WHERE s.protection_id = b.protection_id
           AND s.instrument_id = b.instrument_id
           AND s.side = 'sell'
       )
     ORDER BY b.executed_at DESC
     LIMIT 50`
  );

  // 6. Capital pool ledger
  await safeQuery(
    "Capital pool current balances",
    `SELECT pool_id, SUM(amount_usdc) as current_balance_usdc, COUNT(*) as ledger_entries
     FROM pilot_pool_ledger
     WHERE reversed_by_id IS NULL
     GROUP BY pool_id`
  );

  // 7. Recent ledger entries (last 50)
  await safeQuery(
    "Recent ledger entries (last 50)",
    `SELECT id, pool_id, protection_id, entry_type, amount_usdc, created_at, reference
     FROM pilot_pool_ledger
     ORDER BY id DESC LIMIT 50`
  );

  // 8. Settlement runs
  await safeQuery(
    "Settlement runs",
    `SELECT id, pool_id, settlement_type, period_start, period_end, status,
            total_premium_in_usdc, total_payout_out_usdc, net_pnl_usdc, paid_at
     FROM pilot_settlement_runs
     ORDER BY created_at DESC LIMIT 20`
  );

  // 9. Daily activity last 14 days
  await safeQuery(
    "Daily activations + executions last 14 days",
    `SELECT DATE_TRUNC('day', opened_at) as day,
            COUNT(*) as protections_opened,
            SUM(protected_notional) as notional_opened
     FROM pilot_protections
     WHERE opened_at >= NOW() - INTERVAL '14 days'
     GROUP BY day ORDER BY day DESC`
  );

  // 10. Audit / admin actions log
  await safeQuery(
    "Recent admin actions (last 20)",
    `SELECT id, action_type, target, actor, created_at, details
     FROM pilot_admin_actions
     ORDER BY id DESC LIMIT 20`
  );

  // 11. Volume Cover state (the new product — should be empty since not enabled yet)
  await safeQuery(
    "Volume Cover positions (should be empty if VOLUME_COVER_ENABLED=false)",
    `SELECT status, COUNT(*) FROM volume_cover_position GROUP BY status`
  );

  log("DB INVENTORY COMPLETE");

  await pool.end();
};

main().catch((err) => {
  console.error("Inventory failed:", err);
  pool.end().catch(() => {});
  process.exit(1);
});
