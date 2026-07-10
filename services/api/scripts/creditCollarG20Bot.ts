/**
 * G-20 Telegram RFQ bot — semi-automatic dry-run executor. Long-polls the Telegram Bot API in the shared
 * Atticus↔G-20 group and drives the daily RFQ loop end-to-end (paper booking only):
 *
 *   • at the daily window (G20_WINDOW_UTC, default 14:00) it runs the RFQ generator and posts the message;
 *   • when G-20 replies in the agreed format (RFQ-7 BID 78 ASK 96 VALID 60) it parses, checks the quote
 *     against the model credit (decideQuote), and posts the recommendation with [DONE]/[PASS] buttons;
 *   • a button tap books (or passes) via the same creditCollarG20Rfq.ts plumbing — positions flow into the
 *     normal 24h settle pipeline and /positions. G20_AUTO_CONFIRM=true skips the buttons (flag-gated).
 *
 * Setup: create a bot via @BotFather, add it to the group as ADMIN (so it can read replies), set
 * TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID. Manual fallback always works: run the generator yourself and
 * book with `creditCollarG20Rfq.ts book`.
 *
 * Run: npx tsx scripts/creditCollarG20Bot.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseQuoteReply, decideQuote } from "../src/singleSide/twoSided/creditCollar/g20Telegram";
import { resolveWritablePath } from "../src/singleSide/twoSided/creditCollar/shadowStore";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const WINDOW = process.env.G20_WINDOW_UTC || "14:00";
const AUTO_CONFIRM = String(process.env.G20_AUTO_CONFIRM ?? "false").toLowerCase() === "true";
const MAX_DISCOUNT = Number(process.env.G20_MAX_DISCOUNT_PCT ?? 0.25);
const RFQ_PATH = process.env.G20_RFQ_PATH ?? "./logs/g20-rfqs.jsonl";
const POLL_MS = 3_000;

const api = async (method: string, body: Record<string, unknown>): Promise<any> => {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json();
};
const say = (text: string, extra: Record<string, unknown> = {}) => api("sendMessage", { chat_id: CHAT_ID, text, ...extra });

const runRfqTool = (...args: string[]): string => {
  try {
    return execFileSync("npx", ["tsx", "scripts/creditCollarG20Rfq.ts", ...args], { encoding: "utf8", cwd: process.cwd() });
  } catch (e) {
    return `tool failed: ${(e as Error).message}`;
  }
};

type PendingRfq = { ref: string; status: string; legs: Array<{ side: string; modelCreditUsdc: number }> };
const pendingRfq = (ref: string): PendingRfq | null => {
  const eff = resolveWritablePath(RFQ_PATH);
  if (!existsSync(eff)) return null;
  const rows = readFileSync(eff, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as PendingRfq);
  return rows.find((r) => r.ref === ref && r.status === "pending") ?? null;
};

let lastWindowDay = "";
const maybeRunWindow = async (): Promise<void> => {
  const now = new Date();
  const hhmm = now.toISOString().slice(11, 16);
  const day = now.toISOString().slice(0, 10);
  if (hhmm < WINDOW || lastWindowDay === day) return;
  lastWindowDay = day;
  console.log(`[bot] window ${WINDOW} — generating RFQ`);
  const out = runRfqTool("generate");
  const msg = out.includes("paste to G-20")
    ? out.split("── paste to G-20 ─────────────────────────────────────────────")[1]?.split("──────────────────────────────────────────────────────────────")[0]?.trim()
    : null;
  if (msg) await say(msg);
  else await say(out.includes("HALT") ? `No RFQ today — regime gate says sit out. (Normal.)` : `RFQ generation issue:\n${out.slice(0, 500)}`);
};

const handleReply = async (text: string, messageId: number): Promise<void> => {
  const parsed = parseQuoteReply(text);
  if (!parsed) return; // not a quote — ignore chatter
  const rfq = pendingRfq(parsed.ref);
  if (!rfq) {
    await say(`${parsed.ref}: no pending RFQ with that ref (already booked/passed?).`, { reply_to_message_id: messageId });
    return;
  }
  const avgModel = rfq.legs.reduce((s, l) => s + l.modelCreditUsdc, 0) / rfq.legs.length;
  const decision = decideQuote(parsed.bidUsdc, avgModel, MAX_DISCOUNT);
  if (AUTO_CONFIRM) {
    if (decision.action === "done") {
      const out = runRfqTool("book", parsed.ref, String(parsed.bidUsdc));
      await say(`DONE — ${parsed.ref} booked @ net $${parsed.bidUsdc} (auto). ${decision.reason}\n${out.split("\n").slice(-2).join("\n")}`, { reply_to_message_id: messageId });
    } else {
      runRfqTool("pass", parsed.ref);
      await say(`PASS — ${parsed.ref}. ${decision.reason}`, { reply_to_message_id: messageId });
    }
    return;
  }
  await say(`${parsed.ref}: bid $${parsed.bidUsdc}${parsed.askUsdc != null ? ` / ask $${parsed.askUsdc}` : ""} · recommend ${decision.action.toUpperCase()}\n${decision.reason}`, {
    reply_to_message_id: messageId,
    reply_markup: {
      inline_keyboard: [[
        { text: `✅ DONE @ $${parsed.bidUsdc}`, callback_data: `done:${parsed.ref}:${parsed.bidUsdc}` },
        { text: "✖ PASS", callback_data: `pass:${parsed.ref}:0` }
      ]]
    }
  });
};

const handleCallback = async (cb: any): Promise<void> => {
  const [action, ref, net] = String(cb.data || "").split(":");
  if (action === "done") {
    const out = runRfqTool("book", ref, net);
    await say(`DONE — ${ref} booked @ net $${net}.\n${out.split("\n").slice(-2).join("\n")}`);
  } else if (action === "pass") {
    runRfqTool("pass", ref);
    await say(`PASS — ${ref} closed without booking.`);
  }
  await api("answerCallbackQuery", { callback_query_id: cb.id });
};

const main = async (): Promise<void> => {
  if (!TOKEN || !CHAT_ID) {
    console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.");
    process.exit(1);
  }
  console.log(`[bot] G-20 RFQ bot up · window ${WINDOW}Z · auto-confirm ${AUTO_CONFIRM} · tolerance ${(MAX_DISCOUNT * 100).toFixed(0)}%`);
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await maybeRunWindow();
      const updates = await api("getUpdates", { offset, timeout: 20, allowed_updates: ["message", "callback_query"] });
      for (const u of updates?.result ?? []) {
        offset = u.update_id + 1;
        if (u.callback_query) await handleCallback(u.callback_query);
        else if (u.message?.text && String(u.message.chat?.id) === String(CHAT_ID)) await handleReply(u.message.text, u.message.message_id);
      }
    } catch (e) {
      console.error(`[bot] loop error: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
};

main();
