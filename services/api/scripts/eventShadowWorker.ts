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
 *      EVENT_SHADOW_REREAD_HOURS (price every open game again on every venue this long before its
 *      lock, default 2; 0 = off) · EVENT_SHADOW_REREAD_MS (how often that is checked, default 60s)
 *      EVENT_SHADOW_HOLD_HOURS (hold the feed's reference books for every open game this long before
 *      its lock and price it again the moment one opens, default 48; 0 = off; needs the aggregator
 *      key) · EVENT_SHADOW_HOLD_MS (how often the holds are reconciled, default 60s)
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
 *
 * WHAT IS PUBLIC: the record (/, /api/shadow, /api/shadow/positions.csv, /api/shadow/parlays)
 * carries quoted terms, official results, both sides' money and the two books the hedges were
 * bought on. Everything that is a study rather than a receipt (rule counterfactuals, hedge
 * receipts, the last-leg tickets, netting measured on the book) is an operator view. A new
 * measurement joins the operator views first; it reaches the record only by decision.
 *
 * A holder's lock (source "lock", its own ledger) also carries the money between the two parties:
 * POST /api/shadow/cash (operator) records each payment against the leg it pays (credit, floor,
 * handback); the holder's receipt and the public record say what is owed and what was paid
 * (`curl -s -X POST -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" -H "content-type: application/json" \
 *   -d '{"ticker":"KX...","leg":"floor","cents":1200,"method":"venue transfer","ref":"..."}' https://<service>/api/shadow/cash`).
 */

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join } from "node:path";
import {
  CASH_LEGS,
  appendShadowRecord,
  cashDue,
  closeNetCents,
  hedgeUnitsOf,
  ledgerStats,
  loadShadowPositions,
  lockable,
  currentShadowPositions,
  positionsCsv,
  summarizeShadow,
  type CashLeg,
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
  rereadQuotesFor,
  type ShadowBookOpened,
  type ShadowCounterfactuals,
} from "../src/eventCollar/crossVenue/shadowCounterfactuals";
import type { AggregatorBookSource } from "../src/eventCollar/crossVenue/aggregatorBooks";
import type { HeldBookOpen, HeldBooks } from "../src/eventCollar/crossVenue/aggregatorHeldBooks";
import type { ReferenceBookId } from "../src/eventCollar/crossVenue/venueBooks";
import {
  DEFAULT_CROSS_CONFIG,
  capTotalCents,
  floorTotalCents,
  type CrossQuoteResult,
  type CrossSearchConfig,
  type HedgeLeg,
  type HedgeRoute,
  type PmBook,
} from "../src/eventCollar/crossVenue/types";
import type { NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { getMarketResult, kalshiBase } from "../src/eventCollar/kalshiPublic";
import { checkRule, kalshiRuleText, kalshiRuleUrl, pinRule } from "../src/eventCollar/crossVenue/ruleEvidence";
import { VENUE_NAMES, hedgeVenuesFromEnv, type HedgeRouting, type SettlementVenue } from "../src/eventCollar/crossVenue/hedgeRouting";
import { foldProphetXFee, prophetxFeeBpsFromEnv } from "../src/eventCollar/crossVenue/prophetxOrders";
import { TIER_RULES } from "../src/eventCollar/crossVenue/collarSearch";
import { adminAuthorized, parseAdminAuthFromEnv } from "../src/eventCollar/crossVenue/eventFunnel";
import {
  appendHedgeReceipt,
  intentFromHedge,
  sellIntentForNovig,
  loadHedgeReceipts,
  sellIntentForKalshi,
  sellIntentForProphetX,
  summarizeHedgeReceipts,
  type HedgeExecutor,
  type HedgeReceipt,
} from "../src/eventCollar/crossVenue/hedgeExecutor";
import { hedgeExecutorFromEnv } from "../src/eventCollar/crossVenue/hedgeExecutorFromEnv";
import { sentUnitsMilliOn, tickerArmed } from "../src/eventCollar/crossVenue/liveHedge";
import { KALSHI_SHARDS, KalshiAccountClient, KalshiApiError, shardForTicker, type KalshiAccountSnapshot, type KalshiApiKeyInfo } from "../src/eventCollar/crossVenue/kalshiAccount";
import { kalshiRfqCredentialsFromEnv } from "../src/eventCollar/crossVenue/kalshiRfq";
import { AggregatorApiError } from "../src/eventCollar/crossVenue/aggregatorMarkets";
import { FEE_RULE_TEXT, renderHoldersHtml, renderShadowHtml, renderShadowReportHtml, renderSlateHtml, renderVenuesHtml } from "./eventShadowHtml";
import { archiveLedgerFile, archiveLedgerLines } from "../src/eventCollar/crossVenue/ledgerArchive";
import { cryptoOpenAllowed, openMixRuleFromEnv } from "../src/eventCollar/crossVenue/openMix";
import {
  earlyCloseRuleFromEnv,
  earlyCloseSchedule,
  getKalshiBookSides,
  quoteEarlyClose,
  type EarlyCloseBooks,
  type EarlyCloseQuote,
  type EarlyCloseTerms,
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
  summarizeLegRules,
  type LastLegTickReport,
} from "../src/eventCollar/crossVenue/lastLeg";
import { retailParlays } from "../src/eventCollar/crossVenue/parlayRetail";
import { measureNetting } from "../src/eventCollar/crossVenue/shadowNetting";
import { venueBreakdown, venueBreakdownCsv } from "../src/eventCollar/crossVenue/shadowVenues";
import { findVenueSlate, parseVenueSlates, slateAccessOk, slateLeaguesOnRecord, slateLinkKey, slatePositions } from "../src/eventCollar/crossVenue/venueSlate";
import type { CandidateResult, ScanOptions, ScanState, listGameMarkets, pricingSourceStatus, quoteOne, referenceCatalog } from "./eventProtectXDemoService";
import { HOLDER_ALIAS_RE, holderKeysFromEnv, lockCaller, lockKeyFromEnv, parseLockRequest, readJsonBody } from "../src/eventCollar/crossVenue/lockGate";
import { ExtTelemetryStore, parseExtTelemetry } from "../src/eventCollar/crossVenue/extTelemetry";
import { VenueClient, holderPositions, signerFromPem, venueConfigFromEnv, type HolderPosition, type ProtectableMarket } from "../src/eventCollar/crossVenue/venuePositions";
import { PlaysClient, holderPlays, playsConfigFromEnv } from "../src/eventCollar/crossVenue/venuePlays";
import { novigRouteOf, referenceSourcesFromEnv, signedHedgeBook, signedHostFromEnv, type ReferenceBook } from "../src/eventCollar/crossVenue/venueBooks";
import { referencePrintSourcesFromEnv } from "../src/eventCollar/crossVenue/venuePrints";
import { retailCrossQuote } from "../src/eventCollar/retailShowcase";

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
 * PRE-LOCK RE-READ: every open game is priced again on both routes and every reference this many
 * hours before its lock, from fresh books at the position's size, and the read is written beside
 * the open (shadowCounterfactuals.ShadowReread). The open-time read is days before tip for most
 * games, when a venue that opens its books late is not listed yet; the pre-lock read is when a
 * late tap's hedge would actually be placed. Measurement only: nothing is re-hedged or re-written.
 */
const REREAD_HOURS = (() => {
  const raw = process.env.EVENT_SHADOW_REREAD_HOURS;
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 48 ? n : 2;
})();
const REREAD_MS = Number(process.env.EVENT_SHADOW_REREAD_MS || 60_000);
/** reads per tick, so a Sunday slate of games due at once is spread over a few ticks rather than one burst at the venues */
const REREAD_MAX_PER_TICK = 12;
let lastRereadAt: string | null = null;
let lastRereadError: string | null = null;
let rereadDueLastTick = 0;
let rereadWrittenLastTick = 0;
let rereadInFlight = false;

/**
 * HELD BOOKS: for every open game inside this window the worker keeps a subscription on the
 * aggregator's stream for each reference venue's book on the opposing outcome
 * (aggregatorHeldBooks.ts), and the first time that book shows a level the game is priced again
 * on every venue at that second, written beside the open as a `book_open` re-read
 * (shadowCounterfactuals.ShadowBookOpenReread). The pre-lock re-read measures a fixed moment; this
 * one measures the moment the late venue actually listed. The partner's own advice: hold the
 * subscription and catch the open, rather than wait for the fixed read. Needs the aggregator key;
 * without it nothing is held and the health says so. Measurement only, like the re-read.
 */
const HOLD_HOURS = (() => {
  const raw = process.env.EVENT_SHADOW_HOLD_HOURS;
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 240 ? n : 48;
})();
const HOLD_MS = Number(process.env.EVENT_SHADOW_HOLD_MS || 60_000);
/** new games looked up per tick: each is one REST call to the feed, spaced by the source */
const HOLD_MAX_NEW_PER_TICK = 24;
/** a book-open read whose venues were unreachable is tried again this many times, one per tick */
const BOOK_OPEN_MAX_ATTEMPTS = 3;
let heldSource: AggregatorBookSource | null = null;
let heldBooksConn: HeldBooks | null = null;
/** the holds per ticker: which ledger the position is on, and the hold keys (one per reference venue) */
const holdsByTicker = new Map<string, { path: string; keys: string[]; sinceIso: string }>();
/** opens the stream reported, waiting to be priced; drained by the hold tick and on arrival */
const openQueue: Array<{ ev: HeldBookOpen; attempts: number }> = [];
let openDraining = false;
let lastHoldAt: string | null = null;
let lastHoldError: string | null = null;
let holdWantedLastTick = 0;
let holdNotMappedLastTick = 0;
let bookOpensWritten = 0;

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
const HEDGE_VENUE_NAMES: Record<string, string> = { kalshi_self: "Kalshi", polymarket: "Polymarket", prophetx: "ProphetX", novig: "Novig" };
/**
 * Which hedge venues are offered tonight (EVENT_HEDGE_VENUES, hedgeRouting.hedgeVenuesFromEnv): the
 * same reading the engine quotes with; here for the status page and the routing's words.
 */
const HEDGE_VENUES = hedgeVenuesFromEnv(process.env);
/** ProphetX's fee on net gains at settlement, folded into its book before any walk (prophetxOrders.ts) */
const PROPHETX_FEE_BPS = prophetxFeeBpsFromEnv(process.env);

/** one line per hedge: which strategy filled it, at what, and why the other did not */
const RECEIPTS_PATH = process.env.EVENT_HEDGE_RECEIPTS_PATH || join(dirname(LEDGER_PATH), "hedge-receipts.jsonl");
/**
 * A real holder's locks live in their own ledger beside the scan's. The scan opens one showcase
 * position per market; a holder may lock the same market, so the two cannot share a file keyed by
 * ticker. Same record shape, same settlement; never early-closed (that experiment is the scan's).
 */
const LOCK_LEDGER_PATH = process.env.EVENT_SHADOW_LOCK_LEDGER_PATH || join(dirname(LEDGER_PATH), "lock-ledger.jsonl");
const hedgeChoice = hedgeExecutorFromEnv(process.env, null, { receiptsPath: RECEIPTS_PATH });
/**
 * Kalshi account administration (kalshiAccount.ts), with the same key the direct hedge signs
 * with, in any strategy: the tier (API rate tier, not an account type), the subaccounts and their
 * cash per shard, and the transfers that put cash where a pod's subaccount will spend it. Reads
 * and in-account transfers only; nothing here places an order. Operator token. Unset key: 503.
 */
const kalshiAccountCreds = kalshiRfqCredentialsFromEnv(process.env);
const kalshiAccount = kalshiAccountCreds ? new KalshiAccountClient(kalshiAccountCreds) : null;
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
  "/api/shadow/hedges/preflight",
  "/api/shadow/hedges/resend",
  "/api/shadow/hedges/pod",
  "/api/shadow/kalshi/account",
  "/api/shadow/kalshi/account/upgrade",
  "/api/shadow/kalshi/subaccounts",
  "/api/shadow/kalshi/subaccounts/transfer",
  "/api/shadow/kalshi/shards/transfer",
  "/api/shadow/kalshi/keys",
  "/api/shadow/kalshi/keys/delete",
  "/api/shadow/lock/reset",
  "/api/shadow/cash",
  "/api/shadow/holders",
  "/holders",
  "/api/shadow/export",
  "/api/shadow/reset",
  "/api/shadow/lastleg",
  "/api/shadow/lastleg.csv",
  "/api/shadow/netting",
  "/venues",
  "/api/shadow/venues",
  "/api/shadow/venues.csv",
  "/api/shadow/venues/catalog",
  "/api/shadow/ext-telemetry/summary",
]);

const alertCfg = parseShadowAlertsFromEnv(process.env);
const alerter: ShadowAlerter = buildShadowAlerter(alertCfg);
const BOOT_MS = Date.now();

let scan: ((opts?: ScanOptions) => Promise<ScanState>) | null = null;
let searchConfig: () => CrossSearchConfig = () => DEFAULT_CROSS_CONFIG;
/** the lock path's engine calls (eventProtectXDemoService), wired in main() with the scanner */
let quoteOneFn: typeof quoteOne | null = null;
let listGameMarketsFn: typeof listGameMarkets | null = null;
/**
 * The live books an early close is priced from: the protected market's two sides on Kalshi and,
 * on a cross-venue route, the hedge token's book (Polymarket, read from the venue) or the hedge
 * strike's book (ProphetX, read through the aggregator's stream by strike id, the settlement fee
 * folded in as at the lock). The hedge venue unreachable leaves the hedge leg unlocatable and the
 * pricer says so. Replaced by the tests (wireLockEngine).
 */
let closeBooksFn: (p: Pick<ShadowPosition, "ticker" | "route" | "hedgeTokenId" | "hedgeStrikeId" | "hedgeMarketId" | "hedgeOutcomeId" | "hedgeOffsetOutcomeId">) => Promise<EarlyCloseBooks> = async (p) => {
  const books: EarlyCloseBooks = { kalshi: await getKalshiBookSides(p.ticker) };
  if (p.route === "polymarket" && p.hedgeTokenId) {
    try {
      books.pmNoBook = await getPmBook(p.hedgeTokenId);
    } catch {
      // the hedge venue unreachable: the pricer records the leg as unlocatable, honestly
    }
  } else if (p.route === "prophetx" && p.hedgeStrikeId && heldSource) {
    const r = await heldSource.bookFor({ venue: "PROPHETX", strikeId: p.hedgeStrikeId }, new Date());
    if (r.book) books.pxNoBook = foldProphetXFee(r.book, PROPHETX_FEE_BPS);
  } else if (p.route === "novig" && p.hedgeMarketId && p.hedgeOutcomeId && p.hedgeOffsetOutcomeId && novigBookClient) {
    try {
      books.nvNoBook = await signedHedgeBook(novigBookClient, p.hedgeMarketId, p.hedgeOffsetOutcomeId, p.hedgeOutcomeId);
    } catch {
      // the venue unreachable: the pricer records the leg as unlocatable, honestly
    }
  }
  return books;
};
/** The Novig route's own book reads for an early close (the venue's public catalog on the reference or holder-positions host); null when neither host is set. */
const novigBookClient: VenueClient | null = (() => {
  const host = signedHostFromEnv(process.env);
  return host ? new VenueClient({ host }) : null;
})();
/** the engine's pricing-source status (the aggregator's feed, then the venues); wired in main() */
let pricingSourceStatusFn: typeof pricingSourceStatus | null = null;
let referenceCatalogFn: typeof referenceCatalog | null = null;
/**
 * LOCK: a real holder's tap (the browser extension over a venue's page) opens a position at
 * their size and fills the hedge through the same executor. Gated by EVENT_SHADOW_LOCK_KEY
 * (lockGate.ts); unset, the lock routes are 404. Tickers on the live allowlist are reserved
 * for the lock: the scan steps over them so the tap, not the scan, opens them.
 */
const LOCK_KEY = lockKeyFromEnv(process.env);
/**
 * HOLDERS (lockGate.ts): EVENT_SHADOW_HOLDER_KEYS names each person who may lock, `alias:key`.
 * A holder's locks live in their own ledger beside the shared one (`lock-ledger-<alias>.jsonl`),
 * so one market can be locked by several holders while the ticker stays the key inside each file;
 * every read of "the locks" below walks all of them. The alias is on the operator's views and
 * the per-holder cash summary (/api/shadow/holders), never on the public record.
 */
