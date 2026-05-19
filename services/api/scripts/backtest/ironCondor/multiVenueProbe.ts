/**
 * Iron Condor — Multi-venue, multi-tenor probe to find a usable strike grid.
 *
 * Bullish 1-day options proved too sparse (±5% strike radius only). This
 * probe checks:
 *   1. Bullish 7-day options (wider strike availability)
 *   2. Deribit 1-day options
 *   3. Deribit 7-day options
 * To identify the venue + tenor combination that supports the ±7%/±15%
 * iron condor structure.
 */

import { bsPut, bsCall } from "../../../src/pilot/blackScholes";

const NOTIONAL_USD = 800_000;
const INNER_BAND_PCT = 0.07;
const OUTER_BAND_PCT = 0.15;

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

const fetchBullishMarkets = async (): Promise<BullishMarket[]> => {
  return await fetchJson<BullishMarket[]>(
    "https://api.exchange.bullish.com/trading-api/v1/markets",
    15_000
  );
};

const fetchDeribitInstruments = async (): Promise<DeribitInstrument[]> => {
  const res = await fetchJson<{ result: DeribitInstrument[] }>(
    "https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option"
  );
  return res.result.filter((i) => i.is_active !== false);
};

const fetchDeribitOrderbook = async (instrument: string) => {
  try {
    const res = await fetchJson<{ result: { best_bid_price: number; best_ask_price: number; index_price: number } }>(
      `https://www.deribit.com/api/v2/public/get_order_book?instrument_name=${encodeURIComponent(instrument)}`
    );
    return res.result;
  } catch {
    return null;
  }
};

