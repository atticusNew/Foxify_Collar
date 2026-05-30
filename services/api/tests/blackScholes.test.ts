import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import { bsPut, bsCall, computePutRecoveryValue, timeToExpiryYears, bsPutDecimal } from "../src/pilot/blackScholes";

test("bsPut — intrinsic when T=0", () => {
  assert.ok(Math.abs(bsPut(100, 110, 0, 0, 0.5) - 10) < 0.001);
  assert.equal(bsPut(120, 110, 0, 0, 0.5), 0);
});

test("bsPut — intrinsic when sigma=0", () => {
  assert.ok(Math.abs(bsPut(90, 100, 1, 0, 0) - 10) < 0.001);
});

test("bsPut — OTM put near zero", () => {
  const value = bsPut(100, 50, 0.01, 0, 0.3);
  assert.ok(value < 0.01);
});

test("bsPut — ATM put reasonable range", () => {
  const value = bsPut(100, 100, 1, 0, 0.2);
  assert.ok(value > 5);
  assert.ok(value < 12);
});

test("bsPut — higher vol = higher value", () => {
  const low = bsPut(100, 100, 0.5, 0, 0.1);
  const high = bsPut(100, 100, 0.5, 0, 0.5);
  assert.ok(high > low);
});

test("bsPut — longer tenor = higher value", () => {
  const short = bsPut(100, 100, 0.1, 0, 0.3);
  const long = bsPut(100, 100, 1, 0, 0.3);
  assert.ok(long > short);
});

test("bsPut — deeper ITM = higher value", () => {
  const otm = bsPut(110, 100, 0.5, 0, 0.3);
  const itm = bsPut(90, 100, 0.5, 0, 0.3);
  assert.ok(itm > otm);
});

test("bsPut — BTC realistic pricing", () => {
  const value = bsPut(70000, 68600, 2 / 365, 0, 0.45);
  assert.ok(value > 0);
  assert.ok(value < 3000);
});

test("bsCall — intrinsic when T=0", () => {
  assert.ok(Math.abs(bsCall(110, 100, 0, 0, 0.5) - 10) < 0.001);
  assert.equal(bsCall(90, 100, 0, 0, 0.5), 0);
});

test("put-call parity", () => {
  const S = 100, K = 100, T = 1, r = 0.05, sigma = 0.3;
  const put = bsPut(S, K, T, r, sigma);
  const call = bsCall(S, K, T, r, sigma);
  const parity = call - put - S + K * Math.exp(-r * T);
  assert.ok(Math.abs(parity) < 0.01);
});

test("bsPutDecimal — positive", () => {
  const result = bsPutDecimal(new Decimal(100), new Decimal(100), new Decimal(0.5), new Decimal(0), new Decimal(0.3));
  assert.ok(result.gt(0));
  assert.ok(result.lt(20));
});

test("timeToExpiryYears — expired = 0", () => {
  assert.equal(timeToExpiryYears(Date.now() - 1000), 0);
});

test("timeToExpiryYears — 1 year", () => {
  const oneYear = 365.25 * 24 * 3600 * 1000;
  const result = timeToExpiryYears(Date.now() + oneYear);
  assert.ok(Math.abs(result - 1) < 0.01);
});

test("timeToExpiryYears — 2 days", () => {
  const twoDays = 2 * 24 * 3600 * 1000;
  const result = timeToExpiryYears(Date.now() + twoDays);
  assert.ok(Math.abs(result - 2 / 365.25) < 0.001);
});

test("computePutRecoveryValue — ITM put", () => {
  const result = computePutRecoveryValue({
    currentSpot: 68000,
    strike: 70000,
    expiryMs: Date.now() + 2 * 24 * 3600 * 1000,
    sigma: 0.45
  });
  assert.equal(result.intrinsicValue, 2000);
  assert.ok(result.timeValue > 0);
  assert.ok(result.totalValue > result.intrinsicValue);
});

test("computePutRecoveryValue — OTM put (time value only)", () => {
  const result = computePutRecoveryValue({
    currentSpot: 72000,
    strike: 70000,
    expiryMs: Date.now() + 2 * 24 * 3600 * 1000,
    sigma: 0.45
  });
  assert.equal(result.intrinsicValue, 0);
  assert.ok(result.timeValue > 0);
  assert.equal(result.totalValue, result.timeValue);
});

test("computePutRecoveryValue — at expiry (intrinsic only)", () => {
  const result = computePutRecoveryValue({
    currentSpot: 68000,
    strike: 70000,
    expiryMs: Date.now(),
    sigma: 0.45
  });
  assert.equal(result.intrinsicValue, 2000);
  assert.equal(result.timeValue, 0);
  assert.equal(result.totalValue, 2000);
});
