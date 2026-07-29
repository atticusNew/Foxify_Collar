import assert from "node:assert/strict";
import test from "node:test";
import { executeLiveCollar, type LiveExecClient } from "../src/singleSide/twoSided/creditCollar/execution/okxLiveCollarExecutor";
import type { LiveCollarPlan } from "../src/singleSide/twoSided/creditCollar/execution/okxLivePlanner";

// ── Plan fixture: 50-contract long-side collar, spot 100k ────────────────────
const plan: LiveCollarPlan = {
  side: "long",
  expiryMs: Date.UTC(2026, 6, 20, 8, 0, 0),
  expiryIso: new Date(Date.UTC(2026, 6, 20, 8, 0, 0)).toISOString(),
  contracts: 50,
  ctValBtc: 0.01,
  contractsBtc: 0.5,
  effectiveNotionalUsdc: 50_000,
  protective: { instId: "BTC-USD-260720-94000-P", optType: "put", action: "buy", role: "protective", listedStrike: 94_000, solverStrike: 94_000, strikeDriftPct: 0, modelMidPxBtc: 0.0012, tickSz: 0.0001 },
  funding: { instId: "BTC-USD-260720-102000-C", optType: "call", action: "sell", role: "funding", listedStrike: 102_000, solverStrike: 102_000, strikeDriftPct: 0, modelMidPxBtc: 0.0029, tickSz: 0.0001 }
};

/**
 * Scripted fake venue. Per instId, a queue of behaviors consumed per placed order:
 *   { fill: n, px, fee } — order reports filled n contracts at px (state filled if n==sz else canceled w/ partial)
 *   { reject: msg }      — placeOrder fails
 * Market (unwind) orders consume from `unwindBehaviors` instead.
 */
type Behavior = { fill: number; px?: number; fee?: number; reject?: string; stayLive?: boolean };
const makeClient = (script: Record<string, Behavior[]>, unwindScript: Record<string, Behavior[]> = {}) => {
  const orders = new Map<string, { instId: string; sz: number; b: Behavior; polls: number }>();
  const placed: Array<{ instId: string; side: string; ordType: string; sz: string; px?: string; reduceOnly?: boolean }> = [];
  let seq = 0;
  const client: LiveExecClient = {
    mode: "demo",
    placeOrder: async (o) => {
      placed.push({ instId: o.instId, side: o.side, ordType: o.ordType, sz: o.sz, px: o.px, reduceOnly: o.reduceOnly });
      const source = o.reduceOnly ? unwindScript : script; // closes are reduceOnly IOC limits (OKX options reject market)
      const b = (source[o.instId] ?? []).shift() ?? { fill: 0 };
      if (b.reject) return { ok: false, code: "51000", msg: b.reject, data: [] };
      const ordId = `ord${++seq}`;
      orders.set(ordId, { instId: o.instId, sz: Number(o.sz), b, polls: 0 });
      return { ok: true, code: "0", msg: "", data: [{ ordId }] };
    },
    getOrder: async (_instId, ordId) => {
      const o = orders.get(ordId);
      if (!o) return { ok: false, data: [] };
      o.polls += 1;
      const filled = Math.min(o.b.fill, o.sz);
      if (o.b.stayLive) return { ok: true, data: [{ state: "live", accFillSz: "0" }] };
      const state = filled >= o.sz ? "filled" : filled > 0 ? "canceled" : "canceled"; // partials surface on the cancel snapshot
      // Simulate: full fills report immediately; partial/no-fill only resolve after cancel (poll 2+).
      if (filled >= o.sz) return { ok: true, data: [{ state, avgPx: String(o.b.px ?? 0), accFillSz: String(filled), fee: String(-(o.b.fee ?? 0)) }] };
      if (o.polls < 2) return { ok: true, data: [{ state: "live", accFillSz: String(filled) }] };
      return { ok: true, data: [{ state: "canceled", avgPx: filled > 0 ? String(o.b.px ?? 0) : undefined, accFillSz: String(filled), fee: String(-(o.b.fee ?? 0)) }] };
    },
    cancelOrder: async () => ({ ok: true, data: [] }),
    getBookTop: async (instId) => ({
      ok: true,
      data: [instId.endsWith("P") ? { asks: [["0.0013", "100"]], bids: [["0.0011", "100"]] } : { asks: [["0.0031", "100"]], bids: [["0.0028", "100"]] }]
    }),
    getPositions: async () => ({ ok: true, data: [] })
  };
  return { client, placed };
};

