/**
 * Auto-activator — opens a shadow cover on a schedule so the live track record builds itself.
 *
 * Each tick it calls service.activate(...) with require_go (default true), so a cover is only opened
 * when the live signal is GO. Idempotency/foxify_ref is timestamp-based. Env-gated and fully
 * injectable (clock + service) for testing. Best-effort: failures are logged, never throw.
 */

import type { ProtectionService, ActivateParams, ActivateResult } from "./protectionService";

export type AutoActivatorOpts = {
  service: Pick<ProtectionService, "activate">;
  intervalMs?: number;        // default 1h
  params: Omit<ActivateParams, "foxifyRef">; // side, triggerPct, tenorDays, payoutUsdc, requireGo, mode
  now?: () => number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

export type AutoActivatorStatus = {
  running: boolean;
  interval_ms: number;
  ticks: number;
  opened: number;
  skipped: number;
  errors: number;
  last_tick_ms: number | null;
  last_result: string | null;
};

export class ProtectionAutoActivator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;
  private opened = 0;
  private skipped = 0;
  private errors = 0;
  private lastTickMs: number | null = null;
  private lastResult: string | null = null;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void;

  constructor(private readonly opts: AutoActivatorOpts) {
    this.intervalMs = opts.intervalMs ?? 60 * 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((m, meta) => console.log(`[protectionAutoActivator] ${m}`, meta ?? ""));
  }

  /** One activation attempt. Exposed for tests / manual trigger. */
  async tick(): Promise<ActivateResult | null> {
    this.ticks += 1;
    this.lastTickMs = this.now();
    try {
      const res = await this.opts.service.activate({
        ...this.opts.params,
        requireGo: this.opts.params.requireGo ?? true,
        foxifyRef: `auto-${this.lastTickMs}`
      });
      if (res.ok) {
        if (res.reused) { this.skipped += 1; this.lastResult = "reused"; }
        else { this.opened += 1; this.lastResult = `opened ${res.cover.id}`; this.log(`opened cover ${res.cover.id} (premium $${res.cover.premium_usdc})`); }
      } else {
        this.skipped += 1; this.lastResult = res.error;
        if (res.error !== "signal_not_go") this.log(`skip: ${res.error} — ${res.message}`);
      }
      return res;
    } catch (e) {
      this.errors += 1; this.lastResult = `error: ${(e as Error).message}`;
      this.log(`tick error: ${(e as Error).message}`);
      return null;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    if (typeof (this.timer as { unref?: () => void }).unref === "function") (this.timer as { unref: () => void }).unref();
    this.log(`started (interval=${this.intervalMs}ms, requireGo=${this.opts.params.requireGo ?? true})`);
  }

  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  status(): AutoActivatorStatus {
    return {
      running: this.timer != null,
      interval_ms: this.intervalMs,
      ticks: this.ticks,
      opened: this.opened,
      skipped: this.skipped,
      errors: this.errors,
      last_tick_ms: this.lastTickMs,
      last_result: this.lastResult
    };
  }
}
