/**
 * Shadow netting: the two sides of one game, matched on paper. The saving is derived, the identity
 * is written out per winner, and nothing on the record changes.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { hedgeCostOf, hedgeUnitsOf, writerPayouts, type ShadowPosition } from "../src/eventCollar/crossVenue/shadowLedger";
import { NETTING_METHOD, eventKeyOf, measureNetting, netPair } from "../src/eventCollar/crossVenue/shadowNetting";

const pos = (over: Partial<ShadowPosition> & Pick<ShadowPosition, "ticker" | "sideName">): ShadowPosition => ({
  at: "2026-10-04T21:21:38.177Z",
  kind: "sports",
  league: "nfl",
  eventTitle: "49ers vs. Seahawks",
  eventTimeIso: "2026-10-11T20:25:00.000Z",
  contracts: 150,
  markCents: 53,
  floorCents: 33,
  capCents: 61,
  creditCents: 600,
  evCostBps: 219,
  route: "polymarket",
  feesCents: 0,
  takeCents: 66,
  hedgeCostCents: 5184,
  hedgeUnitsMilli: 108_000,
  status: "open",
  ...over,
});

/** The record's own numbers for one NFL game: Seahawks at 48¢ a unit, 49ers at 61¢ a unit. */
const SEA = pos({ ticker: "KXNFLGAME-26OCT11SFSEA-SEA", sideName: "Seahawks" });
const SF = pos({
  ticker: "KXNFLGAME-26OCT11SFSEA-SF",
  sideName: "49ers",
  at: "2026-10-05T16:51:00.000Z",
  markCents: 42,
  floorCents: 24,
  capCents: 51,
  creditCents: 603,
  takeCents: 67,
  hedgeCostCents: 6680,
  hedgeUnitsMilli: 109_500,
});

test("netting: the event key is the ticker without its outcome suffix", () => {
  assert.equal(eventKeyOf("KXNFLGAME-26OCT11SFSEA-SEA"), "KXNFLGAME-26OCT11SFSEA");
  assert.equal(eventKeyOf("KXBTCD-26OCT1117-T83749.99"), "KXBTCD-26OCT1117");
  assert.equal(eventKeyOf("NOSUFFIX"), "NOSUFFIX");
});

test("netting: one pair, every number derived from the record's own hedge legs", () => {
  // Identity inputs first: the module reads hedge cost from the credit identity, never the stored field.
  assert.equal(hedgeCostOf(SEA), 5184);
  assert.equal(hedgeCostOf(SF), 6680);
  const pair = netPair(SF, SEA);
  assert.ok(pair);
  assert.equal(pair.sides[0].sideName, "Seahawks", "sides are ordered by open time, whichever argument came first");
  assert.equal(pair.sides[0].unitCostCents, 48);
  assert.equal(pair.sides[1].unitCostCents, 61);
  assert.equal(pair.twoSidedCostCentsPerUnit, 109, "109¢ for a dollar that pays whoever wins: 9¢ of spread and fees");
  assert.equal(pair.nettedUnitsMilli, 108_000);
  assert.equal(pair.residualUnitsMilli, 1500);
  assert.equal(pair.residualSide, "49ers");
  assert.equal(pair.legForLegCents, 5184 + 6680);
  assert.equal(pair.reserveCents, 10_800, "matched units held as cash at 100¢");
  assert.equal(pair.residualCostCents, 92, "1,500 milli at the 49ers' own 61¢ average");
  assert.equal(pair.nettedCents, 10_892);
  assert.equal(pair.savingCents, 972);
  assert.equal(pair.takeCents, 133);
  assert.equal(pair.hedgedOnOneBook, true);
  assert.equal(pair.openedGapHours, 19.5);
});

