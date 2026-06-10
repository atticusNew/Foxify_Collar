/**
 * Luxor Hashprice Index adapter — network-productivity data for Miner Protect (pluggable).
 *
 * v1 needs `btcPerThPerDay` (BTC mined per TH/s per day) to compute expected production + breakeven.
 * This is the network-mechanics (difficulty-driven) input; the Luxor Hashprice Index is the canonical
 * source. The provider is injected so the engine/route stay testable offline (mock) and the live
 * Luxor call drops in when an API key is configured.
 */

export type HashpriceProvider = {
  /** BTC mined per TH/s per day (network productivity). null when unavailable. */
  getBtcPerThPerDay: () => Promise<number | null>;
};

export type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<unknown>;

/** Deterministic mock for tests / offline (and as the body-supplied override). */
export const mockHashpriceProvider = (btcPerThPerDay: number): HashpriceProvider => ({
  getBtcPerThPerDay: async () => (btcPerThPerDay > 0 ? btcPerThPerDay : null)
});

/** Luxor "Get Hashprice" (REST). currency=BTC & hashunit=THS → price is BTC per TH/s per day.
 *  The `/hashprice/current` variant requires a higher tier (403 on some keys); the span endpoint is
 *  broadly available. We take the most recent point from the returned series. */
export const LUXOR_HASHPRICE_URL = "https://api.hashrateindex.com/v1/hashrateindex/hashprice?span=1D&bucket=1H&currency=BTC&hashunit=THS";

/**
 * Pure parse of Luxor's hashprice response → BTC/TH/day. Handles both shapes:
 *   - span series: { data: [{ price, timestamp }, ...] } → most recent positive price
 *   - current:     { data: { priceBTC } }
 */
export const parseLuxorHashprice = (json: unknown): number | null => {
  const data = (json as { data?: unknown } | null)?.data;
  if (Array.isArray(data)) {
    const points = data
      .map((d) => ({ price: Number((d as { price?: unknown })?.price), ts: Date.parse(String((d as { timestamp?: unknown })?.timestamp ?? "")) }))
      .filter((p) => Number.isFinite(p.price) && p.price > 0)
      .sort((a, b) => (Number.isFinite(b.ts) ? b.ts : 0) - (Number.isFinite(a.ts) ? a.ts : 0));
    return points.length ? points[0].price : null;
  }
  const v = (data as { priceBTC?: unknown } | null)?.priceBTC;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
};

const defaultFetcher: Fetcher = async (url, init) => {
  const res = await fetch(url, { headers: init?.headers, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`luxor_http_${res.status}`);
  return res.json();
};

/**
 * Live Luxor Hashprice Index provider. Calls the REST current-hashprice endpoint with `X-Hi-Api-Key`
 * and reads `data.priceBTC` at hashunit=THS (= BTC/TH/day). Returns null without a key or on any
 * failure, so callers fall back to a request-supplied `btc_per_th_per_day`. Read-only.
 */
export const luxorHashpriceProvider = (
  apiKey?: string,
  opts?: { fetcher?: Fetcher; url?: string }
): HashpriceProvider => ({
  getBtcPerThPerDay: async () => {
    if (!apiKey) return null;
    const fetcher = opts?.fetcher ?? defaultFetcher;
    try {
      const json = await fetcher(opts?.url ?? LUXOR_HASHPRICE_URL, { headers: { "X-Hi-Api-Key": apiKey } });
      return parseLuxorHashprice(json);
    } catch {
      return null;
    }
  }
});
