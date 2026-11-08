/**
 * Read-side arithmetic for the report: venue-vs-venue and venue-vs-model gaps, executable
 * crosses net of each venue's fee, and the cost-of-latency table from the settlement index.
 * Pure functions over snapshots and history; no I/O.
 */

import { digitalDelta, nearestSmile, type Smile } from "./model";
import type { HistoryPoint } from "./store";
import type { IndexCandle, Ladder, VenueQuote } from "./types";

/** Taker fee in cents for one $1 contract at price p cents: Θ · p · (1 − p), rounded up to the cent. */
export function takerFeeCents(theta: number, priceCents: number): number {
  if (!(theta > 0) || priceCents <= 0 || priceCents >= 100) return 0;
  const p = priceCents / 100;
  return Math.ceil(theta * p * (1 - p) * 100 * 1000) / 1000;
}

export interface BucketRow {
  key: string;
  label: string;
  kalshi: VenueQuote | null;
  poly: VenueQuote | null;
  /** model probability in cents of $1 */
  modelCents: number | null;
  /** Kalshi mid − Polymarket US mid, cents; null unless both quote two-sided */
  venueGapCents: number | null;
  /** venue mid − model, cents */
  kalshiVsModelCents: number | null;
  polyVsModelCents: number | null;
  cross: Cross | null;
}

export interface Cross {
  /** buy YES here … */
  buyOn: "kalshi" | "polymarket_us";
  buyAtCents: number;
  /** … sell YES here (equivalently buy NO) */
  sellOn: "kalshi" | "polymarket_us";
  sellAtCents: number;
  feesCents: number;
  /** net edge per $1 contract after both venues' taker fees, cents */
  edgeCents: number;
  /** contracts available at the two best levels, 0 when a venue did not publish depth */
  qty: number;
}

/** (bid + ask)/2 when the venue shows an offer below 100¢; a missing bid counts as zero (the tails). */
export function midCents(q: VenueQuote | null): number | null {
  if (!q || q.bidCents < 0 || q.askCents <= 0 || q.askCents > 99) return null;
  return (q.bidCents + q.askCents) / 2;
}

export function bucketLabel(key: string): string {
  const [kind, rest] = key.split(":");
  const fmt = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  if (kind === "range") {
    const [lo, hi] = rest.split("-").map(Number);
    return `${fmt(lo)} – ${fmt(hi)}`;
  }
  const n = Number(rest);
  if (kind === "above") return `${fmt(n)} or above`;
  if (kind === "below") return `${fmt(Math.round(n))} or below`;
  if (kind === "touch_up") return `touches ${fmt(n)}`;
  if (kind === "touch_down") return `dips to ${fmt(n)}`;
  return key;
}

/** The executable cross between two venues' YES books, if any, net of taker fees on both legs. */
export function findCross(k: VenueQuote | null, p: VenueQuote | null): Cross | null {
  if (!k || !p) return null;
  const tryDir = (buy: VenueQuote, sell: VenueQuote): Cross | null => {
    if (buy.askCents <= 0 || sell.bidCents <= 0) return null;
    const fees = takerFeeCents(buy.feeTheta, buy.askCents) + takerFeeCents(sell.feeTheta, sell.bidCents);
    const edge = sell.bidCents - buy.askCents - fees;
    if (edge <= 0) return null;
    const qty = buy.askQty > 0 && sell.bidQty > 0 ? Math.min(buy.askQty, sell.bidQty) : 0;
    return {
      buyOn: buy.venue,
      buyAtCents: buy.askCents,
      sellOn: sell.venue,
      sellAtCents: sell.bidCents,
      feesCents: Math.round(fees * 100) / 100,
      edgeCents: Math.round(edge * 100) / 100,
      qty,
    };
  };
  return tryDir(k, p) ?? tryDir(p, k);
}

/** Merge a venue-neutral ladder (the Kalshi one as the spine) with the Polymarket US ladder sharing its settlement. */
export function mergeLadders(spine: Ladder, others: Ladder[]): Ladder {
  const sameSettle = others.filter((o) => Math.abs(Date.parse(o.settlesAt) - Date.parse(spine.settlesAt)) <= 60 * 60_000);
  const buckets = [...spine.buckets];
  const seen = new Set(buckets.map((b) => b.key));
  const quotes = [...spine.quotes];
  for (const o of sameSettle) {
    for (const b of o.buckets) {
      if (!seen.has(b.key)) {
        buckets.push(b);
        seen.add(b.key);
      }
    }
    for (const q of o.quotes) {
      if (!seen.has(q.bucketKey)) continue;
      // two listings of the same contract on one venue: keep the deeper book
      const i = quotes.findIndex((x) => x.venue === q.venue && x.bucketKey === q.bucketKey);
      if (i < 0) quotes.push(q);
      else if (q.bidQty + q.askQty > quotes[i].bidQty + quotes[i].askQty) quotes[i] = q;
    }
  }
  buckets.sort((a, b) => (a.level ?? a.lower ?? 0) - (b.level ?? b.lower ?? 0));
  return { ...spine, buckets, quotes, model: { ...spine.model } };
}

export function bucketRows(l: Ladder): BucketRow[] {
  return l.buckets.map((b) => {
    const kalshi = l.quotes.find((q) => q.venue === "kalshi" && q.bucketKey === b.key) ?? null;
    const poly = l.quotes.find((q) => q.venue === "polymarket_us" && q.bucketKey === b.key) ?? null;
    const m = l.model[b.key];
    const modelCents = m ? Math.round(m.p * 10000) / 100 : null;
    const km = midCents(kalshi);
    const pm = midCents(poly);
    const r1 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
    return {
      key: b.key,
      label: bucketLabel(b.key),
      kalshi,
      poly,
      modelCents,
      venueGapCents: km !== null && pm !== null ? r1(km - pm) : null,
      kalshiVsModelCents: km !== null && modelCents !== null ? r1(km - modelCents) : null,
      polyVsModelCents: pm !== null && modelCents !== null ? r1(pm - modelCents) : null,
      cross: findCross(kalshi, poly),
    };
  });
}

