/**
 * The better bid (betterBid.ts): the identity on both results to the cent over every pair of
 * whole-cent prices, several sizes and the fee schedules the repo knows; every refusal; which
 * way each rounding goes; the one-leg loss; the early exits. The expected figures are recomputed
 * here from the venues' own fee functions and the house walks, not read back off the quote.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  betterBidAt,
  oneLegLoss,
  quoteBetterBid,
  quoteHolderBuyBack,
  quoteOwnSale,
  quoteUnwind,
  settleBetterBid,
  type BetterBidInputs,
  type BetterBidQuote,
  type VenueFee,
} from "../src/eventCollar/crossVenue/betterBid";
import { computeTake } from "../src/eventCollar/crossVenue/collarSearch";
import { walkPmAsks } from "../src/eventCollar/crossVenue/crossVenuePricer";
import { walkKalshiBids } from "../src/eventCollar/crossVenue/earlyClose";
import { rulesFor, tailCharge, tailProbabilities, type RuleCells, type TailProbabilities } from "../src/eventCollar/crossVenue/hedgeRouting";
import { kalshiMakerFeeCents, kalshiTakerFeeCents, walkNoAsks } from "../src/eventCollar/crossVenue/kalshiLadder";
import { POLY_US_DEFAULT_COEFFICIENT, polyUsFeeMilli } from "../src/eventCollar/crossVenue/polymarketUs";
import { DEFAULT_PROPHETX_FEE_BPS, buyCostCents } from "../src/eventCollar/crossVenue/prophetxOrders";
import { DEFAULT_CROSS_CONFIG, type PmBookLevel } from "../src/eventCollar/crossVenue/types";
import { signedFeeMilli } from "../src/eventCollar/crossVenue/venueBooks";

const TAKE = DEFAULT_CROSS_CONFIG;
const DEEP = 10_000_000;
const KALSHI: VenueFee = { kind: "kalshi" };
const KALSHI_FREE: VenueFee = { kind: "kalshi", restingBid: "free" };
const KALSHI_AT_TAKER: VenueFee = { kind: "kalshi", restingBid: "taker_formula" };
const KALSHI_M2: VenueFee = { kind: "kalshi", makerMultiplier: 2 };
const POLY_US: VenueFee = { kind: "polymarket_us", coefficient: POLY_US_DEFAULT_COEFFICIENT };
const NOVIG_LIVE: VenueFee = { kind: "novig", coefficient: 0.06, charged: true };
const NOVIG_PREGAME: VenueFee = { kind: "novig", coefficient: 0.06, charged: false };
const PROPHETX: VenueFee = { kind: "prophetx", feeBps: DEFAULT_PROPHETX_FEE_BPS };
const POLYMARKET: VenueFee = { kind: "polymarket", feeBps: 0, flatCents: 0 };
const POLYMARKET_FEE: VenueFee = { kind: "polymarket", feeBps: 50, flatCents: 2 };
const FOLDED: VenueFee = { kind: "folded" };

const PROBS: TailProbabilities = tailProbabilities("nfl");
const KALSHI_RULES = rulesFor("kalshi", "nfl");
const OTHER_RULES = rulesFor("polymarket", "nfl");
/** a pair of venues that settle every tail the same way: no charge */
const SAME_RULES = { holderRules: KALSHI_RULES, otherRules: KALSHI_RULES, probabilities: PROBS, markCents: 60 };

const level = (priceMilli: number, sizeMilli = DEEP): PmBookLevel => ({ priceMilli, sizeMilli });

function inputs(o: {
  sellMilli?: number;
  positionMilli?: number;
  bids?: PmBookLevel[];
  bestAskMilli?: number | null;
  tickMilli?: number;
  holderFee?: VenueFee;
  asks?: PmBookLevel[];
  otherFee?: VenueFee;
  tail?: BetterBidInputs["tail"];
  take?: BetterBidInputs["take"];
  holderMin?: number;
  otherMin?: number;
}): BetterBidInputs {
  const sellMilli = o.sellMilli ?? 100_000;
  return {
    positionMilli: o.positionMilli ?? sellMilli + 50_000,
    sellMilli,
    holderVenue: {
      bids: o.bids ?? [level(580)],
      bestAskMilli: o.bestAskMilli === undefined ? null : o.bestAskMilli,
      tickMilli: o.tickMilli ?? 10,
      fee: o.holderFee ?? KALSHI,
      ...(o.holderMin !== undefined ? { minOrderMilli: o.holderMin } : {}),
    },
    otherVenue: { asks: o.asks ?? [level(330)], fee: o.otherFee ?? POLYMARKET, ...(o.otherMin !== undefined ? { minOrderMilli: o.otherMin } : {}) },
    tail: o.tail ?? { holderRules: KALSHI_RULES, otherRules: OTHER_RULES, probabilities: PROBS, markCents: 60 },
    take: o.take ?? TAKE,
  };
}

const quoted = (i: BetterBidInputs): BetterBidQuote => {
  const q = quoteBetterBid(i);
  assert.ok(q.ok, JSON.stringify(q));
  return q;
};

// the venues' own arithmetic on ONE fill, written out here so the module's figures are checked against it

const up = (micro: number): number => Math.ceil(micro / 10_000);
const down = (micro: number): number => Math.floor(micro / 10_000);

function takerFee(fee: VenueFee, sizeMilli: number, priceMilli: number): number {
  switch (fee.kind) {
    case "kalshi":
      return kalshiTakerFeeCents(sizeMilli, priceMilli / 10);
    case "polymarket_us":
      return up(sizeMilli * polyUsFeeMilli(fee.coefficient, priceMilli));
    case "novig":
      return fee.charged ? up(sizeMilli * signedFeeMilli(fee.coefficient, priceMilli)) : 0;
    case "polymarket":
      return fee.flatCents + Math.ceil((up(sizeMilli * priceMilli) * fee.feeBps) / 10_000);
    case "prophetx":
      return buyCostCents({ sharesMilli: sizeMilli, stakeCents: up(sizeMilli * priceMilli), feesCents: 0 }, fee.feeBps) - up(sizeMilli * priceMilli);
    default:
      return 0;
  }
}

/**
 * Kalshi's maker schedule, written out here apart from the module's own function:
 * round up(M x 0.0175 x C x P x (1 - P)) dollars. In cents, with the size in thousandths of a
 * contract and the price in whole cents: 175 x M x size x p x (100 - p) / 10^9.
 */
const kalshiMaker = (sizeMilli: number, priceMilli: number, m = 1): number => Math.ceil((175 * m * sizeMilli * (priceMilli / 10) * (100 - priceMilli / 10)) / 1_000_000_000);

function makerFee(fee: VenueFee, sizeMilli: number, priceMilli: number): number {
  if (fee.kind === "kalshi") return fee.restingBid === "free" ? 0 : fee.restingBid === "taker_formula" ? kalshiTakerFeeCents(sizeMilli, priceMilli / 10) : kalshiMaker(sizeMilli, priceMilli, fee.makerMultiplier ?? 1);
  if (fee.kind === "polymarket") return takerFee(fee, sizeMilli, priceMilli);
  return 0;
}

