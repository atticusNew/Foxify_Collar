# "Will BTC Price" Modal Showing Old Format - Analysis

## Issue
"Will BTC price" hedge modal sometimes shows old format with "Loading..." states, while other events open directly to correct format.

## Root Cause Analysis

### Event Ticker Format

**"Will BTC price" event**:
- Series ticker: `KXBTC2025100`
- Full ticker format: `KXBTC2025100-25DEC31-100000`
- This is a **simple event** (not "how" or "when will")
- Should use **full ticker** for hedge requests

**"How" events** (working correctly):
- Series ticker: `KXBTCMAXY` or `KXBTCMINY`
- Full ticker: `KXBTCMAXY-25-DEC31-129999.99`
- Frontend extracts base ticker: `KXBTCMAXY-25`
- Backend matches and uses first choice's threshold

### Current EventTicker Extraction Logic

**Location**: `HedgeModal.jsx` lines ~30-69

**Logic Flow**:
1. If `choice?.market_ticker` → Extract base ticker (first 2 parts)
2. Else if `choice?.event_ticker` → Use as-is
3. Else if `event?.event_ticker` → Use as-is
4. Else if `event?.market_id` → Use as-is
5. If ticker has >2 parts and no choice → Extract base ticker (first 2 parts)

**Problem**: 
- For "Will BTC price", `event.event_ticker` might be `KXBTC2025100-25DEC31-100000` (full ticker)
- The logic at line ~61-69 extracts base ticker if it has >2 parts: `KXBTC2025100-25DEC31-100000` → `KXBTC2025100-25`
- But `KXBTC2025100-25` is NOT the correct format - it should be the full ticker `KXBTC2025100-25DEC31-100000`

### Backend Event Formatting

**Location**: `api/main.py` line ~334

**Current Logic**:
```python
"event_ticker": ticker if series_ticker not in ['KXBTCMAXY', 'KXBTCMINY'] else series_ticker
```

**For "Will BTC price"**:
- `series_ticker = "KXBTC2025100"`
- `ticker = "KXBTC2025100-25DEC31-100000"` (full ticker)
- `event_ticker = ticker` ✅ (correct - uses full ticker)

**But frontend might be receiving**:
- `event.event_ticker = "KXBTC2025100-25DEC31-100000"` ✅
- Or `event.market_id = "KXBTC2025100-25DEC31-100000"` ✅

### Cache Key Issue

**Problem**: 
- Cache key is based on `eventTicker`
- If `eventTicker` is extracted incorrectly (e.g., `KXBTC2025100-25` instead of `KXBTC2025100-25DEC31-100000`), cache won't match
- Modal opens → Checks cache → No match → Fetches → Shows loading state

### Frontend Event Data

**Location**: `EventsGrid.jsx` lines ~40-63

**Event Format**:
```jsx
{
  id: e.market_id || e.event_ticker,
  event_ticker: e.event_ticker,  // Full ticker: "KXBTC2025100-25DEC31-100000"
  market_id: e.market_id,        // Same: "KXBTC2025100-25DEC31-100000"
  ...
}
```

**When opening modal**:
- `event.event_ticker = "KXBTC2025100-25DEC31-100000"` ✅
- `event.market_id = "KXBTC2025100-25DEC31-100000"` ✅

### HedgeModal eventTicker Extraction

**Current Logic** (line ~52-58):
```jsx
else if (event?.event_ticker) {
  eventTicker = event.event_ticker  // ✅ Should be "KXBTC2025100-25DEC31-100000"
} else if (event?.market_id) {
  eventTicker = event.market_id     // ✅ Fallback: "KXBTC2025100-25DEC31-100000"
}
```

**Then** (line ~61-69):
```jsx
// For "how" events without choices, extract series ticker if it's a full market ticker
if (eventTicker && eventTicker.includes('-') && eventTicker.split('-').length > 2 && !choice) {
  // Market ticker like "KXBTCMAXY-25-DEC31-129999.99" -> base ticker "KXBTCMAXY-25"
  const parts = eventTicker.split('-')
  if (parts.length >= 2) {
    eventTicker = parts[0] + '-' + parts[1]  // ❌ WRONG for "Will BTC price"!
  }
}
```

**Problem**: 
- This logic assumes ALL events with >2 parts are "how" events
- But "Will BTC price" has format `KXBTC2025100-25DEC31-100000` (3 parts: series-year-date-price)
- It extracts `KXBTC2025100-25` which is incorrect
- Should only apply this logic to "how" events (`KXBTCMAXY`, `KXBTCMINY`)

## Solution

### Fix: Only Extract Base Ticker for "How" Events

**Change**: Only apply base ticker extraction if it's a "how" event

**Code**:
```jsx
// For "how" events without choices, extract series ticker if it's a full market ticker
const isHowEvent = eventTicker && (
  eventTicker.startsWith('KXBTCMAXY-') || 
  eventTicker.startsWith('KXBTCMINY-')
)

if (isHowEvent && eventTicker.includes('-') && eventTicker.split('-').length > 2 && !choice) {
  // Market ticker like "KXBTCMAXY-25-DEC31-129999.99" -> base ticker "KXBTCMAXY-25"
  const parts = eventTicker.split('-')
  if (parts.length >= 2) {
    eventTicker = parts[0] + '-' + parts[1]
  }
}
// For other events (like "Will BTC price"), keep full ticker
```

## Expected Behavior After Fix

**"Will BTC price" event**:
- `event.event_ticker = "KXBTC2025100-25DEC31-100000"`
- `eventTicker = "KXBTC2025100-25DEC31-100000"` ✅ (full ticker, not truncated)
- Cache key: `"KXBTC2025100-25DEC31-100000"`
- Backend receives: `"KXBTC2025100-25DEC31-100000"` ✅
- Options load correctly ✅

**"How" events** (unchanged):
- `event.event_ticker = "KXBTCMAXY-25-DEC31-129999.99"`
- `eventTicker = "KXBTCMAXY-25"` ✅ (base ticker extracted)
- Cache key: `"KXBTCMAXY-25"`
- Backend matches and uses first choice ✅

