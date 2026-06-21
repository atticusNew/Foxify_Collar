import assert from "node:assert/strict";
import test from "node:test";
import { evaluateActivationGate } from "../src/singleSide/twoSided/creditCollar/activationGate";

const ok = { oracleSafeForActivation: true, collateralHalted: false, partnerFeedHealthy: true, basisSafeToSettle: true };

test("activationGate: all guards pass ⟹ opens allowed", () => {
  const d = evaluateActivationGate(ok);
  assert.equal(d.allowOpens, true);
  assert.deepEqual(d.reasons, []);
});

test("activationGate: oracle not safe ⟹ blocked", () => {
  const d = evaluateActivationGate({ ...ok, oracleSafeForActivation: false });
  assert.equal(d.allowOpens, false);
  assert.ok(d.reasons.includes("oracle_not_safe_for_activation"));
});

test("activationGate: collateral halted ⟹ blocked", () => {
  const d = evaluateActivationGate({ ...ok, collateralHalted: true });
  assert.equal(d.allowOpens, false);
  assert.ok(d.reasons.includes("collateral_halted"));
});

test("activationGate: partner feed degraded ⟹ blocked", () => {
  const d = evaluateActivationGate({ ...ok, partnerFeedHealthy: false });
  assert.equal(d.allowOpens, false);
  assert.ok(d.reasons.includes("partner_feed_degraded"));
});

test("activationGate: wide basis ⟹ blocked", () => {
  const d = evaluateActivationGate({ ...ok, basisSafeToSettle: false });
  assert.equal(d.allowOpens, false);
  assert.ok(d.reasons.includes("basis_unsafe_to_settle"));
});

test("activationGate: multiple failures reported together", () => {
  const d = evaluateActivationGate({ oracleSafeForActivation: false, collateralHalted: true, partnerFeedHealthy: false, basisSafeToSettle: false });
  assert.equal(d.allowOpens, false);
  assert.equal(d.reasons.length, 4);
});

test("activationGate: a guard can be disabled via config", () => {
  const d = evaluateActivationGate({ ...ok, basisSafeToSettle: false }, { requireBasisSafe: false });
  assert.equal(d.allowOpens, true, "basis guard off ⟹ wide basis no longer blocks opens");
});
