/**
 * Salvage-Band Stress Test — validates pricing/capacity sensitivity to salvage assumption.
 *
 * Premise: this week's pricing & capacity numbers ($350 for $50k/±2%, ~100 positions/day)
 * depend critically on the assumed hedge salvage rate (~95% of payout amount on touch).
 *
 * This script runs the touch-trigger backtest across three salvage assumptions:
 *   - Conservative: 70% salvage (worst credible)
 *   - Base case:    85% salvage (middle)
 *   - Aggressive:   95% salvage (current model assumption)
 *
 * For each assumption, two outputs:
 *   (A) FIXED premium (current matrix) → shows Atticus P&L sensitivity
 *   (B) BREAK-EVEN premium → shows what we'd need to charge to clear margin
 *
 * Output is a single CEO-facing summary table per cell.
 */

type Cell = {
  name: string;
  notional: number;
  triggerPct: number;
  payoutUsd: number;
  hedgePct: number;
  dailyPremium: number;
  strangleCostPerDay: number;
};

// Verified pricing from live Bullish probe (revised matrix)
const CELLS: Cell[] = [
  { name: "$50k/2%/$1k",     notional: 50_000,  triggerPct: 0.02, payoutUsd: 1_000,  hedgePct: 0.01, dailyPremium: 280, strangleCostPerDay: 227 },
  { name: "$50k/5%/$3k",     notional: 50_000,  triggerPct: 0.05, payoutUsd: 2_500,  hedgePct: 0.03, dailyPremium: 194, strangleCostPerDay: 127 },
  { name: "$50k/10%/$5k",    notional: 50_000,  triggerPct: 0.10, payoutUsd: 5_000,  hedgePct: 0.05, dailyPremium: 97,  strangleCostPerDay: 67  },
  { name: "$200k/5%/$10k",   notional: 200_000, triggerPct: 0.05, payoutUsd: 10_000, hedgePct: 0.03, dailyPremium: 774, strangleCostPerDay: 509 },
  { name: "$200k/10%/$20k",  notional: 200_000, triggerPct: 0.10, payoutUsd: 20_000, hedgePct: 0.05, dailyPremium: 390, strangleCostPerDay: 272 },
  { name: "$200k/15%/$30k",  notional: 200_000, triggerPct: 0.15, payoutUsd: 30_000, hedgePct: 0.07, dailyPremium: 363, strangleCostPerDay: 163 }
];

// Salvage scenarios
const SALVAGE_SCENARIOS = [
  { label: "Conservative", singleTouchSalvage: 0.70, doubleTouchBonus: 1.05 },
  { label: "Base",         singleTouchSalvage: 0.85, doubleTouchBonus: 1.15 },
  { label: "Aggressive",   singleTouchSalvage: 0.95, doubleTouchBonus: 1.20 }
];

const N_PERIODS = 10_000;
const DAYS_PER_PERIOD = 28;

const REGIME_FRACTION: Record<"calm" | "normal" | "stress", number> = {
  calm: 0.30, normal: 0.51, stress: 0.19
};
const REGIME_VOL: Record<"calm" | "normal" | "stress", number> = {
  calm: 0.40, normal: 0.65, stress: 1.00
};

type Regime = "calm" | "normal" | "stress";

const sampleRegime = (): Regime => {
  const r = Math.random();
  if (r < REGIME_FRACTION.calm) return "calm";
  if (r < REGIME_FRACTION.calm + REGIME_FRACTION.normal) return "normal";
  return "stress";
};

