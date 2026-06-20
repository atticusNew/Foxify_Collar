/**
 * Shadow lifecycle overlay — Phase A (pure, offline). Exercises the credit-vesting, collateral-ledger,
 * and basis-guard modules over the live open book each shadow cycle, so the track record shows the
 * mechanics running on real prices (not just unit tests). Observational: it does NOT mutate the
 * settlement bookkeeping — it measures basis, accrues vesting-to-date, detects barrier touches, and
 * runs the gap waterfall against the collateral ledger.
 */

import { detectBarrier, type PartnerPositionState } from "./barrierLifecycle";
import { computeVestedCredit } from "./creditVesting";
import { assessBasis, type VenueMark } from "./basisGuard";
import { applyGap, type CollateralLedger } from "./collateralLedger";
import type { OpenPosition } from "./forwardSettlement";
import type { OracleTick, PriceSample } from "./referenceOracle";

const round2 = (x: number) => +x.toFixed(2);

export type ShadowLifecycleReport = {
  basisBps: number;
  basisWithinTolerance: boolean;
  openPositions: number;
  barrierTouchesDetected: number;
  vestedCreditSoFarUsdc: number;   // credit accrued across the open book at the current held time
  fullCreditUsdc: number;          // credit if every open position were held to conclusion
  vestProgressPct: number;
  collateralAvailableUsdc: number;
  collateralHalted: boolean;
  gapToReserveUsdc: number;        // gaps absorbed by Atticus's reserve this cycle (on-time)
  gapToFoxifyUsdc: number;         // gaps debited to Foxify this cycle (breach)
  /** Positions the partner feed shows CLOSED with no barrier ⟹ closed early without signal. */
  orphansDetected: number;
  /** True iff the partner-position feed is fully reconciled (no missing/stale). */
  partnerFeedHealthy: boolean;
  flags: string[];
};

export type ShadowLifecycleArgs = {
  open: OpenPosition[];
  nowMs: number;
  ticks: OracleTick[];             // live oracle ticks for barrier detection
  oracleMedianUsd: number;
  usableSamples: PriceSample[];    // per-venue live prices → partner-mark proxies for basis
  ledger: CollateralLedger;
  tenorMs: number;
  basisMaxBps: number;
  persistTicks?: number;
  modeledTouchGapBps?: number;     // modeled slippage per detected touch (routed on-time → reserve)
  /** Optional reconciled partner states by ref (from the partner-position feed). */
  partnerStates?: Record<string, PartnerPositionState>;
  /** Whether the partner feed reconciled cleanly (no missing/stale). Default true. */
  partnerFeedHealthy?: boolean;
};

export const reconcileShadowLifecycle = (args: ShadowLifecycleArgs): { report: ShadowLifecycleReport; ledger: CollateralLedger } => {
  const persist = args.persistTicks ?? 3;
  const touchGapBps = args.modeledTouchGapBps ?? 2;

  // Basis: each usable oracle sample (a venue mark) vs the median. Proxy for partner-vs-oracle basis.
  const marks: VenueMark[] = args.usableSamples.map((s) => ({ venue: s.source, priceUsd: s.priceUsd, tsMs: s.tsMs }));
  const basis = assessBasis(args.oracleMedianUsd, marks, args.basisMaxBps);

  let ledger = args.ledger;
  let touches = 0;
  let gapReserve = 0;
  let gapFoxify = 0;
  let vested = 0;
  let full = 0;
  let orphans = 0;
  const flags: string[] = [];

  for (const p of args.open) {
    full += p.foxifyCreditUsdc;
    const heldMs = Math.max(0, args.nowMs - p.openedAtMs);
    // Vesting accrued to date (time-based view) — shows the credit building as positions are held.
    const v = computeVestedCredit({ fullCreditUsdc: p.foxifyCreditUsdc, tenorMs: args.tenorMs }, heldMs, "voluntary_early_close");
    vested += v.realizedCreditUsdc;

    const { barrier } = detectBarrier(args.ticks, p.putStrike, p.callStrike, persist);

    // Reconciliation: partner shows CLOSED with no barrier ⟹ closed early without a signal (orphan).
    const partner = args.partnerStates?.[p.ref];
    if (partner && !partner.isOpen && barrier === "none") {
      orphans += 1;
      flags.push(`orphan_protection:${p.ref}`);
    }

    if (barrier !== "none") {
      touches += 1;
      // Model the on-time close gap and run it through the waterfall (reserve absorbs when on time).
      const barrierPrice = barrier === "floor" ? p.putStrike : p.callStrike;
      const contractsBtc = p.notionalUsdc / p.spotAtEntry;
      const gapUsdc = round2((touchGapBps / 1e4) * barrierPrice * contractsBtc); // modeled slippage past the barrier
      const a = applyGap(ledger, { ref: p.ref, gapUsdc, onTimeWithinSla: true });
      ledger = a.ledger;
      gapReserve += a.bearer === "reserve" ? gapUsdc : 0;
      gapFoxify += a.bearer === "foxify" ? a.debitedUsdc : 0;
    }
  }

  const partnerFeedHealthy = args.partnerFeedHealthy ?? true;
  if (!basis.safeToSettle) flags.push(`basis_wide:${basis.maxAbsBasisBps}bps`);
  if (ledger.haltNewProtection) flags.push("collateral_below_min_buffer");
  if (!partnerFeedHealthy) flags.push("partner_feed_degraded");

  return {
    report: {
      basisBps: basis.maxAbsBasisBps,
      basisWithinTolerance: basis.withinTolerance,
      openPositions: args.open.length,
      barrierTouchesDetected: touches,
      vestedCreditSoFarUsdc: round2(vested),
      fullCreditUsdc: round2(full),
      vestProgressPct: full > 0 ? +((vested / full) * 100).toFixed(2) : 0,
      collateralAvailableUsdc: ledger.availableUsdc,
      collateralHalted: ledger.haltNewProtection,
      gapToReserveUsdc: round2(gapReserve),
      gapToFoxifyUsdc: round2(gapFoxify),
      orphansDetected: orphans,
      partnerFeedHealthy,
      flags
    },
    ledger
  };
};
