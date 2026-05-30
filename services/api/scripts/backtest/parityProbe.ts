/**
 * WS#7 — Bullish vs Deribit Live Pricing Parity Probe.
 *
 * Read-only public-endpoint scraper that captures matched-strike option
 * prices from both venues for the protection tiers we serve. Output is a
 * JSON snapshot file; can be run continuously (one snapshot per cycle)
 * to build the multi-day dataset that calibrates the WS#9 backtest's
 * Bullish-vs-Deribit hedge cost markup assumption.
 *
 * Critical: NO AUTH REQUIRED. Both endpoints are public read-only.
 * No production impact, no env mutation, safe to run anywhere.
 *
 * Usage:
 *   cd services/api
 *   # One-shot snapshot:
 *   npx tsx scripts/backtest/parityProbe.ts
 *   # Continuous mode (snapshot every 5 minutes):
 *   PARITY_PROBE_INTERVAL_MS=300000 npx tsx scripts/backtest/parityProbe.ts
 *
 * Output:
 *   docs/foxify-pilot-bundle-c/parity-snapshots/<ISO>.json
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = resolve(HERE, "../../../../docs/foxify-pilot-bundle-c/parity-snapshots");

type ParityProbeStrike = {
  tier: 2 | 3 | 5 | 7;
  side: "long_put" | "short_call";
  triggerPrice: number;
};

type BullishOrderbookLevel = {
  price: string;
  priceLevelQuantity?: string;
  quantity?: string;
};

type ParityProbeRow = {
  tier: 2 | 3 | 5 | 7;
  side: "long_put" | "short_call";
  triggerPrice: number;

  bullish: {
    symbol: string | null;
    strike: number | null;
    bestBidUsd: number | null;
    bestBidQty: number | null;
    bestAskUsd: number | null;
    bestAskQty: number | null;
    spreadPctOfMid: number | null;
    error: string | null;
  };

  deribit: {
    instrument: string | null;
    strike: number | null;
    bestBidBtc: number | null;
    bestBidUsd: number | null;
    bestBidQty: number | null;
    bestAskBtc: number | null;
    bestAskUsd: number | null;
    bestAskQty: number | null;
    spreadPctOfMid: number | null;
    error: string | null;
  };

  comparison: {
    askDeltaPct: number | null;
    bullishStrikeDistance: number | null;
    deribitStrikeDistance: number | null;
  };
};

type ParityProbeSnapshot = {
  timestampIso: string;
  spotUsd: number;
  dvol: number | null;
  bullishExpiry: string;
  deribitExpiry: string;
  rows: ParityProbeRow[];
  notes: string[];
};

const PROBE_NOTIONAL_USD = 50000;

const fetchJson = async <T>(url: string, timeoutMs = 5000): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
};

const fetchSpot = async (): Promise<number> => {
  // Coinbase spot — agreed truth source for current pilot
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

/**
 * Round a USD strike to the nearest available Bullish strike for the
 * given expiry. Real implementation would query the markets endpoint;
 * for the probe we use a heuristic that snaps to common increments.
 *
 * Bullish 1-DTE: $200 increments near ATM, $1000 jumps in wings
 * Bullish 1-week: $1000 increments
 */
const findClosestStrike = (
  triggerUsd: number,
  availableStrikes: number[]
): number | null => {
  if (availableStrikes.length === 0) return null;
  let best: number | null = null;
  let bestDist = Infinity;
  for (const k of availableStrikes) {
    const d = Math.abs(k - triggerUsd);
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  return best;
};

const computeNextDayExpiry = (now: Date): { iso: string; bullishSym: string; deribitSym: string } => {
  // Both venues expire at 08:00 UTC. If now is before today's 08:00, use today;
  // otherwise tomorrow.
  const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 0, 0));
  if (candidate.getTime() < now.getTime() + 4 * 3600_000) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  const yyyy = candidate.getUTCFullYear();
  const mm = String(candidate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(candidate.getUTCDate()).padStart(2, "0");
  // Deribit format: BTC-DDMMMYY (e.g., 14MAY26)
  const monthShort = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][candidate.getUTCMonth()];
  const yy = String(yyyy).slice(-2);
  return {
    iso: candidate.toISOString(),
    bullishSym: `${yyyy}${mm}${dd}`,
    deribitSym: `${dd}${monthShort}${yy}`
  };
};

