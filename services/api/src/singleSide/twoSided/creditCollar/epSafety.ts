/**
 * EARN & PROTECT SAFETY RAILS — auth, rate limiting, alerting, loop watchdogs. Pure/testable cores;
 * the service wires them to HTTP and timers.
 *
 * Alert fan-out: structured JSONL on disk (always), console (always), optional webhook
 * (ALERT_WEBHOOK_URL), optional Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID). Alert
 * conditions wired in the service: renewal/monitor loop stalled, payout failures, OKX connectivity
 * loss, any unwind event, margin-utilization threshold.
 */

import { appendFileSync } from "node:fs";
import { resolveWritablePath } from "./shadowStore";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

// ── Admin auth ────────────────────────────────────────────────────────────────

/**
 * Admin gate for ops surfaces (control room, reset, pause, whole-book state). Token from env;
 * accepted as `Authorization: Bearer <t>`, `x-admin-token` header, or `?token=` (control-room
 * links). NO token configured ⟹ admin surfaces are DISABLED (fail-closed), except in explicit
 * dev mode (EP_DEV_NO_ADMIN=true).
 */
export type AdminAuth = { enabled: boolean; token: string | null };

export const parseAdminAuthFromEnv = (env: Record<string, string | undefined>): AdminAuth => {
  const token = env.EP_ADMIN_TOKEN?.trim() || null;
  if (token) return { enabled: true, token };
  return { enabled: String(env.EP_DEV_NO_ADMIN ?? "false").toLowerCase() === "true", token: null };
};

export const adminAuthorized = (auth: AdminAuth, headers: Record<string, string | string[] | undefined>, queryToken: string | null): boolean => {
  if (!auth.enabled) return false;
  if (auth.token == null) return true; // explicit dev mode
  const bearer = String(headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  const headerToken = String(headers["x-admin-token"] ?? "").trim();
  return bearer === auth.token || headerToken === auth.token || (queryToken ?? "") === auth.token;
};

// ── Rate limiting (token bucket per key) ──────────────────────────────────────

export type RateLimiter = {
  /** true = allowed; false = over the limit. */
  allow: (key: string, nowMs: number) => boolean;
};

/** Classic token bucket: `limit` requests per `windowMs`, refilled continuously. In-memory — one process owns the API. */
export const tokenBucketLimiter = (limit: number, windowMs: number): RateLimiter => {
  const buckets = new Map<string, { tokens: number; lastMs: number }>();
  return {
    allow: (key, nowMs) => {
      const b = buckets.get(key) ?? { tokens: limit, lastMs: nowMs };
      b.tokens = Math.min(limit, b.tokens + ((nowMs - b.lastMs) / windowMs) * limit);
      b.lastMs = nowMs;
      if (b.tokens < 1) {
        buckets.set(key, b);
        return false;
      }
      b.tokens -= 1;
      buckets.set(key, b);
      return true;
    }
  };
};

// ── Alerts ────────────────────────────────────────────────────────────────────

export type EpAlertKind =
  | "loop_stalled"
  | "payout_failed"
  | "okx_connectivity"
  | "unwind_event"
  | "margin_utilization"
  | "reconcile_mismatch"
  | "paused";

export type EpAlert = { kind: EpAlertKind; message: string; data?: Record<string, unknown>; tsMs: number };

export type AlertSinkConfig = {
  path: string; // JSONL file (always written)
  webhookUrl: string | null; // optional POST target
  telegram: { botToken: string; chatId: string } | null;
  /** Same alert kind+message repeats are suppressed inside this window. */
  dedupeMs: number;
};

export const parseAlertSinkFromEnv = (env: Record<string, string | undefined>): AlertSinkConfig => ({
  path: env.EP_ALERTS_PATH ?? "./logs/ep-alerts.jsonl",
  webhookUrl: env.ALERT_WEBHOOK_URL?.trim() || null,
  telegram:
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ALERT_CHAT_ID ? { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_ALERT_CHAT_ID } : null,
  dedupeMs: num(env.EP_ALERT_DEDUPE_MS, 600_000)
});

export type AlertRaiser = (kind: EpAlertKind, message: string, data?: Record<string, unknown>) => void;

/**
 * Build the alert raiser. Disk + console are synchronous and never throw outward; webhook/Telegram
 * are fire-and-forget with their own error swallowing (an alert path must never take the engine
 * down). Duplicate (kind, message) pairs are suppressed inside the dedupe window so a stuck
 * condition alerts once, not once per tick.
 */
export const buildAlertRaiser = (cfg: AlertSinkConfig, fetchImpl: typeof fetch = fetch): AlertRaiser => {
  const lastSent = new Map<string, number>();
  return (kind, message, data) => {
    const tsMs = Date.now();
    const key = `${kind}:${message}`;
    const prev = lastSent.get(key);
    if (prev != null && tsMs - prev < cfg.dedupeMs) return;
    lastSent.set(key, tsMs);
    const alert: EpAlert = { kind, message, data, tsMs };
    console.error(`[ep-alert] ${kind}: ${message}`);
    try {
      appendFileSync(resolveWritablePath(cfg.path), JSON.stringify(alert) + "\n", "utf8");
    } catch {
      /* disk alert failure must not cascade */
    }
    if (cfg.webhookUrl) {
      void fetchImpl(cfg.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(alert)
      }).catch(() => undefined);
    }
    if (cfg.telegram) {
      void fetchImpl(`https://api.telegram.org/bot${cfg.telegram.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.telegram.chatId, text: `⚠️ EP ${kind}\n${message}` })
      }).catch(() => undefined);
    }
  };
};

// ── Loop watchdog ─────────────────────────────────────────────────────────────

export type LoopPulse = { name: string; lastRunMs: number; intervalMs: number };

/** Which loops have missed too many beats? Pure — the service feeds pulses and alerts on the result. */
export const stalledLoops = (pulses: LoopPulse[], nowMs: number, toleranceMultiple = 5): LoopPulse[] =>
  pulses.filter((p) => p.lastRunMs > 0 && nowMs - p.lastRunMs > p.intervalMs * toleranceMultiple);
