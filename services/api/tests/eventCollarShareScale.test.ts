/**
 * ONE SCALE FOR EVERY SHAPE, and the public scoreboard as the worker serves it.
 *
 * The share: every tier of every quote carries `sharePercent`, worked out in one place
 * (shareScale.ts), and every surface prints it with one of two sentences. The sentences are
 * run here from the source each surface ships (the extension's content.js, the pages' inline
 * script), not read for a matching string, and held to the service's own wording.
 *
 * The scoreboard: lettered for the public, named for the operator, on the page, the JSON and
 * the CSV, with the operator's view never left in a shared cache.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SALE_SHARE_PERCENT } from "../src/eventCollar/crossVenue/memberSale";
import { collarSharePercent, saleSharePercent, SHARE_WORDS } from "../src/eventCollar/shareScale";
import { appendShadowRecord } from "../src/eventCollar/crossVenue/shadowLedger";
import type { GameMarketRow, OneQuoteResult } from "../scripts/eventProtectXDemoService";

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(API_DIR, "..", "..", "demo", "event-lockin-extension");
const TOKEN = "op-secret-0123456789";

const dir = mkdtempSync(join(tmpdir(), "share-scale-"));
process.env.NODE_ENV = "test";
process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = join(dir, "lock-ledger.jsonl");
process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
process.env.EVENT_X_ADMIN_TOKEN = TOKEN;
for (const k of Object.keys(process.env)) if (/^EVENT_HEDGE_|^EVENT_SHADOW_ALERT_|^EVENT_X_NAME_HEDGE_VENUES$|^EVENT_X_DEV_NO_ADMIN$/.test(k)) delete process.env[k];

let worker: typeof import("../scripts/eventShadowWorker");
let base = "";

before(async () => {
  worker = await import("../scripts/eventShadowWorker");
  worker.wireLockEngine({
    listGameMarkets: async (): Promise<GameMarketRow[]> => [],
    quoteOne: async (): Promise<OneQuoteResult> => ({ ok: false, status: 404, body: { ok: false } }) as unknown as OneQuoteResult,
  });
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => worker.server.close(() => r()));
});

test("the share of a hedged lock is floor + 100 - cap, a whole percent between 0 and 100", () => {
  // by hand: a floor of 15c and a cap of 100c is hedged with 15 contracts of the other side per 100 held
  assert.equal(collarSharePercent(15, 100), 15);
  assert.equal(collarSharePercent(40, 88), 52);
  assert.equal(collarSharePercent(30, 95), 35);
  assert.equal(collarSharePercent(50, 80), 70);
  // the ends: no floor and no cap sells nothing; a floor at the cap sells it all
  assert.equal(collarSharePercent(0, 100), 0);
  assert.equal(collarSharePercent(60, 60), 100);
  // rounded to the nearest whole percent, never out of range, never a number from nothing
  assert.equal(collarSharePercent(15.4, 100), 15);
  assert.equal(collarSharePercent(15.5, 100), 16);
  assert.equal(collarSharePercent(90, 20), 100);
  assert.equal(collarSharePercent(-5, 100), 0);
  assert.equal(collarSharePercent(Number.NaN, 100), null);
  assert.equal(collarSharePercent(15, Number.POSITIVE_INFINITY), null);
});

test("the share of a member's own sale is what sold of what was held; the three shapes come to the 40, 60 and 80 the sale is built on", () => {
  for (const held of [5, 10, 50, 100, 1000]) {
    assert.deepEqual(
      (["wide", "balanced", "tight"] as const).map((k) => saleSharePercent(Math.floor((held * SALE_SHARE_PERCENT[k]) / 100), held)),
      [40, 60, 80],
      `held ${held}`,
    );
  }
  // where the bids ran out, it is what sold: 3 of 5, not the 4 the shape asked for
  assert.equal(saleSharePercent(3, 5), 60);
  // a position too small to split evenly says what it comes to: 1 of 3 is 33, 2 of 3 is 67
  assert.deepEqual([saleSharePercent(1, 3), saleSharePercent(2, 3)], [33, 67]);
  assert.deepEqual([saleSharePercent(0, 50), saleSharePercent(50, 50)], [0, 100]);
  assert.deepEqual([saleSharePercent(1, 0), saleSharePercent(-1, 5), saleSharePercent(Number.NaN, 5)], [null, null, null]);
});

/** Pull one function out of shipped script source and run it: the page's own code, not a copy of it. */
function shipped<T>(source: string, start: string, name: string): T {
  const i = source.indexOf(start);
  assert.ok(i >= 0, `the source has ${JSON.stringify(start)}`);
  const end = source.indexOf("\n", i);
  const line = source.slice(i, end < 0 ? undefined : end);
  return new Function(`${line}\nreturn ${name};`)() as T;
}

