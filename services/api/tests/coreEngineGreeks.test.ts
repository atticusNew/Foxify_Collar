/**
 * Black-Scholes greeks — known-answer (Hull) + finite-difference self-consistency.
 * Underpins Phase 4.5 gamma scalp (per-tick delta hedge + gamma harvest).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  bsCall, bsPut, bsCallDelta, bsPutDelta, bsGamma, bsVega, bsCallTheta, bsPutTheta,
  combinedStraddleGreeks, combinedStraddleGreeksSkew
} from "../scripts/backtest/singleSide/coreEngine";

// Hull (Options, Futures & Other Derivatives) worked example:
const S = 49, K = 50, r = 0.05, sigma = 0.20, T = 0.3846;

test("skew greeks: equal per-leg σ reduces to the single-σ straddle greeks", () => {
  const flat = combinedStraddleGreeks(73000, 73000, 73000, 1, 3 / 365, 0.045, 0.5);
  const skew = combinedStraddleGreeksSkew(73000, 73000, 73000, 1, 3 / 365, 0.045, 0.5, 0.5);
  assert.deepEqual(skew, flat, "putσ==callσ → identical to single-σ form");
});

test("skew greeks: higher per-leg σ raises vega (smile-aware)", () => {
  const lo = combinedStraddleGreeksSkew(73000, 71000, 75000, 1, 3 / 365, 0.045, 0.45, 0.45);
  const hi = combinedStraddleGreeksSkew(73000, 71000, 75000, 1, 3 / 365, 0.045, 0.60, 0.60);
  assert.ok(hi.vega_per_pct > lo.vega_per_pct, "higher IV → higher vega");
});

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

test("impliedVolFromPrice: round-trips BS price back to sigma (call & put)", async () => {
  const { impliedVolFromPrice } = await import("../scripts/backtest/singleSide/coreEngine");
  const Sx = 73000, Kx = 73000, Tx = 3 / 365, rx = 0.045;
  for (const sig of [0.20, 0.45, 0.80, 1.20]) {
    const cPrice = bsCall(Sx, Kx, Tx, rx, sig);
    const pPrice = bsPut(Sx, Kx, Tx, rx, sig);
    const cIv = impliedVolFromPrice(cPrice, Sx, Kx, Tx, rx, "call")!;
    const pIv = impliedVolFromPrice(pPrice, Sx, Kx, Tx, rx, "put")!;
    assert.ok(Math.abs(cIv - sig) < 1e-3, `call IV ${cIv} ~ ${sig}`);
    assert.ok(Math.abs(pIv - sig) < 1e-3, `put IV ${pIv} ~ ${sig}`);
  }
  assert.equal(impliedVolFromPrice(0, Sx, Kx, Tx, rx, "call"), null, "zero price -> null");
  assert.equal(impliedVolFromPrice(100, Sx, Kx, 0, rx, "call"), null, "T=0 -> null");
});

test("combinedStraddleGreeks: ATM straddle ~delta-neutral, +gamma, +vega, -theta", async () => {
  const { combinedStraddleGreeks } = await import("../scripts/backtest/singleSide/coreEngine");
  const g = combinedStraddleGreeks(73000, 73000, 73000, 1, 3 / 365, 0.045, 0.55);
  assert.ok(Math.abs(g.delta) < 0.1, `ATM straddle ~delta-neutral, got ${g.delta}`);
  assert.ok(g.gamma > 0, "positive gamma");
  assert.ok(g.vega_per_pct > 0, "positive vega (long premium)");
  assert.ok(g.theta_per_day < 0, "negative theta (long premium decays)");
  // strangle (wider) has less gamma than ATM straddle
  const wide = combinedStraddleGreeks(73000, 71000, 75000, 1, 3 / 365, 0.045, 0.55);
  assert.ok(wide.gamma < g.gamma, "OTM strangle gamma < ATM straddle gamma");
});
