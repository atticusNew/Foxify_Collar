#!/usr/bin/env tsx
/**
 * EARN & PROTECT — EVENTS, PROTECTION ROUTER (Tier 2 demonstration service)
 *
 * A self-contained, read-only demo of one-tap protection on Kalshi event
 * markets — GAMES AND CRYPTO on one board. Every event is priced on every
 * hedge route that is structurally safe for it, and the holder gets the
 * cheapest one:
 *   - polymarket:  (sports only) the SAME game listed on Polymarket; the
 *                  opposing outcome token pays $1 exactly when the protected
 *                  side loses. Quotes only from the curated whitelist where
 *                  both venues verifiably settle on the identical result.
 *   - kalshi_self: (every market) the protected market's own No side; same
 *                  instrument, same settlement, zero basis risk.
 * Crypto strike markets quote ONLY the self-hedge route: the venues settle
 * crypto on different index feeds, so a cross-venue hedge would not be the
 * same trade. That refusal is disclosed, not hidden.
 *
 * What is real: the venues' markets and live prices, the whitelist pairing,
 * the executable hedges (walked through each venue's live book), and every
 * credit/refusal quoted from them.
 * What is simulated: the holder's position and the wrap lifecycle. No venue
 * credentials, no wallet; only public market-data endpoints - this service is
 * structurally unable to trade, deposit, or pay.
 *
 * ISOLATION: imports only from src/eventCollar/**. Nothing here touches the
 * production Earn & Protect service, stores, or deploy.
 *
 * RETAIL FIRST: GET /api/showcase and GET /api/receipts serve the holder's
 * shape (src/eventCollar/retailShowcase.ts): event, position, floor/cap/credit
 * per tier, a retail refusal sentence, the track record. The hedge leg, the
 * pairing, the routes examined, our take and raw refusal detail answer only to
 * the operator token (?token= or x-admin-token, EVENT_X_ADMIN_TOKEN), so dev
 * tools show a visitor exactly what the card shows.
 *
 * EMBED DEMO IS THE FRONT DOOR: GET / (also /embed) is the layer inside a
 * host's app: their positions list in their colours (brand: EVENT_X_EMBED_BRAND
 * by default, `?brand=` honoured only on EVENT_X_BRAND_ALLOWLIST; a recognised
 * brand brings its colourway and light/dark shell, `?skin=` overrides) with
 * our Protect button on every row; the sheet prices from the same scan and the
 * row reshapes to "ends floor or cap · credit paid now". The board is GET /board.
 * GET /partner
 * (operator token) is the host's console: volume protected, credits paid to
 * their users, cost of protection, own-book share, refusals, revenue share
 * (EVENT_X_PARTNER_SHARE_PCT, default 50).
 *
 * Funnel (mirrors the perp demo's admin funnel): page loads are counted when
 * served; board taps and Protect toggles arrive as tiny beacons on
 * POST /api/metrics carrying only an anonymous per-tab session id and the
 * tapped ticker — every financial field is filled in from the server's own
 * scan. Read it at GET /api/admin/funnel (EVENT_X_ADMIN_TOKEN), reset with
 * POST /api/admin/funnel/reset. Persisted as one JSON file, flushed each
 * minute when dirty.
 *
 * Run: npx tsx services/api/scripts/eventProtectXDemoService.ts
 * Env: EVENT_X_PORT (default 8792) · EVENT_X_CONTRACTS (default 150)
 *      EVENT_X_TAKE_BPS (share of gross, default 1000) · EVENT_X_MIN_TAKE_BPS
 *      (minimum fee, bps of stake, default 25; 0 disables) · EVENT_X_DEFAULT_TIER
 *      (tight|balanced|wide, default balanced) · EVENT_X_LEDGER_PATH · EVENT_X_BOARD_ROWS
 *      EVENT_X_MAX_EV_COST_BPS (ceiling on protection's EV cost, default 300; 0 = off)
 *      EVENT_X_FAR_OUT_HOURS (no cross-venue route on a game further out than this when the
 *      market's own No side is empty and the feed has no book, default 24; 0 = off)
 *      EVENT_X_KEEP_WARM_MS (the scan is refreshed on this timer with or without visitors, default 60s)
 *      EVENT_X_STALE_MAX_MS (backstop: a cached scan older than this is not served before its
 *      refresh, default 5m) · EVENT_X_STALE_WAIT_MS (how long that wait may take, default 20s)
 *      EVENT_X_CRYPTO_SERIES (default KXBTCD,KXETHD) · EVENT_X_CRYPTO_ROWS
 *      EVENT_X_FUNNEL_PATH · EVENT_X_ADMIN_TOKEN (or EVENT_X_DEV_NO_ADMIN=true)
 *      KALSHI_REST_BASE / PM_GAMMA_REST_BASE / PM_CLOB_REST_BASE (relay overrides)
 *      EVENT_X_VIDEO_URL / EVENT_X_VIDEO_POSTER_URL (the live recording on the demo page;
 *      default the bundled file at /media/lockin-live.mp4; "off" hides the block)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adminAuthorized,
  coerceEventFunnel,
  emptyEventFunnel,
  eventFunnelSummary,
  isEventAction,
  parseAdminAuthFromEnv,
  recordAction,
  recordPageLoad,
  tokenBucketLimiter,
  type EventFunnelState,
  type ProtectContext,
} from "../src/eventCollar/crossVenue/eventFunnel";
import { getOpenMarkets, getRecentTrades, midCents } from "../src/eventCollar/kalshiPublic";
import {
  buildShowcasePosition,
  rankShowcaseCandidates,
  type ShowcaseSelection,
} from "../src/eventCollar/showcasePicker";
import { appendCrossLedger, summarizeCrossLedger } from "../src/eventCollar/crossVenue/crossLedger";
import { retailCrossPayload } from "../src/eventCollar/retailShowcase";
import type { KalshiMarket } from "../src/eventCollar/types";
import { LEAGUE_TEMPLATES, type LeagueTemplate } from "../src/eventCollar/crossVenue/resolutionWhitelist";
import { matchKalshiMarket, parseGameTicker } from "../src/eventCollar/crossVenue/eventMatcher";
import { getPmBook } from "../src/eventCollar/crossVenue/polymarketPublic";
import { evCostBps, quoteCrossWrap } from "../src/eventCollar/crossVenue/crossVenuePricer";
import { getNoAsks, quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { readReferenceBooks, referenceSourcesFromEnv, type ReferenceBook, type ReferenceCatalogProbe } from "../src/eventCollar/crossVenue/venueBooks";
import { aggregatorBookSourceFromEnv, type AggregatorBookSource, type AggregatorBookStatus, type BookOrigins } from "../src/eventCollar/crossVenue/aggregatorBooks";
import { farOutGuardFromEnv, farOutVerdict, type FarOutGuardRule } from "../src/eventCollar/crossVenue/farOutGuard";
import { readReferencePrints, referencePrintSourcesFromEnv, type ReferencePrint } from "../src/eventCollar/crossVenue/venuePrints";
import {
  DEFAULT_CROSS_CONFIG,
  type CollarTerms,
  type CrossQuoteResult,
  type CrossSearchConfig,
  type HedgeRoute,
  type MatchedPair,
  type PmBook,
  type ProtectionTier,
  type RouteCheck,
} from "../src/eventCollar/crossVenue/types";
import { renderEventXAppHtml, renderFunnelHtml, renderReceiptsHtml } from "./eventProtectXAppHtml";
import { DEFAULT_EMBED_BRAND, DEFAULT_LIVE_VIDEO, brandRecordUrl, renderEventEmbedHtml, renderPartnerCtaHtml, renderPartnerHtml, resolveBrand, type LiveVideo } from "./eventProtectEmbedHtml";
import { serveMedia } from "../src/eventCollar/crossVenue/mediaFiles";
import { renderVCard, vcardFilename, type CardContact } from "../src/eventCollar/crossVenue/cardContact";
import { applyMinimumCredit, describeMinimumCredit, minimumCreditRuleFromEnv } from "../src/eventCollar/crossVenue/minimumCredit";
import { archiveLedgerFile } from "../src/eventCollar/crossVenue/ledgerArchive";
import { activityFromShadowBody } from "../src/eventCollar/crossVenue/activityRetail";
import { getKalshiBookSides, quoteEarlyClose, type EarlyCloseBooks } from "../src/eventCollar/crossVenue/earlyClose";

const PORT = Number(process.env.EVENT_X_PORT || process.env.PORT || 8792);
const SHOWCASE_CONTRACTS = Number(process.env.EVENT_X_CONTRACTS || 150);
const LEDGER_PATH = process.env.EVENT_X_LEDGER_PATH || "/tmp/event-demo/cross-quotes.jsonl";
const MAX_MATCH_ATTEMPTS = 10;
/** Scanner board caps: how many pairings get live-quoted per refresh. */
const MAX_BOARD_ROWS = Number(process.env.EVENT_X_BOARD_ROWS || 6);
const MAX_CRYPTO_ROWS = Number(process.env.EVENT_X_CRYPTO_ROWS || 2);
/**
 * Ceiling on what protection may cost, in bps of the position's expected value at the market's
 * own odds. Above it the cheapest route is still rich insurance (a wide No-side spread, usually),
 * and refusing beats quoting: the board and the track record stop being dominated by the worst
 * product. 0 disables the ceiling.
 */
export const MAX_EV_COST_BPS = Number(process.env.EVENT_X_MAX_EV_COST_BPS ?? 300);
/**
 * MINIMUM CREDIT (src/eventCollar/crossVenue/minimumCredit.ts): 25¢ and 0.25% of stake by default
 * (EVENT_X_MIN_CREDIT_CENTS, EVENT_X_MIN_CREDIT_BPS). Applied in the scan, before the ceiling, so
 * the board, the embed and the shadow record offer the same tiers and refuse the same events.
 */
