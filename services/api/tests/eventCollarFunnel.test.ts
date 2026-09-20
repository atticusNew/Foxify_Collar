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
  tier: "balanced",
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
  assert.deepEqual(f.protectsByTier, { balanced: 1, unknown: 1 });
  assert.equal(f.recentProtects.length, 2);
  const first = f.recentProtects[0];
  assert.equal(first.tier, "balanced");
  assert.equal(f.recentProtects[1].tier, null);
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

test("board budget: next week's slate is skipped before it burns match attempts", async () => {
  const { gameDateWithinHorizon } = await import("../scripts/eventProtectXDemoService");
  const { templateForSeries } = await import("../src/eventCollar/crossVenue/resolutionWhitelist");
  const nfl = templateForSeries("KXNFLGAME")!;
  const now = new Date("2026-09-18T19:00:00Z");
  assert.equal(gameDateWithinHorizon("KXNFLGAME-26SEP20INDKC-KC", nfl, now), true, "this Sunday");
  assert.equal(gameDateWithinHorizon("KXNFLGAME-26SEP24ATLGB-GB", nfl, now), true, "Thursday night, day 6");
  assert.equal(gameDateWithinHorizon("KXNFLGAME-26SEP27LVNO-NO", nfl, now), false, "next Sunday, day 9");
  assert.equal(gameDateWithinHorizon("KXNFLGAME-26SEP18XXYY-XX", nfl, now), true, "unparseable teams pass through to the matcher");
  assert.equal(gameDateWithinHorizon("KXNFLGAME-26SEP10INDKC-KC", nfl, now), false, "already played");
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
    assert.equal((await fetch(`${base}/board`)).status, 200);
    assert.equal((await fetch(`${base}/board`)).status, 200);
    assert.equal((await fetch(`${base}/receipts`)).status, 200);

    // the page carries the beacon and fires it on the one-tap interactions
    const html = await (await fetch(`${base}/board`)).text();
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

    // readable page: same gate, renders the same numbers, never leaks the token into script
    assert.equal((await fetch(`${base}/admin/funnel`)).status, 403);
    const pageRes = await fetch(`${base}/admin/funnel?token=t0ken`);
    assert.equal(pageRes.status, 200);
    assert.match(pageRes.headers.get("content-type") ?? "", /text\/html/);
    const page = await pageRes.text();
    assert.ok(page.includes("Who looked, who tapped, who protected"));
    assert.ok(page.includes("KXNFLGAME-26SEP20INDKC-KC"), "recent Protect taps are listed");
    assert.ok(page.includes('href="/api/admin/funnel?token=t0ken"'), "links the raw JSON with the same token");
    assert.ok(page.includes("'/api/admin/funnel/reset'+location.search"), "reset reuses the URL token, not an inlined one");
    const rawJson = await (await fetch(`${base}/api/admin/funnel?token=t0ken`)).text();
    assert.ok(rawJson.includes("\n  \"funnel\": {"), "JSON is pretty-printed for a browser tab");

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

test("demo service: /api/showcase is retail without the token and the operator's full payload with it", async () => {
  const { server, primeScanForTests } = await import("../scripts/eventProtectXDemoService");
  const { forbiddenKeysIn } = await import("../src/eventCollar/retailShowcase");
  primeScanForTests({ atIso: "2026-09-20T18:00:00.000Z", rows: [], fallback: null, fetchFailures: 1 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const retail = (await (await fetch(`${base}/api/showcase`)).json()) as Record<string, unknown>;
    assert.equal(retail.retail, true);
    assert.deepEqual(Object.keys(retail).sort(), ["at", "board", "error", "ok", "pair", "position", "quote", "retail"]);
    assert.equal(retail.error, "Live pricing is unavailable right now; retrying.");
    assert.deepEqual(forbiddenKeysIn(retail), []);

    const operator = (await (await fetch(`${base}/api/showcase?token=t0ken`)).json()) as Record<string, unknown>;
    assert.equal(operator.retail, undefined);
    assert.ok(Array.isArray(operator.routesChecked), "the operator payload keeps the routes");
    assert.match(String(operator.error), /PM_CLOB_REST_BASE/, "and the raw reason with its relay hint");

    const wrong = (await (await fetch(`${base}/api/showcase?token=nope`)).json()) as Record<string, unknown>;
    assert.equal(wrong.retail, true, "a wrong token is a retail caller, not an error");

    // the receipts JSON follows the same rule: the track record for everyone, our take and the route split for the operator
    const receipts = (await (await fetch(`${base}/api/receipts`)).json()) as Record<string, unknown>;
    assert.equal(receipts.ok, true);
    assert.ok("priced" in receipts && "refused" in receipts && "creditsSourcedCents" in receipts && "refusalsByCode" in receipts);
    assert.ok(!("takeKeptCents" in receipts) && !("routeSplit" in receipts), "take kept and route split stay with the operator");
    const opReceipts = (await (await fetch(`${base}/api/receipts?token=t0ken`)).json()) as Record<string, unknown>;
    assert.ok("takeKeptCents" in opReceipts && "routeSplit" in opReceipts);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("applyEvCeiling: a fundable collar above the EV-cost ceiling becomes an honest refusal; the routes examined keep their verdicts", async () => {
  const { applyEvCeiling, MAX_EV_COST_BPS } = await import("../scripts/eventProtectXDemoService");
  assert.equal(MAX_EV_COST_BPS, 300, "default ceiling: 3% of expected value");
  const quote = { ok: true as const, floorCents: 40, capCents: 88, creditCents: 420, contracts: 150 } as unknown as import("../src/eventCollar/crossVenue/types").CrossQuote;
  const base = {
    kind: "crypto" as const,
    league: "crypto",
    market: { ticker: "KXBTCD-TEST" } as unknown as import("../src/eventCollar/types").KalshiMarket,
    pair: null,
    sideName: "Bitcoin above $115,000",
    eventTitle: "BTC above $115,000",
    eventTimeIso: "2026-09-21T21:00:00.000Z",
    parityNote: "own No side",
    fingerprint: "crypto:KXBTCD-TEST",
    markCents: 48,
    position: { contracts: 150, entryCents: 45, entrySource: "real_print", entryTime: null },
    quote,
    route: "kalshi_self" as const,
    evBps: 472,
    routesChecked: [{ route: "kalshi_self" as const, ok: true, evCostBps: 472, creditCents: 420 }],
    books: {},
  };
  const rich = applyEvCeiling(base);
  assert.equal(rich.quote.ok, false);
  assert.equal(!rich.quote.ok && rich.quote.code, "protection_too_rich");
  assert.match(!rich.quote.ok ? rich.quote.detail : "", /4\.72% of expected value; the ceiling is 3\.00%/);
  assert.equal(rich.route, null);
  assert.equal(rich.evBps, null);
  assert.deepEqual(rich.routesChecked, base.routesChecked, "operator sees the route was fundable, just rich");

  const cheap = { ...base, evBps: 122 };
  assert.strictEqual(applyEvCeiling(cheap), cheap, "under the ceiling: untouched, same object");
  assert.strictEqual(applyEvCeiling({ ...base, evBps: 300 }).quote.ok, true, "at the ceiling: still quoted");
  assert.strictEqual(applyEvCeiling(base, 0).quote.ok, true, "0 disables the ceiling");
  const refusedAlready = { ...base, quote: { ok: false as const, code: "kalshi_book_empty" as const, detail: "no asks" }, route: null, evBps: null };
  assert.strictEqual(applyEvCeiling(refusedAlready).quote, refusedAlready.quote, "a refusal stays the refusal it was");
});

test("protectContextFor: attributes the tier the holder locked, falls back to the row's default", async () => {
  const { protectContextFor } = await import("../scripts/eventProtectXDemoService");
  const { quoteLadderWrap } = await import("../src/eventCollar/crossVenue/kalshiLadder");
  const { DEFAULT_CROSS_CONFIG } = await import("../src/eventCollar/crossVenue/types");
  const start = new Date(T0 + 6 * 3_600_000).toISOString();
  const quote = quoteLadderWrap({
    pair: { kalshi: { ticker: "KXMLBGAME-26SEP18NYYBOS-NYY" }, gameStartTime: start },
    markCents: 60,
    entryCents: 55,
    contracts: 150,
    now: new Date(T0),
    noAsks: [
      { priceCents: 41, qtyMilli: 100_000 },
      { priceCents: 42, qtyMilli: 300_000 },
      { priceCents: 43, qtyMilli: 900_000 },
    ],
    config: DEFAULT_CROSS_CONFIG,
  });
  assert.ok(quote.ok);
  const res = {
    kind: "sports" as const,
    league: "mlb",
    market: { ticker: "KXMLBGAME-26SEP18NYYBOS-NYY" },
    route: "kalshi_self" as const,
    position: { contracts: 150 },
    markCents: 60,
    quote,
  };
  const state = { atIso: new Date(T0).toISOString(), rows: [{ res, evBps: quote.evCostBps }], fallback: null, fetchFailures: 0 };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = state as any;

  const wide = protectContextFor(res.market.ticker, "wide", s);
  assert.ok(wide);
  assert.equal(wide.tier, "wide");
  assert.equal(wide.floorCents, quote.tiers.wide?.floorCents);
  assert.equal(wide.creditCents, quote.tiers.wide?.creditCents);
  assert.equal(wide.evCostBps, quote.tiers.wide?.evCostBps);

  const dflt = protectContextFor(res.market.ticker, undefined, s);
  assert.ok(dflt);
  assert.equal(dflt.tier, quote.tier);
  assert.equal(dflt.floorCents, quote.floorCents);

  // an unknown tier name from the browser cannot invent terms: the default is attributed
  const bogus = protectContextFor(res.market.ticker, "platinum", s);
  assert.ok(bogus);
  assert.equal(bogus.tier, quote.tier);
  assert.equal(bogus.creditCents, quote.creditCents);

  assert.equal(protectContextFor("KXMLBGAME-ROLLED-OFF", "wide", s), null);
  assert.equal(protectContextFor(res.market.ticker, "wide", null), null);
});
