/**
 * Polymarket US BTC ladders — public Retail API (gateway.polymarket.us), no key.
 *
 * Discovery: every series whose slug mentions btc → its active events → markets with
 * typed `assetPriceTerms` (range / above-below / one-touch on the BRTI index). Production
 * lists the hand-made year-end 2026 ladders (series `btc`) and the automated families:
 * `btc-strike-hourly` (4 PM ET style hourly, strikes $100 apart, the 5 PM hour skipped),
 * `btc-strike-daily` (5 PM ET, $250 apart, none on Fridays), `btc-strike-weekly` (Fri 5 PM ET)
 * and their `btc-range-*` twins. The series list runs past 200 entries and the automated
 * families sit on its second page, so discovery pages through it.
 *
 * Bucket keys follow the same convention as the Kalshi reader so same-bounds buckets
 * line up. Thresholds normalise to the inclusive side: "strictly above 149,999.99" and
 * "at or above 150,000" are the same contract and get the key `above:150000`.
 */

import { fetchJsonWithRetry } from "../eventCollar/kalshiPublic";
import { fetchJsonOnce, type BookStamp, type ReadOnceOptions } from "./bookRead";
import { aboveKey, belowKey } from "./keys";
import type { Bucket, IndexCandle, Ladder, VenueQuote } from "./types";

const DEFAULT_BASE = "https://gateway.polymarket.us";

export function polyUsBase(): string {
  return process.env.POLY_US_REST_BASE?.replace(/\/$/, "") || DEFAULT_BASE;
}

interface Money {
  value: string;
  currency?: string;
}

interface RawTerms {
  marketType?: string; // ASSET_PRICE_MARKET_TYPE_RANGE | _ONE_TOUCH | _STRIKE | _ABOVE_BELOW | _UP_DOWN
  asset?: { assetClass?: string; symbol?: string };
  indexSymbol?: string;
  horizon?: string; // "15m", "1h", "1d" on the up/down families
  windowStart?: string | null;
  windowEnd?: string | null;
  /** up/down: the BRTI average before the window opened; "Up" settles Yes at or above it */
  priceToBeat?: Money | null;
  strike?: Money | null;
  rangeLower?: Money | null;
  rangeUpper?: Money | null;
  rangeKind?: string; // ASSET_PRICE_RANGE_KIND_INTERIOR | _ABOVE | _BELOW
  direction?: string; // ASSET_PRICE_DIRECTION_UP | _DOWN
}

interface RawMarket {
  slug: string;
  question?: string;
  active?: boolean;
  closed?: boolean;
  endDate?: string;
  /** when the listing was created; on the 15-minute family that is hours before the window */
  startDate?: string;
  /** when trading opens: the window start on the up/down families */
  gameStartTime?: string;
  feeCoefficient?: number;
  bestBidQuote?: Money | null;
  bestAskQuote?: Money | null;
  assetPriceTerms?: RawTerms | null;
}

interface RawEvent {
  slug: string;
  title?: string;
  endDate?: string;
  markets?: RawMarket[];
}

/** Dollars string to cents with two decimals kept (the venue quotes whole cents; mids can be halves). */
export function moneyCents(m: Money | null | undefined): number {
  if (!m?.value) return 0;
  const n = Number(m.value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10_000) / 100;
}

function moneyNum(m: Money | null | undefined): number | undefined {
  if (!m?.value) return undefined;
  const n = Number(m.value);
  return Number.isFinite(n) ? n : undefined;
}

