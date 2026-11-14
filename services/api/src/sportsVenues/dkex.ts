/**
 * DKeX, DraftKings' exchange (Railbird Exchange, LLC), from the files it publishes each day at
 * railbirdexchange.com/reports. No key, no account. Three files a day:
 *
 *   Time & Sales       every trade: contract, time to the minute, price, size
 *   Daily Market       every listed contract: status, volume, the maturity date and time
 *   Daily Settlement   every contract settled that day: the club's name, when, at $1.00 or $0.00
 *
 * A game is the two winner contracts of one event: `{league}-WIN-FG-{event}-{club}`. This file
 * turns their rows into the same game file the replay reads for Crypto.com (tapeReplay.ts), so
 * one replay serves both.
 *
 * WHAT THE FILES DO NOT SAY, and what is done about each.
 *
 *   Which side started a trade. The replay needs it: a buy is a position opened, a sale is a
 *   price a holder was really paid. It is read from the price (sideOfPrints): the two contracts
 *   of a game are quoted a cent apart, buyers pay the higher price and sellers get the lower.
 *   On the tapes of an exchange that does publish the side, a trade read as a buy is one 98
 *   times in 100, and a trade read as a sale is one only about 4 times in 10: most are buys a
 *   cent higher than the price before. So a trade read as a sale is kept ONE CENT UNDER its
 *   price (DKEX_SALE_UNDER). A real sale is then priced a cent short; a buy read as a sale is
 *   priced at the bid it was a cent above. tests/sportsDkex.test.ts runs the replay on those
 *   tapes both ways, with the side as published and with it read this way, and holds the
 *   stake-back figures of the second at or under the first.
 *
 *   The second. Times are to the minute. Within a minute the file's own order is kept: the rows
 *   of every contract are interleaved in it, so it is the order of the exchange.
 *
 *   The book. There is none, so a lock is priced only at a trade read as a sale.
 *
 *   The start. A winner contract matures thirty days after its game starts, so its maturity
 *   less thirty days is the start. Against the starts of 19 games in our own record that is
 *   the same minute for the NFL and ten minutes later for the NBA and NHL, whose listed time
 *   is ten minutes before play. Games either side of the November clock change run the same
 *   length from it, so the thirty days are elapsed time, not the calendar's.
 *
 *   Who traded. DraftKings' customers, its own market maker and any other member alike.
 */

import { priceOfDollars, quantityOf } from "./lockMath";
import type { Capsule, TapeTrade } from "./tapeReplay";
import type { Side } from "./types";

const WINNER = /^([A-Z0-9]+)-WIN-FG-([A-Z0-9]+)-([A-Z0-9]+)$/;
/** a row of any of the three files that is about a game-winner contract */
export const DKEX_WINNER_ROW = /-WIN-FG-/;
/** what a trade read as a sale is kept under its price, hundredths of a cent: the width of the book */
export const DKEX_SALE_UNDER = 100;

/** a winner contract's maturity is its game's start plus this */
export const DKEX_MATURITY_AFTER_MS = 30 * 86_400_000;

export interface WinnerSymbol {
  /** as the exchange writes it: "NFL", "CFB", "NBAPRE" */
  league: string;
  event: string;
  club: string;
}
export function winnerSymbol(symbol: string): WinnerSymbol | null {
  const m = WINNER.exec(symbol);
  return m ? { league: m[1], event: m[2], club: m[3] } : null;
}

/** "11/12/26 08:15 PM EST" or "11/12/26 12:33:10.991 AM EST" as epoch ms, to the minute. Null when it is not that. */
export function dkexMinuteMs(text: string): number | null {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{2}) (\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)? (AM|PM)(?: (EST|EDT))?\s*$/.exec(text);
  if (!m) return null;
  const hour = (Number(m[4]) % 12) + (m[6] === "PM" ? 12 : 0);
  const utc = Date.UTC(2000 + Number(m[3]), Number(m[1]) - 1, Number(m[2]), hour, Number(m[5]));
  // with no zone on the row it is Eastern: EDT until the first Sunday of November is the file's own rule
  const zone = m[7] ?? (easternIsDaylight(utc) ? "EDT" : "EST");
  return utc + (zone === "EDT" ? 4 : 5) * 3_600_000;
}

