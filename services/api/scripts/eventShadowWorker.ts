#!/usr/bin/env tsx
/**
 * EARN & PROTECT — EVENT SHADOW RUN (track-record service)
 *
 * Runs the same protection router as the public demo, continuously, and turns
 * it into an auditable history:
 *   - every SCAN interval, every quotable board row becomes one simulated
 *     position (one per market, ever; first priced quote wins). The scan is
 *     told which markets the book already holds, so it walks past them and
 *     reaches every quotable game in the window over successive scans,
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
 *      Last-leg shadow (crossVenue/lastLeg.ts): EVENT_LASTLEG_ENABLED (default on) · EVENT_LASTLEG_TICK_MS (10m)
 *      · EVENT_LASTLEG_LEDGER_PATH · EVENT_LASTLEG_STAKE_CENTS · EVENT_LASTLEG_LEG_COUNTS · EVENT_LASTLEG_TICKETS_PER_SIZE
 *      · EVENT_LASTLEG_MAX_OPEN · EVENT_LASTLEG_MAX_PER_GAME (3: no game on more undecided tickets than this)
 *      · EVENT_LASTLEG_FAV_MIN_MILLI / _MAX_MILLI · EVENT_LASTLEG_MIN_GAP_MS · EVENT_LASTLEG_WINDOW_MS
 *      · EVENT_LASTLEG_LEAGUES · EVENT_LASTLEG_CATALOG_PAGES · EVENT_LASTLEG_VOID_AFTER_MS
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
  hedgeUnitsOf,
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
import { FEE_RULE_TEXT, renderShadowHtml, renderShadowReportHtml, renderSlateHtml } from "./eventShadowHtml";
import { archiveLedgerFile } from "../src/eventCollar/crossVenue/ledgerArchive";
import { cryptoOpenAllowed, openMixRuleFromEnv } from "../src/eventCollar/crossVenue/openMix";
import {
  earlyCloseRuleFromEnv,
  earlyCloseSchedule,
  getKalshiBookSides,
  quoteEarlyClose,
  type EarlyCloseBooks,
} from "../src/eventCollar/crossVenue/earlyClose";
import { getPmBook } from "../src/eventCollar/crossVenue/polymarketPublic";
import { getComboLegStatus, getComboMarkets } from "../src/eventCollar/crossVenue/polymarketCombos";
import {
  appendLastLegRecord,
  lastLegConfigFromEnv,
  lastLegCsv,
  loadLastLegTickets,
  lockVersusSell,
  runLastLegTick,
  summarizeLastLeg,
  type LastLegTickReport,
} from "../src/eventCollar/crossVenue/lastLeg";
import { retailParlays } from "../src/eventCollar/crossVenue/parlayRetail";
import { findVenueSlate, parseVenueSlates, slateAccessOk, slateLeaguesOnRecord, slatePositions } from "../src/eventCollar/crossVenue/venueSlate";
import type { ScanOptions, ScanState } from "./eventProtectXDemoService";

const PORT = Number(process.env.EVENT_SHADOW_PORT || process.env.PORT || 8793);
const LEDGER_PATH = process.env.EVENT_SHADOW_LEDGER_PATH || "/tmp/event-demo/shadow-ledger.jsonl";
const SCAN_MS = Number(process.env.EVENT_SHADOW_SCAN_MS || 5 * 60_000);
const SETTLE_MS = Number(process.env.EVENT_SHADOW_SETTLE_MS || 10 * 60_000);
/** wait this long past the event time before asking for a result (games run long) */
const SETTLE_GRACE_MS = Number(process.env.EVENT_SHADOW_SETTLE_GRACE_MS || 3 * 3_600_000);
/** an event with no official result after this long is voided (postponed, rebooked) */
const VOID_AFTER_MS = Number(process.env.EVENT_SHADOW_VOID_AFTER_MS || 72 * 3_600_000);
/**
 * EARLY CLOSES: a share of positions leave before the lock, priced as a new trade at the live
 * books that second (EVENT_SHADOW_EARLY_CLOSE_SHARE_PCT, default 20; 0 disables). The record then
 * shows what leaving early paid against holding, and what crossing the books cost against the mid.
 */
