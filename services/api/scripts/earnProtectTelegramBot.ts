#!/usr/bin/env tsx
/**
 * EARN & PROTECT — Telegram bot runner (the second thin client, decision 8).
 *
 * A few hundred lines that move JSON between the Telegram Bot API and the SAME local Earn & Protect
 * JSON API the web app uses (EP_API_BASE). All decisions and copy live in the pure module
 * (src/…/creditCollar/epBot.ts); this file is transport.
 *
 *   paste address once  → stored per chat (read-only; we never ask for keys)
 *   /positions          → open perps with inline Earn & Protect buttons
 *   background notifier → pushes every cycle event: credit paid, renewed, knocked out + re-armed,
 *                         refusals — the retention loop
 *
 * Run: TELEGRAM_BOT_TOKEN=… EP_API_BASE=http://localhost:8788 npx tsx services/api/scripts/earnProtectTelegramBot.ts
 * (TELEGRAM_API_BASE is overridable for tests/mocks.)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveWritablePath } from "../src/singleSide/twoSided/creditCollar/shadowStore";
import {
  BOT_COMMANDS,
  diffCycleEvents,
  HELP_TEXT,
  humanRefusal,
  parseBotMessage,
  positionsKeyboard,
  positionsText,
  tosPrompt,
  WELCOME_TEXT,
  type BotPosition,
  type ChatSnapshot
} from "../src/singleSide/twoSided/creditCollar/epBot";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.error("[ep-bot] TELEGRAM_BOT_TOKEN missing — set it and restart");
  process.exit(1);
}
const tgBase = `${process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org"}/bot${botToken}`;
const apiBase = process.env.EP_API_BASE ?? "http://localhost:8788";
const storePath = process.env.EP_BOT_STORE_PATH ?? "./logs/ep-bot-chats.json";
const notifyMs = num(process.env.EP_BOT_NOTIFY_MS, 30_000);
// Telegram Mini App home (must be public HTTPS — Telegram refuses http/localhost web_app URLs).
// The service serves it at <public-base>/miniapp; unset ⟹ buttons/menu are simply omitted.
const rawMiniApp = process.env.EP_MINIAPP_URL?.trim() ?? "";
const miniAppUrl = /^https:\/\//.test(rawMiniApp) ? rawMiniApp.replace(/\/$/, "") : null;
if (rawMiniApp && !miniAppUrl) console.error("[ep-bot] EP_MINIAPP_URL ignored — Telegram requires an https:// URL");
const miniAppFor = (address: string): string | null => (miniAppUrl ? `${miniAppUrl}?account=${address}` : null);

// ── Chat store (chatId → address + notification snapshot) ─────────────────────

type ChatRecord = { address: string; snapshot: ChatSnapshot | null };
type ChatStore = Record<string, ChatRecord>;

const loadChats = (): ChatStore => {
  const eff = resolveWritablePath(storePath);
  if (!existsSync(eff)) return {};
  try {
    const parsed = JSON.parse(readFileSync(eff, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ChatStore) : {};
  } catch {
    return {};
  }
};
const saveChats = (chats: ChatStore): void => {
  try {
    writeFileSync(resolveWritablePath(storePath), JSON.stringify(chats, null, 1), "utf8");
  } catch (e) {
    console.error(`[ep-bot] chat store save failed: ${(e as Error).message}`);
  }
};

// ── Transports ────────────────────────────────────────────────────────────────

const tg = async (method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown }> => {
  try {
    const res = await fetch(`${tgBase}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return (await res.json()) as { ok: boolean; result?: unknown };
  } catch (e) {
    console.error(`[ep-bot] telegram ${method} failed: ${(e as Error).message}`);
    return { ok: false };
  }
};

// HTML parse mode: Markdown corrupts on underscores in addresses/instrument ids.
const send = (chatId: string | number, text: string, keyboard?: unknown): Promise<{ ok: boolean }> =>
  tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
  });

const ep = async (path: string, account: string, method = "GET"): Promise<Record<string, unknown>> => {
  const sep = path.includes("?") ? "&" : "?";
  try {
    const res = await fetch(`${apiBase}${path}${sep}account=${encodeURIComponent(account)}`, {
      method,
      headers: method === "POST" ? { "Idempotency-Key": `tg-${account.slice(2, 10)}-${Date.now().toString(36)}` } : undefined
    });
    return (await res.json()) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: "api_unreachable", message: (e as Error).message };
  }
};

// ── Handlers ──────────────────────────────────────────────────────────────────

const showPositions = async (chatId: string | number, address: string): Promise<void> => {
  const [pos, prot] = await Promise.all([ep("/api/positions", address), ep("/api/protection", address)]);
  if (pos.ok !== true) {
    await send(chatId, `🚫 ${humanRefusal(String(pos.message ?? pos.error ?? ""))}`);
    return;
  }
  const positions = (pos.positions as BotPosition[]) ?? [];
  await send(chatId, positionsText(positions), positionsKeyboard(positions, prot.on === true, miniAppFor(address)));
};

/** ToS gate (Phase 3): prompt with the inline accept button when the current version is unaccepted. */
const promptTosIfNeeded = async (chatId: string | number, address: string): Promise<boolean> => {
  const tos = await ep("/api/tos", address);
  if (tos.ok === true && tos.required === true && tos.accepted !== true) {
    const p = tosPrompt(String(tos.version ?? "?"), apiBase);
    await send(chatId, p.text, p.keyboard);
    return true;
  }
  return false;
};

