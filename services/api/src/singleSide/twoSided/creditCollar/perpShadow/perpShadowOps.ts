/**
 * Operations for the perp shadow: the pure half of "somebody is watching".
 *
 * Nine days of no settlements went unnoticed in October 2026 (OKX renamed the
 * delivered instruments; the parser found no print; the page kept rendering
 * stale numbers). Everything here is a pure function over the ledger and a
 * clock so the worker can raise an alarm, settle from a second source, and
 * post the Friday review, and so each of those is testable without a venue.
 *
 *   - watchdog: which loops have gone quiet, which positions are overdue
 *   - venue payload drift: did the real parsers read the live payloads
 *   - the Hyperliquid print at expiry, the second source before a void
 *   - the Friday review: one row per expiry, said vs seen, hand-back vs take,
 *     cumulative, with the two flags the founder asked to be told about
 *   - the public cap ladder: the counterfactual rungs compacted for the page
 *   - fees as a share of the credit the market funded
 *
 * None of this changes who keeps a payoff. The P&L identity is untouched:
 * trader = credit + floor payout - cap excess, writer = take.
 */

import { perpOutcome, type PerpCounterfactualSummary, type PerpShadowOpenRecord, type PerpShadowPosition, type PerpShadowSummary } from "./perpShadowLedger";
import type { Candle } from "./perpShadowPath";

// ── The floor drill ──────────────────────────────────────────────────────────

export type DrillPosition = Pick<PerpShadowOpenRecord, "side" | "contracts" | "ctValBtc" | "spotCents" | "floorStrikeCents" | "capStrikeCents" | "creditCents" | "takeCents">;

export interface FloorDrillResult {
  shockPct: number;
  positions: number;
  floorSaves: number;
  endedPastCap: number;
  between: number;
  /** what the users would have lost bare, cents (negative) */
  holderNakedCents: number;
  /** what the users end with under the collar, cents */
  holderProtectedCents: number;
  holderDeltaCents: number;
  /** the floor's payout: protected minus (naked + credit) on the floor saves, cents */
  floorPayoutCents: number;
  capExcessCents: number;
  takeCents: number;
  writerCents: number;
  /** writer minus take: must be 0 to the cent */
  gapCents: number;
  identityHolds: boolean;
  /** every floor save landed exactly at floor P&L + credit */
  floorClampHolds: boolean;
}

/**
 * The week that has not come yet: every position re-settled at spot moved by `shockPct`, no path
 * (the print alone), so the floor's payout path runs on the real book and the identity is checked
 * on it before a real one arrives. Pure; same outcome function the ledger settles with.
 */
export function floorDrill(positions: DrillPosition[], shockPct: number): FloorDrillResult {
  const r: FloorDrillResult = {
    shockPct,
    positions: positions.length,
    floorSaves: 0,
    endedPastCap: 0,
    between: 0,
    holderNakedCents: 0,
    holderProtectedCents: 0,
    holderDeltaCents: 0,
    floorPayoutCents: 0,
    capExcessCents: 0,
    takeCents: 0,
    writerCents: 0,
    gapCents: 0,
    identityHolds: true,
    floorClampHolds: true,
  };
  for (const p of positions) {
    const settle = Math.round(p.spotCents * (1 + shockPct));
    const o = perpOutcome(p, settle, { hasPath: false, openMs: 0, expiryMs: 0 }, "plain");
    r.holderNakedCents += o.nakedCents;
    r.holderProtectedCents += o.protectedCents;
    r.holderDeltaCents += o.deltaCents;
    r.capExcessCents += o.capExcessCents;
    r.takeCents += p.takeCents;
    r.writerCents += o.writerCents;
    if (o.floorSave) {
      r.floorSaves += 1;
      const qty = p.contracts * p.ctValBtc;
      const floorPnl = Math.round(qty * (p.floorStrikeCents - p.spotCents) * (p.side === "long" ? 1 : -1));
      const payout = o.protectedCents - (o.nakedCents + p.creditCents);
      r.floorPayoutCents += payout;
      if (Math.abs(o.protectedCents - (floorPnl + p.creditCents)) > 1) r.floorClampHolds = false;
    } else if (o.capExcessCents > 0) r.endedPastCap += 1;
    else r.between += 1;
  }
  r.gapCents = r.writerCents - r.takeCents;
  r.identityHolds = r.gapCents === 0;
  return r;
}

