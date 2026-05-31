/**
 * Chain snapshot persister + reader for regime markup calibration.
 *
 * Records compact summaries of LiquidChainCache snapshots so we can compute
 * per-regime bid-ask widening (markup) from real data instead of the
 * hardcoded REGIME_MARKUP = {calm: 1.00, moderate: 1.15, elevated: 1.35,
 * stress: 1.60} synthetic defaults.
 *
 * STORAGE STRATEGY: not the full snapshot (would balloon). We store the
 * ATM strangle summary per minute:
 *   - timestamp
 *   - regime (from current DVOL)
 *   - spot
 *   - atm_put_bid, atm_put_ask, atm_put_mid, atm_call_bid, atm_call_ask, atm_call_mid
 *   - venue (which venue won the ATM pick at this moment)
 *
 * This is enough to derive: ask_widening = atm_ask_mid / median_atm_mid_in_calm
 * which gives an empirical "how much wider are asks in this regime than in calm".
 *
 * Falls back to hardcoded REGIME_MARKUP when chain history is sparse
 * (<7 days of data per regime).
 */

import type { Pool, PoolClient } from "pg";
import { classifyRegime, type Regime } from "./featureFlag";
import type { LiquidChainCache } from "./liquidChainCache";

export const ensureChainSnapshotSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_chain_snapshot (
      snapshot_id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      regime TEXT NOT NULL CHECK (regime IN ('calm', 'moderate', 'elevated', 'stress')),
      dvol NUMERIC(8,3),
      spot NUMERIC(12,2) NOT NULL,
      tenor_days NUMERIC(5,2) NOT NULL,
      atm_put_strike NUMERIC(12,2) NOT NULL,
      atm_put_bid_per_btc NUMERIC(12,4),
      atm_put_ask_per_btc NUMERIC(12,4),
      atm_put_mid_per_btc NUMERIC(12,4),
      atm_put_venue TEXT,
      atm_call_strike NUMERIC(12,2) NOT NULL,
      atm_call_bid_per_btc NUMERIC(12,4),
      atm_call_ask_per_btc NUMERIC(12,4),
      atm_call_mid_per_btc NUMERIC(12,4),
      atm_call_venue TEXT
    );
  `);
  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_two_sided_chain_snapshot_ts ON two_sided_chain_snapshot(ts DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_two_sided_chain_snapshot_regime_ts ON two_sided_chain_snapshot(regime, ts DESC);`);
  } catch {
    /* pg-mem may not support these */
  }
};

export type ChainSnapshotRow = {
  asOfMs: number;
  regime: Regime;
  dvol: number | null;
  spot: number;
  tenorDays: number;
  putStrike: number;
  putBid: number | null;
  putAsk: number | null;
  putMid: number | null;
  putVenue: string | null;
  callStrike: number;
  callBid: number | null;
  callAsk: number | null;
  callMid: number | null;
  callVenue: string | null;
};

/**
 * Capture one snapshot from the live chain cache for the ATM put + call
 * at the given target tenor. Persists if the chain has both legs.
 */
export const captureChainSnapshot = async (
  pool: Pool | PoolClient,
  inputs: {
    liquidChainCache: LiquidChainCache;
    dvol: number;
    spot: number;
    tenorDays: number;
    nowMs?: number;
  }
): Promise<ChainSnapshotRow | null> => {
  const nowMs = inputs.nowMs ?? Date.now();
  const regime = classifyRegime(inputs.dvol);
  const tenorHours = inputs.tenorDays * 24;
  // ATM: round spot to nearest $1k for strike
  const atmStrike = Math.round(inputs.spot / 1000) * 1000;
  const putLookup = inputs.liquidChainCache.getBidForLeg({
    strike: atmStrike, optType: "put",
    tenorRemainingHours: tenorHours, preferVenue: "bullish"
  });
  const callLookup = inputs.liquidChainCache.getBidForLeg({
    strike: atmStrike, optType: "call",
    tenorRemainingHours: tenorHours, preferVenue: "bullish"
  });
  if (!putLookup || !callLookup) return null;
  await pool.query(
    `INSERT INTO two_sided_chain_snapshot (
       ts, regime, dvol, spot, tenor_days,
       atm_put_strike, atm_put_bid_per_btc, atm_put_ask_per_btc, atm_put_mid_per_btc, atm_put_venue,
       atm_call_strike, atm_call_bid_per_btc, atm_call_ask_per_btc, atm_call_mid_per_btc, atm_call_venue
     ) VALUES ($1::timestamptz,$2,$3,$4,$5, $6,$7,$8,$9,$10, $11,$12,$13,$14,$15)`,
    [
      new Date(nowMs).toISOString(), regime, inputs.dvol, inputs.spot, inputs.tenorDays,
      atmStrike, putLookup.bidUsdcPerBtc, putLookup.askUsdcPerBtc, putLookup.midUsdcPerBtc, putLookup.venue,
      atmStrike, callLookup.bidUsdcPerBtc, callLookup.askUsdcPerBtc, callLookup.midUsdcPerBtc, callLookup.venue
    ]
  );
  return {
    asOfMs: nowMs, regime, dvol: inputs.dvol, spot: inputs.spot, tenorDays: inputs.tenorDays,
    putStrike: atmStrike, putBid: putLookup.bidUsdcPerBtc, putAsk: putLookup.askUsdcPerBtc,
    putMid: putLookup.midUsdcPerBtc, putVenue: putLookup.venue,
    callStrike: atmStrike, callBid: callLookup.bidUsdcPerBtc, callAsk: callLookup.askUsdcPerBtc,
    callMid: callLookup.midUsdcPerBtc, callVenue: callLookup.venue
  };
};

