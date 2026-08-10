/**
 * Foxify matched-perp view — Phase A (pure, offline). The settlement ledger models the COLLAR legs
 * (Atticus's side). This module reconstructs FOXIFY's side — the perp book the collar sits on — so the
 * dashboard can show the two things Foxify actually cares about:
 *
 *   1. Are they (close to) FLAT on the perps?  → matched long/short perp P&L nets to ~0.
 *   2. Do the CREDITS cover their FEES?         → accrued credit vs the assumed per-position perp fee.
 *
 * REALISM MODEL. The naive view treats a long and a short as the SAME oracle price flipped in sign — a
 * mechanical mirror that nets to *exactly* zero and erases everything that moves a real delta-neutral
 * perp book. The real world is: a long on venue A and a short on venue B, opened at slightly different
 * marks, carried across funding settlements, each paying its own fees. This module models that with
 * per-venue inputs (assumption-free by default; feed real numbers — ideally from the live partner feed —
 * to make it faithful):
 *
 *   • venue per leg     — round-robin across the configured perp venues; a matched pair's two legs land
 *                         on DIFFERENT venues (dYdX / Bluefin / Hyperliquid …), as Foxify actually trades.
 *   • funding carry     — perps settle funding ~every 8h; over a 24h hold that's ~3 periods. A positive
 *                         funding rate ⟹ longs PAY shorts. With per-venue rates the matched book keeps a
 *                         real funding SPREAD (the usual P&L of a delta-neutral perp book). Default 0.
 *   • mark basis        — each perp marks to its venue index, not Atticus's oracle; an entry/exit basis
 *                         (bps) gives each leg its own price and breaks the exact-zero mirror. Default 0.
 *   • per-venue fees    — open+close trading fee per venue, overriding the global assumption. Default
 *                         falls back to the global perp-fee assumption (the credit benchmark).
 *
 * With all per-venue inputs left at their defaults the numbers reduce to the prior oracle-mirror (so the
 * existing track record is unchanged); supply real venue inputs to make the perp side faithful. The perps
 * live on the partner venues, not in the shadow — this is the modelled view; live, the partner-position
 * feed supplies the real fills, funding, and fees. Pure: no I/O beyond the optional ledger loader.
 */

import type { SettlementOutcome } from "./forwardSettlement";
import { loadSettlements } from "./forwardSettlementStore";

const r2 = (x: number) => +x.toFixed(2);
const FUNDING_PERIOD_HOURS = 8; // standard perp funding interval

export type PerpVenue = {
  name: string;
  /** Assumed funding rate in bps per 8h interval. +rate ⟹ longs PAY shorts (cost to long, income to short). */
  fundingBpsPer8h?: number;
  /** Per-position perp trading fee (open+close, USDC) on this venue; overrides the global assumption. */
  feeUsdc?: number;
  /** Perp mark − oracle at entry, in bps (default 0 ⟹ leg opens at the oracle price). */
  entryBasisBps?: number;
  /** Perp mark − oracle at exit, in bps (default 0 ⟹ leg closes at the oracle price). */
  exitBasisBps?: number;
};

export type FoxifyViewConfig = {
  /**
   * Global per-position perp fee (USDC) — the credit benchmark. Default 0: NO fee is assumed until
   * Foxify's real number is known (a hypothetical here poisons every downstream net). Model one ad hoc
   * via the dashboard's ?fee=X override or FOXIFY_PERP_FEE_USDC.
   */
  perpFeeUsdc?: number;
  /** How many recent matched pairs to surface. Default 5. */
  recentPairs?: number;
  /**
   * Perp venues to spread the book across (round-robin). The two legs of a matched pair are placed on
   * adjacent venues so they land on DIFFERENT exchanges. Default: three unfunded, zero-basis venues
   * (labels only — numerically identical to the oracle mirror until you supply funding/basis/fees).
   */
  venues?: PerpVenue[];
  /**
   * Max entry-time gap (ms) for a long+short to count as a MATCHED pair. Pair-atomic opens share a
   * cycle (entries ms apart); anything wider is a directional single and must not be displayed as a
   * pair. Default 5 minutes.
   */
  pairWindowMs?: number;
};

