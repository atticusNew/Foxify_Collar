/**
 * Lock in now: the lock's three numbers for a position someone names, from the bid on Crypto.com's
 * exchange as the collector last read it. Arithmetic on a public bid; nothing here places an order.
 *
 * The holder says the game, the side, how many contracts and what was paid for each. Every
 * option is their own sale of part of the position at that bid (lockMath.ts): the product's three
 * tiers, and stake back when the bid is high enough for it.
 *
 * The same for a moment of a finished game (lockPast): the bid is one that was really there then,
 * a book reading or a taker's sale off the game's tape, and the result is known.
 */

import type { FeeTerms } from "./analytics";
import { TIERS, TIER_NAME, TIER_SHARE, centsOf, lockTerms, netBid, priceOf, quantityOf, stakeBackNet, stakeBackSold, stakeCharged, stakeOf, tierSold, type LockTerms, type Position, type Tier } from "./lockMath";
import { BACK_SHARE, LOCK_MAX_BID, LOCK_MIN_BID, firstAfter, lockPoints, type Capsule } from "./tapeReplay";
import type { Game, Side } from "./types";

export interface LockChoice {
  /** `<game key>|<side>` */
  value: string;
  label: string;
  inPlay: boolean;
  bidCents: number;
}

export interface LockOption {
  id: "back" | Tier;
  name: string;
  /** contracts sold and kept */
  sold: number;
  kept: number;
  soldPercent: number;
  /** cash now, after the fee on the sale: the floor */
  floorCents: number;
  feeCents: number;
  capCents: number;
  /** the floor as a share of what the position cost, percent */
  backPercent: number;
  /** the bid's size covers the whole sale */
  covered: boolean;
}

export interface LockQuote {
  key: string;
  label: string;
  league: string;
  side: Side;
  team: string;
  inPlay: boolean;
  startsAt: string | null;
  contracts: number;
  paidCents: number;
  /** true when no price was given and the ask now stands in for it */
  paidAssumed: boolean;
  bidCents: number;
  bidQty: number;
  askCents: number;
  /** what the position cost with the fee to open it, and what it pays if the side wins */
  stakeCents: number;
  fullWinCents: number;
  options: LockOption[];
  /**
   * Stake back is shown whenever it leaves something riding. The replay counts it only once it
   * sells 80% or less. Present when that is not so at this bid (stake back not shown, or shown
   * selling more): the bid at which it is, cents; null when no bid up to 95¢ does it.
   */
  stakeBackOpensAtCents?: number | null;
  /** present when stake back is not shown: the lowest bid at which it is, selling nearly all; null when no bid up to 95¢ */
  stakeBackFromCents?: number | null;
  /** in words, when no option can be shown */
  note?: string;
  /** a moment of a finished game, not the book now */
  past?: {
    event: string;
    atMs: number;
    startMs: number;
    /** the bid is a book reading; false when it is a taker's sale on the tape, and bidQty is then that sale's size */
    fromBook: boolean;
    /** how the side finished; null when the game has no result */
    won: boolean | null;
    winnerName: string | null;
  };
}

export interface LockAsk {
  game?: string;
  side?: string;
  contracts?: string | number;
  paid?: string | number;
}

const listingOf = (g: Game) => g.listings.find((l) => l.venue === "cryptocom");
const startOf = (g: Game): number => Date.parse(listingOf(g)?.startsAt ?? (g.startSource === "venue" ? g.startsAt : ""));
const openBid = (cents: number): boolean => priceOf(cents) >= LOCK_MIN_BID && priceOf(cents) <= LOCK_MAX_BID;

/** Every side of every game Crypto.com lists with a bid, in play first, then by start. */
export function lockChoices(games: Game[], nowMs: number): LockChoice[] {
  const rows: Array<LockChoice & { startMs: number }> = [];
  for (const g of games) {
    const l = listingOf(g);
    if (!l) continue;
    const startMs = startOf(g);
    const inPlay = Number.isFinite(startMs) && startMs <= nowMs;
    for (const side of ["away", "home"] as const) {
      const q = l[side];
      if (!(q.bidCents > 0)) continue;
      const team = side === "away" ? g.awayName : g.homeName;
      rows.push({ value: `${g.key}|${side}`, label: `${g.league.toUpperCase()} · ${g.awayName} at ${g.homeName} · ${team} to win`, inPlay, bidCents: q.bidCents, startMs: Number.isFinite(startMs) ? startMs : Infinity });
    }
  }
  rows.sort((a, b) => Number(b.inPlay) - Number(a.inPlay) || a.startMs - b.startMs || a.value.localeCompare(b.value));
  return rows.map(({ startMs: _startMs, ...c }) => c);
}

function option(id: LockOption["id"], name: string, pos: Position, terms: LockTerms, bidQty: number): LockOption {
  return {
    id,
    name,
    sold: terms.sold / 100,
    kept: terms.kept / 100,
    soldPercent: Math.round((terms.sold / pos.qty) * 100),
    floorCents: centsOf(terms.cash, "down"),
    feeCents: centsOf(terms.fee, "up"),
    capCents: centsOf(terms.cap, "down"),
    backPercent: Math.floor((terms.cash / terms.stake) * 100),
    covered: quantityOf(bidQty) >= terms.sold,
  };
}

