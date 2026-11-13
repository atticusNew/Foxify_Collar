#!/usr/bin/env tsx
/**
 * BTC CURVE REPORT — read-only collector and report page.
 *
 * Every cycle: read the Bitcoin ladders on Kalshi and Polymarket US (public endpoints),
 * the Deribit option chain, and the BRTI settlement index; model each bucket off the
 * option smile; write one snapshot to disk; step the static-vs-dynamic hedge replay;
 * quote Lock in along the hourly ladder off OKX option books. Serve it all as one page.
 *
 * What is real: every venue price, every option mark, the settlement index.
 * What is a model: the "option-implied fair value" column and the touch probabilities.
 * What is arithmetic over observed prices: the crosses, the latency table, the replays.
 * Nothing here trades — no credentials are loaded, only public market-data endpoints.
 *
 * ISOLATION: imports only from src/btcCurve/**, src/sportsVenues/** and the read-only readers /
 * pricer under src/eventCollar/**. Nothing here touches production services, stores or deploys.
 *
 * Run:  npx tsx services/api/scripts/btcCurveReportService.ts
 * Env:  BTC_CURVE_PORT          (default 8860; PORT honoured)
 *       BTC_CURVE_DATA_DIR      (default /tmp/btc-curve; a Render disk in production)
 *       BTC_CURVE_INTERVAL_SEC  (default 60)
 *       BTC_CURVE_TOKEN         (optional; when set the page and JSON need ?k=<token>. Without
 *                               it, or with one that no longer matches, the report, /pairs and
 *                               /sports answer a short "access link expired, contact us" page
 *                               (src/btcCurve/accessPage.ts) and their JSON the same in JSON,
 *                               both 401; every other path is the plain 404 it was)
 *       BTC_CURVE_SHOW_TAKE     (1 shows the writer's take in §6; default off)
 *       BTC_CURVE_RETAIN_DAYS   (default: unset, every day is kept. A whole number of days keeps
 *                               that window and deletes older day files; 0, all or none keep
 *                               everything; anything unreadable keeps everything and says so on
 *                               /healthz. Covers the pairs files too unless BTC_PAIRS_RETAIN_DAYS
 *                               is set. A day that has closed is gzipped either way.)
 *       BTC_CURVE_DISK_BUDGET_MB (optional; /healthz warns past 80% of it. It deletes nothing.)
 *       BTC_CURVE_COLLAR        (0 disables the §6 OKX quotes; default on)
 *       BTC_CURVE_PAIRS         (0 disables the BTC pairs page mounted at /pairs; default on)
 *       BTC_PAIRS_*             (the pairs collector: INTERVAL_SEC 10, DATA_DIR under the curve
 *                               data dir, RETAIN_DAYS, LAUNCH_URL, LAUNCH_MODE send|open,
 *                               KALSHI_URL; see scripts/btcPairsService.ts)
 *       BTC_CURVE_SPORTS        (off or 0 disables the sports venues page mounted at /sports;
 *                               default on)
 *       SPORTS_VENUES_*         (the sports collector: INTERVAL_SEC 60, WINDOW_HOURS 24 here,
 *                               DATA_DIR under the curve data dir, RETAIN_DAYS, HORIZON_DAYS;
 *                               see scripts/sportsVenuesReportService.ts)
 *       PROSPECT_PAGE_KEY       (optional; the key of the page made for one reader at /prospect.
 *                               Unset, shorter than 16 characters, or equal to BTC_CURVE_TOKEN:
 *                               that page is off. It opens nothing else here, and
 *                               BTC_CURVE_TOKEN does not open it.)
 *       LOCK_IN_INTERNAL_KEY    (optional; the key of the company's own Lock in pages at /lockin:
 *                               every replay table and the lock card. Same rules; it may not
 *                               equal PROSPECT_PAGE_KEY either.)
 *       POLY_US_EXTRA_EVENT_SLUGS  comma-separated Polymarket US event slugs to add
 *       POLY_US_REST_BASE / KALSHI_REST_BASE / DERIBIT_REST_BASE / OKX_REST_BASE (relays)
 *
 * /pairs is the BTC pairs UI (Kalshi and Polymarket US: the 15-minute window, at the money and
 * one strike each way on the next close and the daily, bands, regime, one Launch button per
 * tenor) served from this process so it costs no second web service; its JSON lives under
 * /pairs/api/* and shares this service's token.
 *
 * /sports is the sports venues page (the same game on Kalshi, Polymarket US and Novig) served
 * from this process for the same reason, with its JSON under /sports/api/* and the same token.
 * It sits behind a boundary (mountSports): a sports fault is a line on /healthz and never this
 * service's own pages. It holds 24 hours of snapshots in memory, not the 72 it holds on its
 * own, because this process has 512 MB for everything; the day files keep every snapshot.
 * Under this service's token /sports is the board only. Lock in replayed on Crypto.com's trade
 * tape is a page made for one reader, at /prospect under that reader's own key, and the full
 * tables at /lockin under an internal key (src/sportsVenues/audiences.ts); the request is
 * offered to those before this service's token is checked, and a wrong key there is a 404.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readKalshiLadders } from "../src/btcCurve/kalshiLadders";
import { fetchBrtiCandles, readPolyUsLadders } from "../src/btcCurve/polyUsLadders";
import { fetchChain, fetchDeribitIndex, selectRows } from "../src/btcCurve/deribitChain";
import { buildSmiles, modelBucket } from "../src/btcCurve/model";
import { hourlyVolPoint, mergeLadders } from "../src/btcCurve/analytics";
import { SnapshotStore } from "../src/btcCurve/store";
import { maintainLines, parseBudgetMb, parseRetention } from "../src/btcCurve/dayFiles";
import { ReplayEngine } from "../src/btcCurve/replay";
import { quoteCollarLadder, type CollarLadder } from "../src/btcCurve/collarLadder";
import { buildReport } from "../src/btcCurve/report";
import { renderReportHtml } from "../src/btcCurve/reportHtml";
import { pairsCollectorFromEnv, type PairsCollector } from "../src/btcCurve/pairsCollector";
import { pageLinks } from "../src/btcCurve/pageLinks";
import { accessAnswer } from "../src/btcCurve/accessPage";
import { mountSports, sportsCollectorFromEnv, type SportsMount } from "../src/sportsVenues/collector";
import type { IndexCandle, Ladder, OptionRow, Snapshot } from "../src/btcCurve/types";

const PORT = Number(process.env.BTC_CURVE_PORT || process.env.PORT || 8860);
const DATA_DIR = process.env.BTC_CURVE_DATA_DIR || "/tmp/btc-curve";
const INTERVAL_SEC = Math.max(20, Number(process.env.BTC_CURVE_INTERVAL_SEC || 60));
const TOKEN = process.env.BTC_CURVE_TOKEN || "";
const SHOW_TAKE = process.env.BTC_CURVE_SHOW_TAKE === "1";
const COLLAR_ON = process.env.BTC_CURVE_COLLAR !== "0";
const EXTRA_SLUGS = (process.env.POLY_US_EXTRA_EVENT_SLUGS || "").split(",").map((s) => s.trim()).filter(Boolean);
const PAIRS_BASE = "/pairs";
const RETENTION = parseRetention(process.env.BTC_CURVE_RETAIN_DAYS, "BTC_CURVE_RETAIN_DAYS");
// the pairs files sit on the same disk, so the curve's window covers them unless BTC_PAIRS_RETAIN_DAYS says otherwise
const pairs: PairsCollector | null =
  process.env.BTC_CURVE_PAIRS !== "0"
    ? pairsCollectorFromEnv(process.env, { dataDir: join(DATA_DIR, "pairs"), retainDays: process.env.BTC_CURVE_RETAIN_DAYS ?? "", retainSetting: "BTC_CURVE_RETAIN_DAYS" })
    : null;
const SPORTS_BASE = "/sports";
const SPORTS_WINDOW_HOURS = 24;
export const sports: SportsMount | null = ["off", "0", "false", "no"].includes((process.env.BTC_CURVE_SPORTS ?? "").trim().toLowerCase())
  ? null
  : mountSports(() =>
      sportsCollectorFromEnv(process.env, { dataDir: join(DATA_DIR, "sports"), retainDays: process.env.BTC_CURVE_RETAIN_DAYS ?? "", retainSetting: "BTC_CURVE_RETAIN_DAYS", windowHours: SPORTS_WINDOW_HOURS }),
    );
const LINKS = pageLinks(TOKEN || undefined, [...(pairs ? [{ label: "BTC pairs", base: PAIRS_BASE }] : []), ...(sports ? [{ label: "Sports", base: SPORTS_BASE }] : [])]);

const store = new SnapshotStore(DATA_DIR, { retention: RETENTION, budget: parseBudgetMb(process.env.BTC_CURVE_DISK_BUDGET_MB, "BTC_CURVE_DISK_BUDGET_MB") });
const replay = new ReplayEngine(join(DATA_DIR, "replay-state.json"), join(DATA_DIR, "replays.jsonl"));

let candles: IndexCandle[] = [];
let collar: CollarLadder | null = null;
let collectingSince: string | null = null;
/** false until the since marker is on disk: a write that failed is tried again each cycle, so /healthz does not say "not recording" for good */
let sinceOnDisk = false;
let cycles = 0;
let lastError = "";

