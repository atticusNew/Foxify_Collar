/**
 * CAP WATCH — the lock-line watcher, repurposed for the knock-out collar.
 *
 * `lockPolicy.ts` asked "MAY we unwind at a touch?" — for this product the answer is fixed: a
 * cap touch ALWAYS ends the cycle (both legs close, protection re-arms, the trader keeps every
 * gain). What is left to decide is what a touch would COST us right now, and how to make the
 * buy-back cheap when it comes. Two jobs, both pure here, wired by the demo service's monitor:
 *
 *  1. HEADROOM, per active wrap, every monitor tick.
 *       headroom = (unvested credit + our take + floor-leg recovery) − buy-back of the sold cap leg
 *     where the buy-back is priced as if the mark were AT the cap right now: the at-the-money time
 *     value of the sold leg at its OKX mark vol for the time left, plus the half-spread we would
 *     pay to lift the ask. Positive: a knock-out now is paid for by credit the trader has not yet
 *     earned. Negative: the shortfall is the writer's cost — booked as a MARGIN RESERVE, summed
 *     across the book, and paged past an alert line. When no vol is readable the leg's live ask
 *     stands in (a floor on the true cost while the leg is out of the money).
 *
 *  2. PRE-TOUCH WORKING ORDER (flag-guarded, EP_PRETOUCH_WORKING_ORDER=1, okx lanes only).
 *     When the Hyperliquid mark comes within `nearBps` of the cap, a passive LIMIT BUY on the sold
 *     leg is rested at the OKX book's mid (never crossing the ask), so that if the touch comes the
 *     buy-back is done at mid instead of at the ask on an IOC. If the mark recedes past
 *     `recallBps` the order is cancelled; if the mid moves it is re-priced; at the touch whatever
 *     did not fill goes through the existing IOC unwind (which reads venue positions first, so a
 *     pre-touch fill is never bought twice). Trigger on the product's clock (HL mark), price on
 *     the hedge venue's clock (OKX book).
 */

import { bsCall, bsPut } from "../../../pilot/blackScholes";
import type { PerpSide } from "./creditCollarPricer";

const YEAR_MS = 365.25 * 24 * 3_600_000;
const round2 = (x: number): number => +x.toFixed(2);

// OKX BTC option tick (BTC per BTC of underlying); off-tick prices are rejected outright.
export const OKX_OPTION_TICK_BTC = 0.0001;
export const floorTick = (px: number): number => Math.max(OKX_OPTION_TICK_BTC, +(Math.floor(px / OKX_OPTION_TICK_BTC + 1e-9) * OKX_OPTION_TICK_BTC).toFixed(8));

export type CapWatchConfig = {
  /** Distance to the cap (bps of mark) under which the wrap is "near" and a working order may rest. Default 35. */
  nearBps: number;
  /** Distance past which a resting order is recalled. Must exceed nearBps (hysteresis). Default 60. */
  recallBps: number;
  /** Re-price the resting order when the book's mid has moved by at least this many ticks. Default 2. */
  repriceTicks: number;
  /** Half-spread assumed on the buy-back, as a fraction of the leg's model value. Default 0.05. */
  spreadRelPct: number;
  /** Absolute half-spread floor on the buy-back, USDC. Default 1. */
  minSpreadUsdc: number;
  /**
   * Page the operator when one wrap's reserve (negative headroom) exceeds this many bps of the
   * wrapped notional. Default 300: an at-the-money weekly cap leg is worth ~200–250 bps of
   * notional, so a normal near-cap weekly reserve sits under the line and only an expensive
   * one (a vol spike, a wide book) pages. Bps, not dollars, so a 0.03 BTC wrap and a 3 BTC
   * wrap are judged by the same rule.
   */
  reserveAlertBps: number;
  /** Rest pre-touch working orders at all (okx lanes only; paper never places anything). */
  workingOrders: boolean;
};

export const DEFAULT_CAP_WATCH: CapWatchConfig = {
  nearBps: 35,
  recallBps: 60,
  repriceTicks: 2,
  spreadRelPct: 0.05,
  minSpreadUsdc: 1,
  reserveAlertBps: 300,
  workingOrders: false,
};

const numEnv = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