/**
 * Compute the ask-widening ratio for each non-calm regime, using calm as
 * baseline. ratio = median(atm_ask_total_in_regime) / median(atm_ask_total_in_calm)
 *
 * Returns ratios per regime + sample counts so callers know how trustworthy
 * the calibration is.
 */
export type RegimeMarkupStats = {
  regime: Regime;
  sampleCount: number;
  medianAtmAskTotal: number | null;
  markupVsCalm: number | null;        // ratio (e.g. 1.15 = 15% wider than calm)
  oldestSampleMs: number | null;
  newestSampleMs: number | null;
};

const median = (sorted: number[]): number | null => {
  if (sorted.length === 0) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};

export const getRegimeMarkupStats = async (
  pool: Pool | PoolClient,
  opts: {
    lookbackMs?: number;
    nowMs?: number;
  } = {}
): Promise<Record<Regime, RegimeMarkupStats>> => {
  const lookbackMs = opts.lookbackMs ?? 30 * 86_400_000;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = new Date(nowMs - lookbackMs).toISOString();
  const r = await pool.query<{
    regime: Regime;
    atm_put_ask_per_btc: string | null;
    atm_call_ask_per_btc: string | null;
    ts: string;
  }>(
    `SELECT regime, atm_put_ask_per_btc, atm_call_ask_per_btc, ts
     FROM two_sided_chain_snapshot
     WHERE ts >= $1
       AND atm_put_ask_per_btc IS NOT NULL
       AND atm_call_ask_per_btc IS NOT NULL
     ORDER BY ts ASC`,
    [cutoff]
  );
  const byRegime: Record<Regime, { totals: number[]; oldest: number | null; newest: number | null }> = {
    calm: { totals: [], oldest: null, newest: null },
    moderate: { totals: [], oldest: null, newest: null },
    elevated: { totals: [], oldest: null, newest: null },
    stress: { totals: [], oldest: null, newest: null }
  };
  for (const row of r.rows) {
    const putAsk = Number(row.atm_put_ask_per_btc);
    const callAsk = Number(row.atm_call_ask_per_btc);
    if (!Number.isFinite(putAsk) || !Number.isFinite(callAsk)) continue;
    const total = putAsk + callAsk;
    const tsMs = Date.parse(row.ts);
    byRegime[row.regime].totals.push(total);
    if (byRegime[row.regime].oldest == null) byRegime[row.regime].oldest = tsMs;
    byRegime[row.regime].newest = tsMs;
  }
  // Compute calm median first (baseline for markup ratios)
  const calmMedian = median([...byRegime.calm.totals].sort((a, b) => a - b));
  const out: Record<Regime, RegimeMarkupStats> = {} as Record<Regime, RegimeMarkupStats>;
  for (const regime of (Object.keys(byRegime) as Regime[])) {
    const data = byRegime[regime];
    const med = median([...data.totals].sort((a, b) => a - b));
    out[regime] = {
      regime,
      sampleCount: data.totals.length,
      medianAtmAskTotal: med,
      markupVsCalm: calmMedian != null && med != null && calmMedian > 0 ? med / calmMedian : null,
      oldestSampleMs: data.oldest,
      newestSampleMs: data.newest
    };
  }
  return out;
};

/**
 * Background persister — call once at server boot.
 */
export type ChainSnapshotPersisterDeps = {
  pool: Pool;
  liquidChainCache: LiquidChainCache;
  getCurrentDvol: () => { dvol: number; sigmaAnnual: number } | null;
  getCurrentSpot: () => number | null;
  intervalMs?: number;
  tenorDays?: number;
  log?: (msg: string) => void;
};

export const startChainSnapshotPersister = (
  deps: ChainSnapshotPersisterDeps
): { stop: () => void } => {
  const intervalMs = deps.intervalMs ?? 60_000;
  const tenorDays = deps.tenorDays ?? 2;
  const log = deps.log ?? ((m) => console.log(`[chainSnapshotPersister] ${m}`));
  let lastMinuteBucket = 0;
  const timer = setInterval(() => {
    try {
      const dvol = deps.getCurrentDvol();
      const spot = deps.getCurrentSpot();
      if (dvol == null || spot == null) return;
      const minuteBucket = Math.floor(Date.now() / 60_000);
      if (minuteBucket === lastMinuteBucket) return;
      void captureChainSnapshot(deps.pool, {
        liquidChainCache: deps.liquidChainCache,
        dvol: dvol.dvol,
        spot,
        tenorDays
      }).then((row) => {
        if (row) {
          lastMinuteBucket = minuteBucket;
        }
      }).catch((e) => log(`capture failed: ${(e as Error).message}`));
    } catch (e) {
      log(`tick error: ${(e as Error).message}`);
    }
  }, intervalMs);
  if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  log(`started (interval=${intervalMs}ms, tenor=${tenorDays}d)`);
  return { stop: () => clearInterval(timer) };
};
