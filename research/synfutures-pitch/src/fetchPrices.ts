/**
 * BTC + ETH daily price fetcher with OHLC (for path-dependent drawdown sims).
 *
 * Coinbase public API only — no auth, no keys, no Foxify pilot dependencies.
 */

const COINBASE_BASE = "https://api.exchange.coinbase.com";
const DAY_MS = 86_400_000;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export type DailyOhlc = { close: number; high: number; low: number; open: number };

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

async function fetchCoinbaseDaily(product: string, fromMs: number, toMs: number): Promise<Map<string, DailyOhlc>> {
  const result = new Map<string, DailyOhlc>();
  let cursor = fromMs;
  while (cursor < toMs) {
    const windowEnd = Math.min(toMs, cursor + 300 * DAY_MS);
    const url = new URL(`/products/${product}/candles`, COINBASE_BASE);
    url.searchParams.set("granularity", "86400");
    url.searchParams.set("start", new Date(cursor).toISOString());
    url.searchParams.set("end", new Date(windowEnd).toISOString());
    try {
      const res = await fetchWithRetry(url.toString());
      const candles = await res.json() as number[][];
      // Coinbase candles: [time_seconds, low, high, open, close, volume]
      for (const [ts, low, high, open, close] of candles) {
        const dateStr = new Date(ts * 1000).toISOString().slice(0, 10);
        if (!result.has(dateStr)) result.set(dateStr, { close, high, low, open });
      }
    } catch { /* skip window */ }
    cursor = windowEnd;
    await sleep(300);
  }
  return result;
}

export async function fetchBtcDailyOhlc(fromDate: string, toDate: string): Promise<Map<string, DailyOhlc>> {
  const fromMs = new Date(fromDate).getTime();
  const toMs = new Date(toDate).getTime() + DAY_MS;
  const data = await fetchCoinbaseDaily("BTC-USD", fromMs, toMs);
  console.error(`[BTC] Coinbase: ${data.size} daily OHLC bars`);
  return data;
}

export async function fetchEthDailyOhlc(fromDate: string, toDate: string): Promise<Map<string, DailyOhlc>> {
  const fromMs = new Date(fromDate).getTime();
  const toMs = new Date(toDate).getTime() + DAY_MS;
  const data = await fetchCoinbaseDaily("ETH-USD", fromMs, toMs);
  console.error(`[ETH] Coinbase: ${data.size} daily OHLC bars`);
  return data;
}

export function getOhlcOnDate(map: Map<string, DailyOhlc>, dateStr: string): DailyOhlc | null {
  if (map.has(dateStr)) return map.get(dateStr)!;
  for (let off = 1; off <= 3; off++) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() - off);
    const prev = d.toISOString().slice(0, 10);
    if (map.has(prev)) return map.get(prev)!;
  }
  return null;
}

/** Build an ordered close-only series for rvol calculations. */
export function buildCloseSeries(map: Map<string, DailyOhlc>, fromDate: string, toDate: string): { date: string; price: number }[] {
  const fromMs = new Date(fromDate).getTime();
  const toMs = new Date(toDate).getTime();
  const result: { date: string; price: number }[] = [];
  let cursor = fromMs;
  while (cursor <= toMs) {
    const dateStr = new Date(cursor).toISOString().slice(0, 10);
    const o = map.get(dateStr);
    if (o) result.push({ date: dateStr, price: o.close });
    cursor += DAY_MS;
  }
  return result;
}

/**
 * For path-dependent drawdown sims: walk from openDate to closeDate and
 * return the worst-case adverse price excursion (max-high for shorts,
 * min-low for longs). Daily resolution; intra-day liquidations can still
 * occur but are bounded by daily high/low.
 */
export function pathExtremesInRange(
  map: Map<string, DailyOhlc>,
  fromDate: string,
  toDate: string,
): { minLow: number | null; maxHigh: number | null; days: number } {
  let minLow: number | null = null;
  let maxHigh: number | null = null;
  let days = 0;
  const fromMs = new Date(fromDate).getTime();
  const toMs = new Date(toDate).getTime();
  for (const [d, ohlc] of map.entries()) {
    const dMs = new Date(d).getTime();
    if (dMs >= fromMs && dMs <= toMs) {
      if (minLow === null || ohlc.low < minLow) minLow = ohlc.low;
      if (maxHigh === null || ohlc.high > maxHigh) maxHigh = ohlc.high;
      days++;
    }
  }
  return { minLow, maxHigh, days };
}
