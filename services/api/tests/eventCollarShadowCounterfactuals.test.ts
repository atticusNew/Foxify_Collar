/**
 * Shadow v2 — counterfactuals recorded next to the live quote, folded into
 * rule books at settlement, exported in the CSV.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FEE_RULE_LABELS,
  SIZE_LADDER_MULTS,
  counterfactualsFor,
  type CounterfactualInputs,
} from "../src/eventCollar/crossVenue/shadowCounterfactuals";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { quoteCrossWrap } from "../src/eventCollar/crossVenue/crossVenuePricer";
import { DEFAULT_CROSS_CONFIG, PROTECTION_TIERS, type MatchedPair, type PmBook } from "../src/eventCollar/crossVenue/types";
import {
  POSITIONS_CSV_COLUMNS,
  altOutcome,
  appendShadowRecord,
  loadShadowPositions,
  positionsCsv,
  summarizeCounterfactuals,
  summarizeShadow,
  writerPayouts,
  type ShadowOpenRecord,
} from "../src/eventCollar/crossVenue/shadowLedger";
import { renderShadowReportHtml } from "../scripts/eventShadowHtml";

const LOCK = "2026-09-20T17:00:00.000Z";
const NOW = new Date("2026-09-20T11:00:00.000Z");
/** deep enough for 5x (750 contracts -> ~640 No), too thin for 20x */
const NO_ASKS: NoAskLevel[] = [
  { priceCents: 41, qtyMilli: 300_000 },
  { priceCents: 42, qtyMilli: 400_000 },
  { priceCents: 43, qtyMilli: 400_000 },
];

/** The live rule under test: tight as default so the minimum fee binds (gross 106c -> share 10c < 38c). */
const CFG = { ...DEFAULT_CROSS_CONFIG, floorOffsetsCents: [3, 5, 8, 10, 12, 15, 20, 25, 30], capOffsetsCents: [3, 4, 5, 6, 8, 10, 12, 15, 20, 25], defaultTier: "tight" as const };

function liveQuote(contracts = 150) {
  const q = quoteLadderWrap({
    pair: { kalshi: { ticker: "KXMLBGAME-26SEP20NYYBOS-NYY" }, gameStartTime: LOCK },
    markCents: 60,
    entryCents: 55,
    contracts,
    now: NOW,
    noAsks: NO_ASKS,
    config: CFG,
  });
  assert.ok(q.ok, JSON.stringify(q));
  return q;
}

function inputs(overrides: Partial<CounterfactualInputs> = {}): CounterfactualInputs {
  return {
    route: "kalshi_self",
    ticker: "KXMLBGAME-26SEP20NYYBOS-NYY",
    lockTimeIso: LOCK,
    pair: null,
    markCents: 60,
    entryCents: 55,
    contracts: 150,
    now: NOW,
    config: CFG,
    books: { noAsks: NO_ASKS },
    ...overrides,
  };
}

