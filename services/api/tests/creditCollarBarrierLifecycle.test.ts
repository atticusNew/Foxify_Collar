import assert from "node:assert/strict";
import test from "node:test";
import {
  newLifecyclePosition,
  detectBarrier,
  assessClose,
  detectPhantom,
  detectOrphanProtection,
  detectSizeMismatch,
  enforceReopenCooldown,
  detectAsymmetricCompliance,
  stepLifecycle,
  type LifecyclePosition,
  type PartnerPositionState
} from "../src/singleSide/twoSided/creditCollar/barrierLifecycle";
import type { OracleTick } from "../src/singleSide/twoSided/creditCollar/referenceOracle";

const NOW = 1_800_000_000_000;
const mkPos = (over: Partial<LifecyclePosition> = {}): LifecyclePosition => ({
  ...newLifecyclePosition({
    ref: "p1",
    side: "long",
    putStrike: 61_000,   // floor
    callStrike: 65_000,  // ceiling
    spotAtEntry: 63_000,
    notionalUsdc: 50_000,
    openedAtMs: NOW - 3_600_000,
    expiresAtMs: NOW + 3_600_000
  }),
  ...over
});

const open = (over: Partial<PartnerPositionState> = {}): PartnerPositionState => ({ isOpen: true, sizeUsd: 50_000, markPriceUsd: 63_000, ...over });
const flat = (over: Partial<PartnerPositionState> = {}): PartnerPositionState => ({ isOpen: false, sizeUsd: 0, markPriceUsd: 63_000, ...over });
const ticksAt = (price: number): OracleTick[] => [0, 1, 2, 3].map((i) => ({ tsMs: NOW + i * 1000, priceUsd: price }));

// ── Barrier detection ──
test("detectBarrier: tick-persistent floor/ceiling; single wick does not fire", () => {
  assert.equal(detectBarrier(ticksAt(60_000), 61_000, 65_000, 3).barrier, "floor");
  assert.equal(detectBarrier(ticksAt(66_000), 61_000, 65_000, 3).barrier, "ceiling");
  assert.equal(detectBarrier(ticksAt(63_000), 61_000, 65_000, 3).barrier, "none");
  const wick: OracleTick[] = [
    { tsMs: NOW, priceUsd: 63_000 },
    { tsMs: NOW + 1000, priceUsd: 60_000 }, // one tick below floor
    { tsMs: NOW + 2000, priceUsd: 63_000 },
    { tsMs: NOW + 3000, priceUsd: 63_000 }
  ];
  assert.equal(detectBarrier(wick, 61_000, 65_000, 3).barrier, "none", "a single wick must not confirm");
});

// ── Close SLA + gap accountability ──
test("assessClose: on-time gap → reserve; late gap → foxify; no gap → none", () => {
  const contracts = 50_000 / 63_000;
  // Closed exactly at the floor, on time ⟹ no gap.
  const clean = assessClose("floor", 61_000, 61_000, contracts, NOW, NOW + 5_000, 30_000);
  assert.equal(clean.bearer, "none");
  // Closed below the floor but within SLA ⟹ reserve bears the gap.
  const onTime = assessClose("floor", 61_000, 60_500, contracts, NOW, NOW + 5_000, 30_000);
  assert.equal(onTime.onTime, true);
  assert.equal(onTime.bearer, "reserve");
  assert.ok(onTime.gapUsdc > 0);
  // Closed below the floor AFTER the SLA ⟹ Foxify bears it.
  const late = assessClose("floor", 61_000, 60_500, contracts, NOW, NOW + 60_000, 30_000);
  assert.equal(late.onTime, false);
  assert.equal(late.bearer, "foxify");
  // Ceiling adverse = above the cap.
  const ceil = assessClose("ceiling", 65_000, 65_800, contracts, NOW, NOW + 5_000, 30_000);
  assert.ok(ceil.gapUsdc > 0 && ceil.bearer === "reserve");
});

// ── Gaming detectors ──
test("detectPhantom: collar live but no partner perp", () => {
  assert.ok(detectPhantom({ ...mkPos(), state: "open" }, flat()));
  assert.equal(detectPhantom({ ...mkPos(), state: "open" }, open()), null);
});

test("detectOrphanProtection: perp closed with no barrier ⟹ flag (no free protection)", () => {
  assert.ok(detectOrphanProtection({ ...mkPos(), state: "open", barrierTouched: "none" }, flat()));
  // If a barrier was touched, a closed perp is expected, not an orphan.
  assert.equal(detectOrphanProtection({ ...mkPos(), state: "open", barrierTouched: "floor" }, flat()), null);
});

