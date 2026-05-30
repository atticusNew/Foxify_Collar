/**
 * Backtest D: Volume Cover Take-Profit optimization.
 *
 * Tests current static "hold-until-trigger-or-foxify-close" vs:
 *   - Pre-trigger sell at 80% of trigger distance (TP1)
 *   - Theta-floor early sell when hedge value < 30% of cost (TP2)
 *   - Combined TP1 + TP2
 *
 * Quantifies value-add from each TP rule.
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

type TPMode = "baseline" | "pre_trigger_sell" | "theta_floor" | "combined";

const TENOR_DAYS = 14;

// Use 50k_2pct_1k cell as test case (highest trigger frequency)
const CELL = {
  cellId: "50k_2pct_1k",
  notionalUsdc: 50_000,
  triggerPct: 0.02,
  payoutUsdc: 1_000,
  hedgePct: 0.01,
  dailyPremium: 350
};

const main = async () => {
  console.log("# Backtest D — Volume Cover TP Optimization\n");
  console.log(`Test cell: ${CELL.cellId}, premium $${CELL.dailyPremium}/day, payout $${CELL.payoutUsdc}\n`);

  const { candles, vols, regimes } = await loadHistoricalData();

  for (const tpMode of ["baseline", "pre_trigger_sell", "theta_floor", "combined"] as TPMode[]) {
    const pnls: number[] = [];
    let triggers = 0;
    let preTriggerExits = 0;
    let thetaFloorExits = 0;

    for (let i = 30; i < candles.length - TENOR_DAYS; i++) {
      const entryDay = candles[i];
      const entrySpot = entryDay.close;
      const vol = vols[entryDay.date] ?? 0.65;
      const T = TENOR_DAYS / 365;
      const btcNotional = (CELL.notionalUsdc / entrySpot);

      const longPutStrike = Math.round(entrySpot * (1 - CELL.hedgePct) / 1000) * 1000;
      const longCallStrike = Math.round(entrySpot * (1 + CELL.hedgePct) / 1000) * 1000;
      const triggerLow = entrySpot * (1 - CELL.triggerPct);
      const triggerHigh = entrySpot * (1 + CELL.triggerPct);
      const preTriggerLow = entrySpot * (1 - CELL.triggerPct * 0.8); // 80% of trigger distance = 1.6%
      const preTriggerHigh = entrySpot * (1 + CELL.triggerPct * 0.8);

      const initialHedgeCost = (bsPut(entrySpot, longPutStrike, T, RFR, vol) + bsCall(entrySpot, longCallStrike, T, RFR, vol)) * btcNotional;

      const heldDays = sampleHoldDays(7, TENOR_DAYS);

      // Walk forward day by day, applying TP rules
      let triggered = false;
      let earlyExit = false;
      let exitDay: number | null = null;
      let exitSpot = entrySpot;
      let exitReason: "trigger" | "pre_trigger_sell" | "theta_floor" | "foxify_close" | "expiry" = "expiry";

      for (let d = 1; d <= heldDays; d++) {
        if (i + d >= candles.length) break;
        const day = candles[i + d];

        // Check trigger first (always)
        if (day.low <= triggerLow) {
          triggered = true;
          exitDay = d;
          exitSpot = triggerLow;
          exitReason = "trigger";
          break;
        }
        if (day.high >= triggerHigh) {
          triggered = true;
          exitDay = d;
          exitSpot = triggerHigh;
          exitReason = "trigger";
          break;
        }

        // TP1: pre-trigger sell when BTC at 80% of trigger distance
        if (tpMode === "pre_trigger_sell" || tpMode === "combined") {
          if (day.low <= preTriggerLow) {
            earlyExit = true;
            exitDay = d;
            exitSpot = preTriggerLow;
            exitReason = "pre_trigger_sell";
            preTriggerExits++;
            break;
          }
          if (day.high >= preTriggerHigh) {
            earlyExit = true;
            exitDay = d;
            exitSpot = preTriggerHigh;
            exitReason = "pre_trigger_sell";
            preTriggerExits++;
            break;
          }
        }

        // TP2: theta floor — if hedge value drops below 30% of cost, sell
        if (tpMode === "theta_floor" || tpMode === "combined") {
          if (d >= 3) { // give it at least 3 days
            const remaining = TENOR_DAYS - d;
            const remainingT = remaining / 365;
            const currentHedge = (bsPut(day.close, longPutStrike, remainingT, RFR, vol) + bsCall(day.close, longCallStrike, remainingT, RFR, vol)) * btcNotional;
            if (currentHedge < initialHedgeCost * 0.3) {
              earlyExit = true;
              exitDay = d;
              exitSpot = day.close;
              exitReason = "theta_floor";
              thetaFloorExits++;
              break;
            }
          }
        }

        exitSpot = day.close;
      }

      if (exitDay === null) {
        exitDay = heldDays;
        exitReason = "foxify_close";
      }

      // Sell hedge
      const remaining = TENOR_DAYS - exitDay;
      const remainingT = Math.max(0, remaining / 365);
      const hedgeSale = (bsPut(exitSpot, longPutStrike, remainingT, RFR, vol) + bsCall(exitSpot, longCallStrike, remainingT, RFR, vol)) * btcNotional;

      const premium = CELL.dailyPremium * exitDay;
      const payout = triggered ? CELL.payoutUsdc : 0;
      const atticusNet = premium - initialHedgeCost + hedgeSale - payout;

      pnls.push(atticusNet);
      if (triggered) triggers++;
    }

    const s = summarize(pnls);
    console.log(`TP Mode: ${tpMode}`);
    console.log(`  Total covers:       ${pnls.length}`);
    console.log(`  Avg Atticus PnL:    $${s.avg.toFixed(0)}`);
    console.log(`  Median PnL:         $${s.median.toFixed(0)}`);
    console.log(`  Worst case:         $${s.worst.toFixed(0)}`);
    console.log(`  Best case:          $${s.best.toFixed(0)}`);
    console.log(`  % profitable:       ${(s.pctProfitable * 100).toFixed(0)}%`);
    console.log(`  Trigger rate:       ${(triggers / pnls.length * 100).toFixed(1)}%`);
    if (tpMode !== "baseline") {
      console.log(`  Pre-trigger exits:  ${preTriggerExits}`);
      console.log(`  Theta-floor exits:  ${thetaFloorExits}`);
    }
    console.log("");
  }

  console.log("\nKEY METRIC: Improvement of each TP variant vs BASELINE");
  console.log("Run again with both modes back-to-back to get clean delta.\n");
};

main().catch(e => { console.error(e); process.exit(1); });
