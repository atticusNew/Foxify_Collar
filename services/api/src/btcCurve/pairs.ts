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

export type Freshness = "fresh" | "stale";

/**
 * Seconds beyond which a book copy is too old for its gap to be read as a quoting difference.
 * A judgment from two short samples of the live books, not a venue constant and not a tested
 * threshold: Polymarket US serves its public book through a cache that holds each copy up to
 * 30 seconds (copies were seen at every age from 0 to 29), while Kalshi's order book is served
 * live and moved several times within one such copy's life. Fifteen seconds on the 15-minute
 * window keeps the younger half of those copies; thirty on the hourly and daily, which move
 * less per second, keeps a whole cache life. `BTC_PAIRS_STALE_SECONDS` overrides.
 */
export const STALE_AFTER_SEC: Readonly<Record<Horizon, number>> = { fifteen: 15, hourly: 30, daily: 30 };

const STALE_KEYS: Record<string, Horizon> = { "15m": "fifteen", fifteen: "fifteen", "1h": "hourly", hourly: "hourly", "1d": "daily", daily: "daily" };

/** `15m=15,1h=30,1d=30` (any subset, any order) over the defaults; entries that do not read as a tenor and a positive number are ignored. Exported for tests. */
export function staleBoundsFrom(spec: string | undefined | null, base: Readonly<Record<Horizon, number>> = STALE_AFTER_SEC): Record<Horizon, number> {
  const out = { ...base };
  for (const part of (spec ?? "").split(",")) {
    const [k, v] = part.split("=").map((x) => x.trim().toLowerCase());
    const horizon = STALE_KEYS[k];
    const n = Number(v);
    if (horizon && v !== "" && Number.isFinite(n) && n > 0) out[horizon] = n;
  }
  return out;
}

/**
 * Fresh or stale from the two copies' ages against the tenor's bound: stale when either is
 * older than the bound. Null when either age is unknown (a venue absent, or a quote that did
 * not come from a book read): there is nothing to judge. Exported for tests.
 */
export function freshnessOf(kalshiAgeSec: number | null | undefined, polyAgeSec: number | null | undefined, staleAfterSec: number): Freshness | null {
  if (kalshiAgeSec === null || kalshiAgeSec === undefined || polyAgeSec === null || polyAgeSec === undefined) return null;
  return kalshiAgeSec > staleAfterSec || polyAgeSec > staleAfterSec ? "stale" : "fresh";
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
  /**
   * Whether the two books were read recently enough for the gap and the lock to mean anything:
   * stale when either copy's age (`read.ageSec`) is over `staleAfterSec`. A stale row still shows
   * both books; its gap is not added to the persistence window, it is not the tenor's default
   * pick, and it adds nothing to a lock episode. Null when a venue is absent or carries no read time.
   */
  freshness: Freshness | null;
  /** the bound this row was judged against, seconds */
  staleAfterSec: number;
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
  /** the id the tenor's Launch button sends by default: the cleanest scored pair on a read that is not stale, else the money on the same terms, else none */
  pick: string | null;
  /** seconds beyond which a book copy is stale on this tenor */
  staleAfterSec: number;
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
  /** every pair with a score, best first; pairs on a stale read come after every pair that is not */
  bundle: StrikePair[];
  /** seconds beyond which a book copy is stale, per tenor */
  staleAfterSec: Record<Horizon, number>;
  health: Record<string, { ok: boolean; ms: number; detail?: string }>;
  /** every book that did not answer this cycle, with the tenor and strike it belongs to; for the operator */
  errors: Array<BookFailure & { horizon: Horizon; strike: number }>;
  /** runs of consecutive cycles in which one pair showed a lock after fees on fresh reads, today (UTC), per tenor */
  lockEpisodes: LockEpisodesReport;
}

/** One cycle's sighting of a lock after fees on a fresh read: which pair, which way round, how much, at what size. */
export interface LockSighting {
  horizon: Horizon;
  settlesAt: string;
  key: string;
  strike: number;
  kalshiId: string;
  polyId: string;
  yesOn: Venue;
  noOn: Venue;
  /** lock after both fees, cents per contract */
  lockCents: number;
  /** the thinner of the two top-of-book levels taken, contracts: the size the lock is quoted at */
  qty: number;
}