const handleMessage = async (chats: ChatStore, chatId: string | number, text: string): Promise<void> => {
  const key = String(chatId);
  const cmd = parseBotMessage(text);
  if (cmd.kind === "start") {
    await send(chatId, WELCOME_TEXT);
    return;
  }
  if (cmd.kind === "help") {
    await send(chatId, HELP_TEXT);
    return;
  }
  if (cmd.kind === "address") {
    chats[key] = { address: cmd.address, snapshot: null };
    saveChats(chats);
    await send(chatId, `🔗 Connected <code>${cmd.address.slice(0, 6)}…${cmd.address.slice(-4)}</code> — read-only. We can see positions, never touch them.`);
    if (await promptTosIfNeeded(chatId, cmd.address)) return;
    await showPositions(chatId, cmd.address);
    return;
  }
  const chat = chats[key];
  if (!chat) {
    await send(chatId, "Paste your Hyperliquid address (0x…) first — read-only, no keys.");
    return;
  }
  if (cmd.kind === "positions") {
    await showPositions(chatId, chat.address);
    return;
  }
  if (cmd.kind === "status") {
    const st = await ep("/api/state", chat.address);
    if (st.ok !== true) {
      await send(chatId, `🚫 ${humanRefusal(String(st.message ?? st.error ?? ""))}`);
      return;
    }
    const payouts = (st.payouts as Array<{ amountUsdc: number; status: string }>) ?? [];
    const paid = payouts.filter((p) => p.status === "paid" || p.status === "confirmed").reduce((s, p) => s + p.amountUsdc, 0);
    const prot = st.protection as { on?: boolean; founding?: boolean } | undefined;
    await send(
      chatId,
      [
        "🛡 <b>Earn &amp; Protect</b> · <i>status</i>",
        "",
        `Protection: <b>${prot?.on ? "ON — auto-renews daily" : "off"}</b>${prot?.founding ? " · 🏅 founding rate" : ""}`,
        `Credits paid to date: <b>$${paid.toFixed(2)}</b>`,
        "",
        "<i>Use /positions to toggle.</i>"
      ].join("\n")
    );
    return;
  }
  await send(chatId, "Didn't catch that — /help lists the commands.");
};

