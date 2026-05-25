/**
 * Atticus Definitive V4: Overall Best Recommendation + Live Venue Pricing
 *
 * 1. Prints the definitive overall recommendation from backtest data
 * 2. Scans Deribit live production options chain (public, no auth needed)
 * 3. Scans Bullish SimNext options chain (public endpoints, auth attempted if env set)
 * 4. Compares BS-model premiums to real venue ask prices per SL tier
 *
 * Run: npx tsx services/api/scripts/pilotBacktestDefinitiveV4.ts
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { BullishTradingClient } from "../src/pilot/bullish.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════════

const SL_TIERS = [1, 2, 3, 5, 10];
const TENORS = [2, 3, 5, 7];
const RF = 0.05;
const VOL_WINDOW = 30;
const POSITION_SIZES = [5_000, 10_000, 20_000, 25_000, 50_000];

type Regime = "calm" | "normal" | "stress";

// ═══════════════════════════════════════════════════════════════════════════
// Math
// ═══════════════════════════════════════════════════════════════════════════

function nCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
    a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

function bsPut(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return Math.max(0, K - S);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return K * Math.exp(-r * T) * nCDF(-d2) - S * nCDF(-d1);
}

function realizedVol(closes: number[], endIdx: number, window: number): number {
  const start = Math.max(0, endIdx - window);
  if (endIdx - start < 5) return 0.5;
  const rets: number[] = [];
  for (let i = start + 1; i <= endIdx; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 5) return 0.5;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance * 365);
}

function classifyRegime(v: number): Regime {
  if (v < 0.4) return "calm"; if (v < 0.65) return "normal"; return "stress";
}

// ═══════════════════════════════════════════════════════════════════════════
// Data Fetching
// ═══════════════════════════════════════════════════════════════════════════

async function fetchBTCPrices(startDate: string, endDate: string): Promise<{ date: string; close: number }[]> {
  const all = new Map<string, number>();
  let curMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();
  while (curMs < endMs) {
    const chunkEndMs = Math.min(curMs + 300 * 86400000, endMs);
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${new Date(curMs).toISOString()}&end=${new Date(chunkEndMs).toISOString()}`;
    let retries = 4;
    while (retries-- > 0) {
      try {
        const res = await fetch(url);
        if (res.status === 429) { await delay(3000); continue; }
        if (!res.ok) throw new Error(`Coinbase HTTP ${res.status}`);
        const candles = (await res.json()) as number[][];
        for (const [ts, , , , close] of candles) all.set(new Date(ts * 1000).toISOString().slice(0, 10), close);
        break;
      } catch (e: any) { if (retries <= 0) throw e; await delay(2000); }
    }
    curMs = chunkEndMs; await delay(500);
  }
  return Array.from(all.entries()).map(([date, close]) => ({ date, close })).sort((a, b) => a.date.localeCompare(b.date));
}

function delay(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════════════════════════

const $ = (n: number, d = 0) => n < 0 ? `-$${Math.abs(d ? n : Math.round(n)).toLocaleString()}${d ? "" : ""}` : `$${(d ? n.toFixed(d) : Math.round(n)).toLocaleString()}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const pad = (s: string, w: number) => s.padStart(w);
const padE = (s: string, w: number) => s.padEnd(w);
const hdr = (t: string) => "\n" + "═".repeat(90) + "\n  " + t + "\n" + "═".repeat(90);

// ═══════════════════════════════════════════════════════════════════════════
// Live Venue Pricing
// ═══════════════════════════════════════════════════════════════════════════

type VenueOption = {
  venue: string;
  symbol: string;
  strike: number;
  expiry: string;
  daysToExpiry: number;
  bidPx: number;
  askPx: number;
  midPx: number;
  costPer1k: number;
  spotPrice: number;
  otmPct: number;
};

async function scanDeribit(spotPrice: number): Promise<VenueOption[]> {
  const results: VenueOption[] = [];
  const baseUrl = "https://www.deribit.com/api/v2";

  try {
    const instrRes = await fetch(`${baseUrl}/public/get_instruments?currency=BTC&kind=option&expired=false`);
    if (!instrRes.ok) throw new Error(`Deribit instruments: ${instrRes.status}`);
    const instrData = await instrRes.json() as any;
    const instruments = instrData?.result || [];

    const now = Date.now();
    const puts = instruments.filter((i: any) => {
      if (i.option_type !== "put") return false;
      const expMs = i.expiration_timestamp || 0;
      const days = (expMs - now) / 86400000;
      return days >= 1 && days <= 14;
    });

    // Group by closest to each SL tier
    for (const sl of SL_TIERS) {
      const targetStrike = spotPrice * (1 - sl / 100);
      const candidates = puts
        .map((i: any) => ({
          instrument: i.instrument_name,
          strike: i.strike,
          expMs: i.expiration_timestamp,
          days: (i.expiration_timestamp - now) / 86400000,
          dist: Math.abs(i.strike - targetStrike),
        }))
        .filter((c: any) => c.dist / spotPrice < 0.03)
        .sort((a: any, b: any) => a.dist - b.dist)
        .slice(0, 3);

      for (const cand of candidates) {
        try {
          await delay(200);
          const bookRes = await fetch(`${baseUrl}/public/get_order_book?instrument_name=${encodeURIComponent(cand.instrument)}`);
          if (!bookRes.ok) continue;
          const bookData = await bookRes.json() as any;
          const book = bookData?.result;
          if (!book) continue;

          // Deribit prices are in BTC, convert to USD
          const bestBid = book.best_bid_price ?? 0;
          const bestAsk = book.best_ask_price ?? 0;
          if (bestAsk <= 0) continue;

          const bidUsd = bestBid * spotPrice;
          const askUsd = bestAsk * spotPrice;
          const midUsd = (bidUsd + askUsd) / 2;
          const qty = 1000 / spotPrice;
          const costPer1k = askUsd * qty;
          const otmPct = (spotPrice - cand.strike) / spotPrice * 100;

          results.push({
            venue: "Deribit",
            symbol: cand.instrument,
            strike: cand.strike,
            expiry: new Date(cand.expMs).toISOString().slice(0, 10),
            daysToExpiry: Math.round(cand.days),
            bidPx: bidUsd,
            askPx: askUsd,
            midPx: midUsd,
            costPer1k,
            spotPrice,
            otmPct,
          });
        } catch { /* skip failed orderbooks */ }
      }
    }
  } catch (e: any) {
    console.log(`  [Deribit] Scan failed: ${e.message}`);
  }

  return results;
}

