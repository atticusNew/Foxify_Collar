import type { PilotAlert } from "./monitor";

/**
 * R7 — Pre-live-pilot alerting layer.
 *
 * Sends pilot alerts (the same PilotAlert objects already emitted by
 * monitor.ts) to one or more outbound webhooks: Telegram bot, Slack,
 * Discord, or a generic JSON webhook.
 *
 * Design constraints:
 *   - Best-effort delivery. A webhook failure never crashes the platform,
 *     never blocks the alert from being recorded internally, and never
 *     gets retried (live alerting tolerates dropped messages better than
 *     duplicated messages — the user can always check /pilot/monitor/alerts
 *     for the canonical list).
 *   - Per-destination level filter. An operator may want only `critical`
 *     to Telegram (their phone) but `warning + critical` to Slack (the
 *     ops channel).
 *   - Per-destination dedup window. Same code+level within N seconds is
 *     suppressed to prevent storm during cycle-after-cycle failure modes.
 *   - Stateless. No persistent dedup table; recent-alert ring buffer
 *     lives in-process. Restart = clean slate, which is acceptable.
 *   - Configurable via env. No secrets in code.
 *
 * Configured via env vars (all optional — empty = destination disabled):
 *
 *   PILOT_ALERT_TELEGRAM_BOT_TOKEN  — Telegram bot HTTP API token
 *   PILOT_ALERT_TELEGRAM_CHAT_ID    — chat id (user, group, or channel)
 *   PILOT_ALERT_TELEGRAM_LEVELS     — comma-list of levels to send
 *                                     (default: "warning,critical")
 *
 *   PILOT_ALERT_SLACK_WEBHOOK_URL   — Slack incoming-webhook URL
 *   PILOT_ALERT_SLACK_LEVELS        — default "warning,critical"
 *
 *   PILOT_ALERT_DISCORD_WEBHOOK_URL — Discord webhook URL
 *   PILOT_ALERT_DISCORD_LEVELS      — default "critical"
 *
 *   PILOT_ALERT_GENERIC_WEBHOOK_URL — generic JSON POST destination
 *   PILOT_ALERT_GENERIC_LEVELS      — default "info,warning,critical"
 *
 *   PILOT_ALERT_DEDUP_WINDOW_SEC    — same (code,level) pair suppressed
 *                                     within this many seconds (default 300)
 *   PILOT_ALERT_HTTP_TIMEOUT_MS     — per-webhook send timeout (default 5000)
 *
 * Usage:
 *   import { dispatchAlert, configureAlertDispatcher } from "./alertDispatcher";
 *   configureAlertDispatcher();   // reads env, sets up enabled destinations
 *   dispatchAlert({ level: "critical", code: "...", message: "...", timestamp });
 *
 * Idempotent: configureAlertDispatcher() can be called multiple times;
 * later calls overwrite earlier config. Useful for tests.
 */

export type AlertLevel = PilotAlert["level"];

type Destination = {
  name: "telegram" | "slack" | "discord" | "generic";
  enabled: boolean;
  levels: Set<AlertLevel>;
  send: (alert: PilotAlert) => Promise<{ ok: boolean; status: number; detail?: string }>;
};

type DispatcherConfig = {
  destinations: Destination[];
  dedupWindowMs: number;
  httpTimeoutMs: number;
};

let config: DispatcherConfig | null = null;
const recentSentKeys = new Map<string, number>(); // key = `${dest}:${code}:${level}`, value = timestampMs

const parseLevels = (raw: string | undefined, fallback: string): Set<AlertLevel> => {
  const list = String(raw ?? fallback).split(",").map((s) => s.trim().toLowerCase());
  const out = new Set<AlertLevel>();
  for (const l of list) {
    if (l === "info" || l === "warning" || l === "critical") out.add(l);
  }
  return out;
};

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
};

