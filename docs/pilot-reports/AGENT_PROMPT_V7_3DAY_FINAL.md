# Agent Prompt: V7 Final — 3-Day Rolling Tenor, Tiered Pricing, Take-Profit

## Context

You are implementing the final V7 pricing configuration for the Atticus/Foxify perp protection platform. Previous iterations tested 7-day and 1-day tenors. Comprehensive backtesting across 4 years of historical data and live Deribit mainnet pricing has determined that **3-day rolling tenor with take-profit optimization** is the optimal configuration.

## Why 3-Day Tenor

Backtesting (results at `/workspace/docs/pilot-reports/backtest_min_premium_results.txt`) showed:
- 3-day options are cheap enough for low premiums
- Long enough for meaningful take-profit recovery after breach (105-155% of payout)
- The take-profit engine is the primary profit driver — the option gains value after breach and the platform sells it
- Break-even premiums are near zero for 2% SL because TP recovery exceeds payout
- Works across all volatility regimes (tested at vol × 0.44, 0.65, 0.85)

## Final Configuration

```
TENORS: 3-day (for 2%, 3%, 5% SL) | 2-day (for 10% SL)
RENEWAL: Rolling — auto-renew at expiry with fresh option at current spot
TAKE-PROFIT: Always on — sell option at optimal point after breach
```

### Tiered Pricing

| SL% | Tenor | Premium/$1k | Per $10k/period | Weekly/$10k | Payout/$10k |
|-----|-------|------------|----------------|------------|-------------|
| 2%  | 3d    | $3.00      | $30            | $70        | $200        |
| 3%  | 3d    | $4.00      | $40            | $93        | $300        |
| 5%  | 3d    | $6.00      | $60            | $140       | $500        |
| 10% | 2d    | $3.00      | $30            | $105       | $1,000      |

### How Weekly Cost Works
- 3-day tenor: 7 / 3 = 2.33 renewals per week
- 2-day tenor: 7 / 2 = 3.5 renewals per week
- Weekly cost = premium per period × renewals per week
- Example: 2% SL, $30/period × 2.33 = $70/week for $10k position

### Drop 1% SL
1% SL is not offered. Trigger rates are too high (86-95%) and the premium exceeds the payout, providing no trader value.

## What the Trader Sees

```
Position: BTC Long $10,000
Stop Loss: 2%
Premium: $30 per 3-day cycle (~$70/week)
Payout if triggered: $200
Max loss with protection: $30 (the premium)
Max loss without: $200
Savings on breach: $170
Protection renews automatically every 3 days
```

## What the Platform Does (Backend)

### Protection Lifecycle
1. Trader buys protection → platform buys 3-day put at 2% OTM
2. Platform collects $30 premium, pays ~$5-9 hedge cost
3. During 3-day window:
   - If BTC hits trigger: pay trader $200 immediately. Option stays open.
   - Platform monitors option value. If option gains > payout × 1.3, sell (take-profit).
   - If BTC continues falling, option gains more value — sell at deepest point within 2 days.
4. At expiry: if option still held, Bullish cash-settles (ITM) or expires (OTM)
5. If auto-renew: buy new 3-day put at current spot, charge new premium

### Take-Profit Logic (critical for profitability)
After breach:
1. Option has remaining life (1-2 days on a 3-day option)
2. Monitor the option's intrinsic value: max(0, strike - current_price) × quantity
3. If intrinsic value >= payout × 1.3: sell immediately (lock in profit)
4. Otherwise: check every hour, sell at the deepest point within 2 days of breach
5. If price recovers (BTC goes back up): option loses value, hold to expiry
6. Average recovery: 105-155% of payout (the option recovers more than we paid out)

### Premium Calculation
```
premium = positionSize / 1000 * RATE_PER_1K[slPct]

RATE_PER_1K = {
  2: 3.00,
  3: 4.00,
  5: 6.00,
  10: 3.00
}

TENOR_DAYS = {
  2: 3,
  3: 3,
  5: 3,
  10: 2
}
```

