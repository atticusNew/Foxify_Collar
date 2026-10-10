/**
 * Parlays on the demo and the record: the last-leg shadow's tickets in retail shape, the
 * three-state row, the lock-sell-hold card on the public record, and the Parlays tab.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  comboPriceMilli,
  compressedContracts,
  lockVersusSell,
  momentRecord,
  quoteLastLeg,
  replayLastLeg,
  sharesFor,
  summarizeLastLeg,
  type LastLegRecord,
  type LastLegTicketRecord,
} from "../src/eventCollar/crossVenue/lastLeg";
import { PARLAY_REFUSAL_SHORT, PARLAY_REFUSAL_WORDS, refusalShort, refusalWords, retailParlayTicket, retailParlays } from "../src/eventCollar/crossVenue/parlayRetail";
import { pickWords, shortClub } from "../src/eventCollar/crossVenue/pickWords";
import { legWords } from "../src/eventCollar/crossVenue/lastLeg";
import { EVENT_ACTIONS, isEventAction, isValidTicker } from "../src/eventCollar/crossVenue/eventFunnel";
import { forbiddenKeysIn } from "../src/eventCollar/retailShowcase";
import { summarizeShadow } from "../src/eventCollar/crossVenue/shadowLedger";
import { DEFAULT_CROSS_CONFIG, type PmBook } from "../src/eventCollar/crossVenue/types";
import { parlayMomentCard, renderShadowHtml } from "../scripts/eventShadowHtml";
import { renderEventEmbedHtml } from "../scripts/eventProtectEmbedHtml";

const FRI_NOON = Date.UTC(2026, 9, 9, 12, 0, 0);
const SAT_13 = Date.UTC(2026, 9, 10, 13, 0, 0);
const SAT_16 = Date.UTC(2026, 9, 10, 16, 0, 0);
const SAT_20 = Date.UTC(2026, 9, 10, 20, 0, 0);
const SUN_20 = Date.UTC(2026, 9, 11, 20, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();

const ticketRec = (id: string, legs: Array<[string, number, 0 | 1, number]>, at = iso(FRI_NOON)): LastLegTicketRecord => {
  const price = comboPriceMilli(legs.map((l) => l[1]));
  return {
    type: "ticket",
    at,
    ticketId: id,
    stakeCents: 2_000,
    legs: legs.map(([cond, priceMilli, side, startMs]) => ({
      conditionId: cond,
      slug: `nfl-${cond}`,
      title: `${cond} game`,
      league: "nfl",
      side,
      outcome: side === 0 ? "Away" : "Home",
      priceMilli,
      yesTokenId: `${cond}-t${side}`,
      noTokenId: `${cond}-t${1 - side}`,
      gameStartIso: iso(startMs),
    })),
    comboPriceMilli: price,
    sharesMilli: sharesFor(2_000, price),
  };
};
const lines = (recs: LastLegRecord[]): string[] => recs.map((r) => JSON.stringify(r));
const noBook = (tokenId: string, askMilli: number, sizeShares = 100_000): PmBook => ({
  tokenId,
  asks: [{ priceMilli: askMilli, sizeMilli: sizeShares * 1000 }],
  bids: [{ priceMilli: askMilli - 20, sizeMilli: sizeShares * 1000 }],
  minOrderSizeShares: 5,
  tickMilli: 10,
});
const hit = (id: string, cond: string, at: number): LastLegRecord => ({ type: "leg", at: iso(at), ticketId: id, conditionId: cond, valueMilli: 1000 });
const miss = (id: string, cond: string, at: number): LastLegRecord => ({ type: "leg", at: iso(at), ticketId: id, conditionId: cond, valueMilli: 0 });

/** A ledger with one ticket in every state the row knows. */
function fixture() {
  const open3 = ticketRec("ll_open", [["A", 700, 0, SAT_13], ["B", 650, 1, SAT_16], ["D", 600, 0, SUN_20]]);
  const last = ticketRec("ll_last", [["A", 700, 0, SAT_13], ["E", 600, 0, SUN_20]]);
  const refused = ticketRec("ll_refused", [["B", 650, 1, SAT_16], ["F", 600, 1, SUN_20]]);
  const pending = ticketRec("ll_pending", [["C", 800, 0, SAT_20], ["G", 600, 0, SUN_20]]);
  const busted = ticketRec("ll_busted", [["A", 700, 0, SAT_13], ["H", 600, 0, SUN_20]]);
  const settledHit = ticketRec("ll_hit", [["A", 700, 0, SAT_13], ["I", 600, 0, SAT_20 + 3_600_000]]);
  const settledMiss = ticketRec("ll_miss", [["A", 700, 0, SAT_13], ["J", 600, 0, SAT_20 + 3_600_000]]);
  const settledNoLock = ticketRec("ll_nolock", [["A", 700, 0, SAT_13], ["K", 600, 0, SAT_20 + 3_600_000]]);
  const quoteFor = (t: LastLegTicketRecord, lastCond: string, minutesToStart: number, at: number) => {
    const contracts = compressedContracts(t.sharesMilli, 1000);
    const q = quoteLastLeg({ contracts, markCents: 60, entryCents: 30, minutesToStart, noBook: noBook(`${lastCond}-t1`, 410), noOutcome: "Home", config: DEFAULT_CROSS_CONFIG });
    assert.ok(q.ok, q.ok ? "" : q.detail);
    return momentRecord({ at: iso(at), ticketId: t.ticketId, minutesToStart, decidedProductMilli: 1000, contracts, markCents: 60, entryCents: 30 }, q);
  };
  const qLast = quoteFor(last, "E", 480, SUN_20 - 8 * 3_600_000);
  const qHit = quoteFor(settledHit, "I", 180, SAT_20 - 2 * 3_600_000);
  const qMiss = quoteFor(settledMiss, "J", 180, SAT_20 - 2 * 3_600_000);
  const refusal = momentRecord(
    { at: iso(SUN_20 - 8 * 3_600_000), ticketId: "ll_refused", minutesToStart: 480, decidedProductMilli: 1000, contracts: 30, markCents: 60, entryCents: 30 },
    { ok: false, code: "pm_book_empty", detail: "no asks" },
  );
  const tickets = replayLastLeg(
    lines([
      open3,
      last,
      refused,
      pending,
      busted,
      settledHit,
      settledMiss,
      settledNoLock,
      hit("ll_open", "A", SAT_16),
      hit("ll_last", "A", SAT_16),
      qLast,
      hit("ll_refused", "B", SAT_20),
      refusal,
      refusal,
      hit("ll_pending", "C", SAT_20 + 3 * 3_600_000),
      miss("ll_busted", "A", SAT_16),
      hit("ll_hit", "A", SAT_16),
      qHit,
      hit("ll_hit", "I", SUN_20 - 20 * 3_600_000),
      hit("ll_miss", "A", SAT_16),
      qMiss,
      miss("ll_miss", "J", SUN_20 - 19 * 3_600_000),
      hit("ll_nolock", "A", SAT_16),
      hit("ll_nolock", "K", SUN_20 - 18 * 3_600_000),
    ]),
  );
  return { tickets, qLast, qHit, qMiss, last, settledHit };
}

