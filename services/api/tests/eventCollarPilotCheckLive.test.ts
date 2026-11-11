/**
 * The pilot switch check on a service set as a pilot would set it: live, sending, every game
 * armed, the kill switch off, each holder on a key of their own and no shared key, an alert sink.
 * What settings can show is a yes; what the books decide, and what only the founder can see, is
 * on the list to confirm; what is not built is a no, so the overall line is still no.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANNOT, type PilotItem, type PilotReport } from "../src/eventCollar/crossVenue/pilotCheck";
import type { GameMarketRow, OneQuoteResult } from "../scripts/eventProtectXDemoService";

test("pilot check route, live and sending: hedge first is in force where there is a key, and the venues with none are named to confirm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilot-check-live-"));
  const TOKEN = "op-secret-0123456789";
  const KEYS = ["ann-key-0123456789ab", "bo-key-0123456789abc"];
  process.env.NODE_ENV = "test";
  for (const k of Object.keys(process.env)) if (/^EVENT_HEDGE_|^EVENT_SHADOW_ALERT_|^EVENT_X_IN_PLAY|^EVENT_X_DEV_NO_ADMIN$|^EVENT_SHADOW_LOCK_KEY$|^NOVIG_|^SPORTS_AGG|^VENUE_API/.test(k)) delete process.env[k];
  process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = join(dir, "lock-ledger.jsonl");
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  process.env.EVENT_SHADOW_DISK_MOUNT = dir;
  process.env.EVENT_X_ADMIN_TOKEN = TOKEN;
  process.env.EVENT_SHADOW_HOLDER_KEYS = `ann:${KEYS[0]},bo:${KEYS[1]}`;
  process.env.EVENT_HEDGE_STRATEGY = "live";
  process.env.EVENT_HEDGE_LIVE_SEND = "yes";
  process.env.EVENT_HEDGE_LIVE_TICKERS = "*";
  process.env.EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_ORDER = "10";
  process.env.EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_VENUE_KALSHI = "7500";
  // a sink that is set; nothing in this test raises an alert, and the address answers nobody
  process.env.EVENT_SHADOW_ALERT_WEBHOOK_URL = "http://127.0.0.1:9/alerts";
  // a throwaway key: the service then has a client for Kalshi and for no other venue; no order is built here
  process.env.KALSHI_API_KEY_ID = "test-key-id";
  process.env.KALSHI_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;

  const worker = await import("../scripts/eventShadowWorker");
  worker.wireLockEngine({
    listGameMarkets: async (): Promise<GameMarketRow[]> => [],
    quoteOne: async (): Promise<OneQuoteResult> => ({ ok: false, status: 404, body: { ok: false } }) as unknown as OneQuoteResult,
  });
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/api/shadow/pilot-check`)).status, 403);
    const res = await fetch(`${base}/api/shadow/pilot-check`, { headers: { "x-admin-token": TOKEN } });
    const text = await res.text();
    const r = JSON.parse(text) as PilotReport;
    const item = (id: string): PilotItem => r.items.find((i) => i.id === id) as PilotItem;

    assert.equal(item("hedge_first").answer, CANNOT);
    assert.match(item("hedge_first").detail, /^Live, sending, every game armed, kill switch off, a key to send with on Kalshi\./);
    assert.match(item("hedge_first").detail, /But there is no key to send with on Polymarket, ProphetX, Novig\./);
    assert.equal(item("kill_switch").answer, "yes");
    assert.match(item("kill_switch").detail, /Its state now: off\./);
    assert.equal(item("caps").answer, "yes");
    assert.match(item("caps").detail, /per order 10 hedge contracts; per day 100 hedge contracts; per game \$50\.00; per venue \$100\.00 \(Kalshi \$75\.00\); per holder \$50\.00\./);
    assert.equal(item("holder_keys").answer, "yes");
    assert.match(item("holder_keys").detail, /2 holder keys listed, 2 in force, 0 not in force; shared key not set\. Every key in force is different from every other\./);
    assert.equal(item("in_play").answer, CANNOT);
    // the ledgers are under the folder named as the mount, and that folder is a temp folder on this machine
    assert.equal(item("ledger_disk").answer, "no");
    assert.match(item("ledger_disk").detail, /^Under a temp folder/);
    assert.equal(item("alerts").answer, "yes");
    assert.match(item("alerts").detail, /^Configured: a webhook/);
    assert.equal(item("terms").answer, "no");

    assert.equal(r.ready, "no");
    assert.ok(!r.no.includes("1 hedge_first") && !r.no.includes("2 kill_switch") && !r.no.includes("3 caps") && !r.no.includes("4 holder_keys") && !r.no.includes("7 alerts"));
    assert.ok(r.no.includes("10 terms"));
    for (const secret of [TOKEN, ...KEYS, "test-key-id", "127.0.0.1:9"]) assert.ok(!text.includes(secret), "no key, token or address in the body");
  } finally {
    await new Promise<void>((r) => worker.server.close(() => r()));
  }
});
