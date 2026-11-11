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
 *       NOVIG_PUBLIC_HOST           (default https://api.novig.com)
 *       POLY_US_REST_BASE / KALSHI_REST_BASE (relays)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { assembleGames, readKalshiGames, readNovigListings, readPolyUsListings, type KalshiGame } from "../src/sportsVenues/readers";
import { SnapshotStore } from "../src/sportsVenues/store";
import { maintainLines, parseBudgetMb, parseRetention } from "../src/btcCurve/dayFiles";
import { buildReport } from "../src/sportsVenues/report";
import { renderReportHtml } from "../src/sportsVenues/reportHtml";
import type { Snapshot, VenueListing } from "../src/sportsVenues/types";

const PORT = Number(process.env.SPORTS_VENUES_PORT || process.env.PORT || 8870);
const DATA_DIR = process.env.SPORTS_VENUES_DATA_DIR || "/tmp/sports-venues";
const INTERVAL_SEC = Math.max(20, Number(process.env.SPORTS_VENUES_INTERVAL_SEC || 60));
const TOKEN = process.env.SPORTS_VENUES_TOKEN || "";
const HORIZON_MS = Math.max(1, Number(process.env.SPORTS_VENUES_HORIZON_DAYS || 3)) * 86_400_000;
const SOURCE_DEADLINE_MS = Math.max(10_000, Number(process.env.SPORTS_VENUES_SOURCE_DEADLINE_MS || 45_000));

const RETENTION = parseRetention(process.env.SPORTS_VENUES_RETAIN_DAYS, "SPORTS_VENUES_RETAIN_DAYS");
const store = new SnapshotStore(DATA_DIR, { retention: RETENTION, budget: parseBudgetMb(process.env.SPORTS_VENUES_DISK_BUDGET_MB, "SPORTS_VENUES_DISK_BUDGET_MB") });
const SINCE_PATH = join(DATA_DIR, "collecting-since.txt");

let collectingSince: string | null = null;
let cycles = 0;
let lastError = "";

/** One source per cycle gets a ceiling; past it the source is recorded as down and the cycle goes on. */
async function timed<T>(name: string, health: Snapshot["health"], fn: () => Promise<T>): Promise<T | null> {
  const t0 = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${SOURCE_DEADLINE_MS / 1000}s`)), SOURCE_DEADLINE_MS);
  });
  try {
    const v = await Promise.race([fn(), deadline]);
    health[name] = { ok: true, ms: Date.now() - t0 };
    return v;
  } catch (err) {
    health[name] = { ok: false, ms: Date.now() - t0, detail: (err as Error).message.slice(0, 120) };
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function collectOnce(now = new Date()): Promise<Snapshot> {
  const health: Snapshot["health"] = {};
  const nowMs = now.getTime();
  const kalshi: KalshiGame[] = (await timed("kalshi", health, () => readKalshiGames({ nowMs, horizonMs: HORIZON_MS }))) ?? [];
  const games = kalshi.map((k) => k.game);
  const [poly, novig] = await Promise.all([
    timed("polymarket_us", health, () => readPolyUsListings(games)),
    timed("novig", health, () => readNovigListings(games, { nowMs })),
  ]);
  const snapshot: Snapshot = {
    at: now.toISOString(),
    games: assembleGames(kalshi, poly ?? new Map<string, VenueListing>(), novig ?? new Map<string, VenueListing>()),
    health,
  };
  store.append(snapshot);
  if (!collectingSince) {
    const since = now.toISOString();
    collectingSince = since;
    store.guardWrite("collecting-since.txt", () => writeFileSync(SINCE_PATH, since));
  }
  cycles += 1;
  if (cycles % 60 === 0) maintain(nowMs);
  return snapshot;
}

/** The hourly pass over the day files, never awaited by a cycle: the retention sweep and at most one closed day gzipped. */
/** What the start-up reload did; null while it runs. */
let reloaded: { points: number; ms: number; error?: string } | null = null;

/** Memory in use, in megabytes, for /healthz: the service runs in 512 MB and this is how close it is. */
function memoryMb(): { rss: number; heapUsed: number; arrayBuffers: number } {
  const m = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1_048_576);
  return { rss: mb(m.rss), heapUsed: mb(m.heapUsed), arrayBuffers: mb(m.arrayBuffers) };
}

function maintain(nowMs = Date.now()): void {
  void store.maintain(nowMs).then((r) => {
    for (const line of maintainLines(r, RETENTION)) console.log(`[sports-venues] ${line}`);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const authorized = (url: URL): boolean => !TOKEN || url.searchParams.get("k") === TOKEN;

function buildReportData() {
  const latest = store.getLatest();
  if (!latest) return null;
  return buildReport({ snapshot: latest, history: store.getHistory(), intervalSec: INTERVAL_SEC, collectingSince });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/healthz") {
    const latest = store.getLatest();
    return sendJson(res, 200, {
      ok: true,
      service: "sports-venues-report",
      commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null,
      branch: process.env.RENDER_GIT_BRANCH || null,
      warm: Boolean(latest),
      at: latest?.at ?? null,
      games: latest?.games.length ?? 0,
      cycles,
      historyPoints: store.getHistory().length,
      reload: reloaded ?? "in progress",
      memoryMb: memoryMb(),
      lastError: lastError || undefined,
      data: store.dataHealth(),
    });
  }
  if (!authorized(url)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  if (url.pathname === "/api/report") {
    const data = buildReportData();
    return data ? sendJson(res, 200, data) : sendJson(res, 503, { ok: false, error: "warming up" });
  }
  if (url.pathname === "/api/latest") {
    const latest = store.getLatest();
    return latest ? sendJson(res, 200, latest) : sendJson(res, 503, { ok: false, error: "warming up" });
  }
  if (url.pathname === "/") {
    const data = buildReportData();
    res.writeHead(data ? 200 : 503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    if (!data) {
      res.end(
        `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="10"><title>warming up</title><p style="font:16px system-ui;padding:40px">First snapshot in progress. This page refreshes itself.</p>`,
      );
      return;
    }
    res.end(renderReportHtml(data, { refreshSec: INTERVAL_SEC }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

async function loop(): Promise<void> {
  try {
    await collectOnce();
    lastError = "";
  } catch (err) {
    lastError = (err as Error).message.slice(0, 200);
    console.error(`[sports-venues] cycle failed: ${lastError}`);
  }
  setTimeout(loop, INTERVAL_SEC * 1000);
}

if (process.env.NODE_ENV !== "test") {
  if (existsSync(SINCE_PATH)) collectingSince = readFileSync(SINCE_PATH, "utf8").trim() || null;
  // the service answers first, so the host's health check passes while the history reloads
  createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(`[sports-venues] request failed: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false });
    });
  }).listen(PORT, () => console.log(`[sports-venues] listening on :${PORT}`));
  // the cycles start whether the reload ends well or not: recording new data never waits on old data
  const t0 = Date.now();
  void store
    .load()
    .then(
      (loaded) => {
        reloaded = { points: loaded, ms: Date.now() - t0 };
        console.log(`[sports-venues] data dir ${DATA_DIR} · ${loaded} snapshots reloaded in ${Math.round(reloaded.ms / 1000)}s · interval ${INTERVAL_SEC}s · ${store.startupLine()}`);
      },
      (err) => {
        reloaded = { points: 0, ms: Date.now() - t0, error: (err as Error).message.slice(0, 160) };
        console.error(`[sports-venues] the reload on start-up failed (${reloaded.error}); the cycles start without it`);
      },
    )
    .then(() => {
      maintain();
      void loop();
    });
}