test("retailParlayTicket: picks with their marks, the three row states, the lock's two endings with the credit inside, and what settled paid", () => {
  const { tickets, qLast, qHit, last, settledHit } = fixture();
  const by = Object.fromEntries(tickets.map((t) => [t.ticketId, retailParlayTicket(t)]));

  const open = by.ll_open;
  assert.equal(open.state, "open");
  assert.equal(open.picksOpen, 2, "two picks open: the lock is not offered");
  assert.deepEqual(open.picks.map((p) => p.state), ["hit", "open", "open"]);
  assert.equal(open.nextStartIso, iso(SAT_16), "the earliest open pick");
  assert.equal(open.lock, null);
  assert.equal(open.lockRefused, null);
  assert.equal(open.result, null);
  assert.equal(open.paysCents, compressedContracts(tickets.find((t) => t.ticketId === "ll_open")!.sharesMilli, 1000) * 100, "whole contracts, the basis the lock and the settled lines use");
  assert.deepEqual(open.picks[0], { outcome: "Away", versus: "A game", game: "A game", league: "nfl", startsIso: iso(SAT_13), state: "hit" });

  const atLast = by.ll_last;
  assert.equal(atLast.state, "last_pick");
  assert.equal(atLast.picksOpen, 1);
  assert.ok(atLast.lock);
  const contracts = compressedContracts(last.sharesMilli, 1000);
  assert.deepEqual(atLast.lock, {
    quotedAt: qLast.at,
    hoursBefore: 8,
    worthCents: qLast.ticketValueCents,
    floorTotalCents: (qLast.floorCents as number) * contracts + (qLast.creditCents as number),
    capTotalCents: (qLast.capCents as number) * contracts + (qLast.creditCents as number),
    creditCents: qLast.creditCents,
  });
  assert.ok(atLast.lock!.floorTotalCents > 0 && atLast.lock!.capTotalCents > atLast.lock!.floorTotalCents);
  assert.equal(atLast.lockRefused, null);

  const refused = by.ll_refused;
  assert.equal(refused.state, "last_pick");
  assert.equal(refused.lock, null);
  assert.equal(refused.lockRefused, "no one is offering the other side of the last pick right now", "the refusal in the bettor's words, not the code");
  assert.equal(refused.lockRefusedShort, "other side not on offer", "the same reason at row length");

  const pending = by.ll_pending;
  assert.equal(pending.state, "last_pick");
  assert.equal(pending.lock, null);
  assert.equal(pending.lockRefused, null, "no attempt yet: nothing to explain");
  assert.equal(pending.lockRefusedShort, null);

  const busted = by.ll_busted;
  assert.equal(busted.state, "busted");
  assert.deepEqual(busted.result, { hit: false, ticketPaidCents: 0, lockPaidCents: null });
  assert.deepEqual(busted.picks.map((p) => p.state), ["miss", "open"]);
  assert.equal(busted.decidedAt, iso(SAT_16));

  const won = by.ll_hit;
  assert.equal(won.state, "settled");
  const c2 = compressedContracts(settledHit.sharesMilli, 1000);
  assert.deepEqual(won.result, { hit: true, ticketPaidCents: c2 * 100, lockPaidCents: (qHit.capCents as number) * c2 + (qHit.creditCents as number) });
  assert.ok(won.result!.lockPaidCents! < won.result!.ticketPaidCents, "a hit gives up the cap");
  const lost = by.ll_miss;
  assert.equal(lost.result!.hit, false);
  assert.equal(lost.result!.ticketPaidCents, 0);
  assert.ok(lost.result!.lockPaidCents! > 0, "a miss keeps the floor");
  const noLock = by.ll_nolock;
  assert.equal(noLock.result!.hit, true);
  assert.equal(noLock.result!.lockPaidCents, null, "never quoted: the ticket alone");
});

