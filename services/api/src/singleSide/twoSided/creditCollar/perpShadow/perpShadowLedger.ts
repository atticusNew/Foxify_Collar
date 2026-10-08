/**
 * The perp shadow ledger: the Earn & Protect collar quoted continuously from
 * the live OKX book at the demo's own terms, every quote a simulated position,
 * every position settled on the price PATH (Hyperliquid candles: did the cap
 * get touched, and when) and the venue's official delivery print.
 *
 * The collar is a knock-out. A cap touch ends the cycle: the holder keeps the
 * position and every gain, is paid the credit vested to that moment, and
 * protection re-arms. The writer buys the short funding leg back at the money
 * and keeps the unvested credit against that cost. So the questions the
 * shadow answers are not "which tier" but: how far out should the cap sit,
 * how often does it get touched, what does a touch cost, do touches cluster,
 * and does the hedge venue's clock agree with the trigger's.
 *
 * Append-only JSONL, replayed on every read; money in integer cents; nothing
 * edited in place. Each open also carries what the OTHER rules would have
 * written from the same snapshot (every listed cap distance, the fee rule,
 * larger sizes, the weekly), so the rule comparison is measured, not argued.
 */

import type { CapMode } from "../demoWrap";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { PerpSide } from "../creditCollarPricer";
import type { EpTenor } from "../perpTenor";
import { summarizeVenueReference, type PerpVenueReference, type PerpVenueReferenceSummary } from "./venueReference";
import { closeOutcome, type PerpBookRecord, type PerpCloseOutcome, type PerpCloseValuation, type PerpFlowSummary, type SizeClass } from "./perpShadowFlow";

export type PerpTakeRule = "share" | "minimum" | "waived";

export interface PerpAltTerms {
  ok: true;
  floorStrikeCents: number;
  capStrikeCents: number;
  floorPct: number;
  capPct: number;
  buyInstId: string;
  sellInstId: string;
  buyPxBtc: number;
  sellPxBtc: number;
  grossCreditCents: number;
  venueFeeCents: number;
  netCreditCents: number;
  takeCents: number;
  takeRule: PerpTakeRule;
  creditCents: number;
  midCreditCents: number | null;
  levelsUsed: { buy: number; sell: number };
  /** market-implied odds of finishing past this cap at open; absent on records before the cap rule */
  capExceedProb?: number | null;
}
export interface PerpAltRefusal {
  ok: false;
  error: string;
  message: string;
}
export type PerpAlt = PerpAltTerms | PerpAltRefusal;

export interface PerpSizeProbe {
  mult: number;
  contracts: number;
  terms: PerpAlt;
}

export interface PerpFeeRuleAlt {
  rule: string;
  takeCents: number;
  creditCents: number;
  takeRule: PerpTakeRule;
  /** the rule would have refused: the take would consume the whole credit */
  refused: boolean;
}

/** The same geometry at another expiry; compared on quoted terms (it settles on a different print). */
export type PerpTenorAlt = (PerpAltTerms & { expiryIso: string }) | PerpAltRefusal;

/**
 * One rung of the cap-distance ladder: the live floor held fixed, the funding
 * wing moved to this listed strike. Settled on the same path as the live
 * position, so each rung shows its own knock-out rate and cost.
 */
export interface PerpCapRung {
  sellInstId: string;
  capStrikeCents: number;
  /** distance from spot, fraction */
  capPct: number;
  /** the live pick (the widest strike that paid) */
  live: boolean;
  /** sits closer than the cap guard: the live product refuses to write here */
  underGuard: boolean;
  /** market-implied chance the cycle settles beyond this rung (the rung's mark vol); null when unreadable */
  exceedProb?: number | null;
  terms: PerpAlt;
}

/**
 * One rung of the floor ladder: the collar re-quoted with the floor at this depth (the cap found
 * by the live cap rule at each), same size, expiry and instant. Settled on the same path, so
 * each depth shows what it paid, how often it was needed and what the holder netted.
 */
export interface PerpFloorRung {
  /** floor depth from spot, fraction (the target; the listed strike is the nearest at or beyond it) */
  floorPct: number;
  /** the live geometry's floor */
  live: boolean;
  terms: PerpAlt;
}

export interface PerpShadowCounterfactuals {
  version: 2;
  capLadder: PerpCapRung[];
  feeRules: Record<string, PerpFeeRuleAlt>;
  sizeLadder: PerpSizeProbe[];
  tenors: Record<string, PerpTenorAlt>;
  /** absent on records before the floor ladder (2026-09-20) */
  floorLadder?: PerpFloorRung[];
}

/** The ATM ask seen at open: the knock-out buyback is estimated from the nearest scan's. */
export interface PerpAtmRef {
  callAskPxBtc: number | null;
  putAskPxBtc: number | null;
  hoursToExpiry: number;
}

export interface PerpShadowOpenRecord {
  type: "open";
  at: string;
  id: string;
  side: PerpSide;
  contracts: number;
  ctValBtc: number;
  /** contracts × ctVal × spot */
  notionalCents: number;
  /** Hyperliquid mark at open: the position's price */
  spotCents: number;
  /** OKX BTC-USD index at open, the hedge venue's price; null when unreadable */
  okxIndexCents: number | null;
  /** (HL mark − OKX index) / OKX index, bps; the basis the hedge carries */
  basisBps: number | null;
  /** Hyperliquid funding at open, bps per 8h; what holding the perp costs meanwhile */
  fundingBpsPer8h: number | null;
  /** funding over the cycle at that rate, cents; positive = the holder pays; null when funding unreadable */
  fundingCycleCents: number | null;
  expiryIso: string;
  /** the expiry the live collar was written to; absent on records from before the tenor was recorded (daily) */
  tenor?: EpTenor;
  /** the cap guard in force at open, fraction: a cap closer than this is refused live */
  capGuardPct: number;
  /** market-implied chance the cycle settles beyond the live cap at open; null when no vol was readable */
  capExceedProb?: number | null;
  /** which cap rule decided the live strike (`widest` for every record before the rule existed) */
  capRuleApplied?: "widest" | "target";
  /**
   * What the counterfactual FLOOR RULE (floorRule.ts, `tightest_paying`) would have picked from this
   * quote's floor ladder, so the default depth changes on a measured number. Absent before 2026-09-20.
   */
  floorRulePick?: { rule: string; floorPct: number | null; by: "fixed" | "clears_minimum" | "best_paying" | "none" } | null;
  /**
   * The same two legs read at Deribit and Bullish the second OKX quoted them (venueReference.ts):
   * would the identical collar have paid more elsewhere. A reference, never the price. Absent
   * before 2026-09-20 and when the worker runs with PERP_SHADOW_VENUE_REF=0.
   */
  venueReference?: PerpVenueReference | null;
  buyInstId: string;
  sellInstId: string;
  floorStrikeCents: number;
  capStrikeCents: number;
  floorPct: number;
  capPct: number;
  buyPxBtc: number;
  sellPxBtc: number;
  grossCreditCents: number;
  venueFeeCents: number;
  /** gross − venue fee: what the market funded */
  netCreditCents: number;
  takeCents: number;
  takeRule: PerpTakeRule;
  takeShareCents: number;
  takeMinimumCents: number;
  /** net − take: what the holder is paid */
  creditCents: number;
  /** the collar valued at venue mids; the spread we pay is mid − net */
  midCreditCents: number | null;
  atmRef: PerpAtmRef | null;
  counterfactuals: PerpShadowCounterfactuals | null;
  /** flow mode (perpShadowFlow.ts): the size drawn, its class, and when it is scheduled to close early (null = runs to expiry) */
  flow?: { sizeClass: SizeClass; targetUsd: number; closeAtIso: string | null };
}

