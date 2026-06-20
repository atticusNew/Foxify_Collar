/**
 * Basis guard — Phase A (pure, offline, default-off). The barrier fires on Atticus's oracle, but the
 * trader's perp closes on a PARTNER exchange. If those prices diverge (basis), protection and the
 * realized close mismatch. The fix is to (a) include the partner-exchange marks in the oracle sources
 * so the barrier is measured where Foxify actually trades, and (b) refuse to settle when basis is too
 * wide. This module measures basis and converts partner marks into oracle samples. Pure.
 */

import type { PriceSample } from "./referenceOracle";

export type VenueMark = { venue: string; priceUsd: number; tsMs?: number };

/** Signed basis of a partner mark vs the oracle reference, in bps. Pure. */
export const computeBasisBps = (oraclePriceUsd: number, markUsd: number): number =>
  oraclePriceUsd > 0 ? +(((markUsd - oraclePriceUsd) / oraclePriceUsd) * 1e4).toFixed(4) : 0;

export type BasisAssessment = {
  perVenue: Array<{ venue: string; markUsd: number; basisBps: number }>;
  maxAbsBasisBps: number;
  withinTolerance: boolean;
  safeToSettle: boolean;        // false ⟹ basis too wide; defer settlement (fail-closed)
};

/**
 * Assess basis between the oracle reference price and each partner-exchange mark. If the worst
 * absolute basis exceeds maxAbsBasisBps, settlement is NOT safe (defer rather than settle on a price
 * that diverges from where Foxify executed). Pure.
 */
export const assessBasis = (oraclePriceUsd: number, marks: VenueMark[], maxAbsBasisBps: number): BasisAssessment => {
  const perVenue = marks.map((m) => ({ venue: m.venue, markUsd: m.priceUsd, basisBps: computeBasisBps(oraclePriceUsd, m.priceUsd) }));
  const maxAbs = perVenue.reduce((mx, v) => Math.max(mx, Math.abs(v.basisBps)), 0);
  const within = maxAbs <= maxAbsBasisBps;
  return { perVenue, maxAbsBasisBps: +maxAbs.toFixed(4), withinTolerance: within, safeToSettle: within };
};

/**
 * Convert partner-exchange marks into oracle PriceSamples so they participate in the median/TWAP — the
 * barrier is then measured WHERE FOXIFY EXECUTES, which collapses basis at the source. Stale-tagged by
 * the oracle's own freshness check via tsMs.
 */
export const partnerMarksToSamples = (marks: VenueMark[], nowMs: number): PriceSample[] =>
  marks
    .filter((m) => Number.isFinite(m.priceUsd) && m.priceUsd > 0)
    .map((m) => ({ source: `partner:${m.venue}`, priceUsd: m.priceUsd, tsMs: m.tsMs ?? nowMs }));
