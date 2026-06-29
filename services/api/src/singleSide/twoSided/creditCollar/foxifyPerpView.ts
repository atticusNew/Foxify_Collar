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
  /** Global assumed per-position perp fee (USDC) — the credit benchmark. Default 80. Overridden per venue. */
  perpFeeUsdc?: number;
  /** How many recent matched pairs to surface. Default 5. */
  recentPairs?: number;
  /**
   * Perp venues to spread the book across (round-robin). The two legs of a matched pair are placed on
   * adjacent venues so they land on DIFFERENT exchanges. Default: three unfunded, zero-basis venues
   * (labels only — numerically identical to the oracle mirror until you supply funding/basis/fees).
   */
  venues?: PerpVenue[];
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
  // ── Recent matched pairs (one long + one short, most recent first) ──
  recentPairs: Array<{ long: FoxifyPositionRow | null; short: FoxifyPositionRow | null; pairNetUsdc: number }>;
};

const DEFAULT_VENUES: PerpVenue[] = [{ name: "dYdX" }, { name: "Bluefin" }, { name: "Hyperliquid" }];

/** Foxify's perp P&L on a settled position at the oracle price (no venue basis): signed move × notional. */
export const perpPnlUsdc = (o: SettlementOutcome): number => {
  const move = o.spotAtEntry > 0 ? (o.settlePriceUsd - o.spotAtEntry) / o.spotAtEntry : 0;
  return r2((o.side === "long" ? move : -move) * o.notionalUsdc);
};

export const buildFoxifyView = (outcomes: SettlementOutcome[], cfg: FoxifyViewConfig = {}): FoxifyView => {
  const globalFee = cfg.perpFeeUsdc != null && cfg.perpFeeUsdc >= 0 ? cfg.perpFeeUsdc : 80;
  const nPairs = cfg.recentPairs ?? 5;
  const venues = cfg.venues && cfg.venues.length > 0 ? cfg.venues : DEFAULT_VENUES;
  const nv = venues.length;

  // Per-side round-robin: long #i → venues[i], short #i → venues[i+1] ⟹ a matched pair's legs differ (nv≥2).
  let li = 0;
  let si = 0;

  const rows: FoxifyPositionRow[] = outcomes.map((o) => {
    const isLong = o.side === "long";
    const venue = isLong ? venues[li++ % nv] : venues[(si++ + 1) % nv];

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

  // Recent matched pairs: most-recent longs alongside most-recent shorts.
  const byRecent = (a: FoxifyPositionRow, b: FoxifyPositionRow) => Date.parse(b.settleIso) - Date.parse(a.settleIso);
  const rl = [...longs].sort(byRecent);
  const rs = [...shorts].sort(byRecent);
  const recentPairs: FoxifyView["recentPairs"] = [];
  for (let i = 0; i < Math.min(nPairs, Math.max(rl.length, rs.length)); i++) {
    const long = rl[i] ?? null;
    const short = rs[i] ?? null;
    recentPairs.push({ long, short, pairNetUsdc: r2((long?.foxifyNetUsdc ?? 0) + (short?.foxifyNetUsdc ?? 0)) });
  }

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
