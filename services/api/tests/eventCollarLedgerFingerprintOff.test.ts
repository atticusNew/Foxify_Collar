/**
 * EVENT_SHADOW_FINGERPRINTS=0: the service keeps no fingerprints, writes no file beside the
 * ledger, and says so where the operator looks; the record page carries no section.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendShadowRecord } from "../src/eventCollar/crossVenue/shadowLedger";

test("shadow worker: with fingerprints switched off there is no section, no list and no file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-fingerprint-off-"));
  const path = join(dir, "ledger.jsonl");
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = path;
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg-ledger.jsonl");
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_FINGERPRINTS = "0";
  delete process.env.EVENT_SHADOW_ALERT_WEBHOOK_URL;
  appendShadowRecord(path, { type: "settle", at: "2026-09-12T04:00:00.000Z", ticker: "KXNFLGAME-TEST-A", result: "no" });
  appendShadowRecord(path, { type: "settle", at: "2026-09-13T04:00:00.000Z", ticker: "KXNFLGAME-TEST-B", result: "yes" });

  const { server } = await import("../scripts/eventShadowWorker");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const op = { headers: { "x-admin-token": "op-secret" } };
  try {
    const page = await (await fetch(`${base}/`)).text();
    assert.ok(!page.includes("Ledger fingerprint") && !page.includes("/api/shadow/fingerprints"));
    assert.equal((await fetch(`${base}/api/shadow/fingerprints`)).status, 404);
    assert.equal((await fetch(`${base}/api/shadow/fingerprints?ledger=lock`, op)).status, 404);
    const holders = await (await fetch(`${base}/holders?token=op-secret`)).text();
    assert.ok(!holders.includes("Lock ledger fingerprints"));
    const health = (await (await fetch(`${base}/healthz`, op)).json()) as { ledgerFingerprints: unknown };
    assert.deepEqual(health.ledgerFingerprints, { on: false, off: "EVENT_SHADOW_FINGERPRINTS=0" });
    assert.deepEqual(Object.keys((await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>).sort(), ["lastScanAt", "lastSettleAt", "ok", "positions", "service"]);
    assert.deepEqual(readdirSync(dir), ["ledger.jsonl"], "nothing is written beside the ledger");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
