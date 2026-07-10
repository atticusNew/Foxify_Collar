/**
 * Capped activation scaffold — Phase A (DEFAULT-OFF, shadow/paper-settled). Wires the safety model
 * for the ramp WITHOUT enabling live trading:
 *   - ExposureBreaker in front of EVERY open (fail-closed, latching) — no directional warehousing,
 *   - settlement on the ECDSA reference oracle (verified, recomputable),
 *   - a venue-vs-ledger RECONCILIATION record on every fill/settle,
 *   - Tier-0 = shadow (paper end-to-end); Tiers 1+ flip on per the ramp, capped by per-tier notional,
 *   - the position INSTRUCTION STREAM to Foxify's bot via recommendNextSide (independent directional
 *     positions steering net flat), with HARD rejection of manufactured same-instrument offsetting
 *     pairs (short-gamma bleed) and the structural-pair guard kept as an ALERT.
 *
 * Live trading stays OFF unless `liveEnabled` AND the tier is marked live AND under its cap. No venue
 * I/O here — fills are injected (paper in shadow); this is the orchestration + invariants only.
 */

import { solveAdaptiveCreditCollar, type SkewCurve, type AtticusSpreadConfig, type PerpSide, type AdaptiveFloorConfig } from "./creditCollarPricer";
import {
  computeInventory,
  recommendNextSide,
  assertInventoryNeutralPolicy,
  flagStructuralPairs,
  ExposureBreaker,
  type InventoryPolicy,
  type ExposureBreakerConfig,
  type IdentifiedPosition
} from "./inventoryBalancer";
import { verifySnapshot, computeSettlementTwap, type OracleSnapshot, type OracleTick } from "./referenceOracle";

export type TierConfig = { tier: number; maxDailyNotionalUsdc: number; live: boolean };

export type ScaffoldConfig = {
  tiers: TierConfig[];
  policy: InventoryPolicy;
  breaker: ExposureBreakerConfig;
  serviceFeeBps: number;
  minServiceFeeUsdc: number;
  maxFloorPct: number;
  tenorDays: number;
  /**
   * Profit model (see creditCollarPricer). Default "pass_through": the collar is sold at fair value and
   * funds only credit + Bullish fees (nets ~0), and Atticus's profit is the SEPARATE operation fee
   * (sized from serviceFeeBps / minServiceFeeUsdc). "embedded_spread" keeps the legacy embedded margin.
   */
  pricingModel?: "embedded_spread" | "pass_through";
  /** Foxify's per-position fee = the CREDIT accrued (e.g. 75). If absent, the service fee is used. */
  feeUsdc?: number;
  /** Regime-adaptive floor: deepen the floor until the credit prices in calm/low-vol markets. */
  adaptiveFloor?: AdaptiveFloorConfig;
  /** Master live switch. Default false ⟹ everything is shadow/paper regardless of tier.live. */
  liveEnabled: boolean;
  spreadConfig?: AtticusSpreadConfig;
};

export type InstructionResult =
  | { ok: true; ref: string; side: PerpSide; notionalUsdc: number; reason: string }
  | { ok: false; halted: true; reason: string };

export type ActivationRecord = {
  ref: string;
  mode: "shadow" | "live";
  tier: number;
  side: PerpSide;
  notionalUsdc: number;
  putStrike: number;
  callStrike: number;
  serviceFeeUsdc: number;
  foxifyCreditUsdc: number;
  foxifyEvUsdc: number;
  floorPctUsed: number;
  /** Hedge-venue (Bullish) fee to OPEN the collar legs — held-to-expiry pays only this. */
  openFeeUsdc: number;
  /** What we SOLD the funding leg (the cap) for — executable premium collected, USDC. */
  fundingLegPremiumUsdc: number;
  /** What we PAID for the protective leg (the floor) — executable premium, USDC. */
  protectiveLegPremiumUsdc: number;
  /** Atticus's profit model: "pass_through" (collar nets ~0, fee billed separately) or "embedded_spread". */
  pricingModel: "embedded_spread" | "pass_through";
  /** True when the collar itself funds the Bullish open fee (pass_through) ⟹ fee is not borne by Atticus's net. */
  feesFundedByCollar: boolean;
  status: "active";
};

