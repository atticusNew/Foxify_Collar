/**
 * Lock in as a holder's own sale on one venue's book, in whole numbers.
 *
 * A holder of N contracts that each pay $1 sells k of them at the bid. The cash, after the
 * venue's fee on the sale, is theirs whatever happens: the floor. The cap is that cash plus $1
 * on each of the N - k still held. Nobody else is in it: no counterparty of ours, no hedge.
 *
 * Two ways to pick k:
 *   a tier        the three sizes the product offers (eventCollar/crossVenue/memberSale.ts):
 *                 Max upside sells 40% of the position, Balanced 60%, Max floor 80%.
 *   stake back    the fewest contracts whose cash covers everything the position cost, the fee
 *                 paid to open it included. What is left rides at no cost.
 *
 * Units, all integers:
 *   quantity   hundredths of a contract (Crypto.com's exchange trades to 0.01 of a contract)
 *   price      hundredths of a cent per contract
 *   money      micro-dollars: a hundredth of a contract times a hundredth of a cent
 * A fee that does not land on a hundredth of a cent goes against the holder: up.
 */

import { buyFeeCents, sellFeeCents, type FeeTerms } from "./analytics";

/** hundredths of a cent in $1: what one hundredth of a contract pays, in micro-dollars */
export const PAYOUT = 10_000;
export const MICRO_PER_DOLLAR = 1_000_000;
export const MICRO_PER_CENT = 10_000;

export type Tier = "wide" | "balanced" | "tight";
export const TIERS: readonly Tier[] = ["wide", "balanced", "tight"];
/** the share of the position each tier sells, whole percent: the product's own (memberSale.SALE_SHARE_PERCENT) */
export const TIER_SHARE: Record<Tier, number> = { wide: 40, balanced: 60, tight: 80 };
export const TIER_NAME: Record<Tier, string> = { wide: "Max upside", balanced: "Balanced", tight: "Max floor" };

/** Contracts as the venue writes them ("55.57") in hundredths of a contract; 0 when unreadable. */
export const quantityOf = (contracts: number | string): number => {
  const n = Math.round(Number(contracts) * 100);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
/** A price in cents in hundredths of a cent. */
export const priceOf = (cents: number): number => Math.round(cents * 100);
/** A price as the venue writes it, dollars ("0.34"), in hundredths of a cent; 0 when unreadable. */
export const priceOfDollars = (dollars: number | string): number => {
  const n = Math.round(Number(dollars) * 10_000);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const up = (x: number): number => Math.ceil(x - 1e-7);
/** The venue's fee to buy one contract at `price`, hundredths of a cent, up. */
export const buyFee = (fee: FeeTerms, price: number): number => up(buyFeeCents(fee, price / 100) * 100);
/** The venue's fee to sell one contract at `price`, hundredths of a cent, up. */
export const sellFee = (fee: FeeTerms, price: number): number => up(sellFeeCents(fee, price / 100) * 100);
/** What one contract sold at `bid` leaves after the fee, hundredths of a cent; 0 or less when the fee eats the bid. */
export const netBid = (fee: FeeTerms, bid: number): number => bid - sellFee(fee, bid);

export interface Position {
  /** hundredths of a contract */
  qty: number;
  /** what was paid per contract, hundredths of a cent, before the fee */
  price: number;
}

/** Everything the position cost: the price and the fee to open it, micro-dollars. */
export const stakeOf = (pos: Position, fee: FeeTerms): number => pos.qty * (pos.price + buyFee(fee, pos.price));
/** What the position pays if its side wins, micro-dollars. */
export const fullWinOf = (pos: Position): number => pos.qty * PAYOUT;

/** How much a tier sells: its share of the position, down, and never nothing. */
export function tierSold(qty: number, tier: Tier): number {
  return qty >= 1 ? Math.max(1, Math.floor((qty * TIER_SHARE[tier]) / 100)) : 0;
}

/** The fewest hundredths of a contract whose sale at `net` each covers the stake; null when the whole position does not. */
export function stakeBackSold(pos: Position, net: number, fee: FeeTerms): number | null {
  if (!(net > 0) || pos.qty < 1) return null;
  const k = Math.ceil(stakeOf(pos, fee) / net);
  return k <= pos.qty ? k : null;
}

/**
 * The lowest bid after the fee at which the stake comes back by selling no more than
 * `maxSharePercent` of the position. Null when that share is less than the venue's smallest size.
 */
export function stakeBackNet(pos: Position, fee: FeeTerms, maxSharePercent: number): number | null {
  const most = Math.floor((pos.qty * maxSharePercent) / 100);
  return most >= 1 ? Math.ceil(stakeOf(pos, fee) / most) : null;
}

/** The lowest bid after the fee at which the tier's sale returns `backPercent` of the stake or more. */
export function tierBackNet(pos: Position, fee: FeeTerms, tier: Tier, backPercent: number): number | null {
  const k = tierSold(pos.qty, tier);
  return k >= 1 ? Math.ceil((stakeOf(pos, fee) * backPercent) / (100 * k)) : null;
}

export interface LockTerms {
  /** hundredths of a contract sold and kept */
  sold: number;
  kept: number;
  /** the bid and what it leaves after the fee, hundredths of a cent */
  bid: number;
  net: number;
  /** the sale's cash after the fee: the floor, micro-dollars */
  cash: number;
  /** the fee on the sale, micro-dollars */
  fee: number;
  /** the cash plus $1 on each contract kept, micro-dollars */
  cap: number;
  stake: number;
  fullWin: number;
}

/** The terms of selling `sold` of the position at `bid`. Null when there is nothing to sell or the fee eats the bid. */
export function lockTerms(pos: Position, sold: number, bid: number, fee: FeeTerms): LockTerms | null {
  const net = netBid(fee, bid);
  if (!(sold >= 1) || sold > pos.qty || !(net > 0)) return null;
  const cash = sold * net;
  const kept = pos.qty - sold;
  return { sold, kept, bid, net, cash, fee: sold * (bid - net), cap: cash + kept * PAYOUT, stake: stakeOf(pos, fee), fullWin: fullWinOf(pos) };
}

/** Micro-dollars as whole cents, the remainder going the way `round` says: a holder's cash down, a cost up. */
export const centsOf = (micro: number, round: "down" | "up"): number => (round === "down" ? Math.floor(micro / MICRO_PER_CENT + 1e-9) : Math.ceil(micro / MICRO_PER_CENT - 1e-9));
