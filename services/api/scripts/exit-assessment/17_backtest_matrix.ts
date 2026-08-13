/**
 * Historical backtest of $200k @ 5% put-spread cover with Option B mechanics.
 *
 * Methodology:
 *   For each day in BTC history:
 *     1. Open a cover at day's close. Compute spread debit using BS at current vol.
 *     2. Simulate Foxify hold time (1-7 days based on configured pattern).
 *     3. Walk forward day-by-day. Detect trigger (BTC touches 5% below entry).
 *     4. Compute outcome:
 *        - If trigger before hold ends: pay $10k payout, sell spread at full value.
 *        - If hold ends before trigger: sell spread at residual value.
 *     5. Accumulate Atticus P&L.
 *
 * Sweeps:
 *   - daily_rate: $400, $500, $530, $600, $650
 *   - over_hedge: 1.0, 1.2, 1.3, 1.5
 *   - hold_pattern: scalp(2.5d) / mixed(5d) / hold(10d)
 *
 * READ ONLY (uses cached BTC data + BS pricing).
 */

import * as fs from "node:fs/promises";

// Black-Scholes
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

type BacktestConfig = {
  positionNotionalUsd: number;
  triggerPct: number;
  payoutUsd: number;
  hedgeTenorDays: number;
  spreadShortStrikeOffsetPct: number;
  dailyRateUsd: number;
  overHedgeFactor: number;
  holdPatternMeanDays: number;
  triggerProbabilityFloorPct: number;
};

type CoverResult = {
  date: string;
  entrySpot: number;
  triggerLow: number;
  longStrike: number;
  shortStrike: number;
  spreadDebitUsd: number;
  daysHeld: number;
  triggered: boolean;
  triggerDay: number | null;
  spotAtClose: number;
  spreadSaleUsd: number;
  premiumCollectedUsd: number;
  payoutUsd: number;
  atticusNetUsd: number;
  vol: number;
};

const sampleHoldDays = (mean: number): number => {
  // Truncated geometric: probability of close on day N = exponential decay
  // Mean of exponential = 1/lambda → lambda = 1/mean
  const lambda = 1 / mean;
  const u = Math.random();
  const sample = -Math.log(1 - u) / lambda;
  return Math.max(1, Math.min(14, Math.round(sample)));
};

const runBacktest = (
  candles: Candle[],
  vols: Record<string, number>,
  config: BacktestConfig
): CoverResult[] => {
  const results: CoverResult[] = [];
  const r = 0.045; // risk-free rate

  for (let i = 30; i < candles.length - config.hedgeTenorDays; i++) {
    const entryDay = candles[i];
    const entrySpot = entryDay.close;
    const vol = vols[entryDay.date] ?? 0.65;

    // Compute strikes: long at ATM (= entry), short at trigger pct below
    const longStrike = Math.round(entrySpot / 1000) * 1000;
    const shortStrike = Math.round(entrySpot * (1 - config.triggerPct) / 1000) * 1000;
    const triggerLow = entrySpot * (1 - config.triggerPct);

    // Compute spread debit at day 0
    const T = config.hedgeTenorDays / 365;
    const longLegPrice = bsPut(entrySpot, longStrike, T, r, vol);
    const shortLegPrice = bsPut(entrySpot, shortStrike, T, r, vol);
    const spreadDebitPerBtc = longLegPrice - shortLegPrice;
    const btcNotional = (config.positionNotionalUsd / entrySpot) * config.overHedgeFactor;
    const spreadDebitUsd = spreadDebitPerBtc * btcNotional;

    // Sample hold days
    const plannedHoldDays = sampleHoldDays(config.holdPatternMeanDays);

    // Walk forward
    let triggered = false;
    let triggerDay: number | null = null;
    let actualHoldDays = plannedHoldDays;
    let spotAtClose = entrySpot;

    for (let d = 1; d <= plannedHoldDays; d++) {
      if (i + d >= candles.length) break;
      const day = candles[i + d];
      // Trigger if intraday low touches trigger
      if (day.low <= triggerLow) {
        triggered = true;
        triggerDay = d;
        actualHoldDays = d;
        spotAtClose = triggerLow; // assume execution exactly at trigger
        break;
      }
      spotAtClose = day.close;
    }

    // Compute spread sale value at close
    const remainingTenorDays = config.hedgeTenorDays - actualHoldDays;
    const remainingT = Math.max(0, remainingTenorDays / 365);
    const longLegSale = bsPut(spotAtClose, longStrike, remainingT, r, vol);
    const shortLegBuyback = bsPut(spotAtClose, shortStrike, remainingT, r, vol);
    const spreadSalePerBtc = longLegSale - shortLegBuyback;
    const spreadSaleUsd = spreadSalePerBtc * btcNotional;

    // Premium collected
    const premiumCollectedUsd = config.dailyRateUsd * actualHoldDays;

    // Payout (only if triggered)
    const payoutUsd = triggered ? config.payoutUsd : 0;

    // Atticus net
    const atticusNetUsd = premiumCollectedUsd - spreadDebitUsd + spreadSaleUsd - payoutUsd;

    results.push({
      date: entryDay.date,
      entrySpot,
      triggerLow,
      longStrike,
      shortStrike,
      spreadDebitUsd,
      daysHeld: actualHoldDays,
      triggered,
      triggerDay,
      spotAtClose,
      spreadSaleUsd,
      premiumCollectedUsd,
      payoutUsd,
      atticusNetUsd,
      vol
    });
  }

  return results;
};

