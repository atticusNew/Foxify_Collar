/**
 * Phase B (final) — Full reconciliation report.
 *
 * Combines DB data with the complete Deribit trade history to produce
 * actual realized P&L, segmented by pricing regime (the user's
 * $25 / $65 / $70 framing).
 *
 * Pricing regimes identified from data:
 *   Regime A (Apr 16 - Apr 20): $50-60 flat premium / $10k 2% (1-day tenor)
 *   Regime B (Apr 21 - Apr 30): $65-70 flat premium / $10k 2% (1-day tenor)
 *   Regime C (May 1 - May 14):  $25/$10k/day biweekly ($350 = $25 × 14)
 *
 * Output:
 *   - Per-regime: protections, premium collected, hedge spend (Deribit
 *     buys), hedge proceeds (Deribit sells), payouts owed/settled,
 *     net P&L
 *   - Aggregate pilot-level reconciliation
 *   - Reconciled vs DB-tracked balances
 *
 * READ ONLY.
 */

import pg from "pg";

const url = process.env.PROD_POSTGRES_URL_EXTERNAL!;
const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  max: 2,
  statement_timeout: 30_000
});

const CLIENT_ID = process.env.DERIBIT_CLIENT_ID!;
const CLIENT_SECRET = process.env.DERIBIT_CLIENT_SECRET!;
const BASE_URL = "https://www.deribit.com/api/v2";

const auth = async (): Promise<string> => {
  const r = await fetch(
    `${BASE_URL}/public/auth?grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`
  );
  return (await r.json() as any).result.access_token;
};

