/**
 * The sports venues collector: the cycle, the snapshot store and the routes, as one object two
 * hosts share. scripts/sportsVenuesReportService.ts runs it on its own port; the BTC curve
 * service mounts it at /sports so it costs no second web service (see `mountSports`).
 *
 * Read-only: no credentials are loaded, only public market-data endpoints.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { maintainLines, parseBudgetMb, parseRetention, type Budget, type Retention } from "../btcCurve/dayFiles";
import type { PageLink } from "../btcCurve/pageLinks";
import { assembleGames, readKalshiGames, readNovigListings, readPolyUsListings, type KalshiGame } from "./readers";
import { readProphetXListings } from "./prophetx";
import { cryptocomFeeFromEnv, newCryptocomCache, readCryptocomListings, type CryptocomFee } from "./cryptocom";
import { HolderRecord } from "./holder";
import { buildReport, type ReportData } from "./report";
import { renderReportHtml } from "./reportHtml";
import { AUDIENCES, audienceOf, audienceState, keyMatches, type AudienceState } from "./audiences";
import { lockChoices, lockNow, lockPast, pastMoments, type LockQuote, type PastMoment } from "./lockNow";
import { PAST_PREFIX, bookCountOf, renderProspectHtml, type ProspectLock } from "./prospectHtml";
import { renderLockHtml, renderReplayHtml } from "./replayHtml";
import { TapeRecord } from "./tape";
import { SnapshotStore } from "./store";
import { VENUES, type Game, type Snapshot, type VenueListing } from "./types";

export interface SportsCollectorOptions {
  dataDir: string;
  intervalSec?: number;
  horizonMs?: number;
  sourceDeadlineMs?: number;
  /** how many hours of snapshots the page's window sections read; the day files keep every snapshot either way */
  windowHours?: number;
  retention?: Retention;
  budget?: Budget;
  log?: (line: string) => void;
  /** Crypto.com's exchange fee as it is counted; the flat fee of its schedule when not given */
  cryptocomFee?: CryptocomFee;
  /** test seam: the venue reads of one cycle */
  readGames?: (now: Date, health: Snapshot["health"]) => Promise<Game[]>;
  /** test seams of the trade tape: its fetch, and where the games shipped with the code are read from (null for none) */
  tape?: { fetchImpl?: typeof fetch; seedDir?: string | null; host?: string };
  /** the key of each page made for one reader, by its id (audiences.ts); a page with no key is off */
  audienceKeys?: Record<string, string | undefined>;
  /** the keys that open the host's own pages: a reader's page may not share one */
  hostKeys?: string[];
}

export class SportsCollector {
  readonly dataDir: string;
  readonly intervalSec: number;
  readonly windowHours: number;
  private readonly horizonMs: number;
  private readonly deadlineMs: number;
  private readonly retention: Retention;
  private readonly store: SnapshotStore;
  private readonly sincePath: string;
  private readonly holder: HolderRecord;
  private readonly tape: TapeRecord;
  private readonly audiences: AudienceState[];
  private readonly log: (line: string) => void;
  private readonly readGames: (now: Date, health: Snapshot["health"]) => Promise<Game[]>;
  private readonly cryptocomFee: CryptocomFee;
  private readonly cryptocomCache = newCryptocomCache();
  private collectingSince: string | null = null;
  private sinceOnDisk = false;
  private cycles = 0;
  private lastError = "";
  private reloaded: { points: number; ms: number; error?: string } | null = null;
  private report: { at: string; points: number; data: ReportData } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(opts: SportsCollectorOptions) {
    this.dataDir = opts.dataDir;
    this.intervalSec = Math.max(20, opts.intervalSec || 60);
    this.windowHours = Math.max(1, opts.windowHours || 72);
    this.horizonMs = opts.horizonMs ?? 3 * 86_400_000;
    this.deadlineMs = Math.max(10_000, opts.sourceDeadlineMs || 45_000);
    this.retention = opts.retention ?? parseRetention(undefined, "retainDays");
    this.log = opts.log ?? ((line) => console.log(line));
    this.cryptocomFee = opts.cryptocomFee ?? cryptocomFeeFromEnv({});
    this.readGames = opts.readGames ?? ((now, health) => this.readVenues(now, health));
    this.store = new SnapshotStore(opts.dataDir, { keepHours: this.windowHours, retention: this.retention, budget: opts.budget });
    this.sincePath = join(opts.dataDir, "collecting-since.txt");
    this.holder = new HolderRecord(join(opts.dataDir, "holder-count.json"), (what, write) => this.store.guardWrite(what, write));
    this.audiences = AUDIENCES.map((a) => audienceState(a, opts.audienceKeys?.[a.id], opts.hostKeys ?? []));
    this.tape = new TapeRecord({
      dir: join(opts.dataDir, "tape"),
      fee: { theta: this.cryptocomFee.theta, flat: this.cryptocomFee.flatCents },
      guard: (what, write) => this.store.guardWrite(what, write),
      log: this.log,
      ...(opts.tape ?? {}),
    });
    try {
      if (existsSync(this.sincePath)) this.collectingSince = readFileSync(this.sincePath, "utf8").trim() || null;
    } catch {
      // a marker that cannot be read is written again by the first cycle that can
    }
    this.sinceOnDisk = this.collectingSince !== null;
  }

