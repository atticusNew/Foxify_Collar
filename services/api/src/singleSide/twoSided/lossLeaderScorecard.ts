/**
 * Calm loss-leader CUMULATIVE PnL scorecard.
 *
 * The right way to judge a long-CONVEXITY loss-leader is NOT the per-window
 * within-15% reconciliation gate (that flags "false" on every real move, since
 * the MC models calm-continuation). It's the CUMULATIVE realized PnL over many
 * settled pairs: does the occasional convexity win (a real BTC move pushing the
 * OTM legs ITM) outweigh the steady calm bleed (premium decaying to zero when
 * nothing happens)?
 *
 * This aggregates settled SHADOW loss-leader pairs into:
 *   - cumulative net, mean net/pair, % profitable
 *   - WINS (convexity payoffs) vs LOSSES (calm bleed), split out so the
 *     "bleed vs payoff" economics are explicit
 *   - per-cell + overall, organic-only by default (excludes force-triggered/test)
 *
 * Realized net per pair = foxify_share_usdc − hedge_cost_total_usdc (Foxify's true
 * net, per computeSplit), sourced from getRealizedShadowStats.
 */

import type { Pool, PoolClient } from "pg";
import type { Regime } from "./featureFlag";
import { getRealizedShadowStats } from "./realizedVsMc";
import { CALM_LOSS_LEADER_CELLS } from "./cellConfig";

export type SplitBucket = { count: number; sum_usdc: number; avg_usdc: number };

export type CellScorecard = {
  cell_id: string;
  n: number;
  cumulative_net_usdc: number;
  mean_net_usdc: number;
  pct_profitable: number;
  mean_cost_usdc: number;
  wins: SplitBucket;
  losses: SplitBucket;
  exit_modes: Record<string, number>;
};

export type LossLeaderScorecard = {
  cells: string[];
  organic_only: boolean;
  regime: Regime | null;
  overall: {
    n: number;
    cumulative_net_usdc: number;
    mean_net_usdc: number;
    pct_profitable: number;
    wins: SplitBucket;
    losses: SplitBucket;
  };
  per_cell: CellScorecard[];
  interpretation: string;
};

const round2 = (x: number): number => +x.toFixed(2);
const sum = (a: number[]): number => a.reduce((s, x) => s + x, 0);
const bucket = (nets: number[]): SplitBucket => ({
  count: nets.length,
  sum_usdc: round2(sum(nets)),
  avg_usdc: round2(nets.length ? sum(nets) / nets.length : 0)
});

export const computeLossLeaderScorecard = async (
  pool: Pool | PoolClient,
  opts: { cells?: string[]; regime?: Regime; organicOnly?: boolean } = {}
): Promise<LossLeaderScorecard> => {
  const cells = opts.cells && opts.cells.length > 0 ? opts.cells : [...CALM_LOSS_LEADER_CELLS];
  const organicOnly = opts.organicOnly ?? true;

  const { stats } = await getRealizedShadowStats(pool, {
    regime: opts.regime,
    returnSamples: true,
    organicOnly
  });
  const byCell = new Map(stats.map((s) => [s.cellId, s]));

  const allNets: number[] = [];
  const perCell: CellScorecard[] = cells.map((cellId) => {
    const s = byCell.get(cellId);
    const nets = s?.nets ?? [];
    allNets.push(...nets);
    const wins = nets.filter((x) => x > 0);
    const losses = nets.filter((x) => x <= 0);
    return {
      cell_id: cellId,
      n: nets.length,
      cumulative_net_usdc: round2(sum(nets)),
      mean_net_usdc: round2(nets.length ? sum(nets) / nets.length : 0),
      pct_profitable: nets.length ? +(wins.length / nets.length).toFixed(4) : 0,
      mean_cost_usdc: s?.meanCostUsdc ?? 0,
      wins: bucket(wins),
      losses: bucket(losses),
      exit_modes: s?.exitModeCounts ?? {}
    };
  });

  const wins = allNets.filter((x) => x > 0);
  const losses = allNets.filter((x) => x <= 0);
  const n = allNets.length;
  const cumNet = round2(sum(allNets));
  const overall = {
    n,
    cumulative_net_usdc: cumNet,
    mean_net_usdc: round2(n ? sum(allNets) / n : 0),
    pct_profitable: n ? +(wins.length / n).toFixed(4) : 0,
    wins: bucket(wins),
    losses: bucket(losses)
  };

  const sign = (x: number): string => (x >= 0 ? "+" : "");
  const interpretation = n === 0
    ? "No settled organic loss-leader pairs yet — let shadow accrue, then re-check."
    : `${n} settled organic loss-leader pair(s): cumulative net ${sign(cumNet)}$${cumNet} ` +
      `(${overall.wins.count} convexity win(s) totaling +$${overall.wins.sum_usdc} vs ` +
      `${overall.losses.count} calm-bleed loss(es) totaling $${overall.losses.sum_usdc}); ` +
      `net/pair ${sign(overall.mean_net_usdc)}$${overall.mean_net_usdc}. ` +
      (cumNet >= 0
        ? "Convexity is currently COVERING the calm bleed — but judge over MANY pairs + multiple regimes; a single move can dominate a small sample."
        : "Calm bleed currently EXCEEDS convexity wins — expected when few real moves have occurred; needs more pairs/moves before concluding net EV.");

  return { cells, organic_only: organicOnly, regime: opts.regime ?? null, overall, per_cell: perCell, interpretation };
};
