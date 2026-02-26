# Remaining Issues Analysis

**Date:** January 2025  
**Status:** Analysis Only - No Changes Yet

## Issues Identified

### Issue 1: "When Will" Events All Show Same Date (Jan 2, 2025)

**Current State:**
- All "when will" event choices show "By Jan 02, 2025"
- Should show different dates (e.g., "By Dec 31, 2025", "By Jan 15, 2026", "By Feb 28, 2026")

**Root Cause:**
**File:** `api/main.py` (lines 266-277)
```python
settlement_date_str = choice_event.get('expected_expiration_time', '') or choice_event.get('settlement_date', '')
# Format date as "By [Date]"
choice_label = "By " + settlement_date_str[:10] if settlement_date_str else choice_event.get('title', '')

# Try to parse and format date nicely
try:
    from datetime import datetime
    if settlement_date_str:
        dt = datetime.fromisoformat(settlement_date_str.replace('Z', '+00:00'))
        choice_label = f"By {dt.strftime('%b %d, %Y')}"
except:
    pass
```

**Problem:**
1. All events in the same series (`KXBTCMAX150`) might have the same `expected_expiration_time` or `settlement_date`
2. Need to extract date from the ticker itself (e.g., `KXBTCMAX150-25-26FEB28-149999.99` contains date `26FEB28`)
3. Ticker format: `KXBTCMAX150-{year}-{date}-{price}` where date is in format like `26FEB28` (YYMMMDD)

**Solution:**
- Parse date from ticker: `KXBTCMAX150-25-26FEB28-149999.99` → extract `26FEB28` → parse as Feb 28, 2026
- Use ticker date as primary source, fallback to `settlement_date` if ticker parsing fails

---

### Issue 2: "When Will" Should Show Only Top 2 Choices

**Current State:**
- `event_fetcher.py` line 167: Returns top 3 date choices (`top_dates = series_events[:3]`)
- Should return only top 2 choices

**Root Cause:**
**File:** `services/kalshi/event_fetcher.py` (line 167)
```python
elif series == 'KXBTCMAX150':
    # For "when will" events, return top 2-3 date variants by volume
    top_dates = series_events[:3]  # Top 3 date choices
    result_events.extend(top_dates)
```

**Solution:**
- Change `[:3]` to `[:2]` to match "how" events behavior

---

### Issue 3: Hedge Modal Still Shows Input Amount Field

**Current State:**
- User reports input amount field still visible in hedge modal
- Should only show preset options (Light/Standard/Max)

**Root Cause:**
**File:** `frontend/src/components/HedgeModal.jsx`
- Previous fix removed custom input section, but there might be:
  1. Remaining references to `showCustom` or `premiumBudget` state
  2. Conditional rendering that still shows input
  3. State variables not fully removed

**Investigation Needed:**
- Check if `showCustom` or `premiumBudget` state still exists
- Check if there's conditional rendering showing input field
- Verify all references removed

**Solution:**
- Remove any remaining `showCustom` or `premiumBudget` state
- Remove any conditional rendering for custom input
- Ensure only preset options are shown

---

### Issue 4: Platform Functionality - Options and Strategies

**Question:** Is the platform functioning to show options and strategies?

**Current Implementation:**

**Backend Endpoints:**
1. `GET /events/btc/top-volume` - ✅ Working (returns events with choices)
2. `POST /hedge/quote` - ✅ Implemented (returns hedge options)

**Hedge Quote Flow:**
1. Frontend calls `/hedge/quote` with event data
2. Backend:
   - Parses event (event_parser.py)
   - Creates hedge request (adapter.py)
   - Fetches option chains (chain_service.py)
   - Selects strikes (strike_selector.py)
   - Builds spreads (spread_builder.py)
   - Calculates premiums (premium_calculator.py)
   - Optimizes venues (venue_optimizer.py)
   - Returns 3 tiers (Light/Standard/Max)

**Frontend Integration:**
- `HedgeModal.jsx` calls `/hedge/quote` endpoint
- Displays hedge options (Light/Standard/Max)
- User selects option and submits

**Potential Issues:**
1. **API Endpoint Mismatch:**
   - Frontend might be calling wrong endpoint
   - Check if frontend uses `/hedge/quote` or `/kalshi/hedge-quote`

2. **Response Format:**
   - Backend returns `HedgeQuoteResponse` with `hedges` array
   - Frontend expects specific format
   - Need to verify format matches

3. **Error Handling:**
   - If option chains unavailable, backend might return empty response
   - Frontend might not handle this gracefully

