import assert from "node:assert/strict";
import test from "node:test";
import {
  legFeeUsdc,
  computeCollarOpenFees,
  rateBpsFor,
  BULLISH_FEE
} from "../src/singleSide/twoSided/creditCollar/bullishFees";

test("legFeeUsdc: min of (1bp × notional) and (10% × premium)", () => {
  // 1bp × 50k = $5 ; 10% × $70 = $7 ⟹ notional binds at $5.
  assert.equal(legFeeUsdc(1, 50_000, 70), 5);
  // 1bp × 50k = $5 ; 10% × $20 = $2 ⟹ premium cap binds at $2.
  assert.equal(legFeeUsdc(1, 50_000, 20), 2);
  // maker (0 bps) ⟹ always 0.
  assert.equal(legFeeUsdc(0, 50_000, 70), 0);
});

test("rate table matches the Bullish schedule", () => {
  assert.equal(rateBpsFor("clob_maker"), BULLISH_FEE.clobMakerBps);
  assert.equal(rateBpsFor("clob_taker"), 1);
  assert.equal(rateBpsFor("otc_rfq"), 1);
});

test("computeCollarOpenFees: worked 50k example (CLOB charges both legs, OTC nets to heavier)", () => {
  const input = { notionalUsd: 50_000, protectivePremiumUsd: 20, fundingPremiumUsd: 70 } as const;

  const clobTaker = computeCollarOpenFees({ ...input, mode: "clob_taker" });
  assert.equal(clobTaker.protectiveFeeUsdc, 2); // put: 10%-premium cap
  assert.equal(clobTaker.fundingFeeUsdc, 5); // call: 1bp-notional
  assert.equal(clobTaker.openFeeUsdc, 7); // both legs
  assert.equal(clobTaker.expiryFeeUsdc, 0); // held-to-expiry is free
  assert.equal(clobTaker.earlyCloseRoundTripFeeUsdc, 14);

  const otc = computeCollarOpenFees({ ...input, mode: "otc_rfq" });
  assert.equal(otc.openFeeUsdc, 5, "OTC/RFQ multi-leg nets to the heavier leg");

  const maker = computeCollarOpenFees({ ...input, mode: "clob_maker" });
  assert.equal(maker.openFeeUsdc, 0, "passive CLOB maker is free");
});

test("fees are immaterial vs an $80 credit / ~$30 spread (the headline)", () => {
  const f = computeCollarOpenFees({ notionalUsd: 50_000, protectivePremiumUsd: 20, fundingPremiumUsd: 70, mode: "clob_taker" });
  assert.ok(f.openFeeUsdc < 10, "Bullish open fee is single-digit dollars per 50k collar");
});

test("OKX venue uses the 12.5% premium cap (vs Bullish 10%)", () => {
  const input = { notionalUsd: 50_000, protectivePremiumUsd: 20, fundingPremiumUsd: 70, mode: "clob_taker" } as const;
  const bullish = computeCollarOpenFees({ ...input, venue: "bullish" });
  const okx = computeCollarOpenFees({ ...input, venue: "okx" });
  // Put leg ($20 premium): Bullish 10% cap = $2; OKX 12.5% cap = $2.50 (premium cap binds on the cheap leg).
  assert.equal(bullish.protectiveFeeUsdc, 2);
  assert.equal(okx.protectiveFeeUsdc, 2.5);
  // OKX fee is still single-digit dollars — immaterial vs the $80 credit.
  assert.ok(okx.openFeeUsdc < 20, `OKX open fee should be small, got ${okx.openFeeUsdc}`);
  // Default (no venue) == Bullish (back-compat).
  assert.equal(computeCollarOpenFees(input).openFeeUsdc, bullish.openFeeUsdc);
});
