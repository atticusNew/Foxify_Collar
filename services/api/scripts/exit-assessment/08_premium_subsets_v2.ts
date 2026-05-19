/**
 * Phase B+ — Premium subset discovery v2 using daily_rate_usd_per_1k.
 *
 * Atticus pilot is biweekly: total premium = daily_rate × notional/1k × tenor_days.
 * The user's $25/$65/$70 references are likely DAILY rates per $10k notional:
 *   $25/$10k = $2.50/$1k/day (deployed baseline / breakeven)
 *   $65/$10k = $6.50/$1k/day (P1 / Design A)
 *   $70/$10k = $7/$1k/day  (roughly P2)
 *
 * This script groups by daily_rate_usd_per_1k and computes per-tier rollups.
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
  console.log("# Premium subset discovery v2 — by daily_rate_usd_per_1k\n");

  // 1. Distinct daily rates
  const rates = await pool.query(
    `SELECT
       daily_rate_usd_per_1k,
       sl_pct,
       COUNT(*) as count
     FROM pilot_protections
     WHERE status NOT IN ('activation_failed','cancelled')
       AND daily_rate_usd_per_1k IS NOT NULL
     GROUP BY daily_rate_usd_per_1k, sl_pct
     ORDER BY daily_rate_usd_per_1k, sl_pct`
  );
  console.log("Distinct (daily_rate_usd_per_1k, sl_pct) combinations:");
  for (const r of rates.rows) {
    console.log(`  $${r.daily_rate_usd_per_1k}/$1k/day | sl=${r.sl_pct}% | count=${r.count}`);
  }

  // 2. Daily rate distribution by date
  const daily = await pool.query(
    `SELECT
       DATE_TRUNC('day', created_at) as day,
       daily_rate_usd_per_1k,
       COUNT(*) as count
     FROM pilot_protections
     WHERE status NOT IN ('activation_failed','cancelled')
       AND daily_rate_usd_per_1k IS NOT NULL
     GROUP BY day, daily_rate_usd_per_1k
     ORDER BY day, daily_rate_usd_per_1k`
  );
  console.log("\nDaily rate by date:");
  for (const r of daily.rows) {
    console.log(`  ${(r.day as Date).toISOString().slice(0, 10)} | $${r.daily_rate_usd_per_1k}/$1k/day | count=${r.count}`);
  }

  // 3. Some protections may not have daily_rate_usd_per_1k set — use accumulated_charge_usd / tenor_days / notional
  const fallback = await pool.query(
    `SELECT
       id, sl_pct, premium, daily_rate_usd_per_1k,
       protected_notional, tenor_days, accumulated_charge_usd, days_billed,
       created_at
     FROM pilot_protections
     WHERE status NOT IN ('activation_failed','cancelled')
       AND (daily_rate_usd_per_1k IS NULL OR daily_rate_usd_per_1k = 0)
     LIMIT 20`
  );
  console.log(`\nProtections with NULL/0 daily_rate (${fallback.rows.length} sampled):`);
  for (const r of fallback.rows) {
    console.log(
      `  ${r.id.slice(0,8)} | sl=${r.sl_pct} | premium=$${r.premium} | notional=$${r.protected_notional} | tenor=${r.tenor_days}d | accumulated=$${r.accumulated_charge_usd} | days_billed=${r.days_billed}`
    );
  }

  await pool.end();
};

main().catch(e => { console.error(e); pool.end().catch(()=>{}); process.exit(1); });
