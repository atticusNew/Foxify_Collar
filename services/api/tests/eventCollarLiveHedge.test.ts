/**
 * Live hedge — a real order on Kalshi behind rails. Every rail is exercised,
 * dry run is the default, the order client is driven by fixture responses,
 * and every decision lands on the receipt. Nothing touches the network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendHedgeReceipt,
  intentFromHedge,
  loadHedgeReceipts,
  summarizeHedgeReceipts,
  type ExecutorClock,
  type HedgeIntent,
  type HedgeReceipt,
} from "../src/eventCollar/crossVenue/hedgeExecutor";
import { hedgeExecutorFromEnv } from "../src/eventCollar/crossVenue/hedgeExecutorFromEnv";
import { KalshiOrderClient, fillOfOrder } from "../src/eventCollar/crossVenue/kalshiOrders";
import {
  DEFAULT_LIVE_RAILS,
  LiveHedgeExecutor,
  checkRails,
  describeOrder,
  liveRailsFromEnv,
  sentUnitsMilliOn,
  type LiveHedgeRails,
  type LiveOrderHook,
  type LiveOrderResult,
} from "../src/eventCollar/crossVenue/liveHedge";
import type { CrossHedgeLeg, KalshiSelfHedgeLeg } from "../src/eventCollar/crossVenue/types";

function fakeClock(startMs = Date.parse("2026-10-14T12:00:00.000Z")): ExecutorClock & { ms: number } {
  const c = {
    ms: startMs,
    now: () => new Date(c.ms),
    sleep: async (ms: number) => {
      c.ms += ms;
    },
  };
  return c;
}

/** 20 No at 40c, 42c walked; the demo size. */
const KALSHI_LEG: KalshiSelfHedgeLeg = {
  action: "buy",
  venue: "kalshi",
  outcome: "No",
  ticker: "KXNBAGAME-26OCT14LALBOS-BOS",
  contractsMilli: 20_000,
  avgPriceCents: 41,
  worstPriceCents: 42,
  costCents: 826, // 20 x 41c + fees
};

const PM_LEG: CrossHedgeLeg = {
  action: "buy",
  venue: "polymarket",
  outcome: "Lakers",
  tokenId: "7123",
  sharesMilli: 20_000,
  avgPriceMilli: 415,
  worstPriceMilli: 430,
  costCents: 830,
};

const OPEN_RAILS: LiveHedgeRails = {
  killSwitch: false,
  dryRun: false,
  allowlist: ["KXNBAGAME-26OCT14LALBOS-BOS"],
  maxUnitsPerOrderMilli: 25_000,
  maxUnitsPerDayMilli: 100_000,
};

const okHook =
  (overrides: Partial<LiveOrderResult> = {}): LiveOrderHook =>
  async (intent) => ({
    orderId: "ord-1",
    unitsMilli: intent.unitsMilli,
    avgPriceMilli: 405,
    costCents: 810,
    feesCents: 7,
    status: "executed",
    ...overrides,
  });

test("rails from env: dry run and an empty allowlist by default; the one setting that sends is spelled out", () => {
  const d = liveRailsFromEnv({});
  assert.deepEqual(d, DEFAULT_LIVE_RAILS);
  assert.equal(d.dryRun, true);
  assert.deepEqual(d.allowlist, []);

  const armed = liveRailsFromEnv({
    EVENT_HEDGE_LIVE_SEND: "yes",
    EVENT_HEDGE_LIVE_TICKERS: " kxnbagame-26oct14lalbos-bos, KXNFL-X ,,kxnbagame-26oct14lalbos-bos",
    EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_ORDER: "20",
    EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_DAY: "60",
  });
  assert.equal(armed.dryRun, false);
  assert.deepEqual(armed.allowlist, ["KXNBAGAME-26OCT14LALBOS-BOS", "KXNFL-X"], "upper-cased, trimmed, de-duplicated");
  assert.equal(armed.maxUnitsPerOrderMilli, 20_000);
  assert.equal(armed.maxUnitsPerDayMilli, 60_000);

  assert.equal(liveRailsFromEnv({ EVENT_HEDGE_LIVE_SEND: "true" }).dryRun, true, "only the word yes sends");
  assert.equal(liveRailsFromEnv({ EVENT_HEDGE_LIVE_SEND: "1" }).dryRun, true);
  assert.equal(liveRailsFromEnv({ EVENT_HEDGE_KILL_SWITCH: "1" }).killSwitch, true);
  assert.equal(liveRailsFromEnv({ EVENT_HEDGE_KILL_SWITCH: "off" }).killSwitch, false);
  assert.equal(liveRailsFromEnv({ EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_ORDER: "0" }).maxUnitsPerOrderMilli, 25_000, "a zero or junk cap falls back to the default");
  assert.equal(liveRailsFromEnv({ EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_DAY: "lots" }).maxUnitsPerDayMilli, 100_000);
});