function tailCents(i: BetterBidInputs, otherAvgCents: number, boughtMilli: number): number {
  const c = tailCharge(
    i.tail.holderRules,
    i.tail.otherRules,
    { floorCents: 100 - otherAvgCents, capCents: 100 - otherAvgCents, markCents: i.tail.markCents, hedgeUnitsPerContractMilli: 1000, hedgeAvgPriceCents: otherAvgCents },
    i.tail.probabilities,
  );
  return Math.ceil((Math.round(c.chargeCentsPerContract * 10_000) * boughtMilli) / 10_000_000);
}

const PLAIN_WORDS = /\u2014|\u2013|guarantee|wallet|protect/i;

// ---------------------------------------------------------------------------
// one quote, every figure by hand
// ---------------------------------------------------------------------------

test("better bid: a worked quote, every party's figure by hand", () => {
  // 150 contracts on Kalshi, 100 sold. Kalshi bids 58c, offers 62c. The other side is offered at 33c elsewhere, no fee.
  const i = inputs({ sellMilli: 100_000, positionMilli: 150_000, bids: [level(580, 500_000)], bestAskMilli: 620, asks: [level(330, 500_000)] });
  const q = quoted(i);

  // own sale: 100 x 58c = $58.00, Kalshi's taker fee ceil(0.07 x 100 x 0.58 x 0.42) = $1.71
  assert.deepEqual([q.ownSale.grossCents, q.ownSale.feeCents, q.ownSale.cashCents], [5800, 171, 5629]);
  assert.deepEqual([q.ownSale.floorCents, q.ownSale.capCents], [5629, 5629 + 5000]);

  // our bid rests at 61c, one step under Kalshi's 62c offer: 100 x 61c = $61.00 less ceil(0.07 x 100 x 0.61 x 0.39) = $1.67
  assert.equal(q.bidMilli, 610);
  assert.deepEqual([q.holder.grossCents, q.holder.feeCents, q.holder.cashCents], [6100, 167, 5933]);
  assert.deepEqual([q.holder.improvementCents, q.holder.improvementMilliCentsPerContract], [304, 3040]);
  assert.deepEqual([q.holder.soldToUsMilli, q.holder.soldToVenueBidsMilli, q.holder.keptMilli], [100_000, 0, 50_000]);
  assert.deepEqual([q.holder.floorCents, q.holder.capCents], [5933, 10_933]);

  // us: $61.00 and Kalshi's maker fee on our resting bid, ceil(0.0175 x 100 x 0.61 x 0.39 = 41.6c) = 42c; $33.00 on the other venue; $100 back on either result
  assert.deepEqual(
    [q.us.holderVenueCostCents, q.us.holderVenueFeeCents, q.us.holderVenueFeeBasis, q.us.otherVenueCostCents, q.us.otherVenueFeeCents, q.us.payoutCents],
    [6100, 42, "maker_schedule", 3300, 0, 10_000],
  );
  // $100.00 - $61.00 - 42c - $33.00
  assert.deepEqual([q.us.ifSideWinsCents, q.us.ifSideLosesCents, q.us.lockedCents], [558, 558, 558]);
  // the tail charge is the router's, on a writer whose floor and cap are both 100 - 33
  assert.equal(q.us.tailChargeCents, tailCents(i, 33, 100_000));
  assert.equal(q.us.tailChargeCents, 12);
  // the gain to share is the holder's $3.04 plus our $5.58 less the charge; our take is a tenth of it, rounded down
  assert.deepEqual([q.us.takeCents, q.us.take.takeRule], [Math.floor((304 + 558 - 12) / 10), "share"]);
  assert.equal(q.us.residualCents, 558 - 12 - 85);
  // the bid stops at the venue's own offer, not at our take, and the quote says so; what is left over stays with us, on its own line
  assert.equal(q.us.bidLimitedBy, "venue_offer");
  assert.equal(q.us.residualKeptBy, "us");
  assert.equal(q.us.lockedCents, q.us.takeCents + q.us.tailChargeCents + q.us.residualCents);

  const win = settleBetterBid(q, "side_wins");
  const lose = settleBetterBid(q, "side_loses");
  // the venue's fees: the taker's $1.67 from the holder and the maker's 42c from us
  assert.deepEqual(win, { result: "side_wins", holderCents: 5933 + 5000, usCents: 558, holderVenueFeesCents: 167 + 42, otherVenueFeesCents: 0 });
  assert.deepEqual(lose, { result: "side_loses", holderCents: 5933, usCents: 558, holderVenueFeesCents: 209, otherVenueFeesCents: 0 });

  // a market that charges our resting bid nothing: the difference is ours and the settlement shows it
  assert.equal(settleBetterBid(q, "side_wins", { holderVenueFeeCents: 0 }).usCents, 558 + 42);

  // the same books with the bid priced at the full taker rate, as the record priced it before the schedule was in hand:
  // $1.67 where the schedule charges 42c, so $1.25 less is left, the take is a tenth of a smaller gain, and the holder's cash is the same
  const before = quoted({ ...i, holderVenue: { ...i.holderVenue, fee: KALSHI_AT_TAKER } });
  assert.deepEqual([before.us.holderVenueFeeCents, before.us.holderVenueFeeBasis, before.us.lockedCents, before.us.takeCents], [167, "taker_formula", 433, 72]);
  assert.equal(before.holder.cashCents, q.holder.cashCents);
  assert.deepEqual(q.available, { holderVenueBidMilli: 500_000, otherVenueAskMilli: 500_000 });
});

test("better bid: with no offer in the way the bid climbs until one more step would leave us short of our take", () => {
  const i = inputs({ sellMilli: 100_000, bids: [level(580, 500_000)], bestAskMilli: null, asks: [level(330, 500_000)] });
  const q = quoted(i);
  // at 65c: we pay $65.00 + the maker's ceil(0.0175 x 100 x 0.65 x 0.35 = 39.8c) = 40c + $33.00 = $98.40 for $100;
  // the holder nets $65.00 - the taker's ceil(0.07 x 100 x 0.65 x 0.35 = 159.25c) = $1.60, which is $63.40
  assert.equal(q.bidMilli, 650);
  assert.deepEqual([q.holder.cashCents, q.holder.improvementCents, q.us.lockedCents], [6340, 711, 160]);
  // the gain is $7.11 + $1.60 - 12c = $8.59; a tenth, rounded down, is 85c
  assert.deepEqual([q.us.takeCents, q.us.tailChargeCents, q.us.residualCents, q.us.bidLimitedBy], [85, 12, 63, "our_take"]);
  assert.equal(q.us.lockedCents, q.us.takeCents + q.us.tailChargeCents + q.us.residualCents);
  // one step up, 66c, leaves $100 - $66.00 - 40c - $33.00 = 60c: less than the take and the charge
  const stepUp = betterBidAt(i, 660);
  assert.ok(typeof stepUp !== "string");
  assert.deepEqual([stepUp.lockedCents, stepUp.feasible], [60, false]);
  assert.ok(stepUp.residualCents < 0);
  // the lower fee on our bid went to the holder: priced at the taker rate the bid stops a step lower and pays them $1.02 less
  const before = quoted({ ...i, holderVenue: { ...i.holderVenue, fee: KALSHI_AT_TAKER } });
  assert.deepEqual([before.bidMilli, before.holder.cashCents, q.holder.cashCents - before.holder.cashCents], [640, 6238, 102]);
});

