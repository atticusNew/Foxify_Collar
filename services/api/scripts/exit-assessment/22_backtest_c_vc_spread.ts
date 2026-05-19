/**
 * Backtest C: Volume Cover refactored to Iron Condor (defined-risk strangle spread).
 *
 * Compares current TIGHT strangle vs Iron Condor structure across same matrix.
 * Iron condor = long ATM put + short OTM put + long ATM call + short OTM call.
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
  console.log("# Backtest C — Volume Cover Iron Condor refactor\n");
  const { candles, vols, regimes } = await loadHistoricalData();

  console.log("Per-cell comparison: TIGHT strangle (current) vs Iron Condor (defined-risk spread)\n");

  for (const cell of CELLS) {
    console.log("=".repeat(140));
    console.log(`CELL: ${cell.cellId}`);
    console.log("=".repeat(140));

    const tightResults: Record<Regime, number[]> = { calm: [], moderate: [], elevated: [], stress: [] };
    const condorResults: Record<Regime, number[]> = { calm: [], moderate: [], elevated: [], stress: [] };

    for (let i = 30; i < candles.length - TENOR_DAYS; i++) {
      const entryDay = candles[i];
      const entrySpot = entryDay.close;
      const vol = vols[entryDay.date] ?? 0.65;
      const regime = regimes[entryDay.date] ?? "moderate";
      const T = TENOR_DAYS / 365;
      const btcNotional = (cell.notionalUsdc / entrySpot);

      // TIGHT strangle: long put + long call inside trigger
      const longPutStrike = Math.round(entrySpot * (1 - cell.hedgePct) / 1000) * 1000;
      const longCallStrike = Math.round(entrySpot * (1 + cell.hedgePct) / 1000) * 1000;
      const triggerLow = entrySpot * (1 - cell.triggerPct);
      const triggerHigh = entrySpot * (1 + cell.triggerPct);
      const tightCost = (bsPut(entrySpot, longPutStrike, T, RFR, vol) + bsCall(entrySpot, longCallStrike, T, RFR, vol)) * btcNotional;

      // Iron Condor: long ATM put + short trigger put + long ATM call + short trigger call
      // Strikes: long inside, short at trigger
      const condorLongPut = longPutStrike; // same as TIGHT long put
      const condorShortPut = Math.round(entrySpot * (1 - cell.triggerPct) / 1000) * 1000;
      const condorLongCall = longCallStrike; // same as TIGHT long call
      const condorShortCall = Math.round(entrySpot * (1 + cell.triggerPct) / 1000) * 1000;

      const longPutPx = bsPut(entrySpot, condorLongPut, T, RFR, vol);
      const shortPutPx = bsPut(entrySpot, condorShortPut, T, RFR, vol);
      const longCallPx = bsCall(entrySpot, condorLongCall, T, RFR, vol);
      const shortCallPx = bsCall(entrySpot, condorShortCall, T, RFR, vol);
      const condorCost = (longPutPx - shortPutPx + longCallPx - shortCallPx) * btcNotional;

      // Sample hold
      const heldDays = sampleHoldDays(7, TENOR_DAYS);

      const walk = walkForward(candles, i, heldDays, triggerLow, triggerHigh);

      // Sell hedges at close
      const remaining = TENOR_DAYS - walk.daysHeld;
      const remainingT = Math.max(0, remaining / 365);

      const tightSale = (bsPut(walk.spotAtClose, longPutStrike, remainingT, RFR, vol) + bsCall(walk.spotAtClose, longCallStrike, remainingT, RFR, vol)) * btcNotional;
      const condorSale = (
        bsPut(walk.spotAtClose, condorLongPut, remainingT, RFR, vol) -
        bsPut(walk.spotAtClose, condorShortPut, remainingT, RFR, vol) +
        bsCall(walk.spotAtClose, condorLongCall, remainingT, RFR, vol) -
        bsCall(walk.spotAtClose, condorShortCall, remainingT, RFR, vol)
      ) * btcNotional;

      const premium = cell.dailyPremium * walk.daysHeld;
      const payout = walk.triggered ? cell.payoutUsdc : 0;

      const tightPnL = premium - tightCost + tightSale - payout;
      const condorPnL = premium - condorCost + condorSale - payout;

      tightResults[regime].push(tightPnL);
      condorResults[regime].push(condorPnL);
    }

    console.log("Regime       | TIGHT Avg | TIGHT %Profit | CONDOR Avg | CONDOR %Profit | Improvement");
    console.log("-".repeat(90));
    for (const regime of ["calm", "moderate", "elevated"] as Regime[]) {
      const t = tightResults[regime];
      const c = condorResults[regime];
      if (t.length === 0) continue;
      const ts = summarize(t);
      const cs = summarize(c);
      const imp = cs.avg - ts.avg;
      console.log(
        `${regime.padEnd(12)} | $${ts.avg.toFixed(0).padStart(7)} | ${(ts.pctProfitable * 100).toFixed(0).padStart(12)}% | $${cs.avg.toFixed(0).padStart(7)} | ${(cs.pctProfitable * 100).toFixed(0).padStart(13)}% | ${imp > 0 ? "+" : ""}$${imp.toFixed(0)} per cover`
      );
    }
    console.log("");
  }
};

main().catch(e => { console.error(e); process.exit(1); });
