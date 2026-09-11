/**
 * CROSS-VENUE EVENT COLLAR (Tier 2) — isolated module tree for the demo of
 * protection on one prediction venue hedged with the SAME event listed on
 * another venue.
 *
 * HARD ISOLATION RULE (inherited): nothing under src/eventCollar/** may import
 * from src/singleSide/** or any other production module. This tree ships as
 * its own service (eventProtectXDemoService) and must never touch the Earn &
 * Protect runtime, its stores, or its deploy.
 *
 * Money units: Kalshi quotes integer cents. Polymarket quotes decimal-string
 * prices (tick 0.01 or 0.001) and fractional share sizes; both are parsed
 * EXACTLY to integer milli units (1000 = $1 / 1 share) so no float enters the
 * credit identity. Cross products land in micro dollars (priceMilli *
 * sizeMilli), converted once to cents rounded AGAINST the holder's credit.
 */

import type { KalshiMarket } from "../types";

/** One Polymarket market normalized from the Gamma API. */
export interface PmMarket {
  eventSlug: string;
  eventTitle: string;
  question: string;
  conditionId: string;
  /** outcome display names, order as listed (sports: [away, home]) */
  outcomes: string[];
  /** CLOB token ids, index-aligned with outcomes */
  tokenIds: string[];
  /** last mid prices per outcome, milli units (1000 = $1), -1 when absent */
  outcomePricesMilli: number[];
  gameStartTime: string | null; // ISO
  endDate: string | null; // ISO
  sportsMarketType: string; // "moneyline" for winner markets
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  negRisk: boolean;
  orderMinSizeShares: number;
  liquidityUsd: number;
  volumeUsd: number;
}

/** One CLOB book level in exact integer milli units. */
export interface PmBookLevel {
  priceMilli: number; // 1000 = $1.000
  sizeMilli: number; // 1000 = 1 share
}

/** One side of a CLOB book, sorted best-first (asks ascending by price). */
export interface PmBook {
  tokenId: string;
  asks: PmBookLevel[];
  bids: PmBookLevel[];
  minOrderSizeShares: number;
  tickMilli: number;
}

/** A Kalshi market paired with the identical event on Polymarket. */
export interface MatchedPair {
  league: string; // whitelist template key, e.g. "mlb"
  kalshi: KalshiMarket;
  pm: PmMarket;
  /** index into pm.outcomes/tokenIds equivalent to the Kalshi YES side */
  pmYesOutcomeIndex: number;
  /** index of the opposing outcome (the hedge instrument: pays $1 when Kalshi resolves No) */
  pmNoOutcomeIndex: number;
  gameStartTime: string; // ISO, canonical (Polymarket's gameStartTime)
  /** resolution parity note from the whitelist template (shown to the holder) */
  parityNote: string;
  fingerprint: string; // league:away:home:date
}

export type CrossRefusalCode =
  | "no_matched_market"
  | "resolution_mismatch"
  | "market_too_close_to_start"
  | "mark_out_of_range"
  | "pm_book_empty"
  | "pm_book_too_thin"
  | "credit_nonpositive";

export interface CrossRefusal {
  ok: false;
  code: CrossRefusalCode;
  detail: string;
  bestShortfallCents?: number;
}

export interface CrossHedgeLeg {
  action: "buy";
  venue: "polymarket";
  outcome: string; // display name of the opposing outcome
  tokenId: string;
  sharesMilli: number; // 1000 = 1 share, rounded UP (never under-hedged)
  avgPriceMilli: number; // walked average, 1000 = $1
  worstPriceMilli: number;
  costCents: number; // rounded up
}

export interface CrossQuote {
  ok: true;
  kalshiTicker: string;
  pmEventSlug: string;
  contracts: number;
  markCents: number;
  entryCents: number;
  floorCents: number;
  capCents: number;
  creditCents: number;
  grossCreditCents: number;
  takeCents: number;
  takeBps: number;
  takeWaived: boolean;
  hedge: CrossHedgeLeg;
  feesCents: number;
  parityNote: string;
  quotedAt: string;
}

export type CrossQuoteResult = CrossQuote | CrossRefusal;

export interface CrossSearchConfig {
  floorOffsetsCents: number[];
  capOffsetsCents: number[];
  maxCapCents: number;
  minFloorCents: number;
  minCapHeadroomCents: number;
  /** quote only pre-game: refuse when start is nearer than this (minutes) */
  minMinutesToStart: number;
  markLowerBoundCents: number;
  markUpperBoundCents: number;
  takeBps: number;
  deMinimisTakeCents: number;
  /** venue fee on hedge notional, bps (Polymarket taker fee is 0 today) */
  hedgeFeeBps: number;
  /** flat per-quote fee buffer, cents */
  hedgeFeeFlatCents: number;
}

export const DEFAULT_CROSS_CONFIG: CrossSearchConfig = {
  floorOffsetsCents: [3, 5, 8, 10, 12, 15, 20, 25, 30],
  capOffsetsCents: [3, 4, 5, 6, 8, 10, 12, 15, 20, 25],
  maxCapCents: 97,
  minFloorCents: 5,
  minCapHeadroomCents: 3,
  minMinutesToStart: 10,
  markLowerBoundCents: 10,
  markUpperBoundCents: 92,
  takeBps: 1000,
  deMinimisTakeCents: 5,
  hedgeFeeBps: 0,
  hedgeFeeFlatCents: 0,
};
