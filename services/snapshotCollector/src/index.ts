/**
 * Foxify Pilot Snapshot Collector
 *
 * Read-only background worker. Polls the live Foxify pilot admin
 * endpoints on a schedule, persists raw snapshots + derived metrics
 * to its OWN Postgres DB, and emits structured logs.
 *
 * NEVER writes to the live pilot DB. Only uses GET/POST against the
 * public admin endpoints with X-Admin-Token auth.
 *
 * Required env:
 *   SNAPSHOT_FOXIFY_PILOT_URL    e.g. https://foxify-pilot-new.onrender.com
 *   SNAPSHOT_FOXIFY_ADMIN_TOKEN  the live PILOT_ADMIN_TOKEN
 *   SNAPSHOT_POSTGRES_URL        connection string for the collector's DB
 *
 * Optional env:
 *   SNAPSHOT_FAST_INTERVAL_MS    default 60000   (positions + health)
 *   SNAPSHOT_FULL_INTERVAL_MS    default 300000  (full incl. ledger + dryrun)
 *   SNAPSHOT_DAILY_ROLLUP_HOUR   default 1       (UTC hour to roll up the prior day)
 *   SNAPSHOT_HEDGE_MGR_DRY_RUN_ENABLED  default false
 *   SNAPSHOT_DB_POOL_MAX         default 4
 *   SNAPSHOT_DB_SSL              default auto (true if URL contains render.com)
 *   SNAPSHOT_RUN_MIGRATIONS_ON_BOOT  default true
 */
import {
  fetchActivePositionsDetail,
  fetchAllOpenLegs,
  fetchDashboard,
  fetchHealth,
  fetchHedgeManagerDryRun,
  fetchPoolLedger,
  type AdminClientConfig
} from "./admin-client.js";
import {
  closePool,
  completeRun,
  insertDerivedPositions,
  insertHealth,
  insertPoolLedger,
  insertRaw,
  insertRuleFirings,
  runMigrations,
  startRun,
  upsertDailyMetrics
} from "./db.js";
import {
  computeDailyMetrics,
  deriveAllPositions
} from "./metrics.js";

type Logger = {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
};

const log: Logger = {
  info: (msg, fields) =>
    console.log(JSON.stringify({ level: "info", msg, ts: new Date().toISOString(), ...fields })),
  warn: (msg, fields) =>
    console.warn(JSON.stringify({ level: "warn", msg, ts: new Date().toISOString(), ...fields })),
  error: (msg, fields) =>
    console.error(JSON.stringify({ level: "error", msg, ts: new Date().toISOString(), ...fields }))
};

const requireEnv = (key: string): string => {
  const v = process.env[key];
  if (!v) {
    log.error("missing_required_env", { key });
    process.exit(1);
  }
  return v;
};

const parseBool = (v: string | undefined, def: boolean): boolean =>
  v === undefined ? def : v === "1" || v.toLowerCase() === "true";

