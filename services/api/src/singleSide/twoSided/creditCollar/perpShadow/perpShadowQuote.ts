/**
 * From one snapshot to one shadow position: the live product's terms, the
 * published take, and every counterfactual the operator wants measured, all
 * priced from the same second of the same book.
 */

import type { CapRule } from "../capRule";
import type { PerpSide } from "../creditCollarPricer";
import { DEFAULT_FLOOR_BAND, floorRuleText, pickFloor, type FloorRule } from "../floorRule";
import { otherTenor, type CapGuard, type CollarGeometry, type EpTenor } from "../perpTenor";
import { atmReference, fundingStrikeLadder, quoteCollarFromSnapshot, type OkxListedSnapshot, type SnapshotQuote } from "./okxListedSnapshot";
import type {
  PerpAlt,
  PerpAltTerms,
  PerpCapRung,
  PerpFeeRuleAlt,
  PerpFloorRung,
  PerpShadowCounterfactuals,
  PerpShadowOpenRecord,
  PerpShadowRefusalRecord,
  PerpSizeProbe,
  PerpTakeRule,
  PerpTenorAlt,
} from "./perpShadowLedger";

export const cents = (usd: number): number => Math.round(usd * 100);
const round6 = (x: number): number => +x.toFixed(6);

export interface PerpTakeConfig {
  /** share of the net credit we keep (EP_TAKE_RATE; the live default is 0.20) */
  shareRate: number;
  /** minimum take as bps of notional; 0 = no minimum (the live product today) */
  minTakeBpsOfNotional: number;
  /** below this the take is waived (EP_DE_MINIMIS_USDC; live default $0.05) */
  deMinimisCents: number;
}

export interface PerpTakeSplit {
  takeCents: number;
  takeShareCents: number;
  takeMinimumCents: number;
  takeRule: PerpTakeRule;
  creditCents: number;
}

/**
 * The take is the larger of the share and the minimum, waived when tiny, and
 * never more than the net credit (a take that turns the credit negative is a
 * refusal upstream, not a fee).
 */
export function perpTake(netCreditCents: number, notionalCents: number, cfg: PerpTakeConfig): PerpTakeSplit {
  const share = Math.round(Math.max(0, netCreditCents) * cfg.shareRate);
  const minimum = Math.round((Math.max(0, notionalCents) * cfg.minTakeBpsOfNotional) / 10000);
  let take = Math.max(share, minimum);
  let rule: PerpTakeRule = minimum > share ? "minimum" : "share";
  if (take < cfg.deMinimisCents) {
    take = 0;
    rule = "waived";
  }
  take = Math.min(take, Math.max(0, netCreditCents));
  return { takeCents: take, takeShareCents: share, takeMinimumCents: minimum, takeRule: rule, creditCents: netCreditCents - take };
}

/** Plain words for a fee-rule label (`share_only`, `min_<n>bps`). */
export function feeRuleText(label: string): { name: string; rule: string } {
  if (label === "share_only") return { name: "share only", rule: "we keep the published share of the net credit; nothing else" };
  const m = /^min_(\d+)bps$/.exec(label);
  if (m) {
    const bps = Number(m[1]);
    return {
      name: `share or ${(bps / 100).toFixed(2)}% of notional`,
      rule: `the larger of the share and ${bps} bps of the protected notional, waived when tiny`,
    };
  }
  return { name: label, rule: "" };
}