test("better bid: our bid stands behind the venue's own bidders at its price or better", () => {
  // 5 contracts bid at 60c, then 500 at 55c. A sale of 100 takes the 5 first whatever we bid under 60c.
  const i = inputs({ sellMilli: 100_000, bids: [level(600, 5_000), level(550, 500_000)], bestAskMilli: 600, asks: [level(330, 500_000)], tail: SAME_RULES });
  const q = quoted(i);
  // the own sale: 5 x 60c + 95 x 55c = $55.25, fees ceil(8.4c) + ceil(164.59c) = 9c + $1.65
  assert.deepEqual([q.ownSale.grossCents, q.ownSale.feeCents, q.ownSale.worstPriceMilli], [5525, 174, 550]);
  // the venue's offer is 60c, so our bid rests at 59c: 5 go to the 60c bidder, 95 to us
  assert.equal(q.bidMilli, 590);
  assert.deepEqual([q.holder.soldToVenueBidsMilli, q.holder.soldToUsMilli, q.us.boughtMilli], [5_000, 95_000, 95_000]);
  // holder: $3.00 + 95 x 59c = $59.05, fees 9c + ceil(0.07 x 95 x 0.59 x 0.41) = 9c + $1.61
  assert.deepEqual([q.holder.grossCents, q.holder.feeCents, q.holder.cashCents], [5905, 170, 5735]);
  assert.equal(q.holder.improvementCents, 5735 - (5525 - 174));
  // us: 95 x 59c = $56.05 + the maker's ceil(0.0175 x 95 x 0.59 x 0.41 = 40.2c) = 41c on the holder's venue, 95 x 33c = $31.35 on the other, $95 back
  assert.deepEqual([q.us.holderVenueCostCents, q.us.holderVenueFeeCents, q.us.otherVenueCostCents, q.us.payoutCents, q.us.lockedCents], [5605, 41, 3135, 9500, 9500 - 5605 - 41 - 3135]);
  // if the other side cannot be bought, the 95 go back into the 55c bid: the 60c bid is gone
  assert.ok(q.oneLeg.ok);
  assert.deepEqual([q.oneLeg.paidCents, q.oneLeg.soldBackGrossCents, q.oneLeg.worstPriceMilli], [5605, 5225, 550]);
});

// ---------------------------------------------------------------------------
// the identity, exhaustively
// ---------------------------------------------------------------------------

const SCHEDULES: Array<{ name: string; holder: VenueFee; other: VenueFee; holderRules: RuleCells; otherRules: RuleCells }> = [
  { name: "Kalshi / Polymarket US", holder: KALSHI, other: POLY_US, holderRules: KALSHI_RULES, otherRules: OTHER_RULES },
  { name: "Kalshi / Novig once live", holder: KALSHI, other: NOVIG_LIVE, holderRules: KALSHI_RULES, otherRules: rulesFor("novig", "nfl") },
  { name: "Kalshi / Novig before the game", holder: KALSHI, other: NOVIG_PREGAME, holderRules: KALSHI_RULES, otherRules: rulesFor("novig", "nfl") },
  { name: "Kalshi / ProphetX", holder: KALSHI, other: PROPHETX, holderRules: KALSHI_RULES, otherRules: rulesFor("prophetx", "nfl") },
  { name: "Kalshi / Polymarket", holder: KALSHI, other: POLYMARKET, holderRules: KALSHI_RULES, otherRules: OTHER_RULES },
  { name: "Kalshi / a fee-folded book", holder: KALSHI, other: FOLDED, holderRules: KALSHI_RULES, otherRules: OTHER_RULES },
  { name: "Kalshi, resting bid free / Polymarket US", holder: KALSHI_FREE, other: POLY_US, holderRules: KALSHI_RULES, otherRules: OTHER_RULES },
  { name: "Kalshi, resting bid at the taker rate / Polymarket US", holder: KALSHI_AT_TAKER, other: POLY_US, holderRules: KALSHI_RULES, otherRules: OTHER_RULES },
  { name: "Kalshi, maker multiplier 2 / Polymarket", holder: KALSHI_M2, other: POLYMARKET, holderRules: KALSHI_RULES, otherRules: OTHER_RULES },
  { name: "Polymarket US / Kalshi", holder: POLY_US, other: KALSHI, holderRules: OTHER_RULES, otherRules: KALSHI_RULES },
  { name: "Polymarket US / Novig once live", holder: POLY_US, other: NOVIG_LIVE, holderRules: OTHER_RULES, otherRules: rulesFor("novig", "nfl") },
  { name: "Polymarket US / ProphetX", holder: POLY_US, other: PROPHETX, holderRules: OTHER_RULES, otherRules: rulesFor("prophetx", "nfl") },
  { name: "Polymarket with a fee / Kalshi", holder: POLYMARKET_FEE, other: KALSHI, holderRules: OTHER_RULES, otherRules: KALSHI_RULES },
  { name: "Polymarket with a fee / Polymarket US", holder: POLYMARKET_FEE, other: POLY_US, holderRules: OTHER_RULES, otherRules: KALSHI_RULES },
];
/** a hundredth of a contract, one contract, an odd size whose fills are not whole cents, a hundred contracts */
const SIZES = [10, 1000, 7530, 100_000];

