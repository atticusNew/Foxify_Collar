/**
 * SHADOW NETTING, MEASURED AND NOT DONE.
 *
 * The shadow hedges every position leg for leg: that is the proof, and nothing here changes it.
 * This module reads the same ledger and asks one question a book would ask before it buys the
 * next hedge: when two positions sit on the two sides of the same game, what would netting them
 * have saved?
 *
 * Why the two sides net. A holder of side A is protected by buying A-NO; a holder of side B by
 * buying B-NO. In a two-outcome game A-NO is B-YES, so the two hedges together pay $1 per unit
 * whoever wins. Buying both is paying two spreads and two fees for a dollar that could simply be
 * held in reserve. Netting means: hold the matched units as cash, buy only the residual on the
 * larger side.
 *
 * What is measured, per pair, integer cents:
 *   leg for leg   both hedges as the record bought them (hedge cost, venue fees included)
 *   netted        the reserve (matched units at 100 cents, no spread, no fee) plus the residual
 *                 at that position's own average unit cost
 *   saving        leg for leg minus netted; the two-sided spread plus fees on the matched units
 *   identity      our result on the pair, written out for each winner, equals the two takes plus
 *                 the saving in both states. Checked per pair, not believed.
 *
 * What transfers and what does not. The shadow opens one position per market, so which games have
 * both sides is what the board offered, not what users brought; the netted share here says
 * nothing about live flow. The number that transfers is the two-sided cost per netted dollar: the
 * saving a real book earns on every dollar it can match. Both are reported, and labelled.
 *
 * The two sides of a pair were opened by different scans, often hours apart, so a pair's two-sided
 * cost also carries whatever the market did in between; the pairs opened within one hour of each
 * other are summarized apart, and theirs is the cost per netted dollar to quote.
 *
 * The residual at the position's average unit cost is a ceiling on its cost (the top of the book
 * is cheaper than the walk), so the saving is a floor. Pairs are only formed for sports events
 * with exactly two sides on the record and no draw market; crypto strikes under one event are not
 * exclusive outcomes and are never paired.
 *
 * Operator view. Nothing in this module is on the public record. Pure bookkeeping over the
 * replayed ledger: no venue calls, no trading.
 */

import { hedgeCostOf, hedgeUnitsOf, writerPayouts, type ShadowPosition } from "./shadowLedger";

export interface NettingSide {
  ticker: string;
  sideName: string;
  status: ShadowPosition["status"];
  openedAt: string;
  contracts: number;
  hedgeUnitsMilli: number;
  /** venue fees included, from the credit identity */
  hedgeCostCents: number;
  /** cents per $1 unit, one decimal */
  unitCostCents: number;
  takeCents: number;
}

export interface NettingPair {
  eventKey: string;
  league: string;
  eventTitle: string;
  eventTimeIso: string;
  sides: [NettingSide, NettingSide];
  /** units matched and held as reserve, milli */
  nettedUnitsMilli: number;
  /** units still bought, on the side with the larger hedge, milli */
  residualUnitsMilli: number;
  residualSide: string | null;
  /** both hedges bought leg for leg: whether both were filled on the same book */
  hedgedOnOneBook: boolean;
  legForLegCents: number;
  reserveCents: number;
  residualCostCents: number;
  nettedCents: number;
  savingCents: number;
  /** the two hedges' unit costs summed: cents paid per $1 of matched payout; 100 would be free */
  twoSidedCostCentsPerUnit: number;
  takeCents: number;
  /** hours between the two opens on the record (scan order, not user arrival) */
  openedGapHours: number;
  identity: NettingIdentity;
}

/**
 * Our result on the pair if netted, written out per winner. Leg for leg the pair pays the two
 * takes whoever wins; netted it pays the two takes plus the saving, whoever wins. `holds` is
 * both states within integer rounding of that.
 */
export interface NettingIdentity {
  ifFirstWinsCents: number;
  ifSecondWinsCents: number;
  legForLegIfFirstWinsCents: number;
  legForLegIfSecondWinsCents: number;
  expectedCents: number;
  holds: boolean;
}

export interface NettingLeagueRow {
  pairs: number;
  singles: number;
  legForLegCents: number;
  nettedCents: number;
  savingCents: number;
  medianTwoSidedCostCentsPerUnit: number | null;
}

export interface NettingSummary {
  method: string;
  pairs: number;
  /** sports events with one side on the record: nothing to net against */
  singles: number;
  /** sports events with more than two sides on the record, or a draw side: not paired */
  skippedMultiOutcome: number;
  cryptoExcluded: number;
  pairedPositions: number;
  legForLegCents: number;
  nettedCents: number;
  savingCents: number;
  /** saving as bps of leg-for-leg hedge cost on the paired positions */
  savingBpsOfLegForLeg: number | null;
  takeOnPairsCents: number;
  /** saving as a share of the take booked on the same positions, bps (10000 = the saving equals the take) */
  savingBpsOfTake: number | null;
  grossUnitsMilli: number;
  nettedUnitsMilli: number;
  /** matched units as a share of all paired hedge units, bps; a property of the board, not of flow */
  nettedShareBps: number | null;
  twoSidedCostCentsPerUnit: { median: number | null; min: number | null; max: number | null };
  pairsSaving: number;
  pairsNotSaving: number;
  openedGapHours: { median: number | null };
  /**
   * Pairs whose two sides were priced within one hedging window of each other. Sides priced
   * hours apart carry the market's move between the two opens in their two-sided cost, in either
   * direction; these do not, so their cost per netted dollar is the one to quote.
   */
  sameWindow: { windowHours: number; pairs: number; legForLegCents: number; savingCents: number; medianTwoSidedCostCentsPerUnit: number | null };
  identityHolds: boolean;
  byLeague: Record<string, NettingLeagueRow>;
}

