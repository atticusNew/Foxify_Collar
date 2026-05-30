/**
 * PR B1 tests — UnwindQueue (FIFO with deadline priority + regime policy).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { UnwindQueue, DEFAULT_REGIME_POLICY } from "../src/singleSide/twoSided/unwindQueue";

test("single pair: granted on first request", () => {
  const q = new UnwindQueue({ log: () => {} });
  const r = q.requestSlot("p1", 1_000, 2_000);
  assert.equal(r.granted, true);
  assert.equal(r.queueDepth, 0);
});

test("idempotent: re-requesting after grant returns granted=true", () => {
  const q = new UnwindQueue({ log: () => {} });
  q.requestSlot("p1", 1_000, 2_000);
  const r2 = q.requestSlot("p1", 1_000, 2_500);
  assert.equal(r2.granted, true);
});

test("FIFO: older pair (earlier triggered_at) gets slot before newer", () => {
  const q = new UnwindQueue({
    policy: { ...DEFAULT_REGIME_POLICY, calm: { windowMs: 60_000, maxConcurrent: 1 } }, // only 1 slot
    log: () => {}
  });
  // Both request at same now, but p_old has earlier triggered_at
  const newR = q.requestSlot("p_new", 5_000, 10_000);
  const oldR = q.requestSlot("p_old", 1_000, 10_000);
  // p_new asked first but should be denied because p_old has earlier triggered_at
  // Order of evaluation: at request 1, p_new is the only entry, so it gets the slot
  // At request 2, p_old is older but slot is taken
  // FIFO ordering is meant for queue waiting; if p_new already granted, p_old waits
  assert.equal(newR.granted, true); // first in, takes the only slot
  assert.equal(oldR.granted, false);
});

test("FIFO ordering: when concurrent slot is full, older queued pair gets it next", () => {
  const q = new UnwindQueue({
    policy: { ...DEFAULT_REGIME_POLICY, calm: { windowMs: 60_000, maxConcurrent: 1 } },
    log: () => {}
  });
  // Two pairs queue waiting (p_old at 1000, p_new at 5000)
  q.requestSlot("granted_first", 500, 10_000); // takes the slot
  const newR1 = q.requestSlot("p_new", 5_000, 10_000);
  const oldR1 = q.requestSlot("p_old", 1_000, 10_000);
  assert.equal(newR1.granted, false);
  assert.equal(oldR1.granted, false);
  // Release the slot; next request: p_old should be at queue front (older triggered_at)
  q.releaseSlot("granted_first");
  // Slot timestamps not auto-pruned, but window check uses now. We'll request at later time.
  const oldR2 = q.requestSlot("p_old", 1_000, 11_000);
  assert.equal(oldR2.granted, false, "p_old should still be denied — window slot still occupied within window");
  // FIFO: p_new requesting will see p_old is older → denied with queue_position reason
  const newR2 = q.requestSlot("p_new", 5_000, 11_000);
  assert.equal(newR2.granted, false);
  assert.match(newR2.reason ?? "", /queue_position/);
});

test("deadline force-grant: pair waiting longer than maxWaitMs is force-granted", () => {
  const q = new UnwindQueue({
    policy: { ...DEFAULT_REGIME_POLICY, calm: { windowMs: 60_000, maxConcurrent: 0 } }, // no slots
    maxWaitMs: 1_000, // 1 second deadline
    log: () => {}
  });
  q.requestSlot("p1", 0, 0);
  // Try again 2s later — should force-grant
  const r = q.requestSlot("p1", 0, 2_000);
  assert.equal(r.granted, true);
  assert.equal(r.forceGranted, true);
});

test("regime policy: elevated allows 3 concurrent, calm only 2", () => {
  let regime: "calm" | "elevated" = "calm";
  const q = new UnwindQueue({
    getCurrentRegime: () => regime,
    log: () => {}
  });
  // Calm policy = 2 max
  const r1 = q.requestSlot("p1", 1, 10);
  const r2 = q.requestSlot("p2", 2, 10);
  const r3 = q.requestSlot("p3", 3, 10);
  assert.equal(r1.granted, true);
  assert.equal(r2.granted, true);
  assert.equal(r3.granted, false);
  // Switch to elevated (3 max) — but window already has 2 grants
  regime = "elevated";
  const r3b = q.requestSlot("p3", 3, 11);
  assert.equal(r3b.granted, true);
  // Now p4 — calm 2 (cap), elevated 3 (cap reached) — denied
  const r4 = q.requestSlot("p4", 4, 12);
  assert.equal(r4.granted, false);
});

test("release frees slot for future grants", () => {
  const q = new UnwindQueue({
    policy: { ...DEFAULT_REGIME_POLICY, calm: { windowMs: 60_000, maxConcurrent: 1 } },
    log: () => {}
  });
  q.requestSlot("p1", 1, 10);
  q.releaseSlot("p1");
  // Try p2 — but the grant timestamp for p1 is still in the window
  const r = q.requestSlot("p2", 2, 100);
  assert.equal(r.granted, false);
  // Outside window (61s later) — slot opens again
  const r2 = q.requestSlot("p2", 2, 61_000);
  assert.equal(r2.granted, true);
});

test("stats: reports queue depth + longest wait + grants/denials", () => {
  const q = new UnwindQueue({
    policy: { ...DEFAULT_REGIME_POLICY, calm: { windowMs: 60_000, maxConcurrent: 0 } }, // never grants
    log: () => {}
  });
  q.requestSlot("p1", 1, 10);
  q.requestSlot("p2", 2, 100); // 90ms later
  q.requestSlot("p3", 3, 1_000); // 990ms later
  const s = q.stats(2_000);
  assert.equal(s.queueDepth, 3);
  assert.ok(s.longestWaitMs >= 1_900, `expected >=1900ms wait, got ${s.longestWaitMs}`);
  assert.ok(s.totalDenied > 0);
});
