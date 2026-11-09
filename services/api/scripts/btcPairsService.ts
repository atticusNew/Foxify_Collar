#!/usr/bin/env tsx
/**
 * BTC PAIRS, standalone: the same collector and page the BTC curve service mounts at /pairs,
 * served on its own port. For a local run (a trader running it next to his own engine) or a
 * separate deploy; production serves it from atticus-btc-curve so no extra service is paid for.
 *
 * Nothing here trades: public market-data endpoints only, no credentials loaded.
 *
 * Run:  npx tsx services/api/scripts/btcPairsService.ts
 * Env:  BTC_PAIRS_PORT            (default 8880; PORT honoured)
 *       BTC_PAIRS_INTERVAL_SEC    (default 10, floor 5)
 *       BTC_PAIRS_DATA_DIR        (default /tmp/btc-pairs; gap history survives a restart)
 *       BTC_PAIRS_TOKEN           (optional; when set the page and JSON need ?k=<token>)
 *       BTC_PAIRS_WINDOW_MIN      (default 120; gap history kept this long)
 *       BTC_PAIRS_LAUNCH_URL      (optional; the engine endpoint the Launch button posts to by default)
 *       BTC_PAIRS_KALSHI_URL      (link template; {event} and {ticker} replaced, lower case;
 *                                 default https://kalshi.com/markets/kxbtcd, the series page)
 *       BTC_PAIRS_POLY_URL        (default https://polymarket.us/event/{event})
 *       POLY_US_REST_BASE / KALSHI_REST_BASE (relays)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pairsCollectorFromEnv } from "../src/btcCurve/pairsCollector";

const PORT = Number(process.env.BTC_PAIRS_PORT || process.env.PORT || 8880);
const TOKEN = process.env.BTC_PAIRS_TOKEN || "";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const collector = pairsCollectorFromEnv();
collector.start();

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/healthz") {
    return sendJson(res, 200, { ok: true, service: "btc-pairs", commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null, ...collector.health() });
  }
  if (TOKEN && url.searchParams.get("k") !== TOKEN) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  if (collector.handle(req, res, url.pathname.replace(/\/$/, "") || "/", url, { base: "", token: TOKEN || undefined })) return;
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

createServer((req, res) => {
  try {
    handle(req, res);
  } catch (err) {
    console.error(`[btc-pairs] request failed: ${(err as Error).message}`);
    if (!res.headersSent) sendJson(res, 500, { ok: false });
  }
}).listen(PORT, () => console.log(`[btc-pairs] listening on :${PORT}`));
