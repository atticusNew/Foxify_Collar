/**
 * The replay over the stored pairs cycles: what would this rule have captured, after fees, if
 * the trader were N seconds slow? No I/O here; pairsReplayLoader.ts reads the day files and
 * feeds the lines in. Paper only: nothing is sent anywhere.
 *
 * (replay.ts beside this file is a different thing: the hedge replay on the curve service.)
 *
 * THE TRADE. A lock is Yes bought on one venue and No on the other for the same contract. The
 * prices are the repo's own lock, one way round (`lockOneWay` in pairs.ts): the Yes ask on one
 * venue and 100 minus the other venue's Yes bid, top of book. Fees are the repo's
 * `takerFeeCents` per contract, times the size, and each leg's fee for the order is rounded up
 * to the next whole cent (Kalshi publishes that rounding; for Polymarket US it is the rounding
 * that goes against the trader). The edge is $1 minus both prices minus both fees, at the size
 * traded. The page's lock is the same arithmetic for one contract without the per-order
 * rounding, so the replay's edge is never above the page's.
 *
 * MONEY is integer milli-cents (1000 = 1 cent) from the stored prices onward. Sums are integer
 * sums. Where a figure must be rounded it goes against the trader: a price is rounded up, a
 * fee up, an edge per pair down, the median of an even count is the lower middle.
 *
 * SIGNAL. The first stored cycle at which the rule's conditions hold for a pair one way round,
 * judged on that cycle's reads alone: the tenor is one the rule names; both books were read
 * (no leg missing, no book failing) and are fresh against the bound the collector stored for
 * the row (`freshnessOf`), and neither read is older than `maxReadAgeSec`; the top of book
 * holds at least `minSizeContracts` and at least `sizeContracts`; the edge at `sizeContracts`
 * is at least `minEdgeCents` per pair. A cycle's time is its `pricedAt`.
 *
 * FILL. The first stored cycle at or after signal time plus `lagSec`. A lag of 0 is the signal
 * cycle itself: an upper bound nobody achieves. If no stored cycle lands within one cycle
 * interval plus `gapToleranceSec` after signal time plus lag (a data gap, or the data ends),
 * the outcome is `unknown`. At the fill cycle, the same way round as the signal:
 *   - the pair or a leg is not there, its read age is not stored, the row is stale, or a read
 *     is older than `maxReadAgeSec`: `unknown`;
 *   - the price is not there or the top of book holds less than `sizeContracts`: `gone`
 *     (size). What a market order would have paid deeper in the book is not stored, so this
 *     trade has no "sent anyway" figure and is counted as not priced;
 *   - the edge at `sizeContracts` is zero or more: `captured`, at the fill cycle's edge, not
 *     the signal's;
 *   - the edge is below zero: `gone` (edge), nothing captured: a limit at break even does not
 *     fill. "Sent anyway" is the same trade sent at market: the fill cycle's edge, negative.
 * `unknown` is never counted as captured, as gone, or as zero.
 *
 * ONE TRADE PER EPISODE. A pair one way round is the repo's lock run identity (`lockRunId` in
 * pairs.ts: tenor, close, strike key, both venue ids, which venue the Yes is on). After a
 * signal there is no new signal on it until a stored cycle at which its conditions do not
 * hold: the edge or the size went, a read was stale or missing, or the pair was not in the
 * cycle. A stretch with no stored cycle does not re-arm it: nothing was seen to be false. The
 * page's lock episodes use the same identity but need two cycles in a row and end on a gap of
 * three intervals; here one cycle is a signal, because the question is what a rule acting on
 * each cycle would have done.
 *
 * WHAT IS NOT MODELLED is in `ASSUMPTIONS`, printed with every result.
 */

import { takerFeeCents } from "./analytics";
import { freshnessOf, lockOneWay, lockRunId, type Horizon, type LockQuote } from "./pairs";
import type { ParsedCycleLine, StoredCycle, StoredLeg, StoredPair } from "./pairsCycles";
import type { Venue } from "./types";

