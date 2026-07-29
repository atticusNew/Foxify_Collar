import assert from "node:assert/strict";
import test from "node:test";
import { unwindLiveCollar } from "../src/singleSide/twoSided/creditCollar/execution/okxLiveUnwind";
import type { LiveExecClient } from "../src/singleSide/twoSided/creditCollar/execution/okxLiveCollarExecutor";

const target = {
  side: "long" as const,
  putInstId: "BTC-USD-260720-94000-P",
  callInstId: "BTC-USD-260720-102000-C",
  contracts: 50,
  ctValBtc: 0.01
};

type Script = Record<string, Array<{ fill: number; px?: number; fee?: number; reject?: string }>>;

const makeClient = (script: Script, positionsAfter: Array<{ instId: string; pos: string }> = []) => {
  const orders = new Map<string, { b: { fill: number; px?: number; fee?: number } ; sz: number }>();
  const placed: Array<{ instId: string; side: string; reduceOnly?: boolean }> = [];
  let seq = 0;
  const client: LiveExecClient = {
    mode: "live",
    placeOrder: async (o) => {
      placed.push({ instId: o.instId, side: o.side, reduceOnly: o.reduceOnly });
      const b = (script[o.instId] ?? []).shift() ?? { fill: 0 };
      if (b.reject) return { ok: false, code: "51000", msg: b.reject, data: [] };
      const ordId = `u${++seq}`;
      orders.set(ordId, { b, sz: Number(o.sz) });
      return { ok: true, code: "0", msg: "", data: [{ ordId }] };
    },
    getOrder: async (_i, ordId) => {
      const o = orders.get(ordId);
      if (!o) return { ok: false, data: [] };
      const filled = Math.min(o.b.fill, o.sz);
      const state = filled >= o.sz ? "filled" : "canceled";
      return { ok: true, data: [{ state, avgPx: String(o.b.px ?? 0), accFillSz: String(filled), fee: String(-(o.b.fee ?? 0)) }] };
    },
    cancelOrder: async () => ({ ok: true, data: [] }),
    // Closes are book-priced IOC limits now (OKX options reject market orders) — give every leg a live top.
    getBookTop: async () => ({ ok: true, data: [{ bids: [["0.001", "99"]], asks: [["0.002", "99"]] }] }),
    getPositions: async () => ({ ok: true, data: positionsAfter })
  };
  return { client, placed };
};

test("unwind: an EMPTY book yields no safe IOC reference — nothing placed, position rides fully hedged", async () => {
  const { client, placed } = makeClient({ "BTC-USD-260720-102000-C": [{ fill: 50, px: 0.001 }] });
  client.getBookTop = async () => ({ ok: true, data: [] });
  const r = await unwindLiveCollar(client, target, { spotUsd: 100_000, sleep: async () => {}, pollDelayMs: 1 });
  assert.equal(r.outcome, "rides_to_expiry");
  assert.equal(placed.length, 0, "no order without a price reference");
  assert.ok(r.notes.some((n) => n.includes("EMPTY BOOK")));
});

test("unwind: closes SHORT (funding) leg FIRST, then the long; verifies flat; nets the value", async () => {
  const { client, placed } = makeClient({
    "BTC-USD-260720-102000-C": [{ fill: 50, px: 0.001, fee: 0.00001 }],  // buy-back cost 0.001×0.5×100k = $50
    "BTC-USD-260720-94000-P": [{ fill: 50, px: 0.002, fee: 0.00001 }]    // sale proceeds 0.002×0.5×100k = $100
  });
  const r = await unwindLiveCollar(client, target, { spotUsd: 100_000, sleep: async () => {}, pollDelayMs: 1 });
  assert.equal(r.outcome, "closed");
  assert.ok(r.complete);
  assert.equal(placed[0].instId, target.callInstId); // short first
  assert.equal(placed[0].side, "buy");
  assert.equal(placed[0].reduceOnly, true);
  assert.equal(placed[1].instId, target.putInstId);
  assert.equal(placed[1].side, "sell");
  // value = 100 − 50 − fees(0.00002 BTC × 100k = $2) = $48
  assert.equal(r.unwindValueUsdc, 48);
  assert.equal(r.verifiedFlat, true);
});

test("unwind: short-perp mirror closes the short PUT first", async () => {
  const { client, placed } = makeClient({
    "BTC-USD-260720-94000-P": [{ fill: 50, px: 0.001 }],
    "BTC-USD-260720-102000-C": [{ fill: 50, px: 0.002 }]
  });
  const r = await unwindLiveCollar(client, { ...target, side: "short" }, { spotUsd: 100_000, sleep: async () => {}, pollDelayMs: 1 });
  assert.equal(r.outcome, "closed");
  assert.equal(placed[0].instId, target.putInstId); // short-perp hedge: funding = the put
  assert.equal(placed[0].side, "buy");
});

test("unwind: short-leg buy-back fails ⟹ STOP before the long leg — position rides fully hedged", async () => {
  const { client, placed } = makeClient({
    "BTC-USD-260720-102000-C": [{ reject: "no liquidity", fill: 0 }]
  });
  const r = await unwindLiveCollar(client, target, { spotUsd: 100_000, sleep: async () => {}, pollDelayMs: 1 });
  assert.equal(r.outcome, "rides_to_expiry");
  assert.equal(r.complete, false);
  assert.equal(placed.length, 1); // never touched the long leg
  assert.ok(r.notes.some((n) => n.includes("rides to expiry")));
});

test("unwind: long-leg sale incomplete ⟹ long_residue (bounded risk), flagged", async () => {
  const { client } = makeClient(
    {
      "BTC-USD-260720-102000-C": [{ fill: 50, px: 0.001 }],
      "BTC-USD-260720-94000-P": [{ fill: 20, px: 0.002 }] // partial close
    },
    [{ instId: "BTC-USD-260720-94000-P", pos: "30" }]
  );
  const r = await unwindLiveCollar(client, target, { spotUsd: 100_000, sleep: async () => {}, pollDelayMs: 1 });
  assert.equal(r.outcome, "long_residue");
  assert.equal(r.complete, false);
  assert.ok(r.notes.some((n) => n.includes("LONG RESIDUE")));
});
