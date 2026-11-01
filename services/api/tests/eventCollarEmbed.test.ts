import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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

test("embed: brands bring a colourway and a default shell; anything else is the generic dark shell in sportsbook green", () => {
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
    // the generic shell borrows DraftKings' green on purpose; every other brand keeps its own colour
    if (name !== "draftkings") assert.notEqual(t.accent, GENERIC_THEME.accent, `${name} does not share the generic accent`);
  }
  const dk = renderEventEmbedHtml({ brand: "DraftKings" });
  assert.ok(dk.includes("--accent:#53D337; --accent-ink:#0f1115;"), "the brand's colour is the shell's accent");
  assert.ok(dk.includes("--bg:#0f1115"), "no ?skin= and the preset's dark shell is used");
  assert.ok(dk.includes('<div class="brand"><i>D</i>DraftKings</div>'), "the brand pip carries the initial");
  const dkLight = renderEventEmbedHtml({ brand: "DraftKings", skin: "light" });
  assert.ok(dkLight.includes("--bg:#f4f5f7") && dkLight.includes("--accent:#53D337"), "?skin= overrides the shell, not the colour");
  const generic = renderEventEmbedHtml({ brand: "Your Exchange" });
  assert.ok(generic.includes(`--accent:${GENERIC_THEME.accent};`) && generic.includes("--bg:#0f1115"), "generic: sportsbook green on the dark shell");
  assert.ok(renderEventEmbedHtml({ brand: "Your Exchange", skin: "light" }).includes("--bg:#f4f5f7"), "?skin=light still flips the generic shell");
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
  assert.equal(html.split(`href="${wm.url}"`).length - 1, 3, "the pitch link, the phone's and the desktop table's");
  assert.ok(html.includes('<a href="/partner?brand=Wire%20Markets">Partner console</a>'), "the partner console keeps the brand");
  assert.ok(!html.includes('href="/receipts"') && !html.includes('href="/board"'), "the whole-book pages are off a shell whose record is its own slate");
  assert.ok(html.includes("Partner console</a></div>"), "the partner row ends at the console");
  const generic = renderEventEmbedHtml({ brand: "Your Exchange", trackRecordUrl: "https://shadow.example" });
  assert.ok(generic.includes('<a href="https://shadow.example">Track record</a>') && generic.includes('<a href="/partner">Partner console</a>'));
  assert.ok(generic.includes('<a href="/receipts">Receipts</a><a href="/board">Full board</a>'), "the generic shell keeps receipts and the full board");
  const brandedNoKey = renderEventEmbedHtml({ brand: "Wire Markets", trackRecordUrl: "https://shadow.example" });
  assert.ok(brandedNoKey.includes('<a href="/receipts">Receipts</a><a href="/board">Full board</a>'), "without a slate link the branded shell falls back to the full set, as before");
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

test("embed: the minimum-credit rule hides negligible tiers: 5¢ and 0.25% of stake, whichever is more", () => {
  assert.equal(worthOffering(5, 10), true, "5¢ on $10 clears both");
  assert.equal(worthOffering(4, 10), false, "4¢ never clears");
  assert.equal(worthOffering(37, 150), false, "0.25% of $150 is 38¢; 37¢ is under");
  assert.equal(worthOffering(38, 150), true);
  assert.equal(worthOffering(0, 1), false);
  const html = renderEventEmbedHtml({ brand: "ProphetX" });
  assert.ok(html.includes("var MIN_CREDIT_CENTS=5,MIN_CREDIT_BPS=25;"), "the page script runs the same rule");
  assert.ok(html.includes("function worthIt(t,n){return !!t&&t.creditCents>=Math.max(MIN_CREDIT_CENTS,Math.round(n*100*MIN_CREDIT_BPS/10000))}"));
  assert.ok(html.includes("The market can\\'t fund a worthwhile credit on this one right now."), "when no tier clears, the sheet refuses rather than offering pennies");
  assert.ok(html.includes("function defaultTier(offered,q){if(q&&q.tier&&offered[q.tier])return q.tier;for(var i=0;i<TIER_ORDER.length;i++)if(offered[TIER_ORDER[i]])return TIER_ORDER[i];return null}"), "one shape by default: the one the service heads the quote with, else the first in the extension's order that clears");
});

test("embed: the page script parses, for every skin and brand shape", () => {
  for (const opts of [{ brand: "ProphetX" }, { brand: "Your Exchange", skin: "dark" as const }, { brand: "A&B \"x\"" }, { brand: DEFAULT_EMBED_BRAND, liveVideo: null }]) {
    const html = renderEventEmbedHtml(opts);
    const js = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
    assert.ok(js.length > 10_000, "the script is in the page");
    assert.doesNotThrow(() => new Function(js), `the page script parses for ${JSON.stringify(opts)}`);
  }
});

test("embed: the host shell is theirs, the line and the panel are ours (the extension's, in the host's colours); copy is outcomes, not mechanics", () => {
  const html = renderEventEmbedHtml({ brand: "ProphetX", skin: "light" });
  assert.ok(html.includes("<title>ProphetX · Positions</title>"), "the host's name on the tab");
  assert.ok(html.includes('<div class="brand"><i>P</i>ProphetX</div>'), "and on the shell");
  assert.ok(html.includes('<div class="tabs"><span class="on" data-tab="Positions">Positions</span><span data-tab="Parlays">Parlays</span><span data-tab="Activity">Activity</span></div>'), "three tabs, all live");
  assert.ok(!html.includes('data-tab="Markets"') && !html.includes("Positions and Parlays are live here"), "no Markets tab and no dead-tab toast: browsing is the host's product");
  assert.ok(html.includes("if(tab==='Positions'||tab==='Parlays'||tab==='Activity'){switchTab(tab);return}"), "every tab switches");
  // two shells, one state: the phone, and a venue's desktop My Trades table; the control shows only on a wide stage
  assert.ok(html.includes('<div class="seg shellseg" role="group" aria-label="Shell"><button type="button" data-shell="phone" aria-pressed="true">Phone</button><button type="button" data-shell="table" aria-pressed="false">Desktop</button></div>'), "a segmented control picks the shell");
  assert.ok(html.includes(".seg.shellseg{display:none}") && html.includes(".seg.shellseg{display:inline-flex}"), "hidden on a phone, shown on desktop");
  assert.ok(html.includes('<nav><span>Markets</span><span class="on">My Trades</span><span>Account</span></nav>'), "the table wears the venue's own nav");
  assert.ok(html.includes('<div class="thead"><span>Position</span><span>Stake</span><span>Price</span><span>Payout</span><span>Placed</span></div>'), "a table of the venue's columns");
  assert.ok(html.includes("var into=S.shell==='table'?el('tbody'):el('list');"), "one painter, two targets");
  assert.ok(html.includes("host=(S.shell==='table'?el('tbody'):el('list')).querySelector('.ael-row[data-row=\"'+t.replace(/\"/g,'')+'\"]')"), "a row repaint finds the shown shell's copy, never the hidden one");
  assert.ok(html.includes("if(/[?&]shell=table\\b/i.test(location.search)&&window.matchMedia&&window.matchMedia('(min-width:900px)').matches)setShell('table');"), "?shell=table deep-links the table, on a stage wide enough to hold it");
  // realistic rows: a stake from the ticker, contracts at the entry price, payout, placed a while back
  assert.ok(html.includes("var STAKES=[1000,2500,5000,10000,2000,4000,7500,1500];") && html.includes("function sizeOf(r){"), "varied sizes, stable per ticker");
  assert.ok(html.includes("n=Math.round(stake/r.entryCents*100)/100"), "contracts are what the stake bought at the entry price");
  assert.ok(html.includes('<div class="facts"><span>Stake<b>\'+usd(z.stakeCents)+\'</b></span><span>Price<b>\'+r.entryCents+\'¢</b></span><span>Payout<b>\'+usd(z.payoutCents)+\'</b></span><span>Placed<b>\'+esc(fmtAt(z.placedIso))+\'</b></span></div>'), "the row's facts as a venue prints them");
  assert.ok(html.includes("function scaled(t,q,n){var k=n/(q.contracts||n||1);return {floorCents:t.floorCents,capCents:t.capCents,creditCents:Math.round(t.creditCents*k)}}"), "the quote's credit scales to the row's size; the floor and the cap are per contract");
  // cash: a plausible balance in both shells, every change through addCash, the pulse beside it
  assert.ok(html.includes('<span id="bal" data-bal>Cash $412.50</span>') && html.includes('<div class="bal"><span data-bal>Cash $412.50</span></div>'), "a plausible balance on the phone and the table");
  assert.ok(html.includes("cash:41250"), "and the script starts from it");
  assert.ok(html.includes("function paintCash(){var bs=document.querySelectorAll('[data-bal]');"), "one repaint reaches every balance");
  assert.ok(html.includes("function addCash(cents){") && html.includes("d.textContent=(cents>0?'+':'-')+usd(Math.abs(cents))") && html.includes("d.className='delta on'+(cents<0?' down':'')"), "every change prints +$x, or -$x in the down colour");
  assert.ok(html.includes("deltaT=setTimeout(function(){d.className='delta'},1900)") && html.includes("@keyframes delta{"), "then it is gone");
  assert.ok(html.includes("if(S.openParlay){pendingDelta+=cents;return}") && html.includes("el('sheet').className='sheet';if(pendingDelta){var d=pendingDelta;pendingDelta=0;pulse(d)}"), "behind the parlay sheet the pulse waits for Done");
  assert.equal((html.match(/S\.cash[+-]=/g) ?? []).length, 1, "no cash change bypasses the pulse");
  for (const call of ["addCash(tt.creditCents);", "addCash(net);", "addCash(41250-S.cash);", "addCash(L.creditCents);", "addCash(-S.lockedBy[ul].lock.creditCents);"]) assert.ok(html.includes(call), call);
  // the line: the extension's pill and sentence under every row; the panel opens under it, no sheet for positions
  assert.ok(html.includes("function lineGo(label,fact,cls,open){") && html.includes('class="ael-line \'+(cls||\'\')+(open?\' ael-open\':\'\')+\'" data-act="toggle"><span class="ael-tag">'), "one Lock in line per row, a button that opens the panel");
  assert.ok(html.includes("return lineGo('Lock in','Lose, and still get <b>'+usd(floor)+'</b>.','',st.open);"), "the line says the one thing that matters");
  assert.ok(html.includes("if(st.lock)return lineGo('Protected','<b>'+usd(st.lock.floorTotal)+'</b> or '+usd(st.lock.capTotal)"), "locked: Protected, the two endings");
  assert.ok(html.includes("return lineGo('Unavailable',esc(st.err||'The market can\\'t fund a worthwhile credit right now.'),'ael-line-off',st.open);"), "refused: Unavailable, the reason");
  assert.ok(html.includes("if(!st.q)return '<div class=\"ael-wait\">Pricing from the live book&hellip;</div>';"), "a loading line, not skeleton bars");
  assert.ok(!html.includes("Lock in this position") && !html.includes("confirmProtect") && !html.includes("data-protect="), "the positions sheet is gone");
  assert.ok(html.includes('id="sheet"') && html.includes('role="dialog"') && html.includes("Lock in your parlay"), "the sheet remains for the parlays, which have no row to open under");
  assert.ok(html.includes('<div class="pow">Powered by <img src="data:image/png;base64'), "the sheet's foot names us in the wordmark, host first");
  assert.ok(!html.includes("protection by") && !html.includes(".sheet .eyebrow"), "no eyebrow over the host's sheet");
  assert.ok(!html.includes("brightness(0)") && !html.includes("data:image/jpeg"), "never recoloured; the black tile is gone");
  // the slip: win, lose, cash now, with the "of/instead of" column until the lock
  assert.ok(html.includes("ledgerRow(win,usd(rs.capTotal),locked?null:'of '+usd(was))+ledgerRow(lose,usd(rs.floorTotal),locked?null:'instead of $0','ael-hero')+ledgerRow('Cash now','+'+usd(credit),locked?null:'','ael-last')"), "three rows: the win, the lose as the hero, the cash now");
  assert.ok(html.includes("win=r.kind==='crypto'?'Settles yes':name+' win',lose=r.kind==='crypto'?'Settles no':name+' lose'"), "named for the pick");
  assert.ok(html.includes("function reshape(n,F,C,K){return {kept:n*(C-F)/100, cashCents:Math.round(F*n)+K"), "the reshape identity stays in code");
  assert.ok(html.includes('<button type="button" class="ael-go" data-act="go"><span class="ael-ic">\'+SHIELD_FILL+\'</span>Lock in</button>'), "the pill says the verb; the figures are the slip");
  assert.ok(html.includes("var stages=['Pricing from the live book\\u2026','Writing the record\\u2026','Buying the other side\\u2026']"), "the lock reports its stages in words");
  // Details: four rows in one grammar, the How last; the offer itself is the slip, the pill and Details
  assert.ok(html.includes("var TIER_ORDER=['wide','balanced','tight'];") && html.includes("var TIER_WORDS={wide:'Max upside',balanced:'Balanced',tight:'Max floor'};"), "the extension's shapes, in its order and its words");
  assert.ok(html.includes("if(keys.length>1)rows.push(drow('Shape',shapeSegs(st,n,keys),'ael-dshape'));"), "Shape as a segmented control, only when more than one clears");
  assert.ok(html.includes('class="ael-shape-b" data-act="shape" data-tier="\'+k+\'" aria-pressed="\'+(k===st.tier)+\'"'), "pressed state on the chosen shape");
  assert.ok(html.includes("rows.push(drow('Other side','<span'+(o.tip?' title=\"'+esc(o.tip)+'\"':'')+'>'+o.html+'</span>'));"), "Other side: the venue, the race, every venue's figure in the tooltip");
  assert.ok(html.includes("else{parts.push('best of '+priced.length+' venues');if(v.edgeCents>0)parts.push(usd(Math.round(v.edgeCents*k))+' more for you')}") && html.includes("parts.push('of '+priced.length+' venues, chosen on all-in cost')"), "the winner and what it saved the trader; never 'best of' when the scan chose on all-in cost");
  assert.ok(html.includes("rows.push(drow('Until',esc(startWord(r))+' '+esc(fmtEt(r.eventTimeIso))+' <span class=\"ael-dim\">&middot; priced live</span>'));"), "Until");
  assert.ok(html.includes("var HOW='You sell part of the upside today for the floor and the cash now. The other side is bought the second you tap and settles on the same official result.';"), "the How names what is sold, in one breath");
  assert.ok(html.includes("rows.push(drow('Until',esc(startWord(r))+' '+esc(fmtEt(r.eventTimeIso))+' <span class=\"ael-dim\">&middot; priced live</span>'));\n    rows.push(drow('How',HOW));"), "and is the last Details row, after Until, in the same grammar");
  assert.ok(html.includes("return ledger(r,rs,t.creditCents,Math.round(100*n),false)+\n      '<div class=\"ael-acts\">'"), "nothing between the slip and Lock in; the offer stays the slip, the pill and Details");
  assert.ok(!html.includes("ael-how"), "the line under the slip is gone, class and rule");
  assert.ok(!html.includes("set aside") && !html.includes("contracts</b> kept"), "no set-aside or contracts-kept mechanics");
  // the protected row: Leave early and Details; the receipt in the same grammar
  assert.ok(html.includes('<button type="button" class="ael-go ael-quiet" data-act="leave">Leave early</button>\'+toggleA(\'rcpt\',\'Details\',st.rcpt)'), "Leave early beside Details");
  assert.ok(!html.includes("close early") && !html.includes("Close early"), "'Leave early' everywhere, never 'close early'");
  assert.ok(html.includes("Locked '+esc(L.at)+' &middot; the other side bought in '+L.secs+'s'"), "the facts line: when, and how fast the other side was bought");
  assert.ok(html.includes("rows.push('<span>Other side</span><b><b>'+esc(venue)+'</b> &middot; '+L.contracts+' contracts of the other side at '+price.toFixed(1)+'c'+cmp+' <span class=\"ael-dim\">&middot; priced at the book; demo, nothing bought</span></b>');"), "the receipt's Other side names the venue and says the demo bought nothing");
  for (const row of ["<span>Cost</span>", "<span>Until</span>", "<span>Paid to you</span>"]) assert.ok(html.includes(row), `receipt row ${row}`);
  // leave early: live figures, two ways out, Why behind a toggle; the pick stays
  assert.ok(html.includes("fetch('/api/close-quote?'+qs") && html.includes("st.leave.q={net:Math.round((c.leaveWithCents-c.withoutProtectionCents-base.creditCents)*k),at:Date.now()};"), "the exit is priced live and scaled to the row");
  assert.ok(html.includes('<div class="ael-leave-h">Leave early<span>remove the protection, keep your pick</span></div>'), "what leaving is");
  assert.ok(html.includes("<div class=\"ael-wait\">Pricing your exit&hellip;</div>"), "a loading line while the exit is priced");
  assert.ok(html.includes("var hero=net<0?'You pay <b class=\"ael-pay\">'+usd(-net)+'</b>':net>0?'You get <b>'+usd(net)+'</b>':'Nothing owed either way';"), "to leave now: pay, get, or nothing");
  assert.ok(html.includes('<button type="button" class="ael-go" data-act="leavego">Leave early</button><button type="button" class="ael-go ael-quiet" data-act="stay">Stay</button>'), "two ways out");
  assert.ok(html.includes("Your pick stays open on '+esc(BRAND)+', unprotected. The '+usd(credit)+' paid at the lock is yours either way."), "the pick stays; the credit is kept");
  assert.ok(html.includes("Earlier protection removed '+esc(m.at)"), "a row that left early says so when it is priced again");
  // the host's footer: the disclaimer, the links, the credit; reset lives there now
  assert.ok(html.includes('<div class="host-note"><span>Demo. Simulated positions at live prices; nothing is bought.</span><span class="links"><a href="https://atticus-event-shadow.onrender.com">Track record</a><a href="#" data-reset="1">reset demo</a></span><span class="pow">Powered by <img src="data:image/png;base64'), "the phone note: disclaimer, record and reset on one line, the credit under with the wordmark");
  assert.ok(html.includes(".host-note span,.host-note a,.host-note .pow,.host-note .links{display:block}") && html.includes(".host-note a{color:var(--dim);white-space:nowrap"), "deliberate lines; a link never strands mid-sentence");
  assert.ok(!html.includes('">reset · demo only</button>') || html.includes('data-unlock="'), "no reset button on a protected position row; the footer link resets the demo");
  assert.ok(html.includes("if(b.hasAttribute('data-reset')){e.preventDefault();resetDemo();return}"), "the footer link resets");
  assert.ok(html.includes("function powered(){return '<div class=\"ael-pow\"><span>Powered by</span><img src=\"'+WORDMARK+'\" alt=\"Atticus\"><span>&middot; routed via ParlayX</span></div>'}"), "the panel's foot: host first, our wordmark second, the partner named; whole words that wrap as a unit");
  assert.ok(html.includes(".ael-dl.ael-dshape,.ael-dv.ael-dshape{grid-column:1/-1}") && html.includes(".ael-shape{display:flex;width:100%;") && html.includes(".ael-shape-b{appearance:none;flex:1 1 0;min-width:0;"), "Shape takes its own full-width row and the three words share it, so none spills off a phone");
  assert.ok(html.includes(".host-note{padding:14px 16px calc(22px + env(safe-area-inset-bottom));") && html.includes(".list{padding:8px 12px 16px}"), "on a phone the note sits at the end of the list, never over a panel");
  assert.ok(html.includes("  .host-note{left:0;right:0;bottom:0;padding:28px 16px 14px;background:linear-gradient(to top,var(--bg) 78%,transparent);pointer-events:none}"), "inside the desktop frame it overlays the bottom on a gradient tall enough to cover the words under it");
  assert.ok(!html.includes('<a href="/board">Board</a>') && !html.includes('<a href="/receipts">Receipts</a></div>'), "board and receipts are off the phone");
  // the pitch: the venue's value, not the integrator's
  assert.ok(html.includes('<aside class="pitch">') && html.includes("<h1>One tap. Any prediction market.</h1>"), "desktop: the pitch beside the mock");
  assert.ok(html.includes("One line under every open position. Your traders lock a floor and get paid today, on your page. We price the other side at every venue, buy it where it is cheapest, and share the spread with you."), "the lede carries the deal");
  for (const li of ["<li><b>Every venue priced, every time.</b></li>", "<li><b>Your venue first when it is best,</b> never when it is not.</li>", "<li><b>The trader stays on your page.</b></li>", "<li><b>Plus a share of the spread:</b>"]) assert.ok(html.includes(li), li);
  assert.ok(html.includes('<div class="routed">Hedges mapped and routed through ParlayX where partnered.</div>'), "the partner named once, plainly");
  assert.ok(html.includes("Tap <b>Lock in</b> on any row, or switch to <b>Venue view</b> &rarr;"), "the try line uses the same verb and points at the toggle");
  assert.ok(!html.includes("carry the risk") && !html.includes("One JSON quote in"), "no risk claim; no integrator talk");
  assert.ok(html.includes("Demo positions are simulated at live prices. The record also carries locks on real positions, hedged with real orders on Kalshi, Novig and ProphetX."), "labelled a demonstration, the record's real venues named");
  assert.ok(html.includes('<b>For partners</b><a href="https://atticus-event-shadow.onrender.com">Track record</a><a href="/partner?brand=ProphetX">Partner console</a><a href="/receipts">Receipts</a><a href="/board">Full board</a>'), "every partner surface in one row, the console opened as this brand");
  const plain = renderEventEmbedHtml({ brand: DEFAULT_EMBED_BRAND });
  assert.ok(plain.includes('<a href="/partner">Partner console</a>') && plain.includes("var VV_URL='/api/venue-view'+\"\";"), "the default brand opens the console and the venue view unbranded");
  assert.ok(html.includes("var VV_URL='/api/venue-view'+\"?brand=ProphetX\";"), "a branded shell asks the venue view as itself");
  const custom = renderEventEmbedHtml({ brand: "ProphetX", trackRecordUrl: "https://tr.example", minCredit: { cents: 50, bpsOfStake: 10 } });
  assert.ok(custom.includes('href="https://tr.example">Track record</a>'), "the track record URL comes from the server");
  assert.ok(custom.includes("var MIN_CREDIT_CENTS=50,MIN_CREDIT_BPS=10;"), "the page mirrors the server's minimum-credit rule");
  assert.ok(html.includes("@media(min-width:900px)") && html.includes(".host-note,.scrim,.sheet,.toast{position:absolute}"), "on desktop the sheet stays inside the phone frame");
  assert.ok(html.includes("far=dt.getTime()-Date.now()>86400000") && html.includes("month:'short',day:'numeric'"), "past 24h out the row shows the date");
  // Venue view: the host's side of the same rows, from the retail-safe endpoint; never a token
  assert.ok(html.includes('<div class="seg viewseg" role="group" aria-label="View"><button type="button" data-view="trader" aria-pressed="true">Trader view</button><button type="button" data-view="venue" aria-pressed="false">Venue view</button></div>'), "Trader view / Venue view");
  assert.ok(html.includes("fetch(VV_URL,{cache:'no-store'})") && !html.includes("token"), "read from /api/venue-view, no token anywhere in the page");
  assert.ok(html.includes('<div class="vnote"><b>What the trader does not see.</b> Every venue asked for the other side, which one got it and why, what the hedge cost, and your share of the spread. Your venue first when it is best, never when it is not.</div>'), "the view says what it is");
  for (const row of ["<span>Quotes</span>", "<span>Other side</span>", "<span>Hedge cost</span>", "<span>Spread</span>"]) assert.ok(html.includes(row), `venue row ${row}`);
  assert.ok(html.includes("your book: it paid the trader the most") && html.includes("more than your book did for the same protection, so the other side went there. You take a share of the spread instead.") && html.includes("so the other side went to the best venue that did."), "the winner and why, in the host's words, for each case");
  assert.ok(html.includes("<b>your share '+usd(share)+'</b> <span class=\"ael-dim\">('+S.vv.sharePct+'%)</span>"), "the host's share of the spread, with the rule");
  assert.ok(html.includes('.vq i.host:after{content:"yours"'), "the host's own quote is marked");
  assert.ok(html.includes("if(view==='venue'){track('venue_view');if(!S.vv&&!S.vvBusy)loadVenueView()}") && html.includes("if(/[?&]view=venue\\b/i.test(location.search))setView('venue');"), "the funnel knows; ?view=venue deep-links");
  assert.ok(html.includes("track('protect_on',t,st.tier)") && html.includes("track('row_tap',t)") && html.includes("track('tier_pick',t,st.tier)") && html.includes("track('close_early',t,L.tier)"), "taps flow into the same funnel");
  // The trader's copy is outcomes, never mechanics. The pitch and the Venue view speak to the venue and may say "hedge"; the
  // trader's panel may name the venue that took the other side, since the receipt names it on the real extension too.
  const trader = html
    .replace(/<aside class="pitch">[\s\S]*?<\/aside>/, "")
    .replace(/<div class="vnote">[\s\S]*?<\/div>/, "")
    .replace(/\/\* ---- VENUE VIEW:[\s\S]*?function paintVenue\(\)\{[\s\S]*?\n  \}\n/, "")
    .replace(/'\/api\/venue-view'|Venue view|routed via ParlayX|chosen on all-in cost/g, "");
  assert.ok(trader.length < html.length - 2000, "the pitch and the venue view are present and excluded from the retail leak check");
  for (const leak of ["Kalshi", "Polymarket", "hedge", "route", "take", "instId", "OKX", "tight", "wide"]) {
    assert.ok(!new RegExp(`\\b${leak}\\b`).test(trader.replace(/'tight'|'wide'|tight:|wide:|offered\.tight|offered\.wide/g, "")), `"${leak}" is not in the trader's copy`);
  }
  assert.ok(!html.includes("—"), "no em dash in any copy");
  // "Protect" is the name of the line (Earn & Protect), never the bettor's verb. The line says "Lock in"; a locked row says
  // "Protected" as its state, and "protection" is the thing one leaves, as on the extension.
  const traderCopy = trader.replace(/Earn &amp; Protect|Earn & Protect|protectedBy|\.protected|' protected'|protect_\w+|protects\.\w+|pos protected|protectedHtml|lineGo\('Protected'/g, "");
  assert.ok(!/\bProtect\b/.test(traderCopy), "no Protect as the verb in the trader's copy");
  assert.ok(!/without protection|positions to protect|Protection is only/.test(traderCopy), "the lock, not protection, in the trader's sentences");
  const dark = renderEventEmbedHtml({ brand: "Your Exchange", skin: "dark" });
  assert.ok(dark.includes("--bg:#0f1115"), "dark skin flips the host shell");
  assert.ok(dark.includes(".sheet{position:fixed") && dark.includes("background:var(--card);color:var(--ink)"), "the sheet is the host's card now, in a dark host too");
  assert.ok(renderEventEmbedHtml({ brand: "A&B \"x\"", skin: "light" }).includes("A&amp;B &quot;x&quot;"), "the brand is escaped");
});

test("embed: the live recording sits in the pitch column, plays only on tap, names ProphetX and Novig and carries the extension disclaimer, and can be pointed elsewhere or left out", () => {
  const html = renderEventEmbedHtml({ brand: DEFAULT_EMBED_BRAND });
  assert.ok(html.includes('<div class="live"><div class="live-h">Seen live</div>'), "the block is labelled");
  assert.ok(html.includes('<video controls preload="none" playsinline poster="/media/lockin-live.jpg" src="/media/lockin-live.mp4"></video>'), "default: the bundled file, no autoplay, nothing fetched until play");
  assert.ok(html.includes("A real position on ProphetX, locked in one tap. The other side was bought on Novig, the best price of the venues that quoted it; the receipt names both."), "the one sentence names both venues and the comparison");
  assert.ok(html.includes("Shown through a browser extension on the venues' pages. Not affiliated with or endorsed by any venue."), "the disclaimer travels with the clip");
  assert.ok(html.includes('<meta property="og:video" content="/media/lockin-live.mp4" />') && html.includes('<meta property="og:image" content="/media/lockin-live.jpg" />'), "a shared link previews the clip");
  const aside = /<aside class="pitch">([\s\S]*?)<\/aside>/.exec(html)?.[1] || "";
  const order = [aside.indexOf("Tap <b>Lock in</b>"), aside.indexOf('class="live"'), aside.indexOf("<b>For partners</b>")];
  assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2], "under the try line, above the partner links");
  assert.ok(html.includes(".pitch .live video{display:block;width:100%;aspect-ratio:16/9"), "sized to the new clip's 16:9 frame so the column does not jump when it loads");
  const cdn = renderEventEmbedHtml({ brand: DEFAULT_EMBED_BRAND, liveVideo: { src: "https://cdn.example/a.mp4", poster: "https://cdn.example/a.jpg" } });
  assert.ok(cdn.includes('poster="https://cdn.example/a.jpg" src="https://cdn.example/a.mp4"') && cdn.includes('<meta property="og:video" content="https://cdn.example/a.mp4" />'), "a CDN URL replaces both the player and the preview");
  const escaped = renderEventEmbedHtml({ brand: DEFAULT_EMBED_BRAND, liveVideo: { src: 'x"><script>', poster: "p" } });
  assert.ok(escaped.includes('src="x&quot;&gt;&lt;script&gt;"') && !escaped.includes('src="x"><script>'), "URLs are escaped");
  const none = renderEventEmbedHtml({ brand: DEFAULT_EMBED_BRAND, liveVideo: null });
  assert.ok(!none.includes('class="live"') && !none.includes("og:video") && !none.includes("<video"), "null leaves the block and the preview tags out");
  assert.ok(none.includes("<b>For partners</b>"), "the rest of the pitch is unchanged");
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
  assert.ok(html.includes("<span>Lock in taps (all pages)</span>"), "the console counts taps by the bettor's verb");
  assert.ok(html.includes("we price and hedge <i>your venue executes and settles</i>"), "who does what, stated");
  assert.ok(!html.includes("quote-only"), "not a pricer");
  assert.ok(html.includes("data:image/png;base64") && html.includes(".topbar img{height:18px;display:block}"), "the gold wordmark on the console bar");
  assert.ok(html.includes("2026-09-18 to 2026-09-20 UTC"));
  assert.ok(!html.includes("—"), "no em dash");
});

