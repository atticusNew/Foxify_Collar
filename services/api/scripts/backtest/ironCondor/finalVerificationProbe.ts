/**
 * Final iron condor verification probe — pulls live Bullish + Deribit
 * order books for the two viable paths from the previous analysis:
 *
 *   PATH 1: $300k notional, ±7% inner / ±12% outer iron condor, weekly
 *           ($15k Atticus margin, no Foxify pre-fund needed)
 *   PATH 2: $800k notional, ±7% inner / ±15% outer iron condor, weekly
 *           ($64k margin via Foxify pre-fund)
 *
 * For each path: probes both Bullish and Deribit weekly options at the
 * specific target strikes, computes the actual iron condor cost from
 * cross-the-spread fills, reports liquidity quality.
 */

import { bsPut, bsCall } from "../../../src/pilot/blackScholes";

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
  fetchJson<BullishMarket[]>(
    "https://api.exchange.bullish.com/trading-api/v1/markets",
    15_000
  );

const fetchDeribitInstruments = async (): Promise<DeribitInstrument[]> => {
  const res = await fetchJson<{ result: DeribitInstrument[] }>(
    "https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option"
  );
  return res.result.filter((i) => i.is_active !== false);
};

type Orderbook = {
  bids: Array<{ price: number; qty: number }>;
  asks: Array<{ price: number; qty: number }>;
};

const fetchBullishOrderbook = async (symbol: string): Promise<Orderbook | null> => {
  try {
    const raw = await fetchJson<{
      bids: Array<{ price: string; quantity?: string; priceLevelQuantity?: string }>;
      asks: Array<{ price: string; quantity?: string; priceLevelQuantity?: string }>;
    }>(
      `https://api.exchange.bullish.com/trading-api/v1/markets/${encodeURIComponent(symbol)}/orderbook/hybrid`
    );
    return {
      bids: raw.bids.map((b) => ({
        price: Number(b.price),
        qty: Number(b.priceLevelQuantity ?? b.quantity ?? 0)
      })),
      asks: raw.asks.map((a) => ({
        price: Number(a.price),
        qty: Number(a.priceLevelQuantity ?? a.quantity ?? 0)
      }))
    };
  } catch {
    return null;
  }
};

