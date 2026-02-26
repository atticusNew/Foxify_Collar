# YES/NO Price Fetching Analysis

**Date:** January 2025  
**Status:** Analysis Only - No Changes Yet

## Problem

All events are showing **50/50% or 0%** for YES/NO probabilities, but the actual Kalshi website shows real percentages for high-volume events.

## Root Cause Analysis

### Current Implementation

**File:** `connectors/kalshi_connector.py` (lines 728-729)
```python
yes_price = DM.to_decimal(str(data.get('yes_bid', '0')))
no_price = DM.to_decimal(str(data.get('no_bid', '0')))
```

**Problem:**
1. Only looking for `yes_bid` and `no_bid` fields
2. If these fields don't exist or are 0, defaults to 0
3. Not checking other possible fields that Kalshi API might return

### What Kalshi API Actually Returns

Based on the old `kalshi_demo` code (`services/strategy/kalshi_adapter.py` lines 1028-1044), the Kalshi API can return prices in multiple formats:

1. **Direct probability fields:**
   - `yes_price` - Direct probability (0-1 range)
   - `no_price` - Direct probability (0-1 range)
   - `probability` - Single probability value

2. **Bid/Ask fields:**
   - `yes_bid` - Bid price for YES
   - `yes_ask` - Ask price for YES
   - `no_bid` - Bid price for NO
   - `no_ask` - Ask price for NO

3. **Format variations:**
   - Prices might be in **0-1 range** (0.5 = 50%)
   - Prices might be in **0-100 range** (50 = 50%)
   - Prices might be in **cents** (50 = 50 cents = 0.50)

### Current Code Issues

**Issue 1: Only Checking Bids**
- Current code only checks `yes_bid` and `no_bid`
- If these are 0 or missing, prices become 0
- Should check multiple fields as fallback

**Issue 2: Not Using Market Data from fetch_markets**
- `fetch_markets()` already returns market data that might include prices
- We're fetching markets, then separately fetching tickers
- Market data might already have `yes_price`/`no_price` fields

**Issue 3: No Fallback Logic**
- Old code had extensive fallback logic (lines 1028-1060)
- Current code has no fallback - just uses defaults
- Should try multiple fields before defaulting

**Issue 4: Market ID Format**
- Using `market_id` or `ticker` to fetch ticker
- But Kalshi API might need exact format
- Need to verify market_id format matches API expectations

## Comparison with Old Working Code

**Old Code (`kalshi_demo/services/strategy/kalshi_adapter.py`):**
```python
# Try multiple fields
yes_price_raw = market.get('yes_bid') or market.get('yes_ask') or market.get('yes_price')
if yes_price_raw:
    yes_price_raw = float(yes_price_raw)
    # Handle different formats (0-1 vs 0-100)
    yes_price = yes_price_raw / 100.0 if yes_price_raw > 1 else yes_price_raw

# Try other fields as fallback
if yes_price is None:
    yes_price_raw = market.get('yes_price') or market.get('yes_ask') or market.get('probability')
    if yes_price_raw:
        yes_price_raw = float(yes_price_raw)
        yes_price = yes_price_raw / 100.0 if yes_price_raw > 1 else yes_price_raw

# Final fallback
if yes_price is None:
    yes_price = 0.5
if no_price is None:
    no_price = 1.0 - yes_price if yes_price else 0.5

# Normalize probabilities
yes_price = max(0.0, min(1.0, yes_price))
no_price = max(0.0, min(1.0, no_price))
total = yes_price + no_price
if total > 0:
    yes_price = yes_price / total
    no_price = no_price / total
```

**Current Code:**
```python
# Only checks yes_bid and no_bid
yes_price = DM.to_decimal(str(data.get('yes_bid', '0')))
no_price = DM.to_decimal(str(data.get('no_bid', '0')))
# No fallback, no normalization, no format handling
```

## What Needs to Be Fixed

### Fix 1: Check Market Data First
- `fetch_markets()` might already return `yes_price`/`no_price`
- Check market data before making separate ticker calls
- Use market data if available

### Fix 2: Add Fallback Logic in fetch_ticker
- Check multiple fields: `yes_price`, `yes_ask`, `yes_bid`, `probability`
- Handle different formats (0-1 vs 0-100)
- Normalize probabilities

### Fix 3: Use Orderbook Data
- If prices not in market data, check orderbook
- Use mid-price from orderbook: `(yes_bid + yes_ask) / 2`
- Or use best bid/ask

### Fix 4: Verify Market ID Format
- Ensure `market_id` format matches Kalshi API expectations
- Check if API needs `ticker` vs `market_id`
- Verify API endpoint format

## Implementation Plan

### Step 1: Check Market Data First
**File:** `services/kalshi/event_fetcher.py`
- Before fetching ticker, check if market data already has prices
- Use `event.get('yes_price')` or `event.get('yes_ask')` if available
- Only fetch ticker if prices not in market data

### Step 2: Fix fetch_ticker Method
**File:** `connectors/kalshi_connector.py`
- Add fallback logic to check multiple fields
- Handle different price formats (0-1 vs 0-100)
- Normalize probabilities to 0-1 range
- Ensure yes_price + no_price = 1.0

### Step 3: Add Logging
- Log which fields were found
- Log price values before/after normalization
- Log if fallback to defaults was used

### Step 4: Test with Real Market
- Test with high-volume market (KXBTCMAXY-25-DEC31-129999.99)
- Verify prices match Kalshi website
- Check all event types (how high, how low, when will, will BTC)

## Expected Behavior

After fix:
- Events should show real YES/NO percentages from Kalshi API
- Percentages should match Kalshi website (within rounding)
- High-volume events should have non-zero prices
- Prices should sum to 100% (yes + no = 100%)

## Risk Assessment

**Low Risk:**
- Adding fallback logic is safe
- Checking multiple fields won't break existing code
- Normalization ensures valid probabilities

**Medium Risk:**
- Need to verify Kalshi API field names
- Format conversion (0-1 vs 0-100) needs testing
- Market ID format might need adjustment

**Mitigation:**
- Test with real API responses
- Add extensive logging
- Fallback to defaults if all else fails
- Verify against Kalshi website

---

**Ready for implementation once approved.**

