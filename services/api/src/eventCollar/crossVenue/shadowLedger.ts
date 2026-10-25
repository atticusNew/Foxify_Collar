/**
 * Event shadow ledger — the track record engine.
 *
 * The shadow run converts the demo's math into auditable history: every
 * quotable board row becomes one simulated position (opened once per market,
 * at the first priced quote), and after the event settles on Kalshi the
 * position is marked against the official result. The ledger is append-only
 * JSONL so the history is tamper-evident and replayable; positions are
 * reconstructed by replay, never mutated in place.
 *
 * Everything here is pure bookkeeping over already-quoted terms. No venue
 * calls, no trading: the module is structurally unable to do anything but
 * record and summarize.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HedgeRoute, ProtectionTier, TakeRule } from "./types";
import { PROTECTION_TIERS } from "./types";
import type { RuleCheck, RuleEvidence } from "./ruleEvidence";
import {
  FEE_RULE_LABELS,
  SIZE_LADDER_MULTS,
  type FeeRuleLabel,
  type ShadowAltTerms,
  type ShadowBookOpenReread,
  type ShadowCounterfactuals,
  type ShadowReread,
} from "./shadowCounterfactuals";

/** One simulated position opened from a live board quote. */
export interface ShadowOpenRecord {
  type: "open";
  at: string;
  /** Kalshi market ticker — the position key; one position per market, ever. */
  ticker: string;
  kind: "sports" | "crypto";
  league: string;
  sideName: string;
  eventTitle: string;
  /** when protection locks: game start (sports) or market close (crypto), ISO */
  eventTimeIso: string;
  contracts: number;
  markCents: number;
  floorCents: number;
  capCents: number;
  creditCents: number;
  /** quoted cost of protection, bps of naked EV (negative = protection beats naked) */
  evCostBps: number;
  route: HedgeRoute;
  feesCents: number;
  takeCents: number;
  /**
   * The hedge leg as quoted: walked cost in cents, venue fees included, and
   * the NO units bought, in milli (1000 = one $1-paying share/contract).
   * Optional because early ledgers predate these fields. The cost is
   * informational: the writer's book derives it from the credit identity
   * (see hedgeCostOf), so a record cannot misstate it.
   */
  hedgeCostCents?: number;
  hedgeUnitsMilli?: number;
  /** which protection tier the recorded terms are (absent on records before tiers existed: the tight rule) */
  tier?: ProtectionTier;
  takeRule?: TakeRule;
  takeShareCents?: number;
  takeMinimumCents?: number;
  /**
   * Counterfactuals priced from the same books at the same instant: every
   * tier the venues funded, the default tier under each fee rule, and the
   * default tier at larger sizes. Absent on records before shadow v2.
   */
  counterfactuals?: ShadowCounterfactuals;
  /**
   * Where each route's book came from at open: the aggregator's feed or the venue read directly.
   * Absent on records before the feed was wired (every one of those was a direct read).
   */
  bookOrigins?: { polymarket?: "aggregator" | "direct"; kalshi?: "aggregator" | "direct" };
  /**
   * The Polymarket token the cross-venue hedge bought, so an early close can
   * sell it into its live book. Absent on self-hedged positions and on records
   * before early closes existed (those close with the hedge leg unpriced).
   */
  hedgeTokenId?: string;
  /**
   * The venue's rule text as published at open, pinned (sha256, source URL, the text). Null when
   * the venue published none; absent on records before 2026-10-11. Evidence for the result, never
   * an input to the payout.
   */
  rule?: RuleEvidence | null;
  /**
   * How the position came to be on the record. Absent: the scan opened it (the shadow's own
   * simulated holder). "lock": a person tapped Lock in on a real position of this size, through
   * the lock endpoint; the terms and the hedge are the same code path, the size is theirs.
   */
  source?: "lock";
  /** With source "lock": what the holder paid per contract, cents, so their own cost sits on the record. */
  entryCents?: number;
  /**
   * With source "lock": the holder's alias (lockGate.ts), from the key their client sent. Each
   * holder's locks live in their own ledger file, so one market can be locked by several people
   * and the ticker stays the key inside each file. Operator views only; the public record strips it.
   */
  holder?: string;
}

/**
 * The user left early, before the lock: a new trade at live prices, both legs
 * sold into their venues' bids in the same second. `priced: false` records an
 * attempt where a leg had no depth; the position stays open and runs to
 * settlement, and the attempt is counted so the record can say so.
 */
export interface ShadowCloseRecord {
  type: "close";
  at: string;
  ticker: string;
  priced: boolean;
  /** when unpriced: which leg and why */
  reason?: string;
  /** the protected market's live mid at the close, cents (null when one side was empty) */
  yesMidCents?: number | null;
  /** average fill selling the user's Yes contracts, cents */
  yesFillCents?: number;
  /** the user's own sale after the venue fee; also what leaving with no protection pays */
  positionProceedsCents?: number;
  /** our hedge sale after fees */
  hedgeProceedsCents?: number;
  feesCents?: number;
  /** what the user walked away with, the credit paid at the tap included */
  protectedAtCloseCents?: number;
  /** the frictionless reference at the live mid (null without a mid) */
  protectedAtMidCents?: number | null;
  /** protectedAtMid minus protectedAtClose: what crossing both books cost (null without a mid) */
  unwindFrictionCents?: number | null;
}

/** The market finalized on Kalshi with an official result. */
export interface ShadowSettleRecord {
  type: "settle";
  at: string;
  ticker: string;
  result: "yes" | "no";
  /** the rule text read again at this settlement, against the pin (ruleEvidence.checkRule); absent before 2026-10-11 */
  ruleCheck?: RuleCheck;
}

/** The market never produced a result (e.g. postponed and rebooked). */
export interface ShadowVoidRecord {
  type: "void";
  at: string;
  ticker: string;
  reason: string;
}

/**
 * CASH. Money that actually moved between the writer and the holder of a lock, as the operator
 * recorded it. The record's other lines say what is owed (the credit at the tap; at settlement
 * the floor to the holder when the side lost, or the slice above the cap back to the writer when
 * it won); this line says a payment happened. Direction follows the leg. Several lines may pay
 * one leg. The scan's showcase positions never carry one: nobody is paid on paper.
 */
export type CashLeg = "credit" | "floor" | "handback";
export const CASH_LEGS: readonly CashLeg[] = ["credit", "floor", "handback"];
export interface ShadowCashRecord {
  type: "cash";
  at: string;
  ticker: string;
  leg: CashLeg;
  /** cents that moved, positive */
  cents: number;
  /** how it moved, in the operator's words ("venue transfer", "wire", "cash") */
  method?: string;
  /** the payment's own reference; stays in the raw ledger, never on a page */
  ref?: string;
  note?: string;
}

