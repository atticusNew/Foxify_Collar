/**
 * Hedge executor — book and RFQ strategies behind one interface, the RFQ path
 * never worse than the walk, every step in the receipt. Venue clients are
 * driven by fixture responses; nothing touches the network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, constants, createHmac, createVerify } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BookHedgeExecutor,
  RfqHedgeExecutor,
  appendHedgeReceipt,
  bookWalkPenaltyCents,
  costCentsAt,
  intentFromHedge,
  loadHedgeReceipts,
  summarizeHedgeReceipts,
  type ExecutorClock,
  type HedgeIntent,
  type RfqClient,
  type RfqQuoteView,
} from "../src/eventCollar/crossVenue/hedgeExecutor";
import { hedgeExecutorFromEnv } from "../src/eventCollar/crossVenue/hedgeExecutorFromEnv";
import {
  KALSHI_REQUESTER_SIDE,
  KalshiRfqClient,
  contractsFp,
  fpToMilli,
  kalshiRfqCredentialsFromEnv,
  noViewOfQuote,
  signKalshiRequest,
} from "../src/eventCollar/crossVenue/kalshiRfq";
import {
  PolymarketRfqClient,
  buyViewOfQuote,
  maskBuilderCode,
  polymarketBuilderCodeFromEnv,
  polymarketRfqCredentialsFromEnv,
  signPolymarketL2,
  type SignedV1Order,
} from "../src/eventCollar/crossVenue/polymarketRfq";
import type { CrossHedgeLeg, KalshiSelfHedgeLeg } from "../src/eventCollar/crossVenue/types";

/** A deterministic clock: time advances only when the executor sleeps. */
function fakeClock(startMs = Date.parse("2026-09-20T12:00:00.000Z")): ExecutorClock & { ms: number } {
  const c = {
    ms: startMs,
    now: () => new Date(c.ms),
    sleep: async (ms: number) => {
      c.ms += ms;
    },
  };
  return c;
}

const KALSHI_LEG: KalshiSelfHedgeLeg = {
  action: "buy",
  venue: "kalshi",
  outcome: "No",
  ticker: "KXMLB-YANKEES",
  contractsMilli: 150_000,
  avgPriceCents: 42, // walked: 100 @ 40c, 50 @ 46c -> 4300c / 150 = 42 (rounded up)
  worstPriceCents: 46,
  costCents: 6_300,
};

const PM_LEG: CrossHedgeLeg = {
  action: "buy",
  venue: "polymarket",
  outcome: "Red Sox",
  tokenId: "7123",
  sharesMilli: 150_000,
  avgPriceMilli: 415,
  worstPriceMilli: 430,
  costCents: 6_225,
};

test("intentFromHedge + walk penalty: the penalty is the walk over one price at the top, never negative", () => {
  const k = intentFromHedge(KALSHI_LEG, 400);
  assert.equal(k.venue, "kalshi");
  assert.equal(k.unitsMilli, 150_000);
  assert.equal(k.book.avgPriceMilli, 420);
  assert.equal(k.book.worstPriceMilli, 460);
  assert.equal(k.maxCostCents, 6_300);
  assert.equal(costCentsAt(150_000, 400), 6_000);
  assert.equal(bookWalkPenaltyCents(k), 300, "150 contracts x 2c average walk");

  const p = intentFromHedge(PM_LEG, 415);
  assert.equal(p.instrument, "7123");
  assert.equal(bookWalkPenaltyCents(p), 0, "whole size at the top: nothing to win back");
  assert.equal(costCentsAt(1, 1), 1, "rounds up against the writer");
});

