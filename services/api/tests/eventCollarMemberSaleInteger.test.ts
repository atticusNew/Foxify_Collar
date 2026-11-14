/**
 * The member sale's money is integer arithmetic on the venue's own digits (memberSale.ts over
 * exactDecimal.ts). These tests prove it against a reference worked in BigInt fractions that
 * shares no code with the implementation:
 *   - every price from 1 to 99 cents, and every price on the venue's four-decimal grid, across a
 *     range of sizes and the three shares sold (40, 60, 80 percent): proceeds, floor and cap are
 *     the exact figures with the fraction of a cent dropped, and floor + riding x $1 = cap to the
 *     cent;
 *   - the record written from the venue's fills is the venue's numbers, summed exactly, with the
 *     classic float traps in the fills;
 *   - the page's own arithmetic agrees with the server's.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MICRO_PER_DOLLAR, centsToDollarString } from "../src/eventCollar/crossVenue/exactDecimal";
import { MemberApiError, MemberClient, maxPriceMicroOf, type RawMemberFill, type RawMemberOrder, type RawMemberRfq } from "../src/eventCollar/crossVenue/memberApp";
import {
  SALE_SHARE_PERCENT,
  acceptRfq,
  askLevels,
  bidLevels,
  buyBackRecordOf,
  centsPerDollarOf,
  executeLimitOrder,
  orderPriceBoundMicro,
  ownContracts,
  priceString,
  quoteBuyBack,
  quoteSaleTiers,
  requestRfqBid,
  saleEvCostBps,
  saleRecordOf,
  tierSaleContracts,
  venueContractsOf,
  venueLevelOf,
  walkLevels,
  type VenueLevel,
} from "../src/eventCollar/crossVenue/memberSale";
import { PROTECTION_TIERS, type ProtectionTier } from "../src/eventCollar/crossVenue/types";
import type { RawOutcomeMarket } from "../src/eventCollar/crossVenue/venueMarkets";
import { memberAppHtml } from "../scripts/memberAppHtml";

// ---------------------------------------------------------------------------
// the reference: exact fractions in BigInt, nothing shared with the implementation
// ---------------------------------------------------------------------------

/** a plain decimal string as numerator over a power of ten */
function frac(s: string): { num: bigint; den: bigint } {
  const [whole, f = ""] = s.split(".");
  return { num: BigInt(`${whole}${f}`), den: 10n ** BigInt(f.length) };
}
const floorB = (a: bigint, b: bigint): bigint => a / b;
const ceilB = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
/** every price and size below fits twelve decimals: dollars x 10^12 as one integer */
const E12 = 10n ** 12n;
const scaled = (s: string): bigint => {
  const { num, den } = frac(s);
  assert.equal(E12 % den, 0n, `${s} fits twelve decimals`);
  return (num * E12) / den;
};
const wholeContracts = (s: string): bigint => {
  const { num, den } = frac(s);
  return num / den;
};
const SHARE: Record<ProtectionTier, bigint> = { wide: 40n, balanced: 60n, tight: 80n };

interface RefSale {
  want: bigint;
  sold: bigint;
  kept: bigint;
  /** dollars x 10^12, exact */
  gross: bigint;
  cashCents: bigint;
  capCents: bigint;
  limitCents: bigint;
  avgCents: bigint;
  depthLimited: boolean;
}

/** The sale of one share of a position into bids given as the venue's strings, by exact fractions. Null when nothing can be sold. */
function refSale(position: bigint, tier: ProtectionTier, bids: Array<[string, string]>, maxPrice: string): RefSale | null {
  const share = (position * SHARE[tier]) / 100n;
  const want = position >= 1n ? (share > 1n ? share : 1n) : 0n;
  const levels = bids.map(([p, q]) => ({ p: scaled(p), q: wholeContracts(q) })).sort((a, b) => (a.p > b.p ? -1 : a.p < b.p ? 1 : 0));
  let left = want;
  let gross = 0n;
  let worst = 0n;
  let sold = 0n;
  for (const l of levels) {
    if (left <= 0n) break;
    const q = l.q < left ? l.q : left;
    if (q <= 0n) continue;
    gross += q * l.p;
    worst = l.p;
    sold += q;
    left -= q;
  }
  if (sold === 0n) return null;
  const kept = position - sold;
  const cashCents = floorB(gross * 100n, E12);
  return { want, sold, kept, gross, cashCents, capCents: cashCents + floorB(kept * scaled(maxPrice) * 100n, E12), limitCents: floorB(worst * 100n, E12), avgCents: floorB(gross * 100n, E12 * sold), depthLimited: sold < want };
}

const ONE = MICRO_PER_DOLLAR;
const bidsOf = (rows: Array<[string, string]>, maxPriceMicro = ONE): VenueLevel[] => bidLevels({ market_id: "m", max_price: centsToDollarString(maxPriceMicro / 10_000), bids: rows.map(([price, quantity]) => ({ price, quantity })) } as RawOutcomeMarket);

