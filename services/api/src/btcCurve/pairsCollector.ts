/**
 * The BTC pairs collector and its routes, mountable under a base path on any of the report
 * services (production mounts it on the BTC curve service at /pairs) or run on its own.
 *
 * Every cycle (10 s by default): Kalshi's KXBTCD and KXBTC15M open markets, Polymarket US's
 * btc-strike-hourly, btc-strike-daily and btc-updown-15m events, the BRTI print. Pick the
 * 15-minute window, the next close and the 5 PM ET daily that share a close on both venues,
 * select at the money and one strike each way off BRTI, read the books at those strikes, score
 * each pair, price the bands between the strikes, read the index's trailing movement, keep the
 * gap history, push the result to anyone listening on the stream.
 *
 * Nothing here trades: public market-data endpoints only, no credentials loaded. The Launch
 * button posts the pair to the trader's own engine; the orders are his.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { BookReadError } from "./bookRead";
import { KALSHI_15M, KALSHI_HOURLY, DAILY_WINDOW_MS, FIFTEEN_WINDOW_MS, HOURLY_WINDOW_MS, dailyLadderFrom, fetchFeeTheta, fetchOpenMarkets, fifteenLadderFrom, hourlyLadderFrom, kalshiOrderbookUrl, readTopOnce } from "./kalshiLadders";
import { fetchBrtiCandles, fetchSeriesIdsBySlug, polyBookUrl, readBookOnce, readPolyUsLaddersForSeries } from "./polyUsLadders";
import { mergeLadders } from "./analytics";
import { EPISODE_KEEP, EPISODE_LABEL, EPISODE_MIN_CYCLES, STALE_AFTER_SEC, bundleOf, closeEpisodes, emptyEpisodeBook, episodeOf, fifteenSet, gapHistoryKey, horizonSet, lockEpisodesReport, lockSightings, pairId, pruneEpisodes, recordGaps, regimeOf, reportErrors, selectStrikes, staleBoundsFrom, stepEpisodes, strikeLevels, type Band, type EpisodeBook, type GapHistory, type Horizon, type HorizonSet, type LockEpisode, type PairsReport, type Place, type Regime, type StrikePair, type VenueUrls } from "./pairs";
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
  /** send: Launch POSTs the payload to the engine URL; open: Launch opens the engine URL with the pair in the query (the page can override it locally) */
  launchMode?: LaunchMode;
  sourceDeadlineMs?: number;
  /** how long one book may take to answer before its row says it timed out */
  bookTimeoutMs?: number;
  /** seconds beyond which a book copy is stale, per tenor; defaults to STALE_AFTER_SEC */
  staleAfterSec?: Partial<Record<Horizon, number>>;
  /** test seam */
  fetchImpl?: typeof fetch;
  /** test seam: our clock, ms */
  clock?: () => number;
  log?: (line: string) => void;
}

const POLY_SERIES = ["btc-strike-hourly", "btc-strike-daily", "btc-updown-15m"];
const CACHE_MS = 10 * 60_000;
/** index prints kept for the regime gauge: the hour plus a margin */
const SPOT_KEEP_MS = 65 * 60_000;

export type LaunchMode = "send" | "open";

/**
 * What the Launch button posts and what /api/pair returns: one pair with its context. `set`
 * is the tenor it sits in, `bands` the ranges between that tenor's strikes (Yes just below plus
 * No just above, with the legs on the venues that sell them cheapest), `regime` the index's
 * trailing movement. Fields are only ever added; `version` stays 1 until one changes meaning.
 */
export interface LaunchPayload {
  type: "atticus.btc_pair";
  version: 1;
  at: string;
  spotUsd: number;
  index: "BRTI";
  pair: StrikePair;
  set: { horizon: Horizon; settlesAt: string; secondsToClose: number; stepUsd: number; sigmaUsd: number | null; pick: string | null } | null;
  bands: Band[];
  regime: Regime | null;
}