test("retailParlays: at the last pick first (priced before refused), then open by next game, then decided most recent first; summary counts; no hedge words anywhere", () => {
  const { tickets } = fixture();
  const payload = retailParlays(tickets, summarizeLastLeg(tickets), lockVersusSell(tickets));
  assert.deepEqual(
    payload.tickets.map((t) => t.id),
    ["ll_last", "ll_pending", "ll_refused", "ll_open", "ll_nolock", "ll_miss", "ll_hit", "ll_busted"],
    "the list a bettor would scroll",
  );
  const s = payload.summary;
  assert.equal(s.tickets, 8);
  assert.equal(s.inPlay, 4);
  assert.equal(s.atLastPick, 3);
  assert.equal(s.locksPriced, 3);
  assert.equal(s.refusedOnly, 0, "ll_refused is still in play and may yet be quoted; it counts as refused only once it settles unquoted");
  assert.equal(s.busted, 1);
  assert.deepEqual(s.refusals, { "no one is offering the other side of the last pick right now": 2 });
  assert.equal(s.settled.count, 3);
  assert.equal(s.settled.withLock, 2);
  assert.equal(s.settled.floorSaves, 1);
  assert.equal(s.settled.capGiveups, 1);
  assert.equal(s.settled.identityHolds, true, "our P&L on the two locked settlements is the take");
  assert.ok(s.creditsCents > 0);
  assert.equal(s.settled.lockBeatSell, 1, "the miss: the floor beat selling at fair");
  assert.deepEqual(forbiddenKeysIn(payload), [], "retail shape end to end: no legs, tokens, take or hedge cost");
  assert.ok(!JSON.stringify(payload).includes("-t1"), "no token ids leak through strings either");

  const capped = retailParlays(tickets, summarizeLastLeg(tickets), lockVersusSell(tickets), 2);
  assert.equal(capped.tickets.length, 6, "in play is never cut; decided is capped");
  const empty = retailParlays([], summarizeLastLeg([]), lockVersusSell([]));
  assert.equal(empty.tickets.length, 0);
  assert.equal(empty.summary.settled.identityHolds, null);
});

