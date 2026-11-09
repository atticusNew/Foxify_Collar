/**
 * BTC PAIRS: the same above/below contract on Kalshi and Polymarket US, at the money and one
 * strike each way, hourly and 5 PM ET daily, scored for how cleanly both venues quote it.
 *
 * Both venues settle on CF Benchmarks' BRTI at the same instant and list the same strike grid
 * ($100 hourly, $250 daily), so a pair here is one contract with two books, not an analogue.
 * Pure arithmetic over observed quotes; nothing here trades.
 */

import { midCents, takerFeeCents } from "./analytics";
import type { Ladder, Venue, VenueQuote } from "./types";

export type Horizon = "hourly" | "daily";
export type Place = "below" | "atm" | "above";

export interface PairLeg {
  venue: Venue;
  /** the venue's own id (Kalshi ticker / Polymarket US market slug) */
  id: string;
  bidCents: number;
  askCents: number;
  bidQty: number;
  askQty: number;
  feeTheta: number;
  /** the venue's page for this contract */
  url: string;
}

/** The cheaper of the two ways to own both sides of the contract: Yes on one venue, No on the other. */
export interface Lock {
  yesOn: Venue;
  noOn: Venue;
  /** the Yes ask taken */
  yesAtCents: number;
  /** the No price taken (100 minus the other venue's Yes bid) */
  noAtCents: number;
  feesCents: number;
  /** yesAt + noAt + fees; under 100 is a cross */
  costCents: number;
  /** 100 minus cost: positive locks that much per $1, negative is what the pair costs to carry */
  edgeCents: number;
  /** the thinner of the two levels taken, contracts */
  qty: number;
}

export interface Persistence {
  /** readings in the window */
  n: number;
  /** share of readings whose Kalshi minus Poly gap had the sign of the current one */
  sameSign: number;
  meanGapCents: number;
  /** [atMs, gap] for a sparkline */
  series: Array<[number, number]>;
}

export interface StrikePair {
  horizon: Horizon;
  place: Place;
  strike: number;
  key: string;
  settlesAt: string;
  kalshi: PairLeg | null;
  poly: PairLeg | null;
  /** both venues show a bid and an ask */
  twoSided: boolean;
  /** Kalshi mid minus Polymarket US mid, cents */
  gapCents: number | null;
  /** Kalshi spread plus Polymarket US spread, cents */
  spreadCents: number | null;
  /** the thinnest of the four best levels, contracts */
  depth: number | null;
  lock: Lock | null;
  persistence: Persistence | null;
  /** 0..100: tight, deep and in agreement on both venues; null unless two-sided on both */
  score: number | null;
  /** why the score is what it is, or why there is none */
  reading: string;
}

export interface HorizonSet {
  horizon: Horizon;
  settlesAt: string;
  minutesToClose: number;
  /** strike spacing on this ladder, USD */
  stepUsd: number;
  /** the three strikes: below, at the money, above */
  pairs: StrikePair[];
  /** a wider look, mids only: the strikes around the money on both venues */
  context: Array<{ strike: number; kalshiMid: number | null; polyMid: number | null; gapCents: number | null }>;
  venues: { kalshi: boolean; poly: boolean };
  kalshiEvent: string | null;
  polyEvent: string | null;
}

export interface PairsReport {
  at: string;
  spotUsd: number;
  spotSource: string;
  intervalSec: number;
  historyPoints: number;
  collectingSince: string | null;
  hourly: HorizonSet | null;
  daily: HorizonSet | null;
  /** every pair with a score, best first */
  bundle: StrikePair[];
  health: Record<string, { ok: boolean; ms: number; detail?: string }>;
}

/** One cycle's gap readings kept for persistence: `${settlesAt}|${key}` to [atMs, Kalshi mid minus Poly mid]. */
export type GapHistory = Map<string, Array<[number, number]>>;

export function gapHistoryKey(settlesAt: string, key: string): string {
  return `${settlesAt}|${key}`;
}

export interface VenueUrls {
  kalshi: (leg: { ticker: string; eventTicker: string }) => string;
  poly: (leg: { slug: string; eventSlug: string }) => string;
}