/** compare one implementation tier with the reference; returns how many figures were checked */
function sameSale(got: ReturnType<typeof quoteSaleTiers>[ProtectionTier], want: RefSale | null, where: string): number {
  if (!want) {
    assert.equal(got, null, where);
    return 1;
  }
  assert.ok(got, where);
  const g = [got.soldContracts, got.keptContracts, got.wantContracts, got.limitPriceCents, got.avgPriceCents, got.cashNowCents, got.floorTotalCents, got.capTotalCents, got.depthLimited];
  const w = [Number(want.sold), Number(want.kept), Number(want.want), Number(want.limitCents), Number(want.avgCents), Number(want.cashCents), Number(want.cashCents), Number(want.capCents), want.depthLimited];
  for (let i = 0; i < g.length; i++) if (g[i] !== w[i]) assert.deepEqual(g, w, where);
  return g.length;
}

// ---------------------------------------------------------------------------
// the quote: every price, a range of sizes, the three shares
// ---------------------------------------------------------------------------

const EVERY_SIZE_TO_200 = Array.from({ length: 200 }, (_, i) => i + 1);
const LARGER_SIZES = [250, 333, 999, 1000, 1001, 3333, 10_000, 123_457, 1_000_000];
const GRID_SIZES = [1, 2, 3, 4, 5, 7, 9, 10, 13, 20, 25, 33, 50, 99, 100, 101, 250, 999, 1000, 3333, 10_000, 123_457];

test("member sale grid: every price from 1 to 99 cents, every size from 1 to 200 and beyond, the three shares: proceeds, floor and cap are the exact figures, and floor + riding x $1 = cap to the cent", () => {
  let checked = 0;
  for (let c = 1; c <= 99; c++) {
    const price = `0.${String(c).padStart(2, "0")}`;
    const bids = bidsOf([[price, "100000000"]]);
    for (const N of [...EVERY_SIZE_TO_200, ...LARGER_SIZES]) {
      const got = quoteSaleTiers({ positionContracts: N, maxPriceMicro: ONE, bids });
      for (const tier of PROTECTION_TIERS) {
        const ref = refSale(BigInt(N), tier, [[price, "100000000"]], "1.0000");
        checked += sameSale(got[tier], ref, `${price} x ${N} ${tier}`);
        const q = got[tier];
        assert.ok(q && ref);
        // at a whole-cent price the proceeds are whole cents: nothing was dropped
        if (BigInt(q.cashNowCents) * E12 !== ref.gross * 100n) assert.fail(`${price} x ${N} ${tier}: proceeds ${q.cashNowCents} are not the exact ${ref.gross}`);
        if (q.cashNowCents !== q.soldContracts * c) assert.fail(`${price} x ${N} ${tier}: proceeds`);
        if (q.floorTotalCents + q.keptContracts * 100 !== q.capTotalCents) assert.fail(`${price} x ${N} ${tier}: floor + riding x $1 is not the cap`);
        if (q.soldContracts + q.keptContracts !== N) assert.fail(`${price} x ${N} ${tier}: sold + riding is not the position`);
        if (q.soldContracts !== Math.max(1, Number((BigInt(N) * BigInt(SALE_SHARE_PERCENT[tier])) / 100n))) assert.fail(`${price} x ${N} ${tier}: the share sold`);
      }
    }
  }
  assert.equal(checked, 99 * 209 * 3 * 9);
});

test("member sale grid: every price on the venue's four-decimal grid: the fraction of a cent is dropped from the proceeds, never added, and the cap identity holds", () => {
  let checked = 0;
  let dropped = 0;
  for (let k = 1; k <= 9999; k++) {
    const price = `0.${String(k).padStart(4, "0")}`;
    const bids = bidsOf([[price, "100000000"]]);
    for (const N of GRID_SIZES) {
      const got = quoteSaleTiers({ positionContracts: N, maxPriceMicro: ONE, bids });
      for (const tier of PROTECTION_TIERS) {
        const ref = refSale(BigInt(N), tier, [[price, "100000000"]], "1.0000");
        checked += sameSale(got[tier], ref, `${price} x ${N} ${tier}`);
        const q = got[tier];
        assert.ok(q && ref);
        // the exact proceeds are sold x k / 100 cents: shown is their floor, less than a cent under, never over
        const exactHundredthsOfACent = BigInt(q.soldContracts) * BigInt(k);
        const shown = BigInt(q.cashNowCents) * 100n;
        if (shown > exactHundredthsOfACent || exactHundredthsOfACent - shown >= 100n) assert.fail(`${price} x ${N} ${tier}: ${q.cashNowCents} against ${exactHundredthsOfACent}/100`);
        if (shown !== exactHundredthsOfACent) dropped++;
        if (q.floorTotalCents + q.keptContracts * 100 !== q.capTotalCents) assert.fail(`${price} x ${N} ${tier}: floor + riding x $1 is not the cap`);
        // the limit is the whole cent at or under the level, so the order still reaches it
        if (q.limitPriceCents * 100 > k || k - q.limitPriceCents * 100 >= 100) assert.fail(`${price}: limit ${q.limitPriceCents}`);
      }
    }
  }
  assert.equal(checked, 9999 * GRID_SIZES.length * 3 * 9);
  assert.ok(dropped > 100_000, "the grid does exercise a dropped fraction");
});

