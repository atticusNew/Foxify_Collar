/**
 * Event shadow worker hardening: alert thresholds, dedupe, ledger stats, and
 * the export/health HTTP surface.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  buildShadowAlerter,
  evaluateShadowHealth,
  parseShadowAlertsFromEnv,
  type ShadowAlertConfig,
} from "../src/eventCollar/crossVenue/shadowAlerts";
import { appendShadowRecord, ledgerStats, type ShadowOpenRecord } from "../src/eventCollar/crossVenue/shadowLedger";

const CFG: ShadowAlertConfig = {
  telegramBotToken: null,
  telegramChatId: null,
  webhookUrl: null,
  dedupeMs: 6 * 3_600_000,
  scanFailureThreshold: 3,
  stallIntervals: 3,
};

const HEALTHY = {
  nowMs: 1_000_000_000,
  scanMs: 300_000,
  lastScanOkMs: 1_000_000_000 - 60_000,
  bootMs: 1_000_000_000 - 3_600_000,
  consecutiveScanFailures: 0,
  lastScanError: null,
  settleFailuresLastTick: 0,
  settleDueLastTick: 4,
  scanFailingRaised: false,
};

test("shadow alerts: env parsing with defaults", () => {
  const cfg = parseShadowAlertsFromEnv({});
  assert.equal(cfg.telegramBotToken, null);
  assert.equal(cfg.webhookUrl, null);
  assert.equal(cfg.scanFailureThreshold, 3);
  assert.equal(cfg.stallIntervals, 3);
  assert.equal(cfg.dedupeMs, 6 * 3_600_000);
  const custom = parseShadowAlertsFromEnv({
    EVENT_SHADOW_ALERT_WEBHOOK_URL: "https://hooks.example/x",
    EVENT_SHADOW_ALERT_SCAN_FAILURES: "5",
    EVENT_SHADOW_ALERT_DEDUPE_MS: "junk",
  });
  assert.equal(custom.webhookUrl, "https://hooks.example/x");
  assert.equal(custom.scanFailureThreshold, 5);
  assert.equal(custom.dedupeMs, 6 * 3_600_000, "garbage falls back to the default");
});

test("shadow alerts: healthy state raises nothing", () => {
  assert.deepEqual(evaluateShadowHealth(HEALTHY, CFG), []);
});

test("shadow alerts: scan failures fire once at the threshold, recover once", () => {
  const two = evaluateShadowHealth({ ...HEALTHY, consecutiveScanFailures: 2, lastScanError: "boom" }, CFG);
  assert.deepEqual(two, []);
  const three = evaluateShadowHealth({ ...HEALTHY, consecutiveScanFailures: 3, lastScanError: "boom" }, CFG);
  assert.equal(three.length, 1);
  assert.equal(three[0].kind, "scan_failing");
  assert.match(three[0].message, /3 times in a row: boom/);
  // already raised: the streak continuing does not re-fire
  const four = evaluateShadowHealth({ ...HEALTHY, consecutiveScanFailures: 4, lastScanError: "boom", scanFailingRaised: true }, CFG);
  assert.deepEqual(four, []);
  // back to zero after a raise: one recovery message
  const ok = evaluateShadowHealth({ ...HEALTHY, consecutiveScanFailures: 0, scanFailingRaised: true }, CFG);
  assert.deepEqual(ok.map((a) => a.kind), ["scan_recovered"]);
});

test("shadow alerts: stall is measured from the last success, or from boot", () => {
  const stalled = evaluateShadowHealth({ ...HEALTHY, lastScanOkMs: HEALTHY.nowMs - 16 * 60_000 }, CFG);
  assert.deepEqual(stalled.map((a) => a.kind), ["scan_stalled"]);
  assert.match(stalled[0].message, /no successful board scan for 16m \(expected every 5m\)/);
  const justUnder = evaluateShadowHealth({ ...HEALTHY, lastScanOkMs: HEALTHY.nowMs - 15 * 60_000 }, CFG);
  assert.deepEqual(justUnder, []);
  // never scanned since boot, boot was long ago
  const neverScanned = evaluateShadowHealth({ ...HEALTHY, lastScanOkMs: null, bootMs: HEALTHY.nowMs - 3_600_000, lastScanError: "dns" }, CFG);
  assert.deepEqual(neverScanned.map((a) => a.kind), ["scan_stalled"]);
  assert.match(neverScanned[0].message, /last error: dns/);
  // never scanned, but only just booted: no alert yet
  const freshBoot = evaluateShadowHealth({ ...HEALTHY, lastScanOkMs: null, bootMs: HEALTHY.nowMs - 60_000 }, CFG);
  assert.deepEqual(freshBoot, []);
});

test("shadow alerts: settlement fires only when every due lookup failed", () => {
  const all = evaluateShadowHealth({ ...HEALTHY, settleDueLastTick: 3, settleFailuresLastTick: 3 }, CFG);
  assert.deepEqual(all.map((a) => a.kind), ["settle_failing"]);
  const some = evaluateShadowHealth({ ...HEALTHY, settleDueLastTick: 3, settleFailuresLastTick: 2 }, CFG);
  assert.deepEqual(some, []);
  const none = evaluateShadowHealth({ ...HEALTHY, settleDueLastTick: 0, settleFailuresLastTick: 0 }, CFG);
  assert.deepEqual(none, []);
});

test("shadow alerts: alerter dedupes per kind, posts to both sinks, swallows sink failures", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body ?? "null")) });
    if (url.includes("hooks.example")) throw new Error("webhook down");
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  let t = 0;
  const logged: string[] = [];
  const alerter = buildShadowAlerter(
    { ...CFG, telegramBotToken: "TOKEN", telegramChatId: "42", webhookUrl: "https://hooks.example/x", dedupeMs: 1000 },
    fakeFetch,
    () => t,
    (l) => logged.push(l),
  );
  await alerter({ kind: "scan_failing", message: "boom" });
  assert.equal(calls.length, 2, "telegram + webhook");
  const tg = calls.find((c) => c.url.includes("api.telegram.org/botTOKEN/sendMessage"));
  assert.ok(tg);
  assert.deepEqual(tg.body, { chat_id: "42", text: "[event-shadow] scan_failing: boom" });
  const wh = calls.find((c) => c.url.includes("hooks.example"));
  assert.ok(wh);
  assert.equal((wh.body as { kind: string }).kind, "scan_failing");
  assert.equal(logged.length, 1);

  // same kind inside the dedupe window: silent
  t = 500;
  await alerter({ kind: "scan_failing", message: "boom again" });
  assert.equal(calls.length, 2);
  // a different kind is not suppressed
  await alerter({ kind: "position_voided", message: "x" });
  assert.equal(calls.length, 4);
  // recovery clears the scan_failing dedupe so the next outage reports immediately
  await alerter({ kind: "scan_recovered", message: "ok" });
  assert.equal(calls.length, 6);
  await alerter({ kind: "scan_failing", message: "boom 2" });
  assert.equal(calls.length, 8);
  // outside the window the same kind reports again
  t = 5000;
  await alerter({ kind: "position_voided", message: "y" });
  assert.equal(calls.length, 10);
});

const OPEN: ShadowOpenRecord = {
  type: "open",
  at: "2026-09-12T16:00:00.000Z",
  ticker: "KXNFLGAME-TEST-KC",
  kind: "sports",
  league: "nfl",
  sideName: "Kansas City Chiefs",
  eventTitle: "Kansas City wins",
  eventTimeIso: "2026-09-21T00:20:00.000Z",
  contracts: 150,
  markCents: 60,
  floorCents: 52,
  capCents: 63,
  creditCents: 112,
  evCostBps: 297,
  route: "polymarket",
  feesCents: 0,
  takeCents: 12,
};

test("shadow ledger: stats count bytes and non-empty lines; missing file is empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-stats-"));
  const path = join(dir, "ledger.jsonl");
  assert.deepEqual(ledgerStats(path), { exists: false, bytes: 0, records: 0 });
  appendShadowRecord(path, OPEN);
  appendShadowRecord(path, { type: "settle", at: "2026-09-21T04:00:00.000Z", ticker: OPEN.ticker, result: "yes" });
  const s = ledgerStats(path);
  assert.equal(s.exists, true);
  assert.equal(s.records, 2);
  assert.equal(s.bytes, Buffer.byteLength(readFileSync(path, "utf8")));
});

test("shadow worker: /healthz carries ledger stats and failure counters; /api/shadow/export streams the raw ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-worker-"));
  const path = join(dir, "ledger.jsonl");
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = path;
  const { server } = await import("../scripts/eventShadowWorker");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // empty ledger: export is an empty 200, health reports no file
    const emptyExport = await fetch(`${base}/api/shadow/export`);
    assert.equal(emptyExport.status, 200);
    assert.equal(await emptyExport.text(), "");
    let health = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    assert.equal(health.ok, true);
    assert.deepEqual(health.ledger, { path, exists: false, bytes: 0, records: 0 });
    assert.equal(health.consecutiveScanFailures, 0);
    assert.equal(health.alertsConfigured, false);

    appendShadowRecord(path, OPEN);
    appendShadowRecord(path, { type: "settle", at: "2026-09-21T04:00:00.000Z", ticker: OPEN.ticker, result: "no" });
    const raw = readFileSync(path, "utf8");

    const exp = await fetch(`${base}/api/shadow/export`);
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get("content-type") ?? "", /x-ndjson/);
    assert.match(exp.headers.get("content-disposition") ?? "", /event-shadow-ledger-\d{4}-\d{2}-\d{2}\.jsonl/);
    assert.equal(exp.headers.get("content-length"), String(Buffer.byteLength(raw)));
    assert.equal(await exp.text(), raw, "byte-for-byte the append-only ledger");

    health = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    assert.deepEqual(health.ledger, { path, exists: true, bytes: Buffer.byteLength(raw), records: 2 });
    assert.equal(health.positions, 1);

    const api = (await (await fetch(`${base}/api/shadow`)).json()) as {
      summary: { settledCount: number; floorSaves: number; writer: { settledPnlCents: number; takeBookedCents: number } };
    };
    assert.equal(api.summary.settledCount, 1);
    assert.equal(api.summary.floorSaves, 1);
    assert.equal(api.summary.writer.settledPnlCents, OPEN.takeCents, "writer realized the published take");
    assert.equal(api.summary.writer.takeBookedCents, OPEN.takeCents);

    const csv = await fetch(`${base}/api/shadow/positions.csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(csv.headers.get("content-disposition") ?? "", /event-shadow-positions-\d{4}-\d{2}-\d{2}\.csv/);
    const csvLines = (await csv.text()).trimEnd().split("\n");
    assert.equal(csvLines.length, 2, "header + the one position");
    assert.ok(csvLines[0].startsWith("ticker,league,kind,"));
    assert.ok(csvLines[1].startsWith(`${OPEN.ticker},`));

    const page = await (await fetch(`${base}/`)).text();
    assert.ok(page.includes('href="/api/shadow/export"'), "the page links the full ledger download");
    assert.ok(page.includes('href="/api/shadow/positions.csv"'), "and the spreadsheet form");
    assert.ok(page.includes("writer P&amp;L, settled"));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
