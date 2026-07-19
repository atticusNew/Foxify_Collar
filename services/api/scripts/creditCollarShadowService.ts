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
import { loadFoxifyView } from "../src/singleSide/twoSided/creditCollar/foxifyPerpView";
import { loadRegimeStats } from "../src/singleSide/twoSided/creditCollar/regimeStats";
import { loadPriceHistory, computeLiveRegimeSignal } from "../src/singleSide/twoSided/creditCollar/priceHistoryStore";
import { appendScorecard, loadScorecards, resolveWritablePath, DEFAULT_SHADOW_STORE_PATH } from "../src/singleSide/twoSided/creditCollar/shadowStore";
import { DEFAULT_OPEN_POSITIONS_PATH, DEFAULT_SETTLEMENT_LEDGER_PATH, loadOpenPositions, loadSettlements } from "../src/singleSide/twoSided/creditCollar/forwardSettlementStore";
import { DEFAULT_OPENING_STATE_PATH } from "../src/singleSide/twoSided/creditCollar/openingSignalStore";
import { DEFAULT_GATE_STATE_PATH, loadGateState } from "../src/singleSide/twoSided/creditCollar/regimeGateStore";
import { DEFAULT_COLLATERAL_PATH } from "../src/singleSide/twoSided/creditCollar/collateralStore";
import { handleDashboardRequest, type ShadowLiveStatus } from "../src/singleSide/twoSided/creditCollar/shadowDashboard";
import type { ShadowLifecycleReport } from "../src/singleSide/twoSided/creditCollar/lifecycleShadow";
import { OkxExecutionClient } from "../src/singleSide/twoSided/creditCollar/execution/okxExecutionClient";
import { buildOkxLiveExecutionHook } from "../src/singleSide/twoSided/creditCollar/execution/okxLiveRunner";
import { FalconxClient } from "../src/singleSide/twoSided/creditCollar/execution/falconxClient";
import { buildFalconxLiveExecutionHook } from "../src/singleSide/twoSided/creditCollar/execution/falconxLiveRunner";
import type { LiveExecutionHook } from "../src/singleSide/twoSided/creditCollar/execution/liveWindowRunner";
import { executionArmed, parseLiveGuardsFromEnv, type LiveExecutionVenue } from "../src/singleSide/twoSided/creditCollar/execution/liveGuards";
import { existsSync, unlinkSync } from "node:fs";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

// One-time store reset: set SHADOW_RESET_ON_BOOT=true to WIPE the accumulated shadow stores on startup
// (scorecards, settlements, open positions, opening-signal state, collateral) for a fresh track record.
// Remove the flag afterwards so later restarts don't keep wiping.
if (String(process.env.SHADOW_RESET_ON_BOOT ?? "").toLowerCase() === "true") {
  for (const p of [DEFAULT_SHADOW_STORE_PATH, DEFAULT_OPEN_POSITIONS_PATH, DEFAULT_SETTLEMENT_LEDGER_PATH, DEFAULT_OPENING_STATE_PATH, DEFAULT_COLLATERAL_PATH, DEFAULT_GATE_STATE_PATH]) {
    try {
      const eff = resolveWritablePath(p);
      if (existsSync(eff)) {
        unlinkSync(eff);
        console.error(`[shadow-svc] RESET: cleared ${eff}`);
      }
    } catch (e) {
      console.warn(`[shadow-svc] RESET: could not clear ${p} (${(e as Error).message})`);
    }
  }
  console.error("[shadow-svc] RESET complete — starting with EMPTY stores. Remove SHADOW_RESET_ON_BOOT so future restarts persist.");
}

