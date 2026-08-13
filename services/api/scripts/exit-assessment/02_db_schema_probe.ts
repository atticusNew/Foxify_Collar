/**
 * Phase A1.5 — schema probe to discover actual column names in prod.
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

const main = async () => {
  for (const t of [
    "pilot_protections",
    "pilot_venue_executions",
    "pilot_ledger_entries",
    "pilot_admin_actions",
    "pilot_hedge_decisions",
    "pilot_rfq_fills",
    "pilot_sim_positions"
  ]) {
    const r = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = $1 ORDER BY ordinal_position`,
      [t]
    );
    console.log(`\n=== ${t} (${r.rows.length} columns) ===`);
    for (const row of r.rows) {
      console.log(`  ${row.column_name.padEnd(40)} ${row.data_type}`);
    }
  }
  await pool.end();
};

main().catch((e) => { console.error(e); pool.end().catch(() => {}); process.exit(1); });
