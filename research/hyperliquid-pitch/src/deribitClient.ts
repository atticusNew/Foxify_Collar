/**
 * Deribit live-chain client (public API only — no keys, no auth).
 * Supports BTC and ETH chains.
 *
 * CRITICAL: public endpoints only. No API keys used. No Foxify pilot
 * dependencies. Does not share state with any other Atticus service.
 */

const BASE = "https://www.deribit.com/api/v2/public";

export type DeribitOptionRow = {
  instrument: string;
  asset: "BTC" | "ETH";
  strike: number;
  expiryDate: string;
  optionType: "C" | "P";
  bid: number | null;
  ask: number | null;
  mark: number | null;
  underlying: number | null;
};

export type ChainSnapshot = {
  asset: "BTC" | "ETH";
  fetchedAtMs: number;
  underlying: number;
  rows: DeribitOptionRow[];
};

const months: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

function parseInstr(name: string, asset: "BTC" | "ETH"): { strike: number; expiryDate: string; optionType: "C" | "P" } | null {
  const re = asset === "BTC"
    ? /^BTC-(\d+)([A-Z]+)(\d+)-(\d+)-([CP])$/
    : /^ETH-(\d+)([A-Z]+)(\d+)-(\d+)-([CP])$/;
  const m = re.exec(name);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = months[m[2]];
  const year = 2000 + parseInt(m[3], 10);
  const strike = parseInt(m[4], 10);
  const optionType = m[5] as "C" | "P";
  if (!month) return null;
  return {
    strike,
    expiryDate: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    optionType,
  };
}

async function fetchJson(url: string, timeoutMs = 10000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchIndex(asset: "BTC" | "ETH"): Promise<number | null> {
  try {
    const indexName = asset === "BTC" ? "btc_usd" : "eth_usd";
    const j = await fetchJson(`${BASE}/get_index_price?index_name=${indexName}`);
    return j?.result?.index_price ?? null;
  } catch { return null; }
}

export async function fetchChainSnapshot(asset: "BTC" | "ETH"): Promise<ChainSnapshot | null> {
  try {
    const idx = await fetchIndex(asset);
    if (idx == null) return null;
    const j = await fetchJson(`${BASE}/get_book_summary_by_currency?currency=${asset}&kind=option`);
    const items = j?.result;
    if (!Array.isArray(items)) return null;
    const rows: DeribitOptionRow[] = [];
    for (const it of items) {
      const parsed = parseInstr(it.instrument_name, asset);
      if (!parsed) continue;
      rows.push({
        instrument: it.instrument_name,
        asset,
        strike: parsed.strike,
        expiryDate: parsed.expiryDate,
        optionType: parsed.optionType,
        bid: typeof it.bid_price === "number" ? it.bid_price : null,
        ask: typeof it.ask_price === "number" ? it.ask_price : null,
        mark: typeof it.mark_price === "number" ? it.mark_price : null,
        underlying: typeof it.underlying_price === "number" ? it.underlying_price : null,
      });
    }
    return { asset, fetchedAtMs: Date.now(), underlying: idx, rows };
  } catch { return null; }
}

/** Find the live-chain expiry closest to targetDays with at least minStrikes per side. */
export function findClosestExpiry(chain: ChainSnapshot, targetDays: number, minStrikes = 6): string | null {
  const today = new Date();
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

/** Find a vertical spread with a target long-strike and target width. */
export function findVerticalSpread(
  chain: ChainSnapshot,
  expiryDate: string,
  optionType: "C" | "P",
  targetLong: number,
  targetWidth?: number,
): { K_long: number; K_short: number; longRow: DeribitOptionRow; shortRow: DeribitOptionRow } | null {
  const strikes = new Map<number, DeribitOptionRow>();
  for (const r of chain.rows) {
    if (r.expiryDate !== expiryDate || r.optionType !== optionType) continue;
    if (r.bid == null || r.ask == null || r.bid <= 0 || r.ask <= 0) continue;
    strikes.set(r.strike, r);
  }
  if (strikes.size < 2) return null;
  const sorted = [...strikes.keys()].sort((a, b) => a - b);

  // Snap K_long to nearest listed strike to target.
  let K_long = sorted[0], best = Math.abs(K_long - targetLong);
  for (const s of sorted) {
    const d = Math.abs(s - targetLong);
    if (d < best) { best = d; K_long = s; }
  }

  let K_short: number;
  if (targetWidth && targetWidth > 0) {
    const desired = optionType === "P" ? K_long - targetWidth : K_long + targetWidth;
    const candidates = optionType === "P" ? sorted.filter(s => s < K_long) : sorted.filter(s => s > K_long);
    if (!candidates.length) return null;
    K_short = candidates[0];
    let bestS = Math.abs(K_short - desired);
    for (const s of candidates) {
      const d = Math.abs(s - desired);
      if (d < bestS) { bestS = d; K_short = s; }
    }
  } else {
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

  return { K_long, K_short, longRow: strikes.get(K_long)!, shortRow: strikes.get(K_short)! };
}