// HTML-escape user-provided text before embedding in a Telegram message.
// Telegram's HTML parse mode requires <, >, & escaped — unescaped chars
// in alert.message produce a 400 "Bad Request: can't parse entities".
// Real-world example: an alert message containing an instrument name
// like "BTC-19APR26-78500-P offered at <0.001" was rejected because
// "<0.001" was parsed as the start of an HTML tag.
const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// Format alert for a Telegram message. Markdown V2 is finicky; we use the
// simpler "HTML" parse mode which is friendlier with special characters.
const formatForTelegram = (alert: PilotAlert): string => {
  const icon = alert.level === "critical" ? "🚨" : alert.level === "warning" ? "⚠️" : "ℹ️";
  const head = `${icon} <b>${escapeHtml(alert.level.toUpperCase())}</b> — <code>${escapeHtml(alert.code)}</code>`;
  // Cap message length BEFORE escape so we don't truncate inside an HTML entity.
  const body = escapeHtml(alert.message.slice(0, 2000));
  const ts = `<i>${escapeHtml(alert.timestamp)}</i>`;
  return `${head}\n${body}\n${ts}`;
};

const formatForSlack = (alert: PilotAlert): Record<string, unknown> => {
  const color = alert.level === "critical" ? "#dc2626" : alert.level === "warning" ? "#f59e0b" : "#3b82f6";
  return {
    text: `[${alert.level.toUpperCase()}] ${alert.code}`,
    attachments: [
      {
        color,
        title: alert.code,
        text: alert.message,
        ts: Math.floor(new Date(alert.timestamp).getTime() / 1000),
        fields: alert.details
          ? Object.entries(alert.details)
              .filter(([k]) => !k.startsWith("_"))
              .slice(0, 8)
              .map(([k, v]) => ({
                title: k,
                value: typeof v === "string" ? v : JSON.stringify(v).slice(0, 200),
                short: true
              }))
          : []
      }
    ]
  };
};

const formatForDiscord = (alert: PilotAlert): Record<string, unknown> => {
  const color =
    alert.level === "critical"
      ? 0xdc2626
      : alert.level === "warning"
        ? 0xf59e0b
        : 0x3b82f6;
  return {
    embeds: [
      {
        title: `[${alert.level.toUpperCase()}] ${alert.code}`,
        description: alert.message,
        color,
        timestamp: alert.timestamp
      }
    ]
  };
};

export const configureAlertDispatcher = (): { configured: boolean; destinations: string[] } => {
  const destinations: Destination[] = [];
  const dedupWindowMs = Math.max(0, Number(process.env.PILOT_ALERT_DEDUP_WINDOW_SEC || "300") * 1000);
  const httpTimeoutMs = Math.max(500, Number(process.env.PILOT_ALERT_HTTP_TIMEOUT_MS || "5000"));

  const tgToken = String(process.env.PILOT_ALERT_TELEGRAM_BOT_TOKEN || "").trim();
  const tgChatId = String(process.env.PILOT_ALERT_TELEGRAM_CHAT_ID || "").trim();
  if (tgToken && tgChatId) {
    destinations.push({
      name: "telegram",
      enabled: true,
      levels: parseLevels(process.env.PILOT_ALERT_TELEGRAM_LEVELS, "warning,critical"),
      send: async (alert) => {
        try {
          const res = await fetchWithTimeout(
            `https://api.telegram.org/bot${tgToken}/sendMessage`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                chat_id: tgChatId,
                text: formatForTelegram(alert),
                parse_mode: "HTML",
                disable_web_page_preview: true
              })
            },
            httpTimeoutMs
          );
          // On non-OK, capture Telegram's response body so we can see the
          // exact error description (e.g. "chat not found", "Unauthorized",
          // "can't parse entities"). The dispatcher previously logged only
          // the status code, which left operators blind to the cause.
          let detail: string | undefined;
          if (!res.ok) {
            try {
              const body = await res.text();
              // Truncate so a long body doesn't clutter logs.
              detail = body.slice(0, 500);
            } catch {
              detail = undefined;
            }
          }
          return { ok: res.ok, status: res.status, detail };
        } catch (e: any) {
          return { ok: false, status: 0, detail: String(e?.message || e) };
        }
      }
    });
  }

  const slackUrl = String(process.env.PILOT_ALERT_SLACK_WEBHOOK_URL || "").trim();
  if (slackUrl) {
    destinations.push({
      name: "slack",
      enabled: true,
      levels: parseLevels(process.env.PILOT_ALERT_SLACK_LEVELS, "warning,critical"),
      send: async (alert) => {
        try {
          const res = await fetchWithTimeout(
            slackUrl,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(formatForSlack(alert))
            },
            httpTimeoutMs
          );
          let detail: string | undefined;
          if (!res.ok) {
            try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
          }
          return { ok: res.ok, status: res.status, detail };
        } catch (e: any) {
          return { ok: false, status: 0, detail: String(e?.message || e) };
        }
      }
    });
  }

  const discordUrl = String(process.env.PILOT_ALERT_DISCORD_WEBHOOK_URL || "").trim();
  if (discordUrl) {
    destinations.push({
      name: "discord",
      enabled: true,
      levels: parseLevels(process.env.PILOT_ALERT_DISCORD_LEVELS, "critical"),
      send: async (alert) => {
        try {
          const res = await fetchWithTimeout(
            discordUrl,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(formatForDiscord(alert))
            },
            httpTimeoutMs
          );
          let detail: string | undefined;
          if (!res.ok) {
            try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
          }
          return { ok: res.ok, status: res.status, detail };
        } catch (e: any) {
          return { ok: false, status: 0, detail: String(e?.message || e) };
        }
      }
    });
  }

  const genericUrl = String(process.env.PILOT_ALERT_GENERIC_WEBHOOK_URL || "").trim();
  if (genericUrl) {
    destinations.push({
      name: "generic",
      enabled: true,
      levels: parseLevels(process.env.PILOT_ALERT_GENERIC_LEVELS, "info,warning,critical"),
      send: async (alert) => {
        try {
          const res = await fetchWithTimeout(
            genericUrl,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(alert)
            },
            httpTimeoutMs
          );
          let detail: string | undefined;
          if (!res.ok) {
            try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
          }
          return { ok: res.ok, status: res.status, detail };
        } catch (e: any) {
          return { ok: false, status: 0, detail: String(e?.message || e) };
        }
      }
    });
  }

  config = { destinations, dedupWindowMs, httpTimeoutMs };
  recentSentKeys.clear();

  if (destinations.length > 0) {
    const summary = destinations
      .map((d) => `${d.name}(${Array.from(d.levels).join("|")})`)
      .join(", ");
    console.log(`[AlertDispatcher] configured: ${summary} dedupSec=${dedupWindowMs / 1000}`);
  } else {
    console.log("[AlertDispatcher] no destinations configured (all PILOT_ALERT_* env vars empty)");
  }

  return { configured: destinations.length > 0, destinations: destinations.map((d) => d.name) };
};