export const MIN_CREDIT_RULE = minimumCreditRuleFromEnv(process.env);
/**
 * FAR-OUT GUARD (src/eventCollar/crossVenue/farOutGuard.ts): a game more than EVENT_X_FAR_OUT_HOURS
 * away (default 24) is not routed cross-venue while the market's own No side cannot fund it and the
 * feed has no book for it: the second venue's ask is a placeholder then, not a hedge. Deferred, not
 * lost; priced again every scan and opened once a real book shows or the window is reached.
 */
export const FAR_OUT_GUARD = farOutGuardFromEnv(process.env);
/**
 * EMBED DEMO knobs. `?brand=` on /embed is honoured only for names on the allowlist (fail-closed
 * to "Your Exchange"); the partner console's revenue-share line uses EVENT_X_PARTNER_SHARE_PCT.
 * /partner without the operator token is the public pitch for the console with one CTA
 * (EVENT_X_CONTACT_EMAIL, default michael@atticustrade.com); with it, the console.
 */
const BRAND_ALLOWLIST = process.env.EVENT_X_BRAND_ALLOWLIST || "";
/** What the embed shell calls the host when the link carries no brand (the first screen for a cold visitor). */
const EMBED_BRAND = process.env.EVENT_X_EMBED_BRAND || DEFAULT_EMBED_BRAND;
/** where the public /partner page's "Talk to us" goes */
const CONTACT_EMAIL = process.env.EVENT_X_CONTACT_EMAIL || "michael@atticustrade.com";
const PARTNER_SHARE_PCT = Math.min(100, Math.max(0, Number(process.env.EVENT_X_PARTNER_SHARE_PCT ?? 50)));
/** The track record (its own deploy); the embed's one public link and the desktop pitch's first partner link. */
const TRACK_RECORD_URL = process.env.EVENT_X_SHADOW_URL || "https://atticus-event-shadow.onrender.com";
/**
 * The shadow's slate share key, the same value as on the shadow service. With it, a partner
 * brand's shell links to its own slate page (/slate/<slug>) with a key derived for that slate
 * alone; without it every shell links to the public record.
 */
const SLATE_KEY = process.env.EVENT_SHADOW_SLATE_KEY;
/**
 * The live recording on the demo page (a real position locked and hedged on Kalshi). Served
 * from this service's assets folder at /media/ by default; EVENT_X_VIDEO_URL (and
 * EVENT_X_VIDEO_POSTER_URL) point it at a CDN instead, and EVENT_X_VIDEO_URL=off leaves it out.
 */
const MEDIA_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets");
const LIVE_VIDEO: LiveVideo | null = (() => {
  const src = process.env.EVENT_X_VIDEO_URL?.trim();
  if (src?.toLowerCase() === "off") return null;
  if (!src) return DEFAULT_LIVE_VIDEO;
  return { src, poster: process.env.EVENT_X_VIDEO_POSTER_URL?.trim() || DEFAULT_LIVE_VIDEO.poster };
})();

/**
 * THE BUSINESS CARD: its QR is `/?from=card`. A phone that scans it gets a landing (the sentence,
 * the clip, Save contact, the links) instead of the bare demo; a desktop gets the page as usual.
 * `/contact.vcf` is the "Save contact" behind it. EVENT_X_CARD=off turns both off.
 */
const CARD_CONTACT: CardContact | null =
  process.env.EVENT_X_CARD?.trim().toLowerCase() === "off"
    ? null
    : {
        givenName: "Michael",
        familyName: "William",
        org: "Atticus",
        title: "Founder",
        email: "michael@atticustrade.com",
        phoneE164: "+17186643497",
        linkedin: "https://www.linkedin.com/in/michael-william-5888ba263/",
        site: "https://event.earnandprotect.xyz/",
        note: "Earn & Protect. The Lock in button: a floor and cash now on any open position, hedged leg for leg.",
      };

/**
 * PARLAYS: the demo's Parlays tab lists the shadow's simulated tickets (the last-leg ledger
 * lives on the shadow service's disk) through GET /api/parlays, a read-through of the shadow's
 * public /api/shadow/parlays. Cached for a minute, stale copy served for ten if the shadow is
 * unreachable, then an honest "unavailable". Retail shape end to end; nothing is re-priced here.
 */
const PARLAYS_SOURCE = `${TRACK_RECORD_URL.replace(/\/+$/, "")}/api/shadow/parlays`;
const PARLAYS_FRESH_MS = 60_000;
const PARLAYS_STALE_MS = 10 * 60_000;
const PARLAYS_TIMEOUT_MS = Number(process.env.EVENT_X_PARLAYS_TIMEOUT_MS || 6_000);

/**
 * One read-through of a public shadow URL: fresh for a minute, the stale copy for ten when the
 * shadow is unreachable, then null for an honest "unavailable". `shape` turns the shadow's body
 * into what this service serves (identity for parlays; the retail activity cut for activity),
 * and runs once per fetch, not per request.
 */
function shadowReadThrough(source: string, shape: (body: string) => string): (nowMs: number) => Promise<string | null> {
  let cache: { body: string; atMs: number } | null = null;
  let inflight: Promise<string | null> | null = null;
  return async (nowMs: number) => {
    if (cache && nowMs - cache.atMs < PARLAYS_FRESH_MS) return cache.body;
    if (!inflight) {
      inflight = (async () => {
        try {
          const r = await fetch(source, { signal: AbortSignal.timeout(PARLAYS_TIMEOUT_MS), headers: { accept: "application/json" } });
          if (!r.ok) throw new Error(`shadow answered ${r.status}`);
          const raw = await r.text();
          const parsed = JSON.parse(raw) as { ok?: unknown };
          if (parsed.ok !== true) throw new Error("shadow body not ok");
          const body = shape(raw);
          cache = { body, atMs: Date.now() };
          return body;
        } catch {
          return cache && Date.now() - cache.atMs < PARLAYS_STALE_MS ? cache.body : null;
        } finally {
          inflight = null;
        }
      })();
    }
    return inflight;
  };
}
const fetchParlays = shadowReadThrough(PARLAYS_SOURCE, (body) => body);

/**
 * ACTIVITY: the demo's Activity tab lists the record's finished positions (settled at the
 * venue's official result, or closed early) through GET /api/activity, cut to retail shape
 * from the shadow's public /api/shadow. Same cache rhythm as parlays. Outcomes only: what it
 * ended at with the lock, what it would have ended at without, what was paid at open.
 */
const ACTIVITY_SOURCE = `${TRACK_RECORD_URL.replace(/\/+$/, "")}/api/shadow`;
const fetchActivity = shadowReadThrough(ACTIVITY_SOURCE, (body) => {
  const parsed = JSON.parse(body) as { at?: unknown };
  return JSON.stringify({ ok: true, at: typeof parsed.at === "string" ? parsed.at : new Date().toISOString(), ...activityFromShadowBody(parsed) });
});

/** Kalshi crypto strike series admitted to the board (self-hedge route only). */
const CRYPTO_SERIES = (process.env.EVENT_X_CRYPTO_SERIES || "KXBTCD,KXETHD")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CRYPTO_ASSET_NAMES: Record<string, string> = {
  KXBTCD: "Bitcoin",
  KXETHD: "Ethereum",
};
const CRYPTO_PARITY_NOTE =
  "the hedge is the protected market's own No side; settlement is identical by construction";
const CRYPTO_PM_NOT_OFFERED =
  "not offered for crypto: the venues settle on different index feeds, so a cross-venue hedge would not be the same trade";

// Funnel counters: in-memory, restored from one JSON file at boot, flushed at
// most once a minute when dirty (same rhythm as the perp demo). Admin-only to
// read; fail-closed when no token is configured.
const FUNNEL_PATH = process.env.EVENT_X_FUNNEL_PATH || "/tmp/event-demo/funnel.json";
const adminAuth = parseAdminAuthFromEnv(process.env);
const metricsLimiter = tokenBucketLimiter(Number(process.env.EVENT_X_RATE_METRICS_PER_MIN || 30), 60_000);
/** early-close quotes hit the venues' books live on every call; one bucket per visitor keeps that honest */
const closeQuoteLimiter = tokenBucketLimiter(Number(process.env.EVENT_X_RATE_CLOSE_PER_MIN || 20), 60_000);
const METRICS_BODY_LIMIT = 2_048;
let funnelState: EventFunnelState = loadFunnel();
let funnelDirty = false;

function loadFunnel(): EventFunnelState {
  try {
    if (!existsSync(FUNNEL_PATH)) return emptyEventFunnel();
    return coerceEventFunnel(JSON.parse(readFileSync(FUNNEL_PATH, "utf8")));
  } catch (err) {
    // A corrupt counter file must never keep the demo from booting.
    console.error(`[event-protect-x] funnel load failed, starting empty: ${(err as Error).message}`);
    return emptyEventFunnel();
  }
}

