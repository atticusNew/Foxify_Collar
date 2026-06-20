/**
 * Activation gate — Phase A (pure, default-on, fail-closed). Promotes the previously LOGGED-ONLY
 * fail-closed signals into a HARD gate on opening new protection. Before a cycle opens any positions,
 * EVERY enabled guard must pass; any failure halts opens for the cycle (a correct, fail-closed decline,
 * not an error). This is the runtime enforcement the shadow track record only described before.
 *
 * Guards (all required by default):
 *   - oracle safeForActivation   — the multi-source oracle has its min-3 quorum (else price untrusted)
 *   - collateral not halted       — Foxify's collateral is above the minimum buffer
 *   - partner feed healthy        — the read-only partner feed reconciled cleanly (no missing/stale)
 *   - basis safe to settle        — partner-vs-oracle basis is within tolerance (else can't settle)
 *
 * Settlement has its OWN fail-closed gates on the settle path (ECDSA verify + basis safeToSettle in
 * settleMatured); this module governs OPENS. Pure: signals in, decision out.
 */

export type ActivationGateSignals = {
  oracleSafeForActivation: boolean;
  collateralHalted: boolean;
  partnerFeedHealthy: boolean;
  basisSafeToSettle: boolean;
};

export type ActivationGateConfig = {
  requireOracleSafe?: boolean;          // default true
  requireCollateralOk?: boolean;        // default true
  requirePartnerFeedHealthy?: boolean;  // default true
  requireBasisSafe?: boolean;           // default true
};

export type ActivationGateDecision = {
  allowOpens: boolean;
  /** Machine-readable reasons a gate is closed (empty ⟹ open). */
  reasons: string[];
};

/** Evaluate the open gate. Fail-closed: every enabled guard must pass. Pure. */
export const evaluateActivationGate = (
  signals: ActivationGateSignals,
  cfg: ActivationGateConfig = {}
): ActivationGateDecision => {
  const reasons: string[] = [];
  if (cfg.requireOracleSafe !== false && !signals.oracleSafeForActivation) reasons.push("oracle_not_safe_for_activation");
  if (cfg.requireCollateralOk !== false && signals.collateralHalted) reasons.push("collateral_halted");
  if (cfg.requirePartnerFeedHealthy !== false && !signals.partnerFeedHealthy) reasons.push("partner_feed_degraded");
  if (cfg.requireBasisSafe !== false && !signals.basisSafeToSettle) reasons.push("basis_unsafe_to_settle");
  return { allowOpens: reasons.length === 0, reasons };
};
