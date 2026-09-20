import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { renderEventEmbedHtml, renderPartnerHtml, resolveBrand } from "../scripts/eventProtectEmbedHtml";
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

test("embed: the brand is honoured only from the allowlist, case-insensitively, else 'Your app'", () => {
  assert.equal(resolveBrand("ProphetX", "ProphetX, Novig"), "ProphetX");
  assert.equal(resolveBrand("prophetx", "ProphetX, Novig"), "ProphetX", "canonical casing from the allowlist");
  assert.equal(resolveBrand("Kalshi", "ProphetX, Novig"), "Your app", "a name not on the list never renders");
  assert.equal(resolveBrand("<script>", "ProphetX"), "Your app");
  assert.equal(resolveBrand("ProphetX", undefined), "Your app", "no allowlist: fail closed");
  assert.equal(resolveBrand(null, "ProphetX"), "Your app");
  assert.equal(resolveBrand("  ", "ProphetX"), "Your app");
});

test("embed: the host shell is theirs, the button and the sheet are ours; positions reshape to fewer contracts plus cash", () => {
  const html = renderEventEmbedHtml({ brand: "ProphetX", skin: "light" });
  assert.ok(html.includes("<title>ProphetX · Positions</title>"), "the host's name on the tab");
  assert.ok(html.includes('<div class="brand"><i></i>ProphetX</div>'), "and on the shell");
  assert.ok(html.includes('class="tabs"') && html.includes(">Positions</span>"), "a host positions list, not our board");
  assert.ok(html.includes('data-protect="'), "one Protect button per row");
  assert.ok(html.includes('id="sheet"') && html.includes('role="dialog"'), "the sheet is a dialog over the host");
  assert.ok(html.includes("protection by") && html.includes("data:image/jpeg;base64"), "the sheet carries our mark, inlined");
  assert.ok(html.includes("Protect this position"), "same grammar as the board");
  assert.ok(html.includes("keep at least") && html.includes("cash now") && html.includes("up to"), "three tiles, three outcomes");
  assert.ok(html.includes("function reshape(n,F,C,K){return {kept:n*(C-F)/100, cashCents:F*n+K"), "the reshape identity: n(C-F)/100 contracts kept, F·n+K in cash");
  assert.ok(html.includes("contracts</b> kept · <b>"), "the row shows kept contracts and cash after protection");
  assert.ok(html.includes("&#x2713; Protected"), "protected badge");
  assert.ok(html.includes("undo (demo)"), "undo is labelled as a demo affordance");
  assert.ok(html.includes("/api/showcase?ticker="), "the sheet prices from the retail showcase endpoint");
  assert.ok(html.includes("<b>Not right now.</b> '+esc(detail)"), "refusals render the server's retail sentence");
  assert.ok(html.includes("track('protect_on',ticker,S.tier)") && html.includes("track('row_tap',ticker)"), "taps flow into the same funnel");
  assert.ok(html.includes("The credit you see is the credit you get."), "the fee is explained as netted, once");
  assert.ok(html.includes("Nothing to manage. It settles with your position."), "passive after the tap");
  assert.ok(html.includes("Simulated positions at live prices; nothing is bought."), "honesty line on the shell");
  for (const leak of ["Kalshi", "Polymarket", "hedge", "route", "take", "instId", "OKX"]) {
    assert.ok(!new RegExp(`\\b${leak}\\b`).test(html.replace(/protection by/g, "")), `"${leak}" is not on the embedded page`);
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
  assert.ok(html.includes("quote-only <i>we hedge, you settle</i>"), "integration mode stated");
  assert.ok(html.includes("2026-09-18 to 2026-09-20 UTC"));
  assert.ok(!html.includes("—"), "no em dash");
});

test("embed: /embed is public and brand-gated; /partner needs the operator token; board rows carry the position behind them", async () => {
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
    assert.ok(other.includes("<title>Your app · Positions</title>"), "a name off the list falls back");

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
    assert.equal(embedLoads, 2, "both /embed loads counted under their own page");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
