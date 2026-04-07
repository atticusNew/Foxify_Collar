/**
 * Backtest V2: Comprehensive low-floor premium analysis
 * 
 * Tests 1-6 + post-breach option profit tracking:
 * 1. Win/Loss breakdown per tier
 * 2. Hedge coverage verification (option value at trigger vs payout)
 * 3. Treasury cash flow simulation
 * 4. Aggressive pricing floors for adoption
 * 5. Calm vs stress regime breakout
 * 6. Pass-through pricing range for 1-2%
 * + Post-breach profit: how much more the option gains after trigger
 */

const SL_TIERS = [1, 2, 3, 5, 10];
const TENOR = 7;
const NOTIONAL = 10_000;
const RF = 0.05;
const TREASURY_START = 10_000;
const DAILY_NEW_PROTECTIONS = 5;

const PERIODS: { name: string; start: string; end: string; tag: string }[] = [
  { name: "Last 12mo (Apr 2025-Apr 2026)", start: "2025-04-01", end: "2026-04-07", tag: "recent" },
  { name: "Prior 12mo (Apr 2024-Apr 2025)", start: "2024-04-01", end: "2025-04-01", tag: "bull" },
  { name: "Q2 2022 Terra/Luna", start: "2022-04-01", end: "2022-07-01", tag: "crash" },
  { name: "Q4 2022 FTX", start: "2022-10-01", end: "2023-01-01", tag: "crash" },
  { name: "Q1 2024 ETF Rally", start: "2024-01-01", end: "2024-04-01", tag: "bull" },
  { name: "Q3 2024 Consolidation", start: "2024-07-01", end: "2024-10-01", tag: "range" },
  { name: "Full 2022 (worst)", start: "2022-01-01", end: "2023-01-01", tag: "crash" },
  { name: "Full 2024 (bull)", start: "2024-01-01", end: "2025-01-01", tag: "bull" },
];

// ─── Black-Scholes ───────────────────────────────────────────────────

function nCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const s = x < 0 ? -1 : 1; x = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  return 0.5 * (1 + s * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)));
}

function bsPut(S: number, K: number, T: number, r: number, v: number): number {
  if (T <= 0 || v <= 0 || S <= 0 || K <= 0) return Math.max(0, K - S);
  const d1 = (Math.log(S / K) + (r + v * v / 2) * T) / (v * Math.sqrt(T));
  const d2 = d1 - v * Math.sqrt(T);
  return K * Math.exp(-r * T) * nCDF(-d2) - S * nCDF(-d1);
}

function rVol(prices: number[], w: number): number {
  if (prices.length < w + 1) return 0.6;
  const rets: number[] = [];
  for (let i = Math.max(0, prices.length - w - 1); i < prices.length - 1; i++) {
    if (prices[i] > 0 && prices[i + 1] > 0) rets.push(Math.log(prices[i + 1] / prices[i]));
  }
  if (rets.length < 5) return 0.6;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance * 365);
}

// ─── Data fetch ──────────────────────────────────────────────────────

