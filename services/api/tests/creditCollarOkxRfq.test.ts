import assert from "node:assert/strict";
import test from "node:test";
import { executeRfqCollar, quoteNetCreditUsd, type RfqExecClient, type RfqQuote } from "../src/singleSide/twoSided/creditCollar/execution/okxRfqExecutor";
import type { LiveCollarPlan } from "../src/singleSide/twoSided/creditCollar/execution/okxLivePlanner";

const SPOT = 100_000;

// 50 contracts × 0.01 BTC = 0.5 BTC ≈ $50k. Model mids: put 0.0012, call 0.0028 (BTC per BTC underlying).
const plan: LiveCollarPlan = {
  side: "long",
  expiryMs: Date.UTC(2026, 6, 30, 8, 0, 0),
  expiryIso: "2026-07-30T08:00:00.000Z",
  contracts: 50,
  ctValBtc: 0.01,
  contractsBtc: 0.5,
  effectiveNotionalUsdc: 50_000,
  protective: { instId: "BTC-USD-260730-94000-P", optType: "put", action: "buy", role: "protective", listedStrike: 94_000, solverStrike: 94_000, strikeDriftPct: 0, modelMidPxBtc: 0.0012, tickSz: 0.0001 },
  funding: { instId: "BTC-USD-260730-102000-C", optType: "call", action: "sell", role: "funding", listedStrike: 102_000, solverStrike: 102_000, strikeDriftPct: 0, modelMidPxBtc: 0.0028, tickSz: 0.0001 }
};

type Calls = { created: number; cancelled: number; executed: string[] };

const makeClient = (quotes: RfqQuote[], opts: { failExecute?: boolean; noMakers?: boolean } = {}): { client: RfqExecClient; calls: Calls } => {
  const calls: Calls = { created: 0, cancelled: 0, executed: [] };
  const client: RfqExecClient = {
    mode: "demo",
    getRfqCounterparties: async () => ({ ok: true, code: "0", msg: "", data: opts.noMakers ? [] : [{ traderCode: "MAKER1" }, { traderCode: "MAKER2" }] }),
    createRfq: async () => {
      calls.created += 1;
      return { ok: true, code: "0", msg: "", data: [{ rfqId: "R1", state: "active" }] };
    },
    getRfqQuotes: async () => ({ ok: true, code: "0", msg: "", data: quotes }),
    executeRfqQuote: async (_r, quoteId) => {
      calls.executed.push(quoteId);
      if (opts.failExecute) return { ok: false, code: "70016", msg: "quote expired", data: [] };
      return { ok: true, code: "0", msg: "", data: [{ blockTdId: "BT1" }] };
    },
    cancelRfq: async () => {
      calls.cancelled += 1;
      return { ok: true, code: "0", msg: "", data: [{ rfqId: "R1" }] };
    }
  };
  return { client, calls };
};

const q = (quoteId: string, putPx: number, callPx: number): RfqQuote => ({
  quoteId,
  rfqId: "R1",
  state: "active",
  legs: [
    { instId: plan.protective.instId, px: String(putPx), sz: "50", side: "sell" },
    { instId: plan.funding.instId, px: String(callPx), sz: "50", side: "buy" }
  ]
});

const opts = { bandPct: 0.25, spotUsd: SPOT, quoteWaitMs: 100, pollDelayMs: 1, sleep: async () => {} };

