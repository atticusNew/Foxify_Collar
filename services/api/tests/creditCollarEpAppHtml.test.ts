/**
 * EARN & PROTECT web app HTML — invariants of the live-replica retail surface.
 *
 * The app is a single generated HTML string, so these tests pin the contract-level strings:
 * the honesty label, the conversion chrome, the retired demo-aid affordances, and the
 * placeholders the service substitutes at serve time. They are deliberately string-level —
 * the full behavior is exercised manually against the running service.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildEpAppHtml } from "../scripts/earnProtectWebAppHtml";

const web = buildEpAppHtml("web");
const mini = buildEpAppHtml("miniapp");

test("simulation lane: the one quiet persistent honesty label is present verbatim", () => {
  for (const html of [web, mini]) {
    assert.ok(html.includes("simulation · live pricing"), "honesty label must be present");
    assert.ok(html.includes('class="simlabel"'), "label style hook must exist");
  }
});

test("simulation lane: toggle is marked data-sim and priced by the live preview endpoint", () => {
  for (const html of [web, mini]) {
    assert.ok(html.includes('data-sim="1"'), "showcase toggle must carry the sim marker");
    assert.ok(html.includes('"/api/preview?side="'), "sim quote must come from the live preview endpoint");
    // The sim drivers never post to the wrap path: the block from simStart through the watch
    // terms references only /api/preview.
    const simBody = html.slice(html.indexOf("const simStart"), html.indexOf("// Mobile-safe tooltips"));
    assert.ok(simBody.length > 0, "sim driver block must exist");
    assert.ok(!simBody.includes("/api/wrap"), "the simulation lane must never touch the wrap path");
    assert.ok(!simBody.includes("/api/close"), "the simulation lane must never touch the close path");
  }
});

test("simulation lane: full lifecycle including the unwind and knockout states", () => {
  for (const html of [web, mini]) {
    assert.ok(html.includes("Pricing the live book"), "quoting phase");
    assert.ok(html.includes("Placing hedge legs"), "executing phase");
    assert.ok(html.includes('chip on oneline'), "status chips never wrap to a second line");
    assert.ok(html.includes("Simulation: turn protection off now?"), "unwind states the consequence first");
    assert.ok(html.includes("Unwinding hedge legs"), "unwind walks the close visuals");
    assert.ok(html.includes("Closed early"), "settlement ticket after the unwind");
    assert.ok(html.includes("returned to the market"), "ticket states the returned figure");
    assert.ok(html.includes("touched · cycle over"), "knockout on a real cap touch");
    assert.ok(html.includes("re-arming at the new price"), "knockout re-arms like the live product");
  }
});

test("design system: credit hero, price rail, coach bubble, conversion CTA, compact numbers", () => {
  for (const html of [web, mini]) {
    assert.ok(html.includes('class="cred-num'), "credit hero number");
    assert.ok(html.includes("rail-track") && html.includes("rail-ends"), "floor–price–cap rail");
    assert.ok(html.includes("rail-tick") && html.includes("tfloor") && html.includes("tcap"), "floor/cap end ticks");
    assert.ok(html.includes("rail-pxval") && html.includes("<em>live</em>"), "live tag on the rail marker");
    assert.ok(html.includes("Try it · nothing opens"), "one-time coach bubble");
    assert.ok(html.includes("livedot"), "live-data dot on the card eyebrow");
    assert.ok(html.includes("positionTips"), "tooltips are pre-positioned inside the viewport");
    assert.ok(html.includes("min-width:' + fmt$(o.creditUsdc).length + 'ch"), "vested amount counts up in a reserved-width slot");
    assert.ok(html.includes('class="btn cta connOpen"'), "full-width connect CTA at the payoff moment");
    assert.ok(html.includes("const fmtC"), "compact notional formatter");
    assert.ok(html.includes('class="pos-row"'), "position row never wraps the toggle");
    assert.ok(html.includes("minibar"), "vesting is an inline mini-bar — the rail is the one full-width picture");
    assert.ok(html.includes("ghosted"), "nav Connect demotes while the card CTA is up");
    assert.ok(!html.includes("BTC position shown — protection covers BTC today"), "orphan footnote deleted");
  }
});

test("geo notice: dismissible with persisted acknowledgment; enforcement stays server-side", () => {
  for (const html of [web, mini]) {
    assert.ok(html.includes('id="geoX"'), "dismiss control");
    assert.ok(html.includes("ep_geo_ack_"), "acknowledgment persistence key");
  }
});

test("connect chrome: dApp-standard nav button opening the address-paste modal", () => {
  for (const html of [web, mini]) {
    assert.ok(html.includes('class="connbtn" id="connPill"'), "nav Connect button must exist");
    assert.ok(html.includes('id="connVeil"'), "connect modal must exist");
    assert.ok(html.includes("No keys, no signing, no deposits"), "safety line must survive in the modal");
    assert.ok(html.includes('placeholder="0x… your Hyperliquid address"'), "address grammar: an address, never a wallet");
  }
});

test("landing operating: showcase boot path present, whale-button chrome retired", () => {
  for (const html of [web, mini]) {
    assert.ok(html.includes("landShowcase"), "landing must boot into the showcase address");
    assert.ok(html.includes('class="skl"'), "skeleton (never an empty entry gate) must exist");
    assert.ok(!html.includes("See it on a whale"), "whale aid button is retired");
    assert.ok(!html.includes("Preview a size"), "preview aid button is retired");
    assert.ok(!html.includes("__DEMO_AIDS__"), "demo-aids placeholder is retired");
    assert.ok(!html.includes("demo-switch"), "the demonstration panel is superseded by the sim lane");
    assert.ok(!html.includes("Watching a public wallet"), "whale-watch strip copy is retired");
  }
});

test("honesty: no 'guaranteed' or 'risk-free' anywhere in the surface", () => {
  for (const html of [web, mini]) {
    assert.ok(!/guaranteed/i.test(html), "never 'guaranteed'");
    assert.ok(!/risk[- ]free/i.test(html), "never 'risk-free'");
  }
});

test("copy: no em dashes in user-visible text (placeholder '—' for missing values excepted)", () => {
  for (const html of [web, mini]) {
    const withoutComments = html
      .replace(/\/\*[\s\S]*?\*\//g, "")   // CSS/JS block comments
      .replace(/<!--[\s\S]*?-->/g, "")    // HTML comments
      .replace(/\/\/[^\n]*/g, "");        // JS line comments
    assert.ok(!withoutComments.includes(" — "), "no prose em dashes in visible copy");
    assert.ok(!withoutComments.includes("\\u2014"), "no escaped em dashes in generated strings");
  }
});

test("institutional skin markers untouched", () => {
  for (const html of [web, mini]) {
    assert.ok(html.includes("Institutional asset protection"), "INST hero swap intact");
    assert.ok(html.includes("body.inst"), "INST style block intact");
    assert.ok(html.includes("Viewing a public reference position"), "INST viewing register intact");
  }
});

test("service placeholders intact for serve-time substitution", () => {
  for (const html of [web, mini]) {
    for (const ph of ["__SKIN__", "__BRAND_FOR__", "__BRAND_LINE__", "__BRAND_MARK__", "__LINK_TG__", "__LINK_X__"]) {
      assert.ok(html.includes(ph), `${ph} must remain for the service to substitute`);
    }
  }
});

test("variants: miniapp loads the Telegram bridge, web does not", () => {
  assert.ok(mini.includes("telegram-web-app.js"));
  assert.ok(!web.includes("telegram-web-app.js"));
});
