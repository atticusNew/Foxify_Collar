#!/usr/bin/env tsx
/**
 * Credit-Collar Tier-0 SHADOW service — Render web entrypoint (read-only dashboard + shadow loop in
 * ONE process, ONE disk). It (a) runs a shadow lifecycle every SHADOW_LOOP_INTERVAL_MS and appends
 * the scorecard to the disk-backed track record, and (b) serves a small dashboard:
 *   GET /              → HTML dashboard (scorecard + RUNNING heartbeat)
 *   GET /api/scorecard → full JSON model
 *   GET /api/health    → liveness (200 running / 503 stale)  · GET /healthz → infra check
 * NO trading; paper settlement; live tiers OFF. Optional read-only token: SHADOW_DASHBOARD_TOKEN.
 */

import { createServer } from "node:http";
import { runLiveShadowSession, type LiveShadowConfig } from "../src/singleSide/twoSided/creditCollar/shadowRunner";
import { runForwardShadowCycle, loadSettlementAggregate } from "../src/singleSide/twoSided/creditCollar/forwardShadow";
import { appendScorecard, loadScorecards } from "../src/singleSide/twoSided/creditCollar/shadowStore";
import { handleDashboardRequest, type ShadowLiveStatus } from "../src/singleSide/twoSided/creditCollar/shadowDashboard";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

const intervalMs = num(process.env.SHADOW_LOOP_INTERVAL_MS, 900_000);
const port = num(process.env.PORT, 10_000);
const token = process.env.SHADOW_DASHBOARD_TOKEN;
const haltBand = num(process.env.SHADOW_BREAKER_HALT, 0.15);
const forwardSettle = String(process.env.SHADOW_FORWARD_SETTLE ?? "true").toLowerCase() !== "false";
const settlementHorizonMin = num(process.env.SHADOW_SETTLEMENT_HORIZON_MIN, 60); // positions settle 1h later (real move)

// Measured capital inputs (Deribit margin sweep + PM-netting) → capital-aware net bps on the dashboard.
const capitalConfig = {
  shortOptionImFraction: num(process.env.SHADOW_SHORT_OPTION_IM_FRACTION, 0.1393),
  shortOptionGrossNotionalFraction: num(process.env.SHADOW_SHORT_OPTION_GROSS_FRACTION, 1.0),
  portfolioMarginNettingFactor: num(process.env.SHADOW_PM_NETTING, 1.0),
  costOfCapitalAnnual: num(process.env.SHADOW_COST_OF_CAPITAL, 0.12),
  tenorDays: num(process.env.HARNESS_TENOR_DAYS, 1)
};

const cfg: LiveShadowConfig = {
  positionNotionalUsdc: num(process.env.SHADOW_POSITION_USDC, 50_000),
  feeUsdc: num(process.env.HARNESS_FEE_USDC, 75),
  serviceFeeBps: num(process.env.HARNESS_SERVICE_FEE_BPS, 2),
  minServiceFeeUsdc: num(process.env.HARNESS_MIN_SERVICE_FEE_USDC, 10),
  tenorDays: num(process.env.HARNESS_TENOR_DAYS, 1),
  maxFloorPct: num(process.env.HARNESS_MAX_FLOOR_PCT, 0.04),
  nPositions: num(process.env.SHADOW_N_POSITIONS, 20),
  tier0CapUsdc: num(process.env.SHADOW_TIER0_CAP_USDC, 1_000_000),
  breaker: {
    warnBandPct: num(process.env.SHADOW_BREAKER_WARN, 0.1),
    haltBandPct: haltBand,
    resumeBandPct: num(process.env.SHADOW_BREAKER_RESUME, 0.08),
    minGrossNotionalUsd: num(process.env.SHADOW_BREAKER_MIN_GROSS, 500_000),
    maxAbsNetNotionalUsd: num(process.env.SHADOW_BREAKER_MAX_ABS_NET, 200_000)
  },
  policy: { targetNetBandPct: num(process.env.SHADOW_TARGET_BAND, 0.1), allowDirectionalBias: false, directionalTiltSigned: 0 },
  bullishWeight: num(process.env.HARNESS_BULLISH_WEIGHT, 0.15),
  settlementWindowMin: num(process.env.SHADOW_SETTLEMENT_WINDOW_MIN, 30),
  seed: num(process.env.SHADOW_SEED, 42),
  adaptiveFloor: {
    enabled: String(process.env.SHADOW_ADAPTIVE_FLOOR ?? "true").toLowerCase() !== "false",
    maxFloorCapPct: num(process.env.SHADOW_ADAPTIVE_FLOOR_CAP, 0.1),
    stepPct: num(process.env.SHADOW_ADAPTIVE_FLOOR_STEP, 0.005)
  },
  oraclePrivateKeyPem: process.env.ORACLE_PRIVATE_KEY_PEM,
  oraclePublicKeyPem: process.env.ORACLE_PUBLIC_KEY_PEM
};

