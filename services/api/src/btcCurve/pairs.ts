/**
 * BTC PAIRS: the same above/below contract on Kalshi and Polymarket US, at the money and one
 * strike each way, hourly and 5 PM ET daily, scored for how cleanly both venues quote it.
 *
 * Both venues settle on CF Benchmarks' BRTI at the same instant and list the same strike grid
 * ($100 hourly, $250 daily), so a pair here is one contract with two books, not an analogue.
 * Pure arithmetic over observed quotes; nothing here trades.
 */

import { midCents, takerFeeCents } from "./analytics";
import { normCdf } from "./model";
import type { BookReadFailureKind, BookStamp } from "./bookRead";
import type { Ladder, Venue, VenueQuote } from "./types";

/** fifteen: the 15-minute up/down window (one strike, the price to beat); hourly: the next close; daily: 5 PM ET */
export type Horizon = "fifteen" | "hourly" | "daily";
export type Place = "below" | "atm" | "above";

const MINUTES_PER_YEAR = 365 * 24 * 60;

/**
 * How old one leg's book is, as of the moment its pair was priced. Three clocks, kept apart:
 * ours (when the venue answered), the venue's cache (how long it had already held the answer,
 * the HTTP Age header) and the venue's own stamp on the book. Seconds, one decimal.
 */
export interface LegRead {
  /** when the venue answered our request for this book, our clock (ISO) */
  fetchedAt: string;
  /** seconds from that answer to the pricing */
  fetchAgeSec: number;
  /** seconds the venue's cache said it had held the answer when it gave it; null when it did not say */
  cacheAgeSec: number | null;
  /**
   * The venue's own stamp on the book (ISO); null when the venue gives none. Polymarket US:
   * `marketData.transactTime`, the book's last change, so a quiet book carries an old stamp on
   * a new copy. Kalshi: none on the orderbook.
   */
  venueAt: string | null;
  /** seconds from the venue's stamp to the pricing; null without a stamp */
  venueAgeSec: number | null;
  /** how old the copy that was priced is: fetchAgeSec plus cacheAgeSec */
  ageSec: number;
  /** the venue's state for the market, where it says (Polymarket US: MARKET_STATE_OPEN) */
  state: string | null;
}

const tenth = (ms: number): number => Math.round(Math.max(0, ms) / 100) / 10;

/** A read's stamps as ages at the pricing moment. Exported for tests. */
export function legReadOf(stamp: BookStamp | undefined, pricedAtMs: number): LegRead | null {
  if (!stamp) return null;
  const fetchAgeSec = tenth(pricedAtMs - stamp.fetchedAtMs);
  return {
    fetchedAt: new Date(stamp.fetchedAtMs).toISOString(),
    fetchAgeSec,
    cacheAgeSec: stamp.cacheAgeSec,
    venueAt: stamp.venueAtMs !== null ? new Date(stamp.venueAtMs).toISOString() : null,
    venueAgeSec: stamp.venueAtMs !== null ? tenth(pricedAtMs - stamp.venueAtMs) : null,
    ageSec: Math.round((fetchAgeSec + (stamp.cacheAgeSec ?? 0)) * 10) / 10,
    state: stamp.state,
  };
}

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
  /** when this book was read and how old it was when the pair was priced; null when the quote did not come from a book read */
  read: LegRead | null;
}

/**
 * How long after a contract opens a 404 on its book reads as "listed, not served yet" rather
 * than as a fault. Polymarket US answered 404 for the new 15-minute market for 97 seconds
 * after the 21:15 UTC open on 10 November 2026 while its event listing already showed it; the
 * refusal came from the venue's cache, which had held it 225 seconds and let it go at 300. Ten
 * minutes covers that with room; it is a judgment, not a venue rule.
 */
export const BOOK_NOT_SERVED_YET_MS = 10 * 60_000;

