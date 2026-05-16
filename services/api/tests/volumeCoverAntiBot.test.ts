import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  ensureVolumeCoverSchema,
  seedVolumeCoverCellsIfNeeded
} from "../src/volumeCover/volumeCoverDb";
import {
  ensureCapitalPoolSchema,
  seedCapitalPoolsIfNeeded
} from "../src/pilot/capitalPoolSchema";
import {
  checkAntiBot,
  recordActivation,
  recordTriggerForFingerprint
} from "../src/volumeCover/antiBot";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensureCapitalPoolSchema(pool);
  await seedCapitalPoolsIfNeeded(pool);
  await ensureVolumeCoverSchema(pool);
  await seedVolumeCoverCellsIfNeeded(pool);
  return pool;
};

test("anti-bot: first-ever activation by fingerprint is allowed", async () => {
  const pool = await buildPool();
  const decision = await checkAntiBot({
    pool,
    fingerprintHash: "fp-new",
    cellId: "50k_2pct_1k"
  });
  assert.equal(decision.allowed, true);
});

test("Layer 1: same cell within 60min by same fingerprint blocked", async () => {
  const pool = await buildPool();
  const fp = "fp-l1";
  await recordActivation({
    pool,
    fingerprintHash: fp,
    cellId: "50k_2pct_1k",
    jitterFnForTest: () => 0
  });

  // Try to reopen same cell immediately
  const decision = await checkAntiBot({
    pool,
    fingerprintHash: fp,
    cellId: "50k_2pct_1k"
  });
  assert.equal(decision.allowed, false);
  if (decision.allowed) return; // type narrow
  assert.equal(decision.reason, "layer1_repeat_cell_window");
  assert.ok(typeof decision.retryAfterMs === "number" && decision.retryAfterMs > 0);
});

test("Layer 1: different cell by same fingerprint NOT blocked by Layer 1 (Layer 2 may still block)", async () => {
  const pool = await buildPool();
  const fp = "fp-cross";
  // Record activation for cell A with NO Layer 2 cooldown for this test
  // (use a 0ms base+jitter via env override would require a pool reset;
  // instead we backdate next_allowed_activate_at past the cooldown)
  await recordActivation({
    pool,
    fingerprintHash: fp,
    cellId: "50k_2pct_1k",
    jitterFnForTest: () => 0
  });
  // Backdate so Layer 2 cooldown has expired
  await pool.query(
    `UPDATE volume_cover_fingerprint_state
     SET next_allowed_activate_at = NOW() - interval '1 minute'
     WHERE fingerprint_hash = $1`,
    [fp]
  );

  const decision = await checkAntiBot({
    pool,
    fingerprintHash: fp,
    cellId: "50k_5pct_2_5k" // different cell
  });
  assert.equal(decision.allowed, true);
});

test("Layer 2: cooldown blocks rapid repeat activation within base+jitter window", async () => {
  const pool = await buildPool();
  const fp = "fp-l2";
  // Record activation with jitter=120s
  await recordActivation({
    pool,
    fingerprintHash: fp,
    cellId: "50k_5pct_2_5k",
    jitterFnForTest: () => 120_000
  });
  // Try a different cell immediately (Layer 1 doesn't apply)
  const decision = await checkAntiBot({
    pool,
    fingerprintHash: fp,
    cellId: "50k_10pct_5k"
  });
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.equal(decision.reason, "layer2_cooldown_active");
});

test("Layer 1 disabled via env lets repeat through (subject to Layer 2)", async () => {
  const pool = await buildPool();
  const fp = "fp-l1-off";
  await recordActivation({
    pool,
    fingerprintHash: fp,
    cellId: "50k_2pct_1k",
    jitterFnForTest: () => 0
  });
  // Backdate cooldown so Layer 2 doesn't fire
  await pool.query(
    `UPDATE volume_cover_fingerprint_state
     SET next_allowed_activate_at = NOW() - interval '1 minute'
     WHERE fingerprint_hash = $1`,
    [fp]
  );

  const original = process.env.VOLUME_COVER_ANTIBOT_LAYER1_ENABLED;
  process.env.VOLUME_COVER_ANTIBOT_LAYER1_ENABLED = "false";
  try {
    const decision = await checkAntiBot({
      pool,
      fingerprintHash: fp,
      cellId: "50k_2pct_1k"
    });
    assert.equal(decision.allowed, true);
  } finally {
    if (original === undefined) delete process.env.VOLUME_COVER_ANTIBOT_LAYER1_ENABLED;
    else process.env.VOLUME_COVER_ANTIBOT_LAYER1_ENABLED = original;
  }
});

test("bypass=true skips both layers", async () => {
  const pool = await buildPool();
  const fp = "fp-bypass";
  await recordActivation({
    pool,
    fingerprintHash: fp,
    cellId: "50k_2pct_1k",
    jitterFnForTest: () => 120_000
  });
  const decision = await checkAntiBot({
    pool,
    fingerprintHash: fp,
    cellId: "50k_2pct_1k",
    bypass: true
  });
  assert.equal(decision.allowed, true);
});

test("recordTriggerForFingerprint upserts last_trigger_at", async () => {
  const pool = await buildPool();
  const fp = "fp-trig";
  await recordTriggerForFingerprint({ pool, fingerprintHash: fp });
  const r = await pool.query(
    `SELECT last_trigger_at FROM volume_cover_fingerprint_state WHERE fingerprint_hash = $1`,
    [fp]
  );
  assert.equal(r.rows.length, 1);
  assert.ok(r.rows[0].last_trigger_at !== null);
});

test("Layer 1 window expired: same cell allowed after 61min", async () => {
  const pool = await buildPool();
  const fp = "fp-window-expired";
  await recordActivation({
    pool,
    fingerprintHash: fp,
    cellId: "50k_2pct_1k",
    jitterFnForTest: () => 0
  });
  // Backdate the activation 61 minutes
  await pool.query(
    `UPDATE volume_cover_fingerprint_state
     SET last_activate_at = NOW() - interval '61 minutes',
         next_allowed_activate_at = NOW() - interval '60 minutes'
     WHERE fingerprint_hash = $1`,
    [fp]
  );
  const decision = await checkAntiBot({
    pool,
    fingerprintHash: fp,
    cellId: "50k_2pct_1k"
  });
  assert.equal(decision.allowed, true);
});
