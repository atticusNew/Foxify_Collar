#!/usr/bin/env tsx
/**
 * BTC PAIRS: read-only collector and page for a trader working Kalshi and Polymarket US by hand.
 *
 * Every cycle (10 s by default): Kalshi's KXBTCD open markets, Polymarket US's btc-strike-hourly
 * and btc-strike-daily events, the BRTI print. Pick the hourly and the 5 PM ET daily that share
 * a close on both venues, select at the money and one strike each way off BRTI, read the books
 * at those six strikes, score each pair for how cleanly both venues quote it, keep the gap
 * history for persistence, serve one page that re-fetches itself.
 *
 * Nothing here trades: public market-data endpoints only, no credentials loaded. The button on
 * the page opens the venues' own pages; the orders are the trader's.
 *
 * ISOLATION: imports only from src/btcCurve/** and the read-only reader under src/eventCollar/**.
 *
 * Run:  npx tsx services/api/scripts/btcPairsService.ts
 * Env:  BTC_PAIRS_PORT            (default 8880; PORT honoured)
 *       BTC_PAIRS_INTERVAL_SEC    (default 10, floor 5)
 *       BTC_PAIRS_DATA_DIR        (default /tmp/btc-pairs; gap history survives a restart)
 *       BTC_PAIRS_TOKEN           (optional; when set the page and JSON need ?k=<token>)
 *       BTC_PAIRS_WINDOW_MIN      (default 120; gap history kept this long)
 *       BTC_PAIRS_KALSHI_URL      (link template; {event} and {ticker} are replaced, lower case;
 *                                 default https://kalshi.com/markets/kxbtcd, the series page)
 *       BTC_PAIRS_POLY_URL        (default https://polymarket.us/event/{event})
 *       POLY_US_REST_BASE / KALSHI_REST_BASE (relays)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { KALSHI_HOURLY, dailyLadderFrom, fetchFeeTheta, fetchOpenMarkets, fetchTopDepth, hourlyLadderFrom, DAILY_WINDOW_MS, HOURLY_WINDOW_MS } from "../src/btcCurve/kalshiLadders";
import { fetchBook, fetchBrtiCandles, fetchSeriesIdsBySlug, readPolyUsLaddersForSeries } from "../src/btcCurve/polyUsLadders";
import { mergeLadders } from "../src/btcCurve/analytics";
import { bundleOf, gapHistoryKey, horizonSet, recordGaps, selectStrikes, strikeLevels, type GapHistory, type Horizon, type HorizonSet, type PairsReport, type VenueUrls } from "../src/btcCurve/pairs";
import { renderPairsBody, renderPairsHtml } from "../src/btcCurve/pairsHtml";
import type { Ladder, VenueQuote } from "../src/btcCurve/types";

const PORT = Number(process.env.BTC_PAIRS_PORT || process.env.PORT || 8880);
const INTERVAL_SEC = Math.max(5, Number(process.env.BTC_PAIRS_INTERVAL_SEC || 10));
const DATA_DIR = process.env.BTC_PAIRS_DATA_DIR || "/tmp/btc-pairs";
const TOKEN = process.env.BTC_PAIRS_TOKEN || "";
const WINDOW_MS = Math.max(10, Number(process.env.BTC_PAIRS_WINDOW_MIN || 120)) * 60_000;
const KALSHI_URL = process.env.BTC_PAIRS_KALSHI_URL || "https://kalshi.com/markets/kxbtcd";
const POLY_URL = process.env.BTC_PAIRS_POLY_URL || "https://polymarket.us/event/{event}";
const POLY_SERIES = ["btc-strike-hourly", "btc-strike-daily"];
const SOURCE_DEADLINE_MS = Math.max(5_000, Number(process.env.BTC_PAIRS_SOURCE_DEADLINE_MS || 20_000));
const CACHE_MS = 10 * 60_000;

export const urls: VenueUrls = {
  kalshi: ({ ticker, eventTicker }) => KALSHI_URL.replace("{event}", eventTicker.toLowerCase()).replace("{ticker}", ticker.toLowerCase()),
  poly: ({ slug, eventSlug }) => POLY_URL.replace("{event}", eventSlug).replace("{slug}", slug),
};

const history: GapHistory = new Map();
let latest: PairsReport | null = null;
let bodyHtml = "";
let collectingSince: string | null = null;
let cycles = 0;
let lastError = "";
let lastSpot = 0;
let kalshiTheta: { at: number; value: number } | null = null;
let polySeriesIds: { at: number; value: string[] } | null = null;

async function timed<T>(name: string, health: PairsReport["health"], fn: () => Promise<T>): Promise<T | null> {
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

async function cached<T>(slot: { at: number; value: T } | null, fn: () => Promise<T>, fallback: T): Promise<{ at: number; value: T }> {
  if (slot && Date.now() - slot.at < CACHE_MS) return slot;
  try {
    return { at: Date.now(), value: await fn() };
  } catch {
    return slot ?? { at: 0, value: fallback };
  }
}

/** The Polymarket US ladder closing soonest inside (minAhead, maxAhead], above-type buckets only. */
function polyLadderIn(ladders: Ladder[], nowMs: number, minAheadMs: number, maxAheadMs: number): Ladder | null {
  return (
    ladders
      .filter((l) => l.buckets.some((b) => b.kind === "above") && !l.buckets.some((b) => b.kind === "range"))
      .map((l) => ({ l, ahead: Date.parse(l.settlesAt) - nowMs }))
      .filter((x) => Number.isFinite(x.ahead) && x.ahead > minAheadMs && x.ahead <= maxAheadMs)
      .sort((a, b) => a.ahead - b.ahead)[0]?.l ?? null
  );
}

