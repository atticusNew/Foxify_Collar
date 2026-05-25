/**
 * Foxify Touch-Trigger Matrix — Revised with dual-direction salvage model.
 *
 * Insight from CEO conversation:
 *   - Atticus's TIGHT hedge has strikes INSIDE the cover trigger band
 *   - When cover triggers, Atticus's option is already ITM
 *   - On volatile days, Atticus can salvage from BOTH sides of the strangle
 *   - Average salvage \u2248 full payout amount (single-trigger structure)
 *
 * Implication: Atticus's effective per-trigger cost is near zero
 *              Premium just needs to cover strangle premium + margin
 *
 * Tests all 6 cells in Foxify's matrix with corrected pricing.
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
  hedgePct: number;       // TIGHT hedge offset (must be < triggerPct)
  marginMultiplier: number; // 1.10 = 10% margin, 1.40 = 40% margin
};

// Touch-trigger probabilities per day
const TOUCH_PROB_PER_DAY: Record<number, number> = {
  0.02: 0.55,
  0.05: 0.22,
  0.10: 0.04,
  0.15: 0.012,
  0.20: 0.004
};

// Average salvage as fraction of payout (with TIGHT hedge + active management)
//   Calibrated: avg salvage \u2248 full payout amount in active mgmt
const SALVAGE_FRACTION_OF_PAYOUT = 0.95;

const CELLS: Cell[] = [
  { notional: 50_000, triggerPct: 0.02, payoutUsd: 1_000, hedgePct: 0.01, marginMultiplier: 1.10 },
  { notional: 50_000, triggerPct: 0.05, payoutUsd: 2_500, hedgePct: 0.03, marginMultiplier: 1.25 },
  { notional: 50_000, triggerPct: 0.10, payoutUsd: 5_000, hedgePct: 0.05, marginMultiplier: 1.25 },
  { notional: 200_000, triggerPct: 0.05, payoutUsd: 10_000, hedgePct: 0.03, marginMultiplier: 1.25 },
  { notional: 200_000, triggerPct: 0.10, payoutUsd: 20_000, hedgePct: 0.05, marginMultiplier: 1.25 },
  { notional: 200_000, triggerPct: 0.15, payoutUsd: 30_000, hedgePct: 0.07, marginMultiplier: 2.00 } // higher margin for tail
];

const main = async () => {
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("Foxify Matrix — REVISED with dual-direction salvage insight");
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
    console.error("No weekly expiry");
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
    hedgePutStrike: number | null;
    hedgeCallStrike: number | null;
    putAsk: number | null;
    callAsk: number | null;
    strangleCostWeek: number | null;
    strangleCostDay: number | null;
    salvageEstimate: number;
    triggerProb: number;
    expectedPayoutCost: number;
    totalDailyAtticusCost: number | null;
    recommendedDailyPremium: number | null;
    monthly28DayCost: number | null;
    triggersPerMonth: number;
    foxifyMonthlyTriggerIncome: number;
    foxifyMonthlyNet: number | null;
  };

  const results: Result[] = [];

  for (const cell of CELLS) {
    const positionSizeBtc = cell.notional / spot;
    const targetPutStrike = spot * (1 - cell.hedgePct);
    const targetCallStrike = spot * (1 + cell.hedgePct);

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

    const salvageEstimate = cell.payoutUsd * SALVAGE_FRACTION_OF_PAYOUT;
    const triggerProb = TOUCH_PROB_PER_DAY[cell.triggerPct] ?? 0.01;
    const lossPerTrigger = Math.max(0, cell.payoutUsd - salvageEstimate);
    const expectedPayoutCost = triggerProb * lossPerTrigger;
    const totalDailyAtticusCost = strangleCostDay !== null ? strangleCostDay + expectedPayoutCost : null;
    const recommendedDailyPremium = totalDailyAtticusCost !== null
      ? totalDailyAtticusCost * cell.marginMultiplier
      : null;
    const monthly28DayCost = recommendedDailyPremium !== null ? recommendedDailyPremium * 28 : null;
    const triggersPerMonth = triggerProb * 30;
    const foxifyMonthlyTriggerIncome = triggersPerMonth * cell.payoutUsd;
    const foxifyMonthlyNet = monthly28DayCost !== null
      ? foxifyMonthlyTriggerIncome - monthly28DayCost
      : null;

    results.push({
      ...cell,
      hedgePutStrike,
      hedgeCallStrike,
      putAsk,
      callAsk,
      strangleCostWeek,
      strangleCostDay,
      salvageEstimate,
      triggerProb,
      expectedPayoutCost,
      totalDailyAtticusCost,
      recommendedDailyPremium,
      monthly28DayCost,
      triggersPerMonth,
      foxifyMonthlyTriggerIncome,
      foxifyMonthlyNet
    });
  }

  // Print detailed results
  console.log("DETAILED RESULTS PER CELL");
  console.log("─────────────────────────────────────────────────────────────────────────────\n");

  for (const r of results) {
    const cellLabel = `$${(r.notional / 1000).toFixed(0)}k / \xb1${(r.triggerPct * 100).toFixed(0)}% / $${(r.payoutUsd / 1000).toFixed(0)}k payout / TIGHT \xb1${(r.hedgePct * 100).toFixed(0)}%`;
    console.log(`══ ${cellLabel} ══`);
    if (r.putAsk !== null && r.callAsk !== null) {
      console.log(`  Strangle: put $${r.hedgePutStrike} ask $${r.putAsk.toFixed(0)}, call $${r.hedgeCallStrike} ask $${r.callAsk.toFixed(0)}`);
      console.log(`  Strangle cost: $${r.strangleCostWeek!.toFixed(0)}/wk = $${r.strangleCostDay!.toFixed(0)}/day`);
    } else {
      console.log(`  Strangle: NO LIVE PRICING (strikes ${r.hedgePutStrike}/${r.hedgeCallStrike})`);
    }
    console.log(`  Avg salvage at trigger: $${r.salvageEstimate.toFixed(0)} (${(SALVAGE_FRACTION_OF_PAYOUT * 100).toFixed(0)}% of payout)`);
    console.log(`  Atticus loss per trigger (after salvage): $${(r.payoutUsd - r.salvageEstimate).toFixed(0)}`);
    console.log(`  Trigger prob/day: ${(r.triggerProb * 100).toFixed(1)}%, expected daily payout cost: $${r.expectedPayoutCost.toFixed(0)}`);
    if (r.totalDailyAtticusCost !== null) {
      console.log(`  Total Atticus daily cost: $${r.totalDailyAtticusCost.toFixed(0)}`);
      console.log(`  Recommended daily premium (${((r.marginMultiplier - 1) * 100).toFixed(0)}% margin): $${r.recommendedDailyPremium!.toFixed(0)}`);
      console.log(`  28-day Foxify cost: $${r.monthly28DayCost!.toFixed(0)}`);
      console.log(`  Triggers/month: ${r.triggersPerMonth.toFixed(1)}, Foxify monthly trigger income: $${r.foxifyMonthlyTriggerIncome.toFixed(0)}`);
      console.log(`  Foxify monthly net (cover only): ${r.foxifyMonthlyNet! >= 0 ? "+" : ""}$${r.foxifyMonthlyNet!.toFixed(0)}`);
    }
    console.log("");
  }

  // Summary matrix
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("FINAL MATRIX (verified Bullish weekly, with dual-direction salvage)");
  console.log("═══════════════════════════════════════════════════════════════════════\n");
  console.log("Position | Trigger | Payout | Daily Premium | 28-day Foxify | Triggers/mo | Foxify mo. net");
  console.log("---------+---------+--------+---------------+---------------+-------------+----------------");
  for (const r of results) {
    const positionStr = `$${(r.notional / 1000).toFixed(0)}k`.padEnd(8);
    const triggerStr = `${(r.triggerPct * 100).toFixed(2)}%`.padEnd(7);
    const payoutStr = `$${(r.payoutUsd / 1000).toFixed(0)}k`.padEnd(6);
    const premiumStr = r.recommendedDailyPremium !== null ? `$${r.recommendedDailyPremium.toFixed(0)}` : "n/a";
    const monthlyStr = r.monthly28DayCost !== null ? `$${r.monthly28DayCost.toFixed(0)}` : "n/a";
    const triggersStr = r.triggersPerMonth.toFixed(1);
    const netStr = r.foxifyMonthlyNet !== null ? `${r.foxifyMonthlyNet >= 0 ? "+" : ""}$${r.foxifyMonthlyNet.toFixed(0)}` : "n/a";
    console.log(`${positionStr} | ${triggerStr} | ${payoutStr} | ${premiumStr.padEnd(13)} | ${monthlyStr.padEnd(13)} | ${triggersStr.padEnd(11)} | ${netStr}`);
  }
};

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
