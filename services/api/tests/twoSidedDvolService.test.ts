/**
 * PR A2 tests — DvolService.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DvolService } from "../src/singleSide/twoSided/dvolService";

test("DvolService: tick with successful fetch produces DvolSample with correct regime classification", async () => {
  const svc = new DvolService({
    fetchOverride: async () => 38.5,
    log: () => {}
  });
  const sample = await svc.tick(1_000_000);
  assert.ok(sample);
  assert.equal(sample!.dvol, 38.5);
  assert.equal(sample!.sigmaAnnual, 0.385);
  assert.equal(sample!.regime, "calm");
  assert.equal(sample!.asOfMs, 1_000_000);
});

test("DvolService: regime classification across bands", async () => {
  for (const [dvol, expected] of [[30, "calm"], [50, "moderate"], [70, "elevated"], [90, "stress"]] as const) {
    const svc = new DvolService({ fetchOverride: async () => dvol, log: () => {} });
    const s = await svc.tick();
    assert.equal(s!.regime, expected, `dvol=${dvol} should be ${expected}`);
  }
});

test("DvolService: failed fetch keeps previous value and increments consecutiveFailures", async () => {
  let returnValue: number | null = 36.0;
  const svc = new DvolService({
    fetchOverride: async () => returnValue,
    log: () => {}
  });
  await svc.tick(1_000_000);
  returnValue = null;
  await svc.tick(1_001_000);
  await svc.tick(1_002_000);
  // Check at 1_003_000 — within staleMaxAgeMs of last success (1_000_000)
  const cur = svc.getCurrentDvol(1_003_000);
  assert.ok(cur, "current value should remain after failures");
  assert.equal(cur!.dvol, 36.0);
  const h = svc.getHealth();
  assert.equal(h.consecutiveFailures, 2);
});

test("DvolService: getCurrentDvol returns null when stale > staleMaxAgeMs", async () => {
  const svc = new DvolService({
    fetchOverride: async () => 36.0,
    staleMaxAgeMs: 5_000,
    log: () => {}
  });
  await svc.tick(1_000_000);
  // Fresh immediately after tick
  assert.ok(svc.getCurrentDvol(1_001_000), "fresh within window");
  // 6s later — past 5s staleMaxAgeMs
  assert.equal(svc.getCurrentDvol(1_006_001), null, "should be stale");
});

test("DvolService: stop halts polling", async () => {
  let pollCount = 0;
  const svc = new DvolService({
    pollPeriodMs: 30,
    fetchOverride: async () => {
      pollCount++;
      return 36.0;
    },
    log: () => {}
  });
  await svc.start();
  await new Promise((r) => setTimeout(r, 120));
  svc.stop();
  const c1 = pollCount;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(pollCount, c1, "no polls after stop");
  assert.ok(c1 >= 2, `expected multiple polls, got ${c1}`);
});