export interface ReplayRule {
  /** the least edge that is a signal: net of both venues' fees, per $1 pair, at the size traded; cents */
  minEdgeCents: number;
  /** the least size showing at the top of both books for a signal, contracts */
  minSizeContracts: number;
  /** the size traded, contracts */
  sizeContracts: number;
  /** seconds from the signal to the trader's orders reaching the books */
  lagSec: number;
  /** a read older than this is not acted on at the signal and is not a fill at the fill, seconds */
  maxReadAgeSec: number;
  horizons: Horizon[];
  /** how late past one cycle interval the fill cycle may be before the outcome is unknown, seconds */
  gapToleranceSec: number;
}

export const DEFAULT_RULE: ReplayRule = { minEdgeCents: 1, minSizeContracts: 10, sizeContracts: 10, lagSec: 10, maxReadAgeSec: 30, horizons: ["fifteen", "hourly", "daily"], gapToleranceSec: 5 };

export const ASSUMPTIONS: readonly string[] = [
  "Paper only. No order was sent; these are prices the public books showed.",
  "Both legs are assumed to fill together, at the fill cycle's prices. A real pair of orders can fill one leg and miss the other; that risk is not priced here.",
  "Cycles are stored about every 10 seconds (the collector's interval), so a lag is only resolved to the next stored cycle at or after signal time plus lag. A lag of 0 fills at the signal cycle itself: an upper bound nobody achieves.",
  "The Polymarket US public book is an edge-cached copy that can be up to about 30 seconds old, so a gap between the venues may be a stale quote and not a price anyone could trade. That is why the read age is a rule input.",
  "No queue position and no partial fills. Size is the top of book as stored, the thinner of the two levels taken; depth below the top is not stored, so a trade larger than the top level is not priced.",
  "Fees are each venue's taker fee for the whole order, each leg rounded up to the next whole cent. Kalshi publishes that rounding; for Polymarket US it is the rounding that goes against the trader.",
  "A fill whose edge is below zero counts as gone and captures nothing (a limit at break even). Sent anyway is the same trades sent at market, so it includes the negative fills; fills where the size was not on the book are left out of it and counted as not priced.",
  "Unknown is never counted as captured, as gone, or as zero: no stored cycle in time, or a fill read that was stale, too old or missing.",
  "One trade per episode: after a signal on a pair one way round, no new signal on it until a stored cycle at which its conditions do not hold.",
];

export const UNITS = "Fields ending in Mc are integer milli-cents: 1000 is 1 cent, 100000 is $1. Edges are per $1 pair; totals are for the size traded.";

const HORIZONS: readonly Horizon[] = ["fifteen", "hourly", "daily"];
const whole = (x: number): boolean => Number.isSafeInteger(x);
/** A figure with at most three decimals, as integer thousandths; null otherwise. */
function thousandths(x: number): number | null {
  if (!Number.isFinite(x)) return null;
  const t = Math.round(x * 1000);
  return Math.abs(x * 1000 - t) < 1e-6 && whole(t) ? t : null;
}

/** Why a rule cannot be replayed, in plain words; null when it can. Nothing is corrected silently. */
export function ruleProblem(rule: ReplayRule): string | null {
  const edge = thousandths(rule.minEdgeCents);
  if (edge === null || edge < 0) return "The minimum edge must be zero or more cents, with at most three decimals.";
  if (!whole(rule.minSizeContracts) || rule.minSizeContracts < 1) return "The minimum size must be a whole number of contracts, 1 or more.";
  if (!whole(rule.sizeContracts) || rule.sizeContracts < 1 || rule.sizeContracts > 1_000_000) return "The size traded must be a whole number of contracts, from 1 to 1000000.";
  const lag = thousandths(rule.lagSec);
  if (lag === null || lag < 0) return "The lag must be zero or more seconds, with at most three decimals.";
  if (!(rule.maxReadAgeSec > 0) || !Number.isFinite(rule.maxReadAgeSec)) return "The maximum read age must be more than zero seconds.";
  const tol = thousandths(rule.gapToleranceSec);
  if (tol === null || tol < 0) return "The gap tolerance must be zero or more seconds, with at most three decimals.";
  if (!Array.isArray(rule.horizons) || !rule.horizons.length) return "Name at least one tenor: fifteen, hourly or daily.";
  for (const h of rule.horizons) if (!HORIZONS.includes(h)) return `"${String(h)}" is not a tenor. The tenors are fifteen, hourly and daily.`;
  if (new Set(rule.horizons).size !== rule.horizons.length) return "A tenor is named twice.";
  return null;
}