test("book executor: simulated fill at exactly the quoted terms; a live hook records the venue's numbers", async () => {
  const clock = fakeClock();
  const intent = intentFromHedge(KALSHI_LEG, 400);
  const sim = await new BookHedgeExecutor(null, clock).execute(intent, "KXMLB-YANKEES");
  assert.equal(sim.outcome, "filled_book");
  assert.equal(sim.fill?.simulated, true);
  assert.equal(sim.fill?.costCents, 6_300);
  assert.equal(sim.fill?.vsBookCents, 0);
  assert.equal(sim.attempts.length, 1);
  assert.equal(sim.attempts[0].strategy, "book");
  assert.equal(sim.bookWalkPenaltyCents, 300);
  assert.equal(sim.fallbackReason, null);
  assert.equal(sim.id.length, 16);

  const live = await new BookHedgeExecutor(async () => ({ orderId: "o-1", avgPriceMilli: 418, costCents: 6_270 }), clock).execute(
    intent,
    "KXMLB-YANKEES",
  );
  assert.equal(live.fill?.simulated, false);
  assert.equal(live.fill?.ids.orderId, "o-1");
  assert.equal(live.fill?.vsBookCents, 30);

  const failed = await new BookHedgeExecutor(async () => {
    throw new Error("venue down");
  }, clock).execute(intent, "KXMLB-YANKEES");
  assert.equal(failed.outcome, "unfilled");
  assert.equal(failed.fill, null);
  assert.equal(failed.attempts[0].ok, false);
  assert.match(failed.attempts[0].detail, /venue down/);
});

/** A scripted RFQ client: quotes appear after `arriveAfterPolls` polls; calls are logged. */
function scriptedClient(opts: {
  venue?: "kalshi" | "polymarket";
  quotes?: RfqQuoteView[];
  arriveAfterPolls?: number;
  canExecute?: boolean;
  failRequest?: boolean;
  failAccept?: boolean;
  failCancel?: boolean;
}): RfqClient & { calls: string[] } {
  let polls = 0;
  const calls: string[] = [];
  return {
    venue: opts.venue ?? "kalshi",
    calls,
    canExecute: () => opts.canExecute ?? true,
    async request() {
      calls.push("request");
      if (opts.failRequest) throw new Error("401 bad signature");
      return { rfqId: "rfq-1" };
    },
    async bestQuote() {
      calls.push("poll");
      polls += 1;
      if (polls <= (opts.arriveAfterPolls ?? 0)) return null;
      return opts.quotes?.[0] ?? null;
    },
    async accept(_rfqId, quote) {
      calls.push(`accept:${quote.quoteId}`);
      if (opts.failAccept) throw new Error("maker did not confirm");
      return { orderId: "ord-9" };
    },
    async cancel() {
      calls.push("cancel");
      if (opts.failCancel) throw new Error("already executed");
    },
  };
}

test("rfq executor: a quote for the full size at or inside the walk is accepted and the saving is kept", async () => {
  const clock = fakeClock();
  const intent = intentFromHedge(KALSHI_LEG, 400);
  const client = scriptedClient({ quotes: [{ quoteId: "q-1", priceMilli: 405, unitsMilli: 150_000 }], arriveAfterPolls: 2 });
  const ex = new RfqHedgeExecutor({ kalshi: client }, null, { waitMs: 4_000, pollMs: 500 }, clock);
  const r = await ex.execute(intent, "KXMLB-YANKEES");
  assert.equal(r.outcome, "filled_rfq");
  assert.equal(r.fill?.strategy, "rfq");
  assert.equal(r.fill?.costCents, costCentsAt(150_000, 405));
  assert.equal(r.fill?.costCents, 6_075);
  assert.equal(r.fill?.vsBookCents, 225);
  assert.equal(r.fill?.simulated, false);
  assert.deepEqual(r.fill?.ids, { rfqId: "rfq-1", quoteId: "q-1", orderId: "ord-9" });
  assert.deepEqual(client.calls, ["request", "poll", "poll", "poll", "accept:q-1"]);
  assert.deepEqual(
    r.attempts.map((a) => `${a.strategy}:${a.step}:${a.ok}`),
    ["rfq:request:true", "rfq:quote:true", "rfq:accept:true"],
  );
  assert.equal(r.fallbackReason, null);
});

test("rfq executor: a quote above the walk is declined; the request is withdrawn and the book fills", async () => {
  const clock = fakeClock();
  const intent = intentFromHedge(KALSHI_LEG, 400);
  const client = scriptedClient({ quotes: [{ quoteId: "q-dear", priceMilli: 425, unitsMilli: 150_000 }] });
  const r = await new RfqHedgeExecutor({ kalshi: client }, null, { waitMs: 1_000, pollMs: 500 }, clock).execute(intent, "T");
  assert.equal(r.outcome, "filled_book");
  assert.equal(r.fill?.strategy, "book");
  assert.equal(r.fill?.costCents, 6_300, "never worse than quoted");
  assert.match(r.fallbackReason ?? "", /costs 6375c, book walk 6300c/);
  assert.ok(client.calls.includes("cancel"));
  const steps = r.attempts.map((a) => `${a.strategy}:${a.step}:${a.ok}`);
  assert.deepEqual(steps, ["rfq:request:true", "rfq:quote:false", "rfq:cancel:true", "book:fill:true"]);
});

