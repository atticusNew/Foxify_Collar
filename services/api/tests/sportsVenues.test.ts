/**
 * SPORTS VENUES REPORT: the three venues' game-winner books fold onto the same game and the same
 * two sides, all-in prices carry each venue's fee as it applies now, the consensus and the gaps
 * are arithmetic over the venues' own mids, the cheapest other side and the crosses are net of
 * fees, the window tallies count what they say, and the page shows it without a model.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LEAGUE_TEMPLATES } from "../src/eventCollar/crossVenue/resolutionWhitelist";
import { allIn, crossesOf, devigCents, gapSeries, hedgeOf, readGame, readSlate, takerFeeCents, windowTally } from "../src/sportsVenues/analytics";
import { assembleGames, etDate, kalshiGamesFrom, novigListingFrom, polyUsAliases, polyUsListingFrom, polyUsSlugs } from "../src/sportsVenues/readers";
import { buildReport } from "../src/sportsVenues/report";
import { renderReportHtml } from "../src/sportsVenues/reportHtml";
import { SnapshotStore, toHistoryPoint } from "../src/sportsVenues/store";
import type { Game, Snapshot, VenueListing } from "../src/sportsVenues/types";

const NBA = LEAGUE_TEMPLATES.find((t) => t.league === "nba")!;
const NHL = LEAGUE_TEMPLATES.find((t) => t.league === "nhl")!;
const NOW = Date.parse("2026-11-09T15:00:00Z");
const TIP = "2026-11-10T00:00:00.000Z";

const q = (bid: number, ask: number, bq = 1000, aq = 1000) => ({ bidCents: bid, askCents: ask, bidQty: bq, askQty: aq });
const listing = (venue: VenueListing["venue"], away: ReturnType<typeof q>, home: ReturnType<typeof q>, feeTheta: number, extra: Partial<VenueListing> = {}): VenueListing => ({
  venue,
  id: `${venue}-id`,
  away,
  home,
  feeTheta,
  awayName: "Cleveland Cavaliers",
  homeName: "Charlotte Hornets",
  ...extra,
});
const game = (listings: VenueListing[], startsAt = TIP): Game => ({
  key: "nba:CLE:CHA:2026-11-09",
  league: "nba",
  awayCode: "CLE",
  homeCode: "CHA",
  awayName: "Cleveland Cavaliers",
  homeName: "Charlotte Hornets",
  startsAt,
  startSource: "venue",
  listings,
});

test("kalshi: two team markets fold into one game with the ET date, both sides, and the names; a lone market is not a game", () => {
  const raw = (ticker: string, bid: string, ask: string, sub: string) => ({ ticker, event_ticker: "KXNBAGAME-26NOV09CLECHA", status: "open", close_time: "2026-11-12T00:00:00Z", yes_bid_dollars: bid, yes_ask_dollars: ask, yes_sub_title: sub });
  const games = kalshiGamesFrom(
    [raw("KXNBAGAME-26NOV09CLECHA-CLE", "0.75", "0.76", "Cleveland"), raw("KXNBAGAME-26NOV09CLECHA-CHA", "0.24", "0.25", "Charlotte"), raw("KXNBAGAME-26NOV09LALATL-LAL", "0.48", "0.49", "Lakers")],
    NBA,
    0.07,
  );
  assert.equal(games.length, 1);
  const g = games[0];
  assert.equal(g.game.key, "nba:CLE:CHA:2026-11-09");
  assert.equal(g.game.startSource, "date_only");
  assert.deepEqual(g.tickers, { away: "KXNBAGAME-26NOV09CLECHA-CLE", home: "KXNBAGAME-26NOV09CLECHA-CHA" });
  assert.equal(g.game.listings[0].away.bidCents, 75);
  assert.equal(g.game.listings[0].home.askCents, 25);
  assert.equal(g.game.awayName, "Cleveland Cavaliers");
  // a ticker with a time carries it (ET + 5)
  const timed = kalshiGamesFrom([raw("KXNBAGAME-26NOV091930CLECHA-CLE", "0.75", "0.76", "c"), raw("KXNBAGAME-26NOV091930CLECHA-CHA", "0.24", "0.25", "h")], NBA, 0.07);
  assert.equal(timed[0].game.startsAt, "2026-11-10T00:30:00.000Z");
  assert.equal(timed[0].game.startSource, "venue");
});

test("polymarket us: slugs try the venue's own spelling first, the long side must be one of the two teams, the home side is 1 minus with sizes swapped", () => {
  assert.deepEqual(polyUsAliases("nba", "GSW", NBA).slice(0, 1), ["gs"]);
  assert.equal(polyUsSlugs(game([]), NBA)[0], "nba-cle-cha-2026-11-09");
  const nsh: Game = { ...game([]), league: "nhl", key: "nhl:NSH:LA:2026-11-09", awayCode: "NSH", homeCode: "LA", awayName: "Nashville Predators", homeName: "Los Angeles Kings" };
  assert.equal(polyUsSlugs(nsh, NHL)[0], "nhl-nas-la-2026-11-09");

  const m = { slug: "aec-nba-cle-cha-2026-11-09", sportsMarketType: "nba_full_game_winner", feeCoefficient: 0.095, gameStartTime: TIP, marketSides: [{ long: true, team: { abbreviation: "cle" }, description: "Cavaliers" }, { long: false, team: { abbreviation: "cha" }, description: "Hornets" }] };
  const l = polyUsListingFrom(m, { bidCents: 75, askCents: 76, bidQty: 12469.6, askQty: 245327.23 }, game([]), NBA)!;
  assert.equal(l.away.bidCents, 75);
  assert.equal(l.home.bidCents, 24);
  assert.equal(l.home.askCents, 25);
  assert.equal(l.home.bidQty, 245327.23);
  assert.equal(l.home.askQty, 12469.6);
  assert.equal(l.feeTheta, 0.095);
  // long side the home team: sides flip
  const flipped = polyUsListingFrom({ ...m, marketSides: [{ long: true, team: { abbreviation: "cha" } }, { long: false, team: { abbreviation: "cle" } }] }, { bidCents: 24, askCents: 25, bidQty: 1, askQty: 2 }, game([]), NBA)!;
  assert.equal(flipped.away.bidCents, 75);
  assert.equal(flipped.home.askCents, 25);
  // a long side naming neither team is refused
  assert.equal(polyUsListingFrom({ ...m, marketSides: [{ long: true, team: { abbreviation: "bos" } }] }, { bidCents: 1, askCents: 2, bidQty: 1, askQty: 1 }, game([]), NBA), null);
});

test("novig: outcomes by code, a bid on one side is the ask on the other, sizes in $1 shares, fee 0 before tip and the coefficient once live", () => {
  const m = {
    marketId: "m1",
    eventId: "e1",
    description: "Cavaliers at Hornets",
    marketType: "MONEY",
    status: "OPEN",
    startsTs: Date.parse(TIP),
    fee: { coefficient: "0.06", charged: "WHEN_LIVE" },
    outcomes: [
      { outcomeId: "o1", name: "CLE", status: "OPEN", bid: { price: "0.75", qty: 251393 } },
      { outcomeId: "o2", name: "CHA", status: "OPEN", bid: { price: "0.245", qty: 205865 } },
    ],
  };
  const pre = novigListingFrom(m, game([]), NBA, NOW)!;
  assert.equal(pre.away.bidCents, 75);
  assert.equal(pre.away.askCents, 75.5);
  assert.equal(pre.home.bidCents, 24.5);
  assert.equal(pre.home.askCents, 25);
  assert.equal(pre.away.bidQty, 2513.93);
  assert.equal(pre.away.askQty, 2058.65);
  assert.equal(pre.feeTheta, 0);
  assert.equal(pre.feeThetaLive, 0.06);
  const live = novigListingFrom(m, game([]), NBA, Date.parse(TIP) + 60_000)!;
  assert.equal(live.feeTheta, 0.06);
  assert.equal(novigListingFrom({ ...m, outcomes: [m.outcomes[0]] }, game([]), NBA, NOW), null);
  assert.equal(etDate(Date.parse("2026-11-10T03:30:00Z")), "2026-11-09");
});

test("assemble: other venues' listings fold onto the kalshi game and a venue's start time replaces the date-only one", () => {
  const k = { game: { ...game([listing("kalshi", q(75, 76), q(24, 25), 0.07)], "2026-11-09T17:00:00.000Z"), startSource: "date_only" as const }, tickers: { away: "a", home: "h" } };
  const games = assembleGames([k], new Map([[k.game.key, listing("polymarket_us", q(75, 76), q(24, 25), 0.095, { startsAt: TIP })]]), new Map());
  assert.equal(games[0].listings.length, 2);
  assert.equal(games[0].startsAt, TIP);
  assert.equal(games[0].startSource, "venue");
  const alone = assembleGames([k], new Map(), new Map());
  assert.equal(alone[0].startSource, "date_only");
});

test("all-in: ask plus c·p·(1−p), bid minus it; Novig pre-game carries none; a one-sided book has no mid", () => {
  assert.ok(Math.abs(takerFeeCents(0.07, 50) - 1.75) < 1e-9);
  const k = allIn(listing("kalshi", q(39, 40), q(60, 61), 0.07), "home");
  assert.equal(k.allInAsk, 61 + 1.67);
  assert.equal(k.allInBid, 60 - 1.68);
  assert.equal(k.mid, 60.5);
  const n = allIn(listing("novig", q(40, 40.5), q(59.5, 60), 0), "home");
  assert.equal(n.allInAsk, 60);
  const empty = allIn(listing("kalshi", q(0, 40, 0, 10), q(60, 0, 10, 0), 0.07), "away");
  assert.equal(empty.mid, null);
  assert.equal(empty.allInBid, null);
  assert.equal(empty.allInAsk, 40 + 1.68);
});

test("consensus and gaps: each venue's two mids scaled to 100, averaged; a venue off it is off its peers", () => {
  const k = listing("kalshi", q(17, 19), q(81, 83), 0.07);
  const p = listing("polymarket_us", q(18, 19), q(81, 82), 0.095);
  assert.equal(devigCents(allIn(k, "away"), allIn(k, "home"), "away"), 18);
  assert.equal(devigCents(allIn(p, "away"), allIn(p, "home"), "away"), 18.5);
  const g = readGame(game([k, p]), NOW);
  assert.equal(g.sides.away.consensusCents, 18.25);
  assert.equal(g.sides.away.vsConsensus.kalshi, -0.25);
  assert.equal(g.sides.away.vsConsensus.polymarket_us, 0.25);
  assert.equal(g.sides.away.vsConsensus.novig, null);
  assert.equal(g.sides.home.vsConsensus.kalshi, 0.25);
  // one venue: no consensus
  assert.equal(readGame(game([k]), NOW).sides.away.consensusCents, null);
});

test("cheapest other side: all-in asks on every venue, the cheapest named, the saving against Kalshi's own", () => {
  const k = listing("kalshi", q(39, 40, 500, 9000), q(60, 61, 9500, 143000), 0.07);
  const p = listing("polymarket_us", q(40, 41), q(59, 60, 59204, 64717), 0.095);
  const n = listing("novig", q(40, 40.5), q(59.5, 60, 1110, 13831), 0);
  const byVenue = { kalshi: { away: allIn(k, "away"), home: allIn(k, "home") }, polymarket_us: { away: allIn(p, "away"), home: allIn(p, "home") }, novig: { away: allIn(n, "away"), home: allIn(n, "home") } };
  // holder of the away side (NYR) hedges by buying the home side
  const h = hedgeOf(byVenue, "away");
  assert.equal(h.costs.kalshi, 62.67);
  assert.equal(h.costs.polymarket_us, 62.28);
  assert.equal(h.costs.novig, 60);
  assert.equal(h.cheapest, "novig");
  assert.equal(h.cheapestQty, 13831);
  assert.equal(h.savingCents, 2.67);
  // Kalshi cheapest: saving is 0, not negative
  const k2 = hedgeOf({ ...byVenue, novig: null, polymarket_us: { away: allIn(p, "away"), home: allIn(listing("polymarket_us", q(40, 41), q(62, 63), 0.095), "home") } }, "away");
  assert.equal(k2.cheapest, "kalshi");
  assert.equal(k2.savingCents, 0);
  // no venue quotes the other side
  const none = hedgeOf({ kalshi: null, polymarket_us: null, novig: null }, "away");
  assert.equal(none.cheapest, null);
});

test("crosses: away on one venue plus home on another under 100¢ after both fees, sized at the smaller best level, in dollars", () => {
  const k = listing("kalshi", q(39, 40, 100, 2000), q(58, 59, 100, 500), 0.07);
  const n = listing("novig", q(40, 40.5, 100, 800), q(59.5, 60, 100, 100), 0);
  const byVenue = { kalshi: { away: allIn(k, "away"), home: allIn(k, "home") }, polymarket_us: null, novig: { away: allIn(n, "away"), home: allIn(n, "home") } };
  const xs = crossesOf(byVenue);
  // buy away on Novig at 40.5 (no fee) + home on Kalshi at 59 + 1.69 = 101.19: no; buy away on Kalshi 40 + 1.68 + home on Novig 60 = 101.68: no
  assert.equal(xs.length, 0);
  // Novig's home ask drops to 57.5: 41.68 + 57.5 = 99.18, 0.82¢ locked on 100 shares = $0.82
  const n2 = listing("novig", q(40, 40.5, 100, 800), q(57, 57.5, 100, 100), 0);
  const xs2 = crossesOf({ ...byVenue, novig: { away: allIn(n2, "away"), home: allIn(n2, "home") } });
  assert.equal(xs2.length, 1);
  assert.equal(xs2[0].awayOn, "kalshi");
  assert.equal(xs2[0].homeOn, "novig");
  assert.equal(xs2[0].edgeCents, 0.82);
  assert.equal(xs2[0].qty, 100);
  assert.equal(xs2[0].usd, 0.82);
  // the same venue on both sides is never a cross
  assert.ok(xs2.every((x) => x.awayOn !== x.homeOn));
});

test("game read: overround per venue is both all-in asks minus 100, the tightest named; live once the start has passed", () => {
  const k = listing("kalshi", q(75, 76), q(24, 25), 0.07);
  const n = listing("novig", q(75, 75.5), q(24.5, 25), 0);
  const g = readGame(game([k, n]), NOW);
  assert.equal(g.overround.kalshi, 3.59);
  assert.equal(g.overround.novig, 0.5);
  assert.equal(g.tightest, "novig");
  assert.equal(g.live, false);
  assert.equal(g.minutesToStart, 540);
  assert.deepEqual(g.listed, ["kalshi", "novig"]);
  const live = readGame(game([k, n]), Date.parse(TIP) + 1);
  assert.equal(live.live, true);
  // a date-only placeholder start never reads live
  const dateOnly = readGame({ ...game([k, n], "2026-11-09T17:00:00.000Z"), startSource: "date_only" }, Date.parse("2026-11-09T18:00:00Z"));
  assert.equal(dateOnly.live, false);
  assert.equal(toHistoryPoint({ at: "2026-11-09T18:00:00Z", games: [{ ...game([k, n], "2026-11-09T17:00:00.000Z"), startSource: "date_only" }], health: {} }).starts["nba:CLE:CHA:2026-11-09"], undefined);
});

test("slate: venue tallies count games listed, tightest, other side quoted and cheapest; sides with a choice and those routed off Kalshi", () => {
  const k = listing("kalshi", q(75, 76), q(24, 25), 0.07);
  const p = listing("polymarket_us", q(75, 76), q(24, 25), 0.095);
  const n = listing("novig", q(75, 75.5), q(24.5, 25), 0);
  const g1 = readGame(game([k, p, n]), NOW);
  const g2 = readGame({ ...game([k, p]), key: "nba:LAL:ATL:2026-11-09", awayCode: "LAL", homeCode: "ATL" }, NOW);
  const s = readSlate([g1, g2]);
  assert.equal(s.games, 2);
  assert.equal(s.withTwo, 2);
  assert.equal(s.withThree, 1);
  assert.equal(s.sidesWithChoice, 4);
  // g1: Novig cheapest both sides; g2: Kalshi (0.07) beats Poly (0.095) at the same price
  assert.equal(s.sidesRoutedAway, 2);
  const novig = s.venues.find((v) => v.venue === "novig")!;
  assert.equal(novig.listed, 1);
  assert.equal(novig.tightestCount, 1);
  assert.equal(novig.hedgeCheapest, 2);
  const kalshi = s.venues.find((v) => v.venue === "kalshi")!;
  assert.equal(kalshi.listed, 2);
  assert.equal(kalshi.tightestCount, 1);
  assert.equal(kalshi.hedgeCheapest, 2);
  assert.equal(kalshi.meanSavingCents, 0);
  assert.equal(s.crosses.length, 0);
});

test("store and window: snapshots round-trip, the history cell carries both books and the fee, gaps over time and the tally read it back", () => {
  const dir = mkdtempSync(join(tmpdir(), "sv-"));
  const store = new SnapshotStore(dir, { keepHours: 1 });
  const snap = (at: string, kalshiHomeAsk: number, novigHomeAsk: number): Snapshot => ({
    at,
    games: [game([listing("kalshi", q(39, 40, 100, 2000), q(kalshiHomeAsk - 1, kalshiHomeAsk, 100, 500), 0.07), listing("novig", q(40, 40.5, 100, 800), q(novigHomeAsk - 0.5, novigHomeAsk, 100, 100), 0)])],
    health: { kalshi: { ok: true, ms: 1 }, novig: { ok: true, ms: 1 }, polymarket_us: { ok: false, ms: 1, detail: "x" } },
  });
  store.append(snap("2026-11-09T15:00:00Z", 61, 60));
  store.append(snap("2026-11-09T15:01:00Z", 61, 57.5));
  store.append(snap("2026-11-09T15:02:00Z", 59, 60));
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length, 1);
  const again = new SnapshotStore(dir, { keepHours: 1 });
  assert.equal(again.load(Date.parse("2026-11-09T15:10:00Z")), 3);
  assert.equal(again.getLatest()?.at, "2026-11-09T15:02:00Z");

  const h = toHistoryPoint(snap("2026-11-09T15:00:00Z", 61, 60));
  assert.deepEqual(h.games["nba:CLE:CHA:2026-11-09"].kalshi, [39, 40, 60, 61, 0.07, 100, 2000, 100, 500]);
  assert.equal(h.starts["nba:CLE:CHA:2026-11-09"], Date.parse(TIP));

  const history = again.getHistory();
  const reads = [readGame(again.getLatest()!.games[0], NOW)];
  const gaps = gapSeries(history, reads);
  // away: Kalshi mid 39.5 vs Novig 40.25 → −0.75 each snapshot; home: 60.5 vs 59.75, 60.5 vs 57.25, 58.5 vs 59.75
  const away = gaps.find((g) => g.side === "away" && g.venue === "novig")!;
  assert.equal(away.series.length, 3);
  assert.equal(away.last, -0.75);
  const home = gaps.find((g) => g.side === "home" && g.venue === "novig")!;
  assert.equal(home.max, 3.25);
  assert.equal(home.last, -1.25);

  const w = windowTally(history);
  assert.equal(w.snapshots, 3);
  // snapshot 2: Kalshi away 40 + 1.68 + Novig home 57.5 = 99.18 → a cross; the others none
  assert.equal(w.snapshotsWithCross, 1);
  assert.equal(w.widestCrossCents, 0.82);
  assert.equal(w.widestCross?.awayOn, "kalshi");
  assert.equal(w.widestCross?.homeOn, "novig");
  assert.equal(w.widestCross?.label, "CLE @ CHA");
  // two sides per snapshot with two venues quoting the other side
  assert.equal(w.readings, 6);
  assert.equal(w.liveReadings, 0);
  // holder of away buys home: Kalshi 62.67 / 62.67 / 60.66 vs Novig 60 / 57.5 / 60 → Novig all three; holder of home buys away: Kalshi 41.68 vs Novig 40.5 → Novig
  assert.equal(w.cheapest.novig, 6);
  assert.equal(w.cheapest.kalshi, 0);
  // the same books after tip-off are live readings
  const liveHistory = history.map((p) => ({ ...p, atMs: Date.parse(TIP) + 60_000 }));
  assert.equal(windowTally(liveHistory).liveReadings, 6);
});

test("page: key, tiles, the board with both sides and the cheapest other side, crosses in dollars, the hedger's table, gaps folded, no model, no em dash", () => {
  const k = listing("kalshi", q(39, 40, 100, 2000), q(58, 59, 100, 500), 0.07);
  const n = listing("novig", q(40, 40.5, 100, 800), q(57, 57.5, 100, 100), 0);
  const p = listing("polymarket_us", q(40, 41, 10, 10), q(59, 60, 10, 10), 0.095);
  const snapshot: Snapshot = { at: "2026-11-09T15:02:00Z", games: [game([k, p, n])], health: { kalshi: { ok: true, ms: 300 }, polymarket_us: { ok: true, ms: 400 }, novig: { ok: false, ms: 45000, detail: "no answer within 45s" } } };
  const history = [toHistoryPoint({ ...snapshot, at: "2026-11-09T15:01:00Z" }), toHistoryPoint(snapshot)];
  const d = buildReport({ snapshot, history, intervalSec: 60, collectingSince: "2026-11-09T15:01:00Z" });
  assert.equal(d.games.length, 1);
  assert.equal(d.slate.crosses.length, 1);
  assert.equal(d.slate.crosses[0].usd, 0.82);
  const html = renderReportHtml(d, { refreshSec: 60 });
  for (const needle of [
    "Sports on the event venues",
    'class="tag ref">Reference',
    'class="tag eng">Engine',
    'class="kpis now"',
    "Games with a choice of venue",
    "Cheapest other side, now",
    "Executable crosses after fees",
    "1 · The board",
    "Cleveland Cavaliers at Charlotte Hornets",
    "CLE <small>away</small>",
    "CHA <small>home</small>",
    "fee 7.0%",
    "no fee",
    "Novig</b> 57.50¢ all in",
    "saves 3.19¢",
    "2 · Executable crosses, in dollars",
    "+0.82¢",
    "$1",
    "3 · The hedger",
    "Routed off Kalshi",
    "4 · Gaps over time",
    "with sparklines</summary>",
    "Notes and limits",
    "no answer within 45s",
    "nothing here can place an order",
  ]) {
    assert.ok(html.includes(needle), `page lacks: ${needle}`);
  }
  assert.ok(!/—/.test(html), "no em dash in the page");
  assert.ok(!/fair value column|model-implied/i.test(html));
  // the live flag and the health line
  assert.ok(html.includes('class="bad">novig'));
});
