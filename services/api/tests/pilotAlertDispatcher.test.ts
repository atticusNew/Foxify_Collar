import assert from "node:assert/strict";
import test from "node:test";

import {
  configureAlertDispatcher,
  dispatchAlert,
  __resetAlertDispatcherForTests
} from "../src/pilot/alertDispatcher.js";

// R7 — Alert dispatcher unit tests. We mock global fetch so destinations
// can be exercised end-to-end without hitting a real Telegram / Slack /
// Discord server.
//
// Coverage:
//   - configureAlertDispatcher reads env vars, enables matching destinations
//   - dispatchAlert sends to enabled destinations matching the alert level
//   - dispatchAlert skips destinations whose level filter doesn't match
//   - dispatchAlert dedupes within window
//   - send failures don't throw to caller, are reflected in result.ok=false
//   - Telegram payload uses sendMessage with HTML parse_mode
//   - All destinations disabled = no-op (no fetch calls)

const captureFetch = () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let outcomeStatus = 200;
  let outcomeOk = true;
  const original = global.fetch;
  global.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    calls.push({ url, init: init || {} });
    return {
      ok: outcomeOk,
      status: outcomeStatus,
      text: async () => "ok",
      json: async () => ({})
    } as any;
  }) as typeof fetch;
  return {
    calls,
    setOutcome: (status: number, ok: boolean) => {
      outcomeStatus = status;
      outcomeOk = ok;
    },
    restore: () => {
      global.fetch = original;
    }
  };
};