/** Bucket for one Polymarket US market, or null when it is not a BTC price contract. Exported for tests. */
export function bucketFromPolyUs(m: RawMarket, opts: PolyReadOptions = {}): Bucket | null {
  const t = m.assetPriceTerms;
  if (!t || t.asset?.symbol?.toLowerCase() !== "btc") return null;
  const settlesAt = t.windowEnd || m.endDate || "";
  if (!settlesAt) return null;
  const type = t.marketType ?? "";
  if (type.endsWith("_RANGE")) {
    const lo = moneyNum(t.rangeLower);
    const hi = moneyNum(t.rangeUpper);
    if (t.rangeKind?.endsWith("_ABOVE") && lo !== undefined) {
      return { key: aboveKey(lo, true), kind: "above", level: lo, settlesAt };
    }
    if (t.rangeKind?.endsWith("_BELOW") && hi !== undefined) {
      return { key: belowKey(hi, true), kind: "below", level: hi, settlesAt };
    }
    if (lo !== undefined && hi !== undefined) {
      return { key: `range:${lo}-${hi}`, kind: "range", lower: lo, upper: hi, settlesAt };
    }
    return null;
  }
  if (type.endsWith("_ONE_TOUCH")) {
    const level = moneyNum(t.strike);
    if (level === undefined) return null;
    const up = (t.direction ?? "").endsWith("_UP");
    return { key: `${up ? "touch_up" : "touch_down"}:${level}`, kind: up ? "touch_up" : "touch_down", level, settlesAt };
  }
  // "_STRIKE" in the documented schema; production labels the hourly/daily/weekly strike
  // ladders "_ABOVE_BELOW" ("settles Yes if ... at or above $74,500"). Same contract shape.
  if (type.endsWith("_STRIKE") || type.endsWith("_ABOVE_BELOW")) {
    const level = moneyNum(t.strike);
    if (level === undefined) return null;
    return { key: aboveKey(level, true), kind: "above", level, settlesAt };
  }
  // up/down (5m, 15m, 1h, 1d): "Up" is Yes when the index closes at or above the price to beat,
  // the same shape Kalshi's KXBTC15M quotes with floor_strike greater_or_equal, so the keys meet.
  // Opt-in: the curve report keeps these off its strike ladders (an hourly up/down would land
  // an off-grid strike on the hourly ladder); the pairs collector asks for them.
  if (type.endsWith("_UP_DOWN") && opts.upDown) {
    const level = moneyNum(t.priceToBeat) ?? moneyNum(t.strike);
    if (level === undefined) return null;
    return { key: aboveKey(level, true), kind: "above", level, settlesAt };
  }
  return null;
}

export interface PolyReadOptions {
  /** read the up/down families (price to beat as the strike) as one-strike above ladders */
  upDown?: boolean;
}

/**
 * When the contract opened: the latest of the window start, the trading start and the listing's
 * creation. The 15-minute markets are created hours ahead and open with their window; the
 * strike ladders have no window start and open when they are listed. Exported for tests.
 */
export function polyOpenedAt(m: RawMarket): string | undefined {
  const ms = [m.assetPriceTerms?.windowStart, m.gameStartTime, m.startDate].map((v) => (v ? Date.parse(v) : NaN)).filter((v) => Number.isFinite(v));
  return ms.length ? new Date(Math.max(...ms)).toISOString() : undefined;
}

function quoteFromPolyUs(m: RawMarket, bucketKey: string): VenueQuote {
  const openedAt = polyOpenedAt(m);
  return {
    venue: "polymarket_us",
    bucketKey,
    id: m.slug,
    bidCents: moneyCents(m.bestBidQuote),
    askCents: moneyCents(m.bestAskQuote),
    bidQty: 0,
    askQty: 0,
    volume: 0,
    openInterest: 0,
    feeTheta: typeof m.feeCoefficient === "number" ? m.feeCoefficient : 0,
    ...(openedAt ? { openedAt } : {}),
  };
}

const SERIES_PAGE = 200;

/** Every series the venue lists (several hundred; the BTC families are past the first page). Exported for tests. */
export async function fetchAllSeries(fetchImpl: typeof fetch = fetch, maxPages = 10): Promise<Array<{ id: string; slug: string }>> {
  const out: Array<{ id: string; slug: string }> = [];
  for (let page = 0; page < maxPages; page += 1) {
    const data = (await fetchJsonWithRetry(`${polyUsBase()}/v1/series?limit=${SERIES_PAGE}&offset=${page * SERIES_PAGE}`, fetchImpl)) as {
      series?: Array<{ id: string; slug: string }>;
    };
    const rows = data.series ?? [];
    out.push(...rows);
    if (rows.length < SERIES_PAGE) break;
  }
  return out;
}

async function fetchBtcSeriesIds(fetchImpl: typeof fetch): Promise<string[]> {
  return (await fetchAllSeries(fetchImpl)).filter((s) => /btc|bitcoin/i.test(s.slug)).map((s) => s.id);
}

/** Series ids for the given slugs (e.g. `btc-strike-hourly`), in the order asked; missing slugs are dropped. */
export async function fetchSeriesIdsBySlug(slugs: string[], fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const all = await fetchAllSeries(fetchImpl);
  return slugs.map((slug) => all.find((s) => s.slug === slug)?.id).filter((id): id is string => Boolean(id));
}

