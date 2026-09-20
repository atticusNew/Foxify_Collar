/**
 * CAP RELEASE — the plain collar's one decision, priced for the holder.
 *
 * In plain mode the collar runs to expiry and the gains above the cap this cycle are what the
 * holder pays for the floor. Nothing closes at a touch. If the holder wants the upside back they
 * buy the cap leg back at the live price, any time: that is a RELEASE. From the release on every
 * gain is theirs; the cost is owed at settlement, netted against the credit.
 *
 * This module prices the release (and the early-close mark-to-market) from OKX's public book, and
 * executes it on okx lanes as a single IOC buy of the sold leg — mirroring the unwind's ladder
 * (book-referenced first, then venue mark) but touching ONLY the short leg: the long protective
 * leg stays, so the holder keeps the floor for the rest of the cycle.
 *
 * Someone always eats the cap leg's time value when price reaches the cap. Here the holder
 * decides who, with the price in dollars in front of them.
 */

import { computeCollarOpenFees } from "./bullishFees";
import type { PerpSide } from "./creditCollarPricer";
import type { DemoLeg, DemoWrapRecord } from "./demoWrap";
import { OKX_OPTION_LOT_BTC } from "./demoWrap";
import type { LiveExecClient } from "./execution/okxLiveCollarExecutor";
import { iocClosePxBtc } from "./execution/okxLivePlanner";

const round2 = (x: number): number => +x.toFixed(2);

export type BookTop = { bidPxBtc: number | null; askPxBtc: number | null };

const MONTH_NUM: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };

/**
 * The OKX-listed id behind a leg. Real legs already carry it. Paper legs carry the model's
 * `BTC-USD-25SEP26-78000-P (model)`; the same contract is listed as `BTC-USD-260925-78000-P`,
 * and that is the book the release (and the cap watch) prices against, so a paper wrap shows the
 * holder the same dollar figure a live one would. Anything else passes through untouched.
 */
