#!/usr/bin/env tsx
/**
 * EARN & PROTECT — EVENTS (demonstration service)
 *
 * A self-contained, read-only demo of one-tap protection on Kalshi crypto price
 * events, hedged leg-for-leg on live OKX listed option books.
 *
 * What is real: the Kalshi market, its live prices, the OKX option books, the
 * executable hedge legs, and every credit/refusal quoted from them.
 * What is simulated: the holder's position and the wrap lifecycle. The service
 * has no venue credentials and only calls public market-data endpoints - it is
 * structurally unable to trade, deposit, or pay.
 *
 * ISOLATION: imports only from src/eventCollar/**. Nothing here touches the
 * production Earn & Protect service, stores, or deploy.
 *
 * Run: npx tsx services/api/scripts/eventProtectDemoService.ts
 * Env: EVENT_DEMO_PORT (default 8791) · KALSHI_SERIES (default KXBTCD)
 *      EVENT_TAKE_BPS · EVENT_FEE_CENTS_PER_SPREAD · EVENT_DEMO_LEDGER_PATH
 *      OKX_REST_BASE / KALSHI_REST_BASE (relay overrides)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getOpenMarkets, getRecentTrades, midCents } from "../src/eventCollar/kalshiPublic";
import {
  bracketingPutStrikes,
  expiryToDate,
  getBtcIndexUsd,
  getBtcOptionInstruments,
  getOptionBook,
  nearestExpiryAtOrAfter,
} from "../src/eventCollar/okxOptionsPublic";
import { quoteWrap } from "../src/eventCollar/eventCollarPricer";
import {
  buildShowcasePosition,
  rankShowcaseCandidates,
  type ShowcaseSelection,
} from "../src/eventCollar/showcasePicker";
import { appendLedger } from "../src/eventCollar/quoteLedger";
import { DEFAULT_SEARCH_CONFIG, type WrapQuoteResult, type WrapSearchConfig } from "../src/eventCollar/types";
import { renderEventAppHtml } from "./eventProtectAppHtml";

const PORT = Number(process.env.EVENT_DEMO_PORT || process.env.PORT || 8791);
const SERIES = process.env.KALSHI_SERIES || "KXBTCD";
const SHOWCASE_CONTRACTS = Number(process.env.EVENT_DEMO_CONTRACTS || 150);

function searchConfig(indexPxUsd: number): WrapSearchConfig {
  // OKX options taker fee: 0.03% of underlying notional per leg, two legs per
  // vertical on 0.01 BTC contracts => 0.0006 * index, in cents. Env-overridable.
  const dynamicFee = Math.ceil(0.0006 * indexPxUsd);
  return {
    ...DEFAULT_SEARCH_CONFIG,
    takeBps: Number(process.env.EVENT_TAKE_BPS || DEFAULT_SEARCH_CONFIG.takeBps),
    feeCentsPerSpread: Number(process.env.EVENT_FEE_CENTS_PER_SPREAD || dynamicFee),
  };
}

export interface ShowcasePayload {
  ok: boolean;
  at: string;
  spotUsd: number;
  market: {
    ticker: string;
    title: string;
    subtitle: string;
    strike: number;
    closeTime: string;
    yesBidCents: number;
    yesAskCents: number;
    markCents: number;
    volume: number;
  } | null;
  position: {
    contracts: number;
    entryCents: number;
    entrySource: string;
    entryTime: string | null;
  } | null;
  quote: WrapQuoteResult | null;
  hedge: { expiry: string; expiryTime: string } | null;
  error?: string;
}

let cache: { at: number; payload: ShowcasePayload } | null = null;
const CACHE_TTL_MS = 10_000;
/** How far down the ranked market list to look for one that actually quotes. */
const MAX_QUOTE_ATTEMPTS = 6;

interface CandidateResult {
  market: ShowcaseSelection["market"];
  markCents: number;
  position: ReturnType<typeof buildShowcasePosition>;
  quote: WrapQuoteResult;
  hedge: ShowcasePayload["hedge"];
}

