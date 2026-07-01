/**
 * Opening-signal store — models how a partner (Foxify) actually opens flow: a steady arrival RATE over
 * time (e.g. 2 positions/day), staggered across cycles at live prices, rather than a fixed batch dumped at
 * one price each cycle. The cycle loop asks this each tick "how many should open now?"; a persisted
 * fractional accumulator advances by the elapsed-time share of the daily rate and releases whole positions
 * as they accrue. Sides are still steered net-flat by the scaffold, so the book is delta-neutral OVER TIME
 * (not one-for-one). Pure compute + tiny disk-backed state (same writable-fallback as the other stores).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveWritablePath } from "./shadowStore";

export const DEFAULT_OPENING_STATE_PATH = process.env.SHADOW_OPENING_STATE_PATH ?? "./logs/shadow-opening-state.json";

export type OpeningState = { accumulator: number; lastMs: number };

const DAY_MS = 86_400_000;

/**
 * Advance the accumulator by the elapsed-time share of the daily rate; return whole positions to open now.
 * Pure. First call (no prior state) seeds the clock and opens `firstCycleOpens` (default 1) to kick-start.
 * `maxPerCycle` caps a catch-up burst if a cycle was delayed (fail-safe against dumping a backlog at once).
 */
export const computeOpensThisCycle = (
  prev: OpeningState | null,
  nowMs: number,
  dailyPositions: number,
  opts: { maxPerCycle?: number; firstCycleOpens?: number } = {}
): { nToOpen: number; next: OpeningState } => {
  const maxPerCycle = opts.maxPerCycle ?? 5;
  if (!(dailyPositions > 0)) return { nToOpen: 0, next: { accumulator: 0, lastMs: nowMs } };
  if (prev == null) {
    const seed = Math.max(0, Math.min(maxPerCycle, Math.floor(opts.firstCycleOpens ?? 1)));
    return { nToOpen: seed, next: { accumulator: 0, lastMs: nowMs } };
  }
  const elapsed = Math.max(0, nowMs - prev.lastMs);
  const acc = prev.accumulator + (dailyPositions * elapsed) / DAY_MS;
  const n = Math.min(maxPerCycle, Math.floor(acc + 1e-9));
  return { nToOpen: n, next: { accumulator: acc - n, lastMs: nowMs } };
};

export const loadOpeningState = (path = DEFAULT_OPENING_STATE_PATH): OpeningState | null => {
  const eff = resolveWritablePath(path);
  if (!existsSync(eff)) return null;
  try {
    const s = JSON.parse(readFileSync(eff, "utf8")) as OpeningState;
    if (s && Number.isFinite(s.accumulator) && Number.isFinite(s.lastMs)) return s;
  } catch {
    /* skip */
  }
  return null;
};

export const saveOpeningState = (state: OpeningState, path = DEFAULT_OPENING_STATE_PATH): void => {
  const eff = resolveWritablePath(path);
  try {
    writeFileSync(eff, JSON.stringify(state), "utf8");
  } catch (e) {
    console.warn(`[opening-store] save failed (${(e as Error).message})`);
  }
};
