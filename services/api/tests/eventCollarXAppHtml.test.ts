import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEventXAppHtml } from "../scripts/eventProtectXAppHtml";

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
  assert.ok(html.includes("ranked by what the protection really costs"));
  assert.ok(html.includes('id="boardrows"'), "board rows container");
  assert.ok(html.includes("cost of protection"), "EV honesty line in the drawer");
  assert.ok(html.includes("% of expected value"), "EV framing in plain words");
  assert.ok(html.includes("pays "), "negative EV cost (venue-gap edge) has its own wording");
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
