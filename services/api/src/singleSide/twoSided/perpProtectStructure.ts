/**
 * Perp Protect — position-aware protection structure (pure, testable).
 *
 * The original tiers were inherited from Protected Leverage and hard-wired to leverage via
 * `floorPct = fraction / leverage`. That breaks for low/no-leverage perps (a 1× position would be
 * "protected" with a 50%-down put, and the spread degenerates). Perp Protect must protect the
 * floor on ALL position types, so strike selection is driven by PROTECTION INTENTS, chosen by the
 * position's leverage:
 *
 *   - drawdown_floor      (ALL positions): a price floor a fixed % from mark — the universal,
 *                          leverage-agnostic anchor real insurance uses ("protect below −10%").
 *   - liquidation_insurance (leveraged):   a strike just INSIDE the liquidation price — survive a
 *                          wick / stay in the trade. The Bybit-beating tier (fully realized once
 *                          Phase-4 margin integration PREVENTS liquidation).
 *   - margin_loss_cap     (leveraged):     the legacy `fraction/leverage` cap tiers, retained but
 *                          only when leverage makes them meaningful.
 *
 * This module only computes TARGET strikes (geometry, in `number`). Venues snap to listed strikes,
 * the engine applies the entry-aware worst case + liquidation interaction, and pricing applies the
 * underwriter load — all downstream. De-dups overlapping targets and caps the candidate count so we
 * don't over-probe the venues.
 */

import type { TradeSide } from "./perpProtectQuote";

export type ProtectionIntent = "drawdown_floor" | "liquidation_insurance" | "margin_loss_cap";

export type StructurePosition = {
  spot: number;
  side: TradeSide;
  leverage: number;
};

export type StrikeCandidate = {
  intent: ProtectionIntent;
  /** Pre-snap target strike (venues snap to their listed grid downstream). */
  targetStrike: number;
  /** Positive distance of the strike from spot, as a fraction. */
  targetMovePct: number;
  label: string;
  /** Lower = closer to spot / safer / show first (set after sort+dedup). */
  priority: number;
};

export type PerpProtectStructureConfig = {
  /** Drawdown floors as fractions from mark (e.g. 0.05 = −5% for a long). */
  drawdownLadder: number[];
  /** Legacy margin-fraction cap tiers (floorPct = f / leverage). */
  marginFractions: number[];
  /** How far INSIDE the liquidation price to place the liquidation-insurance strike (flat price
   *  fraction floor). The EFFECTIVE buffer is max(this, liqMove × liqInsuranceBufferFrac) so the
   *  target sits comfortably inside liq and reliably stays inside after venues snap to their grid. */
  liqInsuranceBufferPct: number;
  /** Buffer as a fraction of the liquidation distance (1/leverage); deepens the strike inside liq so
   *  coarse listed-strike grids don't snap it BELOW liq (which would break the "stay alive" promise). */
  liqInsuranceBufferFrac: number;
  /** Minimum leverage to offer liquidation-insurance / margin-cap intents. */
  minLeverageForLiqIntents: number;
  minLeverageForMarginCap: number;
  /** Max distinct candidates returned (closest-to-spot kept first) to bound venue probing. */
  maxCandidates: number;
  /** Spread short-leg step DEEPER than the long leg (price fraction), before liq-capping. */
  spreadStepPct: number;
};

export const DEFAULT_STRUCTURE_CONFIG: PerpProtectStructureConfig = {
  drawdownLadder: [0.05, 0.1, 0.2],
  marginFractions: [0.25, 0.5, 0.75],
  liqInsuranceBufferPct: 0.005,
  liqInsuranceBufferFrac: 0.12,
  minLeverageForLiqIntents: 5,
  minLeverageForMarginCap: 3,
  maxCandidates: 6,
  spreadStepPct: 0.03
};

/** Read structure config from env (PERP_PROTECT_* overrides), falling back to defaults. */
export const structureConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): PerpProtectStructureConfig => {
  const numList = (v: string | undefined, dflt: number[]): number[] => {
    if (!v) return dflt;
    const parsed = v.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    return parsed.length ? parsed : dflt;
  };
  const num = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  const d = DEFAULT_STRUCTURE_CONFIG;
  return {
    drawdownLadder: numList(env.PERP_PROTECT_DRAWDOWN_LADDER, d.drawdownLadder),
    marginFractions: numList(env.PERP_PROTECT_MARGIN_FRACTIONS, d.marginFractions),
    liqInsuranceBufferPct: num(env.PERP_PROTECT_LIQ_INSURANCE_BUFFER_PCT, d.liqInsuranceBufferPct),
    liqInsuranceBufferFrac: num(env.PERP_PROTECT_LIQ_INSURANCE_BUFFER_FRAC, d.liqInsuranceBufferFrac),
    minLeverageForLiqIntents: num(env.PERP_PROTECT_MIN_LEV_LIQ_INTENTS, d.minLeverageForLiqIntents),
    minLeverageForMarginCap: num(env.PERP_PROTECT_MIN_LEV_MARGIN_CAP, d.minLeverageForMarginCap),
    maxCandidates: num(env.PERP_PROTECT_MAX_CANDIDATES, d.maxCandidates),
    spreadStepPct: num(env.PERP_PROTECT_SPREAD_STEP_PCT, d.spreadStepPct)
  };
};

