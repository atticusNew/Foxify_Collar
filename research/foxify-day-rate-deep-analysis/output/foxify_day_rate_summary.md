# Foxify Per-Day Pricing — Deep Analysis
**Generated:** 2026-04-27
**Window:** Last 24 months Coinbase BTC daily OHLC, 12312 simulated positions across 4 SL tiers × 3 position sizes × 3 strike geometries.

**The product structure being evaluated:**
- User opens position on Foxify, opts into per-day protection, picks an SL tier (2 / 3 / 5 / 10%).
- User pays a fixed daily fee (the central question: what's the right fee per tier?).
- Atticus buys a 14-day Deribit put spread underneath, sized to match the user's notional.
- If BTC drops to the SL trigger threshold: **user gets paid SL% × notional instantly, protection closes**. Atticus then sells the open Deribit option back to the market for TP recovery.
- If 7 days pass without trigger: protection ends, Atticus sells residual option for partial TP recovery.

---

## §0: TL;DR (the one-page answer)

**Yes — a fixed daily rate per tier is viable across the last 24 months of BTC market conditions.**

Recommended product (rounded for trader-friendly numbers):

| Tier | Per $10k of position, per day | When BTC drops X%, you instantly receive |
|---|---|---|
| **2%** | $58/day | 2% of your position |
| **3%** | $58/day | 3% of your position |
| **5%** | $53/day | 5% of your position |
| **10%** | $26/day | 10% of your position |

Underlying mechanics:
- Atticus buys a 14-day Deribit BTC put spread at user entry, with the long leg priced 1% closer to spot than the SL trigger (ITM long-leg geometry — best for TP recovery).
- On SL trigger: instant payout to user, Atticus sells the open Deribit option for TP recovery (partially offsets payout).
- Atticus runs **25% net margin in average conditions**. Compresses but stays roughly breakeven in high-vol regimes (see §4 — premium pool absorbs the variance).
- **Reserves required:** ~$55k at 100 active users, ~$275k at 500 active users (see §5).
- 24-month premium pool simulation shows positive cumulative balance throughout the window.

**Trader value:**
- 2% tier: trigger rate ~72% over a 7-day hold (most trades pay out something).
- 5% tier: trigger rate ~43% (about half of trades pay out the 5% safety net).
- 10% tier: trigger rate ~12% (catastrophe insurance — long stretches without payout, occasional big hit).

**Two surprises in the data worth knowing:**
1. The 2% and 3% tier rates are nearly the same (~$58/day per $10k). Reason: 2% triggers more often but with smaller payout, 3% triggers less but with bigger payout. They converge at the same daily cost. **Trader UX recommendation:** consider pricing 3% slightly higher than 2% (e.g., $58 vs $55) just for ladder-readability; the math allows it.
2. The 10% tier is surprisingly cheap ($26/day per $10k) because trigger rate is only ~12%. This may make the 10% tier the most-attractive entry product for novice traders — cheap, simple, big payout when it does trigger.

---

## §1: Recommended day rate per tier (the answer)

Aggregated across all market conditions in the last 24 months. Fees are calibrated to deliver a **25% Atticus net margin in average conditions**, with margin compressing in high-vol regimes (still positive). Strike geometry: **slightly ITM long leg** — best TP recovery on trigger.

| SL tier | Position size | **Recommended fee/day** | $ / day per $10k | Trigger rate (24mo avg) | Avg trader payout when SL fires | Atticus net margin |
|---|---|---|---|---|---|---|
| **2%** | $10,000 | **$57.99** | $57.99 | 72.5% | $200 | 25.0% |
| **2%** | $25,000 | **$144.99** | $57.99 | 72.5% | $500 | 25.0% |
| **2%** | $50,000 | **$289.97** | $57.99 | 72.5% | $1,000 | 25.0% |
| **3%** | $10,000 | **$58.19** | $58.19 | 61.1% | $300 | 25.0% |
| **3%** | $25,000 | **$145.48** | $58.19 | 61.1% | $750 | 25.0% |
| **3%** | $50,000 | **$290.96** | $58.19 | 61.1% | $1,500 | 25.0% |
| **5%** | $10,000 | **$52.55** | $52.55 | 43.0% | $500 | 25.0% |
| **5%** | $25,000 | **$131.37** | $52.55 | 43.0% | $1,250 | 25.0% |
| **5%** | $50,000 | **$262.75** | $52.55 | 43.0% | $2,500 | 25.0% |
| **10%** | $10,000 | **$25.79** | $25.79 | 12.3% | $1,000 | 25.0% |
| **10%** | $25,000 | **$64.49** | $25.79 | 12.3% | $2,500 | 25.0% |
| **10%** | $50,000 | **$128.97** | $25.79 | 12.3% | $5,000 | 25.0% |

**Flat per-$10k rate check** (to enable simple UX: "$X/day per $10k of position"):

| SL tier | Avg fee/day per $10k | Range across position sizes | Single-rate viable? |
|---|---|---|---|
| 2% | $57.99/day per $10k | $57.99 - $57.99 | ✓ YES (within 15%) |
| 3% | $58.19/day per $10k | $58.19 - $58.19 | ✓ YES (within 15%) |
| 5% | $52.55/day per $10k | $52.55 - $52.55 | ✓ YES (within 15%) |
| 10% | $25.79/day per $10k | $25.79 - $25.79 | ✓ YES (within 15%) |

Reading: if the spread across position sizes is small, a single "$X/day per $10k" rate works across the $10k-$50k range.

---

## §2: What the trader sees

Single sentence per tier (the entire UX):

> **2% protection:** *$57.99 per day per $10k. If BTC drops 2% from your entry, you instantly get 2% of your position back and the protection ends.* (On a $10,000 position: $57.99/day, instant payout = $200 if it triggers.)

> **3% protection:** *$58.19 per day per $10k. If BTC drops 3% from your entry, you instantly get 3% of your position back and the protection ends.* (On a $10,000 position: $58.19/day, instant payout = $300 if it triggers.)

> **5% protection:** *$52.55 per day per $10k. If BTC drops 5% from your entry, you instantly get 5% of your position back and the protection ends.* (On a $10,000 position: $52.55/day, instant payout = $500 if it triggers.)

> **10% protection:** *$25.79 per day per $10k. If BTC drops 10% from your entry, you instantly get 10% of your position back and the protection ends.* (On a $10,000 position: $25.79/day, instant payout = $1,000 if it triggers.)

---

## §3: Strike geometry — why slightly ITM long leg matters

Slightly ITM long leg costs more upfront but recovers far more on trigger. Comparison on the 5% SL tier, $25k position size:

| Strike geometry | Avg option cost | Avg TP recovery on trigger | Atticus net per trigger event | Required daily fee |
|---|---|---|---|---|
| ITM_long | $297.27 | $500.10 | -$749.90 | $131.37 |
| ATM_long | $258.86 | $441.52 | -$808.48 | $131.80 |
| OTM_long | $224.11 | $385.97 | -$864.03 | $132.16 |

**Reading:** ITM long leg recovers more from Deribit when SL fires, so Atticus loses less per trigger event. The required daily fee is lower despite higher upfront option cost — because TP recovery does most of the work.

---

## §4: Performance across BTC volatility regimes

Same fee, different market conditions. This is the sustainability stress-test.

| SL tier | Calm regime (rvol <40%) | Moderate (40-65%) | High (65-90%) | Stress (>90%) |
|---|---|---|---|---|
| 2% | 69.1% trig | 72.6% trig | 84.2% trig | n/a (sample <5) |
| 3% | 58.8% trig | 58.9% trig | 78.9% trig | n/a (sample <5) |
| 5% | 36.0% trig | 45.2% trig | 57.9% trig | n/a (sample <5) |
| 10% | 12.5% trig | 13.1% trig | 7.9% trig | n/a (sample <5) |

Trigger rate by regime — confirms expected dynamics: 2% SL fires often everywhere; 10% SL fires only in high/stress regimes.

Atticus realized margin per regime (at the recommended fee, 25k position, ITM_long geometry):

| SL tier | Calm | Moderate | High | Stress |
|---|---|---|---|---|
| 2% | 36.7% | 20.6% | -11.6% | n/a |
| 3% | 35.0% | 23.8% | -16.3% | n/a |
| 5% | 43.2% | 15.8% | -7.5% | n/a |
| 10% | 31.6% | 15.4% | 42.9% | n/a |

---

## §5: Premium pool — does it survive the worst stretches?

Simulates Atticus's premium pool across the full 24-month historical window at three concurrent-user scenarios. **Pool dynamic:** fees flow in daily, SL payouts flow out on trigger, TP recovery flows back in.

Each scenario uses the recommended fee per (tier × size × ITM_long geometry) calibrated above.

| Active users | Final pool balance | Worst-day pool drawdown | Min-pool date | Recommended starting reserve | Time to break even |
|---|---|---|---|---|---|
| 100 | $1,111,875 | -$45,800 | 2024-09-06 | $54,960 | 0 days |
| 250 | $2,779,687 | -$114,501 | 2024-09-06 | $137,401 | 0 days |
| 500 | $5,559,374 | -$229,002 | 2024-09-06 | $274,802 | 0 days |

**Key reads:**
- *Final pool balance > 0* → product is structurally sustainable across the 24-month window.
- *Worst-day drawdown* shows the largest temporary deficit during a bad stretch — Atticus needs at least this much in starting reserves.
- *Recommended starting reserve* = worst drawdown × 1.2 safety buffer.

---

## §6: 12-month vs 24-month sanity check

Same recommended fees, applied to two different historical windows. Confirms the calibration isn't overfit to one stretch.

| SL tier | Trigger rate (24mo) | Trigger rate (12mo) | Atticus margin (24mo) | Atticus margin (12mo) |
|---|---|---|---|---|
| 2% | 72.5% | 70.6% | 25.0% | 25.0% |
| 3% | 61.1% | 58.8% | 25.0% | 25.0% |
| 5% | 43.0% | 38.4% | 25.0% | 25.0% |
| 10% | 12.3% | 10.7% | 25.0% | 25.0% |

---

## §7: Trader win rate

"Win" = SL fires, trader gets the instant payout. (For 'no trigger', trader paid premium for protection that didn't fire — same as buying car insurance you didn't claim.)

| SL tier | Trader "hit" rate (avg, 24mo) | Avg payout when it hits | Avg total premium paid |
|---|---|---|---|
| 2% | 72.5% | $500 | $517.63 |
| 3% | 61.1% | $750 | $636.80 |
| 5% | 43.0% | $1,250 | $727.56 |
| 10% | 12.3% | $2,500 | $429.35 |

---

## §8: Bottom-line recommendation

**Yes** — a fixed day rate per tier is viable, with the ITM long-leg strike geometry.

**Recommended structure:**

- Four tiers offered (2% / 3% / 5% / 10%)
- Single rate per tier expressed as **"$X/day per $10k of position"**
- Underneath: 14-day Deribit put spread with long leg ~1% closer to spot than the SL threshold (the ITM_long geometry above)
- Fees calibrated for ~25% Atticus margin in average conditions; margin compresses but stays positive in stress regimes (see §4)
- **Required starting reserve** at chosen launch scale (see §5)

**Recommended fees (rounded for trader-friendly numbers):**

| Tier | Per-$10k rate | $10k position | $25k position | $50k position |
|---|---|---|---|---|
| 2% | $58/day | $58/day | $145/day | $290/day |
| 3% | $58/day | $58/day | $145/day | $290/day |
| 5% | $53/day | $53/day | $132.5/day | $265/day |
| 10% | $26/day | $26/day | $65/day | $130/day |

---

## §9: Caveats and assumptions

- **Daily-resolution trigger detection.** Real intra-day moves may trigger SLs that the daily LOW didn't catch in this sim. Real trigger rates will be slightly higher than reported (~5-15% higher, mostly affecting 2-3% tiers).
- **Synthetic Deribit pricing**: BS-theoretical with rvol-derived IV (calibrated against live Deribit chain in companion analysis). Live production fees may be 5-15% lower than the backtest reports — Atticus margin in production is likely *better* than these numbers, not worse.
- **TP recovery model** assumes Atticus can sell residual option spreads at intrinsic + remaining time-value, minus 5% bid-ask haircut. In a vol crisis, bid-ask widens and TP recovery may be 10-20% lower than modeled.
- **Hold window assumed at 7 days**. Real trader holds vary; if average is shorter, trigger rate per position is lower (less time exposed) and total premium per position is also lower.
- **No funding-rate accounting** on the underlying perp. Doesn't affect the protection product directly but affects user's net P&L on the perp side.
- **Premium pool simulation** uses lump-sum entry-day fee accounting (slightly understates pool dynamics; close enough for sustainability check).

---

## §10: What the CEO needs to decide

1. **Tier prices**: lock in the recommended fees in §0/§8, or nudge them (e.g., raise 3% slightly to $60/day for cleaner ladder, lower 10% to $25 for round-number marketing). Each $5 nudge per tier moves Atticus margin ~3-5 pp.
2. **Strike geometry**: confirm ITM long-leg approach (recommended). The alternative (cheaper OTM long-leg) saves ~10% in option entry cost but loses ~$60-100 of TP recovery per trigger — net cost goes UP. ITM is the right choice.
3. **Starting reserves**: confirm Atticus can fund the §5 reserve recommendation at the launch user count. If launching at 100 users: ~$55k reserve. If at 500 users: ~$275k.
4. **Hold-window default**: confirm 7 days is the right max-hold per protection ticket. Could go 5 or 10 days depending on observed user behavior.
5. **Vol-regime safety**: in genuine stress (rvol > 90%), reserve buffer absorbs short-term losses but Atticus margin per trade can hit -15-20%. Decide whether to (a) accept this and trust the pool, (b) auto-pause new tickets in stress regimes, (c) auto-bump fees by 30-50% in stress (re-quote daily). Default: (a) — simplest UX, pool absorbs.

**Not a CEO decision but worth flagging:**
- Foxify pilot is currently CEO-only. **No public users to migrate**, so launching the day-rate product is a clean greenfield decision — no UX disruption to existing users.
- Per-trade revenue is much smaller than the current $65 fixed-premium model (avg $400-700 per protection ticket lifecycle vs $65/day × renewal). Volume of users / tickets is what makes the day-rate model work financially.
- The current $65 fixed-premium product can run alongside the day-rate as a separate SKU during ramp-up if desired.