test("member sale grid: books of several levels, thin books, sizes written with decimals, and contracts that pay $2 or 50 cents, against the same exact reference", () => {
  // a fixed sequence, so the same books are walked on every run
  let seed = 20261110;
  const next = (n: number): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  const price4 = (lo: number, hi: number): string => {
    const k = lo + next(hi - lo + 1);
    return `${Math.floor(k / 10_000)}.${String(k % 10_000).padStart(4, "0")}`;
  };
  let checked = 0;
  let thin = 0;
  for (const [maxPrice, maxK] of [["1.0000", 10_000], ["2.00", 20_000], ["0.50", 5000]] as Array<[string, number]>) {
    const maxPriceMicro = maxPriceMicroOf({ max_price: maxPrice });
    assert.equal(BigInt(maxPriceMicro), scaled(maxPrice) / 1_000_000n);
    for (let i = 0; i < 6000; i++) {
      const levels: Array<[string, string]> = [];
      const n = 1 + next(4);
      for (let j = 0; j < n; j++) levels.push([price4(1, maxK - 1), [String(1 + next(60)), `${1 + next(60)}.00`, `${next(40)}.50`, `${1 + next(9)}.999`][next(4)]]);
      const N = [1, 2, 3, 5, 7, 12, 25, 50, 80, 137, 400][next(11)];
      const market = { market_id: "m", max_price: maxPrice, bids: levels.map(([price, quantity]) => ({ price, quantity })) } as RawOutcomeMarket;
      const got = quoteSaleTiers({ positionContracts: N, maxPriceMicro, bids: bidLevels(market) });
      for (const tier of PROTECTION_TIERS) {
        const ref = refSale(BigInt(N), tier, levels, maxPrice);
        checked += sameSale(got[tier], ref, `${JSON.stringify(levels)} max ${maxPrice} N=${N} ${tier}`);
        if (ref?.depthLimited) thin++;
        const q = got[tier];
        if (q && maxPrice === "1.0000" && q.floorTotalCents + q.keptContracts * 100 !== q.capTotalCents) assert.fail("floor + riding x $1 is not the cap");
        if (q && maxPrice === "2.00" && q.floorTotalCents + q.keptContracts * 200 !== q.capTotalCents) assert.fail("floor + riding x $2 is not the cap");
        if (q && maxPrice === "0.50" && q.floorTotalCents + q.keptContracts * 50 !== q.capTotalCents) assert.fail("floor + riding x 50 cents is not the cap");
      }
    }
  }
  assert.ok(checked > 100_000 && thin > 1000, `${checked} figures, ${thin} thin books`);

  // a level priced at or over max_price, at zero, or unreadable is not a bid; a level under one contract fills nothing
  assert.deepEqual(bidsOf([["1.0000", "10"], ["1.2", "10"], ["0", "10"], ["-0.5", "10"], ["abc", "10"], ["0.5", "0"], ["0.5", "x"], ["0.61", "0.999"]]), [{ priceMicro: 610_000, quantityMilli: 999 }]);
  assert.equal(walkLevels(bidsOf([["0.61", "0.999"]]), 5), null);
  assert.equal(walkLevels(bidsOf([["0.61", "10"]]), NaN), null);
  // a price finer than a micro-dollar goes against the member: a bid down, an offer up
  assert.deepEqual([venueLevelOf("0.12345678", "1", ONE, "bid"), venueLevelOf("0.12345678", "1", ONE, "offer")], [{ priceMicro: 123_456, quantityMilli: 1000 }, { priceMicro: 123_457, quantityMilli: 1000 }]);
  assert.deepEqual([maxPriceMicroOf({ max_price: "1.0000" }), maxPriceMicroOf({ max_price: "2.00" }), maxPriceMicroOf({ max_price: null }), maxPriceMicroOf({}), maxPriceMicroOf({ max_price: "0" }), maxPriceMicroOf({ max_price: "junk" }), maxPriceMicroOf(null)], [ONE, 2 * ONE, ONE, ONE, ONE, ONE, ONE]);
});

test("member sale grid: the share sold is the percent of the position rounded down, at least one contract, for every size to 100,000", () => {
  for (let N = 1; N <= 100_000; N++) {
    for (const tier of PROTECTION_TIERS) {
      const share = (BigInt(N) * SHARE[tier]) / 100n;
      if (BigInt(tierSaleContracts(N, tier)) !== (share > 1n ? share : 1n)) assert.fail(`${N} ${tier}`);
    }
  }
  assert.deepEqual([tierSaleContracts(0, "tight"), tierSaleContracts(0.99, "tight"), tierSaleContracts(7, "wide"), tierSaleContracts(7, "balanced"), tierSaleContracts(7, "tight"), tierSaleContracts(12.9, "tight")], [0, 0, 2, 4, 5, 9]);
});

