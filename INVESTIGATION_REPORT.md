# Investigation Report: Three Issues

## Issue 1: "No" Bet on "How High" and "How Low" Showing No Options

### Current Behavior
- **KXBTCMAXY-25 + NO**: Returns `hedge_unavailable`
- **KXBTCMINY-25 + NO**: Returns `hedge_unavailable`

### Expected Insurance Types (from adapter.py)
- **KXBTCMAXY** (ABOVE event) + NO → `insurance_type = 'call'` ✅
- **KXBTCMINY** (BELOW event) + NO → `insurance_type = 'put'` ✅

### Analysis Needed
1. Check if strike selection is finding valid strikes for these combinations
2. Check if premium calculation is rejecting them
3. Check if economic validity checks are failing

### Next Steps
- Review logs for strike selection failures
- Check if CALL strikes above barrier exist for "how high" + NO
- Check if PUT strikes below barrier exist for "how low" + NO

---

## Issue 2: "When Will" Events Showing No Options

### Current Behavior
- **KXBTCMAX150-25-DEC31-149999.99**: Returns `503 Service Unavailable` with message "Option chains for expiry 2025-01-02 not available"

### Root Cause
- Event expiry: **2025-01-02** (Jan 2, 2025)
- This is **very soon** (less than 1 month away)
- Option chains likely don't have expiries that close
- Deribit/OKX typically list options with longer expiries

### Analysis
- "When will" events have near-term expiries (Jan 2, Feb 28)
- Option exchanges may not have options expiring on these exact dates
- Need to check what expiries are actually available

### Next Steps
- Check what option expiries are available from Deribit/OKX
- Consider using closest available expiry (±14 days flexibility)
- Verify expiry matching logic is working correctly

---

## Issue 3: Premium/Payout Ratio Analysis

### Current Example (KXBTCMAXY-25 + YES)
- **Premium**: $10.00
- **Max Payout**: $12.27
- **Ratio**: 1.227 (meets 1.1 requirement ✅)
- **Strikes**: $94,000 / $93,000 (PUT spread)
- **Spread Width**: $1,000
- **Notional**: 0.01227 BTC

### Option Cost Breakdown
- **Premium Formula**: `premium = notional * spot * (long_ask - short_bid)`
- **Implied Price Difference**: `(long_ask - short_bid) = premium / (notional * spot)`
- **Calculation**: $10 / (0.01227 BTC * $100,000) = **0.00815** (0.815%)

### Analysis
**Current Structure**:
- User pays $10 premium
- Max payout is $12.27 (22.7% return if max payout occurs)
- Ratio is 1.227 (meets minimum 1.1 requirement)

**Option Cost**:
- The option spread costs 0.815% of notional (very low cost)
- This is the actual market cost of the options

**Room for Improvement**:
1. **Increase Notional**: Larger notional = larger payout, but also larger premium
   - 2x notional: Premium=$20, Payout=$24.54, Ratio=1.227 (same ratio)
   - Ratio is **independent of notional** - scaling doesn't improve ratio

2. **Find Wider Spreads**: Wider spread width = better ratio
   - Current: $1k spread width
   - If we find $2k spread width with similar option prices: Ratio could be ~2.0

3. **Find Better Strike Prices**: Different strikes might have better price ratios
   - Current strikes: $94k/$93k
   - Alternative: $95k/$93k ($2k spread) might have better ratio

### Key Insight
**The ratio is determined by the option prices and spread width, NOT by notional scaling.**
- If option prices are expensive relative to spread width → poor ratio
- If option prices are cheap relative to spread width → good ratio
- We can't "scale" our way to a better ratio - we need better strikes

### Recommendations
1. **Try even wider spreads** (offset 3, 4) to find better ratios
2. **Prioritize strikes with wider spread widths** when option prices are similar
3. **Consider adjusting initial notional formula** to target better payout percentages
   - Current: `notional = stake / (5 * spread_width)`
   - Could try: `notional = stake / (4 * spread_width)` for larger notional = larger payout

---

## Summary

| Issue | Status | Root Cause | Solution |
|-------|--------|------------|----------|
| "How High" + NO | ❌ No options | Need investigation | Check strike selection |
| "How Low" + NO | ❌ No options | Need investigation | Check strike selection |
| "When Will" | ❌ No options | Expiry too soon (Jan 2) | Use closest available expiry |
| Premium/Payout | ⚠️ Low payout % | Narrow spreads, low notional | Try wider spreads, adjust notional formula |