async function scanBullish(spotPrice: number): Promise<{ options: VenueOption[]; bullishSpot: number | null }> {
  const results: VenueOption[] = [];
  let bullishSpot: number | null = null;

  try {
    const config = {
      enabled: true,
      restBaseUrl: process.env.PILOT_BULLISH_REST_BASE_URL || "https://api.simnext.bullish-test.com",
      publicWsUrl: "", privateWsUrl: "",
      authMode: "ecdsa" as const,
      hmacPublicKey: "", hmacSecret: "",
      ecdsaPublicKey: process.env.PILOT_BULLISH_ECDSA_PUBLIC_KEY || "",
      ecdsaPrivateKey: process.env.PILOT_BULLISH_ECDSA_PRIVATE_KEY || "",
      ecdsaMetadata: process.env.PILOT_BULLISH_ECDSA_METADATA || "",
      tradingAccountId: process.env.PILOT_BULLISH_TRADING_ACCOUNT_ID || "",
      defaultSymbol: "BTCUSDC",
      symbolByMarketId: { "BTC-USD": "BTCUSDC" } as Record<string, string>,
      hmacLoginPath: "/trading-api/v1/users/hmac/login",
      ecdsaLoginPath: "/trading-api/v2/users/login",
      tradingAccountsPath: "/trading-api/v1/accounts/trading-accounts",
      noncePath: "/nonce",
      commandPath: "/trading-api/v2/command",
      orderbookPathTemplate: "/trading-api/v1/markets/:symbol/orderbook/hybrid",
      enableExecution: false, orderTimeoutMs: 15000,
      orderTif: "IOC" as const, allowMargin: false,
    };

    const client = new BullishTradingClient(config);

    try {
      const spotBook = await client.getHybridOrderBook("BTCUSDC");
      const bid = Number(spotBook.bids[0]?.price || 0);
      const ask = Number(spotBook.asks[0]?.price || 0);
      if (bid > 0 && ask > 0) bullishSpot = (bid + ask) / 2;
    } catch { /* spot book unavailable */ }

    const useSpot = bullishSpot || spotPrice;

    const markets = await client.getMarkets({ forceRefresh: true });
    const now = Date.now();
    const puts = markets.filter(m =>
      m.marketType === "OPTION" &&
      m.symbol?.includes("-P") &&
      m.createOrderEnabled
    );

    const activePuts = puts.filter(m => {
      const e = Date.parse(m.expiryDatetime || "");
      const days = (e - now) / 86400000;
      return Number.isFinite(e) && days >= 1 && days <= 14;
    });

    for (const sl of SL_TIERS) {
      const targetStrike = useSpot * (1 - sl / 100);

      const candidates = activePuts
        .map(m => {
          const sym = m.symbol || "";
          const parts = sym.split("-");
          const strike = Number(parts[3] || m.optionStrikePrice || 0);
          const expMs = Date.parse(m.expiryDatetime || "");
          const days = (expMs - now) / 86400000;
          return { symbol: sym, strike, expMs, days, dist: Math.abs(strike - targetStrike) };
        })
        .filter(c => c.strike > 0 && c.days >= 1 && c.dist / useSpot < 0.05)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 3);

      for (const cand of candidates) {
        try {
          await delay(300);
          const book = await client.getHybridOrderBook(cand.symbol);
          const bestAsk = Number(book.asks[0]?.price || 0);
          const bestBid = Number(book.bids[0]?.price || 0);
          if (bestAsk <= 0) continue;

          const qty = 1000 / useSpot;
          const costPer1k = bestAsk * qty;
          const otmPct = (useSpot - cand.strike) / useSpot * 100;

          results.push({
            venue: "Bullish SimNext",
            symbol: cand.symbol,
            strike: cand.strike,
            expiry: new Date(cand.expMs).toISOString().slice(0, 10),
            daysToExpiry: Math.round(cand.days),
            bidPx: bestBid,
            askPx: bestAsk,
            midPx: (bestBid + bestAsk) / 2,
            costPer1k,
            spotPrice: useSpot,
            otmPct,
          });
        } catch { /* skip failed orderbooks */ }
      }
    }
  } catch (e: any) {
    console.log(`  [Bullish] Scan failed: ${e.message}`);
  }

  return { options: results, bullishSpot };
}

