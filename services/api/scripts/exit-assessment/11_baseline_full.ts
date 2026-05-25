/**
 * Identify ALL protections at the $25/$10k/day baseline pricing
 * regardless of how daily_rate_usd_per_1k was populated.
 *
 * Match criterion: premium / notional / tenor_days ≈ $2.50/$1k/day
 * (i.e., 0.0025 of notional per day). Tolerance ±10%.
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
  console.log("# Phase B+ — Full $25/$10k/day baseline regime audit\n");

  // Fetch all protections with enough data to compute effective daily rate
  const rows = await pool.query(
    `SELECT
       id,
       status,
       sl_pct,
       protected_notional,
       premium,
       daily_rate_usd_per_1k,
       tenor_days,
       payout_due_amount,
       payout_settled_amount,
       payout_settled_at,
       created_at,
       closed_at,
       hedge_status,
       instrument_id,
       venue
     FROM pilot_protections
     WHERE status NOT IN ('activation_failed','cancelled') OR closed_at IS NOT NULL
     ORDER BY created_at`
  );

  // Compute effective daily rate per $1k for each protection.
  // For biweekly: daily_rate stored OR premium / notional / tenor.
  // For 1-day: premium / notional × 1k = per $1k for one day.
  type Annotated = any & { effectiveDailyRatePer1k: number | null };
  const annotated: Annotated[] = rows.rows.map((r: any) => {
    const premium = Number(r.premium);
    const notional = Number(r.protected_notional);
    const tenor = Number(r.tenor_days) || 1;
    const dailyRateField = r.daily_rate_usd_per_1k ? Number(r.daily_rate_usd_per_1k) : null;
    let effective: number | null = null;
    if (dailyRateField !== null && dailyRateField > 0) {
      effective = dailyRateField;
    } else if (notional > 0 && tenor > 0) {
      effective = (premium / (notional / 1000)) / tenor;
    }
    return { ...r, effectiveDailyRatePer1k: effective };
  });

  // Find baseline: $2.50/$1k/day ± 10%
  const targetRate = 2.5;
  const tolerance = 0.25;
  const baselineProtections = annotated.filter(r => {
    if (r.effectiveDailyRatePer1k === null) return false;
    return Math.abs(r.effectiveDailyRatePer1k - targetRate) <= tolerance;
  });

  console.log(`### Found ${baselineProtections.length} protections at \$2.50/\$1k/day baseline (\$25/\$10k/day)\n`);
  for (const p of baselineProtections) {
    const tenorDays = Number(p.tenor_days) || 14;
    const dailyDollarsPer10k = (p.effectiveDailyRatePer1k * 10).toFixed(2);
    console.log(
      `  ${p.id.slice(0,8)} | sl=${p.sl_pct}% | notional=$${p.protected_notional} | tenor=${tenorDays}d | ` +
      `premium=$${p.premium} | daily=$${dailyDollarsPer10k}/$10k/day | ` +
      `status=${p.status} | hedge=${p.hedge_status} | instr=${p.instrument_id ?? "(null)"} | created=${p.created_at}`
    );
  }

  // Aggregate stats for this regime
  const totalPremium = baselineProtections.reduce((s, p) => s + Number(p.premium), 0);
  const totalNotional = baselineProtections.reduce((s, p) => s + Number(p.protected_notional), 0);
  const triggered = baselineProtections.filter(p => p.status === "triggered");
  const expiredOtm = baselineProtections.filter(p => p.status === "expired_otm");
  const cancelled = baselineProtections.filter(p => p.status === "cancelled" || p.closed_at);
  const totalPayoutOwed = baselineProtections.reduce(
    (s, p) => s + (Number(p.payout_due_amount) || 0), 0
  );
  const totalPayoutSettled = baselineProtections.reduce(
    (s, p) => s + (Number(p.payout_settled_amount) || 0), 0
  );

  console.log(`\n### Regime aggregates`);
  console.log(`  Total notional:           $${totalNotional}`);
  console.log(`  Total premium collected:  $${totalPremium}`);
  console.log(`  Triggered count:          ${triggered.length}`);
  console.log(`  Expired OTM count:        ${expiredOtm.length}`);
  console.log(`  Cancelled (incl closed):  ${cancelled.length}`);
  console.log(`  Total payout owed:        $${totalPayoutOwed}`);
  console.log(`  Total payout settled:     $${totalPayoutSettled}`);

  // Hedge buys for these protections
  const ids = baselineProtections.map((p: any) => p.id);
  const exec = await pool.query(
    `SELECT protection_id, instrument_id, side, quantity, premium, executed_at
     FROM pilot_venue_executions WHERE protection_id = ANY($1)`,
    [ids]
  );
  console.log(`\n### Hedge executions for these ${baselineProtections.length} protections (${exec.rows.length} rows)`);
  let totalHedgeBuy = 0;
  for (const e of exec.rows) {
    if (e.side === "buy") totalHedgeBuy += Number(e.premium);
    console.log(
      `  ${e.protection_id.slice(0,8)} | ${e.instrument_id} | ${e.side} qty=${e.quantity} premium=$${e.premium} at=${e.executed_at}`
    );
  }
  console.log(`\n  Total hedge BUY spend: $${totalHedgeBuy.toFixed(2)}`);

  // Map orphan unwinds back to baseline protections
  const orphanUnwinds: Record<string, { proceedsBtcUsdc: number; instrument: string }> = {
    "763d4750-4d93-4a4b-9fff-62913cb20d6c": { proceedsBtcUsdc: 174.61, instrument: "BTC-22MAY26-78000-P" },
    "dfb0810a-dcf7-4f01-acb2-6944b8c66d6d": { proceedsBtcUsdc: 23.81, instrument: "BTC-22MAY26-83000-C" },
    "0cb9375b-5937-4a71-948e-a67741bdcf9b": { proceedsBtcUsdc: 26.99, instrument: "BTC-22MAY26-84000-C" }
  };
  let totalUnwindProceeds = 0;
  console.log(`\n### Orphan unwinds attributable to this regime`);
  for (const p of baselineProtections) {
    const u = orphanUnwinds[p.id];
    if (u) {
      totalUnwindProceeds += u.proceedsBtcUsdc;
      console.log(`  ${p.id.slice(0,8)} ${u.instrument} → recovered $${u.proceedsBtcUsdc.toFixed(2)}`);
    }
  }
  console.log(`  Total unwind recovery for regime: $${totalUnwindProceeds.toFixed(2)}`);

  // Final P&L for this regime
  const grossPnL = totalPremium - totalHedgeBuy + totalUnwindProceeds - totalPayoutOwed;
  console.log(`\n### Regime gross P&L`);
  console.log(`  Premium collected:        +$${totalPremium.toFixed(2)}`);
  console.log(`  Hedge buy spend:          -$${totalHedgeBuy.toFixed(2)}`);
  console.log(`  Orphan unwind recovery:   +$${totalUnwindProceeds.toFixed(2)}`);
  console.log(`  Payout owed (liability):  -$${totalPayoutOwed.toFixed(2)}`);
  console.log(`  ----`);
  console.log(`  NET REGIME P&L:           $${grossPnL.toFixed(2)}`);

  // Note: still missing the salvage from the 4 triggered protections
  // (their hedges were sold on Deribit but proceeds not recorded in DB).
  // Estimate at 50% of buy cost:
  const triggeredBuySpend = exec.rows
    .filter(e => triggered.some((t: any) => t.id === e.protection_id) && e.side === "buy")
    .reduce((s: number, e: any) => s + Number(e.premium), 0);
  const estTriggeredSalvage = triggeredBuySpend * 0.5;
  console.log(`\n### Adjustment estimate for triggered-protection hedge salvage`);
  console.log(`  Triggered hedge buy spend: $${triggeredBuySpend.toFixed(2)}`);
  console.log(`  Estimated salvage @ 50%:   +$${estTriggeredSalvage.toFixed(2)}`);
  console.log(`  Adjusted NET P&L:          $${(grossPnL + estTriggeredSalvage).toFixed(2)}`);

  await pool.end();
};

main().catch(e => { console.error(e); pool.end().catch(()=>{}); process.exit(1); });