test("member sale grid: the buy-back costs the exact total rounded up to the cent, its limit the cent at or over the worst offer and always under max_price", () => {
  let checked = 0;
  for (let k = 1; k <= 9999; k++) {
    const price = `0.${String(k).padStart(4, "0")}`;
    const asks = askLevels({ market_id: "m", max_price: "1.0000", offers: [{ price, quantity: "100000000" }] } as RawOutcomeMarket);
    for (const want of [1, 2, 3, 7, 12, 30, 100, 999, 12_345]) {
      const bb = quoteBuyBack(asks, want, ONE);
      assert.ok(bb);
      const gross = BigInt(want) * scaled(price);
      const cost = ceilB(gross * 100n, E12);
      const limit = ceilB(scaled(price) * 100n, E12);
      const want4 = [want, want, Number(limit < 99n ? limit : 99n), Number(ceilB(gross * 100n, E12 * BigInt(want))), Number(cost), false];
      const got = [bb.wantContracts, bb.contracts, bb.limitPriceCents, bb.avgPriceCents, bb.costCents, bb.depthLimited];
      for (let i = 0; i < got.length; i++) if (got[i] !== want4[i]) assert.deepEqual(got, want4, `${price} x ${want}`);
      // never under the exact cost, and less than a cent over
      const exact = BigInt(want) * BigInt(k);
      if (BigInt(bb.costCents) * 100n < exact || BigInt(bb.costCents) * 100n - exact >= 100n) assert.fail(`${price} x ${want}: cost ${bb.costCents}`);
      checked++;
    }
  }
  assert.equal(checked, 9999 * 9);
  // two levels, and a $2 contract: the limit may reach $1.99, never $2.00
  const two = askLevels({ market_id: "m", max_price: "2.00", offers: [{ price: "1.9950", quantity: "3" }, { price: "1.0750", quantity: "2" }] } as RawOutcomeMarket);
  assert.deepEqual(two.map((l) => l.priceMicro), [1_075_000, 1_995_000], "best (lowest) first");
  const bb2 = quoteBuyBack(two, 5, 2 * ONE);
  // 2 x 1.0750 + 3 x 1.9950 = $8.135
  assert.deepEqual(bb2 && [bb2.contracts, bb2.limitPriceCents, bb2.avgPriceCents, bb2.costCents], [5, 199, 163, 814]);
});

test("member sale units: a venue contract that pays $2 is two of ours; sizes convert without a float; the measurement in bps matches the exact fraction", () => {
  assert.deepEqual([venueContractsOf(50, ONE), venueContractsOf(25, 2 * ONE), venueContractsOf(20, 2 * ONE), venueContractsOf(15.95, ONE), venueContractsOf(1, 2 * ONE), venueContractsOf(10, 500_000)], [50, 12, 10, 15, 0, 20]);
  assert.deepEqual([ownContracts(10_000, 2 * ONE, "down"), ownContracts(12_500, ONE, "down"), ownContracts(3000, 500_000, "down"), ownContracts(1000, 1_005_000, "down"), ownContracts(1000, 1_005_000, "up")], [20, 12.5, 1.5, 1, 1.01]);
  assert.deepEqual([centsPerDollarOf(535_000, ONE, "down"), centsPerDollarOf(535_000, ONE, "nearest"), centsPerDollarOf(535_000, ONE, "up"), centsPerDollarOf(1_080_000, 2 * ONE, "down"), centsPerDollarOf(105_500, ONE, "nearest")], [53, 54, 54, 54, 11]);
  for (const [sold, cash, position, mark] of [[30, 1615, 50, 55], [20, 1080, 50, 60], [3, 31, 9, 11], [40, 2145, 50, 53], [1, 99, 1, 99], [7, 73, 9, 11]] as Array<[number, number, number, number]>) {
    // (sold x mark - cash) x 10,000 / (position x mark), to the nearest, a tie going up
    const num = (BigInt(sold) * BigInt(mark) - BigInt(cash)) * 10_000n;
    const den = BigInt(position) * BigInt(mark);
    const nearest = (2n * num + den) / (2n * den) - ((2n * num + den) % (2n * den) < 0n ? 1n : 0n);
    assert.equal(BigInt(saleEvCostBps({ soldContracts: sold, cashNowCents: cash }, position * 100, ONE, mark)), nearest, `${sold} of ${position} for ${cash} at ${mark}`);
  }
  assert.equal(saleEvCostBps({ soldContracts: 30, cashNowCents: 1615 }, 0, ONE, 55), 0);
  assert.equal(saleEvCostBps({ soldContracts: 30, cashNowCents: 1615 }, 5000, ONE, 0), 0);
  // the price an order carries is written from whole cents, never from a float's toFixed
  assert.deepEqual([priceString(53), priceString(5), priceString(0), priceString(100), priceString(108), priceString(12_345)], ["0.53", "0.05", "0.00", "1.00", "1.08", "123.45"]);
  for (const bad of [53.5, -1, NaN, Infinity]) assert.throws(() => priceString(bad), RangeError);
});

// ---------------------------------------------------------------------------
// the record: the venue's fills, summed exactly
// ---------------------------------------------------------------------------

interface Script {
  /** the fills the venue reports for the order, as it writes them */
  fills: RawMemberFill[];
  /** the order as the venue answers it */
  order: Partial<RawMemberOrder>;
  /** the fills read fails */
  fillsDown?: boolean;
}

/** A member client over a scripted venue: one order, its fills. Records what was sent. */
function scriptedClient(script: Script): { client: MemberClient; sent: Array<{ path: string; body: unknown }> } {
  const sent: Array<{ path: string; body: unknown }> = [];
  const order = (body: Record<string, unknown> | null): RawMemberOrder => ({ id: "ord-1", status: "filled", quantity: String(body?.quantity ?? ""), price: String(body?.price ?? ""), ...script.order });
  let placed: RawMemberOrder | null = null;
  const client = new MemberClient({
    host: "http://venue.test",
    token: async () => "t",
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
      if (init?.method === "POST") sent.push({ path: u.pathname, body });
      if (u.pathname === "/api/v1/orders" && init?.method === "POST") {
        placed = order(body);
        return json(201, { order: placed });
      }
      if (/^\/api\/v1\/rfqs\/[^/]+\/accept$/.test(u.pathname)) {
        placed = order(body);
        return json(201, { order: placed });
      }
      if (/^\/api\/v1\/orders\/[^/]+$/.test(u.pathname)) return init?.method === "DELETE" ? json(200, { order_id: "ord-1", status: "cancelled" }) : json(200, { order: placed });
      if (u.pathname === "/api/v1/fills") return script.fillsDown ? json(503, { error: "down" }) : json(200, { fills: script.fills });
      return json(404, { error: "not found" });
    }) as typeof fetch,
  });
  return { client, sent };
}

