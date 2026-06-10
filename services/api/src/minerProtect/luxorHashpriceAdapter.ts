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

/** Deterministic mock for tests / offline (and as the body-supplied override). */
export const mockHashpriceProvider = (btcPerThPerDay: number): HashpriceProvider => ({
  getBtcPerThPerDay: async () => (btcPerThPerDay > 0 ? btcPerThPerDay : null)
});

/**
 * Live Luxor provider (stub). Wire the Luxor Hashprice Index API here when `LUXOR_API_KEY` is set;
 * convert the published hashprice/difficulty to BTC/TH/day. Returns null without a key so callers
 * fall back to a request-supplied `btc_per_th_per_day`.
 */
export const luxorHashpriceProvider = (apiKey?: string): HashpriceProvider => ({
  getBtcPerThPerDay: async () => {
    if (!apiKey) return null;
    // TODO(miner-protect PR3): GET Luxor Hashprice Index → derive BTC/TH/day. Region/rate-limit aware.
    return null;
  }
});
