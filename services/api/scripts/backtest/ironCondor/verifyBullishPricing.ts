/**
 * Iron Condor Live Pricing Probe — verify Bullish chain pricing.
 *
 * Pulls Bullish 1-day BTC option chain near ±7% and ±15% strikes from current
 * spot, computes the actual iron condor cost from live order books, compares
 * to my Black-Scholes model assumption.
 *
 * Output: console table with verified pricing for the proposed Foxify
 * Volume Facility iron condor product.
 *
 * Usage:
 *   cd services/api
 *   npx tsx scripts/backtest/ironCondor/verifyBullishPricing.ts
 *
 * Public-endpoint scraper. NO AUTH. No production impact.
 */

import { bsPut, bsCall } from "../../../src/pilot/blackScholes";

const NOTIONAL_USD = 800_000;
const INNER_BAND_PCT = 0.07;
const OUTER_BAND_PCT = 0.15;

type BullishLevel = { price: string; quantity?: string; priceLevelQuantity?: string };
type BullishOrderbook = { bids: BullishLevel[]; asks: BullishLevel[] };

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

const fetchDvol = async (): Promise<number | null> => {
  try {
    const now = Date.now();
    const res = await fetchJson<{ result: { data: number[][] } }>(
      `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${now - 3600_000}&end_timestamp=${now}&resolution=60`
    );
    const last = res.result.data[res.result.data.length - 1];
    return last && Number.isFinite(last[1]) ? Number(last[1]) : null;
  } catch {
    return null;
  }
};

type BullishMarket = {
  marketType: string;
  baseSymbol: string;
  symbol: string;
  optionStrikePrice?: string;
  optionType?: string;
  expiryDatetime?: string;
};

const fetchBullishMarkets = async (): Promise<BullishMarket[]> => {
  return await fetchJson<BullishMarket[]>(
    "https://api.exchange.bullish.com/trading-api/v1/markets",
    15_000
  );
};

const fetchBullishOrderbook = async (symbol: string): Promise<BullishOrderbook | null> => {
  try {
    return await fetchJson<BullishOrderbook>(
      `https://api.exchange.bullish.com/trading-api/v1/markets/${encodeURIComponent(symbol)}/orderbook/hybrid`
    );
  } catch (err) {
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

const computeNextExpiry = (now: Date): { iso: string; bullishDate: string } => {
  const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 0, 0));
  if (candidate.getTime() < now.getTime() + 4 * 3600_000) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return {
    iso: candidate.toISOString(),
    bullishDate: `${candidate.getUTCFullYear()}${String(candidate.getUTCMonth() + 1).padStart(2, "0")}${String(candidate.getUTCDate()).padStart(2, "0")}`
  };
};

type LegResult = {
  label: string;
  side: "buy_put" | "sell_put" | "sell_call" | "buy_call";
  targetStrike: number;
  actualStrike: number | null;
  symbol: string | null;
  bestBidUsd: number | null;
  bestAskUsd: number | null;
  bestBidQty: number | null;
  bestAskQty: number | null;
  spreadPct: number | null;
  midUsd: number | null;
  depthAt2pct: number | null; // qty available within 2% of mid
  fillPriceForLeg: number | null; // Atticus's expected fill price
  bsModelPriceUsd: number | null; // BS predicted price for comparison
  notes: string[];
};

