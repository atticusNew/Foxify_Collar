#!/usr/bin/env tsx
/**
 * OKX LIVE CANARY — the Mon/Tue go/no-go artifact: ONE tiny real collar (default 1 contract =
 * 0.01 BTC) through the FULL production path: live skew/pricer solve (pass-through, σ-floor, all
 * guardrails) → instrument mapping → band-capped atomic execution → booked to the SAME ledgers as
 * venue "okx_live" → appears on /positions → settles at the next 08:00 UTC fixing → reconciles
 * against OKX's delivery price + bills on the following cycle.
 *
 * SAFETY: same gates as the service. Requires LIVE_ENABLED=true; real money additionally requires
 * OKX_EXECUTION_MODE=live + OKX_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY. Size is FORCED tiny
 * (LIVE_CANARY_CONTRACTS, default 1; hard max 5 here). The canary bypasses the 08:15 clock (it uses
 * its own window-state file) but respects every other rail. It executes ONE directional single —
 * side from the live trend, or --side long|short.
 *
 * Run in the Render shell (whitelisted IP), with the SAME env as the live service:
 *   LIVE_ENABLED=true LIVE_CANARY_CONTRACTS=1 \
 *   npm --silent --workspace services/api run okx:live-canary -- --side long
 */

import { OkxExecutionClient, type OkxMode } from "../src/singleSide/twoSided/creditCollar/execution/okxExecutionClient";
import { buildOkxLiveExecutionHook } from "../src/singleSide/twoSided/creditCollar/execution/okxLiveRunner";
import { parseLiveGuardsFromEnv, executionArmed } from "../src/singleSide/twoSided/creditCollar/execution/liveGuards";
import { buildLiveShadowInputs, type LiveShadowConfig } from "../src/singleSide/twoSided/creditCollar/shadowRunner";
import { solveAdaptiveCreditCollar, type PerpSide } from "../src/singleSide/twoSided/creditCollar/creditCollarPricer";
import { evaluateRegimeGate } from "../src/singleSide/twoSided/creditCollar/regimeGate";
import { loadPriceHistory, computeLiveRegimeSignal, trendDirection, appendPriceObs } from "../src/singleSide/twoSided/creditCollar/priceHistoryStore";
import { loadSettlements, loadOpenPositions, saveOpenPositions } from "../src/singleSide/twoSided/creditCollar/forwardSettlementStore";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

// Same pricing config as the shadow service (config freeze: floor 6%/10%, credit 80, σ-floor 1.1, grid 250).
const cfg: LiveShadowConfig = {
  positionNotionalUsdc: num(process.env.SHADOW_POSITION_USDC, 50_000),
  feeUsdc: num(process.env.HARNESS_FEE_USDC, 80),
  serviceFeeBps: 0,
  minServiceFeeUsdc: 0,
  tenorDays: num(process.env.HARNESS_TENOR_DAYS, 1),
  maxFloorPct: num(process.env.HARNESS_MAX_FLOOR_PCT, 0.06),
  nPositions: 1,
  tier0CapUsdc: 2_000_000,
  breaker: { warnBandPct: 100, haltBandPct: 100, resumeBandPct: 100, minGrossNotionalUsd: 0, maxAbsNetNotionalUsd: Number.MAX_SAFE_INTEGER },
  policy: { targetNetBandPct: 0.1, allowDirectionalBias: false, directionalTiltSigned: 0 },
  bullishWeight: 0,
  settlementWindowMin: 30,
  seed: 42,
  strikeGridUsdc: num(process.env.HARNESS_STRIKE_GRID_USDC, 250),
  minCapSigmaMult: num(process.env.HARNESS_MIN_CAP_SIGMA, 1.1),
  maxRetainedNetOfFeesUsdc: num(process.env.HARNESS_MAX_RETAINED_USDC, 2),
  hedgeVenue: "okx",
  adaptiveFloor: { enabled: true, maxFloorCapPct: num(process.env.SHADOW_ADAPTIVE_FLOOR_CAP, 0.1), stepPct: 0.005 }
};

const gateCfg = {
  enabled: true,
  lookback: num(process.env.SHADOW_REGIME_LOOKBACK, 40),
  minSamples: num(process.env.SHADOW_REGIME_MIN_SAMPLES, 10),
  elevatedVolPct: num(process.env.SHADOW_REGIME_ELEVATED_VOL, 1.2),
  haltVolPct: num(process.env.SHADOW_REGIME_HALT_VOL, 3.0),
  elevatedOpenMultiplier: 0,
  elevatedFloorPct: num(process.env.SHADOW_REGIME_ELEVATED_FLOOR, 0.1),
  liveLookbackMs: num(process.env.SHADOW_REGIME_LIVE_LOOKBACK_MIN, 360) * 60_000,
  liveMinSamples: num(process.env.SHADOW_REGIME_LIVE_MIN_SAMPLES, 4),
  hysteresisExitRatio: num(process.env.SHADOW_REGIME_HYSTERESIS, 0.85)
};