test("detectSizeMismatch: partner size must match collar notional within tolerance", () => {
  assert.equal(detectSizeMismatch(mkPos(), open({ sizeUsd: 50_500 }), 0.02), null);
  assert.ok(detectSizeMismatch(mkPos(), open({ sizeUsd: 70_000 }), 0.02));
});

test("enforceReopenCooldown: blocks churn within the cooldown", () => {
  assert.ok(enforceReopenCooldown("p1", NOW, NOW + 10_000, 60_000));
  assert.equal(enforceReopenCooldown("p1", NOW, NOW + 90_000, 60_000), null);
  assert.equal(enforceReopenCooldown("p1", null, NOW, 60_000), null);
});

test("detectAsymmetricCompliance: cherry-picking floor vs ceiling closes", () => {
  const hist = [
    ...Array.from({ length: 6 }, () => ({ barrier: "floor" as const, closedOnTime: true })),
    ...Array.from({ length: 6 }, () => ({ barrier: "ceiling" as const, closedOnTime: false }))
  ];
  assert.ok(detectAsymmetricCompliance(hist));
  const balanced = [
    ...Array.from({ length: 6 }, () => ({ barrier: "floor" as const, closedOnTime: true })),
    ...Array.from({ length: 6 }, () => ({ barrier: "ceiling" as const, closedOnTime: true }))
  ];
  assert.equal(detectAsymmetricCompliance(balanced), null);
});

// ── State machine ──
test("lifecycle: proposed → open on confirmed partner perp", () => {
  const s = stepLifecycle(mkPos(), { nowMs: NOW, ticks: ticksAt(63_000), partner: open() });
  assert.equal(s.pos.state, "open");
  assert.ok(s.actions.includes("confirm_open"));
});

test("lifecycle: barrier touch ⟹ emit close signal + unwind hedge immediately", () => {
  const s = stepLifecycle({ ...mkPos(), state: "open" }, { nowMs: NOW, ticks: ticksAt(65_500), partner: open() });
  assert.equal(s.pos.state, "close_signaled");
  assert.equal(s.pos.barrierTouched, "ceiling");
  assert.ok(s.actions.includes("emit_close_signal") && s.actions.includes("unwind_hedge"));
});

test("lifecycle: close within SLA ⟹ closed; reserve bears any gap", () => {
  const signaled = { ...mkPos(), state: "close_signaled" as const, barrierTouched: "ceiling" as const, closeSignaledAtMs: NOW };
  const s = stepLifecycle(signaled, { nowMs: NOW + 5_000, ticks: [], partner: flat({ markPriceUsd: 65_200 }), settlePriceUsd: 65_200, cfg: { closeSlaMs: 30_000 } });
  assert.equal(s.pos.state, "closed");
  assert.ok(s.actions.includes("settle"));
  assert.equal(s.accountability?.bearer, "reserve");
});

test("lifecycle: perp NOT closed past SLA ⟹ breached, gap is Foxify's", () => {
  const signaled = { ...mkPos(), state: "close_signaled" as const, barrierTouched: "ceiling" as const, closeSignaledAtMs: NOW };
  const s = stepLifecycle(signaled, { nowMs: NOW + 60_000, ticks: [], partner: open({ markPriceUsd: 66_000 }), settlePriceUsd: 66_000, cfg: { closeSlaMs: 30_000 } });
  assert.equal(s.pos.state, "breached");
  assert.equal(s.accountability?.onTime, false);
  assert.equal(s.accountability?.bearer, "foxify");
});

test("lifecycle: perp closed early with no barrier ⟹ collar cancelled (orphan guard)", () => {
  const s = stepLifecycle({ ...mkPos(), state: "open" }, { nowMs: NOW, ticks: ticksAt(63_000), partner: flat() });
  assert.equal(s.pos.state, "cancelled");
  assert.ok(s.actions.includes("cancel_collar") && s.actions.includes("unwind_hedge"));
  assert.ok(s.flags.some((f) => f.kind === "orphan_protection"));
});

test("lifecycle: no touch by expiry ⟹ expired (European settle)", () => {
  const s = stepLifecycle({ ...mkPos(), state: "open", expiresAtMs: NOW - 1 }, { nowMs: NOW, ticks: ticksAt(63_000), partner: open() });
  assert.equal(s.pos.state, "expired");
  assert.ok(s.actions.includes("settle"));
});