/** Is this wall-clock moment (read as if UTC) inside US daylight time: the second Sunday of March to the first of November, 2 AM. */
function easternIsDaylight(wallUtc: number): boolean {
  const y = new Date(wallUtc).getUTCFullYear();
  const sunday = (month: number, nth: number): number => {
    const first = new Date(Date.UTC(y, month, 1)).getUTCDay();
    return Date.UTC(y, month, 1 + ((7 - first) % 7) + 7 * (nth - 1), 2);
  };
  return wallUtc >= sunday(2, 2) && wallUtc < sunday(10, 1);
}

/** One CSV row as its fields: quotes honoured, nothing else. */
export function csvFields(row: string): string[] {
  if (!row.includes('"')) return row.split(",");
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < row.length; i += 1) {
    const c = row[i];
    if (quoted) {
      if (c === '"' && row[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const dollarsOf = (text: string): string => text.replace(/^\$/, "").trim();

export interface DkexPrint {
  symbol: string;
  /** the minute it traded in, epoch ms */
  minuteMs: number;
  /** hundredths of a cent */
  price: number;
  /** hundredths of a contract */
  qty: number;
}
/** A Time & Sales row: `Business Date,Symbol,Transaction Date and Time,Last Price (USD),Last Quantity`. Null for the header or a row that does not read. */
export function printOf(row: string): DkexPrint | null {
  const f = csvFields(row.trimEnd());
  if (f.length < 5) return null;
  const minuteMs = dkexMinuteMs(f[2]);
  const price = priceOfDollars(dollarsOf(f[3]));
  const qty = quantityOf(f[4]);
  return minuteMs === null || !price || !qty ? null : { symbol: f[1], minuteMs, price, qty };
}

/** A Daily Market row, for its symbol and maturity: `...,Maturity Date and Time (ET)` is the last field. */
export function maturityOf(row: string): { symbol: string; maturityMs: number } | null {
  const f = csvFields(row.trimEnd());
  if (f.length < 9) return null;
  const maturityMs = dkexMinuteMs(f[8]);
  return maturityMs === null ? null : { symbol: f[1], maturityMs };
}

export interface DkexSettlement {
  symbol: string;
  /** the club as the exchange names it: "NY Giants" */
  name: string;
  settledMs: number;
  /** true at $1.00, false at $0.00, null at anything else (a void pays $0.50) */
  won: boolean | null;
}
/** A Daily Settlement row: `Market Name,Ticker,Status,Date and Time of Settlement (ET),Price (USD)`. */
export function settlementOf(row: string): DkexSettlement | null {
  const f = csvFields(row.trimEnd());
  if (f.length < 5) return null;
  const settledMs = dkexMinuteMs(f[3]);
  if (settledMs === null) return null;
  const price = Number(dollarsOf(f[4]));
  return { symbol: f[1], name: f[0].trim(), settledMs, won: price === 1 ? true : price === 0 ? false : null };
}

// ---------------------------------------------------------------------------
// which side started each trade
// ---------------------------------------------------------------------------

export interface SidedPrint {
  /** epoch ms; only the minute is used */
  t: number;
  side: Side;
  /** hundredths of a cent */
  price: number;
}

const TICK = 100;
const WHOLE = 10_000;
const OTHER: Record<Side, Side> = { away: "home", home: "away" };

/**
 * For each trade of a game, in the exchange's order: true when it is read as a buy, false as a
 * sale. Three readings of the price, the first that speaks:
 *
 *   1. Its own minute. A contract that traded at two prices one cent apart in the minute: the
 *      higher is where buyers paid, the lower where sellers were paid. At one price only, the
 *      other contract's two prices say where this one's must have been, because the pair is
 *      quoted to add to $1.01 to buy and 99 cents to sell.
 *   2. The other contract's last price. The two adding to $1.01 or more is a buy, to 99 cents or
 *      less a sale.
 *   3. Its own last move: up is a buy, down a sale, flat is whatever the last move was.
 *
 * A trade none of them reads (the first of a game, at a flat price) is taken as a buy: buys are
 * the great majority on these contracts, and a wrong buy adds a position where a wrong sale
 * would add a price nobody was paid.
 */
export function sideOfPrints(prints: readonly SidedPrint[]): boolean[] {
  const minutes = new Map<number, Record<Side, Set<number>>>();
  for (const p of prints) {
    const m = Math.floor(p.t / 60_000);
    let levels = minutes.get(m);
    if (!levels) minutes.set(m, (levels = { away: new Set(), home: new Set() }));
    levels[p.side].add(p.price);
  }
  const pair = (levels: Set<number>): [number, number] | null => {
    if (levels.size !== 2) return null;
    const [a, b] = [...levels].sort((x, y) => x - y);
    return b - a === TICK ? [a, b] : null;
  };
  const last: Partial<Record<Side, number>> = {};
  const moved: Partial<Record<Side, boolean>> = {};
  return prints.map((p) => {
    const levels = minutes.get(Math.floor(p.t / 60_000)) as Record<Side, Set<number>>;
    const mine = pair(levels[p.side]);
    const theirs = pair(levels[OTHER[p.side]]);
    let buy: boolean | undefined;
    if (mine) buy = p.price === mine[1];
    else if (levels[p.side].size === 1 && theirs) {
      if (p.price === WHOLE + TICK - theirs[1]) buy = true;
      else if (p.price === WHOLE - theirs[1]) buy = false;
    } else if (levels[p.side].size === 1 && levels[OTHER[p.side]].size === 1) {
      const sum = p.price + ([...levels[OTHER[p.side]]][0] as number);
      if (sum >= WHOLE + TICK) buy = true;
      else if (sum <= WHOLE - TICK) buy = false;
    }
    const other = last[OTHER[p.side]];
    if (buy === undefined && other !== undefined) {
      if (p.price + other >= WHOLE + TICK) buy = true;
      else if (p.price + other <= WHOLE - TICK) buy = false;
    }
    const mineLast = last[p.side];
    const tick = mineLast === undefined || p.price === mineLast ? moved[p.side] : p.price > mineLast;
    if (tick !== undefined) moved[p.side] = tick;
    last[p.side] = p.price;
    return buy ?? tick ?? true;
  });
}

// ---------------------------------------------------------------------------
// a game
// ---------------------------------------------------------------------------

export interface DkexGame {
  league: string;
  event: string;
  /** the two contracts, in the order of their symbols: "away" and "home" are only the replay's names for the two */
  symbols: Record<Side, string>;
  names: Record<Side, string>;
  startMs: number;
  winner: Side | null;
  /** the game's trades in the file's order */
  prints: DkexPrint[];
}

/**
 * The game as the replay reads one: sides read from the price, a trade read as a sale kept a
 * cent under its price, times in the file's order within a minute, no book.
 */
export function capsuleOfGame(g: DkexGame): Capsule {
  const sideOf = (symbol: string): Side | null => (symbol === g.symbols.away ? "away" : symbol === g.symbols.home ? "home" : null);
  const rows: Array<SidedPrint & { qty: number }> = [];
  let minute = -1;
  let inMinute = 0;
  for (const p of g.prints) {
    const side = sideOf(p.symbol);
    if (!side) continue;
    inMinute = p.minuteMs === minute ? Math.min(inMinute + 1, 59_999) : 0;
    minute = p.minuteMs;
    rows.push({ t: p.minuteMs + inMinute, side, price: p.price, qty: p.qty });
  }
  const buys = sideOfPrints(rows);
  const trades: Record<Side, TapeTrade[]> = { away: [], home: [] };
  rows.forEach((r, i) => trades[r.side].push({ t: r.t, qty: r.qty, price: buys[i] ? r.price : r.price - DKEX_SALE_UNDER, buy: buys[i] }));
  return {
    event: `${g.league}-${g.event}`,
    league: g.league.toLowerCase(),
    awayName: g.names.away,
    homeName: g.names.home,
    startMs: g.startMs,
    symbols: g.symbols,
    trades,
    book: { away: [], home: [] },
    winner: g.winner,
    lastId: { away: "", home: "" },
  };
}

/**
 * The three files, a row at a time in any order of file but each Time & Sales file in its own
 * order and the days oldest first; then the games that finished: two contracts, a start, and
 * both settled. Trades are held as four numbers each, so a season fits in memory.
 */
export class DkexAssembler {
  private readonly maturity = new Map<string, number>();
  private readonly settled = new Map<string, DkexSettlement>();
  private readonly prints = new Map<string, number[]>();
  /** every Time & Sales row read as a game-winner trade */
  winnerPrints = 0;
  /** contracts in them, hundredths */
  winnerQty = 0;

  market(row: string): void {
    const m = maturityOf(row);
    if (m && winnerSymbol(m.symbol)) this.maturity.set(m.symbol, m.maturityMs);
  }
  settlement(row: string): void {
    const s = settlementOf(row);
    if (s && winnerSymbol(s.symbol)) this.settled.set(s.symbol, s);
  }
  print(row: string): void {
    const p = printOf(row);
    if (!p || !winnerSymbol(p.symbol)) return;
    this.winnerPrints += 1;
    this.winnerQty += p.qty;
    let list = this.prints.get(p.symbol);
    if (!list) this.prints.set(p.symbol, (list = []));
    list.push(p.minuteMs, p.price, p.qty, this.winnerPrints);
  }

  /** Finished games, the earliest start first. `listed` is every event seen with two contracts; the rest of them have not settled in the days read. */
  games(): { games: DkexGame[]; listed: number } {
    const events = new Map<string, string[]>();
    for (const symbol of new Set([...this.maturity.keys(), ...this.settled.keys()])) {
      const w = winnerSymbol(symbol) as WinnerSymbol;
      const key = `${w.league}-${w.event}`;
      events.set(key, [...(events.get(key) ?? []), symbol]);
    }
    const games: DkexGame[] = [];
    let listed = 0;
    for (const symbols of events.values()) {
      if (symbols.length !== 2) continue;
      listed += 1;
      const [away, home] = [...symbols].sort();
      const a = this.settled.get(away);
      const h = this.settled.get(home);
      const maturityMs = this.maturity.get(away) ?? this.maturity.get(home);
      if (!a || !h || maturityMs === undefined) continue;
      const w = winnerSymbol(away) as WinnerSymbol;
      // one at $1.00 and the other at $0.00 is a result; a tie, a void or a game cut short is not
      const winner: Side | null = a.won === true && h.won === false ? "away" : h.won === true && a.won === false ? "home" : null;
      // the two contracts' trades back in the one order they were read in
      const rows: Array<[number, DkexPrint]> = [];
      for (const symbol of [away, home]) {
        const flat = this.prints.get(symbol) ?? [];
        for (let i = 0; i < flat.length; i += 4) rows.push([flat[i + 3], { symbol, minuteMs: flat[i], price: flat[i + 1], qty: flat[i + 2] }]);
      }
      rows.sort((x, y) => x[0] - y[0]);
      games.push({ league: w.league, event: w.event, symbols: { away, home }, names: { away: a.name, home: h.name }, startMs: maturityMs - DKEX_MATURITY_AFTER_MS, winner, prints: rows.map((r) => r[1]) });
    }
    games.sort((x, y) => x.startMs - y.startMs || x.event.localeCompare(y.event));
    return { games, listed };
  }
}
