import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hedgeAlignment,
  quoteWrap,
  settleWrap,
  walkBook,
  type PricerInputs,
} from "../src/eventCollar/eventCollarPricer";
import { DEFAULT_SEARCH_CONFIG, type WrapSearchConfig } from "../src/eventCollar/types";

const NOW = new Date("2026-09-11T12:00:00Z");
const RESOLUTION = new Date("2026-09-11T21:00:00Z");
const EXPIRY_TIME = new Date("2026-09-12T08:00:00Z");

function baseConfig(overrides: Partial<WrapSearchConfig> = {}): WrapSearchConfig {
  return { ...DEFAULT_SEARCH_CONFIG, feeCentsPerSpread: 10, unalignedHaircutBps: 0, ...overrides };
}

/**
 * Hand-computed fixture:
 *   index $80,000 · vertical 76,750/77,000 (width 250 => 250 digital cents/vertical)
 *   highPut ask 0.0030 BTC, lowPut bid 0.0025 BTC => debit 0.0005 BTC
 *   debit cents/vertical = ceil(0.0005 * 0.01 * 80000 * 100) = 40
 *   digital put P0 = 40/250 = 16% (160000 micro)
 */
function baseInputs(overrides: Partial<PricerInputs> = {}): PricerInputs {
  return {
    marketTicker: "KXBTCD-TEST-T76899.99",
    markCents: 62,
    entryCents: 41,
    contracts: 100,
    resolutionTime: RESOLUTION,
    now: NOW,
    indexPxUsd: 80_000,
    vertical: {
      highStrike: 77_000,
      lowStrike: 76_750,
      highPut: {
        instId: "BTC-USD-260912-77000-P",
        asks: [{ priceBtc: 0.003, sizeContracts: 1000 }],
        bids: [{ priceBtc: 0.0029, sizeContracts: 1000 }],
        ts: 1,
      },
      lowPut: {
        instId: "BTC-USD-260912-76750-P",
        asks: [{ priceBtc: 0.0026, sizeContracts: 1000 }],
        bids: [{ priceBtc: 0.0025, sizeContracts: 1000 }],
        ts: 1,
      },
    },
    hedgeExpiry: "260912",
    hedgeExpiryTime: EXPIRY_TIME,
    config: baseConfig(),
    ...overrides,
  };
}

test("walkBook averages across levels and fails on thin depth", () => {
  const levels = [
    { priceBtc: 0.001, sizeContracts: 5 },
    { priceBtc: 0.002, sizeContracts: 5 },
  ];
  const walked = walkBook(levels, 10);
  assert.ok(walked);
  assert.equal(walked.avgPriceBtc, 0.0015);
  assert.equal(walked.worstPriceBtc, 0.002);
  assert.equal(walkBook(levels, 11), null);
});

test("quoteWrap: exact integer credit math on the hand-computed fixture", () => {
  const result = quoteWrap(baseInputs());
  assert.ok(result.ok, JSON.stringify(result));
  // P0 = 16%: cheap floor => the engine protects the holder's gains: the
  // highest floor with a funded credit wins, then max credit at that floor.
  // floor 57 (mark-5), best cap at that floor:
  //   c=66: digitalNeeded=(57+34)*100=9100 => 37 verticals (ceil 9100/250)
  //   hedge = 37*40 + 37*10 = 1850; funding = 34*100 = 3400; gross = 1550
  //   take 10% = 155; credit = 1395
  assert.equal(result.floorCents, 57);
  assert.equal(result.capCents, 66);
  assert.equal(result.spreads, 37);
  assert.equal(result.grossCreditCents, 1550);
  assert.equal(result.takeCents, 155);
  assert.equal(result.takeWaived, false);
  assert.equal(result.creditCents, 1395);
  assert.equal(result.digitalPutMicro, 160_000);
  assert.equal(result.alignment, "unwind_at_resolution");
  assert.equal(result.feesCents, 370);
  assert.equal(result.legs[0].action, "buy");
  assert.equal(result.legs[0].instId, "BTC-USD-260912-77000-P");
  assert.equal(result.legs[0].contracts, 37);
  assert.equal(result.legs[1].action, "sell");
});

test("quoteWrap: floor at or above entry is preferred over raw credit", () => {
  // entry very low: every floor protects gains; engine picks the HIGHEST floor
  const result = quoteWrap(baseInputs({ entryCents: 20 }));
  assert.ok(result.ok);
  assert.equal(result.floorCents, 57);
  // entry above all floors: falls back to highest floor still (tie on protects-entry=0)
  const result2 = quoteWrap(baseInputs({ entryCents: 60 }));
  assert.ok(result2.ok);
  assert.equal(result2.floorCents, 57);
});

