/**
 * BETTER BID: the second settlement shape, as arithmetic. Nothing in this file sends an order,
 * reads a venue or holds a key; it prices books it is handed.
 *
 * A holder has N contracts of one side of a game on venue V and wants to lock in part of it by
 * selling k of them. Three shapes, in order of preference:
 *
 *   1. OWN SALE. The holder sells k contracts into V's bids with their own sell button. We hold
 *      nothing and fund nothing (memberSale.ts does this for a member's own account).
 *   2. BETTER BID (this file). Where another venue W offers the OTHER side cheaply enough, we rest
 *      a bid on V above the price the holder's sale would otherwise reach. The holder sells into
 *      it with the same sell button, and we buy the same number of the other side on W. One of
 *      our two contracts pays $1 whichever side wins.
 *   3. COLLAR. Only with a venue agreement. Not this file.
 *
 * WHO IS MAKER, WHO IS TAKER
 *   On V the holder is the TAKER (their sale hits resting bids, ours among them) and we are the
 *   MAKER (our bid rests until the holder hits it). On W we are the TAKER (we lift resting
 *   offers). Whenever we sell the first leg back into V's bids (the one-leg case, an early
 *   unwind) we are the TAKER on V.
 *
 * THE FEE SCHEDULES, AS THIS REPO'S CODE HAS THEM (nothing here is from memory)
 *   Kalshi         Taker: kalshiTakerFeeCents (kalshiLadder.ts), 7% x contracts x p x (1 - p),
 *                  rounded up to the cent on each fill. Maker: the repo has NO maker schedule.
 *                  kalshiOrders.ts reads `maker_fees` off a filled order, so the venue can charge
 *                  one. Our resting bid is therefore priced at the TAKER formula, which is never
 *                  under what the venue can take; if the venue charges less, the difference is
 *                  ours and settleBetterBid shows it when it is given the fee actually paid.
 *                  `restingBid: "free"` prices it at nothing, for an operator who has the venue's
 *                  maker schedule in hand. That is the founder's call, not this file's.
 *   Polymarket US  Taker: polyUsFeeMilli (polymarketUs.ts), coefficient x p x (1 - p) per share,
 *                  rounded up per share; the coefficient is the market's own, 0.095 at the first
 *                  tier (polyUsCoefficient). Maker: nothing; that file says the fee is on the taker.
 *   Novig          Taker: signedFeeMilli (venueBooks.ts), coefficient x p x (1 - p) per unit,
 *                  charged on a game market only once the game is live (signedFeeAppliesPreGame,
 *                  signedFeeAppliesLive; novigOrders.ts point 3). Maker: nothing in the code. The
 *                  venue has NO SELL (novigOrders.ts point 4), so it can be W and cannot be V.
 *   ProphetX       Nothing at the match; buyCostCents (prophetxOrders.ts) counts 2% of the net
 *                  gain (DEFAULT_PROPHETX_FEE_BPS), taken at settlement and so only if the
 *                  contract wins. NO SELL (prophetxOrders.ts point 3): W only.
 *   Polymarket     The international book behind the hedge route "polymarket":
 *                  hedgeNotionalFeeCents (crossVenuePricer.ts), the config's hedgeFeeBps and
 *                  hedgeFeeFlatCents on the notional, both 0 by default. The config has one
 *                  rate; it is applied to our resting bid and to a taker alike.
 *   STX            The fee is per account and not on the market (venueBooks.ts, outcome_v1), so
 *                  it cannot be priced here: refused. A member's own sale there is memberSale.ts.
 *   folded         A reference book whose reader already put the taker fee inside every price
 *                  (venueBooks.ts, polymarketUs.ts). W only; the fee cannot be shown apart.
 *
 * THE IDENTITY (cents; one contract pays 100)
 *   V's bids, best first: (p1, s1), (p2, s2), ...     W's offers for the other side: (a1, t1), ...
 *
 *   Own sale of k:      O = floor(sum of fills x price, walking down V's bids)
 *                           - V's taker fee on those fills
 *   Our bid at b:       it stands behind every order on V at b or better, so the holder's sale
 *                       fills those first and the rest, m = k - (size on V at b or better), hits us.
 *   Holder's cash:      H(b) = floor(fills at b or better x their prices + m x b)
 *                              - V's taker fee on those fills (ours is one more fill, at b)
 *   Our cost on V:      A(b) = ceil(m x b) + our fee on V as maker
 *   Our cost on W:      B(m) = ceil(m of the other side walked up W's offers) + W's taker fee
 *   Payout:             P = 100 x m. Our V contracts pay it if the holder's side wins, our W
 *                       contracts pay it if it loses. Never both, never neither (tails below).
 *   What we are left with, on either result:
 *                       L(b) = P - A(b) - B(m)
 *   Tail charge:        T = the router's expected shortfall per contract between V's rules and
 *                       W's (hedgeRouting.tailCharge) x m, rounded up. It is a reserve inside L,
 *                       not a payment to anyone. The router is asked about a writer whose floor
 *                       and cap are both 100 - q (q = what one W contract cost), which is where
 *                       we stand: we own the V contract outright and need V and W to pay 100
 *                       between them. Its shortfall in a branch is then max(0, 100 - what V pays
 *                       - what W pays); where V voids, the router counts the loss on the W leg.
 *   Gain to share:      G(b) = (H(b) - O) + (L(b) - T), the whole gain over the own sale.
 *   Our take:           computeTake(G, m) (collarSearch.ts): the share rounded down, the minimum
 *                       on stake rounded up, nothing below the de minimis line.
 *   The bid:            b* = the price on V's grid, under V's best offer (so the bid rests and
 *                       does not lift), that gives the holder the most cash while
 *                       L(b) - T >= take(b)   and   H(b) > O.
 *                       At b*:  L = take + T + residual, residual >= 0.
 *   The residual is what a resting bid could not pass on, for one of two reasons, and the quote
 *   says which (`bidLimitedBy`):
 *     our_take      V's grid. One step up in price is one step times m more for the holder, and
 *                   the next step would leave us short of the take.
 *     venue_offer   V's own offer. The bid already sits one step under it; a higher bid would
 *                   buy from V's sellers and not from the holder. This happens when the two
 *                   venues disagree by more than V's own spread, and the residual can be large.
 *   It is reported on its own line, never folded into the take.
 *
 * WHAT EACH PARTY GETS
 *   Holder        H(b*) in cash now, which is O plus the improvement. If their side wins, $1 for
 *                 each of the N - k contracts kept; if it loses, nothing more. They owe us nothing
 *                 and we owe them nothing, at settlement or in any tail: the cash is theirs.
 *   Us            L on either result. One exception, said plainly: on ProphetX the fee is taken
 *                 only if the W contract wins, so we are left with L if the holder's side loses
 *                 and L plus that fee if it wins. The bid is priced as if the fee is always paid.
 *   Venue V       its taker fee from the holder (on every fill of the sale) and its fee from us
 *                 on our resting bid. V's other bidders at b or better fill as they would have.
 *   Venue W       its taker fee from us (ProphetX: at settlement, if its contract wins).
 *
 * EARLY EXIT
 *   Holder        buys the k contracts back on V's offers: ceil(walk up) + V's taker fee
 *                 (quoteHolderBuyBack). Nothing passes between the holder and us.
 *   Us            sell m on V into its bids and m of the other side on W into its bids, each
 *                 floor(walk down) - the taker fee (quoteUnwind). Holding pays P at the game, so
 *                 leaving early costs P - what the two sales fetch. On a venue with no sell there
 *                 is nothing to do early: the two contracts already pay $1 between them.
 *
 * WHAT THE ARITHMETIC DOES NOT COVER
 *   The bid rests on a public book: whoever sells into it first is filled. Our result is the
 *   same whoever that is; the holder's improvement is theirs only once their own sale fills.
 *   The books are read at one moment and the two legs trade one after the other, which is the
 *   one-leg case below.
 *
 * THE ONE-LEG CASE (oneLegLoss)
 *   Our bid is hit and the other side cannot be bought at the priced level. We sell the first
 *   leg back into V's bids, which now start below b (the holder's sale took everything at b or
 *   better before it reached us):
 *       loss = (ceil(m x b) + our maker fee) - (floor(m walked down V's bids under b) - taker fee)
 *            = the price difference + both fees.
 *   It is a function so a cap on that loss can be set where the quote is used.
 *
 * ROUNDING, EVERY ONE, AND WHICH WAY
 *   Holder's proceeds        floor to the cent (never overstate the holder's cash); the same
 *                            floor is used for the own sale, so the comparison is like for like.
 *   Venue fees               as each venue's function rounds: up.
 *   Our purchases, V and W   ceil to the cent (never understate what we pay).
 *   Payout on m              floor(m / 10) cents (m is in thousandths of a contract).
 *   Tail charge              ceil (a reserve is never short).
 *   Take                     computeTake's own: share down, minimum up.
 *   Bid                      down to V's grid and under V's offer; what that keeps from the
 *                            holder is `residualCents`.
 *   Improvement per contract floor, in milli-cents.
 *   The holder's proceeds are floored and our purchase of the same fill is rounded up, so up to
 *   one cent of a fill is counted for neither of us. Every rounding but the last two can leave
 *   us up to a cent better off than the figure and none can leave us worse; the bid's rounding
 *   can leave us better off by the residual. Both are visible: `residualCents` on the quote, and
 *   the fees actually paid in settleBetterBid.
 *
 * Units: prices in milli-dollars per $1 of payout (1000 = $1), sizes in milli-contracts
 * (1000 = one contract), their product exact micro-dollars, converted once to cents.
 */

