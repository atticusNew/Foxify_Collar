/**
 * Cost-plus pricing backtest.
 *
 * Model: Foxify premium = (live spread debit × over_hedge_factor) × (1 + margin_pct)
 *
 * Question: across 16 months of BTC history, what's the AVG Foxify premium
 * AND avg Atticus margin per cover under this model?
 *
 * Sweeps: margin_pct = 5%, 10%, 15%, 20%; over_hedge = 1.0, 1.2, 1.3, 1.5
 *
 * READ ONLY (uses cached BTC data + BS pricing).
 */

import * as fs from "node:fs/promises";

const SQRT2 = Math.SQRT2;
const nCDF = (x: number): number => {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
};
const bsPut = (S: number, K: number, T: number, r: number, sigma: number): number => {
  if (T <= 0) return Math.max(0, K - S);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return K * Math.exp(-r * T) * nCDF(-d2) - S * nCDF(-d1);
};

type Candle = { timestamp: number; date: string; low: number; high: number; open: number; close: number; volume: number };

type Config = {
  positionNotionalUsd: number;
  triggerPct: number;
  payoutUsd: number;
  hedgeTenorDays: number;
  marginPct: number;
  overHedgeFactor: number;
  holdPatternMeanDays: number;
};

const sampleHoldDays = (mean: number): number => {
  const lambda = 1 / mean;
  const u = Math.random();
  const sample = -Math.log(1 - u) / lambda;
  return Math.max(1, Math.min(14, Math.round(sample)));
};

type Result = {
  date: string;
  vol: number;
  entrySpot: number;
  spreadDebitUsd: number;
  foxifyPremiumUsd: number;
  daysHeld: number;
  triggered: boolean;
  spreadSaleUsd: number;
  payoutUsd: number;
  atticusNetUsd: number;
};

const runBacktest = (
  candles: Candle[],
  vols: Record<string, number>,
  cfg: Config
): Result[] => {
  const results: Result[] = [];
  const r = 0.045;
  for (let i = 30; i < candles.length - cfg.hedgeTenorDays; i++) {
    const entryDay = candles[i];
    const entrySpot = entryDay.close;
    const vol = vols[entryDay.date] ?? 0.65;
    const longStrike = Math.round(entrySpot / 1000) * 1000;
    const shortStrike = Math.round(entrySpot * (1 - cfg.triggerPct) / 1000) * 1000;
    const triggerLow = entrySpot * (1 - cfg.triggerPct);
    const T = cfg.hedgeTenorDays / 365;
    const longPrice = bsPut(entrySpot, longStrike, T, r, vol);
    const shortPrice = bsPut(entrySpot, shortStrike, T, r, vol);
    const baseDebitPerBtc = longPrice - shortPrice;
    const btcNotional = (cfg.positionNotionalUsd / entrySpot) * cfg.overHedgeFactor;
    const spreadDebitUsd = baseDebitPerBtc * btcNotional;
    const foxifyPremiumUsd = spreadDebitUsd * (1 + cfg.marginPct);

    const heldDays = sampleHoldDays(cfg.holdPatternMeanDays);
    let triggered = false;
    let actualHoldDays = heldDays;
    let spotAtClose = entrySpot;
    for (let d = 1; d <= heldDays; d++) {
      if (i + d >= candles.length) break;
      const day = candles[i + d];
      if (day.low <= triggerLow) {
        triggered = true;
        actualHoldDays = d;
        spotAtClose = triggerLow;
        break;
      }
      spotAtClose = day.close;
    }

    const remainingT = Math.max(0, (cfg.hedgeTenorDays - actualHoldDays) / 365);
    const longSale = bsPut(spotAtClose, longStrike, remainingT, r, vol);
    const shortBuyback = bsPut(spotAtClose, shortStrike, remainingT, r, vol);
    const spreadSaleUsd = (longSale - shortBuyback) * btcNotional;
    const payoutUsd = triggered ? cfg.payoutUsd : 0;
    const atticusNetUsd = foxifyPremiumUsd - spreadDebitUsd + spreadSaleUsd - payoutUsd;

    results.push({
      date: entryDay.date,
      vol,
      entrySpot,
      spreadDebitUsd,
      foxifyPremiumUsd,
      daysHeld: actualHoldDays,
      triggered,
      spreadSaleUsd,
      payoutUsd,
      atticusNetUsd
    });
  }
  return results;
};

const summarize = (results: Result[]) => {
  const sorted = results.slice().sort((a, b) => a.atticusNetUsd - b.atticusNetUsd);
  const premiums = results.map(r => r.foxifyPremiumUsd).sort((a, b) => a - b);
  const debits = results.map(r => r.spreadDebitUsd).sort((a, b) => a - b);
  return {
    count: results.length,
    foxifyPremium: {
      avg: premiums.reduce((s, x) => s + x, 0) / premiums.length,
      median: premiums[Math.floor(premiums.length / 2)],
      min: premiums[0],
      max: premiums[premiums.length - 1],
      p10: premiums[Math.floor(premiums.length * 0.1)],
      p90: premiums[Math.floor(premiums.length * 0.9)]
    },
    spreadDebit: {
      avg: debits.reduce((s, x) => s + x, 0) / debits.length,
      median: debits[Math.floor(debits.length / 2)]
    },
    atticus: {
      avgPnL: sorted.reduce((s, r) => s + r.atticusNetUsd, 0) / sorted.length,
      medianPnL: sorted[Math.floor(sorted.length / 2)].atticusNetUsd,
      worstPnL: sorted[0].atticusNetUsd,
      bestPnL: sorted[sorted.length - 1].atticusNetUsd,
      p10PnL: sorted[Math.floor(sorted.length * 0.1)].atticusNetUsd,
      p90PnL: sorted[Math.floor(sorted.length * 0.9)].atticusNetUsd,
      pctProfitable: sorted.filter(r => r.atticusNetUsd > 0).length / sorted.length,
      pctLosing: sorted.filter(r => r.atticusNetUsd < 0).length / sorted.length
    },
    triggerRate: results.filter(r => r.triggered).length / results.length,
    avgHoldDays: results.reduce((s, r) => s + r.daysHeld, 0) / results.length
  };
};

