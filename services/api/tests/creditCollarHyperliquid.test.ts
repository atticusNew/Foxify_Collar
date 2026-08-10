import { test } from "node:test";
import assert from "node:assert/strict";
import { actionHash, signL1Action, recoverL1ActionAddress, addressFromPrivateKey } from "../src/singleSide/twoSided/creditCollar/execution/perpVenues/hyperliquidSigning";
import { HyperliquidClient, roundPx, roundSz, HL_TESTNET_BASE } from "../src/singleSide/twoSided/creditCollar/execution/perpVenues/hyperliquidClient";
import { HyperliquidPerpExecutor } from "../src/singleSide/twoSided/creditCollar/execution/perpVenues/hyperliquidPerpExecutor";

const KEY = "0x" + "7".repeat(64); // throwaway test key
const ORDER_ACTION = {
  type: "order",
  orders: [{ a: 0, b: true, p: "64000", s: "0.001", r: false, t: { limit: { tif: "Ioc" } } }],
  grouping: "na"
};

test("signing: deterministic action hash + signature recovers to the signer's address", () => {
  const h1 = actionHash(ORDER_ACTION, 1_700_000_000_000);
  const h2 = actionHash(ORDER_ACTION, 1_700_000_000_000);
  assert.deepEqual(h1, h2, "action hash is deterministic");
  const h3 = actionHash(ORDER_ACTION, 1_700_000_000_001);
  assert.notDeepEqual(h1, h3, "nonce changes the hash");

  const sig = signL1Action(ORDER_ACTION, 1_700_000_000_000, KEY, true);
  assert.match(sig.r, /^0x[0-9a-f]{64}$/);
  assert.ok(sig.v === 27 || sig.v === 28);
  const recovered = recoverL1ActionAddress(ORDER_ACTION, 1_700_000_000_000, sig, true);
  assert.equal(recovered.toLowerCase(), addressFromPrivateKey(KEY).toLowerCase(), "signature recovers to signer");
  // mainnet vs testnet phantom source produces different digests ⟹ different recovery
  const recoveredWrongNet = recoverL1ActionAddress(ORDER_ACTION, 1_700_000_000_000, sig, false);
  assert.notEqual(recoveredWrongNet.toLowerCase(), addressFromPrivateKey(KEY).toLowerCase());
});

test("rounding: HL perp price (5 sig figs, 6−szDecimals decimals) and size (szDecimals)", () => {
  // BTC: szDecimals=5 ⟹ max 1 decimal place, 5 sig figs
  assert.equal(roundPx(64123.456, 5), "64123");
  assert.equal(roundPx(64000, 5), "64000");
  assert.equal(roundSz(0.0123456, 5), "0.01235");
  assert.equal(roundSz(50_000 / 64_000, 5), "0.78125");
  // low-price asset with szDecimals=0 ⟹ up to 6 decimals, 5 sig figs
  assert.equal(roundPx(0.0012345678, 0), "0.001235");
});

const mockFetch = (handler: (url: string, body: unknown) => unknown) => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl = async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    return { ok: true, status: 200, json: async () => handler(url, body) };
  };
  return { impl, calls };
};