## Implementation Changes

### Backend (`services/api/src/pilot/`)

**routes.ts:**
- Replace `FIXED_PREMIUM_PER_1K = 11` with tiered lookup from SL%
- Remove all regime pricing code (no calm/normal/stress)
- Tenor comes from SL% tier mapping, not a single global constant
- Add take-profit logic: after trigger, schedule option sell

**config.ts:**
- `fixedTenorDays` → remove single value, use tier-based lookup
- Remove `premiumRegime` config for locked profile
- Add `PILOT_SL_TIERS` config with premium and tenor per tier

**venue.ts:**
- Option selection: filter for puts expiring within (tenor - 0.5) to (tenor + 1.5) days
- For 3-day tenor: look for options expiring in 2.5 to 4.5 days
- For 2-day tenor: look for options expiring in 1.5 to 3.5 days
- Add `sellOption` method: place a sell order on an existing option position
- Take-profit monitor: background check on triggered protections

**triggerMonitor.ts:**
- After marking protection as triggered, add to take-profit queue
- Take-profit queue checks option value periodically
- Sells when value >= payout × 1.3 or within 1 day of expiry

### Frontend (`apps/web/src/`)

**PilotWidget.tsx:**
- SL buttons: [2%, 3%, 5%, 10%] (remove 1%)
- Premium display: tiered, shows per-period cost
- Tenor display: "3-day" or "2-day" based on SL%
- Weekly cost calculation: premium × (7/tenor)
- Show "renews every 3 days" or "renews every 2 days"

**funded_levels.json (both locations):**
```json
{
  "levels": [
    { "name": "SL 2%", "sl_pct": "0.02", "fixed_price_usdc": "3.00", "expiry_days": "3" },
    { "name": "SL 3%", "sl_pct": "0.03", "fixed_price_usdc": "4.00", "expiry_days": "3" },
    { "name": "SL 5%", "sl_pct": "0.05", "fixed_price_usdc": "6.00", "expiry_days": "3" },
    { "name": "SL 10%", "sl_pct": "0.10", "fixed_price_usdc": "3.00", "expiry_days": "2" }
  ]
}
```

### render.yaml
- `PILOT_TENOR_DEFAULT_DAYS: "3"`
- Remove regime pricing env vars

### DB
- Add `sl_pct` column to protections table (keep `tier_name` with "SL X%" labels)
- No other schema changes needed

## What NOT to Change
- Bullish adapter execution flow (IOC, REST status poll, order format, price precision)
- Multi-position frontend (positions, balance, settlement, localStorage persistence)
- Admin dashboard (protections list, settlement buttons, treasury)
- Account balance / settlement tracking
- Toast notifications, collapsible sections
- The trigger monitor polling mechanism (just add TP queue after trigger)

## Testing
- Update test expectations for new rates ($3-6/1k instead of $11/1k)
- Update tenor expectations (3d instead of 7d)
- Run: `npm --workspace services/api test`
- Build: `npm --workspace apps/web run build`
- Verify on VPS with live Bullish testnet

## Branch
`cursor/-bc-c2468b87-16cc-4357-84a5-12c8079ff3c2-6ba4`

## Backtest Evidence
All results in `/workspace/docs/pilot-reports/`:
- `backtest_min_premium_results.txt` — minimum premium finder (the definitive test)
- `backtest_1day_tenor_results.txt` — 1-day comparison
- `backtest_low_floor_v2_results.txt` through `v5` — earlier iterations
- Scripts in `services/api/scripts/pilotBacktest*.ts`

## Success Criteria
1. Tiered pricing: 2%=$3/1k, 3%=$4/1k, 5%=$6/1k, 10%=$3/1k
2. Tenor: 3-day for 2/3/5%, 2-day for 10%
3. No regime pricing (flat rates)
4. Take-profit logic implemented (sell option after breach at optimal point)
5. Frontend shows correct SL tiers, premiums, tenors
6. All non-IBKR tests pass
7. Frontend builds clean