test("counterfactualsFor: tiers come from the live search; fee rules and sizes are re-priced on the same books", () => {
  const live = liveQuote();
  const cf = counterfactualsFor(inputs(), live);

  // every distinct tier, identical to the live quote's own tiers
  for (const tier of PROTECTION_TIERS) {
    const alt = cf.alternatives[tier];
    const t = live.tiers[tier];
    assert.ok(alt && t && alt.ok);
    assert.equal(alt.floorCents, t.floorCents);
    assert.equal(alt.creditCents, t.creditCents);
    assert.equal(alt.hedgeUnitsMilli, t.hedge.venue === "kalshi" ? t.hedge.contractsMilli : -1);
  }

  // fee rules on the SAME collar: share-only charges the 10% share (10c of 106c gross);
  // min_25bps charges the 38c minimum on $150. Hedge, floor and cap are untouched.
  const share = cf.feeRules.share_only;
  const min25 = cf.feeRules.min_25bps;
  assert.ok(share.ok && min25.ok);
  assert.equal(live.grossCreditCents, 106);
  for (const alt of [share, min25]) {
    assert.equal(alt.floorCents, live.floorCents);
    assert.equal(alt.capCents, live.capCents);
    assert.equal(alt.grossCreditCents, live.grossCreditCents);
    assert.equal(alt.hedgeCostCents, live.hedge.costCents + live.feesCents, "fees included");
  }
  assert.deepEqual([share.takeCents, share.takeRule, share.creditCents], [10, "share", 96]);
  assert.deepEqual([min25.takeCents, min25.takeRule, min25.creditCents], [38, "minimum", 68]);
  assert.ok(share.evCostBps < min25.evCostBps, "a smaller take is a cheaper protection");
  // the live config IS min_25bps, so that rule reproduces the live terms exactly
  assert.equal(min25.creditCents, live.creditCents);
  assert.equal(min25.takeCents, live.takeCents);

  // size ladder: 1x is the live quote; 5x quotes deeper in the book; 20x exceeds visible depth
  assert.deepEqual(cf.sizeLadder.map((s) => s.mult), [...SIZE_LADDER_MULTS]);
  const x1 = cf.sizeLadder[0];
  assert.ok(x1.terms.ok && x1.terms.creditCents === live.creditCents);
  const x5 = cf.sizeLadder.find((s) => s.mult === 5);
  assert.ok(x5 && x5.contracts === 750 && x5.terms.ok, JSON.stringify(x5));
  // more contracts, more gross in dollars; but the walk pays up the book so gross per $ of stake falls
  assert.ok(x5.terms.grossCreditCents > (x1.terms.ok ? x1.terms.grossCreditCents : 0));
  const grossBps = (g: number, n: number) => (g / (100 * n)) * 10_000;
  assert.ok(grossBps(x5.terms.grossCreditCents, 750) < grossBps(x1.terms.ok ? x1.terms.grossCreditCents : 0, 150));
  const x20 = cf.sizeLadder.find((s) => s.mult === 20);
  assert.ok(x20 && !x20.terms.ok);
  if (x20 && !x20.terms.ok) assert.equal(x20.terms.refused, "kalshi_book_too_thin");
});

test("counterfactualsFor: a route whose book was not retained is marked, never guessed", () => {
  const live = liveQuote();
  const cf = counterfactualsFor(inputs({ books: {} }), live);
  // fee rules need no book (same collar, take recomputed) so they are always available
  for (const label of FEE_RULE_LABELS) assert.ok(cf.feeRules[label].ok);
  assert.ok(cf.sizeLadder[0].terms.ok, "1x never needs a re-price");
  for (const probe of cf.sizeLadder.slice(1)) {
    assert.ok(!probe.terms.ok && probe.terms.refused === "book_not_retained");
  }
  // the polymarket route needs the pair as well as the book
  const cf2 = counterfactualsFor(inputs({ route: "polymarket", books: { noAsks: NO_ASKS } }), live);
  assert.ok(!cf2.sizeLadder[1].terms.ok);
  // a fee that would eat the whole gross is a refusal, not a negative credit
  const tiny = counterfactualsFor(inputs({ contracts: 150 }), { ...live, grossCreditCents: 30, creditCents: 27, takeCents: 3 });
  assert.ok(!tiny.feeRules.min_25bps.ok && tiny.feeRules.min_25bps.refused === "fee_exceeds_gross");
  assert.ok(tiny.feeRules.share_only.ok);
});