/** EP_PRETOUCH_NEAR_BPS / EP_PRETOUCH_RECALL_BPS / EP_HEADROOM_ALERT_BPS / EP_PRETOUCH_WORKING_ORDER. Junk keeps the default; recall never sits inside near. */
export const capWatchConfigFromEnv = (env: NodeJS.ProcessEnv): CapWatchConfig => {
  const nearBps = numEnv(env.EP_PRETOUCH_NEAR_BPS, DEFAULT_CAP_WATCH.nearBps);
  const recallRaw = numEnv(env.EP_PRETOUCH_RECALL_BPS, DEFAULT_CAP_WATCH.recallBps);
  return {
    ...DEFAULT_CAP_WATCH,
    nearBps,
    recallBps: Math.max(recallRaw, nearBps + 5),
    reserveAlertBps: numEnv(env.EP_HEADROOM_ALERT_BPS, DEFAULT_CAP_WATCH.reserveAlertBps),
    workingOrders: /^(1|true|on|yes)$/i.test(env.EP_PRETOUCH_WORKING_ORDER ?? ""),
  };
};

/** The reserve line for one wrap in dollars: the configured bps of its wrapped notional. */
export const reserveAlertUsdcFor = (cfg: CapWatchConfig, notionalUsdc: number): number =>
  +((Math.max(0, notionalUsdc) * cfg.reserveAlertBps) / 10000).toFixed(2);

// ── Headroom ────────────────────────────────────────────────────────────────

export type CapWatchState = "calm" | "near" | "touched";

export type HeadroomInput = {
  side: PerpSide;
  capStrike: number;
  floorStrike: number | null;
  markPx: number;
  nowMs: number;
  expiryMs: number;
  /** Covered size in BTC (OKX contracts × lot). */
  coveredBtc: number;
  /** The trader's full cycle credit and what has vested so far (linear, from the wrap record). */
  fullCreditUsdc: number;
  vestedUsdc: number;
  /** Our published take on this cycle, USDC (kept at a knock-out). 0 when unknown. */
  takeUsdc: number;
  /** Annualised mark vol of the sold cap leg (OKX opt-summary markVol), or null when unreadable. */
  capLegIv: number | null;
  /** Annualised mark vol of the bought floor leg, or null: recovery counts as zero. */
  floorLegIv: number | null;
  /** The sold leg's live ask in BTC (fallback cost when no vol is readable). */
  capLegAskBtc: number | null;
};

export type CapHeadroom = {
  state: CapWatchState;
  /** Mark's distance to the cap in bps of mark; ≤ 0 = at or through. */
  distanceBps: number;
  vestedUsdc: number;
  unvestedUsdc: number;
  takeUsdc: number;
  /** What buying back the sold leg would cost with the mark AT the cap now (ATM time value + half-spread). */
  buybackAtTouchUsdc: number;
  /** What selling the bought floor leg would recover at that moment (0 when unpriceable). */
  floorRecoveryUsdc: number;
  /** unvested + take + recovery − buyback. Negative = the writer's cost of a knock-out now. */
  headroomUsdc: number;
  /** max(0, −headroom): capital to hold against this wrap. */
  reserveUsdc: number;
  /** How the buy-back was priced. */
  priced: "mark_vol" | "live_ask" | "unpriced";
  hoursLeft: number;
};

/** Distance from the mark to the cap on the profit side, bps of mark. Negative once touched. */
export const capDistanceBps = (side: PerpSide, capStrike: number, markPx: number): number =>
  +((side === "long" ? (capStrike - markPx) / markPx : (markPx - capStrike) / markPx) * 10_000).toFixed(1);

export const capWatchState = (distanceBps: number, cfg: Pick<CapWatchConfig, "nearBps">): CapWatchState =>
  distanceBps <= 0 ? "touched" : distanceBps <= cfg.nearBps ? "near" : "calm";

/** Model value in USDC of one option leg with the spot pinned at `spotUsd`, on `coveredBtc`. */
const legValueUsdc = (type: "call" | "put", spotUsd: number, strike: number, timeLeftMs: number, iv: number, coveredBtc: number): number => {
  const T = Math.max(0, timeLeftMs) / YEAR_MS;
  const perBtc = type === "call" ? bsCall(spotUsd, strike, T, 0, iv) : bsPut(spotUsd, strike, T, 0, iv);
  return perBtc * coveredBtc;
};

