/**
 * Live ↔ venue position reconciliation probe (Phase C).
 *
 * Read-only. Compares what OUR books say we hold (live, non-shadow legs whose buy
 * filled and whose sell has NOT) against what the venues actually report. Surfaces:
 *
 *   - PHANTOM (db_only): our DB says we hold a leg, but the venue shows no matching
 *     position. This is the dangerous case the held-venue MTM fix + this probe exist
 *     for — a position we manage that isn't really there (already closed on-venue,
 *     never filled, or mis-recorded).
 *   - ORPHAN (venue_only): the venue holds an option position we have no live record
 *     for. May be legitimate (a different desk/strategy on a shared account) — flagged,
 *     not assumed wrong.
 *   - MATCHED: DB leg ↔ venue position agree (with size delta reported).
 *
 * Venue data sources:
 *   - Deribit: getPositions("BTC") → option positions (instrument_name + size). Size is
 *     in contracts (= BTC for BTC options); a held long leg shows size > 0.
 *   - Bullish: getAssetBalances() → asset holdings. Bullish exposes holdings as asset
 *     balances rather than a positions feed, so we best-effort match each held leg's
 *     option symbol against the balance asset symbols and ALSO return the raw option-like
 *     balances for the operator to eyeball. (Clearly labelled — balances, not positions.)
 *
 * Pure w.r.t. the injected reader → unit-testable with pg-mem + mock venue data.
 */

import type { Pool, PoolClient } from "pg";
import { getLegsForPair } from "./db";

export type VenuePositionReader = {
  /** Deribit option/any positions for BTC. null/throw ⇒ reported as a venue read error. */
  getDeribitPositions?: () => Promise<Array<{ instrument_name?: string; size?: number; direction?: string }>>;
  /** Bullish asset balances (holdings). null/throw ⇒ reported as a venue read error. */
  getBullishAssetBalances?: () => Promise<Array<{ assetSymbol?: string; availableQuantity?: string; lockedQuantity?: string }>>;
};

export type ExpectedLeg = {
  pair_id: string;
  cell_id: string;
  status: string;
  leg_role: string;
  venue: string;
  symbol: string;
  contracts_btc: number;
};

export type VenueReconciliationReport = {
  as_of: string;
  expected_held_legs: number;
  expected: { deribit: ExpectedLeg[]; bullish: ExpectedLeg[] };
  deribit: {
    available: boolean;
    error?: string;
    matched: Array<{ symbol: string; pair_id: string; expected_btc: number; venue_size: number; size_delta_btc: number }>;
    phantom: Array<{ symbol: string; pair_id: string; expected_btc: number }>;
    orphan: Array<{ instrument: string; venue_size: number }>;
  };
  bullish: {
    available: boolean;
    error?: string;
    matched: Array<{ symbol: string; pair_id: string; expected_btc: number; venue_qty: number }>;
    missing: Array<{ symbol: string; pair_id: string; expected_btc: number }>;
    option_like_balances: Array<{ assetSymbol: string; availableQuantity: string; lockedQuantity?: string }>;
    note: string;
  };
  summary: {
    deribit_matched: number;
    deribit_phantom: number;
    deribit_orphan: number;
    bullish_matched: number;
    bullish_missing: number;
    clean: boolean;
  };
  note: string;
};

const SIZE_TOLERANCE_BTC = 0.05;

/** Heuristic: an option-symbol-looking asset (contains a strike+P/C suffix). */
const looksLikeOption = (s: string): boolean => /-\d+-[PC]$/i.test(s) || /\d{8}-\d+-[PC]/i.test(s);