test("rfq: banded quote executes as one atomic block — real premiums, fees estimated when absent", async () => {
  // put at 0.0013 (buy, inside +25% of 0.0012) · call at 0.0027 (sell, inside −25% of 0.0028)
  const { client, calls } = makeClient([q("Q1", 0.0013, 0.0027)]);
  const r = await executeRfqCollar(client, plan, opts);
  assert.equal(r.outcome, "filled");
  assert.equal(r.safe, true);
  assert.equal(r.blockTdId, "BT1");
  // Premiums: px × contracts × ctVal × spot = 0.0013×0.5×100k = $65 paid · 0.0027×0.5×100k = $135 received.
  assert.equal(r.protectivePremiumUsdc, 65);
  assert.equal(r.fundingPremiumUsdc, 135);
  // Fee estimate per leg: min(0.03% × 0.5 BTC × $100k = $15, 12.5% of premium) ⟹ put min(15, 8.13)=8.13 · call min(15, 16.88)=15.
  assert.ok(r.venueFeeUsdc != null && r.venueFeeUsdc > 20 && r.venueFeeUsdc < 25, `fees ${r.venueFeeUsdc}`);
  assert.ok(r.netCreditUsdc != null && Math.abs(r.netCreditUsdc - (135 - 65 - r.venueFeeUsdc!)) < 0.01);
  assert.equal(r.protective.withinBand, true);
  assert.equal(r.funding.withinBand, true);
  assert.equal(calls.executed[0], "Q1");
  assert.equal(calls.cancelled, 0);
});

test("rfq: the BEST banded quote wins when several arrive in the same sweep", async () => {
  // Q-worse nets 0.0025−0.0013; Q-better nets 0.0027−0.00125 — both banded.
  const { client, calls } = makeClient([q("Q-worse", 0.0013, 0.0025), q("Q-better", 0.00125, 0.0027)]);
  const r = await executeRfqCollar(client, plan, opts);
  assert.equal(r.outcome, "filled");
  assert.equal(calls.executed[0], "Q-better");
});

test("rfq: quotes outside the band are refused — RFQ cancelled, SAFE non-fill (caller falls back to the book)", async () => {
  // put quoted at 0.0016 > 0.0012×1.25 = 0.0015 ⟹ buy leg outside the band.
  const { client, calls } = makeClient([q("Q1", 0.0016, 0.0027)]);
  const r = await executeRfqCollar(client, plan, opts);
  assert.equal(r.outcome, "aborted_no_fill");
  assert.equal(r.safe, true, "block trades are all-or-none — a non-fill never leaves a naked leg");
  assert.equal(calls.executed.length, 0);
  assert.equal(calls.cancelled, 1);
});

test("rfq: no quotes by the deadline ⟹ cancel + safe non-fill", async () => {
  const { client, calls } = makeClient([]);
  const r = await executeRfqCollar(client, plan, opts);
  assert.equal(r.outcome, "aborted_no_fill");
  assert.equal(r.safe, true);
  assert.equal(calls.cancelled, 1);
});

test("rfq: no makers for this account ⟹ safe non-fill without even creating an RFQ", async () => {
  const { client, calls } = makeClient([], { noMakers: true });
  const r = await executeRfqCollar(client, plan, opts);
  assert.equal(r.outcome, "aborted_no_fill");
  assert.equal(calls.created, 0);
});

test("rfq: execute-quote failure (expired quote) ⟹ cancel + safe non-fill, nothing stands", async () => {
  const { client, calls } = makeClient([q("Q1", 0.0013, 0.0027)], { failExecute: true });
  const r = await executeRfqCollar(client, plan, opts);
  assert.equal(r.outcome, "aborted_no_fill");
  assert.equal(r.safe, true);
  assert.equal(calls.cancelled, 1);
});

test("rfq: counterparty list is capped at the OKX per-RFQ maximum (error 70107 guard)", async () => {
  const seen: string[][] = [];
  const { client } = makeClient([q("Q1", 0.0013, 0.0027)]);
  client.getRfqCounterparties = async () => ({ ok: true, code: "0", msg: "", data: Array.from({ length: 40 }, (_, i) => ({ traderCode: `MM${i}` })) });
  const origCreate = client.createRfq;
  client.createRfq = async (body) => {
    seen.push(body.counterparties);
    return origCreate(body);
  };
  const r = await executeRfqCollar(client, plan, opts);
  assert.equal(r.outcome, "filled");
  assert.equal(seen[0].length, 15, "capped at the documented max of 15");
});

test("rfq: quoteNetCreditUsd prices the package (receive cap − pay floor)", () => {
  assert.equal(quoteNetCreditUsd(q("Q", 0.0012, 0.0028), plan, SPOT), 140 - 60);
  assert.equal(quoteNetCreditUsd({ quoteId: "Q", legs: [] }, plan, SPOT), null);
});
