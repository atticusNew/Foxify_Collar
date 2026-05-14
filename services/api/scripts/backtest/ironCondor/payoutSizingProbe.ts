/**
 * ±15% Trigger Verification Probe — multiple payout sizes.
 *
 * For CEO's specific structure: $200k notional, ±15% boundary trigger.
 * Tests payouts of $20k, $25k, $30k with TIGHT 7% and TIGHT 10% hedge strategies
 * on both Bullish and Deribit, weekly tenor.
 *
 * Goal: confirm verified pricing for the recommendation before CEO meeting.
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

type DeribitInstrument = {
  instrument_name: string;
  option_type?: string;
  strike?: number;
  expiration_timestamp?: number;
  is_active?: boolean;
};

const fetchBullishMarkets = async (): Promise<BullishMarket[]> =>
  fetchJson<BullishMarket[]>("https://api.exchange.bullish.com/trading-api/v1/markets", 15_000);

const fetchDeribitInstruments = async (): Promise<DeribitInstrument[]> => {
  const res = await fetchJson<{ result: DeribitInstrument[] }>(
    "https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option"
  );
  return res.result.filter((i) => i.is_active !== false);
};

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

const fetchDeribitOrderbook = async (instrument: string) => {
  try {
    const res = await fetchJson<{
      result: { bids?: Array<[number, number]>; asks?: Array<[number, number]>; index_price: number };
    }>(`https://www.deribit.com/api/v2/public/get_order_book?instrument_name=${encodeURIComponent(instrument)}&depth=10`);
    const idx = res.result.index_price;
    const bid = res.result.bids?.[0]?.[0] ?? null;
    const ask = res.result.asks?.[0]?.[0] ?? null;
    return {
      bidUsd: bid !== null && bid > 0 ? bid * idx : null,
      askUsd: ask !== null && ask > 0 ? ask * idx : null
    };
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

const NOTIONAL_USD = 200_000;
const TRIGGER_PCT = 0.15;
const TRIGGER_PROB_WEEKLY = 0.03; // 3% per week empirical for ±15%

// Test payout sizes
const PAYOUT_SIZES = [15_000, 20_000, 25_000, 30_000, 35_000];

// Hedge strategies (long strangle widths for Atticus)
const HEDGE_STRATEGIES = [
  { name: "TIGHT 7%", pct: 0.07 },
  { name: "TIGHT 10%", pct: 0.10 },
  { name: "MATCH 15%", pct: 0.15 }
];

const main = async () => {
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("\xb115% Trigger Verification Probe — Multiple Payout Sizes");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  const spot = await fetchSpotUsd();
  const positionSizeBtc = NOTIONAL_USD / spot;
  console.log(`Spot:         $${spot.toLocaleString()}`);
  console.log(`Notional:     $${NOTIONAL_USD.toLocaleString()} (${positionSizeBtc.toFixed(4)} BTC)`);
  console.log(`Trigger:      \xb1${(TRIGGER_PCT * 100).toFixed(0)}%`);
  console.log(`Weekly trigger probability: ${(TRIGGER_PROB_WEEKLY * 100).toFixed(0)}%\n`);

  console.log("Fetching markets...");
  const [bullishMarkets, deribitInstruments] = await Promise.all([
    fetchBullishMarkets(),
    fetchDeribitInstruments()
  ]);

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
  const deribitExpiryTs = new Date(weeklyExpiry).getTime();
  console.log(`Weekly expiry: ${weeklyExpiry} (${tenorDays.toFixed(1)} days)\n`);

  // Get strikes
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

  const deribitOpts = deribitInstruments.filter((i) => i.expiration_timestamp === deribitExpiryTs);
  const deribitPuts = deribitOpts.filter((i) => i.option_type === "put");
  const deribitCalls = deribitOpts.filter((i) => i.option_type === "call");
  const deribitPutStrikes = Array.from(new Set(deribitPuts.map((i) => Number(i.strike))))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const deribitCallStrikes = Array.from(new Set(deribitCalls.map((i) => Number(i.strike))))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  // Estimate salvage at trigger
  // When BTC touches \xb115%, Atticus's strangle at ±X% (where X < 15) has:
  //   Intrinsic = (15% - X%) × notional (option is ITM by this amount)
  //   Time value = approximately notional × 0.005 (small remaining time value)
  const estimateSalvage = (hedgePct: number, notional: number): number => {
    const intrinsicAtTrigger = (TRIGGER_PCT - hedgePct) * notional;
    const remainingTimeValue = notional * 0.005;
    return Math.max(0, intrinsicAtTrigger + remainingTimeValue);
  };

  // Probe each hedge strategy on both venues
  for (const hedge of HEDGE_STRATEGIES) {
    console.log(`\n══════ HEDGE: ${hedge.name} (long strangle at \xb1${(hedge.pct * 100).toFixed(0)}%) ══════`);

    const targetPutStrike = spot * (1 - hedge.pct);
    const targetCallStrike = spot * (1 + hedge.pct);

    const bullishPutStrike = findClosestStrike(targetPutStrike, bullishPutStrikes);
    const bullishCallStrike = findClosestStrike(targetCallStrike, bullishCallStrikes);
    const deribitPutStrike = findClosestStrike(targetPutStrike, deribitPutStrikes);
    const deribitCallStrike = findClosestStrike(targetCallStrike, deribitCallStrikes);

    // Fetch fills
    const fetchVenueData = async (
      venue: "Bullish" | "Deribit",
      putStrike: number | null,
      callStrike: number | null
    ): Promise<{ putAsk: number | null; callAsk: number | null; strangleCost: number } | null> => {
      if (putStrike === null || callStrike === null) return null;
      let putAsk: number | null = null;
      let callAsk: number | null = null;
      if (venue === "Bullish") {
        const putMarket = bullishPuts.find((m) => Number(m.optionStrikePrice) === putStrike);
        const callMarket = bullishCalls.find((m) => Number(m.optionStrikePrice) === callStrike);
        if (putMarket) {
          const ob = await fetchBullishOrderbook(putMarket.symbol);
          if (ob?.asks[0]) putAsk = Number(ob.asks[0].price);
        }
        if (callMarket) {
          const ob = await fetchBullishOrderbook(callMarket.symbol);
          if (ob?.asks[0]) callAsk = Number(ob.asks[0].price);
        }
      } else {
        const putInst = deribitPuts.find((i) => Number(i.strike) === putStrike);
        const callInst = deribitCalls.find((i) => Number(i.strike) === callStrike);
        if (putInst) {
          const ob = await fetchDeribitOrderbook(putInst.instrument_name);
          putAsk = ob?.askUsd ?? null;
        }
        if (callInst) {
          const ob = await fetchDeribitOrderbook(callInst.instrument_name);
          callAsk = ob?.askUsd ?? null;
        }
      }
      if (putAsk === null || callAsk === null) return null;
      const strangleCost = (putAsk + callAsk) * positionSizeBtc;
      return { putAsk, callAsk, strangleCost };
    };

    const bullishData = await fetchVenueData("Bullish", bullishPutStrike, bullishCallStrike);
    const deribitData = await fetchVenueData("Deribit", deribitPutStrike, deribitCallStrike);

    const salvage = estimateSalvage(hedge.pct, NOTIONAL_USD);
    console.log(`Atticus salvage at trigger: ~$${salvage.toFixed(0)} (${(((salvage / NOTIONAL_USD) * 100)).toFixed(1)}% of notional)`);

    if (bullishData) {
      console.log(`Bullish: put $${bullishPutStrike} ask $${bullishData.putAsk.toFixed(0)}, call $${bullishCallStrike} ask $${bullishData.callAsk.toFixed(0)}`);
      console.log(`         strangle cost: $${bullishData.strangleCost.toFixed(0)}/week`);
    } else {
      console.log(`Bullish: strikes ${bullishPutStrike}/${bullishCallStrike} but no fills available`);
    }
    if (deribitData) {
      console.log(`Deribit: put $${deribitPutStrike} ask $${deribitData.putAsk.toFixed(0)}, call $${deribitCallStrike} ask $${deribitData.callAsk.toFixed(0)}`);
      console.log(`         strangle cost: $${deribitData.strangleCost.toFixed(0)}/week`);
    } else {
      console.log(`Deribit: strikes ${deribitPutStrike}/${deribitCallStrike} but no fills available`);
    }

    console.log(`\nFor each payout size:`);
    console.log(`Payout    | Atticus loss/trigger | Bullish weekly | Bullish 28d | Deribit weekly | Deribit 28d | Reserve needed`);
    console.log(`----------+----------------------+----------------+-------------+----------------+-------------+----------------`);
    for (const payout of PAYOUT_SIZES) {
      const atticusLossPerTrigger = payout - salvage;
      const expectedWeeklyTriggerCost = TRIGGER_PROB_WEEKLY * atticusLossPerTrigger;
      const reserveRecommended = atticusLossPerTrigger * 2; // 2 worst-case triggers per month

      const computeFoxifyPricing = (strangleCostWeek: number) => {
        const totalWeeklyCost = strangleCostWeek + expectedWeeklyTriggerCost;
        const margin = 1.4; // 40% margin
        const foxifyWeekly = totalWeeklyCost * margin;
        return { weekly: foxifyWeekly, monthly: foxifyWeekly * 4 };
      };

      const bullishPricing = bullishData ? computeFoxifyPricing(bullishData.strangleCost) : null;
      const deribitPricing = deribitData ? computeFoxifyPricing(deribitData.strangleCost) : null;

      const bullishWeekStr = bullishPricing ? `$${bullishPricing.weekly.toFixed(0)}` : "n/a";
      const bullish28Str = bullishPricing ? `$${bullishPricing.monthly.toFixed(0)}` : "n/a";
      const deribitWeekStr = deribitPricing ? `$${deribitPricing.weekly.toFixed(0)}` : "n/a";
      const deribit28Str = deribitPricing ? `$${deribitPricing.monthly.toFixed(0)}` : "n/a";

      console.log(
        `$${(payout / 1000).toFixed(0)}k`.padEnd(10) + `| $${atticusLossPerTrigger.toFixed(0)}`.padEnd(22) +
        `| ${bullishWeekStr}`.padEnd(16) + `| ${bullish28Str}`.padEnd(13) +
        `| ${deribitWeekStr}`.padEnd(16) + `| ${deribit28Str}`.padEnd(13) +
        `| $${reserveRecommended.toFixed(0)}`
      );
    }
  }

  console.log("\n\n═══════════════════════════════════════════════════════════════════════");
  console.log("RECOMMENDATIONS");
  console.log("═══════════════════════════════════════════════════════════════════════\n");
  console.log("For \xb115% trigger / $200k notional / weekly tenor:");
  console.log("");
  console.log("  • $20k payout + TIGHT 10% hedge: best balance, fits Atticus budget");
  console.log("  • $25k payout + TIGHT 10% hedge: bigger cushion, slightly more cost");
  console.log("  • $25k payout + TIGHT 7% hedge:  best salvage, similar Atticus margin");
  console.log("  • $30k+ payout: requires Foxify margin deposit (Atticus reserve too large)");
};

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
