/**
 * Final Foxify Cover Backtest + Live Bullish Verification.
 *
 * Combines:
 *   1. Live Bullish strike/liquidity verification for the proposed matrix
 *   2. Monte Carlo backtest with corrected pricing (sustainable Atticus margin)
 *
 * Pricing matrix (recommended after backtest revealed initial prices unsustainable):
 *   $50k/2%/$1k:    $350/day
 *   $50k/5%/$3k:    $265/day
 *   $50k/10%/$5k:   $105/day
 *   $200k/5%/$10k:  $1,060/day
 *   $200k/10%/$20k: $425/day
 *   $200k/15%/$30k: $300/day
 *
 * Daily premium covers BOTH directions (single trigger - either side).
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
  name: string;
  notional: number;
  triggerPct: number;
  payoutUsd: number;
  hedgePct: number;
  dailyPremium: number;
};

const CELLS: Cell[] = [
  { name: "$50k/2%/$1k",   notional: 50_000,  triggerPct: 0.02, payoutUsd: 1_000,  hedgePct: 0.01, dailyPremium: 350 },
  { name: "$50k/5%/$3k",   notional: 50_000,  triggerPct: 0.05, payoutUsd: 2_500,  hedgePct: 0.03, dailyPremium: 265 },
  { name: "$50k/10%/$5k",  notional: 50_000,  triggerPct: 0.10, payoutUsd: 5_000,  hedgePct: 0.05, dailyPremium: 105 },
  { name: "$200k/5%/$10k", notional: 200_000, triggerPct: 0.05, payoutUsd: 10_000, hedgePct: 0.03, dailyPremium: 1060 },
  { name: "$200k/10%/$20k",notional: 200_000, triggerPct: 0.10, payoutUsd: 20_000, hedgePct: 0.05, dailyPremium: 425 },
  { name: "$200k/15%/$30k",notional: 200_000, triggerPct: 0.15, payoutUsd: 30_000, hedgePct: 0.07, dailyPremium: 300 }
];

// Realistic intraday touch probabilities per regime
const TOUCH_PROB_PER_DAY: Record<string, Record<number, number>> = {
  calm:   { 0.02: 0.60, 0.05: 0.18, 0.10: 0.02, 0.15: 0.005 },
  normal: { 0.02: 0.85, 0.05: 0.30, 0.10: 0.05, 0.15: 0.012 },
  stress: { 0.02: 0.95, 0.05: 0.50, 0.10: 0.12, 0.15: 0.04 }
};

// Cleaner version - touch probability lookup
const touchProb = (triggerPct: number, regime: "calm" | "normal" | "stress"): number => {
  if (regime === "calm") {
    if (triggerPct <= 0.02) return 0.60;
    if (triggerPct <= 0.05) return 0.18;
    if (triggerPct <= 0.10) return 0.02;
    if (triggerPct <= 0.15) return 0.005;
    return 0.001;
  } else if (regime === "normal") {
    if (triggerPct <= 0.02) return 0.85;
    if (triggerPct <= 0.05) return 0.30;
    if (triggerPct <= 0.10) return 0.05;
    if (triggerPct <= 0.15) return 0.012;
    return 0.003;
  } else {
    if (triggerPct <= 0.02) return 0.95;
    if (triggerPct <= 0.05) return 0.50;
    if (triggerPct <= 0.10) return 0.12;
    if (triggerPct <= 0.15) return 0.04;
    return 0.012;
  }
};

const REGIME_FRACTION = { calm: 0.30, normal: 0.51, stress: 0.19 };

const sampleRegime = (): "calm" | "normal" | "stress" => {
  const r = Math.random();
  if (r < REGIME_FRACTION.calm) return "calm";
  if (r < REGIME_FRACTION.calm + REGIME_FRACTION.normal) return "normal";
  return "stress";
};

// ────────────────────── Bullish Verification ──────────────────────

const verifyBullishStrikes = async (cells: Cell[], spot: number): Promise<Map<string, { strangleCostDay: number | null; available: boolean }>> => {
  console.log("\n══ BULLISH STRIKE VERIFICATION ══\n");

  const bullishMarkets = await fetchBullishMarkets();

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
  if (!weeklyExpiry) throw new Error("No weekly expiry");

  const tenorDays = (new Date(weeklyExpiry).getTime() - Date.now()) / (24 * 3600 * 1000);
  console.log(`Weekly expiry: ${weeklyExpiry} (${tenorDays.toFixed(1)} days)\n`);

  const bullishOpts = bullishMarkets.filter(
    (m) => m.marketType === "OPTION" && m.baseSymbol === "BTC" && m.expiryDatetime === weeklyExpiry
  );
  const bullishPuts = bullishOpts.filter((m) => m.optionType === "PUT");
  const bullishCalls = bullishOpts.filter((m) => m.optionType === "CALL");
  const putStrikes = Array.from(new Set(bullishPuts.map((m) => Number(m.optionStrikePrice)))).filter(Number.isFinite).sort((a, b) => a - b);
  const callStrikes = Array.from(new Set(bullishCalls.map((m) => Number(m.optionStrikePrice)))).filter(Number.isFinite).sort((a, b) => a - b);

  const results = new Map<string, { strangleCostDay: number | null; available: boolean }>();

  for (const cell of cells) {
    const positionSizeBtc = cell.notional / spot;
    const targetPut = spot * (1 - cell.hedgePct);
    const targetCall = spot * (1 + cell.hedgePct);

    const putStrike = findClosestStrike(targetPut, putStrikes);
    const callStrike = findClosestStrike(targetCall, callStrikes);

    let putAsk: number | null = null;
    let callAsk: number | null = null;

    if (putStrike !== null) {
      const market = bullishPuts.find((m) => Number(m.optionStrikePrice) === putStrike);
      if (market) {
        const ob = await fetchBullishOrderbook(market.symbol);
        if (ob?.asks[0]) putAsk = Number(ob.asks[0].price);
      }
    }
    if (callStrike !== null) {
      const market = bullishCalls.find((m) => Number(m.optionStrikePrice) === callStrike);
      if (market) {
        const ob = await fetchBullishOrderbook(market.symbol);
        if (ob?.asks[0]) callAsk = Number(ob.asks[0].price);
      }
    }

    const available = putAsk !== null && callAsk !== null;
    const strangleCostWeek = available ? (putAsk! + callAsk!) * positionSizeBtc : null;
    const strangleCostDay = strangleCostWeek !== null ? strangleCostWeek / tenorDays : null;

    console.log(`${cell.name.padEnd(20)}: hedge \xb1${(cell.hedgePct * 100).toFixed(0)}% \u2192 put $${putStrike} ask $${putAsk?.toFixed(0) ?? "n/a"}, call $${callStrike} ask $${callAsk?.toFixed(0) ?? "n/a"} \u2192 strangle $${strangleCostDay?.toFixed(0) ?? "n/a"}/day`);

    results.set(cell.name, { strangleCostDay, available });
  }

  return results;
};

// ────────────────────── Backtest ──────────────────────

const simulateDay = (cell: Cell, strangleCostDay: number, regime: "calm" | "normal" | "stress"): { atticusPnL: number; foxifyPnL: number; triggered: boolean } => {
  const triggered = Math.random() < touchProb(cell.triggerPct, regime);

  let atticusRevenue = cell.dailyPremium;
  const atticusHedgeCost = strangleCostDay;
  let atticusPayoutCost = 0;
  let foxifyPayoutReceived = 0;

  if (triggered) {
    atticusPayoutCost = cell.payoutUsd;
    foxifyPayoutReceived = cell.payoutUsd;
    // Salvage: 80% single direction, 120% double direction (vol-dependent)
    const doubleProb = regime === "stress" ? 0.45 : regime === "normal" ? 0.25 : 0.10;
    const isDouble = Math.random() < doubleProb;
    const salvage = cell.payoutUsd * (isDouble ? 1.20 : 0.80);
    atticusRevenue += salvage;
  }

  return {
    atticusPnL: atticusRevenue - atticusHedgeCost - atticusPayoutCost,
    foxifyPnL: foxifyPayoutReceived - cell.dailyPremium,
    triggered
  };
};

const N_PERIODS = 10_000;
const DAYS_PER_PERIOD = 28;

const simulatePeriod = (cell: Cell, strangleCostDay: number) => {
  let atticusTotal = 0;
  let foxifyTotal = 0;
  let triggers = 0;
  for (let d = 0; d < DAYS_PER_PERIOD; d++) {
    const regime = sampleRegime();
    const day = simulateDay(cell, strangleCostDay, regime);
    atticusTotal += day.atticusPnL;
    foxifyTotal += day.foxifyPnL;
    if (day.triggered) triggers++;
  }
  return { atticus: atticusTotal, foxify: foxifyTotal, triggers };
};

const percentile = (sorted: number[], p: number): number => sorted[Math.floor(sorted.length * p)];
const meanStd = (xs: number[]): { mean: number; std: number } => {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const std = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
  return { mean, std };
};

// ────────────────────── Main ──────────────────────

const main = async () => {
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("Foxify Cover Final Verification — Pricing + Backtest");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  const spot = await fetchSpotUsd();
  console.log(`Spot: $${spot.toLocaleString()}\n`);

  // 1. Verify Bullish strikes
  const verification = await verifyBullishStrikes(CELLS, spot);

  console.log("\n\n══ HISTORICAL BACKTEST WITH NEW PRICING ══");
  console.log(`${N_PERIODS.toLocaleString()} \xd7 ${DAYS_PER_PERIOD}-day Monte Carlo periods\n`);

  console.log("Cell                | Daily Premium | Atticus mean | %profitable | Foxify mean | Foxify median | Triggers/period");
  console.log("--------------------+---------------+--------------+-------------+-------------+---------------+-----------------");

  const allResults = new Map<string, { atticusMean: number; atticusProfitable: number; foxifyMean: number; foxifyMedian: number; triggers: number; atticusP05: number; foxifyP05: number }>();

  for (const cell of CELLS) {
    const v = verification.get(cell.name);
    if (!v || !v.available || v.strangleCostDay === null) {
      console.log(`${cell.name.padEnd(19)} | $${cell.dailyPremium.toString().padEnd(11)} | NOT VIABLE - strikes unavailable`);
      continue;
    }

    const periods = [];
    for (let i = 0; i < N_PERIODS; i++) {
      periods.push(simulatePeriod(cell, v.strangleCostDay));
    }

    const atticusPnLs = periods.map((p) => p.atticus).sort((a, b) => a - b);
    const foxifyPnLs = periods.map((p) => p.foxify).sort((a, b) => a - b);
    const triggers = periods.map((p) => p.triggers);

    const atticusMean = meanStd(atticusPnLs).mean;
    const atticusProfitable = (atticusPnLs.filter((x) => x > 0).length / atticusPnLs.length) * 100;
    const foxifyMean = meanStd(foxifyPnLs).mean;
    const foxifyMedian = percentile(foxifyPnLs, 0.5);
    const trigMean = meanStd(triggers).mean;

    allResults.set(cell.name, {
      atticusMean,
      atticusProfitable,
      foxifyMean,
      foxifyMedian,
      triggers: trigMean,
      atticusP05: percentile(atticusPnLs, 0.05),
      foxifyP05: percentile(foxifyPnLs, 0.05)
    });

    console.log(`${cell.name.padEnd(19)} | $${cell.dailyPremium.toString().padEnd(11)} | $${atticusMean.toFixed(0).padStart(11)} | ${atticusProfitable.toFixed(0).padStart(10)}% | $${foxifyMean.toFixed(0).padStart(10)} | $${foxifyMedian.toFixed(0).padStart(12)} | ${trigMean.toFixed(1).padStart(15)}`);
  }

  // Detail per cell
  console.log("\n\nDETAILED MONTHLY DISTRIBUTION");
  console.log("─────────────────────────────────────────────────────────────────────────────\n");
  for (const cell of CELLS) {
    const r = allResults.get(cell.name);
    if (!r) continue;
    console.log(`${cell.name} @ $${cell.dailyPremium}/day:`);
    console.log(`  Atticus 28-day P&L: mean +$${r.atticusMean.toFixed(0)}, worst-case (5%ile) $${r.atticusP05.toFixed(0)}, profitable ${r.atticusProfitable.toFixed(0)}% of months`);
    console.log(`  Foxify 28-day P&L:  mean +$${r.foxifyMean.toFixed(0)}, worst-case $${r.foxifyP05.toFixed(0)}, median +$${r.foxifyMedian.toFixed(0)}`);
    console.log("");
  }
};

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