test("checkRails: kill switch, venue, ticker, per-order and per-day caps, in that order; a clean intent passes", () => {
  const k = intentFromHedge(KALSHI_LEG, 400);
  assert.equal(checkRails(k, OPEN_RAILS, 0, true), null);
  assert.equal(checkRails(k, { ...OPEN_RAILS, killSwitch: true }, 0, true)?.rail, "kill_switch");
  assert.equal(checkRails(k, OPEN_RAILS, 0, false)?.rail, "venue");
  assert.equal(checkRails(k, { ...OPEN_RAILS, allowlist: [] }, 0, true)?.rail, "ticker");
  assert.equal(checkRails(k, { ...OPEN_RAILS, allowlist: ["KXNFL-X"] }, 0, true)?.rail, "ticker");
  assert.equal(checkRails(k, { ...OPEN_RAILS, maxUnitsPerOrderMilli: 19_000 }, 0, true)?.rail, "per_order");
  assert.equal(checkRails(k, OPEN_RAILS, 80_001, true)?.rail, "per_day", "80.001 sent + 20 would pass 100");
  assert.equal(checkRails(k, OPEN_RAILS, 80_000, true), null, "exactly at the cap is allowed");
  const p = intentFromHedge(PM_LEG, 415);
  assert.equal(checkRails(p, { ...OPEN_RAILS, allowlist: ["7123"] }, 0, false)?.rail, "venue", "no live client for polymarket");
  assert.match(describeOrder(k), /kalshi buy 20 No on KXNBAGAME-26OCT14LALBOS-BOS at or under 42c, immediate or cancel/);
});

test("live executor: dry run builds the order, records it, sends nothing, and the shadow's simulated fill stands", async () => {
  const clock = fakeClock();
  let calls = 0;
  const hook: LiveOrderHook = async () => {
    calls += 1;
    throw new Error("must not be called");
  };
  const ex = new LiveHedgeExecutor({ kalshi: hook }, { ...OPEN_RAILS, dryRun: true }, () => 0, clock);
  const r = await ex.execute(intentFromHedge(KALSHI_LEG, 400), "KXNBAGAME-26OCT14LALBOS-BOS");
  assert.equal(calls, 0);
  assert.equal(r.outcome, "filled_book");
  assert.equal(r.fallbackReason, "dry run");
  assert.equal(r.fill?.simulated, true);
  assert.equal(r.fill?.costCents, 826, "the shadow's number is the quoted walk");
  assert.deepEqual(
    r.attempts.map((a) => [a.strategy, a.step, a.ok]),
    [
      ["live", "rails", true],
      ["live", "dry_run", true],
      ["book", "fill", true],
    ],
  );
  const dry = r.attempts[1];
  assert.equal(dry.strategy, "live");
  assert.match(dry.detail, /dry run: kalshi buy 20 No .* at or under 42c, immediate or cancel; not sent/);
  assert.equal(dry.strategy === "live" ? dry.unitsMilli : -1, 20_000);
});