const HOLDER_KEYS = holderKeysFromEnv(process.env, LOCK_KEY);
const LOCK_ROUTES_ON = Boolean(LOCK_KEY) || HOLDER_KEYS.holders.length > 0;
const LOCK_PATHS = new Set(["/api/shadow/lock", "/api/shadow/quote", "/api/shadow/markets", "/api/shadow/positions", "/api/shadow/receipt", "/api/shadow/unwind", "/api/shadow/unwind/quote", "/api/shadow/ext-telemetry"]);
/**
 * THE EXTENSION'S SWITCHES, served with the markets list so the service, not the build, decides:
 * EVENT_SHADOW_EXT_MIN_VERSION   the version below which the extension shows "update" and draws nothing
 * EVENT_SHADOW_EXT_MARKS_OFF     venues (comma list: prophetx,kalshi,novig) whose marks are off for now
 */
const EXT_MIN_VERSION = (process.env.EVENT_SHADOW_EXT_MIN_VERSION ?? "").trim() || null;
const EXT_MARKS_OFF = new Set(
  (process.env.EVENT_SHADOW_EXT_MARKS_OFF ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean),
);
let protectCutoffMinutes = 45;
const extConfig = () => ({ minVersion: EXT_MIN_VERSION, marksOff: [...EXT_MARKS_OFF].sort(), cutoffMinutes: protectCutoffMinutes });
/** anonymous counts the extension posts per page (extTelemetry.ts); in memory, operator-read */
const extTelemetry = new ExtTelemetryStore();
/** keyed `${holder ?? ""}|${ticker}`: two holders may lock one market at once, one holder may not lock it twice */
const lockInFlight = new Set<string>();
const inFlightKey = (holder: string | null, ticker: string) => `${holder ?? ""}|${ticker}`;

/** The ledger a holder's locks are written to: the shared file for the shared key, their own otherwise. */
function lockLedgerPathFor(holder: string | null): string {
  if (!holder) return LOCK_LEDGER_PATH;
  const ext = extname(LOCK_LEDGER_PATH);
  return join(dirname(LOCK_LEDGER_PATH), `${basename(LOCK_LEDGER_PATH, ext)}-${holder}${ext}`);
}

/** The holder an existing ledger path belongs to, or null for the shared one. */
function holderOfLedgerPath(path: string): string | null {
  if (path === LOCK_LEDGER_PATH) return null;
  const ext = extname(LOCK_LEDGER_PATH);
  const stem = basename(LOCK_LEDGER_PATH, ext);
  const m = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-([a-z0-9][a-z0-9_-]{1,23})${ext.replace(".", "\\.")}$`).exec(basename(path));
  return m ? m[1] : null;
}

/**
 * Every lock ledger: the shared one, one per configured holder, and any holder file already on
 * disk (a holder whose key was removed keeps their history on the record). Archives
 * (`*.archived.jsonl`) never match.
 */
function lockLedgerPaths(): string[] {
  const paths = new Set<string>([LOCK_LEDGER_PATH, ...HOLDER_KEYS.holders.map((h) => lockLedgerPathFor(h.holder))]);
  const dir = dirname(LOCK_LEDGER_PATH);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (holderOfLedgerPath(full)) paths.add(full);
    }
  }
  return [...paths];
}

/** Every holder's locks, each with the ledger it lives in and whose it is. */
function allLocks(): Array<{ p: ShadowPosition; path: string; holder: string | null }> {
  return lockLedgerPaths().flatMap((path) => {
    const holder = holderOfLedgerPath(path);
    return loadShadowPositions(path).map((p) => ({ p, path, holder }));
  });
}

/**
 * One lock by ticker: in a named holder's ledger (`holder` a string), the shared ledger (null), or,
 * with `holder` undefined, wherever it is, provided it is in exactly one place. The operator's
 * routes take `?holder=` and get an `ambiguous` refusal naming the holders when they leave it off
 * and more than one person locked the market.
 */
function findLock(ticker: string, holder: string | null | undefined): { ok: true; lock: ShadowPosition; path: string; holder: string | null } | { ok: false; status: 404 | 409; error: string; message: string; holders?: string[] } {
  if (holder !== undefined) {
    const path = lockLedgerPathFor(holder);
    const lock = loadShadowPositions(path).find((p) => p.ticker === ticker);
    return lock ? { ok: true, lock, path, holder } : { ok: false, status: 404, error: "no_lock", message: `no lock on the record for ${ticker}${holder ? ` by ${holder}` : ""}` };
  }
  // one hit per ledger: the current lock on the market, not the earlier generations behind it
  const hits = allLocks().filter((l) => l.p.ticker === ticker).filter((l, i, all) => all.findIndex((o) => o.path === l.path) === i);
  if (hits.length === 0) return { ok: false, status: 404, error: "no_lock", message: `no lock on the record for ${ticker}` };
  if (hits.length > 1) {
    const holders = hits.map((h) => h.holder ?? "(shared)");
    return { ok: false, status: 409, error: "ambiguous", message: `${ticker} is locked by ${holders.join(", ")}; say which with ?holder=`, holders };
  }
  const [{ p, path, holder: h }] = hits;
  return { ok: true, lock: p, path, holder: h };
}

/** `?holder=` on an operator route: an alias, "" or "shared" for the shared ledger, absent for "wherever it is". */
function holderParam(url: URL): string | null | undefined {
  const raw = url.searchParams.get("holder");
  if (raw === null) return undefined;
  const v = raw.trim().toLowerCase();
  return v === "" || v === "shared" ? null : v;
}
/**
 * HOLDER POSITIONS (crossVenue/venuePositions.ts, crossVenue/venuePlays.ts): with a key for the
 * holder's venue account in the service env, GET /api/shadow/positions confirms what they hold
 * (contracts, cost, game) and which of our markets each maps to, so the client points at a row
 * and never guesses a size. Two venue APIs are spoken, chosen by which credentials are set:
 * VENUE_API_KEY_ID + VENUE_API_PRIVATE_KEY_PEM (signed requests, read-only key) or
 * VENUE_API_ACCESS_KEY + VENUE_API_SECRET_KEY (session login, bearer token). Unset, the route
 * answers configured:false and the client reads the page instead.
 */
export interface HolderPositionsSource {
  kind: "signed" | "bearer";
  holderPositions(protectable: ProtectableMarket[]): Promise<HolderPosition[]>;
}
let venueClient: HolderPositionsSource | null = null;
let venueClientNote: string | null = null;
{
  const signed = venueConfigFromEnv(process.env);
  const bearer = playsConfigFromEnv(process.env);
  if (signed) {
    try {
      const c = new VenueClient({ host: signed.host, signer: signerFromPem(signed.keyId, signed.pem) });
      venueClient = { kind: "signed", holderPositions: (p) => holderPositions(c, p) };
    } catch (err) {
      venueClientNote = `venue positions: key unusable (${String(err instanceof Error ? err.message : err)})`;
    }
  } else if (bearer) {
    const c = new PlaysClient(bearer);
    venueClient = { kind: "bearer", holderPositions: (p) => holderPlays(c, p) };
  }
}
/** REFERENCE_BOOK_* in the env: the scanner module reads these books on every sports open; this is only the operator's view of what is on */
const referenceBooks = (() => {
  const r = referenceSourcesFromEnv(process.env);
  return { configured: r.sources.map((s) => s.id), notes: r.notes };
})();
/** REFERENCE_PRINTS_HOST in the env: yesterday's tape from an exchange with no live book, read on every sports open; the operator's view only */
const referencePrints = (() => {
  const r = referencePrintSourcesFromEnv(process.env);
  return { configured: r.sources.map((s) => s.id), notes: r.notes };
})();
const POSITIONS_TTL_MS = Number(process.env.EVENT_SHADOW_POSITIONS_TTL_MS || 20_000);
let positionsCache: { at: number; positions: HolderPosition[] } | null = null;
/**
 * The holder's position on the OTHER club of this market's game, as the venue reports it, when
 * their account is readable and they hold nothing on this market. Null otherwise: no key, a read
 * that failed (the lock then proceeds as it does with no key at all), a position on this side, or
 * none on the game.
 */
async function heldOtherSideOf(ticker: string): Promise<HolderPosition | null> {
  if (!venueClient || !listGameMarketsFn) return null;
  try {
    if (!positionsCache || Date.now() - positionsCache.at > POSITIONS_TTL_MS) {
      const markets = await listGameMarketsFn();
      positionsCache = { at: Date.now(), positions: await venueClient.holderPositions(markets) };
    }
  } catch {
    return null;
  }
  const stem = ticker.slice(0, ticker.lastIndexOf("-") + 1);
  const onGame = positionsCache.positions.filter((p) => p.ticker && p.ticker.startsWith(stem));
  if (onGame.some((p) => p.ticker === ticker)) return null;
  return onGame.find((p) => p.ticker !== ticker) ?? null;
}
/**
 * A ticker armed for live orders is hedged on a venue the executor can send to, never on a route
 * the live rails would refuse (the record would carry a simulated fill). With ONE live venue the
 * route is pinned to it and the quote says what the pin cost against the rest. With more than one
 * (Kalshi and ProphetX through the aggregator's pod, Novig with our own key) nothing is pinned: the routing competes the
 * live venues on price, behind the executable gate, and the holder sees which won and why.
 * Unarmed tickers keep the board's rule.
 */
const tickerIsArmed = (ticker: string): boolean => Boolean(hedgeChoice.live && tickerArmed(hedgeChoice.live, ticker));
const lockRouteFor = (ticker: string): HedgeRoute | undefined => {
  const live = hedgeChoice.live;
  if (!live || !tickerIsArmed(ticker)) return undefined;
  const reachable = live.venues.filter((v) => v === "kalshi" || v === "prophetx" || v === "polymarket" || v === "novig");
  if (reachable.length !== 1) return undefined;
  return reachable[0] === "kalshi" ? "kalshi_self" : reachable[0] === "prophetx" ? "prophetx" : reachable[0] === "novig" ? "novig" : "polymarket";
};
/**
 * Which hedge venues an order can reach for this ticker now (hedgeRouting's executable gate): on
 * paper every one; armed for live orders, only the venues the live executor has a client for.
 */
const executableFor = (ticker: string): Record<HedgeRoute, boolean> =>
  tickerIsArmed(ticker) && hedgeChoice.live
    ? { kalshi_self: hedgeChoice.live.venues.includes("kalshi"), polymarket: hedgeChoice.live.venues.includes("polymarket"), prophetx: hedgeChoice.live.venues.includes("prophetx"), novig: hedgeChoice.live.venues.includes("novig") }
    : { kalshi_self: true, polymarket: true, prophetx: true, novig: true };

/**
 * The price competition in one line a holder can read: what each venue's book would have paid them
 * for the same protection, and which one the hedge went to. Null when fewer than two were priced.
 */
export function comparisonLineOf(r: HedgeRouting): string | null {
  const priced = r.routes.filter((x) => x.creditCents !== null);
  if (priced.length < 2) return null;
  const chosen = r.routes.find((x) => x.route === r.chosen) ?? null;
  const money = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
  const parts = [...priced].sort((a, b) => (b.creditCents as number) - (a.creditCents as number)).map((x) => `${VENUE_NAMES[x.hedgeVenue]} ${money(x.creditCents as number)}`);
  const tail = chosen ? `hedged on ${VENUE_NAMES[chosen.hedgeVenue]}` : "no route passed";
  return `${parts.join(" vs ")}, ${tail}`;
}

/**
 * The routing as a holder reads it: where their position lives, where the hedge went and why, what
 * each route cost all in, and the tails in their venue's words. The rule cells' sources stay on the
 * record (the receipt links the venue's text; the holder's page says the treatment).
 */
function routingViewOf(r: HedgeRouting | undefined) {
  if (!r) return null;
  const chosen = r.routes.find((x) => x.route === r.chosen) ?? null;
  return {
    holderVenue: r.holderVenue,
    holderVenueName: VENUE_NAMES[r.holderVenue],
    hedgeVenue: chosen?.hedgeVenue ?? null,
    hedgeVenueName: chosen ? VENUE_NAMES[chosen.hedgeVenue] : null,
    reason: r.reason,
    /** the competition as the holder reads it: each venue's credit for the same protection, the winner named */
    comparison: comparisonLineOf(r),
    evCostBps: chosen?.evCostBps ?? null,
    tailChargeBps: chosen?.tailChargeBps ?? null,
    allInBps: chosen?.allInBps ?? null,
    compatible: chosen?.compatible ?? null,
    routes: r.routes.map((x) => ({
      route: x.route,
      hedgeVenue: x.hedgeVenue,
      hedgeVenueName: VENUE_NAMES[x.hedgeVenue],
      ok: x.ok,
      evCostBps: x.evCostBps,
      tailChargeBps: x.tailChargeBps,
      allInBps: x.allInBps,
      creditCents: x.creditCents,
      terms: x.terms,
      compatible: x.compatible,
      ...(x.gates.detail ? { gate: x.gates.detail } : {}),
      ...(x.refusal ? { refusal: x.refusal } : {}),
      mismatches: x.mismatches.map((m) => ({ branch: m.branch, holder: m.holder, hedge: m.hedge, confirmed: m.confirmed, chargeCents: m.chargeCents, note: m.note })),
    })),
    tails: r.tails,
    rules: Object.fromEntries(Object.entries(r.holderRules).map(([b, c]) => [b, { treatment: c.treatment, ...(c.windowHours !== undefined ? { windowHours: c.windowHours } : {}), confirmed: c.confirmed, source: c.source, asOf: c.asOf }])),
    probabilities: r.probabilities,
  };
}
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

/** Every position on the record: the scan's showcase positions and the holders' locks. */
const allPositions = () => [...loadShadowPositions(LEDGER_PATH), ...allLocks().map((l) => l.p)];
/** The scan's ledger and every lock ledger: what the settle, re-read and hold loops walk. */
const ledgerPaths = () => [LEDGER_PATH, ...lockLedgerPaths()];

/** Append with the failure surfaced: a ledger that cannot be written is the one fault that must page. */
function appendOrAlert(record: Parameters<typeof appendShadowRecord>[1], path: string = LEDGER_PATH): boolean {
  try {
    appendShadowRecord(path, record);
    return true;
  } catch (err) {
    void alerter({
      kind: "ledger_write_failed",
      message: `could not append ${record.type} for ${record.ticker} to ${path}: ${String(err instanceof Error ? err.message : err)}`,
    });
    return false;
  }
}

/**
 * Fill the hedge leg through the configured executor and keep the receipt.
 * The position is already on the ledger; a hedge failure is recorded, never
 * allowed to lose the record or stop the scan.
 */
async function fillHedge(ref: string, hedge: HedgeLeg, books: { pmNoBook?: PmBook; noAsks?: NoAskLevel[]; pxNoBook?: PmBook; references?: ReferenceBook[] }): Promise<HedgeReceipt | null> {
  const ticker = ref.split("@")[0];
  try {
    const best =
      hedge.venue === "kalshi"
        ? books.noAsks?.[0]
          ? books.noAsks[0].priceCents * 10
          : hedge.avgPriceCents * 10
        : hedge.venue === "prophetx"
          ? (books.pxNoBook ? foldProphetXFee(books.pxNoBook, PROPHETX_FEE_BPS).asks[0]?.priceMilli : undefined) ?? hedge.avgPriceMilli
          : hedge.venue === "novig"
            ? novigRouteOf(books.references)?.noBook.asks[0]?.priceMilli ?? hedge.avgPriceMilli
            : books.pmNoBook?.asks[0]?.priceMilli ?? hedge.avgPriceMilli;
    // a leg on another venue is armed by the game's Kalshi ticker (the live allowlist's key)
    const armKey = hedge.venue === "kalshi" ? undefined : ticker;
    const receipt = await hedgeChoice.executor.execute(intentFromHedge(hedge, best, armKey), ref);
    appendHedgeReceipt(RECEIPTS_PATH, receipt);
    return receipt;
  } catch (err) {
    lastScanError = `hedge for ${ticker}: ${String(err instanceof Error ? err.message : err)}`;
    return null;
  }
}

/**
 * SELL THE HEDGE BACK (an early close). The walked sale (earlyClose.hedgeSale) goes to the executor
 * as a sell intent behind the same rails as the buy: on a live, armed ticker it is a Kalshi `bid`
 * for Yes at 1 - the walked worst No bid, immediate or cancel; anywhere else it is simulated at
 * the walk and the line says the operator sells by hand. The receipt joins the trail under the
 * same ref as the buy. When the venue sold, the close is written at what the venue paid: the net
 * proceeds on the units sold, plus the walked worst bid on any remainder an IOC left behind (the
 * operator sells that by hand; the note says so). A Polymarket hedge has no sell rail yet.
 *
 * A ProphetX hedge is not sold: the venue takes no sell order. The sale is the OFFSET, a buy of
 * the holder's side's strike at or under 1 - the walked worst bid on the hedge strike, which pairs
 * with the hedge share for share and settles at the game (prophetxOrders.ts). The record carries
 * the proceeds that pair fetches; the cash lands at settlement, not today, and the note says so.
 * Without the offset strike on the record the offset is the operator's hand. A Novig hedge leaves
 * the same way: the offset buys the holder's own outcome on the venue's market (novigOrders.ts).
 */
async function sellHedge(
  ticker: string,
  ref: string,
  lock: ShadowPosition,
  q: EarlyCloseQuote,
): Promise<{ q: EarlyCloseQuote; sent: boolean; receipt: HedgeReceipt | null; note: string }> {
  if (!q.hedgeSale || !lock.hedgeUnitsMilli) {
    return { q, sent: false, receipt: null, note: "the hedge is on Polymarket; its sale is recorded at the book's price and the operator sells it by hand" };
  }
  if (q.hedgeSale.venue === "prophetx" && !lock.hedgeOffsetStrikeId) {
    return { q, sent: false, receipt: null, note: "the hedge is on ProphetX and the holder's side's strike is not on the record; the offset is recorded at the book's price and the operator buys it by hand" };
  }
  if (q.hedgeSale.venue === "novig" && !lock.hedgeOffsetOutcomeId) {
    return { q, sent: false, receipt: null, note: "the hedge is on Novig and the holder's own outcome is not on the record; the offset is recorded at the book's price and the operator buys it by hand" };
  }
  let receipt: HedgeReceipt;
  try {
    const intent =
      q.hedgeSale.venue === "prophetx"
        ? sellIntentForProphetX({ strikeId: q.hedgeSale.strikeId, offsetStrikeId: lock.hedgeOffsetStrikeId as string, armKey: ticker, unitsMilli: lock.hedgeUnitsMilli, bestPriceMilli: q.hedgeSale.bestPriceMilli, avgPriceMilli: q.hedgeSale.avgPriceMilli, worstPriceMilli: q.hedgeSale.worstPriceMilli, grossCents: q.hedgeSale.grossCents })
        : q.hedgeSale.venue === "novig"
          ? sellIntentForNovig({ marketId: q.hedgeSale.marketId, outcomeId: q.hedgeSale.outcomeId, offsetOutcomeId: q.hedgeSale.offsetOutcomeId, armKey: ticker, unitsMilli: lock.hedgeUnitsMilli, bestPriceMilli: q.hedgeSale.bestPriceMilli, avgPriceMilli: q.hedgeSale.avgPriceMilli, worstPriceMilli: q.hedgeSale.worstPriceMilli, grossCents: q.hedgeSale.grossCents })
          : sellIntentForKalshi({ ticker, unitsMilli: lock.hedgeUnitsMilli, ...q.hedgeSale });
    receipt = await hedgeChoice.executor.execute(intent, ref);
    appendHedgeReceipt(RECEIPTS_PATH, receipt);
  } catch (err) {
    lastScanError = `hedge sale for ${ticker}: ${String(err instanceof Error ? err.message : err)}`;
    return { q, sent: false, receipt: null, note: `the sale could not be attempted (${String(err instanceof Error ? err.message : err)}); recorded at the book's price, the operator sells by hand` };
  }
  const fill = receipt.fill;
  if (!fill || fill.simulated) {
    return { q, sent: false, receipt, note: `the hedge sale is recorded at the book's price and not sent (${receipt.fallbackReason ?? "simulated"}); the operator sells it by hand` };
  }
  // what the venue paid, plus the walked worst bid on whatever an IOC left unsold
  const leftMilli = Math.max(0, lock.hedgeUnitsMilli - fill.unitsMilli);
  const worstMilli = q.hedgeSale.venue === "kalshi" ? q.hedgeSale.worstPriceCents * 10 : q.hedgeSale.worstPriceMilli;
  const leftCents = Math.floor((leftMilli * worstMilli) / 10_000);
  const netCents = fill.costCents + leftCents;
  const delta = netCents - q.hedgeProceedsCents;
  const priced: EarlyCloseQuote = {
    ...q,
    hedgeProceedsCents: netCents,
    protectedAtCloseCents: q.protectedAtCloseCents + delta,
    unwindFrictionCents: q.unwindFrictionCents === null ? null : q.unwindFrictionCents - delta,
  };
  const via = fill.via === "aggregator" ? " via the aggregator's pod" : "";
  if (q.hedgeSale.venue === "prophetx") {
    const partial = leftMilli > 0 ? `; ${leftMilli / 1000} of ${lock.hedgeUnitsMilli / 1000} not offset, carried at the walked ${worstMilli} milli for the operator's hand` : "";
    return { q: priced, sent: true, receipt, note: `offset on ProphetX, order ${fill.ids.orderId ?? "?"}${via}: ${fill.unitsMilli / 1000} of the holder's side's strike bought against the hedge, ${fill.costCents}c net when the pair settles at the game${partial}` };
  }
  if (q.hedgeSale.venue === "novig") {
    const partial = leftMilli > 0 ? `; ${leftMilli / 1000} of ${lock.hedgeUnitsMilli / 1000} not offset, carried at the walked ${worstMilli} milli for the operator's hand` : "";
    return { q: priced, sent: true, receipt, note: `offset on Novig, order ${fill.ids.orderId ?? "?"}: ${fill.unitsMilli / 1000} of the holder's own outcome bought against the hedge, ${fill.costCents}c net when the pair settles at the game${partial}` };
  }
  const partial = leftMilli > 0 ? `; ${leftMilli / 1000} of ${lock.hedgeUnitsMilli / 1000} left unsold, carried at the walked ${q.hedgeSale.worstPriceCents}c for the operator to sell by hand` : "";
  return { q: priced, sent: true, receipt, note: `sold on Kalshi, order ${fill.ids.orderId ?? "?"}${via}: ${fill.unitsMilli / 1000} No at ${fill.avgPriceMilli} milli, ${fill.costCents}c net${partial}` };
}

