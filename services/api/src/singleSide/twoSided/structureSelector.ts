/**
 * Regime → option-structure selector (Phase 5 scaffolding).
 *
 * Maps the live DVOL regime to the STRUCTURE CLASS the desk should trade, per
 * the CTO strategic framework:
 *
 *   | Regime (DVOL)        | Structure              | Why                          |
 *   | calm (<40)           | straddle_gamma_scalp   | harvest gamma via perp hedge |
 *   | moderate (40-60)     | straddle               | capture vol expansion        |
 *   | elevated (60-85)     | strangle               | convex payoff on breakouts   |
 *   | stress (>=85)        | strangle               | convex payoff on breakouts   |
 *
 * This module is the regime→structure MAPPING ONLY. The specific cell
 * parameters within a structure are still gated by cellAllowlist (validated by
 * the cell sweep). The mapping itself is a strategic input (the sweep validates
 * parameters, not which structure-class fits which regime).
 *
 * NOT YET wired into the live activation gate — that step waits until the cell
 * sweep + DVOL backfill validate the per-regime winners (production-readiness
 * gate: no live activation without a validated cell). This module + the
 * read-only /admin/foxify/v2/structure-selector endpoint are informational so
 * the operator can see the intended routing before flipping it on.
 *
 * Override via env SS_STRUCTURE_BY_REGIME (JSON), e.g.
 *   {"calm":"straddle_gamma_scalp","moderate":"straddle","elevated":"strangle","stress":"strangle"}
 */

import type { Regime } from "./featureFlag";
import type { CellStructure } from "./cellSweep";

export const DEFAULT_STRUCTURE_BY_REGIME: Record<Regime, CellStructure> = {
  calm: "straddle_gamma_scalp",
  moderate: "straddle",
  elevated: "strangle",
  stress: "strangle"
};

const REGIME_RATIONALE: Record<Regime, string> = {
  calm: "low realized vol — harvest gamma via delta-hedged ATM straddle (Foxify perp hedge); a naked long straddle bleeds theta in calm",
  moderate: "rising vol — long ATM straddle captures the expansion with active monetization",
  elevated: "breakout conditions — OTM strangle for convex payoff on large moves",
  stress: "high-vol breakout — OTM strangle for convex payoff on large moves"
};

const VALID_STRUCTURES: ReadonlyArray<CellStructure> = ["strangle", "straddle", "straddle_gamma_scalp"];
const REGIMES: ReadonlyArray<Regime> = ["calm", "moderate", "elevated", "stress"];

export type StructureSelection = {
  regime: Regime;
  structure: CellStructure;
  source: "env_override" | "default";
  rationale: string;
};

/** Parse SS_STRUCTURE_BY_REGIME JSON; silently ignores malformed / invalid entries. */
export const parseStructureOverrides = (raw: string | undefined): Partial<Record<Regime, CellStructure>> => {
  if (!raw) return {};
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (!obj || typeof obj !== "object") return {};
  const out: Partial<Record<Regime, CellStructure>> = {};
  for (const r of REGIMES) {
    const v = obj[r];
    if (typeof v === "string" && VALID_STRUCTURES.includes(v as CellStructure)) {
      out[r] = v as CellStructure;
    }
  }
  return out;
};

/** Select the structure class for one regime (env override > default). */
export const selectStructureForRegime = (
  regime: Regime,
  opts: { overrides?: Partial<Record<Regime, CellStructure>>; envRaw?: string } = {}
): StructureSelection => {
  const overrides = opts.overrides ?? parseStructureOverrides(opts.envRaw ?? process.env.SS_STRUCTURE_BY_REGIME);
  const ov = overrides[regime];
  return ov
    ? { regime, structure: ov, source: "env_override", rationale: REGIME_RATIONALE[regime] }
    : { regime, structure: DEFAULT_STRUCTURE_BY_REGIME[regime], source: "default", rationale: REGIME_RATIONALE[regime] };
};

/** Full regime→structure map (all four regimes). */
export const getFullStructureMap = (
  opts: { envRaw?: string } = {}
): Record<Regime, StructureSelection> => {
  const out = {} as Record<Regime, StructureSelection>;
  for (const r of REGIMES) out[r] = selectStructureForRegime(r, { envRaw: opts.envRaw });
  return out;
};