const fetchAllDeribitTrades = async (token: string, sinceTimestampMs: number): Promise<any[]> => {
  const all: any[] = [];
  // Use time-based pagination via get_user_trades_by_currency_and_time
  // Walk forward from sinceTimestampMs in 7-day windows.
  const nowMs = Date.now();
  let cursor = sinceTimestampMs;
  const windowMs = 7 * 86_400_000;
  for (let page = 0; page < 30 && cursor < nowMs; page++) {
    const endMs = Math.min(cursor + windowMs, nowMs);
    const params = new URLSearchParams({
      currency: "BTC",
      kind: "option",
      start_timestamp: String(cursor),
      end_timestamp: String(endMs),
      count: "1000",
      sorting: "asc",
      include_old: "true"
    });
    const r = await fetch(`${BASE_URL}/private/get_user_trades_by_currency_and_time?${params}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const json = await r.json() as any;
    const trades = json.result?.trades ?? [];
    all.push(...trades);
    cursor = endMs + 1;
  }
  return all;
};

const main = async () => {
  console.log("# Pilot Final Reconciliation Report");
  console.log(`# Generated: ${new Date().toISOString()}\n`);

  // 1. Pull Deribit trade history (life of pilot ~ since 2026-04-15)
  const sinceMs = new Date("2026-04-15T00:00:00Z").getTime();
  const token = await auth();
  console.log("Fetching Deribit trade history...");
  const allTrades = await fetchAllDeribitTrades(token, sinceMs);
  console.log(`  Pulled ${allTrades.length} trades since 2026-04-15`);

  const buys = allTrades.filter(t => t.direction === "buy");
  const sells = allTrades.filter(t => t.direction === "sell");
  const buyTotalBtc = buys.reduce((s, t) => s + Number(t.amount) * Number(t.price), 0);
  const sellTotalBtc = sells.reduce((s, t) => s + Number(t.amount) * Number(t.price), 0);
  const buyFeesBtc = buys.reduce((s, t) => s + Number(t.fee ?? 0), 0);
  const sellFeesBtc = sells.reduce((s, t) => s + Number(t.fee ?? 0), 0);

  // Need a representative BTC price for USD conversion. Use trade-time price.
  // For simplicity report in BTC and convert at average BTC reference price ($80k).
  const avgBtcPrice = 80_000; // rough average over pilot period
  console.log(`\nDeribit summary:`);
  console.log(`  Buys: ${buys.length} trades, total ${buyTotalBtc.toFixed(6)} BTC ≈ $${(buyTotalBtc * avgBtcPrice).toFixed(2)}`);
  console.log(`  Sells: ${sells.length} trades, total ${sellTotalBtc.toFixed(6)} BTC ≈ $${(sellTotalBtc * avgBtcPrice).toFixed(2)}`);
  console.log(`  Buy fees: ${buyFeesBtc.toFixed(6)} BTC ≈ $${(buyFeesBtc * avgBtcPrice).toFixed(2)}`);
  console.log(`  Sell fees: ${sellFeesBtc.toFixed(6)} BTC ≈ $${(sellFeesBtc * avgBtcPrice).toFixed(2)}`);
  console.log(`  Net hedge cost (buys - sells + fees): $${((buyTotalBtc - sellTotalBtc + buyFeesBtc + sellFeesBtc) * avgBtcPrice).toFixed(2)}`);

  // 2. Pull all protections with classification
  const protections = await pool.query(
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
     WHERE status NOT IN ('activation_failed','cancelled')
     ORDER BY created_at`
  );

  // Classify each protection by regime
  const classify = (p: any): "A_50_60" | "B_65_70" | "C_25_biweekly" | "other" => {
    const created = new Date(p.created_at);
    const dailyRate = p.daily_rate_usd_per_1k ? Number(p.daily_rate_usd_per_1k) : null;
    const premium = Number(p.premium);
    const notional = Number(p.protected_notional);
    const perTenK = (premium / notional) * 10_000;

    if (dailyRate !== null && dailyRate > 0) {
      // Biweekly with daily rate
      if (Math.abs(dailyRate - 2.5) < 0.5) return "C_25_biweekly";
    }
    // 1-day product, classify by per-$10k premium
    if (perTenK <= 60) return "A_50_60";
    if (perTenK <= 70) return "B_65_70";
    return "other";
  };

  // 3. Compute per-regime stats
  const regimes: Record<string, any> = {
    A_50_60: { name: "Regime A: $50-60/$10k flat (1-day, Apr 16-20)", protections: [] },
    B_65_70: { name: "Regime B: $65-70/$10k flat (1-day, Apr 21+)", protections: [] },
    C_25_biweekly: { name: "Regime C: $25/$10k/day biweekly ($350 total, May 1+) — BASELINE", protections: [] },
    other: { name: "Other", protections: [] }
  };

  for (const p of protections.rows) {
    regimes[classify(p)].protections.push(p);
  }

  // For each regime, also pull venue executions for those protection IDs
  // and compute realized P&L
  for (const [key, regime] of Object.entries(regimes)) {
    if (regime.protections.length === 0) continue;
    const ids = regime.protections.map((p: any) => p.id);
    const exec = await pool.query(
      `SELECT protection_id, instrument_id, side, quantity, premium, executed_at, status
       FROM pilot_venue_executions
       WHERE protection_id = ANY($1)`,
      [ids]
    );
    regime.executions = exec.rows;
    regime.totalPremiumCollected = regime.protections.reduce((s: number, p: any) => s + Number(p.premium), 0);
    regime.totalNotional = regime.protections.reduce((s: number, p: any) => s + Number(p.protected_notional), 0);
    regime.totalHedgeBuysUsdc = exec.rows
      .filter(r => r.side === "buy")
      .reduce((s: number, r: any) => s + Number(r.premium), 0);
    regime.totalHedgeSellsUsdc = exec.rows
      .filter(r => r.side === "sell")
      .reduce((s: number, r: any) => s + Number(r.premium), 0);
    regime.protectionCount = regime.protections.length;
    regime.triggeredCount = regime.protections.filter((p: any) => p.status === "triggered").length;
    regime.expiredOtmCount = regime.protections.filter((p: any) => p.status === "expired_otm").length;
    regime.totalPayoutOwed = regime.protections.reduce(
      (s: number, p: any) => s + (Number(p.payout_due_amount) || 0),
      0
    );
    regime.totalPayoutSettled = regime.protections.reduce(
      (s: number, p: any) => s + (Number(p.payout_settled_amount) || 0),
      0
    );
    regime.firstTrade = regime.protections[0]?.created_at;
    regime.lastTrade = regime.protections[regime.protections.length - 1]?.created_at;
  }

  // 4. Reconcile Deribit sells (which protection do they belong to?)
  // We don't have a clean mapping in DB; do a best-effort via instrument_id.
  // For each sell trade, find the matching buy trade(s) by instrument_id,
  // then look up the protection_id for those buys in pilot_venue_executions.
  const buyByInstrument: Record<string, any[]> = {};
  for (const b of buys) {
    if (!buyByInstrument[b.instrument_name]) buyByInstrument[b.instrument_name] = [];
    buyByInstrument[b.instrument_name].push(b);
  }
  const sellsByInstrument: Record<string, any[]> = {};
  for (const s of sells) {
    if (!sellsByInstrument[s.instrument_name]) sellsByInstrument[s.instrument_name] = [];
    sellsByInstrument[s.instrument_name].push(s);
  }

  // Assign sell-side proceeds to protections via instrument_id matching
  const protectionByInstrument = await pool.query(
    `SELECT instrument_id, id as protection_id, status, premium
     FROM pilot_protections
     WHERE instrument_id IS NOT NULL`
  );
  const protByInstr: Record<string, any[]> = {};
  for (const r of protectionByInstrument.rows) {
    if (!protByInstr[r.instrument_id]) protByInstr[r.instrument_id] = [];
    protByInstr[r.instrument_id].push(r);
  }

  // Compute per-regime hedge sell proceeds via instrument matching
  for (const [key, regime] of Object.entries(regimes)) {
    if (!regime.protections || regime.protections.length === 0) continue;
    const regimeInstruments = new Set<string>(
      regime.protections.map((p: any) => p.instrument_id).filter(Boolean)
    );
    let regimeSellsBtc = 0;
    let regimeSellsCount = 0;
    for (const instr of regimeInstruments) {
      const ss = sellsByInstrument[instr] ?? [];
      for (const s of ss) {
        regimeSellsBtc += Number(s.amount) * Number(s.price);
        regimeSellsCount += 1;
      }
    }
    regime.deribitSellsBtc = regimeSellsBtc;
    regime.deribitSellsUsd = regimeSellsBtc * avgBtcPrice;
    regime.deribitSellsCount = regimeSellsCount;
  }

  // 5. Print per-regime report
  console.log("\n\n" + "═".repeat(80));
  console.log("REGIME-BY-REGIME RECONCILIATION");
  console.log("═".repeat(80));

  for (const key of ["A_50_60", "B_65_70", "C_25_biweekly", "other"]) {
    const r = regimes[key];
    if (r.protections.length === 0) continue;
    console.log(`\n### ${r.name}`);
    console.log(`  Protection count:           ${r.protectionCount}`);
    console.log(`  Total notional:             $${r.totalNotional.toFixed(2)}`);
    console.log(`  Total premium collected:    $${r.totalPremiumCollected.toFixed(2)}`);
    console.log(`  Triggered:                  ${r.triggeredCount}`);
    console.log(`  Expired OTM:                ${r.expiredOtmCount}`);
    console.log(`  Hedge BUY (DB-recorded):    $${r.totalHedgeBuysUsdc.toFixed(2)}`);
    console.log(`  Hedge SELL (DB-recorded):   $${r.totalHedgeSellsUsdc.toFixed(2)}`);
    console.log(`  Hedge SELL (Deribit-actual): $${(r.deribitSellsUsd ?? 0).toFixed(2)} (${r.deribitSellsCount ?? 0} fills)`);
    console.log(`  Payout owed (DB):           $${r.totalPayoutOwed.toFixed(2)}`);
    console.log(`  Payout settled (DB):        $${r.totalPayoutSettled.toFixed(2)}`);
    const grossPnL =
      r.totalPremiumCollected
      - r.totalHedgeBuysUsdc
      + (r.deribitSellsUsd ?? 0)
      - r.totalPayoutOwed; // owed = liability whether settled or not
    console.log(`  >> Gross net P&L:           $${grossPnL.toFixed(2)}`);
    console.log(`  Period:                     ${r.firstTrade?.toISOString().slice(0,10)} → ${r.lastTrade?.toISOString().slice(0,10)}`);
  }

  // 6. Aggregate pilot reconciliation
  console.log("\n\n" + "═".repeat(80));
  console.log("PILOT AGGREGATE (life-to-date)");
  console.log("═".repeat(80));

  const totalProt = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status NOT IN ('activation_failed','cancelled')) as protections,
       SUM(premium) FILTER (WHERE status NOT IN ('activation_failed','cancelled')) as premium,
       SUM(payout_due_amount) FILTER (WHERE status = 'triggered') as payout_owed,
       SUM(payout_settled_amount) FILTER (WHERE payout_settled_amount IS NOT NULL) as payout_settled
     FROM pilot_protections`
  );
  const t = totalProt.rows[0];
  console.log(`\n  Protections sold:           ${t.protections}`);
  console.log(`  Premium collected:          $${t.premium ?? "0"}`);
  console.log(`  Payouts owed (triggered):   $${t.payout_owed ?? "0"}`);
  console.log(`  Payouts settled:            $${t.payout_settled ?? "0"}`);
  console.log(`  Hedge buys (Deribit total): $${(buyTotalBtc * avgBtcPrice).toFixed(2)}`);
  console.log(`  Hedge sells (Deribit total): $${(sellTotalBtc * avgBtcPrice).toFixed(2)}`);
  console.log(`  Net hedge cost:             $${((buyTotalBtc - sellTotalBtc) * avgBtcPrice).toFixed(2)}`);

  // 7. Account-side reconciliation
  console.log("\n\n" + "═".repeat(80));
  console.log("ACCOUNT-SIDE RECONCILIATION (post-unwind)");
  console.log("═".repeat(80));
  // Get current account state
  const sumR = await fetch(`${BASE_URL}/private/get_account_summary?currency=BTC`, {
    headers: { Authorization: `Bearer ${token}` }
  }).then(r => r.json()) as any;
  const sumU = await fetch(`${BASE_URL}/private/get_account_summary?currency=USDC`, {
    headers: { Authorization: `Bearer ${token}` }
  }).then(r => r.json()) as any;
  console.log(`\n  Deribit BTC equity:         ${sumR.result.equity} BTC ≈ $${(Number(sumR.result.equity) * avgBtcPrice).toFixed(2)}`);
  console.log(`  Deribit USDC available:     ${sumU.result.available_funds} USDC`);
  console.log(`  Total account value:        ~$${(Number(sumR.result.equity) * avgBtcPrice + Number(sumU.result.available_funds)).toFixed(2)}`);

  await pool.end();
};

main().catch(e => { console.error(e); pool.end().catch(()=>{}); process.exit(1); });