const fetchBullishOrderbook = async (symbol: string) => {
  try {
    return await fetchJson<{ bids: Array<{ price: string; quantity?: string; priceLevelQuantity?: string }>; asks: Array<{ price: string; quantity?: string; priceLevelQuantity?: string }> }>(
      `https://api.exchange.bullish.com/trading-api/v1/markets/${encodeURIComponent(symbol)}/orderbook/hybrid`
    );
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

type VenueResult = {
  venueName: string;
  tenorDays: number;
  expiryIso: string;
  putStrikes: number[];
  callStrikes: number[];
  innerPutClosest: number | null;
  outerPutClosest: number | null;
  innerCallClosest: number | null;
  outerCallClosest: number | null;
  innerPutDriftPct: number;
  outerPutDriftPct: number;
  innerCallDriftPct: number;
  outerCallDriftPct: number;
  fillsAvailable: boolean;
  netCondorCostUsd: number | null;
  notes: string[];
};

const analyzeStrikeGrid = (
  spot: number,
  putStrikes: number[],
  callStrikes: number[],
  venueName: string,
  tenorDays: number,
  expiryIso: string
): VenueResult => {
  const innerPutTarget = spot * (1 - INNER_BAND_PCT);
  const outerPutTarget = spot * (1 - OUTER_BAND_PCT);
  const innerCallTarget = spot * (1 + INNER_BAND_PCT);
  const outerCallTarget = spot * (1 + OUTER_BAND_PCT);

  const innerPutClosest = findClosestStrike(innerPutTarget, putStrikes);
  const outerPutClosest = findClosestStrike(outerPutTarget, putStrikes);
  const innerCallClosest = findClosestStrike(innerCallTarget, callStrikes);
  const outerCallClosest = findClosestStrike(outerCallTarget, callStrikes);

  const innerPutDrift = innerPutClosest !== null ? ((innerPutClosest - innerPutTarget) / innerPutTarget) * 100 : NaN;
  const outerPutDrift = outerPutClosest !== null ? ((outerPutClosest - outerPutTarget) / outerPutTarget) * 100 : NaN;
  const innerCallDrift = innerCallClosest !== null ? ((innerCallClosest - innerCallTarget) / innerCallTarget) * 100 : NaN;
  const outerCallDrift = outerCallClosest !== null ? ((outerCallClosest - outerCallTarget) / outerCallTarget) * 100 : NaN;

  const notes: string[] = [];
  // Strike drift acceptance: within 2% of target is acceptable for inner, 3% for outer
  let strikeOk = true;
  if (innerPutClosest === null) {
    notes.push("inner put: no strike");
    strikeOk = false;
  } else if (Math.abs(innerPutDrift) > 2) {
    notes.push(`inner put: drift ${innerPutDrift.toFixed(1)}%`);
    if (Math.abs(innerPutDrift) > 5) strikeOk = false;
  }
  if (outerPutClosest === null) {
    notes.push("outer put: no strike");
    strikeOk = false;
  } else if (Math.abs(outerPutDrift) > 3) {
    notes.push(`outer put: drift ${outerPutDrift.toFixed(1)}%`);
    if (Math.abs(outerPutDrift) > 5) strikeOk = false;
  }
  if (innerCallClosest === null) {
    notes.push("inner call: no strike");
    strikeOk = false;
  } else if (Math.abs(innerCallDrift) > 2) {
    notes.push(`inner call: drift ${innerCallDrift.toFixed(1)}%`);
    if (Math.abs(innerCallDrift) > 5) strikeOk = false;
  }
  if (outerCallClosest === null) {
    notes.push("outer call: no strike");
    strikeOk = false;
  } else if (Math.abs(outerCallDrift) > 3) {
    notes.push(`outer call: drift ${outerCallDrift.toFixed(1)}%`);
    if (Math.abs(outerCallDrift) > 5) strikeOk = false;
  }

  return {
    venueName,
    tenorDays,
    expiryIso,
    putStrikes,
    callStrikes,
    innerPutClosest,
    outerPutClosest,
    innerCallClosest,
    outerCallClosest,
    innerPutDriftPct: innerPutDrift,
    outerPutDriftPct: outerPutDrift,
    innerCallDriftPct: innerCallDrift,
    outerCallDriftPct: outerCallDrift,
    fillsAvailable: strikeOk,
    netCondorCostUsd: null,
    notes
  };
};

const main = async () => {
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("Iron Condor — Multi-venue / multi-tenor strike availability check");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  const spot = await fetchSpotUsd();
  console.log(`Spot:          $${spot.toLocaleString()}`);
  console.log(`Notional:      $${NOTIONAL_USD.toLocaleString()}`);
  console.log(`Inner band:    ±${(INNER_BAND_PCT * 100).toFixed(0)}%`);
  console.log(`Outer band:    ±${(OUTER_BAND_PCT * 100).toFixed(0)}%`);
  console.log(`Target strikes: inner put $${(spot * (1 - INNER_BAND_PCT)).toFixed(0)}, outer put $${(spot * (1 - OUTER_BAND_PCT)).toFixed(0)}, inner call $${(spot * (1 + INNER_BAND_PCT)).toFixed(0)}, outer call $${(spot * (1 + OUTER_BAND_PCT)).toFixed(0)}`);
  console.log("");

  // Fetch all instruments from both venues
  console.log("Fetching all available instruments...");
  const bullishMarkets = await fetchBullishMarkets();
  const deribitInstruments = await fetchDeribitInstruments();
  console.log(`Bullish: ${bullishMarkets.length} markets`);
  console.log(`Deribit: ${deribitInstruments.length} BTC option instruments`);
  console.log("");

  // ═══ Bullish: group by expiry ═══
  console.log("BULLISH AVAILABLE BTC OPTION EXPIRIES");
  console.log("──────────────────────────────────────");
  const bullishExpiries = new Set<string>();
  for (const m of bullishMarkets) {
    if (m.marketType === "OPTION" && m.baseSymbol === "BTC" && m.expiryDatetime) {
      bullishExpiries.add(m.expiryDatetime);
    }
  }
  const sortedBullishExpiries = Array.from(bullishExpiries).sort();
  for (const e of sortedBullishExpiries.slice(0, 10)) {
    const tenorDays = (new Date(e).getTime() - Date.now()) / (24 * 3600 * 1000);
    const optionsAtThisExpiry = bullishMarkets.filter(
      (m) => m.marketType === "OPTION" && m.baseSymbol === "BTC" && m.expiryDatetime === e
    );
    console.log(`  ${e} (${tenorDays.toFixed(1)}d) — ${optionsAtThisExpiry.length} options`);
  }
  console.log("");

  // ═══ Deribit: group by expiry ═══
  console.log("DERIBIT AVAILABLE BTC OPTION EXPIRIES (next 10)");
  console.log("───────────────────────────────────────────────");
  const deribitExpiries = new Map<number, number>();
  for (const i of deribitInstruments) {
    if (i.expiration_timestamp) {
      deribitExpiries.set(i.expiration_timestamp, (deribitExpiries.get(i.expiration_timestamp) ?? 0) + 1);
    }
  }
  const sortedDeribitExpiries = Array.from(deribitExpiries.keys()).sort();
  for (const ts of sortedDeribitExpiries.slice(0, 10)) {
    const date = new Date(ts);
    const tenorDays = (ts - Date.now()) / (24 * 3600 * 1000);
    console.log(`  ${date.toISOString()} (${tenorDays.toFixed(1)}d) — ${deribitExpiries.get(ts)} options`);
  }
  console.log("");

  // ═══ Analyze each venue/tenor combination ═══
  const results: VenueResult[] = [];

  // Bullish: each available expiry up to 30 days
  for (const expiry of sortedBullishExpiries) {
    const tenorDays = (new Date(expiry).getTime() - Date.now()) / (24 * 3600 * 1000);
    if (tenorDays < 0.1 || tenorDays > 35) continue;
    const opts = bullishMarkets.filter(
      (m) => m.marketType === "OPTION" && m.baseSymbol === "BTC" && m.expiryDatetime === expiry
    );
    const puts = opts.filter((o) => o.optionType === "PUT").map((o) => Number(o.optionStrikePrice)).filter(Number.isFinite);
    const calls = opts.filter((o) => o.optionType === "CALL").map((o) => Number(o.optionStrikePrice)).filter(Number.isFinite);
    const putStrikes = Array.from(new Set(puts)).sort((a, b) => a - b);
    const callStrikes = Array.from(new Set(calls)).sort((a, b) => a - b);
    results.push(analyzeStrikeGrid(spot, putStrikes, callStrikes, "Bullish", tenorDays, expiry));
  }

  // Deribit: each available expiry up to 30 days
  for (const ts of sortedDeribitExpiries) {
    const tenorDays = (ts - Date.now()) / (24 * 3600 * 1000);
    if (tenorDays < 0.1 || tenorDays > 35) continue;
    const opts = deribitInstruments.filter((i) => i.expiration_timestamp === ts);
    const puts = opts.filter((o) => o.option_type === "put").map((o) => Number(o.strike)).filter(Number.isFinite);
    const calls = opts.filter((o) => o.option_type === "call").map((o) => Number(o.strike)).filter(Number.isFinite);
    const putStrikes = Array.from(new Set(puts)).sort((a, b) => a - b);
    const callStrikes = Array.from(new Set(calls)).sort((a, b) => a - b);
    results.push(analyzeStrikeGrid(spot, putStrikes, callStrikes, "Deribit", tenorDays, new Date(ts).toISOString()));
  }

  // ═══ Print summary table ═══
  console.log("STRIKE AVAILABILITY ACROSS VENUE/TENOR COMBINATIONS");
  console.log("─────────────────────────────────────────────────────────────────────────────────");
  console.log("Venue   | Tenor | Inner Put           | Outer Put           | Inner Call          | Outer Call          | Status");
  console.log("--------+-------+---------------------+---------------------+---------------------+---------------------+-------");
  for (const r of results) {
    const targetIp = (spot * (1 - INNER_BAND_PCT)).toFixed(0);
    const targetOp = (spot * (1 - OUTER_BAND_PCT)).toFixed(0);
    const targetIc = (spot * (1 + INNER_BAND_PCT)).toFixed(0);
    const targetOc = (spot * (1 + OUTER_BAND_PCT)).toFixed(0);

    const fmt = (closest: number | null, target: string, drift: number) => {
      if (closest === null) return `   N/A (target $${target})`;
      const driftStr = isFinite(drift) ? `${drift >= 0 ? "+" : ""}${drift.toFixed(1)}%` : "n/a";
      return `$${closest.toFixed(0)} (${driftStr})`.padEnd(19);
    };

    const status = r.fillsAvailable ? "✓ OK" : "✗ FAIL";
    console.log(
      `${r.venueName.padEnd(7)} | ${r.tenorDays.toFixed(1).padStart(4)}d | ${fmt(r.innerPutClosest, targetIp, r.innerPutDriftPct)} | ${fmt(r.outerPutClosest, targetOp, r.outerPutDriftPct)} | ${fmt(r.innerCallClosest, targetIc, r.innerCallDriftPct)} | ${fmt(r.outerCallClosest, targetOc, r.outerCallDriftPct)} | ${status}`
    );
  }
  console.log("");

  // ═══ For viable combinations, fetch live order books and price the spread ═══
  const viableResults = results.filter((r) => r.fillsAvailable);
  console.log(`VIABLE COMBINATIONS: ${viableResults.length}`);
  console.log("");

  if (viableResults.length === 0) {
    console.log("⚠ NO viable venue/tenor combination found for ±7%/±15% iron condor on $800k notional.");
    console.log("");
    console.log("OPTIONS to consider:");
    console.log("  1. Tighter outer band (e.g., ±10% instead of ±15%)");
    console.log("  2. Different inner band (e.g., ±5% / ±12%)");
    console.log("  3. Use longer tenor with weekly resets");
    console.log("  4. Use Deribit cash-settled options (typically deeper strike grid than perp-style)");
    return;
  }

  // For top 3 viable combos, pull order books
  console.log("LIVE ORDER BOOK PROBE FOR TOP VIABLE COMBINATIONS");
  console.log("──────────────────────────────────────────────────");

  for (const r of viableResults.slice(0, 5)) {
    console.log(`\n${r.venueName} ${r.tenorDays.toFixed(1)}d (expiry ${r.expiryIso}):`);

    const fetchAndDisplay = async (
      label: string,
      strike: number,
      isPut: boolean
    ): Promise<{ bid: number | null; ask: number | null }> => {
      let bid: number | null = null;
      let ask: number | null = null;
      if (r.venueName === "Bullish") {
        const opts = bullishMarkets.filter(
          (m) =>
            m.marketType === "OPTION" &&
            m.baseSymbol === "BTC" &&
            m.expiryDatetime === r.expiryIso &&
            m.optionType === (isPut ? "PUT" : "CALL") &&
            Number(m.optionStrikePrice) === strike
        );
        if (opts.length > 0) {
          const ob = await fetchBullishOrderbook(opts[0].symbol);
          if (ob) {
            if (ob.bids[0]) bid = Number(ob.bids[0].price);
            if (ob.asks[0]) ask = Number(ob.asks[0].price);
          }
        }
      } else {
        // Deribit
        const ts = new Date(r.expiryIso).getTime();
        const opts = deribitInstruments.filter(
          (i) =>
            i.expiration_timestamp === ts &&
            i.option_type === (isPut ? "put" : "call") &&
            Number(i.strike) === strike
        );
        if (opts.length > 0) {
          const ob = await fetchDeribitOrderbook(opts[0].instrument_name);
          if (ob) {
            // Deribit prices in BTC; convert to USD using index_price as spot ref
            const indexUsd = ob.index_price ?? spot;
            if (ob.best_bid_price > 0) bid = ob.best_bid_price * indexUsd;
            if (ob.best_ask_price > 0) ask = ob.best_ask_price * indexUsd;
          }
        }
      }
      const bidStr = bid !== null ? `$${bid.toFixed(0).padStart(7)}` : "    n/a";
      const askStr = ask !== null ? `$${ask.toFixed(0).padStart(7)}` : "    n/a";
      const spreadStr =
        bid !== null && ask !== null && bid > 0 ? `${(((ask - bid) / ((bid + ask) / 2)) * 100).toFixed(1)}%` : " n/a";
      console.log(`  ${label.padEnd(28)} strike $${strike.toFixed(0).padStart(6)} | bid ${bidStr} ask ${askStr} (spread ${spreadStr})`);
      return { bid, ask };
    };

    const innerPut = await fetchAndDisplay("Inner put (-7%, BUY)", r.innerPutClosest!, true);
    const outerPut = await fetchAndDisplay("Outer put (-15%, SELL)", r.outerPutClosest!, true);
    const innerCall = await fetchAndDisplay("Inner call (+7%, SELL)", r.innerCallClosest!, false);
    const outerCall = await fetchAndDisplay("Outer call (+15%, BUY)", r.outerCallClosest!, false);

    if (innerPut.ask && outerPut.bid && innerCall.bid && outerCall.ask) {
      // Cross-the-spread iron condor cost
      const positionSizeBtc = NOTIONAL_USD / spot;
      const costPerBtc = innerPut.ask - outerPut.bid - innerCall.bid + outerCall.ask;
      const costUsd = costPerBtc * positionSizeBtc;
      console.log(`  → Iron condor cost (cross spread): $${costPerBtc.toFixed(2)}/BTC = $${costUsd.toFixed(2)} for $800k notional`);
      console.log(`  → Per day if tenor is ${r.tenorDays.toFixed(1)}d: $${(costUsd / r.tenorDays).toFixed(2)}/day amortized`);
    }
  }
};

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