export type FoxifyPositionRow = {
  ref: string;
  side: "long" | "short";
  venue: string;
  entryPriceUsd: number;      // venue mark at entry (oracle ± entry basis)
  entryIso: string;
  settlePriceUsd: number;     // venue mark at exit (oracle ± exit basis)
  settleIso: string;
  heldHours: number;
  movePct: number;            // (exit − entry)/entry on this venue
  perpPnlUsdc: number;        // Foxify's perp P&L on this leg (signed by side)
  fundingUsdc: number;        // funding carry over the hold (+ received / − paid)
  collarPayoutUsdc: number;   // collar option payoff to Foxify (± ; capped/floored)
  creditUsdc: number;         // credit accrued on this position
  perpFeeUsdc: number;        // assumed perp trading fee (open+close) the credit is meant to cover
  foxifyNetUsdc: number;      // perp P&L + funding + collar payout + credit − perp fee
};

export type FoxifyVenueBreakdown = {
  venue: string;
  positions: number;
  perpPnlUsdc: number;
  fundingUsdc: number;
  feesUsdc: number;
  netUsdc: number;
};

export type FoxifyView = {
  settledPositions: number;
  // ── Delta-neutrality on the perps (the matched long/short should net ~0) ──
  netPerpPnlUsdc: number;     // Σ signed perp P&L — the directional residual
  netPerpPnlBps: number;      // / notional
  longPerpPnlUsdc: number;
  shortPerpPnlUsdc: number;
  grossPerpPnlUsdc: number;   // Σ |perp P&L| — how much gross movement was offset
  longCount: number;
  shortCount: number;
  // ── Funding carry (the real economic of holding the perp book) ──
  netFundingUsdc: number;     // Σ funding — the carry the delta-neutral book keeps (≠0 only with venue rates)
  // ── Credits vs fees (the trader-value half) ──
  totalCreditUsdc: number;
  assumedPerpFeeUsdc: number;     // global per-position fee assumption
  totalAssumedFeesUsdc: number;   // sum of per-venue fees actually applied
  creditMinusFeesUsdc: number;
  creditCoversFees: boolean;
  creditCoverageRatio: number;    // total credit / total assumed fees
  // ── Foxify all-in (perps + funding + collars + credits − fees) ──
  totalCollarPayoutUsdc: number;
  foxifyAllInNetUsdc: number;
  foxifyAllInNetBps: number;
  // ── Where the book sat (per-venue) ──
  venues: FoxifyVenueBreakdown[];
  // ── Recent groups (most recent first): a MATCHED pair (long+short opened together) or a directional single ──
  recentPairs: Array<{ long: FoxifyPositionRow | null; short: FoxifyPositionRow | null; matched: boolean; pairNetUsdc: number }>;
};

const DEFAULT_VENUES: PerpVenue[] = [{ name: "dYdX" }, { name: "Bluefin" }, { name: "Hyperliquid" }];

/** Foxify's perp P&L on a settled position at the oracle price (no venue basis): signed move × notional. */
export const perpPnlUsdc = (o: SettlementOutcome): number => {
  const move = o.spotAtEntry > 0 ? (o.settlePriceUsd - o.spotAtEntry) / o.spotAtEntry : 0;
  return r2((o.side === "long" ? move : -move) * o.notionalUsdc);
};