test("netting: our result on the pair is the two takes plus the saving, whoever wins", () => {
  const pair = netPair(SEA, SF);
  assert.ok(pair);
  const id = pair.identity;
  assert.equal(id.expectedCents, 133 + 972);
  assert.equal(id.ifFirstWinsCents, 1105, "Seahawks win: cap slice kept, 49ers floor paid, residual 49ers-NO pays");
  assert.equal(id.ifSecondWinsCents, 1105, "49ers win: cap slice kept, Seahawks floor paid, residual pays nothing");
  assert.equal(id.holds, true);
  // and leg for leg on the same pair pays exactly the two takes in both states, so the saving is the whole difference
  const lfl1 = writerPayouts(SEA, "yes").writerCents + writerPayouts(SF, "no").writerCents;
  const lfl2 = writerPayouts(SEA, "no").writerCents + writerPayouts(SF, "yes").writerCents;
  assert.equal(lfl1, 133);
  assert.equal(lfl2, 133);
  assert.equal(id.legForLegIfFirstWinsCents, lfl1);
  assert.equal(id.legForLegIfSecondWinsCents, lfl2);
  assert.equal(id.ifFirstWinsCents - lfl1, pair.savingCents);
});

test("netting: a pair whose books sum under a dollar does not save, and is counted as such", () => {
  // Two cheap sides: 40¢ + 55¢ = 95¢ a unit. Buying both pays $1 for 95¢; the reserve would cost more.
  const a = pos({ ticker: "KXNBAGAME-26OCT14DENLAC-DEN", sideName: "Nuggets", league: "nba", capCents: 60, creditCents: 1500, takeCents: 180, hedgeUnitsMilli: 108_000, floorCents: 32 });
  // funding (100-60)*150 = 6000; cost = 6000 - 1500 - 180 = 4320 => 40¢ a unit
  const b = pos({ ticker: "KXNBAGAME-26OCT14DENLAC-LAC", sideName: "Clippers", league: "nba", capCents: 50, creditCents: 1400, takeCents: 160, hedgeUnitsMilli: 108_000, floorCents: 22 });
  // funding (100-50)*150 = 7500; cost = 7500 - 1400 - 160 = 5940 => 55¢ a unit
  const pair = netPair(a, b);
  assert.ok(pair);
  assert.equal(pair.twoSidedCostCentsPerUnit, 95);
  assert.equal(pair.savingCents, 4320 + 5940 - 10_800);
  assert.ok(pair.savingCents < 0);
  assert.equal(pair.identity.holds, true, "the identity is arithmetic; it holds whether or not netting pays");
  const { summary } = measureNetting([a, b]);
  assert.equal(summary.pairsSaving, 0);
  assert.equal(summary.pairsNotSaving, 1);
});

test("netting: legacy records without stored hedge units still pair through the sizing rule", () => {
  const { hedgeUnitsMilli: _u, hedgeCostCents: _c, ...legacyFields } = SEA;
  const legacy = legacyFields as ShadowPosition;
  assert.equal(hedgeUnitsOf(legacy), Math.ceil(((33 + 100 - 61) * 150 * 1000) / 100));
  const pair = netPair(legacy, SF);
  assert.ok(pair);
  assert.equal(pair.sides[0].hedgeUnitsMilli, 108_000);
  assert.equal(pair.identity.holds, true);
});

test("netting: singles, crypto strikes, draw markets and three-sided events are never paired", () => {
  const single = pos({ ticker: "KXNBAGAME-26OCT11DALHOU-HOU", sideName: "Rockets", league: "nba" });
  const btc1 = pos({ ticker: "KXBTCD-26OCT1117-T83749.99", sideName: "Bitcoin $83,750 or above", kind: "crypto", league: "crypto" });
  const btc2 = pos({ ticker: "KXBTCD-26OCT1117-T82749.99", sideName: "Bitcoin $82,750 or above", kind: "crypto", league: "crypto" });
  const home = pos({ ticker: "KXEPLGAME-26OCT12ARSCHE-ARS", sideName: "Arsenal", league: "epl" });
  const draw = pos({ ticker: "KXEPLGAME-26OCT12ARSCHE-TIE", sideName: "Draw", league: "epl" });
  const t1 = pos({ ticker: "KXGOLF-26OCT12-A", sideName: "A", league: "golf" });
  const t2 = pos({ ticker: "KXGOLF-26OCT12-B", sideName: "B", league: "golf" });
  const t3 = pos({ ticker: "KXGOLF-26OCT12-C", sideName: "C", league: "golf" });
  const voided = pos({ ticker: "KXNFLGAME-26OCT11SFSEA-SF", sideName: "49ers", status: "void" });
  const { summary, pairs } = measureNetting([single, btc1, btc2, home, draw, t1, t2, t3, SEA, voided]);
  assert.equal(pairs.length, 0, "a voided side leaves the Seahawks single");
  assert.equal(summary.singles, 2, "the Rockets and the Seahawks");
  assert.equal(summary.cryptoExcluded, 2);
  assert.equal(summary.skippedMultiOutcome, 2, "the draw event and the three-sided event");
  assert.equal(summary.savingCents, 0);
  assert.equal(summary.savingBpsOfLegForLeg, null);
  assert.equal(summary.identityHolds, true, "vacuously, and never NaN");
});

