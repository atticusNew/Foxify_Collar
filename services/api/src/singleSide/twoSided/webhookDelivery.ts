/**
 * Foxify webhook delivery (PR A7).
 *
 * On pair settled, executionRuntime calls deliverPairClosed() which:
 *   1. Reads webhook config from DB
 *   2. If unset → silently skip + log (allow operation without webhook configured)
 *   3. Signs payload with HMAC-SHA256 using shared secret
 *   4. POSTs to webhook URL with X-Atticus-Signature header
 *   5. On non-2xx or timeout: enqueues retry per exponential backoff schedule
 *      (1s, 5s, 30s, 5m, 30m, 2h, 12h — 7 attempts total)
 *   6. Logs every attempt to two_sided_webhook_attempt table
 *
 * Idempotent on (pair_id, attempt_seq): the receiver must treat duplicate
 * deliveries as no-ops.
 *
 * For Phase 0 the retry scheduler is in-process (setTimeout per attempt).
 * Phase 1+ could move to a proper job queue if reliability demands.
 */

import { createHmac, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getWebhookConfig } from "./webhookConfig";

const RETRY_DELAYS_MS = [
  0,         // attempt 1 immediate
  1_000,     // attempt 2 → +1s
  5_000,     // attempt 3 → +5s
  30_000,    // attempt 4 → +30s
  5 * 60_000,// attempt 5 → +5m
  30 * 60_000,// attempt 6 → +30m
  2 * 3_600_000,// attempt 7 → +2h
  12 * 3_600_000// attempt 8 → +12h
];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;
const DEFAULT_TIMEOUT_MS = 10_000;

export type PairClosedPayload = {
  pair_id: string;
  foxify_pair_ref: string;
  closed_at: string;
  closed_reason: "trigger" | "foxify_close" | "expiry" | "atticus_halt";
  trigger_side: "down" | "up" | null;
  salvage_proceeds_usdc: number;
  uplift_usdc: number;
  foxify_share_usdc: number;
  atticus_share_usdc: number;
  exit_mode: string | null;
  tier_at_settlement: string;
};

export const ensureWebhookAttemptSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_webhook_attempt (
      attempt_id TEXT PRIMARY KEY,
      pair_id TEXT NOT NULL,
      attempt_seq INTEGER NOT NULL,
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      webhook_url TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      response_status INTEGER,
      response_body_preview TEXT,
      error_message TEXT,
      success BOOLEAN NOT NULL DEFAULT FALSE,
      next_retry_at TIMESTAMPTZ
    );
  `);
  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS two_sided_webhook_attempt_pair_idx ON two_sided_webhook_attempt(pair_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS two_sided_webhook_attempt_pending_idx ON two_sided_webhook_attempt(next_retry_at) WHERE success = FALSE AND next_retry_at IS NOT NULL;`);
  } catch {/* pg-mem may not support partial indexes */}
};

const signPayload = (body: string, secret: string): string => {
  return createHmac("sha256", secret).update(body).digest("hex");
};

const hashPayload = (body: string): string => {
  return createHmac("sha256", "_idempotency_").update(body).digest("hex").slice(0, 16);
};

export type DeliveryOpts = {
  /** Inject for tests. */
  fetchOverride?: (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
  /** Inject for tests to control timing. */
  scheduleRetry?: (delayMs: number, cb: () => void) => void;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  timeoutMs?: number;
};

const safeLog = (opts: DeliveryOpts, msg: string, meta?: Record<string, unknown>) => {
  const fn = opts.log ?? ((m, _meta) => console.log(`[webhookDelivery] ${m}`, _meta ?? ""));
  fn(msg, meta);
};

export type DeliveryResult = {
  attemptsMade: number;
  finalSuccess: boolean;
  scheduledRetryFor: string | null;
};

/**
 * Top-level entry point. Tries attempt 1 immediately; on failure schedules
 * remaining retries via setTimeout.
 *
 * Returns after attempt 1's result (success or scheduled). The full retry
 * chain runs in the background. For tests, use scheduleRetry to control timing.
 */
export const deliverPairClosed = async (
  pool: Pool,
  payload: PairClosedPayload,
  opts: DeliveryOpts = {}
): Promise<DeliveryResult> => {
  const cfg = await getWebhookConfig(pool);
  if (!cfg.webhookUrl || !cfg.hmacSecret) {
    safeLog(opts, `webhook not configured; skipping delivery for pair=${payload.pair_id}`);
    return { attemptsMade: 0, finalSuccess: false, scheduledRetryFor: null };
  }
  return attemptDelivery(pool, payload, cfg.webhookUrl, cfg.hmacSecret, 1, opts);
};

const attemptDelivery = async (
  pool: Pool,
  payload: PairClosedPayload,
  webhookUrl: string,
  hmacSecret: string,
  attemptSeq: number,
  opts: DeliveryOpts
): Promise<DeliveryResult> => {
  const body = JSON.stringify(payload);
  const signature = signPayload(body, hmacSecret);
  const payloadHashShort = hashPayload(body);
  const attemptId = randomUUID();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let success = false;
  let status: number | null = null;
  let bodyPreview = "";
  let errorMessage: string | null = null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetcher = opts.fetchOverride ?? (((url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
      fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal })) as DeliveryOpts["fetchOverride"]);
    const res = await fetcher!(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Atticus-Signature": signature,
        "X-Atticus-Pair-Id": payload.pair_id,
        "X-Atticus-Attempt-Seq": String(attemptSeq)
      },
      body,
      signal: controller.signal
    });
    status = res.status;
    bodyPreview = (await res.text()).slice(0, 500);
    success = res.ok;
  } catch (e) {
    errorMessage = (e as Error).message;
  } finally {
    clearTimeout(timer);
  }

  const willRetry = !success && attemptSeq < MAX_ATTEMPTS;
  const nextDelay = willRetry ? RETRY_DELAYS_MS[attemptSeq] : null;
  const nextRetryAt = nextDelay != null ? new Date(Date.now() + nextDelay).toISOString() : null;

  await pool.query(
    `INSERT INTO two_sided_webhook_attempt (attempt_id, pair_id, attempt_seq, webhook_url, payload_hash, response_status, response_body_preview, error_message, success, next_retry_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [attemptId, payload.pair_id, attemptSeq, webhookUrl, payloadHashShort, status, bodyPreview || null, errorMessage, success, nextRetryAt]
  );
  safeLog(opts, `pair=${payload.pair_id} attempt=${attemptSeq} status=${status} success=${success}${willRetry ? ` retry_in=${nextDelay}ms` : ""}`);

  if (willRetry) {
    const schedule = opts.scheduleRetry ?? ((delayMs, cb) => {
      const t = setTimeout(cb, delayMs);
      if (t && typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
    });
    schedule(nextDelay!, () => {
      void attemptDelivery(pool, payload, webhookUrl, hmacSecret, attemptSeq + 1, opts).catch((e) =>
        safeLog(opts, `attempt ${attemptSeq + 1} chain failure: ${(e as Error).message}`)
      );
    });
  }

  return {
    attemptsMade: attemptSeq,
    finalSuccess: success,
    scheduledRetryFor: nextRetryAt
  };
};

/**
 * Helper for receivers: verify our signature.
 * Foxify's webhook handler should call this with the request body + our shared secret.
 */
export const verifyAtticusSignature = (
  receivedBody: string,
  receivedSignature: string,
  sharedSecret: string
): boolean => {
  const expected = signPayload(receivedBody, sharedSecret);
  if (expected.length !== receivedSignature.length) return false;
  // constant-time compare
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ receivedSignature.charCodeAt(i);
  }
  return diff === 0;
};