const fast = { waitMs: 20, pollMs: 1, sleep: async () => undefined };
const fill = (price: string, filled: string, trade_fee?: string | null): RawMemberFill => ({ order_id: "ord-1", price, filled, ...(trade_fee !== undefined ? { trade_fee } : {}) });
const sellBody = (price: string, quantity: number) => ({ action: "sell" as const, market_id: "m", order_type: "limit" as const, price, quantity: String(quantity), client_order_id: "atticus-lock-test" });
const buyBody = (price: string, quantity: number) => ({ ...sellBody(price, quantity), action: "buy" as const, client_order_id: "atticus-leave-test" });

/** the exact money of a list of fills, by fractions: dollars x 10^12 */
const refGross = (fills: Array<[string, string]>): { gross: bigint; contracts12: bigint } => {
  let gross = 0n;
  let contracts12 = 0n;
  for (const [p, q] of fills) {
    gross += (scaled(p) * scaled(q)) / E12;
    assert.equal((scaled(p) * scaled(q)) % E12, 0n);
    contracts12 += scaled(q);
  }
  return { gross, contracts12 };
};

test("member sale record: written from the venue's fills, summed exactly, for every price from 1 to 99 cents, a range of sizes and the three shares; floor + riding x $1 = cap; the fills ride on the record as the venue wrote them", async () => {
  let checked = 0;
  for (let c = 1; c <= 99; c++) {
    for (const N of [1, 3, 7, 10, 25, 50, 99, 137, 1000]) {
      for (const tier of PROTECTION_TIERS) {
        const want = tierSaleContracts(N, tier);
        const limit = centsToDollarString(c);
        // the venue fills part at the limit and part between cents above it, as a walked book would
        const first = Math.ceil(want / 3);
        const fills: Array<[string, string]> = first < want ? [[`0.${String(c).padStart(2, "0")}50`, `${first}.00`], [`${limit}00`, String(want - first)]] : [[`0.${String(c).padStart(2, "0")}25`, String(want)]];
        const { client, sent } = scriptedClient({ fills: fills.map(([p, q]) => fill(p, q, "0.00")), order: { filled: String(want) } });
        const o = await executeLimitOrder(client, sellBody(limit, want), fast);
        const sale = saleRecordOf(o, { marketId: "m", positionContracts: N, maxPriceMicro: ONE, limitPriceCents: c, clientOrderId: "atticus-lock-test", requested: want });
        const ref = refGross(fills);
        const cash = Number(floorB(ref.gross * 100n, E12));
        assert.deepEqual(
          [sale.soldContracts, sale.keptContracts, sale.requestedContracts, sale.cashNowCents, sale.floorTotalCents, sale.capTotalCents, sale.avgPriceCents, sale.limitPriceCents, sale.maxPriceCents, sale.feeCents, sale.figuresFrom, sale.status],
          [want, N - want, want, cash, cash, cash + (N - want) * 100, Number(floorB(ref.gross * 100n, E12 * BigInt(want))), c, 100, 0, "fills", "filled"],
          `${limit} x ${want} of ${N}`,
        );
        assert.deepEqual(sale.venueFills, fills.map(([price, filled]) => ({ price, filled, tradeFee: "0.00" })));
        assert.equal(sale.floorTotalCents + sale.keptContracts * 100, sale.capTotalCents);
        assert.deepEqual((sent[0].body as Record<string, unknown>).price, limit);
        checked++;
      }
    }
  }
  assert.equal(checked, 99 * 9 * 3);
});

