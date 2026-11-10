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
 *      EVENT_SHADOW_IN_GAME_MINUTES (price every open game again on every venue this long after its
 *      start, in play, default 20; 0 = off; the read is taken on the same timer as the pre-lock one)
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
 * bought on; /api/shadow/scoreboard (and .csv, and the /scoreboard page) is the venue scoreboard
 * drawn from it by week (venueScoreboard.ts: which venue took the other side, by how much, what
 * its fee schedule charged, how often each priced, the refusals), venue-named, for industry readers. Everything that is a study rather than a receipt (rule counterfactuals, hedge
 * receipts, the last-leg tickets, netting measured on the book) is an operator view. A new
 * measurement joins the operator views first; it reaches the record only by decision.
 *
 * A holder's lock (source "lock", its own ledger) also carries the money between the two parties:
 * POST /api/shadow/cash (operator) records each payment against the leg it pays (credit, floor,
 * handback); the holder's receipt and the public record say what is owed and what was paid
 * (`curl -s -X POST -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" -H "content-type: application/json" \
 *   -d '{"ticker":"KX...","leg":"floor","cents":1200,"method":"venue transfer","ref":"..."}' https://<service>/api/shadow/cash`).
 */

import { createHash, randomBytes } from "node:crypto";
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
  inPlayConfig,
  rereadQuotesFor,
  type ShadowBookOpened,
  type ShadowCounterfactuals,
} from "../src/eventCollar/crossVenue/shadowCounterfactuals";
import type { AggregatorBookSource } from "../src/eventCollar/crossVenue/aggregatorBooks";
import type { HeldBookOpen, HeldBooks } from "../src/eventCollar/crossVenue/aggregatorHeldBooks";
import type { ReferenceBookId } from "../src/eventCollar/crossVenue/venueBooks";
import {
  DEFAULT_CROSS_CONFIG,
  PARLAY_LAST_PICK_TIER,
  PROTECTION_TIERS,
  capTotalCents,
  floorTotalCents,
  roundContracts,
  type CrossQuoteResult,
  type CrossSearchConfig,
  type HedgeLeg,
  type HedgeRoute,
  type PmBook,
  type ProtectionTier,
} from "../src/eventCollar/crossVenue/types";
import type { NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { getMarketResult, getSettledMarkets, kalshiBase, type KalshiSettledMarket } from "../src/eventCollar/kalshiPublic";
import { PICK_SERIES, parlayRecordOf, parsePickQueries, resolvePicks, verifyParlayLock, type PickMarket, type PickQuery, type PicksView } from "../src/eventCollar/crossVenue/parlayPicks";
import { checkRule, kalshiRuleText, kalshiRuleUrl, pinRule, pinVenueRules, ruleStateLabel, venueRulesText, type RuleEvidence } from "../src/eventCollar/crossVenue/ruleEvidence";
import { VENUE_NAMES, hedgeVenueOf, hedgeVenuesFromEnv, rulesFor, type HedgeRouting, type SettlementVenue } from "../src/eventCollar/crossVenue/hedgeRouting";
import { foldProphetXFee, prophetxFeeBpsFromEnv } from "../src/eventCollar/crossVenue/prophetxOrders";
import { TIER_RULES } from "../src/eventCollar/crossVenue/collarSearch";
import { adminAuthorized, parseAdminAuthFromEnv } from "../src/eventCollar/crossVenue/eventFunnel";
import {
  BookHedgeExecutor,
  appendHedgeReceipt,
  intentFromHedge,
  sellIntentForNovig,
  loadHedgeReceipts,
  sellIntentForKalshi,
  sellIntentForProphetX,
  summarizeHedgeReceipts,
  type HedgeExecutor,
  type HedgeIntent,
  type HedgeReceipt,
} from "../src/eventCollar/crossVenue/hedgeExecutor";
import { hedgeExecutorFromEnv } from "../src/eventCollar/crossVenue/hedgeExecutorFromEnv";
import { appendPending, clearable, judgeHedge, loadPending, lockMode, pendingRecordFor, refusalWords, summarizePending, type PendingRecord } from "../src/eventCollar/crossVenue/hedgeFirst";
import { sentUnitsMilliOn, tickerArmed } from "../src/eventCollar/crossVenue/liveHedge";
import { KALSHI_SHARDS, KalshiAccountClient, KalshiApiError, shardForTicker, type KalshiAccountSnapshot, type KalshiApiKeyInfo } from "../src/eventCollar/crossVenue/kalshiAccount";
import { kalshiRfqCredentialsFromEnv } from "../src/eventCollar/crossVenue/kalshiRfq";
import { AggregatorApiError } from "../src/eventCollar/crossVenue/aggregatorMarkets";
import { FEE_RULE_TEXT, renderHoldersHtml, renderShadowHtml, renderShadowReportHtml, renderSlateHtml, renderVenuesHtml } from "./eventShadowHtml";
import { renderScoreboardHtml } from "./eventScoreboardHtml";
import { memberAppHtml, memberPrivacyHtml } from "./memberAppHtml";
import { ATTICUS_BIRD_PNG, ATTICUS_WORDMARK_PNG, ICON_180_PNG, ICON_192_PNG, ICON_512_PNG, STX_LOGO_PNG } from "./memberAppAssets";
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
  type LastLegRouter,
  type LastLegTickReport,
  type RoutedQuote,
} from "../src/eventCollar/crossVenue/lastLeg";
import { retailParlays } from "../src/eventCollar/crossVenue/parlayRetail";
import { measureNetting } from "../src/eventCollar/crossVenue/shadowNetting";
import { venueBreakdown, venueBreakdownCsv } from "../src/eventCollar/crossVenue/shadowVenues";
import { findVenueSlate, parseVenueSlates, slateAccessOk, slateLeaguesOnRecord, slateLinkKey, slatePositions } from "../src/eventCollar/crossVenue/venueSlate";
import type { CandidateResult, ScanOptions, ScanState, listGameMarkets, pricingSourceStatus, quoteOne, referenceCatalog } from "./eventProtectXDemoService";
import { HOLDER_ALIAS_RE, holderKeysFromEnv, lockCaller, lockKeyFromEnv, parseLockRequest, readJsonBody } from "../src/eventCollar/crossVenue/lockGate";
import { ExtTelemetryStore, parseExtTelemetry } from "../src/eventCollar/crossVenue/extTelemetry";
import { VenueClient, excludedWalletsFromEnv, holderPositions, signerFromPem, venueConfigFromEnv, type HolderPosition, type ProtectableMarket } from "../src/eventCollar/crossVenue/venuePositions";
import { PlaysClient, holderPlays, playsConfigFromEnv } from "../src/eventCollar/crossVenue/venuePlays";
import { novigRouteOf, referenceSourcesFromEnv, signedHedgeBook, signedHostFromEnv, type ReferenceBook } from "../src/eventCollar/crossVenue/venueBooks";
import { referencePrintSourcesFromEnv } from "../src/eventCollar/crossVenue/venuePrints";
import { loadRefusals, recordScanRefusals, saveRefusals, summarizeRefusals, type RefusalSummary } from "../src/eventCollar/crossVenue/shadowRefusals";
import { venueScoreboard, venueScoreboardCsv } from "../src/eventCollar/crossVenue/venueScoreboard";
import { retailCrossQuote } from "../src/eventCollar/retailShowcase";
import { ComboLegMemory, MemberApiError, MemberSessions, clientOrderIdFor, comboTickerOf, isComboTicker, leagueOfCompetition, marketResultWord, matchMemberMarket, memberAppConfigFromEnv, memberHolderPositions, memberKeyOf, winnerClubOf, type MemberBalance, type MemberHolderPosition } from "../src/eventCollar/crossVenue/memberApp";
import { SALE_SHARE, acceptRfq, askLevels, bidLevels, buyBackRecordOf, executeLimitOrder, memberTailTerms, priceString, quoteBuyBack, quoteSaleTiers, requestRfqBid, saleEvCostBps, saleRecordOf, type ExecuteOptions, type OrderOutcome, type RfqBid, type SaleTierQuote } from "../src/eventCollar/crossVenue/memberSale";
import type { MemberSaleComparison, MemberSaleRecord } from "../src/eventCollar/crossVenue/shadowLedger";
import type { RawOutcomeMarket } from "../src/eventCollar/crossVenue/venueMarkets";
import { outcomeBids, outcomeCompetitionCode, outcomeMaxPrice } from "../src/eventCollar/crossVenue/venueBooks";

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
 * IN-GAME RE-READ: every open game is priced again the same way a fixed number of minutes after
 * its start, while it is in play (shadowCounterfactuals.ShadowInGameReread). The question it
 * answers is whether a floor could be priced at all once the game has begun: which venues still
 * carry a book on the opposing outcome, how wide the protected market's own spread has gone, and
 * what the default tier would pay from those books at the position's size. Measurement only: the
 * lock window stays at 45 minutes before the start, nothing is hedged in play, and the read is the
 * operator's (/venues, the CSV), never the public record's. A game whose read-minute passed while
 * the worker was away is not read late: the read is of that minute or not at all.
 */
const IN_GAME_MINUTES = (() => {
  const raw = process.env.EVENT_SHADOW_IN_GAME_MINUTES;
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 240 ? n : 20;
})();
/** how long after its read-minute a game is still read (the venues down, the worker restarting): past this, it goes unread */
const IN_GAME_LATE_MINUTES = 30;
let lastInGameAt: string | null = null;
let lastInGameError: string | null = null;
let inGameDueLastTick = 0;
let inGameWrittenLastTick = 0;
let inGameInFlight = false;

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
/**
 * Whether a prospect's slate page names the hedge venues (EVENT_X_NAME_HEDGE_VENUES=1, the same
 * switch the demo page reads). Off by default: the page says how many venues compete, and only
 * the operator's token reads which.
 */
const SLATE_NAMES_HEDGE_VENUES = process.env.EVENT_X_NAME_HEDGE_VENUES === "1";
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
/** one entry per market the scan priced and declined, with the engine's reason (shadowRefusals.ts) */
const REFUSALS_PATH = process.env.EVENT_SHADOW_REFUSALS_PATH || join(dirname(LEDGER_PATH), "scan-refusals.json");
/** the record's refusal figures against the positions it holds; read on every page */
function refusalSummary(positions: ReadonlyArray<{ ticker: string; kind: string }>): RefusalSummary {
  return summarizeRefusals(loadRefusals(REFUSALS_PATH), positions);
}
/**
 * A real holder's locks live in their own ledger beside the scan's. The scan opens one showcase
 * position per market; a holder may lock the same market, so the two cannot share a file keyed by
 * ticker. Same record shape, same settlement; never early-closed (that experiment is the scan's).
 */
const LOCK_LEDGER_PATH = process.env.EVENT_SHADOW_LOCK_LEDGER_PATH || join(dirname(LEDGER_PATH), "lock-ledger.jsonl");
/**
 * The pending trail (hedgeFirst.ts): one line before a real hedge order leaves, one when the
 * attempt ends. Beside the lock ledger, so it rides the same disk and the same backup.
 */
const PENDING_PATH = process.env.EVENT_SHADOW_LOCK_PENDING_PATH || join(dirname(LOCK_LEDGER_PATH), "lock-pending.jsonl");
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
  "/api/shadow/lock/pending",
  "/api/shadow/lock/pending/clear",
  "/api/shadow/cash",
  "/api/shadow/holders",
  "/api/shadow/member/raw",
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
 * PARLAY PICKS (parlayPicks.ts): a ticket's picks are placed on the week's open game markets and
 * on the markets settled in the last two weeks, which carry the results of the picks already
 * played. The settled lists are read from Kalshi's public API per league and kept a minute; the
 * tests replace the reader.
 */
const PICKS_SETTLED_LOOKBACK_MS = 14 * 86_400_000;
const PICKS_SETTLED_TTL_MS = 60_000;
let settledMarketsFn: (series: string, sinceMs: number) => Promise<KalshiSettledMarket[]> = getSettledMarkets;
const settledCache = new Map<string, { at: number; rows: KalshiSettledMarket[] }>();
async function pickMarkets(now = new Date()): Promise<PickMarket[]> {
  if (!listGameMarketsFn) return [];
  const open = (await listGameMarketsFn()).map(
    (m): PickMarket => ({ ticker: m.ticker, league: m.league, sideName: m.sideName, title: m.title, startIso: m.startIso ?? m.closeTimeIso, settled: false }),
  );
  const seen = new Set(open.map((m) => m.ticker));
  const settled: PickMarket[] = [];
  for (const { league, series } of PICK_SERIES) {
    const hit = settledCache.get(series);
    let rows = hit && now.getTime() - hit.at < PICKS_SETTLED_TTL_MS ? hit.rows : null;
    if (!rows) {
      try {
        rows = await settledMarketsFn(series, now.getTime() - PICKS_SETTLED_LOOKBACK_MS);
        settledCache.set(series, { at: now.getTime(), rows });
      } catch {
        // a league whose settled list could not be read leaves its picks unknown, never guessed
        rows = hit?.rows ?? [];
      }
    }
    for (const m of rows) if (!seen.has(m.ticker)) settled.push({ ticker: m.ticker, league, sideName: m.subtitle, title: m.title, startIso: null, settled: true, result: m.result });
  }
  return [...open, ...settled];
}
const picksViewFor = async (queries: readonly PickQuery[], now = new Date()): Promise<PicksView> => resolvePicks(queries, await pickMarkets(now), now);
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
const LOCK_PATHS = new Set(["/api/shadow/lock", "/api/shadow/quote", "/api/shadow/markets", "/api/shadow/picks", "/api/shadow/positions", "/api/shadow/receipt", "/api/shadow/unwind", "/api/shadow/unwind/quote", "/api/shadow/ext-telemetry", "/api/shadow/member", "/api/shadow/member/connect", "/api/shadow/member/disconnect", "/api/shadow/member/account", "/api/shadow/member/games", "/api/shadow/member/history"]);
/**
 * THE EXTENSION'S SWITCHES, served with the markets list so the service, not the build, decides:
 * EVENT_SHADOW_EXT_MIN_VERSION   the version below which the extension shows "update" and draws nothing
 * EVENT_SHADOW_EXT_MARKS_OFF     venues (comma list: prophetx,kalshi,novig,stx) whose marks are off for now
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
      // the holder's wallets only: the service's hedge subaccount sits in the same account and is left out
      const c = new VenueClient({ host: signed.host, signer: signerFromPem(signed.keyId, signed.pem), excludeWallets: excludedWalletsFromEnv(process.env) });
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
 * Read the holder's positions again once the cache is stale. A position whose market the venue
 * failed to describe on this pass (a lookup that timed out or was rate limited) keeps the match
 * the last pass made for it, so a passing fault at the venue does not make a position drop out of
 * our market and back in between two reads.
 */
async function refreshPositions(fresh = false): Promise<HolderPosition[]> {
  if (!venueClient || !listGameMarketsFn) return [];
  if (positionsCache && !fresh && Date.now() - positionsCache.at <= POSITIONS_TTL_MS) return positionsCache.positions;
  const markets = await listGameMarketsFn();
  const read = await venueClient.holderPositions(markets);
  const before = new Map((positionsCache?.positions ?? []).map((p) => [p.id, p]));
  const positions = read.map((p) => {
    const prev = before.get(p.id);
    return !p.ticker && p.reason === "market_lookup_failed" && prev?.ticker ? { ...prev, contracts: p.contracts, entryCents: p.entryCents, costCents: p.costCents, payoutCents: p.payoutCents } : p;
  });
  positionsCache = { at: Date.now(), positions };
  return positions;
}
/**
 * The holder's position on the OTHER club of this market's game, as the venue reports it, when
 * their account is readable and they hold nothing on this market. Null otherwise: no key, a read
 * that failed (the lock then proceeds as it does with no key at all), a position on this side, or
 * none on the game.
 */
/**
 * The service's own hedge, seen from the venue it was bought on. A Novig holder's Portfolio shows
 * the hedge subaccount's positions beside their own, so the other side of an open lock held
 * elsewhere and hedged on Novig appears as a card of theirs; a lock on it would hedge the hedge,
 * and the venue nets the two sides in one account and pays out early. Novig only, for now: on
 * Kalshi and ProphetX the hedges go through the aggregator and never show as the holder's cards.
 * Returns the lock the hedge belongs to, or null.
 */
function ownHedgeOn(ticker: string, venue: SettlementVenue, ledger: string): ShadowPosition | null {
  if (venue !== "novig") return null;
  const stem = ticker.slice(0, ticker.lastIndexOf("-") + 1);
  for (const p of loadShadowPositions(ledger)) {
    if (p.status !== "open" || p.source !== "lock" || p.route === "member_sale" || p.ticker === ticker || !p.ticker.startsWith(stem)) continue;
    const route = p.routing?.chosen ?? null;
    if (route && hedgeVenueOf(route) === venue && (p.holderVenue ?? "kalshi") !== venue) return p;
  }
  return null;
}

