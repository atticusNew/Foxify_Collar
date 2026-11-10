/**
 * EXPOSURE CAPS: how much real money may be open at once on one game, on one hedge venue and for
 * one holder.
 *
 * The live rails (liveHedge.ts) bound one order and one day. Nothing bounded what stays open: a
 * week of small locks on one game, or every hedge resting on one new exchange. This module reads
 * the replayed ledgers and says what is open right now, and a real-money lock that would take any
 * of three sums over its cap is refused before an order is built (hedgeFirst.ts, step 0).
 *
 * WHAT COUNTS. A lock counts when it is on a lock ledger, its status is open, and a real order
 * bought its hedge. Any one of three records says so: the open line carries `hedgeFill` (written
 * by the hedge-first path); the hedge receipt trail holds a live buy fill under the lock's ref at
 * or after the lock's time (locks from before `hedgeFill` existed, and a simulated lock the
 * operator later hedged for real with the resend route); the pending trail holds an attempt under
 * the lock's ref, at or after the lock's time, that ended "locked" with its fill (the same older
 * locks, should the receipt trail have been archived). A fill named by more than one of them is
 * counted once, by its receipt id. A simulated lock moved no money and counts for nothing. A lock
 * stops counting the moment the ledger says it ended:
 *   settled   a `settle` line (status "settled")
 *   voided    a `void` line (status "void")
 *   unwound   a priced `close` line (status "closed"): the holder left early, or the schedule did
 * A lock the operator took off the record (lock reset) is no longer on the ledger and no longer
 * counts; the hedge it left on the venue is the operator's to sell. A member's own sale has no
 * hedge and no cash of ours and never counts.
 *
 * THE THREE SUMS, integer cents, N contracts, floor F and cap C per contract, credit K, hedge
 * bought for X all in (fees included, the real fill):
 *
 *   per game     F x N + K + X, summed over every counted lock on the game. Everything paid or
 *                promised on that game: the hedge cost and the credit are already spent, the floor
 *                is what is still owed if the side loses. It is the most the lock can cost if its
 *                hedge pays nothing (a game the two venues settle differently, a void on one side
 *                only), and by the credit identity it equals the hedge's face value less the take.
 *                A game-level accident hits every lock on the game at once, both sides, so they
 *                are summed. The key is the league plus the date-and-teams part of the Kalshi
 *                ticker the ledger carries (KXNBAGAME-26OCT14LALBOS-BOS on an "nba" record is
 *                nba:26OCT14LALBOS), so both sides, a draw market and any other market series on
 *                the same game share one key.
 *   per venue    X, summed over every counted lock whose hedge was bought there: the cash resting
 *                on that venue until the games settle. What a venue that froze, failed or was
 *                operated wrongly would be holding.
 *   per holder   the larger of what the lock can make us owe that person and what it can make
 *                them owe us: max(F x N + credit not yet paid, (100 - C) x N), summed over their
 *                counted locks. One of the two happens on every lock: the side loses and the floor
 *                is owed to them, or it wins and the slice above the cap is owed back by them
 *                (the hand-back, the leg that cannot be collected from someone who walks away).
 *                The cap bounds how much can ride on one person's word either way. The shared
 *                lock key is the holder "(shared)".
 *
 * HEDGE WITH NO LOCK BEHIND IT also counts, from the pending trail, until the operator clears the
 * line: an attempt still in flight or never resolved counts in full at what the gate set aside
 * for it (so two locks arriving together are measured against each other); a part fill or a fill
 * whose lock could not be written counts its cost on the venue and the game; an unconfirmed order
 * counts the most it could have cost.
 *
 * A NEW LOCK is measured at the most its order can cost: every unit at the limit price, plus the
 * quoted fees. Once filled, the fill's own cost replaces that.
 *
 * Pure: no file is read here and no venue is called. The caller hands in the replayed ledgers.
 */

