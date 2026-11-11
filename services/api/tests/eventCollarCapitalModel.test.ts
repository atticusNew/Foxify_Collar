/**
 * The capital model (capitalModel.ts): what each settlement shape ties up, worked by hand on a
 * small record. The expected figures are written out here from each line's own terms and times.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { quoteBetterBid, type BetterBidInputs, type VenueFee } from "../src/eventCollar/crossVenue/betterBid";
import { CAPITAL_LAG_HOURS, CAPITAL_MULTIPLES, capitalModel, tiedUp, type CapitalStretch } from "../src/eventCollar/crossVenue/capitalModel";
import { rulesFor, tailProbabilities } from "../src/eventCollar/crossVenue/hedgeRouting";
import { DEFAULT_PROPHETX_FEE_BPS } from "../src/eventCollar/crossVenue/prophetxOrders";
import type { ShadowPosition } from "../src/eventCollar/crossVenue/shadowLedger";
import { DEFAULT_CROSS_CONFIG } from "../src/eventCollar/crossVenue/types";

const T = (day: number, hour: number): string => new Date(Date.UTC(2026, 9, day, hour)).toISOString();
const H = 3_600_000;
const at = (hours: number): number => Date.parse(T(1, 0)) + hours * H;
const NOW = new Date(T(3, 0));

function line(o: Partial<ShadowPosition> & Pick<ShadowPosition, "ticker" | "at" | "status" | "contracts" | "floorCents" | "capCents" | "creditCents" | "takeCents">): ShadowPosition {
  return {
    kind: "sports",
    league: "nfl",
    sideName: "Side",
    eventTitle: "A at B",
    eventTimeIso: o.at,
    markCents: 60,
    evCostBps: 0,
    route: "polymarket",
    feesCents: 0,
    ...o,
  } as ShadowPosition;
}

const sale = (betterBid: unknown): ShadowPosition["counterfactuals"] => ({ sale: { betterBid } }) as unknown as ShadowPosition["counterfactuals"];

/**
 * A  100 contracts, floor 40, cap 80, credit $1.00, take 50c, hedge 60 contracts.
 *    cap slice 20c x 100 = $20.00; hedge cost 2000 - 100 - 50 = $18.50; collar ties 1850 + 100 = $19.50.
 *    Better bid ceiling: 60 contracts at $1 = $60.00. Measured: $60.00 - $1.20 left if the side wins = $58.80.
 *    Opens day 1 00:00, starts 18:00, settles 21:00.
 * B  50 contracts, floor 50, cap 90, credit 20c, take 30c, hedge 30 contracts, on another route.
 *    cap slice $5.00; hedge cost 500 - 20 - 30 = $4.50; collar ties $4.70. Ceiling $30.00.
 *    Opens day 1 12:00, starts day 2 00:00, settles day 2 03:00. Measured, and no better bid found.
 * C  10 contracts, floor 30, cap 70, credit 5c, take 5c, no hedge size on the line (an old record):
 *    hedge = (30 + 100 - 70) x 10 / 100 = 6 contracts. cap slice $3.00; hedge cost $2.90; collar ties $2.95.
 *    Ceiling $6.00. Opens day 2 02:00 and is still open.
 * F  20 contracts, floor 40, cap 80, credit 10c, take 10c, old record: hedge 12 contracts.
 *    cap slice $4.00; hedge cost $3.80; collar ties $3.90. Ceiling $12.00.
 *    Opens day 1 06:00, the holder leaves at 08:00, the game starts 20:00. Settled lines took 3h from
 *    the start (A and B), so the pair is held until 23:00.
 * V  voided. M  a member's own sale. Neither is counted.
 */
const RECORD: ShadowPosition[] = [
  line({ ticker: "A", at: T(1, 0), eventTimeIso: T(1, 18), status: "settled", settledAt: T(1, 21), contracts: 100, floorCents: 40, capCents: 80, creditCents: 100, takeCents: 50, hedgeUnitsMilli: 60_000, counterfactuals: sale({ ok: true, boughtMilli: 60_000, ifSideWinsCents: 120, takeCents: 40 }) }),
  line({ ticker: "B", at: T(1, 12), eventTimeIso: T(2, 0), status: "settled", settledAt: T(2, 3), contracts: 50, floorCents: 50, capCents: 90, creditCents: 20, takeCents: 30, hedgeUnitsMilli: 30_000, route: "prophetx", counterfactuals: sale({ ok: false, refused: "no_venue_improves" }) }),
  line({ ticker: "C", at: T(2, 2), eventTimeIso: T(4, 0), status: "open", contracts: 10, floorCents: 30, capCents: 70, creditCents: 5, takeCents: 5 }),
  line({ ticker: "F", at: T(1, 6), eventTimeIso: T(1, 20), status: "closed", closedAt: T(1, 8), contracts: 20, floorCents: 40, capCents: 80, creditCents: 10, takeCents: 10 }),
  line({ ticker: "V", at: T(1, 1), status: "void", contracts: 500, floorCents: 40, capCents: 80, creditCents: 100, takeCents: 50 }),
  line({ ticker: "M", at: T(1, 2), status: "settled", settledAt: T(1, 21), contracts: 500, floorCents: 40, capCents: 80, creditCents: 0, takeCents: 0, route: "member_sale" }),
];

