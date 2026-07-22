import assert from "node:assert/strict";
import test from "node:test";
import type { SettlementOutcome } from "../src/singleSide/twoSided/creditCollar/forwardSettlement";
import { buildFoxifyView, perpPnlUsdc } from "../src/singleSide/twoSided/creditCollar/foxifyPerpView";

const NOW = 1_800_000_000_000;
const ENTRY = 100_000;

const outcome = (over: Partial<SettlementOutcome> = {}): SettlementOutcome => ({
  ref: "p",
  side: "long",
  notionalUsdc: 50_000,
  spotAtEntry: ENTRY,
  settlePriceUsd: ENTRY,
  movePct: 0,
  putIntrinsicUsd: 0,
  callIntrinsicUsd: 0,
  payoutToFoxifyUsdc: 0,
  foxifyCreditUsdc: 147,
  netToFoxifyUsdc: 147,
  serviceFeeUsdc: 60,
  floorBreached: false,
  capBreached: false,
  oracleVerified: true,
  openedAtMs: NOW - 24 * 3_600_000,
  settledAtMs: NOW,
  heldMs: 24 * 3_600_000,
  hedgeReceiptUsdc: 0,
  atticusOptionNetUsdc: 0,
  shortLegMarginUsdc: 0,
  capitalCostUsdc: 0,
  optionFeesUsdc: 0,
  atticusNetAfterCapitalUsdc: 60,
  atticusNetAfterFeesAndCapitalUsdc: 60,
  ...over
});

test("perp P&L is signed by side: long gains on up-move, short gains on down-move", () => {
  const up = { settlePriceUsd: 101_000, movePct: 0.01 };
  // +1% on $50k = +$500 for the long, −$500 for the short
  assert.equal(perpPnlUsdc(outcome({ side: "long", ...up })), 500);
  assert.equal(perpPnlUsdc(outcome({ side: "short", ...up })), -500);
});

test("matched long+short on the same move nets ~flat on the perps", () => {
  // A balanced batch: equal long/short notional, same entry, same settle.
  const settlePriceUsd = 103_500; // +3.5% move
  const movePct = 0.035;
  const view = buildFoxifyView(
    [
      outcome({ ref: "L1", side: "long", settlePriceUsd, movePct }),
      outcome({ ref: "S1", side: "short", settlePriceUsd, movePct }),
      outcome({ ref: "L2", side: "long", settlePriceUsd, movePct }),
      outcome({ ref: "S2", side: "short", settlePriceUsd, movePct })
    ],
    { perpFeeUsdc: 80 }
  );

  assert.equal(view.settledPositions, 4);
  // Longs made money, shorts lost the same → net perp P&L is flat.
  assert.ok(view.longPerpPnlUsdc > 0, "longs gained on the up-move");
  assert.ok(view.shortPerpPnlUsdc < 0, "shorts lost on the up-move");
  assert.ok(Math.abs(view.netPerpPnlUsdc) < 1e-6, `net perp P&L should be ~0, got ${view.netPerpPnlUsdc}`);
  assert.ok(view.grossPerpPnlUsdc > 0, "gross movement is non-zero even when net is flat");
});

test("credit-covers-fees: $147 credit clears an assumed $80 perp fee with room to spare", () => {
  const view = buildFoxifyView(
    [outcome({ side: "long", foxifyCreditUsdc: 147 }), outcome({ side: "short", foxifyCreditUsdc: 147 })],
    { perpFeeUsdc: 80 }
  );
  assert.equal(view.totalCreditUsdc, 294);
  assert.equal(view.totalAssumedFeesUsdc, 160);
  assert.equal(view.creditMinusFeesUsdc, 134);
  assert.equal(view.creditCoversFees, true);
  assert.ok(view.creditCoverageRatio > 1.8 && view.creditCoverageRatio < 1.85);
});

test("Foxify all-in net = perp P&L + collar payout + credit − fee, and recent pairs are populated", () => {
  const settlePriceUsd = 98_000; // −2% move
  const movePct = -0.02;
  const view = buildFoxifyView(
    [
      outcome({ ref: "L1", side: "long", settlePriceUsd, movePct, payoutToFoxifyUsdc: 250, foxifyCreditUsdc: 147 }),
      outcome({ ref: "S1", side: "short", settlePriceUsd, movePct, payoutToFoxifyUsdc: -100, foxifyCreditUsdc: 147 })
    ],
    { perpFeeUsdc: 80 }
  );

  // long: −$1000 perp + $250 collar + $147 credit − $80 fee = −$683
  // short: +$1000 perp − $100 collar + $147 credit − $80 fee = +$967
  const allIn = view.recentPairs.reduce((s, p) => s + (p.long?.foxifyNetUsdc ?? 0) + (p.short?.foxifyNetUsdc ?? 0), 0);
  assert.ok(Math.abs(view.foxifyAllInNetUsdc - allIn) < 1e-6);
  assert.equal(view.recentPairs.length, 1);
  assert.equal(view.recentPairs[0].long?.ref, "L1");
  assert.equal(view.recentPairs[0].short?.ref, "S1");
  assert.equal(view.recentPairs[0].matched, true, "same-cycle long+short is a matched pair");
});

