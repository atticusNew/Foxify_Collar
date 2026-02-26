# Implementation Review Analysis

**Date:** January 2025  
**Status:** Analysis Only - No Changes

## Question 1: YES/NO on All Events and Choices

### Current Implementation

**✅ YES/NO Support:**
- ✅ Adapter handles YES/NO for all event types (BELOW, ABOVE, HIT)
- ✅ Strike selector handles YES/NO for all event types
- ✅ API endpoint accepts `direction: 'yes' or 'no'`
- ✅ Logic correctly maps event_type + direction → insurance_type

**❌ Choices NOT Handled:**
- ❌ Event fetcher returns only **ONE event per series** (top by volume)
- ❌ For "how high" events (KXBTCMAXY), there are multiple choices (e.g., $130k, $140k, $150k)
- ❌ For "how low" events (KXBTCMINY), there are multiple choices (e.g., $80k, $75k, $70k)
- ❌ Backend only processes the **top volume event**, not individual choices
- ❌ Frontend shows choices, but backend doesn't handle them separately

**Example:**
- KXBTCMAXY series has: $130k, $140k, $150k choices
- Current: Only returns top volume choice (e.g., $130k)
- Missing: Can't hedge $140k or $150k choices individually

**Impact:**
- ✅ YES/NO works for the **top event** per series
- ❌ YES/NO does **NOT work for individual choices** within "how" events
- ❌ User can't hedge specific price thresholds in "how" events

### Analysis

**What Works:**
- YES/NO on top 4 events (one per series)
- YES/NO on simple events (KXBTC2025100, KXBTCMAX150)

**What Doesn't Work:**
- YES/NO on individual choices within "how" events
- Backend doesn't receive or process choice-specific data
- Event fetcher doesn't return all choices, only top event

**Required Changes:**
1. Event fetcher should return **all choices** for "how" events, not just top event
2. API should accept `choice_id` or `choice_ticker` parameter
3. Event parser should extract threshold from choice, not just top event
4. Strike selector should use choice threshold, not series threshold

---

## Question 2: Finding Next Available Option When Ratio Not Met

### Current Implementation

**Current Behavior:**
- Strike selector finds **one set of strikes** (K₁, K₂) per event type/direction
- If premium > max_payout or ratio < 1.1 → **reject immediately**
- **No fallback logic** to try different strikes
- **No iterative search** for better strikes

**Example:**
- Event: BELOW $80k + YES
- Strikes found: K₁=$85k, K₂=$90k
- Premium: $18, Max Payout: $16 → Rejected
- **No attempt** to try: K₁=$90k, K₂=$95k or K₁=$100k, K₂=$105k

### Analysis

**Current Limitations:**
1. ❌ **Single strike attempt** - Only tries first valid strikes
2. ❌ **No fallback** - Rejects immediately if ratio not met
3. ❌ **No optimization** - Doesn't search for better strikes

**What Would Be Needed:**
1. **Try multiple strike pairs** when first attempt fails ratio check
2. **Search strategy:**
   - For CALL spreads above barrier: Try next higher strikes (K₁+ΔK, K₂+ΔK)
   - For PUT spreads below barrier: Try next lower strikes (K₁-ΔK, K₂-ΔK)
3. **Stop conditions:**
   - Found strikes with ratio ≥ 1.1
   - Exhausted available strikes
   - Strikes too far from barrier (e.g., >20% away)

**Feasibility:**
- ✅ **Possible** without over-engineering
- ✅ **Simple approach:** Try 2-3 alternative strike pairs
- ✅ **Realistic:** Most option chains have multiple strikes available
- ✅ **Value:** Would find better hedges instead of rejecting

**Implementation Complexity:**
- **Low-Medium:** Add fallback logic to strike selector
- **Simple approach:** Try next 2-3 strike pairs if first fails
- **Not over-engineered:** Just iterate through available strikes

**Example Logic:**
```python
# Try first strikes
strikes = find_strikes(...)
if strikes:
    candidate = build_and_calculate(...)
    if candidate and ratio >= 1.1:
        return candidate

# Try alternative strikes (next higher/lower)
for offset in [1, 2, 3]:  # Try next 3 strikes
    alt_strikes = find_strikes_with_offset(..., offset)
    if alt_strikes:
        candidate = build_and_calculate(...)
        if candidate and ratio >= 1.1:
            return candidate

# If still no good candidate, reject
return None
```

---

## Question 3: Light/Standard/Max Protection Tiers

### Current Implementation

**Current Behavior:**
- Venue optimizer creates labels: "Light protection", "Standard protection", "Max protection"
- **BUT:** These are just **rankings of different venues**, not different protection levels
- **NOT:** Different notional sizes or premium tiers
- **NOT:** Scaled protection levels