test("refusal words: every refusal code the collar search can return has retail words, long and short; unknown codes read as words, not snake_case", () => {
  for (const code of ["credit_nonpositive", "protection_too_rich", "credit_too_small", "pm_book_empty", "pm_book_too_thin", "market_too_close_to_start", "mark_out_of_range", "no_matched_market", "resolution_mismatch", "kalshi_book_empty", "kalshi_book_too_thin"]) {
    assert.ok(PARLAY_REFUSAL_WORDS[code], code);
    assert.ok(PARLAY_REFUSAL_SHORT[code], code);
    assert.ok(!/_/.test(PARLAY_REFUSAL_WORDS[code]) && !/_/.test(PARLAY_REFUSAL_SHORT[code]));
    assert.ok(!/polymarket|kalshi|token|hedge|writer|book/i.test(PARLAY_REFUSAL_WORDS[code] + PARLAY_REFUSAL_SHORT[code]), `${code}: no venue or mechanics in the bettor's words`);
    assert.ok(PARLAY_REFUSAL_SHORT[code].length <= 32, `${code}: the short form fits one row clause`);
    assert.ok(PARLAY_REFUSAL_SHORT[code].length < PARLAY_REFUSAL_WORDS[code].length || PARLAY_REFUSAL_SHORT[code] === PARLAY_REFUSAL_WORDS[code], code);
  }
  assert.equal(refusalWords("some_new_code"), "some new code");
  assert.equal(refusalShort("some_new_code"), "some new code", "no short form: the long words, never the code");
});

test("pick words: team picks read 'Cowboys vs Buccaneers' and 'Dodgers at Padres'; soccer Yes/No markets read 'Brighton & Hove Albion to win'; anything else keeps the venue's title", () => {
  assert.deepEqual(pickWords("Cowboys", "Buccaneers vs. Cowboys"), { outcome: "Cowboys", versus: "vs Buccaneers" });
  assert.deepEqual(pickWords("Buccaneers", "Buccaneers vs. Cowboys"), { outcome: "Buccaneers", versus: "vs Cowboys" });
  assert.deepEqual(pickWords("Dodgers", "Dodgers at Padres"), { outcome: "Dodgers", versus: "at Padres" });
  assert.deepEqual(pickWords("Padres", "Dodgers at Padres"), { outcome: "Padres", versus: "vs Dodgers" });
  assert.deepEqual(pickWords("No", "Will Brighton & Hove Albion FC win on 2026-10-10?"), { outcome: "Brighton & Hove Albion not to win", versus: "" });
  assert.deepEqual(pickWords("Yes", "Will Manchester United FC win on 2026-10-10?"), { outcome: "Manchester United to win", versus: "" });
  assert.deepEqual(pickWords("Yes", "Will AFC Bournemouth win on 2026-10-11?"), { outcome: "Bournemouth to win", versus: "" });
  assert.deepEqual(pickWords("Away", "A game"), { outcome: "Away", versus: "A game" }, "an outcome that is not a side of the title keeps the title");
  assert.deepEqual(pickWords("Yes", "Will it rain?"), { outcome: "Yes", versus: "Will it rain?" }, "a Yes/No that is not a win market is left alone");
  assert.equal(shortClub("Brighton & Hove Albion FC"), "Brighton & Hove Albion");
  assert.equal(shortClub("FC Barcelona"), "Barcelona");
  assert.equal(shortClub("Inter Miami CF"), "Inter Miami");
  assert.equal(legWords({ outcome: "Cowboys", title: "Buccaneers vs. Cowboys" }), "Cowboys vs Buccaneers");
  assert.equal(legWords({ outcome: "No", title: "Will Brighton & Hove Albion FC win on 2026-10-10?" }), "Brighton & Hove Albion not to win");
  // the retail pick and the record row both go through it
  const t = ticketRec("ll_words", [["A", 700, 0, SAT_13], ["B", 650, 1, SUN_20]]);
  t.legs[0].outcome = "Cowboys";
  t.legs[0].title = "Buccaneers vs. Cowboys";
  t.legs[1].outcome = "No";
  t.legs[1].title = "Will Brighton & Hove Albion FC win on 2026-10-11?";
  const retail = retailParlayTicket(replayLastLeg(lines([t]))[0]);
  assert.deepEqual(retail.picks.map((p) => [p.outcome, p.versus]), [["Cowboys", "vs Buccaneers"], ["Brighton & Hove Albion not to win", ""]]);
  assert.equal(retail.picks[1].game, "Will Brighton & Hove Albion FC win on 2026-10-11?", "the venue's title stays on the pick for anyone who wants it");
});

