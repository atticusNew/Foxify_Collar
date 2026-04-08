# Agent Prompt: V7 Pricing Integration — Pilot Production + Live Readiness

## CRITICAL INSTRUCTION

**DO NOT make any code changes yet.** Your first response must be a complete summary of:
1. Every file you plan to modify and why
2. Every file you plan to create and why
3. Every file/module you plan to remove or deprecate and why
4. A dependency graph showing the order of changes
5. Any risks or concerns you identify
6. Questions you have before proceeding

Wait for explicit confirmation before writing any code.

---

## Context

You are integrating a new pricing model (V7) into an existing Bitcoin options trading platform that is currently running as a pilot on Bullish SimNext. The platform sells "protection" to BTC perpetual traders — they pay a premium for coverage, and if BTC hits their stop-loss, they receive an instant payout. The platform hedges by buying put options.

### What Changed (V7 Pricing Model)

The backtest analysis (V1-V7) determined the following optimal configuration:

**Product structure:**
- 2-day rolling protection (renewable), replacing the previous 7-day tenor
- Trigger-strike put hedge (option strike = entry price × (1 - SL%))
- Naked puts for all SL tiers (spreads evaluated but naked won in calm/normal)
- Regime-dynamic pricing based on Deribit DVOL (BTC Volatility Index)

**Regime definitions (data-driven, not arbitrary):**
- CALM: DVOL below ~40% (30th percentile of historical data) — ~30% of the time
- NORMAL: DVOL 40% – 65% (30th-80th percentile) — ~50% of the time  
- STRESS: DVOL above ~65% (80th percentile) — ~20% of the time
- Fallback: Use 30-day realized vol with same thresholds if DVOL unavailable

**Premium schedule (per $1k notional / per $10k position):**

| SL% | CALM | NORMAL | STRESS | Payout/$10k |
|-----|------|--------|--------|-------------|
| 1% | $5/1k ($50/10k) | $9/1k ($90/10k) | PAUSE | $100 |
| 2% | $3/1k ($30/10k) | $6/1k ($60/10k) | $13/1k ($130/10k) | $200 |
| 3% | $2/1k ($20/10k) | $5/1k ($50/10k) | $12/1k ($120/10k) | $300 |
| 5% | $2/1k ($20/10k) | $4/1k ($40/10k) | $10/1k ($100/10k) | $500 |
| 10% | $1/1k ($10/10k) | $2/1k ($20/10k) | $6/1k ($60/10k) | $1,000 |

**Recovery model:**
- Post-trigger: Sell option at BS value (intrinsic + time value), not just intrinsic
- Early-close: If trader closes position before expiry, recoup remaining option value
- Optimal take-profit: Sell option at peak value within the 2-day window

**Hedge venue:**
- Primary: Bullish (SimNext for pilot, mainnet for production)
- DVOL signal: Fetched from Deribit public API (read-only, no trading on Deribit)
- Deribit/FalconX: Keep adapters in place but inactive for pilot

---

## Platform Architecture (Current State)

```
/workspace
├── apps/web/                    # React frontend (Vite)
├── packages/shared/             # @foxify/shared types
├── services/
│   ├── api/                     # Fastify API server
│   │   ├── src/pilot/           # PILOT MODULE — main integration target
│   │   │   ├── config.ts        # Pilot config, Bullish config, premium config
│   │   │   ├── premiumRegime.ts # Premium regime overlay (calm/watch/stress)
│   │   │   ├── protectionMath.ts # Payout calculations
│   │   │   ├── bullish.ts       # Bullish trading client
│   │   │   ├── venue.ts         # Venue adapters (Deribit, Bullish)
│   │   │   ├── routes.ts        # API routes
│   │   │   └── migrate.ts       # DB migrations
│   │   ├── scripts/             # Backtest scripts (V1-V7, regime definition)
│   │   └── tests/               # Test files
│   ├── broker-bridge/           # IBKR gateway (NO LONGER NEEDED)
│   ├── connectors/              # Exchange connectors
│   │   └── src/deribitConnector.ts  # Deribit public API (keep for DVOL)
│   └── hedging/                 # Hedging service
├── docs/pilot-reports/          # Backtest results, regime definition
└── package.json                 # Workspace root
```

