/**
 * Cell redesign sweep — explores parameter space around the V3-positive cells
 * to find variants that are profitable IN CALM REGIME (DVOL ~36, current state).
 *
 * V3 sweep finding: no cell is positive at calm under the current parameter
 * defaults (Atticus 15% tier-1 split, $25 floor, ATM/short-OTM strikes).
 *
 * Levers explored:
 *   - putOffset / callOffset (how far OTM)
 *   - tenorDays (theta budget)
 *   - splitPct (Atticus share of uplift)
 *   - floorUsdc (Atticus floor)
 *   - triggerPct (trigger boundary)
 *
 * Output: docs/PHASE_1_CELL_REDESIGN_<date>.md with all variants ranked by
 * calm Foxify EV.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bsPut, bsCall } from "./coreEngine";
import {
  generateBootstrapPath,
  generateGbmPath,
  load5MinBars,
  mulberry32,
  type PathConfig
} from "./monteCarloEngine";
import { loadLiveMultiTenorData, livePerLegAskV3, liveSlippageHaircutV3 } from "./liveCellPricingV3";

const RFR = 0.045;
const N_PATHS = 8_000;
const BAR_MINUTES = 5;

type Variant = {
  variantId: string;
  notionalUsdcPerLeg: number;
  triggerPct: number;
  tenorDays: number;
  putStrikeOffsetPct: number;
  callStrikeOffsetPct: number;
  contractsBtc: number;
  strikeGridUsdc: number;
  splitPct: number;
  floorUsdc: number;
};

// Base: pair_25k_5pct_otm_short (V3-positive at moderate+, closest at calm)
const BASE: Omit<Variant, "variantId"> = {
  notionalUsdcPerLeg: 25_000,
  triggerPct: 0.05,
  tenorDays: 1,
  putStrikeOffsetPct: -0.020,
  callStrikeOffsetPct: -0.025,
  contractsBtc: 0.5,
  strikeGridUsdc: 1_000,
  splitPct: 0.85,
  floorUsdc: 25
};

// Build variant grid (orthogonal lever sweeps)
const buildVariants = (): Variant[] => {
  const out: Variant[] = [{ variantId: "BASE_pair_25k_5pct_otm_short", ...BASE }];

  // L1: deeper OTM (lower trigger rate, higher salvage per trigger)
  for (const off of [-0.030, -0.040]) {
    out.push({ ...BASE, variantId: `L1_putoff_${off}`, putStrikeOffsetPct: off });
    out.push({ ...BASE, variantId: `L1_calloff_${off}`, callStrikeOffsetPct: off });
    out.push({ ...BASE, variantId: `L1_both_${off}`, putStrikeOffsetPct: off, callStrikeOffsetPct: off });
  }

  // L2: longer tenor (more time value to capture, more theta to fight)
  for (const t of [1.5, 2, 3]) {
    out.push({ ...BASE, variantId: `L2_tenor_${t}d`, tenorDays: t });
  }

  // L3: higher Foxify split (lower Atticus take in calm to keep EV positive)
  for (const s of [0.90, 0.95, 0.98]) {
    out.push({ ...BASE, variantId: `L3_split_${s}`, splitPct: s });
  }

  // L4: lower / no Atticus floor
  for (const f of [10, 5, 0]) {
    out.push({ ...BASE, variantId: `L4_floor_${f}`, floorUsdc: f });
  }

  // L5: wider trigger (rarer trigger but more dramatic move → bigger salvage)
  for (const trg of [0.06, 0.07, 0.08]) {
    out.push({ ...BASE, variantId: `L5_trigger_${trg}`, triggerPct: trg });
  }

  // L6: bigger notional (amortize fixed bid-ask better)
  for (const n of [50_000, 100_000]) {
    out.push({
      ...BASE,
      variantId: `L6_notional_${n}`,
      notionalUsdcPerLeg: n,
      contractsBtc: BASE.contractsBtc * (n / BASE.notionalUsdcPerLeg)
    });
  }

  // L7: combo (best lever from each L1-L5)
  out.push({
    ...BASE,
    variantId: "L7_combo_deep+long+highsplit+lowfloor",
    putStrikeOffsetPct: -0.040,
    callStrikeOffsetPct: -0.040,
    tenorDays: 2,
    splitPct: 0.95,
    floorUsdc: 10,
    triggerPct: 0.07
  });
  out.push({
    ...BASE,
    variantId: "L7_combo_OTM2pct_tenor2_split95_floor10",
    putStrikeOffsetPct: -0.030,
    callStrikeOffsetPct: -0.030,
    tenorDays: 2,
    splitPct: 0.95,
    floorUsdc: 10
  });

  return out;
};

const computeStrikes = (v: Variant, spot: number): { put: number; call: number } => {
  const rawPut = spot * (1 + v.putStrikeOffsetPct);
  const rawCall = spot * (1 - v.callStrikeOffsetPct);
  return {
    put: Math.ceil(rawPut / v.strikeGridUsdc) * v.strikeGridUsdc,
    call: Math.floor(rawCall / v.strikeGridUsdc) * v.strikeGridUsdc
  };
};

type SimResult = {
  hedgeCost: number;
  meanSalvage: number;
  triggerRate: number;
  meanFoxifyEv: number;
  meanAtticusEv: number;
  pctProfit: number;
  worstFoxify: number;
  p5FoxifyEv: number;
  bucketUsed: string;
};

const simulate = async (
  v: Variant,
  spot: number,
  regime: "calm" | "moderate",
  bars: { close: number; high: number; low: number; open: number }[] | null
): Promise<SimResult> => {
  const REGIME_SIGMAS = { calm: 0.35, moderate: 0.55 };
  const REGIME_MARKUP = { calm: 1.0, moderate: 1.15 };
  const sigma = REGIME_SIGMAS[regime];
  const markup = REGIME_MARKUP[regime];
  const data = await loadLiveMultiTenorData();
  const { put: putStrike, call: callStrike } = computeStrikes(v, spot);
  const putAsk = livePerLegAskV3(data, spot, putStrike, "put", v.tenorDays, markup);
  const callAsk = livePerLegAskV3(data, spot, callStrike, "call", v.tenorDays, markup);
  const hedgeCost = (putAsk + callAsk) * v.contractsBtc;
  const slip = Math.min(
    liveSlippageHaircutV3(data, putStrike, "put", v.contractsBtc, v.tenorDays),
    liveSlippageHaircutV3(data, callStrike, "call", v.contractsBtc, v.tenorDays)
  );
  const bucketUsed = data
    ? [...data.buckets].sort((a, b) => Math.abs(a.targetHours / 24 - v.tenorDays) - Math.abs(b.targetHours / 24 - v.tenorDays))[0].label
    : "fallback";

  const triggerDownPx = spot * (1 - v.triggerPct);
  const triggerUpPx = spot * (1 + v.triggerPct);

  const rng = mulberry32(42);
  const pathConfig: PathConfig = {
    tenorDays: v.tenorDays,
    sigmaAnnual: sigma,
    driftAnnual: 0,
    generator: regime === "calm" && bars ? "bootstrap" : "gbm",
    seed: 42
  };

  const foxifyEvs: number[] = [];
  const atticusEvs: number[] = [];
  const salvages: number[] = [];
  let triggers = 0;

  for (let p = 0; p < N_PATHS; p++) {
    const pathBars = bars && regime === "calm"
      ? generateBootstrapPath(spot, pathConfig, bars, rng)
      : generateGbmPath(spot, pathConfig, rng);
    let triggerBar = -1;
    let triggerSide: "down" | "up" | null = null;
    for (let i = 1; i < pathBars.closes.length; i++) {
      if (pathBars.lows[i] <= triggerDownPx) { triggerBar = i; triggerSide = "down"; break; }
      if (pathBars.highs[i] >= triggerUpPx) { triggerBar = i; triggerSide = "up"; break; }
    }
    let salvage = 0;
    if (triggerBar === -1) {
      const sellAt = Math.max(0, pathBars.closes.length - 1 - 48);
      const sp = pathBars.closes[sellAt];
      const remDays = ((pathBars.closes.length - 1 - sellAt) * BAR_MINUTES) / (60 * 24);
      const T2 = Math.max(0, remDays / 365);
      salvage = (Math.max(0, bsPut(sp, putStrike, T2, RFR, sigma)) + Math.max(0, bsCall(sp, callStrike, T2, RFR, sigma))) * v.contractsBtc * slip;
    } else {
      triggers++;
      const captureEnd = Math.min(triggerBar + 6, pathBars.closes.length - 1);
      let peak = 0;
      for (let i = triggerBar; i <= captureEnd; i++) {
        const sp = triggerSide === "down" ? pathBars.lows[i] : pathBars.highs[i];
        const remBars = pathBars.closes.length - 1 - i;
        const remDays = (remBars * BAR_MINUTES) / (60 * 24);
        const T2 = Math.max(0, remDays / 365);
        const val = (Math.max(0, bsPut(sp, putStrike, T2, RFR, sigma)) + Math.max(0, bsCall(sp, callStrike, T2, RFR, sigma))) * v.contractsBtc;
        if (val > peak) peak = val;
      }
      salvage = peak * slip;
    }
    salvages.push(salvage);
    const uplift = salvage - hedgeCost;
    let atticusShare = 0;
    let foxifyShare: number;
    if (uplift <= 0) {
      foxifyShare = salvage;
    } else {
      atticusShare = Math.min(uplift, Math.max((1 - v.splitPct) * uplift, v.floorUsdc));
      foxifyShare = hedgeCost + (uplift - atticusShare);
    }
    foxifyEvs.push(foxifyShare - hedgeCost);
    atticusEvs.push(atticusShare);
  }
  const sortedF = [...foxifyEvs].sort((a, b) => a - b);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  return {
    hedgeCost,
    meanSalvage: mean(salvages),
    triggerRate: triggers / N_PATHS,
    meanFoxifyEv: mean(foxifyEvs),
    meanAtticusEv: mean(atticusEvs),
    pctProfit: foxifyEvs.filter((x) => x > 0).length / foxifyEvs.length,
    worstFoxify: sortedF[0],
    p5FoxifyEv: sortedF[Math.floor(sortedF.length * 0.05)],
    bucketUsed
  };
};

const fmt$ = (n: number) => `${n < 0 ? "-" : ""}\$${Math.round(Math.abs(n)).toLocaleString()}`;
const fmt$S = (n: number) => `${n < 0 ? "-" : "+"}\$${Math.round(Math.abs(n)).toLocaleString()}`;
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;

const main = async () => {
  console.log("# Cell redesign sweep (V3 pricing, calm + moderate focus)\n");
  const bars = await load5MinBars().catch(() => null);
  const data = await loadLiveMultiTenorData();
  if (!data) { console.log("⚠ no multi-tenor data; aborting"); process.exit(1); }
  const spot = data.spotAtPull;
  const variants = buildVariants();
  console.log(`Spot: \$${spot.toFixed(0)}, variants: ${variants.length}\n`);

  type Row = { v: Variant; calm: SimResult; moderate: SimResult };
  const rows: Row[] = [];
  for (const v of variants) {
    const calm = await simulate(v, spot, "calm", bars);
    const moderate = await simulate(v, spot, "moderate", bars);
    rows.push({ v, calm, moderate });
    console.log(`  ${v.variantId.padEnd(50)} calm F=${fmt$S(calm.meanFoxifyEv)} A=${fmt$S(calm.meanAtticusEv)}  mod F=${fmt$S(moderate.meanFoxifyEv)} A=${fmt$S(moderate.meanAtticusEv)}`);
  }

  // Sort by calm Foxify EV desc
  const sortedByCalm = [...rows].sort((a, b) => b.calm.meanFoxifyEv - a.calm.meanFoxifyEv);

  const lines: string[] = [];
  lines.push(`# Cell Redesign Sweep — V3 Pricing`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Spot:** \$${spot.toFixed(0)}`);
  lines.push(`**Base cell:** \`pair_25k_5pct_otm_short\` (V3-positive at moderate+, closest at calm)`);
  lines.push(`**Levers explored:** OTM offset, tenor, split %, Atticus floor, trigger %, notional, combo`);
  lines.push("");
  lines.push(`## Variants ranked by CALM Foxify EV`);
  lines.push("");
  lines.push(`| Rank | Variant | Hedge | Trig | Foxify EV (calm) | Atticus EV (calm) | %profit | Foxify EV (moderate) | Atticus EV (moderate) | Verdict |`);
  lines.push(`|---:|---|---:|---:|---:|---:|---:|---:|---:|---|`);
  sortedByCalm.forEach((r, i) => {
    const calmVerdict = r.calm.meanFoxifyEv > 0 ? "✅ CALM+" : r.calm.meanFoxifyEv > -50 ? "⚠️ CLOSE" : "❌ LOSS";
    lines.push(`| ${i + 1} | \`${r.v.variantId}\` | ${fmt$(r.calm.hedgeCost)} | ${fmtPct(r.calm.triggerRate)} | **${fmt$S(r.calm.meanFoxifyEv)}** | ${fmt$S(r.calm.meanAtticusEv)} | ${fmtPct(r.calm.pctProfit)} | ${fmt$S(r.moderate.meanFoxifyEv)} | ${fmt$S(r.moderate.meanAtticusEv)} | ${calmVerdict} |`);
  });
  lines.push("");
  lines.push(`## Variant configs (top 10 by calm EV)`);
  lines.push("");
  lines.push(`| Variant | notional | trigger | tenor | putOff | callOff | split | floor |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|`);
  sortedByCalm.slice(0, 10).forEach((r) => {
    const v = r.v;
    lines.push(`| \`${v.variantId}\` | \$${v.notionalUsdcPerLeg.toLocaleString()} | ${fmtPct(v.triggerPct)} | ${v.tenorDays}d | ${(v.putStrikeOffsetPct * 100).toFixed(1)}% | ${(v.callStrikeOffsetPct * 100).toFixed(1)}% | ${(v.splitPct * 100).toFixed(0)}/${(100 - v.splitPct * 100).toFixed(0)} | \$${v.floorUsdc} |`);
  });
  lines.push("");

  // Recommendation
  const calmWinners = sortedByCalm.filter((r) => r.calm.meanFoxifyEv > 0);
  lines.push(`## Recommendation`);
  lines.push("");
  if (calmWinners.length === 0) {
    lines.push(`**No variant achieves positive Foxify EV at calm regime.**`);
    lines.push(``);
    lines.push(`The structural problem persists across all levers tested:`);
    lines.push(`- ATM/short-OTM cells lose to theta`);
    lines.push(`- Deep-OTM cells lose to low trigger rate`);
    lines.push(`- Longer tenor amplifies theta`);
    lines.push(`- Higher split helps Foxify but starves Atticus (and Atticus floor still triggers)`);
    lines.push(``);
    lines.push(`**Production recommendation:** keep system HALTED in calm regime. Only activate`);
    lines.push(`when DVOL crosses ${rows[0].calm.meanFoxifyEv > rows[0].moderate.meanFoxifyEv ? "" : "40 (moderate threshold)"}.`);
    lines.push(`The closest variants to break-even are listed at the top of the ranking above.`);
  } else {
    const top = calmWinners[0];
    lines.push(`**Top calm-positive variant: \`${top.v.variantId}\`**`);
    lines.push(`- Foxify EV: ${fmt$S(top.calm.meanFoxifyEv)}/pair (calm), ${fmt$S(top.moderate.meanFoxifyEv)}/pair (moderate)`);
    lines.push(`- Atticus EV: ${fmt$S(top.calm.meanAtticusEv)}/pair (calm), ${fmt$S(top.moderate.meanAtticusEv)}/pair (moderate)`);
    lines.push(`- Hedge cost: ${fmt$(top.calm.hedgeCost)} → \$3,500 budget supports ~${Math.floor(3500 / top.calm.hedgeCost)} concurrent pairs`);
    lines.push(`- Config: notional \$${top.v.notionalUsdcPerLeg.toLocaleString()}/leg, trigger ${fmtPct(top.v.triggerPct)}, tenor ${top.v.tenorDays}d, putOff ${(top.v.putStrikeOffsetPct * 100).toFixed(1)}%, callOff ${(top.v.callStrikeOffsetPct * 100).toFixed(1)}%, split ${(top.v.splitPct * 100).toFixed(0)}/${(100 - top.v.splitPct * 100).toFixed(0)}, floor \$${top.v.floorUsdc}`);
    lines.push(``);
    lines.push(`**Action:** Add this variant to \`cellConfig.ts\` as new cell + add to calm allowlist.`);
  }
  lines.push("");
  lines.push(`---`);
  lines.push(`*Generated by services/api/scripts/backtest/singleSide/runCellRedesignSweep.ts*`);

  const outPath = path.resolve(process.cwd(), "../..", `docs/PHASE_1_CELL_REDESIGN_${new Date().toISOString().slice(0, 10)}.md`);
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`\n✓ Redesign report: ${outPath}`);
};

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
