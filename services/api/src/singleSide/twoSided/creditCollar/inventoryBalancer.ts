/**
 * Inventory-balancing signal — Phase A (pure, offline, default-off). Resolves Q2 under the
 * canonical Model-B directive: flow is a CONTROLLED design input. Atticus drives the signal that
 * determines what Foxify opens next, and uses that control to steer the AGGREGATE NET DELTA of the
 * book toward FLAT — like a market-maker managing inventory — by choosing the side of the next
 * position given what is already open.
 *
 * HARD RULES (encoded, not just documented):
 *   - net-book-delta reference (NOT per-position): the signal manages the book's net delta.
 *   - The signal manages inventory toward NEUTRAL only — NEVER a directional view. Any policy with a
 *     directional bias is REJECTED (directional warehousing makes Atticus implicitly short its own
 *     signal — the exact way prior attempts bled).
 *   - This is NOT opening offsetting pairs on the same instrument (that self-cancels into two spreads
 *     protecting nothing). Positions must be independent real trades — `detectSelfCancellation` stays
 *     active and `assertIndependentFlow` asserts it.
 *
 * Delta convention: a long-perp client receives (long put + short call) ⟹ Atticus holds
 * (short put + long call) ≈ synthetic LONG ⟹ +delta inventory. A short-perp client ⟹ Atticus
 * synthetic SHORT ⟹ −delta. So the book's net delta ≈ Σ(long-perp notional) − Σ(short-perp notional)
 * (the option legs are OTM so true delta < 1×notional, but the SIGN and ordering are what the
 * inventory signal needs; notional is the conservative proxy).
 */

import { detectSelfCancellation, type PerpPosition } from "./selfCancellation";

export type InventoryPolicy = {
  /** Keep |net delta| / gross below this band (e.g. 0.10 = 10%). */
  targetNetBandPct: number;
  /**
   * MUST be false. Present only so a misconfiguration is caught LOUDLY rather than silently enabling
   * directional warehousing. `assertInventoryNeutralPolicy` throws if this is ever true.
   */
  allowDirectionalBias: boolean;
  /**
   * Optional directional tilt in [−1,1]. MUST be 0. Any non-zero value is rejected — the signal is
   * inventory-neutral only, never a market view.
   */
  directionalTiltSigned?: number;
};

export type Inventory = {
  longNotionalUsdc: number;
  shortNotionalUsdc: number;
  grossNotionalUsdc: number;
  /** Signed net delta proxy: + = synthetic-long-heavy, − = synthetic-short-heavy. */
  netNotionalUsdc: number;
  /** |net| / gross in [0,1]; 0 = perfectly flat, 1 = fully one-sided. */
  imbalanceRatio: number;
  withinBand: boolean;
};

export type NextSideRecommendation = {
  side: "long" | "short";
  resultingNetNotionalUsdc: number;
  resultingImbalanceRatio: number;
  reducesImbalance: boolean;
  withinBandAfter: boolean;
  reason: string;
};

/** Reject any non-neutral policy. Call before using the signal anywhere. Pure (returns or throws). */
export const assertInventoryNeutralPolicy = (policy: InventoryPolicy): void => {
  if (policy.allowDirectionalBias) {
    throw new Error("inventory_policy_directional_forbidden: allowDirectionalBias must be false (no directional warehousing)");
  }
  if (policy.directionalTiltSigned != null && Math.abs(policy.directionalTiltSigned) > 1e-12) {
    throw new Error("inventory_policy_directional_forbidden: directionalTiltSigned must be 0 (inventory-neutral only)");
  }
  if (!(policy.targetNetBandPct >= 0 && policy.targetNetBandPct < 1)) {
    throw new Error("inventory_policy_invalid_band: targetNetBandPct must be in [0,1)");
  }
};

