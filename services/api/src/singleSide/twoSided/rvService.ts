/**
 * RvService — long-running poll loop that maintains a live realized-volatility
 * estimate for BTC spot. Used by gating logic to compute the vol risk premium
 * (VRP = IV - RV) and decide whether the current moment is good for buying
 * options.
 *
 * Source: Deribit `get_tradingview_chart_data` (free, public).
 *   Pulls 5-minute close bars over a configurable lookback window.
 *   Computes annualized volatility from log-returns.
 *
 * VRP signal:
 *   - DvolService gives us implied vol (IV) as DVOL/100
 *   - RvService gives us realized vol (RV) over recent window
 *   - VRP = IV - RV
 *     VRP > 0  → implied is RICH (overpriced; bad time to BUY options)
 *     VRP < 0  → implied is CHEAP (underpriced; GOOD time to BUY options)
 *
 * In calm regimes, VRP is positive ~80% of the time. The 20% of days with
 * negative VRP are precisely when buying options is +EV even at calm DVOL.
 * That's the actionable signal we expose to Foxify's bot.
 */

const DEFAULT_POLL_PERIOD_MS = 5 * 60_000;        // 5 min refresh
const DEFAULT_STALE_MAX_AGE_MS = 15 * 60_000;     // 15 min before stale
const DEFAULT_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_LOOKBACK_HOURS = 24;                // 24h RV window
const BARS_PER_HOUR = 12;                         // 5-min bars

export type RvSample = {
  /** Annualized realized volatility (e.g. 0.32 = 32%) */
  rvAnnual: number;
  /** Number of 5-min bars used in computation */
  barCount: number;
  /** Average BTC spot across the window */
  meanSpot: number;
  /** Latest spot in window */
  latestSpot: number;
  asOfMs: number;
};

export type RvHealthSummary = {
  current: RvSample | null;
  lastSuccessMs: number | null;
  ageMs: number | null;
  isStale: boolean;
  consecutiveFailures: number;
  totalPolls: number;
};

export type RvServiceOpts = {
  pollPeriodMs?: number;
  staleMaxAgeMs?: number;
  fetchTimeoutMs?: number;
  lookbackHours?: number;
  /** Inject for tests — returns close-price bars. */
  fetchOverride?: () => Promise<Array<{ ts: number; close: number }>>;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

/**
 * Annualized realized volatility from log-return series.
 * Standard deviation × √(periods per year).
 */
export const computeAnnualizedRv = (closes: number[], periodsPerYear: number): number => {
  if (closes.length < 2) return 0;
  const logRets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) {
      logRets.push(Math.log(closes[i] / closes[i - 1]));
    }
  }
  if (logRets.length < 2) return 0;
  const mean = logRets.reduce((a, b) => a + b, 0) / logRets.length;
  const variance = logRets.reduce((s, r) => s + (r - mean) ** 2, 0) / (logRets.length - 1);
  const stddev = Math.sqrt(variance);
  return stddev * Math.sqrt(periodsPerYear);
};

const fetchDeribit5MinBars = async (lookbackHours: number, timeoutMs: number): Promise<Array<{ ts: number; close: number }>> => {
  const now = Date.now();
  const start = now - lookbackHours * 3_600_000;
  const url = `https://www.deribit.com/api/v2/public/get_tradingview_chart_data?instrument_name=BTC-PERPETUAL&start_timestamp=${start}&end_timestamp=${now}&resolution=5`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { result?: { ticks?: number[]; close?: number[] } };
    const ticks = body.result?.ticks ?? [];
    const closes = body.result?.close ?? [];
    const n = Math.min(ticks.length, closes.length);
    const out: Array<{ ts: number; close: number }> = [];
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(closes[i]) && closes[i] > 0) {
        out.push({ ts: ticks[i], close: closes[i] });
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
};

export class RvService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: RvSample | null = null;
  private lastSuccessMs: number | null = null;
  private consecutiveFailures = 0;
  private totalPolls = 0;

  constructor(private readonly opts: RvServiceOpts = {}) {}

  async start(): Promise<void> {
    if (this.timer) return;
    await this.tick();
    const period = this.opts.pollPeriodMs ?? DEFAULT_POLL_PERIOD_MS;
    this.timer = setInterval(() => {
      void this.tick().catch((e) =>
        this.log(`rv tick error: ${(e as Error).message}`, { error: String(e) })
      );
    }, period);
    if (this.timer && typeof (this.timer as { unref?: () => void }).unref === "function") (this.timer as { unref: () => void }).unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Returns cached RV, OR null if stale > staleMaxAgeMs. */
  getCurrentRv(nowMs?: number): RvSample | null {
    if (!this.current) return null;
    const stale = this.opts.staleMaxAgeMs ?? DEFAULT_STALE_MAX_AGE_MS;
    const now = nowMs ?? Date.now();
    if (this.lastSuccessMs && now - this.lastSuccessMs > stale) return null;
    return this.current;
  }

  getHealth(): RvHealthSummary {
    const now = Date.now();
    const ageMs = this.lastSuccessMs ? now - this.lastSuccessMs : null;
    const stale = this.opts.staleMaxAgeMs ?? DEFAULT_STALE_MAX_AGE_MS;
    return {
      current: this.current,
      lastSuccessMs: this.lastSuccessMs,
      ageMs,
      isStale: ageMs == null || ageMs > stale,
      consecutiveFailures: this.consecutiveFailures,
      totalPolls: this.totalPolls
    };
  }

  /** Exposed for tests. */
  async tick(nowMsOverride?: number): Promise<RvSample | null> {
    this.totalPolls++;
    const lookbackHours = this.opts.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
    const fetcher = this.opts.fetchOverride
      ? this.opts.fetchOverride
      : () => fetchDeribit5MinBars(lookbackHours, this.opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
    const bars = await fetcher();
    const now = nowMsOverride ?? Date.now();
    if (bars.length < 12) {
      // Need at least 1h of 5-min bars to compute meaningful RV
      this.consecutiveFailures++;
      this.log(`rv fetch returned insufficient bars (${bars.length}); consecutive=${this.consecutiveFailures}`);
      return this.current;
    }
    this.consecutiveFailures = 0;
    this.lastSuccessMs = now;
    const closes = bars.map((b) => b.close);
    const periodsPerYear = BARS_PER_HOUR * 24 * 365; // 5-min bars
    const rvAnnual = computeAnnualizedRv(closes, periodsPerYear);
    const sample: RvSample = {
      rvAnnual,
      barCount: bars.length,
      meanSpot: closes.reduce((a, b) => a + b, 0) / closes.length,
      latestSpot: closes[closes.length - 1],
      asOfMs: now
    };
    this.current = sample;
    return sample;
  }

  private log(msg: string, meta?: Record<string, unknown>): void {
    const fn = this.opts.log ?? ((m, _meta) => console.log(`[rvService] ${m}`, _meta ?? ""));
    fn(msg, meta);
  }
}
