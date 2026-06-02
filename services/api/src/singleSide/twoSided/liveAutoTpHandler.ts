/**
 * Live auto-TP watcher — server-side take-profit / trailing-stop for REAL pairs.
 *
 * Fills the one gap left open for a live ACTIVE pair: a profit spike that does
 * NOT cross a trigger boundary. (Triggered pairs are already auto-managed by the
 * ExecutionRuntime's TP engine; pairs at expiry are auto-sold by the expiry
 * handler. Only the "in profit but never triggered" case had no automation.)
 *
 * Unlike ShadowAutoTpHandler (which paper-settles and is shadow-only), this
 * closes via the SAME REAL path as POST /foxify/v2/close — handleClose →
 * spawnRuntimeForceClose → LiveCloseExecutor actually sells the legs on the
 * venue. So it never corrupts state by settling in the DB without a real sell.
 *
 * Two close triggers (either fires a close):
 *   - TAKE-PROFIT: pnl_pct >= tpThresholdPct (hard ceiling — bank it).
 *   - TRAILING-STOP: once pnl_pct has peaked at >= trailArmPct, close if it
 *     retraces trailGivebackPct (percentage-points) BELOW that peak — lets a
 *     winner run while locking gains (the "maximize profit" behavior).
 *
 * Default OFF (SS_LIVE_AUTO_TP_ENABLED). Optional pair scoping via
 * SS_LIVE_AUTO_TP_PAIR_IDS (CSV) so it can be limited to a single pair.
 * Operates STRICTLY on is_shadow=false pairs.
 */

export type LiveAutoTpConfig = {
  enabled: boolean;
  pollMs: number;
  /** Hard take-profit: close when pnl_pct >= this (e.g. 0.40 = +40%). */
  tpThresholdPct: number;
  /** Arm trailing once pnl_pct peaks at >= this (e.g. 0.25 = +25%). 0 disables trailing. */
  trailArmPct: number;
  /** Close if pnl_pct retraces this many pct-points below the armed peak (e.g. 0.12). */
  trailGivebackPct: number;
  /** Max closes per tick. */
  maxPerTick: number;
  /** Optional: restrict to these pair_ids (empty = all live active pairs). */
  pairIds: string[];
};

