import assert from "node:assert/strict";
import test from "node:test";
import { createPilotVenueAdapter } from "../src/pilot/venue";

// Regression for the c84dbbe9 bug observed 2026-04-21:
//   First real SHORT 2% trigger + TP cycle in production. Selection picked
//   $76,000 OTM call (strike $292 above trigger) when $75,500 ITM call was
//   available with healthy liquidity. Recovery ratio 8% vs R1 baseline 68%.
//   Net P&L on the trade: −$288.56.
//
// Root cause: preferItm in venue.ts was hardcoded to put-only:
//   const preferItm = targetOptionType === "put" && drawdownFloorPct <= 0.025;
// So the entire ITM-preference machinery (sort bonus, cost-score bonus,
// candidate logging) was dead code for SHORT protection.
//
// Fix: extend preferItm to fire for both directions when SL <= 2.5%.
// Also bump bonus weights for the 2% tier (0.010 vs legacy 0.002) and
// reduce strike-distance + cost-cap penalty coefficients for trigger-ITM
// strikes so the algorithm actually picks them rather than just
// nudging the score.
//
// This test mocks a Deribit connector that returns:
//   - listInstruments: 4 call options at strikes $75,500, $76,000, $76,500, $77,000
//     (matches a typical Deribit grid above spot $74,223)
//   - getOrderBook for each: $75,500 has a HIGHER ask than $76,000 (typical
//     ITM premium ~50% more expensive). If preferItm is broken (or weights
//     are too small), the selection picks $76,000 (cheaper, OTM). If the
//     fix works, $75,500 wins despite costing more.

const HOUR = 3600 * 1000;
const futureExpiry = Date.now() + 24 * HOUR; // ~1 day out

const buildMockConnector = (overrides?: {
  bookByStrike?: Record<number, { bid: number; ask: number; bidSize: number; askSize: number; mark?: number }>;
}) => {
  const defaultBook: Record<number, { bid: number; ask: number; bidSize: number; askSize: number; mark?: number }> = {
    75500: { bid: 0.0040, ask: 0.0044, bidSize: 1.0, askSize: 1.0, mark: 0.0042 }, // ITM-by-trigger; pricier
    76000: { bid: 0.0028, ask: 0.0031, bidSize: 1.0, askSize: 1.0, mark: 0.0030 }, // OTM by $292; cheaper
    76500: { bid: 0.0020, ask: 0.0023, bidSize: 1.0, askSize: 1.0, mark: 0.0022 },
    77000: { bid: 0.0014, ask: 0.0017, bidSize: 1.0, askSize: 1.0, mark: 0.0016 }
  };
  const book = overrides?.bookByStrike ?? defaultBook;

  return {
    async listInstruments(_currency: string) {
      return {
        result: Object.keys(book).map((strikeStr) => {
          const strike = Number(strikeStr);
          return {
            instrument_name: `BTC-22APR26-${strike}-C`,
            option_type: "call",
            strike,
            expiration_timestamp: futureExpiry
          };
        })
      };
    },
    async getOrderBook(instrumentId: string) {
      // Parse strike from instrument name "BTC-22APR26-{strike}-C"
      const m = /BTC-\w+-(\d+)-C/.exec(instrumentId);
      if (!m) throw new Error("unknown instrument");
      const strike = Number(m[1]);
      const entry = book[strike];
      if (!entry) throw new Error(`no book for strike ${strike}`);
      return {
        result: {
          best_bid_price: entry.bid,
          best_ask_price: entry.ask,
          best_bid_amount: entry.bidSize,
          best_ask_amount: entry.askSize,
          mark_price: entry.mark ?? (entry.bid + entry.ask) / 2,
          bids: [[entry.bid, entry.bidSize]],
          asks: [[entry.ask, entry.askSize]]
        }
      };
    },
    async getIndexPrice(_pair: string) {
      return { result: { index_price: 74223 } };
    },
    async placeOrder() {
      throw new Error("placeOrder should not be called in this test");
    }
  } as any;
};

