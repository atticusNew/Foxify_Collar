/**
 * Breakeven win-rate — the single most decision-relevant number: for each structure (in a
 * regime, with/without frictions), what is the MINIMUM directional hit-rate Foxify needs
 * for it to be +EV? Sweeps win_rate and interpolates where mc_mean_net crosses 0.
 *
 * Read-only research. Reuses compareStructures (which is itself read-only) at a grid of
 * win-rates. Lower breakeven = easier to clear = better. ≤0.50 ⇒ +EV with no edge at all.
 */

import type { Pool } from "pg";
import type { Regime } from "./featureFlag";
import { compareStructures } from "./structureComparison";
import type { OptionStructure } from "./optionStructures";
import type { SweepVenue } from "./cellSweep";
import type { LiquidChainCache } from "./liquidChainCache";
import type { DvolService } from "./dvolService";

export type BreakevenRow = {
  structure: OptionStructure;
  /** Min win-rate for +EV (interpolated). null = not +EV anywhere in the grid (needs > max). */
  breakeven_win_rate: number | null;
  /** "≤0.50" when +EV even with no edge. */
  plus_ev_without_edge: boolean;
  net_by_win_rate: Array<{ win_rate: number; mc_net: number | null }>;
};

export type BreakevenReport = {
  as_of: string;
  cell_id: string;
  regime: Regime;
  frictionless: boolean;
  win_rate_grid: number[];
  rows: BreakevenRow[];
  note: string;
};

export const computeBreakevenWinRates = async (
  pool: Pool,
  opts: {
    cellId: string;
    regime: Regime;
    spot: number;
    liquidChainCache: LiquidChainCache;
    dvolService?: DvolService | null;
    venue?: SweepVenue;
    nPaths?: number;
    frictionless?: boolean;
    winRates?: number[];
    nowMs?: number;
  }
): Promise<BreakevenReport> => {
  const grid = opts.winRates ?? [0.50, 0.525, 0.55, 0.575, 0.60, 0.625, 0.65];
  const nPaths = opts.nPaths ?? 1000; // lighter — this runs the full comparison once per grid point
  const series = new Map<OptionStructure, Array<{ wr: number; net: number | null }>>();

  for (const wr of grid) {
    const rep = await compareStructures(pool, {
      cellId: opts.cellId, regime: opts.regime, spot: opts.spot,
      liquidChainCache: opts.liquidChainCache, dvolService: opts.dvolService ?? null,
      venue: opts.venue, nPaths, frictionless: opts.frictionless === true,
      directionalWinRate: wr, nowMs: opts.nowMs
    });
    for (const row of rep.rows) {
      const arr = series.get(row.structure) ?? [];
      arr.push({ wr, net: row.mc_mean_net_usdc });
      series.set(row.structure, arr);
    }
  }

  const rows: BreakevenRow[] = [...series.entries()].map(([structure, pts]) => {
    let breakeven: number | null = null;
    let plusEvNoEdge = false;
    for (let i = 0; i < pts.length; i++) {
      const { wr, net } = pts[i];
      if (net == null) continue;
      if (net >= 0) {
        if (i === 0) { breakeven = wr; plusEvNoEdge = true; }
        else {
          const prev = pts[i - 1];
          if (prev.net != null && prev.net < 0 && net !== prev.net) {
            const t = (0 - prev.net) / (net - prev.net); // linear interp to the zero crossing
            breakeven = +(prev.wr + t * (wr - prev.wr)).toFixed(4);
          } else breakeven = wr;
        }
        break;
      }
    }
    return {
      structure,
      breakeven_win_rate: breakeven,
      plus_ev_without_edge: plusEvNoEdge,
      net_by_win_rate: pts.map((p) => ({ win_rate: p.wr, mc_net: p.net }))
    };
  });

  return {
    as_of: new Date(opts.nowMs ?? Date.now()).toISOString(),
    cell_id: opts.cellId,
    regime: opts.regime,
    frictionless: opts.frictionless === true,
    win_rate_grid: grid,
    rows,
    note: "breakeven_win_rate = MIN directional hit-rate for +EV (lower = easier). plus_ev_without_edge=true ⇒ +EV even at 50/50. null ⇒ needs more edge than the grid max. This is the bar Foxify's real directional accuracy must clear."
  };
};
