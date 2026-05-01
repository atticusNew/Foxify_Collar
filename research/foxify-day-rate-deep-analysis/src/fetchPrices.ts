/** Coinbase BTC daily OHLC fetcher. Public API only. No Foxify deps. */

const COINBASE_BASE = "https://api.exchange.coinbase.com";
const DAY_MS = 86_400_000;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export type DailyOhlc = { date: string; close: number; high: number; low: number; open: number };

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

export async function fetchBtcDailyOhlc(fromDate: string, toDate: string): Promise<DailyOhlc[]> {
  const fromMs = new Date(fromDate).getTime();
  const toMs = new Date(toDate).getTime() + DAY_MS;
  const result = new Map<string, DailyOhlc>();
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
      for (const [ts, low, high, open, close] of candles) {
        const date = new Date(ts * 1000).toISOString().slice(0, 10);
        if (!result.has(date)) result.set(date, { date, close, high, low, open });
      }
    } catch { /* skip window */ }
    cursor = windowEnd;
    await sleep(300);
  }
  const sorted = [...result.values()].sort((a, b) => a.date.localeCompare(b.date));
  console.error(`[BTC] fetched ${sorted.length} daily bars (${sorted[0]?.date} → ${sorted.at(-1)?.date})`);
  return sorted;
}
