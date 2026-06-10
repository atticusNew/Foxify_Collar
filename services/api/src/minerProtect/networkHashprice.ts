/**
 * Network-difficulty hashprice provider — FREE, public, no entitlement (default source for
 * `btcPerThPerDay`). Luxor's Hashprice Index is an optional premium source; this derives the same
 * quantity from on-chain difficulty so Miner Protect works without any paid API.
 *
 * A miner with H hashes/s finds H / (difficulty × 2^32) blocks per second. For 1 TH/s = 1e12 H/s:
 *   blocks/TH/day = 1e12 × 86400 / (difficulty × 2^32)
 *   BTC/TH/day    = blocks/TH/day × (block subsidy + avg fees per block)
 */

const HASHES_PER_DIFFICULTY = 2 ** 32; // 4,294,967,296
const SECONDS_PER_DAY = 86_400;
const HASHES_PER_TH = 1e12;

/** Current block subsidy (BTC). 3.125 after the Apr-2024 halving (until ~2028). Env-overridable. */
export const DEFAULT_BLOCK_SUBSIDY_BTC = 3.125;

/** Pure: BTC mined per TH/s per day from network difficulty + (subsidy + avg fees) per block. */
export const btcPerThPerDayFromDifficulty = (difficulty: number, subsidyPlusFeesBtc: number): number | null => {
  if (!(difficulty > 0) || !(subsidyPlusFeesBtc > 0)) return null;
  const blocksPerThPerDay = (HASHES_PER_TH * SECONDS_PER_DAY) / (difficulty * HASHES_PER_DIFFICULTY);
  const v = blocksPerThPerDay * subsidyPlusFeesBtc;
  return Number.isFinite(v) && v > 0 ? v : null;
};

export type TextFetcher = (url: string) => Promise<string>;
export type JsonFetcher = (url: string) => Promise<unknown>;

const defaultFetcher: TextFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`difficulty_http_${res.status}`);
  return res.text();
};
const defaultJsonFetcher: JsonFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`fees_http_${res.status}`);
  return res.json();
};

/** Public difficulty source (plain number). blockchain.info is unauthenticated + CORS-free. */
export const DIFFICULTY_URL = "https://blockchain.info/q/getdifficulty";
/** Avg block reward+fee stats over the last 144 blocks (mempool.space; totals in sats). */
export const REWARD_STATS_URL = "https://mempool.space/api/v1/mining/reward-stats/144";

/** Average transaction fees per block (BTC) over the recent window. null on failure. */
export const fetchAvgFeesPerBlockBtc = async (fetcher: JsonFetcher = defaultJsonFetcher): Promise<number | null> => {
  try {
    const j = await fetcher(REWARD_STATS_URL) as { totalFee?: unknown } | null;
    const totalFeeSats = Number(j?.totalFee); // sats across 144 blocks
    if (!Number.isFinite(totalFeeSats) || totalFeeSats <= 0) return null;
    return (totalFeeSats / 144) / 1e8;
  } catch {
    return null;
  }
};

/**
 * Difficulty-based provider matching the HashpriceProvider shape: reads current difficulty + the
 * recent average block fees, and converts (subsidy + fees) to BTC/TH/day. Pass `subsidyPlusFeesBtc`
 * to bypass fee fetching entirely; otherwise fees are fetched (fallback 0 = conservative, subsidy-only).
 */
export const difficultyHashpriceProvider = (
  opts?: { subsidyPlusFeesBtc?: number; subsidyBtc?: number; avgFeesPerBlockBtc?: number; fetcher?: TextFetcher; feeFetcher?: JsonFetcher; url?: string }
): { getBtcPerThPerDay: () => Promise<number | null> } => ({
  getBtcPerThPerDay: async () => {
    const fetcher = opts?.fetcher ?? defaultFetcher;
    try {
      const txt = await fetcher(opts?.url ?? DIFFICULTY_URL);
      const difficulty = Number(String(txt).trim());
      let total = opts?.subsidyPlusFeesBtc;
      if (total == null || !(total > 0)) {
        const subsidy = opts?.subsidyBtc && opts.subsidyBtc > 0 ? opts.subsidyBtc : DEFAULT_BLOCK_SUBSIDY_BTC;
        let fees = opts?.avgFeesPerBlockBtc;
        if (fees == null) fees = (await fetchAvgFeesPerBlockBtc(opts?.feeFetcher)) ?? 0;
        total = subsidy + Math.max(0, fees);
      }
      return btcPerThPerDayFromDifficulty(difficulty, total);
    } catch {
      return null;
    }
  }
});