/* ---- the price of one trade, in integer milli-cents ---- */

/** A price in cents as milli-cents; anything finer than a milli-cent is rounded up, against the buyer. */
function priceMc(cents: number): number {
  const t = Math.round(cents * 1000);
  return Math.abs(cents * 1000 - t) < 1e-6 ? t : Math.ceil(cents * 1000);
}

/** One leg's taker fee for the whole order: the repo's per-contract fee times the size, rounded up to the next whole cent. */
function orderFeeMc(theta: number, priceCents: number, size: number): number {
  const perContractMc = Math.round(takerFeeCents(theta, priceCents) * 1000);
  const total = perContractMc * size;
  const over = total % 1000;
  return over === 0 ? total : total - over + 1000;
}

export interface PricedLock {
  yesOn: Venue;
  noOn: Venue;
  yesAtMc: number;
  noAtMc: number;
  /** both legs' fees for the whole order */
  feesMc: number;
  /** $1 a pair minus both prices, times the size, minus both fees: what the trade locks, for the size traded */
  netMc: number;
  /** netMc over the size, rounded down */
  edgeMc: number;
  /** contracts at the top of both books: the thinner level */
  qty: number;
}

/** The lock one way round at a size, or null when a price is not there. Exported for tests. */
export function priceLock(yes: LockQuote, no: LockQuote, size: number): PricedLock | null {
  const lock = lockOneWay(yes, no);
  if (!lock) return null;
  const yesAtMc = priceMc(lock.yesAtCents);
  const noAtMc = priceMc(lock.noAtCents);
  const feesMc = orderFeeMc(yes.feeTheta, lock.yesAtCents, size) + orderFeeMc(no.feeTheta, lock.noAtCents, size);
  const netMc = size * (100_000 - yesAtMc - noAtMc) - feesMc;
  return { yesOn: lock.yesOn, noOn: lock.noOn, yesAtMc, noAtMc, feesMc, netMc, edgeMc: Math.floor(netMc / size), qty: lock.qty };
}

/* ---- what one cycle says about one pair, one way round ---- */

type ReadState = "ok" | "noRead" | "staleRead" | "oldRead";

const quoteOf = (venue: Venue, leg: StoredLeg): LockQuote => ({ venue, bidCents: leg.bidCents, askCents: leg.askCents, bidQty: leg.bidQty, askQty: leg.askQty, feeTheta: leg.feeTheta });

/** Whether both of the pair's reads can be acted on under the rule. */
function readState(p: StoredPair, rule: ReplayRule): ReadState {
  if (!p.kalshi || !p.poly || (p.errors && p.errors.length)) return "noRead";
  const fresh = freshnessOf(p.kalshi.ageSec, p.poly.ageSec, p.staleAfterSec);
  if (fresh === null) return "noRead";
  if (fresh === "stale") return "staleRead";
  if ((p.kalshi.ageSec as number) > rule.maxReadAgeSec || (p.poly.ageSec as number) > rule.maxReadAgeSec) return "oldRead";
  return "ok";
}

function priced(p: StoredPair, yesOn: Venue, size: number): PricedLock | null {
  if (!p.kalshi || !p.poly) return null;
  const k = quoteOf("kalshi", p.kalshi);
  const q = quoteOf("polymarket_us", p.poly);
  return yesOn === "kalshi" ? priceLock(k, q, size) : priceLock(q, k, size);
}

const pairKey = (p: Pick<StoredPair, "horizon" | "settlesAt" | "key">): string => [p.horizon, p.settlesAt, p.key].join("|");
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/* ---- outcomes ---- */

export type Outcome = "captured" | "gone" | "unknown";
export type OutcomeWhy = "edge" | "size" | "noCycle" | "noRead" | "staleRead" | "oldRead" | null;

export interface ReplayTrade {
  horizon: Horizon;
  settlesAt: string;
  key: string;
  strike: number;
  kalshiId: string;
  polyId: string;
  yesOn: Venue;
  signalAt: string;
  /** the edge per pair the signal cycle showed at the size traded */
  signalEdgeMc: number;
  outcome: Outcome;
  /** why it is gone or unknown; null when captured */
  why: OutcomeWhy;
  /** the fill cycle; null when no stored cycle came in time */
  fillAt: string | null;
  /** the edge per pair at the fill cycle, when both books could be priced there; negative when the lock had gone */
  fillEdgeMc: number | null;
  /** what was captured for the size traded; 0 unless captured */
  capturedMc: number;
}

