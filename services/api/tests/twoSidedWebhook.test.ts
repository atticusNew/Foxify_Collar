/**
 * PR A7 tests — webhook config + delivery + signature.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import {
  ensureWebhookConfigSchema,
  getWebhookConfig,
  setWebhookConfig,
  clearWebhookConfig
} from "../src/singleSide/twoSided/webhookConfig";
import {
  ensureWebhookAttemptSchema,
  deliverPairClosed,
  verifyAtticusSignature,
  type PairClosedPayload
} from "../src/singleSide/twoSided/webhookDelivery";
import { createHmac } from "node:crypto";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureWebhookConfigSchema(pool);
  await ensureWebhookAttemptSchema(pool);
  return pool;
};

const samplePayload = (): PairClosedPayload => ({
  pair_id: "p-1",
  foxify_pair_ref: "fxy-1",
  closed_at: "2026-05-28T03:00:00Z",
  closed_reason: "trigger",
  trigger_side: "down",
  salvage_proceeds_usdc: 3_800,
  uplift_usdc: 600,
  foxify_share_usdc: 3_710,
  atticus_share_usdc: 90,
  exit_mode: "capture_window_peak",
  tier_at_settlement: "tier_1"
});

test("config: setWebhookConfig persists + getWebhookConfig reads", async () => {
  const pool = await buildPool();
  const c0 = await getWebhookConfig(pool);
  assert.equal(c0.webhookUrl, null);
  await setWebhookConfig(pool, "https://foxify.example.com/webhook", "secret-1234567890ab");
  const c1 = await getWebhookConfig(pool);
  assert.equal(c1.webhookUrl, "https://foxify.example.com/webhook");
  assert.equal(c1.hmacSecret, "secret-1234567890ab");
  await clearWebhookConfig(pool);
  const c2 = await getWebhookConfig(pool);
  assert.equal(c2.webhookUrl, null);
});

test("config: rejects short hmac secret", async () => {
  const pool = await buildPool();
  await assert.rejects(() => setWebhookConfig(pool, "https://x", "short"), /at least 16/);
});

test("delivery: webhook unconfigured → silent skip (no attempt)", async () => {
  const pool = await buildPool();
  const r = await deliverPairClosed(pool, samplePayload(), { log: () => {} });
  assert.equal(r.attemptsMade, 0);
  assert.equal(r.finalSuccess, false);
});

test("delivery: happy 2xx → attempt 1 success + recorded", async () => {
  const pool = await buildPool();
  await setWebhookConfig(pool, "https://foxify.example.com/webhook", "secret-1234567890ab");
  const calls: Array<{ url: string; signature: string }> = [];
  const r = await deliverPairClosed(pool, samplePayload(), {
    fetchOverride: async (url, init) => {
      calls.push({ url, signature: init.headers["X-Atticus-Signature"] });
      return { ok: true, status: 200, text: async () => "OK" };
    },
    log: () => {}
  });
  assert.equal(r.attemptsMade, 1);
  assert.equal(r.finalSuccess, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://foxify.example.com/webhook");
  assert.ok(calls[0].signature.length === 64, "HMAC-SHA256 hex is 64 chars");
  // Verify recorded
  const attempts = await pool.query("SELECT * FROM two_sided_webhook_attempt WHERE pair_id = $1", ["p-1"]);
  assert.equal(attempts.rows.length, 1);
  assert.equal(attempts.rows[0].success, true);
});

test("delivery: non-2xx → retry scheduled", async () => {
  const pool = await buildPool();
  await setWebhookConfig(pool, "https://foxify.example.com/webhook", "secret-1234567890ab");
  const scheduled: number[] = [];
  const r = await deliverPairClosed(pool, samplePayload(), {
    fetchOverride: async () => ({ ok: false, status: 500, text: async () => "internal error" }),
    scheduleRetry: (delayMs, _cb) => { scheduled.push(delayMs); /* don't invoke cb in test */ },
    log: () => {}
  });
  assert.equal(r.attemptsMade, 1);
  assert.equal(r.finalSuccess, false);
  assert.ok(r.scheduledRetryFor != null);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0], 1_000); // attempt 2 delay = 1s
});

test("delivery: retry sequence advances through full backoff", async () => {
  const pool = await buildPool();
  await setWebhookConfig(pool, "https://foxify.example.com/webhook", "secret-1234567890ab");
  const scheduled: number[] = [];
  let attemptCount = 0;
  let lastAttemptResolve: () => void = () => {};
  const allAttemptsDone = new Promise<void>((r) => { lastAttemptResolve = r; });

  await deliverPairClosed(pool, samplePayload(), {
    fetchOverride: async () => {
      attemptCount++;
      if (attemptCount >= 8) lastAttemptResolve();
      return { ok: false, status: 500, text: async () => "err" };
    },
    scheduleRetry: (delayMs, cb) => {
      scheduled.push(delayMs);
      // Invoke immediately (no real delay in test) — chain continues asynchronously
      void cb();
    },
    log: () => {}
  });
  // Wait for the recursive chain to complete (up to 1s safety)
  await Promise.race([allAttemptsDone, new Promise<void>((r) => setTimeout(r, 1_000))]);
  // Should have made all MAX_ATTEMPTS (8) before giving up
  assert.equal(attemptCount, 8);
  // Scheduled delays for attempts 2..8 = 7 delays
  assert.equal(scheduled.length, 7);
  assert.deepEqual(scheduled, [1_000, 5_000, 30_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000]);
});

test("delivery: fetch throws → recorded as error", async () => {
  const pool = await buildPool();
  await setWebhookConfig(pool, "https://foxify.example.com/webhook", "secret-1234567890ab");
  const r = await deliverPairClosed(pool, samplePayload(), {
    fetchOverride: async () => { throw new Error("ECONNRESET"); },
    scheduleRetry: () => {}, // don't retry in this test
    log: () => {}
  });
  assert.equal(r.finalSuccess, false);
  const attempts = await pool.query("SELECT error_message FROM two_sided_webhook_attempt WHERE pair_id = $1", ["p-1"]);
  assert.match(attempts.rows[0].error_message, /ECONNRESET/);
});

test("verifyAtticusSignature: round-trip with correct secret returns true", () => {
  const body = JSON.stringify({ test: "payload", num: 42 });
  const secret = "test-secret-abcdef123456";
  // Simulate: we sign the body, then verify
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyAtticusSignature(body, sig, secret), true);
});

test("verifyAtticusSignature: wrong secret returns false", () => {
  const body = JSON.stringify({ test: "payload" });
  const sig = createHmac("sha256", "right-secret-1234").update(body).digest("hex");
  assert.equal(verifyAtticusSignature(body, sig, "wrong-secret-5678"), false);
});

test("verifyAtticusSignature: tampered body returns false", () => {
  const body = JSON.stringify({ test: "payload" });
  const sig = createHmac("sha256", "secret-key-1234").update(body).digest("hex");
  assert.equal(verifyAtticusSignature(body + "tampered", sig, "secret-key-1234"), false);
});