/** Compute the current book inventory (net delta proxy) from open positions. Pure. */
export const computeInventory = (openPositions: PerpPosition[], targetNetBandPct = 0.1): Inventory => {
  let longN = 0;
  let shortN = 0;
  for (const p of openPositions) {
    if (!(p.notionalUsdc > 0)) continue;
    if (p.side === "long") longN += p.notionalUsdc;
    else shortN += p.notionalUsdc;
  }
  const gross = longN + shortN;
  const net = longN - shortN;
  const imbalance = gross > 0 ? Math.abs(net) / gross : 0;
  return {
    longNotionalUsdc: +longN.toFixed(2),
    shortNotionalUsdc: +shortN.toFixed(2),
    grossNotionalUsdc: +gross.toFixed(2),
    netNotionalUsdc: +net.toFixed(2),
    imbalanceRatio: +imbalance.toFixed(4),
    withinBand: imbalance <= targetNetBandPct
  };
};

/**
 * Recommend the side of the NEXT position to steer net delta toward flat. Always picks the side that
 * reduces |net|; never tilts directionally. Pure.
 */
export const recommendNextSide = (
  inv: Inventory,
  candidateNotionalUsdc: number,
  policy: InventoryPolicy
): NextSideRecommendation => {
  assertInventoryNeutralPolicy(policy);

  // If net > 0 (synthetic-long-heavy) → next should be SHORT to flatten; if net < 0 → LONG.
  // If exactly flat, default to the side that keeps it flat (either is fine; pick to minimize |net|).
  const side: "long" | "short" = inv.netNotionalUsdc > 0 ? "short" : "long";
  const delta = side === "long" ? candidateNotionalUsdc : -candidateNotionalUsdc;
  const resultingNet = inv.netNotionalUsdc + delta;
  const resultingGross = inv.grossNotionalUsdc + candidateNotionalUsdc;
  const resultingImbalance = resultingGross > 0 ? Math.abs(resultingNet) / resultingGross : 0;
  const reduces = Math.abs(resultingNet) < Math.abs(inv.netNotionalUsdc) + 1e-9;

  return {
    side,
    resultingNetNotionalUsdc: +resultingNet.toFixed(2),
    resultingImbalanceRatio: +resultingImbalance.toFixed(4),
    reducesImbalance: reduces,
    withinBandAfter: resultingImbalance <= policy.targetNetBandPct,
    reason:
      inv.netNotionalUsdc === 0
        ? "book flat; either side acceptable, defaulting to keep it flat"
        : `book ${inv.netNotionalUsdc > 0 ? "synthetic-long" : "synthetic-short"}-heavy by $${Math.abs(inv.netNotionalUsdc)}; steer ${side} to flatten`
  };
};

// ── Live exposure circuit breaker (production, not just a sim verdict) ─────────
//
// The Model-B safety model is "steering keeps us flat; if steering fails, HALT rather than warehouse
// direction." That must be a RUNTIME breaker on the real-time book delta — analogous to the oracle's
// fail-closed — checked in the activation gate before every new open. The sim verdict proves the
// property in replay; this is the component that enforces it live. Default-off until wired to the
// activation path (no live route is created here).

export type ExposureBreakerConfig = {
  /** Warn (alert, keep opening) at this peak |net|/gross. */
  warnBandPct: number;
  /** HALT new opens at/above this |net|/gross (fail-closed; forbidden directional warehousing). */
  haltBandPct: number;
  /** Once halted, only resume opening once exposure recovers below this (hysteresis). */
  resumeBandPct: number;
  /**
   * Gross-notional floor below which the |net|/gross RATIO is not meaningful (a 1–2 position book is
   * trivially ~100% imbalanced). Below this the breaker allows opens — absolute exposure is too small
   * to be "warehousing." Default 0 (ratio always applies). Set per ramp tier in production.
   */
  minGrossNotionalUsd?: number;
};

export type ExposureBreakerState = "ok" | "warn" | "halted";

export type ExposureDecision = {
  state: ExposureBreakerState;
  allowNewOpens: boolean;
  exposureRatio: number;
  reason: string;
};