/** Strike at a positive distance `movePct` from spot: below for a long (put), above for a short (call). */
export const strikeAtMove = (spot: number, side: TradeSide, movePct: number): number =>
  side === "short" ? spot * (1 + movePct) : spot * (1 - movePct);

const pctLabel = (x: number) => `${(x * 100).toFixed(x * 100 < 10 ? 1 : 0)}%`;

/** Which intents apply to this position, by leverage. drawdown_floor is universal. */
export const selectIntents = (position: StructurePosition, cfg: PerpProtectStructureConfig = DEFAULT_STRUCTURE_CONFIG): ProtectionIntent[] => {
  const intents: ProtectionIntent[] = ["drawdown_floor"];
  if (position.leverage >= cfg.minLeverageForLiqIntents) intents.push("liquidation_insurance");
  if (position.leverage >= cfg.minLeverageForMarginCap) intents.push("margin_loss_cap");
  return intents;
};

/**
 * Generate the menu of TARGET protection strikes for a position. Candidates from all applicable
 * intents, filtered to be OTM (movePct > 0), sorted by distance from spot, de-duplicated by
 * rounded strike (keep the closest/safest), and capped at `maxCandidates`.
 */
export const generateStrikeCandidates = (
  position: StructurePosition,
  cfg: PerpProtectStructureConfig = DEFAULT_STRUCTURE_CONFIG
): StrikeCandidate[] => {
  const { spot, side, leverage } = position;
  if (!(spot > 0) || !(leverage > 0)) return [];
  const intents = selectIntents(position, cfg);
  const floorWord = side === "short" ? "Ceiling" : "Floor";
  const sign = side === "short" ? "+" : "−";
  const liqMove = 1 / leverage;

  const raw: StrikeCandidate[] = [];

  if (intents.includes("drawdown_floor")) {
    for (const d of cfg.drawdownLadder) {
      if (!(d > 0) || d >= 1) continue;
      raw.push({ intent: "drawdown_floor", targetMovePct: d, targetStrike: strikeAtMove(spot, side, d), label: `${floorWord} ${sign}${pctLabel(d)}`, priority: 0 });
    }
  }

  if (intents.includes("liquidation_insurance")) {
    // Strike a buffer INSIDE the liquidation distance (closer to spot than liq) so the option is
    // in-the-money before the perp would liquidate. The buffer is the deeper of a flat floor and a
    // fraction of the liq distance, so after venues snap to their listed grid the strike still lands
    // inside liq (coarse grids were snapping it below liq → "Stay alive" that didn't keep you alive).
    const liqBuffer = Math.max(cfg.liqInsuranceBufferPct, liqMove * cfg.liqInsuranceBufferFrac);
    const move = Math.max(0, liqMove - liqBuffer);
    if (move > 0) raw.push({ intent: "liquidation_insurance", targetMovePct: move, targetStrike: strikeAtMove(spot, side, move), label: "Stay alive", priority: 0 });
  }

  if (intents.includes("margin_loss_cap")) {
    for (const f of cfg.marginFractions) {
      const floorPct = f / leverage; // cap loss at f × margin (before premium)
      if (!(floorPct > 0) || floorPct >= 1) continue;
      // Trader-facing label is the protected PRICE move (Floor/Ceiling), NOT "% of margin" — the old
      // margin-fraction label understated the true worst case (premium-dominated at high leverage) and
      // confused traders. All single floors now share one consistent mental model.
      raw.push({ intent: "margin_loss_cap", targetMovePct: floorPct, targetStrike: strikeAtMove(spot, side, floorPct), label: `${floorWord} ${sign}${pctLabel(floorPct)}`, priority: 0 });
    }
  }

  // Sort by distance from spot (closest/safest first), de-dup by rounded strike, cap count.
  raw.sort((a, b) => a.targetMovePct - b.targetMovePct);
  const seen = new Set<number>();
  const distinct: StrikeCandidate[] = [];
  for (const c of raw) {
    const key = Math.round(c.targetStrike);
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(c);
    if (distinct.length >= cfg.maxCandidates) break;
  }
  return distinct.map((c, i) => ({ ...c, priority: i }));
};

export type SpreadTargets = { longStrike: number; shortStrike: number; longMovePct: number; shortMovePct: number };

/**
 * Spread target strikes: long at the chosen floor (`longMovePct` from spot), short one configured
 * step DEEPER. The engine applies liquidation-awareness; this only provides the geometry.
 */
export const spreadTargets = (
  position: StructurePosition,
  longMovePct: number,
  cfg: PerpProtectStructureConfig = DEFAULT_STRUCTURE_CONFIG
): SpreadTargets => {
  const shortMovePct = Math.min(0.9, longMovePct + cfg.spreadStepPct);
  return {
    longMovePct,
    shortMovePct,
    longStrike: strikeAtMove(position.spot, position.side, longMovePct),
    shortStrike: strikeAtMove(position.spot, position.side, shortMovePct)
  };
};