test("altOutcome: every alternative nets the writer its own take, whichever way the event settles", () => {
  const live = liveQuote();
  const cf = counterfactualsFor(inputs(), live);
  for (const tier of PROTECTION_TIERS) {
    const alt = cf.alternatives[tier];
    assert.ok(alt && alt.ok);
    const yes = altOutcome(alt, 150, "yes");
    const no = altOutcome(alt, 150, "no");
    assert.ok(yes && no);
    // leg-for-leg: writer P&L on YES equals the take exactly; on NO it is the take plus hedge round-up
    assert.equal(yes.writerCents, alt.takeCents, `${tier}: YES nets the take`);
    assert.ok(no.writerCents >= alt.takeCents, `${tier}: NO nets at least the take`);
    // and the holder's delta is what settlePayouts says for those terms
    assert.equal(yes.deltaCents, alt.capCents * 150 + alt.creditCents - 15_000);
    assert.equal(no.deltaCents, alt.floorCents * 150 + alt.creditCents);
    // consistent with the writerPayouts primitive used by the live book
    const wp = writerPayouts(
      { contracts: 150, floorCents: alt.floorCents, capCents: alt.capCents, creditCents: alt.creditCents, takeCents: alt.takeCents, hedgeCostCents: alt.hedgeCostCents, hedgeUnitsMilli: alt.hedgeUnitsMilli },
      "no",
    );
    assert.equal(no.writerCents, wp.writerCents);
  }
  assert.equal(altOutcome({ ok: false, refused: "x" }, 150, "yes"), null);
});

/** A verified MLB pair whose Polymarket No book is cheaper than the Kalshi ladder above. */
function pmPair(): MatchedPair {
  return {
    league: "mlb",
    kalshi: {
      ticker: "KXMLBGAME-26SEP20NYYBOS-NYY",
      eventTicker: "KXMLBGAME-26SEP20NYYBOS",
      title: "Yankees win",
      subtitle: "Yankees",
      strike: 0,
      strikeType: "",
      status: "active",
      openTime: "",
      closeTime: LOCK,
      yesBidCents: 59,
      yesAskCents: 61,
      lastPriceCents: 60,
      volume: 1000,
      openInterest: 500,
      rulesPrimary: "",
    },
    pm: {
      eventSlug: "mlb-nyy-bos-2026-09-20",
      eventTitle: "New York Yankees vs. Boston Red Sox",
      question: "New York Yankees vs. Boston Red Sox",
      conditionId: "0xdef",
      outcomes: ["New York Yankees", "Boston Red Sox"],
      tokenIds: ["111", "222"],
      outcomePricesMilli: [600, 400],
      gameStartTime: LOCK,
      endDate: "2026-09-27T17:00:00Z",
      sportsMarketType: "moneyline",
      active: true,
      closed: false,
      acceptingOrders: true,
      negRisk: false,
      orderMinSizeShares: 5,
      liquidityUsd: 9000,
      volumeUsd: 100,
    },
    pmYesOutcomeIndex: 0,
    pmNoOutcomeIndex: 1,
    gameStartTime: LOCK,
    parityNote: "both venues settle on the official MLB final result for this game",
    fingerprint: "mlb:NYY:BOS:2026-09-20",
  };
}
const PM_NO_BOOK: PmBook = {
  tokenId: "222",
  asks: [
    { priceMilli: 380, sizeMilli: 300_000 },
    { priceMilli: 390, sizeMilli: 500_000 },
  ],
  bids: [{ priceMilli: 370, sizeMilli: 200_000 }],
  minOrderSizeShares: 5,
  tickMilli: 10,
};

