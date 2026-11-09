/**
 * The BTC pairs collector and its routes, mountable under a base path on any of the report
 * services (production mounts it on the BTC curve service at /pairs) or run on its own.
 *
 * Every cycle (10 s by default): Kalshi's KXBTCD open markets, Polymarket US's
 * btc-strike-hourly and btc-strike-daily events, the BRTI print. Pick the next close and the
 * 5 PM ET daily that share a close on both venues, select at the money and one strike each way
 * off BRTI, read the books at those six strikes, score each pair, keep the gap history, push
 * the result to anyone listening on the stream.
 *
 * Nothing here trades: public market-data endpoints only, no credentials loaded. The Launch
 * button posts the pair to the trader's own engine; the orders are his.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { KALSHI_HOURLY, DAILY_WINDOW_MS, HOURLY_WINDOW_MS, dailyLadderFrom, fetchFeeTheta, fetchOpenMarkets, fetchTopDepth, hourlyLadderFrom } from "./kalshiLadders";
import { fetchBook, fetchBrtiCandles, fetchSeriesIdsBySlug, readPolyUsLaddersForSeries } from "./polyUsLadders";
import { mergeLadders } from "./analytics";
import { bundleOf, gapHistoryKey, horizonSet, recordGaps, selectStrikes, strikeLevels, type GapHistory, type Horizon, type HorizonSet, type PairsReport, type Place, type StrikePair, type VenueUrls } from "./pairs";
import { renderPairsBody, renderPairsHtml } from "./pairsHtml";
import type { Ladder, VenueQuote } from "./types";

export interface PairsCollectorOptions {
  intervalSec?: number;
  dataDir?: string;
  windowMs?: number;
  /** link templates; {event}, {ticker} (Kalshi, lower case) and {event}, {slug} (Polymarket US) are replaced */
  kalshiUrl?: string;
  polyUrl?: string;
  /** the trader's engine endpoint the Launch button posts to by default (the page can override it locally) */
  launchUrl?: string;
  sourceDeadlineMs?: number;
  /** test seam */
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

const POLY_SERIES = ["btc-strike-hourly", "btc-strike-daily"];
const CACHE_MS = 10 * 60_000;

/** What the Launch button posts and what /api/pair returns: one pair with its context. */
export interface LaunchPayload {
  type: "atticus.btc_pair";
  version: 1;
  at: string;
  spotUsd: number;
  index: "BRTI";
  pair: StrikePair;
}

export function launchPayload(report: PairsReport, pair: StrikePair): LaunchPayload {
  return { type: "atticus.btc_pair", version: 1, at: report.at, spotUsd: report.spotUsd, index: "BRTI", pair };
}

