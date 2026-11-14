/**
 * The embed's Activity tab and grouped Positions list.
 *
 *   - retailActivity cuts the record's finished positions to outcomes: what it ended at with
 *     the lock, what it would have without, what was paid at open. Open and void positions are
 *     not activity. Most recent first, capped. No hedge, take or route words survive.
 *   - the embed shell has three live tabs (Positions, Parlays, Activity), no Markets tab, and
 *     the Positions list is grouped by league with crypto last.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVITY_ROW_CAP, activityFromShadowBody, activityRow, retailActivity, type ActivitySource } from "../src/eventCollar/crossVenue/activityRetail";
import { forbiddenKeysIn } from "../src/eventCollar/retailShowcase";
import { isEventAction } from "../src/eventCollar/crossVenue/eventFunnel";
import { renderEventEmbedHtml } from "../scripts/eventProtectEmbedHtml";

const base: ActivitySource & Record<string, unknown> = {
  ticker: "KXNFLGAME-26OCT11PHIJAC-PHI",
  kind: "sports",
  league: "nfl",
  sideName: "Eagles",
  eventTitle: "Eagles vs. Jaguars",
  eventTimeIso: "2026-10-11T13:30:00.000Z",
  contracts: 150,
  floorCents: 24,
  capCents: 51,
  creditCents: 603,
  status: "settled",
  result: "no",
  settledAt: "2026-10-11T17:05:00.000Z",
  protectedCents: 4203,
  nakedCents: 0,
  // the shadow's full object carries the writer's side too; none of it may cross
  route: "polymarket",
  takeCents: 67,
  hedgeCostCents: 6680,
  hedgeTokenId: "0xabc",
  counterfactuals: { alternatives: { tight: { takeCents: 38 } } },
};

test("activity: a settled loss reads as the floor paid, a settled win as the cap, an early close as what was left with; open and void are not activity", () => {
  const lost = activityRow(base)!;
  assert.deepEqual(lost, {
    id: base.ticker, kind: "sports", league: "nfl", name: "Eagles", game: "Eagles vs. Jaguars", startsIso: base.eventTimeIso,
    state: "settled", outcome: "lost", atIso: "2026-10-11T17:05:00.000Z", contracts: 150, endedCents: 4203, withoutCents: 0, creditCents: 603, floorTotalCents: 4203, capTotalCents: 8253,
  });
  assert.equal(lost.endedCents, lost.floorTotalCents, "a loss with the lock ends at the floor, credit inside");
  const won = activityRow({ ...base, result: "yes", protectedCents: 8253, nakedCents: 15000 })!;
  assert.equal(won.outcome, "won");
  assert.equal(won.endedCents, won.capTotalCents, "a win with the lock ends at the cap, credit inside");
  assert.equal(won.withoutCents, 15000);
  const closed = activityRow({ ...base, status: "closed", result: undefined, settledAt: undefined, closedAt: "2026-10-11T15:00:00.000Z", protectedCents: 5100, nakedCents: 4950 })!;
  assert.deepEqual([closed.state, closed.outcome, closed.atIso, closed.endedCents, closed.withoutCents], ["closed", "closed", "2026-10-11T15:00:00.000Z", 5100, 4950]);
  assert.equal(activityRow({ ...base, status: "open", result: undefined, settledAt: undefined }), null);
  assert.equal(activityRow({ ...base, status: "void" }), null);
  assert.equal(activityRow({ ...base, protectedCents: undefined }), null, "a settled row without totals is not shown rather than shown wrong");
  assert.equal(activityRow({ ...base, settledAt: undefined }), null);
  assert.equal(activityRow({ ...base, kind: "crypto", league: "crypto" })!.kind, "crypto");
  assert.deepEqual(forbiddenKeysIn(lost), [], "the row carries no hedge, take, route or counterfactual words");
});

test("activity: most recent first, capped, counts before the cap; the shadow body's open list is ignored; a body without lists is empty, not a crash", () => {
  const many: ActivitySource[] = [];
  for (let i = 0; i < 70; i += 1) {
    many.push({ ...base, ticker: `T${String(i).padStart(2, "0")}`, settledAt: `2026-10-${String(1 + (i % 9)).padStart(2, "0")}T12:00:00.000Z` });
  }
  many.push({ ...base, ticker: "C1", status: "closed", result: undefined, settledAt: undefined, closedAt: "2026-10-11T09:00:00.000Z", protectedCents: 5000, nakedCents: 4900 });
  many.push({ ...base, ticker: "O1", status: "open", result: undefined, settledAt: undefined });
  const out = retailActivity(many);
  assert.equal(out.rows.length, ACTIVITY_ROW_CAP);
  assert.deepEqual([out.settledCount, out.closedCount], [70, 1], "the counts are the record's, not the page's");
  assert.equal(out.rows[0].id, "C1", "the most recent finish leads, settled or closed alike");
  for (let i = 1; i < out.rows.length; i += 1) assert.ok(out.rows[i - 1].atIso >= out.rows[i].atIso, "descending by finish time");
  assert.deepEqual(retailActivity(many, 3).rows.map((r) => r.id), ["C1", "T08", "T17"], "ties on time break on the id so the order is stable");
  assert.deepEqual(retailActivity([]), { rows: [], settledCount: 0, closedCount: 0 });

  const fromBody = activityFromShadowBody({ ok: true, settled: [base], open: [{ ...base, status: "open" }], closed: [] });
  assert.equal(fromBody.rows.length, 1);
  assert.deepEqual(activityFromShadowBody({ ok: true }), { rows: [], settledCount: 0, closedCount: 0 });
  assert.deepEqual(activityFromShadowBody(null), { rows: [], settledCount: 0, closedCount: 0 });
  assert.deepEqual(forbiddenKeysIn(fromBody), []);
});

test("embed: three live tabs and no Markets; Positions grouped by league with crypto last; Activity lists this session's taps, then the record's finished rows, outcomes only", () => {
  const html = renderEventEmbedHtml({ brand: "ProphetX" });
  assert.ok(html.includes('<div class="tabs"><span class="on" data-tab="Positions">Positions</span><span data-tab="Parlays">Parlays</span><span data-tab="Activity">Activity</span></div>'));
  assert.ok(!html.includes('data-tab="Markets"'), "no Markets tab on the phone: browsing is the host's product");
  assert.ok(html.includes("<nav><span>Markets</span><span class=\"on\">My Trades</span><span>Account</span></nav>"), "the desktop table shell wears the venue's own nav, My Trades selected; it is decoration, not a tab");
  assert.ok(!html.includes("toast('Demo:"), "no dead-tab toast is left");

  // grouping
  assert.ok(html.includes("function groupRows(rows){"));
  assert.ok(html.includes("k=r.kind==='crypto'?'crypto':String(r.league||'other').toLowerCase()"), "crypto is its own group whatever its league field says");
  assert.ok(html.includes("out.sort(function(a,b){return a.next-b.next});") && html.includes("if(by.crypto)out.push(by.crypto);"), "the league with the nearest game first, crypto last");
  assert.ok(html.includes("if(groups.length>1)html+=S.shell==='table'?'<div class=\"tgrp\">'+esc(g.key.toUpperCase())+' &middot; '+g.rows.length+'</div>':'<div class=\"grp\"><span>'+esc(g.key.toUpperCase())+' &middot; '+g.rows.length+'</span></div>';"), "a header per league with its count, in either shell; one league alone gets none");

  // activity tab
  assert.ok(html.includes("if(S.tab==='Activity'){paintActivity();return}"));
  assert.ok(html.includes("fetch('/api/activity',{cache:'no-store'})"), "read from the demo's retail read-through, never the shadow directly");
  assert.ok(html.includes("if(tab==='Activity'){track('activity_tab');if(!S.activity)loadActivity()}"), "the funnel knows the tab was opened");
  assert.ok(isEventAction("activity_tab"));
  assert.ok(html.includes('<div class="grp"><span>This session</span></div>'), "the visitor's own taps sit on top");
  assert.ok(html.includes("locked in'+(when?' &middot; '+esc(fmtEt(when)):'')") && html.includes("lock removed '+esc(st.removed.at)"), "locks and early leaves made here are listed");
  assert.ok(html.includes("sideName:r.sideName,league:r.league,eventTimeIso:r.eventTimeIso};") && html.includes("var name=(p&&p.sideName)||r.sideName||k"), "the lock keeps the row's words, so it is still listed after the board re-scans and drops the row");
  assert.ok(html.includes("S.lockedBy[t.id]={size:t.size,lock:L,leagues:leaguesOf(t)};") && html.includes("'+t.size+'-pick parlay</div><div class=\"meta\">'+t.leagues+' &middot; locked in</div>"), "parlay locks too, from their own snapshot");
  assert.ok(html.includes("<span>Finished &middot; '+(!SPORTS_ONLY&&total>rows.length?'last '+rows.length+' of '+total:rows.length)+'</span>"), "the record's full count is said when the feed is a cut of it");
  assert.ok(html.includes("(closed?'closed early':won?'won':'lost')"), "the row's state in one word");
  assert.ok(html.includes("<b>'+usd(a.endedCents)+'</b><i>vs '+usd0(a.withoutCents)+' without</i>"), "what it ended at with the lock, against without");
  assert.ok(html.includes("usd(a.creditCents)+' credited at lock in &middot; '+(closed?'closed before the result':won?'the win, to the cap':'the floor, paid')"), "the credit is said as inside the number, and which ending it was");
  assert.ok(html.includes("if(SPORTS_ONLY)rows=rows.filter(function(r){return r.kind!=='crypto'});"), "a sportsbook shell hides crypto finishes as it hides crypto positions");
  assert.ok(html.includes("Finished positions from our public record; nothing is bought."), "the honesty line stays on the tab");
  assert.ok(html.includes("Activity is unavailable right now.") && html.includes("Nothing has finished yet."), "honest empty and error states");
  assert.ok(html.includes('data-more="activity"') && html.includes("S.activityShown+=25"), "long records page in 25s");
  assert.ok(html.includes("tab=activity") && html.includes("else if(S.tab==='Activity')loadActivity()"), "deep link and the minute refresh");
  for (const banned of ["hedge", "take ", "counterfactual", "writer"]) assert.ok(!new RegExp(`paintActivity[\\s\\S]*?${banned}[\\s\\S]*?function loadActivity`).test(html), `no "${banned}" in the activity copy`);
});
