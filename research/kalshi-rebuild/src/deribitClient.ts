/**
 * Deribit live-chain client (public API only — no keys, no auth).
 *
 * CRITICAL: this module ONLY hits Deribit's public REST endpoints. It does
 * not require any API keys, does not touch any Foxify pilot infrastructure,
 * and does not share state with any other Atticus service. The Atticus
 * production keys remain unused and unexposed.
 *
 * Endpoints used (all public, no auth required):
 *   GET /api/v2/public/get_index_price
 *   GET /api/v2/public/get_book_summary_by_currency  (full chain)
 *   GET /api/v2/public/ticker                        (single instrument detail)
 *
 * Used by: src/hedgeEngine.ts to obtain real-fill bid-ask prices for the
 * Deribit-leg of Atticus's options hedge product. When live data is
 * unavailable (offline, throttled, historical backtest dates), the engine
 * falls back to BS-theoretical pricing with an explicit bid-ask widener.
 * This module reports which path was used so the report can be honest about
 * which rows are live-priced vs synthetic.
 */

const BASE = "https://www.deribit.com/api/v2/public";

export type DeribitOptionRow = {
  instrument: string;        // e.g. "BTC-29MAY26-80000-P"
  strike: number;
  expiryDate: string;        // YYYY-MM-DD
  optionType: "C" | "P";
  bid: number | null;        // in BTC (multiply by underlying for USD)
  ask: number | null;
  mark: number | null;
  underlying: number | null;
  volume24h: number | null;  // in BTC
  openInterest: number | null;
};

export type DeribitChainSnapshot = {
  fetchedAtMs: number;
  underlying: number;        // BTC index price in USD
  rows: DeribitOptionRow[];  // all live BTC options
};

const monthMap: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

