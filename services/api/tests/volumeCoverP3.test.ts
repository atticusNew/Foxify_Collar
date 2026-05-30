import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  ensureCapitalPoolSchema,
  seedCapitalPoolsIfNeeded
} from "../src/pilot/capitalPoolSchema";
import {
  ensureVolumeCoverSchema,
  seedVolumeCoverCellsIfNeeded
} from "../src/volumeCover/volumeCoverDb";
import {
  checkAntiBot,
  recordActivation,
  recordTriggerForFingerprint,
  recordPatternStrike
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

test("P3 Layer 3: post-trigger cooldown blocks new activation for 4h", async () => {
  const pool = await buildPool();
  const fp = "fp-l3";
  await recordTriggerForFingerprint({ pool, fingerprintHash: fp });

  const decision = await checkAntiBot({
    pool,
    fingerprintHash: fp,
    cellId: "50k_2pct_1k"
  });
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.equal(decision.reason, "layer3_post_trigger_cooldown");
});

test("P3 Layer 3: cooldown elapses after configured window", async () => {
  const pool = await buildPool();
  const fp = "fp-l3-elapsed";
  await recordTriggerForFingerprint({ pool, fingerprintHash: fp });
  // Backdate trigger 5 hours ago (default cooldown 4h)
  await pool.query(
    `UPDATE volume_cover_fingerprint_state
     SET last_trigger_at = NOW() - interval '5 hours'
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

test("P3 Layer 4: pattern strikes accumulate; surcharge applies on threshold", async () => {
  const pool = await buildPool();
  const fp = "fp-l4";

  // Strike 1
  let r = await recordPatternStrike({ pool, fingerprintHash: fp });
  assert.equal(r.strikes, 1);
  assert.equal(r.surchargeUntilIso, null, "below threshold; no surcharge");

  // Strike 2
  r = await recordPatternStrike({ pool, fingerprintHash: fp });
  assert.equal(r.strikes, 2);
  assert.equal(r.surchargeUntilIso, null);

  // Strike 3 — threshold (default 3) reached
  r = await recordPatternStrike({ pool, fingerprintHash: fp });
  assert.equal(r.strikes, 3);
  assert.ok(r.surchargeUntilIso !== null, "surcharge_until set on threshold");

  // Now checkAntiBot returns surcharge multiplier
  const decision = await checkAntiBot({
    pool,
    fingerprintHash: fp,
    cellId: "50k_2pct_1k"
  });
  assert.equal(decision.allowed, true);
  if (!decision.allowed) return;
  assert.equal(decision.surchargeMultiplier, 1.5);
});

test("P3 Layer 4: surcharge expires after duration", async () => {
  const pool = await buildPool();
  const fp = "fp-l4-expired";
  // Hit threshold
  await recordPatternStrike({ pool, fingerprintHash: fp });
  await recordPatternStrike({ pool, fingerprintHash: fp });
  await recordPatternStrike({ pool, fingerprintHash: fp });
  // Backdate surcharge_until to past
  await pool.query(
    `UPDATE volume_cover_fingerprint_state
     SET surcharge_until = NOW() - interval '1 hour'
     WHERE fingerprint_hash = $1`,
    [fp]
  );

  const decision = await checkAntiBot({
    pool,
    fingerprintHash: fp,
    cellId: "50k_2pct_1k"
  });
  assert.equal(decision.allowed, true);
  if (!decision.allowed) return;
  assert.equal(decision.surchargeMultiplier, 1.0);
});

test("P3 Layer 3 disabled via env lets trigger-recent activations through", async () => {
  const pool = await buildPool();
  const fp = "fp-l3-off";
  await recordTriggerForFingerprint({ pool, fingerprintHash: fp });

  const original = process.env.VOLUME_COVER_ANTIBOT_LAYER3_ENABLED;
  process.env.VOLUME_COVER_ANTIBOT_LAYER3_ENABLED = "false";
  try {
    const decision = await checkAntiBot({
      pool,
      fingerprintHash: fp,
      cellId: "50k_2pct_1k"
    });
    assert.equal(decision.allowed, true);
  } finally {
    if (original === undefined) delete process.env.VOLUME_COVER_ANTIBOT_LAYER3_ENABLED;
    else process.env.VOLUME_COVER_ANTIBOT_LAYER3_ENABLED = original;
  }
});

test("P3 Layer 4 disabled via env returns surcharge=1.0 even with surcharge_until set", async () => {
  const pool = await buildPool();
  const fp = "fp-l4-off";
  await recordPatternStrike({ pool, fingerprintHash: fp });
  await recordPatternStrike({ pool, fingerprintHash: fp });
  await recordPatternStrike({ pool, fingerprintHash: fp });

  const original = process.env.VOLUME_COVER_ANTIBOT_LAYER4_ENABLED;
  process.env.VOLUME_COVER_ANTIBOT_LAYER4_ENABLED = "false";
  try {
    const decision = await checkAntiBot({
      pool,
      fingerprintHash: fp,
      cellId: "50k_5pct_2_5k"
    });
    assert.equal(decision.allowed, true);
    if (!decision.allowed) return;
    assert.equal(decision.surchargeMultiplier, 1.0);
  } finally {
    if (original === undefined) delete process.env.VOLUME_COVER_ANTIBOT_LAYER4_ENABLED;
    else process.env.VOLUME_COVER_ANTIBOT_LAYER4_ENABLED = original;
  }
});

test("P3 Layer 3 + Layer 4 chain: trigger → cooldown → expire → surcharge applies", async () => {
  const pool = await buildPool();
  const fp = "fp-chain";
  await recordTriggerForFingerprint({ pool, fingerprintHash: fp });
  // Add 3 pattern strikes (separate from trigger event)
  await recordPatternStrike({ pool, fingerprintHash: fp });
  await recordPatternStrike({ pool, fingerprintHash: fp });
  await recordPatternStrike({ pool, fingerprintHash: fp });

  // Layer 3 should fire first (4h cooldown)
  const blocked = await checkAntiBot({
    pool,
    fingerprintHash: fp,
    cellId: "50k_2pct_1k"
  });
  assert.equal(blocked.allowed, false);
  if (blocked.allowed) return;
  assert.equal(blocked.reason, "layer3_post_trigger_cooldown");

  // Move trigger to past so Layer 3 clears; surcharge_until still active
  await pool.query(
    `UPDATE volume_cover_fingerprint_state
     SET last_trigger_at = NOW() - interval '5 hours',
         next_allowed_activate_at = NOW() - interval '1 hour'
     WHERE fingerprint_hash = $1`,
    [fp]
  );
  const allowed = await checkAntiBot({
    pool,
    fingerprintHash: fp,
    cellId: "50k_2pct_1k"
  });
  assert.equal(allowed.allowed, true);
  if (!allowed.allowed) return;
  assert.equal(allowed.surchargeMultiplier, 1.5);
});