const CLOSE_MS = Number(process.env.EVENT_SHADOW_CLOSE_MS || 60_000);
const earlyCloseRule = earlyCloseRuleFromEnv(process.env);

/**
 * LAST-LEG SHADOW: representative parlay tickets built from Polymarket's public combo-leg catalog,
 * tracked leg by leg, and quoted for protection at the moment every leg but the last has hit
 * (lastLeg.ts). Its own append-only ledger beside the positions ledger. The raw tickets with their
 * hedge legs are operator views; the retail shape (/api/shadow/parlays) and the lock-sell-hold
 * card on the public record are public, and the demo's Parlays tab reads the former.
 */
const LASTLEG_PATH = process.env.EVENT_LASTLEG_LEDGER_PATH || join(dirname(LEDGER_PATH), "lastleg-ledger.jsonl");
const lastLegCfg = lastLegConfigFromEnv(process.env);
let lastLastLegAt: string | null = null;
let lastLastLegError: string | null = null;
let lastLastLegReport: LastLegTickReport | null = null;

/**
 * VENUE SLATES (crossVenue/venueSlate.ts): the record cut to one venue's leagues, with its name
 * on the page, at /slate/<slug> and /slate/<slug>.csv. Reached by the share key (?k=) or the
 * operator token; no key configured and no slate page opens. Nothing is read from the venue.
 */
const venueSlates = parseVenueSlates(process.env.EVENT_SHADOW_SLATES);
const SLATE_KEY = process.env.EVENT_SHADOW_SLATE_KEY;
/** the interactive demo, which renders in a venue's brand with ?brand= */
const DEMO_URL = (process.env.EVENT_SHADOW_DEMO_URL || "https://atticus-event-demo-cross-venue.onrender.com").replace(/\/+$/, "");
const RECORD_URL = (process.env.EVENT_SHADOW_PUBLIC_URL || "https://atticus-event-shadow.onrender.com").replace(/\/+$/, "");
/** the books the hedges are bought on, by public name, keyed by the record's route codes */
const HEDGE_VENUE_NAMES: Record<string, string> = { kalshi_self: "Kalshi", polymarket: "Polymarket" };

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
const OPERATOR_PATHS = new Set([
  "/report",
  "/api/shadow/report",
  "/api/shadow/hedges",
  "/api/shadow/export",
  "/api/shadow/reset",
  "/api/shadow/lastleg",
  "/api/shadow/lastleg.csv",
]);

const alertCfg = parseShadowAlertsFromEnv(process.env);
const alerter: ShadowAlerter = buildShadowAlerter(alertCfg);
const BOOT_MS = Date.now();

let scan: ((opts?: ScanOptions) => Promise<ScanState>) | null = null;
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
let lastCloseAt: string | null = null;
let lastCloseError: string | null = null;
let closeDueLastTick = 0;

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
    const book = loadShadowPositions(LEDGER_PATH);
    const seen = new Set(book.map((p) => p.ticker));
    // Step over what the book already holds so each scan reaches the next games in the ranking.
    const state = await scan({ skipTickers: seen });
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
        ...(q.hedge.venue === "polymarket" ? { hedgeTokenId: q.hedge.tokenId } : {}),
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

/**
 * Close the positions whose scheduled exit has come: both legs sold into the live bids that
 * second, recorded priced or unpriced. One attempt per position; an unpriced leg leaves the
 * position open to settle as usual, and the record counts the attempt.
 */