// ── Watchdog ─────────────────────────────────────────────────────────────────

export type PerpOpsAlarmKind = "settlement_stalled" | "quote_stalled" | "netting_stale" | "venue_payload_drift";

export interface PerpOpsAlarm {
  kind: PerpOpsAlarmKind;
  /** dedupe key: one alarm per condition per cooldown, not one per tick */
  key: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface WatchdogInput {
  nowMs: number;
  positions: PerpShadowPosition[];
  lastScanAtMs: number | null;
  lastSettleAtMs: number | null;
  lastScanError: string | null;
  lastSettleError: string | null;
  consecutiveScanFailures: number;
  /** the latest netted book snapshot, ms (flow mode) */
  lastBookAtMs: number | null;
  flowEnabled: boolean;
  scanMs: number;
  settleGraceMs: number;
  /** how long past expiry + grace an open position may sit before it is an alarm */
  settleStallMs: number;
  bootMs: number;
}

export const DEFAULT_SETTLE_STALL_MS = 6 * 3_600_000;

/** Which conditions deserve a message right now. Pure; the worker decides where it goes. */
export function watchdog(i: WatchdogInput): PerpOpsAlarm[] {
  const out: PerpOpsAlarm[] = [];
  const overdue = i.positions.filter((p) => p.status === "open" && Date.parse(p.expiryIso) + i.settleGraceMs + i.settleStallMs <= i.nowMs);
  if (overdue.length > 0) {
    const byExpiry = new Map<string, number>();
    for (const p of overdue) byExpiry.set(p.expiryIso, (byExpiry.get(p.expiryIso) ?? 0) + 1);
    const oldest = [...byExpiry.keys()].sort()[0];
    const hours = Math.floor((i.nowMs - Date.parse(oldest)) / 3_600_000);
    out.push({
      kind: "settlement_stalled",
      key: `settlement_stalled:${oldest}`,
      message: `${overdue.length} position${overdue.length === 1 ? "" : "s"} past expiry and still open; oldest expiry ${oldest.slice(0, 16).replace("T", " ")} UTC, ${hours}h ago${i.lastSettleError ? ` · last settle error: ${i.lastSettleError}` : ""}`,
      data: { overdue: overdue.length, expiries: Object.fromEntries(byExpiry), lastSettleAtMs: i.lastSettleAtMs, lastSettleError: i.lastSettleError },
    });
  }
  const sinceBoot = i.nowMs - i.bootMs;
  const quietFor = i.lastScanAtMs == null ? sinceBoot : i.nowMs - i.lastScanAtMs;
  if (quietFor > 3 * i.scanMs || i.consecutiveScanFailures >= 3) {
    out.push({
      kind: "quote_stalled",
      key: "quote_stalled",
      message: `no quote written for ${Math.floor(quietFor / 60_000)} minutes (scan every ${Math.round(i.scanMs / 60_000)}m)${i.consecutiveScanFailures ? ` · ${i.consecutiveScanFailures} consecutive scan failures` : ""}${i.lastScanError ? ` · last error: ${i.lastScanError}` : ""}`,
      data: { quietForMs: quietFor, consecutiveScanFailures: i.consecutiveScanFailures, lastScanError: i.lastScanError },
    });
  }
  if (i.flowEnabled) {
    const bookQuiet = i.lastBookAtMs == null ? sinceBoot : i.nowMs - i.lastBookAtMs;
    const hasOpen = i.positions.some((p) => p.status === "open");
    if (hasOpen && bookQuiet > 3 * i.scanMs) {
      out.push({
        kind: "netting_stale",
        key: "netting_stale",
        message: `the netted book snapshot is ${Math.floor(bookQuiet / 60_000)} minutes old with open positions on the book`,
        data: { bookQuietMs: bookQuiet, lastBookAtMs: i.lastBookAtMs },
      });
    }
  }
  return out;
}

// ── Venue payload drift ──────────────────────────────────────────────────────

export interface DriftCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** The one alarm for any parser that read a live payload and found nothing in it. Pure over the check results. */
export function driftAlarm(checks: DriftCheck[]): PerpOpsAlarm | null {
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) return null;
  return {
    kind: "venue_payload_drift",
    key: `venue_payload_drift:${failed.map((c) => c.name).sort().join(",")}`,
    message: `venue payload drift: ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")}`,
    data: { failed: failed.map((c) => c.name), checks },
  };
}

