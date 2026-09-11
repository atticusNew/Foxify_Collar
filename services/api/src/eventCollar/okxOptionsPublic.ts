/**
 * OKX public option market data — read-only, unauthenticated.
 * Uses only /public and /market endpoints; this module cannot place orders.
 * OKX_REST_BASE can point at the Singapore egress relay when a region blocks
 * direct access (same env convention as the rest of the platform).
 */

import type { OkxBookLevel, OkxOptionBook, OkxOptionInstrument } from "./types";
import { fetchJsonWithRetry } from "./kalshiPublic";

const DEFAULT_BASE = "https://www.okx.com";

export function okxBase(): string {
  return process.env.OKX_REST_BASE?.replace(/\/$/, "") || DEFAULT_BASE;
}

export function parseOkxInstrument(raw: Record<string, unknown>): OkxOptionInstrument | null {
  const instId = String(raw.instId ?? "");
  const parts = instId.split("-");
  if (parts.length !== 5) return null;
  const [, , expiry, strikeStr, optType] = parts;
  if (optType !== "C" && optType !== "P") return null;
  const strike = Number(strikeStr);
  if (!Number.isFinite(strike)) return null;
  const ctMultBtc = Number(raw.ctMult ?? 0) * Number(raw.ctVal ?? 0);
  return { instId, expiry, strike, optType, ctMultBtc: ctMultBtc || 0.01 };
}

let instrumentsCache: { at: number; list: OkxOptionInstrument[] } | null = null;
const INSTRUMENTS_TTL_MS = 10 * 60 * 1000;

export async function getBtcOptionInstruments(
  fetchImpl: typeof fetch = fetch,
): Promise<OkxOptionInstrument[]> {
  if (instrumentsCache && Date.now() - instrumentsCache.at < INSTRUMENTS_TTL_MS) {
    return instrumentsCache.list;
  }
  const url = `${okxBase()}/api/v5/public/instruments?instType=OPTION&instFamily=BTC-USD`;
  const data = (await fetchJsonWithRetry(url, fetchImpl)) as {
    data?: Record<string, unknown>[];
  };
  const list = (data.data ?? [])
    .map(parseOkxInstrument)
    .filter((i): i is OkxOptionInstrument => i !== null);
  instrumentsCache = { at: Date.now(), list };
  return list;
}

/** For tests. */
export function clearInstrumentsCache(): void {
  instrumentsCache = null;
}

export async function getBtcIndexUsd(fetchImpl: typeof fetch = fetch): Promise<number> {
  const url = `${okxBase()}/api/v5/market/index-tickers?instId=BTC-USD`;
  const data = (await fetchJsonWithRetry(url, fetchImpl)) as {
    data?: { idxPx?: string }[];
  };
  const px = Number(data.data?.[0]?.idxPx ?? 0);
  if (!Number.isFinite(px) || px <= 0) throw new Error("okx index unavailable");
  return px;
}

export function parseOkxBook(instId: string, raw: Record<string, unknown>): OkxOptionBook {
  const toLevels = (rows: unknown): OkxBookLevel[] =>
    (Array.isArray(rows) ? rows : []).map((r) => ({
      priceBtc: Number((r as string[])[0] ?? 0),
      sizeContracts: Number((r as string[])[1] ?? 0),
    }));
  return {
    instId,
    asks: toLevels(raw.asks),
    bids: toLevels(raw.bids),
    ts: Number(raw.ts ?? Date.now()),
  };
}

export async function getOptionBook(
  instId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OkxOptionBook> {
  const url = `${okxBase()}/api/v5/market/books?instId=${encodeURIComponent(instId)}&sz=20`;
  const data = (await fetchJsonWithRetry(url, fetchImpl)) as {
    data?: Record<string, unknown>[];
  };
  const raw = data.data?.[0];
  if (!raw) return { instId, asks: [], bids: [], ts: Date.now() };
  return parseOkxBook(instId, raw);
}

/** OKX daily options expire 08:00 UTC on the date encoded in the instId. */
export function expiryToDate(expiry: string): Date {
  const yy = Number(expiry.slice(0, 2));
  const mm = Number(expiry.slice(2, 4));
  const dd = Number(expiry.slice(4, 6));
  return new Date(Date.UTC(2000 + yy, mm - 1, dd, 8, 0, 0));
}

/** Nearest listed expiry at or after the given time; null when none exists. */
export function nearestExpiryAtOrAfter(
  instruments: OkxOptionInstrument[],
  when: Date,
): string | null {
  const expiries = [...new Set(instruments.map((i) => i.expiry))].sort();
  for (const e of expiries) {
    if (expiryToDate(e).getTime() >= when.getTime()) return e;
  }
  return null;
}

/**
 * The adjacent listed put strikes bracketing a level, for one expiry.
 * Returns null when the level falls outside the listed grid.
 */
export function bracketingPutStrikes(
  instruments: OkxOptionInstrument[],
  expiry: string,
  level: number,
): { lowStrike: number; highStrike: number; lowInstId: string; highInstId: string } | null {
  const puts = instruments
    .filter((i) => i.expiry === expiry && i.optType === "P")
    .sort((a, b) => a.strike - b.strike);
  let low: OkxOptionInstrument | null = null;
  let high: OkxOptionInstrument | null = null;
  for (const p of puts) {
    if (p.strike <= level) low = p;
    if (p.strike > level) {
      high = p;
      break;
    }
  }
  if (!low || !high) return null;
  return {
    lowStrike: low.strike,
    highStrike: high.strike,
    lowInstId: low.instId,
    highInstId: high.instId,
  };
}
