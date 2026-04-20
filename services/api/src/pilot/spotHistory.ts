/**
 * Spot price history ring buffer (PR C).
 *
 * Tracks BTC spot samples for the last ~24 hours so the active TP
 * gaps (Gap 1 volatility-spike forced exit, Gap 3 price-direction
 * cooling shrink) can ask "how much has spot moved over the last N
 * hours?" without each TP cycle having to re-fetch historical data
 * from Deribit.
 *
 * The hedge-management cycle already fetches spot at every iteration
 * (default every 60s), so by the time these gaps need to evaluate,
 * we have ~24h of samples cached in process memory at zero extra
 * Deribit API cost.
 *
 * Capacity: at 60s cadence × 24h = 1,440 samples max. In-memory size
 * is trivial (~30 KB). When the process restarts, the buffer empties
 * and the gaps degrade gracefully — both are designed to no-op when
 * insufficient history exists (returning null from the query helpers
 * so the cycle treats the move check as "unknown" and skips firing).
 */

export type SpotSample = {
  ms: number;
  spot: number;
};

const buffer: SpotSample[] = [];
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_SAMPLES = 5000; // hard ceiling against runaway memory

export const recordSpotSample = (spot: number, atMs: number = Date.now()): void => {
  if (!Number.isFinite(spot) || spot <= 0) return;
  buffer.push({ ms: atMs, spot });
  // Drop samples beyond the rolling window.
  const cutoff = atMs - MAX_AGE_MS;
  while (buffer.length && buffer[0].ms < cutoff) {
    buffer.shift();
  }
  // Hard cap (defensive — should never trigger at 60s cadence).
  while (buffer.length > MAX_SAMPLES) {
    buffer.shift();
  }
};

/**
 * Get the percentage change from `lookbackMs` ago to now. Positive
 * value = spot rose; negative = spot fell. Returns null if no sample
 * old enough exists.
 *
 * "Old enough" = the oldest sample we have that is at least
 * (lookbackMs - tolerance) old. If our most-recent comparable sample
 * is too young, we return null (cycle treats the move check as
 * "unknown").
 */
export const getSpotMovePct = (
  lookbackMs: number,
  atMs: number = Date.now(),
  toleranceMs: number = 60_000
): number | null => {
  if (buffer.length < 2) return null;
  const targetMs = atMs - lookbackMs;
  // Find the sample closest to targetMs but not significantly newer
  // than it (within tolerance).
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < buffer.length; i++) {
    const dist = Math.abs(buffer[i].ms - targetMs);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  // Reject if we don't actually have a sample old enough. We accept a
  // sample that's slightly newer than targetMs (within tolerance) so
  // small clock drift / cycle skew doesn't kill the lookback.
  if (buffer[bestIdx].ms > atMs - lookbackMs + toleranceMs) return null;
  const past = buffer[bestIdx].spot;
  const current = buffer[buffer.length - 1].spot;
  if (past <= 0) return null;
  return ((current - past) / past) * 100;
};

/**
 * Test/debug helpers.
 */
export const __resetSpotHistoryForTests = (): void => {
  buffer.length = 0;
};

export const __getSpotHistoryLengthForTests = (): number => buffer.length;

export const __getSpotHistorySnapshotForTests = (): SpotSample[] => [...buffer];
