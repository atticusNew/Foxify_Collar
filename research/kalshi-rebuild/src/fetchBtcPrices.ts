/**
 * Standalone BTC daily price fetcher for the Kalshi shadow backtest.
 * Fetches from Coinbase (primary) with Binance fallback.
 * Writes a simple date→price map as JSON.
 *
 * Zero imports from the live pilot.
 */

const COINBASE_BASE = "https://api.exchange.coinbase.com";
const BINANCE_BASE = "https://api.binance.com";
const DAY_MS = 86_400_000;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function fetchWithRetry(url: string, maxRetries = 4): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      await sleep(500 * Math.pow(2, attempt));
      continue;
    }
    throw new Error(`http_${res.status}`);
  }
  throw new Error("max_retries_exceeded");
}

/**
 * Per-day OHLC data for path-dependent HIT settlement.
 * Coinbase candles: [time, low, high, open, close, volume].
 */
export type DailyOhlc = { close: number; high: number; low: number };

const ohlcMap = new Map<string, DailyOhlc>();

async function fetchCoinbaseDaily(fromMs: number, toMs: number): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  let cursor = fromMs;
  while (cursor < toMs) {
    const windowEnd = Math.min(toMs, cursor + 300 * DAY_MS);
    const url = new URL("/products/BTC-USD/candles", COINBASE_BASE);
    url.searchParams.set("granularity", "86400");
    url.searchParams.set("start", new Date(cursor).toISOString());
    url.searchParams.set("end", new Date(windowEnd).toISOString());
    try {
      const res = await fetchWithRetry(url.toString());
      const candles = await res.json() as number[][];
      for (const [ts, low, high, , close] of candles) {
        const dateStr = new Date(ts * 1000).toISOString().slice(0, 10);
        if (!result.has(dateStr)) {
          result.set(dateStr, close);
          ohlcMap.set(dateStr, { close, high, low });
        }
      }
    } catch { /* skip window */ }
    cursor = windowEnd;
    await sleep(300);
  }
  return result;
}

/** Get the maximum high (or minimum low) across a date range. */
export function maxHighInRange(fromDate: string, toDate: string): number | null {
  let max: number | null = null;
  const fromMs = new Date(fromDate).getTime();
  const toMs = new Date(toDate).getTime();
  for (const [d, ohlc] of ohlcMap.entries()) {
    const dMs = new Date(d).getTime();
    if (dMs >= fromMs && dMs <= toMs) {
      if (max === null || ohlc.high > max) max = ohlc.high;
    }
  }
  return max;
}

export function minLowInRange(fromDate: string, toDate: string): number | null {
  let min: number | null = null;
  const fromMs = new Date(fromDate).getTime();
  const toMs = new Date(toDate).getTime();
  for (const [d, ohlc] of ohlcMap.entries()) {
    const dMs = new Date(d).getTime();
    if (dMs >= fromMs && dMs <= toMs) {
      if (min === null || ohlc.low < min) min = ohlc.low;
    }
  }
  return min;
}

async function fetchBinanceDaily(fromMs: number, toMs: number): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  let cursor = fromMs;
  while (cursor < toMs) {
    const url = new URL("/api/v3/klines", BINANCE_BASE);
    url.searchParams.set("symbol", "BTCUSDT");
    url.searchParams.set("interval", "1d");
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(toMs));
    url.searchParams.set("limit", "1000");
    try {
      const res = await fetchWithRetry(url.toString());
      const rows = await res.json() as number[][];
      if (!rows.length) break;
      for (const row of rows) {
        const tsMs = Number(row[0]);
        const close = Number(row[4]);
        const dateStr = new Date(tsMs).toISOString().slice(0, 10);
        if (!result.has(dateStr)) result.set(dateStr, close);
      }
      const lastTs = Number(rows[rows.length - 1][0]);
      cursor = lastTs + DAY_MS;
    } catch { break; }
    await sleep(200);
  }
  return result;
}

/**
 * Fetch BTC daily closes for a date range.
 * Returns a Map<YYYY-MM-DD, closePrice>.
 */
export async function fetchBtcDailyPrices(fromDate: string, toDate: string): Promise<Map<string, number>> {
  const fromMs = new Date(fromDate).getTime();
  const toMs = new Date(toDate).getTime() + DAY_MS;

  try {
    const prices = await fetchCoinbaseDaily(fromMs, toMs);
    if (prices.size > 10) {
      console.error(`[BTC data] Coinbase: ${prices.size} daily closes`);
      return prices;
    }
  } catch (e: any) {
    console.error(`[BTC data] Coinbase failed: ${e.message}`);
  }

  try {
    const prices = await fetchBinanceDaily(fromMs, toMs);
    console.error(`[BTC data] Binance: ${prices.size} daily closes`);
    return prices;
  } catch (e: any) {
    console.error(`[BTC data] Binance also failed: ${e.message}`);
  }

  return new Map();
}

/**
 * Get the closest available price on or before a given date.
 */
export function getPriceOnDate(
  priceMap: Map<string, number>,
  targetDate: string
): number | null {
  // Try exact match first
  if (priceMap.has(targetDate)) return priceMap.get(targetDate)!;
  // Walk back up to 3 days for weekends / holidays
  for (let offset = 1; offset <= 3; offset++) {
    const d = new Date(targetDate);
    d.setDate(d.getDate() - offset);
    const prev = d.toISOString().slice(0, 10);
    if (priceMap.has(prev)) return priceMap.get(prev)!;
  }
  return null;
}

/**
 * Build an ordered array of daily closes for a date range (for realized vol calc).
 */
export function buildCloseSeries(
  priceMap: Map<string, number>,
  fromDate: string,
  toDate: string
): Array<{ date: string; price: number }> {
  const result: Array<{ date: string; price: number }> = [];
  const fromMs = new Date(fromDate).getTime();
  const toMs = new Date(toDate).getTime();
  let cursor = fromMs;
  while (cursor <= toMs) {
    const dateStr = new Date(cursor).toISOString().slice(0, 10);
    if (priceMap.has(dateStr)) {
      result.push({ date: dateStr, price: priceMap.get(dateStr)! });
    }
    cursor += DAY_MS;
  }
  return result;
}
