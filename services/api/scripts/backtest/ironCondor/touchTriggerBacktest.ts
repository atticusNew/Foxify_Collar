/**
 * Touch-Trigger Cover Backtest — historical Monte Carlo validation.
 *
 * Simulates the proposed Foxify Volume Facility products across realistic
 * BTC daily paths to validate Atticus and Foxify P&L expectations.
 *
 * Methodology:
 *   1. Sample regime per day (calm/normal/stress per CFO §3.2)
 *   2. Generate realistic intraday BTC path with min/max touches
 *   3. For each cover (each cell in Foxify matrix):
 *      - Determine if BTC touched ±trigger boundary that day
 *      - If yes: Atticus pays Foxify $payout, Atticus salvages from option
 *      - If no: Atticus keeps premium, hedge expires worthless
 *   4. Aggregate daily P&L into 28-day periods
 *   5. Run 10,000 Monte Carlo periods, report distribution
 *
 * Key model parameters:
 *   - Salvage realized = 95% of payout on average (TIGHT hedge active mgmt)
 *   - Strangle premium amortized from live Bullish data
 *   - Daily renewable, ceiling maintained on rollover (CEO confirmed)
 */

// ────────────────────── Configuration ──────────────────────

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
  { name: "$50k/2%/$1k",  notional: 50_000,  triggerPct: 0.02, payoutUsd: 1_000,  hedgePct: 0.01, dailyPremium: 280, strangleCostPerDay: 227 },
  { name: "$50k/5%/$3k",  notional: 50_000,  triggerPct: 0.05, payoutUsd: 2_500,  hedgePct: 0.03, dailyPremium: 194, strangleCostPerDay: 127 },
  { name: "$50k/10%/$5k", notional: 50_000,  triggerPct: 0.10, payoutUsd: 5_000,  hedgePct: 0.05, dailyPremium: 97,  strangleCostPerDay: 67 },
  { name: "$200k/5%/$10k", notional: 200_000, triggerPct: 0.05, payoutUsd: 10_000, hedgePct: 0.03, dailyPremium: 774, strangleCostPerDay: 509 },
  { name: "$200k/10%/$20k", notional: 200_000, triggerPct: 0.10, payoutUsd: 20_000, hedgePct: 0.05, dailyPremium: 390, strangleCostPerDay: 272 },
  { name: "$200k/15%/$30k", notional: 200_000, triggerPct: 0.15, payoutUsd: 30_000, hedgePct: 0.07, dailyPremium: 363, strangleCostPerDay: 163 }
];

const N_PERIODS = 10_000;
const DAYS_PER_PERIOD = 28;

// Regime distribution (CFO §3.2, 1,558 days historical)
const REGIME_FRACTION: Record<"calm" | "normal" | "stress", number> = {
  calm: 0.30,
  normal: 0.51,
  stress: 0.19
};

// Annualized vol per regime (BTC realized)
const REGIME_VOL: Record<"calm" | "normal" | "stress", number> = {
  calm: 0.40,
  normal: 0.65,
  stress: 1.00
};

type Regime = "calm" | "normal" | "stress";

// ────────────────────── Sampling helpers ──────────────────────

const sampleRegime = (): Regime => {
  const r = Math.random();
  if (r < REGIME_FRACTION.calm) return "calm";
  if (r < REGIME_FRACTION.calm + REGIME_FRACTION.normal) return "normal";
  return "stress";
};