test("better bid: the identity holds to the cent on both results, every pair of prices 1 to 99 cents, every size, every fee schedule", () => {
  let quotes = 0;
  let refusals = 0;
  const codes = new Set<string>();
  for (const s of SCHEDULES) {
    let quotedHere = 0;
    for (const k of SIZES) {
      for (let v = 1; v <= 99; v++) {
        for (let w = 1; w <= 99; w++) {
          const i = inputs({
            sellMilli: k,
            positionMilli: k + 2500,
            bids: [level(v * 10)],
            asks: [level(w * 10)],
            holderFee: s.holder,
            otherFee: s.other,
            tail: { holderRules: s.holderRules, otherRules: s.otherRules, probabilities: PROBS, markCents: v },
          });
          const q = quoteBetterBid(i);
          const at = `${s.name}, ${k} milli, bid ${v}c, other side ${w}c`;
          if (!q.ok) {
            refusals += 1;
            codes.add(q.code);
            assert.ok(!PLAIN_WORDS.test(q.reason) && q.reason.length > 0, `${at}: ${q.reason}`);
            continue;
          }
          quotes += 1;
          quotedHere += 1;
          const b = q.bidMilli;
          assert.ok(b > v * 10 && b % 10 === 0 && b < 1000, at);

          // the holder: the own sale and the sale into our bid, each after the venue's taker fee, like for like
          const ownCash = down(k * v * 10) - takerFee(s.holder, k, v * 10);
          const cash = down(k * b) - takerFee(s.holder, k, b);
          assert.equal(q.ownSale.cashCents, ownCash, at);
          assert.equal(q.holder.cashCents, cash, at);
          assert.equal(q.holder.improvementCents, cash - ownCash, at);
          assert.ok(q.holder.improvementCents > 0, `${at}: better means strictly more cash after fees`);
          assert.equal(q.holder.improvementMilliCentsPerContract, Math.floor(((cash - ownCash) * 1_000_000) / k), at);

          // us, leg by leg: what we pay on each venue, and the $1 a contract that comes back on either result
          const costV = up(k * b);
          const feeV = makerFee(s.holder, k, b);
          const costW = up(k * w * 10);
          const feeW = takerFee(s.other, k, w * 10);
          const payout = k / 10;
          const atSettlement = s.other.kind === "prophetx";
          const ifLoses = payout - costV - feeV - costW - feeW;
          const ifWins = atSettlement ? ifLoses + feeW : ifLoses;
          const win = settleBetterBid(q, "side_wins");
          const lose = settleBetterBid(q, "side_loses");
          assert.equal(win.usCents, ifWins, at);
          assert.equal(lose.usCents, ifLoses, at);
          assert.deepEqual([q.us.ifSideWinsCents, q.us.ifSideLosesCents, q.us.lockedCents], [ifWins, ifLoses, ifLoses], at);
          // the same number on either result; on ProphetX the fee is taken only when its contract wins, and that is the whole difference
          assert.equal(win.usCents - lose.usCents, atSettlement ? feeW : 0, at);

          // the holder on each result: the cash, plus $1 per contract kept when their side wins
          assert.equal(lose.holderCents, cash, at);
          assert.equal(win.holderCents, cash + 250, at);
          // the venues: V its taker fee from the holder and its fee from us, W its fee from us
          assert.equal(win.holderVenueFeesCents, takerFee(s.holder, k, b) + feeV, at);
          assert.equal(lose.otherVenueFeesCents, s.other.kind === "folded" ? 0 : feeW, at);
          assert.equal(win.otherVenueFeesCents, atSettlement ? 0 : lose.otherVenueFeesCents, at);

          // what we are left with is the take, the tail charge and the named residual, nothing else
          const tail = tailCents(i, w, k);
          assert.equal(q.us.tailChargeCents, tail, at);
          const take = computeTake(Math.max(0, cash - ownCash + ifLoses - tail), k / 1000, TAKE);
          assert.equal(q.us.takeCents, take.takeCents, at);
          assert.equal(q.us.lockedCents, q.us.takeCents + q.us.tailChargeCents + q.us.residualCents, at);
          assert.ok(q.us.residualCents >= 0, at);

          // one step up is not a better quote: it leaves us short, or pays the holder no more
          if (b + 10 < 1000) {
            const stepUp = betterBidAt(i, b + 10);
            assert.ok(typeof stepUp === "string" || !stepUp.feasible || stepUp.holderCashCents <= cash, `${at}: a higher bid was available`);
          }
          assert.equal(q.us.bidLimitedBy, "our_take", at);
          // and among bids that pay the holder the same, ours is the lowest: one step down pays the holder less, or is not a quote
          const stepDown = b - 10 > v * 10 ? betterBidAt(i, b - 10) : null;
          if (stepDown && typeof stepDown !== "string" && stepDown.feasible) assert.ok(stepDown.holderCashCents < cash, at);
        }
      }
    }
    assert.ok(quotedHere > 0, `${s.name}: the grid quoted nothing`);
  }
  assert.equal(quotes + refusals, SCHEDULES.length * SIZES.length * 99 * 99);
  assert.ok(quotes > 50_000, `${quotes} quotes`);
  for (const c of codes) assert.ok(["own_sale_unpriced", "spread_closed", "no_improvement", "tail_charge_eats_it", "take_eats_it"].includes(c), c);
});

test("better bid: a refusal on the grid means no price at all would be a quote", () => {
  for (const s of [SCHEDULES[0], SCHEDULES[3], SCHEDULES[7]]) {
    for (let v = 2; v <= 98; v += 3) {
      for (let w = 2; w <= 98; w += 3) {
        const i = inputs({ sellMilli: 7530, bids: [level(v * 10)], asks: [level(w * 10)], holderFee: s.holder, otherFee: s.other, tail: { holderRules: s.holderRules, otherRules: s.otherRules, probabilities: PROBS, markCents: v } });
        const q = quoteBetterBid(i);
        let best = -1;
        for (let b = 10; b <= 990; b += 10) {
          const at = betterBidAt(i, b);
          if (typeof at !== "string" && at.feasible) best = Math.max(best, at.holderCashCents);
        }
        if (q.ok) assert.equal(q.holder.cashCents, best, `${s.name} ${v}/${w}: the quote is the most cash any price pays`);
        else assert.equal(best, -1, `${s.name} ${v}/${w}: refused as ${q.code} while a price would quote`);
      }
    }
  }
});

test("better bid: deeper books are walked level by level and agree with the house walks", () => {
  // Kalshi: the own sale against walkKalshiBids; the other side on Kalshi against walkNoAsks
  const kalshiBids = [level(610, 30_000), level(600, 45_000), level(570, 400_000)];
  const own = quoteOwnSale({ positionMilli: 200_000, sellMilli: 120_000, bids: kalshiBids, fee: KALSHI });
  const house = walkKalshiBids(kalshiBids.map((l) => ({ priceCents: l.priceMilli / 10, qtyMilli: l.sizeMilli })), 120_000);
  assert.ok(own.ok && house);
  assert.deepEqual([own.grossCents, own.feeCents, own.worstPriceMilli], [house.proceedsCents, house.feeCents, house.worstPriceCents * 10]);
  assert.deepEqual([own.cashCents, own.floorCents, own.capCents, own.keptMilli], [house.proceedsCents - house.feeCents, own.cashCents, own.cashCents + 8000, 80_000]);

  const otherAsks = [level(310, 20_000), level(320, 50_000), level(350, 400_000)];
  const onKalshi = quoted(inputs({ sellMilli: 120_000, bids: [level(550, 500_000)], asks: otherAsks, holderFee: POLY_US, otherFee: KALSHI, tail: SAME_RULES }));
  const no = walkNoAsks(otherAsks.map((l) => ({ priceCents: l.priceMilli / 10, qtyMilli: l.sizeMilli })), 120_000);
  assert.ok(no);
  assert.deepEqual([onKalshi.us.otherVenueCostCents, onKalshi.us.otherVenueFeeCents, onKalshi.otherVenue.worstPriceMilli], [no.costCents, no.feeCents, no.worstPriceCents * 10]);

  // Polymarket: the other side against walkPmAsks, cost rounded up
  const onPm = quoted(inputs({ sellMilli: 120_000, bids: [level(550, 500_000)], asks: otherAsks, otherFee: POLYMARKET, tail: SAME_RULES }));
  const pm = walkPmAsks(otherAsks, 120_000);
  assert.ok(pm);
  assert.deepEqual([onPm.us.otherVenueCostCents, onPm.otherVenue.avgPriceMilli, onPm.otherVenue.worstPriceMilli], [Math.ceil(pm.costMicroUsd / 10_000), pm.avgPriceMilli, pm.worstPriceMilli]);
  // the identity on a walked quote: both legs pay the same $120 and the three lines add up
  assert.equal(settleBetterBid(onPm, "side_wins").usCents, settleBetterBid(onPm, "side_loses").usCents);
  assert.equal(onPm.us.lockedCents, 12_000 - onPm.us.holderVenueCostCents - onPm.us.holderVenueFeeCents - onPm.us.otherVenueCostCents);
  assert.equal(onPm.us.lockedCents, onPm.us.takeCents + onPm.us.tailChargeCents + onPm.us.residualCents);
  // books handed over out of order are walked best first all the same
  const shuffled = quoted(inputs({ sellMilli: 120_000, bids: [level(550, 500_000)], asks: [otherAsks[2], otherAsks[0], otherAsks[1]], otherFee: POLYMARKET, tail: SAME_RULES }));
  assert.deepEqual(shuffled.us, onPm.us);
});

