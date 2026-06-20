import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stepLifecycleBook, seedTracked, checkReopenCooldowns, type CoordinatorContext } from "../src/singleSide/twoSided/creditCollar/lifecycleCoordinator";
import { loadLifecycleStates, saveLifecycleStates, type TrackedPosition } from "../src/singleSide/twoSided/creditCollar/lifecycleStateStore";
import { openLedger } from "../src/singleSide/twoSided/creditCollar/collateralLedger";
import type { OpenPosition } from "../src/singleSide/twoSided/creditCollar/forwardSettlement";
import type { OracleTick } from "../src/singleSide/twoSided/creditCollar/referenceOracle";
import type { LifecyclePosition, PartnerPositionState } from "../src/singleSide/twoSided/creditCollar/barrierLifecycle";

const NOW = 1_800_000_000_000;
const ENTRY = 100_000;

const op = (over: Partial<OpenPosition> = {}): OpenPosition => ({
  ref: "p1", side: "long", notionalUsdc: 50_000, spotAtEntry: ENTRY, putStrike: 96_000, callStrike: 104_000,
  foxifyCreditUsdc: 75, serviceFeeUsdc: 10, floorPctUsed: 0.04, openedAtMs: NOW - 2 * 3_600_000, expiresAtMs: NOW + 22 * 3_600_000, ...over
});

const trackedAt = (state: LifecyclePosition["state"], over: Partial<TrackedPosition> = {}): TrackedPosition => ({
  ...seedTracked(op()), state, ...over
});

const open = (isOpen: boolean, markPriceUsd: number | null = null): PartnerPositionState => ({ isOpen, sizeUsd: 50_000, markPriceUsd });

const ctx = (over: Partial<CoordinatorContext> = {}): CoordinatorContext => ({
  nowMs: NOW, ticks: [], partnerStates: {}, settlePriceUsd: null, ledger: openLedger(100_000, { minBufferUsdc: 25_000 }), ...over
});

const floorTicks: OracleTick[] = [
  { tsMs: NOW - 3 * 60_000, priceUsd: 99_000 },
  { tsMs: NOW - 2 * 60_000, priceUsd: 95_000 },
  { tsMs: NOW - 1 * 60_000, priceUsd: 94_000 },
  { tsMs: NOW, priceUsd: 93_000 }
];

test("coordinator: proposed → open when the partner perp is confirmed", () => {
  const r = stepLifecycleBook({}, [op()], ctx({ partnerStates: { p1: open(true) } }));
  assert.equal(r.states.p1.state, "open");
  assert.deepEqual(r.actionsByRef.p1, ["confirm_open"]);
  assert.equal(r.summary.open, 1);
});

test("coordinator: phantom flag when collar is open but partner shows no perp", () => {
  const r = stepLifecycleBook({ p1: trackedAt("open") }, [], ctx({ partnerStates: { p1: open(false) }, ticks: [] }));
  // open + partner closed + no barrier ⟹ orphan cancel (and phantom is also flagged on the open state).
  assert.ok(r.flags.some((f) => f.kind === "phantom_position"));
});

test("coordinator: ORPHAN cancellation — perp closed with no barrier ⟹ cancel collar (no free leg)", () => {
  const r = stepLifecycleBook({ p1: trackedAt("open") }, [], ctx({ partnerStates: { p1: open(false) } }));
  assert.equal(r.concluded.length, 1);
  assert.equal(r.concluded[0].state, "cancelled");
  assert.deepEqual(r.cancelledRefs, ["p1"]);
  assert.equal(r.summary.orphanCancelled, 1);
  assert.ok(r.actionsByRef.p1.includes("cancel_collar") && r.actionsByRef.p1.includes("unwind_hedge"));
  assert.equal(r.states.p1, undefined, "terminal positions drop from persisted state");
  // voluntary early close ⟹ only the vested portion is realized
  assert.ok(r.concluded[0].creditOutcome && r.concluded[0].creditOutcome.realizedCreditUsdc < 75);
});

test("coordinator: barrier touch ⟹ close_signaled (persisted, awaiting perp close)", () => {
  const r = stepLifecycleBook({ p1: trackedAt("open") }, [op()], ctx({ partnerStates: { p1: open(true) }, ticks: floorTicks, settlePriceUsd: 95_500 }));
  assert.equal(r.states.p1.state, "close_signaled");
  assert.equal(r.states.p1.barrierTouched, "floor");
  assert.equal(r.summary.closeSignaled, 1);
  assert.ok(r.actionsByRef.p1.includes("emit_close_signal") && r.actionsByRef.p1.includes("unwind_hedge"));
});

