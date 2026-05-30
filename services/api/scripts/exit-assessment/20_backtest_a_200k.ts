/**
 * Backtest A: $200k @ 5% single-side cover.
 *
 * Compares 3 hedge structures across 4 regime tiers:
 *   1. Put SPREAD (long ATM put + short trigger put) — V2 with margin
 *   2. Deep-ITM put (long $80k put = $1k above spot) — V1 no margin
 *   3. ATM put (long $79k put = spot) — comparison baseline
 *
 * Pricing model: FIXED daily premium per regime tier.
 *   Calm:     $300/day
 *   Moderate: $400/day
 *   Elevated: $550/day
 *   Stress:   $750/day (only relevant if any stress days exist)
 *
 * Assumes upfront billing (Foxify pre-funds working balance, daily debits).
 * 14-day tenor.
 *
 * READ ONLY.
 */

import {
  loadHistoricalData,
  bsPut,
  walkForward,
  sampleHoldDays,
  summarize,
  summarizeByRegime,
  classifyRegime,
  type Regime,
  RFR
} from "./19_backtest_engine";

const POSITION = 200_000;
const TRIGGER = 0.05;
const PAYOUT = 10_000;
const TENOR_DAYS = 14;

const REGIME_PRICES: Record<Regime, number> = {
  calm: 300,
  moderate: 400,
  elevated: 550,
  stress: 750
};

type HedgeStructure = "put_spread_1.3x" | "put_spread_1.0x" | "deep_itm_put" | "atm_put";

type CoverResult = {
  date: string;
  regime: Regime;
  structure: HedgeStructure;
  entrySpot: number;
  hedgeCost: number;
  premium: number;
  daysHeld: number;
  triggered: boolean;
  triggerDay: number | null;
  spotAtClose: number;
  hedgeSale: number;
  payout: number;
  atticusNet: number;
};

const buildHedge = (
  structure: HedgeStructure,
  entrySpot: number,
  vol: number,
  tenorDays: number
): { hedgeCost: number; longStrike: number; shortStrike: number | null; btcNotional: number } => {
  const T = tenorDays / 365;
  const triggerStrike = Math.round(entrySpot * (1 - TRIGGER) / 1000) * 1000;
  const baseBtc = POSITION / entrySpot;

  if (structure === "put_spread_1.3x" || structure === "put_spread_1.0x") {
    const overHedge = structure === "put_spread_1.3x" ? 1.3 : 1.0;
    const longStrike = Math.round(entrySpot / 1000) * 1000;
    const shortStrike = triggerStrike;
    const longLeg = bsPut(entrySpot, longStrike, T, RFR, vol);
    const shortLeg = bsPut(entrySpot, shortStrike, T, RFR, vol);
    const btcNotional = baseBtc * overHedge;
    const hedgeCost = (longLeg - shortLeg) * btcNotional;
    return { hedgeCost, longStrike, shortStrike, btcNotional };
  }

  if (structure === "deep_itm_put") {
    // Buy put $1k above spot (slightly ITM)
    const longStrike = Math.round(entrySpot / 1000) * 1000 + 1000;
    const longLeg = bsPut(entrySpot, longStrike, T, RFR, vol);
    return { hedgeCost: longLeg * baseBtc, longStrike, shortStrike: null, btcNotional: baseBtc };
  }

  // atm_put
  const longStrike = Math.round(entrySpot / 1000) * 1000;
  const longLeg = bsPut(entrySpot, longStrike, T, RFR, vol);
  return { hedgeCost: longLeg * baseBtc, longStrike, shortStrike: null, btcNotional: baseBtc };
};

const sellHedge = (
  structure: HedgeStructure,
  spotAtClose: number,
  longStrike: number,
  shortStrike: number | null,
  btcNotional: number,
  remainingDays: number,
  vol: number
): number => {
  const T = Math.max(0, remainingDays / 365);
  const longSale = bsPut(spotAtClose, longStrike, T, RFR, vol);
  if (shortStrike !== null) {
    const shortBuyback = bsPut(spotAtClose, shortStrike, T, RFR, vol);
    return (longSale - shortBuyback) * btcNotional;
  }
  return longSale * btcNotional;
};

const runBacktest = async (
  structure: HedgeStructure,
  holdMeanDays: number = 5
): Promise<CoverResult[]> => {
  const { candles, vols, regimes } = await loadHistoricalData();
  const results: CoverResult[] = [];

  for (let i = 30; i < candles.length - TENOR_DAYS; i++) {
    const entryDay = candles[i];
    const entrySpot = entryDay.close;
    const vol = vols[entryDay.date] ?? 0.65;
    const regime = regimes[entryDay.date] ?? "moderate";
    const dailyRate = REGIME_PRICES[regime];
    const triggerLow = entrySpot * (1 - TRIGGER);

    // Build hedge
    const { hedgeCost, longStrike, shortStrike, btcNotional } = buildHedge(structure, entrySpot, vol, TENOR_DAYS);

    // Sample hold days
    const heldDays = sampleHoldDays(holdMeanDays, TENOR_DAYS);

    // Walk forward, detect trigger
    const walk = walkForward(candles, i, heldDays, triggerLow, null);

    // Sell hedge at close
    const remaining = TENOR_DAYS - walk.daysHeld;
    const hedgeSale = sellHedge(structure, walk.spotAtClose, longStrike, shortStrike, btcNotional, remaining, vol);

    // Premium = upfront for full tenor (Foxify pays for tenor regardless of close)
    const premium = dailyRate * TENOR_DAYS;
    const payout = walk.triggered ? PAYOUT : 0;
    const atticusNet = premium - hedgeCost + hedgeSale - payout;

    results.push({
      date: entryDay.date,
      regime,
      structure,
      entrySpot,
      hedgeCost,
      premium,
      daysHeld: walk.daysHeld,
      triggered: walk.triggered,
      triggerDay: walk.triggerDay,
      spotAtClose: walk.spotAtClose,
      hedgeSale,
      payout,
      atticusNet
    });
  }

  return results;
};

