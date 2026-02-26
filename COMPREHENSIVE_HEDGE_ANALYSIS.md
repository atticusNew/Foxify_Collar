# Comprehensive Hedge Options Analysis

**Date:** January 2025  
**Status:** Analysis Only - No Changes Yet

## Problem Statement

- ❌ **No hedge options showing for ANY event**
- ❌ **Preview badges showing "No options" for all events**
- ❌ **Speed too slow** (need <2s, currently 4-7s estimated)

---

## Critical Finding: Exchange Connectivity Issue

### Test Results Show:
```
"No option exchanges available or connected"
```

**Root Cause:** Exchange registry not initializing option exchanges properly in test context.

**However:** Backend logs show chains ARE being fetched:
- "Retrieved option chains: exchange_count=2, chain_count=3, total_contracts=210"
- This suggests exchanges ARE working in production context

**Need to verify:** Is the issue in test context only, or also in production?

---

## 1. Exchange Connectivity Analysis

### ✅ Both Exchanges Being Checked

**Evidence:**
- `OptionChainService.get_option_chains()` uses `asyncio.gather()` for parallel fetching
- Logs show: "exchange_count=2, chain_count=3"
- Both Deribit and OKX connectors exist

**OKX Issues:**
- Many 404 errors for specific contracts
- Contracts may not exist or format is wrong
- But some contracts DO work (chains are returned)

**Deribit:**
- ✅ Successfully fetching chains
- ✅ Contracts have valid bid/ask prices
- ✅ Working correctly

**Conclusion:** ✅ **Both exchanges ARE being checked**

---

## 2. Option Chain Fetching Analysis

### Current Implementation

**Flow:**
1. `get_option_chains()` called with expiry date
2. Filters by days range (±14 days from target expiry)
3. Fetches contracts in parallel (Deribit: batches of 20, OKX: all at once)
4. Filters contracts with `ask <= 0` (no valid ask price)

**Potential Issues:**

#### Issue A: Expiry Date Filtering Too Strict
```python
min_days_to_expiry=max(1, (canonical_event.expiry_date - date.today()).days - 14),
max_days_to_expiry=(canonical_event.expiry_date - date.today()).days + 14
```
- For Dec 31, 2025: Allows chains from Dec 17, 2025 to Jan 14, 2026
- This should be fine, but may exclude valid chains