test("rfq executor: partial size, timeout, request failure, accept failure, and a venue without a client all fall back", async () => {
  const intent = intentFromHedge(KALSHI_LEG, 400);
  const run = (client: RfqClient | undefined, venue: "kalshi" | "polymarket" = "kalshi") =>
    new RfqHedgeExecutor(client ? { [venue]: client } : {}, null, { waitMs: 1_000, pollMs: 500 }, fakeClock()).execute(intent, "T");

  const partial = await run(scriptedClient({ quotes: [{ quoteId: "q-p", priceMilli: 400, unitsMilli: 100_000 }] }));
  assert.equal(partial.outcome, "filled_book");
  assert.match(partial.fallbackReason ?? "", /covers 100 of 150/);

  const silent = await run(scriptedClient({ arriveAfterPolls: 99 }));
  assert.equal(silent.outcome, "filled_book");
  assert.equal(silent.fallbackReason, "no quote within 1000ms");

  const badReq = await run(scriptedClient({ failRequest: true }));
  assert.equal(badReq.outcome, "filled_book");
  assert.match(badReq.fallbackReason ?? "", /request failed: 401/);
  assert.equal(badReq.attempts.filter((a) => a.strategy === "rfq" && a.step === "cancel").length, 0, "nothing to withdraw");

  const badAccept = await run(scriptedClient({ quotes: [{ quoteId: "q-1", priceMilli: 400, unitsMilli: 150_000 }], failAccept: true, failCancel: true }));
  assert.equal(badAccept.outcome, "filled_book");
  assert.match(badAccept.fallbackReason ?? "", /accept failed: maker did not confirm/);
  const cancel = badAccept.attempts.find((a) => a.strategy === "rfq" && a.step === "cancel");
  assert.equal(cancel?.ok, false, "a failed withdrawal is recorded, not hidden");

  const noClient = await run(undefined);
  assert.equal(noClient.outcome, "filled_book");
  assert.equal(noClient.fallbackReason, "no RFQ client for kalshi");

  const readOnly = await run(scriptedClient({ canExecute: false }));
  assert.equal(readOnly.fallbackReason, "kalshi RFQ client cannot accept quotes (no signer)");
  assert.equal(readOnly.attempts.length, 1, "no request is even sent");
});

test("receipt trail: append-only JSONL replays; the summary counts outcomes, savings, and the walk penalty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hedge-receipts-"));
  const path = join(dir, "hedge-receipts.jsonl");
  assert.deepEqual(loadHedgeReceipts(path), []);
  const clock = fakeClock();
  const intent = intentFromHedge(KALSHI_LEG, 400);
  const a = await new BookHedgeExecutor(null, clock).execute(intent, "A");
  const b = await new RfqHedgeExecutor(
    { kalshi: scriptedClient({ quotes: [{ quoteId: "q", priceMilli: 405, unitsMilli: 150_000 }] }) },
    null,
    { waitMs: 1_000, pollMs: 500 },
    clock,
  ).execute(intent, "B");
  const c = await new RfqHedgeExecutor({}, null, { waitMs: 1_000, pollMs: 500 }, clock).execute(
    intentFromHedge(PM_LEG, 415),
    "C",
  );
  appendHedgeReceipt(path, a);
  appendHedgeReceipt(path, b);
  appendHedgeReceipt(path, c);
  const loaded = loadHedgeReceipts(path);
  assert.equal(loaded.length, 3);
  assert.deepEqual(loaded.map((r) => r.ref), ["A", "B", "C"]);
  const s = summarizeHedgeReceipts(loaded);
  assert.equal(s.receipts, 3);
  assert.deepEqual(s.byOutcome, { filled_rfq: 1, filled_book: 2, filled_live: 0, unfilled: 0 });
  assert.deepEqual(s.byVenue, { kalshi: 2, polymarket: 1, prophetx: 0 });
  assert.deepEqual(s.live, { refused: 0, byRail: {}, dryRun: 0, sent: 0, filled: 0, partial: 0, sentUnitsMilli: 0, costCents: 0 }, "no live path touched");
  assert.equal(s.rfqSavedCents, 225);
  assert.equal(s.bookWalkPenaltyCents, 600, "300 on each Kalshi hedge, 0 on the Polymarket one at the top");
  assert.equal(s.costCents, 6_300 + 6_075 + 6_225);
  assert.equal(s.simulated, 2);
  assert.deepEqual(s.fallbackReasons, { "no RFQ client for polymarket": 1 });
});

