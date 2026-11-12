/**
 * Lock in now: the lock's three numbers for a position someone names, from the bid on Crypto.com's
 * exchange as the collector last read it. Arithmetic on a public bid; nothing here places an order.
 *
 * The holder says the game, the side, how many contracts and what was paid for each. Every
 * option is their own sale of part of the position at that bid (lockMath.ts): the product's three
 * tiers, and stake back when the bid is high enough for it.
 */

import type { FeeTerms } from "./analytics";
import { TIERS, TIER_NAME, TIER_SHARE, centsOf, lockTerms, netBid, priceOf, quantityOf, stakeBackNet, stakeBackSold, stakeOf, tierSold, type LockTerms, type Position, type Tier } from "./lockMath";
import { LOCK_MAX_BID, LOCK_MIN_BID } from "./tapeReplay";
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
  if (!(pos.price > 0)) return { ...base, note: "No price to work from: say what was paid per contract." };
  if (!(q.bidCents > 0)) return { ...base, note: "The book shows no bid on this side right now, so there is nothing to sell into." };
  if (!openBid(q.bidCents)) return { ...base, note: `The bid is ${q.bidCents}¢. Outside 5¢ to 95¢ the result is all but known and no lock is shown.` };
  const bid = priceOf(q.bidCents);
  const tiers: LockOption[] = [];
  for (const tier of TIERS) {
    const terms = lockTerms(pos, tierSold(pos.qty, tier), bid, fee);
    if (terms) tiers.push(option(tier, `${TIER_NAME[tier]}: sells ${TIER_SHARE[tier]}%`, pos, terms, q.bidQty));
  }
  const backSold = stakeBackSold(pos, netBid(fee, bid), fee);
  const backTerms = backSold !== null && backSold < pos.qty ? lockTerms(pos, backSold, bid, fee) : null;
  const back = backTerms ? option("back", "Stake back: sells just enough to return what you paid", pos, backTerms, q.bidQty) : null;
  /** the lowest whole-cent bid, from the bid now up to 95¢, that leaves `least` or more after the fee */
  const firstBid = (least: number | null): number | null => {
    if (least === null) return null;
    for (let cents = Math.ceil(q.bidCents); cents * 100 <= LOCK_MAX_BID; cents += 1) if (netBid(fee, priceOf(cents)) >= least) return cents;
    return null;
  };
  const counted = backTerms !== null && backTerms.sold <= Math.floor((pos.qty * TIER_SHARE.tight) / 100);
  const opensAt = counted ? undefined : firstBid(stakeBackNet(pos, fee, TIER_SHARE.tight));
  // shown from the first bid at which one hundredth of a contract is left riding
  const from = back ? undefined : firstBid(pos.qty > 1 ? Math.ceil(stakeOf(pos, fee) / (pos.qty - 1)) : null);
  // in play the stake coming back is the first thing a holder who is ahead asks; before the start it is rarely there
  const options = back ? (inPlay ? [back, ...tiers] : [...tiers, back]) : tiers;
  return { ...base, options, ...(opensAt === undefined ? {} : { stakeBackOpensAtCents: opensAt }), ...(from === undefined ? {} : { stakeBackFromCents: from }), ...(options.length ? {} : { note: "The exchange fee is more than this bid leaves: nothing to lock." }) };
}
