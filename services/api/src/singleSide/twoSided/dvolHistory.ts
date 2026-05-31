/**
 * DVOL history collector + reader for regime calibration.
 *
 * The DvolService caches only the LATEST DVOL value. For regime calibration
 * (Phase 2) we need historical samples so we can derive each regime's true
 * mean/median sigma from observed data instead of using hardcoded synthetic
 * values like {calm: 0.35, moderate: 0.55, elevated: 0.75, stress: 0.95}.
 *
 * This module:
 *   1. Persists every DVOL sample to two_sided_dvol_history (cheap append)
 *   2. Provides readers that compute per-regime sigma statistics over a
 *      rolling window
 *   3. Surfaces the calibration result + sample count so callers can decide
 *      whether to trust it or fall back to defaults
 *
 * Sample frequency: matches DvolService poll rate (default 60s).
 *
 * Regime classification follows featureFlag.classifyRegime so history
 * buckets agree with live decisions.
 */

import type { Pool, PoolClient } from "pg";
import { classifyRegime, type Regime } from "./featureFlag";

export type DvolHistorySample = {
  asOfMs: number;
  dvol: number;
  sigmaAnnual: number;
  regime: Regime;
};

export const ensureDvolHistorySchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_dvol_history (
      sample_id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      dvol NUMERIC(8,3) NOT NULL,
      sigma_annual NUMERIC(8,5) NOT NULL,
      regime TEXT NOT NULL CHECK (regime IN ('calm', 'moderate', 'elevated', 'stress'))
    );
  `);
  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_two_sided_dvol_history_ts ON two_sided_dvol_history(ts DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_two_sided_dvol_history_regime_ts ON two_sided_dvol_history(regime, ts DESC);`);
  } catch {
    /* pg-mem may not support these */
  }
};

/**
 * Persist a sample. Deduped on minute granularity to avoid bloating the
 * table when poll interval is faster than that.
 */
export const persistDvolSample = async (
  pool: Pool | PoolClient,
  sample: { asOfMs: number; dvol: number; sigmaAnnual: number }
): Promise<void> => {
  const regime = classifyRegime(sample.dvol);
  const ts = new Date(sample.asOfMs);
  // Bucket to minute; dedupe via NOT EXISTS check (no UNIQUE constraint to keep
  // schema simple — at worst we get rare duplicate samples in same minute)
  const minuteStart = Math.floor(sample.asOfMs / 60_000) * 60_000;
  const minuteStartIso = new Date(minuteStart).toISOString();
  await pool.query(
    `INSERT INTO two_sided_dvol_history (ts, dvol, sigma_annual, regime)
     SELECT $1::timestamptz, $2::numeric, $3::numeric, $4
     WHERE NOT EXISTS (
       SELECT 1 FROM two_sided_dvol_history
       WHERE ts >= $5::timestamptz
         AND ts < ($5::timestamptz + INTERVAL '1 minute')
     )`,
    [ts.toISOString(), sample.dvol, sample.sigmaAnnual, regime, minuteStartIso]
  );
};

export type RegimeSigmaStats = {
  regime: Regime;
  sampleCount: number;
  meanSigma: number | null;
  medianSigma: number | null;
  /** Recency-weighted (half-life) mean sigma — tracks regime transitions faster than median. */
  ewmaSigma: number | null;
  p25Sigma: number | null;
  p75Sigma: number | null;
  minSigma: number | null;
  maxSigma: number | null;
  oldestSampleMs: number | null;
  newestSampleMs: number | null;
};

const median = (sorted: number[]): number | null => {
  if (sorted.length === 0) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};

const percentile = (sorted: number[], p: number): number | null => {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * sorted.length)));
  return sorted[idx];
};

/**
 * Get historical sigma stats for ONE regime over the lookback window.
 *
 * If sampleCount < minSamplesRequired, callers should treat the stats as
 * unreliable and fall back to documented synthetic defaults.
 */
