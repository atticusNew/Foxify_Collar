/**
 * Read-side arithmetic for the report: venue-vs-venue and venue-vs-model gaps, executable
 * crosses net of each venue's fee, and the cost-of-latency table from the settlement index.
 * Pure functions over snapshots and history; no I/O.
 */

import { digitalDelta, ivAt, nearestSmile, normCdf, type Smile } from "./model";
import type { HistoryPoint } from "./store";
import type { HourlyVolPoint, IndexCandle, Ladder, VenueQuote } from "./types";

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

export interface LadderVol {
  /** lognormal vol (annualised, %) that best fits the venue's two-sided mids as N(d2) digitals */
  ladderPct: number;
  /** the forward the same fit puts the ladder's centre at, USD */
  forwardUsd: number;
  /** strikes used in the fit */
  n: number;
  /** root-mean-square miss of that fit, cents */
  rmsCents: number;
}

/**
 * The single vol a venue's "above X" ladder is priced at: fit a forward and a σ so that N(d2)
 * digitals with `T` years to run match the two-sided mids between 5¢ and 95¢. Fitting the
 * forward as well keeps a few seconds' index lag out of the vol; it also says where the
 * venue's makers think spot is. One number a reader can hold against the listed option vol
 * and the index's realised vol.
 */
export function ladderImpliedVol(rows: BucketRow[], venue: "kalshi" | "polymarket_us", spot: number, T: number): LadderVol | null {
  if (!(spot > 0) || !(T > 0)) return null;
  const pts: Array<{ K: number; p: number }> = [];
  for (const r of rows) {
    if (!r.key.startsWith("above:")) continue;
    const K = Number(r.key.slice("above:".length));
    const m = midCents(venue === "kalshi" ? r.kalshi : r.poly);
    if (!(K > 0) || m === null || m < 5 || m > 95) continue;
    pts.push({ K, p: m / 100 });
  }
  if (pts.length < 3) return null;
  const sqT = Math.sqrt(T);
  const sse = (F: number, iv: number) => {
    const s = iv * sqT;
    let e = 0;
    for (const { K, p } of pts) {
      const q = normCdf((Math.log(F / K) - 0.5 * s * s) / s);
      e += (q - p) * (q - p);
    }
    return e;
  };
  let bestF = spot;
  let bestIv = 0.5;
  let bestE = Number.POSITIVE_INFINITY;
  // coarse grid in both, then a fine pass around the winner
  for (const [fStep, ivStep, fSpan, ivLo, ivHi, f0, iv0] of [
    [0.001, 1.05, 0.02, 0.05, 4, spot, 0.5],
    [0.0001, 1.005, 0.0025, 0, 0, 0, 0],
  ] as Array<[number, number, number, number, number, number, number]>) {
    const centerF = f0 || bestF;
    const lo = ivLo || bestIv / 1.1;
    const hi = ivHi || bestIv * 1.1;
    for (let F = centerF * (1 - fSpan); F <= centerF * (1 + fSpan); F += centerF * fStep) {
      for (let iv = lo; iv <= hi; iv *= ivStep) {
        const e = sse(F, iv);
        if (e < bestE) {
          bestE = e;
          bestF = F;
          bestIv = iv;
        }
      }
    }
  }
  return {
    ladderPct: Math.round(bestIv * 1000) / 10,
    forwardUsd: Math.round(bestF),
    n: pts.length,
    rmsCents: Math.round(Math.sqrt(bestE / pts.length) * 10000) / 100,
  };
}

export interface StrikeVolRow {
  strikeUsd: number;
  label: string;
  bidCents: number;
  askCents: number;
  bidQty: number;
  askQty: number;
  /**
   * The vol band the venue's two sides imply for an "above K" digital on the fitted centre, % annualised,
   * low to high (bid and ask swap sides across the centre). Null within a quarter of a standard deviation of the
   * centre, where a digital carries almost no vol, or when no vol in 2–500% reproduces the price.
   */
  volLoPct: number | null;
  volHiPct: number | null;
  volMidPct: number | null;
  /** Deribit mark IV at the strike, % */
  smilePct: number | null;
  /** where the listed vol sits against the venue's band */
  listedVs: "inside" | "venue_over" | "venue_under" | null;
  /** venue mid minus the one-vol fit at this strike, cents */
  fitResidualCents: number | null;
}

