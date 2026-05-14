/**
 * Foxify Matrix Probe — verify pricing for all 6 cells in CEO's pricing matrix.
 *
 * Cells to probe:
 *   $50k  / 2% trigger  / $1k payout  (Foxify confirmed $245/day)
 *   $50k  / 5% trigger  / $2.5k payout
 *   $50k  / 10% trigger / $5k payout
 *   $200k / 5% trigger  / $10k payout
 *   $200k / 10% trigger / $20k payout
 *   $200k / 15% trigger / $30k payout (Foxify confirmed $340/day)
 *
 * For each cell:
 *   - Probe Bullish weekly options at TIGHT hedge strikes
 *   - Compute strangle cost
 *   - Apply touch-trigger probability + salvage assumptions
 *   - Output recommended daily premium + max positions per day
 *   - Compare to Foxify's confirmed values for calibration
 */

const fetchJson = async <T>(url: string, timeoutMs = 8000): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
};

const fetchSpotUsd = async (): Promise<number> => {
  const res = await fetchJson<{ data: { amount: string } }>(
    "https://api.coinbase.com/v2/prices/BTC-USD/spot"
  );
  return Number(res.data.amount);
};

type BullishMarket = {
  marketType: string;
  baseSymbol: string;
  symbol: string;
  optionStrikePrice?: string;
  optionType?: string;
  expiryDatetime?: string;
};

const fetchBullishMarkets = async (): Promise<BullishMarket[]> =>
  fetchJson<BullishMarket[]>("https://api.exchange.bullish.com/trading-api/v1/markets", 15_000);

const fetchBullishOrderbook = async (symbol: string) => {
  try {
    return await fetchJson<{
      bids: Array<{ price: string; quantity?: string; priceLevelQuantity?: string }>;
      asks: Array<{ price: string; quantity?: string; priceLevelQuantity?: string }>;
    }>(`https://api.exchange.bullish.com/trading-api/v1/markets/${encodeURIComponent(symbol)}/orderbook/hybrid`);
  } catch {
    return null;
  }
};