const fetchBullishMarkets = async (): Promise<any[]> => {
  return await fetchJson<any[]>(
    "https://api.exchange.bullish.com/trading-api/v1/markets",
    10_000
  );
};

const fetchBullishOrderbook = async (symbol: string): Promise<{ bids: BullishOrderbookLevel[]; asks: BullishOrderbookLevel[] } | null> => {
  try {
    return await fetchJson<{ bids: BullishOrderbookLevel[]; asks: BullishOrderbookLevel[] }>(
      `https://api.exchange.bullish.com/trading-api/v1/markets/${encodeURIComponent(symbol)}/orderbook/hybrid`
    );
  } catch {
    return null;
  }
};

const fetchDeribitOrderbook = async (instrument: string): Promise<{
  bid: number | null; bidQty: number | null; ask: number | null; askQty: number | null;
} | null> => {
  try {
    const res = await fetchJson<{
      result: {
        best_bid_price: number;
        best_bid_amount: number;
        best_ask_price: number;
        best_ask_amount: number;
      };
    }>(`https://www.deribit.com/api/v2/public/get_order_book?instrument_name=${encodeURIComponent(instrument)}`);
    const r = res.result;
    return {
      bid: Number.isFinite(r.best_bid_price) && r.best_bid_price > 0 ? r.best_bid_price : null,
      bidQty: Number.isFinite(r.best_bid_amount) ? r.best_bid_amount : null,
      ask: Number.isFinite(r.best_ask_price) && r.best_ask_price > 0 ? r.best_ask_price : null,
      askQty: Number.isFinite(r.best_ask_amount) ? r.best_ask_amount : null
    };
  } catch {
    return null;
  }
};

const computeSpreadPct = (bid: number | null, ask: number | null): number | null => {
  if (bid === null || ask === null || bid <= 0 || ask <= 0) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0) return null;
  return ((ask - bid) / mid) * 100;
};

const probeStrikes = (spot: number): ParityProbeStrike[] => [
  { tier: 2, side: "long_put",   triggerPrice: spot * 0.98 },
  { tier: 2, side: "short_call", triggerPrice: spot * 1.02 },
  { tier: 3, side: "long_put",   triggerPrice: spot * 0.97 },
  { tier: 3, side: "short_call", triggerPrice: spot * 1.03 },
  { tier: 5, side: "long_put",   triggerPrice: spot * 0.95 },
  { tier: 5, side: "short_call", triggerPrice: spot * 1.05 },
  { tier: 7, side: "long_put",   triggerPrice: spot * 0.93 },
  { tier: 7, side: "short_call", triggerPrice: spot * 1.07 }
];