async function closeTick(): Promise<void> {
  const now = Date.now();
  let due = 0;
  let failed = 0;
  for (const p of loadShadowPositions(LEDGER_PATH)) {
    if (p.status !== "open" || p.closeUnpriced) continue;
    const sched = earlyCloseSchedule(p.ticker, p.at, p.eventTimeIso, earlyCloseRule);
    if (!sched.selected || sched.closeAtMs === null || now < sched.closeAtMs) continue;
    // Past the margin the pricers refuse anyway; a close that missed its window is not forced.
    if (now > Date.parse(p.eventTimeIso) - earlyCloseRule.marginMs) continue;
    due += 1;
    try {
      const books: EarlyCloseBooks = { kalshi: await getKalshiBookSides(p.ticker) };
      if (p.route === "polymarket" && p.hedgeTokenId) {
        try {
          books.pmNoBook = await getPmBook(p.hedgeTokenId);
        } catch {
          // the hedge venue unreachable: the pricer records the leg as unlocatable, honestly
        }
      }
      const q = quoteEarlyClose(
        {
          contracts: p.contracts,
          floorCents: p.floorCents,
          capCents: p.capCents,
          creditCents: p.creditCents,
          takeCents: p.takeCents,
          hedgeUnitsMilli: hedgeUnitsOf(p),
          route: p.route,
        },
        books,
      );
      const at = new Date().toISOString();
      if (!q.ok) {
        appendOrAlert({ type: "close", at, ticker: p.ticker, priced: false, reason: `${q.leg} leg: ${q.detail}` });
        continue;
      }
      appendOrAlert({
        type: "close",
        at,
        ticker: p.ticker,
        priced: true,
        yesMidCents: q.yesMidCents,
        yesFillCents: q.yesFillCents,
        positionProceedsCents: q.positionProceedsCents,
        hedgeProceedsCents: q.hedgeProceedsCents,
        feesCents: q.positionFeesCents + q.hedgeFeesCents,
        protectedAtCloseCents: q.protectedAtCloseCents,
        protectedAtMidCents: q.protectedAtMidCents,
        unwindFrictionCents: q.unwindFrictionCents,
      });
    } catch (err) {
      // venue unreachable; the schedule is still due next tick
      failed += 1;
      lastCloseError = String(err instanceof Error ? err.message : err);
    }
  }
  if (failed === 0) lastCloseError = null;
  closeDueLastTick = due;
  lastCloseAt = new Date().toISOString();
}

/** Resolve legs, quote the moment, build tickets: one pass of the last-leg shadow. */
async function lastLegTick(): Promise<void> {
  if (!lastLegCfg.enabled) return;
  try {
    lastLastLegReport = await runLastLegTick(
      {
        nowMs: () => Date.now(),
        catalog: () => getComboMarkets({ maxPages: lastLegCfg.catalogPages }),
        legStatus: (slug) => getComboLegStatus(slug),
        noBook: (tokenId) => getPmBook(tokenId),
        load: () => loadLastLegTickets(LASTLEG_PATH),
        append: (record) => appendLastLegRecord(LASTLEG_PATH, record),
      },
      lastLegCfg,
      searchConfig(),
    );
    lastLastLegError = lastLastLegReport.errors.length ? lastLastLegReport.errors[lastLastLegReport.errors.length - 1] : null;
  } catch (err) {
    lastLastLegError = String(err instanceof Error ? err.message : err);
  }
  lastLastLegAt = new Date().toISOString();
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
    earlyClose: { ...earlyCloseRule, everyMs: CLOSE_MS, lastCloseAt, lastCloseError, closeDueLastTick },
    openMix: { ...openMix, cryptoSkippedLastScan },
    lastLeg: {
      ...lastLegCfg,
      ledger: { path: LASTLEG_PATH, ...ledgerStats(LASTLEG_PATH) },
      lastTickAt: lastLastLegAt,
      lastError: lastLastLegError,
      lastReport: lastLastLegReport,
    },
    slates: { keyConfigured: Boolean((SLATE_KEY ?? "").trim()), configured: venueSlates.map((s) => ({ slug: s.slug, name: s.name, leagues: s.leagues })) },
    alertsConfigured: Boolean((alertCfg.telegramBotToken && alertCfg.telegramChatId) || alertCfg.webhookUrl),
    hedge: {
      strategy: hedgeChoice.strategy,
      rfqVenues: hedgeChoice.rfqVenues,
      polymarketBuilderCode: hedgeChoice.polymarketBuilderCode,
      notes: hedgeChoice.notes,
      receipts: { path: RECEIPTS_PATH, ...ledgerStats(RECEIPTS_PATH) },
    },
  };
}