import { computeTake, type TakeBreakdown } from "./collarSearch";
import { hedgeNotionalFeeCents } from "./crossVenuePricer";
import { tailCharge, type RuleCells, type TailCharge, type TailProbabilities } from "./hedgeRouting";
import { kalshiTakerFeeCents } from "./kalshiLadder";
import { polyUsFeeMilli } from "./polymarketUs";
import { buyCostCents } from "./prophetxOrders";
import type { CrossSearchConfig, PmBookLevel } from "./types";
import { signedFeeMilli } from "./venueBooks";

const MICRO_PER_CENT = 10_000;

/** A venue's fee rule, as the code that already prices that venue has it. */
export type VenueFee =
  | { kind: "kalshi"; restingBid?: "taker_formula" | "free" }
  | { kind: "polymarket_us"; coefficient: number }
  | { kind: "novig"; coefficient: number; charged: boolean }
  | { kind: "prophetx"; feeBps: number }
  | { kind: "polymarket"; feeBps: number; flatCents: number }
  | { kind: "stx" }
  | { kind: "folded" };

export type TakeConfig = Pick<CrossSearchConfig, "takeBps" | "minTakeBpsOfStake" | "deMinimisTakeCents">;

interface Walk {
  fills: PmBookLevel[];
  microUsd: number;
  filledMilli: number;
  worstPriceMilli: number;
}

const usable = (l: PmBookLevel): boolean =>
  Number.isInteger(l.priceMilli) && Number.isInteger(l.sizeMilli) && l.priceMilli > 0 && l.priceMilli < 1000 && l.sizeMilli > 0;
const bidsOf = (levels: PmBookLevel[]): PmBookLevel[] => levels.filter(usable).sort((a, b) => b.priceMilli - a.priceMilli);
const asksOf = (levels: PmBookLevel[]): PmBookLevel[] => levels.filter(usable).sort((a, b) => a.priceMilli - b.priceMilli);
const depthOf = (levels: PmBookLevel[]): number => levels.reduce((n, l) => n + l.sizeMilli, 0);
const wholeHundredths = (milli: number): boolean => Number.isInteger(milli) && milli > 0 && milli % 10 === 0;

/** Take up to sizeMilli from levels already in walking order; the fills are kept because fees are per fill. */
function walk(levels: PmBookLevel[], sizeMilli: number): Walk {
  const fills: PmBookLevel[] = [];
  let remaining = sizeMilli;
  let microUsd = 0;
  let worst = 0;
  for (const l of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, l.sizeMilli);
    fills.push({ priceMilli: l.priceMilli, sizeMilli: take });
    microUsd += take * l.priceMilli;
    worst = l.priceMilli;
    remaining -= take;
  }
  return { fills, microUsd, filledMilli: sizeMilli - remaining, worstPriceMilli: worst };
}

/**
 * A taker's fee on fills, cents, by the venue's own function. Null where this code cannot price
 * it: Kalshi's function takes whole cents, ProphetX is costed on the whole buy (otherSideBuy),
 * STX's fee is not on the market.
 */
