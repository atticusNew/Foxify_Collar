/**
 * Live (real-money) pair P&L rollup.
 *
 * The loss-leader scorecard (lossLeaderScorecard.ts → getRealizedShadowStats) is
 * hard-filtered to is_shadow = TRUE, so LIVE pairs never appear there. This module
 * is the live-money counterpart: it aggregates settled is_shadow = FALSE pairs into
 * cumulative cost / salvage / Foxify net / Atticus share, splits wins vs losses, and
 * lists each pair (including ones reconciled out-of-band via reconcile-settle,
 * flagged reconciled:true).
 *
 * Net per pair = foxify_share_usdc − hedge_cost_total_usdc (Foxify's true net, per
 * computeSplit). Atticus share is surfaced separately (Atticus only collects on
 * uplift-positive paths).
 */

import type { Pool, PoolClient } from "pg";

export type LivePnlPair = {
  pair_id_short: string;
  pair_id: string;
  cell_id: string;
  hedge_cost_total_usdc: number;
  salvage_proceeds_usdc: number;
  foxify_share_usdc: number;
  atticus_share_usdc: number;
  uplift_usdc: number;
  foxify_net_usdc: number;
  exit_mode: string | null;
  closed_reason: string | null;
  reconciled: boolean;
  created_at: string | null;
  closed_at: string | null;
};

export type LivePnlBucket = { count: number; sum_usdc: number; avg_usdc: number };

export type LivePnlCell = {
  cell_id: string;
  n: number;
  total_cost_usdc: number;
  total_salvage_usdc: number;
  foxify_net_usdc: number;
  atticus_share_usdc: number;
  pct_profitable: number;
};

export type LivePnl = {
  cells: string[] | null;
  since_iso: string | null;
  overall: {
    n: number;
    total_cost_usdc: number;
    total_salvage_usdc: number;
    foxify_net_usdc: number;
    atticus_share_usdc: number;
    pct_profitable: number;
    wins: LivePnlBucket;
    losses: LivePnlBucket;
  };
  per_cell: LivePnlCell[];
  pairs: LivePnlPair[];
  interpretation: string;
};

const round2 = (x: number): number => +x.toFixed(2);
const sum = (a: number[]): number => a.reduce((s, x) => s + x, 0);
const bucket = (nets: number[]): LivePnlBucket => ({
  count: nets.length,
  sum_usdc: round2(sum(nets)),
  avg_usdc: round2(nets.length ? sum(nets) / nets.length : 0)
});