test("client: placeOrder posts a correctly-shaped signed action and parses a fill", async () => {
  const { impl, calls } = mockFetch((url, body) => {
    if (url.endsWith("/exchange")) {
      const b = body as { action: { type: string; orders: unknown[]; grouping: string }; nonce: number; signature: { r: string; s: string; v: number } };
      assert.equal(b.action.type, "order");
      assert.equal(b.action.grouping, "na");
      assert.equal(b.nonce, 1_700_000_000_000);
      assert.match(b.signature.r, /^0x/);
      return { status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.001", avgPx: "64010.0", oid: 42 } }] } } };
    }
    throw new Error(`unexpected ${url}`);
  });
  const client = new HyperliquidClient({ baseUrl: HL_TESTNET_BASE, privateKeyHex: KEY, fetchImpl: impl as never, nowMs: () => 1_700_000_000_000 });
  const res = await client.placeOrder({ assetIndex: 0, isBuy: true, pxStr: "64000", szStr: "0.001", reduceOnly: false, tif: "Ioc" });
  assert.deepEqual(res, { kind: "filled", totalSz: 0.001, avgPx: 64010, oid: 42 });
  assert.equal(calls.length, 1);
});

test("executor: openLeg sizes from mid, sends aggressive IOC, maps fill; closeLeg is reduce-only opposite side", async () => {
  const sent: Array<{ orders: Array<{ a: number; b: boolean; p: string; s: string; r: boolean; t: { limit: { tif: string } } }> }> = [];
  const { impl } = mockFetch((url, body) => {
    const b = body as Record<string, unknown>;
    if (url.endsWith("/info") && b.type === "meta") return { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] };
    if (url.endsWith("/info") && b.type === "allMids") return { BTC: "64000" };
    if (url.endsWith("/exchange")) {
      sent.push(b.action as never);
      return { status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.78125", avgPx: "64005", oid: 7 } }] } } };
    }
    throw new Error(`unexpected ${url} ${JSON.stringify(b)}`);
  });
  const client = new HyperliquidClient({ baseUrl: HL_TESTNET_BASE, privateKeyHex: KEY, fetchImpl: impl as never, nowMs: () => 1 });
  const ex = new HyperliquidPerpExecutor(client);

  const open = await ex.openLeg({ coin: "BTC", side: "long", notionalUsdc: 50_000 });
  assert.equal(open.status, "filled");
  assert.equal(open.filledSz, 0.78125);
  const o = sent[0].orders[0];
  assert.equal(o.b, true, "long opens with a buy");
  assert.equal(o.r, false);
  assert.equal(o.t.limit.tif, "Ioc");
  assert.equal(o.s, "0.78125", "size = notional/mid rounded to szDecimals");
  assert.ok(Number(o.p) > 64_000, "aggressive buy prices above mid");

  const close = await ex.closeLeg({ coin: "BTC", side: "long", sz: 0.78125 });
  assert.equal(close.status, "filled");
  const c = sent[1].orders[0];
  assert.equal(c.b, false, "closing a long sells");
  assert.equal(c.r, true, "closes are reduce-only");
  assert.ok(Number(c.p) < 64_000, "aggressive sell prices below mid");
});

test("agent-wallet setups: position queries hit the MASTER address, not the signing key's", async () => {
  const seen: string[] = [];
  const { impl } = mockFetch((url, body) => {
    const b = body as Record<string, unknown>;
    if (url.endsWith("/info") && b.type === "clearinghouseState") {
      seen.push(String(b.user));
      return { assetPositions: [{ position: { coin: "BTC", szi: "0.00018" } }] };
    }
    if (url.endsWith("/info") && b.type === "meta") return { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] };
    throw new Error(`unexpected ${url} ${JSON.stringify(b)}`);
  });
  const MASTER = "0x" + "a".repeat(40);
  const withMaster = new HyperliquidClient({ baseUrl: HL_TESTNET_BASE, privateKeyHex: KEY, masterAddress: MASTER, fetchImpl: impl as never });
  const ex = new HyperliquidPerpExecutor(withMaster);
  assert.equal(await ex.positionSz("BTC"), 0.00018);
  assert.equal(seen[0], MASTER, "queried the master account");
  assert.equal(withMaster.address().toLowerCase() === MASTER.toLowerCase(), false, "master differs from the signing key's address");

  const withoutMaster = new HyperliquidClient({ baseUrl: HL_TESTNET_BASE, privateKeyHex: KEY, fetchImpl: impl as never });
  await new HyperliquidPerpExecutor(withoutMaster).positionSz("BTC");
  assert.equal(seen[1], withoutMaster.address(), "falls back to the key's own address when no master set");
});

test("executor: error status and dust-size guard surface honestly", async () => {
  const { impl } = mockFetch((url, body) => {
    const b = body as Record<string, unknown>;
    if (url.endsWith("/info") && b.type === "meta") return { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] };
    if (url.endsWith("/info") && b.type === "allMids") return { BTC: "64000" };
    if (url.endsWith("/exchange")) return { status: "ok", response: { type: "order", data: { statuses: [{ error: "Insufficient margin" }] } } };
    throw new Error("unexpected");
  });
  const client = new HyperliquidClient({ baseUrl: HL_TESTNET_BASE, privateKeyHex: KEY, fetchImpl: impl as never, nowMs: () => 1 });
  const ex = new HyperliquidPerpExecutor(client);
  const res = await ex.openLeg({ coin: "BTC", side: "short", notionalUsdc: 50_000 });
  assert.equal(res.status, "error");
  assert.match(res.message ?? "", /Insufficient margin/);
  const dust = await ex.openLeg({ coin: "BTC", side: "long", notionalUsdc: 0.01 });
  assert.equal(dust.status, "error");
  assert.match(dust.message ?? "", /rounds to 0/);
});