export interface PerpShadowRefusalRecord {
  type: "refusal";
  at: string;
  side: PerpSide;
  contracts: number;
  spotCents: number;
  error: string;
  message: string;
  /** flow mode: the planned wrap's id (so a restart does not re-refuse the same plan) and size class */
  id?: string;
  sizeClass?: SizeClass;
}

export interface PerpPathTouch {
  capStrikeCents: number;
  atIso: string;
  /** the Hyperliquid candle extreme that reached the cap */
  hlPxCents: number;
  /** the OKX index extreme in the minutes around it; null when no candle covered the window */
  okxPxCents: number | null;
  /** did the hedge venue's index reach the cap too (null = unknown) */
  okxConfirmed: boolean | null;
  /** OKX extreme vs the cap, bps (negative = OKX did not reach it) */
  okxGapBps: number | null;
}

/** The price path from open to expiry, and the first touch of every cap the position or its rungs used. */
export interface PerpPath {
  source: "hl_candles";
  interval: "1m" | "5m";
  candles: number;
  hiCents: number;
  loCents: number;
  touches: PerpPathTouch[];
}

export interface PerpShadowSettleRecord {
  type: "settle";
  at: string;
  id: string;
  settleCents: number;
  source: "okx_delivery" | "hl_mark";
  /** absent on records written before path settlement */
  path?: PerpPath | null;
}

export interface PerpShadowVoidRecord {
  type: "void";
  at: string;
  id: string;
  reason: string;
}

/** An early close at live prices: the holder leaves the perp at the mark and unwinds the collar at the OKX book. */
export interface PerpShadowCloseRecord {
  type: "close";
  at: string;
  id: string;
  valuation: PerpCloseValuation;
}

export type PerpShadowRecord = PerpShadowOpenRecord | PerpShadowRefusalRecord | PerpShadowSettleRecord | PerpShadowVoidRecord | PerpShadowCloseRecord | PerpBookRecord;

export interface PerpShadowPosition extends Omit<PerpShadowOpenRecord, "type"> {
  status: "open" | "settled" | "void" | "closed";
  settledAt?: string;
  settleCents?: number;
  settleSource?: PerpShadowSettleRecord["source"];
  path?: PerpPath | null;
  voidReason?: string;
  outcome?: PerpOutcome;
  closedAt?: string;
  closeValuation?: PerpCloseValuation;
  closeOutcome?: PerpCloseOutcome;
}

export interface PerpOutcome {
  nakedCents: number;
  protectedCents: number;
  /** protected − naked: what protection did for the holder */
  deltaCents: number;
  floorSave: boolean;
  /** the cap was reached: on the path (knock-out at the touch) or, without a path, at the print */
  capHit: boolean;
  /** the cycle ended early at a cap touch */
  knockedOut: boolean;
  touchedAtIso: string | null;
  /** share of the credit vested when the cycle ended (1 = ran to expiry) */
  vestedFraction: number;
  /** the holder's cash: the credit × vested fraction */
  paidCents: number;
  /**
   * knockout: the estimated cost of buying the short funding leg back at the touch (ATM ask at
   * the remaining time), the writer's cost. plain: the same number as the RELEASE price the
   * holder would have paid at the touch to keep the upside (informational; nobody paid it).
   */
  buybackCents: number;
  /** plain: gains above the cap on the covered size at the print, handed back by the holder (0 in knockout mode) */
  capExcessCents: number;
  /** the writer's side: knockout = take + unvested kept − buyback; plain = the take (hedged leg for leg) */
  writerCents: number;
}

/** How the shadow settles the cap (mirrors the demo's EP_CAP_MODE; plain is the product). */
export type PerpCapMode = CapMode;
export const DEFAULT_PERP_CAP_MODE: PerpCapMode = "plain";

/** Cents of P&L on `qtyBtc` from `fromCents` to `toCents`, signed for the side. */
const pnlCents = (side: PerpSide, qtyBtc: number, fromCents: number, toCents: number): number =>
  Math.round(qtyBtc * (toCents - fromCents) * (side === "long" ? 1 : -1));

export interface PerpSettleContext {
  /** the touch of THIS cap on the path, if any */
  touch?: PerpPathTouch | null;
  /** a path was recorded (so "no touch" is a fact, not an absence of data) */
  hasPath: boolean;
  openMs: number;
  expiryMs: number;
  /** the ATM ask to estimate the buyback from (the nearest scan's), BTC per BTC, and its time to expiry */
  atm?: { askPxBtc: number; hoursToExpiry: number } | null;
}

/**
 * Buyback estimate at a touch: the ATM ask a nearby scan saw, scaled by
 * √(time remaining) — time value is what an ATM option is — priced at the
 * cap (spot is at the cap when it touches). Null reference → 0, and the
 * summary counts how many knock-outs were priced blind.
 */
export const buybackEstimateCents = (
  qtyBtc: number,
  capStrikeCents: number,
  hoursLeftAtTouch: number,
  atm: { askPxBtc: number; hoursToExpiry: number } | null | undefined,
): number => {
  if (!atm || !(atm.askPxBtc > 0) || !(atm.hoursToExpiry > 0)) return 0;
  const scale = Math.sqrt(Math.max(0, hoursLeftAtTouch) / atm.hoursToExpiry);
  return Math.round(atm.askPxBtc * scale * qtyBtc * capStrikeCents);
};

/**
 * The holder's two worlds at settlement.
 *
 * Ran to expiry: the floor clamps the exit on the loss side; the full credit
 * is theirs. Knocked out on the path: the cycle ended at the touch, the
 * position kept running naked from there (re-arming is the next cycle's
 * story), and the credit vested to the touch is paid. Without a path (older
 * records) the print alone decides and a print beyond the cap is a knock-out
 * at expiry with the intrinsic as the buyback.
 *
 * The writer's side is the take, plus the unvested credit kept at a
 * knock-out, minus the buyback of the short leg. The floor leg is bought and
 * held, so it cancels against the holder's terms leg for leg.
 */