async function heldOtherSideOf(ticker: string): Promise<HolderPosition | null> {
  if (!venueClient || !listGameMarketsFn) return null;
  let positions: HolderPosition[];
  try {
    positions = await refreshPositions();
  } catch {
    return null;
  }
  const stem = ticker.slice(0, ticker.lastIndexOf("-") + 1);
  const onGame = positions.filter((p) => p.ticker && p.ticker.startsWith(stem));
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
 * MEMBER APP (crossVenue/memberApp.ts, crossVenue/memberSale.ts). On the outcome-market exchange
 * (hedgeRouting venue "stx") the member connects their own account through the venue's OAuth and
 * a lock is their own limit sell of part of the position into the venue's bid: the cash lands in
 * their balance, the rest rides to the game. No hedge, no counterparty, no capital or fee of ours;
 * the record carries it as route "member_sale", floor and cap read off the fills. The member is
 * the lock caller (a holder alias from EVENT_SHADOW_HOLDER_KEYS, "shared" for the shared key);
 * the extension never holds a token. In the background the same size is priced on the hedge
 * routes and written beside the sale, nothing sent (memberSale.compared).
 *   GET  /api/shadow/member                       this caller's connection state (never a token)
 *   GET  /api/shadow/member/connect               {url}: the venue's authorize page the browser opens
 *   GET  /api/shadow/member/callback?code&state   the venue's redirect, keyless (the one-time state is the key); an HTML page
 *   POST /api/shadow/member/disconnect            revoke at the venue (best effort) and drop the tokens
 * Env: MEMBER_APP_HOST · MEMBER_APP_CLIENT_ID · MEMBER_APP_CLIENT_SECRET · MEMBER_APP_TOKEN_KEY (32 bytes)
 *      · MEMBER_APP_REDIRECT_URI (default <public url>/api/shadow/member/callback) · MEMBER_APP_TOKENS_PATH
 *      · MEMBER_APP_SCOPES · MEMBER_APP_ORDER_WAIT_MS (default 3000) · MEMBER_APP_COMPARE_WAIT_MS (default 4000; 0 = off)
 *      · MEMBER_APP_VENUE_URL (the venue's own web app, linked from the hosted page's top bar)
 *
 * THE HOSTED PAGE (memberAppHtml.ts), GET /app: the member's own surface, no extension to install.
 * Its session is a cookie this service sets on the first visit (HttpOnly, SameSite=Lax, Secure on
 * https; never the token, never a key). A valid cookie names a holder alias `m-<16 hex>` (a hash
 * of the cookie, so no ledger file carries the secret) and that alias is the member on every
 * route above and on the lock routes, in the member's own lane only: positions read no venue
 * account of ours, quote and lock are the member venue's alone (any other venue is 403), leave
 * early and the receipt see that alias's own ledger. POSTs from the cookie must carry the
 * x-member-app header, which a cross-site form cannot. The venue's redirect sends a cookie
 * member back to /app, not to the one-line page the extension's flow lands on.
 */
const MEMBER_VENUE = "stx" as const;
const MEMBER_CALLBACK_PATH = "/api/shadow/member/callback";
const MEMBER_APP_PATH = "/app";
const MEMBER_COOKIE = "ael_member";
const MEMBER_COOKIE_MAX_AGE_S = 180 * 86_400;
const MEMBER_ALIAS_PREFIX = "m-";
const memberApp = memberAppConfigFromEnv(process.env, { redirectUri: `${RECORD_URL}${MEMBER_CALLBACK_PATH}`, storePath: join(dirname(LOCK_LEDGER_PATH), "member-tokens.json") });
let memberSessions: MemberSessions | null = memberApp.config ? new MemberSessions(memberApp.config) : null;
const MEMBER_APP_VENUE_URL = (process.env.MEMBER_APP_VENUE_URL ?? "").trim().replace(/\/+$/, "") || null;
/**
 * The page's own host, when it has one (a subdomain pointed at this service): there the root is
 * the page, the page's files and the API answer as always, and every other path (the public
 * record, the embed, the operator views) is sent to the record URL, so the venue-neutral public
 * pages are never served under a host named for a venue.
 */
const MEMBER_APP_HOSTNAME = (process.env.MEMBER_APP_HOSTNAME ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "") || null;
const MEMBER_APP_ORIGIN = MEMBER_APP_HOSTNAME ? `https://${MEMBER_APP_HOSTNAME}` : null;
/** who a member writes to for removal, named on the privacy page; the sentence is left out when unset */
const MEMBER_APP_CONTACT = (process.env.MEMBER_APP_CONTACT ?? "").trim() || null;
/** where each member's connect began (the page's own host, or "" for the record URL), so the venue's callback sends them back to the same origin, where their cookie is */
const memberConnectOrigin = new Map<string, string>();
const isMemberAppHost = (req: IncomingMessage): boolean => {
  if (!MEMBER_APP_HOSTNAME) return false;
  const fwd = req.headers["x-forwarded-host"];
  const host = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0].trim() || req.headers.host || "";
  return host.split(":")[0].toLowerCase() === MEMBER_APP_HOSTNAME;
};
/** the page's files under /app/: the marks, the icons, the manifest (so the page can live on a home screen) */
const MEMBER_APP_FILES: Record<string, { type: string; body: Buffer }> = {
  "stx.png": { type: "image/png", body: STX_LOGO_PNG },
  "bird.png": { type: "image/png", body: ATTICUS_BIRD_PNG },
  "atticus.png": { type: "image/png", body: ATTICUS_WORDMARK_PNG },
  "icon-180.png": { type: "image/png", body: ICON_180_PNG },
  "icon-192.png": { type: "image/png", body: ICON_192_PNG },
  "icon-512.png": { type: "image/png", body: ICON_512_PNG },
  "manifest.webmanifest": {
    type: "application/manifest+json",
    body: Buffer.from(
      JSON.stringify({
        name: `Lock in · ${VENUE_NAMES[MEMBER_VENUE]}`,
        short_name: "Lock in",
        start_url: `${MEMBER_APP_PATH}?source=home`,
        scope: `${MEMBER_APP_PATH}`,
        display: "standalone",
        background_color: "#010101",
        theme_color: "#010101",
        icons: [
          { src: `${MEMBER_APP_PATH}/icon-192.png`, sizes: "192x192", type: "image/png" },
          { src: `${MEMBER_APP_PATH}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      }),
      "utf8",
    ),
  },
};

/** The cookie's value, when the request carries one of the right shape; nothing is trusted beyond its shape. */
function memberCookieValue(req: IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k !== MEMBER_COOKIE) continue;
    const v = rest.join("=").trim();
    return /^[A-Za-z0-9_-]{43}$/.test(v) ? v : null;
  }
  return null;
}
/** The holder alias a cookie stands for: a hash of it, so the alias may sit in a file name and a log line. */
const memberAliasOf = (cookie: string): string => `${MEMBER_ALIAS_PREFIX}${createHash("sha256").update(cookie, "ascii").digest("hex").slice(0, 16)}`;
const isMemberAlias = (holder: string | null): boolean => Boolean(holder && holder.startsWith(MEMBER_ALIAS_PREFIX));
/** The cookie member on this request, when the member app is on and the cookie is sound; null otherwise. */
function memberCookieHolder(req: IncomingMessage): string | null {
  if (!memberSessions) return null;
  const v = memberCookieValue(req);
  return v ? memberAliasOf(v) : null;
}
function memberCookieHeader(value: string): string {
  const secure = RECORD_URL.startsWith("https://") ? "; Secure" : "";
  return `${MEMBER_COOKIE}=${value}; Path=/; Max-Age=${MEMBER_COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax${secure}`;
}
const positiveMs = (raw: string | undefined, dflt: number): number => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : dflt;
};
/** how long a member's order may rest on the venue before the rest is cancelled; the tests shorten it */
let memberOrderOpts: ExecuteOptions = { waitMs: positiveMs(process.env.MEMBER_APP_ORDER_WAIT_MS, 3000) };
const MEMBER_COMPARE_WAIT_MS = positiveMs(process.env.MEMBER_APP_COMPARE_WAIT_MS, 4000);
/**
 * In play, on unless MEMBER_APP_IN_PLAY=0: a member may lock while the game is on, and the pre-game
 * cutoff does not apply (the sale is their own limit sell into the venue's bids; no one here carries
 * the game's risk, so there is nothing to cut off). The venue holds an in-play order for the market's
 * delay before it can match, so the order rests at least that long past the usual wait. Off: pre-game only.
 */
let memberInPlay = !/^(0|false|no|off)$/i.test(process.env.MEMBER_APP_IN_PLAY ?? "");
/**
 * Combos, off unless MEMBER_APP_COMBO_RFQ=1: a member's combination (parlay) ticket is protected
 * the same way a single is, part of it sold, with the bid coming from the venue's request for
 * quote instead of a book (a combo market has none). The venue has not shipped the quote path,
 * and its shape in the client is assumed (memberApp.ts, RawMemberRfq): off, a combo row reads as
 * it always has, riding to settlement. No leave early on a combo: there is nothing to buy it back from.
 * MEMBER_APP_COMBO_RFQ=preview shows the flow before the venue quotes: the combo rows quote from a
 * stand-in bid (a tenth under the ticket's own last price), said to be a preview on the page, and
 * the tap is refused in words (combo_preview); nothing is asked of the venue and nothing is sold.
 */
type ComboRfqMode = "off" | "on" | "preview";
const comboRfqModeOf = (v: string | undefined): ComboRfqMode => (/^preview$/i.test(v ?? "") ? "preview" : /^(1|true|yes|on)$/i.test(v ?? "") ? "on" : "off");
let memberComboRfq: ComboRfqMode = comboRfqModeOf(process.env.MEMBER_APP_COMBO_RFQ);
/** a stand-in quote in preview: this far under the ticket's last price */
const COMBO_PREVIEW_HAIRCUT = 0.9;
const LIVE_EVENT_WORDS = /in_progress|in_play|in-play|live|started|underway/;
const OVER_WORDS = /closed|resulted|settled|cancel|void|completed|final/;
/** the game is on at the venue's own word, or on the clock when the venue gives none */
const marketLive = (m: RawOutcomeMarket, startMs: number, nowMs: number): boolean => {
  const ev = String(m.event_status ?? "").toLowerCase();
  if (LIVE_EVENT_WORDS.test(ev)) return true;
  if (OVER_WORDS.test(ev)) return false;
  return Number.isFinite(startMs) && startMs <= nowMs;
};
const inPlayDelaySecOf = (m: RawOutcomeMarket): number => Math.max(0, Number(m.in_play_delay_sec) || 0);
/** the order's rest when the game is on: the venue's delay on top of the usual wait, so the order outlives the hold */
const memberOrderOptsFor = (live: boolean, delaySec: number): ExecuteOptions => (live && delaySec > 0 ? { ...memberOrderOpts, waitMs: (memberOrderOpts.waitMs ?? 3000) + delaySec * 1000 } : memberOrderOpts);
const memberPositionsCache = new Map<string, { at: number; positions: MemberHolderPosition[] }>();

/** where a combination's picks were placed, kept beside the token store so a played leg still reads its result after a restart */
let comboLegMemoryInst: ComboLegMemory | null = null;
const comboLegMemory = (): ComboLegMemory => {
  if (!comboLegMemoryInst) comboLegMemoryInst = new ComboLegMemory(memberSessions ? join(dirname(memberSessions.cfg.storePath), "member-combo-legs.json") : null);
  return comboLegMemoryInst;
};

/** The member's positions on our markets, read again once the cache is stale (the same keep-last-match rule as refreshPositions). */
async function refreshMemberPositions(member: string, fresh = false): Promise<MemberHolderPosition[]> {
  if (!memberSessions || !listGameMarketsFn) return [];
  const hit = memberPositionsCache.get(member);
  if (hit && !fresh && Date.now() - hit.at <= POSITIONS_TTL_MS) return hit.positions;
  const markets = await listGameMarketsFn();
  // a combination's legs are placed on the venue's own listings (every competition it has a code for), read only when one is held
  const listings = async (): Promise<RawOutcomeMarket[]> => {
    const out: RawOutcomeMarket[] = [];
    for (const code of new Set(Object.values(memberSessions!.cfg.competitionCodes))) {
      try {
        out.push(...(await memberCompetitionMarkets(member, code)));
      } catch {
        // a competition that would not list leaves its legs as words
      }
    }
    return out;
  };
  const read = await memberHolderPositions(memberSessions.client(member), markets, memberSessions.cfg.competitionCodes, listings, comboLegMemory());
  const before = new Map((hit?.positions ?? []).map((p) => [p.id, p]));
  const positions = read.map((p) => {
    const prev = before.get(p.id);
    return !p.ticker && p.reason === "market_lookup_failed" && prev?.ticker ? { ...prev, contracts: p.contracts, entryCents: p.entryCents, costCents: p.costCents, payoutCents: p.payoutCents } : p;
  });
  memberPositionsCache.set(member, { at: Date.now(), positions });
  return positions;
}

/** This caller's member connection as the client sees it: on or off and why, never a token. Null when the member app is not configured. */
function memberView(member: string) {
  if (!memberSessions) return null;
  return { venue: MEMBER_VENUE, venueName: VENUE_NAMES[MEMBER_VENUE], configured: true, ...memberSessions.state(member) };
}

/** the balance is read again after this long; a lock or a buy-back reads it fresh */
const MEMBER_BALANCE_TTL_MS = 10_000;
const memberBalanceCache = new Map<string, { at: number; balance: MemberBalance | null; scope: boolean }>();
const memberProfileChecked = new Set<string>();

/**
 * The member's account as the page's top line shows it: the handle and avatar the venue shows
 * them under, and the balance the sale lands in. A grant without balance.read (connected before
 * the scope was asked) says so, so the page can offer the reconnect; nothing else fails on it.
 */
async function memberAccount(member: string, fresh: boolean): Promise<{ profile: { handle: string | null; avatarUrl: string | null }; balance: MemberBalance | null; balanceScope: boolean }> {
  const st = memberSessions!.state(member);
  const profile = st.connected ? { handle: st.handle, avatarUrl: st.avatarUrl } : { handle: null, avatarUrl: null };
  if (st.connected && !st.handle && !memberProfileChecked.has(member)) {
    // a handle set after the connect, or a connect whose profile read missed: once per process
    memberProfileChecked.add(member);
    try {
      await memberSessions!.refreshProfile(member);
      const again = memberSessions!.state(member);
      if (again.connected) Object.assign(profile, { handle: again.handle, avatarUrl: again.avatarUrl });
    } catch {
      // the ids stay as they were
    }
  }
  const hit = memberBalanceCache.get(member);
  if (hit && !fresh && Date.now() - hit.at <= MEMBER_BALANCE_TTL_MS) return { profile, balance: hit.balance, balanceScope: hit.scope };
  let balance: MemberBalance | null = null;
  let scope = true;
  try {
    balance = await memberSessions!.client(member).balance();
  } catch (err) {
    if (err instanceof MemberApiError && err.code === "insufficient_scope") scope = false;
    else throw err;
  }
  memberBalanceCache.set(member, { at: Date.now(), balance, scope });
  return { profile, balance, balanceScope: scope };
}

/** the venue's competition listing, shared by every member (it is the public catalogue), kept 45 s */
const memberCatalogCache = new Map<string, { at: number; markets: RawOutcomeMarket[] }>();
const MEMBER_CATALOG_TTL_MS = 45_000;
/** what the listing endpoint's books look like, per competition, for the operator: does the list carry depth at all, and one market's top of book as the wire gave it */
const memberCatalogSample = new Map<string, Record<string, unknown>>();
async function memberCompetitionMarkets(member: string, competition: string): Promise<RawOutcomeMarket[]> {
  const key = competition.toUpperCase();
  const hit = memberCatalogCache.get(key);
  if (hit && Date.now() - hit.at <= MEMBER_CATALOG_TTL_MS) return hit.markets;
  const markets = await memberSessions!.client(member).listCompetitionMarkets(key);
  memberCatalogCache.set(key, { at: Date.now(), markets });
  const winners = markets.filter((m) => winnerClubOf(m));
  const withBids = winners.filter((m) => (m.bids ?? []).length > 0);
  const bestBids = withBids.map((m) => outcomeBids(m)[0]?.priceMilli ?? 0);
  const one = withBids[0] ?? winners[0] ?? null;
  memberCatalogSample.set(key, {
    readAt: new Date().toISOString(),
    markets: markets.length,
    winners: winners.length,
    winnersWithBids: withBids.length,
    distinctBestBids: new Set(bestBids).size,
    ...(one ? { sample: { marketId: one.market_id, status: one.status ?? null, trading: one.trading ?? null, price: one.price ?? null, lastTradedPrice: one.last_traded_price ?? null, bids: (one.bids ?? []).slice(0, 3), offers: (one.offers ?? []).slice(0, 3) } } : {}),
  });
  return markets;
}

/**
 * THE GAMES A MEMBER COULD PROTECT: every protectable market of ours that the venue lists too,
 * with the venue's own market and event (the page links the member to the event on the venue to
 * buy; this service never buys for anyone), the best bid there now, and what a Max floor lock
 * would keep of it per contract. Grouped by game on the page. Only leagues the venue has a
 * competition code for are read.
 */
async function memberGames(member: string, held: Set<string>): Promise<{ games: Array<Record<string, unknown>>; leagues: string[]; readAt: string }> {
  // games still outside the cutoff: a game a lock can no longer be placed on is not one to buy for protection
  const nowMs = Date.now();
  const rows = (await listGameMarketsFn!()).filter((m) => m.protectable && m.startIso && Date.parse(m.startIso) - protectCutoffMinutes * 60_000 > nowMs);
  const codes = memberSessions!.cfg.competitionCodes;
  const leagues = [...new Set(rows.map((r) => r.league))];
  const byTicker = new Map<string, { market: RawOutcomeMarket; league: string }>();
  for (const league of leagues) {
    const code = outcomeCompetitionCode(league, codes);
    let markets: RawOutcomeMarket[];
    try {
      markets = await memberCompetitionMarkets(member, code);
    } catch {
      continue;
    }
    const protectable = rows.filter((r) => r.league === league).map((r) => ({ ticker: r.ticker, league: r.league, dateIso: r.dateIso, sideName: r.sideName, title: r.title }));
    for (const m of markets) {
      if (!winnerClubOf(m)) continue;
      const matched = matchMemberMarket(m, leagueOfCompetition(m.competition, codes) ?? league, protectable);
      if (matched.ticker && !byTicker.has(matched.ticker)) byTicker.set(matched.ticker, { market: m, league });
    }
  }
  const games = rows
    .map((r) => {
      const hit = byTicker.get(r.ticker);
      if (!hit) return null;
      const m = hit.market;
      const maxPrice = outcomeMaxPrice(m);
      const bids = outcomeBids(m);
      const bestBidCents = bids[0] ? Math.round(bids[0].priceMilli / 10) : null;
      const last = Number(m.last_traded_price ?? m.price);
      const lastCents = Number.isFinite(last) && last > 0 ? Math.round((last / maxPrice) * 100) : null;
      const eventId = m.event_id ?? m.grouping_id?.split(":")[0] ?? null;
      const club = winnerClubOf(m);
      return {
        ticker: r.ticker,
        league: r.league,
        // the club as the venue names it, so the row reads as the portfolio does
        side: club?.name ?? r.sideName,
        opponent: club?.opponent ?? null,
        home: club ? club.side === "home" : null,
        event: (m.event_title ?? "").trim() || r.title,
        startIso: r.startIso,
        untilIso: r.protectableUntilIso,
        markCents: r.markCents,
        held: held.has(r.ticker),
        venue: {
          marketId: m.market_id,
          eventId,
          url: MEMBER_APP_VENUE_URL && eventId ? `${MEMBER_APP_VENUE_URL}/events/${encodeURIComponent(eventId)}` : null,
          trading: m.trading !== false,
          bestBidCents,
          lastCents,
          // a Max floor lock sells 80% into the bid: what each contract keeps on a loss
          floorFromCents: bestBidCents === null ? null : Math.floor(bestBidCents * 0.8),
        },
      };
    })
    .filter((g): g is NonNullable<typeof g> => g !== null)
    .sort((a, b) => Date.parse(a.startIso as string) - Date.parse(b.startIso as string) || String(a.event).localeCompare(String(b.event)));
  return { games, leagues, readAt: new Date().toISOString() };
}

/** A member API failure as a lock refusal: what the venue said, what the member can do. Nothing is written on any of these. */
function memberRefusal(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof MemberApiError) {
    switch (err.code) {
      case "not_connected":
        return { status: 409, body: { ok: false, error: "member_not_connected", code: "member_not_connected", message: `Connect your ${VENUE_NAMES[MEMBER_VENUE]} account first.` } };
      case "insufficient_scope":
        return { status: 409, body: { ok: false, error: "member_scope", code: "member_scope", message: `Your ${VENUE_NAMES[MEMBER_VENUE]} connection does not allow ${err.scope === "orders.write" ? "orders" : err.scope ?? "this"}; reconnect and allow it.`, scope: err.scope ?? null } };
      case "terms_required":
        return { status: 409, body: { ok: false, error: "member_terms", code: "member_terms", message: `${VENUE_NAMES[MEMBER_VENUE]} needs you to accept its terms first.`, termsUrl: err.termsUrl ?? null } };
      case "ip_not_allowed":
        return { status: 409, body: { ok: false, error: "member_ip", code: "member_ip", message: `${VENUE_NAMES[MEMBER_VENUE]} refused the order from this service's address; the operator has to allowlist it.` } };
      case "unauthorized":
        return { status: 409, body: { ok: false, error: "member_not_connected", code: "member_not_connected", message: `Your ${VENUE_NAMES[MEMBER_VENUE]} connection lapsed; connect it again.` } };
      default:
        return { status: 502, body: { ok: false, error: "venue_refused", code: "venue_refused", message: `${VENUE_NAMES[MEMBER_VENUE]} refused: ${err.message}` } };
    }
  }
  return { status: 502, body: { ok: false, error: "venue_unreachable", code: "venue_unreachable", message: `${VENUE_NAMES[MEMBER_VENUE]} could not be reached: ${String(err instanceof Error ? err.message : err)}` } };
}

/** What the member's lock is priced from: their position, the venue's market and book, our game row, the three tiers. */
interface MemberPriced {
  member: string;
  pos: MemberHolderPosition;
  market: RawOutcomeMarket;
  maxPrice: number;
  /** the holder's size in our $1 contracts, and in the venue's own contracts */
  contracts: number;
  venueContracts: number;
  entryCents: number;
  game: { league: string; sideName: string; eventTitle: string; eventTimeIso: string; markCents: number };
  tiers: Record<ProtectionTier, SaleTierQuote | null>;
  bestBidCents: number | null;
  bidDepth: number;
  /** the game is on (only with MEMBER_APP_IN_PLAY); the venue's hold on an in-play order, seconds */
  live: boolean;
  inPlayDelaySec: number;
  /** a combination ticket: the venue's quote the tiers were read from, and the legs it carries (MEMBER_APP_COMBO_RFQ); preview: a stand-in bid, nothing asked of the venue */
  combo?: { bid: RfqBid; legs: number; preview: boolean };
}

type MemberPricedResult = { ok: true; priced: MemberPriced } | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Price a member's lock on one market: refuse before the book is read when the account is not
 * connected, holds nothing on the market (or holds the other club), holds less than asked, the
 * game is over or paused, or (in-play off) the game has started or is inside the pre-game cutoff;
 * then the three tiers from the venue's bids as they stand. A combination ticket (its synthetic
 * ticker) is priced from the venue's quote instead (memberComboPriced).
 */
async function memberPriced(member: string, ticker: string, contracts: number, entryCents: number | undefined, fresh: boolean): Promise<MemberPricedResult> {
  if (!memberSessions) return { ok: false, status: 404, body: { ok: false, error: "member_app_off", code: "member_app_off", message: "The member app is not configured on this service." } };
  if (!memberSessions.state(member).connected) return { ok: false, status: 409, body: { ok: false, error: "member_not_connected", code: "member_not_connected", message: `Connect your ${VENUE_NAMES[MEMBER_VENUE]} account first.` } };
  let positions: MemberHolderPosition[];
  try {
    positions = await refreshMemberPositions(member, fresh);
  } catch (err) {
    return { ok: false, ...memberRefusal(err) };
  }
  if (isComboTicker(ticker)) return memberComboPriced(member, ticker, contracts, entryCents, positions);
  const stem = ticker.slice(0, ticker.lastIndexOf("-") + 1);
  const pos = positions.find((p) => p.ticker === ticker);
  if (!pos) {
    const other = positions.find((p) => p.ticker && p.ticker.startsWith(stem));
    if (other) return { ok: false, status: 409, body: { ok: false, error: "wrong_side", code: "wrong_side", message: `Your pick on this game is ${other.side || "the other side"}; protect it from that card.`, heldTicker: other.ticker } };
    return { ok: false, status: 409, body: { ok: false, error: "not_held", code: "not_held", message: `Your ${VENUE_NAMES[MEMBER_VENUE]} account holds nothing on this market.` } };
  }
  if (contracts > pos.contracts + 1e-9) return { ok: false, status: 409, body: { ok: false, error: "size", code: "size", message: `You hold ${pos.contracts} on this market; the lock can cover up to that.`, held: pos.contracts } };
  let market = pos.market;
  if (!market) {
    try {
      market = (await memberSessions.client(member).markets([pos.marketId]))[0] ?? null;
    } catch (err) {
      return { ok: false, ...memberRefusal(err) };
    }
    if (!market) return { ok: false, status: 502, body: { ok: false, error: "venue_refused", code: "venue_refused", message: `${VENUE_NAMES[MEMBER_VENUE]} did not describe the market.` } };
  }
  const row = (await listGameMarketsFn!()).find((m) => m.ticker === ticker);
  const eventTimeIso = row?.startIso ?? pos.startsIso ?? null;
  if (!row || !eventTimeIso || !row.league) return { ok: false, status: 200, body: { ok: false, code: "not_offered", message: "Protection isn't offered on this market." } };
  const startMs = Date.parse(eventTimeIso);
  const now = Date.now();
  const VN = VENUE_NAMES[MEMBER_VENUE];
  const statusWords = `${market.status ?? ""} ${market.event_status ?? ""}`.toLowerCase();
  if (!Number.isFinite(startMs) || OVER_WORDS.test(statusWords)) return { ok: false, status: 200, body: { ok: false, code: "market_not_active", message: `This game is over; ${VN} is settling it.` } };
  const live = memberInPlay && marketLive(market, startMs, now);
  if (!memberInPlay) {
    if (startMs <= now) return { ok: false, status: 200, body: { ok: false, code: "market_not_active", message: "This game has started; the lock is pre-game only." } };
    if (startMs - now < protectCutoffMinutes * 60_000) return { ok: false, status: 200, body: { ok: false, code: "market_too_close_to_start", message: `This one starts too soon to protect (locks close ${protectCutoffMinutes} minutes before the start).`, untilIso: new Date(startMs - protectCutoffMinutes * 60_000).toISOString() } };
  }
  // the venue pauses a market for a moment at a score or a review: nothing matches until it resumes
  if (market.trading === false || /suspend/.test(statusWords)) return { ok: false, status: 200, body: { ok: false, code: "market_suspended", message: `${VN} has paused this market for the moment; try again in a few seconds.` } };
  const maxPrice = outcomeMaxPrice(market);
  const venueContracts = Math.floor(contracts / maxPrice + 1e-9);
  const bids = bidLevels(market);
  const tiers = quoteSaleTiers({ positionContracts: venueContracts, maxPrice, bids });
  if (!tiers.wide && !tiers.balanced && !tiers.tight) return { ok: false, status: 200, body: { ok: false, code: "no_bids", message: `${VENUE_NAMES[MEMBER_VENUE]} shows no bids on this market right now; nothing to sell into.` } };
  return {
    ok: true,
    priced: {
      member,
      pos,
      market,
      maxPrice,
      contracts,
      venueContracts,
      entryCents: entryCents ?? pos.entryCents,
      // the game's name as the venue gives it (Away at Home); our market's title otherwise
      game: { league: row.league, sideName: row.sideName, eventTitle: pos.event || row.title, eventTimeIso, markCents: row.markCents },
      tiers,
      bestBidCents: bids[0] ? Math.round((bids[0].price / maxPrice) * 100) : null,
      bidDepth: Math.floor(bids.reduce((s, l) => s + l.quantity, 0)),
      live,
      inPlayDelaySec: live ? inPlayDelaySecOf(market) : 0,
    },
  };
}

/** A member's combination ticket is a quotable row only with MEMBER_APP_COMBO_RFQ on and the ticket still live: no leg missed, not every leg in. */
const comboLockable = (p: MemberHolderPosition): boolean => {
  if (memberComboRfq === "off" || p.reason !== "parlay") return false;
  const legs = p.legs ?? [];
  if (legs.some((l) => l.state === "lost")) return false;
  return !(legs.length > 0 && legs.every((l) => l.state === "won" || l.state === "void"));
};

/** The member's combination ticket the synthetic ticker names, among their positions. */
const comboPositionOf = (positions: MemberHolderPosition[], ticker: string): MemberHolderPosition | undefined => positions.find((p) => p.reason === "parlay" && comboTickerOf(p.marketId) === ticker);

/**
 * Price a member's lock on a combination ticket: the same refusals as a single, then one quote
 * asked of the venue's makers on the largest shape's size (Max floor, 80%), read as one bid level
 * so the three shapes walk it like a book. Nothing is accepted here; the lock asks again at the
 * tap and accepts that quote.
 */
async function memberComboPriced(member: string, ticker: string, contracts: number, entryCents: number | undefined, positions: MemberHolderPosition[]): Promise<MemberPricedResult> {
  const VN = VENUE_NAMES[MEMBER_VENUE];
  if (memberComboRfq === "off") return { ok: false, status: 409, body: { ok: false, error: "parlay_unsupported", code: "parlay_unsupported", message: `A parlay is not locked on ${VN}; the lock sells part of one position.` } };
  const pos = comboPositionOf(positions, ticker);
  if (!pos) return { ok: false, status: 409, body: { ok: false, error: "not_held", code: "not_held", message: `Your ${VN} account holds no such combo.` } };
  if (contracts > pos.contracts + 1e-9) return { ok: false, status: 409, body: { ok: false, error: "size", code: "size", message: `You hold ${pos.contracts} on this ticket; the lock can cover up to that.`, held: pos.contracts } };
  const legs = pos.legs ?? [];
  if (legs.some((l) => l.state === "lost")) return { ok: false, status: 200, body: { ok: false, code: "combo_missed", message: "A leg missed; this ticket has settled its way." } };
  if (legs.length > 0 && legs.every((l) => l.state === "won" || l.state === "void")) return { ok: false, status: 200, body: { ok: false, code: "combo_settling", message: `Every leg hit; ${VN} is settling this ticket.` } };
  const client = memberSessions!.client(member);
  let market: RawOutcomeMarket | undefined;
  try {
    market = (await client.markets([pos.marketId]))[0];
  } catch (err) {
    return { ok: false, ...memberRefusal(err) };
  }
  if (!market) return { ok: false, status: 502, body: { ok: false, error: "venue_refused", code: "venue_refused", message: `${VN} did not describe the ticket.` } };
  const statusWords = `${market.status ?? ""} ${market.event_status ?? ""}`.toLowerCase();
  if (OVER_WORDS.test(statusWords) || market.settled_at) return { ok: false, status: 200, body: { ok: false, code: "market_not_active", message: `This ticket is over; ${VN} is settling it.` } };
  // the record settles after the last leg; the page's first-leg start stays on the position
  const lastLegIso = legs.map((l) => l.startsIso).filter((x): x is string => Boolean(x)).sort().at(-1) ?? (market.event_start ? new Date(market.event_start).toISOString() : null) ?? pos.startsIso;
  if (!lastLegIso || !Number.isFinite(Date.parse(lastLegIso))) return { ok: false, status: 200, body: { ok: false, code: "not_offered", message: "Protection isn't offered on this ticket: no leg has a start time." } };
  const live = legs.some((l) => l.state === "live") || LIVE_EVENT_WORDS.test(statusWords);
  if (live && !memberInPlay) return { ok: false, status: 200, body: { ok: false, code: "market_not_active", message: "A leg is in play; the lock is pre-game only." } };
  if (market.trading === false || /suspend/.test(statusWords)) return { ok: false, status: 200, body: { ok: false, code: "market_suspended", message: `${VN} has paused this ticket for the moment; try again in a few seconds.` } };
  const maxPrice = outcomeMaxPrice(market);
  const venueContracts = Math.floor(contracts / maxPrice + 1e-9);
  const askFor = Math.max(1, Math.floor(venueContracts * SALE_SHARE.tight));
  // the ticket's own last price, as the venue shows it (the market's field, else its last trade), per $1
  const lastTrade = (market.recent_trades ?? []).map((t) => Number(t?.price)).filter((x) => Number.isFinite(x) && x > 0).at(-1);
  const lastPx = Number(market.last_traded_price ?? market.price ?? lastTrade);
  const lastCents = Number.isFinite(lastPx) && lastPx > 0 && lastPx < maxPrice ? Math.round((lastPx / maxPrice) * 100) : null;
  const preview = memberComboRfq === "preview";
  let bid: RfqBid;
  if (preview) {
    // a stand-in bid a tenth under the ticket's last price (its entry when the venue shows none); nothing is asked of the venue
    const standIn = Math.max(1, Math.floor((lastCents ?? pos.entryCents) * COMBO_PREVIEW_HAIRCUT));
    const price = (standIn / 100) * maxPrice;
    bid = { rfq: { id: "preview", status: "quoted", market_id: pos.marketId, action: "sell", quantity: String(askFor), price: price.toFixed(2), client_rfq_id: null }, level: { price, quantity: askFor }, reason: null, expiresAtIso: null };
  } else {
    try {
      bid = await requestRfqBid(client, { market_id: pos.marketId, action: "sell", quantity: String(askFor), client_rfq_id: clientOrderIdFor("rfq", ticker) }, maxPrice, memberOrderOpts);
    } catch (err) {
      // the venue has not shipped the quote path: its 404 is "not yet", not an outage
      if (err instanceof MemberApiError && err.status === 404) return { ok: false, status: 200, body: { ok: false, code: "combo_quotes_unavailable", message: `${VN} isn't quoting combo tickets yet.` } };
      return { ok: false, ...memberRefusal(err) };
    }
  }
  if (!bid.level) {
    const why = bid.reason === "declined" ? `${VN}'s makers passed on this ticket right now.` : bid.reason === "expired" ? `${VN}'s quote lapsed before it could be read; try again.` : `${VN} did not price this ticket in time; try again.`;
    return { ok: false, status: 200, body: { ok: false, code: "no_bids", rfq: bid.reason, message: why } };
  }
  const tiers = quoteSaleTiers({ positionContracts: venueContracts, maxPrice, bids: [bid.level] });
  if (!tiers.wide && !tiers.balanced && !tiers.tight) return { ok: false, status: 200, body: { ok: false, code: "no_bids", message: `${VN}'s quote cannot fund a shape at this size.` } };
  const bidCents = Math.round((bid.level.price / maxPrice) * 100);
  // the mark is the ticket's own last price when the venue shows one, the quote otherwise
  const markCents = lastCents ?? bidCents;
  return {
    ok: true,
    priced: {
      member,
      pos,
      market,
      maxPrice,
      contracts,
      venueContracts,
      entryCents: entryCents ?? pos.entryCents,
      game: { league: pos.league ?? "combo", sideName: pos.side || `${legs.length}-leg combo`, eventTitle: pos.event || (market.symbol ?? "").trim() || "Combo", eventTimeIso: lastLegIso, markCents },
      tiers,
      bestBidCents: bidCents,
      bidDepth: Math.floor(bid.level.quantity),
      live,
      inPlayDelaySec: 0,
      combo: { bid, legs: legs.length, preview },
    },
  };
}

/** per-contract figure for the tables from a whole-position total: the totals on the sale are what settlement pays */
const perContract = (totalCents: number, contracts: number): number => (contracts > 0 ? Math.round(totalCents / contracts) : 0);

/** One tier of a member sale as the client paints it: the tier's own totals ride beside the per-contract figures the shared slip reads. */
function saleTierView(t: SaleTierQuote, contracts: number, maxPrice: number, markCents: number) {
  return {
    floorCents: perContract(t.floorTotalCents, contracts),
    capCents: perContract(t.capTotalCents, contracts),
    creditCents: 0,
    evCostBps: saleEvCostBps(t, contracts / maxPrice, maxPrice, markCents),
    floorTotalCents: t.floorTotalCents,
    capTotalCents: t.capTotalCents,
    cashNowCents: t.cashNowCents,
    soldContracts: roundContracts(t.soldContracts * maxPrice),
    keptContracts: roundContracts(t.keptContracts * maxPrice),
    limitPriceCents: t.limitPriceCents,
    avgPriceCents: t.avgPriceCents,
    depthLimited: t.depthLimited,
  };
}

/** The sale as the holder's own views carry it: their order id is theirs to see; the venue's market id and our client id stay in the ledger. */
function memberSaleViewOf(s: MemberSaleRecord) {
  const { marketId: _m, clientOrderId: _c, compared: _cmp, ...rest } = s;
  return { ...rest, venue: MEMBER_VENUE, venueName: VENUE_NAMES[MEMBER_VENUE] };
}

/**
 * The background comparison: the same size priced on the hedge routes now, against the member's
 * venue's rules, nothing sent. Bounded, so a slow venue never holds the member's own sale; what
 * came back in time is written, and "timed_out" otherwise.
 */
async function memberComparison(ticker: string, contracts: number, entryCents: number, at: string, tier?: ProtectionTier): Promise<{ compared: MemberSaleComparison; result: CandidateResult | null }> {
  if (!quoteOneFn || MEMBER_COMPARE_WAIT_MS <= 0) return { compared: { at, ok: false, reason: "off", sent: false }, result: null };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timed_out">((r) => {
    timer = setTimeout(() => r("timed_out"), MEMBER_COMPARE_WAIT_MS);
  });
  try {
    const q = await Promise.race([quoteOneFn({ ticker, contracts, entryCents, holderVenue: MEMBER_VENUE, executable: executableFor(ticker) }).catch((err: unknown) => ({ ok: false as const, code: "unreachable", detail: String(err instanceof Error ? err.message : err) })), timeout]);
    if (q === "timed_out") return { compared: { at, ok: false, reason: "timed_out", sent: false }, result: null };
    if (!q.ok) return { compared: { at, ok: false, reason: q.code, sent: false }, result: null };
    const res = q.result;
    if (!res.quote.ok) return { compared: { at, ok: false, reason: res.quote.code, sent: false }, result: res };
    const r = res.routing;
    // the same shape the member chose, when the hedge routes fund it; else the quote's own head
    const shape = tier && res.quote.tiers[tier] ? { ...res.quote, ...res.quote.tiers[tier], tier } : res.quote;
    return {
      compared: {
        at,
        ok: true,
        tier: shape.tier,
        creditCents: shape.creditCents,
        floorTotalCents: floorTotalCents(shape),
        capTotalCents: capTotalCents(shape),
        chosen: r?.chosen ?? res.route,
        routes: r
          ? r.routes.map((x) => ({ route: x.route, ok: x.ok, creditCents: x.creditCents ?? null, allInBps: x.allInBps ?? null }))
          : res.routesChecked.map((x) => ({ route: x.route, ok: x.ok, creditCents: x.creditCents ?? null, allInBps: null })),
        sent: false,
      },
      result: res,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The comparison as the client paints it: each route's venue named, the chosen one, what a hedged lock would have paid. Null when none was priced. */
function comparedViewOf(c: MemberSaleComparison | undefined, result: CandidateResult | null = null) {
  if (!c) return null;
  const name = (route: HedgeRoute) => HEDGE_VENUE_NAMES[route] ?? route;
  // on a quote, every shape the hedge routes fund, so the client's Compared follows the shape the member picks
  const q = result?.quote.ok ? result.quote : null;
  const tiers = q ? Object.fromEntries(Object.entries(q.tiers).filter(([, t]) => t).map(([k, t]) => [k, { creditCents: t!.creditCents, floorTotalCents: floorTotalCents({ ...q, ...t! }), capTotalCents: capTotalCents({ ...q, ...t! }) }])) : null;
  return {
    ...(tiers && Object.keys(tiers).length ? { tiers } : {}),
    at: c.at,
    ok: c.ok,
    sent: false,
    ...(c.reason ? { reason: c.reason } : {}),
    ...(c.ok
      ? {
          tier: c.tier,
          creditCents: c.creditCents,
          floorTotalCents: c.floorTotalCents,
          capTotalCents: c.capTotalCents,
          chosen: c.chosen ?? null,
          chosenName: c.chosen ? name(c.chosen) : null,
          routes: (c.routes ?? []).map((r) => ({ ...r, venue: name(r.route) })),
          priced: (c.routes ?? []).filter((r) => r.ok).length,
        }
      : {}),
  };
}

/** The rule cells of the member's venue for the league, as the client's rules grid reads them, and the tails in the member's words. */
/** The text a combination ticket's pin is over: the venue's description of the legs and what each must do, its rules word, its specifier. */
const comboRuleText = (m: RawOutcomeMarket): string => [m.description, m.question, m.rules, m.specifier].filter((s): s is string => typeof s === "string" && s.trim() !== "").join("\n");

function memberRulesView(league: string, kept: number, combo = false) {
  // a combination settles under the venue's own combo rules (a voided leg drops out and the ticket re-prices), not a league's tails; the page shows the one sentence under Details
  if (combo) return { tails: [], rules: {}, comboNote: `${VENUE_NAMES[MEMBER_VENUE]} settles the ${kept} riding contract${kept === 1 ? "" : "s"} by its own combo rules: a voided leg drops out and the ticket re-prices. The contracts you sold stay sold.` };
  const cells = rulesFor(MEMBER_VENUE, league);
  return {
    tails: memberTailTerms(VENUE_NAMES[MEMBER_VENUE], cells, kept),
    rules: Object.fromEntries(Object.entries(cells).map(([b, c]) => [b, { treatment: c.treatment, ...(c.windowHours !== undefined ? { windowHours: c.windowHours } : {}), confirmed: c.confirmed, source: c.source, asOf: c.asOf }])),
  };
}

/** The HTML page the venue's redirect lands on: one sentence, no script, nothing of the grant on it. */
function memberCallbackHtml(ok: boolean, message: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
  const venue = VENUE_NAMES[MEMBER_VENUE];
  const mark = ok
    ? `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="#f9ae1c"/><path d="m15 25 6 6 12-14" stroke="#1a1200" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="#1d1d1d" stroke="#3a3a3a" stroke-width="2"/><path d="M17 17l14 14M31 17 17 31" stroke="#d1d1d1" stroke-width="3" stroke-linecap="round"/></svg>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="theme-color" content="#010101"><title>${ok ? "Connected" : "Not connected"}</title><style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#010101;color:#f4f4f4}main{max-width:26rem;margin:16px;padding:28px 26px 22px;text-align:center;background:#1d1d1d;border:1px solid #2e2e2e;border-radius:14px}svg{width:48px;height:48px;margin:0 auto 14px;display:block}h1{font-size:19px;margin:0 0 8px;color:#fff}p{margin:0 0 16px;color:#b9b9b9}a.go{display:inline-flex;align-items:center;justify-content:center;height:44px;padding:0 22px;border-radius:999px;background:#f9ae1c;color:#1a1200;font-weight:600;text-decoration:none}.fine{font-size:12.5px;color:#818181;margin:14px 0 0}</style></head><body><main>${mark}<h1>${ok ? `${esc(venue)} connected` : "Not connected"}</h1><p>${esc(message)}</p>${ok ? "" : `<a class="go" href="${MEMBER_APP_PATH}">Try again</a>`}<div class="fine">Protection by Atticus, a third party; not a product of ${esc(venue)}.</div></main></body></html>`;
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" });
  res.end(html);
}

/**
 * A MEMBER'S LOCK: price again at the tap (fresh positions, fresh book), send the sell as one limit
 * order at the walked price for the tier's share, wait briefly, cancel the rest, read the fills.
 * The record is written from the fills, never from the quote: a partial fill is a smaller sale
 * with more riding, and no fill writes nothing. The comparison on the hedge routes runs while the
 * order rests and is written beside the sale, nothing sent.
 */
async function memberLock(res: ServerResponse, holder: string | null, ticker: string, contracts: number, entryCents: number | undefined, tier: ProtectionTier | undefined, ownLedger: string, atIso: string): Promise<void> {
  const member = memberKeyOf(holder);
  const priced = await memberPriced(member, ticker, contracts, entryCents, true);
  if (!priced.ok) {
    sendJson(res, priced.status, { at: atIso, ticker, ...priced.body });
    return;
  }
  const P = priced.priced;
  if (P.combo?.preview) {
    sendJson(res, 200, { ok: false, at: atIso, ticker, code: "combo_preview", combo: true, message: `A preview: ${VENUE_NAMES[MEMBER_VENUE]}'s cash-out quote isn't live yet, so nothing was sold. The figures shown are a stand-in bid.` });
    return;
  }
  const want = tier ?? (P.tiers[searchConfig().defaultTier] ? searchConfig().defaultTier : (PROTECTION_TIERS.find((t) => P.tiers[t]) as ProtectionTier));
  const t = P.tiers[want];
  if (!t) {
    sendJson(res, 200, { ok: false, at: atIso, ticker, code: "no_bids", message: `${VENUE_NAMES[MEMBER_VENUE]}'s bids cannot fund that shape right now; pick another.` });
    return;
  }
  // the comparison starts now and runs while the order rests: the member's own sale never waits on the other venues.
  // A combination has no Kalshi twin to price against: nothing is compared.
  const cmp = P.combo ? Promise.resolve({ compared: { at: atIso, ok: false as const, reason: "combo", sent: false as const }, result: null }) : memberComparison(ticker, P.contracts, P.entryCents, atIso, want);
  const clientOrderId = P.combo ? (P.combo.bid.rfq.client_rfq_id ?? clientOrderIdFor("rfq", ticker)) : clientOrderIdFor("lock", ticker);
  let outcome: OrderOutcome;
  try {
    outcome = P.combo
      ? // the quote the tap priced is the one accepted, for the shape's size (never more than the makers offered)
        await acceptRfq(memberSessions!.client(member), P.combo.bid, t.soldContracts)
      : await executeLimitOrder(
          memberSessions!.client(member),
          { action: "sell", market_id: P.pos.marketId, order_type: "limit", price: priceString(t.limitPriceCents), quantity: String(t.soldContracts), client_order_id: clientOrderId },
          memberOrderOptsFor(P.live, P.inPlayDelaySec),
        );
  } catch (err) {
    void cmp.catch(() => undefined);
    memberPositionsCache.delete(member);
    if (P.combo && err instanceof MemberApiError && (err.status === 409 || err.status === 410 || /expir|lapse/i.test(err.message))) {
      sendJson(res, 200, { ok: false, at: atIso, ticker, code: "quote_lapsed", message: `${VENUE_NAMES[MEMBER_VENUE]}'s quote lapsed before the tap reached it; nothing was sold. Price again.` });
      return;
    }
    const r = memberRefusal(err);
    sendJson(res, r.status, { at: atIso, ticker, ...r.body });
    return;
  }
  // the position changed at the venue; the next read is fresh
  memberPositionsCache.delete(member);
  if (outcome.filled <= 0) {
    void cmp.catch(() => undefined);
    const why = P.combo
      ? `${VENUE_NAMES[MEMBER_VENUE]} accepted the quote but nothing filled; nothing was sold.`
      : P.live && P.inPlayDelaySec > 0
        ? `${VENUE_NAMES[MEMBER_VENUE]} held the order for its ${P.inPlayDelaySec}s in-play delay and the bid moved away before it could match; nothing was sold.`
        : `${VENUE_NAMES[MEMBER_VENUE]}'s bid moved before the order reached it; nothing was sold.`;
    sendJson(res, 200, { ok: false, at: atIso, ticker, code: "not_filled", live: P.live, message: why, order: { id: outcome.orderId, status: outcome.status, note: outcome.note } });
    return;
  }
  const sale = saleRecordOf(outcome, { marketId: P.pos.marketId, positionContracts: P.venueContracts, maxPrice: P.maxPrice, limitPriceCents: t.limitPriceCents, clientOrderId, requested: t.soldContracts });
  const { compared, result } = await cmp;
  const at = new Date().toISOString();
  const combo = P.combo ? { rfqId: P.combo.bid.rfq.id ?? null, quotedPriceCents: t.limitPriceCents, expiresAtIso: P.combo.bid.expiresAtIso, legs: P.combo.legs } : undefined;
  const record: Parameters<typeof appendShadowRecord>[1] = {
    type: "open",
    at,
    ticker,
    kind: "sports",
    league: P.game.league,
    sideName: P.game.sideName,
    eventTitle: P.game.eventTitle,
    eventTimeIso: P.game.eventTimeIso,
    contracts: P.contracts,
    markCents: P.game.markCents,
    floorCents: perContract(sale.floorTotalCents, P.contracts),
    capCents: perContract(sale.capTotalCents, P.contracts),
    creditCents: 0,
    evCostBps: saleEvCostBps({ soldContracts: outcome.filled, cashNowCents: sale.cashNowCents }, P.venueContracts, P.maxPrice, P.game.markCents),
    route: "member_sale",
    feesCents: sale.feeCents ?? 0,
    takeCents: 0,
    hedgeCostCents: 0,
    hedgeUnitsMilli: 0,
    tier: want,
    holderVenue: MEMBER_VENUE,
    source: "lock",
    entryCents: P.entryCents,
    memberSale: { ...sale, compared, ...(combo ? { combo } : {}) },
    // the member's venue's published rules for the league, pinned; the Kalshi market the result is read from, when the comparison read it.
    // A combination pins the ticket's own text as the venue describes it: the result is read from that market at settlement.
    rule: combo
      ? pinRule({ venue: MEMBER_VENUE, marketId: P.pos.marketId, ruleText: comboRuleText(P.market), sourceUrl: `${MEMBER_APP_VENUE_URL ?? memberSessions!.cfg.host}/markets/${encodeURIComponent(P.pos.marketId)}`, readAtIso: at })
      : pinVenueRules({ venue: MEMBER_VENUE, marketId: ticker, cells: rulesFor(MEMBER_VENUE, P.game.league) }),
    ...(result ? { referenceRule: pinRule({ venue: "kalshi", marketId: ticker, ruleText: kalshiRuleText(result.market), sourceUrl: kalshiRuleUrl(ticker, kalshiBase()), readAtIso: at }) } : {}),
    ...(holder ? { holder } : {}),
  };
  if (!appendOrAlert(record, ownLedger)) {
    sendJson(res, 500, { ok: false, error: "ledger_write_failed", message: `The record could not be written; your sale on ${VENUE_NAMES[MEMBER_VENUE]} stands (order ${sale.orderId ?? "unknown"}).`, memberSale: memberSaleViewOf(sale) });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    at,
    ticker,
    ...(holder ? { holder } : {}),
    sideName: P.game.sideName,
    eventTitle: P.game.eventTitle,
    eventTimeIso: P.game.eventTimeIso,
    contracts: P.contracts,
    tier: want,
    floorCents: record.floorCents,
    capCents: record.capCents,
    creditCents: 0,
    floorTotalCents: sale.floorTotalCents,
    capTotalCents: sale.capTotalCents,
    route: "member_sale",
    memberSale: memberSaleViewOf({ ...sale, ...(combo ? { combo } : {}) }),
    partial: sale.soldContracts < sale.requestedContracts,
    live: P.live,
    ...(P.live ? { inPlayDelaySec: P.inPlayDelaySec } : {}),
    ...(combo ? { combo: true } : {}),
    member: memberView(member),
    ...memberRulesView(P.game.league, sale.keptContracts, Boolean(combo)),
    compared: comparedViewOf(compared),
    hedge: null,
    routing: null,
    rule: ruleViewOf(record),
  });
}

/** The buy-back priced from the member's venue's offers: the contracts sold at the lock, bought again at the walked price. */
async function memberBuyBackPriced(holder: string | null, lock: ShadowPosition): Promise<{ ok: true; member: string; market: RawOutcomeMarket; maxPrice: number; bb: NonNullable<ReturnType<typeof quoteBuyBack>>; midCents: number | null; sale: MemberSaleRecord } | { ok: false; status: number; body: Record<string, unknown> }> {
  const sale = lock.memberSale;
  if (!sale) return { ok: false, status: 409, body: { ok: false, error: "no_sale", code: "no_sale", message: "This lock carries no sale to buy back." } };
  const member = memberKeyOf(holder);
  if (!memberSessions) return { ok: false, status: 404, body: { ok: false, error: "member_app_off", code: "member_app_off", message: "The member app is not configured on this service." } };
  if (!memberSessions.state(member).connected) return { ok: false, status: 409, body: { ok: false, error: "member_not_connected", code: "member_not_connected", message: `Connect your ${VENUE_NAMES[MEMBER_VENUE]} account first.` } };
  let market: RawOutcomeMarket | undefined;
  try {
    market = (await memberSessions.client(member).markets([sale.marketId]))[0];
  } catch (err) {
    return { ok: false, ...memberRefusal(err) };
  }
  if (!market) return { ok: false, status: 502, body: { ok: false, error: "venue_refused", code: "venue_refused", message: `${VENUE_NAMES[MEMBER_VENUE]} did not describe the market.` } };
  const maxPrice = outcomeMaxPrice(market);
  const want = Math.floor(sale.soldContracts / maxPrice + 1e-9);
  const asks = askLevels(market);
  const bb = quoteBuyBack(asks, want, maxPrice);
  if (!bb) return { ok: false, status: 200, body: { ok: false, code: "no_offers", message: `${VENUE_NAMES[MEMBER_VENUE]} shows no offers on this market right now; the contracts you sold cannot be bought back.` } };
  const bids = bidLevels(market);
  const midCents = bids[0] && asks[0] ? Math.round(((bids[0].price + asks[0].price) / 2 / maxPrice) * 100) : null;
  return { ok: true, member, market, maxPrice, bb, midCents, sale };
}

/**
 * The member's view of leaving early, before the tap (the quote) and after it (what filled): the
 * buy-back, the sale it undoes, what the round trip leaves in their balance with the position back
 * at its size, against staying to the floor and the cap. The same shape both times.
 */
function memberUnwindViewOf(lock: ShadowPosition, sale: MemberSaleRecord, bb: { wantContracts: number; contracts: number; limitPriceCents: number; avgPriceCents: number; costCents: number; depthLimited?: boolean }, maxPrice: number, midCents: number | null) {
  const bought = roundContracts(bb.contracts * maxPrice);
  return {
    route: "member_sale" as const,
    venue: MEMBER_VENUE,
    venueName: VENUE_NAMES[MEMBER_VENUE],
    contracts: lock.contracts,
    buyBack: { wantContracts: roundContracts(bb.wantContracts * maxPrice), contracts: bought, limitPriceCents: bb.limitPriceCents, avgPriceCents: bb.avgPriceCents, costCents: bb.costCents, depthLimited: bb.depthLimited ?? false },
    cashNowCents: sale.cashNowCents,
    soldContracts: sale.soldContracts,
    /** the sale less the buy-back: what the round trip leaves in the member's balance */
    protectedAtCloseCents: sale.cashNowCents - bb.costCents,
    nakedAtCloseCents: 0,
    closeNetCents: sale.cashNowCents - bb.costCents,
    creditCents: 0,
    yesMidCents: midCents,
    protectedAtMidCents: midCents !== null ? sale.cashNowCents - Math.round(bought * midCents) : null,
    stayFloorCents: sale.floorTotalCents,
    stayCapCents: sale.capTotalCents,
  };
}

/** The member's settlement on their venue for the sale's market, best effort: null when not connected, unread or none yet. */
async function memberSettlementOf(holder: string | null, sale: MemberSaleRecord) {
  const member = memberKeyOf(holder);
  if (!memberSessions || !memberSessions.state(member).connected) return null;
  try {
    const rows = await memberSessions.client(member).settlements([sale.marketId]);
    const s = rows.find((r) => r.market_id === sale.marketId);
    return s ? { type: s.type, closingPrice: s.closing_price, quantity: s.quantity, fee: s.fee, grossPnl: s.gross_pnl, realizedPnl: s.realized_pnl, time: s.time } : null;
  } catch {
    return null;
  }
}

/**
 * A MEMBER'S LEAVE: price the buy-back again at the tap, send the buy as one limit order at the
 * walked price, wait briefly, cancel the rest, read the fills. The close line is written from the
 * fills: the sale less what the buy-back cost is what the round trip left in the member's balance;
 * a partial buy-back is written as such (the rest stays sold). No fill writes nothing.
 */
async function memberUnwind(res: ServerResponse, holder: string | null, lock: ShadowPosition, ownLedger: string, atIso: string): Promise<void> {
  const bp = await memberBuyBackPriced(holder, lock);
  if (!bp.ok) {
    sendJson(res, bp.status, { at: atIso, ticker: lock.ticker, ...bp.body });
    return;
  }
  const clientOrderId = clientOrderIdFor("leave", lock.ticker);
  let outcome: OrderOutcome;
  try {
    outcome = await executeLimitOrder(
      memberSessions!.client(bp.member),
      { action: "buy", market_id: bp.sale.marketId, order_type: "limit", price: priceString(bp.bb.limitPriceCents), quantity: String(bp.bb.contracts), client_order_id: clientOrderId },
      // a buy-back during the game waits out the venue's in-play hold too
      memberOrderOptsFor(marketLive(bp.market, Date.parse(lock.eventTimeIso), Date.now()), inPlayDelaySecOf(bp.market)),
    );
  } catch (err) {
    const r = memberRefusal(err);
    sendJson(res, r.status, { at: atIso, ticker: lock.ticker, ...r.body });
    return;
  }
  memberPositionsCache.delete(bp.member);
  if (outcome.filled <= 0) {
    sendJson(res, 200, { ok: false, at: atIso, ticker: lock.ticker, code: "not_filled", message: `${VENUE_NAMES[MEMBER_VENUE]}'s offers moved before the order reached them; nothing was bought back and the protection stands.`, order: { id: outcome.orderId, status: outcome.status, note: outcome.note } });
    return;
  }
  const back = buyBackRecordOf(outcome, { maxPrice: bp.maxPrice, limitPriceCents: bp.bb.limitPriceCents, clientOrderId, requested: bp.bb.contracts });
  const at = new Date().toISOString();
  const protectedAtCloseCents = bp.sale.cashNowCents - back.costCents;
  const protectedAtMidCents = bp.midCents !== null ? bp.sale.cashNowCents - Math.round(back.boughtContracts * bp.midCents) : null;
  const ok = appendOrAlert(
    {
      type: "close",
      at,
      ticker: lock.ticker,
      priced: true,
      source: "unwind",
      hedgeSent: false,
      yesMidCents: bp.midCents,
      yesFillCents: back.avgPriceCents,
      positionProceedsCents: 0,
      hedgeProceedsCents: 0,
      feesCents: back.feeCents ?? 0,
      protectedAtCloseCents,
      protectedAtMidCents,
      unwindFrictionCents: protectedAtMidCents !== null ? protectedAtMidCents - protectedAtCloseCents : null,
      memberBuyBack: back,
    },
    ownLedger,
  );
  if (!ok) {
    sendJson(res, 500, { ok: false, error: "ledger_write_failed", message: `The record could not be written; your buy-back on ${VENUE_NAMES[MEMBER_VENUE]} stands (order ${back.orderId ?? "unknown"}).`, memberBuyBack: back });
    return;
  }
  const closed = loadShadowPositions(ownLedger).find((p) => p.ticker === lock.ticker)!;
  sendJson(res, 200, {
    ok: true,
    at,
    ticker: lock.ticker,
    ...(holder ? { holder } : {}),
    status: closed.status,
    route: "member_sale",
    unwind: memberUnwindViewOf(lock, bp.sale, { wantContracts: bp.bb.wantContracts, contracts: outcome.filled, limitPriceCents: bp.bb.limitPriceCents, avgPriceCents: back.avgPriceCents, costCents: back.costCents, depthLimited: back.boughtContracts < back.requestedContracts }, bp.maxPrice, bp.midCents),
    memberBuyBack: back,
    partial: back.boughtContracts < back.requestedContracts,
    hedge: { sent: false, note: "no hedge on a member's own sale; the contracts were bought back in your own account" },
    cash: [],
  });
}

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
/**
 * The rule the result will be judged under, as the holder's receipt shows it: which venue's text was
 * pinned, where it is published, when it was read, its fingerprint, and (after settlement) whether the
 * second read matched. The text itself stays on the record; the venue's page has the current words.
 */
function ruleViewOf(p: Pick<ShadowPosition, "rule" | "ruleCheck">) {
  if (!p.rule) return null;
  return {
    venue: p.rule.venue,
    venueName: VENUE_NAMES[p.rule.venue],
    /** "market": the market's own text read live at the pin; "rules": the venue's published league rules as read on readAtIso */
    basis: p.rule.basis ?? "market",
    sourceUrl: p.rule.sourceUrl,
    readAtIso: p.rule.readAtIso,
    sha256: p.rule.sha256,
    // "terms kept at open" until settlement reads again; then "terms held" or "venue edited its rules"
    state: ruleStateLabel(p.ruleCheck),
    ...(p.ruleCheck ? { checkedAtIso: p.ruleCheck.readAtIso, unchanged: p.ruleCheck.unchanged } : {}),
  };
}

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

/** The scan's hedges are recorded at the walked book and never sent, whatever the live rails arm. */
const PAPER_EXECUTOR = new BookHedgeExecutor();
const SCAN_PAPER_REASON = "scan: the board's positions are paper; no order placed";

/**
 * Fill the hedge leg through the configured executor and keep the receipt.
 * The position is already on the ledger; a hedge failure is recorded, never
 * allowed to lose the record or stop the scan. `paper` (the scan) fills at the
 * walked book and sends nothing: the live rails exist for a holder's tap, and
 * `EVENT_HEDGE_LIVE_TICKERS=*` must not turn every board row into an order.
 */
type HedgeBooks = { pmNoBook?: PmBook; noAsks?: NoAskLevel[]; pxNoBook?: PmBook; references?: ReferenceBook[] };

/** The order a quoted hedge leg becomes: the walk's prices from the books it was quoted on, armed by the game's Kalshi ticker. */
function hedgeIntentFor(ticker: string, hedge: HedgeLeg, books: HedgeBooks): HedgeIntent {
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
  return intentFromHedge(hedge, best, armKey);
}

async function fillHedge(ref: string, hedge: HedgeLeg, books: HedgeBooks, opts: { paper?: boolean } = {}): Promise<HedgeReceipt | null> {
  const ticker = ref.split("@")[0];
  try {
    const intent = hedgeIntentFor(ticker, hedge, books);
    const paper = Boolean(opts.paper) && hedgeChoice.strategy !== "book";
    const receipt = paper ? { ...(await PAPER_EXECUTOR.execute(intent, ref)), fallbackReason: SCAN_PAPER_REASON } : await hedgeChoice.executor.execute(intent, ref);
    appendHedgeReceipt(RECEIPTS_PATH, receipt);
    return receipt;
  } catch (err) {
    lastScanError = `hedge for ${ticker}: ${String(err instanceof Error ? err.message : err)}`;
    return null;
  }
}

/** A line on the pending trail; a trail that cannot be written pages like a ledger that cannot. */
function appendPendingOrAlert(record: PendingRecord): boolean {
  try {
    appendPending(PENDING_PATH, record);
    return true;
  } catch (err) {
    void alerter({ kind: "ledger_write_failed", message: `could not append ${record.type} ${record.id} to ${PENDING_PATH}: ${String(err instanceof Error ? err.message : err)}` });
    return false;
  }
}

/** The pending trail for the status page: how attempts ended, and what still wants the operator's eyes. */
function pendingHealth(): { path: string; counts: Record<string, number>; unresolved: string[]; strays: string[] } {
  const s = summarizePending(loadPending(PENDING_PATH));
  return { path: PENDING_PATH, counts: s.counts, unresolved: s.unresolved.map((p) => p.id), strays: s.strays.map((x) => x.pending.id) };
}

/**
 * On boot: a pending line with no resolution means the process stopped between an order and its
 * record. Nothing is repaired here; the operator is told which order to look for on the venue.
 */
function alertUnresolvedPending(): void {
  const s = summarizePending(loadPending(PENDING_PATH));
  if (s.unresolved.length === 0 && s.strays.length === 0) return;
  const lines = [
    ...s.unresolved.map((p) => `${p.id}: ${p.order.unitsMilli / 1000} on ${p.order.venue} ${p.order.instrument}, never resolved`),
    ...s.strays.map((x) => `${x.pending.id}: ${x.resolved.outcome}, ${x.resolved.detail}`),
  ];
  void alerter({ kind: "lock_pending_unresolved", message: `${lines.length} lock attempt(s) may have left hedge on a venue with no lock behind it: ${lines.join(" | ")}. See /api/shadow/lock/pending; clear each once checked.` });
}

type HedgeFirstResult =
  | { ok: true; receipt: HedgeReceipt }
  | { ok: false; status: number; code: string; message: string };

/**
 * A REAL-MONEY LOCK: THE HEDGE IS BOUGHT, THEN THE LOCK IS WRITTEN (hedgeFirst.ts has the
 * sequence and each party's P&L per ending). Called only when lockMode says the order will truly
 * leave. `writeLock` appends the open record and says whether it landed; it runs only behind a
 * real fill of the whole hedge. Every other ending writes no lock and answers a refusal the
 * holder can act on; an ending that leaves, or may leave, hedge on a venue pages the operator.
 */
async function hedgeThenLock(args: {
  ref: string;
  ticker: string;
  holder: string | null;
  intent: HedgeIntent;
  terms: { contracts: number; tier: string; floorCents: number; capCents: number; creditCents: number };
  writeLock: () => boolean;
}): Promise<HedgeFirstResult> {
  const { ref, ticker, holder, terms } = args;
  const intent: HedgeIntent = { ...args.intent, allOrNone: true };
  const pending = pendingRecordFor(ref, ticker, holder, new Date().toISOString(), terms, intent);
  // no trail, no order: an order that leaves with no line before it is the one thing a restart could not find
  if (!appendPendingOrAlert(pending)) {
    return { ok: false, status: 500, code: "ledger_write_failed", message: "The record could not be written; nothing was locked." };
  }
  let receipt: HedgeReceipt | null = null;
  let threw: string | null = null;
  try {
    receipt = await hedgeChoice.executor.execute(intent, ref);
  } catch (err) {
    threw = String(err instanceof Error ? err.message : err);
  }
  if (receipt) {
    try {
      appendHedgeReceipt(RECEIPTS_PATH, receipt);
    } catch (err) {
      void alerter({ kind: "ledger_write_failed", message: `could not append the hedge receipt for ${ref} to ${RECEIPTS_PATH}: ${String(err instanceof Error ? err.message : err)}` });
    }
  }
  const verdict = judgeHedge(intent, receipt);
  const resolve = (outcome: Extract<PendingRecord, { type: "resolved" }>["outcome"], detail: string, fill?: { unitsMilli: number; costCents: number; orderId: string | null }): void => {
    appendPendingOrAlert({
      type: "resolved",
      id: pending.id,
      at: new Date().toISOString(),
      outcome,
      detail,
      ...(fill && receipt ? { fill: { ...fill, receiptId: receipt.id } } : {}),
      ...(receipt ? { receiptId: receipt.id } : {}),
    });
  };
  const where = `${intent.venue} ${intent.instrument}`;
  if (verdict.kind === "filled") {
    const fill = { unitsMilli: verdict.unitsMilli, costCents: verdict.costCents, orderId: verdict.orderId };
    if (!args.writeLock()) {
      resolve("ledger_failed", "the hedge filled and the lock record could not be written", fill);
      void alerter({ kind: "hedge_stray", message: `${ref}: the hedge filled (${verdict.unitsMilli / 1000} on ${where}, ${verdict.costCents}c, order ${verdict.orderId ?? "?"}) and the lock record could not be written. No lock stands. Sell the hedge, then clear ${pending.id}.` });
      return { ok: false, status: 500, code: "ledger_write_failed", message: "The record could not be written; nothing was locked." };
    }
    resolve("locked", `the whole hedge filled: ${verdict.unitsMilli / 1000} for ${verdict.costCents}c`, fill);
    return { ok: true, receipt: receipt as HedgeReceipt };
  }
  const words = refusalWords(verdict);
  if (verdict.kind === "partial") {
    resolve("stray", `${verdict.unitsMilli / 1000} of ${verdict.wantedMilli / 1000} filled; no lock written`, { unitsMilli: verdict.unitsMilli, costCents: verdict.costCents, orderId: verdict.orderId });
    void alerter({ kind: "hedge_stray", message: `${ref}: ${verdict.unitsMilli / 1000} of ${verdict.wantedMilli / 1000} filled on ${where} for ${verdict.costCents}c (order ${verdict.orderId ?? "?"}). No lock was written. Sell the part that filled, then clear ${pending.id}.` });
  } else if (verdict.kind === "unconfirmed") {
    const detail = threw ?? verdict.detail;
    resolve("unconfirmed", detail);
    void alerter({ kind: "hedge_stray", message: `${ref}: the order for ${intent.unitsMilli / 1000} on ${where} went out and was not confirmed (${detail}). No lock was written. Look for client order ${receipt ? `atticus-${receipt.id}` : "(no receipt)"} on the venue; sell anything it bought, then clear ${pending.id}.` });
  } else {
    resolve("refused", verdict.detail);
  }
  return { ok: false, status: 200, code: words.code, message: words.message };
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
  // a member's own sale has no hedge leg to price; its leave is a buy-back on the member's venue (the unwind routes branch before this)
  if (p.route === "member_sale") throw new Error(`${p.ticker}: a member sale is not priced by the early-close pricer`);
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

/**
 * A lock as the positions list and the receipt carry it: the terms, the tier, the result once
 * settled, the close once left. A member's own sale adds its facts and its whole-position totals,
 * which are what settlement pays (the per-contract figures are those divided down).
 */
function lockSummaryOf(L: ShadowPosition) {
  return {
    at: L.at,
    status: L.status,
    contracts: L.contracts,
    floorCents: L.floorCents,
    capCents: L.capCents,
    creditCents: L.creditCents,
    route: L.route,
    eventTimeIso: L.eventTimeIso,
    ...(L.generation ? { generation: L.generation } : {}),
    ...(L.tier ? { tier: L.tier } : {}),
    ...(L.holderVenue ? { holderVenue: L.holderVenue } : {}),
    ...(L.memberSale ? { memberSale: memberSaleViewOf(L.memberSale), floorTotalCents: L.memberSale.floorTotalCents, capTotalCents: L.memberSale.capTotalCents, compared: comparedViewOf(L.memberSale.compared) } : {}),
    ...(L.result ? { result: L.result, protectedCents: L.protectedCents, nakedCents: L.nakedCents, settledAt: L.settledAt } : {}),
    ...closedViewOf(L),
    ...(L.closeMemberBuyBack ? { memberBuyBack: L.closeMemberBuyBack } : {}),
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
 * Refuse an unwind the pricers would, before any book is read. Open positions only; on the hedged
 * routes the early-close margin before the lock (the same one the schedule keeps) is the holder's
 * last moment to leave. A member's sale has no such moment while in play is on: the leave is a
 * buy-back of their own contracts on their own venue, so it stands for as long as the venue trades
 * the market (a live game included); the venue's own close is the end of it.
 */
const leaveLastMsOf = (lock: ShadowPosition): number | null => (lock.route === "member_sale" && memberInPlay ? null : Date.parse(lock.eventTimeIso) - earlyCloseRule.marginMs);
function unwindRefusal(lock: ShadowPosition | undefined, ticker: string, nowMs: number): { status: number; body: Record<string, unknown> } | null {
  if (!lock) return { status: 404, body: { ok: false, error: "no_lock", message: ticker ? "This market is not on the record." : "?ticker= names the lock" } };
  if (lock.status !== "open") {
    const said = lock.status === "closed" ? "This position was already left early." : lock.status === "settled" ? "This position has settled; there is nothing to leave." : "This position was voided; there is nothing to leave.";
    return { status: 409, body: { ok: false, error: "not_open", status: lock.status, message: said } };
  }
  // a combination sold through the venue's quote has nothing to buy it back from: the lock stands to settlement
  if (lock.memberSale?.combo) return { status: 409, body: { ok: false, error: "combo_no_buyback", code: "combo_no_buyback", message: `A combo lock stays to settlement; ${VENUE_NAMES[MEMBER_VENUE]} has no offers to buy a combo back from.` } };
  const lastMs = leaveLastMsOf(lock);
  if (lastMs === null) return null;
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
    // the rule the holder's payout will be judged under: the holder's venue's own text (for a
    // ProphetX or Novig holder its published league rules, with Kalshi's market text kept as the
    // reference the result is read from); for a Kalshi holder the market's text this second
    ...rulePinsFor(res),
    ...(source ? { source, entryCents: res.position.entryCents } : {}),
  };
}

/**
 * The pins an opening record carries. A Kalshi holder: `rule` is the market's own text as read now.
 * A holder elsewhere: `rule` is that venue's published rules for the league (the sentences the
 * routing priced the tails from, hashed, with the venue's page and the read date), and
 * `referenceRule` is the Kalshi market text, the market the result is read from at settlement.
 */
function rulePinsFor(res: CandidateResult): { rule: RuleEvidence | null; referenceRule?: RuleEvidence | null } {
  const kalshi = pinRule({
    venue: "kalshi",
    marketId: res.market.ticker,
    ruleText: kalshiRuleText(res.market),
    sourceUrl: kalshiRuleUrl(res.market.ticker, kalshiBase()),
    readAtIso: new Date().toISOString(),
  });
  const holder = res.routing?.holderVenue;
  if (!holder || holder === "kalshi" || !res.routing) return { rule: kalshi };
  return { rule: pinVenueRules({ venue: holder, marketId: res.market.ticker, cells: res.routing.holderRules }), referenceRule: kalshi };
}

/**
 * The text a pin is checked against at settlement: a market pin against the market's text as the
 * result read carries it; a venue-rules pin against the same venue's rules for the league as they
 * read now (the record's own table, so an edit to the sentences since the pin is said).
 */
function ruleTextNowFor(p: ShadowPosition, result: { rulesPrimary?: string | null; rulesSecondary?: string | null }): string {
  if (p.rule?.basis === "rules" && p.holderVenue) return venueRulesText(rulesFor(p.holderVenue, p.league));
  return kalshiRuleText(result);
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
 * The same quote headed at another of its tiers, when the venues funded it: the top-level terms
 * become that tier's, the others ride along unchanged. A parlay at its last pick heads with the
 * highest floor (PARLAY_LAST_PICK_TIER); a single keeps the engine's default.
 */
function headedAt(res: CandidateResult, tier: ProtectionTier): CandidateResult {
  if (!res.quote.ok) return res;
  const terms = res.quote.tiers[tier];
  if (!terms || res.quote.tier === tier) return res;
  return { ...res, quote: { ...res.quote, ...terms, tier }, evBps: terms.evCostBps };
}

/**
 * The lock routes (gated by the lock key or the operator token; 404 when no key is configured):
 *   GET  /api/shadow/markets?league=   the games the engine can protect, and which are already on the record
 *   GET  /api/shadow/quote?ticker=&contracts=&entry=&venue=&parlay=   one position, priced now, retail shape (parlay=1:
 *        a ticket at its last pick, headed at the highest floor rather than the default tier), with
 *        `routing` (hedgeRouting.ts): the holder's venue (`venue`: kalshi, prophetx, novig; absent Kalshi), the
 *        hedge venue chosen against it and why, each route's cost all in (EV plus the tails priced), the tails
 *        in the holder's venue's words; with the operator token, also the engine's route verdicts and the pin
 *   GET  /api/shadow/picks?picks=SEA:CHI:Mon,BAL:JAX:Thu   a parlay's picks placed on the markets (open game
 *        markets and those settled in the last two weeks): each open, won or lost; whether the ticket is at its
 *        last pick and which market that is (parlayPicks.ts)
 *   POST /api/shadow/lock {ticker, contracts, entryCents?, tier?, venue?, parlay?}   quote again (the lock is at the tap),
 *        with `parlay` {picks, stakeCents, payoutCents} the position is a parlay at its last pick: the picks are
 *        read again here and the lock is refused (409 parlay_busted, parlay_not_last_pick, parlay_size…) unless
 *        every other pick hit, `ticker` is the one left and has not started, and the size is at most the payout;
 *        write the open record with source "lock" (holderVenue and routing on it), fill the hedge on the
 *        chosen venue, answer with the terms, the hedge receipt's outcome and the routing
 *   GET  /api/shadow/receipt?ticker=   the lock's terms, the hedge behind them and the routing, any time after
 *   GET  /api/shadow/unwind/quote?ticker=   leaving early, priced now from the live books (earlyClose.ts), nothing written
 *   POST /api/shadow/unwind {ticker}   quote again at the tap, write the close line (source "unwind"), answer with it
 */
async function handleLockRoutes(req: IncomingMessage, res: ServerResponse, url: URL, holder: string | null, operator = false, memberOnly = false): Promise<void> {
  // a cookie member (the hosted page) acts in the member venue's lane alone: never a venue account
  // of ours, never a quote or a lock that the protection would hedge with our capital
  const memberOnlyRefusal = () => sendJson(res, 403, { ok: false, error: "member_only", code: "member_only", message: `This session can only protect positions in your own ${VENUE_NAMES[MEMBER_VENUE]} account.` });
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
  if (url.pathname === "/api/shadow/picks") {
    // a parlay's picks placed on the service's markets, each open, won or lost, and whether the
    // ticket is at its last pick (parlayPicks.ts): what the extension draws under a parlay card
    const queries = parsePickQueries(url.searchParams.get("picks"));
    if (!queries || queries.length < 2) {
      sendJson(res, 400, { ok: false, error: "bad_request", message: "picks must list two or more club codes, each as CODE[:OPP[:DAY]], comma separated" });
      return;
    }
    const view = await picksViewFor(queries);
    sendJson(res, 200, { ok: true, at: atIso, ...view });
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
  if (url.pathname.startsWith("/api/shadow/member")) {
    // THE MEMBER'S CONNECTION: state, the venue's authorize URL to open, or the disconnect; and
    // the page's reads beside it: account (handle, balance), games (what the venue lists that we
    // protect) and history (this member's own records). The member is this caller (their holder
    // alias; "shared" on the shared key). Never a token.
    const member = memberKeyOf(holder);
    if (!memberSessions) {
      sendJson(res, 404, { ok: false, error: "member_app_off", message: "The member app is not configured on this service.", ...(memberApp.notes.length ? { notes: memberApp.notes } : {}) });
      return;
    }
    if (url.pathname === "/api/shadow/member/account" || url.pathname === "/api/shadow/member/games") {
      if (!memberSessions.state(member).connected) {
        sendJson(res, 409, { ok: false, error: "member_not_connected", code: "member_not_connected", message: `Connect your ${VENUE_NAMES[MEMBER_VENUE]} account first.`, member: memberView(member) });
        return;
      }
      try {
        if (url.pathname === "/api/shadow/member/account") {
          const a = await memberAccount(member, url.searchParams.get("fresh") === "1");
          sendJson(res, 200, { ok: true, at: atIso, ...(holder ? { holder } : {}), member: memberView(member), ...a });
          return;
        }
        const held = new Set(currentShadowPositions(loadShadowPositions(ownLedger)).filter((p) => p.status !== "closed").map((p) => p.ticker));
        let positions: MemberHolderPosition[] = [];
        try {
          positions = await refreshMemberPositions(member, false);
        } catch {
          // the games list stands without the holdings; the rows say "in your portfolio" only when known
        }
        for (const p of positions) if (p.ticker) held.add(p.ticker);
        const g = await memberGames(member, held);
        sendJson(res, 200, { ok: true, at: atIso, ...(holder ? { holder } : {}), cutoffMinutes: protectCutoffMinutes, inPlay: memberInPlay, venueUrl: MEMBER_APP_VENUE_URL, ...g });
      } catch (err) {
        const r = memberRefusal(err);
        sendJson(res, r.status, { at: atIso, ...r.body });
      }
      return;
    }
    if (url.pathname === "/api/shadow/member/history") {
      // every lock this member ever made, newest first: open ones are on Portfolio, the rest is History
      const all = loadShadowPositions(ownLedger)
        .filter((L) => L.holderVenue === MEMBER_VENUE || L.route === "member_sale")
        .map((L) => ({ ticker: L.ticker, league: L.league, side: L.sideName, event: L.eventTitle, ...lockSummaryOf(L) }))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      sendJson(res, 200, { ok: true, at: atIso, ...(holder ? { holder } : {}), records: all });
      return;
    }
    if (url.pathname === "/api/shadow/member/connect") {
      const { url: authorize } = memberSessions.beginConnect(member);
      memberConnectOrigin.set(member, isMemberAppHost(req) && MEMBER_APP_ORIGIN ? MEMBER_APP_ORIGIN : "");
      sendJson(res, 200, { ok: true, at: atIso, ...(holder ? { holder } : {}), member: memberView(member), url: authorize });
      return;
    }
    if (url.pathname === "/api/shadow/member/disconnect") {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "POST to disconnect" });
        return;
      }
      const had = await memberSessions.disconnect(member);
      memberPositionsCache.delete(member);
      sendJson(res, 200, { ok: true, at: atIso, ...(holder ? { holder } : {}), disconnected: had, member: memberView(member) });
      return;
    }
    sendJson(res, 200, { ok: true, at: atIso, ...(holder ? { holder } : {}), member: memberView(member) });
    return;
  }
  if (url.pathname === "/api/shadow/positions") {
    const member = memberKeyOf(holder);
    const mv = memberView(member);
    const memberOn = Boolean(mv && mv.connected);
    const ownVenue = memberOnly ? null : venueClient;
    if (!ownVenue && !memberOn) {
      sendJson(res, 200, { ok: true, at: atIso, configured: false, positions: [], ...(venueClientNote && !memberOnly ? { note: venueClientNote } : {}), ...(mv ? { member: mv } : {}) });
      return;
    }
    const fresh = url.searchParams.get("fresh") === "1";
    // the holder's venue account (read-only key) and their connected member account, side by side; each read fails on its own
    const notes: string[] = [];
    let venueRows: HolderPosition[] = [];
    let venueReadAt: number | null = null;
    if (ownVenue) {
      try {
        venueRows = await refreshPositions(fresh);
        venueReadAt = positionsCache?.at ?? null;
      } catch (err) {
        notes.push(`venue read failed: ${String(err instanceof Error ? err.message : err)}`);
      }
    }
    let memberRows: MemberHolderPosition[] = [];
    let memberReadAt: number | null = null;
    if (memberOn) {
      try {
        memberRows = await refreshMemberPositions(member, fresh);
        memberReadAt = memberPositionsCache.get(member)?.at ?? null;
      } catch (err) {
        notes.push(`${VENUE_NAMES[MEMBER_VENUE]} read failed: ${memberRefusal(err).body.message as string}`);
      }
    }
    if (venueReadAt === null && memberReadAt === null) {
      sendJson(res, 200, { ok: false, at: atIso, configured: true, error: "venue_read_failed", message: notes.join("; ") || "no read yet", ...(mv ? { member: mv } : {}) });
      return;
    }
    // what the record already holds for each matched market: the client shows Protected, not Lock in
    const locks = new Map(currentShadowPositions(loadShadowPositions(ownLedger)).map((p) => [p.ticker, p]));
    const lockOf = (ticker: string | null) => {
      const L = ticker ? locks.get(ticker) : undefined;
      return L ? lockSummaryOf(L) : null;
    };
    sendJson(res, 200, {
      ok: true,
      at: atIso,
      configured: true,
      ...(holder ? { holder } : {}),
      readAt: new Date(Math.max(venueReadAt ?? 0, memberReadAt ?? 0)).toISOString(),
      cutoffMinutes: protectCutoffMinutes,
      inPlay: memberInPlay,
      ...(notes.length ? { note: notes.join("; ") } : {}),
      ...(mv ? { member: mv } : {}),
      positions: [
        ...venueRows.map((p) => ({ ...p, lock: lockOf(p.ticker) })),
        // the member's positions carry their venue, so a client on another venue's page leaves them alone.
        // A combination ticket the venue will quote (MEMBER_APP_COMBO_RFQ) carries its synthetic ticker, so the page quotes and locks it like a single.
        // Each row also carries what the venue pays for it now (the top bid; the last trade when there is no bid, a combo), so the
        // page can say what the ticket is worth against what it cost without a quote.
        ...memberRows.map((row) => {
          const { market: m, marketId: _id, ...p } = row;
          const ticker = comboLockable(row) ? comboTickerOf(row.marketId) : p.ticker;
          const bids = m ? bidLevels(m) : [];
          const last = m ? Number(m.last_traded_price ?? m.price) : NaN;
          const bidCents = bids[0] ? Math.round((bids[0].price / row.maxPrice) * 100) : null;
          const lastCents = Number.isFinite(last) && last > 0 && last < row.maxPrice ? Math.round((last / row.maxPrice) * 100) : null;
          return { ...p, ticker, ...(ticker !== p.ticker ? { combo: true } : {}), bidCents, lastCents, venue: MEMBER_VENUE, lock: lockOf(ticker) };
        }),
      ],
      ...(memberComboRfq !== "off" ? { comboRfq: memberComboRfq === "preview" ? "preview" : true } : {}),
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
    if (memberOnly && parsed.value.venue !== MEMBER_VENUE) {
      memberOnlyRefusal();
      return;
    }
    if (parsed.value.venue === MEMBER_VENUE) {
      // A MEMBER'S QUOTE: the three tiers from their venue's bids at their size, the comparison on
      // the hedge routes beside it (priced, nothing sent), the tails in their venue's words.
      const member = memberKeyOf(holder);
      const priced = await memberPriced(member, parsed.value.ticker, parsed.value.contracts, parsed.value.entryCents, url.searchParams.get("fresh") === "1");
      if (!priced.ok) {
        sendJson(res, priced.status, { at: atIso, ticker: parsed.value.ticker, ...priced.body });
        return;
      }
      const P = priced.priced;
      const held = !lockable(loadShadowPositions(ownLedger), parsed.value.ticker);
      // each shape carries its own tails: the riding count the venue's rules speak of is that shape's
      const tiers = Object.fromEntries(
        Object.entries(P.tiers)
          .filter(([, t]) => t)
          .map(([k, t]) => {
            const v = saleTierView(t as SaleTierQuote, P.contracts, P.maxPrice, P.game.markCents);
            return [k, { ...v, tails: memberRulesView(P.game.league, v.keptContracts, Boolean(P.combo)).tails }];
          }),
      );
      const dflt = P.tiers[searchConfig().defaultTier] ? searchConfig().defaultTier : (Object.keys(tiers)[0] as ProtectionTier);
      const head = tiers[dflt];
      // a combination has no Kalshi twin to compare against
      const cmp = P.combo ? { compared: undefined, result: null } : await memberComparison(parsed.value.ticker, P.contracts, P.entryCents, atIso, dflt);
      sendJson(res, 200, {
        ok: true,
        at: atIso,
        onRecord: held,
        ...(holder ? { holder } : {}),
        ticker: parsed.value.ticker,
        kind: "sports",
        ...P.game,
        contracts: P.contracts,
        entryCents: P.entryCents,
        route: "member_sale",
        live: P.live,
        ...(P.live ? { inPlayDelaySec: P.inPlayDelaySec } : {}),
        // a combination: the quote the shapes were read from, so the page can say where the bid came from and how long it stands
        ...(P.combo ? { combo: true, rfq: { id: P.combo.bid.rfq.id, quantity: P.bidDepth, priceCents: P.bestBidCents, expiresAtIso: P.combo.bid.expiresAtIso, legs: P.combo.legs, preview: P.combo.preview } } : {}),
        quote: { ok: true, contracts: P.contracts, markCents: P.game.markCents, entryCents: P.entryCents, ...head, tier: dflt, tiers, quotedAt: atIso },
        evCostBps: head.evCostBps,
        member: { ...memberView(member), held: P.pos.contracts, bestBidCents: P.bestBidCents, bidDepth: P.bidDepth },
        ...memberRulesView(P.game.league, head.keptContracts, Boolean(P.combo)),
        compared: comparedViewOf(cmp.compared, cmp.result),
      });
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
    // a parlay at its last pick (parlay=1) heads with the highest floor; the other shapes ride along
    const result = url.searchParams.get("parlay") === "1" ? headedAt(q.result, PARLAY_LAST_PICK_TIER) : q.result;
    const held = !lockable(loadShadowPositions(ownLedger), parsed.value.ticker);
    // The operator also sees the routing: which hedge route funded this quote and what every route
    // said. On an armed ticker the lock is pinned to Kalshi's own No side, so the verdict there is
    // what the live hedge will do; on an unarmed one it is the engine's free choice at this size.
    // Every caller sees where the hedge would go and why (hedgeRouting.ts): the holder's venue, the
    // hedge venue, each route's cost all in, the tails in their venue's words. The operator also
    // sees the engine's own route verdicts and the pin.
    const view = routingViewOf(result.routing);
    const routing = {
      routing: operator
        ? {
            ...(view ?? {}),
            route: result.route,
            pinned: lockRouteFor(parsed.value.ticker) ?? null,
            ...(result.pinnedExecution ? { pinnedExecution: result.pinnedExecution } : {}),
            routesChecked: result.routesChecked.map((r) => ({ route: r.route, ok: r.ok, evCostBps: r.evCostBps, creditCents: r.creditCents, ...(r.detail ? { detail: r.detail } : {}) })),
          }
        : view,
    };
    sendJson(res, 200, { ok: true, at: atIso, onRecord: held, ...(holder ? { holder } : {}), ...retailOneQuote(result, result.evBps), ...routing });
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
    const { ticker, contracts, entryCents, tier, venue, parlay } = parsed.value;
    if (memberOnly && venue !== MEMBER_VENUE) {
      memberOnlyRefusal();
      return;
    }
    const flight = inFlightKey(holder, ticker);
    if (lockInFlight.has(flight)) {
      sendJson(res, 409, { ok: false, error: "lock_in_flight", message: "This position is being locked right now." });
      return;
    }
    if (!lockable(loadShadowPositions(ownLedger), ticker)) {
      sendJson(res, 409, { ok: false, error: "already_on_record", message: "This market is already locked; one lock per market." });
      return;
    }
    if (venue === MEMBER_VENUE) {
      if (parlay) {
        sendJson(res, 409, { ok: false, error: "parlay_unsupported", code: "parlay_unsupported", message: `A parlay is not locked on ${VENUE_NAMES[MEMBER_VENUE]}; the lock sells part of one position.` });
        return;
      }
      lockInFlight.add(flight);
      try {
        await memberLock(res, holder, ticker, contracts, entryCents, tier, ownLedger, atIso);
      } finally {
        lockInFlight.delete(flight);
      }
      return;
    }
    // a parlay is locked at its last pick only, on the service's own read of the picks: every other
    // pick hit, this market is the one left and has not started, the size is at most what it pays
    let parlayView: PicksView | null = null;
    if (parlay) {
      parlayView = await picksViewFor(parlay.picks);
      const check = verifyParlayLock(parlayView, ticker, contracts, parlay.stakeCents, parlay.payoutCents);
      if (!check.ok) {
        sendJson(res, 409, { ok: false, error: check.code, code: check.code, message: check.message, picks: parlayView.picks });
        return;
      }
    }
    // the venue's own word on the holder's side: when their account is readable and it holds the
    // other club of this game and not this one, the card was misread; no lock, no wrong-way hedge
    const other = await heldOtherSideOf(ticker);
    if (other) {
      sendJson(res, 409, { ok: false, error: "wrong_side", code: "wrong_side", message: `Your pick on this game is ${other.side || "the other side"}; protect it from that card.`, heldTicker: other.ticker });
      return;
    }
    // the card is the protection's own hedge for a lock held on another venue: not theirs to protect
    const ours = ownHedgeOn(ticker, venue ?? "kalshi", ownLedger);
    if (ours) {
      sendJson(res, 409, { ok: false, error: "own_hedge", code: "own_hedge", message: `This position is the protection's own hedge for your ${ours.sideName} on ${VENUE_NAMES[ours.holderVenue ?? "kalshi"]}.`, lockTicker: ours.ticker });
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
      // the tier the holder chose, when the venues funded it; else a parlay's highest floor; else the quote's default
      const want = tier ?? (parlay ? PARLAY_LAST_PICK_TIER : undefined);
      const chosen = want && result.quote.tiers[want] ? { ...result.quote, ...result.quote.tiers[want], tier: want } : result.quote;
      const evBps = chosen.tier === result.quote.tier ? result.evBps : chosen.evCostBps;
      const base = openRecordFor(result, chosen, evBps, atIso, "lock");
      const record = parlay && parlayView ? { ...base, parlay: parlayRecordOf(parlayView, parlay.stakeCents, parlay.payoutCents) } : base;
      const writeLock = (): boolean => appendOrAlert(holder ? { ...record, holder } : record, ownLedger);
      const ref = hedgeRefFor(ticker, holder);
      // would this hedge truly be sent? then it is bought before the lock is written (hedgeFirst.ts);
      // on paper the record is written and the fill simulated at the walk, as the shadow always has
      let intent: HedgeIntent | null = null;
      try {
        intent = hedgeIntentFor(ticker, chosen.hedge, result.books);
      } catch (err) {
        lastScanError = `hedge for ${ticker}: ${String(err instanceof Error ? err.message : err)}`;
      }
      let receipt: HedgeReceipt | null;
      if (intent && lockMode(hedgeChoice.live, intent).real) {
        const done = await hedgeThenLock({
          ref,
          ticker,
          holder,
          intent,
          terms: { contracts: chosen.contracts, tier: chosen.tier, floorCents: chosen.floorCents, capCents: chosen.capCents, creditCents: chosen.creditCents },
          writeLock,
        });
        if (!done.ok) {
          sendJson(res, done.status, { ok: false, at: atIso, ticker, code: done.code, ...(done.status === 500 ? { error: done.code } : {}), message: done.message });
          return;
        }
        receipt = done.receipt;
      } else {
        if (!writeLock()) {
          sendJson(res, 500, { ok: false, error: "ledger_write_failed", message: "The record could not be written; nothing was locked." });
          return;
        }
        receipt = await fillHedge(ref, chosen.hedge, result.books);
      }
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
        // the rule pinned with the record, so the receipt the tap opens says so without a second read
        rule: record.type === "open" ? ruleViewOf(record) : null,
        ...(record.parlay ? { parlay: record.parlay } : {}),
      });
    } finally {
      lockInFlight.delete(flight);
    }
    return;
  }
  if (url.pathname === "/api/shadow/unwind/quote") {
    // LEAVE EARLY, PRICED: the holder's open lock sold into the live books on both legs, at this
    // moment, nothing written. The same pricer the schedule uses (earlyClose.ts); the margin before
    // the start that the schedule keeps is the holder's last moment too. A member's sale is bought
    // back from their venue's offers instead, during the game as well when in play is on.
    const ticker = (url.searchParams.get("ticker") ?? "").trim().toUpperCase();
    const lock = ticker ? loadShadowPositions(ownLedger).find((p) => p.ticker === ticker) : undefined;
    const refusal = unwindRefusal(lock, ticker, Date.now());
    if (refusal || !lock) {
      sendJson(res, refusal?.status ?? 404, { at: atIso, ticker, ...refusal?.body });
      return;
    }
    const lastMs = leaveLastMsOf(lock);
    const lastIso = lastMs === null ? null : new Date(lastMs).toISOString();
    if (lock.route === "member_sale") {
      // a member's leave is a buy-back of the contracts they sold, priced from their venue's offers now
      const bp = await memberBuyBackPriced(holder, lock);
      if (!bp.ok) {
        sendJson(res, bp.status, { at: atIso, ticker, ...bp.body });
        return;
      }
      sendJson(res, 200, { ok: true, at: atIso, ticker, ...(holder ? { holder } : {}), lastIso, unwind: memberUnwindViewOf(lock, bp.sale, bp.bb, bp.maxPrice, bp.midCents) });
      return;
    }
    const q = quoteEarlyClose(closeTermsOf(lock), await closeBooksFn(lock));
    if (!q.ok) {
      sendJson(res, 200, { ok: false, at: atIso, ticker, code: q.code, leg: q.leg, message: `${q.leg === "position" ? "Your side's" : "The hedge's"} book cannot take the size right now: ${q.detail}.` });
      return;
    }
    sendJson(res, 200, { ok: true, at: atIso, ticker, ...(holder ? { holder } : {}), lastIso, unwind: unwindViewOf(lock, q) });
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
      if (lock.route === "member_sale") {
        await memberUnwind(res, holder, lock, ownLedger, atIso);
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
    if (lock.route === "member_sale" && lock.memberSale) {
      // a member's receipt: the sale as the venue filled it, the comparison priced beside it (nothing
      // sent), the tails in their venue's words, the venue's own settlement line once it has one
      const s = lock.memberSale;
      sendJson(res, 200, {
        ok: true,
        at: atIso,
        ticker,
        ...(holder ? { holder } : {}),
        route: "member_sale",
        lock: lockSummaryOf(lock),
        memberSale: memberSaleViewOf(s),
        compared: comparedViewOf(s.compared),
        ...(s.combo ? { combo: true } : {}),
        ...memberRulesView(lock.league, s.keptContracts, Boolean(s.combo)),
        ...(lock.closeMemberBuyBack ? { memberBuyBack: lock.closeMemberBuyBack } : {}),
        venueSettlement: await memberSettlementOf(holder, s),
        hedge: null,
        hedgeSale: null,
        routing: null,
        rule: ruleViewOf(lock),
        cash: [],
      });
      return;
    }
    const receipt = receiptForLock(hedgeRefFor(ticker, holder), lock.at);
    const sale = lock.status === "closed" && lock.closeSource === "unwind" ? receiptForLock(hedgeRefFor(ticker, holder), lock.at, "sell") : null;
    sendJson(res, 200, {
      ok: true,
      at: atIso,
      ticker,
      ...(holder ? { holder } : {}),
      lock: lockSummaryOf(lock),
      hedge: receipt ? hedgeViewOf(receipt) : null,
      // the hedge sold back when the holder left early: the sale's receipt (sent or simulated); null otherwise
      hedgeSale: sale ? hedgeViewOf(sale) : null,
      // where the hedge went against the holder's venue and why, with the tails in the venue's words; null on locks before routing was judged
      routing: routingViewOf(lock.routing),
      // the rule text pinned at the lock and, once settled, whether the venue's text still matched
      rule: ruleViewOf(lock),
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
 * position is priced now as a tap would be (pinned to the one live venue, or the live venues
 * competed behind the executable gate) and sent through the executor and its rails; one more
 * receipt lands on the trail under the same ref. `?route=kalshi|prophetx|novig` names the venue
 * instead, for a venue that keeps refusing; a venue the executor cannot send to on this ticker is
 * refused. The lock's terms do not move: the record is as quoted at the tap. Refused while a live
 * fill is already on the trail for it unless ?force=1.
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
  const routeWord = (url.searchParams.get("route") ?? "").trim();
  const executable = executableFor(ticker);
  let route: HedgeRoute | undefined = lockRouteFor(ticker);
  if (routeWord) {
    const named = hedgeVenuesFromEnv({ EVENT_HEDGE_VENUES: routeWord }).routes[0];
    if (!named) {
      sendJson(res, 400, { ok: false, error: "bad_request", message: `?route= is one of kalshi, prophetx, novig, polymarket; "${routeWord}" is none of them` });
      return;
    }
    if (!executable[named]) {
      sendJson(res, 409, { ok: false, error: "route_not_executable", message: `${VENUE_NAMES[hedgeVenueOf(named)]} cannot be sent to on ${ticker}: no live client for it`, executable });
      return;
    }
    route = named;
  }
  const flight = inFlightKey(holder, ticker);
  if (lockInFlight.has(flight)) {
    sendJson(res, 409, { ok: false, error: "lock_in_flight", message: "This position is being locked right now." });
    return;
  }
  lockInFlight.add(flight);
  try {
    const atIso = new Date().toISOString();
    const q = await quoteOneFn({ ticker, contracts: lock.contracts, entryCents: lock.entryCents, route, holderVenue: lock.holderVenue ?? "kalshi", executable });
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
      // the route this send was held to: the operator's ?route=, else the one live venue; null when the live venues competed
      pinned: route ?? null,
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
      await fillHedge(res.market.ticker, q.hedge, res.books, { paper: true });
    }
    // the candidates the engine priced and declined this scan, kept so the record can say how often it says no
    if (state.refused && state.refused.length > 0) saveRefusals(REFUSALS_PATH, recordScanRefusals(loadRefusals(REFUSALS_PATH), state.refused, state.atIso));
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

/**
 * A combination ticket sold through the member's venue has no Kalshi market to read: the result
 * is the venue's own word on the combo market, read with the member's connection (the holder's
 * when the record names one), the pinned text checked against the market's description as it
 * reads now. Voided like any record when no word comes in time.
 */
async function settleComboRecord(p: ShadowPosition, path: string, now: number): Promise<void> {
  const eventMs = Date.parse(p.eventTimeIso);
  const marketId = p.memberSale?.marketId;
  if (!memberSessions || !marketId) throw new Error(`${p.ticker}: the member app is off; the combo's result cannot be read`);
  const member = memberKeyOf(p.holder ?? null);
  if (!memberSessions.state(member).connected) throw new Error(`${p.ticker}: the member's ${VENUE_NAMES[MEMBER_VENUE]} connection is not open; the combo's result waits`);
  const m = (await memberSessions.client(member).markets([marketId]))[0];
  const word = m ? marketResultWord(m) : null;
  if (word) {
    const at = new Date().toISOString();
    const ruleCheck = checkRule(p.rule, m ? comboRuleText(m) : null, at);
    if (ruleCheck.unchanged === false) {
      void alerter({ kind: "rule_changed", message: `${p.ticker} (${p.eventTitle}) settled ${word} under a combo text that changed since open: ${p.rule?.sha256.slice(0, 12)} -> ${ruleCheck.sha256?.slice(0, 12)}` });
    }
    appendOrAlert({ type: "settle", at, ticker: p.ticker, result: word, ruleCheck }, path);
  } else if (now > eventMs + VOID_AFTER_MS) {
    const reason = `no result on the venue's combo market ${Math.round(VOID_AFTER_MS / 3_600_000)}h after the last leg`;
    if (appendOrAlert({ type: "void", at: new Date().toISOString(), ticker: p.ticker, reason }, path)) {
      void alerter({ kind: "position_voided", message: `${p.ticker} (${p.eventTitle}) voided: ${reason}` });
    }
  }
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
      if (p.memberSale?.combo) {
        await settleComboRecord(p, path, now);
        continue;
      }
      const r = await getMarketResult(p.ticker);
      if (r.result === "yes" || r.result === "no") {
        const at = new Date().toISOString();
        // the same read that carries the result carries the rule; compared to the pin, said either way
        const ruleCheck = checkRule(p.rule, ruleTextNowFor(p, r), at);
        if (ruleCheck.unchanged === false) {
          void alerter({ kind: "rule_changed", message: `${p.ticker} (${p.eventTitle}) settled ${r.result} under a rule text that changed since open: ${p.rule?.sha256.slice(0, 12)} -> ${ruleCheck.sha256?.slice(0, 12)}` });
        }
        const referenceRuleCheck = p.referenceRule ? checkRule(p.referenceRule, kalshiRuleText(r), at) : undefined;
        if (referenceRuleCheck?.unchanged === false) {
          void alerter({ kind: "rule_changed", message: `${p.ticker} (${p.eventTitle}) settled ${r.result}; the Kalshi reference market's text changed since open: ${p.referenceRule?.sha256.slice(0, 12)} -> ${referenceRuleCheck.sha256?.slice(0, 12)}` });
        }
        appendOrAlert(
          {
            type: "settle",
            at,
            ticker: p.ticker,
            result: r.result,
            ruleCheck,
            ...(referenceRuleCheck ? { referenceRuleCheck } : {}),
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
      // a member's own sale has no hedge route to re-read; its comparison was written with the sale
      if (p.status !== "open" || p.kind !== "sports" || p.prelock || p.route === "member_sale") continue;
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

/**
 * Price every open game that is inside its in-game minute and has no in-game read yet: the
 * engine's own quote path with the window set aside (quoteOne's inGame), then both routes and
 * each reference re-priced at the position's size, written to the position's own ledger as an
 * `in_game` re-read with the minutes into the game and the protected market's own spread. A read
 * the engine refuses for a reason that will not change (the market closed, the odds out of range)
 * is written as `unread`; a venue that is unreachable is retried next tick, within the late margin.
 */
async function inGameTick(): Promise<void> {
  if (!quoteOneFn || IN_GAME_MINUTES <= 0 || inGameInFlight) return;
  inGameInFlight = true;
  const now = Date.now();
  let due = 0;
  let written = 0;
  let failed = 0;
  try {
    const onBoth = ledgerPaths().flatMap((path) => loadShadowPositions(path).map((p) => ({ p, path })));
    for (const { p, path } of onBoth) {
      if (p.status !== "open" || p.kind !== "sports" || p.inGame || p.route === "member_sale") continue;
      const eventMs = Date.parse(p.eventTimeIso);
      if (!Number.isFinite(eventMs)) continue;
      const minutesIn = (now - eventMs) / 60_000;
      if (minutesIn < IN_GAME_MINUTES || minutesIn > IN_GAME_MINUTES + IN_GAME_LATE_MINUTES) continue;
      due += 1;
      if (written + failed >= REREAD_MAX_PER_TICK) continue;
      try {
        const q = await quoteOneFn({ ticker: p.ticker, contracts: p.contracts, entryCents: p.entryCents, inGame: true });
        const at = new Date().toISOString();
        const sinceStartMs = Date.parse(at) - eventMs;
        const stamp = { hoursToLock: -Math.round((sinceStartMs / 3_600_000) * 10) / 10, minutesIn: Math.round((sinceStartMs / 60_000) * 10) / 10 };
        if (!q.ok) {
          // the pairing's start is later than the record's (a delayed start): not in play yet, asked again next tick
          if (q.code === "not_started") continue;
          // a structural refusal (the market closed on the result, the odds out of range): final for this position
          if (appendOrAlert({ type: "reread", at, ticker: p.ticker, phase: "in_game", ...stamp, unread: q.code }, path)) written += 1;
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
          config: inPlayConfig(searchConfig()),
          books: res.books,
          prophetxFeeBps: PROPHETX_FEE_BPS,
        });
        const ok = appendOrAlert(
          {
            type: "reread",
            at,
            ticker: p.ticker,
            phase: "in_game",
            ...stamp,
            markCents: res.markCents,
            protectedBook: { yesBidCents: res.market.yesBidCents, yesAskCents: res.market.yesAskCents },
            routes,
            ...(references ? { references } : {}),
            ...(res.bookOrigins ? { bookOrigins: res.bookOrigins } : {}),
          },
          path,
        );
        if (ok) written += 1;
      } catch (err) {
        // the venues unreachable for this one; due again next tick while inside the late margin
        failed += 1;
        lastInGameError = `${p.ticker}: ${String(err instanceof Error ? err.message : err)}`;
      }
    }
    if (failed === 0) lastInGameError = null;
  } finally {
    inGameInFlight = false;
    inGameDueLastTick = due;
    inGameWrittenLastTick = written;
    lastInGameAt = new Date().toISOString();
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
      if (!hold || !pos || pos.bookOpen || pos.status !== "open" || pos.route === "member_sale") {
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

/**
 * The last-leg shadow's router: the engine's own quote (quoteOne), exactly as the lock path calls
 * it for a parlay at its last pick — every hedge venue offered tonight read, the route pinned or
 * competed as the live executor allows for this ticker, the terms headed at the parlay tier — so a
 * simulated ticket's moment is priced where a real one's lock would be sent. Null until the engine
 * is wired (main()); the tick then quotes nothing rather than quoting off one book.
 */
export function lastLegRouter(): LastLegRouter | null {
  const quote = quoteOneFn;
  const markets = listGameMarketsFn;
  if (!quote || !markets) return null;
  return {
    markets: () => markets(),
    quote: async ({ ticker, contracts, entryCents }): Promise<RoutedQuote> => {
      const q = await quote({ ticker, contracts, entryCents, route: lockRouteFor(ticker), holderVenue: "kalshi", executable: executableFor(ticker) });
      if (!q.ok) return { ok: false, code: q.code, detail: q.detail };
      const r = headedAt(q.result, PARLAY_LAST_PICK_TIER);
      if (!r.quote.ok) return { ok: false, code: r.quote.code, detail: r.quote.detail };
      const h = r.quote.hedge;
      const route: HedgeRoute = r.route ?? (h.venue === "kalshi" ? "kalshi_self" : h.venue);
      return {
        ok: true,
        markCents: r.markCents,
        route,
        terms: r.quote,
        hedgeUnitsMilli: "sharesMilli" in h ? h.sharesMilli : h.contractsMilli,
        hedgeCostCents: h.costCents,
        ...(h.venue === "polymarket" ? { hedgeTokenId: h.tokenId } : {}),
      };
    },
  };
}

/** Resolve legs, quote the moment, build tickets: one pass of the last-leg shadow. */
async function lastLegTick(): Promise<void> {
  if (!lastLegCfg.enabled) return;
  const router = lastLegRouter();
  if (!router) return; // the engine is not wired yet: no tickets built, no moment priced off one book
  try {
    lastLastLegReport = await runLastLegTick(
      {
        nowMs: () => Date.now(),
        catalog: () => getComboMarkets({ maxPages: lastLegCfg.catalogPages }),
        legStatus: (slug) => getComboLegStatus(slug),
        noBook: (tokenId) => getPmBook(tokenId),
        load: () => loadLastLegTickets(LASTLEG_PATH),
        append: (record) => appendLastLegRecord(LASTLEG_PATH, record),
        router,
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
    inGame: { minutes: IN_GAME_MINUTES, lateMinutes: IN_GAME_LATE_MINUTES, everyMs: REREAD_MS, lastAt: lastInGameAt, lastError: lastInGameError, dueLastTick: inGameDueLastTick, writtenLastTick: inGameWrittenLastTick },
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
      // real-money locks buy the hedge first (hedgeFirst.ts): attempts by ending, and the two counts that must read zero
      hedgeFirst: pendingHealth(),
      // who may lock (aliases only, never keys), each with their ledger and how many locks stand on it
      holders: HOLDER_KEYS.holders.map((h) => {
        const path = lockLedgerPathFor(h.holder);
        return { holder: h.holder, positions: loadShadowPositions(path).length, ledger: { path, ...ledgerStats(path) } };
      }),
      ...(HOLDER_KEYS.notes.length ? { holderNotes: HOLDER_KEYS.notes } : {}),
      // the holder's venue account, read-only: configured or not, never the key
      holderPositions: { configured: Boolean(venueClient), ...(venueClient ? { api: venueClient.kind } : {}), ...(venueClientNote ? { note: venueClientNote } : {}), lastReadAt: positionsCache ? new Date(positionsCache.at).toISOString() : null },
      // the member app (memberApp.ts): on or off and why, where the store is, who is connected by alias and venue id; never a token, a code or the secret
      member: {
        configured: Boolean(memberSessions),
        venue: MEMBER_VENUE,
        ...(memberSessions
          ? {
              host: memberSessions.cfg.host,
              redirectUri: memberSessions.cfg.redirectUri,
              page: `${RECORD_URL}${MEMBER_APP_PATH}`,
              ...(MEMBER_APP_VENUE_URL ? { venueUrl: MEMBER_APP_VENUE_URL } : {}),
              scopes: memberSessions.cfg.scopes,
              tokensPath: memberSessions.cfg.storePath,
              orderWaitMs: memberOrderOpts.waitMs ?? 3000,
              inPlay: memberInPlay,
              compareWaitMs: MEMBER_COMPARE_WAIT_MS,
              members: memberSessions.summary(),
              ...(MEMBER_APP_HOSTNAME ? { hostname: MEMBER_APP_HOSTNAME } : {}),
              ...(memberCatalogSample.size ? { catalogue: Object.fromEntries(memberCatalogSample) } : {}),
            }
          : {}),
        ...(memberApp.notes.length ? { notes: memberApp.notes } : {}),
      },
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
function publicPosition(p: ShadowPosition): Omit<ShadowPosition, "counterfactuals" | "prelock" | "bookOpen" | "inGame" | "hedgeTokenId" | "hedgeStrikeId" | "hedgeOffsetStrikeId" | "hedgeMarketId" | "hedgeOutcomeId" | "hedgeOffsetOutcomeId" | "bookOrigins" | "holder"> & { cashDue?: ReturnType<typeof cashDue> } {
  // where the books came from (the partner's feed or the venue), the pre-lock, book-open and in-game reads and whose lock it is are the operator's: /venues, /api/shadow/holders, the raw ledger
  const { counterfactuals: _cf, prelock: _prelock, bookOpen: _bookOpen, inGame: _inGame, hedgeTokenId: _tok, hedgeStrikeId: _strike, hedgeOffsetStrikeId: _offset, hedgeMarketId: _nvMarket, hedgeOutcomeId: _nvOutcome, hedgeOffsetOutcomeId: _nvOffset, bookOrigins: _origins, holder: _holder, ...rest } = p;
  // a member's own sale: the venue's order ids and market id stay with the operator; the sale's figures are public
  const pub = rest.memberSale ? { ...rest, memberSale: publicMemberSale(rest.memberSale), ...(rest.closeMemberBuyBack ? { closeMemberBuyBack: publicMemberBuyBack(rest.closeMemberBuyBack) } : {}) } : rest;
  // a holder's lock carries what it owes and what was paid; the scan's positions pay nobody
  return p.source === "lock" ? { ...pub, cashDue: cashDue(p) } : pub;
}
function publicMemberSale(s: MemberSaleRecord): MemberSaleRecord {
  return { ...s, marketId: "", orderId: null, clientOrderId: "" };
}
function publicMemberBuyBack(b: NonNullable<ShadowPosition["closeMemberBuyBack"]>): NonNullable<ShadowPosition["closeMemberBuyBack"]> {
  return { ...b, orderId: null, clientOrderId: "" };
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
    if (isMemberAppHost(req)) {
      // the page's own host: the root is the page; the page's files, the member callback and the
      // API stay; everything else lives on the record URL
      if (url.pathname === "/") url.pathname = MEMBER_APP_PATH;
      else if (url.pathname === "/privacy") url.pathname = `${MEMBER_APP_PATH}/privacy`;
      else if (!(url.pathname.startsWith(MEMBER_APP_PATH) || url.pathname.startsWith("/api/") || url.pathname === "/healthz")) {
        res.writeHead(302, { location: `${RECORD_URL}${url.pathname}${url.search}`, "cache-control": "no-store" });
        res.end();
        return;
      }
    }
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
    if (url.pathname === MEMBER_CALLBACK_PATH) {
      // THE VENUE'S REDIRECT after the member allowed (or refused) the connection: keyless, since the
      // browser arrives from the venue; the one-time state the service issued is what is checked.
      // The code is exchanged server to server; the page says connected or not, nothing more.
      if (!memberSessions) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }
      void memberSessions
        .finishConnect({ code: url.searchParams.get("code"), state: url.searchParams.get("state"), error: url.searchParams.get("error"), error_description: url.searchParams.get("error_description") })
        .then((r) => {
          if (r.member) memberPositionsCache.delete(r.member);
          if (r.member && isMemberAlias(r.member)) {
            // the hosted page's member: back to the page, which says connected (or why not) in place
            const origin = memberConnectOrigin.get(r.member) ?? "";
            memberConnectOrigin.delete(r.member);
            res.writeHead(302, { location: `${origin}${MEMBER_APP_PATH}` + (r.ok ? "?connected=1" : `?error=${encodeURIComponent(r.message)}`), "cache-control": "no-store" });
            res.end();
            return;
          }
          sendHtml(res, r.ok ? 200 : 400, memberCallbackHtml(r.ok, r.ok ? `Your ${VENUE_NAMES[MEMBER_VENUE]} account is connected. You can close this tab and go back to the game.` : r.message));
        })
        .catch((err: unknown) => sendHtml(res, 500, memberCallbackHtml(false, `Something failed on our side: ${String(err instanceof Error ? err.message : err)}`)));
      return;
    }
    if (url.pathname === `${MEMBER_APP_PATH}/privacy`) {
      sendHtml(res, 200, memberPrivacyHtml({ venueName: VENUE_NAMES[MEMBER_VENUE], recordUrl: RECORD_URL, appUrl: isMemberAppHost(req) ? "/" : MEMBER_APP_PATH, ...(MEMBER_APP_CONTACT ? { contact: MEMBER_APP_CONTACT } : {}) }));
      return;
    }
    if (url.pathname.startsWith(`${MEMBER_APP_PATH}/`) && url.pathname !== `${MEMBER_APP_PATH}/`) {
      // the page's own files: the marks, the home-screen icons and the manifest; nothing personal, cached long
      const file = MEMBER_APP_FILES[url.pathname.slice(MEMBER_APP_PATH.length + 1)];
      if (!file) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }
      res.writeHead(200, { "content-type": file.type, "cache-control": "public, max-age=86400", "content-length": String(file.body.length) });
      res.end(file.body);
      return;
    }
    if (url.pathname === MEMBER_APP_PATH || url.pathname === `${MEMBER_APP_PATH}/`) {
      // THE HOSTED MEMBER PAGE: the session cookie is set here, once, and the page does the rest
      // against the routes below with it. No key is ever on the page.
      const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" };
      if (memberSessions && !memberCookieValue(req)) headers["set-cookie"] = memberCookieHeader(randomBytes(32).toString("base64url"));
      res.writeHead(200, headers);
      res.end(memberAppHtml({ venueName: VENUE_NAMES[MEMBER_VENUE], configured: Boolean(memberSessions), recordUrl: RECORD_URL, ...(MEMBER_APP_VENUE_URL ? { venueUrl: MEMBER_APP_VENUE_URL } : {}) }));
      return;
    }
    if (LOCK_PATHS.has(url.pathname)) {
      // No key configured: the routes do not exist. Wrong or missing key: 403, like the operator views.
      // A holder's key names the holder; the shared key and the operator act with no holder, and the
      // operator may act as one with ?holder= (a lock entered for a person by hand).
      const caller = lockCaller(LOCK_KEY, HOLDER_KEYS.holders, req.headers, url.searchParams.get("lock"));
      if (!operator && !caller) {
        // the hosted page's member: the cookie names them, and a POST must carry the page's own header
        const cookieHolder = memberCookieHolder(req);
        if (cookieHolder && (req.method === "GET" || req.headers["x-member-app"] === "1")) {
          void handleLockRoutes(req, res, url, cookieHolder, false, true).catch((err: unknown) => sendJson(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) }));
          return;
        }
      }
      if (!LOCK_ROUTES_ON && !operator) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }
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
        refusals: refusalSummary(positions),
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
    if (url.pathname === "/api/shadow/scoreboard" || url.pathname === "/api/shadow/scoreboard.csv" || url.pathname === "/scoreboard") {
      // PUBLIC, INDUSTRY SHAPE: the venue scoreboard by week (venueScoreboard.ts), computed from
      // the record on each request so it moves as the record does. Venue-named on purpose: this is
      // the hedger's comparison of the venues, for industry readers, not a holder's screen. Nothing
      // of the writer's book is in it. ?weeks=N (1..26, default 8). CORS open: the record is public.
      // /scoreboard is the same table as a page, with the JSON and CSV links at the top.
      const weeksRaw = Number(url.searchParams.get("weeks") ?? "8");
      const weeks = Number.isFinite(weeksRaw) ? Math.min(26, Math.max(1, Math.floor(weeksRaw))) : 8;
      const positions = allPositions();
      const sb = venueScoreboard({ positions, refusals: loadRefusals(REFUSALS_PATH), tickets: loadLastLegTickets(LASTLEG_PATH), weeks });
      const headers = { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" };
      if (url.pathname === "/scoreboard") {
        res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
        res.end(renderScoreboardHtml({ scoreboard: sb, weeks }));
        return;
      }
      if (url.pathname.endsWith(".csv")) {
        res.writeHead(200, { ...headers, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="venue-scoreboard-${sb.at.slice(0, 10)}.csv"` });
        res.end(venueScoreboardCsv(sb));
        return;
      }
      res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(sb));
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
    if (url.pathname === "/api/shadow/lock/pending") {
      // The pending trail (hedgeFirst.ts): every real-money lock attempt and how it ended; what is
      // still open; what was bought, or may have been, with no lock behind it.
      const records = loadPending(PENDING_PATH);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)));
      sendJson(res, 200, { ok: true, at: new Date().toISOString(), path: PENDING_PATH, ...summarizePending(records), recent: records.slice(-limit).reverse() });
      return;
    }
    if (url.pathname === "/api/shadow/lock/pending/clear") {
      // The operator's word that an open or stray line was looked at on the venue and dealt with.
      // Appends one line; removes nothing. POST ?id=<the line's id>&note=<what was done>.
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "POST /api/shadow/lock/pending/clear?id=...&note=... with the operator token" });
        return;
      }
      const id = (url.searchParams.get("id") ?? "").trim();
      const note = (url.searchParams.get("note") ?? "").trim().slice(0, 300);
      if (!id || !note) {
        sendJson(res, 400, { ok: false, error: "bad_request", message: "id names the line; note says what was done on the venue" });
        return;
      }
      if (!clearable(loadPending(PENDING_PATH), id)) {
        sendJson(res, 404, { ok: false, error: "not_found", message: "no open or stray line has that id" });
        return;
      }
      if (!appendPendingOrAlert({ type: "cleared", id, at: new Date().toISOString(), note })) {
        sendJson(res, 500, { ok: false, error: "ledger_write_failed" });
        return;
      }
      sendJson(res, 200, { ok: true, id, ...summarizePending(loadPending(PENDING_PATH)) });
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
    if (url.pathname === "/api/shadow/member/raw") {
      // THE OPERATOR'S RAW READ of one member's venue account, as the wire gives it: the positions list
      // unfiltered, the markets for their ids, which ids the markets endpoint did not return, a few
      // probes of paths the docs do not settle (where a combination might live), and the listing
      // endpoint's books. For fitting the reader to the real venue; no token is ever in the body.
      if (!memberSessions) {
        sendJson(res, 404, { ok: false, error: "member_app_off" });
        return;
      }
      const members = memberSessions.summary();
      const member = url.searchParams.get("holder") ?? url.searchParams.get("member") ?? (members.length === 1 ? members[0].member : null);
      if (!member || !members.some((m) => m.member === member)) {
        sendJson(res, 400, { ok: false, error: "member", message: "name a connected member with ?holder=<alias>", members: members.map((m) => m.member) });
        return;
      }
      void (async () => {
        const client = memberSessions!.client(member);
        const raw = await client.positionsRaw();
        const list = (raw as { positions?: Array<Record<string, unknown>> } | null)?.positions ?? [];
        const ids = [...new Set(list.map((p) => p?.market_id).filter((id): id is string => typeof id === "string"))];
        let markets: RawOutcomeMarket[] = [];
        let marketsError: string | null = null;
        try {
          markets = await client.markets(ids);
        } catch (err) {
          marketsError = String(err instanceof Error ? err.message : err);
        }
        const have = new Set(markets.map((m) => m.market_id));
        const probes: Record<string, { status: number; body: unknown }> = {};
        for (const path of ["/api/v1/combos", "/api/v1/account/combos", "/api/v1/positions?include=combos", "/api/v1/markets?types=combo&limit=5", "/api/v1/orders?status=filled&limit=5"]) probes[path] = await client.probe(path);
        sendJson(res, 200, {
          ok: true,
          at: new Date().toISOString(),
          member,
          positions: { count: list.length, dropped: list.filter((p) => !(typeof p?.market_id === "string" && (typeof p?.position === "string" || typeof p?.position === "number"))), raw },
          markets: { asked: ids.length, returned: markets.length, missing: ids.filter((id) => !have.has(id)), ...(marketsError ? { error: marketsError } : {}), raw: markets },
          probes,
          ...(memberCatalogSample.size ? { catalogue: Object.fromEntries(memberCatalogSample) } : {}),
        });
      })().catch((err: unknown) => sendJson(res, 502, { ok: false, error: "venue_read_failed", message: String(err instanceof Error ? err.message : err) }));
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
      // the venues this slate's record used, then the ones offered tonight (EVENT_HEDGE_VENUES); a
      // venue that is neither is not on the page. A share link carries how many, never which
      // (SLATE_NAMES_HEDGE_VENUES); the operator's own token reads the names.
      const used = Object.keys(summary.routeSplit).map((r) => HEDGE_VENUE_NAMES[r]).filter(Boolean);
      const hedgeVenues = [...new Set([...used, ...HEDGE_VENUES.routes.map((r) => HEDGE_VENUE_NAMES[r]).filter(Boolean)])];
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
          nameHedgeVenues: SLATE_NAMES_HEDGE_VENUES || (operator && !keyed),
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
          refusals: refusalSummary(positions),
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
  alertUnresolvedPending();
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[event-shadow] listening on :${PORT} · ledger ${LEDGER_PATH} · scan every ${Math.round(SCAN_MS / 60_000)}m · settle every ${Math.round(SETTLE_MS / 60_000)}m · early closes ${earlyCloseRule.sharePct}% of the book` +
        (REREAD_HOURS > 0 ? ` · pre-lock re-read ${REREAD_HOURS}h before each lock` : " · pre-lock re-read off") +
        (IN_GAME_MINUTES > 0 ? ` · in-game re-read ${IN_GAME_MINUTES}m after each start` : " · in-game re-read off") +
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
    if (IN_GAME_MINUTES > 0) {
      void inGameTick();
      setInterval(() => void inGameTick(), REREAD_MS);
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
  /** the board scan a scanTick runs, in place of the scanner module's */
  scan?: NonNullable<typeof scan>;
  /** the settled game markets a parlay's picks are read against, in place of Kalshi's public list */
  settledMarkets?: typeof settledMarketsFn;
  /** the member app's sessions (a fake venue behind them), in place of the env's; null turns the member routes off */
  memberSessions?: MemberSessions | null;
  /** how long a member's order rests before the rest is cancelled, and how often it is polled */
  memberOrder?: ExecuteOptions;
  /** whether a member may lock while the game is on, in place of MEMBER_APP_IN_PLAY (on unless set to 0) */
  memberInPlay?: boolean;
  /** whether a member's combination ticket is quoted and sold through the venue's request for quote, in place of MEMBER_APP_COMBO_RFQ (off unless set); "preview" quotes from a stand-in and refuses the tap */
  memberComboRfq?: boolean | "preview";
}): void {
  quoteOneFn = fns.quoteOne;
  listGameMarketsFn = fns.listGameMarkets;
  if (fns.memberSessions !== undefined) {
    memberSessions = fns.memberSessions;
    memberPositionsCache.clear();
  }
  if (fns.memberOrder) memberOrderOpts = fns.memberOrder;
  if (fns.memberInPlay !== undefined) memberInPlay = fns.memberInPlay;
  if (fns.memberComboRfq !== undefined) {
    memberComboRfq = fns.memberComboRfq === "preview" ? "preview" : fns.memberComboRfq ? "on" : "off";
    memberPositionsCache.clear();
  }
  if (fns.settledMarkets) {
    settledMarketsFn = fns.settledMarkets;
    settledCache.clear();
  }
  if (fns.closeBooks) closeBooksFn = fns.closeBooks;
  if (fns.hedgeExecutor) hedgeChoice.executor = fns.hedgeExecutor;
  if (fns.scan) scan = fns.scan;
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

export { server, scanTick, settleTick, closeTick, lastLegTick, rereadTick, inGameTick, holdTick };