/** One venue's book that did not answer this cycle. Nothing on its row is priced. */
export interface BookFailure {
  venue: Venue;
  /** the venue's id for the market (Kalshi ticker / Polymarket US market slug) */
  id: string;
  /** not_served_yet: a 404 within the first minutes after the contract opened */
  kind: "not_served_yet" | BookReadFailureKind;
  status: number | null;
  /** plain words, as the page prints them; no URL */
  reason: string;
  /** for the operator: the URL that was asked */
  url: string;
  /** for the operator: what came back */
  detail: string;
  /** seconds the venue's cache had held the refusal (HTTP Age), when it said */
  cacheAgeSec: number | null;
  /** the listing's own top of book while the book is missing: prices only, no size, never priced */
  listing: { bidCents: number; askCents: number } | null;
}

/** The short name a venue goes by in a sentence on the page (the header has already said Polymarket US in full). */
const venueShort = (v: Venue): string => (v === "kalshi" ? "Kalshi" : "Poly");

/**
 * A failed book read in plain words. A 404 soon after the contract opened is the venue listing
 * the market before it serves the book; anything else is said as what happened. Exported for tests.
 */
export function bookFailureOf(q: VenueQuote, nowMs: number): BookFailure | null {
  const f = q.failure;
  if (!f) return null;
  const name = venueShort(q.venue);
  const openedMs = q.openedAt ? Date.parse(q.openedAt) : NaN;
  const justOpened = f.kind === "http" && f.status === 404 && Number.isFinite(openedMs) && nowMs >= openedMs && nowMs - openedMs <= BOOK_NOT_SERVED_YET_MS;
  const what = f.kind === "http" ? `HTTP ${f.status ?? "error"}` : f.kind === "timeout" ? "timed out" : "no connection";
  const listed = q.bidCents > 0 || (q.askCents > 0 && q.askCents < 100);
  return {
    venue: q.venue,
    id: q.id,
    kind: justOpened ? "not_served_yet" : f.kind,
    status: f.status,
    reason: justOpened ? `${name} has listed this contract but is not serving its book yet (usual for a few minutes after it opens)` : `${name} book did not answer (${what})`,
    url: f.url,
    detail: f.detail,
    cacheAgeSec: f.cacheAgeSec,
    listing: listed ? { bidCents: q.bidCents, askCents: q.askCents } : null,
  };
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
  /** realized-vol model: probability BRTI settles at or above the strike, cents of $1; null without a sigma */
  modelCents: number | null;
  /**
   * Books that did not answer this cycle (one per venue at most). That venue's leg is then null,
   * so the row has no gap, no lock and no score, and it is never the tenor's pick.
   */
  errors: BookFailure[];
}

/** One leg of a band: Yes at the lower strike or No at the upper, on the venue that sells it cheapest. */
export interface BandLeg {
  venue: Venue;
  id: string;
  side: "yes" | "no";
  strike: number;
  /** the price taken: the Yes ask, or 100 minus the Yes bid for the No */
  priceCents: number;
  qty: number;
  feeCents: number;
}

/**
 * The range between two neighbouring strikes, built the way a trader builds it on an
 * above/below ladder: Yes just below plus No just above. One leg pays for sure; both pay
 * inside. So the band costs (Yes ask at the lower) minus (Yes bid at the upper) plus fees, per
 * $1 paid when BRTI settles inside, and the venues' own mids say what they think that is worth.
 */
export interface Band {
  lower: number;
  upper: number;
  widthUsd: number;
  /** what each venue's mids imply for settling inside, cents of $1 */
  impliedKalshiCents: number | null;
  impliedPolyCents: number | null;
  /** the mean of what both venues imply, or the one that shows */
  impliedCents: number | null;
  /** realized-vol model probability of settling inside, cents; null without a sigma */
  modelCents: number | null;
  /** the cheapest way to own the band across the two venues, after both fees */
  cost: { legs: [BandLeg, BandLeg]; costCents: number; feesCents: number; qty: number } | null;
  /** implied minus cost: the premium paid over the venues' own mids (negative) or a cross (positive) */
  edgeCents: number | null;
  /** the band's width in one-sigma moves to the close; null without a sigma */
  sigmas: number | null;
}