**Code Analysis:**
```python
# venue_optimizer.py lines 73-81
if len(best_candidates) == 1:
    label = "Standard protection"
elif idx == 0:
    label = "Light protection"  # Best score (lowest premium/max_payout)
elif idx == 1:
    label = "Standard protection"  # Second best
else:
    label = "Max protection"  # Third best
```

**What This Actually Does:**
- Light = Best venue (lowest cost-per-payout ratio)
- Standard = Second best venue OR single candidate
- Max = Third best venue

**Problems:**
1. ❌ **Not protection tiers** - Just different venues
2. ❌ **No scaling** - All have same notional (scaled to user budget)
3. ❌ **No meaningful progression** - Light might have HIGHER premium than Standard if venues differ
4. ❌ **Doesn't make sense** - "Light protection" with $20 premium vs "Max protection" with $15 premium (if different venues)

### Analysis

**What's Missing:**
1. ❌ **No tier scaling** - All candidates use same notional (scaled to budget)
2. ❌ **No premium tiers** - Light/Standard/Max should have different premium amounts
3. ❌ **No protection progression** - Should be: Light < Standard < Max (in both cost and protection)

**What Should Happen:**
1. **Single candidate:** Scale to create 3 tiers:
   - Light: 50% of budget → Lower premium, lower protection
   - Standard: 100% of budget → Medium premium, medium protection
   - Max: 150% of budget (capped at max_payout) → Higher premium, higher protection

2. **Multiple venues:** Create tiers per venue OR combine:
   - Option A: 3 tiers per venue (Light/Standard/Max for each)
   - Option B: Best Light from all venues, Best Standard, Best Max

**Example of What Should Be:**
```json
{
  "hedges": [
    {
      "label": "Light protection",
      "premium_usd": 10.00,
      "max_payout_usd": 12.00,
      "description": "Basic protection at lower cost"
    },
    {
      "label": "Standard protection",
      "premium_usd": 20.00,
      "max_payout_usd": 24.00,
      "description": "Balanced protection"
    },
    {
      "label": "Max protection",
      "premium_usd": 30.00,
      "max_payout_usd": 36.00,
      "description": "Maximum protection"
    }
  ]
}
```

**Current Reality:**
```json
{
  "hedges": [
    {
      "label": "Light protection",  // Actually: Best venue
      "premium_usd": 20.00,
      "max_payout_usd": 23.78
    },
    {
      "label": "Standard protection",  // Actually: Second best venue
      "premium_usd": 18.00,  // Could be LOWER than Light!
      "max_payout_usd": 20.00
    }
  ]
}
```

**Feasibility:**
- ✅ **Possible** without over-engineering
- ✅ **Simple approach:** Scale single candidate to 3 tiers (50%, 100%, 150% of budget)
- ✅ **Realistic:** Provides meaningful choice progression
- ✅ **Value:** Trader can choose protection level based on budget

**Implementation Complexity:**
- **Low:** Modify premium calculator to accept tier multiplier
- **Simple:** Create 3 candidates from 1 base candidate with different notional scales
- **Not over-engineered:** Just scale notional by tier factor

---

## Summary

### Question 1: YES/NO on All Events and Choices

**Status:** ⚠️ **PARTIAL**
- ✅ YES/NO works on top events
- ❌ YES/NO does NOT work on individual choices within "how" events
- ❌ Backend doesn't process choices separately

**Required:** Event fetcher should return all choices, API should accept choice_id

### Question 2: Finding Next Available Option When Ratio Not Met

**Status:** ❌ **NOT IMPLEMENTED**
- ❌ Only tries one set of strikes
- ❌ Rejects immediately if ratio not met
- ❌ No fallback to alternative strikes

**Required:** Add fallback logic to try 2-3 alternative strike pairs

**Feasibility:** ✅ **YES** - Simple, not over-engineered

### Question 3: Light/Standard/Max Protection Tiers

**Status:** ❌ **NOT IMPLEMENTED CORRECTLY**
- ❌ Current labels are just venue rankings, not protection tiers
- ❌ No scaling to create meaningful tiers
- ❌ No progression in cost/protection

**Required:** Scale single candidate to create 3 tiers (50%, 100%, 150% of budget)

**Feasibility:** ✅ **YES** - Simple, provides real value

---

## Recommendations

1. **Question 1:** Add choice handling to event fetcher and API
2. **Question 2:** Add fallback strike selection (try 2-3 alternatives)
3. **Question 3:** Implement proper tier scaling (Light/Standard/Max from single candidate)

All three are feasible without over-engineering.