export function perpOutcome(
  p: Pick<PerpShadowOpenRecord, "side" | "contracts" | "ctValBtc" | "spotCents" | "floorStrikeCents" | "capStrikeCents" | "creditCents" | "takeCents">,
  settleCents: number,
  ctx?: PerpSettleContext,
  capMode: PerpCapMode = DEFAULT_PERP_CAP_MODE,
): PerpOutcome {
  const qty = p.contracts * p.ctValBtc;
  const naked = pnlCents(p.side, qty, p.spotCents, settleCents);
  const floorSaveAtPrint = p.side === "long" ? settleCents < p.floorStrikeCents : settleCents > p.floorStrikeCents;
  const beyondCapAtPrint = p.side === "long" ? settleCents > p.capStrikeCents : settleCents < p.capStrikeCents;
  const floored = p.side === "long" ? Math.max(p.floorStrikeCents, settleCents) : Math.min(p.floorStrikeCents, settleCents);

  if (capMode === "plain") {
    // The plain collar runs to expiry: the exit is clamped at BOTH wings. Gains above the cap are
    // handed back (they paid for the floor); the full credit is the holder's; the hedge is held
    // leg for leg so the writer's side is the take. A touch on the path closed nothing; it is
    // recorded as the moment a release was on offer, with what it would have cost.
    const clamped = p.side === "long" ? Math.min(p.capStrikeCents, floored) : Math.max(p.capStrikeCents, floored);
    const protectedPnl = pnlCents(p.side, qty, p.spotCents, clamped) + p.creditCents;
    const excess = beyondCapAtPrint ? Math.round(qty * Math.abs(settleCents - p.capStrikeCents)) : 0;
    const touch = ctx?.touch ?? null;
    let releaseAtTouch = 0;
    if (touch && ctx) {
      const hoursLeft = Math.max(0, (ctx.expiryMs - Date.parse(touch.atIso)) / 3_600_000);
      releaseAtTouch = buybackEstimateCents(qty, p.capStrikeCents, hoursLeft, ctx.atm);
    }
    return {
      nakedCents: naked,
      protectedCents: protectedPnl,
      deltaCents: protectedPnl - naked,
      floorSave: floorSaveAtPrint,
      capHit: beyondCapAtPrint,
      knockedOut: false,
      touchedAtIso: touch?.atIso ?? null,
      vestedFraction: 1,
      paidCents: p.creditCents,
      buybackCents: releaseAtTouch,
      capExcessCents: excess,
      writerCents: p.takeCents,
    };
  }

  if (ctx?.touch) {
    const touchMs = Date.parse(ctx.touch.atIso);
    const span = Math.max(1, ctx.expiryMs - ctx.openMs);
    const vested = Math.min(1, Math.max(0, (touchMs - ctx.openMs) / span));
    const paid = Math.round(p.creditCents * vested);
    const hoursLeft = Math.max(0, (ctx.expiryMs - touchMs) / 3_600_000);
    const buyback = buybackEstimateCents(qty, p.capStrikeCents, hoursLeft, ctx.atm);
    const protectedPnl = naked + paid;
    return {
      nakedCents: naked,
      protectedCents: protectedPnl,
      deltaCents: protectedPnl - naked,
      floorSave: false,
      capHit: true,
      knockedOut: true,
      touchedAtIso: ctx.touch.atIso,
      vestedFraction: +vested.toFixed(4),
      paidCents: paid,
      buybackCents: buyback,
      capExcessCents: 0,
      writerCents: p.takeCents + (p.creditCents - paid) - buyback,
    };
  }

  if (ctx?.hasPath || !beyondCapAtPrint) {
    // Ran to expiry without a touch (or a legacy print inside the wings): floor only.
    const protectedPnl = pnlCents(p.side, qty, p.spotCents, floored) + p.creditCents;
    // A print beyond the cap with no touch on the path means the last candle carried it there: knock-out at expiry.
    if (beyondCapAtPrint) {
      const intrinsic = Math.round(qty * Math.abs(settleCents - p.capStrikeCents));
      return {
        nakedCents: naked,
        protectedCents: naked + p.creditCents,
        deltaCents: p.creditCents,
        floorSave: false,
        capHit: true,
        knockedOut: true,
        touchedAtIso: new Date(ctx!.expiryMs).toISOString(),
        vestedFraction: 1,
        paidCents: p.creditCents,
        buybackCents: intrinsic,
        capExcessCents: 0,
        writerCents: p.takeCents - intrinsic,
      };
    }
    return {
      nakedCents: naked,
      protectedCents: protectedPnl,
      deltaCents: protectedPnl - naked,
      floorSave: floorSaveAtPrint,
      capHit: false,
      knockedOut: false,
      touchedAtIso: null,
      vestedFraction: 1,
      paidCents: p.creditCents,
      buybackCents: 0,
      capExcessCents: 0,
      writerCents: p.takeCents,
    };
  }

  // Legacy (no path): the print is beyond the cap. Treat as a knock-out at expiry with the intrinsic as the buyback.
  const intrinsic = Math.round(qty * Math.abs(settleCents - p.capStrikeCents));
  return {
    nakedCents: naked,
    protectedCents: naked + p.creditCents,
    deltaCents: p.creditCents,
    floorSave: false,
    capHit: true,
    knockedOut: true,
    touchedAtIso: null,
    vestedFraction: 1,
    paidCents: p.creditCents,
    buybackCents: intrinsic,
    capExcessCents: 0,
    writerCents: p.takeCents - intrinsic,
  };
}

const touchFor = (path: PerpPath | null | undefined, capStrikeCents: number): PerpPathTouch | null =>
  path?.touches.find((t) => t.capStrikeCents === capStrikeCents) ?? null;

/**
 * The ATM reference for a touch: the scan nearest in time to it, on either
 * side, that saw an ask for the leg we are short (a long is short the call,
 * a short is short the put).
 */
export const nearestAtm = (
  positions: Array<Pick<PerpShadowPosition, "at" | "expiryIso" | "atmRef">>,
  side: PerpSide,
  expiryIso: string,
  touchMs: number,
): { askPxBtc: number; hoursToExpiry: number } | null => {
  let best: { askPxBtc: number; hoursToExpiry: number } | null = null;
  let bestDist = Infinity;
  for (const p of positions) {
    if (p.expiryIso !== expiryIso || !p.atmRef) continue;
    const ask = side === "long" ? p.atmRef.callAskPxBtc : p.atmRef.putAskPxBtc;
    if (ask == null || !(ask > 0)) continue;
    const d = Math.abs(Date.parse(p.at) - touchMs);
    if (d < bestDist) {
      bestDist = d;
      best = { askPxBtc: ask, hoursToExpiry: p.atmRef.hoursToExpiry };
    }
  }
  return best;
};

const settleCtx = (p: PerpShadowPosition, capStrikeCents: number, all: PerpShadowPosition[]): PerpSettleContext => {
  const touch = touchFor(p.path, capStrikeCents);
  return {
    touch,
    hasPath: p.path != null,
    openMs: Date.parse(p.at),
    expiryMs: Date.parse(p.expiryIso),
    atm: touch ? nearestAtm(all, p.side, p.expiryIso, Date.parse(touch.atIso)) : null,
  };
};

/** The same outcome for an alternative's terms on the same position, path and print. */
export function altOutcome(p: PerpShadowPosition, alt: PerpAltTerms, settleCents: number, all: PerpShadowPosition[] = [p], capMode: PerpCapMode = DEFAULT_PERP_CAP_MODE): PerpOutcome {
  return perpOutcome(
    {
      side: p.side,
      contracts: p.contracts,
      ctValBtc: p.ctValBtc,
      spotCents: p.spotCents,
      floorStrikeCents: alt.floorStrikeCents,
      capStrikeCents: alt.capStrikeCents,
      creditCents: alt.creditCents,
      takeCents: alt.takeCents,
    },
    settleCents,
    settleCtx(p, alt.capStrikeCents, all),
    capMode,
  );
}

export interface PerpReplayOptions {
  capMode?: PerpCapMode;
}

export function appendPerpShadowRecord(path: string, record: PerpShadowRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

export function perpLedgerStats(path: string): { exists: boolean; bytes: number; records: number } {
  if (!existsSync(path)) return { exists: false, bytes: 0, records: 0 };
  const raw = readFileSync(path, "utf8");
  return { exists: true, bytes: statSync(path).size, records: raw.split("\n").filter((l) => l.trim()).length };
}

export function loadPerpShadowRecords(path: string): PerpShadowRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PerpShadowRecord);
}

