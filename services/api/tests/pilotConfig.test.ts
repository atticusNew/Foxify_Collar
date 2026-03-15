import assert from "node:assert/strict";
import test from "node:test";
import { parsePilotVenueMode } from "../src/pilot/config";

test("parsePilotVenueMode accepts known values", () => {
  assert.equal(parsePilotVenueMode("falconx"), "falconx");
  assert.equal(parsePilotVenueMode("deribit_test"), "deribit_test");
  assert.equal(parsePilotVenueMode("mock_falconx"), "mock_falconx");
  assert.equal(parsePilotVenueMode(undefined), "mock_falconx");
});

test("parsePilotVenueMode fails fast on unknown values", () => {
  assert.throws(() => parsePilotVenueMode("unknown_mode"), /invalid_pilot_venue_mode/);
});

