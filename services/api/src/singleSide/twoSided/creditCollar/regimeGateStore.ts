/**
 * Regime-gate state persistence — remembers the last regime across cycles/restarts so hysteresis works
 * (sticky exits need to know which regime we're already in). Tiny JSON, same writable-fallback pattern
 * as the other stores.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveWritablePath } from "./shadowStore";

export const DEFAULT_GATE_STATE_PATH = process.env.SHADOW_GATE_STATE_PATH ?? "./logs/shadow-gate-state.json";

export type GateState = { regime: "calm" | "elevated" | "halt"; updatedAtMs: number };

export const loadGateState = (path = DEFAULT_GATE_STATE_PATH): GateState | null => {
  const eff = resolveWritablePath(path);
  if (!existsSync(eff)) return null;
  try {
    const s = JSON.parse(readFileSync(eff, "utf8")) as GateState;
    if (s && ["calm", "elevated", "halt"].includes(s.regime)) return s;
  } catch {
    /* skip */
  }
  return null;
};

export const saveGateState = (state: GateState, path = DEFAULT_GATE_STATE_PATH): void => {
  try {
    writeFileSync(resolveWritablePath(path), JSON.stringify(state), "utf8");
  } catch (e) {
    console.warn(`[gate-store] save failed (${(e as Error).message})`);
  }
};