export function replayPerpShadow(
  records: PerpShadowRecord[],
  opts: PerpReplayOptions = {},
): { positions: PerpShadowPosition[]; refusals: PerpShadowRefusalRecord[]; books: PerpBookRecord[] } {
  const capMode = opts.capMode ?? DEFAULT_PERP_CAP_MODE;
  const byId = new Map<string, PerpShadowPosition>();
  const refusals: PerpShadowRefusalRecord[] = [];
  const books: PerpBookRecord[] = [];
  const refusalIds = new Set<string>();
  for (const r of records) {
    if (r.type === "open") {
      if (byId.has(r.id)) continue;
      const { type: _t, ...rest } = r;
      byId.set(r.id, { ...rest, status: "open" });
    } else if (r.type === "refusal") {
      // flow refusals carry the plan's id: a restart that re-plans the hour must not count it twice
      if (r.id) {
        if (refusalIds.has(r.id)) continue;
        refusalIds.add(r.id);
      }
      refusals.push(r);
    } else if (r.type === "book") {
      books.push(r);
    } else if (r.type === "close") {
      const p = byId.get(r.id);
      if (!p || p.status !== "open") continue;
      p.status = "closed";
      p.closedAt = r.at;
      p.closeValuation = r.valuation;
      p.closeOutcome = closeOutcome(p, r.valuation);
    } else if (r.type === "settle") {
      const p = byId.get(r.id);
      if (!p || p.status !== "open") continue;
      p.status = "settled";
      p.settledAt = r.at;
      p.settleCents = r.settleCents;
      p.settleSource = r.source;
      p.path = r.path ?? null;
    } else if (r.type === "void") {
      const p = byId.get(r.id);
      if (!p || p.status !== "open") continue;
      p.status = "void";
      p.voidReason = r.reason;
    }
  }
  // Outcomes last: a knock-out's buyback reads the ATM ask from the scan nearest the touch, which
  // may be a later open than the position itself.
  const positions = [...byId.values()];
  for (const p of positions) {
    if (p.status === "settled" && p.settleCents != null) p.outcome = perpOutcome(p, p.settleCents, settleCtx(p, p.capStrikeCents, positions), capMode);
  }
  return { positions, refusals, books };
}

/** Ids already in the ledger (opens and flow refusals): what a re-planned batch must skip. */
export function plannedIdsIn(records: PerpShadowRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const r of records) {
    if (r.type === "open") ids.add(r.id);
    else if (r.type === "refusal" && r.id) ids.add(r.id);
  }
  return ids;
}

export function loadPerpShadow(path: string, opts: PerpReplayOptions = {}): { positions: PerpShadowPosition[]; refusals: PerpShadowRefusalRecord[]; books: PerpBookRecord[] } {
  return replayPerpShadow(loadPerpShadowRecords(path), opts);
}

// ── Summary ─────────────────────────────────────────────────────────────────

export interface PerpRuleBook {
  quoted: number;
  refused: number;
  notionalCents: number;
  grossCreditCents: number;
  netCreditCents: number;
  takeCents: number;
  creditCents: number;
  /** holder credit per dollar of notional, bps (null until something is quoted) */
  creditBpsOfNotional: number | null;
  settled: number;
  floorSaves: number;
  capHits: number;
  knockouts: number;
  /** knock-outs / settled, percent to one decimal */
  knockoutRatePct: number | null;
  /** hours from open to the touch, averaged over knock-outs */
  avgHoursToTouch: number | null;
  buybackCents: number;
  /** plain: gains above the cap handed back at the print, summed */
  capExcessCents: number;
  /** what holders were actually paid (vested at knock-outs) */
  paidCents: number;
  holderDeltaCents: number;
  writerCents: number;
}

/** a fraction as bps to one decimal: a $0.09 credit on $2,400 is 0.4 bps, not 0 */
const bps1 = (frac: number): number => Math.round(frac * 100_000) / 10;

const emptyBook = (): PerpRuleBook => ({
  quoted: 0,
  refused: 0,
  notionalCents: 0,
  grossCreditCents: 0,
  netCreditCents: 0,
  takeCents: 0,
  creditCents: 0,
  creditBpsOfNotional: null,
  settled: 0,
  floorSaves: 0,
  capHits: 0,
  knockouts: 0,
  knockoutRatePct: null,
  avgHoursToTouch: null,
  buybackCents: 0,
  capExcessCents: 0,
  paidCents: 0,
  holderDeltaCents: 0,
  writerCents: 0,
});

type BookAcc = PerpRuleBook & { touchHours: number };

const bookQuote = (b: PerpRuleBook, notionalCents: number, t: Pick<PerpAltTerms, "grossCreditCents" | "netCreditCents" | "takeCents" | "creditCents">): void => {
  b.quoted += 1;
  b.notionalCents += notionalCents;
  b.grossCreditCents += t.grossCreditCents;
  b.netCreditCents += t.netCreditCents;
  b.takeCents += t.takeCents;
  b.creditCents += t.creditCents;
};
const bookSettle = (b: BookAcc, o: PerpOutcome, openMs: number): void => {
  b.settled += 1;
  if (o.floorSave) b.floorSaves += 1;
  if (o.capHit) b.capHits += 1;
  if (o.knockedOut) {
    b.knockouts += 1;
    if (o.touchedAtIso) b.touchHours += (Date.parse(o.touchedAtIso) - openMs) / 3_600_000;
  }
  b.buybackCents += o.buybackCents;
  b.capExcessCents += o.capExcessCents;
  b.paidCents += o.paidCents;
  b.holderDeltaCents += o.deltaCents;
  b.writerCents += o.writerCents;
};
const newAcc = (): BookAcc => ({ ...emptyBook(), touchHours: 0 });
const finishBook = ({ touchHours, ...b }: BookAcc): PerpRuleBook => ({
  ...b,
  creditBpsOfNotional: b.notionalCents > 0 ? bps1(b.creditCents / b.notionalCents) : null,
  knockoutRatePct: b.settled > 0 ? +((b.knockouts / b.settled) * 100).toFixed(1) : null,
  avgHoursToTouch: b.knockouts > 0 ? +(touchHours / b.knockouts).toFixed(1) : null,
});

/** Rungs are bucketed by cap distance to the nearest 0.5% so strikes from different spots compare. */
export const capBucket = (capPct: number): string => `${(Math.round(capPct * 200) / 2).toFixed(1)}%`;

export interface PerpCapRungBook extends PerpRuleBook {
  bucket: string;
  /** the bucket's mean cap distance, fraction */
  capPct: number;
  /** how many of its quotes were the live pick */
  livePicks: number;
  /** how many sat under the cap guard (refused live) */
  underGuard: number;
  okxConfirmedTouches: number;
  hlOnlyTouches: number;
  /** mean market-implied chance (at open) of settling beyond this rung, % — null when no quote carried a vol */
  predictedExceedPct: number | null;
  /** realized share of settled cycles that ended beyond this rung, % — the number the prediction is checked against */
  realizedExceedPct: number | null;
}

export interface PerpFloorRungBook extends PerpRuleBook {
  /** floor depth, fraction */
  floorPct: number;
  /** how many of its quotes were the live geometry */
  livePicks: number;
  /** the mean cap distance the cap rule found at this floor, fraction (null when nothing paid) */
  avgCapPct: number | null;
  /** mean market-implied odds of finishing past that cap, % (null when no vol was readable) */
  predictedExceedPct: number | null;
}

export interface PerpCounterfactualSummary {
  positionsWithCounterfactuals: number;
  recordedSince: string | null;
  baseline: PerpRuleBook;
  /** the live book's mean days from open to expiry, and its credit per day on that footing (what the tenor rows compare against) */
  baselineDays: { avgDays: number | null; creditBpsPerDay: number | null };
  /** every listed cap distance, floor held fixed, settled on the same path */
  capLadder: PerpCapRungBook[];
  /** the floor at each depth, the cap re-found by the live rule, settled on the same path */
  floorLadder: PerpFloorRungBook[];
  feeRules: Record<string, PerpRuleBook>;
  /** the live geometry re-quoted at larger sizes, walked down the depth */
  capacity: Array<PerpRuleBook & { mult: number; contracts: number; avgSpreadCostBps: number | null }>;
  /**
   * the live geometry at other expiries (the other tenor; the two-weekly and monthly the shadow
   * measures); quoted terms only, never settled here. `creditBpsPerDay` puts tenors of different
   * length on one footing; `avgCapPct` / `predictedExceedPct` say where the cap landed and what
   * the market gave it.
   */
  tenors: Record<string, PerpRuleBook & { avgDays: number | null; creditBpsPerDay: number | null; avgCapPct: number | null; predictedExceedPct: number | null }>;
  /** "math makes sense": how often the credit failed to clear the cycle's funding cost */
  fundingRule: { judged: number; wouldRefuse: number; creditCents: number; fundingCents: number };
  /** the counterfactual floor rule: which depth it would have written each quote to, and how often */
  floorRule: { rule: string | null; judged: number; picks: Record<string, number>; agreesWithLive: number };
  /** Deribit and Bullish against OKX on the same legs at the same instant (a reference, not a counterfactual we could write) */
  venueReference: PerpVenueReferenceSummary;
}