export const reconcileVenuePositions = async (
  pool: Pool | PoolClient,
  reader: VenuePositionReader,
  opts: { nowMs?: number } = {}
): Promise<VenueReconciliationReport> => {
  const now = opts.nowMs ?? Date.now();

  // 1. Expected held legs: live (non-shadow) pairs still open, leg bought but not yet sold.
  const pairRes = await pool.query(
    `SELECT pair_id, cell_id, status
       FROM two_sided_pair
      WHERE is_shadow = FALSE AND status IN ('active','triggered','unwinding')
      ORDER BY created_at ASC`
  );
  const expectedDeribit: ExpectedLeg[] = [];
  const expectedBullish: ExpectedLeg[] = [];
  for (const row of pairRes.rows) {
    const pairId = row.pair_id as string;
    const legs = await getLegsForPair(pool, pairId);
    for (const leg of legs) {
      // Only legs we currently HOLD: buy filled, sell not yet filled.
      if (!leg.buyFilledAt || leg.sellFilledAt) continue;
      const el: ExpectedLeg = {
        pair_id: pairId,
        cell_id: row.cell_id as string,
        status: row.status as string,
        leg_role: leg.legRole,
        venue: leg.venue,
        symbol: leg.symbol,
        contracts_btc: leg.contractsBtc
      };
      if (leg.venue === "deribit") expectedDeribit.push(el);
      else if (leg.venue === "bullish") expectedBullish.push(el);
    }
  }

  // 2. Deribit reconciliation.
  const deribitOut: VenueReconciliationReport["deribit"] = { available: false, matched: [], phantom: [], orphan: [] };
  if (reader.getDeribitPositions) {
    try {
      const positions = (await reader.getDeribitPositions()) ?? [];
      deribitOut.available = true;
      // instrument → net size (held long if > 0)
      const posBySymbol = new Map<string, number>();
      for (const p of positions) {
        if (!p.instrument_name) continue;
        posBySymbol.set(p.instrument_name, Number(p.size ?? 0));
      }
      const expectedSymbols = new Set(expectedDeribit.map((e) => e.symbol));
      for (const e of expectedDeribit) {
        const size = posBySymbol.get(e.symbol);
        if (size != null && Math.abs(size) > 1e-9) {
          deribitOut.matched.push({
            symbol: e.symbol, pair_id: e.pair_id, expected_btc: e.contracts_btc,
            venue_size: size, size_delta_btc: +(size - e.contracts_btc).toFixed(6)
          });
        } else {
          deribitOut.phantom.push({ symbol: e.symbol, pair_id: e.pair_id, expected_btc: e.contracts_btc });
        }
      }
      for (const [instrument, size] of posBySymbol.entries()) {
        if (Math.abs(size) > 1e-9 && !expectedSymbols.has(instrument)) {
          deribitOut.orphan.push({ instrument, venue_size: size });
        }
      }
    } catch (e) {
      deribitOut.available = false;
      deribitOut.error = (e as Error).message;
    }
  }

  // 3. Bullish reconciliation (balances, best-effort symbol match).
  const bullishOut: VenueReconciliationReport["bullish"] = {
    available: false, matched: [], missing: [], option_like_balances: [],
    note: "Bullish exposes holdings as ASSET BALANCES, not a positions feed; matches are best-effort by option symbol. Use the raw option_like_balances + the Bullish UI to confirm."
  };
  if (reader.getBullishAssetBalances) {
    try {
      const balances = (await reader.getBullishAssetBalances()) ?? [];
      bullishOut.available = true;
      const qtyBySymbol = new Map<string, number>();
      for (const b of balances) {
        const sym = String(b.assetSymbol ?? "");
        if (!sym) continue;
        qtyBySymbol.set(sym, Number(b.availableQuantity ?? "0"));
        if (looksLikeOption(sym)) {
          bullishOut.option_like_balances.push({
            assetSymbol: sym,
            availableQuantity: String(b.availableQuantity ?? "0"),
            lockedQuantity: b.lockedQuantity != null ? String(b.lockedQuantity) : undefined
          });
        }
      }
      for (const e of expectedBullish) {
        const qty = qtyBySymbol.get(e.symbol);
        if (qty != null && Math.abs(qty) > 1e-9) {
          bullishOut.matched.push({ symbol: e.symbol, pair_id: e.pair_id, expected_btc: e.contracts_btc, venue_qty: qty });
        } else {
          bullishOut.missing.push({ symbol: e.symbol, pair_id: e.pair_id, expected_btc: e.contracts_btc });
        }
      }
    } catch (e) {
      bullishOut.available = false;
      bullishOut.error = (e as Error).message;
    }
  }

  // Clean ⇒ no phantom/missing AND no venue read errors. An omitted reader (never
  // queried) carries no error and is not treated as a discrepancy.
  const clean =
    deribitOut.phantom.length === 0 &&
    bullishOut.missing.length === 0 &&
    deribitOut.error == null &&
    bullishOut.error == null;

  return {
    as_of: new Date(now).toISOString(),
    expected_held_legs: expectedDeribit.length + expectedBullish.length,
    expected: { deribit: expectedDeribit, bullish: expectedBullish },
    deribit: deribitOut,
    bullish: bullishOut,
    summary: {
      deribit_matched: deribitOut.matched.length,
      deribit_phantom: deribitOut.phantom.length,
      deribit_orphan: deribitOut.orphan.length,
      bullish_matched: bullishOut.matched.length,
      bullish_missing: bullishOut.missing.length,
      clean
    },
    note: "PHANTOM (db_only) = we think we hold it but the venue doesn't — investigate/reconcile-settle. ORPHAN (venue_only) = venue holds an option we have no live record for (may belong to another desk on a shared account). SIZE deltas flag partial/over fills."
  };
};