/** Pure evaluation of the breaker for a current inventory + prior state (latching with hysteresis). */
export const evaluateExposureBreaker = (
  inv: Inventory,
  config: ExposureBreakerConfig,
  priorState: ExposureBreakerState = "ok"
): ExposureDecision => {
  const x = inv.imbalanceRatio;
  // Below the gross floor the ratio is not meaningful (tiny book → trivially ~100% imbalanced);
  // absolute exposure is too small to be warehousing, so allow (and clear any latch).
  if (inv.grossNotionalUsdc < (config.minGrossNotionalUsd ?? 0)) {
    return { state: "ok", allowNewOpens: true, exposureRatio: x, reason: `gross $${inv.grossNotionalUsdc} below ratio floor — exposure immaterial` };
  }
  // Latch: stay halted until exposure recovers below resumeBandPct (manual-resume analogue).
  if (priorState === "halted" && x > config.resumeBandPct) {
    return { state: "halted", allowNewOpens: false, exposureRatio: x, reason: `halted: exposure ${(x * 100).toFixed(1)}% > resume ${(config.resumeBandPct * 100).toFixed(1)}%` };
  }
  if (x >= config.haltBandPct) {
    return { state: "halted", allowNewOpens: false, exposureRatio: x, reason: `HALT new opens: exposure ${(x * 100).toFixed(1)}% ≥ halt band ${(config.haltBandPct * 100).toFixed(1)}% — steering failing, do not warehouse direction` };
  }
  if (x >= config.warnBandPct) {
    return { state: "warn", allowNewOpens: true, exposureRatio: x, reason: `warn: exposure ${(x * 100).toFixed(1)}% ≥ warn band ${(config.warnBandPct * 100).toFixed(1)}% — steer harder` };
  }
  return { state: "ok", allowNewOpens: true, exposureRatio: x, reason: "flat within band" };
};

/**
 * Stateful breaker for the production activation gate. Call `onBook(positions)` whenever the book
 * changes; call `canOpen()` before every new activation. Latches halted until exposure recovers.
 */
export class ExposureBreaker {
  private state: ExposureBreakerState = "ok";
  private lastDecision: ExposureDecision | null = null;
  constructor(private readonly config: ExposureBreakerConfig) {}

  onBook(openPositions: PerpPosition[]): ExposureDecision {
    const inv = computeInventory(openPositions, this.config.warnBandPct);
    const decision = evaluateExposureBreaker(inv, this.config, this.state);
    this.state = decision.state;
    this.lastDecision = decision;
    return decision;
  }

  /** Gate for the activation path: true ⟹ a new open is permitted. Fail-closed if never evaluated. */
  canOpen(): boolean {
    return this.lastDecision != null && this.lastDecision.allowNewOpens;
  }

  current(): ExposureDecision | null {
    return this.lastDecision;
  }
}

/** A position carrying its identity, so independence can be asserted (not just notional/side). */
export type IdentifiedPosition = PerpPosition & {
  /** Distinct per-trade reference (e.g. foxifyPairRef). Independent trades have distinct refs. */
  ref: string;
  /**
   * If set, this position was explicitly opened as a HEDGE PAIR of another (same instrument, opposite
   * side, to net it). That is the forbidden self-cancel (two spreads protecting nothing).
   */
  pairedWithRef?: string;
  /** Optional: the underlying perp instrument/market id (for the structural pair backstop). */
  instrument?: string;
  /** Optional: position open time (ms) — independent flow is spread over time; pairs are simultaneous. */
  tsMs?: number;
};

export type StructuralPairFlag = {
  refA: string;
  refB: string;
  reason: string;
};

