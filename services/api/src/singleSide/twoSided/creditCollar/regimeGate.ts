/**
 * Regime-aware opening gate (pure). A short-vol book bleeds when price TRAVELS far in 24h — a sustained
 * trend or a high-vol chop. The direct predictor of cap breaches is the MAGNITUDE of the 24h move (a
 * steady trend has *low* move-dispersion but large moves, so stdev is the wrong gauge — we use the trailing
 * average |24h move|). When that's elevated we widen the cap (deeper floor) and throttle the open rate;
 * when it's extreme we pause new opens and sit the regime out. Calm regimes ⟹ open normally and harvest
 * the credit. This is the "signal" that lets the strategy work across regimes instead of only in calm tape.
 */

export type RegimeGateConfig = {
  enabled: boolean;
  /** Recent settled positions to gauge the regime from. Default 40. */
  lookback?: number;
  /** Below this many samples, don't gate (avoid acting on noise). Default 10. */
  minSamples?: number;
  /** Trailing avg |24h move| (in %) at/above which we WIDEN + throttle. Default 1.5. */
  elevatedVolPct?: number;
  /** Trailing avg |24h move| (in %) at/above which we PAUSE new opens. Default 3.0. */
  haltVolPct?: number;
  /** Open-rate multiplier when elevated (0..1). Default 0.5. */
  elevatedOpenMultiplier?: number;
  /** Deeper floor (⟹ wider cap) to use when elevated/halt. Default 0.10. */
  elevatedFloorPct?: number;
  /** Leading signal: lookback window (ms) over live oracle prices. Default 6h. */
  liveLookbackMs?: number;
  /** Leading signal: min live samples in the window before it's used. Default 4. */
  liveMinSamples?: number;
  /**
   * HYSTERESIS: once a stricter regime is entered, it only exits when the gauge falls BELOW
   * threshold × this ratio (default 0.85). Stops the gate flickering calm↔elevated on noise when the
   * gauge hovers at the line (e.g. enter elevated at 1.2%, exit only below ~1.02%).
   */
  hysteresisExitRatio?: number;
};

export type RegimeGateDecision = {
  regime: "calm" | "elevated" | "halt";
  realizedMovePct: number; // the EFFECTIVE gauge used = max(trailing, live), in %
  trailingMovePct: number; // trailing avg |24h move| from settled positions (lags ~12–24h)
  liveMovePct: number | null; // leading gauge from live oracle prices (same-cycle), null if unavailable
  signalSource: "trailing" | "live"; // which one drove the decision
  samples: number;
  openMultiplier: number; // scale applied to the cycle's opens (1 calm · <1 elevated · 0 halt)
  floorPctOverride: number | null; // deeper floor when elevated/halt (wider cap), else null
  reason: string;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/**
 * Evaluate the gate. `recentAbsMovePcts` is the TRAILING signal (settled |24h moves|, as fractions).
 * `liveGaugePct` is the optional LEADING gauge from live oracle prices (already in %). The gate acts on
 * the MORE conservative (higher) of the two, so it catches a developing regime from live prices even
 * before positions settle, and still respects the realized trailing move.
 *
 * `prevRegime` enables HYSTERESIS: entering a stricter regime uses the normal thresholds, but exiting
 * requires the gauge to fall below threshold × hysteresisExitRatio — so a gauge hovering at the line
 * (e.g. 1.19 ↔ 1.21) can't flicker the strategy on and off each cycle.
 */
export const evaluateRegimeGate = (
  recentAbsMovePcts: number[],
  cfg: RegimeGateConfig,
  liveGaugePct?: number | null,
  prevRegime?: RegimeGateDecision["regime"] | null
): RegimeGateDecision => {
  const minSamples = cfg.minSamples ?? 10;
  const elevated = cfg.elevatedVolPct ?? 1.5;
  const halt = cfg.haltVolPct ?? 3.0;
  const elevMult = cfg.elevatedOpenMultiplier ?? 0.5;
  const elevFloor = cfg.elevatedFloorPct ?? 0.1;
  const exitRatio = cfg.hysteresisExitRatio ?? 0.85;

  const samples = recentAbsMovePcts.length;
  const trailingPct = +(mean(recentAbsMovePcts) * 100).toFixed(3); // moves are fractions ⟹ ×100 for %
  const live = liveGaugePct != null && Number.isFinite(liveGaugePct) ? +liveGaugePct.toFixed(3) : null;
  const trailingUsable = samples >= minSamples; // trailing needs enough settled samples; live is usable as soon as present

  // Effective gauge = max of the usable signals. Live works even before positions settle (warm-up).
  const candidates: number[] = [];
  if (trailingUsable) candidates.push(trailingPct);
  if (live != null) candidates.push(live);
  const effective = candidates.length ? Math.max(...candidates) : 0;
  const source: "trailing" | "live" = live != null && effective === live ? "live" : "trailing";
  const base = { realizedMovePct: effective, trailingMovePct: trailingPct, liveMovePct: live, signalSource: source, samples };

  if (!cfg.enabled || candidates.length === 0) {
    return { ...base, regime: "calm", openMultiplier: 1, floorPctOverride: null, reason: !cfg.enabled ? "gate disabled" : `warming up (trailing ${samples}/${minSamples}, no live signal yet)` };
  }
  const src = `${source} avg |move| ${effective}%`;
  // Sticky exits: a regime already entered only releases below threshold × exitRatio.
  const haltBar = prevRegime === "halt" ? halt * exitRatio : halt;
  const elevBar = prevRegime === "halt" || prevRegime === "elevated" ? elevated * exitRatio : elevated;
  const sticky = (bar: number, enter: number) => (bar < enter ? ` (hysteresis: exit below ${+bar.toFixed(3)}%)` : "");

  if (effective >= haltBar) {
    return { ...base, regime: "halt", openMultiplier: 0, floorPctOverride: elevFloor, reason: `${src} ≥ halt ${+haltBar.toFixed(3)}%${sticky(haltBar, halt)} — pause new opens (sit out the trend)` };
  }
  if (effective >= elevBar) {
    return { ...base, regime: "elevated", openMultiplier: elevMult, floorPctOverride: elevFloor, reason: `${src} ≥ elevated ${+elevBar.toFixed(3)}%${sticky(elevBar, elevated)} — widen cap (floor ${elevFloor}) + throttle opens ×${elevMult}` };
  }
  return { ...base, regime: "calm", openMultiplier: 1, floorPctOverride: null, reason: `${src} < elevated ${+elevBar.toFixed(3)}% — open normally, harvest credit` };
};
