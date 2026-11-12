/**
 * The trade tape of Crypto.com's exchange, kept per game, and the replay over it.
 *
 * The exchange publishes every trade on a contract (GET /get-trades, no key): time, size, price
 * and the taker's side. It stops publishing a game's trades within about a day and a half of
 * the game (read 12 November 2026: the night before's were whole, the night before that's were
 * gone), so they are only ever ours if they are read while the game is listed. This keeps them.
 *
 * One append-only file per game, `<event>.tape.jsonl`, a line at a time:
 *   {"k":"g",...}                          the game: event, league, clubs, scheduled start, the
 *                                          two contracts. Written again if the start moves.
 *   ["t",side,ms,"qty","price",buy,id]     a trade as the venue wrote it: side "a" away or "h"
 *                                          home, quantity and price the venue's own strings,
 *                                          buy 1 when the taker bought, the venue's trade id.
 *   ["b",side,ms,bidCents,qty]             the best bid of that side's book as the collector read
 *                                          it, one line per snapshot in the window, written when
 *                                          the game is closed.
 *   {"k":"r",...}                          the result, last: the game is closed and its file is
 *                                          never written again.
 * `replay.json` beside them is derived: each closed game's replay (tapeReplay.ts), so the page
 * does not read every file on every view. It is worked out again from the files when it is
 * missing, unreadable, of another version or of another fee.
 *
 * Wire facts (read 12 November 2026):
 *   GET /get-trades?instrument_name=<contract>&count=150&start_ts=1[&end_ts=<ms>]
 *     -> newest first: {d: trade id, the match time in nanoseconds; t: ms; q: "55.57"; p: "0.34";
 *        s: "buy" | "sell", the taker's side}. count above 150 is refused. end_ts includes that
 *        millisecond. The same trade's `t` was seen a millisecond apart between two calls, so
 *        the time kept is the id's.
 *     start_ts MUST be sent. Without it the venue looks back 24 hours from end_ts (from now
 *     when there is none) and answers a short or empty page although older trades exist: a
 *     game's first day or two of trading is then silently missing. With start_ts=1 a page of
 *     fewer than 150 is the end of the tape.
 *   A contract the venue has delisted answers HTTP 400. Both contracts of a game were still
 *   readable 40 hours after its start; for games four days old one of the two was gone.
 *
 * WHEN A GAME IS OVER. Its last trade is half an hour old, four and a half hours have passed
 * since the scheduled start, and the tape's last prints give a result (tapeReplay.ts). A game
 * with no such result thirty hours after its start is closed without one and not counted.
 *
 * Read-only: public market data, no key, nothing here can place an order.
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FeeTerms } from "./analytics";
import { BadArgument, cryptocomHost, getResult } from "./cryptocom";
import { priceOfDollars } from "./lockMath";
import type { HistoryPoint } from "./store";
import { REPLAY_VERSION, newerId, parseCapsule, replayGame, sideCode, sumReplays, winnerFromLastPrices, type BookLine, type Capsule, type GameMeta, type GameReplay, type HeadLine, type ReplayReport, type ResultLine, type TradeLine } from "./tapeReplay";
import { SIDES, type Game, type Side } from "./types";

export const TAPE_PAGE = 150;
/** pages read back for one contract in one pass: 30,000 trades */
export const TAPE_MAX_PAGES = 200;
/** a game this close to its start, or past it, is read every pass; one further off this often */
export const TAPE_NEAR_MS = 30 * 60_000;
export const TAPE_FAR_EVERY_MS = 20 * 60_000;
export const TAPE_SETTLE_AFTER_MS = 4.5 * 3_600_000;
export const TAPE_QUIET_MS = 30 * 60_000;
export const TAPE_GIVE_UP_MS = 30 * 3_600_000;

const FILE = /^([A-Za-z0-9._-]+)\.tape\.jsonl$/;
const fileOf = (event: string): string => `${event}.tape.jsonl`;
const safe = (event: string): boolean => /^[A-Za-z0-9._-]+$/.test(event);

interface RawTrade {
  d?: string | number;
  t?: number;
  q?: string | number;
  p?: string | number;
  s?: string;
}

