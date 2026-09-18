/**
 * Shadow-run operator alerts. The track record is the asset; a silently
 * stalled scanner or a venue that stops answering result queries must reach a
 * human, not just a healthz field nobody polls.
 *
 * Sinks (both optional, both fail-silent - an alert must never take the
 * worker down): a Telegram chat (bot token + chat id) and/or a generic JSON
 * webhook. Each alert kind is deduplicated for `dedupeMs` so a persistent
 * fault produces one message, not one per tick. Pure decision logic lives in
 * `evaluateShadowHealth` so the thresholds are testable without timers.
 *
 * ISOLATION: no imports outside src/eventCollar/**.
 */

export interface ShadowAlertConfig {
  telegramBotToken: string | null;
  telegramChatId: string | null;
  webhookUrl: string | null;
  dedupeMs: number;
  /** consecutive failed scan ticks before `scan_failing` fires */
  scanFailureThreshold: number;
  /** no successful scan for this many scan intervals ⇒ `scan_stalled` */
  stallIntervals: number;
}

export function parseShadowAlertsFromEnv(env: NodeJS.ProcessEnv): ShadowAlertConfig {
  const num = (v: string | undefined, d: number) =>
    v != null && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d;
  return {
    telegramBotToken: env.EVENT_SHADOW_ALERT_BOT_TOKEN || null,
    telegramChatId: env.EVENT_SHADOW_ALERT_CHAT_ID || null,
    webhookUrl: env.EVENT_SHADOW_ALERT_WEBHOOK_URL || null,
    dedupeMs: num(env.EVENT_SHADOW_ALERT_DEDUPE_MS, 6 * 3_600_000),
    scanFailureThreshold: num(env.EVENT_SHADOW_ALERT_SCAN_FAILURES, 3),
    stallIntervals: num(env.EVENT_SHADOW_ALERT_STALL_INTERVALS, 3),
  };
}

export type ShadowAlertKind =
  | "scan_failing"
  | "scan_recovered"
  | "scan_stalled"
  | "settle_failing"
  | "position_voided"
  | "ledger_write_failed";

export interface ShadowAlert {
  kind: ShadowAlertKind;
  message: string;
}

export interface ShadowHealthInput {
  nowMs: number;
  scanMs: number;
  /** ms of the last successful scan, null when none has succeeded since boot */
  lastScanOkMs: number | null;
  bootMs: number;
  consecutiveScanFailures: number;
  lastScanError: string | null;
  /** how many open positions had a result fetch fail on the last settle tick, out of how many were due */
  settleFailuresLastTick: number;
  settleDueLastTick: number;
  /** whether `scan_failing` has already been raised for the current failure streak */
  scanFailingRaised: boolean;
}

/**
 * Decide which alerts the current state warrants. Pure: the worker feeds it
 * counters and calls the alerter with the result.
 */
export function evaluateShadowHealth(s: ShadowHealthInput, cfg: ShadowAlertConfig): ShadowAlert[] {
  const out: ShadowAlert[] = [];
  if (s.consecutiveScanFailures >= cfg.scanFailureThreshold) {
    if (!s.scanFailingRaised) {
      out.push({
        kind: "scan_failing",
        message: `board scan has failed ${s.consecutiveScanFailures} times in a row: ${s.lastScanError ?? "unknown error"}`,
      });
    }
  } else if (s.scanFailingRaised && s.consecutiveScanFailures === 0) {
    out.push({ kind: "scan_recovered", message: "board scan is succeeding again" });
  }
  // Stall: the scanner has not completed in `stallIntervals` scan periods.
  // Measured from the last success, or from boot when none has succeeded yet.
  const since = s.lastScanOkMs ?? s.bootMs;
  if (s.nowMs - since > cfg.stallIntervals * s.scanMs) {
    const minutes = Math.round((s.nowMs - since) / 60_000);
    out.push({
      kind: "scan_stalled",
      message: `no successful board scan for ${minutes}m (expected every ${Math.round(s.scanMs / 60_000)}m)${s.lastScanError ? `; last error: ${s.lastScanError}` : ""}`,
    });
  }
  // Settlement: every due position failed its result fetch on the last tick.
  if (s.settleDueLastTick > 0 && s.settleFailuresLastTick === s.settleDueLastTick) {
    out.push({
      kind: "settle_failing",
      message: `result lookups failed for all ${s.settleDueLastTick} due position(s) on the last settle tick; Kalshi may be unreachable`,
    });
  }
  return out;
}

export type ShadowAlerter = (alert: ShadowAlert) => Promise<void>;

/**
 * Build the sender. Deduplicates per kind for `cfg.dedupeMs`; `scan_recovered`
 * clears the `scan_failing` dedupe so the next outage is reported again.
 */
export function buildShadowAlerter(
  cfg: ShadowAlertConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
  log: (line: string) => void = (l) => console.error(l),
): ShadowAlerter {
  const lastSentMs = new Map<ShadowAlertKind, number>();
  return async (alert) => {
    const t = now();
    const prev = lastSentMs.get(alert.kind);
    if (prev != null && t - prev < cfg.dedupeMs) return;
    lastSentMs.set(alert.kind, t);
    if (alert.kind === "scan_recovered") lastSentMs.delete("scan_failing");
    if (alert.kind === "scan_failing") lastSentMs.delete("scan_recovered");
    const text = `[event-shadow] ${alert.kind}: ${alert.message}`;
    log(text);
    const sends: Promise<unknown>[] = [];
    if (cfg.telegramBotToken && cfg.telegramChatId) {
      sends.push(
        fetchImpl(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: cfg.telegramChatId, text }),
          signal: AbortSignal.timeout(10_000),
        }),
      );
    }
    if (cfg.webhookUrl) {
      sends.push(
        fetchImpl(cfg.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ service: "event-protect-shadow", kind: alert.kind, message: alert.message, at: new Date(t).toISOString() }),
          signal: AbortSignal.timeout(10_000),
        }),
      );
    }
    // A sink that is down must never surface as a worker error.
    await Promise.allSettled(sends);
  };
}