/** The lock on the position asked for, or null when the game and side are not on the board. */
export function lockNow(games: Game[], ask: LockAsk, fee: FeeTerms, nowMs: number): LockQuote | null {
  const [key, sideRaw] = String(ask.game ?? "").split("|");
  const side: Side | null = (ask.side ?? sideRaw) === "away" ? "away" : (ask.side ?? sideRaw) === "home" ? "home" : null;
  const g = games.find((x) => x.key === key);
  const l = g ? listingOf(g) : undefined;
  if (!g || !l || !side) return null;
  const q = l[side];
  const startMs = startOf(g);
  const inPlay = Number.isFinite(startMs) && startMs <= nowMs;
  const qty = quantityOf(ask.contracts ?? 0) || 2000;
  const paidGiven = Number(ask.paid);
  const paidAssumed = !(Number.isFinite(paidGiven) && paidGiven > 0 && paidGiven < 100);
  const askNow = q.askCents > 0 && q.askCents < 100 ? q.askCents : q.bidCents;
  const paidCents = paidAssumed ? askNow : Math.round(paidGiven * 100) / 100;
  const pos: Position = { qty, price: priceOf(paidCents) };
  const base: LockQuote = {
    key: g.key,
    label: `${g.awayName} at ${g.homeName}`,
    league: g.league,
    side,
    team: side === "away" ? g.awayName : g.homeName,
    inPlay,
    startsAt: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
    contracts: qty / 100,
    paidCents,
    paidAssumed,
    bidCents: q.bidCents,
    bidQty: q.bidQty,
    askCents: q.askCents,
    stakeCents: centsOf(stakeOf(pos, fee), "up"),
    fullWinCents: qty,
    options: [],
  };
  return priced(base, pos, fee);
}

/** The options on a position at the bid `base` carries. */
function priced(base: LockQuote, pos: Position, fee: FeeTerms): LockQuote {
  if (!(pos.price > 0)) return { ...base, note: "No price to work from: say what was paid per contract." };
  if (!(base.bidCents > 0)) return { ...base, note: "The book shows no bid on this side right now, so there is nothing to sell into." };
  if (!openBid(base.bidCents)) return { ...base, note: `The bid is ${base.bidCents}¢. Outside 5¢ to 95¢ the result is all but known and no lock is shown.` };
  const bid = priceOf(base.bidCents);
  const tiers: LockOption[] = [];
  for (const tier of TIERS) {
    const terms = lockTerms(pos, tierSold(pos.qty, tier), bid, fee);
    if (terms) tiers.push(option(tier, `${TIER_NAME[tier]}: sells ${TIER_SHARE[tier]}%`, pos, terms, base.bidQty));
  }
  const backSold = stakeBackSold(pos, netBid(fee, bid), fee);
  const backTerms = backSold !== null && backSold < pos.qty ? lockTerms(pos, backSold, bid, fee) : null;
  const back = backTerms ? option("back", "Stake back: sells just enough to return what you paid", pos, backTerms, base.bidQty) : null;
  /** the lowest whole-cent bid, from the bid now up to 95¢, that leaves `least` or more after the fee */
  const firstBid = (least: number | null): number | null => {
    if (least === null) return null;
    for (let cents = Math.ceil(base.bidCents); cents * 100 <= LOCK_MAX_BID; cents += 1) if (netBid(fee, priceOf(cents)) >= least) return cents;
    return null;
  };
  const counted = backTerms !== null && backTerms.sold <= Math.floor((pos.qty * TIER_SHARE.tight) / 100);
  const opensAt = counted ? undefined : firstBid(stakeBackNet(pos, fee, TIER_SHARE.tight));
  // shown from the first bid at which one hundredth of a contract is left riding
  const from = back ? undefined : firstBid(pos.qty > 1 ? Math.ceil(stakeCharged(pos, fee) / (pos.qty - 1)) : null);
  // in play the stake coming back is the first thing a holder who is ahead asks; before the start it is rarely there
  const options = back ? (base.inPlay ? [back, ...tiers] : [...tiers, back]) : tiers;
  return { ...base, options, ...(opensAt === undefined ? {} : { stakeBackOpensAtCents: opensAt }), ...(from === undefined ? {} : { stakeBackFromCents: from }), ...(options.length ? {} : { note: "The exchange fee is more than this bid leaves: nothing to lock." }) };
}

/**
 * The lock on a position at a price someone names: no game, no book. `price` is what one
 * contract can be closed at, cents. For a page with no price of its own to read (DKeX
 * publishes none).
 */
