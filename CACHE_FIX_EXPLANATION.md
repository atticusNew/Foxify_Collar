# Cache Fix Explanation

## What Happened?

### The Problem
1. **First fetch fails** (network error, backend down, timeout, etc.)
2. **Empty results cached**: `{ yes: [], no: [] }` stored in cache
3. **Next modal open**: Cache check finds cached data (even though it's empty)
4. **Immediate "no options"**: Sets `previewCounts = { yes: 0, no: 0 }` without fetching
5. **User sees "Hedge unavailable"** even though options might be available now

### Why Hard Refresh Fixed It
- Hard refresh cleared the browser's in-memory cache
- Next fetch succeeded and cached valid results
- Now it works correctly

## Does It Need Fixing?

**YES** - This is a critical UX issue:
- Users will see "no options" even when options are available
- They'll need to hard refresh to fix it (not user-friendly)
- Failed fetches shouldn't prevent future attempts

## The Fix

### Fix 1: Don't Cache Empty Results
**Before**:
```jsx
catch (err) {
  setPreviewCounts({ yes: 0, no: 0 })
  const emptyOptions = { yes: [], no: [] }
  setCachedOptions(eventTicker, emptyOptions)  // ← Problem!
}
```

**After**:
```jsx
catch (err) {
  setPreviewCounts({ yes: 0, no: 0 })
  const emptyOptions = { yes: [], no: [] }
  setHedgeOptionsByPosition(emptyOptions)
  // DON'T cache empty results - let it try again next time
}
```

**Why**: Prevents failed fetches from blocking future attempts.

### Fix 2: Validate Cache Before Using
**Before**:
```jsx
const cached = getCachedOptions(eventTicker)
if (cached) {
  // Uses cache even if it's empty arrays
  setPreviewCounts({
    yes: cached.yes?.length || 0,
    no: cached.no?.length || 0
  })
}
```

**After**:
```jsx
const cached = getCachedOptions(eventTicker)
if (cached && (cached.yes?.length > 0 || cached.no?.length > 0)) {
  // Only use cache if it has at least one option
  setPreviewCounts({
    yes: cached.yes?.length || 0,
    no: cached.no?.length || 0
  })
} else {
  // Cache is empty or doesn't exist - fetch fresh
  fetchPreviewCountsAndOptions()
}
```

**Why**: Ensures we only use cache when it has valid data.

## Benefits

1. **Better UX**: Users won't see "no options" from stale cache
2. **Auto-recovery**: Failed fetches don't block future attempts
3. **Fresh data**: Always tries to fetch if cache is empty
4. **Performance**: Still uses cache when valid data exists

## Edge Cases Handled

1. **Network error**: Doesn't cache empty, tries again next time
2. **Backend down**: Doesn't cache empty, tries again when backend is up
3. **Timeout**: Doesn't cache empty, tries again next time
4. **Valid cache**: Still uses cache for performance (if it has options)
5. **Empty cache**: Fetches fresh data instead of showing "no options"

## Testing

After fix:
1. Open modal → Should fetch (no cache)
2. Close and reopen → Should use cache (if valid)
3. Simulate network error → Should show "no options" but NOT cache it
4. Reopen after error → Should fetch again (not use empty cache)
5. Successful fetch → Should cache and use on next open

