/**
 * Live-execution guards (pure) — every rail that must hold before a real order leaves the building:
 *
 *   - MASTER KILL-SWITCH: LIVE_ENABLED (default false). Nothing trades until it is deliberately set.
 *   - LIVE-MONEY CONFIRM: mode "live" additionally requires OKX_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY
 *     (same phrase as the dry-run tooling — one confirmation convention everywhere).
 *   - DAILY WINDOW: one attempt per UTC day at/after LIVE_WINDOW_UTC (default 08:15), and never after
 *     LIVE_WINDOW_LATEST_UTC (default 10:00) — a missed window is SKIPPED, not chased.
 *   - NOTIONAL CAPS: per-position (default $50k) and per-day (default $100k), on the EFFECTIVE
 *     (contract-rounded) notional.
 *   - RECON HALT: any unresolved settlement-reconciliation mismatch halts new issuance.
 *
 * All pure decision functions — I/O (stores, env) stays at the edges.
 */

import type { LiveWindowState } from "./liveExecutionStore";

export type LiveGuardsConfig = {
  liveEnabled: boolean;
  mode: "demo" | "live";
  liveConfirmed: boolean;          // OKX_LIVE_CONFIRM matches the phrase
  windowUtc: string;               // "HH:MM"
  windowLatestUtc: string;         // "HH:MM"
  maxPositionNotionalUsdc: number;
  maxDayNotionalUsdc: number;
  slippageBandPct: number;
  maxStrikeDriftPct: number;
  canaryContracts: number | null;  // when set, forces a tiny fixed contract count (Mon/Tue canary)
};

export const LIVE_CONFIRM_PHRASE = "I_UNDERSTAND_REAL_MONEY";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

/** Parse the guard config from env. Defaults are the pilot spec; everything is default-off/safe. */
export const parseLiveGuardsFromEnv = (env: Record<string, string | undefined>): LiveGuardsConfig => ({
  liveEnabled: String(env.LIVE_ENABLED ?? "").toLowerCase() === "true",
  mode: (env.OKX_EXECUTION_MODE ?? "demo").toLowerCase() === "live" ? "live" : "demo",
  liveConfirmed: env.OKX_LIVE_CONFIRM === LIVE_CONFIRM_PHRASE,
  windowUtc: env.LIVE_WINDOW_UTC ?? "08:15",
  windowLatestUtc: env.LIVE_WINDOW_LATEST_UTC ?? "10:00",
  maxPositionNotionalUsdc: num(env.LIVE_MAX_POSITION_USDC, 50_000),
  maxDayNotionalUsdc: num(env.LIVE_MAX_DAY_NOTIONAL_USDC, 100_000),
  slippageBandPct: num(env.LIVE_SLIPPAGE_BAND_PCT, 0.25),
  maxStrikeDriftPct: num(env.LIVE_MAX_STRIKE_DRIFT_PCT, 0.01),
  canaryContracts: num(env.LIVE_CANARY_CONTRACTS, 0) > 0 ? num(env.LIVE_CANARY_CONTRACTS, 0) : null
});

/** Is the execution path armed at all? (Kill-switch + live-money confirmation.) */
export const executionArmed = (cfg: LiveGuardsConfig): { armed: boolean; reason: string } => {
  if (!cfg.liveEnabled) return { armed: false, reason: "LIVE_ENABLED is not true (master kill-switch off)" };
  if (cfg.mode === "live" && !cfg.liveConfirmed) {
    return { armed: false, reason: `OKX_EXECUTION_MODE=live but OKX_LIVE_CONFIRM≠${LIVE_CONFIRM_PHRASE} — refusing real money` };
  }
  return { armed: true, reason: cfg.mode === "live" ? "armed (LIVE — real money)" : "armed (demo environment)" };
};

const hhmmToMinutes = (hhmm: string): number => {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
};

export const dayUtcOf = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

export type WindowDecision = { due: boolean; dayUtc: string; reason: string };

/**
 * One attempt per UTC day, inside [windowUtc, windowLatestUtc]. A day whose window passed without an
 * attempt is skipped — never chased (chasing = executing at a different tenor than the product).
 */
export const isWindowDue = (nowMs: number, state: LiveWindowState, cfg: Pick<LiveGuardsConfig, "windowUtc" | "windowLatestUtc">): WindowDecision => {
  const day = dayUtcOf(nowMs);
  const d = new Date(nowMs);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const open = hhmmToMinutes(cfg.windowUtc);
  const latest = hhmmToMinutes(cfg.windowLatestUtc);
  if (state.lastAttemptDayUtc === day) return { due: false, dayUtc: day, reason: `already attempted today (${state.lastOutcome ?? "?"}) — one window per day` };
  if (minutes < open) return { due: false, dayUtc: day, reason: `before window ${cfg.windowUtc} UTC` };
  if (minutes > latest) return { due: false, dayUtc: day, reason: `after latest ${cfg.windowLatestUtc} UTC — day skipped, never chase` };
  return { due: true, dayUtc: day, reason: `window open (${cfg.windowUtc}–${cfg.windowLatestUtc} UTC)` };
};

/** Per-position + per-day notional caps on the EFFECTIVE (rounded) notional. */
export const checkNotionalCaps = (
  effectiveNotionalUsdc: number,
  bookedTodayUsdc: number,
  cfg: Pick<LiveGuardsConfig, "maxPositionNotionalUsdc" | "maxDayNotionalUsdc">
): { ok: boolean; reason: string } => {
  if (effectiveNotionalUsdc > cfg.maxPositionNotionalUsdc + 1e-6) {
    return { ok: false, reason: `position notional ${effectiveNotionalUsdc} > per-position cap ${cfg.maxPositionNotionalUsdc}` };
  }
  if (bookedTodayUsdc + effectiveNotionalUsdc > cfg.maxDayNotionalUsdc + 1e-6) {
    return { ok: false, reason: `day notional ${bookedTodayUsdc} + ${effectiveNotionalUsdc} > per-day cap ${cfg.maxDayNotionalUsdc}` };
  }
  return { ok: true, reason: "within caps" };
};
