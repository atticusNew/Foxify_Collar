# Hardcoded/Fake/Mock Data Review

**Date:** January 2025  
**Status:** Review Complete

## Summary

After comprehensive review of the codebase, here are all instances of hardcoded, fake, mock, or cosmetic data:

---

## ✅ APPROVED Hardcoded Values (Configuration/Defaults)

### 1. **Default YES/NO Prices (0.5 = 50%)**
**Location:** `services/kalshi/event_fetcher.py`, `api/main.py`  
**Status:** ✅ **APPROVED** - Fallback defaults  
**Reason:** Used only as fallback when Kalshi API fails to return prices. Real prices are fetched from API.

**Code:**
```python
event['yes_price'] = 0.5  # Fallback default
event['no_price'] = 0.5   # Fallback default
```

**Action:** ✅ Keep - These are safety fallbacks, not fake data.

---

### 2. **Tier Multipliers (0.5, 1.0, 1.5)**
**Location:** `services/hedging/venue_optimizer.py`  
**Status:** ✅ **APPROVED** - Business logic constants  
**Reason:** These define protection tiers (Light/Standard/Max) and are intentional business logic.

**Code:**
```python
TIER_MULTIPLIERS = {
    "Light protection": Decimal('0.5'),
    "Standard protection": Decimal('1.0'),
    "Max protection": Decimal('1.5'),
}
```

**Action:** ✅ Keep - These are intentional business rules.

---

### 3. **Minimum Premium and Value Ratio**
**Location:** `services/hedging/premium_calculator.py`  
**Status:** ✅ **APPROVED** - Business rules  
**Reason:** These are minimum thresholds for offering hedges.

**Code:**
```python
MIN_PREMIUM_USD = Decimal('10')  # Minimum premium to offer hedge
MIN_VALUE_RATIO = Decimal('1.1')  # Max payout must be at least 10% more than premium
```

**Action:** ✅ Keep - These are business rules, not fake data.

---

### 4. **API Rate Limiting Delays**
**Location:** `services/kalshi/event_fetcher.py`  
**Status:** ✅ **APPROVED** - Performance optimization  
**Reason:** Small delays to avoid rate limiting.

**Code:**
```python
await asyncio.sleep(0.5)  # 500ms delay between requests
await asyncio.sleep(0.2)  # 200ms delay between batches
```

**Action:** ✅ Keep - These are performance optimizations.

---

### 5. **Batch Size for Parallel Processing**
**Location:** `services/kalshi/event_fetcher.py`  
**Status:** ✅ **APPROVED** - Performance optimization  
**Reason:** Limits parallel API calls to avoid overwhelming the API.

**Code:**
```python
batch_size = 10  # Process 10 events at a time
```

**Action:** ✅ Keep - Performance optimization.

---

## ❌ REMOVED Hardcoded Values (Fake/Cosmetic Data)

### 1. **Hardcoded Event Scores**
**Location:** `frontend/src/components/EventList.jsx` (line 44-50)  
**Status:** ❌ **REMOVED** - Fake cosmetic data  
**Reason:** These scores were hardcoded and not calculated from real data.

**Previous Code:**
```javascript
score: 0.8,  // High score for volume-based events
score_breakdown: {
  volume: 0.9,
  liquidity: 0.8,
  relevance: 0.8,
  timeline: 0.7
},
recommended: true,
```

**Action:** ✅ **REMOVED** - These fields have been removed from the code.

---

### 2. **Custom Amount Input in Hedge Modal**
**Location:** `frontend/src/components/HedgeModal.jsx`  
**Status:** ❌ **REMOVED** - Unnecessary complexity  
**Reason:** User requested removal of custom input field.

**Previous Code:**
```javascript
const [premiumBudget, setPremiumBudget] = useState('')
const [showCustom, setShowCustom] = useState(false)
// ... custom input UI ...
```

**Action:** ✅ **REMOVED** - All custom input logic has been removed. Users now only select from preset options.

---

## ✅ Real Data Sources (No Hardcoded Values)

### 1. **Event Data**
- ✅ Fetched from Kalshi API (`connector.fetch_markets()`)
- ✅ YES/NO prices fetched from Kalshi API (`connector.fetch_ticker()`)
- ✅ Volume, settlement dates, tickers all from API

### 2. **Option Chain Data**
- ✅ Fetched from Deribit API (`deribit_connector.fetch_orderbook()`)
- ✅ Fetched from OKX API (`okx_connector.fetch_orderbook()`)
- ✅ Strikes, bids, asks all from real exchange data

### 3. **Hedge Calculations**
- ✅ Premium calculated from real option prices
- ✅ Max payout calculated from real spread widths
- ✅ Notional scaled based on real premium/payout ratios

### 4. **Frontend Display**
- ✅ All event data from API
- ✅ All hedge options from backend calculations
- ✅ No mock or fake data displayed

---

## Summary Table

| Location | Type | Status | Action |
|----------|------|--------|--------|
| Default YES/NO prices (0.5) | Fallback | ✅ Approved | Keep |
| Tier multipliers (0.5, 1.0, 1.5) | Business logic | ✅ Approved | Keep |
| Min premium ($10) | Business rule | ✅ Approved | Keep |
| Min value ratio (1.1) | Business rule | ✅ Approved | Keep |
| API delays (0.5s, 0.2s) | Performance | ✅ Approved | Keep |
| Batch size (10) | Performance | ✅ Approved | Keep |
| Event scores (0.8, etc.) | Fake data | ❌ Removed | ✅ Removed |
| Recommended flag (true) | Fake data | ❌ Removed | ✅ Removed |
| Custom amount input | Unnecessary | ❌ Removed | ✅ Removed |

---

## Conclusion

**All fake/mock/cosmetic data has been removed.**

**Remaining hardcoded values are:**
1. ✅ **Fallback defaults** (for error handling)
2. ✅ **Business rules** (tier multipliers, minimums)
3. ✅ **Performance optimizations** (delays, batch sizes)

**No unauthorized hardcoded data remains in the codebase.**