test("member sale record: the classic float traps in the fills come out exact; a sale's cash drops the fraction of a cent, a buy-back's cost rounds it up, a fee rounds up", async () => {
  const run = async (side: "sell" | "buy", fills: RawMemberFill[], limit: string, quantity: number) => {
    const { client } = scriptedClient({ fills, order: { filled: String(quantity) } });
    return executeLimitOrder(client, side === "sell" ? sellBody(limit, quantity) : buyBody(limit, quantity), fast);
  };
  const cases: Array<[string, Array<[string, string]>, number, number]> = [
    // [what a float does with it, the fills, the sale's cash, the buy-back's cost]
    ["0.1 + 0.2 = 0.30000000000000004", [["0.1", "1"], ["0.2", "1"]], 30, 30],
    ["0.29 x 100 = 28.999999999999996", [["0.29", "100"]], 2900, 2900],
    ["0.7 + 0.1 = 0.7999999999999999", [["0.7", "1"], ["0.1", "1"]], 80, 80],
    ["0.57 x 100 = 56.99999999999999", [["0.57", "100"]], 5700, 5700],
    ["0.56 x 25 = 14.000000000000002", [["0.56", "25"]], 1400, 1400],
    ["0.07 x 100 = 7.000000000000001", [["0.07", "100"]], 700, 700],
    ["0.58 x 100 = 57.99999999999999", [["0.58", "100"]], 5800, 5800],
    // the true total has a fraction of a cent: $3.165, $0.5275, $16.0125
    ["30 x 0.1055", [["0.1055", "30"]], 316, 317],
    ["5 x 0.1055", [["0.1055", "5.00"]], 52, 53],
    ["25 x 0.5350 + 5 x 0.5275", [["0.5350", "25"], ["0.5275", "5"]], 1601, 1602],
    // a size written with a fraction: 12.5 x 0.4321 = $5.40125
    ["12.5 x 0.4321", [["0.4321", "12.500"]], 540, 541],
  ];
  for (const [what, fills, cash, cost] of cases) {
    const qty = fills.reduce((s, [, q]) => s + Number(q), 0);
    const sold = await run("sell", fills.map(([p, q]) => fill(p, q)), "0.01", Math.ceil(qty));
    const bought = await run("buy", fills.map(([p, q]) => fill(p, q)), "0.99", Math.ceil(qty));
    const ref = refGross(fills);
    assert.deepEqual([sold.grossCents, bought.grossCents], [cash, cost], what);
    assert.deepEqual([BigInt(sold.grossCents), BigInt(bought.grossCents)], [floorB(ref.gross * 100n, E12), ceilB(ref.gross * 100n, E12)], what);
    assert.equal(BigInt(sold.filledMilli) * 10n ** 9n, ref.contracts12, what);
    assert.deepEqual([sold.figuresFrom, sold.feeCents, sold.venueFills], ["fills", undefined, fills.map(([price, filled]) => ({ price, filled }))], what);
  }

  // 1.005 a contract on a market that pays $2: half a cent, down on the sale and up on the buy-back
  const { client: two } = scriptedClient({ fills: [fill("1.005", "1")], order: { filled: "1" } });
  const half = await executeLimitOrder(two, sellBody("1.00", 1), fast);
  assert.deepEqual([half.grossCents, half.avgPriceCents], [100, 100]);
  const rec2 = saleRecordOf(half, { marketId: "m", positionContracts: 25, maxPriceMicro: 2 * ONE, limitPriceCents: 100, clientOrderId: "c", requested: 10 });
  assert.deepEqual([rec2.maxPriceCents, rec2.soldContracts, rec2.keptContracts, rec2.requestedContracts, rec2.capTotalCents], [200, 2, 48, 20, 100 + 4800], "one $2 contract sold of 25 held: two of ours sold, 48 riding");
  const { client: twoBuy } = scriptedClient({ fills: [fill("1.005", "1")], order: { filled: "1" } });
  const halfUp = await executeLimitOrder(twoBuy, buyBody("1.01", 1), fast);
  assert.deepEqual([halfUp.grossCents, halfUp.avgPriceCents], [101, 101]);
  const back = buyBackRecordOf(halfUp, { maxPriceMicro: 2 * ONE, limitPriceCents: 101, clientOrderId: "c", requested: 1 });
  assert.deepEqual([back.boughtContracts, back.requestedContracts, back.costCents, back.figuresFrom, back.venueFills], [2, 2, 101, "fills", [{ price: "1.005", filled: "1" }]]);

  // the venue's fee on the fills: summed in micro-dollars, up to the cent; absent when the venue gives none
  const fee = await run("sell", [fill("0.54", "10", "0.0149"), fill("0.54", "10", "0.0149"), fill("0.53", "10", null)], "0.53", 30);
  assert.deepEqual([fee.grossCents, fee.feeCents], [1610, 3], "$0.0298 of fees is 3 cents, not 2");
  assert.deepEqual(fee.venueFills, [{ price: "0.54", filled: "10", tradeFee: "0.0149" }, { price: "0.54", filled: "10", tradeFee: "0.0149" }, { price: "0.53", filled: "10" }]);
  assert.equal((await run("sell", [fill("0.54", "10", "0.01"), fill("0.54", "10", "0.02")], "0.53", 20)).feeCents, 3);
  assert.equal((await run("sell", [fill("0.54", "10")], "0.53", 10)).feeCents, undefined);

  // a fill the venue wrote unreadably is not counted, and is not on the record
  const odd = await run("sell", [fill("0.54", "10"), fill("abc", "5"), fill("0.54", "0"), fill("0.54", "-3"), fill("0.54", "")], "0.53", 30);
  assert.deepEqual([odd.filled, odd.filledMilli, odd.grossCents, odd.venueFills], [10, 10_000, 540, [{ price: "0.54", filled: "10" }]]);

  // a partial: 12 of 30 filled; the record is the smaller sale, more riding
  const { client: part } = scriptedClient({ fills: [fill("0.5350", "12")], order: { status: "partially_cancelled", filled: "12" } });
  const p = await executeLimitOrder(part, sellBody("0.53", 30), fast);
  const partRec = saleRecordOf(p, { marketId: "m", positionContracts: 50, maxPriceMicro: ONE, limitPriceCents: 53, clientOrderId: "c", requested: 30 });
  assert.deepEqual([partRec.soldContracts, partRec.keptContracts, partRec.requestedContracts, partRec.cashNowCents, partRec.capTotalCents, p.note], [12, 38, 30, 642, 642 + 3800, "12 of 30 filled at 0.53 or better; the rest partially_cancelled"]);

  // nothing is sent on an order this service could not read back itself
  for (const bad of [sellBody("0.5.3", 30), sellBody("0.53", 0), { ...sellBody("0.53", 30), quantity: "thirty" }, sellBody("0", 30)]) {
    const { client, sent } = scriptedClient({ fills: [], order: {} });
    await assert.rejects(executeLimitOrder(client, bad, fast), (err: unknown) => err instanceof MemberApiError && err.code === "bad_order");
    assert.equal(sent.length, 0);
  }
});