const intervalMs = num(process.env.SHADOW_LOOP_INTERVAL_MS, 900_000);
const port = num(process.env.PORT, 10_000);
const token = process.env.SHADOW_DASHBOARD_TOKEN;
const haltBand = num(process.env.SHADOW_BREAKER_HALT, 0.15);
const forwardSettle = String(process.env.SHADOW_FORWARD_SETTLE ?? "true").toLowerCase() !== "false";
const settlementHorizonMin = num(process.env.SHADOW_SETTLEMENT_HORIZON_MIN, 60); // positions settle 1h later (real move)
// Per-position perp fee for the Foxify views. Default 0: NO fee assumed until Foxify's real number is known
// (dashboards show observed money only). Model one ad hoc with ?fee=25 on any dashboard URL, or set the env.
const foxifyPerpFeeUsdc = num(process.env.FOXIFY_PERP_FEE_USDC, 0);
// Foxify perp-book realism inputs. Each leg of a matched pair lands on a DIFFERENT venue (round-robin).
// Funding/basis/fee are CSV-aligned to the venue list (single value broadcasts); leave at 0 for the
// oracle-mirror baseline, or feed real per-venue numbers (ideally from the partner feed) to make it faithful.
const csvStr = (v: string | undefined, d: string[]): string[] => (v && v.trim() ? v.split(",").map((s) => s.trim()).filter(Boolean) : d);
const perVenue = (csv: string | undefined, n: number): number[] => {
  const parts = csvStr(csv, []).map((s) => Number(s)).filter((x) => Number.isFinite(x));
  if (parts.length === 0) return Array(n).fill(0);
  return Array.from({ length: n }, (_, i) => parts[i] ?? parts[parts.length - 1]); // broadcast last value
};
const foxifyVenueNames = csvStr(process.env.FOXIFY_PERP_VENUES, ["dYdX", "Bluefin", "Hyperliquid"]);
const foxifyFundingBps = perVenue(process.env.FOXIFY_FUNDING_BPS_PER_8H, foxifyVenueNames.length);
const foxifyEntryBasisBps = perVenue(process.env.FOXIFY_PERP_ENTRY_BASIS_BPS, foxifyVenueNames.length);
const foxifyExitBasisBps = perVenue(process.env.FOXIFY_PERP_EXIT_BASIS_BPS, foxifyVenueNames.length);
const foxifyVenues = foxifyVenueNames.map((name, i) => ({
  name,
  fundingBpsPer8h: foxifyFundingBps[i],
  entryBasisBps: foxifyEntryBasisBps[i],
  exitBasisBps: foxifyExitBasisBps[i]
}));

// Measured capital inputs (Deribit margin sweep + PM-netting) → capital-aware net bps on the dashboard.
const capitalConfig = {
  shortOptionImFraction: num(process.env.SHADOW_SHORT_OPTION_IM_FRACTION, 0.1393),
  shortOptionGrossNotionalFraction: num(process.env.SHADOW_SHORT_OPTION_GROSS_FRACTION, 1.0),
  portfolioMarginNettingFactor: num(process.env.SHADOW_PM_NETTING, 1.0),
  costOfCapitalAnnual: num(process.env.SHADOW_COST_OF_CAPITAL, 0.12),
  tenorDays: num(process.env.HARNESS_TENOR_DAYS, 1)
};

// CALM-ONLY NEUTRAL POLICY (historical validation: the neutral both-sides book is reliably profitable ONLY
// when avg |24h move| < ~1.2%/day; in 2 years it never had a winning fortnight at credit=fee outside calm).
// Neutral mode therefore gates at 1.2% and PAUSES when not calm (no half-speed into a losing regime).
// Directional mode keeps the wider 1.5% / throttle-×0.5 behavior (its regime economics differ).
const isDirectional = ["long", "short", "trend"].includes(String(process.env.SHADOW_DIRECTIONAL_BIAS));

