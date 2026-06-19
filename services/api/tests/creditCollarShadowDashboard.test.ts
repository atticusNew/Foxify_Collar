import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardModel, renderDashboardHtml, handleDashboardRequest, type ShadowLiveStatus } from "../src/singleSide/twoSided/creditCollar/shadowDashboard";
import type { ShadowRunRecord } from "../src/singleSide/twoSided/creditCollar/shadowAggregate";
import type { ShadowScorecard } from "../src/singleSide/twoSided/creditCollar/shadowRunner";

const NOW = 1_800_000_000_000;
const INTERVAL = 900_000;

const sc = (over: Partial<ShadowScorecard> = {}): ShadowScorecard => ({
  label: "tier0_shadow_paper_settled", mode: "shadow",
  oracle: { status: "healthy", priceUsd: 62_000, safeForActivation: true, signatureValid: true },
  attempted: 20, opened: 20, openedNotionalUsdc: 1_000_000, halted: 0, rejected: 0, rejectionsByReason: {},
  peakNetExposureRatio: 0.09, peakNetNotionalUsdc: 50_000, serviceFeeAccruedUsdc: 200, foxifyCreditAccruedUsdc: 1_500,
  settlements: 20, allSettledOracleVerified: true, allReconciled: true, totalPayoutToFoxifyUsdc: -120,
  totalNetToFoxifyUsdc: 1_380, settlementPriceUsd: 62_000, lifecycleComplete: true, notes: [], ...over
});
const rec = (tsMs: number, over: Partial<ShadowScorecard> = {}): ShadowRunRecord => ({ tsMs, scorecard: sc(over) });
const status = (over: Partial<ShadowLiveStatus> = {}): ShadowLiveStatus => ({
  loopActive: true, intervalMs: INTERVAL, startedAtMs: NOW - 3_600_000, cyclesRun: 4,
  lastRunAtMs: NOW - 60_000, lastRunOk: true, lastError: null, ...over
});

test("dashboard model: RUNNING when last cycle is recent; STALE when overdue; DOWN when loop inactive", () => {
  assert.equal(buildDashboardModel([rec(NOW - 60_000)], status(), NOW).liveness.state, "RUNNING");
  assert.equal(buildDashboardModel([rec(NOW)], status({ lastRunAtMs: NOW - INTERVAL * 5 }), NOW).liveness.state, "STALE");
  assert.equal(buildDashboardModel([], status({ loopActive: false }), NOW).liveness.state, "DOWN");
  assert.equal(buildDashboardModel([], status({ lastRunAtMs: null }), NOW).liveness.state, "STARTING");
});

test("dashboard model: surfaces aggregate verdict + recent sessions", () => {
  const records = Array.from({ length: 12 }, (_, i) => rec(NOW - i * INTERVAL));
  const m = buildDashboardModel(records, status(), NOW);
  assert.equal(m.running, true);
  assert.equal(m.aggregate.verdict, "TRACK_RECORD_CLEAN");
  assert.equal(m.aggregate.economics.realizedServiceFeeBps, 2);
  assert.ok(m.recentSessions.length <= 15 && m.recentSessions.length === 12);
  // recent sorted newest-first
  assert.ok(m.recentSessions[0].tsIso >= m.recentSessions[1].tsIso);
});

test("dashboard HTML renders and shows RUNNING + verdict", () => {
  const html = renderDashboardHtml(buildDashboardModel([rec(NOW - 30_000)], status(), NOW));
  assert.ok(html.includes("Credit-Collar Tier-0 Shadow"));
  assert.ok(html.includes("RUNNING"));
  assert.ok(/verdict/i.test(html));
  assert.ok(html.includes("/api/scorecard"));
});

test("handler: routes / (html), /api/scorecard (json), /api/health (running), /healthz", () => {
  const deps = { loadRecords: () => [rec(NOW - 30_000)], liveStatus: () => status(), nowMs: () => NOW };
  assert.equal(handleDashboardRequest({ method: "GET", path: "/" }, deps).contentType.includes("text/html"), true);
  const sccard = handleDashboardRequest({ method: "GET", path: "/api/scorecard" }, deps);
  assert.equal(sccard.statusCode, 200);
  assert.equal(JSON.parse(sccard.body).running, true);
  const health = handleDashboardRequest({ method: "GET", path: "/api/health" }, deps);
  assert.equal(health.statusCode, 200);
  assert.equal(handleDashboardRequest({ method: "GET", path: "/healthz" }, deps).body, "ok");
  assert.equal(handleDashboardRequest({ method: "POST", path: "/" }, deps).statusCode, 405);
  assert.equal(handleDashboardRequest({ method: "GET", path: "/nope" }, deps).statusCode, 404);
});

test("handler: stale loop ⟹ /api/health returns 503", () => {
  const deps = { loadRecords: () => [rec(NOW)], liveStatus: () => status({ lastRunAtMs: NOW - INTERVAL * 5 }), nowMs: () => NOW };
  assert.equal(handleDashboardRequest({ method: "GET", path: "/api/health" }, deps).statusCode, 503);
});

test("handler: optional token gates / and /api but not /healthz", () => {
  const deps = { loadRecords: () => [rec(NOW)], liveStatus: () => status(), token: "secret", nowMs: () => NOW };
  assert.equal(handleDashboardRequest({ method: "GET", path: "/" }, deps).statusCode, 401);
  assert.equal(handleDashboardRequest({ method: "GET", path: "/", authorization: "Bearer secret" }, deps).statusCode, 200);
  assert.equal(handleDashboardRequest({ method: "GET", path: "/healthz" }, deps).statusCode, 200, "infra check is unauthenticated");
});
