import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import {
  resolveVenueRouting,
  chooseExecutionVenue,
  type VenueQuoteCandidate
} from "../src/pilot/multiVenueRouter";

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.PILOT_VENUE_ROUTING_JSON;
  delete process.env.PILOT_VENUE_ROUTING_JSON;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.PILOT_VENUE_ROUTING_JSON;
  else process.env.PILOT_VENUE_ROUTING_JSON = savedEnv;
});

// ── Routing decision per tier (rev 6 defaults) ──

test("Routing rev 6: 2% primary = Bullish, fallback Deribit", () => {
  const r = resolveVenueRouting(2);
  assert.equal(r.primary, "bullish");
  assert.equal(r.fallback, "deribit");
});

test("Routing rev 6: 3% primary = Bullish, fallback Deribit", () => {
  const r = resolveVenueRouting(3);
  assert.equal(r.primary, "bullish");
  assert.equal(r.fallback, "deribit");
});

test("Routing rev 6: 5% primary = Deribit, fallback Bullish", () => {
  const r = resolveVenueRouting(5);
  assert.equal(r.primary, "deribit");
  assert.equal(r.fallback, "bullish");
});

test("Routing rev 6: 7% primary = Deribit (Bullish 1-DTE has no strikes)", () => {
  const r = resolveVenueRouting(7);
  assert.equal(r.primary, "deribit");
});

test("Routing rev 6: 10% primary = Deribit, no fallback (Bullish has nothing)", () => {
  const r = resolveVenueRouting(10);
  assert.equal(r.primary, "deribit");
  assert.equal(r.fallback, null);
});

test("Routing env override: PILOT_VENUE_ROUTING_JSON respected", () => {
  process.env.PILOT_VENUE_ROUTING_JSON = '{"2":{"primary":"deribit","fallback":"bullish","reason":"emergency_failover"}}';
  const r = resolveVenueRouting(2);
  assert.equal(r.primary, "deribit");
  assert.equal(r.fallback, "bullish");
  assert.equal(r.reason, "emergency_failover");
});

test("Routing env override: invalid JSON falls back to defaults gracefully", () => {
  process.env.PILOT_VENUE_ROUTING_JSON = "{not valid json}";
  const r = resolveVenueRouting(2);
  // Should still get default routing
  assert.equal(r.primary, "bullish");
});

// ── Execution venue choice ──

const bullishQuote = (cost: number | null): VenueQuoteCandidate => ({
  venue: "bullish",
  hedgeCostUsd: cost,
  available: cost !== null && cost > 0
});
const deribitQuote = (cost: number | null): VenueQuoteCandidate => ({
  venue: "deribit",
  hedgeCostUsd: cost,
  available: cost !== null && cost > 0
});

test("chooseExecutionVenue: primary cheaper → choose primary", () => {
  const routing = resolveVenueRouting(2);
  const choice = chooseExecutionVenue({
    routing,
    primaryQuote: bullishQuote(100),
    fallbackQuote: deribitQuote(110)
  });
  assert.equal(choice.chosenVenue, "bullish");
  assert.equal(choice.reason, "primary_within_drift_threshold");
});

test("chooseExecutionVenue: primary slightly more expensive (within 30% drift) → still primary", () => {
  const routing = resolveVenueRouting(2);
  const choice = chooseExecutionVenue({
    routing,
    primaryQuote: bullishQuote(120), // 20% over fallback
    fallbackQuote: deribitQuote(100)
  });
  assert.equal(choice.chosenVenue, "bullish");
});

test("chooseExecutionVenue: primary >30% over fallback → switch to fallback", () => {
  const routing = resolveVenueRouting(2);
  const choice = chooseExecutionVenue({
    routing,
    primaryQuote: bullishQuote(150), // 50% over fallback
    fallbackQuote: deribitQuote(100)
  });
  assert.equal(choice.chosenVenue, "deribit");
  assert.ok(choice.reason.startsWith("fallback_cheaper_by_"));
});

test("chooseExecutionVenue: primary unavailable → fallback", () => {
  const routing = resolveVenueRouting(2);
  const choice = chooseExecutionVenue({
    routing,
    primaryQuote: bullishQuote(null),
    fallbackQuote: deribitQuote(100)
  });
  assert.equal(choice.chosenVenue, "deribit");
  assert.ok(choice.reason.startsWith("primary_unavailable_fell_back"));
});

test("chooseExecutionVenue: both unavailable → primary (downstream will error)", () => {
  const routing = resolveVenueRouting(2);
  const choice = chooseExecutionVenue({
    routing,
    primaryQuote: bullishQuote(null),
    fallbackQuote: deribitQuote(null)
  });
  assert.equal(choice.chosenVenue, "bullish");
  assert.ok(choice.reason.startsWith("both_venues_unavailable"));
});

test("chooseExecutionVenue: 10% tier with no fallback → always primary", () => {
  const routing = resolveVenueRouting(10);
  assert.equal(routing.fallback, null);
  const choice = chooseExecutionVenue({
    routing,
    primaryQuote: deribitQuote(50),
    fallbackQuote: null
  });
  assert.equal(choice.chosenVenue, "deribit");
  assert.equal(choice.reason, "primary_only_no_fallback");
});

test("chooseExecutionVenue: 10% with no fallback and primary unavailable → primary anyway (will error downstream)", () => {
  const routing = resolveVenueRouting(10);
  const choice = chooseExecutionVenue({
    routing,
    primaryQuote: deribitQuote(null),
    fallbackQuote: null
  });
  // No fallback exists for 10% — must surface as "both unavailable"
  assert.equal(choice.chosenVenue, "deribit");
  assert.ok(choice.reason.startsWith("both_venues_unavailable"));
});
