/**
 * Asymmetric Iron Condor Probe — verify pricing for variants where the put
 * spread and call spread have different widths or distances.
 *
 * Tests four structures on weekly Bullish (with Deribit comparison):
 *   SYMM 7/12: ±7% inner / ±12% outer (Path 1 baseline)
 *   LONG-BIAS: -5%/-12% put + +7%/+15% call (tight downside, wide upside cap)
 *   SHORT-BIAS: -7%/-15% put + +5%/+12% call (wide downside, tight upside cap)
 *   ZERO-PUT: +5%/+12% call only (no downside protection — radical)
 *
 * Goal: determine if asymmetric structures genuinely lower Foxify cost
 * or expand value for grid-trading use case.
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

type BullishOB = {
  bids: Array<{ price: string; quantity?: string; priceLevelQuantity?: string }>;
  asks: Array<{ price: string; quantity?: string; priceLevelQuantity?: string }>;
};

const fetchBullishOrderbook = async (symbol: string): Promise<BullishOB | null> => {
  try {
    return await fetchJson<BullishOB>(
      `https://api.exchange.bullish.com/trading-api/v1/markets/${encodeURIComponent(symbol)}/orderbook/hybrid`
    );
  } catch {
    return null;
  }
};

const fetchDeribitOrderbook = async (
  instrument: string
): Promise<{ bidUsd: number | null; askUsd: number | null; spotIdx: number } | null> => {
  try {
    const res = await fetchJson<{
      result: { bids?: Array<[number, number]>; asks?: Array<[number, number]>; index_price: number };
    }>(`https://www.deribit.com/api/v2/public/get_order_book?instrument_name=${encodeURIComponent(instrument)}`);
    const idx = res.result.index_price;
    const bid = res.result.bids?.[0]?.[0] ?? null;
    const ask = res.result.asks?.[0]?.[0] ?? null;
    return {
      bidUsd: bid !== null && bid > 0 ? bid * idx : null,
      askUsd: ask !== null && ask > 0 ? ask * idx : null,
      spotIdx: idx
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
  description: string;
  innerPutPct: number; // e.g., 0.07 means -7% strike
  outerPutPct: number;
  innerCallPct: number;
  outerCallPct: number;
  notionalUsd: number;
};

const NOTIONAL = 800_000;

const VARIANTS: Variant[] = [
  {
    name: "SYMM 7/12",
    description: "Symmetric ±7%/±12% — Path 1 baseline",
    innerPutPct: 0.07,
    outerPutPct: 0.12,
    innerCallPct: 0.07,
    outerCallPct: 0.12,
    notionalUsd: NOTIONAL
  },
  {
    name: "SYMM 7/15",
    description: "Symmetric ±7%/±15% — full Path 2",
    innerPutPct: 0.07,
    outerPutPct: 0.15,
    innerCallPct: 0.07,
    outerCallPct: 0.15,
    notionalUsd: NOTIONAL
  },
  {
    name: "LONG-BIAS",
    description: "Tight downside (-5%/-12%) + wide upside (+7%/+15%) — for long-biased grid",
    innerPutPct: 0.05,
    outerPutPct: 0.12,
    innerCallPct: 0.07,
    outerCallPct: 0.15,
    notionalUsd: NOTIONAL
  },
  {
    name: "SHORT-BIAS",
    description: "Wide downside (-7%/-15%) + tight upside (+5%/+12%) — for short-biased grid",
    innerPutPct: 0.07,
    outerPutPct: 0.15,
    innerCallPct: 0.05,
    outerCallPct: 0.12,
    notionalUsd: NOTIONAL
  },
  {
    name: "ASYM-CHEAP",
    description: "Tighter both inner (-3%/-10% put + +3%/+10% call) — cheaper but tighter band",
    innerPutPct: 0.03,
    outerPutPct: 0.10,
    innerCallPct: 0.03,
    outerCallPct: 0.10,
    notionalUsd: NOTIONAL
  }
];

type LegProbe = {
  label: string;
  side: "buy_put" | "sell_put" | "sell_call" | "buy_call";
  targetStrike: number;
  actualStrike: number | null;
  bidUsd: number | null;
  askUsd: number | null;
  fillUsd: number | null;
  spreadPct: number | null;
};

const probeBullishLeg = async (
  bullishMarkets: BullishMarket[],
  expiry: string,
  isPut: boolean,
  side: LegProbe["side"],
  label: string,
  targetStrike: number,
  availableStrikes: number[]
): Promise<LegProbe> => {
  const closest = findClosestStrike(targetStrike, availableStrikes);
  const result: LegProbe = {
    label,
    side,
    targetStrike,
    actualStrike: closest,
    bidUsd: null,
    askUsd: null,
    fillUsd: null,
    spreadPct: null
  };
  if (closest === null) return result;
  const market = bullishMarkets.find(
    (m) =>
      m.marketType === "OPTION" &&
      m.baseSymbol === "BTC" &&
      m.expiryDatetime === expiry &&
      m.optionType === (isPut ? "PUT" : "CALL") &&
      Number(m.optionStrikePrice) === closest
  );
  if (!market) return result;
  const ob = await fetchBullishOrderbook(market.symbol);
  if (!ob) return result;
  if (ob.bids[0]) result.bidUsd = Number(ob.bids[0].price);
  if (ob.asks[0]) result.askUsd = Number(ob.asks[0].price);
  if (result.bidUsd !== null && result.askUsd !== null && result.bidUsd > 0 && result.askUsd > 0) {
    const mid = (result.bidUsd + result.askUsd) / 2;
    result.spreadPct = ((result.askUsd - result.bidUsd) / mid) * 100;
  }
  if (side === "buy_put" || side === "buy_call") result.fillUsd = result.askUsd;
  else result.fillUsd = result.bidUsd;
  return result;
};

const probeDeribitLeg = async (
  deribitInstruments: DeribitInstrument[],
  expiryTs: number,
  isPut: boolean,
  side: LegProbe["side"],
  label: string,
  targetStrike: number,
  availableStrikes: number[]
): Promise<LegProbe> => {
  const closest = findClosestStrike(targetStrike, availableStrikes);
  const result: LegProbe = {
    label,
    side,
    targetStrike,
    actualStrike: closest,
    bidUsd: null,
    askUsd: null,
    fillUsd: null,
    spreadPct: null
  };
  if (closest === null) return result;
  const inst = deribitInstruments.find(
    (i) =>
      i.expiration_timestamp === expiryTs &&
      i.option_type === (isPut ? "put" : "call") &&
      Number(i.strike) === closest
  );
  if (!inst) return result;
  const ob = await fetchDeribitOrderbook(inst.instrument_name);
  if (!ob) return result;
  result.bidUsd = ob.bidUsd;
  result.askUsd = ob.askUsd;
  if (result.bidUsd !== null && result.askUsd !== null && result.bidUsd > 0 && result.askUsd > 0) {
    const mid = (result.bidUsd + result.askUsd) / 2;
    result.spreadPct = ((result.askUsd - result.bidUsd) / mid) * 100;
  }
  if (side === "buy_put" || side === "buy_call") result.fillUsd = result.askUsd;
  else result.fillUsd = result.bidUsd;
  return result;
};

type VariantResult = {
  variant: Variant;
  venue: "Bullish" | "Deribit";
  legs: LegProbe[];
  totalCostUsd: number | null;
  perDayUsd: number | null;
  marginRequiredUsd: number;
  putSpreadCap: number;
  callSpreadCap: number;
  recommendedFoxifyPremiumPerDay: number | null;
  notes: string[];
};

const main = async () => {
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("Asymmetric Iron Condor Probe — Live Bullish + Deribit Pricing");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  const spot = await fetchSpotUsd();
  console.log(`Spot: $${spot.toLocaleString()}`);

  console.log("Fetching markets...");
  const [bullishMarkets, deribitInstruments] = await Promise.all([
    fetchBullishMarkets(),
    fetchDeribitInstruments()
  ]);

  // Find weekly expiry
  const allBullishExpiries = Array.from(
    new Set(
      bullishMarkets
        .filter((m) => m.marketType === "OPTION" && m.baseSymbol === "BTC")
        .map((m) => m.expiryDatetime)
        .filter((e): e is string => Boolean(e))
    )
  ).sort();

  let weeklyExpiry: string | null = null;
  for (const e of allBullishExpiries) {
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
  console.log(`Weekly expiry: ${weeklyExpiry} (${tenorDays.toFixed(1)} days)\n`);

  // Available Bullish strikes
  const bullishOpts = bullishMarkets.filter(
    (m) => m.marketType === "OPTION" && m.baseSymbol === "BTC" && m.expiryDatetime === weeklyExpiry
  );
  const bullishPutStrikes = Array.from(
    new Set(bullishOpts.filter((m) => m.optionType === "PUT").map((m) => Number(m.optionStrikePrice)))
  )
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const bullishCallStrikes = Array.from(
    new Set(bullishOpts.filter((m) => m.optionType === "CALL").map((m) => Number(m.optionStrikePrice)))
  )
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  // Available Deribit strikes
  const deribitExpiryTs = new Date(weeklyExpiry).getTime();
  const deribitOpts = deribitInstruments.filter((i) => i.expiration_timestamp === deribitExpiryTs);
  const deribitPutStrikes = Array.from(
    new Set(deribitOpts.filter((i) => i.option_type === "put").map((i) => Number(i.strike)))
  )
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const deribitCallStrikes = Array.from(
    new Set(deribitOpts.filter((i) => i.option_type === "call").map((i) => Number(i.strike)))
  )
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  console.log(`Bullish put strikes (range): ${bullishPutStrikes[0]} - ${bullishPutStrikes[bullishPutStrikes.length - 1]} (${bullishPutStrikes.length} total)`);
  console.log(`Deribit put strikes (range): ${deribitPutStrikes[0]} - ${deribitPutStrikes[deribitPutStrikes.length - 1]} (${deribitPutStrikes.length} total)\n`);

  const probeVariant = async (variant: Variant, venue: "Bullish" | "Deribit"): Promise<VariantResult> => {
    const innerPut = spot * (1 - variant.innerPutPct);
    const outerPut = spot * (1 - variant.outerPutPct);
    const innerCall = spot * (1 + variant.innerCallPct);
    const outerCall = spot * (1 + variant.outerCallPct);

    const positionSizeBtc = variant.notionalUsd / spot;
    const putSpreadCap = (variant.outerPutPct - variant.innerPutPct) * variant.notionalUsd;
    const callSpreadCap = (variant.outerCallPct - variant.innerCallPct) * variant.notionalUsd;
    const marginRequired = Math.max(putSpreadCap, callSpreadCap);

    const probeFn = venue === "Bullish" ? probeBullishLeg : probeDeribitLeg;

    const legs: LegProbe[] = await Promise.all([
      venue === "Bullish"
        ? probeBullishLeg(bullishMarkets, weeklyExpiry!, true, "buy_put", "Buy inner put", innerPut, bullishPutStrikes)
        : probeDeribitLeg(deribitInstruments, deribitExpiryTs, true, "buy_put", "Buy inner put", innerPut, deribitPutStrikes),
      venue === "Bullish"
        ? probeBullishLeg(bullishMarkets, weeklyExpiry!, true, "sell_put", "Sell outer put", outerPut, bullishPutStrikes)
        : probeDeribitLeg(deribitInstruments, deribitExpiryTs, true, "sell_put", "Sell outer put", outerPut, deribitPutStrikes),
      venue === "Bullish"
        ? probeBullishLeg(bullishMarkets, weeklyExpiry!, false, "sell_call", "Sell inner call", innerCall, bullishCallStrikes)
        : probeDeribitLeg(deribitInstruments, deribitExpiryTs, false, "sell_call", "Sell inner call", innerCall, deribitCallStrikes),
      venue === "Bullish"
        ? probeBullishLeg(bullishMarkets, weeklyExpiry!, false, "buy_call", "Buy outer call", outerCall, bullishCallStrikes)
        : probeDeribitLeg(deribitInstruments, deribitExpiryTs, false, "buy_call", "Buy outer call", outerCall, deribitCallStrikes)
    ]);

    let totalCostUsd: number | null = null;
    if (legs.every((l) => l.fillUsd !== null && l.fillUsd >= 0)) {
      const perBtc = legs[0].fillUsd! - legs[1].fillUsd! - legs[2].fillUsd! + legs[3].fillUsd!;
      totalCostUsd = perBtc * positionSizeBtc;
    }

    const notes: string[] = [];
    for (const leg of legs) {
      if (leg.fillUsd === null) {
        notes.push(`${leg.label}: no fill (no liquidity at ${leg.actualStrike})`);
      } else if (leg.spreadPct !== null && leg.spreadPct > 60) {
        notes.push(`${leg.label}: wide spread ${leg.spreadPct.toFixed(0)}%`);
      }
    }

    const perDay = totalCostUsd !== null ? totalCostUsd / tenorDays : null;
    const recommendedPremium = perDay !== null ? perDay + 50 + perDay * 0.07 : null;

    return {
      variant,
      venue,
      legs,
      totalCostUsd,
      perDayUsd: perDay,
      marginRequiredUsd: marginRequired,
      putSpreadCap,
      callSpreadCap,
      recommendedFoxifyPremiumPerDay: recommendedPremium,
      notes
    };
  };

  console.log("RUNNING ALL VARIANTS ON BULLISH + DERIBIT...\n");

  const allResults: VariantResult[] = [];
  for (const variant of VARIANTS) {
    console.log(`\n──── ${variant.name}: ${variant.description} ────`);
    const bullishResult = await probeVariant(variant, "Bullish");
    const deribitResult = await probeVariant(variant, "Deribit");
    allResults.push(bullishResult, deribitResult);

    const printResult = (r: VariantResult) => {
      console.log(`\n  ${r.venue}:`);
      for (const leg of r.legs) {
        const strikeStr = leg.actualStrike !== null ? `$${leg.actualStrike.toFixed(0).padStart(6)}` : "  N/A ";
        const fillStr = leg.fillUsd !== null ? `$${leg.fillUsd.toFixed(0).padStart(5)}` : "  n/a";
        const spreadStr = leg.spreadPct !== null ? `sp ${leg.spreadPct.toFixed(0)}%` : "sp n/a";
        console.log(`    ${leg.label.padEnd(18)} target $${leg.targetStrike.toFixed(0).padStart(6)} → ${strikeStr} (fill ${fillStr}, ${spreadStr})`);
      }
      if (r.totalCostUsd !== null) {
        console.log(`    Net iron condor cost: $${r.totalCostUsd.toFixed(2)} for $${r.variant.notionalUsd.toLocaleString()} notional`);
        console.log(`    Per-day amortized: $${r.perDayUsd!.toFixed(2)}/day`);
        console.log(`    Margin required: $${r.marginRequiredUsd.toLocaleString()}`);
        console.log(`    Foxify recommended premium: $${r.recommendedFoxifyPremiumPerDay!.toFixed(0)}/day = $${(r.recommendedFoxifyPremiumPerDay! * 28).toFixed(0)}/28 days`);
      } else {
        console.log(`    ⚠ Cannot compute cost — missing fills`);
      }
      if (r.notes.length > 0) {
        for (const n of r.notes) console.log(`    - ${n}`);
      }
    };

    printResult(bullishResult);
    printResult(deribitResult);
  }

  // Final summary table
  console.log("\n\n═══════════════════════════════════════════════════════════════════════");
  console.log("SUMMARY — All variants compared");
  console.log("═══════════════════════════════════════════════════════════════════════\n");
  console.log("Variant       | Venue   | Margin   | Put cap | Call cap | Cost/wk | Foxify $/day | Foxify $/28d | Status");
  console.log("--------------+---------+----------+---------+----------+---------+--------------+--------------+--------");
  for (const r of allResults) {
    const margin = `$${(r.marginRequiredUsd / 1000).toFixed(0)}k`;
    const putCap = `$${(r.putSpreadCap / 1000).toFixed(0)}k`;
    const callCap = `$${(r.callSpreadCap / 1000).toFixed(0)}k`;
    const cost = r.totalCostUsd !== null ? `$${r.totalCostUsd.toFixed(0)}` : "n/a";
    const foxDaily = r.recommendedFoxifyPremiumPerDay !== null ? `$${r.recommendedFoxifyPremiumPerDay.toFixed(0)}` : "n/a";
    const fox28 = r.recommendedFoxifyPremiumPerDay !== null ? `$${(r.recommendedFoxifyPremiumPerDay * 28).toFixed(0)}` : "n/a";
    const status = r.totalCostUsd !== null && r.notes.length === 0 ? "✓" : r.totalCostUsd !== null ? "⚠ liquidity issues" : "✗ no fill";
    console.log(
      `${r.variant.name.padEnd(13)} | ${r.venue.padEnd(7)} | ${margin.padEnd(8)} | ${putCap.padEnd(7)} | ${callCap.padEnd(8)} | ${cost.padEnd(7)} | ${foxDaily.padEnd(12)} | ${fox28.padEnd(12)} | ${status}`
    );
  }
};

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