export const buildFoxifyView = (outcomes: SettlementOutcome[], cfg: FoxifyViewConfig = {}): FoxifyView => {
  const globalFee = cfg.perpFeeUsdc != null && cfg.perpFeeUsdc >= 0 ? cfg.perpFeeUsdc : 0;
  const nPairs = cfg.recentPairs ?? 5;
  const venues = cfg.venues && cfg.venues.length > 0 ? cfg.venues : DEFAULT_VENUES;
  const nv = venues.length;

  // Venue per leg is a deterministic function of the OPEN timestamp: a pair's two legs share
  // `openedAtMs`, so long → venues[rank], short → venues[rank+1] guarantees the legs land on
  // DIFFERENT venues (nv≥2) — the product's cross-venue rule (never self-match on one book).
  // (The previous per-side counters desynchronized whenever the long/short counts diverged —
  // e.g. the retired directional singles — and same-venue "pairs" leaked into the display.)
  const openTimes = [...new Set(outcomes.map((o) => o.openedAtMs))].sort((a, b) => a - b);
  const rankByOpen = new Map(openTimes.map((t, i) => [t, i]));

  const rows: FoxifyPositionRow[] = outcomes.map((o) => {
    const isLong = o.side === "long";
    const rank = rankByOpen.get(o.openedAtMs) ?? 0;
    const venue = isLong ? venues[rank % nv] : venues[(rank + 1) % nv];

    const entryPrice = o.spotAtEntry * (1 + (venue.entryBasisBps ?? 0) / 1e4);
    const exitPrice = o.settlePriceUsd * (1 + (venue.exitBasisBps ?? 0) / 1e4);
    const move = entryPrice > 0 ? (exitPrice - entryPrice) / entryPrice : 0;
    const perp = r2((isLong ? move : -move) * o.notionalUsdc);

    const heldHours = +(o.heldMs / 3_600_000).toFixed(2);
    const periods = heldHours / FUNDING_PERIOD_HOURS;
    const fundMag = (o.notionalUsdc * ((venue.fundingBpsPer8h ?? 0) / 1e4)) * periods;
    const funding = r2(isLong ? -fundMag : fundMag); // +rate ⟹ long pays, short receives

    const fee = venue.feeUsdc != null && venue.feeUsdc >= 0 ? venue.feeUsdc : globalFee;

    return {
      ref: o.ref,
      side: o.side,
      venue: venue.name,
      entryPriceUsd: r2(entryPrice),
      entryIso: new Date(o.openedAtMs).toISOString(),
      settlePriceUsd: r2(exitPrice),
      settleIso: new Date(o.settledAtMs).toISOString(),
      heldHours,
      movePct: +move.toFixed(6),
      perpPnlUsdc: perp,
      fundingUsdc: funding,
      collarPayoutUsdc: o.payoutToFoxifyUsdc,
      creditUsdc: o.foxifyCreditUsdc,
      perpFeeUsdc: fee,
      foxifyNetUsdc: r2(perp + funding + o.payoutToFoxifyUsdc + o.foxifyCreditUsdc - fee)
    };
  });

  const n = rows.length;
  const notional = outcomes.reduce((s, o) => s + o.notionalUsdc, 0);
  const sum = (f: (r: FoxifyPositionRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const longs = rows.filter((r) => r.side === "long");
  const shorts = rows.filter((r) => r.side === "short");

  const netPerp = sum((r) => r.perpPnlUsdc);
  const longPerp = longs.reduce((s, r) => s + r.perpPnlUsdc, 0);
  const shortPerp = shorts.reduce((s, r) => s + r.perpPnlUsdc, 0);
  const gross = sum((r) => Math.abs(r.perpPnlUsdc));
  const netFunding = sum((r) => r.fundingUsdc);
  const credit = sum((r) => r.creditUsdc);
  const fees = sum((r) => r.perpFeeUsdc);
  const collar = sum((r) => r.collarPayoutUsdc);
  const allIn = sum((r) => r.foxifyNetUsdc);

  // Per-venue breakdown.
  const venueMap = new Map<string, FoxifyVenueBreakdown>();
  for (const r of rows) {
    const b = venueMap.get(r.venue) ?? { venue: r.venue, positions: 0, perpPnlUsdc: 0, fundingUsdc: 0, feesUsdc: 0, netUsdc: 0 };
    b.positions += 1;
    b.perpPnlUsdc += r.perpPnlUsdc;
    b.fundingUsdc += r.fundingUsdc;
    b.feesUsdc += r.perpFeeUsdc;
    b.netUsdc += r.foxifyNetUsdc;
    venueMap.set(r.venue, b);
  }
  const venueBreakdown = [...venueMap.values()].map((b) => ({
    venue: b.venue,
    positions: b.positions,
    perpPnlUsdc: r2(b.perpPnlUsdc),
    fundingUsdc: r2(b.fundingUsdc),
    feesUsdc: r2(b.feesUsdc),
    netUsdc: r2(b.netUsdc)
  }));

  // Recent groups: a long and a short only count as a MATCHED pair when they were OPENED together
  // (pair-atomic ⟹ entry times within the pair window). Anything else — directional singles from
  // elevated-day trend calls — surfaces as a single. Grouping unrelated legs by recency painted
  // mismatched entries as "pair" losses (a −$727 pseudo-pair that was really two separate bets).
  const pairWindowMs = cfg.pairWindowMs ?? 5 * 60_000;
  const openMsByRef = new Map<string, number>(outcomes.map((o) => [o.ref, o.openedAtMs]));
  const openMs = (r: FoxifyPositionRow) => openMsByRef.get(r.ref) ?? Date.parse(r.entryIso);
  const unmatchedShorts = [...shorts];
  const groups: FoxifyView["recentPairs"] = [];
  for (const long of longs) {
    const idx = unmatchedShorts.findIndex((s) => Math.abs(openMs(s) - openMs(long)) <= pairWindowMs);
    if (idx >= 0) {
      const short = unmatchedShorts.splice(idx, 1)[0];
      groups.push({ long, short, matched: true, pairNetUsdc: r2(long.foxifyNetUsdc + short.foxifyNetUsdc) });
    } else {
      groups.push({ long, short: null, matched: false, pairNetUsdc: r2(long.foxifyNetUsdc) });
    }
  }
  for (const short of unmatchedShorts) groups.push({ long: null, short, matched: false, pairNetUsdc: r2(short.foxifyNetUsdc) });
  const recency = (g: FoxifyView["recentPairs"][number]) =>
    Math.max(g.long ? Date.parse(g.long.settleIso) : 0, g.short ? Date.parse(g.short.settleIso) : 0);
  groups.sort((a, b) => recency(b) - recency(a));
  const recentPairs = groups.slice(0, nPairs);

  return {
    settledPositions: n,
    netPerpPnlUsdc: r2(netPerp),
    netPerpPnlBps: notional > 0 ? +((netPerp / notional) * 1e4).toFixed(4) : 0,
    longPerpPnlUsdc: r2(longPerp),
    shortPerpPnlUsdc: r2(shortPerp),
    grossPerpPnlUsdc: r2(gross),
    longCount: longs.length,
    shortCount: shorts.length,
    netFundingUsdc: r2(netFunding),
    totalCreditUsdc: r2(credit),
    assumedPerpFeeUsdc: globalFee,
    totalAssumedFeesUsdc: r2(fees),
    creditMinusFeesUsdc: r2(credit - fees),
    creditCoversFees: credit >= fees,
    creditCoverageRatio: fees > 0 ? +(credit / fees).toFixed(2) : 0,
    totalCollarPayoutUsdc: r2(collar),
    foxifyAllInNetUsdc: r2(allIn),
    foxifyAllInNetBps: notional > 0 ? +((allIn / notional) * 1e4).toFixed(4) : 0,
    venues: venueBreakdown,
    recentPairs
  };
};

/** Build the Foxify view directly from the settlement ledger. */
export const loadFoxifyView = (ledgerPath?: string, cfg: FoxifyViewConfig = {}): FoxifyView =>
  buildFoxifyView(loadSettlements(ledgerPath), cfg);
