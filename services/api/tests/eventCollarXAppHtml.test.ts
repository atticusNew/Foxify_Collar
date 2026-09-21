import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderEventXAppHtml, renderReceiptsHtml } from "../scripts/eventProtectXAppHtml";
import { summarizeCrossLedger } from "../src/eventCollar/crossVenue/crossLedger";

test("cross-venue app html: honesty label, gating line, and structure", () => {
  const html = renderEventXAppHtml();
  assert.ok(html.includes("simulation · live pricing"), "honesty label present");
  assert.ok(html.includes("Demonstration, not an offer."), "gating line present");
  assert.ok(html.includes("US availability requires a regulated deployment path"));
  assert.ok(html.includes('id="toggle"'), "the toggle is the feature");
  assert.ok(html.includes("/api/showcase"), "polls the live endpoint");
  assert.ok(html.includes("width=device-width"), "mobile viewport");
  assert.ok(html.includes("Protect this position"));
  assert.ok(html.includes('id="loading"'), "loading state while venues are paired");
  assert.ok(html.includes("scanning games and crypto"));
  assert.ok(!html.includes("across Kalshi and Polymarket"), "retail first: the other venue is not on the page");
});

test("cross-venue app html: the drawer is the holder's terms; the hedge, the pairing and the take stay with the operator", () => {
  const html = renderEventXAppHtml();
  assert.ok(html.includes("see the terms"), "the drawer is named for what it shows");
  assert.ok(html.includes("See the track record"), "footer links the live track record");
  assert.ok(html.includes("without protection"), "naked outcome row in the drawer");
  assert.ok(html.includes("with protection</span>"), "protected outcome row mirrors the naked row");
  assert.ok(html.includes(">settles</span>"), "settlement row: official final score / index print");
  assert.ok(html.includes("verifiably settle on the identical official result"), "settlement honesty lives in the disclosure");
  assert.ok(html.includes("the position is simulated, no funds can move"), "simulation disclosed in the disclosure");
  assert.ok(html.includes("simulation · live pricing"), "and once in the eyebrow: the one honesty marker on the hero");
  for (const leak of [
    "same game, two prices",
    "the gap funds your credit",
    "q.hedge.",
    "hedge cost",
    "our take",
    "routes checked",
    "routesChecked",
    "pmYesPriceMilli",
    "parityNote",
    "kalshi_self",
    "minimum fee",
    "% of the credit sourced",
    "Kalshi + Polymarket",
  ]) {
    assert.ok(!html.includes(leak), `"${leak}" is operator information and is not on the retail page`);
  }
  assert.ok(html.includes("The credit you see is the credit you get."), "the fee is explained as already netted, once, in How this works");
  assert.ok(html.includes('id="refreshed"'), "quote freshness microtext");
  assert.ok(html.includes("In play."), "graceful in-play state");
});

test("cross-venue app html: the scanner board ranks protection by its true cost", () => {
  const html = renderEventXAppHtml();
  assert.ok(html.includes("Best protection right now"), "board card present");
  assert.ok(html.includes("best value first"), "the ranking rule in three words");
  assert.ok(html.includes("tap any game"), "rows are invitations, not decoration");
  assert.ok(!html.includes("cheapest safe route wins"), "route competition is an operator concern, not a retail sentence");
  assert.ok(html.includes('id="boardrows"'), "board rows container");
  assert.ok(html.includes("cost of protection"), "EV honesty line in the drawer");
  assert.ok(html.includes("% of expected value"), "EV framing in plain words");
  assert.ok(html.includes("pays "), "negative EV cost (venue-gap edge) has its own wording");
});