test("live executor: a refused rail is on the receipt by name and the hedge is simulated, never sent", async () => {
  const clock = fakeClock();
  let calls = 0;
  const hook: LiveOrderHook = async () => {
    calls += 1;
    return okHook()(intentFromHedge(KALSHI_LEG, 400), "x");
  };
  const cases: Array<[LiveHedgeRails, number, string]> = [
    [{ ...OPEN_RAILS, killSwitch: true }, 0, "kill_switch"],
    [{ ...OPEN_RAILS, allowlist: ["OTHER"] }, 0, "ticker"],
    [{ ...OPEN_RAILS, maxUnitsPerOrderMilli: 10_000 }, 0, "per_order"],
    [OPEN_RAILS, 90_000, "per_day"],
  ];
  for (const [rails, sent, rail] of cases) {
    const ex = new LiveHedgeExecutor({ kalshi: hook }, rails, () => sent, clock);
    const r = await ex.execute(intentFromHedge(KALSHI_LEG, 400), "ref");
    assert.equal(r.outcome, "filled_book", rail);
    assert.equal(r.fill?.simulated, true, rail);
    assert.match(r.fallbackReason ?? "", new RegExp(`^rail ${rail}: `), rail);
    const a = r.attempts[0];
    assert.equal(a.strategy, "live");
    assert.equal(a.step, "rails");
    assert.equal(a.ok, false);
    assert.equal(a.strategy === "live" ? a.rail : "", rail);
  }
  assert.equal(calls, 0, "no rail refusal reached the venue");

  // the polymarket leg has no live client: venue rail, simulated at its own walk
  const ex = new LiveHedgeExecutor({ kalshi: hook }, { ...OPEN_RAILS, allowlist: ["7123"] }, () => 0, clock);
  const r = await ex.execute(intentFromHedge(PM_LEG, 415), "ref");
  assert.equal(r.fallbackReason, "rail venue: no live client for polymarket");
  assert.equal(r.fill?.costCents, 830);
});

test("live executor: a sent order fills live with the venue's numbers; a partial is marked; a failure falls back with the reason", async () => {
  const clock = fakeClock();
  const seen: Array<[HedgeIntent, string]> = [];
  const hook: LiveOrderHook = async (intent, clientOrderId) => {
    seen.push([intent, clientOrderId]);
    return okHook()(intent, clientOrderId);
  };
  const ex = new LiveHedgeExecutor({ kalshi: hook }, OPEN_RAILS, () => 40_000, clock);
  const full = await ex.execute(intentFromHedge(KALSHI_LEG, 400), "ref");
  assert.equal(full.outcome, "filled_live");
  assert.equal(full.fallbackReason, null);
  assert.equal(full.fill?.simulated, false);
  assert.equal(full.fill?.strategy, "live");
  assert.equal(full.fill?.costCents, 810);
  assert.equal(full.fill?.vsBookCents, 16, "826 walked, 810 paid");
  assert.deepEqual(full.fill?.ids, { orderId: "ord-1" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1], `atticus-${full.id}`, "the client order id is the receipt id, so the venue's trail and ours line up");
  assert.deepEqual(
    full.attempts.map((a) => [a.strategy, a.step, a.ok]),
    [
      ["live", "rails", true],
      ["live", "order", true],
    ],
  );
  assert.match(full.attempts[0].detail, /20 of 25 per order; 40 of 100 sent today/);

  const partialEx = new LiveHedgeExecutor({ kalshi: okHook({ unitsMilli: 12_000, costCents: 490, status: "canceled" }) }, OPEN_RAILS, () => 0, clock);
  const partial = await partialEx.execute(intentFromHedge(KALSHI_LEG, 400), "ref");
  assert.equal(partial.outcome, "filled_live");
  assert.equal(partial.fill?.unitsMilli, 12_000);
  assert.equal(partial.fill?.vsBookCents, Math.round((826 * 12) / 20) - 490, "against the walk pro rata to what filled");
  assert.match(partial.attempts[1].detail, /12 of 20 filled .*\(partial\)/);

  const failEx = new LiveHedgeExecutor(
    {
      kalshi: async () => {
        throw new Error("kalshi orders: HTTP 400 POST /portfolio/orders insufficient_balance");
      },
    },
    OPEN_RAILS,
    () => 0,
    clock,
  );
  const failed = await failEx.execute(intentFromHedge(KALSHI_LEG, 400), "ref");
  assert.equal(failed.outcome, "filled_book");
  assert.equal(failed.fill?.simulated, true);
  assert.match(failed.fallbackReason ?? "", /^order failed: kalshi orders: HTTP 400/);
  const order = failed.attempts[1];
  assert.equal(order.step, "order");
  assert.equal(order.ok, false);
});

