/**
 * Live adaptive signal (deployable GO/WAIT) for shadow protection.
 *
 * Same logic as the backtest's adaptive_go: over a trailing window of RESOLVED entries, compare the
 * realized stop-touch rate to the DVOL-implied rate. GO when realized has been beating implied by the
 * margin (a buyer-favorable / negative-VRP regime); WAIT otherwise. Leakage-free — uses only past,
 * fully-resolved data. `computeLiveSignal` is pure; `LiveSignalService` warms it from recent market
 * data on boot and refreshes on an interval so `getSignal()` is an O(1) cached read.
 */

import { runFeeRecoveryBacktest, DEFAULT_TERM_STRUCTURE, type Candle, type DvolPoint, type TradeSide, type TermStructure } from "../feeRecoveryBacktest";
import { fetchBtcOhlc, fetchDvol } from "./marketData";

const HOUR = 3_600_000;

export type LiveSignalParams = {
  side: TradeSide;
  triggerPct: number;
  tenorHours: number;
  vrpLookbackHours?: number;   // trailing window of resolved entries (default 336 = 14d)
  vrpMargin?: number;          // realized must beat implied by this (default 0)
  minSamples?: number;         // min resolved entries for a verdict (default 50)
  termStructure?: TermStructure;
};

export type LiveSignalResult = {
  state: "GO" | "WAIT" | "NA";
  trailing_realized: number | null;
  trailing_implied: number | null;
  edge_pts: number | null;
  samples: number;
  as_of_ms: number;
  reason: string;
};

/** Pure: decide GO/WAIT from a trailing window of candles+dvol. */
export const computeLiveSignal = (candles: Candle[], dvol: DvolPoint[], params: LiveSignalParams): LiveSignalResult => {
  const lookbackH = params.vrpLookbackHours ?? 336;
  const tenorH = params.tenorHours;
  const margin = params.vrpMargin ?? 0;
  const minSamples = params.minSamples ?? 50;
  const nowMs = candles.length ? candles[candles.length - 1].tsMs : Date.now();
  const cutoff = nowMs - (lookbackH + tenorH) * HOUR;
  const slice = candles.filter((c) => c.tsMs >= cutoff);
  if (slice.length < minSamples + tenorH) {
    return { state: "NA", trailing_realized: null, trailing_implied: null, edge_pts: null, samples: slice.length, as_of_ms: nowMs, reason: "insufficient trailing data (warming up)" };
  }
  const rep = runFeeRecoveryBacktest(slice, dvol, {
    triggers: [params.triggerPct], tenorHours: tenorH, sides: [params.side],
    payoutUsdc: 60, opsFeeUsdc: 0, minBucketN: 1,
    termStructure: params.termStructure ?? DEFAULT_TERM_STRUCTURE
  });
  const all = rep.rows.find((r) => r.signal === "all" && r.side === params.side);
  if (!all || all.n < minSamples) {
    return { state: "NA", trailing_realized: null, trailing_implied: null, edge_pts: null, samples: all?.n ?? 0, as_of_ms: nowMs, reason: `insufficient resolved entries (${all?.n ?? 0} < ${minSamples})` };
  }
  const realized = all.realized_touch_rate;
  const implied = all.implied_touch_rate;
  const state: "GO" | "WAIT" = realized > implied + margin ? "GO" : "WAIT";
  return {
    state,
    trailing_realized: realized,
    trailing_implied: implied,
    edge_pts: +((realized - implied) * 100).toFixed(2),
    samples: all.n,
    as_of_ms: nowMs,
    reason: state === "GO"
      ? `realized ${(realized * 100).toFixed(1)}% > implied ${(implied * 100).toFixed(1)}% + margin → buyer-favorable`
      : `realized ${(realized * 100).toFixed(1)}% ≤ implied ${(implied * 100).toFixed(1)}% + margin → not favorable`
  };
};

export type LiveSignalServiceOpts = LiveSignalParams & {
  refreshMs?: number;          // how often to refresh the signal (default 30min)
  warmDays?: number;           // how much history to pull on boot/refresh (default 45d)
  fetchOhlc?: (fromMs: number, toMs: number) => Promise<Candle[]>;
  fetchDvolFn?: (fromMs: number, toMs: number) => Promise<DvolPoint[]>;
  /** Fired when the signal STATE changes between refreshes (e.g. WAIT→GO). For alerting. */
  onChange?: (prev: LiveSignalResult, curr: LiveSignalResult) => void;
  log?: (msg: string) => void;
};

export class LiveSignalService {
  private current: LiveSignalResult = { state: "NA", trailing_realized: null, trailing_implied: null, edge_pts: null, samples: 0, as_of_ms: 0, reason: "not started" };
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly opts: LiveSignalServiceOpts;
  private readonly fetchOhlc: (f: number, t: number) => Promise<Candle[]>;
  private readonly fetchDvolFn: (f: number, t: number) => Promise<DvolPoint[]>;
  private readonly log: (m: string) => void;

  constructor(opts: LiveSignalServiceOpts) {
    this.opts = opts;
    this.fetchOhlc = opts.fetchOhlc ?? fetchBtcOhlc;
    this.fetchDvolFn = opts.fetchDvolFn ?? fetchDvol;
    this.log = opts.log ?? ((m) => console.log(`[protectionSignal] ${m}`));
  }

  getSignal(): "GO" | "WAIT" | "NA" { return this.current.state; }
  getDetail(): LiveSignalResult { return this.current; }

  async refresh(): Promise<LiveSignalResult> {
    const warmDays = this.opts.warmDays ?? 45;
    const toMs = Date.now();
    const fromMs = toMs - warmDays * 24 * HOUR;
    try {
      const [candles, dvol] = await Promise.all([this.fetchOhlc(fromMs, toMs), this.fetchDvolFn(fromMs, toMs)]);
      const prev = this.current;
      this.current = computeLiveSignal(candles, dvol, this.opts);
      this.log(`signal=${this.current.state} edge=${this.current.edge_pts}pts n=${this.current.samples}`);
      if (prev.state !== this.current.state && this.opts.onChange) {
        try { this.opts.onChange(prev, this.current); } catch (e) { this.log(`onChange handler error: ${(e as Error).message}`); }
      }
    } catch (e) {
      this.log(`refresh failed (keeping prior signal=${this.current.state}): ${(e as Error).message}`);
    }
    return this.current;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.refresh();
    const period = this.opts.refreshMs ?? 30 * 60_000;
    this.timer = setInterval(() => { void this.refresh(); }, period);
    if (typeof (this.timer as { unref?: () => void }).unref === "function") (this.timer as { unref: () => void }).unref();
  }

  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