/** A cycle's row whose reads say nothing about a lock either way: a stale read, a read with no age, a book that did not answer. */
export interface UnjudgedPair {
  horizon: Horizon;
  settlesAt: string;
  key: string;
  /** null when that venue's book did not answer */
  kalshiId: string | null;
  polyId: string | null;
}

/** A run still going: the same pair, the same way round, with no cycle since it began that showed the lock gone. */
export interface LockRun extends Omit<LockSighting, "lockCents" | "qty"> {
  id: string;
  startedAtMs: number;
  /** the last cycle that showed the lock */
  lastAtMs: number;
  /** the last cycle that had the pair at all, lock shown or reads unjudged: what a gap in the cycles is measured from */
  seenAtMs: number;
  /** cycles that showed the lock */
  cycles: number;
  minLockCents: number;
  minQty: number;
}

export interface LockEpisode extends Omit<LockSighting, "lockCents" | "qty"> {
  /** the first cycle that showed the lock (ISO) */
  startedAt: string;
  /** the last cycle that showed it (ISO) */
  endedAt: string;
  /** end minus start: the span over which the lock was seen, not how long it existed */
  durationSec: number;
  cycles: number;
  /** the smallest lock seen in the run, cents per contract */
  minLockCents: number;
  /** the smallest size seen in the run, contracts */
  minQty: number;
  /** minLockCents times minQty, cents: a floor on what was on the book for the whole run */
  valueCents: number;
  /** true while the run is still going; the figures are as of the last cycle */
  open?: true;
}

/** What the collector carries between cycles: the runs still going and the episodes kept. */
export interface EpisodeBook {
  open: LockRun[];
  /** oldest first */
  finished: LockEpisode[];
}

export interface EpisodeSummary {
  /** episodes today (UTC, by the cycle that last showed the lock), counting those still open */
  episodes: number;
  open: number;
  medianDurationSec: number | null;
  longestDurationSec: number | null;
  /** the episodes' valueCents summed, cents */
  totalValueCents: number;
  /** the latest few, newest first, open ones included */
  recent: LockEpisode[];
}

