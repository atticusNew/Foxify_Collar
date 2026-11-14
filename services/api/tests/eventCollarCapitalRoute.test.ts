/**
 * The capital model as the worker serves it (GET /api/shadow/capital and /capital): operator only,
 * read off the simulated record's ledger, a read that changes nothing on disk, and a page that
 * prints the same figures the JSON carries.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapitalModel } from "../src/eventCollar/crossVenue/capitalModel";
import { appendShadowRecord } from "../src/eventCollar/crossVenue/shadowLedger";
import type { GameMarketRow, OneQuoteResult } from "../scripts/eventProtectXDemoService";

const TOKEN = "op-secret-0123456789";
const LOCK_KEY = "lock-key-0123456789";

const dir = mkdtempSync(join(tmpdir(), "capital-route-"));
process.env.NODE_ENV = "test";
process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = join(dir, "lock-ledger.jsonl");
process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
process.env.EVENT_X_ADMIN_TOKEN = TOKEN;
process.env.EVENT_SHADOW_LOCK_KEY = LOCK_KEY;
for (const k of Object.keys(process.env)) if (/^EVENT_HEDGE_|^EVENT_SHADOW_ALERT_|^EVENT_X_DEV_NO_ADMIN$/.test(k)) delete process.env[k];

type Body = CapitalModel & { ok: boolean; simulated: boolean };
let worker: typeof import("../scripts/eventShadowWorker");
let base = "";
const engine = {
  listGameMarkets: async (): Promise<GameMarketRow[]> => [],
  quoteOne: async (): Promise<OneQuoteResult> => ({ ok: false, status: 404, body: { ok: false } }) as unknown as OneQuoteResult,
};
const onDisk = (): string => readdirSync(dir).sort().map((f) => `${f}:${readFileSync(join(dir, f), "utf8")}`).join("\n");
const ago = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();
type Rec = Parameters<typeof appendShadowRecord>[1];

before(async () => {
  const ledger = process.env.EVENT_SHADOW_LEDGER_PATH as string;
  const open = (ticker: string, at: string, start: string, o: Record<string, unknown>): Rec =>
    ({ type: "open", ticker, at, kind: "sports", league: "nfl", sideName: "Side", eventTitle: "A at B", eventTimeIso: start, markCents: 60, evCostBps: 0, feesCents: 0, route: "polymarket", ...o }) as unknown as Rec;
  // A: 100 contracts, cap 80, credit $1.00, take 50c, hedge 60 contracts. Collar $19.50 out; ceiling $60.00. Settled.
  appendShadowRecord(ledger, open("CAP-A", ago(60), ago(40), { contracts: 100, floorCents: 40, capCents: 80, creditCents: 100, takeCents: 50, hedgeUnitsMilli: 60_000 }));
  appendShadowRecord(ledger, { type: "settle", at: ago(37), ticker: "CAP-A", result: "yes" } as Rec);
  // C: 10 contracts, cap 70, credit 5c, take 5c, hedge 6 contracts. Collar $2.95 out; ceiling $6.00. Still open.
  appendShadowRecord(ledger, open("CAP-C", ago(10), new Date(Date.now() + 5 * 3_600_000).toISOString(), { contracts: 10, floorCents: 30, capCents: 70, creditCents: 5, takeCents: 5, hedgeUnitsMilli: 6000, route: "kalshi_self" }));

  worker = await import("../scripts/eventShadowWorker");
  worker.wireLockEngine(engine);
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => worker.server.close(() => r()));
});

test("capital route: operator only, by the token the other operator views take", async () => {
  for (const path of ["/api/shadow/capital", "/capital"]) {
    const none = await fetch(`${base}${path}`);
    assert.equal(none.status, 403, path);
    assert.deepEqual(await none.json(), { ok: false, error: "bad admin token" });
    assert.equal((await fetch(`${base}${path}?token=wrong`)).status, 403);
    assert.equal((await fetch(`${base}${path}?token=${LOCK_KEY}`)).status, 403);
    assert.equal((await fetch(`${base}${path}`, { headers: { "x-lock-key": LOCK_KEY } })).status, 403);
    assert.equal((await fetch(`${base}${path}?token=${TOKEN}`)).status, 200);
    assert.equal((await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  }
});

test("capital route: the figures are read off the record's ledger, and reading them writes nothing", async () => {
  const before = onDisk();
  const m = (await (await fetch(`${base}/api/shadow/capital`, { headers: { "x-admin-token": TOKEN } })).json()) as Body;
  assert.equal(m.ok, true);
  assert.equal(m.simulated, true);
  assert.deepEqual([m.record.lines, m.record.counted, m.record.voided, m.record.memberSales, m.record.days], [2, 2, 0, 0, 3]);
  assert.deepEqual(m.ownSale, { peakCents: 0, lines: 2 });

  // the two lines never overlap: A was back 37 hours ago, C went out 10 hours ago
  const [noLag, oneDay] = m.collar.byLag;
  assert.deepEqual([m.collar.lines, m.collar.open, m.collar.outlayCents, m.collar.takeCents], [2, 1, 1950 + 295, 55]);
  assert.deepEqual([noLag.lagHours, noLag.peakCents, noLag.nowCents], [0, 1950, 295]);
  assert.deepEqual([oneDay.lagHours, oneDay.peakCents, oneDay.nowCents], [24, 1950, 295]);
  assert.deepEqual(noLag.atMultiple.map((x) => [x.multiple, x.peakCents]), [[1, 1950], [10, 19_500], [100, 195_000]]);
  assert.deepEqual(m.collar.byRoute, [
    { route: "polymarket", lines: 1, peakCents: 1950 },
    { route: "kalshi_self", lines: 1, peakCents: 295 },
  ]);

  const c = m.betterBid.ceiling;
  assert.deepEqual([c.lines, c.outlayCents, c.byLag[0].peakCents, c.byLag[0].nowCents], [2, 6600, 6000, 600]);
  assert.deepEqual([m.betterBid.linesMeasured, m.betterBid.measured.lines], [0, 0]);
  assert.equal(m.medianStartToSettleMinutes, 180);

  assert.equal(onDisk(), before, "a read: nothing on disk changed");
});

test("capital page: the same figures in words, own sale at nothing, and no key in the body", async () => {
  const html = await (await fetch(`${base}/capital?token=${TOKEN}`)).text();
  assert.match(html, /<title>Capital · operator · Earn &amp; Protect<\/title>/);
  assert.match(html, /<b>Direct lock<\/b><i>in the holder's own account, nothing hedged<\/i><\/td><td>\$0\.00<\/td><td>\$0\.00<\/td><td>\$0\.00<\/td>/);
  // collar: $19.50 at record volume, $195.00 at 10 times, $1,950.00 at 100 times, $2.95 out now
  assert.match(html, /<b>Collar, our book<\/b><i>paid back at the result<\/i><\/td><td>\$19\.50<\/td><td>\$195\.00<\/td><td>\$1,950\.00<\/td><td>\$[\d.,]+<\/td><td>\$2\.95<\/td>/);
  assert.match(html, /<b>Better bid, ceiling<\/b><i>paid back at the result<\/i><\/td><td>\$60\.00<\/td><td>\$600\.00<\/td><td>\$6,000\.00<\/td>/);
  assert.match(html, /<i>paid back 24 hours after the result<\/i>/);
  assert.match(html, /Better bid, measured: no line carries the measurement yet\./);
  assert.match(html, /2 lines counted, since .* \(3 days\)\. Left out: 0 voided, 0 member locks/);
  assert.match(html, /Simulated, like the record\. Nothing was bought\./);
  assert.match(html, /That is an assumption\./);
  assert.match(html, /\$22\.45 for the collar against \$19\.50 pooled/);
  // the page carries no key and no token: its links are opened by the operator's sign-in
  assert.ok(!html.includes(LOCK_KEY));
  assert.ok(!html.includes(TOKEN));
  assert.ok(html.includes('href="/api/shadow/capital"') && html.includes('href="/pilot-check"') && html.includes('href="/holders"'));
});