// ═══════════════════════════════════════════════════════════════════════════
// Report Generation
// ═══════════════════════════════════════════════════════════════════════════

function genRecommendation(spotPrice: number, currentVol: number): string {
  const lines: string[] = [];
  const regime = classifyRegime(currentVol);

  lines.push(hdr("OVERALL BEST RECOMMENDATION"));
  lines.push("");
  lines.push(`  Current BTC spot: ${$(spotPrice)} | 30-day realized vol: ${pct(currentVol)} | Regime: ${regime.toUpperCase()}`);
  lines.push("");
  lines.push("  ╔══════════════════════════════════════════════════════════════════════════╗");
  lines.push("  ║  ATTICUS PROTECTION: RECOMMENDED PRODUCT LINEUP                        ║");
  lines.push("  ║                                                                        ║");
  lines.push("  ║  2-day rolling protection, renewable. Trigger-strike put hedge.         ║");
  lines.push("  ║  Naked puts for 1-3% SL. Put spreads for 5-10% SL.                     ║");
  lines.push("  ║  Regime-dynamic pricing: lower in calm, higher in stress, pause if      ║");
  lines.push("  ║  vol > 65% for tight SL tiers.                                         ║");
  lines.push("  ╚══════════════════════════════════════════════════════════════════════════╝");

  lines.push("\n  FIXED PRICING (simple launch, all-weather):\n");
  lines.push("  SL%  | Premium/$1k | $5k   | $10k  | $20k  | $25k  | $50k  | Payout/$10k | Return | Win Rate");
  lines.push("  -----|------------|-------|-------|-------|-------|-------|-------------|--------|--------");
  const fixedData = [
    { sl: 1, prem: 7, wr: "58%" },
    { sl: 2, prem: 5, wr: "57%" },
    { sl: 3, prem: 5, wr: "72%" },
    { sl: 5, prem: 3, wr: "84%" },
    { sl: 10, prem: 1, wr: "99%" },
  ];
  for (const d of fixedData) {
    const payout = d.sl * 100;
    const ret = (d.sl * 10 / d.prem).toFixed(1);
    lines.push(
      `  ${pad(d.sl + "%", 4)} | ${pad("$" + d.prem + ".00", 10)} | ${pad($(d.prem * 5), 5)} | ${pad($(d.prem * 10), 5)} | ${pad($(d.prem * 20), 5)} | ${pad($(d.prem * 25), 5)} | ${pad($(d.prem * 50), 5)} | ${pad($(payout), 11)} | ${pad(ret + "×", 6)} | ${pad(d.wr, 7)}`
    );
  }

  lines.push("\n  REGIME-DYNAMIC PRICING (recommended):\n");
  lines.push("  SL%  | CALM (30%)      | NORMAL (50%)    | STRESS (20%)    | Weighted Avg | Notes");
  lines.push("  -----|-----------------|-----------------|-----------------|-------------|------");

  const regimeData = [
    { sl: 1, calm: 4, normal: 7, stress: null as number | null, avg: 4.74, note: "Pause in stress" },
    { sl: 2, calm: 2, normal: 5, stress: 11, avg: 5.24, note: "Consider pause in stress" },
    { sl: 3, calm: 1, normal: 4, stress: 10, avg: 4.24, note: "Active all regimes" },
    { sl: 5, calm: 2, normal: 3, stress: 7, avg: 3.47, note: "Active all regimes" },
    { sl: 10, calm: 1, normal: 1, stress: 1, avg: 1.00, note: "Flat — near-zero cost" },
  ];

  for (const d of regimeData) {
    const cLabel = `$${d.calm}/1k ($${d.calm * 10}/10k)`;
    const nLabel = `$${d.normal}/1k ($${d.normal * 10}/10k)`;
    const sLabel = d.stress !== null ? `$${d.stress}/1k ($${d.stress * 10}/10k)` : "PAUSE";
    lines.push(
      `  ${pad(d.sl + "%", 4)} | ${padE(cLabel, 15)} | ${padE(nLabel, 15)} | ${padE(sLabel, 15)} | ${pad("$" + d.avg.toFixed(2) + "/1k", 11)} | ${d.note}`
    );
  }

  lines.push("\n  REGIME-DYNAMIC: What the trader pays today (per $10k position):\n");
  const currentPricing = regimeData.map(d => {
    const p = regime === "calm" ? d.calm : regime === "normal" ? d.normal : d.stress;
    return { sl: d.sl, prem: p };
  });
  lines.push(`  Current regime: ${regime.toUpperCase()} (vol = ${pct(currentVol)})\n`);
  lines.push("  SL%  | Premium TODAY | $5k   | $10k  | $20k  | $25k  | $50k  | Payout/$10k | Return");
  lines.push("  -----|-------------|-------|-------|-------|-------|-------|-------------|-------");
  for (const d of currentPricing) {
    if (d.prem === null) {
      lines.push(`  ${pad(d.sl + "%", 4)} | PAUSED      | —     | —     | —     | —     | —     | ${pad($(d.sl * 100), 11)} | —`);
      continue;
    }
    const ret = (d.sl * 10 / d.prem).toFixed(1);
    lines.push(
      `  ${pad(d.sl + "%", 4)} | ${pad("$" + d.prem + "/1k", 11)} | ${pad($(d.prem * 5), 5)} | ${pad($(d.prem * 10), 5)} | ${pad($(d.prem * 20), 5)} | ${pad($(d.prem * 25), 5)} | ${pad($(d.prem * 50), 5)} | ${pad($(d.sl * 100), 11)} | ${pad(ret + "×", 6)}`
    );
  }

  // Hedging strategy per tier
  lines.push("\n  HEDGING STRATEGY PER TIER:\n");
  lines.push("  SL%  | Hedge Type      | Option Strike      | Tenor | Why");
  lines.push("  -----|-----------------|--------------------|----|---");
  lines.push(`  1%   | Naked trigger   | ${$(spotPrice * 0.99)} (1% OTM)  | 2d  | Recovery exceeds hedge; spread caps would limit profit`);
  lines.push(`  2%   | Naked trigger   | ${$(spotPrice * 0.98)} (2% OTM)  | 2d  | Same — recovery is the profit driver`);
  lines.push(`  3%   | Naked trigger   | ${$(spotPrice * 0.97)} (3% OTM)  | 2d  | Same — strong ITM recovery on breach`);
  lines.push(`  5%   | Put spread      | Buy ${$(spotPrice * 0.975)} / Sell ${$(spotPrice * 0.925)} | 2d  | Cheaper hedge; recovery cap rarely hit`);
  lines.push(`  10%  | Put spread      | Buy ${$(spotPrice * 0.95)} / Sell ${$(spotPrice * 0.85)}  | 2d  | Very cheap hedge; trigger is rare (1%)`);

  return lines.join("\n");
}

