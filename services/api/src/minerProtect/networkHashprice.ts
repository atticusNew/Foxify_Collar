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

const defaultFetcher: TextFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`difficulty_http_${res.status}`);
  return res.text();
};

/** Public difficulty source (plain number). blockchain.info is unauthenticated + CORS-free. */
export const DIFFICULTY_URL = "https://blockchain.info/q/getdifficulty";

/**
 * Difficulty-based provider matching the HashpriceProvider shape. Reads current difficulty and
 * converts to BTC/TH/day. `subsidyPlusFeesBtc` defaults to the current subsidy (fees ≈ 0, conservative).
 */
export const difficultyHashpriceProvider = (
  opts?: { subsidyPlusFeesBtc?: number; fetcher?: TextFetcher; url?: string }
): { getBtcPerThPerDay: () => Promise<number | null> } => ({
  getBtcPerThPerDay: async () => {
    const fetcher = opts?.fetcher ?? defaultFetcher;
    const subsidyPlusFees = opts?.subsidyPlusFeesBtc && opts.subsidyPlusFeesBtc > 0 ? opts.subsidyPlusFeesBtc : DEFAULT_BLOCK_SUBSIDY_BTC;
    try {
      const txt = await fetcher(opts?.url ?? DIFFICULTY_URL);
      const difficulty = Number(String(txt).trim());
      return btcPerThPerDayFromDifficulty(difficulty, subsidyPlusFees);
    } catch {
      return null;
    }
  }
});
