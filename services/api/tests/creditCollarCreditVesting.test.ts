import assert from "node:assert/strict";
import test from "node:test";
import { computeVestedCredit, vestedTimeFraction, type CreditVestingConfig } from "../src/singleSide/twoSided/creditCollar/creditVesting";

const DAY = 86_400_000;
const cfg = (over: Partial<CreditVestingConfig> = {}): CreditVestingConfig => ({ fullCreditUsdc: 70, tenorMs: DAY, ...over });

test("vestedTimeFraction: linear and convex", () => {
  assert.equal(vestedTimeFraction(DAY / 2, DAY, "linear"), 0.5);
  assert.equal(vestedTimeFraction(0, DAY, "linear"), 0);
  assert.equal(vestedTimeFraction(DAY, DAY, "linear"), 1);
  assert.ok(vestedTimeFraction(DAY / 2, DAY, "convex", 2) < 0.5, "convex back-loads vesting toward expiry");
});

test("open-and-grab farming: closing right after opening vests ~nothing", () => {
  const o = computeVestedCredit(cfg(), 60_000, "voluntary_early_close"); // 1 minute held
  assert.ok(o.realizedCreditUsdc < 0.1, `got ${o.realizedCreditUsdc}`);
  assert.ok(o.clawbackUsdc > 69.9, "nearly the whole credit is clawed back");
  assert.equal(o.forfeited, false);
});

test("expiry vests the full credit", () => {
  const o = computeVestedCredit(cfg(), DAY, "expiry");
  assert.equal(o.realizedCreditUsdc, 70);
  assert.equal(o.clawbackUsdc, 0);
  assert.equal(o.vestedFraction, 1);
});

test("barrier_close vests time-pro-rata by default; full if barrierFullVest", () => {
  const half = computeVestedCredit(cfg(), DAY / 2, "barrier_close");
  assert.equal(half.realizedCreditUsdc, 35); // half the tenor
  const full = computeVestedCredit(cfg({ barrierFullVest: true }), DAY / 2, "barrier_close");
  assert.equal(full.realizedCreditUsdc, 70); // product choice: barrier honors full credit
});

test("voluntary early close applies the churn penalty on top of pro-rata", () => {
  const o = computeVestedCredit(cfg({ earlyClosePenaltyPct: 0.5 }), DAY / 2, "voluntary_early_close");
  assert.equal(o.realizedCreditUsdc, 17.5); // 0.5 vested × (1 − 0.5 penalty) × 70
});

test("breach forfeits the entire credit", () => {
  const o = computeVestedCredit(cfg(), DAY * 0.9, "breach_forfeit");
  assert.equal(o.realizedCreditUsdc, 0);
  assert.equal(o.clawbackUsdc, 70);
  assert.equal(o.forfeited, true);
});
