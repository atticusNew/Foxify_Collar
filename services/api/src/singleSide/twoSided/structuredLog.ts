/**
 * Structured JSON logger for two-sided cooperative volume facility (PR B3).
 *
 * Emits one JSON-per-line entry per event. Renders parse-friendly logs that
 * tools like Loki/CloudWatch/Datadog can query by pair_id, event_kind, severity.
 *
 * Usage:
 *   import { slog } from "./structuredLog";
 *   slog.info("pair activated", { pair_id, foxify_pair_ref, total_hedge_cost_usdc });
 *
 * Severity levels: debug, info, warn, error, critical.
 *
 * In production, set TWO_SIDED_LOG_LEVEL=info (default) to filter debug noise.
 */

export type LogSeverity = "debug" | "info" | "warn" | "error" | "critical";

const SEVERITY_RANK: Record<LogSeverity, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  critical: 4
};

const minSeverity = (): LogSeverity => {
  const env = (process.env.TWO_SIDED_LOG_LEVEL ?? "info").toLowerCase() as LogSeverity;
  if (env in SEVERITY_RANK) return env;
  return "info";
};

export type StructuredLogEntry = {
  ts: string;
  severity: LogSeverity;
  msg: string;
  pair_id?: string;
  event_kind?: string;
  [key: string]: unknown;
};

const emit = (entry: StructuredLogEntry): void => {
  if (SEVERITY_RANK[entry.severity] < SEVERITY_RANK[minSeverity()]) return;
  // Single-line JSON per entry — Loki/CloudWatch friendly
  try {
    console.log(JSON.stringify(entry));
  } catch {
    // Fallback if circular references
    console.log(`[${entry.severity}] ${entry.msg}`);
  }
};

const entry = (sev: LogSeverity, msg: string, meta: Record<string, unknown> = {}): StructuredLogEntry => ({
  ts: new Date().toISOString(),
  severity: sev,
  msg,
  ...meta
});

export const slog = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit(entry("debug", msg, meta)),
  info: (msg: string, meta?: Record<string, unknown>) => emit(entry("info", msg, meta)),
  warn: (msg: string, meta?: Record<string, unknown>) => emit(entry("warn", msg, meta)),
  error: (msg: string, meta?: Record<string, unknown>) => emit(entry("error", msg, meta)),
  critical: (msg: string, meta?: Record<string, unknown>) => emit(entry("critical", msg, meta))
};

/** Helper: wrap an existing logger callback (used by services that take inj. log fn). */
export const slogAdapter = (sev: LogSeverity = "info") => (msg: string, meta?: Record<string, unknown>) => emit(entry(sev, msg, meta));