test("hedgeExecutorFromEnv: book by default; rfq only where credentials exist, with the gaps named", () => {
  const book = hedgeExecutorFromEnv({});
  assert.equal(book.strategy, "book");
  assert.equal(book.executor.strategy, "book");
  assert.deepEqual(book.rfqVenues, []);

  const bare = hedgeExecutorFromEnv({ EVENT_HEDGE_STRATEGY: "rfq" });
  assert.equal(bare.strategy, "rfq");
  assert.equal(bare.executor.strategy, "rfq");
  assert.deepEqual(bare.rfqVenues, []);
  assert.equal(bare.notes.length, 2);
  assert.match(bare.notes[0], /kalshi: no KALSHI_API_KEY_ID/);
  assert.match(bare.notes[1], /polymarket: no POLY_API_KEY/);

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const withKalshi = hedgeExecutorFromEnv({
    EVENT_HEDGE_STRATEGY: "rfq",
    KALSHI_API_KEY_ID: "key-1",
    KALSHI_PRIVATE_KEY_PEM: pem.replace(/\n/g, "\\n"),
    POLY_API_KEY: "k",
    POLY_API_SECRET: "c2VjcmV0",
    POLY_API_PASSPHRASE: "p",
    POLY_ADDRESS: "0xabc",
  });
  assert.deepEqual(withKalshi.rfqVenues, ["kalshi"]);
  assert.equal(withKalshi.notes.length, 2);
  assert.match(withKalshi.notes[0], /polymarket: credentials present, no order signer/);
  assert.match(withKalshi.notes[1], /polymarket: no POLYMARKET_BUILDER_CODE; orders unattributed/);
  assert.equal(withKalshi.polymarketBuilderCode, null);
});

test("hedgeExecutorFromEnv: the builder code is read in both modes, masked for healthz, and a pasted API key is refused by name", () => {
  const code = "0x" + "ab".repeat(32);
  const book = hedgeExecutorFromEnv({ POLYMARKET_BUILDER_CODE: code });
  assert.equal(book.strategy, "book");
  assert.equal(book.polymarketBuilderCode, "0xababab...abab");
  assert.deepEqual(book.notes, ["book: simulated fill at the walked terms"], "book mode sends nothing, so nothing to warn about");

  const unset = hedgeExecutorFromEnv({});
  assert.equal(unset.polymarketBuilderCode, null);
  assert.equal(unset.notes.length, 1, "unset is fine in book mode; no nag");

  const pastedKey = hedgeExecutorFromEnv({ POLYMARKET_BUILDER_CODE: "00000000-1111-4222-8333-444444444444" });
  assert.equal(pastedKey.polymarketBuilderCode, null);
  assert.match(pastedKey.notes[1], /Builder API key \(secret\), not the bytes32 Builder Code/);

  const rfq = hedgeExecutorFromEnv({
    EVENT_HEDGE_STRATEGY: "rfq",
    POLY_API_KEY: "k",
    POLY_API_SECRET: "c2VjcmV0",
    POLY_API_PASSPHRASE: "p",
    POLY_ADDRESS: "0xabc",
    POLYMARKET_BUILDER_CODE: code.toUpperCase().replace("0X", "0x"),
  });
  assert.equal(rfq.polymarketBuilderCode, "0xababab...abab", "normalised to lowercase");
  assert.ok(!rfq.notes.some((n) => /unattributed/.test(n)), rfq.notes.join(" | "));
});

// ---------------------------------------------------------------------------
// Kalshi client against fixture responses
// ---------------------------------------------------------------------------

type Call = { method: string; url: string; headers: Record<string, string>; body: string | null };

/** A fetch that answers from a script and logs every call. */
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

