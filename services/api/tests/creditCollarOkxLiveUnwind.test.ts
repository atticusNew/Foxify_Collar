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

// ── Idempotency guard (live incident, Aug 21) ─────────────────────────────────
// A retry whose previous attempt actually filled must never re-close a flat leg: OKX ignores
// reduceOnly on options, so a repeated close-buy OPENS a fresh long. checkVenueFirst reads the
// venue's positions before placing anything; single-shot callers keep the original behavior.

test("unwind idempotency: venue flat on both legs ⟹ complete immediately, ZERO orders placed", async () => {
  let orders = 0;
  const client = {
    getBookTop: async () => ({ ok: true, data: [{ bids: [["0.01", "1"]], asks: [["0.012", "1"]] }] }),
    placeOrder: async () => {
      orders++;
      return { ok: true, data: [{ ordId: "x" }] };
    },
    getOrder: async () => ({ ok: true, data: [{ state: "filled", accFillSz: "1", avgPx: "0.01", fee: "0" }] }),
    getPositions: async () => ({ ok: true, data: [] }) // venue: FLAT
  } as never;
  const rep = await unwindLiveCollar(
    client,
    { side: "long", putInstId: "P1", callInstId: "C1", contracts: 1, ctValBtc: 0.01 },
    { spotUsd: 70_000, checkVenueFirst: true, sleep: async () => undefined }
  );
  assert.equal(rep.complete, true);
  assert.equal(orders, 0); // the whole point: nothing re-placed
  assert.match(rep.notes.join(" "), /already FLAT/);
});

test("unwind idempotency: funding already flat, protective still open ⟹ only the SELL goes out", async () => {
  const placed: string[] = [];
  const client = {
    getBookTop: async () => ({ ok: true, data: [{ bids: [["0.01", "1"]], asks: [["0.012", "1"]] }] }),
    placeOrder: async (o: { instId: string; side: string }) => {
      placed.push(`${o.side}:${o.instId}`);
      return { ok: true, data: [{ ordId: "x" }] };
    },
    getOrder: async () => ({ ok: true, data: [{ state: "filled", accFillSz: "1", avgPx: "0.01", fee: "0" }] }),
    getPositions: async () => ({ ok: true, data: [{ instId: "P1", pos: "1" }] }) // put open, call flat
  } as never;
  const rep = await unwindLiveCollar(
    client,
    { side: "long", putInstId: "P1", callInstId: "C1", contracts: 1, ctValBtc: 0.01 },
    { spotUsd: 70_000, checkVenueFirst: true, sleep: async () => undefined }
  );
  assert.deepEqual(placed, ["sell:P1"]); // no re-buy of the closed call
  assert.equal(rep.complete, false); // put row remains at the venue read taken BEFORE the sell — flat check reports honestly
});

test("unwind idempotency: default (no flag) keeps the original single-shot behavior", async () => {
  const placed: string[] = [];
  const client = {
    getBookTop: async () => ({ ok: true, data: [{ bids: [["0.01", "1"]], asks: [["0.012", "1"]] }] }),
    placeOrder: async (o: { instId: string; side: string }) => {
      placed.push(`${o.side}:${o.instId}`);
      return { ok: true, data: [{ ordId: "x" }] };
    },
    getOrder: async () => ({ ok: true, data: [{ state: "filled", accFillSz: "1", avgPx: "0.01", fee: "0" }] }),
    getPositions: async () => ({ ok: true, data: [] })
  } as never;
  await unwindLiveCollar(
    client,
    { side: "long", putInstId: "P1", callInstId: "C1", contracts: 1, ctValBtc: 0.01 },
    { spotUsd: 70_000, sleep: async () => undefined }
  );
  assert.deepEqual(placed, ["buy:C1", "sell:P1"]); // unchanged legacy sequence
});

// ── Price ladder + dust abandonment (live incident, Aug 21 #2) ────────────────
// A ~$1 OTM put with an EMPTY bid side canceled bid- and mark-referenced IOCs forever, paging the
// operator every retry. Sells of near-worthless legs now walk mark×0.9 → mark×0.5 → the minimum
// tick (an IOC limit still fills AT the best bid — the limit only floors the price); a residue
// that still can't find a bid and is worth ≤ dustMaxUsd is ABANDONED (long option, risk-free,
// settles itself at expiry) and the unwind reports complete so the retry/alert loop ends.

const ladderClient = (markPx: string, fillSellAt: string | null, positionsAfter: Array<{ instId: string; pos: string }> = []) => {
  const placed: Array<{ side: string; px: string }> = [];
  const pxByOrd = new Map<string, string>();
  let n = 0;
  const client = {
    getBookTop: async () => ({ ok: true, data: [{ bids: [["0.001", "1"]], asks: [["0.02", "1"]] }] }),
    getMarkPrice: async () => ({ ok: true, data: [{ markPx }] }),
    placeOrder: async (o: { side: string; px: string }) => {
      placed.push({ side: o.side, px: o.px });
      pxByOrd.set(`o${++n}`, o.px);
      return { ok: true, data: [{ ordId: `o${n}` }] };
    },
    getOrder: async (_i: string, ordId: string) => {
      const px = pxByOrd.get(ordId) ?? "";
      const isSell = placed.some((p) => p.side === "sell" && p.px === px);
      if (isSell && px !== fillSellAt) return { ok: true, data: [{ state: "canceled", accFillSz: "0" }] };
      return { ok: true, data: [{ state: "filled", accFillSz: "1", avgPx: px, fee: "0" }] };
    },
    getPositions: async () => ({ ok: true, data: positionsAfter })
  } as never;
  return { client, placed };
};