test("embed: / is the embed shell (also /embed), /board is the board; brand-gated; /partner needs the operator token; /api/parlays reads the record through", async () => {
  // a stand-in for the shadow service: the demo's /api/parlays is a read-through of its public /api/shadow/parlays
  let shadowMode: "ok" | "down" = "down";
  let shadowHits = 0;
  const shadow = createServer((req, res) => {
    shadowHits += 1;
    if (shadowMode === "down" || (req.url !== "/api/shadow/parlays" && req.url !== "/api/shadow")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/api/shadow") {
      // the shadow's full positions, hedge words and all: the demo must cut them to retail before serving
      const settled = {
        at: "2026-10-04T22:11:37.343Z", ticker: "KXNFLGAME-26OCT11PHIJAC-PHI", kind: "sports", league: "nfl", sideName: "Eagles", eventTitle: "Eagles vs. Jaguars", eventTimeIso: "2026-10-11T13:30:00.000Z",
        contracts: 150, markCents: 39, floorCents: 24, capCents: 51, creditCents: 603, evCostBps: 115, route: "polymarket", feesCents: 0, takeCents: 67, hedgeCostCents: 6680, hedgeUnitsMilli: 109500, hedgeTokenId: "0xabc",
        status: "settled", result: "no", settledAt: "2026-10-11T17:05:00.000Z", protectedCents: 4203, nakedCents: 0, deltaCents: 4203, writerCents: 67, hedgePayoutCents: 10950,
        counterfactuals: { alternatives: { tight: { takeCents: 38 } } },
      };
      res.end(JSON.stringify({ ok: true, at: "2026-10-11T18:00:00.000Z", summary: {}, settled: [settled], open: [{ ...settled, status: "open" }], closed: [] }));
      return;
    }
    res.end(JSON.stringify({ ok: true, at: "2026-10-10T12:00:00.000Z", enabled: true, stakeCents: 2000, pricedEveryMinutes: 10, summary: { tickets: 1 }, tickets: [{ id: "ll_x", state: "open", picksOpen: 2, picks: [] }] }));
  });
  await new Promise<void>((r) => shadow.listen(0, "127.0.0.1", () => r()));
  const shadowBase = `http://127.0.0.1:${(shadow.address() as AddressInfo).port}`;
  process.env.EVENT_X_SHADOW_URL = shadowBase;
  const { server, primeScanForTests } = await import("../scripts/eventProtectXDemoService");
  primeScanForTests({ atIso: "2026-09-20T18:00:00.000Z", rows: [], fallback: null, fetchFailures: 0 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // the shadow is down and nothing is cached: an honest 503 with a retail sentence, not a stack trace
    const cold = await fetch(`${base}/api/parlays`);
    assert.equal(cold.status, 503);
    assert.deepEqual(await cold.json(), { ok: false, error: "Parlays are unavailable right now." });
    shadowMode = "ok";
    const warm = await fetch(`${base}/api/parlays`);
    assert.equal(warm.status, 200);
    const warmBody = (await warm.json()) as { ok: boolean; tickets: Array<{ id: string }>; pricedEveryMinutes: number };
    assert.equal(warmBody.ok, true);
    assert.equal(warmBody.tickets[0].id, "ll_x", "the shadow's body, passed through untouched");
    assert.equal(warmBody.pricedEveryMinutes, 10);
    const hitsAfterWarm = shadowHits;
    shadowMode = "down";
    const cached = await fetch(`${base}/api/parlays`);
    assert.equal(cached.status, 200, "a fresh copy is served from cache; the shadow is not asked again within the minute");
    assert.equal(shadowHits, hitsAfterWarm);

    // /api/activity: the same read-through, cut to retail before it is served
    const actCold = await fetch(`${base}/api/activity`);
    assert.equal(actCold.status, 503);
    assert.deepEqual(await actCold.json(), { ok: false, error: "Activity is unavailable right now." });
    shadowMode = "ok";
    const act = await fetch(`${base}/api/activity`);
    assert.equal(act.status, 200);
    const actBody = (await act.json()) as { ok: boolean; at: string; rows: Array<Record<string, unknown>>; settledCount: number; closedCount: number };
    assert.equal(actBody.ok, true);
    assert.equal(actBody.at, "2026-10-11T18:00:00.000Z");
    assert.deepEqual([actBody.settledCount, actBody.closedCount], [1, 0], "the open position is not activity");
    assert.deepEqual(actBody.rows, [
      {
        id: "KXNFLGAME-26OCT11PHIJAC-PHI", kind: "sports", league: "nfl", name: "Eagles", game: "Eagles vs. Jaguars", startsIso: "2026-10-11T13:30:00.000Z",
        state: "settled", outcome: "lost", atIso: "2026-10-11T17:05:00.000Z", contracts: 150, endedCents: 4203, withoutCents: 0, creditCents: 603, floorTotalCents: 4203, capTotalCents: 8253,
      },
    ]);
    assert.deepEqual(forbiddenKeysIn(actBody), [], "no hedge, take, route or counterfactual words reach the phone");
    const actHits = shadowHits;
    shadowMode = "down";
    assert.equal((await fetch(`${base}/api/activity`)).status, 200, "served from cache within the minute");
    assert.equal(shadowHits, actHits);

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
    assert.ok(!root.includes('class="cardland"') && !root.includes('class="stage from-card"'), "a plain visit has no card landing in the page");

    // the business card's QR: the landing rides on the same page, and Save contact is a vCard
    const card = await (await fetch(`${base}/?from=card`)).text();
    assert.ok(card.includes('<div class="stage from-card">') && card.includes('<section class="cardland">'), "?from=card adds the landing");
    assert.ok(card.includes('id="sheet"') && card.includes('class="pitch"'), "the demo and the desktop pitch are still in the page");
    assert.ok(card.includes('<a class="cl-btn cl-primary" href="/contact.vcf" download>Save contact</a>'), "Save contact");
    assert.ok(card.includes('<a class="cl-btn" href="/">Try the demo: tap Lock in on a position</a>'), "the demo link drops from=card");
    assert.ok(card.includes('href="https://wa.me/17186643497"') && card.includes('href="tel:+17186643497">+1 718 664 3497</a>'), "WhatsApp and tel from the one number");
    assert.ok(card.includes('href="https://www.linkedin.com/in/michael-william-5888ba263/"'), "LinkedIn is behind the QR, not on the paper");
    assert.ok(card.includes("Priced across venues, hedged leg for leg on the cheaper book; refused when no book can fund it. Every quote, hedge, refusal and result on a public record."), "the sentence matches the printed card");
    assert.ok(card.includes("Shown through a browser extension on the venues' pages. Not affiliated with or endorsed by any venue."), "the extension disclaimer travels with the clip");
    const landing = /<section class="cardland">[\s\S]*?<\/section>/.exec(card)?.[0] || "";
    assert.ok(landing.length > 500 && !/ProphetX|Novig|Kalshi/.test(landing), "no venue named on the card landing itself; the pitch beside it may name the clip's venues");
    const vcf = await fetch(`${base}/contact.vcf`);
    assert.equal(vcf.status, 200);
    assert.match(vcf.headers.get("content-type") ?? "", /text\/vcard/);
    assert.equal(vcf.headers.get("content-disposition"), 'attachment; filename="michael-william-atticus.vcf"');
    const vcfText = await vcf.text();
    assert.ok(vcfText.startsWith("BEGIN:VCARD\r\nVERSION:3.0\r\n") && vcfText.endsWith("END:VCARD\r\n"), "a vCard with CRLF lines");
    assert.ok(vcfText.includes("FN:Michael William\r\n") && vcfText.includes("TEL;TYPE=CELL,VOICE:+17186643497\r\n") && vcfText.includes("EMAIL;TYPE=INTERNET,WORK:michael@atticustrade.com\r\n"));
    assert.ok(vcfText.includes("URL;TYPE=LinkedIn:https://www.linkedin.com/in/michael-william-5888ba263/\r\n"), "LinkedIn rides in the contact");
    assert.equal((await fetch(`${base}/contact.vcf`, { method: "POST" })).status, 405);

    // /partner without the token is the public case for the console with one CTA, never a JSON error
    const publicPartner = await fetch(`${base}/partner`);
    assert.equal(publicPartner.status, 200);
    assert.match(publicPartner.headers.get("content-type") ?? "", /text\/html/);
    const ctaHtml = await publicPartner.text();
    assert.ok(ctaHtml.includes("The console your team gets.") && ctaHtml.includes('href="mailto:michael@atticustrade.com?subject='), "the pitch and a Talk to us CTA");
    assert.ok(ctaHtml.includes(`href="${shadowBase}">track record</a>`), "and the track record (EVENT_X_SHADOW_URL) as the soft path");
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

    // /api/venue-view: the host's side, no token, brand-gated like the shell
    const vv = await fetch(`${base}/api/venue-view?brand=prophetx`);
    assert.equal(vv.status, 200);
    assert.deepEqual(await vv.json(), { ok: true, at: "2026-09-20T18:00:00.000Z", retail: true, sharePct: 40, hostVenue: "ProphetX", rows: [] }, "an allowlisted venue brand is the host venue; the share is EVENT_X_PARTNER_SHARE_PCT");
    const vvOff = (await (await fetch(`${base}/api/venue-view?brand=Kalshi`)).json()) as { hostVenue: string | null };
    assert.equal(vvOff.hostVenue, null, "a brand off the allowlist falls back to the default host, which is no venue");
    assert.ok(root.includes("var VV_URL='/api/venue-view'+\"\";") && root.includes('data-view="venue"'), "the shell asks for it and offers the toggle");

    const funnel = (await (await fetch(`${base}/api/admin/funnel?token=t0ken`)).json()) as { funnel: { pageLoads7d: Array<{ byPage: Record<string, number> }> } };
    const embedLoads = funnel.funnel.pageLoads7d.reduce((n, d) => n + (d.byPage.embed ?? 0), 0);
    const boardLoads = funnel.funnel.pageLoads7d.reduce((n, d) => n + (d.byPage.app ?? 0), 0);
    assert.equal(embedLoads, 4, "/embed twice, / once and the card's /?from=card once count as embed loads");
    assert.equal(boardLoads, 1, "/board counts as a board load");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => shadow.close(() => r()));
  }
});
