/**
 * Telegram notifier — message formatting + send (injected fetch).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { sendTelegramMessage, formatSignalAlert } from "../src/singleSide/twoSided/protection/telegramNotifier";
import type { LiveSignalResult } from "../src/singleSide/twoSided/protection/protectionSignal";

const go: LiveSignalResult = { state: "GO", trailing_realized: 0.35, trailing_implied: 0.18, edge_pts: 17, samples: 120, as_of_ms: 1, reason: "buyer-favorable" };
const wait: LiveSignalResult = { state: "WAIT", trailing_realized: 0, trailing_implied: 0.18, edge_pts: -18, samples: 120, as_of_ms: 1, reason: "not favorable" };

test("formatSignalAlert: GO message includes edge + cover params", () => {
  const msg = formatSignalAlert(go, wait, { side: "long", triggerPct: 0.03, tenorHours: 24, payoutUsdc: 60 });
  assert.match(msg, /GO/);
  assert.match(msg, /WAIT → GO/);
  assert.match(msg, /long 3\.0% \/ 24h/);
  assert.match(msg, /35\.0%/);
});

test("formatSignalAlert: WAIT message says stand down", () => {
  const msg = formatSignalAlert(wait, go, { side: "long", triggerPct: 0.03, tenorHours: 24 });
  assert.match(msg, /stand down/i);
});

test("sendTelegramMessage: posts to bot API and returns ok", async () => {
  let calledUrl = ""; let body = "";
  const fakeFetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    calledUrl = url; body = init.body;
    return { ok: true, status: 200, text: async () => "ok" };
  };
  const r = await sendTelegramMessage({ botToken: "T", chatId: "C" }, "hello", fakeFetch);
  assert.equal(r.ok, true);
  assert.match(calledUrl, /api\.telegram\.org\/botT\/sendMessage/);
  assert.match(body, /"chat_id":"C"/);
  assert.match(body, /"text":"hello"/);
});

test("sendTelegramMessage: not configured → ok:false", async () => {
  const r = await sendTelegramMessage({ botToken: "", chatId: "" }, "x");
  assert.equal(r.ok, false);
  assert.equal(r.error, "telegram not configured");
});

test("sendTelegramMessage: non-2xx → ok:false with status", async () => {
  const fakeFetch = async () => ({ ok: false, status: 403, text: async () => "forbidden" });
  const r = await sendTelegramMessage({ botToken: "T", chatId: "C" }, "x", fakeFetch);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});
