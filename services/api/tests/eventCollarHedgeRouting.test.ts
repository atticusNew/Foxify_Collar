/**
 * Hedge routing: the rule table and its text parsers, the branch arithmetic, the tail charge,
 * the gates and the choice, and the terms that name the tails.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TAIL_PROBABILITIES,
  branchShortfallCents,
  chooseRoute,
  hedgeVenuesFromEnv,
  kalshiTailCells,
  polymarketTailCells,
  rulesFor,
  tableRules,
  tailCharge,
  tailProbabilitiesFromEnv,
  tailTerms,
  type RouteInput,
  type TailTerms,
} from "../src/eventCollar/crossVenue/hedgeRouting";

// a favorite's collar: mark 60, floor 40, cap 70 -> 0.7 No per contract bought at 40c (28c against 30c of funding)
const TERMS: TailTerms = { floorCents: 40, capCents: 70, markCents: 60, hedgeUnitsPerContractMilli: 700, hedgeAvgPriceCents: 40 };
// an underdog's: mark 35, floor 20, cap 50 -> 0.7 No per contract bought at 66c (46.2c against 50c of funding)
const DOG: TailTerms = { floorCents: 20, capCents: 50, markCents: 35, hedgeUnitsPerContractMilli: 700, hedgeAvgPriceCents: 66 };
const c2 = (n: number): number => Math.round(n * 100) / 100;

test("routing table: every venue and league has four cells with a source and a sentence", () => {
  for (const venue of ["kalshi", "polymarket", "prophetx", "novig"] as const) {
    for (const league of ["nfl", "nba", "mlb", "nhl"]) {
      const row = tableRules(venue, league);
      for (const b of ["tie", "postponed", "abandoned", "corrected"] as const) {
        assert.ok(row[b].source.startsWith("http"), `${venue} ${league} ${b} source`);
        assert.ok(row[b].excerpt.length > 10, `${venue} ${league} ${b} excerpt`);
        assert.equal(typeof row[b].confirmed, "boolean");
      }
    }
  }
  assert.equal(tableRules("kalshi", "nfl").tie.treatment, "half");
  assert.equal(tableRules("kalshi", "nfl").postponed.treatment, "fair");
  assert.equal(tableRules("prophetx", "nfl").tie.treatment, "void");
  assert.equal(tableRules("novig", "nfl").tie.treatment, "half");
  assert.equal(tableRules("polymarket", "nba").postponed.treatment, "hold");
  // NHL rows were read from the live text on 2026-11-02: Kalshi's 48-hour fair-price clause, Polymarket's hold-then-50-50
  assert.equal(tableRules("kalshi", "nhl").postponed.treatment, "fair");
  assert.equal(tableRules("kalshi", "nhl").postponed.confirmed, true);
  assert.equal(tableRules("kalshi", "nhl").postponed.asOf, "2026-11-02");
  assert.equal(tableRules("polymarket", "nhl").postponed.treatment, "hold");
  assert.equal(tableRules("polymarket", "nhl").abandoned.treatment, "half");
  assert.match(tableRules("polymarket", "nhl").abandoned.excerpt, /shootout/);
  assert.equal(tableRules("prophetx", "nhl").tie.treatment, "void");
  assert.equal(tableRules("novig", "nhl").postponed.confirmed, false, "Novig's hockey text was not read; the general rule stands unconfirmed");
  // an unknown league inherits a row with nothing confirmed
  const wnba = tableRules("kalshi", "wnba");
  assert.ok(Object.values(wnba).every((c) => c.confirmed === false));
});

test("routing text: Kalshi's rules_secondary and Polymarket's description read into cells", () => {
  const k = kalshiTailCells(
    "The following market refers to the team who wins the Buffalo vs Minnesota Pro Football game. If the game ends in a tie, the market will resolve to $0.50 for each team. If the game is postponed but begins within 48 hours from its originally scheduled start time, the market will remain open and resolve based on the official final result. If the game is not started within 48 hours, the market will resolve to a fair price.",
    "https://kalshi/x",
    "2026-10-28T00:00:00Z",
  );
  assert.equal(k.tie?.treatment, "half");
  assert.equal(k.postponed?.treatment, "fair");
  assert.equal(k.postponed?.windowHours, 48);
  assert.equal(k.abandoned, undefined);
  assert.ok(k.tie?.excerpt.startsWith("If the game ends in a tie"));

  const kNba = kalshiTailCells("If the game is cancelled or not started within 48 hours of its originally scheduled start, all markets will resolve to a fair price.", "u", "t");
  assert.equal(kNba.postponed?.treatment, "fair");
  assert.equal(kNba.abandoned?.treatment, "fair");

  const kMlb = kalshiTailCells("If the game is cancelled or rescheduled to over two days away, the market will resolve to a fair price in accordance with the rules.", "u", "t");
  assert.equal(kMlb.postponed?.treatment, "fair");
  assert.equal(kMlb.postponed?.windowHours, 48);

  const p = polymarketTailCells(
    "If the game is postponed, this market will remain open until the game has been completed. If the game is canceled entirely, with no make-up game, or ends in a tie, this market will resolve 50-50.",
    "https://pm/x",
    "2026-10-28T00:00:00Z",
  );
  assert.equal(p.postponed?.treatment, "hold");
  assert.equal(p.abandoned?.treatment, "half");
  assert.equal(p.tie?.treatment, "half", "baseball's cancelled sentence names the tie too");

  const p2022 = polymarketTailCells("If the game ends in a tie, this market will resolve 50-50. If the game is not completed by November 13 (11:59:59 PM ET), this market will resolve 50-50.", "u", "t");
  assert.equal(p2022.tie?.treatment, "half");
  assert.equal(p2022.postponed?.treatment, "half");

  // text lays over the table and confirms
  const merged = rulesFor("kalshi", "nfl", kalshiTailCells("If the game is cancelled or not started within 48 hours, all markets will resolve to a fair price.", "u", "t"));
  assert.equal(merged.abandoned.confirmed, true);
  assert.equal(merged.abandoned.source, "u");
  assert.equal(merged.tie.treatment, "half");
});

test("routing arithmetic: the normal branches never show a shortfall, the tails do where the venues differ", () => {
  // a decided game, both sides on the result: nothing owed beyond the design
  assert.equal(branchShortfallCents("stands", "stands", TERMS, "yes"), 0);
  assert.equal(branchShortfallCents("stands", "stands", TERMS, "no"), 0);
  // the same treatment on both sides at a fair price: the hedge comes back at the mark
  assert.equal(branchShortfallCents("fair", "fair", TERMS), 0);
  // tie paid $0.50 a side on both: the hedge pays 35 for a 28 cost -> windfall, no shortfall
  assert.equal(branchShortfallCents("half", "half", TERMS), 0);
  // the holder refunded (ProphetX tie) while the hedge pays half: 0.7 x (40 - 50) < 0 -> windfall
  assert.equal(branchShortfallCents("void", "half", TERMS), 0);
  // an underdog's No is dear: refunded holder, hedge paid half -> 0.7 x (66 - 50) = 11.2c a contract
  assert.equal(c2(branchShortfallCents("void", "half", DOG)), 11.2);
  // the holder's venue settles at fair while the hedge venue keeps the market open: sold at the mark, nothing short
  assert.equal(branchShortfallCents("fair", "hold", TERMS), 0);
  // the holder's market stays open while the hedge was paid half: hedged again at the mark (40) with 50 in hand -> windfall
  assert.equal(branchShortfallCents("hold", "half", TERMS), 0);
  // ... but for the underdog: 0.7 x (65 - 50) = 10.5
  assert.equal(c2(branchShortfallCents("hold", "half", DOG)), 10.5);
  // a corrected result the holder's venue re-settles and the hedge venue leaves standing: the full flip
  assert.ok(branchShortfallCents("resettle", "stands", TERMS, "yes") > 0);
});

test("routing charge: the holder's own market charges nothing; ProphetX against Kalshi prices the tie and the postponement", () => {
  const probs = DEFAULT_TAIL_PROBABILITIES.nfl;
  const same = tailCharge(tableRules("kalshi", "nfl"), tableRules("kalshi", "nfl"), TERMS, probs, true);
  assert.equal(same.compatible, true);
  assert.equal(same.chargeBps, 0);
  assert.ok(same.branches.every((b) => !b.mismatch));

  const px = tailCharge(tableRules("prophetx", "nfl"), tableRules("kalshi", "nfl"), DOG, probs);
  const byBranch = Object.fromEntries(px.branches.map((b) => [b.branch, b]));
  assert.equal(byBranch.tie.mismatch, true, "void against half");
  assert.equal(byBranch.postponed.mismatch, true, "void against fair");
  assert.equal(byBranch.corrected.mismatch, true, "resettle against stands");
  assert.ok(px.chargeBps > 0);
  assert.equal(px.compatible, false);
  // the favorite's collar passes the same tails: the hedge's No was cheap, so being paid half or refunded is a windfall
  const fav = tailCharge(tableRules("prophetx", "nfl"), tableRules("kalshi", "nfl"), TERMS, probs);
  assert.equal(fav.branches.find((b) => b.branch === "tie")?.shortfallCents, 0);
  // the unconfirmed Kalshi 'abandoned' cell is priced at its worst reading and says so
  assert.match(byBranch.abandoned.note, /not confirmed/);
  assert.ok(byBranch.abandoned.shortfallCents > 0);
});

test("routing choice: cheapest all in among routes that pass the gates, ties to Kalshi, the pinned route named for what it costs", () => {
  const holderRules = tableRules("prophetx", "nfl");
  const base = (route: "kalshi_self" | "polymarket", evCostBps: number, extra: Partial<RouteInput> = {}): RouteInput => ({
    route,
    ok: true,
    evCostBps,
    hedge: { unitsMilli: 7_000, avgPriceCents: 40, floorCents: 40, capCents: 70 },
    gates: { gameMatch: true, venueOpen: true, executable: true },
    rules: tableRules(route === "kalshi_self" ? "kalshi" : "polymarket", "nfl"),
    ...extra,
  });
  const inputs = {
    holderVenue: "prophetx" as const,
    league: "nfl",
    holderRules,
    markCents: 60,
    contracts: 10,
    probabilities: DEFAULT_TAIL_PROBABILITIES.nfl,
  };

  // same EV on the books: Kalshi wins the tie
  const tie = chooseRoute({ ...inputs, routes: [base("polymarket", 20), base("kalshi_self", 20)] });
  assert.equal(tie.chosen, "kalshi_self");
  assert.match(tie.reason, /Kalshi's own No side/);
  assert.equal(tie.routes.length, 2);
  assert.ok(tie.routes.every((r) => r.allInBps !== null && r.tailChargeBps !== null));

  // Polymarket much cheaper on the books: it wins all in
  const pm = chooseRoute({ ...inputs, routes: [base("polymarket", -40), base("kalshi_self", 20)] });
  assert.equal(pm.chosen, "polymarket");
  assert.match(pm.reason, /^Polymarket: cheaper all in/);

  // a gate failing on the cheaper route hands the choice to the other, and the reason says why
  const closed = chooseRoute({ ...inputs, routes: [base("polymarket", -40, { gates: { gameMatch: true, venueOpen: false, executable: true } }), base("kalshi_self", 20)] });
  assert.equal(closed.chosen, "kalshi_self");
  assert.match(closed.reason, /closes before the lock/);
  assert.equal(closed.routes.find((r) => r.route === "polymarket")?.gates.detail, "the venue's market closes before the lock");

  // a thin book is the depth gate
  const thin = chooseRoute({ ...inputs, routes: [{ ...base("polymarket", 0), ok: false, evCostBps: null, hedge: undefined, refusalCode: "pm_book_too_thin", refusalDetail: "12 of 65 shares" }, base("kalshi_self", 20)] });
  assert.equal(thin.chosen, "kalshi_self");
  assert.equal(thin.routes.find((r) => r.route === "polymarket")?.gates.depth, false);

  // pinned to Kalshi while Polymarket is cheaper: Kalshi, and the reason owns the difference
  const pinned = chooseRoute({ ...inputs, pinned: "kalshi_self", routes: [base("polymarket", -40), base("kalshi_self", 20)] });
  assert.equal(pinned.chosen, "kalshi_self");
  assert.match(pinned.reason, /the venue the hedge can be sent to tonight/);
  assert.match(pinned.reason, /ours to carry/);

  // nothing passes
  const none = chooseRoute({ ...inputs, routes: [{ ...base("polymarket", 0), ok: false, evCostBps: null, refusalCode: "pm_book_empty", refusalDetail: "unreachable" }, { ...base("kalshi_self", 0), ok: false, evCostBps: null, refusalCode: "kalshi_book_too_thin", refusalDetail: "thin" }] });
  assert.equal(none.chosen, null);
  assert.match(none.reason, /unreachable/);
  assert.equal(none.probabilities.estimate, true);
});

test("routing choice, three routes: ProphetX competes against Kalshi on the holder's own venue; the credit rides on every route; the reason names both others", () => {
  const route = (r: "kalshi_self" | "polymarket" | "prophetx", evCostBps: number, creditCents: number, extra: Partial<RouteInput> = {}): RouteInput => ({
    route: r,
    ok: true,
    evCostBps,
    creditCents,
    hedge: { unitsMilli: 7_000, avgPriceCents: 40, floorCents: 40, capCents: 70 },
    gates: { gameMatch: true, venueOpen: true, executable: true },
    rules: tableRules(r === "kalshi_self" ? "kalshi" : r === "polymarket" ? "polymarket" : "prophetx", "nba"),
    ...extra,
  });
  const inputs = { holderVenue: "novig" as const, league: "nba", holderRules: tableRules("novig", "nba"), markCents: 60, contracts: 10, probabilities: DEFAULT_TAIL_PROBABILITIES.nba };

  // tonight's two venues: ProphetX pays more for the same protection and wins
  const px = chooseRoute({ ...inputs, routes: [route("kalshi_self", 20, 240), route("prophetx", -30, 310)] });
  assert.equal(px.chosen, "prophetx");
  assert.match(px.reason, /^ProphetX: cheaper all in/);
  assert.deepEqual(
    px.routes.map((r) => [r.route, r.hedgeVenue, r.creditCents, r.terms?.floorCents, r.terms?.capCents]),
    [
      ["kalshi_self", "kalshi", 240, 40, 70],
      ["prophetx", "prophetx", 310, 40, 70],
    ],
  );
  // ProphetX not executable tonight (no TRADE key): Kalshi, and the reason says what gate held ProphetX
  const gated = chooseRoute({ ...inputs, routes: [route("kalshi_self", 20, 240), route("prophetx", -30, 310, { gates: { gameMatch: true, venueOpen: true, executable: false } })] });
  assert.equal(gated.chosen, "kalshi_self");
  assert.match(gated.reason, /ProphetX/);
  assert.match(gated.reason, /cannot be sent|executor|send/i);
  // all three offered: the reason names the two not taken
  const three = chooseRoute({ ...inputs, routes: [route("kalshi_self", 20, 240), route("polymarket", 10, 260), route("prophetx", -30, 310)] });
  assert.equal(three.chosen, "prophetx");
  assert.match(three.reason, /Kalshi/);
  assert.match(three.reason, /Polymarket/);
  assert.equal(three.routes.length, 3);
  // a route not offered tonight is a refusal with its own code
  const off = chooseRoute({ ...inputs, routes: [route("kalshi_self", 20, 240), { ...route("polymarket", 0, 0), ok: false, evCostBps: null, creditCents: null, hedge: undefined, refusalCode: "route_not_offered", refusalDetail: "Polymarket is not offered as a hedge venue tonight (EVENT_HEDGE_VENUES)" }] });
  assert.equal(off.chosen, "kalshi_self");
  assert.equal(off.routes.find((r) => r.route === "polymarket")?.creditCents, null);
});

test("routing venues: EVENT_HEDGE_VENUES names the routes offered tonight; unset offers all three; unknown words are reported, never guessed", () => {
  assert.deepEqual(hedgeVenuesFromEnv({}), { routes: ["kalshi_self", "polymarket", "prophetx", "novig"], source: "default", unknown: [] });
  assert.deepEqual(hedgeVenuesFromEnv({ EVENT_HEDGE_VENUES: "kalshi,prophetx" }), { routes: ["kalshi_self", "prophetx"], source: "env", unknown: [] });
  assert.deepEqual(hedgeVenuesFromEnv({ EVENT_HEDGE_VENUES: " Kalshi_self , Poly, prophet, kalshi " }), { routes: ["kalshi_self", "polymarket", "prophetx"], source: "env", unknown: [] });
  assert.deepEqual(hedgeVenuesFromEnv({ EVENT_HEDGE_VENUES: "kalshi,novig,draftkings" }), { routes: ["kalshi_self", "novig"], source: "env", unknown: ["draftkings"] });
  assert.deepEqual(hedgeVenuesFromEnv({ EVENT_HEDGE_VENUES: "kalshi,prophetx,novig" }), { routes: ["kalshi_self", "prophetx", "novig"], source: "env", unknown: [] });
  assert.deepEqual(hedgeVenuesFromEnv({ EVENT_HEDGE_VENUES: "   " }).source, "default");
});

test("routing terms: the tails in the holder's venue's words", () => {
  const px = tailTerms("prophetx", tableRules("prophetx", "nfl"));
  assert.equal(px.length, 4);
  assert.match(px[0].text, /^If the game ends in a tie, ProphetX voids the position and returns your stake; the protection is void with it/);
  assert.match(px[1].text, /not played within 7 days/);
  assert.match(px[3].text, /settles again on the corrected result/);
  const k = tailTerms("kalshi", tableRules("kalshi", "nfl"));
  assert.match(k[0].text, /Kalshi pays each side \$0\.50/);
  assert.match(k[1].text, /within 48 hours/);
  assert.match(k[1].text, /fair price/);
  const pm = tailTerms("polymarket", tableRules("polymarket", "nba"));
  assert.match(pm[1].text, /^If the game is postponed, Polymarket keeps the market open/);
});

test("routing probabilities: the env overrides one league's cells and leaves the rest", () => {
  const t = tailProbabilitiesFromEnv({ EVENT_ROUTING_TAIL_PROBS: JSON.stringify({ nfl: { tie: 0.01 }, nhl: { postponed: 0.004 } }) } as NodeJS.ProcessEnv);
  assert.equal(t.nfl.tie, 0.01);
  assert.equal(t.nfl.postponed, DEFAULT_TAIL_PROBABILITIES.nfl.postponed);
  assert.equal(t.nhl.postponed, 0.004);
  assert.equal(t.mlb.postponed, DEFAULT_TAIL_PROBABILITIES.mlb.postponed);
  assert.deepEqual(tailProbabilitiesFromEnv({ EVENT_ROUTING_TAIL_PROBS: "not json" } as NodeJS.ProcessEnv), DEFAULT_TAIL_PROBABILITIES);
});
