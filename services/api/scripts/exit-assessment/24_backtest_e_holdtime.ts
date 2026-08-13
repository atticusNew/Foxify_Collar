/**
 * Backtest E: Validate the premium/payout hold-time hypothesis.
 *
 * Hypothesis: Foxify rationally holds longer when payout/premium ratio is favorable.
 * Formula: hold ≈ closeThresholdPct × (payout / dailyPremium)
 *
 * Tests how Atticus economics differ across:
 *   - Premium-aware hold model (using formula above)
 *   - Fixed hold patterns (2.5d / 5d / 10d)
 *
 * Confirms whether the formula better matches deprecated pilot's actual 2-3 day hold
 * for the small-payout product, AND projects new product hold pattern.
 *
 * READ ONLY.
 */

import {
  loadHistoricalData,
  bsPut,
  walkForward,
  sampleHoldDaysPremiumAware,
  summarize,
  RFR
} from "./19_backtest_engine";

const TENOR_DAYS = 14;

// Test products
const PRODUCTS = [
  // Deprecated pilot — known actual hold ≈ 2-3 days
  { name: "Deprecated pilot $10k/2%/$200/$25/day", position: 10_000, trigger: 0.02, payout: 200, dailyPremium: 25, hedgePct: 0.01 },
  // Volume Cover cells (low premium/payout = short hold)
  { name: "VC $50k/2%/$1k/$350/day", position: 50_000, trigger: 0.02, payout: 1_000, dailyPremium: 350, hedgePct: 0.01 },
  { name: "VC $200k/15%/$30k/$370/day", position: 200_000, trigger: 0.15, payout: 30_000, dailyPremium: 370, hedgePct: 0.07 },
  // New $200k/5% product
  { name: "New $200k/5%/$10k/$400/day", position: 200_000, trigger: 0.05, payout: 10_000, dailyPremium: 400, hedgePct: 0.05 }
];

const main = async () => {
  console.log("# Backtest E — Premium/Payout Hold-Time Hypothesis Validation\n");
  console.log("Hypothesis: Foxify holds for ~closeThreshold × (payout/dailyPremium) days\n");

  for (const p of PRODUCTS) {
    const breakEvenDays = p.payout / p.dailyPremium;
    console.log("=".repeat(120));
    console.log(`PRODUCT: ${p.name}`);
    console.log(`  Break-even hold day (premium = payout): ${breakEvenDays.toFixed(1)} days`);
    console.log(`  Tenor cap: ${TENOR_DAYS} days`);

    // Sample many hold days using the formula and report distribution
    const SAMPLES = 1000;
    for (const closeThreshold of [0.30, 0.40, 0.50]) {
      const holds: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        holds.push(sampleHoldDaysPremiumAware(p.dailyPremium, p.payout, TENOR_DAYS, closeThreshold));
      }
      const sorted = holds.slice().sort((a, b) => a - b);
      const avg = holds.reduce((s, x) => s + x, 0) / holds.length;
      const median = sorted[Math.floor(sorted.length / 2)];
      console.log(`  Threshold ${(closeThreshold * 100).toFixed(0)}% of break-even: avg hold = ${avg.toFixed(1)}d, median ${median}d`);
    }
    console.log("");
  }

  console.log("\n=== Comparison: Atticus economics under fixed-hold vs premium-aware-hold ===\n");

  const { candles, vols } = await loadHistoricalData();

  for (const p of PRODUCTS) {
    if (p.position === 200_000 && p.trigger === 0.05) {
      // For the new product, use put spread structure
      console.log("=".repeat(120));
      console.log(`PRODUCT: ${p.name} — using deep-ITM put hedge (V1)`);
      console.log("=".repeat(120));

      const ITER = 5;
      const holdScenarios = [
        { name: "Premium-aware (40% threshold)", premiumAware: true, threshold: 0.40 },
        { name: "Premium-aware (30% threshold)", premiumAware: true, threshold: 0.30 },
        { name: "Fixed 2.5d hold", premiumAware: false, fixed: 2.5 },
        { name: "Fixed 5d hold", premiumAware: false, fixed: 5 },
        { name: "Fixed 10d hold", premiumAware: false, fixed: 10 }
      ];

      for (const scenario of holdScenarios) {
        const pnls: number[] = [];
        let triggers = 0;
        let totalDays = 0;

        for (let it = 0; it < ITER; it++) {
          for (let i = 30; i < candles.length - TENOR_DAYS; i++) {
            const entryDay = candles[i];
            const entrySpot = entryDay.close;
            const vol = vols[entryDay.date] ?? 0.65;
            const T = TENOR_DAYS / 365;
            const btcNotional = (p.position / entrySpot);

            // Deep-ITM put structure: strike = spot + $1k (slightly ITM)
            const longStrike = Math.round(entrySpot / 1000) * 1000 + 1000;
            const triggerLow = entrySpot * (1 - p.trigger);
            const hedgeCost = bsPut(entrySpot, longStrike, T, RFR, vol) * btcNotional;

            const heldDays = (scenario as any).premiumAware
              ? sampleHoldDaysPremiumAware(p.dailyPremium, p.payout, TENOR_DAYS, (scenario as any).threshold)
              : Math.max(1, Math.min(TENOR_DAYS, Math.round((scenario as any).fixed + (Math.random() - 0.5) * 2)));

            const walk = walkForward(candles, i, heldDays, triggerLow, null);

            const remaining = TENOR_DAYS - walk.daysHeld;
            const remainingT = Math.max(0, remaining / 365);
            const hedgeSale = bsPut(walk.spotAtClose, longStrike, remainingT, RFR, vol) * btcNotional;

            const premium = p.dailyPremium * walk.daysHeld;
            const payout = walk.triggered ? p.payout : 0;
            const atticusNet = premium - hedgeCost + hedgeSale - payout;

            pnls.push(atticusNet);
            if (walk.triggered) triggers++;
            totalDays += walk.daysHeld;
          }
        }

        const s = summarize(pnls);
        console.log(`  ${scenario.name}:`);
        console.log(`    Avg hold: ${(totalDays / pnls.length).toFixed(1)} days, Trigger rate: ${(triggers / pnls.length * 100).toFixed(1)}%`);
        console.log(`    Avg PnL: $${s.avg.toFixed(0)}, Median: $${s.median.toFixed(0)}, Worst: $${s.worst.toFixed(0)}, Best: $${s.best.toFixed(0)}, %Profit: ${(s.pctProfitable * 100).toFixed(0)}%`);
      }
      console.log("");
    }
  }
};

main().catch(e => { console.error(e); process.exit(1); });