/** Two opens this close together were priced off the same books; wider apart, the market moved between them. */
export const SAME_WINDOW_HOURS = 1;

export const NETTING_METHOD =
  "Two sides of one game on the record: the matched hedge units are held as cash at 100 cents, the residual is bought at that position's own average unit cost. Saving is what leg for leg paid above that. Measured on the replayed ledger; nothing was netted, nothing changed hands.";

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** The event under a Kalshi market ticker: everything before the outcome suffix. */
export function eventKeyOf(ticker: string): string {
  const i = ticker.lastIndexOf("-");
  return i > 0 ? ticker.slice(0, i) : ticker;
}

const isDrawSide = (sideName: string): boolean => /\b(draw|tie)\b/i.test(sideName);

function sideOf(p: ShadowPosition): NettingSide {
  const units = hedgeUnitsOf(p);
  const cost = hedgeCostOf(p);
  return {
    ticker: p.ticker,
    sideName: p.sideName,
    status: p.status,
    openedAt: p.at,
    contracts: p.contracts,
    hedgeUnitsMilli: units,
    hedgeCostCents: cost,
    unitCostCents: units > 0 ? round1((cost * 1000) / units) : 0,
    takeCents: p.takeCents,
  };
}

/** The two positions as one netted pair, or null when a hedge has no units to match. */
export function netPair(a: ShadowPosition, b: ShadowPosition): NettingPair | null {
  const [first, second] = a.at <= b.at ? [a, b] : [b, a];
  const s1 = sideOf(first);
  const s2 = sideOf(second);
  if (s1.hedgeUnitsMilli <= 0 || s2.hedgeUnitsMilli <= 0) return null;

  const m = Math.min(s1.hedgeUnitsMilli, s2.hedgeUnitsMilli);
  const larger = s1.hedgeUnitsMilli >= s2.hedgeUnitsMilli ? s1 : s2;
  const r = larger.hedgeUnitsMilli - m;
  const legForLeg = s1.hedgeCostCents + s2.hedgeCostCents;
  const reserve = Math.round(m / 10);
  const residualCost = r > 0 ? Math.round((larger.hedgeCostCents * r) / larger.hedgeUnitsMilli) : 0;
  const netted = reserve + residualCost;
  const saving = legForLeg - netted;
  const takeCents = s1.takeCents + s2.takeCents;

  // Our result on the pair per winner, netted: holder legs as leg for leg, the reserve returns
  // itself, the residual pays $1 a unit when its own side loses.
  const lfl1 = writerPayouts(first, "yes").writerCents + writerPayouts(second, "no").writerCents;
  const lfl2 = writerPayouts(first, "no").writerCents + writerPayouts(second, "yes").writerCents;
  const holderLegs = (winner: ShadowPosition, loser: ShadowPosition): number =>
    (100 - winner.capCents) * winner.contracts - loser.floorCents * loser.contracts - winner.creditCents - loser.creditCents;
  const residualPays = (winnerSide: NettingSide): number => (r > 0 && larger.ticker !== winnerSide.ticker ? Math.round(r / 10) : 0);
  const net1 = holderLegs(first, second) + residualPays(s1) - residualCost;
  const net2 = holderLegs(second, first) + residualPays(s2) - residualCost;
  const expected = takeCents + saving;
  const tol = 2;
  const identity: NettingIdentity = {
    ifFirstWinsCents: net1,
    ifSecondWinsCents: net2,
    legForLegIfFirstWinsCents: lfl1,
    legForLegIfSecondWinsCents: lfl2,
    expectedCents: expected,
    holds: Math.abs(net1 - (lfl1 + saving)) <= tol && Math.abs(net2 - (lfl2 + saving)) <= tol && Math.abs(net1 - net2) <= tol + 2,
  };

  return {
    eventKey: eventKeyOf(first.ticker),
    league: first.league,
    eventTitle: first.eventTitle,
    eventTimeIso: first.eventTimeIso,
    sides: [s1, s2],
    nettedUnitsMilli: m,
    residualUnitsMilli: r,
    residualSide: r > 0 ? larger.sideName : null,
    hedgedOnOneBook: first.route === second.route,
    legForLegCents: legForLeg,
    reserveCents: reserve,
    residualCostCents: residualCost,
    nettedCents: netted,
    savingCents: saving,
    twoSidedCostCentsPerUnit: round1(s1.unitCostCents + s2.unitCostCents),
    takeCents,
    openedGapHours: round1(Math.abs(Date.parse(second.at) - Date.parse(first.at)) / 3_600_000),
    identity,
  };
}

