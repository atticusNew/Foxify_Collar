/**
 * Standalone migration runner. Use:
 *   npm --workspace services/snapshotCollector run migrate
 *
 * Render runs migrations on each boot by default
 * (`SNAPSHOT_RUN_MIGRATIONS_ON_BOOT=true`). This script exists for
 * one-off / local invocation.
 */
import { closePool, runMigrations } from "./db.js";

const main = async (): Promise<void> => {
  console.log(JSON.stringify({ level: "info", msg: "migrate_start", ts: new Date().toISOString() }));
  try {
    await runMigrations();
    console.log(JSON.stringify({ level: "info", msg: "migrate_complete", ts: new Date().toISOString() }));
  } finally {
    await closePool();
  }
};

main().catch((err) => {
  console.error(JSON.stringify({
    level: "error",
    msg: "migrate_failed",
    error: (err as Error).message,
    stack: (err as Error).stack
  }));
  process.exit(1);
});