import { costCentsAt, type HedgeIntent, type HedgeReceipt, type HedgeVenue } from "./hedgeExecutor";
import { summarizePending, type CapRefusalLine, type PendingRecord, type PendingReserve } from "./hedgeFirst";
import { fundingOf, type HedgeFillOnRecord, type ShadowPosition } from "./shadowLedger";
import { centsOf } from "./types";

export const EXPOSURE_VENUES: readonly HedgeVenue[] = ["kalshi", "polymarket", "prophetx", "novig"];
export const EXPOSURE_VENUE_NAMES: Record<HedgeVenue, string> = { kalshi: "Kalshi", polymarket: "Polymarket", prophetx: "ProphetX", novig: "Novig" };

/** The holder a lock made with the shared key belongs to, as the operator's views name it. */
export const SHARED_HOLDER = "(shared)";
export const holderKeyOf = (holder: string | null | undefined): string => holder || SHARED_HOLDER;

/** The hedge trail's ref for a lock: the ticker, suffixed with the holder when there is one. */
export const hedgeRefOf = (ticker: string, holder: string | null): string => (holder ? `${ticker}@${holder}` : ticker);

// ---------------------------------------------------------------------------
// the caps
// ---------------------------------------------------------------------------

/** A cap in cents; null is "no cap", which only the word `none` in the setting can say. */
export type CapCents = number | null;

export interface ExposureCaps {
  gameCents: CapCents;
  /** every venue without its own setting */
  venueCents: CapCents;
  venueOverrides: Partial<Record<HedgeVenue, CapCents>>;
  holderCents: CapCents;
  /** settings that could not be read, and what applies instead */
  notes: string[];
}

/**
 * Sized for a first cohort locking $5 to $20 positions, and against the order rails beside them
 * (liveHedge.ts: 25 hedge contracts an order, 100 a day). The per-order rail bounds any one lock
 * at about $25 on each sum, and a $20 position in the middle shape at a 60c mark is about $21 on
 * its game, $9 on its venue and $12 on its holder. So: one game holds two of the largest locks
 * the order rail lets through, one venue holds about a day of the most the day rail lets be
 * bought, one holder holds two of the largest locks, or four or more ordinary ones.
 */
export const DEFAULT_EXPOSURE_CAPS = { gameCents: 5_000, venueCents: 10_000, holderCents: 5_000 } as const;

export const EXPOSURE_CAP_ENV = {
  game: "EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_GAME",
  venue: "EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_VENUE",
  holder: "EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_HOLDER",
} as const;
export const venueCapEnvName = (venue: HedgeVenue): string => `${EXPOSURE_CAP_ENV.venue}_${venue.toUpperCase()}`;

type CapReading = { kind: "unset" } | { kind: "cap"; cents: CapCents } | { kind: "unreadable" };

function readCap(raw: string | undefined): CapReading {
  const v = (raw ?? "").trim();
  if (v === "") return { kind: "unset" };
  if (/^none$/i.test(v)) return { kind: "cap", cents: null };
  if (/^\d{1,12}$/.test(v)) return { kind: "cap", cents: Number(v) };
  return { kind: "unreadable" };
}

/**
 * The caps as the deploy sets them. Unset is the documented default, never "no cap". The word
 * `none` is the only way to say no cap. Anything else that is not a whole number of cents is not
 * guessed at: the default applies and a note says so. A venue's own setting replaces the
 * venue-wide one for that venue; one that cannot be read falls back to the venue-wide cap when
 * that is a number and to the default when it is `none`, never to no cap.
 */
