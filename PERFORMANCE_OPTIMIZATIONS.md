# Performance Optimizations Applied

**Date:** January 2025  
**Status:** Applied - Monitor for rate limiting issues

## Changes Made

### 1. Removed Per-Contract Delay
**File:** `services/option_chains/chain_service.py` (line ~340)
- **Before:** `await asyncio.sleep(0.05)` - 50ms delay per contract
- **After:** Removed (commented out)
- **Reason:** Semaphore (10 concurrent) + batch delays provide sufficient rate limiting
- **Expected Savings:** ~5 seconds for 100 contracts

### 2. Reduced Batch Delay
**File:** `services/option_chains/chain_service.py` (line ~454)
- **Before:** `await asyncio.sleep(0.2)` - 200ms delay between batches
- **After:** `await asyncio.sleep(0.1)` - 100ms delay between batches
- **Expected Savings:** ~0.5 seconds for 100 contracts (5 batches)

### 3. Increased Cache TTL
**File:** `api/main.py` (line ~453)
- **Before:** `ttl_seconds=120` - 120 second cache
- **After:** `ttl_seconds=180` - 180 second cache
- **Benefit:** Better cache hit rate for repeated queries

## Total Expected Improvement
- **~5-6 seconds faster** for 100 contracts
- **Better cache utilization** for repeated queries

## Rollback Instructions

If rate limiting issues occur (HTTP 429 errors), rollback with:

### Rollback 1: Restore Per-Contract Delay
```python
# In services/option_chains/chain_service.py, line ~340
async def fetch_contract_data(data):
    async with semaphore:
        await asyncio.sleep(0.05)  # Restore 50ms delay
        symbol = data['symbol']
```

### Rollback 2: Restore Batch Delay
```python
# In services/option_chains/chain_service.py, line ~454
if i + batch_size < len(contract_data):
    await asyncio.sleep(0.2)  # Restore 200ms delay
```

### Rollback 3: Restore Cache TTL (optional)
```python
# In api/main.py, line ~453
chains = await chain_cache.get(cache_key, fetch_chains, ttl_seconds=120)
```

## Monitoring

Watch for these signs of rate limiting:
- HTTP 429 errors in logs
- Increased failed contract fetches
- "too_many_requests" errors from Deribit
- Options not loading or taking longer than before

## Status
❌ **ROLLED BACK** - Optimizations caused rate limiting issues

### Rollback Applied
- ✅ Per-contract delay restored (0.05s)
- ✅ Batch delay restored (0.2s)
- ✅ Cache TTL kept at 180s (safe optimization)

### Issue
Removing delays caused Deribit rate limiting (HTTP 429), resulting in "no options available" errors.

### Solution
All delays have been restored. Cache may need clearing if stale empty results were cached. Use `/cache/clear` endpoint or restart server.