/**
 * The holder's view of one hedge receipt: what was bought on the other side, where, at what, and
 * the ids that tie it to the venue and to our trail. Nothing about rails or strategy; the fallback
 * reason rides along for the operator's client. Shared by the lock answer and /api/shadow/receipt
 * so the receipt the holder sees a week later is the one they saw at the tap.
 */
function hedgeViewOf(receipt: HedgeReceipt) {
  const fill = receipt.fill;
  // where the other side was bought is the receipt's own fact: a lock quoted on one route may be hedged again on another
  const fillVenue = fill?.venue ?? receipt.intent.venue;
  const route: HedgeRoute = fillVenue === "polymarket" ? "polymarket" : fillVenue === "prophetx" ? "prophetx" : fillVenue === "novig" ? "novig" : "kalshi_self";
  return {
    at: receipt.at,
    /** "buy": the hedge bought at the lock; "sell": the hedge sold back at an early close (on ProphetX and Novig, the offset bought; the pair settles at the game) */
    action: receipt.intent.action ?? "buy",
    route,
    venue: HEDGE_VENUE_NAMES[route],
    ...((route === "prophetx" || route === "novig") && (receipt.intent.action ?? "buy") === "sell" ? { settlesAtGame: true } : {}),
    outcome: receipt.outcome,
    simulated: fill?.simulated ?? true,
    unitsMilli: fill?.unitsMilli ?? null,
    /** all in, fees included, milli dollars per contract */
    avgPriceMilli: fill?.avgPriceMilli ?? null,
    costCents: fill?.costCents ?? null,
    orderId: fill?.ids.orderId ?? null,
    /** how the order reached the venue: "direct" (our key), "aggregator" (the partner's pod), "book" (simulated, nothing sent) */
    via: fill && !fill.simulated ? (fill.via ?? "direct") : "book",
    fallbackReason: receipt.fallbackReason,
    receiptId: receipt.id,
  };
}

/** The locked terms an early close prices against, read off the position as written. */
function closeTermsOf(p: ShadowPosition): EarlyCloseTerms {
  return {
    contracts: p.contracts,
    floorCents: p.floorCents,
    capCents: p.capCents,
    creditCents: p.creditCents,
    takeCents: p.takeCents,
    hedgeUnitsMilli: hedgeUnitsOf(p),
    route: p.route,
    ...(p.hedgeStrikeId ? { hedgeStrikeId: p.hedgeStrikeId } : {}),
    ...(p.hedgeMarketId && p.hedgeOutcomeId && p.hedgeOffsetOutcomeId ? { novig: { marketId: p.hedgeMarketId, hedgeOutcomeId: p.hedgeOutcomeId, offsetOutcomeId: p.hedgeOffsetOutcomeId } } : {}),
  };
}

/** The priced lines of a close as the ledger records them; shared by the schedule and the holder's unwind. */
function closeLinesOf(q: EarlyCloseQuote) {
  return {
    yesMidCents: q.yesMidCents,
    yesFillCents: q.yesFillCents,
    positionProceedsCents: q.positionProceedsCents,
    hedgeProceedsCents: q.hedgeProceedsCents,
    feesCents: q.positionFeesCents + q.hedgeFeesCents,
    protectedAtCloseCents: q.protectedAtCloseCents,
    protectedAtMidCents: q.protectedAtMidCents,
    unwindFrictionCents: q.unwindFrictionCents,
  };
}

/**
 * The holder's view of an early-close quote: what their own sale fetches, what the protection
 * settles for between us, what they walk away with, against staying to the floor and the cap.
 * The same shape before the tap (the quote) and after it (the record), so the client paints one.
 */
function unwindViewOf(lock: ShadowPosition, q: EarlyCloseQuote) {
  return {
    contracts: lock.contracts,
    /** the holder's own sale: N Yes into the bids at this average, after the venue's fee */
    yesFillCents: q.yesFillCents,
    yesMidCents: q.yesMidCents,
    positionProceedsCents: q.positionProceedsCents,
    positionFeesCents: q.positionFeesCents,
    /** between the two parties: our hedge sale less the cap slice sold at the tap; positive is owed to the holder */
    hedgeProceedsCents: q.hedgeProceedsCents,
    fundingCents: q.fundingCents,
    closeNetCents: q.hedgeProceedsCents - q.fundingCents,
    creditCents: lock.creditCents,
    /** what the holder ends with: own sale + close net + credit */
    protectedAtCloseCents: q.protectedAtCloseCents,
    /** the same sale with no protection ever bought */
    nakedAtCloseCents: q.nakedAtCloseCents,
    /** the frictionless reference at the mid, and what crossing both books cost against it */
    protectedAtMidCents: q.protectedAtMidCents,
    unwindFrictionCents: q.unwindFrictionCents,
    /** staying: the two ends of the protected position at settlement */
    stayFloorCents: floorTotalCents(lock),
    stayCapCents: capTotalCents(lock),
  };
}

/** A lock's close, once it has one, as the receipt and the positions list carry it. */
function closedViewOf(lock: ShadowPosition) {
  if (lock.status !== "closed") return {};
  return {
    closedAt: lock.closedAt,
    protectedCents: lock.protectedCents,
    nakedCents: lock.nakedCents,
    closeNetCents: closeNetCents(lock),
    closeYesFillCents: lock.closeYesFillCents,
    closeYesMidCents: lock.closeYesMidCents,
    closeFeesCents: lock.closeFeesCents,
    closeUnwindFrictionCents: lock.closeUnwindFrictionCents,
    closeSource: lock.closeSource,
    closeHedgeSent: lock.closeHedgeSent,
  };
}

/**
 * Refuse an unwind the pricers would, before any book is read. Open positions only; the early-close
 * margin before the lock (the same one the schedule keeps) is the holder's last moment to leave.
 */
function unwindRefusal(lock: ShadowPosition | undefined, ticker: string, nowMs: number): { status: number; body: Record<string, unknown> } | null {
  if (!lock) return { status: 404, body: { ok: false, error: "no_lock", message: ticker ? "This market is not on the record." : "?ticker= names the lock" } };
  if (lock.status !== "open") {
    const said = lock.status === "closed" ? "This position was already left early." : lock.status === "settled" ? "This position has settled; there is nothing to leave." : "This position was voided; there is nothing to leave.";
    return { status: 409, body: { ok: false, error: "not_open", status: lock.status, message: said } };
  }
  const lastMs = Date.parse(lock.eventTimeIso) - earlyCloseRule.marginMs;
  if (!Number.isFinite(lastMs) || nowMs > lastMs) {
    return {
      status: 409,
      body: { ok: false, error: "too_late", message: `Leaving early closes ${Math.round(earlyCloseRule.marginMs / 60_000)} minutes before the start; the protection runs to settlement now.`, lastIso: Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null },
    };
  }
  return null;
}

/**
 * The receipt that stands for a lock: the latest live fill on the trail for its ticker since the
 * lock was written; else the latest receipt since then; null when the trail has none (a lock
 * re-done after a reset never inherits the old lock's hedge).
 */
/** The hedge trail's ref for a lock: the ticker, suffixed with the holder when there is one, so two holders' hedges on one market stay apart. */
const hedgeRefFor = (ticker: string, holder: string | null): string => (holder ? `${ticker}@${holder}` : ticker);

function receiptForLock(ref: string, lockAtIso: string, action: "buy" | "sell" = "buy"): HedgeReceipt | null {
  const since = loadHedgeReceipts(RECEIPTS_PATH).filter((r) => r.ref === ref && r.at >= lockAtIso && (r.intent.action ?? "buy") === action);
  const live = since.filter((r) => r.fill && !r.fill.simulated);
  return live.at(-1) ?? since.at(-1) ?? null;
}

/**
 * The open record for one quoted candidate: the terms, the hedge as quoted, the counterfactuals
 * from the same books, the venue's rule pinned. Shared by the scan and the lock so a person's
 * position is written exactly as the scan would have written it, plus `source`.
 */
function openRecordFor(
  res: CandidateResult,
  q: Extract<CrossQuoteResult, { ok: true }>,
  evBps: number,
  scanAtIso: string,
  source?: "lock",
): Parameters<typeof appendShadowRecord>[1] {
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
        now: new Date(scanAtIso),
        config: searchConfig(),
        books: res.books,
        prophetxFeeBps: PROPHETX_FEE_BPS,
      },
      q,
    );
  } catch (err) {
    // The live record must never be lost to a counterfactual failure.
    lastScanError = `counterfactuals for ${res.market.ticker}: ${String(err instanceof Error ? err.message : err)}`;
  }
  return {
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
    ...(res.bookOrigins ? { bookOrigins: res.bookOrigins } : {}),
    ...(q.hedge.venue === "polymarket" ? { hedgeTokenId: q.hedge.tokenId } : {}),
    ...(q.hedge.venue === "prophetx" ? { hedgeStrikeId: q.hedge.strikeId, ...(q.hedge.offsetStrikeId ? { hedgeOffsetStrikeId: q.hedge.offsetStrikeId } : {}) } : {}),
    ...(q.hedge.venue === "novig" ? { hedgeMarketId: q.hedge.marketId, hedgeOutcomeId: q.hedge.outcomeId, hedgeOffsetOutcomeId: q.hedge.offsetOutcomeId } : {}),
    ...(res.routing ? { holderVenue: res.routing.holderVenue, routing: res.routing } : {}),
    // the rule the result will be judged under, as the venue publishes it this second
    rule: pinRule({
      venue: "kalshi",
      marketId: res.market.ticker,
      ruleText: kalshiRuleText(res.market),
      sourceUrl: kalshiRuleUrl(res.market.ticker, kalshiBase()),
      readAtIso: new Date().toISOString(),
    }),
    ...(source ? { source, entryCents: res.position.entryCents } : {}),
  };
}

/** The retail shape of a quoted game for the lock client: the event, the odds, the terms. Nothing about the hedge. */
function retailOneQuote(res: CandidateResult, evBps: number | null) {
  return {
    ticker: res.market.ticker,
    kind: res.kind,
    league: res.league,
    sideName: res.sideName,
    eventTitle: res.eventTitle,
    eventTimeIso: res.eventTimeIso,
    markCents: res.markCents,
    contracts: res.position.contracts,
    entryCents: res.position.entryCents,
    quote: retailCrossQuote(res.quote),
    evCostBps: evBps,
  };
}