export interface GapSeries {
  key: string;
  label: string;
  /** [atMs, kalshiMid − polyMid] over the history window, cents */
  venue: Array<[number, number]>;
  /** [atMs, kalshiMid − model] */
  kalshiModel: Array<[number, number]>;
  /** [atMs, polyMid − model] */
  polyModel: Array<[number, number]>;
  stats: { venueMeanAbs: number | null; venueMax: number | null; venueLast: number | null; n: number };
}

/** Per-bucket gap time series for one ladder id across the history window. */
export function gapSeries(history: HistoryPoint[], ladderId: string): GapSeries[] {
  const keys = new Set<string>();
  for (const h of history) for (const k of Object.keys(h.ladders[ladderId] ?? {})) keys.add(k);
  const out: GapSeries[] = [];
  for (const key of keys) {
    const venue: Array<[number, number]> = [];
    const kalshiModel: Array<[number, number]> = [];
    const polyModel: Array<[number, number]> = [];
    for (const h of history) {
      const row = h.ladders[ladderId]?.[key];
      if (!row) continue;
      const [kb, ka, pb, pa, m] = row;
      const km = kb >= 0 && ka > 0 && ka <= 99 ? (kb + ka) / 2 : null;
      const pm = pb >= 0 && pa > 0 && pa <= 99 ? (pb + pa) / 2 : null;
      if (km !== null && pm !== null) venue.push([h.atMs, km - pm]);
      if (km !== null && m >= 0) kalshiModel.push([h.atMs, km - m]);
      if (pm !== null && m >= 0) polyModel.push([h.atMs, pm - m]);
    }
    const abs = venue.map(([, g]) => Math.abs(g));
    out.push({
      key,
      label: bucketLabel(key),
      venue,
      kalshiModel,
      polyModel,
      stats: {
        venueMeanAbs: abs.length ? Math.round((abs.reduce((a, b) => a + b, 0) / abs.length) * 100) / 100 : null,
        venueMax: abs.length ? Math.round(Math.max(...abs) * 100) / 100 : null,
        venueLast: venue.length ? Math.round(venue[venue.length - 1][1] * 100) / 100 : null,
        n: venue.length,
      },
    });
  }
  const level = (k: string) => Number(k.split(":")[1]?.split("-")[0]) || 0;
  return out.sort((a, b) => level(a.key) - level(b.key));
}

export interface LatencyRow {
  horizonSec: number;
  /** |Δ index| over the horizon, bps of spot */
  p50Bps: number;
  p90Bps: number;
  maxBps: number;
  /** what that move is worth on a $1 at-the-money digital of the given tenor, cents, at p50 / p90 */
  atmCentsP50: number | null;
  atmCentsP90: number | null;
  n: number;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[i];
}

/**
 * Cost of being late: how far the settlement index moves over 1 / 5 / 15 / 60 seconds, and
 * what that move is worth on a $1 at-the-money digital settling at `settlesAtMs` under the
 * option smile. Digital sensitivity is per $1 of spot; cents = delta · spot · move · 100.
 */
export function latencyTable(
  candles: IndexCandle[],
  smiles: Smile[],
  settlesAtMs: number | null,
  nowMs: number,
  horizons = [1, 5, 15, 60],
): LatencyRow[] {
  const byTs = new Map<number, number>();
  for (const c of candles) byTs.set(c.ts, c.close);
  const ts = [...byTs.keys()].sort((a, b) => a - b);
  let delta: number | null = null;
  let spot = 0;
  if (settlesAtMs && ts.length) {
    spot = byTs.get(ts[ts.length - 1]) ?? 0;
    const smile = nearestSmile(smiles, settlesAtMs);
    const T = Math.max(1 / (365.25 * 24 * 60), (settlesAtMs - nowMs) / (365.25 * 86_400_000));
    if (smile && spot > 0) delta = digitalDelta({ ...smile, forward: spot }, spot, T);
  }
  return horizons.map((h) => {
    const moves: number[] = [];
    for (const t of ts) {
      const a = byTs.get(t);
      const b = byTs.get(t + h);
      if (a && b) moves.push((Math.abs(b - a) / a) * 10_000);
    }
    moves.sort((x, y) => x - y);
    const p50 = quantile(moves, 0.5);
    const p90 = quantile(moves, 0.9);
    const cents = (bps: number) => (delta === null || !spot ? null : Math.round(delta * spot * (bps / 10_000) * 100 * 100) / 100);
    return {
      horizonSec: h,
      p50Bps: Math.round(p50 * 100) / 100,
      p90Bps: Math.round(p90 * 100) / 100,
      maxBps: Math.round((moves[moves.length - 1] ?? 0) * 100) / 100,
      atmCentsP50: cents(p50),
      atmCentsP90: cents(p90),
      n: moves.length,
    };
  });
}

/** Implied distribution across a range ladder: per bucket, each source's probability mass in cents. */
export function distributionRows(l: Ladder): Array<{ label: string; kalshi: number | null; poly: number | null; model: number | null }> {
  return bucketRows(l)
    .filter((r) => r.key.startsWith("range:") || r.key.startsWith("above:") || r.key.startsWith("below:"))
    .map((r) => ({ label: r.label, kalshi: midCents(r.kalshi), poly: midCents(r.poly), model: r.modelCents }));
}
