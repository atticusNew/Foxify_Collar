/**
 * What a taker pays each venue, as each venue publishes it. Read on 12 and 13 November 2026;
 * the page prints the source beside every figure. A venue can change a rate, and two of the
 * three set rates per market or per account, so these are the standard published rates and
 * not a reading of our own account.
 *
 *   Polymarket International   shares × 0.05 × p × (1 − p) on sports, taker only, at the trade
 *                              (docs.polymarket.com/trading/fees; 0.03 before 10 July 2026)
 *   Limitless                  5% × (1 − p) of the trade's dollar value on its current trading
 *                              venues, buys and exits alike, taker only: the same shares ×
 *                              0.05 × p × (1 − p). Markets made before the switch keep an older
 *                              curve (docs.limitless.exchange/user-guide/fees)
 *   SX Bet                     nothing at the trade. 1% of the profit of a winning taker bet, at
 *                              settlement; 5% on a parlay; rates are set per account
 *                              (docs.sx.bet/developers/fees)
 *
 * A fee on winnings is counted in full as if the bet wins, which is the most it can be, so a
 * figure here holds whichever side wins. (The same arithmetic as the regulated lane's sports
 * page, written out here so this lane shares no file with it.)
 */

import type { Venue } from "./types";

export interface FeeTerms {
  /** the taker fee is theta × p × (1 − p) a share, at the trade */
  theta: number;
  /** a share of the profit of a winning bet, at settlement */
  gain?: number;
}

const curveFeeCents = (theta: number, cents: number): number => theta * (cents / 100) * (1 - cents / 100) * 100;
/** Everything a taker pays over the ask to buy at `cents`: the trade fee, and the settlement fee on the profit (100 − cents) if it wins. */
export const buyFeeCents = (fee: FeeTerms, cents: number): number => curveFeeCents(fee.theta, cents) + (fee.gain ? fee.gain * (100 - cents) : 0);
/**
 * Everything a taker gives up under the bid when leaving at `cents`. Where the fee is on
 * winnings, leaving is a bet on the other outcome at 100 − cents, whose profit if it wins is
 * `cents`.
 */
export const sellFeeCents = (fee: FeeTerms, cents: number): number => curveFeeCents(fee.theta, cents) + (fee.gain ? fee.gain * cents : 0);

export const FEES: Record<Venue, FeeTerms> = {
  polymarket: { theta: 0.05 },
  limitless: { theta: 0.05 },
  sx_bet: { theta: 0, gain: 0.01 },
};

export const FEE_WORDS: Record<Venue, string> = {
  polymarket: "0.05 × p × (1 − p) a share, at the trade",
  limitless: "0.05 × p × (1 − p) a share, at the trade",
  sx_bet: "1% of the profit of a winning bet, at settlement",
};

/** What buying at `price` costs with the fee in, cents per $1 share. */
export const allInAskCents = (venue: Venue, price: number): number => price * 100 + buyFeeCents(FEES[venue], price * 100);
/** What leaving at `price` pays with the fee out, cents per $1 share. */
export const allInBidCents = (venue: Venue, price: number): number => price * 100 - sellFeeCents(FEES[venue], price * 100);