export function launchPayload(report: PairsReport, pair: StrikePair): LaunchPayload {
  const set = pair.horizon === "fifteen" ? report.fifteen : pair.horizon === "daily" ? report.daily : report.hourly;
  return {
    type: "atticus.btc_pair",
    version: 1,
    at: report.at,
    spotUsd: report.spotUsd,
    index: "BRTI",
    pair,
    set: set ? { horizon: set.horizon, settlesAt: set.settlesAt, secondsToClose: set.secondsToClose, stepUsd: set.stepUsd, sigmaUsd: set.sigmaUsd, pick: set.pick } : null,
    bands: set?.bands ?? [],
    regime: report.regime,
  };
}

export class PairsCollector {
  readonly intervalSec: number;
  readonly urls: VenueUrls;
  readonly launchUrl: string;
  readonly launchMode: LaunchMode;
  private readonly dataDir: string;
  private readonly windowMs: number;
  private readonly deadlineMs: number;
  private readonly bookTimeoutMs: number;
  readonly staleAfterSec: Record<Horizon, number>;
  private readonly clock: () => number;
  /** books not answering as of the last cycle, by market id, so the log says it once and once more when it recovers */
  private readonly failing = new Map<string, { what: string; cycles: number; seenInCycle: number }>();
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly history: GapHistory = new Map();
  /** lock runs still going and the episodes kept; replaced whole every cycle */
  private episodes: EpisodeBook = emptyEpisodeBook();
  private readonly listeners = new Set<ServerResponse>();
  latest: PairsReport | null = null;
  private bodyHtml = "";
  private collectingSince: string | null = null;
  cycles = 0;
  lastError = "";
  private lastSpot = 0;
  /** [ms, usd] BRTI prints, about one a second, the last hour and a bit */
  private spots: Array<[number, number]> = [];
  private kalshiTheta: { at: number; value: number } | null = null;
  private fifteenTheta: { at: number; value: number } | null = null;
  private polySeriesIds: { at: number; value: string[] } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: PairsCollectorOptions = {}) {
    this.intervalSec = Math.max(5, opts.intervalSec ?? 10);
    this.dataDir = opts.dataDir ?? "/tmp/btc-pairs";
    this.windowMs = opts.windowMs ?? 120 * 60_000;
    this.deadlineMs = Math.max(5_000, opts.sourceDeadlineMs ?? 20_000);
    this.bookTimeoutMs = Math.min(this.deadlineMs, Math.max(1, opts.bookTimeoutMs ?? 8_000));
    this.staleAfterSec = { ...STALE_AFTER_SEC, ...(opts.staleAfterSec ?? {}) };
    this.clock = opts.clock ?? Date.now;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? ((line) => console.log(line));
    this.launchUrl = opts.launchUrl ?? "";
    this.launchMode = opts.launchMode === "open" ? "open" : "send";
    const kalshiUrl = opts.kalshiUrl || "https://kalshi.com/markets/kxbtcd";
    const polyUrl = opts.polyUrl || "https://polymarket.us/event/{event}";
    this.urls = {
      kalshi: ({ ticker, eventTicker }) => kalshiUrl.replace("{event}", eventTicker.toLowerCase()).replace("{ticker}", ticker.toLowerCase()),
      poly: ({ slug, eventSlug }) => polyUrl.replace("{event}", eventSlug).replace("{slug}", slug),
    };
  }

  /** Reload the gap history within the window and the lock episodes kept, and start the cycle. */
  start(): void {
    const loaded = this.loadGaps();
    const episodes = this.loadEpisodes();
    this.log(`[btc-pairs] data dir ${this.dataDir} · ${loaded} cycles of gap history reloaded · ${episodes} lock episodes reloaded · interval ${this.intervalSec}s`);
    void this.loop();
  }

  /** Stop the cycle. Lock runs still going end here and are written, so a clean stop loses none; a kill loses the ones open at that moment. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const closed = closeEpisodes(this.episodes, this.clock());
    this.episodes = closed.book;
    this.persistEpisodes(closed.finished);
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

  /**
   * Books for the three selected strikes on each venue (every strike on the one-strike window);
   * the rest of the ladder keeps its listing's top of book. Each book is its own read: one that
   * does not answer marks its own quote and leaves the others, and the tenor, standing.
   */
  private async readBooks(ladder: Ladder, spotUsd: number, health: PairsReport["health"], tag: string): Promise<void> {
    let quotes: VenueQuote[];
    if (tag === "fifteen") quotes = ladder.quotes;
    else {
      const picked = selectStrikes(strikeLevels(ladder), spotUsd);
      if (!picked) return;
      const keys = new Set([picked.below, picked.atm, picked.above].map((s) => ladder.buckets.find((b) => b.kind === "above" && b.level === s)?.key));
      quotes = ladder.quotes.filter((q) => keys.has(q.bucketKey));
    }
    const t0 = Date.now();
    const opts = { timeoutMs: this.bookTimeoutMs, clock: this.clock };
    await Promise.all(
      quotes.map(async (q: VenueQuote) => {
        try {
          // the book is the whole answer, price and size: an empty side in it is an empty side, whatever the listing still shows
          const b = q.venue === "kalshi" ? await readTopOnce(q.id, this.fetchImpl, opts) : await readBookOnce(q.id, this.fetchImpl, opts);
          q.bidCents = b.bidCents;
          q.askCents = b.askCents;
          q.bidQty = b.bidQty;
          q.askQty = b.askQty;
          q.read = { fetchedAtMs: b.fetchedAtMs, cacheAgeSec: b.cacheAgeSec, venueAtMs: b.venueAtMs, state: b.state };
          this.noteBook(q, null);
        } catch (err) {
          const e = err instanceof BookReadError ? err : new BookReadError("unreachable", q.venue === "kalshi" ? kalshiOrderbookUrl(q.id) : polyBookUrl(q.id), { detail: (err as Error).message?.slice(0, 120) });
          q.bidQty = 0;
          q.askQty = 0;
          q.failure = { kind: e.kind, status: e.status, url: e.url, detail: e.message, cacheAgeSec: e.cacheAgeSec };
          this.noteBook(q, e);
        }
      }),
    );
    const failed = quotes.filter((q) => q.failure).length;
    health[`${tag} books`] = failed ? { ok: false, ms: Date.now() - t0, detail: `${failed} of ${quotes.length} did not answer` } : { ok: true, ms: Date.now() - t0 };
  }

  /** The log line for a book that stops answering, and the one for when it answers again; the URL lives here and in the JSON, not on the page. */
  private noteBook(q: VenueQuote, err: BookReadError | null): void {
    const was = this.failing.get(q.id);
    if (!err) {
      if (was) {
        this.failing.delete(q.id);
        this.log(`[btc-pairs] book answering again: ${q.venue} ${q.id} after ${was.cycles} cycle${was.cycles === 1 ? "" : "s"} (${was.what})`);
      }
      return;
    }
    const what = err.message;
    if (was && was.what === what) {
      was.cycles += 1;
      was.seenInCycle = this.cycles;
      return;
    }
    this.failing.set(q.id, { what, cycles: (was?.cycles ?? 0) + 1, seenInCycle: this.cycles });
    this.log(`[btc-pairs] book not answering: ${q.venue} ${q.id} ${what}${err.cacheAgeSec !== null ? ` (held in the venue's cache ${err.cacheAgeSec}s)` : ""} ${err.url}`);
  }

  async collectOnce(now = new Date(this.clock())): Promise<PairsReport> {
    const health: PairsReport["health"] = {};
    const nowMs = now.getTime();

    this.kalshiTheta = await this.cached(this.kalshiTheta, () => fetchFeeTheta(KALSHI_HOURLY, this.fetchImpl), 0.07);
    this.fifteenTheta = await this.cached(this.fifteenTheta, () => fetchFeeTheta(KALSHI_15M, this.fetchImpl), 0.07);
    this.polySeriesIds = await this.cached(this.polySeriesIds, () => fetchSeriesIdsBySlug(POLY_SERIES, this.fetchImpl), []);

    // the first cycle backfills the hour of index prints the regime gauge reads; after that, the last two minutes
    const brtiFromSec = this.spots.length ? nowMs / 1000 - 120 : nowMs / 1000 - SPOT_KEEP_MS / 1000;
    const [kalshiRaw, kalshi15Raw, polyLadders, brti] = await Promise.all([
      this.timed("kalshi", health, () => fetchOpenMarkets(KALSHI_HOURLY, this.fetchImpl)),
      this.timed("kalshi 15m", health, () => fetchOpenMarkets(KALSHI_15M, this.fetchImpl)),
      this.timed("polymarket_us", health, () => readPolyUsLaddersForSeries(this.polySeriesIds?.value ?? [], this.fetchImpl, { upDown: true })),
      this.timed("brti", health, () => fetchBrtiCandles(brtiFromSec, nowMs / 1000, "1S", this.fetchImpl)),
    ]);

    let spotUsd = brti && brti.length ? brti[brti.length - 1].close : 0;
    let spotSource = "BRTI";
    if (!(spotUsd > 0)) {
      spotUsd = this.lastSpot;
      spotSource = "BRTI, last good print";
    } else this.lastSpot = spotUsd;
    if (brti) this.keepSpots(brti, nowMs);
    const regime = this.spots.length >= 2 ? regimeOf(this.spots, nowMs) : null;
    const volPct = regime?.m60?.volPct ?? regime?.m15?.volPct ?? null;

    const theta = this.kalshiTheta.value;
    const kHourly = kalshiRaw ? hourlyLadderFrom(kalshiRaw, theta, nowMs) : null;
    const kDaily = kalshiRaw ? dailyLadderFrom(kalshiRaw, theta, nowMs) : null;
    const kFifteen = kalshi15Raw ? fifteenLadderFrom(kalshi15Raw, this.fifteenTheta.value, nowMs) : null;
    const polyUpDown = (polyLadders ?? []).filter((l) => isUpDown(l));
    const polyStrikes = (polyLadders ?? []).filter((l) => !isUpDown(l));
    const pFifteen = polyLadderIn(polyUpDown, nowMs, 30_000, FIFTEEN_WINDOW_MS);
    const pHourly = polyLadderIn(polyStrikes, nowMs, 2 * 60_000, HOURLY_WINDOW_MS);
    const pDaily = polyLadderIn(polyStrikes, nowMs, HOURLY_WINDOW_MS, DAILY_WINDOW_MS);
    const fifteen = merged(kFifteen, pFifteen);
    const hourly = merged(kHourly, pHourly);
    const daily = merged(kDaily, pDaily);

    if (spotUsd > 0) {
      await Promise.all([
        fifteen ? this.readBooks(fifteen, spotUsd, health, "fifteen") : null,
        hourly ? this.readBooks(hourly, spotUsd, health, "hourly") : null,
        daily ? this.readBooks(daily, spotUsd, health, "daily") : null,
      ]);
      // a market that rolled off while its book was failing is no longer read, so it is forgotten here
      for (const [id, f] of this.failing) if (f.seenInCycle !== this.cycles) this.failing.delete(id);
    }

    // the books are in: every read age on the page and in the JSON is measured to this moment
    const pricedAtMs = Math.max(nowMs, this.clock());
    const setOpts = (h: Horizon) => ({ volPct, pricedAtMs, staleAfterSec: this.staleAfterSec[h] });
    const build = (h: Horizon, l: Ladder | null, polyId: string | null): HorizonSet | null =>
      l && spotUsd > 0 ? horizonSet(h, l, polyId, spotUsd, nowMs, this.history, this.urls, setOpts(h)) : null;
    const sets = [
      fifteen && spotUsd > 0 ? fifteenSet(fifteen, pFifteen?.id ?? null, spotUsd, nowMs, this.history, this.urls, setOpts("fifteen")) : null,
      build("hourly", hourly, pHourly?.id ?? null),
      build("daily", daily, pDaily?.id ?? null),
    ];
    recordGaps(this.history, sets, nowMs, this.windowMs);
    this.persistGaps(nowMs, sets);
    // three intervals without a cycle and a run is no longer known to be consecutive
    const stepped = stepEpisodes(this.episodes, lockSightings(sets), pricedAtMs, { maxGapMs: 3 * this.intervalSec * 1000 });
    this.episodes = stepped.book;
    this.persistEpisodes(stepped.finished);

    if (!this.collectingSince) this.collectingSince = now.toISOString();
    this.cycles += 1;
    const report: PairsReport = {
      at: now.toISOString(),
      pricedAt: new Date(pricedAtMs).toISOString(),
      spotUsd,
      spotSource,
      intervalSec: this.intervalSec,
      historyPoints: Math.max(0, ...[...this.history.values()].map((a) => a.length)),
      collectingSince: this.collectingSince,
      fifteen: sets[0],
      hourly: sets[1],
      daily: sets[2],
      regime,
      bundle: bundleOf(sets),
      staleAfterSec: this.staleAfterSec,
      health,
      errors: reportErrors(sets),
      lockEpisodes: lockEpisodesReport(this.episodes, pricedAtMs),
    };
    this.latest = report;
    this.bodyHtml = renderPairsBody(report);
    this.broadcast(report);
    return report;
  }

  /** Append this cycle's index prints (newer than what is kept) and drop what is older than the hour. */
  private keepSpots(candles: Array<{ ts: number; close: number }>, nowMs: number): void {
    const lastMs = this.spots.length ? this.spots[this.spots.length - 1][0] : 0;
    for (const c of candles) {
      const ms = c.ts * 1000;
      if (ms > lastMs && c.close > 0) this.spots.push([ms, c.close]);
    }
    const from = nowMs - SPOT_KEEP_MS;
    let drop = 0;
    while (drop < this.spots.length && this.spots[drop][0] < from) drop += 1;
    if (drop) this.spots.splice(0, drop);
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
    // what recordGaps kept, so a restart reloads the same window: gaps on stale reads are not persistence
    const rows = sets.flatMap((s) => (s ? s.pairs.filter((p) => p.gapCents !== null && p.freshness !== "stale").map((p) => [p.settlesAt, p.key, p.gapCents]) : []));
    if (!rows.length) return;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      appendFileSync(this.dayFile(atMs), `${JSON.stringify({ at: atMs, rows })}\n`);
    } catch (err) {
      this.lastError = `persist: ${(err as Error).message.slice(0, 80)}`;
    }
  }

  /** Finished episodes go to the day file of the day they ended, one a line, the way the gap history is kept. */
  private persistEpisodes(finished: LockEpisode[]): void {
    if (!finished.length) return;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      for (const e of finished) appendFileSync(join(this.dataDir, `episodes-${e.endedAt.slice(0, 10)}.jsonl`), `${JSON.stringify(e)}\n`);
    } catch (err) {
      this.lastError = `persist episodes: ${(err as Error).message.slice(0, 80)}`;
    }
  }

  /** Reload the episodes kept (today's, and the last EPISODE_KEEP per tenor of the three days before); older day files are deleted. */
  loadEpisodes(nowMs = this.clock()): number {
    if (!existsSync(this.dataDir)) return 0;
    const loaded: LockEpisode[] = [];
    for (const f of readdirSync(this.dataDir).filter((f: string) => f.startsWith("episodes-") && f.endsWith(".jsonl")).sort()) {
      const path = join(this.dataDir, f);
      const dayMs = Date.parse(f.slice(9, 19));
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
          const e = JSON.parse(line) as LockEpisode;
          if (typeof e.endedAt === "string" && Number.isFinite(Date.parse(e.endedAt)) && typeof e.horizon === "string") loaded.push(e);
        } catch {
          // a torn line at the end of a file is skipped
        }
      }
    }
    this.episodes = { open: this.episodes.open, finished: pruneEpisodes([...loaded, ...this.episodes.finished], nowMs) };
    return this.episodes.finished.length;
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
    return {
      warm: Boolean(this.latest),
      at: this.latest?.at ?? null,
      cycles: this.cycles,
      intervalSec: this.intervalSec,
      listeners: this.listeners.size,
      spotPrints: this.spots.length,
      regime: this.latest?.regime?.label ?? null,
      tenors: this.latest ? { fifteen: Boolean(this.latest.fifteen), hourly: Boolean(this.latest.hourly), daily: Boolean(this.latest.daily) } : undefined,
      booksNotAnswering: this.latest?.errors?.length ?? 0,
      lockEpisodesToday: this.latest?.lockEpisodes ? { fifteen: this.latest.lockEpisodes.fifteen.episodes, hourly: this.latest.lockEpisodes.hourly.episodes, daily: this.latest.lockEpisodes.daily.episodes } : undefined,
      lastError: this.lastError || undefined,
    };
  }

  /**
   * The pair asked for: by Kalshi ticker / Polymarket US slug (`id`), or by tenor and place
   * (`horizon=fifteen|hourly|daily`, `place=below|atm|above|pick`; `pick` is the tenor's
   * default Launch target, the cleanest scored pair).
   */
  findPair(params: URLSearchParams): StrikePair | null {
    const d = this.latest;
    if (!d) return null;
    const id = params.get("id");
    const all = [...(d.fifteen?.pairs ?? []), ...(d.hourly?.pairs ?? []), ...(d.daily?.pairs ?? [])];
    // a pair whose book did not answer is still found by that market's id, so the caller reads why instead of "no such pair"
    if (id) return all.find((p) => pairId(p) === id || p.kalshi?.id === id || p.poly?.id === id || p.errors.some((e) => e.id === id)) ?? null;
    const horizon = params.get("horizon") as Horizon | null;
    const place = (params.get("place") ?? "atm") as Place | "pick";
    const set = horizon === "daily" ? d.daily : horizon === "fifteen" ? d.fifteen : d.hourly;
    if (!set) return null;
    if (place === "pick") return set.pairs.find((p) => pairId(p) === set.pick) ?? null;
    return set.pairs.find((p) => p.place === place) ?? null;
  }

  /**
   * Serve one request whose path is already relative to the mount (`/`, `/fragment`,
   * `/api/pairs`, `/api/bundle`, `/api/pair`, `/api/episodes`, `/api/stream`). Returns false when the path is
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
    if (path === "/api/episodes") {
      // everything kept, not only today's latest few: for whoever wants to do his own arithmetic
      json(200, {
        label: EPISODE_LABEL,
        minCycles: EPISODE_MIN_CYCLES,
        keptPerTenorBeforeToday: EPISODE_KEEP,
        open: this.episodes.open.filter((r) => r.cycles >= EPISODE_MIN_CYCLES).map((r) => episodeOf(r, true)),
        episodes: [...this.episodes.finished].reverse(),
      });
      return true;
    }
    if (path === "/api/pair") {
      if (!d) {
        json(503, { ok: false, error: "warming up" });
        return true;
      }
      const p = this.findPair(url.searchParams);
      p ? json(200, launchPayload(d, p)) : json(404, { ok: false, error: "no such pair; use horizon=fifteen|hourly|daily&place=below|atm|above|pick or id=<Kalshi ticker | Polymarket US slug>" });
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
      res.end(renderPairsHtml(d, { token: opts.token, base: opts.base, launchUrl: this.launchUrl, launchMode: this.launchMode }));
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
    launchMode: env.BTC_PAIRS_LAUNCH_MODE === "open" ? "open" : "send",
    sourceDeadlineMs: Number(env.BTC_PAIRS_SOURCE_DEADLINE_MS || 20_000),
    bookTimeoutMs: Number(env.EVENT_FETCH_TIMEOUT_MS || 8_000),
    staleAfterSec: staleBoundsFrom(env.BTC_PAIRS_STALE_SECONDS),
  });
}

/** An up/down family ladder (price to beat as the strike) rather than a strike ladder, by its event slug. */
export function isUpDown(l: Ladder): boolean {
  return /updown/i.test(l.id);
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
