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
 * Run: npx tsx services/api/scripts/eventProtectXDemoService.ts
 * Env: EVENT_X_PORT (default 8792) · EVENT_X_CONTRACTS (default 150)
 *      EVENT_X_TAKE_BPS · EVENT_X_LEDGER_PATH · EVENT_X_BOARD_ROWS
 *      EVENT_X_CRYPTO_SERIES (default KXBTCD,KXETHD) · EVENT_X_CRYPTO_ROWS
 *      KALSHI_REST_BASE / PM_GAMMA_REST_BASE / PM_CLOB_REST_BASE (relay overrides)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getOpenMarkets, getRecentTrades, midCents } from "../src/eventCollar/kalshiPublic";
import {
  buildShowcasePosition,
  rankShowcaseCandidates,
  type ShowcaseSelection,
} from "../src/eventCollar/showcasePicker";
import { appendCrossLedger, summarizeCrossLedger } from "../src/eventCollar/crossVenue/crossLedger";
import type { KalshiMarket } from "../src/eventCollar/types";
import { LEAGUE_TEMPLATES } from "../src/eventCollar/crossVenue/resolutionWhitelist";
import { matchKalshiMarket } from "../src/eventCollar/crossVenue/eventMatcher";
import { getPmBook } from "../src/eventCollar/crossVenue/polymarketPublic";
import { evCostBps, quoteCrossWrap } from "../src/eventCollar/crossVenue/crossVenuePricer";
import { getNoAsks, quoteLadderWrap } from "../src/eventCollar/crossVenue/kalshiLadder";
import {
  DEFAULT_CROSS_CONFIG,
  type CrossQuoteResult,
  type CrossSearchConfig,
  type HedgeRoute,
  type MatchedPair,
  type RouteCheck,
} from "../src/eventCollar/crossVenue/types";
import { renderEventXAppHtml, renderReceiptsHtml } from "./eventProtectXAppHtml";

const PORT = Number(process.env.EVENT_X_PORT || process.env.PORT || 8792);
const SHOWCASE_CONTRACTS = Number(process.env.EVENT_X_CONTRACTS || 150);
const LEDGER_PATH = process.env.EVENT_X_LEDGER_PATH || "/tmp/event-demo/cross-quotes.jsonl";
const MAX_MATCH_ATTEMPTS = 10;
/** Scanner board caps: how many pairings get live-quoted per refresh. */
const MAX_BOARD_ROWS = Number(process.env.EVENT_X_BOARD_ROWS || 6);
const MAX_CRYPTO_ROWS = Number(process.env.EVENT_X_CRYPTO_ROWS || 2);
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

