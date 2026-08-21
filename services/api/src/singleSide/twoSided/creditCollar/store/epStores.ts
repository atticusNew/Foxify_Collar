/**
 * EARN & PROTECT STORES — one async interface over two backends:
 *
 *   json      — the Phase 1 files (dev default; zero setup)
 *   postgres  — production (DATABASE_URL set ⟹ selected automatically); full records live as
 *               JSONB with indexed id/account/status columns, so the pure domain modules keep
 *               their load-all/mutate/save-all shape unchanged
 *
 * Write strategy on postgres: each save runs DELETE + INSERT of the full set inside one
 * transaction. Deliberately simple — the book is capped at tens of open wraps (decision 4), the
 * writers are single-process loops, and pg-mem (tests) chokes on ON CONFLICT upserts. Revisit only
 * if the book cap ever grows orders of magnitude.
 */

import type { Pool } from "pg";
import {
  loadDemoWraps,
  saveDemoWraps,
  loadProtectionPrefs,
  saveProtectionPrefs,
  type DemoWrapRecord,
  type ProtectionPrefs
} from "../demoWrap";
import { loadPayoutLedger, savePayoutLedger, type PayoutEntry } from "../settlement/payoutLedger";
import type { WalletRegistry } from "../capsConfig";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveWritablePath } from "../shadowStore";

export type EpStorePaths = {
  wraps: string;
  protection: string;
  ledger: string;
  registry: string;
  runtime: string; // kill-switch / pause flag
  tos: string; // per-account Terms acceptances
  waitlist: string; // wallets queued beyond the founding cohort
};

/**
 * One wallet's Terms-of-Service acceptance (versioned — a new ToS version requires re-acceptance).
 * When the public-demo signature gate is armed, `signature` holds the wallet's EIP-191 signature
 * over the canonical accept message and `signerVerified` records that it recovered to the account
 * — one signature is both proof-of-control and a signed ToS acceptance.
 */
export type TosAcceptance = { version: string; acceptedAtMs: number; country: string | null; signature?: string | null; signerVerified?: boolean };
export type TosRegistry = Record<string, TosAcceptance>; // key = account, lowercase

/** First-come waitlist beyond the founding cohort. */
export type WaitlistEntry = { account: string; joinedAtMs: number };

/** Runtime flags an admin can flip without redeploying (pause survives restarts). */
export type EpRuntimeFlags = { paused: boolean; pausedReason: string | null; updatedAtMs: number };

export type EpStores = {
  kind: "json" | "postgres";
  loadWraps: () => Promise<DemoWrapRecord[]>;
  saveWraps: (records: DemoWrapRecord[]) => Promise<void>;
  loadPrefs: () => Promise<ProtectionPrefs>;
  savePrefs: (prefs: ProtectionPrefs) => Promise<void>;
  loadLedger: () => Promise<PayoutEntry[]>;
  saveLedger: (entries: PayoutEntry[]) => Promise<void>;
  loadRegistry: () => Promise<WalletRegistry>;
  saveRegistry: (registry: WalletRegistry) => Promise<void>;
  loadRuntime: () => Promise<EpRuntimeFlags>;
  saveRuntime: (flags: EpRuntimeFlags) => Promise<void>;
  loadTos: () => Promise<TosRegistry>;
  saveTos: (tos: TosRegistry) => Promise<void>;
  loadWaitlist: () => Promise<WaitlistEntry[]>;
  saveWaitlist: (entries: WaitlistEntry[]) => Promise<void>;
  /** Demo affordance: clear everything (guarded by DEMO_ALLOW_RESET upstream). */
  clearAll: () => Promise<void>;
};

const DEFAULT_RUNTIME: EpRuntimeFlags = { paused: false, pausedReason: null, updatedAtMs: 0 };

// ── JSON backend (Phase 1 files, wrapped async) ───────────────────────────────

