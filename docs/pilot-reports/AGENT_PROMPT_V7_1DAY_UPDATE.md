# Agent Update: Switch V7 to 1-Day Rolling Tenor with Flat $8/1k Premium

## Context

You are implementing V7 pricing for the Atticus/Foxify perp protection platform. A previous agent (or you in a prior session) began V7 implementation with 7-day tenor and regime-adjusted pricing. **That approach is now superseded.** New backtest results show that 1-day rolling tenor with flat pricing is dramatically more profitable and simpler.

## What Changed and Why

Backtest results at `/workspace/docs/pilot-reports/backtest_1day_tenor_results.txt` show:

**1-day tenor is 36-91% cheaper than 7-day across all SL tiers:**

| SL% | 1-Day BE/$1k | 7-Day BE/$1k | Reduction | 1d Trigger Rate |
|-----|-------------|-------------|-----------|----------------|
| 1% | $5.55 | $8.71 | 36% cheaper | 61% |
| 2% | $6.34 | $15.25 | 58% cheaper | 35% |
| 3% | $5.52 | $18.54 | 70% cheaper | 21% |
| 5% | $3.32 | $20.64 | 84% cheaper | 8% |
| 10% | $1.12 | $13.14 | 91% cheaper | 1% |

**At $8/1k flat premium, every tier is profitable with 1-day tenor:**

| SL% | P&L/trade | Win Rate |
|-----|-----------|---------|
| 1% | +$2.45 | 55% |
| 2% | +$1.66 | 71% |
| 3% | +$2.48 | 82% |
| 5% | +$4.68 | 93% |
| 10% | +$6.88 | 99% |

**Live Deribit mainnet prices confirm** (1-day puts, real market, April 8 2026):

| SL% | Strike | Hedge/$1k | Spread at $8 prem |
|-----|--------|-----------|-------------------|
| 1% | $71,000 | $4.40 | +$3.60 |
| 2% | $70,500 | $2.70 | +$5.30 |
| 3% | $69,500 | $1.10 | +$6.90 |
| 5% | $68,000 | $0.40 | +$7.60 |
| 10% | $64,500 | $0.10 | +$7.90 |

**Regime pricing is NOT needed.** Even during stress periods (vol > 65%), the overall average P&L stays positive at flat $8/1k. Stress is only 19% of days and calm/normal profits offset stress losses.

## Your Instructions

### Remove from V7:
1. **Regime pricing logic** -- no calm/normal/stress premium tiers. Single flat premium.
2. **7-day tenor** -- replace with 1-day throughout.
3. **Regime overlay, premium state machine, dwell/hysteresis** -- none of this is needed for flat pricing.

### V7 Final Configuration:

```
TENOR: 1 day (rolling daily)
PREMIUM: $8 per $1k notional (flat, all tiers, all conditions)
SL TIERS: [1, 2, 3, 5, 10] (percent)
PAYOUT: notional × SL% (e.g., $10k × 2% = $200)
TRIGGER: entryPrice × (1 - SL/100)
HEDGE: Buy 1-day put option at strike = trigger price
AUTO-RENEW: Daily. At expiry, if position still open, buy new 1-day put at current spot.
```

### What the trader sees:
```
Position: BTC Long $10,000
Stop Loss: 2%
Premium: $80 per day
Payout if triggered: $200
Protection: renews daily at midnight UTC
```

### What the platform does:
```
1. Trader buys protection → platform buys 1-day put at 2% OTM ($2.70/1k hedge cost)
2. Platform collects $8/1k premium, pays $2.70/1k hedge → immediate $5.30 spread
3. End of day: option expires or is exercised
4. If triggered during the day: pay trader $200, keep option (take-profit if value > payout × 1.3)
5. If not triggered: option expires worthless, platform keeps $5.30 profit
6. Next day: auto-renew buys new 1-day put at current spot price
```

### Premium calculation:
```
premium = positionSize / 1000 * 8
```
That's it. No regime, no tier-based rates, no hybrid pricing, no treasury subsidy logic.

### Key implementation details:

**Frontend (`PilotWidget.tsx`):**
- Change tenor display from "5 days" or "7 days" to "1 day (daily rolling)"
- Premium display: "$8 per $1k per day" 
- Auto-renew is the default and primary mode — each day is a new protection cycle
- The "per day" framing is important for the trader: they pay $80/day for $10k coverage

**Backend (`routes.ts`):**
- `FIXED_PREMIUM_PER_1K` = 8 (was 11)
- Tenor = 1 day (was 7)
- Remove all regime pricing code paths for the locked profile
- The quote and activate endpoints stay the same, just with different constants

**Config (`config.ts`):**
- `fixedTenorDays` = 1 (was 7)
- Remove or bypass `premiumRegime` for locked profile
- `fixedPricingMode` can be simplified to just "fixed_flat"

**Venue (`venue.ts`):**
- Option selection: look for puts expiring within 0.5-2 days (was 3-14 days)
- The `maxDrift` tenor filter should accept options expiring in 0.5 to 2.5 days
- Everything else (IOC execution, REST fill confirmation, order format) stays the same

**funded_levels.json:**
- Update `fixed_price_usdc` to "8" for all tiers
- Update `expiry_days` to "1" for all tiers

### Files to modify:
- `services/api/src/pilot/routes.ts` — premium override, tenor
- `services/api/src/pilot/config.ts` — locked profile tenor and pricing mode
- `services/api/src/pilot/venue.ts` — option selection tenor filter
- `apps/web/src/PilotWidget.tsx` — tenor display, premium constant
- `configs/funded_levels.json` — rates and tenor
- `apps/web/public/funded_levels.json` — same
- `render.yaml` — `PILOT_TENOR_DEFAULT_DAYS: "1"`
- Tests that reference old rates/tenors

### What NOT to change:
- The Bullish adapter execution flow (IOC, REST status poll, order format)
- The trigger monitor logic (still polls and checks breach)
- The DB schema (sl_pct column addition is fine, keep tier_name compat)
- The admin dashboard
- The multi-position frontend (positions, balance, settlement)
- The take-profit logic (still valuable — sell option on breach if profitable)

### Auto-renew implementation:
The 1-day rolling model means protection renews daily. Implementation:
- At protection expiry (end of day UTC), if the position is still open and auto-renew is on:
  1. Fetch current BTC spot price
  2. Compute new trigger from current spot (NOT original entry)
  3. Buy new 1-day put at new trigger strike
  4. Deduct new premium from balance
  5. Create new protection record linked to the position
- This is a backend cron/interval job, not a frontend action
- The trader sees continuous protection, the backend manages daily rollovers

### Branch
All changes on: `cursor/-bc-c2468b87-16cc-4357-84a5-12c8079ff3c2-6ba4`

### Testing
- Run existing test suite: `npm --workspace services/api test`
- Update tests that reference old premium rates ($11/1k → $8/1k) and tenor (7d → 1d)
- Frontend build: `npm --workspace apps/web run build`
- Verify on VPS or Render deployment

### Success criteria
- Flat $8/1k premium applied to all protections
- 1-day options selected from Bullish orderbook
- No regime pricing logic in the activation path
- Frontend shows "per day" tenor
- All non-IBKR tests pass
- Frontend builds clean
