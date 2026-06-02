/**
 * Cell configuration for the two-sided cooperative volume facility.
 *
 * Phase 0: ONE cell only — pair_50k_2pct (ITM guts strangle).
 * Per PLAN.md §7, the 5% cells are dropped (negative EV under cooperative model)
 * and 100k/3% + 25k/1.5% are Phase 1 candidates pending MC validation.
 */

export type TwoSidedCell = {
  cellId: string;
  notionalUsdcPerLeg: number;          // Foxify perp notional, each side
  triggerPctDown: number;              // 0.02 = ±2%
  triggerPctUp: number;
  contractsBtc: number;                // strangle contracts per leg
  hedgeTenorDays: number;
  /** Strike selection: ITM guts — put strike ABOVE spot, call strike BELOW spot,
   * both 1.3% ITM, snapped to $1k grid. */
  putStrikeItmPct: number;             // 0.013 = put strike is spot × 1.013
  callStrikeItmPct: number;            // 0.013 = call strike is spot × 0.987
  strikeGridUsdc: number;              // Bullish $1k grid
  enabled: boolean;
};

export const PHASE_0_CELLS: Record<string, TwoSidedCell> = {
  // ── Phase 0 (calm baseline) ──
  pair_50k_2pct: {
    cellId: "pair_50k_2pct",
    notionalUsdcPerLeg: 50_000,
    triggerPctDown: 0.02,
    triggerPctUp: 0.02,
    contractsBtc: 1.4,
    hedgeTenorDays: 3,
    putStrikeItmPct: 0.013,
    callStrikeItmPct: 0.013,
    strikeGridUsdc: 1_000,
    enabled: true
  },
  // ── Phase 1 cells (per Wave C2 sweep) ──
  pair_100k_3pct_itm_short: {
    cellId: "pair_100k_3pct_itm_short",
    notionalUsdcPerLeg: 100_000,
    triggerPctDown: 0.03,
    triggerPctUp: 0.03,
    contractsBtc: 2.0,
    hedgeTenorDays: 2,
    putStrikeItmPct: 0.005,
    callStrikeItmPct: 0.005,
    strikeGridUsdc: 1_000,
    enabled: true
  },
  pair_50k_3pct_atm: {
    cellId: "pair_50k_3pct_atm",
    notionalUsdcPerLeg: 50_000,
    triggerPctDown: 0.03,
    triggerPctUp: 0.03,
    contractsBtc: 1.0,
    hedgeTenorDays: 2,
    putStrikeItmPct: 0,
    callStrikeItmPct: 0,
    strikeGridUsdc: 1_000,
    enabled: true
  },
  pair_50k_5pct_otm: {
    cellId: "pair_50k_5pct_otm",
    notionalUsdcPerLeg: 50_000,
    triggerPctDown: 0.05,
    triggerPctUp: 0.05,
    contractsBtc: 1.0,
    hedgeTenorDays: 2,
    putStrikeItmPct: -0.015,  // 1.5% OTM
    callStrikeItmPct: -0.020,  // 2.0% OTM (asymmetric: BTC put-skew)
    strikeGridUsdc: 1_000,
    enabled: true
  },
  /**
   * DEPRECATED 2026-05-28. Live MC shows 0% trigger rate at calm (5% boundary
   * in 1d tenor is effectively unreachable at typical BTC vol). Always -EV.
   * Kept in registry for backward compat with old shadow pairs; operator
   * cannot activate (enabled: false). Use pair_25k_5pct_otm_3d instead.
   */
  pair_25k_5pct_otm_short: {
    cellId: "pair_25k_5pct_otm_short",
    notionalUsdcPerLeg: 25_000,
    triggerPctDown: 0.05,
    triggerPctUp: 0.05,
    contractsBtc: 0.5,
    hedgeTenorDays: 1,
    putStrikeItmPct: -0.020,
    callStrikeItmPct: -0.025,
    strikeGridUsdc: 1_000,
    enabled: false
  },
  /**
   * pair_25k_5pct_otm_3d — TOP MODERATE-REGIME CELL per cell-redesign sweep
   * 2026-05-28. V3 MC: +$252/pair Foxify EV at moderate regime (DVOL 40-60),
   * crushing pair_25k_5pct_otm_short's +$41. Identical strike geometry, just
   * 3d tenor instead of 1d — more time-value to capture on actual moves.
   * Still loss-making at calm (-$104/pair) — DO NOT include in calm allowlist.
   */
  pair_25k_5pct_otm_3d: {
    cellId: "pair_25k_5pct_otm_3d",
    notionalUsdcPerLeg: 25_000,
    triggerPctDown: 0.05,
    triggerPctUp: 0.05,
    contractsBtc: 0.5,
    hedgeTenorDays: 3,
    putStrikeItmPct: -0.020,
    callStrikeItmPct: -0.025,
    strikeGridUsdc: 1_000,
    enabled: true
  },
  pair_50k_4pct_otm_short: {
    cellId: "pair_50k_4pct_otm_short",
    notionalUsdcPerLeg: 50_000,
    triggerPctDown: 0.04,
    triggerPctUp: 0.04,
    contractsBtc: 1.0,
    hedgeTenorDays: 1,
    putStrikeItmPct: -0.010,
    callStrikeItmPct: -0.015,
    strikeGridUsdc: 1_000,
    enabled: true
  },
  /**
   * DEPRECATED 2026-05-28. Structurally always -EV across all regimes per
   * V5/V6 sweeps. 4h tenor + 1% boundary + ATM strikes = trigger rate ~26%
   * but salvage per trigger too small (1% × $73k × 0.3 BTC = $220 max raw
   * payoff vs $300-400 cost). Kept for backward compat; cannot activate.
   */
  pair_25k_1pct_atm_micro: {
    cellId: "pair_25k_1pct_atm_micro",
    notionalUsdcPerLeg: 25_000,
    triggerPctDown: 0.01,
    triggerPctUp: 0.01,
    contractsBtc: 0.3,
    hedgeTenorDays: 0.167,  // 4h
    putStrikeItmPct: 0,
    callStrikeItmPct: 0,
    strikeGridUsdc: 1_000,
    enabled: false
  },
  /**
   * pair_50k_3pct_atm_3d — moderate+ STRADDLE, the friction-aware sweep winner
   * (real-priced 2026-05-31): ATM straddle, 3% trigger, 3-day tenor. Estimate-tier
   * net +$238 (moderate) / +$809 (elevated) / +$1,285 (stress), all 100% profitable
   * and covering the ~$200-300 perp friction with room. NOT for calm (stand-down).
   * NOTE: contractsBtc≈0.68 = 50k notional / ~$74k spot — sizing should track the
   * perp notional (Foxify opens perps at the same size as protection); the legacy
   * hardcoded contractsBtc on older cells is stale vs current spot. Activation is
   * still globally gated by SS_TWO_SIDED_LIVE_ENABLED=false (shadow-only).
   */
  pair_50k_3pct_atm_3d: {
    cellId: "pair_50k_3pct_atm_3d",
    notionalUsdcPerLeg: 50_000,
    triggerPctDown: 0.03,
    triggerPctUp: 0.03,
    contractsBtc: 0.68,
    hedgeTenorDays: 3,
    putStrikeItmPct: 0,
    callStrikeItmPct: 0,
    strikeGridUsdc: 1_000,
    enabled: true
  },
  /**
   * pair_10k_atm_3d — SMALL near-ATM straddle for GUARANTEED BULLISH FILL (partnership
   * volume). Same ATM/3%/3d geometry as the 50k winner but sized to 10k (~0.14 BTC/leg
   * at ~$70k) — small enough to clear Bullish's THIN near-ATM book (the proven smoke
   * fill was 0.07 BTC; this is ~2× that), while the 3-DAY tenor gives room to HOLD
   * through a vol expansion (unlike the 1d smoke cell, which is theta-heavy). Purpose:
   * route real OPTION volume to BULLISH (the partnership venue) when DVOL crosses into
   * moderate, at a size that fills reliably. ATM (0% ITM) → single nearest-$1k strike,
   * which is exactly where Bullish quotes. To actually ROUTE to Bullish (Bullish ATM
   * round-trip is ~2–7% wider than Deribit), set SS_VENUE_PARTNER=bullish +
   * SS_VENUE_PARTNER_MAX_SPREAD_PCT~0.08 and confirm chosen_venue="bullish" via
   * venue-probe BEFORE arming. Verify Bullish ATM depth covers ~0.14 BTC at go-time
   * (chain-probe); reduce if the book is thin. Moderate+ only (calm = stand-down).
   * Live activation still globally gated by SS_TWO_SIDED_LIVE_ENABLED + the live
   * allowlist + FOXIFY_V2_LIVE_EXECUTION. contractsBtc is a reference only — quoteEngine
   * derives it live from notional/spot.
   */
  pair_10k_atm_3d: {
    cellId: "pair_10k_atm_3d",
    notionalUsdcPerLeg: 10_000,
    triggerPctDown: 0.03,
    triggerPctUp: 0.03,
    contractsBtc: 0.14,
    hedgeTenorDays: 3,
    putStrikeItmPct: 0,
    callStrikeItmPct: 0,
    strikeGridUsdc: 1_000,
    enabled: true
  },
  /**
   * pair_10k_atm_2d — SMALL near-ATM straddle on the 2-DAY tenor, where Bullish is
   * actually COMPETITIVE. Live chain comparison (2026-06-02) showed Bullish WINS the
   * round-trip vs Deribit at the 2d ATM (put RT 930 vs 992, call 830 vs 850), but LOSES
   * badly at 3d (~+18%). So this cell routes to BULLISH naturally (it's the best venue —
   * no partner-band widening needed) at a size (~0.15 BTC/leg, ~$320 premium at moderate)
   * that clears Bullish's thin near-ATM book and fits a ~$1k Bullish balance with buffer.
   * Purpose: real, competitively-priced Bullish partnership volume + a small long-vol hold.
   * 2-day gives more hold-room than the 1d smoke without entering Bullish's wide-3d zone.
   * ATM (0% ITM) → single nearest strike. strikeGridUsdc = 500 ON PURPOSE: Bullish quotes
   * its near-ATM book on a $500 grid (verified live 2026-06-02 — at spot ~$67.5k Bullish
   * quotes 67500, NOT 67000), so a $1k grid would round to a strike Bullish doesn't quote
   * and the cell would never route Bullish. Deribit co-quotes the $500 strikes near ATM
   * (verified), so the $500 grid keeps a Deribit fallback too. Moderate+ only. Live
   * activation still gated by SS_TWO_SIDED_LIVE_ENABLED + live allowlist +
   * FOXIFY_V2_LIVE_EXECUTION. contractsBtc is a reference only (quoteEngine derives live).
   */
  pair_10k_atm_2d: {
    cellId: "pair_10k_atm_2d",
    notionalUsdcPerLeg: 10_000,
    triggerPctDown: 0.03,
    triggerPctUp: 0.03,
    contractsBtc: 0.15,
    hedgeTenorDays: 2,
    putStrikeItmPct: 0,
    callStrikeItmPct: 0,
    strikeGridUsdc: 500,
    enabled: true
  },
  /**
   * pair_150k_3pct_atm_3d — MODERATE+ STRADDLE WINNER (empirical sweep 2026-05-31,
   * Deribit-priced, empirical moderate sigma 0.441). Same ATM/3%/3d geometry as
   * pair_50k_3pct_atm_3d but sized to 150k — the sweep proved net scales ~linearly
   * with notional (50k≈$85 → 100k≈$164 → 150k≈$224–247 Foxify net at ~98–99%
   * profitable), which is the size needed to (nearly) cover the ~$250 perp friction.
   * Net/$ is flat ~6.7%, so size buys absolute net + volume at equal capital
   * efficiency. NOTE (capital): straddle cost ≈ $3.7k/pair at current spot — this is
   * the "more hedge capital, scale into it" path; keep pair_50k_3pct_atm_3d as the
   * capital-light option. To clear $250 with margin: scale to ~175k OR let winners
   * run (Foxify auto-close higher). Results are ESTIMATE-tier until validated in a
   * real moderate regime window. Live activation still globally gated by
   * SS_TWO_SIDED_LIVE_ENABLED=false. contractsBtc is a reference only — quoteEngine
   * derives it live from notional/spot.
   */
  pair_150k_3pct_atm_3d: {
    cellId: "pair_150k_3pct_atm_3d",
    notionalUsdcPerLeg: 150_000,
    triggerPctDown: 0.03,
    triggerPctUp: 0.03,
    contractsBtc: 2.04,
    hedgeTenorDays: 3,
    putStrikeItmPct: 0,
    callStrikeItmPct: 0,
    strikeGridUsdc: 1_000,
    enabled: true
  },
  /**
   * CALM LOSS-LEADER cells (breakeven-ladder 2026-06-01, REAL-tier). Cheap 5%-OTM
   * 25k strangles for the budgeted calm volume mode (SS_TWO_SIDED_CALM_LOSS_LEADER).
   * They are calm-allowlisted but STILL hard-gated: calm activation requires
   * loss-leader mode AND premium <= SS_TWO_SIDED_CALM_MAX_LOSS_USDC (calm stands
   * down by default). Strikes: putStrikeItmPct/callStrikeItmPct = -0.05 → put 5%
   * BELOW spot + call 5% ABOVE spot (true OTM strangle, per computeStrikes).
   *
   * 2d (PRIMARY): cost ~$40, ~−$27 loss/pair in calm, breakeven DVOL ~42.6
   * (flips just past the calm→moderate line), ramps to +$145 at DVOL 60.
   * 1d: cheapest deep-calm volume (cost ~$12.50, ~−$12/pair loss), breakeven
   * DVOL ~50 — only profitable once vol is solidly moderate.
   */
  pair_25k_5otm_strangle_2d: {
    cellId: "pair_25k_5otm_strangle_2d",
    notionalUsdcPerLeg: 25_000,
    triggerPctDown: 0.03,
    triggerPctUp: 0.03,
    contractsBtc: 0.34,
    hedgeTenorDays: 2,
    putStrikeItmPct: -0.05,
    callStrikeItmPct: -0.05,
    strikeGridUsdc: 1_000,
    enabled: true
  },
  pair_25k_5otm_strangle_1d: {
    cellId: "pair_25k_5otm_strangle_1d",
    notionalUsdcPerLeg: 25_000,
    triggerPctDown: 0.03,
    triggerPctUp: 0.03,
    contractsBtc: 0.34,
    hedgeTenorDays: 1,
    putStrikeItmPct: -0.05,
    callStrikeItmPct: -0.05,
    strikeGridUsdc: 1_000,
    enabled: true
  },
  /**
   * LIVE BULLISH SMOKE-TEST cell. Tiny 5k ATM 1d straddle — deliberately NEAR-ATM
   * (0% ITM → single ATM strike) so BULLISH actually quotes it (Bullish has no
   * resting book at the OTM wings). Premium ≈ $100 at current spot. Sole purpose:
   * prove LIVE Bullish order placement end-to-end at minimal cost.
   *
   * ROUTING NOTE: Bullish is ~2–7% wider round-trip than Deribit at ATM, so by
   * default the venue selector still picks Deribit. To force the hedge onto Bullish
   * for the smoke test, widen SS_VENUE_PARTNER_MAX_SPREAD_PCT (~0.08) and confirm
   * via /admin/foxify/v2/venue-probe?cell_id=pair_5k_atm_1d_smoke that
   * chosen_venue="bullish" BEFORE arming live. NOT for normal trading — operator
   * allowlists it only for the smoke test, then removes it.
   */
  pair_5k_atm_1d_smoke: {
    cellId: "pair_5k_atm_1d_smoke",
    notionalUsdcPerLeg: 5_000,
    triggerPctDown: 0.03,
    triggerPctUp: 0.03,
    contractsBtc: 0.07,
    hedgeTenorDays: 1,
    putStrikeItmPct: 0,
    callStrikeItmPct: 0,
    strikeGridUsdc: 1_000,
    enabled: true
  }
};