/** The trade's time: its id is the match time in nanoseconds; the venue's `t` when the id is not that. */
export function tradeMs(id: string, t: number): number {
  if (/^\d{19}$/.test(id)) {
    const ms = Number(BigInt(id) / 1_000_000n);
    if (Math.abs(ms - t) <= 86_400_000) return ms;
  }
  return t;
}

interface Active {
  meta: GameMeta & { symbols: Record<Side, string> };
  lastId: Record<Side, string>;
  lastPrice: Record<Side, number | null>;
  lastTradeMs: number;
  trades: number;
  nextPollMs: number;
  /** in words, when a pass could not read back as far as the last trade kept */
  gap?: string;
}

export interface TapeOptions {
  dir: string;
  fee: FeeTerms;
  /** the store's guarded write: a filesystem failure is recorded on /healthz and false returned */
  guard?: (what: string, write: () => void) => boolean;
  fetchImpl?: typeof fetch;
  host?: string;
  log?: (line: string) => void;
  /** closed games shipped with the code, copied in when the disk has no file for them; null for none */
  seedDir?: string | null;
}

export const TAPE_SEED_DIR = fileURLToPath(new URL("./tapeSeed/", import.meta.url));

const yieldToOthers = (): Promise<void> => new Promise((r) => setImmediate(r));