const opts = { bandPct: 0.25, fillTimeoutMs: 50, pollDelayMs: 1, spotUsd: 100_000, sleep: async () => {} };

// ── Scenarios ─────────────────────────────────────────────────────────────────

test("live executor: both legs fill ⟹ filled, real premiums + fees + net credit", async () => {
  const { client } = makeClient({
    "BTC-USD-260720-94000-P": [{ fill: 50, px: 0.0013, fee: 0.00002 }],
    "BTC-USD-260720-102000-C": [{ fill: 50, px: 0.0028, fee: 0.00002 }]
  });
  const r = await executeLiveCollar(client, plan, opts);
  assert.equal(r.outcome, "filled");
  assert.ok(r.safe);
  // premiums: 0.0013 × 50 × 0.01 × 100k = $65 paid; 0.0028 × ... = $140 received
  assert.equal(r.protectivePremiumUsdc, 65);
  assert.equal(r.fundingPremiumUsdc, 140);
  // fees: (0.00002 + 0.00002) BTC × 100k = $4
  assert.equal(r.venueFeeUsdc, 4);
  assert.equal(r.netCreditUsdc, 140 - 65 - 4);
  assert.equal(r.protective.withinBand, true);
  assert.equal(r.funding.withinBand, true);
  assert.equal(r.alerts.length, 0);
});

test("live executor: limit prices are band-capped (ask outside band rests at the cap)", async () => {
  // Put ask 0.0013 < cap 0.0012×1.25=0.0015 ⟹ limit = ask. Call bid 0.0028 > floor 0.0029×0.75=0.002175 ⟹ limit = bid.
  const { client, placed } = makeClient({
    "BTC-USD-260720-94000-P": [{ fill: 50, px: 0.0013 }],
    "BTC-USD-260720-102000-C": [{ fill: 50, px: 0.0028 }]
  });
  await executeLiveCollar(client, plan, opts);
  const put = placed.find((p) => p.instId.endsWith("P"));
  const call = placed.find((p) => p.instId.endsWith("C"));
  assert.equal(put?.px, "0.0013");   // crossed to touch (inside band)
  assert.equal(call?.px, "0.0028");
});

test("live executor: unfilled leg retries once, then fills ⟹ filled", async () => {
  const { client, placed } = makeClient({
    "BTC-USD-260720-94000-P": [{ fill: 50, px: 0.0013 }],
    "BTC-USD-260720-102000-C": [{ fill: 0 }, { fill: 50, px: 0.0028 }] // attempt 1 no fill, attempt 2 fills
  });
  const r = await executeLiveCollar(client, plan, opts);
  assert.equal(r.outcome, "filled");
  // Two placements on the call (attempt 1 + retry), one on the put.
  assert.equal(placed.filter((p) => p.instId.endsWith("C") && p.ordType === "limit").length, 2);
  assert.equal(placed.filter((p) => p.instId.endsWith("P") && p.ordType === "limit").length, 1);
});

test("live executor: neither fills ⟹ aborted_no_fill, safe, no unwind", async () => {
  const { client } = makeClient({
    "BTC-USD-260720-94000-P": [{ fill: 0 }, { fill: 0 }],
    "BTC-USD-260720-102000-C": [{ fill: 0 }, { fill: 0 }]
  });
  const r = await executeLiveCollar(client, plan, opts);
  assert.equal(r.outcome, "aborted_no_fill");
  assert.ok(r.safe);
  assert.equal(r.unwind, null);
  assert.equal(r.netCreditUsdc, null);
});