function genLiveVenuePricing(
  deribitOptions: VenueOption[],
  bullishOptions: VenueOption[],
  spotPrice: number,
  bullishSpot: number | null,
  currentVol: number,
): string {
  const lines: string[] = [];
  lines.push(hdr("LIVE VENUE PRICING — Deribit (Production) + Bullish SimNext"));
  lines.push("");
  lines.push(`  Coinbase BTC spot: ${$(spotPrice)}`);
  if (bullishSpot) lines.push(`  Bullish SimNext BTC mid: ${$(bullishSpot)}`);
  lines.push(`  Current 30d vol: ${pct(currentVol)} (regime: ${classifyRegime(currentVol).toUpperCase()})`);
  lines.push(`  Scan time: ${new Date().toISOString()}`);

  // Deribit table
  if (deribitOptions.length > 0) {
    lines.push("\n  DERIBIT (Production) — Live put option prices:\n");
    lines.push("  SL%  | Symbol                         | Strike    | Expiry     | Days | OTM%  | Bid/BTC | Ask/BTC | Ask USD | Hedge/$1k | BS Model/$1k | Venue/BS");
    lines.push("  -----|-------------------------------|-----------|------------|------|-------|---------|---------|---------|-----------|-------------|--------");

    for (const sl of SL_TIERS) {
      const opts = deribitOptions.filter(o => {
        const targetStrike = spotPrice * (1 - sl / 100);
        return Math.abs(o.strike - targetStrike) / spotPrice < 0.03;
      }).sort((a, b) => a.costPer1k - b.costPer1k);

      if (opts.length === 0) {
        lines.push(`  ${pad(sl + "%", 4)} | (no matching options found)     |           |            |      |       |         |         |         |           |             |`);
        continue;
      }

      for (const o of opts.slice(0, 2)) {
        const bsHedge = bsPut(spotPrice, o.strike, o.daysToExpiry / 365, RF, currentVol * 0.85) * (1000 / spotPrice);
        const ratio = bsHedge > 0 ? (o.costPer1k / bsHedge).toFixed(2) + "×" : "N/A";
        lines.push(
          `  ${pad(sl + "%", 4)} | ${padE(o.symbol, 29)} | ${pad($(o.strike), 9)} | ${o.expiry} | ${pad(String(o.daysToExpiry), 4)} | ${pad(o.otmPct.toFixed(1) + "%", 5)} | ${pad((o.bidPx / spotPrice).toFixed(5), 7)} | ${pad((o.askPx / spotPrice).toFixed(5), 7)} | ${pad($(o.askPx, 2), 7)} | ${pad($(o.costPer1k, 2), 9)} | ${pad($(bsHedge, 2), 11)} | ${pad(ratio, 7)}`
        );
      }
    }
  } else {
    lines.push("\n  DERIBIT: No options data retrieved (may be network issue or no matching puts).");
  }

  // Bullish table
  if (bullishOptions.length > 0) {
    lines.push("\n\n  BULLISH SIMNEXT — Live put option prices:\n");
    lines.push("  SL%  | Symbol                         | Strike    | Expiry     | Days | OTM%  | Bid      | Ask      | Hedge/$1k | BS Model/$1k | Venue/BS");
    lines.push("  -----|-------------------------------|-----------|------------|------|-------|----------|----------|-----------|-------------|--------");

    const useSpot = bullishSpot || spotPrice;
    for (const sl of SL_TIERS) {
      const targetStrike = useSpot * (1 - sl / 100);
      const opts = bullishOptions.filter(o =>
        Math.abs(o.strike - targetStrike) / useSpot < 0.05
      ).sort((a, b) => a.costPer1k - b.costPer1k);

      if (opts.length === 0) {
        lines.push(`  ${pad(sl + "%", 4)} | (no matching options found)     |           |            |      |       |          |          |           |             |`);
        continue;
      }

      for (const o of opts.slice(0, 2)) {
        const bsHedge = bsPut(useSpot, o.strike, o.daysToExpiry / 365, RF, currentVol * 0.85) * (1000 / useSpot);
        const ratio = bsHedge > 0 ? (o.costPer1k / bsHedge).toFixed(2) + "×" : "N/A";
        lines.push(
          `  ${pad(sl + "%", 4)} | ${padE(o.symbol, 29)} | ${pad($(o.strike), 9)} | ${o.expiry} | ${pad(String(o.daysToExpiry), 4)} | ${pad(o.otmPct.toFixed(1) + "%", 5)} | ${pad($(o.bidPx, 2), 8)} | ${pad($(o.askPx, 2), 8)} | ${pad($(o.costPer1k, 2), 9)} | ${pad($(bsHedge, 2), 11)} | ${pad(ratio, 7)}`
        );
      }
    }
  } else {
    lines.push("\n  BULLISH SIMNEXT: No options data retrieved.");
    lines.push("  (Set PILOT_BULLISH_REST_BASE_URL to enable. Public endpoints may require SimNext access.)");
  }

  // Comparison: Model vs Live
  lines.push("\n\n  COMPARISON: Backtest BS Model vs Live Venue Hedge Cost (per $1k):\n");
  lines.push("  SL%  | BS Model (v×0.85) | Deribit Best | Bullish Best | Cheapest Venue | Model Accurate?");
  lines.push("  -----|-------------------|-------------|-------------|----------------|---------------");

  for (const sl of SL_TIERS) {
    const triggerStrike = spotPrice * (1 - sl / 100);
    const bsModel = bsPut(spotPrice, triggerStrike, 2 / 365, RF, currentVol * 0.85) * (1000 / spotPrice);

    const dBest = deribitOptions
      .filter(o => Math.abs(o.strike - triggerStrike) / spotPrice < 0.03)
      .sort((a, b) => a.costPer1k - b.costPer1k)[0];
    const bBest = bullishOptions
      .filter(o => Math.abs(o.strike - triggerStrike) / spotPrice < 0.05)
      .sort((a, b) => a.costPer1k - b.costPer1k)[0];

    const dStr = dBest ? $(dBest.costPer1k, 2) : "N/A";
    const bStr = bBest ? $(bBest.costPer1k, 2) : "N/A";
    const cheapest = dBest && bBest ? (dBest.costPer1k < bBest.costPer1k ? "Deribit" : "Bullish") :
                     dBest ? "Deribit" : bBest ? "Bullish" : "N/A";
    const livePrice = dBest?.costPer1k ?? bBest?.costPer1k;
    let accuracy = "No live data";
    if (livePrice) {
      const ratio = livePrice / bsModel;
      if (ratio > 0.7 && ratio < 1.5) accuracy = `${(ratio).toFixed(2)}× — close`;
      else if (ratio >= 1.5 && ratio < 3) accuracy = `${(ratio).toFixed(2)}× — venue premium`;
      else if (ratio >= 3) accuracy = `${(ratio).toFixed(2)}× — significantly higher`;
      else accuracy = `${(ratio).toFixed(2)}× — cheaper than model`;
    }

    lines.push(
      `  ${pad(sl + "%", 4)} | ${pad($(bsModel, 2), 17)} | ${pad(dStr, 11)} | ${pad(bStr, 11)} | ${padE(cheapest, 14)} | ${accuracy}`
    );
  }

  lines.push("\n  NOTE: BS model uses vol × 0.85 as IV proxy. Live venue prices include spread, liquidity premium,");
  lines.push("  and market maker edge. Deribit prices are in BTC converted to USD at current spot.");

  // Viability assessment
  lines.push("\n\n  VIABILITY ASSESSMENT:\n");
  for (const sl of SL_TIERS) {
    const triggerStrike = spotPrice * (1 - sl / 100);
    const bsModel = bsPut(spotPrice, triggerStrike, 2 / 365, RF, currentVol * 0.85) * (1000 / spotPrice);
    const dBest = deribitOptions
      .filter(o => Math.abs(o.strike - triggerStrike) / spotPrice < 0.03)
      .sort((a, b) => a.costPer1k - b.costPer1k)[0];

    const liveHedge = dBest?.costPer1k ?? bsModel;
    const recData = [
      { sl: 1, prem: 7, rec: 10.36 },
      { sl: 2, prem: 5, rec: 6.92 },
      { sl: 3, prem: 5, rec: 4.59 },
      { sl: 5, prem: 3, rec: 2.16 },
      { sl: 10, prem: 1, rec: 0.40 },
    ];
    const rd = recData.find(r => r.sl === sl)!;
    const avgPayout = rd.sl * 10 * (sl === 1 ? 0.412 : sl === 2 ? 0.283 : sl === 3 ? 0.187 : sl === 5 ? 0.08 : 0.01);
    const netPnl = rd.prem - liveHedge - avgPayout + rd.rec;
    const viable = netPnl > 0 ? "VIABLE" : "AT RISK";

    lines.push(`  ${sl}% SL: Prem ${$(rd.prem)}/1k - Hedge ${$(liveHedge, 2)}/1k - AvgPayout ${$(avgPayout, 2)}/1k + Recovery ${$(rd.rec, 2)}/1k = P&L ${$(netPnl, 2)}/1k → ${viable}`);
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const startTime = Date.now();
  console.log("═".repeat(90));
  console.log("  ATTICUS DEFINITIVE V4: Best Recommendation + Live Venue Pricing");
  console.log("  " + new Date().toISOString());
  console.log("═".repeat(90));
  console.log();

  // Fetch recent BTC prices for current vol calc
  console.log("  Fetching BTC prices for current vol calculation...");
  const prices = await fetchBTCPrices("2025-01-01", "2026-04-08");
  console.log(`  ${prices.length} days loaded`);
  const closes = prices.map(p => p.close);
  const spotPrice = closes[closes.length - 1];
  const currentVol = realizedVol(closes, closes.length - 1, 30);
  console.log(`  Current spot: ${$(spotPrice)} | 30d vol: ${pct(currentVol)} | Regime: ${classifyRegime(currentVol).toUpperCase()}\n`);

  const sections: string[] = [];
  sections.push("═".repeat(90));
  sections.push("  ATTICUS DEFINITIVE V4: Best Recommendation + Live Venue Pricing");
  sections.push("  " + new Date().toISOString());
  sections.push("═".repeat(90));

  // Section 1: Overall recommendation
  console.log("  Generating best recommendation...");
  sections.push(genRecommendation(spotPrice, currentVol));

  // Section 2: Live venue scan
  console.log("  Scanning Deribit production options...");
  const deribitOptions = await scanDeribit(spotPrice);
  console.log(`  Found ${deribitOptions.length} Deribit options`);

  console.log("  Scanning Bullish SimNext options...");
  const { options: bullishOptions, bullishSpot } = await scanBullish(spotPrice);
  console.log(`  Found ${bullishOptions.length} Bullish options`);

  sections.push(genLiveVenuePricing(deribitOptions, bullishOptions, spotPrice, bullishSpot, currentVol));

  const fullOutput = sections.join("\n");

  const outDir = path.resolve("docs/pilot-reports");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "backtest_definitive_v4_results.txt");
  await writeFile(outPath, fullOutput, "utf8");

  console.log(fullOutput);
  console.log(`\n  Results written to: ${outPath}`);
  console.log(`  Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error("Fatal:", e.message || e); process.exit(1); });