async function fetchPrices(start: string, end: string): Promise<{ date: string; price: number }[]> {
  const all = new Map<string, number>();
  const sMs = new Date(start).getTime(), eMs = new Date(end).getTime();
  let cur = sMs;
  while (cur < eMs) {
    const ce = Math.min(cur + 300 * 86400000, eMs);
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${new Date(cur).toISOString()}&end=${new Date(ce).toISOString()}`;
    let retries = 3;
    while (retries-- > 0) {
      try {
        const res = await fetch(url);
        if (res.status === 429) { await new Promise(r => setTimeout(r, 3000)); continue; }
        if (!res.ok) throw new Error(`Coinbase ${res.status}`);
        const candles = await res.json() as number[][];
        for (const [ts, , , , close] of candles) all.set(new Date(ts * 1000).toISOString().slice(0, 10), close);
        break;
      } catch (e: any) { if (retries <= 0) throw e; await new Promise(r => setTimeout(r, 2000)); }
    }
    cur = ce;
    await new Promise(r => setTimeout(r, 500));
  }
  return Array.from(all.entries()).map(([d, p]) => ({ date: d, price: p })).sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Analysis types ──────────────────────────────────────────────────

type WindowResult = {
  entryPrice: number;
  triggerPrice: number;
  minPrice: number;
  expiryPrice: number;
  triggered: boolean;
  hedgeCost: number;
  payout: number;
  optionAtTrigger: number;
  optionAtExpiry: number;
  postBreachProfit: number;
  vol30d: number;
  pnlAtPremium: (premium: number) => number;
};

function analyzeWindows(prices: { date: string; price: number }[], slPct: number): WindowResult[] {
  const pv = prices.map(p => p.price);
  const results: WindowResult[] = [];

  for (let i = 0; i + TENOR < prices.length; i++) {
    const entry = prices[i].price;
    if (entry <= 0) continue;
    const trigger = entry * (1 - slPct / 100);
    const qty = NOTIONAL / entry;
    const T = TENOR / 365;
    const vol = rVol(pv.slice(0, i + 1), 30) * 1.15;
    const hedgeCost = bsPut(entry, trigger, T, RF, vol) * qty;

    const window = prices.slice(i, i + TENOR + 1).map(p => p.price);
    const minPrice = Math.min(...window);
    const expiryPrice = prices[i + TENOR]?.price || entry;
    const triggered = minPrice <= trigger;
    const payout = triggered ? NOTIONAL * (slPct / 100) : 0;

    let triggerDay = -1;
    if (triggered) {
      for (let d = 0; d < window.length; d++) { if (window[d] <= trigger) { triggerDay = d; break; } }
    }

    const optionAtTrigger = triggered ? bsPut(trigger, trigger, Math.max(0, (TENOR - triggerDay) / 365), RF, vol) * qty : 0;
    const optionIntrinsicAtExpiry = Math.max(0, trigger - expiryPrice) * qty;
    const optionTimeAtExpiry = bsPut(expiryPrice, trigger, 0.001, RF, vol) * qty;
    const optionAtExpiry = Math.max(optionIntrinsicAtExpiry, optionTimeAtExpiry);

    const postBreachProfit = triggered ? optionAtExpiry : 0;

    results.push({
      entryPrice: entry, triggerPrice: trigger, minPrice, expiryPrice,
      triggered, hedgeCost, payout, optionAtTrigger, optionAtExpiry, postBreachProfit,
      vol30d: vol / 1.15,
      pnlAtPremium: (premium: number) => premium - hedgeCost - payout + optionAtExpiry,
    });
  }
  return results;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log("  ATTICUS LOW-FLOOR BACKTEST V2 — COMPREHENSIVE ANALYSIS");
  console.log("  SL Tiers: " + SL_TIERS.join("%, ") + "% | Tenor: " + TENOR + "d | Notional: $" + NOTIONAL.toLocaleString());
  console.log("  " + new Date().toISOString());
  console.log("═══════════════════════════════════════════════════════════════════════════\n");

  const allData: { period: string; tag: string; prices: { date: string; price: number }[] }[] = [];

  for (const p of PERIODS) {
    console.log(`Fetching: ${p.name}...`);
    try {
      const prices = await fetchPrices(p.start, p.end);
      console.log(`  ${prices.length} days loaded\n`);
      allData.push({ period: p.name, tag: p.tag, prices });
    } catch (e: any) { console.error(`  ERROR: ${e.message}\n`); }
  }

  for (const sl of SL_TIERS) {
    console.log("\n" + "═".repeat(75));
    console.log(`  ${sl}% STOP LOSS — FULL ANALYSIS`);
    console.log("═".repeat(75));

    const allWindows: (WindowResult & { period: string; tag: string })[] = [];

    for (const d of allData) {
      const windows = analyzeWindows(d.prices, sl);
      for (const w of windows) allWindows.push({ ...w, period: d.period, tag: d.tag });
    }

    if (!allWindows.length) { console.log("  No data"); continue; }

    // ─── TEST 1: Win/Loss at various premiums ────────────────────────
    console.log("\n  ── TEST 1: Win/Loss Breakdown ──\n");
    const testPremiums = [30, 50, 65, 80, 100, 120, 150].map(p => p);
    console.log("  Premium/10k │ Wins    │ Losses  │ Win Rate │ Avg Win  │ Avg Loss │ Max Loss │ Net P&L/trade");
    console.log("  ────────────┼─────────┼─────────┼──────────┼──────────┼──────────┼──────────┼─────────────");
    for (const prem of testPremiums) {
      const pnls = allWindows.map(w => w.pnlAtPremium(prem));
      const wins = pnls.filter(p => p >= 0);
      const losses = pnls.filter(p => p < 0);
      const avgWin = wins.length ? wins.reduce((s, p) => s + p, 0) / wins.length : 0;
      const avgLoss = losses.length ? losses.reduce((s, p) => s + p, 0) / losses.length : 0;
      const maxLoss = losses.length ? Math.min(...losses) : 0;
      const netAvg = pnls.reduce((s, p) => s + p, 0) / pnls.length;
      const wr = (wins.length / pnls.length * 100).toFixed(0);
      console.log(`  $${String(prem).padStart(9)}  │ ${String(wins.length).padStart(7)} │ ${String(losses.length).padStart(7)} │ ${wr.padStart(6)}%  │ $${avgWin.toFixed(0).padStart(6)}  │ $${avgLoss.toFixed(0).padStart(6)}  │ $${maxLoss.toFixed(0).padStart(6)}  │ $${netAvg.toFixed(2)}`);
    }

    // ─── TEST 2: Hedge Coverage at Trigger ───────────────────────────
    console.log("\n  ── TEST 2: Hedge Coverage at Trigger ──\n");
    const triggered = allWindows.filter(w => w.triggered);
    if (triggered.length) {
      const avgPayout = triggered.reduce((s, w) => s + w.payout, 0) / triggered.length;
      const avgOptAtTrigger = triggered.reduce((s, w) => s + w.optionAtTrigger, 0) / triggered.length;
      const avgOptAtExpiry = triggered.reduce((s, w) => s + w.optionAtExpiry, 0) / triggered.length;
      const avgCoverageAtTrigger = triggered.reduce((s, w) => s + (w.payout > 0 ? w.optionAtTrigger / w.payout : 0), 0) / triggered.length;
      const avgCoverageAtExpiry = triggered.reduce((s, w) => s + (w.payout > 0 ? w.optionAtExpiry / w.payout : 0), 0) / triggered.length;
      const fullyCoveredAtExpiry = triggered.filter(w => w.optionAtExpiry >= w.payout).length;
      console.log(`  Triggered windows: ${triggered.length} / ${allWindows.length} (${(triggered.length / allWindows.length * 100).toFixed(1)}%)`);
      console.log(`  Avg payout owed:               $${avgPayout.toFixed(2)}`);
      console.log(`  Avg option value AT trigger:    $${avgOptAtTrigger.toFixed(2)} (${(avgCoverageAtTrigger * 100).toFixed(0)}% coverage)`);
      console.log(`  Avg option value AT expiry:     $${avgOptAtExpiry.toFixed(2)} (${(avgCoverageAtExpiry * 100).toFixed(0)}% coverage)`);
      console.log(`  Fully covered at expiry:        ${fullyCoveredAtExpiry} / ${triggered.length} (${(fullyCoveredAtExpiry / triggered.length * 100).toFixed(0)}%)`);
    } else {
      console.log("  No triggers in dataset");
    }

    // ─── POST-BREACH PROFIT ──────────────────────────────────────────
    console.log("\n  ── POST-BREACH OPTION PROFIT ──\n");
    if (triggered.length) {
      const withProfit = triggered.filter(w => w.postBreachProfit > 0);
      const avgProfit = withProfit.length ? withProfit.reduce((s, w) => s + w.postBreachProfit, 0) / withProfit.length : 0;
      const maxProfit = withProfit.length ? Math.max(...withProfit.map(w => w.postBreachProfit)) : 0;
      const totalPostBreach = triggered.reduce((s, w) => s + w.postBreachProfit, 0);
      const avgPerTrigger = totalPostBreach / triggered.length;
      const netAfterPayout = triggered.reduce((s, w) => s + w.postBreachProfit - w.payout, 0) / triggered.length;
      console.log(`  Triggers with post-breach profit: ${withProfit.length} / ${triggered.length} (${(withProfit.length / triggered.length * 100).toFixed(0)}%)`);
      console.log(`  Avg post-breach option value:     $${avgPerTrigger.toFixed(2)} per trigger`);
      console.log(`  Max post-breach option value:     $${maxProfit.toFixed(2)}`);
      console.log(`  Avg net after payout (opt - pay): $${netAfterPayout.toFixed(2)} per trigger`);
      console.log(`  Total post-breach recovery:       $${totalPostBreach.toFixed(2)} across ${triggered.length} triggers`);
    }

    // ─── TEST 3: Treasury Simulation ─────────────────────────────────
    console.log("\n  ── TEST 3: Treasury Cash Flow (${DAILY_NEW_PROTECTIONS}/day, $65/10k premium) ──\n");
    const simPremium = sl <= 2 ? 65 : sl <= 5 ? 50 : 30;
    for (const d of allData) {
      const windows = analyzeWindows(d.prices, sl);
      let treasury = TREASURY_START;
      let minTreasury = treasury, maxDrawdown = 0, totalPremiums = 0, totalPayouts = 0, totalRecovery = 0;
      for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
        const dailyProtections = Math.min(DAILY_NEW_PROTECTIONS, 1);
        for (let p = 0; p < dailyProtections; p++) {
          treasury += simPremium;
          treasury -= w.hedgeCost;
          totalPremiums += simPremium;
          if (w.triggered) {
            treasury -= w.payout;
            treasury += w.optionAtExpiry;
            totalPayouts += w.payout;
            totalRecovery += w.optionAtExpiry;
          }
        }
        if (treasury < minTreasury) minTreasury = treasury;
        const dd = TREASURY_START - treasury;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }
      const label = d.period.slice(0, 30).padEnd(30);
      console.log(`  ${label} | Start: $${TREASURY_START} | End: $${treasury.toFixed(0).padStart(7)} | Min: $${minTreasury.toFixed(0).padStart(7)} | MaxDD: $${maxDrawdown.toFixed(0).padStart(6)} | Prem: $${totalPremiums.toFixed(0)} | Pay: $${totalPayouts.toFixed(0)} | Recov: $${totalRecovery.toFixed(0)}`);
    }

    // ─── TEST 4: Aggressive Pricing Floors ───────────────────────────
    console.log("\n  ── TEST 4: Minimum Viable Premiums ──\n");
    const sortedPnls = (prem: number) => allWindows.map(w => w.pnlAtPremium(prem));
    for (const target of [0, -0.10, -0.20]) {
      let lo = 1, hi = 500;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        const pnls = sortedPnls(mid);
        const total = pnls.reduce((s, p) => s + p, 0);
        const avg = total / pnls.length;
        if (avg >= target * NOTIONAL) hi = mid; else lo = mid;
      }
      const label = target === 0 ? "Break-even (avg)" : `Accept ${(target * 100).toFixed(0)}% loss`;
      console.log(`  ${label.padEnd(25)} → $${hi}/10k ($${(hi / 10).toFixed(1)}/1k)`);
    }
    const pnls30 = sortedPnls(30); const pnls50 = sortedPnls(50); const pnls80 = sortedPnls(80);
    console.log(`\n  P&L at $30/10k: avg $${(pnls30.reduce((s,p)=>s+p,0)/pnls30.length).toFixed(2)} | at $50: avg $${(pnls50.reduce((s,p)=>s+p,0)/pnls50.length).toFixed(2)} | at $80: avg $${(pnls80.reduce((s,p)=>s+p,0)/pnls80.length).toFixed(2)}`);

    // ─── TEST 5: Calm vs Stress ──────────────────────────────────────
    console.log("\n  ── TEST 5: Calm vs Normal vs Stress ──\n");
    const calm = allWindows.filter(w => w.vol30d < 0.40);
    const normal = allWindows.filter(w => w.vol30d >= 0.40 && w.vol30d < 0.65);
    const stress = allWindows.filter(w => w.vol30d >= 0.65);

    for (const [label, group] of [["Calm (vol<40%)", calm], ["Normal (40-65%)", normal], ["Stress (vol>65%)", stress]] as const) {
      if (!group.length) { console.log(`  ${label}: no data`); continue; }
      const tr = group.filter(w => w.triggered).length / group.length;
      const avgHedge = group.reduce((s, w) => s + w.hedgeCost, 0) / group.length;
      const avgPay = group.reduce((s, w) => s + w.payout, 0) / group.length;
      const avgResid = group.reduce((s, w) => s + w.optionAtExpiry, 0) / group.length;
      const be = avgHedge + avgPay - avgResid;
      console.log(`  ${(label as string).padEnd(20)} │ N=${String(group.length).padStart(5)} │ Trigger: ${(tr * 100).toFixed(0).padStart(3)}% │ Hedge: $${avgHedge.toFixed(0).padStart(5)} │ BE: $${be.toFixed(0).padStart(5)} │ Suggest: $${(be * 1.3).toFixed(0).padStart(5)}/10k`);
    }

    // ─── TEST 6: Pass-through range (1-2% only) ─────────────────────
    if (sl <= 2) {
      console.log("\n  ── TEST 6: Pass-Through Pricing Distribution ──\n");
      const costs = allWindows.map(w => w.hedgeCost).sort((a, b) => a - b);
      const pct = (p: number) => costs[Math.floor(costs.length * p)] || 0;
      for (const margin of [0.20, 0.30, 0.40]) {
        const withMargin = costs.map(c => c * (1 + margin));
        const wm = (p: number) => withMargin[Math.floor(withMargin.length * p)] || 0;
        console.log(`  +${(margin * 100).toFixed(0)}% margin │ Min: $${wm(0).toFixed(0).padStart(4)} │ P25: $${wm(0.25).toFixed(0).padStart(4)} │ Med: $${wm(0.5).toFixed(0).padStart(4)} │ P75: $${wm(0.75).toFixed(0).padStart(4)} │ P95: $${wm(0.95).toFixed(0).padStart(4)} │ Max: $${wm(1).toFixed(0).padStart(4)}`);
      }
      console.log(`  Raw hedge │ Min: $${pct(0).toFixed(0).padStart(4)} │ P25: $${pct(0.25).toFixed(0).padStart(4)} │ Med: $${pct(0.5).toFixed(0).padStart(4)} │ P75: $${pct(0.75).toFixed(0).padStart(4)} │ P95: $${pct(0.95).toFixed(0).padStart(4)} │ Max: $${pct(1).toFixed(0).padStart(4)}`);
    }
  }

  // ─── FINAL SUMMARY ─────────────────────────────────────────────────
  console.log("\n\n" + "═".repeat(75));
  console.log("  FINAL PREMIUM RECOMMENDATIONS");
  console.log("═".repeat(75) + "\n");
  console.log("  SL%  │ Adoption Price │ Sustainable │ Conservative │ Model          ");
  console.log("  ─────┼────────────────┼─────────────┼──────────────┼────────────────");

  for (const sl of SL_TIERS) {
    const allW: WindowResult[] = [];
    for (const d of allData) allW.push(...analyzeWindows(d.prices, sl));
    if (!allW.length) continue;
    const trigRate = allW.filter(w => w.triggered).length / allW.length;
    const avgHedge = allW.reduce((s, w) => s + w.hedgeCost, 0) / allW.length;
    const avgPay = allW.reduce((s, w) => s + w.payout, 0) / allW.length;
    const avgResid = allW.reduce((s, w) => s + w.optionAtExpiry, 0) / allW.length;
    const be = avgHedge + avgPay - avgResid;

    const adoption = Math.ceil(be * 0.9 / 5) * 5;
    const sustainable = Math.ceil(be * 1.2 / 5) * 5;
    const conservative = Math.ceil(be * 1.4 / 5) * 5;
    const model = trigRate > 0.5 ? "Dynamic recommended" : trigRate > 0.3 ? "Fixed viable" : "Fixed safe";

    console.log(`  ${String(sl).padStart(3)}%  │ $${String(adoption).padStart(4)}/10k      │ $${String(sustainable).padStart(4)}/10k   │ $${String(conservative).padStart(5)}/10k    │ ${model}`);
  }
  console.log();
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
