/**
 * Historical DVOL backfill (Phase 6) — makes regime calibration EMPIRICAL for
 * ALL regimes instead of waiting ~2 weeks for live samples to accumulate.
 *
 * Pulls historical Deribit DVOL (the SAME REAL source DvolService polls live —
 * /public/get_volatility_index_data) over a window and writes each bar to
 * two_sided_dvol_history via persistDvolSample. This is NOT synthetic data: it
 * is Deribit's published volatility index, just historical instead of live
 * (an explicitly-allowed exception in the operating rules).
 *
 * After a backfill, getRegimeCalibration flips from synthetic_default to
 * empirical_median for every regime with >=100 samples, so the cell sweep's
 * non-current-regime results become REAL calibration (not estimate).
 *
 * Idempotent: persistDvolSample dedupes on minute granularity, so re-running
 * over an overlapping window inserts no duplicates.
 *
 * Requests are WINDOWED (default 10-day chunks) to stay well under Deribit's
 * per-request data-point cap (90d hourly = 2160 points; chunked to ~240/req).
 */

import type { Pool, PoolClient } from "pg";
import { persistDvolSample, ensureDvolHistorySchema } from "../../src/singleSide/twoSided/dvolHistory";
import { classifyRegime, type Regime } from "../../src/singleSide/twoSided/featureFlag";

const DERIBIT_VOL_URL = "https://www.deribit.com/api/v2/public/get_volatility_index_data";
const MS_PER_DAY = 86_400_000;

/** One DVOL bar: timestamp (ms) + close value (percent, e.g. 55.2 = 55.2% vol). */
export type DvolBar = { tsMs: number; dvol: number };

/** Fetch a single time window of DVOL bars. Injectable for tests. */
export type DvolBackfillFetch = (startMs: number, endMs: number, resolutionSec: number) => Promise<DvolBar[]>;

/** Real Deribit fetch for one window. Throws on non-200 (caller decides retry/skip). */
export const fetchDvolWindowFromDeribit = async (
  startMs: number, endMs: number, resolutionSec: number, timeoutMs = 15_000
): Promise<DvolBar[]> => {
  const url = `${DERIBIT_VOL_URL}?currency=BTC&start_timestamp=${startMs}&end_timestamp=${endMs}&resolution=${resolutionSec}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!res.ok) throw new Error(`deribit get_volatility_index_data HTTP ${res.status}`);
    const body = (await res.json()) as { result?: { data?: number[][] } };
    const rows = body.result?.data ?? [];
    // Each row: [timestamp_ms, open, high, low, close]; we use close (index 4).
    return rows
      .filter((r) => Array.isArray(r) && r.length >= 5 && Number.isFinite(r[0]) && Number.isFinite(r[4]) && r[4] > 0)
      .map((r) => ({ tsMs: r[0], dvol: r[4] }));
  } finally {
    clearTimeout(timer);
  }
};

export type DvolBackfillResult = {
  days: number;
  resolutionSec: number;
  windows: number;
  windowsFailed: number;
  barsFetched: number;
  barsInserted: number;       // accurate (count delta), excludes dedupe-skipped
  regimeBreakdown: Record<Regime, number>;  // over fetched bars
  oldestMs: number | null;
  newestMs: number | null;
};

const countRows = async (pool: Pool | PoolClient): Promise<number> => {
  const r = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM two_sided_dvol_history`);
  return Number(r.rows[0]?.n ?? 0);
};

/**
 * Backfill `days` of DVOL history at `resolutionSec` granularity, fetching in
 * `windowDays` chunks. Idempotent + safe to re-run.
 */
export const backfillDvolHistory = async (
  pool: Pool,
  opts: {
    days?: number;
    resolutionSec?: number;
    windowDays?: number;
    /**
     * Explicit absolute window (ms epoch). When BOTH startMs and endMs are
     * provided they OVERRIDE the `days`/`now` relative window — use this to
     * target a HISTORICAL VOLATILE period (e.g. a past elevated/stress month)
     * so regime calibration becomes empirical for those regimes. Still REAL
     * Deribit data, just an arbitrary date range. endMs must be > startMs.
     */
    startMs?: number;
    endMs?: number;
    fetch?: DvolBackfillFetch;
    nowMs?: number;
    log?: (msg: string) => void;
  } = {}
): Promise<DvolBackfillResult> => {
  const days = opts.days ?? 90;
  const resolutionSec = opts.resolutionSec ?? 3600;
  const windowDays = opts.windowDays ?? 10;
  const fetcher = opts.fetch ?? ((s, e, r) => fetchDvolWindowFromDeribit(s, e, r));
  const now = opts.nowMs ?? Date.now();
  // Explicit window overrides the relative one (target historical vol periods).
  const useExplicit = opts.startMs != null && opts.endMs != null && opts.endMs > opts.startMs;
  const start = useExplicit ? (opts.startMs as number) : now - days * MS_PER_DAY;
  const end = useExplicit ? (opts.endMs as number) : now;
  const log = opts.log ?? (() => {});

  await ensureDvolHistorySchema(pool);
  const before = await countRows(pool);

  const regimeBreakdown: Record<Regime, number> = { calm: 0, moderate: 0, elevated: 0, stress: 0 };
  let windows = 0;
  let windowsFailed = 0;
  let barsFetched = 0;
  let oldestMs: number | null = null;
  let newestMs: number | null = null;

  for (let wStart = start; wStart < end; wStart += windowDays * MS_PER_DAY) {
    const wEnd = Math.min(end, wStart + windowDays * MS_PER_DAY);
    windows++;
    let bars: DvolBar[];
    try {
      bars = await fetcher(wStart, wEnd, resolutionSec);
    } catch (e) {
      windowsFailed++;
      log(`window ${new Date(wStart).toISOString()} fetch failed: ${(e as Error).message}`);
      continue;
    }
    barsFetched += bars.length;
    for (const b of bars) {
      await persistDvolSample(pool, { asOfMs: b.tsMs, dvol: b.dvol, sigmaAnnual: b.dvol / 100 });
      regimeBreakdown[classifyRegime(b.dvol)]++;
      oldestMs = oldestMs == null ? b.tsMs : Math.min(oldestMs, b.tsMs);
      newestMs = newestMs == null ? b.tsMs : Math.max(newestMs, b.tsMs);
    }
    log(`window ${windows} [${new Date(wStart).toISOString().slice(0, 10)}..${new Date(wEnd).toISOString().slice(0, 10)}]: ${bars.length} bars`);
  }

  const after = await countRows(pool);
  return {
    days: useExplicit ? +((end - start) / MS_PER_DAY).toFixed(2) : days,
    resolutionSec, windows, windowsFailed,
    barsFetched, barsInserted: after - before,
    regimeBreakdown, oldestMs, newestMs
  };
};