const altFrom = (q: SnapshotQuote, cfg: PerpTakeConfig): PerpAlt => {
  if (!q.ok) return { ok: false, error: q.error, message: q.message };
  const net = cents(q.netCreditUsdc);
  if (net <= 0) return { ok: false, error: "listed_credit_nonpositive", message: "net credit after venue fees is not positive" };
  const split = perpTake(net, cents(q.notionalUsdc), cfg);
  if (split.creditCents <= 0) return { ok: false, error: "credit_below_take", message: "the take would consume the whole credit" };
  return {
    ok: true,
    floorStrikeCents: cents(q.buyStrike),
    capStrikeCents: cents(q.sellStrike),
    floorPct: q.floorPct,
    capPct: q.capPct,
    buyInstId: q.buyInstId,
    sellInstId: q.sellInstId,
    buyPxBtc: q.buyPxBtc,
    sellPxBtc: q.sellPxBtc,
    grossCreditCents: cents(q.grossCreditUsdc),
    venueFeeCents: cents(q.venueFeeUsdc),
    netCreditCents: net,
    takeCents: split.takeCents,
    takeRule: split.takeRule,
    creditCents: split.creditCents,
    midCreditCents: q.midCreditUsdc == null ? null : cents(q.midCreditUsdc),
    capExceedProb: q.capExceedProb,
    levelsUsed: q.levelsUsed,
  };
};

/** Floor depths the shadow re-quotes at (the live 6% among them). */
export const FLOOR_LADDER_PCTS = [0.05, 0.06, 0.07, 0.08] as const;

export const SIZE_LADDER_MULTS = [1, 10, 50] as const;

export interface PerpQuoteInputs {
  side: PerpSide;
  /** Hyperliquid mark, USD */
  spot: number;
  contracts: number;
  /** the live shape: floor distance and the cap pin the search starts from (the demo's DEMO_FLOOR_PCT / DEMO_CAP_PCT) */
  geometry: CollarGeometry;
  /** the expiry the live product writes to (EP_TENOR; weekly by default). Falls back to the daily when no weekly is listed. */
  tenor: EpTenor;
  /** the live cap guard: the widest strike the search may reach, and the closest it may write */
  capGuard: CapGuard;
  /** the live cap rule (capRule.ts); default the widest strike that pays */
  capRule?: CapRule;
  /** the floor rule to judge on the ladder (floorRule.ts); default `tightest_paying` over the default band */
  floorRule?: FloorRule;
  take: PerpTakeConfig;
  /** the fee-floor counterfactual's minimum, bps of notional */
  counterfactualMinTakeBps: number;
  /** the other tenor's band (the counterfactual re-quotes the same shape at the other expiry); default the live guard */
  otherTenorCapGuard?: CapGuard;
  okxIndex: number | null;
  fundingBpsPer8h: number | null;
  nowIso: string;
  id: string;
  /** how the live quote fills: `top` (top of book, the metronome's default) or `walk` (the book walked at this size; flow mode) */
  fillMode?: "top" | "walk";
}

/**
 * Quote the live shape at the live size and every alternative. The cap
 * ladder holds the floor and moves the funding wing to each listed strike in
 * the band. Fee-rule alternatives hold the collar fixed and recompute only
 * the split, so the difference is the fee and nothing else. Size probes
 * re-walk the book. The other tenor re-quotes the same shape at the other
 * expiry (the daily when the live product is weekly, and the reverse).
 */
