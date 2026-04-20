/**
 * Defensive circuit breaker for the pilot platform (PR B).
 *
 * Two distinct circuits, both opt-in via env config but enabled by
 * default in production:
 *
 *   1. Max-loss circuit — trips when the Deribit equity has dropped
 *      by more than PILOT_CIRCUIT_BREAKER_MAX_LOSS_PCT in a rolling
 *      24-hour window. While tripped, the activate path refuses new
 *      protection sales until either:
 *        - an operator manually un-pauses via /pilot/admin/circuit-breaker/reset
 *        - the cooldown window elapses (PILOT_CIRCUIT_BREAKER_COOLDOWN_MS)
 *      The breaker observes Deribit balance every cycle of the
 *      hedge-management interval (default 60s) and stores rolling
 *      24h baseline for comparison.
 *
 *   2. Auto-renew freeze — when the pricing regime is "high" (DVOL > 80
 *      configured), the auto-renew scheduler skips new renewals. The
 *      protected position itself is unaffected; it simply doesn't
 *      auto-roll into a new contract at the current expensive price.
 *      Trader can still manually open a new position. This is the
 *      defensive equivalent of "don't auto-buy at peak premium."
 *
 * Both circuits are idempotent and observable via /pilot/admin/circuit-breaker.
 */

export type BalanceSample = {
  ms: number;
  /** Equity in BTC (Deribit's account_summary.equity field). */
  equityBtc: number;
};

export type CircuitState =
  | { tripped: false; reason: null; trippedAt: null; baselineBtc: number | null; currentBtc: number | null; lossPct: number | null }
  | { tripped: true; reason: string; trippedAt: string; baselineBtc: number; currentBtc: number; lossPct: number; cooldownExpiresAt: string };

export type CircuitBreakerConfig = {
  /** Fractional drop of equity (e.g., 0.50 = 50%) over the rolling window that trips the breaker. */
  maxLossPct: number;
  /** Rolling window in milliseconds (default 24h). */
  windowMs: number;
  /** After trip, how long to wait before auto-resetting (default 4h). 0 = manual-reset only. */
  cooldownMs: number;
  /** Minimum balance samples in window before the breaker can trip (avoids cold-start false positives). */
  minSamplesForTrip: number;
  /** When false, the breaker observes and logs but never blocks. */
  enforce: boolean;
};

const DEFAULTS: CircuitBreakerConfig = {
  maxLossPct: 0.5,
  windowMs: 24 * 60 * 60 * 1000,
  cooldownMs: 4 * 60 * 60 * 1000,
  minSamplesForTrip: 4,
  enforce: true
};

let config: CircuitBreakerConfig = { ...DEFAULTS };
const balanceHistory: BalanceSample[] = [];
let state: CircuitState = {
  tripped: false,
  reason: null,
  trippedAt: null,
  baselineBtc: null,
  currentBtc: null,
  lossPct: null
};

export const configureCircuitBreaker = (params: Partial<CircuitBreakerConfig>): void => {
  config = { ...config, ...params };
};

export const getCircuitBreakerConfig = (): CircuitBreakerConfig => ({ ...config });

/**
 * Record a fresh Deribit equity sample. Called from the hedge-management
 * cycle so balance is observed at the same cadence as TP decisions.
 *
 * Returns the post-record state so callers can act immediately if a
 * trip happened on this sample (e.g., emit an alert, log a warning).
 */
export const recordBalanceSample = (
  equityBtc: number,
  atMs: number = Date.now()
): CircuitState => {
  if (!Number.isFinite(equityBtc) || equityBtc < 0) {
    return state;
  }
  balanceHistory.push({ ms: atMs, equityBtc });

  // Drop samples outside the rolling window.
  const cutoff = atMs - config.windowMs;
  while (balanceHistory.length && balanceHistory[0].ms < cutoff) {
    balanceHistory.shift();
  }

  // Auto-reset after cooldown.
  if (state.tripped && config.cooldownMs > 0) {
    const cooldownExpired = new Date(state.cooldownExpiresAt).getTime() <= atMs;
    if (cooldownExpired) {
      console.log(
        `[CircuitBreaker] Cooldown expired (was tripped at ${state.trippedAt}, reason=${state.reason}); auto-resetting.`
      );
      state = {
        tripped: false,
        reason: null,
        trippedAt: null,
        baselineBtc: null,
        currentBtc: null,
        lossPct: null
      };
    }
  }

  // Only check trip condition if we have enough samples.
  if (balanceHistory.length < config.minSamplesForTrip) {
    return state;
  }

  // Baseline = highest equity observed in the window. This is more
  // conservative than "equity 24h ago" because it captures peak-to-trough
  // drawdown rather than point-to-point.
  const baseline = balanceHistory.reduce((max, s) => (s.equityBtc > max ? s.equityBtc : max), 0);
  if (baseline <= 0) return state;
  const lossPct = (baseline - equityBtc) / baseline;

  if (!state.tripped && lossPct >= config.maxLossPct) {
    const trippedAtIso = new Date(atMs).toISOString();
    const cooldownExpiresIso = new Date(atMs + config.cooldownMs).toISOString();
    state = {
      tripped: true,
      reason: `equity_drawdown_exceeded:${(lossPct * 100).toFixed(1)}%`,
      trippedAt: trippedAtIso,
      baselineBtc: baseline,
      currentBtc: equityBtc,
      lossPct,
      cooldownExpiresAt: cooldownExpiresIso
    };
    console.warn(
      `[CircuitBreaker] *** TRIPPED *** equity ${equityBtc.toFixed(6)} BTC vs baseline ${baseline.toFixed(6)} BTC ` +
      `(loss ${(lossPct * 100).toFixed(1)}% >= max ${(config.maxLossPct * 100).toFixed(1)}%). ` +
      `New protection sales blocked until cooldown expires at ${cooldownExpiresIso} or admin reset.`
    );
  }
  return state;
};

/**
 * Returns true if new protection sales should be blocked. Used by the
 * activate path. When config.enforce is false, always returns false
 * (observe-only mode for staging).
 */
export const isCircuitBreakerActive = (): boolean => {
  if (!config.enforce) return false;
  return state.tripped;
};

export const getCircuitBreakerState = (): CircuitState => ({ ...state });

/**
 * Manual reset by admin. Returns true if there was a tripped state to
 * clear; false if the breaker was already reset.
 */
export const resetCircuitBreaker = (actor: string): boolean => {
  if (!state.tripped) return false;
  console.log(
    `[CircuitBreaker] Manual reset by ${actor} (was tripped at ${state.trippedAt}, reason=${state.reason})`
  );
  state = {
    tripped: false,
    reason: null,
    trippedAt: null,
    baselineBtc: null,
    currentBtc: null,
    lossPct: null
  };
  // Also clear the history so the next sample establishes a fresh baseline
  // — without this the breaker would immediately re-trip against the same
  // pre-reset peak.
  balanceHistory.length = 0;
  return true;
};

/**
 * Test helpers.
 */
export const __resetCircuitBreakerForTests = (): void => {
  config = { ...DEFAULTS };
  balanceHistory.length = 0;
  state = {
    tripped: false,
    reason: null,
    trippedAt: null,
    baselineBtc: null,
    currentBtc: null,
    lossPct: null
  };
};

export const __getBalanceHistoryLengthForTests = (): number => balanceHistory.length;
