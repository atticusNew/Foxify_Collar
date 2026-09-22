#!/usr/bin/env tsx
/**
 * EARN & PROTECT — EVENT SHADOW RUN (track-record service)
 *
 * Runs the same protection router as the public demo, continuously, and turns
 * it into an auditable history:
 *   - every SCAN interval, every quotable board row becomes one simulated
 *     position (one per market, ever; first priced quote wins),
 *   - every SETTLE interval, positions whose events have passed are marked
 *     against the official Kalshi result (floor or cap plus credit, versus
 *     the naked payout),
 *   - the append-only JSONL ledger is replayed on every page view; nothing
 *     is ever edited in place.
 *
 * What is real: venue prices, quoted terms, official results.
 * What is simulated: the positions. No venue credentials, no wallets; this
 * service is structurally unable to trade, deposit, or pay.
 *
 * ISOLATION: imports the demo's scanner with EVENT_X_EMBED=1 (no second demo
 * server starts). Nothing here touches the production Earn & Protect deploy.
 *
 * Run: npx tsx services/api/scripts/eventShadowWorker.ts
 * Env: EVENT_SHADOW_PORT (default 8793) · EVENT_SHADOW_LEDGER_PATH
 *      EVENT_SHADOW_SCAN_MS (default 5m) · EVENT_SHADOW_SETTLE_MS (default 10m)
 *      EVENT_SHADOW_SETTLE_GRACE_MS (default 3h) · EVENT_SHADOW_VOID_AFTER_MS (default 72h)
 *      EVENT_SHADOW_CRYPTO_SHARE_MAX (default 0.5) · EVENT_SHADOW_CRYPTO_FLOOR_PER_DAY (default 4)
 *      plus the demo's EVENT_X_* scanner knobs (contracts, board rows, series)
 * Alerts (optional, see crossVenue/shadowAlerts.ts): EVENT_SHADOW_ALERT_BOT_TOKEN +
 *      EVENT_SHADOW_ALERT_CHAT_ID (Telegram) and/or EVENT_SHADOW_ALERT_WEBHOOK_URL
 *
 * Durability: the ledger lives on one Render disk. GET /api/shadow/export streams
 * the raw JSONL so it can be mirrored off-box on a schedule
 * (`curl -s -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" https://<service>/api/shadow/export > backup-$(date +%F).jsonl`).
 *
 * GET /healthz is public liveness only (ok, service, positions, last scan/settle).
 * Ledger and receipt paths, hedge strategy and venues, error text and failure
 * counters come back on the same route with the operator token.
 */