### Key Existing Modules to Understand Before Changing

1. **`services/api/src/pilot/config.ts`** — Contains `pilotConfig`, `BullishRuntimeConfig`, premium regime config, tier configs with fixed premiums per $1k. This is where the current premium schedule lives.

2. **`services/api/src/pilot/premiumRegime.ts`** — Current regime overlay system with `normal`/`watch`/`stress` levels. This needs to be replaced with the V7 DVOL-based regime system (CALM/NORMAL/STRESS with different thresholds and premium multipliers).

3. **`services/api/src/pilot/protectionMath.ts`** — Payout and drawdown calculations. The payout math itself doesn't change, but the tenor (7d → 2d) and premium computation flow does.

4. **`services/api/src/pilot/bullish.ts`** — The Bullish trading client. DO NOT modify this. It works correctly for SimNext and will work for mainnet.

5. **`services/api/src/pilot/venue.ts`** — Venue adapters. The Bullish adapter stays. Deribit adapter stays but remains inactive for trading. Add a read-only DVOL fetcher.

6. **`services/api/src/pilot/routes.ts`** — API routes that serve premium quotes, protection purchases, etc. These need to use the new pricing.

7. **`services/connectors/src/deribitConnector.ts`** — Has `getIndexPrice()` and public API methods. Keep this. Add a `getDVOL()` method or use existing infrastructure to fetch DVOL.

8. **`apps/web/`** — Frontend. Needs targeted updates to show regime-based pricing and current regime indicator. Do NOT redesign or overhaul the UI.

9. **`services/broker-bridge/`** — IBKR gateway bridge. No longer needed. Can be deprecated but do NOT delete — just ensure it's not imported or started anywhere active.

---

## Specific Changes Required

### 1. Regime Classification Engine (NEW)

