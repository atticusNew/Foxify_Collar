import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adminAuthorized,
  buildAlertRaiser,
  parseAdminAuthFromEnv,
  parseAlertSinkFromEnv,
  stalledLoops,
  tokenBucketLimiter
} from "../src/singleSide/twoSided/creditCollar/epSafety";
import {
  diffCycleEvents,
  humanRefusal,
  parseBotMessage,
  positionsKeyboard,
  type ChatSnapshot,
  type EpStatePayout,
  type EpStateWrap
} from "../src/singleSide/twoSided/creditCollar/epBot";

const NOW = 1_800_000_000_000;

// ── Admin auth ────────────────────────────────────────────────────────────────

test("admin auth: fail-closed without a token; dev mode is explicit", () => {
  const off = parseAdminAuthFromEnv({});
  assert.equal(off.enabled, false);
  assert.equal(adminAuthorized(off, {}, null), false);
  const dev = parseAdminAuthFromEnv({ EP_DEV_NO_ADMIN: "true" });
  assert.equal(adminAuthorized(dev, {}, null), true);
});

test("admin auth: bearer, header, and query token all accepted; wrong token refused", () => {
  const auth = parseAdminAuthFromEnv({ EP_ADMIN_TOKEN: "s3cret" });
  assert.equal(adminAuthorized(auth, { authorization: "Bearer s3cret" }, null), true);
  assert.equal(adminAuthorized(auth, { "x-admin-token": "s3cret" }, null), true);
  assert.equal(adminAuthorized(auth, {}, "s3cret"), true);
  assert.equal(adminAuthorized(auth, { authorization: "Bearer wrong" }, null), false);
  assert.equal(adminAuthorized(auth, {}, null), false);
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

test("rate limiter: allows the burst, refuses past it, refills with time, isolates keys", () => {
  const rl = tokenBucketLimiter(3, 60_000);
  assert.equal(rl.allow("ip1", NOW), true);
  assert.equal(rl.allow("ip1", NOW), true);
  assert.equal(rl.allow("ip1", NOW), true);
  assert.equal(rl.allow("ip1", NOW), false); // burst spent
  assert.equal(rl.allow("ip2", NOW), true); // other key unaffected
  assert.equal(rl.allow("ip1", NOW + 20_000), true); // 1/3 window refills one token
  assert.equal(rl.allow("ip1", NOW + 20_001), false);
});

// ── Alerts ────────────────────────────────────────────────────────────────────

test("alerts: fan out to disk + webhook, dedupe repeats inside the window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-alerts-"));
  const calls: string[] = [];
  const fakeFetch = (async (url: unknown) => {
    calls.push(String(url));
    return { ok: true } as Response;
  }) as unknown as typeof fetch;
  const raise = buildAlertRaiser(
    { path: join(dir, "alerts.jsonl"), webhookUrl: "https://hook.example/x", telegram: { botToken: "t", chatId: "c" }, dedupeMs: 600_000 },
    fakeFetch
  );
  raise("payout_failed", "1 payout send(s) failed");
  raise("payout_failed", "1 payout send(s) failed"); // duplicate — suppressed
  raise("loop_stalled", "renewal loop has not run"); // different kind — sent
  await new Promise((r) => setTimeout(r, 20)); // fire-and-forget fetches
  // 2 alerts × (webhook + telegram) = 4 calls
  assert.equal(calls.length, 4);
  assert.ok(calls.some((u) => u.includes("hook.example")));
  assert.ok(calls.some((u) => u.includes("api.telegram.org")));
});

test("alerts: env parsing — no webhook/telegram unless configured", () => {
  const cfg = parseAlertSinkFromEnv({});
  assert.equal(cfg.webhookUrl, null);
  assert.equal(cfg.telegram, null);
  const full = parseAlertSinkFromEnv({ ALERT_WEBHOOK_URL: "https://h", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ALERT_CHAT_ID: "c" });
  assert.equal(full.webhookUrl, "https://h");
  assert.deepEqual(full.telegram, { botToken: "t", chatId: "c" });
});

// ── Loop watchdog ─────────────────────────────────────────────────────────────

test("watchdog: flags loops that missed 5× their interval; never-started loops don't false-alarm", () => {
  const pulses = [
    { name: "renewal", lastRunMs: NOW - 400_000, intervalMs: 60_000 }, // stalled (>5×60s)
    { name: "monitor", lastRunMs: NOW - 20_000, intervalMs: 15_000 }, // fine
    { name: "payout", lastRunMs: 0, intervalMs: 60_000 } // not started yet — boot, not a stall
  ];
  const stalled = stalledLoops(pulses, NOW);
  assert.deepEqual(stalled.map((p) => p.name), ["renewal"]);
});

// ── Bot: command parsing + keyboards ──────────────────────────────────────────

test("bot: parses commands and addresses; anything else is unknown (never guess)", () => {
  assert.deepEqual(parseBotMessage("/start"), { kind: "start" });
  assert.deepEqual(parseBotMessage("/positions"), { kind: "positions" });
  assert.deepEqual(parseBotMessage("/status"), { kind: "status" });
  const addr = "0x" + "ab".repeat(20);
  assert.deepEqual(parseBotMessage(` ${addr} `), { kind: "address", address: addr });
  assert.equal(parseBotMessage("wen lambo").kind, "unknown");
  assert.equal(parseBotMessage("0x123").kind, "unknown"); // not a full address
});

