/**
 * Foxify matched-perp view — Phase A (pure, offline). The settlement ledger models the COLLAR legs
 * (Atticus's side). This module reconstructs FOXIFY's side — the perp P&L the collar sits on — so the
 * dashboard can show the two things Foxify actually cares about:
 *
 *   1. Are they (close to) FLAT on the perps?  → matched long/short perp P&L should net to ~0.
 *   2. Do the CREDITS cover their FEES?         → accrued credit vs the assumed per-position perp fee.
 *
 * Per settled position we already have side, entry spot, settle price, times, the collar payout, and the
 * accrued credit — enough to compute the perp P&L (signed by side) and combine it into Foxify's all-in
 * outcome: perp P&L + collar payout + credit − assumed perp fee. The perps live on the partner venues
 * (dYdX/Bluefin), not in the shadow, so this is the modelled view; live, the partner-position feed
 * supplies the real fills. Pure: no I/O beyond the optional ledger loader.
 */

import type { SettlementOutcome } from "./forwardSettlement";
import { loadSettlements } from "./forwardSettlementStore";

const r2 = (x: number) => +x.toFixed(2);

export type FoxifyPositionRow = {
  ref: string;
  side: "long" | "short";
  entryPriceUsd: number;
  entryIso: string;
  settlePriceUsd: number;
  settleIso: string;
  heldHours: number;
  movePct: number;            // (settle − entry)/entry
  perpPnlUsdc: number;        // Foxify's perp P&L on this leg (signed by side)
  collarPayoutUsdc: number;   // collar option payoff to Foxify (± ; capped/floored)
  creditUsdc: number;         // credit accrued on this position
  perpFeeUsdc: number;        // assumed perp trading fee the credit is meant to cover
  foxifyNetUsdc: number;      // perp P&L + collar payout + credit − perp fee
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
  // ── Credits vs fees (the trader-value half) ──
  totalCreditUsdc: number;
  assumedPerpFeeUsdc: number;     // per-position fee assumption used
  totalAssumedFeesUsdc: number;
  creditMinusFeesUsdc: number;
  creditCoversFees: boolean;
  creditCoverageRatio: number;    // total credit / total assumed fees
  // ── Foxify all-in (perps + collars + credits − fees) ──
  totalCollarPayoutUsdc: number;
  foxifyAllInNetUsdc: number;
  foxifyAllInNetBps: number;
  // ── Recent matched pairs (one long + one short, most recent first) ──
  recentPairs: Array<{ long: FoxifyPositionRow | null; short: FoxifyPositionRow | null; pairNetUsdc: number }>;
};

/** Foxify's perp P&L on a settled position: signed move × notional (long gains on up, short on down). */
export const perpPnlUsdc = (o: SettlementOutcome): number => {
  const move = o.spotAtEntry > 0 ? (o.settlePriceUsd - o.spotAtEntry) / o.spotAtEntry : 0;
  return r2((o.side === "long" ? move : -move) * o.notionalUsdc);
};

export type FoxifyViewConfig = {
  /** Assumed per-position perp trading fee the credit is meant to cover (USDC). Default 80 (the credit target). */
  perpFeeUsdc?: number;
  /** How many recent matched pairs to surface. Default 5. */
  recentPairs?: number;
};

export const buildFoxifyView = (outcomes: SettlementOutcome[], cfg: FoxifyViewConfig = {}): FoxifyView => {
  const perpFee = cfg.perpFeeUsdc != null && cfg.perpFeeUsdc >= 0 ? cfg.perpFeeUsdc : 80;
  const nPairs = cfg.recentPairs ?? 5;

  const rows: FoxifyPositionRow[] = outcomes.map((o) => {
    const perp = perpPnlUsdc(o);
    return {
      ref: o.ref,
      side: o.side,
      entryPriceUsd: o.spotAtEntry,
      entryIso: new Date(o.openedAtMs).toISOString(),
      settlePriceUsd: o.settlePriceUsd,
      settleIso: new Date(o.settledAtMs).toISOString(),
      heldHours: +(o.heldMs / 3_600_000).toFixed(2),
      movePct: o.movePct,
      perpPnlUsdc: perp,
      collarPayoutUsdc: o.payoutToFoxifyUsdc,
      creditUsdc: o.foxifyCreditUsdc,
      perpFeeUsdc: perpFee,
      foxifyNetUsdc: r2(perp + o.payoutToFoxifyUsdc + o.foxifyCreditUsdc - perpFee)
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
  const credit = sum((r) => r.creditUsdc);
  const fees = n * perpFee;
  const collar = sum((r) => r.collarPayoutUsdc);
  const allIn = sum((r) => r.foxifyNetUsdc);

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
    totalCreditUsdc: r2(credit),
    assumedPerpFeeUsdc: perpFee,
    totalAssumedFeesUsdc: r2(fees),
    creditMinusFeesUsdc: r2(credit - fees),
    creditCoversFees: credit >= fees,
    creditCoverageRatio: fees > 0 ? +(credit / fees).toFixed(2) : 0,
    totalCollarPayoutUsdc: r2(collar),
    foxifyAllInNetUsdc: r2(allIn),
    foxifyAllInNetBps: notional > 0 ? +((allIn / notional) * 1e4).toFixed(4) : 0,
    recentPairs
  };
};

/** Build the Foxify view directly from the settlement ledger. */
export const loadFoxifyView = (ledgerPath?: string, cfg: FoxifyViewConfig = {}): FoxifyView =>
  buildFoxifyView(loadSettlements(ledgerPath), cfg);
