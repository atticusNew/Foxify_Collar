import assert from "node:assert/strict";
import test from "node:test";
import { assessLock } from "../src/singleSide/twoSided/creditCollar/lockPolicy";
import { reconcileShadowLifecycle } from "../src/singleSide/twoSided/creditCollar/lifecycleShadow";
import { openLedger } from "../src/singleSide/twoSided/creditCollar/collateralLedger";
import type { OpenPosition } from "../src/singleSide/twoSided/creditCollar/forwardSettlement";
import type { OracleTick, PriceSample } from "../src/singleSide/twoSided/creditCollar/referenceOracle";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

const pos = (over: Partial<OpenPosition> = {}): OpenPosition => ({
  ref: "p1",
  side: "long",
  notionalUsdc: 50_000,
  spotAtEntry: 63_000,
  putStrike: 61_000,
  callStrike: 65_000,
  foxifyCreditUsdc: 80,
  serviceFeeUsdc: 0,
  floorPctUsed: 0.03,
  openedAtMs: NOW - 2 * HOUR, // touched 2h into the 24h tenor
  expiresAtMs: NOW + 22 * HOUR,
  ...over
});

const flatIv = (iv: number) => () => iv;

test("lock policy: early cap-side touch at normal vol is DEFERRED (ATM buyback exceeds unvested credit) and never arms", () => {
  const d = assessLock(pos(), "ceiling", 65_000, NOW, flatIv(0.5), { tenorMs: DAY });
  // Vesting: 2h of 24h ⟹ ~1/12 vested.
  assert.ok(Math.abs(d.vestedCreditUsdc - 80 / 12) < 0.5, `vested ${d.vestedCreditUsdc}`);
  assert.ok(Math.abs(d.vestedCreditUsdc + d.unvestedCreditUsdc - 80) < 0.01, "vested + unvested = full credit");
  // ATM short call at 50% vol is worth hundreds — far above the ~$73 unvested budget.
  assert.ok(d.unwindCostUsdc > d.unvestedCreditUsdc, `cost ${d.unwindCostUsdc} vs unvested ${d.unvestedCreditUsdc}`);
  assert.equal(d.permitted, false);
  // √t cost decay never catches the linearly-vanishing unvested credit ⟹ rides to expiry.
  assert.equal(d.lockEtaMs, null);
  // The never-underwater payout cap cannot exceed the vested schedule (and never goes negative).
  assert.ok(d.payoutToFoxifyIfLockedUsdc >= 0 && d.payoutToFoxifyIfLockedUsdc <= d.vestedCreditUsdc + 0.01);
  assert.ok(Math.abs(d.netIfLockedUsdc - (80 - d.unwindCostUsdc)) < 0.01, "net-if-locked = credit − cost");
});

test("lock policy: floor-side touch is PERMITTED (we OWN the ATM leg — unwinding is a net recovery)", () => {
  const d = assessLock(pos(), "floor", 61_000, NOW, flatIv(0.5), { tenorMs: DAY });
  assert.ok(d.unwindCostUsdc < 0, `expected net recovery, got cost ${d.unwindCostUsdc}`);
  assert.equal(d.permitted, true);
  assert.equal(d.lockEtaMs, 0);
});

test("lock policy: calm vol makes even an early cap-side lock affordable", () => {
  const d = assessLock(pos(), "ceiling", 65_000, NOW, flatIv(0.03), { tenorMs: DAY });
  assert.ok(d.unwindCostUsdc > 0 && d.unwindCostUsdc < d.unvestedCreditUsdc, `cost ${d.unwindCostUsdc} vs unvested ${d.unvestedCreditUsdc}`);
  assert.equal(d.permitted, true);
});

test("lock policy: buffer tightens the rule", () => {
  const base = assessLock(pos(), "ceiling", 65_000, NOW, flatIv(0.03), { tenorMs: DAY });
  assert.equal(base.permitted, true);
  const buffered = assessLock(pos(), "ceiling", 65_000, NOW, flatIv(0.03), { tenorMs: DAY, bufferUsdc: base.headroomUsdc + 5 });
  assert.equal(buffered.permitted, false);
});

const samples = (prices: Record<string, number>): PriceSample[] =>
  Object.entries(prices).map(([source, priceUsd]) => ({ source, priceUsd, tsMs: NOW - 100 }));

test("overlay: a cap touch with a vol surface produces a lock-watcher DEFER decision", () => {
  const ticks: OracleTick[] = [0, 1, 2, 3].map((i) => ({ tsMs: NOW + i * 1000, priceUsd: 65_500 })); // above the cap
  const r = reconcileShadowLifecycle({
    open: [pos()],
    nowMs: NOW,
    ticks,
    oracleMedianUsd: 65_500,
    usableSamples: samples({ deribit: 65_500, okx: 65_490 }),
    ledger: openLedger(250_000),
    tenorMs: DAY,
    basisMaxBps: 25,
    persistTicks: 3,
    iv: flatIv(0.5)
  });
  assert.ok(r.report.lockWatcher, "watcher active when iv provided");
  assert.equal(r.report.lockWatcher!.touchesEvaluated, 1);
  assert.equal(r.report.lockWatcher!.locksPermitted, 0);
  assert.equal(r.report.lockWatcher!.locksDeferred, 1);
  assert.equal(r.report.lockWatcher!.decisions[0].barrier, "ceiling");
});

test("overlay: no vol surface ⟹ lock watcher is null (can't price the unwind)", () => {
  const r = reconcileShadowLifecycle({
    open: [pos()],
    nowMs: NOW,
    ticks: [{ tsMs: NOW, priceUsd: 63_000 }],
    oracleMedianUsd: 63_000,
    usableSamples: samples({ deribit: 63_000, okx: 63_005 }),
    ledger: openLedger(250_000),
    tenorMs: DAY,
    basisMaxBps: 25
  });
  assert.equal(r.report.lockWatcher, null);
});
