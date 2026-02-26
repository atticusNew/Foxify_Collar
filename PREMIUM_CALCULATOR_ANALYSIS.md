# Premium Calculator Analysis

## Current Implementation Issue

### What's Wrong

**Current Fix (Lines 92-114):**
```python
if premium_final > max_payout_final:
    # Scale notional so that premium = max_payout
    scale_factor = max_payout_final / premium_final
    N_final = N_final * scale_factor
    premium_final = N_final * spot_price * (long_ask - short_bid)
    max_payout_final = N_final * spread_width
```

**Problem:** This makes `premium_final = max_payout_final`, which is:
1. ❌ **Not economically sensible** - trader pays $16.37 to potentially receive $16.37 (1:1 ratio)
2. ❌ **No value proposition** - trader gets no upside, just breaks even at best
3. ❌ **Violates user requirement** - user said "premium has to be lower and ideally of value compared to payout"

## Specification Review

### Original Specification (from user requirements):

```
5.3 Enforce payoff ≥ premium and budget

Steps:
1. Compute initial premium_raw from initial_notional
2. Compute max_payout_raw = initial_notional * spread_width
3. Clamp target premium: target_premium = min(user_budget, max_payout_raw)
4. Scale notional: scale = target_premium / premium_raw
   N_final = initial_notional * scale
5. max_payout_final = N_final * spread_width
6. Guarantee: target_premium <= max_payout_final by construction
```

**Key Points:**
- Guarantee is: `target_premium <= max_payout_final` (not `premium_final <= max_payout_final`)
- After scaling: `premium_final = target_premium` (by construction)
- So guarantee becomes: `premium_final <= max_payout_final`

### The Mathematical Relationship

After scaling by `scale = target_premium / premium_raw`:

```
premium_final = N_final * spot * (c_long - c_short)
              = initial_notional * scale * spot * (c_long - c_short)
              = initial_notional * (target_premium / premium_raw) * spot * (c_long - c_short)
              = target_premium * (spot * (c_long - c_short)) / (premium_raw / initial_notional)
              = target_premium  [because premium_raw = initial_notional * spot * (c_long - c_short)]

max_payout_final = N_final * spread_width
                 = initial_notional * scale * spread_width
                 = initial_notional * (target_premium / premium_raw) * spread_width
                 = target_premium * spread_width / (premium_raw / initial_notional)
                 = target_premium * spread_width / (spot * (c_long - c_short))
```

**Critical Ratio:**
```
max_payout_final / premium_final = spread_width / (spot * (c_long - c_short))
```

**This ratio determines if the hedge is economically sensible:**
- If `spread_width > spot * (c_long - c_short)` → `max_payout > premium` ✅ Good value
- If `spread_width = spot * (c_long - c_short)` → `max_payout = premium` ⚠️ Break-even (not ideal)
- If `spread_width < spot * (c_long - c_short)` → `max_payout < premium` ❌ Bad value (should reject)

## The Real Problem

### When Does `premium_final > max_payout_final` Happen?

This happens when:
```
premium_final > max_payout_final
target_premium > target_premium * spread_width / (spot * (c_long - c_short))
1 > spread_width / (spot * (c_long - c_short))
spot * (c_long - c_short) > spread_width
```

**This means:** The option spread premium (per BTC) is greater than the spread width (per BTC).

**Example:**
- Spread width: $4,000 (K2 - K1 = $84k - $80k)
- Spot: $100,000
- Option premium spread: $0.05 (5% of spot)
- `spot * (c_long - c_short) = $100,000 * 0.05 = $5,000`
- `$5,000 > $4,000` → Premium > Max payout

**This is economically nonsensical!** You're paying $5,000 to potentially receive $4,000.

## What Should Happen

### Option 1: Reject Bad Spreads (Recommended)

If `premium_final > max_payout_final` after initial scaling, **reject the candidate** because:
1. It's economically nonsensical
2. No trader would pay more than they can receive
3. The spread is too narrow relative to option prices

**Logic:**
```python
# After initial scaling
premium_final = target_premium
max_payout_final = N_final * spread_width

if premium_final > max_payout_final:
    logger.debug("Rejecting candidate: premium exceeds max payout (economically nonsensical)")
    return None  # Reject, don't scale down
```

### Option 2: Scale Down to Achieve Minimum Ratio

If we want to keep the candidate but make it economically sensible:

**Require minimum ratio:** `max_payout_final / premium_final >= MIN_RATIO` (e.g., 1.2 or 1.5)

**Logic:**
```python
MIN_PAYOUT_PREMIUM_RATIO = Decimal('1.2')  # Max payout must be at least 20% more than premium

# After initial scaling
premium_final = target_premium
max_payout_final = N_final * spread_width

# Check if ratio is acceptable
if max_payout_final / premium_final < MIN_PAYOUT_PREMIUM_RATIO:
    # Scale down to achieve minimum ratio
    # We want: max_payout_final / premium_final >= MIN_RATIO
    # So: premium_final <= max_payout_final / MIN_RATIO
    max_allowed_premium = max_payout_final / MIN_PAYOUT_PREMIUM_RATIO
    if target_premium > max_allowed_premium:
        # Scale down notional to achieve ratio
        scale_factor = max_allowed_premium / target_premium
        N_final = N_final * scale_factor
        premium_final = N_final * spot_price * (long_ask - short_bid)
        max_payout_final = N_final * spread_width
```

## Recommendation

**Use Option 1: Reject Bad Spreads**

**Reasoning:**
1. ✅ **Economically correct** - If premium > max_payout, the spread is fundamentally bad
2. ✅ **Simple** - No complex scaling logic
3. ✅ **Clear to user** - "Hedge unavailable" is better than offering a bad hedge
4. ✅ **Matches user requirement** - "premium has to be lower and ideally of value compared to payout"

**Implementation:**
```python
# After initial scaling (lines 86-88)
premium_final = N_final * spot_price * (long_ask - short_bid)
max_payout_final = N_final * spread_width

# Check economic validity
if premium_final > max_payout_final:
    logger.debug(
        "Rejecting candidate: premium exceeds max payout (economically nonsensical)",
        premium_final=premium_final,
        max_payout_final=max_payout_final,
        ratio=max_payout_final / premium_final if premium_final > 0 else 0
    )
    return None  # Reject - this spread doesn't make economic sense

# Optional: Check minimum value ratio
MIN_VALUE_RATIO = Decimal('1.1')  # Max payout should be at least 10% more than premium
if max_payout_final / premium_final < MIN_VALUE_RATIO:
    logger.debug(
        "Rejecting candidate: payout-to-premium ratio too low (poor value)",
        premium_final=premium_final,
        max_payout_final=max_payout_final,
        ratio=max_payout_final / premium_final
    )
    return None  # Reject - not enough value for trader
```

## Summary

**Current Fix:** ❌ Wrong - Makes premium = max_payout (1:1 ratio, no value)

**Correct Approach:** ✅ Reject spreads where premium > max_payout (economically nonsensical)

**Optional Enhancement:** Add minimum value ratio check (e.g., max_payout must be at least 10-20% more than premium)

---

**Action Required:** Remove the scaling-down logic (lines 92-114) and replace with rejection logic.