const cfg: LiveShadowConfig = {
  positionNotionalUsdc: num(process.env.SHADOW_POSITION_USDC, 50_000),
  feeUsdc: num(process.env.HARNESS_FEE_USDC, 80), // Foxify's stated per-trade need ($80) = the credit TARGET
  // Atticus's fee is NEGOTIATED SEPARATELY on volume and is deliberately NOT modeled in platform economics
  // (a hardcoded number would distort the "collar nets to ~0" proof and anchor the negotiation). Default 0.
  serviceFeeBps: num(process.env.HARNESS_SERVICE_FEE_BPS, 0),
  minServiceFeeUsdc: num(process.env.HARNESS_MIN_SERVICE_FEE_USDC, 0),
  tenorDays: num(process.env.HARNESS_TENOR_DAYS, 1),
  maxFloorPct: num(process.env.HARNESS_MAX_FLOOR_PCT, 0.06), // deeper floor ⟹ cheaper put ⟹ WIDER cap for the same $80 (sweep: cap 1.67%→2.08%/2.92%, breaches 24%→17%)
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
  // Credit-target mode: finer strike grid lets the cap sit nearer the $80 target (WIDER cap ⟹ fewer cap
  // breaches), and the credit ceiling hands Foxify ~the target rather than passing discrete-strike overshoot
  // through as extra credit funded by an over-tight cap. Bounded overshoot above the ceiling → Atticus margin.
  strikeGridUsdc: num(process.env.HARNESS_STRIKE_GRID_USDC, 250),
  // FULL PASS-THROUGH both ways: the strike solve stays TARGET-driven ($80 sets the cap width; never widen
  // the target to chase credit), but whatever the chosen strike actually throws off flows to Foxify — the
  // discrete-strike overshoot is value their cap generated (no ceiling), and Atticus retains ≤ $2 rounding
  // dust (retention bound). Mirrors the σ-floor float-DOWN so credit variance is symmetric: sometimes $72,
  // sometimes $95, target $80. Atticus's profit is ONLY the separate ops fee.
  maxFoxifyCreditUsdc: num(process.env.HARNESS_MAX_CREDIT_USDC, 0) || undefined,
  minCapSigmaMult: num(process.env.HARNESS_MIN_CAP_SIGMA, 1.1),
  maxRetainedNetOfFeesUsdc: num(process.env.HARNESS_MAX_RETAINED_USDC, 2),
  // Partner-like opening signal: positions/day, staggered (delta-neutral over time). Set 2 to shadow the
  // actual first pilot. Unset (0) ⟹ legacy fixed batch of SHADOW_N_POSITIONS per cycle (scaled stress mode).
  dailyPositions: num(process.env.SHADOW_DAILY_POSITIONS, 0) || undefined,
  // Opening direction: flat (neutral, default) | long | short | trend (follow live momentum) | auto
  // (HYBRID pilot playbook: calm ⟹ neutral pair, elevated ⟹ directional single with the trend, halt ⟹ skip).
  directionalBias: (["flat", "long", "short", "trend", "auto"].includes(String(process.env.SHADOW_DIRECTIONAL_BIAS)) ? (process.env.SHADOW_DIRECTIONAL_BIAS as "flat" | "long" | "short" | "trend" | "auto") : undefined),
  // Regime-aware opening gate: widen the cap + throttle when the trailing avg |24h move| is elevated; pause
  // when extreme. Lets the short-vol book sit out trend/high-vol regimes. On by default; tune the thresholds.
  regimeGate: {
    enabled: String(process.env.SHADOW_REGIME_GATE ?? "true").toLowerCase() !== "false",
    lookback: num(process.env.SHADOW_REGIME_LOOKBACK, 40),
    minSamples: num(process.env.SHADOW_REGIME_MIN_SAMPLES, 10),
    // Calm-only for the neutral book: calm line at 1.2% (the historically profitable bucket) and PAUSE
    // (×0) when not calm. Directional keeps 1.5% / ×0.5.
    elevatedVolPct: num(process.env.SHADOW_REGIME_ELEVATED_VOL, isDirectional ? 1.5 : 1.2),
    haltVolPct: num(process.env.SHADOW_REGIME_HALT_VOL, 3.0),
    elevatedOpenMultiplier: num(process.env.SHADOW_REGIME_ELEVATED_MULT, isDirectional ? 0.5 : 0),
    elevatedFloorPct: num(process.env.SHADOW_REGIME_ELEVATED_FLOOR, 0.1),
    liveLookbackMs: num(process.env.SHADOW_REGIME_LIVE_LOOKBACK_MIN, 360) * 60_000, // leading signal window (min → ms), default 6h
    liveMinSamples: num(process.env.SHADOW_REGIME_LIVE_MIN_SAMPLES, 4),
    // Hysteresis: once elevated/halt, only exit below threshold × ratio (stops calm↔elevated flicker at the line).
    hysteresisExitRatio: num(process.env.SHADOW_REGIME_HYSTERESIS, 0.85)
  },
  // Auto mode: positions/day while ELEVATED (directional). Set 1 for the conservative variant (default = full rate).
  autoElevatedDailyPositions: num(process.env.SHADOW_AUTO_ELEVATED_DAILY, 0) || undefined,
  // Force a single hedge venue for the mirror (e.g. SHADOW_HEDGE_VENUE=okx) so skew/spreads/fees are OKX-specific.
  hedgeVenue: (["bullish", "okx", "deribit"].includes(String(process.env.SHADOW_HEDGE_VENUE)) ? (process.env.SHADOW_HEDGE_VENUE as "bullish" | "okx" | "deribit") : undefined),
  adaptiveFloor: {
    enabled: String(process.env.SHADOW_ADAPTIVE_FLOOR ?? "true").toLowerCase() !== "false",
    maxFloorCapPct: num(process.env.SHADOW_ADAPTIVE_FLOOR_CAP, 0.1),
    stepPct: num(process.env.SHADOW_ADAPTIVE_FLOOR_STEP, 0.005)
  },
  oraclePrivateKeyPem: process.env.ORACLE_PRIVATE_KEY_PEM,
  oraclePublicKeyPem: process.env.ORACLE_PUBLIC_KEY_PEM
};

