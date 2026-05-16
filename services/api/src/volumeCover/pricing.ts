/**
 * Volume Cover pricing — resolves the daily premium for a cell.
 *
 * Pricing precedence (highest first):
 *   1. Regime overlay env (P3 §13, deployable post Phase 2 sign-off):
 *      VC_REGIME_OVERLAY_JSON='{"50k_2pct_1k":{"moderate":420,"elevated":525,"stress":700}}'
 *      Applied when current regime matches a non-base bucket. Calm is
 *      LOCKED at base per operator commitment 2026-05-16; calm overlay
 *      is intentionally NOT honored — reserved for "head-start" hot-fix
 *      path which goes through DB override (admin cell toggle).
 *   2. DB override (admin cell toggle): per-cell `daily_premium_usdc`
 *      column. Used as the calm-tier "head-start hot-fix" lever.
 *   3. Matrix base value (locked launch price per cell).
 *
 * The result is also potentially scaled by anti-bot Layer 4 surcharge
 * multiplier; that lives in the route layer (not here).
 */

import type { CellDefinition } from "./matrix";
import type { VolRegime } from "./strikeGrid";

export type PremiumQuote = {
  cellId: string;
  dailyPremiumUsdc: number;
  payoutUsdc: number;
  source: "matrix_base" | "db_override" | "regime_overlay";
  regime: VolRegime | null;
  baseDailyPremiumUsdc: number;
};

type OverlayMap = Partial<Record<string, Partial<Record<VolRegime, number>>>>;

let cachedOverlay: { json: string; map: OverlayMap } | null = null;

const readOverlayMap = (): OverlayMap => {
  const raw = process.env.VC_REGIME_OVERLAY_JSON;
  if (!raw || raw.trim() === "") return {};
  // Cache parse result keyed by raw string (so env updates take effect on next read).
  if (cachedOverlay && cachedOverlay.json === raw) return cachedOverlay.map;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    cachedOverlay = { json: raw, map: parsed as OverlayMap };
    return cachedOverlay.map;
  } catch {
    return {};
  }
};

/**
 * Resolve the premium to charge for a quote/activate. Apply the
 * regime overlay if defined for (cell, regime); otherwise DB override;
 * otherwise matrix base.
 *
 * Calm regime intentionally never reads from VC_REGIME_OVERLAY_JSON —
 * calm price is locked at matrix base per operator commitment. To
 * adjust calm (head-start hot-fix), use the DB override path
 * (POST /volume-cover/admin/cells/:cellId/toggle).
 */
export const resolveDailyPremium = (params: {
  cell: CellDefinition;
  dbOverrideDailyPremiumUsdc?: number | null;
  regime?: VolRegime | null;
}): PremiumQuote => {
  const baseDailyPremium = params.cell.dailyPremiumUsdc;
  const useOverride =
    typeof params.dbOverrideDailyPremiumUsdc === "number" &&
    Number.isFinite(params.dbOverrideDailyPremiumUsdc) &&
    params.dbOverrideDailyPremiumUsdc > 0;
  const dbBase = useOverride
    ? (params.dbOverrideDailyPremiumUsdc as number)
    : baseDailyPremium;

  // Calm intentionally NEVER reads regime overlay.
  if (params.regime && params.regime !== "calm") {
    const overlay = readOverlayMap();
    const cellOverlay = overlay[params.cell.cellId];
    if (cellOverlay) {
      const overlayPrice = cellOverlay[params.regime];
      if (typeof overlayPrice === "number" && Number.isFinite(overlayPrice) && overlayPrice > 0) {
        return {
          cellId: params.cell.cellId,
          dailyPremiumUsdc: overlayPrice,
          payoutUsdc: params.cell.payoutUsdc,
          source: "regime_overlay",
          regime: params.regime,
          baseDailyPremiumUsdc: baseDailyPremium
        };
      }
    }
  }

  return {
    cellId: params.cell.cellId,
    dailyPremiumUsdc: dbBase,
    payoutUsdc: params.cell.payoutUsdc,
    source: useOverride ? "db_override" : "matrix_base",
    regime: params.regime ?? null,
    baseDailyPremiumUsdc: baseDailyPremium
  };
};

/**
 * Test helper: clear the parse cache so env changes mid-test apply.
 */
export const __resetPricingCacheForTests = (): void => {
  cachedOverlay = null;
};
