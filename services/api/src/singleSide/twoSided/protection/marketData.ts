/**
 * Shared market-data fetchers for the protection signal (and the backtest runner).
 * Public sources only — no keys: BTC 1h OHLC (Binance → Coinbase fallback) + Deribit DVOL.
 */

import type { Candle, DvolPoint } from "../feeRecoveryBacktest";

const HOUR = 3_600_000;

const fetchJson = async (url: string): Promise<unknown> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) return res.json();
      if (res.status !== 429 && res.status < 500) throw new Error(`http_${res.status}`);
    } catch (e) {
      if (attempt === 4) throw e;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw new Error("fetch_failed");
};

const fetchBinanceOhlc = async (fromMs: number, toMs: number): Promise<Candle[]> => {
  const out: Candle[] = [];
  let cursor = fromMs;
  while (cursor < toMs) {
    const rows = (await fetchJson(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=${cursor}&endTime=${toMs}&limit=1000`)) as unknown[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows as number[][]) {
      const tsMs = Number(r[0]), high = Number(r[2]), low = Number(r[3]), close = Number(r[4]);
      if (Number.isFinite(tsMs) && high > 0 && low > 0 && close > 0) out.push({ tsMs, close, high, low });
    }
    const last = Number((rows as number[][])[rows.length - 1][0]);
    if (!Number.isFinite(last)) break;
    cursor = last + HOUR;
  }
  return out;
};

const fetchCoinbaseOhlc = async (fromMs: number, toMs: number): Promise<Candle[]> => {
  const out: Candle[] = [];
  const WINDOW = 300 * HOUR;
  let cursor = fromMs;
  while (cursor < toMs) {
    const end = Math.min(toMs, cursor + WINDOW);
    const rows = (await fetchJson(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600&start=${new Date(cursor).toISOString()}&end=${new Date(end).toISOString()}`)) as number[][];
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const tsMs = Number(r[0]) * 1000, low = Number(r[1]), high = Number(r[2]), close = Number(r[4]);
        if (Number.isFinite(tsMs) && high > 0 && low > 0 && close > 0) out.push({ tsMs, close, high, low });
      }
    }
    cursor = end + 1;
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
};

/** BTC 1h OHLC over [fromMs,toMs], Binance preferred, Coinbase fallback (Binance is geo-blocked in some regions). */
export const fetchBtcOhlc = async (fromMs: number, toMs: number): Promise<Candle[]> => {
  let raw: Candle[] = [];
  try { raw = await fetchBinanceOhlc(fromMs, toMs); } catch { /* fall through */ }
  if (raw.length === 0) raw = await fetchCoinbaseOhlc(fromMs, toMs);
  const dedup = new Map<number, Candle>();
  for (const c of raw) if (c.tsMs >= fromMs && c.tsMs <= toMs) dedup.set(Math.round(c.tsMs / HOUR), c);
  return [...dedup.values()].sort((a, b) => a.tsMs - b.tsMs);
};

/** Deribit DVOL 1h over [fromMs,toMs] (result.data = [[ts,o,h,l,close],...]; take close). */
export const fetchDvol = async (fromMs: number, toMs: number): Promise<DvolPoint[]> => {
  const out: DvolPoint[] = [];
  const CHUNK = 700 * HOUR;
  let start = fromMs;
  while (start < toMs) {
    const end = Math.min(toMs, start + CHUNK);
    const body = (await fetchJson(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${start}&end_timestamp=${end}&resolution=3600`)) as { result?: { data?: number[][] } };
    for (const row of body.result?.data ?? []) {
      const tsMs = Number(row[0]), close = Number(row[4]);
      if (Number.isFinite(tsMs) && close > 0) out.push({ tsMs, dvol: close });
    }
    start = end + 1;
  }
  const dedup = new Map<number, DvolPoint>();
  for (const d of out) dedup.set(Math.round(d.tsMs / HOUR), d);
  return [...dedup.values()].sort((a, b) => a.tsMs - b.tsMs);
};