test("SHORT 2% selection picks ITM-by-trigger call when ITM strike has liquidity (regression for c84dbbe9)", async () => {
  const adapter = createPilotVenueAdapter({
    mode: "deribit_test",
    falconx: { baseUrl: "", apiKey: "", secret: "", passphrase: "" },
    deribit: buildMockConnector(),
    quoteTtlMs: 30000,
    deribitQuotePolicy: "ask_or_mark_fallback",
    strikeSelectionMode: "trigger_aligned",
    maxTenorDriftDays: 1.5
  });

  // SHORT 2% on $20k at spot $74,223 → trigger $75,707.61
  const quote = await adapter.quote({
    marketId: "BTC-USD",
    instrumentId: "BTC-USD-1D-C",
    protectedNotional: 20000,
    quantity: 0.27, // ~ $20k / $74,223
    side: "buy",
    protectionType: "short",
    drawdownFloorPct: 0.02,
    triggerPrice: 75707.61,
    requestedTenorDays: 1,
    clientPremiumUsd: 120 // Low regime 2% on $20k = $120
  });

  // The fix should have selected $75,500 (ITM by trigger) over $76,000 (OTM
  // by $292), even though $75,500 costs ~40% more upfront. Pre-fix
  // behavior selected $76,000 — that's the bug we're regression-testing.
  const details = (quote.details || {}) as Record<string, unknown>;
  const selectedStrike = Number(details.selectedStrike);
  assert.equal(
    selectedStrike,
    75500,
    `expected $75,500 (ITM-by-trigger, even though pricier); got $${selectedStrike}. ` +
      `If this fails the ITM preference fix has regressed for SHORT protection.`
  );

  // Strike gap should now be NEGATIVE (strike below trigger by $207 = ITM)
  // instead of the pre-fix +$292 (OTM dead zone).
  const strikeGap = Number(details.strikeGapToTriggerUsd);
  assert.ok(
    strikeGap < 0,
    `expected negative strikeGap (ITM); got ${strikeGap}`
  );
});