test("kalshi rfq: signature is RSA-PSS over timestamp+method+path; fixed-point counts round up; the No view hits the maker's Yes bid", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const creds = { apiKeyId: "key-1", privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string };
  const sig = signKalshiRequest(creds, 1_726_000_000_000, "post", "/trade-api/v2/communications/rfqs");
  const v = createVerify("RSA-SHA256");
  v.update("1726000000000POST/trade-api/v2/communications/rfqs");
  v.end();
  assert.ok(
    v.verify({ key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(sig, "base64")),
  );

  assert.equal(contractsFp(150_000), "150.00");
  assert.equal(contractsFp(150_001), "150.01", "rounded up to the venue's 0.01 so the hedge is never short");
  assert.equal(contractsFp(5), "0.01");
  assert.equal(fpToMilli("150.00"), 150_000);
  assert.equal(fpToMilli("2.50"), 2_500);
  assert.equal(fpToMilli(undefined), 0);

  const view = noViewOfQuote({
    id: "q-1",
    rfq_id: "rfq-1",
    status: "open",
    yes_bid_dollars: "0.5950",
    no_bid_dollars: "0.3900",
    contracts_fp: "200.00",
    yes_contracts_fp: "180.00",
  });
  assert.deepEqual({ quoteId: view?.quoteId, priceMilli: view?.priceMilli, unitsMilli: view?.unitsMilli }, {
    quoteId: "q-1",
    priceMilli: 405,
    unitsMilli: 180_000,
  });
  assert.equal(noViewOfQuote({ id: "x", rfq_id: "r", status: "open", yes_bid_dollars: "0" }), null);
  assert.equal(noViewOfQuote({ id: "x", rfq_id: "r", status: "open", yes_bid_dollars: "1.00", contracts_fp: "1" }), null);
  assert.equal(KALSHI_REQUESTER_SIDE, "no");

  assert.equal(kalshiRfqCredentialsFromEnv({}), null);
  assert.equal(kalshiRfqCredentialsFromEnv({ KALSHI_API_KEY_ID: "k", KALSHI_PRIVATE_KEY_PEM: "a\\nb" })?.privateKeyPem, "a\nb");
});

test("kalshi rfq client: request, best quote, accept-then-confirm, cancel — wire shapes and headers from fixtures", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const creds = { apiKeyId: "key-1", privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string };
  const intent = intentFromHedge(KALSHI_LEG, 400);
  let nowMs = 1_726_000_000_000;
  const fx = fixtureFetch([
    (c) => {
      assert.equal(c.method, "POST");
      assert.equal(c.url, "https://api.test/trade-api/v2/communications/rfqs");
      assert.deepEqual(JSON.parse(c.body ?? ""), { market_ticker: "KXMLB-YANKEES", contracts_fp: "150.00", rest_remainder: false });
      assert.equal(c.headers["KALSHI-ACCESS-KEY"], "key-1");
      assert.equal(c.headers["KALSHI-ACCESS-TIMESTAMP"], String(nowMs));
      assert.ok(c.headers["KALSHI-ACCESS-SIGNATURE"].length > 100);
      return { status: 201, body: { rfq_id: "rfq-77" } };
    },
    (c) => {
      assert.equal(c.method, "GET");
      assert.equal(c.url, "https://api.test/trade-api/v2/communications/quotes?rfq_id=rfq-77&status=open");
      return {
        status: 200,
        body: {
          quotes: [
            { id: "q-small", rfq_id: "rfq-77", status: "open", yes_bid_dollars: "0.6100", contracts_fp: "50.00" },
            { id: "q-dear", rfq_id: "rfq-77", status: "open", yes_bid_dollars: "0.5700", contracts_fp: "150.00" },
            { id: "q-best", rfq_id: "rfq-77", status: "open", yes_bid_dollars: "0.5900", contracts_fp: "150.00" },
            { id: "q-other", rfq_id: "rfq-99", status: "open", yes_bid_dollars: "0.7000", contracts_fp: "999.00" },
          ],
        },
      };
    },
    (c) => {
      assert.equal(c.method, "PUT");
      assert.equal(c.url, "https://api.test/trade-api/v2/communications/rfqs/rfq-77/quotes/q-best/accept");
      assert.deepEqual(JSON.parse(c.body ?? ""), { accepted_side: "no" });
      return { status: 204 };
    },
    () => ({ status: 200, body: { quotes: [{ id: "q-best", rfq_id: "rfq-77", status: "accepted" }] } }),
    () => ({ status: 200, body: { quotes: [{ id: "q-best", rfq_id: "rfq-77", status: "executed", rfq_creator_order_id: "ord-5" }] } }),
    (c) => {
      assert.equal(c.method, "DELETE");
      assert.equal(c.url, "https://api.test/trade-api/v2/communications/rfqs/rfq-77");
      return { status: 204 };
    },
  ]);
  const client = new KalshiRfqClient(creds, {
    base: "https://api.test/trade-api/v2",
    fetchImpl: fx.fetchImpl,
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    confirmWaitMs: 2_000,
    confirmPollMs: 300,
  });
  assert.equal(client.canExecute(), true);
  assert.equal(new KalshiRfqClient(null).canExecute(), false);

  const { rfqId } = await client.request(intent);
  assert.equal(rfqId, "rfq-77");
  const best = await client.bestQuote(rfqId, intent);
  assert.equal(best?.quoteId, "q-best", "cheapest quote that covers the whole size; the other RFQ's quote is ignored");
  assert.equal(best?.priceMilli, 410);
  const acc = await client.accept(rfqId, best as RfqQuoteView, intent);
  assert.deepEqual(acc, { orderId: "ord-5" });
  await client.cancel(rfqId);
  assert.equal(fx.calls.length, 6);
});

