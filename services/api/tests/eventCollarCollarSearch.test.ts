import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeTake,
  enumerateCollars,
  refuseUnfunded,
  selectTiers,
  TIER_RULES,
  type HedgeProbe,
} from "../src/eventCollar/crossVenue/collarSearch";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { quoteCrossWrap } from "../src/eventCollar/crossVenue/crossVenuePricer";
import {
  DEFAULT_CROSS_CONFIG,
  PROTECTION_TIERS,
  type CollarTerms,
  type CrossSearchConfig,
  type MatchedPair,
  type PmBook,
} from "../src/eventCollar/crossVenue/types";

const GAME_START = new Date("2026-09-13T18:20:00Z");
const NOW = new Date(GAME_START.getTime() - 6 * 3_600_000);

/** A real-looking Kalshi No side at mark 60: fair 40c, asks 41/42/43 with modest depth. */
const PROD_NO_ASKS: NoAskLevel[] = [
  { priceCents: 41, qtyMilli: 100_000 },
  { priceCents: 42, qtyMilli: 300_000 },
  { priceCents: 43, qtyMilli: 900_000 },
];

function ladder(overrides: Partial<Parameters<typeof quoteLadderWrap>[0]> = {}) {
  return quoteLadderWrap({
    pair: { kalshi: { ticker: "KXMLBGAME-26SEP131420PITCHC-PIT" }, gameStartTime: GAME_START.toISOString() },
    markCents: 60,
    entryCents: 55,
    contracts: 150,
    now: NOW,
    noAsks: PROD_NO_ASKS,
    config: DEFAULT_CROSS_CONFIG,
    ...overrides,
  });
}

// ---------------------------------------------------------------- fee rule

test("computeTake: max(share, minimum), share rounds down, minimum rounds up, de minimis waives", () => {
  const cfg = { takeBps: 1000, minTakeBpsOfStake: 25, deMinimisTakeCents: 5 };
  // 150 contracts: minimum = ceil(15000 * 25 / 10000) = ceil(37.5) = 38c
  let t = computeTake(78, 150, cfg);
  assert.deepEqual(t, { takeCents: 38, takeShareCents: 7, takeMinimumCents: 38, takeRule: "minimum", takeWaived: false });
  // share wins once gross is large: 10% of 812 = 81 > 38
  t = computeTake(812, 150, cfg);
  assert.deepEqual(t, { takeCents: 81, takeShareCents: 81, takeMinimumCents: 38, takeRule: "share", takeWaived: false });
  // one contract: minimum = ceil(100 * 25 / 10000) = 1c, share floor(0.3) = 0 -> 1c < 5c de minimis -> waived
  t = computeTake(3, 1, cfg);
  assert.deepEqual(t, { takeCents: 0, takeShareCents: 0, takeMinimumCents: 1, takeRule: "waived", takeWaived: true });
  // minimum disabled reproduces the old share-only rule exactly
  t = computeTake(78, 150, { ...cfg, minTakeBpsOfStake: 0 });
  assert.deepEqual(t, { takeCents: 7, takeShareCents: 7, takeMinimumCents: 0, takeRule: "share", takeWaived: false });
});

test("enumerateCollars: a positive gross eaten by the minimum fee is counted, not offered", () => {
  // Every collar funds exactly 20c gross; the 38c minimum on 150 contracts eats it.
  const hedgeFor = (digitalCents: number): HedgeProbe => ({
    ok: true,
    costCents: 0,
    feesCents: 0,
    hedge: {
      action: "buy",
      venue: "kalshi",
      outcome: "No",
      ticker: "T",
      contractsMilli: digitalCents * 10,
      avgPriceCents: 0,
      worstPriceCents: 0,
      costCents: 0,
    },
  });
  const cfg: CrossSearchConfig = {
    ...DEFAULT_CROSS_CONFIG,
    // one collar only: floor mark-3, cap mark+3 -> funding (100-63)*150 = 5550
    floorOffsetsCents: [3],
    capOffsetsCents: [3],
  };
  // make the hedge cost funding - 20 so gross is 20c
  const search = enumerateCollars({
    markCents: 60,
    contracts: 150,
    config: cfg,
    hedgeFor: (d) => {
      const probe = hedgeFor(d);
      return probe.ok ? { ...probe, costCents: 5550 - 20 } : probe;
    },
  });
  assert.equal(search.candidates.length, 0);
  assert.equal(search.feeEaten, 1);
  assert.equal(search.bestShortfallCents, Number.POSITIVE_INFINITY);
  const refusal = refuseUnfunded(search, cfg, {
    shortfall: "s",
    thin: "kalshi_book_too_thin",
    thinDetail: "t",
    none: "n",
  });
  assert.equal(refusal.code, "credit_nonpositive");
  assert.match(refusal.detail, /minimum fee \(25 bps of stake\)/);
  // with the minimum off, the same collar is offered with the take waived (2c < 5c)
  const shareOnly = enumerateCollars({
    markCents: 60,
    contracts: 150,
    config: { ...cfg, minTakeBpsOfStake: 0 },
    hedgeFor: (d) => {
      const probe = hedgeFor(d);
      return probe.ok ? { ...probe, costCents: 5550 - 20 } : probe;
    },
  });
  assert.equal(shareOnly.candidates.length, 1);
  assert.equal(shareOnly.candidates[0].takeRule, "waived");
  assert.equal(shareOnly.candidates[0].creditCents, 20);
});

