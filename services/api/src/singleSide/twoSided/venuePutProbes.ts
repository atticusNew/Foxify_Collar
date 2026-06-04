/**
 * Per-venue single put-quote probes for the floor tool — fetch the protective put at an
 * ARBITRARY strike + tenor directly from each venue (NOT the vol-facility chain cache,
 * which only holds the narrow ~2d ATM window). Read-only.
 *
 * Deribit: public REST (no keys). Bullish: via the shared client (getMarkets + orderbook).
 * OKX: see okxProbe. All return a put ask in USDC/BTC at the nearest listed strike+expiry.
 */

import type { OkxFetcher } from "./okxProbe";

export type VenuePut = { venue: string; ask_usdc_per_btc: number | null; bid_usdc_per_btc?: number | null; instrument: string | null; strike?: number | null; expiry_iso?: string | null };

const DERIBIT_BASE = process.env.DERIBIT_REST_BASE ?? "https://www.deribit.com";
const defaultFetcher: OkxFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  return res.json();
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
    const ob = (await fetcher(`${DERIBIT_BASE}/api/v2/public/get_order_book?instrument_name=${inst.instrument_name}`)) as { result?: { best_ask_price?: number; best_bid_price?: number } };
    const askBtc = ob.result?.best_ask_price;
    const bidBtc = ob.result?.best_bid_price;
    return {
      venue: "deribit",
      ask_usdc_per_btc: askBtc != null && askBtc > 0 ? +(askBtc * opts.spot).toFixed(2) : null,
      bid_usdc_per_btc: bidBtc != null && bidBtc > 0 ? +(bidBtc * opts.spot).toFixed(2) : null,
      instrument: inst.instrument_name ?? null,
      strike: inst.strike ?? null,
      expiry_iso: new Date(expiry).toISOString()
    };
  } catch {
    return { venue: "deribit", ask_usdc_per_btc: null, instrument: null };
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
    return { venue: "bullish", ask_usdc_per_btc: ask != null && ask > 0 ? +ask.toFixed(2) : null, bid_usdc_per_btc: bid != null && bid > 0 ? +bid.toFixed(2) : null, instrument: inst.symbol, strike: inst.strike ?? null, expiry_iso: new Date(expiry).toISOString() };
  } catch {
    return { venue: "bullish", ask_usdc_per_btc: null, instrument: null };
  }
};