export interface ReplaySummary {
  signals: number;
  captured: number;
  gone: { total: number; edge: number; size: number };
  unknown: { total: number; noCycle: number; noRead: number; staleRead: number; oldRead: number };
  /** what the captured trades locked, for the size traded */
  capturedMc: number;
  /** median edge per pair of the captured trades (the lower middle of an even count); null with none */
  medianCapturedEdgeMc: number | null;
  /** smallest edge per pair of the captured trades; null with none */
  worstCapturedEdgeMc: number | null;
  /** the captured trades plus the trades whose edge had gone, at the fill cycle's edge: what sending at market would have made */
  sentAnywayMc: number;
  /** trades left out of sentAnywayMc because the size was not on the book at the fill */
  sentAnywayNotPriced: number;
  /** what the signal cycles showed for the size traded, all signals: the figure a lag of 0 captures */
  shownAtSignalMc: number;
  /** of the signals whose outcome is known (captured or gone), the share captured; null when none is known */
  survivedShare: number | null;
  /** seconds from signal to fill over the trades that reached a fill cycle; null with none */
  fillDelaySec: { median: number; max: number } | null;
}

export interface ReplayDay {
  day: string;
  cyclesRead: number;
  /** cycles stored in the old form: counted, and nothing else can be said of them */
  cyclesOldFormat: number;
  /** lines that could not be read, or whose time ran backwards */
  linesSkipped: number;
  signals: number;
  captured: number;
  gone: number;
  unknown: number;
  capturedMc: number;
  sentAnywayMc: number;
  /** what this day cannot say, in plain words; absent when the day is whole */
  note?: string;
}

export interface ReplayResult {
  rule: ReplayRule;
  /** what the lag means for this run */
  lagLabel: string;
  units: string;
  total: ReplaySummary;
  byHorizon: Partial<Record<Horizon, ReplaySummary>>;
  /** days with at least one cycle the replay could read */
  daysCovered: number;
  cyclesRead: number;
  cyclesOldFormat: number;
  linesSkipped: number;
  firstCycleAt: string | null;
  lastCycleAt: string | null;
  days: ReplayDay[];
  /** signals whose fill cycle had not come when the data ended; they are in `unknown.noCycle` */
  signalsOpenAtEnd: number;
  /** the first trades in signal order, up to the number asked for */
  trades: ReplayTrade[];
  tradesNotListed: number;
  /** what the stored lines could not give, in plain words */
  notes: string[];
  assumptions: readonly string[];
}

interface Tally {
  signals: number;
  captured: number;
  goneEdge: number;
  goneSize: number;
  noCycle: number;
  noRead: number;
  staleRead: number;
  oldRead: number;
  capturedMc: number;
  sentAnywayMc: number;
  sentAnywayNotPriced: number;
  shownAtSignalMc: number;
  edgesMc: number[];
  delaysMs: number[];
}

const emptyTally = (): Tally => ({ signals: 0, captured: 0, goneEdge: 0, goneSize: 0, noCycle: 0, noRead: 0, staleRead: 0, oldRead: 0, capturedMc: 0, sentAnywayMc: 0, sentAnywayNotPriced: 0, shownAtSignalMc: 0, edgesMc: [], delaysMs: [] });

