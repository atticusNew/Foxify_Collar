import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BRAND_PRESETS, GENERIC_THEME, brandTheme, renderEventEmbedHtml, renderPartnerHtml, resolveBrand, worthOffering } from "../scripts/eventProtectEmbedHtml";
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
process.env.EVENT_X_EMBED_BRAND = "Demo Exchange";

test("embed: the brand is honoured only from the allowlist, case-insensitively, else 'Your app'", () => {
  assert.equal(resolveBrand("ProphetX", "ProphetX, Novig"), "ProphetX");
  assert.equal(resolveBrand("prophetx", "ProphetX, Novig"), "ProphetX", "canonical casing from the allowlist");
  assert.equal(resolveBrand("Kalshi", "ProphetX, Novig"), "Your app", "a name not on the list never renders");
  assert.equal(resolveBrand("<script>", "ProphetX"), "Your app");
  assert.equal(resolveBrand("ProphetX", undefined), "Your app", "no allowlist: fail closed");
  assert.equal(resolveBrand(null, "ProphetX"), "Your app");
  assert.equal(resolveBrand("  ", "ProphetX"), "Your app");
  assert.equal(resolveBrand(null, "ProphetX", "Demo Exchange"), "Demo Exchange", "the configured default names the cold first screen");
  assert.equal(resolveBrand("Kalshi", "ProphetX", "Demo Exchange"), "Demo Exchange", "and is what an off-list name falls back to");
  assert.equal(resolveBrand("prophetx", "ProphetX", "Demo Exchange"), "ProphetX", "an allowlisted name still wins");
  assert.equal(resolveBrand(null, "ProphetX", "  "), "Your app", "a blank default is not a brand");
});

test("embed: brands bring a colourway and a default shell; anything else is the generic slate on light", () => {
  assert.deepEqual(brandTheme("DraftKings"), BRAND_PRESETS.draftkings);
  assert.equal(brandTheme("DraftKings").skin, "dark", "DraftKings ships dark");
  assert.equal(brandTheme("kalshi").skin, "light", "Kalshi ships light");
  assert.equal(brandTheme("Crypto.com").accent, "#1199FA", "dots survive the key");
  assert.deepEqual(brandTheme("Demo Exchange"), GENERIC_THEME, "the demo host is generic");
  assert.deepEqual(brandTheme("Your app"), GENERIC_THEME);
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
  const generic = renderEventEmbedHtml({ brand: "Demo Exchange" });
  assert.ok(generic.includes(`--accent:${GENERIC_THEME.accent};`) && generic.includes("--bg:#f4f5f7"), "generic: slate on light");
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
  assert.ok(html.includes(".sheet .eyebrow img{height:16px;display:block;opacity:.7;filter:brightness(0)}"), "rendered as ink at 16px / 70%: legible on the white sheet, still quiet");
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
  assert.ok(html.includes('">undo</button>') && !html.includes("undo (demo)"), "undo is quiet");
  assert.ok(html.includes('class="chips'+"'+(S.adjust?' on':'')+'"), "tiers are hidden until adjust is tapped");
  assert.ok(html.includes('id="sh-adjust">adjust</a>'), "one shape by default, adjust on request");
  assert.ok(html.includes("if(keys.length>1)"), "adjust is offered only when more than one tier clears");
  assert.ok(html.includes("/api/showcase?ticker="), "the sheet prices from the retail showcase endpoint");
  assert.ok(html.includes("<b>Not right now.</b> '+esc(detail)"), "refusals render the server's retail sentence");
  assert.ok(html.includes("track('protect_on',ticker,S.tier)") && html.includes("track('row_tap',ticker)"), "taps flow into the same funnel");
  assert.ok(html.includes("You sell part of this position at today\\'s price and keep the rest. That is why you are paid now."), "how it works: the sale framing, not set-aside");
  assert.ok(html.includes("The credit you see is the credit you get."), "the fee is explained as netted, once");
  assert.ok(html.includes("Nothing to manage. It settles with your position."), "passive after the tap");
  assert.ok(html.includes("Demo. Simulated positions at live prices; nothing is bought. · <a href=\"https://atticus-event-shadow.onrender.com\">Track record</a></div>"), "the phone has one line and one link: the track record");
  assert.ok(!html.includes('<a href="/board">Board</a>') && !html.includes('<a href="/receipts">Receipts</a></div>'), "board and receipts are off the phone");
  assert.ok(html.includes('<aside class="pitch">') && html.includes("Protection inside your app.") && html.includes("One JSON quote in, one receipt out"), "desktop: the pitch beside the phone");
  assert.ok(html.includes("We price it and carry the risk; you keep the flow, the ledger and the relationship."), "the subline carries the deal");
  assert.ok(html.includes('<b>For partners</b><a href="https://atticus-event-shadow.onrender.com">Track record</a><a href="/partner">Partner console</a><a href="/receipts">Receipts</a><a href="/board">Full board</a>'), "desktop: every partner surface in one row");
  const custom = renderEventEmbedHtml({ brand: "ProphetX", trackRecordUrl: "https://tr.example", minCredit: { cents: 50, bpsOfStake: 10 } });
  assert.ok(custom.includes('href="https://tr.example">Track record</a>'), "the track record URL comes from the server");
  assert.ok(custom.includes("var MIN_CREDIT_CENTS=50,MIN_CREDIT_BPS=10;"), "the page mirrors the server's minimum-credit rule");
  assert.ok(html.includes("@media(min-width:900px)") && html.includes(".host-note,.scrim,.sheet,.toast{position:absolute}"), "on desktop the sheet stays inside the phone frame");
  assert.ok(html.includes("far=dt.getTime()-Date.now()>86400000") && html.includes("month:'short',day:'numeric'"), "past 24h out the row shows the date, so next Sunday's game never reads as today's");
  for (const leak of ["Kalshi", "Polymarket", "hedge", "route", "take", "instId", "OKX", "tight", "wide"]) {
    assert.ok(!new RegExp(`\\b${leak}\\b`).test(html.replace(/protection by/g, "").replace(/'tight'|'wide'|tight:|wide:|offered\.tight|offered\.wide/g, "")), `"${leak}" is not on the embedded page as copy`);
  }
  assert.ok(!html.includes("—"), "no em dash in any copy");
  const dark = renderEventEmbedHtml({ brand: "Your app", skin: "dark" });
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
  assert.ok(html.includes("data:image/png;base64") && html.includes(".topbar img{height:16px;display:block;opacity:.7;filter:brightness(0)}"), "the wordmark as ink, subtle, on the console bar");
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
    assert.ok(other.includes("<title>Demo Exchange · Positions</title>"), "a name off the list falls back to EVENT_X_EMBED_BRAND");

    // the front door is the embed shell; the board has its own address
    const root = await (await fetch(`${base}/`)).text();
    assert.ok(root.includes("<title>Demo Exchange · Positions</title>") && root.includes('id="sheet"'), "/ serves the embed shell with the default brand");
    const board = await (await fetch(`${base}/board`)).text();
    assert.ok(board.includes('id="toggle"') && board.includes("Best protection right now"), "/board serves the board");
    assert.ok(!root.includes("Best protection right now"), "the shell is not the board");

    assert.equal((await fetch(`${base}/partner`)).status, 403, "the console names our take: operator only");
    assert.equal((await fetch(`${base}/partner?token=nope`)).status, 403);
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
