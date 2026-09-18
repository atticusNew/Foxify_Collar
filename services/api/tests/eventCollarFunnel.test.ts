/**
 * Event demo funnel: pure counters, validation, admin gate, per-league board
 * budget, and the /api/metrics + /api/admin/funnel HTTP surface.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  MAX_RECENT_PROTECTS,
  MAX_SESSIONS,
  adminAuthorized,
  coerceEventFunnel,
  emptyEventFunnel,
  eventFunnelSummary,
  isValidSid,
  isValidTicker,
  parseAdminAuthFromEnv,
  recordAction,
  recordPageLoad,
  tokenBucketLimiter,
  type ProtectContext,
} from "../src/eventCollar/crossVenue/eventFunnel";

// The demo service reads its env once at import; set it before any test imports it.
const TMP_DIR = mkdtempSync(join(tmpdir(), "event-funnel-"));
const FUNNEL_PATH = join(TMP_DIR, "nested", "funnel.json");
process.env.NODE_ENV = "test";
process.env.EVENT_X_FUNNEL_PATH = FUNNEL_PATH;
process.env.EVENT_X_ADMIN_TOKEN = "t0ken";
process.env.EVENT_X_LEDGER_PATH = join(TMP_DIR, "ledger.jsonl");

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 18, 12, 0, 0);
const SID = "abc123def456";
const CTX: ProtectContext = {
  league: "nfl",
  kind: "sports",
  route: "polymarket",
  creditCents: 1234,
  contracts: 150,
  markCents: 58,
  floorCents: 40,
  capCents: 80,
  evCostBps: -37.4,
};

test("funnel: sid and ticker validation", () => {
  assert.equal(isValidSid("abcdefgh"), true);
  assert.equal(isValidSid("ABCDEFGH"), false, "uppercase rejected: the page only emits [a-z0-9]");
  assert.equal(isValidSid("short"), false);
  assert.equal(isValidSid("a".repeat(33)), false);
  assert.equal(isValidSid(42), false);
  assert.equal(isValidTicker("KXNFLGAME-26SEP20INDKC-KC"), true);
  assert.equal(isValidTicker("KXBTCD-26SEP1817-T80999.99"), true);
  assert.equal(isValidTicker("<script>"), false);
  assert.equal(isValidTicker("x".repeat(100)), false);
});

test("funnel: page loads bucket by UTC day and prune past retention", () => {
  const f = emptyEventFunnel();
  recordPageLoad(f, "app", T0);
  recordPageLoad(f, "app", T0 + 1000);
  recordPageLoad(f, "receipts", T0);
  recordPageLoad(f, "app", T0 - 45 * DAY);
  assert.deepEqual(f.pageLoads["2026-09-18"], { app: 2, receipts: 1 });
  // the 45-day-old bucket was written, then pruned by the next write
  recordPageLoad(f, "app", T0 + 2000);
  assert.equal(Object.keys(f.pageLoads).length, 1);
});

test("funnel: actions reject bad input without writing", () => {
  const f = emptyEventFunnel();
  assert.equal(recordAction(f, { sid: "BAD", action: "row_tap", ticker: "X" }, T0), false);
  assert.equal(recordAction(f, { sid: SID, action: "row_tap", ticker: "<b>" }, T0), false);
  assert.deepEqual(f.actions, {});
  assert.deepEqual(f.sessions, {});
});

test("funnel: protect taps are attributed from the server context, never the client", () => {
  const f = emptyEventFunnel();
  assert.equal(recordAction(f, { sid: SID, action: "row_tap", ticker: "KXNFLGAME-26SEP20INDKC-KC" }, T0), true);
  assert.equal(recordAction(f, { sid: SID, action: "protect_on", ticker: "KXNFLGAME-26SEP20INDKC-KC" }, T0 + 5000, CTX), true);
  // a tap on a row that already rolled off the board still counts, unattributed
  assert.equal(recordAction(f, { sid: "zzzzzzzz", action: "protect_on", ticker: "KXMLBGAME-OLD" }, T0 + 9000, null), true);

  assert.deepEqual(f.protectsByLeague, { nfl: 1, unknown: 1 });
  assert.deepEqual(f.protectsByRoute, { polymarket: 1, unknown: 1 });
  assert.equal(f.recentProtects.length, 2);
  const first = f.recentProtects[0];
  assert.equal(first.creditCents, 1234);
  assert.equal(first.contracts, 150);
  assert.equal(first.evCostBps, -37, "bps stored as an integer");
  assert.equal(f.recentProtects[1].creditCents, null);
  assert.equal(f.sessions[SID].taps, 1);
  assert.equal(f.sessions[SID].protects, 1);
  assert.deepEqual(f.actions["2026-09-18"], { row_tap: 1, protect_on: 2 });
});

test("funnel: summary separates reach, taps, and conversion", () => {
  const f = emptyEventFunnel();
  recordPageLoad(f, "app", T0 - 3 * DAY);
  recordPageLoad(f, "app", T0);
  recordAction(f, { sid: "protect1", action: "protect_on", ticker: "C" }, T0 - 10 * DAY, { ...CTX, league: "mlb", route: "kalshi_self" });
  recordAction(f, { sid: "tapper00", action: "row_tap", ticker: "A" }, T0 - 2 * DAY);
  recordAction(f, { sid: "protect0", action: "row_tap", ticker: "B" }, T0 - 3600_000);
  recordAction(f, { sid: "protect0", action: "protect_on", ticker: "B" }, T0 - 3500_000, CTX);
  recordAction(f, { sid: "expandr0", action: "board_expand" }, T0);

  const s = eventFunnelSummary(f, T0);
  assert.equal(s.sessions.distinct, 4);
  assert.equal(s.sessions.active24h, 2, "protect0 and expandr0");
  assert.equal(s.sessions.active7d, 3);
  assert.equal(s.sessions.protected, 2);
  assert.equal(s.sessions.tappedNeverProtected, 1, "tapper00 looked and left");
  assert.equal(s.protects.total, 2);
  assert.equal(s.protects.last24h, 1);
  assert.equal(s.protects.last7d, 1);
  assert.deepEqual(s.protects.byLeague, { nfl: 1, mlb: 1 });
  assert.deepEqual(s.protects.byRoute, { polymarket: 1, kalshi_self: 1 });
  assert.equal(s.protects.creditCentsTotal, 2468);
  assert.equal(s.protects.contractsTotal, 300);
  assert.equal(s.recentProtects[0].sid, "protect0", "newest first");
  assert.equal(s.pageLoads7d.length, 7);
  assert.equal(s.pageLoads7d[6].day, "2026-09-18");
  assert.equal(s.pageLoads7d[6].byPage.app, 1);
  assert.equal(s.pageLoads7d[3].byPage.app, 1);
  assert.equal(s.actions7d[6].byAction.board_expand, 1);
});

test("funnel: session and recent-protect tables stay bounded", () => {
  const f = emptyEventFunnel();
  for (let i = 0; i < MAX_SESSIONS + 50; i++) {
    recordAction(f, { sid: `s${String(i).padStart(9, "0")}`, action: "board_expand" }, T0 + i);
  }
  assert.equal(Object.keys(f.sessions).length, MAX_SESSIONS);
  assert.equal(f.sessions["s000000000"], undefined, "the oldest was evicted");
  assert.ok(f.sessions[`s${String(MAX_SESSIONS + 49).padStart(9, "0")}`]);

  for (let i = 0; i < MAX_RECENT_PROTECTS + 10; i++) {
    recordAction(f, { sid: SID, action: "protect_on", ticker: `T${i}` }, T0 + i, CTX);
  }
  assert.equal(f.recentProtects.length, MAX_RECENT_PROTECTS);
  assert.equal(f.recentProtects[0].ticker, "T10");
  assert.equal(f.protectsByLeague.nfl, MAX_RECENT_PROTECTS + 10, "lifetime totals are not capped");
});

test("funnel: coerce tolerates garbage and partial files", () => {
  assert.deepEqual(coerceEventFunnel(null), emptyEventFunnel());
  assert.deepEqual(coerceEventFunnel("junk"), emptyEventFunnel());
  const partial = coerceEventFunnel({ pageLoads: { "2026-09-18": { app: 3 } }, recentProtects: "nope" });
  assert.deepEqual(partial.pageLoads, { "2026-09-18": { app: 3 } });
  assert.deepEqual(partial.recentProtects, []);
  assert.deepEqual(partial.sessions, {});
});

test("funnel: admin auth fails closed without a token; accepts bearer, header, or query", () => {
  const off = parseAdminAuthFromEnv({});
  assert.equal(off.enabled, false);
  assert.equal(adminAuthorized(off, {}, "anything"), false);
  const dev = parseAdminAuthFromEnv({ EVENT_X_DEV_NO_ADMIN: "true" });
  assert.equal(adminAuthorized(dev, {}, null), true);
  const on = parseAdminAuthFromEnv({ EVENT_X_ADMIN_TOKEN: " s3cret " });
  assert.equal(on.token, "s3cret");
  assert.equal(adminAuthorized(on, {}, null), false);
  assert.equal(adminAuthorized(on, {}, "s3cret"), true);
  assert.equal(adminAuthorized(on, { authorization: "Bearer s3cret" }, null), true);
  assert.equal(adminAuthorized(on, { "x-admin-token": "s3cret" }, null), true);
  assert.equal(adminAuthorized(on, { "x-admin-token": "wrong" }, null), false);
});

test("funnel: token bucket refills over time", () => {
  const lim = tokenBucketLimiter(3, 60_000);
  assert.equal(lim.allow("ip", T0), true);
  assert.equal(lim.allow("ip", T0), true);
  assert.equal(lim.allow("ip", T0), true);
  assert.equal(lim.allow("ip", T0), false);
  assert.equal(lim.allow("other", T0), true, "buckets are per key");
  assert.equal(lim.allow("ip", T0 + 20_001), true, "a third of the window refills one token");
  assert.equal(lim.allow("ip", T0 + 20_001), false);
});

test("board budget: rows split evenly across leagues with games on", async () => {
  const { leagueRowQuota } = await import("../scripts/eventProtectXDemoService");
  assert.equal(leagueRowQuota(0, 6), 0);
  assert.equal(leagueRowQuota(1, 6), 6, "one league in season keeps the whole board");
  assert.equal(leagueRowQuota(2, 6), 3, "MLB + NFL: three each");
  assert.equal(leagueRowQuota(3, 6), 2);
  assert.equal(leagueRowQuota(4, 6), 2, "rounds up so the board is never short by construction");
  assert.equal(leagueRowQuota(7, 6), 1);
});

test("demo service: page loads count, beacons record, admin funnel is gated and persists", async () => {
  const funnelPath = FUNNEL_PATH;
  const { server, flushFunnel } = await import("../scripts/eventProtectXDemoService");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/metrics`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "text/plain", "x-forwarded-for": "203.0.113.7", ...headers },
    });
  try {
    // reach: the board page and the receipts page are counted when served
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/receipts`)).status, 200);

    // the page carries the beacon and fires it on the one-tap interactions
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(html.includes("'/api/metrics'"), "page posts beacons to /api/metrics");
    assert.ok(html.includes("track('protect_on'"), "Protect toggle is tracked");
    assert.ok(html.includes("track('row_tap'"), "board taps are tracked");
    assert.ok(html.includes("track('protect_undo'"), "undo is tracked");
    assert.ok(html.includes("sessionStorage"), "session id lives in sessionStorage only");

    // beacons: sendBeacon posts as a Blob, so content-type is not application/json
    assert.equal((await post({ sid: "s1s1s1s1", action: "row_tap", ticker: "KXNFLGAME-26SEP20INDKC-KC" })).status, 204);
    assert.equal((await post({ sid: "s1s1s1s1", action: "protect_on", ticker: "KXNFLGAME-26SEP20INDKC-KC" })).status, 204);
    assert.equal((await post({ sid: "s2s2s2s2", action: "board_expand" })).status, 204);
    assert.equal((await post({ sid: "nope", action: "row_tap", ticker: "X" })).status, 400);
    assert.equal((await post({ sid: "s1s1s1s1", action: "buy_everything" })).status, 400);
    assert.equal((await post("not json")).status, 400);
    assert.equal((await post({ sid: "s1s1s1s1", action: "row_tap", ticker: "x".repeat(3000) })).status, 413);
    assert.equal((await fetch(`${base}/api/metrics`)).status, 404, "GET is not a beacon");

    // admin gate
    assert.equal((await fetch(`${base}/api/admin/funnel`)).status, 403);
    assert.equal((await fetch(`${base}/api/admin/funnel?token=wrong`)).status, 403);
    const ok = await fetch(`${base}/api/admin/funnel`, { headers: { "x-admin-token": "t0ken" } });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as {
      funnelPath: string;
      funnel: ReturnType<typeof eventFunnelSummary>;
    };
    assert.equal(body.funnelPath, funnelPath);
    const today = new Date().toISOString().slice(0, 10);
    const todayLoads = body.funnel.pageLoads7d.find((d) => d.day === today);
    assert.deepEqual(todayLoads?.byPage, { app: 3, receipts: 1 });
    assert.equal(body.funnel.sessions.distinct, 2);
    assert.equal(body.funnel.sessions.protected, 1);
    assert.equal(body.funnel.protects.total, 1);
    // no scan has run in the test, so the tap is recorded but unattributed
    assert.deepEqual(body.funnel.protects.byLeague, { unknown: 1 });
    assert.equal(body.funnel.recentProtects[0].ticker, "KXNFLGAME-26SEP20INDKC-KC");
    assert.equal(body.funnel.recentProtects[0].creditCents, null);

    // persistence: flush writes the file (creating the directory), reset clears it
    assert.equal(existsSync(funnelPath), false);
    flushFunnel();
    const onDisk = JSON.parse(readFileSync(funnelPath, "utf8")) as { sessions: Record<string, unknown> };
    assert.equal(Object.keys(onDisk.sessions).length, 2);

    const reset = await fetch(`${base}/api/admin/funnel/reset?token=t0ken`, { method: "POST" });
    assert.equal(reset.status, 200);
    const after = (await (await fetch(`${base}/api/admin/funnel?token=t0ken`)).json()) as {
      funnel: ReturnType<typeof eventFunnelSummary>;
    };
    assert.equal(after.funnel.sessions.distinct, 0);
    assert.equal(after.funnel.protects.total, 0);
    const cleared = JSON.parse(readFileSync(funnelPath, "utf8")) as { sessions: Record<string, unknown> };
    assert.deepEqual(cleared.sessions, {});

    // rate limit: the beacon budget is per IP
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const r = await post({ sid: "s3s3s3s3", action: "board_expand" }, { "x-forwarded-for": "198.51.100.9" });
      if (r.status === 429) limited += 1;
    }
    assert.ok(limited >= 10, `expected the 30/min bucket to trip, got ${limited} rejections`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
