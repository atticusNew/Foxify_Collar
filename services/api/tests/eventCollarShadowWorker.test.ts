/**
 * Event shadow worker hardening: alert thresholds, dedupe, ledger stats, and
 * the export/health HTTP surface.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
  // a stray hedge is one order on one venue: two in the same second are two pages
  await alerter({ kind: "hedge_stray", message: "5 of 13 filled, no lock" });
  await alerter({ kind: "hedge_stray", message: "order not confirmed, no lock" });
  assert.equal(calls.length, 14);
  // a day whose fills differ is one day's check: two days checked in the same hour are two pages
  await alerter({ kind: "venue_fills_differ", message: "our ledger and the venue's own fills differ for 2026-11-03 (UTC)" });
  await alerter({ kind: "venue_fills_differ", message: "our ledger and the venue's own fills differ for 2026-11-04 (UTC)" });
  assert.equal(calls.length, 18);
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
  const lastLegPath = join(dir, "lastleg-ledger.jsonl");
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = path;
  process.env.EVENT_LASTLEG_LEDGER_PATH = lastLegPath;
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_SLATES = "wiremarkets=Wire Markets:nfl,nba;sporttrade=Sporttrade:mlb";
  process.env.EVENT_SHADOW_SLATE_KEY = "share-key-1";
  const { server } = await import("../scripts/eventShadowWorker");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const op = { headers: { "x-admin-token": "op-secret" } };
  try {
    // operator views are gated: no token, wrong token -> 403; the public record is unaffected
    for (const p of ["/report", "/api/shadow/report", "/api/shadow/hedges", "/api/shadow/export", "/api/shadow/netting", "/venues", "/api/shadow/venues", "/api/shadow/venues.csv", "/api/shadow/venues/catalog"]) {
      assert.equal((await fetch(`${base}${p}`)).status, 403, `${p} without a token`);
      assert.equal((await fetch(`${base}${p}?token=wrong`)).status, 403, `${p} with the wrong token`);
    }
    // the venues CSV answers the operator with the header alone on an empty ledger; the catalog probe waits for the engine
    const venuesCsv = await fetch(`${base}/api/shadow/venues.csv`, op);
    assert.equal(venuesCsv.status, 200);
    assert.match(venuesCsv.headers.get("content-type") ?? "", /text\/csv/);
    assert.equal((await venuesCsv.text()).trim(), "ticker,league,event,side,event_time,status,read,read_at,hours_to_lock,venue,venue_id,via,state,credit_c,delta_c,ev_cost_bps,best_ask_c,depth_shares,age_sec,market_id,listing_key,snapshot_at,written");
    const catalog = await fetch(`${base}/api/shadow/venues/catalog?league=nba`, op);
    assert.equal(catalog.status, 503, "the engine (and its reference sources) is not loaded in this test: the route says so rather than guessing");
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
        flow: { windowDays: number; last30Days: Record<string, unknown>; allTime: { positions: number; contracts: number; hedgeNotionalCents: number; since: string } };
      };
    };
    assert.equal(api.summary.settledCount, 1);
    assert.equal(api.summary.floorSaves, 1);
    // the flow line: contracts protection put on public books, one total, no venue split
    assert.equal(api.summary.flow.windowDays, 30);
    assert.deepEqual(api.summary.flow.allTime, { positions: 1, contractsMilli: 133_500, contracts: 134, hedgeNotionalCents: 5426, stakeCents: 15_000, since: OPEN.at });
    assert.deepEqual(Object.keys(api.summary.flow.last30Days).sort(), ["contracts", "contractsMilli", "hedgeNotionalCents", "positions", "since", "stakeCents"]);
    assert.ok(!JSON.stringify(api.summary.flow).includes("polymarket"), "no route inside the flow block");
    const flowPage = await (await fetch(`${base}/`)).text();
    assert.ok(flowPage.includes("<h2>Flow onto public books</h2>") && flowPage.includes("contracts since 2026-09-12"), "the public page carries the flow card");
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
    assert.ok(csvLines[0].endsWith(",ev_cost_bps,tier,closed_at_utc,close_mid_c,close_fill_c,close_fees_c,close_friction_c"));
    assert.ok(!csvLines[0].includes("wide_floor_c") && !csvLines[0].includes("x20_refused"));
    assert.ok(csvLines[1].startsWith(`${OPEN.ticker},`));
    const publicAsksFull = await fetch(`${base}/api/shadow/positions.csv?scope=full`);
    assert.ok(!(await publicAsksFull.text()).includes("wide_floor_c"), "scope=full without the token is the public CSV");
    const fullCsv = await fetch(`${base}/api/shadow/positions.csv?scope=full&token=op-secret`);
    assert.match(fullCsv.headers.get("content-disposition") ?? "", /event-shadow-positions-full-/);
    const fullHeader = (await fullCsv.text()).split("\n")[0];
    assert.ok(fullHeader.includes("wide_floor_c") && fullHeader.includes("x20_refused") && fullHeader.includes("min_25bps_take_c"));

    // the public page: outcomes and the live book's receipts; no operator links, no mention of the rule comparison
    const page = await (await fetch(`${base}/`)).text();
    assert.ok(page.includes('href="/api/shadow/positions.csv"'), "the spreadsheet form");
    assert.ok(page.includes("our P&amp;L, settled") && !page.includes("writer P&amp;L"));
    assert.ok(page.includes("Track record") && !page.includes("Shadow record"));
    assert.ok(!page.includes('href="/report"') && !page.includes('href="/api/shadow/export"') && !page.includes('href="/api/shadow/hedges"'));
    assert.ok(!page.includes("What each rule would have done") && !page.includes("How the hedge leg is filled"));
    assert.ok(!page.includes("rule comparison") && !page.includes("report on request"), "operator note, not a public card");
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
    assert.ok(reportHtml.includes("Netting, measured") && reportHtml.includes("No game has both sides on the record yet"), "the netting card, empty");

    assert.ok(reportHtml.includes('href="/api/shadow/export"'), "operator links carry no token: the sign-in opens them");
    assert.ok(reportHtml.includes('href="/api/shadow/positions.csv?scope=full&amp;as=operator"'));
    assert.ok(!reportHtml.includes("op-secret"));

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
    assert.equal((h.hedge as { live: unknown }).live, null, "book mode: no live rails");
    // no EVENT_SHADOW_LOCK_KEY: the lock routes do not exist for a visitor; the operator reaches them (engine not wired here)
    const lockView = (health as { lock: { enabled: boolean; reservedTickers: string[]; positions: number; ledger: { exists: boolean } } }).lock;
    assert.equal(lockView.enabled, false);
    assert.deepEqual(lockView.reservedTickers, []);
    assert.equal(lockView.positions, 0);
    assert.equal(lockView.ledger.exists, false, "no lock yet, no lock ledger");
    assert.equal((await fetch(`${base}/api/shadow/lock`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${base}/api/shadow/markets`)).status, 404);
    assert.equal((await fetch(`${base}/api/shadow/markets`, { headers: { "x-lock-key": "anything-at-all-here" } })).status, 404);
    assert.equal((await fetch(`${base}/api/shadow/markets`, op)).status, 503);
    // the live pre-flight is an operator view; in book mode it says so and places nothing
    assert.equal((await fetch(`${base}/api/shadow/hedges/preflight`)).status, 403);
    const preflight = (await (await fetch(`${base}/api/shadow/hedges/preflight?ticker=kxnba-x`, op)).json()) as {
      ok: boolean;
      strategy: string;
      live: unknown;
      sentTodayContracts: number;
      venue: { ok: boolean; error?: string };
      ticker: { ticker: string; allowlisted: boolean; onRecord: boolean; wouldSend: boolean; contracts: number; kalshiRoute: unknown } | null;
    };
    assert.equal(preflight.ok, true);
    assert.equal(preflight.strategy, "book");
    assert.equal(preflight.live, null);
    assert.equal(preflight.sentTodayContracts, 0);
    assert.deepEqual(preflight.venue, { ok: false, error: "not in live mode" });
    // no engine wired in this test: the Kalshi-route quote says so instead of guessing
    assert.deepEqual(preflight.ticker, {
      ticker: "KXNBA-X",
      allowlisted: false,
      onRecord: false,
      wouldSend: false,
      contracts: 20,
      kalshiRoute: { offered: false, code: "engine_not_ready", detail: "the scanner is still loading" },
    });

    // VENUE SLATES: a prospect's name renders only on a link we sent. No key, wrong key, unknown
    // slate: the same 404 as any unknown path. The share key or the operator token opens it.
    for (const p of ["/slate/wiremarkets", "/slate/wiremarkets?k=wrong", "/slate/wiremarkets.csv", "/slate/kalshi?k=share-key-1", "/slate/Wire%20Markets?k=share-key-1"]) {
      assert.equal((await fetch(`${base}${p}`)).status, 404, `${p}`);
    }
    const slatePage = await fetch(`${base}/slate/wiremarkets?k=share-key-1`);
    assert.equal(slatePage.status, 200);
    assert.match(slatePage.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(slatePage.headers.get("x-robots-tag"), "noindex, nofollow");
    const slateHtml = await slatePage.text();
    assert.ok(slateHtml.includes("Lock in on the Wire Markets slate"));
    assert.ok(slateHtml.includes("Hedged leg for leg on the best of 4 venues."), "a share link says how many venues compete tonight");
    assert.ok(!/Kalshi|Polymarket|ProphetX|Novig/.test(slateHtml), "and names none of them");
    assert.ok(slateHtml.includes("What one Lock in button would have done"), "the bettor's verb");
    assert.ok(slateHtml.includes('<div class="n green">1</div><div class="l">games settled</div>'), "the NFL position is on the slate");
    assert.ok(slateHtml.includes("Kansas City Chiefs"));
    assert.ok(slateHtml.includes('href="/slate/wiremarkets.csv?k=share-key-1"'), "the CSV link carries the share key, not the operator token");
    assert.ok(slateHtml.includes("?brand=Wire%20Markets"), "the demo link opens in the venue's brand");
    assert.ok(!slateHtml.includes("op-secret"));
    const opSlate = await fetch(`${base}/slate/wiremarkets`, op);
    assert.equal(opSlate.status, 200, "the operator token opens any slate");
    assert.ok((await opSlate.text()).includes("Hedged leg for leg on Polymarket, Kalshi, ProphetX and Novig."), "the operator reads the names, the one this record used first");
    const { slateLinkKey } = await import("../src/eventCollar/crossVenue/venueSlate");
    const wmLink = slateLinkKey("share-key-1", "wiremarkets");
    assert.equal((await fetch(`${base}/slate/wiremarkets?k=${wmLink}`)).status, 200, "the slate's derived link key (what the branded demo carries) opens it");
    assert.equal((await fetch(`${base}/slate/sporttrade?k=${wmLink}`)).status, 404, "and opens no other slate");
    const linkedHtml = await (await fetch(`${base}/slate/wiremarkets?k=${wmLink}`)).text();
    assert.ok(linkedHtml.includes(`href="/slate/wiremarkets.csv?k=${wmLink}"`), "the CSV link carries the key the visitor arrived with");
    const otherSlate = await (await fetch(`${base}/slate/sporttrade?k=share-key-1`)).text();
    assert.ok(otherSlate.includes("Lock in on the Sporttrade slate") && otherSlate.includes("no positions on these leagues yet"), "an MLB-only slate has none of this record");
    const slateCsv = await fetch(`${base}/slate/wiremarkets.csv?k=share-key-1`);
    assert.equal(slateCsv.status, 200);
    assert.match(slateCsv.headers.get("content-disposition") ?? "", /wiremarkets-slate-\d{4}-\d{2}-\d{2}\.csv/);
    const slateCsvLines = (await slateCsv.text()).trimEnd().split("\n");
    assert.equal(slateCsvLines.length, 2);
    assert.ok(slateCsvLines[0].startsWith("ticker,league,kind,") && !slateCsvLines[0].includes("wide_floor_c"), "public columns only");
    assert.ok(slateCsvLines[1].startsWith(`${OPEN.ticker},`));
    assert.equal(((await (await fetch(`${base}/slate/sporttrade.csv?k=share-key-1`)).text()).trimEnd().split("\n")).length, 1, "header only off the slate");
    const healthSlates = (health as { slates: { keyConfigured: boolean; configured: Array<{ slug: string; shareUrl: string | null; demoUrl: string }> } }).slates;
    assert.equal(healthSlates.keyConfigured, true);
    assert.deepEqual(healthSlates.configured.map((s) => s.slug), ["wiremarkets", "sporttrade"]);
    // the operator body carries the link to send per slate: the slate on its own derived key, the demo in the brand
    assert.equal(healthSlates.configured[0].shareUrl, `https://atticus-event-shadow.onrender.com/slate/wiremarkets?k=${wmLink}`);
    assert.equal(healthSlates.configured[1].shareUrl, `https://atticus-event-shadow.onrender.com/slate/sporttrade?k=${slateLinkKey("share-key-1", "sporttrade")}`);
    assert.equal(healthSlates.configured[0].demoUrl, "https://atticus-event-demo-cross-venue.onrender.com/?brand=Wire%20Markets");
    assert.equal("slates" in publicHealth, false, "the public health body does not list prospects");

    // PARLAYS, PUBLIC: the last-leg tickets in retail shape for the demo's Parlays tab, and the
    // lock-sell-hold card on the record. The raw tickets stay behind the operator token.
    const emptyParlays = (await (await fetch(`${base}/api/shadow/parlays`)).json()) as { ok: boolean; tickets: unknown[]; summary: { tickets: number } };
    assert.equal(emptyParlays.ok, true);
    assert.deepEqual(emptyParlays.tickets, []);
    const ll = await import("../src/eventCollar/crossVenue/lastLeg");
    const legs = [
      { conditionId: "A", slug: "nfl-a", title: "A game", league: "nfl", side: 0 as const, outcome: "Away", priceMilli: 700, yesTokenId: "A-t0", noTokenId: "A-t1", gameStartIso: "2026-10-10T13:00:00.000Z" },
      { conditionId: "D", slug: "nfl-d", title: "D game", league: "nfl", side: 0 as const, outcome: "Away", priceMilli: 600, yesTokenId: "D-t0", noTokenId: "D-t1", gameStartIso: "2026-10-11T20:00:00.000Z" },
    ];
    const price = ll.comboPriceMilli(legs.map((l) => l.priceMilli));
    ll.appendLastLegRecord(lastLegPath, { type: "ticket", at: "2026-10-09T12:00:00.000Z", ticketId: "ll_pub", stakeCents: 2_000, legs, comboPriceMilli: price, sharesMilli: ll.sharesFor(2_000, price) });
    ll.appendLastLegRecord(lastLegPath, { type: "leg", at: "2026-10-10T16:00:00.000Z", ticketId: "ll_pub", conditionId: "A", valueMilli: 1000 });
    const parlays = await fetch(`${base}/api/shadow/parlays`);
    assert.equal(parlays.status, 200);
    assert.equal(parlays.headers.get("access-control-allow-origin"), "*");
    const parlayBody = (await parlays.json()) as {
      ok: boolean;
      enabled: boolean;
      stakeCents: number;
      pricedEveryMinutes: number;
      summary: { tickets: number; atLastPick: number };
      tickets: Array<{ id: string; state: string; picksOpen: number; picks: Array<{ state: string }>; lock: unknown; lockRefused: unknown }>;
    };
    assert.equal(parlayBody.ok, true);
    assert.equal(parlayBody.enabled, true);
    assert.equal(parlayBody.stakeCents, 2_000);
    assert.equal(parlayBody.pricedEveryMinutes, 10);
    assert.equal(parlayBody.summary.tickets, 1);
    assert.equal(parlayBody.summary.atLastPick, 1);
    assert.equal(parlayBody.tickets.length, 1);
    assert.equal(parlayBody.tickets[0].id, "ll_pub");
    assert.equal(parlayBody.tickets[0].state, "last_pick");
    assert.equal(parlayBody.tickets[0].picksOpen, 1);
    assert.deepEqual(parlayBody.tickets[0].picks.map((p) => p.state), ["hit", "open"]);
    assert.equal(parlayBody.tickets[0].lock, null, "no moment priced yet");
    assert.equal(parlayBody.tickets[0].lockRefused, null);
    assert.deepEqual(forbiddenKeysIn(parlayBody), [], "no hedge legs, token ids or take in the public body");
    assert.ok(!JSON.stringify(parlayBody).includes("D-t1"), "the hedge token never leaves the operator view");
    const recordWithParlays = await (await fetch(`${base}/`)).text();
    assert.ok(recordWithParlays.includes("Lock, sell or hold: the parlay moment"), "the record carries the parlay card");
    assert.ok(recordWithParlays.includes('<div class="n">1</div><div class="l">tickets built</div>'));
    assert.ok(recordWithParlays.includes('href="/api/shadow/parlays"'));
    assert.ok(!recordWithParlays.includes('href="/api/shadow/lastleg"'), "the raw tickets stay an operator link");
    assert.equal((await fetch(`${base}/api/shadow/lastleg`)).status, 403, "still gated");

    // FRESH START: operator only; archive, never delete. The old window stays on disk beside the new empty book.
    assert.equal((await fetch(`${base}/api/shadow/reset`, { method: "POST" })).status, 403, "reset is an operator action");
    assert.equal((await fetch(`${base}/api/shadow/reset?token=op-secret`)).status, 405, "a bare GET does nothing");
    const reset = await fetch(`${base}/api/shadow/reset?token=op-secret`, { method: "POST" });
    assert.equal(reset.status, 200);
    const resetBody = (await reset.json()) as { ok: boolean; archived: Array<{ from: string; to: string }> };
    assert.equal(resetBody.ok, true);
    assert.equal(resetBody.archived.length, 2, "the positions ledger and the last-leg ledger were archived; there were no hedge receipts to archive");
    const archivedLedger = resetBody.archived.find((a) => a.from === path);
    assert.ok(archivedLedger);
    assert.match(archivedLedger.to, /ledger\.\d{4}-\d{2}-\d{2}T\d{6}Z\.archived\.jsonl$/);
    assert.equal(readFileSync(archivedLedger.to, "utf8"), raw, "the archive is the old ledger byte for byte");
    assert.ok(resetBody.archived.some((a) => a.from === lastLegPath), "the parlay tickets start over with the book");
    assert.deepEqual(((await (await fetch(`${base}/api/shadow/parlays`)).json()) as { tickets: unknown[] }).tickets, []);
    assert.equal(existsSync(path), false, "and the live path is empty until the next scan");
    assert.equal(((await (await fetch(`${base}/healthz`)).json()) as { positions: number }).positions, 0);
    assert.equal(((await (await fetch(`${base}/api/shadow`)).json()) as { summary: { settledCount: number } }).summary.settledCount, 0, "the public record starts over");
    assert.equal((await fetch(`${base}/api/shadow/reset?token=op-secret&confirm=reset`)).status, 200, "GET with confirm=reset works from a browser");
    assert.equal(((await (await fetch(`${base}/api/shadow/reset?token=op-secret&confirm=reset`)).json()) as { archived: unknown[] }).archived.length, 0, "nothing to archive twice");

    // NETTING: on the fresh book, both sides of one game open; the operator sees the pair, the record does not change.
    // The open carries a counterfactual block and a hedge token id, which the public JSON must not repeat.
    appendShadowRecord(path, OPEN);
    appendShadowRecord(path, {
      ...OPEN,
      at: "2026-09-12T16:20:00.000Z",
      ticker: "KXNFLGAME-TEST-LAC",
      sideName: "Los Angeles Chargers",
      markCents: 40,
      floorCents: 32,
      capCents: 43,
      creditCents: 430,
      takeCents: 110,
      hedgeUnitsMilli: 133_500,
      hedgeTokenId: "0xpm-token",
      counterfactuals: { alternatives: {}, feeRules: {}, sizeLadder: [] } as never,
      bookOrigins: { polymarket: "aggregator", kalshi: "aggregator" },
    });
    const netting = (await (await fetch(`${base}/api/shadow/netting`, op)).json()) as {
      ok: boolean;
      summary: { pairs: number; singles: number; savingCents: number; legForLegCents: number; nettedCents: number; identityHolds: boolean; takeOnPairsCents: number };
      pairs: Array<{ eventKey: string; sides: Array<{ sideName: string }>; savingCents: number; identity: { holds: boolean; ifFirstWinsCents: number; ifSecondWinsCents: number } }>;
    };
    assert.equal(netting.ok, true);
    assert.equal(netting.summary.pairs, 1);
    assert.equal(netting.summary.singles, 0);
    assert.equal(netting.pairs[0].eventKey, "KXNFLGAME-TEST");
    assert.deepEqual(netting.pairs[0].sides.map((s) => s.sideName), ["Kansas City Chiefs", "Los Angeles Chargers"]);
    // Chiefs: funding 5550, cost 5426 over 133,500 milli (40.6¢); Chargers: funding 8550, cost 8010 over 133,500 (60.0¢).
    // Both hedges 133,500 milli: all matched, no residual. Leg for leg 13,436¢; reserve 13,350¢; saving 86¢ on 122¢ of take.
    assert.equal(netting.summary.legForLegCents, 5426 + 8010);
    assert.equal(netting.summary.nettedCents, 13_350);
    assert.equal(netting.summary.savingCents, 86);
    assert.equal(netting.summary.takeOnPairsCents, 122);
    assert.equal(netting.summary.identityHolds, true);
    assert.equal(netting.pairs[0].identity.ifFirstWinsCents, netting.pairs[0].identity.ifSecondWinsCents, "our result on the pair does not depend on who won");
    const reportWithPair = await (await fetch(`${base}/report?token=op-secret`)).text();
    assert.ok(reportWithPair.includes("1 games have both sides on the record") && reportWithPair.includes("Kansas City Chiefs 40.6¢"));
    assert.ok(reportWithPair.includes('href="/api/shadow/netting"') && !reportWithPair.includes("op-secret"));

    // the record: no netting anywhere public, and no counterfactuals or venue token ids on the public positions
    const publicPage = await (await fetch(`${base}/`)).text();
    assert.ok(!publicPage.includes("Netting, measured") && !publicPage.includes("/api/shadow/netting") && !publicPage.includes("both sides on the record"), "the public page does not mention netting");
    const publicJson = (await (await fetch(`${base}/api/shadow`)).json()) as { open: Array<Record<string, unknown>>; settled: Array<Record<string, unknown>> };
    const publicText = JSON.stringify(publicJson);
    assert.ok(!publicText.includes("netting") && !publicText.includes("nettedUnits"));
    assert.ok(!publicText.includes("0xpm-token") && !publicText.includes('"counterfactuals":{"alternatives"'), "the public JSON strips the operator fields");
    const chargers = publicJson.open.find((p) => p.ticker === "KXNFLGAME-TEST-LAC");
    assert.ok(chargers);
    assert.ok(!("counterfactuals" in chargers) && !("hedgeTokenId" in chargers) && !("bookOrigins" in chargers), "where the books were read from is the operator's");
    assert.ok(!publicText.includes("aggregator"));
    assert.equal(chargers.hedgeUnitsMilli, 133_500, "the hedge leg itself stays public: the identity is checkable from it");
    assert.ok(!(await (await fetch(`${base}/api/shadow/positions.csv`)).text()).includes("0xpm-token"));
    const fullExport = await (await fetch(`${base}/api/shadow/export`, op)).text();
    assert.ok(fullExport.includes("0xpm-token"), "the operator's raw ledger has everything");
  } finally {
    delete process.env.EVENT_X_ADMIN_TOKEN;
    await new Promise<void>((r) => server.close(() => r()));
  }
});