test("legs opened hours apart are directional SINGLES, not a pseudo-pair", () => {
  const view = buildFoxifyView([
    outcome({ ref: "S-early", side: "short", openedAtMs: NOW - 38 * 3_600_000, settledAtMs: NOW - 14 * 3_600_000 }),
    outcome({ ref: "L-late", side: "long", openedAtMs: NOW - 24 * 3_600_000, settledAtMs: NOW })
  ]);
  assert.equal(view.recentPairs.length, 2, "two singles, no grouping");
  for (const g of view.recentPairs) {
    assert.equal(g.matched, false);
    assert.ok((g.long == null) !== (g.short == null), "exactly one leg per single");
  }
  // Most recent settle first.
  assert.equal(view.recentPairs[0].long?.ref, "L-late");
  assert.equal(view.recentPairs[1].short?.ref, "S-early");
  // A single's group net is just that leg's net.
  assert.equal(view.recentPairs[0].pairNetUsdc, view.recentPairs[0].long?.foxifyNetUsdc);
});

test("mixed book: the atomic pair matches, the lone directional stays single", () => {
  const view = buildFoxifyView([
    outcome({ ref: "L1", side: "long" }),
    outcome({ ref: "S1", side: "short" }), // same default openedAtMs as L1 ⟹ matched
    outcome({ ref: "S-solo", side: "short", openedAtMs: NOW - 40 * 3_600_000, settledAtMs: NOW - 16 * 3_600_000 })
  ]);
  assert.equal(view.recentPairs.length, 2);
  const pair = view.recentPairs.find((g) => g.matched);
  const single = view.recentPairs.find((g) => !g.matched);
  assert.ok(pair && pair.long?.ref === "L1" && pair.short?.ref === "S1");
  assert.ok(single && single.long == null && single.short?.ref === "S-solo");
});

test("empty ledger is safe (zeros, no division by notional)", () => {
  const view = buildFoxifyView([]);
  assert.equal(view.settledPositions, 0);
  assert.equal(view.netPerpPnlBps, 0);
  assert.equal(view.creditCoverageRatio, 0);
  assert.equal(view.recentPairs.length, 0);
  assert.equal(view.netFundingUsdc, 0);
  assert.equal(view.venues.length, 0);
});

test("default venues label legs without changing the numbers (oracle-mirror baseline)", () => {
  const settlePriceUsd = 102_000;
  const movePct = 0.02;
  const view = buildFoxifyView([
    outcome({ ref: "L1", side: "long", settlePriceUsd, movePct }),
    outcome({ ref: "S1", side: "short", settlePriceUsd, movePct })
  ]);
  // No funding/basis configured ⟹ funding 0 and perp P&L is still the exact mirror.
  assert.equal(view.netFundingUsdc, 0);
  assert.ok(Math.abs(view.netPerpPnlUsdc) < 1e-6);
  // Legs land on different venues (the two perps on different exchanges).
  const long = view.recentPairs[0].long!;
  const short = view.recentPairs[0].short!;
  assert.ok(long.venue.length > 0 && short.venue.length > 0);
  assert.notEqual(long.venue, short.venue);
  assert.ok(view.venues.length >= 1);
});

test("funding carry is signed: +rate ⟹ long pays, short receives; held 24h = 3 periods", () => {
  // 10 bps/8h on $50k over 24h (3 periods) = $50k * 0.001 * 3 = $150 per leg.
  const venues = [{ name: "A", fundingBpsPer8h: 10 }];
  const view = buildFoxifyView(
    [outcome({ side: "long" }), outcome({ side: "short" })],
    { venues }
  );
  const long = view.recentPairs[0].long!;
  const short = view.recentPairs[0].short!;
  assert.equal(long.fundingUsdc, -150); // long pays
  assert.equal(short.fundingUsdc, 150); // short receives
  // Same venue+rate ⟹ funding nets out; a real spread needs different per-venue rates.
  assert.equal(view.netFundingUsdc, 0);
});

test("a per-venue funding SPREAD leaves a real residual carry (the delta-neutral book's P&L)", () => {
  // Long venue earns less than the short venue pays out ⟹ net positive carry to the book.
  const venues = [
    { name: "Cheap", fundingBpsPer8h: 2 },  // long #0 lands here → pays $30
    { name: "Rich", fundingBpsPer8h: 10 }   // short #0 lands here (round-robin +1) → receives $150
  ];
  const view = buildFoxifyView([outcome({ side: "long" }), outcome({ side: "short" })], { venues });
  assert.ok(view.netFundingUsdc > 0, `expected positive funding spread, got ${view.netFundingUsdc}`);
});

test("a non-zero mark basis breaks the exact-zero perp mirror", () => {
  // Give the venues different entry/exit basis so the two legs no longer price identically.
  const venues = [
    { name: "A", entryBasisBps: 5, exitBasisBps: -3 },
    { name: "B", entryBasisBps: -4, exitBasisBps: 6 }
  ];
  const settlePriceUsd = 101_000;
  const movePct = 0.01;
  const view = buildFoxifyView(
    [outcome({ ref: "L1", side: "long", settlePriceUsd, movePct }), outcome({ ref: "S1", side: "short", settlePriceUsd, movePct })],
    { venues }
  );
  assert.ok(Math.abs(view.netPerpPnlUsdc) > 1e-6, `basis should create a residual, got ${view.netPerpPnlUsdc}`);
});