export class PairsCollector {
  readonly intervalSec: number;
  readonly urls: VenueUrls;
  readonly launchUrl: string;
  private readonly dataDir: string;
  private readonly windowMs: number;
  private readonly deadlineMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly history: GapHistory = new Map();
  private readonly listeners = new Set<ServerResponse>();
  latest: PairsReport | null = null;
  private bodyHtml = "";
  private collectingSince: string | null = null;
  cycles = 0;
  lastError = "";
  private lastSpot = 0;
  private kalshiTheta: { at: number; value: number } | null = null;
  private polySeriesIds: { at: number; value: string[] } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: PairsCollectorOptions = {}) {
    this.intervalSec = Math.max(5, opts.intervalSec ?? 10);
    this.dataDir = opts.dataDir ?? "/tmp/btc-pairs";
    this.windowMs = opts.windowMs ?? 120 * 60_000;
    this.deadlineMs = Math.max(5_000, opts.sourceDeadlineMs ?? 20_000);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? ((line) => console.log(line));
    this.launchUrl = opts.launchUrl ?? "";
    const kalshiUrl = opts.kalshiUrl || "https://kalshi.com/markets/kxbtcd";
    const polyUrl = opts.polyUrl || "https://polymarket.us/event/{event}";
    this.urls = {
      kalshi: ({ ticker, eventTicker }) => kalshiUrl.replace("{event}", eventTicker.toLowerCase()).replace("{ticker}", ticker.toLowerCase()),
      poly: ({ slug, eventSlug }) => polyUrl.replace("{event}", eventSlug).replace("{slug}", slug),
    };
  }

  /** Reload the gap history within the window and start the cycle. */
  start(): void {
    const loaded = this.loadGaps();
    this.log(`[btc-pairs] data dir ${this.dataDir} · ${loaded} cycles of gap history reloaded · interval ${this.intervalSec}s`);
    void this.loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async loop(): Promise<void> {
    const t0 = Date.now();
    try {
      await this.collectOnce();
      this.lastError = "";
    } catch (err) {
      this.lastError = (err as Error).message.slice(0, 200);
      this.log(`[btc-pairs] cycle failed: ${this.lastError}`);
    }
    // the interval is the cadence, not a pause: a slow cycle starts the next one sooner
    this.timer = setTimeout(() => void this.loop(), Math.max(1000, this.intervalSec * 1000 - (Date.now() - t0)));
  }

  private async timed<T>(name: string, health: PairsReport["health"], fn: () => Promise<T>): Promise<T | null> {
    const t0 = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${this.deadlineMs / 1000}s`)), this.deadlineMs);
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

  private async cached<T>(slot: { at: number; value: T } | null, fn: () => Promise<T>, fallback: T): Promise<{ at: number; value: T }> {
    if (slot && Date.now() - slot.at < CACHE_MS) return slot;
    try {
      return { at: Date.now(), value: await fn() };
    } catch {
      return slot ?? { at: 0, value: fallback };
    }
  }

  /** Books for the three selected strikes on each venue; the rest of the ladder keeps its top of book. */
  private async readDepth(ladder: Ladder, spotUsd: number, health: PairsReport["health"], tag: string): Promise<void> {
    const picked = selectStrikes(strikeLevels(ladder), spotUsd);
    if (!picked) return;
    const keys = new Set([picked.below, picked.atm, picked.above].map((s) => ladder.buckets.find((b) => b.kind === "above" && b.level === s)?.key));
    const quotes = ladder.quotes.filter((q) => keys.has(q.bucketKey));
    await this.timed(`${tag} books`, health, () =>
      Promise.all(
        quotes.map(async (q: VenueQuote) => {
          if (q.venue === "kalshi") {
            const d = await fetchTopDepth(q.id, this.fetchImpl);
            q.bidQty = d.bidQty;
            q.askQty = d.askQty;
          } else {
            const b = await fetchBook(q.id, this.fetchImpl);
            q.bidQty = b.bidQty;
            q.askQty = b.askQty;
            if (b.bidCents) q.bidCents = b.bidCents;
            if (b.askCents) q.askCents = b.askCents;
          }
        }),
      ),
    );
  }

  async collectOnce(now = new Date()): Promise<PairsReport> {
    const health: PairsReport["health"] = {};
    const nowMs = now.getTime();

    this.kalshiTheta = await this.cached(this.kalshiTheta, () => fetchFeeTheta(KALSHI_HOURLY, this.fetchImpl), 0.07);
    this.polySeriesIds = await this.cached(this.polySeriesIds, () => fetchSeriesIdsBySlug(POLY_SERIES, this.fetchImpl), []);

    const [kalshiRaw, polyLadders, brti] = await Promise.all([
      this.timed("kalshi", health, () => fetchOpenMarkets(KALSHI_HOURLY, this.fetchImpl)),
      this.timed("polymarket_us", health, () => readPolyUsLaddersForSeries(this.polySeriesIds?.value ?? [], this.fetchImpl)),
      this.timed("brti", health, () => fetchBrtiCandles(nowMs / 1000 - 120, nowMs / 1000, "1S", this.fetchImpl)),
    ]);

    let spotUsd = brti && brti.length ? brti[brti.length - 1].close : 0;
    let spotSource = "BRTI";
    if (!(spotUsd > 0)) {
      spotUsd = this.lastSpot;
      spotSource = "BRTI, last good print";
    } else this.lastSpot = spotUsd;

    const theta = this.kalshiTheta.value;
    const kHourly = kalshiRaw ? hourlyLadderFrom(kalshiRaw, theta, nowMs) : null;
    const kDaily = kalshiRaw ? dailyLadderFrom(kalshiRaw, theta, nowMs) : null;
    const pHourly = polyLadderIn(polyLadders ?? [], nowMs, 2 * 60_000, HOURLY_WINDOW_MS);
    const pDaily = polyLadderIn(polyLadders ?? [], nowMs, HOURLY_WINDOW_MS, DAILY_WINDOW_MS);
    const hourly = merged(kHourly, pHourly);
    const daily = merged(kDaily, pDaily);

    if (spotUsd > 0) {
      await Promise.all([hourly ? this.readDepth(hourly, spotUsd, health, "hourly") : null, daily ? this.readDepth(daily, spotUsd, health, "daily") : null]);
    }

    const build = (h: Horizon, l: Ladder | null, polyId: string | null): HorizonSet | null =>
      l && spotUsd > 0 ? horizonSet(h, l, polyId, spotUsd, nowMs, this.history, this.urls) : null;
    const sets = [build("hourly", hourly, pHourly?.id ?? null), build("daily", daily, pDaily?.id ?? null)];
    recordGaps(this.history, sets, nowMs, this.windowMs);
    this.persistGaps(nowMs, sets);

    if (!this.collectingSince) this.collectingSince = now.toISOString();
    this.cycles += 1;
    const report: PairsReport = {
      at: now.toISOString(),
      spotUsd,
      spotSource,
      intervalSec: this.intervalSec,
      historyPoints: Math.max(0, ...[...this.history.values()].map((a) => a.length)),
      collectingSince: this.collectingSince,
      hourly: sets[0],
      daily: sets[1],
      bundle: bundleOf(sets),
      health,
    };
    this.latest = report;
    this.bodyHtml = renderPairsBody(report);
    this.broadcast(report);
    return report;
  }

  /* ---- the stream: one JSON line per cycle to every listener ---- */

  private broadcast(report: PairsReport): void {
    const frame = `event: pairs\ndata: ${JSON.stringify(report)}\n\n`;
    for (const res of this.listeners) {
      try {
        res.write(frame);
      } catch {
        this.listeners.delete(res);
      }
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /* ---- gap history on disk: one line per cycle, reloaded within the window on boot ---- */

  private dayFile(ms: number): string {
    return join(this.dataDir, `gaps-${new Date(ms).toISOString().slice(0, 10)}.jsonl`);
  }

  private persistGaps(atMs: number, sets: Array<HorizonSet | null>): void {
    const rows = sets.flatMap((s) => (s ? s.pairs.filter((p) => p.gapCents !== null).map((p) => [p.settlesAt, p.key, p.gapCents]) : []));
    if (!rows.length) return;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      appendFileSync(this.dayFile(atMs), `${JSON.stringify({ at: atMs, rows })}\n`);
    } catch (err) {
      this.lastError = `persist: ${(err as Error).message.slice(0, 80)}`;
    }
  }

  loadGaps(nowMs = Date.now()): number {
    if (!existsSync(this.dataDir)) return 0;
    let n = 0;
    for (const f of readdirSync(this.dataDir).filter((f: string) => f.startsWith("gaps-") && f.endsWith(".jsonl")).sort()) {
      const path = join(this.dataDir, f);
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
          if (nowMs - rec.at > this.windowMs) continue;
          for (const [settlesAt, key, gap] of rec.rows) {
            const k = gapHistoryKey(settlesAt, key);
            const arr = this.history.get(k) ?? [];
            arr.push([rec.at, gap]);
            this.history.set(k, arr);
          }
          n += 1;
        } catch {
          // a torn line at the end of a file is skipped
        }
      }
    }
    return n;
  }

  /* ---- routes, relative to a base path ---- */

  health(): Record<string, unknown> {
    return { warm: Boolean(this.latest), at: this.latest?.at ?? null, cycles: this.cycles, intervalSec: this.intervalSec, listeners: this.listeners.size, lastError: this.lastError || undefined };
  }

  /** The pair asked for by horizon and place, or by Kalshi ticker / Polymarket US slug. */
  findPair(params: URLSearchParams): StrikePair | null {
    const d = this.latest;
    if (!d) return null;
    const id = params.get("id");
    const all = [...(d.hourly?.pairs ?? []), ...(d.daily?.pairs ?? [])];
    if (id) return all.find((p) => p.kalshi?.id === id || p.poly?.id === id || `${p.horizon}:${p.strike}` === id) ?? null;
    const horizon = params.get("horizon") as Horizon | null;
    const place = (params.get("place") ?? "atm") as Place;
    const set = horizon === "daily" ? d.daily : d.hourly;
    return set?.pairs.find((p) => p.place === place) ?? null;
  }

  /**
   * Serve one request whose path is already relative to the mount (`/`, `/fragment`,
   * `/api/pairs`, `/api/bundle`, `/api/pair`, `/api/stream`). Returns false when the path is
   * not one of ours so the host can 404 it. `base` is the mount path the page links under.
   */
  handle(req: IncomingMessage, res: ServerResponse, path: string, url: URL, opts: { base: string; token?: string }): boolean {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body));
    };
    const d = this.latest;
    if (path === "/api/pairs") {
      d ? json(200, d) : json(503, { ok: false, error: "warming up" });
      return true;
    }
    if (path === "/api/bundle") {
      d ? json(200, { at: d.at, spotUsd: d.spotUsd, index: "BRTI", bundle: d.bundle.map((p) => launchPayload(d, p)) }) : json(503, { ok: false, error: "warming up" });
      return true;
    }
    if (path === "/api/pair") {
      if (!d) {
        json(503, { ok: false, error: "warming up" });
        return true;
      }
      const p = this.findPair(url.searchParams);
      p ? json(200, launchPayload(d, p)) : json(404, { ok: false, error: "no such pair; use horizon=hourly|daily&place=below|atm|above or id=<Kalshi ticker | Polymarket US slug>" });
      return true;
    }
    if (path === "/api/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "access-control-allow-origin": "*" });
      res.write(`retry: ${this.intervalSec * 1000}\n\n`);
      if (d) res.write(`event: pairs\ndata: ${JSON.stringify(d)}\n\n`);
      this.listeners.add(res);
      req.on("close", () => this.listeners.delete(res));
      return true;
    }
    if (path === "/fragment") {
      res.writeHead(d ? 200 : 503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(d ? this.bodyHtml : "");
      return true;
    }
    if (path === "/" || path === "") {
      res.writeHead(d ? 200 : 503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      if (!d) {
        res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>warming up</title><p style="font:16px system-ui;padding:40px">First reading in progress. This page refreshes itself.</p>`);
        return true;
      }
      res.end(renderPairsHtml(d, { token: opts.token, base: opts.base, launchUrl: this.launchUrl }));
      return true;
    }
    return false;
  }
}

