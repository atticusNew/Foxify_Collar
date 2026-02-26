# Markup vs Max Payout Ratio Analysis

**Date:** January 2025  
**Status:** Analysis - Critical Issue Identified

## Problem Statement

**User's Concern:**
- If we apply markup to bring premium to $5, but max_payout is less than $5, then:
  - Charged premium ($5) > Max payout ($2) ❌
  - This violates economic principle: can't charge more than max payout

**User's Requirement:**
- Still need 1.1 ratio check
- But ratio should be on **CHARGED premium** (after markup), not raw premium
- If charged_premium > max_payout OR ratio fails, reject hedge

---

## Current Understanding (INCORRECT)

### What I Proposed Before:
1. Calculate raw premium
2. Check MIN_VALUE_RATIO on raw premium (before markup)
3. Apply markup if raw premium < $5
4. Return charged premium

**Problem:**
- Raw premium $1, max payout $2 → ratio 2.0 ✅ (passes)
- After markup: Charged $5, max payout $2 → ratio 0.4 ❌
- **We'd charge $5 for $2 max payout - economically nonsensical!**

---

## Correct Understanding

### User's Requirement:
1. Calculate raw premium
2. Apply markup if raw premium < $5 → get charged_premium
3. Check MIN_VALUE_RATIO on **CHARGED premium**: `max_payout / charged_premium >= 1.1`
4. Also check: `charged_premium <= max_payout` (can't charge more than payout)
5. If either check fails, reject hedge

**Logic:**
```python
# Step 1: Calculate raw premium
raw_premium = calculate_raw_premium(...)

# Step 2: Apply markup
if raw_premium < 5:
    charged_premium = 5
    markup = 5 - raw_premium
else:
    charged_premium = raw_premium
    markup = 0

# Step 3: Check economic validity
if charged_premium > max_payout:
    return None  # Reject - can't charge more than payout

# Step 4: Check MIN_VALUE_RATIO on CHARGED premium
if max_payout / charged_premium < 1.1:
    return None  # Reject - ratio too low
```

---

## Examples

### Example 1: Small Hedge (Should Reject)

**Input:**
- Raw premium: $1
- Max payout: $2

**Step 1: Apply Markup**
- Raw premium ($1) < $5 → Charged premium = $5
- Markup = $4

**Step 2: Check Economic Validity**
- Charged premium ($5) > Max payout ($2) ❌
- **REJECT** - Can't charge more than payout

**Result:** ❌ Rejected (correctly)

---

### Example 2: Small Hedge (Should Accept)

**Input:**
- Raw premium: $1
- Max payout: $6

**Step 1: Apply Markup**
- Raw premium ($1) < $5 → Charged premium = $5
- Markup = $4

**Step 2: Check Economic Validity**
- Charged premium ($5) <= Max payout ($6) ✅

**Step 3: Check MIN_VALUE_RATIO**
- Ratio = $6 / $5 = 1.2 >= 1.1 ✅
- **ACCEPT**

**Result:** ✅ Accepted

---

### Example 3: Medium Hedge (Should Accept)

**Input:**
- Raw premium: $4
- Max payout: $5.5

**Step 1: Apply Markup**
- Raw premium ($4) < $5 → Charged premium = $5
- Markup = $1

**Step 2: Check Economic Validity**
- Charged premium ($5) <= Max payout ($5.5) ✅

**Step 3: Check MIN_VALUE_RATIO**
- Ratio = $5.5 / $5 = 1.1 >= 1.1 ✅
- **ACCEPT**

**Result:** ✅ Accepted

---

### Example 4: Large Hedge (Should Accept)

**Input:**
- Raw premium: $8
- Max payout: $10

**Step 1: Apply Markup**
- Raw premium ($8) >= $5 → Charged premium = $8
- Markup = $0

**Step 2: Check Economic Validity**
- Charged premium ($8) <= Max payout ($10) ✅

**Step 3: Check MIN_VALUE_RATIO**
- Ratio = $10 / $8 = 1.25 >= 1.1 ✅
- **ACCEPT**

**Result:** ✅ Accepted

---

### Example 5: Edge Case - Ratio Exactly 1.1

**Input:**
- Raw premium: $4.55
- Max payout: $5

**Step 1: Apply Markup**
- Raw premium ($4.55) < $5 → Charged premium = $5
- Markup = $0.45

**Step 2: Check Economic Validity**
- Charged premium ($5) <= Max payout ($5) ✅

**Step 3: Check MIN_VALUE_RATIO**
- Ratio = $5 / $5 = 1.0 < 1.1 ❌
- **REJECT** - Ratio too low

**Result:** ❌ Rejected (correctly - ratio fails)

---

### Example 6: Edge Case - Max Payout Exactly $5

**Input:**
- Raw premium: $1
- Max payout: $5

**Step 1: Apply Markup**
- Raw premium ($1) < $5 → Charged premium = $5
- Markup = $4

**Step 2: Check Economic Validity**
- Charged premium ($5) <= Max payout ($5) ✅

**Step 3: Check MIN_VALUE_RATIO**
- Ratio = $5 / $5 = 1.0 < 1.1 ❌
- **REJECT** - Ratio too low

**Result:** ❌ Rejected (correctly - ratio fails)

---

## Key Insights

### Insight 1: Markup Can Break Ratio

**Problem:**
- Raw premium might have good ratio
- But after markup, ratio might fail
- Need to check ratio AFTER markup

**Solution:**
- Check MIN_VALUE_RATIO on charged_premium (after markup)
- Not on raw_premium (before markup)

---

### Insight 2: Minimum Max Payout for $5 Charge

**Question:** What's the minimum max_payout needed to charge $5?

**Answer:**
- Charged premium = $5
- Ratio requirement: max_payout / $5 >= 1.1
- Therefore: max_payout >= $5 * 1.1 = $5.50

**Conclusion:**
- Can only charge $5 if max_payout >= $5.50
- If max_payout < $5.50, must reject (ratio fails)

---

### Insight 3: Markup Makes Small Hedges Harder

**Impact:**
- Small hedges (low max_payout) become harder to offer
- Need max_payout >= $5.50 to charge $5
- This is correct - protects users from poor value hedges

**Example:**
- Max payout $2 → Can't charge $5 (would violate ratio)
- Max payout $5.50 → Can charge $5 (ratio = 1.1)
- Max payout $10 → Can charge $5 (ratio = 2.0)

---

## Implementation Plan

### Step 1: Update PremiumCalculator

**File:** `services/hedging/premium_calculator.py`

**Changes:**
1. Remove MIN_PREMIUM_USD check (line 119-125)
2. Keep MIN_VALUE_RATIO check BUT note it will be checked later (after markup)
3. Return raw premium (no markup applied here)

**Code:**
```python
# REMOVE THIS:
# if premium_final < self.MIN_PREMIUM_USD:
#     return None

# Keep MIN_VALUE_RATIO check BUT note: will be checked after markup
# Actually, we might want to do a PRELIMINARY check here on raw premium
# to avoid unnecessary markup calculation
# But final check must be on charged premium
```

**Decision:** Do preliminary check on raw premium (early rejection), but final check is on charged premium

---

### Step 2: Update VenueOptimizer

**File:** `services/hedging/venue_optimizer.py`

**Changes:**
1. Add `MIN_CHARGED_PREMIUM_USD = Decimal('5')`
2. Add `MIN_VALUE_RATIO = Decimal('1.1')`
3. Add `_apply_markup()` method
4. Add `_check_economic_validity()` method
5. Apply markup and check ratio for base candidate
6. Apply markup and check ratio for each tier

**New Methods:**
```python
def _apply_markup(self, raw_premium: Decimal) -> Tuple[Decimal, Decimal]:
    """
    Apply markup to ensure minimum charge.
    
    Returns:
        Tuple of (charged_premium, markup_amount)
    """
    if raw_premium < self.MIN_CHARGED_PREMIUM_USD:
        markup = self.MIN_CHARGED_PREMIUM_USD - raw_premium
        charged_premium = self.MIN_CHARGED_PREMIUM_USD
    else:
        markup = Decimal('0')
        charged_premium = raw_premium
    
    return charged_premium, markup

def _check_economic_validity(
    self,
    charged_premium: Decimal,
    max_payout: Decimal
) -> bool:
    """
    Check if hedge is economically valid.
    
    Requirements:
    1. charged_premium <= max_payout (can't charge more than payout)
    2. max_payout / charged_premium >= 1.1 (minimum value ratio)
    
    Returns:
        True if valid, False otherwise
    """
    # Check 1: Can't charge more than payout
    if charged_premium > max_payout:
        logger.debug(
            "Rejecting: charged premium exceeds max payout",
            charged_premium=charged_premium,
            max_payout=max_payout
        )
        return False
    
    # Check 2: Minimum value ratio
    if max_payout <= 0 or charged_premium <= 0:
        return False
    
    ratio = max_payout / charged_premium
    if ratio < self.MIN_VALUE_RATIO:
        logger.debug(
            "Rejecting: ratio too low",
            charged_premium=charged_premium,
            max_payout=max_payout,
            ratio=ratio,
            min_ratio=self.MIN_VALUE_RATIO
        )
        return False
    
    return True
```

**Update `optimize()` method:**
```python
# For base candidate:
raw_premium = base_candidate['premium_usd']
max_payout = base_candidate['max_payout_usd']

# Apply markup
charged_premium, markup = self._apply_markup(raw_premium)

# Check economic validity
if not self._check_economic_validity(charged_premium, max_payout):
    # Base candidate fails - try next candidate or return empty
    return []

# For each tier:
for label, multiplier in tier_multipliers:
    # Calculate tier premium and max_payout
    tier_raw_premium = tier_notional * premium_per_btc
    tier_max_payout = tier_notional * spread_width
    
    # Apply markup
    tier_charged_premium, tier_markup = self._apply_markup(tier_raw_premium)
    
    # Check economic validity
    if not self._check_economic_validity(tier_charged_premium, tier_max_payout):
        continue  # Skip this tier
    
    # Add to results
    results.append({
        'label': label,
        'venue': venue,
        'raw_premium_usd': tier_raw_premium,
        'charged_premium_usd': tier_charged_premium,
        'markup_usd': tier_markup,
        'max_payout_usd': tier_max_payout,
        # ... other fields
    })
```

---

### Step 3: Update PremiumCalculator (Optional Preliminary Check)

**File:** `services/hedging/premium_calculator.py`

**Option:** Add preliminary check on raw premium to avoid unnecessary markup calculation

**Logic:**
- If raw premium < $5, we'll charge $5
- For this to be valid, max_payout must be >= $5.50 (to meet 1.1 ratio)
- So: if raw_premium < $5 AND max_payout < $5.50, reject early

**Code:**
```python
# Preliminary check: If raw premium < $5, need max_payout >= $5.50
MIN_CHARGED_PREMIUM_USD = Decimal('5')
MIN_MAX_PAYOUT_FOR_MIN_CHARGE = Decimal('5.50')  # $5 * 1.1

if premium_final < MIN_CHARGED_PREMIUM_USD:
    # Will charge $5, so need max_payout >= $5.50
    if max_payout_final < MIN_MAX_PAYOUT_FOR_MIN_CHARGE:
        logger.debug(
            "Rejecting: raw premium below minimum and max_payout too low",
            premium_final=premium_final,
            max_payout_final=max_payout_final
        )
        return None
```

**Decision:** Add this preliminary check for efficiency (early rejection)

---

### Step 4: Update API Response Format

**File:** `api/main.py`

**Include both raw and charged premium:**
```python
{
    'raw_premium_usd': float(raw_premium),
    'charged_premium_usd': float(charged_premium),
    'markup_usd': float(markup),
    'max_payout_usd': float(max_payout),
    # ... other fields
}
```

**Frontend uses:** `charged_premium_usd` for display

---

## Summary of Changes

### 1. PremiumCalculator
- ✅ Remove MIN_PREMIUM_USD check
- ✅ Add preliminary check: if raw_premium < $5, need max_payout >= $5.50
- ✅ Keep MIN_VALUE_RATIO check (but final check is in VenueOptimizer)

### 2. VenueOptimizer
- ✅ Add MIN_CHARGED_PREMIUM_USD = $5
- ✅ Add MIN_VALUE_RATIO = 1.1
- ✅ Add `_apply_markup()` method
- ✅ Add `_check_economic_validity()` method
- ✅ Apply markup and check ratio for base candidate
- ✅ Apply markup and check ratio for each tier
- ✅ Store both raw_premium and charged_premium in results

### 3. API Response
- ✅ Include raw_premium_usd, charged_premium_usd, markup_usd
- ✅ Frontend uses charged_premium_usd

---

## Edge Cases Handled

1. ✅ Raw premium $1, max payout $2 → Reject (charged $5 > payout $2)
2. ✅ Raw premium $1, max payout $6 → Accept (charged $5, ratio 1.2)
3. ✅ Raw premium $4, max payout $5.5 → Accept (charged $5, ratio 1.1)
4. ✅ Raw premium $8, max payout $10 → Accept (charged $8, ratio 1.25)
5. ✅ Raw premium $4.55, max payout $5 → Reject (charged $5, ratio 1.0)
6. ✅ Raw premium $1, max payout $5 → Reject (charged $5, ratio 1.0)

---

## Key Takeaways

1. **Markup must be applied BEFORE ratio check**
2. **Ratio check must be on CHARGED premium (after markup)**
3. **Must also check: charged_premium <= max_payout**
4. **Minimum max_payout for $5 charge is $5.50** (to meet 1.1 ratio)
5. **Small hedges become harder to offer** (correct - protects users)

---

**Ready for implementation once approved.**