function takerFeeCents(fee: VenueFee, w: Pick<Walk, "fills" | "microUsd">): number | null {
  switch (fee.kind) {
    case "kalshi": {
      let cents = 0;
      for (const f of w.fills) {
        if (f.priceMilli % 10 !== 0) return null;
        cents += kalshiTakerFeeCents(f.sizeMilli, f.priceMilli / 10);
      }
      return cents;
    }
    case "polymarket_us":
      return Math.ceil(w.fills.reduce((n, f) => n + f.sizeMilli * polyUsFeeMilli(fee.coefficient, f.priceMilli), 0) / MICRO_PER_CENT);
    case "novig":
      return fee.charged ? Math.ceil(w.fills.reduce((n, f) => n + f.sizeMilli * signedFeeMilli(fee.coefficient, f.priceMilli), 0) / MICRO_PER_CENT) : 0;
    case "polymarket":
      return hedgeNotionalFeeCents(Math.ceil(w.microUsd / MICRO_PER_CENT), { hedgeFeeBps: fee.feeBps, hedgeFeeFlatCents: fee.flatCents });
    case "folded":
      return 0;
    case "prophetx":
    case "stx":
      return null;
  }
}

export type RestingBidFeeBasis = "taker_formula" | "free_by_setting" | "taker_only_schedule" | "config_rate";

/** Our fee on V when our resting bid is hit. Null where V cannot be the holder's venue in this shape. */
function restingBidFee(fee: VenueFee, sizeMilli: number, bidMilli: number): { cents: number; basis: RestingBidFeeBasis } | null {
  switch (fee.kind) {
    case "kalshi":
      if (bidMilli % 10 !== 0) return null;
      return fee.restingBid === "free" ? { cents: 0, basis: "free_by_setting" } : { cents: kalshiTakerFeeCents(sizeMilli, bidMilli / 10), basis: "taker_formula" };
    case "polymarket_us":
      return { cents: 0, basis: "taker_only_schedule" };
    case "polymarket":
      return {
        cents: hedgeNotionalFeeCents(Math.ceil((sizeMilli * bidMilli) / MICRO_PER_CENT), { hedgeFeeBps: fee.feeBps, hedgeFeeFlatCents: fee.flatCents }),
        basis: "config_rate",
      };
    default:
      return null;
  }
}

export type VenueRefusalCode = "holder_venue_cannot_sell" | "fee_unpriced";

/** Why a venue cannot be the one a holder sells on, in this file's arithmetic; null when it can. */
function holderVenueRefusal(fee: VenueFee): { code: VenueRefusalCode; reason: string } | null {
  switch (fee.kind) {
    case "novig":
    case "prophetx":
      return {
        code: "holder_venue_cannot_sell",
        reason: "This venue has no sell. A holder leaves by buying the other outcome, which pays at the game and is not cash now, so there is no sale to improve on.",
      };
    case "stx":
      return { code: "fee_unpriced", reason: "This venue's fee is set per account and is not on the market, so a sale there cannot be priced after fees here. The member page prices that sale." };
    case "folded":
      return { code: "fee_unpriced", reason: "This book has the fee inside its prices already. A sale and a resting bid need the venue's own prices and its fee apart." };
    default:
      return null;
  }
}

/** Why a venue's bids cannot be sold into by us; null when they can. */
function sellRefusal(fee: VenueFee): { code: VenueRefusalCode; reason: string } | null {
  if (fee.kind === "folded") return null;
  return holderVenueRefusal(fee);
}

// ---------------------------------------------------------------------------
// shape 1: the holder's own sale
// ---------------------------------------------------------------------------

export interface OwnSaleInputs {
  /** the whole position, milli-contracts */
  positionMilli: number;
  /** the part sold, milli-contracts, to the hundredth of a contract */
  sellMilli: number;
  /** V's bids for the holder's side */
  bids: PmBookLevel[];
  fee: VenueFee;
}

export interface OwnSaleQuote {
  ok: true;
  positionMilli: number;
  soldMilli: number;
  keptMilli: number;
  /** the walked proceeds, floored to the cent */
  grossCents: number;
  /** V's taker fee on the fills */
  feeCents: number;
  /** what reaches the holder now */
  cashCents: number;
  /** the holder's result if their side loses: the cash */
  floorCents: number;
  /** the holder's result if their side wins: the cash plus $1 per contract kept */
  capCents: number;
  avgPriceMilli: number;
  worstPriceMilli: number;
  /** everything V's bids hold, milli-contracts */
  bookDepthMilli: number;
}

export type OwnSaleRefusalCode = "size_invalid" | "book_empty" | "book_too_thin" | "nothing_after_fees" | VenueRefusalCode;

export interface OwnSaleRefusal {
  ok: false;
  code: OwnSaleRefusalCode;
  reason: string;
  bookDepthMilli: number;
}

const contractsWords = (milli: number): string => `${(milli / 1000).toFixed(milli % 1000 === 0 ? 0 : 2)} contracts`;

/** The holder's own sell button: k contracts into V's bids, walked level by level, after V's taker fee. */
export function quoteOwnSale(i: OwnSaleInputs): OwnSaleQuote | OwnSaleRefusal {
  const bids = bidsOf(i.bids);
  const bookDepthMilli = depthOf(bids);
  const refuse = (code: OwnSaleRefusalCode, reason: string): OwnSaleRefusal => ({ ok: false, code, reason, bookDepthMilli });
  if (!wholeHundredths(i.sellMilli) || !wholeHundredths(i.positionMilli) || i.sellMilli > i.positionMilli) {
    return refuse("size_invalid", "The size sold has to be a positive number of contracts, to the hundredth, and no more than the position.");
  }
  const venue = holderVenueRefusal(i.fee);
  if (venue) return refuse(venue.code, venue.reason);
  if (bids.length === 0) return refuse("book_empty", "The venue shows no bid for this side.");
  const w = walk(bids, i.sellMilli);
  if (w.filledMilli < i.sellMilli) {
    return refuse("book_too_thin", `The venue's bids hold ${contractsWords(bookDepthMilli)}; the sale is ${contractsWords(i.sellMilli)}.`);
  }
  const feeCents = takerFeeCents(i.fee, w);
  if (feeCents === null) return refuse("fee_unpriced", "A bid on this book sits off the whole cent, and the venue's fee function in this code takes whole cents.");
  const grossCents = Math.floor(w.microUsd / MICRO_PER_CENT);
  const cashCents = grossCents - feeCents;
  if (cashCents <= 0) return refuse("nothing_after_fees", "The venue's fee takes all the sale would fetch at this size.");
  const keptMilli = i.positionMilli - i.sellMilli;
  return {
    ok: true,
    positionMilli: i.positionMilli,
    soldMilli: i.sellMilli,
    keptMilli,
    grossCents,
    feeCents,
    cashCents,
    floorCents: cashCents,
    capCents: cashCents + keptMilli / 10,
    avgPriceMilli: Math.floor(w.microUsd / i.sellMilli),
    worstPriceMilli: w.worstPriceMilli,
    bookDepthMilli,
  };
}