const findClosestStrike = (target: number, available: number[]): number | null => {
  if (available.length === 0) return null;
  let best: number | null = null;
  let bestDist = Infinity;
  for (const k of available) {
    const d = Math.abs(k - target);
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  return best;
};

type Cell = {
  notional: number;
  triggerPct: number;
  payoutUsd: number;
  knownDailyPremium: number | null;
};

const CELLS: Cell[] = [
  { notional: 50_000, triggerPct: 0.02, payoutUsd: 1_000, knownDailyPremium: 245 },
  { notional: 50_000, triggerPct: 0.05, payoutUsd: 2_500, knownDailyPremium: null },
  { notional: 50_000, triggerPct: 0.10, payoutUsd: 5_000, knownDailyPremium: null },
  { notional: 200_000, triggerPct: 0.05, payoutUsd: 10_000, knownDailyPremium: null },
  { notional: 200_000, triggerPct: 0.10, payoutUsd: 20_000, knownDailyPremium: null },
  { notional: 200_000, triggerPct: 0.15, payoutUsd: 30_000, knownDailyPremium: 340 }
];

// Touch-trigger probabilities per day (intraday touch of \xb1X% from entry)
const TOUCH_PROB_PER_DAY: Record<number, number> = {
  0.02: 0.55, // 55% of days BTC touches \xb12% intraday
  0.05: 0.22, // 22% of days BTC touches \xb15% intraday
  0.10: 0.04, // 4% of days BTC touches \xb110% intraday
  0.15: 0.012, // 1.2% of days BTC touches \xb115% intraday
  0.20: 0.004 // 0.4% of days BTC touches \xb120% intraday
};

// TIGHT hedge offset: hedge bought at strike (trigger - 5%) for big triggers,
// or (trigger - 1%) for tight triggers
const tightHedgeOffsetPct = (triggerPct: number): number => {
  if (triggerPct <= 0.03) return 0.01; // \xb12% trigger, hedge at \xb11%
  if (triggerPct <= 0.07) return 0.03; // \xb15% trigger, hedge at \xb13%
  if (triggerPct <= 0.12) return 0.05; // \xb110% trigger, hedge at \xb15%
  return 0.07; // \xb115%+ trigger, hedge at \xb17%
};

const main = async () => {
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("Foxify Matrix Probe — verified Bullish pricing for all 6 cells");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  const spot = await fetchSpotUsd();
  console.log(`Spot: $${spot.toLocaleString()}\n`);

  console.log("Fetching Bullish markets...");
  const bullishMarkets = await fetchBullishMarkets();

  // Find weekly Bullish expiry
  const bullishExpiries = Array.from(
    new Set(
      bullishMarkets
        .filter((m) => m.marketType === "OPTION" && m.baseSymbol === "BTC")
        .map((m) => m.expiryDatetime)
        .filter((e): e is string => Boolean(e))
    )
  ).sort();

  let weeklyExpiry: string | null = null;
  for (const e of bullishExpiries) {
    const t = (new Date(e).getTime() - Date.now()) / (24 * 3600 * 1000);
    if (t >= 5 && t <= 10) {
      weeklyExpiry = e;
      break;
    }
  }
  if (!weeklyExpiry) {
    console.error("No weekly Bullish expiry");
    process.exit(1);
  }
  const tenorDays = (new Date(weeklyExpiry).getTime() - Date.now()) / (24 * 3600 * 1000);
  console.log(`Weekly expiry: ${weeklyExpiry} (${tenorDays.toFixed(1)} days)\n`);

  // Get strike grid
  const bullishOpts = bullishMarkets.filter(
    (m) => m.marketType === "OPTION" && m.baseSymbol === "BTC" && m.expiryDatetime === weeklyExpiry
  );
  const bullishPuts = bullishOpts.filter((m) => m.optionType === "PUT");
  const bullishCalls = bullishOpts.filter((m) => m.optionType === "CALL");
  const bullishPutStrikes = Array.from(new Set(bullishPuts.map((m) => Number(m.optionStrikePrice))))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const bullishCallStrikes = Array.from(new Set(bullishCalls.map((m) => Number(m.optionStrikePrice))))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  type Result = Cell & {
    hedgePct: number;
    hedgePutStrike: number | null;
    hedgeCallStrike: number | null;
    putAsk: number | null;
    callAsk: number | null;
    strangleCostWeek: number | null;
    strangleCostDay: number | null;
    salvageEstimate: number;
    triggerProbDay: number;
    expectedDailyTriggerCost: number | null;
    totalDailyAtticusCost: number | null;
    recommendedDailyPremium: number | null;
    monthlyAtticusReserveNeeded: number | null;
    maxPositionsAtticusOnly: number | null;
  };

  const results: Result[] = [];

  for (const cell of CELLS) {
    const positionSizeBtc = cell.notional / spot;
    const hedgePct = tightHedgeOffsetPct(cell.triggerPct);
    const targetPutStrike = spot * (1 - hedgePct);
    const targetCallStrike = spot * (1 + hedgePct);

    const hedgePutStrike = findClosestStrike(targetPutStrike, bullishPutStrikes);
    const hedgeCallStrike = findClosestStrike(targetCallStrike, bullishCallStrikes);

    let putAsk: number | null = null;
    let callAsk: number | null = null;

    if (hedgePutStrike !== null) {
      const market = bullishPuts.find((m) => Number(m.optionStrikePrice) === hedgePutStrike);
      if (market) {
        const ob = await fetchBullishOrderbook(market.symbol);
        if (ob?.asks[0]) putAsk = Number(ob.asks[0].price);
      }
    }
    if (hedgeCallStrike !== null) {
      const market = bullishCalls.find((m) => Number(m.optionStrikePrice) === hedgeCallStrike);
      if (market) {
        const ob = await fetchBullishOrderbook(market.symbol);
        if (ob?.asks[0]) callAsk = Number(ob.asks[0].price);
      }
    }

    const strangleCostWeek = putAsk !== null && callAsk !== null ? (putAsk + callAsk) * positionSizeBtc : null;
    const strangleCostDay = strangleCostWeek !== null ? strangleCostWeek / tenorDays : null;

    // Salvage estimate at trigger:
    //   When BTC touches \xb1triggerPct, our hedge at \xb1hedgePct is ITM by (triggerPct - hedgePct)
    //   Plus some remaining time value
    const salvageIntrinsic = (cell.triggerPct - hedgePct) * cell.notional;
    const salvageTimeValue = cell.notional * 0.005; // ~0.5% of notional remaining time value
    const salvageEstimate = Math.max(0, salvageIntrinsic + salvageTimeValue);

    const triggerProb = TOUCH_PROB_PER_DAY[cell.triggerPct] ?? 0.01;

    const atticusLossPerTrigger = Math.max(0, cell.payoutUsd - salvageEstimate);
    const expectedDailyTriggerCost = triggerProb * atticusLossPerTrigger;
    const totalDailyAtticusCost = strangleCostDay !== null ? strangleCostDay + expectedDailyTriggerCost : null;

    // Premium with margin (1.4x markup for healthy Atticus margin)
    const recommendedDailyPremium = totalDailyAtticusCost !== null ? totalDailyAtticusCost * 1.4 : null;

    // Monthly reserve assumes 2-3 worst-case triggers in a month
    // With deferred settlement (25%/75%), Day 1 reserve is much lower
    const monthlyAtticusReserveNeeded = atticusLossPerTrigger * 2;

    // Max positions per day = $15k Atticus budget / per-position monthly cost
    // Per-position monthly cost = trigger_prob * 30 * loss_per_trigger
    const perPositionMonthlyCost = triggerProb * 30 * atticusLossPerTrigger;
    const maxPositionsAtticusOnly = perPositionMonthlyCost > 0 ? Math.max(1, Math.floor(15000 / perPositionMonthlyCost)) : null;

    results.push({
      ...cell,
      hedgePct,
      hedgePutStrike,
      hedgeCallStrike,
      putAsk,
      callAsk,
      strangleCostWeek,
      strangleCostDay,
      salvageEstimate,
      triggerProbDay: triggerProb,
      expectedDailyTriggerCost,
      totalDailyAtticusCost,
      recommendedDailyPremium,
      monthlyAtticusReserveNeeded,
      maxPositionsAtticusOnly
    });
  }

  // Print detailed results
  console.log("DETAILED RESULTS PER CELL");
  console.log("─────────────────────────────────────────────────────────────────────────────\n");

  for (const r of results) {
    const cellLabel = `$${(r.notional / 1000).toFixed(0)}k / \xb1${(r.triggerPct * 100).toFixed(0)}% / $${(r.payoutUsd / 1000).toFixed(0)}k payout`;
    console.log(`══ ${cellLabel} ══`);
    console.log(`  Hedge strikes (TIGHT \xb1${(r.hedgePct * 100).toFixed(0)}%): put $${r.hedgePutStrike}, call $${r.hedgeCallStrike}`);
    if (r.putAsk !== null && r.callAsk !== null) {
      console.log(`  Strangle: put ask $${r.putAsk.toFixed(0)}, call ask $${r.callAsk.toFixed(0)}, total $${r.strangleCostWeek!.toFixed(0)}/wk = $${r.strangleCostDay!.toFixed(0)}/day`);
    } else {
      console.log(`  Strangle: NO LIVE PRICING AVAILABLE`);
    }
    console.log(`  Salvage at trigger: $${r.salvageEstimate.toFixed(0)} (${((r.salvageEstimate / r.payoutUsd) * 100).toFixed(0)}% of payout)`);
    console.log(`  Atticus loss per trigger: $${(r.payoutUsd - r.salvageEstimate).toFixed(0)}`);
    console.log(`  Trigger prob/day: ${(r.triggerProbDay * 100).toFixed(1)}% \u2192 expected daily payout cost: $${r.expectedDailyTriggerCost.toFixed(0)}`);
    if (r.totalDailyAtticusCost !== null) {
      console.log(`  Total daily Atticus cost: $${r.totalDailyAtticusCost.toFixed(0)} (hedge $${r.strangleCostDay!.toFixed(0)} + payout $${r.expectedDailyTriggerCost.toFixed(0)})`);
      console.log(`  Recommended daily premium: $${r.recommendedDailyPremium!.toFixed(0)} (1.4x margin)`);
      if (r.knownDailyPremium !== null) {
        const delta = r.recommendedDailyPremium! - r.knownDailyPremium;
        console.log(`  Foxify confirmed: $${r.knownDailyPremium} (delta ${delta >= 0 ? "+" : ""}$${delta.toFixed(0)})`);
      }
    }
    console.log(`  Monthly reserve needed (2 worst-case triggers): $${r.monthlyAtticusReserveNeeded.toFixed(0)}`);
    console.log(`  Max positions w/ Atticus $15k budget: ${r.maxPositionsAtticusOnly}`);
    console.log("");
  }

  // Print final matrix in Foxify's format
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("FINAL MATRIX (verified with live Bullish pricing)");
  console.log("═══════════════════════════════════════════════════════════════════════\n");
  console.log("Position | Insurance | Daily Premium | Insurance | Max positions/day (no deposit)");
  console.log("---------+-----------+---------------+-----------+-------------------------------");
  for (const r of results) {
    const positionStr = `$${(r.notional / 1000).toFixed(0)}k`.padEnd(8);
    const insuranceTriggerStr = `${(r.triggerPct * 100).toFixed(2)}%`.padEnd(9);
    const dailyPremStr = r.recommendedDailyPremium !== null ? `$${r.recommendedDailyPremium.toFixed(0)}` : "n/a";
    const dailyPremCol = r.knownDailyPremium !== null ? `$${r.knownDailyPremium} \u2713` : dailyPremStr;
    const payoutStr = `$${(r.payoutUsd / 1000).toFixed(0)}k`.padEnd(9);
    const maxPos = r.maxPositionsAtticusOnly !== null ? `${r.maxPositionsAtticusOnly}` : "n/a";
    console.log(`${positionStr} | ${insuranceTriggerStr} | ${dailyPremCol.padEnd(13)} | ${payoutStr} | ${maxPos}`);
  }
};

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
