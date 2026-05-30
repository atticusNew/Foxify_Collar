# Agent Prompt: Atticus Premium Optimization — Definitive Backtest

## Your Role
You are a quantitative financial engineer and options pricing specialist. You are running the definitive backtest to determine optimal fixed premiums for a BTC perp protection product that hedges using put options.

## Context

### Product Description
Atticus sells "protection" to BTC perp traders. The trader pays a premium for 7 days of coverage. If BTC drops to their stop-loss level, the trader receives an instant payout. Atticus hedges by buying put options on Bullish exchange.

### The Protection Lifecycle
1. Trader opens a BTC long at $70,000, position size $10,000, stop loss at 2% ($68,600)
2. Trader pays premium (e.g., $80) for 7 days of protection
3. Atticus buys a put option near the $68,600 strike to hedge
4. If BTC hits $68,600: trader receives $200 payout instantly. Atticus keeps the option open.
5. If BTC doesn't hit $68,600 in 7 days: option expires, no payout. Atticus keeps the premium.
6. After breach: Atticus can sell the option (take-profit) or hold to expiry to recover value.

### Stop-Loss Tiers to Test
1%, 2%, 3%, 5%, 10%

### Previous Backtests Found
- At 1-2% SL, trigger rates are 53-64% (very frequent)
- Post-breach option recovery is strong at 1-2% SL (+$148-251 per trigger average)
- The hedge option costs MORE than any reasonable premium at 1-5% SL
- Platform profitability depends on post-breach option recovery, not on premium > hedge cost
- Take-profit (selling option within 2 days of breach) adds 13-32% more recovery
- Deductible (trader absorbs first 1%) reduces costs 21-43%
- Market-realistic IV (realized vol × 0.85) gives lower break-evens than inflated BS (×1.15)

### Key Financial Relationships
```
Per-trade P&L = Premium - HedgeCost - (Triggered ? Payout : 0) + OptionRecovery
Where:
  Premium = fixed amount charged to trader per $1k notional
  HedgeCost = put option purchase price (BS model or live market)
  Payout = notional × SL% (only if triggered)
  OptionRecovery = option value at exit (take-profit or expiry)
```

## Your Task

Run ONE definitive backtest that tests ALL optimization levers simultaneously and outputs a clear recommendation.

### Data
- Fetch BTC daily prices 2022-01-01 to 2026-04-07 from Coinbase public API:
  `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start={ISO}&end={ISO}`
  - Returns: `[timestamp, low, high, open, close, volume][]`
  - Chunk into 300-day ranges to avoid API limits
  - Wait 500ms between requests

### Methodology

For each 7-day rolling window across all historical data:

**Step 1: Compute trigger**
- Entry price = close on day 0
- Trigger price = entry × (1 - SL%)
- Check if min(close[day0..day7]) <= trigger price
- Record trigger day if triggered

**Step 2: Compute hedge cost (3 strike strategies)**
- **Strategy A (At-Trigger):** Put strike = trigger price (current approach)
- **Strategy B (Mid):** Put strike = entry - (SL% / 2) × entry (halfway between entry and trigger)
- **Strategy C (ATM):** Put strike = entry price (full coverage, most expensive)
- Use Black-Scholes: `Put = K×e^(-rT)×N(-d2) - S×N(-d1)` where:
  - S = entry price, K = strike, T = 7/365, r = 0.05
  - σ = 30-day realized vol × vol_multiplier
  - Run with vol_multiplier = 0.85 (market IV) and 1.0 (neutral) 

**Step 3: Compute recovery (2 strategies)**
- **Hold-to-Expiry:** Option intrinsic at day 7 = max(0, strike - close[day7]) × qty
- **Take-Profit:** Find the lowest price in days [trigger_day .. trigger_day+2]. Option value = max(0, strike - lowest) × qty. Use whichever is higher: TP value or hold value.

**Step 4: Compute payout (2 structures)**
- **Standard:** Payout = notional × SL% (full payout on breach)
- **With 1% Deductible:** Payout = notional × max(0, SL% - 1%) (trader absorbs first 1%)