test("netting: the summary totals the pairs and labels the board's share apart from the transferable cost", () => {
  const den = pos({ ticker: "KXNFLGAME-26OCT11DENLAC-DEN", sideName: "Broncos", at: "2026-10-04T22:56:00.000Z", status: "settled", result: "yes" });
  const lac = pos({ ticker: "KXNFLGAME-26OCT11DENLAC-LAC", sideName: "Chargers", at: "2026-10-04T22:21:00.000Z", status: "settled", result: "no", route: "kalshi_self" });
  const { summary, pairs } = measureNetting([SEA, SF, den, lac, pos({ ticker: "KXNBAGAME-26OCT11DALHOU-HOU", sideName: "Rockets", league: "nba" })]);
  assert.equal(summary.method, NETTING_METHOD);
  assert.equal(summary.pairs, 2);
  assert.equal(summary.singles, 1);
  assert.equal(summary.pairedPositions, 4);
  assert.equal(pairs[0].eventKey, "KXNFLGAME-26OCT11SFSEA", "most recent event first; same kickoff, so the record's order holds");
  const denlac = pairs.find((p) => p.eventKey === "KXNFLGAME-26OCT11DENLAC");
  assert.ok(denlac);
  assert.equal(denlac.hedgedOnOneBook, false, "the two hedges sat on different books; the pair nets regardless");
  assert.equal(denlac.sides[0].sideName, "Chargers", "opened first");
  // Same-side twins: 48¢ + 48¢ = 96¢; no saving on that pair, 972¢ on the other.
  assert.equal(denlac.savingCents, 5184 * 2 - 10_800);
  assert.equal(summary.savingCents, 972 + denlac.savingCents);
  assert.equal(summary.legForLegCents, 5184 + 6680 + 5184 * 2);
  assert.equal(summary.nettedCents, summary.legForLegCents - summary.savingCents);
  assert.equal(summary.takeOnPairsCents, 133 + 132);
  assert.equal(summary.savingBpsOfLegForLeg, Math.round((summary.savingCents / summary.legForLegCents) * 10_000));
  assert.equal(summary.savingBpsOfTake, Math.round((summary.savingCents / 265) * 10_000));
  assert.equal(summary.grossUnitsMilli, 108_000 + 109_500 + 108_000 * 2);
  assert.equal(summary.nettedUnitsMilli, 2 * 108_000 * 2);
  assert.equal(summary.nettedShareBps, Math.round((summary.nettedUnitsMilli / summary.grossUnitsMilli) * 10_000));
  assert.deepEqual(summary.twoSidedCostCentsPerUnit, { median: 102.5, min: 96, max: 109 });
  assert.equal(summary.pairsSaving, 1);
  assert.equal(summary.pairsNotSaving, 1);
  assert.equal(summary.openedGapHours.median, round1((19.5 + 0.6) / 2));
  assert.deepEqual(
    summary.sameWindow,
    { windowHours: 1, pairs: 1, legForLegCents: 5184 * 2, savingCents: denlac.savingCents, medianTwoSidedCostCentsPerUnit: 96 },
    "only the Broncos pair was priced within the hour; the Seahawks pair's 109¢ carries 19 hours of market",
  );
  assert.equal(summary.identityHolds, true);
  assert.deepEqual(Object.keys(summary.byLeague).sort(), ["nba", "nfl"]);
  assert.equal(summary.byLeague.nfl.pairs, 2);
  assert.equal(summary.byLeague.nfl.medianTwoSidedCostCentsPerUnit, 102.5);
  assert.equal(summary.byLeague.nba.singles, 1);
  assert.equal(summary.byLeague.nba.medianTwoSidedCostCentsPerUnit, null);
});

const round1 = (x: number) => Math.round(x * 10) / 10;
