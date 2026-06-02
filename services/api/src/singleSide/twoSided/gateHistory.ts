/**
 * Gate history buffer — tracks recent VRP values and gate outcomes so the
 * /foxify/v2/should_activate endpoint can surface trend + sustained-confidence
 * signals to Foxify's bot.
 *
 * Two metrics computed:
 *   1. **vrp_trend**: VRP delta over the last N min (positive = loosening = bad
 *      for buyers; negative = tightening = good for buyers approaching threshold)
 *   2. **consecutive_good_seconds**: how long the gate has been continuously
 *      good_to_activate=true. Foxify's bot can use this to wait for sustained
 *      signal before activating (avoids one-off noise activations).
 *
 * In-memory ring buffer (3600 entries = 1 hour at 1/sec OR ~12 hours at one
 * read per 12 sec). Size kept tiny to avoid memory pressure.
 */

export type GateHistoryEntry = {
  asOfMs: number;
  vrp: number | null;
  goodToActivate: boolean;
  regime: string | null;
  /** DVOL at snapshot — optional/additive, used for regime-proximity trend. */
  dvol?: number | null;
};

const MAX_ENTRIES = 3600;
const _history: GateHistoryEntry[] = [];

export const recordGateSnapshot = (entry: GateHistoryEntry): void => {
  _history.push(entry);
  if (_history.length > MAX_ENTRIES) _history.shift();
};

/** Number of entries currently held. For tests / observability. */
export const __getGateHistorySize = (): number => _history.length;
export const __resetGateHistory = (): void => { _history.length = 0; };

/**
 * VRP trend = current_vrp - vrp_N_min_ago.
 * Positive = VRP has risen (implied getting richer relative to realized — bad for buyers).
 * Negative = VRP has fallen (implied getting cheaper — better for buyers, approaching threshold).
 * Returns null if no historical data.
 */
export const computeVrpTrend = (lookbackMinutes: number, nowMs = Date.now()): { delta: number | null; sampleCount: number; ageRangeMin: number | null } => {
  const lookbackMs = lookbackMinutes * 60_000;
  const oldEnoughEntries = _history.filter((e) => e.vrp != null && e.asOfMs <= nowMs - lookbackMs * 0.8);
  if (oldEnoughEntries.length === 0 || _history.length === 0) {
    return { delta: null, sampleCount: 0, ageRangeMin: null };
  }
  const oldest = oldEnoughEntries[0]; // first sample old enough
  const newest = _history[_history.length - 1];
  if (newest.vrp == null || oldest.vrp == null) {
    return { delta: null, sampleCount: 0, ageRangeMin: null };
  }
  return {
    delta: newest.vrp - oldest.vrp,
    sampleCount: oldEnoughEntries.length,
    ageRangeMin: (newest.asOfMs - oldest.asOfMs) / 60_000
  };
};

/**
 * DVOL trend = current_dvol - dvol_N_min_ago. Positive = rising (approaching the
 * next regime-up boundary); negative = falling. Null if no DVOL history.
 */
export const computeDvolTrend = (lookbackMinutes: number, nowMs = Date.now()): { delta: number | null; sampleCount: number; ageRangeMin: number | null } => {
  const lookbackMs = lookbackMinutes * 60_000;
  const oldEnough = _history.filter((e) => e.dvol != null && e.asOfMs <= nowMs - lookbackMs * 0.8);
  const newest = _history.length > 0 ? _history[_history.length - 1] : null;
  if (oldEnough.length === 0 || newest == null || newest.dvol == null) {
    return { delta: null, sampleCount: 0, ageRangeMin: null };
  }
  const oldest = oldEnough[0];
  if (oldest.dvol == null) return { delta: null, sampleCount: 0, ageRangeMin: null };
  return {
    delta: +(newest.dvol - oldest.dvol).toFixed(3),
    sampleCount: oldEnough.length,
    ageRangeMin: (newest.asOfMs - oldest.asOfMs) / 60_000
  };
};

/**
 * How long (in seconds) has the gate been continuously good_to_activate=true?
 * Returns 0 if the most recent snapshot is bad, or if no history.
 * Returns null if history is too sparse (< 2 entries).
 */
export const computeConsecutiveGoodSeconds = (nowMs = Date.now()): number | null => {
  if (_history.length < 2) return null;
  const lastIdx = _history.length - 1;
  if (!_history[lastIdx].goodToActivate) return 0;
  // Walk backwards from end while goodToActivate=true
  let firstGoodIdx = lastIdx;
  for (let i = lastIdx; i >= 0; i--) {
    if (_history[i].goodToActivate) {
      firstGoodIdx = i;
    } else {
      break;
    }
  }
  const firstGoodTs = _history[firstGoodIdx].asOfMs;
  return Math.max(0, (nowMs - firstGoodTs) / 1000);
};

/** Latest history entry, or null if empty. */
export const getLatestSnapshot = (): GateHistoryEntry | null =>
  _history.length > 0 ? _history[_history.length - 1] : null;
