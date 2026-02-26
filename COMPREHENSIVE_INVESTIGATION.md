# Comprehensive Investigation Report

## Issue 1: "No" Bet on "How High" and "How Low" - No Options

### Current Status
- **KXBTCMAXY-25 + NO**: `hedge_unavailable` ❌
- **KXBTCMINY-25 + NO**: `hedge_unavailable` ❌

### Insurance Type Mapping (Verified ✅)
From `adapter.py`:
- **KXBTCMAXY** (ABOVE event) + NO → `insurance_type = 'call'` ✅ Correct
- **KXBTCMINY** (BELOW event) + NO → `insurance_type = 'put'` ✅ Correct

### Strike Selection Rules (Verified ✅)
From `strike_selector.py`:
- **ABOVE K + NO**: `_find_first_two_calls_above(barrier, call_strikes)` ✅ Correct
- **BELOW K + NO**: `_find_two_highest_puts_below(barrier, put_strikes)` ✅ Correct

### Likely Root Causes

#### For "How High" + NO (CALL spreads above barrier):
- **Barrier**: $130k (above current spot ~$100k)
- **Need**: CALL strikes ≥ $130k
- **Problem**: CALL strikes above $130k might:
  1. Not exist (exchanges might not list strikes that far OTM)
  2. Have zero bid/ask (no liquidity)
  3. Be filtered out by strike selection logic

#### For "How Low" + NO (PUT spreads below barrier):
- **Barrier**: $80k (below current spot ~$100k)
- **Need**: PUT strikes ≤ $80k
- **Problem**: PUT strikes at/below $80k might:
  1. Exist but have poor liquidity (zero bid/ask)
  2. Create spreads with negative premiums
  3. Fail economic validity checks

### Next Steps to Investigate
1. Check what CALL strikes are available above $130k
2. Check what PUT strikes are available at/below $80k
3. Review logs for strike selection failures
4. Check if option prices are causing rejections

---

## Issue 2: "When Will" Events - No Options

### Current Status
- **KXBTCMAX150-25-DEC31-149999.99**: `503 Service Unavailable`
- **Error**: "Option chains for expiry 2025-01-02 not available"

### Root Cause Analysis

**Event Expiry**: January 2, 2025 (very soon - less than 1 month away)

**Logs Show**:
```
"Deribit option filtering": "valid_after_filtering": 0, "filtered_out": 708
"Retrieved option chains": "chain_count": 0, "total_contracts": 0
```

**Problem**: 
- Deribit/OKX fetched 708 instruments
- But **ALL were filtered out** (0 valid after filtering)
- This means no options match the expiry date (Jan 2, 2025)

### Why Options Are Filtered Out

The expiry matching logic in `chain_service.py`:
- Looks for options expiring on or near Jan 2, 2025
- Uses ±14 days flexibility for events <365 days away
- But Jan 2, 2025 is **very soon** (less than 1 month)
- Option exchanges typically don't list options with such short expiries
- Or the available expiries don't match (e.g., Dec 27, Jan 10, but not Jan 2)

### Solution Options
1. **Use closest available expiry**: If Jan 2 not available, use closest (e.g., Dec 27 or Jan 10)
2. **Increase expiry flexibility**: Allow ±30 days for very short-term events
3. **Check what expiries are actually available**: Query Deribit/OKX to see what dates they have

---

## Issue 3: Premium/Payout Ratio Analysis

### Current Example (KXBTCMAXY-25 + YES)

**Hedge Structure**:
- **Premium**: $10.00
- **Max Payout**: $12.27
- **Ratio**: 1.227 (meets 1.1 requirement ✅)
- **Strikes**: $94,000 / $93,000 (PUT spread)
- **Spread Width**: $1,000
- **Notional**: 0.01227 BTC (~$1,227)

### Option Cost Breakdown

**Premium Formula**: `premium = notional * spot * (long_ask - short_bid)`

**Calculated Values**:
- **Option Price Difference**: `(long_ask - short_bid) = 0.00815` (0.815% of spot)
- **Cost per BTC**: $8.15
- **Total Cost**: $10.00 (for 0.01227 BTC)

**Estimated Option Prices** (PUT spread):
- **Long PUT @ $94k**: ~1.0% of spot (ask price)
- **Short PUT @ $93k**: ~0.185% of spot (bid price)
- **Net Cost**: 0.815% of spot

### Key Insight: Ratio is Independent of Notional

**The ratio is determined by option prices and spread width, NOT by notional scaling.**

```
Ratio = max_payout / premium
     = (notional * spread_width) / (notional * spot * price_diff)
     = spread_width / (spot * price_diff)
```

**This means**:
- Scaling notional up/down doesn't change the ratio
- To improve ratio, we need:
  1. **Wider spread width** (better strikes)
  2. **Lower option prices** (cheaper options)
  3. **Different strike combinations** (better price ratios)

### Impact Analysis

#### Current Structure:
- Premium: $10
- Max Payout: $12.27
- **Return if max payout**: 22.7%
- **Ratio**: 1.227

#### If We Double Notional:
- Premium: $20
- Max Payout: $24.54
- **Return if max payout**: 22.7% (same!)
- **Ratio**: 1.227 (unchanged)

#### If We Find Wider Spread ($2k instead of $1k):
- Premium: $10 (same)
- Max Payout: $24.54 (doubled)
- **Return if max payout**: 145.4%
- **Ratio**: 2.454 (much better!)

### Recommendations

1. **Try Even Wider Spreads**:
   - Current: Tries offsets 0-4 (including wider spreads)
   - Could try: Offsets up to 6-8 for even wider spreads
   - Prioritize: Strikes with $2k+ spread width

2. **Adjust Initial Notional Formula**:
   - Current: `notional = stake / (5 * spread_width)`
   - Could try: `notional = stake / (4 * spread_width)` for larger notional
   - **Impact**: Larger payout, but same ratio (just bigger numbers)

3. **Prioritize Strikes by Spread Width**:
   - When multiple strike pairs available, prefer wider spreads
   - Score candidates by: `spread_width / option_price_diff` (higher is better)

4. **Consider Minimum Spread Width**:
   - Reject spreads with width < $1,500 (too narrow for good ratios)
   - Or: Require minimum ratio of 1.3 for acceptance (not just 1.1)

### Room for Improvement

**Current**: Ratio 1.227 (22.7% return)
**Potential**: Ratio 2.0+ (100%+ return) with wider spreads

**The limiting factor**: Finding option strikes that create wider spreads with reasonable prices.

---

## Summary Table

| Issue | Status | Root Cause | Impact | Solution Complexity |
|-------|--------|------------|--------|-------------------|
| "How High" + NO | ❌ No options | CALL strikes above $130k may not exist/have liquidity | Medium | Medium |
| "How Low" + NO | ❌ No options | PUT strikes at/below $80k may have poor prices | Medium | Medium |
| "When Will" | ❌ No options | Expiry Jan 2 too soon, no matching options | High | Low-Medium |
| Premium/Payout | ⚠️ Low return % | Narrow spreads ($1k), ratio independent of notional | Low | Medium |

---

## Next Steps

1. **For NO bets**: Check available strikes and option prices
2. **For "When Will"**: Check what expiries are actually available, use closest match
3. **For Premium/Payout**: Try even wider spreads, prioritize by spread width