// ── LIVE execution hook (DEFAULT OFF). Venue via LIVE_EXECUTION_VENUE (falconx = primary; okx =
// fallback). Armed ONLY when LIVE_ENABLED=true AND the venue's creds exist; real money additionally
// requires the venue confirm phrase (FALCONX_LIVE_CONFIRM, or OKX_EXECUTION_MODE=live+OKX_LIVE_CONFIRM).
// When armed, opens happen ONLY via the guarded 08:15 UTC window (venue <venue>_live) — no paper opens.
let liveExecution: LiveExecutionHook | undefined;
{
  const venue: LiveExecutionVenue = (process.env.LIVE_EXECUTION_VENUE ?? "falconx").toLowerCase() === "okx" ? "okx" : "falconx";
  const liveGuards = parseLiveGuardsFromEnv(process.env, venue);
  if (liveGuards.liveEnabled) {
    const armed = executionArmed(liveGuards);
    if (!armed.armed) {
      console.error(`[shadow-svc] ❌ live path NOT armed: ${armed.reason} — paper shadow continues.`);
    } else if (venue === "falconx") {
      const apiKey = process.env.FALCONX_API_KEY;
      const secret = process.env.FALCONX_SECRET;
      const passphrase = process.env.FALCONX_PASSPHRASE;
      if (!apiKey || !secret || !passphrase) {
        console.error("[shadow-svc] ❌ LIVE_ENABLED=true but FALCONX_API_KEY/SECRET/PASSPHRASE missing — live path stays OFF (paper shadow).");
      } else {
        liveExecution = buildFalconxLiveExecutionHook(process.env, { client: new FalconxClient({ apiKey, secret, passphrase }) });
      }
    } else {
      const apiKey = process.env.OKX_API_KEY;
      const secret = process.env.OKX_API_SECRET;
      const passphrase = process.env.OKX_API_PASSPHRASE;
      if (!apiKey || !secret || !passphrase) {
        console.error("[shadow-svc] ❌ LIVE_ENABLED=true but OKX_API_KEY/SECRET/PASSPHRASE missing — live path stays OFF (paper shadow).");
      } else {
        liveExecution = buildOkxLiveExecutionHook(process.env, { client: new OkxExecutionClient({ apiKey, secret, passphrase, mode: liveGuards.mode }) });
      }
    }
    if (liveExecution) {
      console.error(
        `[shadow-svc] ⚡ ${venue.toUpperCase()} LIVE EXECUTION ARMED (${liveGuards.mode.toUpperCase()}): window ${liveGuards.windowUtc}–${liveGuards.windowLatestUtc} UTC · caps $${liveGuards.maxPositionNotionalUsdc}/pos $${liveGuards.maxDayNotionalUsdc}/day · band ${liveGuards.slippageBandPct * 100}%` +
          (liveGuards.canaryContracts != null ? ` · CANARY ${liveGuards.canaryContracts} × 0.01 BTC` : "")
      );
    }
  }
}

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
        liveExecution,
        settlementHorizonMin,
        capital: {
          shortOptionImFraction: capitalConfig.shortOptionImFraction,
          portfolioMarginNettingFactor: capitalConfig.portfolioMarginNettingFactor,
          costOfCapitalAnnual: capitalConfig.costOfCapitalAnnual
        },
        lifecycle: {
          fullTenorMs: cfg.tenorDays * 86_400_000,
          basisMaxBps: num(process.env.SHADOW_BASIS_MAX_BPS, 25),
          // Pilot-accurate defaults: Foxify posts $5k for the 2×$50k/day pilot (halt if the buffer drops
          // below $500). Override via env for scaled runs (e.g. 250k/25k for the 1k/day book).
          initialCollateralUsdc: num(process.env.SHADOW_COLLATERAL_USDC, 5_000),
          minCollateralBufferUsdc: num(process.env.SHADOW_COLLATERAL_MIN_BUFFER, 500),
          // Lock watcher: early unwind permitted only when the market cost of closing the legs fits
          // inside the UNVESTED credit (schedule never underwater). Buffer/spread tunable via env.
          lockPolicy: {
            bufferUsdc: num(process.env.SHADOW_LOCK_BUFFER_USDC, 0),
            spreadRelPct: num(process.env.SHADOW_LOCK_SPREAD_REL, 0.05),
            minLegSpreadUsdc: num(process.env.SHADOW_LOCK_MIN_LEG_SPREAD_USDC, 1)
          }
        }
      });
      if (res.ok) {
        appendScorecard({ tsMs: status.lastRunAtMs, scorecard: res.openingScorecard, spotUsd: res.meta.spotUsd, oracleSources: res.meta.oracleSources });
        status.lastRunOk = true;
        status.lastError = null;
        const lc = res.lifecycle;
        latestLifecycle = lc;
        const rg = res.regimeGate ? ` | regime=${res.regimeGate.regime}(${res.regimeGate.realizedMovePct}%)` : "";
        console.error(`[shadow-svc] cycle ${status.cyclesRun}: opened=${res.openingScorecard.opened}/${res.openingScorecard.attempted} settled=${res.settledThisCycle} payout=$${res.settledPayoutThisCycleUsdc} openBook=${res.openBookSize} deferred=${res.deferred} verified=${res.oracleVerified}${rg} | basis=${lc.basisBps}bps vest=${lc.vestProgressPct}% collat=$${lc.collateralAvailableUsdc}${lc.collateralHalted ? " HALT" : ""}`);
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
    { loadRecords: () => loadScorecards(), liveStatus: () => status, settlementAggregate: () => loadSettlementAggregate(), foxifyView: (feeUsdc?: number) => loadFoxifyView(undefined, { perpFeeUsdc: feeUsdc ?? foxifyPerpFeeUsdc, venues: foxifyVenues }), regimeStats: (feeUsdc?: number) => loadRegimeStats(undefined, { perpFeeUsdc: feeUsdc ?? foxifyPerpFeeUsdc, gate: cfg.regimeGate, liveGaugePct: computeLiveRegimeSignal(loadPriceHistory(), Date.now(), { lookbackMs: cfg.regimeGate?.liveLookbackMs, minSamples: cfg.regimeGate?.liveMinSamples })?.gaugePct ?? null, prevRegime: loadGateState()?.regime ?? null }), positions: () => ({ open: loadOpenPositions(), settled: loadSettlements() }), lifecycleReport: () => latestLifecycle, token, aggregateConfig: { exposureBandPct: haltBand, targetServiceFeeBps: cfg.serviceFeeBps, capital: capitalConfig } }
  );
  res.writeHead(out.statusCode, { "Content-Type": out.contentType });
  res.end(out.body);
});

server.listen(port, () => console.error(`[shadow-svc] dashboard on :${port} · loop every ${intervalMs}ms · paper/read-only · live tiers OFF`));
void loop();