export function summarizePerpCounterfactuals(positions: PerpShadowPosition[], capMode: PerpCapMode = DEFAULT_PERP_CAP_MODE): PerpCounterfactualSummary {
  const withCf = positions.filter((p) => p.counterfactuals);
  const baseline = newAcc();
  const rungs = new Map<string, BookAcc & { capPctSum: number; livePicks: number; underGuard: number; okxConfirmedTouches: number; hlOnlyTouches: number; probSum: number; probN: number }>();
  const feeRules: Record<string, BookAcc> = {};
  const tenors = new Map<string, BookAcc & { dayNum: number; dayDen: number; capPctSum: number; probSum: number; probN: number }>();
  const capacity = new Map<number, BookAcc & { mult: number; contracts: number; spreadNum: number; spreadDen: number }>();
  const floors = new Map<string, BookAcc & { floorPct: number; livePicks: number; capPctSum: number; capN: number; probSum: number; probN: number }>();
  const fundingRule = { judged: 0, wouldRefuse: 0, creditCents: 0, fundingCents: 0 };
  const floorRule: PerpCounterfactualSummary["floorRule"] = { rule: null, judged: 0, picks: {}, agreesWithLive: 0 };
  let baselineDayNum = 0;
  for (const p of withCf) {
    const cf = p.counterfactuals!;
    const settled = p.status === "settled" && p.settleCents != null;
    const openMs = Date.parse(p.at);
    bookQuote(baseline, p.notionalCents, p);
    baselineDayNum += (Date.parse(p.expiryIso) - openMs) / 86_400_000;
    if (settled && p.outcome) bookSettle(baseline, p.outcome, openMs);
    if (p.fundingCycleCents != null) {
      fundingRule.judged += 1;
      fundingRule.creditCents += p.creditCents;
      fundingRule.fundingCents += Math.max(0, p.fundingCycleCents);
      if (p.fundingCycleCents > 0 && p.creditCents <= p.fundingCycleCents) fundingRule.wouldRefuse += 1;
    }
    for (const rung of cf.capLadder ?? []) {
      const key = capBucket(rung.capPct);
      const row = rungs.get(key) ?? { ...newAcc(), capPctSum: 0, livePicks: 0, underGuard: 0, okxConfirmedTouches: 0, hlOnlyTouches: 0, probSum: 0, probN: 0 };
      row.capPctSum += rung.capPct;
      if (rung.exceedProb != null) {
        row.probSum += rung.exceedProb;
        row.probN += 1;
      }
      if (rung.live) row.livePicks += 1;
      if (rung.underGuard) row.underGuard += 1;
      if (!rung.terms.ok) row.refused += 1;
      else {
        bookQuote(row, p.notionalCents, rung.terms);
        if (settled) {
          const o = altOutcome(p, rung.terms, p.settleCents!, positions, capMode);
          bookSettle(row, o, openMs);
          const touch = touchFor(p.path, rung.capStrikeCents);
          if (touch?.okxConfirmed === true) row.okxConfirmedTouches += 1;
          else if (touch?.okxConfirmed === false) row.hlOnlyTouches += 1;
        }
      }
      rungs.set(key, row);
    }
    if (p.floorRulePick) {
      floorRule.rule = p.floorRulePick.rule;
      floorRule.judged += 1;
      const k = p.floorRulePick.floorPct == null ? "refuse" : `${(p.floorRulePick.floorPct * 100).toFixed(0)}%`;
      floorRule.picks[k] = (floorRule.picks[k] ?? 0) + 1;
      if (p.floorRulePick.floorPct != null && Math.abs(p.floorRulePick.floorPct - p.floorPct) < 0.005) floorRule.agreesWithLive += 1;
    }
    for (const rung of cf.floorLadder ?? []) {
      const key = rung.floorPct.toFixed(4);
      const row = floors.get(key) ?? { ...newAcc(), floorPct: rung.floorPct, livePicks: 0, capPctSum: 0, capN: 0, probSum: 0, probN: 0 };
      if (rung.live) row.livePicks += 1;
      if (!rung.terms.ok) row.refused += 1;
      else {
        bookQuote(row, p.notionalCents, rung.terms);
        row.capPctSum += rung.terms.capPct;
        row.capN += 1;
        if (rung.terms.capExceedProb != null) {
          row.probSum += rung.terms.capExceedProb;
          row.probN += 1;
        }
        if (settled) bookSettle(row, altOutcome(p, rung.terms, p.settleCents!, positions, capMode), openMs);
      }
      floors.set(key, row);
    }
    for (const [label, fr] of Object.entries(cf.feeRules)) {
      feeRules[label] ??= newAcc();
      if (fr.refused) {
        feeRules[label].refused += 1;
        continue;
      }
      const terms: PerpAltTerms = {
        ...(p as unknown as PerpAltTerms),
        ok: true,
        takeCents: fr.takeCents,
        creditCents: fr.creditCents,
        takeRule: fr.takeRule,
      };
      bookQuote(feeRules[label], p.notionalCents, terms);
      if (settled) bookSettle(feeRules[label], altOutcome(p, terms, p.settleCents!, positions, capMode), openMs);
    }
    for (const [label, alt] of Object.entries(cf.tenors ?? {})) {
      const row = tenors.get(label) ?? { ...newAcc(), dayNum: 0, dayDen: 0, capPctSum: 0, probSum: 0, probN: 0 };
      if (!alt.ok) row.refused += 1;
      else {
        bookQuote(row, p.notionalCents, alt);
        row.dayNum += (Date.parse(alt.expiryIso) - Date.parse(p.at)) / 86_400_000;
        row.dayDen += 1;
        row.capPctSum += alt.capPct;
        if (alt.capExceedProb != null) {
          row.probSum += alt.capExceedProb;
          row.probN += 1;
        }
      }
      tenors.set(label, row);
    }
    for (const probe of cf.sizeLadder) {
      const row = capacity.get(probe.mult) ?? { ...newAcc(), mult: probe.mult, contracts: 0, spreadNum: 0, spreadDen: 0 };
      row.contracts += probe.contracts;
      if (!probe.terms.ok) row.refused += 1;
      else {
        const notional = Math.round(probe.contracts * p.ctValBtc * p.spotCents);
        bookQuote(row, notional, probe.terms);
        if (probe.terms.midCreditCents != null && notional > 0) {
          row.spreadNum += ((probe.terms.midCreditCents - probe.terms.netCreditCents) / notional) * 10000;
          row.spreadDen += 1;
        }
        if (settled) bookSettle(row, altOutcome({ ...p, contracts: probe.contracts }, probe.terms, p.settleCents!, positions, capMode), openMs);
      }
      capacity.set(probe.mult, row);
    }
  }
  return {
    positionsWithCounterfactuals: withCf.length,
    recordedSince: withCf.length ? withCf.map((p) => p.at).sort()[0] : null,
    floorRule,
    venueReference: summarizeVenueReference(positions.map((p) => p.venueReference)),
    baseline: finishBook(baseline),
    baselineDays: (() => {
      const book = finishBook(baseline);
      const avgDays = withCf.length > 0 ? +(baselineDayNum / withCf.length).toFixed(1) : null;
      return { avgDays, creditBpsPerDay: book.creditBpsOfNotional != null && avgDays != null && avgDays > 0 ? +(book.creditBpsOfNotional / avgDays).toFixed(2) : null };
    })(),
    capLadder: [...rungs.entries()]
      .map(([bucket, { capPctSum, livePicks, underGuard, okxConfirmedTouches, hlOnlyTouches, probSum, probN, ...row }]) => ({
        ...finishBook(row),
        bucket,
        capPct: +(capPctSum / Math.max(1, row.quoted + row.refused)).toFixed(4),
        livePicks,
        underGuard,
        okxConfirmedTouches,
        hlOnlyTouches,
        predictedExceedPct: probN > 0 ? +((probSum / probN) * 100).toFixed(1) : null,
        realizedExceedPct: row.settled > 0 ? +((row.capHits / row.settled) * 100).toFixed(1) : null,
      }))
      .sort((a, b) => a.capPct - b.capPct),
    floorLadder: [...floors.values()]
      .map(({ floorPct, livePicks, capPctSum, capN, probSum, probN, ...row }) => ({
        ...finishBook(row),
        floorPct,
        livePicks,
        avgCapPct: capN > 0 ? +(capPctSum / capN).toFixed(4) : null,
        predictedExceedPct: probN > 0 ? +((probSum / probN) * 100).toFixed(1) : null,
      }))
      .sort((a, b) => a.floorPct - b.floorPct),
    feeRules: Object.fromEntries(Object.entries(feeRules).map(([k, v]) => [k, finishBook(v)])),
    tenors: Object.fromEntries(
      [...tenors.entries()].map(([k, { dayNum, dayDen, capPctSum, probSum, probN, ...row }]) => {
        const book = finishBook(row);
        const avgDays = dayDen > 0 ? +(dayNum / dayDen).toFixed(1) : null;
        return [
          k,
          {
            ...book,
            avgDays,
            creditBpsPerDay: book.creditBpsOfNotional != null && avgDays != null && avgDays > 0 ? +(book.creditBpsOfNotional / avgDays).toFixed(2) : null,
            avgCapPct: dayDen > 0 ? +(capPctSum / dayDen).toFixed(4) : null,
            predictedExceedPct: probN > 0 ? +((probSum / probN) * 100).toFixed(1) : null,
          },
        ];
      }),
    ),
    capacity: [...capacity.values()]
      .sort((a, b) => a.mult - b.mult)
      .map(({ spreadNum, spreadDen, ...row }) => ({
        ...finishBook(row),
        mult: row.mult,
        contracts: row.contracts,
        avgSpreadCostBps: spreadDen > 0 ? Math.round((spreadNum / spreadDen) * 10) / 10 : null,
      })),
    fundingRule,
  };
}

