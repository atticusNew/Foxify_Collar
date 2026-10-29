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
 *
 * Position size: contracts to the hundredth. Kalshi sells fractional contracts
 * (count_fp "15.95"), and a $7.69 payout on an exchange is 7.69 contracts of
 * $1, so a size is any multiple of 0.01 from 1.00 up. A per-contract figure in
 * cents times a size can land on a half cent; the helpers below say which way
 * each such product rounds, and every money line is built from them so the
 * record's identities hold to the cent.
 */

import type { KalshiMarket } from "../types";

/** A size snapped to the hundredth of a contract (float noise removed). */
export function roundContracts(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Exact hundredths of a contract (15.95 -> 1595); the integer the money helpers work in. */
export function contractHundredths(contracts: number): number {
  return Math.round(contracts * 100);
}

/** perContractCents x contracts, rounded half up to the cent: a payout line (floor paid, cap kept). */
export function centsOf(perContractCents: number, contracts: number): number {
  return Math.round((perContractCents * contractHundredths(contracts)) / 100);
}

/** ... rounded UP: a quantity that must never come up short (the hedge the writer must hold). */
export function centsUpOf(perContractCents: number, contracts: number): number {
  return Math.ceil((perContractCents * contractHundredths(contracts)) / 100);
}

/** ... rounded DOWN: a quantity the holder hands back (the funding the cap releases). */
export function centsDownOf(perContractCents: number, contracts: number): number {
  return Math.floor((perContractCents * contractHundredths(contracts)) / 100);
}

/** The holder's two settled outcomes under terms (floor, cap, credit) on a size: whole cents. */
export function floorTotalCents(t: { floorCents: number; contracts: number; creditCents: number }): number {
  return centsOf(t.floorCents, t.contracts) + t.creditCents;
}

/** Cap kept = the whole payout less the funding handed back, so handback + cap total = payout + credit exactly. */
export function capTotalCents(t: { capCents: number; contracts: number; creditCents: number }): number {
  return centsOf(100, t.contracts) - centsDownOf(100 - t.capCents, t.contracts) + t.creditCents;
}

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
  /** the venue's resolution text (ties, postponements, cancellations); absent on objects built before routing read it */
  description?: string;
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
  | "prophetx_book_empty"
  | "prophetx_book_too_thin"
  | "novig_book_empty"
  | "novig_book_too_thin"
  /** the venue is not offered as a hedge venue tonight (EVENT_HEDGE_VENUES leaves it out) */
  | "route_not_offered"
  | "credit_nonpositive"
  /** every route funded a collar, but the cheapest still costs more than the ceiling in EV terms */
  | "protection_too_rich"
  /** a collar was funded, but no tier's credit clears the minimum (25¢ and 0.25% of stake by default) */
  | "credit_too_small"
  /** the cross-venue route priced off a placeholder: days out, the market's own No side empty, no feed book (farOutGuard.ts) */
  | "far_out_no_book"
  /** a route priced, but no gate let it through (the venue closes before the lock, the executor cannot send there); the detail is the routing's reason (hedgeRouting.ts) */
  | "route_gated"
  /** the cross-venue route priced off a mark the hedge venue disagrees with: the market's own side a stub, or far from the implied price (markGapGuard.ts) */
  | "mark_disagreement";

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

/**
 * The ProphetX route: the opposing strike on ProphetX, read and sent through the aggregator's
 * pod. A strike names both the market and the side; a share of it pays $1 when that side wins.
 * Prices carry the venue's settlement fee folded in (prophetxOrders.ts), so `costCents` is all in.
 */
export interface ProphetXHedgeLeg {
  action: "buy";
  venue: "prophetx";
  outcome: string; // display name of the opposing outcome
  strikeId: string;
  /** the holder's own side's strike on the same market, when the mapping names it: what an early close buys to offset */
  offsetStrikeId?: string;
  sharesMilli: number; // 1000 = 1 share, rounded UP (never under-hedged)
  avgPriceMilli: number; // walked average with the fee folded, 1000 = $1
  worstPriceMilli: number;
  costCents: number; // rounded up
}

/**
 * The Novig route: the opposing outcome on Novig's own market, read from the venue's book and
 * sent with the service's trading key (novigOrders.ts). An order on Novig is always a buy of an
 * outcome; a contract pays 1 cent, so one of our $1 units is 100 of them. Prices carry the venue's
 * taker fee folded in when it applies (game markets charge only once live), so `costCents` is all in.
 */
export interface NovigHedgeLeg {
  action: "buy";
  venue: "novig";
  outcome: string; // display name of the opposing outcome
  marketId: string;
  /** the opposing outcome: what the hedge buys */
  outcomeId: string;
  /** the holder's own outcome on the same market: what an early close buys to offset (the venue takes no sell order) */
  offsetOutcomeId: string;
  sharesMilli: number; // 1000 = 1 share ($1 paying), rounded UP (never under-hedged)
  avgPriceMilli: number; // walked average with the fee folded, 1000 = $1
  worstPriceMilli: number;
  costCents: number; // rounded up
}

export type HedgeLeg = CrossHedgeLeg | KalshiSelfHedgeLeg | ProphetXHedgeLeg | NovigHedgeLeg;

/** Which hedge route funded the quote. */
export type HedgeRoute = "polymarket" | "kalshi_self" | "prophetx" | "novig";
export const HEDGE_ROUTES: readonly HedgeRoute[] = ["kalshi_self", "polymarket", "prophetx", "novig"];

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
 *   - balanced: the middle — the floor nearest halfway between the two, and
 *               the cap nearest halfway between the least and the most the
 *               venues fund at that floor
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