// ---------------------------------------------------------------------------
// shape 2: the better bid
// ---------------------------------------------------------------------------

export interface BetterBidInputs {
  positionMilli: number;
  sellMilli: number;
  holderVenue: {
    /** V's bids for the holder's side */
    bids: PmBookLevel[];
    /** V's best offer for the holder's side; our bid rests below it. Null when V shows no offer. */
    bestAskMilli: number | null;
    /** V's price step */
    tickMilli: number;
    fee: VenueFee;
    /** V's smallest order, milli-contracts */
    minOrderMilli?: number;
  };
  otherVenue: {
    /** W's offers for the OTHER side */
    asks: PmBookLevel[];
    fee: VenueFee;
    /** W's smallest order, milli-contracts */
    minOrderMilli?: number;
  };
  /** what the router needs to price V and W settling differently */
  tail: {
    holderRules: RuleCells;
    otherRules: RuleCells;
    probabilities: TailProbabilities;
    /** the market's mid for the holder's side, cents */
    markCents: number;
  };
  take: TakeConfig;
}

/** When W's fee is paid: with the trade, only if its contract wins (ProphetX), or already inside the price. */
export type OtherFeeTiming = "at_trade" | "at_settlement_if_it_wins" | "inside_price";

/** Every figure of the shape at one bid price, whether or not it is the one to quote. */
export interface BetterBidAt {
  bidMilli: number;
  /** the part of the sale V's own bidders at the bid or better take first */
  soldToVenueBidsMilli: number;
  /** the part that reaches our bid, which is what we buy on both venues */
  boughtMilli: number;
  holderGrossCents: number;
  holderFeeCents: number;
  holderCashCents: number;
  /** the holder's cash over the own sale at the same size, after fees on both */
  improvementCents: number;
  ourCostOnHolderVenueCents: number;
  ourFeeOnHolderVenueCents: number;
  ourFeeOnHolderVenueBasis: RestingBidFeeBasis;
  otherCostCents: number;
  /** W's fee, cents; 0 with timing "inside_price" means it cannot be shown apart */
  otherFeeCents: number;
  otherFeeTiming: OtherFeeTiming;
  otherAvgPriceMilli: number;
  otherWorstPriceMilli: number;
  payoutCents: number;
  ifSideWinsCents: number;
  ifSideLosesCents: number;
  /** the lower of the two, which is what we count on */
  lockedCents: number;
  tailChargeCents: number;
  tail: TailCharge | null;
  /** the whole gain over the own sale, the holder's part and ours, after the tail charge */
  grossGainCents: number;
  take: TakeBreakdown;
  /** locked less the tail charge less the take; negative means this bid is too high */
  residualCents: number;
  /** the bid leaves us our take and the tail charge, and the holder strictly more cash than the own sale */
  feasible: boolean;
}

export type BetterBidSkip = "own_sale_unpriced" | "not_reached" | "other_side_too_thin" | "below_minimum_size" | "fee_unpriced";

interface OtherBuy {
  costCents: number;
  feeCents: number;
  feeTiming: OtherFeeTiming;
  avgPriceMilli: number;
  worstPriceMilli: number;
  microUsd: number;
}

/** m of the other side lifted from W's offers, after W's fee; null when the offers cannot fill it or the fee cannot be priced. */
function otherSideBuy(asks: PmBookLevel[], fee: VenueFee, sizeMilli: number): OtherBuy | "too_thin" | "fee_unpriced" {
  const w = walk(asks, sizeMilli);
  if (w.filledMilli < sizeMilli) return "too_thin";
  const costCents = Math.ceil(w.microUsd / MICRO_PER_CENT);
  const shape = { costCents, avgPriceMilli: Math.ceil(w.microUsd / sizeMilli), worstPriceMilli: w.worstPriceMilli, microUsd: w.microUsd };
  if (fee.kind === "prophetx") {
    const allIn = buyCostCents({ sharesMilli: sizeMilli, stakeCents: costCents, feesCents: 0 }, fee.feeBps);
    return { ...shape, feeCents: allIn - costCents, feeTiming: "at_settlement_if_it_wins" };
  }
  const feeCents = takerFeeCents(fee, w);
  if (feeCents === null) return "fee_unpriced";
  return { ...shape, feeCents, feeTiming: fee.kind === "folded" ? "inside_price" : "at_trade" };
}

const NO_TAKE: TakeBreakdown = { takeCents: 0, takeShareCents: 0, takeMinimumCents: 0, takeRule: "waived", takeWaived: true };

interface Mode {
  tail: boolean;
  take: boolean;
}

interface Ctx {
  bids: PmBookLevel[];
  asks: PmBookLevel[];
  ownCashCents: number;
  otherBuys: Map<number, OtherBuy | "too_thin" | "fee_unpriced">;
  tails: Map<number, { charge: TailCharge; cents: number }>;
}

