import assert from "node:assert/strict";
import test from "node:test";
import { signOkx, buildOkxHeaders, buildOrderBody, OkxExecutionClient, type OkxCredentials, type OkxFetcher } from "../src/singleSide/twoSided/creditCollar/execution/okxExecutionClient";
import {
  buildCollarLegOrders,
  legSlippageUsd,
  classifyOutcome,
  executeCollarHedge,
  type CollarHedgeSpec,
  type ExecClient,
  type LegFill
} from "../src/singleSide/twoSided/creditCollar/execution/okxCollarExecutor";

const creds: OkxCredentials = { apiKey: "k", secret: "s", passphrase: "p", mode: "demo" };

test("okx signing is deterministic, secret-sensitive, base64", () => {
  const a = signOkx("2026-06-19T00:00:00.000Z", "POST", "/api/v5/trade/order", "{}", "secret");
  const b = signOkx("2026-06-19T00:00:00.000Z", "POST", "/api/v5/trade/order", "{}", "secret");
  assert.equal(a, b);
  assert.notEqual(a, signOkx("2026-06-19T00:00:00.000Z", "POST", "/api/v5/trade/order", "{}", "other"));
  assert.match(a, /^[A-Za-z0-9+/]+=*$/);
});

test("okx headers include sim-trading flag in demo, not in live", () => {
  const demo = buildOkxHeaders({ ...creds, mode: "demo" }, "t", "GET", "/x", "");
  assert.equal(demo["x-simulated-trading"], "1");
  assert.equal(demo["OK-ACCESS-KEY"], "k");
  const live = buildOkxHeaders({ ...creds, mode: "live" }, "t", "GET", "/x", "");
  assert.equal(live["x-simulated-trading"], undefined);
});

test("order body + collar legs: buy put, sell call", () => {
  const body = JSON.parse(buildOrderBody({ instId: "BTC-USD-X-P", side: "buy", ordType: "limit", sz: "1", px: "100" }));
  assert.equal(body.side, "buy");
  assert.equal(body.tdMode, "cross");
  const spec: CollarHedgeSpec = { putInstId: "P", callInstId: "C", sizeContracts: "1", putLimitPx: "100", callLimitPx: "200", modeledPutAskUsd: 100, modeledCallBidUsd: 200 };
  const { putOrder, callOrder } = buildCollarLegOrders(spec);
  assert.equal(putOrder.side, "buy");
  assert.equal(callOrder.side, "sell");
});

test("slippage sign: buy pays more = +, sell receives less = +", () => {
  const fillBuy: LegFill = { filled: true, avgPxUsd: 105, filledContracts: 1, ordId: "1", state: "filled" };
  assert.equal(legSlippageUsd("buy", 100, fillBuy), 5);
  const fillSell: LegFill = { filled: true, avgPxUsd: 190, filledContracts: 1, ordId: "2", state: "filled" };
  assert.equal(legSlippageUsd("sell", 200, fillSell), 10);
  assert.equal(legSlippageUsd("buy", 100, { filled: false, avgPxUsd: null, filledContracts: 0, ordId: null, state: null }), null);
});

test("activateOption: signed POST to /activate-option, non-empty body, demo header", async () => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fetcher: OkxFetcher = async (url, init) => {
    calls.push({ url, ...init });
    return { status: 200, json: async () => ({ code: "0", msg: "", data: [{ ts: "1" }] }) };
  };
  const client = new OkxExecutionClient({ apiKey: "k", secret: "s", passphrase: "p", mode: "demo" }, fetcher);
  const r = await client.activateOption();
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/api\/v5\/account\/activate-option$/);
  assert.equal(calls[0].body, "{}"); // non-empty body so OKX doesn't return an HTML error page
  assert.equal(calls[0].headers["x-simulated-trading"], "1");
  assert.ok(calls[0].headers["OK-ACCESS-SIGN"]);
});

test("setAccountLevel: signed POST with acctLv body", async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  const fetcher: OkxFetcher = async (url, init) => {
    calls.push({ url, body: init.body });
    return { status: 200, json: async () => ({ code: "0", msg: "", data: [{ acctLv: "4" }] }) };
  };
  const client = new OkxExecutionClient({ apiKey: "k", secret: "s", passphrase: "p", mode: "demo" }, fetcher);
  const r = await client.setAccountLevel("4");
  assert.equal(r.ok, true);
  assert.match(calls[0].url, /\/api\/v5\/account\/set-account-level$/);
  assert.equal(calls[0].body, JSON.stringify({ acctLv: "4" }));
});

