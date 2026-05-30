/**
 * Fixed-Payout Cover Probe — verify pricing for CEO's specific structure.
 *
 * Cover structure:
 *   - $200k notional position (Foxify's grid pair size)
 *   - Cover triggers at \xb1X% boundary (10%, 15%, or 20%)
 *   - Foxify gets $20k FIXED payout on first touch of boundary
 *   - Atticus retains the hedging option after payout (TP salvage)
 *
 * Atticus hedge options tested per trigger boundary:
 *   - "TIGHT" hedge: buy strangle CLOSER to spot than trigger (more salvage)
 *   - "MATCH" hedge: buy strangle AT trigger boundary (cheaper premium)
 *   - "WIDE" hedge: buy strangle WIDER than trigger (cheapest, lowest salvage)
 *
 * Goal: find the optimal combination of cover boundary + hedge structure
 * that gives best Foxify pricing while keeping Atticus capital fits.
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

const NOTIONAL_USD = 200_000; // CEO's actual position size
const FIXED_PAYOUT_USD = 20_000;

// Cover trigger boundaries to test
const TRIGGER_BOUNDARIES = [0.10, 0.15, 0.20];

// Atticus hedge strategies (strangle widths):
//   For each trigger, hedge is bought at TIGHTER level so it's already ITM
//   when trigger fires. Salvage is the option's value at trigger.
const HEDGE_OFFSETS: Record<number, Array<{ name: string; pct: number }>> = {
  0.10: [
    { name: "MATCH 10%", pct: 0.10 },
    { name: "TIGHT 7%", pct: 0.07 },
    { name: "TIGHT 5%", pct: 0.05 }
  ],
  0.15: [
    { name: "MATCH 15%", pct: 0.15 },
    { name: "TIGHT 10%", pct: 0.10 },
    { name: "TIGHT 7%", pct: 0.07 }
  ],
  0.20: [
    { name: "MATCH 20%", pct: 0.20 },
    { name: "TIGHT 15%", pct: 0.15 },
    { name: "TIGHT 10%", pct: 0.10 }
  ]
};

const main = async () => {
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("CEO Fixed-Payout Cover — Pricing & Atticus Hedge Analysis");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  const spot = await fetchSpotUsd();
  const positionSizeBtc = NOTIONAL_USD / spot;
  console.log(`Spot:     $${spot.toLocaleString()}`);
  console.log(`Notional: $${NOTIONAL_USD.toLocaleString()} (${positionSizeBtc.toFixed(4)} BTC)`);
  console.log(`Payout:   $${FIXED_PAYOUT_USD.toLocaleString()} fixed on trigger`);
  console.log("");

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
    console.error("No weekly expiry");
    process.exit(1);
  }
  const tenorDays = (new Date(weeklyExpiry).getTime() - Date.now()) / (24 * 3600 * 1000);
  const deribitExpiryTs = new Date(weeklyExpiry).getTime();
  console.log(`Weekly expiry: ${weeklyExpiry} (${tenorDays.toFixed(1)} days)\n`);

  // Get Bullish strike grid
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

  // Get Deribit strike grid
  const deribitOpts = deribitInstruments.filter((i) => i.expiration_timestamp === deribitExpiryTs);
  const deribitPuts = deribitOpts.filter((i) => i.option_type === "put");
  const deribitCalls = deribitOpts.filter((i) => i.option_type === "call");
  const deribitPutStrikes = Array.from(new Set(deribitPuts.map((i) => Number(i.strike))))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const deribitCallStrikes = Array.from(new Set(deribitCalls.map((i) => Number(i.strike))))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  // Trigger probability per week (empirical estimates for BTC)
  const TRIGGER_PROB_WEEKLY: Record<number, number> = {
    0.10: 0.10, // 10% per week
    0.15: 0.03, // 3% per week
    0.20: 0.01  // 1% per week
  };

  // Probe a strangle (long put + long call at given offset)
  const probeStrangle = async (
    venue: "Bullish" | "Deribit",
    putStrike: number,
    callStrike: number
  ) => {
    if (venue === "Bullish") {
      const putMarket = bullishPuts.find((m) => Number(m.optionStrikePrice) === putStrike);
      const callMarket = bullishCalls.find((m) => Number(m.optionStrikePrice) === callStrike);
      if (!putMarket || !callMarket) return null;
      const [putOb, callOb] = await Promise.all([
        fetchBullishOrderbook(putMarket.symbol),
        fetchBullishOrderbook(callMarket.symbol)
      ]);
      const putAsk = putOb?.asks[0] ? Number(putOb.asks[0].price) : null;
      const callAsk = callOb?.asks[0] ? Number(callOb.asks[0].price) : null;
      return { putAsk, callAsk };
    } else {
      const putInst = deribitPuts.find((i) => Number(i.strike) === putStrike);
      const callInst = deribitCalls.find((i) => Number(i.strike) === callStrike);
      if (!putInst || !callInst) return null;
      const [putOb, callOb] = await Promise.all([
        fetchDeribitOrderbook(putInst.instrument_name),
        fetchDeribitOrderbook(callInst.instrument_name)
      ]);
      return { putAsk: putOb?.askUsd ?? null, callAsk: callOb?.askUsd ?? null };
    }
  };

  // Estimate option salvage value at trigger
  // When BTC touches -trigger boundary, Atticus's put (struck at -hedge_pct, where hedge_pct < trigger):
  //   - Intrinsic value = (hedge_strike - spot_at_trigger) * notional/spot
  //                     = (trigger - hedge_pct) * notional
  //   - Plus remaining time value (~$3-5k for ATM BTC put with days remaining)
  const estimateSalvage = (triggerPct: number, hedgePct: number, notional: number): number => {
    const intrinsicAtTrigger = (triggerPct - hedgePct) * notional;
    const timeValueAtMidLife = notional * 0.015; // ~1.5% of notional for ATM-ish put with days remaining
    return Math.max(0, intrinsicAtTrigger + timeValueAtMidLife * 0.5); // conservative haircut
  };

  // Run analysis for each trigger × hedge combination
  for (const trigger of TRIGGER_BOUNDARIES) {
    console.log(`\n═══ TRIGGER: \xb1${(trigger * 100).toFixed(0)}% (cover fires when BTC moves \xb1${(trigger * 100).toFixed(0)}%) ═══`);
    console.log(`Weekly trigger probability (estimated): ${(TRIGGER_PROB_WEEKLY[trigger] * 100).toFixed(0)}%\n`);

    for (const hedge of HEDGE_OFFSETS[trigger]) {
      console.log(`  ── Hedge: ${hedge.name} (long strangle at \xb1${(hedge.pct * 100).toFixed(0)}%) ──`);

      const targetPutStrike = spot * (1 - hedge.pct);
      const targetCallStrike = spot * (1 + hedge.pct);

      const bullishPutStrike = findClosestStrike(targetPutStrike, bullishPutStrikes);
      const bullishCallStrike = findClosestStrike(targetCallStrike, bullishCallStrikes);
      const deribitPutStrike = findClosestStrike(targetPutStrike, deribitPutStrikes);
      const deribitCallStrike = findClosestStrike(targetCallStrike, deribitCallStrikes);

      const probeAndPrint = async (
        venue: "Bullish" | "Deribit",
        putStrike: number | null,
        callStrike: number | null
      ) => {
        if (putStrike === null || callStrike === null) {
          console.log(`    ${venue.padEnd(8)}: no strikes available`);
          return;
        }
        const result = await probeStrangle(venue, putStrike, callStrike);
        if (!result || result.putAsk === null || result.callAsk === null) {
          console.log(`    ${venue.padEnd(8)}: strikes \$${putStrike}/\$${callStrike} but no fills available`);
          return;
        }
        const strangleCostPerBtc = result.putAsk + result.callAsk;
        const strangleCostUsd = strangleCostPerBtc * positionSizeBtc;
        const strangleCostPerDay = strangleCostUsd / tenorDays;

        // Salvage estimate at trigger
        const salvage = estimateSalvage(trigger, hedge.pct, NOTIONAL_USD);

        // Atticus per-trigger net loss
        const atticusLossPerTrigger = FIXED_PAYOUT_USD - salvage;

        // Atticus expected weekly economics
        const triggerProb = TRIGGER_PROB_WEEKLY[trigger];
        const expectedTriggerCost = triggerProb * atticusLossPerTrigger;
        const totalAtticusCostWeekly = strangleCostUsd + expectedTriggerCost;
        const atticusBreakeven = totalAtticusCostWeekly;
        const atticusHealthyPremium = atticusBreakeven * 1.5; // 50% margin
        const foxify28dCost = atticusHealthyPremium * 4;

        console.log(`    ${venue.padEnd(8)}: put \$${putStrike} ask \$${result.putAsk.toFixed(0)}, call \$${callStrike} ask \$${result.callAsk.toFixed(0)}`);
        console.log(`              strangle cost: \$${strangleCostUsd.toFixed(0)} (\$${strangleCostPerDay.toFixed(0)}/day)`);
        console.log(`              salvage at trigger: ~\$${salvage.toFixed(0)}`);
        console.log(`              Atticus loss per trigger: \$${atticusLossPerTrigger.toFixed(0)}`);
        console.log(`              expected weekly cost: \$${totalAtticusCostWeekly.toFixed(0)} (\$${strangleCostUsd.toFixed(0)} hedge + \$${expectedTriggerCost.toFixed(0)} expected payouts)`);
        console.log(`              recommended Foxify weekly: \$${atticusHealthyPremium.toFixed(0)} → 28-day: \$${foxify28dCost.toFixed(0)}`);
      };

      await probeAndPrint("Bullish", bullishPutStrike, bullishCallStrike);
      await probeAndPrint("Deribit", deribitPutStrike, deribitCallStrike);
      console.log("");
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("KEY INSIGHTS");
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log(`
  1. \"TIGHT hedge\" (e.g., buying \xb15% strangle when cover triggers at \xb110%)
     gives Atticus more salvage at trigger because the option is already ITM.
  
  2. Atticus capital required = strangle cost + reserve for triggers
     (the strangle premium is the weekly outlay; reserve is needed for
     bad scenarios where multiple triggers fire).
  
  3. Foxify cost depends on trigger probability AND Atticus salvage strategy.
     Wider trigger = lower Foxify cost. Tighter Atticus hedge = lower
     Atticus loss per trigger but higher upfront premium.
  `);
};

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