// ── The second print source ──────────────────────────────────────────────────

/**
 * The Hyperliquid mark at the expiry minute: the close of the last candle that
 * ends at or before expiry. Null unless a candle sits within `toleranceMs` of
 * expiry; a print is never invented from a candle an hour away.
 */
export function hlPrintAtExpiry(candles: Candle[], expiryMs: number, intervalMs: number, toleranceMs = 15 * 60_000): number | null {
  let best: Candle | null = null;
  for (const c of candles) {
    const endMs = c.t + intervalMs;
    if (endMs > expiryMs + 1) continue;
    if (!best || c.t > best.t) best = c;
  }
  if (!best) return null;
  if (expiryMs - (best.t + intervalMs) > toleranceMs) return null;
  return best.c;
}

// ── The Friday review ────────────────────────────────────────────────────────

export interface FridayRow {
  expiryIso: string;
  /** the official print the group settled on (cents); null when the group is mixed */
  settleCents: number | null;
  settleSource: string | null;
  settled: number;
  long: number;
  short: number;
  notionalCents: number;
  creditCents: number;
  takeCents: number;
  writerCents: number;
  holderDeltaCents: number;
  floorSaves: number;
  endedPastCap: number;
  touched: number;
  capExcessCents: number;
  /** hand-back beyond the credit on the cycles where it exceeded it */
  exceededCreditCents: number;
  /** mean market-implied odds at open of finishing past the cap, % */
  saidPct: number | null;
  /** realized share that finished past the cap, % */
  seenPct: number;
  cumulative: {
    settled: number;
    takeCents: number;
    capExcessCents: number;
    exceededCreditCents: number;
    saidPct: number | null;
    seenPct: number;
    /** hand-back as a share of take, % */
    handBackOfTakePct: number | null;
  };
  flags: FridayFlag[];
}

export type FridayFlag = "seen_above_said" | "hand_back_over_share" | "floor_paid";

export interface FridayReviewConfig {
  /** the published cap odds the rule targets, fraction (EP_CAP_EXCEED_PROB) */
  capExceedProb: number;
  /** flag when cumulative hand-back exceeds this share of cumulative take (default 0.5) */
  handBackShareOfTake: number;
  /** the cumulative check needs at least this many settled before it can flag (one Friday is one draw) */
  minSettledForFlags: number;
}

export const DEFAULT_FRIDAY_CONFIG: FridayReviewConfig = { capExceedProb: 0.2, handBackShareOfTake: 0.5, minSettledForFlags: 100 };

const pct1 = (num: number, den: number): number => (den > 0 ? Math.round((1000 * num) / den) / 10 : 0);

/**
 * One row per expiry that has settled, oldest first, each carrying the record
 * to date. Said vs seen is the calibration check; hand-back vs take is the
 * founder's "are we still ahead after what we give back" check.
 */
