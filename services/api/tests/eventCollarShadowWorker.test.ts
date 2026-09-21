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
import { forbiddenKeysIn } from "../src/eventCollar/retailShowcase";

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

test("shadow worker: public record vs operator views; /api/shadow/export streams the raw ledger to the operator", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-worker-"));
  const path = join(dir, "ledger.jsonl");
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = path;
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  const { server } = await import("../scripts/eventShadowWorker");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const op = { headers: { "x-admin-token": "op-secret" } };
  try {
    // operator views are gated: no token, wrong token -> 403; the public record is unaffected
    for (const p of ["/report", "/api/shadow/report", "/api/shadow/hedges", "/api/shadow/export"]) {
      assert.equal((await fetch(`${base}${p}`)).status, 403, `${p} without a token`);
      assert.equal((await fetch(`${base}${p}?token=wrong`)).status, 403, `${p} with the wrong token`);
    }
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/api/shadow`)).status, 200);
    assert.equal((await fetch(`${base}/api/shadow/positions.csv`)).status, 200);

    // empty ledger: export is an empty 200, health reports no file
    const emptyExport = await fetch(`${base}/api/shadow/export`, op);
    assert.equal(emptyExport.status, 200);
    assert.equal(await emptyExport.text(), "");
    // public /healthz: up, scanning, how many positions — no paths, strategy, venues or error text
    const publicHealth = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(publicHealth).sort(), ["lastScanAt", "lastSettleAt", "ok", "positions", "service"]);
    assert.equal(publicHealth.ok, true);
    assert.equal(publicHealth.positions, 0);
    assert.deepEqual(forbiddenKeysIn(publicHealth), []);
    // the operator token unlocks the full body
    let health = (await (await fetch(`${base}/healthz`, op)).json()) as Record<string, unknown>;
    assert.equal(health.ok, true);
    assert.deepEqual(health.ledger, { path, exists: false, bytes: 0, records: 0 });
    assert.equal(health.consecutiveScanFailures, 0);
    assert.equal(health.alertsConfigured, false);

    appendShadowRecord(path, OPEN);
    appendShadowRecord(path, { type: "settle", at: "2026-09-21T04:00:00.000Z", ticker: OPEN.ticker, result: "no" });
    const raw = readFileSync(path, "utf8");

    const exp = await fetch(`${base}/api/shadow/export?token=op-secret`);
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get("content-type") ?? "", /x-ndjson/);
    assert.match(exp.headers.get("content-disposition") ?? "", /event-shadow-ledger-\d{4}-\d{2}-\d{2}\.jsonl/);
    assert.equal(exp.headers.get("content-length"), String(Buffer.byteLength(raw)));
    assert.equal(await exp.text(), raw, "byte-for-byte the append-only ledger");

    health = (await (await fetch(`${base}/healthz`, op)).json()) as Record<string, unknown>;
    assert.deepEqual(health.ledger, { path, exists: true, bytes: Buffer.byteLength(raw), records: 2 });
    assert.equal(health.positions, 1);
    assert.equal(((await (await fetch(`${base}/healthz`)).json()) as { positions: number }).positions, 1, "the public body counts positions too");

    const api = (await (await fetch(`${base}/api/shadow`)).json()) as {
      summary: {
        settledCount: number;
        floorSaves: number;
        writer: { settledPnlCents: number; takeBookedCents: number };
        counterfactuals: Record<string, unknown>;
      };
    };
    assert.equal(api.summary.settledCount, 1);
    assert.equal(api.summary.floorSaves, 1);
    assert.equal(api.summary.writer.settledPnlCents, OPEN.takeCents, "writer realized the published take");
    assert.equal(api.summary.writer.takeBookedCents, OPEN.takeCents);
    assert.deepEqual(
      Object.keys(api.summary.counterfactuals).sort(),
      ["positionsWithCounterfactuals", "recordedSince"],
      "the public JSON says the comparison exists; the rule books stay with the operator",
    );

    // public CSV: what was quoted and settled, no counterfactual columns; the operator's ?scope=full has them all
    const csv = await fetch(`${base}/api/shadow/positions.csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(csv.headers.get("content-disposition") ?? "", /event-shadow-positions-\d{4}-\d{2}-\d{2}\.csv/);
    const csvLines = (await csv.text()).trimEnd().split("\n");
    assert.equal(csvLines.length, 2, "header + the one position");
    assert.ok(csvLines[0].startsWith("ticker,league,kind,"));
    assert.ok(csvLines[0].endsWith(",ev_cost_bps,tier"));
    assert.ok(!csvLines[0].includes("wide_floor_c") && !csvLines[0].includes("x20_refused"));
    assert.ok(csvLines[1].startsWith(`${OPEN.ticker},`));
    const publicAsksFull = await fetch(`${base}/api/shadow/positions.csv?scope=full`);
    assert.ok(!(await publicAsksFull.text()).includes("wide_floor_c"), "scope=full without the token is the public CSV");
    const fullCsv = await fetch(`${base}/api/shadow/positions.csv?scope=full&token=op-secret`);
    assert.match(fullCsv.headers.get("content-disposition") ?? "", /event-shadow-positions-full-/);
    const fullHeader = (await fullCsv.text()).split("\n")[0];
    assert.ok(fullHeader.includes("wide_floor_c") && fullHeader.includes("x20_refused") && fullHeader.includes("min_25bps_take_c"));

    // the public page: outcomes and the live book's receipts; no operator links, one line saying the comparison exists
    const page = await (await fetch(`${base}/`)).text();
    assert.ok(page.includes('href="/api/shadow/positions.csv"'), "the spreadsheet form");
    assert.ok(page.includes("our P&amp;L, settled") && !page.includes("writer P&amp;L"));
    assert.ok(page.includes("Track record") && !page.includes("Shadow record"));
    assert.ok(!page.includes('href="/report"') && !page.includes('href="/api/shadow/export"') && !page.includes('href="/api/shadow/hedges"'));
    assert.ok(!page.includes("What each rule would have done") && !page.includes("How the hedge leg is filled"));
    assert.ok(page.includes("rule comparison") && page.includes("report on request"));
    assert.ok(page.includes("hedge fills"));

    // the rule comparison (operator): JSON carries the rule books plus the plain-language rules; HTML renders them
    const report = (await (await fetch(`${base}/api/shadow/report`, op)).json()) as {
      ok: boolean;
      period: { recordedSince: string | null };
      rules: { tiers: Record<string, string>; feeRules: Record<string, { name: string }> };
      counterfactuals: { positionsWithCounterfactuals: number; baseline: { quoted: number }; capacity: Array<{ mult: number }> };
    };
    assert.equal(report.ok, true);
    assert.equal(report.counterfactuals.positionsWithCounterfactuals, 0, "a legacy open carries no counterfactuals");
    assert.equal(report.period.recordedSince, null);
    assert.ok(report.rules.tiers.tight && report.rules.tiers.balanced && report.rules.tiers.wide);
    assert.equal(report.rules.feeRules.min_25bps.name, "share or 0.25% of stake");
    assert.deepEqual(report.counterfactuals.capacity.map((c) => c.mult), [1, 5, 20]);
    const reportPage = await fetch(`${base}/report?token=op-secret`);
    assert.equal(reportPage.status, 200);
    assert.match(reportPage.headers.get("content-type") ?? "", /text\/html/);
    const reportHtml = await reportPage.text();
    assert.ok(reportHtml.includes("What each rule would have done"));
    assert.ok(reportHtml.includes("not started"), "no v2 positions yet: the period says so");
    assert.ok(!reportHtml.includes("NaN"));
    assert.ok(reportHtml.includes('href="/api/shadow/export?token=op-secret"'), "operator links carry the token");
    assert.ok(reportHtml.includes('href="/api/shadow/positions.csv?scope=full&token=op-secret"'));

    // the hedge trail: book by default, receipts next to the ledger, surfaced on healthz, JSON and the page
    const h = health as { hedge: { strategy: string; rfqVenues: string[]; notes: string[]; receipts: { path: string; exists: boolean } } };
    assert.equal(h.hedge.strategy, "book");
    assert.deepEqual(h.hedge.rfqVenues, []);
    assert.equal(h.hedge.receipts.path, join(dir, "hedge-receipts.jsonl"));
    const hedges = (await (await fetch(`${base}/api/shadow/hedges?limit=5`, op)).json()) as {
      ok: boolean;
      strategy: string;
      summary: { receipts: number; byOutcome: Record<string, number> };
      recent: unknown[];
    };
    assert.equal(hedges.ok, true);
    assert.equal(hedges.strategy, "book");
    assert.equal(hedges.summary.receipts, 0, "positions appended by hand carry no hedge receipt; the scanner writes those");
    assert.deepEqual(hedges.recent, []);
  } finally {
    delete process.env.EVENT_X_ADMIN_TOKEN;
    await new Promise<void>((r) => server.close(() => r()));
  }
});