test("kalshi rfq client: an HTTP error names the call; an unconfirmed accept throws so the executor withdraws", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const creds = { apiKeyId: "key-1", privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string };
  const intent = intentFromHedge(KALSHI_LEG, 400);
  let nowMs = 0;
  const fx = fixtureFetch([
    () => ({ status: 401, body: { code: "unauthorized", message: "bad signature" } }),
    () => ({ status: 204 }),
    () => ({ status: 200, body: { quotes: [{ id: "q", rfq_id: "r", status: "accepted" }] } }),
    () => ({ status: 200, body: { quotes: [{ id: "q", rfq_id: "r", status: "accepted" }] } }),
    () => ({ status: 200, body: { quotes: [{ id: "q", rfq_id: "r", status: "accepted" }] } }),
  ]);
  const client = new KalshiRfqClient(creds, {
    base: "https://api.test/trade-api/v2",
    fetchImpl: fx.fetchImpl,
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    confirmWaitMs: 500,
    confirmPollMs: 300,
  });
  await assert.rejects(client.request(intent), /HTTP 401 POST \/communications\/rfqs.*bad signature/);
  await assert.rejects(client.accept("r", { quoteId: "q", priceMilli: 400, unitsMilli: 150_000 }, intent), /did not confirm quote q within 500ms/);
});

// ---------------------------------------------------------------------------
// Polymarket client against fixture responses
// ---------------------------------------------------------------------------