/**
 * The lock routes (gated by the lock key or the operator token; 404 when no key is configured):
 *   GET  /api/shadow/markets?league=   the games the engine can protect, and which are already on the record
 *   GET  /api/shadow/quote?ticker=&contracts=&entry=&venue=   one position, priced now, retail shape, with
 *        `routing` (hedgeRouting.ts): the holder's venue (`venue`: kalshi, prophetx, novig; absent Kalshi), the
 *        hedge venue chosen against it and why, each route's cost all in (EV plus the tails priced), the tails
 *        in the holder's venue's words; with the operator token, also the engine's route verdicts and the pin
 *   POST /api/shadow/lock {ticker, contracts, entryCents?, tier?, venue?}   quote again (the lock is at the tap),
 *        write the open record with source "lock" (holderVenue and routing on it), fill the hedge on the
 *        chosen venue, answer with the terms, the hedge receipt's outcome and the routing
 *   GET  /api/shadow/receipt?ticker=   the lock's terms, the hedge behind them and the routing, any time after
 *   GET  /api/shadow/unwind/quote?ticker=   leaving early, priced now from the live books (earlyClose.ts), nothing written
 *   POST /api/shadow/unwind {ticker}   quote again at the tap, write the close line (source "unwind"), answer with it
 */
async function handleLockRoutes(req: IncomingMessage, res: ServerResponse, url: URL, holder: string | null, operator = false): Promise<void> {
  if (!quoteOneFn || !listGameMarketsFn) {
    sendJson(res, 503, { ok: false, error: "engine_not_ready", message: "the scanner is still loading" });
    return;
  }
  const atIso = new Date().toISOString();
  // this caller's own locks: what they see as Protected, what they may not lock twice
  const ownLedger = lockLedgerPathFor(holder);
  if (url.pathname === "/api/shadow/markets") {
    // held: a lock this holder has on the market that is open, settled or void; one whose protection was removed frees the market
    const held = new Set(loadShadowPositions(ownLedger).filter((p) => p.status !== "closed").map((p) => p.ticker));
    const league = url.searchParams.get("league") ?? undefined;
    const markets = await listGameMarketsFn(league);
    sendJson(res, 200, {
      ok: true,
      at: atIso,
      ...(holder ? { holder } : {}),
      ext: extConfig(),
      // a market this holder already locked is on record, not protectable again
      markets: markets.map((m) => ({ ...m, onRecord: held.has(m.ticker), protectable: m.protectable && !held.has(m.ticker), ...(held.has(m.ticker) ? { notProtectable: "on_record" } : {}), live: tickerIsArmed(m.ticker) })),
    });
    return;
  }
  if (url.pathname === "/api/shadow/ext-telemetry") {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "POST a JSON body {venue, page, version, counts}" });
      return;
    }
    const parsed = parseExtTelemetry(await readJsonBody(req), atIso);
    if (!parsed.ok) {
      sendJson(res, 400, { ok: false, error: "bad_request", message: parsed.error });
      return;
    }
    extTelemetry.add(parsed.row);
    sendJson(res, 200, { ok: true, at: atIso });
    return;
  }
  if (url.pathname === "/api/shadow/positions") {
    if (!venueClient) {
      sendJson(res, 200, { ok: true, at: atIso, configured: false, positions: [], ...(venueClientNote ? { note: venueClientNote } : {}) });
      return;
    }
    if (!positionsCache || Date.now() - positionsCache.at > POSITIONS_TTL_MS || url.searchParams.get("fresh") === "1") {
      try {
        const markets = await listGameMarketsFn();
        positionsCache = { at: Date.now(), positions: await venueClient.holderPositions(markets) };
      } catch (err) {
        sendJson(res, 200, { ok: false, at: atIso, configured: true, error: "venue_read_failed", message: String(err instanceof Error ? err.message : err) });
        return;
      }
    }
    // what the record already holds for each matched market: the client shows Protected, not Lock in
    const locks = new Map(currentShadowPositions(loadShadowPositions(ownLedger)).map((p) => [p.ticker, p]));
    sendJson(res, 200, {
      ok: true,
      at: atIso,
      configured: true,
      ...(holder ? { holder } : {}),
      readAt: new Date(positionsCache.at).toISOString(),
      positions: positionsCache.positions.map((p) => {
        const L = p.ticker ? locks.get(p.ticker) : undefined;
        return {
          ...p,
          lock: L
            ? {
                at: L.at,
                status: L.status,
                contracts: L.contracts,
                floorCents: L.floorCents,
                capCents: L.capCents,
                creditCents: L.creditCents,
                ...(L.generation ? { generation: L.generation } : {}),
                ...(L.result ? { result: L.result, protectedCents: L.protectedCents, nakedCents: L.nakedCents, settledAt: L.settledAt } : {}),
                ...closedViewOf(L),
              }
            : null,
        };
      }),
    });
    return;
  }
  if (url.pathname === "/api/shadow/quote") {
    const parsed = parseLockRequest({
      ticker: url.searchParams.get("ticker") ?? "",
      contracts: url.searchParams.get("contracts") ?? "",
      ...(url.searchParams.get("entry") ? { entryCents: url.searchParams.get("entry") } : {}),
      ...(url.searchParams.get("venue") ? { venue: url.searchParams.get("venue") } : {}),
    });
    if (!parsed.ok) {
      sendJson(res, 400, { ok: false, error: "bad_request", message: parsed.error });
      return;
    }
    const q = await quoteOneFn({
      ticker: parsed.value.ticker,
      contracts: parsed.value.contracts,
      entryCents: parsed.value.entryCents,
      route: lockRouteFor(parsed.value.ticker),
      holderVenue: parsed.value.venue ?? "kalshi",
      executable: executableFor(parsed.value.ticker),
    });
    if (!q.ok) {
      sendJson(res, 200, { ok: false, at: atIso, ticker: parsed.value.ticker, code: q.code, message: q.detail });
      return;
    }
    const held = !lockable(loadShadowPositions(ownLedger), parsed.value.ticker);
    // The operator also sees the routing: which hedge route funded this quote and what every route
    // said. On an armed ticker the lock is pinned to Kalshi's own No side, so the verdict there is
    // what the live hedge will do; on an unarmed one it is the engine's free choice at this size.
    // Every caller sees where the hedge would go and why (hedgeRouting.ts): the holder's venue, the
    // hedge venue, each route's cost all in, the tails in their venue's words. The operator also
    // sees the engine's own route verdicts and the pin.
    const view = routingViewOf(q.result.routing);
    const routing = {
      routing: operator
        ? {
            ...(view ?? {}),
            route: q.result.route,
            pinned: lockRouteFor(parsed.value.ticker) ?? null,
            ...(q.result.pinnedExecution ? { pinnedExecution: q.result.pinnedExecution } : {}),
            routesChecked: q.result.routesChecked.map((r) => ({ route: r.route, ok: r.ok, evCostBps: r.evCostBps, creditCents: r.creditCents, ...(r.detail ? { detail: r.detail } : {}) })),
          }
        : view,
    };
    sendJson(res, 200, { ok: true, at: atIso, onRecord: held, ...(holder ? { holder } : {}), ...retailOneQuote(q.result, q.result.evBps), ...routing });
    return;
  }
  if (url.pathname === "/api/shadow/lock") {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "POST a JSON body {ticker, contracts, entryCents?, tier?, venue?}" });
      return;
    }
    const parsed = parseLockRequest(await readJsonBody(req));
    if (!parsed.ok) {
      sendJson(res, 400, { ok: false, error: "bad_request", message: parsed.error });
      return;
    }
    const { ticker, contracts, entryCents, tier, venue } = parsed.value;
    const flight = inFlightKey(holder, ticker);
    if (lockInFlight.has(flight)) {
      sendJson(res, 409, { ok: false, error: "lock_in_flight", message: "This position is being locked right now." });
      return;
    }
    if (!lockable(loadShadowPositions(ownLedger), ticker)) {
      sendJson(res, 409, { ok: false, error: "already_on_record", message: "This market is already locked; one lock per market." });
      return;
    }
    // the venue's own word on the holder's side: when their account is readable and it holds the
    // other club of this game and not this one, the card was misread; no lock, no wrong-way hedge
    const other = await heldOtherSideOf(ticker);
    if (other) {
      sendJson(res, 409, { ok: false, error: "wrong_side", code: "wrong_side", message: `Your pick on this game is ${other.side || "the other side"}; protect it from that card.`, heldTicker: other.ticker });
      return;
    }
    lockInFlight.add(flight);
    try {
      const q = await quoteOneFn({ ticker, contracts, entryCents, route: lockRouteFor(ticker), holderVenue: venue ?? "kalshi", executable: executableFor(ticker) });
      if (!q.ok) {
        sendJson(res, 200, { ok: false, at: atIso, ticker, code: q.code, message: q.detail });
        return;
      }
      const result = q.result;
      if (!result.quote.ok || result.evBps === null) {
        const retail = retailCrossQuote(result.quote);
        sendJson(res, 200, { ok: false, at: atIso, ticker, code: retail && !retail.ok ? retail.code : "unavailable", message: retail && !retail.ok ? retail.detail : "Protection isn't available on this position right now." });
        return;
      }
      // the tier the holder chose, when the venues funded it; else the quote's default
      const chosen = tier && result.quote.tiers[tier] ? { ...result.quote, ...result.quote.tiers[tier], tier } : result.quote;
      const evBps = chosen.tier === result.quote.tier ? result.evBps : chosen.evCostBps;
      const record = openRecordFor(result, chosen, evBps, atIso, "lock");
      if (!appendOrAlert(holder ? { ...record, holder } : record, ownLedger)) {
        sendJson(res, 500, { ok: false, error: "ledger_write_failed", message: "The record could not be written; nothing was locked." });
        return;
      }
      const receipt = await fillHedge(hedgeRefFor(ticker, holder), chosen.hedge, result.books);
      sendJson(res, 200, {
        ok: true,
        at: atIso,
        ticker,
        ...(holder ? { holder } : {}),
        sideName: result.sideName,
        eventTitle: result.eventTitle,
        eventTimeIso: result.eventTimeIso,
        contracts: chosen.contracts,
        tier: chosen.tier,
        floorCents: chosen.floorCents,
        capCents: chosen.capCents,
        creditCents: chosen.creditCents,
        hedge: receipt ? hedgeViewOf(receipt) : null,
        routing: routingViewOf(result.routing),
      });
    } finally {
      lockInFlight.delete(flight);
    }
    return;
  }
  if (url.pathname === "/api/shadow/unwind/quote") {
    // LEAVE EARLY, PRICED: the holder's open lock sold into the live books on both legs, at this
    // moment, nothing written. The same pricer the schedule uses (earlyClose.ts); the margin before
    // the start that the schedule keeps is the holder's last moment too.
    const ticker = (url.searchParams.get("ticker") ?? "").trim().toUpperCase();
    const lock = ticker ? loadShadowPositions(ownLedger).find((p) => p.ticker === ticker) : undefined;
    const refusal = unwindRefusal(lock, ticker, Date.now());
    if (refusal || !lock) {
      sendJson(res, refusal?.status ?? 404, { at: atIso, ticker, ...refusal?.body });
      return;
    }
    const q = quoteEarlyClose(closeTermsOf(lock), await closeBooksFn(lock));
    if (!q.ok) {
      sendJson(res, 200, { ok: false, at: atIso, ticker, code: q.code, leg: q.leg, message: `${q.leg === "position" ? "Your side's" : "The hedge's"} book cannot take the size right now: ${q.detail}.` });
      return;
    }
    sendJson(res, 200, { ok: true, at: atIso, ticker, ...(holder ? { holder } : {}), lastIso: new Date(Date.parse(lock.eventTimeIso) - earlyCloseRule.marginMs).toISOString(), unwind: unwindViewOf(lock, q) });
    return;
  }
  if (url.pathname === "/api/shadow/unwind") {
    // LEAVE EARLY, DONE: quote again at the tap (the books moved since the holder read them), sell
    // the hedge back through the executor (sellHedge: live on an armed ticker, simulated elsewhere),
    // write the close line with source "unwind" at what the sale fetched, answer with what was written.
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "POST a JSON body {ticker}" });
      return;
    }
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    const ticker = String(body?.ticker ?? "").trim().toUpperCase();
    if (!ticker) {
      sendJson(res, 400, { ok: false, error: "bad_request", message: "ticker names the lock" });
      return;
    }
    const flight = inFlightKey(holder, ticker);
    if (lockInFlight.has(flight)) {
      sendJson(res, 409, { ok: false, error: "lock_in_flight", message: "This position is being written right now." });
      return;
    }
    lockInFlight.add(flight);
    try {
      const lock = loadShadowPositions(ownLedger).find((p) => p.ticker === ticker);
      const refusal = unwindRefusal(lock, ticker, Date.now());
      if (refusal || !lock) {
        sendJson(res, refusal?.status ?? 404, { at: atIso, ticker, ...refusal?.body });
        return;
      }
      const q = quoteEarlyClose(closeTermsOf(lock), await closeBooksFn(lock));
      const at = new Date().toISOString();
      if (!q.ok) {
        // the attempt is on the record, as the schedule's are; the position stays open and the holder may try again
        appendOrAlert({ type: "close", at, ticker, priced: false, reason: `${q.leg} leg: ${q.detail}`, source: "unwind" }, ownLedger);
        sendJson(res, 200, { ok: false, at, ticker, code: q.code, leg: q.leg, message: `${q.leg === "position" ? "Your side's" : "The hedge's"} book cannot take the size right now: ${q.detail}. Nothing was closed.` });
        return;
      }
      const sale = await sellHedge(ticker, hedgeRefFor(ticker, holder), lock, q);
      if (!appendOrAlert({ type: "close", at, ticker, priced: true, source: "unwind", hedgeSent: sale.sent, ...closeLinesOf(sale.q) }, ownLedger)) {
        sendJson(res, 500, { ok: false, error: "ledger_write_failed", message: `The record could not be written; nothing was closed on the record${sale.sent ? ", though the hedge sale went to the venue" : ""}.` });
        return;
      }
      const closed = loadShadowPositions(ownLedger).find((p) => p.ticker === ticker)!;
      sendJson(res, 200, {
        ok: true,
        at,
        ticker,
        ...(holder ? { holder } : {}),
        status: closed.status,
        unwind: unwindViewOf(lock, sale.q),
        hedge: { sent: sale.sent, note: sale.note, ...(sale.receipt ? { sale: hedgeViewOf(sale.receipt) } : {}) },
        cash: cashDue(closed),
      });
    } finally {
      lockInFlight.delete(flight);
    }
    return;
  }
  if (url.pathname === "/api/shadow/receipt") {
    // The holder's receipt for one lock, any time after the tap: the terms as written and the
    // hedge that stands behind them (hedgeViewOf). The client opens this under "receipt".
    const ticker = (url.searchParams.get("ticker") ?? "").trim().toUpperCase();
    const lock = ticker ? loadShadowPositions(ownLedger).find((p) => p.ticker === ticker) : undefined;
    if (!lock) {
      sendJson(res, 404, { ok: false, error: "no_lock", message: ticker ? "This market is not on the record." : "?ticker= names the lock" });
      return;
    }
    const receipt = receiptForLock(hedgeRefFor(ticker, holder), lock.at);
    const sale = lock.status === "closed" && lock.closeSource === "unwind" ? receiptForLock(hedgeRefFor(ticker, holder), lock.at, "sell") : null;
    sendJson(res, 200, {
      ok: true,
      at: atIso,
      ticker,
      ...(holder ? { holder } : {}),
      lock: {
        at: lock.at,
        status: lock.status,
        contracts: lock.contracts,
        floorCents: lock.floorCents,
        capCents: lock.capCents,
        creditCents: lock.creditCents,
        eventTimeIso: lock.eventTimeIso,
        ...(lock.generation ? { generation: lock.generation } : {}),
        ...(lock.tier ? { tier: lock.tier } : {}),
        ...(lock.result ? { result: lock.result, protectedCents: lock.protectedCents, nakedCents: lock.nakedCents, settledAt: lock.settledAt } : {}),
        ...closedViewOf(lock),
      },
      hedge: receipt ? hedgeViewOf(receipt) : null,
      // the hedge sold back when the holder left early: the sale's receipt (sent or simulated); null otherwise
      hedgeSale: sale ? hedgeViewOf(sale) : null,
      // where the hedge went against the holder's venue and why, with the tails in the venue's words; null on locks before routing was judged
      routing: routingViewOf(lock.routing),
      // what the lock owes and what has been paid, leg by leg; the payments' references stay in the ledger
      cash: cashDue(lock),
    });
    return;
  }
  sendJson(res, 404, { ok: false, error: "not found" });
}

