/**
 * Rolling oracle tick history — the price stream the touch-first settlement model needs. Each shadow
 * cycle appends ONE verified median price; the rolling window is what `settleMatured` (and the
 * lifecycle overlay) feed to the anti-wick barrier detector. Without this, the synthetic same-price
 * 2-tick stream never confirms a touch, so the touch path can't engage on live data.
 *
 * Disk-backed (Render disk) with the same writable-fallback as the other shadow stores. The roll itself
 * is PURE (append + age/count trim) so it's deterministic and testable.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveWritablePath } from "./shadowStore";
import type { OracleTick } from "./referenceOracle";

export const DEFAULT_TICK_HISTORY_PATH = process.env.SHADOW_TICK_HISTORY_PATH ?? "./logs/shadow-tick-history.json";

export type RollConfig = {
  /** Hard cap on retained ticks (most recent kept). Default 192 (≈48h at 15-min cycles). */
  maxTicks?: number;
  /** Drop ticks older than this age vs nowMs. Default 24h. */
  maxAgeMs?: number;
};

/**
 * Append `next` to the prior history, drop anything older than `maxAgeMs`, and keep at most `maxTicks`
 * most-recent ticks (chronologically sorted). Pure. Ignores a non-finite/zero price (fail-safe — a bad
 * sample must not poison the touch detector).
 */
export const rollTickHistory = (
  prev: OracleTick[],
  next: OracleTick,
  nowMs: number,
  cfg: RollConfig = {}
): OracleTick[] => {
  const maxTicks = cfg.maxTicks != null && cfg.maxTicks > 0 ? Math.floor(cfg.maxTicks) : 192;
  const maxAgeMs = cfg.maxAgeMs != null && cfg.maxAgeMs > 0 ? cfg.maxAgeMs : 24 * 3_600_000;
  const minTs = nowMs - maxAgeMs;
  const merged = [...prev];
  if (next.priceUsd > 0 && Number.isFinite(next.priceUsd) && Number.isFinite(next.tsMs)) merged.push(next);
  const cleaned = merged
    .filter((t) => Number.isFinite(t.priceUsd) && t.priceUsd > 0 && Number.isFinite(t.tsMs) && t.tsMs >= minTs && t.tsMs <= nowMs)
    .sort((a, b) => a.tsMs - b.tsMs);
  return cleaned.length > maxTicks ? cleaned.slice(cleaned.length - maxTicks) : cleaned;
};

export const loadTickHistory = (path = DEFAULT_TICK_HISTORY_PATH): OracleTick[] => {
  const eff = resolveWritablePath(path);
  if (!existsSync(eff)) return [];
  try {
    const parsed = JSON.parse(readFileSync(eff, "utf8")) as OracleTick[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t) => t && Number.isFinite(t.priceUsd) && Number.isFinite(t.tsMs));
  } catch {
    return [];
  }
};

export const saveTickHistory = (ticks: OracleTick[], path = DEFAULT_TICK_HISTORY_PATH): void => {
  const eff = resolveWritablePath(path);
  try {
    writeFileSync(eff, JSON.stringify(ticks), "utf8");
  } catch (e) {
    console.warn(`[tick-history] save failed (${(e as Error).message})`);
  }
};