test("every surface says the share with the service's two sentences, and takes the number from the quote", async () => {
  const content = readFileSync(join(EXT_DIR, "content.js"), "utf8");
  const extWords = shipped<(t: unknown, sale: boolean) => string>(content, "  const shareWords = (t, sale) =>", "shareWords");
  const { renderEventEmbedHtml } = await import("../scripts/eventProtectEmbedHtml");
  const embed = renderEventEmbedHtml({ brand: "DraftKings", nameVenues: false });
  const embedWords = shipped<(t: unknown) => string>(embed, "  function shareWords(t){", "shareWords");

  for (const percent of [0, 15, 40, 60, 80, 100]) {
    assert.equal(extWords({ sharePercent: percent }, true), SHARE_WORDS.sale(percent));
    assert.equal(extWords({ sharePercent: percent }, false), SHARE_WORDS.lock(percent));
    assert.equal(embedWords({ sharePercent: percent }), SHARE_WORDS.lock(percent));
  }
  assert.equal(SHARE_WORDS.sale(40), "sells 40% of your position");
  assert.equal(SHARE_WORDS.lock(15), "like selling 15% of your position");
  // a quote from a service that sends no share says nothing, rather than a number made up on the page
  assert.deepEqual([extWords({}, true), extWords(null, false), extWords({ sharePercent: "40" }, true), embedWords({}), embedWords(null)], ["", "", "", "", ""]);

  // the extension: on each shape's button (seen and read aloud) and as its own row in the details
  assert.ok(content.includes('(shareWords(tt, isSale(p)) ? " <i>&middot; " + esc(shareWords(tt, isSale(p))) + "</i>" : "")'), "on the shape buttons");
  assert.ok(content.includes('if (share) rows.push(drow("Share", esc(share)));'), "a Share row in the details");
  assert.ok(content.includes('(shareWords(tt, tt && tt.cashNowCents != null) ? ", " + shareWords(tt, tt && tt.cashNowCents != null) : "")'), "in the button's spoken label");
  // the demo's embed: the same row, and the share survives the scaling to the row's size
  assert.ok(embed.includes("if(shareWords(st.offered[st.tier]))rows.push(drow('Share',esc(shareWords(st.offered[st.tier]))));"));
  assert.ok(embed.includes("sharePercent:t.sharePercent}}"));

  // the member page and the demo board carry the sentence around the quote's own number
  const member = await import("../scripts/memberAppHtml");
  const memberHtml = member.memberAppHtml({ venueName: "STX", configured: true, recordUrl: "https://shadow.example" });
  assert.ok(memberHtml.includes(`'<span class="ael-share">sells ' + sel.sharePercent + "% of your position</span>"`));
  const { renderEventXAppHtml } = await import("../scripts/eventProtectXAppHtml");
  const board = renderEventXAppHtml();
  assert.ok(board.includes(`(typeof t.sharePercent==='number'?'<div class="tc">like selling '+t.sharePercent+'%</div>':'')`));

  // no surface works the share out for itself: each only reads the quote's number, and the embed passes it through its scaling
  for (const [what, text] of [["extension", content], ["embed", embed], ["member page", memberHtml], ["board", board]] as const) {
    const written = text.replace(/sharePercent:t\.sharePercent/g, "").match(/(?<!\.)\bsharePercent\b/g) ?? [];
    assert.deepEqual(written, [], `${what} sets a share of its own`);
    assert.ok(/\.sharePercent\b/.test(text), `${what} reads the quote's share`);
  }
});

