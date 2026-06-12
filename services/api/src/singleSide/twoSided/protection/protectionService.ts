/**
 * Shadow Protection — store + service (Phase 2). Orchestrates the lifecycle against a live feed and
 * real pricing, but keeps both INJECTED so it's fully testable offline.
 *
 *   activate() → price the cover (real quote) → openCover → store
 *   tick()     → for every active cover, read the live feed, evaluate touch/expiry, settle
 *   scorecard()→ the live validation track record
 *
 * Default store is in-memory (fine for a demo; swap in a Postgres-backed store later via the
 * ProtectionStore interface). Pricing + feed come from the route (real venue probes + feedService).
 */

import {
  openCover, evaluateCover, scorecard,
  type ProtectionCover, type SignalState, type TradeSide, type ProtectionScorecard
} from "./protectionLifecycle";

export interface ProtectionStore {
  put(cover: ProtectionCover): Promise<void>;
  get(id: string): Promise<ProtectionCover | undefined>;
  findByRef(ref: string): Promise<ProtectionCover | undefined>;
  list(): Promise<ProtectionCover[]>;
  active(): Promise<ProtectionCover[]>;
}

export class InMemoryProtectionStore implements ProtectionStore {
  private byId = new Map<string, ProtectionCover>();
  async put(c: ProtectionCover): Promise<void> { this.byId.set(c.id, c); }
  async get(id: string): Promise<ProtectionCover | undefined> { return this.byId.get(id); }
  async findByRef(ref: string): Promise<ProtectionCover | undefined> { return [...this.byId.values()].find((c) => c.foxify_ref === ref); }
  async list(): Promise<ProtectionCover[]> { return [...this.byId.values()].sort((a, b) => b.created_at_ms - a.created_at_ms); }
  async active(): Promise<ProtectionCover[]> { return (await this.list()).filter((c) => c.status === "active"); }
}

/** Real pricing for one cover (the route supplies this from live venue quotes). */
export type CoverPricing = {
  premiumUsdc: number;
  hedgeCostUsdc: number;
  impliedTouch: number;
  payoutUsdc: number;
  opsFeeUsdc: number;
};

export type PriceCoverFn = (req: {
  side: TradeSide; spot: number; triggerPct: number; tenorDays: number; payoutUsdc: number;
}) => Promise<CoverPricing>;

export type ProtectionServiceDeps = {
  store?: ProtectionStore;
  /** Live mark/index price; null if the feed is unavailable. */
  getSpot: () => number | null;
  /** Real cover pricing from venue quotes. */
  priceCover: PriceCoverFn;
  /** Optional live signal gate; if requireGo is set, activation needs "GO". */
  getSignal?: () => SignalState;
  now?: () => number;
  idGen?: () => string;
};

export type ActivateParams = {
  foxifyRef?: string | null;
  side?: TradeSide;
  triggerPct: number;
  tenorDays: number;
  payoutUsdc: number;
  requireGo?: boolean;
  signalOverride?: SignalState;
  mode?: "shadow" | "live";
};

export type ActivateResult =
  | { ok: true; cover: ProtectionCover; reused: boolean }
  | { ok: false; error: string; message: string; signal?: SignalState };

const defaultId = () => `cov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export class ProtectionService {
  readonly store: ProtectionStore;
  private getSpot: () => number | null;
  private priceCover: PriceCoverFn;
  private getSignal: () => SignalState;
  private now: () => number;
  private idGen: () => string;

  constructor(deps: ProtectionServiceDeps) {
    this.store = deps.store ?? new InMemoryProtectionStore();
    this.getSpot = deps.getSpot;
    this.priceCover = deps.priceCover;
    this.getSignal = deps.getSignal ?? (() => "NA");
    this.now = deps.now ?? (() => Date.now());
    this.idGen = deps.idGen ?? defaultId;
  }

  async activate(p: ActivateParams): Promise<ActivateResult> {
    const side: TradeSide = p.side === "short" ? "short" : "long";
    if (!(p.triggerPct > 0 && p.triggerPct < 1)) return { ok: false, error: "invalid_trigger", message: "triggerPct in (0,1)" };
    if (!(p.tenorDays > 0)) return { ok: false, error: "invalid_tenor", message: "tenorDays > 0" };
    if (!(p.payoutUsdc > 0)) return { ok: false, error: "invalid_payout", message: "payoutUsdc > 0" };

    if (p.foxifyRef) {
      const existing = await this.store.findByRef(p.foxifyRef);
      if (existing) return { ok: true, cover: existing, reused: true };
    }

    const signal = p.signalOverride ?? this.getSignal();
    if (p.requireGo && signal !== "GO") {
      return { ok: false, error: "signal_not_go", message: `signal is ${signal}; activation gated to GO`, signal };
    }

    const spot = this.getSpot();
    if (spot == null || !(spot > 0)) return { ok: false, error: "feed_unavailable", message: "no live spot" };

    let pricing: CoverPricing;
    try {
      pricing = await this.priceCover({ side, spot, triggerPct: p.triggerPct, tenorDays: p.tenorDays, payoutUsdc: p.payoutUsdc });
    } catch (e) {
      return { ok: false, error: "pricing_failed", message: (e as Error).message };
    }
    if (!(pricing.premiumUsdc > 0) || !(pricing.hedgeCostUsdc >= 0)) {
      return { ok: false, error: "pricing_invalid", message: "non-positive premium or invalid hedge cost" };
    }

    const cover = openCover({
      id: this.idGen(),
      foxifyRef: p.foxifyRef ?? null,
      side,
      spot,
      triggerPct: p.triggerPct,
      tenorMs: Math.round(p.tenorDays * 86_400_000),
      payoutUsdc: pricing.payoutUsdc,
      premiumUsdc: pricing.premiumUsdc,
      hedgeCostUsdc: pricing.hedgeCostUsdc,
      opsFeeUsdc: pricing.opsFeeUsdc,
      impliedTouch: pricing.impliedTouch,
      signal,
      mode: p.mode ?? "shadow",
      nowMs: this.now()
    });
    await this.store.put(cover);
    return { ok: true, cover, reused: false };
  }

  /**
   * Monitor pass: evaluate every active cover against the current feed. `observed` lets callers pass
   * the adverse extreme since the last tick (low for longs / high for shorts) so wicks aren't missed;
   * defaults to the current spot. Returns the covers that settled on this tick.
   */
  async tick(observed?: { low?: number; high?: number }): Promise<{ evaluated: number; settled: ProtectionCover[]; spot: number | null }> {
    const spot = this.getSpot();
    const now = this.now();
    const settled: ProtectionCover[] = [];
    if (spot == null || !(spot > 0)) return { evaluated: 0, settled, spot };
    const active = await this.store.active();
    for (const cover of active) {
      const adverse = cover.side === "short" ? (observed?.high ?? spot) : (observed?.low ?? spot);
      const next = evaluateCover(cover, adverse, now);
      if (next.status !== "active") { await this.store.put(next); settled.push(next); }
    }
    return { evaluated: active.length, settled, spot };
  }

  async get(id: string): Promise<ProtectionCover | undefined> { return this.store.get(id); }
  async list(): Promise<ProtectionCover[]> { return this.store.list(); }
  async scorecard(): Promise<ProtectionScorecard> { return scorecard(await this.store.list()); }
}
