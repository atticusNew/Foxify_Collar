import assert from "node:assert/strict";
import { test } from "node:test";

import type { ShadowAltTerms } from "../src/eventCollar/crossVenue/shadowCounterfactuals";
import type { ShadowPosition } from "../src/eventCollar/crossVenue/shadowLedger";
import { VENUE_COLUMNS, refusalWord, venueBreakdown, venueRowFor } from "../src/eventCollar/crossVenue/shadowVenues";

const NOW = new Date("2026-10-24T00:00:00.000Z");

const ok = (creditCents: number, evCostBps = 100): ShadowAltTerms => ({
  ok: true,
  floorCents: 40,
  capCents: 85,
  creditCents,
  grossCreditCents: creditCents + 50,
  takeCents: 50,
  takeRule: "share",
  feesCents: 10,
  hedgeCostCents: 3000,
  hedgeUnitsMilli: 100_000,
  evCostBps,
});
const refused = (code: string): ShadowAltTerms => ({ ok: false, refused: code });

function position(over: Partial<ShadowPosition> & { ticker: string }): ShadowPosition {
  return {
    at: "2026-10-23T20:00:00.000Z",
    kind: "sports",
    league: "nfl",
    sideName: "49ers",
    eventTitle: "49ers vs. Falcons",
    eventTimeIso: "2026-10-26T00:20:00.000Z",
    contracts: 100,
    markCents: 62,
    floorCents: 40,
    capCents: 85,
    creditCents: 300,
    evCostBps: 100,
    route: "polymarket",
    feesCents: 10,
    takeCents: 50,
    status: "open",
    counterfactuals: {
      alternatives: {},
      feeRules: { share_only: ok(300), min_25bps: ok(290) },
      sizeLadder: [],
      routes: { polymarket: ok(300), kalshi_self: ok(260, 140) },
      references: [
        { id: "aggregated_mm", terms: ok(340, 80), bestAskMilli: 370, depthMilli: 2_500_000 },
        { id: "aggregated_other", terms: refused("not_listed"), bestAskMilli: null, depthMilli: 0 },
      ],
    },
    ...over,
  } as ShadowPosition;
}

test("venue row: every column in order, written route marked, best book found, reference ask and depth carried", () => {
  const row = venueRowFor(position({ ticker: "A", bookOrigins: { polymarket: "aggregator", kalshi: "aggregator" } }));
  assert.ok(row);
  assert.deepEqual(
    row.cells.map((c) => c.id),
    VENUE_COLUMNS.map((c) => c.id),
  );
  const by = new Map(row.cells.map((c) => [c.id, c]));
  assert.equal(by.get("polymarket")?.written, true);
  assert.equal(by.get("polymarket")?.deltaCents, 0);
  assert.equal(by.get("kalshi_self")?.creditCents, 260);
  assert.equal(by.get("kalshi_self")?.deltaCents, -40);
  const px = by.get("aggregated_mm")!;
  assert.equal(px.creditCents, 340);
  assert.equal(px.deltaCents, 40);
  assert.equal(px.bestAskCents, 37, "milli dollars to cents per $1");
  assert.equal(px.depthShares, 2500);
  assert.equal(px.listed, true);
  const other = by.get("aggregated_other")!;
  assert.equal(other.read, true);
  assert.equal(other.listed, false);
  assert.equal(other.refused, "not listed");
  assert.equal(by.get("signed_v3")?.read, false, "a venue never configured is unread, not refused");
  assert.equal(row.best, "aggregated_mm", "lowest EV cost (80 bps) wins, which here is also the richest credit");
  assert.deepEqual(row.bookOrigins, { polymarket: "aggregator", kalshi: "aggregator" });
});

test("venue row: crypto and legacy records (no routes) are left out", () => {
  assert.equal(venueRowFor(position({ ticker: "C", kind: "crypto", league: "crypto" })), null);
  const legacy = position({ ticker: "L" });
  legacy.counterfactuals = { ...legacy.counterfactuals!, routes: undefined };
  assert.equal(venueRowFor(legacy), null);
});

