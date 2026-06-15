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
  openCover, evaluateCover, settleCover, attachHedgeClose, scorecard,
  type ProtectionCover, type SignalState, type TradeSide, type ProtectionScorecard
} from "./protectionLifecycle";
import type { HedgeExecutor, HedgePlan } from "./hedgeExecutor";

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

/** Builds the multi-venue replicating spread plan for a LIVE cover (best executable venue per leg).
 *  `forceVenue` pins both legs to one venue (for venue-specific live execution tests). */
export type PlanLiveHedgeFn = (req: {
  side: TradeSide; spot: number; triggerPct: number; tenorDays: number; contractsBtc: number;
  forceVenue?: "deribit" | "bullish";
}) => Promise<HedgePlan>;

export type ProtectionServiceDeps = {
  store?: ProtectionStore;
  /** Live mark/index price; null if the feed is unavailable. */
  getSpot: () => number | null;
  /** Real cover pricing from venue quotes (shadow covers). */
  priceCover: PriceCoverFn;
  /** Optional live signal gate; if requireGo is set, activation needs "GO". */
  getSignal?: () => SignalState;
  /** Live execution: real spread open/unwind. When set with planLiveHedge, mode:"live" places real orders. */
  executor?: HedgeExecutor;
  planLiveHedge?: PlanLiveHedgeFn;
  defaultOpsFeeUsdc?: number;
  defaultContractsBtc?: number;
  now?: () => number;
  idGen?: () => string;
};

export type ActivateParams = {
  foxifyRef?: string | null;
  side?: TradeSide;
  triggerPct: number;
  tenorDays: number;
  payoutUsdc: number;          // shadow: the target payout. live: ignored (derived from contracts×width).
  contractsBtc?: number;       // live only: spread size (≥ venue minimum).
  forceVenue?: "deribit" | "bullish"; // live only: pin both legs to one venue (venue test).
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
  private executor?: HedgeExecutor;
  private planLiveHedge?: PlanLiveHedgeFn;
  private defaultOpsFeeUsdc: number;
  private defaultContractsBtc: number;
  private now: () => number;
  private idGen: () => string;

  constructor(deps: ProtectionServiceDeps) {
    this.store = deps.store ?? new InMemoryProtectionStore();
    this.getSpot = deps.getSpot;
    this.priceCover = deps.priceCover;
    this.getSignal = deps.getSignal ?? (() => "NA");
    this.executor = deps.executor;
    this.planLiveHedge = deps.planLiveHedge;
    this.defaultOpsFeeUsdc = deps.defaultOpsFeeUsdc ?? 1;
    this.defaultContractsBtc = deps.defaultContractsBtc ?? 0.1;
    this.now = deps.now ?? (() => Date.now());
    this.idGen = deps.idGen ?? defaultId;
  }

  async activate(p: ActivateParams): Promise<ActivateResult> {
    const side: TradeSide = p.side === "short" ? "short" : "long";
    if (!(p.triggerPct > 0 && p.triggerPct < 1)) return { ok: false, error: "invalid_trigger", message: "triggerPct in (0,1)" };
    if (!(p.tenorDays > 0)) return { ok: false, error: "invalid_tenor", message: "tenorDays > 0" };
    // payout is derived from the real fills in live mode; only required for shadow.
    if ((p.mode ?? "shadow") !== "live" && !(p.payoutUsdc > 0)) return { ok: false, error: "invalid_payout", message: "payoutUsdc > 0" };

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

    // ── LIVE: place the real spread, derive payout/premium from the actual fills ──
    if ((p.mode ?? "shadow") === "live") {
      if (!this.executor || !this.planLiveHedge) return { ok: false, error: "live_unavailable", message: "executor/planner not configured" };
      const contractsBtc = p.contractsBtc ?? this.defaultContractsBtc;
      let plan: HedgePlan;
      try {
        plan = await this.planLiveHedge({ side, spot, triggerPct: p.triggerPct, tenorDays: p.tenorDays, contractsBtc, forceVenue: p.forceVenue });
      } catch (e) {
        return { ok: false, error: "planning_failed", message: (e as Error).message };
      }
      const open = await this.executor.openHedge(plan);
      if (!open.ok) return { ok: false, error: "hedge_open_failed", message: open.error };
      const opsFee = this.defaultOpsFeeUsdc;
      const payout = open.effective_payout_usdc;
      const debit = open.debit_usdc;
      const cover = openCover({
        id: this.idGen(), foxifyRef: p.foxifyRef ?? null, side, spot,
        triggerPct: p.triggerPct, tenorMs: Math.round(p.tenorDays * 86_400_000),
        payoutUsdc: payout, premiumUsdc: +(debit + opsFee).toFixed(2), hedgeCostUsdc: debit, opsFeeUsdc: opsFee,
        impliedTouch: payout > 0 ? Math.min(1, debit / payout) : 0,
        signal, mode: "live",
        hedge: { debit_usdc: debit, effective_payout_usdc: payout, venues: open.venues, legs: open.legs },
        nowMs: this.now()
      });
      await this.store.put(cover);
      return { ok: true, cover, reused: false };
    }

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
      if (next.status === "active") continue;
      // LIVE cover settled → unwind the real spread. If the unwind FAILS, leave it active and retry
      // next tick (never mark a live cover settled while the hedge is still open).
      if (next.mode === "live" && next.hedge && this.executor) {
        try {
          const close = await this.executor.closeHedge(next.hedge.legs);
          if (!close.ok) continue; // retry next tick
          const closed = attachHedgeClose(next, { proceeds_usdc: close.proceeds_usdc, legs: close.legs });
          await this.store.put(closed);
          settled.push(closed);
        } catch { continue; } // retry next tick
      } else {
        await this.store.put(next);
        settled.push(next);
      }
    }
    return { evaluated: active.length, settled, spot };
  }

  /** Manually settle + unwind an active cover now (forced, no touch). For operator-driven live tests.
   *  `skipUnwind` settles WITHOUT calling the venue (use after manually flattening the legs on the
   *  exchange) — prevents the monitor from repeatedly re-attempting a venue unwind on a stuck cover. */
  async forceClose(id: string, opts?: { skipUnwind?: boolean }): Promise<{ ok: true; cover: ProtectionCover } | { ok: false; error: string }> {
    const c = await this.store.get(id);
    if (!c) return { ok: false, error: "not_found" };
    if (c.status !== "active") return { ok: false, error: "not_active" };
    const spot = this.getSpot() ?? c.spot_at_entry;
    let settled = settleCover(c, { touched: false, settlePrice: spot, nowMs: this.now() });
    if (!opts?.skipUnwind && c.mode === "live" && c.hedge && this.executor) {
      const close = await this.executor.closeHedge(c.hedge.legs);
      if (!close.ok) return { ok: false, error: `hedge_unwind_failed: ${close.error}` };
      settled = attachHedgeClose(settled, { proceeds_usdc: close.proceeds_usdc, legs: close.legs });
    }
    await this.store.put(settled);
    return { ok: true, cover: settled };
  }

  async get(id: string): Promise<ProtectionCover | undefined> { return this.store.get(id); }
  async list(): Promise<ProtectionCover[]> { return this.store.list(); }
  async scorecard(): Promise<ProtectionScorecard> { return scorecard(await this.store.list()); }
}