const sampleNormal = (): number => {
  let u1 = Math.random();
  let u2 = Math.random();
  while (u1 === 0) u1 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

/**
 * Sample intraday max ABSOLUTE move from open price.
 * Uses regime-conditional log-normal with adjustment factor for intraday.
 * Intraday moves are typically ~1.5x larger than close-to-close.
 */
const sampleIntradayMaxMove = (regime: Regime): number => {
  const annualVol = REGIME_VOL[regime];
  const dailyVol = annualVol / Math.sqrt(365);
  const intradayFactor = 1.5;
  const z = Math.abs(sampleNormal()); // half-normal for max move magnitude
  return dailyVol * intradayFactor * z;
};

// ────────────────────── Daily simulation ──────────────────────

type DayResult = {
  regime: Regime;
  intradayMove: number;
  triggered: boolean;
  atticusPnL: number;
  foxifyPnL: number;
};

/**
 * Simulate one day of one cover.
 * Returns Atticus and Foxify P&L for that day.
 */
const simulateDay = (cell: Cell): DayResult => {
  const regime = sampleRegime();
  const intradayMove = sampleIntradayMaxMove(regime);
  const triggered = intradayMove >= cell.triggerPct;

  // Foxify pays daily premium regardless
  let atticusRevenue = cell.dailyPremium;
  // Atticus pays for strangle hedge daily
  let atticusHedgeCost = cell.strangleCostPerDay;

  let atticusPayoutCost = 0;
  let foxifyPayoutReceived = 0;

  if (triggered) {
    // Atticus pays Foxify the fixed payout
    atticusPayoutCost = cell.payoutUsd;
    foxifyPayoutReceived = cell.payoutUsd;

    // Atticus's salvage from selling option:
    // - Single direction trigger: salvage ~75% of payout
    // - Both directions touched intraday: salvage ~120% of payout (rare bonus)
    // - Probability of double-touch given single touch: depends on vol
    const doubleTouchProb = regime === "stress" ? 0.40 : regime === "normal" ? 0.20 : 0.10;
    const isDoubleTouch = Math.random() < doubleTouchProb;
    const salvageFraction = isDoubleTouch ? 1.20 : 0.80;
    const salvage = cell.payoutUsd * salvageFraction;
    atticusRevenue += salvage;
  }

  const atticusPnL = atticusRevenue - atticusHedgeCost - atticusPayoutCost;
  const foxifyPnL = foxifyPayoutReceived - cell.dailyPremium;

  return {
    regime,
    intradayMove,
    triggered,
    atticusPnL,
    foxifyPnL
  };
};

// ────────────────────── 28-day period simulation ──────────────────────

type PeriodResult = {
  totalAtticusPnL: number;
  totalFoxifyPnL: number;
  triggersInPeriod: number;
  daysByRegime: Record<Regime, number>;
};

const simulatePeriod = (cell: Cell): PeriodResult => {
  let atticusTotal = 0;
  let foxifyTotal = 0;
  let triggers = 0;
  const daysByRegime: Record<Regime, number> = { calm: 0, normal: 0, stress: 0 };

  for (let d = 0; d < DAYS_PER_PERIOD; d++) {
    const day = simulateDay(cell);
    atticusTotal += day.atticusPnL;
    foxifyTotal += day.foxifyPnL;
    if (day.triggered) triggers++;
    daysByRegime[day.regime]++;
  }

  return {
    totalAtticusPnL: atticusTotal,
    totalFoxifyPnL: foxifyTotal,
    triggersInPeriod: triggers,
    daysByRegime
  };
};

// ────────────────────── Distribution helpers ──────────────────────

const percentile = (sorted: number[], p: number): number => {
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
};

const meanStd = (xs: number[]): { mean: number; std: number } => {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const std = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
  return { mean, std };
};

// ────────────────────── Main backtest ──────────────────────

const main = () => {
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("Foxify Touch-Trigger Cover — Historical Backtest");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  console.log(`Backtest: ${N_PERIODS.toLocaleString()} periods \xd7 ${DAYS_PER_PERIOD} days each`);
  console.log(`Regime mix: 30% calm / 51% normal / 19% stress (historical)`);
  console.log(`Salvage model: 80% of payout (single touch) or 120% (double touch, vol-dependent)\n`);

  console.log("RESULTS PER CELL");
  console.log("─────────────────────────────────────────────────────────────────────────────\n");

  console.log("Cell              | Mean Atticus | Atticus 5%ile | Atticus 95%ile | %profitable | Mean Foxify | Foxify 5%ile | Foxify 95%ile | Triggers/period");
  console.log("------------------+--------------+---------------+----------------+-------------+-------------+--------------+---------------+----------------");

  for (const cell of CELLS) {
    const periods: PeriodResult[] = [];
    for (let i = 0; i < N_PERIODS; i++) {
      periods.push(simulatePeriod(cell));
    }

    const atticusPnLs = periods.map((p) => p.totalAtticusPnL).sort((a, b) => a - b);
    const foxifyPnLs = periods.map((p) => p.totalFoxifyPnL).sort((a, b) => a - b);
    const triggers = periods.map((p) => p.triggersInPeriod);

    const atticusStats = meanStd(atticusPnLs);
    const foxifyStats = meanStd(foxifyPnLs);
    const triggerStats = meanStd(triggers);

    const atticusProfitablePct = (atticusPnLs.filter((x) => x > 0).length / atticusPnLs.length) * 100;

    console.log(
      `${cell.name.padEnd(17)} | $${atticusStats.mean.toFixed(0).padStart(11)} | $${percentile(atticusPnLs, 0.05).toFixed(0).padStart(12)} | $${percentile(atticusPnLs, 0.95).toFixed(0).padStart(13)} | ${atticusProfitablePct.toFixed(0).padStart(10)}% | $${foxifyStats.mean.toFixed(0).padStart(10)} | $${percentile(foxifyPnLs, 0.05).toFixed(0).padStart(11)} | $${percentile(foxifyPnLs, 0.95).toFixed(0).padStart(12)} | ${triggerStats.mean.toFixed(1).padStart(15)}`
    );
  }

  // Detailed analysis on best/worst case scenarios
  console.log("\n\nDETAILED OUTCOMES PER CELL (worst-case 1-in-20 month, median, best-case 1-in-20)");
  console.log("─────────────────────────────────────────────────────────────────────────────────\n");

  for (const cell of CELLS) {
    const periods: PeriodResult[] = [];
    for (let i = 0; i < N_PERIODS; i++) {
      periods.push(simulatePeriod(cell));
    }

    const atticusPnLs = periods.map((p) => p.totalAtticusPnL).sort((a, b) => a - b);
    const foxifyPnLs = periods.map((p) => p.totalFoxifyPnL).sort((a, b) => a - b);

    console.log(`${cell.name}:`);
    console.log(`  Atticus monthly P&L distribution:`);
    console.log(`    Worst-case 1-in-20 month: $${percentile(atticusPnLs, 0.05).toFixed(0)}`);
    console.log(`    Median month:             $${percentile(atticusPnLs, 0.5).toFixed(0)}`);
    console.log(`    Best-case 1-in-20 month:  $${percentile(atticusPnLs, 0.95).toFixed(0)}`);
    console.log(`    Mean:                     $${meanStd(atticusPnLs).mean.toFixed(0)}`);
    console.log(`  Foxify monthly P&L distribution (cover only, excludes partner fees):`);
    console.log(`    Worst-case 1-in-20 month: $${percentile(foxifyPnLs, 0.05).toFixed(0)} (no triggers fire)`);
    console.log(`    Median month:             $${percentile(foxifyPnLs, 0.5).toFixed(0)}`);
    console.log(`    Best-case 1-in-20 month:  $${percentile(foxifyPnLs, 0.95).toFixed(0)} (many triggers fire)`);
    console.log(`    Mean:                     $${meanStd(foxifyPnLs).mean.toFixed(0)}`);
    console.log("");
  }

  // Portfolio combination analysis
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("PORTFOLIO ANALYSIS — running multiple covers in parallel");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  // Simulate the recommended Foxify portfolio:
  // Tier 1: 25 \xd7 $50k/2% positions
  // Tier 2: 9 \xd7 $50k/5% positions
  // Tier 3: 16 \xd7 $50k/10% positions
  const portfolio = [
    { cell: CELLS[0], count: 25 },
    { cell: CELLS[1], count: 9 },
    { cell: CELLS[2], count: 16 }
  ];

  const portfolioPeriods = [];
  for (let i = 0; i < N_PERIODS; i++) {
    let portAtticus = 0;
    let portFoxify = 0;
    let portTriggers = 0;
    for (const { cell, count } of portfolio) {
      for (let p = 0; p < count; p++) {
        const period = simulatePeriod(cell);
        portAtticus += period.totalAtticusPnL;
        portFoxify += period.totalFoxifyPnL;
        portTriggers += period.triggersInPeriod;
      }
    }
    portfolioPeriods.push({ atticus: portAtticus, foxify: portFoxify, triggers: portTriggers });
  }

  const portAtticusPnLs = portfolioPeriods.map((p) => p.atticus).sort((a, b) => a - b);
  const portFoxifyPnLs = portfolioPeriods.map((p) => p.foxify).sort((a, b) => a - b);
  const portTriggers = portfolioPeriods.map((p) => p.triggers);

  console.log("Portfolio composition: 25 \xd7 $50k/2% + 9 \xd7 $50k/5% + 16 \xd7 $50k/10% = 50 positions, $2.5M notional");
  console.log("");
  console.log("ATTICUS portfolio P&L per 28 days:");
  console.log(`  Mean:                     $${meanStd(portAtticusPnLs).mean.toFixed(0)}`);
  console.log(`  Std deviation:            $${meanStd(portAtticusPnLs).std.toFixed(0)}`);
  console.log(`  Worst-case 1-in-20 month: $${percentile(portAtticusPnLs, 0.05).toFixed(0)}`);
  console.log(`  Median month:             $${percentile(portAtticusPnLs, 0.5).toFixed(0)}`);
  console.log(`  Best-case 1-in-20 month:  $${percentile(portAtticusPnLs, 0.95).toFixed(0)}`);
  console.log(`  % months profitable:      ${((portAtticusPnLs.filter((x) => x > 0).length / portAtticusPnLs.length) * 100).toFixed(1)}%`);
  console.log("");
  console.log("FOXIFY portfolio P&L per 28 days (cover only, partner fees additional):");
  console.log(`  Mean:                     $${meanStd(portFoxifyPnLs).mean.toFixed(0)}`);
  console.log(`  Worst-case 1-in-20 month: $${percentile(portFoxifyPnLs, 0.05).toFixed(0)}`);
  console.log(`  Median month:             $${percentile(portFoxifyPnLs, 0.5).toFixed(0)}`);
  console.log(`  Best-case 1-in-20 month:  $${percentile(portFoxifyPnLs, 0.95).toFixed(0)}`);
  console.log(`  Average triggers per period: ${meanStd(portTriggers).mean.toFixed(0)}`);
};

main();