/**
 * PRE-LOCK RE-READ. The open position priced again, both routes and every reference, from fresh
 * books a fixed time before its lock (shadowCounterfactuals.ShadowReread). Measurement only: the
 * terms written at open stand; this line says what the same protection would have cost on each
 * book at the moment a late tap's hedge would actually be placed. One per position; a second is
 * ignored on replay. `unread` records a read that could not happen for a reason that will not
 * change before the lock, so the tick does not try again.
 */
export type ShadowRereadRecord =
  | ({ type: "reread"; ticker: string; phase: "prelock" } & ShadowReread)
  /** the same read taken when a held reference book first showed levels (shadowCounterfactuals.ShadowBookOpenReread); one per position */
  | ({ type: "reread"; ticker: string; phase: "book_open" } & ShadowBookOpenReread);

export type ShadowRecord = ShadowOpenRecord | ShadowSettleRecord | ShadowVoidRecord | ShadowCloseRecord | ShadowCashRecord | ShadowRereadRecord;

export interface ShadowPosition extends Omit<ShadowOpenRecord, "type"> {
  status: "open" | "settled" | "void" | "closed";
  result?: "yes" | "no";
  settledAt?: string;
  ruleCheck?: RuleCheck;
  voidReason?: string;
  /**
   * Total with protection. Settled: (cap if yes, floor if no) x contracts + credit.
   * Closed: what the user walked away with at live prices, credit included.
   */
  protectedCents?: number;
  /** Total without protection. Settled: 100 x contracts if yes, 0 if no. Closed: the same sale, no protection ever bought. */
  nakedCents?: number;
  /** protected minus naked; positive = protection paid off on this event */
  deltaCents?: number;
  /** writer side, settled or closed: what the protection writer netted after hedge and credit */
  writerCents?: number;
  hedgePayoutCents?: number;
  /** closed only: when, at what mid and fill, and what crossing the books cost against the mid */
  closedAt?: string;
  closeYesMidCents?: number | null;
  closeYesFillCents?: number;
  closeFeesCents?: number;
  closeProtectedAtMidCents?: number | null;
  closeUnwindFrictionCents?: number | null;
  /** an early close was attempted and a leg had no depth; the position runs to settlement */
  closeUnpriced?: { at: string; reason: string };
  /** payments recorded on this lock, oldest first; the reference and note stay in the raw ledger */
  cash?: Array<{ at: string; leg: CashLeg; cents: number; method?: string }>;
  /** the pre-lock re-read, when one has happened (operator information, like the counterfactuals) */
  prelock?: ShadowReread;
  /** the read taken the moment a held reference book opened, when the record caught one (operator information) */
  bookOpen?: ShadowBookOpenReread;
}

/** One leg of cash the lock owes, and how much of it has been paid. */
export interface CashLegDue {
  leg: CashLeg;
  /** who receives it */
  to: "holder" | "writer";
  dueCents: number;
  paidCents: number;
  outstandingCents: number;
  /** when the leg was paid in full, else null */
  paidAt: string | null;
}

/**
 * What a lock owes and to whom, from its terms and its state, with the cash lines applied. The
 * credit is owed to the holder from the tap. A settled position adds one leg: the floor to the
 * holder when the side lost, the slice above the cap to the writer when it won (none when the
 * cap is $1). A void or closed position owes nothing beyond the credit; a close is settled at
 * live prices on the books, not between the two parties.
 */
export function cashDue(p: ShadowPosition): CashLegDue[] {
  const owed: Array<{ leg: CashLeg; to: "holder" | "writer"; dueCents: number }> = [{ leg: "credit", to: "holder", dueCents: p.creditCents }];
  if (p.status === "settled" && p.result === "no") owed.push({ leg: "floor", to: "holder", dueCents: p.floorCents * p.contracts });
  if (p.status === "settled" && p.result === "yes" && p.capCents < 100) owed.push({ leg: "handback", to: "writer", dueCents: (100 - p.capCents) * p.contracts });
  return owed.map((o) => {
    const lines = (p.cash ?? []).filter((c) => c.leg === o.leg);
    const paidCents = lines.reduce((s, c) => s + c.cents, 0);
    const outstandingCents = Math.max(0, o.dueCents - paidCents);
    return { ...o, paidCents, outstandingCents, paidAt: lines.length > 0 && outstandingCents === 0 ? lines[lines.length - 1].at : null };
  });
}

/** Outcome math for one settled position — the same totals the app banner shows. */
export function settlePayouts(
  p: Pick<ShadowOpenRecord, "contracts" | "floorCents" | "capCents" | "creditCents">,
  result: "yes" | "no",
): { protectedCents: number; nakedCents: number; deltaCents: number } {
  const protectedCents =
    (result === "yes" ? p.capCents : p.floorCents) * p.contracts + p.creditCents;
  const nakedCents = result === "yes" ? 100 * p.contracts : 0;
  return { protectedCents, nakedCents, deltaCents: protectedCents - nakedCents };
}

type WriterInputs = Pick<
  ShadowOpenRecord,
  "contracts" | "floorCents" | "capCents" | "creditCents" | "takeCents" | "hedgeCostCents" | "hedgeUnitsMilli"
>;

/** The cap slice the holder sells: (100 - cap) x N cents, received by the writer in the YES state. */
export function fundingOf(p: Pick<ShadowOpenRecord, "contracts" | "capCents">): number {
  return (100 - p.capCents) * p.contracts;
}

/**
 * Hedge cost as quoted, venue fees included. Always derived from the pricer's
 * credit identity, which is exact by construction: gross = funding - hedgeCost
 * - fees and credit = gross - take, so hedgeCost + fees = funding - credit -
 * take. The stored `hedgeCostCents` is informational; deriving here means a
 * record that stored the leg without its fee cannot overstate the writer.
 */
export function hedgeCostOf(p: WriterInputs): number {
  return fundingOf(p) - p.creditCents - p.takeCents;
}

/** NO units the hedge bought, milli. Older records: the pricer's sizing rule, rounded up. */
export function hedgeUnitsOf(p: WriterInputs): number {
  return p.hedgeUnitsMilli ?? Math.ceil(((p.floorCents + 100 - p.capCents) * p.contracts * 1000) / 100);
}

/**
 * Writer-side cash flows for one settled position, integer cents.
 *
 *   YES: writer keeps the cap slice (100 - cap) x N, hedge pays nothing.
 *   NO:  writer pays the floor x N, hedge pays $1 per unit bought.
 *   Both: writer paid the hedge at open and the credit at settlement.
 *
 * Because the hedge is sized to (floor + 100 - cap) x N, the two states net
 * to the same number: the published take (plus the round-up on NO). That is
 * the whole point of leg-for-leg: the writer's result does not depend on who
 * won. This function computes both legs explicitly so the record can be
 * checked rather than believed.
 */
