import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BRAND_PRESETS, DEFAULT_EMBED_BRAND, GENERIC_THEME, brandInitial, brandRecordUrl, brandTheme, renderEventEmbedHtml, renderPartnerHtml, resolveBrand, worthOffering } from "../scripts/eventProtectEmbedHtml";
import { summarizeCrossLedger } from "../src/eventCollar/crossVenue/crossLedger";
import { emptyEventFunnel, eventFunnelSummary, recordPageLoad, EVENT_PAGES } from "../src/eventCollar/crossVenue/eventFunnel";
import { forbiddenKeysIn } from "../src/eventCollar/retailShowcase";

process.env.NODE_ENV = "test";
const TMP_DIR = mkdtempSync(join(tmpdir(), "event-embed-test-"));
process.env.EVENT_X_FUNNEL_PATH = join(TMP_DIR, "funnel.json");
process.env.EVENT_X_LEDGER_PATH = join(TMP_DIR, "ledger.jsonl");
process.env.EVENT_X_ADMIN_TOKEN = "t0ken";
process.env.EVENT_X_BRAND_ALLOWLIST = "ProphetX, Novig";
process.env.EVENT_X_PARTNER_SHARE_PCT = "40";
process.env.EVENT_X_EMBED_BRAND = "Your Exchange";

test("embed: the brand is honoured only from the allowlist, case-insensitively, else 'Your app'", () => {
  assert.equal(resolveBrand("ProphetX", "ProphetX, Novig"), "ProphetX");
  assert.equal(resolveBrand("prophetx", "ProphetX, Novig"), "ProphetX", "canonical casing from the allowlist");
  assert.equal(resolveBrand("Kalshi", "ProphetX, Novig"), "Your Exchange", "a name not on the list never renders");
  assert.equal(resolveBrand("<script>", "ProphetX"), "Your Exchange");
  assert.equal(resolveBrand("ProphetX", undefined), "Your Exchange", "no allowlist: fail closed");
  assert.equal(resolveBrand(null, "ProphetX"), "Your Exchange");
  assert.equal(resolveBrand("  ", "ProphetX"), "Your Exchange");
  assert.equal(resolveBrand(null, "ProphetX", "Your Exchange"), "Your Exchange", "the configured default names the cold first screen");
  assert.equal(resolveBrand("Kalshi", "ProphetX", "Your Exchange"), "Your Exchange", "and is what an off-list name falls back to");
  assert.equal(resolveBrand("prophetx", "ProphetX", "Your Exchange"), "ProphetX", "an allowlisted name still wins");
  assert.equal(resolveBrand(null, "ProphetX", "  "), "Your Exchange", "a blank default is not a brand");
});