/** What the Kalshi account still needs before a pod can trade a subaccount of ours, as plain sentences. */
function kalshiAccountAdvice(s: KalshiAccountSnapshot, keys: KalshiApiKeyInfo[]): string[] {
  const out: string[] = [];
  const numbered = [...new Set(s.subaccounts.filter((b) => b.subaccount > 0).map((b) => b.subaccount))].sort((a, b) => a - b);
  if (!s.tier.canCreateSubaccounts) {
    out.push(`tier is ${s.tier.usageTier}: creating a subaccount needs Advanced. /api/shadow/kalshi/account/upgrade?confirm=yes grants it for good once one of the account's last 100 orders was placed through the API (a live hedge counts)`);
  }
  if (numbered.length === 0) {
    out.push("no numbered subaccount yet. /api/shadow/kalshi/subaccounts?confirm=yes&shard=0 creates subaccount 1 on the default shard; again with shard=3 provisions the same number for basketball");
  }
  for (const n of numbered) {
    for (const shard of [0, 3]) {
      const here = s.subaccounts.find((b) => b.subaccount === n && b.exchangeIndex === shard);
      if (!here || here.cents <= 0) {
        const primary = s.byShard.find((b) => b.exchangeIndex === shard)?.cents ?? 0;
        out.push(
          primary > 0
            ? `subaccount ${n} holds nothing on shard ${shard} (${KALSHI_SHARDS[shard]}); the primary has ${primary}c there. /api/shadow/kalshi/subaccounts/transfer?confirm=yes&from=0&to=${n}&cents=…&shard=${shard}`
            : `subaccount ${n} and the primary both hold nothing on shard ${shard} (${KALSHI_SHARDS[shard]}). /api/shadow/kalshi/shards/transfer?confirm=yes&fromShard=0&toShard=${shard}&cents=… first, then fund the subaccount`,
        );
      }
    }
  }
  if (numbered.length > 0) {
    const n = numbered[0];
    const restricted = keys.find((k) => k.subaccount === n);
    if (!restricted) {
      out.push(`no API key is restricted to subaccount ${n}. /api/shadow/kalshi/keys?confirm=yes&name=parlayx-pod&subaccount=${n} mints one (private key shown once); that key id and private key are what the pod connects Kalshi with`);
    } else if (out.length === 0) {
      out.push(`subaccount ${n} is funded on shards 0 and 3 and key "${restricted.name}" (…${restricted.apiKeyId.slice(-6)}) is restricted to it. Give that key id and its private key to the pod when connecting Kalshi; the pod then trades only that cash`);
    }
  }
  return out;
}

/**
 * The Kalshi account routes (operator): the account the hedge key signs for, as the pod will use it.
 *   /api/shadow/kalshi/account                 tier and grants, cash per shard, every subaccount's cash per shard, the API keys, what to do next
 *   /api/shadow/kalshi/account/upgrade         ask Kalshi for the permanent Advanced grant (403 from Kalshi = no API order among the last 100)
 *   /api/shadow/kalshi/subaccounts             shard=0        create the next numbered subaccount on that shard (again with another shard provisions it there)
 *   /api/shadow/kalshi/subaccounts/transfer    from, to, cents, shard?       cash between subaccounts on one shard
 *   /api/shadow/kalshi/shards/transfer         fromShard, toShard, cents     the primary's cash from one shard to another
 *   /api/shadow/kalshi/keys                    (read) the API keys; (write) name, subaccount?, keyType?   mint a key, restricted to a subaccount when given
 *   /api/shadow/kalshi/keys/delete             id                            revoke a key
 * A write is a POST with a JSON body, or — so the operator can act from a browser tab — a GET with
 * `confirm=yes` and the same fields in the query. Every write answers with a fresh snapshot; a minted
 * key's private half is in that one answer and nowhere else. Nothing here places an order.
 */
async function handleKalshiAccount(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!kalshiAccount) {
    sendJson(res, 503, { ok: false, error: "no_kalshi_key", message: "KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY_PEM are not set in the service env; the account routes need the account owner's key" });
    return;
  }
  const at = new Date().toISOString();
  const snapshotBody = async (extra: Record<string, unknown> = {}) => {
    const [s, keysRead] = await Promise.all([kalshiAccount.snapshot(), kalshiAccount.listApiKeys().then((k) => ({ ok: true as const, keys: k })).catch((err: unknown) => ({ ok: false as const, error: String(err instanceof Error ? err.message : err) }))]);
    const keys = keysRead.ok ? keysRead.keys : [];
    return {
      ok: true,
      at,
      ...extra,
      tier: s.tier,
      balanceCents: s.balanceCents,
      byShard: s.byShard.map((b) => ({ ...b, name: KALSHI_SHARDS[b.exchangeIndex] ?? "unlisted" })),
      subaccounts: s.subaccounts.map((b) => ({ ...b, shard: KALSHI_SHARDS[b.exchangeIndex] ?? "unlisted" })),
      shards: KALSHI_SHARDS,
      apiKeys: keysRead.ok ? keys.map((k) => ({ ...k, thisService: k.apiKeyId === kalshiAccountCreds?.apiKeyId })) : { error: keysRead.error },
      next: kalshiAccountAdvice(s, keys),
    };
  };
  const venueError = (err: unknown) => {
    if (err instanceof KalshiApiError) {
      sendJson(res, 502, { ok: false, error: "kalshi_refused", status: err.status, message: err.message });
      return;
    }
    sendJson(res, 502, { ok: false, error: "kalshi_unreachable", message: String(err instanceof Error ? err.message : err) });
  };
  // a write: POST with a JSON body, or GET ...&confirm=yes with the fields in the query
  const isPost = req.method === "POST";
  const body = isPost ? (((await readJsonBody(req)) ?? {}) as Record<string, unknown>) : {};
  const confirmed = isPost || url.searchParams.get("confirm") === "yes";
  const field = (k: string): unknown => (body[k] !== undefined ? body[k] : url.searchParams.has(k) ? url.searchParams.get(k) : undefined);
  const int = (k: string): number | null => {
    const raw = field(k);
    const v = typeof raw === "number" ? raw : Number(raw);
    return raw !== undefined && raw !== "" && Number.isInteger(v) ? v : null;
  };
  const str = (k: string): string => String(field(k) ?? "").trim();
  const mustConfirm = (fields: string): boolean => {
    if (confirmed) return true;
    const query = fields
      .split(", ")
      .filter(Boolean)
      .map((f) => `&${f.replace(/\?$/, "")}=…`)
      .join("");
    sendJson(res, 405, {
      ok: false,
      error: "confirm_required",
      message: `this writes to the Kalshi account. POST ${url.pathname} with a JSON body {${fields}}, or GET ${url.pathname}?confirm=yes${query} with the operator token`,
    });
    return false;
  };
  try {
    if (url.pathname === "/api/shadow/kalshi/account") {
      sendJson(res, 200, await snapshotBody());
      return;
    }
    if (url.pathname === "/api/shadow/kalshi/account/upgrade") {
      if (!mustConfirm("")) return;
      const r = await kalshiAccount.upgradeToAdvanced();
      sendJson(res, r.ok ? 200 : 409, { ok: r.ok, at, upgrade: r.ok ? { status: r.status, granted: "advanced", permanent: true } : { status: r.status, reason: r.reason }, tier: r.tier });
      return;
    }
    if (url.pathname === "/api/shadow/kalshi/subaccounts") {
      if (!mustConfirm("shard")) return;
      const shard = field("shard") === undefined ? 0 : int("shard");
      if (shard === null || shard < 0 || shard > 100) {
        sendJson(res, 400, { ok: false, error: "bad_request", message: "shard must be a whole number (0 default/NFL, 3 basketball)" });
        return;
      }
      const created = await kalshiAccount.createSubaccount(shard);
      sendJson(res, 201, await snapshotBody({ created: { ...created, shard: KALSHI_SHARDS[shard] ?? "unlisted" } }));
      return;
    }
    if (url.pathname === "/api/shadow/kalshi/subaccounts/transfer") {
      if (!mustConfirm("from, to, cents, shard?")) return;
      const from = int("from");
      const to = int("to");
      const cents = int("cents");
      const shard = field("shard") === undefined ? 0 : int("shard");
      if (from === null || to === null || cents === null || shard === null || cents <= 0 || from < 0 || to < 0 || from > 63 || to > 63 || from === to) {
        sendJson(res, 400, { ok: false, error: "bad_request", message: "from and to are subaccount numbers 0-63 (0 = primary), different; cents a positive whole number; shard optional (default 0)" });
        return;
      }
      const t = await kalshiAccount.transferBetweenSubaccounts({ from, to, cents, exchangeIndex: shard });
      sendJson(res, 200, await snapshotBody({ transfer: { from, to, cents, shard, name: KALSHI_SHARDS[shard] ?? "unlisted", ...t } }));
      return;
    }
    if (url.pathname === "/api/shadow/kalshi/shards/transfer") {
      if (!mustConfirm("fromShard, toShard, cents")) return;
      const fromShard = int("fromShard");
      const toShard = int("toShard");
      const cents = int("cents");
      if (fromShard === null || toShard === null || cents === null || cents <= 0 || fromShard < 0 || toShard < 0 || fromShard === toShard) {
        sendJson(res, 400, { ok: false, error: "bad_request", message: "fromShard and toShard are shard numbers (0 default/NFL, 3 basketball), different; cents a positive whole number" });
        return;
      }
      const t = await kalshiAccount.transferBetweenShards({ fromShard, toShard, cents });
      // Kalshi applies it asynchronously; the snapshot may still show the old split for a moment
      sendJson(res, 202, await snapshotBody({ transfer: { fromShard, toShard, cents, ...t, note: "applied asynchronously by the venue; read /api/shadow/kalshi/account again" } }));
      return;
    }
    if (url.pathname === "/api/shadow/kalshi/keys") {
      if (!confirmed) {
        // the read: every key, which subaccount each is locked to, which one is this service's
        const keys = await kalshiAccount.listApiKeys();
        sendJson(res, 200, {
          ok: true,
          at,
          apiKeys: keys.map((k) => ({ ...k, thisService: k.apiKeyId === kalshiAccountCreds?.apiKeyId })),
          mint: "POST /api/shadow/kalshi/keys {name, subaccount?, keyType?} or GET …/keys?confirm=yes&name=parlayx-pod&subaccount=1; the private key is shown once",
        });
        return;
      }
      const name = str("name");
      const subaccount = field("subaccount") === undefined || field("subaccount") === "" ? undefined : int("subaccount");
      const keyTypeRaw = str("keyType").toLowerCase();
      const keyType = keyTypeRaw === "ed25519" ? "ed25519" : keyTypeRaw === "" || keyTypeRaw === "rsa" ? "rsa" : null;
      if (!name || name.length > 64 || subaccount === null || (subaccount !== undefined && (subaccount < 0 || subaccount > 63)) || keyType === null) {
        sendJson(res, 400, { ok: false, error: "bad_request", message: "name (1-64 chars) is required; subaccount optional 0-63 (restricts the key to that subaccount); keyType optional rsa (default) or ed25519" });
        return;
      }
      const minted = await kalshiAccount.generateApiKey({ name, subaccount, keyType });
      const { privateKeyPem, ...info } = minted;
      sendJson(
        res,
        201,
        await snapshotBody({
          minted: {
            ...info,
            privateKeyPem,
            shownOnce: "Kalshi does not store this private key and neither do we. Copy the key id and the private key into the pod's Kalshi connection now; this answer cannot be fetched again",
            restricted: subaccount !== undefined ? `this key can read and trade subaccount ${subaccount} only; it cannot move cash or touch other subaccounts` : "this key is unrestricted: the whole account",
          },
        }),
      );
      return;
    }
    if (url.pathname === "/api/shadow/kalshi/keys/delete") {
      if (!mustConfirm("id")) return;
      const id = str("id");
      if (!id) {
        sendJson(res, 400, { ok: false, error: "bad_request", message: "id names the key to revoke" });
        return;
      }
      if (id === kalshiAccountCreds?.apiKeyId) {
        sendJson(res, 409, { ok: false, error: "own_key", message: "that is the key this service signs with; revoke it from Kalshi's own page if you mean to" });
        return;
      }
      await kalshiAccount.deleteApiKey(id);
      sendJson(res, 200, await snapshotBody({ revoked: { apiKeyId: id } }));
      return;
    }
    sendJson(res, 404, { ok: false, error: "not_found" });
  } catch (err) {
    venueError(err);
  }
}

/**
 * GET /api/shadow/hedges/pod (operator): the aggregator's side of the live hedge, read with the
 * TRADE key: who the key is (pod, capabilities), the pod's Kalshi cash, the positions the pod
 * holds, and the receipts on our trail that went this way. ?ticker= narrows the positions. The
 * second book a hedge is on, read from the second book.
 */
async function handlePod(res: ServerResponse, url: URL): Promise<void> {
  const at = new Date().toISOString();
  const client = hedgeChoice.aggregatorOrders;
  const receipts = loadHedgeReceipts(RECEIPTS_PATH).filter((r) => r.fill?.via === "aggregator");
  if (!client) {
    sendJson(res, 200, {
      ok: true,
      at,
      configured: false,
      via: hedgeChoice.live?.via ?? null,
      message:
        hedgeChoice.strategy !== "live"
          ? "not in live mode"
          : hedgeChoice.live?.via !== "aggregator"
            ? "EVENT_HEDGE_LIVE_VIA is not aggregator; orders go direct"
            : "EVENT_HEDGE_LIVE_VIA=aggregator but no AGGREGATOR_TRADE_KEY_ID / AGGREGATOR_TRADE_PRIVATE_KEY_HEX",
      receipts: { viaAggregator: receipts.length },
    });
    return;
  }
  const ticker = (url.searchParams.get("ticker") ?? "").trim().toUpperCase() || undefined;
  const settle = async <T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string; status?: number; code?: string }> =>
    p.then((value) => ({ ok: true as const, value })).catch((err: unknown) => (err instanceof AggregatorApiError ? { ok: false as const, error: err.message, status: err.status, code: err.code } : { ok: false as const, error: String(err instanceof Error ? err.message : err) }));
  const [identity, available, positions] = await Promise.all([settle(client.whoami()), settle(client.availableCents()), settle(client.positions(ticker))]);
  const canTrade = identity.ok ? identity.value.capabilities.includes("trade") : null;
  sendJson(res, 200, {
    ok: true,
    at,
    configured: true,
    via: "aggregator",
    key: { id: `…${client.keyId.slice(-4)}`, publicKeyHex: client.publicKeyHex },
    identity: identity.ok ? { podId: identity.value.podId, scope: identity.value.scope, capabilities: identity.value.capabilities, canTrade } : { error: identity.error, status: identity.status, code: identity.code },
    balance: available.ok ? { availableCents: available.value } : { error: available.error, status: available.status, code: available.code },
    positions: positions.ok ? positions.value.map((p) => ({ ...p, shard: shardForTicker(p.ticker) })) : { error: positions.error, status: positions.status, code: positions.code },
    receipts: { viaAggregator: receipts.length, recent: receipts.slice(-20).reverse() },
    live: hedgeChoice.live,
  });
}

/**
 * POST /api/shadow/cash (operator): record that money moved on a lock. Body {ticker, leg, cents,
 * method?, ref?, note?, at?}. The leg must be one the lock owes in its current state: the credit
 * from the tap; the floor once the side has settled lost; the handback once it has settled won.
 * A payment past what is outstanding is refused, so the record cannot say more was paid than
 * was owed. Appends one line to the lock ledger; the holder's receipt reads it from there.
 */