export const getRegimeSigmaStats = async (
  pool: Pool | PoolClient,
  regime: Regime,
  opts: {
    lookbackMs?: number;
    nowMs?: number;
    halfLifeDays?: number;
  } = {}
): Promise<RegimeSigmaStats> => {
  const lookbackMs = opts.lookbackMs ?? 30 * 86_400_000; // 30d default
  const nowMs = opts.nowMs ?? Date.now();
  const halfLifeDays = opts.halfLifeDays ?? 14;
  const cutoff = new Date(nowMs - lookbackMs).toISOString();
  const r = await pool.query<{ sigma_annual: string; ts: string }>(
    `SELECT sigma_annual, ts FROM two_sided_dvol_history
     WHERE regime = $1 AND ts >= $2
     ORDER BY ts ASC`,
    [regime, cutoff]
  );
  if (r.rows.length === 0) {
    return {
      regime,
      sampleCount: 0,
      meanSigma: null,
      medianSigma: null,
      ewmaSigma: null,
      p25Sigma: null,
      p75Sigma: null,
      minSigma: null,
      maxSigma: null,
      oldestSampleMs: null,
      newestSampleMs: null
    };
  }
  const sigmas = r.rows.map((row) => Number(row.sigma_annual)).filter((s) => Number.isFinite(s) && s > 0);
  const sorted = [...sigmas].sort((a, b) => a - b);
  const sum = sigmas.reduce((s, x) => s + x, 0);
  // EWMA: weight each sample by 0.5^(ageDays/halfLifeDays) relative to the newest
  // sample, so recent DVOL dominates — tracks regime transitions faster than median.
  const newestTs = Date.parse(r.rows[r.rows.length - 1].ts);
  const halfLifeMs = Math.max(1, halfLifeDays) * 86_400_000;
  let wSum = 0;
  let wvSum = 0;
  for (const row of r.rows) {
    const s = Number(row.sigma_annual);
    if (!Number.isFinite(s) || s <= 0) continue;
    const w = Math.pow(0.5, (newestTs - Date.parse(row.ts)) / halfLifeMs);
    wSum += w;
    wvSum += w * s;
  }
  return {
    regime,
    sampleCount: sigmas.length,
    meanSigma: sigmas.length > 0 ? sum / sigmas.length : null,
    medianSigma: median(sorted),
    ewmaSigma: wSum > 0 ? wvSum / wSum : null,
    p25Sigma: percentile(sorted, 0.25),
    p75Sigma: percentile(sorted, 0.75),
    minSigma: sorted[0] ?? null,
    maxSigma: sorted[sorted.length - 1] ?? null,
    oldestSampleMs: Date.parse(r.rows[0].ts),
    newestSampleMs: Date.parse(r.rows[r.rows.length - 1].ts)
  };
};

/**
 * Get sigma stats for all four regimes in one call. Used by regimeCalibration.
 */
export const getAllRegimeSigmaStats = async (
  pool: Pool | PoolClient,
  opts: {
    lookbackMs?: number;
    nowMs?: number;
    halfLifeDays?: number;
  } = {}
): Promise<Record<Regime, RegimeSigmaStats>> => {
  const regimes: Regime[] = ["calm", "moderate", "elevated", "stress"];
  const results = await Promise.all(regimes.map((r) => getRegimeSigmaStats(pool, r, opts)));
  return {
    calm: results[0],
    moderate: results[1],
    elevated: results[2],
    stress: results[3]
  };
};

/**
 * Background persister — call once at server boot. Hooks into DvolService's
 * onSample callback (added below) so every fresh DVOL poll writes a row.
 *
 * Returns the unsubscribe function for tests / shutdown.
 */
export type DvolPersisterDeps = {
  pool: Pool;
  dvolService: {
    getCurrentDvol: (nowMs?: number) => { dvol: number; sigmaAnnual: number; asOfMs: number } | null;
  };
  intervalMs?: number;
  log?: (msg: string) => void;
};

export const startDvolPersister = (
  deps: DvolPersisterDeps
): { stop: () => void } => {
  const intervalMs = deps.intervalMs ?? 60_000;
  const log = deps.log ?? ((m) => console.log(`[dvolPersister] ${m}`));
  let lastPersistedMinuteBucket = 0;
  const timer = setInterval(() => {
    try {
      const sample = deps.dvolService.getCurrentDvol();
      if (!sample) return;
      const minuteBucket = Math.floor(sample.asOfMs / 60_000);
      if (minuteBucket === lastPersistedMinuteBucket) return; // already wrote this minute
      void persistDvolSample(deps.pool, {
        asOfMs: sample.asOfMs,
        dvol: sample.dvol,
        sigmaAnnual: sample.sigmaAnnual
      }).then(() => {
        lastPersistedMinuteBucket = minuteBucket;
      }).catch((e) => log(`persist failed: ${(e as Error).message}`));
    } catch (e) {
      log(`tick error: ${(e as Error).message}`);
    }
  }, intervalMs);
  if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  log(`started (interval=${intervalMs}ms)`);
  return {
    stop: () => clearInterval(timer)
  };
};