export const runParityProbe = async (): Promise<ParityProbeSnapshot> => {
  const now = new Date();
  const expiry = computeNextDayExpiry(now);
  const spot = await fetchSpot();
  const dvol = await fetchDvol();

  // Discover available Bullish strikes for the target expiry
  const allMarkets = await fetchBullishMarkets();
  const bullishExpiryIso = `${expiry.iso.slice(0, 10)}T08:00:00.000Z`;
  const bullishStrikes = allMarkets
    .filter((m: any) =>
      m.marketType === "OPTION" &&
      m.baseSymbol === "BTC" &&
      m.expiryDatetime === bullishExpiryIso
    )
    .map((m: any) => Number(m.optionStrikePrice))
    .filter((n: number) => Number.isFinite(n));
  const uniqueStrikes = Array.from(new Set(bullishStrikes)).sort((a: number, b: number) => a - b);

  const rows: ParityProbeRow[] = [];
  const notes: string[] = [];

  for (const probe of probeStrikes(spot)) {
    const optType = probe.side === "long_put" ? "P" : "C";
    const bullishOptType = probe.side === "long_put" ? "P" : "C";

    const bullishStrike = findClosestStrike(probe.triggerPrice, uniqueStrikes);
    const bullishSym = bullishStrike
      ? `BTC-USDC-${expiry.bullishSym}-${bullishStrike}-${bullishOptType}`
      : null;

    let bullish: ParityProbeRow["bullish"] = {
      symbol: bullishSym,
      strike: bullishStrike,
      bestBidUsd: null,
      bestBidQty: null,
      bestAskUsd: null,
      bestAskQty: null,
      spreadPctOfMid: null,
      error: bullishSym ? null : "no_strike_in_grid"
    };

    if (bullishSym) {
      const book = await fetchBullishOrderbook(bullishSym);
      if (book) {
        const bid = book.bids[0];
        const ask = book.asks[0];
        bullish.bestBidUsd = bid?.price ? Number(bid.price) : null;
        bullish.bestBidQty = bid?.priceLevelQuantity ? Number(bid.priceLevelQuantity) : (bid?.quantity ? Number(bid.quantity) : null);
        bullish.bestAskUsd = ask?.price ? Number(ask.price) : null;
        bullish.bestAskQty = ask?.priceLevelQuantity ? Number(ask.priceLevelQuantity) : (ask?.quantity ? Number(ask.quantity) : null);
        bullish.spreadPctOfMid = computeSpreadPct(bullish.bestBidUsd, bullish.bestAskUsd);
      } else {
        bullish.error = "orderbook_unavailable";
      }
    }

    // Deribit: try nearest 500 first, then fall back to 1000 if missing.
    // Real Deribit strike grids have 500 increments near ATM but 1000 in
    // wings; for tiers >= 5% the trigger usually hits a 1000-multiple.
    const candidateStrikes = [
      Math.round(probe.triggerPrice / 500) * 500,
      Math.round(probe.triggerPrice / 1000) * 1000
    ];
    let deribitStrike: number | null = null;
    let deribitBook: Awaited<ReturnType<typeof fetchDeribitOrderbook>> | null = null;
    let deribitInst: string | null = null;
    for (const k of candidateStrikes) {
      const inst = `BTC-${expiry.deribitSym}-${k}-${optType}`;
      const book = await fetchDeribitOrderbook(inst);
      if (book && (book.ask !== null || book.bid !== null)) {
        deribitStrike = k;
        deribitBook = book;
        deribitInst = inst;
        break;
      }
    }
    if (deribitInst === null) {
      deribitInst = `BTC-${expiry.deribitSym}-${candidateStrikes[0]}-${optType}`;
      deribitStrike = candidateStrikes[0];
    }
    const deribit: ParityProbeRow["deribit"] = {
      instrument: deribitInst,
      strike: deribitStrike,
      bestBidBtc: deribitBook?.bid ?? null,
      bestBidUsd: deribitBook?.bid ? Number((deribitBook.bid * spot).toFixed(2)) : null,
      bestBidQty: deribitBook?.bidQty ?? null,
      bestAskBtc: deribitBook?.ask ?? null,
      bestAskUsd: deribitBook?.ask ? Number((deribitBook.ask * spot).toFixed(2)) : null,
      bestAskQty: deribitBook?.askQty ?? null,
      spreadPctOfMid: computeSpreadPct(deribitBook?.bid ?? null, deribitBook?.ask ?? null),
      error: deribitBook ? null : "orderbook_unavailable"
    };

    const askDeltaPct =
      bullish.bestAskUsd !== null && deribit.bestAskUsd !== null && deribit.bestAskUsd > 0
        ? ((bullish.bestAskUsd - deribit.bestAskUsd) / deribit.bestAskUsd) * 100
        : null;

    rows.push({
      tier: probe.tier,
      side: probe.side,
      triggerPrice: probe.triggerPrice,
      bullish,
      deribit,
      comparison: {
        askDeltaPct,
        bullishStrikeDistance: bullishStrike !== null ? Math.abs(bullishStrike - probe.triggerPrice) : null,
        deribitStrikeDistance: deribitStrike !== null ? Math.abs(deribitStrike - probe.triggerPrice) : null
      }
    });
  }

  // Notes for operator review
  const bullishUnavailable = rows.filter((r) => r.bullish.error === "no_strike_in_grid");
  if (bullishUnavailable.length > 0) {
    notes.push(
      `Bullish has no strikes for: ${bullishUnavailable.map((r) => `${r.tier}% ${r.side}`).join(", ")} ` +
      `(must route to Deribit for these tiers)`
    );
  }
  const askDeltas = rows
    .map((r) => r.comparison.askDeltaPct)
    .filter((d): d is number => d !== null);
  if (askDeltas.length > 0) {
    const avg = askDeltas.reduce((a, b) => a + b, 0) / askDeltas.length;
    notes.push(`Average Bullish ask premium vs Deribit: ${avg >= 0 ? "+" : ""}${avg.toFixed(1)}% across ${askDeltas.length} matched comparisons`);
  }
  notes.push(`Spot: $${spot.toFixed(2)}; DVOL: ${dvol?.toFixed(2) ?? "n/a"}; expiry: ${expiry.iso}`);

  return {
    timestampIso: now.toISOString(),
    spotUsd: spot,
    dvol,
    bullishExpiry: bullishExpiryIso,
    deribitExpiry: expiry.deribitSym,
    rows,
    notes
  };
};

