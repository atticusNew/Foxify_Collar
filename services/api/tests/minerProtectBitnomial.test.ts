/**
 * Miner Protect — Bitnomial read-only pricefeed (parse, hashprice conversion, probe via mock WS).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  parseBook, hupToUsdPerThDay, probeBitnomialBooks, bitnomialHashpriceProvider,
  PH_PER_TH, type WsLike
} from "../src/minerProtect/bitnomialPricefeed";

test("parseBook: book snapshot → best bid/ask/mid; non-book → null", () => {
  const b = parseBook({ type: "book", symbol: "HUPZ26", asks: [[101, 5], [102, 10]], bids: [[99, 3], [98, 4]], timestamp: "2026-06-08T15:00:00Z" });
  assert.ok(b);
  assert.equal(b!.best_ask, 101);
  assert.equal(b!.best_bid, 99);
  assert.equal(b!.mid, 100);
  assert.equal(parseBook({ type: "trade", symbol: "HUPZ26" }), null);
  assert.equal(parseBook(null), null);
  // zero-qty levels are dropped
  const z = parseBook({ type: "book", symbol: "HUP", asks: [[100, 0]], bids: [] });
  assert.equal(z!.best_ask, null);
});

test("hupToUsdPerThDay: USD per PH/day → per TH/day (÷1000)", () => {
  assert.equal(PH_PER_TH, 1000);
  assert.equal(hupToUsdPerThDay(100), 0.1);   // $100/PH/day → $0.10/TH/day
  assert.equal(hupToUsdPerThDay(0), null);
  assert.equal(hupToUsdPerThDay(null), null);
});

/** Fake WS: invokes open on the next microtask; on subscribe(send) emits preset messages then close. */
const makeFakeWs = (messages: unknown[]): { factory: () => WsLike; sent: string[] } => {
  const sent: string[] = [];
  const h: Record<string, (a?: unknown) => void> = {};
  const ws: WsLike = {
    on: (e, cb) => { h[e] = cb; },
    send: (d) => { sent.push(d); messages.forEach((m) => h.message?.(JSON.stringify(m))); h.close?.(); },
    close: () => { /* noop */ }
  };
  queueMicrotask(() => h.open?.());
  return { factory: () => ws, sent };
};

test("probeBitnomialBooks: subscribes to Book for product codes, collects snapshots by symbol", async () => {
  const { factory, sent } = makeFakeWs([
    { type: "book", symbol: "HUPZ26", asks: [[101, 5]], bids: [[99, 5]], timestamp: "t" },
    { type: "status", symbol: "X" } // ignored
  ]);
  const books = await probeBitnomialBooks(["HUP"], { wsFactory: factory, collectMs: 500 });
  assert.deepEqual(Object.keys(books), ["HUPZ26"]);
  assert.equal(books.HUPZ26.mid, 100);
  // subscribed to the book channel with our product codes
  const sub = JSON.parse(sent[0]);
  assert.equal(sub.type, "subscribe");
  assert.equal(sub.channels[0].name, "book");
  assert.deepEqual(sub.channels[0].product_codes, ["HUP"]);
});

test("bitnomialHashpriceProvider: returns live HUP hashprice in USD/TH/day", async () => {
  const { factory } = makeFakeWs([{ type: "book", symbol: "HUPM26", asks: [[120, 2]], bids: [[100, 2]] }]);
  const p = bitnomialHashpriceProvider({ wsFactory: factory, collectMs: 500 });
  const r = await p.getHashpriceUsdPerThDay();
  assert.ok(r);
  assert.equal(r!.symbol, "HUPM26");
  assert.equal(r!.usd_per_th_day, 0.11); // mid 110 / 1000
});

test("probeBitnomialBooks: resolves {} when the feed errors (e.g. market closed)", async () => {
  const errFactory = (): WsLike => {
    const h: Record<string, (a?: unknown) => void> = {};
    queueMicrotask(() => h.error?.(new Error("closed")));
    return { on: (e, cb) => { h[e] = cb; }, send: () => {}, close: () => {} };
  };
  const books = await probeBitnomialBooks(["HUP"], { wsFactory: errFactory, collectMs: 500 });
  assert.deepEqual(books, {});
});
