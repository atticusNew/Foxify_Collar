#!/usr/bin/env tsx
/**
 * EARN & PROTECT — EVENTS, CROSS-VENUE ROUTER (Tier 2 demonstration service)
 *
 * A self-contained, read-only demo of one-tap protection on a Kalshi sports
 * market. Every game is priced on TWO hedge routes and the holder gets the
 * cheaper one:
 *   - polymarket:  the SAME game listed on Polymarket; the opposing outcome
 *                  token pays $1 exactly when the protected side loses.
 *   - kalshi_self: the protected market's own No side (buy No contracts);
 *                  same instrument, same settlement, zero basis risk.
 *
 * What is real: both venues' markets and live prices, the resolution-whitelist
 * pairing, the executable hedges (walked through each venue's live book), and
 * every credit/refusal quoted from them.
 * What is simulated: the holder's position and the wrap lifecycle. No venue
 * credentials, no wallet; only public market-data endpoints - this service is
 * structurally unable to trade, deposit, or pay.
 *
 * ISOLATION: imports only from src/eventCollar/**. Nothing here touches the
 * production Earn & Protect service, stores, or deploy.
 *
 * Run: npx tsx services/api/scripts/eventProtectXDemoService.ts
 * Env: EVENT_X_PORT (default 8792) · EVENT_X_CONTRACTS (default 150)
 *      EVENT_X_TAKE_BPS · EVENT_X_LEDGER_PATH
 *      KALSHI_REST_BASE / PM_GAMMA_REST_BASE / PM_CLOB_REST_BASE (relay overrides)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getOpenMarkets, getRecentTrades, midCents } from "../src/eventCollar/kalshiPublic";
import { buildShowcasePosition } from "../src/eventCollar/showcasePicker";
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
/** Scanner board cap: how many pairings get live-quoted per refresh. */
const MAX_BOARD_ROWS = Number(process.env.EVENT_X_BOARD_ROWS || 6);

function searchConfig(): CrossSearchConfig {
  return {
    ...DEFAULT_CROSS_CONFIG,
    takeBps: Number(process.env.EVENT_X_TAKE_BPS || DEFAULT_CROSS_CONFIG.takeBps),
  };
}

/** One scanner-board row: a live-quoted protection across the venue pair. */
export interface BoardRow {
  league: string;
  kalshiTicker: string;
  kalshiSide: string;
  /** full display name of the protected side (from the venue pairing) */
  sideName: string;
  pmEventTitle: string;
  pmEventSlug: string;
  gameStartTime: string;
  markCents: number;
  floorCents: number;
  capCents: number;
  creditCents: number;
  /** cost of the protection in bps of the naked position's EV (negative = protection beats naked) */
  evCostBps: number;
  /** which hedge route won this game's quote */
  route: HedgeRoute;
}