test("the trail: sent units count per UTC day (filled or failed, never dry run); the summary separates refused, held, sent, filled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "live-hedge-"));
  const path = join(dir, "hedge-receipts.jsonl");
  const clock = fakeClock();
  const sentToday = (day: string): number => sentUnitsMilliOn(loadHedgeReceipts(path), day);
  const intent = intentFromHedge(KALSHI_LEG, 400);

  const dry = new LiveHedgeExecutor({ kalshi: okHook() }, { ...OPEN_RAILS, dryRun: true }, sentToday, clock);
  appendHedgeReceipt(path, await dry.execute(intent, "a"));
  assert.equal(sentToday("2026-10-14"), 0, "dry run sends nothing, counts nothing");

  const live = new LiveHedgeExecutor({ kalshi: okHook() }, { ...OPEN_RAILS, maxUnitsPerDayMilli: 50_000 }, sentToday, clock);
  appendHedgeReceipt(path, await live.execute(intent, "b"));
  assert.equal(sentToday("2026-10-14"), 20_000);
  const failing = new LiveHedgeExecutor(
    {
      kalshi: async () => {
        throw new Error("timeout");
      },
    },
    { ...OPEN_RAILS, maxUnitsPerDayMilli: 50_000 },
    sentToday,
    clock,
  );
  appendHedgeReceipt(path, await failing.execute(intent, "c"));
  assert.equal(sentToday("2026-10-14"), 40_000, "a failed send still counts: the venue may have it");
  const third = await live.execute(intent, "d");
  appendHedgeReceipt(path, third);
  assert.equal(third.fallbackReason, "rail per_day: 40 sent today plus 20 would pass the daily cap of 50");
  assert.equal(sentToday("2026-10-14"), 40_000);
  assert.equal(sentToday("2026-10-15"), 0, "a new UTC day starts at zero");

  const receipts: HedgeReceipt[] = loadHedgeReceipts(path);
  assert.equal(receipts.length, 4);
  const s = summarizeHedgeReceipts(receipts);
  assert.deepEqual(s.byOutcome, { filled_rfq: 0, filled_book: 3, filled_live: 1, unfilled: 0 });
  assert.equal(s.simulated, 3);
  assert.deepEqual(s.live, {
    refused: 1,
    byRail: { per_day: 1 },
    dryRun: 1,
    sent: 2,
    filled: 1,
    partial: 0,
    sentUnitsMilli: 40_000,
    costCents: 810,
  });
  assert.deepEqual(s.fallbackReasons, { "dry run": 1, "order failed": 1, "rail per_day": 1 });
});

// ---------------------------------------------------------------------------
// Kalshi order client against fixture responses
// ---------------------------------------------------------------------------

type Call = { method: string; url: string; headers: Record<string, string>; body: string | null };