export const readLiveAutoTpConfig = (env: NodeJS.ProcessEnv = process.env): LiveAutoTpConfig => ({
  enabled: String(env.SS_LIVE_AUTO_TP_ENABLED ?? "false").toLowerCase().trim() === "true",
  pollMs: Math.max(5_000, Number(env.SS_LIVE_AUTO_TP_POLL_MS ?? "60000")),
  tpThresholdPct: Number(env.SS_LIVE_AUTO_TP_THRESHOLD_PCT ?? "0.40"),
  trailArmPct: Number(env.SS_LIVE_AUTO_TP_TRAIL_ARM_PCT ?? "0.25"),
  trailGivebackPct: Number(env.SS_LIVE_AUTO_TP_TRAIL_GIVEBACK_PCT ?? "0.12"),
  maxPerTick: Math.max(1, Number(env.SS_LIVE_AUTO_TP_MAX_PER_TICK ?? "10")),
  pairIds: (env.SS_LIVE_AUTO_TP_PAIR_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
});

/** Minimal shape this handler needs from MTM (subset of PairMtm). */
export type LiveMtmRow = {
  pair_id: string;
  is_shadow: boolean;
  pnl_pct: number;
  pnl_if_close_now_usdc: number;
  estimated_salvage_usdc: number;
};

export type LiveAutoTpDeps = {
  config: LiveAutoTpConfig;
  /** Returns current MTM for ACTIVE pairs (the operator-grade valuation). */
  getActivePairsMtm: () => Promise<LiveMtmRow[]>;
  /** Closes a pair via the REAL venue path (wraps handleClose/spawnRuntimeForceClose). */
  closePair: (pairId: string, reason: string) => Promise<void>;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

export type TpDecision = { pairId: string; reason: "auto_tp" | "auto_trail"; pnlPct: number; peakPct: number };

export class LiveAutoTpHandler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** In-memory peak pnl_pct per pair (resets on restart — conservative re-arm). */
  private peakPct = new Map<string, number>();
  private ticksRun = 0;
  private closedCount = 0;

  constructor(private readonly deps: LiveAutoTpDeps) {}

  start(): void {
    if (!this.deps.config.enabled) {
      this.log("DISABLED (SS_LIVE_AUTO_TP_ENABLED != true). No-op.");
      return;
    }
    if (this.timer) return;
    const c = this.deps.config;
    this.log(`started (poll=${c.pollMs}ms, tp=${(c.tpThresholdPct * 100).toFixed(0)}%, trail_arm=${(c.trailArmPct * 100).toFixed(0)}%, trail_give=${(c.trailGivebackPct * 100).toFixed(0)}pp${c.pairIds.length ? `, scoped=${c.pairIds.join(",")}` : ""})`);
    this.timer = setInterval(() => { void this.tick().catch((e) => this.log(`tick error: ${(e as Error).message}`)); }, c.pollMs);
    if (this.timer && typeof (this.timer as { unref?: () => void }).unref === "function") (this.timer as { unref: () => void }).unref();
    void this.tick().catch((e) => this.log(`initial tick error: ${(e as Error).message}`));
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  stats(): { ticksRun: number; closedCount: number; tracked: number } {
    return { ticksRun: this.ticksRun, closedCount: this.closedCount, tracked: this.peakPct.size };
  }

  /** Decide which pairs to close this tick (pure-ish; updates peak map). Exposed for tests. */
  decide(rows: LiveMtmRow[]): TpDecision[] {
    const c = this.deps.config;
    const scope = c.pairIds.length ? new Set(c.pairIds) : null;
    const out: TpDecision[] = [];
    const liveIds = new Set<string>();
    for (const r of rows) {
      if (r.is_shadow) continue;                       // LIVE only — never touch shadow
      if (scope && !scope.has(r.pair_id)) continue;    // optional pair scoping
      liveIds.add(r.pair_id);
      const prevPeak = this.peakPct.get(r.pair_id) ?? -Infinity;
      const peak = Math.max(prevPeak, r.pnl_pct);
      this.peakPct.set(r.pair_id, peak);

      // Take-profit ceiling.
      if (r.pnl_pct >= c.tpThresholdPct) {
        out.push({ pairId: r.pair_id, reason: "auto_tp", pnlPct: r.pnl_pct, peakPct: peak });
        continue;
      }
      // Trailing-stop: armed once peak >= trailArmPct, fires on giveback.
      if (c.trailArmPct > 0 && peak >= c.trailArmPct && r.pnl_pct <= peak - c.trailGivebackPct) {
        out.push({ pairId: r.pair_id, reason: "auto_trail", pnlPct: r.pnl_pct, peakPct: peak });
      }
    }
    // Forget peaks for pairs no longer active (closed/settled) so the map doesn't grow.
    for (const id of [...this.peakPct.keys()]) if (!liveIds.has(id)) this.peakPct.delete(id);
    return out.slice(0, c.maxPerTick);
  }

  async tick(): Promise<{ checked: number; closed: number }> {
    if (this.running) return { checked: 0, closed: 0 };
    this.running = true;
    let checked = 0;
    let closed = 0;
    try {
      const rows = await this.deps.getActivePairsMtm();
      checked = rows.length;
      const decisions = this.decide(rows);
      this.ticksRun++;
      for (const d of decisions) {
        try {
          await this.deps.closePair(d.pairId, d.reason);
          this.peakPct.delete(d.pairId);
          this.closedCount++;
          closed++;
          this.log(`auto-closed ${d.pairId.slice(0, 8)} reason=${d.reason} pnl=${(d.pnlPct * 100).toFixed(0)}% peak=${(d.peakPct * 100).toFixed(0)}%`);
        } catch (e) {
          this.log(`close failed for ${d.pairId.slice(0, 8)}: ${(e as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
    return { checked, closed };
  }

  private log(msg: string, meta?: Record<string, unknown>): void {
    (this.deps.log ?? ((m, _m) => console.log(`[liveAutoTp] ${m}`, _m ?? "")))(msg, meta);
  }
}
