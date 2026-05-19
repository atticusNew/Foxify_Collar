/**
 * Bundle C scenario configurations for the backtest harness.
 *
 * Each scenario is a complete ScenarioConfig describing:
 *   - Pricing schedule per regime per tier
 *   - Launched tier set
 *   - Tier mix assumption
 *   - Venue routing per tier
 *   - Anti-bot defense state
 *
 * To add a new scenario, just append to SCENARIOS array; the harness
 * picks them up automatically.
 */

import type {
  ScenarioConfig,
  BacktestPricingSchedule,
  BacktestVenueRouting,
  BacktestVenueCostMarkup
} from "../core/types";

// ── Pricing schedules per option ──

/** Current deployed pricing — flat $2.50/$1k per user-confirmed live state */
const PRICING_CURRENT: BacktestPricingSchedule = {
  calm:   { 1: 2.5, 2: 2.5, 3: 2.5, 5: 2.5, 7: 2.5, 10: 2.5 },
  normal: { 1: 2.5, 2: 2.5, 3: 2.5, 5: 2.5, 7: 2.5, 10: 2.5 },
  stress: { 1: 2.5, 2: 2.5, 3: 2.5, 5: 2.5, 7: 2.5, 10: 2.5 }
};

/** P1 — Design A schedule as currently in code (rev 5 baseline) */
const PRICING_P1: BacktestPricingSchedule = {
  calm:   { 1: 6.5, 2: 6.5, 3: 5.0, 5: 3.0, 7: 3.0, 10: 2.0 },
  normal: { 1: 7.0, 2: 7.0, 3: 5.5, 5: 3.0, 7: 3.5, 10: 2.0 },
  stress: { 1: 9.0, 2: 10.0, 3: 7.0, 5: 4.0, 7: 5.0, 10: 2.0 }
};

/** P2 — lift floors */
const PRICING_P2: BacktestPricingSchedule = {
  calm:   { 1: 7.0, 2: 8.0, 3: 6.0, 5: 3.5, 7: 3.5, 10: 2.0 },
  normal: { 1: 7.5, 2: 8.5, 3: 6.5, 5: 4.0, 7: 4.0, 10: 2.25 },
  stress: { 1: 9.5, 2: 11.0, 3: 9.5, 5: 7.5, 7: 6.0, 10: 5.0 }
};

/** P3 — Bundle C aggressive lift, with rev 6 stress 2% adjustment ($11/$1k not $13) */
const PRICING_P3: BacktestPricingSchedule = {
  calm:   { 1: 6.5, 2: 10.0, 3: 7.0, 5: 4.0, 7: 3.0, 10: 2.0 },
  normal: { 1: 7.0, 2: 10.5, 3: 7.5, 5: 4.5, 7: 3.5, 10: 2.5 },
  stress: { 1: 9.0, 2: 11.0, 3: 11.0, 5: 9.0, 7: 7.0, 10: 6.0 } // rev 6: 2% $11 not $13
};

// ── Tier mix options ──

/** Bundle C target tier mix per rev 6 lock */
const TIER_MIX_BUNDLE_C = { 2: 0.30, 3: 0.30, 5: 0.25, 7: 0.15 };

/** Pre-rev-6 mix (with 10% instead of 7%) — used for "current baseline" */
const TIER_MIX_LEGACY = { 2: 0.30, 3: 0.30, 5: 0.20, 10: 0.20 };

// ── Venue routing options ──

/** Multi-venue routing per Bullish vs Deribit live findings */
const VENUE_MULTI: BacktestVenueRouting = {
  1: "deribit", 2: "bullish", 3: "bullish", 5: "deribit", 7: "deribit", 10: "deribit"
};

/** Bullish-only — what would happen if we didn't fall back */
const VENUE_BULLISH_ONLY: BacktestVenueRouting = {
  1: "bullish", 2: "bullish", 3: "bullish", 5: "bullish", 7: "bullish", 10: "bullish"
};

/** Deribit-only — the current pilot state */
const VENUE_DERIBIT_ONLY: BacktestVenueRouting = {
  1: "deribit", 2: "deribit", 3: "deribit", 5: "deribit", 7: "deribit", 10: "deribit"
};

// ── Venue cost markup ──

/** Per the 2026-05-13 live snapshot:
 *  - Bullish 2%: +1-4% vs Deribit
 *  - Bullish 3%: mixed (long +64%, short -38%) — average +13%
 *  - Bullish 5%: +85% (strike grid mismatch)
 *  - Bullish 7%: not measured live; estimate +30% (interpolated)
 *  - Bullish 10%: cannot serve, fallback to Deribit (markup not used)
 *  Deribit: baseline, markup = 1.0
 */