const summarize = (results: CoverResult[]): {
  count: number;
  avgPnL: number;
  medianPnL: number;
  worstPnL: number;
  bestPnL: number;
  triggerRate: number;
  avgHoldDays: number;
  pctProfitable: number;
  pctLosing: number;
} => {
  const pnls = results.map(r => r.atticusNetUsd).sort((a, b) => a - b);
  const triggered = results.filter(r => r.triggered).length;
  return {
    count: results.length,
    avgPnL: pnls.reduce((s, x) => s + x, 0) / pnls.length,
    medianPnL: pnls[Math.floor(pnls.length / 2)],
    worstPnL: pnls[0],
    bestPnL: pnls[pnls.length - 1],
    triggerRate: triggered / results.length,
    avgHoldDays: results.reduce((s, r) => s + r.daysHeld, 0) / results.length,
    pctProfitable: pnls.filter(p => p > 0).length / pnls.length,
    pctLosing: pnls.filter(p => p < 0).length / pnls.length
  };
};

const main = async () => {
  console.log("# $200k @ 5% Backtest Matrix\n");

  const data = JSON.parse(await fs.readFile("/tmp/btc_daily_ohlc.json", "utf8"));
  const candles: Candle[] = data.candles;
  const vols: Record<string, number> = data.annualVolByDay;
  console.log(`Loaded ${candles.length} candles, ${Object.keys(vols).length} vol-days\n`);

  const baseConfig: Omit<BacktestConfig, "dailyRateUsd" | "overHedgeFactor" | "holdPatternMeanDays"> = {
    positionNotionalUsd: 200_000,
    triggerPct: 0.05,
    payoutUsd: 10_000,
    hedgeTenorDays: 14,
    spreadShortStrikeOffsetPct: 0.05,
    triggerProbabilityFloorPct: 0
  };

  const dailyRates = [400, 500, 530, 600, 650];
  const overHedges = [1.0, 1.2, 1.3, 1.5];
  const holdPatterns: Array<{ name: string; meanDays: number }> = [
    { name: "ultra-scalp (1.5d avg)", meanDays: 1.5 },
    { name: "scalp (2.5d avg)", meanDays: 2.5 },
    { name: "mixed (5d avg)", meanDays: 5 },
    { name: "hold (10d avg)", meanDays: 10 }
  ];

  // Set seed for reproducibility (kind of — Math.random isn't seedable; we run many iterations to average out)
  const ITER = 5; // run each combo 5 times and average

  const matrix: any[] = [];

  for (const holdP of holdPatterns) {
    for (const dailyRate of dailyRates) {
      for (const overHedge of overHedges) {
        const aggregateResults: CoverResult[] = [];
        for (let it = 0; it < ITER; it++) {
          const r = runBacktest(candles, vols, {
            ...baseConfig,
            dailyRateUsd: dailyRate,
            overHedgeFactor: overHedge,
            holdPatternMeanDays: holdP.meanDays
          });
          aggregateResults.push(...r);
        }
        const stats = summarize(aggregateResults);
        matrix.push({
          holdPattern: holdP.name,
          meanHoldDays: holdP.meanDays,
          dailyRateUsd: dailyRate,
          overHedge,
          ...stats
        });
      }
    }
  }

  // Print matrix
  console.log("\n## Full matrix\n");
  console.log("HoldPattern             | $/day | OverHedge | AvgPnL  | MedianPnL | WorstPnL | BestPnL | TrigRate | %Profit | %Loss");
  console.log("------------------------|-------|-----------|---------|-----------|----------|---------|----------|---------|------");
  for (const r of matrix) {
    console.log(
      `${r.holdPattern.padEnd(23)} | $${r.dailyRateUsd.toString().padStart(4)} | ${r.overHedge.toFixed(1)}x      | $${r.avgPnL.toFixed(0).padStart(6)} | $${r.medianPnL.toFixed(0).padStart(8)} | $${r.worstPnL.toFixed(0).padStart(7)} | $${r.bestPnL.toFixed(0).padStart(6)} | ${(r.triggerRate * 100).toFixed(1).padStart(7)}% | ${(r.pctProfitable * 100).toFixed(0).padStart(6)}% | ${(r.pctLosing * 100).toFixed(0).padStart(4)}%`
    );
  }

  // Highlights: find best EV per hold pattern
  console.log("\n\n## Best config per hold pattern (max avg P&L with worst-case >= 0)\n");
  for (const holdP of holdPatterns) {
    const subset = matrix.filter(m => m.holdPattern === holdP.name);
    const safeOnly = subset.filter(m => m.worstPnL >= 0);
    const best = safeOnly.length > 0
      ? safeOnly.reduce((a, b) => a.avgPnL > b.avgPnL ? a : b)
      : subset.reduce((a, b) => a.avgPnL > b.avgPnL ? a : b);
    const bestSafeNote = safeOnly.length > 0 ? "(SAFE: never loses)" : "(no fully-safe config; showing best EV)";
    console.log(
      `  ${holdP.name.padEnd(25)}  →  $${best.dailyRateUsd}/day, ${best.overHedge}x hedge: avg=$${best.avgPnL.toFixed(0)}, worst=$${best.worstPnL.toFixed(0)} ${bestSafeNote}`
    );
  }

  // Save full matrix to JSON
  await fs.writeFile("/tmp/backtest_matrix.json", JSON.stringify(matrix, null, 2));
  console.log("\nFull matrix saved to /tmp/backtest_matrix.json");

  // Filter to user's preferred config: $530/day with 1.3x over-hedge
  console.log("\n\n## Spotlight: User's preferred config ($530/day, 1.3x over-hedge)\n");
  const userPick = matrix.filter(m => m.dailyRateUsd === 530 && m.overHedge === 1.3);
  for (const r of userPick) {
    console.log(`  ${r.holdPattern}:`);
    console.log(`    Avg P&L:        $${r.avgPnL.toFixed(0)} per cover`);
    console.log(`    Median P&L:     $${r.medianPnL.toFixed(0)}`);
    console.log(`    Worst case:     $${r.worstPnL.toFixed(0)}`);
    console.log(`    Best case:      $${r.bestPnL.toFixed(0)}`);
    console.log(`    Trigger rate:   ${(r.triggerRate * 100).toFixed(1)}%`);
    console.log(`    % profitable:   ${(r.pctProfitable * 100).toFixed(0)}%`);
  }
};

main().catch(e => { console.error(e); process.exit(1); });
