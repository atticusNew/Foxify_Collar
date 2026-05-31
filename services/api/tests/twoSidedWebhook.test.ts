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
  deliverPairActivated,
  verifyAtticusSignature,
  type PairClosedPayload,
  type PairActivatedPayload
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

// ──────────────────────────── activation-time signal ────────────────────────────

const sampleActivated = (): PairActivatedPayload => ({
  pair_id: "p-act-1",
  foxify_pair_ref: "fxy-act-1",
  cell_id: "pair_50k_2pct",
  activated_at: "2026-05-31T03:00:00Z",
  spot_at_activation: 73950,
  put_strike: 74000,
  call_strike: 74000,
  contracts_btc: 1.4,
  total_hedge_cost_usdc: 1149.43,
  trigger_down_price: 72471,
  trigger_up_price: 75429,
  tier_at_activation: "tier_1",
  hedge_tenor_days: 3,
  expires_at: "2026-06-03T03:00:00Z",
  is_shadow: true
});

test("activation: deliverPairActivated sends event=pair_activated + valid signature", async () => {
  const pool = await buildPool();
  await setWebhookConfig(pool, "https://foxify.example.com/webhook", "secret-1234567890ab");
  let captured: { body: string; event: string; pairId: string; sig: string } | null = null;
  const r = await deliverPairActivated(pool, sampleActivated(), {
    fetchOverride: async (url, init) => {
      captured = { body: init.body, event: init.headers["X-Atticus-Event"], pairId: init.headers["X-Atticus-Pair-Id"], sig: init.headers["X-Atticus-Signature"] };
      return { ok: true, status: 200, text: async () => "OK" };
    },
    log: () => {}
  });
  assert.equal(r.finalSuccess, true);
  assert.ok(captured, "fetch was called");
  const cap = captured as NonNullable<typeof captured>;
  assert.equal(cap.event, "pair_activated", "X-Atticus-Event header");
  assert.equal(cap.pairId, "p-act-1");
  const parsed = JSON.parse(cap.body);
  assert.equal(parsed.event, "pair_activated", "event in body");
  assert.equal(parsed.cell_id, "pair_50k_2pct");
  assert.equal(parsed.total_hedge_cost_usdc, 1149.43);
  // signature verifies over the EXACT body (incl. event)
  assert.ok(verifyAtticusSignature(cap.body, cap.sig, "secret-1234567890ab"), "HMAC verifies");
  // recorded with event column
  const rows = await pool.query("SELECT * FROM two_sided_webhook_attempt WHERE pair_id = $1", ["p-act-1"]);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].event, "pair_activated");
});

test("activation: unconfigured webhook → silent skip", async () => {
  const pool = await buildPool();
  const r = await deliverPairActivated(pool, sampleActivated(), { log: () => {} });
  assert.equal(r.attemptsMade, 0);
  assert.equal(r.finalSuccess, false);
});

test("close webhook still tags event=pair_closed (backward compat)", async () => {
  const pool = await buildPool();
  await setWebhookConfig(pool, "https://foxify.example.com/webhook", "secret-1234567890ab");
  let event = "";
  await deliverPairClosed(pool, samplePayload(), {
    fetchOverride: async (_url, init) => { event = init.headers["X-Atticus-Event"]; return { ok: true, status: 200, text: async () => "OK" }; },
    log: () => {}
  });
  assert.equal(event, "pair_closed");
});
