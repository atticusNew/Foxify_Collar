#!/usr/bin/env tsx
/**
 * SPORTS VENUES REPORT: read-only collector and report page.
 *
 * Every cycle: read the game-winner markets on Kalshi (the spine: NFL, NBA, NHL games within
 * three days), look each game up on Polymarket US and on Novig's public catalog, read the best
 * bid, ask and depth on both sides on every venue, write one snapshot to disk, and serve one page:
 * the board side by side after fees, the consensus and who sits off it, the cheapest other side
 * for every position with the saving, the crosses that lock after fees, and the gaps over time.
 *
 * Nothing here is a model. Every number is a venue's price, its published fee, or a difference.
 * Nothing here trades: no credentials are loaded, only public market-data endpoints.
 *
 * ISOLATION: imports only from src/sportsVenues/** and read-only pieces under src/eventCollar/**.
 *
 * The cycle and the routes live in src/sportsVenues/collector.ts. Production does not run this
 * script: the BTC curve service mounts the same collector at /sports. This is the page on its
 * own port, for a laptop.
 *
 * Run:  npx tsx services/api/scripts/sportsVenuesReportService.ts
 * Env:  SPORTS_VENUES_PORT          (default 8870; PORT honoured)
 *       SPORTS_VENUES_DATA_DIR      (default /tmp/sports-venues; a Render disk in production)
 *       SPORTS_VENUES_INTERVAL_SEC  (default 60)
 *       SPORTS_VENUES_TOKEN         (optional; when set the page and JSON need ?k=<token>)
 *       SPORTS_VENUES_RETAIN_DAYS   (default: unset, every day is kept. A whole number of days
 *                                   keeps that window and deletes older day files; 0, all or none
 *                                   keep everything; anything unreadable keeps everything and
 *                                   says so on /healthz. A day that has closed is gzipped.)
 *       SPORTS_VENUES_DISK_BUDGET_MB (optional; /healthz warns past 80% of it. It deletes nothing.)
 *       SPORTS_VENUES_HORIZON_DAYS  (default 3; games starting within this many days)
 *       SPORTS_VENUES_WINDOW_HOURS  (default 72; hours of snapshots the window sections read.
 *                                   Memory, not disk: the day files keep every snapshot.)
 *       PROSPECT_PAGE_KEY           (optional; the key of the page made for one reader at
 *                                   /prospect. Unset, shorter than 16 characters, or equal to
 *                                   SPORTS_VENUES_TOKEN: that page is off.)
 *       LOCK_IN_INTERNAL_KEY        (optional; the company's own Lock in pages at /lockin)
 *       NOVIG_PUBLIC_HOST           (default https://api.novig.com)
 *       POLY_US_REST_BASE / KALSHI_REST_BASE (relays)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { sportsCollectorFromEnv } from "../src/sportsVenues/collector";

const PORT = Number(process.env.SPORTS_VENUES_PORT || process.env.PORT || 8870);
const TOKEN = process.env.SPORTS_VENUES_TOKEN || "";

export const sports = sportsCollectorFromEnv(process.env);

/** Memory in use, in megabytes, for /healthz: the service runs in 512 MB and this is how close it is. */
function memoryMb(): { rss: number; heapUsed: number; arrayBuffers: number } {
  const m = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1_048_576);
  return { rss: mb(m.rss), heapUsed: mb(m.heapUsed), arrayBuffers: mb(m.arrayBuffers) };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/healthz") {
    return sendJson(res, 200, {
      ok: true,
      service: "sports-venues-report",
      commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null,
      branch: process.env.RENDER_GIT_BRANCH || null,
      ...sports.health(),
      memoryMb: memoryMb(),
    });
  }
  if (sports.audience(req, res, url)) return;
  if ((!TOKEN || url.searchParams.get("k") === TOKEN) && sports.handle(req, res, url.pathname, url)) return;
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

if (process.env.NODE_ENV !== "test") {
  // the service answers first, so the host's health check passes while the history reloads
  createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(`[sports-venues] request failed: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false });
    });
  }).listen(PORT, () => console.log(`[sports-venues] listening on :${PORT}`));
  sports.start();
}