Create a regime classification module that:
- Fetches DVOL from Deribit public API (`/public/get_volatility_index_data`)
- Caches the result for 5 minutes (don't hit Deribit on every quote)
- Falls back to 30-day realized vol if DVOL is unavailable
- Classifies: CALM (<40%), NORMAL (40-65%), STRESS (>65%)
- Exposes: `getCurrentRegime(): Promise<{ regime: "calm" | "normal" | "stress", dvol: number | null, rvol: number, source: "dvol" | "rvol" }>`

### 2. Premium Pricing Engine (REPLACE)

Replace the current fixed/hybrid premium model with V7 regime-dynamic pricing:
- Input: SL tier (1/2/3/5/10%), notional, current regime
- Output: premium amount, regime used, whether protection is available
- The premium schedule is the table above
- If regime = STRESS and SL = 1%: return `{ available: false, reason: "paused_in_stress" }`
- Premium = (premiumPer1k for this tier+regime) × (notional / 1000)

### 3. Tenor Change (7d → 2d)

- Update the default protection tenor from 7 days to 2 days
- This affects: option selection (buy 2-day puts instead of 7-day), protection expiry, renewal flow
- Make tenor configurable via config (not hardcoded) for future flexibility

### 4. Recovery Model Update

- When selling an option post-trigger, compute BS value with remaining time (not just intrinsic)
- When a trader closes early, compute remaining option value and log the recovery
- This mainly affects the hedging service and P&L tracking

### 5. Config Updates

- Update `pilotConfig` to reflect V7 premium schedule
- Add regime thresholds to config (DVOL calm threshold, stress threshold)
- Update tier definitions with new premium-per-1k values per regime
- Keep config structure backward-compatible where possible

### 6. Frontend Updates (TARGETED ONLY)

- Show the current regime indicator (CALM/NORMAL/STRESS) with the DVOL reading
- Update premium display to show the regime-appropriate price
- If a tier is PAUSED in current regime, show it as unavailable with explanation
- Update any hardcoded 7-day references to 2-day
- Do NOT change layout, styling, components, or navigation

### 7. IBKR Deprecation

- Remove IBKR/broker-bridge from any active imports, startup sequences, or docker-compose services
- Do NOT delete the files — just ensure they're inert
- Remove any IBKR-specific env var requirements from startup validation

### 8. Deribit Read-Only Integration

- The `DeribitConnector` stays for DVOL fetching (public endpoint, no auth needed)
- Add a `getDVOL()` method if not already present
- This is read-only — no trading on Deribit for pilot
- Ensure the connector doesn't require credentials for public endpoints

---

## Constraints

1. **DO NOT modify `services/api/src/pilot/bullish.ts`** — The Bullish client is working and tested
2. **DO NOT overhaul the frontend** — Surgical updates only
3. **DO NOT delete IBKR/broker-bridge files** — Deprecate in place
4. **DO NOT add new dependencies** unless absolutely necessary
5. **All financial calculations must use appropriate precision** — Decimal where available, careful floating point otherwise
6. **Changes must be backward-compatible** — If the V7 config is missing, fall back to current behavior
7. **Pilot code must be cleanly separable** — Any pilot-only code should be behind feature flags or in clearly marked modules so it can be lifted out or promoted to production
8. **Test coverage** — Add or update tests for new pricing logic, regime classification
9. **No stale code** — Remove any dead code paths that reference the old 7-day fixed pricing in active flows. Old backtest scripts in `scripts/` can stay (they're reference material)
10. **Logging** — Log regime classification, premium calculation, and DVOL readings for every quote and protection purchase

---

## What "Pilot Production" Means

- This runs on Bullish SimNext with real (test) trades
- It serves real users in a controlled pilot
- It must be stable, performant, and correct
- When pilot is approved, the transition to production is:
  1. Change Bullish URL from SimNext to mainnet
  2. Enable real credentials
  3. No code changes needed for the transition

---

## What "Live Production Ready" Means

When the pilot is approved and we go to mainnet:
- Everything in the pilot should work as-is on mainnet
- No pilot-specific hacks that would need removal
- The only change is config (URLs, credentials)
- Deribit DVOL fetching works the same on mainnet (public API)
- Bullish client works the same on mainnet (just different base URL)

---

## Files to Read Before Planning

Read these files completely before creating your plan:
1. `services/api/src/pilot/config.ts` — Current config structure
2. `services/api/src/pilot/premiumRegime.ts` — Current regime system
3. `services/api/src/pilot/protectionMath.ts` — Payout math
4. `services/api/src/pilot/routes.ts` — API routes
5. `services/api/src/pilot/venue.ts` — Venue adapters
6. `services/connectors/src/deribitConnector.ts` — Deribit connector
7. `apps/web/src/` — Frontend source (understand the component structure)
8. `docs/pilot-reports/backtest_definitive_v7_results.txt` — V7 pricing tables
9. `docs/pilot-reports/regime_definition.txt` — Regime boundary definitions
10. `services/api/src/pilot/bullish.ts` — Bullish client (read-only, do not modify)

---

## Deliverables

1. Updated pricing engine with V7 regime-dynamic premiums
2. DVOL-based regime classification with RVol fallback
3. 2-day tenor as default (configurable)
4. Updated config with V7 premium schedule
5. Frontend regime indicator and updated pricing display
6. IBKR deprecated from active flows
7. Tests for new pricing and regime logic
8. No stale code in active paths
9. Clean separation between pilot and production concerns

---

## Summary Format for Your First Response

Structure your first response as:

### 1. Understanding
- Restate the objectives in your own words
- List any assumptions you're making

### 2. Files to Modify
| File | Change Type | Description |
|------|------------|-------------|

### 3. Files to Create
| File | Purpose |
|------|---------|

### 4. Files to Deprecate
| File | How |
|------|-----|

### 5. Change Order
1. First: ...
2. Then: ...
3. Finally: ...

### 6. Risks
- Risk 1: ...
- Risk 2: ...

### 7. Questions
- Question 1: ...

Then wait for my confirmation before proceeding.
