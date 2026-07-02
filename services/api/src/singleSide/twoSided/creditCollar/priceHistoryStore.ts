/**
 * Live price-history store + leading regime signal (pure compute + tiny disk-backed ring buffer). The
 * TRAILING gate reads settled positions (updates only when something matures, ~12–24h late). This adds a
 * LEADING gauge: the shadow records the oracle price EVERY cycle (~15 min), so we can measure current
 * realized vol + short-horizon momentum and react to a developing trend/vol-spike the same cycle, hours
 * before a settled position would reveal it. Both are expressed in daily-% terms so they compare directly
 * to the gate thresholds; the gate uses whichever (trailing vs live) is higher.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveWritablePath } from "./shadowStore";

export const DEFAULT_PRICE_HISTORY_PATH = process.env.SHADOW_PRICE_HISTORY_PATH ?? "./logs/shadow-price-history.jsonl";

export type PriceObs = { tsMs: number; priceUsd: number };

const DAY_MS = 86_400_000;

const std = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length);
};
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export const loadPriceHistory = (path = DEFAULT_PRICE_HISTORY_PATH): PriceObs[] => {
  const eff = resolveWritablePath(path);
  if (!existsSync(eff)) return [];
  const out: PriceObs[] = [];
  for (const line of readFileSync(eff, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const p = JSON.parse(t) as PriceObs;
      if (p && Number.isFinite(p.tsMs) && Number.isFinite(p.priceUsd) && p.priceUsd > 0) out.push(p);
    } catch {
      /* skip */
    }
  }
  return out;
};

/** Record the current oracle price; keep the file bounded (ring buffer of the most recent `maxKeep`). */
export const appendPriceObs = (obs: PriceObs, path = DEFAULT_PRICE_HISTORY_PATH, maxKeep = 400): void => {
  const eff = resolveWritablePath(path);
  try {
    const existing = loadPriceHistory(path);
    existing.push(obs);
    const trimmed = existing.slice(-maxKeep);
    if (trimmed.length < existing.length || !existsSync(eff)) {
      writeFileSync(eff, trimmed.map((p) => JSON.stringify(p)).join("\n") + "\n", "utf8");
    } else {
      appendFileSync(eff, JSON.stringify(obs) + "\n", "utf8");
    }
  } catch (e) {
    console.warn(`[price-history] append failed (${(e as Error).message})`);
  }
};

/** Sign of the net price change over the lookback window: +1 rising, −1 falling, 0 flat/insufficient. */
export const trendDirection = (history: PriceObs[], nowMs: number, lookbackMs = 6 * 3_600_000): 1 | -1 | 0 => {
  const pts = history.filter((p) => p.tsMs >= nowMs - lookbackMs).sort((a, b) => a.tsMs - b.tsMs);
  if (pts.length < 2) return 0;
  const chg = pts[pts.length - 1].priceUsd - pts[0].priceUsd;
  return chg > 0 ? 1 : chg < 0 ? -1 : 0;
};

export type LiveRegimeConfig = { lookbackMs?: number; minSamples?: number };
export type LiveRegimeSignal = { gaugePct: number; volPct: number; momentumPct: number; samples: number };

/**
 * Leading regime gauge from recent oracle prices, in DAILY-% terms:
 *   • volPct       — realized vol of intra-window returns, scaled to a day
 *   • momentumPct  — the |net move| over the window, scaled to a day (catches a steady trend, which has
 *                    low return-dispersion but a large directional move)
 *   • gaugePct     — max(vol, momentum): trips on either chop or trend
 * Returns null until there are enough samples in the window (don't act on noise).
 */
export const computeLiveRegimeSignal = (history: PriceObs[], nowMs: number, cfg: LiveRegimeConfig = {}): LiveRegimeSignal | null => {
  const lookbackMs = cfg.lookbackMs ?? 6 * 3_600_000; // 6h
  const minSamples = cfg.minSamples ?? 4;
  const pts = history.filter((p) => p.tsMs >= nowMs - lookbackMs).sort((a, b) => a.tsMs - b.tsMs);
  if (pts.length < minSamples) return null;

  const rets: number[] = [];
  const dts: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    rets.push(Math.log(pts[i].priceUsd / pts[i - 1].priceUsd));
    dts.push(pts[i].tsMs - pts[i - 1].tsMs);
  }
  const medianDt = Math.max(1, median(dts));
  const volDaily = std(rets) * Math.sqrt(DAY_MS / medianDt);

  const spanMs = Math.max(1, pts[pts.length - 1].tsMs - pts[0].tsMs);
  const move = Math.abs(pts[pts.length - 1].priceUsd / pts[0].priceUsd - 1);
  const momentumDaily = move * Math.sqrt(DAY_MS / spanMs);

  return {
    gaugePct: +(Math.max(volDaily, momentumDaily) * 100).toFixed(3),
    volPct: +(volDaily * 100).toFixed(3),
    momentumPct: +(momentumDaily * 100).toFixed(3),
    samples: pts.length
  };
};
