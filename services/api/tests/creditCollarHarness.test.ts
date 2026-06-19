import assert from "node:assert/strict";
import test from "node:test";
import { bsPut, bsCall } from "../scripts/backtest/singleSide/coreEngine";
import {
  buildDataset,
  capturePerpImpact,
  listsDailyOption,
  type OptionQuote,
  type VenueOptionSnapshot,
  type VenuePerpSnapshot,
  type WingCaptureConfig
} from "../src/singleSide/twoSided/creditCollar/pricingHarness/capture";
import { recommendRouting } from "../src/singleSide/twoSided/creditCollar/pricingHarness/routing";
import { parseBullishBtcOptionMarkets, normalizeBullishLevels } from "../src/singleSide/twoSided/creditCollar/pricingHarness/liveFetchers";
import { runPricingReport, type HarnessReportConfig } from "../src/singleSide/twoSided/creditCollar/pricingHarness/report";

const SPOT = 100_000;
const NOW = 1_700_000_000_000;
const DAILY_EXP = NOW + 24 * 3_600_000;
const RFR = 0.045;

// Self-consistent option fixture: BS mids under a downside skew, ±halfSpread for bid/ask.
const mkOptions = (halfSpreadPct: number): OptionQuote[] => {
  const T = 1 / 365;
  const out: OptionQuote[] = [];
  for (let k = 0.94; k <= 1.06 + 1e-9; k += 0.005) {
    const strike = Math.round((SPOT * k) / 500) * 500;
    const moneyness = (SPOT - strike) / SPOT; // >0 below spot
    const iv = Math.max(0.2, 0.5 + 1.2 * moneyness); // downside skew: lower strikes richer
    for (const optType of ["put", "call"] as const) {
      const mid = optType === "put" ? bsPut(SPOT, strike, T, RFR, iv) : bsCall(SPOT, strike, T, RFR, iv);
      if (mid <= 0) continue;
      out.push({
        strike,
        optType,
        expiryMs: DAILY_EXP,
        bidUsdcPerBtc: mid * (1 - halfSpreadPct),
        askUsdcPerBtc: mid * (1 + halfSpreadPct)
      });
    }
  }
  return out;
};

const mkPerp = (venue: "bullish" | "deribit" | "okx", spreadBps: number, levelSizeUsd: number): VenuePerpSnapshot => {
  const mid = SPOT;
  const half = (mid * spreadBps) / 1e4 / 2;
  const bids = Array.from({ length: 40 }, (_, i) => ({ priceUsd: mid - half - i * 5, sizeUsd: levelSizeUsd }));
  const asks = Array.from({ length: 40 }, (_, i) => ({ priceUsd: mid + half + i * 5, sizeUsd: levelSizeUsd }));
  return { venue, spot: mid, nowMs: NOW, bids, asks };
};

const optionSnap = (venue: "bullish" | "deribit" | "okx", halfSpreadPct: number): VenueOptionSnapshot => ({
  venue,
  spot: SPOT,
  nowMs: NOW,
  options: mkOptions(halfSpreadPct)
});

const wingCfg: WingCaptureConfig = { floorPcts: [0.03, 0.04, 0.05], capPcts: [0.01, 0.015, 0.02, 0.025], tenorsDays: [1, 2, 7], dailyMaxHours: 30 };
const clips = [11_000, 110_000, 550_000, 2_750_000, 5_500_000];

const reportCfg = (feeUsdc: number | null): HarnessReportConfig => ({
  positionNotionalUsdc: 50_000,
  feeUsdc,
  serviceFeeBps: 2,
  minServiceFeeUsdc: 10,
  tenorDays: 1,
  maxFloorPct: 0.04,
  rampTiersDailyUsd: [100_000, 1_000_000, 5_000_000, 25_000_000, 50_000_000],
  peakResidualPct: 0.11,
  reserveMultiple: 1.5,
  costOfCapitalAnnual: 0.12,
  stressJumpPct: 0.12,
  intradayTimingBufferPct: 0.25,
  routing: { bullishWeight: 0.15, materialMarginPct: 0.2 }
});

test("capture: daily-listing detection + wing spreads per tenor", () => {
  const snap = optionSnap("deribit", 0.08);
  assert.equal(listsDailyOption(snap, 30), true);
  const ds = buildDataset([snap], [mkPerp("deribit", 1.0, 500_000)], wingCfg, clips);
  assert.ok(ds.options.some((r) => r.wing === "floor_put" && r.tenorDays <= 1.2));
  assert.ok(ds.options.some((r) => r.wing === "cap_call"));
  assert.equal(ds.dailyListing.deribit, true);
});

test("capture: perp impact grows with clip and is larger into thinner depth", () => {
  const deep = capturePerpImpact(mkPerp("deribit", 1.0, 1_000_000), [110_000, 5_500_000]);
  const thin = capturePerpImpact(mkPerp("deribit", 1.0, 100_000), [110_000, 5_500_000]);
  const bigDeep = deep.find((r) => r.clipUsd === 5_500_000 && r.side === "buy")!;
  const smallDeep = deep.find((r) => r.clipUsd === 110_000 && r.side === "buy")!;
  assert.ok((bigDeep.impactBps as number) >= (smallDeep.impactBps as number), "bigger clip ⟹ more impact");
  const bigThin = thin.find((r) => r.clipUsd === 5_500_000 && r.side === "buy")!;
  assert.ok((bigThin.impactBps as number) > (bigDeep.impactBps as number), "thinner depth ⟹ more impact at the same clip");
});

