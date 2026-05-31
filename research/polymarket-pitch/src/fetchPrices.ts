/** Coinbase BTC daily close fetcher. Public API only. */
const COINBASE_BASE = "https://api.exchange.coinbase.com";
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

export async function fetchBtcDailyCloses(fromDate: string, toDate: string): Promise<Map<string, number>> {
  const fromMs = new Date(fromDate).getTime();
  const toMs = new Date(toDate).getTime() + DAY_MS;
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
      for (const [ts, , , , close] of candles) {
        const d = new Date(ts * 1000).toISOString().slice(0, 10);
        if (!result.has(d)) result.set(d, close);
      }
    } catch { /* skip */ }
    cursor = windowEnd;
    await sleep(300);
  }
  console.error(`[BTC] ${result.size} daily closes`);
  return result;
}

export function getPriceOnDate(map: Map<string, number>, dateStr: string): number | null {
  if (map.has(dateStr)) return map.get(dateStr)!;
  for (let off = 1; off <= 3; off++) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() - off);
    const prev = d.toISOString().slice(0, 10);
    if (map.has(prev)) return map.get(prev)!;
  }
  return null;
}

export function buildCloseSeries(map: Map<string, number>, from: string, to: string): { date: string; price: number }[] {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const out: { date: string; price: number }[] = [];
  let c = fromMs;
  while (c <= toMs) {
    const d = new Date(c).toISOString().slice(0, 10);
    if (map.has(d)) out.push({ date: d, price: map.get(d)! });
    c += DAY_MS;
  }
  return out;
}
