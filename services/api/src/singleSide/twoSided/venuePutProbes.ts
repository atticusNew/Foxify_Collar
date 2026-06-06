/**
 * Per-venue single put-quote probes for the floor tool — fetch the protective put at an
 * ARBITRARY strike + tenor directly from each venue (NOT the vol-facility chain cache,
 * which only holds the narrow ~2d ATM window). Read-only.
 *
 * Deribit: public REST (no keys). Bullish: via the shared client (getMarkets + orderbook).
 * OKX: see okxProbe. All return a put ask in USDC/BTC at the nearest listed strike+expiry.
 */

import type { OkxFetcher } from "./okxProbe";

export type VenuePut = {
  venue: string;
  ask_usdc_per_btc: number | null;
  bid_usdc_per_btc?: number | null;
  instrument: string | null;
  strike?: number | null;
  expiry_iso?: string | null;
  /** Top-of-book relative spread (ask−bid)/mid in [0,∞); null when a side is missing. Liquidity-quality signal. */
  spread_pct?: number | null;
  /** Days from now to the chosen listed expiry (so the caller can normalize cross-venue tenor). */
  days_to_expiry?: number | null;
  /** Book levels normalized to USDC/BTC price + BTC size. For depth-aware (B4) pricing. */
  ask_levels?: Array<{ price_usdc_per_btc: number; size_btc: number }>;
  bid_levels?: Array<{ price_usdc_per_btc: number; size_btc: number }>;
};

const DERIBIT_BASE = process.env.DERIBIT_REST_BASE ?? "https://www.deribit.com";
const defaultFetcher: OkxFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  return res.json();
};

/** Relative top-of-book spread (ask−bid)/mid in USDC terms; null unless both sides are present and positive. */
const spreadPctOf = (askUsdc: number | null, bidUsdc: number | null): number | null => {
  if (askUsdc == null || bidUsdc == null || askUsdc <= 0 || bidUsdc <= 0) return null;
  const mid = (askUsdc + bidUsdc) / 2;
  return mid > 0 ? +(((askUsdc - bidUsdc) / mid)).toFixed(4) : null;
};

/** Deribit public put probe — premium quoted in BTC → ×spot = USDC/BTC. */
export const deribitPutProbe = async (opts: {
  spot: number; strike: number; tenorDays: number; optType?: "put" | "call"; nowMs?: number; fetcher?: OkxFetcher;
}): Promise<VenuePut> => {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const now = opts.nowMs ?? Date.now();
  const optType = opts.optType ?? "put";
  try {
    const resp = (await fetcher(`${DERIBIT_BASE}/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false`)) as {
      result?: Array<{ instrument_name?: string; strike?: number; option_type?: string; expiration_timestamp?: number }>;
    };
    const puts = (resp.result ?? []).filter((r) => r.option_type === optType && r.strike != null && r.expiration_timestamp != null && r.expiration_timestamp > now);
    if (puts.length === 0) return { venue: "deribit", ask_usdc_per_btc: null, instrument: null };
    const targetMs = now + opts.tenorDays * 86_400_000;
    const expiries = [...new Set(puts.map((p) => p.expiration_timestamp!))].sort((a, b) => Math.abs(a - targetMs) - Math.abs(b - targetMs));
    const expiry = expiries[0];
    const inst = puts.filter((p) => p.expiration_timestamp === expiry).sort((a, b) => Math.abs(a.strike! - opts.strike) - Math.abs(b.strike! - opts.strike))[0];
    const ob = (await fetcher(`${DERIBIT_BASE}/api/v2/public/get_order_book?instrument_name=${inst.instrument_name}`)) as { result?: { best_ask_price?: number; best_bid_price?: number; asks?: number[][]; bids?: number[][] } };
    const askBtc = ob.result?.best_ask_price;
    const bidBtc = ob.result?.best_bid_price;
    const askU = askBtc != null && askBtc > 0 ? +(askBtc * opts.spot).toFixed(2) : null;
    const bidU = bidBtc != null && bidBtc > 0 ? +(bidBtc * opts.spot).toFixed(2) : null;
    // Deribit BTC options: contract_size = 1.0 → order-book amount is already in BTC (public-API confirmed).
    const toLevels = (rows?: number[][]) =>
      (rows ?? [])
        .map((r) => ({ price_usdc_per_btc: +(Number(r[0]) * opts.spot).toFixed(2), size_btc: +Number(r[1]).toFixed(8) }))
        .filter((l) => l.price_usdc_per_btc > 0 && l.size_btc > 0);
    return {
      venue: "deribit",
      ask_usdc_per_btc: askU,
      bid_usdc_per_btc: bidU,
      instrument: inst.instrument_name ?? null,
      strike: inst.strike ?? null,
      expiry_iso: new Date(expiry).toISOString(),
      spread_pct: spreadPctOf(askU, bidU),
      days_to_expiry: +((expiry - now) / 86_400_000).toFixed(2),
      ask_levels: toLevels(ob.result?.asks),
      bid_levels: toLevels(ob.result?.bids)
    };
  } catch {
    return { venue: "deribit", ask_usdc_per_btc: null, instrument: null };
  }
};

