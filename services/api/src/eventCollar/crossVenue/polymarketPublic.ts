/**
 * Polymarket public market data — read-only, no keys, no wallet.
 * Gamma API for market metadata, CLOB API for order books. Both are public;
 * this module is structurally unable to trade.
 *
 * Price strings ("0.535") and size strings ("1025.01") are parsed EXACTLY to
 * integer milli units (1000 = $1 / 1 share); anything with more than three
 * decimals is truncated against the holder (prices round up on the ask we pay,
 * sizes round down on the depth we trust).
 */

import { fetchJsonWithRetry } from "../kalshiPublic";
import type { PmBook, PmBookLevel, PmMarket } from "./types";

const DEFAULT_GAMMA_BASE = "https://gamma-api.polymarket.com";
const DEFAULT_CLOB_BASE = "https://clob.polymarket.com";

export function gammaBase(): string {
  return process.env.PM_GAMMA_REST_BASE?.replace(/\/$/, "") || DEFAULT_GAMMA_BASE;
}

export function clobBase(): string {
  return process.env.PM_CLOB_REST_BASE?.replace(/\/$/, "") || DEFAULT_CLOB_BASE;
}

/**
 * Exact decimal-string to integer milli units (1000 = 1.0).
 * roundUp controls the direction applied to a fourth-or-later decimal digit.
 */
export function decimalToMilli(value: string | number | undefined, roundUp: boolean): number {
  if (value === undefined || value === null) return -1;
  const s = String(value).trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return -1;
  const whole = Number(m[1]);
  const fracRaw = m[2] ?? "";
  const frac3 = fracRaw.padEnd(3, "0").slice(0, 3);
  let milli = whole * 1000 + Number(frac3);
  if (roundUp && fracRaw.length > 3 && /[1-9]/.test(fracRaw.slice(3))) milli += 1;
  return milli;
}

/** Gamma stores some list fields as JSON strings; accept both shapes. */
function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Gamma's gameStartTime is "YYYY-MM-DD HH:MM:SS+00"; normalize to ISO. */
export function normalizeGammaTime(v: unknown): string | null {
  if (!v || typeof v !== "string") return null;
  const s = v.trim().replace(" ", "T");
  const withZone = /([+-]\d{2}(:?\d{2})?|Z)$/.test(s) ? s.replace(/\+00$/, "Z") : `${s}Z`;
  const t = new Date(withZone);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/** Normalize one raw Gamma market inside an event. Exported for tests. */
export function parsePmMarket(
  raw: Record<string, unknown>,
  eventSlug: string,
  eventTitle: string,
): PmMarket {
  const outcomes = asStringArray(raw.outcomes);
  const tokenIds = asStringArray(raw.clobTokenIds);
  const prices = asStringArray(raw.outcomePrices).map((p) => decimalToMilli(p, false));
  return {
    eventSlug,
    eventTitle,
    question: String(raw.question ?? ""),
    conditionId: String(raw.conditionId ?? ""),
    outcomes,
    tokenIds,
    outcomePricesMilli: prices,
    gameStartTime: normalizeGammaTime(raw.gameStartTime),
    endDate: typeof raw.endDate === "string" ? raw.endDate : null,
    sportsMarketType: String(raw.sportsMarketType ?? ""),
    active: raw.active === true,
    closed: raw.closed === true,
    acceptingOrders: raw.acceptingOrders === true,
    negRisk: raw.negRisk === true,
    orderMinSizeShares: Number(raw.orderMinSize ?? 5),
    liquidityUsd: Number(raw.liquidity ?? 0),
    volumeUsd: Number(raw.volume ?? 0),
  };
}

/** Fetch one Gamma event by slug; returns its markets (empty when absent). */
export async function getEventMarketsBySlug(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PmMarket[]> {
  const url = `${gammaBase()}/events?slug=${encodeURIComponent(slug)}`;
  const data = (await fetchJsonWithRetry(url, fetchImpl)) as Array<Record<string, unknown>>;
  const out: PmMarket[] = [];
  for (const ev of data ?? []) {
    const evSlug = String(ev.slug ?? "");
    const evTitle = String(ev.title ?? "");
    for (const m of (ev.markets as Record<string, unknown>[]) ?? []) {
      out.push(parsePmMarket(m, evSlug, evTitle));
    }
  }
  return out;
}

/** Parse one raw CLOB book. Levels arrive worst-first; we sort best-first. */
export function parsePmBook(raw: Record<string, unknown>, tokenId: string): PmBook {
  const side = (v: unknown, priceRoundUp: boolean): PmBookLevel[] => {
    const levels: PmBookLevel[] = [];
    for (const l of (v as Array<Record<string, unknown>>) ?? []) {
      const priceMilli = decimalToMilli(l.price as string, priceRoundUp);
      const sizeMilli = decimalToMilli(l.size as string, false);
      if (priceMilli > 0 && sizeMilli > 0) levels.push({ priceMilli, sizeMilli });
    }
    return levels;
  };
  const asks = side(raw.asks, true).sort((a, b) => a.priceMilli - b.priceMilli);
  const bids = side(raw.bids, false).sort((a, b) => b.priceMilli - a.priceMilli);
  return {
    tokenId,
    asks,
    bids,
    minOrderSizeShares: Number(raw.min_order_size ?? 5),
    tickMilli: decimalToMilli(raw.tick_size as string, false),
  };
}

/** Live CLOB order book for one outcome token. */
export async function getPmBook(
  tokenId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PmBook> {
  const url = `${clobBase()}/book?token_id=${encodeURIComponent(tokenId)}`;
  const data = (await fetchJsonWithRetry(url, fetchImpl)) as Record<string, unknown>;
  return parsePmBook(data, tokenId);
}