const handleCallback = async (chats: ChatStore, cb: { id: string; data?: string; message?: { chat?: { id?: number } } }): Promise<void> => {
  const chatId = cb.message?.chat?.id;
  const chat = chatId != null ? chats[String(chatId)] : undefined;
  if (chatId == null || !chat) {
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Paste your address first (0x…)" });
    return;
  }
  if (cb.data === "tos") {
    const out = await ep("/api/tos/accept", chat.address, "POST");
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: out.ok === true ? "Terms accepted" : "Could not record acceptance" });
    if (out.ok === true) {
      await send(chatId, `✅ Terms accepted (${out.version}). You're set.`);
      await showPositions(chatId, chat.address);
    } else {
      await send(chatId, `🚫 ${humanRefusal(String(out.message ?? out.error ?? ""))}`);
    }
    return;
  }
  if (cb.data === "wrap") {
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Wrapping — pricing the live book…" });
    const out = await ep("/api/wrap", chat.address, "POST");
    if (out.ok !== true && out.error === "verify_required" && miniAppUrl) {
      await send(chatId, `🔐 ${humanRefusal(String(out.message ?? ""))}`, [[{ text: "🔐 Verify in the app (one signature)", web_app: { url: miniAppFor(chat.address)! } }]]);
      return;
    }
    if (out.ok === true) {
      const wrap = out.wrap as { quote?: { creditUsdc?: number; floorStrike?: number; capStrike?: number } };
      const q = wrap?.quote;
      await send(
        chatId,
        [
          "🛡 <b>Protection live</b>",
          "",
          `Today's credit: <b>$${q?.creditUsdc ?? "?"}</b> — unlocks through the day, pays at the cycle's close`,
          `Hard floor: <b>$${(q?.floorStrike ?? 0).toLocaleString("en-US")}</b> · Cap: <b>$${(q?.capStrike ?? 0).toLocaleString("en-US")}</b> (touch ends the cycle — you keep gains to the cap + unlocked credit)`,
          "",
          "<i>Auto-renews daily while the toggle stays on.</i>"
        ].join("\n")
      );
    } else {
      await send(chatId, `🚫 ${humanRefusal(String(out.message ?? out.error ?? ""))}`);
    }
    return;
  }
  if (cb.data === "close") {
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Closing early…" });
    const out = await ep("/api/close", chat.address, "POST");
    if (out.ok === true) {
      const v = out.vested as { vestedUsdc?: number; fullCreditUsdc?: number };
      await send(chatId, `✋ Closed early — you keep <b>$${(v?.vestedUsdc ?? 0).toFixed(2)}</b> of $${(v?.fullCreditUsdc ?? 0).toFixed(2)} unlocked. Auto-renew off.`);
    } else {
      await send(chatId, `🚫 ${humanRefusal(String(out.message ?? out.error ?? ""))}`);
    }
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: cb.id });
};

// ── Notifier (state poll → push) ──────────────────────────────────────────────

const notifyTick = async (): Promise<void> => {
  const chats = loadChats();
  let dirty = false;
  for (const [chatId, chat] of Object.entries(chats)) {
    try {
      const st = await ep("/api/state", chat.address);
      if (st.ok !== true) continue;
      const { events, next } = diffCycleEvents(
        chat.snapshot,
        (st.wraps as Parameters<typeof diffCycleEvents>[1]) ?? [],
        (st.payouts as Parameters<typeof diffCycleEvents>[2]) ?? []
      );
      for (const ev of events) await send(chatId, ev);
      chat.snapshot = next;
      dirty = true;
    } catch (e) {
      console.error(`[ep-bot] notify failed for chat ${chatId}: ${(e as Error).message}`);
    }
  }
  if (dirty) saveChats(chats);
};

// ── Long-poll loop ────────────────────────────────────────────────────────────

type TgUpdate = {
  update_id: number;
  message?: { chat?: { id?: number }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat?: { id?: number } } };
};

let offset = 0;

const pollLoop = async (): Promise<void> => {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await tg("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
      const updates = (res.result as TgUpdate[] | undefined) ?? [];
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        const chats = loadChats();
        if (u.message?.chat?.id != null && typeof u.message.text === "string") {
          await handleMessage(chats, u.message.chat.id, u.message.text);
        } else if (u.callback_query) {
          await handleCallback(chats, u.callback_query);
        }
      }
    } catch (e) {
      console.error(`[ep-bot] poll error: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
};

console.error(`[ep-bot] Earn & Protect bot up — API ${apiBase} · notifier every ${Math.round(notifyMs / 1000)}s${miniAppUrl ? ` · mini app ${miniAppUrl}` : " · mini app OFF (set EP_MINIAPP_URL)"}`);
// Register the "/" command menu (the professional touch traders expect).
void tg("setMyCommands", { commands: BOT_COMMANDS });
// The chat menu button opens the Mini App (global — the app resolves the account from
// localStorage inside Telegram's WebView, or the paste flow on first open).
if (miniAppUrl) void tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Earn & Protect", web_app: { url: miniAppUrl } } });
setInterval(() => void notifyTick(), notifyMs);
void pollLoop();