**Verification Needed:**
- Check frontend API calls in `HedgeModal.jsx`
- Verify response format matches frontend expectations
- Test hedge quote endpoint with real event data
- Check if option chains are being fetched correctly

---

## Implementation Plan

### Fix 1: Parse Date from Ticker for "When Will" Events

**File:** `api/main.py` (lines 261-277)

**Changes:**
1. Extract date from ticker format: `KXBTCMAX150-25-26FEB28-149999.99`
2. Parse date component: `26FEB28` → Feb 28, 2026
3. Use ticker date as primary, fallback to `settlement_date`

**Code:**
```python
# Extract date from ticker (format: KXBTCMAX150-25-26FEB28-149999.99)
choice_ticker = choice_event.get('ticker', '') or choice_event.get('event_ticker', '')
date_from_ticker = None

if choice_ticker:
    parts = choice_ticker.split('-')
    if len(parts) >= 3:
        date_part = parts[2]  # e.g., "26FEB28"
        # Parse YYMMMDD format
        try:
            import re
            match = re.match(r'(\d{2})([A-Z]{3})(\d{2})', date_part)
            if match:
                year_suffix = int(match.group(1))
                month_abbr = match.group(2)
                day = int(match.group(3))
                year = 2000 + year_suffix
                month_map = {'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
                            'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12}
                month = month_map.get(month_abbr.upper())
                if month:
                    from datetime import date
                    date_from_ticker = date(year, month, day)
        except:
            pass

# Use ticker date if available, otherwise use settlement_date
if date_from_ticker:
    choice_label = f"By {date_from_ticker.strftime('%b %d, %Y')}"
else:
    settlement_date_str = choice_event.get('expected_expiration_time', '') or choice_event.get('settlement_date', '')
    # ... existing fallback logic ...
```

---

### Fix 2: Limit "When Will" to Top 2 Choices

**File:** `services/kalshi/event_fetcher.py` (line 167)

**Change:**
```python
elif series == 'KXBTCMAX150':
    # For "when will" events, return top 2 date variants by volume
    top_dates = series_events[:2]  # Changed from [:3] to [:2]
    result_events.extend(top_dates)
```

**File:** `api/main.py` (line 263)

**Change:**
```python
elif series_ticker == 'KXBTCMAX150':
    # For "when will" events, create date choices from top 2 date variants
    top_date_events = sorted(series_events, key=lambda e: float(e.get('volume', 0) or 0), reverse=True)[:2]  # Changed from [:3] to [:2]
```

---

### Fix 3: Remove Remaining Input Field References

**File:** `frontend/src/components/HedgeModal.jsx`

**Steps:**
1. Search for all `showCustom` references - remove if found
2. Search for all `premiumBudget` references - remove if found
3. Check for conditional rendering (`{showCustom ? ... : ...}`)
4. Verify no input fields remain

**If found:**
- Remove state variables
- Remove conditional rendering
- Remove input field JSX

---

### Fix 4: Verify Platform Functionality

**Steps:**
1. Check frontend API endpoint calls
2. Test `/hedge/quote` endpoint with real event
3. Verify response format
4. Check option chain fetching
5. Test full hedge flow

**Files to Check:**
- `frontend/src/components/HedgeModal.jsx` - API calls
- `api/main.py` - `/hedge/quote` endpoint
- `services/option_chains/chain_service.py` - Option chain fetching
- `services/hedging/venue_optimizer.py` - Tier generation

---

## Summary

| Issue | Severity | Files Affected | Complexity |
|-------|----------|----------------|------------|
| 1. Same date for "when will" | High | `api/main.py` | Medium |
| 2. Top 2 choices for "when will" | Medium | `event_fetcher.py`, `api/main.py` | Low |
| 3. Input field still visible | High | `HedgeModal.jsx` | Low |
| 4. Platform functionality | Medium | Multiple files | Medium |

---

## Testing Plan

### After Fix 1 (Date Parsing):
- Verify "when will" events show different dates
- Verify dates match ticker format
- Test with multiple date variants

### After Fix 2 (Top 2 Choices):
- Verify only 2 choices shown for "when will"
- Verify choices are top 2 by volume

### After Fix 3 (Remove Input):
- Verify no input field in hedge modal
- Verify only preset options shown
- Test hedge flow end-to-end

### After Fix 4 (Platform Functionality):
- Test hedge quote endpoint
- Verify option chains fetched
- Verify tiers generated
- Test full hedge flow

---

**Ready for implementation once approved.**