// ------------------------------------------------------------------- tiers

test("tiers on a production-like No side: three distinct collars on the floor axis, hand-checked", () => {
  const q = ladder();
  assert.ok(q.ok, JSON.stringify(q));
  assert.equal(q.tier, "balanced");
  assert.equal(q.candidatesConsidered, 24);
  assert.deepEqual(Object.keys(q.tiers), ["tight", "balanced", "wide"]);
  const t = q.tiers.tight as CollarTerms;
  const b = q.tiers.balanced as CollarTerms;
  const w = q.tiers.wide as CollarTerms;

  // tight = highest fundable floor (48 = mark-12; floor 50 leaves gross negative on every cap):
  //   digital (48+100-63)=85c x 150 = 12750c -> 127,500 milli No
  //   walk: 100,000 @41 + 27,500 @42 = 5,255,000 milli-cents -> 5255c
  //   fees: ceil(7*100000*41*59/1e7)=170 + ceil(7*27500*42*58/1e7)=47 -> 217c
  //   funding 37*150 = 5550; gross = 5550-5255-217 = 78c
  //   take = max(floor(7.8)=7, ceil(15000*25/10000)=38) = 38 (minimum rule); credit 40c
  //   EV: naked 900,000; protected (63*150+40)*60 + (48*150+40)*40 = 859,000 -> 456 bps
  assert.equal(t.floorCents, 48);
  assert.equal(t.capCents, 63);
  assert.equal(t.hedge.venue === "kalshi" && t.hedge.contractsMilli, 127_500);
  assert.equal(t.hedge.costCents, 5255);
  assert.equal(t.feesCents, 217);
  assert.equal(t.grossCreditCents, 78);
  assert.deepEqual(
    { take: t.takeCents, share: t.takeShareCents, min: t.takeMinimumCents, rule: t.takeRule },
    { take: 38, share: 7, min: 38, rule: "minimum" },
  );
  assert.equal(t.creditCents, 40);
  assert.equal(t.evCostBps, 456);

  // wide = lowest floor offered (30 = mark-30) with the highest fundable cap there
  assert.equal(w.floorCents, 30);
  assert.equal(w.capCents, 75);
  assert.equal(w.creditCents, 189);
  assert.ok(w.evCostBps < b.evCostBps && b.evCostBps < t.evCostBps, "cheaper as the collar widens");

  // balanced = the fundable floor nearest the midpoint (39 -> 40), cheapest true cost at it
  assert.equal(b.floorCents, 40);
  assert.equal(b.capCents, 68);
  assert.equal(b.creditCents, 142);

  // the top-level terms ARE the default tier's terms
  assert.equal(q.floorCents, b.floorCents);
  assert.equal(q.capCents, b.capCents);
  assert.equal(q.creditCents, b.creditCents);
  assert.equal(q.takeRule, "minimum");
  assert.equal(q.minTakeBpsOfStake, 25);

  // every tier is a real, fully hedged collar: never under-hedged, credit positive
  for (const tier of PROTECTION_TIERS) {
    const terms = q.tiers[tier] as CollarTerms;
    const digitalCents = (terms.floorCents + 100 - terms.capCents) * q.contracts;
    const units = terms.hedge.venue === "kalshi" ? terms.hedge.contractsMilli : terms.hedge.sharesMilli;
    assert.ok(units >= digitalCents * 10, `${tier} under-hedged`);
    assert.ok(terms.creditCents > 0);
    assert.equal(terms.creditCents, terms.grossCreditCents - terms.takeCents);
    assert.ok(TIER_RULES[tier].length > 20);
  }
});

test("defaultTier picks which tier heads the quote; the others ride along unchanged", () => {
  const balanced = ladder();
  const tight = ladder({ config: { ...DEFAULT_CROSS_CONFIG, defaultTier: "tight" } });
  const wide = ladder({ config: { ...DEFAULT_CROSS_CONFIG, defaultTier: "wide" } });
  assert.ok(balanced.ok && tight.ok && wide.ok);
  assert.equal(tight.tier, "tight");
  assert.equal(tight.floorCents, 48);
  assert.equal(wide.tier, "wide");
  assert.equal(wide.floorCents, 30);
  assert.deepEqual(tight.tiers, balanced.tiers);
  assert.deepEqual(wide.tiers, balanced.tiers);
});