/**
 * Dispatch an alert to all configured webhook destinations whose level
 * filter accepts it. Best-effort: per-destination failures are logged but
 * never thrown to the caller.
 *
 * Dedup: identical (destination, code, level) tuples within
 * dedupWindowMs are suppressed.
 *
 * Returns summary for tests / observability. Caller does NOT need to await
 * for correctness, but should await to surface errors in tests.
 */
export const dispatchAlert = async (
  alert: PilotAlert
): Promise<{
  destinations: Array<{ name: string; sent: boolean; suppressed: boolean; ok?: boolean; status?: number; detail?: string }>;
}> => {
  if (!config) {
    return { destinations: [] };
  }
  const now = Date.now();
  const results: Array<{
    name: string;
    sent: boolean;
    suppressed: boolean;
    ok?: boolean;
    status?: number;
    detail?: string;
  }> = [];

  for (const dest of config.destinations) {
    if (!dest.enabled || !dest.levels.has(alert.level)) {
      results.push({ name: dest.name, sent: false, suppressed: false });
      continue;
    }
    const dedupKey = `${dest.name}:${alert.code}:${alert.level}`;
    const lastSent = recentSentKeys.get(dedupKey) || 0;
    if (config.dedupWindowMs > 0 && now - lastSent < config.dedupWindowMs) {
      results.push({ name: dest.name, sent: false, suppressed: true });
      continue;
    }
    let outcome: { ok: boolean; status: number; detail?: string };
    try {
      outcome = await dest.send(alert);
    } catch (e: any) {
      outcome = { ok: false, status: 0, detail: String(e?.message || e) };
    }
    if (outcome.ok) {
      recentSentKeys.set(dedupKey, now);
    } else {
      console.warn(
        `[AlertDispatcher] ${dest.name} send FAILED for ${alert.code}: status=${outcome.status} detail=${outcome.detail || "n/a"}`
      );
    }
    results.push({
      name: dest.name,
      sent: true,
      suppressed: false,
      ok: outcome.ok,
      status: outcome.status,
      detail: outcome.detail
    });
  }
  return { destinations: results };
};

export const __resetAlertDispatcherForTests = (): void => {
  config = null;
  recentSentKeys.clear();
};
