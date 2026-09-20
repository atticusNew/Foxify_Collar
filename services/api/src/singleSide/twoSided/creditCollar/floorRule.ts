/**
 * FLOOR RULE — which floor depth a quote is written to.
 *
 * The product promises one shape: a hard floor a few percent under the position and the cap that
 * pays the most for it. Until now the floor was one number (DEMO_FLOOR_PCT, 6%). The shadow's
 * floor ladder showed why that is a rule, not a constant: the listed strikes are $1,000 apart,
 * the cap is re-found at every depth, and the credit per dollar protected moves non-monotonically
 * with the floor. So the depth becomes a RULE over a band (5–8%), evaluated per quote against the
 * live book, with the default preserving today's behaviour exactly:
 *
 *   fixed            — one depth, today's 6% (default; one probe, one quote, nothing changes)
 *   tightest_paying  — the most PROTECTIVE depth in the band whose net credit clears a minimum
 *                      (bps of notional). Protection first, then pay: the floor sits as close as
 *                      the market will fund. When no depth clears the minimum, the depth that pays
 *                      the most positive credit; when none pays, refuse.
 *
 * The shadow records what each rule would have picked from its ladder, so the day the default
 * changes it changes on a measured number. Pure functions; the demo service supplies the quoting.
 */

export type FloorRule =
  | { kind: "fixed"; floorPct: number }
  | { kind: "tightest_paying"; minPct: number; maxPct: number; stepPct: number; minCreditBps: number };

export const DEFAULT_FLOOR_BAND = { minPct: 0.05, maxPct: 0.08, stepPct: 0.01, minCreditBps: 5 } as const;

const num = (v: string | undefined, d: number) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

/** EP_FLOOR_RULE=fixed|tightest_paying; band + minimum from EP_FLOOR_MIN_PCT / MAX_PCT / STEP_PCT / MIN_CREDIT_BPS. */
export const floorRuleFromEnv = (env: Record<string, string | undefined>, liveFloorPct: number): FloorRule => {
  const kind = String(env.EP_FLOOR_RULE ?? "fixed").toLowerCase();
  if (kind !== "tightest_paying") return { kind: "fixed", floorPct: liveFloorPct };
  const minPct = Math.max(0.005, num(env.EP_FLOOR_MIN_PCT, DEFAULT_FLOOR_BAND.minPct));
  const maxPct = Math.max(minPct, num(env.EP_FLOOR_MAX_PCT, DEFAULT_FLOOR_BAND.maxPct));
  const stepPct = Math.max(0.0025, num(env.EP_FLOOR_STEP_PCT, DEFAULT_FLOOR_BAND.stepPct));
  const minCreditBps = Math.max(0, num(env.EP_FLOOR_MIN_CREDIT_BPS, DEFAULT_FLOOR_BAND.minCreditBps));
  return { kind: "tightest_paying", minPct, maxPct, stepPct, minCreditBps };
};

export const floorRuleText = (r: FloorRule): string =>
  r.kind === "fixed"
    ? `fixed floor ${(r.floorPct * 100).toFixed(1)}% under the live price`
    : `the tightest floor in ${(r.minPct * 100).toFixed(0)}–${(r.maxPct * 100).toFixed(0)}% whose credit clears ${r.minCreditBps} bps of notional (else the depth that pays most)`;

/** The depths a rule tries, most protective first. Fixed = one depth. */
export const floorCandidates = (r: FloorRule): number[] => {
  if (r.kind === "fixed") return [r.floorPct];
  const out: number[] = [];
  for (let p = r.minPct; p <= r.maxPct + 1e-9; p += r.stepPct) out.push(+p.toFixed(6));
  return out;
};

export interface FloorTrial {
  floorPct: number;
  /** the trader's net credit at this depth; null when the depth did not quote */
  creditUsdc: number | null;
  notionalUsdc: number;
}

export interface FloorPick {
  floorPct: number | null;
  /** why this depth: cleared the minimum, was the best paying fallback, or the fixed rule */
  by: "fixed" | "clears_minimum" | "best_paying" | "none";
  tried: FloorTrial[];
}

const bpsOf = (t: FloorTrial): number => (t.creditUsdc == null || t.notionalUsdc <= 0 ? -Infinity : (t.creditUsdc / t.notionalUsdc) * 10000);

/** Apply the rule to trials already quoted (the shadow's ladder, or a completed demo probe). */
export const pickFloor = (r: FloorRule, tried: FloorTrial[]): FloorPick => {
  if (r.kind === "fixed") {
    const t = tried.find((x) => Math.abs(x.floorPct - r.floorPct) < 1e-9) ?? tried[0];
    return { floorPct: t && t.creditUsdc != null && t.creditUsdc > 0 ? t.floorPct : null, by: t && t.creditUsdc != null && t.creditUsdc > 0 ? "fixed" : "none", tried };
  }
  const asc = [...tried].sort((a, b) => a.floorPct - b.floorPct);
  const clears = asc.find((t) => bpsOf(t) >= r.minCreditBps);
  if (clears) return { floorPct: clears.floorPct, by: "clears_minimum", tried };
  const paying = asc.filter((t) => t.creditUsdc != null && t.creditUsdc > 0).sort((a, b) => bpsOf(b) - bpsOf(a))[0];
  if (paying) return { floorPct: paying.floorPct, by: "best_paying", tried };
  return { floorPct: null, by: "none", tried };
};

/**
 * Evaluate the rule against a live quoter, most protective depth first, stopping at the first
 * depth that clears the minimum (tightest_paying) — so the common case costs one or two probes,
 * and the fixed rule costs exactly one, as before.
 */
export const evaluateFloorRule = async <Q extends { ok: boolean }>(
  r: FloorRule,
  quoteAt: (floorPct: number) => Promise<Q>,
  creditOf: (q: Q) => { creditUsdc: number | null; notionalUsdc: number }
): Promise<{ pick: FloorPick; quotes: Map<number, Q> }> => {
  const quotes = new Map<number, Q>();
  const tried: FloorTrial[] = [];
  for (const floorPct of floorCandidates(r)) {
    const q = await quoteAt(floorPct);
    quotes.set(floorPct, q);
    const c = q.ok ? creditOf(q) : { creditUsdc: null, notionalUsdc: 0 };
    tried.push({ floorPct, creditUsdc: c.creditUsdc, notionalUsdc: c.notionalUsdc });
    if (r.kind === "tightest_paying" && c.creditUsdc != null && c.notionalUsdc > 0 && (c.creditUsdc / c.notionalUsdc) * 10000 >= r.minCreditBps) break;
  }
  return { pick: pickFloor(r, tried), quotes };
};
