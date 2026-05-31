/**
 * Regime → option-structure selector (Phase 5).
 *
 * Mapping is now driven by REAL, venue-priced sweep results (not just the CTO
 * framework). Findings (2026-05-31):
 *   - calm: efficiently priced — NO options structure (long straddle/strangle,
 *     gamma scalp, OR short iron condor across widths) covers Foxify's ~$200-300
 *     perp friction. Calm is a STAND-DOWN regime (or a deliberate volume
 *     loss-leader — a business decision, not an options edge).
 *   - moderate / elevated / stress: ATM straddle dominates (finding #2) and is
 *     strongly positive (+$238 / +$809 / +$1,285), covering friction with room.
 *
 *   | Regime    | Structure  |
 *   | calm      | stand_down |
 *   | moderate  | straddle   |
 *   | elevated  | straddle   |
 *   | stress    | straddle   |
 *
 * Override via env SS_STRUCTURE_BY_REGIME (JSON). Still informational: the
 * activation gate / cellAllowlist + live_enabled flag remain the real controls;
 * this surfaces the recommended structure so Foxify's should_activate poll and
 * operators can see the intended routing before live wiring of specific cells.
 */

import type { Regime } from "./featureFlag";
import type { CellStructure } from "./cellSweep";

/** Selector can recommend a tradeable structure OR explicit stand-down. */
export type SelectorStructure = CellStructure | "stand_down";

export const DEFAULT_STRUCTURE_BY_REGIME: Record<Regime, SelectorStructure> = {
  calm: "stand_down",
  moderate: "straddle",
  elevated: "straddle",
  stress: "straddle"
};

const REGIME_RATIONALE: Record<Regime, string> = {
  calm: "efficiently-priced — no options structure covers perp friction in calm (validated across long/short/scalp). Stand down, or run as an explicit volume loss-leader only.",
  moderate: "ATM straddle, strongly positive (~+$238) and covers perp friction with room",
  elevated: "ATM straddle, strongly positive (~+$809) on larger moves",
  stress: "ATM straddle, strongly positive (~+$1,285) on large moves"
};

const VALID_STRUCTURES: ReadonlyArray<SelectorStructure> = ["strangle", "straddle", "straddle_gamma_scalp", "stand_down"];
const REGIMES: ReadonlyArray<Regime> = ["calm", "moderate", "elevated", "stress"];

export type StructureSelection = {
  regime: Regime;
  structure: SelectorStructure;
  tradeable: boolean;           // false when stand_down
  source: "env_override" | "default";
  rationale: string;
};

/** Parse SS_STRUCTURE_BY_REGIME JSON; silently ignores malformed / invalid entries. */
export const parseStructureOverrides = (raw: string | undefined): Partial<Record<Regime, SelectorStructure>> => {
  if (!raw) return {};
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (!obj || typeof obj !== "object") return {};
  const out: Partial<Record<Regime, SelectorStructure>> = {};
  for (const r of REGIMES) {
    const v = obj[r];
    if (typeof v === "string" && VALID_STRUCTURES.includes(v as SelectorStructure)) {
      out[r] = v as SelectorStructure;
    }
  }
  return out;
};

/** Select the structure for one regime (env override > default). */
export const selectStructureForRegime = (
  regime: Regime,
  opts: { overrides?: Partial<Record<Regime, SelectorStructure>>; envRaw?: string } = {}
): StructureSelection => {
  const overrides = opts.overrides ?? parseStructureOverrides(opts.envRaw ?? process.env.SS_STRUCTURE_BY_REGIME);
  const ov = overrides[regime];
  const structure = ov ?? DEFAULT_STRUCTURE_BY_REGIME[regime];
  return {
    regime,
    structure,
    tradeable: structure !== "stand_down",
    source: ov ? "env_override" : "default",
    rationale: REGIME_RATIONALE[regime]
  };
};

/** Full regime→structure map (all four regimes). */
export const getFullStructureMap = (
  opts: { envRaw?: string } = {}
): Record<Regime, StructureSelection> => {
  const out = {} as Record<Regime, StructureSelection>;
  for (const r of REGIMES) out[r] = selectStructureForRegime(r, { envRaw: opts.envRaw });
  return out;
};
