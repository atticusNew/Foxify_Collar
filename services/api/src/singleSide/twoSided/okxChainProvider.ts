/**
 * OKX chain provider — read-only multi-strike BTC option snapshot (public REST, NO keys).
 *
 * Phase 1 of OKX-as-a-venue. Returns OKX coin-margined `BTC-USD-…` option quotes (premium
 * in BTC → ×spot = USDC/BTC, mirroring Deribit) across a strike+tenor window, plus the
 * contract value (ctVal, BTC/contract) read straight from OKX so sizing/depth are exact —
 * the operator doesn't need to know the multiplier.
 *
 * This module is ISOLATED: it does not (yet) merge into LiquidChainCache, the venue
 * selector, or execution. Wiring OKX into routing (widening the Venue type + making
 * pickLegVenue N-venue) is the next, careful increment — done gated (OKX_CHAIN_ENABLED).
 */

import { parseOkxOption, type OkxFetcher } from "./okxProbe";

const OKX_BASE = process.env.OKX_REST_BASE ?? "https://www.okx.com";

const defaultFetcher: OkxFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  return res.json();
};

export type OkxChainQuote = {
  venue: "okx";
  instrument_name: string;
  strike: number;
  optType: "put" | "call";
  tenorHours: number;
  bidUsdcPerBtc: number;
  askUsdcPerBtc: number;
  midUsdcPerBtc: number;
  spreadPct: number;
  bidSizeBtc: number;   // top-of-book depth in BTC (contracts × ctVal)
  askSizeBtc: number;
};

export type OkxChainConfig = {
  centerSpot: number;
  strikeWindowUsdc: number;
  centerTenorDays: number;
  tenorWindowDays: number;
  maxOrderbookFetches?: number;   // cap orderbook calls to nearest-N strikes (rate-limit guard)
};

/** Fetch a read-only OKX BTC option chain snapshot. ctVal is read from the instruments API. */
export const fetchOkxChainSnapshot = async (
  spot: number,
  config: OkxChainConfig,
  fetcher: OkxFetcher = defaultFetcher,
  nowMs = Date.now()
): Promise<{ spot: number; ctVal: number; quotes: OkxChainQuote[] }> => {
  const targetTenorMs = config.centerTenorDays * 86_400_000;
  const tenorWindowMs = config.tenorWindowDays * 86_400_000;

  const instrResp = (await fetcher(`${OKX_BASE}/api/v5/public/instruments?instType=OPTION&uly=BTC-USD`)) as {
    data?: Array<{ instId?: string; ctVal?: string }>;
  };
  const rows = instrResp.data ?? [];
  // Contract value (BTC per contract), read from OKX (e.g. "0.01"). Default 0.01 if absent.
  const ctVal = (() => {
    const v = Number(rows.find((r) => r.ctVal != null)?.ctVal);
    return Number.isFinite(v) && v > 0 ? v : 0.01;
  })();

  // Filter to coin-margined BTC-USD options inside the strike + tenor window.
  const candidates = rows
    .map((r) => ({ instId: String(r.instId ?? ""), parsed: parseOkxOption(String(r.instId ?? "")) }))
    .filter((x): x is { instId: string; parsed: { strike: number; optType: "put" | "call"; expiryMs: number } } => x.parsed != null)
    .filter((x) => Math.abs(x.parsed.strike - config.centerSpot) <= config.strikeWindowUsdc)
    .filter((x) => x.parsed.expiryMs > nowMs && Math.abs((x.parsed.expiryMs - nowMs) - targetTenorMs) <= tenorWindowMs);

  // Rate-limit guard: keep only the strikes NEAREST centerSpot.
  const maxFetches = config.maxOrderbookFetches ?? 16;
  const fetchList = maxFetches > 0 && candidates.length > maxFetches
    ? [...candidates].sort((a, b) => Math.abs(a.parsed.strike - config.centerSpot) - Math.abs(b.parsed.strike - config.centerSpot)).slice(0, maxFetches)
    : candidates;

  const quotes: OkxChainQuote[] = [];
  for (const c of fetchList) {
    const book = (await fetcher(`${OKX_BASE}/api/v5/market/books?instId=${c.instId}&sz=1`)) as { data?: Array<{ bids?: string[][]; asks?: string[][] }> };
    const top = book.data?.[0];
    const bidBtc = top?.bids?.[0]?.[0] != null ? Number(top.bids[0][0]) : null;
    const askBtc = top?.asks?.[0]?.[0] != null ? Number(top.asks[0][0]) : null;
    if (bidBtc == null || askBtc == null || bidBtc <= 0 || askBtc <= 0) continue;
    const bidU = bidBtc * spot;
    const askU = askBtc * spot;
    const mid = (bidU + askU) / 2;
    if (mid <= 0) continue;
    quotes.push({
      venue: "okx",
      instrument_name: c.instId,
      strike: c.parsed.strike,
      optType: c.parsed.optType,
      tenorHours: (c.parsed.expiryMs - nowMs) / 3_600_000,
      bidUsdcPerBtc: bidU,
      askUsdcPerBtc: askU,
      midUsdcPerBtc: mid,
      spreadPct: (askU - bidU) / mid,
      bidSizeBtc: (top?.bids?.[0]?.[1] != null ? Number(top.bids[0][1]) : 0) * ctVal,
      askSizeBtc: (top?.asks?.[0]?.[1] != null ? Number(top.asks[0][1]) : 0) * ctVal
    });
  }
  return { spot, ctVal, quotes };
};
