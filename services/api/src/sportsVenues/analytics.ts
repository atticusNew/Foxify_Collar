/**
 * Arithmetic over observed books. Nothing here is a model: the "consensus" is the venues' own
 * de-vigged mids averaged, and every other number is a price, a fee or a difference of them.
 *
 * All-in: a taker pays ask + c·p·(1−p) and receives bid − c·p·(1−p), c the venue's coefficient
 * as it applies now (Novig's is 0 before tip-off). Order-level rounding (Kalshi rounds a fee up
 * to the cent per order) is ignored, as on the BTC page.
 *
 * A venue that instead takes a share g of a market's net winnings at settlement (ProphetX
 * outside its maker/taker leagues) charges nothing at the trade. Its fee is counted in full as
 * if the contract wins: g·(1−p) on a buy at p, which is the most it can be, so a cross or a
 * saving shown here holds whichever side wins. On the bid it is g·b, the most an offset bought
 * at 1−b can give up.
 *
 * A venue with a fixed fee per contract (Crypto.com's exchange) charges that many cents on the
 * buy and again on a sale before expiry, whatever the price.
 */

import type { Game, Side, SideQuote, Venue, VenueListing } from "./types";
import { SIDES, VENUES, byVenue as perVenue } from "./types";
import type { HistoryPoint } from "./store";

/** A venue's taker fee: c·p·(1−p), a share of net winnings, a fixed number of cents per contract, or a sum of them. */
export interface FeeTerms {
  theta: number;
  gain?: number;
  flat?: number;
}

export const takerFeeCents = (theta: number, cents: number): number => (theta * (cents / 100) * (1 - cents / 100) * 100);
/** The winnings fee of a buy at `cents`, counted as if it wins: g of the gain, cents. */
export const gainFeeCents = (gain: number | undefined, cents: number): number => (gain ? gain * (100 - cents) : 0);
/** Everything a taker pays over the ask to buy at `cents`, cents. */
export const buyFeeCents = (fee: FeeTerms, cents: number): number => takerFeeCents(fee.theta, cents) + gainFeeCents(fee.gain, cents) + (fee.flat ?? 0);
/** Everything a taker gives up under the bid when leaving at `cents`, cents. */
export const sellFeeCents = (fee: FeeTerms, cents: number): number => takerFeeCents(fee.theta, cents) + (fee.gain ? fee.gain * cents : 0) + (fee.flat ?? 0);
const r2 = (x: number): number => Math.round(x * 100) / 100;
const other = (s: Side): Side => (s === "away" ? "home" : "away");

export interface AllIn {
  venue: Venue;
  bidCents: number;
  askCents: number;
  bidQty: number;
  askQty: number;
  /** ask + fee, bid − fee, cents; null when that side of the book is empty */
  allInAsk: number | null;
  allInBid: number | null;
  mid: number | null;
  feeTheta: number;
  /** the share of net winnings taken at settlement, when the venue charges that way */
  feeGain?: number;
  /** the fixed fee per contract, cents, when the venue charges that way */
  feeFlatCents?: number;
}

export function allIn(l: VenueListing, side: Side): AllIn {
  const q: SideQuote = l[side];
  const two = q.bidCents > 0 && q.askCents > 0 && q.askCents < 100;
  const fee: FeeTerms = { theta: l.feeTheta, gain: l.feeGain, flat: l.feeFlatCents };
  return {
    venue: l.venue,
    bidCents: q.bidCents,
    askCents: q.askCents,
    bidQty: q.bidQty,
    askQty: q.askQty,
    allInAsk: q.askCents > 0 && q.askCents < 100 ? r2(q.askCents + buyFeeCents(fee, q.askCents)) : null,
    allInBid: q.bidCents > 0 ? r2(q.bidCents - sellFeeCents(fee, q.bidCents)) : null,
    mid: two ? r2((q.bidCents + q.askCents) / 2) : null,
    feeTheta: l.feeTheta,
    ...(l.feeGain ? { feeGain: l.feeGain } : {}),
    ...(l.feeFlatCents ? { feeFlatCents: l.feeFlatCents } : {}),
  };
}

export interface Cross {
  /** venue selling the away side (we buy away there) and venue selling the home side */
  awayOn: Venue;
  homeOn: Venue;
  awayAllInAsk: number;
  homeAllInAsk: number;
  /** 100 − the two all-in asks: locked per $1 whichever side wins */
  edgeCents: number;
  /** $1 shares at the two best levels, the smaller */
  qty: number;
  usd: number;
}