const smallTarget = { side: "long" as const, putInstId: "P1", callInstId: "C1", contracts: 1, ctValBtc: 0.01 };

test("unwind ladder: empty bid side ⟹ sell walks mark×0.9 → mark×0.5 → min tick and fills at the tick rung", async () => {
  // mark 0.015 ⟹ leg value $10.50 at spot 70k — inside the fire-sale line, deep rungs allowed
  const { client, placed } = ladderClient("0.015", "0.0001");
  const rep = await unwindLiveCollar(client, smallTarget, { spotUsd: 70_000, sleep: async () => undefined });
  const sells = placed.filter((p) => p.side === "sell").map((p) => p.px);
  assert.deepEqual(sells, ["0.0009", "0.0135", "0.0075", "0.0001"]); // book, mark×0.9, mark×0.5, tick
  assert.equal(rep.protectiveClose.closedContracts, 1);
  assert.equal(rep.outcome, "closed");
});

test("unwind dust: sell finds NO bid at any rung, residue ≤ dust line ⟹ ABANDONED, unwind reports complete", async () => {
  // mark 0.015 ⟹ residue ≈ $10.50 ≤ default dust line $20; venue keeps showing the put
  const { client } = ladderClient("0.015", null, [{ instId: "P1", pos: "1" }]);
  const rep = await unwindLiveCollar(client, smallTarget, { spotUsd: 70_000, sleep: async () => undefined });
  assert.equal(rep.outcome, "closed");
  assert.equal(rep.complete, true, "dusted residue must END the retry/alert loop");
  assert.match(rep.notes.join(" "), /ABANDONED AS DUST/);
  assert.ok(!rep.notes.join(" ").includes("LONG RESIDUE"));
});

test("unwind dust: residue worth MORE than the dust line is never abandoned — still long_residue", async () => {
  // mark 0.5 ⟹ leg value $350: above the fire-sale line (no deep rungs) and above the dust line
  const { client, placed } = ladderClient("0.5", null, [{ instId: "P1", pos: "1" }]);
  const rep = await unwindLiveCollar(client, smallTarget, { spotUsd: 70_000, sleep: async () => undefined });
  const sells = placed.filter((p) => p.side === "sell").map((p) => p.px);
  assert.ok(!sells.includes("0.0001"), "no fire-sale rung for a leg with real value");
  assert.ok(!sells.includes("0.25"), "no half-mark rung for a leg with real value");
  assert.equal(rep.outcome, "long_residue");
  assert.equal(rep.complete, false);
  assert.match(rep.notes.join(" "), /LONG RESIDUE/);
});

test("unwind dust: dustMaxUsd 0 disables abandonment entirely", async () => {
  const { client } = ladderClient("0.015", null, [{ instId: "P1", pos: "1" }]);
  const rep = await unwindLiveCollar(client, smallTarget, { spotUsd: 70_000, sleep: async () => undefined, dustMaxUsd: 0 });
  assert.equal(rep.outcome, "long_residue");
  assert.equal(rep.complete, false);
});

test("unwind pricing: bid-referenced IOC cancels unfilled ⟹ mark-referenced retry fills (thin-book fix)", async () => {
  const placed: Array<{ side: string; px: string }> = [];
  const pxByOrd = new Map<string, string>();
  let orderCount = 0;
  const client = {
    getBookTop: async () => ({ ok: true, data: [{ bids: [["0.001", "1"]], asks: [["0.02", "1"]] }] }),
    getMarkPrice: async () => ({ ok: true, data: [{ markPx: "0.015" }] }),
    placeOrder: async (o: { side: string; px: string }) => {
      placed.push({ side: o.side, px: o.px });
      orderCount++;
      pxByOrd.set(`o${orderCount}`, o.px);
      return { ok: true, data: [{ ordId: `o${orderCount}` }] };
    },
    // the BID-referenced sell (0.001 × 0.95, tick-floored to 0.0009) cancels unfilled; everything else fills
    getOrder: async (_i: string, ordId: string) =>
      pxByOrd.get(ordId) === "0.0009"
        ? { ok: true, data: [{ state: "canceled", accFillSz: "0" }] }
        : { ok: true, data: [{ state: "filled", accFillSz: "1", avgPx: pxByOrd.get(ordId) ?? "0", fee: "0" }] },
    getPositions: async () => ({ ok: true, data: [] })
  } as never;
  const rep = await unwindLiveCollar(
    client,
    { side: "long", putInstId: "P1", callInstId: "C1", contracts: 1, ctValBtc: 0.01 },
    { spotUsd: 70_000, sleep: async () => undefined }
  );
  // funding (buy C1): bid path priced off ask; assume filled via first candidate — the PUT (sell)
  // leg is the thin one: bid-priced sell canceled, mark×0.9 retry filled.
  const sells = placed.filter((p) => p.side === "sell");
  assert.equal(sells.length, 2); // bid-priced attempt + mark-priced retry
  assert.equal(sells[1].px, "0.0135"); // 0.015 × 0.9
  assert.equal(rep.protectiveClose.closedContracts, 1);
});
