/**
 * EVENT COLLAR — isolated module tree for the Kalshi crypto-price-event demo.
 *
 * HARD ISOLATION RULE: nothing in services/api/src/eventCollar/ may import from
 * services/api/src/singleSide/** or any other production module. This tree ships
 * as its own service (eventProtectDemoService) and must never touch the Earn &
 * Protect runtime, its stores, or its deploy.
 *
 * All money values are integer cents (Kalshi quotes in whole cents; USD amounts
 * derived from OKX BTC-denominated premia are converted once, rounded against
 * the holder's credit — never in its favor). Probabilities are integer micro
 * units (1e6 = certainty) so no float accumulates through the quote math.
 */

/** One Kalshi binary market (a strike inside an hourly/daily event). */
export interface KalshiMarket {
  ticker: string;
  eventTicker: string;
  title: string;
  subtitle: string;
  /** Resolves YES when the BRTI fixing is strictly above this level. */
  strike: number;
  strikeType: "greater" | "less" | string;
  status: string;
  openTime: string;
  closeTime: string;
  yesBidCents: number;
  yesAskCents: number;
  lastPriceCents: number;
  volume: number;
  openInterest: number;
  rulesPrimary: string;
}

/** A public Kalshi trade print (used for honest showcase entry prices). */
export interface KalshiTrade {
  tradeId: string;
  ticker: string;
  priceCents: number; // yes price
  count: number;
  createdTime: string;
}

/** One OKX option instrument (BTC-USD inverse options, 0.01 BTC per contract). */
export interface OkxOptionInstrument {
  instId: string; // e.g. BTC-USD-260911-76750-P
  expiry: string; // YYMMDD
  strike: number;
  optType: "C" | "P";
  /** contract multiplier in BTC (0.01 for BTC-USD options) */
  ctMultBtc: number;
}

/** Order book for one instrument. Premia are strings in BTC per 1 BTC notional. */
export interface OkxBookLevel {
  priceBtc: number;
  sizeContracts: number;
}

export interface OkxOptionBook {
  instId: string;
  asks: OkxBookLevel[];
  bids: OkxBookLevel[];
  ts: number;
}

/** Inputs the pricer needs for one leg of the digital-put replication. */
export interface VerticalLegBooks {
  /** put struck at the higher strike (bought) */
  highPut: OkxOptionBook;
  highStrike: number;
  /** put struck at the lower strike (sold) */
  lowPut: OkxOptionBook;
  lowStrike: number;
}

export type WrapRefusalCode =
  | "market_not_active"
  | "market_too_close_to_resolution"
  | "mark_out_of_range"
  | "no_bracketing_strikes"
  | "okx_book_empty"
  | "okx_book_too_thin"
  | "credit_nonpositive"
  | "no_matching_expiry";

export interface WrapRefusal {
  ok: false;
  code: WrapRefusalCode;
  detail: string;
  /** best shortfall observed, in cents per contract (for honest display) */
  bestShortfallCents?: number;
}

/** How the hedge tenor relates to the Kalshi resolution time. */
export type HedgeAlignment = "expiry_aligned" | "unwind_at_resolution";

export interface WrapLegPlan {
  action: "buy" | "sell";
  instId: string;
  contracts: number;
  /** executable premium for the full leg, USD cents (cost positive) */
  premiumCents: number;
  avgPriceBtc: number;
}

export interface WrapQuote {
  ok: true;
  marketTicker: string;
  contracts: number;
  markCents: number;
  entryCents: number;
  floorCents: number;
  capCents: number;
  /** net credit paid to the holder at resolution, USD cents, all-in */
  creditCents: number;
  /** gross credit sourced from the hedge before the published take */
  grossCreditCents: number;
  /** the published take actually charged (0 when de minimis) */
  takeCents: number;
  takeBps: number;
  takeWaived: boolean;
  /** executable digital-put price used, micro units (1e6 = certainty) */
  digitalPutMicro: number;
  /** number of OKX put verticals bought (rounded UP — never under-hedged) */
  spreads: number;
  verticalWidthUsd: number;
  hedgeExpiry: string;
  alignment: HedgeAlignment;
  legs: WrapLegPlan[];
  feesCents: number;
  quotedAt: string;
}

export type WrapQuoteResult = WrapQuote | WrapRefusal;

/** Terms of the wrap grid search. */
export interface WrapSearchConfig {
  /** candidate floors: mark minus each of these offsets (cents) */
  floorOffsetsCents: number[];
  /** candidate caps: mark plus each of these offsets (cents), clamped to maxCapCents */
  capOffsetsCents: number[];
  maxCapCents: number; // never cap above this (e.g. 97)
  minFloorCents: number; // never floor below this (e.g. 5)
  /** holder must keep at least this much room above mark (cents) */
  minCapHeadroomCents: number;
  /** refuse quotes when resolution is nearer than this (minutes) */
  minMinutesToResolution: number;
  markLowerBoundCents: number;
  markUpperBoundCents: number;
  takeBps: number;
  /** take waived when it would be under this (cents), published rule */
  deMinimisTakeCents: number;
  /** per-vertical (two legs) venue fee estimate, cents */
  feeCentsPerSpread: number;
  /** haircut applied to hedge cost when tenor is not expiry-aligned, bps */
  unalignedHaircutBps: number;
  /** hedge is expiry_aligned when |resolution - okx expiry| <= this (minutes) */
  alignmentToleranceMinutes: number;
}

export const DEFAULT_SEARCH_CONFIG: WrapSearchConfig = {
  floorOffsetsCents: [5, 8, 10, 12, 15, 20, 25, 30, 35],
  capOffsetsCents: [4, 5, 6, 8, 10, 12, 15, 20, 25, 30],
  maxCapCents: 97,
  minFloorCents: 5,
  minCapHeadroomCents: 4,
  minMinutesToResolution: 10,
  markLowerBoundCents: 10,
  markUpperBoundCents: 92,
  takeBps: 1000,
  deMinimisTakeCents: 5,
  feeCentsPerSpread: 50,
  unalignedHaircutBps: 500,
  alignmentToleranceMinutes: 30,
};

/** Settlement of a concluded (simulated) wrap. */
export interface WrapSettlement {
  outcome: "yes" | "no";
  /** per-contract payout with protection, cents */
  protectedPayoutCents: number;
  /** per-contract payout without protection, cents */
  nakedPayoutCents: number;
  creditCents: number;
  contracts: number;
  totalProtectedCents: number;
  totalNakedCents: number;
}