export interface NettingReport {
  summary: NettingSummary;
  /** most recent event first */
  pairs: NettingPair[];
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : round1((s[mid - 1] + s[mid]) / 2);
}

/** Pair the record's two-sided games and measure what netting would have saved. */
export function measureNetting(positions: ShadowPosition[]): NettingReport {
  const live = positions.filter((p) => p.status !== "void");
  const cryptoExcluded = live.filter((p) => p.kind !== "sports").length;
  const byEvent = new Map<string, ShadowPosition[]>();
  for (const p of live) {
    if (p.kind !== "sports") continue;
    const k = eventKeyOf(p.ticker);
    const arr = byEvent.get(k) ?? [];
    arr.push(p);
    byEvent.set(k, arr);
  }

  const pairs: NettingPair[] = [];
  let singles = 0;
  let skippedMultiOutcome = 0;
  const leagueOf = (league: string, by: Record<string, NettingLeagueRow & { costs: number[] }>) =>
    (by[league] ??= { pairs: 0, singles: 0, legForLegCents: 0, nettedCents: 0, savingCents: 0, medianTwoSidedCostCentsPerUnit: null, costs: [] });
  const byLeague: Record<string, NettingLeagueRow & { costs: number[] }> = {};

  for (const group of byEvent.values()) {
    const league = group[0].league;
    if (group.length === 1) {
      singles += 1;
      leagueOf(league, byLeague).singles += 1;
      continue;
    }
    if (group.length !== 2 || group.some((p) => isDrawSide(p.sideName)) || group[0].sideName === group[1].sideName) {
      skippedMultiOutcome += 1;
      continue;
    }
    const pair = netPair(group[0], group[1]);
    if (!pair) {
      skippedMultiOutcome += 1;
      continue;
    }
    pairs.push(pair);
    const row = leagueOf(league, byLeague);
    row.pairs += 1;
    row.legForLegCents += pair.legForLegCents;
    row.nettedCents += pair.nettedCents;
    row.savingCents += pair.savingCents;
    row.costs.push(pair.twoSidedCostCentsPerUnit);
  }
  pairs.sort((a, b) => b.eventTimeIso.localeCompare(a.eventTimeIso));

  const legForLegCents = pairs.reduce((s, p) => s + p.legForLegCents, 0);
  const nettedCents = pairs.reduce((s, p) => s + p.nettedCents, 0);
  const savingCents = legForLegCents - nettedCents;
  const takeOnPairsCents = pairs.reduce((s, p) => s + p.takeCents, 0);
  const grossUnitsMilli = pairs.reduce((s, p) => s + p.sides[0].hedgeUnitsMilli + p.sides[1].hedgeUnitsMilli, 0);
  const nettedUnitsMilli = pairs.reduce((s, p) => s + 2 * p.nettedUnitsMilli, 0);
  const costs = pairs.map((p) => p.twoSidedCostCentsPerUnit);

  const summary: NettingSummary = {
    method: NETTING_METHOD,
    pairs: pairs.length,
    singles,
    skippedMultiOutcome,
    cryptoExcluded,
    pairedPositions: pairs.length * 2,
    legForLegCents,
    nettedCents,
    savingCents,
    savingBpsOfLegForLeg: legForLegCents > 0 ? Math.round((savingCents / legForLegCents) * 10_000) : null,
    takeOnPairsCents,
    savingBpsOfTake: takeOnPairsCents > 0 ? Math.round((savingCents / takeOnPairsCents) * 10_000) : null,
    grossUnitsMilli,
    nettedUnitsMilli,
    nettedShareBps: grossUnitsMilli > 0 ? Math.round((nettedUnitsMilli / grossUnitsMilli) * 10_000) : null,
    twoSidedCostCentsPerUnit: {
      median: median(costs),
      min: costs.length ? Math.min(...costs) : null,
      max: costs.length ? Math.max(...costs) : null,
    },
    pairsSaving: pairs.filter((p) => p.savingCents > 0).length,
    pairsNotSaving: pairs.filter((p) => p.savingCents <= 0).length,
    openedGapHours: { median: median(pairs.map((p) => p.openedGapHours)) },
    sameWindow: (() => {
      const close = pairs.filter((p) => p.openedGapHours <= SAME_WINDOW_HOURS);
      return {
        windowHours: SAME_WINDOW_HOURS,
        pairs: close.length,
        legForLegCents: close.reduce((s, p) => s + p.legForLegCents, 0),
        savingCents: close.reduce((s, p) => s + p.savingCents, 0),
        medianTwoSidedCostCentsPerUnit: median(close.map((p) => p.twoSidedCostCentsPerUnit)),
      };
    })(),
    identityHolds: pairs.every((p) => p.identity.holds),
    byLeague: Object.fromEntries(
      Object.entries(byLeague).map(([k, v]) => {
        const { costs: c, ...rest } = v;
        return [k, { ...rest, medianTwoSidedCostCentsPerUnit: median(c) }];
      }),
    ),
  };
  return { summary, pairs };
}
