/**
 * Black-Scholes greeks — known-answer (Hull) + finite-difference self-consistency.
 * Underpins Phase 4.5 gamma scalp (per-tick delta hedge + gamma harvest).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  bsCall, bsPut, bsCallDelta, bsPutDelta, bsGamma, bsVega, bsCallTheta, bsPutTheta
} from "../scripts/backtest/singleSide/coreEngine";

// Hull (Options, Futures & Other Derivatives) worked example:
const S = 49, K = 50, r = 0.05, sigma = 0.20, T = 0.3846;

test("greeks: Hull known-answer values", () => {
  assert.ok(Math.abs(bsCallDelta(S, K, T, r, sigma) - 0.522) < 0.005, "call delta ~0.522");
  assert.ok(Math.abs(bsPutDelta(S, K, T, r, sigma) - (-0.478)) < 0.005, "put delta ~-0.478");
  assert.ok(Math.abs(bsGamma(S, K, T, r, sigma) - 0.0655) < 0.0010, "gamma ~0.0655");
  assert.ok(Math.abs(bsVega(S, K, T, r, sigma) - 12.10) < 0.20, "vega ~12.1 (per 1.00 vol)");
  assert.ok(Math.abs(bsCallTheta(S, K, T, r, sigma) - (-4.302)) < 0.05, "call theta ~-4.30/yr");
});

test("greeks: put-call parity (delta diff = 1; gamma & vega equal)", () => {
  assert.ok(Math.abs((bsCallDelta(S, K, T, r, sigma) - bsPutDelta(S, K, T, r, sigma)) - 1) < 1e-9);
  // theta parity: theta_put - theta_call = r*K*e^{-rT}
  const parity = r * K * Math.exp(-r * T);
  assert.ok(Math.abs((bsPutTheta(S, K, T, r, sigma) - bsCallTheta(S, K, T, r, sigma)) - parity) < 1e-9);
});

test("greeks: finite-difference self-consistency (delta & gamma vs bsCall)", () => {
  const h = 0.5;
  const fdDelta = (bsCall(S + h, K, T, r, sigma) - bsCall(S - h, K, T, r, sigma)) / (2 * h);
  const fdGamma = (bsCall(S + h, K, T, r, sigma) - 2 * bsCall(S, K, T, r, sigma) + bsCall(S - h, K, T, r, sigma)) / (h * h);
  assert.ok(Math.abs(fdDelta - bsCallDelta(S, K, T, r, sigma)) < 1e-3, `fd delta ${fdDelta} vs analytic`);
  assert.ok(Math.abs(fdGamma - bsGamma(S, K, T, r, sigma)) < 1e-3, `fd gamma ${fdGamma} vs analytic`);
  // put delta via finite difference of bsPut
  const fdPutDelta = (bsPut(S + h, K, T, r, sigma) - bsPut(S - h, K, T, r, sigma)) / (2 * h);
  assert.ok(Math.abs(fdPutDelta - bsPutDelta(S, K, T, r, sigma)) < 1e-3);
});

test("greeks: ATM gamma > OTM gamma (drives the gamma-scalp thesis)", () => {
  const atm = bsGamma(73000, 73000, 3 / 365, r, 0.55);
  const otm = bsGamma(73000, 79000, 3 / 365, r, 0.55);
  assert.ok(atm > otm, `ATM gamma (${atm}) should exceed OTM gamma (${otm})`);
});

test("greeks: degenerate inputs never NaN", () => {
  for (const fn of [bsGamma, bsVega, bsCallTheta, bsPutTheta]) {
    assert.equal(fn(73000, 73000, 0, r, 0.5), 0, "T=0 -> 0");
    assert.equal(fn(73000, 73000, 0.1, r, 0), 0, "sigma=0 -> 0");
  }
  assert.equal(bsCallDelta(80000, 73000, 0, r, 0.5), 1, "ITM call delta at expiry = 1");
  assert.equal(bsPutDelta(70000, 73000, 0, r, 0.5), -1, "ITM put delta at expiry = -1");
});
