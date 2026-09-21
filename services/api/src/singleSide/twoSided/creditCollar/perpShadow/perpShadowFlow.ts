/**
 * PERP SHADOW — FLOW, EARLY CLOSES, THE BOOK
 *
 * The shadow's first form was a metronome: one long and one short at a fixed size, every hour.
 * It proves pricing and settlement and says nothing about capacity or netting. This module makes
 * the shadow run like a book:
 *
 *   FLOW      Each hour opens a batch of simulated wraps that together reach a target notional
 *             (PERP_SHADOW_DAILY_NOTIONAL_USD / 24). Sizes are lognormal with a real tail
 *             (median PERP_SHADOW_MEDIAN_USD, sigma PERP_SHADOW_SIZE_SIGMA), capped at
 *             PERP_SHADOW_MAX_USD. Side mix PERP_SHADOW_LONG_SHARE. Every draw is seeded by the
 *             hour, so a restart re-plans the same batch and the ledger's id dedup keeps it once.
 *             Every wrap is priced at its own size by WALKING the book, so a large wrap pays real
 *             depth or is refused (`depth_insufficient`): the capacity signal.
 *
 *   CLOSES    A share of wraps (PERP_SHADOW_CLOSE_SHARE) is scheduled to close early, at a
 *             seeded fraction of its life. When due, the close is valued at LIVE prices: the
 *             holder exits the perp at the Hyperliquid mark and unwinds the collar at the OKX
 *             book, immediately (cross the spread: sell the floor at the bid, buy the cap back at
 *             the ask) and passively (both at mid). The difference is the execution edge the
 *             unwind queue is built to capture. Legs not in the live band are recorded as
 *             unpriced, never guessed.
 *
 *   BOOK      After every batch, the open book is netted by exact instrument: the writer's hedge
 *             is long the floor leg and short the cap leg of every wrap, so a long's short call
 *             and a short's long call at the same strike and expiry cancel, and every wrap at the
 *             same strike aggregates. Gross legs vs net legs, gross vs net OKX fees, gross vs net
 *             short-option margin (OKX's simple formula), and the book-walk slippage of hedging
 *             every leg vs one net order per instrument at the snapshot's depth. Exact-instrument netting only: portfolio margin
 *             across strikes would be lower still, so these are lower bounds on the saving.
 *
 * Real: OKX prices, depth, fees; Hyperliquid marks and funding. Simulated: sizes, sides, arrival
 * times, close decisions. The record says so on every page.
 */

import type { PerpSide } from "../creditCollarPricer";
import { OKX_FEE } from "../bullishFees";
import { topOf, walkBook, type OkxListedSnapshot } from "./okxListedSnapshot";
import type { PerpShadowPosition } from "./perpShadowLedger";

// ── Config ──────────────────────────────────────────────────────────────────

export interface FlowConfig {
  enabled: boolean;
  dailyNotionalUsd: number;
  medianUsd: number;
  /** lognormal sigma of size; 1.4 puts ~5% of wraps above 10× the median */
  sigma: number;
  maxUsd: number;
  minUsd: number;
  longShare: number;
  /** share of wraps scheduled to close before expiry */
  closeShare: number;
}

export const DEFAULT_FLOW: FlowConfig = {
  enabled: false,
  dailyNotionalUsd: 2_000_000,
  medianUsd: 15_000,
  sigma: 1.4,
  maxUsd: 750_000,
  minUsd: 1_000,
  longShare: 0.7,
  closeShare: 0.3,
};

export function flowConfigFromEnv(env: NodeJS.ProcessEnv): FlowConfig {
  const num = (v: string | undefined, d: number, lo = 0, hi = Number.POSITIVE_INFINITY): number => {
    const n = Number(v);
    return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= lo && n <= hi ? n : d;
  };
  return {
    enabled: /^(1|true|on|yes)$/i.test(String(env.PERP_SHADOW_FLOW ?? "")),
    dailyNotionalUsd: num(env.PERP_SHADOW_DAILY_NOTIONAL_USD, DEFAULT_FLOW.dailyNotionalUsd, 1_000),
    medianUsd: num(env.PERP_SHADOW_MEDIAN_USD, DEFAULT_FLOW.medianUsd, 100),
    sigma: num(env.PERP_SHADOW_SIZE_SIGMA, DEFAULT_FLOW.sigma, 0, 4),
    maxUsd: num(env.PERP_SHADOW_MAX_USD, DEFAULT_FLOW.maxUsd, 1_000),
    minUsd: num(env.PERP_SHADOW_MIN_USD, DEFAULT_FLOW.minUsd, 10),
    longShare: num(env.PERP_SHADOW_LONG_SHARE, DEFAULT_FLOW.longShare, 0, 1),
    closeShare: num(env.PERP_SHADOW_CLOSE_SHARE, DEFAULT_FLOW.closeShare, 0, 1),
  };
}

