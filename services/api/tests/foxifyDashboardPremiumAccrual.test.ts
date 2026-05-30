/**
 * Unit tests for the 2026-05-22 fix to Foxify dashboard premium math.
 *
 * Background: /foxify/positions was sending dailyPremiumUsdc (the per-day
 * RATE) in the `premiumPaidUsdc` field, leading Foxify's dashboard to show
 * "no premium owed". /foxify/today was summing daily rates of positions
 * opened today instead of premium accrued today.
 *
 * Tests cover the pure helper functions added to fix this. Integration with
 * the full dashboard handler is left to the existing dashboard tests; here
 * we only validate the accrual math.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  premiumAccruedInWindowUsdc,
  premiumBillableInWindowUsdc
} from "../src/volumeCover/foxifyDashboard";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test("premiumAccruedInWindowUsdc: full day at $210/d = $210", () => {
  const dayStart = "2026-05-22T00:00:00.000Z";
  const dayEnd = "2026-05-23T00:00:00.000Z";
  const opened = "2026-05-21T00:00:00.000Z"; // opened before window
  const closed = "2026-05-24T00:00:00.000Z"; // closes after window
  const accrued = premiumAccruedInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: closed,
    windowStartIso: dayStart,
    windowEndIso: dayEnd,
    dailyRateUsdc: 210
  });
  assert.equal(accrued.toFixed(2), "210.00");
});

test("premiumAccruedInWindowUsdc: 12h at $210/d = $105", () => {
  const dayStart = "2026-05-22T00:00:00.000Z";
  const dayEnd = "2026-05-23T00:00:00.000Z";
  const opened = "2026-05-22T12:00:00.000Z"; // mid-day open
  const accrued = premiumAccruedInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: null,
    windowStartIso: dayStart,
    windowEndIso: dayEnd,
    dailyRateUsdc: 210,
    nowMs: new Date("2026-05-23T00:00:00.000Z").getTime()
  });
  assert.equal(accrued.toFixed(2), "105.00");
});

test("premiumAccruedInWindowUsdc: closed within window = partial", () => {
  const dayStart = "2026-05-22T00:00:00.000Z";
  const dayEnd = "2026-05-23T00:00:00.000Z";
  const opened = "2026-05-22T00:00:00.000Z";
  const closed = "2026-05-22T06:00:00.000Z"; // closed 6h into window
  const accrued = premiumAccruedInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: closed,
    windowStartIso: dayStart,
    windowEndIso: dayEnd,
    dailyRateUsdc: 210
  });
  // 6/24 × 210 = 52.50
  assert.equal(accrued.toFixed(2), "52.50");
});

test("premiumAccruedInWindowUsdc: opened after window end = 0", () => {
  const dayStart = "2026-05-22T00:00:00.000Z";
  const dayEnd = "2026-05-23T00:00:00.000Z";
  const opened = "2026-05-23T05:00:00.000Z"; // opens tomorrow
  const accrued = premiumAccruedInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: null,
    windowStartIso: dayStart,
    windowEndIso: dayEnd,
    dailyRateUsdc: 210,
    nowMs: new Date("2026-05-23T07:00:00.000Z").getTime()
  });
  assert.equal(accrued, 0);
});

test("premiumAccruedInWindowUsdc: closed before window start = 0", () => {
  const dayStart = "2026-05-22T00:00:00.000Z";
  const dayEnd = "2026-05-23T00:00:00.000Z";
  const opened = "2026-05-20T00:00:00.000Z";
  const closed = "2026-05-21T12:00:00.000Z"; // closed yesterday
  const accrued = premiumAccruedInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: closed,
    windowStartIso: dayStart,
    windowEndIso: dayEnd,
    dailyRateUsdc: 210
  });
  assert.equal(accrued, 0);
});

test("premiumAccruedInWindowUsdc: hourly precision (not whole-day rounding)", () => {
  // weeklyReconciler.daysActiveInWindow rounds UP to whole days for
  // settlement, but the dashboard must show smooth real-time accrual.
  // 1.5h at $240/d should be exactly $15 (240/24 × 1.5).
  const start = "2026-05-22T00:00:00.000Z";
  const end = "2026-05-22T01:30:00.000Z";
  const accrued = premiumAccruedInWindowUsdc({
    openedAtIso: start,
    closedAtIso: end,
    windowStartIso: start,
    windowEndIso: "2026-05-23T00:00:00.000Z",
    dailyRateUsdc: 240
  });
  assert.equal(accrued.toFixed(4), "15.0000");
});

test("premiumAccruedInWindowUsdc: zero daily rate = 0", () => {
  const accrued = premiumAccruedInWindowUsdc({
    openedAtIso: "2026-05-22T00:00:00.000Z",
    closedAtIso: null,
    windowStartIso: "2026-05-22T00:00:00.000Z",
    windowEndIso: "2026-05-23T00:00:00.000Z",
    dailyRateUsdc: 0,
    nowMs: new Date("2026-05-23T00:00:00.000Z").getTime()
  });
  assert.equal(accrued, 0);
});

test("premiumAccruedInWindowUsdc: realistic vc-pos-e41890f0 scenario", () => {
  // Position opened Thu 2026-05-21 12:13:48 UTC at $210/d.
  // Today's UTC window: Fri 2026-05-22 00:00:00 → Sat 2026-05-23 00:00:00.
  // Position is still alive (still accruing). Expected today:
  //   full 24h at $210/d = $210.00
  // (Position spans the entire UTC day Fri.)
  const opened = "2026-05-21T12:13:48.000Z";
  const dayStart = "2026-05-22T00:00:00.000Z";
  const dayEnd = "2026-05-23T00:00:00.000Z";
  const accrued = premiumAccruedInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: null,
    windowStartIso: dayStart,
    windowEndIso: dayEnd,
    dailyRateUsdc: 210,
    nowMs: new Date("2026-05-23T00:00:00.000Z").getTime()
  });
  assert.equal(accrued.toFixed(2), "210.00");
});

test("premiumAccruedInWindowUsdc: vc-pos-e41890f0 since-open accrual", () => {
  // Premium accrued since open (not bounded by a day window).
  // Opened Thu 12:13:48 UTC; "now" is Fri 23:20 UTC. That's 35h 6min ≈ 1.46d.
  // Expected: 1.46 × $210 ≈ $306.83.
  const opened = "2026-05-21T12:13:48.000Z";
  const now = new Date("2026-05-22T23:20:00.000Z").getTime();
  const accrued = premiumAccruedInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: null,
    // window from open to now ≡ cumulative since-open
    windowStartIso: opened,
    windowEndIso: new Date(now).toISOString(),
    dailyRateUsdc: 210,
    nowMs: now
  });
  assert.ok(accrued > 305 && accrued < 308, `expected ~$306.83, got ${accrued.toFixed(2)}`);
});

// ─── Billable (per-day round-up) tests ──────────────────────────────────────

test("premiumBillableInWindowUsdc: any portion of one day = 1 day billable", () => {
  // 11.78h overlap (Thu open at 12:13 → Thu 24:00) rounds UP to 1 day.
  const billable = premiumBillableInWindowUsdc({
    openedAtIso: "2026-05-21T12:13:00.000Z",
    closedAtIso: null,
    windowStartIso: "2026-05-21T00:00:00.000Z",
    windowEndIso: "2026-05-22T00:00:00.000Z",
    dailyRateUsdc: 210,
    nowMs: new Date("2026-05-22T00:00:00.000Z").getTime()
  });
  assert.equal(billable, 210);
});

test("premiumBillableInWindowUsdc: vc-pos-e41890f0 lifetime = 2 days = $420", () => {
  // Opened Thu 2026-05-21 12:13:48 UTC at $210/d. "Now" is Fri 23:54 UTC.
  // ceil(35.7h / 24h) = 2 days → $420 billable.
  const opened = "2026-05-21T12:13:48.000Z";
  const now = new Date("2026-05-22T23:54:00.000Z").getTime();
  const billable = premiumBillableInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: null,
    windowStartIso: opened,
    windowEndIso: new Date(now).toISOString(),
    dailyRateUsdc: 210,
    nowMs: now
  });
  assert.equal(billable, 420);
});

test("premiumBillableInWindowUsdc: exactly 24h = 1 day (not 2)", () => {
  const billable = premiumBillableInWindowUsdc({
    openedAtIso: "2026-05-21T00:00:00.000Z",
    closedAtIso: "2026-05-22T00:00:00.000Z",
    windowStartIso: "2026-05-21T00:00:00.000Z",
    windowEndIso: "2026-05-22T00:00:00.000Z",
    dailyRateUsdc: 210
  });
  // 24.0h / 24h = exactly 1.0 → ceil → 1 day. (Strictly: 86400000/86400000 = 1)
  assert.equal(billable, 210);
});

test("premiumBillableInWindowUsdc: 24h + 1 minute = 2 days", () => {
  const billable = premiumBillableInWindowUsdc({
    openedAtIso: "2026-05-21T00:00:00.000Z",
    closedAtIso: "2026-05-22T00:01:00.000Z",
    windowStartIso: "2026-05-21T00:00:00.000Z",
    windowEndIso: "2026-05-23T00:00:00.000Z",
    dailyRateUsdc: 210
  });
  // ceil(24.0167h / 24h) = 2 days
  assert.equal(billable, 420);
});

test("premiumBillableInWindowUsdc: zero overlap = 0", () => {
  const billable = premiumBillableInWindowUsdc({
    openedAtIso: "2026-05-23T00:00:00.000Z",
    closedAtIso: null,
    windowStartIso: "2026-05-21T00:00:00.000Z",
    windowEndIso: "2026-05-22T00:00:00.000Z",
    dailyRateUsdc: 210,
    nowMs: new Date("2026-05-23T05:00:00.000Z").getTime()
  });
  assert.equal(billable, 0);
});

test("billable vs accrued: contractual vs real-time on a partial day", () => {
  // Same window. 6h active.
  // Accrued: 6/24 × $210 = $52.50.
  // Billable: ceil(6/24) = 1 day = $210.
  const args = {
    openedAtIso: "2026-05-22T00:00:00.000Z",
    closedAtIso: "2026-05-22T06:00:00.000Z",
    windowStartIso: "2026-05-22T00:00:00.000Z",
    windowEndIso: "2026-05-23T00:00:00.000Z",
    dailyRateUsdc: 210
  } as const;
  const accrued = premiumAccruedInWindowUsdc(args);
  const billable = premiumBillableInWindowUsdc(args);
  assert.equal(accrued.toFixed(2), "52.50");
  assert.equal(billable, 210);
});