/** Atomic write (temp + rename) so a crash mid-flush cannot leave a torn file. */
function flushFunnel(): void {
  if (!funnelDirty) return;
  funnelDirty = false;
  try {
    mkdirSync(dirname(FUNNEL_PATH), { recursive: true });
    const tmp = `${FUNNEL_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(funnelState));
    renameSync(tmp, FUNNEL_PATH);
  } catch (err) {
    funnelDirty = true;
    console.error(`[event-protect-x] funnel save failed: ${(err as Error).message}`);
  }
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  return (first ?? "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}

/** Read a small body; null when it exceeds `limit`. Oversize input is drained so the 413 still lands. */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    let over = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (over) return;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

function parseTier(v: string | undefined): ProtectionTier {
  return v === "tight" || v === "balanced" || v === "wide" ? v : DEFAULT_CROSS_CONFIG.defaultTier;
}

/**
 * Other regulated exchanges' books for the same game, read beside the two hedge books so every
 * open records what a hedge there would have cost (REFERENCE_BOOK_* in the env; unset, none are
 * read). Price reference only: they never pick the route or change the quote.
 */
const referenceBooks = referenceSourcesFromEnv(process.env);
/**
 * An exchange that publishes only yesterday's tape (REFERENCE_PRINTS_HOST; unset, none is read):
 * the opposing side's last print there is kept beside the price the live hedge paid. Never priced
 * as a route, never touches the quote.
 */
const referencePrints = referencePrintSourcesFromEnv(process.env);
/**
 * The aggregator's cross-venue feed as the first source of the books every sports quote is priced
 * from (AGGREGATOR_KEY_ID + AGGREGATOR_PRIVATE_KEY_HEX; unset, the venues are read directly as
 * before). The mapping must agree with ours before a book is trusted; anything it cannot supply
 * falls back to the direct read, pair by pair, so a partner outage never becomes a refusal.
 */
const aggregatorBooks = aggregatorBookSourceFromEnv(process.env);
// one line in the service log at boot, so a deploy's pricing source is visible without the operator token
console.log(
  aggregatorBooks.source
    ? `[pricing-source] aggregator feed first (${aggregatorBooks.source.status().host}; key …${aggregatorBooks.source.status().keyIdTail}, public key ${aggregatorBooks.source.status().publicKeyHex}); venues read directly behind it`
    : `[pricing-source] venues read directly (aggregator key not set${aggregatorBooks.notes.length ? `: ${aggregatorBooks.notes.join("; ")}` : ""})`,
);

/** The operator's view of the pricing source: configured or not, counters, never the key. */
export function pricingSourceStatus(): { aggregator: AggregatorBookStatus | { configured: false }; notes: string[] } {
  return { aggregator: aggregatorBooks.source ? aggregatorBooks.source.status() : { configured: false }, notes: aggregatorBooks.notes };
}

/**
 * What each configured reference venue lists for one of our leagues, as its catalog answers
 * (venueBooks.ts, signedCatalogProbe): the operator's diagnostic behind a run of "not listed".
 * Venues whose dialect has no catalog to ask are named with no queries. Never throws.
 */
export async function referenceCatalog(league: string): Promise<{ league: string; configured: string[]; notes: string[]; probes: ReferenceCatalogProbe[] }> {
  const probes = await Promise.all(
    referenceBooks.sources.map(async (s): Promise<ReferenceCatalogProbe> => {
      if (!s.catalog) return { id: s.id, league, queries: [] };
      try {
        return await s.catalog(league);
      } catch (err) {
        return { id: s.id, league, queries: [{ query: "", count: null, winners: null, ourClubs: null, error: String(err instanceof Error ? err.message : err).slice(0, 160), leaguesSeen: {}, sample: [] }] };
      }
    }),
  );
  return { league, configured: referenceBooks.sources.map((s) => s.id), notes: referenceBooks.notes, probes };
}

/** The aggregator source itself, for the shadow worker's held books (its lookup and its key stay inside it); null when the key is not set. */
export function aggregatorSource(): AggregatorBookSource | null {
  return aggregatorBooks.source;
}

export function searchConfig(): CrossSearchConfig {
  const minTake = process.env.EVENT_X_MIN_TAKE_BPS;
  return {
    ...DEFAULT_CROSS_CONFIG,
    takeBps: Number(process.env.EVENT_X_TAKE_BPS || DEFAULT_CROSS_CONFIG.takeBps),
    minTakeBpsOfStake:
      minTake !== undefined && minTake !== "" ? Math.max(0, Number(minTake)) : DEFAULT_CROSS_CONFIG.minTakeBpsOfStake,
    defaultTier: parseTier(process.env.EVENT_X_DEFAULT_TIER),
  };
}

/** One scanner-board row: a live-quoted protection on one event. */
export interface BoardRow {
  kind: "sports" | "crypto";
  league: string;
  kalshiTicker: string;
  kalshiSide: string;
  /** full display name of the protected side */
  sideName: string;
  eventTitle: string;
  /** when protection locks: game start (sports) or market close (crypto), ISO */
  eventTimeIso: string;
  markCents: number;
  /** the simulated position behind the row: size and the real print it was entered at */
  contracts: number;
  entryCents: number;
  floorCents: number;
  capCents: number;
  creditCents: number;
  /** what the holder keeps at worst: floor × contracts + credit, in cents */
  floorTotalCents: number;
  /** cost of the protection in bps of the naked position's EV (negative = protection beats naked) */
  evCostBps: number;
  /** which hedge route won this event's quote */
  route: HedgeRoute;
  /** which protection tier the row's terms are (the default tier) */
  tier: ProtectionTier;
  /** how many distinct tiers the venues funded for this event */
  tierCount: number;
}

export interface CrossShowcasePayload {
  ok: boolean;
  at: string;
  pair: {
    kind: "sports" | "crypto";
    league: string;
    kalshiTicker: string;
    kalshiTitle: string;
    kalshiSide: string;
    /** full display name of the protected side */
    sideName: string;
    /** the other side of the event (sports opponent); null when not applicable */
    opponent: string | null;
    eventTitle: string;
    /** when protection locks: game start (sports) or market close (crypto), ISO */
    eventTimeIso: string;
    parityNote: string;
    yesBidCents: number;
    yesAskCents: number;
    markCents: number;
    /** cross-venue pairing details; null for self-hedge-only events */
    pmEventSlug: string | null;
    pmYesPriceMilli: number;
  } | null;
  position: {
    contracts: number;
    entryCents: number;
    entrySource: string;
    entryTime: string | null;
  } | null;
  quote: CrossQuoteResult | null;
  /** which hedge route funded the showcased quote (null on refusals) */
  route: HedgeRoute | null;
  /** every route examined for the showcased event */
  routesChecked: RouteCheck[];
  /** true EV cost of the showcased quote, bps (null on refusals) */
  evCostBps: number | null;
  /** every quotable event, ranked by what the protection really costs */
  board: BoardRow[];
  error?: string;
}

/** Verified pairings are stable for a game; cache them to spare the Gamma API. */
const pairCache = new Map<string, MatchedPair | null>();

/**
 * The window a game can be locked in: from seven days out until 45 minutes before kickoff. One
 * rule for the board, the quote, and the list the extension marks games from; the extension never
 * works it out from the venue's page.
 */
export const PROTECT_WINDOW_MINUTES = { min: 45, max: 7 * 24 * 60 } as const;
export type ProtectWindowWhy = "in_progress" | "too_close" | "far_out";
export function protectWindow(startIso: string, now: Date): { open: boolean; why?: ProtectWindowWhy; untilIso: string } {
  const startMs = new Date(startIso).getTime();
  const untilIso = new Date(startMs - PROTECT_WINDOW_MINUTES.min * 60_000).toISOString();
  const minutes = (startMs - now.getTime()) / 60_000;
  if (minutes <= 0) return { open: false, why: "in_progress", untilIso };
  if (minutes < PROTECT_WINDOW_MINUTES.min) return { open: false, why: "too_close", untilIso };
  if (minutes > PROTECT_WINDOW_MINUTES.max) return { open: false, why: "far_out", untilIso };
  return { open: true, untilIso };
}

function showcaseWindowOk(pair: MatchedPair, now: Date): boolean {
  return protectWindow(pair.gameStartTime, now).open;
}

/**
 * Cheap horizon pre-filter from the game date in the Kalshi ticker: a league
 * that plays weekly lists next week's slate too, and those games would burn
 * match attempts only to fail the showcase window afterwards. Unparseable
 * tickers pass through (the matcher decides). One day of slack covers ET vs
 * UTC and the 7-day edge.
 */
export function gameDateWithinHorizon(
  ticker: string,
  template: (typeof LEAGUE_TEMPLATES)[number],
  now: Date,
  horizonDays = 7,
): boolean {
  const parsed = parseGameTicker(ticker, template);
  if (!parsed) return true;
  const gameMs = Date.parse(`${parsed.dateIso}T00:00:00Z`);
  if (!Number.isFinite(gameMs)) return true;
  const days = (gameMs - now.getTime()) / 86_400_000;
  return days >= -1 && days <= horizonDays + 1;
}

/** Candidate ordering: quotable band first, moderately-favored side, tight spread. */
function rankCandidates(
  markets: KalshiMarket[],
  template?: (typeof LEAGUE_TEMPLATES)[number],
  now: Date = new Date(),
): Array<{ m: KalshiMarket; mark: number }> {
  return markets
    .filter((m) => m.status === "active")
    .filter((m) => !template || gameDateWithinHorizon(m.ticker, template, now))
    .map((m) => ({ m, mark: midCents(m) }))
    .filter(
      ({ m, mark }) =>
        mark >= 15 && mark <= 85 && m.yesBidCents > 0 && m.yesAskCents < 100,
    )
    .sort((a, b) => {
      const da = Math.abs(a.mark - 60);
      const db = Math.abs(b.mark - 60);
      if (da !== db) return da - db;
      const sa = a.m.yesAskCents - a.m.yesBidCents;
      const sb = b.m.yesAskCents - b.m.yesBidCents;
      if (sa !== sb) return sa - sb;
      return new Date(a.m.closeTime).getTime() - new Date(b.m.closeTime).getTime();
    });
}

/** One fully-quoted event candidate, sports or crypto, display-ready. */
export interface CandidateResult {
  kind: "sports" | "crypto";
  league: string;
  /** the protected Kalshi market with live prices */
  market: KalshiMarket;
  /** cross-venue pairing (sports only) */
  pair: MatchedPair | null;
  sideName: string;
  eventTitle: string;
  eventTimeIso: string;
  parityNote: string;
  fingerprint: string;
  markCents: number;
  position: ReturnType<typeof buildShowcasePosition>;
  quote: CrossQuoteResult;
  /** winning route (null when every route refused) */
  route: HedgeRoute | null;
  /** EV cost of the winning quote (null when every route refused) */
  evBps: number | null;
  routesChecked: RouteCheck[];
  /**
   * The live books each route was priced from, kept so the shadow run can
   * re-price the same moment under other rules or sizes (counterfactuals)
   * without another venue call. Absent when the venue was unreachable.
   */
  books: { pmNoBook?: PmBook; noAsks?: NoAskLevel[]; references?: ReferenceBook[]; prints?: ReferencePrint[] };
  /** where each route's book came from: the aggregator's feed first, the venue directly behind it (sports only) */
  bookOrigins?: BookOrigins;
  /** the aggregator's own account of what it could not supply for this pair; empty when it supplied everything */
  aggregatorNotes?: string[];
}

async function showcasePositionFor(ticker: string, markCents: number) {
  let trades: Awaited<ReturnType<typeof getRecentTrades>> = [];
  try {
    trades = await getRecentTrades(ticker);
  } catch {
    trades = [];
  }
  return buildShowcasePosition(trades, markCents, SHOWCASE_CONTRACTS);
}

/**
 * Quote one verified sports pairing on BOTH hedge routes and keep the cheaper.
 * Position from real prints; each hedge walked through its venue's live book.
 * Throws only when both venues are unreachable (counts toward the breaker);
 * a single unreachable venue becomes that route's honest refusal.
 */
async function quoteSportsCandidate(
  pair: MatchedPair,
  markCents: number,
  now: Date,
  /** a real holder's position (the lock path); absent, the showcase builds one from public prints */
  given?: ReturnType<typeof buildShowcasePosition>,
  /**
   * Pin the hedge to one route instead of taking the cheaper. The lock path pins a ticker that is
   * armed for live orders to the venue the executor can send to; the other route is still checked
   * and disclosed in routesChecked. A pinned route that refuses is the quote's refusal.
   */
  pinRoute?: HedgeRoute,
): Promise<CandidateResult> {
  const position = given ?? (await showcasePositionFor(pair.kalshi.ticker, markCents));

  // the reference read never throws: a venue that is down is one unlisted reference, not a failed quote
  const referencesP = readReferenceBooks(referenceBooks.sources, pair, now);
  const printsP = readReferencePrints(referencePrints.sources, pair, now);
  // The aggregator's feed is read first (never throws); whatever it did not supply is read from
  // the venue directly, so a partner outage prices the way the record always has.
  const agg = aggregatorBooks.source ? await aggregatorBooks.source.read(pair, now) : null;
  const bookOrigins: BookOrigins | undefined = agg
    ? { polymarket: agg.pmNoBook ? "aggregator" : "direct", kalshi: agg.noAsks ? "aggregator" : "direct" }
    : undefined;
  const [pmRes, ladderRes] = await Promise.allSettled([
    agg?.pmNoBook ? Promise.resolve(agg.pmNoBook) : getPmBook(pair.pm.tokenIds[pair.pmNoOutcomeIndex]),
    agg?.noAsks ? Promise.resolve(agg.noAsks) : getNoAsks(pair.kalshi.ticker),
  ]);
  const references = [...(await referencesP), ...(agg?.references ?? [])];
  const prints = await printsP;
  if (pmRes.status === "rejected" && ladderRes.status === "rejected") {
    throw new Error("both hedge venues unreachable");
  }

  const base = {
    pair,
    markCents,
    entryCents: position.entryCents,
    contracts: position.contracts,
    now,
    config: searchConfig(),
  };
  const pmQuote: CrossQuoteResult =
    pmRes.status === "fulfilled"
      ? quoteCrossWrap({ ...base, noBook: pmRes.value })
      : {
          ok: false,
          code: "pm_book_empty",
          detail: "Polymarket's book API is unreachable from this machine right now",
        };
  const ladderQuote: CrossQuoteResult =
    ladderRes.status === "fulfilled"
      ? quoteLadderWrap({ ...base, noAsks: ladderRes.value })
      : {
          ok: false,
          code: "kalshi_book_empty",
          detail: "Kalshi's orderbook API is unreachable right now",
        };

  const bpsOf = (q: CrossQuoteResult): number | null =>
    q.ok ? evCostBps(markCents, q.floorCents, q.capCents, q.creditCents, position.contracts) : null;
  const pmBps = bpsOf(pmQuote);
  const ladderBps = bpsOf(ladderQuote);
  const routesChecked: RouteCheck[] = [
    {
      route: "polymarket",
      ok: pmQuote.ok,
      evCostBps: pmBps,
      creditCents: pmQuote.ok ? pmQuote.creditCents : null,
      ...(pmQuote.ok ? {} : { detail: pmQuote.detail }),
    },
    {
      route: "kalshi_self",
      ok: ladderQuote.ok,
      evCostBps: ladderBps,
      creditCents: ladderQuote.ok ? ladderQuote.creditCents : null,
      ...(ladderQuote.ok ? {} : { detail: ladderQuote.detail }),
    },
  ];

  // Route selection: the holder gets the cheaper protection in true EV terms.
  // Ties go to the self-hedge route (same instrument, zero basis risk).
  let route: HedgeRoute | null;
  let quote: CrossQuoteResult;
  let evBps: number | null;
  if (pinRoute) {
    const pinned = pinRoute === "kalshi_self" ? ladderQuote : pmQuote;
    route = pinned.ok ? pinRoute : null;
    quote = pinned;
    evBps = pinned.ok ? (pinRoute === "kalshi_self" ? ladderBps : pmBps) : null;
  } else if (pmQuote.ok && ladderQuote.ok) {
    const ladderWins = (ladderBps as number) <= (pmBps as number);
    route = ladderWins ? "kalshi_self" : "polymarket";
    quote = ladderWins ? ladderQuote : pmQuote;
    evBps = ladderWins ? ladderBps : pmBps;
  } else if (pmQuote.ok) {
    route = "polymarket";
    quote = pmQuote;
    evBps = pmBps;
  } else if (ladderQuote.ok) {
    route = "kalshi_self";
    quote = ladderQuote;
    evBps = ladderBps;
  } else {
    route = null;
    evBps = null;
    // Show the more informative refusal: a real pricing refusal beats an
    // unreachable-venue placeholder.
    quote =
      pmQuote.code === "pm_book_empty" && ladderQuote.code !== "kalshi_book_empty"
        ? ladderQuote
        : pmQuote;
  }

  return {
    kind: "sports",
    league: pair.league,
    market: pair.kalshi,
    pair,
    sideName: pair.pm.outcomes[pair.pmYesOutcomeIndex] ?? pair.kalshi.subtitle,
    eventTitle: pair.pm.eventTitle,
    eventTimeIso: pair.gameStartTime,
    parityNote: pair.parityNote,
    fingerprint: pair.fingerprint,
    markCents,
    position,
    quote,
    route,
    evBps,
    routesChecked,
    books: {
      ...(pmRes.status === "fulfilled" ? { pmNoBook: pmRes.value } : {}),
      ...(ladderRes.status === "fulfilled" ? { noAsks: ladderRes.value } : {}),
      ...(references.length > 0 ? { references } : {}),
      ...(prints.length > 0 ? { prints } : {}),
    },
    ...(bookOrigins ? { bookOrigins } : {}),
    ...(agg ? { aggregatorNotes: agg.notes } : {}),
  };
}

/**
 * Quote one crypto strike market on its only structurally safe route: the
 * market's own No side. The cross-venue route is disclosed as not offered
 * (different settlement feeds across venues), never silently skipped.
 */
async function quoteCryptoCandidate(series: string, sel: ShowcaseSelection, now: Date): Promise<CandidateResult> {
  const m = sel.market;
  const markCents = sel.markCents;
  const position = await showcasePositionFor(m.ticker, markCents);
  const noAsks = await getNoAsks(m.ticker); // unreachable venue throws -> breaker

  const ladderQuote = quoteLadderWrap({
    pair: { kalshi: { ticker: m.ticker }, gameStartTime: m.closeTime },
    markCents,
    entryCents: position.entryCents,
    contracts: position.contracts,
    now,
    noAsks,
    config: searchConfig(),
  });
  const evBps = ladderQuote.ok
    ? evCostBps(markCents, ladderQuote.floorCents, ladderQuote.capCents, ladderQuote.creditCents, position.contracts)
    : null;
  const routesChecked: RouteCheck[] = [
    {
      route: "polymarket",
      ok: false,
      evCostBps: null,
      creditCents: null,
      detail: CRYPTO_PM_NOT_OFFERED,
    },
    {
      route: "kalshi_self",
      ok: ladderQuote.ok,
      evCostBps: evBps,
      creditCents: ladderQuote.ok ? ladderQuote.creditCents : null,
      ...(ladderQuote.ok ? {} : { detail: ladderQuote.detail }),
    },
  ];

  const asset = CRYPTO_ASSET_NAMES[series] ?? series;
  return {
    kind: "crypto",
    league: "crypto",
    market: m,
    pair: null,
    sideName: `${asset} ${m.subtitle}`,
    eventTitle: m.title.replace(/\?$/, ""),
    eventTimeIso: m.closeTime,
    parityNote: CRYPTO_PARITY_NOTE,
    fingerprint: `crypto:${m.ticker}`,
    markCents,
    position,
    quote: ladderQuote,
    route: ladderQuote.ok ? "kalshi_self" : null,
    evBps,
    routesChecked,
    books: { noAsks },
  };
}

/**
 * Apply the EV-cost ceiling to a quoted candidate. The routes examined keep their real verdicts
 * (operator information: the collar was fundable, just rich); the holder-facing quote becomes an
 * honest refusal with a code of its own so the receipts count it as a ceiling, not as no depth.
 */
export function applyEvCeiling(result: CandidateResult, maxEvBps: number = MAX_EV_COST_BPS): CandidateResult {
  if (maxEvBps <= 0 || !result.quote.ok || result.evBps === null || result.evBps <= maxEvBps) return result;
  return {
    ...result,
    quote: {
      ok: false,
      code: "protection_too_rich",
      detail: `the cheapest route costs ${(result.evBps / 100).toFixed(2)}% of expected value; the ceiling is ${(maxEvBps / 100).toFixed(2)}%`,
    },
    route: null,
    evBps: null,
  };
}

/**
 * Apply the minimum-credit rule to a quoted candidate: tiers under the line drop, a clearing tier
 * is promoted when the default is under it (and the EV cost follows the promoted terms), and a
 * quote with nothing clearing becomes a `credit_too_small` refusal. Runs BEFORE the ceiling so a
 * promoted tier is still judged on cost.
 */
export function applyMinimumCreditRule(result: CandidateResult, rule = MIN_CREDIT_RULE): CandidateResult {
  if (!result.quote.ok) return result;
  const quote = applyMinimumCredit(result.quote, rule);
  if (!quote.ok) return { ...result, quote, route: null, evBps: null };
  if (quote === result.quote) return result;
  return {
    ...result,
    quote,
    evBps: evCostBps(result.markCents, quote.floorCents, quote.capCents, quote.creditCents, result.position.contracts),
  };
}

/**
 * Apply the far-out guard: a cross-venue quote on a game days away, with the market's own No side
 * unable to fund it and no feed book behind the second venue, becomes a `far_out_no_book` refusal.
 * The routes examined keep their verdicts (operator information); the holder-facing quote says
 * protection opens nearer the start.
 */
export function applyFarOutGuard(result: CandidateResult, now: Date, rule: FarOutGuardRule = FAR_OUT_GUARD): CandidateResult {
  if (!result.quote.ok) return result;
  const verdict = farOutVerdict(
    {
      kind: result.kind,
      route: result.route,
      eventTimeIso: result.eventTimeIso,
      nowMs: now.getTime(),
      kalshiRouteOk: result.routesChecked.some((r) => r.route === "kalshi_self" && r.ok),
      feedSuppliedPmBook: result.bookOrigins?.polymarket === "aggregator",
    },
    rule,
  );
  if (!verdict.defer) return result;
  return { ...result, quote: { ok: false, code: verdict.code, detail: verdict.detail }, route: null, evBps: null };
}

/** The scan's post-quote pipeline, in order: minimum credit, the EV-cost ceiling, then the far-out guard. */
export function applyQuoteRules(result: CandidateResult, now: Date = new Date()): CandidateResult {
  return applyFarOutGuard(applyEvCeiling(applyMinimumCreditRule(result)), now);
}

/** One refresh's full result: ranked quotable rows plus the best honest refusal. */
export interface ScanState {
  atIso: string;
  /** quotable candidates, cheapest true insurance cost first */
  rows: Array<{ res: CandidateResult; evBps: number }>;
  fallback: CandidateResult | null;
  fetchFailures: number;
}

/**
 * Per-league row budget. The board is shared by every league that has games
 * on: split the cap evenly (rounding up) so an in-season league with a game
 * every day cannot starve the others. Leagues with nothing listed do not
 * consume a share. A top-up pass afterwards fills any rows a league left
 * unused, so the board is never shorter than it has to be.
 */
export function leagueRowQuota(activeLeagues: number, maxRows: number): number {
  if (activeLeagues <= 0) return 0;
  return Math.max(1, Math.ceil(maxRows / activeLeagues));
}

/** Per-league scanner cursor: the ranked candidates and how far we have walked them. */
interface LeagueCursor {
  template: (typeof LEAGUE_TEMPLATES)[number];
  ranked: Array<{ m: KalshiMarket; mark: number }>;
  next: number;
  attempts: number;
  rows: number;
}

/**
 * Scan options. `skipTickers` is the shadow's: markets it already holds are stepped over without
 * spending a match attempt, so successive scans walk down each league's ranking and the record
 * reaches every quotable game in the window instead of re-quoting the same top few all week.
 * The demo board passes nothing and is unchanged.
 */
export interface ScanOptions {
  skipTickers?: ReadonlySet<string>;
}

/** Index of the first ranked candidate from `from` that is not held; `ranked.length` when none is. */
export function nextUnheld(ranked: ReadonlyArray<{ m: { ticker: string } }>, from: number, held: ReadonlySet<string>): number {
  let i = from;
  while (i < ranked.length && held.has(ranked[i].m.ticker)) i += 1;
  return i;
}

async function buildScan(opts: ScanOptions = {}): Promise<ScanState> {
  const now = new Date();
  const skip = opts.skipTickers ?? new Set<string>();

  // The scanner: walk the whitelisted leagues and their ranked games, quote
  // EVERY verified pairing on both routes (up to the board cap), then admit
  // the best crypto strike markets on the self-hedge route. Everything is
  // ranked together by what the protection really costs in expected-value
  // terms; the best-value row is the default showcase. When nothing funds a
  // credit, fall back to the best pairing's honest refusal. Any single fetch
  // failure skips that candidate instead of taking the service down.
  const scanned: Array<{ res: CandidateResult; evBps: number }> = [];
  let fallback: CandidateResult | null = null;
  let fetchFailures = 0;
  // Two strikes and out: fetchJsonWithRetry already retries each call, so a
  // second candidate-level failure means the venue is unreachable, not flaky.
  const FETCH_FAILURE_LIMIT = 2;
  let breakerTripped = false;
  const countFailure = (): boolean => {
    fetchFailures += 1;
    if (fetchFailures >= FETCH_FAILURE_LIMIT) breakerTripped = true;
    return breakerTripped;
  };

  // Sports leg, step 1: list every league's open markets so the row budget
  // is split only among leagues that actually have games on.
  const cursors: LeagueCursor[] = [];
  for (const template of LEAGUE_TEMPLATES) {
    if (breakerTripped) break;
    let markets: KalshiMarket[];
    try {
      markets = await getOpenMarkets(template.kalshiSeries);
    } catch {
      countFailure();
      continue;
    }
    const ranked = rankCandidates(markets, template, now);
    if (ranked.length > 0) cursors.push({ template, ranked, next: 0, attempts: 0, rows: 0 });
  }
  const quota = leagueRowQuota(cursors.length, MAX_BOARD_ROWS);

  /** Match and quote one league's next candidate; true when the cursor still has work. */
  const step = async (c: LeagueCursor): Promise<boolean> => {
    c.next = nextUnheld(c.ranked, c.next, skip);
    if (c.next >= c.ranked.length || c.attempts >= MAX_MATCH_ATTEMPTS) return false;
    const cand = c.ranked[c.next++];
    c.attempts += 1;
    let pair: MatchedPair | null;
    try {
      if (pairCache.has(cand.m.ticker)) {
        pair = pairCache.get(cand.m.ticker) ?? null;
        if (pair) pair = { ...pair, kalshi: cand.m }; // refresh live prices
      } else {
        pair = await matchKalshiMarket(cand.m, c.template);
        pairCache.set(cand.m.ticker, pair);
      }
    } catch {
      return !countFailure();
    }
    if (!pair || !showcaseWindowOk(pair, now)) return true;
    let result: CandidateResult;
    try {
      result = applyQuoteRules(await quoteSportsCandidate(pair, cand.mark, now), now);
    } catch {
      return !countFailure();
    }
    if (!fallback) fallback = result;
    if (result.quote.ok && result.evBps !== null) {
      scanned.push({ res: result, evBps: result.evBps });
      c.rows += 1;
    }
    return true;
  };

  // Step 2: round-robin across leagues up to each league's quota, then a
  // top-up round with the quota lifted so unused shares are not wasted.
  for (const cap of [quota, MAX_BOARD_ROWS]) {
    let progressed = true;
    while (progressed && !breakerTripped && scanned.length < MAX_BOARD_ROWS) {
      progressed = false;
      for (const c of cursors) {
        if (breakerTripped || scanned.length >= MAX_BOARD_ROWS) break;
        if (c.rows >= cap) continue;
        if (await step(c)) progressed = true;
      }
    }
  }

  // Crypto leg: the self-hedge route works for any Kalshi market, so the
  // board carries the best strike markets too (liquidity-ranked, capped).
  let cryptoRows = 0;
  crypto: for (const series of CRYPTO_SERIES) {
    if (breakerTripped || cryptoRows >= MAX_CRYPTO_ROWS) break;
    let markets: KalshiMarket[];
    try {
      markets = await getOpenMarkets(series);
    } catch {
      fetchFailures += 1;
      if (fetchFailures >= FETCH_FAILURE_LIMIT) break;
      continue;
    }
    const ranked = rankShowcaseCandidates(markets, now);
    let attempts = 0;
    for (const sel of ranked) {
      if (cryptoRows >= MAX_CRYPTO_ROWS) break;
      if (attempts >= MAX_MATCH_ATTEMPTS) break;
      if (skip.has(sel.market.ticker)) continue;
      attempts += 1;
      let result: CandidateResult;
      try {
        result = applyQuoteRules(await quoteCryptoCandidate(series, sel, now), now);
      } catch {
        fetchFailures += 1;
        if (fetchFailures >= FETCH_FAILURE_LIMIT) break crypto;
        continue;
      }
      if (!fallback) fallback = result;
      if (result.quote.ok && result.evBps !== null) {
        scanned.push({ res: result, evBps: result.evBps });
        cryptoRows += 1;
      }
    }
  }

  // Cheapest true insurance cost first; bigger credit breaks ties.
  scanned.sort((a, b) => {
    if (a.evBps !== b.evBps) return a.evBps - b.evBps;
    const ca = a.res.quote.ok ? a.res.quote.creditCents : 0;
    const cb = b.res.quote.ok ? b.res.quote.creditCents : 0;
    return cb - ca;
  });

  const use = scanned[0]?.res ?? fallback;
  if (use) {
    appendCrossLedger(
      {
        at: now.toISOString(),
        kind: "cross_venue_quote",
        kalshiTicker: use.market.ticker,
        pmEventSlug: use.pair?.pm.eventSlug ?? "",
        fingerprint: use.fingerprint,
        markCents: use.markCents,
        entryCents: use.position.entryCents,
        contracts: use.position.contracts,
        result: use.quote,
        ...(use.route ? { route: use.route } : {}),
        ...(use.evBps !== null ? { evCostBps: use.evBps } : {}),
        routesChecked: use.routesChecked,
      },
      LEDGER_PATH,
    );
  }

  return { atIso: now.toISOString(), rows: scanned, fallback, fetchFailures };
}

/* ------------------------------------------------------------------------------------------ */
/* ONE POSITION, ON DEMAND (the lock path)                                                      */
/*                                                                                              */
/* The board quotes the scanner's pick at the showcase size. A real holder has one game and one */
/* size. These two functions let a thin client (the browser extension over a venue's positions  */
/* page) list the games the engine can protect and quote exactly the holder's position, through */
/* the same pairing, the same books, the same rules as the board.                               */
/* ------------------------------------------------------------------------------------------ */

export interface GameMarketRow {
  ticker: string;
  league: string;
  /** the side this market pays on: the team (Kalshi's yes_sub_title) */
  sideName: string;
  title: string;
  /** the game date from the ticker, YYYY-MM-DD (ET) */
  dateIso: string | null;
  closeTimeIso: string;
  markCents: number;
  /** kickoff, from the verified pairing; null until the game is paired */
  startIso: string | null;
  /** can a position on this market be locked in right now (paired, odds in range, inside the window) */
  protectable: boolean;
  /** when the window closes: 45 minutes before kickoff; null when the kickoff is not known */
  protectableUntilIso: string | null;
  /** why not, when not */
  notProtectable?: ProtectWindowWhy | "unpaired" | "mark_out_of_range";
}

/**
 * Kickoff per market, from the pairing. A verified pairing is kept for good (pairCache); a market
 * that would not pair is asked again after a while, since the other venue lists games late.
 */
const UNPAIRED_RETRY_MS = 10 * 60_000;
const unpairedAt = new Map<string, number>();
async function kickoffFor(m: KalshiMarket, template: LeagueTemplate): Promise<string | null> {
  if (pairCache.has(m.ticker)) {
    const cached = pairCache.get(m.ticker) ?? null;
    if (cached) return cached.gameStartTime;
    const at = unpairedAt.get(m.ticker) ?? 0;
    if (Date.now() - at < UNPAIRED_RETRY_MS) return null;
    pairCache.delete(m.ticker);
  }
  const pair = await matchKalshiMarket(m, template);
  pairCache.set(m.ticker, pair);
  if (!pair) unpairedAt.set(m.ticker, Date.now());
  return pair?.gameStartTime ?? null;
}

/**
 * Open, active game markets in the horizon for the whitelisted leagues (or one league), each
 * saying whether it can be locked in right now. Public data plus the pairing; no quoting.
 */
export async function listGameMarkets(league?: string, now: Date = new Date()): Promise<GameMarketRow[]> {
  const out: GameMarketRow[] = [];
  for (const template of LEAGUE_TEMPLATES) {
    if (league && template.league !== league.toLowerCase()) continue;
    const markets = (await getOpenMarkets(template.kalshiSeries)).filter((m) => m.status === "active" && gameDateWithinHorizon(m.ticker, template, now));
    const starts = await Promise.all(markets.map((m) => kickoffFor(m, template).catch(() => null)));
    markets.forEach((m, i) => {
      const startIso = starts[i];
      const markCents = midCents(m);
      const markOk = markCents >= 1 && markCents <= 99 && m.yesBidCents > 0 && m.yesAskCents < 100;
      const window = startIso ? protectWindow(startIso, now) : null;
      const notProtectable = !startIso ? "unpaired" : !markOk ? "mark_out_of_range" : window && !window.open ? window.why : undefined;
      out.push({
        ticker: m.ticker,
        league: template.league,
        sideName: m.subtitle,
        title: m.title,
        dateIso: parseGameTicker(m.ticker, template)?.dateIso ?? null,
        closeTimeIso: m.closeTime,
        markCents,
        startIso,
        protectable: !notProtectable,
        protectableUntilIso: window ? window.untilIso : null,
        ...(notProtectable ? { notProtectable } : {}),
      });
    });
  }
  return out.sort((a, b) => (a.startIso ?? a.closeTimeIso).localeCompare(b.startIso ?? b.closeTimeIso) || a.ticker.localeCompare(b.ticker));
}

export interface OneQuoteInputs {
  ticker: string;
  /** the holder's size, whole contracts */
  contracts: number;
  /** what the holder paid per contract, cents; absent, the market's mid stands in */
  entryCents?: number;
  now?: Date;
  /** hedge route to pin (see quoteSportsCandidate); absent, the cheaper route wins as on the board */
  route?: HedgeRoute;
}

export type OneQuoteResult = { ok: true; result: CandidateResult } | { ok: false; code: string; detail: string };

/**
 * Quote one game market at one size. Refuses, by name, anything the board would never carry:
 * a ticker outside the whitelisted leagues, a market that is not open, a game without a verified
 * pairing, a start outside the window. A quotable game comes back as the same CandidateResult the
 * board builds, so the record and the hedge are the same code path.
 */
export async function quoteOne(inputs: OneQuoteInputs): Promise<OneQuoteResult> {
  const now = inputs.now ?? new Date();
  const ticker = inputs.ticker.trim().toUpperCase();
  if (!Number.isInteger(inputs.contracts) || inputs.contracts < 1 || inputs.contracts > 10_000) {
    return { ok: false, code: "bad_size", detail: "contracts must be a whole number from 1 to 10,000" };
  }
  if (inputs.entryCents !== undefined && (!Number.isInteger(inputs.entryCents) || inputs.entryCents < 1 || inputs.entryCents > 99)) {
    return { ok: false, code: "bad_entry", detail: "entry must be whole cents from 1 to 99" };
  }
  const template = LEAGUE_TEMPLATES.find((t) => ticker.startsWith(`${t.kalshiSeries}-`));
  if (!template) return { ok: false, code: "not_offered", detail: "Protection isn't offered on this market." };
  const market = (await getOpenMarkets(template.kalshiSeries)).find((m) => m.ticker === ticker);
  if (!market || market.status !== "active") return { ok: false, code: "market_not_active", detail: "This market isn't open for protection right now." };
  const markCents = midCents(market);
  if (!(markCents >= 1 && markCents <= 99 && market.yesBidCents > 0 && market.yesAskCents < 100)) {
    return { ok: false, code: "mark_out_of_range", detail: "The odds are outside the range we protect." };
  }
  let pair: MatchedPair | null;
  if (pairCache.has(ticker)) {
    pair = pairCache.get(ticker) ?? null;
    if (pair) pair = { ...pair, kalshi: market };
  } else {
    pair = await matchKalshiMarket(market, template);
    pairCache.set(ticker, pair);
  }
  if (!pair) return { ok: false, code: "no_matched_market", detail: "Protection isn't offered on this event yet." };
  if (!showcaseWindowOk(pair, now)) return { ok: false, code: "market_too_close_to_start", detail: "This one starts too soon to protect." };
  const position: ReturnType<typeof buildShowcasePosition> = {
    contracts: inputs.contracts,
    entryCents: inputs.entryCents ?? markCents,
    entrySource: "entered_now",
    entryTime: null,
  };
  const result = applyQuoteRules(await quoteSportsCandidate(pair, markCents, now, position, inputs.route), now);
  return { ok: true, result };
}

/**
 * Render one scan into the payload. When `ticker` names a quotable board row,
 * that row is the showcase (tap-to-showcase); otherwise the best-value row.
 */
export function payloadFromScan(state: ScanState, ticker?: string): CrossShowcasePayload {
  const board: BoardRow[] = state.rows.map((s) => {
    const q = s.res.quote as Extract<CrossQuoteResult, { ok: true }>;
    return {
      kind: s.res.kind,
      league: s.res.league,
      kalshiTicker: s.res.market.ticker,
      kalshiSide: s.res.market.subtitle,
      sideName: s.res.sideName,
      eventTitle: s.res.eventTitle,
      eventTimeIso: s.res.eventTimeIso,
      markCents: s.res.markCents,
      contracts: s.res.position.contracts,
      entryCents: s.res.position.entryCents,
      floorCents: q.floorCents,
      capCents: q.capCents,
      creditCents: q.creditCents,
      floorTotalCents: q.floorCents * s.res.position.contracts + q.creditCents,
      evCostBps: s.evBps,
      route: s.res.route ?? "polymarket",
      tier: q.tier,
      tierCount: Object.keys(q.tiers).length,
    };
  });

  const tapped = ticker ? state.rows.find((s) => s.res.market.ticker === ticker) : undefined;
  const use = tapped?.res ?? state.rows[0]?.res ?? state.fallback;
  if (!use) {
    return {
      ok: false,
      at: state.atIso,
      pair: null,
      position: null,
      quote: null,
      route: null,
      routesChecked: [],
      evCostBps: null,
      board: [],
      error: state.fetchFailures > 0
        ? "a venue is unreachable from this machine right now (Polymarket's book API is blocked on some networks; a relay via PM_CLOB_REST_BASE fixes it)"
        : "no whitelisted event is quotable right now",
    };
  }

  return {
    ok: true,
    at: state.atIso,
    pair: {
      kind: use.kind,
      league: use.league,
      kalshiTicker: use.market.ticker,
      kalshiTitle: use.market.title,
      kalshiSide: use.market.subtitle,
      sideName: use.sideName,
      opponent: use.pair
        ? use.pair.pm.outcomes[use.pair.pmNoOutcomeIndex] ?? null
        : null,
      eventTitle: use.eventTitle,
      eventTimeIso: use.eventTimeIso,
      parityNote: use.parityNote,
      yesBidCents: use.market.yesBidCents,
      yesAskCents: use.market.yesAskCents,
      markCents: use.markCents,
      pmEventSlug: use.pair?.pm.eventSlug ?? null,
      pmYesPriceMilli: use.pair
        ? use.pair.pm.outcomePricesMilli[use.pair.pmYesOutcomeIndex] ?? -1
        : -1,
    },
    position: use.position,
    quote: use.quote,
    route: use.route,
    routesChecked: use.routesChecked,
    evCostBps: use.evBps,
    board,
  };
}

let cache: { at: number; state: ScanState } | null = null;
const CACHE_TTL_MS = 10_000;
/**
 * KEEP WARM: the scan is refreshed on a timer whether or not anyone is looking, so a visitor
 * arriving after a quiet hour reads books at most a minute old, instantly. A scan takes ten to
 * fifteen seconds of venue round-trips; making the first visitor wait for one (the previous
 * approach) left the page blank for that long, which on a demo reads as broken. The timer is the
 * fix; the stale ceiling below is only the backstop for a timer whose scans keep failing.
 */
const KEEP_WARM_MS = Number(process.env.EVENT_X_KEEP_WARM_MS || 60_000);
/**
 * Backstop: past this age the last scan is not served as is; the request waits for the refresh
 * it started, up to STALE_WAIT_MS, then takes whatever is current. With the keep-warm timer on,
 * a scan this old means the timer's scans have been failing for minutes, so the ceiling sits
 * well above the timer (five minutes) and is not met in normal running.
 */
const STALE_MAX_MS = Number(process.env.EVENT_X_STALE_MAX_MS || 5 * 60_000);
const STALE_WAIT_MS = Number(process.env.EVENT_X_STALE_WAIT_MS || 20_000);

export type CacheServeDecision = "serve" | "refresh_and_serve" | "refresh_and_wait";

/** What a request does with a cached scan of this age; pure, so the thresholds can be tested. */
export function cacheServeDecision(ageMs: number, limits: { ttlMs: number; staleMaxMs: number } = { ttlMs: CACHE_TTL_MS, staleMaxMs: STALE_MAX_MS }): CacheServeDecision {
  if (ageMs < limits.ttlMs) return "serve";
  if (ageMs < limits.staleMaxMs) return "refresh_and_serve";
  return "refresh_and_wait";
}

/** Test seam: serve this scan as the current one (no venue round-trips). */
export function primeScanForTests(state: ScanState): void {
  if (process.env.NODE_ENV !== "test") throw new Error("primeScanForTests is test-only");
  cache = { at: Date.now(), state };
}
let refreshing: Promise<void> | null = null;

// Deploy warm-gate: report unhealthy until the prewarm scan lands so the host
// keeps routing traffic to the old instance during a swap. The grace cap keeps
// a venue outage from ever blocking a deploy (after it, we boot cold exactly as
// before). Once warm, health never flips red again; SWR absorbs later failures.
const BOOT_AT = Date.now();
const WARM_GRACE_MS = 60_000;

function healthReady(): { ready: boolean; warm: boolean } {
  const warm = cache !== null;
  return { ready: warm || Date.now() - BOOT_AT >= WARM_GRACE_MS, warm };
}

function refreshInBackground(): void {
  if (refreshing) return;
  refreshing = buildScan()
    .then((state) => {
      cache = { at: Date.now(), state };
    })
    .catch(() => {
      /* keep serving the last good scan; next poll retries */
    })
    .finally(() => {
      refreshing = null;
    });
}

/**
 * Stale-while-revalidate, kept warm: visitors get an instant answer from the last good scan,
 * which the keep-warm timer holds under a minute old whether or not anyone is looking; a request
 * past the TTL also starts a refresh behind itself. Only past the stale ceiling (the timer's scans
 * failing for minutes) does a request wait, up to STALE_WAIT_MS, for the refresh it started. The
 * very first request after boot (cold cache) waits for the venue round-trips; prewarming at
 * startup usually removes even that.
 */
async function getCachedScan(): Promise<ScanState> {
  if (cache) {
    const decision = cacheServeDecision(Date.now() - cache.at);
    if (decision !== "serve") refreshInBackground();
    if (decision === "refresh_and_wait" && refreshing) {
      await Promise.race([refreshing, new Promise<void>((resolve) => setTimeout(resolve, STALE_WAIT_MS).unref())]);
    }
    return cache.state;
  }
  const state = await buildScan();
  cache = { at: Date.now(), state };
  return state;
}

/** Back-compat with tests and callers that want the default payload directly. */
async function buildPayload(): Promise<CrossShowcasePayload> {
  return payloadFromScan(await buildScan());
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/**
 * The server's own view of a board row, for attributing a Protect tap. Null
 * once it rolls off. `tier` names which of the row's tiers the holder locked;
 * an unknown or missing tier attributes the row's default terms.
 */
export function protectContextFor(ticker: string | null, tier: unknown, state: ScanState | null): ProtectContext | null {
  if (!ticker || !state) return null;
  const row = state.rows.find((s) => s.res.market.ticker === ticker);
  if (!row || !row.res.quote.ok) return null;
  const q = row.res.quote;
  const wanted = typeof tier === "string" ? (q.tiers[tier as ProtectionTier] ? (tier as ProtectionTier) : null) : null;
  const terms: CollarTerms = (wanted && q.tiers[wanted]) || q;
  const contracts = row.res.position.contracts;
  return {
    league: row.res.league,
    kind: row.res.kind,
    route: row.res.route,
    tier: wanted ?? q.tier,
    creditCents: terms.creditCents,
    contracts,
    markCents: row.res.markCents,
    floorCents: terms.floorCents,
    capCents: terms.capCents,
    evCostBps: wanted ? terms.evCostBps : row.evBps,
  };
}

/**
 * Beacon from the page: {sid, action, ticker?, tier?}. Anything else in the
 * body is ignored; the financial facts about the row come from our own scan
 * (the tier only selects which of the row's own tiers to attribute). Always
 * answers 204 on accepted input so the page never has to care.
 */
async function handleMetrics(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!metricsLimiter.allow(clientIp(req), Date.now())) {
    sendJson(res, 429, { ok: false, error: "rate_limited" });
    return;
  }
  const raw = await readBody(req, METRICS_BODY_LIMIT);
  if (raw === null) {
    sendJson(res, 413, { ok: false, error: "body_too_large" });
    return;
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { ok: false, error: "bad_json" });
    return;
  }
  if (!isEventAction(body.action)) {
    sendJson(res, 400, { ok: false, error: "bad_action" });
    return;
  }
  const ticker = typeof body.ticker === "string" ? body.ticker : null;
  const ctx = body.action === "protect_on" ? protectContextFor(ticker, body.tier, cache?.state ?? null) : null;
  const ok = recordAction(funnelState, { sid: body.sid, action: body.action, ticker }, Date.now(), ctx);
  if (!ok) {
    sendJson(res, 400, { ok: false, error: "bad_input" });
    return;
  }
  funnelDirty = true;
  res.writeHead(204, { "cache-control": "no-store" });
  res.end();
}

/** An integer cents query value inside [lo, hi], or null. */
function centsParam(url: URL, key: string, lo: number, hi: number): number | null {
  const raw = url.searchParams.get(key);
  if (raw === null || !/^-?\d{1,9}$/.test(raw)) return null;
  const v = Number(raw);
  return v >= lo && v <= hi ? v : null;
}

/**
 * GET /api/close-quote?ticker=&floor=&cap=&credit= — what leaving a protected position pays
 * RIGHT NOW. Terms locked at the tap come from the page (validated, never re-derived: the lock
 * is the point); size and route come from the live scan, so the page cannot invent a position.
 * Both legs are sold into the live bids that second: the user's contracts on the protected
 * market, our other side on its venue. Retail JSON carries what the card shows; the full
 * leg-by-leg quote answers to the operator token.
 */
async function handleCloseQuote(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!closeQuoteLimiter.allow(clientIp(req), Date.now())) {
    sendJson(res, 429, { ok: false, error: "rate_limited" });
    return;
  }
  const ticker = url.searchParams.get("ticker") || "";
  const state = await getCachedScan();
  const row = state.rows.find((s) => s.res.market.ticker === ticker);
  if (!row || !row.res.quote.ok) {
    sendJson(res, 404, { ok: false, error: "not_on_board", message: "This position is not on the board right now." });
    return;
  }
  const n = row.res.position.contracts;
  const floorCents = centsParam(url, "floor", 1, 99);
  const capCents = centsParam(url, "cap", 1, 99);
  const creditCents = centsParam(url, "credit", 0, 100 * n);
  if (floorCents === null || capCents === null || creditCents === null || floorCents >= capCents) {
    sendJson(res, 400, { ok: false, error: "bad_terms", message: "floor, cap and credit must be the locked terms, in cents." });
    return;
  }
  const route = row.res.route ?? "kalshi_self";
  const books: EarlyCloseBooks = { kalshi: await getKalshiBookSides(ticker) };
  if (route === "polymarket" && row.res.pair) {
    try {
      books.pmNoBook = await getPmBook(row.res.pair.pm.tokenIds[row.res.pair.pmNoOutcomeIndex]);
    } catch {
      // unreachable hedge venue: the pricer refuses the leg honestly
    }
  }
  const q = quoteEarlyClose(
    {
      contracts: n,
      floorCents,
      capCents,
      creditCents,
      takeCents: 0,
      // the sizing rule, exact in milli: (floor + 100 - cap) x N / 100 units
      hedgeUnitsMilli: (floorCents + 100 - capCents) * n * 10,
      route,
    },
    books,
  );
  const at = new Date().toISOString();
  const operator = adminAuthorized(adminAuth, req.headers, url.searchParams.get("token"));
  if (!q.ok) {
    sendJson(res, 200, {
      ok: false,
      at,
      ticker,
      error: "no_depth",
      message: "The books cannot absorb this exit right now. Your terms stay locked and settle at the lock as quoted.",
      ...(operator ? { refusal: q } : {}),
    });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    at,
    ticker,
    contracts: n,
    floorCents,
    capCents,
    creditCents,
    /** what the user leaves with, the credit already paid included */
    leaveWithCents: q.protectedAtCloseCents,
    /** the same sale with no protection ever bought */
    withoutProtectionCents: q.nakedAtCloseCents,
    midCents: q.yesMidCents,
    fillCents: q.yesFillCents,
    feesCents: q.positionFeesCents + q.hedgeFeesCents,
    /** the frictionless number at the mid, and what crossing the books cost against it */
    atMidCents: q.protectedAtMidCents,
    costVsMidCents: q.unwindFrictionCents,
    ...(operator ? { legs: q, route } : {}),
  });
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/healthz") {
      const h = healthReady();
      // brandRecordLinks says where a branded shell's record link goes: "slate" when
      // EVENT_SHADOW_SLATE_KEY is set (the same value as the shadow service), else the
      // full public record. A boolean about configuration, never the value.
      sendJson(res, h.ready ? 200 : 503, { ok: h.ready, warm: h.warm, service: "event-protect-cross-venue-demo", brandRecordLinks: SLATE_KEY?.trim() ? "slate" : "full record" });
      return;
    }
    if (serveMedia(req, res, url.pathname, MEDIA_DIR)) return;
    if (url.pathname === "/contact.vcf" && CARD_CONTACT) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD" });
        res.end();
        return;
      }
      const body = renderVCard(CARD_CONTACT);
      res.writeHead(200, {
        "content-type": "text/vcard; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "content-disposition": `attachment; filename="${vcardFilename(CARD_CONTACT)}"`,
        "cache-control": "public, max-age=3600",
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    if (url.pathname === "/api/showcase") {
      const ticker = url.searchParams.get("ticker") || undefined;
      const full = payloadFromScan(await getCachedScan(), ticker);
      // Retail first: the holder's JSON carries exactly what the card shows (event, position,
      // floor/cap/credit per tier, a retail refusal sentence). The hedge leg, our take, the
      // pairing, the routes examined and raw refusal detail answer only to the operator token.
      const operator = adminAuthorized(adminAuth, req.headers, url.searchParams.get("token"));
      // the operator also sees where the books came from (the aggregator's feed or the venues), never the key
      sendJson(res, 200, operator ? { ...full, pricingSource: pricingSourceStatus() } : retailCrossPayload(full));
      return;
    }
    if (url.pathname === "/api/metrics" && req.method === "POST") {
      await handleMetrics(req, res);
      return;
    }
    if (url.pathname === "/api/close-quote") {
      await handleCloseQuote(req, res, url);
      return;
    }
    if (url.pathname === "/api/parlays") {
      const body = await fetchParlays(Date.now());
      if (body === null) {
        sendJson(res, 503, { ok: false, error: "Parlays are unavailable right now." });
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    if (url.pathname === "/api/activity") {
      const body = await fetchActivity(Date.now());
      if (body === null) {
        sendJson(res, 503, { ok: false, error: "Activity is unavailable right now." });
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    // EMBED IS THE FRONT DOOR: the first screen is the layer inside a partner's app. The board moved to /board.
    if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/embed") {
      recordPageLoad(funnelState, "embed", Date.now());
      funnelDirty = true;
      const brand = resolveBrand(url.searchParams.get("brand"), BRAND_ALLOWLIST, EMBED_BRAND);
      const record = brandRecordUrl(TRACK_RECORD_URL, brand, SLATE_KEY, EMBED_BRAND);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(
        renderEventEmbedHtml({
          brand,
          minCredit: MIN_CREDIT_RULE,
          trackRecordUrl: record.url,
          recordIsSlate: record.slate,
          liveVideo: LIVE_VIDEO,
          card: url.searchParams.get("from") === "card" ? CARD_CONTACT : null,
          // no ?skin= and the brand preset decides (DraftKings ships dark, Kalshi light)
          skin: url.searchParams.get("skin") === "dark" ? "dark" : url.searchParams.get("skin") === "light" ? "light" : null,
          // no ?kind= and the brand preset decides (a sportsbook shell hides the crypto strikes)
          sportsOnly: url.searchParams.get("kind") === "sports" ? true : url.searchParams.get("kind") === "all" ? false : null,
        }),
      );
      return;
    }
    if (url.pathname === "/partner" && req.method === "GET" && !adminAuthorized(adminAuth, req.headers, url.searchParams.get("token"))) {
      // A visitor (a partner following the pitch's link) gets the case for the console and a CTA; the console itself names our take.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      const ctaBrand = resolveBrand(url.searchParams.get("brand"), BRAND_ALLOWLIST, EMBED_BRAND);
      res.end(
        renderPartnerCtaHtml({
          brand: ctaBrand,
          contactEmail: CONTACT_EMAIL,
          trackRecordUrl: brandRecordUrl(TRACK_RECORD_URL, ctaBrand, SLATE_KEY, EMBED_BRAND).url,
        }),
      );
      return;
    }
    if (url.pathname.startsWith("/api/admin/") || url.pathname === "/admin/funnel" || url.pathname === "/partner") {
      if (!adminAuthorized(adminAuth, req.headers, url.searchParams.get("token"))) {
        sendJson(res, 403, {
          ok: false,
          error: "admin_required",
          message: adminAuth.enabled ? "bad admin token" : "admin surfaces disabled — set EVENT_X_ADMIN_TOKEN",
        });
        return;
      }
      if (url.pathname === "/partner" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(
          renderPartnerHtml({
            atIso: new Date().toISOString(),
            brand: resolveBrand(url.searchParams.get("brand"), BRAND_ALLOWLIST, EMBED_BRAND),
            ledger: summarizeCrossLedger(LEDGER_PATH),
            funnel: eventFunnelSummary(funnelState, Date.now()),
            sharePct: PARTNER_SHARE_PCT,
            maxEvCostBps: MAX_EV_COST_BPS,
          }),
        );
        return;
      }
      if (url.pathname === "/admin/funnel" && req.method === "GET") {
        const nowIso = new Date().toISOString();
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(
          renderFunnelHtml(eventFunnelSummary(funnelState, Date.now()), {
            atIso: nowIso,
            funnelPath: FUNNEL_PATH,
            token: url.searchParams.get("token"),
          }),
        );
        return;
      }
      if (url.pathname === "/api/admin/funnel" && req.method === "GET") {
        // Pretty-printed: operators read this in a browser tab.
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(
          JSON.stringify(
            {
              ok: true,
              at: new Date().toISOString(),
              service: "event-protect-cross-venue-demo",
              funnelPath: FUNNEL_PATH,
              readable: `/admin/funnel${url.search}`,
              funnel: eventFunnelSummary(funnelState, Date.now()),
            },
            null,
            2,
          ),
        );
        return;
      }
      if (url.pathname === "/api/admin/reset" && (req.method === "POST" || (req.method === "GET" && url.searchParams.get("confirm") === "reset"))) {
        // FRESH START, ARCHIVE NOT DELETE: the quote ledger (receipts, partner console) and the funnel
        // are renamed beside themselves with a UTC stamp; the next scan writes a new ledger.
        const atIso = new Date().toISOString();
        const ledger = archiveLedgerFile(LEDGER_PATH, atIso);
        flushFunnel();
        const funnel = archiveLedgerFile(FUNNEL_PATH, atIso);
        funnelState = emptyEventFunnel();
        funnelDirty = true;
        flushFunnel();
        if (cache) cache = { at: 0, state: cache.state }; // the next request re-scans and writes the first fresh receipts
        sendJson(res, 200, {
          ok: true,
          at: atIso,
          archived: [ledger, funnel].filter((a) => a.archivedTo).map((a) => ({ from: a.path, to: a.archivedTo })),
          message: "quote ledger and funnel archived; a fresh ledger starts with the next scan",
          rules: { minimumCredit: describeMinimumCredit(MIN_CREDIT_RULE), maxEvCostBps: MAX_EV_COST_BPS },
        });
        return;
      }
      if (url.pathname === "/api/admin/reset") {
        sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "POST /api/admin/reset?token=… or GET …&confirm=reset" });
        return;
      }
      if (url.pathname === "/api/admin/funnel/reset" && req.method === "POST") {
        // Counter reset for a clean measurement window; the quote ledger is untouched.
        funnelState = emptyEventFunnel();
        funnelDirty = true;
        flushFunnel();
        sendJson(res, 200, { ok: true, message: "funnel counters cleared (page loads + actions + sessions + protects)" });
        return;
      }
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }
    if (url.pathname === "/api/receipts") {
      const summary = summarizeCrossLedger(LEDGER_PATH);
      const operator = adminAuthorized(adminAuth, req.headers, url.searchParams.get("token"));
      // Retail: the track record without our take or the route split (operator information).
      const { takeKeptCents, routeSplit, ...retail } = summary;
      sendJson(res, 200, {
        ok: true,
        at: new Date().toISOString(),
        ...(operator ? { takeKeptCents, routeSplit, ...retail } : retail),
      });
      return;
    }
    if (url.pathname === "/receipts") {
      recordPageLoad(funnelState, "receipts", Date.now());
      funnelDirty = true;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderReceiptsHtml(summarizeCrossLedger(LEDGER_PATH)));
      return;
    }
    if (url.pathname === "/board") {
      recordPageLoad(funnelState, "app", Date.now());
      funnelDirty = true;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderEventXAppHtml());
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) });
  }
});

// EVENT_X_EMBED=1 lets the shadow worker import buildScan without starting this
// server. The live demo never sets it, so its boot behavior is unchanged.
if (process.env.NODE_ENV !== "test" && process.env.EVENT_X_EMBED !== "1") {
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[event-protect-x] listening on :${PORT} (protection router: games + crypto)`);
    // prewarm so the first visitor is not the one paying for venue round-trips;
    // a failed prewarm must never crash the process (retried on first request)
    getCachedScan().catch(() => {});
    // keep the scan warm on a timer; a refresh already running is left alone (refreshInBackground)
    if (KEEP_WARM_MS > 0) setInterval(refreshInBackground, KEEP_WARM_MS).unref();
    setInterval(flushFunnel, 60_000).unref();
  });
  // Best-effort flush on shutdown so a deploy does not drop the last minute of counters.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      flushFunnel();
      process.exit(0);
    });
  }
}

export { server, buildPayload, buildScan, flushFunnel };
