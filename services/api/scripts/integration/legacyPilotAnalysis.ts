/**
 * Legacy pilot empirical analysis — the ACTUAL answer to "did past 50k/2% work?"
 *
 * Pulls real position + hedge data from the production DB (DB #1, schema:
 * volume_cover_position + volume_cover_hedge_leg + pilot_protections), computes
 * realized per-pair economics:
 *
 *   Foxify revenue   = daily_premium_usdc × days held (or premium collected)
 *   Foxify payout    = payout_usdc (what Foxify paid the user)
 *   Hedge gross cost = SUM(volume_cover_hedge_leg.buy_price_usdc × contracts)
 *   Hedge salvage    = SUM(volume_cover_hedge_leg.sell_price_usdc × contracts)
 *   Foxify NET       = revenue - payout
 *   Atticus NET      = -hedge_gross + hedge_salvage  (hedge P&L)
 *   Cooperative EV   = Foxify_NET + Atticus_NET
 *
 * Also groups by:
 *   - Cell ID (50k/2%, etc.)
 *   - Regime at open
 *   - Hour-of-day at open (was past success time-of-day dependent?)
 *
 * Output: docs/PHASE_1_LEGACY_PILOT_EMPIRICAL_<date>.md
 *
 * Usage:
 *   export POSTGRES_URL=<prod>
 *   npx tsx scripts/integration/legacyPilotAnalysis.ts
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL!,
  ssl: { rejectUnauthorized: false }
});

const fmt$ = (n: number | null) => n == null ? "—" : `${n < 0 ? "-" : ""}\$${Math.round(Math.abs(n)).toLocaleString()}`;
const fmt$S = (n: number | null) => n == null ? "—" : `${n < 0 ? "-" : "+"}\$${Math.round(Math.abs(n)).toLocaleString()}`;
const fmtPct = (n: number | null) => n == null ? "—" : `${(n * 100).toFixed(1)}%`;

const main = async () => {
  console.log("# Legacy Pilot Empirical Analysis\n");

  // 1) Pull all volume_cover_position rows
  const posRes = await pool.query(`
    SELECT id, cell_id, foxify_pair_id, pair_long_notional_usdc, pair_short_notional_usdc,
           pair_entry_btc_price, trigger_high_btc, trigger_low_btc,
           daily_premium_usdc, payout_usdc, status,
           opened_at, triggered_at, triggered_direction, closed_at, close_reason,
           regime_at_open, metadata
    FROM volume_cover_position
    ORDER BY opened_at DESC
  `);
  const positions = posRes.rows;
  console.log(`positions: ${positions.length}`);

  // 2) Pull hedge legs (joined to positions)
  const legRes = await pool.query(`
    SELECT id, position_id, venue, option_kind, strike_usdc, contracts,
           buy_price_usdc, sell_price_usdc, status, opened_at, closed_at,
           initial_proceeds_usdc, running_max_value_usdc
    FROM volume_cover_hedge_leg
    ORDER BY opened_at
  `);
  const legs = legRes.rows;
  console.log(`hedge legs: ${legs.length}`);

  // 3) Pull cell defs for sanity
  const cellRes = await pool.query(`SELECT * FROM volume_cover_cell LIMIT 8`);
  console.log(`\ncells in registry (${cellRes.rows.length}):`);
  for (const c of cellRes.rows) console.log(`  ${JSON.stringify(c)}`);

  // 4) Per-position computed economics
  type PositionEcon = {
    posId: string;
    cellId: string;
    foxifyPairId: string;
    openedAt: Date;
    openHour: number;
    regime: string;
    notionalLong: number;
    notionalShort: number;
    entryPrice: number;
    triggered: boolean;
    triggerDir: string | null;
    closeReason: string | null;
    status: string;
    dailyPremium: number;
    payoutToUser: number;
    hedgeBuyTotal: number;
    hedgeSellTotal: number;
    hedgeNetPnl: number;
    foxifyNetPnl: number;
    cooperativeEv: number;
    daysHeld: number | null;
    legCount: number;
  };
  const econ: PositionEcon[] = positions.map((p) => {
    const myLegs = legs.filter((l) => l.position_id === p.id);
    const hedgeBuy = myLegs.reduce((s, l) => s + Number(l.buy_price_usdc ?? 0) * Number(l.contracts ?? 0), 0);
    const hedgeSell = myLegs.reduce((s, l) => s + Number(l.sell_price_usdc ?? 0) * Number(l.contracts ?? 0), 0);
    const opened = new Date(p.opened_at);
    const closed = p.closed_at ? new Date(p.closed_at) : null;
    const daysHeld = closed ? (closed.getTime() - opened.getTime()) / 86_400_000 : null;
    const premiumCollected = Number(p.daily_premium_usdc ?? 0) * (daysHeld ?? 1);
    const payout = Number(p.payout_usdc ?? 0);
    const foxifyNet = premiumCollected - payout;
    const hedgeNet = hedgeSell - hedgeBuy;
    return {
      posId: p.id,
      cellId: p.cell_id,
      foxifyPairId: p.foxify_pair_id,
      openedAt: opened,
      openHour: opened.getUTCHours(),
      regime: p.regime_at_open ?? "unknown",
      notionalLong: Number(p.pair_long_notional_usdc ?? 0),
      notionalShort: Number(p.pair_short_notional_usdc ?? 0),
      entryPrice: Number(p.pair_entry_btc_price ?? 0),
      triggered: p.triggered_at != null,
      triggerDir: p.triggered_direction,
      closeReason: p.close_reason,
      status: p.status,
      dailyPremium: Number(p.daily_premium_usdc ?? 0),
      payoutToUser: payout,
      hedgeBuyTotal: hedgeBuy,
      hedgeSellTotal: hedgeSell,
      hedgeNetPnl: hedgeNet,
      foxifyNetPnl: foxifyNet,
      cooperativeEv: foxifyNet + hedgeNet,
      daysHeld,
      legCount: myLegs.length
    };
  });

  // 5) Aggregate by cell
  const cellAgg = new Map<string, { n: number; trig: number; sumHedgeBuy: number; sumHedgeSell: number; sumHedgeNet: number; sumFoxifyNet: number; sumCoop: number; bestCoop: number; worstCoop: number }>();
  for (const e of econ) {
    const a = cellAgg.get(e.cellId) ?? { n: 0, trig: 0, sumHedgeBuy: 0, sumHedgeSell: 0, sumHedgeNet: 0, sumFoxifyNet: 0, sumCoop: 0, bestCoop: -Infinity, worstCoop: Infinity };
    a.n++;
    if (e.triggered) a.trig++;
    a.sumHedgeBuy += e.hedgeBuyTotal;
    a.sumHedgeSell += e.hedgeSellTotal;
    a.sumHedgeNet += e.hedgeNetPnl;
    a.sumFoxifyNet += e.foxifyNetPnl;
    a.sumCoop += e.cooperativeEv;
    if (e.cooperativeEv > a.bestCoop) a.bestCoop = e.cooperativeEv;
    if (e.cooperativeEv < a.worstCoop) a.worstCoop = e.cooperativeEv;
    cellAgg.set(e.cellId, a);
  }

  // 6) Aggregate by regime
  const regAgg = new Map<string, { n: number; trig: number; sumHedgeNet: number; sumFoxifyNet: number; sumCoop: number }>();
  for (const e of econ) {
    const a = regAgg.get(e.regime) ?? { n: 0, trig: 0, sumHedgeNet: 0, sumFoxifyNet: 0, sumCoop: 0 };
    a.n++;
    if (e.triggered) a.trig++;
    a.sumHedgeNet += e.hedgeNetPnl;
    a.sumFoxifyNet += e.foxifyNetPnl;
    a.sumCoop += e.cooperativeEv;
    regAgg.set(e.regime, a);
  }

  // 7) Aggregate by hour-of-day (UTC) at open
  const hourAgg = new Map<number, { n: number; sumHedgeBuy: number; sumHedgeNet: number; sumCoop: number }>();
  for (const e of econ) {
    const a = hourAgg.get(e.openHour) ?? { n: 0, sumHedgeBuy: 0, sumHedgeNet: 0, sumCoop: 0 };
    a.n++;
    a.sumHedgeBuy += e.hedgeBuyTotal;
    a.sumHedgeNet += e.hedgeNetPnl;
    a.sumCoop += e.cooperativeEv;
    hourAgg.set(e.openHour, a);
  }

  // 8) Write the report
  const lines: string[] = [];
  lines.push(`# Legacy Pilot Empirical Analysis — REAL PAST DATA`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Source:** \`volume_cover_position\` JOIN \`volume_cover_hedge_leg\` (Render production DB)`);
  lines.push(`**Sample size:** ${positions.length} positions, ${legs.length} hedge legs`);
  lines.push("");

  lines.push(`## Per-cell realized economics`);
  lines.push("");
  lines.push(`| Cell | N | TrigRate | Total hedge $ paid | Total hedge $ recovered | **Hedge net** | **Foxify net** | **Coop EV** | Mean coop/pair | Best | Worst |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  const sortedCells = [...cellAgg.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [cellId, a] of sortedCells) {
    lines.push(`| ${cellId} | ${a.n} | ${fmtPct(a.trig / a.n)} | ${fmt$(a.sumHedgeBuy)} | ${fmt$(a.sumHedgeSell)} | ${fmt$S(a.sumHedgeNet)} | ${fmt$S(a.sumFoxifyNet)} | **${fmt$S(a.sumCoop)}** | ${fmt$S(a.sumCoop / a.n)} | ${fmt$S(a.bestCoop)} | ${fmt$S(a.worstCoop)} |`);
  }
  lines.push("");

  lines.push(`## Per-regime realized economics`);
  lines.push("");
  lines.push(`| Regime | N | TrigRate | **Hedge net** | **Foxify net** | **Coop EV** | Mean coop/pair |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|`);
  for (const [reg, a] of [...regAgg.entries()].sort((a, b) => b[1].n - a[1].n)) {
    lines.push(`| ${reg} | ${a.n} | ${fmtPct(a.trig / a.n)} | ${fmt$S(a.sumHedgeNet)} | ${fmt$S(a.sumFoxifyNet)} | **${fmt$S(a.sumCoop)}** | ${fmt$S(a.sumCoop / a.n)} |`);
  }
  lines.push("");

  lines.push(`## Time-of-day distribution (UTC hour at position open)`);
  lines.push("");
  lines.push(`Reveals whether past pilots were biased to a specific session (e.g., US open = better spreads).`);
  lines.push("");
  lines.push(`| Hour UTC | Session | N | Mean hedge $ paid | Mean hedge net | Mean coop EV |`);
  lines.push(`|---:|---|---:|---:|---:|---:|`);
  for (let h = 0; h < 24; h++) {
    const a = hourAgg.get(h);
    if (!a) continue;
    const session = h >= 0 && h < 8 ? "ASIA" : h >= 8 && h < 13 ? "EU" : h >= 13 && h < 21 ? "US" : "ASIA-EVE";
    lines.push(`| ${h.toString().padStart(2, "0")}:00 | ${session} | ${a.n} | ${fmt$(a.sumHedgeBuy / a.n)} | ${fmt$S(a.sumHedgeNet / a.n)} | ${fmt$S(a.sumCoop / a.n)} |`);
  }
  lines.push("");

  lines.push(`## All positions (full receipts)`);
  lines.push("");
  lines.push(`| pos_id (8) | cell | opened (UTC) | regime | entry BTC | trig? | dir | legs | hedge BUY | hedge SELL | hedge net | Foxify net | Coop EV | close reason |`);
  lines.push(`|---|---|---|---|---:|---|---|---:|---:|---:|---:|---:|---:|---|`);
  for (const e of econ) {
    lines.push(`| \`${e.posId.slice(0, 8)}\` | ${e.cellId} | ${e.openedAt.toISOString().slice(0, 16)} | ${e.regime} | \$${Math.round(e.entryPrice).toLocaleString()} | ${e.triggered ? "Y" : "N"} | ${e.triggerDir ?? "—"} | ${e.legCount} | ${fmt$(e.hedgeBuyTotal)} | ${fmt$(e.hedgeSellTotal)} | ${fmt$S(e.hedgeNetPnl)} | ${fmt$S(e.foxifyNetPnl)} | **${fmt$S(e.cooperativeEv)}** | ${e.closeReason ?? "—"} |`);
  }
  lines.push("");

  // 9) Key empirical conclusions
  lines.push(`## Key empirical conclusions`);
  lines.push("");
  const totalCoop = econ.reduce((s, e) => s + e.cooperativeEv, 0);
  const totalHedgeBuy = econ.reduce((s, e) => s + e.hedgeBuyTotal, 0);
  const totalHedgeSell = econ.reduce((s, e) => s + e.hedgeSellTotal, 0);
  const totalFoxifyNet = econ.reduce((s, e) => s + e.foxifyNetPnl, 0);
  const profCount = econ.filter((e) => e.cooperativeEv > 0).length;
  lines.push(`- **Total positions analyzed:** ${econ.length}`);
  lines.push(`- **Total hedge premium PAID (Atticus out):** ${fmt$(totalHedgeBuy)}`);
  lines.push(`- **Total hedge salvage RECEIVED (Atticus in):** ${fmt$(totalHedgeSell)}`);
  lines.push(`- **Net hedge P&L (Atticus side):** ${fmt$S(totalHedgeSell - totalHedgeBuy)}`);
  lines.push(`- **Net Foxify P&L (premium − payout to users):** ${fmt$S(totalFoxifyNet)}`);
  lines.push(`- **Cooperative EV total (Atticus + Foxify):** ${fmt$S(totalCoop)}`);
  lines.push(`- **Profitable pair rate:** ${profCount}/${econ.length} = ${fmtPct(profCount / econ.length)}`);
  lines.push(`- **Mean coop EV per pair:** ${fmt$S(totalCoop / econ.length)}`);
  lines.push("");

  lines.push(`### Answer to "did past 50k/2% actually pay out net of hedge?"`);
  lines.push("");
  const cell50k2 = sortedCells.find(([id]) => id.includes("50k") || id.includes("50_000") || id.includes("2pct") || id.includes("2_pct"));
  if (cell50k2) {
    const [cid, a] = cell50k2;
    lines.push(`Most-traded ITM-style cell was \`${cid}\` (${a.n} positions).`);
    lines.push(`- Total hedge paid: ${fmt$(a.sumHedgeBuy)}`);
    lines.push(`- Total hedge recovered: ${fmt$(a.sumHedgeSell)}`);
    lines.push(`- **Net hedge P&L: ${fmt$S(a.sumHedgeNet)}**`);
    lines.push(`- **Net cooperative EV: ${fmt$S(a.sumCoop)} (mean ${fmt$S(a.sumCoop / a.n)}/pair)**`);
    if (a.sumCoop > 0) {
      lines.push(`- **Verdict: PROFITABLE empirically.** V3's prediction of catastrophic loss is at odds with this past data — investigate further.`);
    } else {
      lines.push(`- **Verdict: NOT PROFITABLE empirically.** Confirms V3 was correct to flag this as broken.`);
    }
  } else {
    lines.push(`No 50k/2%-style cell found in legacy data. The closest cell traded was the top entry in the table above.`);
  }
  lines.push("");

  lines.push(`---`);
  lines.push(`*Generated by services/api/scripts/integration/legacyPilotAnalysis.ts*`);

  const outPath = path.resolve(process.cwd(), "../..", `docs/PHASE_1_LEGACY_PILOT_EMPIRICAL_${new Date().toISOString().slice(0, 10)}.md`);
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`\n✓ Legacy pilot report: ${outPath}`);

  // Print summary to stdout
  console.log(`\n=== SUMMARY ===`);
  console.log(`Total positions: ${econ.length}`);
  console.log(`Total hedge buy:  ${fmt$(totalHedgeBuy)}`);
  console.log(`Total hedge sell: ${fmt$(totalHedgeSell)}`);
  console.log(`Hedge net P&L:    ${fmt$S(totalHedgeSell - totalHedgeBuy)}`);
  console.log(`Foxify net P&L:   ${fmt$S(totalFoxifyNet)}`);
  console.log(`COOP EV total:    ${fmt$S(totalCoop)}`);
  console.log(`Profitable: ${profCount}/${econ.length} = ${fmtPct(profCount / econ.length)}`);
  console.log(`\nPer-cell:`);
  for (const [cid, a] of sortedCells) {
    console.log(`  ${cid.padEnd(35)} n=${String(a.n).padStart(3)} hedgeBuy=${fmt$(a.sumHedgeBuy).padStart(10)} hedgeNet=${fmt$S(a.sumHedgeNet).padStart(8)} coopEV=${fmt$S(a.sumCoop).padStart(8)} (mean ${fmt$S(a.sumCoop / a.n)}/pair)`);
  }

  await pool.end();
};

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
