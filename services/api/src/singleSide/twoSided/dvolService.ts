/**
 * DvolService — long-running poll loop that maintains a live cached DVOL value.
 *
 * Polls Deribit DVOL every `pollPeriodMs` (default 60s). Caches the latest
 * reading. Consumers (guardrails.canActivate, dashboardService) read the
 * cached value synchronously via `getCurrentDvol()`.
 *
 * On poll failure:
 *   - Keeps the previous value (allow short-lived API hiccups)
 *   - After `staleMaxAgeMs` (default 5 min) of no successful poll, returns null
 *     → guardrail treats as halt-eligible per existing canActivate logic
 *
 * Source: Deribit public /api/v2/public/get_volatility_index_data
 *   Returns: result.data = [[ts, open, high, low, close], ...]
 *   We take close of the most recent bar at 60s resolution.
 */

import { classifyRegime, type Regime } from "./featureFlag";

const DEFAULT_POLL_PERIOD_MS = 60_000;
const DEFAULT_STALE_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

export type DvolSample = {
  dvol: number;          // raw DVOL value (e.g. 36.32)
  sigmaAnnual: number;   // dvol / 100
  regime: Regime;
  asOfMs: number;
};

export type DvolHealthSummary = {
  current: DvolSample | null;
  lastSuccessMs: number | null;
  ageMs: number | null;
  isStale: boolean;
  consecutiveFailures: number;
  totalPolls: number;
};

export type DvolServiceOpts = {
  pollPeriodMs?: number;
  staleMaxAgeMs?: number;
  fetchTimeoutMs?: number;
  /** Inject for tests. */
  fetchOverride?: () => Promise<number | null>;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

const fetchDvolFromDeribit = async (timeoutMs: number): Promise<number | null> => {
  const now = Date.now();
  const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${now - 3_600_000}&end_timestamp=${now}&resolution=60`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { data?: number[][] } };
    const rows = body.result?.data ?? [];
    if (rows.length === 0) return null;
    const last = rows[rows.length - 1];
    const close = last[4];
    return Number.isFinite(close) && close > 0 ? close : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

export class DvolService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: DvolSample | null = null;
  private lastSuccessMs: number | null = null;
  private consecutiveFailures = 0;
  private totalPolls = 0;

  constructor(private readonly opts: DvolServiceOpts = {}) {}

  async start(): Promise<void> {
    if (this.timer) return;
    await this.tick();
    const period = this.opts.pollPeriodMs ?? DEFAULT_POLL_PERIOD_MS;
    this.timer = setInterval(() => {
      void this.tick().catch((e) =>
        this.log(`dvol tick error: ${(e as Error).message}`, { error: String(e) })
      );
    }, period);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Returns cached DVOL, OR null if stale > staleMaxAgeMs. */
  getCurrentDvol(nowMs?: number): DvolSample | null {
    if (!this.current) return null;
    const stale = this.opts.staleMaxAgeMs ?? DEFAULT_STALE_MAX_AGE_MS;
    const now = nowMs ?? Date.now();
    if (this.lastSuccessMs && now - this.lastSuccessMs > stale) return null;
    return this.current;
  }

  getHealth(): DvolHealthSummary {
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
  async tick(nowMsOverride?: number): Promise<DvolSample | null> {
    this.totalPolls++;
    const fetcher = this.opts.fetchOverride
      ? this.opts.fetchOverride
      : () => fetchDvolFromDeribit(this.opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
    const dvol = await fetcher();
    const now = nowMsOverride ?? Date.now();
    if (dvol == null) {
      this.consecutiveFailures++;
      this.log(`dvol fetch failed; consecutive=${this.consecutiveFailures}`);
      return this.current;
    }
    this.consecutiveFailures = 0;
    this.lastSuccessMs = now;
    const sample: DvolSample = {
      dvol,
      sigmaAnnual: dvol / 100,
      regime: classifyRegime(dvol),
      asOfMs: now
    };
    this.current = sample;
    return sample;
  }

  private log(msg: string, meta?: Record<string, unknown>): void {
    const fn = this.opts.log ?? ((m, _meta) => console.log(`[dvolService] ${m}`, _meta ?? ""));
    fn(msg, meta);
  }
}
