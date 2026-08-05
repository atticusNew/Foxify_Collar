import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardModel, renderDashboardHtml, renderSimpleHtml, handleDashboardRequest, type ShadowLiveStatus } from "../src/singleSide/twoSided/creditCollar/shadowDashboard";
import type { ShadowRunRecord } from "../src/singleSide/twoSided/creditCollar/shadowAggregate";
import type { ShadowScorecard } from "../src/singleSide/twoSided/creditCollar/shadowRunner";

const NOW = 1_800_000_000_000;
const INTERVAL = 900_000;

const sc = (over: Partial<ShadowScorecard> = {}): ShadowScorecard => ({
  label: "tier0_shadow_paper_settled", mode: "shadow",
  oracle: { status: "healthy", priceUsd: 62_000, safeForActivation: true, signatureValid: true },
  attempted: 20, opened: 20, openedNotionalUsdc: 1_000_000, halted: 0, rejected: 0, rejectionsByReason: {},
  peakNetExposureRatio: 0.09, peakNetNotionalUsdc: 50_000, maxFloorPctUsed: 0.04, avgFloorPctUsed: 0.04, serviceFeeAccruedUsdc: 200, foxifyCreditAccruedUsdc: 1_500,
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
  assert.ok(html.includes("Atticus Volume Facility — Shadow Pilot"));
  assert.ok(html.includes("RUNNING"));
  assert.ok(/verdict/i.test(html));
  assert.ok(html.includes("/api/scorecard"));
});

test("simple view: renders plain-English P&L and cross-links the advanced view", () => {
  const settlement = {
    settledPositions: 100, totalCreditAccruedUsdc: 9_000, totalPayoutToFoxifyUsdc: -1_200,
    totalNetToFoxifyUsdc: 7_800, totalOptionFeesUsdc: 2_600, totalHedgeReceiptUsdc: -1_200,
    totalAtticusNetAfterFeesAndCapitalUsdc: 980, netAfterFeesAndCapitalBps: 1.96, bookHedgedNetBps: 0,
    avgHeldHours: 24.1, pctCapBreached: 0.12, pctFloorBreached: 0
  } as unknown as Parameters<typeof buildDashboardModel>[4];
  const model = buildDashboardModel([rec(NOW - 30_000)], status(), NOW, {}, settlement);
  const html = renderSimpleHtml(model);
  assert.ok(html.includes("Simple P&L"));
  assert.ok(/Client COLLECTS/i.test(html));
  assert.ok(!/foxify/i.test(html), "rendered pages must not name the former partner");
  assert.ok(/Atticus FLAT/i.test(html));
  assert.ok(html.includes("Advanced view"));
});

test("positions view renders open + settled with leg premiums and plain-words fields", async () => {
  const { renderPositionsHtml } = await import("../src/singleSide/twoSided/creditCollar/shadowDashboard");
  const open = [{
    ref: "cc-123-1", side: "long" as const, notionalUsdc: 50_000, spotAtEntry: 60_000, putStrike: 56_400, callStrike: 61_250,
    foxifyCreditUsdc: 80, serviceFeeUsdc: 0, floorPctUsed: 0.06, openedAtMs: NOW - 3_600_000, expiresAtMs: NOW + 20 * 3_600_000,
    fundingLegPremiumUsdc: 128.4, protectiveLegPremiumUsdc: 40.2, venue: "g20_quote",
    quoteMeta: { rfqRef: "RFQ-1", quotedNetUsdc: 82, modelNetUsdc: 79, quotedAtIso: new Date(NOW).toISOString() }
  }];
  const settled = [{
    ref: "cc-100-9", side: "short" as const, notionalUsdc: 50_000, spotAtEntry: 60_000, settlePriceUsd: 60_500, movePct: 0.0083,
    putIntrinsicUsd: 0, callIntrinsicUsd: 0, payoutToFoxifyUsdc: 0, foxifyCreditUsdc: 85, netToFoxifyUsdc: 85, serviceFeeUsdc: 0,
    floorBreached: false, capBreached: false, oracleVerified: true, openedAtMs: NOW - 25 * 3_600_000, settledAtMs: NOW - 3_600_000,
    heldMs: 24 * 3_600_000, hedgeReceiptUsdc: 0, atticusOptionNetUsdc: 0, shortLegMarginUsdc: 546, capitalCostUsdc: 0.18,
    optionFeesUsdc: 8, atticusNetAfterCapitalUsdc: -0.18, atticusNetAfterFeesAndCapitalUsdc: -0.18,
    fundingLegPremiumUsdc: 120, protectiveLegPremiumUsdc: 35, venue: "okx_model"
  }];
  const html = renderPositionsHtml(open, settled, NOW);
  assert.ok(html.includes("SOLD cap for") && html.includes("PAID for floor"));
  assert.ok(html.includes("g20_quote") && html.includes("okx_model"));
  assert.ok(html.includes("quoted") && html.includes("vs model"));
  assert.ok(/no breach/.test(html));
});

test("?fee= override flows into the Foxify/regime views; no fee assumed by default", () => {
  const captured: Array<number | undefined> = [];
  const deps = {
    loadRecords: () => [rec(NOW - 30_000)],
    liveStatus: () => status(),
    nowMs: () => NOW,
    foxifyView: (fee?: number) => {
      captured.push(fee);
      return null;
    }
  };
  handleDashboardRequest({ method: "GET", path: "/simple" }, deps);
  handleDashboardRequest({ method: "GET", path: "/simple?fee=25" }, deps);
  handleDashboardRequest({ method: "GET", path: "/api/scorecard?fee=42.5" }, deps);
  assert.deepEqual(captured, [undefined, 25, 42.5], "no override by default; ?fee= parsed and passed through");
});

test("handler: /simple returns html", () => {
  const deps = { loadRecords: () => [rec(NOW - 30_000)], liveStatus: () => status(), nowMs: () => NOW };
  const r = handleDashboardRequest({ method: "GET", path: "/simple" }, deps);
  assert.equal(r.statusCode, 200);
  assert.ok(r.contentType.includes("text/html"));
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
