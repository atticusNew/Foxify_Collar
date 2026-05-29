# Fixed-Price Analysis — $300 Premium / $1k Payout / 50k/2%

---

## The bottom line

The fixed-price structure is achievable in principle. The **$300/day premium specifically** is very difficult to sustain at the proposed $1k payout level. Making it work at that price point requires substantial Atticus working capital (~$500k) and several months of additional engineering.

This document explains why the $300 number specifically is hard, what would need to change for it to work, and what's available today.

---

## How the fixed-price math has to work

Foxify pays Atticus a daily premium. Atticus uses some of that to buy a small hedge. When BTC moves past ±2%, Atticus pays Foxify a fixed $1,000.

For Atticus to be profitable on average:

```
premium_collected_per_pair  >  (trigger_probability × $1,000)  +  hedge_cost  +  small_margin
```

That equation has to hold across all market regimes for the business to sustain.

---

## Three factors that make $300 specifically very hard

### 1. Premium doesn't accumulate when positions close quickly

In the current pass-through lifecycle (and likely in the fixed-price version too), Foxify's bot closes positions when its perp position triggers. In active markets, that's within hours — not days.

| Scenario | Premium collected | Atticus payout obligation | Atticus net per pair |
|---|---:|---:|---:|
| BTC moves 2% in 4 hours, Foxify closes | $300 × 4/24 = $50 | $1,000 | **−$950** |
| BTC moves 2% in 1 day, Foxify closes | $300 | $1,000 | **−$700** |
| BTC stays flat 3 days, no trigger | $900 | $0 | **+$810** |

The math only works if positions are held for several days WITHOUT triggering. In active markets — exactly when Foxify wants the protection — positions close fast and premium doesn't have time to build.

### 2. Higher volatility (stress regimes) makes it worse, not better

In stress regimes (DVOL >80, what crypto sees during news events):
- BTC moves 2% in **minutes**, not hours
- Foxify might open, close, reopen the position 10+ times per day
- Each close-reopen cycle is potentially another $1,000 payout owed by Atticus

A single stress day per concurrent Foxify position:
- 10 trigger cycles × $1,000 payout = **$10,000 of potential Atticus liability**
- Premium collected across those cycles (each ~1 hour hold): ~$125

Stress is exactly when Foxify needs the protection most. It's also when Atticus's loss curve is steepest. The model's worst environment is its most-needed environment.

### 3. The hedge alone can't bridge the gap

At $300/day premium, the hedge budget is limited. A small hedge ($50-100) might pay out $150-250 when triggered. That's nowhere close to the $1,000 obligation.

To fully cover a $1,000 payout, the hedge needs to cost ~$450-500. The premium has to cover that hedge cost plus the expected payout cost plus margin. Math points to ~$500/day minimum at the $1,000 payout level — not $300.

---

## Rapid close + reopen makes this harder still

Foxify's intended behavior includes rapid close-and-reopen cycles in active markets. With pass-through, each cycle is self-contained. With fixed-price, each cycle is another potential $1k Atticus payout from working capital.

Across 25 Foxify positions running concurrently during a stress day:
- 25 positions × 5-10 cycles each × $1,000 payout per trigger
- Potential single-day Atticus liability: **$125,000 to $250,000**
- Premium collected to offset: a small fraction of that

This is the load profile fixed-price faces. Without significant capital cushion, the model can't survive a few bad days.

---

## The asymmetry of fixed-price economics

In any given pair, fixed-price creates this dynamic:

| Outcome | Foxify net | Atticus net |
|---|---:|---:|
| BTC moves 2% (trigger fires) | **+$700** ($1,000 − $300 premium) | **−$650** (paid $1,000 − $300 premium − $50 hedge salvage + $100 hedge cost) |
| BTC stays flat | **−$300** | **+$200** (kept premium − hedge cost) |

Atticus profits when Foxify "loses" (BTC doesn't move). Atticus loses when Foxify "wins" (trigger fires). Long-term sustainability requires Foxify to lose most of the time — which is exactly the experience Foxify wants to avoid.

---

## What would make the $300 number work

Two paths, both with real constraints:

### Path A — Foxify holds positions longer

If Foxify's bot held positions for 3+ days regardless of triggers (a behavioral change):
- 3 × $300 = $900 premium collected per pair
- ~80% × $1,000 payout = $800 expected payout cost
- ~$90 hedge cost
- **Atticus net: ~+$10/pair** (borderline viable)

This requires Foxify to change its bot behavior. Atticus can't enforce this on Foxify's side.

### Path B — Atticus capital + premium uplift

With $500,000+ Atticus working capital and a premium uplift to $500/day:
- Capital cushion absorbs stress-day losses across many concurrent pairs
- Premium ($500/day) covers hedge cost + expected payout + small margin
- **Atticus net: ~+$50-100/pair on average across regimes**

This is the real fixed-price solution. The cost: Atticus needs to raise $500k+, then engineer daily-premium billing, real-time pricing, treasury management for payout obligations, and stress-test reserves. **Realistic timeline: 6-9 months before Foxify could activate at $500/day.**

---

## What capital actually enables

| With $500k+ Atticus float | Without it |
|---|---|
| Absorbs stress-regime losses across multiple pairs | One bad day risks the business |
| Premium can be calibrated tight ($400-500/day) | Premium has to be conservatively high or model fails |
| Pre-funds $1k payouts instantly | Payouts queue, settlement delays grow |
| Survives a few bad weeks of average-out | Bad streak ends the program |
| Supports 100+ concurrent fixed-price pairs | Limits to 10-20 concurrent maximum |

The capital is what unlocks fixed-price at the price level Foxify wants. Atticus doesn't have it today. Raising it is a 3-6 month outreach + diligence + deployment process.

---

## What's available today: pass-through

Pass-through is built and live. Foxify and Atticus economics are aligned — both gain on real BTC moves, both bear cost on flat markets. No Atticus capital pool required.

Important distinction: pass-through doesn't promise a fixed $1k payout. But:

- **Foxify often nets MORE than $1k on real triggers.** A 5% BTC move with a 5%-trigger cell ($480 cost) typically pays back $1,400-2,800 from the actual options market. Better than the $1k fixed-price cap.
- **Foxify's max loss per pair is bounded** at what they paid for protection. Same as fixed-price.
- **The activation signal keeps Foxify out of unfavorable timing windows.** Filters away the loss-prone calm scenarios that would hit either model.

---

## Recommendation

Two tracks, not mutually exclusive:

1. **Start with pass-through today.** It's built, live, capital-efficient, ready to integrate within 1-2 weeks. Validates the volume-center concept with real data.

2. **In parallel, decide if fixed-price at $300/day is worth a 6-9 month project.** Would require a $500k+ capital raise plus billing/pricing/treasury engineering. If Foxify CEO wants this, Atticus can scope it as a separate Phase 2 initiative. But it's a months-long undertaking, not weeks.

The pass-through path delivers Foxify volume immediately. Fixed-price at $300 is a longer-term option that needs significant capital and engineering before it can launch.

---

*Generated 2026-05-28 by Atticus engineering. Numbers from V6 simulation engine + live venue data.*