/**
 * Calm LOSS-LEADER cells, in preference order (PRIMARY first). The shadow
 * auto-loop and the should_activate signal use this ordered list when calm
 * loss-leader mode is on: it tries the PRIMARY (2d, breakeven DVOL ~45) first
 * and falls through to the cheaper 1d if the 2d's premium exceeds the per-pair
 * budget (SS_TWO_SIDED_CALM_MAX_LOSS_USDC). Both are 5%-OTM 25k strangles whose
 * hedge legs route to Deribit (Bullish has no resting book at the OTM wings).
 */
export const CALM_LOSS_LEADER_CELLS: ReadonlyArray<string> = [
  "pair_25k_5otm_strangle_2d",
  "pair_25k_5otm_strangle_1d"
];

/** Pick put + call strikes for the given spot, snapping to grid. */
export const computeStrikes = (cell: TwoSidedCell, spotUsdc: number): { putStrike: number; callStrike: number } => {
  // TRUE ATM straddle (both legs 0% ITM): snap BOTH legs to the SAME nearest grid
  // strike (= the cell-sweep's snapStrike = round). This reproduces the validated
  // single-strike straddle winner (e.g. pair_150k_3pct_atm_3d). WITHOUT this, the
  // ceil(put)/floor(call) logic below would split a 0%-ITM cell into two ADJACENT
  // strikes (a mild ITM "guts"), baking in ~$1k/BTC of extra intrinsic and ~30%
  // higher cost than the structure the sweep actually proved. Guts/OTM cells
  // (non-zero ITM pcts) keep the ceil/floor behavior unchanged.
  if (cell.putStrikeItmPct === 0 && cell.callStrikeItmPct === 0) {
    const atm = Math.round(spotUsdc / cell.strikeGridUsdc) * cell.strikeGridUsdc;
    return { putStrike: atm, callStrike: atm };
  }
  const rawPut = spotUsdc * (1 + cell.putStrikeItmPct);
  const rawCall = spotUsdc * (1 - cell.callStrikeItmPct);
  // Snap put UP to nearest grid (ensures ≥ desired ITM-ness, conservative)
  // Snap call DOWN to nearest grid (same logic for call ITM)
  const putStrike = Math.ceil(rawPut / cell.strikeGridUsdc) * cell.strikeGridUsdc;
  const callStrike = Math.floor(rawCall / cell.strikeGridUsdc) * cell.strikeGridUsdc;
  return { putStrike, callStrike };
};

export const computeTriggerBoundaries = (cell: TwoSidedCell, spotUsdc: number): { triggerDown: number; triggerUp: number } => ({
  triggerDown: spotUsdc * (1 - cell.triggerPctDown),
  triggerUp: spotUsdc * (1 + cell.triggerPctUp)
});

export const getCellOrThrow = (cellId: string): TwoSidedCell => {
  const cell = PHASE_0_CELLS[cellId];
  if (!cell) throw new Error(`Unknown cell: ${cellId}`);
  if (!cell.enabled) throw new Error(`Cell disabled: ${cellId}`);
  return cell;
};
