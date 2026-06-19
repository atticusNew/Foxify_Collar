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

/** A position carrying its identity, so independence can be asserted (not just notional/side). */
export type IdentifiedPosition = PerpPosition & {
  /** Distinct per-trade reference (e.g. foxifyPairRef). Independent trades have distinct refs. */
  ref: string;
  /**
   * If set, this position was explicitly opened as a HEDGE PAIR of another (same instrument, opposite
   * side, to net it). That is the forbidden self-cancel (two spreads protecting nothing).
   */
  pairedWithRef?: string;
};

/**
 * Assert inventory balance arises from INDEPENDENT real trades, not manufactured offsetting pairs.
 *
 * IMPORTANT: a well-balanced inventory book has long ≈ short and therefore a HIGH aggregate offset
 * ratio — that is GOOD (net-flat), not self-cancellation. So we do NOT reject on aggregate balance.
 * We reject only LITERAL pairing: duplicate refs, or positions explicitly tagged `pairedWithRef`
 * (a long and short opened on the SAME instrument purely to net each other). `detectSelfCancellation`
 * is retained as an informational diagnostic, not a gate (reference mode is fixed = net_book_delta).
 */
export const assertIndependentFlow = (
  openPositions: IdentifiedPosition[]
): { selfCancellationDiagnostic: ReturnType<typeof detectSelfCancellation>; independent: true } => {
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
  // Informational only: aggregate offset ratio is EXPECTED to be high for a balanced book.
  const selfCancellationDiagnostic = detectSelfCancellation(openPositions);
  return { selfCancellationDiagnostic, independent: true };
};