const main = async () => {
  console.log("# Cost-Plus Pricing Backtest");
  console.log(`# Generated: ${new Date().toISOString()}\n`);

  const data = JSON.parse(await fs.readFile("/tmp/btc_daily_ohlc.json", "utf8"));
  const candles: Candle[] = data.candles;
  const vols: Record<string, number> = data.annualVolByDay;
  console.log(`Loaded ${candles.length} candles\n`);

  const baseCfg: Omit<Config, "marginPct" | "overHedgeFactor" | "holdPatternMeanDays"> = {
    positionNotionalUsd: 200_000,
    triggerPct: 0.05,
    payoutUsd: 10_000,
    hedgeTenorDays: 14
  };

  const margins = [0.05, 0.10, 0.15, 0.20];
  const overHedges = [1.0, 1.2, 1.3, 1.5];
  const holdPatterns = [
    { name: "scalp (2.5d avg)", days: 2.5 },
    { name: "mixed (5d avg)", days: 5 },
    { name: "hold (10d avg)", days: 10 }
  ];

  const ITER = 5;

  console.log("=".repeat(150));
  console.log("FULL MATRIX — what Foxify pays + what Atticus makes per cover");
  console.log("=".repeat(150));
  console.log(
    "HoldPattern".padEnd(20),
    "| Margin% | OverHedge | FoxifyAvg | FoxifyMin | FoxifyMax | FoxifyMed | AtticusAvg | AtticusMed | AtticusWorst | AtticusBest | %Profit | TrigRate"
  );
  console.log("-".repeat(150));

  type Row = {
    holdPattern: string;
    marginPct: number;
    overHedge: number;
    summary: ReturnType<typeof summarize>;
  };
  const matrix: Row[] = [];

  for (const hp of holdPatterns) {
    for (const m of margins) {
      for (const oh of overHedges) {
        const all: Result[] = [];
        for (let i = 0; i < ITER; i++) {
          all.push(...runBacktest(candles, vols, {
            ...baseCfg,
            marginPct: m,
            overHedgeFactor: oh,
            holdPatternMeanDays: hp.days
          }));
        }
        const s = summarize(all);
        matrix.push({ holdPattern: hp.name, marginPct: m, overHedge: oh, summary: s });
        console.log(
          `${hp.name.padEnd(20)} | ${(m * 100).toFixed(0).padStart(5)}% | ${oh.toFixed(1)}x      | $${s.foxifyPremium.avg.toFixed(0).padStart(7)} | $${s.foxifyPremium.min.toFixed(0).padStart(7)} | $${s.foxifyPremium.max.toFixed(0).padStart(7)} | $${s.foxifyPremium.median.toFixed(0).padStart(7)} | $${s.atticus.avgPnL.toFixed(0).padStart(8)} | $${s.atticus.medianPnL.toFixed(0).padStart(8)} | $${s.atticus.worstPnL.toFixed(0).padStart(10)} | $${s.atticus.bestPnL.toFixed(0).padStart(9)} | ${(s.atticus.pctProfitable * 100).toFixed(0).padStart(6)}% | ${(s.triggerRate * 100).toFixed(1).padStart(7)}%`
        );
      }
    }
    console.log("");
  }

  // Spotlight: 10% margin (user approved) at various over-hedge
  console.log("\n");
  console.log("=".repeat(150));
  console.log("SPOTLIGHT — 10% margin (your approved baseline)");
  console.log("=".repeat(150));
  for (const hp of holdPatterns) {
    console.log(`\n${hp.name}:`);
    const subset = matrix.filter(r => r.holdPattern === hp.name && r.marginPct === 0.10);
    for (const r of subset) {
      const s = r.summary;
      console.log(
        `  ${r.overHedge}x hedge:`
      );
      console.log(`    Foxify pays:        avg $${s.foxifyPremium.avg.toFixed(0)} (range $${s.foxifyPremium.min.toFixed(0)} - $${s.foxifyPremium.max.toFixed(0)}); median $${s.foxifyPremium.median.toFixed(0)}`);
      console.log(`    Foxify per-day:     ~$${(s.foxifyPremium.avg / 14).toFixed(0)}/day equivalent (over 14 days)`);
      console.log(`    Atticus avg P&L:    $${s.atticus.avgPnL.toFixed(0)}`);
      console.log(`    Atticus median P&L: $${s.atticus.medianPnL.toFixed(0)}`);
      console.log(`    Atticus worst:      $${s.atticus.worstPnL.toFixed(0)}`);
      console.log(`    Atticus best:       $${s.atticus.bestPnL.toFixed(0)}`);
      console.log(`    % profitable:       ${(s.atticus.pctProfitable * 100).toFixed(1)}%`);
      console.log(`    Trigger rate:       ${(s.triggerRate * 100).toFixed(1)}%`);
    }
  }

  // Save
  await fs.writeFile("/tmp/cost_plus_matrix.json", JSON.stringify(matrix, null, 2));
  console.log("\n\nFull matrix saved to /tmp/cost_plus_matrix.json");
};

main().catch(e => { console.error(e); process.exit(1); });