/** Bybit option probe (read-only public data) — Bybit as a SOURCING venue, not just the benchmark.
 *  Quotes are USDC per BTC (no spot conversion). Region-gated (works from the Singapore deploy);
 *  returns a null ask elsewhere so it simply doesn't win/participate. */
export const bybitPutProbe = async (opts: {
  spot: number; strike: number; tenorDays: number; optType?: "put" | "call"; nowMs?: number;
}): Promise<VenuePut> => {
  const now = opts.nowMs ?? Date.now();
  const optType = opts.optType ?? "put";
  try {
    const { getBybitOptionBook } = await import("../../bybitAdapter");
    const book = await getBybitOptionBook("BTC", now + opts.tenorDays * 86_400_000, opts.strike, optType === "put" ? "P" : "C");
    if (!book || book.ask_usdc_per_btc == null) return { venue: "bybit", ask_usdc_per_btc: null, instrument: null };
    return {
      venue: "bybit",
      ask_usdc_per_btc: book.ask_usdc_per_btc,
      bid_usdc_per_btc: book.bid_usdc_per_btc,
      instrument: book.symbol,
      strike: book.strike,
      expiry_iso: new Date(book.expiry_ms).toISOString(),
      spread_pct: spreadPctOf(book.ask_usdc_per_btc, book.bid_usdc_per_btc),
      days_to_expiry: +((book.expiry_ms - now) / 86_400_000).toFixed(2),
      ask_levels: book.ask_levels,
      bid_levels: book.bid_levels
    };
  } catch {
    return { venue: "bybit", ask_usdc_per_btc: null, instrument: null };
  }
};

/** Bullish put probe via the shared client (USDC-quoted → no spot conversion). */
export type BullishProbeClientLike = {
  getMarkets?: (params?: { forceRefresh?: boolean; cacheTtlMs?: number }) => Promise<Array<Record<string, unknown>>>;
  getHybridOrderBook?: (symbol: string) => Promise<{ asks?: Array<{ price: string | number }>; bids?: Array<{ price: string | number }> }>;
};
export const bullishPutProbe = async (
  client: BullishProbeClientLike | null | undefined,
  opts: { spot: number; strike: number; tenorDays: number; optType?: "put" | "call"; nowMs?: number }
): Promise<VenuePut> => {
  if (!client?.getMarkets || !client?.getHybridOrderBook) return { venue: "bullish", ask_usdc_per_btc: null, instrument: null };
  const now = opts.nowMs ?? Date.now();
  const optType = (opts.optType ?? "put").toUpperCase();
  try {
    const markets = await client.getMarkets({ cacheTtlMs: 60_000 });
    const puts = markets
      .filter((m) => String(m.underlyingBaseSymbol ?? "").toUpperCase() === "BTC" && String(m.optionType ?? "").toUpperCase() === optType && m.marketEnabled)
      .map((m) => ({ symbol: String(m.symbol ?? ""), strike: Number(m.optionStrikePrice ?? 0), expiryMs: Date.parse(String(m.expiryDatetime ?? "")) }))
      .filter((m) => m.strike > 0 && Number.isFinite(m.expiryMs) && m.expiryMs > now);
    if (puts.length === 0) return { venue: "bullish", ask_usdc_per_btc: null, instrument: null };
    const targetMs = now + opts.tenorDays * 86_400_000;
    const expiry = [...new Set(puts.map((p) => p.expiryMs))].sort((a, b) => Math.abs(a - targetMs) - Math.abs(b - targetMs))[0];
    const inst = puts.filter((p) => p.expiryMs === expiry).sort((a, b) => Math.abs(a.strike - opts.strike) - Math.abs(b.strike - opts.strike))[0];
    const ob = await client.getHybridOrderBook(inst.symbol);
    const ask = ob.asks?.[0]?.price != null ? Number(ob.asks[0].price) : null; // Bullish quotes USDC per option
    const bid = ob.bids?.[0]?.price != null ? Number(ob.bids[0].price) : null;
    const askU = ask != null && ask > 0 ? +ask.toFixed(2) : null;
    const bidU = bid != null && bid > 0 ? +bid.toFixed(2) : null;
    return {
      venue: "bullish",
      ask_usdc_per_btc: askU,
      bid_usdc_per_btc: bidU,
      instrument: inst.symbol,
      strike: inst.strike ?? null,
      expiry_iso: new Date(expiry).toISOString(),
      spread_pct: spreadPctOf(askU, bidU),
      days_to_expiry: +((expiry - now) / 86_400_000).toFixed(2)
    };
  } catch {
    return { venue: "bullish", ask_usdc_per_btc: null, instrument: null };
  }
};