export function exposureCapsFromEnv(env: NodeJS.ProcessEnv = process.env): ExposureCaps {
  const notes: string[] = [];
  const one = (name: string, fallback: number): CapCents => {
    const r = readCap(env[name]);
    if (r.kind === "cap") return r.cents;
    if (r.kind === "unreadable") notes.push(`${name} is neither a whole number of cents nor the word none; the default of ${fallback} cents applies`);
    return fallback;
  };
  const gameCents = one(EXPOSURE_CAP_ENV.game, DEFAULT_EXPOSURE_CAPS.gameCents);
  const venueCents = one(EXPOSURE_CAP_ENV.venue, DEFAULT_EXPOSURE_CAPS.venueCents);
  const holderCents = one(EXPOSURE_CAP_ENV.holder, DEFAULT_EXPOSURE_CAPS.holderCents);
  const venueOverrides: Partial<Record<HedgeVenue, CapCents>> = {};
  for (const venue of EXPOSURE_VENUES) {
    const name = venueCapEnvName(venue);
    const r = readCap(env[name]);
    if (r.kind === "cap") venueOverrides[venue] = r.cents;
    else if (r.kind === "unreadable") {
      const fallback = venueCents ?? DEFAULT_EXPOSURE_CAPS.venueCents;
      venueOverrides[venue] = fallback;
      notes.push(`${name} is neither a whole number of cents nor the word none; ${fallback} cents applies to ${EXPOSURE_VENUE_NAMES[venue]}`);
    }
  }
  return { gameCents, venueCents, venueOverrides, holderCents, notes };
}

export function venueCapOf(caps: ExposureCaps, venue: HedgeVenue): CapCents {
  const own = caps.venueOverrides[venue];
  return own === undefined ? caps.venueCents : own;
}

/** Every cap that is "no cap", by the name of its setting; empty when all are numbers. */
export function uncappedSettings(caps: ExposureCaps): string[] {
  const out: string[] = [];
  if (caps.gameCents === null) out.push(EXPOSURE_CAP_ENV.game);
  if (caps.venueCents === null) out.push(EXPOSURE_CAP_ENV.venue);
  for (const venue of EXPOSURE_VENUES) if (caps.venueOverrides[venue] === null) out.push(venueCapEnvName(venue));
  if (caps.holderCents === null) out.push(EXPOSURE_CAP_ENV.holder);
  return out;
}

// ---------------------------------------------------------------------------
// what is open
// ---------------------------------------------------------------------------

/**
 * The game a market belongs to: the league and the date-and-teams part of the Kalshi ticker, so
 * every market on the game shares the key whatever its series or side. Without a league the
 * series stands in for it. A ticker with fewer than three parts cannot be split into event and
 * outcome and is its own game.
 */
export function gameKeyOf(ticker: string, league?: string | null): string {
  const parts = ticker.split("-");
  if (parts.length < 3) return ticker;
  const prefix = (league ?? "").trim().toLowerCase() || parts[0].toLowerCase();
  return `${prefix}:${parts.slice(1, -1).join("-")}`;
}

export interface LockOnRecord {
  p: ShadowPosition;
  /** whose ledger the lock is on; null is the shared key's */
  holder: string | null;
}

/** What one attempt or lock adds to each sum. */
export interface ExposureAdd extends PendingReserve {
  venue: HedgeVenue;
  holder: string;
}

export interface ExposureInputs {
  /** every lock on every lock ledger, any status (loadShadowPositions per ledger) */
  locks: readonly LockOnRecord[];
  /** the hedge receipt trail */
  receipts: readonly HedgeReceipt[];
  /** the pending trail */
  pending: readonly PendingRecord[];
  /** amounts held in memory for an order in flight that writes no pending line (the operator's resend) */
  holds?: readonly ExposureAdd[];
}

export interface GameExposure {
  game: string;
  openCents: number;
  /** counted locks on the game */
  locks: number;
  title: string | null;
  eventTimeIso: string | null;
}

export interface OpenExposure {
  games: Record<string, GameExposure>;
  venues: Partial<Record<HedgeVenue, number>>;
  holders: Record<string, { openCents: number; locks: number }>;
  /** open locks behind a real hedge: the ones counted */
  realOpenLocks: number;
  /** open locks whose hedge is simulated: no money moved, not counted */
  simulatedOpenLocks: number;
  /** pending-trail lines counted: attempts in flight or never resolved, and hedge left with no lock behind it */
  pendingUnresolved: number;
  pendingLeftOver: number;
}