export function perpShadowQuote(inputs: PerpQuoteInputs, snap: OkxListedSnapshot): PerpShadowOpenRecord | PerpShadowRefusalRecord {
  const weeklyListed = snap.weeklyExpiryMs != null && snap.weeklyExpiryMs !== snap.expiryMs;
  const liveTenor: EpTenor = inputs.tenor === "weekly" && weeklyListed ? "weekly" : "daily";
  const liveExpiryMs = liveTenor === "weekly" ? (snap.weeklyExpiryMs as number) : snap.expiryMs;
  const liveMode = inputs.fillMode ?? "top";
  const base = { side: inputs.side, spot: inputs.spot, contracts: inputs.contracts, geometry: inputs.geometry, maxCapPct: inputs.capGuard.maxCapPct, expiryMs: liveExpiryMs, capRule: inputs.capRule };
  const live = quoteCollarFromSnapshot({ ...base, mode: liveMode }, snap);
  let liveAlt = altFrom(live, inputs.take);
  // The cap guard: the widest paying strike still sits too close to price. Refuse, and say how close.
  if (live.ok && liveAlt.ok && live.capPct < inputs.capGuard.minCapPct - 1e-9) {
    liveAlt = {
      ok: false,
      error: "cap_too_close",
      message: `widest paying cap ${live.sellInstId} sits ${(live.capPct * 100).toFixed(2)}% from price, under the ${(inputs.capGuard.minCapPct * 100).toFixed(1)}% guard`,
    };
  }
  if (!live.ok || !liveAlt.ok) {
    const err = !live.ok ? live : (liveAlt as Extract<PerpAlt, { ok: false }>);
    return {
      type: "refusal",
      at: inputs.nowIso,
      side: inputs.side,
      contracts: inputs.contracts,
      spotCents: cents(inputs.spot),
      error: err.error,
      message: err.message,
    };
  }
  const notionalCents = cents(live.notionalUsdc);
  const split = perpTake(liveAlt.netCreditCents, notionalCents, inputs.take);

  // The cap-distance ladder: every listed funding strike in the band, the live floor held fixed.
  const capLadder: PerpCapRung[] = fundingStrikeLadder(snap, inputs.side, inputs.spot, inputs.capGuard.maxCapPct, liveExpiryMs).map((inst) => {
    const capPct = round6(Math.abs(inst.strike - inputs.spot) / inputs.spot);
    const isLive = inst.instId === live.sellInstId;
    const rq = isLive ? live : quoteCollarFromSnapshot({ ...base, mode: liveMode, pinSellInstId: inst.instId }, snap);
    const terms = isLive ? liveAlt : altFrom(rq, inputs.take);
    const exceedProb = rq.ok ? rq.capExceedProb : null;
    return { sellInstId: inst.instId, capStrikeCents: cents(inst.strike), capPct, live: isLive, underGuard: capPct < inputs.capGuard.minCapPct - 1e-9, exceedProb, terms };
  });

  const feeRules: Record<string, PerpFeeRuleAlt> = {};
  const shareOnly = perpTake(liveAlt.netCreditCents, notionalCents, { ...inputs.take, minTakeBpsOfNotional: 0 });
  feeRules.share_only = {
    rule: feeRuleText("share_only").rule,
    takeCents: shareOnly.takeCents,
    creditCents: shareOnly.creditCents,
    takeRule: shareOnly.takeRule,
    refused: shareOnly.creditCents <= 0,
  };
  const withMin = perpTake(liveAlt.netCreditCents, notionalCents, { ...inputs.take, minTakeBpsOfNotional: inputs.counterfactualMinTakeBps });
  const minLabel = `min_${inputs.counterfactualMinTakeBps}bps`;
  feeRules[minLabel] = {
    rule: feeRuleText(minLabel).rule,
    takeCents: withMin.takeCents,
    creditCents: withMin.creditCents,
    takeRule: withMin.takeRule,
    refused: withMin.creditCents <= 0,
  };

  const sizeLadder: PerpSizeProbe[] = SIZE_LADDER_MULTS.map((mult) => {
    const contracts = inputs.contracts * mult;
    const q = quoteCollarFromSnapshot({ ...base, contracts, mode: "walk" }, snap);
    return { mult, contracts, terms: altFrom(q, inputs.take) };
  });

  // Tenor: the same geometry at the other expiry, in that tenor's band. One-day
  // options a few percent out are worth ticks; the weekly is where the credit
  // is real. Measured side by side so the default is a number, not an argument.
  const tenors: Record<string, PerpTenorAlt> = {};
  if (weeklyListed) {
    const alt = otherTenor(liveTenor);
    const altExpiryMs = alt === "weekly" ? (snap.weeklyExpiryMs as number) : snap.expiryMs;
    const aq = quoteCollarFromSnapshot({ ...base, maxCapPct: inputs.otherTenorCapGuard?.maxCapPct ?? base.maxCapPct, mode: liveMode, expiryMs: altExpiryMs }, snap);
    const terms = altFrom(aq, inputs.take);
    tenors[alt] = terms.ok ? { ...terms, expiryIso: new Date(altExpiryMs).toISOString() } : terms;
  }

  // Floor depth: the collar re-quoted with the floor at each depth (the cap re-found by the live
  // rule at each), same expiry and instant. Deeper floors are cheaper, so the cap can sit closer
  // for the same credit or pay more at the same cap — measured per depth, settled on the same path.
  const floorLadder: PerpFloorRung[] = FLOOR_LADDER_PCTS.map((floorPct) => {
    const isLive = Math.abs(floorPct - inputs.geometry.floorPct) < 1e-9;
    const q = isLive ? live : quoteCollarFromSnapshot({ ...base, geometry: { ...inputs.geometry, floorPct }, mode: liveMode }, snap);
    return { floorPct, live: isLive, terms: isLive ? liveAlt : altFrom(q, inputs.take) };
  });

  const counterfactuals: PerpShadowCounterfactuals = { version: 2, capLadder, feeRules, sizeLadder, tenors, floorLadder };
  // The counterfactual floor rule, judged on the ladder just quoted (the live rule may be `fixed`).
  const cfFloorRule = inputs.floorRule ?? { kind: "tightest_paying", ...DEFAULT_FLOOR_BAND };
  const fpick = pickFloor(
    cfFloorRule,
    floorLadder.map((r) => ({ floorPct: r.floorPct, creditUsdc: r.terms.ok ? r.terms.creditCents / 100 : null, notionalUsdc: notionalCents / 100 })),
  );
  const floorRulePick = { rule: floorRuleText(cfFloorRule), floorPct: fpick.floorPct, by: fpick.by };
  const basisBps = inputs.okxIndex != null && inputs.okxIndex > 0 ? +(((inputs.spot - inputs.okxIndex) / inputs.okxIndex) * 10000).toFixed(1) : null;
  const nowMs = Date.parse(inputs.nowIso);
  const periods8h = Math.max(0, live.expiryMs - nowMs) / (8 * 3_600_000);
  const fundingCycleCents =
    inputs.fundingBpsPer8h == null ? null : Math.round(notionalCents * (inputs.fundingBpsPer8h / 10000) * periods8h * (inputs.side === "long" ? 1 : -1));
  const atm = atmReference(snap, inputs.spot, live.expiryMs, nowMs);
  return {
    type: "open",
    at: inputs.nowIso,
    id: inputs.id,
    side: inputs.side,
    contracts: live.contracts,
    ctValBtc: live.ctValBtc,
    notionalCents,
    spotCents: cents(inputs.spot),
    okxIndexCents: inputs.okxIndex == null ? null : cents(inputs.okxIndex),
    basisBps,
    fundingBpsPer8h: inputs.fundingBpsPer8h,
    fundingCycleCents,
    expiryIso: new Date(live.expiryMs).toISOString(),
    tenor: liveTenor,
    capGuardPct: inputs.capGuard.minCapPct,
    capExceedProb: live.capExceedProb,
    capRuleApplied: live.capRuleApplied,
    floorRulePick,
    buyInstId: live.buyInstId,
    sellInstId: live.sellInstId,
    floorStrikeCents: cents(live.buyStrike),
    capStrikeCents: cents(live.sellStrike),
    floorPct: live.floorPct,
    capPct: live.capPct,
    buyPxBtc: live.buyPxBtc,
    sellPxBtc: live.sellPxBtc,
    grossCreditCents: liveAlt.grossCreditCents,
    venueFeeCents: liveAlt.venueFeeCents,
    netCreditCents: liveAlt.netCreditCents,
    takeCents: split.takeCents,
    takeRule: split.takeRule,
    takeShareCents: split.takeShareCents,
    takeMinimumCents: split.takeMinimumCents,
    creditCents: split.creditCents,
    midCreditCents: liveAlt.midCreditCents,
    atmRef: { callAskPxBtc: atm.callAskPxBtc, putAskPxBtc: atm.putAskPxBtc, hoursToExpiry: atm.hoursToExpiry },
    counterfactuals,
  };
}

export type { PerpAltTerms };