/** The lower middle of an even count: of two middle edges the smaller is reported. */
function lowerMedian(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

function summaryOf(t: Tally): ReplaySummary {
  const gone = t.goneEdge + t.goneSize;
  const unknown = t.noCycle + t.noRead + t.staleRead + t.oldRead;
  const known = t.captured + gone;
  const medianDelay = lowerMedian(t.delaysMs);
  return {
    signals: t.signals,
    captured: t.captured,
    gone: { total: gone, edge: t.goneEdge, size: t.goneSize },
    unknown: { total: unknown, noCycle: t.noCycle, noRead: t.noRead, staleRead: t.staleRead, oldRead: t.oldRead },
    capturedMc: t.capturedMc,
    medianCapturedEdgeMc: lowerMedian(t.edgesMc),
    worstCapturedEdgeMc: t.edgesMc.length ? Math.min(...t.edgesMc) : null,
    sentAnywayMc: t.sentAnywayMc,
    sentAnywayNotPriced: t.sentAnywayNotPriced,
    shownAtSignalMc: t.shownAtSignalMc,
    survivedShare: known ? Math.round((t.captured / known) * 10_000) / 10_000 : null,
    fillDelaySec: medianDelay === null ? null : { median: medianDelay / 1000, max: Math.max(...t.delaysMs) / 1000 },
  };
}

interface Pending {
  trade: ReplayTrade;
  signalMs: number;
  /** signal time plus lag: the fill cycle is the first at or after this */
  dueMs: number;
  /** past this the next stored cycle is too late to be the fill */
  lastMs: number;
  day: string;
}

interface DayCount {
  cyclesRead: number;
  cyclesOldFormat: number;
  linesSkipped: number;
  signals: number;
  captured: number;
  gone: number;
  unknown: number;
  capturedMc: number;
  sentAnywayMc: number;
}

export interface Replay {
  /** One line of the cycle file, in file order. `fileDay` names the day for a line that carries no time of its own. */
  push(line: ParsedCycleLine, fileDay?: string): void;
  /** The result as of the lines pushed. Signals still waiting for their fill cycle are `unknown`: the data ends before it. */
  result(): ReplayResult;
}

export function lagLabelOf(rule: ReplayRule): string {
  return rule.lagSec === 0
    ? "Lag 0: each trade fills at its own signal cycle. An upper bound nobody achieves."
    : `Lag ${rule.lagSec} s: each trade fills at the first stored cycle at or after its signal time plus ${rule.lagSec} seconds.`;
}

/**
 * A replay fed one line at a time, so a reader can stream day files through it and several
 * lags can share one pass. Throws on a rule that `ruleProblem` refuses.
 */
export function createReplay(rule: ReplayRule, opts: { keepTrades?: number } = {}): Replay {
  const problem = ruleProblem(rule);
  if (problem) throw new Error(problem);
  const keepTrades = opts.keepTrades ?? 100;
  const size = rule.sizeContracts;
  const needQty = Math.max(rule.minSizeContracts, size);
  const minNetMc = (thousandths(rule.minEdgeCents) as number) * size;
  const lagMs = thousandths(rule.lagSec) as number;
  const toleranceMs = thousandths(rule.gapToleranceSec) as number;
  const wanted = new Set<Horizon>(rule.horizons);

  const total = emptyTally();
  const byHorizon = new Map<Horizon, Tally>(rule.horizons.map((h) => [h, emptyTally()]));
  const days = new Map<string, DayCount>();
  /** runs whose signal has fired and whose conditions have held on every stored cycle since */
  let held = new Set<string>();
  let pending: Pending[] = [];
  const trades: ReplayTrade[] = [];
  let tradeCount = 0;
  let lastMs = Number.NEGATIVE_INFINITY;
  let firstMs: number | null = null;

  const dayOf = (day: string): DayCount => {
    let d = days.get(day);
    if (!d) {
      d = { cyclesRead: 0, cyclesOldFormat: 0, linesSkipped: 0, signals: 0, captured: 0, gone: 0, unknown: 0, capturedMc: 0, sentAnywayMc: 0 };
      days.set(day, d);
    }
    return d;
  };
  const tallies = (h: Horizon): Tally[] => [total, byHorizon.get(h) as Tally];

  const settle = (p: Pending, outcome: Outcome, why: OutcomeWhy, fillMs: number | null, fill: PricedLock | null): void => {
    const t = p.trade;
    t.outcome = outcome;
    t.why = why;
    t.fillAt = fillMs === null ? null : new Date(fillMs).toISOString();
    t.fillEdgeMc = fill ? fill.edgeMc : null;
    t.capturedMc = outcome === "captured" && fill ? fill.netMc : 0;
    const day = dayOf(p.day);
    for (const tally of tallies(t.horizon)) {
      if (fillMs !== null) tally.delaysMs.push(fillMs - p.signalMs);
      if (outcome === "captured" && fill) {
        tally.captured += 1;
        tally.capturedMc += fill.netMc;
        tally.sentAnywayMc += fill.netMc;
        tally.edgesMc.push(fill.edgeMc);
      } else if (outcome === "gone") {
        if (why === "edge" && fill) {
          tally.goneEdge += 1;
          tally.sentAnywayMc += fill.netMc;
        } else {
          tally.goneSize += 1;
          tally.sentAnywayNotPriced += 1;
        }
      } else {
        tally[why as "noCycle" | "noRead" | "staleRead" | "oldRead"] += 1;
      }
    }
    if (outcome === "captured" && fill) {
      day.captured += 1;
      day.capturedMc += fill.netMc;
      day.sentAnywayMc += fill.netMc;
    } else if (outcome === "gone") {
      day.gone += 1;
      if (why === "edge" && fill) day.sentAnywayMc += fill.netMc;
    } else day.unknown += 1;
  };

  /** The trade at its fill cycle, judged on that cycle's reads alone, the way round it was signalled. */
  const fillAt = (p: Pending, cycleMs: number, pairs: Map<string, StoredPair>): void => {
    const t = p.trade;
    const pair = pairs.get(pairKey(t));
    if (!pair || pair.kalshi?.id !== t.kalshiId || pair.poly?.id !== t.polyId) return settle(p, "unknown", "noRead", cycleMs, null);
    const read = readState(pair, rule);
    if (read !== "ok") return settle(p, "unknown", read, cycleMs, null);
    const lock = priced(pair, t.yesOn, size);
    if (!lock || lock.qty < size) return settle(p, "gone", "size", cycleMs, null);
    if (lock.netMc >= 0) return settle(p, "captured", null, cycleMs, lock);
    return settle(p, "gone", "edge", cycleMs, lock);
  };

  const cycle = (c: StoredCycle): void => {
    const t = c.pricedAt;
    const day = dayOf(utcDay(c.at));
    if (!(t > lastMs)) {
      day.linesSkipped += 1;
      return;
    }
    lastMs = t;
    if (firstMs === null) firstMs = t;
    day.cyclesRead += 1;

    const pairs = new Map<string, StoredPair>();
    const holds = new Set<string>();
    for (const p of c.pairs) {
      if (!wanted.has(p.horizon)) continue;
      pairs.set(pairKey(p), p);
      if (readState(p, rule) !== "ok" || !p.kalshi || !p.poly) continue;
      for (const yesOn of ["kalshi", "polymarket_us"] as const) {
        const lock = priced(p, yesOn, size);
        if (!lock || lock.qty < needQty || lock.netMc < minNetMc) continue;
        const id = lockRunId({ horizon: p.horizon, settlesAt: p.settlesAt, key: p.key, strike: p.strike, kalshiId: p.kalshi.id, polyId: p.poly.id, yesOn, noOn: lock.noOn });
        holds.add(id);
        if (held.has(id)) continue;
        const trade: ReplayTrade = {
          horizon: p.horizon,
          settlesAt: p.settlesAt,
          key: p.key,
          strike: p.strike,
          kalshiId: p.kalshi.id,
          polyId: p.poly.id,
          yesOn,
          signalAt: new Date(t).toISOString(),
          signalEdgeMc: lock.edgeMc,
          outcome: "unknown",
          why: "noCycle",
          fillAt: null,
          fillEdgeMc: null,
          capturedMc: 0,
        };
        tradeCount += 1;
        if (trades.length < keepTrades) trades.push(trade);
        for (const tally of tallies(p.horizon)) {
          tally.signals += 1;
          tally.shownAtSignalMc += lock.netMc;
        }
        day.signals += 1;
        pending.push({ trade, signalMs: t, dueMs: t + lagMs, lastMs: t + lagMs + Math.round(c.intervalSec * 1000) + toleranceMs, day: utcDay(c.at) });
      }
    }
    // a run stays held only while its conditions hold: a cycle that does not show them re-arms it
    held = holds;

    const waiting: Pending[] = [];
    for (const p of pending) {
      if (t < p.dueMs) waiting.push(p);
      else if (t > p.lastMs) settle(p, "unknown", "noCycle", null, null);
      else fillAt(p, t, pairs);
    }
    pending = waiting;
  };

  return {
    push(line, fileDay) {
      if (line.kind === "cycle") cycle(line.cycle);
      else if (line.kind === "old") dayOf(utcDay(line.atMs)).cyclesOldFormat += 1;
      else dayOf(fileDay ?? "unknown day").linesSkipped += 1;
    },
    result() {
      // the data ends before these signals' fill cycles: they are unknown, without changing the replay's own state
      const open = pending;
      const totalNow = cloneTally(total);
      const horizonNow = new Map([...byHorizon].map(([h, t]) => [h, cloneTally(t)] as const));
      const dayNow = new Map([...days].map(([k, d]) => [k, { ...d }] as const));
      for (const p of pending) {
        totalNow.noCycle += 1;
        (horizonNow.get(p.trade.horizon) as Tally).noCycle += 1;
        (dayNow.get(p.day) as DayCount).unknown += 1;
      }
      const dayRows: ReplayDay[] = [...dayNow.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([day, d]) => {
          const row: ReplayDay = { day, ...d };
          const note = dayNote(d);
          if (note) row.note = note;
          return row;
        });
      const sum = (f: (d: DayCount) => number) => [...dayNow.values()].reduce((a, d) => a + f(d), 0);
      const old = sum((d) => d.cyclesOldFormat);
      const skipped = sum((d) => d.linesSkipped);
      const read = sum((d) => d.cyclesRead);
      const notes: string[] = [];
      if (old) notes.push(`${old} stored cycle${old === 1 ? " is" : "s are"} in the old form (the gap between the mids only). ${OLD_FORMAT_CANNOT_SAY}`);
      if (skipped) notes.push(`${skipped} line${skipped === 1 ? "" : "s"} could not be read or ran backwards in time and ${skipped === 1 ? "was" : "were"} skipped; nothing was filled in for ${skipped === 1 ? "it" : "them"}.`);
      if (!read) notes.push("No cycle in the range could be replayed.");
      return {
        rule: { ...rule, horizons: [...rule.horizons] },
        lagLabel: lagLabelOf(rule),
        units: UNITS,
        total: summaryOf(totalNow),
        byHorizon: Object.fromEntries(rule.horizons.map((h) => [h, summaryOf(horizonNow.get(h) as Tally)])) as Partial<Record<Horizon, ReplaySummary>>,
        daysCovered: [...dayNow.values()].filter((d) => d.cyclesRead > 0).length,
        cyclesRead: read,
        cyclesOldFormat: old,
        linesSkipped: skipped,
        firstCycleAt: firstMs === null ? null : new Date(firstMs).toISOString(),
        lastCycleAt: firstMs === null ? null : new Date(lastMs).toISOString(),
        days: dayRows,
        signalsOpenAtEnd: open.length,
        trades: trades.map((t) => ({ ...t })),
        tradesNotListed: tradeCount - trades.length,
        notes,
        assumptions: ASSUMPTIONS,
      };
    },
  };
}

const cloneTally = (t: Tally): Tally => ({ ...t, edgesMc: [...t.edgesMc], delaysMs: [...t.delaysMs] });

export const OLD_FORMAT_CANNOT_SAY = "They hold no prices, sizes, fees or read ages, so no signal can be found on them and no trade filled; they are counted and nothing more is said of them.";

function dayNote(d: DayCount): string | null {
  const parts: string[] = [];
  if (d.cyclesOldFormat && !d.cyclesRead) parts.push(`Old form only (${d.cyclesOldFormat} cycles of gaps, no books): nothing can be replayed on this day.`);
  else if (d.cyclesOldFormat) parts.push(`${d.cyclesOldFormat} cycles in the old form (gaps, no books) are not replayed.`);
  if (d.linesSkipped) parts.push(`${d.linesSkipped} line${d.linesSkipped === 1 ? "" : "s"} skipped as unreadable.`);
  return parts.length ? parts.join(" ") : null;
}

/** The replay of a whole run of lines, oldest first. */
export function replayPairs(lines: Iterable<ParsedCycleLine | StoredCycle>, rule: ReplayRule, opts: { keepTrades?: number } = {}): ReplayResult {
  const r = createReplay(rule, opts);
  for (const l of lines) r.push("kind" in l ? l : { kind: "cycle", cycle: l });
  return r.result();
}
