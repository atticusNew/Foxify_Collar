/**
 * From one snapshot to one shadow position: the live product's terms, the
 * published take, and every counterfactual the operator wants measured, all
 * priced from the same second of the same book.
 */

import type { PerpSide } from "../creditCollarPricer";
import type { CapGuard, CollarGeometry } from "../perpTenor";
import { atmReference, fundingStrikeLadder, quoteCollarFromSnapshot, type OkxListedSnapshot, type SnapshotQuote } from "./okxListedSnapshot";
import type {
  PerpAlt,
  PerpAltTerms,
  PerpCapRung,
  PerpFeeRuleAlt,
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
    levelsUsed: q.levelsUsed,
  };
};

export const SIZE_LADDER_MULTS = [1, 10, 50] as const;

export interface PerpQuoteInputs {
  side: PerpSide;
  /** Hyperliquid mark, USD */
  spot: number;
  contracts: number;
  /** the live shape: floor distance and the cap pin the search starts from (the demo's DEMO_FLOOR_PCT / DEMO_CAP_PCT) */
  geometry: CollarGeometry;
  /** the live cap guard: the widest strike the search may reach, and the closest it may write */
  capGuard: CapGuard;
  take: PerpTakeConfig;
  /** the fee-floor counterfactual's minimum, bps of notional */
  counterfactualMinTakeBps: number;
  /** the weekly tenor counterfactual's band (wider; default the daily's) */
  weeklyCapGuard?: CapGuard;
  okxIndex: number | null;
  fundingBpsPer8h: number | null;
  nowIso: string;
  id: string;
}

/**
 * Quote the live shape at the live size and every alternative. The cap
 * ladder holds the floor and moves the funding wing to each listed strike in
 * the band. Fee-rule alternatives hold the collar fixed and recompute only
 * the split, so the difference is the fee and nothing else. Size probes
 * re-walk the book. The weekly re-quotes the same shape at the next Friday.
 */
export function perpShadowQuote(inputs: PerpQuoteInputs, snap: OkxListedSnapshot): PerpShadowOpenRecord | PerpShadowRefusalRecord {
  const base = { side: inputs.side, spot: inputs.spot, contracts: inputs.contracts, geometry: inputs.geometry, maxCapPct: inputs.capGuard.maxCapPct };
  const live = quoteCollarFromSnapshot({ ...base, mode: "top" }, snap);
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
  const capLadder: PerpCapRung[] = fundingStrikeLadder(snap, inputs.side, inputs.spot, inputs.capGuard.maxCapPct).map((inst) => {
    const capPct = round6(Math.abs(inst.strike - inputs.spot) / inputs.spot);
    const isLive = inst.instId === live.sellInstId;
    const terms = isLive ? liveAlt : altFrom(quoteCollarFromSnapshot({ ...base, mode: "top", pinSellInstId: inst.instId }, snap), inputs.take);
    return { sellInstId: inst.instId, capStrikeCents: cents(inst.strike), capPct, live: isLive, underGuard: capPct < inputs.capGuard.minCapPct - 1e-9, terms };
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

  // Tenor: the same geometry at the next weekly. One-day options a few percent
  // out are worth ticks; the weekly is the first place the credit is real.
  // The weekly band reaches wider (its guard), as the live product's would.
  const tenors: Record<string, PerpTenorAlt> = {};
  if (snap.weeklyExpiryMs != null && snap.weeklyExpiryMs !== snap.expiryMs) {
    const wq = quoteCollarFromSnapshot({ ...base, maxCapPct: inputs.weeklyCapGuard?.maxCapPct ?? base.maxCapPct, mode: "top", expiryMs: snap.weeklyExpiryMs }, snap);
    const alt = altFrom(wq, inputs.take);
    tenors.weekly = alt.ok ? { ...alt, expiryIso: new Date(snap.weeklyExpiryMs).toISOString() } : alt;
  }

  const counterfactuals: PerpShadowCounterfactuals = { version: 2, capLadder, feeRules, sizeLadder, tenors };
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
    capGuardPct: inputs.capGuard.minCapPct,
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