export interface HedgeRead {
  /** the side held (bought on Kalshi); the hedge buys the other side */
  held: Side;
  /** the other side's all-in ask on each venue, cents; null when not quoted */
  costs: Record<Venue, number | null>;
  cheapest: Venue | null;
  cheapestCents: number | null;
  /** depth at the cheapest venue's best level, $1 shares */
  cheapestQty: number | null;
  kalshiCents: number | null;
  /** Kalshi's own other side minus the cheapest: what routing saved, cents per $1 (0 when Kalshi is cheapest) */
  savingCents: number | null;
}

export interface SideRead {
  side: Side;
  code: string;
  name: string;
  quotes: Record<Venue, AllIn | null>;
  /** the venues' de-vigged mids averaged, cents; null with fewer than two venues two-sided */
  consensusCents: number | null;
  /** each venue's de-vigged mid minus the consensus, cents */
  vsConsensus: Record<Venue, number | null>;
  hedge: HedgeRead;
}

export interface GameRead {
  key: string;
  league: string;
  label: string;
  startsAt: string;
  startSource: Game["startSource"];
  live: boolean;
  minutesToStart: number;
  listed: Venue[];
  twoSided: Venue[];
  sides: Record<Side, SideRead>;
  /** the cost of buying both sides at all-in asks minus 100, per venue: its spread plus fees */
  overround: Record<Venue, number | null>;
  tightest: Venue | null;
  crosses: Cross[];
}

const emptyByVenue = <T>(v: T): Record<Venue, T> => perVenue(() => v);

/** A venue's de-vigged probability of a side from its own two mids, cents. */
export function devigCents(away: AllIn | null, home: AllIn | null, side: Side): number | null {
  if (!away || !home || away.mid === null || home.mid === null) return null;
  const sum = away.mid + home.mid;
  if (!(sum > 0)) return null;
  return r2(((side === "away" ? away.mid : home.mid) / sum) * 100);
}

export function crossesOf(byVenue: Record<Venue, { away: AllIn; home: AllIn } | null>): Cross[] {
  const out: Cross[] = [];
  for (const a of VENUES) {
    for (const h of VENUES) {
      if (a === h) continue;
      const A = byVenue[a]?.away;
      const H = byVenue[h]?.home;
      if (!A || !H || A.allInAsk === null || H.allInAsk === null) continue;
      const edge = r2(100 - A.allInAsk - H.allInAsk);
      if (edge <= 0) continue;
      const qty = Math.min(A.askQty, H.askQty);
      out.push({ awayOn: a, homeOn: h, awayAllInAsk: A.allInAsk, homeAllInAsk: H.allInAsk, edgeCents: edge, qty, usd: r2((edge * qty) / 100) });
    }
  }
  return out.sort((x, y) => y.edgeCents - x.edgeCents);
}

export function hedgeOf(byVenue: Record<Venue, { away: AllIn; home: AllIn } | null>, held: Side): HedgeRead {
  const costs = emptyByVenue<number | null>(null);
  const qty = emptyByVenue<number>(0);
  for (const v of VENUES) {
    const q = byVenue[v]?.[other(held)];
    if (q && q.allInAsk !== null && q.askQty > 0) {
      costs[v] = q.allInAsk;
      qty[v] = q.askQty;
    } else if (q && q.allInAsk !== null) {
      costs[v] = q.allInAsk;
    }
  }
  let cheapest: Venue | null = null;
  for (const v of VENUES) {
    const c = costs[v];
    if (c === null) continue;
    if (cheapest === null || c < (costs[cheapest] as number)) cheapest = v;
  }
  const k = costs.kalshi;
  return {
    held,
    costs,
    cheapest,
    cheapestCents: cheapest ? costs[cheapest] : null,
    cheapestQty: cheapest ? qty[cheapest] : null,
    kalshiCents: k,
    savingCents: cheapest && k !== null ? r2(k - (costs[cheapest] as number)) : null,
  };
}