function evaluate(i: BetterBidInputs, ctx: Ctx, bidMilli: number, mode: Mode): BetterBidAt | BetterBidSkip {
  const ahead = ctx.bids.filter((l) => l.priceMilli >= bidMilli);
  const soldToVenueBidsMilli = Math.min(i.sellMilli, depthOf(ahead));
  const boughtMilli = i.sellMilli - soldToVenueBidsMilli;
  if (boughtMilli <= 0) return "not_reached";
  if (boughtMilli < Math.max(i.holderVenue.minOrderMilli ?? 0, i.otherVenue.minOrderMilli ?? 0)) return "below_minimum_size";

  const sale = walk([...ahead, { priceMilli: bidMilli, sizeMilli: boughtMilli }], i.sellMilli);
  const holderFeeCents = takerFeeCents(i.holderVenue.fee, sale);
  const ours = restingBidFee(i.holderVenue.fee, boughtMilli, bidMilli);
  if (holderFeeCents === null || ours === null) return "fee_unpriced";
  const holderGrossCents = Math.floor(sale.microUsd / MICRO_PER_CENT);
  const holderCashCents = holderGrossCents - holderFeeCents;

  let other = ctx.otherBuys.get(boughtMilli);
  if (other === undefined) {
    other = otherSideBuy(ctx.asks, i.otherVenue.fee, boughtMilli);
    ctx.otherBuys.set(boughtMilli, other);
  }
  if (other === "too_thin") return "other_side_too_thin";
  if (other === "fee_unpriced") return "fee_unpriced";

  const ourCostOnHolderVenueCents = Math.ceil((boughtMilli * bidMilli) / MICRO_PER_CENT);
  const payoutCents = Math.floor(boughtMilli / 10);
  const paidNow = ourCostOnHolderVenueCents + ours.cents + other.costCents + (other.feeTiming === "at_settlement_if_it_wins" ? 0 : other.feeCents);
  // the holder's side wins: V's contracts pay, W's expire, and a fee due only on W's win is never taken
  const ifSideWinsCents = payoutCents - paidNow;
  // the holder's side loses: W's contracts pay, and a fee due on W's win is taken from that payout
  const ifSideLosesCents = payoutCents - paidNow - (other.feeTiming === "at_settlement_if_it_wins" ? other.feeCents : 0);
  const lockedCents = Math.min(ifSideWinsCents, ifSideLosesCents);

  let tail: { charge: TailCharge; cents: number } | null = null;
  if (mode.tail) {
    tail = ctx.tails.get(boughtMilli) ?? null;
    if (!tail) {
      // what one W contract cost, cents, as walked; a folded book's average carries its fee, as the router's does
      const q = other.microUsd / boughtMilli / 10;
      const charge = tailCharge(
        i.tail.holderRules,
        i.tail.otherRules,
        { floorCents: 100 - q, capCents: 100 - q, markCents: i.tail.markCents, hedgeUnitsPerContractMilli: 1000, hedgeAvgPriceCents: q },
        i.tail.probabilities,
      );
      // the router's figure is to four places of a cent; scale it as an integer before the size, then up
      tail = { charge, cents: Math.ceil((Math.round(charge.chargeCentsPerContract * 10_000) * boughtMilli) / 10_000_000) };
      ctx.tails.set(boughtMilli, tail);
    }
  }
  const tailChargeCents = tail ? tail.cents : 0;
  const improvementCents = holderCashCents - ctx.ownCashCents;
  const grossGainCents = improvementCents + lockedCents - tailChargeCents;
  const take = mode.take ? computeTake(Math.max(0, grossGainCents), boughtMilli / 1000, i.take) : NO_TAKE;
  const residualCents = lockedCents - tailChargeCents - take.takeCents;
  return {
    bidMilli,
    soldToVenueBidsMilli,
    boughtMilli,
    holderGrossCents,
    holderFeeCents,
    holderCashCents,
    improvementCents,
    ourCostOnHolderVenueCents,
    ourFeeOnHolderVenueCents: ours.cents,
    ourFeeOnHolderVenueBasis: ours.basis,
    otherCostCents: other.costCents,
    otherFeeCents: other.feeCents,
    otherFeeTiming: other.feeTiming,
    otherAvgPriceMilli: other.avgPriceMilli,
    otherWorstPriceMilli: other.worstPriceMilli,
    payoutCents,
    ifSideWinsCents,
    ifSideLosesCents,
    lockedCents,
    tailChargeCents,
    tail: tail ? tail.charge : null,
    grossGainCents,
    take,
    residualCents,
    feasible: residualCents >= 0 && improvementCents > 0,
  };
}

const ctxFor = (i: BetterBidInputs, ownCashCents: number): Ctx => ({
  bids: bidsOf(i.holderVenue.bids),
  asks: asksOf(i.otherVenue.asks),
  ownCashCents,
  otherBuys: new Map(),
  tails: new Map(),
});

/**
 * Every figure at one bid price: what the holder gets, what we pay on each venue, what we are
 * left with on each result. For an operator reading one price and for the tests; quoteBetterBid
 * picks the price. A skip says why the price has no figures.
 */
export function betterBidAt(i: BetterBidInputs, bidMilli: number): BetterBidAt | BetterBidSkip {
  const own = quoteOwnSale({ positionMilli: i.positionMilli, sellMilli: i.sellMilli, bids: i.holderVenue.bids, fee: i.holderVenue.fee });
  if (!own.ok) return own.code === "fee_unpriced" ? "fee_unpriced" : "own_sale_unpriced";
  return evaluate(i, ctxFor(i, own.cashCents), bidMilli, { tail: true, take: true });
}

export type BetterBidRefusalCode =
  | "size_invalid"
  | "holder_venue_cannot_sell"
  | "fee_unpriced"
  | "own_sale_unpriced"
  | "spread_closed"
  | "other_side_empty"
  | "other_side_too_thin"
  | "below_minimum_size"
  | "no_improvement"
  | "tail_charge_eats_it"
  | "take_eats_it";

export interface BookDepths {
  /** everything V's bids hold for the holder's side, milli-contracts */
  holderVenueBidMilli: number;
  /** everything W's offers hold for the other side, milli-contracts */
  otherVenueAskMilli: number;
}

export interface BetterBidRefusal {
  ok: false;
  code: BetterBidRefusalCode;
  reason: string;
  /** the own sale at the same size, when V's book prices it */
  ownSale: OwnSaleQuote | null;
  available: BookDepths;
}

export interface BetterBidQuote {
  ok: true;
  /** the price we would rest on V, on V's grid */
  bidMilli: number;
  ownSale: OwnSaleQuote;
  holder: {
    soldMilli: number;
    /** filled by V's own bidders at our price or better, ahead of us */
    soldToVenueBidsMilli: number;
    soldToUsMilli: number;
    keptMilli: number;
    grossCents: number;
    feeCents: number;
    cashCents: number;
    /** if their side loses: the cash */
    floorCents: number;
    /** if their side wins: the cash plus $1 per contract kept */
    capCents: number;
    /** cash over the own sale at the same size, after fees on both; always above zero on a quote */
    improvementCents: number;
    /** the same per contract sold, milli-cents, rounded down */
    improvementMilliCentsPerContract: number;
  };
  us: {
    boughtMilli: number;
    holderVenueCostCents: number;
    holderVenueFeeCents: number;
    holderVenueFeeBasis: RestingBidFeeBasis;
    otherVenueCostCents: number;
    otherVenueFeeCents: number;
    otherVenueFeeTiming: OtherFeeTiming;
    payoutCents: number;
    ifSideWinsCents: number;
    ifSideLosesCents: number;
    /** what we are left with on either result (the lower of the two where they differ) */
    lockedCents: number;
    takeCents: number;
    take: TakeBreakdown;
    tailChargeCents: number;
    /** locked = take + tail charge + residual; the residual is what a resting bid could not pass on to the holder */
    residualCents: number;
    /** why the bid is no higher: the next step up would leave us short of our take, or it would reach V's own offer */
    bidLimitedBy: "our_take" | "venue_offer";
  };
  holderVenue: { feeFromHolderCents: number; feeFromUsCents: number };
  otherVenue: { feeFromUsCents: number; feeTiming: OtherFeeTiming; avgPriceMilli: number; worstPriceMilli: number };
  tail: TailCharge;
  available: BookDepths;
  /** what it costs if our bid is hit and the other side cannot be bought */
  oneLeg: OneLegLoss | OneLegRefusal;
}

