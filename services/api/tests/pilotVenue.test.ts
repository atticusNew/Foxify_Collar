import assert from "node:assert/strict";
import test from "node:test";
import { createPilotVenueAdapter, mapVenueFailureReason } from "../src/pilot/venue";

test("mock_falconx adapter returns quote and execution", async () => {
  const adapter = createPilotVenueAdapter({
    mode: "mock_falconx",
    falconx: {
      baseUrl: "https://api.falconx.io",
      apiKey: "key",
      secret: "c2VjcmV0",
      passphrase: "pass"
    },
    deribit: {} as any
  });
  const quote = await adapter.quote({
    marketId: "BTC-USD",
    instrumentId: "BTC-USD-7D-P",
    protectedNotional: 10000,
    quantity: 0.1,
    side: "buy"
  });
  assert.equal(quote.venue, "mock_falconx");
  const execution = await adapter.execute(quote);
  assert.equal(execution.status, "success");
});

test("mapVenueFailureReason normalizes known errors", () => {
  assert.equal(mapVenueFailureReason(new Error("QUOTE_EXPIRED")), "quote_expired");
  assert.equal(mapVenueFailureReason(new Error("INVALID_QUOTE_ID")), "invalid_quote_id");
  assert.equal(mapVenueFailureReason(new Error("INSUFFICIENT_CASH_BALANCE")), "insufficient_balance");
  assert.equal(mapVenueFailureReason(new Error("other")), "venue_error");
});

