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

test("preview lane: the one quiet persistent honesty label is present verbatim", () => {
  for (const html of [web, mini]) {
    assert.ok(html.includes("preview · live pricing"), "honesty label must be present");
    assert.ok(!html.includes("simulation · live pricing"), "the word 'simulation' is retired from the retail label");
    assert.ok(html.includes('class="simlabel"'), "label style hook must exist");
    assert.ok(html.includes("simulated hedge \\u00b7 live pricing") && html.includes("state.simulated === true && !INST"), "an own-address wrap on a simulated lane carries one honesty line, never the lane's name");
  }
});

test("preview lane, active: says whose wallet it is, when it started, that the credit is moving, and what the visitor does next", () => {
  for (const html of [web, mini]) {
    assert.ok(html.includes("Public wallet, so this is a preview. The terms are live."), "one line of context under the label");
    assert.ok(html.includes("' · on since ' + since") && html.includes("const sinceLabel"), "the label carries the start time");
    assert.ok(html.includes("Protect my position") && !html.includes(">Connect your address</button>"), "the CTA is the next step, not a missing one");
    assert.ok(html.includes("/day</span>") && html.includes("perDayUsdc"), "the unlock line shows the daily rate beside the amount");
    assert.ok(html.includes('sessionStorage.getItem(SIMS_KEY)') && html.includes('s.phase === "active" && s.quote && s.endMs > Date.now()'), "only active previews survive a reload, and only within the tab");
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
    assert.ok(html.includes("Turn protection off?"), "in-app close confirmation states the consequence first");
    assert.ok(html.includes("Keep protection"), "close confirmation offers the safe exit");
    assert.ok(!html.includes("window.confirm"), "no native browser dialogs (Chrome injects suppress-dialogs chrome into them)");
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
    assert.ok(html.includes('class="teaser"') && html.includes("preview, nothing opens"), "pre-toggle teaser on the landing card (first visit only)");
    assert.ok(!html.includes("coach-x") && !html.includes('class="coach"'), "the coach bubble is retired for the teaser line");
    assert.ok(html.includes("livedot"), "live-data dot on the card eyebrow");
    assert.ok(html.includes("positionTips"), "tooltips are pre-positioned inside the viewport");
    assert.ok(html.includes("justify-content:space-between"), "vesting line: static text left, amount pinned right");
    assert.ok(html.includes("infoTip(") && html.includes(", leftIsFloor)") && html.includes(", !leftIsFloor)"), "rail tooltip direction follows geometry, not a hardcoded side");
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

test("one shape, no tiers: the knock-out is explained as keeping the upside, the pre-flip quote leads with value", () => {
  for (const html of [web, mini]) {
    assert.ok(!html.includes("TIER_ORDER") && !html.includes("pickedTier") && !html.includes("ep_tier") && !html.includes("simRetier"), "the tier picker is gone");
    assert.ok(!html.includes("Safest") && !html.includes("Most upside") && !html.includes("Three shapes"), "no tier copy anywhere");
    assert.ok(!html.includes("?tier=") && !html.includes("&tier="), "no tier rides any request");
    assert.ok(html.includes("If you flip it on now:"), "the pre-flip quote leads with value before the commit");
    assert.ok(html.includes('id="realQuote"') && html.includes('api("/api/quote")'), "pre-flip quote box priced off the holder's own position");
    assert.ok(html.includes("The cap pays for your floor."), "the cap is explained as what funds the floor");
    assert.ok(html.includes("Nothing to manage.") && html.includes("Turn it off any time: the collar closes at the live market"), "the retail escape hatch is the toggle, stated in How it works");
    assert.ok(!html.includes("Release your upside any time.") && !html.includes("Release upside \\u00b7") && !html.includes("live price in the product") && !html.includes('class="release"'), "no release row, button or promise on the retail surface");
    assert.ok(html.includes("const relLine = !INST ||") && html.includes("release for ' + fmt$(rel.costUsdc)"), "the live release price is a second line under the cap on the institutional skin only");
    assert.ok(!html.includes('data-sim="1"') || !html.includes("s.released"), "the simulation carries no release path");
    assert.ok(html.includes("if (!INST) return \"\";") && html.includes("Hyperliquid's own funding on your perp is separate and unchanged"), "funding is off the retail card and one sentence in How it works");
    assert.ok(!html.includes("Your position works the same way."), "the CTA subtitle is the trust line alone");
    assert.ok(html.includes("Hedged, not carried.") && html.includes("hedged leg for leg") && html.includes("bought back only at the holder"), "how the writer stays flat, stated plainly");
    assert.ok(!/delta[- ]neutral/i.test(html), "no 'delta neutral' claim on the retail surface");
    assert.ok(!html.includes("You never owe anything"), "the plain collar can net negative: no 'never owe' claim");
    assert.ok(html.includes('id="relVeil"') && html.includes("Release your upside?") && html.includes('api("/api/release/quote")') && html.includes("/api/release?ctl="), "release confirm modal re-prices at the tap and posts the ceiling the holder saw");
    assert.ok(html.includes("maxCostUsdc=") && html.includes("price_moved"), "the engine may refuse a moved price; the app explains it");
    assert.ok(html.includes("chip owed") && html.includes("settles from gains</b>"), "a negative net is said in dollars as settling from the cycle's gains");
    assert.ok(!/owed after netting|to settle<\/b>/.test(html), "no 'owed' on the retail surface: the excess is the floor's price, settled from gains");
    assert.ok(html.includes("const floorLeads") && html.includes("HERO_MIN_CREDIT_USD = 10, HERO_MIN_CREDIT_BPS = 5") && html.includes("losses stop here"), "size-aware hero: the floor leads when the credit is small (under $10 or 5 bps)");
    assert.ok(html.includes("cred cred-floor") && html.includes("cred-plus"), "the floor-led card keeps the credit as its second line");
    assert.ok(html.includes("cap_touched") && html.includes("cap_released"), "the new stages have labels");
    assert.ok(html.includes("Cap touched · cycle over") && html.includes("re-arming at the new price"), "knockout-mode copy is kept for wraps written under the previous rule");
  }
});

test("tenor + carry + fee: the credit label follows the tenor, funding is institutional-only, the fee rule is on the quote", () => {
  for (const html of [web, mini]) {
    assert.ok(html.includes('j.tenor === "weekly" ? "this week\\u2019s" : "today\\u2019s"'), "tenor-aware credit label");
    assert.ok(!html.includes("</b>today\\u2019s credit"), "no hardcoded daily label left on a quote surface");
    assert.ok(html.includes("Funding over the cycle: "), "carry line (institutional skin)");
    assert.ok(html.includes("you receive "), "shorts receive positive funding");
    assert.ok(html.includes("not part of the credit, shown so the number reads net"), "carry is disclosed as separate from the credit");
    assert.ok(html.includes("The market funded "), "fee line names what the market funded");
    assert.ok(html.includes("the published minimum at this size"), "the minimum rule is named when it binds");
    assert.ok(html.includes("our cut is waived"), "the waiver is named when it applies");
    assert.ok(html.includes("const termsGrid"), "one terms grid for every quote surface");
  }
});

test("retail first: no cohort, no mode badge, no receipt table, no raw engine strings on the retail surface", () => {
  for (const html of [web, mini]) {
    assert.ok(!/founding|cohort|waitlist/i.test(html), "the founding cohort / waitlist gates are gone from the client");
    assert.ok(!html.includes('id="cohortLine"') && !html.includes('id="rateNote"'), "no cohort line, no rate note");
    assert.ok(html.includes("if (INST && st && st.guards) setModePill("), "the execution-mode pill is institutional-only");
    assert.ok(html.includes("if (INST && isWrapCoin && w && w.legs"), "the hedge receipt table (instruments, order refs) is institutional-only");
    assert.ok(!html.includes('title="\' + esc(w.failReason)') && !html.includes("esc(tooltip)") && !html.includes('$("connectMsg").title'), "no raw engine string rides a title attribute");
    assert.ok(html.includes("if (!INST) return s && !/^[a-z_]+$/.test(s) ? s : FALLBACK_CHIP;"), "retail chips show the server's retail sentence verbatim");
    assert.ok(html.includes("const paysLabel") && html.includes('"pays " + DAY_NAMES['), "a weekly cycle says 'pays Friday', not a 100-hour countdown");
    assert.ok(html.includes("w.coverageNote || (w.hedge && w.hedge.sizeNote)"), "coverage note read from the lifted retail field first");
    assert.ok(html.includes(".foot a,.foot span{white-space:nowrap}"), "footer links never break mid-phrase");
    assert.ok(html.includes(".nav-in{height:48px;padding:0 14px;flex-wrap:nowrap"), "the mobile header holds one line");
  }
});

test("desktop stage: the pitch beside the card in an exchange panel, retail web only, folds away on connect", () => {
  for (const html of [web, mini]) {
    assert.ok(html.includes('<aside class="pitch" id="pitch">') && html.includes("One toggle. A hard floor.") && html.includes("Flip protection on any perp position."), "the pitch column exists");
    assert.ok(html.includes('<div class="panel-top"><b>Positions</b><span>__BRAND_FOR__ · BTC</span></div>'), "the panel header names the venue: a trading UI's side panel, not a phone");
    assert.ok(html.includes("@media (min-width:900px){") && html.includes("body.retail:not(.connected) .stage{display:grid"), "the stage is desktop-only css on body.retail:not(.connected)");
    assert.ok(html.includes(".pitch,.panel-top{display:none}"), "phones never see the pitch or the panel header");
    assert.ok(html.includes('document.body.classList.toggle("connected", !!account && !watching)'), "connecting an own address folds the stage into the app; watching a showcase keeps it");
    assert.ok(html.includes("body.retail:not(.connected) .wrap .foot{display:none}") && html.includes('<b>For partners</b> __LINK_RECORD____LINK_TG____LINK_X__<span><a href="#" id="howLink2">How it works</a> ·</span>'), "on the stage the footer moves into the pitch column, placeholders included");
    assert.ok(html.includes('$("howLink2").onclick'), "the pitch's How it works opens the same modal");
    assert.ok(html.includes("body.retail:not(.connected) #hero{display:none!important}"), "the in-column hero never doubles the pitch");
  }
  assert.ok(web.includes("if (!INST && !false) document.body.classList.add(\"retail\");"), "web: retail body class arms the stage");
  assert.ok(mini.includes("if (!INST && !true) document.body.classList.add(\"retail\");"), "miniapp: never a stage, it is a phone surface");
});

test("variants: miniapp loads the Telegram bridge, web does not", () => {
  assert.ok(mini.includes("telegram-web-app.js"));
  assert.ok(!web.includes("telegram-web-app.js"));
});