const parseInt10 = (v: string | undefined, def: number): number => {
  if (!v) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

const buildConfig = (): AdminClientConfig => ({
  baseUrl: requireEnv("SNAPSHOT_FOXIFY_PILOT_URL"),
  adminToken: requireEnv("SNAPSHOT_FOXIFY_ADMIN_TOKEN"),
  timeoutMs: parseInt10(process.env.SNAPSHOT_FETCH_TIMEOUT_MS, 15_000)
});

// Fast tick — positions + health only (cheap)
const fastPoll = async (cfg: AdminClientConfig): Promise<void> => {
  const runId = await startRun(cfg.baseUrl, "fast");
  let firstError: string | null = null;
  try {
    const [health, dashboard, positions] = await Promise.all([
      fetchHealth(cfg),
      fetchDashboard(cfg),
      fetchActivePositionsDetail(cfg, 200)
    ]);
    await Promise.all([
      insertRaw(runId, "health", health.httpStatus, health.rawBody),
      insertRaw(runId, "dashboard", dashboard.httpStatus, dashboard.rawBody),
      insertRaw(runId, "active-positions-detail", positions.httpStatus, positions.rawBody)
    ]);
    if (positions.parsed) {
      const derived = deriveAllPositions(positions.parsed);
      await insertDerivedPositions(runId, derived);
      log.info("fast_poll_positions", {
        count: derived.length,
        triggered: derived.filter((p) => p.status === "triggered").length,
        salvaging: derived.filter((p) => p.salvageState === "salvaging").length
      });
    }
    await insertHealth(runId, health.parsed, dashboard.parsed);
    if (!health.ok) firstError = `health:${health.errorMessage}`;
    else if (!dashboard.ok) firstError = `dashboard:${dashboard.errorMessage}`;
    else if (!positions.ok) firstError = `positions:${positions.errorMessage}`;
    await completeRun(runId, firstError === null, firstError);
  } catch (err) {
    log.error("fast_poll_failed", { runId, error: (err as Error).message });
    await completeRun(runId, false, (err as Error).message);
  }
};

// Full tick — adds ledgers + open legs + (optional) hedge manager dry-run
const fullPoll = async (cfg: AdminClientConfig): Promise<void> => {
  const runId = await startRun(cfg.baseUrl, "full");
  let firstError: string | null = null;
  try {
    const [
      health,
      dashboard,
      positions,
      openLegs,
      atticusLedger,
      foxifyLedger
    ] = await Promise.all([
      fetchHealth(cfg),
      fetchDashboard(cfg),
      fetchActivePositionsDetail(cfg, 200),
      fetchAllOpenLegs(cfg),
      fetchPoolLedger(cfg, "atticus_hedge", 500),
      fetchPoolLedger(cfg, "foxify_trader", 500)
    ]);

    await Promise.all([
      insertRaw(runId, "health", health.httpStatus, health.rawBody),
      insertRaw(runId, "dashboard", dashboard.httpStatus, dashboard.rawBody),
      insertRaw(runId, "active-positions-detail", positions.httpStatus, positions.rawBody),
      insertRaw(runId, "all-open-legs", openLegs.httpStatus, openLegs.rawBody),
      insertRaw(runId, "pool-ledger-atticus", atticusLedger.httpStatus, atticusLedger.rawBody),
      insertRaw(runId, "pool-ledger-foxify", foxifyLedger.httpStatus, foxifyLedger.rawBody)
    ]);

    if (positions.parsed) {
      const derived = deriveAllPositions(positions.parsed);
      await insertDerivedPositions(runId, derived);
    }
    await insertHealth(runId, health.parsed, dashboard.parsed);
    await insertPoolLedger(runId, "atticus_hedge", atticusLedger.parsed);
    await insertPoolLedger(runId, "foxify_trader", foxifyLedger.parsed);

    if (parseBool(process.env.SNAPSHOT_HEDGE_MGR_DRY_RUN_ENABLED, false)) {
      const dryRun = await fetchHedgeManagerDryRun(
        cfg,
        parseFloat(process.env.SNAPSHOT_HEDGE_MGR_IV ?? "0.4")
      );
      await insertRaw(runId, "hedge-manager-dry-run", dryRun.httpStatus, dryRun.rawBody);
      await insertRuleFirings(runId, dryRun.parsed);
    }

    log.info("full_poll_complete", {
      activePositions: dashboard.parsed?.activePositions,
      openLegs: openLegs.parsed?.count,
      atticusEntries: atticusLedger.parsed?.entries?.length ?? 0,
      foxifyEntries: foxifyLedger.parsed?.entries?.length ?? 0
    });

    if (!health.ok) firstError = `health:${health.errorMessage}`;
    else if (!dashboard.ok) firstError = `dashboard:${dashboard.errorMessage}`;
    else if (!positions.ok) firstError = `positions:${positions.errorMessage}`;
    else if (!openLegs.ok) firstError = `open-legs:${openLegs.errorMessage}`;
    else if (!atticusLedger.ok) firstError = `atticus-ledger:${atticusLedger.errorMessage}`;
    else if (!foxifyLedger.ok) firstError = `foxify-ledger:${foxifyLedger.errorMessage}`;

    await completeRun(runId, firstError === null, firstError);
  } catch (err) {
    log.error("full_poll_failed", { runId, error: (err as Error).message });
    await completeRun(runId, false, (err as Error).message);
  }
};

const dailyRollup = async (cfg: AdminClientConfig): Promise<void> => {
  log.info("daily_rollup_start");
  const yesterday = new Date(Date.now() - 24 * 3600_000);
  const dateUtc = yesterday.toISOString().slice(0, 10);
  const runId = await startRun(cfg.baseUrl, "manual");
  try {
    const [positions, atticus, foxify, dryRun] = await Promise.all([
      fetchActivePositionsDetail(cfg, 200),
      fetchPoolLedger(cfg, "atticus_hedge", 1000),
      fetchPoolLedger(cfg, "foxify_trader", 1000),
      parseBool(process.env.SNAPSHOT_HEDGE_MGR_DRY_RUN_ENABLED, false)
        ? fetchHedgeManagerDryRun(cfg, 0.4)
        : Promise.resolve(null)
    ]);
    const closed = positions.parsed
      ? deriveAllPositions(positions.parsed).filter(
          (p) =>
            p.status === "closed" ||
            p.status === "expired" ||
            p.status === "triggered" ||
            p.status === "failed"
        )
      : [];
    const metrics = computeDailyMetrics({
      dateUtc,
      closedPositions: closed,
      atticusLedger: atticus.parsed,
      foxifyLedger: foxify.parsed,
      ruleFirings: dryRun?.parsed?.actions ?? []
    });
    await upsertDailyMetrics(metrics);
    log.info("daily_rollup_done", {
      dateUtc,
      closed: metrics.closedPositionsCount,
      netPnl: metrics.netAtticusPnlUsdc
    });
    await completeRun(runId, true, null);
  } catch (err) {
    log.error("daily_rollup_failed", { error: (err as Error).message });
    await completeRun(runId, false, (err as Error).message);
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let shuttingDown = false;
const onShutdown = async (sig: string): Promise<void> => {
  log.info("shutdown_signal", { sig });
  shuttingDown = true;
  await closePool();
  process.exit(0);
};
process.on("SIGTERM", () => void onShutdown("SIGTERM"));
process.on("SIGINT", () => void onShutdown("SIGINT"));

const main = async (): Promise<void> => {
  const cfg = buildConfig();
  log.info("collector_start", {
    baseUrl: cfg.baseUrl,
    fastIntervalMs: parseInt10(process.env.SNAPSHOT_FAST_INTERVAL_MS, 60_000),
    fullIntervalMs: parseInt10(process.env.SNAPSHOT_FULL_INTERVAL_MS, 300_000)
  });

  if (parseBool(process.env.SNAPSHOT_RUN_MIGRATIONS_ON_BOOT, true)) {
    log.info("running_migrations");
    await runMigrations();
  }

  const fastIntervalMs = parseInt10(process.env.SNAPSHOT_FAST_INTERVAL_MS, 60_000);
  const fullIntervalMs = parseInt10(process.env.SNAPSHOT_FULL_INTERVAL_MS, 300_000);
  const rollupHourUtc = parseInt10(process.env.SNAPSHOT_DAILY_ROLLUP_HOUR, 1);

  let lastFastMs = 0;
  let lastFullMs = 0;
  let lastRollupDate = "";

  while (!shuttingDown) {
    const now = Date.now();
    const nowDate = new Date(now);
    const hourUtc = nowDate.getUTCHours();
    const todayUtc = nowDate.toISOString().slice(0, 10);

    if (hourUtc === rollupHourUtc && lastRollupDate !== todayUtc) {
      lastRollupDate = todayUtc;
      try {
        await dailyRollup(cfg);
      } catch (err) {
        log.error("rollup_unexpected_error", { error: (err as Error).message });
      }
    }

    if (now - lastFullMs >= fullIntervalMs) {
      lastFullMs = now;
      try {
        await fullPoll(cfg);
      } catch (err) {
        log.error("full_poll_unexpected_error", { error: (err as Error).message });
      }
    } else if (now - lastFastMs >= fastIntervalMs) {
      lastFastMs = now;
      try {
        await fastPoll(cfg);
      } catch (err) {
        log.error("fast_poll_unexpected_error", { error: (err as Error).message });
      }
    }

    await sleep(5_000);
  }
};

main().catch(async (err) => {
  log.error("collector_fatal", { error: (err as Error).message, stack: (err as Error).stack });
  await closePool();
  process.exit(1);
});
