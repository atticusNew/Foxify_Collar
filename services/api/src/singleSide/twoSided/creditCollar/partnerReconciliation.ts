/**
 * Partner-position reconciliation adapter — Phase A (pure core + thin feeds, default-off). Foxify's
 * perp lives on a partner exchange, so we must learn the perp's real state INDEPENDENTLY (read-only
 * venue API / pushed feed) rather than trust a self-report. This module defines the feed interface,
 * a pure reconciliation that converts venue records → the coordinator's PartnerPositionState (FAIL-
 * CLOSED on stale/missing data), and reference feeds (static for tests/shadow, a generic REST adapter
 * for live venues). Plugs straight into barrierLifecycle.stepLifecycle and the shadow overlay.
 */

import type { PartnerPositionState } from "./barrierLifecycle";

/** What a partner exchange reports for one tracked position (the source of truth). */
export type PartnerPositionRecord = {
  ref: string;            // our position ref (must be mappable to the venue's clOrdId/label)
  isOpen: boolean;
  sizeUsd: number;
  markPriceUsd: number | null;
  tsMs: number;           // record timestamp (for staleness)
};

/** A read-only feed of partner-exchange positions. Implementations: REST poll, websocket, webhook cache. */
export interface PartnerPositionFeed {
  fetchPositions(refs: string[]): Promise<PartnerPositionRecord[]>;
}

export type ReconciliationConfig = {
  maxStalenessMs?: number;   // records older than this are treated as stale (default 15_000)
  sizeTolerancePct?: number; // partner size vs collar notional tolerance (default 0.02)
};

export type ReconciledPosition = {
  ref: string;
  partner: PartnerPositionState;            // fed to the coordinator/overlay
  dataQuality: "fresh" | "stale" | "missing";
  flags: string[];
};

export type ReconcileSummary = {
  total: number;
  fresh: number;
  stale: number;
  missing: number;
  /** Data-quality is degraded ⟹ activations should be frozen until reconciliation is healthy. */
  feedHealthy: boolean;
};

/**
 * Pure reconciliation. FAIL-CLOSED: a missing or stale record is treated as "still open" (never
 * assume a close on bad data) and flagged — so we neither pay protection nor cancel collars on an
 * unreliable feed. Fresh records pass through, with a size-mismatch flag when the venue size diverges.
 */
export const reconcilePositions = (
  book: Array<{ ref: string; notionalUsdc: number }>,
  records: PartnerPositionRecord[],
  nowMs: number,
  cfg: ReconciliationConfig = {}
): { positions: ReconciledPosition[]; byRef: Record<string, PartnerPositionState>; summary: ReconcileSummary } => {
  const maxStale = cfg.maxStalenessMs ?? 15_000;
  const tol = cfg.sizeTolerancePct ?? 0.02;
  const byRecord = new Map(records.map((r) => [r.ref, r]));

  const positions: ReconciledPosition[] = [];
  const byRef: Record<string, PartnerPositionState> = {};
  let fresh = 0, stale = 0, missing = 0;

  for (const b of book) {
    const rec = byRecord.get(b.ref);
    if (!rec) {
      // No record at all → fail-closed: assume still open, flag missing.
      const partner: PartnerPositionState = { isOpen: true, sizeUsd: b.notionalUsdc, markPriceUsd: null };
      positions.push({ ref: b.ref, partner, dataQuality: "missing", flags: ["missing_record"] });
      byRef[b.ref] = partner;
      missing += 1;
      continue;
    }
    const ageMs = nowMs - rec.tsMs;
    if (ageMs > maxStale) {
      const partner: PartnerPositionState = { isOpen: true, sizeUsd: b.notionalUsdc, markPriceUsd: rec.markPriceUsd };
      positions.push({ ref: b.ref, partner, dataQuality: "stale", flags: [`stale_feed:${ageMs}ms`] });
      byRef[b.ref] = partner;
      stale += 1;
      continue;
    }
    const flags: string[] = [];
    if (rec.isOpen && b.notionalUsdc > 0) {
      const rel = Math.abs(Math.abs(rec.sizeUsd) - b.notionalUsdc) / b.notionalUsdc;
      if (rel > tol) flags.push(`size_mismatch:${(rel * 100).toFixed(1)}%`);
    }
    const partner: PartnerPositionState = { isOpen: rec.isOpen, sizeUsd: rec.sizeUsd, markPriceUsd: rec.markPriceUsd };
    positions.push({ ref: b.ref, partner, dataQuality: "fresh", flags });
    byRef[b.ref] = partner;
    fresh += 1;
  }

  const total = book.length;
  // Healthy only if every tracked position has a fresh record (no missing/stale).
  const feedHealthy = total > 0 ? fresh === total : true;
  return { positions, byRef, summary: { total, fresh, stale, missing, feedHealthy } };
};

// ── Reference feeds ───────────────────────────────────────────────────────────

/** In-memory feed (tests, shadow, webhook cache). Set records, then fetchPositions filters by ref. */
export class StaticPartnerFeed implements PartnerPositionFeed {
  private records = new Map<string, PartnerPositionRecord>();
  set(record: PartnerPositionRecord): void {
    this.records.set(record.ref, record);
  }
  setMany(records: PartnerPositionRecord[]): void {
    for (const r of records) this.set(r);
  }
  async fetchPositions(refs: string[]): Promise<PartnerPositionRecord[]> {
    return refs.map((r) => this.records.get(r)).filter((r): r is PartnerPositionRecord => r != null);
  }
}

/**
 * Generic read-only REST feed for a live venue. Deps-injected: a fetcher (URL → JSON) and a parser
 * mapping the venue payload → PartnerPositionRecord[]. Wiring a specific exchange = supply the URL
 * builder + parser; the reconciliation core is unchanged.
 */
export class RestPartnerFeed implements PartnerPositionFeed {
  constructor(
    private readonly urlFor: (refs: string[]) => string,
    private readonly parse: (raw: unknown, nowMs: number) => PartnerPositionRecord[],
    private readonly fetcher: (url: string) => Promise<unknown> = async (url) => (await fetch(url, { signal: AbortSignal.timeout(Number(process.env.PARTNER_FEED_TIMEOUT_MS ?? "6000")) })).json(),
    private readonly nowMs: () => number = () => Date.now()
  ) {}
  async fetchPositions(refs: string[]): Promise<PartnerPositionRecord[]> {
    try {
      const raw = await this.fetcher(this.urlFor(refs));
      const all = this.parse(raw, this.nowMs());
      const want = new Set(refs);
      return all.filter((r) => want.has(r.ref));
    } catch {
      return []; // network failure ⟹ no records ⟹ reconciliation fails-closed (treats as missing)
    }
  }
}