export interface LadderVolTable {
  ladderId: string;
  settlesAt: string;
  minutesToClose: number;
  /** the one-vol fit the residual column is read against */
  fitPct: number;
  /** the strike where the venue's mids cross 50¢; the centre the bands are inverted on */
  centreUsd: number;
  rmsCents: number;
  /** one standard deviation of the fit over the time left, USD */
  stdevUsd: number;
  rows: StrikeVolRow[];
  /** strikes with a vol band, and how many of them hold the listed vol inside it */
  withBand: number;
  inside: number;
  /** mean mid vol below the centre minus above it, vol points, for the venue and for the smile at the same strikes */
  skew: { venuePts: number; smilePts: number; n: number } | null;
}

/** The strike at which a venue's "above K" mids cross 50¢, interpolated between neighbours; null without a crossing. */
export function ladderCentre(rows: BucketRow[]): number | null {
  const pts = rows
    .filter((r) => r.key.startsWith("above:"))
    .map((r) => ({ K: Number(r.key.slice("above:".length)), m: midCents(r.kalshi) }))
    .filter((x): x is { K: number; m: number } => x.K > 0 && x.m !== null)
    .sort((a, b) => a.K - b.K);
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a.m >= 50 && b.m < 50 && a.m !== b.m) return a.K + ((a.m - 50) / (a.m - b.m)) * (b.K - a.K);
  }
  return null;
}