test("embed: brands bring a colourway and a default shell; anything else is the generic slate on light", () => {
  assert.deepEqual(brandTheme("DraftKings"), BRAND_PRESETS.draftkings);
  assert.equal(brandTheme("DraftKings").skin, "dark", "DraftKings ships dark");
  assert.equal(brandTheme("kalshi").skin, "light", "Kalshi ships light");
  assert.equal(brandTheme("Crypto.com").accent, "#1199FA", "dots survive the key");
  assert.deepEqual(brandTheme("Your Exchange"), GENERIC_THEME, "the placeholder host is generic");
  assert.equal(brandInitial("Your Exchange"), "E", "the pip shows the noun, not Y");
  assert.equal(brandInitial("DraftKings"), "D");
  assert.equal(brandInitial("your book"), "B");
  assert.equal(brandInitial("  "), "A");
  for (const [name, t] of Object.entries(BRAND_PRESETS)) {
    assert.match(t.accent, /^#[0-9A-Fa-f]{6}$/, `${name} accent is a hex colour`);
    assert.match(t.accentInk, /^#[0-9A-Fa-f]{6}$/, `${name} ink is a hex colour`);
    assert.notEqual(t.accent, GENERIC_THEME.accent, `${name} does not share the generic accent`);
  }
  const dk = renderEventEmbedHtml({ brand: "DraftKings" });
  assert.ok(dk.includes("--accent:#53D337; --accent-ink:#0f1115;"), "the brand's colour is the shell's accent");
  assert.ok(dk.includes("--bg:#0f1115"), "no ?skin= and the preset's dark shell is used");
  assert.ok(dk.includes('<div class="brand"><i>D</i>DraftKings</div>'), "the brand pip carries the initial");
  const dkLight = renderEventEmbedHtml({ brand: "DraftKings", skin: "light" });
  assert.ok(dkLight.includes("--bg:#f4f5f7") && dkLight.includes("--accent:#53D337"), "?skin= overrides the shell, not the colour");
  const generic = renderEventEmbedHtml({ brand: "Your Exchange" });
  assert.ok(generic.includes(`--accent:${GENERIC_THEME.accent};`) && generic.includes("--bg:#f4f5f7"), "generic: slate on light");
  assert.ok(generic.includes('<div class="brand"><i>E</i>Your Exchange</div>'), "the placeholder pip reads E");
});

test("embed: a partner shell's record link is its own slate page with a key for that slate alone; the generic shell links to the public record", () => {
  const pub = brandRecordUrl("https://shadow.example/", "Your Exchange", "share-secret");
  assert.deepEqual(pub, { url: "https://shadow.example", slate: false }, "the placeholder host has no slate");
  const noKey = brandRecordUrl("https://shadow.example", "Wire Markets", undefined);
  assert.deepEqual(noKey, { url: "https://shadow.example", slate: false }, "no share key configured: the public record");
  const wm = brandRecordUrl("https://shadow.example", "Wire Markets", "share-secret");
  assert.equal(wm.slate, true);
  assert.match(wm.url, /^https:\/\/shadow\.example\/slate\/wiremarkets\?k=[0-9a-f]{24}$/);
  assert.ok(!wm.url.includes("share-secret"), "the share key itself never appears in a page");
  assert.notEqual(brandRecordUrl("https://shadow.example", "Sporttrade", "share-secret").url.split("k=")[1], wm.url.split("k=")[1], "one key per slate");

  const html = renderEventEmbedHtml({ brand: "Wire Markets", trackRecordUrl: wm.url, recordIsSlate: true });
  assert.ok(html.includes(`<a href="${wm.url.replace(/&/g, "&amp;")}">Wire Markets record</a>`), "both record links go to the slate, labelled with the brand");
  assert.equal(html.split(`href="${wm.url}"`).length - 1, 2, "the pitch link and the phone link");
  assert.ok(html.includes('<a href="/partner?brand=Wire%20Markets">Partner console</a>'), "the partner console keeps the brand");
  const generic = renderEventEmbedHtml({ brand: "Your Exchange", trackRecordUrl: "https://shadow.example" });
  assert.ok(generic.includes('<a href="https://shadow.example">Track record</a>') && generic.includes('<a href="/partner">Partner console</a>'));
});

test("embed: a sportsbook shell lists games only; the generic shell and ?kind= decide otherwise", () => {
  assert.equal(brandTheme("Wire Markets").sportsOnly, true);
  assert.equal(brandTheme("WagerWire").accent, brandTheme("Wire Markets").accent, "one colourway for the group");
  assert.equal(brandTheme("DraftKings").sportsOnly, true);
  assert.equal(brandTheme("Kalshi").sportsOnly, undefined, "a prediction market lists everything it lists");
  assert.equal(GENERIC_THEME.sportsOnly, undefined);
  const wm = renderEventEmbedHtml({ brand: "Wire Markets" });
  assert.ok(wm.includes("var SPORTS_ONLY=true;"), "the preset hides the crypto strikes");
  assert.ok(wm.includes("if(SPORTS_ONLY)rows=rows.filter(function(r){return r.kind!=='crypto'});"), "filtered where the rows are loaded");
  assert.ok(wm.includes('<div class="brand"><i>W</i>Wire Markets</div>') && wm.includes("--accent:#02FDDD;"));
  assert.ok(renderEventEmbedHtml({ brand: "Wire Markets", sportsOnly: false }).includes("var SPORTS_ONLY=false;"), "?kind=all overrides the preset");
  assert.ok(renderEventEmbedHtml({ brand: "Your Exchange" }).includes("var SPORTS_ONLY=false;"), "the generic shell shows the whole board");
  assert.ok(renderEventEmbedHtml({ brand: "Your Exchange", sportsOnly: true }).includes("var SPORTS_ONLY=true;"), "?kind=sports narrows any shell");
});

test("embed: the minimum-credit rule hides negligible tiers: 25¢ and 0.25% of stake, whichever is more", () => {
  assert.equal(worthOffering(25, 10), true, "25¢ on $10 clears both");
  assert.equal(worthOffering(24, 10), false, "24¢ never clears");
  assert.equal(worthOffering(37, 150), false, "0.25% of $150 is 38¢; 37¢ is under");
  assert.equal(worthOffering(38, 150), true);
  assert.equal(worthOffering(0, 1), false);
  const html = renderEventEmbedHtml({ brand: "ProphetX" });
  assert.ok(html.includes("var MIN_CREDIT_CENTS=25,MIN_CREDIT_BPS=25;"), "the page script runs the same rule");
  assert.ok(html.includes("function worthIt(t,n){return !!t&&t.creditCents>=Math.max(MIN_CREDIT_CENTS,Math.round(n*100*MIN_CREDIT_BPS/10000))}"));
  assert.ok(html.includes("The market can\\'t fund a worthwhile credit on this one right now."), "when no tier clears, the sheet refuses rather than offering pennies");
  assert.ok(html.includes("function defaultTier(offered){return offered.balanced?'balanced':offered.tight?'tight':offered.wide?'wide':null}"), "one shape by default: Balanced, then the next that clears");
});

test("embed: the host shell is theirs, the button and the sheet are ours; copy is outcomes, not mechanics", () => {
  const html = renderEventEmbedHtml({ brand: "ProphetX", skin: "light" });
  assert.ok(html.includes("<title>ProphetX · Positions</title>"), "the host's name on the tab");
  assert.ok(html.includes('<div class="brand"><i>P</i>ProphetX</div>'), "and on the shell");
  assert.ok(html.includes('class="tabs"') && html.includes(">Positions</span>"), "a host positions list, not our board");
  assert.ok(html.includes('data-tab="Markets"') && html.includes('data-tab="Activity"') && html.includes("toast('Demo: only Positions is live here.')"), "the other tabs answer with a toast, not silence");
  assert.ok(html.includes('id="bal">Cash $412.50<'), "a plausible balance, not $0.00");
  assert.ok(html.includes("cash:41250"), "and the script starts from it");
  assert.ok(html.includes('data-protect="'), "one Protect button per row");
  assert.ok(html.includes('id="sheet"') && html.includes('role="dialog"'), "the sheet is a dialog over the host");
  assert.ok(html.includes("protection by") && html.includes("data:image/png;base64"), "the sheet carries our wordmark, inlined");
  assert.ok(html.includes(".sheet .eyebrow img{height:20px;display:block}"), "the wordmark in Atticus gold, 20px, full strength: brand colour, legible on the sheet");
  assert.ok(!html.includes("brightness(0)"), "never recoloured");
  assert.ok(html.includes(".pitch img{height:24px;display:block;margin-bottom:22px}"), "24px on the desktop pitch");
  assert.ok(!html.includes("data:image/jpeg"), "the black-tile mark is gone from the embed");
  assert.ok(html.includes("Protect this position"), "same grammar as the board");
  assert.ok(html.includes(">if it loses<") && html.includes(">paid now<") && html.includes(">if it wins<"), "three tiles, three outcomes");
  assert.ok(html.includes('<div class="was">was $0</div>') && html.includes("<div class=\"was\">was '+usd0(100*n)+'</div>"), "each outcome tile shows what it was without protection");
  assert.ok(html.includes("Protect · +'+usd(t.creditCents)+' now"), "the button says what you get");
  assert.ok(html.includes("function reshape(n,F,C,K){return {kept:n*(C-F)/100, cashCents:F*n+K"), "the reshape identity stays in code");
  assert.ok(html.includes("ends <b>'+usd(p.floorTotal)+'</b> or <b>'+usd(p.capTotal)+'</b> · <b>'+usd(p.creditCents)+'</b> paid now"), "a protected row reads as two endings and the credit");
  assert.ok(html.includes("' contracts · ends $0 or '+usd0(100*r.contracts)+'"), "an unprotected row reads as two endings too");
  assert.ok(!html.includes("contracts</b> kept") && !html.includes("set aside"), "no contracts-kept or cash-set-aside mechanics on the row");
  assert.ok(html.includes("&#x2713; Protected"), "protected badge");
  assert.ok(html.includes('">reset · demo only</button>'), "the reset says it is demo only");
  assert.ok(html.includes('<button class="closeb" data-close="\'+esc(r.kalshiTicker)+\'">close early</button>'), "a protected row offers close early");
  assert.ok(html.includes('<div class="lock">locked at your tap · an early exit is a new trade at live prices</div>'), "a protected row states the lock");
  assert.ok(html.includes("Terms lock at your tap; the other side is bought in the same second."), "the sheet explains the lock and the demo reset");
  assert.ok(html.includes("fetch('/api/close-quote?'+qs") && html.includes("Close early · '+usd(c.leaveWithCents)+' now"), "close early quotes live and prices the button");
  assert.ok(html.includes("a new trade, not a reversal") && html.includes("Leaving costs the spread on both sides"), "the close sheet says what leaving is and what it costs");
  assert.ok(html.includes("closed early · left with <b>") && html.includes("&#x2713; Closed"), "a closed row shows what the user left with");
  assert.ok(html.includes('class="chips'+"'+(S.adjust?' on':'')+'"), "tiers are hidden until adjust is tapped");
  assert.ok(html.includes('id="sh-adjust">adjust</a>'), "one shape by default, adjust on request");
  assert.ok(html.includes("if(keys.length>1)"), "adjust is offered only when more than one tier clears");
  assert.ok(html.includes("/api/showcase?ticker="), "the sheet prices from the retail showcase endpoint");
  assert.ok(html.includes("<b>Not right now.</b> '+esc(detail)"), "refusals render the server's retail sentence");
  assert.ok(html.includes("track('protect_on',ticker,S.tier)") && html.includes("track('row_tap',ticker)"), "taps flow into the same funnel");
  assert.ok(html.includes("You sell part of this position at today\\'s price and keep the rest. That is why you are paid now."), "how it works: the sale framing, not set-aside");
  assert.ok(html.includes("The credit you see is the credit you get."), "the fee is explained as netted, once");
  assert.ok(html.includes("Nothing to manage. It settles with your position."), "passive after the tap");
  assert.ok(html.includes("<span>Demo. Simulated positions at live prices; nothing is bought.</span><a href=\"https://atticus-event-shadow.onrender.com\">Track record</a></div>"), "the phone note: the disclaimer, then the one link on its own line");
  assert.ok(html.includes(".host-note span,.host-note a{display:block}") && html.includes(".host-note a{color:var(--dim);pointer-events:auto;white-space:nowrap"), "the link never wraps or strands mid-sentence");
  assert.ok(!html.includes('<a href="/board">Board</a>') && !html.includes('<a href="/receipts">Receipts</a></div>'), "board and receipts are off the phone");
  assert.ok(html.includes('<aside class="pitch">') && html.includes("Protection inside your app.") && html.includes("One JSON quote in, one receipt out"), "desktop: the pitch beside the phone");
  assert.ok(html.includes("One button on every open position."), "the pitch speaks to the partner, not the integrator");
  assert.ok(html.includes("We price the protection and hedge it leg for leg; you keep the flow, the ledger and the relationship."), "the subline carries the deal and never claims we carry risk");
  assert.ok(!html.includes("carry the risk"), "the record says we carry no outcome risk; the pitch must not contradict it");
  assert.ok(html.includes("Demonstration only."), "labelled a demonstration, plainly");
  assert.ok(html.includes('<b>For partners</b><a href="https://atticus-event-shadow.onrender.com">Track record</a><a href="/partner?brand=ProphetX">Partner console</a><a href="/receipts">Receipts</a><a href="/board">Full board</a>'), "desktop: every partner surface in one row, the console opened as this brand");
  const plain = renderEventEmbedHtml({ brand: DEFAULT_EMBED_BRAND });
  assert.ok(plain.includes('<a href="/partner">Partner console</a>'), "the default brand opens the console unbranded");
  const custom = renderEventEmbedHtml({ brand: "ProphetX", trackRecordUrl: "https://tr.example", minCredit: { cents: 50, bpsOfStake: 10 } });
  assert.ok(custom.includes('href="https://tr.example">Track record</a>'), "the track record URL comes from the server");
  assert.ok(custom.includes("var MIN_CREDIT_CENTS=50,MIN_CREDIT_BPS=10;"), "the page mirrors the server's minimum-credit rule");
  assert.ok(html.includes("@media(min-width:900px)") && html.includes(".host-note,.scrim,.sheet,.toast{position:absolute}"), "on desktop the sheet stays inside the phone frame");
  assert.ok(html.includes("far=dt.getTime()-Date.now()>86400000") && html.includes("month:'short',day:'numeric'"), "past 24h out the row shows the date, so next Sunday's game never reads as today's");
  // The phone is retail copy: outcomes, never mechanics. The desktop pitch aside speaks to the partner and may say "hedge".
  const phone = html.replace(/<aside class="pitch">[\s\S]*?<\/aside>/, "");
  assert.ok(phone.length < html.length, "the pitch aside is present and excluded from the retail leak check");
  for (const leak of ["Kalshi", "Polymarket", "hedge", "route", "take", "instId", "OKX", "tight", "wide"]) {
    assert.ok(!new RegExp(`\\b${leak}\\b`).test(phone.replace(/protection by/g, "").replace(/'tight'|'wide'|tight:|wide:|offered\.tight|offered\.wide/g, "")), `"${leak}" is not on the embedded page as copy`);
  }
  assert.ok(!html.includes("—"), "no em dash in any copy");
  const dark = renderEventEmbedHtml({ brand: "Your Exchange", skin: "dark" });
  assert.ok(dark.includes("--bg:#0f1115"), "dark skin flips the host shell");
  assert.ok(dark.includes(".sheet{position:fixed") && dark.includes("background:#fff;color:var(--ep-ink)"), "the sheet keeps its own look in a dark host");
  assert.ok(renderEventEmbedHtml({ brand: "A&B \"x\"", skin: "light" }).includes("A&amp;B &quot;x&quot;"), "the brand is escaped");
});

test("embed: the partner console reads the ledger and funnel in the host's words: volume, credits, cost, own-book share, refusals, revenue share", () => {
  const path = join(TMP_DIR, "partner-ledger.jsonl");
  const rec = (at: string, result: Record<string, unknown>, route?: string, evCostBps?: number) =>
    JSON.stringify({
      at,
      kind: "cross_venue_quote",
      kalshiTicker: "KXMLBGAME-T",
      pmEventSlug: "",
      fingerprint: "f",
      markCents: 60,
      entryCents: 55,
      contracts: 150,
      result,
      ...(route ? { route } : {}),
      ...(evCostBps !== undefined ? { evCostBps } : {}),
      routesChecked: [],
    });
  writeFileSync(
    path,
    [
      rec("2026-09-18T10:00:00.000Z", { ok: true, contracts: 150, creditCents: 400, takeCents: 40 }, "kalshi_self", 120),
      rec("2026-09-19T10:00:00.000Z", { ok: true, contracts: 150, creditCents: 300, takeCents: 60 }, "polymarket", -80),
      rec("2026-09-20T10:00:00.000Z", { ok: false, code: "protection_too_rich", detail: "4.72% vs 3.00%" }),
      rec("2026-09-20T11:00:00.000Z", { ok: false, code: "kalshi_book_too_thin", detail: "thin" }),
    ].join("\n") + "\n",
  );
  const ledger = summarizeCrossLedger(path);
  assert.equal(ledger.stakeQuotedCents, 30_000, "stake behind priced quotes: 100¢ × contracts");
  assert.equal(ledger.priced, 2);
  assert.equal(ledger.refused, 2);

  const f = emptyEventFunnel();
  const now = Date.parse("2026-09-20T12:00:00.000Z");
  recordPageLoad(f, "embed", now);
  recordPageLoad(f, "embed", now - 1000);
  recordPageLoad(f, "app", now);
  const funnel = eventFunnelSummary(f, now);
  assert.ok((EVENT_PAGES as readonly string[]).includes("embed"), "embed is a funnel page");

  const html = renderPartnerHtml({ atIso: "2026-09-20T12:00:00.000Z", brand: "ProphetX", ledger, funnel, sharePct: 40, maxEvCostBps: 300 });
  assert.ok(html.includes("partner console · ProphetX"));
  assert.ok(html.includes("$300.00</div><div class=\"l\">volume protected"), "volume protected is the stake behind priced quotes");
  assert.ok(html.includes("$7.00</div><div class=\"l\">credits paid to your users"));
  assert.ok(html.includes("0.20%</div><div class=\"l\">average cost of protection"), "mean EV cost of priced quotes");
  assert.ok(html.includes("$0.40</div><div class=\"l\">your share (40% of take)"), "40% of $1.00 take kept");
  assert.ok(html.includes("<span>priced</span><b>2 <i>of 4 · 50% fill</i></b>"));
  assert.ok(html.includes("<span>priced on your own book</span><b>1 <i>50%</i></b>"));
  assert.ok(html.includes("priced cross-venue on the same game") && !html.includes("Polymarket"), "routes in the host's words, no venue names");
  assert.ok(html.includes("protection would have cost more than our ceiling</span><b>1</b>"), "the ceiling refusal is named for what it is");
  assert.ok(html.includes("not enough depth on the market's No side</span><b>1</b>"));
  assert.ok(html.includes("<span>ceiling on cost of protection</span><b>3.00% <i>of expected value</i></b>"));
  assert.ok(html.includes("<span>embedded shell loads, 7 days</span><b>2</b>"), "embed loads counted apart from the board");
  assert.ok(html.includes("we price and hedge <i>your venue executes and settles</i>"), "who does what, stated");
  assert.ok(!html.includes("quote-only"), "not a pricer");
  assert.ok(html.includes("data:image/png;base64") && html.includes(".topbar img{height:18px;display:block}"), "the gold wordmark on the console bar");
  assert.ok(html.includes("2026-09-18 to 2026-09-20 UTC"));
  assert.ok(!html.includes("—"), "no em dash");
});

test("embed: / is the embed shell (also /embed), /board is the board; brand-gated; /partner needs the operator token", async () => {
  const { server, primeScanForTests } = await import("../scripts/eventProtectXDemoService");
  primeScanForTests({ atIso: "2026-09-20T18:00:00.000Z", rows: [], fallback: null, fetchFailures: 0 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const shell = await fetch(`${base}/embed?brand=novig&skin=dark`);
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get("content-type") ?? "", /text\/html/);
    const html = await shell.text();
    assert.ok(html.includes("<title>Novig · Positions</title>"), "allowlisted brand, canonical casing");
    assert.ok(html.includes("--bg:#0f1115"), "dark skin");
    const other = await (await fetch(`${base}/embed?brand=Kalshi`)).text();
    assert.ok(other.includes("<title>Your Exchange · Positions</title>"), "a name off the list falls back to EVENT_X_EMBED_BRAND");

    // the front door is the embed shell; the board has its own address
    const root = await (await fetch(`${base}/`)).text();
    assert.ok(root.includes("<title>Your Exchange · Positions</title>") && root.includes('id="sheet"'), "/ serves the embed shell with the default brand");
    const board = await (await fetch(`${base}/board`)).text();
    assert.ok(board.includes('id="toggle"') && board.includes("Best protection right now"), "/board serves the board");
    assert.ok(!root.includes("Best protection right now"), "the shell is not the board");

    // /partner without the token is the public case for the console with one CTA, never a JSON error
    const publicPartner = await fetch(`${base}/partner`);
    assert.equal(publicPartner.status, 200);
    assert.match(publicPartner.headers.get("content-type") ?? "", /text\/html/);
    const ctaHtml = await publicPartner.text();
    assert.ok(ctaHtml.includes("The console your team gets.") && ctaHtml.includes('href="mailto:michael@atticustrade.com?subject='), "the pitch and a Talk to us CTA");
    assert.ok(ctaHtml.includes('href="https://atticus-event-shadow.onrender.com">track record</a>'), "and the track record as the soft path");
    assert.ok(!ctaHtml.includes("your share (") && !/\$\d/.test(ctaHtml), "no numbers: the console's figures stay behind the token");
    assert.ok(!ctaHtml.includes("admin_required") && !ctaHtml.includes("token"), "nothing about tokens");
    const wrongToken = await fetch(`${base}/partner?token=nope`);
    assert.equal(wrongToken.status, 200, "a wrong token is a visitor too");
    assert.ok((await wrongToken.text()).includes("The console your team gets."));
    const console_ = await fetch(`${base}/partner?token=t0ken&brand=ProphetX`);
    assert.equal(console_.status, 200);
    const consoleHtml = await console_.text();
    assert.ok(consoleHtml.includes("partner console · ProphetX"));
    assert.ok(consoleHtml.includes("your share (40% of take)"), "EVENT_X_PARTNER_SHARE_PCT read");
    assert.ok(consoleHtml.includes("ceiling on cost of protection</span><b>3.00%"), "default ceiling shown");

    const retail = (await (await fetch(`${base}/api/showcase`)).json()) as { board: unknown[] };
    assert.deepEqual(retail.board, []);
    assert.deepEqual(forbiddenKeysIn(retail), []);

    const funnel = (await (await fetch(`${base}/api/admin/funnel?token=t0ken`)).json()) as { funnel: { pageLoads7d: Array<{ byPage: Record<string, number> }> } };
    const embedLoads = funnel.funnel.pageLoads7d.reduce((n, d) => n + (d.byPage.embed ?? 0), 0);
    const boardLoads = funnel.funnel.pageLoads7d.reduce((n, d) => n + (d.byPage.app ?? 0), 0);
    assert.equal(embedLoads, 3, "/embed twice and / once count as embed loads");
    assert.equal(boardLoads, 1, "/board counts as a board load");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
