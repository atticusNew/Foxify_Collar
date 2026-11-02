/**
 * The venue scoreboard: the record folded by New York week into the hedger's comparison of the
 * venues (other side won, edge over the runner-up, availability when asked, refusals), singles
 * and parlays, real taps apart from simulated positions, nothing of the writer's book.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { HedgeRouting, RoutedRoute, SettlementVenue } from "../src/eventCollar/crossVenue/hedgeRouting";
import type { LastLegTicket } from "../src/eventCollar/crossVenue/lastLeg";
import type { ShadowPosition } from "../src/eventCollar/crossVenue/shadowLedger";
import type { RefusalMap } from "../src/eventCollar/crossVenue/shadowRefusals";
import type { HedgeRoute } from "../src/eventCollar/crossVenue/types";
import { SCOREBOARD_METHODOLOGY, venueScoreboard, venueScoreboardCsv, weekLabel, weekMondayOf } from "../src/eventCollar/crossVenue/venueScoreboard";

const NOW = new Date("2026-11-02T18:00:00.000Z"); // Monday Nov 2, 1pm ET

function position(over: Partial<ShadowPosition> & { ticker: string; at: string; route: HedgeRoute }): ShadowPosition {
  return {
    kind: "sports",
    league: "nfl",
    sideName: "Ravens",
    eventTitle: "Jaguars at Ravens",
    eventTimeIso: "2026-11-06T01:15:00.000Z",
    contracts: 100,
    markCents: 62,
    floorCents: 40,
    capCents: 85,
    creditCents: 300,
    evCostBps: 100,
    feesCents: 10,
    takeCents: 50,
    status: "open",
    ...over,
  } as ShadowPosition;
}

const routed = (hedgeVenue: SettlementVenue, ok: boolean, creditCents: number | null, allInBps: number | null): RoutedRoute =>
  ({ route: hedgeVenue === "kalshi" ? "kalshi_self" : hedgeVenue, hedgeVenue, ok, evCostBps: allInBps, tailChargeBps: 0, allInBps, creditCents, terms: ok ? { floorCents: 40, capCents: 85 } : null, compatible: true, sameContract: hedgeVenue === "kalshi", gates: {} as RoutedRoute["gates"], mismatches: [] }) as RoutedRoute;
const routing = (routes: RoutedRoute[]): HedgeRouting => ({ routes } as unknown as HedgeRouting);

const ticket = (quote: Record<string, unknown> | undefined, league = "nfl"): LastLegTicket => ({ ticketId: "t", legs: [{ league: "nba" }, { league }], quote } as unknown as LastLegTicket);

test("weeks are Monday to Sunday in New York; a Sunday night in UTC's Monday stays in its week; labels read as the industry writes them", () => {
  assert.equal(weekMondayOf(Date.parse("2026-10-27T20:00:00Z")), "2026-10-26");
  assert.equal(weekMondayOf(Date.parse("2026-11-02T03:30:00Z")), "2026-10-26", "Sunday 10:30pm ET is still the week of Oct 26");
  assert.equal(weekMondayOf(Date.parse("2026-11-02T06:00:00Z")), "2026-11-02", "Monday 1am ET is the new week");
  assert.equal(weekLabel("2026-10-19"), "Week of Oct 19 – 25");
  assert.equal(weekLabel("2026-10-26"), "Week of Oct 26 – Nov 1");
});

test("venueScoreboard: other side by venue weighted by contracts, the winner's edge over the runner-up, availability when asked, refusals by week, taps apart, parlays by the router's venue", () => {
  const positions: ShadowPosition[] = [
    position({ ticker: "BAL", at: "2026-10-27T20:00:00.000Z", route: "novig", contracts: 100, routing: routing([routed("novig", true, 300, 120), routed("kalshi", true, 240, 200), routed("polymarket", true, 250, 180), routed("prophetx", false, null, null)]) }),
    position({ ticker: "LAL", at: "2026-11-02T03:30:00.000Z", route: "kalshi_self", league: "nba", contracts: 50, routing: routing([routed("kalshi", true, 100, 150), routed("novig", false, null, null)]) }),
    position({ ticker: "SF", at: "2026-10-20T20:00:00.000Z", route: "polymarket", contracts: 200, source: "lock", hedgeCostCents: 7000 }),
    position({ ticker: "OLD", at: "2026-09-01T20:00:00.000Z", route: "polymarket", contracts: 10 }),
  ];
  const refusals: RefusalMap = {
    DEN: { ticker: "DEN", kind: "sports", league: "nfl", sideName: "Broncos", eventTimeIso: "", code: "protection_too_rich", firstAt: "2026-10-29T12:00:00.000Z", lastAt: "2026-10-30T12:00:00.000Z", times: 3 },
    BAL: { ticker: "BAL", kind: "sports", league: "nfl", sideName: "Ravens", eventTimeIso: "", code: "credit_too_small", firstAt: "2026-10-26T12:00:00.000Z", lastAt: "2026-10-26T12:00:00.000Z", times: 1 },
    ARS: { ticker: "ARS", kind: "sports", league: "epl", sideName: "Arsenal", eventTimeIso: "", code: "no_matched_market", firstAt: "2026-10-21T12:00:00.000Z", lastAt: "2026-10-21T12:00:00.000Z", times: 1 },
  };
  const tickets: LastLegTicket[] = [
    ticket({ ok: true, at: "2026-10-30T20:00:00.000Z", contracts: 66, route: "novig", hedgeCostCents: 2500 }),
    ticket({ ok: true, at: "2026-10-30T21:00:00.000Z", contracts: 20 }),
    ticket({ ok: false, at: "2026-10-30T21:00:00.000Z", contracts: 0, code: "no_matched_market" }),
    ticket(undefined),
  ];
  const sb = venueScoreboard({ positions, refusals, tickets, now: NOW, weeks: 3 });
  assert.equal(sb.live, true);
  assert.equal(sb.methodology, SCOREBOARD_METHODOLOGY);
  assert.deepEqual(sb.venues, ["Kalshi", "Polymarket", "ProphetX", "Novig"]);
  assert.deepEqual(sb.weeks.map((w) => w.from), ["2026-11-02", "2026-10-26", "2026-10-19"], "this week first, back to the number of weeks asked");

  const [thisWeek, last, before] = sb.weeks;
  assert.equal(thisWeek.n, 0, "nothing yet this week");
  assert.equal(thisWeek.refusals.refusedPct, null);

  assert.equal(last.label, "Week of Oct 26 – Nov 1");
  assert.equal(last.n, 4, "two singles and two priced parlay tickets");
  assert.equal(last.taps, 0);
  assert.equal(last.contracts, 236);
  assert.equal(last.notionalCents, 2500, "the other side bought, where the record priced it");
  assert.deepEqual(last.singles.otherSide, [
    { venue: "Novig", n: 1, contracts: 100, sharePct: 66.7 },
    { venue: "Kalshi", n: 1, contracts: 50, sharePct: 33.3 },
  ]);
  assert.deepEqual(last.parlays, { n: 2, contracts: 86, otherSide: [{ venue: "Novig", n: 1, contracts: 66, sharePct: 100 }], unrouted: 1 });
  assert.deepEqual(last.edge, { n: 1, byVenue: [{ venue: "Novig", n: 1, avgEdgeCentsPerContract: 0.5, avgEdgeAllInBps: 60 }] }, "Novig paid 50c more than Polymarket's 250 on 100 contracts; 60 bps cheaper all in");
  assert.deepEqual(last.availability, {
    n: 2,
    byVenue: [
      { venue: "Kalshi", asked: 2, priced: 2, pricedPct: 100 },
      { venue: "Novig", asked: 2, priced: 1, pricedPct: 50 },
      { venue: "Polymarket", asked: 1, priced: 1, pricedPct: 100 },
      { venue: "ProphetX", asked: 1, priced: 0, pricedPct: 0 },
    ],
  });
  assert.deepEqual(last.refusals, { refused: 1, offered: 2, priced: 3, refusedPct: 33.3, byReason: [{ reason: "too rich to offer", count: 1 }] }, "a refused market the record later quoted (BAL) is not a refusal");
  assert.deepEqual(last.byLeague.map((l) => [l.league, l.n, l.contracts]), [["nfl", 2, 166], ["nba", 1, 50]], "a parlay counts under its last pick's league");
  assert.deepEqual(last.byLeague[0].otherSide, [{ venue: "Novig", n: 2, contracts: 166, sharePct: 100 }]);
  assert.deepEqual(last.byLeague[1].availability, [{ venue: "Kalshi", asked: 1, priced: 1, pricedPct: 100 }, { venue: "Novig", asked: 1, priced: 0, pricedPct: 0 }]);

  assert.equal(before.label, "Week of Oct 19 – 25");
  assert.equal(before.n, 1);
  assert.equal(before.taps, 1, "a real holder's lock is counted apart");
  assert.equal(before.notionalCents, 7000);
  assert.deepEqual(before.singles.otherSide, [{ venue: "Polymarket", n: 1, contracts: 200, sharePct: 100 }]);
  assert.deepEqual(before.edge, { n: 0, byVenue: [] }, "no route verdicts on the record: no edge claimed");
  assert.deepEqual(before.refusals.byReason, [{ reason: "not a market we protect", count: 1 }]);

  // nothing of the writer's book, and no holder, anywhere in the table
  const keys = new Set<string>();
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { keys.add(k); walk(v); }
  };
  walk(sb);
  for (const k of ["takeCents", "takeShareCents", "writerCents", "writerPnlCents", "holderDeltaCents", "holder", "feesCents", "evCostBps", "hedgeCostCents", "route"]) assert.equal(keys.has(k), false, k);
  assert.equal(/writer|holder|take/i.test(JSON.stringify(sb).replace(SCOREBOARD_METHODOLOGY, "")), false, "no writer-side words outside the methodology");
});

test("venueScoreboardCsv: an all row per week with totals and refusals, a row per venue with shares, edge and availability", () => {
  const positions: ShadowPosition[] = [
    position({ ticker: "BAL", at: "2026-10-27T20:00:00.000Z", route: "novig", contracts: 100, routing: routing([routed("novig", true, 300, 120), routed("kalshi", true, 240, 200)]) }),
  ];
  const sb = venueScoreboard({ positions, refusals: {}, tickets: [], now: NOW, weeks: 2 });
  const csv = venueScoreboardCsv(sb);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "week_from,week_to,week,venue,positions,taps,contracts,other_side_notional_cents,singles_won,singles_contracts,singles_share_pct,parlays_won,parlays_contracts,parlays_share_pct,edge_n,avg_edge_cents_per_contract,avg_edge_all_in_bps,asked,priced,priced_pct,refused,markets_priced,refused_pct");
  assert.equal(lines[1], "2026-11-02,2026-11-08,Week of Nov 2 – 8,all,0,0,0,0,0,0,100,0,0,100,0,,,0,,,0,0,");
  assert.equal(lines[2], "2026-10-26,2026-11-01,Week of Oct 26 – Nov 1,all,1,0,100,0,1,100,100,0,0,100,1,,,1,,,0,1,0");
  assert.equal(lines[3], "2026-10-26,2026-11-01,Week of Oct 26 – Nov 1,Kalshi,,,,,0,0,0,0,0,0,0,,,1,1,100,,,");
  assert.equal(lines[4], "2026-10-26,2026-11-01,Week of Oct 26 – Nov 1,Novig,,,,,1,100,100,0,0,0,1,0.6,80,1,1,100,,,");
  assert.equal(lines.length, 5, "venues never asked and never winning have no row");
});