test("member sale record: when the fills cannot be read, the order's own size stands in at the price it cannot have done worse than, and the record says so", async () => {
  // the bound itself: a sell never fills under its limit, a buy never over it; the average tightens that by one unit of its last digit
  assert.deepEqual(
    [orderPriceBoundMicro("0.5383", 530_000, true), orderPriceBoundMicro("0.54", 530_000, true), orderPriceBoundMicro("0.5400", 530_000, true), orderPriceBoundMicro(null, 530_000, true), orderPriceBoundMicro("junk", 530_000, true), orderPriceBoundMicro("0.52", 530_000, true), orderPriceBoundMicro("0", 530_000, true)],
    [538_200, 530_000, 539_900, 530_000, 530_000, 530_000, 530_000],
  );
  assert.deepEqual([orderPriceBoundMicro("0.5712", 580_000, false), orderPriceBoundMicro("0.57", 580_000, false), orderPriceBoundMicro(undefined, 580_000, false), orderPriceBoundMicro("0.60", 580_000, false)], [571_300, 580_000, 580_000, 580_000]);

  // true fills: 20 at 0.54 and 10 at 0.535 = $16.15; the venue's own average reads 0.5383
  const { client } = scriptedClient({ fills: [], order: { filled: "30", avg_price: "0.5383" } });
  const o = await executeLimitOrder(client, sellBody("0.53", 30), fast);
  assert.deepEqual([o.filled, o.figuresFrom, o.grossCents, o.avgPriceCents, o.venueFills], [30, "order", 1614, 53, []], "30 x 0.5382 = $16.146: a cent under the true $16.15, never over");
  const rec = saleRecordOf(o, { marketId: "m", positionContracts: 50, maxPriceMicro: ONE, limitPriceCents: 53, clientOrderId: "c", requested: 30 });
  assert.deepEqual([rec.figuresFrom, rec.venueFills, rec.cashNowCents, rec.capTotalCents], ["order", undefined, 1614, 3614]);
  // an average that was rounded up cannot push the cash over the truth: 29 at 0.54 and 1 at 0.5398 is $16.1998, shown as 0.5400
  const { client: up } = scriptedClient({ fills: [], order: { filled: "30", avg_price: "0.5400" } });
  assert.equal((await executeLimitOrder(up, sellBody("0.53", 30), fast)).grossCents, 1619);
  // the fills read failing is the same case; no average at all leaves the limit
  const { client: down } = scriptedClient({ fills: [], fillsDown: true, order: { filled: "30" } });
  const d = await executeLimitOrder(down, sellBody("0.53", 30), fast);
  assert.deepEqual([d.figuresFrom, d.grossCents], ["order", 1590]);
  // a buy-back: the cost is counted at the most it can have been
  const { client: buy } = scriptedClient({ fills: [], order: { filled: "30", avg_price: "0.5712" } });
  const b = await executeLimitOrder(buy, buyBody("0.58", 30), fast);
  assert.deepEqual([b.figuresFrom, b.grossCents, b.avgPriceCents], ["order", 1714, 58], "30 x 0.5713 = $17.139, up");
  // nothing filled: nothing counted
  const { client: none } = scriptedClient({ fills: [], order: { status: "cancelled", filled: "0" } });
  const n = await executeLimitOrder(none, sellBody("0.53", 30), fast);
  assert.deepEqual([n.filled, n.grossCents, n.avgPriceCents, n.figuresFrom], [0, 0, 0, "fills"]);
});

