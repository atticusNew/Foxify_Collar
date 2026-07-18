/**
 * FalconX LIVE collar planner — pure functions that turn a solved collar into an executable FalconX
 * RFQ structure. FalconX is an OTC desk: quantities are plain BTC (no contract lots), a collar is
 * quoted as ONE structure with a single net price (execution is atomic at the venue), and the quote
 * is all-in (the spread IS the fee — no separate fee line).
 *
 * The slippage band therefore applies at the STRUCTURE level: the quoted net credit must not be
 * worse than the model MID net credit by more than the band. The pricer's mid is the fair value
 * anchor; FalconX's quote embeds their spread, exactly like the OKX touch embedded the book spread.
 *
 * Symbols: BTC-USDC-29AUG25-120000.0-C (validated by the probe). Expiries sit on the same standard
 * 08:00 UTC daily grid the product settles on.
 */

import type { PerpSide } from "../creditCollarPricer";
import type { FxInstrument, FxStructureLeg } from "./falconxClient";
import { nextStandardDailyExpiryMs } from "./okxLivePlanner";

const round2 = (x: number) => +x.toFixed(2);
const round6 = (x: number) => +x.toFixed(6);

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;

/** Parse a FalconX option symbol: BTC-USDC-29AUG25-120000.0-C. Expiry = 08:00 UTC (their fixing). Pure. */
export const parseFalconxSymbol = (symbol: string): { strike: number; optType: "put" | "call"; expiryMs: number } | null => {
  const m = symbol.match(/^BTC-USDC?-(\d{1,2})([A-Z]{3})(\d{2})-([\d.]+)-([CP])$/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2] as (typeof MONTHS)[number]);
  if (month < 0) return null;
  const expiryMs = Date.UTC(2000 + Number(m[3]), month, Number(m[1]), 8, 0, 0);
  const strike = Number(m[4]);
  if (!Number.isFinite(expiryMs) || !Number.isFinite(strike) || strike <= 0) return null;
  return { strike, optType: m[5] === "C" ? "call" : "put", expiryMs };
};

export type FxPlannedLeg = {
  symbol: string;
  optType: "put" | "call";
  action: "buy" | "sell";
  role: "protective" | "funding";
  listedStrike: number;
  solverStrike: number;
  strikeDriftPct: number;
};

export type FalconxCollarPlan = {
  side: PerpSide;
  expiryMs: number;
  expiryIso: string;
  qtyBtc: number;
  effectiveNotionalUsdc: number;
  protective: FxPlannedLeg;
  funding: FxPlannedLeg;
  /** The RFQ structure in FalconX's shape — SELL funding leg, BUY protective leg. */
  structure: FxStructureLeg[];
  /** Model MID net credit for THIS qty (USDC) — the slippage-band anchor for the quoted net. */
  modelMidNetUsdc: number;
};

export type FxPlanInput = {
  side: PerpSide;
  spot: number;
  notionalUsdc: number;
  putStrike: number;      // solver strikes (USD)
  callStrike: number;
  protectiveMidUsdc: number; // model MID totals at modelContractsBtc
  fundingMidUsdc: number;
  modelContractsBtc: number;
  nowMs: number;
  minHoursToExpiry?: number;   // default 12
  maxStrikeDriftPct?: number;  // default 0.01 (of spot)
  /** Canary override: force a tiny qty (BTC). */
  qtyBtcOverride?: number;
};

export type FxPlanResult = { ok: true; plan: FalconxCollarPlan } | { ok: false; error: string; message: string };

