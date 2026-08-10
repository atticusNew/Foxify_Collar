#!/usr/bin/env tsx
/**
 * CREDIT CHECK — read-only, zero writes, no API keys. Answers one question with live market data:
 * "does today's solve get to the $80 credit per position?"
 *
 * Runs the EXACT frozen pilot pricing (pass-through, floor 6%/10%, σ-floor 1.1×, grid 250) on the
 * live OKX option book, both sides, and prints the credit vs target. Also prices the optional
 * far-OTM wing (the defined-risk add-on discussed for the FalconX IA) so its cost is visible on
 * today's tape.
 *
 * Run in the Render shell:  npm --silent --workspace services/api run credit:check
 */

import { buildLiveShadowInputs, type LiveShadowConfig } from "../src/singleSide/twoSided/creditCollar/shadowRunner";
import { solveAdaptiveCreditCollar, type PerpSide } from "../src/singleSide/twoSided/creditCollar/creditCollarPricer";
import { bsCall, bsPut } from "../src/pilot/blackScholes";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);
const fmt = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 0 });

// The FROZEN pilot config — identical to the live service / canary / RFQ tools.
const cfg: LiveShadowConfig = {
  positionNotionalUsdc: num(process.env.SHADOW_POSITION_USDC, 50_000),
  feeUsdc: num(process.env.HARNESS_FEE_USDC, 80),
  serviceFeeBps: 0,
  minServiceFeeUsdc: 0,
  tenorDays: num(process.env.HARNESS_TENOR_DAYS, 1),
  maxFloorPct: num(process.env.HARNESS_MAX_FLOOR_PCT, 0.06),
  nPositions: 2,
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

const main = async () => {
  console.log("fetching live OKX option book + oracle spot (read-only)…");
  const built = await buildLiveShadowInputs(cfg);
  if (!built.ok) {
    console.error(`cannot build live inputs: ${built.error} — ${built.message}`);
    process.exit(1);
  }
  const { skew, spot, scaffoldConfig } = built.inputs;
  const T = cfg.tenorDays / 365;
  console.log(`\nBTC spot ≈ $${fmt(spot)} · tenor ${cfg.tenorDays * 24}h · credit target $${cfg.feeUsdc} · notional $${fmt(cfg.positionNotionalUsdc)} (≈ ${(cfg.positionNotionalUsdc / spot).toFixed(4)} BTC)\n`);

  for (const side of ["long", "short"] as PerpSide[]) {
    const adaptive = solveAdaptiveCreditCollar(
      { side, spot, notionalUsdc: cfg.positionNotionalUsdc, tenorDays: cfg.tenorDays, targetCreditUsdc: cfg.feeUsdc, maxFloorPct: scaffoldConfig.maxFloorPct, referenceMode: "position" },
      skew,
      { ...(scaffoldConfig.spreadConfig ?? {}), pricingModel: "pass_through", operationFeeBps: 0, minOperationFeeUsdc: 0 },
      scaffoldConfig.adaptiveFloor
    );
    if (!adaptive.quote.ok) {
      console.log(`${side.toUpperCase()} side: NOT PRICEABLE today — ${adaptive.quote.message}`);
      continue;
    }
    const q = adaptive.quote;
    const credit = q.economics.foxify_credit_usdc;
    const hit = credit >= cfg.feeUsdc - 0.01;
    console.log(`${side.toUpperCase()} side (protects a ${side} perp):`);
    console.log(`  SELL ${q.legs.foxifyShortLeg.toUpperCase()} ${fmt(q.legs.foxifyShortLeg === "call" ? q.legs.callStrike : q.legs.putStrike)} (${(q.legs.cap_pct * 100).toFixed(2)}% OTM, the funding leg)`);
    console.log(`  BUY  ${q.legs.foxifyLongLeg.toUpperCase()} ${fmt(q.legs.foxifyLongLeg === "put" ? q.legs.putStrike : q.legs.callStrike)} (${(q.legs.floor_pct * 100).toFixed(2)}% OTM, the protection)`);
    console.log(`  ⟹ CREDIT $${credit.toFixed(2)} vs target $${cfg.feeUsdc} — ${hit ? "TARGET HIT ✓" : "floated DOWN (σ-floor: cap not compressed to chase credit — expected in quiet tape)"}`);
    console.log(`     (fundable collar proceeds $${q.economics.fundable_credit_usdc.toFixed(2)} · venue fee $${q.economics.option_open_fees_usdc.toFixed(2)} · floor used ${(adaptive.floorUsedPct * 100).toFixed(1)}%)`);

    // The defined-risk WING (single-protection days only): far OTM long, 4% of spot beyond the funding leg.
    const grid = num(process.env.HARNESS_STRIKE_GRID_USDC, 250);
    const fundingStrike = q.legs.foxifyShortLeg === "call" ? q.legs.callStrike : q.legs.putStrike;
    const wingK = side === "long" ? Math.round((fundingStrike + 0.04 * spot) / grid) * grid : Math.round((fundingStrike - 0.04 * spot) / grid) * grid;
    const iv = skew(wingK, q.legs.foxifyShortLeg);
    const wingPerBtc = side === "long" ? bsCall(spot, wingK, T, 0, iv) : bsPut(spot, wingK, T, 0, iv);
    const wingCost = wingPerBtc * (cfg.positionNotionalUsdc / spot);
    console.log(`     single-day WING (defined-risk add-on): BUY ${side === "long" ? "CALL" : "PUT"} ${fmt(wingK)} ≈ $${wingCost.toFixed(2)} ⟹ credit after wing ≈ $${(credit - wingCost).toFixed(2)}`);
    console.log(`     (wing caps the worst-case settlement at ≈ $${fmt(0.04 * spot * (cfg.positionNotionalUsdc / spot))} — the $2k IA number)\n`);
  }

  console.log("Pair days need NO wing (the two structures protect each other) — pair credit math is unchanged.");
};

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
