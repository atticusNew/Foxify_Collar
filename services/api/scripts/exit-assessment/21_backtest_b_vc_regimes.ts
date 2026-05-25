/**
 * Backtest B: Volume Cover matrix across DVOL regimes.
 *
 * Tests whether current Volume Cover prices ($350/$200/$100/$800/$400/$370 per day)
 * remain profitable across calm/moderate/elevated/stress regimes.
 *
 * Uses TIGHT strangle hedge structure (current Volume Cover spec).
 *
 * READ ONLY.
 */

import {
  loadHistoricalData,
  bsPut,
  bsCall,
  walkForward,
  sampleHoldDays,
  summarize,
  classifyRegime,
  type Regime,
  RFR
} from "./19_backtest_engine";

type Cell = {
  cellId: string;
  notionalUsdc: number;
  triggerPct: number;
  payoutUsdc: number;
  hedgePct: number;
  dailyPremium: number;
};

const CELLS: Cell[] = [
  { cellId: "50k_2pct_1k", notionalUsdc: 50_000, triggerPct: 0.02, payoutUsdc: 1_000, hedgePct: 0.01, dailyPremium: 350 },
  { cellId: "50k_5pct_2.5k", notionalUsdc: 50_000, triggerPct: 0.05, payoutUsdc: 2_500, hedgePct: 0.03, dailyPremium: 200 },
  { cellId: "50k_10pct_5k", notionalUsdc: 50_000, triggerPct: 0.10, payoutUsdc: 5_000, hedgePct: 0.05, dailyPremium: 100 },
  { cellId: "200k_5pct_10k", notionalUsdc: 200_000, triggerPct: 0.05, payoutUsdc: 10_000, hedgePct: 0.03, dailyPremium: 800 },
  { cellId: "200k_10pct_20k", notionalUsdc: 200_000, triggerPct: 0.10, payoutUsdc: 20_000, hedgePct: 0.05, dailyPremium: 400 },
  { cellId: "200k_15pct_30k", notionalUsdc: 200_000, triggerPct: 0.15, payoutUsdc: 30_000, hedgePct: 0.07, dailyPremium: 370 }
];

const TENOR_DAYS = 14;

const main = async () => {
  console.log("# Backtest B — Volume Cover Matrix Across Regimes\n");
  const { candles, vols, regimes } = await loadHistoricalData();

  console.log(`Vol regime distribution in 16-month BTC data:`);
  const regimeCounts: Record<Regime, number> = { calm: 0, moderate: 0, elevated: 0, stress: 0 };
  for (const r of Object.values(regimes)) regimeCounts[r]++;
  const totalDays = Object.values(regimeCounts).reduce((s, c) => s + c, 0);
  for (const [k, v] of Object.entries(regimeCounts)) {
    console.log(`  ${k}: ${v} days (${(v / totalDays * 100).toFixed(0)}%)`);
  }
  console.log("");

  for (const cell of CELLS) {
    console.log("=".repeat(140));
    console.log(`CELL: ${cell.cellId} — pair $${cell.notionalUsdc} per leg, ±${cell.triggerPct * 100}% trigger, $${cell.payoutUsdc} payout, $${cell.dailyPremium}/day`);
    console.log("=".repeat(140));

    const resultsByRegime: Record<Regime, number[]> = { calm: [], moderate: [], elevated: [], stress: [] };
    let totalCovers = 0;

    for (let i = 30; i < candles.length - TENOR_DAYS; i++) {
      const entryDay = candles[i];
      const entrySpot = entryDay.close;
      const vol = vols[entryDay.date] ?? 0.65;
      const regime = regimes[entryDay.date] ?? "moderate";
      const T = TENOR_DAYS / 365;
      const btcNotional = (cell.notionalUsdc / entrySpot);

      // TIGHT strangle: long ATM put + long ATM call (1.0x notional each leg)
      // Strikes inside trigger boundary
      const longPutStrike = Math.round(entrySpot * (1 - cell.hedgePct) / 1000) * 1000;
      const longCallStrike = Math.round(entrySpot * (1 + cell.hedgePct) / 1000) * 1000;
      const triggerLow = entrySpot * (1 - cell.triggerPct);
      const triggerHigh = entrySpot * (1 + cell.triggerPct);

      const putCost = bsPut(entrySpot, longPutStrike, T, RFR, vol);
      const callCost = bsCall(entrySpot, longCallStrike, T, RFR, vol);
      const hedgeCost = (putCost + callCost) * btcNotional;

      // Sample hold (cap at tenor)
      const heldDays = sampleHoldDays(7, TENOR_DAYS); // assume 7d avg hold for VC pairs

      // Walk forward, detect trigger
      const walk = walkForward(candles, i, heldDays, triggerLow, triggerHigh);

      // Sell hedge at close
      const remaining = TENOR_DAYS - walk.daysHeld;
      const remainingT = Math.max(0, remaining / 365);
      const putSale = bsPut(walk.spotAtClose, longPutStrike, remainingT, RFR, vol);
      const callSale = bsCall(walk.spotAtClose, longCallStrike, remainingT, RFR, vol);
      const hedgeSale = (putSale + callSale) * btcNotional;

      // Premium: collected daily
      const premium = cell.dailyPremium * walk.daysHeld;
      const payout = walk.triggered ? cell.payoutUsdc : 0;
      const atticusNet = premium - hedgeCost + hedgeSale - payout;

      resultsByRegime[regime].push(atticusNet);
      totalCovers++;
    }

    console.log(`Total covers simulated: ${totalCovers}\n`);
    console.log("Regime       | Count | AvgPnL  | MedianPnL | WorstPnL | BestPnL | %Profit");
    console.log("-".repeat(80));
    for (const [regime, pnls] of Object.entries(resultsByRegime)) {
      if (pnls.length === 0) continue;
      const s = summarize(pnls);
      console.log(
        `${regime.padEnd(12)} | ${s.count.toString().padStart(5)} | $${s.avg.toFixed(0).padStart(6)} | $${s.median.toFixed(0).padStart(8)} | $${s.worst.toFixed(0).padStart(7)} | $${s.best.toFixed(0).padStart(6)} | ${(s.pctProfitable * 100).toFixed(0).padStart(6)}%`
      );
    }
    console.log("");
  }

  // Recommendation analysis
  console.log("\n" + "=".repeat(140));
  console.log("REGIME-PRICING RECOMMENDATION");
  console.log("=".repeat(140));
  console.log("If avg PnL per cover in a regime is NEGATIVE, the cell needs price uplift in that regime.");
  console.log("If avg PnL is positive but small (<$50), the cell may need stress-pause logic.\n");
};

main().catch(e => { console.error(e); process.exit(1); });