// ---------------------------------------------------------------------------
// fee schedules: who pays what, and when
// ---------------------------------------------------------------------------

test("better bid: maker and taker on each venue, as the code has the schedules", () => {
  // Kalshi: the holder pays the taker fee; our resting bid pays the maker schedule, a quarter of the taker rate
  const onKalshi = quoted(inputs({ holderFee: KALSHI, tail: SAME_RULES }));
  assert.equal(onKalshi.us.holderVenueFeeBasis, "maker_schedule");
  assert.equal(onKalshi.us.holderVenueFeeCents, kalshiMaker(100_000, onKalshi.bidMilli));
  assert.equal(onKalshi.holderVenue.feeFromHolderCents, kalshiTakerFeeCents(100_000, onKalshi.bidMilli / 10));
  assert.equal(onKalshi.holderVenue.feeFromUsCents, onKalshi.us.holderVenueFeeCents);
  // the two comparisons: the full taker rate (what the record used before the schedule was in hand) and nothing at all
  const atTaker = quoted(inputs({ holderFee: KALSHI_AT_TAKER, tail: SAME_RULES }));
  assert.deepEqual([atTaker.us.holderVenueFeeCents, atTaker.us.holderVenueFeeBasis], [kalshiTakerFeeCents(100_000, atTaker.bidMilli / 10), "taker_formula"]);
  const free = quoted(inputs({ holderFee: KALSHI_FREE, tail: SAME_RULES }));
  assert.deepEqual([free.us.holderVenueFeeCents, free.us.holderVenueFeeBasis], [0, "free_by_setting"]);
  assert.ok(onKalshi.holder.cashCents > atTaker.holder.cashCents, "a fee we do not pay is passed on in the bid");
  assert.ok(free.holder.cashCents >= onKalshi.holder.cashCents);
  // a market with a multiplier: the same formula times M
  const doubled = quoted(inputs({ holderFee: KALSHI_M2, bestAskMilli: 620, tail: SAME_RULES }));
  assert.deepEqual([doubled.bidMilli, doubled.us.holderVenueFeeCents, doubled.us.holderVenueFeeBasis], [610, 84, "maker_schedule"]);
  // a multiplier that is not a positive number is not guessed at
  const bad = quoteBetterBid(inputs({ holderFee: { kind: "kalshi", makerMultiplier: 0 }, tail: SAME_RULES }));
  assert.deepEqual([bad.ok, !bad.ok && bad.code], [false, "fee_unpriced"]);

  // the schedule itself, by hand: round up(M x 0.0175 x C x P x (1 - P)) dollars
  // 100 contracts at 50c: 0.0175 x 100 x 0.25 = $0.4375, so 44c. The taker's is 0.07 x 100 x 0.25 = $1.75: four times it
  assert.deepEqual([kalshiMakerFeeCents(100_000, 50), kalshiTakerFeeCents(100_000, 50)], [44, 175]);
  // one contract at 50c: 0.4375c, so 1c. A hundredth of a contract: still 1c, never nothing
  assert.deepEqual([kalshiMakerFeeCents(1000, 50), kalshiMakerFeeCents(10, 50)], [1, 1]);
  // 100 at 61c: 0.0175 x 100 x 0.61 x 0.39 = 41.6c, so 42c; 400 at 20c: 0.0175 x 400 x 0.2 x 0.8 = $1.12 exactly, no rounding
  assert.deepEqual([kalshiMakerFeeCents(100_000, 61), kalshiMakerFeeCents(400_000, 20)], [42, 112]);
  // the multiplier: M = 2 doubles the fee before the rounding, M = 0.5 halves it (43.75c x 2 = 87.5c, so 88c; 21.875c, so 22c)
  assert.deepEqual([kalshiMakerFeeCents(100_000, 50, 2), kalshiMakerFeeCents(100_000, 50, 0.5)], [88, 22]);
  // nothing at a price that cannot trade or on no size; a multiplier that is not positive is an error, not a free fee
  assert.deepEqual([kalshiMakerFeeCents(100_000, 0), kalshiMakerFeeCents(100_000, 100), kalshiMakerFeeCents(0, 50)], [0, 0, 0]);
  assert.throws(() => kalshiMakerFeeCents(100_000, 50, 0), /multiplier/);
  assert.throws(() => kalshiMakerFeeCents(100_000, 50, Number.NaN), /multiplier/);
  // never under the venue's figure and never a cent more than the round-up: every whole-cent price, several sizes
  for (const size of [10, 1000, 7530, 100_000, 2_500_000]) {
    for (let p = 1; p <= 99; p++) {
      const exactCents = (1.75 * size * p * (100 - p)) / 10_000_000;
      const fee = kalshiMakerFeeCents(size, p);
      assert.ok(fee >= exactCents - 1e-9 && fee < exactCents + 1, `${size} at ${p}c: ${fee} against ${exactCents}`);
      assert.ok(fee <= kalshiTakerFeeCents(size, p), `${size} at ${p}c: the maker's is never over the taker's`);
    }
  }
  // a size no float product holds exactly: 50,000,000 contracts at 50c is $218,750.00
  assert.equal(kalshiMakerFeeCents(50_000_000_000, 50), 21_875_000);

  // Polymarket US: the fee is the taker's; the holder pays it, our resting bid pays nothing
  const onPolyUs = quoted(inputs({ holderFee: POLY_US, tail: SAME_RULES }));
  assert.deepEqual([onPolyUs.us.holderVenueFeeCents, onPolyUs.us.holderVenueFeeBasis], [0, "taker_only_schedule"]);
  assert.equal(onPolyUs.holder.feeCents, up(100_000 * polyUsFeeMilli(POLY_US_DEFAULT_COEFFICIENT, onPolyUs.bidMilli)));

  // Polymarket: one configured rate, charged to our resting bid and to a taker alike
  const onPm = quoted(inputs({ holderFee: POLYMARKET_FEE, tail: SAME_RULES }));
  assert.equal(onPm.us.holderVenueFeeBasis, "config_rate");
  assert.equal(onPm.us.holderVenueFeeCents, 2 + Math.ceil((onPm.us.holderVenueCostCents * 50) / 10_000));

  // the other side: we are the taker. Novig charges a game market only once it is live.
  const live = quoted(inputs({ otherFee: NOVIG_LIVE, tail: SAME_RULES }));
  const pregame = quoted(inputs({ otherFee: NOVIG_PREGAME, tail: SAME_RULES }));
  assert.equal(live.us.otherVenueFeeCents, up(100_000 * signedFeeMilli(0.06, 330)));
  assert.equal(pregame.us.otherVenueFeeCents, 0);
  assert.deepEqual([live.us.otherVenueFeeTiming, pregame.us.otherVenueFeeTiming], ["at_trade", "at_trade"]);

  // a fee-folded book: the fee is inside the price and cannot be shown apart
  const folded = quoted(inputs({ otherFee: FOLDED, tail: SAME_RULES }));
  assert.deepEqual([folded.us.otherVenueFeeCents, folded.us.otherVenueFeeTiming], [0, "inside_price"]);
});