interface Scan {
  best: BetterBidAt | null;
  priced: number;
  skips: Record<BetterBidSkip, number>;
  candidates: number;
}

function scan(i: BetterBidInputs, ctx: Ctx, fromMilli: number, toMilli: number, mode: Mode): Scan {
  const out: Scan = { best: null, priced: 0, skips: { own_sale_unpriced: 0, not_reached: 0, other_side_too_thin: 0, below_minimum_size: 0, fee_unpriced: 0 }, candidates: 0 };
  // top down, and a tie in the holder's cash goes to the lower price: a higher bid that pays the holder nothing more only pays V's fee
  for (let b = toMilli; b >= fromMilli; b -= i.holderVenue.tickMilli) {
    out.candidates += 1;
    const at = evaluate(i, ctx, b, mode);
    if (typeof at === "string") {
      out.skips[at] += 1;
      continue;
    }
    out.priced += 1;
    if (at.feasible && (!out.best || at.holderCashCents >= out.best.holderCashCents)) out.best = at;
  }
  return out;
}

/**
 * The bid we can pay for the part of a position the holder sells, or the plain reason there is
 * none. A quote exists only when the holder's cash after fees is strictly more than their own
 * sale's cash after fees at the same size, and we are left with our take and the tail charge on
 * either result.
 */
export function quoteBetterBid(i: BetterBidInputs): BetterBidQuote | BetterBidRefusal {
  const bids = bidsOf(i.holderVenue.bids);
  const asks = asksOf(i.otherVenue.asks);
  const available: BookDepths = { holderVenueBidMilli: depthOf(bids), otherVenueAskMilli: depthOf(asks) };
  const own = quoteOwnSale({ positionMilli: i.positionMilli, sellMilli: i.sellMilli, bids: i.holderVenue.bids, fee: i.holderVenue.fee });
  const refuse = (code: BetterBidRefusalCode, reason: string): BetterBidRefusal => ({ ok: false, code, reason, ownSale: own.ok ? own : null, available });

  if (!own.ok) {
    if (own.code === "size_invalid" || own.code === "holder_venue_cannot_sell" || own.code === "fee_unpriced") return refuse(own.code, own.reason);
    return refuse("own_sale_unpriced", `The holder's own sale cannot be priced, so there is nothing to compare a bid with. ${own.reason}`);
  }
  const tick = i.holderVenue.tickMilli;
  if (!Number.isInteger(tick) || tick <= 0 || (i.holderVenue.fee.kind === "kalshi" && tick % 10 !== 0)) {
    return refuse("fee_unpriced", "The venue's price step is not one this code's fee function can price.");
  }
  if (i.otherVenue.fee.kind === "stx") {
    return refuse("fee_unpriced", "The other venue's fee is set per account and is not on the market, so the other side cannot be priced after fees.");
  }
  if (asks.length === 0) return refuse("other_side_empty", "The other venue shows no offer for the other side.");

  // above the last price the own sale reaches (at that price we stand behind the order already there), under V's best offer
  const from = (Math.floor(own.worstPriceMilli / tick) + 1) * tick;
  const ceiling = i.holderVenue.bestAskMilli !== null && i.holderVenue.bestAskMilli > 0 ? Math.min(i.holderVenue.bestAskMilli, 1000) : 1000;
  const to = Math.ceil(ceiling / tick) * tick - tick;
  if (to < from) {
    return refuse("spread_closed", "There is no price between the last bid the holder's sale reaches and the venue's offer for a bid to rest at.");
  }

  const ctx = ctxFor(i, own.cashCents);
  const full = scan(i, ctx, from, to, { tail: true, take: true });
  if (!full.best) {
    if (full.priced === 0) {
      if (full.skips.other_side_too_thin > 0) {
        return refuse("other_side_too_thin", `The other venue's offers hold ${contractsWords(available.otherVenueAskMilli)} of the other side, fewer than a bid here would need to buy.`);
      }
      if (full.skips.below_minimum_size > 0) return refuse("below_minimum_size", "The part of the sale that would reach our bid is under a venue's smallest order.");
      if (full.skips.fee_unpriced > 0) return refuse("fee_unpriced", "A price on one of the two books sits where this code's fee function for that venue cannot price it.");
      return refuse("no_improvement", "The venue's own bidders already take the whole sale at every price a bid could rest at.");
    }
    if (!scan(i, ctx, from, to, { tail: false, take: false }).best) {
      return refuse("no_improvement", "Buying the other side at the other venue's offers, after both venues' fees, leaves no room to pay more than the venue's own bid does.");
    }
    if (!scan(i, ctx, from, to, { tail: true, take: false }).best) {
      return refuse(
        "tail_charge_eats_it",
        "The two prices leave room, and the charge for the two venues settling differently (a tie, a postponement, a game called off, a corrected result) takes all of it.",
      );
    }
    return refuse("take_eats_it", "What the two prices leave after fees and the settlement charge is less than our fee, so nothing more would reach the holder.");
  }

  const at = full.best;
  const stepUp = at.bidMilli === to && to + tick < 1000 ? evaluate(i, ctx, to + tick, { tail: true, take: true }) : null;
  const bidLimitedBy = stepUp !== null && typeof stepUp !== "string" && stepUp.feasible && stepUp.holderCashCents > at.holderCashCents ? "venue_offer" : "our_take";
  return {
    ok: true,
    bidMilli: at.bidMilli,
    ownSale: own,
    holder: {
      soldMilli: i.sellMilli,
      soldToVenueBidsMilli: at.soldToVenueBidsMilli,
      soldToUsMilli: at.boughtMilli,
      keptMilli: own.keptMilli,
      grossCents: at.holderGrossCents,
      feeCents: at.holderFeeCents,
      cashCents: at.holderCashCents,
      floorCents: at.holderCashCents,
      capCents: at.holderCashCents + own.keptMilli / 10,
      improvementCents: at.improvementCents,
      improvementMilliCentsPerContract: Math.floor((at.improvementCents * 1_000_000) / i.sellMilli),
    },
    us: {
      boughtMilli: at.boughtMilli,
      holderVenueCostCents: at.ourCostOnHolderVenueCents,
      holderVenueFeeCents: at.ourFeeOnHolderVenueCents,
      holderVenueFeeBasis: at.ourFeeOnHolderVenueBasis,
      otherVenueCostCents: at.otherCostCents,
      otherVenueFeeCents: at.otherFeeCents,
      otherVenueFeeTiming: at.otherFeeTiming,
      payoutCents: at.payoutCents,
      ifSideWinsCents: at.ifSideWinsCents,
      ifSideLosesCents: at.ifSideLosesCents,
      lockedCents: at.lockedCents,
      takeCents: at.take.takeCents,
      take: at.take,
      tailChargeCents: at.tailChargeCents,
      residualCents: at.residualCents,
      bidLimitedBy,
    },
    holderVenue: { feeFromHolderCents: at.holderFeeCents, feeFromUsCents: at.ourFeeOnHolderVenueCents },
    otherVenue: { feeFromUsCents: at.otherFeeCents, feeTiming: at.otherFeeTiming, avgPriceMilli: at.otherAvgPriceMilli, worstPriceMilli: at.otherWorstPriceMilli },
    tail: at.tail as TailCharge,
    available,
    oneLeg: oneLegLoss({ boughtMilli: at.boughtMilli, bidMilli: at.bidMilli, bids: i.holderVenue.bids, fee: i.holderVenue.fee }),
  };
}