/** Active events of the given series, as `readPolyUsLadders` would see them. */
export async function readPolyUsLaddersForSeries(seriesIds: string[], fetchImpl: typeof fetch = fetch, opts: PolyReadOptions = {}): Promise<Ladder[]> {
  const lists = await Promise.all(seriesIds.map((id) => fetchEventsForSeries(id, fetchImpl).catch(() => [] as RawEvent[])));
  return laddersFromEvents(lists.flat(), opts);
}

async function fetchEventsForSeries(seriesId: string, fetchImpl: typeof fetch): Promise<RawEvent[]> {
  const data = (await fetchJsonWithRetry(
    `${polyUsBase()}/v1/events?seriesId=${encodeURIComponent(seriesId)}&active=true&closed=false&limit=100`,
    fetchImpl,
  )) as { events?: RawEvent[] };
  return data.events ?? [];
}

async function fetchEventsBySlug(slugs: string[], fetchImpl: typeof fetch): Promise<RawEvent[]> {
  if (!slugs.length) return [];
  const qs = slugs.map((s) => `slug=${encodeURIComponent(s)}`).join("&");
  const data = (await fetchJsonWithRetry(`${polyUsBase()}/v1/events?${qs}`, fetchImpl)) as { events?: RawEvent[] };
  return data.events ?? [];
}

interface RawBook {
  marketData?: {
    bids?: Array<{ px: Money; qty: string }>;
    offers?: Array<{ px: Money; qty: string }>;
    stats?: { sharesTraded?: string; openInterest?: string };
    /** MARKET_STATE_OPEN while the market trades */
    state?: string;
    /** the venue's stamp on the book, nanosecond ISO; it marks the last change, so a quiet book carries an old one */
    transactTime?: string;
  };
}

export interface PolyBook {
  bidCents: number;
  askCents: number;
  bidQty: number;
  askQty: number;
  volume: number;
  openInterest: number;
  /** `marketData.transactTime`, ms; null when absent or unreadable */
  venueAtMs: number | null;
  state: string | null;
}

/** The best level each side, the venue's stamp and the market state out of one book answer. Exported for tests. */
export function bookFromPolyUs(data: unknown): PolyBook {
  const md = (data as RawBook | null | undefined)?.marketData;
  const bids = (md?.bids ?? []).map((l) => ({ px: moneyCents(l.px), qty: Number(l.qty) })).sort((a, b) => b.px - a.px);
  const offers = (md?.offers ?? []).map((l) => ({ px: moneyCents(l.px), qty: Number(l.qty) })).sort((a, b) => a.px - b.px);
  const venueAtMs = md?.transactTime ? Date.parse(md.transactTime) : NaN;
  return {
    bidCents: bids[0]?.px ?? 0,
    askCents: offers[0]?.px ?? 0,
    bidQty: bids[0]?.qty ?? 0,
    askQty: offers[0]?.qty ?? 0,
    volume: Number(md?.stats?.sharesTraded ?? 0),
    openInterest: Number(md?.stats?.openInterest ?? 0),
    venueAtMs: Number.isFinite(venueAtMs) ? venueAtMs : null,
    state: typeof md?.state === "string" ? md.state : null,
  };
}

export function polyBookUrl(slug: string): string {
  return `${polyUsBase()}/v1/markets/${encodeURIComponent(slug)}/book`;
}

/** Best-level depth and the full book for one market. */
export async function fetchBook(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bidCents: number; askCents: number; bidQty: number; askQty: number; volume: number; openInterest: number }> {
  const { bidCents, askCents, bidQty, askQty, volume, openInterest } = bookFromPolyUs(await fetchJsonWithRetry(polyBookUrl(slug), fetchImpl));
  return { bidCents, askCents, bidQty, askQty, volume, openInterest };
}

/**
 * One market's book, read once, with its times: when we got it, how long the venue's cache had
 * held it, and the venue's own stamp. Throws `BookReadError` (a 404 for minutes after a contract
 * opens is the usual case) so the caller can say so on that row alone.
 */
export async function readBookOnce(slug: string, fetchImpl: typeof fetch = fetch, opts: ReadOnceOptions = {}): Promise<PolyBook & BookStamp> {
  const { data, fetchedAtMs, cacheAgeSec } = await fetchJsonOnce(polyBookUrl(slug), fetchImpl, opts);
  return { ...bookFromPolyUs(data), fetchedAtMs, cacheAgeSec };
}

