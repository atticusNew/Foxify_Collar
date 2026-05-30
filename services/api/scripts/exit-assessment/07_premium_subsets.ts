/**
 * Phase B+ — Discover the premium-tier subsets the user mentioned.
 *
 * User said pilot ran across at least 3 premium tiers ($25, $65, $70).
 * Probe the actual distribution of premiums in the DB to identify
 * subsets cleanly.
 *
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
  console.log("# Premium subset discovery\n");

  // Round protected_notional / 1k to find premium per $1k bucket
  const r = await pool.query(
    `SELECT
       sl_pct,
       protected_notional,
       premium,
       ROUND(premium / (protected_notional / 1000)) as premium_per_1k_usdc,
       COUNT(*) as count
     FROM pilot_protections
     WHERE status NOT IN ('activation_failed','cancelled')
       AND premium IS NOT NULL
       AND protected_notional > 0
     GROUP BY sl_pct, protected_notional, premium
     ORDER BY premium_per_1k_usdc, sl_pct`
  );

  console.log("All distinct (sl_pct, notional, premium) combinations:");
  for (const row of r.rows) {
    console.log(
      `  sl=${row.sl_pct}% | notional=$${row.protected_notional} | premium=$${row.premium} | per $1k=$${row.premium_per_1k_usdc} | count=${row.count}`
    );
  }

  // Distribution by premium per $1k notional
  const byBucket = await pool.query(
    `SELECT
       ROUND(premium / (protected_notional / 1000)) as premium_per_1k_usdc,
       COUNT(*) as protections,
       SUM(premium) as total_premium_collected,
       SUM(protected_notional) as total_notional,
       MIN(created_at) as first,
       MAX(created_at) as last
     FROM pilot_protections
     WHERE status NOT IN ('activation_failed','cancelled')
       AND premium IS NOT NULL
       AND protected_notional > 0
     GROUP BY premium_per_1k_usdc
     ORDER BY premium_per_1k_usdc`
  );

  console.log("\nDistribution by premium per $1k notional:");
  for (const row of byBucket.rows) {
    console.log(
      `  $${row.premium_per_1k_usdc}/$1k: ${row.protections} protections, ` +
      `$${row.total_premium_collected} total premium, ` +
      `$${row.total_notional} total notional, ` +
      `period: ${row.first} → ${row.last}`
    );
  }

  // Group by date to see when pricing tiers transitioned
  console.log("\nDaily premium-per-$1k distribution (last 30 days):");
  const daily = await pool.query(
    `SELECT
       DATE_TRUNC('day', created_at) as day,
       ROUND(AVG(premium / (protected_notional / 1000))) as avg_per_1k,
       MIN(ROUND(premium / (protected_notional / 1000))) as min_per_1k,
       MAX(ROUND(premium / (protected_notional / 1000))) as max_per_1k,
       COUNT(*) as count,
       SUM(premium) as premium_total
     FROM pilot_protections
     WHERE status NOT IN ('activation_failed','cancelled')
       AND premium IS NOT NULL
       AND protected_notional > 0
       AND created_at >= NOW() - INTERVAL '30 days'
     GROUP BY day
     ORDER BY day`
  );
  for (const row of daily.rows) {
    console.log(
      `  ${(row.day as Date).toISOString().slice(0, 10)}: ` +
      `count=${row.count} avg=$${row.avg_per_1k}/$1k (range $${row.min_per_1k}-$${row.max_per_1k}) total=$${row.premium_total}`
    );
  }

  await pool.end();
};

main().catch(e => { console.error(e); pool.end().catch(() => {}); process.exit(1); });
