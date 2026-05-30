import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.POSTGRES_URL!, ssl: { rejectUnauthorized: false } });
const main = async () => {
  console.log("=== two_sided_pair state ===");
  const status = await pool.query(`SELECT status, is_shadow, COUNT(*)::int as n FROM two_sided_pair GROUP BY status, is_shadow ORDER BY status, is_shadow`);
  console.table(status.rows);
  console.log("=== Last 10 pairs (most recent) ===");
  const recent = await pool.query(`
    SELECT pair_id, cell_id, status, is_shadow, created_at, triggered_at, closed_at, closed_reason,
           hedge_cost_total_usdc, salvage_proceeds_usdc, uplift_usdc, foxify_share_usdc, atticus_share_usdc
    FROM two_sided_pair ORDER BY created_at DESC LIMIT 10`);
  console.table(recent.rows);
  console.log("=== Tier counts (volume tier basis) — last 24h ===");
  const tier = await pool.query(`SELECT cell_id, COUNT(*)::int as count_24h FROM two_sided_pair WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY cell_id`);
  console.table(tier.rows);
  console.log("=== Total pairs in DB ===");
  const total = await pool.query(`SELECT COUNT(*)::int as total, COUNT(*) FILTER (WHERE is_shadow = true)::int as shadow, COUNT(*) FILTER (WHERE is_shadow = false)::int as live FROM two_sided_pair`);
  console.table(total.rows);
  await pool.end();
};
main().catch((e) => { console.error(e.message); process.exit(1); });
