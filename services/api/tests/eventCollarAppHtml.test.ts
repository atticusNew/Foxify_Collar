import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEventAppHtml } from "../scripts/eventProtectAppHtml";

test("event app html: honesty label, gating line, and structure", () => {
  const html = renderEventAppHtml();
  assert.ok(html.includes("simulation · live pricing"), "honesty label present");
  assert.ok(html.includes("Demonstration, not an offer."), "gating line present");
  assert.ok(html.includes("US availability requires a regulated deployment path"));
  assert.ok(html.includes('id="toggle"'), "the toggle is the feature");
  assert.ok(html.includes("/api/showcase"), "polls the live endpoint");
  assert.ok(html.includes("width=device-width"), "mobile viewport");
  assert.ok(html.includes("Protect into resolution"));
});

test("event app html: outcomes-first, percent framing, one-tap grammar", () => {
  const html = renderEventAppHtml();
  assert.ok(html.includes("leave with at least"), "guaranteed minimum is the hero");
  assert.ok(html.includes("chance of yes"), "percent framing for the market");
  assert.ok(html.includes("credit paid win or lose"), "credit framing is all-in");
  assert.ok(html.includes("one tap · protected instantly"), "one-tap grammar");
  assert.ok(html.includes('id="undo"'), "undo window after the tap");
  assert.ok(html.includes("see the hedge"), "machinery behind one disclosure");
  assert.ok(html.includes("terms locked at your tap"));
});

test("event app html: total dollars on the main screen, cents in the drawer", () => {
  const html = renderEventAppHtml();
  // plain-language settlement line on the main screen; BRTI jargon only in disclosures
  assert.ok(html.includes("settles on Bitcoin's official reference price"));
  assert.ok(html.includes("BRTI (CF Benchmarks)"), "settlement mechanics in the drawer");
  // per-contract cents are demoted to the hedge drawer
  assert.ok(html.includes("per contract"));
  assert.ok(html.includes("without protection"), "capped upside disclosed honestly");
  // the probability rail and its jargon are gone from the main screen
  assert.ok(!html.includes("railbox") && !html.includes("markdot"), "no probability rail");
  // the hero number is all-in: the credit is included, not double-counted
  assert.ok(html.includes("includes a"), "no 'plus credit' double counting");
});

test("event app html: no em dashes in visible copy", () => {
  const html = renderEventAppHtml();
  assert.ok(!html.includes("\u2014"), "no em dash anywhere in the rendered page");
});

test("event app html: never claims live execution", () => {
  const html = renderEventAppHtml();
  assert.ok(!/live execution|orders placed live|we are live/i.test(html));
  assert.ok(html.includes("simulated fills at live quotes"));
  assert.ok(html.includes("places no orders"));
});
