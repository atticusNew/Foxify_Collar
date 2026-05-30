/**
 * Tests for testFireWebhook — the dry-run webhook delivery used by the
 * /admin/foxify/v2/webhook-config/test endpoint.
 *
 * Uses a local Fastify receiver that:
 *   - Captures the request body, headers, and signature
 *   - Verifies the HMAC signature using the shared secret
 *   - Returns 200 OK on success, 401 on signature mismatch
 *
 * This proves the production webhook delivery code:
 *   1. Posts to the configured URL
 *   2. Signs with HMAC-SHA256 correctly
 *   3. Sets the required headers (X-Atticus-Signature, etc.)
 *   4. Receives the response body + status code
 *   5. Handles timeouts and errors
 */

import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { testFireWebhook, verifyAtticusSignature } from "../src/singleSide/twoSided/webhookDelivery";

const SECRET = "test-secret-32-chars-1234567890ab";

const startReceiver = async (
  handler: (body: string, signature: string, headers: Record<string, string | string[] | undefined>) =>
    Promise<{ status: number; body: unknown }>
): Promise<{ url: string; close: () => Promise<void> }> => {
  const app: FastifyInstance = Fastify({ logger: false });
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.post("/webhook", async (req, reply) => {
    const sig = String(req.headers["x-atticus-signature"] ?? "");
    const result = await handler(req.body as string, sig, req.headers);
    reply.code(result.status).send(result.body);
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("could not bind receiver");
  const url = `http://127.0.0.1:${addr.port}/webhook`;
  return {
    url,
    close: async () => { await app.close(); }
  };
};

test("testFireWebhook: receiver gets POST with valid HMAC signature", async () => {
  let captured: { body: string; signature: string; verified: boolean } | null = null;
  const receiver = await startReceiver(async (body, signature) => {
    const verified = verifyAtticusSignature(body, signature, SECRET);
    captured = { body, signature, verified };
    return { status: 200, body: { ack: true } };
  });
  try {
    const result = await testFireWebhook(receiver.url, SECRET);
    assert.equal(result.sent, true);
    assert.equal(result.http_status, 200);
    assert.match(result.http_body_preview, /"ack":true/);
    assert.ok(result.signature_sent.length === 64, "signature should be 64-char hex");
    assert.ok(captured, "receiver should have been hit");
    assert.equal(captured!.verified, true, "HMAC signature must validate on receiver side");
  } finally {
    await receiver.close();
  }
});

test("testFireWebhook: receiver rejects wrong signature", async () => {
  const receiver = await startReceiver(async (body, signature) => {
    const verified = verifyAtticusSignature(body, signature, "WRONG-SECRET");
    return verified ? { status: 200, body: { ack: true } } : { status: 401, body: { error: "bad_sig" } };
  });
  try {
    const result = await testFireWebhook(receiver.url, SECRET);
    assert.equal(result.sent, true);
    assert.equal(result.http_status, 401);
    assert.match(result.http_body_preview, /bad_sig/);
  } finally {
    await receiver.close();
  }
});

test("testFireWebhook: payload shape matches PairClosedPayload contract", async () => {
  let receivedPayload: Record<string, unknown> | null = null;
  const receiver = await startReceiver(async (body) => {
    receivedPayload = JSON.parse(body);
    return { status: 200, body: { ack: true } };
  });
  try {
    await testFireWebhook(receiver.url, SECRET);
    assert.ok(receivedPayload);
    const p = receivedPayload!;
    // All required fields per the PairClosedPayload type contract
    for (const key of [
      "pair_id", "foxify_pair_ref", "closed_at", "closed_reason",
      "salvage_proceeds_usdc", "uplift_usdc",
      "foxify_share_usdc", "atticus_share_usdc",
      "tier_at_settlement"
    ]) {
      assert.ok(key in p, `payload missing required field: ${key}`);
    }
    assert.ok(String(p.pair_id).startsWith("test-"), "test fire should use test- prefix on pair_id");
    assert.equal(p.exit_mode, "test_fire", "exit_mode should mark this as a test");
  } finally {
    await receiver.close();
  }
});

test("testFireWebhook: latency_ms is populated", async () => {
  const receiver = await startReceiver(async () => ({ status: 200, body: { ok: true } }));
  try {
    const result = await testFireWebhook(receiver.url, SECRET);
    assert.ok(result.latency_ms >= 0);
    assert.ok(result.latency_ms < 10_000);
  } finally {
    await receiver.close();
  }
});

test("testFireWebhook: returns error on unreachable URL", async () => {
  // Port 1 is reserved and typically rejected by OS
  const result = await testFireWebhook("http://127.0.0.1:1/webhook", SECRET, undefined, 2_000);
  assert.equal(result.sent, false);
  assert.equal(result.http_status, null);
  assert.ok(result.error, "should populate error on failure");
});

test("testFireWebhook: respects override_payload fields", async () => {
  let received: Record<string, unknown> | null = null;
  const receiver = await startReceiver(async (body) => {
    received = JSON.parse(body);
    return { status: 200, body: { ok: true } };
  });
  try {
    await testFireWebhook(receiver.url, SECRET, {
      closed_reason: "trigger",
      trigger_side: "up",
      salvage_proceeds_usdc: 1234.56
    });
    assert.ok(received);
    assert.equal(received!.closed_reason, "trigger");
    assert.equal(received!.trigger_side, "up");
    assert.equal(received!.salvage_proceeds_usdc, 1234.56);
  } finally {
    await receiver.close();
  }
});

test("verifyAtticusSignature: constant-time comparison rejects modified body", () => {
  const body = JSON.stringify({ pair_id: "abc", salvage: 100 });
  const sig = createHmac("sha256", SECRET).update(body).digest("hex");
  assert.equal(verifyAtticusSignature(body, sig, SECRET), true);
  // Modify body — signature should now reject
  const modifiedBody = JSON.stringify({ pair_id: "abc", salvage: 10000 });
  assert.equal(verifyAtticusSignature(modifiedBody, sig, SECRET), false);
});