test("coordinator: close ON TIME ⟹ closed, gap to reserve, credit barrier_close", () => {
  const prior = { p1: trackedAt("close_signaled", { barrierTouched: "floor", closeSignaledAtMs: NOW - 10_000 }) };
  const r = stepLifecycleBook(prior, [], ctx({ partnerStates: { p1: open(false, 95_900) }, settlePriceUsd: 95_900, ticks: floorTicks }));
  assert.equal(r.concluded[0].state, "closed");
  assert.equal(r.concluded[0].gapBearer, "reserve");
  assert.ok(r.summary.gapToReserveUsdc > 0);
  assert.equal(r.ledger.debitedUsdc, 0, "on-time gap is the reserve's, not Foxify's");
  assert.equal(r.concluded[0].creditOutcome?.forfeited, false);
});

test("coordinator: late close ⟹ BREACH, gap debited to Foxify collateral, credit FORFEIT", () => {
  const prior = { p1: trackedAt("close_signaled", { barrierTouched: "floor", closeSignaledAtMs: NOW - 60_000 }) };
  const r = stepLifecycleBook(prior, [], ctx({ partnerStates: { p1: open(true) }, settlePriceUsd: 95_900, ticks: floorTicks }));
  assert.equal(r.concluded[0].state, "breached");
  assert.deepEqual(r.breachedRefs, ["p1"]);
  assert.equal(r.concluded[0].gapBearer, "foxify");
  assert.ok(r.ledger.debitedUsdc > 0, "breach gap is debited to Foxify's collateral");
  assert.ok(r.summary.gapToFoxifyUsdc > 0);
  assert.equal(r.concluded[0].creditOutcome?.forfeited, true);
});

test("coordinator: cross-cycle — a close_signaled position NOT in the open book stays tracked to conclusion", () => {
  // collar economically settled at the touch (gone from open book) but perp close still pending.
  const prior = { p1: trackedAt("close_signaled", { barrierTouched: "floor", closeSignaledAtMs: NOW - 60_000 }) };
  const r = stepLifecycleBook(prior, [], ctx({ partnerStates: { p1: open(true) }, settlePriceUsd: 95_900 }));
  assert.equal(r.summary.tracked, 1);
  assert.equal(r.concluded[0].state, "breached");
});

test("coordinator: fail-closed — a tracked ref with NO partner record is assumed still open", () => {
  const r = stepLifecycleBook({ p1: trackedAt("open") }, [op()], ctx({ partnerStates: {} }));
  assert.equal(r.states.p1.state, "open", "missing partner data never infers a close/cancel");
  assert.equal(r.cancelledRefs.length, 0);
});

test("coordinator: cherry-pick detector fires on asymmetric floor/ceiling compliance", () => {
  const history = [
    ...Array.from({ length: 6 }, () => ({ barrier: "floor" as const, closedOnTime: true })),
    ...Array.from({ length: 6 }, () => ({ barrier: "ceiling" as const, closedOnTime: false }))
  ];
  const r = stepLifecycleBook({}, [], ctx({ closeHistory: history }));
  assert.ok(r.cherryPickFlag && r.cherryPickFlag.kind === "asymmetric_compliance");
});

test("checkReopenCooldowns: flags a reopen within the cooldown window", () => {
  const flags = checkReopenCooldowns([{ ref: "p1", openedAtMs: NOW }], { p1: NOW - 10_000 }, 60_000);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, "churn_cooldown");
  const none = checkReopenCooldowns([{ ref: "p1", openedAtMs: NOW }], { p1: NOW - 120_000 }, 60_000);
  assert.equal(none.length, 0);
});

test("lifecycleStateStore: round-trips FSM states through disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "lc-state-"));
  const path = join(dir, "state.json");
  try {
    const states = { p1: trackedAt("close_signaled", { barrierTouched: "floor", closeSignaledAtMs: NOW }) };
    saveLifecycleStates(states, path);
    const back = loadLifecycleStates(path);
    assert.equal(back.p1.state, "close_signaled");
    assert.equal(back.p1.foxifyCreditUsdc, 75);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});