async function handleCash(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "POST /api/shadow/cash {ticker, holder?, leg, cents, method?, ref?, note?, at?} with the operator token" });
    return;
  }
  const body = (await readJsonBody(req)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    sendJson(res, 400, { ok: false, error: "bad_request", message: "a JSON body is required" });
    return;
  }
  const ticker = String(body.ticker ?? "").trim().toUpperCase();
  const leg = String(body.leg ?? "").trim().toLowerCase() as CashLeg;
  const cents = typeof body.cents === "number" ? body.cents : Number(body.cents);
  const at = body.at === undefined ? new Date().toISOString() : String(body.at);
  if (!ticker) {
    sendJson(res, 400, { ok: false, error: "bad_request", message: "ticker names the lock" });
    return;
  }
  if (!CASH_LEGS.includes(leg)) {
    sendJson(res, 400, { ok: false, error: "bad_request", message: `leg must be one of ${CASH_LEGS.join(", ")}` });
    return;
  }
  if (!Number.isInteger(cents) || cents <= 0) {
    sendJson(res, 400, { ok: false, error: "bad_request", message: "cents must be a positive whole number" });
    return;
  }
  if (!Number.isFinite(Date.parse(at))) {
    sendJson(res, 400, { ok: false, error: "bad_request", message: "at must be an ISO time" });
    return;
  }
  // whose lock: `holder` an alias, "" or "shared" for the shared ledger, absent when only one person locked it
  const holderArg = body.holder === undefined || body.holder === null ? undefined : String(body.holder).trim().toLowerCase();
  const found = findLock(ticker, holderArg === undefined ? undefined : holderArg === "" || holderArg === "shared" ? null : holderArg);
  if (!found.ok) {
    sendJson(res, found.status, { ok: false, error: found.error, message: found.message, ...(found.holders ? { holders: found.holders } : {}) });
    return;
  }
  const { lock, path: lockPath, holder } = found;
  const due = cashDue(lock);
  const owed = due.find((d) => d.leg === leg);
  if (!owed) {
    sendJson(res, 409, { ok: false, error: "leg_not_owed", message: `${ticker} owes no ${leg} in its current state (${lock.status}${lock.result ? `, ${lock.result}` : ""})`, cash: due });
    return;
  }
  if (cents > owed.outstandingCents) {
    sendJson(res, 409, { ok: false, error: "overpaid", message: `${leg} has ${owed.outstandingCents} cents outstanding; ${cents} would pay more than is owed`, cash: due });
    return;
  }
  const strOpt = (k: string) => {
    const v = body[k];
    return typeof v === "string" && v.trim() ? { [k]: v.trim().slice(0, 200) } : {};
  };
  const line = { type: "cash" as const, at, ticker, leg, cents, ...strOpt("method"), ...strOpt("ref"), ...strOpt("note") };
  if (!appendOrAlert(line, lockPath)) {
    sendJson(res, 500, { ok: false, error: "ledger_write_failed" });
    return;
  }
  const updated = loadShadowPositions(lockPath).find((p) => p.ticker === ticker)!;
  sendJson(res, 200, { ok: true, at: new Date().toISOString(), ticker, ...(holder ? { holder } : {}), recorded: { at, leg, cents, ...strOpt("method") }, cash: cashDue(updated) });
}

/**
 * GET /api/shadow/holders (operator): every holder with locks on the record (the shared ledger is
 * "(shared)"), each lock's cash legs, and the totals outstanding each way: what the writer still
 * owes the person (credit at the tap, floor on a loss) and what the person owes the writer (the
 * handback on a capped win). The page the operator settles from before a pay run.
 */
function holdersSummary() {
  const byHolder = new Map<string, Array<{ p: ShadowPosition; path: string }>>();
  for (const { p, path, holder } of allLocks()) {
    const k = holder ?? "(shared)";
    if (!byHolder.has(k)) byHolder.set(k, []);
    byHolder.get(k)!.push({ p, path });
  }
  for (const h of HOLDER_KEYS.holders) if (!byHolder.has(h.holder)) byHolder.set(h.holder, []);
  if (LOCK_KEY && !byHolder.has("(shared)")) byHolder.set("(shared)", []);
  const holders = [...byHolder.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([holder, locks]) => {
      let toHolderCents = 0;
      let toWriterCents = 0;
      const rows = locks
        .sort((a, b) => b.p.at.localeCompare(a.p.at))
        .map(({ p, path }) => {
          const cash = cashDue(p);
          for (const c of cash) {
            if (c.to === "holder") toHolderCents += c.outstandingCents;
            else toWriterCents += c.outstandingCents;
          }
          return {
            ticker: p.ticker,
            at: p.at,
            status: p.status,
            ...(p.result ? { result: p.result } : {}),
            eventTitle: p.eventTitle,
            sideName: p.sideName,
            eventTimeIso: p.eventTimeIso,
            contracts: p.contracts,
            entryCents: p.entryCents ?? null,
            floorCents: p.floorCents,
            capCents: p.capCents,
            creditCents: p.creditCents,
            route: p.route,
            cash,
            ledger: path,
          };
        });
      return {
        holder,
        configured: holder === "(shared)" ? Boolean(LOCK_KEY) : HOLDER_KEYS.holders.some((h) => h.holder === holder),
        locks: rows.length,
        open: rows.filter((r) => r.status === "open").length,
        settled: rows.filter((r) => r.status === "settled").length,
        // net of both directions, positive: the writer pays the person this much to be square
        outstanding: { toHolderCents, toWriterCents, netToHolderCents: toHolderCents - toWriterCents },
        positions: rows,
      };
    });
  return {
    ok: true,
    at: new Date().toISOString(),
    holders,
    totals: holders.reduce(
      (t, h) => ({ locks: t.locks + h.locks, toHolderCents: t.toHolderCents + h.outstanding.toHolderCents, toWriterCents: t.toWriterCents + h.outstanding.toWriterCents }),
      { locks: 0, toHolderCents: 0, toWriterCents: 0 },
    ),
  };
}

/**
 * POST /api/shadow/lock/reset?ticker=&holder= (operator): take one holder's lock off the record so the
 * market can be locked again. The lock's lines move to an archive file beside the ledger (never
 * deleted; the operator export still reaches them), other holders' locks stand, the hedge trail
 * is untouched. The venue position behind the old lock is the operator's to settle by hand.
 */
function handleLockReset(req: IncomingMessage, res: ServerResponse, url: URL): void {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "POST /api/shadow/lock/reset?ticker=KX...&holder= with the operator token" });
    return;
  }
  const ticker = (url.searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) {
    sendJson(res, 404, { ok: false, error: "no_lock", message: "?ticker= names the lock" });
    return;
  }
  const found = findLock(ticker, holderParam(url));
  if (!found.ok) {
    sendJson(res, found.status, { ok: false, error: found.error, message: found.message, ...(found.holders ? { holders: found.holders } : {}) });
    return;
  }
  const { lock, path: lockPath, holder } = found;
  if (lockInFlight.has(inFlightKey(holder, ticker))) {
    sendJson(res, 409, { ok: false, error: "lock_in_flight", message: "This position is being locked right now." });
    return;
  }
  const atIso = new Date().toISOString();
  const archived = archiveLedgerLines(lockPath, (rec) => rec.ticker === ticker, ticker, atIso);
  const ref = hedgeRefFor(ticker, holder);
  const liveFills = loadHedgeReceipts(RECEIPTS_PATH)
    .filter((r) => r.ref === ref && r.at >= lock.at && r.fill && !r.fill.simulated)
    .map((r) => ({ receiptId: r.id, at: r.at, orderId: r.fill?.ids.orderId ?? null, unitsMilli: r.fill?.unitsMilli ?? 0, costCents: r.fill?.costCents ?? 0 }));
  sendJson(res, 200, {
    ok: true,
    at: atIso,
    ticker,
    ...(holder ? { holder } : {}),
    archived: { to: archived.archivedTo, records: archived.moved, kept: archived.kept },
    lock: { at: lock.at, status: lock.status, contracts: lock.contracts, floorCents: lock.floorCents, capCents: lock.capCents, creditCents: lock.creditCents },
    // what the venue still holds for the lock just taken off the record: the operator's to sell or keep
    liveFills,
    message: liveFills.length
      ? `lock archived; the market can be locked again. ${liveFills.length} live fill(s) remain at the venue for the old lock.`
      : "lock archived; the market can be locked again.",
  });
}

/**
 * POST /api/shadow/hedges/resend?ticker=&holder= (operator): a lock whose hedge never reached the venue
 * (the trail shows a simulated fill, e.g. the venue refused the order) is hedged again. The same
 * position is priced on Kalshi's own No side now and sent through the executor and its rails; one
 * more receipt lands on the trail under the same ref. The lock's terms do not move: the record is
 * as quoted at the tap. Refused while a live fill is already on the trail for it unless ?force=1.
 */
async function handleHedgeResend(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "POST /api/shadow/hedges/resend?ticker=KX... with the operator token; nothing is sent on GET" });
    return;
  }
  if (!quoteOneFn) {
    sendJson(res, 503, { ok: false, error: "engine_not_ready", message: "the scanner is still loading" });
    return;
  }
  const ticker = (url.searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) {
    sendJson(res, 404, { ok: false, error: "no_lock", message: "?ticker= names the lock" });
    return;
  }
  const found = findLock(ticker, holderParam(url));
  if (!found.ok) {
    sendJson(res, found.status, { ok: false, error: found.error, message: found.message, ...(found.holders ? { holders: found.holders } : {}) });
    return;
  }
  const { lock, holder } = found;
  if (lock.status !== "open") {
    sendJson(res, 409, { ok: false, error: "not_open", message: `the lock on ${ticker} is ${lock.status}; only an open lock is hedged again` });
    return;
  }
  const ref = hedgeRefFor(ticker, holder);
  const prior = loadHedgeReceipts(RECEIPTS_PATH).filter((r) => r.ref === ref);
  const liveFills = prior
    .filter((r) => r.fill && !r.fill.simulated)
    .map((r) => ({ receiptId: r.id, at: r.at, orderId: r.fill?.ids.orderId ?? null, unitsMilli: r.fill?.unitsMilli ?? 0, costCents: r.fill?.costCents ?? 0 }));
  if (liveFills.length > 0 && url.searchParams.get("force") !== "1") {
    sendJson(res, 409, { ok: false, error: "already_live", message: `the venue already holds a fill for ${ticker}; ?force=1 to send another`, liveFills });
    return;
  }
  const flight = inFlightKey(holder, ticker);
  if (lockInFlight.has(flight)) {
    sendJson(res, 409, { ok: false, error: "lock_in_flight", message: "This position is being locked right now." });
    return;
  }
  lockInFlight.add(flight);
  try {
    const atIso = new Date().toISOString();
    const q = await quoteOneFn({ ticker, contracts: lock.contracts, entryCents: lock.entryCents, route: "kalshi_self", holderVenue: lock.holderVenue ?? "kalshi", executable: executableFor(ticker) });
    if (!q.ok) {
      sendJson(res, 200, { ok: false, at: atIso, ticker, code: q.code, message: q.detail });
      return;
    }
    const result = q.result;
    if (!result.quote.ok) {
      sendJson(res, 200, { ok: false, at: atIso, ticker, code: result.quote.code, message: result.quote.detail });
      return;
    }
    const chosen = lock.tier && result.quote.tiers[lock.tier] ? { ...result.quote, ...result.quote.tiers[lock.tier], tier: lock.tier } : result.quote;
    const receipt = await fillHedge(ref, chosen.hedge, result.books);
    sendJson(res, receipt ? 200 : 502, {
      ok: Boolean(receipt),
      at: atIso,
      ticker,
      ...(holder ? { holder } : {}),
      allowlisted: tickerIsArmed(ticker),
      lock: {
        at: lock.at,
        contracts: lock.contracts,
        entryCents: lock.entryCents ?? null,
        tier: lock.tier ?? null,
        floorCents: lock.floorCents,
        capCents: lock.capCents,
        creditCents: lock.creditCents,
        hedgeUnitsMilli: lock.hedgeUnitsMilli ?? null,
        hedgeCostCents: lock.hedgeCostCents,
      },
      // the same position on this moment's book: what the hedge is sized and priced at now
      repriced: {
        tier: chosen.tier,
        floorCents: chosen.floorCents,
        capCents: chosen.capCents,
        creditCents: chosen.creditCents,
        hedgeUnitsMilli: "sharesMilli" in chosen.hedge ? chosen.hedge.sharesMilli : chosen.hedge.contractsMilli,
        hedgeCostCents: chosen.hedge.costCents + chosen.feesCents,
      },
      priorReceipts: prior.length,
      hedge: receipt
        ? {
            route: result.route,
            outcome: receipt.outcome,
            simulated: receipt.fill?.simulated ?? true,
            unitsMilli: receipt.fill?.unitsMilli ?? null,
            costCents: receipt.fill?.costCents ?? null,
            orderId: receipt.fill?.ids.orderId ?? null,
            via: receipt.fill && !receipt.fill.simulated ? (receipt.fill.via ?? "direct") : "book",
            fallbackReason: receipt.fallbackReason,
            receiptId: receipt.id,
            attempts: receipt.attempts.map((a) => ({ step: a.step, ok: a.ok, detail: a.detail })),
          }
        : null,
      ...(receipt ? {} : { error: "hedge_failed", message: lastScanError }),
    });
  } finally {
    lockInFlight.delete(flight);
  }
}

