/**
 * Backtest: Optimal fixed premiums for 1-5-10% stop-loss floors
 * 
 * Fetches historical BTC daily prices, computes trigger rates,
 * theoretical option costs (Black-Scholes), and platform P&L
 * across multiple time periods and SL tiers.
 */

import Decimal from "decimal.js";

// ─── Config ──────────────────────────────────────────────────────────

const SL_TIERS = [1, 2, 3, 5, 10];
const TENOR_DAYS = 7;
const NOTIONAL = 10_000;
const RISK_FREE_RATE = 0.05;
const PROFITABILITY_MARGIN = 0.30;

const PERIODS: { name: string; start: string; end: string }[] = [
  { name: "Last 12mo (Apr 2025 - Apr 2026)", start: "2025-04-01", end: "2026-04-07" },
  { name: "Prior 12mo (Apr 2024 - Apr 2025)", start: "2024-04-01", end: "2025-04-01" },
  { name: "Q2 2022 Terra/Luna crash", start: "2022-04-01", end: "2022-07-01" },
  { name: "Q4 2022 FTX collapse", start: "2022-10-01", end: "2023-01-01" },
  { name: "Q1 2024 ETF rally", start: "2024-01-01", end: "2024-04-01" },
  { name: "Q3 2024 Consolidation", start: "2024-07-01", end: "2024-10-01" },
  { name: "Full 2022 (worst year)", start: "2022-01-01", end: "2023-01-01" },
  { name: "Full 2024 (bull year)", start: "2024-01-01", end: "2025-01-01" },
];

// ─── Black-Scholes ───────────────────────────────────────────────────

function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function bsPutPrice(spot: number, strike: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0 || spot <= 0 || strike <= 0) return 0;
  const d1 = (Math.log(spot / strike) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return strike * Math.exp(-r * T) * normalCDF(-d2) - spot * normalCDF(-d1);
}

function realizedVol(prices: number[], window: number): number {
  if (prices.length < window + 1) return 0.6;
  const returns: number[] = [];
  for (let i = Math.max(0, prices.length - window - 1); i < prices.length - 1; i++) {
    if (prices[i] > 0 && prices[i + 1] > 0) {
      returns.push(Math.log(prices[i + 1] / prices[i]));
    }
  }
  if (returns.length < 5) return 0.6;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * 365);
}

// ─── Fetch BTC prices ────────────────────────────────────────────────

