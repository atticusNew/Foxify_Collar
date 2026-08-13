/**
 * Check if hedge sells went to pilot_rfq_fills instead of pilot_venue_executions.
 * READ ONLY.
 */

import pg from "pg";
const url = process.env.PROD_POSTGRES_URL_EXTERNAL!;
const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  max: 2,
  statement_timeout: 15_000
});

const main = async () => {
  // Distinct sides + counts
  const sides = await pool.query(
    `SELECT side, COUNT(*) as count, SUM(premium) as total_premium
     FROM pilot_rfq_fills
     GROUP BY side`
  );
  console.log("pilot_rfq_fills by side:");
  for (const r of sides.rows) {
    console.log(`  ${r.side}: ${r.count} fills, $${r.total_premium} total premium`);
  }

  // Recent rfq fills sample
  const recent = await pool.query(
    `SELECT id, venue, instrument_id, side, quantity, fill_price, premium, status, fill_ts
     FROM pilot_rfq_fills ORDER BY fill_ts DESC LIMIT 30`
  );
  console.log(`\nRecent rfq fills (${recent.rows.length}):`);
  for (const r of recent.rows) {
    console.log(`  ${r.fill_ts} | ${r.venue} ${r.instrument_id} ${r.side} qty=${r.quantity} @ ${r.fill_price} = $${r.premium} | ${r.status}`);
  }

  // Total sell-side rfq value, grouped by date
  const byDate = await pool.query(
    `SELECT DATE_TRUNC('day', fill_ts) as day, side, COUNT(*) as count, SUM(premium) as total
     FROM pilot_rfq_fills
     WHERE side = 'sell'
     GROUP BY day, side
     ORDER BY day DESC LIMIT 30`
  );
  console.log("\nDaily sell-side rfq fills:");
  for (const r of byDate.rows) {
    console.log(`  ${(r.day as Date).toISOString().slice(0,10)} | sells=${r.count} | total=$${r.total}`);
  }

  // Look for protection_id linkage in metadata
  const linked = await pool.query(
    `SELECT id, instrument_id, side, premium, metadata->>'protectionId' as protection_id, metadata->>'protection_id' as p2
     FROM pilot_rfq_fills
     WHERE side = 'sell'
     ORDER BY fill_ts DESC LIMIT 20`
  );
  console.log("\nSell rfq fills with metadata.protectionId:");
  for (const r of linked.rows) {
    console.log(`  ${r.id.slice(0,8)} | ${r.instrument_id} | $${r.premium} | protectionId=${r.protection_id ?? r.p2}`);
  }

  await pool.end();
};

main().catch(e => { console.error(e); pool.end().catch(()=>{}); process.exit(1); });