test("the extension says a removed lock's cash in words that agree with the cash legs: paid only once paid", () => {
  const content = readFileSync(join(EXT_DIR, "content.js"), "utf8");
  const i = content.indexOf("  const closeWords = (rec, bold, capital) => {");
  const j = content.indexOf("\n  };", i);
  assert.ok(i >= 0 && j > i);
  const body = content.slice(i, j + 5);
  type Rec = { net: number; cash: null | { open: boolean } };
  const closeWords = new Function(
    "esc", "usd", "closeNetOf", "cashState",
    `${body}\nreturn closeWords;`,
  )(
    (s: string) => s,
    (c: number) => `$${(c / 100).toFixed(2)}`,
    (r: Rec) => r.net,
    (r: Rec) => r.cash,
  ) as (rec: Rec, bold: boolean, capital: boolean) => string;

  // still outstanding: who owes it, never "paid"
  assert.equal(closeWords({ net: -250, cash: { open: true } }, false, false), "you owe $2.50");
  assert.equal(closeWords({ net: -250, cash: { open: true } }, true, true), "You owe <b>$2.50</b>");
  assert.equal(closeWords({ net: 250, cash: { open: true } }, false, false), "$2.50 owed to you &middot; on its way");
  // paid: said as paid
  assert.equal(closeWords({ net: -250, cash: { open: false } }, false, false), "you paid $2.50");
  assert.equal(closeWords({ net: 250, cash: { open: false } }, true, true), "<b>$2.50</b> paid to you");
  // a record with no cash legs says the direction and no more
  assert.equal(closeWords({ net: -250, cash: null }, false, false), "$2.50 from you");
  assert.equal(closeWords({ net: 250, cash: null }, false, false), "$2.50 to you");
  assert.equal(closeWords({ net: 0, cash: { open: true } }, false, true), "Nothing owed either way");
  for (const cash of [{ open: true }, null]) for (const net of [-1, 1]) assert.equal(/paid/.test(closeWords({ net, cash }, true, true)), false, "never paid before it is");

  // the two lines that say it both go through this one function
  assert.equal((content.match(/closeWords\(/g) ?? []).length, 2);
  assert.equal(/"You paid <b>"|" paid to you" :/.test(content.replace(body, "")), false, "no second wording left beside it");
});

test("the scoreboard as served: lettered and cacheable for the public, named and private for the operator, on the page, the JSON and the CSV", async () => {
  const at = new Date().toISOString();
  const routes = [
    { route: "kalshi_self", hedgeVenue: "kalshi", ok: true, evCostBps: 150, tailChargeBps: 0, allInBps: 150, creditCents: 100, terms: { floorCents: 40, capCents: 85 }, compatible: true, sameContract: true },
    { route: "novig", hedgeVenue: "novig", ok: true, evCostBps: 220, tailChargeBps: 0, allInBps: 220, creditCents: 80, terms: { floorCents: 40, capCents: 85 }, compatible: true, sameContract: false },
  ];
  for (const [ticker, route] of [["KXNBAGAME-26NOV11LALBOS-BOS", "kalshi_self"], ["KXNBAGAME-26NOV11NYKMIA-NYK", "polymarket"], ["KXNBAGAME-26NOV11DENPHX-DEN", "prophetx"]] as const) {
    appendShadowRecord(process.env.EVENT_SHADOW_LEDGER_PATH as string, {
      type: "open", ticker, at, kind: "sports", league: "nba", sideName: "Side", eventTitle: "A at B", eventTimeIso: new Date(Date.now() + 3 * 3_600_000).toISOString(),
      contracts: 50, markCents: 60, entryCents: 58, floorCents: 40, capCents: 85, creditCents: 100, evCostBps: 150, feesCents: 5, takeCents: 20, status: "open", route,
      ...(route === "kalshi_self" ? { routing: { routes } } : {}),
    } as unknown as Parameters<typeof appendShadowRecord>[1]);
  }
  const NAMES = /kalshi|polymarket|prophetx|novig|parlayx/i;
  const paths = ["/scoreboard", "/api/shadow/scoreboard", "/api/shadow/scoreboard.csv"];

  for (const path of paths) {
    const pub = await fetch(`${base}${path}`);
    const text = await pub.text();
    assert.equal(pub.status, 200, path);
    assert.equal(NAMES.test(text), false, `${path} names ${NAMES.exec(text)?.[0]}`);
    assert.ok(/Venue A/.test(text) && /Venue B/.test(text) && /Venue C/.test(text), `${path} letters the venues that took the other side`);
    assert.equal(pub.headers.get("cache-control"), "public, max-age=300");
    // a wrong token is the public, not the operator
    const wrong = await (await fetch(`${base}${path}?token=nope`)).text();
    assert.equal(NAMES.test(wrong), false, path);

    for (const init of [{ url: `${base}${path}?token=${TOKEN}` }, { url: `${base}${path}`, headers: { "x-admin-token": TOKEN } }]) {
      const op = await fetch(init.url, { headers: init.headers });
      const named = await op.text();
      assert.ok(/Kalshi/.test(named) && /Polymarket/.test(named) && /ProphetX/.test(named), `${path} names them for the operator`);
      assert.equal(/Venue [A-D]\b/.test(named), false, path);
      assert.equal(op.headers.get("cache-control"), "private, no-store", "the named view is never left in a shared cache");
      assert.equal(op.headers.get("access-control-allow-origin"), null);
    }
  }
  const json = (await (await fetch(`${base}/api/shadow/scoreboard`)).json()) as { venuesNamed: boolean; feeRules: unknown[]; venues: string[]; weeks: Array<{ n: number }> };
  assert.deepEqual([json.venuesNamed, json.feeRules, json.venues], [false, [], ["Venue A", "Venue B", "Venue C", "Venue D"]]);
  assert.equal(json.weeks.reduce((s, w) => s + w.n, 0), 3, "the three positions are on the table, so the missing names are not an empty table");
  const opJson = (await (await fetch(`${base}/api/shadow/scoreboard?token=${TOKEN}`)).json()) as { venuesNamed: boolean; feeRules: unknown[] };
  assert.deepEqual([opJson.venuesNamed, opJson.feeRules.length], [true, 4]);
});
