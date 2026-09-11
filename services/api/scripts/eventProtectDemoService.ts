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
  pickShowcaseMarket,
} from "../src/eventCollar/showcasePicker";
import { appendLedger } from "../src/eventCollar/quoteLedger";
import { DEFAULT_SEARCH_CONFIG, type WrapQuoteResult, type WrapSearchConfig } from "../src/eventCollar/types";
import { renderEventAppHtml } from "./eventProtectAppHtml";

const PORT = Number(process.env.EVENT_DEMO_PORT || 8791);
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

async function buildShowcasePayload(): Promise<ShowcasePayload> {
  const now = new Date();
  const [markets, instruments, spotUsd] = await Promise.all([
    getOpenMarkets(SERIES),
    getBtcOptionInstruments(),
    getBtcIndexUsd(),
  ]);

  const picked = pickShowcaseMarket(markets, now);
  if (!picked) {
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
  const { market, markCents } = picked;

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

async function getShowcaseCached(): Promise<ShowcasePayload> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.payload;
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
  });
}

export { server, buildShowcasePayload };