async function pooled<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const worker = async () => {
    for (let x = queue.shift(); x !== undefined; x = queue.shift()) await fn(x);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

export class TapeRecord {
  private readonly dir: string;
  private readonly fee: FeeTerms;
  private readonly guard: (what: string, write: () => void) => boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly host: string;
  private readonly log: (line: string) => void;
  private readonly seedDir: string | null;
  private readonly active = new Map<string, Active>();
  private readonly replays = new Map<string, GameReplay>();
  private booted = false;
  private busy = false;
  private revision = 0;
  private cached: { revision: number; report: ReplayReport } | null = null;
  private seeded = 0;
  private lastPassAt: string | null = null;
  private lastError = "";
  private note = "";
  private readonly read = new Map<string, Capsule>();

  constructor(opts: TapeOptions) {
    this.dir = opts.dir;
    this.fee = { theta: opts.fee.theta, ...(opts.fee.flat ? { flat: opts.fee.flat } : {}) };
    this.guard =
      opts.guard ??
      ((_what, write) => {
        write();
        return true;
      });
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.host = opts.host ?? cryptocomHost();
    this.log = opts.log ?? (() => {});
    this.seedDir = opts.seedDir === undefined ? TAPE_SEED_DIR : opts.seedDir;
  }

  private get replayPath(): string {
    return join(this.dir, "replay.json");
  }

  /** The stored replays, when they are this version's and this fee's. */
  private readStored(): void {
    try {
      if (!existsSync(this.replayPath)) return;
      const raw = JSON.parse(readFileSync(this.replayPath, "utf8")) as { v?: number; fee?: FeeTerms; games?: Record<string, GameReplay> };
      if (raw?.v !== REPLAY_VERSION || JSON.stringify(raw.fee) !== JSON.stringify(this.fee) || typeof raw.games !== "object" || raw.games === null) return;
      for (const [event, g] of Object.entries(raw.games)) if (g?.v === REPLAY_VERSION && g.event === event) this.replays.set(event, g);
    } catch {
      this.note = "the stored replay could not be read; it is worked out again from the games' files";
    }
  }

  private save(): boolean {
    this.revision += 1;
    return this.guard("tape/replay.json", () => {
      const tmp = `${this.replayPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: REPLAY_VERSION, fee: this.fee, games: Object.fromEntries(this.replays) }));
      renameSync(tmp, this.replayPath);
    });
  }

  private lines(event: string): string[] {
    return readFileSync(join(this.dir, fileOf(event)), "utf8").split("\n").filter(Boolean);
  }

  /**
   * Start-up: the games shipped with the code that the disk does not have, then every game file
   * on the disk. A closed game with no stored replay is replayed; an open one is picked up where
   * its file ends. It never throws: what went wrong is kept for /healthz.
   */
  async boot(nowMs = Date.now()): Promise<void> {
    try {
      this.guard("tape", () => mkdirSync(this.dir, { recursive: true }));
      this.readStored();
      if (this.seedDir && existsSync(this.seedDir)) {
        for (const name of readdirSync(this.seedDir)) {
          if (!FILE.test(name) || existsSync(join(this.dir, name))) continue;
          if (this.guard(`tape/${name}`, () => copyFileSync(join(this.seedDir as string, name), join(this.dir, name)))) this.seeded += 1;
        }
      }
      let replayed = 0;
      for (const name of existsSync(this.dir) ? readdirSync(this.dir) : []) {
        const event = FILE.exec(name)?.[1];
        if (!event || this.replays.has(event) || this.active.has(event)) continue;
        const game = parseCapsule(this.lines(event));
        if (!game) continue;
        if (game.winner !== undefined) {
          this.replays.set(event, replayGame(game, this.fee));
          replayed += 1;
        } else if (game.symbols) {
          const last = (s: Side): number | null => (game.trades[s].length ? game.trades[s][game.trades[s].length - 1].price : null);
          this.active.set(event, {
            meta: { ...game, symbols: game.symbols },
            lastId: game.lastId,
            lastPrice: { away: last("away"), home: last("home") },
            lastTradeMs: Math.max(0, ...SIDES.map((s) => game.trades[s][game.trades[s].length - 1]?.t ?? 0)),
            trades: game.trades.away.length + game.trades.home.length,
            nextPollMs: nowMs,
          });
        }
        await yieldToOthers();
      }
      if (replayed) this.save();
      this.revision += 1;
      this.log(`[sports-venues] trade tape: ${this.replays.size} closed game${this.replays.size === 1 ? "" : "s"} (${replayed} replayed now, ${this.seeded} copied in from the code), ${this.active.size} being recorded`);
    } catch (err) {
      this.lastError = `start-up: ${(err as Error).message.slice(0, 160)}`;
      this.log(`[sports-venues] trade tape: ${this.lastError}`);
    } finally {
      this.booted = true;
    }
  }

  /**
   * The games of this snapshot Crypto.com lists, with their two contracts: a game not seen
   * before gets its file, and a start the venue moved is written down.
   */
  track(games: Game[], pairs: Map<string, Record<Side, string>>, nowMs = Date.now()): void {
    if (!this.booted) return;
    for (const g of games) {
      const l = g.listings.find((x) => x.venue === "cryptocom");
      const symbols = l ? pairs.get(l.id) : undefined;
      if (!l || !symbols || !safe(l.id) || this.replays.has(l.id)) continue;
      const startMs = Date.parse(l.startsAt ?? g.startsAt);
      if (!Number.isFinite(startMs)) continue;
      const meta = { event: l.id, league: g.league, key: g.key, awayName: g.awayName, homeName: g.homeName, startMs, symbols };
      const held = this.active.get(l.id);
      if (held && held.meta.startMs === startMs && held.meta.key === g.key && held.meta.symbols.away === symbols.away && held.meta.symbols.home === symbols.home) continue;
      const head: HeadLine = { k: "g", v: 1, ...meta };
      if (!this.guard(`tape/${fileOf(l.id)}`, () => appendFileSync(join(this.dir, fileOf(l.id)), `${JSON.stringify(head)}\n`))) continue;
      if (held) held.meta = meta;
      else this.active.set(l.id, { meta, lastId: { away: "", home: "" }, lastPrice: { away: null, home: null }, lastTradeMs: 0, trades: 0, nextPollMs: nowMs });
    }
  }

  /** Every trade of one contract newer than `lastId`, oldest first. `reachedBack` is false when the page limit came first. */
  private async newTrades(symbol: string, lastId: string): Promise<{ rows: Array<{ id: string; t: number; q: string; p: string; buy: boolean }>; reachedBack: boolean }> {
    const rows: Array<{ id: string; t: number; q: string; p: string; buy: boolean }> = [];
    const seen = new Set<string>();
    let end: number | null = null;
    let reachedBack = false;
    for (let page = 0; page < TAPE_MAX_PAGES; page += 1) {
      const { data } = await getResult(`${this.host}/get-trades?instrument_name=${encodeURIComponent(symbol)}&count=${TAPE_PAGE}&start_ts=1${end !== null ? `&end_ts=${end}` : ""}`, this.fetchImpl);
      let added = 0;
      let known = false;
      let oldest = Infinity;
      for (const x of data as RawTrade[]) {
        const id = String(x?.d ?? "");
        const t = Number(x?.t);
        if (!id || !Number.isFinite(t)) continue;
        if (t < oldest) oldest = t;
        if (!newerId(id, lastId)) {
          known = true;
          continue;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push({ id, t: tradeMs(id, t), q: String(x.q ?? ""), p: String(x.p ?? ""), buy: x.s === "buy" });
        added += 1;
      }
      if (known || data.length < TAPE_PAGE || !Number.isFinite(oldest)) {
        reachedBack = true;
        break;
      }
      // end_ts includes its millisecond, so the page's oldest comes again; a page of nothing new steps past it
      end = added ? oldest : oldest - 1;
    }
    rows.sort((a, b) => (a.id === b.id ? 0 : newerId(a.id, b.id) ? 1 : -1));
    return { rows, reachedBack };
  }

  private async poll(a: Active, nowMs: number): Promise<void> {
    const out: string[] = [];
    // what the lines move once they are on disk: a write that fails leaves the game where it was, to be read again
    const newest: Partial<Record<Side, { id: string; price: number; t: number; n: number }>> = {};
    for (const side of SIDES) {
      let got;
      try {
        got = await this.newTrades(a.meta.symbols[side], a.lastId[side]);
      } catch (err) {
        // a contract the venue no longer knows has no more trades to give; anything else is asked again next pass
        if (!(err instanceof BadArgument)) this.lastError = `${a.meta.event}: ${(err as Error).message.slice(0, 120)}`;
        continue;
      }
      if (!got.reachedBack) a.gap = `${a.meta.event}: more trades than one pass reads back; the oldest of them were not kept`;
      for (const r of got.rows) {
        const line: TradeLine = ["t", sideCode(side), r.t, r.q, r.p, r.buy ? 1 : 0, r.id];
        out.push(JSON.stringify(line));
      }
      const last = got.rows[got.rows.length - 1];
      if (last) newest[side] = { id: last.id, price: priceOfDollars(last.p), t: last.t, n: got.rows.length };
    }
    if (out.length && this.guard(`tape/${fileOf(a.meta.event)}`, () => appendFileSync(join(this.dir, fileOf(a.meta.event)), `${out.join("\n")}\n`))) {
      for (const side of SIDES) {
        const n = newest[side];
        if (!n) continue;
        a.lastId[side] = n.id;
        if (n.price) a.lastPrice[side] = n.price;
        a.lastTradeMs = Math.max(a.lastTradeMs, n.t);
        a.trades += n.n;
      }
    }
    a.nextPollMs = nowMs >= a.meta.startMs - TAPE_NEAR_MS ? nowMs : nowMs + TAPE_FAR_EVERY_MS;
  }

  /** Close a game that is over: its book readings from the window, its result, its replay. */
  private close(a: Active, nowMs: number, history: HistoryPoint[]): boolean {
    const over = nowMs >= a.meta.startMs + TAPE_SETTLE_AFTER_MS && nowMs - a.lastTradeMs >= TAPE_QUIET_MS;
    const winner = over ? winnerFromLastPrices(a.lastPrice) : null;
    const gaveUp = nowMs >= a.meta.startMs + TAPE_GIVE_UP_MS;
    if (!winner && !gaveUp) return false;
    const out: string[] = [];
    if (a.meta.key) {
      for (const p of history) {
        const cell = p.games[a.meta.key]?.cryptocom;
        if (!cell) continue;
        const away: BookLine = ["b", "a", p.atMs, cell[0], cell[5] ?? 0];
        const home: BookLine = ["b", "h", p.atMs, cell[2], cell[7] ?? 0];
        out.push(JSON.stringify(away), JSON.stringify(home));
      }
    }
    const cents = (x: number | null): string => (x === null ? "none" : `${x / 100}¢`);
    const result: ResultLine = {
      k: "r",
      atMs: nowMs,
      winner,
      why: winner ? `the tape's last prints: away ${cents(a.lastPrice.away)}, home ${cents(a.lastPrice.home)}` : `no result on the tape ${Math.round(TAPE_GIVE_UP_MS / 3_600_000)} hours after the start: away ${cents(a.lastPrice.away)}, home ${cents(a.lastPrice.home)}`,
    };
    out.push(JSON.stringify(result));
    if (!this.guard(`tape/${fileOf(a.meta.event)}`, () => appendFileSync(join(this.dir, fileOf(a.meta.event)), `${out.join("\n")}\n`))) return false;
    const game = parseCapsule(this.lines(a.meta.event));
    if (game) this.replays.set(a.meta.event, replayGame(game, this.fee));
    this.active.delete(a.meta.event);
    return true;
  }

  /**
   * One pass: the games due are read, the games over are closed. Never awaited by a snapshot
   * cycle and never overlapping itself. It never throws.
   */
  async pass(nowMs = Date.now(), history: HistoryPoint[] = []): Promise<void> {
    if (!this.booted || this.busy) return;
    this.busy = true;
    try {
      const due = [...this.active.values()].filter((a) => a.nextPollMs <= nowMs).sort((a, b) => a.meta.startMs - b.meta.startMs);
      this.lastError = "";
      await pooled(due, 3, (a) => this.poll(a, nowMs));
      let closed = 0;
      for (const a of [...this.active.values()]) if (this.close(a, nowMs, history)) closed += 1;
      if (closed) {
        this.save();
        this.log(`[sports-venues] trade tape: ${closed} game${closed === 1 ? "" : "s"} closed and replayed; ${this.replays.size} closed in all`);
      }
      this.lastPassAt = new Date(nowMs).toISOString();
    } catch (err) {
      this.lastError = (err as Error).message.slice(0, 200);
    } finally {
      this.busy = false;
    }
  }

  /** The replay over every closed game, summed once per change. */
  report(): ReplayReport {
    if (!this.cached || this.cached.revision !== this.revision) this.cached = { revision: this.revision, report: sumReplays(this.replays.values()) };
    return this.cached.report;
  }

  /**
   * A closed game's file read back, for a moment of it. Only a game this record has closed is
   * read, so the name asked for never reaches the disk as given. The last few read are kept.
   */
  capsule(event: string): Capsule | null {
    if (!this.replays.has(event) || !safe(event)) return null;
    const held = this.read.get(event);
    if (held) return held;
    try {
      const game = parseCapsule(this.lines(event));
      if (!game) return null;
      if (this.read.size >= 3) this.read.delete(this.read.keys().next().value as string);
      this.read.set(event, game);
      return game;
    } catch {
      return null;
    }
  }

  /** The games being recorded now, soonest first: for the page. */
  recording(nowMs = Date.now()): Array<{ event: string; label: string; league: string; startMs: number; trades: number; inPlay: boolean }> {
    return [...this.active.values()]
      .map((a) => ({ event: a.meta.event, label: `${a.meta.awayName} at ${a.meta.homeName}`, league: a.meta.league, startMs: a.meta.startMs, trades: a.trades, inPlay: a.meta.startMs <= nowMs }))
      .sort((x, y) => x.startMs - y.startMs);
  }

  health(): Record<string, unknown> {
    const active = [...this.active.values()];
    const gaps = active.map((a) => a.gap).filter(Boolean);
    const closed = [...this.replays.values()];
    return {
      booted: this.booted,
      recording: active.length,
      recordingTrades: active.reduce((n, a) => n + a.trades, 0),
      closed: closed.length,
      closedWithResult: closed.filter((g) => g.winner).length,
      closedTrades: closed.reduce((n, g) => n + g.trades, 0),
      copiedFromCode: this.seeded,
      lastPassAt: this.lastPassAt,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(gaps.length ? { gaps } : {}),
      ...(this.note ? { note: this.note } : {}),
    };
  }
}