export const computeLivePnl = async (
  pool: Pool | PoolClient,
  opts: { cells?: string[]; sinceIso?: string } = {}
): Promise<LivePnl> => {
  // NOTE: cell filtering is applied in JS (below), not via SQL `= ANY($array)` —
  // pg-mem does not bind array params reliably, and the live-pair set is tiny.
  const clauses = ["status = 'settled'", "is_shadow = FALSE", "foxify_share_usdc IS NOT NULL"];
  const params: unknown[] = [];
  if (opts.sinceIso) {
    params.push(opts.sinceIso);
    clauses.push(`created_at >= $${params.length}`);
  }
  const cellFilter = opts.cells && opts.cells.length > 0 ? new Set(opts.cells) : null;
  const r = await pool.query<{
    pair_id: string;
    cell_id: string;
    hedge_cost_total_usdc: string;
    salvage_proceeds_usdc: string | null;
    foxify_share_usdc: string | null;
    atticus_share_usdc: string | null;
    uplift_usdc: string | null;
    exit_mode: string | null;
    closed_reason: string | null;
    created_at: string | null;
    closed_at: string | null;
    metadata: unknown;
  }>(
    `SELECT pair_id, cell_id, hedge_cost_total_usdc, salvage_proceeds_usdc,
            foxify_share_usdc, atticus_share_usdc, uplift_usdc, exit_mode,
            closed_reason, created_at, closed_at, metadata
       FROM two_sided_pair
      WHERE ${clauses.join(" AND ")}
      ORDER BY closed_at ASC NULLS LAST, created_at ASC`,
    params
  );

  const filteredRows = cellFilter ? r.rows.filter((row) => cellFilter.has(row.cell_id)) : r.rows;
  const pairs: LivePnlPair[] = filteredRows.map((row) => {
    const cost = Number(row.hedge_cost_total_usdc);
    const salvage = row.salvage_proceeds_usdc == null ? 0 : Number(row.salvage_proceeds_usdc);
    const foxifyShare = row.foxify_share_usdc == null ? 0 : Number(row.foxify_share_usdc);
    const atticusShare = row.atticus_share_usdc == null ? 0 : Number(row.atticus_share_usdc);
    const uplift = row.uplift_usdc == null ? salvage - cost : Number(row.uplift_usdc);
    const mdRaw = row.metadata;
    const md = (typeof mdRaw === "string"
      ? (() => { try { return JSON.parse(mdRaw); } catch { return {}; } })()
      : (mdRaw ?? {})) as { reconciled?: boolean };
    return {
      pair_id_short: row.pair_id.slice(0, 8),
      pair_id: row.pair_id,
      cell_id: row.cell_id,
      hedge_cost_total_usdc: round2(cost),
      salvage_proceeds_usdc: round2(salvage),
      foxify_share_usdc: round2(foxifyShare),
      atticus_share_usdc: round2(atticusShare),
      uplift_usdc: round2(uplift),
      foxify_net_usdc: round2(foxifyShare - cost),
      exit_mode: row.exit_mode,
      closed_reason: row.closed_reason,
      reconciled: md.reconciled === true,
      created_at: row.created_at,
      closed_at: row.closed_at
    };
  });

  const nets = pairs.map((p) => p.foxify_net_usdc);
  const wins = nets.filter((x) => x > 0);
  const losses = nets.filter((x) => x <= 0);
  const n = pairs.length;
  const totalCost = round2(sum(pairs.map((p) => p.hedge_cost_total_usdc)));
  const totalSalvage = round2(sum(pairs.map((p) => p.salvage_proceeds_usdc)));
  const foxifyNet = round2(sum(nets));
  const atticusTotal = round2(sum(pairs.map((p) => p.atticus_share_usdc)));

  // Per-cell rollup
  const cellMap = new Map<string, LivePnlPair[]>();
  for (const p of pairs) {
    const arr = cellMap.get(p.cell_id) ?? [];
    arr.push(p);
    cellMap.set(p.cell_id, arr);
  }
  const perCell: LivePnlCell[] = Array.from(cellMap.entries()).map(([cellId, ps]) => {
    const cnets = ps.map((p) => p.foxify_net_usdc);
    const cw = cnets.filter((x) => x > 0);
    return {
      cell_id: cellId,
      n: ps.length,
      total_cost_usdc: round2(sum(ps.map((p) => p.hedge_cost_total_usdc))),
      total_salvage_usdc: round2(sum(ps.map((p) => p.salvage_proceeds_usdc))),
      foxify_net_usdc: round2(sum(cnets)),
      atticus_share_usdc: round2(sum(ps.map((p) => p.atticus_share_usdc))),
      pct_profitable: ps.length ? +(cw.length / ps.length).toFixed(4) : 0
    };
  });

  const sign = (x: number): string => (x >= 0 ? "+" : "");
  const reconciledCount = pairs.filter((p) => p.reconciled).length;
  const interpretation = n === 0
    ? "No settled LIVE (real-money) pairs yet. Once a live pair settles (or is reconciled via reconcile-settle), it shows here."
    : `${n} settled live pair(s)${reconciledCount ? ` (${reconciledCount} reconciled out-of-band)` : ""}: ` +
      `cost $${totalCost}, salvage $${totalSalvage}, Foxify net ${sign(foxifyNet)}$${foxifyNet} ` +
      `(${wins.length} win(s) / ${losses.length} loss(es)); Atticus share $${atticusTotal}. ` +
      `These are REAL pairs (is_shadow=false) and are NOT in the loss-leader (shadow) scorecard.`;

  return {
    cells: opts.cells && opts.cells.length > 0 ? opts.cells : null,
    since_iso: opts.sinceIso ?? null,
    overall: {
      n,
      total_cost_usdc: totalCost,
      total_salvage_usdc: totalSalvage,
      foxify_net_usdc: foxifyNet,
      atticus_share_usdc: atticusTotal,
      pct_profitable: n ? +(wins.length / n).toFixed(4) : 0,
      wins: bucket(wins),
      losses: bucket(losses)
    },
    per_cell: perCell,
    pairs,
    interpretation
  };
};
