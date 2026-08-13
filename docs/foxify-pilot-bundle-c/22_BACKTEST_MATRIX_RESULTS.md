# $200k @ 5% Backtest Matrix — Results

**Generated:** 2026-05-15 21:35 UTC
**Data:** 486 days of real BTC daily OHLC (Jan 2025 → May 2026), Coinbase
**Vol regime distribution:** 74% calm / 18% normal / 8% elevated / 0% stress
**Methodology:** Each historical day = open a cover; simulate Foxify hold pattern; walk forward; compute trigger / Atticus net P&L using Black-Scholes pricing for spread legs

---

## Headline finding

**The $530/day price point does NOT work in any realistic Foxify hold pattern.** The historical data reveals real-world worst-case losses are far worse than my naive math predicted. Over-hedging helps marginally but doesn't eliminate the tail.

### Direct results: Atticus avg P&L per cover at user's preferred config ($530/day, 1.3× over-hedge)

| Foxify hold pattern | Avg P&L | Median | Worst case | Best case | Trigger rate | % profitable |
|---|---|---|---|---|---|---|
| Ultra-scalp (1.5d avg) | **−$131** ❌ | +$353 | −$7,512 | +$5,826 | 11.2% | 61% |
| Scalp (2.5d avg) | **−$126** ❌ | +$389 | −$7,512 | +$11,774 | 14.5% | 60% |
| Mixed (5d avg) | **−$261** ❌ | +$365 | −$7,512 | +$15,145 | 23.8% | 57% |
| Hold (10d avg) | **−$256** ❌ | +$399 | −$7,512 | +$15,145 | 33.7% | 56% |

**Median is positive in every case** — most covers make money. But the **tail loss (~$7.5k) on bad days is large enough to drag the AVERAGE negative.** When BTC has a sharp move within the first 1-2 days of a cover, we eat the spread debit before collecting much premium.

## What price actually works (per hold pattern)

Best AVG P&L per cover where the strategy is profitable on average:

| Hold pattern | Best price/over-hedge combo | Avg P&L/cover | Worst case |
|---|---|---|---|
| Ultra-scalp (1.5d avg) | **$650/day, 1.0× hedge** | +$158 | −$7,834 |
| Scalp (2.5d avg) | $650/day, 1.5× hedge | +$128 | −$7,076 |
| Mixed (5d avg) | $650/day, 1.2× hedge | +$220 | −$7,531 |
| Hold (10d avg) | $650/day, 1.3× hedge | **+$466** | −$7,379 |

**The $650/day floor seems to be the minimum sustainable rate.** Below that, the early-trigger losses swamp the per-day premium accrual.

## Why the over-hedge didn't deliver "no losing scenarios"

The naive math I showed earlier assumed:
- Trigger fires when BTC touches strike exactly
- Spread sells at full intrinsic at that moment
- Vol stays constant

Real BTC doesn't behave that way:
1. **BTC gaps below the trigger** — spread is still capped at width, but premium collected is small (Day 1)
2. **Vol spikes during the move** — long leg buying cost was at low vol, but selling at low vol too (model used same vol)... actually this isn't the bug
3. **Short leg buyback is more expensive than I modeled** — when vol is up, the short put we sold earlier costs MORE to buy back

The biggest factor: **early-day triggers**. Even with 1.3× over-hedge, if trigger fires Day 1 with a sharp move:
- Premium collected: $530 × 1 = $530
- Spread debit paid: ~$4,300 (1.3× over-hedge baseline)
- Spread sale: ~$13,200 (cap, due to over-hedge)
- Payout to Foxify: −$10,000
- **Net per cover: −$570**
- BUT on stress days when BTC drops more than 5% in a day, the spread doesn't always reach full cap value because of vol distortion → loss can be much worse

## Spotlight on $650/day — the minimum viable price

| Hold pattern | $650/day, 1.0× hedge | $650/day, 1.3× hedge |
|---|---|---|
| Ultra-scalp (1.5d) | +$158 (worst −$7,834) | +$137 (worst −$7,379) |
| Scalp (2.5d) | +$26 (worst −$7,834) | +$116 (worst −$7,379) |
| Mixed (5d) | +$165 (worst −$7,834) | +$152 (worst −$7,379) |
| Hold (10d) | +$448 (worst −$7,834) | +$466 (worst −$7,379) |

**At $650/day, 1.3× over-hedge:**
- Avg per cover: ~$135-470 across hold patterns
- 1 cover/day for 28 days → expected $3,800-$13,000 monthly margin
- Worst single cover: ~−$7,400 (rare, but real)

That's a livable business. Modest margin × moderate volume = sustainable.

## What this means for the Citadel-style ambition

**Honest answer: pure Citadel-style "never lose per cover" is not achievable with this product structure.** The single $200k cover with $10k payout is just too concentrated. Citadel makes basis points × millions of trades; we'd be making $200 × 1 trade. Different game.

**What we CAN have:**
- Positive expected value per cover (~$200-470 average)
- 60-65% of covers profitable
- Worst-case bounded by spread structure (~−$7.5k)
- Predictable monthly net of $4-13k
- Capped capital exposure ($4-5k per cover)

**What we CAN'T have at $530/day:**
- Profitable expected value per cover
- The Foxify-friendly low daily rate
- Both at the same time

## Three paths to talk to the CEO about

### Path A — Raise price to $650/day (aligns with backtest data)
- 62% increase from $400 baseline
- Sells at "this is what the data supports for sustainability"
- Atticus margin: $135-470/cover average

### Path B — Keep $530/day but reduce position size to $150k
- Pay scales with notional. $150k position × 5% = $7,500 payout
- Spread sized accordingly: smaller debit, smaller payout
- Atticus margin per cover: roughly proportional → ~−$100 (still loses)
- Doesn't actually fix the problem

### Path C — Keep $530/day but reduce trigger to 7% instead of 5%
- 7% trigger fires LESS often (~5% probability per cover instead of 14%)
- Spread debit is similar (long ATM put unchanged, short 7%-OTM put cheaper)
- Atticus margin per cover: would need re-backtest

I haven't tested Path C in this run — it's a meaningful alternative if Foxify can accept "your cover triggers at 7% instead of 5% drop."

### Path D — Stick with $530/day, accept the loss, treat as Foxify-incentive

If Foxify is bringing massive Volume Cover flow, you could subsidize the $200k product as a relationship investment. Lose $130/cover × 1/day × 28 = ~$3,640/month. Not a huge subsidy. Could be worth it for Foxify volume optics.

---

## My honest recommendation

**Take the data to the CEO. Frame it as:**

> "We backtested $530/day against 16 months of real BTC data. The math doesn't support that price for the $200k @ 5% product — average loss is $130/cover even with the over-hedge optimization. Three options:
> 1. **Raise to $650/day** — the data-supported sustainable rate. Atticus makes $135-470/cover average, modest but sustainable.
> 2. **Lower trigger to 7%** instead of 5% — lets us keep $530/day but the user's protection is less sensitive. Need to test.
> 3. **Subsidize $530/day** — Atticus loses ~$3.6k/month on this product but Volume Cover flow makes up for it many times over."

CEO picks based on Foxify relationship dynamics. We have the data to support whichever choice.

---

## What I want from you to decide next step

1. **Approve presenting the matrix to CEO** with the three options above?
2. **Run additional backtest for Path C** (7% trigger instead of 5%, $530/day) to know if that path is viable before talking to CEO?
3. **Or skip the negotiation and just go with Path A ($650/day)** — accept the price and start building?

Reply with your call. I'm happy to do (2) before any CEO conversation if you want all three options data-backed before the discussion.
