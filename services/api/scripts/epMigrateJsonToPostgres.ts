#!/usr/bin/env tsx
/**
 * One-shot migration: Phase 1 JSON state → Postgres (DATABASE_URL).
 *
 *   DATABASE_URL=postgres://… npx tsx services/api/scripts/epMigrateJsonToPostgres.ts
 *
 * Reads the same paths the service uses (DEMO_STORE_PATH etc.), refuses to overwrite a non-empty
 * database unless EP_MIGRATE_FORCE=true. After migrating, start the service with DATABASE_URL set
 * and it will read/write Postgres from then on.
 */

import { Pool } from "pg";
import { migrateJsonToPostgres, type EpStorePaths } from "../src/singleSide/twoSided/creditCollar/store/epStores";

const main = async (): Promise<void> => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[ep-migrate] DATABASE_URL missing");
    process.exit(1);
  }
  const paths: EpStorePaths = {
    wraps: process.env.DEMO_STORE_PATH ?? "./logs/demo-wraps.json",
    protection: process.env.DEMO_PROTECTION_STORE_PATH ?? "./logs/demo-protection.json",
    ledger: process.env.DEMO_PAYOUT_LEDGER_PATH ?? "./logs/demo-payout-ledger.json",
    registry: process.env.EP_WALLET_REGISTRY_PATH ?? "./logs/ep-wallets.json",
    runtime: process.env.EP_RUNTIME_PATH ?? "./logs/ep-runtime.json",
    tos: process.env.EP_TOS_STORE_PATH ?? "./logs/ep-tos.json",
    waitlist: process.env.EP_WAITLIST_PATH ?? "./logs/ep-waitlist.json",
    funnel: process.env.EP_FUNNEL_PATH ?? "./logs/ep-funnel.json"
  };
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const summary = await migrateJsonToPostgres(paths, pool, String(process.env.EP_MIGRATE_FORCE ?? "false").toLowerCase() === "true");
    console.error(
      `[ep-migrate] done — ${summary.wraps} wraps, ${summary.prefs} protection prefs, ${summary.payouts} payout entries, ${summary.wallets} wallets`
    );
  } finally {
    await pool.end();
  }
};

void main().catch((e) => {
  console.error(`[ep-migrate] FAILED: ${(e as Error).message}`);
  process.exit(1);
});
