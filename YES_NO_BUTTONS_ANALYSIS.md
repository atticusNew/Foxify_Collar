# YES/NO Buttons Analysis - Making Them Active

## Current Implementation

### EventCard YES/NO Buttons
**Location**: `EventCard.jsx` lines ~310-400

**Current Behavior**:
- YES/NO buttons are displayed for regular events (non-multi-choice)
- Currently call `onProtect(event)` when clicked
- This opens the hedge modal but doesn't pre-select a position

**Code**:
```jsx
<button onClick={() => onProtect && onProtect(event)}>
  Yes {yesPriceCents}¢
</button>
<button onClick={() => onProtect && onProtect(event)}>
  No {noPriceCents}¢
</button>
```

### HedgeModal Current Flow
**Location**: `HedgeModal.jsx`

**Current Flow**:
1. Modal opens with `event` and optional `choice`
2. User must select YES or NO position
3. Then options load for that position
4. User selects tier
5. Clicks "Execute Trade"

**Position Selection**:
- `selectedPosition` state starts as `null`
- User clicks YES/NO buttons in modal to select
- Then `hedgeOptions` loads for that position

## Making YES/NO Buttons Active

### Option 1: Pre-select Position When Opening Modal

**Implementation Difficulty**: ⭐⭐ Easy (2/5)

**Changes Needed**:

1. **EventCard.jsx** - Pass position when opening modal:
```jsx
<button onClick={() => {
  setSelectedChoice(null)
  setShowHedgeModal(true)
  setPreSelectedPosition('yes')  // New state
}}>
  Yes {yesPriceCents}¢
</button>

<button onClick={() => {
  setSelectedChoice(null)
  setShowHedgeModal(true)
  setPreSelectedPosition('no')  // New state
}}>
  No {noPriceCents}¢
</button>
```

2. **HedgeModal.jsx** - Accept and use pre-selected position:
```jsx
export default function HedgeModal({ event, choice, onClose, onHedgeComplete, preSelectedPosition = null }) {
  const [selectedPosition, setSelectedPosition] = useState(preSelectedPosition) // Start with pre-selected
  
  useEffect(() => {
    if (preSelectedPosition && eventTicker) {
      // Auto-load options for pre-selected position
      setSelectedPosition(preSelectedPosition)
      // Options will load automatically via existing useEffect
    }
  }, [preSelectedPosition, eventTicker])
}
```

**Pros**:
- ✅ Simple implementation
- ✅ Better UX - one less click
- ✅ Feels more like Kalshi (click YES → see YES hedges)
- ✅ Minimal code changes

**Cons**:
- ⚠️ User can't easily switch position (would need to close and reopen)
- ⚠️ Less flexible than current approach

---

### Option 2: Pre-load Options for Pre-selected Position

**Implementation Difficulty**: ⭐⭐⭐ Medium (3/5)

**Changes Needed**:

1. **EventCard.jsx** - Pass position and pre-load flag:
```jsx
<button onClick={() => {
  onProtect(event, null, { preSelectPosition: 'yes', preLoadOptions: true })
}}>
  Yes {yesPriceCents}¢
</button>
```

2. **HedgeModal.jsx** - Accept pre-selected position and auto-load:
```jsx
export default function HedgeModal({ 
  event, 
  choice, 
  onClose, 
  onHedgeComplete,
  preSelectedPosition = null,
  preLoadOptions = false
}) {
  const [selectedPosition, setSelectedPosition] = useState(preSelectedPosition)
  
  useEffect(() => {
    if (preSelectedPosition && preLoadOptions && eventTicker) {
      // Immediately fetch options for pre-selected position
      const cached = getCachedOptions(eventTicker)
      if (cached && cached[preSelectedPosition]?.length > 0) {
        setHedgeOptions(cached[preSelectedPosition])
      } else {
        fetchHedgeOptions() // Fetch for pre-selected position
      }
    }
  }, [preSelectedPosition, preLoadOptions, eventTicker])
}
```

**Pros**:
- ✅ Fast - options load immediately
- ✅ Better UX - instant feedback
- ✅ Still allows switching position

**Cons**:
- ⚠️ More complex - need to handle pre-loading logic
- ⚠️ Might fetch unnecessarily if user switches position

---

### Option 3: Keep Current Flow But Improve UX

**Implementation Difficulty**: ⭐ Very Easy (1/5)

**Changes Needed**:

1. **EventCard.jsx** - Just open modal (no changes needed)
2. **HedgeModal.jsx** - Improve visual feedback:
   - Highlight YES/NO buttons more prominently
   - Show loading state when options are loading
   - Auto-focus on position selection

**Pros**:
- ✅ No code changes needed
- ✅ Current flow already works
- ✅ User can switch position easily

**Cons**:
- ⚠️ One extra click (select position)
- ⚠️ Less like Kalshi feel

---

## Recommendation: Option 1 (Pre-select Position)

### Why Option 1 is Best for Demo

1. **Kalshi-like Feel**: Clicking YES/NO directly shows hedges for that position
2. **Simple Implementation**: Minimal code changes
3. **Better UX**: One less step for user
4. **Still Flexible**: User can close modal and click other position if needed

### Implementation Plan

**Step 1: Add preSelectedPosition prop to HedgeModal**
- Accept `preSelectedPosition` prop (optional)
- Initialize `selectedPosition` state with this value
- If provided, auto-trigger option loading

**Step 2: Update EventCard YES/NO buttons**
- Add state: `const [preSelectedPosition, setPreSelectedPosition] = useState(null)`
- YES button: Set `preSelectedPosition = 'yes'` then open modal
- NO button: Set `preSelectedPosition = 'no'` then open modal
- Pass `preSelectedPosition` to HedgeModal

**Step 3: Update EventsGrid**
- Pass `preSelectedPosition` through to HedgeModal

**Estimated Effort**: 15-20 minutes
**Risk Level**: Low (minimal changes, easy to test)

---

## Alternative: Better Demo Approach?

### Option A: Keep Current + Add Visual Indicator
- Keep current flow
- Add visual indicator that YES/NO buttons are clickable
- Add hover effect: "Click to hedge this position"
- **Pros**: No code changes, clear UX
- **Cons**: Still requires position selection in modal

### Option B: Two-Step Flow
- Click YES/NO → Shows quick preview (premium range, max payout)
- Click "View Hedges" → Opens full modal with that position pre-selected
- **Pros**: More informative, still flexible
- **Cons**: More complex, might be overkill for demo

### Option C: Inline Hedge Preview
- Click YES/NO → Shows hedge tiers inline (no modal)
- Click tier → Opens confirmation modal
- **Pros**: Fastest UX, very Kalshi-like
- **Cons**: Significant UI changes, more complex

---

## Final Recommendation

**Go with Option 1 (Pre-select Position)**:
- ✅ Best balance of simplicity and UX improvement
- ✅ Makes YES/NO buttons feel active and useful
- ✅ Minimal code changes
- ✅ Feels more like Kalshi
- ✅ Easy to implement and test

**Implementation Steps**:
1. Add `preSelectedPosition` prop to HedgeModal
2. Initialize `selectedPosition` with prop value
3. Update EventCard YES/NO buttons to set and pass position
4. Test: Click YES → Modal opens with YES position selected and options loading

**Estimated Time**: 15-20 minutes
**Risk**: Low

