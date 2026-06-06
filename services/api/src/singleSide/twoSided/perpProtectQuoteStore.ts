/**
 * Perp Protect — quote snapshot store (Phase-2 `/activate` enabler).
 *
 * A Perp Protect quote is ephemeral (30s TTL): it advertises a price built from the EXACT options
 * priced across venues at that instant. When the trader confirms, `/activate` must buy back the SAME
 * instruments (same venue / instrument id / strike / expiry) — otherwise it would re-probe and could
 * fill at a different strike or price. This store keeps the priced legs keyed by `quote_id` for the
 * life of the quote so activation is deterministic.
 *
 * The quote is short-lived and reconstructable, so an in-memory TTL store is the right abstraction
 * (the DURABLE record is the protection created at activation — a separate Phase-2 table). The
 * interface is deliberately small so a DB-backed implementation can be swapped in later (e.g. for
 * multi-instance deploys) without touching callers.
 */

export type QuoteLegSnapshot = {
  role: "long" | "short";
  venue: string | null;
  instrument: string | null;
  strike: number;
  expiry_iso: string | null;
  ask_usdc_per_btc: number | null;
  bid_usdc_per_btc: number | null;
};

export type QuoteOptionSnapshot = {
  id: string;
  structure: "put" | "call" | "put_spread" | "call_spread";
  strike: number;
  short_strike: number | null;
  premium_usdc: number;
  hedge_cost_usdc: number;
  legs: QuoteLegSnapshot[];
};

export type QuoteSnapshotPosition = {
  side: "long" | "short";
  size_btc: number;
  entry_price: number;
  leverage: number;
  tenor_days: number;
  spot: number;
  settlement_style: "european" | "american" | "auto_close";
  liquidation_prevented: boolean;
};

export type PerpProtectQuoteSnapshot = {
  quote_id: string;
  created_at_ms: number;
  expires_at_ms: number;
  position: QuoteSnapshotPosition;
  options: QuoteOptionSnapshot[];
};

export interface PerpProtectQuoteStore {
  put(snapshot: PerpProtectQuoteSnapshot): void;
  /** Returns the snapshot if present AND not expired (relative to `nowMs`); else null. */
  get(quoteId: string, nowMs?: number): PerpProtectQuoteSnapshot | null;
  /** Drop expired entries; returns the number pruned. */
  prune(nowMs?: number): number;
  size(): number;
}

/** In-memory TTL implementation. Lazily prunes on access; cap bounds memory under load. */
export class InMemoryPerpProtectQuoteStore implements PerpProtectQuoteStore {
  private readonly map = new Map<string, PerpProtectQuoteSnapshot>();
  constructor(private readonly maxEntries = 5000) {}

  put(snapshot: PerpProtectQuoteSnapshot): void {
    // Bound memory: if at cap, prune expired first, then evict oldest by expiry if still full.
    if (this.map.size >= this.maxEntries) {
      this.prune();
      if (this.map.size >= this.maxEntries) {
        const oldest = [...this.map.values()].sort((a, b) => a.expires_at_ms - b.expires_at_ms)[0];
        if (oldest) this.map.delete(oldest.quote_id);
      }
    }
    this.map.set(snapshot.quote_id, snapshot);
  }

  get(quoteId: string, nowMs: number = Date.now()): PerpProtectQuoteSnapshot | null {
    const snap = this.map.get(quoteId);
    if (!snap) return null;
    if (snap.expires_at_ms <= nowMs) {
      this.map.delete(quoteId);
      return null;
    }
    return snap;
  }

  prune(nowMs: number = Date.now()): number {
    let n = 0;
    for (const [id, snap] of this.map) {
      if (snap.expires_at_ms <= nowMs) {
        this.map.delete(id);
        n++;
      }
    }
    return n;
  }

  size(): number {
    return this.map.size;
  }
}

/** Process-wide default store (single Render instance; swap for a DB-backed store for multi-instance). */
export const defaultPerpProtectQuoteStore: PerpProtectQuoteStore = new InMemoryPerpProtectQuoteStore();