test("bot: keyboard — protect button when off, unprotect when on, only wrappable coins", () => {
  const positions = [
    { coin: "BTC", side: "short", szBase: 0.05, notionalUsdc: 3_580, wrappable: true },
    { coin: "ETH", side: "long", szBase: 1, notionalUsdc: 3_000, wrappable: false }
  ];
  const off = positionsKeyboard(positions, false);
  assert.equal(off.length, 1); // ETH filtered
  assert.match(off[0][0].text, /Earn & Protect SHORT 0\.05 BTC/);
  assert.equal(off[0][0].callback_data, "wrap");
  const on = positionsKeyboard(positions, true);
  assert.match(on[0][0].text, /Unprotect/);
  assert.equal(on[0][0].callback_data, "close");
});

test("bot: refusal copy stays human", () => {
  assert.equal(humanRefusal("wrap refused: the founding cohort (50 wallets) is full — you're on the waitlist"), "Founding cohort full · you're on the waitlist");
  assert.equal(humanRefusal("listed_credit_nonpositive — call bid under put ask"), "No honest credit right now · nothing opened");
  assert.equal(humanRefusal("cap strike $65500 already carries…strike_concentration"), "That strike is crowded · try again shortly");
});

// ── Bot: cycle-event differ (the notification engine) ─────────────────────────

const activeWrap = (id: string, status: string, over: Partial<EpStateWrap> = {}): EpStateWrap => ({
  id,
  status,
  quote: { creditUsdc: 0.16, floorStrike: 67_500, capStrike: 63_250, putStrike: 63_250, callStrike: 67_500 },
  ...over
});

test("bot notify: first poll announces NOTHING (connecting must not replay history)", () => {
  const wraps = [activeWrap("w-1", "active")];
  const payouts: EpStatePayout[] = [{ id: "w-0", amountUsdc: 0.1, reason: "expiry", status: "confirmed", txHash: "sim-w-0" }];
  const { events, next } = diffCycleEvents(null, wraps, payouts);
  assert.deepEqual(events, []);
  assert.deepEqual(next.announcedPayoutIds, ["w-0"]); // pre-existing payouts marked as seen
});

test("bot notify: knockout, renewal, payout, and refusal each produce one honest push", () => {
  let snap: ChatSnapshot = { wrapStatuses: { "w-1": "active" }, announcedPayoutIds: [] };

  // knockout + payout land together
  const knocked = [
    activeWrap("w-1", "knocked_out", {
      knockout: { capStrike: 63_250, markPx: 63_240 },
      vestingStatus: { vestedUsdc: 0.08, fullCreditUsdc: 0.16, fullyVested: false }
    })
  ];
  const paid: EpStatePayout[] = [{ id: "w-1", amountUsdc: 0.08, reason: "knockout", status: "confirmed", txHash: "sim-w-1" }];
  const r1 = diffCycleEvents(snap, knocked, paid);
  assert.equal(r1.events.length, 2);
  assert.match(r1.events[0], /Cap \$63250 touched at \$63240 .* keep every gain to the cap plus \$0\.08 vested credit/);
  assert.match(r1.events[1], /Credit paid: \$0\.08 \(knockout\)/);
  snap = r1.next;

  // re-arm (auto-renewal) — new wrap id appears active with the renewal stage note
  const renewed = [...knocked, activeWrap("w-2", "active", { stages: [{ stage: "wrap_requested", note: "auto-renewal — protection stayed on through expiry" }] })];
  const r2 = diffCycleEvents(snap, renewed, paid);
  assert.equal(r2.events.length, 1);
  assert.match(r2.events[0], /🔄 Renewed — floor \$67500 \/ cap \$63250 · credit \$0\.16/);
  snap = r2.next;

  // repeat poll: silence (announce-once)
  const r3 = diffCycleEvents(snap, renewed, paid);
  assert.deepEqual(r3.events, []);
  snap = r3.next;

  // a renewal refusal pushes the honest reason
  const refused = [...renewed.slice(0, 1), { ...renewed[1] }, activeWrap("w-3", "failed", { failReason: "wrap refused: listed_credit_nonpositive — book can't fund" })];
  // w-3 transitions from unseen…  first make it known as quoting, then failed
  snap = diffCycleEvents(snap, [...renewed, activeWrap("w-3", "quoting")], paid).next;
  const r4 = diffCycleEvents(snap, refused, paid);
  assert.equal(r4.events.length, 1);
  assert.match(r4.events[0], /🚫 No honest credit right now/);
});

test("bot notify: natural expiry announces the full credit; early close the kept share", () => {
  const snap: ChatSnapshot = { wrapStatuses: { "w-1": "active", "w-2": "active" }, announcedPayoutIds: [] };
  const wraps = [
    activeWrap("w-1", "concluded", { vestingStatus: { vestedUsdc: 0.16, fullCreditUsdc: 0.16, fullyVested: true } }),
    activeWrap("w-2", "concluded", { vestingStatus: { vestedUsdc: 0.05, fullCreditUsdc: 0.16, fullyVested: false } })
  ];
  const { events } = diffCycleEvents(snap, wraps, []);
  assert.equal(events.length, 2);
  assert.match(events[0], /✅ Cycle complete — \$0\.16 earned in full/);
  assert.match(events[1], /✋ Closed early — kept \$0\.05 of \$0\.16/);
});
