# Three Issues Analysis

## Issue 1: Performance (~20 seconds)

### Current Flow
1. **Frontend**: Fetches YES and NO options in parallel (2 API calls)
2. **Backend per request**:
   - Fetches option chains from **Deribit AND OKX** (2 exchanges)
   - Deribit: Processes contracts in batches (10 at a time, 0.5s delay between batches)
   - Each contract: 0.1s delay + fetch ticker + fetch orderbook
   - For ~200 contracts: ~20 seconds total
   - OKX: Similar process (might be faster but adds overhead)
   - Try up to 8 alternative strikes per venue
   - Process venues in parallel but still sequential within each venue

### Performance Bottlenecks
1. **Deribit batch delays**: 0.5s between batches of 10 contracts
   - For 200 contracts: 20 batches × 0.5s = 10 seconds just in delays
2. **Per-contract delays**: 0.1s per contract
   - For 200 contracts: 200 × 0.1s = 20 seconds (but parallelized, so less)
3. **OKX overhead**: Adds another exchange fetch (parallel but still adds time)
4. **Multiple strike attempts**: Up to 8 attempts per venue (sequential)

### Using Only Deribit Analysis
**Pros**:
- ✅ Eliminates OKX fetch overhead (~2-5 seconds saved)
- ✅ Deribit has good liquidity for BTC options
- ✅ Simpler code path
- ✅ Still provides institutional-grade options

**Cons**:
- ⚠️ Might miss better prices on OKX (but for demo, acceptable)
- ⚠️ Less venue diversity (but for demo, acceptable)

**Impact on Strategies**:
- ✅ Minimal - Deribit has good strike coverage
- ✅ Premium calculations would be similar
- ✅ Strike selection logic unchanged
- ✅ For demo purposes, Deribit-only is acceptable

**Recommendation**: **Use Deribit only for demo** - saves ~30-50% time with minimal strategy impact.

### Additional Optimizations
1. **Reduce batch delays**: 0.5s → 0.2s (saves ~6 seconds)
2. **Reduce per-contract delays**: 0.1s → 0.05s (saves ~10 seconds if sequential)
3. **Increase batch size**: 10 → 20 contracts (fewer batches)
4. **Cache option chains longer**: 60s → 120s (more cache hits)
5. **Pre-filter strikes**: Only fetch contracts near barrier (saves ~50% contracts)

**Combined**: Could reduce from ~20s to ~5-8s

---

## Issue 2: "Build Strategy" Button Analysis

### Current Flow
1. User selects YES/NO position
2. User selects hedge tier (Light/Standard/Max)
3. User clicks "Build Hedge Strategy"
4. Calls `/insurance` endpoint (line 384)
5. Returns strategy details
6. Shows strategy results screen
7. User clicks "Execute Hedge"
8. Simulates execution

### Problem Analysis
**Current**: "Build Hedge Strategy" button calls `/insurance` endpoint which seems to build a NEW strategy.

**But**: We already have the hedge strategy from `/kalshi/hedge-quote`:
- Premium: `selectedOption.premium_usd`
- Max payout: `selectedOption.max_payout_usd`
- Strikes: `selectedOption.strikes`
- Description: `selectedOption.description`

**The `/insurance` endpoint** (line 384):
- Takes: `event_ticker`, `direction`, `premium_budget`
- Returns: Strategy with legs, strikes, premium
- **This seems redundant** - we already have all this info!

### What Should Happen
1. User selects YES/NO position ✅
2. User selects hedge tier ✅
3. User clicks **"Execute Hedge"** (not "Build Strategy")
4. Strategy is already built (from selected option)
5. Execute directly (or show confirmation first)

### Recommendation
**Remove "Build Strategy" step**:
- Strategy is already built when user selects tier
- Change button to "Execute Hedge" or "Confirm Hedge"
- Use selected option data directly (no need to call `/insurance`)
- Show confirmation screen with selected option details
- Then execute

**Benefits**:
- ✅ Faster UX (no extra API call)
- ✅ Simpler flow
- ✅ Less confusing

---

## Issue 3: Cache Issue - Options Disappear When Switching Events

### Problem
1. Open "How High" → Shows options ✅
2. Open "Will Price" → Shows options ✅
3. Go back to "How High" → Shows 0 options ❌

### Root Cause
**Location**: `HedgeModal.jsx` line 22
```javascript
const [hedgeOptionsByPosition, setHedgeOptionsByPosition] = useState({ yes: null, no: null })
```

**Issue**: 
- `hedgeOptionsByPosition` is component-level state
- When modal closes and reopens for different event, component unmounts
- State resets to `{ yes: null, no: null }`
- Cache is lost

**Flow**:
1. Modal opens for "How High" (`eventTicker = "KXBTCMAXY-25"`)
   - Fetches and caches: `hedgeOptionsByPosition = { yes: [...], no: [...] }`
2. Modal closes → Component unmounts → State lost
3. Modal opens for "Will Price" (`eventTicker = "KXBTC2025100-25DEC31-100000"`)
   - Fetches and caches: `hedgeOptionsByPosition = { yes: [...], no: [...] }`
4. Modal closes → Component unmounts → State lost
5. Modal opens for "How High" again (`eventTicker = "KXBTCMAXY-25"`)
   - State reset: `hedgeOptionsByPosition = { yes: null, no: null }`
   - Fetches again BUT... might be hitting cache issue

### Additional Issue: Cache Key by eventTicker
The cache should be keyed by `eventTicker`, not just position:
- Current: `hedgeOptionsByPosition = { yes: [...], no: [...] }`
- Should be: `hedgeOptionsByEvent = { "KXBTCMAXY-25": { yes: [...], no: [...] }, ... }`

### Solution Options

**Option 1: Persist Cache Outside Component** (Recommended)
- Use module-level cache or React Context
- Key by `eventTicker`
- Persists across modal opens/closes

**Option 2: Check Cache Before Fetching**
- Before fetching, check if we already have cached options for this `eventTicker`
- Only fetch if cache miss

**Option 3: Use Session Storage**
- Store cache in `sessionStorage` keyed by `eventTicker`
- Restore on modal open

**Recommendation**: **Option 1** - Module-level cache, simplest and most reliable.

---

## Summary & Recommendations

### Issue 1: Performance
- ✅ **Use Deribit only** for demo (saves ~30-50% time)
- ✅ Reduce batch delays (0.5s → 0.2s)
- ✅ Increase batch size (10 → 20)
- ✅ Cache chains longer (60s → 120s)
- **Expected**: ~20s → ~5-8s

### Issue 2: Build Strategy Button
- ✅ **Remove "Build Strategy" step**
- ✅ Change to "Execute Hedge" or "Confirm Hedge"
- ✅ Use selected option data directly
- ✅ Show confirmation → Execute
- **Expected**: Faster, simpler UX

### Issue 3: Cache Issue
- ✅ **Persist cache by eventTicker** (module-level or Context)
- ✅ Check cache before fetching
- ✅ Restore cache on modal open
- **Expected**: Options persist when switching events