const status: ShadowLiveStatus = {
  loopActive: true,
  intervalMs,
  startedAtMs: Date.now(),
  cyclesRun: 0,
  lastRunAtMs: null,
  lastRunOk: null,
  lastError: null
};

const runCycle = async () => {
  try {
    status.cyclesRun += 1;
    status.lastRunAtMs = Date.now();
    if (forwardSettle) {
      const res = await runForwardShadowCycle({ ...cfg, settlementHorizonMin });
      if (res.ok) {
        appendScorecard({ tsMs: status.lastRunAtMs, scorecard: res.openingScorecard, spotUsd: res.meta.spotUsd, oracleSources: res.meta.oracleSources });
        status.lastRunOk = true;
        status.lastError = null;
        console.error(`[shadow-svc] cycle ${status.cyclesRun}: opened=${res.openingScorecard.opened}/${res.openingScorecard.attempted} settled=${res.settledThisCycle} payout=$${res.settledPayoutThisCycleUsdc} openBook=${res.openBookSize} deferred=${res.deferred} verified=${res.oracleVerified}`);
      } else {
        status.lastRunOk = false;
        status.lastError = `${res.error}: ${res.message}`;
        console.error(`[shadow-svc] cycle ${status.cyclesRun} not run: ${status.lastError}`);
      }
      return;
    }
    const res = await runLiveShadowSession(cfg);
    if (res.ok) {
      appendScorecard({ tsMs: status.lastRunAtMs, scorecard: res.scorecard, spotUsd: res.meta.spotUsd, oracleSources: res.meta.oracleSources });
      status.lastRunOk = true;
      status.lastError = null;
      console.error(`[shadow-svc] cycle ${status.cyclesRun}: opened=${res.scorecard.opened}/${res.scorecard.attempted} verified=${res.scorecard.allSettledOracleVerified} reconciled=${res.scorecard.allReconciled}`);
    } else {
      status.lastRunOk = false;
      status.lastError = `${res.error}: ${res.message}`;
      console.error(`[shadow-svc] cycle ${status.cyclesRun} not run: ${status.lastError}`);
    }
  } catch (e) {
    status.lastRunOk = false;
    status.lastError = (e as Error).message;
    console.error(`[shadow-svc] cycle error: ${status.lastError}`);
  }
};

const loop = async () => {
  for (;;) {
    await runCycle();
    await new Promise((r) => setTimeout(r, intervalMs));
  }
};

const server = createServer((req, res) => {
  const out = handleDashboardRequest(
    { method: req.method ?? "GET", path: req.url ?? "/", authorization: req.headers.authorization },
    { loadRecords: () => loadScorecards(), liveStatus: () => status, settlementAggregate: () => loadSettlementAggregate(), token, aggregateConfig: { exposureBandPct: haltBand, targetServiceFeeBps: cfg.serviceFeeBps, capital: capitalConfig } }
  );
  res.writeHead(out.statusCode, { "Content-Type": out.contentType });
  res.end(out.body);
});

server.listen(port, () => console.error(`[shadow-svc] dashboard on :${port} · loop every ${intervalMs}ms · paper/read-only · live tiers OFF`));
void loop();