test("better bid: on ProphetX the fee is taken only if its contract wins, priced as always paid, and the difference is said", () => {
  const q = quoted(inputs({ otherFee: PROPHETX, tail: SAME_RULES }));
  // 100 of the other side at 33c: $33.00 staked, 2% of the $67.00 it would gain = $1.34
  assert.deepEqual([q.us.otherVenueCostCents, q.us.otherVenueFeeCents, q.us.otherVenueFeeTiming], [3300, 134, "at_settlement_if_it_wins"]);
  assert.equal(q.us.otherVenueCostCents + q.us.otherVenueFeeCents, buyCostCents({ sharesMilli: 100_000, stakeCents: 3300, feesCents: 0 }, DEFAULT_PROPHETX_FEE_BPS));
  assert.equal(q.us.ifSideWinsCents - q.us.ifSideLosesCents, 134);
  assert.equal(q.us.lockedCents, q.us.ifSideLosesCents);
  assert.equal(settleBetterBid(q, "side_wins").otherVenueFeesCents, 0);
  assert.equal(settleBetterBid(q, "side_loses").otherVenueFeesCents, 134);
  // an NHL game: 3.5% x $33.00 x 0.67 = 77.4c -> 78c, paid at the trade whoever wins
  const nhl = quoted(inputs({ otherFee: { kind: "prophetx", feeBps: 0, tradeBps: 350 }, tail: SAME_RULES }));
  assert.deepEqual([nhl.us.otherVenueCostCents, nhl.us.otherVenueFeeCents, nhl.us.otherVenueFeeTiming], [3300, 78, "at_trade"]);
  assert.equal(nhl.us.ifSideWinsCents, nhl.us.ifSideLosesCents);
  assert.equal(settleBetterBid(nhl, "side_wins").otherVenueFeesCents, 78);
  // the bid was set against the lower figure, so the take and the charge are covered on either result
  assert.ok(q.us.ifSideLosesCents >= q.us.takeCents + q.us.tailChargeCents);
});

// ---------------------------------------------------------------------------
// refusals
// ---------------------------------------------------------------------------

test("better bid: every refusal is typed and says why in plain words", () => {
  const code = (i: BetterBidInputs) => {
    const q = quoteBetterBid(i);
    assert.ok(!q.ok, JSON.stringify(q));
    assert.ok(q.reason.length > 20 && !PLAIN_WORDS.test(q.reason), q.reason);
    return q;
  };

  // sizes
  assert.equal(code(inputs({ sellMilli: 0 })).code, "size_invalid");
  assert.equal(code(inputs({ sellMilli: 1005 })).code, "size_invalid");
  assert.equal(code(inputs({ sellMilli: 100_000, positionMilli: 50_000 })).code, "size_invalid");

  // venues where the shape does not exist or cannot be priced
  assert.equal(code(inputs({ holderFee: NOVIG_LIVE })).code, "holder_venue_cannot_sell");
  assert.equal(code(inputs({ holderFee: PROPHETX })).code, "holder_venue_cannot_sell");
  assert.equal(code(inputs({ holderFee: { kind: "stx" } })).code, "fee_unpriced");
  assert.equal(code(inputs({ holderFee: FOLDED })).code, "fee_unpriced");
  assert.equal(code(inputs({ otherFee: { kind: "stx" } })).code, "fee_unpriced");
  // Kalshi's fee function takes whole cents: a half-cent bid or step is refused, not rounded
  assert.equal(code(inputs({ bids: [level(585)] })).code, "fee_unpriced");
  assert.equal(code(inputs({ tickMilli: 5 })).code, "fee_unpriced");

  // the own sale has to exist to be improved on
  const empty = code(inputs({ bids: [] }));
  assert.deepEqual([empty.code, empty.ownSale, empty.available.holderVenueBidMilli], ["own_sale_unpriced", null, 0]);
  const thin = code(inputs({ bids: [level(580, 40_000)] }));
  assert.equal(thin.code, "own_sale_unpriced");
  assert.match(thin.reason, /hold 40 contracts; the size asked is 100 contracts/);

  // the venue's offer is one step over its bid: nowhere for a bid to rest
  const closed = code(inputs({ bids: [level(580)], bestAskMilli: 590 }));
  assert.equal(closed.code, "spread_closed");
  assert.equal(closed.ownSale?.cashCents, 5629);

  // the other side
  assert.equal(code(inputs({ asks: [] })).code, "other_side_empty");
  const short = code(inputs({ asks: [level(330, 60_000)] }));
  assert.deepEqual([short.code, short.available.otherVenueAskMilli], ["other_side_too_thin", 60_000]);
  assert.match(short.reason, /hold 60 contracts/);
  assert.equal(code(inputs({ sellMilli: 3000, otherMin: 5000 })).code, "below_minimum_size");
  assert.equal(code(inputs({ sellMilli: 3000, holderMin: 5000 })).code, "below_minimum_size");

  // the prices: 58c and 42c make $1 before any fee
  assert.equal(code(inputs({ asks: [level(420)] })).code, "no_improvement");
  // 58c and 41c leave 1c a contract: a bid one step up at 59c leaves nothing, and the 43c fee on our resting bid makes it a loss
  assert.equal(code(inputs({ asks: [level(410)] })).code, "no_improvement");
  // 58c and 40.5c leave room after fees (7c on 100 contracts at a 59c bid: $100 - $59.00 - 43c - $40.50), less than the tail charge and our minimum take together
  assert.equal(code(inputs({ asks: [level(405)] })).code, "take_eats_it");
  // 58c and 40c quote: 57c is left at a 59c bid, which covers the 7c charge and the 25c minimum take, and the holder nets $1.01 more
  const thinQuote = quoted(inputs({ asks: [level(400)] }));
  assert.deepEqual([thinQuote.bidMilli, thinQuote.us.lockedCents, thinQuote.us.takeCents, thinQuote.us.take.takeRule, thinQuote.holder.improvementCents], [590, 57, 25, "minimum", 101]);

  // room before the tail charge, none after: a venue pair that splits on ties in a league that ties often
  const tieProne: TailProbabilities = { tie: 0.2, postponed: 0, abandoned: 0, corrected: 0 };
  // a 59c bid against 40c leaves $1.00 on 100 contracts; a tie pays 50c on one venue and the 40c back on the other, 10c short, one game in five
  const eaten = inputs({ holderFee: POLY_US, bids: [level(580)], asks: [level(400)], tail: { holderRules: KALSHI_RULES, otherRules: rulesFor("prophetx", "nfl"), probabilities: tieProne, markCents: 60 } });
  assert.equal(code(eaten).code, "tail_charge_eats_it");
  assert.ok(quoteBetterBid({ ...eaten, tail: SAME_RULES }).ok, "the same books quote when the venues settle alike");

  // room after fees and the charge, less than our minimum take: a tenth of a cent a contract on a fine grid
  const fine = inputs({ holderFee: POLYMARKET, tickMilli: 1, bids: [level(580)], asks: [level(418)], tail: SAME_RULES });
  assert.equal(code(fine).code, "take_eats_it");
  assert.ok(quoteBetterBid({ ...fine, take: { takeBps: 1000, minTakeBpsOfStake: 0, deMinimisTakeCents: 5 } }).ok, "the same books quote without the minimum take");
});

