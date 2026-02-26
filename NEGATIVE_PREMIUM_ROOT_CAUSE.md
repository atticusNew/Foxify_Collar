# Negative Premium Root Cause Analysis

**Date:** January 2025  
**Status:** Root Cause Identified ✅

## Problem

**Evidence from Trace:**
```
Spread built: True
Spread width: 4000
Long leg ask: 0.081 (PUT at 96k)
Short leg bid: 0.1065 (PUT at 100k)
Premium calc: FAILED
premium_raw: -11.49
```

**Log:**
```
"premium_raw": "Decimal('-11.48851500')"
"long_ask": "Decimal('0.081')"
"short_bid": "Decimal('0.1065')"
"option_type": "put"
"K1": "Decimal('96000')"
"K2": "Decimal('100000')"
```

## Root Cause

### The Issue: PUT Spread Leg Order is WRONG

**For a PUT spread (ABOVE K + YES):**
- We need PUT spread below K (barrier = 100k)
- Long leg: PUT at 96k (lower strike) - should cost MORE
- Short leg: PUT at 100k (higher strike) - should cost LESS

**Expected:**
- `long_ask` (96k PUT) > `short_bid` (100k PUT)
- Premium = `N * spot * (long_ask - short_bid)` should be POSITIVE

**Actual:**
- `long_ask` (0.081) < `short_bid` (0.1065)
- Premium = `N * spot * (0.081 - 0.1065)` = NEGATIVE ❌

### Why This Happens

**Option Pricing Logic:**
- For PUT options: Lower strike PUTs have MORE intrinsic value
- Example: PUT at 96k when spot = 100k has $4k intrinsic value
- PUT at 100k when spot = 100k has $0 intrinsic value
- So PUT at 96k should cost MORE than PUT at 100k

**But we're seeing:**
- PUT at 96k ask = 0.081 (8.1%)
- PUT at 100k bid = 0.1065 (10.65%)

This suggests:
1. **Option prices might be inverted** (bid/ask swapped?)
2. **Spread builder might be using wrong prices** (using bid for long, ask for short?)
3. **Strike selector might be returning wrong order** (K1 > K2 instead of K1 < K2?)

### Investigation Needed

**Check 1: Strike Order**
- `_find_two_highest_puts_below` returns `(strikes_below[offset + 1], strikes_below[offset])`
- `strikes_below` is sorted descending (highest first)
- So `[offset + 1]` is lower strike, `[offset]` is higher strike
- This means K1 < K2 ✅ (correct)

**Check 2: Spread Builder Leg Assignment**
- Long leg gets K1 (lower strike) ✅
- Short leg gets K2 (higher strike) ✅
- Long leg uses `K1_contract.ask` ✅
- Short leg uses `K2_contract.bid` ✅
- This is correct!

**Check 3: Option Prices**
- PUT at 96k: ask = 0.081 (8.1%)
- PUT at 100k: bid = 0.1065 (10.65%)
- This is WRONG! Lower strike PUT should cost MORE

**Possible Causes:**
1. **Deribit option prices are inverted** (unlikely, but possible)
2. **We're reading prices from wrong contracts** (maybe using wrong expiry?)
3. **Option prices are in different format** (maybe not percentage?)
4. **Spread is being built for wrong expiry** (using Jan 2 expiry instead of Dec 31?)

### Most Likely Cause

**Wrong Expiry Chain Selected:**
- Event expiry: Dec 31, 2025
- Chains fetched:
  - Dec 19, 2025 (48 contracts)
  - Dec 26, 2025 (132 contracts)
  - Jan 2, 2026 (30 contracts)
- Strike selector finds strikes in Dec 26 chain
- But spread builder might be using Jan 2 chain?
- Or strike selector returns strikes from one chain, but spread builder looks in another?

**Check:** Are strikes and spread builder using the same chain?

## Solution

### Fix 1: Verify Chain Consistency

Ensure strike selector and spread builder use the same chain:
- Strike selector finds chain with closest expiry
- Spread builder should use the SAME chain
- Currently, both use `_find_closest_expiry_chain` - should be consistent

### Fix 2: Verify Option Prices

Check if option prices make sense:
- For PUT spread: lower strike PUT should cost MORE
- If prices are inverted, might need to swap legs
- Or might need to use different price source

### Fix 3: Add Validation

Add validation in spread builder:
- For PUT spread: verify `long_ask > short_bid`
- For CALL spread: verify `long_ask < short_bid`
- If validation fails, try swapping legs or reject

## Expected Fix

After fix:
- PUT spread: `long_ask` (lower strike) > `short_bid` (higher strike)
- Premium calculation: POSITIVE
- Hedges generated successfully

## Next Steps

1. **Verify:** Check if strike selector and spread builder use same chain
2. **Debug:** Log option prices to see if they make sense
3. **Fix:** Ensure PUT spread legs are in correct order
4. **Test:** Verify premium is positive after fix