function parseInstrumentName(name: string): { strike: number; expiryDate: string; optionType: "C" | "P" } | null {
  // BTC-29MAY26-80000-P
  const m = /^BTC-(\d+)([A-Z]+)(\d+)-(\d+)-([CP])$/.exec(name);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthName = m[2];
  const year = 2000 + parseInt(m[3], 10);
  const strike = parseInt(m[4], 10);
  const optionType = m[5] as "C" | "P";
  const month = monthMap[monthName];
  if (!month) return null;
  const expiryDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { strike, expiryDate, optionType };
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<any> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Fetch the BTC index spot price (USD). */
export async function fetchBtcIndex(): Promise<number | null> {
  try {
    const j = await fetchJson(`${BASE}/get_index_price?index_name=btc_usd`);
    return j?.result?.index_price ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch a snapshot of the entire live BTC option chain.
 *
 * Returns null on network failure / timeout. Caller should fall back to
 * BS-theoretical pricing.
 *
 * Note: prices are in BTC (Deribit convention). To convert to USD multiply
 * by the underlying. The `underlying` field on each row is provided by
 * Deribit per-row (it varies microscopically across instruments).
 */
export async function fetchBtcChainSnapshot(): Promise<DeribitChainSnapshot | null> {
  try {
    const idx = await fetchBtcIndex();
    if (idx == null) return null;
    const j = await fetchJson(`${BASE}/get_book_summary_by_currency?currency=BTC&kind=option`);
    const items = j?.result;
    if (!Array.isArray(items)) return null;
    const rows: DeribitOptionRow[] = [];
    for (const it of items) {
      const parsed = parseInstrumentName(it.instrument_name);
      if (!parsed) continue;
      rows.push({
        instrument: it.instrument_name,
        strike: parsed.strike,
        expiryDate: parsed.expiryDate,
        optionType: parsed.optionType,
        bid: typeof it.bid_price === "number" ? it.bid_price : null,
        ask: typeof it.ask_price === "number" ? it.ask_price : null,
        mark: typeof it.mark_price === "number" ? it.mark_price : null,
        underlying: typeof it.underlying_price === "number" ? it.underlying_price : null,
        volume24h: typeof it.volume === "number" ? it.volume : null,
        openInterest: typeof it.open_interest === "number" ? it.open_interest : null,
      });
    }
    return { fetchedAtMs: Date.now(), underlying: idx, rows };
  } catch {
    return null;
  }
}

/**
 * From a chain snapshot, find the closest-to-target-DTE expiry that has
 * at least `minStrikes` listed strikes per side (call+put).
 */
export function findClosestExpiry(
  chain: DeribitChainSnapshot,
  targetDays: number,
  minStrikes = 6,
): string | null {
  const today = new Date();
  // Group by expiry and count strikes per side
  const byExpiry = new Map<string, { calls: Set<number>; puts: Set<number> }>();
  for (const r of chain.rows) {
    if (r.bid == null || r.ask == null || r.bid <= 0 || r.ask <= 0) continue;
    const e = byExpiry.get(r.expiryDate) ?? { calls: new Set(), puts: new Set() };
    if (r.optionType === "C") e.calls.add(r.strike);
    else e.puts.add(r.strike);
    byExpiry.set(r.expiryDate, e);
  }
  let best: { date: string; daysOff: number } | null = null;
  for (const [date, sides] of byExpiry) {
    if (sides.calls.size < minStrikes || sides.puts.size < minStrikes) continue;
    const days = (new Date(date).getTime() - today.getTime()) / 86_400_000;
    if (days < 0) continue;
    const daysOff = Math.abs(days - targetDays);
    if (best == null || daysOff < best.daysOff) best = { date, daysOff };
  }
  return best?.date ?? null;
}

/**
 * Get a {strike → row} map for a given (expiryDate, optionType).
 */
export function getStrikeMap(
  chain: DeribitChainSnapshot,
  expiryDate: string,
  optionType: "C" | "P",
): Map<number, DeribitOptionRow> {
  const out = new Map<number, DeribitOptionRow>();
  for (const r of chain.rows) {
    if (r.expiryDate !== expiryDate) continue;
    if (r.optionType !== optionType) continue;
    if (r.bid == null || r.ask == null || r.bid <= 0 || r.ask <= 0) continue;
    out.set(r.strike, r);
  }
  return out;
}

/**
 * Find a vertical spread on the live chain.
 *
 * Algorithm: pick K_long as the listed strike closest to `targetLongStrike`
 * on the correct side of the barrier. Then pick K_short as the listed strike
 * closest to (K_long ± targetWidth) on the correct side.
 *
 * For PUT spreads (loss-region "below"):
 *   K_long should be on or below barrier (typical: at barrier).
 *   K_short = K_long − targetWidth (further OTM).
 *
 * For CALL spreads (loss-region "above"):
 *   K_long should be on or above barrier.
 *   K_short = K_long + targetWidth.
 */
export function findVerticalSpread(
  chain: DeribitChainSnapshot,
  expiryDate: string,
  optionType: "C" | "P",
  targetLongStrike: number,
  targetWidth?: number,  // USD; if omitted, uses adjacent listed strikes
): { K_long: number; K_short: number; longRow: DeribitOptionRow; shortRow: DeribitOptionRow } | null {
  const strikes = getStrikeMap(chain, expiryDate, optionType);
  if (strikes.size < 2) return null;
  const sorted = [...strikes.keys()].sort((a, b) => a - b);

  // Pick K_long = listed strike closest to targetLongStrike.
  let K_long = sorted[0];
  let bestLongDiff = Math.abs(K_long - targetLongStrike);
  for (const s of sorted) {
    const d = Math.abs(s - targetLongStrike);
    if (d < bestLongDiff) { bestLongDiff = d; K_long = s; }
  }

  // Pick K_short.
  let K_short: number;
  if (targetWidth && targetWidth > 0) {
    // Use targetWidth: K_short = K_long ± targetWidth, snapped to nearest listed strike on the correct side.
    const desiredShort = optionType === "P" ? K_long - targetWidth : K_long + targetWidth;
    const candidates = optionType === "P"
      ? sorted.filter(s => s < K_long)
      : sorted.filter(s => s > K_long);
    if (!candidates.length) return null;
    K_short = candidates[0];
    let bestShortDiff = Math.abs(K_short - desiredShort);
    for (const s of candidates) {
      const d = Math.abs(s - desiredShort);
      if (d < bestShortDiff) { bestShortDiff = d; K_short = s; }
    }
  } else {
    // Adjacent: pick the immediately-next strike on the correct side.
    if (optionType === "P") {
      const below = sorted.filter(s => s < K_long).reverse();
      if (!below.length) return null;
      K_short = below[0];
    } else {
      const above = sorted.filter(s => s > K_long);
      if (!above.length) return null;
      K_short = above[0];
    }
  }

  return {
    K_long, K_short,
    longRow: strikes.get(K_long)!,
    shortRow: strikes.get(K_short)!,
  };
}