export const capHeadroom = (input: HeadroomInput, cfg: Pick<CapWatchConfig, "nearBps" | "spreadRelPct" | "minSpreadUsdc">): CapHeadroom => {
  const distanceBps = capDistanceBps(input.side, input.capStrike, input.markPx);
  const state = capWatchState(distanceBps, cfg);
  const timeLeftMs = Math.max(0, input.expiryMs - input.nowMs);
  const unvested = Math.max(0, input.fullCreditUsdc - input.vestedUsdc);
  const spread = (v: number) => Math.max(cfg.minSpreadUsdc, cfg.spreadRelPct * v);
  const capType: "call" | "put" = input.side === "long" ? "call" : "put";
  const floorType: "call" | "put" = input.side === "long" ? "put" : "call";

  let buyback = 0;
  let priced: CapHeadroom["priced"] = "unpriced";
  if (input.capLegIv != null && input.capLegIv > 0 && timeLeftMs > 0) {
    // The mark AT the cap: the sold leg is exactly at the money, where its time value peaks.
    const v = legValueUsdc(capType, input.capStrike, input.capStrike, timeLeftMs, input.capLegIv, input.coveredBtc);
    buyback = v + spread(v);
    priced = "mark_vol";
  } else if (input.capLegAskBtc != null && input.capLegAskBtc > 0) {
    // No vol: the live ask is what it costs to buy back NOW — a floor on the at-touch cost while OTM.
    const v = input.capLegAskBtc * input.coveredBtc * input.markPx;
    buyback = v + spread(v);
    priced = "live_ask";
  }
  let recovery = 0;
  if (input.floorStrike != null && input.floorLegIv != null && input.floorLegIv > 0 && timeLeftMs > 0 && priced === "mark_vol") {
    const v = legValueUsdc(floorType, input.capStrike, input.floorStrike, timeLeftMs, input.floorLegIv, input.coveredBtc);
    recovery = Math.max(0, v - spread(v));
  }
  const headroom = unvested + input.takeUsdc + recovery - buyback;
  return {
    state,
    distanceBps,
    vestedUsdc: round2(input.vestedUsdc),
    unvestedUsdc: round2(unvested),
    takeUsdc: round2(input.takeUsdc),
    buybackAtTouchUsdc: round2(buyback),
    floorRecoveryUsdc: round2(recovery),
    headroomUsdc: round2(headroom),
    reserveUsdc: round2(Math.max(0, -headroom)),
    priced,
    hoursLeft: +(timeLeftMs / 3_600_000).toFixed(2),
  };
};

// ── Pre-touch working order ─────────────────────────────────────────────────

export type WorkingOrder = {
  instId: string;
  ordId: string;
  pxBtc: number;
  contracts: number;
  restedAtMs: number;
  /** Fills seen so far on this resting order (venue truth, refreshed each tick). */
  filledContracts: number;
  avgPxBtc: number | null;
};

export type WorkingOrderAction =
  | { kind: "none"; reason: string }
  | { kind: "hold"; reason: string }
  | { kind: "rest"; pxBtc: number; reason: string }
  | { kind: "replace"; pxBtc: number; reason: string }
  | { kind: "cancel"; reason: string };

/** The passive price for a buy: the book's mid floored to a tick, never at or above the ask. */
export const passiveBuyPxBtc = (book: { bidBtc: number | null; askBtc: number | null }): number | null => {
  if (book.askBtc == null || !(book.askBtc > 0)) return null;
  const ask = book.askBtc;
  const belowAsk = floorTick(ask - OKX_OPTION_TICK_BTC);
  if (book.bidBtc == null || !(book.bidBtc > 0) || book.bidBtc >= ask) return belowAsk;
  const mid = floorTick((book.bidBtc + ask) / 2);
  return Math.min(mid, belowAsk);
};

/**
 * What to do with the working order this tick. Pure: state, book and the resting order in, one
 * action out. `touched` always cancels (the IOC unwind takes over on venue truth); `calm` past the
 * recall line cancels; `near` rests at the passive price, or re-prices when the mid has walked.
 */
export const workingOrderAction = (
  headroom: Pick<CapHeadroom, "state" | "distanceBps">,
  order: WorkingOrder | null,
  book: { bidBtc: number | null; askBtc: number | null } | null,
  cfg: Pick<CapWatchConfig, "workingOrders" | "recallBps" | "repriceTicks">,
): WorkingOrderAction => {
  if (!cfg.workingOrders) return order ? { kind: "cancel", reason: "working orders disabled" } : { kind: "none", reason: "working orders disabled" };
  if (headroom.state === "touched") return order ? { kind: "cancel", reason: "cap touched — the IOC unwind takes over" } : { kind: "none", reason: "cap touched" };
  if (headroom.state === "calm") {
    if (order && headroom.distanceBps > cfg.recallBps) return { kind: "cancel", reason: `mark receded to ${headroom.distanceBps} bps, past the ${cfg.recallBps} bps recall line` };
    return order ? { kind: "hold", reason: "inside the recall band" } : { kind: "none", reason: "calm" };
  }
  // near
  const px = book ? passiveBuyPxBtc(book) : null;
  if (!order) {
    if (px == null) return { kind: "none", reason: "near, but the sold leg has no ask to price against" };
    return { kind: "rest", pxBtc: px, reason: `mark ${headroom.distanceBps} bps from the cap — rest a passive buy at ${px}` };
  }
  if (px != null && Math.abs(px - order.pxBtc) >= cfg.repriceTicks * OKX_OPTION_TICK_BTC - 1e-9) {
    return { kind: "replace", pxBtc: px, reason: `mid walked from ${order.pxBtc} to ${px}` };
  }
  return { kind: "hold", reason: "resting at the passive price" };
};