test("polymarket rfq: L2 HMAC matches the reference construction; the buy view follows the match type", () => {
  // secret is base64url of "secret-bytes"; message = ts + METHOD + path + body
  const secret = Buffer.from("secret-bytes").toString("base64url");
  const sig = signPolymarketL2(secret, 1_726_000_000, "post", "/rfq/request", '{"a":1}');
  const expected = createHmac("sha256", Buffer.from("secret-bytes"))
    .update('1726000000POST/rfq/request{"a":1}')
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  assert.equal(sig, expected);

  const intent = intentFromHedge(PM_LEG, 415);
  const comp = buyViewOfQuote({ quoteId: "q1", price: "0.41", side: "SELL", sizeIn: "61.5", sizeOut: "150", token: "7123", matchType: "COMPLEMENTARY" }, intent);
  assert.deepEqual({ id: comp?.quoteId, p: comp?.priceMilli, u: comp?.unitsMilli }, { id: "q1", p: 410, u: 150_000 });
  const mint = buyViewOfQuote({ quoteId: "q2", price: "0.6", side: "BUY", sizeIn: "150", sizeOut: "90", complement: "7123", matchType: "MINT" }, intent);
  assert.deepEqual({ p: mint?.priceMilli, u: mint?.unitsMilli }, { p: 400, u: 150_000 });
  assert.equal(buyViewOfQuote({ quoteId: "q3", price: "0.41", token: "other-token", sizeOut: "150" }, intent), null, "a quote on another token is not ours");
  assert.equal(buyViewOfQuote({ price: "0.41", sizeOut: "150" }, intent), null, "no id, no quote");
  assert.equal(buyViewOfQuote({ quoteId: "q4", price: "0.4105", sizeOut: "150", token: "7123" }, intent)?.priceMilli, 411, "a fourth decimal rounds our price up");

  assert.equal(polymarketRfqCredentialsFromEnv({}), null);
  assert.equal(
    polymarketRfqCredentialsFromEnv({ POLY_API_KEY: "k", POLY_API_SECRET: "s", POLY_API_PASSPHRASE: "p", POLY_ADDRESS: "0x1", POLY_SIGNATURE_TYPE: "2" })
      ?.signatureType,
    2,
  );

  const code = "0x" + "0123456789abcdef".repeat(4);
  assert.deepEqual(polymarketBuilderCodeFromEnv({}), { code: null, note: null }, "unset: unattributed, silently");
  assert.deepEqual(polymarketBuilderCodeFromEnv({ POLYMARKET_BUILDER_CODE: ` ${code.toUpperCase().replace("0X", "0x")} ` }), { code, note: null });
  assert.equal(polymarketBuilderCodeFromEnv({ POLYMARKET_BUILDER_CODE: "0x1234" }).code, null, "short hex is not a bytes32");
  assert.match(polymarketBuilderCodeFromEnv({ POLYMARKET_BUILDER_CODE: "0x1234" }).note ?? "", /not 0x \+ 64 hex/);
  assert.match(
    polymarketBuilderCodeFromEnv({ POLYMARKET_BUILDER_CODE: "00000000-1111-4222-8333-444444444444" }).note ?? "",
    /Builder API key \(secret\)/,
    "the API key is a UUID; refuse it and say why",
  );
  assert.equal(maskBuilderCode(code), "0x012345...cdef");
  assert.throws(() => new PolymarketRfqClient(null, null, { builderCode: "nope" }), /builderCode must be 0x \+ 64 hex/);
});

test("polymarket rfq client: request amounts are exact micro units; best quote parses; accept needs the signer; cancel is a DELETE with a body", async () => {
  const creds = { apiKey: "key", secret: Buffer.from("s").toString("base64url"), passphrase: "pass", address: "0xabc", signatureType: 1 as const };
  const builderCode = "0x" + "cd".repeat(32);
  const intent = intentFromHedge(PM_LEG, 415);
  const signer = {
    async signBuy(args: { tokenId: string; priceMilli: number; unitsMilli: number; expirationSec: number }): Promise<SignedV1Order> {
      assert.deepEqual(args, { tokenId: "7123", priceMilli: 410, unitsMilli: 150_000, expirationSec: 1_726_000_120 });
      return {
        salt: 1,
        maker: "0xabc",
        signer: "0xabc",
        taker: "0x0",
        tokenId: "7123",
        makerAmount: "61500000",
        takerAmount: "150000000",
        expiration: args.expirationSec,
        nonce: "0",
        feeRateBps: "0",
        side: "BUY",
        signatureType: 1,
        signature: "0xsig",
      };
    },
  };
  const fx = fixtureFetch([
    (c) => {
      assert.equal(c.method, "POST");
      assert.equal(c.url, "https://clob.test/rfq/request");
      assert.deepEqual(JSON.parse(c.body ?? ""), {
        assetIn: "7123",
        assetOut: "0",
        amountIn: "150000000",
        amountOut: "62250000",
        userType: 1,
      }, "the RFQ request is not an order; no builderCode on it");
      assert.equal(c.headers.POLY_ADDRESS, "0xabc");
      assert.equal(c.headers.POLY_API_KEY, "key");
      assert.equal(c.headers.POLY_PASSPHRASE, "pass");
      assert.equal(c.headers.POLY_TIMESTAMP, "1726000000");
      assert.equal(c.headers.POLY_SIGNATURE, signPolymarketL2(creds.secret, 1_726_000_000, "POST", "/rfq/request", c.body ?? ""));
      return { status: 200, body: { requestId: "req-1" } };
    },
    (c) => {
      assert.equal(c.url, "https://clob.test/rfq/data/best-quote?requestId=req-1");
      assert.equal(c.body, null);
      return { status: 200, body: { data: { quoteId: "q-1", requestId: "req-1", price: "0.41", side: "SELL", sizeOut: "150", token: "7123", state: "active" } } };
    },
    (c) => {
      assert.equal(c.method, "POST");
      assert.equal(c.url, "https://clob.test/rfq/request/accept");
      const body = JSON.parse(c.body ?? "");
      assert.equal(body.requestId, "req-1");
      assert.equal(body.quoteId, "q-1");
      assert.equal(body.owner, "key");
      assert.equal(body.signature, "0xsig");
      assert.equal(body.side, "BUY");
      assert.equal(body.builderCode, builderCode, "attribution rides on the order we place");
      assert.equal(c.headers.POLY_SIGNATURE, signPolymarketL2(creds.secret, 1_726_000_000, "POST", "/rfq/request/accept", c.body ?? ""), "and inside the signed body");
      return { status: 200, body: { orderId: "ord-1" } };
    },
    (c) => {
      assert.equal(c.method, "DELETE");
      assert.equal(c.url, "https://clob.test/rfq/request");
      assert.deepEqual(JSON.parse(c.body ?? ""), { requestId: "req-1" });
      return { status: 200, body: "OK" };
    },
  ]);
  const client = new PolymarketRfqClient(creds, signer, { base: "https://clob.test", fetchImpl: fx.fetchImpl, nowSec: () => 1_726_000_000, builderCode });
  assert.equal(client.canExecute(), true);
  assert.equal(client.builderCode, builderCode);
  const { rfqId } = await client.request(intent);
  assert.equal(rfqId, "req-1");
  const best = await client.bestQuote(rfqId, intent);
  assert.equal(best?.priceMilli, 410);
  assert.deepEqual(await client.accept(rfqId, best as RfqQuoteView, intent), { orderId: "ord-1" });
  await client.cancel(rfqId);
  assert.equal(fx.calls.length, 4);

  const readOnly = new PolymarketRfqClient(creds, null, { base: "https://clob.test", fetchImpl: fx.fetchImpl });
  assert.equal(readOnly.canExecute(), false, "quotes readable, not acceptable");
  assert.equal(readOnly.canRequest(), true);
  await assert.rejects(readOnly.accept("r", { quoteId: "q", priceMilli: 400, unitsMilli: 1 }, intent), /no order signer/);
  assert.equal(new PolymarketRfqClient(null).canRequest(), false);
});

