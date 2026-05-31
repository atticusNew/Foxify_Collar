/**
 * Tests for the unified optionPricing module — the single canonical
 * "what is this option worth" answer.
 *
 * Covers every cascade tier, IV resolution path, purpose-specific haircut
 * behavior, and edge cases (expired, zero bid, missing inputs).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  priceOption,
  priceStrangle,
  RISK_FREE_RATE,
  DEFAULT_BID_HAIRCUT,
  DEFAULT_BS_FALLBACK_HAIRCUT,
  NEUTRAL_IV_FALLBACK,
  type OptionPricingInputs
} from "../src/singleSide/twoSided/optionPricing";

const baseInputs: OptionPricingInputs = {
  spot: 73950,
  strike: 73000,
  optType: "put",
  tenorRemainingMs: 2 * 86_400_000, // 2 days
  contractsBtc: 1,
  purpose: "mtm",
  nowMs: 1_000_000_000_000
};

const makeCache = (overrides: Partial<{
  exactBid: number | null;
  exactSymbol: string;
  fuzzyBid: number | null;
  bidAge: number;
}> = {}) => {
  const exactBid = overrides.exactBid ?? null;
  const fuzzyBid = overrides.fuzzyBid ?? null;
  const bidAge = overrides.bidAge ?? 5000; // 5s default
  const exactSymbol = overrides.exactSymbol ?? "BTC-1JUN26-73000-P";
  return {
    getBidForSymbol: ({ instrumentSymbol }: { instrumentSymbol: string }) => {
      if (exactBid != null && exactBid > 0 && instrumentSymbol === exactSymbol) {
        return {
          bidUsdcPerBtc: exactBid,
          askUsdcPerBtc: exactBid * 1.2,
          midUsdcPerBtc: exactBid * 1.1,
          spreadPct: 0.17,
          venue: "deribit" as const,
          instrumentName: instrumentSymbol,
          tenorHours: 48,
          markIv: 0.36,
          pulledAtMs: (baseInputs.nowMs ?? 0) - bidAge
        };
      }
      if (exactBid === 0) {
        return {
          bidUsdcPerBtc: 0,
          askUsdcPerBtc: 50,
          midUsdcPerBtc: 25,
          spreadPct: 1,
          venue: "deribit" as const,
          instrumentName: instrumentSymbol,
          tenorHours: 48,
          markIv: 0.36,
          pulledAtMs: (baseInputs.nowMs ?? 0) - bidAge
        };
      }
      return null;
    },
    getBidForLeg: () => {
      if (fuzzyBid != null && fuzzyBid > 0) {
        return {
          bidUsdcPerBtc: fuzzyBid,
          askUsdcPerBtc: fuzzyBid * 1.2,
          midUsdcPerBtc: fuzzyBid * 1.1,
          spreadPct: 0.17,
          venue: "deribit" as const,
          instrumentName: "FUZZY-PROXY",
          tenorHours: 60, // 12h drift
          markIv: 0.36,
          pulledAtMs: (baseInputs.nowMs ?? 0) - bidAge
        };
      }
      return null;
    },
    getCached: () => null
  } as unknown as NonNullable<OptionPricingInputs["liquidChainCache"]>;
};

const makeDvol = (sigma: number | null) => ({
  getCurrentDvol: () => sigma != null
    ? { dvol: sigma * 100, sigmaAnnual: sigma, regime: "moderate" as const, asOfMs: 0 }
    : null
}) as unknown as NonNullable<OptionPricingInputs["dvolService"]>;

// ────────── Cascade Tier 1: exact_symbol ──────────

test("cascade tier 1: exact_symbol hit returns bid × bid_haircut", () => {
  const cache = makeCache({ exactBid: 200 });
  const r = priceOption({
    ...baseInputs,
    venue: "deribit",
    instrumentSymbol: "BTC-1JUN26-73000-P",
    liquidChainCache: cache
  });
  assert.equal(r.source, "exact_symbol");
  assert.equal(r.bid_per_btc, 200);
  assert.equal(r.primary_value_per_btc, 200 * DEFAULT_BID_HAIRCUT);
  assert.equal(r.haircut_applied, DEFAULT_BID_HAIRCUT);
});

test("cascade tier 1: exact_symbol with zero bid falls through to fuzzy", () => {
  const cache = makeCache({ exactBid: 0, fuzzyBid: 150 });
  const r = priceOption({
    ...baseInputs,
    venue: "deribit",
    instrumentSymbol: "BTC-1JUN26-73000-P",
    liquidChainCache: cache
  });
  assert.equal(r.source, "fuzzy_strike_tenor");
  assert.equal(r.bid_per_btc, 150);
  assert.ok(r.warnings.some((w) => w.includes("exact_symbol_has_zero_bid")));
});

test("cascade tier 1: stale quote emits warning but still used", () => {
  const cache = makeCache({ exactBid: 200, bidAge: 200_000 }); // 200s, > 180s threshold
  const r = priceOption({
    ...baseInputs,
    venue: "deribit",
    instrumentSymbol: "BTC-1JUN26-73000-P",
    liquidChainCache: cache
  });
  assert.equal(r.source, "exact_symbol");
  assert.ok(r.warnings.some((w) => w.includes("stale_quote")));
  assert.equal(r.primary_value_per_btc, 200 * DEFAULT_BID_HAIRCUT);
});

// ────────── Cascade Tier 2: fuzzy_strike_tenor ──────────

test("cascade tier 2: fuzzy when exact_symbol unavailable", () => {
  const cache = makeCache({ fuzzyBid: 175 });
  const r = priceOption({
    ...baseInputs,
    venue: "deribit",
    instrumentSymbol: "DOES-NOT-EXIST",
    liquidChainCache: cache
  });
  assert.equal(r.source, "fuzzy_strike_tenor");
  assert.equal(r.bid_per_btc, 175);
  assert.equal(r.instrument_used, "FUZZY-PROXY");
});

test("cascade tier 2: emits warning when fuzzy match has significant tenor drift", () => {
  const cache = makeCache({ fuzzyBid: 175 }); // mock returns tenorHours=60, requested 48
  const r = priceOption({
    ...baseInputs,
    liquidChainCache: cache
  });
  assert.ok(r.warnings.some((w) => w.includes("fuzzy_tenor_drift")));
});

// ────────── Cascade Tier 3: bs_only ──────────

test("cascade tier 3: bs_only when no bid available anywhere", () => {
  const cache = makeCache({ exactBid: null, fuzzyBid: null });
  const r = priceOption({
    ...baseInputs,
    liquidChainCache: cache
  });
  assert.equal(r.source, "bs_only");
  assert.equal(r.bid_per_btc, null);
  assert.equal(r.ask_per_btc, null);
  assert.ok(r.bs_theoretical_per_btc > 0);
  assert.equal(r.primary_value_per_btc, r.bs_theoretical_per_btc * DEFAULT_BS_FALLBACK_HAIRCUT);
  assert.equal(r.haircut_applied, DEFAULT_BS_FALLBACK_HAIRCUT);
  assert.ok(r.warnings.some((w) => w.includes("bs_fallback")));
});

test("cascade tier 3: bs_only when no chain cache provided", () => {
  const r = priceOption(baseInputs);
  assert.equal(r.source, "bs_only");
});

// ────────── Purpose-specific haircut behavior ──────────

test("purpose=mtm applies bid haircut", () => {
  const cache = makeCache({ exactBid: 200 });
  const r = priceOption({ ...baseInputs, purpose: "mtm", liquidChainCache: cache, venue: "deribit", instrumentSymbol: "BTC-1JUN26-73000-P" });
  assert.equal(r.haircut_applied, DEFAULT_BID_HAIRCUT);
  assert.equal(r.primary_value_per_btc, 200 * DEFAULT_BID_HAIRCUT);
});

test("purpose=salvage_estimate applies bid haircut", () => {
  const cache = makeCache({ exactBid: 200 });
  const r = priceOption({ ...baseInputs, purpose: "salvage_estimate", liquidChainCache: cache, venue: "deribit", instrumentSymbol: "BTC-1JUN26-73000-P" });
  assert.equal(r.haircut_applied, DEFAULT_BID_HAIRCUT);
});

test("purpose=fair_value uses MID (no haircut) when bid available", () => {
  const cache = makeCache({ exactBid: 200 });
  const r = priceOption({ ...baseInputs, purpose: "fair_value", liquidChainCache: cache, venue: "deribit", instrumentSymbol: "BTC-1JUN26-73000-P" });
  assert.equal(r.haircut_applied, 1.0);
  // mock midUsdcPerBtc = bid * 1.1 = 220 (allow float tolerance)
  assert.ok(Math.abs(r.primary_value_per_btc - 220) < 1e-6, `expected ~220, got ${r.primary_value_per_btc}`);
});

test("purpose=fair_value uses raw BS (no haircut) when bs fallback", () => {
  const r = priceOption({ ...baseInputs, purpose: "fair_value" });
  assert.equal(r.haircut_applied, 1.0);
  assert.equal(r.primary_value_per_btc, r.bs_theoretical_per_btc);
});

// ────────── IV resolution ──────────

test("iv resolution: explicit override wins", () => {
  const r = priceOption({ ...baseInputs, ivAnnualOverride: 0.55, dvolService: makeDvol(0.35) });
  assert.equal(r.iv_used, 0.55);
  assert.equal(r.iv_source, "override");
});

test("iv resolution: live DVOL used when no override", () => {
  const r = priceOption({ ...baseInputs, dvolService: makeDvol(0.42) });
  assert.equal(r.iv_used, 0.42);
  assert.equal(r.iv_source, "live_dvol");
});

test("iv resolution: falls back to NEUTRAL_IV_FALLBACK when no DVOL", () => {
  const r = priceOption({ ...baseInputs, dvolService: makeDvol(null) });
  assert.equal(r.iv_used, NEUTRAL_IV_FALLBACK);
  assert.equal(r.iv_source, "default_36");
});

test("iv resolution: zero/negative override falls through to DVOL", () => {
  const r = priceOption({ ...baseInputs, ivAnnualOverride: 0, dvolService: makeDvol(0.42) });
  assert.equal(r.iv_used, 0.42);
  assert.equal(r.iv_source, "live_dvol");
});

// ────────── Edge cases ──────────

test("edge: expired option (tenorMs <= 0) returns intrinsic only", () => {
  const r = priceOption({ ...baseInputs, tenorRemainingMs: 0, optType: "put" });
  // Put at strike 73000, spot 73950 → OTM, intrinsic = 0
  assert.equal(r.bs_theoretical_per_btc, 0);
});

test("edge: expired ITM option returns positive intrinsic", () => {
  const r = priceOption({ ...baseInputs, tenorRemainingMs: 0, strike: 75000, optType: "put" });
  // Put at strike 75000, spot 73950 → ITM by 1050
  assert.equal(r.bs_theoretical_per_btc, 1050);
});

test("edge: validates positive spot", () => {
  assert.throws(() => priceOption({ ...baseInputs, spot: -100 }), /invalid spot/);
  assert.throws(() => priceOption({ ...baseInputs, spot: 0 }), /invalid spot/);
});

test("edge: validates positive contractsBtc", () => {
  assert.throws(() => priceOption({ ...baseInputs, contractsBtc: 0 }), /invalid contractsBtc/);
});

test("edge: primary_value_total scales by contractsBtc", () => {
  const cache = makeCache({ exactBid: 200 });
  const r = priceOption({
    ...baseInputs,
    contractsBtc: 0.5,
    liquidChainCache: cache,
    venue: "deribit",
    instrumentSymbol: "BTC-1JUN26-73000-P"
  });
  assert.equal(r.primary_value_per_btc, 200 * DEFAULT_BID_HAIRCUT);
  assert.equal(r.primary_value_total, 200 * DEFAULT_BID_HAIRCUT * 0.5);
});

// ────────── Custom haircuts ──────────

test("custom bidHaircut overrides default", () => {
  const cache = makeCache({ exactBid: 200 });
  const r = priceOption({
    ...baseInputs,
    bidHaircut: 0.80,
    liquidChainCache: cache,
    venue: "deribit",
    instrumentSymbol: "BTC-1JUN26-73000-P"
  });
  assert.equal(r.haircut_applied, 0.80);
  assert.equal(r.primary_value_per_btc, 200 * 0.80);
});

test("custom bsFallbackHaircut overrides default", () => {
  const r = priceOption({
    ...baseInputs,
    bsFallbackHaircut: 0.50
  });
  assert.equal(r.haircut_applied, 0.50);
  assert.equal(r.primary_value_per_btc, r.bs_theoretical_per_btc * 0.50);
});

// ────────── priceStrangle convenience ──────────

test("priceStrangle: returns both legs + combined", () => {
  const cache = makeCache({ exactBid: 200 });
  const r = priceStrangle({
    put: {
      spot: 73950, strike: 73000, contractsBtc: 1,
      tenorRemainingMs: 2 * 86_400_000, optType: "put",
      venue: "deribit", instrumentSymbol: "BTC-1JUN26-73000-P",
      liquidChainCache: cache, nowMs: 1_000_000_000_000
    },
    call: {
      spot: 73950, strike: 75000, contractsBtc: 1,
      tenorRemainingMs: 2 * 86_400_000, optType: "call",
      venue: "deribit", instrumentSymbol: "BTC-1JUN26-75000-C",
      liquidChainCache: cache, nowMs: 1_000_000_000_000
    },
    purpose: "mtm"
  });
  assert.ok(r.put);
  assert.ok(r.call);
  // Put has exact match (bid 200), call has no match (mock only returns for the put symbol) → bs_only
  assert.equal(r.put.source, "exact_symbol");
  assert.equal(r.call.source, "bs_only");
  assert.equal(r.combined_value_total, r.put.primary_value_total + r.call.primary_value_total);
});

// ────────── Determinism / consistency ──────────

test("consistency: same inputs produce same output (no hidden state)", () => {
  const cache = makeCache({ exactBid: 200 });
  const r1 = priceOption({
    ...baseInputs,
    liquidChainCache: cache,
    venue: "deribit",
    instrumentSymbol: "BTC-1JUN26-73000-P"
  });
  const r2 = priceOption({
    ...baseInputs,
    liquidChainCache: cache,
    venue: "deribit",
    instrumentSymbol: "BTC-1JUN26-73000-P"
  });
  assert.deepEqual(r1, r2);
});

test("RISK_FREE_RATE is centrally exported", () => {
  assert.equal(typeof RISK_FREE_RATE, "number");
  assert.ok(RISK_FREE_RATE > 0 && RISK_FREE_RATE < 1);
});