test("counterfactualsFor: both hedge routes are recorded from the same books; crypto has one route; summary measures kalshi-only", () => {
  // Sports, routed cross-venue because the second book is cheaper: the record keeps both quotes.
  const pmLive = quoteCrossWrap({ pair: pmPair(), markCents: 60, entryCents: 55, contracts: 150, now: NOW, noBook: PM_NO_BOOK, config: CFG });
  assert.ok(pmLive.ok, JSON.stringify(pmLive));
  const cf = counterfactualsFor(inputs({ route: "polymarket", pair: pmPair(), books: { pmNoBook: PM_NO_BOOK, noAsks: NO_ASKS } }), pmLive);
  assert.ok(cf.routes);
  const live = cf.routes.polymarket;
  const k = cf.routes.kalshi_self;
  assert.ok(live.ok && k.ok);
  assert.equal(live.creditCents, pmLive.creditCents, "the live route carries the live terms, not a re-price");
  const ladder = liveQuote();
  assert.equal(k.creditCents, ladder.creditCents, "the other route is the ladder quote on the retained Kalshi book");
  assert.ok(k.evCostBps > live.evCostBps, "on this book the market's own No side is the richer hedge");

  // Routed to Kalshi self with the pair and both books retained: the second book is re-priced.
  const cf2 = counterfactualsFor(inputs({ pair: pmPair(), books: { pmNoBook: PM_NO_BOOK, noAsks: NO_ASKS } }), ladder);
  assert.ok(cf2.routes?.kalshi_self.ok && cf2.routes.polymarket.ok);
  assert.equal(cf2.routes.kalshi_self.creditCents, ladder.creditCents);
  assert.equal(cf2.routes.polymarket.creditCents, pmLive.creditCents);

  // Second book not retained: marked, never guessed. No pair (a crypto strike): not offered.
  const cf3 = counterfactualsFor(inputs({ pair: pmPair(), books: { noAsks: NO_ASKS } }), ladder);
  assert.ok(!cf3.routes?.polymarket.ok && cf3.routes?.polymarket.refused === "book_not_retained");
  const cf4 = counterfactualsFor(inputs(), ladder);
  assert.ok(!cf4.routes?.polymarket.ok && cf4.routes?.polymarket.refused === "route_not_offered");

  // Summary: two sports positions both routes quoted (one settled NO), one sports position the
  // Kalshi side refused, one crypto strike (one route, left out), one legacy record without routes.
  const dir = mkdtempSync(join(tmpdir(), "shadow-routes-"));
  const path = join(dir, "ledger.jsonl");
  const open = (ticker: string, at: string, q: typeof pmLive, route: "polymarket" | "kalshi_self", extra: Partial<ShadowOpenRecord> = {}): ShadowOpenRecord => ({
    type: "open",
    at,
    ticker,
    kind: "sports",
    league: "mlb",
    sideName: "Yankees",
    eventTitle: "Yankees to win",
    eventTimeIso: LOCK,
    contracts: 150,
    markCents: 60,
    floorCents: q.floorCents,
    capCents: q.capCents,
    creditCents: q.creditCents,
    evCostBps: q.evCostBps,
    route,
    feesCents: q.feesCents,
    takeCents: q.takeCents,
    hedgeCostCents: q.hedge.costCents + q.feesCents,
    hedgeUnitsMilli: q.hedge.venue === "kalshi" ? q.hedge.contractsMilli : q.hedge.sharesMilli,
    tier: q.tier,
    takeRule: q.takeRule,
    takeShareCents: q.takeShareCents,
    takeMinimumCents: q.takeMinimumCents,
    counterfactuals: cf,
    ...extra,
  });
  appendShadowRecord(path, open("PM-SETTLED", "2026-09-20T11:00:00.000Z", pmLive, "polymarket"));
  appendShadowRecord(path, { type: "settle", at: "2026-09-20T21:00:00.000Z", ticker: "PM-SETTLED", result: "no" });
  appendShadowRecord(path, open("PM-OPEN", "2026-09-20T11:01:00.000Z", pmLive, "polymarket"));
  appendShadowRecord(path, open("PM-KREFUSED", "2026-09-20T11:02:00.000Z", pmLive, "polymarket", { counterfactuals: { ...cf, routes: { polymarket: cf.routes.polymarket, kalshi_self: { ok: false, refused: "kalshi_book_empty" } } } }));
  appendShadowRecord(path, open("CRYPTO", "2026-09-20T11:03:00.000Z", ladder, "kalshi_self", { kind: "crypto", league: "crypto", counterfactuals: cf4 }));
  const legacy = open("LEGACY", "2026-09-20T10:00:00.000Z", pmLive, "polymarket", { counterfactuals: { ...cf, routes: undefined } });
  appendShadowRecord(path, legacy);

  const positions = loadShadowPositions(path);
  const r = summarizeCounterfactuals(positions).routes;
  assert.equal(r.positions, 3, "three sports positions carry both routes; crypto and legacy are out");
  assert.equal(r.recordedSince, "2026-09-20T11:00:00.000Z");
  assert.deepEqual(r.liveRouteSplit, { polymarket: 3 });
  assert.equal(r.live.quoted, 3);
  assert.equal(r.live.settled, 1);
  assert.equal(r.live.creditsCents, 3 * pmLive.creditCents);
  assert.equal(r.kalshiOnly.quoted, 2);
  assert.equal(r.kalshiOnly.refused, 1);
  assert.equal(r.kalshiOnly.settled, 1, "the settled one was quoted on both, so kalshi-only is marked against the same result");
  assert.equal(r.kalshiOnly.creditsCents, 2 * ladder.creditCents);
  assert.equal(r.crossOnly.quoted, 3);
  assert.deepEqual({ ...r.crossOnly }, { ...r.live }, "cross-only equals the live book when every position routed cross-venue");
  assert.equal(r.bothQuoted, 2);
  assert.equal(r.kalshiOnlyRefusedWhereLiveQuoted, 1);
  assert.equal(r.kalshiOnlyExtraEvBps, Math.round(((k.evCostBps - live.evCostBps) * 2) / 2));
  assert.ok((r.kalshiOnlyExtraEvBps as number) > 0, "kalshi-only is richer here");
  assert.equal(r.kalshiOnlyCreditDeltaCents, 2 * (ladder.creditCents - pmLive.creditCents));
  assert.ok(r.kalshiOnlyCreditDeltaCents < 0, "users would have been paid less");
  // kalshi-only writer P&L on the settled position is the ladder's own take: the identity holds per route
  assert.equal(r.kalshiOnly.writerPnlCents, ladder.takeCents);

  // the operator report carries the card; the public summary does not carry routes
  const s = summarizeShadow(positions);
  const html = renderShadowReportHtml({ atIso: "2026-09-21T00:00:00.000Z", summary: s });
  assert.ok(html.includes("<h2>Routing, measured</h2>"));
  assert.ok(html.includes("kalshi only") && html.includes("second book only"));
  assert.ok(html.includes("3 sports positions since 2026-09-20 UTC"));
  assert.ok(html.includes("1 position the live route protected would have been refused kalshi-only"));
  const empty = renderShadowReportHtml({ atIso: "2026-09-21T00:00:00.000Z", summary: summarizeShadow([]) });
  assert.ok(empty.includes("No sports position has carried both routes yet"));
});