interface RealizedWindow {
  minutes: number;
  /** high minus low over the window, USD */
  rangeUsd: number;
  /** last minus first, USD */
  netUsd: number;
  /** realized vol from one-minute returns, percent per year; null with too few samples */
  volPct: number | null;
  /** one-minute samples used */
  n: number;
}

/** Trailing realized movement of the settlement index: is the market contained or expanding right now. */
export interface Regime {
  m15: RealizedWindow | null;
  m60: RealizedWindow | null;
  /** the 15-minute realized vol against the hour's: under 0.7 contained, over 1.4 expanding */
  label: "contained" | "steady" | "expanding" | null;
  reading: string;
}

export interface HorizonSet {
  horizon: Horizon;
  settlesAt: string;
  minutesToClose: number;
  secondsToClose: number;
  /** strike spacing on this ladder, USD; 0 on the one-strike 15-minute window */
  stepUsd: number;
  /** the three strikes: below, at the money, above (the 15-minute window has the one strike, the price to beat) */
  pairs: StrikePair[];
  /** the ranges between the strikes, Yes just below plus No just above */
  bands: Band[];
  /** one standard deviation of BRTI to the close at the trailing realized vol, USD; null without a vol */
  sigmaUsd: number | null;
  /** the id the tenor's Launch button sends by default: the cleanest scored pair, else the money */
  pick: string | null;
  /** a wider look, mids only: the strikes around the money on both venues */
  context: Array<{ strike: number; kalshiMid: number | null; polyMid: number | null; gapCents: number | null }>;
  venues: { kalshi: boolean; poly: boolean };
  kalshiEvent: string | null;
  polyEvent: string | null;
}

export interface PairsReport {
  /** when the cycle began (ISO) */
  at: string;
  /** when the books had been read and the pairs were priced (ISO); every read age is as of this moment */
  pricedAt: string;
  spotUsd: number;
  spotSource: string;
  intervalSec: number;
  historyPoints: number;
  collectingSince: string | null;
  fifteen: HorizonSet | null;
  hourly: HorizonSet | null;
  daily: HorizonSet | null;
  regime: Regime | null;
  /** every pair with a score, best first */
  bundle: StrikePair[];
  health: Record<string, { ok: boolean; ms: number; detail?: string }>;
  /** every book that did not answer this cycle, with the tenor and strike it belongs to; for the operator */
  errors: Array<BookFailure & { horizon: Horizon; strike: number }>;
}

/** The failed books of a cycle, flat, with where each belongs. */
export function reportErrors(sets: Array<HorizonSet | null>): PairsReport["errors"] {
  return sets.flatMap((s) => (s ? s.pairs.flatMap((p) => p.errors.map((e) => ({ ...e, horizon: p.horizon, strike: p.strike }))) : []));
}