/** Kalshi spine with the Polymarket US quotes on the same keys; either alone when the other has no contract at that close. */
function merged(kalshi: Ladder | null, poly: Ladder | null): Ladder | null {
  if (kalshi && poly && Math.abs(Date.parse(kalshi.settlesAt) - Date.parse(poly.settlesAt)) <= 60_000) return mergeLadders(kalshi, [poly]);
  return kalshi ?? poly;
}

/** Books for the three selected strikes on each venue; the rest of the ladder keeps its top of book. */
async function readDepth(ladder: Ladder, spotUsd: number, health: PairsReport["health"], tag: string): Promise<void> {
  const picked = selectStrikes(strikeLevels(ladder), spotUsd);
  if (!picked) return;
  const keys = new Set([picked.below, picked.atm, picked.above].map((s) => ladder.buckets.find((b) => b.kind === "above" && b.level === s)?.key).filter(Boolean));
  const quotes = ladder.quotes.filter((q) => keys.has(q.bucketKey));
  await timed(`${tag} books`, health, () =>
    Promise.all(
      quotes.map(async (q: VenueQuote) => {
        if (q.venue === "kalshi") {
          const d = await fetchTopDepth(q.id);
          q.bidQty = d.bidQty;
          q.askQty = d.askQty;
        } else {
          const b = await fetchBook(q.id);
          q.bidQty = b.bidQty;
          q.askQty = b.askQty;
          if (b.bidCents) q.bidCents = b.bidCents;
          if (b.askCents) q.askCents = b.askCents;
        }
      }),
    ),
  );
}

export async function collectOnce(now = new Date()): Promise<PairsReport> {
  const health: PairsReport["health"] = {};
  const nowMs = now.getTime();

  kalshiTheta = await cached(kalshiTheta, () => fetchFeeTheta(KALSHI_HOURLY), 0.07);
  polySeriesIds = await cached(polySeriesIds, () => fetchSeriesIdsBySlug(POLY_SERIES), []);

  const [kalshiRaw, polyLadders, brti] = await Promise.all([
    timed("kalshi", health, () => fetchOpenMarkets(KALSHI_HOURLY)),
    timed("polymarket_us", health, () => readPolyUsLaddersForSeries(polySeriesIds?.value ?? [])),
    timed("brti", health, () => fetchBrtiCandles(nowMs / 1000 - 120, nowMs / 1000, "1S")),
  ]);

  let spotUsd = brti && brti.length ? brti[brti.length - 1].close : 0;
  let spotSource = "BRTI";
  if (!(spotUsd > 0)) {
    spotUsd = lastSpot;
    spotSource = "BRTI, last good print";
  } else lastSpot = spotUsd;

  const theta = kalshiTheta.value;
  const kHourly = kalshiRaw ? hourlyLadderFrom(kalshiRaw, theta, nowMs) : null;
  const kDaily = kalshiRaw ? dailyLadderFrom(kalshiRaw, theta, nowMs) : null;
  const pHourly = polyLadderIn(polyLadders ?? [], nowMs, 2 * 60_000, HOURLY_WINDOW_MS);
  const pDaily = polyLadderIn(polyLadders ?? [], nowMs, HOURLY_WINDOW_MS, DAILY_WINDOW_MS);
  const hourly = merged(kHourly, pHourly);
  const daily = merged(kDaily, pDaily);

  if (spotUsd > 0) {
    await Promise.all([hourly ? readDepth(hourly, spotUsd, health, "hourly") : null, daily ? readDepth(daily, spotUsd, health, "daily") : null]);
  }

  const build = (h: Horizon, l: Ladder | null, polyId: string | null): HorizonSet | null => (l && spotUsd > 0 ? horizonSet(h, l, polyId, spotUsd, nowMs, history, urls) : null);
  const sets = [build("hourly", hourly, pHourly?.id ?? null), build("daily", daily, pDaily?.id ?? null)];
  recordGaps(history, sets, nowMs, WINDOW_MS);
  persistGaps(nowMs, sets);

  if (!collectingSince) collectingSince = now.toISOString();
  cycles += 1;
  const report: PairsReport = {
    at: now.toISOString(),
    spotUsd,
    spotSource,
    intervalSec: INTERVAL_SEC,
    historyPoints: Math.max(0, ...[...history.values()].map((a) => a.length)),
    collectingSince,
    hourly: sets[0],
    daily: sets[1],
    bundle: bundleOf(sets),
    health,
  };
  latest = report;
  bodyHtml = renderPairsBody(report);
  return report;
}