export function lockAtPrice(ask: { contracts?: string | number; paid?: string | number; price?: string | number }, fee: FeeTerms): LockQuote {
  const qty = quantityOf(ask.contracts ?? 0) || 2000;
  const within = (v: unknown): number => {
    const n = Math.round(Number(v) * 100) / 100;
    return Number.isFinite(n) && n > 0 && n < 100 ? n : 0;
  };
  const paidCents = within(ask.paid);
  const pos: Position = { qty, price: priceOf(paidCents) };
  return priced(
    { key: "", label: "", league: "", side: "away", team: "", inPlay: true, startsAt: null, contracts: qty / 100, paidCents, paidAssumed: false, bidCents: within(ask.price), bidQty: qty / 100, askCents: 0, stakeCents: centsOf(stakeOf(pos, fee), "up"), fullWinCents: qty, options: [] },
    pos,
    fee,
  );
}

// ---------------------------------------------------------------------------
// a moment of a finished game
// ---------------------------------------------------------------------------

export interface PastMoment {
  atMs: number;
  bidCents: number;
  fromBook: boolean;
  inPlay: boolean;
}

/** how far before the scheduled start a past moment can be picked, and how far apart the moments offered are */
export const PAST_BEFORE_START_MS = 60 * 60_000;
export const PAST_STEP_MS = 5 * 60_000;

/**
 * The moments of one side of a finished game a lock can be shown at: the last bid that was
 * really there in each five minutes, from an hour before the start, 5¢ to 95¢ only.
 */
export function pastMoments(game: Capsule, side: Side, fee: FeeTerms): PastMoment[] {
  const { points } = lockPoints(game.book[side], game.trades[side], fee);
  const out: PastMoment[] = [];
  let lastStep: number | null = null;
  for (let i = 0; i < points.t.length; i += 1) {
    const t = points.t[i];
    if (t < game.startMs - PAST_BEFORE_START_MS) continue;
    const step = Math.floor((t - game.startMs) / PAST_STEP_MS);
    const m = { atMs: t, bidCents: points.bid[i] / 100, fromBook: points.book[i], inPlay: t >= game.startMs };
    if (step === lastStep) out[out.length - 1] = m;
    else out.push(m);
    lastStep = step;
  }
  return out;
}

export interface PastAsk {
  side?: string;
  /** the moment, ms: the last bid at or before it is used. Absent: the first bid in play at which stake back is counted, else the first in play */
  atMs?: number;
  contracts?: string | number;
  paid?: string | number;
}

/** The lock on a position at a moment of a finished game, with how the side finished. Null when the side is not one. */
export function lockPast(game: Capsule, ask: PastAsk, fee: FeeTerms): LockQuote | null {
  const side: Side | null = ask.side === "away" ? "away" : ask.side === "home" ? "home" : null;
  if (!side) return null;
  const { points } = lockPoints(game.book[side], game.trades[side], fee);
  const qty = quantityOf(ask.contracts ?? 0) || 2000;
  const paidGiven = Number(ask.paid);
  const paidAssumed = !(Number.isFinite(paidGiven) && paidGiven > 0 && paidGiven < 100);
  // no price given: what the last taker paid before the start, or the first after it
  const buys = game.trades[side].filter((t) => t.buy);
  const before = buys.filter((t) => t.t < game.startMs);
  const assumed = (before[before.length - 1] ?? buys[0])?.price ?? 0;
  const paidCents = paidAssumed ? assumed / 100 : Math.round(paidGiven * 100) / 100;
  const pos: Position = { qty, price: priceOf(paidCents) };
  const liveFrom = firstAfter(points.t, game.startMs - 1);
  // the moment asked for is the last bid at or before it; with none, the first in play that returns the stake from 80% or less, else the first in play
  let i = Number.isFinite(ask.atMs) ? firstAfter(points.t, ask.atMs as number) - 1 : -1;
  const least = i < 0 && pos.price > 0 ? stakeBackNet(pos, fee, BACK_SHARE.live_back80) : null;
  if (least !== null) i = points.net.findIndex((net, j) => j >= liveFrom && net >= least);
  if (i < 0) i = liveFrom < points.t.length ? liveFrom : points.t.length - 1;
  const winner = game.winner === "away" || game.winner === "home" ? game.winner : null;
  const atMs = i >= 0 ? points.t[i] : game.startMs;
  const base: LockQuote = {
    key: `past:${game.event}`,
    label: `${game.awayName} at ${game.homeName}`,
    league: game.league,
    side,
    team: side === "away" ? game.awayName : game.homeName,
    inPlay: atMs >= game.startMs,
    startsAt: new Date(game.startMs).toISOString(),
    contracts: qty / 100,
    paidCents,
    paidAssumed,
    bidCents: i >= 0 ? points.bid[i] / 100 : 0,
    bidQty: i >= 0 ? points.qty[i] / 100 : 0,
    askCents: 0,
    stakeCents: centsOf(stakeOf(pos, fee), "up"),
    fullWinCents: qty,
    options: [],
    past: { event: game.event, atMs, startMs: game.startMs, fromBook: i >= 0 && points.book[i], won: winner ? winner === side : null, winnerName: winner ? (winner === "away" ? game.awayName : game.homeName) : null },
  };
  if (i < 0) return { ...base, note: "No bid between 5¢ and 95¢ was seen on this side of the game." };
  return priced(base, pos, fee);
}