const setEnv = (vars: Record<string, string | undefined>) => {
  const original: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    original[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  return () => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
};

test("R7: dispatcher with no env vars set = no-op (no destinations, no fetch)", async () => {
  const restoreEnv = setEnv({
    PILOT_ALERT_TELEGRAM_BOT_TOKEN: "",
    PILOT_ALERT_TELEGRAM_CHAT_ID: "",
    PILOT_ALERT_SLACK_WEBHOOK_URL: "",
    PILOT_ALERT_DISCORD_WEBHOOK_URL: "",
    PILOT_ALERT_GENERIC_WEBHOOK_URL: ""
  });
  const fetchMock = captureFetch();
  __resetAlertDispatcherForTests();
  const result = configureAlertDispatcher();
  assert.equal(result.configured, false);
  assert.deepEqual(result.destinations, []);

  const dispatch = await dispatchAlert({
    level: "critical",
    code: "test_code",
    message: "test message",
    timestamp: new Date().toISOString()
  });
  assert.deepEqual(dispatch.destinations, []);
  assert.equal(fetchMock.calls.length, 0, "no fetch calls when no destinations");

  fetchMock.restore();
  restoreEnv();
});

test("R7: Telegram destination sends sendMessage with HTML parse_mode for critical alerts", async () => {
  const restoreEnv = setEnv({
    PILOT_ALERT_TELEGRAM_BOT_TOKEN: "fake-token-123",
    PILOT_ALERT_TELEGRAM_CHAT_ID: "987654",
    PILOT_ALERT_TELEGRAM_LEVELS: "critical",
    PILOT_ALERT_DEDUP_WINDOW_SEC: "0",
    PILOT_ALERT_SLACK_WEBHOOK_URL: "",
    PILOT_ALERT_DISCORD_WEBHOOK_URL: "",
    PILOT_ALERT_GENERIC_WEBHOOK_URL: ""
  });
  const fetchMock = captureFetch();
  __resetAlertDispatcherForTests();
  const result = configureAlertDispatcher();
  assert.equal(result.configured, true);
  assert.deepEqual(result.destinations, ["telegram"]);

  // Critical alert → telegram should send
  const r1 = await dispatchAlert({
    level: "critical",
    code: "trigger_fired",
    message: "Position #1 triggered.",
    timestamp: "2026-04-19T16:00:00.000Z"
  });
  assert.equal(fetchMock.calls.length, 1, "exactly one fetch call");
  const tgCall = fetchMock.calls[0];
  assert.match(tgCall.url, /api\.telegram\.org\/botfake-token-123\/sendMessage/);
  const body = JSON.parse(String(tgCall.init.body));
  assert.equal(body.chat_id, "987654");
  assert.equal(body.parse_mode, "HTML");
  assert.match(body.text, /CRITICAL/);
  assert.match(body.text, /trigger_fired/);
  assert.match(body.text, /Position #1 triggered/);

  // Telegram destination result: sent + ok
  assert.equal(r1.destinations.length, 1);
  assert.equal(r1.destinations[0].name, "telegram");
  assert.equal(r1.destinations[0].sent, true);
  assert.equal(r1.destinations[0].ok, true);

  // Warning level alert → Telegram skips it (only listens to critical)
  fetchMock.calls.length = 0;
  const r2 = await dispatchAlert({
    level: "warning",
    code: "negative_spread",
    message: "spread is negative",
    timestamp: "2026-04-19T16:01:00.000Z"
  });
  assert.equal(fetchMock.calls.length, 0, "warning skipped because level filter is 'critical' only");
  assert.equal(r2.destinations[0].sent, false);
  assert.equal(r2.destinations[0].suppressed, false);

  fetchMock.restore();
  restoreEnv();
});

test("R7: dedup window suppresses identical (code,level) within window", async () => {
  const restoreEnv = setEnv({
    PILOT_ALERT_TELEGRAM_BOT_TOKEN: "tok",
    PILOT_ALERT_TELEGRAM_CHAT_ID: "1",
    PILOT_ALERT_TELEGRAM_LEVELS: "warning,critical",
    PILOT_ALERT_DEDUP_WINDOW_SEC: "60",
    PILOT_ALERT_SLACK_WEBHOOK_URL: "",
    PILOT_ALERT_DISCORD_WEBHOOK_URL: "",
    PILOT_ALERT_GENERIC_WEBHOOK_URL: ""
  });
  const fetchMock = captureFetch();
  __resetAlertDispatcherForTests();
  configureAlertDispatcher();

  const ts = "2026-04-19T16:00:00.000Z";
  // First send: hits Telegram
  await dispatchAlert({ level: "warning", code: "hedge_no_spot", message: "1", timestamp: ts });
  assert.equal(fetchMock.calls.length, 1, "first send hits");

  // Second send within window: suppressed
  const r2 = await dispatchAlert({ level: "warning", code: "hedge_no_spot", message: "2", timestamp: ts });
  assert.equal(fetchMock.calls.length, 1, "dedup suppressed second send");
  assert.equal(r2.destinations[0].suppressed, true);

  // Different code: not suppressed
  await dispatchAlert({ level: "warning", code: "different_code", message: "3", timestamp: ts });
  assert.equal(fetchMock.calls.length, 2, "different code is not suppressed");

  fetchMock.restore();
  restoreEnv();
});

test("R7: Slack and Generic destinations send their format; failures captured in result", async () => {
  const restoreEnv = setEnv({
    PILOT_ALERT_TELEGRAM_BOT_TOKEN: "",
    PILOT_ALERT_TELEGRAM_CHAT_ID: "",
    PILOT_ALERT_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/FAKE",
    PILOT_ALERT_SLACK_LEVELS: "warning,critical",
    PILOT_ALERT_GENERIC_WEBHOOK_URL: "https://example.com/webhook",
    PILOT_ALERT_GENERIC_LEVELS: "info,warning,critical",
    PILOT_ALERT_DEDUP_WINDOW_SEC: "0",
    PILOT_ALERT_DISCORD_WEBHOOK_URL: ""
  });
  const fetchMock = captureFetch();
  fetchMock.setOutcome(500, false); // Slack returns 500 → ok=false
  __resetAlertDispatcherForTests();
  const conf = configureAlertDispatcher();
  assert.deepEqual(conf.destinations.sort(), ["generic", "slack"]);

  const r = await dispatchAlert({
    level: "warning",
    code: "test",
    message: "msg",
    timestamp: "2026-04-19T16:00:00.000Z"
  });
  assert.equal(fetchMock.calls.length, 2, "both destinations were called");

  // Both reflect ok=false from the mock 500
  for (const d of r.destinations) {
    assert.equal(d.sent, true);
    assert.equal(d.ok, false);
    assert.equal(d.status, 500);
  }

  // Slack call: payload has color, text, attachments
  const slackCall = fetchMock.calls.find((c) => c.url.includes("slack.com"))!;
  const slackBody = JSON.parse(String(slackCall.init.body));
  assert.match(slackBody.text, /WARNING/);
  assert.ok(Array.isArray(slackBody.attachments), "slack payload has attachments");

  // Generic call: payload is the raw alert object
  const genCall = fetchMock.calls.find((c) => c.url.includes("example.com"))!;
  const genBody = JSON.parse(String(genCall.init.body));
  assert.equal(genBody.code, "test");
  assert.equal(genBody.level, "warning");
  assert.equal(genBody.message, "msg");

  fetchMock.restore();
  restoreEnv();
});

test("R7 regression: Telegram body HTML-escapes <, >, & in alert.message", async () => {
  const restoreEnv = setEnv({
    PILOT_ALERT_TELEGRAM_BOT_TOKEN: "fake-token-123",
    PILOT_ALERT_TELEGRAM_CHAT_ID: "987654",
    PILOT_ALERT_TELEGRAM_LEVELS: "warning,critical",
    PILOT_ALERT_DEDUP_WINDOW_SEC: "0",
    PILOT_ALERT_SLACK_WEBHOOK_URL: "",
    PILOT_ALERT_DISCORD_WEBHOOK_URL: "",
    PILOT_ALERT_GENERIC_WEBHOOK_URL: ""
  });
  const fetchMock = captureFetch();
  __resetAlertDispatcherForTests();
  configureAlertDispatcher();

  // Production failure observed 2026-04-20: alert.message strings can
  // contain instrument names like "BTC-19APR26-78500-P offered at <0.001"
  // which Telegram's HTML parser rejects with 400 because it sees "<0"
  // as the start of an unrecognized tag. We HTML-escape the body before
  // sending so arbitrary alert.message content never breaks the send.
  await dispatchAlert({
    level: "warning",
    code: "html_escape_test",
    message: "tag <html> & symbols > here for BTC-PUT <0.001",
    timestamp: "2026-04-20T00:00:00.000Z"
  });

  assert.equal(fetchMock.calls.length, 1, "telegram called once");
  const body = JSON.parse(String(fetchMock.calls[0].init.body));
  assert.match(body.text, /&lt;html&gt;/, "< and > escaped in body");
  assert.match(body.text, /&amp;/, "& escaped in body");
  assert.match(body.text, /&lt;0\.001/, "embedded <0.001 escaped");
  assert.match(body.text, /<b>WARNING<\/b>/, "header HTML tags survive (real HTML, not escaped)");
  assert.equal(body.parse_mode, "HTML");

  fetchMock.restore();
  restoreEnv();
});

test("R7 regression: Telegram failure response body is captured into outcome.detail", async () => {
  const restoreEnv = setEnv({
    PILOT_ALERT_TELEGRAM_BOT_TOKEN: "fake-token-123",
    PILOT_ALERT_TELEGRAM_CHAT_ID: "987654",
    PILOT_ALERT_TELEGRAM_LEVELS: "warning,critical",
    PILOT_ALERT_DEDUP_WINDOW_SEC: "0",
    PILOT_ALERT_SLACK_WEBHOOK_URL: "",
    PILOT_ALERT_DISCORD_WEBHOOK_URL: "",
    PILOT_ALERT_GENERIC_WEBHOOK_URL: ""
  });

  // Mock fetch returning a Telegram-style 400 with the actual error
  // description so we can verify the dispatcher reads the response
  // body and surfaces it via outcome.detail (was 'n/a' before this fix).
  const original = global.fetch;
  global.fetch = (async () => ({
    ok: false,
    status: 400,
    text: async () =>
      '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}',
    json: async () => ({})
  }) as any) as typeof fetch;

  __resetAlertDispatcherForTests();
  configureAlertDispatcher();

  const r = await dispatchAlert({
    level: "warning",
    code: "detail_capture_test",
    message: "message",
    timestamp: "2026-04-20T00:00:00.000Z"
  });

  global.fetch = original;
  restoreEnv();

  const tg = r.destinations.find((d) => d.name === "telegram");
  assert.ok(tg, "telegram destination present");
  assert.equal(tg!.ok, false);
  assert.equal(tg!.status, 400);
  assert.match(
    String(tg!.detail || ""),
    /chat not found/,
    `detail should include Telegram's description; got ${tg!.detail}`
  );
});