/* ---- gap history on disk: one line per cycle, reloaded within the window on boot ---- */

function dayFile(ms: number): string {
  return join(DATA_DIR, `gaps-${new Date(ms).toISOString().slice(0, 10)}.jsonl`);
}

function persistGaps(atMs: number, sets: Array<HorizonSet | null>): void {
  const rows = sets.flatMap((s) => (s ? s.pairs.filter((p) => p.gapCents !== null).map((p) => [p.settlesAt, p.key, p.gapCents]) : []));
  if (!rows.length) return;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(dayFile(atMs), `${JSON.stringify({ at: atMs, rows })}\n`);
  } catch (err) {
    lastError = `persist: ${(err as Error).message.slice(0, 80)}`;
  }
}

export function loadGaps(nowMs = Date.now()): number {
  if (!existsSync(DATA_DIR)) return 0;
  let n = 0;
  for (const f of readdirSync(DATA_DIR).filter((f) => f.startsWith("gaps-") && f.endsWith(".jsonl")).sort()) {
    const path = join(DATA_DIR, f);
    const dayMs = Date.parse(f.slice(5, 15));
    if (Number.isFinite(dayMs) && nowMs - dayMs > 3 * 86_400_000) {
      try {
        unlinkSync(path);
      } catch {
        // an old day that would not delete is left; nothing reads it
      }
      continue;
    }
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as { at: number; rows: Array<[string, string, number]> };
        if (nowMs - rec.at > WINDOW_MS) continue;
        for (const [settlesAt, key, gap] of rec.rows) {
          const k = gapHistoryKey(settlesAt, key);
          const arr = history.get(k) ?? [];
          arr.push([rec.at, gap]);
          history.set(k, arr);
        }
        n += 1;
      } catch {
        // a torn line at the end of a file is skipped
      }
    }
  }
  return n;
}

/* ---- http ---- */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function authorized(url: URL): boolean {
  return !TOKEN || url.searchParams.get("k") === TOKEN;
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/healthz") {
    return sendJson(res, 200, {
      ok: true,
      service: "btc-pairs",
      commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null,
      warm: Boolean(latest),
      at: latest?.at ?? null,
      cycles,
      intervalSec: INTERVAL_SEC,
      lastError: lastError || undefined,
    });
  }
  if (!authorized(url)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  if (url.pathname === "/api/pairs") {
    return latest ? sendJson(res, 200, latest) : sendJson(res, 503, { ok: false, error: "warming up" });
  }
  if (url.pathname === "/fragment") {
    res.writeHead(latest ? 200 : 503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(latest ? bodyHtml : "");
    return;
  }
  if (url.pathname === "/") {
    res.writeHead(latest ? 200 : 503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    if (!latest) {
      res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>warming up</title><p style="font:16px system-ui;padding:40px">First reading in progress. This page refreshes itself.</p>`);
      return;
    }
    res.end(renderPairsHtml(latest, { token: TOKEN || undefined }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

async function loop(): Promise<void> {
  const t0 = Date.now();
  try {
    await collectOnce();
    lastError = "";
  } catch (err) {
    lastError = (err as Error).message.slice(0, 200);
    console.error(`[btc-pairs] cycle failed: ${lastError}`);
  }
  // the interval is the cadence, not a pause: a slow cycle starts the next one sooner
  setTimeout(loop, Math.max(1000, INTERVAL_SEC * 1000 - (Date.now() - t0)));
}

if (process.env.NODE_ENV !== "test") {
  const loaded = loadGaps();
  console.log(`[btc-pairs] data dir ${DATA_DIR} · ${loaded} cycles of gap history reloaded · interval ${INTERVAL_SEC}s`);
  createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(`[btc-pairs] request failed: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false });
    });
  }).listen(PORT, () => console.log(`[btc-pairs] listening on :${PORT}`));
  void loop();
}