// ---------------------------------------------------------------------------
// settlement, as each party sees it
// ---------------------------------------------------------------------------

export type GameResult = "side_wins" | "side_loses";

export interface BetterBidSettlement {
  result: GameResult;
  /** the holder: the cash from the sale, plus $1 per contract kept when their side wins */
  holderCents: number;
  /** us: what the winning leg pays less everything paid on both legs */
  usCents: number;
  /** V: its fee from the holder and its fee from us */
  holderVenueFeesCents: number;
  /** W: its fee from us (a fee due only when its contract wins is 0 when it loses) */
  otherVenueFeesCents: number;
}

/**
 * The quote settled on one result, each party's money from the legs themselves rather than from
 * the quote's own totals. `paid` replaces a priced fee with the one a venue actually took, which
 * is where a maker fee lower than the priced one shows up as ours.
 */
export function settleBetterBid(
  q: BetterBidQuote,
  result: GameResult,
  paid: { holderVenueFeeCents?: number; otherVenueFeeCents?: number } = {},
): BetterBidSettlement {
  const wins = result === "side_wins";
  const feeOnV = paid.holderVenueFeeCents ?? q.us.holderVenueFeeCents;
  const feeOnWPriced = paid.otherVenueFeeCents ?? q.us.otherVenueFeeCents;
  const feeOnW = q.us.otherVenueFeeTiming === "at_settlement_if_it_wins" && wins ? 0 : feeOnWPriced;
  // exactly one of our two legs pays: V's contracts on a win for the holder's side, W's on a loss
  const legPays = q.us.payoutCents;
  return {
    result,
    holderCents: q.holder.cashCents + (wins ? q.holder.keptMilli / 10 : 0),
    usCents: legPays - q.us.holderVenueCostCents - feeOnV - q.us.otherVenueCostCents - feeOnW,
    holderVenueFeesCents: q.holder.feeCents + feeOnV,
    otherVenueFeesCents: feeOnW,
  };
}

// ---------------------------------------------------------------------------
// the one-leg case
// ---------------------------------------------------------------------------

export interface OneLegInputs {
  /** what our bid bought, milli-contracts */
  boughtMilli: number;
  /** the price our bid was hit at */
  bidMilli: number;
  /** V's bids as read before the sale; everything at our price or better is gone, the holder's sale took it first */
  bids: PmBookLevel[];
  fee: VenueFee;
}

export interface OneLegLoss {
  ok: true;
  /** what the first leg cost: the price, rounded up */
  paidCents: number;
  /** our fee on that fill */
  paidFeeCents: number;
  /** what selling it back fetches: V's bids under our price, walked, rounded down */
  soldBackGrossCents: number;
  /** V's taker fee on the sale back */
  soldBackFeeCents: number;
  /** the price difference alone */
  priceGapCents: number;
  /** the price difference plus both fees; never understated */
  lossCents: number;
  worstPriceMilli: number;
}

export type OneLegRefusalCode = "size_invalid" | "unwind_book_empty" | "unwind_book_too_thin" | VenueRefusalCode;

export interface OneLegRefusal {
  ok: false;
  code: OneLegRefusalCode;
  reason: string;
  /** what V's bids under our price hold, milli-contracts */
  depthUnderBidMilli: number;
}

/**
 * Our bid was hit and the other side cannot be bought at the priced level: the first leg is sold
 * back into V's bids. The loss is the price difference plus our fee on the way in and V's taker
 * fee on the way out. A refusal means the book under our price cannot take the size back, so the
 * loss has no bound on this book.
 */
