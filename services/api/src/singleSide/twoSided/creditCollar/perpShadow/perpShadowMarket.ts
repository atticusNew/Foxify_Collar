/**
 * The perp shadow's market reads, all public and unsigned:
 *   - Hyperliquid mark and funding (the position's price and carry),
 *   - OKX BTC-USD index (the hedge venue's price; the basis between the two),
 *   - OKX delivery price at expiry (the official print the hedge settles at).
 *   - Hyperliquid candles (the mark path a knock-out is judged on) and OKX
 *     index candles around a touch (did the hedge venue's clock see it too).
 * Every fetch is injectable so tests run on fixtures and never touch a venue.
 */

import { parseHlCandles, parseOkxIndexCandles, type Candle } from "./perpShadowPath";

export interface HlContext {
  markPx: number;
  oraclePx: number | null;
  fundingBpsPer8h: number | null;
}

/** metaAndAssetCtxs: [{ universe: [{name}] }, [{ markPx, oraclePx, funding }]] */
export const parseHlContext = (raw: unknown, coin: string): HlContext | null => {
  const arr = raw as [{ universe?: Array<{ name: string }> }, Array<{ markPx?: string; oraclePx?: string; funding?: string }>];
  const idx = arr?.[0]?.universe?.findIndex((u) => u.name === coin) ?? -1;
  const ctx = idx >= 0 ? arr[1]?.[idx] : undefined;
  const mark = Number(ctx?.markPx);
  if (!Number.isFinite(mark) || mark <= 0) return null;
  const oracle = Number(ctx?.oraclePx);
  const funding = Number(ctx?.funding);
  return {
    markPx: mark,
    oraclePx: Number.isFinite(oracle) && oracle > 0 ? oracle : null,
    fundingBpsPer8h: Number.isFinite(funding) ? +(funding * 10000).toFixed(3) : null,
  };
};

export const fetchHlContext = async (coin: string, base = process.env.HL_API_BASE || "https://api.hyperliquid.xyz", f: typeof fetch = fetch): Promise<HlContext | null> => {
  const res = await f(`${base}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Hyperliquid /info HTTP ${res.status}`);
  return parseHlContext(await res.json(), coin);
};

export const parseOkxIndex = (raw: unknown): number | null => {
  const px = Number((raw as { data?: Array<{ idxPx?: string }> })?.data?.[0]?.idxPx);
  return Number.isFinite(px) && px > 0 ? px : null;
};

export const fetchOkxIndex = async (base = process.env.OKX_REST_BASE || "https://www.okx.com", f: typeof fetch = fetch): Promise<number | null> => {
  const res = await f(`${base}/api/v5/market/index-tickers?instId=BTC-USD`, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`OKX index-tickers HTTP ${res.status}`);
  return parseOkxIndex(await res.json());
};

/** BTC-USD-YYMMDD-STRIKE-C → the YYMMDD the instrument expires */
const dateCodeOf = (instId: string): string | null => /^BTC-USD-(\d{6})-/.exec(instId)?.[1] ?? null;
export const dateCodeForExpiry = (expiryMs: number): string => {
  const d = new Date(expiryMs);
  return `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
};

/**
 * delivery-exercise-history: [{ ts, details: [{ insId, px, type }] }]. Every
 * instrument at one expiry delivers at the same price; the first match for
 * the expiry's date code is the official print.
 */
export const deliveryPriceFor = (raw: unknown, expiryMs: number): number | null => {
  const code = dateCodeForExpiry(expiryMs);
  const rows = (raw as { data?: Array<{ details?: Array<{ insId?: string; px?: string }> }> })?.data ?? [];
  for (const row of rows) {
    for (const d of row.details ?? []) {
      if (d.insId && dateCodeOf(d.insId) === code) {
        const px = Number(d.px);
        if (Number.isFinite(px) && px > 0) return px;
      }
    }
  }
  return null;
};

/** Hyperliquid candles over [startMs, endMs]: the mark path the knock-out is judged on. */
export const fetchHlCandles = async (
  coin: string,
  startMs: number,
  endMs: number,
  interval: "1m" | "5m",
  base = process.env.HL_API_BASE || "https://api.hyperliquid.xyz",
  f: typeof fetch = fetch,
): Promise<Candle[]> => {
  const res = await f(`${base}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval, startTime: startMs, endTime: endMs } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Hyperliquid candleSnapshot HTTP ${res.status}`);
  return parseHlCandles(await res.json());
};

/** OKX BTC-USD index 1m candles in the minutes around `aroundMs` (one request; `after` pages backward from its bound). */
export const fetchOkxIndexCandlesAround = async (
  aroundMs: number,
  windowMs = 3 * 60_000,
  base = process.env.OKX_REST_BASE || "https://www.okx.com",
  f: typeof fetch = fetch,
): Promise<Candle[]> => {
  const limit = Math.ceil((2 * windowMs) / 60_000) + 2;
  const res = await f(`${base}/api/v5/market/index-candles?instId=BTC-USD&bar=1m&after=${aroundMs + windowMs + 60_000}&limit=${limit}`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`OKX index-candles HTTP ${res.status}`);
  return parseOkxIndexCandles(await res.json());
};

export const fetchOkxDeliveryPrice = async (
  expiryMs: number,
  base = process.env.OKX_REST_BASE || "https://www.okx.com",
  f: typeof fetch = fetch,
): Promise<number | null> => {
  const res = await f(`${base}/api/v5/public/delivery-exercise-history?instType=OPTION&uly=BTC-USD&limit=100`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`OKX delivery-exercise-history HTTP ${res.status}`);
  return deliveryPriceFor(await res.json(), expiryMs);
};
