import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildShowcasePosition,
  DEFAULT_PICK_CONFIG,
  pickShowcaseMarket,
} from "../src/eventCollar/showcasePicker";
import type { KalshiMarket, KalshiTrade } from "../src/eventCollar/types";

const NOW = new Date("2026-09-11T12:00:00Z");

function market(overrides: Partial<KalshiMarket>): KalshiMarket {
  return {
    ticker: "T",
    eventTicker: "E",
    title: "Bitcoin price?",
    subtitle: "$76,900 or above",
    strike: 76899.99,
    strikeType: "greater",
    status: "active",
    openTime: "2026-09-10T21:00:00Z",
    closeTime: "2026-09-11T21:00:00Z",
    yesBidCents: 60,
    yesAskCents: 62,
    lastPriceCents: 61,
    volume: 100,
    openInterest: 50,
    rulesPrimary: "",
    ...overrides,
  };
}

test("pickShowcaseMarket: liquidity first, inside the quotable band", () => {
  const picked = pickShowcaseMarket(
    [
      market({ ticker: "thin", volume: 5 }),
      market({ ticker: "liquid", volume: 900 }),
      market({ ticker: "extreme", volume: 5000, yesBidCents: 97, yesAskCents: 99, lastPriceCents: 98 }),
      market({ ticker: "closed", status: "closed", volume: 9999 }),
      market({ ticker: "too_soon", volume: 9999, closeTime: "2026-09-11T12:20:00Z" }),
    ],
    NOW,
  );
  assert.ok(picked);
  assert.equal(picked.market.ticker, "liquid");
  assert.equal(picked.markCents, 61);
});

test("pickShowcaseMarket: null when nothing is quotable", () => {
  assert.equal(pickShowcaseMarket([market({ status: "closed" })], NOW), null);
  assert.equal(
    pickShowcaseMarket(
      [market({ closeTime: new Date(NOW.getTime() + 30 * 60_000).toISOString() })],
      NOW,
      DEFAULT_PICK_CONFIG,
    ),
    null,
  );
});

function trade(priceCents: number, createdTime: string): KalshiTrade {
  return { tradeId: `t${priceCents}`, ticker: "T", priceCents, count: 10, createdTime };
}

test("buildShowcasePosition: oldest real print below mark wins (the hero story)", () => {
  const trades = [
    trade(58, "2026-09-11T11:00:00Z"), // newest first
    trade(44, "2026-09-11T09:00:00Z"),
    trade(41, "2026-09-11T08:00:00Z"), // oldest
  ];
  const pos = buildShowcasePosition(trades, 61, 150);
  assert.equal(pos.entryCents, 41);
  assert.equal(pos.entrySource, "real_print");
  assert.equal(pos.contracts, 150);
});

test("buildShowcasePosition: falls back to oldest print, then to entered-now", () => {
  const above = buildShowcasePosition([trade(70, "2026-09-11T08:00:00Z")], 61, 150);
  assert.equal(above.entryCents, 70);
  assert.equal(above.entrySource, "real_print");
  const none = buildShowcasePosition([], 61, 150);
  assert.equal(none.entryCents, 61);
  assert.equal(none.entrySource, "entered_now");
});
