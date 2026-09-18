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
  | "kalshi_book_empty"
  | "kalshi_book_too_thin"
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

/**
 * The same-venue route: buy No contracts on the very market being protected.
 * A No contract pays exactly $1 in the NO state — same instrument, same
 * settlement, zero basis. Depth comes from the market's live yes bids
 * (buying No crosses them at 100c minus the bid).
 */
export interface KalshiSelfHedgeLeg {
  action: "buy";
  venue: "kalshi";
  outcome: "No";
  ticker: string;
  contractsMilli: number; // 1000 = 1 contract, rounded UP (never under-hedged)
  avgPriceCents: number; // walked average, rounded up
  worstPriceCents: number;
  costCents: number; // rounded up
}

export type HedgeLeg = CrossHedgeLeg | KalshiSelfHedgeLeg;

/** Which hedge route funded the quote. */
export type HedgeRoute = "polymarket" | "kalshi_self";

/** One route's outcome in a dual-route scan: quotable (with its true EV cost) or an honest refusal. */
export interface RouteCheck {
  route: HedgeRoute;
  ok: boolean;
  /** cost of the protection in EV bps when quotable, null when refused */
  evCostBps: number | null;
  creditCents: number | null;
  detail?: string;
}

/**
 * Protection tiers. In a credit collar the floor and the cap are tied: a
 * higher floor needs more hedge, which only a lower cap can fund. So the
 * fundable collars line up along one axis and the tiers are three named
 * points on it, each with a stated selection rule:
 *   - tight:    most protection — the highest fundable floor, largest credit
 *               at it (today's rule; the shadow baseline)
 *   - wide:     most upside — the lowest floor offered, highest fundable cap
 *   - balanced: the middle — the floor nearest halfway between the two,
 *               priced at its lowest true cost
 * Tiers that resolve to the same collar collapse; the holder never sees two
 * chips with identical terms.
 */
export type ProtectionTier = "tight" | "balanced" | "wide";
export const PROTECTION_TIERS: readonly ProtectionTier[] = ["tight", "balanced", "wide"] as const;

/** Which component of the fee rule set the published take. */
export type TakeRule = "share" | "minimum" | "waived";

/** One priced collar: the terms the holder locks plus the leg that backs them. */
export interface CollarTerms {
  floorCents: number;
  capCents: number;
  creditCents: number;
  grossCreditCents: number;
  /** the published take actually charged (0 when waived) */
  takeCents: number;
  /** what the share-of-credit component alone would charge */
  takeShareCents: number;
  /** what the minimum-fee-on-notional component alone would charge */
  takeMinimumCents: number;
  takeRule: TakeRule;
  takeWaived: boolean;
  hedge: HedgeLeg;
  feesCents: number;
  /** true cost of this protection at the market's own odds, bps of naked EV */
  evCostBps: number;
}

export interface CrossQuote extends CollarTerms {
  ok: true;
  kalshiTicker: string;
  pmEventSlug: string;
  contracts: number;
  markCents: number;
  entryCents: number;
  takeBps: number;
  /** the fee rule's notional minimum, bps of stake (100c x contracts) */
  minTakeBpsOfStake: number;
  /** which tier the top-level terms are; the others sit in `tiers` */
  tier: ProtectionTier;
  /** every distinct tier the venues funded, each with its own selection rule */
  tiers: Partial<Record<ProtectionTier, CollarTerms>>;
  /** how many fundable (floor, cap) collars the search saw before choosing */
  candidatesConsidered: number;
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
  /** the writer's share of the gross credit, bps */
  takeBps: number;
  /**
   * The writer's minimum fee, bps of stake (100c x contracts). The take is
   * max(share, minimum); a fee on notional pays for balance sheet and
   * execution even when the venues barely disagree. 0 disables it.
   */
  minTakeBpsOfStake: number;
  deMinimisTakeCents: number;
  /** venue fee on hedge notional, bps (Polymarket taker fee is 0 today) */
  hedgeFeeBps: number;
  /** flat per-quote fee buffer, cents */
  hedgeFeeFlatCents: number;
  /** the tier whose terms become the top-level quote (the others ride along) */
  defaultTier: ProtectionTier;
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
  minTakeBpsOfStake: 25,
  deMinimisTakeCents: 5,
  hedgeFeeBps: 0,
  hedgeFeeFlatCents: 0,
  defaultTier: "balanced",
};
