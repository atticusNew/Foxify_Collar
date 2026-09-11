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
  assert.ok(html.includes("pairing the same game across Kalshi and Polymarket"));
});

test("cross-venue app html: pairing is explicit and honest", () => {
  const html = renderEventXAppHtml();
  assert.ok(html.includes("protected on"), "Kalshi listing named in the drawer");
  assert.ok(html.includes("hedged on"), "Polymarket listing named in the drawer");
  assert.ok(html.includes("same result"), "resolution parity shown to the holder");
  assert.ok(html.includes("settled by the official final score"), "plain settlement line");
  assert.ok(html.includes("whitelist"), "whitelist discipline explained");
  assert.ok(html.includes("simulated fills at live quotes"));
  assert.ok(html.includes("same game, two prices"), "venue gap row makes the credit source legible");
  assert.ok(html.includes("the gap funds your credit"));
  assert.ok(html.includes('id="refreshed"'), "quote freshness microtext");
  assert.ok(html.includes("In play."), "graceful in-play state");
});

test("cross-venue app html: the scanner board ranks protection by its true cost", () => {
  const html = renderEventXAppHtml();
  assert.ok(html.includes("Best protection right now"), "board card present");
  assert.ok(html.includes("the cheaper protection wins"), "route competition is the pitch");
  assert.ok(html.includes("tap a game to load it"), "rows are invitations, not decoration");
  assert.ok(html.includes('id="boardrows"'), "board rows container");
  assert.ok(html.includes("cost of protection"), "EV honesty line in the drawer");
  assert.ok(html.includes("% of expected value"), "EV framing in plain words");
  assert.ok(html.includes("pays "), "negative EV cost (venue-gap edge) has its own wording");
});

test("cross-venue app html: grades, tappable rows, and route competition", () => {
  const html = renderEventXAppHtml();
  assert.ok(html.includes("data-ticker"), "board rows carry their market ticker for tap-to-showcase");
  assert.ok(html.includes("'pays you'"), "grade word for negative EV cost");
  assert.ok(html.includes("'cheap'"), "grade word for cheap protection");
  assert.ok(html.includes("'rich'"), "grade word for rich protection");
  assert.ok(html.includes("routes checked"), "both routes disclosed in the drawer");
  assert.ok(html.includes("cheaper route wins"), "selection rule stated plainly");
  assert.ok(html.includes("its own No side"), "self-hedge route named for the holder");
  assert.ok(html.includes("sideName"), "full team names from the venue pairing");
  assert.ok(html.includes("guaranteed "), "protected banner states the locked range");
  assert.ok(html.includes('href="/receipts"'), "receipts page linked from the footer");
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
  assert.ok(html.includes("Receipts"), "page title");
  assert.ok(html.includes("quotes priced"));
  assert.ok(html.includes("honest refusals"));
  assert.ok(html.includes("credits sourced"));
  assert.ok(html.includes("could not fund a positive credit"), "refusal code in plain words");
  assert.ok(html.includes("own No side"), "route split names the self-hedge route");
  assert.ok(html.includes("Demonstration, not an offer."), "gating line present");
  assert.ok(!html.includes("\u2014"), "no em dash in receipts copy");

  const empty = summarizeCrossLedger(join(dir, "missing.jsonl"));
  assert.equal(empty.totalQuotes, 0);
  const emptyHtml = renderReceiptsHtml(empty);
  assert.ok(emptyHtml.includes("The ledger is empty"), "empty history is stated, not faked");
});

test("cross-venue app html: kalshi-native vocabulary, total dollars, one-tap", () => {
  const html = renderEventXAppHtml();
  assert.ok(html.includes("your minimum payout"), "minimum payout is the hero");
  assert.ok(html.includes(">chance<"), "percent framing");
  assert.ok(html.includes("credit paid Yes or No"), "credit framing is all-in");
  assert.ok(html.includes("starts in"), "countdown to game start");
  assert.ok(html.includes("one tap · protected instantly"));
  assert.ok(html.includes("terms locked at your tap"));
  assert.ok(html.includes('id="undo"'), "undo after the tap");
  assert.ok(html.includes("includes a"), "no 'plus credit' double counting");
  assert.ok(!/resolution/i.test(html.replace(/US availability requires a regulated deployment path/g, "")), "no 'resolution' in visible copy");
});

test("cross-venue app html: no em dashes, never claims live execution, logo inlined", () => {
  const html = renderEventXAppHtml();
  assert.ok(!html.includes("\u2014"), "no em dash anywhere in the rendered page");
  assert.ok(!/live execution|orders placed live|we are live/i.test(html));
  assert.ok(html.includes("places no orders"));
  assert.ok(html.includes("data:image/jpeg;base64,"), "logo is inlined");
  assert.ok(!html.includes("i.ibb.co"), "no hotlinked assets");
});
