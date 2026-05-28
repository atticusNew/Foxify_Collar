import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.POSTGRES_URL!, ssl: { rejectUnauthorized: false } });
const main = async () => {
  // Get schemas
  for (const tbl of ["volume_cover_position", "volume_cover_hedge_leg", "pilot_venue_executions", "pilot_protections", "volume_cover_cell"]) {
    const c = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`, [tbl]);
    console.log(`\n=== ${tbl} (${c.rows.length} cols) ===`);
    console.log(c.rows.map(r => `  ${r.column_name} :: ${r.data_type}`).join("\n"));
  }
  await pool.end();
};
main().catch(e => { console.error(e.message); process.exit(1); });
