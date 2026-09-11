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
  assert.ok(html.includes("if yes") && html.includes("if no"), "outcomes panel");
  assert.ok(html.includes("one tap · protected instantly"), "one-tap grammar");
  assert.ok(html.includes('id="undo"'), "undo window after the tap");
  assert.ok(html.includes("see the hedge"), "machinery behind one disclosure");
  assert.ok(html.includes("terms locked at your tap"));
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