/** Strike levels present on a ladder (above-type buckets only), ascending. */
export function strikeLevels(l: Ladder): number[] {
  return l.buckets.filter((b) => b.kind === "above" && typeof b.level === "number").map((b) => b.level as number).sort((a, b) => a - b);
}

/** The grid spacing as the ladder shows it: the most common gap between neighbouring strikes. */
export function gridStep(levels: number[]): number {
  const counts = new Map<number, number>();
  for (let i = 1; i < levels.length; i += 1) {
    const d = Math.round((levels[i] - levels[i - 1]) * 100) / 100;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best = 0;
  let bestN = -1;
  for (const [d, n] of counts) if (n > bestN) [best, bestN] = [d, n];
  return best;
}

/**
 * At the money and one strike each way. The money is the strike nearest spot among those the
 * ladder lists; the neighbours are the ladder's own next strikes, so a gap in a venue's listing
 * reads as a gap and not as a made-up level. Exported for tests.
 */
export function selectStrikes(levels: number[], spotUsd: number): { below: number; atm: number; above: number } | null {
  if (levels.length < 3 || !(spotUsd > 0)) return null;
  let i = 0;
  for (let j = 1; j < levels.length; j += 1) if (Math.abs(levels[j] - spotUsd) < Math.abs(levels[i] - spotUsd)) i = j;
  if (i === 0) i = 1;
  if (i === levels.length - 1) i = levels.length - 2;
  return { below: levels[i - 1], atm: levels[i], above: levels[i + 1] };
}

function legOf(q: VenueQuote | null, url: string): PairLeg | null {
  if (!q) return null;
  return { venue: q.venue, id: q.id, bidCents: q.bidCents, askCents: q.askCents, bidQty: q.bidQty, askQty: q.askQty, feeTheta: q.feeTheta, url };
}

const quoted = (q: VenueQuote | null): boolean => Boolean(q && q.bidCents > 0 && q.askCents > 0 && q.askCents < 100);

/** The cheaper way to own both sides across the two venues, after both taker fees. Exported for tests. */
export function lockOf(k: VenueQuote | null, p: VenueQuote | null): Lock | null {
  if (!k || !p) return null;
  const dir = (yes: VenueQuote, no: VenueQuote): Lock | null => {
    if (!(yes.askCents > 0 && yes.askCents < 100) || !(no.bidCents > 0)) return null;
    const noAt = Math.round((100 - no.bidCents) * 100) / 100;
    const fees = takerFeeCents(yes.feeTheta, yes.askCents) + takerFeeCents(no.feeTheta, noAt);
    const cost = yes.askCents + noAt + fees;
    const qty = yes.askQty > 0 && no.bidQty > 0 ? Math.min(yes.askQty, no.bidQty) : 0;
    return {
      yesOn: yes.venue,
      noOn: no.venue,
      yesAtCents: yes.askCents,
      noAtCents: noAt,
      feesCents: Math.round(fees * 100) / 100,
      costCents: Math.round(cost * 100) / 100,
      edgeCents: Math.round((100 - cost) * 100) / 100,
      qty,
    };
  };
  const a = dir(k, p);
  const b = dir(p, k);
  if (!a) return b;
  if (!b) return a;
  return a.costCents <= b.costCents ? a : b;
}

/**
 * How cleanly the pair trades on both venues, 0..100. Three parts: how tight the two books are
 * together (both spreads summed; 0¢ scores full, 10¢ scores nothing), how deep the thinnest best
 * level is (200 contracts scores full), and how closely the two mids agree (0¢ apart scores full,
 * 5¢ apart scores nothing). Null unless both venues show a bid and an ask. Exported for tests.
 */
export function cleanScore(spreadCents: number | null, depth: number | null, gapCents: number | null): number | null {
  if (spreadCents === null || gapCents === null) return null;
  const tight = Math.max(0, 1 - spreadCents / 10);
  const deep = Math.min(1, (depth ?? 0) / 200);
  const agree = Math.max(0, 1 - Math.abs(gapCents) / 5);
  return Math.round((0.4 * tight + 0.3 * deep + 0.3 * agree) * 100);
}

/** Persistence of the current gap over the window: how often it had this sign, and its mean. Exported for tests. */
export function persistenceOf(series: Array<[number, number]> | undefined, currentGap: number | null): Persistence | null {
  if (!series || series.length < 2 || currentGap === null) return null;
  const sign = Math.sign(currentGap);
  const same = sign === 0 ? series.filter(([, g]) => Math.abs(g) < 0.5).length : series.filter(([, g]) => Math.sign(g) === sign && Math.abs(g) >= 0.5).length;
  const mean = series.reduce((a, [, g]) => a + g, 0) / series.length;
  return { n: series.length, sameSign: Math.round((same / series.length) * 100) / 100, meanGapCents: Math.round(mean * 100) / 100, series };
}

function readingOf(p: Omit<StrikePair, "reading">): string {
  if (!p.kalshi && !p.poly) return "neither venue lists this strike";
  if (!p.kalshi) return "Kalshi does not list this strike";
  if (!p.poly) return "Polymarket US does not list this strike";
  const oneSided = (l: PairLeg, name: string) => {
    if (l.bidCents > 0 && (l.askCents <= 0 || l.askCents >= 100)) return `${name} has bids only`;
    if (l.bidCents <= 0 && l.askCents > 0 && l.askCents < 100) return `${name} has offers only`;
    if (l.bidCents <= 0 && (l.askCents <= 0 || l.askCents >= 100)) return `${name} shows no book`;
    return null;
  };
  const k = oneSided(p.kalshi, "Kalshi");
  const q = oneSided(p.poly, "Polymarket US");
  if (k || q) return [k, q].filter(Boolean).join("; ");
  const parts: string[] = [];
  if (p.spreadCents !== null) parts.push(p.spreadCents <= 2 ? "tight on both" : p.spreadCents <= 5 ? "spreads add to " + p.spreadCents.toFixed(0) + "¢" : "wide: spreads add to " + p.spreadCents.toFixed(0) + "¢");
  if (p.depth !== null) parts.push(p.depth >= 200 ? "deep" : p.depth >= 50 ? `${Math.round(p.depth)} contracts at the thinnest level` : `thin: ${Math.round(p.depth)} at the thinnest level`);
  if (p.gapCents !== null) parts.push(Math.abs(p.gapCents) < 1 ? "mids agree" : `mids ${Math.abs(p.gapCents).toFixed(1)}¢ apart`);
  if (p.lock && p.lock.edgeCents > 0) parts.push(`cross: both sides for ${p.lock.costCents.toFixed(2)}¢`);
  return parts.join(" · ");
}

/** Kalshi's event ticker from a market ticker: `KXBTCD-26NOV0917-T74499.99` to `KXBTCD-26NOV0917`. */
export function kalshiEventTicker(ticker: string): string {
  const i = ticker.lastIndexOf("-");
  return i > 0 ? ticker.slice(0, i) : ticker;
}

/** Polymarket US event slug from a ladder id `poly:<event slug>:<family>:<date>`. */
export function polyEventSlug(ladderId: string): string | null {
  const parts = ladderId.split(":");
  return parts[0] === "poly" && parts[1] ? parts[1] : null;
}

/**
 * One horizon: the merged ladder (Kalshi spine with the Polymarket US quotes on the same keys,
 * or either alone), spot, and the gap history. Exported for tests.
 */
export function horizonSet(
  horizon: Horizon,
  ladder: Ladder,
  polyLadderId: string | null,
  spotUsd: number,
  nowMs: number,
  history: GapHistory,
  urls: VenueUrls,
): HorizonSet | null {
  const levels = strikeLevels(ladder);
  const picked = selectStrikes(levels, spotUsd);
  if (!picked) return null;
  const step = gridStep(levels);
  const kalshiQuotes = ladder.quotes.filter((q) => q.venue === "kalshi");
  const polyQuotes = ladder.quotes.filter((q) => q.venue === "polymarket_us");
  const kalshiEvent = kalshiQuotes[0] ? kalshiEventTicker(kalshiQuotes[0].id) : null;
  const polyEvent = polyLadderId ? polyEventSlug(polyLadderId) : null;
  const byKey = (venue: Venue, key: string) => ladder.quotes.find((q) => q.venue === venue && q.bucketKey === key) ?? null;
  const keyOf = (strike: number) => ladder.buckets.find((b) => b.kind === "above" && b.level === strike)?.key ?? `above:${strike}`;

  const pairAt = (place: Place, strike: number): StrikePair => {
    const key = keyOf(strike);
    const k = byKey("kalshi", key);
    const p = byKey("polymarket_us", key);
    const kLeg = legOf(k, k ? urls.kalshi({ ticker: k.id, eventTicker: kalshiEventTicker(k.id) }) : "");
    const pLeg = legOf(p, p ? urls.poly({ slug: p.id, eventSlug: polyEvent ?? "" }) : "");
    const twoSided = quoted(k) && quoted(p);
    const km = midCents(k);
    const pm = midCents(p);
    const gap = km !== null && pm !== null ? Math.round((km - pm) * 100) / 100 : null;
    const spread = twoSided && k && p ? Math.round((k.askCents - k.bidCents + (p.askCents - p.bidCents)) * 100) / 100 : null;
    const sizes = twoSided && k && p ? [k.bidQty, k.askQty, p.bidQty, p.askQty] : [];
    const depth = sizes.length && sizes.every((s) => s > 0) ? Math.min(...sizes) : sizes.length ? 0 : null;
    const base: Omit<StrikePair, "reading"> = {
      horizon,
      place,
      strike,
      key,
      settlesAt: ladder.settlesAt,
      kalshi: kLeg,
      poly: pLeg,
      twoSided,
      gapCents: gap,
      spreadCents: spread,
      depth,
      lock: lockOf(k, p),
      persistence: persistenceOf(history.get(gapHistoryKey(ladder.settlesAt, key)), gap),
      score: twoSided ? cleanScore(spread, depth, gap) : null,
    };
    return { ...base, reading: readingOf(base) };
  };

  const pairs = [pairAt("below", picked.below), pairAt("atm", picked.atm), pairAt("above", picked.above)];
  const i = levels.indexOf(picked.atm);
  const context = levels.slice(Math.max(0, i - 4), i + 5).map((strike) => {
    const key = keyOf(strike);
    const km = midCents(byKey("kalshi", key));
    const pm = midCents(byKey("polymarket_us", key));
    return { strike, kalshiMid: km, polyMid: pm, gapCents: km !== null && pm !== null ? Math.round((km - pm) * 100) / 100 : null };
  });
  return {
    horizon,
    settlesAt: ladder.settlesAt,
    minutesToClose: Math.round((Date.parse(ladder.settlesAt) - nowMs) / 60_000),
    stepUsd: step,
    pairs,
    context,
    venues: { kalshi: kalshiQuotes.length > 0, poly: polyQuotes.length > 0 },
    kalshiEvent,
    polyEvent,
  };
}

/** The bundle: every scored pair, best first; ties go to the larger locked edge, then the nearer close. */
export function bundleOf(sets: Array<HorizonSet | null>): StrikePair[] {
  return sets
    .flatMap((s) => s?.pairs ?? [])
    .filter((p) => p.score !== null)
    .sort((a, b) => (b.score as number) - (a.score as number) || (b.lock?.edgeCents ?? -99) - (a.lock?.edgeCents ?? -99) || Date.parse(a.settlesAt) - Date.parse(b.settlesAt));
}

/**
 * Append this cycle's gaps to the history, drop readings older than the window, and refresh each
 * pair's persistence so the reading includes this cycle.
 */
export function recordGaps(history: GapHistory, sets: Array<HorizonSet | null>, atMs: number, keepMs: number): void {
  for (const s of sets) {
    if (!s) continue;
    for (const p of s.pairs) {
      if (p.gapCents === null) continue;
      const k = gapHistoryKey(p.settlesAt, p.key);
      const arr = history.get(k) ?? [];
      arr.push([atMs, p.gapCents]);
      history.set(k, arr);
    }
  }
  for (const [k, arr] of history) {
    const kept = arr.filter(([t]) => atMs - t <= keepMs);
    if (kept.length) history.set(k, kept);
    else history.delete(k);
  }
  for (const s of sets) {
    if (!s) continue;
    for (const p of s.pairs) p.persistence = persistenceOf(history.get(gapHistoryKey(p.settlesAt, p.key)), p.gapCents);
  }
}
