/**
 * Unit tests for the 2026-05-24 (PR-E) fix to the Foxify dashboard premium
 * projection. Premium accrual stops at trigger time per the contract — and
 * the ledger entry written by fireTrigger() honors this cap. Before PR-E,
 * the dashboard's projection function continued accruing past trigger for
 * any position stuck in `status='triggered'` until it was eventually closed,
 * which over-displayed premium by (now − triggeredAt) × dailyRate.
 *
 * The May 22-24, 2026 incident:
 *   - 30k_2pct_600 triggered Fri May 22 22:44 UTC, billed at trigger $420 (2d).
 *     Foxify left it stuck in `triggered`. Dash showed $840 (4d) by May 24.
 *   - 50k_2pct_1k triggered Sat May 23 20:56 UTC, billed at trigger $350 (1d).
 *     Same Foxify-side bug. Dash showed $700 (2d) by May 24.
 *   - SALVAGE-TEST-0: $1/d × 1d = $1 billed at trigger. Dash matched correctly
 *     (both fields advanced together for $1/d), but only because nobody noticed.
 *
 * These tests pin the invariant: when triggeredAtIso is supplied, both
 * accrued and billable projections cap at min(triggered, closed, now). When
 * triggeredAtIso is null/undefined, behavior is unchanged (backward-compat).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  premiumAccruedInWindowUsdc,
  premiumBillableInWindowUsdc
} from "../src/volumeCover/foxifyDashboard";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test("PR-E billable: triggeredAtIso caps right edge before now", () => {
  // Reproduces the 30k_2pct_600 May 22-24 case.
  // Opened Thu May 21 12:13:48 UTC.
  // Triggered Fri May 22 22:44:17 UTC (~34.5h later).
  // "Now" Sun May 24 21:24 UTC (lookback at incident time).
  // Without PR-E: ceil(81/24) = 4 days × $210 = $840 (WRONG)
  // With PR-E:    ceil(34.5/24) = 2 days × $210 = $420 (CORRECT)
  const opened = "2026-05-21T12:13:48.000Z";
  const triggered = "2026-05-22T22:44:17.000Z";
  const nowMs = new Date("2026-05-24T21:24:00.000Z").getTime();
  const billable = premiumBillableInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: null,
    triggeredAtIso: triggered,
    windowStartIso: opened,
    windowEndIso: new Date(nowMs).toISOString(),
    dailyRateUsdc: 210,
    nowMs
  });
  assert.equal(billable, 420);
});

test("PR-E billable: 50k_2pct_1k incident reproduction", () => {
  // Opened Sat May 23 15:06:51 UTC.
  // Triggered Sat May 23 20:56:48 UTC (~5h50m later — same UTC day).
  // "Now" Sun May 24 21:24 UTC.
  // Without PR-E: ceil(30.3h/24) = 2 days × $350 = $700 (WRONG)
  // With PR-E:    ceil(5.83h/24) = 1 day × $350 = $350 (CORRECT)
  const opened = "2026-05-23T15:06:51.000Z";
  const triggered = "2026-05-23T20:56:48.000Z";
  const nowMs = new Date("2026-05-24T21:24:00.000Z").getTime();
  const billable = premiumBillableInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: null,
    triggeredAtIso: triggered,
    windowStartIso: opened,
    windowEndIso: new Date(nowMs).toISOString(),
    dailyRateUsdc: 350,
    nowMs
  });
  assert.equal(billable, 350);
});

test("PR-E accrued: triggeredAtIso caps hourly-precision accrual", () => {
  // 30k position: opened Thu 12:13:48, triggered Fri 22:44:17 → 34.51h.
  // Accrued = 34.51/24 × $210 = $301.96.
  // Without PR-E (using now ~57h post-trigger): would be ~$795.
  const opened = "2026-05-21T12:13:48.000Z";
  const triggered = "2026-05-22T22:44:17.000Z";
  const nowMs = new Date("2026-05-24T21:24:00.000Z").getTime();
  const accrued = premiumAccruedInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: null,
    triggeredAtIso: triggered,
    windowStartIso: opened,
    windowEndIso: new Date(nowMs).toISOString(),
    dailyRateUsdc: 210,
    nowMs
  });
  // 34.5081h × $210/24 = $301.95
  assert.equal(accrued.toFixed(2), "301.95");
});

test("PR-E: triggeredAtIso=null (active position) preserves old behavior", () => {
  // No trigger yet → triggeredMs = +Infinity → cap is closedMs/now.
  const opened = "2026-05-22T12:00:00.000Z";
  const nowMs = new Date("2026-05-23T00:00:00.000Z").getTime(); // 12h after open
  const billable = premiumBillableInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: null,
    triggeredAtIso: null,
    windowStartIso: opened,
    windowEndIso: new Date(nowMs).toISOString(),
    dailyRateUsdc: 210,
    nowMs
  });
  // ceil(12/24) = 1 day → $210, same as old behavior with no triggeredAt param.
  assert.equal(billable, 210);
});

test("PR-E: triggeredAtIso undefined (call sites unchanged) preserves old behavior", () => {
  // Backward-compat for tests/callers that don't pass the new field.
  const opened = "2026-05-22T12:00:00.000Z";
  const nowMs = new Date("2026-05-23T06:00:00.000Z").getTime(); // 18h after open
  const billable = premiumBillableInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: null,
    windowStartIso: opened,
    windowEndIso: new Date(nowMs).toISOString(),
    dailyRateUsdc: 210,
    nowMs
  });
  // ceil(18/24) = 1 day → $210.
  assert.equal(billable, 210);
});

test("PR-E: triggered THEN closed — caps at the EARLIER (triggered)", () => {
  // Triggered Fri at 22:00, closed Sat at 12:00 (14h gap). Premium freezes at
  // trigger, not at close. Without this rule we'd over-bill the gap.
  const opened = "2026-05-22T00:00:00.000Z";
  const triggered = "2026-05-22T22:00:00.000Z"; // 22h post-open
  const closed = "2026-05-23T12:00:00.000Z"; // 36h post-open
  const billable = premiumBillableInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: closed,
    triggeredAtIso: triggered,
    windowStartIso: opened,
    windowEndIso: closed,
    dailyRateUsdc: 210
  });
  // Should cap at triggered → 22h overlap → ceil(22/24)=1 → $210.
  // Without the cap → 36h overlap → ceil(36/24)=2 → $420.
  assert.equal(billable, 210);
});

test("PR-E: closed BEFORE trigger ever fired (Foxify-close path) caps at closed", () => {
  // Position closed by Foxify before any trigger fired. triggeredAt=null.
  // Right edge should be closedAt, same as pre-PR-E behavior.
  const opened = "2026-05-22T00:00:00.000Z";
  const closed = "2026-05-22T18:00:00.000Z";
  const billable = premiumBillableInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: closed,
    triggeredAtIso: null,
    windowStartIso: opened,
    windowEndIso: "2026-05-23T00:00:00.000Z",
    dailyRateUsdc: 210
  });
  // 18h overlap → ceil(18/24)=1 → $210.
  assert.equal(billable, 210);
});

test("PR-E: SALVAGE-TEST-0 ($1/d, triggered 1s after open) bills $1", () => {
  // Reproduces the SALVAGE-TEST-0 fixture: opened May 18 03:06:10, triggered
  // 1 second later. dailyPremiumUsdc=$1. Without PR-E and 6+ days of dash
  // visibility, would have shown $7. With PR-E: ceil(1s/86400000) = 1 day → $1.
  const opened = "2026-05-18T03:06:10.000Z";
  const triggered = "2026-05-18T03:06:11.000Z";
  const nowMs = new Date("2026-05-24T21:24:00.000Z").getTime();
  const billable = premiumBillableInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: null,
    triggeredAtIso: triggered,
    windowStartIso: opened,
    windowEndIso: new Date(nowMs).toISOString(),
    dailyRateUsdc: 1,
    nowMs
  });
  assert.equal(billable, 1);
});

test("PR-E today-window: triggered before today excludes today's window from accrual", () => {
  // Position triggered yesterday. Today's window starts at 00:00 UTC. The
  // trigger cap is BEFORE the window start, so today should add $0 to the
  // /foxify/today aggregate (versus the pre-fix behavior of adding 24h ×
  // hourly rate / 1 full billable day).
  const opened = "2026-05-22T10:00:00.000Z";
  const triggered = "2026-05-22T16:00:00.000Z";
  const todayStart = "2026-05-23T00:00:00.000Z";
  const todayEnd = "2026-05-24T00:00:00.000Z";
  const accrued = premiumAccruedInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: null,
    triggeredAtIso: triggered,
    windowStartIso: todayStart,
    windowEndIso: todayEnd,
    dailyRateUsdc: 350
  });
  const billable = premiumBillableInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: null,
    triggeredAtIso: triggered,
    windowStartIso: todayStart,
    windowEndIso: todayEnd,
    dailyRateUsdc: 350
  });
  assert.equal(accrued, 0);
  assert.equal(billable, 0);
});

test("PR-E today-window: triggered mid-day caps accrual at trigger moment", () => {
  // Position triggered today at 06:00 UTC (6h into the day). Today's window
  // accrual should be 6h × hourly rate, billable should be 1 day (any portion).
  const opened = "2026-05-22T22:00:00.000Z";
  const triggered = "2026-05-23T06:00:00.000Z";
  const todayStart = "2026-05-23T00:00:00.000Z";
  const todayEnd = "2026-05-24T00:00:00.000Z";
  const accrued = premiumAccruedInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: null,
    triggeredAtIso: triggered,
    windowStartIso: todayStart,
    windowEndIso: todayEnd,
    dailyRateUsdc: 350,
    nowMs: new Date("2026-05-23T20:00:00.000Z").getTime()
  });
  // Today-window overlap: 00:00 to 06:00 = 6h → 6/24 × $350 = $87.50.
  assert.equal(accrued.toFixed(2), "87.50");
  const billable = premiumBillableInWindowUsdc({
    openedAtIso: opened,
    closedAtIso: null,
    triggeredAtIso: triggered,
    windowStartIso: todayStart,
    windowEndIso: todayEnd,
    dailyRateUsdc: 350,
    nowMs: new Date("2026-05-23T20:00:00.000Z").getTime()
  });
  // Today-window overlap: 6h → ceil(6/24) = 1 day × $350 = $350.
  assert.equal(billable, 350);
});

test("PR-E lifetime: stuck-in-triggered does not over-bill vs ledger truth", () => {
  // Combined lifetime sum across the two real positions from the May 22-24
  // incident. Pre-fix: $840 + $700 = $1540. Post-fix: $420 + $350 = $770.
  // The ledger has $770 (matches what fireTrigger wrote at trigger time).
  const nowMs = new Date("2026-05-24T21:24:00.000Z").getTime();
  const cell30k = premiumBillableInWindowUsdc({
    openedAtIso: "2026-05-21T12:13:48.000Z",
    closedAtIso: null,
    triggeredAtIso: "2026-05-22T22:44:17.000Z",
    windowStartIso: "2026-05-21T12:13:48.000Z",
    windowEndIso: new Date(nowMs).toISOString(),
    dailyRateUsdc: 210,
    nowMs
  });
  const cell50k = premiumBillableInWindowUsdc({
    openedAtIso: "2026-05-23T15:06:51.000Z",
    closedAtIso: null,
    triggeredAtIso: "2026-05-23T20:56:48.000Z",
    windowStartIso: "2026-05-23T15:06:51.000Z",
    windowEndIso: new Date(nowMs).toISOString(),
    dailyRateUsdc: 350,
    nowMs
  });
  assert.equal(cell30k + cell50k, 770);
});
