# Root Cause Analysis: Options Not Loading

## Summary
Backend API is returning `hedge_unavailable` for `KXBTCMAXY-25` event. Frontend correctly shows 0 options for both YES and NO positions.

## Findings

### 1. Events Endpoint Returns Correct Data ✅
The `/events/btc/top-volume` endpoint returns:
- Event with `series_ticker: "KXBTCMAXY"`
- `choices` array with 2 choices
- First choice has `price_threshold: 129999.99`
- Structure is correct

### 2. Backend API Returns No Options ❌
Both YES and NO positions return:
```json
{
    "status": "hedge_unavailable",
    "candidates": []
}
```

### 3. Event Matching Logic Issue (Suspected)
**Location**: `api/main.py` lines 660-737

**Problem**: When frontend sends `KXBTCMAXY-25`:
1. Backend should match it to cached event
2. Extract `choice_threshold` from first choice (`129999.99`)
3. Pass threshold to hedge request

**Potential Issues**:
- `app.state.btc_events` cache might not be populated when `/kalshi/hedge-quote` is called
- Cache might have different structure than expected
- Matching logic might fail silently
- `choice_threshold` might be `None` even if event is matched

### 4. Cache Structure Mismatch (Likely Root Cause)
**Issue**: The `/events/btc/top-volume` endpoint formats events differently than what `/kalshi/hedge-quote` expects.

**Events Endpoint Format** (lines 171-365):
- Returns formatted events with `choices` array
- Stores in `app.state.btc_events` as formatted events

**Hedge Quote Endpoint Expects** (lines 666-696):
- Looks for `cached_event.get('choices', [])`
- Extracts `first_choice.get('price_threshold')`

**BUT**: The cache might be populated with raw events from `event_fetcher.get_top_4_btc_events()` which have different structure!

**Line 668**: `app.state.btc_events = await event_fetcher.get_top_4_btc_events()`
- This stores RAW events, not formatted events
- Raw events don't have `choices` array!
- They have individual events per choice, not grouped by series

### 5. The Real Problem
When `/kalshi/hedge-quote` tries to match `KXBTCMAXY-25`:
1. Checks `app.state.btc_events` cache
2. Cache might be empty or have raw events (not formatted)
3. Tries to find event with `series_ticker == "KXBTCMAXY"`
4. Raw events have `ticker` like `"KXBTCMAXY-25-DEC31-129999.99"` (full ticker)
5. Extracts `series_ticker = ticker.split('-')[0]` → `"KXBTCMAXY"` ✅
6. BUT: Raw events don't have `choices` array!
7. So `cached_event.get('choices', [])` returns `[]`
8. No choices → no threshold extracted → `choice_threshold = None`
9. Hedge request created without threshold → uses default threshold (might be wrong)
10. Wrong threshold → wrong strike selection → no options found

## Solution

### Option 1: Populate Cache with Formatted Events
When `/kalshi/hedge-quote` populates cache, use the same formatting logic as `/events/btc/top-volume`:
- Group events by series
- Create `choices` array
- Store formatted events in cache

### Option 2: Extract Threshold from Raw Event
If cache has raw events, extract threshold directly from event ticker:
- Parse ticker: `KXBTCMAXY-25-DEC31-129999.99`
- Extract threshold: `129999.99` (last part if > 1000)

### Option 3: Always Use First Event's Threshold
For "how" events, use the first event's threshold directly:
- Find first event with matching series_ticker
- Extract threshold from its ticker
- Use that threshold

## Recommended Fix

**Use Option 3** (simplest and most reliable):
1. When matching `KXBTCMAXY-25`, find first event with `series_ticker == "KXBTCMAXY"`
2. Extract threshold from event's ticker (last part if numeric and > 1000)
3. Use that threshold for hedge request

This works regardless of cache structure and is more robust.