/** Knock-out timing: do touches cluster (many positions ending in the same hour = many buybacks at once)? */
export interface PerpKnockoutSummary {
  knockouts: number;
  /** knock-outs whose touch was in hours the trigger and the hedge venue both saw (OKX index reached the cap too) */
  okxConfirmed: number;
  /** touches Hyperliquid saw that the OKX index did not reach in the window */
  hlOnly: number;
  /** OKX extreme vs cap at the touches, bps, averaged (negative = OKX stayed short of the cap) */
  avgOkxGapBps: number | null;
  avgHoursToTouch: number | null;
  /** hours (UTC, yyyy-mm-ddThh) with at least one knock-out, and the busiest hour's count */
  touchHours: number;
  maxInOneHour: number;
  /** knock-outs whose buyback was estimated without an ATM reference (counted as 0) */
  pricedBlind: number;
  buybackCents: number;
  /** credit not paid because the cycle ended early: the writer's offset against the buyback */
  unvestedKeptCents: number;
}

/** Same-strike coincidence: how often a new position's funding strike was already open on the book (the block-RFQ case). */
export interface PerpSameStrikeSummary {
  opens: number;
  /** opens whose sell instrument was open on an earlier, still-live position at the same expiry */
  sharedSellStrike: number;
  /** the most positions open at once on one sell instrument */
  maxOpenOnOneStrike: number;
}

export interface PerpShadowSummary {
  positions: number;
  open: number;
  settled: number;
  void: number;
  /** closed early at live prices (flow mode) */
  closed: number;
  refusals: number;
  firstAt: string | null;
  lastAt: string | null;
  notionalCents: number;
  grossCreditCents: number;
  venueFeeCents: number;
  creditCents: number;
  takeCents: number;
  /** holder credit per dollar protected, bps of notional */
  creditBpsOfNotional: number | null;
  /** venue spread paid: mid-valued collar minus net funded, bps of notional, over positions with mids */
  spreadCostBps: number | null;
  floorSaves: number;
  capHits: number;
  knockouts: number;
  /** what holders were actually paid over settled positions (vested at knock-outs) */
  paidCents: number;
  holderDeltaCents: number;
  holderNakedCents: number;
  holderProtectedCents: number;
  writerCents: number;
  /** the take booked at quote on the SETTLED positions only: the identity compares it with writerCents */
  settledTakeCents: number;
  bySide: Record<PerpSide, { positions: number; settled: number; creditCents: number; holderDeltaCents: number; knockouts: number }>;
  refusalReasons: Record<string, number>;
  avgFundingBpsPer8h: number | null;
  avgBasisBps: number | null;
  /** the cap distance actually written, averaged, fraction */
  avgCapPct: number | null;
  knockoutDetail: PerpKnockoutSummary;
  /** how the cap settled these positions */
  capMode: PerpCapMode;
  /** plain mode: the cap as the holder experienced it */
  capDetail: PerpCapSummary;
  sameStrike: PerpSameStrikeSummary;
  counterfactuals: PerpCounterfactualSummary;
  /** flow mode: sizes, days, early closes, the netted book (perpShadowFlow.ts); set by the worker */
  flow?: PerpFlowSummary;
}

export interface PerpCapSummary {
  /** settled positions whose cap was touched on the path (a release was on offer) */
  touched: number;
  /** settled positions that printed past the cap at expiry (upside handed back) */
  endedPastCap: number;
  /** gains above the cap handed back, summed */
  capExcessCents: number;
  /** what releasing at the touch would have cost, summed over touched positions (informational) */
  releaseAtTouchCents: number;
  avgHoursToTouch: number | null;
  okxConfirmed: number;
  hlOnly: number;
  /** credit paid on the positions that ended past the cap: did it compensate for the upside handed back? */
  creditOnPastCapCents: number;
  /**
   * Settled positions whose hand-back exceeded the credit paid on that cycle. The credit settles
   * at close and nets the first slice of the hand-back, so this is the only case in which a
   * one-way rail (Hyperliquid agent wallets) is left with a balance it cannot collect. On a venue
   * ledger the week is simply booked capped and this number is informational.
   */
  exceededCredit: number;
  /** sum of (hand-back − credit) over those positions, cents: the balance a one-way rail would carry */
  exceededCreditCents: number;
  /** the largest single (hand-back − credit), cents */
  largestExceededCreditCents: number;
  /**
   * The cap rule's calibration. Market-implied odds at open that the live cap would be finished
   * past (the rule targets at most 20%), averaged over settled positions with a readable vol, %.
   */
  predictedExceedPct: number | null;
  /** realized share of settled positions that finished past the cap, %: the number the prediction is checked against */
  realizedExceedPct: number | null;
}