test("better bid: reported as better only when the holder's cash after fees is strictly more", () => {
  // Kalshi's fee rises with the price below 50c: at a hundredth of a contract a higher bid can net the holder nothing more
  for (let v = 1; v <= 60; v++) {
    const i = inputs({ sellMilli: 10, positionMilli: 1000, bids: [level(v * 10)], asks: [level(100)], tail: SAME_RULES });
    const q = quoteBetterBid(i);
    if (q.ok) assert.ok(q.holder.cashCents > q.ownSale.cashCents);
    for (let b = v * 10 + 10; b <= 890; b += 10) {
      const at = betterBidAt(i, b);
      if (typeof at !== "string" && at.improvementCents <= 0) assert.equal(at.feasible, false, `bid ${b} pays no more than the own sale and is not a quote`);
    }
  }
  // a higher price that only feeds the venue's fee is never chosen over a lower one that pays the holder the same
  const q = quoted(inputs({ sellMilli: 100, positionMilli: 1000, bids: [level(300)], asks: [level(100)], tail: SAME_RULES }));
  const lower = betterBidAt(inputs({ sellMilli: 100, positionMilli: 1000, bids: [level(300)], asks: [level(100)], tail: SAME_RULES }), q.bidMilli - 10);
  assert.ok(typeof lower === "string" || !lower.feasible || lower.holderCashCents < q.holder.cashCents);
});

// ---------------------------------------------------------------------------
// rounding
// ---------------------------------------------------------------------------

test("better bid: every rounding goes against the figure it sits in, and none is hidden", () => {
  // 7.53 contracts at 61c is $4.5933: the holder's proceeds are floored, our cost of the same fill is rounded up
  const i = inputs({ sellMilli: 7530, positionMilli: 10_000, bids: [level(580)], bestAskMilli: 620, asks: [level(333)], tail: SAME_RULES, holderFee: POLY_US });
  const q = quoted(i);
  assert.equal(q.bidMilli, 610);
  assert.deepEqual([q.holder.grossCents, q.us.holderVenueCostCents], [459, 460]);
  // 7.53 x 33.3c = $2.50749: rounded up
  assert.equal(q.us.otherVenueCostCents, 251);
  // the payout is exact: 7.53 contracts pay $7.53
  assert.equal(q.us.payoutCents, 753);
  assert.equal(q.us.lockedCents, 753 - 460 - 251);
  // the holder's fee is the venue's own rounding: up
  assert.equal(q.holder.feeCents, Math.ceil((7530 * polyUsFeeMilli(POLY_US_DEFAULT_COEFFICIENT, 610)) / 10_000));
  // per contract, the improvement is rounded down
  assert.equal(q.holder.improvementMilliCentsPerContract, Math.floor((q.holder.improvementCents * 1_000_000) / 7530));
  assert.ok((q.holder.improvementMilliCentsPerContract * 7530) / 1_000_000 <= q.holder.improvementCents);

  // the tail charge is rounded up: 0.111c a contract on 7.53 contracts is 0.84c, reserved as 1c
  const charged = quoted({ ...i, tail: { holderRules: KALSHI_RULES, otherRules: OTHER_RULES, probabilities: PROBS, markCents: 60 } });
  const perContract = charged.tail.chargeCentsPerContract;
  assert.ok(perContract > 0 && perContract * 7.53 < 1);
  assert.equal(charged.us.tailChargeCents, 1);

  // the take is computeTake's own: the share down, the minimum up
  const big = quoted(inputs({ sellMilli: 100_000, bids: [level(580)], bestAskMilli: 620, asks: [level(330)], tail: SAME_RULES }));
  assert.equal(big.us.take.takeShareCents, Math.floor(((big.holder.improvementCents + big.us.lockedCents - big.us.tailChargeCents) * TAKE.takeBps) / 10_000));
  assert.equal(big.us.take.takeMinimumCents, 25);

  // whatever the grid or the venue's offer kept from the holder is on its own line, to the cent
  for (const quote of [q, charged, big]) {
    assert.equal(quote.us.residualCents, quote.us.lockedCents - quote.us.takeCents - quote.us.tailChargeCents);
    assert.ok(quote.us.residualCents >= 0);
  }

  // across sizes whose fills are not whole cents: our cost never under the holder's proceeds, and never over by more than a cent
  for (const k of [10, 70, 990, 1230, 7530, 33_330]) {
    for (let v = 5; v <= 85; v += 7) {
      const r = quoteBetterBid(inputs({ sellMilli: k, positionMilli: 50_000, bids: [level(v * 10)], asks: [level(50)], holderFee: POLY_US, tail: SAME_RULES }));
      if (!r.ok) continue;
      const gap = r.us.holderVenueCostCents - r.holder.grossCents;
      assert.ok(gap === 0 || gap === 1, `${k} at ${v}c: ${gap}`);
      assert.equal(gap, (k * r.bidMilli) % 10_000 === 0 ? 0 : 1);
    }
  }
});

// ---------------------------------------------------------------------------
// the one-leg case
// ---------------------------------------------------------------------------

test("one-leg loss: the first leg sold back into the venue's bid costs the price difference plus both fees", () => {
  // our 61c bid was hit for 100; the other side cannot be bought; Kalshi's bids under us start at 58c
  const loss = oneLegLoss({ boughtMilli: 100_000, bidMilli: 610, bids: [level(580, 500_000)], fee: KALSHI });
  assert.ok(loss.ok);
  // in at the maker's 42c, out at the taker's $1.71
  assert.deepEqual(loss, { ok: true, paidCents: 6100, paidFeeCents: 42, soldBackGrossCents: 5800, soldBackFeeCents: 171, priceGapCents: 300, lossCents: 300 + 42 + 171, worstPriceMilli: 580 });

  // bids at our price or better are gone: the holder's sale took them before it reached ours
  const behind = oneLegLoss({ boughtMilli: 95_000, bidMilli: 590, bids: [level(600, 5_000), level(590, 20_000), level(550, 60_000), level(540, 500_000)], fee: KALSHI });
  assert.ok(behind.ok);
  // 60 at 55c and 35 at 54c = $51.90; fees ceil(0.07 x 60 x 0.55 x 0.45) + ceil(0.07 x 35 x 0.54 x 0.46) = $1.04 + 61c
  assert.deepEqual([behind.soldBackGrossCents, behind.soldBackFeeCents, behind.worstPriceMilli], [5190, 104 + 61, 540]);
  assert.equal(behind.lossCents, behind.priceGapCents + behind.paidFeeCents + behind.soldBackFeeCents);

  // Polymarket US: our resting bid paid no fee, the sale back pays the taker's
  const polyUs = oneLegLoss({ boughtMilli: 100_000, bidMilli: 610, bids: [level(580, 500_000)], fee: POLY_US });
  assert.ok(polyUs.ok);
  assert.deepEqual([polyUs.paidFeeCents, polyUs.soldBackFeeCents], [0, up(100_000 * polyUsFeeMilli(POLY_US_DEFAULT_COEFFICIENT, 580))]);
  assert.equal(polyUs.lossCents, 300 + polyUs.soldBackFeeCents);

  // the quote carries the same figure for its own bid
  const q = quoted(inputs({ sellMilli: 100_000, bids: [level(580, 500_000)], bestAskMilli: 620, asks: [level(330, 500_000)] }));
  assert.deepEqual(q.oneLeg, loss);

  // over the grid: the loss is never under the price difference plus both fees, and never negative
  for (let v = 1; v <= 98; v++) {
    for (let b = v + 1; b <= 99; b++) {
      const l = oneLegLoss({ boughtMilli: 7530, bidMilli: b * 10, bids: [level(v * 10)], fee: KALSHI });
      assert.ok(l.ok);
      assert.equal(l.lossCents, up(7530 * b * 10) - down(7530 * v * 10) + kalshiMaker(7530, b * 10) + kalshiTakerFeeCents(7530, v));
      assert.ok(l.lossCents >= l.priceGapCents && l.priceGapCents >= 0);
    }
  }

  // no bid under ours, or too little of it: the loss has no bound on this book, and the answer says so
  const none = oneLegLoss({ boughtMilli: 100_000, bidMilli: 610, bids: [level(610, 500_000)], fee: KALSHI });
  assert.deepEqual([none.ok, !none.ok && none.code, !none.ok && none.depthUnderBidMilli], [false, "unwind_book_empty", 0]);
  const little = oneLegLoss({ boughtMilli: 100_000, bidMilli: 610, bids: [level(580, 40_000)], fee: KALSHI });
  assert.deepEqual([little.ok, !little.ok && little.code, !little.ok && little.depthUnderBidMilli], [false, "unwind_book_too_thin", 40_000]);
  const thinQuote = quoted(inputs({ sellMilli: 100_000, bids: [level(580, 100_000)], bestAskMilli: 620, asks: [level(330, 500_000)] }));
  assert.ok(thinQuote.oneLeg.ok, "the 58c bid the holder did not hit is still there to sell back into");
  for (const r of [none, little]) assert.ok(!r.ok && !PLAIN_WORDS.test(r.reason));
  assert.equal((oneLegLoss({ boughtMilli: 100_000, bidMilli: 610, bids: [level(580)], fee: NOVIG_LIVE }) as { code: string }).code, "holder_venue_cannot_sell");
  assert.equal((oneLegLoss({ boughtMilli: 0, bidMilli: 610, bids: [level(580)], fee: KALSHI }) as { code: string }).code, "size_invalid");
});

