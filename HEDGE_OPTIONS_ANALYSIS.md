# Hedge Options Analysis - No Options Showing

**Date:** January 2025  
**Status:** Analysis Only - No Changes Yet

## Problem Statement

- ❌ **No hedge options showing for ANY event**
- ❌ **Speed is too slow** (need <2s, currently slower)
- ❌ **Preview badges showing "No options" for all events**

---

## Investigation Areas

### 1. Exchange Connectivity (Deribit & OKX)

**Question:** Is it checking both Deribit and OKX?

**Current Implementation:**
- `OptionChainService.get_option_chains()` fetches from both exchanges in parallel
- Uses `asyncio.gather()` for parallel fetching
- Returns chains grouped by exchange

**Evidence from Logs:**
```
- OKX: Many 404 errors (contracts don't exist)
- Deribit: Successfully fetching chains
- Total chains retrieved: 3 chains, 210 contracts
```

**Analysis:**
✅ **YES** - Both exchanges are being checked
⚠️ **Issue:** OKX returning many 404s (contracts may not exist or format wrong)
✅ **Deribit working** - Successfully fetching option chains

---

### 2. Option Chain Fetching

**Current Flow:**
1. `OptionChainService.get_option_chains()` called
2. Fetches from Deribit and OKX in parallel
3. Filters by expiry date (within ±14 days)
4. Returns list of `OptionChain` objects

**Potential Issues:**
- Expiry date filtering might be too strict
- OKX product ID format might be incorrect
- Chains might not have contracts near threshold price

**Evidence:**
- Logs show: "Retrieved option chains: exchange_count=2, chain_count=3, total_contracts=210"
- This suggests chains ARE being fetched
- But may not have suitable strikes

---

### 3. Strike Selection Logic

**Current Implementation:**
- `StrikeSelector.find_strikes()` implements rules per event type
- Has fallback logic (up to 3 alternative strikes)
- Checks strike distance from barrier (max 20%)

**Potential Issues:**

#### Issue A: Strike Distance Restriction Too Strict
```python
MAX_STRIKE_DISTANCE_RATIO = Decimal('0.2')  # 20% from barrier
```
- If barrier is $100k, strikes must be within $80k-$120k
- May reject valid strikes that are slightly further

#### Issue B: Fallback Logic May Not Work
- Tries up to 3 alternatives
- But if initial strikes fail, alternatives might also fail
- No logging of WHY strikes are rejected

#### Issue C: Strike Selection Rules
- For "ABOVE" events with YES: Need CALL spread above K
- For "ABOVE" events with NO: Need CALL spread at/above K
- May not find strikes if:
  - No strikes exist above threshold
  - Strikes exist but don't have valid bid/ask

**Evidence Needed:**
- Check if strikes are being found but rejected later
- Check if strike selection is returning None
- Check strike availability around threshold prices

---

### 4. Premium Calculation Restrictions

**Current Restrictions:**

#### Restriction A: Minimum Premium
```python
MIN_PREMIUM_USD = Decimal('10')  # Minimum $10 premium
```
- Rejects hedges with premium < $10
- May be too high for small budgets

#### Restriction B: Minimum Value Ratio
```python
MIN_VALUE_RATIO = Decimal('1.1')  # Max payout must be 10% more than premium
```
- Requires: `max_payout / premium >= 1.1`
- This means premium must be < 90.9% of max_payout
- May reject valid hedges with tight spreads

#### Restriction C: Premium Must Be Less Than Max Payout
```python
if premium_final > max_payout_final:
    return None  # Reject
```
- This is correct (economically sound)
- But combined with MIN_VALUE_RATIO, may be too strict

**Potential Issues:**
1. **Too Strict Together:** MIN_VALUE_RATIO + MIN_PREMIUM may reject many valid hedges
2. **No Logging:** Don't know WHY premium calc is rejecting
3. **Budget Scaling:** May scale notional down too much, making premium too small

**Example:**
- If spread width is $10k and initial notional is 0.01 BTC
- Max payout = 0.01 * 10000 = $100
- Premium might be $95 (95% of max payout)
- This gets rejected because ratio is 1.05 < 1.1

---

### 5. Venue Optimizer Logic

**Current Implementation:**
- Takes best candidate from all venues
- Generates 3 tiers (Light/Standard/Max) by scaling notional
- Each tier recalculates premium

**Potential Issues:**

#### Issue A: Single Best Candidate
- Only uses ONE best candidate
- If that candidate fails premium calc for tiers, all fail
- Doesn't try next best candidate

#### Issue B: Tier Scaling May Fail
- Scales notional by 0.5x, 1.0x, 1.5x
- Each tier recalculates premium
- If any tier fails premium restrictions, it's rejected
- May result in 0 tiers even if base candidate is valid

#### Issue C: Score Calculation
```python
score = premium / max_payout  # Lower is better
```
- This is correct
- But if no candidates pass premium calc, score doesn't matter

---

### 6. Performance Analysis

**Current Bottlenecks:**

#### Bottleneck A: Sequential Option Chain Fetching
- Fetches chains for each venue sequentially
- Should be parallel but may have delays

