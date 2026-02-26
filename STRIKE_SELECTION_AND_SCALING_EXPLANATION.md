# Explanation: Strike Selection and Notional Scaling

## Current Problem

Options are being generated but rejected because:
- **Premium**: $20.00
- **Max Payout**: $21.34
- **Ratio**: 1.067 (max_payout / premium)
- **Required Ratio**: ≥ 1.1

The ratio is too low (1.067 < 1.1), so the hedge fails economic validity.

---

## Concept 1: Try Alternative Strikes (Fallback Logic)

### What It Means

When selecting strikes for an option spread, we follow specific rules:

**Example for "BELOW K + YES"** (Kalshi event: "Below $130k"):
- **Rule**: Pick first two call strikes ≥ $130k
- **Result**: Might pick strikes at $130k and $135k
- **Problem**: These strikes might create a spread with poor premium-to-payout ratio

**Alternative Strikes** would be:
- **First attempt**: $130k and $135k (spread width = $5k)
- **Second attempt**: $135k and $140k (spread width = $5k, but different strikes)
- **Third attempt**: $130k and $140k (spread width = $10k, wider = better ratio potentially)

### How It Currently Works

The code already has fallback logic in `api/main.py`:

```python
for attempt in range(3):  # Try up to 3 alternative strikes
    strikes = strike_selector.find_strikes(
        ...
        try_alternatives=(attempt > 0),
        alternative_offset=attempt  # 0, 1, or 2
    )
```

The `StrikeSelector` uses `alternative_offset` to pick different strikes:
- `offset=0`: First two strikes (e.g., $130k, $135k)
- `offset=1`: Next two strikes (e.g., $135k, $140k)
- `offset=2`: Next two strikes (e.g., $140k, $145k)

### Why It Might Not Be Working

1. **All alternatives might have poor ratios**: If all strike combinations fail the 1.1 ratio, none will work
2. **Strike selection might be too narrow**: The strikes might be too close together, creating small spread widths
3. **Fallback might not be trying wide enough spreads**: We might need to try strikes that are further apart

### What We Could Improve

1. **Try wider spreads**: Instead of just moving to next strikes, try strikes that are further apart (e.g., $130k and $140k instead of $130k and $135k)
2. **Try different strike combinations**: For PUT spreads, try different pairs of strikes
3. **Prioritize by spread width**: Try strikes with wider spreads first (wider spread = potentially better ratio)

---

## Concept 2: Adjust Notional Scaling to Improve Ratio

### What It Means

**Notional** = How many BTC worth of options we buy/sell in the spread.

**Current Process**:

1. **Initial Notional Calculation**:
   ```python
   initial_notional = user_stake / (5 * spread_width)
   # Example: $100 stake, $5k spread width
   # initial_notional = $100 / (5 * $5000) = 0.004 BTC
   ```

2. **Premium Calculation**:
   ```python
   premium = initial_notional * spot_price * (long_ask - short_bid)
   # Example: 0.004 BTC * $100k * 0.05 = $20
   ```

3. **Max Payout Calculation**:
   ```python
   max_payout = initial_notional * spread_width
   # Example: 0.004 BTC * $5000 = $20
   ```

4. **Scaling to Fit Budget**:
   ```python
   target_premium = min(user_budget, max_payout)
   scale = target_premium / premium_raw
   N_final = initial_notional * scale
   ```

### The Problem

When we scale the notional to fit the budget, we might be:
- **Scaling up** the notional (if budget is large), which increases both premium AND max_payout proportionally
- But if the **raw ratio** (before scaling) is already poor, scaling won't help

**Example**:
- Raw premium: $10, Raw max_payout: $10.50 → Ratio: 1.05 (too low!)
- Scale by 2x: Premium: $20, Max payout: $21 → Ratio: 1.05 (still too low!)

### What We Could Improve

1. **Scale to Meet Ratio Requirement**: Instead of scaling to fit budget, scale to ensure ratio ≥ 1.1
   ```python
   # Instead of: scale = target_premium / premium_raw
   # Do: scale = (max_payout_raw * 0.909) / premium_raw  # 0.909 = 1/1.1
   # This ensures: max_payout / premium = 1.1
   ```

2. **Cap Notional Based on Ratio**: Don't scale beyond what gives us a 1.1 ratio
   ```python
   max_notional_for_ratio = (premium_raw * 1.1) / spread_width
   N_final = min(initial_notional * scale, max_notional_for_ratio)
   ```

3. **Adjust Initial Notional Formula**: Change the `5` multiplier to create better initial ratios
   ```python
   # Current: initial_notional = user_stake / (5 * spread_width)
   # Try: initial_notional = user_stake / (4 * spread_width)  # Larger notional = better ratio potentially
   ```

### Trade-offs

- **Wider spreads**: Better ratio, but might be more expensive or less precise
- **Larger notional**: Better ratio, but uses more of user's budget
- **Different strikes**: Might be further from barrier, less precise hedge

---

## Recommendation

**Option 1: Improve Strike Selection (Preferred)**
- Try wider spreads (strikes further apart)
- Prioritize strikes that give better ratios
- Keep trying alternatives until we find one that meets 1.1 ratio

**Option 2: Adjust Notional Scaling (Fallback)**
- Scale notional to ensure ratio ≥ 1.1, not just to fit budget
- This might result in smaller hedges, but they'll be economically valid

**Option 3: Both**
- Try better strikes first
- If still failing, adjust scaling as fallback

Which approach would you prefer?