export function writerPayouts(
  p: WriterInputs,
  result: "yes" | "no",
): { writerCents: number; hedgePayoutCents: number; hedgeCostCents: number; fundingCents: number } {
  const funding = fundingOf(p);
  const hedgeCost = hedgeCostOf(p);
  const hedgePayout = result === "no" ? Math.round(hedgeUnitsOf(p) / 10) : 0;
  const holderLeg = result === "yes" ? funding : -p.floorCents * p.contracts;
  return {
    writerCents: holderLeg + hedgePayout - p.creditCents - hedgeCost,
    hedgePayoutCents: hedgePayout,
    hedgeCostCents: hedgeCost,
    fundingCents: funding,
  };
}

/**
 * Mark one counterfactual collar against the same official result the live
 * position settled on: the holder's delta versus naked and the writer's net.
 */
export function altOutcome(
  alt: ShadowAltTerms,
  contracts: number,
  result: "yes" | "no",
): { deltaCents: number; writerCents: number } | null {
  if (!alt.ok) return null;
  const terms = { contracts, floorCents: alt.floorCents, capCents: alt.capCents, creditCents: alt.creditCents };
  const { deltaCents } = settlePayouts(terms, result);
  const { writerCents } = writerPayouts(
    { ...terms, takeCents: alt.takeCents, hedgeCostCents: alt.hedgeCostCents, hedgeUnitsMilli: alt.hedgeUnitsMilli },
    result,
  );
  return { deltaCents, writerCents };
}

export function appendShadowRecord(path: string, record: ShadowRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

/** Size and line count of the raw ledger, for healthz and the export endpoint. */
export function ledgerStats(path: string): { exists: boolean; bytes: number; records: number } {
  if (!existsSync(path)) return { exists: false, bytes: 0, records: 0 };
  const raw = readFileSync(path, "utf8");
  return {
    exists: true,
    bytes: Buffer.byteLength(raw, "utf8"),
    records: raw.split("\n").filter((l) => l.trim().length > 0).length,
  };
}

/** Replay the JSONL into current positions. Unreadable lines are skipped, never fatal. */
export function loadShadowPositions(path: string): ShadowPosition[] {
  if (!existsSync(path)) return [];
  const byTicker = new Map<string, ShadowPosition>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: ShadowRecord;
    try {
      rec = JSON.parse(trimmed) as ShadowRecord;
    } catch {
      continue;
    }
    if (rec.type === "open") {
      if (byTicker.has(rec.ticker)) continue; // first quote wins; replays cannot double-open
      const { type: _t, ...fields } = rec;
      byTicker.set(rec.ticker, { ...fields, status: "open" });
    } else if (rec.type === "settle") {
      const pos = byTicker.get(rec.ticker);
      if (!pos || pos.status !== "open") continue;
      const pay = settlePayouts(pos, rec.result);
      const writer = writerPayouts(pos, rec.result);
      byTicker.set(rec.ticker, {
        ...pos,
        status: "settled",
        result: rec.result,
        settledAt: rec.at,
        ...(rec.ruleCheck ? { ruleCheck: rec.ruleCheck } : {}),
        ...pay,
        writerCents: writer.writerCents,
        hedgePayoutCents: writer.hedgePayoutCents,
      });
    } else if (rec.type === "void") {
      const pos = byTicker.get(rec.ticker);
      if (!pos || pos.status !== "open") continue;
      byTicker.set(rec.ticker, { ...pos, status: "void", voidReason: rec.reason });
    } else if (rec.type === "cash") {
      // a payment lands on the position in any state; one that names no position is noise
      const pos = byTicker.get(rec.ticker);
      if (!pos || !CASH_LEGS.includes(rec.leg) || !Number.isInteger(rec.cents) || rec.cents <= 0) continue;
      const line = { at: rec.at, leg: rec.leg, cents: rec.cents, ...(rec.method ? { method: rec.method } : {}) };
      byTicker.set(rec.ticker, { ...pos, cash: [...(pos.cash ?? []), line] });
    } else if (rec.type === "reread") {
      // one read per position per phase, the first; it lands in any state (the position may have settled since)
      const pos = byTicker.get(rec.ticker);
      if (!pos) continue;
      if (rec.phase === "prelock") {
        if (pos.prelock) continue;
        const { type: _t, ticker: _k, phase: _p, ...reread } = rec;
        byTicker.set(rec.ticker, { ...pos, prelock: reread });
      } else if (rec.phase === "book_open") {
        if (pos.bookOpen) continue;
        const { type: _t, ticker: _k, phase: _p, ...reread } = rec;
        byTicker.set(rec.ticker, { ...pos, bookOpen: reread });
      }
    } else if (rec.type === "close") {
      const pos = byTicker.get(rec.ticker);
      if (!pos || pos.status !== "open") continue;
      if (!rec.priced) {
        // One attempt per position: the schedule does not retry, the position settles as usual.
        byTicker.set(rec.ticker, { ...pos, closeUnpriced: { at: rec.at, reason: rec.reason ?? "a leg had no depth" } });
        continue;
      }
      const protectedCents = rec.protectedAtCloseCents ?? 0;
      const nakedCents = rec.positionProceedsCents ?? 0;
      byTicker.set(rec.ticker, {
        ...pos,
        status: "closed",
        closedAt: rec.at,
        protectedCents,
        nakedCents,
        deltaCents: protectedCents - nakedCents,
        // leg for leg: the user pays live prices on both legs, so the writer keeps exactly the take
        writerCents: pos.takeCents,
        hedgePayoutCents: rec.hedgeProceedsCents ?? 0,
        closeYesMidCents: rec.yesMidCents ?? null,
        closeYesFillCents: rec.yesFillCents,
        closeFeesCents: rec.feesCents ?? 0,
        closeProtectedAtMidCents: rec.protectedAtMidCents ?? null,
        closeUnwindFrictionCents: rec.unwindFrictionCents ?? null,
      });
    }
  }
  return [...byTicker.values()];
}

export interface ShadowSummary {
  openCount: number;
  settledCount: number;
  voidCount: number;
  /** settled events where the result went against the holder — the floor paid */
  floorSaves: number;
  /** settled events where the holder won — upside above the cap was given up */
  capGiveups: number;
  /** across settled events, totals in cents */
  protectedTotalCents: number;
  nakedTotalCents: number;
  deltaTotalCents: number;
  /** realized delta as bps of total staked notional (100c x contracts per event) */
  realizedDeltaBpsOfStake: number | null;
  /** average quoted EV cost across all opened positions, bps */
  quotedAvgEvBps: number | null;
  routeSplit: Record<string, number>;
  firstOpenedAt: string | null;
  lastSettledAt: string | null;
  /** the protection writer's side of the same settled events */
  writer: ShadowWriterSummary;
  /**
   * THE HEDGE-LAYER IDENTITY. Leg-for-leg, the writer's realized P&L on settled events must equal
   * the published take booked on them: the hedge pays the floor, the cap slice pays the hedge, and
   * nothing depends on who won. `gapCents` is what is left after that (per-position round-ups on
   * hedge units, in the writer's favour by construction); `holds` is |gap| within tolerance.
   */
  identity: ShadowIdentity;
  /** the same book cut by hedge route, by league and by kind (sports vs crypto): where protection is cheap and where it is rich */
  segments: { byRoute: Record<string, ShadowSegment>; byLeague: Record<string, ShadowSegment>; byKind: Record<string, ShadowSegment> };
  /** what each proposed rule would have done on the same events (shadow v2 records only) */
  counterfactuals: ShadowCounterfactualSummary;
  /** positions the user left before the lock, priced as a new trade at live books */
  closed: ShadowClosedSummary;
  /** contracts protection put on public books, one total; the public page does not cut it by venue */
  flow: ShadowFlowSummary;
}

