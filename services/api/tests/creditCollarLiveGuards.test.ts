import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseLiveGuardsFromEnv,
  executionArmed,
  isWindowDue,
  checkNotionalCaps,
  dayUtcOf,
  LIVE_CONFIRM_PHRASE
} from "../src/singleSide/twoSided/creditCollar/execution/liveGuards";
import {
  appendLiveExecution,
  loadLiveExecutions,
  bookedNotionalForDay,
  loadWindowState,
  saveWindowState,
  appendLiveRecon,
  loadLiveRecons,
  hasUnresolvedReconMismatch,
  raiseLiveAlert,
  loadLiveAlerts,
  type LiveExecutionRecord,
  type LiveReconRecord
} from "../src/singleSide/twoSided/creditCollar/execution/liveExecutionStore";

const tmp = mkdtempSync(join(tmpdir(), "live-guards-"));

// ── Kill switch + arming ──────────────────────────────────────────────────────

test("guards: LIVE_ENABLED defaults OFF — nothing is armed", () => {
  const cfg = parseLiveGuardsFromEnv({});
  assert.equal(cfg.liveEnabled, false);
  const armed = executionArmed(cfg);
  assert.equal(armed.armed, false);
  assert.ok(armed.reason.includes("kill-switch"));
});

test("guards: LIVE_ENABLED=true + demo mode arms without the money phrase", () => {
  const cfg = parseLiveGuardsFromEnv({ LIVE_ENABLED: "true" });
  assert.equal(cfg.mode, "demo");
  assert.ok(executionArmed(cfg).armed);
});

test("guards: live mode REFUSES without OKX_LIVE_CONFIRM", () => {
  const cfg = parseLiveGuardsFromEnv({ LIVE_ENABLED: "true", OKX_EXECUTION_MODE: "live" });
  const armed = executionArmed(cfg);
  assert.equal(armed.armed, false);
  assert.ok(armed.reason.includes("OKX_LIVE_CONFIRM"));
});

test("guards: live mode arms with the exact confirmation phrase", () => {
  const cfg = parseLiveGuardsFromEnv({ LIVE_ENABLED: "true", OKX_EXECUTION_MODE: "live", OKX_LIVE_CONFIRM: LIVE_CONFIRM_PHRASE });
  assert.ok(executionArmed(cfg).armed);
});

test("guards: pilot-spec defaults (window 08:15–10:00, caps 50k/100k, band 25%)", () => {
  const cfg = parseLiveGuardsFromEnv({});
  assert.equal(cfg.windowUtc, "08:15");
  assert.equal(cfg.windowLatestUtc, "10:00");
  assert.equal(cfg.maxPositionNotionalUsdc, 50_000);
  assert.equal(cfg.maxDayNotionalUsdc, 100_000);
  assert.equal(cfg.slippageBandPct, 0.25);
  assert.equal(cfg.canaryContracts, null);
});

// ── Window discipline ─────────────────────────────────────────────────────────

const emptyState = { lastAttemptDayUtc: null, lastAttemptTsMs: null, lastOutcome: null };
const winCfg = { windowUtc: "08:15", windowLatestUtc: "10:00" };

test("window: due inside 08:15–10:00, not before, not after (never chase)", () => {
  const day = Date.UTC(2026, 6, 22);
  assert.equal(isWindowDue(day + 8 * 3600e3, emptyState, winCfg).due, false);                    // 08:00 — early
  assert.equal(isWindowDue(day + 8 * 3600e3 + 15 * 60e3, emptyState, winCfg).due, true);         // 08:15
  assert.equal(isWindowDue(day + 9 * 3600e3, emptyState, winCfg).due, true);                     // 09:00
  const late = isWindowDue(day + 14 * 3600e3, emptyState, winCfg);                               // 14:00 — skipped
  assert.equal(late.due, false);
  assert.ok(late.reason.includes("never chase"));
});

test("window: one attempt per UTC day", () => {
  const day = Date.UTC(2026, 6, 22);
  const state = { lastAttemptDayUtc: "2026-07-22", lastAttemptTsMs: day + 8.3 * 3600e3, lastOutcome: "filled" };
  assert.equal(isWindowDue(day + 9 * 3600e3, state, winCfg).due, false);
  // Next day is due again.
  assert.equal(isWindowDue(day + 24 * 3600e3 + 8.5 * 3600e3, state, winCfg).due, true);
});

