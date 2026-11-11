/**
 * THE CAPITAL MODEL, FROM THE RECORD.
 *
 * How much of our own money each settlement shape ties up, measured on the lines the record
 * already holds: when each line opened, when it ended, and what it would have had us pay.
 *
 *   own sale    none. The holder sells part of the position in their own account, to their own
 *               venue's bids. We pay nothing and are owed nothing. Stated, not computed.
 *
 *   better bid  we buy the holder's contracts on their venue and the other side on another venue,
 *               and hold both until the game settles, when one of the two pays $1.
 *                 ceiling   every line, at $1 for each contract sold. A better bid can never cost
 *                           more than that: it is only made when what the pair pays ($1) covers
 *                           what the pair cost (betterBid.ts, lockedCents >= 0).
 *                 measured  only the lines where a better bid was found (the line's
 *                           counterfactuals.sale, shadowSaleAlternatives.ts), at what it would
 *                           have paid at that moment: the pair's $1 less what is left if the
 *                           holder's side wins, which is exactly the cash paid at the two venues.
 *
 *   collar      today's shape, our book as the writer: the hedge bought at lock in, venue fees
 *               included, plus the credit, which is owed to the holder from lock in. By identity
 *               (shadowLedger.hedgeCostOf) the two sum to the cap slice less our take.
 *
 * TIED UP means paid out and not yet back. A line ties its money from the moment it opened until
 * it ended, plus a payout lag: venues pay some hours after the result, and the record does not
 * measure how many. Every figure is given with no lag and with a stated one.
 *
 * WHEN A LINE ENDED. Collar: when it settled, or when the holder left early. Better bid: when it
 * settled; there is no leaving early, the holder sold. A line the holder left early has no
 * settlement time on the record, so its pair is held until the game's start plus the median time
 * from start to settlement among the lines that did settle, never earlier than the leave. Those
 * lines are counted (`endEstimated`). A line still open is tied up now. Voided lines are left out.
 *
 * AT A MULTIPLE of the record's volume every line's size is multiplied; timing is unchanged. That
 * is the money needed IF the books hold that size at those prices, which this does not measure.
 *
 * ONE POOL. The peak is across all venues together. Cash has to sit on each venue before the
 * trade and cannot move between two venues in the moment, so funding each venue for its own peak
 * takes more than the pooled peak. The collar's figure is also given per hedge route for that
 * reason; the better bid's split across its two venues is not modelled.
 *
 * Integer cents throughout; the time-weighted average is summed in BigInt and rounded down.
 * Pure: positions in, figures out. Reads no file, makes no call. Simulated, like the record.
 */

import { hedgeCostOf, hedgeUnitsOf, type ShadowPosition } from "./shadowLedger";

export const CAPITAL_MULTIPLES: readonly number[] = [1, 10, 100];
/** No lag, and one day. The second is an assumption: no venue's payout time is on the record. */
export const CAPITAL_LAG_HOURS: readonly number[] = [0, 24];

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Money paid out at `fromMs` and back at `untilMs`; null while it is still out. */
export interface CapitalStretch {
  fromMs: number;
  untilMs: number | null;
  cents: number;
}

export interface CapitalFigures {
  /** hours added to every line's end before its money counts as back */
  lagHours: number;
  /** the most tied up at one moment, and when that moment began */
  peakCents: number;
  peakAt: string | null;
  /** tied up at `now` */
  nowCents: number;
  /** averaged over time from the first line to `now`, rounded down */
  averageCents: number;
  atMultiple: Array<{ multiple: number; peakCents: number; averageCents: number }>;
}

export interface CapitalShape {
  /** lines that tie money up under this shape */
  lines: number;
  /** of those, still open at `now` */
  open: number;
  /** of those, lines whose end is an estimate (left early; see the header) */
  endEstimated: number;
  /** everything paid out across the lines, whenever it came back */
  outlayCents: number;
  /** median time a finished line's money was out before any lag, minutes; null when none has finished */
  medianMinutesHeld: number | null;
  /** our take on those lines as the record priced it */
  takeCents: number;
  byLag: CapitalFigures[];
}