/**
 * FLOW ONTO PUBLIC BOOKS. Every protection buys its other side on a public book at open, leg for
 * leg, so the record is also a count of the contracts protection sent to those books. Summed as
 * one total over every position opened in the window, whatever it later became (settled, closed
 * early, voided): the hedge was placed at open. The split by route stays on the operator report.
 */
export interface ShadowFlowWindow {
  /** positions opened in the window */
  positions: number;
  /** units bought on public books at open, milli (hedgeUnitsOf) */
  contractsMilli: number;
  /** the same in whole contracts, rounded */
  contracts: number;
  /** what those units cost at open, cents, venue fees included (hedgeCostOf) */
  hedgeNotionalCents: number;
  /** stake protected in the window, cents: 100c x contracts per position */
  stakeCents: number;
  /** when the window opens: now minus the window for the rolling one, first open for all time */
  since: string | null;
}

export interface ShadowFlowSummary {
  asOf: string;
  windowDays: number;
  last30Days: ShadowFlowWindow;
  allTime: ShadowFlowWindow;
}

export const FLOW_WINDOW_DAYS = 30;

export function summarizeFlow(positions: readonly ShadowPosition[], now: Date = new Date()): ShadowFlowSummary {
  const nowMs = now.getTime();
  const sinceMs = nowMs - FLOW_WINDOW_DAYS * 86_400_000;
  const empty = (since: string | null): ShadowFlowWindow => ({ positions: 0, contractsMilli: 0, contracts: 0, hedgeNotionalCents: 0, stakeCents: 0, since });
  const recent = empty(new Date(sinceMs).toISOString());
  const all = empty(null);
  for (const p of positions) {
    const openedMs = Date.parse(p.at);
    const units = hedgeUnitsOf(p);
    const cost = hedgeCostOf(p);
    const stake = 100 * p.contracts;
    for (const w of openedMs >= sinceMs && openedMs <= nowMs ? [recent, all] : [all]) {
      w.positions += 1;
      w.contractsMilli += units;
      w.hedgeNotionalCents += cost;
      w.stakeCents += stake;
    }
    if (all.since === null || p.at < all.since) all.since = p.at;
  }
  for (const w of [recent, all]) w.contracts = Math.round(w.contractsMilli / 1000);
  return { asOf: now.toISOString(), windowDays: FLOW_WINDOW_DAYS, last30Days: recent, allTime: all };
}

export interface ShadowClosedSummary {
  count: number;
  /** attempts where a leg had no depth; those positions ran to settlement instead */
  unpriced: number;
  /** across closed: what users walked away with, credit included */
  protectedAtCloseCents: number;
  /** across closed: the same sale with no protection ever bought */
  nakedAtCloseCents: number;
  /** protected minus naked at the close */
  deltaCents: number;
  /** across closed positions that had a live mid: the frictionless reference and what crossing the books cost */
  withMid: number;
  protectedAtMidCents: number;
  unwindFrictionCents: number;
  /** venue taker fees paid on both legs */
  feesCents: number;
  /** the writer's result on closed positions and the take booked on them: equal by construction */
  writerPnlCents: number;
  takeBookedCents: number;
  /** stake across closed positions (100c x contracts), for percentages */
  stakeCents: number;
  byKind: Record<string, { closed: number; unpriced: number }>;
}

export interface ShadowIdentity {
  settled: number;
  writerPnlCents: number;
  takeBookedCents: number;
  /** writer P&L minus take booked */
  gapCents: number;
  /** |gap| as bps of settled stake (null when nothing settled) */
  gapBpsOfStake: number | null;
  /** hedge payouts received minus hedge cost paid (the hedge funded itself when >= 0) */
  hedgeNetCents: number;
  /** cap slices kept minus floors paid minus credits paid (the holder legs) */
  holderLegsNetCents: number;
  /** true when the gap is inside the rounding tolerance (1¢ per settled position) */
  holds: boolean;
}

/** One slice of the book (a route or a league): what protection cost there, quoted and realized. */
export interface ShadowSegment {
  opened: number;
  settled: number;
  stakeSettledCents: number;
  /** mean quoted EV cost across every position opened in this slice, bps of naked EV */
  quotedAvgEvBps: number | null;
  /** across settled: holder's protected minus naked, and as bps of settled stake */
  holderDeltaCents: number;
  holderDeltaBpsOfStake: number | null;
  creditsCents: number;
  takeCents: number;
  writerPnlCents: number;
}

const newSegment = (): ShadowSegment => ({
  opened: 0,
  settled: 0,
  stakeSettledCents: 0,
  quotedAvgEvBps: null,
  holderDeltaCents: 0,
  holderDeltaBpsOfStake: null,
  creditsCents: 0,
  takeCents: 0,
  writerPnlCents: 0,
});

/** One rule's book: quoted, settled, and what it would have paid each side. */
export interface RuleBook {
  /** positions where this rule produced a quote */
  quoted: number;
  /** positions where this rule refused (the live quote existed; this rule declined) */
  refused: number;
  settled: number;
  /** stake across settled positions this rule quoted, cents */
  stakeSettledCents: number;
  /** credits this rule would have paid on quoted positions */
  creditsCents: number;
  /** take this rule would have booked on quoted positions */
  takeCents: number;
  /** average quoted EV cost across quoted positions, bps */
  quotedAvgEvBps: number | null;
  /** across settled: holder's protected minus naked */
  holderDeltaCents: number;
  /** across settled: writer's net */
  writerPnlCents: number;
}

export interface ShadowCounterfactualSummary {
  /** first open that carried counterfactuals; null when none do yet */
  recordedSince: string | null;
  positionsWithCounterfactuals: number;
  /** the live book restricted to the same positions, for a like-for-like baseline */
  baseline: RuleBook;
  tiers: Record<ProtectionTier, RuleBook>;
  feeRules: Record<FeeRuleLabel, RuleBook>;
  /** capacity curve: the default tier at each size multiple, same books */
  capacity: Array<
    RuleBook & {
      mult: number;
      /** gross credit summed over quoted probes, cents */
      grossCreditCents: number;
      /** stake summed over quoted probes (100c x contracts at that size) */
      stakeQuotedCents: number;
      /** gross credit as bps of stake, quoted probes */
      grossBpsOfStake: number | null;
    }
  >;
  /**
   * ROUTING, MEASURED. Sports positions whose open carried both routes: the live book (the cheaper
   * route, as written) beside the same positions forced onto each route. "Kalshi-only" is what a
   * production hedge that must run on the market's own No side would have cost; the pairwise
   * numbers compare only positions both routes quoted, so a refusal on one side does not pass as
   * a saving. Operator report only.
   */
  routes: ShadowRouteComparison;
}