test("quoteWrap: verticals round UP so the floor is never under-hedged", () => {
  const result = quoteWrap(baseInputs());
  assert.ok(result.ok);
  const digitalNeeded = (result.floorCents + 100 - result.capCents) * result.contracts;
  assert.ok(result.spreads * result.verticalWidthUsd >= digitalNeeded);
  assert.ok((result.spreads - 1) * result.verticalWidthUsd < digitalNeeded);
});

test("quoteWrap: refuses when resolution is too near", () => {
  const result = quoteWrap(
    baseInputs({ now: new Date(RESOLUTION.getTime() - 5 * 60_000) }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "market_too_close_to_resolution");
});

test("quoteWrap: refuses out-of-band marks", () => {
  const low = quoteWrap(baseInputs({ markCents: 5 }));
  assert.equal(low.ok, false);
  if (!low.ok) assert.equal(low.code, "mark_out_of_range");
  const high = quoteWrap(baseInputs({ markCents: 96 }));
  assert.equal(high.ok, false);
  if (!high.ok) assert.equal(high.code, "mark_out_of_range");
});

test("quoteWrap: refuses on an empty book side", () => {
  const inputs = baseInputs();
  inputs.vertical.highPut = { ...inputs.vertical.highPut, asks: [] };
  const result = quoteWrap(inputs);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "okx_book_empty");
});

test("quoteWrap: refuses when depth cannot cover the hedge", () => {
  const inputs = baseInputs();
  inputs.vertical.highPut = {
    ...inputs.vertical.highPut,
    asks: [{ priceBtc: 0.003, sizeContracts: 2 }],
  };
  const result = quoteWrap(inputs);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "okx_book_too_thin");
});

test("quoteWrap: honest refusal with shortfall when books cannot fund a credit", () => {
  // expensive digital: debit 0.0028 BTC => ceil(224)/250 = 90% digital put
  const inputs = baseInputs();
  inputs.vertical.highPut = {
    ...inputs.vertical.highPut,
    asks: [{ priceBtc: 0.0053, sizeContracts: 1000 }],
  };
  inputs.vertical.lowPut = {
    ...inputs.vertical.lowPut,
    bids: [{ priceBtc: 0.0025, sizeContracts: 1000 }],
  };
  const result = quoteWrap(inputs);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "credit_nonpositive");
    assert.ok((result.bestShortfallCents ?? 0) > 0);
  }
});

test("quoteWrap: de minimis take is waived", () => {
  // 2 contracts: floor 57 / cap 66 needs 182 digital cents => 1 vertical (over-
  // hedged, cost 40+10=50) against funding 68 => gross 18, take 1 (< 5) waived.
  const result = quoteWrap(baseInputs({ contracts: 2, config: baseConfig({ deMinimisTakeCents: 5 }) }));
  assert.ok(result.ok, JSON.stringify(result));
  if (result.ok) {
    assert.equal(result.grossCreditCents, 18);
    assert.equal(result.takeWaived, true);
    assert.equal(result.takeCents, 0);
    assert.equal(result.creditCents, 18);
  }
});

test("quoteWrap: unaligned tenor applies the haircut to hedge cost", () => {
  const aligned = quoteWrap(
    baseInputs({
      resolutionTime: EXPIRY_TIME,
      config: baseConfig({ unalignedHaircutBps: 1000 }),
    }),
  );
  const unaligned = quoteWrap(baseInputs({ config: baseConfig({ unalignedHaircutBps: 1000 }) }));
  assert.ok(aligned.ok && unaligned.ok);
  if (aligned.ok && unaligned.ok) {
    assert.equal(aligned.alignment, "expiry_aligned");
    assert.equal(unaligned.alignment, "unwind_at_resolution");
    assert.ok(unaligned.creditCents < aligned.creditCents);
  }
});

test("hedgeAlignment tolerance", () => {
  assert.equal(hedgeAlignment(EXPIRY_TIME, EXPIRY_TIME, 30), "expiry_aligned");
  assert.equal(
    hedgeAlignment(new Date(EXPIRY_TIME.getTime() - 29 * 60_000), EXPIRY_TIME, 30),
    "expiry_aligned",
  );
  assert.equal(
    hedgeAlignment(new Date(EXPIRY_TIME.getTime() - 31 * 60_000), EXPIRY_TIME, 30),
    "unwind_at_resolution",
  );
});

test("settleWrap: both outcomes, exact totals", () => {
  const terms = { floorCents: 45, capCents: 80, creditCents: 300, contracts: 100 };
  const yes = settleWrap("yes", terms);
  assert.equal(yes.protectedPayoutCents, 80);
  assert.equal(yes.totalProtectedCents, 80 * 100 + 300);
  assert.equal(yes.totalNakedCents, 10_000);
  const no = settleWrap("no", terms);
  assert.equal(no.protectedPayoutCents, 45);
  assert.equal(no.totalProtectedCents, 45 * 100 + 300);
  assert.equal(no.totalNakedCents, 0);
});
