/**
 * Live cell pricing V3 — multi-tenor smile-aware.
 *
 * Replaces liveCellPricing.ts (which used a single 3d-tenor smile for all cells).
 * Picks the closest-tenor smile bucket from /tmp/two_sided_smile_multi.json.
 *
 * Each cell's tenor (cell.tenorDays) maps to a bucket:
 *   0.1–0.5d  → 6h bucket   (most accurate for micro cell)
 *   0.5–1.5d  → 1d bucket
 *   1.5–2.5d  → 2d bucket
 *   2.5d+     → 3d bucket
 */

import * as fs from "node:fs/promises";
import { bsPut, bsCall } from "./coreEngine";
import { evaluateSmile, type SmileFit, type SpreadObservation } from "./smileModel";

type BucketData = {
  label: string;
  targetHours: number;
  fit: SmileFit | null;
  smileObservations: { strike: number; ivAnnual: number }[];
  spreadObservations: SpreadObservation[];
  wideSpreadsExcluded: string[];
};

export type LiveMultiTenorData = {
  generatedAt: string;
  spotAtPull: number;
  buckets: BucketData[];
};

let _cache: LiveMultiTenorData | null = null;

export const loadLiveMultiTenorData = async (path = "/tmp/two_sided_smile_multi.json"): Promise<LiveMultiTenorData | null> => {
  if (_cache) return _cache;
  try {
    const raw = await fs.readFile(path, "utf8");
    _cache = JSON.parse(raw) as LiveMultiTenorData;
    return _cache;
  } catch {
    return null;
  }
};

export const __resetMultiTenorCache = (): void => { _cache = null; };

const RFR = 0.045;

/** Pick the closest-tenor bucket. */
const pickBucket = (data: LiveMultiTenorData, tenorDays: number): BucketData | null => {
  const targetHours = tenorDays * 24;
  const sorted = [...data.buckets].sort(
    (a, b) => Math.abs(a.targetHours - targetHours) - Math.abs(b.targetHours - targetHours)
  );
  return sorted[0] ?? null;
};

/**
 * Live per-leg ask using multi-tenor smile.
 */
export const livePerLegAskV3 = (
  data: LiveMultiTenorData | null,
  spot: number,
  strike: number,
  optionType: "put" | "call",
  tenorDays: number,
  regimeMarkup = 1.0
): number => {
  const T = tenorDays / 365;

  if (data) {
    const bucket = pickBucket(data, tenorDays);
    if (bucket) {
      // Try direct strike + option_type match within the bucket
      const direct = bucket.spreadObservations.find(
        (s) => s.strike === strike && s.optionType === optionType
      );
      if (direct) {
        // Scale by tenor ratio if cell tenor != bucket tenor
        const bucketDays = bucket.targetHours / 24;
        if (Math.abs(bucketDays - tenorDays) < 0.05) {
          // Same tenor — use direct ask
          return direct.askUsdcPerBtc * regimeMarkup;
        }
        // Scale: ask ~ √(T) for ATM (approximate); use BS-ratio for accuracy
        const fitIv = bucket.fit ? evaluateSmile(bucket.fit, strike) : null;
        const sigma = fitIv ?? 0.36;
        const bsAtCell = optionType === "put"
          ? bsPut(spot, strike, T, RFR, sigma)
          : bsCall(spot, strike, T, RFR, sigma);
        const bsAtBucket = optionType === "put"
          ? bsPut(spot, strike, bucketDays / 365, RFR, sigma)
          : bsCall(spot, strike, bucketDays / 365, RFR, sigma);
        const scale = bsAtBucket > 0 ? bsAtCell / bsAtBucket : 1;
        return direct.askUsdcPerBtc * scale * regimeMarkup;
      }

      // No direct — use smile interp + BS + avg ask-over-mid
      if (bucket.fit) {
        const iv = evaluateSmile(bucket.fit, strike) ?? 0.36;
        const bs = optionType === "put"
          ? bsPut(spot, strike, T, RFR, iv)
          : bsCall(spot, strike, T, RFR, iv);
        const sameType = bucket.spreadObservations.filter((s) => s.optionType === optionType);
        const avgAskOverMid = sameType.length > 0
          ? sameType.reduce((s, o) => s + (o.midUsdcPerBtc > 0 ? o.askUsdcPerBtc / o.midUsdcPerBtc : 1.0), 0) / sameType.length
          : 1.15;
        return bs * avgAskOverMid * regimeMarkup;
      }
    }
  }

  // Final fallback
  const bs = optionType === "put"
    ? bsPut(spot, strike, T, RFR, 0.36)
    : bsCall(spot, strike, T, RFR, 0.36);
  return bs * 1.07 * regimeMarkup;
};

export const liveSlippageHaircutV3 = (
  data: LiveMultiTenorData | null,
  strike: number,
  optionType: "put" | "call",
  contractsBtc: number,
  tenorDays: number
): number => {
  if (!data) return 0.85;
  const bucket = pickBucket(data, tenorDays);
  if (!bucket) return 0.85;
  const sameType = bucket.spreadObservations.filter((s) => s.optionType === optionType);
  if (sameType.length === 0) return 0.85;
  const closest = sameType.reduce((best, o) =>
    Math.abs(o.strike - strike) < Math.abs(best.strike - strike) ? o : best
  );
  const spread = closest.midUsdcPerBtc > 0
    ? (closest.askUsdcPerBtc - closest.bidUsdcPerBtc) / closest.midUsdcPerBtc
    : 0.15;
  return Math.max(0.65, Math.min(0.95, 0.95 - spread * 1.5));
};