// ── Book-level roll-up ──────────────────────────────────────────────────────

export type CapWatchWrap = {
  wrapId: string;
  account: string;
  side: PerpSide;
  capStrike: number;
  headroom: CapHeadroom;
  order: WorkingOrder | null;
  /** What the working order had bought back when it was recalled at the touch (folded into the knock-out). */
  preTouch?: { filledContracts: number; avgPxBtc: number | null; costUsdc: number } | null;
  updatedAtMs: number;
};

export type CapWatchSummary = {
  wraps: number;
  near: number;
  touched: number;
  /** Sum of every wrap's reserve: capital the book should hold against knock-outs priced now. */
  reserveUsdc: number;
  /** Sum of headroom across wraps (a book-level view of whether knock-outs now would pay for themselves). */
  headroomUsdc: number;
  /** Wraps priced without a readable vol or ask (their reserve is 0 by construction: unknown, not safe). */
  unpriced: number;
  working: number;
  worst: { wrapId: string; headroomUsdc: number } | null;
};

export const summarizeCapWatch = (wraps: Iterable<CapWatchWrap>): CapWatchSummary => {
  const s: CapWatchSummary = { wraps: 0, near: 0, touched: 0, reserveUsdc: 0, headroomUsdc: 0, unpriced: 0, working: 0, worst: null };
  for (const w of wraps) {
    s.wraps += 1;
    if (w.headroom.state === "near") s.near += 1;
    if (w.headroom.state === "touched") s.touched += 1;
    if (w.headroom.priced === "unpriced") s.unpriced += 1;
    if (w.order) s.working += 1;
    s.reserveUsdc += w.headroom.reserveUsdc;
    s.headroomUsdc += w.headroom.headroomUsdc;
    if (w.headroom.priced !== "unpriced" && (!s.worst || w.headroom.headroomUsdc < s.worst.headroomUsdc)) s.worst = { wrapId: w.wrapId, headroomUsdc: w.headroom.headroomUsdc };
  }
  s.reserveUsdc = round2(s.reserveUsdc);
  s.headroomUsdc = round2(s.headroomUsdc);
  return s;
};

// ── OKX mark vols ───────────────────────────────────────────────────────────

/** `BTC-USD-260920-83000-C` → `260920`; null when the instId is not an OKX option id. */
export const expTimeOf = (instId: string): string | null => {
  const m = /^[A-Z]+-[A-Z]+-(\d{6})-\d+(?:\.\d+)?-[CP]$/.exec(instId);
  return m ? m[1] : null;
};

export type OptSummaryFetch = (url: string) => Promise<{ status: number; json: () => Promise<unknown> }>;

/**
 * OKX public option summary for one expiry: instId → annualised mark vol. Public endpoint, no
 * credentials; a bad status or shape throws so the caller falls back to the live ask, never to a
 * guessed vol.
 */
export const fetchOkxMarkVols = async (expTime: string, fetchImpl: OptSummaryFetch = fetch as unknown as OptSummaryFetch, uly = "BTC-USD"): Promise<Map<string, number>> => {
  const res = await fetchImpl(`https://www.okx.com/api/v5/public/opt-summary?uly=${encodeURIComponent(uly)}&expTime=${encodeURIComponent(expTime)}`);
  if (res.status !== 200) throw new Error(`okx opt-summary HTTP ${res.status}`);
  const j = (await res.json()) as { code?: string; data?: Array<{ instId?: string; markVol?: string }> };
  if (j.code !== "0" || !Array.isArray(j.data)) throw new Error(`okx opt-summary code ${j.code ?? "?"}`);
  const out = new Map<string, number>();
  for (const row of j.data) {
    const iv = Number(row.markVol);
    if (row.instId && Number.isFinite(iv) && iv > 0) out.set(row.instId, iv);
  }
  return out;
};