test("summarizeCounterfactuals: rule books fold quoted, refused and settled; legacy records are excluded", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-cf-"));
  const path = join(dir, "ledger.jsonl");
  const live = liveQuote();
  const cf = counterfactualsFor(inputs(), live);
  const base = (ticker: string, at: string): ShadowOpenRecord => ({
    type: "open",
    at,
    ticker,
    kind: "sports",
    league: "mlb",
    sideName: "Yankees",
    eventTitle: "Yankees to win",
    eventTimeIso: LOCK,
    contracts: 150,
    markCents: 60,
    floorCents: live.floorCents,
    capCents: live.capCents,
    creditCents: live.creditCents,
    evCostBps: live.evCostBps,
    route: "kalshi_self",
    feesCents: live.feesCents,
    takeCents: live.takeCents,
    hedgeCostCents: live.hedge.costCents,
    hedgeUnitsMilli: live.hedge.venue === "kalshi" ? live.hedge.contractsMilli : 0,
    tier: live.tier,
    takeRule: live.takeRule,
    takeShareCents: live.takeShareCents,
    takeMinimumCents: live.takeMinimumCents,
    counterfactuals: cf,
  });
  // a legacy record (no counterfactuals), one settled v2, one open v2, one voided v2
  const legacy = { ...base("LEGACY", "2026-09-10T00:00:00.000Z") };
  delete legacy.counterfactuals;
  delete legacy.tier;
  appendShadowRecord(path, legacy);
  appendShadowRecord(path, { type: "settle", at: "2026-09-11T00:00:00.000Z", ticker: "LEGACY", result: "yes" });
  appendShadowRecord(path, base("V2-SETTLED", "2026-09-20T11:00:00.000Z"));
  appendShadowRecord(path, { type: "settle", at: "2026-09-20T21:00:00.000Z", ticker: "V2-SETTLED", result: "no" });
  appendShadowRecord(path, base("V2-OPEN", "2026-09-20T11:05:00.000Z"));
  appendShadowRecord(path, base("V2-VOID", "2026-09-20T11:06:00.000Z"));
  appendShadowRecord(path, { type: "void", at: "2026-09-23T00:00:00.000Z", ticker: "V2-VOID", reason: "postponed" });

  const positions = loadShadowPositions(path);
  const s = summarizeCounterfactuals(positions);
  assert.equal(s.positionsWithCounterfactuals, 2, "legacy and voided are not in the comparison");
  assert.equal(s.recordedSince, "2026-09-20T11:00:00.000Z");

  // baseline = the live book on the same two positions
  assert.equal(s.baseline.quoted, 2);
  assert.equal(s.baseline.settled, 1);
  assert.equal(s.baseline.creditsCents, 2 * live.creditCents);
  assert.equal(s.baseline.takeCents, 2 * live.takeCents);
  assert.equal(s.baseline.stakeSettledCents, 15_000);
  const settledPos = positions.find((p) => p.ticker === "V2-SETTLED");
  assert.equal(s.baseline.holderDeltaCents, settledPos?.deltaCents);
  assert.equal(s.baseline.writerPnlCents, settledPos?.writerCents);

  // the live tier's book equals the baseline (same collar); other tiers differ
  const liveTierBook = s.tiers[live.tier];
  assert.deepEqual(liveTierBook, s.baseline);
  const tight = s.tiers.tight;
  const wide = s.tiers.wide;
  assert.equal(tight.quoted, 2);
  assert.equal(wide.quoted, 2);
  assert.ok(tight.creditsCents < wide.creditsCents, "wide pays the larger credit on this book");
  assert.ok((tight.quotedAvgEvBps as number) > (wide.quotedAvgEvBps as number), "tight costs more in EV");
  // holder lost (NO): the tighter floor paid more
  assert.ok(tight.holderDeltaCents > wide.holderDeltaCents);

  // fee rules: min_25bps reproduces the live take; share_only books less take and pays more credit
  assert.equal(s.feeRules.min_25bps.takeCents, 2 * live.takeCents);
  assert.ok(s.feeRules.share_only.takeCents < s.feeRules.min_25bps.takeCents);
  assert.equal(
    s.feeRules.share_only.creditsCents - s.feeRules.min_25bps.creditsCents,
    s.feeRules.min_25bps.takeCents - s.feeRules.share_only.takeCents,
  );
  assert.ok(s.feeRules.share_only.writerPnlCents < s.feeRules.min_25bps.writerPnlCents, "the writer keeps less under share-only");
  assert.equal(s.feeRules.min_25bps.writerPnlCents, s.baseline.writerPnlCents, "the live rule is min_25bps");

  // capacity: 1x and 5x quoted twice, 20x refused twice; gross bps of stake falls with size
  const x1 = s.capacity.find((c) => c.mult === 1);
  const x5 = s.capacity.find((c) => c.mult === 5);
  const x20 = s.capacity.find((c) => c.mult === 20);
  assert.ok(x1 && x5 && x20);
  assert.equal(x1.quoted, 2);
  assert.equal(x5.quoted, 2);
  assert.equal(x20.refused, 2);
  assert.equal(x20.quoted, 0);
  assert.equal(x20.grossBpsOfStake, null);
  assert.ok((x1.grossBpsOfStake as number) > (x5.grossBpsOfStake as number));

  // the full summary carries it, and the CSV has one cell per column on every row
  const full = summarizeShadow(positions);
  assert.equal(full.counterfactuals.positionsWithCounterfactuals, 2);
  const csv = positionsCsv(positions);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 1 + positions.length);
  const header = lines[0].split(",");
  assert.deepEqual(header, [...POSITIONS_CSV_COLUMNS]);
  for (const line of lines.slice(1)) {
    assert.equal(line.split(",").length, header.length, `row has ${line.split(",").length} cells`);
  }
  // legacy row: the v2 columns are blank; a v2 row: tier + the tiers' terms are present
  const legacyRow = lines.find((l) => l.startsWith("LEGACY,")) as string;
  const tierCol = header.indexOf("tier");
  assert.equal(legacyRow.split(",")[tierCol], "");
  const v2Row = lines.find((l) => l.startsWith("V2-SETTLED,")) as string;
  const cells = v2Row.split(",");
  assert.equal(cells[tierCol], live.tier);
  assert.equal(cells[header.indexOf("wide_floor_c")], String(live.tiers.wide?.floorCents));
  assert.equal(cells[header.indexOf("x20_refused")], "1");
  assert.equal(cells[header.indexOf("x5_refused")], "0");
  assert.equal(cells[header.indexOf("min_25bps_take_c")], "38");
  assert.equal(cells[header.indexOf("wide_writer_pnl_c")], String(altOutcome(cf.alternatives.wide!, 150, "no")?.writerCents));

  // the report page: every rule as a row, the live book marked as the base, plain-language rules
  const html = renderShadowReportHtml({ atIso: "2026-09-24T12:00:00.000Z", summary: full });
  assert.ok(html.includes("What each rule would have done"));
  assert.ok(html.includes("2026-09-20 to 2026-09-24 UTC"), "the recording period, first counterfactual to render time");
  assert.ok(html.includes('<tr class="base"><td>live book'), "the live book heads each comparison");
  for (const tier of PROTECTION_TIERS) assert.ok(html.includes(`<td>${tier} tier</td>`), `${tier} row present`);
  assert.ok(html.includes("<td>share only</td>"));
  assert.ok(html.includes("<td>share or 0.25% of stake</td>"));
  assert.ok(html.includes("<td>20× size</td>"));
  assert.ok(html.includes("the venues&#39; books did not fund a single collar") || html.includes("the venues' books did not fund a single collar"), "capacity line explains the 20x refusals");
  assert.ok(html.includes(`The minimum adds $${((s.feeRules.min_25bps.takeCents - s.feeRules.share_only.takeCents) / 100).toFixed(2)}`));
  assert.ok(html.includes('href="/api/shadow/report"'));
  assert.ok(html.includes("Our book, line by line") && html.includes("cap slices kept (user won)") && html.includes("hedge payouts minus hedge cost"), "the line-by-line book lives on the operator report");
  assert.ok(html.includes("<th>user Δ</th><th>our P&amp;L</th>") && !/writer P&amp;L|holder Δ/.test(html), "same words as the public page");
  assert.ok(!html.includes("undefined") && !html.includes("NaN"));

  // an empty book renders without a period and without dividing by zero
  const empty = renderShadowReportHtml({ atIso: "2026-09-24T12:00:00.000Z", summary: summarizeShadow([]) });
  assert.ok(empty.includes("not started"));
  assert.ok(!empty.includes("NaN") && !empty.includes("undefined"));
});
