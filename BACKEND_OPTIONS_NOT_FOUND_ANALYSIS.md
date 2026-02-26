# Backend Options Not Found - Analysis

## Problem
Backend API is returning `hedge_unavailable` for both YES and NO positions on `KXBTCMAXY-25` event.

## API Test Results

### YES Position:
```json
{
    "status": "hedge_unavailable",
    "candidates": [],
    "rejection_reasons": {
        "no_options": ["No suitable hedge options found"]
    }
}
```

### NO Position:
```json
{
    "status": "hedge_unavailable",
    "candidates": [],
    "rejection_reasons": {
        "no_options": ["No suitable hedge options found"],
        "strike_availability": [
            "No CALL strikes available above the threshold with sufficient liquidity..."
        ]
    }
}
```

## Root Cause Analysis

### Issue 1: Event Matching & Threshold Extraction
**Location**: `api/main.py` lines 660-737

**Problem**: When frontend sends `KXBTCMAXY-25` (base ticker), backend needs to:
1. Match it to cached events
2. Extract `choice_threshold` from first choice
3. Use that threshold for hedge calculation

**Current Flow**:
1. Frontend sends: `event_id=KXBTCMAXY-25`
2. Backend parses: `event_ticker_base = "KXBTCMAXY"`, `parts = ["KXBTCMAXY", "25"]`
3. Checks: `len(parts) == 2` and `event_ticker_base in ['KXBTCMAXY', 'KXBTCMINY']` ✅
4. Tries to match from `app.state.btc_events` cache
5. If matched, extracts `choice_threshold` from first choice
6. Creates hedge request with `choice_threshold`

**Potential Issues**:
- Cache might not be populated (`app.state.btc_events` might be empty)
- Cache might not have `choices` array populated correctly
- `choice_threshold` might be `None` or incorrect
- Event matching logic might fail

### Issue 2: Threshold Not Being Passed Correctly
**Location**: `api/main.py` lines 748-756

**Problem**: Even if `choice_threshold` is extracted, it needs to be passed to `HedgeQuoteRequest`:
```python
hedge_request = HedgeQuoteRequest(
    event_ticker=event_ticker_for_matching,
    direction=direction,
    stake_usd=Decimal(str(stake)),
    hedge_budget_usd=Decimal(str(stake * 0.2)),
    choice_ticker=choice_ticker if choice_ticker else None,
    choice_threshold=choice_threshold if choice_threshold else None  # ← This might be None
)
```

If `choice_threshold` is `None`, the hedge calculation will use the event's default threshold, which might not match the actual choice.

### Issue 3: Option Chain Availability
**Location**: `api/main.py` lines 444-453

**Problem**: Even with correct threshold, option chains might not be available:
- Expiry date might not match available options
- Option chains might be empty
- Strikes might not exist near the threshold

### Issue 4: Strike Selection Failing
**Location**: `services/hedging/strike_selector.py`

**Problem**: Even if chains are available, strike selection might fail:
- For `KXBTCMAXY` + YES: Needs PUT spreads below threshold
- For `KXBTCMAXY` + NO: Needs CALL spreads above threshold
- Strikes might not exist in the required region
- Strikes might exist but have invalid prices (zero bid/ask)

### Issue 5: Premium Calculation Rejecting Candidates
**Location**: `services/hedging/premium_calculator.py`

**Problem**: Even if strikes are found, premium calculation might reject:
- Negative or zero premium
- Premium > max_payout
- Ratio < 1.1
- Other economic validity checks

## Investigation Steps Needed

1. **Check Event Cache**: Verify `app.state.btc_events` has `KXBTCMAXY` events with `choices` array
2. **Check Threshold Extraction**: Verify `choice_threshold` is being extracted correctly
3. **Check Hedge Request**: Verify `choice_threshold` is being passed to `HedgeQuoteRequest`
4. **Check Option Chains**: Verify chains are being fetched for the correct expiry
5. **Check Strike Selection**: Verify strikes are being found near the threshold
6. **Check Premium Calculation**: Verify why candidates are being rejected

## Most Likely Root Cause

**Combination of Issues 1 and 2**:
- Event cache might not be populated correctly
- `choice_threshold` might be `None` or incorrect
- Without correct threshold, hedge calculation uses wrong barrier
- Wrong barrier → wrong strike selection → no options found

## Recommended Debugging

1. Add logging to verify:
   - What threshold is being extracted?
   - What threshold is being passed to hedge request?
   - Are option chains being fetched?
   - Are strikes being found?
   - Why are candidates being rejected?

2. Test with explicit threshold:
   - Try calling API with full ticker including threshold
   - Example: `KXBTCMAXY-25-DEC31-129999.99`
   - See if options are found with explicit threshold

3. Check backend logs for:
   - Event matching success/failure
   - Threshold extraction
   - Option chain fetch results
   - Strike selection results
   - Premium calculation rejections