export const listedInstId = (instId: string | null | undefined): string | null => {
  if (!instId) return null;
  const bare = instId.replace(/\s*\(model\)\s*$/, "");
  const m = /^([A-Z]+-[A-Z]+)-(\d{2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-([CP])$/.exec(bare);
  if (!m) return bare;
  const mon = MONTH_NUM[m[3]];
  return mon ? `${m[1]}-${m[4]}${mon}${m[2]}-${m[5]}-${m[6]}` : bare;
};

/** The wrap's sold (cap) leg and bought (floor) leg, by role, with `instId` in its listed form. */
export const wrapLegs = (rec: Pick<DemoWrapRecord, "legs" | "position">): { capLeg: DemoLeg | null; floorLeg: DemoLeg | null } => {
  const capRole = rec.position.side === "long" ? "sell_call_cap" : "sell_put_cap";
  const floorRole = rec.position.side === "long" ? "buy_put_floor" : "buy_call_floor";
  const listed = (l: DemoLeg | undefined): DemoLeg | null => (l ? { ...l, instId: listedInstId(l.instId) } : null);
  return {
    capLeg: listed(rec.legs.find((l) => l.role === capRole)),
    floorLeg: listed(rec.legs.find((l) => l.role === floorRole))
  };
};

/** OKX taker fee on one option leg, USDC (the same model the open quote charges). */
export const legFeeUsdc = (notionalUsd: number, premiumUsd: number): number =>
  computeCollarOpenFees({ notionalUsd, protectivePremiumUsd: 0, fundingPremiumUsd: premiumUsd, mode: "clob_taker", venue: "okx" }).fundingFeeUsdc;

export type ReleaseQuote =
  | { ok: true; costUsdc: number; premiumUsdc: number; feeUsdc: number; askPxBtc: number; contracts: number; instId: string | null }
  | { ok: false; reason: string };

/**
 * What releasing the cap costs right now: the sold leg's live ask × covered size × spot, plus
 * the venue's taker fee. Pure. No ask ⟹ no price (never invent one for the holder).
 */
export const releaseQuoteFromBook = (input: {
  contracts: number;
  spotUsd: number;
  top: BookTop | null;
  instId: string | null;
  ctValBtc?: number;
}): ReleaseQuote => {
  const ask = input.top?.askPxBtc;
  if (ask == null || !(ask > 0)) return { ok: false, reason: "no ask on the cap leg right now — try again in a moment" };
  if (!(input.contracts > 0) || !(input.spotUsd > 0)) return { ok: false, reason: "nothing to release" };
  const qtyBtc = input.contracts * (input.ctValBtc ?? OKX_OPTION_LOT_BTC);
  const premiumUsdc = round2(ask * qtyBtc * input.spotUsd);
  const feeUsdc = round2(legFeeUsdc(qtyBtc * input.spotUsd, premiumUsdc));
  return { ok: true, costUsdc: round2(premiumUsdc + feeUsdc), premiumUsdc, feeUsdc, askPxBtc: ask, contracts: input.contracts, instId: input.instId };
};

/**
 * The collar's mark-to-market on an early unwind, priced from the book tops (paper lanes; okx
 * lanes use the real fills): protective leg sold at its bid, cap leg (if still held) bought back
 * at its ask, both taker fees. Positive is paid to the holder; negative is owed. Null when a leg
 * that must trade has no price.
 */
export const closeValueFromBooks = (input: {
  contracts: number;
  spotUsd: number;
  floorTop: BookTop | null;
  capTop: BookTop | null;
  capHeld: boolean;
  ctValBtc?: number;
}): number | null => {
  if (!(input.contracts > 0) || !(input.spotUsd > 0)) return null;
  const qtyBtc = input.contracts * (input.ctValBtc ?? OKX_OPTION_LOT_BTC);
  const notional = qtyBtc * input.spotUsd;
  const bid = input.floorTop?.bidPxBtc ?? 0; // a floor leg with no bid is worth nothing on the way out (bounded at zero)
  const floorProceeds = bid * qtyBtc * input.spotUsd;
  let capCost = 0;
  if (input.capHeld) {
    const ask = input.capTop?.askPxBtc;
    if (ask == null || !(ask > 0)) return null;
    capCost = ask * qtyBtc * input.spotUsd;
  }
  const fees = legFeeUsdc(notional, floorProceeds) + (input.capHeld ? legFeeUsdc(notional, capCost) : 0);
  return round2(floorProceeds - capCost - fees);
};

/** Public OKX top of book for one instrument. Throws on HTTP failure; returns nulls on an empty book. */
export const fetchOkxBookTop = async (instId: string, base = process.env.OKX_REST_BASE ?? "https://www.okx.com"): Promise<BookTop> => {
  const res = await fetch(`${base}/api/v5/market/books?instId=${encodeURIComponent(instId)}&sz=1`, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`OKX books ${instId} HTTP ${res.status}`);
  const raw = (await res.json()) as { data?: Array<{ bids?: string[][]; asks?: string[][] }> };
  const px = (v: string | undefined): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return { bidPxBtc: px(raw.data?.[0]?.bids?.[0]?.[0]), askPxBtc: px(raw.data?.[0]?.asks?.[0]?.[0]) };
};

export type LegBuyBack = {
  ok: boolean;
  filledContracts: number;
  avgPxBtc: number | null;
  feeBtc: number;
  /** premium + fee in USDC at `spotUsd`; null when nothing filled */
  costUsdc: number | null;
  notes: string[];
};

const TICK_BTC = 0.0001;
const ceilTick = (px: number): number => Math.max(TICK_BTC, +(Math.ceil(px / TICK_BTC - 1e-9) * TICK_BTC).toFixed(8));
const parseNum = (v: string | undefined | null): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Buy back ONE sold leg on OKX: IOC limit at the book ask (+5% cross), then at venue mark × 1.1
 * when the book is empty, reduce-only so a stale record can never open a long. The protective
 * leg is not touched. Partial fills are reported as such; the caller decides whether a partial
 * release is bookable (it is: the cap shrinks to the unfilled contracts).
 */
export const buyBackLeg = async (
  client: LiveExecClient,
  input: { instId: string; contracts: number; spotUsd: number; ctValBtc?: number; clOrdPrefix?: string; pollTries?: number; pollDelayMs?: number; sleep?: (ms: number) => Promise<void> }
): Promise<LegBuyBack> => {
  const out: LegBuyBack = { ok: false, filledContracts: 0, avgPxBtc: null, feeBtc: 0, costUsdc: null, notes: [] };
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollTries = input.pollTries ?? 8;
  const pollDelayMs = input.pollDelayMs ?? 1_000;
  const ctVal = input.ctValBtc ?? OKX_OPTION_LOT_BTC;
  const ladder: number[] = [];
  const top = (await client.getBookTop(input.instId)).data?.[0];
  const bookPx = iocClosePxBtc("buy", { bidPxBtc: parseNum(top?.bids?.[0]?.[0]), askPxBtc: parseNum(top?.asks?.[0]?.[0]) }, 0.05);
  if (bookPx != null) ladder.push(bookPx);
  const getMark = (client as { getMarkPrice?: (i: string) => Promise<{ data?: Array<{ markPx?: string }> }> }).getMarkPrice;
  if (typeof getMark === "function") {
    try {
      const mark = parseNum((await getMark.call(client, input.instId)).data?.[0]?.markPx);
      if (mark != null && mark > 0) ladder.push(ceilTick(mark * 1.1));
    } catch {
      /* mark unavailable — book price only */
    }
  }
  const prices = [...new Set(ladder)];
  if (prices.length === 0) {
    out.notes.push(`release ${input.instId}: empty book and no mark — no safe IOC reference; nothing bought back`);
    return out;
  }
  for (let attempt = 0; attempt < prices.length; attempt++) {
    const px = prices[attempt];
    const res = await client.placeOrder({
      instId: input.instId,
      side: "buy",
      ordType: "ioc",
      px: String(px),
      sz: String(input.contracts),
      tdMode: "cross",
      reduceOnly: true,
      clOrdId: input.clOrdPrefix ? `${input.clOrdPrefix}RL${attempt === 0 ? "" : String(attempt)}` : undefined
    });
    const ordId = res.data?.[0]?.ordId;
    if (!res.ok || !ordId) {
      out.notes.push(`release buy ${input.instId} REJECTED at ${px}: ${res.code} ${res.data?.[0]?.sMsg ?? res.msg}`);
      continue;
    }
    for (let i = 0; i < pollTries; i++) {
      const snap = (await client.getOrder(input.instId, ordId)).data?.[0];
      if (snap?.state === "filled" || snap?.state === "canceled") {
        out.filledContracts = parseNum(snap.accFillSz) ?? (snap.state === "filled" ? input.contracts : 0);
        out.avgPxBtc = parseNum(snap.avgPx);
        const fee = parseNum(snap.fee);
        if (fee != null) out.feeBtc = -fee;
        if (snap.state === "canceled") out.notes.push(`release order ${ordId} canceled at ${out.filledContracts}/${input.contracts}`);
        break;
      }
      await sleep(pollDelayMs);
    }
    if (out.filledContracts > 0) break;
  }
  if (out.filledContracts > 0 && out.avgPxBtc != null) {
    out.ok = out.filledContracts >= input.contracts;
    out.costUsdc = round2((out.avgPxBtc * out.filledContracts * ctVal + out.feeBtc) * input.spotUsd);
  }
  return out;
};

/** Plain words for the cap, side-aware, for the app and the bot. */
export const capExplainer = (side: PerpSide, capStrike: number, tenorWord: string): string =>
  side === "long"
    ? `Gains above $${capStrike.toLocaleString("en-US")} ${tenorWord} pay for your floor. Release the cap any time at the live price and keep every gain.`
    : `Gains below $${capStrike.toLocaleString("en-US")} ${tenorWord} pay for your floor. Release the cap any time at the live price and keep every gain.`;