test("tiers collapse when they resolve to the same collar; the default still resolves", () => {
  // One floor and one cap fundable -> a single collar; all three names point at it.
  const cands: CollarTerms[] = [
    {
      floorCents: 50,
      capCents: 63,
      creditCents: 100,
      grossCreditCents: 138,
      takeCents: 38,
      takeShareCents: 13,
      takeMinimumCents: 38,
      takeRule: "minimum",
      takeWaived: false,
      hedge: { action: "buy", venue: "kalshi", outcome: "No", ticker: "T", contractsMilli: 1000, avgPriceCents: 1, worstPriceCents: 1, costCents: 1 },
      feesCents: 0,
      evCostBps: 100,
    },
  ];
  const sel = selectTiers(cands, 55, "wide");
  assert.equal(sel.tier, "tight");
  assert.deepEqual(Object.keys(sel.tiers), ["tight"]);
  assert.equal(sel.terms.floorCents, 50);

  // Two caps at one floor: tight takes the larger credit (lower cap); balanced (cheapest at
  // that floor) and wide (highest cap) both land on cap 66. Dedupe keeps the first name in
  // tier order, so balanced survives and wide collapses into it.
  const twoCaps: CollarTerms[] = [
    cands[0],
    { ...cands[0], capCents: 66, creditCents: 60, grossCreditCents: 98, evCostBps: 90 },
  ];
  const sel2 = selectTiers(twoCaps, 55, "balanced");
  assert.equal(sel2.tiers.tight?.capCents, 63);
  assert.equal(sel2.tiers.balanced?.capCents, 66);
  assert.equal(sel2.tiers.wide, undefined);
  assert.equal(sel2.tier, "balanced");
  // asking for the collapsed name resolves to its owner
  assert.equal(selectTiers(twoCaps, 55, "wide").tier, "balanced");
});

test("tight tier still prefers a floor at or above entry when the venues fund one", () => {
  // Entry 45: floors 48 and 40 both fundable; 48 >= 45 protects entry -> tight = 48.
  // Entry 49: no fundable floor protects entry -> highest floor wins anyway (48).
  const a = ladder({ entryCents: 45, config: { ...DEFAULT_CROSS_CONFIG, defaultTier: "tight" } });
  const b = ladder({ entryCents: 49, config: { ...DEFAULT_CROSS_CONFIG, defaultTier: "tight" } });
  assert.ok(a.ok && b.ok);
  assert.equal(a.floorCents, 48);
  assert.equal(b.floorCents, 48);
});

test("cross-venue route carries tiers with the same rules (fat-gap fixture)", () => {
  const pair = {
    league: "mlb",
    kalshi: { ticker: "KXMLBGAME-26SEP131420PITCHC-PIT" },
    pm: { outcomes: ["Pittsburgh Pirates", "Chicago Cubs"], tokenIds: ["111", "222"], eventSlug: "mlb-pit-chc-2026-09-13" },
    pmYesOutcomeIndex: 0,
    pmNoOutcomeIndex: 1,
    gameStartTime: GAME_START.toISOString(),
    parityNote: "same official result",
    fingerprint: "mlb:pit:chc:2026-09-13",
  } as unknown as MatchedPair;
  const noBook: PmBook = {
    tokenId: "222",
    asks: [
      { priceMilli: 300, sizeMilli: 200_000 },
      { priceMilli: 320, sizeMilli: 500_000 },
    ],
    bids: [],
    minOrderSizeShares: 5,
    tickMilli: 10,
  };
  const q = quoteCrossWrap({ pair, markCents: 62, entryCents: 41, contracts: 150, now: NOW, noBook, config: DEFAULT_CROSS_CONFIG });
  assert.ok(q.ok, JSON.stringify(q));
  assert.equal(q.tier, "balanced");
  // tight is the legacy hand-computed collar (59/65, credit 918); it is still there under its name
  assert.equal(q.tiers.tight?.floorCents, 59);
  assert.equal(q.tiers.tight?.capCents, 65);
  assert.equal(q.tiers.tight?.creditCents, 918);
  assert.equal(q.tiers.tight?.takeRule, "share"); // 102c share > 38c minimum
  // wide is the lowest floor on the grid (62-30 = 32) with the highest cap funded there
  assert.equal(q.tiers.wide?.floorCents, 32);
  assert.ok((q.tiers.wide?.capCents ?? 0) > (q.tiers.tight?.capCents ?? 0));
  // balanced floor is the grid floor nearest the midpoint of 59 and 32 (45.5 -> 47, toward protection)
  assert.equal(q.tiers.balanced?.floorCents, 47);
  assert.equal(q.floorCents, 47);
  assert.equal(q.hedge.venue, "polymarket");
});
