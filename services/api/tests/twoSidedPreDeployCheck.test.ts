/**
 * PR A9 tests — preDeployCheck script exits 0 on healthy schemas.
 *
 * The script invokes process.exit, so we don't test it directly. Instead we
 * exercise its core sequence (idempotent migrations + sanity-check) in-process.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { ensureTwoSidedSchema } from "../src/singleSide/twoSided/db";
import { ensureGuardrailsSchema } from "../src/singleSide/twoSided/guardrails";
import { ensureDeferredPoolSchema } from "../src/singleSide/twoSided/deferredPool";
import { ensureNewbornReviewSchema } from "../src/singleSide/twoSided/featureFlag";
import { ensureWebhookConfigSchema } from "../src/singleSide/twoSided/webhookConfig";
import { ensureWebhookAttemptSchema } from "../src/singleSide/twoSided/webhookDelivery";

test("preDeployCheck: full schema sequence runs idempotently", async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();

  const schemas = [
    ensureTwoSidedSchema,
    ensureGuardrailsSchema,
    ensureDeferredPoolSchema,
    ensureNewbornReviewSchema,
    ensureWebhookConfigSchema,
    ensureWebhookAttemptSchema
  ];

  // First pass
  for (const s of schemas) await s(pool);
  // Second pass — must not throw (CREATE IF NOT EXISTS)
  for (const s of schemas) await s(pool);

  // Sanity-check all expected tables exist
  const tables = [
    "two_sided_pair",
    "two_sided_pair_leg",
    "two_sided_pair_event",
    "two_sided_halt_state",
    "two_sided_halt_event",
    "two_sided_deferred_pool_state",
    "two_sided_deferred_pool_ledger",
    "two_sided_newborn_review",
    "two_sided_webhook_config",
    "two_sided_webhook_attempt"
  ];
  for (const t of tables) {
    const r = await pool.query(`SELECT 1 FROM ${t} LIMIT 1`);
    assert.ok(r, `table ${t} should be queryable`);
  }
});

test("preDeployCheck: each schema is independently idempotent", async () => {
  for (const fn of [
    ensureTwoSidedSchema,
    ensureGuardrailsSchema,
    ensureDeferredPoolSchema,
    ensureNewbornReviewSchema,
    ensureWebhookConfigSchema,
    ensureWebhookAttemptSchema
  ]) {
    const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
    const pool = new (db.adapters.createPg().Pool)();
    await fn(pool);
    await fn(pool); // idempotent
    await fn(pool); // triple-check
  }
});