function searchConfig(): CrossSearchConfig {
  return {
    ...DEFAULT_CROSS_CONFIG,
    takeBps: Number(process.env.EVENT_X_TAKE_BPS || DEFAULT_CROSS_CONFIG.takeBps),
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
  floorCents: number;
  capCents: number;
  creditCents: number;
  /** cost of the protection in bps of the naked position's EV (negative = protection beats naked) */
  evCostBps: number;
  /** which hedge route won this event's quote */
  route: HedgeRoute;
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

function showcaseWindowOk(pair: MatchedPair, now: Date): boolean {
  const minutes = (new Date(pair.gameStartTime).getTime() - now.getTime()) / 60_000;
  return minutes >= 45 && minutes <= 7 * 24 * 60;
}

/** Candidate ordering: quotable band first, moderately-favored side, tight spread. */
function rankCandidates(markets: KalshiMarket[]): Array<{ m: KalshiMarket; mark: number }> {
  return markets
    .filter((m) => m.status === "active")
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
interface CandidateResult {
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
async function quoteSportsCandidate(pair: MatchedPair, markCents: number, now: Date): Promise<CandidateResult> {
  const position = await showcasePositionFor(pair.kalshi.ticker, markCents);

  const [pmRes, ladderRes] = await Promise.allSettled([
    getPmBook(pair.pm.tokenIds[pair.pmNoOutcomeIndex]),
    getNoAsks(pair.kalshi.ticker),
  ]);
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
  if (pmQuote.ok && ladderQuote.ok) {
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
  };
}

/** One refresh's full result: ranked quotable rows plus the best honest refusal. */
interface ScanState {
  atIso: string;
  /** quotable candidates, cheapest true insurance cost first */
  rows: Array<{ res: CandidateResult; evBps: number }>;
  fallback: CandidateResult | null;
  fetchFailures: number;
}

async function buildScan(): Promise<ScanState> {
  const now = new Date();

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

  outer: for (const template of LEAGUE_TEMPLATES) {
    let markets: KalshiMarket[];
    try {
      markets = await getOpenMarkets(template.kalshiSeries);
    } catch {
      fetchFailures += 1;
      if (fetchFailures >= FETCH_FAILURE_LIMIT) {
        breakerTripped = true;
        break;
      }
      continue;
    }
    const ranked = rankCandidates(markets);
    let attempts = 0;
    for (const cand of ranked) {
      if (scanned.length >= MAX_BOARD_ROWS) break outer;
      if (attempts >= MAX_MATCH_ATTEMPTS) break;
      attempts += 1;
      let pair: MatchedPair | null;
      try {
        if (pairCache.has(cand.m.ticker)) {
          pair = pairCache.get(cand.m.ticker) ?? null;
          if (pair) pair = { ...pair, kalshi: cand.m }; // refresh live prices
        } else {
          pair = await matchKalshiMarket(cand.m, template);
          pairCache.set(cand.m.ticker, pair);
        }
      } catch {
        fetchFailures += 1;
        if (fetchFailures >= FETCH_FAILURE_LIMIT) {
          breakerTripped = true;
          break outer;
        }
        continue;
      }
      if (!pair || !showcaseWindowOk(pair, now)) continue;
      let result: CandidateResult;
      try {
        result = await quoteSportsCandidate(pair, cand.mark, now);
      } catch {
        fetchFailures += 1;
        if (fetchFailures >= FETCH_FAILURE_LIMIT) {
          breakerTripped = true;
          break outer;
        }
        continue;
      }
      if (!fallback) fallback = result;
      if (result.quote.ok && result.evBps !== null) {
        scanned.push({ res: result, evBps: result.evBps });
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
      attempts += 1;
      let result: CandidateResult;
      try {
        result = await quoteCryptoCandidate(series, sel, now);
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
      floorCents: q.floorCents,
      capCents: q.capCents,
      creditCents: q.creditCents,
      evCostBps: s.evBps,
      route: s.res.route ?? "polymarket",
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
 * Stale-while-revalidate: visitors always get an instant answer from the last
 * good scan while a background refresh keeps it current. Only the very first
 * request after boot (cold cache) has to wait for the venue round-trips, and
 * prewarming at startup usually removes even that.
 */
async function getCachedScan(): Promise<ScanState> {
  if (cache) {
    if (Date.now() - cache.at >= CACHE_TTL_MS) refreshInBackground();
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

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/healthz") {
      const h = healthReady();
      sendJson(res, h.ready ? 200 : 503, { ok: h.ready, warm: h.warm, service: "event-protect-cross-venue-demo" });
      return;
    }
    if (url.pathname === "/api/showcase") {
      const ticker = url.searchParams.get("ticker") || undefined;
      sendJson(res, 200, payloadFromScan(await getCachedScan(), ticker));
      return;
    }
    if (url.pathname === "/api/receipts") {
      sendJson(res, 200, {
        ok: true,
        at: new Date().toISOString(),
        ...summarizeCrossLedger(LEDGER_PATH),
      });
      return;
    }
    if (url.pathname === "/receipts") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderReceiptsHtml(summarizeCrossLedger(LEDGER_PATH)));
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderEventXAppHtml());
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) });
  }
});

if (process.env.NODE_ENV !== "test") {
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[event-protect-x] listening on :${PORT} (protection router: games + crypto)`);
    // prewarm so the first visitor is not the one paying for venue round-trips;
    // a failed prewarm must never crash the process (retried on first request)
    getCachedScan().catch(() => {});
  });
}

export { server, buildPayload };