test("activateOptionWithRetry: retries 504 then succeeds", async () => {
  let n = 0;
  const fetcher: OkxFetcher = async () => {
    n++;
    if (n < 3) return { status: 504, text: async () => "<!DOCTYPE html>gateway timeout", json: async () => JSON.parse("<!DOCTYPE html>") };
    return { status: 200, text: async () => JSON.stringify({ code: "0", msg: "", data: [{ ts: "1" }] }), json: async () => ({ code: "0", data: [{ ts: "1" }] }) };
  };
  const client = new OkxExecutionClient({ apiKey: "k", secret: "s", passphrase: "p", mode: "demo" }, fetcher);
  const r = await client.activateOptionWithRetry({ tries: 5, baseDelayMs: 0, sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(n, 3);
});

test("activateOptionWithRetry: 51199 already-activated counts as success, no further retry", async () => {
  let n = 0;
  const fetcher: OkxFetcher = async () => {
    n++;
    return { status: 200, text: async () => JSON.stringify({ code: "51199", msg: "already" }), json: async () => ({ code: "51199", msg: "already" }) };
  };
  const client = new OkxExecutionClient({ apiKey: "k", secret: "s", passphrase: "p", mode: "demo" }, fetcher);
  const r = await client.activateOptionWithRetry({ tries: 5, baseDelayMs: 0, sleep: async () => {} });
  assert.equal(r.code, "51199");
  assert.equal(n, 1);
});

test("activateOptionWithRetry: non-retryable error returns immediately", async () => {
  let n = 0;
  const fetcher: OkxFetcher = async () => {
    n++;
    return { status: 200, text: async () => JSON.stringify({ code: "50101", msg: "env" }), json: async () => ({ code: "50101", msg: "env" }) };
  };
  const client = new OkxExecutionClient({ apiKey: "k", secret: "s", passphrase: "p", mode: "demo" }, fetcher);
  const r = await client.activateOptionWithRetry({ tries: 5, baseDelayMs: 0, sleep: async () => {} });
  assert.equal(r.code, "50101");
  assert.equal(n, 1);
});

test("request does not throw on network/DNS error — returns retryable ERR", async () => {
  let n = 0;
  const fetcher: OkxFetcher = async () => {
    n++;
    if (n === 1) throw new Error("getaddrinfo ENOTFOUND aws.okx.com");
    return { status: 200, text: async () => JSON.stringify({ code: "0", data: [{ ts: "1" }] }), json: async () => ({ code: "0", data: [{ ts: "1" }] }) };
  };
  const client = new OkxExecutionClient({ apiKey: "k", secret: "s", passphrase: "p", mode: "demo" }, fetcher);
  // First call: surfaces ERR (no throw).
  const direct = await client.getBalance();
  assert.equal(direct.ok, false);
  assert.equal(direct.code, "ERR");
  // Retry wrapper recovers on the next attempt.
  const r = await client.activateOptionWithRetry({ tries: 3, baseDelayMs: 0, sleep: async () => {} });
  assert.equal(r.ok, true);
});

test("request is resilient to a non-JSON (HTML) response", async () => {
  const html = "<!DOCTYPE html><html><body>error</body></html>";
  const fetcher: OkxFetcher = async () => ({ status: 200, text: async () => html, json: async () => JSON.parse(html) });
  const client = new OkxExecutionClient({ apiKey: "k", secret: "s", passphrase: "p", mode: "demo" }, fetcher);
  const r = await client.activateOption();
  assert.equal(r.ok, false);
  assert.match(r.code, /^HTTP_/);
  assert.match(r.msg, /non-JSON response/);
});

test("getInstruments/getBookTop: GET with demo header in demo mode", async () => {
  const calls: string[] = [];
  const fetcher: OkxFetcher = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    return { status: 200, json: async () => ({ code: "0", msg: "", data: [] }) };
  };
  const client = new OkxExecutionClient({ apiKey: "k", secret: "s", passphrase: "p", mode: "demo" }, fetcher);
  await client.getInstruments("OPTION", "BTC-USD");
  await client.getBookTop("BTC-USD-260621-61000-P");
  assert.match(calls[0], /GET .*\/public\/instruments\?instType=OPTION&uly=BTC-USD$/);
  assert.match(calls[1], /GET .*\/market\/books\?instId=BTC-USD-260621-61000-P&sz=1$/);
});

test("classifyOutcome covers all four states", () => {
  assert.equal(classifyOutcome(true, true), "both_filled");
  assert.equal(classifyOutcome(true, false), "put_orphan");
  assert.equal(classifyOutcome(false, true), "call_orphan");
  assert.equal(classifyOutcome(false, false), "neither_filled");
});

const spec: CollarHedgeSpec = { putInstId: "BTC-USD-P", callInstId: "BTC-USD-C", sizeContracts: "1", putLimitPx: "100", callLimitPx: "200", modeledPutAskUsd: 100, modeledCallBidUsd: 200 };
const fastOpts = { pollTries: 1, pollDelayMs: 0, sleep: async () => {} };

const mockClient = (fillSet: Set<string>, opts: { compFails?: boolean; imr?: number } = {}): ExecClient & { placed: string[] } => {
  const placed: string[] = [];
  return {
    mode: "demo",
    placed,
    placeOrder: async (o) => {
      placed.push(`${o.side}:${o.instId}:${o.reduceOnly ? "reduceOnly" : "open"}`);
      if (o.reduceOnly && opts.compFails) return { ok: false, code: "1", msg: "comp failed", data: [{}] };
      return { ok: true, code: "0", msg: "", data: [{ ordId: `ord-${o.instId}-${o.side}` }] };
    },
    getOrder: async (instId) => ({ ok: true, data: [{ state: fillSet.has(instId) ? "filled" : "unfilled", avgPx: instId === "BTC-USD-P" ? "101" : "199", accFillSz: "1" }] }),
    cancelOrder: async () => ({ ok: true, data: [] }),
    getPositions: async () => ({ ok: true, data: opts.imr != null ? [{ instId: "BTC-USD-C", imr: String(opts.imr) }] : [] })
  };
};

test("executor: both legs fill ⟹ safe, slippage + margin measured", async () => {
  const c = mockClient(new Set(["BTC-USD-P", "BTC-USD-C"]), { imr: 6000 });
  const r = await executeCollarHedge(c, spec, fastOpts);
  assert.equal(r.outcome, "both_filled");
  assert.equal(r.safe, true);
  assert.equal(r.putSlippageUsd, 1); // bought put at 101 vs modeled 100
  assert.equal(r.callSlippageUsd, 1); // sold call at 199 vs modeled 200
  assert.equal(r.shortLegMarginUsd, 6000);
  assert.equal(r.compensated, false);
});

test("executor: put fills, call doesn't ⟹ compensates (closes orphan put), stays safe", async () => {
  const c = mockClient(new Set(["BTC-USD-P"]));
  const r = await executeCollarHedge(c, spec, fastOpts);
  assert.equal(r.outcome, "put_orphan");
  assert.equal(r.compensated, true);
  assert.equal(r.safe, true);
  assert.ok(c.placed.some((p) => p === "sell:BTC-USD-P:reduceOnly"), "orphan put closed");
});

test("executor: call fills, put doesn't ⟹ buys back orphan call, stays safe", async () => {
  const c = mockClient(new Set(["BTC-USD-C"]));
  const r = await executeCollarHedge(c, spec, fastOpts);
  assert.equal(r.outcome, "call_orphan");
  assert.equal(r.compensated, true);
  assert.equal(r.safe, true);
  assert.ok(c.placed.some((p) => p === "buy:BTC-USD-C:reduceOnly"), "orphan call bought back");
});

test("executor: neither fills ⟹ safe, no compensation", async () => {
  const c = mockClient(new Set());
  const r = await executeCollarHedge(c, spec, fastOpts);
  assert.equal(r.outcome, "neither_filled");
  assert.equal(r.safe, true);
  assert.equal(r.compensated, false);
});

test("executor: compensation FAILURE ⟹ NOT safe, error surfaced (naked-leg alarm)", async () => {
  const c = mockClient(new Set(["BTC-USD-P"]), { compFails: true });
  const r = await executeCollarHedge(c, spec, fastOpts);
  assert.equal(r.outcome, "put_orphan");
  assert.equal(r.compensated, false);
  assert.equal(r.safe, false, "failed compensation must flag unsafe (naked leg)");
  assert.ok(r.errors.some((e) => /FAILED to close orphan/.test(e)));
});
