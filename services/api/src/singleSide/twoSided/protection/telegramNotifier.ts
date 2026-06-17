/**
 * Telegram notifier — pushes protection-signal transitions to a Telegram chat/bot.
 *
 * Used to alert Foxify's Telegram bot/channel the moment the live signal flips to GO (a genuine
 * buyer-favorable window) or back to WAIT (stand down). Config via env: TELEGRAM_BOT_TOKEN +
 * TELEGRAM_CHAT_ID. Pure sender (fetch injectable for tests) + a formatter.
 */

import type { LiveSignalResult } from "./protectionSignal";

export type TelegramConfig = { botToken: string; chatId: string };
export type TelegramFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export type TelegramSendResult = { ok: boolean; status: number | null; error: string | null };

export const sendTelegramMessage = async (
  cfg: TelegramConfig,
  text: string,
  fetchImpl?: TelegramFetch
): Promise<TelegramSendResult> => {
  if (!cfg.botToken || !cfg.chatId) return { ok: false, status: null, error: "telegram not configured" };
  const f = (fetchImpl ?? (fetch as unknown as TelegramFetch));
  try {
    const res = await f(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: "Markdown", disable_web_page_preview: true })
    });
    if (!res.ok) return { ok: false, status: res.status, error: (await res.text()).slice(0, 200) };
    return { ok: true, status: res.status, error: null };
  } catch (e) {
    return { ok: false, status: null, error: (e as Error).message };
  }
};

/** Human-readable alert for a signal transition. `ctx` carries the cover params for clarity. */
export const formatSignalAlert = (
  curr: LiveSignalResult,
  prev: LiveSignalResult | null,
  ctx: { side: string; triggerPct: number; tenorHours: number; payoutUsdc?: number }
): string => {
  const pct = (x: number | null) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const arrow = prev ? `${prev.state} → ${curr.state}` : curr.state;
  const cover = `${ctx.side} ${(ctx.triggerPct * 100).toFixed(1)}% / ${ctx.tenorHours}h${ctx.payoutUsdc ? ` / $${ctx.payoutUsdc} payout` : ""}`;
  if (curr.state === "GO") {
    return [
      `*ATTICUS PROTECTION — GO* (${arrow})`,
      `Favorable window for *${cover}* covers.`,
      `Trailing realized ${pct(curr.trailing_realized)} vs implied ${pct(curr.trailing_implied)} (edge ${curr.edge_pts ?? "?"} pts, n=${curr.samples}).`,
      `Covers will open while GO holds. Stand by for stand-down.`
    ].join("\n");
  }
  if (curr.state === "WAIT") {
    return [
      `*ATTICUS PROTECTION — WAIT (stand down)* (${arrow})`,
      `Realized ${pct(curr.trailing_realized)} ≤ implied ${pct(curr.trailing_implied)} — no edge. No new covers.`,
      `Cover: ${cover}.`
    ].join("\n");
  }
  return `*ATTICUS PROTECTION — ${curr.state}* (${arrow}). ${curr.reason}`;
};