#### Issue B: Contract Filtering Too Strict
```python
if ask <= 0:
    return None  # Skip if no ask price
```
- **CRITICAL:** This filters out contracts without ask prices
- May be too strict - some contracts might have bid but no ask
- But this is correct (can't buy without ask price)

#### Issue C: Sequential Batch Processing
- Deribit: Processes in batches of 20 with 1s delay between batches
- For 100 contracts: 5 batches × 1s = 5s delay
- **Performance bottleneck**

**Evidence:**
- Logs show: "Retrieved option chains: total_contracts=210"
- Chains ARE being fetched successfully
- But may not have strikes near threshold prices

**Conclusion:** ✅ **Chains ARE being fetched, but may not have suitable strikes**

---

## 3. Strike Selection Analysis

### Current Implementation

**Rules Per Specification:**
- BELOW K + YES: First two call strikes ≥ K
- BELOW K + NO: Two highest put strikes ≤ K
- ABOVE K + YES: Two highest put strikes ≤ K
- ABOVE K + NO: First two call strikes ≥ K
- HIT K + YES: Two call strikes < K
- HIT K + NO: First two call strikes ≥ K

**Potential Issues:**

#### Issue A: Strike Filtering Too Strict
```python
call_strikes = sorted(set(
    c.strike for c in chain.contracts
    if c.option_type == 'C' and c.bid > 0 and c.ask > 0
))
```
- Requires BOTH bid AND ask > 0
- May filter out valid strikes with only ask price
- But this is correct (need ask to buy, bid to sell)

#### Issue B: No Strikes Near Threshold
- For KXBTC2025100 with threshold $100k
- May not have strikes exactly at $100k
- May have strikes at $95k, $105k, etc.
- Rules require strikes ≥ K or ≤ K, which should work

#### Issue C: Fallback Logic Not Working
- Code tries up to 3 alternative strikes
- But if initial strikes fail, alternatives may also fail
- No logging of WHY strikes are rejected

**Evidence Needed:**
- Check what strikes exist in chains
- Check if strikes are found but rejected later
- Check strike availability around threshold prices

**Conclusion:** ⚠️ **Strike selection may be failing - need to verify**

---

## 4. Premium Calculation Restrictions Analysis

### Current Restrictions

#### Restriction A: Minimum Premium
```python
MIN_PREMIUM_USD = Decimal('10')  # Minimum $10 premium
```
- Rejects hedges with premium < $10
- May be too high for small budgets
- **Impact:** Rejects many valid hedges

#### Restriction B: Minimum Value Ratio
```python
MIN_VALUE_RATIO = Decimal('1.1')  # Max payout must be 10% more than premium
```
- Requires: `max_payout / premium >= 1.1`
- This means: `premium <= max_payout / 1.1`
- Or: `premium <= 90.9% of max_payout`
- **Impact:** Very strict - rejects hedges with premium > 90.9% of max_payout

#### Restriction C: Premium Must Be Less Than Max Payout
```python
if premium_final > max_payout_final:
    return None  # Reject
```
- This is correct (economically sound)
- But combined with MIN_VALUE_RATIO, may be too strict

### Example Calculation

**Scenario:**
- Spread width: $10,000
- Initial notional: 0.01 BTC (from `user_stake / (5 * spread_width)`)
- Max payout: 0.01 × 10,000 = $100
- Premium: $95 (95% of max payout)

**Result:**
- Premium < max_payout ✅
- Ratio: 100/95 = 1.05 < 1.1 ❌ **REJECTED**
- Premium > $10 ✅

**This hedge would be REJECTED even though it's economically valid!**

### Comparison with Old Implementation

**Old Code (from analysis):**
- Had MIN_PREMIUM_USD but was removed in fixes
- Had premium > max_payout rejection but was removed
- **Less strict restrictions**

**New Code:**
- MIN_PREMIUM_USD = $10 (strict)
- MIN_VALUE_RATIO = 1.1 (very strict)
- Premium > max_payout rejection (correct)

**Conclusion:** 🔴 **Premium restrictions are TOO STRICT**

---

## 5. Venue Optimizer Analysis

### Current Implementation

**Flow:**
1. Scores all candidates: `score = premium / max_payout`
2. Selects single best candidate
3. Generates 3 tiers by scaling notional (0.5x, 1.0x, 1.5x)
4. Each tier recalculates premium and checks restrictions

**Potential Issues:**

#### Issue A: Single Best Candidate Only
- Only uses ONE candidate from all venues
- If that candidate fails tier generation, all fail
- Doesn't try next best candidate

#### Issue B: Tier Generation May Fail
- Each tier recalculates premium
- Each tier checks MIN_VALUE_RATIO (1.1) and MIN_PREMIUM ($10)
- If ANY tier fails, it's skipped
- May result in 0 tiers even if base candidate is valid

#### Issue C: Tier Restrictions Too Strict
```python
if payout_premium_ratio < Decimal('1.1'):
    continue  # Skip tier
if tier_premium < Decimal('10'):
    continue  # Skip tier
```
- Same restrictions as premium calculator
- May reject all tiers

**Evidence:**
- Code shows fallback: if no tiers created, returns single best candidate
- But if base candidate fails restrictions, still returns empty

**Conclusion:** ⚠️ **Tier generation may be failing due to strict restrictions**

---

## 6. Performance Analysis

### Current Bottlenecks

#### Bottleneck A: Event Fetching
- Fetches events sequentially (with delays)
- Fetches ticker data in batches of 10 with 0.2s delay
- **Time:** ~1-2s

#### Bottleneck B: Option Chain Fetching
- Deribit: Batches of 20 with 1s delay between batches
- For 100 contracts: 5 batches × 1s = 5s
- OKX: All at once (faster)
- **Time:** ~2-5s (Deribit is slow)

#### Bottleneck C: Strike Selection
- Loops through venues sequentially
- For each venue, tries up to 3 alternative strikes
- Each attempt may involve contract lookups
- **Time:** ~0.5-1s per venue

#### Bottleneck D: Premium Calculation
- For each candidate, calculates premium
- Then generates 3 tiers (3x calculations)
- Each calculation is in-memory (fast)
- **Time:** ~0.1-0.2s per candidate

**Total Estimated Time:** 4-8s (too slow, need <2s)

### Optimization Opportunities

1. **Cache Option Chains** - Currently cached for 30s, but may not be hit
2. **Parallelize Venue Processing** - Currently sequential
3. **Fail Fast on OKX 404s** - Skip invalid contracts immediately
4. **Reduce Deribit Batch Delays** - 1s delay is too long
5. **Pre-filter Strikes** - Filter before premium calc

---

## 7. Root Cause Analysis

### Hypothesis 1: Premium Restrictions Too Strict 🔴 **HIGHEST LIKELIHOOD**

**Evidence:**
- MIN_VALUE_RATIO = 1.1 requires premium < 90.9% of max_payout
- Combined with MIN_PREMIUM = $10
- Many valid hedges likely rejected

**Test:**
- Check logs for "Rejecting candidate: payout-to-premium ratio too low"
- Check if strikes are found but premium calc rejects

**Impact:** 🔴 **CRITICAL** - Likely main cause of no options

---

### Hypothesis 2: Strike Selection Failing 🟡 **MEDIUM LIKELIHOOD**

**Evidence:**
- Strike selection requires bid > 0 AND ask > 0
- May not find strikes near threshold
- Fallback logic may not work

**Test:**
- Check if strikes exist in chains
- Check if strikes are found but rejected
- Check strike availability around threshold

**Impact:** 🟡 **MEDIUM** - May be contributing factor

---

### Hypothesis 3: Option Chains Don't Have Suitable Strikes 🟡 **MEDIUM LIKELIHOOD**

**Evidence:**
- Chains ARE being fetched (210 contracts)
- But may not have strikes near threshold prices
- OKX returning many 404s

**Test:**
- Check what strikes exist in chains
- Check strike distribution around threshold

**Impact:** 🟡 **MEDIUM** - May be contributing factor

---

### Hypothesis 4: Venue Optimizer Only Using One Candidate 🟢 **LOW LIKELIHOOD**

**Evidence:**
- Takes single best candidate
- If that fails, all fail
- But should still return base candidate if tiers fail

**Impact:** 🟢 **LOW** - Less likely main cause

---

## 8. Comparison with Old Implementation

### Old Code Restrictions (from analysis):

**Premium Restrictions:**
- Had MIN_PREMIUM but was removed
- Had premium > max_payout rejection but was removed
- **Less strict** - allowed more hedges

**Strike Selection:**
- Used percentage-based fallbacks (10%, 15% below spot)
- More flexible than current strict rules

**Performance:**
- Sequential processing (slower)
- But may have worked better due to less strict restrictions

**Key Difference:**
- **Old:** Less strict restrictions, more hedges shown
- **New:** Very strict restrictions, fewer/no hedges shown

---

## 9. Detailed Restriction Analysis

### Current Restrictions Summary

| Restriction | Value | Impact | Strictness |
|------------|-------|--------|------------|
| MIN_PREMIUM_USD | $10 | Rejects small hedges | 🔴 Very Strict |
| MIN_VALUE_RATIO | 1.1 (10%) | Requires premium < 90.9% of max_payout | 🔴 Very Strict |
| Premium < Max Payout | Required | Economically correct | ✅ Correct |
| Bid > 0 AND Ask > 0 | Required | Need both to trade | ✅ Correct |
| Strike Distance | 20% from barrier | May reject valid strikes | 🟡 Moderate |

### Recommended Changes

#### Priority 1: Relax MIN_VALUE_RATIO
- **Current:** 1.1 (requires 10% margin)
- **Recommended:** 1.05 (requires 5% margin)
- **Impact:** Allows more hedges while still ensuring value

#### Priority 2: Lower MIN_PREMIUM_USD
- **Current:** $10
- **Recommended:** $5
- **Impact:** Allows smaller hedges

#### Priority 3: Increase Strike Distance
- **Current:** 20% from barrier
- **Recommended:** 30% from barrier
- **Impact:** More strikes available

#### Priority 4: Add Detailed Logging
- Log WHY premium calc rejects
- Log strike selection attempts
- Log venue processing results

---

## 10. Performance Optimization Plan

### Target: <2s Total Time

#### Optimization 1: Cache Option Chains More Aggressively
- **Current:** 30s TTL
- **Recommended:** 60s TTL
- **Impact:** Reduces chain fetching time

#### Optimization 2: Reduce Deribit Batch Delays
- **Current:** 1s delay between batches
- **Recommended:** 0.2s delay
- **Impact:** Reduces chain fetching from 5s to 1s

#### Optimization 3: Parallelize Venue Processing
- **Current:** Sequential (venue 1, then venue 2)
- **Recommended:** Parallel (both venues at once)
- **Impact:** Reduces strike selection time

#### Optimization 4: Pre-filter Strikes
- **Current:** Filter during strike selection
- **Recommended:** Pre-filter before selection
- **Impact:** Faster strike selection

#### Optimization 5: Fail Fast on OKX 404s
- **Current:** Waits for 404 response
- **Recommended:** Skip invalid contracts immediately
- **Impact:** Reduces OKX fetch time

**Estimated Time After Optimizations:** 1.5-2.5s ✅

---

## 11. Testing Plan

### Test 1: Check Premium Restrictions
```python
# Test with relaxed restrictions
MIN_VALUE_RATIO = 1.05  # Instead of 1.1
MIN_PREMIUM_USD = 5     # Instead of 10
# See if options appear
```

### Test 2: Check Strike Availability
```python
# Fetch chains for Dec 31, 2025
# Check what strikes exist around $100k
# Verify strikes are within 20% distance
```

### Test 3: Check Full Flow
```python
# Run full hedge flow for KXBTC2025100
# Add detailed logging at each step
# See where it fails
```

### Test 4: Performance Test
```python
# Measure time for each step
# Identify bottlenecks
# Test optimizations
```

---

## 12. Recommendations Summary

### Critical Fixes (Must Do)

1. **Relax MIN_VALUE_RATIO** from 1.1 to 1.05
2. **Lower MIN_PREMIUM_USD** from $10 to $5
3. **Add detailed logging** to see WHY hedges are rejected
4. **Test with relaxed restrictions** to verify hypothesis

### High Priority Fixes

1. **Increase strike distance** from 20% to 30%
2. **Reduce Deribit batch delays** from 1s to 0.2s
3. **Parallelize venue processing**
4. **Cache option chains** more aggressively

### Medium Priority Fixes

1. **Improve fallback logic** for strike selection
2. **Fail fast on OKX 404s**
3. **Pre-filter strikes** before selection
4. **Optimize event fetching** (reduce delays)

---

## 13. Expected Outcomes After Fixes

### If Premium Restrictions Are Main Issue:
- ✅ Options should appear immediately after relaxing restrictions
- ✅ Preview badges should show tier counts
- ✅ All events should have hedge options

### If Strike Selection Is Main Issue:
- ✅ More strikes available after increasing distance
- ✅ Fallback logic should work better
- ✅ Options should appear for more events

### Performance After Optimizations:
- ✅ Total time: <2s (from 4-7s)
- ✅ Faster chain fetching (1s instead of 5s)
- ✅ Parallel venue processing

---

## 14. Next Steps

1. **Add detailed logging** to see WHERE flow fails
2. **Test with relaxed restrictions** to verify hypothesis
3. **Check strike availability** in option chains
4. **Compare with old implementation** restrictions
5. **Implement fixes** based on findings

---

**Ready for implementation once analysis is approved.**

