/**
 * DB helpers for two-sided cooperative facility (PR B4).
 *
 * Provides:
 *   - withTransaction(pool, fn): atomic multi-query helper. Auto-BEGIN/COMMIT/ROLLBACK.
 *     Use for activate's insert sequence (pair + 2 legs + status + event) and
 *     for settle's update sequence (status + event + pool accrual).
 *
 *   - withClient(pool, fn): single-connection helper for batched reads.
 *     Avoids the pool churn of multiple ad-hoc pool.query() calls.
 *
 *   - logSlowQuery(thresholdMs): wrap a query call; logs if > threshold.
 *     Useful for catching DB contention at scale.
 *
 * Connection pool sizing: pg's default Pool max=10. For two-sided at 100+ pairs/day
 * with N concurrent activations + N concurrent runtime ticks, we typically need 20-30.
 * Operator should set pool.max in server.ts wiring; this module just gives the
 * transactional + connection-borrow primitives.
 */

import type { Pool, PoolClient } from "pg";

/**
 * Run `fn` inside a Postgres transaction. Auto-rollback on throw, auto-commit on
 * resolve. Returns whatever fn returns.
 *
 * IMPORTANT: pass the `client` to db functions inside fn (not the pool), so all
 * queries land in the same transactional connection.
 */
export const withTransaction = async <T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ROLLBACK can fail if connection died; swallow secondary error */
    }
    throw e;
  } finally {
    client.release();
  }
};

/**
 * Borrow a single connection for batched reads. Caller MUST release.
 * Convenience wrapper that catches release errors.
 */
export const withClient = async <T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    try {
      client.release();
    } catch {
      /* release errors are best-effort */
    }
  }
};

/**
 * Wrap a query call to log + metric slow queries.
 * Use for hot-path queries we want to monitor.
 */
export const timeQuery = async <T>(
  label: string,
  fn: () => Promise<T>,
  thresholdMs = 100
): Promise<T> => {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    const elapsed = Date.now() - t0;
    if (elapsed > thresholdMs) {
      try {
        const { getMetrics } = await import("./metrics");
        getMetrics().observeHistogram("two_sided_query_latency_ms", elapsed, { query: label });
      } catch { /* swallow */ }
      // Log via console (structured log here would add too much overhead in hot path)
      // eslint-disable-next-line no-console
      console.log(`[db.slow] ${label} took ${elapsed}ms (threshold ${thresholdMs}ms)`);
    }
  }
};