const main = async () => {
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("Iron Condor Live Pricing Probe — Bullish Verification");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  const spot = await fetchSpotUsd();
  const dvol = await fetchDvol();
  const expiry = computeNextExpiry(new Date());
  const tEarly = (new Date(expiry.iso).getTime() - Date.now()) / (365.25 * 24 * 3600 * 1000);

  console.log(`Spot:          $${spot.toLocaleString()}`);
  console.log(`DVOL:          ${dvol !== null ? dvol.toFixed(1) : "n/a"}`);
  console.log(`Next expiry:   ${expiry.iso} (${(tEarly * 365.25 * 24).toFixed(1)} hours)`);
  console.log(`Notional:      $${NOTIONAL_USD.toLocaleString()} (${(NOTIONAL_USD / spot).toFixed(4)} BTC)`);
  console.log("");

  // Compute target strikes
  const targetInnerPut = spot * (1 - INNER_BAND_PCT);
  const targetOuterPut = spot * (1 - OUTER_BAND_PCT);
  const targetInnerCall = spot * (1 + INNER_BAND_PCT);
  const targetOuterCall = spot * (1 + OUTER_BAND_PCT);

  console.log("TARGET STRIKES");
  console.log("──────────────");
  console.log(`Inner put (-7% buy):    $${targetInnerPut.toFixed(0)}`);
  console.log(`Outer put (-15% sell):  $${targetOuterPut.toFixed(0)}`);
  console.log(`Inner call (+7% sell):  $${targetInnerCall.toFixed(0)}`);
  console.log(`Outer call (+15% buy):  $${targetOuterCall.toFixed(0)}`);
  console.log("");

  // Pull Bullish markets
  console.log("Fetching Bullish markets...");
  let allMarkets: BullishMarket[];
  try {
    allMarkets = await fetchBullishMarkets();
  } catch (err: any) {
    console.error(`FAILED: ${err.message}`);
    console.error("Cannot reach Bullish API. Likely geo-restricted from this network.");
    console.error("Backtest cannot proceed without venue access. Try from US/EU IP.");
    process.exit(1);
  }
  console.log(`Got ${allMarkets.length} markets.`);

  // Filter to BTC options expiring next day
  const bullishExpiryIso = `${expiry.iso.slice(0, 10)}T08:00:00.000Z`;
  const dayOptions = allMarkets.filter((m) => {
    return (
      m.marketType === "OPTION" &&
      m.baseSymbol === "BTC" &&
      m.expiryDatetime === bullishExpiryIso
    );
  });
  console.log(`BTC options expiring at ${bullishExpiryIso}: ${dayOptions.length}`);

  if (dayOptions.length === 0) {
    // Try other available expiries
    const allBtcOptions = allMarkets.filter((m) => m.marketType === "OPTION" && m.baseSymbol === "BTC");
    console.log(`No options for target expiry. All BTC option expiries available:`);
    const expiries = Array.from(new Set(allBtcOptions.map((m) => m.expiryDatetime))).sort();
    for (const e of expiries.slice(0, 10)) console.log(`  ${e}`);
    if (allBtcOptions.length > 0) {
      console.log(`(...and ${expiries.length - 10} more)`);
    } else {
      console.log("  No BTC options found at all.");
    }
    process.exit(1);
  }

  // Available strikes for puts and calls
  const puts = dayOptions.filter((m) => m.optionType === "PUT");
  const calls = dayOptions.filter((m) => m.optionType === "CALL");
  const putStrikes = Array.from(new Set(puts.map((m) => Number(m.optionStrikePrice))))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const callStrikes = Array.from(new Set(calls.map((m) => Number(m.optionStrikePrice))))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  console.log(`Put strikes available:  ${putStrikes.length} (range ${putStrikes[0]} - ${putStrikes[putStrikes.length - 1]})`);
  console.log(`Call strikes available: ${callStrikes.length} (range ${callStrikes[0]} - ${callStrikes[callStrikes.length - 1]})`);
  console.log("");

  // Find closest strikes for our 4 legs
  const closestInnerPut = findClosestStrike(targetInnerPut, putStrikes);
  const closestOuterPut = findClosestStrike(targetOuterPut, putStrikes);
  const closestInnerCall = findClosestStrike(targetInnerCall, callStrikes);
  const closestOuterCall = findClosestStrike(targetOuterCall, callStrikes);

  // Probe each leg's orderbook
  const probeLeg = async (
    label: string,
    side: "buy_put" | "sell_put" | "sell_call" | "buy_call",
    targetStrike: number,
    actualStrike: number | null,
    optionMarkets: BullishMarket[]
  ): Promise<LegResult> => {
    const result: LegResult = {
      label,
      side,
      targetStrike,
      actualStrike,
      symbol: null,
      bestBidUsd: null,
      bestAskUsd: null,
      bestBidQty: null,
      bestAskQty: null,
      spreadPct: null,
      midUsd: null,
      depthAt2pct: null,
      fillPriceForLeg: null,
      bsModelPriceUsd: null,
      notes: []
    };

    if (actualStrike === null) {
      result.notes.push("no strike available");
      return result;
    }

    // Find the matching market
    const market = optionMarkets.find((m) => Number(m.optionStrikePrice) === actualStrike);
    if (!market) {
      result.notes.push(`no market for strike ${actualStrike}`);
      return result;
    }
    result.symbol = market.symbol;

    const ob = await fetchBullishOrderbook(market.symbol);
    if (!ob) {
      result.notes.push("orderbook fetch failed");
      return result;
    }

    const bestBid = ob.bids[0];
    const bestAsk = ob.asks[0];

    if (bestBid) {
      result.bestBidUsd = Number(bestBid.price);
      result.bestBidQty = Number(bestBid.priceLevelQuantity ?? bestBid.quantity ?? 0);
    }
    if (bestAsk) {
      result.bestAskUsd = Number(bestAsk.price);
      result.bestAskQty = Number(bestAsk.priceLevelQuantity ?? bestAsk.quantity ?? 0);
    }

    if (result.bestBidUsd !== null && result.bestAskUsd !== null && result.bestBidUsd > 0 && result.bestAskUsd > 0) {
      result.midUsd = (result.bestBidUsd + result.bestAskUsd) / 2;
      result.spreadPct = ((result.bestAskUsd - result.bestBidUsd) / result.midUsd) * 100;
    }

    // Compute depth within 2% of mid
    if (result.midUsd !== null) {
      const midThresholdHigh = result.midUsd * 1.02;
      const midThresholdLow = result.midUsd * 0.98;
      let totalDepth = 0;
      if (side === "buy_put" || side === "buy_call") {
        // Atticus needs to buy → looking at asks
        for (const lvl of ob.asks) {
          if (Number(lvl.price) <= midThresholdHigh) {
            totalDepth += Number(lvl.priceLevelQuantity ?? lvl.quantity ?? 0);
          }
        }
      } else {
        // Atticus needs to sell → looking at bids
        for (const lvl of ob.bids) {
          if (Number(lvl.price) >= midThresholdLow) {
            totalDepth += Number(lvl.priceLevelQuantity ?? lvl.quantity ?? 0);
          }
        }
      }
      result.depthAt2pct = totalDepth;
    }

    // Atticus's expected fill price (assume crossing the spread)
    if (side === "buy_put" || side === "buy_call") {
      result.fillPriceForLeg = result.bestAskUsd;
    } else {
      result.fillPriceForLeg = result.bestBidUsd;
    }

    // BS model comparison
    if (dvol !== null && actualStrike) {
      const sigma = dvol / 100;
      const isPut = side === "buy_put" || side === "sell_put";
      const bsPrice = isPut
        ? bsPut(spot, actualStrike, tEarly, 0, sigma)
        : bsCall(spot, actualStrike, tEarly, 0, sigma);
      result.bsModelPriceUsd = bsPrice;
    }

    return result;
  };

  console.log("Probing 4 legs of iron condor...\n");

  const legs: LegResult[] = await Promise.all([
    probeLeg("Buy inner put (-7%)", "buy_put", targetInnerPut, closestInnerPut, puts),
    probeLeg("Sell outer put (-15%)", "sell_put", targetOuterPut, closestOuterPut, puts),
    probeLeg("Sell inner call (+7%)", "sell_call", targetInnerCall, closestInnerCall, calls),
    probeLeg("Buy outer call (+15%)", "buy_call", targetOuterCall, closestOuterCall, calls)
  ]);

  // Print per-leg
  console.log("LEG-BY-LEG ANALYSIS");
  console.log("───────────────────");
  console.log(`Leg                       | Strike  | Best Bid | Best Ask | Spread% | Depth@2% | Fill   | BS Model`);
  console.log(`--------------------------+---------+----------+----------+---------+----------+--------+---------`);
  for (const leg of legs) {
    const strikeStr = leg.actualStrike !== null ? `$${leg.actualStrike.toFixed(0).padStart(5)}` : "  N/A ";
    const bidStr = leg.bestBidUsd !== null ? `$${leg.bestBidUsd.toFixed(0).padStart(7)}` : "    n/a";
    const askStr = leg.bestAskUsd !== null ? `$${leg.bestAskUsd.toFixed(0).padStart(7)}` : "    n/a";
    const spreadStr = leg.spreadPct !== null ? `${leg.spreadPct.toFixed(1).padStart(5)}%` : "    n/a";
    const depthStr = leg.depthAt2pct !== null ? `${leg.depthAt2pct.toFixed(2).padStart(7)}` : "    n/a";
    const fillStr = leg.fillPriceForLeg !== null ? `$${leg.fillPriceForLeg.toFixed(0).padStart(5)}` : "   n/a";
    const bsStr = leg.bsModelPriceUsd !== null ? `$${leg.bsModelPriceUsd.toFixed(0).padStart(6)}` : "    n/a";
    console.log(`${leg.label.padEnd(25)} | ${strikeStr} | ${bidStr} | ${askStr} | ${spreadStr} | ${depthStr} | ${fillStr} | ${bsStr}`);
  }
  console.log("");

  // Compute iron condor cost from real fills
  console.log("IRON CONDOR COST CALCULATION (per BTC)");
  console.log("───────────────────────────────────────");
  const buyInnerPut = legs[0].fillPriceForLeg;
  const sellOuterPut = legs[1].fillPriceForLeg;
  const sellInnerCall = legs[2].fillPriceForLeg;
  const buyOuterCall = legs[3].fillPriceForLeg;
  const buyInnerPutBs = legs[0].bsModelPriceUsd;
  const sellOuterPutBs = legs[1].bsModelPriceUsd;
  const sellInnerCallBs = legs[2].bsModelPriceUsd;
  const buyOuterCallBs = legs[3].bsModelPriceUsd;

  if (buyInnerPut === null || sellOuterPut === null || sellInnerCall === null || buyOuterCall === null) {
    console.log("Cannot compute net cost — some legs unavailable.");
    console.log("Implications: outer wings (±15%) likely too sparse on Bullish for this product.");
  } else {
    const liveCostPerBtc = buyInnerPut - sellOuterPut - sellInnerCall + buyOuterCall;
    const bsCostPerBtc = (buyInnerPutBs ?? 0) - (sellOuterPutBs ?? 0) - (sellInnerCallBs ?? 0) + (buyOuterCallBs ?? 0);
    const positionSizeBtc = NOTIONAL_USD / spot;
    const liveCostUsd = liveCostPerBtc * positionSizeBtc;
    const bsCostUsd = bsCostPerBtc * positionSizeBtc;

    console.log(`Live (cross spread):  $${liveCostPerBtc.toFixed(2).padStart(8)} per BTC = $${liveCostUsd.toFixed(2).padStart(8)} for $800k notional`);
    console.log(`BS model:             $${bsCostPerBtc.toFixed(2).padStart(8)} per BTC = $${bsCostUsd.toFixed(2).padStart(8)} for $800k notional`);
    console.log(`Live vs BS delta:     $${(liveCostUsd - bsCostUsd).toFixed(2).padStart(8)} (positive = live more expensive than BS)`);
    console.log("");

    // Bid-ask round-trip estimate
    let bidAskCost = 0;
    for (const leg of legs) {
      if (leg.spreadPct !== null && leg.midUsd !== null) {
        const halfSpreadPerBtc = (leg.midUsd * leg.spreadPct) / 200; // crossing half spread
        bidAskCost += halfSpreadPerBtc * (NOTIONAL_USD / spot);
      }
    }
    console.log(`Bid-ask cost (4 legs round trip on $800k notional): $${bidAskCost.toFixed(2)}`);
    console.log("");

    // Updated profit math
    console.log("ATTICUS PROFITABILITY CHECK");
    console.log("───────────────────────────");
    const dailyHedgeCostUsd = liveCostUsd > 0 ? liveCostUsd : 0;
    const dailyHedgeCreditUsd = liveCostUsd < 0 ? -liveCostUsd : 0;
    console.log(`Daily hedge net cost (positive = Atticus pays):  $${liveCostUsd.toFixed(2)}`);
    console.log(`Static daily friction (estimated):                $25.00`);
    console.log(`Triggered-day friction (avg):                     $30.00`);
    console.log(`Total expected daily friction:                    $${(25 + 30 + Math.max(0, liveCostUsd)).toFixed(2)}`);
    console.log("");

    for (const premium of [200, 250, 300, 400]) {
      const dailyProfit = premium - 25 - 30 - Math.max(0, liveCostUsd) + Math.max(0, -liveCostUsd);
      const periodProfit = dailyProfit * 28;
      console.log(`Premium $${premium}/day → expected daily profit $${dailyProfit.toFixed(2)} → 28-day profit $${periodProfit.toFixed(0)}`);
    }
  }

  // Identify gaps
  console.log("");
  console.log("STRIKE COVERAGE ASSESSMENT");
  console.log("──────────────────────────");
  const gaps: string[] = [];
  for (const leg of legs) {
    if (leg.actualStrike === null) {
      gaps.push(`${leg.label}: NO STRIKE AVAILABLE within range`);
    } else if (Math.abs(leg.actualStrike - leg.targetStrike) / leg.targetStrike > 0.005) {
      gaps.push(
        `${leg.label}: target $${leg.targetStrike.toFixed(0)}, actual $${leg.actualStrike.toFixed(0)} (drift ${((100 * (leg.actualStrike - leg.targetStrike)) / leg.targetStrike).toFixed(2)}%)`
      );
    }
    if (leg.bestBidUsd === null || leg.bestAskUsd === null) {
      gaps.push(`${leg.label}: NO ORDERBOOK (no liquidity)`);
    } else if (leg.spreadPct !== null && leg.spreadPct > 30) {
      gaps.push(`${leg.label}: WIDE SPREAD ${leg.spreadPct.toFixed(1)}% (illiquid)`);
    }
    if (leg.depthAt2pct !== null && leg.depthAt2pct < (NOTIONAL_USD / spot) * 0.5) {
      gaps.push(`${leg.label}: SHALLOW DEPTH ${leg.depthAt2pct.toFixed(2)} BTC available within 2%`);
    }
  }

  if (gaps.length === 0) {
    console.log("✓ All 4 legs have adequate strike availability and liquidity on Bullish.");
  } else {
    console.log("⚠ Issues identified:");
    for (const g of gaps) console.log(`  - ${g}`);
  }
  console.log("");
};

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