/** Group markets into ladders by (event, kind family, settlement instant). Exported for tests. */
export function laddersFromEvents(events: RawEvent[], opts: PolyReadOptions = {}): Ladder[] {
  const out = new Map<string, Ladder>();
  for (const e of events) {
    for (const m of e.markets ?? []) {
      if (m.active === false || m.closed === true) continue;
      const b = bucketFromPolyUs(m, opts);
      if (!b) continue;
      const family = b.kind === "range" || b.kind === "above" || b.kind === "below" ? "range" : b.kind;
      const id = `poly:${e.slug}:${family}:${b.settlesAt.slice(0, 10)}`;
      let ladder = out.get(id);
      if (!ladder) {
        ladder = { id, title: e.title || m.question || e.slug, settlesAt: b.settlesAt, buckets: [], quotes: [], model: {} };
        out.set(id, ladder);
      }
      ladder.buckets.push(b);
      ladder.quotes.push(quoteFromPolyUs(m, b.key));
    }
  }
  for (const l of out.values()) l.buckets.sort((a, b) => (a.level ?? a.lower ?? 0) - (b.level ?? b.lower ?? 0));
  return [...out.values()];
}

/**
 * Every BTC price ladder Polymarket US lists right now. `withDepth` adds best-level sizes
 * and the venue's volume / open interest (one book call per market).
 */
export async function readPolyUsLadders(
  opts: { withDepth?: boolean; extraEventSlugs?: string[]; fetchImpl?: typeof fetch } = {},
): Promise<Ladder[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ids = await fetchBtcSeriesIds(fetchImpl);
  const lists = await Promise.all(ids.map((id) => fetchEventsForSeries(id, fetchImpl).catch(() => [] as RawEvent[])));
  const seen = new Set<string>();
  const events: RawEvent[] = [];
  for (const e of [...lists.flat(), ...(await fetchEventsBySlug(opts.extraEventSlugs ?? [], fetchImpl))]) {
    if (seen.has(e.slug)) continue;
    seen.add(e.slug);
    events.push(e);
  }
  const ladders = laddersFromEvents(events);
  if (opts.withDepth) await withPolyUsDepth(ladders.flatMap((l) => l.quotes), fetchImpl);
  return ladders;
}

/**
 * Book onto each quote: best-level sizes, volume, open interest, and the top of book itself
 * (the event payload omits bestBid/bestAsk on some intraday markets). A few books at a time:
 * the automated families are ~500 markets and an unbounded fan-out trips the gateway.
 */
export async function withPolyUsDepth(quotes: VenueQuote[], fetchImpl: typeof fetch = fetch, concurrency = 12): Promise<void> {
  const queue = [...quotes];
  const worker = async () => {
    for (let q = queue.shift(); q; q = queue.shift()) {
      try {
        const b = await fetchBook(q.id, fetchImpl);
        q.bidQty = b.bidQty;
        q.askQty = b.askQty;
        q.volume = b.volume;
        q.openInterest = b.openInterest;
        if (b.bidCents) q.bidCents = b.bidCents;
        if (b.askCents) q.askCents = b.askCents;
      } catch {
        // the event payload's top of book stands without depth
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

/** BRTI candles — the settlement index of both venues, published 1/s. `bucket` is one of 1S 5S 15S 1M 5M 15M 1H 1D. */
export async function fetchBrtiCandles(
  fromSec: number,
  toSec: number,
  bucket: "1S" | "5S" | "15S" | "1M" | "5M" | "15M" | "1H" | "1D" = "1S",
  fetchImpl: typeof fetch = fetch,
): Promise<IndexCandle[]> {
  const url =
    `${polyUsBase()}/v1/asset-prices/history?assets=crypto:btc&from=${Math.floor(fromSec)}&to=${Math.floor(toSec)}` +
    `&bucket=ASSET_PRICE_BUCKET_${bucket}`;
  const data = (await fetchJsonWithRetry(url, fetchImpl)) as {
    series?: Array<{ candles?: Array<{ timestamp: number; open: string; high: string; low: string; close: string }> }>;
  };
  const candles = data.series?.[0]?.candles ?? [];
  return candles
    .map((c) => ({ ts: Number(c.timestamp), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }))
    .filter((c) => Number.isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.ts - b.ts);
}