export function summarizeSameStrike(positions: PerpShadowPosition[]): PerpSameStrikeSummary {
  const out: PerpSameStrikeSummary = { opens: positions.length, sharedSellStrike: 0, maxOpenOnOneStrike: 0 };
  const sorted = [...positions].sort((a, b) => a.at.localeCompare(b.at));
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const openMs = Date.parse(p.at);
    let same = 0;
    for (let j = 0; j < i; j++) {
      const q = sorted[j];
      if (q.sellInstId !== p.sellInstId || q.expiryIso !== p.expiryIso) continue;
      // still live at p's open: not settled before it (a knock-out ends it at the touch)
      const endMs = q.outcome?.touchedAtIso ? Date.parse(q.outcome.touchedAtIso) : Date.parse(q.expiryIso);
      if (endMs > openMs) same += 1;
    }
    if (same > 0) out.sharedSellStrike += 1;
    out.maxOpenOnOneStrike = Math.max(out.maxOpenOnOneStrike, same + 1);
  }
  return out;
}

export function summarizePerpShadow(positions: PerpShadowPosition[], refusals: PerpShadowRefusalRecord[], opts: PerpReplayOptions = {}): PerpShadowSummary {
  const capMode = opts.capMode ?? DEFAULT_PERP_CAP_MODE;
  const s: PerpShadowSummary = {
    positions: positions.length,
    open: 0,
    settled: 0,
    void: 0,
    closed: 0,
    refusals: refusals.length,
    firstAt: null,
    lastAt: null,
    notionalCents: 0,
    grossCreditCents: 0,
    venueFeeCents: 0,
    creditCents: 0,
    takeCents: 0,
    creditBpsOfNotional: null,
    spreadCostBps: null,
    floorSaves: 0,
    capHits: 0,
    knockouts: 0,
    paidCents: 0,
    holderDeltaCents: 0,
    holderNakedCents: 0,
    holderProtectedCents: 0,
    writerCents: 0,
    settledTakeCents: 0,
    bySide: {
      long: { positions: 0, settled: 0, creditCents: 0, holderDeltaCents: 0, knockouts: 0 },
      short: { positions: 0, settled: 0, creditCents: 0, holderDeltaCents: 0, knockouts: 0 },
    },
    refusalReasons: {},
    avgFundingBpsPer8h: null,
    avgBasisBps: null,
    avgCapPct: null,
    knockoutDetail: {
      knockouts: 0,
      okxConfirmed: 0,
      hlOnly: 0,
      avgOkxGapBps: null,
      avgHoursToTouch: null,
      touchHours: 0,
      maxInOneHour: 0,
      pricedBlind: 0,
      buybackCents: 0,
      unvestedKeptCents: 0,
    },
    capMode,
    capDetail: {
      touched: 0,
      endedPastCap: 0,
      capExcessCents: 0,
      releaseAtTouchCents: 0,
      avgHoursToTouch: null,
      okxConfirmed: 0,
      hlOnly: 0,
      creditOnPastCapCents: 0,
      exceededCredit: 0,
      exceededCreditCents: 0,
      largestExceededCreditCents: 0,
      predictedExceedPct: null,
      realizedExceedPct: null,
    },
    sameStrike: summarizeSameStrike(positions),
    counterfactuals: summarizePerpCounterfactuals(positions, capMode),
  };
  const ats = [...positions.map((p) => p.at), ...refusals.map((r) => r.at)].sort();
  s.firstAt = ats[0] ?? null;
  s.lastAt = ats[ats.length - 1] ?? null;
  let spreadNum = 0;
  let spreadDen = 0;
  let fundNum = 0;
  let fundDen = 0;
  let basisNum = 0;
  let basisDen = 0;
  let capNum = 0;
  let gapNum = 0;
  let gapDen = 0;
  let touchHours = 0;
  let touchCount = 0;
  let capTouchHours = 0;
  let exceedProbSum = 0;
  let exceedProbN = 0;
  const hourBuckets = new Map<string, number>();
  const ko = s.knockoutDetail;
  for (const p of positions) {
    s[p.status] += 1;
    s.notionalCents += p.notionalCents;
    s.grossCreditCents += p.grossCreditCents;
    s.venueFeeCents += p.venueFeeCents;
    s.creditCents += p.creditCents;
    s.takeCents += p.takeCents;
    capNum += p.capPct;
    s.bySide[p.side].positions += 1;
    s.bySide[p.side].creditCents += p.creditCents;
    if (p.midCreditCents != null && p.notionalCents > 0) {
      spreadNum += ((p.midCreditCents - p.netCreditCents) / p.notionalCents) * 10000;
      spreadDen += 1;
    }
    if (p.fundingBpsPer8h != null) {
      fundNum += p.fundingBpsPer8h;
      fundDen += 1;
    }
    if (p.basisBps != null) {
      basisNum += p.basisBps;
      basisDen += 1;
    }
    if (p.status === "settled" && p.outcome) {
      const o = p.outcome;
      s.settledTakeCents += p.takeCents;
      if (o.floorSave) s.floorSaves += 1;
      if (o.capHit) s.capHits += 1;
      s.paidCents += o.paidCents;
      s.holderDeltaCents += o.deltaCents;
      s.holderNakedCents += o.nakedCents;
      s.holderProtectedCents += o.protectedCents;
      s.writerCents += o.writerCents;
      s.bySide[p.side].settled += 1;
      s.bySide[p.side].holderDeltaCents += o.deltaCents;
      // The cap as the holder met it, whatever the mode: touched on the path, or printed past at expiry.
      const capTouch = touchFor(p.path, p.capStrikeCents);
      if (capTouch) {
        s.capDetail.touched += 1;
        s.capDetail.releaseAtTouchCents += o.buybackCents; // both modes price the same leg at the same touch
        capTouchHours += (Date.parse(capTouch.atIso) - Date.parse(p.at)) / 3_600_000;
        if (capTouch.okxConfirmed === true) s.capDetail.okxConfirmed += 1;
        else if (capTouch.okxConfirmed === false) s.capDetail.hlOnly += 1;
      }
      if (o.capExcessCents > 0) {
        s.capDetail.endedPastCap += 1;
        s.capDetail.capExcessCents += o.capExcessCents;
        s.capDetail.creditOnPastCapCents += o.paidCents;
        const beyondCredit = o.capExcessCents - o.paidCents;
        if (beyondCredit > 0) {
          s.capDetail.exceededCredit += 1;
          s.capDetail.exceededCreditCents += beyondCredit;
          s.capDetail.largestExceededCreditCents = Math.max(s.capDetail.largestExceededCreditCents, beyondCredit);
        }
      }
      if (p.capExceedProb != null) {
        exceedProbSum += p.capExceedProb;
        exceedProbN += 1;
      }
      if (o.knockedOut) {
        s.knockouts += 1;
        s.bySide[p.side].knockouts += 1;
        ko.knockouts += 1;
        ko.buybackCents += o.buybackCents;
        ko.unvestedKeptCents += p.creditCents - o.paidCents;
        const touch = touchFor(p.path, p.capStrikeCents);
        if (touch) {
          if (touch.okxConfirmed === true) ko.okxConfirmed += 1;
          else if (touch.okxConfirmed === false) ko.hlOnly += 1;
          if (touch.okxGapBps != null) {
            gapNum += touch.okxGapBps;
            gapDen += 1;
          }
          const hour = touch.atIso.slice(0, 13);
          hourBuckets.set(hour, (hourBuckets.get(hour) ?? 0) + 1);
          touchHours += (Date.parse(touch.atIso) - Date.parse(p.at)) / 3_600_000;
          touchCount += 1;
          if (o.buybackCents === 0 && nearestAtm(positions, p.side, p.expiryIso, Date.parse(touch.atIso)) == null) ko.pricedBlind += 1;
        }
      }
    }
  }
  for (const r of refusals) s.refusalReasons[r.error] = (s.refusalReasons[r.error] ?? 0) + 1;
  s.creditBpsOfNotional = s.notionalCents > 0 ? bps1(s.creditCents / s.notionalCents) : null;
  s.spreadCostBps = spreadDen > 0 ? Math.round((spreadNum / spreadDen) * 10) / 10 : null;
  s.avgFundingBpsPer8h = fundDen > 0 ? +(fundNum / fundDen).toFixed(3) : null;
  s.avgBasisBps = basisDen > 0 ? +(basisNum / basisDen).toFixed(1) : null;
  s.avgCapPct = positions.length > 0 ? +(capNum / positions.length).toFixed(4) : null;
  ko.avgOkxGapBps = gapDen > 0 ? +(gapNum / gapDen).toFixed(1) : null;
  ko.avgHoursToTouch = touchCount > 0 ? +(touchHours / touchCount).toFixed(1) : null;
  ko.touchHours = hourBuckets.size;
  ko.maxInOneHour = Math.max(0, ...hourBuckets.values());
  s.capDetail.avgHoursToTouch = s.capDetail.touched > 0 ? +(capTouchHours / s.capDetail.touched).toFixed(1) : null;
  s.capDetail.predictedExceedPct = exceedProbN > 0 ? +((exceedProbSum / exceedProbN) * 100).toFixed(1) : null;
  s.capDetail.realizedExceedPct = s.settled > 0 ? +((s.capDetail.endedPastCap / s.settled) * 100).toFixed(1) : null;
  return s;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

export const PERP_CSV_PUBLIC_COLUMNS = [
  "id",
  "side",
  "opened_at_utc",
  "expiry_utc",
  "tenor",
  "status",
  "settled_at_utc",
  "settle_px_c",
  "settle_source",
  "contracts",
  "notional_c",
  "spot_c",
  "okx_index_c",
  "basis_bps",
  "funding_bps_8h",
  "floor_strike_c",
  "cap_strike_c",
  "floor_pct",
  "cap_pct",
  "buy_inst",
  "sell_inst",
  "buy_px_btc",
  "sell_px_btc",
  "gross_credit_c",
  "venue_fee_c",
  "net_credit_c",
  "take_c",
  "credit_c",
  "mid_credit_c",
  "holder_naked_c",
  "holder_protected_c",
  "holder_delta_c",
  "floor_save",
  "knocked_out",
  "touched_at_utc",
  "vested_frac",
  "paid_c",
  "path_hi_c",
  "path_lo_c",
  "cap_excess_c",
  "writer_c",
] as const;

export const PERP_CSV_COLUMNS = [
  ...PERP_CSV_PUBLIC_COLUMNS,
  "take_rule",
  "take_share_c",
  "take_min_c",
  "cap_guard_pct",
  "funding_cycle_c",
  "buyback_c",
  "okx_confirmed",
  "okx_gap_bps",
  "cap_ladder",
  "fee_rules",
  "size_ladder",
  "alt_tenor",
  "alt_tenor_expiry_utc",
  "alt_tenor_floor_c",
  "alt_tenor_cap_c",
  "alt_tenor_gross_c",
  "alt_tenor_credit_c",
  "alt_tenor_take_c",
  "alt_tenor_refused",
] as const;

const cell = (v: string | number | boolean | null | undefined): string => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "boolean" ? (v ? "1" : "0") : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The other tenor's counterfactual (the daily when the live collar is weekly, and the reverse); the longer tenors ride in the JSON report, not these columns. */
const altTenorCells = (tenors: Record<string, PerpTenorAlt> | undefined): Array<string | number> => {
  const entries = Object.entries(tenors ?? {});
  const entry = entries.find(([k]) => k === "daily" || k === "weekly") ?? entries[0];
  if (!entry) return ["", "", "", "", "", "", "", ""];
  const [label, alt] = entry;
  if (!alt.ok) return [label, "", "", "", "", "", "", 1];
  return [label, alt.expiryIso, alt.floorStrikeCents, alt.capStrikeCents, alt.grossCreditCents, alt.creditCents, alt.takeCents, 0];
};

export function perpPositionsCsv(positions: PerpShadowPosition[], scope: "public" | "full" = "full", opts: PerpReplayOptions = {}): string {
  const capMode = opts.capMode ?? DEFAULT_PERP_CAP_MODE;
  const cols = scope === "public" ? PERP_CSV_PUBLIC_COLUMNS : PERP_CSV_COLUMNS;
  const rows = [...positions]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((p) => {
      const o = p.outcome;
      const touch = touchFor(p.path, p.capStrikeCents);
      const pub: Array<string | number | boolean | null | undefined> = [
        p.id,
        p.side,
        p.at,
        p.expiryIso,
        p.tenor ?? "daily",
        p.status,
        p.settledAt ?? "",
        p.settleCents ?? "",
        p.settleSource ?? "",
        p.contracts,
        p.notionalCents,
        p.spotCents,
        p.okxIndexCents,
        p.basisBps,
        p.fundingBpsPer8h,
        p.floorStrikeCents,
        p.capStrikeCents,
        p.floorPct,
        p.capPct,
        p.buyInstId,
        p.sellInstId,
        p.buyPxBtc,
        p.sellPxBtc,
        p.grossCreditCents,
        p.venueFeeCents,
        p.netCreditCents,
        p.takeCents,
        p.creditCents,
        p.midCreditCents,
        o?.nakedCents ?? "",
        o?.protectedCents ?? "",
        o?.deltaCents ?? "",
        o ? o.floorSave : "",
        o ? o.knockedOut : "",
        o?.touchedAtIso ?? "",
        o?.vestedFraction ?? "",
        o?.paidCents ?? "",
        p.path?.hiCents ?? "",
        p.path?.loCents ?? "",
        o?.capExcessCents ?? "",
        o?.writerCents ?? "",
      ];
      if (scope === "public") return pub.map(cell).join(",");
      const cf = p.counterfactuals;
      const ladder = cf?.capLadder?.map((r) => {
        const out = p.status === "settled" && p.settleCents != null && r.terms.ok ? altOutcome(p, r.terms, p.settleCents, positions, capMode) : null;
        return {
          cap: r.capStrikeCents,
          pct: r.capPct,
          live: r.live,
          guard: r.underGuard,
          ok: r.terms.ok,
          credit: r.terms.ok ? r.terms.creditCents : null,
          error: r.terms.ok ? null : r.terms.error,
          ko: out?.knockedOut ?? null,
          touched: out?.touchedAtIso ?? null,
          writer: out?.writerCents ?? null,
          buyback: out?.buybackCents ?? null,
          excess: out?.capExcessCents ?? null,
        };
      });
      return [
        ...pub,
        p.takeRule,
        p.takeShareCents,
        p.takeMinimumCents,
        p.capGuardPct,
        p.fundingCycleCents,
        o?.buybackCents ?? "",
        touch ? touch.okxConfirmed : "",
        touch?.okxGapBps ?? "",
        ladder ? JSON.stringify(ladder) : "",
        cf ? JSON.stringify(cf.feeRules) : "",
        cf ? JSON.stringify(cf.sizeLadder.map((s) => ({ mult: s.mult, contracts: s.contracts, ok: s.terms.ok, credit: s.terms.ok ? s.terms.creditCents : null, error: s.terms.ok ? null : s.terms.error }))) : "",
        ...altTenorCells(cf?.tenors),
      ]
        .map(cell)
        .join(",");
    });
  return [cols.join(","), ...rows].join("\n") + "\n";
}
