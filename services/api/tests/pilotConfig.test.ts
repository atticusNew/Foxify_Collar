import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePilotHedgePolicy,
  parseDeribitMaxTenorDriftDays,
  parseDeribitQuotePolicy,
  parseDeribitStrikeSelectionMode,
  parsePositiveFinite,
  parsePositiveIntInRange,
  parsePilotVenueMode,
  resolvePilotWindow
} from "../src/pilot/config";

test("parsePilotVenueMode accepts known values", () => {
  assert.equal(parsePilotVenueMode("falconx"), "falconx");
  assert.equal(parsePilotVenueMode("deribit_test"), "deribit_test");
  assert.equal(parsePilotVenueMode("mock_falconx"), "mock_falconx");
  assert.equal(parsePilotVenueMode("ibkr_cme_live"), "ibkr_cme_live");
  assert.equal(parsePilotVenueMode("ibkr_cme_paper"), "ibkr_cme_paper");
  assert.equal(parsePilotVenueMode(undefined), "deribit_test");
});

test("parsePilotVenueMode fails fast on unknown values", () => {
  assert.throws(() => parsePilotVenueMode("unknown_mode"), /invalid_pilot_venue_mode/);
});

test("parseDeribitQuotePolicy validates known values", () => {
  assert.equal(parseDeribitQuotePolicy("ask_only"), "ask_only");
  assert.equal(parseDeribitQuotePolicy("ask_or_mark_fallback"), "ask_or_mark_fallback");
  assert.equal(parseDeribitQuotePolicy(undefined), "ask_or_mark_fallback");
  assert.throws(() => parseDeribitQuotePolicy("best_bid"), /invalid_deribit_quote_policy/);
});

test("parseDeribitStrikeSelectionMode validates known values", () => {
  assert.equal(parseDeribitStrikeSelectionMode("legacy"), "legacy");
  assert.equal(parseDeribitStrikeSelectionMode("trigger_aligned"), "trigger_aligned");
  assert.equal(parseDeribitStrikeSelectionMode(undefined), "trigger_aligned");
  assert.throws(
    () => parseDeribitStrikeSelectionMode("closest"),
    /invalid_deribit_strike_selection_mode/
  );
});

test("parseDeribitMaxTenorDriftDays enforces bounds", () => {
  assert.equal(parseDeribitMaxTenorDriftDays(undefined), 1.5);
  assert.equal(parseDeribitMaxTenorDriftDays("0"), 0);
  assert.equal(parseDeribitMaxTenorDriftDays("3.25"), 3.25);
  assert.throws(() => parseDeribitMaxTenorDriftDays("-1"), /invalid_deribit_max_tenor_drift_days/);
  assert.throws(() => parseDeribitMaxTenorDriftDays("99"), /invalid_deribit_max_tenor_drift_days/);
});

test("parsePilotHedgePolicy validates allowed values", () => {
  assert.equal(parsePilotHedgePolicy(undefined), "options_primary_futures_fallback");
  assert.equal(parsePilotHedgePolicy("options_primary_futures_fallback"), "options_primary_futures_fallback");
  assert.throws(() => parsePilotHedgePolicy("futures_only"), /invalid_pilot_hedge_policy/);
});

test("parsePositiveIntInRange validates integer bounds", () => {
  assert.equal(parsePositiveIntInRange(undefined, 7, 1, 30, "invalid"), 7);
  assert.equal(parsePositiveIntInRange("5", 7, 1, 30, "invalid"), 5);
  assert.throws(() => parsePositiveIntInRange("0", 7, 1, 30, "invalid"), /invalid:/);
  assert.throws(() => parsePositiveIntInRange("31", 7, 1, 30, "invalid"), /invalid:/);
});

test("parsePositiveFinite validates positive numeric values", () => {
  assert.equal(parsePositiveFinite(undefined, 2500, "invalid"), 2500);
  assert.equal(parsePositiveFinite("1.5", 2500, "invalid"), 1.5);
  assert.throws(() => parsePositiveFinite("0", 2500, "invalid"), /invalid:/);
  assert.throws(() => parsePositiveFinite("-5", 2500, "invalid"), /invalid:/);
});

test("resolvePilotWindow supports optional start and hard-stop duration", () => {
  const prevStart = process.env.PILOT_START_AT;
  const prevDuration = process.env.PILOT_DURATION_DAYS;
  const prevEnforce = process.env.PILOT_ENFORCE_WINDOW;
  try {
    process.env.PILOT_ENFORCE_WINDOW = "true";
    process.env.PILOT_DURATION_DAYS = "30";
    process.env.PILOT_START_AT = "";
    assert.equal(resolvePilotWindow(new Date()).status, "open");

    process.env.PILOT_START_AT = "not-a-date";
    assert.equal(resolvePilotWindow(new Date()).status, "config_invalid");

    const now = Date.now();
    process.env.PILOT_START_AT = new Date(now + 86400000).toISOString();
    assert.equal(resolvePilotWindow(new Date(now)).status, "not_started");

    process.env.PILOT_START_AT = new Date(now - 31 * 86400000).toISOString();
    assert.equal(resolvePilotWindow(new Date(now)).status, "closed");
  } finally {
    process.env.PILOT_START_AT = prevStart;
    process.env.PILOT_DURATION_DAYS = prevDuration;
    process.env.PILOT_ENFORCE_WINDOW = prevEnforce;
  }
});