export interface CapitalModel {
  at: string;
  record: {
    /** every line read */
    lines: number;
    voided: number;
    /** member sales on the record: own sales already, no money of ours */
    memberSales: number;
    /** lines the model counts: neither voided nor a member sale, with a readable open time */
    counted: number;
    since: string | null;
    /** from the first counted line to `now`, whole days rounded up */
    days: number;
  };
  ownSale: { peakCents: 0; lines: number };
  betterBid: {
    ceiling: CapitalShape;
    /** lines that carry the measurement at all (written since it shipped) */
    linesMeasured: number;
    measured: CapitalShape;
  };
  collar: CapitalShape & {
    /** the same peak with no lag, per hedge route, and their sum: what funding each venue for its own peak takes */
    byRoute: Array<{ route: string; lines: number; peakCents: number }>;
    sumOfRoutePeaksCents: number;
  };
  /** median minutes from a game's start to its settlement among settled lines; null when none; used for `endEstimated` lines */
  medianStartToSettleMinutes: number | null;
}

const ms = (iso: string | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** The middle value; an even count takes the mean of the two middle values, rounded down. Null on nothing. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : Math.floor((s[mid - 1] + s[mid]) / 2);
}

/**
 * What a set of stretches has tied up, with every end pushed back by `lagHours`. At one instant,
 * money going out is counted before money coming back: cash that returns in the same moment
 * could not have paid for the trade.
 */
export function tiedUp(stretches: readonly CapitalStretch[], nowMs: number, lagHours: number): CapitalFigures {
  const lagMs = lagHours * HOUR_MS;
  const events: Array<{ t: number; d: number }> = [];
  let firstMs: number | null = null;
  for (const s of stretches) {
    if (s.cents <= 0 || s.fromMs > nowMs) continue;
    const until = s.untilMs === null ? null : Math.max(s.fromMs, s.untilMs + lagMs);
    events.push({ t: s.fromMs, d: s.cents });
    if (until !== null && until <= nowMs) events.push({ t: until, d: -s.cents });
    if (firstMs === null || s.fromMs < firstMs) firstMs = s.fromMs;
  }
  events.sort((a, b) => a.t - b.t || b.d - a.d);
  let level = 0;
  let peak = 0;
  let peakAtMs: number | null = null;
  let area = 0n;
  let prev = firstMs ?? nowMs;
  for (const e of events) {
    area += BigInt(level) * BigInt(e.t - prev);
    prev = e.t;
    level += e.d;
    if (level > peak) {
      peak = level;
      peakAtMs = e.t;
    }
  }
  area += BigInt(level) * BigInt(nowMs - prev);
  const span = firstMs === null ? 0 : nowMs - firstMs;
  const average = span > 0 ? Number(area / BigInt(span)) : level;
  return {
    lagHours,
    peakCents: peak,
    peakAt: peakAtMs === null ? null : new Date(peakAtMs).toISOString(),
    nowCents: level,
    averageCents: average,
    atMultiple: CAPITAL_MULTIPLES.map((multiple) => ({ multiple, peakCents: peak * multiple, averageCents: average * multiple })),
  };
}

interface Line {
  stretch: CapitalStretch;
  endEstimated: boolean;
  takeCents: number;
}

function shapeOf(lines: readonly Line[], nowMs: number): CapitalShape {
  const live = lines.filter((l) => l.stretch.cents > 0 && l.stretch.fromMs <= nowMs);
  const stretches = live.map((l) => l.stretch);
  const finished = (s: CapitalStretch): boolean => s.untilMs !== null && s.untilMs <= nowMs;
  return {
    lines: live.length,
    open: stretches.filter((s) => !finished(s)).length,
    endEstimated: live.filter((l) => l.endEstimated).length,
    outlayCents: stretches.reduce((a, s) => a + s.cents, 0),
    medianMinutesHeld: median(stretches.filter(finished).map((s) => Math.floor(((s.untilMs as number) - s.fromMs) / 60_000))),
    takeCents: live.reduce((a, l) => a + l.takeCents, 0),
    byLag: CAPITAL_LAG_HOURS.map((lag) => tiedUp(stretches, nowMs, lag)),
  };
}

