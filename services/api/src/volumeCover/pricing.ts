/**
 * Volume Cover pricing — resolves the daily premium AND payout for a cell.
 *
 * PREMIUM (X) precedence (highest first):
 *   1. Regime overlay env (P3 §13):
 *      VC_REGIME_OVERLAY_JSON='{"50k_2pct_1k":{"moderate":420,"elevated":525,"stress":700}}'
 *      Applied when current regime matches a non-base bucket. Calm is
 *      LOCKED at base per operator commitment 2026-05-16; calm overlay
 *      is intentionally NOT honored — reserved for "head-start" hot-fix
 *      path which goes through DB override (admin cell toggle).
 *   2. DB override (admin cell toggle): per-cell `daily_premium_usdc`.
 *   3. Matrix base value (locked launch price per cell).
 *
 * PAYOUT (Y) precedence (added 2026-05-24 for Hybrid v3 pilot pricing,
 * extended 2026-05-25 in PR-G to cover calm regime):
 *   1. Regime overlay env:
 *      VC_PAYOUT_OVERLAY_JSON='{"50k_2pct_1k":{"calm":800,"moderate":750,"elevated":450,"stress":30}}'
 *      Applied for ANY regime (including calm) when a value is present
 *      for that regime in the overlay. If absent, falls through to
 *      matrix base.
 *   2. Matrix base payout value (per-cell launch default).
 *
 *   No DB override for payout (we want payout changes to be deliberate
 *   ops actions, not per-cell toggles).
 *
 *   NOTE: pre-PR-G, calm was hardcoded to ignore the overlay. Lock
 *   removed because per-cycle EV at the matrix-base calm Y is
 *   structurally underwater at observed h ≈ 0.68 + s ≈ 0.7. Operator
 *   must explicitly populate the calm overlay value to change the
 *   live payout; the code change alone is no-op without the env.
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
  /** Source of premium (X). */
  source: "matrix_base" | "db_override" | "regime_overlay";
  /** Source of payout (Y). */
  payoutSource: "matrix_base" | "regime_overlay";
  regime: VolRegime | null;
  baseDailyPremiumUsdc: number;
  basePayoutUsdc: number;
};

type OverlayMap = Partial<Record<string, Partial<Record<VolRegime, number>>>>;

let cachedOverlay: { json: string; map: OverlayMap } | null = null;
let cachedPayoutOverlay: { json: string; map: OverlayMap } | null = null;

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

const readPayoutOverlayMap = (): OverlayMap => {
  const raw = process.env.VC_PAYOUT_OVERLAY_JSON;
  if (!raw || raw.trim() === "") return {};
  if (cachedPayoutOverlay && cachedPayoutOverlay.json === raw) return cachedPayoutOverlay.map;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    cachedPayoutOverlay = { json: raw, map: parsed as OverlayMap };
    return cachedPayoutOverlay.map;
  } catch {
    return {};
  }
};

const resolvePayoutUsdc = (params: {
  cell: CellDefinition;
  regime: VolRegime | null | undefined;
}): { payoutUsdc: number; source: "matrix_base" | "regime_overlay" } => {
  const basePayout = params.cell.payoutUsdc;
  if (!params.regime) {
    return { payoutUsdc: basePayout, source: "matrix_base" };
  }
  // PR-G (2026-05-25): calm-overlay lock removed. Trade 1's −$1,250
  // realized P&L vs the modeled payout-economics target showed the
  // hardcoded calm Y=$1,000 is structurally underwater at current
  // hedge cost (h≈0.68) and salvage (post-fix s≈0.7); dropping calm Y
  // to $800 puts per-cycle EV firmly positive across the plausible
  // P(trigger) range while still meeting Foxify's $350-net-on-trigger
  // floor (Y−X = $800−$350 = $450). The overlay route is reused so
  // the change is reversible without a redeploy.
  //
  // Operator MUST update VC_PAYOUT_OVERLAY_JSON on Render to add the
  // calm key, e.g.:
  //   {"50k_2pct_1k":{"calm":800,"moderate":750,"elevated":450,"stress":450}}
  // Without that env, calm continues to read the matrix base ($1,000) —
  // so this code change alone does NOT alter live behavior; the env
  // update is the operational deploy.
  const overlay = readPayoutOverlayMap();
  const cellOverlay = overlay[params.cell.cellId];
  if (cellOverlay) {
    const overlayPayout = cellOverlay[params.regime];
    if (typeof overlayPayout === "number" && Number.isFinite(overlayPayout) && overlayPayout >= 0) {
      return { payoutUsdc: overlayPayout, source: "regime_overlay" };
    }
  }
  return { payoutUsdc: basePayout, source: "matrix_base" };
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
  const basePayout = params.cell.payoutUsdc;
  const payoutResolved = resolvePayoutUsdc({ cell: params.cell, regime: params.regime });

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
      if (typeof overlayPrice === "number" && Number.isFinite(overlayPrice) && overlayPrice >= 0) {
        return {
          cellId: params.cell.cellId,
          dailyPremiumUsdc: overlayPrice,
          payoutUsdc: payoutResolved.payoutUsdc,
          source: "regime_overlay",
          payoutSource: payoutResolved.source,
          regime: params.regime,
          baseDailyPremiumUsdc: baseDailyPremium,
          basePayoutUsdc: basePayout
        };
      }
    }
  }

  return {
    cellId: params.cell.cellId,
    dailyPremiumUsdc: dbBase,
    payoutUsdc: payoutResolved.payoutUsdc,
    source: useOverride ? "db_override" : "matrix_base",
    payoutSource: payoutResolved.source,
    regime: params.regime ?? null,
    baseDailyPremiumUsdc: baseDailyPremium,
    basePayoutUsdc: basePayout
  };
};

/**
 * Test helper: clear the parse cache so env changes mid-test apply.
 */
export const __resetPricingCacheForTests = (): void => {
  cachedOverlay = null;
  cachedPayoutOverlay = null;
};