export interface ShadowRouteComparison {
  recordedSince: string | null;
  /** sports positions carrying route counterfactuals (crypto has one route and is left out) */
  positions: number;
  /** how the record actually routed those positions */
  liveRouteSplit: Record<string, number>;
  live: RuleBook;
  kalshiOnly: RuleBook;
  crossOnly: RuleBook;
  /** positions both routes quoted; the pairwise fields below are over these */
  bothQuoted: number;
  /** average quoted EV cost, kalshi-only minus live, bps (positive: kalshi-only is richer) */
  kalshiOnlyExtraEvBps: number | null;
  /** credits users would have been paid under kalshi-only minus what the live route paid, cents */
  kalshiOnlyCreditDeltaCents: number;
  /** positions the live route quoted that kalshi-only refused: coverage lost, not cost */
  kalshiOnlyRefusedWhereLiveQuoted: number;
  /**
   * Other regulated exchanges read as price references: the same positions priced on each one's
   * book. One row per reference id the record has seen; empty until a reference is configured.
   */
  references: ReferenceBookComparison[];
  /**
   * Exchanges that publish only yesterday's tape: the opposing outcome's last print there against
   * the price the live hedge paid. A sign of where that venue trades, never a quote; empty until
   * a print source is configured.
   */
  prints: ReferencePrintComparison[];
}

/** One print source beside the live hedge's price, over the positions whose open carried it. */
export interface ReferencePrintComparison {
  id: string;
  /** positions whose open read this source (printed or not) */
  positions: number;
  /** positions where the venue had printed the opposing outcome on its last published day */
  printed: number;
  /** positions where it had not, or the file could not be read */
  unprinted: number;
  /** average of (last print minus the live hedge's average price), cents, over printed positions */
  avgGapCents: number | null;
  /** printed positions where the venue's last print was above the live hedge's price */
  richer: number;
  /** printed positions where it was below */
  cheaper: number;
  /** average age of the print at the quote, hours */
  avgAgeHours: number | null;
  /** average contracts the venue traded that day on the opposing outcome */
  avgDayContracts: number | null;
}

/** One reference book beside the live route, over the positions whose open carried it. */
export interface ReferenceBookComparison extends RuleBook {
  id: string;
  /** positions whose open read this reference (listed or not) */
  positions: number;
  /** positions where the venue listed the game and a book was read */
  listed: number;
  /** positions where it did not list the game, or could not be reached: coverage, not price */
  unlisted: number;
  /** positions this reference quoted that the live route also quoted; the pairwise fields are over these */
  bothQuoted: number;
  /** average quoted EV cost, this reference minus live, bps (positive: the reference is richer) */
  extraEvBps: number | null;
  /** credits users would have been paid on this reference minus what the live route paid, cents */
  creditDeltaCents: number;
}

function emptyRuleBook(): RuleBook {
  return {
    quoted: 0,
    refused: 0,
    settled: 0,
    stakeSettledCents: 0,
    creditsCents: 0,
    takeCents: 0,
    quotedAvgEvBps: null,
    holderDeltaCents: 0,
    writerPnlCents: 0,
  };
}

/** Fold one alternative (or the live terms) into a rule book; `evSum` accumulates for the average. */
function foldRule(
  book: RuleBook & { evSum?: number },
  alt: ShadowAltTerms,
  contracts: number,
  result: "yes" | "no" | undefined,
): void {
  if (!alt.ok) {
    book.refused += 1;
    return;
  }
  book.quoted += 1;
  book.creditsCents += alt.creditCents;
  book.takeCents += alt.takeCents;
  book.evSum = (book.evSum ?? 0) + alt.evCostBps;
  if (result) {
    const out = altOutcome(alt, contracts, result);
    if (out) {
      book.settled += 1;
      book.stakeSettledCents += 100 * contracts;
      book.holderDeltaCents += out.deltaCents;
      book.writerPnlCents += out.writerCents;
    }
  }
}

function finishRule<T extends RuleBook & { evSum?: number }>(book: T): T {
  book.quotedAvgEvBps = book.quoted > 0 ? Math.round((book.evSum ?? 0) / book.quoted) : null;
  delete book.evSum;
  return book;
}

/** The live position's own terms in the alternative shape, so the baseline folds through the same code. */
function liveAsAlt(p: ShadowPosition): Extract<ShadowAltTerms, { ok: true }> {
  return {
    ok: true,
    floorCents: p.floorCents,
    capCents: p.capCents,
    creditCents: p.creditCents,
    grossCreditCents: p.creditCents + p.takeCents,
    takeCents: p.takeCents,
    takeRule: p.takeRule ?? (p.takeCents === 0 ? "waived" : "share"),
    feesCents: p.feesCents,
    hedgeCostCents: hedgeCostOf(p),
    hedgeUnitsMilli: hedgeUnitsOf(p),
    evCostBps: p.evCostBps,
  };
}

