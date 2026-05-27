/**
 * Pre-deploy schema check (PR A9).
 *
 * Runs the full ensureXxxSchema sequence against a fresh pg-mem instance to
 * catch SQL parse errors before they hit production Postgres.
 *
 * Usage:
 *   cd services/api
 *   npx tsx scripts/preDeployCheck.ts
 *
 * Exits 0 on success, non-zero on first schema failure. Render's deploy hook
 * should invoke this before `node dist/server.js` so a broken migration fails
 * fast at deploy time, not at first DB query in production.
 */

import { newDb } from "pg-mem";
import { ensureTwoSidedSchema } from "../src/singleSide/twoSided/db";
import { ensureGuardrailsSchema } from "../src/singleSide/twoSided/guardrails";
import { ensureDeferredPoolSchema } from "../src/singleSide/twoSided/deferredPool";
import { ensureNewbornReviewSchema } from "../src/singleSide/twoSided/featureFlag";
import { ensureWebhookConfigSchema } from "../src/singleSide/twoSided/webhookConfig";
import { ensureWebhookAttemptSchema } from "../src/singleSide/twoSided/webhookDelivery";

const SCHEMAS: ReadonlyArray<{ name: string; fn: (pool: { query: (q: string, args?: unknown[]) => Promise<unknown> }) => Promise<void> }> = [
  { name: "two_sided_pair + pair_leg + pair_event", fn: ensureTwoSidedSchema as unknown as typeof SCHEMAS[number]["fn"] },
  { name: "two_sided_halt_state + halt_event", fn: ensureGuardrailsSchema as unknown as typeof SCHEMAS[number]["fn"] },
  { name: "two_sided_deferred_pool_state + ledger", fn: ensureDeferredPoolSchema as unknown as typeof SCHEMAS[number]["fn"] },
  { name: "two_sided_newborn_review", fn: ensureNewbornReviewSchema as unknown as typeof SCHEMAS[number]["fn"] },
  { name: "two_sided_webhook_config", fn: ensureWebhookConfigSchema as unknown as typeof SCHEMAS[number]["fn"] },
  { name: "two_sided_webhook_attempt", fn: ensureWebhookAttemptSchema as unknown as typeof SCHEMAS[number]["fn"] }
];

const main = async () => {
  console.log("# Pre-deploy schema check\n");
  console.log(`Validating ${SCHEMAS.length} schema migrations against pg-mem ...\n`);

  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();

  let failedAt: { name: string; error: Error } | null = null;
  for (const s of SCHEMAS) {
    try {
      const t0 = Date.now();
      // First run
      await s.fn(pool);
      // Second run — must be idempotent (CREATE IF NOT EXISTS)
      await s.fn(pool);
      const elapsed = Date.now() - t0;
      console.log(`  ✓ ${s.name.padEnd(50)} (${elapsed}ms, idempotent verified)`);
    } catch (e) {
      failedAt = { name: s.name, error: e as Error };
      console.error(`  ✗ ${s.name}: ${(e as Error).message}`);
      break;
    }
  }

  if (failedAt) {
    console.error(`\n❌ FAIL — schema check failed at: ${failedAt.name}`);
    console.error(failedAt.error.stack);
    process.exit(1);
  }

  // Sanity: check key tables exist
  const tablesToCheck = [
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
  console.log(`\nSanity-check ${tablesToCheck.length} expected tables ...`);
  for (const t of tablesToCheck) {
    try {
      await pool.query(`SELECT 1 FROM ${t} LIMIT 1`);
      console.log(`  ✓ ${t}`);
    } catch (e) {
      console.error(`  ✗ ${t}: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  console.log(`\n✅ Pre-deploy schema check PASSED. All ${SCHEMAS.length} migrations + ${tablesToCheck.length} tables verified.\n`);
};

main().catch((e) => {
  console.error("Pre-deploy check threw:", e);
  process.exit(1);
});