export interface LockEpisodesReport {
  label: string;
  /** the UTC day the counts are for, YYYY-MM-DD */
  day: string;
  /** a lock seen on fewer consecutive cycles than this is not an episode */
  minCycles: number;
  fifteen: EpisodeSummary;
  hourly: EpisodeSummary;
  daily: EpisodeSummary;
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

/** What the lock arithmetic reads from one venue's top of book. A live quote and a leg stored in the cycle file both carry it. */
export type LockQuote = Pick<VenueQuote, "venue" | "bidCents" | "askCents" | "bidQty" | "askQty" | "feeTheta">;

/**
 * One way round: Yes at `yes`'s ask, No at 100 minus `no`'s Yes bid, both taker fees for one
 * contract. Null when either price is not there. The replay prices a trade the way round it
 * was signalled, so this is exported beside `lockOf`, which picks the cheaper of the two.
 */
export function lockOneWay(yes: LockQuote, no: LockQuote): Lock | null {
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
}

/** The cheaper way to own both sides across the two venues, after both taker fees. Exported for tests. */
export function lockOf(k: LockQuote | null, p: LockQuote | null): Lock | null {
  if (!k || !p) return null;
  const a = lockOneWay(k, p);
  const b = lockOneWay(p, k);
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
  if (p.freshness === "stale") parts.push(staleReading(p));
  else if (p.lock && p.lock.edgeCents > 0) parts.push(`cross: both sides for ${p.lock.costCents.toFixed(2)}¢`);
  return parts.join(" · ");
}

/** Which copy is too old, and by how much against the bound. */
function staleReading(p: Pick<StrikePair, "kalshi" | "poly" | "staleAfterSec">): string {
  const old = [p.kalshi, p.poly]
    .filter((l): l is PairLeg => Boolean(l?.read && l.read.ageSec > p.staleAfterSec))
    .map((l) => `${venueShort(l.venue)} copy ${Math.round((l.read as LegRead).ageSec)}s old`);
  return `stale read: ${old.join(", ")} (limit ${p.staleAfterSec}s)`;
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
  /** seconds beyond which a book copy is stale on this tenor; defaults to STALE_AFTER_SEC */
  staleAfterSec?: number;
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
  const staleAfterSec = opts.staleAfterSec ?? STALE_AFTER_SEC[horizon];
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
      freshness: freshnessOf(kLeg?.read?.ageSec, pLeg?.read?.ageSec, staleAfterSec),
      staleAfterSec,
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
  // a row on a stale read or with a book missing is never what Launch sends by default; a row chosen by hand is the trader's call
  const launchable = (p: StrikePair) => p.freshness !== "stale" && !p.errors.length;
  const scored = pairs.filter((p) => p.score !== null && launchable(p)).sort((a, b) => (b.score as number) - (a.score as number) || (b.lock?.edgeCents ?? -99) - (a.lock?.edgeCents ?? -99));
  return {
    horizon,
    settlesAt: ladder.settlesAt,
    minutesToClose: Math.round(secondsToClose / 60),
    secondsToClose,
    stepUsd: step,
    pairs,
    bands,
    sigmaUsd,
    pick: scored[0] ? pairId(scored[0]) : (money.kalshi || money.poly) && launchable(money) ? pairId(money) : null,
    staleAfterSec,
    context,
    venues: { kalshi: kalshiQuotes.length > 0, poly: polyQuotes.length > 0 },
    kalshiEvent,
    polyEvent,
  };
}

/**
 * The bundle: every scored pair, best first; ties go to the larger locked edge, then the nearer
 * close. Pairs on a stale read keep their place in the list but after every pair that is not
 * stale, so the first entry is the cleanest pair whose read can be judged.
 */
export function bundleOf(sets: Array<HorizonSet | null>): StrikePair[] {
  const stale = (p: StrikePair) => (p.freshness === "stale" ? 1 : 0);
  return sets
    .flatMap((s) => s?.pairs ?? [])
    .filter((p) => p.score !== null)
    .sort((a, b) => stale(a) - stale(b) || (b.score as number) - (a.score as number) || (b.lock?.edgeCents ?? -99) - (a.lock?.edgeCents ?? -99) || Date.parse(a.settlesAt) - Date.parse(b.settlesAt));
}

/**
 * Append this cycle's gaps to the history, drop readings older than the window, and refresh each
 * pair's persistence so the reading includes this cycle. A gap on a stale read is not appended:
 * persistence is what separates a quoting difference from latency, so a reading that is itself
 * latency must not count toward it.
 */
export function recordGaps(history: GapHistory, sets: Array<HorizonSet | null>, atMs: number, keepMs: number): void {
  for (const s of sets) {
    if (!s) continue;
    for (const p of s.pairs) {
      if (p.gapCents === null || p.freshness === "stale") continue;
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

/* ---- lock episodes ---- */

/** A lock seen on one cycle only may be a single odd read; two in a row is the least that says it stood. */
export const EPISODE_MIN_CYCLES = 2;
/** Finished episodes kept per tenor from before today; today's are all kept so the day's figures are whole. */
export const EPISODE_KEEP = 50;
export const EPISODE_LABEL = "measured at the size on the book, after fees, no orders placed; a floor on what was there, not what a trader would have captured";

const round2 = (x: number) => Math.round(x * 100) / 100;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function emptyEpisodeBook(): EpisodeBook {
  return { open: [], finished: [] };
}

/** The same contract on both venues, bought the same way round. A lock that flips direction is a different trade and a new run. */
export function lockRunId(s: Omit<LockSighting, "lockCents" | "qty">): string {
  return [s.horizon, s.settlesAt, s.key, s.kalshiId, s.polyId, s.yesOn].join("|");
}

/**
 * This cycle's locks that count toward an episode: both books read fresh (a row whose read
 * cannot be judged is not counted either) and a lock after fees above zero. The size is the
 * one the lock is already quoted at, the thinner of the two top-of-book levels.
 */
export function lockSightings(sets: Array<HorizonSet | null>): LockSighting[] {
  const out: LockSighting[] = [];
  for (const s of sets) {
    if (!s) continue;
    for (const p of s.pairs) {
      if (p.freshness !== "fresh" || p.errors.length || !p.kalshi || !p.poly || !p.lock || !(p.lock.edgeCents > 0)) continue;
      out.push({ horizon: p.horizon, settlesAt: p.settlesAt, key: p.key, strike: p.strike, kalshiId: p.kalshi.id, polyId: p.poly.id, yesOn: p.lock.yesOn, noOn: p.lock.noOn, lockCents: p.lock.edgeCents, qty: p.lock.qty });
    }
  }
  return out;
}

/**
 * This cycle's rows that cannot be judged: still listed (under an id, or the venue's book did
 * not answer) but stale, without a read age, or missing a book. Such a row does not show a lock
 * and does not show it gone, so it neither extends a run nor ends one.
 */
export function unjudgedPairs(sets: Array<HorizonSet | null>): UnjudgedPair[] {
  const out: UnjudgedPair[] = [];
  for (const s of sets) {
    if (!s) continue;
    for (const p of s.pairs) {
      if (p.freshness === "fresh" && !p.errors.length) continue;
      const failed = new Set(p.errors.map((e) => e.venue));
      const listed = (leg: PairLeg | null, venue: Venue) => Boolean(leg) || failed.has(venue);
      if (!listed(p.kalshi, "kalshi") || !listed(p.poly, "polymarket_us")) continue;
      out.push({ horizon: p.horizon, settlesAt: p.settlesAt, key: p.key, kalshiId: failed.has("kalshi") ? null : (p.kalshi?.id ?? null), polyId: failed.has("polymarket_us") ? null : (p.poly?.id ?? null) });
    }
  }
  return out;
}

/** A run as an episode. Dollars are the smallest lock times the smallest size: both were there on every cycle of the run. */
export function episodeOf(run: LockRun, open = false): LockEpisode {
  return {
    horizon: run.horizon,
    settlesAt: run.settlesAt,
    key: run.key,
    strike: run.strike,
    kalshiId: run.kalshiId,
    polyId: run.polyId,
    yesOn: run.yesOn,
    noOn: run.noOn,
    startedAt: new Date(run.startedAtMs).toISOString(),
    endedAt: new Date(run.lastAtMs).toISOString(),
    durationSec: Math.round((run.lastAtMs - run.startedAtMs) / 100) / 10,
    cycles: run.cycles,
    minLockCents: run.minLockCents,
    minQty: run.minQty,
    valueCents: round2(run.minLockCents * run.minQty),
    ...(open ? { open: true as const } : {}),
  };
}

/** Today's episodes (by the cycle that last showed the lock) and, from earlier days, the last `keep` per tenor. Oldest first. */
export function pruneEpisodes(episodes: LockEpisode[], nowMs: number, keep = EPISODE_KEEP): LockEpisode[] {
  const today = utcDay(nowMs);
  const sorted = [...episodes].sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt));
  const older: Record<string, number> = {};
  const kept: LockEpisode[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const e = sorted[i];
    if (e.endedAt.slice(0, 10) === today) kept.push(e);
    else if ((older[e.horizon] = (older[e.horizon] ?? 0) + 1) <= keep) kept.push(e);
  }
  return kept.reverse();
}

/**
 * One cycle. A run whose pair is sighted again is extended (its smallest lock and size carried).
 * A run whose pair is in `unjudged` this cycle (a stale read, a book that did not answer) is
 * carried as it is: nothing showed the lock gone, and ending it here would count one standing
 * lock as a new episode every time a cached copy crossed the stale bound. Any other run ends
 * (fresh reads with no lock, the contract gone from the cycle or from a venue) at the last cycle
 * that showed it, and is an episode only if EPISODE_MIN_CYCLES or more cycles showed it. A
 * sighting with no run opens one. A cycle arriving more than `maxGapMs` after the last cycle
 * that had the run's pair neither extends nor carries it: cycles were missed, so the run is not
 * known to have stood. Returns the new book and the episodes that finished on this cycle; the
 * book passed in is not changed.
 */
export function stepEpisodes(prev: EpisodeBook, sightings: LockSighting[], atMs: number, opts: { maxGapMs?: number; keep?: number; unjudged?: UnjudgedPair[] } = {}): { book: EpisodeBook; finished: LockEpisode[] } {
  const maxGapMs = opts.maxGapMs ?? Number.POSITIVE_INFINITY;
  const seen = new Map(sightings.map((s) => [lockRunId(s), s]));
  const unjudged = opts.unjudged ?? [];
  const carried = (run: LockRun) => unjudged.some((u) => u.horizon === run.horizon && u.settlesAt === run.settlesAt && u.key === run.key && (u.kalshiId === null || u.kalshiId === run.kalshiId) && (u.polyId === null || u.polyId === run.polyId));
  const open: LockRun[] = [];
  const finished: LockEpisode[] = [];
  for (const run of prev.open) {
    const s = seen.get(run.id);
    const inTime = atMs - run.seenAtMs <= maxGapMs;
    if (s && inTime) {
      seen.delete(run.id);
      open.push({ ...run, lastAtMs: atMs, seenAtMs: atMs, cycles: run.cycles + 1, minLockCents: Math.min(run.minLockCents, s.lockCents), minQty: Math.min(run.minQty, s.qty) });
    } else if (!s && inTime && carried(run)) {
      open.push({ ...run, seenAtMs: atMs });
    } else if (run.cycles >= EPISODE_MIN_CYCLES) {
      finished.push(episodeOf(run));
    }
  }
  for (const [id, s] of seen) {
    const { lockCents, qty, ...pair } = s;
    open.push({ ...pair, id, startedAtMs: atMs, lastAtMs: atMs, seenAtMs: atMs, cycles: 1, minLockCents: lockCents, minQty: qty });
  }
  return { book: { open, finished: pruneEpisodes([...prev.finished, ...finished], atMs, opts.keep) }, finished };
}

/** End every run (the collector stopping): those long enough become episodes. */
export function closeEpisodes(prev: EpisodeBook, nowMs: number, keep = EPISODE_KEEP): { book: EpisodeBook; finished: LockEpisode[] } {
  const finished = prev.open.filter((r) => r.cycles >= EPISODE_MIN_CYCLES).map((r) => episodeOf(r));
  return { book: { open: [], finished: pruneEpisodes([...prev.finished, ...finished], nowMs, keep) }, finished };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : Math.round(((a[mid - 1] + a[mid]) / 2) * 10) / 10;
}

/**
 * One tenor's day: the episodes whose last sighting was today (UTC), with the runs still going
 * that already have EPISODE_MIN_CYCLES. An episode that spans midnight belongs to the day it
 * ended.
 */
export function episodeSummary(book: EpisodeBook, horizon: Horizon, nowMs: number, recent = 5): EpisodeSummary {
  const today = utcDay(nowMs);
  const done = book.finished.filter((e) => e.horizon === horizon && e.endedAt.slice(0, 10) === today);
  const running = book.open.filter((r) => r.horizon === horizon && r.cycles >= EPISODE_MIN_CYCLES && utcDay(r.lastAtMs) === today).map((r) => episodeOf(r, true));
  const all = [...done, ...running];
  const durations = all.map((e) => e.durationSec);
  return {
    episodes: all.length,
    open: running.length,
    medianDurationSec: median(durations),
    longestDurationSec: durations.length ? Math.max(...durations) : null,
    totalValueCents: round2(all.reduce((a, e) => a + e.valueCents, 0)),
    recent: all.slice(-recent).reverse(),
  };
}

export function lockEpisodesReport(book: EpisodeBook, nowMs: number): LockEpisodesReport {
  return {
    label: EPISODE_LABEL,
    day: utcDay(nowMs),
    minCycles: EPISODE_MIN_CYCLES,
    fifteen: episodeSummary(book, "fifteen", nowMs),
    hourly: episodeSummary(book, "hourly", nowMs),
    daily: episodeSummary(book, "daily", nowMs),
  };
}