export type ActivationRejection = { ok: false; error: string; message: string };

export type ReconciliationRecord = {
  ref: string;
  ledgerLegs: number;
  venueLegs: number;
  matched: boolean;
  discrepancies: string[];
};

export type SettlementRecord = {
  ref: string;
  settlementPriceUsd: number;
  oracleVerified: boolean;
  payoutToFoxifyUsdc: number;
  netToFoxifyUsdc: number; // credit netted at settlement minus any short-leg owed
  reconciliation: ReconciliationRecord;
  status: "settled";
};

/** A paper/real fill leg as reported by the venue side, for reconciliation against the ledger. */
export type VenueLeg = { ref: string; kind: "put" | "call"; venue: string; filled: boolean };

export class CreditCollarActivationScaffold {
  private readonly breaker: ExposureBreaker;
  private openBook: IdentifiedPosition[] = [];
  private dailyNotionalOpened = 0;
  private seq = 0;

  constructor(private readonly cfg: ScaffoldConfig, private readonly skew: SkewCurve) {
    assertInventoryNeutralPolicy(cfg.policy); // hard rule: no directional warehousing
    this.breaker = new ExposureBreaker(cfg.breaker);
    this.breaker.onBook(this.openBook); // initialize (fail-closed until a real book is seen)
  }

  private tierFor(): TierConfig {
    // Lowest tier whose cap still has headroom for today; default to tier 0 (shadow).
    const sorted = [...this.cfg.tiers].sort((a, b) => a.tier - b.tier);
    for (const t of sorted) if (this.dailyNotionalOpened < t.maxDailyNotionalUsdc) return t;
    return sorted[sorted.length - 1];
  }

  private modeFor(tier: TierConfig): "shadow" | "live" {
    return this.cfg.liveEnabled && tier.live && tier.tier > 0 ? "live" : "shadow";
  }

  /** The instruction stream to Foxify's bot: the side that steers net flat, or a halt if the breaker trips. */
  nextInstruction(candidateNotionalUsdc: number): InstructionResult {
    this.breaker.onBook(this.openBook);
    if (!this.breaker.canOpen()) {
      const d = this.breaker.current();
      return { ok: false, halted: true, reason: d ? d.reason : "exposure breaker fail-closed" };
    }
    const inv = computeInventory(this.openBook, this.cfg.policy.targetNetBandPct);
    const rec = recommendNextSide(inv, candidateNotionalUsdc, this.cfg.policy);
    this.seq += 1;
    return { ok: true, ref: `cc-${Date.now()}-${this.seq}`, side: rec.side, notionalUsdc: candidateNotionalUsdc, reason: rec.reason };
  }

