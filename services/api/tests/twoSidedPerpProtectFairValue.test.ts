/**
 * Perp Protect fair-value / sanity diagnostic — Black-Scholes, implied vol, implausibility flags.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { bsPrice, impliedVol, fairValueDiagnostic } from "../src/singleSide/twoSided/perpProtectFairValue";

test("ATM BS price ≈ 0.3989·S·vol·sqrt(T) (small-rate approximation)", () => {
  const S = 60000, vol = 0.6, T = 30 / 365;
  const p = bsPrice({ type: "call", spot: S, strike: S, tYears: T, vol });
  const approx = 0.3989422804 * S * vol * Math.sqrt(T);
  assert.ok(Math.abs(p - approx) / approx < 0.02, `${p} ≈ ${approx}`);
});

test("put-call parity holds (rate 0): C − P = S − K", () => {
  const S = 60000, K = 58000, T = 14 / 365, vol = 0.7;
  const c = bsPrice({ type: "call", spot: S, strike: K, tYears: T, vol });
  const p = bsPrice({ type: "put", spot: S, strike: K, tYears: T, vol });
  assert.ok(Math.abs((c - p) - (S - K)) < 1e-3);
});

test("implied vol round-trips: price→IV→price", () => {
  const args = { type: "put" as const, spot: 60000, strike: 57000, tYears: 7 / 365 };
  const price = bsPrice({ ...args, vol: 0.85 });
  const iv = impliedVol({ ...args, priceUsdcPerBtc: price });
  assert.ok(iv != null);
  assert.ok(Math.abs(iv! - 0.85) < 1e-3, `recovered ${iv}`);
});

test("price below intrinsic → no solvable IV (null) and below_intrinsic flag", () => {
  const args = { type: "put" as const, spot: 50000, strike: 60000, tYears: 7 / 365 }; // intrinsic ≈ 10000
  assert.equal(impliedVol({ ...args, priceUsdcPerBtc: 5000 }), null);
  const d = fairValueDiagnostic({ ...args, priceUsdcPerBtc: 5000 });
  assert.equal(d.flag, "below_intrinsic");
});

test("normal OTM skew is NOT flagged (plausible vol)", () => {
  const args = { type: "put" as const, spot: 60000, strike: 54000, tYears: 7 / 365 };
  const price = bsPrice({ ...args, vol: 1.1 }); // 110% — elevated but plausible OTM skew
  const d = fairValueDiagnostic({ ...args, priceUsdcPerBtc: price });
  assert.equal(d.flag, "ok");
  assert.ok(Math.abs((d.implied_vol as number) - 1.1) < 1e-2);
});

test("garbage quote implying extreme vol is flagged implausible", () => {
  const args = { type: "put" as const, spot: 60000, strike: 54000, tYears: 7 / 365 };
  const price = bsPrice({ ...args, vol: 6.5 }); // 650% — implausible
  const d = fairValueDiagnostic({ ...args, priceUsdcPerBtc: price });
  assert.equal(d.flag, "implausible_vol");
});

test("invalid inputs → unpriceable (never throws)", () => {
  const d = fairValueDiagnostic({ type: "call", spot: 0, strike: 60000, tYears: 0.02, priceUsdcPerBtc: 100 });
  assert.equal(d.flag, "unpriceable");
  assert.equal(d.implied_vol, null);
});