  /**
   * One source per cycle gets a ceiling; past it the source is recorded as down and the cycle
   * goes on. `notes` is what a source that answered still left off the board, in words.
   */
  private async timed<T>(name: string, health: Snapshot["health"], fn: () => Promise<T>, notes: string[] = []): Promise<T | null> {
    const t0 = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${this.deadlineMs / 1000}s`)), this.deadlineMs);
    });
    try {
      const v = await Promise.race([fn(), deadline]);
      health[name] = { ok: true, ms: Date.now() - t0, ...(notes.length ? { detail: [...new Set(notes)].join("; ").slice(0, 240) } : {}) };
      return v;
    } catch (err) {
      health[name] = { ok: false, ms: Date.now() - t0, detail: (err as Error).message.slice(0, 120) };
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async readVenues(now: Date, health: Snapshot["health"]): Promise<Game[]> {
    const nowMs = now.getTime();
    const kalshi: KalshiGame[] = (await this.timed("kalshi", health, () => readKalshiGames({ nowMs, horizonMs: this.horizonMs }))) ?? [];
    const games = kalshi.map((k) => k.game);
    const prophetxNotes: string[] = [];
    const cryptocomNotes: string[] = [];
    const [poly, novig, prophetx, cryptocom] = await Promise.all([
      this.timed("polymarket_us", health, () => readPolyUsListings(games)),
      this.timed("novig", health, () => readNovigListings(games, { nowMs })),
      this.timed("prophetx", health, () => readProphetXListings(games, { notes: prophetxNotes }), prophetxNotes),
      this.timed("cryptocom", health, () => readCryptocomListings(games, { nowMs, notes: cryptocomNotes, cache: this.cryptocomCache, fee: this.cryptocomFee }), cryptocomNotes),
    ]);
    const none = new Map<string, VenueListing>();
    return assembleGames(kalshi, poly ?? none, novig ?? none, prophetx ?? none, cryptocom ?? none);
  }

  async collectOnce(now = new Date()): Promise<Snapshot> {
    const health: Snapshot["health"] = {};
    const snapshot: Snapshot = { at: now.toISOString(), games: await this.readGames(now, health), health };
    this.store.append(snapshot);
    this.holder.add(this.store.getHistory().slice(-1));
    this.tape.track(snapshot.games, this.cryptocomCache.pairs, now.getTime());
    const since = this.collectingSince ?? snapshot.at;
    this.collectingSince = since;
    // tried again every cycle until it lands: a marker that failed once would otherwise never be written
    if (!this.sinceOnDisk) this.sinceOnDisk = this.store.guardWrite("collecting-since.txt", () => writeFileSync(this.sincePath, since));
    this.cycles += 1;
    if (this.cycles % 60 === 0) this.maintain(now.getTime());
    return snapshot;
  }

  /** The hourly pass over the day files, never awaited by a cycle: the retention sweep and at most one closed day gzipped. */
  private maintain(nowMs = Date.now()): void {
    void this.store.maintain(nowMs).then((r) => {
      for (const line of maintainLines(r, this.retention)) this.log(`[sports-venues] ${line}`);
    });
  }

  /** Reload the window from the day files. It never throws: what went wrong is kept for /healthz. */
  async load(nowMs = Date.now()): Promise<number> {
    const t0 = Date.now();
    try {
      const points = await this.store.load(nowMs);
      // snapshots in the window the holder count has not seen (taken before it existed, or while its file could not be written)
      this.holder.add(this.store.getHistory());
      await this.tape.boot(nowMs);
      this.reloaded = { points, ms: Date.now() - t0 };
      this.log(`[sports-venues] data dir ${this.dataDir} · ${points} snapshots reloaded in ${Math.round(this.reloaded.ms / 1000)}s · window ${this.windowHours}h · interval ${this.intervalSec}s · ${this.store.startupLine()}`);
      return points;
    } catch (err) {
      this.reloaded = { points: 0, ms: Date.now() - t0, error: (err as Error).message.slice(0, 160) };
      this.log(`[sports-venues] the reload on start-up failed (${this.reloaded.error}); the cycles start without it`);
      // the tape does not depend on the window: its own files are read whether the snapshots were or not
      await this.tape.boot(nowMs);
      return 0;
    }
  }

  /** The cycles start whether the reload ends well or not: recording new data never waits on old data. */
  start(): void {
    void this.load().then(() => {
      if (this.stopped) return;
      this.maintain();
      void this.loop();
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async loop(): Promise<void> {
    try {
      await this.collectOnce();
      this.lastError = "";
      // the exchange's trades for the games on the board: off the cycle, so a slow tape never delays a snapshot
      void this.tapePass();
    } catch (err) {
      this.lastError = (err as Error).message.slice(0, 200);
      this.log(`[sports-venues] cycle failed: ${this.lastError}`);
    }
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.loop(), this.intervalSec * 1000);
  }

  /** One pass of the trade tape over the games being recorded: read what is new, close what is over. It never throws. */
  tapePass(nowMs = Date.now()): Promise<void> {
    return this.tape.pass(nowMs, this.store.getHistory());
  }

  private get feeTerms(): { theta: number; flat: number } {
    return { theta: this.cryptocomFee.theta, flat: this.cryptocomFee.flatCents };
  }

  private get feeWords(): string {
    return this.cryptocomFee.flatCents > 0 ? `${this.cryptocomFee.flatCents}¢ a contract` : `${this.cryptocomFee.theta}·p·(1−p) a contract`;
  }

  health(): Record<string, unknown> {
    const latest = this.store.getLatest();
    return {
      warm: Boolean(latest),
      at: latest?.at ?? null,
      games: latest?.games.length ?? 0,
      cycles: this.cycles,
      historyPoints: this.store.getHistory().length,
      windowHours: this.windowHours,
      intervalSec: this.intervalSec,
      reload: this.reloaded ?? "in progress",
      venuesNotAnswering: latest ? Object.entries(latest.health).filter(([, h]) => !h.ok).map(([name, h]) => `${name}: ${h.detail ?? "down"}`) : [],
      // a venue that answered and still left games off the board, in its reader's words
      venueNotes: latest ? Object.entries(latest.health).filter(([, h]) => h.ok && h.detail).map(([name, h]) => `${name}: ${h.detail}`) : [],
      // games each venue is on, in the latest snapshot: a venue that answers with nothing shows as 0 here
      listed: latest ? Object.fromEntries(VENUES.map((v) => [v, latest.games.filter((g) => g.listings.some((l) => l.venue === v)).length])) : undefined,
      lastError: this.lastError || undefined,
      holderCount: this.holder.summary(),
      tape: this.tape.health(),
      // in order, without a name: /healthz needs no key
      audiencePages: this.audiences.map((a) => (a.key ? "on" : `off: ${a.off}`)),
      data: this.store.dataHealth(),
    };
  }

  /**
   * The report over the window, built once per snapshot and kept until the next: the window
   * tally walks every snapshot kept, so a page left refreshing costs one pass a cycle, not one
   * per view.
   */
  reportData(): ReportData | null {
    const latest = this.store.getLatest();
    if (!latest) return null;
    const history = this.store.getHistory();
    if (!this.report || this.report.at !== latest.at || this.report.points !== history.length) {
      const data = buildReport({ snapshot: latest, history, intervalSec: this.intervalSec, collectingSince: this.collectingSince, windowHours: this.windowHours, holder: this.holder.report() });
      this.report = { at: latest.at, points: history.length, data };
    }
    return this.report.data;
  }

  /**
   * Serve one request whose path is already relative to the mount (`/`, `/api/report`,
   * `/api/latest`, `/replay`, `/api/replay`, `/lock`, `/api/lock`). Returns false when the path is not one of ours so the host can 404 it. The
   * host has already checked its access key.
   *
   * `lockPages: false` leaves the replay and the lock out: a host whose key is held by someone
   * the Lock in pages are not for serves the board alone, and those pages are reached under a
   * reader's own key (audience()).
   */
  handle(_req: IncomingMessage, res: ServerResponse, path: string, url: URL, given: { links?: PageLink[]; lockPages?: boolean } = {}): boolean {
    const lockPages = given.lockPages !== false;
    if (!lockPages && ["/replay", "/api/replay", "/lock", "/api/lock"].includes(path)) return false;
    // on its own there is no host to say where the pages sit: they are at the root, under the key this request came with
    const key = url.searchParams.get("k");
    const opts = { links: given.links ?? (key ? [{ label: "Sports", href: `/?k=${encodeURIComponent(key)}` }] : undefined) };
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const html = (body: string) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    };
    if (path === "/api/replay") {
      json(200, { fee: this.feeTerms, report: this.tape.report(), recording: this.tape.recording() });
      return true;
    }
    if (path === "/replay") {
      html(renderReplayHtml(this.tape.report(), this.tape.recording(), { refreshSec: this.intervalSec * 5, links: opts.links, feeWords: this.feeWords }));
      return true;
    }
    if (path === "/lock" || path === "/api/lock") {
      const latest = this.store.getLatest();
      const nowMs = Date.now();
      const choices = latest ? lockChoices(latest.games, nowMs) : [];
      const selected = url.searchParams.get("game") || choices[0]?.value || "";
      const contracts = url.searchParams.get("n") || "20";
      const paid = url.searchParams.get("paid") || "";
      const quote = latest && selected ? lockNow(latest.games, { game: selected, contracts, paid }, this.feeTerms, nowMs) : null;
      if (path === "/api/lock") json(200, { at: latest?.at ?? null, fee: this.feeTerms, quote, choices });
      else html(renderLockHtml({ choices, quote, selected, contracts, paid, at: latest?.at ?? null, refreshSec: this.intervalSec, links: opts.links }));
      return true;
    }
    if (path === "/api/report") {
      const data = this.reportData();
      data ? json(200, data) : json(503, { ok: false, error: "warming up" });
      return true;
    }
    if (path === "/api/latest") {
      const latest = this.store.getLatest();
      latest ? json(200, latest) : json(503, { ok: false, error: "warming up" });
      return true;
    }
    if (path === "/" || path === "") {
      const data = this.reportData();
      res.writeHead(data ? 200 : 503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(
        data
          ? renderReportHtml(data, { refreshSec: this.intervalSec, links: opts.links, lockPages })
          : `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="10"><title>warming up</title><p style="font:16px system-ui;padding:40px">First snapshot in progress. This page refreshes itself.</p>`,
      );
      return true;
    }
    return false;
  }

  /**
   * A page made for one reader (audiences.ts), under that reader's own key. True when the
   * address is one of theirs, whatever the key: a wrong key is a 404 here and never reaches the
   * host's own pages. Checked before the host's key, which does not open these.
   */
  audience(_req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    const found = audienceOf(this.audiences, url.pathname);
    if (!found) return false;
    const { state, sub } = found;
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" });
      res.end(body);
    };
    if (!state.key || !keyMatches(url.searchParams.get("k"), state.key)) {
      send(404, "text/plain", "not found");
      return true;
    }
    const q = `?k=${encodeURIComponent(state.key)}`;
    if (sub === "/detail") {
      const nav = `<nav style="font-size:13px;margin:0 0 10px;color:#6b7280"><a href="${state.base}${q}">Back to the summary</a> · <b>Every table</b></nav>`;
      send(200, "text/html", renderReplayHtml(this.tape.report(), this.tape.recording(), { feeWords: this.feeWords, nav }));
      return true;
    }
    if (sub === "/" || sub === "/api") {
      const input = {
        audience: { name: state.name, base: state.base },
        key: state.key,
        report: this.tape.report(),
        recording: this.tape.recording().length,
        fee: this.feeTerms,
        feeWords: this.feeWords,
        book: bookCountOf(this.holder.report()),
        lock: this.audienceLock(url),
      };
      if (sub === "/api") {
        const { key: _key, ...shown } = input;
        send(200, "application/json", JSON.stringify(shown));
      } else send(200, "text/html", renderProspectHtml(input));
      return true;
    }
    send(404, "text/plain", "not found");
    return true;
  }

  /**
   * The position the reader's page shows a lock on: a side on the board now, or a side of a
   * finished game at a moment of it. With nothing asked for, the latest real ticket the page
   * tells the story of, so the card under the story is that ticket.
   */
  private audienceLock(url: URL): ProspectLock {
    const latest = this.store.getLatest();
    const nowMs = Date.now();
    const live = latest ? lockChoices(latest.games, nowMs) : [];
    const ask = (name: string) => url.searchParams.get(name) || "";
    let selected = ask("game");
    let contracts = ask("n");
    let paid = ask("paid");
    let at = ask("at");
    if (!selected) {
      const stories = this.tape.report().stories;
      const story = stories.find((s) => !s.won) ?? stories[0];
      if (story) {
        selected = `${PAST_PREFIX}${story.event}|${story.side}`;
        contracts ||= String(story.qty / 100);
        paid ||= String(story.price / 100);
        at ||= String(story.atMs);
      } else selected = live[0]?.value ?? "";
    }
    contracts ||= "50";
    let quote: LockQuote | null = null;
    let moments: PastMoment[] = [];
    if (selected.startsWith(PAST_PREFIX)) {
      const [event, side] = selected.slice(PAST_PREFIX.length).split("|");
      const game = this.tape.capsule(event);
      if (game && (side === "away" || side === "home")) {
        quote = lockPast(game, { side, atMs: at ? Number(at) : undefined, contracts, paid }, this.feeTerms);
        moments = pastMoments(game, side, this.feeTerms);
      }
    } else if (latest && selected) quote = lockNow(latest.games, { game: selected, contracts, paid }, this.feeTerms, nowMs);
    return { live, moments, quote, selected, contracts, paid, bookAt: latest?.at ?? null };
  }
}

/**
 * The collector as SPORTS_VENUES_* configures it; shared by the standalone script and the BTC
 * curve service's mount. `defaults` is what the host passes for a setting SPORTS_VENUES_* leaves
 * unset: the data dir under its own, its own retention setting so one window covers the disk,
 * and the hours of history it has the memory to hold.
 */
export function sportsCollectorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  defaults: { dataDir?: string; retainDays?: string; retainSetting?: string; windowHours?: number } = {},
): SportsCollector {
  const own = (env.SPORTS_VENUES_RETAIN_DAYS ?? "").trim() !== "";
  return new SportsCollector({
    dataDir: env.SPORTS_VENUES_DATA_DIR || defaults.dataDir || "/tmp/sports-venues",
    intervalSec: Number(env.SPORTS_VENUES_INTERVAL_SEC || 60),
    horizonMs: Math.max(1, Number(env.SPORTS_VENUES_HORIZON_DAYS || 3)) * 86_400_000,
    sourceDeadlineMs: Number(env.SPORTS_VENUES_SOURCE_DEADLINE_MS || 45_000),
    windowHours: Number(env.SPORTS_VENUES_WINDOW_HOURS || defaults.windowHours || 72),
    retention:
      own || defaults.retainDays === undefined
        ? parseRetention(env.SPORTS_VENUES_RETAIN_DAYS, "SPORTS_VENUES_RETAIN_DAYS")
        : parseRetention(defaults.retainDays, defaults.retainSetting ?? "the host service's retention setting"),
    budget: parseBudgetMb(env.SPORTS_VENUES_DISK_BUDGET_MB, "SPORTS_VENUES_DISK_BUDGET_MB"),
    cryptocomFee: cryptocomFeeFromEnv(env),
    audienceKeys: Object.fromEntries(AUDIENCES.map((a) => [a.id, env[a.keyEnv]])),
    hostKeys: [env.BTC_CURVE_TOKEN, env.SPORTS_VENUES_TOKEN].flatMap((k) => (k ? [k] : [])),
  });
}

const told = (err: unknown): string => String((err as Error)?.message ?? err).slice(0, 200);

/** What a host holds of the sports collector: the same four calls, none of which can throw into the host. */
export interface SportsMount {
  /** null when the collector could not be built (its data dir, a setting) */
  readonly collector: SportsCollector | null;
  start(): void;
  stop(): void;
  health(): Record<string, unknown>;
  handle(req: IncomingMessage, res: ServerResponse, path: string, url: URL, opts?: { links?: PageLink[]; lockPages?: boolean }): boolean;
  /** a page made for one reader, under that reader's own key; true when the address is one of theirs */
  audience(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
}

/**
 * The collector behind a boundary for a host whose own pages must not depend on it. A fault in
 * building it, starting it, serving a request or reading its health becomes `mountError` on the
 * host's /healthz and a 500 on that one sports request; the host's own routes never see it.
 */
export function mountSports(make: () => SportsCollector, log: (line: string) => void = (line) => console.error(line)): SportsMount {
  let mountError = "";
  const fault = (what: string, err: unknown): void => {
    mountError = `${what}: ${told(err)} (${new Date().toISOString()})`;
    log(`[sports-venues] ${mountError}; the host's own pages are not affected`);
  };
  let collector: SportsCollector | null = null;
  try {
    collector = make();
  } catch (err) {
    fault("the sports collector could not be set up", err);
  }
  return {
    collector,
    start() {
      try {
        collector?.start();
      } catch (err) {
        fault("the sports collector could not be started", err);
      }
    },
    stop() {
      try {
        collector?.stop();
      } catch {
        // the host is shutting down either way
      }
    },
    health() {
      try {
        return { ...(collector ? collector.health() : { warm: false }), mountError: mountError || undefined };
      } catch (err) {
        fault("the sports health could not be read", err);
        return { warm: false, mountError };
      }
    },
    audience(req, res, url) {
      try {
        return collector ? collector.audience(req, res, url) : false;
      } catch (err) {
        fault(`a reader's page failed (${url.pathname})`, err);
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        if (!res.writableEnded) res.end("This page failed on this request.");
        return true;
      }
    },
    handle(req, res, path, url, opts) {
      try {
        if (collector) return collector.handle(req, res, path, url, opts);
        res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: `The sports page is not running. ${mountError}` }));
        return true;
      } catch (err) {
        fault(`a sports request failed (${path})`, err);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        if (!res.writableEnded) res.end(JSON.stringify({ ok: false, error: "The sports page failed on this request. The other pages of this service are not affected." }));
        return true;
      }
    },
  };
}
