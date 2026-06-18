/**
 * Self-cancellation detector — Phase A (pure, offline).
 *
 * Correction from Phase 0 review (Q2): a per-position, matched-side collar is only correct if
 * Foxify runs SEQUENTIAL-DIRECTIONAL flow (long now, short later). If Foxify ever runs SIMULTANEOUS
 * offsetting long+short on the SAME asset (which a "delta-neutral book" can imply), per-position
 * collars on both legs largely cancel into a paid-for strangle/anti-strangle: Foxify pays two
 * spreads (Atticus margins) for ~no net protection. In that case the collar must reference the
 * NET BOOK DELTA, not the individual position.
 *
 * This module does NOT decide Foxify's flow (that's an external confirmation, gated). It detects,
 * for a given snapshot of positions, whether per-position collaring would be degenerate, and
 * recommends the correct reference mode. It is the guardrail that stops us from silently assuming.
 */

export type PerpPosition = {
  asset: string;
  side: "long" | "short";
  notionalUsdc: number;
};

export type SelfCancellationReport = {
  asset: string;
  longNotionalUsdc: number;
  shortNotionalUsdc: number;
  grossNotionalUsdc: number;
  netNotionalUsdc: number;        // signed: + = net long, − = net short
  /** offsetting fraction = min(long,short)/max(long,short) on the asset (0 = directional, 1 = fully offset). */
  offsetRatio: number;
  /** True when per-position collars would largely cancel and waste spread. */
  selfCancels: boolean;
  recommendedReferenceMode: "position" | "net_book_delta";
  reason: string;
};

export type SelfCancellationConfig = {
  /** Offset ratio above which per-position collaring is deemed degenerate (default 0.25). */
  offsetThreshold?: number;
};

/**
 * Analyze positions per-asset for offsetting exposure. Returns one report per asset plus an overall
 * recommendation. Pure + deterministic.
 */
export const detectSelfCancellation = (
  positions: PerpPosition[],
  config: SelfCancellationConfig = {}
): { perAsset: SelfCancellationReport[]; anySelfCancels: boolean; recommendedReferenceMode: "position" | "net_book_delta" } => {
  const offsetThreshold = config.offsetThreshold != null && config.offsetThreshold >= 0 ? config.offsetThreshold : 0.25;

  const byAsset = new Map<string, { long: number; short: number }>();
  for (const p of positions) {
    if (!(p.notionalUsdc > 0)) continue;
    const cur = byAsset.get(p.asset) ?? { long: 0, short: 0 };
    if (p.side === "long") cur.long += p.notionalUsdc;
    else cur.short += p.notionalUsdc;
    byAsset.set(p.asset, cur);
  }

  const perAsset: SelfCancellationReport[] = [];
  for (const [asset, { long, short }] of byAsset) {
    const gross = long + short;
    const net = long - short;
    const maxLeg = Math.max(long, short);
    const minLeg = Math.min(long, short);
    const offsetRatio = maxLeg > 0 ? minLeg / maxLeg : 0;
    const selfCancels = offsetRatio >= offsetThreshold;
    perAsset.push({
      asset,
      longNotionalUsdc: +long.toFixed(2),
      shortNotionalUsdc: +short.toFixed(2),
      grossNotionalUsdc: +gross.toFixed(2),
      netNotionalUsdc: +net.toFixed(2),
      offsetRatio: +offsetRatio.toFixed(4),
      selfCancels,
      recommendedReferenceMode: selfCancels ? "net_book_delta" : "position",
      reason: selfCancels
        ? `offset ratio ${(offsetRatio * 100).toFixed(0)}% ≥ ${(offsetThreshold * 100).toFixed(0)}%: per-position collars would cancel; reference net book delta`
        : `offset ratio ${(offsetRatio * 100).toFixed(0)}% < ${(offsetThreshold * 100).toFixed(0)}%: directional; per-position collar is correct`
    });
  }

  const anySelfCancels = perAsset.some((r) => r.selfCancels);
  return {
    perAsset,
    anySelfCancels,
    recommendedReferenceMode: anySelfCancels ? "net_book_delta" : "position"
  };
};
