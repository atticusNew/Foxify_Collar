#!/usr/bin/env tsx
/**
 * Tier-0 SHADOW activation runner — Render entrypoint (DEFAULT-OFF, paper-settled, NO trading).
 *
 * Runs ONE full shadow lifecycle against live public quotes: steer-flat instruction stream → shadow
 * activate (ExposureBreaker + EV guardrail + tier cap) → ECDSA-oracle TWAP settlement → reconciliation
 * → scorecard. Zero capital; live tiers stay off. Set HARNESS_FEE_USDC=75.
 *
 *   HARNESS_FEE_USDC=75 npm --silent --workspace services/api run shadow:run | jq .scorecard
 */

import { runLiveShadowSession, type LiveShadowConfig } from "../src/singleSide/twoSided/creditCollar/shadowRunner";
import { appendScorecard, loadScorecards, DEFAULT_SHADOW_STORE_PATH } from "../src/singleSide/twoSided/creditCollar/shadowStore";
import { aggregateShadowScorecards } from "../src/singleSide/twoSided/creditCollar/shadowAggregate";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);
const storeEnabled = String(process.env.SHADOW_STORE_ENABLED ?? "true").toLowerCase() !== "false";
const loopIntervalMs = num(process.env.SHADOW_LOOP_INTERVAL_MS, 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    haltBandPct: num(process.env.SHADOW_BREAKER_HALT, 0.15),
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

const runOnce = async () => {
  const res = await runLiveShadowSession(cfg);
  if (res.ok) {
    const s = res.scorecard;
    if (storeEnabled) appendScorecard({ tsMs: Date.now(), scorecard: s, spotUsd: res.meta.spotUsd, oracleSources: res.meta.oracleSources });
    console.error(
      `[shadow] opened=${s.opened}/${s.attempted} halted=${s.halted} rejected=${s.rejected} settlements=${s.settlements} ` +
        `lifecycleComplete=${s.lifecycleComplete} peakExp=${(s.peakNetExposureRatio * 100).toFixed(1)}% oracleVerified=${s.allSettledOracleVerified} reconciled=${s.allReconciled}`
    );
    if (storeEnabled) {
      const agg = aggregateShadowScorecards(loadScorecards());
      console.error(`[shadow] track record: ${agg.sessions} session(s) | verdict=${agg.verdict} | openRate=${(agg.positions.openRate * 100).toFixed(0)}% | oracleVerified=${(agg.oracle.allVerifiedRate * 100).toFixed(0)}% | reconciled=${(agg.reconciliation.allReconciledRate * 100).toFixed(0)}% | realizedFee=${agg.economics.realizedServiceFeeBps}bps${agg.flags.length ? ` | flags: ${agg.flags.join("; ")}` : ""}`);
    }
  } else {
    console.error(`[shadow] not run: ${res.error} — ${res.message}`);
  }
  return res;
};

const main = async () => {
  console.error(`[shadow] Tier-0 shadow lifecycle (paper, read/quote-only, live tiers OFF). store=${storeEnabled ? DEFAULT_SHADOW_STORE_PATH : "off"} loop=${loopIntervalMs > 0 ? `${loopIntervalMs}ms` : "single"}`);
  if (loopIntervalMs > 0) {
    // Worker mode (durable accumulation on a disk-backed Render worker).
    for (;;) {
      try {
        await runOnce();
      } catch (e) {
        console.error("[shadow] cycle error:", (e as Error).message);
      }
      await sleep(loopIntervalMs);
    }
  } else {
    const res = await runOnce();
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  }
};

main().catch((e) => {
  console.error("[shadow] fatal:", e);
  process.exit(1);
});