  /**
   * Activate a position. Enforces: breaker gate (fail-closed) → manufactured-pair rejection (hard) →
   * tier cap → EV guardrail. Returns the activation record (shadow paper-fill by default).
   */
  activate(instruction: { ref: string; side: PerpSide; notionalUsdc: number; spot: number; instrument?: string; tsMs?: number; pairedWithRef?: string }): ActivationRecord | ActivationRejection {
    // 1. Breaker gate (fail-closed).
    this.breaker.onBook(this.openBook);
    if (!this.breaker.canOpen()) {
      return { ok: false, error: "exposure_halt", message: this.breaker.current()?.reason ?? "exposure breaker halted new opens" };
    }
    // 2. HARD reject manufactured same-instrument offsetting pairs (short-gamma bleed).
    if (instruction.pairedWithRef) {
      return { ok: false, error: "manufactured_pair_rejected", message: `ref ${instruction.ref} is a manufactured hedge pair of ${instruction.pairedWithRef} — rejected (short-gamma bleed)` };
    }
    // Structural near-pair guard kept as an ALERT (does not block) — surfaced via flagStructuralPairs.
    const candidate: IdentifiedPosition = { asset: "BTC", side: instruction.side, notionalUsdc: instruction.notionalUsdc, ref: instruction.ref, instrument: instruction.instrument, tsMs: instruction.tsMs };
    const structuralAlerts = flagStructuralPairs([...this.openBook, candidate]);

    // 3. Tier cap.
    const tier = this.tierFor();
    if (this.dailyNotionalOpened + instruction.notionalUsdc > tier.maxDailyNotionalUsdc && tier.tier === this.cfg.tiers[this.cfg.tiers.length - 1].tier) {
      return { ok: false, error: "tier_cap_exceeded", message: `daily notional ${this.dailyNotionalOpened + instruction.notionalUsdc} exceeds top tier cap ${tier.maxDailyNotionalUsdc}` };
    }
    const mode = this.modeFor(tier);

    // 4. Price + EV guardrail. Credit = Foxify's fee. Default model = pass_through: the operation fee is
    //    billed separately and the collar nets to ~0; embedded_spread keeps the legacy embedded margin.
    const model = this.cfg.pricingModel ?? "pass_through";
    const opFee = Math.max((instruction.notionalUsdc * this.cfg.serviceFeeBps) / 1e4, this.cfg.minServiceFeeUsdc);
    const creditUsdc = this.cfg.feeUsdc != null && this.cfg.feeUsdc > 0 ? this.cfg.feeUsdc : opFee;
    const baseSpreadCfg = { ...(this.cfg.spreadConfig ?? {}), fillMode: this.cfg.spreadConfig?.fillMode ?? "touch" };
    const spreadCfg =
      model === "pass_through"
        ? { ...baseSpreadCfg, pricingModel: "pass_through" as const, operationFeeBps: this.cfg.serviceFeeBps, minOperationFeeUsdc: this.cfg.minServiceFeeUsdc }
        : { ...baseSpreadCfg, pricingModel: "embedded_spread" as const, spreadBps: 0, minMarginUsdc: opFee };
    const adaptive = solveAdaptiveCreditCollar(
      { side: instruction.side, spot: instruction.spot, notionalUsdc: instruction.notionalUsdc, tenorDays: this.cfg.tenorDays, targetCreditUsdc: creditUsdc, maxFloorPct: this.cfg.maxFloorPct, referenceMode: "net_book_delta" },
      this.skew,
      spreadCfg,
      this.cfg.adaptiveFloor
    );
    const q = adaptive.quote;
    if (!q.ok) return { ok: false, error: "not_priceable", message: q.message };
    // No positive Foxify EV from the COLLAR. pass_through ⟹ ≤ 0 (operation fee is separate); embedded ⟹ ≤ −margin.
    const evCeiling = model === "pass_through" ? 1e-6 : -opFee + 1e-6;
    if (q.economics.foxify_market_implied_ev_usdc > evCeiling) {
      return { ok: false, error: "ev_guardrail", message: model === "pass_through" ? "Foxify collar EV must be ≤ 0" : "Foxify EV must be ≤ −service fee" };
    }

    // 5. Book it (paper in shadow).
    this.openBook.push(candidate);
    this.dailyNotionalOpened += instruction.notionalUsdc;
    void structuralAlerts; // alerts are emitted to monitoring in production; non-blocking here

    return {
      ref: instruction.ref,
      mode,
      tier: tier.tier,
      side: instruction.side,
      notionalUsdc: instruction.notionalUsdc,
      putStrike: q.legs.putStrike,
      callStrike: q.legs.callStrike,
      serviceFeeUsdc: opFee, // Atticus revenue per position (operation fee in pass_through; embedded margin floor otherwise)
      foxifyCreditUsdc: q.economics.foxify_credit_usdc,
      foxifyEvUsdc: q.economics.foxify_market_implied_ev_usdc,
      floorPctUsed: adaptive.floorUsedPct,
      openFeeUsdc: q.economics.option_open_fees_usdc,
      fundingLegPremiumUsdc: q.fills.funding_leg_bid_usdc,
      protectiveLegPremiumUsdc: q.fills.protective_leg_ask_usdc,
      pricingModel: model,
      feesFundedByCollar: model === "pass_through",
      status: "active"
    };
  }

