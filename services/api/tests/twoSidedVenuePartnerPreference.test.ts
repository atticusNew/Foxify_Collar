/**
 * No-bias best-execution venue selection + partner tie-breaker (quoteEngine.pickLegVenue).
 *
 * Default: cheapest depth-qualified venue wins (pure best execution).
 * Opt-in: SS_VENUE_PARTNER + SS_VENUE_PARTNER_MAX_SPREAD_PCT route to the partner
 * ONLY when it's within the spread of the best venue — never when materially worse.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildQuote, type LiveAnchorProvider } from "../src/singleSide/twoSided/quoteEngine";
import { PHASE_0_CELLS } from "../src/singleSide/twoSided/cellConfig";
import { TIERS } from "../src/singleSide/twoSided/types";

const SPOT = 73000;
const CELL = PHASE_0_CELLS.pair_50k_3pct_atm_3d; // ATM straddle (put==call strike)

// Both venues quote every leg; Deribit is the cheaper (best) at 1000, Bullish at `bullishAsk`.
const anchorProvider = (bullishAsk: number): LiveAnchorProvider => ({
  getAnchorForLeg: async (strike, optType) => ({
    bullish: { venue: "bullish", symbol: `B-${strike}-${optType}`, askUsdcPerBtc: bullishAsk, depthWithin2pctBtc: 50, pulledAt: new Date().toISOString() },
    deribit: { venue: "deribit", symbol: `D-${strike}-${optType}`, askUsdcPerBtc: 1000, depthWithin2pctBtc: 50, pulledAt: new Date().toISOString() }
  })
});

const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
  try { await fn(); } finally {
    for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!; }
  }
};

const quoteVenue = async (bullishAsk: number): Promise<string> => {
  const r = await buildQuote({ cell: CELL, spot: SPOT, anchorProvider: anchorProvider(bullishAsk), tier: TIERS[0], useStabilityCache: false });
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("quote failed");
  return r.putLeg.venue;
};

test("default (no partner env): cheapest venue wins (Deribit at 1000 < Bullish 1015)", async () => {
  await withEnv({ SS_VENUE_PARTNER: undefined, SS_VENUE_PARTNER_MAX_SPREAD_PCT: undefined }, async () => {
    assert.equal(await quoteVenue(1015), "deribit", "pure best-execution → cheapest");
  });
});

test("partner tie-breaker: Bullish within 2% of best → routed to Bullish (partnership volume)", async () => {
  await withEnv({ SS_VENUE_PARTNER: "bullish", SS_VENUE_PARTNER_MAX_SPREAD_PCT: "0.02" }, async () => {
    assert.equal(await quoteVenue(1015), "bullish", "1.5% worse ≤ 2% threshold → prefer partner");
  });
});

test("partner tie-breaker: Bullish materially worse (6% > 2%) → stays on Deribit (no bias)", async () => {
  await withEnv({ SS_VENUE_PARTNER: "bullish", SS_VENUE_PARTNER_MAX_SPREAD_PCT: "0.02" }, async () => {
    assert.equal(await quoteVenue(1060), "deribit", "partner too expensive → best execution wins");
  });
});

test("partner tie-breaker: Bullish is already cheapest → naturally chosen", async () => {
  await withEnv({ SS_VENUE_PARTNER: "bullish", SS_VENUE_PARTNER_MAX_SPREAD_PCT: "0.02" }, async () => {
    assert.equal(await quoteVenue(980), "bullish", "partner is best → chosen on price alone");
  });
});
