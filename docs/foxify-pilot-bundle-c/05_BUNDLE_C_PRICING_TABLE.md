# Bundle C / P3 — User-Facing Pricing Table (rev 6)

> What a trader sees at quote time, by position size and SL tier, in each volatility regime. Premium is fixed at quote time and locked at activation; payout is also fixed (= notional × SL%).

> **Rev 6 changes:** 10% tier dropped, 7% tier added, stress 2% premium lifted from 1.5× → 1.8× trader return.

---

## How to read this

- **Premium** = what the trader pays upfront (locked when they click "Open + Protect")
- **Payout** = what they receive instantly if BTC hits the trigger before tenor expires
- **Return on trigger** = payout ÷ premium (the multiplier they earn if it triggers)
- All numbers below are USD; all positions are 1-DTE (1-day rolling tenor)
- Today (DVOL 38.4) is **CALM regime**; the right-most regime is what they'd pay if BTC vol spikes

---

## CALM REGIME (DVOL ≤ 50) — most days, including today

| Position size | 2% SL | | 3% SL | | 5% SL | | **7% SL** | |
|---|---|---|---|---|---|---|---|---|
| | **Premium** | Payout | **Premium** | Payout | **Premium** | Payout | **Premium** | Payout |
| $10,000 | **$100** | $200 | **$70** | $300 | **$40** | $500 | **$30** | $700 |
| $15,000 | **$150** | $300 | **$105** | $450 | **$60** | $750 | **$45** | $1,050 |
| $20,000 | **$200** | $400 | **$140** | $600 | **$80** | $1,000 | **$60** | $1,400 |
| $25,000 | **$250** | $500 | **$175** | $750 | **$100** | $1,250 | **$75** | $1,750 |
| $30,000 | **$300** | $600 | **$210** | $900 | **$120** | $1,500 | **$90** | $2,100 |
| $40,000 | **$400** | $800 | **$280** | $1,200 | **$160** | $2,000 | **$120** | $2,800 |
| **$50,000** | **$500** | **$1,000** | **$350** | **$1,500** | **$200** | **$2,500** | **$150** | **$3,500** |
| Return on trigger | **2.0×** | | **4.3×** | | **12.5×** | | **23.3×** | |

---

## NORMAL REGIME (DVOL 50–65)

| Position size | 2% SL | | 3% SL | | 5% SL | | **7% SL** | |
|---|---|---|---|---|---|---|---|---|
| | **Premium** | Payout | **Premium** | Payout | **Premium** | Payout | **Premium** | Payout |
| $10,000 | **$105** | $200 | **$75** | $300 | **$45** | $500 | **$35** | $700 |
| $15,000 | **$158** | $300 | **$113** | $450 | **$68** | $750 | **$53** | $1,050 |
| $20,000 | **$210** | $400 | **$150** | $600 | **$90** | $1,000 | **$70** | $1,400 |
| $25,000 | **$263** | $500 | **$188** | $750 | **$113** | $1,250 | **$88** | $1,750 |
| $30,000 | **$315** | $600 | **$225** | $900 | **$135** | $1,500 | **$105** | $2,100 |
| $40,000 | **$420** | $800 | **$300** | $1,200 | **$180** | $2,000 | **$140** | $2,800 |
| **$50,000** | **$525** | **$1,000** | **$375** | **$1,500** | **$225** | **$2,500** | **$175** | **$3,500** |
| Return on trigger | **1.9×** | | **4.0×** | | **11.1×** | | **20.0×** | |

---

## STRESS REGIME (DVOL > 65) — rare, ~10–20% of days  *[rev 6: 2% lifted to 1.8×]*

| Position size | 2% SL | | 3% SL | | 5% SL | | **7% SL** | |
|---|---|---|---|---|---|---|---|---|
| | **Premium** | Payout | **Premium** | Payout | **Premium** | Payout | **Premium** | Payout |
| $10,000 | **$110** ↓ | $200 | **$110** | $300 | **$90** | $500 | **$70** | $700 |
| $15,000 | **$165** | $300 | **$165** | $450 | **$135** | $750 | **$105** | $1,050 |
| $20,000 | **$220** | $400 | **$220** | $600 | **$180** | $1,000 | **$140** | $1,400 |
| $25,000 | **$275** | $500 | **$275** | $750 | **$225** | $1,250 | **$175** | $1,750 |
| $30,000 | **$330** | $600 | **$330** | $900 | **$270** | $1,500 | **$210** | $2,100 |
| $40,000 | **$440** | $800 | **$440** | $1,200 | **$360** | $2,000 | **$280** | $2,800 |
| **$50,000** | **$550** ↓ | **$1,000** | **$550** | **$1,500** | **$450** | **$2,500** | **$350** | **$3,500** |
| Return on trigger | **1.8×** ↑ | | **2.7×** | | **5.6×** | | **10.0×** | |

↓ = lowered from rev 5 ($13/$1k → $11/$1k for stress 2%, per CEO retention concern)
↑ = improved trader return (1.5× → 1.8×)

---

## Rev 6 changes summary