test("dayUtcOf formats YYYY-MM-DD", () => {
  assert.equal(dayUtcOf(Date.UTC(2026, 6, 22, 8, 15)), "2026-07-22");
});

// ── Notional caps ─────────────────────────────────────────────────────────────

const caps = { maxPositionNotionalUsdc: 50_000, maxDayNotionalUsdc: 100_000 };

test("caps: per-position cap enforced on the effective notional", () => {
  assert.ok(checkNotionalCaps(50_000, 0, caps).ok);
  assert.ok(!checkNotionalCaps(50_001, 0, caps).ok);
});

test("caps: per-day cap counts already-booked notional", () => {
  assert.ok(checkNotionalCaps(50_000, 50_000, caps).ok);
  assert.ok(!checkNotionalCaps(50_000, 51_000, caps).ok);
});

// ── Stores ────────────────────────────────────────────────────────────────────

test("executions store: append/load + day-cap gauge counts only FILLED", () => {
  const path = join(tmp, "exec.jsonl");
  const rec = (outcome: LiveExecutionRecord["outcome"], notional: number, day = "2026-07-22"): LiveExecutionRecord => ({
    tsMs: 1, dayUtc: day, ref: `r${Math.random()}`, side: "long", outcome, mode: "live",
    effectiveNotionalUsdc: notional, contracts: 50, putInstId: "P", callInstId: "C", netCreditUsdc: 70, venueFeeUsdc: 3
  });
  appendLiveExecution(rec("filled", 50_000), path);
  appendLiveExecution(rec("aborted_no_fill", 0), path);
  appendLiveExecution(rec("filled", 48_000, "2026-07-23"), path);
  const all = loadLiveExecutions(path);
  assert.equal(all.length, 3);
  assert.equal(bookedNotionalForDay(all, "2026-07-22"), 50_000);
  assert.equal(bookedNotionalForDay(all, "2026-07-23"), 48_000);
});

test("window state: round-trips and defaults empty", () => {
  const path = join(tmp, "window.json");
  assert.equal(loadWindowState(path).lastAttemptDayUtc, null);
  saveWindowState({ lastAttemptDayUtc: "2026-07-22", lastAttemptTsMs: 5, lastOutcome: "filled" }, path);
  assert.equal(loadWindowState(path).lastAttemptDayUtc, "2026-07-22");
});

test("recon store: unresolved mismatch halts; a later matched record for the same ref releases", () => {
  const path = join(tmp, "recon.jsonl");
  const rec = (ref: string, status: LiveReconRecord["status"], tsMs: number): LiveReconRecord => ({
    tsMs, ref, putInstId: "P", callInstId: "C", ourSettlePriceUsd: 100_000, venueSettlePriceUsd: 100_010,
    priceDiffUsd: -10, ourPayoutUsdc: 0, venueCashFlowUsdc: 0, cashDiffUsdc: 0, toleranceUsdc: 5, status, notes: []
  });
  appendLiveRecon(rec("a", "matched", 1), path);
  assert.equal(hasUnresolvedReconMismatch(loadLiveRecons(path)), false);
  appendLiveRecon(rec("b", "mismatch", 2), path);
  assert.equal(hasUnresolvedReconMismatch(loadLiveRecons(path)), true);
  appendLiveRecon(rec("b", "matched", 3), path); // investigated + re-reconciled
  assert.equal(hasUnresolvedReconMismatch(loadLiveRecons(path)), false);
});

test("recon store: pending_venue_data does NOT halt", () => {
  const path = join(tmp, "recon2.jsonl");
  appendLiveRecon({ tsMs: 1, ref: "x", putInstId: null, callInstId: null, ourSettlePriceUsd: 0, venueSettlePriceUsd: null, priceDiffUsd: null, ourPayoutUsdc: 0, venueCashFlowUsdc: null, cashDiffUsdc: null, toleranceUsdc: 5, status: "pending_venue_data", notes: [] }, path);
  assert.equal(hasUnresolvedReconMismatch(loadLiveRecons(path)), false);
});

test("alerts: persisted and loadable", () => {
  const path = join(tmp, "alerts.jsonl");
  raiseLiveAlert({ tsMs: 1, level: "critical", code: "test", message: "unit-test alert" }, path);
  const alerts = loadLiveAlerts(path);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].code, "test");
});