function fixtureFetch(script: Array<(c: Call) => { status: number; body?: unknown }>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k] = v;
    const c: Call = { method: init?.method ?? "GET", url: String(input), headers, body: (init?.body as string) ?? null };
    calls.push(c);
    const step = script.shift();
    if (!step) throw new Error(`unexpected call ${c.method} ${c.url}`);
    const r = step(c);
    if (r.status === 204) return new Response(null, { status: 204 });
    const text = r.body === undefined ? "" : JSON.stringify(r.body);
    return new Response(text, { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function testCreds(): { apiKeyId: string; privateKeyPem: string } {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { apiKeyId: "key-1", privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string };
}

test("kalshi orders: the body is a limit buy of No at the walked worst price, IOC; whole sizes as count, fractions as count_fp", () => {
  const body = KalshiOrderClient.orderBody(intentFromHedge(KALSHI_LEG, 400), "atticus-abc");
  assert.deepEqual(body, {
    ticker: "KXNBAGAME-26OCT14LALBOS-BOS",
    client_order_id: "atticus-abc",
    side: "no",
    action: "buy",
    type: "limit",
    count: 20,
    no_price: 42,
    time_in_force: "immediate_or_cancel",
  });
  const frac = KalshiOrderClient.orderBody(intentFromHedge({ ...KALSHI_LEG, contractsMilli: 20_501, worstPriceCents: 41 }, 400), "x");
  assert.equal(frac.count, undefined);
  assert.equal(frac.count_fp, "20.51", "rounded up to the venue's hundredth");
  assert.equal(frac.no_price, 41);
  assert.throws(() => KalshiOrderClient.orderBody(intentFromHedge(PM_LEG, 415), "x"), /intent is for polymarket/);
});

test("kalshi orders: fills read fixed-point before integers, fees from the venue or the exact formula, nothing under-counted", () => {
  const cap = 42;
  assert.deepEqual(fillOfOrder({ order_id: "o", taker_fill_count: 20, taker_fill_cost: 800, taker_fees: 7 }, cap), {
    unitsMilli: 20_000,
    costCents: 807,
    feesCents: 7,
  });
  assert.deepEqual(
    fillOfOrder({ order_id: "o", taker_fill_count: 1, taker_fill_count_fp: "20.00", taker_fill_cost: 1, taker_fill_cost_dollars: "8.0000", taker_fees_dollars: "0.0700" }, cap),
    { unitsMilli: 20_000, costCents: 807, feesCents: 7 },
    "fixed-point and dollar fields win when both shapes are present",
  );
  const noFees = fillOfOrder({ order_id: "o", taker_fill_count: 20, taker_fill_cost: 800 }, cap);
  assert.equal(noFees.feesCents, 34, "0.07 x 20 x 0.40 x 0.60 = 33.6c, rounded up");
  assert.equal(noFees.costCents, 834);
  const noCost = fillOfOrder({ order_id: "o", taker_fill_count: 20 }, cap);
  assert.equal(noCost.costCents - noCost.feesCents, 840, "no cost reported: read at the cap");
  assert.deepEqual(fillOfOrder({ order_id: "o", status: "canceled" }, cap), { unitsMilli: 0, costCents: 0, feesCents: 0 });
  assert.equal(fillOfOrder({ order_id: "o", taker_fill_count: 8, maker_fill_count: 2, taker_fill_cost: 320, maker_fill_cost: 80, taker_fees: 3, maker_fees: 0 }, cap).unitsMilli, 10_000);
});

test("kalshi orders client: place, read until final, cancel the rest; headers signed; the result is the venue's numbers", async () => {
  const creds = testCreds();
  let nowMs = 1_760_000_000_000;
  const intent = intentFromHedge(KALSHI_LEG, 400);
  const fx = fixtureFetch([
    (c) => {
      assert.equal(c.method, "POST");
      assert.equal(c.url, "https://api.test/trade-api/v2/portfolio/orders");
      assert.equal(c.headers["KALSHI-ACCESS-KEY"], "key-1");
      assert.equal(c.headers["KALSHI-ACCESS-TIMESTAMP"], String(nowMs));
      assert.ok(c.headers["KALSHI-ACCESS-SIGNATURE"].length > 100);
      assert.equal(c.headers["content-type"], "application/json");
      const body = JSON.parse(c.body ?? "");
      assert.equal(body.client_order_id, "atticus-r1");
      assert.equal(body.count, 20);
      assert.equal(body.no_price, 42);
      return { status: 201, body: { order: { order_id: "ord-9", status: "resting", taker_fill_count: 12, taker_fill_cost: 492, taker_fees: 4, remaining_count: 8 } } };
    },
    (c) => {
      assert.equal(c.method, "GET");
      assert.equal(c.url, "https://api.test/trade-api/v2/portfolio/orders/ord-9");
      return { status: 200, body: { order: { order_id: "ord-9", status: "resting", taker_fill_count: 12, taker_fill_cost: 492, taker_fees: 4, remaining_count: 8 } } };
    },
    (c) => {
      assert.equal(c.method, "DELETE");
      assert.equal(c.url, "https://api.test/trade-api/v2/portfolio/orders/ord-9");
      return { status: 200, body: { order: { order_id: "ord-9", status: "canceled", taker_fill_count: 12, taker_fill_cost: 492, taker_fees: 4, remaining_count: 0 }, reduced_by: 8 } };
    },
  ]);
  const client = new KalshiOrderClient(creds, {
    base: "https://api.test/trade-api/v2",
    fetchImpl: fx.fetchImpl,
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    restWaitMs: 250,
    restPollMs: 250,
  });
  const r = await client.placeNo(intent, "atticus-r1");
  assert.deepEqual(r, { orderId: "ord-9", unitsMilli: 12_000, avgPriceMilli: 414, costCents: 496, feesCents: 4, status: "canceled" });
  assert.equal(fx.calls.length, 3);

  // executed at once: one call, no read, no cancel
  const fast = fixtureFetch([() => ({ status: 201, body: { order: { order_id: "ord-10", status: "executed", taker_fill_count_fp: "20.00", taker_fill_cost_dollars: "8.1000", taker_fees_dollars: "0.0700" } } })]);
  const quick = new KalshiOrderClient(creds, { base: "https://api.test/trade-api/v2", fetchImpl: fast.fetchImpl, now: () => nowMs, sleep: async () => {} });
  const q = await quick.placeNo(intent, "atticus-r2");
  assert.deepEqual(q, { orderId: "ord-10", unitsMilli: 20_000, avgPriceMilli: 409, costCents: 817, feesCents: 7, status: "executed" });
  assert.equal(fast.calls.length, 1);
});

test("kalshi orders client: nothing filled throws (so the executor falls back); an HTTP error names the call; balance reads cents", async () => {
  const creds = testCreds();
  const intent = intentFromHedge(KALSHI_LEG, 400);
  const empty = fixtureFetch([() => ({ status: 201, body: { order: { order_id: "ord-0", status: "canceled", taker_fill_count: 0 } } })]);
  const c1 = new KalshiOrderClient(creds, { base: "https://api.test/trade-api/v2", fetchImpl: empty.fetchImpl, sleep: async () => {} });
  await assert.rejects(c1.placeNo(intent, "x"), /order ord-0 canceled with nothing filled at or under 42c/);

  const denied = fixtureFetch([() => ({ status: 401, body: { error: { code: "unauthorized" } } })]);
  const c2 = new KalshiOrderClient(creds, { base: "https://api.test/trade-api/v2", fetchImpl: denied.fetchImpl, sleep: async () => {} });
  await assert.rejects(c2.placeNo(intent, "x"), /kalshi orders: HTTP 401 POST \/portfolio\/orders/);

  const bal = fixtureFetch([
    (c) => {
      assert.equal(c.url, "https://api.test/trade-api/v2/portfolio/balance");
      return { status: 200, body: { balance: 2_000, payout: 0 } };
    },
    () => ({ status: 200, body: { balance_dollars: "20.5000" } }),
    () => ({ status: 200, body: {} }),
  ]);
  const c3 = new KalshiOrderClient(creds, { base: "https://api.test/trade-api/v2", fetchImpl: bal.fetchImpl });
  assert.equal(await c3.balanceCents(), 2_000);
  assert.equal(await c3.balanceCents(), 2_050);
  await assert.rejects(c3.balanceCents(), /no balance/);
});

test("hedgeExecutorFromEnv: live mode wires the rails and the Kalshi client from the service env; the view carries no secret", () => {
  const bare = hedgeExecutorFromEnv({ EVENT_HEDGE_STRATEGY: "live" });
  assert.equal(bare.strategy, "live");
  assert.equal(bare.executor.strategy, "live");
  assert.deepEqual(bare.rfqVenues, []);
  assert.equal(bare.kalshiOrders, null);
  assert.deepEqual(bare.live, { dryRun: true, killSwitch: false, venues: [], allowlist: [], maxContractsPerOrder: 25, maxContractsPerDay: 100 });
  assert.match(bare.notes[0], /kalshi: no KALSHI_API_KEY_ID/);
  assert.match(bare.notes[1], /live: dry run; orders built and held, EVENT_HEDGE_LIVE_SEND=yes to send/);
  assert.match(bare.notes[2], /EVENT_HEDGE_LIVE_TICKERS is empty/);
  assert.ok(bare.notes.some((n) => /no receipts path/.test(n)));

  const creds = testCreds();
  const armed = hedgeExecutorFromEnv(
    {
      EVENT_HEDGE_STRATEGY: "live",
      EVENT_HEDGE_LIVE_SEND: "yes",
      EVENT_HEDGE_LIVE_TICKERS: "KXNBAGAME-26OCT14LALBOS-BOS",
      EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_ORDER: "20",
      KALSHI_API_KEY_ID: creds.apiKeyId,
      KALSHI_PRIVATE_KEY_PEM: creds.privateKeyPem.replace(/\n/g, "\\n"),
    },
    null,
    { receiptsPath: join(mkdtempSync(join(tmpdir(), "live-env-")), "receipts.jsonl") },
  );
  assert.ok(armed.kalshiOrders instanceof KalshiOrderClient);
  assert.deepEqual(armed.live, {
    dryRun: false,
    killSwitch: false,
    venues: ["kalshi"],
    allowlist: ["KXNBAGAME-26OCT14LALBOS-BOS"],
    maxContractsPerOrder: 20,
    maxContractsPerDay: 100,
  });
  assert.match(armed.notes[0], /live: SENDING real orders/);
  assert.ok(!JSON.stringify({ live: armed.live, notes: armed.notes }).includes("PRIVATE KEY"), "healthz shape never carries the key");
  assert.ok(!JSON.stringify({ live: armed.live, notes: armed.notes }).includes("key-1"), "nor the key id");

  const killed = hedgeExecutorFromEnv({ EVENT_HEDGE_STRATEGY: "live", EVENT_HEDGE_LIVE_SEND: "yes", EVENT_HEDGE_KILL_SWITCH: "1" });
  assert.equal(killed.live?.killSwitch, true);
  assert.match(killed.notes.join(" | "), /KILL SWITCH ON/);

  // book and rfq modes are untouched by the new fields
  assert.equal(hedgeExecutorFromEnv({}).live, null);
  assert.equal(hedgeExecutorFromEnv({ EVENT_HEDGE_STRATEGY: "rfq" }).live, null);
});

test("hedgeExecutorFromEnv: live mode end to end with an injected hook; dry run by default holds the order", async () => {
  const sent: string[] = [];
  const hook: LiveOrderHook = async (_intent, clientOrderId) => {
    sent.push(clientOrderId);
    return { orderId: "ord-1", unitsMilli: 20_000, avgPriceMilli: 405, costCents: 810, feesCents: 7, status: "executed" };
  };
  const env = { EVENT_HEDGE_STRATEGY: "live", EVENT_HEDGE_LIVE_TICKERS: "KXNBAGAME-26OCT14LALBOS-BOS" };
  const held = await hedgeExecutorFromEnv(env, null, { liveHooks: { kalshi: hook } }).executor.execute(intentFromHedge(KALSHI_LEG, 400), "ref");
  assert.equal(held.fallbackReason, "dry run");
  assert.deepEqual(sent, []);

  const live = await hedgeExecutorFromEnv({ ...env, EVENT_HEDGE_LIVE_SEND: "yes" }, null, { liveHooks: { kalshi: hook } }).executor.execute(
    intentFromHedge(KALSHI_LEG, 400),
    "ref",
  );
  assert.equal(live.outcome, "filled_live");
  assert.equal(sent.length, 1);
});