**Step 5: Regime classification**
- 30-day realized vol < 40%: CALM
- 30-day realized vol 40-65%: NORMAL
- 30-day realized vol >= 65%: STRESS

### Configuration Matrix

Test every combination of:
- SL%: [1, 2, 3, 5, 10]
- Strike: [at-trigger, mid, ATM]
- Recovery: [hold-to-expiry, take-profit]
- Deductible: [none, 1%]
- Vol assumption: [0.85, 1.0]

That's 5 × 3 × 2 × 2 × 2 = 120 configurations. For each, compute:
- Trigger rate
- Average hedge cost per $1k
- Average payout per $1k
- Average recovery per $1k
- Break-even premium per $1k
- P&L at premiums: $3, $5, $7, $8, $10, $12, $15, $20 per $1k
- Win rate at each premium
- Break-even by regime (calm/normal/stress separately)

### Output Format

**Table 1: Top 10 Most Viable Configurations**
Sort all 120 configs by: lowest break-even that has >60% win rate at the suggested premium.

```
Rank | SL% | Strike | TP? | Deduct | Vol | BE/$1k | Suggest/$1k | WinRate | Calm BE | Stress BE
1    | 10% | trigger| yes | none   | 0.85| $4.20  | $5.50       | 91%     | $2.10   | $8.50
2    | ...
```

**Table 2: Per-Tier Best Configuration**
For each SL%, show the single best configuration and its economics.

```
SL% | Best Config         | Premium/$1k | Trader Pays/$10k | Payout | Trader Saves | Platform Margin
1%  | ATM+TP+nodeduct     | $7.00       | $70              | $100   | $30          | +$2.50/trade
```

**Table 3: Regime Pricing Matrix**
For the best config per tier, show what the premium should be in each regime:

```
SL% | Calm    | Normal  | Stress  | How It Works
2%  | $6/1k   | $9/1k   | $14/1k  | Fixed in calm, surcharge in stress
```

**Table 4: Treasury Simulation**
Using the best config and suggested premium, simulate 4 years with $100k starting treasury, 5 protections/day:

```
SL% | End Treasury | Min Treasury | Max DD | Annual P&L | Worst Month
```

**Table 5: CEO Presentation — What The Trader Sees**
Plain language for each tier:

```
SL% | "You Pay" | "You Get" | "Max Loss" | "Without Protection"
2%  | $60/10k   | $200      | $60        | $200
```

### Technical Notes
- Use `Decimal` or careful floating point for all financial calculations
- The Coinbase candle format is `[timestamp_seconds, low, high, open, close, volume]`
- BTC quantity per $10k = $10,000 / entry_price
- Option recovery should NEVER exceed the option's theoretical value (cap at BS price with remaining time)
- For take-profit: use intrinsic value only (conservative), not BS with time value

### Files
- Write the backtest script to: `/workspace/services/api/scripts/pilotBacktestDefinitive.ts`
- Write results to: `/workspace/docs/pilot-reports/backtest_definitive_results.txt`
- The existing scripts at `scripts/pilotBacktestLowFloor*.ts` are references but have inconsistent methodology — start fresh

### What to Return
1. The complete results tables as described above
2. A clear recommendation: "Here are the premiums that work and here is why"
3. Flag any configurations where the platform loses money — these should be eliminated
4. Identify the 2-3 tiers that should be offered as the product

## Repository Location
- Repo: `/workspace`
- The backtest scripts go in: `services/api/scripts/`
- Results go in: `docs/pilot-reports/`
- Run with: `npx tsx services/api/scripts/pilotBacktestDefinitive.ts`

## Success Criteria
- All 120 configurations tested consistently with same methodology
- Clear winner identified per tier
- Treasury simulation proves sustainability over 4 years
- CEO-ready summary table
- Results committed and pushed to branch: `cursor/-bc-c2468b87-16cc-4357-84a5-12c8079ff3c2-6ba4`
