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
 * ISOLATION: imports only from src/btcCurve/** and the read-only readers / pricer under
 * src/eventCollar/**. Nothing here touches production services, stores or deploys.
 *
 * Run:  npx tsx services/api/scripts/btcCurveReportService.ts
 * Env:  BTC_CURVE_PORT          (default 8860; PORT honoured)
 *       BTC_CURVE_DATA_DIR      (default /tmp/btc-curve; a Render disk in production)
 *       BTC_CURVE_INTERVAL_SEC  (default 60)
 *       BTC_CURVE_TOKEN         (optional; when set the page and JSON need ?k=<token>)
 *       BTC_CURVE_SHOW_TAKE     (1 shows the writer's take in §6; default off)
 *       BTC_CURVE_RETAIN_DAYS   (default 21; older day files are deleted)
 *       BTC_CURVE_COLLAR        (0 disables the §6 OKX quotes; default on)
 *       BTC_CURVE_PAIRS         (0 disables the BTC pairs page mounted at /pairs; default on)
 *       BTC_PAIRS_*             (the pairs collector: INTERVAL_SEC 10, DATA_DIR under the curve
 *                               data dir, LAUNCH_URL, LAUNCH_MODE send|open, KALSHI_URL; see
 *                               scripts/btcPairsService.ts)
 *       POLY_US_EXTRA_EVENT_SLUGS  comma-separated Polymarket US event slugs to add
 *       POLY_US_REST_BASE / KALSHI_REST_BASE / DERIBIT_REST_BASE / OKX_REST_BASE (relays)
 *
 * /pairs is the BTC pairs UI (Kalshi and Polymarket US: the 15-minute window, at the money and
 * one strike each way on the next close and the daily, bands, regime, one Launch button per
 * tenor) served from this process so it costs no second web service; its JSON lives under
 * /pairs/api/* and shares this service's token.
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
import { ReplayEngine } from "../src/btcCurve/replay";
import { quoteCollarLadder, type CollarLadder } from "../src/btcCurve/collarLadder";
import { buildReport } from "../src/btcCurve/report";
import { renderReportHtml } from "../src/btcCurve/reportHtml";
import { pairsCollectorFromEnv, type PairsCollector } from "../src/btcCurve/pairsCollector";
import type { IndexCandle, Ladder, OptionRow, Snapshot } from "../src/btcCurve/types";

const PORT = Number(process.env.BTC_CURVE_PORT || process.env.PORT || 8860);
const DATA_DIR = process.env.BTC_CURVE_DATA_DIR || "/tmp/btc-curve";
const INTERVAL_SEC = Math.max(20, Number(process.env.BTC_CURVE_INTERVAL_SEC || 60));
const TOKEN = process.env.BTC_CURVE_TOKEN || "";
const SHOW_TAKE = process.env.BTC_CURVE_SHOW_TAKE === "1";
const COLLAR_ON = process.env.BTC_CURVE_COLLAR !== "0";
const EXTRA_SLUGS = (process.env.POLY_US_EXTRA_EVENT_SLUGS || "").split(",").map((s) => s.trim()).filter(Boolean);
const PAIRS_BASE = "/pairs";
const pairs: PairsCollector | null = process.env.BTC_CURVE_PAIRS !== "0" ? pairsCollectorFromEnv(process.env, { dataDir: join(DATA_DIR, "pairs") }) : null;

const store = new SnapshotStore(DATA_DIR, { retainDays: Number(process.env.BTC_CURVE_RETAIN_DAYS || 21) });
const replay = new ReplayEngine(join(DATA_DIR, "replay-state.json"), join(DATA_DIR, "replays.jsonl"));

let candles: IndexCandle[] = [];
let collar: CollarLadder | null = null;
let collectingSince: string | null = null;
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

  // Hedge replay: open on the hourly ladder, step everything, settle what is due.
  if (spotUsd > 0) replay.observe(hourly, spotUsd, options, nowMs);
  for (const ev of replay.dueForSettlement(nowMs)) {
    try {
      const v = await settlementValue(ev.settlesAtMs);
      if (v !== null) replay.settle(ev.id, v, v, options, nowMs);
    } catch (err) {
      lastError = `settle ${ev.id}: ${(err as Error).message.slice(0, 80)}`;
    }
  }

  // Lock in is quoted on the daily contract (the tenor a collar on listed options fits); the hourly only when no daily is listed.
  const collarLadder = ladders.find((l) => l.id.startsWith("btc-daily:")) ?? hourly;
  if (COLLAR_ON && collarLadder && spotUsd > 0) {
    collar = await timed("okx", health, () => quoteCollarLadder(collarLadder, spotUsd, now, { showTake: SHOW_TAKE }));
  }

  if (!collectingSince) {
    collectingSince = now.toISOString();
    writeFileSync(SINCE_PATH, collectingSince);
  }
  cycles += 1;
  if (cycles % 60 === 0) store.sweep(nowMs);
  return snapshot;
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

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
      replays: replay.summary().n,
      inFlight: replay.getOpen().length,
      lastError: lastError || undefined,
      pairs: pairs ? pairs.health() : undefined,
    });
  }
  if (!authorized(url)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  if (pairs && (url.pathname === PAIRS_BASE || url.pathname.startsWith(`${PAIRS_BASE}/`))) {
    const sub = url.pathname.slice(PAIRS_BASE.length).replace(/\/$/, "") || "/";
    if (pairs.handle(req, res, sub, url, { base: PAIRS_BASE, token: TOKEN || undefined })) return;
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
    console.error(`[btc-curve] cycle failed: ${lastError}`);
  }
  setTimeout(loop, INTERVAL_SEC * 1000);
}

if (process.env.NODE_ENV !== "test") {
  const loaded = store.load();
  if (existsSync(SINCE_PATH)) collectingSince = readFileSync(SINCE_PATH, "utf8").trim() || null;
  console.log(`[btc-curve] data dir ${DATA_DIR} · ${loaded} snapshots reloaded · interval ${INTERVAL_SEC}s`);
  createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(`[btc-curve] request failed: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false });
    });
  }).listen(PORT, () => console.log(`[btc-curve] listening on :${PORT}${pairs ? ` · pairs at ${PAIRS_BASE}` : ""}`));
  void loop();
  pairs?.start();
}