import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import {
  appendShadowRecord,
  ledgerStats,
  loadShadowPositions,
  positionsCsv,
  summarizeShadow,
  type ShadowPosition,
  type ShadowSummary,
} from "../src/eventCollar/crossVenue/shadowLedger";
import {
  buildShadowAlerter,
  evaluateShadowHealth,
  parseShadowAlertsFromEnv,
  type ShadowAlerter,
} from "../src/eventCollar/crossVenue/shadowAlerts";
import {
  counterfactualsFor,
  type ShadowCounterfactuals,
} from "../src/eventCollar/crossVenue/shadowCounterfactuals";
import {
  DEFAULT_CROSS_CONFIG,
  type CrossSearchConfig,
  type HedgeLeg,
  type PmBook,
} from "../src/eventCollar/crossVenue/types";
import type { NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { getMarketResult } from "../src/eventCollar/kalshiPublic";
import { TIER_RULES } from "../src/eventCollar/crossVenue/collarSearch";
import { adminAuthorized, parseAdminAuthFromEnv } from "../src/eventCollar/crossVenue/eventFunnel";
import {
  appendHedgeReceipt,
  intentFromHedge,
  loadHedgeReceipts,
  summarizeHedgeReceipts,
} from "../src/eventCollar/crossVenue/hedgeExecutor";
import { hedgeExecutorFromEnv } from "../src/eventCollar/crossVenue/hedgeExecutorFromEnv";
import { FEE_RULE_TEXT, renderShadowHtml, renderShadowReportHtml } from "./eventShadowHtml";
import { archiveLedgerFile } from "../src/eventCollar/crossVenue/ledgerArchive";
import { cryptoOpenAllowed, openMixRuleFromEnv } from "../src/eventCollar/crossVenue/openMix";
import type { ScanState } from "./eventProtectXDemoService";

const PORT = Number(process.env.EVENT_SHADOW_PORT || process.env.PORT || 8793);
const LEDGER_PATH = process.env.EVENT_SHADOW_LEDGER_PATH || "/tmp/event-demo/shadow-ledger.jsonl";
const SCAN_MS = Number(process.env.EVENT_SHADOW_SCAN_MS || 5 * 60_000);
const SETTLE_MS = Number(process.env.EVENT_SHADOW_SETTLE_MS || 10 * 60_000);
/** wait this long past the event time before asking for a result (games run long) */
const SETTLE_GRACE_MS = Number(process.env.EVENT_SHADOW_SETTLE_GRACE_MS || 3 * 3_600_000);
/** an event with no official result after this long is voided (postponed, rebooked) */
const VOID_AFTER_MS = Number(process.env.EVENT_SHADOW_VOID_AFTER_MS || 72 * 3_600_000);

/** one line per hedge: which strategy filled it, at what, and why the other did not */
const RECEIPTS_PATH = process.env.EVENT_HEDGE_RECEIPTS_PATH || join(dirname(LEDGER_PATH), "hedge-receipts.jsonl");
const hedgeChoice = hedgeExecutorFromEnv(process.env);
/**
 * Operator views (rule comparison, hedge receipts, raw ledger, full CSV) are
 * gated: they are what we are learning, not what was quoted. Same token as the
 * demo's /admin/funnel; fail-closed when unset so the public record is all
 * that is ever public by default.
 */
const adminAuth = parseAdminAuthFromEnv(process.env);
/** crypto strikes roll over hourly; without a ceiling they crowd the games out of the record */
const openMix = openMixRuleFromEnv(process.env);
let cryptoSkippedLastScan = 0;
const OPERATOR_PATHS = new Set(["/report", "/api/shadow/report", "/api/shadow/hedges", "/api/shadow/export", "/api/shadow/reset"]);

const alertCfg = parseShadowAlertsFromEnv(process.env);
const alerter: ShadowAlerter = buildShadowAlerter(alertCfg);
const BOOT_MS = Date.now();

let scan: (() => Promise<ScanState>) | null = null;
let searchConfig: () => CrossSearchConfig = () => DEFAULT_CROSS_CONFIG;
let lastScanAt: string | null = null;
let lastScanOkMs: number | null = null;
let lastSettleAt: string | null = null;
let lastScanError: string | null = null;
let lastSettleError: string | null = null;
let consecutiveScanFailures = 0;
let scanFailingRaised = false;
let settleFailuresLastTick = 0;
let settleDueLastTick = 0;

/** Append with the failure surfaced: a ledger that cannot be written is the one fault that must page. */
function appendOrAlert(record: Parameters<typeof appendShadowRecord>[1]): boolean {
  try {
    appendShadowRecord(LEDGER_PATH, record);
    return true;
  } catch (err) {
    void alerter({
      kind: "ledger_write_failed",
      message: `could not append ${record.type} for ${record.ticker} to ${LEDGER_PATH}: ${String(err instanceof Error ? err.message : err)}`,
    });
    return false;
  }
}

/**
 * Fill the hedge leg through the configured executor and keep the receipt.
 * The position is already on the ledger; a hedge failure is recorded, never
 * allowed to lose the record or stop the scan.
 */
async function fillHedge(ticker: string, hedge: HedgeLeg, books: { pmNoBook?: PmBook; noAsks?: NoAskLevel[] }): Promise<void> {
  try {
    const best =
      hedge.venue === "kalshi"
        ? books.noAsks?.[0]
          ? books.noAsks[0].priceCents * 10
          : hedge.avgPriceCents * 10
        : books.pmNoBook?.asks[0]?.priceMilli ?? hedge.avgPriceMilli;
    const receipt = await hedgeChoice.executor.execute(intentFromHedge(hedge, best), ticker);
    appendHedgeReceipt(RECEIPTS_PATH, receipt);
  } catch (err) {
    lastScanError = `hedge for ${ticker}: ${String(err instanceof Error ? err.message : err)}`;
  }
}

/** Open one simulated position for every quotable board row we have not seen. */
async function scanTick(): Promise<void> {
  if (!scan) return;
  try {
    const state = await scan();
    const book = loadShadowPositions(LEDGER_PATH);
    const seen = new Set(book.map((p) => p.ticker));
    const opened: Array<{ kind: "sports" | "crypto"; at: string }> = book.map((p) => ({ kind: p.kind, at: p.at }));
    let cryptoSkipped = 0;
    for (const { res, evBps } of state.rows) {
      const q = res.quote;
      if (!q.ok || seen.has(res.market.ticker)) continue;
      if (res.kind === "crypto" && !cryptoOpenAllowed(opened, Date.now(), openMix).allowed) {
        // Quotable, just enough of its kind in the window; not a refusal, not recorded.
        cryptoSkipped += 1;
        continue;
      }
      const route = res.route ?? "kalshi_self";
      // Same books, same instant: what every other rule would have written.
      let counterfactuals: ShadowCounterfactuals | undefined;
      try {
        counterfactuals = counterfactualsFor(
          {
            route,
            ticker: res.market.ticker,
            lockTimeIso: res.eventTimeIso,
            pair: res.pair,
            markCents: res.markCents,
            entryCents: res.position.entryCents,
            contracts: q.contracts,
            now: new Date(state.atIso),
            config: searchConfig(),
            books: res.books,
          },
          q,
        );
      } catch (err) {
        // The live record must never be lost to a counterfactual failure.
        lastScanError = `counterfactuals for ${res.market.ticker}: ${String(err instanceof Error ? err.message : err)}`;
      }
      appendOrAlert({
        type: "open",
        at: new Date().toISOString(),
        ticker: res.market.ticker,
        kind: res.kind,
        league: res.league,
        sideName: res.sideName,
        eventTitle: res.eventTitle,
        eventTimeIso: res.eventTimeIso,
        contracts: q.contracts,
        markCents: res.markCents,
        floorCents: q.floorCents,
        capCents: q.capCents,
        creditCents: q.creditCents,
        evCostBps: evBps,
        route,
        feesCents: q.feesCents,
        takeCents: q.takeCents,
        hedgeCostCents: q.hedge.costCents + q.feesCents,
        hedgeUnitsMilli: "sharesMilli" in q.hedge ? q.hedge.sharesMilli : q.hedge.contractsMilli,
        tier: q.tier,
        takeRule: q.takeRule,
        takeShareCents: q.takeShareCents,
        takeMinimumCents: q.takeMinimumCents,
        ...(counterfactuals ? { counterfactuals } : {}),
      });
      seen.add(res.market.ticker);
      opened.push({ kind: res.kind, at: new Date().toISOString() });
      await fillHedge(res.market.ticker, q.hedge, res.books);
    }
    cryptoSkippedLastScan = cryptoSkipped;
    lastScanAt = new Date().toISOString();
    lastScanOkMs = Date.now();
    lastScanError = null;
    consecutiveScanFailures = 0;
  } catch (err) {
    // a failed scan skips one tick; the next one retries from scratch
    lastScanError = String(err instanceof Error ? err.message : err);
    consecutiveScanFailures += 1;
  }
  await healthTick();
}

/** Mark past events against their official results; void the unresolvable. */
async function settleTick(): Promise<void> {
  const now = Date.now();
  let due = 0;
  let failed = 0;
  for (const p of loadShadowPositions(LEDGER_PATH)) {
    if (p.status !== "open") continue;
    const eventMs = Date.parse(p.eventTimeIso);
    if (!Number.isFinite(eventMs) || now < eventMs + SETTLE_GRACE_MS) continue;
    due += 1;
    try {
      const r = await getMarketResult(p.ticker);
      if (r.result === "yes" || r.result === "no") {
        appendOrAlert({
          type: "settle",
          at: new Date().toISOString(),
          ticker: p.ticker,
          result: r.result,
        });
      } else if (now > eventMs + VOID_AFTER_MS) {
        const reason = `no official result ${Math.round(VOID_AFTER_MS / 3_600_000)}h after the event`;
        if (appendOrAlert({ type: "void", at: new Date().toISOString(), ticker: p.ticker, reason })) {
          // A void is rare and worth a human look (postponement, ticker change, result feed gap).
          void alerter({ kind: "position_voided", message: `${p.ticker} (${p.eventTitle}) voided: ${reason}` });
        }
      }
    } catch (err) {
      // venue unreachable for this ticker; retried next tick
      failed += 1;
      lastSettleError = String(err instanceof Error ? err.message : err);
    }
  }
  if (failed === 0) lastSettleError = null;
  settleDueLastTick = due;
  settleFailuresLastTick = failed;
  lastSettleAt = new Date().toISOString();
  await healthTick();
}

/** Evaluate the counters against the alert thresholds; runs after every tick. */
async function healthTick(): Promise<void> {
  const alerts = evaluateShadowHealth(
    {
      nowMs: Date.now(),
      scanMs: SCAN_MS,
      lastScanOkMs,
      bootMs: BOOT_MS,
      consecutiveScanFailures,
      lastScanError,
      settleFailuresLastTick,
      settleDueLastTick,
      scanFailingRaised,
    },
    alertCfg,
  );
  for (const a of alerts) {
    if (a.kind === "scan_failing") scanFailingRaised = true;
    if (a.kind === "scan_recovered") scanFailingRaised = false;
    await alerter(a);
  }
}

/**
 * The public liveness body: is it up, is it scanning, how many positions. Paths on disk, hedge
 * strategy and venues, error text and failure counters are operator information (healthBody).
 */
function publicHealthBody(): Record<string, unknown> {
  return {
    ok: true,
    service: "event-protect-shadow",
    positions: loadShadowPositions(LEDGER_PATH).length,
    lastScanAt,
    lastSettleAt,
  };
}

function healthBody(): Record<string, unknown> {
  const stats = ledgerStats(LEDGER_PATH);
  return {
    ok: true,
    service: "event-protect-shadow",
    positions: loadShadowPositions(LEDGER_PATH).length,
    ledger: { path: LEDGER_PATH, ...stats },
    lastScanAt,
    lastSettleAt,
    lastScanError,
    lastSettleError,
    consecutiveScanFailures,
    settleFailuresLastTick,
    settleDueLastTick,
    openMix: { ...openMix, cryptoSkippedLastScan },
    alertsConfigured: Boolean((alertCfg.telegramBotToken && alertCfg.telegramChatId) || alertCfg.webhookUrl),
    hedge: {
      strategy: hedgeChoice.strategy,
      rfqVenues: hedgeChoice.rfqVenues,
      notes: hedgeChoice.notes,
      receipts: { path: RECEIPTS_PATH, ...ledgerStats(RECEIPTS_PATH) },
    },
  };
}

function pageData(): { atIso: string; positions: ShadowPosition[] } {
  return { atIso: new Date().toISOString(), positions: loadShadowPositions(LEDGER_PATH) };
}

/**
 * The public JSON carries the live book's outcomes. The rule books (what each
 * alternative would have done) stay with the operator; only their existence
 * is public.
 */
function publicSummary(s: ShadowSummary): Omit<ShadowSummary, "counterfactuals"> & {
  counterfactuals: { recordedSince: string | null; positionsWithCounterfactuals: number };
} {
  const { counterfactuals, ...rest } = s;
  return {
    ...rest,
    counterfactuals: {
      recordedSince: counterfactuals.recordedSince,
      positionsWithCounterfactuals: counterfactuals.positionsWithCounterfactuals,
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const operator = adminAuthorized(adminAuth, req.headers, url.searchParams.get("token"));
  try {
    if (OPERATOR_PATHS.has(url.pathname) && !operator) {
      sendJson(res, 403, {
        ok: false,
        error: adminAuth.enabled ? "bad admin token" : "operator views disabled — set EVENT_X_ADMIN_TOKEN",
      });
      return;
    }
    if (url.pathname === "/healthz") {
      sendJson(res, 200, operator ? healthBody() : publicHealthBody());
      return;
    }
    if (url.pathname === "/api/shadow/reset") {
      // FRESH START, ARCHIVE NOT DELETE: the ledger and the hedge receipts are renamed beside
      // themselves with a UTC stamp (still exportable, still append-only, now closed) and the next
      // scan opens a new book under the rules in force. Operator only; POST, or GET with confirm=reset.
      if (!(req.method === "POST" || (req.method === "GET" && url.searchParams.get("confirm") === "reset"))) {
        sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "POST /api/shadow/reset?token=… or GET …&confirm=reset" });
        return;
      }
      const atIso = new Date().toISOString();
      const archived = [archiveLedgerFile(LEDGER_PATH, atIso), archiveLedgerFile(RECEIPTS_PATH, atIso)]
        .filter((a) => a.archivedTo)
        .map((a) => ({ from: a.path, to: a.archivedTo }));
      if (scan) void scanTick();
      sendJson(res, 200, { ok: true, at: atIso, archived, message: "shadow ledger and hedge receipts archived; a fresh book opens with the next scan" });
      return;
    }
    if (url.pathname === "/api/shadow/export") {
      // The raw append-only ledger, byte for byte: the artifact to mirror off-box.
      const stats = ledgerStats(LEDGER_PATH);
      if (!stats.exists) {
        res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "content-length": 0, "cache-control": "no-store" });
        res.end();
        return;
      }
      const size = statSync(LEDGER_PATH).size;
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-length": size,
        "content-disposition": `attachment; filename="event-shadow-ledger-${new Date().toISOString().slice(0, 10)}.jsonl"`,
        "cache-control": "no-store",
      });
      createReadStream(LEDGER_PATH).pipe(res);
      return;
    }
    if (url.pathname === "/api/shadow/positions.csv") {
      // Spreadsheet form: one row per position, every leg in integer cents.
      // Public rows carry what was quoted and what settled; the operator's
      // ?scope=full adds the recorded fee rule and every counterfactual.
      const full = operator && url.searchParams.get("scope") === "full";
      const csv = positionsCsv(loadShadowPositions(LEDGER_PATH), full ? "full" : "public");
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="event-shadow-positions${full ? "-full" : ""}-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "no-store",
      });
      res.end(csv);
      return;
    }
    if (url.pathname === "/api/shadow") {
      const { atIso, positions } = pageData();
      const settled = positions
        .filter((p) => p.status === "settled")
        .sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
      const open = positions
        .filter((p) => p.status === "open")
        .sort((a, b) => a.eventTimeIso.localeCompare(b.eventTimeIso));
      sendJson(res, 200, { ok: true, at: atIso, summary: publicSummary(summarizeShadow(positions)), settled, open });
      return;
    }
    if (url.pathname === "/api/shadow/report") {
      // The rule comparison alone: what every proposed rule would have done on the same positions.
      const { atIso, positions } = pageData();
      const summary = summarizeShadow(positions);
      sendJson(res, 200, {
        ok: true,
        at: atIso,
        period: { recordedSince: summary.counterfactuals.recordedSince, renderedAt: atIso },
        rules: { tiers: TIER_RULES, feeRules: FEE_RULE_TEXT },
        counterfactuals: summary.counterfactuals,
      });
      return;
    }
    if (url.pathname === "/api/shadow/hedges") {
      // The hedge trail: how each hedge leg was filled, and what the RFQ path did or would have done.
      const receipts = loadHedgeReceipts(RECEIPTS_PATH);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)));
      sendJson(res, 200, {
        ok: true,
        at: new Date().toISOString(),
        strategy: hedgeChoice.strategy,
        rfqVenues: hedgeChoice.rfqVenues,
        notes: hedgeChoice.notes,
        summary: summarizeHedgeReceipts(receipts),
        recent: receipts.slice(-limit).reverse(),
      });
      return;
    }
    if (url.pathname === "/report") {
      const { atIso, positions } = pageData();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderShadowReportHtml({ atIso, summary: summarizeShadow(positions), token: url.searchParams.get("token") }));
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const { atIso, positions } = pageData();
      const settled = positions
        .filter((p) => p.status === "settled")
        .sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
      const open = positions
        .filter((p) => p.status === "open")
        .sort((a, b) => a.eventTimeIso.localeCompare(b.eventTimeIso));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(
        renderShadowHtml({
          atIso,
          summary: summarizeShadow(positions),
          open,
          settled,
          hedges: {
            strategy: hedgeChoice.strategy,
            rfqVenues: hedgeChoice.rfqVenues,
            summary: summarizeHedgeReceipts(loadHedgeReceipts(RECEIPTS_PATH)),
          },
        }),
      );
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) });
  }
});

async function main(): Promise<void> {
  // Import the scanner WITHOUT starting the demo's server. This must be set
  // before the dynamic import so the module-load listen guard sees it.
  process.env.EVENT_X_EMBED = "1";
  const demo = await import("./eventProtectXDemoService");
  scan = demo.buildScan;
  searchConfig = demo.searchConfig;
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[event-shadow] listening on :${PORT} · ledger ${LEDGER_PATH} · scan every ${Math.round(SCAN_MS / 60_000)}m · settle every ${Math.round(SETTLE_MS / 60_000)}m`,
    );
    void scanTick();
    void settleTick();
    setInterval(() => void scanTick(), SCAN_MS);
    setInterval(() => void settleTick(), SETTLE_MS);
  });
}

if (process.env.NODE_ENV !== "test") void main();

export { server, scanTick, settleTick };