test("cross-venue app html: grades and tappable rows; no route anywhere on the page", () => {
  const html = renderEventXAppHtml();
  assert.ok(html.includes("data-ticker"), "board rows carry their market ticker for tap-to-showcase");
  assert.ok(html.includes("'pays you'"), "grade word for negative EV cost");
  assert.ok(html.includes("'cheap'"), "grade word for cheap protection");
  assert.ok(html.includes("'rich'"), "grade word for rich protection");
  assert.ok(!html.includes("routes checked"), "routes are not on the retail page");
  assert.ok(!html.includes("Kalshi, same market"), "nor is the self-hedge route");
  assert.ok(!html.includes("p.route"), "the page never reads a route field (the retail JSON has none)");
  assert.ok(!html.includes("via '+routeName"), "the route name stays out of the hero and the board rows");
  assert.ok(html.includes("keep at least '+usd(r.floorTotalCents)"), "board rows lead with what the holder keeps");
  assert.ok(html.includes("' cash</div>'"), "and the cash, nothing else");
  assert.ok(!html.includes("tierCount"), "tier counts are not shown on the board");
  assert.ok(html.includes("sideName"), "full team names from the venue pairing");
  assert.ok(html.includes("guaranteed "), "protected banner states the locked range");
  assert.ok(html.includes('href="/receipts"'), "receipts page linked from the footer");
  assert.ok(html.includes("far=dt.getTime()-Date.now()>86400000") && html.includes("month:'short',day:'numeric'"), "a game more than a day out shows its date, not just a weekday");
});

test("cross-venue app html: one board for games and crypto, honestly worded", () => {
  const html = renderEventXAppHtml();
  assert.ok(html.includes("games and crypto"), "the unified board is the pitch");
  assert.ok(html.includes("settles in "), "crypto countdown wording");
  assert.ok(html.includes("official index print"), "crypto settlement wording");
  assert.ok(!html.includes("'not offered'"), "per-route verdicts are operator information");
  assert.ok(html.includes('id="whyline"'), "the showcase says why it was chosen");
  assert.ok(html.includes("best value right now"), "default showcase reason");
  assert.ok(html.includes("your pick"), "tapped showcase reason");
  assert.ok(html.includes("At the close."), "crypto in-play state has its own words");
});

test("cross-venue app html: board previews three rows with an expand control, undo honesty", () => {
  const html = renderEventXAppHtml();
  assert.ok(html.includes("boardmore"), "expand/collapse control for the board");
  assert.ok(html.includes("show all "), "expand label counts the games");
  assert.ok(html.includes("show fewer games"), "collapse label");
  assert.ok(html.includes("undo simply resets it"), "undo honesty stated in plain words");
  assert.ok(html.includes("in the real product, terms lock at your tap"), "real-product lock stated");
});

test("receipts html: honest aggregates from a real ledger file", () => {
  const dir = mkdtempSync(join(tmpdir(), "xledger-"));
  const path = join(dir, "quotes.jsonl");
  const priced = {
    at: "2026-09-11T01:00:00.000Z",
    kind: "cross_venue_quote",
    kalshiTicker: "T1",
    pmEventSlug: "s1",
    fingerprint: "f1",
    markCents: 60,
    entryCents: 41,
    contracts: 150,
    route: "kalshi_self",
    evCostBps: 157,
    result: { ok: true, creditCents: 69, takeCents: 7, takeWaived: false },
  };
  const refused = {
    at: "2026-09-11T02:00:00.000Z",
    kind: "cross_venue_quote",
    kalshiTicker: "T2",
    pmEventSlug: "s2",
    fingerprint: "f2",
    markCents: 88,
    entryCents: 80,
    contracts: 150,
    result: { ok: false, code: "credit_nonpositive", detail: "no" },
  };
  writeFileSync(
    path,
    `${JSON.stringify(priced)}\n${JSON.stringify(refused)}\nnot json\n`,
    "utf8",
  );
  const s = summarizeCrossLedger(path);
  assert.equal(s.totalQuotes, 2);
  assert.equal(s.priced, 1);
  assert.equal(s.refused, 1);
  assert.equal(s.creditsSourcedCents, 69);
  assert.equal(s.takeKeptCents, 7);
  assert.equal(s.avgEvCostBps, 157);
  assert.deepEqual(s.routeSplit, { kalshi_self: 1 });
  assert.deepEqual(s.refusalsByCode, { credit_nonpositive: 1 });

  const html = renderReceiptsHtml(s);
  assert.ok(html.includes("How the terms are built"), "tier rules and fee mechanics live on the receipts page");
  for (const name of ["Safest", "Balanced", "Most upside"]) assert.ok(html.includes(`<span>${name}</span>`), `${name} rule row`);
  assert.ok(html.includes("the highest floor the venues fund"), "tight rule text");
  assert.ok(html.includes("the credit on the card is the credit you get"), "the fee is explained as already netted");
  assert.ok(!html.includes("the larger of a published share") && !html.includes("published take kept"), "retail first: the fee rule and the take kept are operator information (shadow record)");
  assert.ok(html.includes("never a free reversal"), "unwind economics disclosed");
  assert.ok(!html.includes("Which route won") && !html.includes("Polymarket") && !html.includes("own No side"), "hedge routes are not on the public receipts page");
  assert.ok(html.includes("Receipts"), "page title");
  assert.ok(html.includes("quotes priced"));
  assert.ok(html.includes("honest refusals"));
  assert.ok(html.includes("credits sourced"));
  assert.ok(html.includes("could not fund a positive credit"), "refusal code in plain words");
  assert.ok(html.includes("Demonstration, not an offer."), "gating line present");
  assert.ok(!html.includes("\u2014"), "no em dash in receipts copy");

  const empty = summarizeCrossLedger(join(dir, "missing.jsonl"));
  assert.equal(empty.totalQuotes, 0);
  const emptyHtml = renderReceiptsHtml(empty);
  assert.ok(emptyHtml.includes("The ledger is empty"), "empty history is stated, not faked");
});