const loadJsonObject = <T>(path: string, fallback: T): T => {
  const eff = resolveWritablePath(path);
  if (!existsSync(eff)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(eff, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
};

const saveJsonObject = (path: string, value: unknown): void => {
  try {
    writeFileSync(resolveWritablePath(path), JSON.stringify(value, null, 1), "utf8");
  } catch (e) {
    console.error(`[ep-store] save failed for ${path}: ${(e as Error).message}`);
  }
};

export const jsonStores = (paths: EpStorePaths): EpStores => ({
  kind: "json",
  loadWraps: async () => loadDemoWraps(paths.wraps),
  saveWraps: async (records) => saveDemoWraps(records, paths.wraps),
  loadPrefs: async () => loadProtectionPrefs(paths.protection),
  savePrefs: async (prefs) => saveProtectionPrefs(prefs, paths.protection),
  loadLedger: async () => loadPayoutLedger(paths.ledger),
  saveLedger: async (entries) => savePayoutLedger(entries, paths.ledger),
  loadRegistry: async () => loadJsonObject<WalletRegistry>(paths.registry, {}),
  saveRegistry: async (registry) => saveJsonObject(paths.registry, registry),
  loadRuntime: async () => loadJsonObject<EpRuntimeFlags>(paths.runtime, DEFAULT_RUNTIME),
  saveRuntime: async (flags) => saveJsonObject(paths.runtime, flags),
  loadTos: async () => loadJsonObject<TosRegistry>(paths.tos, {}),
  saveTos: async (tos) => saveJsonObject(paths.tos, tos),
  loadWaitlist: async () => {
    const eff = resolveWritablePath(paths.waitlist);
    if (!existsSync(eff)) return [];
    try {
      const parsed = JSON.parse(readFileSync(eff, "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as WaitlistEntry[]) : [];
    } catch {
      return [];
    }
  },
  saveWaitlist: async (entries) => {
    try {
      writeFileSync(resolveWritablePath(paths.waitlist), JSON.stringify(entries, null, 1), "utf8");
    } catch (e) {
      console.error(`[ep-store] waitlist save failed: ${(e as Error).message}`);
    }
  },
  clearAll: async () => {
    saveDemoWraps([], paths.wraps);
    saveProtectionPrefs({}, paths.protection);
    savePayoutLedger([], paths.ledger);
    saveJsonObject(paths.registry, {});
    saveJsonObject(paths.runtime, DEFAULT_RUNTIME);
    saveJsonObject(paths.tos, {});
    saveJsonObject(paths.waitlist, []);
  }
});

// ── Postgres backend ──────────────────────────────────────────────────────────

type Queryable = Pick<Pool, "query">;

/** Every table with its own DDL — the schema must EVOLVE per table, not all-or-nothing. */
const EP_TABLES: Array<{ name: string; ddl: string }> = [
  { name: "ep_wraps", ddl: "CREATE TABLE ep_wraps (id TEXT PRIMARY KEY, account TEXT NOT NULL, status TEXT NOT NULL, created_at_ms BIGINT NOT NULL, record JSONB NOT NULL)" },
  { name: "ep_protection", ddl: "CREATE TABLE ep_protection (account TEXT PRIMARY KEY, pref JSONB NOT NULL)" },
  { name: "ep_payouts", ddl: "CREATE TABLE ep_payouts (id TEXT PRIMARY KEY, account TEXT NOT NULL, status TEXT NOT NULL, entry JSONB NOT NULL)" },
  { name: "ep_wallets", ddl: "CREATE TABLE ep_wallets (account TEXT PRIMARY KEY, joined_at_ms BIGINT NOT NULL)" },
  { name: "ep_runtime", ddl: "CREATE TABLE ep_runtime (k TEXT PRIMARY KEY, v JSONB NOT NULL)" },
  { name: "ep_tos", ddl: "CREATE TABLE ep_tos (account TEXT PRIMARY KEY, acceptance JSONB NOT NULL)" },
  { name: "ep_waitlist", ddl: "CREATE TABLE ep_waitlist (account TEXT PRIMARY KEY, joined_at_ms BIGINT NOT NULL)" }
];

/**
 * Probe-then-create PER TABLE: a database created by an older deploy gets any newly added tables
 * on the next boot (production regression: an all-or-nothing probe on ep_wraps skipped creating
 * ep_waitlist on an existing database). Individual probes also keep pg-mem (tests) happy — it
 * trips on CREATE TABLE IF NOT EXISTS against existing tables.
 */
export const ensureEpSchema = async (pool: Queryable): Promise<void> => {
  for (const t of EP_TABLES) {
    try {
      await pool.query(`SELECT 1 FROM ${t.name} LIMIT 1`);
    } catch {
      await pool.query(t.ddl);
    }
  }
};

/** DELETE + INSERT the full set in one transaction (see module header for why). */
const replaceAll = async (pool: Queryable, table: string, rows: Array<{ cols: string[]; vals: unknown[] }>): Promise<void> => {
  await pool.query("BEGIN");
  try {
    await pool.query(`DELETE FROM ${table}`);
    for (const r of rows) {
      const placeholders = r.vals.map((_, i) => `$${i + 1}`).join(", ");
      await pool.query(`INSERT INTO ${table} (${r.cols.join(", ")}) VALUES (${placeholders})`, r.vals);
    }
    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  }
};

const parseJsonb = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));

export const postgresStores = (pool: Queryable): EpStores => ({
  kind: "postgres",
  loadWraps: async () => {
    const res = await pool.query("SELECT record FROM ep_wraps ORDER BY created_at_ms ASC");
    return res.rows.map((r: { record: unknown }) => parseJsonb<DemoWrapRecord>(r.record));
  },
  saveWraps: async (records) =>
    replaceAll(
      pool,
      "ep_wraps",
      records.map((r) => ({
        cols: ["id", "account", "status", "created_at_ms", "record"],
        vals: [r.id, r.account.toLowerCase(), r.status, r.createdAtMs, JSON.stringify(r)]
      }))
    ),
  loadPrefs: async () => {
    const res = await pool.query("SELECT account, pref FROM ep_protection");
    const out: ProtectionPrefs = {};
    for (const row of res.rows as Array<{ account: string; pref: unknown }>) out[row.account] = parseJsonb(row.pref);
    return out;
  },
  savePrefs: async (prefs) =>
    replaceAll(
      pool,
      "ep_protection",
      Object.entries(prefs).map(([account, pref]) => ({ cols: ["account", "pref"], vals: [account.toLowerCase(), JSON.stringify(pref)] }))
    ),
  loadLedger: async () => {
    const res = await pool.query("SELECT entry FROM ep_payouts");
    const entries = res.rows.map((r: { entry: unknown }) => parseJsonb<PayoutEntry>(r.entry));
    return entries.sort((a, b) => a.createdAtMs - b.createdAtMs);
  },
  saveLedger: async (entries) =>
    replaceAll(
      pool,
      "ep_payouts",
      entries.map((e) => ({ cols: ["id", "account", "status", "entry"], vals: [e.id, e.account.toLowerCase(), e.status, JSON.stringify(e)] }))
    ),
  loadRegistry: async () => {
    const res = await pool.query("SELECT account, joined_at_ms FROM ep_wallets");
    const out: WalletRegistry = {};
    for (const row of res.rows as Array<{ account: string; joined_at_ms: string | number }>) {
      out[row.account] = { joinedAtMs: Number(row.joined_at_ms) };
    }
    return out;
  },
  saveRegistry: async (registry) =>
    replaceAll(
      pool,
      "ep_wallets",
      Object.entries(registry).map(([account, w]) => ({ cols: ["account", "joined_at_ms"], vals: [account.toLowerCase(), w.joinedAtMs] }))
    ),
  loadRuntime: async () => {
    const res = await pool.query("SELECT v FROM ep_runtime WHERE k = 'flags'");
    return res.rows.length ? parseJsonb<EpRuntimeFlags>(res.rows[0].v) : DEFAULT_RUNTIME;
  },
  saveRuntime: async (flags) => replaceAll(pool, "ep_runtime", [{ cols: ["k", "v"], vals: ["flags", JSON.stringify(flags)] }]),
  loadTos: async () => {
    const res = await pool.query("SELECT account, acceptance FROM ep_tos");
    const out: TosRegistry = {};
    for (const row of res.rows as Array<{ account: string; acceptance: unknown }>) out[row.account] = parseJsonb(row.acceptance);
    return out;
  },
  saveTos: async (tos) =>
    replaceAll(
      pool,
      "ep_tos",
      Object.entries(tos).map(([account, a]) => ({ cols: ["account", "acceptance"], vals: [account.toLowerCase(), JSON.stringify(a)] }))
    ),
  loadWaitlist: async () => {
    const res = await pool.query("SELECT account, joined_at_ms FROM ep_waitlist ORDER BY joined_at_ms ASC");
    return (res.rows as Array<{ account: string; joined_at_ms: string | number }>).map((r) => ({ account: r.account, joinedAtMs: Number(r.joined_at_ms) }));
  },
  saveWaitlist: async (entries) =>
    replaceAll(
      pool,
      "ep_waitlist",
      entries.map((e) => ({ cols: ["account", "joined_at_ms"], vals: [e.account.toLowerCase(), e.joinedAtMs] }))
    ),
  clearAll: async () => {
    for (const t of ["ep_wraps", "ep_protection", "ep_payouts", "ep_wallets", "ep_runtime", "ep_tos", "ep_waitlist"]) await pool.query(`DELETE FROM ${t}`);
  }
});

// ── Migration (Phase 1 JSON files → Postgres) ─────────────────────────────────

export type MigrationSummary = { wraps: number; prefs: number; payouts: number; wallets: number };

/** One-shot import of the JSON state into Postgres. Refuses to overwrite a non-empty database. */
export const migrateJsonToPostgres = async (paths: EpStorePaths, pool: Queryable, force = false): Promise<MigrationSummary> => {
  await ensureEpSchema(pool);
  const pg = postgresStores(pool);
  if (!force) {
    const existing = await pg.loadWraps();
    if (existing.length > 0) throw new Error(`postgres already holds ${existing.length} wraps — pass force to replace`);
  }
  const json = jsonStores(paths);
  const [wraps, prefs, ledger, registry, runtime, tos, waitlist] = await Promise.all([
    json.loadWraps(),
    json.loadPrefs(),
    json.loadLedger(),
    json.loadRegistry(),
    json.loadRuntime(),
    json.loadTos(),
    json.loadWaitlist()
  ]);
  await pg.saveWraps(wraps);
  await pg.savePrefs(prefs);
  await pg.saveLedger(ledger);
  await pg.saveRegistry(registry);
  await pg.saveRuntime(runtime);
  await pg.saveTos(tos);
  await pg.saveWaitlist(waitlist);
  return { wraps: wraps.length, prefs: Object.keys(prefs).length, payouts: ledger.length, wallets: Object.keys(registry).length };
};

// ── Boot reconcile (open wraps vs live OKX option positions) ──────────────────

export type VenueOptionPosition = { instId: string; pos: number };

/**
 * Compare the store's open OKX-lane wraps against the venue's actual option positions. Pure —
 * returns human discrepancy lines for alerting; never mutates state (a human decides what a
 * mismatch means). Paper wraps have no venue legs and are skipped.
 */
export const reconcileOpenWraps = (records: DemoWrapRecord[], venuePositions: VenueOptionPosition[]): string[] => {
  const issues: string[] = [];
  const venueByInst = new Map(venuePositions.map((p) => [p.instId, p.pos]));
  const claimed = new Map<string, number>(); // instId -> contracts the store believes are open
  for (const r of records) {
    if (r.status !== "active" && r.status !== "executing") continue;
    if (r.hedge?.mode === "paper" || r.legs.every((l) => !l.real)) continue;
    for (const leg of r.legs) {
      if (!leg.instId) {
        issues.push(`wrap ${r.id}: ${r.status} with a missing leg instrument — cannot verify against the venue`);
        continue;
      }
      claimed.set(leg.instId, (claimed.get(leg.instId) ?? 0) + (r.hedge?.contracts ?? 0));
    }
  }
  for (const [instId, contracts] of claimed) {
    const venue = Math.abs(venueByInst.get(instId) ?? 0);
    if (venue + 1e-9 < contracts) {
      issues.push(`venue is MISSING position on ${instId}: store expects ${contracts} contracts, venue reports ${venue}`);
    }
  }
  for (const p of venuePositions) {
    if (Math.abs(p.pos) > 1e-9 && !claimed.has(p.instId)) {
      issues.push(`venue holds UNTRACKED option position ${p.instId} (${p.pos}) — no open wrap claims it`);
    }
  }
  return issues;
};