export function summarizeCounterfactuals(positions: ShadowPosition[]): ShadowCounterfactualSummary {
  const withCf = positions.filter((p) => p.counterfactuals && p.status !== "void");
  const baseline: RuleBook & { evSum?: number } = emptyRuleBook();
  const tiers = Object.fromEntries(PROTECTION_TIERS.map((t) => [t, emptyRuleBook()])) as Record<
    ProtectionTier,
    RuleBook & { evSum?: number }
  >;
  const feeRules = Object.fromEntries(FEE_RULE_LABELS.map((l) => [l, emptyRuleBook()])) as Record<
    FeeRuleLabel,
    RuleBook & { evSum?: number }
  >;
  const capacity = SIZE_LADDER_MULTS.map((mult) => ({
    ...emptyRuleBook(),
    mult,
    grossCreditCents: 0,
    stakeQuotedCents: 0,
    grossBpsOfStake: null as number | null,
    evSum: 0,
  }));
  let recordedSince: string | null = null;
  const routes: ShadowRouteComparison & { live: RuleBook & { evSum?: number }; kalshiOnly: RuleBook & { evSum?: number }; crossOnly: RuleBook & { evSum?: number } } = {
    recordedSince: null,
    positions: 0,
    liveRouteSplit: {},
    live: emptyRuleBook(),
    kalshiOnly: emptyRuleBook(),
    crossOnly: emptyRuleBook(),
    bothQuoted: 0,
    kalshiOnlyExtraEvBps: null,
    kalshiOnlyCreditDeltaCents: 0,
    kalshiOnlyRefusedWhereLiveQuoted: 0,
    references: [],
    prints: [],
  };
  let routeEvDiffSum = 0;
  const prints = new Map<string, ReferencePrintComparison & { gapSum: number; ageSum: number; contractsSum: number }>();
  const printRow = (id: string) => {
    let row = prints.get(id);
    if (!row) {
      row = { id, positions: 0, printed: 0, unprinted: 0, avgGapCents: null, richer: 0, cheaper: 0, avgAgeHours: null, avgDayContracts: null, gapSum: 0, ageSum: 0, contractsSum: 0 };
      prints.set(id, row);
    }
    return row;
  };
  const references = new Map<string, ReferenceBookComparison & { evSum?: number; evDiffSum: number }>();
  const referenceRow = (id: string) => {
    let row = references.get(id);
    if (!row) {
      row = { ...emptyRuleBook(), id, positions: 0, listed: 0, unlisted: 0, bothQuoted: 0, extraEvBps: null, creditDeltaCents: 0, evDiffSum: 0 };
      references.set(id, row);
    }
    return row;
  };

  for (const p of withCf) {
    const cf = p.counterfactuals as ShadowCounterfactuals;
    if (!recordedSince || p.at < recordedSince) recordedSince = p.at;
    const result = p.status === "settled" ? p.result : undefined;
    foldRule(baseline, liveAsAlt(p), p.contracts, result);
    if (cf.routes && p.kind === "sports") {
      routes.positions += 1;
      if (!routes.recordedSince || p.at < routes.recordedSince) routes.recordedSince = p.at;
      routes.liveRouteSplit[p.route] = (routes.liveRouteSplit[p.route] ?? 0) + 1;
      const live = liveAsAlt(p);
      const k = cf.routes.kalshi_self;
      const x = cf.routes.polymarket;
      foldRule(routes.live, live, p.contracts, result);
      foldRule(routes.kalshiOnly, k, p.contracts, result);
      foldRule(routes.crossOnly, x, p.contracts, result);
      if (k.ok) {
        routes.bothQuoted += 1;
        routeEvDiffSum += k.evCostBps - live.evCostBps;
        routes.kalshiOnlyCreditDeltaCents += k.creditCents - live.creditCents;
      } else {
        routes.kalshiOnlyRefusedWhereLiveQuoted += 1;
      }
    }
    // A reference that did not list the game is coverage, not a refusal on price: it is counted
    // apart and kept out of the rule book, so quoted + refused is over listed games only.
    for (const ref of cf.references ?? []) {
      if (p.kind !== "sports") continue;
      const row = referenceRow(ref.id);
      row.positions += 1;
      const listed = ref.terms.ok || ref.bestAskMilli !== null;
      if (!listed) {
        row.unlisted += 1;
        continue;
      }
      row.listed += 1;
      const live = liveAsAlt(p);
      foldRule(row, ref.terms, p.contracts, result);
      if (ref.terms.ok) {
        row.bothQuoted += 1;
        row.evDiffSum += ref.terms.evCostBps - live.evCostBps;
        row.creditDeltaCents += ref.terms.creditCents - live.creditCents;
      }
    }
    for (const pr of cf.prints ?? []) {
      if (p.kind !== "sports") continue;
      const row = printRow(pr.id);
      row.positions += 1;
      if (!pr.ok) {
        row.unprinted += 1;
        continue;
      }
      row.printed += 1;
      row.gapSum += pr.gapCents;
      row.ageSum += pr.ageHours;
      row.contractsSum += pr.dayContracts;
      if (pr.gapCents > 0) row.richer += 1;
      else if (pr.gapCents < 0) row.cheaper += 1;
    }
    for (const tier of PROTECTION_TIERS) {
      const alt = cf.alternatives?.[tier];
      // A tier the venues did not fund distinctly collapsed into another; it is not a refusal.
      if (alt) foldRule(tiers[tier], alt, p.contracts, result);
    }
    for (const label of FEE_RULE_LABELS) {
      const alt = cf.feeRules?.[label];
      if (alt) foldRule(feeRules[label], alt, p.contracts, result);
    }
    for (const probe of cf.sizeLadder ?? []) {
      const row = capacity.find((c) => c.mult === probe.mult);
      if (!row) continue;
      foldRule(row, probe.terms, probe.contracts, result);
      if (probe.terms.ok) {
        row.grossCreditCents += probe.terms.grossCreditCents;
        row.stakeQuotedCents += 100 * probe.contracts;
      }
    }
  }

  for (const row of capacity) {
    row.grossBpsOfStake =
      row.stakeQuotedCents > 0 ? Math.round((row.grossCreditCents / row.stakeQuotedCents) * 10_000) : null;
  }
  routes.kalshiOnlyExtraEvBps = routes.bothQuoted > 0 ? Math.round(routeEvDiffSum / routes.bothQuoted) : null;
  routes.references = [...references.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ evDiffSum, ...row }) => {
      const done = finishRule(row);
      done.extraEvBps = done.bothQuoted > 0 ? Math.round(evDiffSum / done.bothQuoted) : null;
      return done;
    });
  routes.prints = [...prints.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ gapSum, ageSum, contractsSum, ...row }) => ({
      ...row,
      avgGapCents: row.printed > 0 ? Math.round((gapSum / row.printed) * 10) / 10 : null,
      avgAgeHours: row.printed > 0 ? Math.round((ageSum / row.printed) * 10) / 10 : null,
      avgDayContracts: row.printed > 0 ? Math.round(contractsSum / row.printed) : null,
    }));
  return {
    recordedSince,
    positionsWithCounterfactuals: withCf.length,
    baseline: finishRule(baseline),
    tiers: Object.fromEntries(PROTECTION_TIERS.map((t) => [t, finishRule(tiers[t])])) as Record<ProtectionTier, RuleBook>,
    feeRules: Object.fromEntries(FEE_RULE_LABELS.map((l) => [l, finishRule(feeRules[l])])) as Record<FeeRuleLabel, RuleBook>,
    capacity: capacity.map((row) => finishRule(row)),
    routes: { ...routes, live: finishRule(routes.live), kalshiOnly: finishRule(routes.kalshiOnly), crossOnly: finishRule(routes.crossOnly) },
  };
}

/**
 * The writer's book: what selling the protection and carrying the hedge
 * actually netted, in integer cents, split so a desk can check the claim
 * that the result does not depend on who won.
 */
export interface ShadowWriterSummary {
  /** realized across settled events: cap slices kept + hedge payouts - floors paid - credits - hedge cost */
  settledPnlCents: number;
  /** realized as bps of settled stake (100c x contracts per event) */
  settledPnlBpsOfStake: number | null;
  /** the same P&L split by outcome; leg-for-leg means these are the published take either way */
  pnlWhenHolderWonCents: number;
  pnlWhenHolderLostCents: number;
  settledWhenHolderWon: number;
  settledWhenHolderLost: number;
  /** gross legs across settled events */
  capSlicesKeptCents: number;
  floorsPaidCents: number;
  creditsPaidCents: number;
  hedgeCostCents: number;
  hedgePayoutsCents: number;
  /** published take booked on settled events (what P&L should equal, before round-up) */
  takeBookedCents: number;
  /** published take locked on still-open positions, realized when they settle */
  takeLockedOpenCents: number;
  byLeague: Record<string, { settled: number; open: number; pnlCents: number; stakeCents: number }>;
}

