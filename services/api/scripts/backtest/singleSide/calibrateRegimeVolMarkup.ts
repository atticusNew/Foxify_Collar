/**
 * Empirical calibration of REGIME_COST_MARKUP for the two-sided strangle MC.
 *
 * Pulls 365 days of Deribit DVOL daily history and computes the median ratio of
 * 3-day strangle premium (BS approximation) per regime, normalized to calm.
 *
 * Regime bands (DVOL):
 *   calm:      < 40
 *   moderate:  40-60
 *   elevated:  60-85
 *   stress:    >= 85
 *
 * Output: prints recommended REGIME_COST_MARKUP map, plus the count and median
 * DVOL within each regime, and writes a markdown summary to
 * docs/REGIME_VOL_MARKUP_CALIBRATION.md.
 *
 * The current hardcoded values in runTwoSidedStrangleProof.ts are conservative
 * midpoints: { calm: 1.00, moderate: 1.08, elevated: 1.20, stress: 1.35 }.
 * Run this script periodically (operator: monthly) to confirm those remain
 * appropriate against real market history. If empirical markup deviates by
 * >10% from hardcoded, update the constant and re-run runTwoSidedStrangleProof.ts.
 *
 * Usage:
 *   cd services/api
 *   npx tsx scripts/backtest/singleSide/calibrateRegimeVolMarkup.ts
 *
 * No env vars required (Deribit public API).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bsPut, bsCall } from "./coreEngine";

const SPOT_REF = 75_000;
const STRIKE_PUT = 76_000;   // 1.3% ITM put
const STRIKE_CALL = 74_000;  // 1.3% ITM call
const CONTRACTS_BTC = 1.4;
const TENOR_DAYS = 3;
const RFR = 0.045;

type DvolPoint = { tsMs: number; dvol: number };

const fetchDvolHistory = async (startMs: number, endMs: number, resolution = "1D"): Promise<DvolPoint[]> => {
  // Deribit's history endpoint accepts resolution in minutes (e.g. "60", "1D")
  // Returns: result.data = [[tsMs, open, high, low, close], ...]
  const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${startMs}&end_timestamp=${endMs}&resolution=${resolution}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Deribit DVOL fetch failed: ${res.status} ${await res.text().catch(() => "")}`);
  const json = (await res.json()) as { result: { data: number[][] } };
  return json.result.data.map((r) => ({ tsMs: r[0], dvol: r[4] })); // close (column 4)
};

type Regime = "calm" | "moderate" | "elevated" | "stress";
const classifyRegime = (dvol: number): Regime => {
  if (dvol < 40) return "calm";
  if (dvol < 60) return "moderate";
  if (dvol < 85) return "elevated";
  return "stress";
};

const median = (arr: number[]): number => {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const strangleBsPremium = (sigma: number): number => {
  const T = TENOR_DAYS / 365;
  const p = bsPut(SPOT_REF, STRIKE_PUT, T, RFR, sigma);
  const c = bsCall(SPOT_REF, STRIKE_CALL, T, RFR, sigma);
  return (p + c) * CONTRACTS_BTC;
};

const main = async () => {
  console.log("# DVOL regime cost markup calibration\n");
  const endMs = Date.now();
  const startMs = endMs - 365 * 86_400_000;

  console.log(`Fetching Deribit DVOL daily history (last 365d) ...`);
  let history: DvolPoint[];
  try {
    history = await fetchDvolHistory(startMs, endMs, "1D");
  } catch (e) {
    // Deribit sometimes rejects very long windows on 1D; fall back to monthly chunks.
    console.warn(`  long-window fetch failed (${(e as Error).message}); chunking by 60d`);
    history = [];
    let cursor = startMs;
    while (cursor < endMs) {
      const chunkEnd = Math.min(cursor + 60 * 86_400_000, endMs);
      try {
        const part = await fetchDvolHistory(cursor, chunkEnd, "1D");
        history.push(...part);
      } catch (err) {
        console.warn(`  chunk fetch failed at ${new Date(cursor).toISOString()}: ${(err as Error).message}`);
      }
      cursor = chunkEnd;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  console.log(`  pulled ${history.length} daily DVOL points`);
  if (history.length === 0) {
    console.error("No DVOL data available; cannot calibrate. Embedded markup unchanged.");
    process.exit(1);
  }

  // Per-regime DVOL stats
  const byRegime: Record<Regime, number[]> = { calm: [], moderate: [], elevated: [], stress: [] };
  for (const p of history) byRegime[classifyRegime(p.dvol)].push(p.dvol);

  // For each regime, compute median DVOL → median sigma → BS strangle premium.
  // Markup = premium_at_regime_median / premium_at_calm_median.
  const calmMedian = median(byRegime.calm);
  if (!Number.isFinite(calmMedian) || calmMedian <= 0) {
    console.error("Calm regime had no samples; cannot calibrate. Embedded markup unchanged.");
    process.exit(1);
  }
  const calmPremium = strangleBsPremium(calmMedian / 100);

  const calibration: Record<Regime, { medianDvol: number; sigma: number; premium: number; markup: number; nDays: number }> = {
    calm: { medianDvol: calmMedian, sigma: calmMedian / 100, premium: calmPremium, markup: 1.0, nDays: byRegime.calm.length },
    moderate: { medianDvol: 0, sigma: 0, premium: 0, markup: 1.0, nDays: byRegime.moderate.length },
    elevated: { medianDvol: 0, sigma: 0, premium: 0, markup: 1.0, nDays: byRegime.elevated.length },
    stress: { medianDvol: 0, sigma: 0, premium: 0, markup: 1.0, nDays: byRegime.stress.length }
  };

  for (const regime of ["moderate", "elevated", "stress"] as const) {
    const m = median(byRegime[regime]);
    if (!Number.isFinite(m) || m <= 0) {
      calibration[regime].markup = NaN;
      continue;
    }
    const sigma = m / 100;
    const premium = strangleBsPremium(sigma);
    calibration[regime] = { medianDvol: m, sigma, premium, markup: premium / calmPremium, nDays: byRegime[regime].length };
  }

  console.log("\nPer-regime calibration:\n");
  console.log("| Regime | Days | Median DVOL | Median σ | BS strangle premium | Empirical markup vs calm |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const r of ["calm", "moderate", "elevated", "stress"] as const) {
    const c = calibration[r];
    const markupStr = Number.isFinite(c.markup) ? `${c.markup.toFixed(3)}×` : "n/a (no samples)";
    console.log(
      `| ${r} | ${c.nDays} | ${c.medianDvol.toFixed(2)} | ${c.sigma.toFixed(3)} | $${c.premium.toFixed(0)} | ${markupStr} |`
    );
  }

  // Hardcoded values for comparison
  const HARDCODED = { calm: 1.0, moderate: 1.08, elevated: 1.20, stress: 1.35 };
  console.log("\nHardcoded REGIME_COST_MARKUP in runTwoSidedStrangleProof.ts:");
  console.log(`  ${JSON.stringify(HARDCODED)}`);
  console.log("\nDelta (empirical - hardcoded):");
  for (const r of ["moderate", "elevated", "stress"] as const) {
    const emp = calibration[r].markup;
    const hard = HARDCODED[r];
    if (!Number.isFinite(emp)) continue;
    const deltaPct = ((emp - hard) / hard) * 100;
    const flag = Math.abs(deltaPct) > 10 ? " ⚠️ >10% — UPDATE RECOMMENDED" : "";
    console.log(`  ${r}: empirical=${emp.toFixed(3)}× hardcoded=${hard.toFixed(2)}× Δ=${deltaPct.toFixed(1)}%${flag}`);
  }

  // Write summary doc
  const out: string[] = [];
  out.push(`# Regime Cost Markup — Empirical Calibration`);
  out.push("");
  out.push(`**Generated:** ${new Date().toISOString()}`);
  out.push(`**Window:** ${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)} (365 days)`);
  out.push(`**Source:** Deribit DVOL daily history (public API)`);
  out.push("");
  out.push(`## Methodology`);
  out.push("");
  out.push(`1. Classify each daily DVOL into regime band (calm <40, moderate 40-60, elevated 60-85, stress ≥85).`);
  out.push(`2. Compute median DVOL within each regime → median σ = DVOL/100.`);
  out.push(`3. Price a representative 3-day ITM guts strangle ($${STRIKE_PUT}/$${STRIKE_CALL}, spot $${SPOT_REF}, ${CONTRACTS_BTC} BTC) at that σ via BS.`);
  out.push(`4. Markup = premium_at_regime_median / premium_at_calm_median.`);
  out.push("");
  out.push(`## Results`);
  out.push("");
  out.push(`| Regime | Days | Median DVOL | Median σ | BS strangle premium | Empirical markup vs calm |`);
  out.push(`|---|---:|---:|---:|---:|---:|`);
  for (const r of ["calm", "moderate", "elevated", "stress"] as const) {
    const c = calibration[r];
    const markupStr = Number.isFinite(c.markup) ? `${c.markup.toFixed(3)}×` : "n/a (no samples in window)";
    out.push(`| ${r} | ${c.nDays} | ${c.medianDvol.toFixed(2)} | ${c.sigma.toFixed(3)} | $${c.premium.toFixed(0)} | ${markupStr} |`);
  }
  out.push("");
  out.push(`## Comparison to hardcoded values`);
  out.push("");
  out.push(`Current \`REGIME_COST_MARKUP\` in runTwoSidedStrangleProof.ts:`);
  out.push("```");
  out.push(JSON.stringify(HARDCODED, null, 2));
  out.push("```");
  out.push("");
  out.push(`| Regime | Empirical | Hardcoded | Δ% | Action |`);
  out.push(`|---|---:|---:|---:|---|`);
  for (const r of ["calm", "moderate", "elevated", "stress"] as const) {
    const emp = calibration[r].markup;
    const hard = HARDCODED[r];
    const delta = Number.isFinite(emp) ? ((emp - hard) / hard) * 100 : NaN;
    const action = !Number.isFinite(delta) ? "no data" : Math.abs(delta) > 10 ? "**UPDATE** hardcoded" : "within tolerance";
    out.push(`| ${r} | ${Number.isFinite(emp) ? emp.toFixed(3) + "×" : "n/a"} | ${hard.toFixed(2)}× | ${Number.isFinite(delta) ? delta.toFixed(1) + "%" : "n/a"} | ${action} |`);
  }
  out.push("");
  out.push(`**Caveat:** this calibration uses BS theoretical with constant smile shape; real market markup also includes`);
  out.push(`bid/ask widening + skew steepening which BS doesn't capture. The hardcoded values include a ~5-15% premium over`);
  out.push(`pure BS σ-scaling to account for these effects. Operator judgement required if empirical Δ > 10%.`);
  out.push("");
  out.push(`Re-run: \`npx tsx services/api/scripts/backtest/singleSide/calibrateRegimeVolMarkup.ts\``);

  const outPath = path.resolve(process.cwd(), "../..", "docs/REGIME_VOL_MARKUP_CALIBRATION.md");
  await fs.writeFile(outPath, out.join("\n"));
  console.log(`\n✓ Calibration report written to ${outPath}`);
};

// Main-guard so this can be imported without auto-running
import { fileURLToPath } from "node:url";
const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectInvocation) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