async function quoteCandidate(
  sel: ShowcaseSelection,
  instruments: Awaited<ReturnType<typeof getBtcOptionInstruments>>,
  spotUsd: number,
  now: Date,
): Promise<CandidateResult> {
  const { market, markCents } = sel;

  let trades: Awaited<ReturnType<typeof getRecentTrades>> = [];
  try {
    trades = await getRecentTrades(market.ticker);
  } catch {
    trades = [];
  }
  const position = buildShowcasePosition(trades, markCents, SHOWCASE_CONTRACTS);

  const resolutionTime = new Date(market.closeTime);
  const expiry = nearestExpiryAtOrAfter(instruments, resolutionTime);
  let quote: WrapQuoteResult;
  let hedge: ShowcasePayload["hedge"] = null;
  if (!expiry) {
    quote = {
      ok: false,
      code: "no_matching_expiry",
      detail: "no listed option expiry at or after this market's resolution",
    };
  } else {
    const bracket = bracketingPutStrikes(instruments, expiry, market.strike);
    if (!bracket) {
      quote = {
        ok: false,
        code: "no_bracketing_strikes",
        detail: `no listed strikes bracket ${market.strike} on expiry ${expiry}`,
      };
    } else {
      const [highPut, lowPut] = await Promise.all([
        getOptionBook(bracket.highInstId),
        getOptionBook(bracket.lowInstId),
      ]);
      hedge = { expiry, expiryTime: expiryToDate(expiry).toISOString() };
      quote = quoteWrap({
        marketTicker: market.ticker,
        markCents,
        entryCents: position.entryCents,
        contracts: position.contracts,
        resolutionTime,
        now,
        indexPxUsd: spotUsd,
        vertical: {
          highPut,
          highStrike: bracket.highStrike,
          lowPut,
          lowStrike: bracket.lowStrike,
        },
        hedgeExpiry: expiry,
        hedgeExpiryTime: expiryToDate(expiry),
        config: searchConfig(spotUsd),
      });
    }
  }
  return { market, markCents, position, quote, hedge };
}

async function buildShowcasePayload(): Promise<ShowcasePayload> {
  const now = new Date();
  const [markets, instruments, spotUsd] = await Promise.all([
    getOpenMarkets(SERIES),
    getBtcOptionInstruments(),
    getBtcIndexUsd(),
  ]);

  const candidates = rankShowcaseCandidates(markets, now);
  if (candidates.length === 0) {
    return {
      ok: false,
      at: now.toISOString(),
      spotUsd,
      market: null,
      position: null,
      quote: null,
      hedge: null,
      error: "no quotable market is open right now",
    };
  }

  // Walk the ranked list: showcase the first market whose books fund a
  // positive credit. When none can, fall back to the most liquid candidate's
  // honest refusal.
  let chosen: CandidateResult | null = null;
  let fallback: CandidateResult | null = null;
  let fetchFailures = 0;
  // Two strikes and out: fetchJsonWithRetry already retries each call, so a
  // second candidate-level failure means the venue is unreachable, not flaky.
  const FETCH_FAILURE_LIMIT = 2;
  for (const sel of candidates.slice(0, MAX_QUOTE_ATTEMPTS)) {
    let result: CandidateResult;
    try {
      result = await quoteCandidate(sel, instruments, spotUsd, now);
    } catch {
      fetchFailures += 1;
      if (fetchFailures >= FETCH_FAILURE_LIMIT) break;
      continue;
    }
    if (!fallback) fallback = result;
    if (result.quote.ok) {
      chosen = result;
      break;
    }
  }
  const use = chosen ?? fallback;
  if (!use) {
    return {
      ok: false,
      at: now.toISOString(),
      spotUsd,
      market: null,
      position: null,
      quote: null,
      hedge: null,
      error: "the hedge venue is unreachable from this machine right now (OKX is blocked on some networks; a relay via OKX_REST_BASE fixes it)",
    };
  }
  const { market, markCents, position, quote, hedge } = use;

  appendLedger({
    at: now.toISOString(),
    kind: quote.ok ? "quote" : "refusal",
    marketTicker: market.ticker,
    markCents,
    contracts: position.contracts,
    result: quote,
    spotUsd,
  });

  return {
    ok: true,
    at: now.toISOString(),
    spotUsd,
    market: {
      ticker: market.ticker,
      title: market.title,
      subtitle: market.subtitle,
      strike: market.strike,
      closeTime: market.closeTime,
      yesBidCents: market.yesBidCents,
      yesAskCents: market.yesAskCents,
      markCents,
      volume: market.volume,
    },
    position,
    quote,
    hedge,
  };
}

let refreshing: Promise<void> | null = null;

function refreshInBackground(): void {
  if (refreshing) return;
  refreshing = buildShowcasePayload()
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
async function getShowcaseCached(): Promise<ShowcasePayload> {
  if (cache) {
    if (Date.now() - cache.at >= CACHE_TTL_MS) refreshInBackground();
    return cache.payload;
  }
  const payload = await buildShowcasePayload();
  cache = { at: Date.now(), payload };
  return payload;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, service: "event-protect-demo" });
      return;
    }
    if (url.pathname === "/api/showcase") {
      const payload = await getShowcaseCached();
      sendJson(res, 200, payload);
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderEventAppHtml());
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
    console.log(`[event-protect-demo] listening on :${PORT} (series ${SERIES})`);
    // prewarm so the first visitor is not the one paying for venue round-trips;
    // a failed prewarm must never crash the process (retried on first request)
    getShowcaseCached().catch(() => {});
  });
}

export { server, buildShowcasePayload };