export const writeSnapshot = (snapshot: ParityProbeSnapshot): string => {
  if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const filename = snapshot.timestampIso.replace(/[:.]/g, "-") + ".json";
  const path = resolve(SNAPSHOT_DIR, filename);
  writeFileSync(path, JSON.stringify(snapshot, null, 2), "utf8");
  return path;
};

const main = async (): Promise<void> => {
  const intervalMs = Number(process.env.PARITY_PROBE_INTERVAL_MS || 0);
  if (intervalMs > 0) {
    console.log(`[ParityProbe] Continuous mode: snapshot every ${intervalMs}ms`);
    while (true) {
      try {
        const snapshot = await runParityProbe();
        const path = writeSnapshot(snapshot);
        console.log(`[ParityProbe] ${snapshot.timestampIso} written to ${path}`);
        for (const note of snapshot.notes) console.log(`  - ${note}`);
      } catch (err: any) {
        console.error(`[ParityProbe] Error: ${err?.message ?? err}`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  } else {
    const snapshot = await runParityProbe();
    const path = writeSnapshot(snapshot);
    console.log(`[ParityProbe] Snapshot at ${snapshot.timestampIso}`);
    console.log(`[ParityProbe] Wrote: ${path}`);
    console.log("");
    console.log("=== Summary ===");
    for (const note of snapshot.notes) console.log(`  - ${note}`);
    console.log("");
    console.log("=== Per-tier comparison ===");
    for (const r of snapshot.rows) {
      const bAsk = r.bullish.bestAskUsd !== null ? `$${r.bullish.bestAskUsd}` : "n/a";
      const dAsk = r.deribit.bestAskUsd !== null ? `$${r.deribit.bestAskUsd}` : "n/a";
      const delta = r.comparison.askDeltaPct !== null ? `${r.comparison.askDeltaPct >= 0 ? "+" : ""}${r.comparison.askDeltaPct.toFixed(1)}%` : "n/a";
      console.log(`  ${r.tier}% ${r.side.padEnd(11)}  Bullish: ${bAsk.padStart(8)}  Deribit: ${dAsk.padStart(8)}  Δ: ${delta}`);
    }
  }
};

// Only run if invoked directly (not when imported by tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[ParityProbe] Fatal: ${err?.message ?? err}`);
    process.exit(1);
  });
}
