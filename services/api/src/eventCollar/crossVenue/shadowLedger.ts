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

export function appendShadowRecord(path: string, record: ShadowRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
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
      byTicker.set(rec.ticker, {
        ...pos,
        status: "settled",
        result: rec.result,
        settledAt: rec.at,
        ...pay,
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
}

export function summarizeShadow(positions: ShadowPosition[]): ShadowSummary {
  const settled = positions.filter((p) => p.status === "settled");
  const routeSplit: Record<string, number> = {};
  let quotedBpsSum = 0;
  let firstOpenedAt: string | null = null;
  for (const p of positions) {
    routeSplit[p.route] = (routeSplit[p.route] ?? 0) + 1;
    quotedBpsSum += p.evCostBps;
    if (!firstOpenedAt || p.at < firstOpenedAt) firstOpenedAt = p.at;
  }
  let protectedTotalCents = 0;
  let nakedTotalCents = 0;
  let stakeCents = 0;
  let lastSettledAt: string | null = null;
  for (const p of settled) {
    protectedTotalCents += p.protectedCents ?? 0;
    nakedTotalCents += p.nakedCents ?? 0;
    stakeCents += 100 * p.contracts;
    if (p.settledAt && (!lastSettledAt || p.settledAt > lastSettledAt)) lastSettledAt = p.settledAt;
  }
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
  };
}
