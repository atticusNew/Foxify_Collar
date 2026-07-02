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
};

export type RegimeGateDecision = {
  regime: "calm" | "elevated" | "halt";
  realizedMovePct: number; // trailing avg |24h move|, in %
  samples: number;
  openMultiplier: number; // scale applied to the cycle's opens (1 calm · <1 elevated · 0 halt)
  floorPctOverride: number | null; // deeper floor when elevated/halt (wider cap), else null
  reason: string;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

export const evaluateRegimeGate = (recentAbsMovePcts: number[], cfg: RegimeGateConfig): RegimeGateDecision => {
  const minSamples = cfg.minSamples ?? 10;
  const elevated = cfg.elevatedVolPct ?? 1.5;
  const halt = cfg.haltVolPct ?? 3.0;
  const elevMult = cfg.elevatedOpenMultiplier ?? 0.5;
  const elevFloor = cfg.elevatedFloorPct ?? 0.1;

  const samples = recentAbsMovePcts.length;
  const volPct = +(mean(recentAbsMovePcts) * 100).toFixed(3); // moves are fractions ⟹ ×100 for %

  if (!cfg.enabled || samples < minSamples) {
    return { regime: "calm", realizedMovePct: volPct, samples, openMultiplier: 1, floorPctOverride: null, reason: !cfg.enabled ? "gate disabled" : `warming up (${samples}/${minSamples} samples)` };
  }
  if (volPct >= halt) {
    return { regime: "halt", realizedMovePct: volPct, samples, openMultiplier: 0, floorPctOverride: elevFloor, reason: `avg |24h move| ${volPct}% ≥ halt ${halt}% — pause new opens (sit out the trend)` };
  }
  if (volPct >= elevated) {
    return { regime: "elevated", realizedMovePct: volPct, samples, openMultiplier: elevMult, floorPctOverride: elevFloor, reason: `avg |24h move| ${volPct}% ≥ elevated ${elevated}% — widen cap (floor ${elevFloor}) + throttle opens ×${elevMult}` };
  }
  return { regime: "calm", realizedMovePct: volPct, samples, openMultiplier: 1, floorPctOverride: null, reason: `avg |24h move| ${volPct}% < elevated ${elevated}% — open normally, harvest credit` };
};
