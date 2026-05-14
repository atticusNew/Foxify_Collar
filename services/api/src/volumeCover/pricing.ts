/**
 * Volume Cover pricing — resolves the daily premium for a cell.
 *
 * For MVP, premium is the matrix base value with no regime overlay.
 * This is intentional: the salvage-band stress test validated the base
 * matrix prices against {calm, normal, stress} regime mixes already, so
 * regime-conditional pricing is not needed for the pilot. Regime overlay
 * can be added post-pilot if salvage data warrants.
 *
 * Operator can override per-cell pricing at runtime via the cell admin
 * toggle (POST /volume-cover/admin/cells/:cellId/toggle), which writes
 * to the volume_cover_cell.daily_premium_usdc column. The runtime
 * premium read from DB takes precedence over the matrix base value.
 */

import type { CellDefinition } from "./matrix";

export type PremiumQuote = {
  cellId: string;
  dailyPremiumUsdc: number;
  payoutUsdc: number;
  source: "matrix_base" | "db_override";
};

/**
 * Resolve the premium to charge. If `dbOverrideDailyPremiumUsdc` is
 * provided (from the volume_cover_cell row), it takes precedence.
 * Otherwise, return the matrix base value.
 */
export const resolveDailyPremium = (params: {
  cell: CellDefinition;
  dbOverrideDailyPremiumUsdc?: number | null;
}): PremiumQuote => {
  const useOverride =
    typeof params.dbOverrideDailyPremiumUsdc === "number" &&
    Number.isFinite(params.dbOverrideDailyPremiumUsdc) &&
    params.dbOverrideDailyPremiumUsdc > 0;
  const premium = useOverride
    ? (params.dbOverrideDailyPremiumUsdc as number)
    : params.cell.dailyPremiumUsdc;
  return {
    cellId: params.cell.cellId,
    dailyPremiumUsdc: premium,
    payoutUsdc: params.cell.payoutUsdc,
    source: useOverride ? "db_override" : "matrix_base"
  };
};
