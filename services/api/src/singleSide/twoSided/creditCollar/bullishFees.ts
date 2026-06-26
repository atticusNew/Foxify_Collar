/**
 * Bullish options fee model — Phase A (pure, offline). Grounds the credit-collar cost model in the
 * REAL Bullish fee schedule instead of a synthetic assumption, so the headroom-by-IV number is net of
 * the actual exchange fee — not just the wing crossing.
 *
 * FEE FORMULA (per leg): fee = min(rate × notional, 10% × premium).
 *   - notional = contracts × spot  (the underlying notional; strike-independent, same for both legs)
 *   - premium  = the leg's option premium (in USDC)
 * RATES (bps of notional), per the Bullish schedule:
 *   - CLOB maker:  0
 *   - CLOB taker:  1 bp
 *   - OTC / RFQ:   1 bp (both sides)
 * EXPIRY: a held-to-expiry European option incurs ZERO fee — a held collar pays only the OPEN.
 * OTC/RFQ multi-leg structures net to the HEAVIER leg (a single structure fee), per block treatment;
 * CLOB charges each leg independently.
 *
 * Worked example (50k collar, spot 100k ⟹ 0.5 BTC, notional 50k):
 *   - sell 2% call: 1 bp × 50k = $5 vs 10% × premium(~$70) = $7 ⟹ min binds at $5
 *   - buy 4% put:  1 bp × 50k = $5 vs 10% × premium(~$20) = $2 ⟹ min binds at $2
 *   - CLOB two-taker ⟹ $5 + $2 = ~$7 ; OTC/RFQ multi-leg ⟹ max($5,$2) = ~$5 ; expiry ⟹ $0.
 * Conclusion: Bullish fees are ~$5–7 per position, once — immaterial against an $80 credit / ~$30
 * embedded spread. Fees are NOT the binding constraint; the executable WING SPREAD is (measured live).
 *
 * SCALE-ONLY (not pilot): the CLOB taker rate can drift up via Bullish's Same-Direction Score (SDS),
 * toward ~2.6 bp at SDS ≥ 90% when flow is one-directional. Matched long/short pairing keeps flow
 * bidirectional and holds the low end. Parked here as a constant; deliberately NOT applied to the
 * pilot model so the pilot number is the realistic two-a-day (bidirectional) figure.
 */

const round4 = (x: number) => +x.toFixed(4);

/** Bullish fee schedule constants (bps of notional, and the premium cap). */
export const BULLISH_FEE = {
  clobMakerBps: 0,
  clobTakerBps: 1,
  otcRfqBps: 1,
  premiumCapPct: 0.1,
  /** Scale-only: SDS-driven taker drift ceiling on one-directional flow. NOT used in the pilot model. */
  sdsTakerCeilingBps: 2.6
} as const;

/**
 * Shadow-measured isolated short-leg IM as a fraction of notional (the upside-stress loss on the short
 * leg of an isolated collar). Bullish BPM (SPAN-like, intra-asset netting) on a MATCHED long/short book
 * nets materially below 2× this; replace with Bullish's indicative MR once quoted. Reported peak
 * concurrent + pair-netted, never summed over cumulative notional.
 */
export const BULLISH_ISOLATED_IM_FRACTION = 0.1393;

export type FeeVenueMode = "clob_maker" | "clob_taker" | "otc_rfq";

export const rateBpsFor = (mode: FeeVenueMode): number =>
  mode === "clob_maker" ? BULLISH_FEE.clobMakerBps : mode === "clob_taker" ? BULLISH_FEE.clobTakerBps : BULLISH_FEE.otcRfqBps;

/** Per-leg fee = min(rate × notional, 10% × premium). Pure, non-negative. */
export const legFeeUsdc = (rateBps: number, notionalUsd: number, premiumUsd: number): number => {
  const byNotional = (Math.max(0, rateBps) / 1e4) * Math.max(0, notionalUsd);
  const byPremium = BULLISH_FEE.premiumCapPct * Math.max(0, premiumUsd);
  return round4(Math.min(byNotional, byPremium));
};

export type CollarFeeInput = {
  /** contracts × spot — the underlying notional (same for both legs). */
  notionalUsd: number;
  /** Total premium of the protective (long) leg, in USDC. */
  protectivePremiumUsd: number;
  /** Total premium of the funding (short) leg, in USDC. */
  fundingPremiumUsd: number;
  mode: FeeVenueMode;
};

export type CollarFeeResult = {
  mode: FeeVenueMode;
  protectiveFeeUsdc: number;
  fundingFeeUsdc: number;
  /** Total fee to OPEN the collar: both legs on CLOB; heavier leg only for an OTC/RFQ multi-leg block. */
  openFeeUsdc: number;
  /** Held-to-expiry European settlement is free. */
  expiryFeeUsdc: 0;
  /** Round-trip if the collar is CLOSED early (open + a second open-equivalent fee). Not paid on expiry. */
  earlyCloseRoundTripFeeUsdc: number;
};

/** Compute the open + (potential) early-close fees for a credit collar on Bullish. Pure. */
export const computeCollarOpenFees = (input: CollarFeeInput): CollarFeeResult => {
  const rate = rateBpsFor(input.mode);
  const protectiveFee = legFeeUsdc(rate, input.notionalUsd, input.protectivePremiumUsd);
  const fundingFee = legFeeUsdc(rate, input.notionalUsd, input.fundingPremiumUsd);
  // CLOB charges both legs; OTC/RFQ multi-leg nets to the heavier leg (single structure fee).
  const openFee = input.mode === "otc_rfq" ? Math.max(protectiveFee, fundingFee) : protectiveFee + fundingFee;
  return {
    mode: input.mode,
    protectiveFeeUsdc: protectiveFee,
    fundingFeeUsdc: fundingFee,
    openFeeUsdc: round4(openFee),
    expiryFeeUsdc: 0,
    // An early (non-expiry) close re-incurs the open-equivalent fee on the unwind.
    earlyCloseRoundTripFeeUsdc: round4(2 * openFee)
  };
};
