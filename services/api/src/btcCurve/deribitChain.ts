/**
 * Deribit BTC option chain — public book summaries (one call, every instrument), no key.
 * Deribit options expire 08:00 UTC on the date in the instrument name.
 */

import { fetchJsonWithRetry } from "../eventCollar/kalshiPublic";
import type { OptionRow } from "./types";

const DEFAULT_BASE = "https://www.deribit.com";

export function deribitBase(): string {
  return process.env.DERIBIT_REST_BASE?.replace(/\/$/, "") || DEFAULT_BASE;
}

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/** `25DEC26` → 2026-12-25T08:00:00Z in ms; NaN when the tag does not parse. */
export function expiryTagToMs(tag: string): number {
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(tag);
  if (!m) return Number.NaN;
  const mon = MONTHS[m[2]];
  if (mon === undefined) return Number.NaN;
  return Date.UTC(2000 + Number(m[3]), mon, Number(m[1]), 8, 0, 0);
}

interface RawSummary {
  instrument_name: string;
  mark_price?: number;
  mark_iv?: number;
  bid_price?: number | null;
  ask_price?: number | null;
  underlying_price?: number;
  open_interest?: number;
}

/** Exported for tests. */
export function parseSummary(r: RawSummary): OptionRow | null {
  const parts = String(r.instrument_name ?? "").split("-");
  if (parts.length !== 4 || parts[0] !== "BTC") return null;
  const [, tag, strikeStr, type] = parts;
  if (type !== "C" && type !== "P") return null;
  const strike = Number(strikeStr);
  const expiryMs = expiryTagToMs(tag);
  if (!Number.isFinite(strike) || !Number.isFinite(expiryMs)) return null;
  const markIv = Number(r.mark_iv ?? 0) / 100;
  return {
    instrument: r.instrument_name,
    expiry: tag,
    expiryMs,
    strike,
    type,
    markIv,
    markPrice: Number(r.mark_price ?? 0),
    bidPrice: Number(r.bid_price ?? 0),
    askPrice: Number(r.ask_price ?? 0),
    forward: Number(r.underlying_price ?? 0),
    openInterest: Number(r.open_interest ?? 0),
  };
}

export async function fetchChain(fetchImpl: typeof fetch = fetch): Promise<OptionRow[]> {
  const data = (await fetchJsonWithRetry(
    `${deribitBase()}/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option`,
    fetchImpl,
  )) as { result?: RawSummary[] };
  return (data.result ?? []).map(parseSummary).filter((r): r is OptionRow => r !== null);
}

export async function fetchDeribitIndex(fetchImpl: typeof fetch = fetch): Promise<number> {
  const data = (await fetchJsonWithRetry(`${deribitBase()}/api/v2/public/get_index_price?index_name=btc_usd`, fetchImpl)) as {
    result?: { index_price?: number };
  };
  const px = Number(data.result?.index_price ?? 0);
  if (!(px > 0)) throw new Error("deribit index unavailable");
  return px;
}

/**
 * The subset worth keeping per snapshot: the expiries nearest each settlement instant we
 * care about (plus the two soonest, for intraday ladders), strikes within ±`band` of the forward.
 * Exported for tests.
 */
export function selectRows(rows: OptionRow[], settleInstantsMs: number[], nowMs: number, band = 0.6): OptionRow[] {
  const expiries = [...new Set(rows.map((r) => r.expiryMs))].filter((e) => e > nowMs).sort((a, b) => a - b);
  const keep = new Set<number>(expiries.slice(0, 2));
  for (const s of settleInstantsMs) {
    let best = Number.NaN;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const e of expiries) {
      const d = Math.abs(e - s);
      if (d < bestDiff) {
        best = e;
        bestDiff = d;
      }
    }
    if (Number.isFinite(best)) keep.add(best);
  }
  return rows.filter((r) => keep.has(r.expiryMs) && r.forward > 0 && Math.abs(r.strike / r.forward - 1) <= band);
}