test("report: fee parameterized ⟹ credit not computed, blocker raised", () => {
  const ds = buildDataset([optionSnap("deribit", 0.08)], [mkPerp("deribit", 1.0, 1_000_000)], wingCfg, clips);
  const rep = runPricingReport(ds, reportCfg(null));
  assert.equal(rep.feeParameterized, true);
  assert.equal(rep.creditQuote.ok, false);
  assert.ok(rep.blockers.some((b) => /fee not confirmed/i.test(b)));
  assert.equal(rep.greenlightTier1, false);
});

test("report: with $75 fee on real captured spreads ⟹ credit feasible, service fee survives, routing chosen", () => {
  const ds = buildDataset(
    [optionSnap("deribit", 0.08), optionSnap("okx", 0.1), optionSnap("bullish", 0.06)],
    [mkPerp("deribit", 1.0, 1_000_000), mkPerp("okx", 1.5, 800_000), mkPerp("bullish", 1.2, 1_200_000)],
    wingCfg,
    clips
  );
  const rep = runPricingReport(ds, reportCfg(75));
  assert.equal(rep.feeParameterized, false);
  assert.equal(rep.skewOk, true);
  assert.equal(rep.creditQuote.ok, true);
  if (rep.creditQuote.ok && "feasible" in rep.creditQuote) {
    assert.equal(rep.creditQuote.feasible, true);
    assert.ok(rep.creditQuote.crossingDrag > 0, "touch fills ⟹ positive crossing drag");
  }
  assert.ok(rep.serviceFeeSurvives.length === 5);
  assert.ok(rep.serviceFeeSurvives.every((t) => t.verdict !== "ERROR"));
  // routing picks a venue per leg; Bullish has the tightest fixture spread so it should win at least one leg.
  assert.ok(rep.routing.every((r) => r.chosenVenue != null));
  assert.ok(rep.routing.some((r) => r.chosenVenue === "bullish"));
});

test("bullish parser: keeps BTC OPTION markets, parses strike/type/expiry, drops spot pairs", () => {
  const recs = [
    { symbol: "AAVEAUSD", marketType: "SPOT", baseSymbol: "AAVE" } as any,
    { symbol: "BTCUSDC", marketType: "SPOT", underlyingBaseSymbol: "BTC" } as any,
    { symbol: "BTC-20JUN26-60000-P", marketType: "OPTION", optionType: "PUT", optionStrikePrice: "60000", expiryDatetime: "2026-06-20T08:00:00Z", underlyingBaseSymbol: "BTC", marketEnabled: true },
    { symbol: "BTC-20JUN26-65000-C", marketType: "OPTION", optionType: "CALL", optionStrikePrice: "65000", expiryDatetime: "2026-06-20T08:00:00Z", underlyingBaseSymbol: "BTC", marketEnabled: true },
    { symbol: "ETH-20JUN26-3000-C", marketType: "OPTION", optionType: "CALL", optionStrikePrice: "3000", expiryDatetime: "2026-06-20T08:00:00Z", underlyingBaseSymbol: "ETH", marketEnabled: true },
    { symbol: "BTC-DISABLED", marketType: "OPTION", optionType: "PUT", optionStrikePrice: "50000", expiryDatetime: "2026-06-20T08:00:00Z", underlyingBaseSymbol: "BTC", marketEnabled: false }
  ];
  const opts = parseBullishBtcOptionMarkets(recs);
  assert.equal(opts.length, 2, "only the 2 enabled BTC options");
  assert.ok(opts.some((o) => o.optType === "put" && o.strike === 60000));
  assert.ok(opts.some((o) => o.optType === "call" && o.strike === 65000));
  assert.ok(opts.every((o) => Number.isFinite(o.expiryMs)));
});

test("bullish orderbook normalizer handles object and flat array forms", () => {
  const objForm = normalizeBullishLevels([{ price: "100", quantity: "2" }, { price: "99", quantity: "1" }]);
  assert.equal(objForm.length, 2);
  assert.equal(objForm[0].price, 100);
  const flatForm = normalizeBullishLevels(["100", "2", "99", "1"]);
  assert.equal(flatForm.length, 2);
  assert.equal(flatForm[1].quantity, 1);
  // Bullish's real field name is priceLevelQuantity.
  const bullishForm = normalizeBullishLevels([{ price: "40.0000", priceLevelQuantity: "15.5349", type: "ask" }]);
  assert.equal(bullishForm.length, 1);
  assert.equal(bullishForm[0].price, 40);
  assert.equal(bullishForm[0].quantity, 15.5349);
  assert.equal(normalizeBullishLevels([]).length, 0);
});

test("routing: materially cheaper non-Bullish venue wins; otherwise Bullish kept", () => {
  // Bullish wide, Deribit tight ⟹ Deribit should win on materiality.
  const ds = buildDataset(
    [optionSnap("bullish", 0.2), optionSnap("deribit", 0.03)],
    [mkPerp("deribit", 1.0, 1_000_000)],
    wingCfg,
    clips
  );
  const routing = recommendRouting(ds.options, 1, { bullishWeight: 0.15, materialMarginPct: 0.2 });
  assert.ok(routing.every((r) => r.chosenVenue === "deribit"), "deribit materially cheaper ⟹ routed there despite Bullish weight");
});