export function fridayReview(positions: PerpShadowPosition[], cfg: FridayReviewConfig = DEFAULT_FRIDAY_CONFIG): FridayRow[] {
  const groups = new Map<string, PerpShadowPosition[]>();
  for (const p of positions) {
    if (p.status !== "settled" || !p.outcome) continue;
    groups.set(p.expiryIso, [...(groups.get(p.expiryIso) ?? []), p]);
  }
  const rows: FridayRow[] = [];
  const cum = { settled: 0, takeCents: 0, capExcessCents: 0, exceededCreditCents: 0, saidSum: 0, saidN: 0, past: 0 };
  for (const expiryIso of [...groups.keys()].sort()) {
    const g = groups.get(expiryIso)!;
    const row: FridayRow = {
      expiryIso,
      settleCents: g.every((p) => p.settleCents === g[0].settleCents) ? (g[0].settleCents ?? null) : null,
      settleSource: g.every((p) => p.settleSource === g[0].settleSource) ? (g[0].settleSource ?? null) : "mixed",
      settled: g.length,
      long: 0,
      short: 0,
      notionalCents: 0,
      creditCents: 0,
      takeCents: 0,
      writerCents: 0,
      holderDeltaCents: 0,
      floorSaves: 0,
      endedPastCap: 0,
      touched: 0,
      capExcessCents: 0,
      exceededCreditCents: 0,
      saidPct: null,
      seenPct: 0,
      cumulative: { settled: 0, takeCents: 0, capExcessCents: 0, exceededCreditCents: 0, saidPct: null, seenPct: 0, handBackOfTakePct: null },
      flags: [],
    };
    let saidSum = 0;
    let saidN = 0;
    for (const p of g) {
      const o = p.outcome!;
      row[p.side] += 1;
      row.notionalCents += p.notionalCents;
      row.creditCents += p.creditCents;
      row.takeCents += p.takeCents;
      row.writerCents += o.writerCents;
      row.holderDeltaCents += o.deltaCents;
      if (o.floorSave) row.floorSaves += 1;
      if (o.touchedAtIso) row.touched += 1;
      if (o.capExcessCents > 0) {
        row.endedPastCap += 1;
        row.capExcessCents += o.capExcessCents;
        const beyond = o.capExcessCents - o.paidCents;
        if (beyond > 0) row.exceededCreditCents += beyond;
      }
      if (p.capExceedProb != null) {
        saidSum += p.capExceedProb;
        saidN += 1;
      }
    }
    row.saidPct = saidN ? Math.round((1000 * saidSum) / saidN) / 10 : null;
    row.seenPct = pct1(row.endedPastCap, row.settled);
    cum.settled += row.settled;
    cum.takeCents += row.takeCents;
    cum.capExcessCents += row.capExcessCents;
    cum.exceededCreditCents += row.exceededCreditCents;
    cum.saidSum += saidSum;
    cum.saidN += saidN;
    cum.past += row.endedPastCap;
    row.cumulative = {
      settled: cum.settled,
      takeCents: cum.takeCents,
      capExcessCents: cum.capExcessCents,
      exceededCreditCents: cum.exceededCreditCents,
      saidPct: cum.saidN ? Math.round((1000 * cum.saidSum) / cum.saidN) / 10 : null,
      seenPct: pct1(cum.past, cum.settled),
      handBackOfTakePct: cum.takeCents > 0 ? pct1(cum.capExcessCents, cum.takeCents) : null,
    };
    if (row.floorSaves > 0) row.flags.push("floor_paid");
    if (cum.settled >= cfg.minSettledForFlags) {
      const band = cfg.capExceedProb * 100;
      if (row.cumulative.seenPct > band) row.flags.push("seen_above_said");
      if (row.cumulative.handBackOfTakePct != null && row.cumulative.handBackOfTakePct > cfg.handBackShareOfTake * 100) row.flags.push("hand_back_over_share");
    }
    rows.push(row);
  }
  return rows;
}

