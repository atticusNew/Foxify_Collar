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

/** Luxor "Get Current Hashprice" (REST) base — hashunit=THS → priceBTC is BTC per TH/s per day. */
export const LUXOR_CURRENT_HASHPRICE_URL = "https://api.hashrateindex.com/v1/hashrateindex/hashprice/current?hashunit=THS";

/** Pure parse of Luxor's current-hashprice response → BTC/TH/day (priceBTC), or null. */
export const parseLuxorCurrentHashprice = (json: unknown): number | null => {
  const v = (json as { data?: { priceBTC?: unknown } } | null)?.data?.priceBTC;
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
      const json = await fetcher(opts?.url ?? LUXOR_CURRENT_HASHPRICE_URL, { headers: { "X-Hi-Api-Key": apiKey } });
      return parseLuxorCurrentHashprice(json);
    } catch {
      return null;
    }
  }
});