/** A lock attempt the pending trail says ended with the whole hedge bought and the lock written. */
export interface LockedAttempt {
  ref: string;
  at: string;
  fill: HedgeFillOnRecord;
}

/** Every attempt on the pending trail that ended "locked" with its fill on the line. */
export function lockedAttempts(pending: readonly PendingRecord[]): LockedAttempt[] {
  const asked = new Map<string, Extract<PendingRecord, { type: "pending" }>>();
  for (const r of pending) if (r.type === "pending") asked.set(r.id, r);
  const out: LockedAttempt[] = [];
  for (const r of pending) {
    if (r.type !== "resolved" || r.outcome !== "locked" || !r.fill) continue;
    const p = asked.get(r.id);
    if (!p || p.order.action !== "buy") continue;
    out.push({ ref: p.ref, at: p.at, fill: { venue: p.order.venue, unitsMilli: r.fill.unitsMilli, costCents: r.fill.costCents, orderId: r.fill.orderId, receiptId: r.fill.receiptId } });
  }
  return out;
}

/**
 * The real buys behind a lock: the fill written with it, every live buy on the receipt trail
 * under its ref since it was written, and every attempt the pending trail says ended in this
 * lock. Each receipt once.
 */
export function fillsBehind(p: ShadowPosition, holder: string | null, receiptsForRef: readonly HedgeReceipt[], attemptsForRef: readonly LockedAttempt[] = []): HedgeFillOnRecord[] {
  const out = new Map<string, HedgeFillOnRecord>();
  if (p.hedgeFill) out.set(p.hedgeFill.receiptId, p.hedgeFill);
  const ref = hedgeRefOf(p.ticker, holder);
  for (const r of receiptsForRef) {
    if (r.ref !== ref || r.at < p.at || (r.intent.action ?? "buy") !== "buy") continue;
    const f = r.fill;
    if (!f || f.simulated || f.unitsMilli <= 0 || out.has(r.id)) continue;
    out.set(r.id, { venue: f.venue, unitsMilli: f.unitsMilli, costCents: f.costCents, orderId: f.ids.orderId ?? null, receiptId: r.id });
  }
  for (const a of attemptsForRef) {
    if (a.ref !== ref || a.at < p.at || a.fill.unitsMilli <= 0 || out.has(a.fill.receiptId)) continue;
    out.set(a.fill.receiptId, a.fill);
  }
  return [...out.values()];
}

type LockTerms = Pick<ShadowPosition, "contracts" | "floorCents" | "capCents" | "creditCents"> & Partial<Pick<ShadowPosition, "cash">>;

/** The floor owed if the side loses, whole cents. */
const floorOwedCents = (t: LockTerms): number => centsOf(t.floorCents, t.contracts);

/** One lock's share of its game's sum: floor owed, credit, and the hedge cost paid (or the most it can cost). */
export function gameCentsOf(t: LockTerms, hedgeCostCents: number): number {
  return floorOwedCents(t) + Math.max(0, t.creditCents) + Math.max(0, hedgeCostCents);
}

/** One lock's share of its holder's sum: the larger of what it can make us owe them and what it can make them owe us. */
export function holderCentsOf(t: LockTerms): number {
  const creditPaid = (t.cash ?? []).filter((c) => c.leg === "credit").reduce((s, c) => s + c.cents, 0);
  const creditOwed = Math.max(0, t.creditCents - creditPaid);
  return Math.max(floorOwedCents(t) + creditOwed, fundingOf(t));
}

/** The most an order can cost: every unit at the limit price, or the walked cost if that is more, plus the quoted fees. */
export function hedgeReserveCents(order: Pick<HedgeIntent, "unitsMilli" | "maxCostCents"> & { limitMilli: number }, feesCents = 0): number {
  return Math.max(order.maxCostCents, costCentsAt(order.unitsMilli, order.limitMilli)) + Math.max(0, feesCents);
}

