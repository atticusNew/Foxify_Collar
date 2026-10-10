/**
 * Listing quote: hand-entered marketplace listings validated, the lock on the
 * remaining leg chosen for the highest worst case with carry to resolution,
 * the identity (writer = take + carry on both outcomes), the refusals, and the
 * one-pager.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LISTING_CONFIG,
  type Listing,
  type ListingLockTerms,
  type ListingMarketState,
  carryCents,
  fairCents,
  fmtUsd,
  listingConfigFromEnv,
  listingContracts,
  listingsMarkdown,
  monthsToResolution,
  parseListings,
  quoteListing,
  settleListing,
} from "../src/eventCollar/crossVenue/listingQuote";
import { lastLegCollars, quoteLastLeg } from "../src/eventCollar/crossVenue/lastLeg";
import { DEFAULT_CROSS_CONFIG, type PmBook } from "../src/eventCollar/crossVenue/types";
import { pickMockRow, renderListingMockHtml } from "../scripts/wagerwireListingMockHtml";

const NOW = Date.parse("2026-10-09T03:00:00Z");

const book = (askMilli: number, sizeShares = 100_000): PmBook => ({
  tokenId: "no-token",
  asks: [{ priceMilli: askMilli, sizeMilli: sizeShares * 1000 }],
  bids: [{ priceMilli: askMilli - 10, sizeMilli: sizeShares * 1000 }],
  minOrderSizeShares: 5,
  tickMilli: 1,
});

const state = (markMilli: number, askMilli: number, over: Partial<ListingMarketState> = {}): ListingMarketState => ({
  markCents: Math.round(markMilli / 10),
  markMilli,
  noBook: book(askMilli),
  noOutcome: "No",
  closed: false,
  eventTitle: "Pro Football: 2027 Champion",
  question: "Will the Kansas City Chiefs win the 2027 NFL league championship?",
  ...over,
});

const rawListing = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "ORD_test",
  sourceUrl: "https://www.example.com/for-sale/ORD_test",
  readAt: "2026-10-09T02:52:00Z",
  book: "DraftKings",
  legsTotal: 2,
  legsRemaining: 1,
  listedPriceCents: 21000,
  highestBidCents: null,
  payoutCents: 357000,
  resolvesIso: "2027-02-15T00:00:00Z",
  hitLegs: [{ label: "Argentina vs Switzerland", market: "Regular Time Correct Score: 1-1" }],
  remaining: [{ label: "Kansas City Chiefs", market: "26/27 Super Bowl Winner", venue: "polymarket", eventSlug: "pro-football-2027-champion", outcome: "Kansas City Chiefs", side: 0 }],
  ...over,
});

const listing = (over: Record<string, unknown> = {}): Listing => parseListings([rawListing(over)])[0];

test("listings: hand-entered rows are validated; money is integer cents, legs add up, the one remaining leg names its market", () => {
  const l = listing();
  assert.equal(l.readAt, "2026-10-09T02:52:00.000Z");
  assert.equal(l.remaining[0].eventSlug, "pro-football-2027-champion");
  assert.throws(() => parseListings([rawListing({ listedPriceCents: 210.5 })]), /listedPriceCents/);
  assert.throws(() => parseListings([rawListing({ sourceUrl: "http://insecure" })]), /https/);
  assert.throws(() => parseListings([rawListing({ legsRemaining: 2 })]), /remaining has 1 legs/);
  assert.throws(() => parseListings([rawListing({ hitLegs: [] })]), /hit \+ remaining/);
  assert.throws(() => parseListings([rawListing({ remaining: [{ label: "x", market: "y", venue: "polymarket", side: 0 }] })]), /needs eventSlug and outcome/);
  assert.throws(() => parseListings([rawListing({ remaining: [{ label: "x", market: "y", venue: "kalshi", eventSlug: "s", outcome: "o", side: 0 }] })]), /venue/);
  const two = parseListings([
    rawListing({ legsTotal: 3, legsRemaining: 2, remaining: [{ label: "a", market: "m", venue: "polymarket", side: 0 }, { label: "b", market: "m", venue: "polymarket", side: 0 }] }),
  ])[0];
  assert.equal(two.legsRemaining, 2, "two remaining legs need no slug: they are refused, not read");
});

test("arithmetic: contracts from payout with odd cents, whole months of carry, carry rounded up, fair to the cent", () => {
  assert.deepEqual(listingContracts(45101), { contracts: 451, unprotectedCents: 1 });
  assert.deepEqual(listingContracts(357000), { contracts: 3570, unprotectedCents: 0 });
  assert.equal(monthsToResolution(NOW, "2027-02-15T00:00:00Z"), 5);
  assert.equal(monthsToResolution(NOW, "2026-10-20T00:00:00Z"), 1, "never under one month");
  assert.equal(carryCents(317_645, 5, 50), Math.ceil((317_645 * 50 * 5) / 10_000));
  assert.equal(carryCents(100, 1, 0), 0);
  assert.equal(fairCents(52_500, 3), 15_750, "a 0.3c leg on $52,500 is $157.50, not $0");
  assert.equal(fmtUsd(123456), "$1,234.56");
  assert.equal(fmtUsd(-5), "-$0.05");
  assert.equal(listingConfigFromEnv({ EVENT_LISTING_CARRY_BPS_PER_MONTH: "25" }).carryBpsPerMonth, 25);
  assert.equal(listingConfigFromEnv({}).carryBpsPerMonth, DEFAULT_LISTING_CONFIG.carryBpsPerMonth);
});

test("quote: the collar with the highest worst case is chosen from the whole grid, carry is deducted, and the writer's result is take + carry on both outcomes", () => {
  const l = listing();
  const s = state(98, 902);
  const row = quoteListing(l, s, NOW);
  assert.ok(row.quote.ok, `quoted: ${JSON.stringify(row.quote)}`);
  const q = row.quote as ListingLockTerms;
  assert.equal(row.contracts, 3570);
  assert.equal(row.markCents, 10);
  assert.equal(row.fairCents, Math.round((3570 * 98) / 10));
  assert.equal(row.askVsFairBps, Math.round(((21000 - (row.fairCents as number)) * 10_000) / (row.fairCents as number)));
  assert.equal(q.monthsCarried, 5);
  assert.equal(q.carryCents, carryCents(q.hedgeCostCents + q.feesCents, 5, 50));
  assert.equal(q.lockWorstCents, q.floorCents * 3570 + q.creditCents);
  assert.equal(q.lockBestCents, q.capCents * 3570 + q.creditCents);
  assert.equal(row.lockBeatsAsk, q.lockWorstCents >= 21000);

  // Highest worst case over every funded collar, not just the balanced tier the live book leads with.
  const grid = lastLegCollars({ contracts: 3570, markCents: 10, entryCents: 6, minutesToStart: 1e6, noBook: s.noBook, noOutcome: "No", config: DEFAULT_CROSS_CONFIG });
  assert.ok(grid.ok);
  let bestWorst = -1;
  for (const c of grid.search.candidates) {
    const carry = carryCents(c.hedge.costCents + c.feesCents, 5, 50);
    const credit = c.creditCents - carry;
    if (credit > 0) bestWorst = Math.max(bestWorst, c.floorCents * 3570 + credit);
  }
  assert.equal(q.lockWorstCents, bestWorst, "no funded collar guarantees the seller more");
  const balanced = quoteLastLeg({ contracts: 3570, markCents: 10, entryCents: 6, minutesToStart: 1e6, noBook: s.noBook, noOutcome: "No", config: DEFAULT_CROSS_CONFIG });
  assert.ok(balanced.ok);
  assert.ok(q.lockWorstCents >= balanced.floorCents * 3570 + balanced.creditCents - carryCents((balanced.hedge.costCents ?? 0) + balanced.feesCents, 5, 50), "at least the balanced tier's worst case");

  // Identity: holder legs by hand; writer = take + carry whichever way the leg settles.
  const win = settleListing(row, "yes");
  const loss = settleListing(row, "no");
  assert.ok(win && loss);
  assert.equal(win.nakedCents, 357000);
  assert.equal(loss.nakedCents, 0);
  assert.equal(win.protectedCents, q.capCents * 3570 + q.creditCents);
  assert.equal(loss.protectedCents, q.floorCents * 3570 + q.creditCents);
  assert.equal(loss.protectedCents, q.lockWorstCents, "the worst case on the page is what the seller gets on a miss");
  assert.equal(win.writerCents, q.takeCents + q.carryCents, "writer on a hit: take + carry");
  assert.equal(loss.writerCents, q.takeCents + q.carryCents, "writer on a miss: take + carry");
  assert.equal(win.askCents, 21000);
  // funding - hedge - fees - credit = take + carry, as the docstring states
  const funding = (100 - q.capCents) * 3570;
  assert.equal(funding - q.hedgeCostCents - q.feesCents - q.creditCents, q.takeCents + q.carryCents);
});

test("quote: odd cents of payout ride unprotected and are paid on a hit only", () => {
  const l = listing({ payoutCents: 45101, listedPriceCents: 21000, resolvesIso: "2026-11-01T00:00:00Z" });
  const row = quoteListing(l, state(430, 575), NOW);
  assert.ok(row.quote.ok);
  assert.equal(row.unprotectedCents, 1);
  const q = row.quote as ListingLockTerms;
  assert.equal(q.monthsCarried, 1);
  assert.equal(settleListing(row, "yes")!.protectedCents, q.capCents * 451 + q.creditCents + 1);
  assert.equal(settleListing(row, "no")!.protectedCents, q.floorCents * 451 + q.creditCents);
});

test("refusals: two legs left, a closed market, a lottery-ticket mark, carry that eats every credit, a credit under the minimum", () => {
  const two = parseListings([
    rawListing({ legsTotal: 3, legsRemaining: 2, remaining: [{ label: "Denver Broncos", market: "SB", venue: "polymarket", side: 0 }, { label: "Kylian Mbappe", market: "Golden Boot", venue: "polymarket", side: 0 }] }),
  ])[0];
  const r2 = quoteListing(two, state(33, 967), NOW);
  assert.equal(r2.quote.ok, false);
  assert.equal((r2.quote as { code: string }).code, "legs_remaining");
  assert.equal(r2.fairCents, null, "nothing is read for a two-leg listing");

  const closed = quoteListing(listing(), state(98, 902, { closed: true }), NOW);
  assert.equal((closed.quote as { code: string }).code, "market_closed");
  assert.equal(closed.fairCents, Math.round((3570 * 98) / 10), "the fair value is still shown");

  const lottery = quoteListing(listing({ payoutCents: 5_250_000, listedPriceCents: 787_500 }), state(3, 997), NOW);
  assert.equal((lottery.quote as { code: string }).code, "mark_out_of_range");
  assert.equal(lottery.fairCents, 15_750, "fair is to the cent even when the mark rounds to 0c");

  // A tight book (NO at 905 for a 10c leg) leaves little credit; years of carry eat all of it.
  const eaten = quoteListing(listing({ resolvesIso: "2031-02-15T00:00:00Z" }), state(98, 905), NOW);
  assert.equal(eaten.quote.ok, false);
  assert.equal((eaten.quote as { code: string }).code, "credit_nonpositive");
  assert.match((eaten.quote as { detail: string }).detail, /carry/);

  const small = quoteListing(listing(), state(98, 902), NOW, { ...DEFAULT_LISTING_CONFIG, minimum: { cents: 100_000, bpsOfStake: 0 } });
  assert.equal((small.quote as { code: string }).code, "credit_too_small");
  assert.equal(settleListing(small, "yes"), null, "a refused row does not settle");
});

test("the page: every listing on one table, quoted rows beside the ask, refusals in plain words, no em dash", () => {
  const rows = [
    quoteListing(listing(), state(98, 902), NOW),
    quoteListing(listing({ id: "ORD_single", legsTotal: 1, hitLegs: [], payoutCents: 5_250_000, listedPriceCents: 787_500, book: "FanDuel", remaining: [{ label: "Shohei Ohtani", market: "2026 MLB Cy Young Winner", venue: "polymarket", eventSlug: "cy", outcome: "Shohei Ohtani", side: 0 }] }), state(3, 997), NOW),
    quoteListing(
      parseListings([rawListing({ id: "ORD_two", legsTotal: 3, legsRemaining: 2, remaining: [{ label: "Denver Broncos", market: "SB", venue: "polymarket", side: 0 }, { label: "Kylian Mbappe", market: "Golden Boot", venue: "polymarket", side: 0 }] })])[0],
      state(33, 967),
      NOW,
    ),
  ];
  const md = listingsMarkdown(rows, "2026-10-09T03:00:00.000Z", { marketplace: "WagerWire", hedgeVenues: ["Polymarket"], contact: "Michael William, michael@example.com." });
  assert.ok(md.startsWith("# 3 of your listings, priced"));
  assert.ok(md.includes("Prepared for WagerWire."));
  assert.ok(md.includes("**1 of 3 quoted.**"));
  assert.ok(md.includes("3 of 3 listings show no bid"));
  const q = rows[0].quote as ListingLockTerms;
  assert.ok(md.includes("| Ticket | Last leg | Ask | Fair now | Lock: worst / if it hits | Paid now |"), "no bid column when no listing shows a bid");
  assert.ok(md.includes(`| DraftKings 2-leg parlay, pays $3,570, Feb 2027 | Kansas City Chiefs, 26/27 Super Bowl Winner | $210.00 | ${fmtUsd(rows[0].fairCents as number)} | ${fmtUsd(q.lockWorstCents)}${rows[0].lockBeatsAsk ? " (beats the ask)" : ""} / ${fmtUsd(q.lockBestCents)} | ${fmtUsd(q.creditCents)} |`), "the quoted row");
  assert.ok(md.includes("| FanDuel single, pays $52,500, Feb 2027 | Shohei Ohtani, 2026 MLB Cy Young Winner | $7,875.00 | $157.50 | not quoted | none |"), "a refused row still shows fair");
  const withBid = listingsMarkdown([quoteListing(listing({ highestBidCents: 15000 }), state(98, 902), NOW)], "2026-10-09T03:00:00.000Z", { marketplace: "WagerWire" });
  assert.ok(withBid.includes("| Ticket | Last leg | Ask | High bid | Fair now |") && withBid.includes("| $210.00 | $150.00 |"), "the bid column appears when a listing has one");
  assert.ok(withBid.includes("0 of 1 listings show no bid"));
  assert.ok(md.includes("- **FanDuel single, Shohei Ohtani, ask $7,875.00:** the market prices this leg outside the 10c to 92c band"), "refusal in plain words");
  assert.ok(md.includes("- **DraftKings 3-leg parlay, Denver Broncos and Kylian Mbappe, ask $210.00:** two legs still running; we hedge one market, not a product of two, so no number rather than a guess."), "two-leg refusal");
  assert.ok(md.includes(`Hedge: ${(q.hedgeSharesMilli / 1000).toLocaleString("en-US", { maximumFractionDigits: 0 })} shares of Kansas City Chiefs NO`), "the hedge is stated on each quoted ticket");
  assert.ok(md.includes("carried 5 months"), "carry is stated");
  assert.ok(md.includes("we earn the stated take plus the stated carry, whoever wins"), "the identity in words");
  assert.ok(md.includes("Michael William, michael@example.com."));
  assert.ok(!md.includes("\u2014"), "no em dash");
  assert.ok(!/wallet/i.test(md));
});

test("the mockup: drawn from the row whose lock beats the ask; the phone shows the seller's two endings and the credit, never the mechanics", () => {
  const beats = quoteListing(listing(), state(98, 902), NOW);
  assert.equal(beats.lockBeatsAsk, true, "fixture: the lock beats the $210 ask");
  const under = quoteListing(listing({ id: "ORD_under", listedPriceCents: 300_000 }), state(98, 902), NOW);
  assert.equal(under.lockBeatsAsk, false);
  const refused = quoteListing(listing({ id: "ORD_refused" }), state(98, 902, { closed: true }), NOW);
  assert.equal(pickMockRow([under, refused, beats])?.id, "ORD_test", "the lock that beats the ask leads");
  assert.equal(pickMockRow([under, refused])?.id, "ORD_under", "else the quoted row with the highest worst case");
  assert.equal(pickMockRow([refused]), null);
  assert.throws(() => renderListingMockHtml(refused, { brand: "WagerWire", atIso: "2026-10-09T03:00:00.000Z" }), /must be quoted/);

  const html = renderListingMockHtml(beats, { brand: "WagerWire", atIso: "2026-10-09T03:00:00.000Z" });
  const q = beats.quote as ListingLockTerms;
  const phone = html.slice(html.indexOf('<div class="row">'), html.indexOf('<div class="caption">'));
  const caption = html.slice(html.indexOf('<div class="caption">'));
  assert.ok(phone.includes(`Lock in ${fmtUsd(q.lockWorstCents)}`), "the button names the guaranteed amount");
  assert.ok(phone.includes(`${fmtUsd(q.creditCents)} paid to you now`), "and the credit");
  assert.ok(phone.includes(`<b>${fmtUsd(q.lockBestCents)}</b><small>was $3,570</small>`), "the hit ending against the naked payout");
  assert.ok(phone.includes(`<b>${fmtUsd(q.lockWorstCents)}</b><small>was $0</small>`), "the miss ending against zero");
  assert.ok(phone.includes(`The lock's worst case is ${fmtUsd(q.lockWorstCents - 21000)} more than your ask.`));
  assert.ok(phone.includes("Pays $3,570.00") && phone.includes("<b>$210.00</b>") && phone.includes("Feb 15, 2027") && phone.includes("2 &middot; 1 hit"), "the listing as the marketplace shows it");
  assert.ok(phone.includes("Argentina vs Switzerland") && phone.includes("Kansas City Chiefs"));
  assert.ok(!/polymarket|kalshi|hedge|collar|writer|contracts/i.test(phone), "retail copy is outcomes, not mechanics");
  assert.ok(caption.includes(`"worstCents": ${q.lockWorstCents}`) && caption.includes(`"creditCents": ${q.creditCents}`) && caption.includes(`"contracts": 3570`), "the partner caption carries the quote shape");
  assert.ok(caption.includes("?brand=WagerWire"));
  assert.ok(!html.includes("\u2014"), "no em dash");
  assert.ok(!/wallet|foxify/i.test(html));
  assert.ok(!html.includes("<script"), "static: no script");

  const withBid = renderListingMockHtml(quoteListing(listing({ highestBidCents: 15000 }), state(98, 902), NOW), { brand: "Wire Markets", atIso: "2026-10-09T03:00:00.000Z" });
  assert.ok(withBid.includes("<small>Highest bid</small><b>$150.00</b>") && withBid.includes("a high bid of $150.00"));
  assert.ok(withBid.includes("<i>W</i>Wire Markets") && withBid.includes("?brand=Wire%20Markets"));
});