export function summarizeShadow(positions: ShadowPosition[], now: Date = new Date()): ShadowSummary {
  const settled = positions.filter((p) => p.status === "settled");
  const routeSplit: Record<string, number> = {};
  let quotedBpsSum = 0;
  let firstOpenedAt: string | null = null;
  const byLeague: ShadowWriterSummary["byLeague"] = {};
  let takeLockedOpenCents = 0;
  const segRoute: Record<string, ShadowSegment & { evSum: number }> = {};
  const segLeague: Record<string, ShadowSegment & { evSum: number }> = {};
  const segKind: Record<string, ShadowSegment & { evSum: number }> = {};
  const seg = (m: Record<string, ShadowSegment & { evSum: number }>, k: string) => (m[k] ??= { ...newSegment(), evSum: 0 });
  for (const p of positions) {
    routeSplit[p.route] = (routeSplit[p.route] ?? 0) + 1;
    quotedBpsSum += p.evCostBps;
    for (const sg of [seg(segRoute, p.route), seg(segLeague, p.league), seg(segKind, p.kind)]) {
      sg.opened += 1;
      sg.evSum += p.evCostBps;
    }
    if (!firstOpenedAt || p.at < firstOpenedAt) firstOpenedAt = p.at;
    const lg = (byLeague[p.league] ??= { settled: 0, open: 0, pnlCents: 0, stakeCents: 0 });
    if (p.status === "open") {
      lg.open += 1;
      takeLockedOpenCents += p.takeCents;
    }
  }
  let protectedTotalCents = 0;
  let nakedTotalCents = 0;
  let stakeCents = 0;
  let lastSettledAt: string | null = null;
  const w: ShadowWriterSummary = {
    settledPnlCents: 0,
    settledPnlBpsOfStake: null,
    pnlWhenHolderWonCents: 0,
    pnlWhenHolderLostCents: 0,
    settledWhenHolderWon: 0,
    settledWhenHolderLost: 0,
    capSlicesKeptCents: 0,
    floorsPaidCents: 0,
    creditsPaidCents: 0,
    hedgeCostCents: 0,
    hedgePayoutsCents: 0,
    takeBookedCents: 0,
    takeLockedOpenCents,
    byLeague,
  };
  for (const p of settled) {
    protectedTotalCents += p.protectedCents ?? 0;
    nakedTotalCents += p.nakedCents ?? 0;
    stakeCents += 100 * p.contracts;
    if (p.settledAt && (!lastSettledAt || p.settledAt > lastSettledAt)) lastSettledAt = p.settledAt;

    const result = p.result ?? "no";
    const wp = writerPayouts(p, result);
    w.settledPnlCents += wp.writerCents;
    w.creditsPaidCents += p.creditCents;
    w.hedgeCostCents += wp.hedgeCostCents;
    w.hedgePayoutsCents += wp.hedgePayoutCents;
    w.takeBookedCents += p.takeCents;
    if (result === "yes") {
      w.pnlWhenHolderWonCents += wp.writerCents;
      w.settledWhenHolderWon += 1;
      w.capSlicesKeptCents += wp.fundingCents;
    } else {
      w.pnlWhenHolderLostCents += wp.writerCents;
      w.settledWhenHolderLost += 1;
      w.floorsPaidCents += p.floorCents * p.contracts;
    }
    const lg = byLeague[p.league];
    lg.settled += 1;
    lg.pnlCents += wp.writerCents;
    lg.stakeCents += 100 * p.contracts;
    for (const sg of [seg(segRoute, p.route), seg(segLeague, p.league), seg(segKind, p.kind)]) {
      sg.settled += 1;
      sg.stakeSettledCents += 100 * p.contracts;
      sg.holderDeltaCents += (p.protectedCents ?? 0) - (p.nakedCents ?? 0);
      sg.creditsCents += p.creditCents;
      sg.takeCents += p.takeCents;
      sg.writerPnlCents += wp.writerCents;
    }
  }
  w.settledPnlBpsOfStake = stakeCents > 0 ? Math.round((w.settledPnlCents / stakeCents) * 10_000) : null;
  const deltaTotalCents = protectedTotalCents - nakedTotalCents;
  const finishSegment = (m: Record<string, ShadowSegment & { evSum: number }>): Record<string, ShadowSegment> =>
    Object.fromEntries(
      Object.entries(m).map(([k, v]) => {
        const { evSum, ...rest } = v;
        return [
          k,
          {
            ...rest,
            quotedAvgEvBps: rest.opened > 0 ? Math.round(evSum / rest.opened) : null,
            holderDeltaBpsOfStake: rest.stakeSettledCents > 0 ? Math.round((rest.holderDeltaCents / rest.stakeSettledCents) * 10_000) : null,
          },
        ];
      }),
    );
  const closed = summarizeClosed(positions);
  const gapCents = w.settledPnlCents - w.takeBookedCents;
  const identity: ShadowIdentity = {
    settled: settled.length,
    writerPnlCents: w.settledPnlCents,
    takeBookedCents: w.takeBookedCents,
    gapCents,
    gapBpsOfStake: stakeCents > 0 ? Math.round((Math.abs(gapCents) / stakeCents) * 10_000) : null,
    hedgeNetCents: w.hedgePayoutsCents - w.hedgeCostCents,
    holderLegsNetCents: w.capSlicesKeptCents - w.floorsPaidCents - w.creditsPaidCents,
    holds: Math.abs(gapCents) <= settled.length,
  };
  return {
    openCount: positions.filter((p) => p.status === "open").length,
    settledCount: settled.length,
    voidCount: positions.filter((p) => p.status === "void").length,
    floorSaves: settled.filter((p) => p.result === "no").length,
    capGiveups: settled.filter((p) => p.result === "yes").length,
    protectedTotalCents,
    nakedTotalCents,
    deltaTotalCents,
    realizedDeltaBpsOfStake:
      stakeCents > 0 ? Math.round((deltaTotalCents / stakeCents) * 10_000) : null,
    quotedAvgEvBps: positions.length > 0 ? Math.round(quotedBpsSum / positions.length) : null,
    routeSplit,
    firstOpenedAt,
    lastSettledAt,
    writer: w,
    identity,
    segments: { byRoute: finishSegment(segRoute), byLeague: finishSegment(segLeague), byKind: finishSegment(segKind) },
    counterfactuals: summarizeCounterfactuals(positions),
    closed,
    flow: summarizeFlow(positions, now),
  };
}