async function fetchBtcPrices(startDate: string, endDate: string): Promise<{ date: string; price: number }[]> {
  const allPrices = new Map<string, number>();
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();
  const chunkMs = 300 * 86400 * 1000;

  let cursor = startMs;
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + chunkMs, endMs);
    const startIso = new Date(cursor).toISOString();
    const endIso = new Date(chunkEnd).toISOString();
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${startIso}&end=${endIso}`;
    let retries = 3;
    while (retries > 0) {
      try {
        const res = await fetch(url);
        if (res.status === 429) { await new Promise(r => setTimeout(r, 3000)); retries--; continue; }
        if (!res.ok) throw new Error(`Coinbase ${res.status}`);
        const candles = await res.json() as [number, number, number, number, number, number][];
        for (const [ts, low, high, open, close, volume] of candles) {
          const date = new Date(ts * 1000).toISOString().slice(0, 10);
          allPrices.set(date, close);
        }
        break;
      } catch (e: any) {
        retries--;
        if (retries <= 0) throw e;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    cursor = chunkEnd;
    await new Promise(r => setTimeout(r, 500));
  }

  return Array.from(allPrices.entries())
    .map(([date, price]) => ({ date, price }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Backtest engine ─────────────────────────────────────────────────

type TierResult = {
  slPct: number;
  triggerCount: number;
  totalWindows: number;
  triggerRate: number;
  avgHedgeCostPer10k: number;
  avgPayoutPer10k: number;
  avgOptionResidualPer10k: number;
  breakEvenPer10k: number;
  suggestedPer10k: number;
  suggestedPer1k: number;
  worstWindowLoss: number;
  avgPnlAtSuggested: number;
  winRate: number;
};

function runBacktest(prices: { date: string; price: number }[], periodName: string): TierResult[] {
  const results: TierResult[] = [];
  const priceValues = prices.map(p => p.price);

  for (const slPct of SL_TIERS) {
    let triggerCount = 0;
    let totalWindows = 0;
    let totalHedgeCost = 0;
    let totalPayoutLiability = 0;
    let totalOptionResidual = 0;
    let worstWindowLoss = 0;
    const windowPnls: number[] = [];

    for (let i = 0; i + TENOR_DAYS < prices.length; i++) {
      const entryPrice = prices[i].price;
      if (entryPrice <= 0) continue;
      totalWindows++;

      const triggerPrice = entryPrice * (1 - slPct / 100);
      const btcQty = NOTIONAL / entryPrice;
      const T = TENOR_DAYS / 365;

      const historicalPrices = priceValues.slice(0, i + 1);
      const iv = realizedVol(historicalPrices, 30);
      const ivWithPremium = iv * 1.15;

      const optionCostPerBtc = bsPutPrice(entryPrice, triggerPrice, T, RISK_FREE_RATE, ivWithPremium);
      const hedgeCostTotal = optionCostPerBtc * btcQty;
      const hedgeCostPer10k = hedgeCostTotal;

      let windowPrices = prices.slice(i, i + TENOR_DAYS + 1).map(p => p.price);
      let minPrice = Math.min(...windowPrices);
      let triggered = minPrice <= triggerPrice;

      let payoutAmount = 0;
      let optionResidual = 0;

      if (triggered) {
        triggerCount++;
        payoutAmount = NOTIONAL * (slPct / 100);

        const expiryPrice = prices[i + TENOR_DAYS]?.price || entryPrice;
        if (expiryPrice < triggerPrice) {
          optionResidual = (triggerPrice - expiryPrice) * btcQty;
        }
      }

      totalHedgeCost += hedgeCostPer10k;
      totalPayoutLiability += payoutAmount;
      totalOptionResidual += optionResidual;

      const netCost = hedgeCostPer10k + payoutAmount - optionResidual;
      if (netCost > worstWindowLoss) worstWindowLoss = netCost;
    }

    const triggerRate = totalWindows > 0 ? triggerCount / totalWindows : 0;
    const avgHedgeCost = totalWindows > 0 ? totalHedgeCost / totalWindows : 0;
    const avgPayout = totalWindows > 0 ? totalPayoutLiability / totalWindows : 0;
    const avgResidual = totalWindows > 0 ? totalOptionResidual / totalWindows : 0;
    const breakEven = avgHedgeCost + avgPayout - avgResidual;
    const suggested = breakEven * (1 + PROFITABILITY_MARGIN);

    for (let i = 0; i + TENOR_DAYS < prices.length; i++) {
      const entryPrice = prices[i].price;
      if (entryPrice <= 0) continue;
      const triggerPrice = entryPrice * (1 - slPct / 100);
      const btcQty = NOTIONAL / entryPrice;
      const T = TENOR_DAYS / 365;
      const iv = realizedVol(priceValues.slice(0, i + 1), 30);
      const optionCost = bsPutPrice(entryPrice, triggerPrice, T, RISK_FREE_RATE, iv * 1.15) * btcQty;

      let windowPrices = prices.slice(i, i + TENOR_DAYS + 1).map(p => p.price);
      let minPrice = Math.min(...windowPrices);
      let triggered = minPrice <= triggerPrice;
      let payout = triggered ? NOTIONAL * (slPct / 100) : 0;
      let residual = 0;
      if (triggered) {
        const expiryPrice = prices[i + TENOR_DAYS]?.price || entryPrice;
        if (expiryPrice < triggerPrice) residual = (triggerPrice - expiryPrice) * btcQty;
      }
      const pnl = suggested - optionCost - payout + residual;
      windowPnls.push(pnl);
    }

    const winCount = windowPnls.filter(p => p >= 0).length;
    const avgPnl = windowPnls.length > 0 ? windowPnls.reduce((s, p) => s + p, 0) / windowPnls.length : 0;

    results.push({
      slPct,
      triggerCount,
      totalWindows,
      triggerRate,
      avgHedgeCostPer10k: avgHedgeCost,
      avgPayoutPer10k: avgPayout,
      avgOptionResidualPer10k: avgResidual,
      breakEvenPer10k: breakEven,
      suggestedPer10k: suggested,
      suggestedPer1k: suggested / 10,
      worstWindowLoss,
      avgPnlAtSuggested: avgPnl,
      winRate: windowPnls.length > 0 ? winCount / windowPnls.length : 0,
    });
  }

  return results;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ATTICUS LOW-FLOOR PREMIUM BACKTEST");
  console.log("  SL Tiers: " + SL_TIERS.map(s => s + "%").join(", "));
  console.log("  Tenor: " + TENOR_DAYS + " days | Notional: $" + NOTIONAL.toLocaleString());
  console.log("  Profitability margin: " + (PROFITABILITY_MARGIN * 100) + "%");
  console.log("  " + new Date().toISOString());
  console.log("═══════════════════════════════════════════════════════════════\n");

  const allPeriodResults: { period: string; results: TierResult[] }[] = [];

  for (const period of PERIODS) {
    console.log(`\n▸ Fetching: ${period.name} (${period.start} → ${period.end})...`);
    try {
      const prices = await fetchBtcPrices(period.start, period.end);
      console.log(`  ${prices.length} daily prices loaded (${prices[0]?.date} → ${prices[prices.length - 1]?.date})`);

      const results = runBacktest(prices, period.name);
      allPeriodResults.push({ period: period.name, results });

      console.log(`\n  ┌─────┬────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────┐`);
      console.log(`  │ SL% │ Trigger Rt │ Hedge/10k    │ Break-Ev/10k │ Suggest/10k  │ Suggest/1k   │ Win Rate │`);
      console.log(`  ├─────┼────────────┼──────────────┼──────────────┼──────────────┼──────────────┼──────────┤`);
      for (const r of results) {
        console.log(
          `  │ ${String(r.slPct).padStart(2)}% │ ` +
          `${(r.triggerRate * 100).toFixed(1).padStart(7)}%   │ ` +
          `$${r.avgHedgeCostPer10k.toFixed(2).padStart(10)} │ ` +
          `$${r.breakEvenPer10k.toFixed(2).padStart(10)} │ ` +
          `$${r.suggestedPer10k.toFixed(2).padStart(10)} │ ` +
          `$${r.suggestedPer1k.toFixed(2).padStart(10)} │ ` +
          `${(r.winRate * 100).toFixed(0).padStart(5)}%  │`
        );
      }
      console.log(`  └─────┴────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────┘`);
    } catch (err: any) {
      console.error(`  ERROR: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  // ─── Cross-period summary ──────────────────────────────────────────
  console.log("\n\n═══════════════════════════════════════════════════════════════");
  console.log("  CROSS-PERIOD SUMMARY (Average across all periods)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  for (const sl of SL_TIERS) {
    const tierResults = allPeriodResults.map(p => p.results.find(r => r.slPct === sl)!).filter(Boolean);
    if (!tierResults.length) continue;

    const avgTriggerRate = tierResults.reduce((s, r) => s + r.triggerRate, 0) / tierResults.length;
    const avgHedge = tierResults.reduce((s, r) => s + r.avgHedgeCostPer10k, 0) / tierResults.length;
    const avgBreakEven = tierResults.reduce((s, r) => s + r.breakEvenPer10k, 0) / tierResults.length;
    const maxBreakEven = Math.max(...tierResults.map(r => r.breakEvenPer10k));
    const avgSuggested = tierResults.reduce((s, r) => s + r.suggestedPer10k, 0) / tierResults.length;
    const maxSuggested = Math.max(...tierResults.map(r => r.suggestedPer10k));
    const avgWinRate = tierResults.reduce((s, r) => s + r.winRate, 0) / tierResults.length;
    const worstLoss = Math.max(...tierResults.map(r => r.worstWindowLoss));

    console.log(`  ${sl}% Stop Loss:`);
    console.log(`    Avg trigger rate:    ${(avgTriggerRate * 100).toFixed(1)}%`);
    console.log(`    Avg hedge cost/10k:  $${avgHedge.toFixed(2)}`);
    console.log(`    Avg break-even/10k:  $${avgBreakEven.toFixed(2)}`);
    console.log(`    Max break-even/10k:  $${maxBreakEven.toFixed(2)} (worst period)`);
    console.log(`    Avg suggested/10k:   $${avgSuggested.toFixed(2)} ($${(avgSuggested / 10).toFixed(2)}/1k)`);
    console.log(`    Max suggested/10k:   $${maxSuggested.toFixed(2)} ($${(maxSuggested / 10).toFixed(2)}/1k)`);
    console.log(`    Avg win rate:        ${(avgWinRate * 100).toFixed(0)}%`);
    console.log(`    Worst single window: $${worstLoss.toFixed(2)} loss`);
    console.log();
  }

  // ─── Final recommendation ─────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  RECOMMENDED FIXED PREMIUMS (conservative: worst-period-safe)");
  console.log("═══════════════════════════════════════════════════════════════\n");
  console.log("  ┌─────┬──────────────┬──────────────┬──────────────────────────────┐");
  console.log("  │ SL% │ Per $10k     │ Per $1k      │ Notes                        │");
  console.log("  ├─────┼──────────────┼──────────────┼──────────────────────────────┤");

  for (const sl of SL_TIERS) {
    const tierResults = allPeriodResults.map(p => p.results.find(r => r.slPct === sl)!).filter(Boolean);
    if (!tierResults.length) continue;
    const maxSuggested = Math.max(...tierResults.map(r => r.suggestedPer10k));
    const rounded10k = Math.ceil(maxSuggested / 5) * 5;
    const rounded1k = rounded10k / 10;
    const avgTrigger = tierResults.reduce((s, r) => s + r.triggerRate, 0) / tierResults.length;
    const note = avgTrigger > 0.4 ? "HIGH trigger rate" : avgTrigger > 0.2 ? "Moderate triggers" : "Low triggers";
    console.log(
      `  │ ${String(sl).padStart(2)}% │ ` +
      `$${String(rounded10k).padStart(10)} │ ` +
      `$${rounded1k.toFixed(2).padStart(10)} │ ` +
      `${note.padEnd(28)} │`
    );
  }
  console.log("  └─────┴──────────────┴──────────────┴──────────────────────────────┘\n");
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
