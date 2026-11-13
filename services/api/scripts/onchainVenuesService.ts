#!/usr/bin/env tsx
/**
 * ON-CHAIN VENUES: one read-only page.
 *
 * The same game's winner market on Polymarket International, SX Bet and Limitless, read through
 * the aggregation partner's signed API and book stream: each venue's bid, ask, depth and fee,
 * what a holder gets for leaving on their own venue, and what a cover on the best of the three
 * would lock instead.
 *
 * Nothing here trades. It takes the partner's DATA key only (discovery and the stream). The
 * trading key must never be set on this service.
 *
 * ISOLATION: imports only src/onchainVenues/**, which in turn reads the partner's client and the
 * fee arithmetic and nothing else. It shares no key with the regulated services: the BTC curve
 * key and the Lock in keys open nothing here, and this page's key opens nothing there.
 *
 * Run:  npx tsx services/api/scripts/onchainVenuesService.ts
 * Env:  AGGREGATOR_KEY_ID, AGGREGATOR_PRIVATE_KEY_HEX   the partner's data key (unset: nothing is read)
 *       ONCHAIN_VENUES_KEY            the page's key, 16 characters or more; the page is at /?k=<key>,
 *                                     the board as JSON at /api/board?k=<key>, and how the feed was
 *                                     read, with names, at /api/diagnostics?k=<key>
 *                                     (unset or shorter: the page is off and every path but /healthz is 404;
 *                                     /healthz is open and carries counts only)
 *       ONCHAIN_VENUES_PORT           (default 8880; PORT honoured)
 *       ONCHAIN_VENUES_INTERVAL_SEC   (default 60) seconds between book reads
 *       ONCHAIN_VENUES_DISCOVER_MIN   (default 10) minutes between catalog reads
 *       ONCHAIN_VENUES_HORIZON_HOURS  (default 48) games starting within this are on the board
 *       ONCHAIN_VENUES_MAX_GAMES      (default 240) the most games on the board: games on two or more
 *                                     of the venues first, then games on one, the venues in turn,
 *                                     soonest first
 *       ONCHAIN_VENUES_READS_PER_PASS (default 150) the most games whose markets one catalog read asks for
 *       ONCHAIN_VENUES_PACE_MS        (default 400) the wait between two catalog requests; the
 *                                     partner's request budget is shared with the other services
 *       AGGREGATOR_API_HOST / AGGREGATOR_STREAM_URL   (the partner's defaults)
 *       LIMITLESS_PUBLIC_HOST         (default https://api.limitless.exchange) Limitless's own public
 *                                     list of game markets, read only when the partner refuses its
 *                                     copy of that list to the key
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { onchainServiceFromEnv } from "../src/onchainVenues/service";

const PORT = Number(process.env.ONCHAIN_VENUES_PORT || process.env.PORT || 8880);

export const service = onchainServiceFromEnv(process.env);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/healthz") {
    return sendJson(res, 200, {
      ok: true,
      service: "onchain-venues",
      commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null,
      branch: process.env.RENDER_GIT_BRANCH || null,
      ...service.health(),
      memoryMb: Math.round(process.memoryUsage().rss / 1_048_576),
    });
  }
  if (service.handle(req, res, url)) return;
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

if (process.env.NODE_ENV !== "test") {
  createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      console.error(`[onchain-venues] request failed: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false });
    }
  }).listen(PORT, () => console.log(`[onchain-venues] listening on :${PORT}`));
  service.start();
}