const SINCE_PATH = join(DATA_DIR, "collecting-since.txt");

type Family = "range" | "above" | "touch_up" | "touch_down";
function family(l: Ladder): Family {
  if (l.buckets.some((b) => b.kind === "range")) return "range";
  const k = l.buckets[0]?.kind;
  return k === "touch_up" || k === "touch_down" || k === "above" ? k : "range";
}

/**
 * Ceiling on one source per cycle. Each request already carries its own per-attempt timeout,
 * but a read that fans out into many requests can still stall for minutes when name
 * resolution or a socket hangs below the abort signal (one Polymarket US read ran 840 s on
 * Nov 8). Past the deadline the source is recorded as down for the cycle and the cycle goes on
 * with the other sources, so an hourly settlement is never missed waiting on a book.
 */
const SOURCE_DEADLINE_MS = Math.max(10_000, Number(process.env.BTC_CURVE_SOURCE_DEADLINE_MS || 45_000));

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

/** BRTI 60-second average ending at the settlement instant (the venues' own statistic). */
async function settlementValue(settlesAtMs: number): Promise<number | null> {
  const to = Math.floor(settlesAtMs / 1000);
  const rows = await fetchBrtiCandles(to - 60, to, "1S");
  const inWindow = rows.filter((c) => c.ts >= to - 60 && c.ts < to);
  if (inWindow.length < 30) return null;
  return inWindow.reduce((a, c) => a + c.close, 0) / inWindow.length;
}

