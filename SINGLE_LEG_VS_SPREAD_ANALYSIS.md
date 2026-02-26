# Single-Leg vs Spread Analysis for "How High" and "How Low" Events

## Current Implementation: 2-Leg Spreads

### "How High" Event Example
**Event**: "Will Bitcoin reach $130k or above?"
**Threshold**: $130k
**Current Strategy**: PUT spread below $130k (for YES bet)

**Example Spread**:
- Long PUT @ $110k
- Short PUT @ $100k
- Spread width: $10k
- Premium: ~$10-20
- Max payout: $10k × notional

### "How Low" Event Example
**Event**: "Will Bitcoin go below $80k?"
**Threshold**: $80k
**Current Strategy**: CALL spread above $80k (for YES bet)

**Example Spread**:
- Long CALL @ $90k
- Short CALL @ $100k
- Spread width: $10k
- Premium: ~$10-20
- Max payout: $10k × notional

---

## Alternative: Single-Leg Protective Options

### "How High" + YES Bet
**User's Question**: Would a single $110k CALL be better than a PUT spread?

**Analysis**:
- **User bets**: YES, BTC will reach ≥ $130k
- **User LOSES if**: BTC < $130k
- **Hedge should pay when**: BTC < $130k (user loses)

**Single-Leg Option Options**:

#### Option A: PUT @ $110k (below threshold)
- **Payoff**: Pays if BTC < $110k
- **Max payout**: Unlimited (theoretically up to $110k × notional)
- **Premium**: Higher than spread (single leg, no offset)
- **Coverage**: Only protects if BTC drops below $110k
- **Gap**: No protection between $110k and $130k ❌

#### Option B: PUT @ $130k (at threshold)
- **Payoff**: Pays if BTC < $130k
- **Max payout**: Up to $130k × notional
- **Premium**: Very high (ATM/ITM option)
- **Coverage**: Protects exactly when user loses ✅
- **Cost**: Likely exceeds user's budget ❌

#### Option C: CALL @ $110k (below threshold)
- **Payoff**: Pays if BTC > $110k
- **Max payout**: Unlimited
- **Premium**: High (ITM option)
- **Coverage**: Pays when BTC is above $110k
- **Problem**: User LOSES when BTC < $130k, not when BTC > $110k ❌
- **This doesn't hedge the loss region!**

### "How Low" + YES Bet
**User's Question**: Would a single CALL be better than a CALL spread?

**Analysis**:
- **User bets**: YES, BTC will go ≤ $80k
- **User LOSES if**: BTC > $80k
- **Hedge should pay when**: BTC > $80k (user loses)

**Single-Leg Option Options**:

#### Option A: CALL @ $90k (above threshold)
- **Payoff**: Pays if BTC > $90k
- **Max payout**: Unlimited
- **Premium**: High (ITM option)
- **Coverage**: Protects when BTC > $90k ✅
- **Gap**: No protection between $80k and $90k ❌

#### Option B: CALL @ $80k (at threshold)
- **Payoff**: Pays if BTC > $80k
- **Max payout**: Unlimited
- **Premium**: Very high (ATM option)
- **Coverage**: Protects exactly when user loses ✅
- **Cost**: Likely exceeds user's budget ❌

---

## Economic Comparison

### Spread Advantages ✅

1. **Lower Premium**:
   - Spread premium = (long_ask - short_bid) × notional
   - Single leg premium = long_ask × notional
   - Spread is cheaper because short leg offsets cost

2. **Controlled Risk**:
   - Spread has defined max payout (spread width × notional)
   - Single leg has unlimited max payout (harder to budget)

3. **Better Value Ratio**:
   - Spread: Premium $10, Max payout $10k → Ratio 1000:1
   - Single leg: Premium $50, Max payout unlimited → Harder to calculate ratio

4. **Digital Replication**:
   - Spread approximates digital/binary payoff
   - Single leg has linear payoff (not binary)

### Single-Leg Advantages ✅

1. **Simpler Structure**:
   - One leg instead of two
   - Easier to understand

2. **Unlimited Upside** (for protective calls):
   - If BTC goes to $200k, single call pays more
   - Spread caps at spread width

3. **No Short Leg Risk**:
   - Spread has short leg (limited upside)
   - Single leg has no short leg risk

### For "How High" + YES (PUT Spread vs Single PUT)

**Current Spread**:
- Long PUT @ $110k, Short PUT @ $100k
- Premium: $10
- Max payout: $10k (if BTC < $100k)
- Payout at $105k: $5k (50% of max)

**Single PUT @ $110k**:
- Premium: ~$30-50 (much higher)
- Max payout: $110k (if BTC = $0)
- Payout at $105k: $5k
- Payout at $100k: $10k
- Payout at $90k: $20k (better than spread)

**Analysis**:
- Single PUT provides **better protection** (higher payouts)
- But **much higher premium** ($30-50 vs $10)
- **Value ratio**: Spread might be better (10:1000 vs 30:11000)
- **Budget constraint**: Single PUT might exceed user's budget

### For "How Low" + YES (CALL Spread vs Single CALL)

**Current Spread**:
- Long CALL @ $90k, Short CALL @ $100k
- Premium: $10
- Max payout: $10k (if BTC > $100k)
- Payout at $95k: $5k (50% of max)

**Single CALL @ $90k**:
- Premium: ~$30-50 (much higher)
- Max payout: Unlimited (if BTC → ∞)
- Payout at $95k: $5k
- Payout at $100k: $10k
- Payout at $110k: $20k (better than spread)

**Analysis**:
- Single CALL provides **better protection** (unlimited upside)
- But **much higher premium** ($30-50 vs $10)
- **Value ratio**: Depends on BTC price movement
- **Budget constraint**: Single CALL might exceed user's budget

---

## Recommendation

### For Demo/User Hedging: **Keep Spreads** ✅

**Reasons**:
1. **Budget-Friendly**: Spreads fit within user's 20% hedge budget
2. **Better Value Ratio**: Lower premium for similar protection
3. **Digital Replication**: Spreads better approximate binary payoffs
4. **Controlled Risk**: Defined max payout is easier to budget
5. **Institutional Standard**: Spreads are standard for hedging binary events

### When Single-Leg Might Be Better:

1. **Large Budget**: If user has budget for $50+ premium
2. **Extreme Scenarios**: If user wants unlimited upside protection
3. **Simpler UX**: If we want to simplify the strategy display

### Hybrid Approach (Future Enhancement):

**Offer Both Options**:
- **"Light Protection"**: Spread (lower cost, defined payout)
- **"Standard Protection"**: Single leg (higher cost, unlimited upside)
- **"Max Protection"**: Larger single leg or wider spread

**Current Implementation**: Spreads are optimal for demo because:
- ✅ Fit user budget (20% of stake = $20 for $100 stake)
- ✅ Provide good value ratio (premium < max_payout)
- ✅ Replicate digital payoffs effectively
- ✅ Standard institutional practice

---

## Conclusion

**Current spread approach is correct** for the demo use case:
- Spreads provide better value (lower premium, good protection)
- Single legs would be too expensive for typical user budgets
- Spreads better replicate the binary nature of Kalshi events

**However**, if we wanted to offer single-leg options:
- Would need to check if premium fits budget
- Would need to calculate value ratio differently
- Would provide better protection but at higher cost
- Could be offered as "Premium Protection" tier

**Recommendation**: **Keep current spread approach** - it's optimal for the demo's budget constraints and value proposition.