const main = async () => {
  const apiKey = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  if (!apiKey || !secret || !passphrase) {
    console.error("[canary] missing OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE");
    process.exit(2);
  }

  // Canary guard profile: tiny forced size, own window-state file (clock bypass), everything else real.
  const canaryContracts = Math.min(5, Math.max(1, num(process.env.LIVE_CANARY_CONTRACTS, 1)));
  const guards = {
    ...parseLiveGuardsFromEnv(process.env),
    windowUtc: "00:00",
    windowLatestUtc: "23:59",
    canaryContracts
  };
  const armed = executionArmed(guards);
  if (!armed.armed) {
    console.error(`[canary] refused: ${armed.reason}`);
    console.error("  Set LIVE_ENABLED=true (and for real money: OKX_EXECUTION_MODE=live OKX_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY).");
    process.exit(3);
  }
  const mode: OkxMode = guards.mode;
  console.error(`[canary] ${mode.toUpperCase()} mode · ${canaryContracts} contract(s) ≈ ${(canaryContracts * 0.01).toFixed(2)} BTC`);

  // Live inputs: OKX skew + oracle spot (the same pipeline the service runs).
  const built = await buildLiveShadowInputs(cfg);
  if (!built.ok) {
    console.error(`[canary] cannot build live inputs: ${built.error} — ${built.message}`);
    process.exit(4);
  }
  const { skew, spot, scaffoldConfig } = built.inputs;
  const now = Date.now();
  appendPriceObs({ tsMs: now, priceUsd: spot });

  // Regime (informational for the canary side choice; HALT still skips — the canary respects the gate).
  const trailing = loadSettlements().slice(-(gateCfg.lookback ?? 40)).map((o) => Math.abs(o.movePct));
  const live = computeLiveRegimeSignal(loadPriceHistory(), now, { lookbackMs: gateCfg.liveLookbackMs, minSamples: gateCfg.liveMinSamples });
  const gate = evaluateRegimeGate(trailing, gateCfg, live?.gaugePct ?? null);
  if (gate.regime === "halt") {
    console.error(`[canary] regime HALT (${gate.reason}) — not canary-ing into a halt. Re-run when calmer.`);
    process.exit(5);
  }
  const sideArg = process.argv.includes("--side") ? (process.argv[process.argv.indexOf("--side") + 1] as PerpSide) : null;
  const side: PerpSide = sideArg === "long" || sideArg === "short" ? sideArg : trendDirection(loadPriceHistory(), now, gateCfg.liveLookbackMs) >= 0 ? "long" : "short";
  if (gate.floorPctOverride != null) scaffoldConfig.maxFloorPct = gate.floorPctOverride;
  console.error(`[canary] regime ${gate.regime} · side ${side} · spot $${spot.toFixed(0)} · floor cap ${scaffoldConfig.maxFloorPct}`);

  // Solve — the SAME pass-through pricer, full guardrails. A rejection aborts the canary (never force).
  const solveSide = (s: PerpSide) => {
    const adaptive = solveAdaptiveCreditCollar(
      { side: s, spot, notionalUsdc: cfg.positionNotionalUsdc, tenorDays: cfg.tenorDays, targetCreditUsdc: cfg.feeUsdc, maxFloorPct: scaffoldConfig.maxFloorPct, referenceMode: "position" },
      skew,
      { ...(scaffoldConfig.spreadConfig ?? {}), pricingModel: "pass_through", operationFeeBps: 0, minOperationFeeUsdc: 0 },
      scaffoldConfig.adaptiveFloor
    );
    if (!adaptive.quote.ok) return { ok: false as const, error: adaptive.quote.error, message: adaptive.quote.message };
    const q = adaptive.quote;
    return {
      ok: true as const,
      solved: {
        ref: `cc-canary-${now}-${s}`,
        side: s,
        notionalUsdc: cfg.positionNotionalUsdc,
        putStrike: q.legs.putStrike,
        callStrike: q.legs.callStrike,
        foxifyCreditUsdc: q.economics.foxify_credit_usdc,
        serviceFeeUsdc: 0,
        floorPctUsed: adaptive.floorUsedPct,
        protectiveLegMidUsdc: q.legs.floor_leg_mid_usdc,
        fundingLegMidUsdc: q.legs.funding_leg_mid_usdc
      }
    };
  };

  const client = new OkxExecutionClient({ apiKey, secret, passphrase, mode });
  const hook = buildOkxLiveExecutionHook(process.env, {
    client,
    guards,
    paths: { windowState: process.env.LIVE_CANARY_WINDOW_STATE_PATH ?? "./logs/live-canary-window.json" }
  });

  // Elevated-shaped context ⟹ exactly ONE directional single at canary size (a calm ctx would pair).
  const res = await hook.executeWindow({
    nowMs: now,
    spot,
    regime: { ...gate, regime: "elevated" },
    trendBias: side,
    solveSide
  });

  console.error(`[canary] ${res.summary}`);
  if (res.newOpens.length === 0) {
    console.error("[canary] ❌ no position booked — see alerts above / live-alerts.jsonl. GO/NO-GO: NO-GO until a clean canary completes.");
    process.exit(6);
  }
  const open = loadOpenPositions();
  saveOpenPositions([...open, ...res.newOpens]);
  const p = res.newOpens[0];
  process.stdout.write(JSON.stringify({ booked: p }, null, 2) + "\n");
  console.error(`[canary] ✅ BOOKED ${p.ref}: ${p.side} collar ${p.putStrike}/${p.callStrike}, ${p.liveMeta?.contracts} contracts, net credit $${p.foxifyCreditUsdc}, fees $${p.openFeeUsdc}.`);
  console.error(`[canary] Now verify: (1) /positions shows venue okx_live; (2) it settles at ${new Date(p.expiresAtMs).toISOString()}; (3) the NEXT cycle logs 'recon ${p.ref}: MATCHED'. That completes the go/no-go.`);
};

main().catch((e) => {
  console.error("[canary] fatal:", e);
  process.exit(1);
});