const fetchDeribitOrderbook = async (
  instrument: string
): Promise<{ ob: Orderbook; indexUsd: number } | null> => {
  try {
    const res = await fetchJson<{
      result: {
        bids?: Array<[number, number]>;
        asks?: Array<[number, number]>;
        index_price: number;
      };
    }>(
      `https://www.deribit.com/api/v2/public/get_order_book?instrument_name=${encodeURIComponent(instrument)}&depth=10`
    );
    return {
      indexUsd: res.result.index_price,
      ob: {
        bids: (res.result.bids ?? []).map(([p, q]) => ({ price: p, qty: q })),
        asks: (res.result.asks ?? []).map(([p, q]) => ({ price: p, qty: q }))
      }
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

type LegFill = {
  label: string;
  side: "buy_put" | "sell_put" | "sell_call" | "buy_call";
  targetStrike: number;
  actualStrike: number | null;
  symbol: string | null;
  bestBidUsd: number | null;
  bestAskUsd: number | null;
  bestBidQty: number;
  bestAskQty: number;
  fillPriceUsd: number | null; // crossing the spread
  spreadPct: number | null;
  notes: string[];
};

type PathResult = {
  pathName: string;
  notionalUsd: number;
  innerBandPct: number;
  outerBandPct: number;
  positionSizeBtc: number;
  expectedMargin: number;
  legs: LegFill[];
  ironCondorCostPerBtc: number | null;
  ironCondorCostUsd: number | null;
  costAmortizedPerDay: number | null;
  recommendedAtticusPremiumPerDay: number | null;
  foxify28DayCost: number | null;
  liquidityWarnings: string[];
};

const probePath = async (
  pathName: string,
  notional: number,
  innerPct: number,
  outerPct: number,
  spot: number,
  bullishMarkets: BullishMarket[],
  deribitInstruments: DeribitInstrument[],
  bullishExpiry: string
): Promise<{ bullish: PathResult; deribit: PathResult | null }> => {
  const positionSizeBtc = notional / spot;
  const innerPutTarget = spot * (1 - innerPct);
  const outerPutTarget = spot * (1 - outerPct);
  const innerCallTarget = spot * (1 + innerPct);
  const outerCallTarget = spot * (1 + outerPct);

  const expectedMargin = (outerPct - innerPct) * notional;

  // ───────── Bullish probe ─────────
  const bullishOpts = bullishMarkets.filter(
    (m) =>
      m.marketType === "OPTION" &&
      m.baseSymbol === "BTC" &&
      m.expiryDatetime === bullishExpiry
  );
  const bullishPuts = bullishOpts.filter((m) => m.optionType === "PUT");
  const bullishCalls = bullishOpts.filter((m) => m.optionType === "CALL");
  const bullishPutStrikes = Array.from(
    new Set(bullishPuts.map((m) => Number(m.optionStrikePrice)))
  )
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const bullishCallStrikes = Array.from(
    new Set(bullishCalls.map((m) => Number(m.optionStrikePrice)))
  )
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const probeBullishLeg = async (
    label: string,
    side: LegFill["side"],
    targetStrike: number,
    actualStrike: number | null,
    isPut: boolean
  ): Promise<LegFill> => {
    const result: LegFill = {
      label,
      side,
      targetStrike,
      actualStrike,
      symbol: null,
      bestBidUsd: null,
      bestAskUsd: null,
      bestBidQty: 0,
      bestAskQty: 0,
      fillPriceUsd: null,
      spreadPct: null,
      notes: []
    };
    if (actualStrike === null) {
      result.notes.push("no strike available");
      return result;
    }
    const market = (isPut ? bullishPuts : bullishCalls).find(
      (m) => Number(m.optionStrikePrice) === actualStrike
    );
    if (!market) {
      result.notes.push("no market found");
      return result;
    }
    result.symbol = market.symbol;
    const ob = await fetchBullishOrderbook(market.symbol);
    if (!ob) {
      result.notes.push("orderbook fetch failed");
      return result;
    }
    if (ob.bids[0]) {
      result.bestBidUsd = ob.bids[0].price;
      result.bestBidQty = ob.bids[0].qty;
    }
    if (ob.asks[0]) {
      result.bestAskUsd = ob.asks[0].price;
      result.bestAskQty = ob.asks[0].qty;
    }
    if (
      result.bestBidUsd !== null &&
      result.bestAskUsd !== null &&
      result.bestBidUsd > 0 &&
      result.bestAskUsd > 0
    ) {
      const mid = (result.bestBidUsd + result.bestAskUsd) / 2;
      result.spreadPct = ((result.bestAskUsd - result.bestBidUsd) / mid) * 100;
    }
    if (side === "buy_put" || side === "buy_call") {
      result.fillPriceUsd = result.bestAskUsd;
    } else {
      result.fillPriceUsd = result.bestBidUsd;
    }
    return result;
  };

  const innerPutClosest = findClosestStrike(innerPutTarget, bullishPutStrikes);
  const outerPutClosest = findClosestStrike(outerPutTarget, bullishPutStrikes);
  const innerCallClosest = findClosestStrike(innerCallTarget, bullishCallStrikes);
  const outerCallClosest = findClosestStrike(outerCallTarget, bullishCallStrikes);

  const bullishLegs: LegFill[] = await Promise.all([
    probeBullishLeg("Buy inner put", "buy_put", innerPutTarget, innerPutClosest, true),
    probeBullishLeg("Sell outer put", "sell_put", outerPutTarget, outerPutClosest, true),
    probeBullishLeg("Sell inner call", "sell_call", innerCallTarget, innerCallClosest, false),
    probeBullishLeg("Buy outer call", "buy_call", outerCallTarget, outerCallClosest, false)
  ]);

  const computePathCost = (legs: LegFill[]): { perBtc: number | null; usd: number | null } => {
    if (legs.some((l) => l.fillPriceUsd === null)) return { perBtc: null, usd: null };
    const buyInner = legs[0].fillPriceUsd!;
    const sellOuter = legs[1].fillPriceUsd!;
    const sellInnerCall = legs[2].fillPriceUsd!;
    const buyOuterCall = legs[3].fillPriceUsd!;
    const perBtc = buyInner - sellOuter - sellInnerCall + buyOuterCall;
    return { perBtc, usd: perBtc * positionSizeBtc };
  };

  const tenorDays = (new Date(bullishExpiry).getTime() - Date.now()) / (24 * 3600 * 1000);

  const bullishCost = computePathCost(bullishLegs);
  const bullishWarnings: string[] = [];
  for (const leg of bullishLegs) {
    if (leg.fillPriceUsd === null) {
      bullishWarnings.push(`${leg.label}: no fill available`);
    } else if (leg.spreadPct !== null && leg.spreadPct > 50) {
      bullishWarnings.push(
        `${leg.label}: VERY wide spread ${leg.spreadPct.toFixed(0)}% (illiquid — execution will be unreliable)`
      );
    }
    if (leg.actualStrike !== null && Math.abs(leg.actualStrike - leg.targetStrike) / leg.targetStrike > 0.03) {
      bullishWarnings.push(
        `${leg.label}: strike drift ${(((leg.actualStrike - leg.targetStrike) / leg.targetStrike) * 100).toFixed(1)}% off target`
      );
    }
    if (leg.bestBidQty + leg.bestAskQty < positionSizeBtc * 0.5) {
      bullishWarnings.push(
        `${leg.label}: shallow depth (${(leg.bestBidQty + leg.bestAskQty).toFixed(2)} BTC available, need ${positionSizeBtc.toFixed(2)})`
      );
    }
  }

  const bullishResult: PathResult = {
    pathName,
    notionalUsd: notional,
    innerBandPct: innerPct,
    outerBandPct: outerPct,
    positionSizeBtc,
    expectedMargin,
    legs: bullishLegs,
    ironCondorCostPerBtc: bullishCost.perBtc,
    ironCondorCostUsd: bullishCost.usd,
    costAmortizedPerDay: bullishCost.usd !== null ? bullishCost.usd / tenorDays : null,
    recommendedAtticusPremiumPerDay:
      bullishCost.usd !== null
        ? bullishCost.usd / tenorDays + 50 + 0.07 * (bullishCost.usd / tenorDays)
        : null,
    foxify28DayCost: null, // computed below
    liquidityWarnings: bullishWarnings
  };

  // ───────── Deribit probe (for comparison) ─────────
  const expiryTs = new Date(bullishExpiry).getTime();
  const deribitOpts = deribitInstruments.filter((i) => i.expiration_timestamp === expiryTs);

  let deribitResult: PathResult | null = null;
  if (deribitOpts.length > 0) {
    const deribitPuts = deribitOpts.filter((i) => i.option_type === "put");
    const deribitCalls = deribitOpts.filter((i) => i.option_type === "call");
    const deribitPutStrikes = Array.from(new Set(deribitPuts.map((i) => Number(i.strike))))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const deribitCallStrikes = Array.from(new Set(deribitCalls.map((i) => Number(i.strike))))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    const probeDeribitLeg = async (
      label: string,
      side: LegFill["side"],
      targetStrike: number,
      actualStrike: number | null,
      isPut: boolean
    ): Promise<LegFill> => {
      const result: LegFill = {
        label,
        side,
        targetStrike,
        actualStrike,
        symbol: null,
        bestBidUsd: null,
        bestAskUsd: null,
        bestBidQty: 0,
        bestAskQty: 0,
        fillPriceUsd: null,
        spreadPct: null,
        notes: []
      };
      if (actualStrike === null) {
        result.notes.push("no strike");
        return result;
      }
      const inst = (isPut ? deribitPuts : deribitCalls).find((i) => Number(i.strike) === actualStrike);
      if (!inst) {
        result.notes.push("no instrument found");
        return result;
      }
      result.symbol = inst.instrument_name;
      const fetched = await fetchDeribitOrderbook(inst.instrument_name);
      if (!fetched) {
        result.notes.push("orderbook fetch failed");
        return result;
      }
      const { ob, indexUsd } = fetched;
      if (ob.bids[0] && ob.bids[0].price > 0) {
        result.bestBidUsd = ob.bids[0].price * indexUsd;
        result.bestBidQty = ob.bids[0].qty;
      }
      if (ob.asks[0] && ob.asks[0].price > 0) {
        result.bestAskUsd = ob.asks[0].price * indexUsd;
        result.bestAskQty = ob.asks[0].qty;
      }
      if (
        result.bestBidUsd !== null &&
        result.bestAskUsd !== null &&
        result.bestBidUsd > 0 &&
        result.bestAskUsd > 0
      ) {
        const mid = (result.bestBidUsd + result.bestAskUsd) / 2;
        result.spreadPct = ((result.bestAskUsd - result.bestBidUsd) / mid) * 100;
      }
      if (side === "buy_put" || side === "buy_call") {
        result.fillPriceUsd = result.bestAskUsd;
      } else {
        result.fillPriceUsd = result.bestBidUsd;
      }
      return result;
    };

    const dInnerPut = findClosestStrike(innerPutTarget, deribitPutStrikes);
    const dOuterPut = findClosestStrike(outerPutTarget, deribitPutStrikes);
    const dInnerCall = findClosestStrike(innerCallTarget, deribitCallStrikes);
    const dOuterCall = findClosestStrike(outerCallTarget, deribitCallStrikes);

    const deribitLegs: LegFill[] = await Promise.all([
      probeDeribitLeg("Buy inner put", "buy_put", innerPutTarget, dInnerPut, true),
      probeDeribitLeg("Sell outer put", "sell_put", outerPutTarget, dOuterPut, true),
      probeDeribitLeg("Sell inner call", "sell_call", innerCallTarget, dInnerCall, false),
      probeDeribitLeg("Buy outer call", "buy_call", outerCallTarget, dOuterCall, false)
    ]);

    const deribitCost = computePathCost(deribitLegs);
    const deribitWarnings: string[] = [];
    for (const leg of deribitLegs) {
      if (leg.fillPriceUsd === null) deribitWarnings.push(`${leg.label}: no fill`);
      else if (leg.spreadPct !== null && leg.spreadPct > 50)
        deribitWarnings.push(`${leg.label}: wide spread ${leg.spreadPct.toFixed(0)}%`);
    }

    deribitResult = {
      pathName,
      notionalUsd: notional,
      innerBandPct: innerPct,
      outerBandPct: outerPct,
      positionSizeBtc,
      expectedMargin,
      legs: deribitLegs,
      ironCondorCostPerBtc: deribitCost.perBtc,
      ironCondorCostUsd: deribitCost.usd,
      costAmortizedPerDay: deribitCost.usd !== null ? deribitCost.usd / tenorDays : null,
      recommendedAtticusPremiumPerDay:
        deribitCost.usd !== null
          ? deribitCost.usd / tenorDays + 50 + 0.07 * (deribitCost.usd / tenorDays)
          : null,
      foxify28DayCost: null,
      liquidityWarnings: deribitWarnings
    };
  }

  // Compute Foxify 28-day cost (4 weekly covers)
  if (bullishResult.recommendedAtticusPremiumPerDay !== null) {
    bullishResult.foxify28DayCost = bullishResult.recommendedAtticusPremiumPerDay * 28;
  }
  if (deribitResult && deribitResult.recommendedAtticusPremiumPerDay !== null) {
    deribitResult.foxify28DayCost = deribitResult.recommendedAtticusPremiumPerDay * 28;
  }

  return { bullish: bullishResult, deribit: deribitResult };
};

const printPath = (result: PathResult, venue: string) => {
  console.log(`\n┌── ${venue} — ${result.pathName} ──`);
  console.log(`│ Notional: $${result.notionalUsd.toLocaleString()} (${result.positionSizeBtc.toFixed(4)} BTC)`);
  console.log(`│ Strikes:  ±${(result.innerBandPct * 100).toFixed(0)}% inner / ±${(result.outerBandPct * 100).toFixed(0)}% outer`);
  console.log(`│ Expected margin: $${result.expectedMargin.toLocaleString()}`);
  console.log("│");
  console.log("│ Legs:");
  for (const leg of result.legs) {
    const strikeStr =
      leg.actualStrike !== null
        ? `$${leg.actualStrike.toFixed(0).padStart(6)}`
        : "  N/A ";
    const bidStr = leg.bestBidUsd !== null ? `$${leg.bestBidUsd.toFixed(0).padStart(6)}` : "    n/a";
    const askStr = leg.bestAskUsd !== null ? `$${leg.bestAskUsd.toFixed(0).padStart(6)}` : "    n/a";
    const spreadStr = leg.spreadPct !== null ? `${leg.spreadPct.toFixed(0).padStart(3)}%` : " n/a";
    const depthStr = `${leg.bestBidQty.toFixed(1)}/${leg.bestAskQty.toFixed(1)} BTC`;
    const fillStr =
      leg.fillPriceUsd !== null ? `$${leg.fillPriceUsd.toFixed(0).padStart(5)}` : "   n/a";
    console.log(
      `│   ${leg.label.padEnd(17)} ${strikeStr} | bid ${bidStr} ask ${askStr} (sp ${spreadStr}, depth ${depthStr.padEnd(14)}) → fill ${fillStr}`
    );
  }
  console.log("│");
  if (result.ironCondorCostUsd !== null) {
    console.log(`│ Iron condor cost (cross spread): $${result.ironCondorCostUsd.toFixed(2)} for ${result.positionSizeBtc.toFixed(4)} BTC`);
    console.log(`│ Per day amortized:  $${result.costAmortizedPerDay!.toFixed(2)}/day`);
    console.log(`│ Recommended Atticus premium: $${result.recommendedAtticusPremiumPerDay!.toFixed(2)}/day`);
    console.log(`│ Foxify 28-day cost: $${result.foxify28DayCost!.toFixed(2)}`);
  } else {
    console.log("│ Cannot compute total cost — some legs unavailable.");
  }
  console.log("│");
  if (result.liquidityWarnings.length === 0) {
    console.log("│ ✓ All legs viable, no major liquidity concerns.");
  } else {
    console.log("│ ⚠ Liquidity issues:");
    for (const w of result.liquidityWarnings) console.log(`│   - ${w}`);
  }
  console.log(`└─────────`);
};

const main = async () => {
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("Iron Condor — FINAL VERIFICATION PROBE");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  const spot = await fetchSpotUsd();
  console.log(`Spot: $${spot.toLocaleString()}`);
  console.log("");

  console.log("Fetching live markets from Bullish + Deribit...");
  const [bullishMarkets, deribitInstruments] = await Promise.all([
    fetchBullishMarkets(),
    fetchDeribitInstruments()
  ]);
  console.log(`Bullish: ${bullishMarkets.length} markets`);
  console.log(`Deribit: ${deribitInstruments.length} BTC option instruments`);

  // Find next weekly expiry on Bullish (target ~7 days out)
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
    const tenorDays = (new Date(e).getTime() - Date.now()) / (24 * 3600 * 1000);
    if (tenorDays >= 5 && tenorDays <= 10) {
      weeklyExpiry = e;
      break;
    }
  }
  if (!weeklyExpiry) {
    console.error("No suitable weekly Bullish expiry found.");
    process.exit(1);
  }
  const tenorDays = (new Date(weeklyExpiry).getTime() - Date.now()) / (24 * 3600 * 1000);
  console.log(`\nWeekly expiry selected: ${weeklyExpiry} (${tenorDays.toFixed(1)} days)`);
  console.log("");

  // Run both paths
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("PATH 1: $300k notional, ±7%/±12%, weekly");
  console.log("═══════════════════════════════════════════════════════════════════════");
  const path1 = await probePath(
    "Path 1 (small)",
    300_000,
    0.07,
    0.12,
    spot,
    bullishMarkets,
    deribitInstruments,
    weeklyExpiry
  );
  printPath(path1.bullish, "BULLISH");
  if (path1.deribit) printPath(path1.deribit, "DERIBIT (comparison)");

  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("PATH 2: $800k notional, ±7%/±15%, weekly");
  console.log("═══════════════════════════════════════════════════════════════════════");
  const path2 = await probePath(
    "Path 2 (full)",
    800_000,
    0.07,
    0.15,
    spot,
    bullishMarkets,
    deribitInstruments,
    weeklyExpiry
  );
  printPath(path2.bullish, "BULLISH");
  if (path2.deribit) printPath(path2.deribit, "DERIBIT (comparison)");

  // Final summary
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("FINAL VERDICT");
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("");
  for (const [name, result] of [
    ["Path 1 Bullish", path1.bullish],
    ["Path 1 Deribit", path1.deribit],
    ["Path 2 Bullish", path2.bullish],
    ["Path 2 Deribit", path2.deribit]
  ] as const) {
    if (!result) continue;
    const verdict =
      result.ironCondorCostUsd === null
        ? "❌ NOT EXECUTABLE"
        : result.liquidityWarnings.length > 2
          ? "⚠ EXECUTABLE BUT POOR LIQUIDITY"
          : "✓ EXECUTABLE";
    const cost =
      result.foxify28DayCost !== null
        ? `Foxify 28-day cost ~$${result.foxify28DayCost.toFixed(0)}`
        : "n/a";
    console.log(`  ${name.padEnd(18)} ${verdict.padEnd(38)} | ${cost}`);
  }
  console.log("");
};

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
