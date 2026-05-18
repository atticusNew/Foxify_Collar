/**
 * Tight Iron Condor Probe — verify ±3%/±7% pricing on Bullish + Deribit.
 *
 * Compares to Path 1 baseline (±7%/±12%) which we already verified.
 *
 * Tests: $300k notional weekly tenor on both venues
 *   - ±3%/±7% (tight)
 *   - ±5%/±10% (middle ground for comparison)
 *   - ±7%/±12% (Path 1 reference)
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

type Variant = {
  name: string;
  innerPct: number;
  outerPct: number;
};

const VARIANTS: Variant[] = [
  { name: "TIGHT 3/7", innerPct: 0.03, outerPct: 0.07 },
  { name: "MID 5/10", innerPct: 0.05, outerPct: 0.10 },
  { name: "PATH 1 (7/12)", innerPct: 0.07, outerPct: 0.12 }
];

const NOTIONAL_USD = 300_000;

const probeVariant = async (
  variant: Variant,
  spot: number,
  bullishMarkets: BullishMarket[],
  deribitInstruments: DeribitInstrument[],
  bullishExpiry: string,
  deribitExpiryTs: number
) => {
  const positionSizeBtc = NOTIONAL_USD / spot;
  const innerPutStrike = spot * (1 - variant.innerPct);
  const outerPutStrike = spot * (1 - variant.outerPct);
  const innerCallStrike = spot * (1 + variant.innerPct);
  const outerCallStrike = spot * (1 + variant.outerPct);
  const spreadWidth = variant.outerPct - variant.innerPct;
  const margin = spreadWidth * NOTIONAL_USD;

  const bullishOpts = bullishMarkets.filter(
    (m) => m.marketType === "OPTION" && m.baseSymbol === "BTC" && m.expiryDatetime === bullishExpiry
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

  const fetchBullishLeg = async (target: number, isPut: boolean) => {
    const strike = findClosestStrike(target, isPut ? bullishPutStrikes : bullishCallStrikes);
    if (strike === null) return null;
    const market = (isPut ? bullishPuts : bullishCalls).find((m) => Number(m.optionStrikePrice) === strike);
    if (!market) return null;
    const ob = await fetchBullishOrderbook(market.symbol);
    if (!ob) return null;
    return {
      strike,
      bid: ob.bids[0] ? Number(ob.bids[0].price) : null,
      ask: ob.asks[0] ? Number(ob.asks[0].price) : null,
      bidQty: ob.bids[0] ? Number(ob.bids[0].priceLevelQuantity ?? ob.bids[0].quantity ?? 0) : 0,
      askQty: ob.asks[0] ? Number(ob.asks[0].priceLevelQuantity ?? ob.asks[0].quantity ?? 0) : 0
    };
  };

  const fetchDeribitLeg = async (target: number, isPut: boolean) => {
    const strike = findClosestStrike(target, isPut ? deribitPutStrikes : deribitCallStrikes);
    if (strike === null) return null;
    const inst = (isPut ? deribitPuts : deribitCalls).find((i) => Number(i.strike) === strike);
    if (!inst) return null;
    const ob = await fetchDeribitOrderbook(inst.instrument_name);
    if (!ob) return null;
    return {
      strike,
      bid: ob.bidUsd,
      ask: ob.askUsd,
      bidQty: 0,
      askQty: 0
    };
  };

  const probeVenue = async (venueName: "Bullish" | "Deribit") => {
    const fetcher = venueName === "Bullish" ? fetchBullishLeg : fetchDeribitLeg;
    const legs = await Promise.all([
      fetcher(innerPutStrike, true),
      fetcher(outerPutStrike, true),
      fetcher(innerCallStrike, false),
      fetcher(outerCallStrike, false)
    ]);
    return legs;
  };

  const bullishLegs = await probeVenue("Bullish");
  const deribitLegs = await probeVenue("Deribit");

  const computeCost = (legs: Array<{ strike: number; bid: number | null; ask: number | null } | null>) => {
    if (legs.some((l) => l === null)) return { cost: null, status: "missing leg" };
    const buyInnerPut = legs[0]!.ask;
    const sellOuterPut = legs[1]!.bid;
    const sellInnerCall = legs[2]!.bid;
    const buyOuterCall = legs[3]!.ask;
    if (buyInnerPut === null || sellOuterPut === null || sellInnerCall === null || buyOuterCall === null) {
      return { cost: null, status: "no fill price" };
    }
    const perBtc = buyInnerPut - sellOuterPut - sellInnerCall + buyOuterCall;
    return { cost: perBtc * positionSizeBtc, status: "ok" };
  };

  const bullishCost = computeCost(bullishLegs);
  const deribitCost = computeCost(deribitLegs);

  return {
    variant,
    spreadWidth,
    margin,
    positionSizeBtc,
    bullishLegs,
    deribitLegs,
    bullishCostUsd: bullishCost.cost,
    bullishStatus: bullishCost.status,
    deribitCostUsd: deribitCost.cost,
    deribitStatus: deribitCost.status,
    targetStrikes: {
      innerPut: innerPutStrike,
      outerPut: outerPutStrike,
      innerCall: innerCallStrike,
      outerCall: outerCallStrike
    }
  };
};

const main = async () => {
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("Tight Iron Condor Probe — ±3%/±7% vs alternatives");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  const spot = await fetchSpotUsd();
  console.log(`Spot: $${spot.toLocaleString()}`);
  console.log(`Notional: $${NOTIONAL_USD.toLocaleString()} (${(NOTIONAL_USD / spot).toFixed(4)} BTC)`);

  console.log("\nFetching markets...");
  const [bullishMarkets, deribitInstruments] = await Promise.all([
    fetchBullishMarkets(),
    fetchDeribitInstruments()
  ]);

  // Find weekly expiry (5-10 days out)
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
    console.error("No weekly Bullish expiry found");
    process.exit(1);
  }
  const tenorDays = (new Date(weeklyExpiry).getTime() - Date.now()) / (24 * 3600 * 1000);
  const deribitExpiryTs = new Date(weeklyExpiry).getTime();
  console.log(`Weekly expiry: ${weeklyExpiry} (${tenorDays.toFixed(1)} days)\n`);

  const results = [];
  for (const variant of VARIANTS) {
    console.log(`\n──── ${variant.name} (\xb1${(variant.innerPct * 100).toFixed(0)}%/\xb1${(variant.outerPct * 100).toFixed(0)}%) ────`);
    const result = await probeVariant(variant, spot, bullishMarkets, deribitInstruments, weeklyExpiry, deribitExpiryTs);
    results.push(result);

    console.log(`  Margin: $${(result.margin / 1000).toFixed(0)}k (spread ${(result.spreadWidth * 100).toFixed(0)}%)`);
    console.log(`  Foxify max payout per cover: $${(result.margin / 1000).toFixed(0)}k`);
    console.log(`  Within-band exposure: $${(variant.innerPct * NOTIONAL_USD / 1000).toFixed(0)}k (Foxify takes loss before cover starts)`);
    console.log(``);

    const printVenue = (
      venueName: string,
      legs: Array<{ strike: number; bid: number | null; ask: number | null } | null>,
      cost: number | null,
      status: string
    ) => {
      console.log(`  ${venueName}:`);
      const legNames = ["Buy inner put", "Sell outer put", "Sell inner call", "Buy outer call"];
      const targets = [
        result.targetStrikes.innerPut,
        result.targetStrikes.outerPut,
        result.targetStrikes.innerCall,
        result.targetStrikes.outerCall
      ];
      legs.forEach((leg, i) => {
        if (leg === null) {
          console.log(`    ${legNames[i].padEnd(17)} target $${targets[i].toFixed(0)} → NO STRIKE`);
        } else {
          const strikeStr = `$${leg.strike.toFixed(0).padStart(6)}`;
          const bidStr = leg.bid !== null ? `bid $${leg.bid.toFixed(0).padStart(5)}` : "bid    n/a";
          const askStr = leg.ask !== null ? `ask $${leg.ask.toFixed(0).padStart(5)}` : "ask    n/a";
          const spreadStr =
            leg.bid !== null && leg.ask !== null && leg.bid > 0 && leg.ask > 0
              ? `(spread ${(((leg.ask - leg.bid) / ((leg.ask + leg.bid) / 2)) * 100).toFixed(0)}%)`
              : "(spread n/a)";
          console.log(`    ${legNames[i].padEnd(17)} target $${targets[i].toFixed(0).padStart(6)} → ${strikeStr} ${bidStr} ${askStr} ${spreadStr}`);
        }
      });
      if (cost !== null) {
        const perDay = cost / tenorDays;
        const recommendedPremium = perDay + 50 + perDay * 0.07;
        console.log(`    → Iron condor cost: $${cost.toFixed(2)} for ${tenorDays.toFixed(1)} days`);
        console.log(`    → Per day amortized: $${perDay.toFixed(2)}`);
        console.log(`    → Recommended Foxify premium: $${recommendedPremium.toFixed(0)}/day = $${(recommendedPremium * 28).toFixed(0)}/28 days`);
      } else {
        console.log(`    → Cost: cannot compute (${status})`);
      }
    };

    printVenue("BULLISH", result.bullishLegs, result.bullishCostUsd, result.bullishStatus);
    printVenue("DERIBIT", result.deribitLegs, result.deribitCostUsd, result.deribitStatus);
  }

  console.log("\n\n═══════════════════════════════════════════════════════════════════════");
  console.log("SUMMARY — All variants compared at $300k notional");
  console.log("═══════════════════════════════════════════════════════════════════════\n");
  console.log("Variant         | Margin | Cap   | Within-band | Bullish 28d | Deribit 28d");
  console.log("----------------+--------+-------+-------------+-------------+-------------");
  for (const r of results) {
    const margin = `$${(r.margin / 1000).toFixed(0)}k`;
    const cap = `$${(r.margin / 1000).toFixed(0)}k`;
    const wbExposure = `$${(r.variant.innerPct * NOTIONAL_USD / 1000).toFixed(0)}k`;
    const bullish28 = r.bullishCostUsd !== null
      ? `$${(((r.bullishCostUsd / tenorDays) + 50 + (r.bullishCostUsd / tenorDays) * 0.07) * 28).toFixed(0)}`
      : "n/a";
    const deribit28 = r.deribitCostUsd !== null
      ? `$${(((r.deribitCostUsd / tenorDays) + 50 + (r.deribitCostUsd / tenorDays) * 0.07) * 28).toFixed(0)}`
      : "n/a";
    console.log(`${r.variant.name.padEnd(15)} | ${margin.padEnd(6)} | ${cap.padEnd(5)} | ${wbExposure.padEnd(11)} | ${bullish28.padEnd(11)} | ${deribit28.padEnd(11)}`);
  }
};

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