test("LONG 2% selection still picks ITM-by-trigger put (existing behavior preserved)", async () => {
  // For LONG protection on PUT options. Trigger BELOW spot, ITM puts have
  // strike ABOVE trigger. Build a put-side book mirror image.
  const putBook: Record<number, { bid: number; ask: number; bidSize: number; askSize: number; mark?: number }> = {
    72500: { bid: 0.0020, ask: 0.0023, bidSize: 1.0, askSize: 1.0, mark: 0.0022 }, // OTM by trigger  (strike below trigger)
    73000: { bid: 0.0028, ask: 0.0031, bidSize: 1.0, askSize: 1.0, mark: 0.0030 }, // ITM by trigger (strike above)
    73500: { bid: 0.0040, ask: 0.0044, bidSize: 1.0, askSize: 1.0, mark: 0.0042 }, // deeper ITM
    74000: { bid: 0.0055, ask: 0.0060, bidSize: 1.0, askSize: 1.0, mark: 0.0057 }
  };

  const connector = {
    async listInstruments(_currency: string) {
      return {
        result: Object.keys(putBook).map((strikeStr) => {
          const strike = Number(strikeStr);
          return {
            instrument_name: `BTC-22APR26-${strike}-P`,
            option_type: "put",
            strike,
            expiration_timestamp: futureExpiry
          };
        })
      };
    },
    async getOrderBook(instrumentId: string) {
      const m = /BTC-\w+-(\d+)-P/.exec(instrumentId);
      if (!m) throw new Error("unknown");
      const strike = Number(m[1]);
      const entry = putBook[strike];
      if (!entry) throw new Error(`no book for strike ${strike}`);
      return {
        result: {
          best_bid_price: entry.bid,
          best_ask_price: entry.ask,
          best_bid_amount: entry.bidSize,
          best_ask_amount: entry.askSize,
          mark_price: entry.mark ?? (entry.bid + entry.ask) / 2,
          bids: [[entry.bid, entry.bidSize]],
          asks: [[entry.ask, entry.askSize]]
        }
      };
    },
    async getIndexPrice() {
      return { result: { index_price: 74223 } };
    },
    async placeOrder() {
      throw new Error("placeOrder should not be called");
    }
  } as any;

  const adapter = createPilotVenueAdapter({
    mode: "deribit_test",
    falconx: { baseUrl: "", apiKey: "", secret: "", passphrase: "" },
    deribit: connector,
    quoteTtlMs: 30000,
    deribitQuotePolicy: "ask_or_mark_fallback",
    strikeSelectionMode: "trigger_aligned",
    maxTenorDriftDays: 1.5
  });

  // LONG 2% on $20k at spot $74,223 → trigger $72,738.54
  const quote = await adapter.quote({
    marketId: "BTC-USD",
    instrumentId: "BTC-USD-1D-P",
    protectedNotional: 20000,
    quantity: 0.27,
    side: "buy",
    protectionType: "long",
    drawdownFloorPct: 0.02,
    triggerPrice: 72738.54,
    requestedTenorDays: 1,
    clientPremiumUsd: 120
  });

  const details = (quote.details || {}) as Record<string, unknown>;
  const selectedStrike = Number(details.selectedStrike);
  // For LONG put hedge: ITM = strike >= trigger. Closest ITM strike above
  // trigger ($72,738) is $73,000. We expect that to win.
  assert.equal(
    selectedStrike,
    73000,
    `expected $73,000 (ITM-by-trigger put); got $${selectedStrike}. ` +
      `If this fails the LONG ITM preference has regressed.`
  );
});

test("3% tier: ITM preference applies but with smaller bonus (mid-tier behavior)", async () => {
  // 3% tier sits between 2% (drawdownFloorPct 0.02) and the 0.025 cutoff.
  // The fix uses tiered bonuses: 0.010 for <=0.02, 0.005 for 0.02-0.025,
  // legacy 0.002 fallback otherwise. 3% (0.03) should NOT receive any
  // ITM preference (above the 0.025 cutoff). Verify by setting
  // drawdownFloorPct: 0.03 and confirming the cheaper OTM strike wins.
  const adapter = createPilotVenueAdapter({
    mode: "deribit_test",
    falconx: { baseUrl: "", apiKey: "", secret: "", passphrase: "" },
    deribit: buildMockConnector(),
    quoteTtlMs: 30000,
    deribitQuotePolicy: "ask_or_mark_fallback",
    strikeSelectionMode: "trigger_aligned",
    maxTenorDriftDays: 1.5
  });

  const quote = await adapter.quote({
    marketId: "BTC-USD",
    instrumentId: "BTC-USD-1D-C",
    protectedNotional: 20000,
    quantity: 0.27,
    side: "buy",
    protectionType: "short",
    drawdownFloorPct: 0.03, // 3% — above the 2.5% ITM-preference cutoff
    triggerPrice: 76450, // entry × 1.03
    requestedTenorDays: 1,
    clientPremiumUsd: 100
  });

  const details = (quote.details || {}) as Record<string, unknown>;
  const selectedStrike = Number(details.selectedStrike);
  // For 3% trigger of 76450, the candidate strikes >= trigger - buffer
  // ($76079) are 76500 (closest, cheap) and 77000. 76500 wins.
  // (75500 and 76000 are below trigger and excluded by the candidate
  // filter at venue.ts:526-533 in trigger_aligned mode.)
  assert.equal(
    selectedStrike,
    76500,
    `expected $76,500 (closest OTM call for 3%); got $${selectedStrike}. ` +
      `3% tier should NOT receive ITM preference (above the 2.5% cutoff).`
  );
});