const VENUE_MARKUP_LIVE_SNAPSHOT: BacktestVenueCostMarkup = {
  bullish: { 1: 1.10, 2: 1.03, 3: 1.13, 5: 1.85, 7: 1.30, 10: 1.50 },
  deribit: { 1: 1.0, 2: 1.0, 3: 1.0, 5: 1.0, 7: 1.0, 10: 1.0 }
};

const COMMON = {
  positionsPerDay: 2,
  notionalPerPosition: 50000,
  startDay: 1,
  endDay: 28,
  tpRecoveryRate: 0.68 // R1 baseline
};

export const SCENARIOS: ScenarioConfig[] = [
  {
    name: "S0_CURRENT_BASELINE",
    description: "Hold current deployed pricing ($25/$10k flat across regimes), Deribit-only, no anti-bot. This is what the pilot is doing today.",
    pricingSchedule: PRICING_CURRENT,
    launchedTiers: [2, 3, 5, 10],
    tierMix: TIER_MIX_LEGACY,
    venueRouting: VENUE_DERIBIT_ONLY,
    venueCostMarkup: VENUE_MARKUP_LIVE_SNAPSHOT,
    antiBotDefenseEnabled: false,
    botExpectedPnLPerDay: 100,
    ...COMMON
  },
  {
    name: "S1_P1_AS_CODED",
    description: "Switch to Design A schedule already in code ($6.50-$10/$1k for 2%). Bundle C tier set + multi-venue + anti-bot.",
    pricingSchedule: PRICING_P1,
    launchedTiers: [2, 3, 5, 7],
    tierMix: TIER_MIX_BUNDLE_C,
    venueRouting: VENUE_MULTI,
    venueCostMarkup: VENUE_MARKUP_LIVE_SNAPSHOT,
    antiBotDefenseEnabled: true,
    botExpectedPnLPerDay: 100,
    ...COMMON
  },
  {
    name: "S2_P2_LIFT_FLOORS",
    description: "P2 pricing (raise calm/normal floors). Bundle C tier set + multi-venue + anti-bot. Conservative recommended baseline.",
    pricingSchedule: PRICING_P2,
    launchedTiers: [2, 3, 5, 7],
    tierMix: TIER_MIX_BUNDLE_C,
    venueRouting: VENUE_MULTI,
    venueCostMarkup: VENUE_MARKUP_LIVE_SNAPSHOT,
    antiBotDefenseEnabled: true,
    botExpectedPnLPerDay: 100,
    ...COMMON
  },
  {
    name: "S3_P3_BUNDLE_C",
    description: "P3 aggressive pricing with rev 6 stress 2% adjustment ($11/$1k not $13). Bundle C tier set + multi-venue + anti-bot. RECOMMENDED.",
    pricingSchedule: PRICING_P3,
    launchedTiers: [2, 3, 5, 7],
    tierMix: TIER_MIX_BUNDLE_C,
    venueRouting: VENUE_MULTI,
    venueCostMarkup: VENUE_MARKUP_LIVE_SNAPSHOT,
    antiBotDefenseEnabled: true,
    botExpectedPnLPerDay: 100,
    ...COMMON
  },
  {
    name: "S4_P3_BULLISH_ONLY",
    description: "P3 pricing routed entirely through Bullish (illustrative — shows why multi-venue routing is necessary; Bullish drag dominates).",
    pricingSchedule: PRICING_P3,
    launchedTiers: [2, 3, 5, 7],
    tierMix: TIER_MIX_BUNDLE_C,
    venueRouting: VENUE_BULLISH_ONLY,
    venueCostMarkup: VENUE_MARKUP_LIVE_SNAPSHOT,
    antiBotDefenseEnabled: true,
    botExpectedPnLPerDay: 100,
    ...COMMON
  },
  {
    name: "S5_P3_NO_BOT_DEFENSE",
    description: "P3 pricing without anti-bot defenses (illustrative — shows defense value). Bot extracts $100/day under this config.",
    pricingSchedule: PRICING_P3,
    launchedTiers: [2, 3, 5, 7],
    tierMix: TIER_MIX_BUNDLE_C,
    venueRouting: VENUE_MULTI,
    venueCostMarkup: VENUE_MARKUP_LIVE_SNAPSHOT,
    antiBotDefenseEnabled: false,
    botExpectedPnLPerDay: 100,
    ...COMMON
  }
];
