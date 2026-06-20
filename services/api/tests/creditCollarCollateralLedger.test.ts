import assert from "node:assert/strict";
import test from "node:test";
import { openLedger, postCollateral, applyGap } from "../src/singleSide/twoSided/creditCollar/collateralLedger";

test("openLedger + postCollateral track available balance", () => {
  let l = openLedger(0, { minBufferUsdc: 1000 });
  assert.equal(l.haltNewProtection, true, "empty ledger halts");
  l = postCollateral(l, 50_000, { minBufferUsdc: 1000 });
  assert.equal(l.availableUsdc, 50_000);
  assert.equal(l.haltNewProtection, false);
});

test("gap within SLA is absorbed by the reserve — no debit to Foxify", () => {
  const l = openLedger(50_000);
  const r = applyGap(l, { gapUsdc: 300, onTimeWithinSla: true });
  assert.equal(r.bearer, "reserve");
  assert.equal(r.debitedUsdc, 0);
  assert.equal(r.ledger.availableUsdc, 50_000);
});

test("gap beyond SLA (breach) debits Foxify collateral", () => {
  const l = openLedger(50_000);
  const r = applyGap(l, { gapUsdc: 300, onTimeWithinSla: false });
  assert.equal(r.bearer, "foxify");
  assert.equal(r.debitedUsdc, 300);
  assert.equal(r.ledger.availableUsdc, 49_700);
  assert.equal(r.ledger.debitedUsdc, 300);
});

test("zero gap ⟹ no bearer", () => {
  const r = applyGap(openLedger(50_000), { gapUsdc: 0, onTimeWithinSla: false });
  assert.equal(r.bearer, "none");
  assert.equal(r.debitedUsdc, 0);
});

test("collateral depletion below the min buffer halts new protection", () => {
  let l = openLedger(1_200, { minBufferUsdc: 1_000 });
  assert.equal(l.haltNewProtection, false);
  const r = applyGap(l, { gapUsdc: 300, onTimeWithinSla: false }, { minBufferUsdc: 1_000 });
  assert.equal(r.ledger.availableUsdc, 900);
  assert.equal(r.halted, true, "available below min buffer ⟹ halt");
  // Top up to clear the halt.
  l = postCollateral(r.ledger, 5_000, { minBufferUsdc: 1_000 });
  assert.equal(l.haltNewProtection, false);
});