// ---------------------------------------------------------------------------
// early exit
// ---------------------------------------------------------------------------

test("early exit: the holder buys back on the venue's offers; we sell both legs into the two venues' bids", () => {
  // the holder sold 100 into our 61c bid for $59.33 after the fee; buying back at 62c and 63c
  const back = quoteHolderBuyBack({ buyMilli: 100_000, asks: [level(620, 60_000), level(630, 500_000)], fee: KALSHI });
  assert.ok(back.ok);
  // 60 x 62c + 40 x 63c = $62.40; fees ceil(0.07 x 60 x 0.62 x 0.38) + ceil(0.07 x 40 x 0.63 x 0.37) = 99c + 66c
  assert.deepEqual([back.costCents, back.feeCents, back.totalCents, back.worstPriceMilli], [6240, 99 + 66, 6405, 630]);
  // the round trip cost the holder what they paid to come back less what the sale paid them
  assert.equal(back.totalCents - 5933, 472);
  assert.equal((quoteHolderBuyBack({ buyMilli: 100_000, asks: [level(620, 60_000)], fee: KALSHI }) as { code: string }).code, "book_too_thin");
  assert.equal((quoteHolderBuyBack({ buyMilli: 100_000, asks: [], fee: KALSHI }) as { code: string }).code, "book_empty");
  assert.equal((quoteHolderBuyBack({ buyMilli: 100_000, asks: [level(620)], fee: PROPHETX }) as { code: string }).code, "holder_venue_cannot_sell");

  // us: 100 sold into Kalshi's 58c bid and 100 of the other side into Polymarket US's 31c bid
  const out = quoteUnwind({ milli: 100_000, holderVenue: { bids: [level(580, 500_000)], fee: KALSHI }, otherVenue: { bids: [level(310, 500_000)], fee: POLY_US } });
  assert.ok(out.ok);
  const polyUsFee = up(100_000 * polyUsFeeMilli(POLY_US_DEFAULT_COEFFICIENT, 310));
  assert.deepEqual([out.holderVenueNetCents, out.holderVenueFeeCents, out.otherVenueNetCents, out.otherVenueFeeCents], [5800 - 171, 171, 3100 - polyUsFee, polyUsFee]);
  assert.equal(out.proceedsCents, 5629 + 3100 - polyUsFee);
  // holding pays $100 at the game on either result; leaving early gives up the difference
  assert.deepEqual([out.payoutCents, out.costAgainstHoldingCents], [10_000, 10_000 - out.proceedsCents]);

  // a venue with no sell: nothing to do early, and the answer says why that is not a loss
  const noSell = quoteUnwind({ milli: 100_000, holderVenue: { bids: [level(580)], fee: KALSHI }, otherVenue: { bids: [level(310)], fee: PROPHETX } });
  assert.ok(!noSell.ok);
  assert.equal(noSell.code, "venue_cannot_sell");
  assert.match(noSell.reason, /already pay \$1 between them/);
  assert.ok(!PLAIN_WORDS.test(noSell.reason));
  assert.equal((quoteUnwind({ milli: 100_000, holderVenue: { bids: [], fee: KALSHI }, otherVenue: { bids: [level(310)], fee: POLY_US } }) as { code: string }).code, "book_empty");
  assert.equal((quoteUnwind({ milli: 100_000, holderVenue: { bids: [level(580)], fee: KALSHI }, otherVenue: { bids: [level(310, 5_000)], fee: POLY_US } }) as { code: string }).code, "book_too_thin");
});

// ---------------------------------------------------------------------------
// the own sale
// ---------------------------------------------------------------------------

test("own sale: cash now is the floor, cash plus $1 per contract kept is the cap, and a sale that nets nothing is refused", () => {
  const q = quoteOwnSale({ positionMilli: 150_000, sellMilli: 90_000, bids: [level(580, 500_000)], fee: POLY_US });
  assert.ok(q.ok);
  const fee = up(90_000 * polyUsFeeMilli(POLY_US_DEFAULT_COEFFICIENT, 580));
  assert.deepEqual([q.grossCents, q.feeCents, q.cashCents, q.floorCents, q.capCents, q.keptMilli], [5220, fee, 5220 - fee, 5220 - fee, 5220 - fee + 6000, 60_000]);
  // one contract at 1c on Kalshi: the fee rounds up to the whole cent the sale fetches
  const nothing = quoteOwnSale({ positionMilli: 1000, sellMilli: 1000, bids: [level(10)], fee: KALSHI });
  assert.deepEqual([nothing.ok, !nothing.ok && nothing.code], [false, "nothing_after_fees"]);
  assert.equal((quoteOwnSale({ positionMilli: 1000, sellMilli: 1000, bids: [], fee: KALSHI }) as { code: string }).code, "book_empty");
  assert.equal((quoteOwnSale({ positionMilli: 1000, sellMilli: 2000, bids: [level(500)], fee: KALSHI }) as { code: string }).code, "size_invalid");
  assert.equal((quoteOwnSale({ positionMilli: 1000, sellMilli: 1000, bids: [level(500)], fee: PROPHETX }) as { code: string }).code, "holder_venue_cannot_sell");
});