test("public record: the parlay card reads lock, sell or hold with refusals counted and the identity checked; absent when the shadow is off", () => {
  const { tickets } = fixture();
  const parlays = { lockVsSell: lockVersusSell(tickets), lastLeg: summarizeLastLeg(tickets), stakeCents: 2_000 };
  const card = parlayMomentCard(parlays);
  assert.ok(card.includes("Lock, sell or hold: the parlay moment"));
  assert.ok(card.includes('<div class="n">8</div><div class="l">tickets built</div>'));
  assert.ok(card.includes('<div class="n green">3</div><div class="l">priced a lock</div>'));
  assert.ok(card.includes("3 tickets reached the last leg with a priced lock"));
  assert.ok(card.includes("On the 2 settled, locking paid"));
  assert.ok(card.includes("the lock beat the sell on 1, and holding beat both on 1"));
  assert.ok(card.includes("2 legs · Away · E game") && card.includes("8h before"));
  assert.ok(card.includes("last leg not played yet"));
  assert.ok(card.includes("Lock not offered, and why, across 5 attempts:"), "refusals are counted against every attempt, priced ones included");
  assert.ok(card.includes("<span>no one is offering the other side of the last pick right now</span><b>2</b>"), "refusal reasons in the bettor's words");
  assert.ok(card.includes("A ticket with two or more legs still open is never quoted"), "why there is no lock before the last pick");
  assert.ok(card.includes("On 2 settled locked tickets our P&amp;L is") && card.includes("the identity holds, we carried no outcome risk on the last pick."));
  assert.ok(!/writer|holder|tokenId|hedgeCost/.test(card), "public words");
  assert.ok(!card.includes("\u2014"), "no em dash");

  const page = renderShadowHtml({ atIso: "2026-10-11T00:00:00.000Z", summary: summarizeShadow([]), open: [], settled: [], closed: [], parlays });
  assert.ok(page.includes("Lock, sell or hold: the parlay moment"));
  assert.ok(page.includes("<b>Simulated:</b> the positions and the parlay tickets;"));
  assert.ok(page.includes('<a class="back" href="/api/shadow/parlays">Parlays (JSON)</a>'));
  const idx = page.indexOf("the parlay moment");
  assert.ok(idx > page.indexOf("With and without protection") && idx < page.indexOf("Where protection is cheap"), "sits between the settled comparison and the slices");

  const off = renderShadowHtml({ atIso: "2026-10-11T00:00:00.000Z", summary: summarizeShadow([]), open: [], settled: [], closed: [] });
  assert.ok(!off.includes("parlay"), "no card and no link when the last-leg shadow is off");

  const young = parlayMomentCard({ lockVsSell: lockVersusSell([]), lastLeg: summarizeLastLeg([]), stakeCents: 2_000 });
  assert.ok(young.includes("The parlay shadow has just started"));
  assert.ok(young.includes("No locked ticket has settled yet; the identity is checked on every settlement."));
  assert.ok(!young.includes("Lock not offered, and why"));
});

