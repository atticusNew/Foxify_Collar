# "How High" Events Showing No Options - Analysis

**Date:** January 2025  
**Status:** Analysis Only - No Changes Yet

## Problem Statement

User reports that "how high" events (KXBTCMAXY) are showing **no options**, while other events are working correctly. This worked previously, suggesting a regression or specific issue.

## Current Flow for "How High" Events

### 1. Frontend → Backend Request
- Frontend sends: `event_id=KXBTCMAXY-25` (base ticker)
- Direction: `yes` or `no`
- Stake: `100.0` (default)

### 2. Backend Processing (`/kalshi/hedge-quote`)

**Step 1: Parse event_id**
- Splits `KXBTCMAXY-25` → `parts = ['KXBTCMAXY', '25']`
- `event_ticker_base = 'KXBTCMAXY'`
- Detects: `len(parts) == 2` and `event_ticker_base in ['KXBTCMAXY', 'KXBTCMINY']`
- `choice_ticker = None` initially

**Step 2: Match from Cache**
- Checks `app.state.btc_events` for event with `series_ticker == 'KXBTCMAXY'`
- If found, extracts `choice_threshold` from:
  - First choice in `choices` array: `choices[0].get('price_threshold')`
  - OR from raw event ticker: `KXBTCMAXY-25-DEC31-129999.99` → extracts `129999.99`
  - OR from `threshold_price` field
- Sets `choice_ticker` and `choice_threshold`

**Step 3: Create HedgeQuoteRequest**
```python
HedgeQuoteRequest(
    event_ticker="KXBTCMAXY-25-DEC31-129999.99" or "KXBTCMAXY-25",  # Full ticker or base
    direction="yes" or "no",
    stake_usd=Decimal("100"),
    hedge_budget_usd=Decimal("20"),
    choice_ticker="KXBTCMAXY-25-DEC31-129999.99",  # If matched
    choice_threshold=Decimal("129999.99")  # If matched
)
```

**Step 4: Call `get_hedge_quote()`**
- Fetches **fresh events** (not using cache)
- Tries to match event:
  - If `choice_ticker` provided: Match by `ticker == choice_ticker`
  - Else: Match by `event_ticker` (various strategies)

**Step 5: Parse Event**
- Calls `event_parser.parse(event_dict)`
- If `choice_threshold` provided: Overrides `canonical_event.threshold_price = choice_threshold`

**Step 6: Build Hedge**
- Uses `canonical_event.threshold_price` as barrier
- For "how high" (ABOVE event):
  - YES: PUT spreads below threshold
  - NO: CALL spreads above threshold

## Potential Issues

### Issue 1: Cache Not Populated
**Symptom:** `app.state.btc_events` is empty or doesn't contain KXBTCMAXY events

**Root Cause:**
- Cache is populated by `/events/btc/top-volume` endpoint
- If frontend hasn't called this endpoint, cache is empty
- Fallback tries fresh fetch, but matching might fail

**Detection:**
- Check logs for: `"BTC events cache not populated"`
- Check logs for: `"Failed to match base ticker from cache"`

### Issue 2: Choice Threshold Extraction Fails
**Symptom:** `choice_threshold` is `None` after matching

**Root Cause:**
- Cached event doesn't have `choices` array
- Ticker parsing fails (e.g., wrong format)
- `threshold_price` field missing

**Detection:**
- Check logs for: `"Matched 'how' event from cache"` without `choice_threshold`
- Check if `choice_threshold` is `None` in hedge request

### Issue 3: Event Matching Fails in `get_hedge_quote()`
**Symptom:** `event_dict` is `None` after matching attempt

**Root Cause:**
- Fresh fetch returns different event structure
- `choice_ticker` doesn't match any event's ticker
- `event_ticker` matching logic fails

**Detection:**
- Check logs for: `"Event not found: ..."`
- Check if `event_dict` is `None` before parsing

### Issue 4: Threshold Price is Zero or Invalid
**Symptom:** Strike selection fails because barrier is 0 or invalid

**Root Cause:**
- `choice_threshold` is `None` → `canonical_event.threshold_price` defaults to 0 or wrong value
- Event parser extracts wrong threshold from event

**Detection:**
- Check logs for: `"Creating hedge request"` with `choice_threshold=None`
- Check if `barrier` in hedge request is 0 or invalid

### Issue 5: Strike Selection Fails
**Symptom:** No strikes found above/below threshold

**Root Cause:**
- Threshold is too high/low (e.g., $130k when BTC is at $100k)
- No option strikes available at that level
- Option chains don't have strikes near threshold

**Detection:**
- Check logs for: `"Not enough call strikes above barrier"` or `"Not enough put strikes below barrier"`
- Check if option chains are fetched successfully

### Issue 6: Premium Calculation Fails
**Symptom:** Strikes found but premium calculation rejects them

**Root Cause:**
- Negative premium (long_ask < short_bid)
- Premium > max_payout (economically invalid)
- Ratio < 1.1 (not enough value)

**Detection:**
- Check logs for: `"Premium calculation failed"` or `"Negative premium"`
- Check logs for: `"No valid candidates found after markup and validity checks"`

## Investigation Steps

1. **Check Cache Population**
   - Verify `/events/btc/top-volume` is called before hedge requests
   - Check if `app.state.btc_events` contains KXBTCMAXY events
   - Verify events have `choices` array with `price_threshold`

2. **Check Threshold Extraction**
   - Log `choice_threshold` value after matching
   - Verify it's a valid Decimal > 1000
   - Check if it matches the first choice's threshold

3. **Check Event Matching**
   - Log `event_ticker_for_matching` and `choice_ticker` values
   - Verify `event_dict` is found in `get_hedge_quote()`
   - Check if matching logic works for KXBTCMAXY events

4. **Check Strike Selection**
   - Log `barrier` value used in strike selection
   - Verify option chains are fetched successfully
   - Check if strikes exist above/below barrier

5. **Check Premium Calculation**
   - Log premium values and ratios
   - Verify premium < max_payout
   - Check if ratio >= 1.1

## Most Likely Causes

Based on the flow, the most likely issues are:

1. **Cache Not Populated** - If frontend hasn't loaded events, cache is empty
2. **Choice Threshold Extraction Fails** - If cached event doesn't have choices array or ticker format is wrong
3. **Event Matching Fails** - If `get_hedge_quote()` can't find the event in fresh fetch

## Recommended Fixes

1. **Ensure Cache is Populated**
   - Always populate cache in `/kalshi/hedge-quote` if empty
   - Use cached events for matching instead of fresh fetch

2. **Improve Threshold Extraction**
   - Add fallback to extract from raw event ticker
   - Validate threshold is valid before using

3. **Improve Event Matching**
   - Use cached events for matching instead of fresh fetch
   - Match by series_ticker if choice_ticker not found

4. **Add Better Logging**
   - Log all threshold values
   - Log matching results
   - Log strike selection results

## Next Steps

1. Check backend logs for "how high" hedge requests
2. Verify cache is populated
3. Check threshold extraction
4. Verify event matching
5. Check strike selection results