export async function collectOnce(now = new Date()): Promise<Snapshot> {
  const health: Snapshot["health"] = {};
  const nowMs = now.getTime();
  const [kalshi, poly, chain, brti] = await Promise.all([
    timed("kalshi", health, () => readKalshiLadders({ withDepth: true })),
    timed("polymarket_us", health, () => readPolyUsLadders({ withDepth: true, extraEventSlugs: EXTRA_SLUGS })),
    timed("deribit", health, () => fetchChain()),
    timed("brti", health, () => fetchBrtiCandles(nowMs / 1000 - 3600, nowMs / 1000, "1S")),
  ]);

  if (brti && brti.length) candles = brti;
  // a fresh BRTI print only; when the index read failed this cycle the kept candles still serve
  // the latency table but the spot comes from Deribit's index rather than a minute-old close
  let spotUsd = brti && brti.length ? brti[brti.length - 1].close : 0;
  let spotSource: Snapshot["spotSource"] = "brti";
  if (!(spotUsd > 0)) {
    const idx = await timed("deribit_index", health, () => fetchDeribitIndex());
    spotUsd = idx ?? 0;
    spotSource = "deribit_index";
  }

  // Ladders: Kalshi as the spine, Polymarket US merged where the family and settlement match.
  const polyLadders = poly ?? [];
  const used = new Set<string>();
  const ladders: Ladder[] = [];
  for (const k of [...(kalshi?.yearEnd ?? []), ...(kalshi?.hourly ? [kalshi.hourly] : []), ...(kalshi?.daily ? [kalshi.daily] : [])]) {
    const fam = family(k);
    const mates = polyLadders.filter(
      (p) => !used.has(p.id) && family(p) === fam && Math.abs(Date.parse(p.settlesAt) - Date.parse(k.settlesAt)) <= 60 * 60_000,
    );
    for (const m of mates) used.add(m.id);
    ladders.push(mates.length ? mergeLadders(k, mates) : k);
  }
  for (const p of polyLadders) if (!used.has(p.id)) ladders.push(p);

  // Options subset and the model column.
  const settles = ladders.map((l) => Date.parse(l.settlesAt)).filter((x) => Number.isFinite(x));
  const options: OptionRow[] = chain ? selectRows(chain, settles, nowMs) : [];
  const smiles = buildSmiles(options);
  for (const l of ladders) {
    for (const b of l.buckets) {
      const m = modelBucket(smiles, b, nowMs, spotUsd);
      if (m) l.model[b.key] = m;
    }
  }

  const hourly = ladders.find((l) => l.id.startsWith("btc-hourly:")) ?? null;
  const snapshot: Snapshot = { at: now.toISOString(), spotUsd, spotSource, ladders, options, health };
  if (hourly && spotUsd > 0) snapshot.hourlyVol = hourlyVolPoint(hourly, smiles, spotUsd, candles, nowMs);
  store.append(snapshot);

  // Hedge replay: open on the hourly ladder, step everything, settle what is due. The engine
  // writes its state every step; a full disk must not stop the cycle, so that write is guarded.
  if (spotUsd > 0) store.guardWrite("replay-state.json", () => replay.observe(hourly, spotUsd, options, nowMs));
  for (const ev of replay.dueForSettlement(nowMs)) {
    try {
      const v = await settlementValue(ev.settlesAtMs);
      if (v !== null) store.guardWrite("replays.jsonl", () => void replay.settle(ev.id, v, v, options, nowMs));
    } catch (err) {
      lastError = `settle ${ev.id}: ${(err as Error).message.slice(0, 80)}`;
    }
  }

  // Lock in is quoted on the daily contract (the tenor a collar on listed options fits); the hourly only when no daily is listed.
  const collarLadder = ladders.find((l) => l.id.startsWith("btc-daily:")) ?? hourly;
  if (COLLAR_ON && collarLadder && spotUsd > 0) {
    collar = await timed("okx", health, () => quoteCollarLadder(collarLadder, spotUsd, now, { showTake: SHOW_TAKE }));
  }

  const since = collectingSince ?? now.toISOString();
  collectingSince = since;
  if (!sinceOnDisk) sinceOnDisk = store.guardWrite("collecting-since.txt", () => writeFileSync(SINCE_PATH, since));
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
    for (const line of maintainLines(r, RETENTION)) console.log(`[btc-curve] ${line}`);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function authorized(url: URL): boolean {
  return !TOKEN || url.searchParams.get("k") === TOKEN;
}

function buildReportData() {
  const latest = store.getLatest();
  if (!latest) return null;
  return buildReport({
    snapshot: latest,
    history: store.getHistory(),
    candles,
    replay: replay.summary(),
    collar,
    intervalSec: INTERVAL_SEC,
    collectingSince,
  });
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/healthz") {
    const latest = store.getLatest();
    return sendJson(res, 200, {
      ok: true,
      service: "btc-curve-report",
      commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null,
      branch: process.env.RENDER_GIT_BRANCH || null,
      warm: Boolean(latest),
      at: latest?.at ?? null,
      cycles,
      historyPoints: store.getHistory().length,
      reload: reloaded ?? "in progress",
      memoryMb: memoryMb(),
      replays: replay.summary().n,
      inFlight: replay.getOpen().length,
      lastError: lastError || undefined,
      data: store.dataHealth(),
      pairs: pairs ? pairs.health() : undefined,
      sports: sports ? sports.health() : "off (BTC_CURVE_SPORTS)",
    });
  }
  // a page made for one reader has its own key, checked there; this service's key does not open it
  if (sports?.audience(req, res, url)) return;
  if (!authorized(url)) {
    // the key was changed: on this service's own pages the holder of an old link is told so and who to write to, and is shown nothing else
    const answer = accessAnswer(url.pathname, url.searchParams.has("k"), ["/", "/api", PAIRS_BASE, SPORTS_BASE]);
    if (answer) {
      res.writeHead(answer.status, { "content-type": `${answer.type}; charset=utf-8`, "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" });
      res.end(answer.body);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  if (pairs && (url.pathname === PAIRS_BASE || url.pathname.startsWith(`${PAIRS_BASE}/`))) {
    const sub = url.pathname.slice(PAIRS_BASE.length).replace(/\/$/, "") || "/";
    if (pairs.handle(req, res, sub, url, { base: PAIRS_BASE, token: TOKEN || undefined, links: LINKS })) return;
  }
  if (sports && (url.pathname === SPORTS_BASE || url.pathname.startsWith(`${SPORTS_BASE}/`))) {
    const sub = url.pathname.slice(SPORTS_BASE.length).replace(/\/$/, "") || "/";
    // the board only: whoever holds this service's key is not shown the Lock in pages
    if (sports.handle(req, res, sub, url, { links: LINKS, lockPages: false })) return;
  }
  if (url.pathname === "/api/report") {
    const data = buildReportData();
    return data ? sendJson(res, 200, data) : sendJson(res, 503, { ok: false, error: "warming up" });
  }
  if (url.pathname === "/api/latest") {
    const latest = store.getLatest();
    return latest ? sendJson(res, 200, latest) : sendJson(res, 503, { ok: false, error: "warming up" });
  }
  if (url.pathname === "/api/replays") {
    return sendJson(res, 200, { open: replay.getOpen(), done: replay.getDone() });
  }
  if (url.pathname === "/") {
    const data = buildReportData();
    res.writeHead(data ? 200 : 503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    if (!data) {
      res.end(
        `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="10"><title>warming up</title><p style="font:16px system-ui;padding:40px">First snapshot in progress — this page refreshes itself.</p>`,
      );
      return;
    }
    res.end(renderReportHtml(data, { refreshSec: INTERVAL_SEC, links: LINKS }));
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
    console.error(`[btc-curve] cycle failed: ${lastError}`);
  }
  setTimeout(loop, INTERVAL_SEC * 1000);
}

if (process.env.NODE_ENV !== "test") {
  if (existsSync(SINCE_PATH)) collectingSince = readFileSync(SINCE_PATH, "utf8").trim() || null;
  sinceOnDisk = collectingSince !== null;
  // the service answers first, so the host's health check passes while the history reloads
  createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(`[btc-curve] request failed: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false });
    });
  }).listen(PORT, () => console.log(`[btc-curve] listening on :${PORT}${pairs ? ` · pairs at ${PAIRS_BASE}` : ""}${sports ? ` · sports at ${SPORTS_BASE}` : ""}`));
  // the cycles start whether the reload ends well or not: recording new data never waits on old data
  const t0 = Date.now();
  void store
    .load()
    .then(
      (loaded) => {
        reloaded = { points: loaded, ms: Date.now() - t0 };
        console.log(`[btc-curve] data dir ${DATA_DIR} · ${loaded} snapshots reloaded in ${Math.round(reloaded.ms / 1000)}s · interval ${INTERVAL_SEC}s · ${store.startupLine()}`);
      },
      (err) => {
        reloaded = { points: 0, ms: Date.now() - t0, error: (err as Error).message.slice(0, 160) };
        console.error(`[btc-curve] the reload on start-up failed (${reloaded.error}); the cycles start without it`);
      },
    )
    .then(() => {
      maintain();
      void loop();
      pairs?.start();
      // after the curve's own reload, never beside it: the two reloads are the two peaks of memory
      sports?.start();
    });
  // a clean stop ends the pairs page's lock runs still open and writes them; without this they are lost with the process
  if (pairs) {
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      process.once(sig, () => {
        pairs.stop();
        process.exit(0);
      });
    }
  }
}