/** The collector as BTC_PAIRS_* configures it; shared by the standalone script and the curve service's mount. */
export function pairsCollectorFromEnv(env: NodeJS.ProcessEnv = process.env, defaults: { dataDir?: string } = {}): PairsCollector {
  return new PairsCollector({
    intervalSec: Number(env.BTC_PAIRS_INTERVAL_SEC || 10),
    dataDir: env.BTC_PAIRS_DATA_DIR || defaults.dataDir || "/tmp/btc-pairs",
    windowMs: Math.max(10, Number(env.BTC_PAIRS_WINDOW_MIN || 120)) * 60_000,
    kalshiUrl: env.BTC_PAIRS_KALSHI_URL,
    polyUrl: env.BTC_PAIRS_POLY_URL,
    launchUrl: env.BTC_PAIRS_LAUNCH_URL,
    sourceDeadlineMs: Number(env.BTC_PAIRS_SOURCE_DEADLINE_MS || 20_000),
  });
}

/** The Polymarket US ladder closing soonest inside (minAhead, maxAhead], above-type buckets only. */
export function polyLadderIn(ladders: Ladder[], nowMs: number, minAheadMs: number, maxAheadMs: number): Ladder | null {
  return (
    ladders
      .filter((l) => l.buckets.some((b) => b.kind === "above") && !l.buckets.some((b) => b.kind === "range"))
      .map((l) => ({ l, ahead: Date.parse(l.settlesAt) - nowMs }))
      .filter((x) => Number.isFinite(x.ahead) && x.ahead > minAheadMs && x.ahead <= maxAheadMs)
      .sort((a, b) => a.ahead - b.ahead)[0]?.l ?? null
  );
}

/** Kalshi spine with the Polymarket US quotes on the same keys; either alone when the other has no contract at that close. */
export function merged(kalshi: Ladder | null, poly: Ladder | null): Ladder | null {
  if (kalshi && poly && Math.abs(Date.parse(kalshi.settlesAt) - Date.parse(poly.settlesAt)) <= 60_000) return mergeLadders(kalshi, [poly]);
  return kalshi ?? poly;
}