test("live executor: one-sided fill ⟹ unwind ALL fills (short leg first), aborted_unwound", async () => {
  const { client, placed } = makeClient(
    {
      "BTC-USD-260720-94000-P": [{ fill: 0 }, { fill: 0 }],
      "BTC-USD-260720-102000-C": [{ fill: 50, px: 0.0028 }]
    },
    { "BTC-USD-260720-102000-C": [{ fill: 50, px: 0.0029 }] } // unwind buy-back fills
  );
  const r = await executeLiveCollar(client, plan, opts);
  assert.equal(r.outcome, "aborted_unwound");
  assert.ok(r.safe);
  assert.ok(r.unwind?.complete);
  assert.equal(r.unwind?.fundingClosed, 50);
  const unwindOrder = placed.find((p) => p.ordType === "ioc");
  assert.equal(unwindOrder?.instId, "BTC-USD-260720-102000-C");
  assert.equal(unwindOrder?.side, "buy");           // buying back the short call
  assert.equal(unwindOrder?.reduceOnly, true);
  assert.ok(r.alerts.some((a) => a.includes("ONE-SIDED/PARTIAL FILL")));
});

test("live executor: partial fills on both legs are fully unwound (never a resized position)", async () => {
  const { client } = makeClient(
    {
      "BTC-USD-260720-94000-P": [{ fill: 30, px: 0.0013 }, { fill: 0 }],
      "BTC-USD-260720-102000-C": [{ fill: 20, px: 0.0028 }, { fill: 0 }]
    },
    {
      "BTC-USD-260720-94000-P": [{ fill: 30, px: 0.0012 }],
      "BTC-USD-260720-102000-C": [{ fill: 20, px: 0.0029 }]
    }
  );
  const r = await executeLiveCollar(client, plan, opts);
  assert.equal(r.outcome, "aborted_unwound");
  assert.ok(r.safe);
  assert.equal(r.unwind?.protectiveClosed, 30);
  assert.equal(r.unwind?.fundingClosed, 20);
  assert.equal(r.netCreditUsdc, null); // aborted positions book nothing
});

test("live executor: failed unwind ⟹ naked_leg_unresolved, safe=false, CRITICAL alert", async () => {
  const { client } = makeClient(
    {
      "BTC-USD-260720-94000-P": [{ fill: 0 }, { fill: 0 }],
      "BTC-USD-260720-102000-C": [{ fill: 50, px: 0.0028 }]
    },
    { "BTC-USD-260720-102000-C": [{ reject: "insufficient balance", fill: 0 }] }
  );
  const r = await executeLiveCollar(client, plan, opts);
  assert.equal(r.outcome, "naked_leg_unresolved");
  assert.equal(r.safe, false);
  assert.ok(r.alerts.some((a) => a.includes("CRITICAL")));
});

test("live executor: place rejection on one leg ⟹ other leg's fill is unwound", async () => {
  const { client } = makeClient(
    {
      "BTC-USD-260720-94000-P": [{ fill: 50, px: 0.0013 }],
      "BTC-USD-260720-102000-C": [{ reject: "not activated", fill: 0 }, { reject: "not activated", fill: 0 }]
    },
    { "BTC-USD-260720-94000-P": [{ fill: 50, px: 0.0012 }] }
  );
  const r = await executeLiveCollar(client, plan, opts);
  assert.equal(r.outcome, "aborted_unwound");
  assert.ok(r.safe);
  assert.ok(r.errors.some((e) => e.includes("not activated")));
});

test("live executor: slippage measured signed vs model mid", async () => {
  const { client } = makeClient({
    "BTC-USD-260720-94000-P": [{ fill: 50, px: 0.0013 }],   // paid 0.0013 vs mid 0.0012 ⟹ +8.33% worse
    "BTC-USD-260720-102000-C": [{ fill: 50, px: 0.0028 }]   // received 0.0028 vs mid 0.0029 ⟹ +3.45% worse
  });
  const r = await executeLiveCollar(client, plan, opts);
  assert.ok(Math.abs((r.protective.slippagePctVsMid ?? 0) - 0.083333) < 1e-4);
  assert.ok(Math.abs((r.funding.slippagePctVsMid ?? 0) - 0.034483) < 1e-4);
});
