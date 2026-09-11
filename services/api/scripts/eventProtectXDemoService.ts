#!/usr/bin/env tsx
/**
 * EARN & PROTECT — EVENTS, CROSS-VENUE (Tier 2 demonstration service)
 *
 * A self-contained, read-only demo of one-tap protection on a Kalshi sports
 * market, hedged leg-for-leg with the SAME game listed on Polymarket: the
 * opposing outcome token pays $1 exactly when the protected side loses.
 *
 * What is real: both venues' markets and live prices, the resolution-whitelist
 * pairing, the executable hedge (walked through Polymarket's live CLOB book),
 * and every credit/refusal quoted from them.
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
import { appendCrossLedger } from "../src/eventCollar/crossVenue/crossLedger";
import type { KalshiMarket } from "../src/eventCollar/types";
import { LEAGUE_TEMPLATES } from "../src/eventCollar/crossVenue/resolutionWhitelist";
import { matchKalshiMarket } from "../src/eventCollar/crossVenue/eventMatcher";
import { getPmBook } from "../src/eventCollar/crossVenue/polymarketPublic";
import { quoteCrossWrap } from "../src/eventCollar/crossVenue/crossVenuePricer";
import {
  DEFAULT_CROSS_CONFIG,
  type CrossQuoteResult,
  type CrossSearchConfig,
  type MatchedPair,
} from "../src/eventCollar/crossVenue/types";
import { renderEventXAppHtml } from "./eventProtectXAppHtml";

const PORT = Number(process.env.EVENT_X_PORT || 8792);
const SHOWCASE_CONTRACTS = Number(process.env.EVENT_X_CONTRACTS || 150);
const LEDGER_PATH = process.env.EVENT_X_LEDGER_PATH || "/tmp/event-demo/cross-quotes.jsonl";
const MAX_MATCH_ATTEMPTS = 10;

function searchConfig(): CrossSearchConfig {
  return {
    ...DEFAULT_CROSS_CONFIG,
    takeBps: Number(process.env.EVENT_X_TAKE_BPS || DEFAULT_CROSS_CONFIG.takeBps),
  };
}

export interface CrossShowcasePayload {
  ok: boolean;
  at: string;
  pair: {
    league: string;
    kalshiTicker: string;
    kalshiTitle: string;
    kalshiSide: string;
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
  error?: string;
}

let cache: { at: number; payload: CrossShowcasePayload } | null = null;
const CACHE_TTL_MS = 10_000;
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

async function buildPayload(): Promise<CrossShowcasePayload> {
  const now = new Date();

  let matched: MatchedPair | null = null;
  let markCents = 0;
  for (const template of LEAGUE_TEMPLATES) {
    let markets: KalshiMarket[];
    try {
      markets = await getOpenMarkets(template.kalshiSeries);
    } catch {
      continue;
    }
    const ranked = rankCandidates(markets);
    let attempts = 0;
    for (const cand of ranked) {
      if (attempts >= MAX_MATCH_ATTEMPTS) break;
      attempts += 1;
      let pair: MatchedPair | null;
      if (pairCache.has(cand.m.ticker)) {
        pair = pairCache.get(cand.m.ticker) ?? null;
        if (pair) pair = { ...pair, kalshi: cand.m }; // refresh live prices
      } else {
        pair = await matchKalshiMarket(cand.m, template);
        pairCache.set(cand.m.ticker, pair);
      }
      if (pair && showcaseWindowOk(pair, now)) {
        matched = pair;
        markCents = cand.mark;
        break;
      }
    }
    if (matched) break;
  }

  if (!matched) {
    return {
      ok: false,
      at: now.toISOString(),
      pair: null,
      position: null,
      quote: null,
      error: "no whitelisted cross-venue pair is quotable right now",
    };
  }

  let trades: Awaited<ReturnType<typeof getRecentTrades>> = [];
  try {
    trades = await getRecentTrades(matched.kalshi.ticker);
  } catch {
    trades = [];
  }
  const position = buildShowcasePosition(trades, markCents, SHOWCASE_CONTRACTS);

  const noBook = await getPmBook(matched.pm.tokenIds[matched.pmNoOutcomeIndex]);
  const quote = quoteCrossWrap({
    pair: matched,
    markCents,
    entryCents: position.entryCents,
    contracts: position.contracts,
    now,
    noBook,
    config: searchConfig(),
  });

  appendCrossLedger(
    {
      at: now.toISOString(),
      kind: "cross_venue_quote",
      kalshiTicker: matched.kalshi.ticker,
      pmEventSlug: matched.pm.eventSlug,
      fingerprint: matched.fingerprint,
      markCents,
      entryCents: position.entryCents,
      contracts: position.contracts,
      result: quote,
    },
    LEDGER_PATH,
  );

  return {
    ok: true,
    at: now.toISOString(),
    pair: {
      league: matched.league,
      kalshiTicker: matched.kalshi.ticker,
      kalshiTitle: matched.kalshi.title,
      kalshiSide: matched.kalshi.subtitle,
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
      markCents,
      pmYesPriceMilli: matched.pm.outcomePricesMilli[matched.pmYesOutcomeIndex] ?? -1,
    },
    position,
    quote,
  };
}

let refreshing: Promise<void> | null = null;

function refreshInBackground(): void {
  if (refreshing) return;
  refreshing = buildPayload()
    .then((payload) => {
      cache = { at: Date.now(), payload };
    })
    .catch(() => {
      /* keep serving the last good payload; next poll retries */
    })
    .finally(() => {
      refreshing = null;
    });
}

/**
 * Stale-while-revalidate: visitors always get an instant answer from the last
 * good payload while a background refresh keeps it current. Only the very
 * first request after boot (cold cache) has to wait for the venue round-trips,
 * and prewarming at startup usually removes even that.
 */
async function getCached(): Promise<CrossShowcasePayload> {
  if (cache) {
    if (Date.now() - cache.at >= CACHE_TTL_MS) refreshInBackground();
    return cache.payload;
  }
  const payload = await buildPayload();
  cache = { at: Date.now(), payload };
  return payload;
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
      sendJson(res, 200, await getCached());
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
    console.log(`[event-protect-x] listening on :${PORT} (cross-venue tier 2)`);
    void getCached(); // prewarm so the first visitor is not the one paying for venue round-trips
  });
}

export { server, buildPayload };