test("capital model: which lines count, and since when", () => {
  const m = capitalModel(RECORD, NOW);
  assert.deepEqual(m.record, { lines: 6, voided: 1, memberSales: 1, counted: 4, since: T(1, 0), days: 2 });
  assert.deepEqual(m.ownSale, { peakCents: 0, lines: 4 });
  assert.equal(m.medianStartToSettleMinutes, 180);
  assert.equal(m.at, NOW.toISOString());
});

test("capital model, collar: the hedge and the credit are out from lock in until the line settles or the holder leaves", () => {
  const c = capitalModel(RECORD, NOW).collar;
  assert.deepEqual([c.lines, c.open, c.endEstimated, c.outlayCents, c.takeCents], [4, 1, 0, 1950 + 470 + 295 + 390, 95]);
  // out for 21h (A), 15h (B) and 2h (F): the middle one
  assert.equal(c.medianMinutesHeld, 15 * 60);

  const [noLag, oneDay] = c.byLag;
  assert.deepEqual([noLag.lagHours, oneDay.lagHours], [0, 24]);
  // 00:00 A 1950 · 06:00 +F 2340 · 08:00 F back 1950 · 12:00 +B 2420 · 21:00 A back 470 · day 2 02:00 +C 765 · 03:00 B back 295
  assert.deepEqual([noLag.peakCents, noLag.peakAt, noLag.nowCents], [2420, T(1, 12), 295]);
  // cents x hours: 1950x6 + 2340x2 + 1950x4 + 2420x9 + 470x5 + 765x1 + 295x21 = 55,270 over 48 hours
  assert.equal(noLag.averageCents, Math.floor(55_270 / 48));
  assert.deepEqual(noLag.atMultiple, [
    { multiple: 1, peakCents: 2420, averageCents: 1151 },
    { multiple: 10, peakCents: 24_200, averageCents: 11_510 },
    { multiple: 100, peakCents: 242_000, averageCents: 115_100 },
  ]);
  // a day's lag: F back day 2 08:00, A back day 2 21:00, B not back by now. All four are out together at day 2 02:00.
  assert.deepEqual([oneDay.peakCents, oneDay.peakAt, oneDay.nowCents], [1950 + 390 + 470 + 295, T(2, 2), 470 + 295]);

  // per route: one venue holds A, F and C (peak with A and F together), the other holds B. Funding each for its own peak takes more than the pool.
  assert.deepEqual(c.byRoute, [
    { route: "polymarket", lines: 3, peakCents: 2340 },
    { route: "prophetx", lines: 1, peakCents: 470 },
  ]);
  assert.equal(c.sumOfRoutePeaksCents, 2810);
  assert.ok(c.sumOfRoutePeaksCents > noLag.peakCents);
});

test("capital model, better bid ceiling: $1 for each contract sold, held to settlement; a line left early is held to the game's likely settlement", () => {
  const b = capitalModel(RECORD, NOW).betterBid.ceiling;
  assert.deepEqual([b.lines, b.open, b.endEstimated, b.outlayCents, b.takeCents], [4, 1, 1, 6000 + 3000 + 600 + 1200, 0]);
  // out for 21h (A), 15h (B) and 17h (F, 06:00 to 23:00)
  assert.equal(b.medianMinutesHeld, 17 * 60);
  const [noLag] = b.byLag;
  // 00:00 A 6000 · 06:00 +F 7200 · 12:00 +B 10200 · 21:00 A back 4200 · 23:00 F back 3000 · day 2 02:00 +C 3600 · 03:00 B back 600
  assert.deepEqual([noLag.peakCents, noLag.peakAt, noLag.nowCents], [10_200, T(1, 12), 600]);
  assert.equal(noLag.atMultiple[2].peakCents, 1_020_000);
});

test("capital model, better bid measured: only lines where one was found, at what it would have paid", () => {
  const m = capitalModel(RECORD, NOW).betterBid;
  assert.equal(m.linesMeasured, 2);
  assert.deepEqual([m.measured.lines, m.measured.outlayCents, m.measured.takeCents, m.measured.open], [1, 5880, 40, 0]);
  assert.deepEqual([m.measured.byLag[0].peakCents, m.measured.byLag[0].nowCents], [5880, 0]);
  // never above the ceiling on the same line
  assert.ok(m.measured.byLag[0].peakCents <= 6000);
});