/** The early closes: what leaving at live prices paid the user and cost against the mid. */
export function summarizeClosed(positions: ShadowPosition[]): ShadowClosedSummary {
  const out: ShadowClosedSummary = {
    count: 0,
    unpriced: 0,
    protectedAtCloseCents: 0,
    nakedAtCloseCents: 0,
    deltaCents: 0,
    withMid: 0,
    protectedAtMidCents: 0,
    unwindFrictionCents: 0,
    feesCents: 0,
    writerPnlCents: 0,
    takeBookedCents: 0,
    stakeCents: 0,
    byKind: {},
  };
  for (const p of positions) {
    const k = (out.byKind[p.kind] ??= { closed: 0, unpriced: 0 });
    if (p.closeUnpriced && p.status !== "closed") {
      out.unpriced += 1;
      k.unpriced += 1;
    }
    if (p.status !== "closed") continue;
    out.count += 1;
    k.closed += 1;
    out.protectedAtCloseCents += p.protectedCents ?? 0;
    out.nakedAtCloseCents += p.nakedCents ?? 0;
    out.feesCents += p.closeFeesCents ?? 0;
    out.writerPnlCents += p.writerCents ?? 0;
    out.takeBookedCents += p.takeCents;
    out.stakeCents += 100 * p.contracts;
    if (typeof p.closeProtectedAtMidCents === "number" && typeof p.closeUnwindFrictionCents === "number") {
      out.withMid += 1;
      out.protectedAtMidCents += p.closeProtectedAtMidCents;
      out.unwindFrictionCents += p.closeUnwindFrictionCents;
    }
  }
  out.deltaCents = out.protectedAtCloseCents - out.nakedAtCloseCents;
  return out;
}

/** Column order of the positions CSV; stable so downstream sheets do not break. */
/**
 * The public spreadsheet: what was quoted, what settled, both sides' money.
 * Enough for a reviewer to recompute every row; nothing about the rules
 * under evaluation.
 */
export const POSITIONS_CSV_PUBLIC_COLUMNS = [
  "ticker",
  "league",
  "kind",
  "side",
  "event",
  "event_time_utc",
  "opened_at_utc",
  "status",
  "result",
  "settled_at_utc",
  "route",
  "contracts",
  "mark_c",
  "floor_c",
  "cap_c",
  "credit_c",
  "take_c",
  "fees_c",
  "hedge_units_milli",
  "hedge_cost_c",
  "hedge_payout_c",
  "holder_protected_c",
  "holder_naked_c",
  "holder_delta_c",
  "writer_pnl_c",
  "ev_cost_bps",
  "tier",
  "closed_at_utc",
  "close_mid_c",
  "close_fill_c",
  "close_fees_c",
  "close_friction_c",
] as const;

/** Every column: the public set, then the recorded fee rule and every counterfactual (operator export). */
export const POSITIONS_CSV_COLUMNS = [
  ...POSITIONS_CSV_PUBLIC_COLUMNS,
  "take_rule",
  "take_share_c",
  "take_min_c",
  ...PROTECTION_TIERS.flatMap((t) => [
    `${t}_floor_c`,
    `${t}_cap_c`,
    `${t}_credit_c`,
    `${t}_take_c`,
    `${t}_ev_bps`,
    `${t}_holder_delta_c`,
    `${t}_writer_pnl_c`,
  ]),
  ...FEE_RULE_LABELS.flatMap((l) => [`${l}_take_c`, `${l}_credit_c`, `${l}_refused`]),
  ...SIZE_LADDER_MULTS.filter((m) => m > 1).flatMap((m) => [`x${m}_contracts`, `x${m}_gross_c`, `x${m}_credit_c`, `x${m}_refused`]),
] as const;

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * One row per position, every status, all money in integer cents. This is
 * the spreadsheet form of the ledger: what a reviewer opens to recompute the
 * writer's P&L row by row.
 */
export type PositionsCsvScope = "public" | "full";

export function positionsCsv(positions: ShadowPosition[], scope: PositionsCsvScope = "full"): string {
  const columns = scope === "public" ? POSITIONS_CSV_PUBLIC_COLUMNS : POSITIONS_CSV_COLUMNS;
  const rows = [...positions]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((p) => {
      const settled = p.status === "settled" || p.status === "closed";
      const closed = p.status === "closed";
      return [
        p.ticker,
        p.league,
        p.kind,
        p.sideName,
        p.eventTitle,
        p.eventTimeIso,
        p.at,
        p.status,
        p.result ?? "",
        p.settledAt ?? "",
        p.route,
        p.contracts,
        p.markCents,
        p.floorCents,
        p.capCents,
        p.creditCents,
        p.takeCents,
        p.feesCents,
        hedgeUnitsOf(p),
        hedgeCostOf(p),
        settled ? (p.hedgePayoutCents ?? 0) : "",
        settled ? (p.protectedCents ?? 0) : "",
        settled ? (p.nakedCents ?? 0) : "",
        settled ? (p.deltaCents ?? 0) : "",
        settled ? (p.writerCents ?? 0) : "",
        p.evCostBps,
        p.tier ?? "",
        closed ? (p.closedAt ?? "") : "",
        closed ? (p.closeYesMidCents ?? "") : "",
        closed ? (p.closeYesFillCents ?? "") : "",
        closed ? (p.closeFeesCents ?? 0) : "",
        closed ? (p.closeUnwindFrictionCents ?? "") : "",
        ...(scope === "full" ? counterfactualCells(p) : []),
      ]
        .map(csvCell)
        .join(",");
    });
  return [columns.join(","), ...rows].join("\n") + "\n";
}

/** The operator-only columns for one row; blanks when the record predates counterfactuals. */
function counterfactualCells(p: ShadowPosition): Array<string | number> {
  const cf = p.counterfactuals;
  const result = p.status === "settled" ? p.result : undefined;
  const head: Array<string | number> = [p.takeRule ?? "", p.takeShareCents ?? "", p.takeMinimumCents ?? ""];
  const tierCells = PROTECTION_TIERS.flatMap((t) => {
    const alt = cf?.alternatives?.[t];
    if (!alt || !alt.ok) return ["", "", "", "", "", "", ""];
    const out = result ? altOutcome(alt, p.contracts, result) : null;
    return [alt.floorCents, alt.capCents, alt.creditCents, alt.takeCents, alt.evCostBps, out?.deltaCents ?? "", out?.writerCents ?? ""];
  });
  const feeCells = FEE_RULE_LABELS.flatMap((l) => {
    const alt = cf?.feeRules?.[l];
    if (!alt) return ["", "", ""];
    return alt.ok ? [alt.takeCents, alt.creditCents, 0] : ["", "", 1];
  });
  const sizeCells = SIZE_LADDER_MULTS.filter((m) => m > 1).flatMap((m) => {
    const probe = cf?.sizeLadder?.find((s) => s.mult === m);
    if (!probe) return ["", "", "", ""];
    return probe.terms.ok
      ? [probe.contracts, probe.terms.grossCreditCents, probe.terms.creditCents, 0]
      : [probe.contracts, "", "", 1];
  });
  return [...head, ...tierCells, ...feeCells, ...sizeCells];
}
