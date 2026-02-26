# Issues Analysis and Plan

**Date:** January 2025  
**Status:** Analysis Only - No Changes Yet

## Issues Identified

### Issue 1: "How High" and "How Low" Show Too Many Choices

**Current State:**
- `event_fetcher.py` line 126: Returns top **4 choices** for "how" events
- `api/main.py` line 226: Uses **all events** in series as choices
- Result: Shows 4 choices per "how" event

**Required:**
- Show only **top 2 choices** by volume for "how high" and "how low" events

**Root Cause:**
- `event_fetcher.py` line 126: `top_choices = series_events[:4]` should be `[:2]`
- `api/main.py` line 226: Loop through all `series_events` should limit to top 2

**Files to Fix:**
1. `services/kalshi/event_fetcher.py` - Change `[:4]` to `[:2]` for "how" events
2. `api/main.py` - Limit choices to top 2 by volume

---

### Issue 2: "When Will" Events Missing Date Choices

**Current State:**
- `api/main.py` line 224-259: Only creates choices for `KXBTCMAXY` and `KXBTCMINY`
- `KXBTCMAX150` (when will hit $150k) has no choices logic
- Result: "When will" events show empty choices array

**Required:**
- "When will" events should have **date choices** (e.g., "By Dec 31", "By Jan 15", etc.)
- Each choice should represent a different settlement date

**Root Cause:**
- No logic to fetch multiple date variants for "when will" events
- Event fetcher only returns one event per series for non-"how" events
- Need to fetch multiple markets with different dates for same target price

**Files to Fix:**
1. `services/kalshi/event_fetcher.py` - Fetch multiple date variants for "when will" events
2. `api/main.py` - Create date choices for `KXBTCMAX150` series

**Example:**
- KXBTCMAX150 series might have:
  - "By Dec 31, 2025"
  - "By Jan 15, 2026"
  - "By Feb 28, 2026"
- Each should be a choice with different settlement dates

---

### Issue 3: All Events Show 50/50% (Hardcoded Prices)

**Current State:**
- `api/main.py` line 219-220: `yes_price = base_event.get('yes_price', 0.5)` (defaults to 0.5)
- `api/main.py` line 237-238: `choice_yes = choice_event.get('yes_price', 0.5)` (defaults to 0.5)
- Result: All events show 50.0% / 50.0% because `yes_price` and `no_price` are not in event data

**Root Cause:**
- Event fetcher (`event_fetcher.py`) doesn't fetch market ticker data
- `fetch_markets()` returns basic event info but not YES/NO prices
- Need to call `fetch_ticker()` for each market to get real prices

**Required:**
- Fetch real YES/NO prices from Kalshi API for each event/choice
- Use `kalshi_connector.fetch_ticker(market_id)` to get `yes_price` and `no_price`
- Update event data with real prices before formatting response

**Files to Fix:**
1. `services/kalshi/event_fetcher.py` - Fetch ticker data for each event
2. `api/main.py` - Use real prices from event data instead of defaults

**Implementation:**
```python
# For each event, fetch ticker to get YES/NO prices
ticker_data = await connector.fetch_ticker(market_id)
event['yes_price'] = ticker_data.get('yes_price', 0.5)
event['no_price'] = ticker_data.get('no_price', 0.5)
```

---

### Issue 4: Hedge Modal Shows Amount Input (Should Be Removed or Optional)

**Current State:**
- `HedgeModal.jsx` line 9: `const [premiumBudget, setPremiumBudget] = useState('')`
- `HedgeModal.jsx` line 714-803: Shows "Custom Amount" input field
- `HedgeModal.jsx` line 848: Submit button requires `premiumBudget` if `showCustom` is true
- Result: User sees amount input field that may not be needed

**Required:**
- Remove amount input OR make it optional with "Custom Input" toggle
- If too complicated, remove it entirely
- User should select from hedge options (Light/Standard/Max) without custom input

**Root Cause:**
- Modal has both preset options AND custom input
- Custom input adds complexity and may not function perfectly
- User preference: Remove if it doesn't work perfectly

**Files to Fix:**
1. `frontend/src/components/HedgeModal.jsx` - Remove custom input section OR add toggle

**Options:**
- **Option A (Simple):** Remove custom input entirely - only show preset options
- **Option B (Advanced):** Add "Custom Input" toggle that shows/hides input field

**Recommendation:** Option A (Remove) - Simpler, cleaner UX

---

## Summary of Issues

