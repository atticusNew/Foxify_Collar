/**
 * PR C1 tests — smile model fit + spread observation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fitSmile, evaluateSmile, flatSmile, spreadAsPct, type SmileObservation } from "../scripts/backtest/singleSide/smileModel";

test("fitSmile: 3 observations on flat IV → rSquared near 1, all coefficients near (iv, 0, 0)", () => {
  const obs: SmileObservation[] = [
    { strike: 70_000, ivAnnual: 0.35 },
    { strike: 75_000, ivAnnual: 0.35 },
    { strike: 80_000, ivAnnual: 0.35 }
  ];
  const fit = fitSmile(obs, 75_000);
  assert.ok(fit);
  assert.ok(Math.abs(fit!.a0 - 0.35) < 0.01);
  assert.ok(Math.abs(fit!.a1) < 0.001);
  assert.ok(fit!.rSquared > 0.99);
});

test("fitSmile: BTC-typical put skew (puts richer than calls) → negative a1", () => {
  // Put skew = IV decreases as strike rises (puts at low strikes = high IV)
  const obs: SmileObservation[] = [
    { strike: 70_000, ivAnnual: 0.45 }, // OTM put = high IV
    { strike: 72_500, ivAnnual: 0.40 },
    { strike: 75_000, ivAnnual: 0.35 }, // ATM
    { strike: 77_500, ivAnnual: 0.32 },
    { strike: 80_000, ivAnnual: 0.30 }  // OTM call = low IV
  ];
  const fit = fitSmile(obs, 75_000);
  assert.ok(fit);
  assert.ok(fit!.a1 < 0, `expected negative skew (put-rich), got a1=${fit!.a1}`);
  assert.ok(fit!.rSquared > 0.95);
});

test("fitSmile: <3 observations returns null", () => {
  assert.equal(fitSmile([{ strike: 75_000, ivAnnual: 0.35 }], 75_000), null);
  assert.equal(fitSmile([{ strike: 75_000, ivAnnual: 0.35 }, { strike: 76_000, ivAnnual: 0.36 }], 75_000), null);
});

test("fitSmile: malformed observations filtered out", () => {
  const obs: SmileObservation[] = [
    { strike: 70_000, ivAnnual: 0.35 },
    { strike: 75_000, ivAnnual: 0.35 },
    { strike: 0, ivAnnual: 0.5 },         // invalid strike
    { strike: 80_000, ivAnnual: NaN },     // invalid iv
    { strike: 85_000, ivAnnual: 0.35 }
  ];
  const fit = fitSmile(obs, 75_000);
  assert.ok(fit);
  assert.equal(fit!.observationCount, 3);
});

test("evaluateSmile: returns interpolated IV at unanchored strike", () => {
  const obs: SmileObservation[] = [
    { strike: 70_000, ivAnnual: 0.45 },
    { strike: 75_000, ivAnnual: 0.35 },
    { strike: 80_000, ivAnnual: 0.30 }
  ];
  const fit = fitSmile(obs, 75_000);
  assert.ok(fit);
  // At strike 72,500 we should get an IV between 0.35 and 0.45 (closer to 0.40)
  const iv72k = evaluateSmile(fit, 72_500);
  assert.ok(iv72k);
  assert.ok(iv72k! > 0.35 && iv72k! < 0.45);
});

test("evaluateSmile: returns null when fit is null", () => {
  assert.equal(evaluateSmile(null, 75_000), null);
});

test("flatSmile: convenience fallback for single observation", () => {
  const fit = flatSmile(0.36, 75_000);
  assert.equal(evaluateSmile(fit, 70_000), 0.36);
  assert.equal(evaluateSmile(fit, 80_000), 0.36);
});

test("spreadAsPct: computes bid-ask spread correctly", () => {
  const obs = {
    strike: 77_000,
    optionType: "put" as const,
    bidUsdcPerBtc: 1_000,
    askUsdcPerBtc: 1_100,
    midUsdcPerBtc: 1_050
  };
  assert.ok(Math.abs(spreadAsPct(obs) - 100/1050) < 0.001);
});

test("spreadAsPct: zero mid returns 0", () => {
  const obs = {
    strike: 0, optionType: "put" as const,
    bidUsdcPerBtc: 0, askUsdcPerBtc: 0, midUsdcPerBtc: 0
  };
  assert.equal(spreadAsPct(obs), 0);
});