test("breakdown: totals per venue, unread columns dropped, routes always kept, origins counted, window and order honoured", () => {
  const positions: ShadowPosition[] = [
    // open, feed-priced, ProphetX cheapest
    position({ ticker: "A", bookOrigins: { polymarket: "aggregator", kalshi: "aggregator" }, eventTimeIso: "2026-10-26T00:20:00.000Z" }),
    // open, direct, Kalshi written and cheapest; ProphetX too thin
    position({
      ticker: "B",
      route: "kalshi_self",
      creditCents: 320,
      bookOrigins: { polymarket: "direct", kalshi: "direct" },
      eventTimeIso: "2026-10-25T17:00:00.000Z",
      counterfactuals: {
        alternatives: {},
        feeRules: { share_only: ok(320), min_25bps: ok(310) },
        sizeLadder: [],
        routes: { polymarket: ok(280, 150), kalshi_self: ok(320, 90) },
        references: [{ id: "aggregated_mm", terms: refused("book_too_thin"), bestAskMilli: 390, depthMilli: 40_000 }],
      },
    }),
    // settled, predates bookOrigins
    position({ ticker: "S", status: "settled", at: "2026-10-20T20:00:00.000Z", settledAt: "2026-10-21T04:00:00.000Z" } as Partial<ShadowPosition> & { ticker: string }),
    // outside the window
    position({ ticker: "OLD", at: "2026-10-01T20:00:00.000Z" }),
    // crypto, out
    position({ ticker: "X", kind: "crypto", league: "crypto" }),
  ];
  const b = venueBreakdown(positions, NOW, { windowDays: 7 });
  assert.equal(b.positions, 3);
  assert.equal(b.sinceIso, "2026-10-20T20:00:00.000Z");
  assert.deepEqual(b.origins, { feed: 1, direct: 1, unknown: 1 });
  assert.deepEqual(
    b.rows.map((r) => r.ticker),
    ["B", "A", "S"],
    "open next-to-lock first, then settled",
  );
  assert.deepEqual(
    b.totals.map((t) => t.id),
    ["kalshi_self", "polymarket", "aggregated_mm", "aggregated_other"],
    "Novig and ProphetX-direct were never read, so their columns are gone; both routes stay",
  );
  assert.deepEqual(
    b.rows.map((r) => r.cells.map((c) => c.id)),
    b.rows.map(() => ["kalshi_self", "polymarket", "aggregated_mm", "aggregated_other"]),
  );
  const t = Object.fromEntries(b.totals.map((x) => [x.id, x]));
  assert.equal(t.kalshi_self.read, 3);
  assert.equal(t.kalshi_self.quoted, 3);
  assert.equal(t.kalshi_self.written, 1);
  assert.equal(t.kalshi_self.best, 1, "on B the market's own No side was the cheapest protection");
  assert.equal(t.polymarket.best, 0);
  assert.equal(t.polymarket.written, 2);
  // ProphetX via feed: read on all three, listed on all three (an ask each time), funded two, cheapest on two (A and S)
  assert.equal(t.aggregated_mm.read, 3);
  assert.equal(t.aggregated_mm.listed, 3);
  assert.equal(t.aggregated_mm.quoted, 2);
  assert.equal(t.aggregated_mm.best, 2);
  assert.equal(t.aggregated_mm.written, 0);
  assert.equal(t.aggregated_mm.bothQuoted, 2);
  assert.equal(t.aggregated_mm.avgDeltaCents, 40, "on the two it funded it paid $0.40 more than the route written");
  assert.equal(t.aggregated_mm.name, "ProphetX");
  assert.equal(t.aggregated_mm.via, "feed");
  // the other venue on the feed: read twice, never listed
  assert.equal(t.aggregated_other.read, 2);
  assert.equal(t.aggregated_other.listed, 0);
  assert.equal(t.aggregated_other.quoted, 0);
  assert.equal(t.aggregated_other.avgDeltaCents, null);
  // kalshi_self vs written over A and S (both written on polymarket at 300, kalshi 260): -40; B is written there so excluded
  assert.equal(t.kalshi_self.bothQuoted, 2);
  assert.equal(t.kalshi_self.avgDeltaCents, -40);
  assert.equal(t.polymarket.bothQuoted, 1);
  assert.equal(t.polymarket.avgDeltaCents, -40, "on B, polymarket would have paid 280 against the 320 written");
});

test("refusal words are short and never leak a code shape the operator has to decode", () => {
  assert.equal(refusalWord("pm_book_too_thin"), "too thin");
  assert.equal(refusalWord("kalshi_book_empty"), "no book");
  assert.equal(refusalWord("route_not_offered"), "not offered");
  assert.equal(refusalWord("winner_market_not_listed"), "not listed");
  assert.equal(refusalWord("stream_unauthorized"), "feed: unauthorized");
  // the feed's mapping states read as states, not as faults
  assert.equal(refusalWord("not_mapped"), "not mapped yet");
  assert.equal(refusalWord("mapped_no_book"), "mapped, no book yet");
  assert.equal(refusalWord("stream_market_not_yet_open"), "mapped, streams ~2d out");
  assert.equal(refusalWord("stream_unavailable"), "feed: unavailable");
  assert.equal(refusalWord("stale"), "stale book");
  assert.equal(refusalWord("unreachable: ECONNRESET"), "unreachable");
});