/** Map a solved collar to FalconX's live instrument grid. Fail-closed on every gap. */
export const planFalconxCollar = (instruments: FxInstrument[], input: FxPlanInput): FxPlanResult => {
  const expiryMs = nextStandardDailyExpiryMs(input.nowMs, input.minHoursToExpiry ?? 12);
  const atExpiry = instruments
    .map((i) => ({ symbol: String(i.symbol ?? ""), type: i.type, strike: Number(i.strike), expiry: Number(i.epoch_time_expiry) }))
    .filter((i) => i.symbol !== "" && Number.isFinite(i.strike) && i.strike > 0 && i.expiry === expiryMs);
  if (atExpiry.length === 0) {
    return { ok: false, error: "expiry_not_listed", message: `FalconX lists no instruments at ${new Date(expiryMs).toISOString()} — daily grid missing or instruments fetch incomplete` };
  }

  const protectiveType: "put" | "call" = input.side === "long" ? "put" : "call";
  const fundingType: "put" | "call" = input.side === "long" ? "call" : "put";
  const protectiveSolver = protectiveType === "put" ? input.putStrike : input.callStrike;
  const fundingSolver = fundingType === "call" ? input.callStrike : input.putStrike;

  const nearest = (type: "put" | "call", target: number) =>
    atExpiry.filter((i) => i.type === type).sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))[0] ?? null;

  const prot = nearest(protectiveType, protectiveSolver);
  const fund = nearest(fundingType, fundingSolver);
  if (!prot || !fund) return { ok: false, error: "strikes_not_listed", message: `no listed ${!prot ? protectiveType : fundingType} near ${!prot ? protectiveSolver : fundingSolver} at that expiry` };

  const maxDrift = input.maxStrikeDriftPct ?? 0.01;
  const protDrift = Math.abs(prot.strike - protectiveSolver) / input.spot;
  const fundDrift = Math.abs(fund.strike - fundingSolver) / input.spot;
  if (protDrift > maxDrift || fundDrift > maxDrift) {
    return { ok: false, error: "strike_drift_too_large", message: `nearest listed strike drifts ${round6(Math.max(protDrift, fundDrift) * 100)}% of spot from the solver strike (max ${maxDrift * 100}%) — skip rather than misprice` };
  }
  if (fundingType === "call" && fund.strike <= input.spot) return { ok: false, error: "funding_strike_through_spot", message: `listed call ${fund.strike} ≤ spot ${input.spot}` };
  if (fundingType === "put" && fund.strike >= input.spot) return { ok: false, error: "funding_strike_through_spot", message: `listed put ${fund.strike} ≥ spot ${input.spot}` };

  const qtyBtc = input.qtyBtcOverride != null ? +input.qtyBtcOverride.toFixed(4) : +(input.notionalUsdc / input.spot).toFixed(4);
  if (!(qtyBtc > 0)) return { ok: false, error: "qty_invalid", message: `quantity ${qtyBtc} BTC` };

  // Model MID net credit scaled to THIS qty: (funding mid − protective mid) × qty / modelContracts.
  const scale = input.modelContractsBtc > 0 ? qtyBtc / input.modelContractsBtc : 0;
  const modelMidNetUsdc = round2((input.fundingMidUsdc - input.protectiveMidUsdc) * scale);
  if (!(scale > 0)) return { ok: false, error: "model_mid_invalid", message: "modelContractsBtc must be positive" };

  const leg = (i: { symbol: string; strike: number }, optType: "put" | "call", action: "buy" | "sell", role: "protective" | "funding", solver: number, drift: number): FxPlannedLeg => ({
    symbol: i.symbol,
    optType,
    action,
    role,
    listedStrike: i.strike,
    solverStrike: solver,
    strikeDriftPct: round6(drift)
  });

  const protective = leg(prot, protectiveType, "buy", "protective", protectiveSolver, protDrift);
  const funding = leg(fund, fundingType, "sell", "funding", fundingSolver, fundDrift);

  return {
    ok: true,
    plan: {
      side: input.side,
      expiryMs,
      expiryIso: new Date(expiryMs).toISOString(),
      qtyBtc,
      effectiveNotionalUsdc: round2(qtyBtc * input.spot),
      protective,
      funding,
      // FalconX structure order mirrors the RFQ tools: SELL the funding leg, BUY the protective leg.
      structure: [
        { side: "sell", symbol: funding.symbol, weight: 1 },
        { side: "buy", symbol: protective.symbol, weight: 1 }
      ],
      modelMidNetUsdc
    }
  };
};

/**
 * Quoted net credit (USDC, positive = credited to us) from a structure quote. FalconX quotes are
 * PER UNIT (per 1 BTC); the ASK is the price to transact the structure as listed, NEGATIVE when the
 * structure nets a credit to us. Pure.
 */
export const quotedNetCreditUsdc = (askPricePerUnit: number | null, qtyBtc: number): number | null =>
  askPricePerUnit == null ? null : round2(-askPricePerUnit * qtyBtc);

/**
 * Structure-level slippage band: the quoted net credit may be worse than the model MID net by at
 * most `bandPct` of the mid (plus a small absolute floor for near-zero mids). Better-than-mid is
 * always acceptable. Pure.
 */
export const quoteWithinBand = (quotedNetUsdc: number, modelMidNetUsdc: number, bandPct: number, absFloorUsdc = 5): { ok: boolean; shortfallUsdc: number; allowedUsdc: number } => {
  const shortfall = round2(modelMidNetUsdc - quotedNetUsdc); // positive = worse than mid
  const allowed = round2(Math.max(Math.abs(modelMidNetUsdc) * bandPct, absFloorUsdc));
  return { ok: shortfall <= allowed, shortfallUsdc: shortfall, allowedUsdc: allowed };
};