export function describeFlow(cfg: FlowConfig): string {
  return (
    `about $${(cfg.dailyNotionalUsd / 1e6).toFixed(1)}M of wraps a day in hourly batches; sizes lognormal around $${cfg.medianUsd.toLocaleString("en-US")} ` +
    `(sigma ${cfg.sigma}), capped at $${cfg.maxUsd.toLocaleString("en-US")}; ${Math.round(cfg.longShare * 100)}% long; ` +
    `${Math.round(cfg.closeShare * 100)}% close early at live prices; every wrap priced at its own size by walking the book`
  );
}

// ── Seeded randomness ───────────────────────────────────────────────────────

/** FNV-1a, so a batch key becomes a 32-bit seed the same way on every machine. */
export function seedFrom(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, and reproducible from a seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller from two uniforms. */
export function normal(next: () => number): number {
  const u = Math.max(next(), 1e-12);
  const v = next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ── Sizes and batches ───────────────────────────────────────────────────────

export type SizeClass = "small" | "medium" | "large";

/** The three buckets the demo's hero rotates through; the shadow labels wraps the same way. */
export const SIZE_CLASS_BOUNDS_USD = { smallMax: 25_000, mediumMax: 150_000 } as const;

export function sizeClassOf(notionalUsd: number): SizeClass {
  if (notionalUsd < SIZE_CLASS_BOUNDS_USD.smallMax) return "small";
  if (notionalUsd < SIZE_CLASS_BOUNDS_USD.mediumMax) return "medium";
  return "large";
}

export interface PlannedWrap {
  id: string;
  side: PerpSide;
  contracts: number;
  /** the size drawn, USD, before rounding to lots */
  targetUsd: number;
  sizeClass: SizeClass;
  /** fraction of the wrap's life at which it closes early; null = runs to expiry */
  closeAtFrac: number | null;
}

/** `2026-09-21T14` for the hour, the batch's key and id prefix. */
export const hourKey = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 13);

/**
 * Plan one hour's batch: draw sizes until the hour's share of the daily target is reached
 * (at least one wrap), each with a side and a close decision, all from one seeded stream.
 */
export function planHourBatch(key: string, spot: number, ctValBtc: number, cfg: FlowConfig): PlannedWrap[] {
  const next = rng(seedFrom(`perp-flow:${key}`));
  const hourlyTarget = cfg.dailyNotionalUsd / 24;
  const out: PlannedWrap[] = [];
  let filled = 0;
  // hard stop so a tiny median with a huge target cannot plan thousands of quotes in one tick
  while ((filled < hourlyTarget || out.length === 0) && out.length < 200) {
    const raw = cfg.medianUsd * Math.exp(cfg.sigma * normal(next));
    const usd = Math.min(cfg.maxUsd, Math.max(cfg.minUsd, raw));
    const contracts = Math.max(1, Math.round(usd / (spot * ctValBtc)));
    const side: PerpSide = next() < cfg.longShare ? "long" : "short";
    const closes = next() < cfg.closeShare;
    const closeAtFrac = closes ? +(0.1 + 0.8 * next()).toFixed(3) : null;
    out.push({ id: `${key.replace(/[-:T]/g, "")}-f${out.length + 1}`, side, contracts, targetUsd: Math.round(usd), sizeClass: sizeClassOf(usd), closeAtFrac });
    filled += contracts * ctValBtc * spot;
  }
  return out;
}

/** When a planned early close falls due, given the wrap's actual open and expiry. */
export function closeAtIso(openIso: string, expiryIso: string, closeAtFrac: number | null): string | null {
  if (closeAtFrac == null) return null;
  const open = Date.parse(openIso);
  const exp = Date.parse(expiryIso);
  if (!(exp > open)) return null;
  return new Date(Math.round(open + (exp - open) * closeAtFrac)).toISOString();
}

// ── Early close valuation ───────────────────────────────────────────────────

export interface PerpCloseLegs {
  floorBidBtc: number | null;
  floorAskBtc: number | null;
  capBidBtc: number | null;
  capAskBtc: number | null;
}

export interface PerpCloseValuation {
  markCents: number;
  legs: PerpCloseLegs;
  /** the collar's value to the holder unwound now, crossing the spread (sell floor at bid, buy cap at ask), cents; null when a leg is unpriced */
  unwindImmediateCents: number | null;
  /** the same at mids: what the unwind queue works toward */
  unwindPassiveCents: number | null;
}

/** Look both legs up in a live snapshot and value the unwind two ways. */
export function valueClose(p: Pick<PerpShadowPosition, "contracts" | "ctValBtc" | "buyInstId" | "sellInstId">, snap: OkxListedSnapshot, spot: number): PerpCloseValuation {
  const floor = topOf(snap.books[p.buyInstId]);
  const cap = topOf(snap.books[p.sellInstId]);
  const qty = p.contracts * p.ctValBtc;
  const legs: PerpCloseLegs = { floorBidBtc: floor.bidPxBtc, floorAskBtc: floor.askPxBtc, capBidBtc: cap.bidPxBtc, capAskBtc: cap.askPxBtc };
  const mid = (b: number | null, a: number | null): number | null => (b != null && a != null ? (a + b) / 2 : (b ?? a));
  const immediate = floor.bidPxBtc != null && cap.askPxBtc != null ? Math.round((floor.bidPxBtc - cap.askPxBtc) * qty * spot * 100) : null;
  const fm = mid(floor.bidPxBtc, floor.askPxBtc);
  const cm = mid(cap.bidPxBtc, cap.askPxBtc);
  const passive = fm != null && cm != null ? Math.round((fm - cm) * qty * spot * 100) : null;
  return { markCents: Math.round(spot * 100), legs, unwindImmediateCents: immediate, unwindPassiveCents: passive };
}

export interface PerpCloseOutcome {
  /** the perp alone from open to the close mark */
  nakedCents: number;
  /** perp + credit + the collar unwound immediately (what the holder gets today) */
  protectedCents: number | null;
  deltaCents: number | null;
  /** passive − immediate: the spread the writer's unwind queue can keep by working the legs */
  executionEdgeCents: number | null;
}

export function closeOutcome(p: Pick<PerpShadowPosition, "side" | "contracts" | "ctValBtc" | "spotCents" | "creditCents">, v: Pick<PerpCloseValuation, "markCents" | "unwindImmediateCents" | "unwindPassiveCents">): PerpCloseOutcome {
  const qty = p.contracts * p.ctValBtc;
  const naked = Math.round(qty * (v.markCents - p.spotCents) * (p.side === "long" ? 1 : -1));
  const prot = v.unwindImmediateCents == null ? null : naked + p.creditCents + v.unwindImmediateCents;
  return {
    nakedCents: naked,
    protectedCents: prot,
    deltaCents: prot == null ? null : prot - naked,
    executionEdgeCents: v.unwindImmediateCents != null && v.unwindPassiveCents != null ? v.unwindPassiveCents - v.unwindImmediateCents : null,
  };
}

// ── The book: exact-instrument netting ──────────────────────────────────────

export interface PerpBookInstrument {
  instId: string;
  expiryIso: string;
  strikeCents: number;
  optType: "put" | "call";
  /** contracts the writer is long across all wraps (floor legs) */
  longContracts: number;
  /** contracts the writer is short across all wraps (cap legs) */
  shortContracts: number;
  /** |long − short| */
  netContracts: number;
  /** +1 net long, −1 net short, 0 flat */
  netSign: -1 | 0 | 1;
}

export interface PerpBookTotals {
  positions: number;
  expiries: number;
  instruments: number;
  /** every wrap's two legs, in contracts */
  grossContracts: number;
  netContracts: number;
  /** 1 − net/gross: the share of hedge contracts netting removed */
  nettedShare: number | null;
  /** OKX taker fee on index notional, gross legs vs net legs (premium cap ignored: a lower bound on the saving is fine) */
  feeGrossCents: number;
  feeNetCents: number;
  /** OKX simple short-option margin: gross = every cap leg on its own; net = the net short per instrument */
  marginGrossCents: number;
  marginNetCents: number;
  /** book-walk cost above mid of hedging every leg (gross, in one book) vs one net order per instrument, cents; null when depth did not cover */
  slippageGrossCents: number | null;
  slippageNetCents: number | null;
  /** instruments whose book the snapshot did not have (their slippage is unknown, not zero) */
  unpricedInstruments: number;
}

export interface PerpBookRecord {
  type: "book";
  at: string;
  spotCents: number;
  totals: PerpBookTotals;
  instruments: PerpBookInstrument[];
}

const parseInst = (instId: string): { strike: number; optType: "put" | "call"; expiry: string } | null => {
  const m = /^[A-Z]+-USD-(\d{6})-(\d+(?:\.\d+)?)-([CP])$/.exec(instId);
  if (!m) return null;
  return { expiry: m[1], strike: Number(m[2]), optType: m[3] === "C" ? "call" : "put" };
};

/**
 * OKX's simple initial margin for a short option, per BTC of underlying:
 * max(0.10 × index, 0.15 × index − OTM amount) + mark, in USD. Long options post the premium only,
 * which both sides of the book already paid, so only net shorts carry margin here.
 */
export function shortOptionMarginUsd(spot: number, strike: number, optType: "put" | "call", markPxBtc: number, qtyBtc: number): number {
  const otm = optType === "call" ? Math.max(0, strike - spot) : Math.max(0, spot - strike);
  const perBtc = Math.max(0.1 * spot, 0.15 * spot - otm) + markPxBtc * spot;
  return perBtc * qtyBtc;
}

/**
 * Net the open book by exact instrument and price what netting saves at this snapshot.
 * Mark for margin is the instrument's mid when the book has it, else the leg's last quoted price.
 */
export function buildBook(open: PerpShadowPosition[], snap: OkxListedSnapshot | null, spot: number, atIso: string): PerpBookRecord {
  const byInst = new Map<string, PerpBookInstrument & { markPxBtc: number | null; ctValBtc: number; perWrapContracts: Array<{ contracts: number; side: "buy" | "sell" }> }>();
  const expiries = new Set<string>();
  let grossContracts = 0;
  const feeRate = OKX_FEE.clobTakerBps / 10_000;
  let feeGross = 0;
  let unpriced = 0;
  const seenUnpriced = new Set<string>();

  const midOf = (instId: string): number | null => {
    const t = topOf(snap?.books[instId]);
    return t.bidPxBtc != null && t.askPxBtc != null ? (t.bidPxBtc + t.askPxBtc) / 2 : (t.bidPxBtc ?? t.askPxBtc);
  };

  for (const p of open) {
    expiries.add(p.expiryIso);
    for (const leg of [
      { instId: p.buyInstId, side: "buy" as const, px: p.buyPxBtc },
      { instId: p.sellInstId, side: "sell" as const, px: p.sellPxBtc },
    ]) {
      const meta = parseInst(leg.instId);
      let row = byInst.get(leg.instId);
      if (!row) {
        row = {
          instId: leg.instId,
          expiryIso: p.expiryIso,
          strikeCents: Math.round((meta?.strike ?? 0) * 100),
          optType: meta?.optType ?? (leg.side === "buy" ? (p.side === "long" ? "put" : "call") : p.side === "long" ? "call" : "put"),
          longContracts: 0,
          shortContracts: 0,
          netContracts: 0,
          netSign: 0,
          markPxBtc: midOf(leg.instId) ?? leg.px,
          ctValBtc: p.ctValBtc,
          perWrapContracts: [],
        };
        byInst.set(leg.instId, row);
      }
      if (leg.side === "buy") row.longContracts += p.contracts;
      else row.shortContracts += p.contracts;
      row.perWrapContracts.push({ contracts: p.contracts, side: leg.side });
      grossContracts += p.contracts;
      feeGross += p.contracts * p.ctValBtc * spot * feeRate;
      if (!snap?.books[leg.instId] && !seenUnpriced.has(leg.instId)) {
        seenUnpriced.add(leg.instId);
        unpriced += 1;
      }
    }
  }

  let netContracts = 0;
  let feeNet = 0;
  let marginGross = 0;
  let marginNet = 0;
  let slipGross = 0;
  let slipKnown = true;
  let slipNet = 0;
  let slipNetKnown = true;
  const instruments: PerpBookInstrument[] = [];
  for (const row of byInst.values()) {
    const net = Math.abs(row.longContracts - row.shortContracts);
    const sign: -1 | 0 | 1 = row.longContracts === row.shortContracts ? 0 : row.longContracts > row.shortContracts ? 1 : -1;
    row.netContracts = net;
    row.netSign = sign;
    netContracts += net;
    feeNet += net * row.ctValBtc * spot * feeRate;
    const mark = row.markPxBtc ?? 0;
    const strike = row.strikeCents / 100;
    marginGross += shortOptionMarginUsd(spot, strike, row.optType, mark, row.shortContracts * row.ctValBtc);
    if (sign === -1) marginNet += shortOptionMarginUsd(spot, strike, row.optType, mark, net * row.ctValBtc);
    // Slippage in one book: leg for leg, every buy walks the asks and every sell walks the bids for the
    // full gross size (the top of the book is only there once); net walks one side for the net size.
    const d = snap?.books[row.instId];
    const mid = midOf(row.instId);
    const slipOf = (levels: { pxBtc: number; contracts: number }[], contracts: number): number | null => {
      if (contracts === 0) return 0;
      if (!d || mid == null) return null;
      const w = walkBook(levels, contracts);
      return w ? Math.abs(w.avgPxBtc - mid) * contracts * row.ctValBtc * spot : null;
    };
    const gBuy = slipOf(d?.asks ?? [], row.longContracts);
    const gSell = slipOf(d?.bids ?? [], row.shortContracts);
    if (gBuy == null || gSell == null) slipKnown = false;
    else slipGross += gBuy + gSell;
    const n = slipOf(sign === 1 ? d?.asks ?? [] : d?.bids ?? [], net);
    if (n == null) slipNetKnown = false;
    else slipNet += n;
    const { markPxBtc: _m, ctValBtc: _c, perWrapContracts: _w, ...pub } = row;
    instruments.push(pub);
  }
  instruments.sort((a, b) => a.expiryIso.localeCompare(b.expiryIso) || a.strikeCents - b.strikeCents || a.optType.localeCompare(b.optType));

  const c = (usd: number): number => Math.round(usd * 100);
  return {
    type: "book",
    at: atIso,
    spotCents: Math.round(spot * 100),
    totals: {
      positions: open.length,
      expiries: expiries.size,
      instruments: instruments.length,
      grossContracts,
      netContracts,
      nettedShare: grossContracts > 0 ? +(1 - netContracts / grossContracts).toFixed(4) : null,
      feeGrossCents: c(feeGross),
      feeNetCents: c(feeNet),
      marginGrossCents: c(marginGross),
      marginNetCents: c(marginNet),
      slippageGrossCents: slipKnown ? c(slipGross) : null,
      slippageNetCents: slipKnown && slipNetKnown ? c(slipNet) : null,
      unpricedInstruments: unpriced,
    },
    instruments,
  };
}

// ── Summary for the page ────────────────────────────────────────────────────

export interface PerpFlowSummary {
  enabled: boolean;
  rule: string | null;
  /** wraps by size class, opened */
  bySize: Record<SizeClass, { positions: number; notionalCents: number; creditCents: number; refused: number }>;
  /** refusals whose reason was depth: the capacity signal, by size class */
  depthRefusals: Record<SizeClass, number>;
  /** notional opened per calendar day (UTC), latest 14 days, cents */
  notionalByDay: Array<{ day: string; notionalCents: number; positions: number }>;
  closes: {
    scheduled: number;
    done: number;
    /** legs unpriced at close (recorded, never guessed) */
    unpriced: number;
    holderDeltaCents: number;
    unwindImmediateCents: number;
    unwindPassiveCents: number;
    /** passive − immediate summed: what working the legs would have kept */
    executionEdgeCents: number;
  };
  book: {
    latest: (PerpBookTotals & { at: string }) | null;
    snapshots: number;
    /** averages over the last 24h of snapshots */
    avgNettedShare: number | null;
    avgFeeSavedCents: number | null;
    avgMarginSavedCents: number | null;
    avgSlippageSavedCents: number | null;
  };
}

export interface FlowRefusalLike {
  at: string;
  contracts: number;
  spotCents: number;
  error: string;
  sizeClass?: SizeClass;
}

export function summarizeFlow(positions: PerpShadowPosition[], refusals: FlowRefusalLike[], books: PerpBookRecord[], cfg: FlowConfig): PerpFlowSummary {
  const empty = () => ({ positions: 0, notionalCents: 0, creditCents: 0, refused: 0 });
  const s: PerpFlowSummary = {
    enabled: cfg.enabled,
    rule: cfg.enabled ? describeFlow(cfg) : null,
    bySize: { small: empty(), medium: empty(), large: empty() },
    depthRefusals: { small: 0, medium: 0, large: 0 },
    notionalByDay: [],
    closes: { scheduled: 0, done: 0, unpriced: 0, holderDeltaCents: 0, unwindImmediateCents: 0, unwindPassiveCents: 0, executionEdgeCents: 0 },
    book: { latest: null, snapshots: books.length, avgNettedShare: null, avgFeeSavedCents: null, avgMarginSavedCents: null, avgSlippageSavedCents: null },
  };
  const days = new Map<string, { notionalCents: number; positions: number }>();
  for (const p of positions) {
    const cls = p.flow?.sizeClass ?? sizeClassOf(p.notionalCents / 100);
    s.bySize[cls].positions += 1;
    s.bySize[cls].notionalCents += p.notionalCents;
    s.bySize[cls].creditCents += p.creditCents;
    const day = p.at.slice(0, 10);
    const d = days.get(day) ?? { notionalCents: 0, positions: 0 };
    d.notionalCents += p.notionalCents;
    d.positions += 1;
    days.set(day, d);
    if (p.flow?.closeAtIso) s.closes.scheduled += 1;
    if (p.status === "closed") {
      s.closes.done += 1;
      const o = p.closeOutcome;
      if (!o || o.deltaCents == null) s.closes.unpriced += 1;
      else {
        s.closes.holderDeltaCents += o.deltaCents;
        s.closes.unwindImmediateCents += p.closeValuation?.unwindImmediateCents ?? 0;
        s.closes.unwindPassiveCents += p.closeValuation?.unwindPassiveCents ?? 0;
        s.closes.executionEdgeCents += o.executionEdgeCents ?? 0;
      }
    }
  }
  for (const r of refusals) {
    const cls = r.sizeClass ?? sizeClassOf((r.contracts * 0.01 * r.spotCents) / 100);
    s.bySize[cls].refused += 1;
    if (r.error === "depth_insufficient") s.depthRefusals[cls] += 1;
  }
  s.notionalByDay = [...days.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 14)
    .map(([day, d]) => ({ day, ...d }));

  if (books.length > 0) {
    const latest = books[books.length - 1];
    s.book.latest = { at: latest.at, ...latest.totals };
    const cutoff = Date.parse(latest.at) - 24 * 3_600_000;
    const recent = books.filter((b) => Date.parse(b.at) >= cutoff && b.totals.grossContracts > 0);
    if (recent.length > 0) {
      const avg = (f: (t: PerpBookTotals) => number | null): number | null => {
        const vals = recent.map((b) => f(b.totals)).filter((v): v is number => v != null);
        return vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(vals.length && Math.abs(vals[0]) < 10 ? 4 : 0) : null;
      };
      s.book.avgNettedShare = avg((t) => t.nettedShare);
      s.book.avgFeeSavedCents = avg((t) => t.feeGrossCents - t.feeNetCents);
      s.book.avgMarginSavedCents = avg((t) => t.marginGrossCents - t.marginNetCents);
      s.book.avgSlippageSavedCents = avg((t) => (t.slippageGrossCents != null && t.slippageNetCents != null ? t.slippageGrossCents - t.slippageNetCents : null));
    }
  }
  return s;
}