/**
 * EXACT discriminator for "manufactured offsetting pair" (the forbidden self-hedge):
 *   same `instrument`  AND  opposite `side`  AND  |notional diff| ≤ notionalTolPct
 *   AND  |tsMs diff| ≤ windowMs  (opened in the SAME moment).
 * Model-B balanced flow does NOT match: it is INDEPENDENT positions spread over time (different tsMs
 * beyond the window) and/or different instruments — the simultaneity + same-instrument is what marks
 * a literal self-hedge. This is a DIAGNOSTIC (alert for review), never an auto-block, because a
 * false-block would halt legitimate Model-B flow (far worse than a false-pass, which just wastes a
 * spread). The HARD block is reserved for unambiguous intent: duplicate refs or explicit pairedWithRef.
 */
export const flagStructuralPairs = (
  positions: IdentifiedPosition[],
  opts: { notionalTolPct?: number; windowMs?: number } = {}
): StructuralPairFlag[] => {
  const notionalTol = opts.notionalTolPct ?? 0.02;
  const windowMs = opts.windowMs ?? 2000;
  const flags: StructuralPairFlag[] = [];
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const a = positions[i];
      const b = positions[j];
      if (a.side === b.side) continue;
      if (!a.instrument || !b.instrument || a.instrument !== b.instrument) continue; // need same instrument
      if (a.tsMs == null || b.tsMs == null) continue; // need timestamps to judge simultaneity
      const sizeRel = Math.abs(a.notionalUsdc - b.notionalUsdc) / Math.max(a.notionalUsdc, b.notionalUsdc);
      if (sizeRel > notionalTol) continue;
      if (Math.abs(a.tsMs - b.tsMs) > windowMs) continue;
      flags.push({
        refA: a.ref,
        refB: b.ref,
        reason: `same instrument ${a.instrument}, opposite side, size within ${(notionalTol * 100).toFixed(0)}%, opened within ${windowMs}ms — review as possible manufactured self-hedge`
      });
    }
  }
  return flags;
};

/**
 * Assert inventory balance arises from INDEPENDENT real trades, not manufactured offsetting pairs.
 *
 * Boundary (Model B is, by design, balanced flow across independent positions):
 *   ALLOWED  : balanced flow across independent positions (distinct refs, different entries/times/
 *              strikes) netting flat in aggregate — high aggregate offset ratio is GOOD, not blocked.
 *   HARD-BLOCK: unambiguous literal pairing — duplicate refs, or explicit `pairedWithRef`.
 *   DIAGNOSTIC: structural near-coincident same-instrument opposite pairs (see flagStructuralPairs) —
 *              ALERTED for review, never auto-blocked (a false-block would halt legitimate flow).
 * `detectSelfCancellation` is retained as an aggregate diagnostic only (reference mode is fixed =
 * net_book_delta), since a balanced book intentionally shows a high aggregate offset ratio.
 */
export const assertIndependentFlow = (
  openPositions: IdentifiedPosition[],
  structuralOpts: { notionalTolPct?: number; windowMs?: number } = {}
): {
  selfCancellationDiagnostic: ReturnType<typeof detectSelfCancellation>;
  structuralPairFlags: StructuralPairFlag[];
  independent: true;
} => {
  const seen = new Set<string>();
  for (const p of openPositions) {
    if (!p.ref) throw new Error("flow_integrity: every position must carry a distinct ref (independent trade)");
    if (seen.has(p.ref)) throw new Error(`flow_integrity: duplicate ref ${p.ref} (same trade counted twice)`);
    seen.add(p.ref);
    if (p.pairedWithRef) {
      throw new Error(
        `self_cancelling_flow_detected: ref ${p.ref} is a manufactured hedge pair of ${p.pairedWithRef} — ` +
          `inventory balance must come from steering INDEPENDENT directional trades toward net-flat, ` +
          `not from offsetting pairs on the same instrument.`
      );
    }
  }
  return {
    selfCancellationDiagnostic: detectSelfCancellation(openPositions), // aggregate diagnostic only
    structuralPairFlags: flagStructuralPairs(openPositions, structuralOpts), // alert, not block
    independent: true
  };
};