#### Bottleneck B: Strike Selection Per Venue
- Loops through venues sequentially
- For each venue, tries strike selection
- If strikes fail, tries alternatives (up to 3x)

#### Bottleneck C: Premium Calculation Per Candidate
- For each candidate, calculates premium
- Then scales for 3 tiers (3x calculations)
- Each calculation may involve API calls for bid/ask

#### Bottleneck D: OKX 404 Errors
- Many OKX API calls returning 404
- Each 404 still takes time (network latency)
- Should fail fast or skip invalid contracts

**Estimated Times:**
- Event fetching: ~1-2s (with ticker fetching)
- Option chain fetching: ~2-3s (Deribit + OKX)
- Strike selection: ~0.5-1s per venue
- Premium calculation: ~0.5-1s per candidate
- **Total: 4-7s** (too slow, need <2s)

---

## Root Cause Analysis

### Hypothesis 1: Premium Restrictions Too Strict
**Likelihood:** 🔴 **HIGH**

**Evidence:**
- MIN_VALUE_RATIO = 1.1 requires premium < 90.9% of max_payout
- Combined with MIN_PREMIUM = $10
- Many valid hedges may be rejected

**Test:**
- Check if strikes are found but premium calc rejects them
- Check rejection reasons in logs

---

### Hypothesis 2: Strike Selection Failing
**Likelihood:** 🟡 **MEDIUM**

**Evidence:**
- Strike distance restriction (20% from barrier)
- May not find strikes within range
- Fallback logic may not work correctly

**Test:**
- Check if strikes are being found
- Check strike availability around threshold prices

---

### Hypothesis 3: Option Chains Don't Have Suitable Strikes
**Likelihood:** 🟡 **MEDIUM**

**Evidence:**
- OKX returning many 404s
- Chains fetched but may not have strikes near threshold
- Expiry date filtering may exclude valid chains

**Test:**
- Check what strikes are available in chains
- Check if strikes exist around threshold prices

---

### Hypothesis 4: Venue Optimizer Only Using One Candidate
**Likelihood:** 🟢 **LOW**

**Evidence:**
- Takes single best candidate
- If that fails, all tiers fail
- But should still show at least one tier if candidate is valid

---

## Comparison with Old Implementation

**Need to check:**
1. What restrictions did old code have?
2. How did it handle premium calculations?
3. What was the minimum value ratio?
4. How did it handle strike selection?

**Key Differences to Investigate:**
- Old code may have had looser restrictions
- Old code may have used different strike selection
- Old code may have had different premium logic

---

## Performance Comparison

**Target:** <2s total
**Current:** 4-7s estimated

**Bottlenecks:**
1. Event fetching: 1-2s (can optimize)
2. Option chains: 2-3s (can cache, parallel better)
3. Strike selection: 0.5-1s (can optimize)
4. Premium calc: 0.5-1s (can cache bid/ask)

**Optimization Opportunities:**
1. Cache option chains more aggressively
2. Parallelize venue processing
3. Fail fast on OKX 404s
4. Cache bid/ask prices
5. Pre-filter strikes before premium calc

---

## Recommendations

### Priority 1: Fix Premium Restrictions (CRITICAL)
1. **Lower MIN_VALUE_RATIO** from 1.1 to 1.05 (5% instead of 10%)
2. **Lower MIN_PREMIUM** from $10 to $5
3. **Add logging** to see WHY premium calc rejects
4. **Test with relaxed restrictions** to see if options appear

### Priority 2: Fix Strike Selection (HIGH)
1. **Increase MAX_STRIKE_DISTANCE_RATIO** from 20% to 30%
2. **Add logging** for strike selection failures
3. **Check strike availability** around threshold prices
4. **Improve fallback logic** to try more alternatives

### Priority 3: Optimize Performance (MEDIUM)
1. **Cache option chains** more aggressively (longer TTL)
2. **Parallelize venue processing**
3. **Fail fast on OKX 404s** (skip invalid contracts)
4. **Cache bid/ask prices** to avoid repeated API calls

### Priority 4: Improve Logging (MEDIUM)
1. **Add detailed logging** at each step
2. **Log rejection reasons** for premium calc
3. **Log strike selection attempts**
4. **Log venue processing results**

---

## Testing Plan

### Test 1: Check Strike Availability
- Fetch option chains for Dec 31, 2025
- Check what strikes exist around $100k
- Verify strikes are within 20% distance

### Test 2: Test Premium Calculation
- Manually create a spread
- Calculate premium with current restrictions
- See if it passes or fails
- Test with relaxed restrictions

### Test 3: Test Full Flow
- Run full hedge flow for KXBTC2025100
- Add logging at each step
- See where it fails

### Test 4: Performance Test
- Measure time for each step
- Identify bottlenecks
- Test optimizations

---

## Next Steps

1. **Add detailed logging** to see where flow fails
2. **Test with relaxed restrictions** to verify hypothesis
3. **Check strike availability** in option chains
4. **Compare with old implementation** to see differences
5. **Optimize performance** once options are working

---

**Ready for implementation once analysis is approved.**

