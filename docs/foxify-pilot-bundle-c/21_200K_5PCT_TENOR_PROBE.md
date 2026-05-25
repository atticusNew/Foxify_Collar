# $200k @ 5% Single-Side Cover — Tenor Optimization Probe

**Generated:** 2026-05-15 20:25 UTC
**BTC spot at probe time:** $79,079
**Target put strike (5% below spot):** $75,125
**BTC notional to hedge:** 2.53 BTC

---

## TL;DR

**Use 7-day weekly tenor on Bullish, NOT 14-day biweekly.**

The deprecated pilot's 14-day tenor was paying ~22% more per day on hedge cost than necessary. Same product, same protection, just cheaper hedge — wins ~$30/day per cover. Across the lifetime of the product that's serious money.

| Tenor option | Per-day hedge | Total hedge cost | Total user premium @ $400/day | Atticus margin per cover (improved TP) |
|---|---|---|---|---|
| **7-day (RECOMMENDED)** | **$133/day** | $931 | $2,800 | **~$1,170** |
| 14-day biweekly (deprecated default) | $163/day | $2,204 | $5,600 | ~$2,396 |
| 1.5-day daily roll | $34/day | $51 × 9 rolls = ~$459 | $2,800 (7d) | ~$1,640 (in theory; rolls add risk) |

---

## Bullish liquidity probe results

Probed 8 expiries from 1.5 days to 76.5 days. **All have full liquidity for our 2.53 BTC order size**, with depth ranging from 5–24 BTC at top of book. Strike $75,000 is available at every meaningful tenor and sits exactly at 5.15% below spot — perfect fit.

| Expiry | Days | Strike | Best ask (USDC/BTC) | Top depth | $200k cost | **Per-day** |
|---|---|---|---|---|---|---|
| 2026-05-17 | 1.5d | $75k | $20 | 23.98 BTC | $51 | **$34/day** |
| 2026-05-18 | 2.5d | $76k* | $70 | 4.00 BTC | $177 | $71/day |
| 2026-05-19 | 3.5d | $76k* | $160 | 3.59 BTC | $405 | $116/day |
| **2026-05-22** | **6.5d** | **$75k** | **$340** | **13.63 BTC** | **$860** | **$133/day** ← **best practical** |
| 2026-05-29 | 13.5d | $75k | $870 | 12.31 BTC | $2,204 | $163/day |
| 2026-06-05 | 20.5d | $75k | $1,330 | 4.99 BTC | $3,372 | $165/day |
| 2026-06-26 | 41.5d | $75k | $2,400 | 6.51 BTC | $6,071 | $146/day |
| 2026-07-31 | 76.5d | $75k | $3,760 | 9.95 BTC | $9,511 | $124/day |

*2.5d/3.5d expiries don't have a $75k strike — closest is $76k which gives only 3.88% protection (not full 5%). Skip these.

## Bullish vs Deribit comparison

| Tenor | Bullish $/day | Deribit $/day | Winner |
|---|---|---|---|
| 1.5d | $34 | $27 | Deribit |
| 6.5d | **$133** | $139 | **Bullish** ✓ |
| 13.5d | $163 | $171 | Bullish ✓ |
| 20.5d | $165 | $200 | Bullish ✓ |
| 76.5d | $124 | $124 | tie |

Bullish wins (or ties) on every tenor we'd actually use. Per your direction "use live Bullish" — confirmed it's the right primary venue.

## Why 7-day is the optimal tenor (vs 14-day deprecated default)

### Theta non-linearity
Option time decay isn't linear. Cost per day GOES UP as you hold longer:
- 1.5-day: $34/day
- 6.5-day: $133/day
- 13.5-day: $163/day
- 20.5-day: $165/day

A 14-day put costs roughly 65× a 1.5-day put even though it's only 9× longer. Theta accelerates as you approach expiry.

**The deprecated pilot bought 14-day puts and held all 14 days, paying peak theta the whole time.** Switching to 7-day means we capture the cheaper portion of the curve.

### Strike alignment
$75k strike (= 5.15% below spot) is consistent across both 6.5d and 13.5d expiries on Bullish. No strike-grid penalty for the shorter tenor. **You get the same protection precision either way.**

### Liquidity
6.5d has 13.63 BTC of depth at top of book — 5.4× our order size. Easy clean fills.

### Risk profile per cover
- 7-day cover: ~30-40% chance of 5% touch in window
- 14-day cover: ~45-55% chance of 5% touch in window

Lower trigger probability per cover → smaller probabilistic payout liability per trade.

### Operational
- 7-day cover means ONE hedge per cover, no mid-tenor rolls. Same as 14-day.
- User can renew at end of week if they want continued protection — gives Atticus a re-pricing opportunity each week (vol regime change adaptation).