/** Open one simulated position for every quotable board row we have not seen. */
async function scanTick(): Promise<void> {
  if (!scan) return;
  try {
    const book = loadShadowPositions(LEDGER_PATH);
    const seen = new Set(book.map((p) => p.ticker));
    // Tickers armed for a live hedge belong to the tap, not the scan; a market a holder locked stays theirs.
    for (const t of hedgeChoice.live?.allowlist ?? []) seen.add(t);
    for (const { p } of allLocks()) seen.add(p.ticker);
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
      appendOrAlert(openRecordFor(res, q, evBps, state.atIso));
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
  const onBoth = ledgerPaths().flatMap((path) => loadShadowPositions(path).map((p) => ({ p, path })));
  for (const { p, path } of onBoth) {
    if (p.status !== "open") continue;
    const eventMs = Date.parse(p.eventTimeIso);
    if (!Number.isFinite(eventMs) || now < eventMs + SETTLE_GRACE_MS) continue;
    due += 1;
    try {
      const r = await getMarketResult(p.ticker);
      if (r.result === "yes" || r.result === "no") {
        const at = new Date().toISOString();
        // the same read that carries the result carries the rule; compared to the pin, said either way
        const ruleCheck = checkRule(p.rule, kalshiRuleText(r), at);
        if (ruleCheck.unchanged === false) {
          void alerter({ kind: "rule_changed", message: `${p.ticker} (${p.eventTitle}) settled ${r.result} under a rule text that changed since open: ${p.rule?.sha256.slice(0, 12)} -> ${ruleCheck.sha256?.slice(0, 12)}` });
        }
        appendOrAlert(
          {
            type: "settle",
            at,
            ticker: p.ticker,
            result: r.result,
            ruleCheck,
          },
          path,
        );
      } else if (now > eventMs + VOID_AFTER_MS) {
        const reason = `no official result ${Math.round(VOID_AFTER_MS / 3_600_000)}h after the event`;
        if (appendOrAlert({ type: "void", at: new Date().toISOString(), ticker: p.ticker, reason }, path)) {
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
      const q = quoteEarlyClose(closeTermsOf(p), await closeBooksFn(p));
      const at = new Date().toISOString();
      if (!q.ok) {
        appendOrAlert({ type: "close", at, ticker: p.ticker, priced: false, reason: `${q.leg} leg: ${q.detail}` });
        continue;
      }
      appendOrAlert({ type: "close", at, ticker: p.ticker, priced: true, ...closeLinesOf(q) });
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

/**
 * Price every open game that is inside the pre-lock window and has no pre-lock read yet: the
 * engine's own quote path (fresh books from the feed, then the venues, plus every reference),
 * then both routes and each reference re-priced at the position's size. The read is appended to
 * the position's own ledger. A read the engine refuses for a reason that will not change before
 * the lock (the market closed, the odds out of range) is written as `unread` so it is not asked
 * again; a venue that is unreachable is retried next tick.
 */
async function rereadTick(): Promise<void> {
  if (!quoteOneFn || REREAD_HOURS <= 0 || rereadInFlight) return;
  rereadInFlight = true;
  const now = Date.now();
  let due = 0;
  let written = 0;
  let failed = 0;
  try {
    const onBoth = ledgerPaths().flatMap((path) => loadShadowPositions(path).map((p) => ({ p, path })));
    for (const { p, path } of onBoth) {
      if (p.status !== "open" || p.kind !== "sports" || p.prelock) continue;
      const eventMs = Date.parse(p.eventTimeIso);
      if (!Number.isFinite(eventMs) || eventMs <= now || eventMs - now > REREAD_HOURS * 3_600_000) continue;
      due += 1;
      if (written + failed >= REREAD_MAX_PER_TICK) continue;
      try {
        const q = await quoteOneFn({ ticker: p.ticker, contracts: p.contracts, entryCents: p.entryCents });
        const at = new Date().toISOString();
        const hoursToLock = Math.round(((eventMs - Date.parse(at)) / 3_600_000) * 10) / 10;
        if (!q.ok) {
          // a structural refusal (the engine checks the market and the window before any book): final for this position
          if (appendOrAlert({ type: "reread", at, ticker: p.ticker, phase: "prelock", hoursToLock, unread: q.code }, path)) written += 1;
          continue;
        }
        const res = q.result;
        const { routes, references } = rereadQuotesFor({
          route: p.route,
          ticker: p.ticker,
          lockTimeIso: p.eventTimeIso,
          pair: res.pair,
          markCents: res.markCents,
          entryCents: p.entryCents ?? res.markCents,
          contracts: p.contracts,
          now: new Date(at),
          config: searchConfig(),
          books: res.books,
          prophetxFeeBps: PROPHETX_FEE_BPS,
        });
        const ok = appendOrAlert(
          {
            type: "reread",
            at,
            ticker: p.ticker,
            phase: "prelock",
            hoursToLock,
            markCents: res.markCents,
            routes,
            ...(references ? { references } : {}),
            ...(res.bookOrigins ? { bookOrigins: res.bookOrigins } : {}),
          },
          path,
        );
        if (ok) written += 1;
      } catch (err) {
        // the venues unreachable for this one; due again next tick
        failed += 1;
        lastRereadError = `${p.ticker}: ${String(err instanceof Error ? err.message : err)}`;
      }
    }
    if (failed === 0) lastRereadError = null;
  } finally {
    rereadInFlight = false;
    rereadDueLastTick = due;
    rereadWrittenLastTick = written;
    lastRereadAt = new Date().toISOString();
  }
}

/** The hold key for one game's reference venue, and back. */
const holdKey = (ticker: string, id: ReferenceBookId) => `${ticker}|${id}`;
const splitHoldKey = (key: string): { ticker: string; id: ReferenceBookId } => {
  const i = key.lastIndexOf("|");
  return { ticker: key.slice(0, i), id: key.slice(i + 1) as ReferenceBookId };
};

/** The stream's open event lands in the queue; pricing it reads the venues, which happens off the stream's thread. */
function onHeldBookOpen(ev: HeldBookOpen): void {
  openQueue.push({ ev, attempts: 0 });
  void drainOpens();
}

const releaseHolds = (ticker: string) => {
  const h = holdsByTicker.get(ticker);
  if (!h) return;
  for (const k of h.keys) heldBooksConn?.release(k);
  holdsByTicker.delete(ticker);
};

/**
 * Price every open the stream reported, in order: the engine's own quote path at the position's
 * size, then both routes and every reference re-priced, written as a `book_open` re-read with
 * which venue opened and how. A structural refusal is written as `unread`; venues unreachable
 * are tried again next tick, a few times. Either way the game's holds are then released: one
 * open per position is the measure.
 */
async function drainOpens(): Promise<void> {
  if (openDraining || !quoteOneFn) return;
  openDraining = true;
  try {
    const retry: typeof openQueue = [];
    while (openQueue.length) {
      const item = openQueue.shift()!;
      const { ticker, id } = splitHoldKey(item.ev.key);
      const hold = holdsByTicker.get(ticker);
      const pos = hold ? loadShadowPositions(hold.path).find((p) => p.ticker === ticker) : undefined;
      if (!hold || !pos || pos.bookOpen || pos.status !== "open") {
        releaseHolds(ticker);
        continue;
      }
      const asks = [...item.ev.book.asks].sort((a, b) => a.price - b.price);
      const bids = [...item.ev.book.bids].sort((a, b) => b.price - a.price);
      const opened: ShadowBookOpened = {
        venue: id,
        caught: item.ev.caught,
        heldSinceIso: item.ev.sinceIso,
        bestAskCents: asks[0] ? Math.round(asks[0].price * 100) : null,
        bestBidCents: bids[0] ? Math.round(bids[0].price * 100) : null,
        depthShares: Math.floor(asks.reduce((s, l) => s + l.size, 0)),
      };
      const eventMs = Date.parse(pos.eventTimeIso);
      try {
        const q = await quoteOneFn({ ticker, contracts: pos.contracts, entryCents: pos.entryCents });
        const at = new Date().toISOString();
        const hoursToLock = Math.round(((eventMs - Date.parse(at)) / 3_600_000) * 10) / 10;
        if (!q.ok) {
          if (appendOrAlert({ type: "reread", at, ticker, phase: "book_open", hoursToLock, unread: q.code, opened }, hold.path)) bookOpensWritten += 1;
        } else {
          const res = q.result;
          const { routes, references } = rereadQuotesFor({
            route: pos.route,
            ticker,
            lockTimeIso: pos.eventTimeIso,
            pair: res.pair,
            markCents: res.markCents,
            entryCents: pos.entryCents ?? res.markCents,
            contracts: pos.contracts,
            now: new Date(at),
            config: searchConfig(),
            books: res.books,
            prophetxFeeBps: PROPHETX_FEE_BPS,
          });
          const ok = appendOrAlert(
            {
              type: "reread",
              at,
              ticker,
              phase: "book_open",
              hoursToLock,
              markCents: res.markCents,
              routes,
              ...(references ? { references } : {}),
              ...(res.bookOrigins ? { bookOrigins: res.bookOrigins } : {}),
              opened,
            },
            hold.path,
          );
          if (ok) bookOpensWritten += 1;
        }
        releaseHolds(ticker);
      } catch (err) {
        lastHoldError = `${ticker} open: ${String(err instanceof Error ? err.message : err)}`;
        if (item.attempts + 1 < BOOK_OPEN_MAX_ATTEMPTS) retry.push({ ev: item.ev, attempts: item.attempts + 1 });
        else releaseHolds(ticker);
      }
    }
    openQueue.push(...retry);
  } finally {
    openDraining = false;
  }
}

/**
 * Reconcile the holds with the ledgers: every open game inside the hold window that has no
 * book-open read yet is held (one subscription per reference venue the feed lists for its
 * opposing outcome); a game that left the window, settled, or has its read is released. A game
 * the feed has no reference listing for yet is asked about again next tick, through the source's
 * cached lookup. Then any opens waiting are priced.
 */
async function holdTick(): Promise<void> {
  if (!heldSource || HOLD_HOURS <= 0 || !quoteOneFn) return;
  if (!heldBooksConn) heldBooksConn = heldSource.heldBooks({ onOpen: onHeldBookOpen, onLog: (l) => console.log(`[event-shadow] ${l}`) });
  const now = Date.now();
  const wanted = new Map<string, { path: string; p: ShadowPosition }>();
  let notMapped = 0;
  lastHoldError = null;
  try {
    for (const path of ledgerPaths()) {
      for (const p of loadShadowPositions(path)) {
        if (p.status !== "open" || p.kind !== "sports" || p.bookOpen) continue;
        const eventMs = Date.parse(p.eventTimeIso);
        if (!Number.isFinite(eventMs) || eventMs <= now || eventMs - now > HOLD_HOURS * 3_600_000) continue;
        wanted.set(p.ticker, { path, p });
      }
    }
    for (const ticker of [...holdsByTicker.keys()]) if (!wanted.has(ticker)) releaseHolds(ticker);
    let looked = 0;
    for (const [ticker, { path }] of wanted) {
      if (holdsByTicker.has(ticker)) continue;
      if (looked >= HOLD_MAX_NEW_PER_TICK) break;
      looked += 1;
      const streams = await heldSource.referenceStreams(ticker);
      if (!streams || streams.length === 0) {
        notMapped += 1;
        continue;
      }
      const keys: string[] = [];
      for (const s of streams) {
        const key = holdKey(ticker, s.id);
        const r = heldBooksConn.hold(key, s.stream);
        if (r === "held" || r === "already") keys.push(key);
        else lastHoldError = `${ticker}: hold ${r}`;
      }
      if (keys.length) holdsByTicker.set(ticker, { path, keys, sinceIso: new Date().toISOString() });
    }
    await drainOpens();
    const st = heldBooksConn.status();
    if (st.lastError && !lastHoldError) lastHoldError = st.lastError;
  } catch (err) {
    lastHoldError = String(err instanceof Error ? err.message : err);
  } finally {
    holdWantedLastTick = wanted.size;
    holdNotMappedLastTick = notMapped;
    lastHoldAt = new Date().toISOString();
  }
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
    positions: allPositions().length,
    lastScanAt,
    lastSettleAt,
  };
}

function healthBody(): Record<string, unknown> {
  const stats = ledgerStats(LEDGER_PATH);
  return {
    ok: true,
    service: "event-protect-shadow",
    positions: allPositions().length,
    ledger: { path: LEDGER_PATH, ...stats },
    lastScanAt,
    lastSettleAt,
    lastScanError,
    lastSettleError,
    consecutiveScanFailures,
    settleFailuresLastTick,
    settleDueLastTick,
    earlyClose: { ...earlyCloseRule, everyMs: CLOSE_MS, lastCloseAt, lastCloseError, closeDueLastTick },
    // the pre-lock read: on or off, how far before the lock, the last tick's counters
    reread: { hours: REREAD_HOURS, everyMs: REREAD_MS, lastAt: lastRereadAt, lastError: lastRereadError, dueLastTick: rereadDueLastTick, writtenLastTick: rereadWrittenLastTick },
    // the held books: on or off (and why), the window, what is held and in which state, opens written
    heldBooks: {
      hours: HOLD_HOURS,
      everyMs: HOLD_MS,
      on: Boolean(heldSource) && HOLD_HOURS > 0,
      ...(!heldSource ? { off: "aggregator key not set" } : HOLD_HOURS <= 0 ? { off: "EVENT_SHADOW_HOLD_HOURS=0" } : {}),
      lastAt: lastHoldAt,
      lastError: lastHoldError,
      wantedLastTick: holdWantedLastTick,
      notMappedLastTick: holdNotMappedLastTick,
      holding: holdsByTicker.size,
      queued: openQueue.length,
      bookOpensWritten,
      stream: heldBooksConn ? heldBooksConn.status() : null,
    },
    openMix: { ...openMix, cryptoSkippedLastScan },
    lastLeg: {
      ...lastLegCfg,
      ledger: { path: LASTLEG_PATH, ...ledgerStats(LASTLEG_PATH) },
      lastTickAt: lastLastLegAt,
      lastError: lastLastLegError,
      lastReport: lastLastLegReport,
    },
    // Each slate with the link to send: the slate page on its own derived key (opens that one slate
    // and no other) and the demo in the venue's brand. Operator body only; the public health body
    // does not list prospects.
    slates: {
      keyConfigured: Boolean((SLATE_KEY ?? "").trim()),
      configured: venueSlates.map((s) => {
        const link = slateLinkKey(SLATE_KEY, s.slug);
        return {
          slug: s.slug,
          name: s.name,
          leagues: s.leagues,
          shareUrl: link ? `${RECORD_URL}/slate/${s.slug}?k=${link}` : null,
          demoUrl: `${DEMO_URL}/?brand=${encodeURIComponent(s.name)}`,
        };
      }),
    },
    alertsConfigured: Boolean((alertCfg.telegramBotToken && alertCfg.telegramChatId) || alertCfg.webhookUrl),
    lock: {
      enabled: LOCK_ROUTES_ON,
      sharedKey: Boolean(LOCK_KEY),
      reservedTickers: hedgeChoice.live?.allowlist ?? [],
      anyTicker: hedgeChoice.live?.anyTicker ?? false,
      positions: allLocks().length,
      ledger: { path: LOCK_LEDGER_PATH, ...ledgerStats(LOCK_LEDGER_PATH) },
      // who may lock (aliases only, never keys), each with their ledger and how many locks stand on it
      holders: HOLDER_KEYS.holders.map((h) => {
        const path = lockLedgerPathFor(h.holder);
        return { holder: h.holder, positions: loadShadowPositions(path).length, ledger: { path, ...ledgerStats(path) } };
      }),
      ...(HOLDER_KEYS.notes.length ? { holderNotes: HOLDER_KEYS.notes } : {}),
      // the holder's venue account, read-only: configured or not, never the key
      holderPositions: { configured: Boolean(venueClient), ...(venueClient ? { api: venueClient.kind } : {}), ...(venueClientNote ? { note: venueClientNote } : {}), lastReadAt: positionsCache ? new Date(positionsCache.at).toISOString() : null },
    },
    hedge: {
      strategy: hedgeChoice.strategy,
      // the venues every quote competes tonight (EVENT_HEDGE_VENUES), and any word in it the reader did not know
      offeredVenues: HEDGE_VENUES.routes.map((r) => HEDGE_VENUE_NAMES[r] ?? r),
      offeredVenuesSource: HEDGE_VENUES.source,
      ...(HEDGE_VENUES.unknown.length ? { offeredVenuesUnknown: HEDGE_VENUES.unknown } : {}),
      prophetxFeeBps: PROPHETX_FEE_BPS,
      rfqVenues: hedgeChoice.rfqVenues,
      polymarketBuilderCode: hedgeChoice.polymarketBuilderCode,
      live: hedgeChoice.live,
      notes: hedgeChoice.notes,
      // the Kalshi account routes (tier, subaccounts, shard cash) need the account owner's key; on or off, never the key
      kalshiAccountRoutes: Boolean(kalshiAccount),
      // the aggregator's pod as a sending path: configured when the TRADE key is set and via=aggregator
      aggregatorPod: Boolean(hedgeChoice.aggregatorOrders),
      receipts: { path: RECEIPTS_PATH, ...ledgerStats(RECEIPTS_PATH) },
      // the books the quote is priced from: the aggregator's feed first when its key is set, the venues directly behind it
      pricingSource: pricingSourceStatusFn ? pricingSourceStatusFn() : { aggregator: { configured: false }, notes: ["engine not loaded yet"] },
      // other regulated exchanges read as price references on each open: which dialects, never the keys
      referenceBooks,
      // an exchange that publishes only yesterday's tape, read the same way: on or off
      referencePrints,
    },
  };
}

function pageData(): { atIso: string; positions: ShadowPosition[] } {
  return { atIso: new Date().toISOString(), positions: allPositions() };
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

/**
 * A position as the public JSON carries it: what was quoted, what settled, both sides' money.
 * The counterfactual rule books, the pre-lock re-read, the hedge leg's venue token and where
 * each book was read from stay with the operator (the raw ledger, the full CSV, /venues); a
 * reader can recompute every public row without them.
 */
function publicPosition(p: ShadowPosition): Omit<ShadowPosition, "counterfactuals" | "prelock" | "bookOpen" | "hedgeTokenId" | "hedgeStrikeId" | "hedgeOffsetStrikeId" | "hedgeMarketId" | "hedgeOutcomeId" | "hedgeOffsetOutcomeId" | "bookOrigins" | "holder"> & { cashDue?: ReturnType<typeof cashDue> } {
  // where the books came from (the partner's feed or the venue), the pre-lock read, the book-open read and whose lock it is are the operator's: /venues, /api/shadow/holders, the raw ledger
  const { counterfactuals: _cf, prelock: _prelock, bookOpen: _bookOpen, hedgeTokenId: _tok, hedgeStrikeId: _strike, hedgeOffsetStrikeId: _offset, hedgeMarketId: _nvMarket, hedgeOutcomeId: _nvOutcome, hedgeOffsetOutcomeId: _nvOffset, bookOrigins: _origins, holder: _holder, ...rest } = p;
  // a holder's lock carries what it owes and what was paid; the scan's positions pay nobody
  return p.source === "lock" ? { ...rest, cashDue: cashDue(p) } : rest;
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
    if ((OPERATOR_PATHS.has(url.pathname) || url.pathname.startsWith("/api/shadow/kalshi/")) && !operator) {
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
    if (LOCK_PATHS.has(url.pathname)) {
      // No key configured: the routes do not exist. Wrong or missing key: 403, like the operator views.
      // A holder's key names the holder; the shared key and the operator act with no holder, and the
      // operator may act as one with ?holder= (a lock entered for a person by hand).
      if (!LOCK_ROUTES_ON && !operator) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }
      const caller = lockCaller(LOCK_KEY, HOLDER_KEYS.holders, req.headers, url.searchParams.get("lock"));
      if (!operator && !caller) {
        sendJson(res, 403, { ok: false, error: "bad lock key" });
        return;
      }
      let holder: string | null = caller?.holder ?? null;
      if (operator && !caller) {
        const asked = holderParam(url);
        if (asked && !HOLDER_ALIAS_RE.test(asked)) {
          sendJson(res, 400, { ok: false, error: "bad_request", message: "holder must be an alias: 2-24 of a-z 0-9 _ -" });
          return;
        }
        holder = asked ?? null;
      }
      void handleLockRoutes(req, res, url, holder, operator).catch((err: unknown) => sendJson(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) }));
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
      // The raw append-only ledger, byte for byte: the artifact to mirror off-box. ?ledger=lock for the
      // shared lock ledger, &holder=<alias> for one holder's.
      const lockFile = url.searchParams.get("ledger") === "lock";
      const exportHolder = lockFile ? (holderParam(url) ?? null) : null;
      if (exportHolder && !HOLDER_ALIAS_RE.test(exportHolder)) {
        sendJson(res, 400, { ok: false, error: "bad_request", message: "holder must be an alias: 2-24 of a-z 0-9 _ -" });
        return;
      }
      const path = lockFile ? lockLedgerPathFor(exportHolder) : LEDGER_PATH;
      const stats = ledgerStats(path);
      if (!stats.exists) {
        res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "content-length": 0, "cache-control": "no-store" });
        res.end();
        return;
      }
      const size = statSync(path).size;
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-length": size,
        "content-disposition": `attachment; filename="event-shadow-${lockFile ? `lock-${exportHolder ? `${exportHolder}-` : ""}` : ""}ledger-${new Date().toISOString().slice(0, 10)}.jsonl"`,
        "cache-control": "no-store",
      });
      createReadStream(path).pipe(res);
      return;
    }
    if (url.pathname === "/api/shadow/positions.csv") {
      // Spreadsheet form: one row per position, every leg in integer cents.
      // Public rows carry what was quoted and what settled; the operator's
      // ?scope=full adds the recorded fee rule and every counterfactual.
      const full = operator && url.searchParams.get("scope") === "full";
      const csv = positionsCsv(allPositions(), full ? "full" : "public");
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
      sendJson(res, 200, {
        ok: true,
        at: atIso,
        summary: publicSummary(summarizeShadow(positions)),
        settled: settled.map(publicPosition),
        open: open.map(publicPosition),
        closed: closed.map(publicPosition),
      });
      return;
    }
    if (url.pathname === "/api/shadow/netting") {
      // Netting measured on the replayed ledger: the two sides of one game matched on paper,
      // the saving derived, the pair identity written out per winner. Operator only; the record
      // hedges leg for leg and the public page does not mention netting.
      const { atIso, positions } = pageData();
      sendJson(res, 200, { ok: true, at: atIso, ...measureNetting(positions) });
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
        live: hedgeChoice.live,
        notes: hedgeChoice.notes,
        summary: summarizeHedgeReceipts(receipts),
        recent: receipts.slice(-limit).reverse(),
      });
      return;
    }
    if (url.pathname === "/api/shadow/hedges/preflight") {
      // Before a live order: do the credentials sign, does the venue answer, what cash is there,
      // and what would the rails do with a sample ticker (?ticker=). Reads only; nothing is placed.
      // With ?ticker= the game is also priced on Kalshi's own No side at ?contracts= (default 20):
      // an armed ticker hedges there, and that route is offered on fewer games than the board's
      // cheaper-route rule, so this says whether the tap would be offered at all. ?scan=1 prices
      // every game in the window on that route and lists the ones offered (reads only, ~10s).
      const ticker = (url.searchParams.get("ticker") ?? "").trim().toUpperCase();
      const contractsParam = Number(url.searchParams.get("contracts") ?? 20);
      const contracts = Number.isInteger(contractsParam) && contractsParam >= 1 && contractsParam <= 10_000 ? contractsParam : 20;
      const live = hedgeChoice.live;
      const sentToday = sentUnitsMilliOn(loadHedgeReceipts(RECEIPTS_PATH), new Date().toISOString().slice(0, 10)) / 1000;
      // the balance behind the sending client: our own Kalshi key, or the pod's Kalshi cash through the aggregator
      const venueCheck: Promise<{ ok: boolean; via?: string; balanceCents?: number; podId?: string; canTrade?: boolean; error?: string }> = hedgeChoice.aggregatorOrders
        ? Promise.all([hedgeChoice.aggregatorOrders.whoami(), hedgeChoice.aggregatorOrders.availableCents()])
            .then(([who, balanceCents]) => ({ ok: who.capabilities.includes("trade"), via: "aggregator", balanceCents, podId: who.podId, canTrade: who.capabilities.includes("trade"), ...(who.capabilities.includes("trade") ? {} : { error: `the key's capabilities are [${who.capabilities.join(", ")}]; it cannot trade` }) }))
            .catch((err: unknown) => ({ ok: false, via: "aggregator", error: String(err instanceof Error ? err.message : err) }))
        : hedgeChoice.kalshiOrders
          ? hedgeChoice.kalshiOrders
              .balanceCents()
              .then((balanceCents) => ({ ok: true, via: "direct", balanceCents }))
              .catch((err: unknown) => ({ ok: false, via: "direct", error: String(err instanceof Error ? err.message : err) }))
          : Promise.resolve({ ok: false, error: live ? (live.via === "aggregator" ? "no aggregator TRADE key in the service env" : "no Kalshi credentials in the service env") : "not in live mode" });
      // the third live venue's cash: the Novig subaccount the service's own trading key reaches
      const novigCheck: Promise<{ ok: boolean; keyId?: string; balanceCents?: number; error?: string } | null> = hedgeChoice.novigOrders
        ? hedgeChoice.novigOrders
            .availableCents()
            .then((balanceCents) => ({ ok: true, keyId: `…${hedgeChoice.novigOrders!.keyId.slice(-4)}`, balanceCents }))
            .catch((err: unknown) => ({ ok: false, keyId: `…${hedgeChoice.novigOrders!.keyId.slice(-4)}`, error: String(err instanceof Error ? err.message : err) }))
        : Promise.resolve(live ? (HEDGE_VENUES.routes.includes("novig") ? { ok: false, error: "no NOVIG_TRADE_KEY_ID / NOVIG_TRADE_PRIVATE_KEY_PEM in the service env" } : null) : null);
      const held = new Set(allLocks().filter((l) => l.p.status !== "closed").map((l) => l.p.ticker));
      const kalshiRouteQuote = async (t: string) => {
        if (!quoteOneFn) return { offered: false as const, code: "engine_not_ready", detail: "the scanner is still loading" };
        const q = await quoteOneFn({ ticker: t, contracts, route: "kalshi_self" });
        if (!q.ok) return { offered: false as const, code: q.code, detail: q.detail };
        const r = q.result;
        if (!r.quote.ok) return { offered: false as const, code: r.quote.code, detail: r.quote.detail, sideName: r.sideName, markCents: r.markCents };
        return {
          offered: true as const,
          sideName: r.sideName,
          eventTitle: r.eventTitle,
          eventTimeIso: r.eventTimeIso,
          markCents: r.markCents,
          tier: r.quote.tier,
          tiers: Object.keys(r.quote.tiers),
          floorCents: r.quote.floorCents,
          capCents: r.quote.capCents,
          creditCents: r.quote.creditCents,
          evCostBps: r.evBps,
          hedgeUnitsMilli: r.quote.hedge.venue === "kalshi" ? r.quote.hedge.contractsMilli : r.quote.hedge.sharesMilli,
          hedgeCostCents: r.quote.hedge.costCents,
        };
      };
      const tickerCheck = ticker ? kalshiRouteQuote(ticker).catch((err: unknown) => ({ offered: false as const, code: "quote_failed", detail: String(err instanceof Error ? err.message : err) })) : Promise.resolve(null);
      const scanCheck =
        url.searchParams.get("scan") && quoteOneFn && listGameMarketsFn
          ? (async () => {
              const offered: Array<Record<string, unknown>> = [];
              const refused: Record<string, number> = {};
              const markets = await listGameMarketsFn!();
              for (const m of markets) {
                if (held.has(m.ticker)) continue;
                const r = await kalshiRouteQuote(m.ticker).catch(() => ({ offered: false as const, code: "quote_failed" }));
                if (r.offered) offered.push({ ticker: m.ticker, league: m.league, dateIso: m.dateIso, armed: tickerIsArmed(m.ticker), ...r });
                else refused[r.code] = (refused[r.code] ?? 0) + 1;
              }
              return { contracts, checked: markets.length, offered, refused };
            })()
          : Promise.resolve(null);
      void Promise.all([venueCheck, tickerCheck, scanCheck, novigCheck]).then(([venue, routeQuote, scan, novig]) =>
        sendJson(res, 200, {
          ok: true,
          at: new Date().toISOString(),
          strategy: hedgeChoice.strategy,
          live,
          sentTodayContracts: sentToday,
          venue,
          ...(novig ? { novig } : {}),
          ticker: ticker
            ? {
                ticker,
                allowlisted: tickerIsArmed(ticker),
                onRecord: held.has(ticker),
                wouldSend: Boolean(live && !live.dryRun && !live.killSwitch && tickerIsArmed(ticker) && venue.ok),
                contracts,
                kalshiRoute: routeQuote,
              }
            : null,
          ...(scan ? { scan } : {}),
          notes: hedgeChoice.notes,
        }),
      );
      return;
    }
    if (url.pathname === "/api/shadow/hedges/resend") {
      void handleHedgeResend(req, res, url).catch((err: unknown) => sendJson(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) }));
      return;
    }
    if (url.pathname === "/api/shadow/hedges/pod") {
      void handlePod(res, url).catch((err: unknown) => sendJson(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) }));
      return;
    }
    if (url.pathname.startsWith("/api/shadow/kalshi/")) {
      void handleKalshiAccount(req, res, url).catch((err: unknown) => sendJson(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) }));
      return;
    }
    if (url.pathname === "/api/shadow/lock/reset") {
      handleLockReset(req, res, url);
      return;
    }
    if (url.pathname === "/api/shadow/cash") {
      void handleCash(req, res).catch((err: unknown) => sendJson(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) }));
      return;
    }
    if (url.pathname === "/holders") {
      // HOLDERS, NAMED: the page a pay run reads. Operator only; aliases never appear in public.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderHoldersHtml({ ...holdersSummary(), token: url.searchParams.get("token") }));
      return;
    }
    if (url.pathname === "/api/shadow/holders") {
      sendJson(res, 200, holdersSummary());
      return;
    }
    if (url.pathname === "/api/shadow/ext-telemetry/summary") {
      // what the extension drew on each venue lately, and the switches it is being served
      sendJson(res, 200, { ok: true, ext: extConfig(), ...extTelemetry.summary() });
      return;
    }
    if (url.pathname === "/api/shadow/venues.csv") {
      // every venue read of every game in the window, flat, with the listing ids (shadowVenues.ts, venueBreakdownCsv)
      const daysRaw = Number(url.searchParams.get("days"));
      const windowDays = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 365) : 7;
      const { atIso, positions } = pageData();
      const breakdown = venueBreakdown(positions, new Date(atIso), { windowDays, maxRows: 10_000 });
      res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "content-disposition": `attachment; filename="venues-${atIso.slice(0, 10)}.csv"` });
      res.end(venueBreakdownCsv(breakdown));
      return;
    }
    if (url.pathname === "/api/shadow/venues/catalog") {
      // what a reference venue lists for one league, as its catalog answers: the diagnostic behind "not listed"
      const league = (url.searchParams.get("league") ?? "nba").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!league) {
        sendJson(res, 400, { ok: false, error: "league required (nba, nfl, mlb)" });
        return;
      }
      if (!referenceCatalogFn) {
        sendJson(res, 503, { ok: false, error: "engine not loaded yet" });
        return;
      }
      void referenceCatalogFn(league).then(
        (probe) => sendJson(res, 200, { ok: true, at: new Date().toISOString(), ...probe }),
        (err: unknown) => sendJson(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) }),
      );
      return;
    }
    if (url.pathname === "/venues" || url.pathname === "/api/shadow/venues") {
      // VENUES, NAMED: every game priced on every venue read, from the ledger's counterfactuals.
      // Operator only (OPERATOR_PATHS); the public record never carries a venue's name.
      const daysRaw = Number(url.searchParams.get("days"));
      const windowDays = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 365) : 7;
      const { atIso, positions } = pageData();
      const breakdown = venueBreakdown(positions, new Date(atIso), { windowDays });
      const pricingSource = pricingSourceStatusFn ? pricingSourceStatusFn() : { aggregator: { configured: false as const }, notes: ["engine not loaded yet"] };
      const heldBooks = heldBooksConn ? heldBooksConn.status() : null;
      if (url.pathname === "/api/shadow/venues") {
        sendJson(res, 200, { ok: true, windowDays, pricingSource, heldBooks, ...breakdown });
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderVenuesHtml({ breakdown, pricingSource, heldBooks, token: url.searchParams.get("token"), windowDays }));
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
          netting: measureNetting(positions),
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
          ...(tickets ? { parlays: { lockVsSell: lockVersusSell(tickets), lastLeg: summarizeLastLeg(tickets), stakeCents: lastLegCfg.stakeCents, rules: summarizeLegRules(tickets) } } : {}),
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
  quoteOneFn = demo.quoteOne;
  listGameMarketsFn = demo.listGameMarkets;
  protectCutoffMinutes = demo.PROTECT_WINDOW_MINUTES.min;
  pricingSourceStatusFn = demo.pricingSourceStatus;
  referenceCatalogFn = demo.referenceCatalog;
  heldSource = demo.aggregatorSource();
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[event-shadow] listening on :${PORT} · ledger ${LEDGER_PATH} · scan every ${Math.round(SCAN_MS / 60_000)}m · settle every ${Math.round(SETTLE_MS / 60_000)}m · early closes ${earlyCloseRule.sharePct}% of the book` +
        (REREAD_HOURS > 0 ? ` · pre-lock re-read ${REREAD_HOURS}h before each lock` : " · pre-lock re-read off") +
        (heldSource && HOLD_HOURS > 0 ? ` · held books ${HOLD_HOURS}h before each lock` : ` · held books off (${heldSource ? "EVENT_SHADOW_HOLD_HOURS=0" : "aggregator key not set"})`) +
        (lastLegCfg.enabled
          ? ` · last-leg shadow every ${Math.round(lastLegCfg.tickMs / 60_000)}m (${lastLegCfg.legCounts.join("/")}-leg tickets, $${(lastLegCfg.stakeCents / 100).toFixed(0)} stake, ledger ${LASTLEG_PATH})`
          : " · last-leg shadow off") +
        (LOCK_ROUTES_ON
          ? ` · lock routes on (${HOLDER_KEYS.holders.length} holder(s)${LOCK_KEY ? " + shared key" : ""}; ${hedgeChoice.live?.anyTicker ? "any ticker armed" : `${hedgeChoice.live?.allowlist.length ?? 0} ticker(s) reserved for the tap`})`
          : " · lock routes off (no EVENT_SHADOW_LOCK_KEY / EVENT_SHADOW_HOLDER_KEYS)") +
        (venueSlates.length
          ? ` · slates ${venueSlates.map((s) => `/slate/${s.slug} (${s.name})`).join(", ")}${(SLATE_KEY ?? "").trim() ? "" : " [no share key: operator token only]"}`
          : ""),
    );
    void scanTick();
    void settleTick();
    setInterval(() => void scanTick(), SCAN_MS);
    setInterval(() => void settleTick(), SETTLE_MS);
    if (earlyCloseRule.sharePct > 0) setInterval(() => void closeTick(), CLOSE_MS);
    if (REREAD_HOURS > 0) {
      void rereadTick();
      setInterval(() => void rereadTick(), REREAD_MS);
    }
    if (heldSource && HOLD_HOURS > 0) {
      void holdTick();
      setInterval(() => void holdTick(), HOLD_MS);
    }
    if (lastLegCfg.enabled) {
      void lastLegTick();
      setInterval(() => void lastLegTick(), lastLegCfg.tickMs);
    }
  });
}

if (process.env.NODE_ENV !== "test") void main();

/** Test seam: the lock routes' engine calls, normally wired in main() from the scanner module. */
export function wireLockEngine(fns: {
  quoteOne: typeof quoteOne;
  listGameMarkets: typeof listGameMarkets;
  venueClient?: HolderPositionsSource | null;
  closeBooks?: typeof closeBooksFn;
  /** the executor the hedge (and its sale) goes through, in place of the one the env chose; the rails view stays the env's */
  hedgeExecutor?: HedgeExecutor;
}): void {
  quoteOneFn = fns.quoteOne;
  listGameMarketsFn = fns.listGameMarkets;
  if (fns.closeBooks) closeBooksFn = fns.closeBooks;
  if (fns.hedgeExecutor) hedgeChoice.executor = fns.hedgeExecutor;
  if (fns.venueClient !== undefined) {
    venueClient = fns.venueClient;
    positionsCache = null;
  }
}

/** Test seam: the aggregator source the held books hang off, normally the scanner module's. Replacing it drops any current holds. */
export function wireHeldBooks(source: AggregatorBookSource | null): void {
  heldBooksConn?.close();
  heldBooksConn = null;
  holdsByTicker.clear();
  openQueue.length = 0;
  heldSource = source;
}

export { server, scanTick, settleTick, closeTick, lastLegTick, rereadTick, holdTick };