| Change | Reason |
|---|---|
| **10% tier dropped** | Bullish has zero strikes near $73k put or $89k call; would be Deribit-only forever |
| **7% tier added** | Fills demand gap between 5% and the dropped 10%; Bullish 1-week strike grid covers it |
| **Stress 2% lifted from $13/$1k → $11/$1k** | Trader return improves from 1.5× to 1.8×; cost ~$1k of pilot P&L |
| **Min position size unchanged at $10k** | Pilot Agreement §3.1 mandates this; revisit post-pilot |

---

## Pricing schedule reference (per $1,000 of notional)

The math underneath the tables above:

| Tier | Calm | Normal | Stress |
|---|---|---|---|
| 2% | $10.00 / $1k | $10.50 / $1k | $13.00 / $1k |
| 3% | $7.00 / $1k | $7.50 / $1k | $11.00 / $1k |
| 5% | $4.00 / $1k | $4.50 / $1k | $9.00 / $1k |
| 10% | $2.00 / $1k | $2.50 / $1k | $6.00 / $1k |

Premium for any (size, tier, regime) = `notional × per-$1k rate / 1000`.

---

## Comparison to current (deployed) pricing

What the trader pays today vs what they'd pay under Bundle C / P3:

| Position | Tier | Current premium | **Bundle C calm** | Bundle C normal | Bundle C stress |
|---|---|---|---|---|---|
| $50,000 | 2% | $125 | **$500** (4.0× higher) | $525 | $650 |
| $50,000 | 3% | (assumed $125) | **$350** (2.8× higher) | $375 | $550 |
| $50,000 | 5% | (assumed $125) | **$200** (1.6× higher) | $225 | $450 |
| $50,000 | 10% | (assumed $125) | **$100** (LOWER — $25 less) | $125 | $300 |
| $25,000 | 2% | (assumed $63) | **$250** (4.0× higher) | $263 | $325 |
| $10,000 | 2% | (assumed $25) | **$100** (4.0× higher) | $105 | $130 |

**Key trader-side message:** premium for tighter SL tiers (2% and 3%) goes UP materially, premium for wider SL tiers (5%) goes up a little, and 10% protection actually gets CHEAPER. This shapes demand toward wider tiers, which are higher-margin for the platform AND have less concentrated trigger risk.

(All "current premium" numbers above assume the deployed $25/$10k = $2.50/$1k flat schedule applies to all tiers. If tier-specific deployed pricing differs, the comparison column needs updating once we audit the live env Day 1.)

---

## Return-on-trigger comparison

What the trader earns when BTC hits the trigger:

| Tier | Current return | Bundle C calm | Bundle C normal | Bundle C stress |
|---|---|---|---|---|
| 2% | 8.0× ($1k payout / $125 premium) | **2.0×** | 1.9× | 1.5× |
| 3% | (assumed 12.0×) | **4.3×** | 4.0× | 2.7× |
| 5% | (assumed 20.0×) | **12.5×** | 11.1× | 5.6× |
| 10% | (assumed 40.0×) | **50.0×** | 40.0× | 16.7× |

Trader narrative changes from "small premium for huge upside" to "fair premium for meaningful upside on tight tiers, lottery-ticket on wide tiers." 2.0× return on 2% trigger is at the CEO's stated psychological floor — not below it.

---

## Trader UX implications

1. **Sticker shock on 2% tier in calm regime** — premium quadruples ($125 → $500 on $50k position). This is the biggest single trader-facing change.
2. **5% and 10% tiers become much more attractive** — pricing rises only slightly or actually drops, and returns stay massive. Likely to shift demand toward wider tiers.
3. **Regime-aware pricing visible** — trader sees "Volatility: Low" or "Volatility: Normal" or "Volatility: Stress" label next to the premium so they understand WHY today's price is different from yesterday's.
4. **Premium pre-trade visibility** — trader sees the exact premium before they commit (no hidden fees, no slippage).
5. **Cooldowns invisible** — anti-bot defenses don't surface unless trader hits one (e.g., trying to open both long + short 2% protection within 30 min).

---

## What about Foxify's CEO and the 2× psychological floor?

CEO previously said "2× return on trigger" is the psychological floor below which traders won't buy. Bundle C / P3:
- Calm: **2.0×** on 2% (right at the floor)
- Normal: **1.9×** (one tick below)
- Stress: **1.5×** (below floor — but stress is a small fraction of days; can be revisited mid-pilot if needed)

If CEO pushes back on stress 1.5×, the easy lever is to drop P3 stress 2% from $13/$1k to $11/$1k:
- Stress 2% premium $50k position: $650 → $550
- Stress return: 1.5× → 1.8×
- Cost: ~$100 less per stress 2% trade × 2 trades/day × 5 stress days = ~$1,000 less pilot P&L
- Acceptable trade-off

The **calm 2.0× is non-negotiable** for the platform economics — dropping it any lower means we lose money in the most common regime.

---

*Generated 2026-05-13. Final pricing pending WS#9 backtest harness output Day 5 of execution.*