function pageData(): { atIso: string; positions: ShadowPosition[] } {
  return { atIso: new Date().toISOString(), positions: loadShadowPositions(LEDGER_PATH) };
}

/** Settled most recent first, open next to lock first, closed most recent first. */
function splitPositions(positions: ShadowPosition[]): { settled: ShadowPosition[]; open: ShadowPosition[]; closed: ShadowPosition[] } {
  return {
    settled: positions.filter((p) => p.status === "settled").sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? "")),
    open: positions.filter((p) => p.status === "open").sort((a, b) => a.eventTimeIso.localeCompare(b.eventTimeIso)),
    closed: positions.filter((p) => p.status === "closed").sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? "")),
  };
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
      const archived = [archiveLedgerFile(LEDGER_PATH, atIso), archiveLedgerFile(RECEIPTS_PATH, atIso), archiveLedgerFile(LASTLEG_PATH, atIso)]
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
      const { settled, open, closed } = splitPositions(positions);
      sendJson(res, 200, { ok: true, at: atIso, summary: publicSummary(summarizeShadow(positions)), settled, open, closed });
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
    if (url.pathname === "/api/shadow/lastleg") {
      // The last-leg shadow: every ticket with its legs, moments and outcome, plus the summary.
      const tickets = loadLastLegTickets(LASTLEG_PATH);
      sendJson(res, 200, {
        ok: true,
        at: new Date().toISOString(),
        config: lastLegCfg,
        lastTickAt: lastLastLegAt,
        lastError: lastLastLegError,
        lastReport: lastLastLegReport,
        summary: summarizeLastLeg(tickets),
        tickets: tickets.sort((a, b) => b.at.localeCompare(a.at)),
      });
      return;
    }
    if (url.pathname === "/api/shadow/parlays") {
      // PUBLIC, RETAIL SHAPE: the tickets as a bettor's app would list them (picks, state, the
      // lock's two endings and credit, what settled paid) plus the lock-sell-hold summary. No
      // hedge legs, take or token ids: those stay on /api/shadow/lastleg behind the operator token.
      // The demo's Parlays tab reads this. CORS is open because the body is public already.
      const tickets = loadLastLegTickets(LASTLEG_PATH);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=60",
        "access-control-allow-origin": "*",
      });
      res.end(
        JSON.stringify({
          ok: true,
          at: new Date().toISOString(),
          enabled: lastLegCfg.enabled,
          stakeCents: lastLegCfg.stakeCents,
          pricedEveryMinutes: Math.round(lastLegCfg.tickMs / 60_000),
          ...retailParlays(tickets, summarizeLastLeg(tickets), lockVersusSell(tickets)),
        }),
      );
      return;
    }
    if (url.pathname === "/api/shadow/lastleg.csv") {
      const csv = lastLegCsv(loadLastLegTickets(LASTLEG_PATH));
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="event-shadow-lastleg-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "no-store",
      });
      res.end(csv);
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
        polymarketBuilderCode: hedgeChoice.polymarketBuilderCode,
        notes: hedgeChoice.notes,
        summary: summarizeHedgeReceipts(receipts),
        recent: receipts.slice(-limit).reverse(),
      });
      return;
    }
    if (url.pathname === "/report") {
      const { atIso, positions } = pageData();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(
        renderShadowReportHtml({
          atIso,
          summary: summarizeShadow(positions),
          token: url.searchParams.get("token"),
          lastLeg: { summary: summarizeLastLeg(loadLastLegTickets(LASTLEG_PATH)), enabled: lastLegCfg.enabled, stakeCents: lastLegCfg.stakeCents },
        }),
      );
      return;
    }
    const slateMatch = /^\/slate\/([a-z0-9-]+?)(\.csv)?$/.exec(url.pathname);
    if (slateMatch) {
      // A prospect's name renders only on a link the operator sent: share key or operator token,
      // and only for a configured slate. Anything else is the same 404 as an unknown path.
      const slate = findVenueSlate(venueSlates, slateMatch[1]);
      const keyed = slate !== null && slateAccessOk(SLATE_KEY, slate.slug, url.searchParams.get("k"));
      if (!slate || !(keyed || operator)) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }
      const { atIso, positions } = pageData();
      const onSlate = slatePositions(slate, positions);
      const keyQuery = keyed ? `?k=${encodeURIComponent(url.searchParams.get("k") as string)}` : `?token=${encodeURIComponent(url.searchParams.get("token") ?? "")}`;
      if (slateMatch[2]) {
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${slate.slug}-slate-${new Date().toISOString().slice(0, 10)}.csv"`,
          "cache-control": "no-store",
        });
        res.end(positionsCsv(onSlate, "public"));
        return;
      }
      const summary = summarizeShadow(onSlate);
      const { settled, open } = splitPositions(onSlate);
      const tickets = loadLastLegTickets(LASTLEG_PATH);
      // the books wired today, the ones the record has used first; the per-row route is in the CSV
      const used = Object.keys(summary.routeSplit).map((r) => HEDGE_VENUE_NAMES[r]).filter(Boolean);
      const hedgeVenues = [...new Set([...used, ...Object.values(HEDGE_VENUE_NAMES)])];
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" });
      res.end(
        renderSlateHtml({
          atIso,
          slate,
          leaguesOnRecord: slateLeaguesOnRecord(slate, positions),
          summary,
          settled,
          open,
          lockVsSell: lockVersusSell(tickets),
          lastLeg: summarizeLastLeg(tickets),
          lastLegStakeCents: lastLegCfg.stakeCents,
          hedgeVenues,
          demoUrl: `${DEMO_URL}/?brand=${encodeURIComponent(slate.name)}`,
          csvHref: `/slate/${slate.slug}.csv${keyQuery}`,
          recordUrl: RECORD_URL,
        }),
      );
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const { atIso, positions } = pageData();
      const { settled, open, closed } = splitPositions(positions);
      const tickets = lastLegCfg.enabled ? loadLastLegTickets(LASTLEG_PATH) : null;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(
        renderShadowHtml({
          atIso,
          summary: summarizeShadow(positions),
          open,
          settled,
          closed,
          hedges: {
            strategy: hedgeChoice.strategy,
            rfqVenues: hedgeChoice.rfqVenues,
            summary: summarizeHedgeReceipts(loadHedgeReceipts(RECEIPTS_PATH)),
          },
          ...(tickets ? { parlays: { lockVsSell: lockVersusSell(tickets), lastLeg: summarizeLastLeg(tickets), stakeCents: lastLegCfg.stakeCents } } : {}),
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
      `[event-shadow] listening on :${PORT} · ledger ${LEDGER_PATH} · scan every ${Math.round(SCAN_MS / 60_000)}m · settle every ${Math.round(SETTLE_MS / 60_000)}m · early closes ${earlyCloseRule.sharePct}% of the book` +
        (lastLegCfg.enabled
          ? ` · last-leg shadow every ${Math.round(lastLegCfg.tickMs / 60_000)}m (${lastLegCfg.legCounts.join("/")}-leg tickets, $${(lastLegCfg.stakeCents / 100).toFixed(0)} stake, ledger ${LASTLEG_PATH})`
          : " · last-leg shadow off") +
        (venueSlates.length
          ? ` · slates ${venueSlates.map((s) => `/slate/${s.slug} (${s.name})`).join(", ")}${(SLATE_KEY ?? "").trim() ? "" : " [no share key: operator token only]"}`
          : ""),
    );
    void scanTick();
    void settleTick();
    setInterval(() => void scanTick(), SCAN_MS);
    setInterval(() => void settleTick(), SETTLE_MS);
    if (earlyCloseRule.sharePct > 0) setInterval(() => void closeTick(), CLOSE_MS);
    if (lastLegCfg.enabled) {
      void lastLegTick();
      setInterval(() => void lastLegTick(), lastLegCfg.tickMs);
    }
  });
}

if (process.env.NODE_ENV !== "test") void main();

export { server, scanTick, settleTick, closeTick, lastLegTick };