export function capitalModel(positions: readonly ShadowPosition[], now: Date = new Date()): CapitalModel {
  const nowMs = now.getTime();
  const voided = positions.filter((p) => p.status === "void").length;
  const memberSales = positions.filter((p) => p.status !== "void" && p.route === "member_sale").length;
  const counted = positions.filter((p) => p.status !== "void" && p.route !== "member_sale" && ms(p.at) !== null && (ms(p.at) as number) <= nowMs);

  const startToSettle: number[] = [];
  for (const p of counted) {
    const start = ms(p.eventTimeIso);
    const settled = ms(p.settledAt);
    if (p.status === "settled" && start !== null && settled !== null && settled >= start) startToSettle.push(Math.floor((settled - start) / 60_000));
  }
  const medianStartToSettleMinutes = median(startToSettle);

  const collar: Line[] = [];
  const ceiling: Line[] = [];
  const measured: Line[] = [];
  const byRoute = new Map<string, CapitalStretch[]>();
  let linesMeasured = 0;

  for (const p of counted) {
    const fromMs = ms(p.at) as number;
    const settledMs = p.status === "settled" ? ms(p.settledAt) : null;
    const closedMs = p.status === "closed" ? ms(p.closedAt) : null;

    // collar: the hedge and the credit, out from lock in until the line settled or the holder left
    const collarStretch: CapitalStretch = { fromMs, untilMs: settledMs ?? closedMs, cents: Math.max(0, hedgeCostOf(p)) + Math.max(0, p.creditCents) };
    collar.push({ stretch: collarStretch, endEstimated: false, takeCents: p.takeCents });
    const route = String(p.route);
    byRoute.set(route, [...(byRoute.get(route) ?? []), collarStretch]);

    // better bid: the pair is held to settlement; a line left early has none on the record
    let pairUntil: number | null = settledMs;
    let endEstimated = false;
    if (p.status === "closed" && closedMs !== null) {
      const start = ms(p.eventTimeIso);
      pairUntil = start !== null && medianStartToSettleMinutes !== null ? Math.max(closedMs, start + medianStartToSettleMinutes * 60_000) : closedMs;
      endEstimated = true;
    }
    ceiling.push({ stretch: { fromMs, untilMs: pairUntil, cents: Math.floor(hedgeUnitsOf(p) / 10) }, endEstimated, takeCents: 0 });

    const sale = p.counterfactuals?.sale;
    if (sale) {
      linesMeasured += 1;
      const bid = sale.betterBid;
      if (bid.ok) {
        const paidNowCents = Math.floor(bid.boughtMilli / 10) - bid.ifSideWinsCents;
        measured.push({ stretch: { fromMs, untilMs: pairUntil, cents: paidNowCents }, endEstimated, takeCents: bid.takeCents });
      }
    }
  }

  const firstMs = counted.reduce<number | null>((a, p) => {
    const t = ms(p.at) as number;
    return a === null || t < a ? t : a;
  }, null);

  const routes = [...byRoute.entries()]
    .map(([route, stretches]) => ({ route, lines: stretches.filter((s) => s.cents > 0).length, peakCents: tiedUp(stretches, nowMs, 0).peakCents }))
    .sort((a, b) => b.peakCents - a.peakCents || a.route.localeCompare(b.route));

  return {
    at: now.toISOString(),
    record: {
      lines: positions.length,
      voided,
      memberSales,
      counted: counted.length,
      since: firstMs === null ? null : new Date(firstMs).toISOString(),
      days: firstMs === null ? 0 : Math.ceil((nowMs - firstMs) / DAY_MS),
    },
    ownSale: { peakCents: 0, lines: counted.length },
    betterBid: { ceiling: shapeOf(ceiling, nowMs), linesMeasured, measured: shapeOf(measured, nowMs) },
    collar: { ...shapeOf(collar, nowMs), byRoute: routes, sumOfRoutePeaksCents: routes.reduce((a, r) => a + r.peakCents, 0) },
    medianStartToSettleMinutes,
  };
}