/** The id a pair is launched and looked up by: the Kalshi ticker, else the Polymarket US slug, else tenor:strike. */
export function pairId(p: Pick<StrikePair, "kalshi" | "poly" | "horizon" | "strike">): string {
  return p.kalshi?.id ?? p.poly?.id ?? `${p.horizon}:${p.strike}`;
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

function legOf(q: VenueQuote | null, url: string, pricedAtMs: number): PairLeg | null {
  if (!q) return null;
  return { venue: q.venue, id: q.id, bidCents: q.bidCents, askCents: q.askCents, bidQty: q.bidQty, askQty: q.askQty, feeTheta: q.feeTheta, url, read: legReadOf(q.read, pricedAtMs) };
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
  if (p.errors.length) return p.errors.map((e) => e.reason).join("; ");
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

/* ---- realized movement of the index ---- */

function realizedWindow(series: Array<[number, number]>, nowMs: number, minutes: number): RealizedWindow | null {
  const from = nowMs - minutes * 60_000;
  const pts = series.filter(([t, v]) => t >= from && t <= nowMs && v > 0);
  if (pts.length < 2) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (const [, v] of pts) {
    if (v > hi) hi = v;
    if (v < lo) lo = v;
  }
  // one sample per minute, the last print at or before each minute mark
  const samples: number[] = [];
  let i = 0;
  for (let t = pts[0][0]; t <= nowMs; t += 60_000) {
    while (i + 1 < pts.length && pts[i + 1][0] <= t) i += 1;
    samples.push(pts[i][1]);
  }
  const rets: number[] = [];
  for (let j = 1; j < samples.length; j += 1) rets.push(Math.log(samples[j] / samples[j - 1]));
  let volPct: number | null = null;
  if (rets.length >= Math.min(5, minutes - 1)) {
    const mean = rets.reduce((a, r) => a + r, 0) / rets.length;
    const varc = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length;
    volPct = Math.round(Math.sqrt(varc) * Math.sqrt(MINUTES_PER_YEAR) * 1000) / 10;
  }
  return { minutes, rangeUsd: Math.round(hi - lo), netUsd: Math.round(pts[pts.length - 1][1] - pts[0][1]), volPct, n: rets.length };
}

/**
 * Contained or expanding: the last 15 minutes of BRTI against the last hour. The series is
 * [ms, usd] prints at about one a second. Exported for tests.
 */
export function regimeOf(series: Array<[number, number]>, nowMs: number): Regime {
  const m15 = realizedWindow(series, nowMs, 15);
  const m60 = realizedWindow(series, nowMs, 60);
  let label: Regime["label"] = null;
  if (m15?.volPct !== null && m15?.volPct !== undefined && m60?.volPct) {
    const ratio = m15.volPct / m60.volPct;
    label = ratio >= 1.4 ? "expanding" : ratio <= 0.7 ? "contained" : "steady";
  }
  const usd = (v: number) => `$${Math.abs(v).toLocaleString("en-US")}`;
  const parts: string[] = [];
  if (m15) parts.push(`last 15 min: range ${usd(m15.rangeUsd)}, net ${m15.netUsd >= 0 ? "+" : "−"}${usd(m15.netUsd)}${m15.volPct !== null ? `, realized ${m15.volPct.toFixed(0)}%` : ""}`);
  if (m60) parts.push(`last hour: range ${usd(m60.rangeUsd)}${m60.volPct !== null ? `, realized ${m60.volPct.toFixed(0)}%` : ""}`);
  if (!parts.length) parts.push("not enough index prints yet");
  const reading = label ? `${label}: ${parts.join(" · ")}` : parts.join(" · ");
  return { m15, m60, label, reading };
}

/** One standard deviation of the index over the minutes to the close at the given annualized vol, USD. Exported for tests. */
export function sigmaToClose(spotUsd: number, volPct: number | null | undefined, minutes: number): number | null {
  if (!(spotUsd > 0) || volPct === null || volPct === undefined || !(volPct > 0) || !(minutes > 0)) return null;
  return Math.round(spotUsd * (volPct / 100) * Math.sqrt(minutes / MINUTES_PER_YEAR));
}

/** Model probability the index settles at or above `level`, cents; a normal move of one sigma around spot. */
function modelAbove(spotUsd: number, level: number, sigmaUsd: number | null): number | null {
  if (sigmaUsd === null || !(sigmaUsd > 0)) return null;
  return Math.round(normCdf((spotUsd - level) / sigmaUsd) * 1000) / 10;
}

/**
 * The band between two neighbouring pairs: implied by each venue's mids, priced the cheapest
 * way across both venues (Yes at the lower strike on either, No at the upper on either), and
 * measured in sigmas. Exported for tests.
 */
export function bandOf(lowerPair: StrikePair, upperPair: StrikePair, spotUsd: number, sigmaUsd: number | null): Band {
  const mid = (l: PairLeg | null) => (l && l.bidCents > 0 && l.askCents > 0 && l.askCents < 100 ? (l.bidCents + l.askCents) / 2 : null);
  const implied = (a: number | null, b: number | null) => (a !== null && b !== null ? Math.round((a - b) * 100) / 100 : null);
  const impliedKalshi = implied(mid(lowerPair.kalshi), mid(upperPair.kalshi));
  const impliedPoly = implied(mid(lowerPair.poly), mid(upperPair.poly));
  const shown = [impliedKalshi, impliedPoly].filter((v): v is number => v !== null);
  const impliedCents = shown.length ? Math.round((shown.reduce((a, v) => a + v, 0) / shown.length) * 100) / 100 : null;

  const yesLegs = [lowerPair.kalshi, lowerPair.poly]
    .filter((l): l is PairLeg => Boolean(l && l.askCents > 0 && l.askCents < 100))
    .map((l): BandLeg => ({ venue: l.venue, id: l.id, side: "yes", strike: lowerPair.strike, priceCents: l.askCents, qty: l.askQty, feeCents: takerFeeCents(l.feeTheta, l.askCents) }));
  const noLegs = [upperPair.kalshi, upperPair.poly]
    .filter((l): l is PairLeg => Boolean(l && l.bidCents > 0))
    .map((l): BandLeg => {
      const price = Math.round((100 - l.bidCents) * 100) / 100;
      return { venue: l.venue, id: l.id, side: "no", strike: upperPair.strike, priceCents: price, qty: l.bidQty, feeCents: takerFeeCents(l.feeTheta, price) };
    });
  let cost: Band["cost"] = null;
  for (const y of yesLegs) {
    for (const n of noLegs) {
      const fees = y.feeCents + n.feeCents;
      const c = y.priceCents + n.priceCents + fees - 100;
      if (!cost || c < cost.costCents) {
        cost = { legs: [y, n], costCents: Math.round(c * 100) / 100, feesCents: Math.round(fees * 100) / 100, qty: y.qty > 0 && n.qty > 0 ? Math.min(y.qty, n.qty) : 0 };
      }
    }
  }
  const lowerModel = modelAbove(spotUsd, lowerPair.strike, sigmaUsd);
  const upperModel = modelAbove(spotUsd, upperPair.strike, sigmaUsd);
  return {
    lower: lowerPair.strike,
    upper: upperPair.strike,
    widthUsd: upperPair.strike - lowerPair.strike,
    impliedKalshiCents: impliedKalshi,
    impliedPolyCents: impliedPoly,
    impliedCents,
    modelCents: lowerModel !== null && upperModel !== null ? Math.round((lowerModel - upperModel) * 10) / 10 : null,
    cost,
    edgeCents: impliedCents !== null && cost ? Math.round((impliedCents - cost.costCents) * 100) / 100 : null,
    sigmas: sigmaUsd ? Math.round(((upperPair.strike - lowerPair.strike) / sigmaUsd) * 100) / 100 : null,
  };
}

export interface SetOptions {
  /** trailing realized vol, percent per year, for the sigma to the close and the model column */
  volPct?: number | null;
  /** when the books had been read, ms; read ages are measured to it. Defaults to the cycle's own time. */
  pricedAtMs?: number;
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
  opts: SetOptions = {},
): HorizonSet | null {
  const levels = strikeLevels(ladder);
  const picked = selectStrikes(levels, spotUsd);
  if (!picked) return null;
  return buildSet(horizon, ladder, polyLadderId, spotUsd, nowMs, history, urls, [["below", picked.below], ["atm", picked.atm], ["above", picked.above]], gridStep(levels), opts);
}

/**
 * The 15-minute window: one contract per venue, the strike is the price to beat (the BRTI
 * average before the window opened), so the set has one pair and no bands. Exported for tests.
 */
export function fifteenSet(ladder: Ladder, polyLadderId: string | null, spotUsd: number, nowMs: number, history: GapHistory, urls: VenueUrls, opts: SetOptions = {}): HorizonSet | null {
  const levels = strikeLevels(ladder);
  if (!levels.length || !(spotUsd > 0)) return null;
  // the ladder should hold one strike; with more (two windows merged), the one nearest spot stands
  const level = levels.reduce((a, b) => (Math.abs(b - spotUsd) < Math.abs(a - spotUsd) ? b : a));
  return buildSet("fifteen", ladder, polyLadderId, spotUsd, nowMs, history, urls, [["atm", level]], 0, opts);
}

function buildSet(
  horizon: Horizon,
  ladder: Ladder,
  polyLadderId: string | null,
  spotUsd: number,
  nowMs: number,
  history: GapHistory,
  urls: VenueUrls,
  strikes: Array<[Place, number]>,
  step: number,
  opts: SetOptions,
): HorizonSet {
  const levels = strikeLevels(ladder);
  const secondsToClose = Math.max(0, Math.round((Date.parse(ladder.settlesAt) - nowMs) / 1000));
  const sigmaUsd = sigmaToClose(spotUsd, opts.volPct, secondsToClose / 60);
  const kalshiQuotes = ladder.quotes.filter((q) => q.venue === "kalshi");
  const polyQuotes = ladder.quotes.filter((q) => q.venue === "polymarket_us");
  const kalshiEvent = kalshiQuotes[0] ? kalshiEventTicker(kalshiQuotes[0].id) : null;
  const polyEvent = polyLadderId ? polyEventSlug(polyLadderId) : null;
  const byKey = (venue: Venue, key: string) => ladder.quotes.find((q) => q.venue === venue && q.bucketKey === key) ?? null;
  const keyOf = (strike: number) => ladder.buckets.find((b) => b.kind === "above" && b.level === strike)?.key ?? `above:${strike}`;

  const pairAt = (place: Place, strike: number): StrikePair => {
    const key = keyOf(strike);
    const kListed = byKey("kalshi", key);
    const pListed = byKey("polymarket_us", key);
    // a book that did not answer leaves only the listing's price, which is never priced: the leg reads as absent
    const k = kListed?.failure ? null : kListed;
    const p = pListed?.failure ? null : pListed;
    const errors = [kListed, pListed].map((q) => (q ? bookFailureOf(q, nowMs) : null)).filter((e): e is BookFailure => e !== null);
    const pricedAtMs = opts.pricedAtMs ?? nowMs;
    const kLeg = legOf(k, k ? urls.kalshi({ ticker: k.id, eventTicker: kalshiEventTicker(k.id) }) : "", pricedAtMs);
    const pLeg = legOf(p, p ? urls.poly({ slug: p.id, eventSlug: polyEvent ?? "" }) : "", pricedAtMs);
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
      modelCents: modelAbove(spotUsd, strike, sigmaUsd),
      errors,
    };
    return { ...base, reading: readingOf(base) };
  };

  const pairs = strikes.map(([place, strike]) => pairAt(place, strike));
  const bands: Band[] = [];
  for (let j = 1; j < pairs.length; j += 1) bands.push(bandOf(pairs[j - 1], pairs[j], spotUsd, sigmaUsd));
  const money = pairs.find((p) => p.place === "atm") ?? pairs[0];
  const i = levels.indexOf(money.strike);
  const context =
    pairs.length > 1
      ? levels.slice(Math.max(0, i - 4), i + 5).map((strike) => {
          const key = keyOf(strike);
          const km = midCents(byKey("kalshi", key));
          const pm = midCents(byKey("polymarket_us", key));
          return { strike, kalshiMid: km, polyMid: pm, gapCents: km !== null && pm !== null ? Math.round((km - pm) * 100) / 100 : null };
        })
      : [];
  const scored = pairs.filter((p) => p.score !== null).sort((a, b) => (b.score as number) - (a.score as number) || (b.lock?.edgeCents ?? -99) - (a.lock?.edgeCents ?? -99));
  return {
    horizon,
    settlesAt: ladder.settlesAt,
    minutesToClose: Math.round(secondsToClose / 60),
    secondsToClose,
    stepUsd: step,
    pairs,
    bands,
    sigmaUsd,
    pick: scored[0] ? pairId(scored[0]) : (money.kalshi || money.poly) && !money.errors.length ? pairId(money) : null,
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
