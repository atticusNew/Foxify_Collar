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
import type { HedgeRoute } from "./types";

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
   * The hedge leg as quoted: walked cost in cents (fees included) and the NO
   * units bought, in milli (1000 = one $1-paying share/contract). Optional
   * because early ledgers predate these fields; both are recoverable from
   * the credit identity when absent (see writerPayouts).
   */
  hedgeCostCents?: number;
  hedgeUnitsMilli?: number;
}

/** The market finalized on Kalshi with an official result. */
export interface ShadowSettleRecord {
  type: "settle";
  at: string;
  ticker: string;
  result: "yes" | "no";
}

/** The market never produced a result (e.g. postponed and rebooked). */
export interface ShadowVoidRecord {
  type: "void";
  at: string;
  ticker: string;
  reason: string;
}

export type ShadowRecord = ShadowOpenRecord | ShadowSettleRecord | ShadowVoidRecord;

export interface ShadowPosition extends Omit<ShadowOpenRecord, "type"> {
  status: "open" | "settled" | "void";
  result?: "yes" | "no";
  settledAt?: string;
  voidReason?: string;
  /** total payout with protection: (cap if yes, floor if no) x contracts + credit */
  protectedCents?: number;
  /** total payout without protection: 100 x contracts if yes, 0 if no */
  nakedCents?: number;
  /** protected minus naked; positive = protection paid off on this event */
  deltaCents?: number;
  /** writer side, settled only: what the protection writer netted after hedge and credit */
  writerCents?: number;
  hedgePayoutCents?: number;
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
 * Hedge cost as quoted (fees included). Older records lack the field; the
 * pricer's credit identity recovers it exactly: gross = funding - hedgeCost
 * and credit = gross - take, so hedgeCost = funding - credit - take.
 */
export function hedgeCostOf(p: WriterInputs): number {
  return p.hedgeCostCents ?? fundingOf(p) - p.creditCents - p.takeCents;
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
        ...pay,
        writerCents: writer.writerCents,
        hedgePayoutCents: writer.hedgePayoutCents,
      });
    } else if (rec.type === "void") {
      const pos = byTicker.get(rec.ticker);
      if (!pos || pos.status !== "open") continue;
      byTicker.set(rec.ticker, { ...pos, status: "void", voidReason: rec.reason });
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

export function summarizeShadow(positions: ShadowPosition[]): ShadowSummary {
  const settled = positions.filter((p) => p.status === "settled");
  const routeSplit: Record<string, number> = {};
  let quotedBpsSum = 0;
  let firstOpenedAt: string | null = null;
  const byLeague: ShadowWriterSummary["byLeague"] = {};
  let takeLockedOpenCents = 0;
  for (const p of positions) {
    routeSplit[p.route] = (routeSplit[p.route] ?? 0) + 1;
    quotedBpsSum += p.evCostBps;
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
  }
  w.settledPnlBpsOfStake = stakeCents > 0 ? Math.round((w.settledPnlCents / stakeCents) * 10_000) : null;
  const deltaTotalCents = protectedTotalCents - nakedTotalCents;
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
  };
}

/** Column order of the positions CSV; stable so downstream sheets do not break. */
export const POSITIONS_CSV_COLUMNS = [
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
export function positionsCsv(positions: ShadowPosition[]): string {
  const rows = [...positions]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((p) => {
      const settled = p.status === "settled";
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
      ]
        .map(csvCell)
        .join(",");
    });
  return [POSITIONS_CSV_COLUMNS.join(","), ...rows].join("\n") + "\n";
}