export interface CrossShowcasePayload {
  ok: boolean;
  at: string;
  pair: {
    league: string;
    kalshiTicker: string;
    kalshiTitle: string;
    kalshiSide: string;
    /** full display name of the protected side */
    sideName: string;
    pmEventSlug: string;
    pmEventTitle: string;
    pmQuestion: string;
    pmOutcomes: string[];
    pmYesOutcome: string;
    pmNoOutcome: string;
    gameStartTime: string;
    parityNote: string;
    yesBidCents: number;
    yesAskCents: number;
    markCents: number;
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
  /** every route examined for the showcased game */
  routesChecked: RouteCheck[];
  /** true EV cost of the showcased quote, bps (null on refusals) */
  evCostBps: number | null;
  /** every quotable whitelisted game, ranked by what the protection really costs */
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

interface CandidateResult {
  pair: MatchedPair;
  markCents: number;
  position: ReturnType<typeof buildShowcasePosition>;
  quote: CrossQuoteResult;
  /** winning route (null when both routes refused) */
  route: HedgeRoute | null;
  /** EV cost of the winning quote (null when both routes refused) */
  evBps: number | null;
  routesChecked: RouteCheck[];
}

/**
 * Quote one verified pairing on BOTH hedge routes and keep the cheaper one.
 * Position from real prints; each hedge walked through its venue's live book.
 * Throws only when both venues are unreachable (counts toward the breaker);
 * a single unreachable venue becomes that route's honest refusal.
 */
async function quoteCandidate(pair: MatchedPair, markCents: number, now: Date): Promise<CandidateResult> {
  let trades: Awaited<ReturnType<typeof getRecentTrades>> = [];
  try {
    trades = await getRecentTrades(pair.kalshi.ticker);
  } catch {
    trades = [];
  }
  const position = buildShowcasePosition(trades, markCents, SHOWCASE_CONTRACTS);

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

  return { pair, markCents, position, quote, route, evBps, routesChecked };
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
  // EVERY verified pairing on both routes (up to the board cap), and rank the
  // results by what the protection really costs in expected-value terms. The
  // best-value row is the default showcase. When nothing funds a credit, fall
  // back to the best pairing's honest refusal. Any single fetch failure skips
  // that candidate instead of taking the service down.
  const scanned: Array<{ res: CandidateResult; evBps: number }> = [];
  let fallback: CandidateResult | null = null;
  let fetchFailures = 0;
  // Two strikes and out: fetchJsonWithRetry already retries each call, so a
  // second candidate-level failure means the venue is unreachable, not flaky.
  const FETCH_FAILURE_LIMIT = 2;
  outer: for (const template of LEAGUE_TEMPLATES) {
    let markets: KalshiMarket[];
    try {
      markets = await getOpenMarkets(template.kalshiSeries);
    } catch {
      fetchFailures += 1;
      if (fetchFailures >= FETCH_FAILURE_LIMIT) break;
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
        if (fetchFailures >= FETCH_FAILURE_LIMIT) break outer;
        continue;
      }
      if (!pair || !showcaseWindowOk(pair, now)) continue;
      let result: CandidateResult;
      try {
        result = await quoteCandidate(pair, cand.mark, now);
      } catch {
        fetchFailures += 1;
        if (fetchFailures >= FETCH_FAILURE_LIMIT) break outer;
        continue;
      }
      if (!fallback) fallback = result;
      if (result.quote.ok && result.evBps !== null) {
        scanned.push({ res: result, evBps: result.evBps });
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
        kalshiTicker: use.pair.kalshi.ticker,
        pmEventSlug: use.pair.pm.eventSlug,
        fingerprint: use.pair.fingerprint,
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
      league: s.res.pair.league,
      kalshiTicker: s.res.pair.kalshi.ticker,
      kalshiSide: s.res.pair.kalshi.subtitle,
      sideName: s.res.pair.pm.outcomes[s.res.pair.pmYesOutcomeIndex] ?? s.res.pair.kalshi.subtitle,
      pmEventTitle: s.res.pair.pm.eventTitle,
      pmEventSlug: s.res.pair.pm.eventSlug,
      gameStartTime: s.res.pair.gameStartTime,
      markCents: s.res.markCents,
      floorCents: q.floorCents,
      capCents: q.capCents,
      creditCents: q.creditCents,
      evCostBps: s.evBps,
      route: s.res.route ?? "polymarket",
    };
  });

  const tapped = ticker ? state.rows.find((s) => s.res.pair.kalshi.ticker === ticker) : undefined;
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
        : "no whitelisted cross-venue pair is quotable right now",
    };
  }
  const matched = use.pair;

  return {
    ok: true,
    at: state.atIso,
    pair: {
      league: matched.league,
      kalshiTicker: matched.kalshi.ticker,
      kalshiTitle: matched.kalshi.title,
      kalshiSide: matched.kalshi.subtitle,
      sideName: matched.pm.outcomes[matched.pmYesOutcomeIndex] ?? matched.kalshi.subtitle,
      pmEventSlug: matched.pm.eventSlug,
      pmEventTitle: matched.pm.eventTitle,
      pmQuestion: matched.pm.question,
      pmOutcomes: matched.pm.outcomes,
      pmYesOutcome: matched.pm.outcomes[matched.pmYesOutcomeIndex],
      pmNoOutcome: matched.pm.outcomes[matched.pmNoOutcomeIndex],
      gameStartTime: matched.gameStartTime,
      parityNote: matched.parityNote,
      yesBidCents: matched.kalshi.yesBidCents,
      yesAskCents: matched.kalshi.yesAskCents,
      markCents: use.markCents,
      pmYesPriceMilli: matched.pm.outcomePricesMilli[matched.pmYesOutcomeIndex] ?? -1,
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
      sendJson(res, 200, { ok: true, service: "event-protect-cross-venue-demo" });
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
    console.log(`[event-protect-x] listening on :${PORT} (cross-venue tier 2 router)`);
    // prewarm so the first visitor is not the one paying for venue round-trips;
    // a failed prewarm must never crash the process (retried on first request)
    getCachedScan().catch(() => {});
  });
}

export { server, buildPayload };