test("rfq executor end to end with the kalshi client on fixtures: RFQ inside the walk fills and the receipt shows it", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const creds = { apiKeyId: "key-1", privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string };
  const clock = fakeClock();
  const fx = fixtureFetch([
    () => ({ status: 201, body: { rfq_id: "rfq-1" } }),
    () => ({ status: 200, body: { quotes: [] } }),
    () => ({ status: 200, body: { quotes: [{ id: "q", rfq_id: "rfq-1", status: "open", yes_bid_dollars: "0.5950", contracts_fp: "150.00" }] } }),
    () => ({ status: 204 }),
    () => ({ status: 200, body: { quotes: [{ id: "q", rfq_id: "rfq-1", status: "executed", rfq_creator_order_id: "o" }] } }),
  ]);
  const client = new KalshiRfqClient(creds, {
    base: "https://api.test/trade-api/v2",
    fetchImpl: fx.fetchImpl,
    now: () => clock.ms,
    sleep: clock.sleep,
  });
  const r = await new RfqHedgeExecutor({ kalshi: client }, null, { waitMs: 2_000, pollMs: 500 }, clock).execute(intentFromHedge(KALSHI_LEG, 400), "KXMLB-YANKEES");
  assert.equal(r.outcome, "filled_rfq");
  assert.equal(r.fill?.avgPriceMilli, 405);
  assert.equal(r.fill?.costCents, 6_075);
  assert.equal(r.fill?.vsBookCents, 225);
  assert.deepEqual(r.fill?.ids, { rfqId: "rfq-1", quoteId: "q", orderId: "o" });
  assert.equal(fx.calls.length, 5);
});

test("intent shapes are stable in the receipt (what the trail promises to downstream readers)", () => {
  const i: HedgeIntent = intentFromHedge(PM_LEG, 415);
  assert.deepEqual(Object.keys(i).sort(), ["book", "instrument", "maxCostCents", "outcome", "unitsMilli", "venue"]);
  assert.deepEqual(Object.keys(i.book).sort(), ["avgPriceMilli", "bestPriceMilli", "costCents", "worstPriceMilli"]);
});
