# No Options Available - Root Cause Analysis

**Date:** January 2025  
**Status:** Critical Issues Identified

## Problem

- ❌ Still showing "no options available" for all events
- ❌ Speed doesn't seem improved

## Root Causes Identified

### Issue 1: OptionChainService Not Using Initialized Registry

**Problem:**
- API lifespan initializes Deribit and OKX connectors and stores them in registry
- But `OptionChainService` is created with `registry=None` (line 37)
- This means it gets a NEW registry instance via `get_exchange_registry()` singleton
- The singleton should return the same instance, BUT the connectors might not be in `get_enabled_connectors()`

**Evidence:**
- Debug script shows: "Enabled connectors: 0" initially
- After manual initialization: "Enabled connectors after: 2"
- This suggests registry singleton works, but connectors aren't being cached properly

**Root Cause:**
- `OptionChainService` is created at module level (line 37)
- This happens BEFORE lifespan runs
- So when it's created, registry is empty
- Even though lifespan initializes exchanges later, the service instance already has a reference

**Solution:**
- Pass registry from API to chain service AFTER initialization
- Or ensure chain service gets registry from app state
- Or lazy-initialize chain service

### Issue 2: Rate Limiting (HTTP 429) - Deribit

**Evidence from Logs:**
```
"Deribit API error: HTTP 429 - too_many_requests"
```

**Problem:**
- Deribit is rate limiting our requests
- We're making too many requests too fast
- Even with 0.2s delay, we're hitting rate limits
- Many contracts failing to fetch → chains incomplete → no valid hedges

**Impact:**
- Contracts missing bid/ask prices
- Spreads can't be built
- Premium can't be calculated
- No hedges generated

**Solution:**
- Increase delays further (0.5s between batches)
- Reduce batch size (10 instead of 20)
- Add exponential backoff on 429 errors
- Skip contracts that fail (don't retry immediately)

### Issue 3: Performance Still Slow

**Problems:**
1. **Rate limiting delays:** Even with 0.2s delay, hitting 429s means retries and longer waits
2. **Sequential batch processing:** Still processing batches one at a time
3. **Too many API calls:** Each contract = 2 calls (ticker + orderbook)
4. **No parallelization:** Venue processing is sequential

**Current Flow:**
- Fetch 100 contracts in batches of 20
- 5 batches × 0.2s delay = 1s minimum
- But with 429 errors, retries add more time
- Total: 3-5s just for chain fetching

**Solution:**
- Increase batch delay to 0.5s (respect rate limits)
- Reduce batch size to 10 (fewer concurrent requests)
- Add exponential backoff on 429
- Better error handling (skip failed contracts)

### Issue 4: Premium Calculator Rejecting Valid Hedges

**Potential Issue:**
- Preliminary markup check might be rejecting hedges that would pass after markup
- Example: Raw premium $4, max_payout $5 → ratio 1.25 ✅
- But preliminary check sees: raw < $5 AND max_payout < $5.50 → REJECT ❌
- But after markup: charged $5, max_payout $5 → ratio 1.0 ❌ (would fail anyway)

**However:** This is correct behavior - if max_payout < $5.50, markup would make ratio fail

**Real Issue:** Might be rejecting hedges where max_payout IS >= $5.50 but preliminary check is wrong

## Solutions

### Fix 1: Pass Registry to Chain Service (CRITICAL)

**Change:** Ensure chain service uses initialized registry

**Option A:** Pass registry from API
```python
# In API lifespan, after initializing exchanges:
option_chain_service = OptionChainService(registry=registry)
```

**Option B:** Get registry from app state
```python
# Store registry in app state
app.state.registry = registry
# Chain service gets from app state
```

**Option C:** Lazy initialize chain service
```python
# Don't create at module level
# Create in lifespan or endpoint
```

### Fix 2: Handle Rate Limiting (CRITICAL)

**Changes:**
1. Increase batch delay to 0.5s
2. Reduce batch size to 10
3. Add exponential backoff on 429 errors
4. Skip failed contracts (don't retry immediately)

### Fix 3: Improve Performance

**Changes:**
1. Better caching (longer TTL)
2. Parallelize venue processing
3. Pre-filter contracts before fetching prices

## Expected Outcome

After fixes:
- ✅ Option chains fetched successfully
- ✅ Contracts have valid prices
- ✅ Strikes found
- ✅ Premium calculated
- ✅ Hedges generated
- ✅ Performance improved (<2s)