test("capital model: what a measured line counts is the cash a real better bid pays at the two venues, and it is never more than $1 a pair", () => {
  const KALSHI: VenueFee = { kind: "kalshi" };
  const rules = rulesFor("kalshi", "nfl");
  const base = (other: VenueFee): BetterBidInputs => ({
    positionMilli: 150_000,
    sellMilli: 100_000,
    holderVenue: { bids: [{ priceMilli: 580, sizeMilli: 10_000_000 }], bestAskMilli: null, tickMilli: 10, fee: KALSHI },
    otherVenue: { asks: [{ priceMilli: 330, sizeMilli: 10_000_000 }], fee: other },
    tail: { holderRules: rules, otherRules: rules, probabilities: tailProbabilities("nfl"), markCents: 60 },
    take: DEFAULT_CROSS_CONFIG,
  });
  for (const other of [{ kind: "polymarket", feeBps: 0, flatCents: 0 }, { kind: "prophetx", feeBps: DEFAULT_PROPHETX_FEE_BPS }] as VenueFee[]) {
    const q = quoteBetterBid(base(other));
    assert.ok(q.ok, JSON.stringify(q));
    const paidAtTheVenues = q.us.holderVenueCostCents + q.us.holderVenueFeeCents + q.us.otherVenueCostCents + (q.us.otherVenueFeeTiming === "at_settlement_if_it_wins" ? 0 : q.us.otherVenueFeeCents);
    const counted = Math.floor(q.us.boughtMilli / 10) - q.us.ifSideWinsCents;
    assert.equal(counted, paidAtTheVenues, other.kind);
    assert.ok(counted <= Math.floor(q.us.boughtMilli / 10), other.kind);
  }
});

test("tied up: money going out is counted before money coming back at the same instant; a lag never ends a line before it began", () => {
  const backToBack: CapitalStretch[] = [
    { fromMs: at(0), untilMs: at(10), cents: 100 },
    { fromMs: at(10), untilMs: at(20), cents: 100 },
  ];
  const f = tiedUp(backToBack, at(30), 0);
  assert.deepEqual([f.peakCents, f.peakAt, f.nowCents], [200, new Date(at(10)).toISOString(), 0]);
  // 100 x 20 hours over 30
  assert.equal(f.averageCents, 66);

  // an end recorded before the start (a clock that disagrees) is out for no time, not a negative one
  const odd = tiedUp([{ fromMs: at(5), untilMs: at(4), cents: 100 }], at(30), 0);
  assert.deepEqual([odd.peakCents, odd.nowCents, odd.averageCents], [100, 0, 0]);
});

test("tied up: nothing in is nothing out; lines not yet open, and lines with nothing paid, are left out", () => {
  const empty = tiedUp([], at(10), 0);
  assert.deepEqual([empty.peakCents, empty.peakAt, empty.nowCents, empty.averageCents], [0, null, 0, 0]);
  assert.deepEqual(empty.atMultiple.map((x) => x.multiple), [...CAPITAL_MULTIPLES]);

  const f = tiedUp(
    [
      { fromMs: at(20), untilMs: null, cents: 500 },
      { fromMs: at(0), untilMs: null, cents: 0 },
      { fromMs: at(0), untilMs: null, cents: -5 },
      { fromMs: at(2), untilMs: null, cents: 7 },
    ],
    at(10),
    0,
  );
  assert.deepEqual([f.peakCents, f.nowCents, f.averageCents], [7, 7, 7]);

  const none = capitalModel([], NOW);
  assert.deepEqual(none.record, { lines: 0, voided: 0, memberSales: 0, counted: 0, since: null, days: 0 });
  assert.deepEqual([none.collar.lines, none.collar.medianMinutesHeld, none.collar.byLag.map((l) => l.peakCents), none.collar.byRoute], [0, null, CAPITAL_LAG_HOURS.map(() => 0), []]);
  assert.equal(none.medianStartToSettleMinutes, null);
});

test("capital model: large sizes stay exact; the average is summed in whole numbers", () => {
  // $50,000,000 out for 400 days: cents x milliseconds is far past what a float holds exactly
  const big = 5_000_000_000;
  const f = tiedUp([{ fromMs: at(0), untilMs: at(400 * 24), cents: big }, { fromMs: at(0), untilMs: null, cents: 1 }], at(800 * 24), 0);
  assert.equal(f.peakCents, big + 1);
  assert.equal(f.averageCents, big / 2 + 1);
  assert.equal(f.atMultiple[2].peakCents, (big + 1) * 100);
});