const usd = (cents: number): string => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The Friday row as a message: what settled, what it did, where the record stands. */
export function fridayMessage(row: FridayRow): string {
  const flagWords: Record<FridayFlag, string> = {
    seen_above_said: "FLAG: positions finishing past the cap more often than the published odds",
    hand_back_over_share: "FLAG: cumulative hand-back above the set share of take",
    floor_paid: "the floor paid this week",
  };
  const lines = [
    `Friday review · expiry ${row.expiryIso.slice(0, 16).replace("T", " ")} UTC${row.settleCents != null ? ` · print $${Math.round(row.settleCents / 100).toLocaleString("en-US")}` : ""}${row.settleSource && row.settleSource !== "okx_delivery" ? ` (${row.settleSource})` : ""}`,
    `${row.settled} settled (${row.long} long, ${row.short} short) · ${usd(row.notionalCents)} notional`,
    `users: credit ${usd(row.creditCents)} · floor saves ${row.floorSaves} · past the cap ${row.endedPastCap} (${usd(row.capExcessCents)} handed back, ${usd(row.exceededCreditCents)} beyond the credit) · net vs unprotected ${row.holderDeltaCents < 0 ? "-" : ""}${usd(Math.abs(row.holderDeltaCents))}`,
    `us: take ${usd(row.takeCents)} · P&L ${usd(row.writerCents)} · gap ${usd(row.writerCents - row.takeCents)}`,
    `cap odds: said ${row.saidPct == null ? "n/a" : `${row.saidPct}%`} · seen ${row.seenPct}%`,
    `record to date: ${row.cumulative.settled} settled · take ${usd(row.cumulative.takeCents)} · handed back ${usd(row.cumulative.capExcessCents)} (${row.cumulative.handBackOfTakePct == null ? "n/a" : `${row.cumulative.handBackOfTakePct}% of take`}) · said ${row.cumulative.saidPct == null ? "n/a" : `${row.cumulative.saidPct}%`} vs seen ${row.cumulative.seenPct}%`,
    ...row.flags.map((f) => flagWords[f]),
  ];
  return lines.join("\n");
}

// ── The public cap ladder ────────────────────────────────────────────────────

export interface PublicCapRung {
  bucket: string;
  capPct: number;
  quoted: number;
  settled: number;
  livePicks: number;
  underGuard: number;
  creditCents: number;
  takeCents: number;
  capExcessCents: number;
  holderDeltaCents: number;
  endedPastCap: number;
  predictedExceedPct: number | null;
  realizedExceedPct: number | null;
}

/** The counterfactual ladder with the money the page needs and nothing else, rungs that settled only. */
export function publicCapLadder(cf: Pick<PerpCounterfactualSummary, "capLadder">): PublicCapRung[] {
  return cf.capLadder
    .filter((r) => r.settled > 0)
    .map((r) => ({
      bucket: r.bucket,
      capPct: r.capPct,
      quoted: r.quoted,
      settled: r.settled,
      livePicks: r.livePicks,
      underGuard: r.underGuard,
      creditCents: r.creditCents,
      takeCents: r.takeCents,
      capExcessCents: r.capExcessCents,
      holderDeltaCents: r.holderDeltaCents,
      endedPastCap: r.capHits,
      predictedExceedPct: r.predictedExceedPct,
      realizedExceedPct: r.realizedExceedPct,
    }))
    .sort((a, b) => a.capPct - b.capPct);
}

// ── Fees as a share of the credit the market funded ──────────────────────────

export interface FeeShare {
  grossCreditCents: number;
  venueFeeCents: number;
  /** venue fees / gross credit, % to one decimal */
  feePct: number | null;
  /** what halving the venue fee would add to the net credit, cents */
  halfFeeGainCents: number;
}

export function feeShare(s: Pick<PerpShadowSummary, "grossCreditCents" | "venueFeeCents">): FeeShare {
  return {
    grossCreditCents: s.grossCreditCents,
    venueFeeCents: s.venueFeeCents,
    feePct: s.grossCreditCents > 0 ? pct1(s.venueFeeCents, s.grossCreditCents) : null,
    halfFeeGainCents: Math.round(s.venueFeeCents / 2),
  };
}
