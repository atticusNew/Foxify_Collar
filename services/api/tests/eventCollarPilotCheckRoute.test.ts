/**
 * The pilot switch check as the worker serves it (GET /api/shadow/pilot-check and /pilot-check),
 * on a service as it starts with nothing switched on: the book strategy, the ledgers in a temp
 * folder, no alert sink. Operator only; a read that changes nothing; the answers follow the
 * settings in force, including ones changed while it runs; no key is in either body.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExposureCaps } from "../src/eventCollar/crossVenue/exposureCaps";
import { CANNOT, PILOT_NOTE, type PilotItem, type PilotReport } from "../src/eventCollar/crossVenue/pilotCheck";
import { appendShadowRecord } from "../src/eventCollar/crossVenue/shadowLedger";
import type { GameMarketRow, OneQuoteResult } from "../scripts/eventProtectXDemoService";

const TOKEN = "op-secret-0123456789";
const SHARED_KEY = "lock-key-0123456789";
const ANN_KEY = "ann-key-0123456789ab";
const BO_KEY = "bo-key-0123456789abc";
const SECRETS = [TOKEN, SHARED_KEY, ANN_KEY, BO_KEY];

const dir = mkdtempSync(join(tmpdir(), "pilot-check-"));
process.env.NODE_ENV = "test";
process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = join(dir, "lock-ledger.jsonl");
process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
process.env.EVENT_X_ADMIN_TOKEN = TOKEN;
process.env.EVENT_SHADOW_LOCK_KEY = SHARED_KEY;
process.env.EVENT_SHADOW_HOLDER_KEYS = `ann:${ANN_KEY},bo:${BO_KEY}`;
for (const k of Object.keys(process.env)) if (/^EVENT_HEDGE_|^EVENT_SHADOW_ALERT_|^EVENT_X_IN_PLAY|^EVENT_SHADOW_DISK_MOUNT$|^EVENT_X_DEV_NO_ADMIN$/.test(k)) delete process.env[k];

type Body = PilotReport & { ok: boolean; at: string };
let worker: typeof import("../scripts/eventShadowWorker");
let base = "";
const engine = {
  listGameMarkets: async (): Promise<GameMarketRow[]> => [],
  quoteOne: async (): Promise<OneQuoteResult> => ({ ok: false, status: 404, body: { ok: false } }) as unknown as OneQuoteResult,
};
const check = async (): Promise<Body> => (await (await fetch(`${base}/api/shadow/pilot-check`, { headers: { "x-admin-token": TOKEN } })).json()) as Body;
const item = (r: PilotReport, id: string): PilotItem => r.items.find((i) => i.id === id) as PilotItem;
const onDisk = (): string => readdirSync(dir).sort().map((f) => `${f}:${readFileSync(join(dir, f), "utf8")}`).join("\n");

before(async () => {
  worker = await import("../scripts/eventShadowWorker");
  worker.wireLockEngine(engine);
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => worker.server.close(() => r()));
});

test("pilot check route: operator only, by the token the other operator views take", async () => {
  for (const path of ["/api/shadow/pilot-check", "/pilot-check"]) {
    const none = await fetch(`${base}${path}`);
    assert.equal(none.status, 403, path);
    assert.deepEqual(await none.json(), { ok: false, error: "bad admin token" });
    assert.equal((await fetch(`${base}${path}?token=wrong`)).status, 403);
    // a lock key is not the operator's token, a holder's or the shared one
    assert.equal((await fetch(`${base}${path}`, { headers: { "x-lock-key": ANN_KEY } })).status, 403);
    assert.equal((await fetch(`${base}${path}?token=${SHARED_KEY}`)).status, 403);
    assert.equal((await fetch(`${base}${path}?token=${TOKEN}`)).status, 200);
    assert.equal((await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  }
});

test("pilot check route: a service with nothing switched on is not ready, and each answer says what was read", async () => {
  // one open lock on the shared key's ledger, as the founder's own would be
  appendShadowRecord(
    join(dir, "lock-ledger.jsonl"),
    { type: "open", ticker: "KXNBAGAME-26OCT14LALBOS-BOS", at: new Date().toISOString(), league: "nba", sideName: "Boston Celtics", eventTitle: "Lakers at Celtics", eventTimeIso: new Date(Date.now() + 3 * 3_600_000).toISOString(), contracts: 20, entryCents: 58, markCents: 60, floorCents: 15, capCents: 85, creditCents: 38, takeCents: 5, feesCents: 11, hedgeCostCents: 246, hedgeContractsMilli: 6000, route: "kalshi_self", routeLabel: "Kalshi", evCostBps: 0 } as unknown as Parameters<typeof appendShadowRecord>[1],
  );
  const before = onDisk();
  const r = await check();
  assert.equal(r.ok, true);
  assert.ok(Date.parse(r.at) > 0);
  assert.equal(r.note, PILOT_NOTE);
  assert.equal(r.ready, "no");
  assert.equal(r.items.length, 11);

  assert.equal(item(r, "hedge_first").answer, "no");
  assert.match(item(r, "hedge_first").detail, /the hedge strategy is "book", not live: every lock is a simulated record and nothing is bought/);
  assert.equal(item(r, "kill_switch").answer, "yes");
  assert.match(item(r, "kill_switch").detail, /Its state now: off\. Nothing leaves under these settings in any case: the hedge strategy is "book"\./);
  assert.equal(item(r, "caps").answer, "yes");
  assert.match(item(r, "caps").detail, /per order 25 hedge contracts; per day 100 hedge contracts; per game \$50\.00; per venue \$100\.00; per holder \$50\.00\./);
  assert.equal(item(r, "holder_keys").answer, CANNOT);
  assert.match(item(r, "holder_keys").detail, /2 holder keys listed, 2 in force, 0 not in force; shared key set/);
  assert.match(item(r, "holder_keys").confirm ?? "", /The shared key is set \(1 open lock on its ledger\)/);
  assert.equal(item(r, "in_play").answer, "no", "in play is on by default, and a lock during a game here is a simulated record");
  assert.equal(item(r, "ledger_disk").answer, "no");
  assert.match(item(r, "ledger_disk").detail, /^Under a temp folder, which is lost on every restart: /);
  assert.ok(item(r, "ledger_disk").detail.includes(join(dir, "lock-ledger.jsonl")));
  assert.match(item(r, "ledger_disk").detail, /The disk is mounted at \/var\/data\.$/);
  assert.equal(item(r, "alerts").answer, "no");
  assert.equal(item(r, "backup").answer, CANNOT);
  assert.equal(item(r, "keys_rotated").answer, CANNOT);
  assert.equal(item(r, "terms").answer, "no");
  assert.match(item(r, "terms").detail, /^No terms are in force on this service: /);
  // the service does not read the repository's documents: a documents-only merge does not restart it, so a listing could be stale
  assert.equal(item(r, "payout_runbook").answer, CANNOT);
  assert.match(item(r, "payout_runbook").detail, /does not look at the repository's documents/);
  assert.match(item(r, "payout_runbook").confirm ?? "", /who pays a holder what is owed/);
  assert.match(item(r, "backup").detail, /does not look at the repository's workflow files/);

  assert.ok(r.overall.startsWith(`ready for an outside holder: no. ${r.no.length} conditions answered no: 1 hedge_first, 5 in_play, 6 ledger_disk, 7 alerts, 10 terms`));
  assert.deepEqual(r.confirmByHand.map((l) => l.split(":")[0]), r.items.filter((i) => i.answer === CANNOT).map((i) => `${i.n} ${i.id}`));

  const text = JSON.stringify(r);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), "no key or token in the body");
  assert.equal(onDisk(), before, "a read: nothing on disk is written, moved or removed");
  assert.deepEqual((await check()).items, r.items, "and asking again gives the same answers");
});

test("pilot check route: the answers follow the settings in force", async () => {
  const none: ExposureCaps = { gameCents: null, venueCents: 10_000, venueOverrides: {}, holderCents: 5_000, notes: [] };
  worker.wireLockEngine({ ...engine, exposureCaps: none, inPlay: false });
  const r = await check();
  assert.equal(item(r, "caps").answer, "no");
  assert.match(item(r, "caps").detail, /^Set to no cap: EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_GAME\. The caps now: .*per game no cap;/);
  assert.equal(item(r, "in_play").answer, "yes");
  assert.match(item(r, "in_play").detail, /^Off \(EVENT_X_IN_PLAY=0\): a lock closes 45 minutes before the start\./);
  assert.ok(r.no.includes("3 caps") && !r.no.includes("5 in_play"));
  // the check gates nothing: the status page, which is what a lock reads, is as it was
  const health = (await (await fetch(`${base}/healthz?token=${TOKEN}`)).json()) as { exposure: { caps: { perGameCents: unknown } } };
  assert.equal(health.exposure.caps.perGameCents, "no cap");
  worker.wireLockEngine({ ...engine, exposureCaps: { ...none, gameCents: 5_000 }, inPlay: true });
  assert.equal(item(await check(), "caps").answer, "yes");
});

test("pilot check page: the same words as the JSON, in a plain table, saying it changes nothing", async () => {
  const r = await check();
  const res = await fetch(`${base}/pilot-check`, { headers: { "x-admin-token": TOKEN } });
  assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const html = await res.text();
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  assert.ok(html.includes(esc(PILOT_NOTE)));
  assert.ok(html.includes(esc(r.overall)));
  for (const i of r.items) {
    assert.ok(html.includes(esc(i.condition)), i.id);
    assert.ok(html.includes(esc(i.detail)), i.id);
    if (i.confirm) assert.ok(html.includes(`To confirm by hand: ${esc(i.confirm)}`), i.id);
  }
  assert.equal((html.match(/<tr class="(yes|no|hand)">/g) ?? []).length, 11);
  assert.ok(!/[\u2013\u2014]/.test(html), "no dash on the page");
  for (const secret of SECRETS) assert.ok(!html.includes(secret), "no key or token on the page");
  // opened with the token in the address, as the other operator pages are, its links carry it on
  const linked = await (await fetch(`${base}/pilot-check?token=${TOKEN}`)).text();
  assert.ok(linked.includes(`/api/shadow/pilot-check?token=${TOKEN}`));
  for (const key of [SHARED_KEY, ANN_KEY, BO_KEY]) assert.ok(!linked.includes(key));
});