const main = async () => {
  console.log("# Backtest A — $200k @ 5% Single-Side\n");
  console.log(`Position: $${POSITION}, Trigger: ±${TRIGGER * 100}%, Payout: $${PAYOUT}`);
  console.log(`Tenor: ${TENOR_DAYS} days, Premium: regime-tiered\n`);

  const structures: HedgeStructure[] = ["put_spread_1.3x", "put_spread_1.0x", "deep_itm_put", "atm_put"];
  const holdPatterns = [
    { name: "scalp (2.5d)", mean: 2.5 },
    { name: "mixed (5d)", mean: 5 },
    { name: "hold (10d)", mean: 10 }
  ];

  const ITER = 5;

  console.log("=".repeat(160));
  console.log("RESULTS — by structure × hold pattern");
  console.log("=".repeat(160));
  console.log("Structure              | Hold        | TotalCovers | AvgPnL  | MedianPnL | WorstPnL | BestPnL | %Profitable | TrigRate | TotalAtticusPnL");
  console.log("-".repeat(160));

  for (const structure of structures) {
    for (const hp of holdPatterns) {
      const all: CoverResult[] = [];
      for (let i = 0; i < ITER; i++) {
        const r = await runBacktest(structure, hp.mean);
        all.push(...r);
      }
      const pnls = all.map(r => r.atticusNet);
      const s = summarize(pnls);
      const triggers = all.filter(r => r.triggered).length / all.length;
      console.log(
        `${structure.padEnd(22)} | ${hp.name.padEnd(11)} | ${s.count.toString().padStart(11)} | $${s.avg.toFixed(0).padStart(6)} | $${s.median.toFixed(0).padStart(8)} | $${s.worst.toFixed(0).padStart(7)} | $${s.best.toFixed(0).padStart(6)} | ${(s.pctProfitable * 100).toFixed(0).padStart(10)}% | ${(triggers * 100).toFixed(1).padStart(7)}% | $${s.totalPnL.toFixed(0).padStart(10)}`
      );
    }
    console.log("");
  }

  // Per-regime breakdown for the recommended structure (deep_itm_put for V1, put_spread_1.3x for V2)
  console.log("\n" + "=".repeat(160));
  console.log("PER-REGIME BREAKDOWN — Deep-ITM Put (V1, no margin) at scalp pattern");
  console.log("=".repeat(160));
  {
    const all: CoverResult[] = [];
    for (let i = 0; i < ITER; i++) {
      const r = await runBacktest("deep_itm_put", 5);
      all.push(...r);
    }
    const byRegime = summarizeByRegime(all.map(r => ({ regime: r.regime, pnl: r.atticusNet })));
    console.log("Regime       | Cnt   | $/day | AvgPnL | MedianPnL | WorstPnL | BestPnL | %Profit | TotalPnL");
    console.log("-".repeat(110));
    for (const [regime, s] of Object.entries(byRegime)) {
      if (s.count === 0) continue;
      console.log(
        `${regime.padEnd(12)} | ${s.count.toString().padStart(5)} | $${REGIME_PRICES[regime as Regime].toString().padStart(4)} | $${s.avg.toFixed(0).padStart(5)} | $${s.median.toFixed(0).padStart(8)} | $${s.worst.toFixed(0).padStart(7)} | $${s.best.toFixed(0).padStart(6)} | ${(s.pctProfitable * 100).toFixed(0).padStart(6)}% | $${s.totalPnL.toFixed(0).padStart(8)}`
      );
    }
  }

  console.log("\n" + "=".repeat(160));
  console.log("PER-REGIME BREAKDOWN — Put Spread 1.3x (V2 with margin) at scalp pattern");
  console.log("=".repeat(160));
  {
    const all: CoverResult[] = [];
    for (let i = 0; i < ITER; i++) {
      const r = await runBacktest("put_spread_1.3x", 5);
      all.push(...r);
    }
    const byRegime = summarizeByRegime(all.map(r => ({ regime: r.regime, pnl: r.atticusNet })));
    console.log("Regime       | Cnt   | $/day | AvgPnL | MedianPnL | WorstPnL | BestPnL | %Profit | TotalPnL");
    console.log("-".repeat(110));
    for (const [regime, s] of Object.entries(byRegime)) {
      if (s.count === 0) continue;
      console.log(
        `${regime.padEnd(12)} | ${s.count.toString().padStart(5)} | $${REGIME_PRICES[regime as Regime].toString().padStart(4)} | $${s.avg.toFixed(0).padStart(5)} | $${s.median.toFixed(0).padStart(8)} | $${s.worst.toFixed(0).padStart(7)} | $${s.best.toFixed(0).padStart(6)} | ${(s.pctProfitable * 100).toFixed(0).padStart(6)}% | $${s.totalPnL.toFixed(0).padStart(8)}`
      );
    }
  }
};

main().catch(e => { console.error(e); process.exit(1); });