/** σ such that an "above K" digital with T years left prices at p on forward F; null when none in [2%, 500%]. */
export function digitalImpliedVol(p: number, F: number, K: number, T: number): number | null {
  if (!(p > 0 && p < 1) || !(F > 0) || !(K > 0) || !(T > 0)) return null;
  const price = (iv: number) => {
    const s = iv * Math.sqrt(T);
    return normCdf((Math.log(F / K) - 0.5 * s * s) / s);
  };
  let lo = 0.02;
  let hi = 5;
  const fLo = price(lo) - p;
  const fHi = price(hi) - p;
  if (fLo === 0) return lo;
  if (fHi === 0) return hi;
  if (Math.sign(fLo) === Math.sign(fHi)) return null;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    const f = price(mid) - p;
    if (Math.sign(f) === Math.sign(fLo)) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The market maker's read of a venue's "above X" ladder: each strike's bid and ask turned into the vol
 * that reproduces it on the ladder's own fitted centre, set beside the listed vol at that strike. A band
 * that holds the listed vol is a strike quoted off the smile; a band above it is a strike the venue
 * charges a premium on; the residual against the one-vol fit says how consistent the strikes are with
 * each other.
 */
export function ladderStrikeVols(ladder: Ladder, smiles: Smile[], spot: number, nowMs: number): LadderVolTable | null {
  const settleMs = Date.parse(ladder.settlesAt);
  const T = Math.max(0, (settleMs - nowMs) / (365.25 * 86_400_000));
  const rows = bucketRows(ladder);
  const fit = ladderImpliedVol(rows, "kalshi", spot, T);
  if (!fit || !(T > 0)) return null;
  const smile = nearestSmile(smiles, settleMs);
  // Centre for the inversion: where the venue's mids cross 50¢, read off the ladder itself. The one-vol
  // fit's centre would absorb any skew between the two sides; the 50¢ point does not.
  const F = ladderCentre(rows) ?? fit.forwardUsd;
  const sigma = fit.ladderPct / 100;
  const s = sigma * Math.sqrt(T);
  const out: StrikeVolRow[] = [];
  const below: Array<{ venue: number; smile: number }> = [];
  const above: Array<{ venue: number; smile: number }> = [];
  const pct = (iv: number | null) => (iv === null ? null : Math.round(iv * 1000) / 10);
  for (const r of rows) {
    if (!r.key.startsWith("above:") || !r.kalshi) continue;
    const K = Number(r.key.slice("above:".length));
    const mid = midCents(r.kalshi);
    if (!(K > 0) || mid === null || mid < 5 || mid > 95) continue;
    const fitted = normCdf((Math.log(fit.forwardUsd / K) - 0.5 * s * s) / s) * 100;
    const nearCentre = Math.abs(Math.log(F / K)) < 0.25 * s;
    const vb = nearCentre ? null : digitalImpliedVol(r.kalshi.bidCents / 100, F, K, T);
    const va = nearCentre ? null : digitalImpliedVol(r.kalshi.askCents / 100, F, K, T);
    const vm = nearCentre ? null : digitalImpliedVol(mid / 100, F, K, T);
    const lo = vb !== null && va !== null ? Math.min(vb, va) : null;
    const hi = vb !== null && va !== null ? Math.max(vb, va) : null;
    const smileIv = smile ? ivAt(smile, K) : null;
    let listedVs: StrikeVolRow["listedVs"] = null;
    if (lo !== null && hi !== null && smileIv !== null) {
      listedVs = smileIv < lo ? "venue_over" : smileIv > hi ? "venue_under" : "inside";
    }
    if (vm !== null && smileIv !== null) (K < F ? below : above).push({ venue: vm, smile: smileIv });
    out.push({
      strikeUsd: K,
      label: r.label,
      bidCents: r.kalshi.bidCents,
      askCents: r.kalshi.askCents,
      bidQty: r.kalshi.bidQty,
      askQty: r.kalshi.askQty,
      volLoPct: pct(lo),
      volHiPct: pct(hi),
      volMidPct: pct(vm),
      smilePct: pct(smileIv),
      listedVs,
      fitResidualCents: Math.round((mid - fitted) * 100) / 100,
    });
  }
  if (!out.length) return null;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const skew =
    below.length && above.length
      ? {
          venuePts: Math.round((mean(below.map((x) => x.venue)) - mean(above.map((x) => x.venue))) * 1000) / 10,
          smilePts: Math.round((mean(below.map((x) => x.smile)) - mean(above.map((x) => x.smile))) * 1000) / 10,
          n: below.length + above.length,
        }
      : null;
  const withBand = out.filter((r) => r.listedVs !== null);
  return {
    ladderId: ladder.id,
    settlesAt: ladder.settlesAt,
    minutesToClose: Math.round((settleMs - nowMs) / 60_000),
    fitPct: fit.ladderPct,
    centreUsd: Math.round(F),
    rmsCents: fit.rmsCents,
    stdevUsd: Math.round(F * s),
    rows: out,
    withBand: withBand.length,
    inside: withBand.filter((r) => r.listedVs === "inside").length,
    skew,
  };
}

/** Annualised realised vol (%) of the index from `stepSec`-spaced closes across the candles. */
export function realizedVolPct(candles: IndexCandle[], stepSec = 60): { pct: number; n: number } | null {
  const byTs = new Map<number, number>();
  for (const c of candles) byTs.set(c.ts, c.close);
  const ts = [...byTs.keys()].sort((a, b) => a - b);
  if (ts.length < 2) return null;
  const rets: number[] = [];
  let last = ts[0];
  for (const t of ts) {
    if (t - last < stepSec) continue;
    const a = byTs.get(last);
    const b = byTs.get(t);
    if (a && b) rets.push(Math.log(b / a));
    last = t;
  }
  if (rets.length < 10) return null;
  const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
  const varr = rets.reduce((x, y) => x + (y - mean) * (y - mean), 0) / rets.length;
  const perYear = (365.25 * 86_400) / stepSec;
  return { pct: Math.round(Math.sqrt(varr * perYear) * 1000) / 10, n: rets.length };
}

/** Implied distribution across a range ladder: per bucket, each source's probability mass in cents. */
export function distributionRows(l: Ladder): Array<{ label: string; kalshi: number | null; poly: number | null; model: number | null }> {
  return bucketRows(l)
    .filter((r) => r.key.startsWith("range:") || r.key.startsWith("above:") || r.key.startsWith("below:"))
    .map((r) => ({ label: r.label, kalshi: midCents(r.kalshi), poly: midCents(r.poly), model: r.modelCents }));
}

/** The hourly vol reading for one cycle: the venue's ladder, the listed smile at spot, the index realised. */
export function hourlyVolPoint(hourly: Ladder, smiles: Smile[], spot: number, candles: IndexCandle[], nowMs: number): HourlyVolPoint {
  const settleMs = Date.parse(hourly.settlesAt);
  const T = Math.max(0, (settleMs - nowMs) / (365.25 * 86_400_000));
  const smile = nearestSmile(smiles, settleMs);
  const fit = ladderImpliedVol(bucketRows(hourly), "kalshi", spot, T);
  const realized = realizedVolPct(candles, 60);
  return {
    ladderId: hourly.id,
    minutesToClose: Math.round((settleMs - nowMs) / 60_000),
    ladderPct: fit ? fit.ladderPct : null,
    ladderCentreUsd: fit ? fit.forwardUsd : null,
    rmsCents: fit ? fit.rmsCents : null,
    smilePct: smile && spot > 0 ? Math.round(ivAt(smile, spot) * 1000) / 10 : null,
    smileExpiry: smile?.expiry ?? null,
    realizedPct: realized ? realized.pct : null,
  };
}

export interface VolPremiumRow {
  /** minutes-to-close band, inclusive lower bound, exclusive upper */
  label: string;
  n: number;
  hours: number;
  meanLadderPct: number;
  meanSmilePct: number;
  /** ladder minus listed, vol points */
  meanPremiumPts: number;
  minPremiumPts: number;
  maxPremiumPts: number;
  meanRealizedPct: number | null;
}

const PREMIUM_BANDS: Array<[number, number, string]> = [
  [45, 91, "45–90 min"],
  [30, 45, "30–45 min"],
  [15, 30, "15–30 min"],
  [5, 15, "5–15 min"],
  [2, 5, "2–5 min"],
];

/**
 * How far over (or under) the listed vol the venue prices the hour, by time to close, over
 * the history window. Readings need both a ladder fit and a listed vol; a band with no
 * readings is omitted.
 */
export function volPremiumByHorizon(history: HistoryPoint[]): VolPremiumRow[] {
  const pts = history.map((h) => h.hourlyVol).filter((v): v is HourlyVolPoint => !!v && v.ladderPct !== null && v.smilePct !== null);
  const out: VolPremiumRow[] = [];
  for (const [lo, hi, label] of PREMIUM_BANDS) {
    const band = pts.filter((v) => v.minutesToClose >= lo && v.minutesToClose < hi);
    if (!band.length) continue;
    const prem = band.map((v) => (v.ladderPct as number) - (v.smilePct as number));
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const realized = band.map((v) => v.realizedPct).filter((x): x is number => x !== null);
    out.push({
      label,
      n: band.length,
      hours: new Set(band.map((v) => v.ladderId)).size,
      meanLadderPct: Math.round(mean(band.map((v) => v.ladderPct as number)) * 10) / 10,
      meanSmilePct: Math.round(mean(band.map((v) => v.smilePct as number)) * 10) / 10,
      meanPremiumPts: Math.round(mean(prem) * 10) / 10,
      minPremiumPts: Math.round(Math.min(...prem) * 10) / 10,
      maxPremiumPts: Math.round(Math.max(...prem) * 10) / 10,
      meanRealizedPct: realized.length ? Math.round(mean(realized) * 10) / 10 : null,
    });
  }
  return out;
}
