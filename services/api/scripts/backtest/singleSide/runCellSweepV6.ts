/**
 * V6 cell sweep — pulls LIVE cross-venue costs from the deployed
 * /admin/foxify/v2/cell-costs endpoint, then runs the V5 MC sim using those
 * exact costs + the ACTUAL strikes the venue router chose (post liquid-picker).
 *
 * This is the definitive answer to "what would each cell ACTUALLY earn if
 * activated right now," replacing V5 (which had Deribit-only costs).
 *
 * Two key differences from V5:
 *   1. Cost comes from real /cell-costs endpoint (both Bullish + Deribit
 *      considered, venue-routed per leg, includes any strike shifts)
 *   2. Salvage uses the ACTUAL strikes the router would buy at, not the cell's
 *      target strikes (consistent with V5 honest-strike approach)
 *
 * Usage:
 *   export ADMIN_TOKEN=<admin-token-not-pasted-into-chat>
 *   export FOXIFY_API_URL=<your-atticus-api-base-url>
 *   npx tsx scripts/backtest/singleSide/runCellSweepV6.ts
 *
 * Output: docs/PHASE_1_CELL_SWEEP_V6_<date>.md
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

const RFR = 0.045;
const N_PATHS = 8_000;
const BAR_MINUTES = 5;

const REGIME_SIGMAS = { calm: 0.35, moderate: 0.55, elevated: 0.75, stress: 0.95 } as const;
const REGIME_MARKUP = { calm: 1.0, moderate: 1.15, elevated: 1.35, stress: 1.60 } as const;

type CellCostResult = {
  cellId: string;
  ok: boolean;
  spot?: number;
  targetStrikes?: { put: number; call: number };
  actualStrikes?: { put: number; call: number };
  strikeShifted?: { put: boolean; call: boolean };
  putLeg?: { venue: string; symbol: string; askUsdcPerBtc: number; legCostUsdc: number };
  callLeg?: { venue: string; symbol: string; askUsdcPerBtc: number; legCostUsdc: number };
  totalHedgeCostUsdc?: number;
  contractsBtc?: number;
  triggerPctDown?: number;
  triggerPctUp?: number;
  hedgeTenorDays?: number;
  reason?: string;
  message?: string;
};

type CellCostsResponse = {
  asOf: string;
  spot: number;
  regime: string | null;
  utcHour: number;
  tier: string;
  results: CellCostResult[];
};

const fetchLiveCellCosts = async (apiUrl: string, adminToken: string): Promise<CellCostsResponse> => {
  const url = `${apiUrl.replace(/\/$/, "")}/admin/foxify/v2/cell-costs`;
  const r = await fetch(url, { headers: { "X-Admin-Token": adminToken } });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`cell-costs fetch failed: ${r.status} ${body.slice(0, 200)}`);
  }
  return (await r.json()) as CellCostsResponse;
};

type SimResult = {
  hedgeCost: number;
  meanSalvage: number;
  triggerRate: number;
  meanFoxifyEv: number;
  meanAtticusEv: number;
  pctProfit: number;
  p5FoxifyEv: number;
  worstFoxify: number;
  bestFoxify: number;
};

const simulate = (
  cellId: string,
  spot: number,
  putStrike: number,
  callStrike: number,
  contractsBtc: number,
  hedgeCostAtCalm: number,
  tenorDays: number,
  triggerPctDown: number,
  triggerPctUp: number,
  regime: keyof typeof REGIME_MARKUP,
  bars: { close: number; high: number; low: number; open: number }[] | null,
  splitPct = 0.85,
  floorUsdc = 25
): SimResult => {
  const sigma = REGIME_SIGMAS[regime];
  // Live cost is captured at calm regime (DVOL ~37); scale up for higher regimes
  // using the same markup table V5 uses (no recalibration here — operator should
  // confirm at higher regimes when DVOL actually spikes).
  const regimeMarkup = REGIME_MARKUP[regime];
  const hedgeCost = hedgeCostAtCalm * regimeMarkup;
  // Slip approximation: derived from typical observed spreads at this moment.
  // V5 used 0.78; the live picker rejects spread > 30% so picks tend to be
  // tighter. Use 0.85 (conservative midpoint).
  const slip = 0.82;
  const triggerDownPx = spot * (1 - triggerPctDown);
  const triggerUpPx = spot * (1 + triggerPctUp);

  const rng = mulberry32(42);
  const pathConfig: PathConfig = {
    tenorDays, sigmaAnnual: sigma, driftAnnual: 0,
    generator: regime === "calm" && bars ? "bootstrap" : "gbm", seed: 42
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
      salvage = (Math.max(0, bsPut(sp, putStrike, T2, RFR, sigma)) + Math.max(0, bsCall(sp, callStrike, T2, RFR, sigma))) * contractsBtc * slip;
    } else {
      triggers++;
      const captureEnd = Math.min(triggerBar + 6, pathBars.closes.length - 1);
      let peak = 0;
      for (let i = triggerBar; i <= captureEnd; i++) {
        const sp = triggerSide === "down" ? pathBars.lows[i] : pathBars.highs[i];
        const remBars = pathBars.closes.length - 1 - i;
        const remDays = (remBars * BAR_MINUTES) / (60 * 24);
        const T2 = Math.max(0, remDays / 365);
        const v = (Math.max(0, bsPut(sp, putStrike, T2, RFR, sigma)) + Math.max(0, bsCall(sp, callStrike, T2, RFR, sigma))) * contractsBtc;
        if (v > peak) peak = v;
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
      atticusShare = Math.min(uplift, Math.max((1 - splitPct) * uplift, floorUsdc));
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
    p5FoxifyEv: sortedF[Math.floor(sortedF.length * 0.05)],
    worstFoxify: sortedF[0],
    bestFoxify: sortedF[sortedF.length - 1]
  };
};

const fmt$ = (n: number) => `${n < 0 ? "-" : ""}\$${Math.round(Math.abs(n)).toLocaleString()}`;
const fmt$S = (n: number) => `${n < 0 ? "-" : "+"}\$${Math.round(Math.abs(n)).toLocaleString()}`;
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;

const main = async () => {
  const adminToken = process.env.ADMIN_TOKEN;
  const apiUrl = process.env.FOXIFY_API_URL ?? "";
  if (!apiUrl) {
    console.error("ERROR: FOXIFY_API_URL env var required (e.g. your Atticus API base URL)");
    process.exit(1);
  }
  if (!adminToken) {
    console.error("ERROR: ADMIN_TOKEN env var required");
    console.error("Usage: export ADMIN_TOKEN=<admin-token>; npx tsx scripts/backtest/singleSide/runCellSweepV6.ts");
    process.exit(1);
  }

  console.log(`# Cell Sweep V6 — LIVE cross-venue costs from production endpoint\n`);
  console.log(`Fetching ${apiUrl}/admin/foxify/v2/cell-costs ...`);
  const live = await fetchLiveCellCosts(apiUrl, adminToken);
  console.log(`  asOf: ${live.asOf}`);
  console.log(`  spot: \$${live.spot.toFixed(0)}`);
  console.log(`  regime: ${live.regime}`);
  console.log(`  utcHour: ${live.utcHour}`);
  console.log(`  cells: ${live.results.length}\n`);

  const bars = await load5MinBars().catch(() => null);

  // Run sim per cell × regime
  type RowResult = { cellId: string; perRegime: Record<string, SimResult>; meta: CellCostResult };
  const rows: RowResult[] = [];
  for (const c of live.results) {
    if (!c.ok || !c.actualStrikes || !c.contractsBtc || !c.totalHedgeCostUsdc || !c.hedgeTenorDays || !c.triggerPctDown || !c.triggerPctUp) {
      console.log(`  ${c.cellId.padEnd(28)} SKIP — ${c.reason ?? "missing fields"}`);
      continue;
    }
    const perRegime: Record<string, SimResult> = {};
    for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
      perRegime[regime] = simulate(
        c.cellId, live.spot,
        c.actualStrikes.put, c.actualStrikes.call,
        c.contractsBtc, c.totalHedgeCostUsdc,
        c.hedgeTenorDays,
        c.triggerPctDown, c.triggerPctUp,
        regime, bars
      );
    }
    rows.push({ cellId: c.cellId, perRegime, meta: c });
    console.log(
      `  ${c.cellId.padEnd(28)} cost=${fmt$(c.totalHedgeCostUsdc).padStart(7)} ` +
      `K(p/c)=${c.actualStrikes.put}/${c.actualStrikes.call} ` +
      `calm F=${fmt$S(perRegime.calm.meanFoxifyEv).padStart(8)} ` +
      `mod F=${fmt$S(perRegime.moderate.meanFoxifyEv).padStart(8)} ` +
      `elev F=${fmt$S(perRegime.elevated.meanFoxifyEv).padStart(8)} ` +
      `stress F=${fmt$S(perRegime.stress.meanFoxifyEv).padStart(8)}`
    );
  }

  // Generate report
  const lines: string[] = [];
  lines.push(`# Phase 1 Cell Sweep V6 — LIVE CROSS-VENUE COSTS`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Live data asOf:** ${live.asOf}`);
  lines.push(`**Spot:** \$${live.spot.toFixed(0)}`);
  lines.push(`**Regime at fetch:** ${live.regime} (DVOL ~37)`);
  lines.push(`**UTC hour:** ${live.utcHour}`);
  lines.push(`**Source:** GET ${apiUrl}/admin/foxify/v2/cell-costs (live cross-venue routing)`);
  lines.push("");
  lines.push(`## Per-cell live cost + sim`);
  lines.push("");
  lines.push(`| Cell | Put venue | Call venue | Hedge cost (live) | Actual strikes | Shifted? |`);
  lines.push(`|---|---|---|---:|---|---|`);
  for (const r of rows) {
    const m = r.meta;
    const shift = m.strikeShifted?.put || m.strikeShifted?.call ? `p:${m.strikeShifted?.put ? "Y" : "N"}/c:${m.strikeShifted?.call ? "Y" : "N"}` : "no";
    lines.push(`| ${r.cellId} | ${m.putLeg?.venue ?? "?"} | ${m.callLeg?.venue ?? "?"} | ${fmt$(m.totalHedgeCostUsdc ?? 0)} | ${m.actualStrikes?.put}/${m.actualStrikes?.call} | ${shift} |`);
  }
  lines.push("");
  for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
    lines.push(`### ${regime[0].toUpperCase() + regime.slice(1)} regime (σ=${REGIME_SIGMAS[regime]}, cost×${REGIME_MARKUP[regime]})`);
    lines.push("");
    lines.push(`| Cell | Hedge | Trigger rate | Salvage | **Foxify EV** | Atticus EV | %profit | P5 |`);
    lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|`);
    const ranked = [...rows].sort((a, b) => b.perRegime[regime].meanFoxifyEv - a.perRegime[regime].meanFoxifyEv);
    for (const r of ranked) {
      const s = r.perRegime[regime];
      const verdict = s.meanFoxifyEv > 100 ? "✅" : s.meanFoxifyEv > 0 ? "⚠️" : "❌";
      lines.push(`| ${r.cellId} ${verdict} | ${fmt$(s.hedgeCost)} | ${fmtPct(s.triggerRate)} | ${fmt$(s.meanSalvage)} | **${fmt$S(s.meanFoxifyEv)}** | ${fmt$S(s.meanAtticusEv)} | ${fmtPct(s.pctProfit)} | ${fmt$S(s.p5FoxifyEv)} |`);
    }
    lines.push("");
  }

  // Comparison vs V5
  lines.push(`## Comparison: V5 (Deribit-only, 03 UTC) vs V6 (cross-venue, ${live.utcHour}:00 UTC)`);
  lines.push("");
  lines.push(`| Cell | V5 cost | V6 cost | V5 calm EV | **V6 calm EV** | Calm verdict |`);
  lines.push(`|---|---:|---:|---:|---:|---|`);
  // V5 numbers from prior sweep (hardcoded reference)
  const V5_REF: Record<string, { cost: number; calmEv: number }> = {
    "pair_50k_2pct": { cost: 3343, calmEv: -308 },
    "pair_50k_3pct_atm": { cost: 2283, calmEv: -537 },
    "pair_50k_5pct_otm": { cost: 1286, calmEv: -568 },
    "pair_25k_5pct_otm_short": { cost: 312, calmEv: -190 },
    "pair_25k_5pct_otm_3d": { cost: 514, calmEv: -224 },
    "pair_50k_4pct_otm_short": { cost: 882, calmEv: -457 },
    "pair_25k_1pct_atm_micro": { cost: 412, calmEv: -145 }
  };
  for (const r of rows) {
    const v5 = V5_REF[r.cellId];
    const v6Calm = r.perRegime.calm;
    const v6cost = r.meta.totalHedgeCostUsdc ?? 0;
    const verdict = v6Calm.meanFoxifyEv > 100 ? "✅ PROFITABLE" : v6Calm.meanFoxifyEv > 0 ? "⚠️ MARGINAL" : "❌ LOSS";
    lines.push(`| ${r.cellId} | ${v5 ? fmt$(v5.cost) : "—"} | ${fmt$(v6cost)} | ${v5 ? fmt$S(v5.calmEv) : "—"} | **${fmt$S(v6Calm.meanFoxifyEv)}** | ${verdict} |`);
  }
  lines.push("");

  // Recommendation
  lines.push(`## Recommendation`);
  lines.push("");
  const calmWinners = rows.filter((r) => r.perRegime.calm.meanFoxifyEv > 100);
  const modWinners = rows.filter((r) => r.perRegime.moderate.meanFoxifyEv > 100);
  if (calmWinners.length > 0) {
    lines.push(`### CALM IS VIABLE — ${calmWinners.length} cell${calmWinners.length > 1 ? "s" : ""} above +\$100/pair threshold:`);
    for (const r of calmWinners.sort((a, b) => b.perRegime.calm.meanFoxifyEv - a.perRegime.calm.meanFoxifyEv)) {
      lines.push(`- \`${r.cellId}\`: +${fmt$(r.perRegime.calm.meanFoxifyEv)}/pair Foxify, +${fmt$(r.perRegime.calm.meanAtticusEv)}/pair Atticus`);
    }
    lines.push("");
    lines.push(`Operator should **consider adding these cells to the calm allowlist** via /admin/foxify/v2/cell-allowlist.`);
  } else {
    lines.push(`Calm regime: no cell crosses +\$100/pair threshold. System should HALT in calm (existing default is correct).`);
  }
  lines.push("");
  lines.push(`### Moderate regime winners (${modWinners.length}):`);
  for (const r of modWinners.sort((a, b) => b.perRegime.moderate.meanFoxifyEv - a.perRegime.moderate.meanFoxifyEv)) {
    lines.push(`- \`${r.cellId}\`: +${fmt$(r.perRegime.moderate.meanFoxifyEv)}/pair Foxify`);
  }
  lines.push("");

  lines.push(`## Caveats`);
  lines.push("");
  lines.push(`1. **Single snapshot at ${live.utcHour}:00 UTC.** Time-of-day matters significantly. Run again at`);
  lines.push(`   13-21 UTC (US session) to see if costs tighten further OR loosen.`);
  lines.push(`2. **Higher-regime costs are estimated** via REGIME_MARKUP scaling from this calm-regime snapshot.`);
  lines.push(`   When DVOL actually spikes, re-fetch /cell-costs to validate.`);
  lines.push(`3. **Salvage uses V5 slip approximation (0.82).** Real venue slip may differ; the cron probe`);
  lines.push(`   accumulates per-cell spread data for refinement.`);
  lines.push(`4. **One Bullish quote could be transient.** Don't change defaults on a single snapshot.`);
  lines.push(`   Wait for 24h of cron data or run V6 daily for a week.`);
  lines.push("");
  lines.push(`---`);
  lines.push(`*Generated by services/api/scripts/backtest/singleSide/runCellSweepV6.ts*`);

  const outPath = path.resolve(process.cwd(), "../..", `docs/PHASE_1_CELL_SWEEP_V6_${new Date().toISOString().slice(0, 10)}.md`);
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`\n✓ V6 report: ${outPath}`);
  console.log(`\n=== HEADLINE ===`);
  console.log(`Calm-viable cells (EV > \$100/pair): ${calmWinners.length}`);
  for (const r of calmWinners.sort((a, b) => b.perRegime.calm.meanFoxifyEv - a.perRegime.calm.meanFoxifyEv)) {
    console.log(`  ${r.cellId} → +\$${Math.round(r.perRegime.calm.meanFoxifyEv)}/pair`);
  }
};

if (process.argv[1] && (
  process.argv[1].endsWith("/runCellSweepV6.ts") ||
  process.argv[1].endsWith("\\runCellSweepV6.ts")
)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
