import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dollarsToCents,
  midCents,
  parseKalshiMarket,
  parseKalshiTrade,
} from "../src/eventCollar/kalshiPublic";
import {
  bracketingPutStrikes,
  expiryToDate,
  nearestExpiryAtOrAfter,
  parseOkxBook,
  parseOkxInstrument,
} from "../src/eventCollar/okxOptionsPublic";
import type { OkxOptionInstrument } from "../src/eventCollar/types";

test("dollarsToCents is exact and rejects junk", () => {
  assert.equal(dollarsToCents("0.4100"), 41);
  assert.equal(dollarsToCents("1.0000"), 100);
  assert.equal(dollarsToCents("0.0700"), 7);
  assert.equal(dollarsToCents("0.99"), 99);
  assert.equal(dollarsToCents("2"), 200);
  assert.equal(dollarsToCents(""), 0);
  assert.equal(dollarsToCents(undefined), 0);
  assert.equal(dollarsToCents("abc"), 0);
  assert.equal(dollarsToCents("-0.10"), 0);
});

const RAW_MARKET = {
  ticker: "KXBTCD-26SEP1117-T76899.99",
  event_ticker: "KXBTCD-26SEP1117",
  title: "Bitcoin price on Sep 11, 2026?",
  yes_sub_title: "$76,900 or above",
  floor_strike: 76899.99,
  strike_type: "greater",
  status: "active",
  open_time: "2026-09-10T21:00:00Z",
  close_time: "2026-09-11T21:00:00Z",
  yes_bid_dollars: "0.6100",
  yes_ask_dollars: "0.6300",
  last_price_dollars: "0.6200",
  volume_fp: "1520.00",
  open_interest_fp: "900.00",
  rules_primary: "If BRTI is above 76899.99 ...",
};

test("parseKalshiMarket normalizes the fields the pricer needs", () => {
  const m = parseKalshiMarket(RAW_MARKET);
  assert.equal(m.ticker, "KXBTCD-26SEP1117-T76899.99");
  assert.equal(m.strike, 76899.99);
  assert.equal(m.yesBidCents, 61);
  assert.equal(m.yesAskCents, 63);
  assert.equal(m.lastPriceCents, 62);
  assert.equal(m.volume, 1520);
  assert.equal(m.closeTime, "2026-09-11T21:00:00Z");
  assert.equal(midCents(m), 62);
});

test("midCents falls back to last print on a one-sided book", () => {
  const m = parseKalshiMarket({ ...RAW_MARKET, yes_bid_dollars: "0.0000", yes_ask_dollars: "1.0000" });
  assert.equal(midCents(m), 62);
});

test("parseKalshiTrade reads dollar prints", () => {
  const t = parseKalshiTrade({
    trade_id: "t1",
    ticker: "X",
    yes_price_dollars: "0.4100",
    count_fp: "25.00",
    created_time: "2026-09-11T09:00:00Z",
  });
  assert.equal(t.priceCents, 41);
  assert.equal(t.count, 25);
});

test("parseOkxInstrument extracts expiry/strike/type", () => {
  const i = parseOkxInstrument({ instId: "BTC-USD-260912-76750-P", ctMult: "0.01", ctVal: "1" });
  assert.ok(i);
  assert.equal(i.expiry, "260912");
  assert.equal(i.strike, 76750);
  assert.equal(i.optType, "P");
  assert.equal(i.ctMultBtc, 0.01);
  assert.equal(parseOkxInstrument({ instId: "BTC-USDT-SWAP" }), null);
});

test("expiryToDate is 08:00 UTC on the encoded date", () => {
  assert.equal(expiryToDate("260912").toISOString(), "2026-09-12T08:00:00.000Z");
});

function inst(expiry: string, strike: number, optType: "C" | "P"): OkxOptionInstrument {
  return { instId: `BTC-USD-${expiry}-${strike}-${optType}`, expiry, strike, optType, ctMultBtc: 0.01 };
}

test("nearestExpiryAtOrAfter picks the first expiry covering resolution", () => {
  const instruments = [inst("260911", 76000, "P"), inst("260912", 76000, "P"), inst("260918", 76000, "P")];
  assert.equal(nearestExpiryAtOrAfter(instruments, new Date("2026-09-11T09:00:00Z")), "260912");
  assert.equal(nearestExpiryAtOrAfter(instruments, new Date("2026-09-11T07:00:00Z")), "260911");
  assert.equal(nearestExpiryAtOrAfter(instruments, new Date("2026-09-20T00:00:00Z")), null);
});

test("bracketingPutStrikes finds the adjacent listed puts", () => {
  const instruments = [
    inst("260912", 76500, "P"),
    inst("260912", 76750, "P"),
    inst("260912", 77000, "P"),
    inst("260912", 76750, "C"),
  ];
  const b = bracketingPutStrikes(instruments, "260912", 76899.99);
  assert.ok(b);
  assert.equal(b.lowStrike, 76750);
  assert.equal(b.highStrike, 77000);
  assert.equal(b.lowInstId, "BTC-USD-260912-76750-P");
  assert.equal(b.highInstId, "BTC-USD-260912-77000-P");
  // outside the grid
  assert.equal(bracketingPutStrikes(instruments, "260912", 80_000), null);
  assert.equal(bracketingPutStrikes(instruments, "260912", 70_000), null);
});

test("parseOkxBook maps levels to numbers", () => {
  const book = parseOkxBook("X", {
    asks: [["0.0038", "332", "0", "3"]],
    bids: [["0.0037", "1610", "0", "3"]],
    ts: "123",
  });
  assert.equal(book.asks[0].priceBtc, 0.0038);
  assert.equal(book.asks[0].sizeContracts, 332);
  assert.equal(book.bids[0].priceBtc, 0.0037);
  assert.equal(book.ts, 123);
});