export function oneLegLoss(i: OneLegInputs): OneLegLoss | OneLegRefusal {
  const under = bidsOf(i.bids).filter((l) => l.priceMilli < i.bidMilli);
  const depthUnderBidMilli = depthOf(under);
  const refuse = (code: OneLegRefusalCode, reason: string): OneLegRefusal => ({ ok: false, code, reason, depthUnderBidMilli });
  if (!Number.isInteger(i.boughtMilli) || i.boughtMilli <= 0 || !Number.isInteger(i.bidMilli) || i.bidMilli <= 0 || i.bidMilli >= 1000) {
    return refuse("size_invalid", "The size bought and the price paid have to be positive, and the price under $1.");
  }
  const venue = holderVenueRefusal(i.fee);
  if (venue) return refuse(venue.code, venue.reason);
  const paidFee = restingBidFee(i.fee, i.boughtMilli, i.bidMilli);
  if (!paidFee) return refuse("fee_unpriced", "The price paid sits where this code's fee function for the venue cannot price it.");
  if (under.length === 0) return refuse("unwind_book_empty", "The venue shows no bid under our price to sell the first leg back into.");
  const w = walk(under, i.boughtMilli);
  if (w.filledMilli < i.boughtMilli) {
    return refuse("unwind_book_too_thin", `The venue's bids under our price hold ${contractsWords(depthUnderBidMilli)}; the first leg is ${contractsWords(i.boughtMilli)}.`);
  }
  const soldBackFeeCents = takerFeeCents(i.fee, w);
  if (soldBackFeeCents === null) return refuse("fee_unpriced", "A bid on this book sits off the whole cent, and the venue's fee function in this code takes whole cents.");
  const paidCents = Math.ceil((i.boughtMilli * i.bidMilli) / MICRO_PER_CENT);
  const soldBackGrossCents = Math.floor(w.microUsd / MICRO_PER_CENT);
  return {
    ok: true,
    paidCents,
    paidFeeCents: paidFee.cents,
    soldBackGrossCents,
    soldBackFeeCents,
    priceGapCents: paidCents - soldBackGrossCents,
    lossCents: paidCents + paidFee.cents - (soldBackGrossCents - soldBackFeeCents),
    worstPriceMilli: w.worstPriceMilli,
  };
}

// ---------------------------------------------------------------------------
// early exit
// ---------------------------------------------------------------------------

export interface BuyBackQuote {
  ok: true;
  boughtMilli: number;
  /** V's offers walked up, rounded up */
  costCents: number;
  /** V's taker fee */
  feeCents: number;
  totalCents: number;
  worstPriceMilli: number;
}

export type ExitRefusalCode = "size_invalid" | "book_empty" | "book_too_thin" | "venue_cannot_sell" | VenueRefusalCode;

export interface ExitRefusal {
  ok: false;
  code: ExitRefusalCode;
  reason: string;
}

/**
 * The holder changes their mind: the contracts sold are bought back on V's offers, at V's taker
 * fee. Nothing passes between the holder and us; what the round trip cost them is this total
 * less the cash the sale paid.
 */
export function quoteHolderBuyBack(i: { buyMilli: number; asks: PmBookLevel[]; fee: VenueFee }): BuyBackQuote | ExitRefusal {
  if (!wholeHundredths(i.buyMilli)) return { ok: false, code: "size_invalid", reason: "The size bought back has to be a positive number of contracts, to the hundredth." };
  const venue = holderVenueRefusal(i.fee);
  if (venue) return { ok: false, code: venue.code, reason: venue.reason };
  const asks = asksOf(i.asks);
  if (asks.length === 0) return { ok: false, code: "book_empty", reason: "The venue shows no offer for this side." };
  const w = walk(asks, i.buyMilli);
  if (w.filledMilli < i.buyMilli) {
    return { ok: false, code: "book_too_thin", reason: `The venue's offers hold ${contractsWords(depthOf(asks))}; the buy back is ${contractsWords(i.buyMilli)}.` };
  }
  const feeCents = takerFeeCents(i.fee, w);
  if (feeCents === null) return { ok: false, code: "fee_unpriced", reason: "An offer on this book sits off the whole cent, and the venue's fee function in this code takes whole cents." };
  const costCents = Math.ceil(w.microUsd / MICRO_PER_CENT);
  return { ok: true, boughtMilli: i.buyMilli, costCents, feeCents, totalCents: costCents + feeCents, worstPriceMilli: w.worstPriceMilli };
}

export interface UnwindQuote {
  ok: true;
  soldMilli: number;
  /** V's bids walked down for our contracts, rounded down, less V's taker fee */
  holderVenueNetCents: number;
  holderVenueFeeCents: number;
  /** W's bids walked down for the other side, rounded down, less W's taker fee */
  otherVenueNetCents: number;
  otherVenueFeeCents: number;
  proceedsCents: number;
  /** what holding both legs to the game pays */
  payoutCents: number;
  /** what leaving early gives up against holding: the payout less the proceeds */
  costAgainstHoldingCents: number;
}

/**
 * We leave both legs before the game: our contracts sold into V's bids and the other side sold
 * into W's bids, each after its taker fee. Refused on a venue with no sell, where there is
 * nothing to do early because the two contracts already pay $1 between them at the game.
 */
export function quoteUnwind(i: {
  milli: number;
  holderVenue: { bids: PmBookLevel[]; fee: VenueFee };
  /** W's bids for the OTHER side */
  otherVenue: { bids: PmBookLevel[]; fee: VenueFee };
}): UnwindQuote | ExitRefusal {
  if (!Number.isInteger(i.milli) || i.milli <= 0) return { ok: false, code: "size_invalid", reason: "The size has to be positive." };
  const legs: Array<{ netCents: number; feeCents: number }> = [];
  for (const [leg, name] of [
    [i.holderVenue, "The holder's venue"],
    [i.otherVenue, "The other venue"],
  ] as const) {
    const venue = sellRefusal(leg.fee);
    if (venue) {
      return venue.code === "holder_venue_cannot_sell"
        ? { ok: false, code: "venue_cannot_sell", reason: `${name} has no sell. The two contracts already pay $1 between them at the game, so there is nothing to do early.` }
        : { ok: false, code: venue.code, reason: venue.reason };
    }
    const bids = bidsOf(leg.bids);
    if (bids.length === 0) return { ok: false, code: "book_empty", reason: `${name} shows no bid to sell into.` };
    const w = walk(bids, i.milli);
    if (w.filledMilli < i.milli) return { ok: false, code: "book_too_thin", reason: `${name}'s bids hold ${contractsWords(depthOf(bids))}; the leg is ${contractsWords(i.milli)}.` };
    const feeCents = takerFeeCents(leg.fee, w);
    if (feeCents === null) return { ok: false, code: "fee_unpriced", reason: `${name}'s fee cannot be priced on this book by this code.` };
    legs.push({ netCents: Math.floor(w.microUsd / MICRO_PER_CENT) - feeCents, feeCents });
  }
  const proceedsCents = legs[0].netCents + legs[1].netCents;
  const payoutCents = Math.floor(i.milli / 10);
  return {
    ok: true,
    soldMilli: i.milli,
    holderVenueNetCents: legs[0].netCents,
    holderVenueFeeCents: legs[0].feeCents,
    otherVenueNetCents: legs[1].netCents,
    otherVenueFeeCents: legs[1].feeCents,
    proceedsCents,
    payoutCents,
    costAgainstHoldingCents: payoutCents - proceedsCents,
  };
}