export function readGame(g: Game, nowMs: number): GameRead {
  const byVenue = emptyByVenue<{ away: AllIn; home: AllIn } | null>(null);
  for (const l of g.listings) byVenue[l.venue] = { away: allIn(l, "away"), home: allIn(l, "home") };
  const listed = VENUES.filter((v) => byVenue[v]);
  const twoSided = VENUES.filter((v) => byVenue[v] && byVenue[v]!.away.mid !== null && byVenue[v]!.home.mid !== null);
  const startMs = Date.parse(g.startsAt);
  const sides = {} as Record<Side, SideRead>;
  for (const side of SIDES) {
    const quotes = emptyByVenue<AllIn | null>(null);
    const devig = emptyByVenue<number | null>(null);
    for (const v of VENUES) {
      quotes[v] = byVenue[v]?.[side] ?? null;
      devig[v] = byVenue[v] ? devigCents(byVenue[v]!.away, byVenue[v]!.home, side) : null;
    }
    const vals = VENUES.map((v) => devig[v]).filter((x): x is number => x !== null);
    const consensus = vals.length >= 2 ? r2(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    const vs = emptyByVenue<number | null>(null);
    for (const v of VENUES) vs[v] = consensus !== null && devig[v] !== null ? r2(devig[v]! - consensus) : null;
    sides[side] = {
      side,
      code: side === "away" ? g.awayCode : g.homeCode,
      name: side === "away" ? g.awayName : g.homeName,
      quotes,
      consensusCents: consensus,
      vsConsensus: vs,
      hedge: hedgeOf(byVenue, side),
    };
  }
  const overround = emptyByVenue<number | null>(null);
  let tightest: Venue | null = null;
  for (const v of VENUES) {
    const b = byVenue[v];
    if (!b || b.away.allInAsk === null || b.home.allInAsk === null) continue;
    overround[v] = r2(b.away.allInAsk + b.home.allInAsk - 100);
    if (tightest === null || (overround[v] as number) < (overround[tightest] as number)) tightest = v;
  }
  return {
    key: g.key,
    league: g.league,
    label: `${g.awayCode} @ ${g.homeCode}`,
    startsAt: g.startsAt,
    startSource: g.startSource,
    // a date-only start is a placeholder, never evidence that the game is on
    live: g.startSource === "venue" && Number.isFinite(startMs) && startMs <= nowMs,
    minutesToStart: Number.isFinite(startMs) ? Math.round((startMs - nowMs) / 60_000) : 0,
    listed,
    twoSided,
    sides,
    overround,
    tightest,
    crosses: crossesOf(byVenue),
  };
}

// ---------------------------------------------------------------------------
// the slate
// ---------------------------------------------------------------------------

export interface VenueTally {
  venue: Venue;
  /** games this venue lists, and lists two-sided on both teams */
  listed: number;
  twoSided: number;
  meanOverround: number | null;
  /** games where this venue's both-sides cost was the lowest */
  tightestCount: number;
  /** sides (two per game) on which the venue quotes the other side at all */
  hedgeQuoted: number;
  /** sides on which it is the cheapest place to buy the other side */
  hedgeCheapest: number;
  /** mean saving vs Kalshi's own other side when this venue is cheapest, cents */
  meanSavingCents: number | null;
  /** mean |de-vigged mid − consensus| across sides where both exist, cents */
  meanAbsVsConsensus: number | null;
}

export interface SlateRead {
  games: number;
  live: number;
  withTwo: number;
  withThree: number;
  /** games every venue on the page quotes two-sided */
  withAll: number;
  /** sides (two per game) with at least two venues quoting the other side: where routing has a choice */
  sidesWithChoice: number;
  /** of those, sides where a venue other than Kalshi is the cheapest hedge */
  sidesRoutedAway: number;
  meanSavingRoutedCents: number | null;
  venues: VenueTally[];
  crosses: Array<Cross & { key: string; label: string; league: string; live: boolean }>;
  crossUsd: number;
}

export function readSlate(reads: GameRead[]): SlateRead {
  const tallies: Record<Venue, { listed: number; two: number; over: number[]; tight: number; hq: number; hc: number; sav: number[]; vs: number[] }> = emptyByVenue(null as never);
  for (const v of VENUES) tallies[v] = { listed: 0, two: 0, over: [], tight: 0, hq: 0, hc: 0, sav: [], vs: [] };
  let sidesWithChoice = 0;
  let routedAway = 0;
  const routedSav: number[] = [];
  const crosses: SlateRead["crosses"] = [];
  for (const g of reads) {
    for (const v of g.listed) tallies[v].listed += 1;
    for (const v of g.twoSided) tallies[v].two += 1;
    for (const v of VENUES) if (g.overround[v] !== null) tallies[v].over.push(g.overround[v] as number);
    if (g.tightest) tallies[g.tightest].tight += 1;
    for (const side of SIDES) {
      const s = g.sides[side];
      const quoted = VENUES.filter((v) => s.hedge.costs[v] !== null);
      for (const v of quoted) tallies[v].hq += 1;
      if (s.hedge.cheapest) {
        tallies[s.hedge.cheapest].hc += 1;
        if (s.hedge.savingCents !== null) tallies[s.hedge.cheapest].sav.push(s.hedge.savingCents);
      }
      if (quoted.length >= 2) {
        sidesWithChoice += 1;
        if (s.hedge.cheapest && s.hedge.cheapest !== "kalshi" && s.hedge.savingCents !== null && s.hedge.savingCents > 0) {
          routedAway += 1;
          routedSav.push(s.hedge.savingCents);
        }
      }
      for (const v of VENUES) if (s.vsConsensus[v] !== null) tallies[v].vs.push(Math.abs(s.vsConsensus[v] as number));
    }
    for (const c of g.crosses) crosses.push({ ...c, key: g.key, label: g.label, league: g.league, live: g.live });
  }
  const mean = (xs: number[]) => (xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  crosses.sort((a, b) => b.usd - a.usd || b.edgeCents - a.edgeCents);
  return {
    games: reads.length,
    live: reads.filter((g) => g.live).length,
    withTwo: reads.filter((g) => g.twoSided.length >= 2).length,
    withThree: reads.filter((g) => g.twoSided.length >= 3).length,
    withAll: reads.filter((g) => g.twoSided.length === VENUES.length).length,
    sidesWithChoice,
    sidesRoutedAway: routedAway,
    meanSavingRoutedCents: mean(routedSav),
    venues: VENUES.map((v) => ({
      venue: v,
      listed: tallies[v].listed,
      twoSided: tallies[v].two,
      meanOverround: mean(tallies[v].over),
      tightestCount: tallies[v].tight,
      hedgeQuoted: tallies[v].hq,
      hedgeCheapest: tallies[v].hc,
      meanSavingCents: mean(tallies[v].sav),
      meanAbsVsConsensus: mean(tallies[v].vs),
    })),
    crosses,
    crossUsd: r2(crosses.reduce((a, c) => a + c.usd, 0)),
  };
}

// ---------------------------------------------------------------------------
// over the window
// ---------------------------------------------------------------------------

export interface GapSeries {
  key: string;
  label: string;
  side: Side;
  code: string;
  venue: Venue;
  /** [atMs, Kalshi mid − venue mid]; at most GAP_SERIES_MAX_POINTS of them, evenly spread, the newest always kept */
  series: Array<[number, number]>;
  /** how many snapshots the figures beside the series were taken over */
  points: number;
  meanAbs: number;
  max: number;
  last: number;
}

/**
 * What a sparkline 160 pixels wide can show. The page and the JSON carry this many points per
 * series, not one per snapshot: three days of a full slate would otherwise be megabytes per view.
 */
export const GAP_SERIES_MAX_POINTS = 240;

/**
 * Kalshi mid minus each other venue's mid, per game and side, over the window. The mean, the
 * maximum and the last value are over every snapshot; only the plotted series is thinned.
 */
export function gapSeries(history: HistoryPoint[], reads: GameRead[]): GapSeries[] {
  const out: GapSeries[] = [];
  for (const g of reads) {
    for (const side of SIDES) {
      for (const v of VENUES) {
        if (v === "kalshi") continue;
        const at: number[] = [];
        const gap: number[] = [];
        let sumAbs = 0;
        let max = 0;
        for (const h of history) {
          const row = h.games[g.key];
          if (!row) continue;
          const k = row.kalshi;
          const o = row[v];
          if (!k || !o) continue;
          const km = midOf(k, side);
          const om = midOf(o, side);
          if (km === null || om === null) continue;
          const x = r2(km - om);
          at.push(h.atMs);
          gap.push(x);
          sumAbs += Math.abs(x);
          max = Math.max(max, Math.abs(x));
        }
        const n = at.length;
        if (n < 2) continue;
        const series: Array<[number, number]> = [];
        const shown = Math.min(n, GAP_SERIES_MAX_POINTS);
        for (let i = 0; i < shown; i += 1) {
          const j = shown === n ? i : Math.round((i * (n - 1)) / (shown - 1));
          series.push([at[j], gap[j]]);
        }
        out.push({
          key: g.key,
          label: g.label,
          side,
          code: g.sides[side].code,
          venue: v,
          series,
          points: n,
          meanAbs: r2(sumAbs / n),
          max: r2(max),
          last: gap[n - 1],
        });
      }
    }
  }
  return out;
}

function midOf(cell: HistoryPoint["games"][string][Venue], side: Side): number | null {
  if (!cell) return null;
  const [ab, aa, hb, ha] = cell;
  const b = side === "away" ? ab : hb;
  const a = side === "away" ? aa : ha;
  return b > 0 && a > 0 && a < 100 ? (b + a) / 2 : null;
}

export interface WindowTally {
  snapshots: number;
  /** snapshots with at least one executable cross after fees */
  snapshotsWithCross: number;
  widestCrossCents: number;
  /** the game and the two venues of the widest cross */
  widestCross: { label: string; awayOn: Venue; homeOn: Venue; atMs: number } | null;
  /** readings = one side of one game in one snapshot where at least two venues quoted the other side */
  readings: number;
  /** of those, the cheapest venue, by venue; and the mean saving vs Kalshi's own when it was not Kalshi */
  cheapest: Record<Venue, number>;
  meanSavingRoutedCents: number | null;
  /** the same split for readings taken after the game started */
  liveReadings: number;
  liveCheapest: Record<Venue, number>;
  liveMeanSavingRoutedCents: number | null;
}

/** The hedger's tally over every snapshot in the window, from the stored books, fees as they applied then. */
export function windowTally(history: HistoryPoint[]): WindowTally {
  let snapshotsWithCross = 0;
  let widest = 0;
  let widestCross: WindowTally["widestCross"] = null;
  let readings = 0;
  let liveReadings = 0;
  const cheapest = emptyByVenue(0);
  const liveCheapest = emptyByVenue(0);
  const sav: number[] = [];
  const liveSav: number[] = [];
  for (const h of history) {
    let anyCross = false;
    for (const [key, row] of Object.entries(h.games)) {
      const live = h.starts?.[key] !== undefined && h.starts[key] <= h.atMs;
      const ask = (v: Venue, side: Side): number | null => {
        const c = row[v];
        if (!c) return null;
        const a = side === "away" ? c[1] : c[3];
        return a > 0 && a < 100 ? a + buyFeeCents({ theta: c[4], gain: c[9], flat: c[10] }, a) : null;
      };
      const qty = (v: Venue, side: Side): number => {
        const c = row[v];
        return c ? (side === "away" ? c[6] : c[8]) ?? 0 : 0;
      };
      for (const a of VENUES) {
        for (const hv of VENUES) {
          if (a === hv) continue;
          const A = ask(a, "away");
          const H = ask(hv, "home");
          if (A === null || H === null) continue;
          const edge = 100 - A - H;
          if (edge > 0 && qty(a, "away") > 0 && qty(hv, "home") > 0) {
            anyCross = true;
            if (edge > widest) {
              widest = edge;
              widestCross = { label: key.split(":").slice(1, 3).join(" @ "), awayOn: a, homeOn: hv, atMs: h.atMs };
            }
          }
        }
      }
      for (const side of SIDES) {
        const o = other(side);
        const costs = VENUES.map((v) => [v, ask(v, o)] as const).filter((x): x is readonly [Venue, number] => x[1] !== null);
        if (costs.length < 2) continue;
        const best = costs.reduce((x, y) => (y[1] < x[1] ? y : x));
        const k = costs.find((x) => x[0] === "kalshi");
        readings += 1;
        cheapest[best[0]] += 1;
        if (best[0] !== "kalshi" && k) sav.push(k[1] - best[1]);
        if (live) {
          liveReadings += 1;
          liveCheapest[best[0]] += 1;
          if (best[0] !== "kalshi" && k) liveSav.push(k[1] - best[1]);
        }
      }
    }
    if (anyCross) snapshotsWithCross += 1;
  }
  const mean = (xs: number[]) => (xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return {
    snapshots: history.length,
    snapshotsWithCross,
    widestCrossCents: r2(widest),
    widestCross,
    readings,
    cheapest,
    meanSavingRoutedCents: mean(sav),
    liveReadings,
    liveCheapest,
    liveMeanSavingRoutedCents: mean(liveSav),
  };
}