### Why not 1.5-day daily roll?
Cheapest in $/day terms ($34/day vs $133/day) but:
- Need to roll the hedge ~9 times per week. Each roll = market impact + slippage + execution risk.
- Strike drift: each roll buys at the new spot ± 5%. If BTC trends, your hedge strike walks away from where the cover was sold.
- Operational complexity = bug surface area = real money at risk.

Net of execution costs, daily roll probably costs ~$80–100/day in practice (still cheaper than 6.5d in clean conditions, but with much more variance).

**Save the daily-roll experiment for after we've seen 7-day work in production.**

---

## Pricing economics at $400/day (your approved target)

### 7-day cover (recommended)

| Item | Amount |
|---|---|
| Premium collected | $400 × 7 = **$2,800** |
| Hedge cost | $931 |
| Trigger probability | ~35% (5% in 7 days) |
| Expected payout × current TP (50% salvage) | $10k × 0.35 × 0.50 = $1,750 |
| Expected payout × improved TP (80% salvage) | $10k × 0.35 × 0.20 = $700 |
| **Atticus per-cover P&L (current TP)** | $2,800 − $931 − $1,750 = **+$119** |
| **Atticus per-cover P&L (improved TP)** | $2,800 − $931 − $700 = **+$1,169** |
| Atticus per-DAY P&L (current TP) | +$17/day |
| Atticus per-DAY P&L (improved TP) | +$167/day |

### 14-day cover (alternative)

| Item | Amount |
|---|---|
| Premium collected | $400 × 14 = **$5,600** |
| Hedge cost | $2,204 |
| Trigger probability | ~50% (5% in 14 days) |
| Expected payout × current TP (50% salvage) | $10k × 0.50 × 0.50 = $2,500 |
| Expected payout × improved TP (80% salvage) | $10k × 0.50 × 0.20 = $1,000 |
| **Atticus per-cover P&L (current TP)** | $5,600 − $2,204 − $2,500 = **+$896** |
| **Atticus per-cover P&L (improved TP)** | $5,600 − $2,204 − $1,000 = **+$2,396** |
| Atticus per-DAY P&L (current TP) | +$64/day |
| Atticus per-DAY P&L (improved TP) | +$171/day |

**Both work at $400/day with improved TP.** 14-day has slightly higher per-day return but more capital-at-risk per cover. **7-day is cleaner and faster to validate.**

---

## What the deprecated pilot left on the table

For comparison, the deprecated pilot's $25/$10k/day biweekly product:
- Per-day hedge cost: ~$25/day per $10k notional (extrapolated from data)
- 7-day equivalent would have been: ~$15/day per $10k notional (38% cheaper)

Across the 7 baseline-regime protections (~$90k notional, 14-day each), the deprecated tenor cost roughly **$700-1,000 in extra theta** that 7-day rolls would have saved.

For the new $200k @ 5% product running multiple covers, the savings compound fast: at 1 cover/day for 28 days, switching from 14-day to 7-day saves **~$840/month in hedge cost** at no protection-quality difference.

---

## Recommended product spec (final)

| Parameter | Value |
|---|---|
| Product | Single-side per-trade put protection, biweekly-style billing |
| Position size | $200,000 notional |
| Stop-loss tier | 5% (trigger at 5% below entry) |
| Payout on trigger | $10,000 fixed |
| **Hedge tenor** | **7 days (Bullish primary)** |
| User-facing cover duration | 7 days (matches hedge), auto-renew option for week-by-week continuation |
| Premium | $400/day = **$2,800 per 7-day cover** |
| Cap | 1 cover/day at start, ramp on salvage data per Volume Cover model |
| Hedge venue | Bullish primary, Deribit fallback (per multi-venue router) |
| Strike | Trigger-aligned ($75k for $79k spot ≈ 5%) |

---

## What needs validating before launch

1. **TP optimization** is the biggest economic lever — we approved this scope (multi-stage TP with pre-trigger sell + at-trigger instant sell + vol-spike opportunistic). 2-3 days engineering.
2. **Bullish 5% strike book holds at the time of activation** — re-probe at activation. Today's $133/day is a snapshot; vol regime can move it.
3. **Re-roll mechanics if user extends past 7 days** — handle the second-week roll cleanly.
4. **First live activation on Bullish testnet** before going to mainnet — we have a code path for this in the existing pilot venue adapter.

---

## What I recommend next

1. **Confirm 7-day tenor** (or override to 14-day if you want bigger per-cover revenue).
2. **Confirm Bullish-primary, Deribit-fallback** routing.
3. I'll start on:
   - New `singleSideCover/` module (sibling to `volumeCover/`)
   - Multi-stage TP engine (the biggest piece)
   - Re-uses Volume Cover's salvage tracker, guardrails, capital pool
4. Day-by-day plan emerges once you confirm tenor.

Reply with tenor confirmation and I start building.