test("cross-venue app html: kalshi-native vocabulary, total dollars, one-tap", () => {
  const html = renderEventXAppHtml();
  assert.ok(html.includes("you keep at least"), "the floor is the first hero number");
  assert.ok(html.includes("cash now"), "the credit is the second, same size");
  assert.ok(html.includes("up to <b id=\"maxout\">"), "the cap is small print under them");
  assert.ok(html.includes(">chance<"), "percent framing");
  assert.ok(html.includes("the cash is yours either way"), "credit framing is all-in and terse");
  assert.ok(html.includes("starts in"), "countdown to game start");
  assert.ok(html.includes(">one tap<"), "toggle promise in two words");
  assert.ok(html.includes("terms locked at your tap"));
  assert.ok(html.includes('id="undo"'), "undo after the tap");
  assert.ok(!/resolution/i.test(html.replace(/US availability requires a regulated deployment path/g, "")), "no 'resolution' in visible copy");
});

test("cross-venue app html: no em dashes, never claims live execution, logo inlined", () => {
  const html = renderEventXAppHtml();
  assert.ok(!html.includes("\u2014"), "no em dash anywhere in the rendered page");
  assert.ok(!/live execution|orders placed live|we are live/i.test(html));
  assert.ok(html.includes("no funds can move"));
  assert.ok(html.includes("data:image/jpeg;base64,"), "logo is inlined");
  assert.ok(!html.includes("i.ibb.co"), "no hotlinked assets");
});

test("cross-venue app html: tiers are offered side by side with stated rules; the fee is disclosed both ways", () => {
  const html = renderEventXAppHtml();
  assert.ok(html.includes('id="tiers"'), "tier chips container in the offer");
  assert.ok(html.includes("data-tier="), "chips carry the tier name the server understands");
  assert.ok(html.includes("Three ways to protect."), "the tiers are explained by outcome, not by rule");
  assert.ok(html.includes("tight:'Safest',balanced:'Balanced',wide:'Most upside'"), "outcome names on the tiles");
  assert.ok(!html.includes("TIER_RULES"), "no rule sentence under the tiles; the rules live on /receipts");
  assert.ok(html.includes('<div class="tc">at least</div>'), "one number per tile: the floor");
  assert.ok(html.includes("tiers.balanced?'balanced'"), "Balanced is the starting point when funded");
  assert.ok(html.includes("aria-pressed"), "the selected tile is announced");
  assert.ok(!html.includes("minimum fee") && !html.includes("% of the credit sourced"), "the fee rule is not on the retail page; the credit shown is net");
  assert.ok(!html.includes("share would be") && !html.includes("not binding"), "the fee line no longer explains the other rule");
  assert.ok(html.includes('<a href="/receipts">See the receipts</a>'), "the mechanics are one tap away");
  assert.ok(html.includes("'tier_pick'"), "tier picks are counted in the funnel");
  assert.ok(html.includes("track('protect_on',S.payload.pair&&S.payload.pair.kalshiTicker,S.tier)"), "Protect beacons carry the locked tier");
});
