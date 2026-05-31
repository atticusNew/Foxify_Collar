/**
 * Synthetic perp trade generator.
 *
 * Samples representative retail-perp-trader trades from realistic
 * distributions over notional, leverage, side, hold duration, asset,
 * and entry timing.
 *
 * Defaults are grounded in publicly observable retail-DEX-perp behavior
 * (GMX, dYdX, SynFutures public data, perp-trader leaderboards). They
 * are not Foxify pilot data — the generator is fully synthetic and the
 * distributions are documented per parameter.
 *
 * Reproducibility: deterministic with a seeded RNG so reruns produce
 * identical samples for the same seed.
 */

export type PerpAsset = "BTC" | "ETH";
export type PerpSide = "long" | "short";

export type SyntheticPerpTrade = {
  id: string;
  asset: PerpAsset;
  side: PerpSide;
  notionalUsd: number;
  leverage: number;        // 3..50
  marginUsd: number;       // = notional / leverage
  entryDate: string;       // YYYY-MM-DD (Coinbase available date)
  holdDays: number;        // 1..30
  // exitDate is computed at sim time (entryDate + holdDays)
};

// ─── Seeded RNG ──────────────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T>(rng: () => number, choices: { value: T; weight: number }[]): T {
  const total = choices.reduce((s, c) => s + c.weight, 0);
  let r = rng() * total;
  for (const c of choices) {
    if ((r -= c.weight) <= 0) return c.value;
  }
  return choices[choices.length - 1].value;
}

// ─── Distributions (documented, tunable) ─────────────────────────────────────

/**
 * Notional distribution. Skewed toward smaller positions (retail).
 * Source: GMX/dYdX leaderboard analysis showing median position size <$5k.
 */
const NOTIONAL_BUCKETS = [
  { value: 500,   weight: 20 },
  { value: 1000,  weight: 25 },
  { value: 2500,  weight: 20 },
  { value: 5000,  weight: 18 },
  { value: 10000, weight: 12 },
  { value: 25000, weight: 5 },
];

/**
 * Leverage distribution. Mode at 5-10x, fat tail to 50x.
 * Source: public perp-DEX leverage stats.
 */
const LEVERAGE_BUCKETS = [
  { value: 3,  weight: 15 },
  { value: 5,  weight: 25 },
  { value: 10, weight: 30 },
  { value: 20, weight: 20 },
  { value: 50, weight: 10 },
];

/**
 * Hold-duration buckets in days. Log-distributed mid-frequency.
 * Most retail closes within a few days.
 */
const HOLD_BUCKETS = [
  { value: 1,  weight: 30 },
  { value: 3,  weight: 30 },
  { value: 7,  weight: 20 },
  { value: 14, weight: 12 },
  { value: 30, weight: 8 },
];

/** Asset weighting. SynFutures product mix is approximately 70/30 BTC/ETH. */
const ASSET_BUCKETS: { value: PerpAsset; weight: number }[] = [
  { value: "BTC", weight: 70 },
  { value: "ETH", weight: 30 },
];

/** Slight long bias typical for retail. */
const SIDE_BUCKETS: { value: PerpSide; weight: number }[] = [
  { value: "long",  weight: 60 },
  { value: "short", weight: 40 },
];

// ─── Generator ───────────────────────────────────────────────────────────────

export function generateSyntheticTrades(opts: {
  count: number;
  seed: number;
  fromDate: string;       // earliest entry date
  toDate: string;         // latest entry date (so entry + holdDays fits in price data)
  availableDates: Set<string>;  // set of YYYY-MM-DD strings where price data exists
}): SyntheticPerpTrade[] {
  const rng = mulberry32(opts.seed);
  const dates = [...opts.availableDates].sort();
  const fromIdx = dates.findIndex(d => d >= opts.fromDate);
  const toIdx = dates.findIndex(d => d > opts.toDate) - 1;
  const validDates = dates.slice(fromIdx >= 0 ? fromIdx : 0, toIdx > 0 ? toIdx : dates.length);

  const out: SyntheticPerpTrade[] = [];
  for (let i = 0; i < opts.count; i++) {
    const asset = pickWeighted(rng, ASSET_BUCKETS);
    const side = pickWeighted(rng, SIDE_BUCKETS);
    const notionalUsd = pickWeighted(rng, NOTIONAL_BUCKETS);
    const leverage = pickWeighted(rng, LEVERAGE_BUCKETS);
    const holdDays = pickWeighted(rng, HOLD_BUCKETS);
    const entryDate = validDates[Math.floor(rng() * validDates.length)];
    const marginUsd = notionalUsd / leverage;
    out.push({
      id: `T${String(i + 1).padStart(4, "0")}`,
      asset, side, notionalUsd, leverage, marginUsd, entryDate, holdDays,
    });
  }
  return out;
}

/** Compute exit date = entryDate + holdDays (in calendar-day terms). */
export function computeExitDate(entryDate: string, holdDays: number): string {
  const d = new Date(entryDate);
  d.setDate(d.getDate() + holdDays);
  return d.toISOString().slice(0, 10);
}
