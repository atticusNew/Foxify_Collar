/**
 * Venue-routing recommendation — Phase A (pure, offline). SOFT cost-optimization: prefer Bullish
 * (relationship/rebate, configurable weight) but route to Deribit/OKX where materially cheaper.
 * NO hard Bullish-share gate. Operates on the captured wing half-spreads.
 */

import type { Venue, WingSpreadRow } from "./capture";

export type RoutingConfig = {
  /** Bullish cost discount in [0,1] reflecting relationship/rebate (e.g. 0.15 = treat Bullish 15% cheaper). */
  bullishWeight: number;
  /** Only switch away from Bullish if an alternative is cheaper than Bullish by > this margin (after weight). */
  materialMarginPct: number;
};

export type LegRouting = {
  wing: "floor_put" | "cap_call";
  tenorDays: number;
  candidates: Array<{ venue: Venue; halfSpreadRelMid: number | null; effectiveCost: number | null }>;
  chosenVenue: Venue | null;
  reason: string;
};

const effective = (venue: Venue, halfSpreadRelMid: number | null, cfg: RoutingConfig): number | null =>
  halfSpreadRelMid == null ? null : halfSpreadRelMid * (venue === "bullish" ? 1 - cfg.bullishWeight : 1);

/**
 * Recommend a venue per leg for a given tenor: cheapest effective half-spread, with Bullish weighted
 * down and only displaced when an alternative is materially cheaper. Pure.
 */
export const recommendRouting = (
  wingRows: WingSpreadRow[],
  tenorDays: number,
  cfg: RoutingConfig,
  tenorTolDays = 0.75
): LegRouting[] => {
  const out: LegRouting[] = [];
  for (const wing of ["floor_put", "cap_call"] as const) {
    // Take, per venue, the wing row nearest the requested tenor (median moneyness target).
    const byVenue = new Map<Venue, WingSpreadRow>();
    for (const r of wingRows) {
      if (r.wing !== wing) continue;
      if (Math.abs(r.tenorDays - tenorDays) > tenorTolDays) continue;
      const prev = byVenue.get(r.venue);
      if (!prev || (r.halfSpreadRelMid ?? Infinity) < (prev.halfSpreadRelMid ?? Infinity)) byVenue.set(r.venue, r);
    }
    const candidates = [...byVenue.entries()].map(([venue, r]) => ({
      venue,
      halfSpreadRelMid: r.halfSpreadRelMid,
      effectiveCost: effective(venue, r.halfSpreadRelMid, cfg)
    }));
    const priced = candidates.filter((c) => c.effectiveCost != null) as Array<{ venue: Venue; halfSpreadRelMid: number; effectiveCost: number }>;

    let chosen: Venue | null = null;
    let reason = "no priced venue for this leg/tenor";
    if (priced.length > 0) {
      const bullish = priced.find((c) => c.venue === "bullish");
      const cheapest = [...priced].sort((a, b) => a.effectiveCost - b.effectiveCost)[0];
      if (bullish && cheapest.venue !== "bullish") {
        const margin = (bullish.effectiveCost - cheapest.effectiveCost) / Math.max(1e-9, bullish.effectiveCost);
        if (margin > cfg.materialMarginPct) {
          chosen = cheapest.venue;
          reason = `${cheapest.venue} materially cheaper than Bullish (${(margin * 100).toFixed(0)}% > ${(cfg.materialMarginPct * 100).toFixed(0)}% after ${(cfg.bullishWeight * 100).toFixed(0)}% Bullish weight)`;
        } else {
          chosen = "bullish";
          reason = `Bullish kept (alternative only ${(margin * 100).toFixed(0)}% cheaper, within material margin)`;
        }
      } else {
        chosen = cheapest.venue;
        reason = cheapest.venue === "bullish" ? "Bullish cheapest (after weight)" : "only/cheapest venue";
      }
    }

    out.push({
      wing,
      tenorDays,
      candidates: candidates.map((c) => ({
        venue: c.venue,
        halfSpreadRelMid: c.halfSpreadRelMid,
        effectiveCost: c.effectiveCost != null ? +c.effectiveCost.toFixed(5) : null
      })),
      chosenVenue: chosen,
      reason
    });
  }
  return out;
};