  /** Venue-vs-ledger reconciliation (every fill/settle emits one). */
  reconcile(ref: string, ledgerKinds: Array<"put" | "call">, venueLegs: VenueLeg[]): ReconciliationRecord {
    const venueForRef = venueLegs.filter((l) => l.ref === ref && l.filled);
    const discrepancies: string[] = [];
    for (const kind of ledgerKinds) {
      if (!venueForRef.some((l) => l.kind === kind)) discrepancies.push(`ledger ${kind} leg has no matching filled venue leg`);
    }
    for (const l of venueForRef) {
      if (!ledgerKinds.includes(l.kind)) discrepancies.push(`venue ${l.kind} leg (${l.venue}) has no matching ledger leg`);
    }
    return { ref, ledgerLegs: ledgerKinds.length, venueLegs: venueForRef.length, matched: discrepancies.length === 0, discrepancies };
  }

  /**
   * Settle a position on the ECDSA oracle settlement TWAP. Verifies the signed snapshot, computes the
   * European payout, nets the credit, and emits a reconciliation record. Paper-settled in shadow.
   */
  settle(params: {
    ref: string;
    side: PerpSide;
    notionalUsdc: number;
    spotAtEntry: number;
    putStrike: number;
    callStrike: number;
    foxifyCreditUsdc: number;
    settlementTwapTicks: OracleTick[];
    windowStartMs: number;
    windowEndMs: number;
    signedSnapshot: { snapshot: OracleSnapshot; signatureHex: string };
    oraclePublicKeyPem: string;
    venueLegs: VenueLeg[];
  }): SettlementRecord | ActivationRejection {
    const oracleVerified = verifySnapshot(params.signedSnapshot.snapshot, params.signedSnapshot.signatureHex, params.oraclePublicKeyPem);
    if (!oracleVerified) return { ok: false, error: "oracle_signature_invalid", message: "settlement oracle snapshot failed ECDSA verification — fail-closed" };
    const twap = computeSettlementTwap(params.settlementTwapTicks, params.windowStartMs, params.windowEndMs);
    if (!twap.ok) return { ok: false, error: "no_settlement_price", message: twap.error };

    const S = twap.twapUsd;
    const contracts = params.notionalUsdc / params.spotAtEntry;
    // European payoff to Foxify: long-perp collar = long put + short call (mirror for short).
    const putPay = Math.max(0, params.putStrike - S) * contracts;
    const callOwed = Math.max(0, S - params.callStrike) * contracts;
    const payoutToFoxify = params.side === "long" ? putPay - callOwed : Math.max(0, S - params.callStrike) * contracts - Math.max(0, params.putStrike - S) * contracts;
    // Credit was ACCRUED (not upfront); net it at settlement.
    const netToFoxify = params.foxifyCreditUsdc + payoutToFoxify;

    // Remove from open book.
    this.openBook = this.openBook.filter((p) => p.ref !== params.ref);

    const reconciliation = this.reconcile(params.ref, ["put", "call"], params.venueLegs);
    return {
      ref: params.ref,
      settlementPriceUsd: S,
      oracleVerified,
      payoutToFoxifyUsdc: +payoutToFoxify.toFixed(2),
      netToFoxifyUsdc: +netToFoxify.toFixed(2),
      reconciliation,
      status: "settled"
    };
  }

  bookSnapshot(): IdentifiedPosition[] {
    return [...this.openBook];
  }
}