| Issue | Severity | Files Affected | Complexity |
|-------|----------|----------------|------------|
| 1. Too many choices (4 instead of 2) | Medium | `event_fetcher.py`, `api/main.py` | Low |
| 2. Missing date choices for "when will" | High | `event_fetcher.py`, `api/main.py` | Medium |
| 3. Hardcoded 50/50% prices | High | `event_fetcher.py`, `api/main.py` | Medium |
| 4. Amount input in hedge modal | Low | `HedgeModal.jsx` | Low |

---

## Implementation Plan

### Phase 1: Fix Choice Counts (Issue 1)
1. Update `event_fetcher.py` to return top 2 choices for "how" events
2. Update `api/main.py` to limit choices to top 2 by volume
3. Test: Verify only 2 choices show for "how high" and "how low"

### Phase 2: Add Date Choices for "When Will" (Issue 2)
1. Update `event_fetcher.py` to fetch multiple date variants for `KXBTCMAX150`
2. Update `api/main.py` to create date choices for "when will" events
3. Format choices as dates (e.g., "By Dec 31, 2025")
4. Test: Verify "when will" events show date choices

### Phase 3: Fetch Real YES/NO Prices (Issue 3)
1. Update `event_fetcher.py` to fetch ticker data for each event
2. Store `yes_price` and `no_price` in event data
3. Update `api/main.py` to use real prices instead of defaults
4. Test: Verify events show real YES/NO percentages

### Phase 4: Remove/Simplify Amount Input (Issue 4)
1. Remove custom amount input section from `HedgeModal.jsx`
2. Remove `premiumBudget` state and related logic
3. Update submit handler to only use selected option
4. Test: Verify hedge modal works with only preset options

---

## Detailed Fix Plan

### Fix 1: Limit "How" Event Choices to Top 2

**File: `services/kalshi/event_fetcher.py`**
- Line 126: Change `top_choices = series_events[:4]` to `top_choices = series_events[:2]`

**File: `api/main.py`**
- Line 226: Change loop to `for choice_event in series_events[:2]:`

---

### Fix 2: Add Date Choices for "When Will" Events

**File: `services/kalshi/event_fetcher.py`**
- Add logic to fetch multiple markets for `KXBTCMAX150` with different dates
- Group by target price ($150k) but different settlement dates
- Return top 2-3 date variants

**File: `api/main.py`**
- Add logic to create date choices for `KXBTCMAX150` series
- Format dates as "By [Date]" labels
- Extract settlement date from ticker or event data

---

### Fix 3: Fetch Real YES/NO Prices

**File: `services/kalshi/event_fetcher.py`**
- After fetching events, loop through each event
- Call `connector.fetch_ticker(market_id)` for each event
- Store `yes_price` and `no_price` in event dict

**File: `api/main.py`**
- Use `event.get('yes_price')` and `event.get('no_price')` instead of defaults
- If prices not available, fallback to 0.5 (50%)

**Performance Consideration:**
- Fetch tickers in parallel using `asyncio.gather()`
- Cache ticker data if needed

---

### Fix 4: Remove Amount Input from Hedge Modal

**File: `frontend/src/components/HedgeModal.jsx`**
- Remove lines 9, 18 (premiumBudget state, showCustom state)
- Remove lines 714-803 (Custom Amount input section)
- Update line 848: Remove `(showCustom && !premiumBudget)` condition
- Update submit handler: Remove custom amount logic
- Simplify to only use `selectedOption.premium_usd`

---

## Testing Plan

1. **Test Choice Counts:**
   - Verify "how high" shows only 2 choices
   - Verify "how low" shows only 2 choices

2. **Test Date Choices:**
   - Verify "when will" events show date choices
   - Verify dates are formatted correctly

3. **Test Real Prices:**
   - Verify events show real YES/NO percentages (not 50/50)
   - Verify prices update when market changes

4. **Test Hedge Modal:**
   - Verify no amount input field
   - Verify can select preset options only
   - Verify hedge quote works correctly

---

## Risk Assessment

**Low Risk:**
- Fix 1 (choice counts) - Simple change
- Fix 4 (remove input) - Simple removal

**Medium Risk:**
- Fix 2 (date choices) - Need to understand Kalshi date format
- Fix 3 (real prices) - API calls may be slow, need error handling

**Mitigation:**
- Add error handling for ticker fetches
- Add fallback to defaults if prices unavailable
- Test with real Kalshi API responses

---

**Ready for implementation once approved.**