test("embed: a Parlays tab beside Positions, read from /api/parlays; three row states; the lock sheet says what cash-out does and what the lock does; honesty labels; the funnel knows the taps", () => {
  const html = renderEventEmbedHtml({ brand: "Wire Markets" });
  assert.ok(html.includes('<span class="on" data-tab="Positions">Positions</span><span data-tab="Parlays">Parlays</span>'), "a live tab, not a toast");
  assert.ok(html.includes("fetch('/api/parlays',{cache:'no-store'})"));
  assert.ok(html.includes("Protect unlocks at your last pick"), "two or more picks open");
  assert.ok(html.includes("Lock in '+usd(L.floorTotalCents)+' &middot; '+usd(L.creditCents)+' paid now</button>"), "one pick open with a priced lock");
  assert.ok(html.includes("No lock right now: '+esc(t.lockRefusedShort||t.lockRefused)+'</button>"), "one pick open, refused: one clause on the row");
  assert.ok(html.includes("function openWhySheet(id)") && html.includes("<h2 id=\"sh-h\">No lock right now</h2>") && html.includes("esc(t.lockRefused.charAt(0).toUpperCase()+t.lockRefused.slice(1))"), "the full reason a tap away");
  assert.ok(html.includes("pricing the lock at the next pass"), "one pick open, not yet attempted");
  assert.ok(html.includes("locked it would have paid") && html.includes("no lock was priced before the last game"), "settled, lock against ticket");
  assert.ok(html.includes("no lock exists before the last pick"), "busted");
  assert.ok(html.includes("Lock in your parlay") && html.includes(">if it misses<") && html.includes(">if it hits<"), "the sheet: two endings and the credit");
  assert.ok(html.includes("Cash out sells the whole ticket at the venue\\'s price. The lock keeps the ticket"), "the cash-out comparison");
  assert.ok(html.includes("With two picks open there is no market for the pair of games, so no lock is offered yet."));
  // honesty: one line on the tab, the long version behind the info button, and the confusing sentence gone
  assert.ok(html.includes('<div class="note"><span>Simulated tickets at live prices; nothing is bought.</span><button class="info" data-info="1" aria-label="About these tickets">i</button></div>'));
  assert.ok(html.includes("<h2 id=\"sh-h\">About these tickets</h2>") && html.includes("These tickets are ours, not copied from anyone.") && html.includes("built from public game markets at the prices when it was built."));
  assert.ok(html.includes("The lock is priced from the live market on the last pick and refreshed every") && html.includes("<p>Nothing is bought.</p>"));
  assert.ok(!html.includes("publishes no list"), "the 'venue publishes no list of real ones' sentence is off the phone");
  assert.ok(html.includes("from the live book, '+L.hoursBefore+'h before the game"), "the quote carries its time");
  // the picks: the side in ink, the matchup after it; the leagues of the ticket, not just the last pick's
  assert.ok(html.includes("<span><b>'+esc(p.outcome)+'</b>'+v+'</span>") && html.includes("/^(vs|at) /.test(p.versus)"));
  assert.ok(!html.includes("last pick\";") && !html.includes("· last pick"), "no duplicate 'last pick' suffix on the row");
  assert.ok(html.includes("function leaguesOf(t)") && html.includes("(lg?' &middot; '+lg:'')"));
  // the list: In play, then a collapsed Settled group of one-line rows that expand on tap
  assert.ok(html.includes("<div class=\"grp\"><span>In play</span></div>"));
  assert.ok(html.includes("Settled &middot; '+done.length+'</span><button data-settled=\"1\">'+(S.showSettled?'Hide':'Show')+'</button>"));
  assert.ok(html.includes("showSettled:false,expanded:{}") && html.includes("if(S.showSettled)for(i=0;i<done.length;i++)html+=decidedHtml(done[i])"));
  assert.ok(html.includes("data-expand=\"'+esc(t.id)+'\"") && html.includes("S.expanded[ex]=!S.expanded[ex]"));
  assert.ok(html.includes("<b>Last pick</b>") && html.includes("<b>'+t.picksOpen+' picks open</b>") && html.includes("h out</i>"), "row headers: one line each");
  assert.ok(html.includes("track('parlay_tab')") && html.includes("track('parlay_tap',parlayId(id))") && html.includes("track('parlay_lock',parlayId(t.id))"));
  assert.ok(html.includes("Parlays: a floor and a credit at the last pick, never before"), "the pitch names it");
  assert.ok(html.includes("if(/[?&]tab=parlays\\b/i.test(location.search))switchTab('Parlays')"), "?tab=parlays deep-links to the tab");
  const parlayScript = html.slice(html.indexOf("PARLAYS:"), html.indexOf("document.addEventListener('click'"));
  assert.ok(parlayScript.length > 1000 && !/polymarket|kalshi|hedg|writer|\btake\b/i.test(parlayScript), "no venue names or mechanics in the parlay copy");
  assert.ok(!html.includes("\u2014"), "no em dash");

  for (const a of ["parlay_tab", "parlay_tap", "parlay_lock"]) assert.ok(isEventAction(a), a);
  assert.equal(EVENT_ACTIONS.length, 10);
  assert.ok(isValidTicker("LL_0A1B2C3D4E5F"), "the ticket id upper-cased passes the funnel's ticker rule");
});