/** What a lock about to be made would add: the terms as quoted, the hedge at the most its order can cost. */
export function proposedExposure(args: {
  ticker: string;
  league?: string | null;
  holder: string | null;
  contracts: number;
  floorCents: number;
  capCents: number;
  creditCents: number;
  venue: HedgeVenue;
  hedgeReserveCents: number;
}): ExposureAdd {
  return {
    game: gameKeyOf(args.ticker, args.league),
    venue: args.venue,
    holder: holderKeyOf(args.holder),
    gameCents: gameCentsOf(args, args.hedgeReserveCents),
    venueCents: Math.max(0, args.hedgeReserveCents),
    holderCents: holderCentsOf(args),
  };
}

/** What is open right now, from the replayed ledgers. */
export function openExposure(inputs: ExposureInputs): OpenExposure {
  const out: OpenExposure = { games: {}, venues: {}, holders: {}, realOpenLocks: 0, simulatedOpenLocks: 0, pendingUnresolved: 0, pendingLeftOver: 0 };
  const addGame = (game: string, cents: number, lock: boolean, p?: ShadowPosition): void => {
    const g = (out.games[game] ??= { game, openCents: 0, locks: 0, title: null, eventTimeIso: null });
    g.openCents += cents;
    if (lock) g.locks += 1;
    if (p && !g.title) {
      g.title = p.eventTitle;
      g.eventTimeIso = p.eventTimeIso;
    }
  };
  const addVenue = (venue: HedgeVenue, cents: number): void => {
    out.venues[venue] = (out.venues[venue] ?? 0) + cents;
  };
  const addHolder = (holder: string, cents: number, lock: boolean): void => {
    const h = (out.holders[holder] ??= { openCents: 0, locks: 0 });
    h.openCents += cents;
    if (lock) h.locks += 1;
  };

  const byRef = new Map<string, HedgeReceipt[]>();
  for (const r of inputs.receipts) {
    const list = byRef.get(r.ref);
    if (list) list.push(r);
    else byRef.set(r.ref, [r]);
  }
  const attemptsByRef = new Map<string, LockedAttempt[]>();
  for (const a of lockedAttempts(inputs.pending)) {
    const list = attemptsByRef.get(a.ref);
    if (list) list.push(a);
    else attemptsByRef.set(a.ref, [a]);
  }
  const leagueOf = new Map<string, string>();
  for (const { p, holder } of inputs.locks) {
    if (p.league && !leagueOf.has(p.ticker)) leagueOf.set(p.ticker, p.league);
    if (p.status !== "open" || p.route === "member_sale") continue;
    const ref = hedgeRefOf(p.ticker, holder);
    const fills = fillsBehind(p, holder, byRef.get(ref) ?? [], attemptsByRef.get(ref) ?? []);
    if (fills.length === 0) {
      out.simulatedOpenLocks += 1;
      continue;
    }
    out.realOpenLocks += 1;
    const hedgeCost = fills.reduce((s, f) => s + f.costCents, 0);
    addGame(gameKeyOf(p.ticker, p.league), gameCentsOf(p, hedgeCost), true, p);
    for (const f of fills) addVenue(f.venue, f.costCents);
    addHolder(holderKeyOf(holder), holderCentsOf(p), true);
  }

  /** what a pending line holds: what the gate wrote on it, or, on a line from before that, the same sums from its terms and its order */
  const reserveOf = (p: Extract<PendingRecord, { type: "pending" }>): PendingReserve => {
    if (p.reserve) return p.reserve;
    const hedge = hedgeReserveCents(p.order);
    return { game: gameKeyOf(p.ticker, leagueOf.get(p.ticker)), gameCents: gameCentsOf(p.terms, hedge), venueCents: hedge, holderCents: holderCentsOf(p.terms) };
  };
  const trail = summarizePending([...inputs.pending]);
  for (const p of trail.unresolved) {
    if (p.order.action !== "buy") continue;
    const r = reserveOf(p);
    out.pendingUnresolved += 1;
    addGame(r.game, r.gameCents, false);
    addVenue(p.order.venue, r.venueCents);
    addHolder(holderKeyOf(p.holder), r.holderCents, false);
  }
  for (const { pending: p, resolved } of trail.strays) {
    if (p.order.action !== "buy") continue;
    const r = reserveOf(p);
    // no lock stands, so no floor is owed and nothing rides on the holder: only the hedge bought, or the most the unconfirmed order could have bought
    const cents = resolved.outcome === "unconfirmed" || !resolved.fill ? r.venueCents : resolved.fill.costCents;
    out.pendingLeftOver += 1;
    addGame(r.game, cents, false);
    addVenue(p.order.venue, cents);
  }
  for (const h of inputs.holds ?? []) {
    addGame(h.game, h.gameCents, false);
    addVenue(h.venue, h.venueCents);
    if (h.holderCents > 0) addHolder(h.holder, h.holderCents, false);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const holderWord = (holder: string): string => (holder === SHARED_HOLDER ? "the shared key" : `holder ${holder}`);

/**
 * Every cap the addition would pass, in the order game, venue, holder; empty when it fits. A sum
 * may reach its cap exactly; the first cent over is refused. A part that adds nothing is never
 * refused, so a cap lowered under what is already open stops new money and nothing else.
 */
export function checkExposure(open: OpenExposure, add: ExposureAdd, caps: ExposureCaps): CapRefusalLine[] {
  const rows: Array<{ cap: CapRefusalLine["cap"]; key: string; openCents: number; addCents: number; limit: CapCents }> = [
    { cap: "game", key: add.game, openCents: open.games[add.game]?.openCents ?? 0, addCents: add.gameCents, limit: caps.gameCents },
    { cap: "venue", key: add.venue, openCents: open.venues[add.venue] ?? 0, addCents: add.venueCents, limit: venueCapOf(caps, add.venue) },
    { cap: "holder", key: add.holder, openCents: open.holders[add.holder]?.openCents ?? 0, addCents: add.holderCents, limit: caps.holderCents },
  ];
  const out: CapRefusalLine[] = [];
  for (const r of rows) {
    if (r.limit === null || r.addCents <= 0) continue;
    const overByCents = r.openCents + r.addCents - r.limit;
    if (overByCents > 0) out.push({ cap: r.cap, key: r.key, openCents: r.openCents, addCents: r.addCents, capCents: r.limit, overByCents });
  }
  return out;
}

/** The operator's words for one cap passed: which cap, on what, and by how much. Names the venue; never shown to a holder. */
export function capRefusalDetail(r: CapRefusalLine): string {
  const sums = `${usd(r.openCents)} open now plus ${usd(r.addCents)} for this one is ${usd(r.openCents + r.addCents)}, over the cap of ${usd(r.capCents)} by ${usd(r.overByCents)}`;
  if (r.cap === "game") return `per-game cap on ${r.key}: ${sums}`;
  if (r.cap === "venue") return `per-venue cap on ${EXPOSURE_VENUE_NAMES[r.key as HedgeVenue] ?? r.key}: ${sums}`;
  return `per-holder cap for ${holderWord(r.key)}: ${sums}`;
}

export const capRefusalDetails = (rows: readonly CapRefusalLine[]): string => rows.map(capRefusalDetail).join("; ");

/**
 * What the holder is told: which limit and by how much, so a smaller size can be tried. The venue
 * is not named.
 */
export function capRefusalWords(rows: readonly CapRefusalLine[]): { code: "exposure_cap"; message: string } {
  const parts = rows.map((r) =>
    r.cap === "game"
      ? `${usd(r.overByCents)} over the limit for this game`
      : r.cap === "venue"
        ? `${usd(r.overByCents)} over the limit for where the other side is bought`
        : `${usd(r.overByCents)} over your own limit of ${usd(r.capCents)}`,
  );
  const smallerMayFit = rows.every((r) => r.openCents < r.capCents);
  return {
    code: "exposure_cap",
    message: `This lock would go over what can be open at once: ${parts.join("; ")}. Nothing was locked.${smallerMayFit ? " A smaller size may fit." : ""}`,
  };
}

// ---------------------------------------------------------------------------
// the operator's view
// ---------------------------------------------------------------------------

export const NO_CAP = "no cap";
type CapShown = number | typeof NO_CAP;
const capShown = (c: CapCents): CapShown => (c === null ? NO_CAP : c);
const roomShown = (c: CapCents, openCents: number): CapShown => (c === null ? NO_CAP : Math.max(0, c - openCents));

export interface ExposureView {
  caps: { perGameCents: CapShown; perVenueCents: { default: CapShown } & Partial<Record<HedgeVenue, CapShown>>; perHolderCents: CapShown; notes?: string[] };
  games: { open: number; top: Array<{ game: string; title: string | null; locks: number; openCents: number; capCents: CapShown; roomCents: CapShown }> };
  venues: Array<{ venue: HedgeVenue; openCents: number; capCents: CapShown; roomCents: CapShown }>;
  holders: Array<{ holder: string; locks: number; openCents: number; capCents: CapShown; roomCents: CapShown }>;
  counted: { realOpenLocks: number; simulatedOpenLocksNotCounted: number; pendingUnresolved: number; pendingLeftOver: number };
}

/**
 * Open now, the cap and the room left, per game (the largest few), per venue and per holder. A
 * cap set to `none` reads "no cap" in both columns. `venues` and `holders` name the ones to list
 * even when nothing is open on them (the venues with a live client, the holders with a key).
 */
export function exposureView(open: OpenExposure, caps: ExposureCaps, opts: { topGames?: number; venues?: readonly HedgeVenue[]; holders?: readonly string[] } = {}): ExposureView {
  const games = Object.values(open.games)
    .filter((g) => g.openCents > 0)
    .sort((a, b) => b.openCents - a.openCents || a.game.localeCompare(b.game));
  const venues = EXPOSURE_VENUES.filter((v) => (open.venues[v] ?? 0) > 0 || (opts.venues ?? []).includes(v) || caps.venueOverrides[v] !== undefined);
  const holders = [...new Set([...(opts.holders ?? []), ...Object.keys(open.holders)])].sort((a, b) => (open.holders[b]?.openCents ?? 0) - (open.holders[a]?.openCents ?? 0) || a.localeCompare(b));
  const overrides: Partial<Record<HedgeVenue, CapShown>> = {};
  for (const v of EXPOSURE_VENUES) {
    const own = caps.venueOverrides[v];
    if (own !== undefined) overrides[v] = capShown(own);
  }
  return {
    caps: {
      perGameCents: capShown(caps.gameCents),
      perVenueCents: { default: capShown(caps.venueCents), ...overrides },
      perHolderCents: capShown(caps.holderCents),
      ...(caps.notes.length ? { notes: caps.notes } : {}),
    },
    games: {
      open: games.length,
      top: games.slice(0, opts.topGames ?? 5).map((g) => ({ game: g.game, title: g.title, locks: g.locks, openCents: g.openCents, capCents: capShown(caps.gameCents), roomCents: roomShown(caps.gameCents, g.openCents) })),
    },
    venues: venues.map((v) => {
      const cap = venueCapOf(caps, v);
      const openCents = open.venues[v] ?? 0;
      return { venue: v, openCents, capCents: capShown(cap), roomCents: roomShown(cap, openCents) };
    }),
    holders: holders.map((h) => {
      const row = open.holders[h] ?? { openCents: 0, locks: 0 };
      return { holder: h, locks: row.locks, openCents: row.openCents, capCents: capShown(caps.holderCents), roomCents: roomShown(caps.holderCents, row.openCents) };
    }),
    counted: { realOpenLocks: open.realOpenLocks, simulatedOpenLocksNotCounted: open.simulatedOpenLocks, pendingUnresolved: open.pendingUnresolved, pendingLeftOver: open.pendingLeftOver },
  };
}
