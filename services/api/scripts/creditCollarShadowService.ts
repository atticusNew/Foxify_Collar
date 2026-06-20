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
import { buildPartnerFeedFromEnv } from "../src/singleSide/twoSided/creditCollar/partnerFeedFactory";
import { appendScorecard, loadScorecards } from "../src/singleSide/twoSided/creditCollar/shadowStore";
import { handleDashboardRequest, type ShadowLiveStatus } from "../src/singleSide/twoSided/creditCollar/shadowDashboard";
import type { ShadowLifecycleReport } from "../src/singleSide/twoSided/creditCollar/lifecycleShadow";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

const intervalMs = num(process.env.SHADOW_LOOP_INTERVAL_MS, 900_000);
const port = num(process.env.PORT, 10_000);
const token = process.env.SHADOW_DASHBOARD_TOKEN;
const haltBand = num(process.env.SHADOW_BREAKER_HALT, 0.15);
const forwardSettle = String(process.env.SHADOW_FORWARD_SETTLE ?? "true").toLowerCase() !== "false";
const settlementHorizonMin = num(process.env.SHADOW_SETTLEMENT_HORIZON_MIN, 60); // positions settle 1h later (real move)

// Settlement model: touch-first / European-fallback. Touch is ON by default; it only ENGAGES once a
// real rolling tick history is fed (SHADOW_BARRIER_*) — with the synthetic same-price stream no touch
// fires (safe). persistTicks is the cycle-cadence anti-wick depth; barrierFullVest=true ⟹ an
// involuntary barrier touch realizes full credit.
const settlementConfig = {
  enableBarrierTouch: String(process.env.SHADOW_BARRIER_TOUCH ?? "true").toLowerCase() !== "false",
  persistTicks: num(process.env.SHADOW_BARRIER_PERSIST_TICKS, 2),
  touchGapBps: num(process.env.SHADOW_BARRIER_TOUCH_GAP_BPS, 0),
  vesting: { barrierFullVest: String(process.env.SHADOW_BARRIER_FULL_VEST ?? "true").toLowerCase() !== "false" }
};

// Rolling oracle tick history: append each cycle's verified median so the touch detector sees a real
// price stream. ON by default so the touch path engages on live data; trimmed to a 24h window.
const rollingTickHistory = {
  enabled: String(process.env.SHADOW_TICK_HISTORY ?? "true").toLowerCase() !== "false",
  maxTicks: num(process.env.SHADOW_TICK_HISTORY_MAX, 192),
  maxAgeMs: num(process.env.SHADOW_TICK_HISTORY_MAX_AGE_MS, 24 * 3_600_000)
};

// Live partner-position feed (read-only): when PARTNER_FEED_URL is set, the lifecycle coordinator
// drives the FSM on live data — orphan-cancel, close-SLA gap allocation, breach forfeit. Unset ⟹ the
// coordinator stays dormant (the feed is the remaining external integration with Foxify's exchange).
const partnerFeed = buildPartnerFeedFromEnv() ?? undefined;
if (partnerFeed) console.error("[shadow-svc] partner feed configured ⟹ lifecycle coordinator ACTIVE (perp↔collar SLA/gap/orphan on live data)");

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

let latestLifecycle: ShadowLifecycleReport | null = null;

const runCycle = async () => {
  try {
    status.cyclesRun += 1;
    status.lastRunAtMs = Date.now();
    if (forwardSettle) {
      const res = await runForwardShadowCycle({
        ...cfg,
        settlementHorizonMin,
        capital: {
          shortOptionImFraction: capitalConfig.shortOptionImFraction,
          portfolioMarginNettingFactor: capitalConfig.portfolioMarginNettingFactor,
          costOfCapitalAnnual: capitalConfig.costOfCapitalAnnual
        },
        settlement: settlementConfig,
        rollingTickHistory,
        lifecycle: {
          fullTenorMs: cfg.tenorDays * 86_400_000,
          basisMaxBps: num(process.env.SHADOW_BASIS_MAX_BPS, 25),
          initialCollateralUsdc: num(process.env.SHADOW_COLLATERAL_USDC, 250_000),
          minCollateralBufferUsdc: num(process.env.SHADOW_COLLATERAL_MIN_BUFFER, 25_000),
          partnerFeed,
          closeSlaMs: num(process.env.SHADOW_CLOSE_SLA_MS, 30_000),
          reopenCooldownMs: num(process.env.SHADOW_REOPEN_COOLDOWN_MS, 60_000),
          maxStalenessMs: num(process.env.PARTNER_FEED_MAX_STALENESS_MS, 15_000)
        }
      });
      if (res.ok) {
        appendScorecard({ tsMs: status.lastRunAtMs, scorecard: res.openingScorecard, spotUsd: res.meta.spotUsd, oracleSources: res.meta.oracleSources });
        status.lastRunOk = true;
        status.lastError = null;
        const lc = res.lifecycle;
        latestLifecycle = lc;
        const gateStr = res.gate.allowOpens ? "" : ` | GATE CLOSED: ${res.gate.reasons.join(",")}`;
        const co = res.coordinator;
        const coStr = co
          ? ` | coord: open=${co.open} closeSig=${co.closeSignaled} orphanCxl=${co.orphanCancelled} breach=${co.breached} gapFoxify=$${co.gapToFoxifyUsdc}${co.cherryPick ? " CHERRY-PICK" : ""}`
          : "";
        console.error(`[shadow-svc] cycle ${status.cyclesRun}: opened=${res.openingScorecard.opened}/${res.openingScorecard.attempted} settled=${res.settledThisCycle} (touch=${res.touchSettledThisCycle} euro=${res.europeanSettledThisCycle}) payout=$${res.settledPayoutThisCycleUsdc} openBook=${res.openBookSize} deferred=${res.deferred} verified=${res.oracleVerified} | basis=${lc.basisBps}bps vest=${lc.vestProgressPct}% collat=$${lc.collateralAvailableUsdc}${lc.collateralHalted ? " HALT" : ""}${coStr}${gateStr}`);
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
    { loadRecords: () => loadScorecards(), liveStatus: () => status, settlementAggregate: () => loadSettlementAggregate(), lifecycleReport: () => latestLifecycle, token, aggregateConfig: { exposureBandPct: haltBand, targetServiceFeeBps: cfg.serviceFeeBps, capital: capitalConfig } }
  );
  res.writeHead(out.statusCode, { "Content-Type": out.contentType });
  res.end(out.body);
});

server.listen(port, () => console.error(`[shadow-svc] dashboard on :${port} · loop every ${intervalMs}ms · paper/read-only · live tiers OFF`));
void loop();