test("combo quote: a price finer than a cent is read as it stands and sent back digit for digit on the accept; the record is the fills", async () => {
  const rfq: RawMemberRfq = { id: "rfq-1", status: "quoted", market_id: "m", action: "sell", quantity: "7", price: "0.1055", expires_at: new Date(Date.now() + 30_000).toISOString(), client_rfq_id: "atticus-rfq-test" };
  const quoteClient = { requestRfq: async () => rfq, rfq: async () => rfq } as unknown as MemberClient;
  const bid = await requestRfqBid(quoteClient, { market_id: "m", action: "sell", quantity: "7", client_rfq_id: "atticus-rfq-test" }, ONE, fast);
  assert.deepEqual([bid.level, bid.reason], [{ priceMicro: 105_500, quantityMilli: 7000 }, null]);
  const tiers = quoteSaleTiers({ positionContracts: 9, maxPriceMicro: ONE, bids: [bid.level as VenueLevel] });
  // 3, 5 and 7 contracts at 0.1055: $0.3165, $0.5275, $0.7385
  assert.deepEqual([tiers.wide?.cashNowCents, tiers.balanced?.cashNowCents, tiers.tight?.cashNowCents, tiers.wide?.limitPriceCents, tiers.wide?.capTotalCents], [31, 52, 73, 10, 631]);
  const { client, sent } = scriptedClient({ fills: [fill("0.1055", "3")], order: { filled: "3", avg_price: "0.1055" } });
  const o = await acceptRfq(client, bid, 3);
  assert.deepEqual(sent, [{ path: "/api/v1/rfqs/rfq-1/accept", body: { quantity: "3", price: "0.1055" } }], "the venue's own price, not a rounded one (two decimals would ask 0.11, more than the quote)");
  assert.deepEqual([o.filled, o.grossCents, o.avgPriceCents, o.figuresFrom, o.note], [3, 31, 10, "fills", "3 filled at 0.1055 on the quote"]);
  // a quote the venue wrote as a JSON number, or with spaces, goes back as it reads
  const { client: c2, sent: s2 } = scriptedClient({ fills: [fill("0.3", "2")], order: { filled: "2" } });
  await acceptRfq(c2, { ...bid, rfq: { ...rfq, price: 0.3 as unknown as string }, level: { priceMicro: 300_000, quantityMilli: 7000 } }, 2);
  assert.deepEqual((s2[0].body as Record<string, unknown>).price, "0.3");
  // the accept's fills unread: the quote's own price is the bound
  const { client: c3 } = scriptedClient({ fills: [], order: { filled: "3" } });
  const o3 = await acceptRfq(c3, bid, 3);
  assert.deepEqual([o3.figuresFrom, o3.grossCents], ["order", 31]);
  // a quote with no readable price is no bid
  for (const price of [null, "", "abc", "0", "1.0000", "1.5"]) {
    const q = { ...rfq, price: price as string | null };
    const none = await requestRfqBid({ requestRfq: async () => q, rfq: async () => q } as unknown as MemberClient, { market_id: "m", action: "sell", quantity: "7", client_rfq_id: "x" }, ONE, fast);
    assert.deepEqual([none.level, none.reason], [null, "unpriced"], String(price));
  }
});

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------

test("member page: its own arithmetic is whole numbers and agrees with the server: the size a shape asks for, what a ticket is worth at the bid, what the riding contracts pay", () => {
  const html = memberAppHtml({ venueName: "STX", configured: true, recordUrl: "https://record.test/" });
  const line = (name: string): string => {
    const m = new RegExp(`^  const ${name} = .*$`, "m").exec(html);
    assert.ok(m, `the page defines ${name}`);
    return m[0];
  };
  const page = new Function(`${line("TIER_ORDER")}\n${line("hundredths")}\n${line("wantOf")}\n${line("worthOf")}\nreturn { TIER_ORDER, hundredths, wantOf, worthOf };`)() as {
    TIER_ORDER: string[];
    hundredths: (contracts: number) => number;
    wantOf: (st: { tier: string }, contracts: number, t?: { wantContracts?: number }) => number;
    worthOf: (p: { contracts: number; bidCents?: number | null; lastCents?: number | null; costCents?: number | null }) => { worth: number; px: number; bid: boolean; since: number } | null;
  };
  assert.deepEqual(page.TIER_ORDER, ["wide", "balanced", "tight"]);
  // the server's figure is the one shown; the page's own rule, when a quote carries none, is the server's rule
  assert.equal(page.wantOf({ tier: "wide" }, 7, { wantContracts: 2 }), 2);
  assert.equal(Math.round((7 * 2) / 5), 3, "rounding the share to the nearest would say 3 where the tier sells 2");
  for (let N = 1; N <= 5000; N++) for (const tier of PROTECTION_TIERS) if (page.wantOf({ tier }, N, {}) !== tierSaleContracts(N, tier)) assert.fail(`${N} ${tier}: the page says ${page.wantOf({ tier }, N, {})}`);
  // worth at the bid: whole cents, the fraction of a cent dropped
  assert.deepEqual(page.worthOf({ contracts: 50, bidCents: 54, costCents: 2100 }), { worth: 2700, px: 54, bid: true, since: 600 });
  assert.deepEqual(page.worthOf({ contracts: 1.01, bidCents: 50, costCents: 40 }), { worth: 50, px: 50, bid: true, since: 10 });
  assert.deepEqual(page.worthOf({ contracts: 12.35, bidCents: 54, costCents: 700 }), { worth: 666, px: 54, bid: true, since: -34 });
  assert.deepEqual(page.worthOf({ contracts: 9, bidCents: null, lastCents: 11, costCents: 99 }), { worth: 99, px: 11, bid: false, since: 0 });
  assert.equal(page.worthOf({ contracts: 9, bidCents: null, lastCents: null, costCents: 99 }), null);
  for (let h = 1; h <= 20_000; h += 7) for (const px of [1, 11, 33, 50, 54, 99]) {
    const w = page.worthOf({ contracts: h / 100, bidCents: px, costCents: 0 });
    if (!w || BigInt(w.worth) !== (BigInt(h) * BigInt(px)) / 100n) assert.fail(`${h / 100} at ${px}`);
  }
  assert.deepEqual([page.hundredths(15.95), page.hundredths(0.29), page.hundredths(1.15), page.hundredths(50)], [1595, 29, 115, 5000]);
  // what the riding contracts pay is read off the sale's own totals, and the whole position's payout off whole hundredths
  assert.ok(html.includes('" contracts</b> · each pays $1 if it wins (" + usd(ms.capTotalCents - ms.floorTotalCents) + " in all), $0 if it loses, as they always did</div>"'));
  assert.ok(html.includes("'</b><s>of ' + usd(hundredths(n)) + '</s></div>'"));
  assert.ok(!/usd\([^()]*\* 100\)/.test(html), "no dollar figure on the page is a decimal times 100");
});
