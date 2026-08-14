/**
 * Live-execution persistence — disk-backed JSONL/JSON stores for the OKX live pilot, isolated from
 * the shadow stores (fresh LIVE_* paths so the live track record is single-config + unpolluted):
 *   - executions ledger  (every live window attempt + its outcome — drives the per-day notional cap)
 *   - window state       (one live attempt per UTC day; never chase a missed window)
 *   - alert log          (every LIVE alert, also printed loudly — the audit trail)
 *   - reconciliation log (our oracle settlement vs OKX's actual settlement, per position)
 *
 * Same conventions as the shadow stores: resolveWritablePath fallback, append-only JSONL, malformed
 * lines skipped.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveWritablePath } from "../shadowStore";

export const DEFAULT_LIVE_EXECUTIONS_PATH = process.env.LIVE_EXECUTIONS_PATH ?? "./logs/live-executions.jsonl";
export const DEFAULT_LIVE_WINDOW_STATE_PATH = process.env.LIVE_WINDOW_STATE_PATH ?? "./logs/live-window-state.json";
export const DEFAULT_LIVE_ALERTS_PATH = process.env.LIVE_ALERTS_PATH ?? "./logs/live-alerts.jsonl";
export const DEFAULT_LIVE_RECON_PATH = process.env.LIVE_RECON_PATH ?? "./logs/live-reconciliations.jsonl";

const readJsonl = <T>(path: string): T[] => {
  const eff = resolveWritablePath(path);
  if (!existsSync(eff)) return [];
  const out: T[] = [];
  for (const line of readFileSync(eff, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
};

const appendJsonl = (path: string, record: unknown): void => {
  try {
    appendFileSync(resolveWritablePath(path), JSON.stringify(record) + "\n", "utf8");
  } catch (e) {
    console.error(`[live-store] append to ${path} failed: ${(e as Error).message}`);
  }
};

// ── Executions ledger ─────────────────────────────────────────────────────────

export type LiveExecutionRecord = {
  tsMs: number;
  dayUtc: string;                 // YYYY-MM-DD (window day)
  ref: string;
  side: "long" | "short";
  /** "filled" books notional; everything else stands for nothing. Known values: filled ·
   *  pair_sibling_unwound · OKX: aborted_no_fill / aborted_unwound / naked_leg_unresolved ·
   *  FalconX: aborted_no_quote / aborted_band / aborted_execute_failed. */
  outcome: string;
  mode: "demo" | "live";
  effectiveNotionalUsdc: number;  // 0 unless filled/booked
  contracts: number;
  putInstId: string | null;
  callInstId: string | null;
  netCreditUsdc: number | null;
  venueFeeUsdc: number | null;
  detail?: unknown;
};

export const appendLiveExecution = (rec: LiveExecutionRecord, path = DEFAULT_LIVE_EXECUTIONS_PATH): void => appendJsonl(path, rec);
export const loadLiveExecutions = (path = DEFAULT_LIVE_EXECUTIONS_PATH): LiveExecutionRecord[] => readJsonl<LiveExecutionRecord>(path);

/** Booked (filled) live notional for a UTC day — the per-day cap gauge. Pure over loaded records. */
export const bookedNotionalForDay = (records: LiveExecutionRecord[], dayUtc: string): number =>
  records.filter((r) => r.dayUtc === dayUtc && r.outcome === "filled").reduce((s, r) => s + r.effectiveNotionalUsdc, 0);

// ── Window state (one attempt per UTC day) ────────────────────────────────────

export type LiveWindowState = { lastAttemptDayUtc: string | null; lastAttemptTsMs: number | null; lastOutcome: string | null };

export const loadWindowState = (path = DEFAULT_LIVE_WINDOW_STATE_PATH): LiveWindowState => {
  const eff = resolveWritablePath(path);
  if (!existsSync(eff)) return { lastAttemptDayUtc: null, lastAttemptTsMs: null, lastOutcome: null };
  try {
    return JSON.parse(readFileSync(eff, "utf8")) as LiveWindowState;
  } catch {
    return { lastAttemptDayUtc: null, lastAttemptTsMs: null, lastOutcome: null };
  }
};

export const saveWindowState = (state: LiveWindowState, path = DEFAULT_LIVE_WINDOW_STATE_PATH): void => {
  try {
    writeFileSync(resolveWritablePath(path), JSON.stringify(state), "utf8");
  } catch (e) {
    console.error(`[live-store] window state save failed: ${(e as Error).message}`);
  }
};

// ── Alerts ────────────────────────────────────────────────────────────────────

export type LiveAlert = { tsMs: number; level: "warn" | "critical"; code: string; message: string; data?: unknown };

/** Log LOUDLY (console) and persist. The pilot's minimum alerting bar. */
export const raiseLiveAlert = (alert: LiveAlert, path = DEFAULT_LIVE_ALERTS_PATH): void => {
  const banner = alert.level === "critical" ? "🚨🚨 LIVE-ALERT CRITICAL 🚨🚨" : "⚠️ LIVE-ALERT";
  // Demo wrap is not a daily canary window — drop the "day skipped" suffix on that alert path.
  const message = /demo-live/.test(path) ? alert.message.replace(/\s*—\s*day skipped/gi, "") : alert.message;
  console.error(`${banner} [${alert.code}] ${message}`);
  appendJsonl(path, { ...alert, message });
};

export const loadLiveAlerts = (path = DEFAULT_LIVE_ALERTS_PATH): LiveAlert[] => readJsonl<LiveAlert>(path);

// ── Reconciliation records ────────────────────────────────────────────────────

export type LiveReconRecord = {
  tsMs: number;
  ref: string;
  putInstId: string | null;
  callInstId: string | null;
  ourSettlePriceUsd: number;
  venueSettlePriceUsd: number | null;   // the venue's own fixing for the expiry (null = not yet published)
  priceDiffUsd: number | null;
  ourPayoutUsdc: number;                // our oracle-settled collar payoff for the position
  venueCashFlowUsdc: number | null;     // realized venue settlement cash flow, USD
  cashDiffUsdc: number | null;
  toleranceUsdc: number;
  status: "matched" | "mismatch" | "pending_venue_data";
  notes: string[];
};

export const appendLiveRecon = (rec: LiveReconRecord, path = DEFAULT_LIVE_RECON_PATH): void => appendJsonl(path, rec);
export const loadLiveRecons = (path = DEFAULT_LIVE_RECON_PATH): LiveReconRecord[] => readJsonl<LiveReconRecord>(path);

/**
 * Is issuance halted by an unresolved reconciliation mismatch? A later "matched" record for the same
 * ref clears it (re-running reconciliation after investigating is the release path).
 */
export const hasUnresolvedReconMismatch = (records: LiveReconRecord[]): boolean => {
  const latestByRef = new Map<string, LiveReconRecord>();
  for (const r of records) {
    const prev = latestByRef.get(r.ref);
    if (!prev || r.tsMs >= prev.tsMs) latestByRef.set(r.ref, r);
  }
  return [...latestByRef.values()].some((r) => r.status === "mismatch");
};