const sampleNormal = (): number => {
  let u1 = Math.random();
  const u2 = Math.random();
  while (u1 === 0) u1 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

const sampleIntradayMaxMove = (regime: Regime): number => {
  const annualVol = REGIME_VOL[regime];
  const dailyVol = annualVol / Math.sqrt(365);
  const intradayFactor = 1.5;
  const z = Math.abs(sampleNormal());
  return dailyVol * intradayFactor * z;
};

type DayResult = {
  triggered: boolean;
  atticusPnL: number;
};

/**
 * Simulate one day with a given salvage scenario and (optionally) override premium.
 */
const simulateDay = (
  cell: Cell,
  salvageScenario: typeof SALVAGE_SCENARIOS[number],
  premiumOverride?: number
): DayResult => {
  const regime = sampleRegime();
  const intradayMove = sampleIntradayMaxMove(regime);
  const triggered = intradayMove >= cell.triggerPct;

  const premium = premiumOverride ?? cell.dailyPremium;
  let atticusRevenue = premium;
  const atticusHedgeCost = cell.strangleCostPerDay;
  let atticusPayoutCost = 0;

  if (triggered) {
    atticusPayoutCost = cell.payoutUsd;
    const doubleTouchProb = regime === "stress" ? 0.40 : regime === "normal" ? 0.20 : 0.10;
    const isDoubleTouch = Math.random() < doubleTouchProb;
    const salvageFraction = isDoubleTouch
      ? salvageScenario.doubleTouchBonus
      : salvageScenario.singleTouchSalvage;
    const salvage = cell.payoutUsd * salvageFraction;
    atticusRevenue += salvage;
  }

  const atticusPnL = atticusRevenue - atticusHedgeCost - atticusPayoutCost;
  return { triggered, atticusPnL };
};

const simulatePeriod = (
  cell: Cell,
  salvageScenario: typeof SALVAGE_SCENARIOS[number],
  premiumOverride?: number
): { totalPnL: number; triggers: number } => {
  let total = 0;
  let triggers = 0;
  for (let d = 0; d < DAYS_PER_PERIOD; d++) {
    const day = simulateDay(cell, salvageScenario, premiumOverride);
    total += day.atticusPnL;
    if (day.triggered) triggers++;
  }
  return { totalPnL: total, triggers };
};

const percentile = (sorted: number[], p: number): number => {
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
};

const meanStd = (xs: number[]): { mean: number; std: number } => {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const std = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
  return { mean, std };
};

/**
 * Find the daily premium that achieves a target Atticus profit margin under a
 * given salvage scenario. Uses bisection: monotone in premium.
 *
 * Target: mean monthly Atticus P&L ≥ targetMonthlyMarginUsd
 */
const solveBreakEvenPremium = (
  cell: Cell,
  salvageScenario: typeof SALVAGE_SCENARIOS[number],
  targetMonthlyMarginUsd: number,
  searchTrials = 1500
): number => {
  // Quick estimate of premium range: hedge cost to 5x hedge cost
  let lo = cell.strangleCostPerDay * 0.5;
  let hi = cell.strangleCostPerDay * 6 + cell.payoutUsd * 0.3;

  for (let iter = 0; iter < 30; iter++) {
    const mid = (lo + hi) / 2;
    const periods: number[] = [];
    for (let i = 0; i < searchTrials; i++) {
      periods.push(simulatePeriod(cell, salvageScenario, mid).totalPnL);
    }
    const mean = periods.reduce((s, x) => s + x, 0) / periods.length;
    if (mean >= targetMonthlyMarginUsd) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
};

// ────────────────────── Main ──────────────────────

const main = () => {
  console.log("\n═══════════════════════════════════════════════════════════════════════════════");
  console.log("FOXIFY VOLUME COVER — SALVAGE-BAND STRESS TEST");
  console.log("═══════════════════════════════════════════════════════════════════════════════\n");

  console.log(`Backtest: ${N_PERIODS.toLocaleString()} periods × ${DAYS_PER_PERIOD} days`);
  console.log(`Regime mix: 30% calm / 51% normal / 19% stress`);
  console.log(`Salvage scenarios:`);
  for (const s of SALVAGE_SCENARIOS) {
    console.log(`  ${s.label.padEnd(12)} → ${(s.singleTouchSalvage * 100).toFixed(0)}% single-touch / ${(s.doubleTouchBonus * 100).toFixed(0)}% double-touch`);
  }
  console.log("");

  // ───── Part A: Fixed premium (current matrix) ─────
  console.log("═══════════════════════════════════════════════════════════════════════════════");
  console.log("PART A — Atticus monthly P&L at FIXED current premium, across salvage band");
  console.log("═══════════════════════════════════════════════════════════════════════════════\n");

  console.log("Cell                | Premium/day | Salvage     | Mean Atticus P&L | 5%ile (worst) | 95%ile (best) | %profitable");
  console.log("--------------------+-------------+-------------+------------------+---------------+---------------+------------");

  for (const cell of CELLS) {
    for (const scenario of SALVAGE_SCENARIOS) {
      const periods: number[] = [];
      for (let i = 0; i < N_PERIODS; i++) {
        periods.push(simulatePeriod(cell, scenario).totalPnL);
      }
      periods.sort((a, b) => a - b);
      const stats = meanStd(periods);
      const profitablePct = (periods.filter((x) => x > 0).length / periods.length) * 100;
      console.log(
        `${cell.name.padEnd(19)} | $${cell.dailyPremium.toString().padStart(10)} | ${scenario.label.padEnd(11)} | $${stats.mean.toFixed(0).padStart(15)} | $${percentile(periods, 0.05).toFixed(0).padStart(12)} | $${percentile(periods, 0.95).toFixed(0).padStart(12)} | ${profitablePct.toFixed(0).padStart(10)}%`
      );
    }
    console.log("");
  }

  // ───── Part B: Break-even premium per salvage scenario ─────
  console.log("\n═══════════════════════════════════════════════════════════════════════════════");
  console.log("PART B — Break-even premium per cell, per salvage scenario");
  console.log("(Solves for premium that yields ≥10% Atticus margin over hedge cost monthly)");
  console.log("═══════════════════════════════════════════════════════════════════════════════\n");

  // Target monthly Atticus margin: 10% over total monthly hedge cost
  console.log("Cell                | Current $/day | Conservative (70%) | Base (85%)    | Aggressive (95%)");
  console.log("--------------------+---------------+--------------------+---------------+-----------------");

  const breakEvenResults: Record<string, Record<string, number>> = {};
  for (const cell of CELLS) {
    breakEvenResults[cell.name] = {};
    const monthlyHedgeCost = cell.strangleCostPerDay * DAYS_PER_PERIOD;
    const targetMargin = monthlyHedgeCost * 0.10; // 10% margin over hedge cost

    const conservative = solveBreakEvenPremium(cell, SALVAGE_SCENARIOS[0], targetMargin);
    const base = solveBreakEvenPremium(cell, SALVAGE_SCENARIOS[1], targetMargin);
    const aggressive = solveBreakEvenPremium(cell, SALVAGE_SCENARIOS[2], targetMargin);

    breakEvenResults[cell.name].conservative = conservative;
    breakEvenResults[cell.name].base = base;
    breakEvenResults[cell.name].aggressive = aggressive;

    console.log(
      `${cell.name.padEnd(19)} | $${cell.dailyPremium.toString().padStart(12)} | $${conservative.toFixed(0).padStart(17)} | $${base.toFixed(0).padStart(12)} | $${aggressive.toFixed(0).padStart(15)}`
    );
  }

  // ───── Part C: Capacity analysis ─────
  console.log("\n\n═══════════════════════════════════════════════════════════════════════════════");
  console.log("PART C — CAPACITY ANALYSIS ($12k Atticus working capital)");
  console.log("═══════════════════════════════════════════════════════════════════════════════\n");

  console.log("Capacity = max simultaneous open positions where worst-case 1-in-20 monthly loss");
  console.log("           does NOT exceed $12k Atticus working capital cap.");
  console.log("");
  console.log("Cell                | Salvage     | Worst monthly loss/position | Max positions/$12k cap");
  console.log("--------------------+-------------+-----------------------------+-----------------------");

  for (const cell of CELLS) {
    for (const scenario of SALVAGE_SCENARIOS) {
      const periods: number[] = [];
      for (let i = 0; i < N_PERIODS; i++) {
        periods.push(simulatePeriod(cell, scenario).totalPnL);
      }
      periods.sort((a, b) => a - b);
      const worstLoss = -percentile(periods, 0.05); // negative P&L = positive loss
      const maxPositions = worstLoss > 0
        ? Math.floor(12_000 / worstLoss)
        : 999; // unbounded if not loss-prone
      console.log(
        `${cell.name.padEnd(19)} | ${scenario.label.padEnd(11)} | $${worstLoss > 0 ? worstLoss.toFixed(0).padStart(26) : ("(profitable)").padStart(26)} | ${maxPositions === 999 ? "unbounded".padStart(21) : maxPositions.toString().padStart(21)}`
      );
    }
    console.log("");
  }

  // ───── CEO summary ─────
  console.log("\n═══════════════════════════════════════════════════════════════════════════════");
  console.log("CEO SUMMARY — pricing range you can quote with confidence");
  console.log("═══════════════════════════════════════════════════════════════════════════════\n");

  console.log("Each cell shows: [conservative price → base price → aggressive (current) price] /day");
  console.log("");
  console.log("If salvage holds at ≥85% in live conditions, current matrix prices are profitable.");
  console.log("If salvage degrades to 70%, premiums in 'Conservative' column are required.");
  console.log("");
  console.log("Cell                | Conservative | Base   | Aggressive (current) | Current safe?");
  console.log("--------------------+--------------+--------+----------------------+---------------");

  for (const cell of CELLS) {
    const cons = breakEvenResults[cell.name].conservative;
    const base = breakEvenResults[cell.name].base;
    const aggr = breakEvenResults[cell.name].aggressive;
    const currentSafe = cell.dailyPremium >= base ? "YES (≥base)" : cell.dailyPremium >= aggr ? "ONLY if 95%+" : "NO";
    console.log(
      `${cell.name.padEnd(19)} | $${cons.toFixed(0).padStart(11)} | $${base.toFixed(0).padStart(5)} | $${cell.dailyPremium.toString().padStart(19)} | ${currentSafe}`
    );
  }

  console.log("");
  console.log("RULE OF THUMB:");
  console.log("  - Salvage ≥85% → matrix as-is is safe");
  console.log("  - Salvage 70-85% → uplift 2% / 5% cells by ~30%, wider tiers (10%/15%) safer");
  console.log("  - Salvage <70% → product needs structural redesign (TIGHT hedge not delivering)");
};

main();
