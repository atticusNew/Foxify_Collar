import { Pool } from "pg";
const dbUrl = process.env.POSTGRES_URL!;
const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
const main = async () => {
  const tables = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
  console.log(`Tables (${tables.rows.length}):`);
  for (const t of tables.rows) console.log("  " + t.table_name);
  // Sample row counts for any interesting tables
  for (const t of tables.rows) {
    try {
      const c = await pool.query(`SELECT COUNT(*) FROM "${t.table_name}"`);
      console.log(`    ${t.table_name}: ${c.rows[0].count} rows`);
    } catch (e) { /* ignore */ }
  }
  await pool.end();
};
main().catch(e => { console.error(e.message); process.exit(1); });
