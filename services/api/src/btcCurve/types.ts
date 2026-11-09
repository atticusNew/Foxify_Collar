/**
 * BTC CURVE REPORT — isolated module tree.
 *
 * Read-only comparison of the Bitcoin strike ladders listed on two CFTC-regulated
 * event venues (Kalshi, Polymarket US) against the distribution implied by the
 * listed option market (Deribit), with the settlement index (CF Benchmarks BRTI)
 * as the hedge reference. Nothing here can trade: only public market-data
 * endpoints are read, no credentials are loaded.
 *
 * HARD ISOLATION RULE: nothing in services/api/src/btcCurve/ may import from
 * services/api/src/singleSide/** or any other production module.
 *
 * Prices are integer cents of a $1 contract. Probabilities are decimals in
 * [0, 1] (the model side only; venue sides stay in cents).
 */

export type Venue = "kalshi" | "polymarket_us";

/** The question a bucket answers at settlement. */
export type BucketKind =
  /** settles YES when the index fixes inside [lower, upper] */
  | "range"
  /** settles YES when the index fixes at or above `level` */
  | "above"
  /** settles YES when the index fixes at or below `level` */
  | "below"
  /** settles YES when the index trades at or above `level` at any point before the window ends */
  | "touch_up"
  /** settles YES when the index trades at or below `level` at any point before the window ends */
  | "touch_down";

/**
 * One strike bucket, venue-neutral. `key` is the same on every venue listing the same
 * bucket so the ladders line up: `range:75000-79999.99`, `above:99999.99`, `touch_up:100000`.
 */
export interface Bucket {
  key: string;
  kind: BucketKind;
  lower?: number;
  upper?: number;
  level?: number;
  /** when the contract settles (ISO) */
  settlesAt: string;
}

/** One venue's top of book for one bucket. */
export interface VenueQuote {
  venue: Venue;
  bucketKey: string;
  /** the venue's own id for the contract */
  id: string;
  bidCents: number;
  askCents: number;
  /** contracts resting at the best bid / ask, 0 when the venue did not say */
  bidQty: number;
  askQty: number;
  volume: number;
  openInterest: number;
  /** taker fee coefficient Θ in `fee = Θ · C · p · (1 − p)`; 0 when the venue charges none here */
  feeTheta: number;
}

/** One ladder: a family of buckets that settle together, across venues. */
export interface Ladder {
  /** stable id, e.g. `btc-yearend-2026-range` */
  id: string;
  title: string;
  /** settlement instant shared by every bucket (ISO) */
  settlesAt: string;
  buckets: Bucket[];
  quotes: VenueQuote[];
  /** model probability per bucket key (decimal); absent when the model had no input */
  model: Record<string, ModelPoint>;
}

export interface ModelPoint {
  /** model probability the bucket settles YES */
  p: number;
  /** option expiry used for the smile (Deribit name, e.g. 25DEC26) */
  expiry: string;
  /** implied vol used at the bucket's level, decimal per year */
  iv: number;
}

/** One option summary row kept from the Deribit chain. */
export interface OptionRow {
  instrument: string;
  expiry: string;
  expiryMs: number;
  strike: number;
  type: "C" | "P";
  /** decimal per year */
  markIv: number;
  /** in BTC per 1 BTC notional */
  markPrice: number;
  bidPrice: number;
  askPrice: number;
  forward: number;
  openInterest: number;
}

/** What the collector writes every cycle. */
export interface Snapshot {
  at: string;
  /** BRTI (the settlement index of both venues), USD; falls back to the Deribit index */
  spotUsd: number;
  spotSource: "brti" | "deribit_index";
  ladders: Ladder[];
  /** Deribit chain subset the model used (two nearest expiries plus the year-end one) */
  options: OptionRow[];
  /** per-venue fetch health this cycle */
  health: Record<string, { ok: boolean; ms: number; detail?: string }>;
  /** the vol each side priced the hour at, this cycle (absent before Nov 9 2026 snapshots) */
  hourlyVol?: HourlyVolPoint;
}

/** One reading of the hourly ladder's implied vol against the listed and realised vol. */
export interface HourlyVolPoint {
  ladderId: string;
  minutesToClose: number;
  /** lognormal fit to the ladder's two-sided mids, % annualised; null when fewer than 4 strikes fit */
  ladderPct: number | null;
  ladderCentreUsd: number | null;
  rmsCents: number | null;
  /** Deribit mark IV at spot for the expiry nearest the close, % */
  smilePct: number | null;
  smileExpiry: string | null;
  /** BRTI realised over the last hour of one-minute returns, % annualised */
  realizedPct: number | null;
}

/** One 1-second BRTI candle (Polymarket US asset-price endpoint). */
export interface IndexCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
