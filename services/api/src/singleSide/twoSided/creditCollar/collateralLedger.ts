/**
 * Collateral / gap-debit ledger — Phase A (pure, offline, default-off). The only money that ever flows
 * Foxify → Atticus is the GAP (slippage past a barrier when the close is late or the market gaps
 * through). Foxify pre-funds a collateral account; gaps are resolved by an SLA waterfall:
 *   - gap within the close SLA  → absorbed by Atticus's timing RESERVE (priced cost, no debit)
 *   - gap beyond the SLA / breach → DEBITED from Foxify's posted collateral
 *   - collateral below the min buffer → HALT new protection until topped up
 * Pure reducer: state in → state out, no I/O.
 */

const round2 = (x: number) => +x.toFixed(2);

export type CollateralLedger = {
  postedUsdc: number;        // cumulative collateral Foxify has posted
  debitedUsdc: number;       // cumulative gaps debited to Foxify
  availableUsdc: number;     // posted − debited
  haltNewProtection: boolean;
};

export type CollateralConfig = {
  /** Below this available balance, halt new protection (fail-safe). Default 0. */
  minBufferUsdc?: number;
};

export const openLedger = (postedUsdc = 0, cfg: CollateralConfig = {}): CollateralLedger => ({
  postedUsdc: round2(postedUsdc),
  debitedUsdc: 0,
  availableUsdc: round2(postedUsdc),
  haltNewProtection: round2(postedUsdc) <= (cfg.minBufferUsdc ?? 0)
});

export const postCollateral = (ledger: CollateralLedger, amountUsdc: number, cfg: CollateralConfig = {}): CollateralLedger => {
  const posted = round2(ledger.postedUsdc + Math.max(0, amountUsdc));
  const available = round2(posted - ledger.debitedUsdc);
  return { ...ledger, postedUsdc: posted, availableUsdc: available, haltNewProtection: available <= (cfg.minBufferUsdc ?? 0) };
};

export type GapResolution = {
  ref?: string;
  gapUsdc: number;            // adverse slippage past the barrier (≥0)
  onTimeWithinSla: boolean;   // true ⟹ reserve absorbs; false ⟹ debit Foxify
};

export type GapApplication = {
  ledger: CollateralLedger;
  bearer: "reserve" | "foxify" | "none";
  debitedUsdc: number;
  halted: boolean;
};

/** Apply one gap to the ledger per the SLA waterfall. Pure. */
export const applyGap = (ledger: CollateralLedger, gap: GapResolution, cfg: CollateralConfig = {}): GapApplication => {
  const minBuffer = cfg.minBufferUsdc ?? 0;
  if (!(gap.gapUsdc > 0)) {
    return { ledger, bearer: "none", debitedUsdc: 0, halted: ledger.availableUsdc <= minBuffer };
  }
  if (gap.onTimeWithinSla) {
    // Within SLA: Atticus's timing reserve absorbs it — no debit to Foxify.
    return { ledger, bearer: "reserve", debitedUsdc: 0, halted: ledger.availableUsdc <= minBuffer };
  }
  // Breach: debit Foxify's collateral.
  const debited = round2(gap.gapUsdc);
  const next: CollateralLedger = {
    ...ledger,
    debitedUsdc: round2(ledger.debitedUsdc + debited),
    availableUsdc: round2(ledger.availableUsdc - debited),
    haltNewProtection: round2(ledger.availableUsdc - debited) <= minBuffer
  };
  return { ledger: next, bearer: "foxify", debitedUsdc: debited, halted: next.haltNewProtection };
};
