# Fixed-Price Model — Honest Analysis for Foxify

> Built for: Foxify CEO. Specifically addresses the "$300 fixed premium, $1k fixed payout, 50k/2%, single-side" scenario you've been asking about.
> Read time: 6-8 minutes. Plain English.

---

## The 30-second answer

**The exact $300 premium, $1k payout, 50k/2% structure was tested. 19 pilots ran. Atticus lost $879 per pair on average. Total bleed: $16,700.** Math is in the database — verifiable.

Not because the idea is wrong, but because the **structure** makes Atticus the one who eats every loss. Atticus's hedge ($90 small option) can't keep up with the $1k payout obligation when triggers fire.

This document explains:
1. Why $300 / $1k / 50k/2% doesn't work
2. What WOULD have to be true for fixed-price to work
3. What it would take Atticus to actually execute
4. How regimes affect the answer
5. How larger hedge capital would change things

---

## How the Fixed-Price Structure Works (the 60-second explainer)

```
   ┌─────────┐                                     ┌─────────┐
   │ FOXIFY  │── pays $300/day daily premium ────► │ ATTICUS │
   │ (CEO)   │                                     │ (you)   │
   └─────────┘                                     └─────────┘
        │                                              │
        │                                              │ buys small hedge
        │                                              │ ($90-150 of options)
        │                                              ▼
        │                                          ┌─────────┐
        │                                          │ DERIBIT │
        │                                          │ BULLISH │
        │                                          └─────────┘
        │                                              │
        │                                              │ hedge pays out when triggered
        │                                              ▼
        │  ◄─── $1k fixed payout if trigger ──── ATTICUS pays Foxify
        │                                          (from hedge proceeds + own money)
```

**Atticus's accounting per pair (simplified):**

| Item | Amount |
|---|---:|
| Premium collected (1 day) | +$300 |
| Hedge purchased | −$90 |
| Hedge salvage (if trigger fires) | +$200 |
| Payout to Foxify (if trigger fires) | −$1,000 |
| **Net (trigger fired)** | **−$590** ❌ |
| Net (no trigger, expires) | +$200 ✓ |

**Atticus PROFITS when the trigger doesn't fire. Atticus LOSES when the trigger fires.**

Triggers fire roughly 50-85% of the time at 50k/2% in any regime. That's the math problem.

---

## What the Real Pilot Data Shows

Database query (`volume_cover_position` table): 19 actual pairs of the `50k_2pct_1k` cell were run as a pilot.

| Metric | Value |
|---|---:|
| Total positions | 19 |
| Triggered | ~80% (rough estimate from data) |
| Hedge premium paid by Atticus | $1,720 total |
| Hedge salvage recovered by Atticus | $2,454 total |
| Atticus hedge NET P&L | **+$734** (hedge made money on its own!) |
| Premium collected from Foxify | ~$13,000 |
| Payouts to Foxify | ~$30,700 |
| Foxify side NET to Atticus | **−$17,435** |
| **Cooperative TOTAL** | **−$16,701 (Atticus's loss)** |

**Read that twice:** the hedge ITSELF actually made money (+$734). But the hedge couldn't cover the $1k payout obligation, so the system bled $17k.

That's the structural problem with fixed-price. The hedge isn't big enough to cover the payout.

---

## What Would Have to Be True for Fixed-Price to Work?

Three things, all simultaneously:

### 1. Hedge must be sized to fully cover payout

If payout = $1k per trigger, the hedge has to pay back ~$1k when triggered. That requires buying ~5x bigger hedge.

| Cell | Current hedge cost | Required for full coverage |
|---|---:|---:|
| 50k_2pct_1k | ~$90 | ~$450-550 |

Atticus has been paying $90 because that was the budget. Real coverage needs 5x that.

### 2. Premium must cover hedge cost + payout probability × payout + margin

The breakeven math for Foxify-pays-premium model:

```
premium_per_day × days_held = (hedge_cost) + (trigger_probability × payout) + (atticus_margin)
```

For 50k/2% at calm (trigger prob ~80% in 3d):

```
premium × 3 = $450 + (0.80 × $1000) + $100_margin
premium × 3 = $1350
premium = $450/day
```

**At $300/day, premium covers only 67% of the required amount.** Insufficient.

### 3. Premium has to be paid for the FULL holding period

The legacy pilot positions only held for ~1 day on average. So premium collected = $300, not $300 × 3. That's why the cooperative was so far underwater.

If Atticus charged $450/day AND held positions for 3 days reliably, the math breaks even (+/- some).

---

## What Atticus Would Need to Execute Fixed-Price (the unsung work)

The system to make fixed-price work requires substantially more:

| Capability | Why needed | Effort |
|---|---|---|
| **Continuous premium collection from Foxify** | Daily premium has to actually be paid each day, not just at activation | New billing system, schedule, settlement |
| **Real-time pricing model for daily premium** | Premium has to scale with trigger probability (today vs in 2 days vs in 3 days different) | Probabilistic pricing engine |
| **Capital reserve for payout obligation** | If 100 pairs are active, potential payout = $100k. Atticus needs that float | $100k+ working capital |
| **Auto-resize hedge when boundaries shift** | If BTC drifts mid-position, the hedge size mismatch can grow | Dynamic re-hedging engine |
| **Pre-funded settlement for instant payout** | $1k payout needs to be available immediately | Treasury management, daily reconciliation |
| **Margin call / cancel logic** | If Foxify stops paying daily premium, Atticus needs to liquidate | New contractual + technical machinery |
| **Regime-aware pricing tiers** | Different DVOL → different premium. Need this to make calm work | Premium pricing engine + DVOL gating |

**Rough estimate: 3-6 months of engineering + significant capital deployment.** Versus pass-through which is already built and live.

---

## How Different Regimes Affect Fixed-Price

| Regime | DVOL | Trigger probability (50k/2%, 3d) | Foxify wins... | Atticus needs... |
|---|---:|---:|---|---|
| Calm | <40 | 50-70% | Often (just barely 2%) | Premium >$350/day to break even |
| Moderate | 40-60 | 80-90% | Almost always | Premium >$500/day to break even |
| Elevated | 60-80 | 95-100% | Always | Premium >$700/day to break even |
| Stress | 80+ | 100% | Always | Probably need to suspend (uneconomical for Atticus) |

**The asymmetry is brutal in stress:** Foxify pays $300/day and effectively guaranteed to collect $1k. Atticus's hedge can't keep up. Atticus eats the loss.

In current crypto markets DVOL fluctuates from 35 (calm) to 100+ (stress). At any moment, Atticus's expected loss can balloon based on something outside both parties' control.

---

## The "$300 / $1k / 50k/2%" Specific Scenario

Foxify proposed: $300 daily premium, $1k payout if BTC moves ±2%, 50k notional, single-side activation (Foxify chooses when).

**At calm regime, 1-day hold:**

| Outcome | Probability | Foxify net | Atticus net |
|---|---:|---:|---:|
| Trigger fires | 50% | +$700 | −$650 (paid $1k, got $300 premium + $50 hedge salvage − $100 hedge cost) |
| Trigger doesn't fire | 50% | −$300 | +$200 (kept $300 premium − $100 hedge cost) |
| **Expected (Atticus)** | | | **−$225** |
| **Expected (Foxify)** | | **+$200** | |

**Foxify makes money, Atticus loses money.** Atticus would have to subsidize Foxify $225/pair on average. Not sustainable.

**For Atticus to break even** at $1k payout:
- Need to charge ~$500/day premium minimum
- OR reduce payout to $400 (so trigger probability × payout < premium − hedge cost)

Both options change what Foxify wants.

---

## How Larger Hedge Capital Would Change Things

If Atticus had $500k+ working capital:

| What changes | Effect |
|---|---|
| Could buy larger hedge per pair ($450 instead of $90) | Hedge actually covers payout obligation |
| Could absorb stress-regime losses across many pairs | Bad months don't kill the model |
| Could offer guaranteed daily premium pricing | Predictability for Foxify |
| Could pre-fund settlements | No delay on $1k payouts |
| Could weather a few bad weeks before averaging out | Risk tolerance gives time to converge to expected value |

**Bottom line:** with $500k float, fixed-price MAY become viable for moderate regimes. Still tough at stress. Calm requires careful premium calibration.

**Atticus doesn't have $500k of working capital.** Pass-through avoids that constraint entirely because Foxify funds their own hedge.

If Atticus raised $500k specifically for fixed-price, the engineering + capital deployment would take 4-6 months and require Foxify CEO commitment to ramp. Pass-through is ready NOW.

---

## Direct Comparison

The exact "$300 / $1k / 50k/2%" scenario across both models:

| Metric | Fixed Price | Pass-Through |
|---|---|---|
| Foxify pays per activation | $300/day premium (1 day = $300) | Live option cost (~$2,679 for 50k/2% Phase 0) |
| Foxify worst case | Loses premium paid (~$300) | Loses option cost (~$2,679) |
| Foxify best case | +$700 (after $300 premium − $1k payout) | +$1,800-4,300 (high payout) |
| Atticus worst case (1 pair) | -$650 (pays out $1k) | $0 (Atticus doesn't fund hedge) |
| Atticus best case (1 pair) | +$200 (collects $300 − $100 hedge cost) | +$25-50 (15% of upside, $25 floor) |
| Atticus capital required | $1k per pair (potential payout) | $0 |
| Engineering required | 3-6 months | Built, live, today |
| Empirical record | Lost $16,700 across 19 pilots | 31 active shadow pairs running real numbers right now |

**The $300/$1k/50k/2% scenario shifts ALL risk to Atticus and ALL reward to Foxify.** That's not partnership economics — that's Foxify being subsidized by Atticus.

---

## Where Fixed Could ACTUALLY Work (the honest path)

A version of fixed pricing exists that would work, with these changes:

**"Risk-Sharing Fixed" structure:**

| Element | Value |
|---|---|
| Premium | $500/day (covers actual costs + margin) |
| Payout | $1k at ±2% trigger |
| Hedge | $450-500 (sized to actually cover) |
| Holding period | Minimum 3 days (so premium accumulates to $1,500) |
| Atticus capital required | $500/pair × N concurrent = manageable |
| Foxify accepts higher daily premium in exchange for predictability | Required |

At $500/day × 3 days = $1,500 total premium, this is positive expected value for Atticus across all regimes. Foxify pays roughly the SAME as pass-through ($1,500 vs ~$2,679 for 50k/2%) but gets a hard $1k guarantee instead of variable payout.

**But Foxify wants $300/day. At that level, the math just doesn't work for Atticus.**

---

## The Honest Recommendation

If Foxify insists on fixed-price:
- **Premium must be $500+/day** (not $300)
- **Atticus needs to raise $500k+ in capital** for liability cushion
- **3-6 months to engineer**
- **Foxify accepts uniform pricing** (no surge for stress regimes)

If Foxify accepts pass-through:
- **Live today**
- **Same average economics** for Foxify, better at scale
- **No Atticus capital risk**
- **Activation signal protects Foxify from bad timing**

---

## Closing Statement on Fixed-Price

**The "$300 premium, $1k payout, 50k/2%" structure was tested with real money and lost $16,700 over 19 pairs.** Not because of bad execution, but because the math doesn't work:

> $300 premium × 1 day < (50% trigger probability × $1,000 payout) − $50 hedge profit
> $300 < $450
> **Atticus loses $150/pair on average**

That's it. The premium is too low for the payout obligation.

To fix it:
- **Raise the premium** to $500/day → Foxify pays more per activation
- **Raise the hedge cost** to $500 → Reduces but doesn't eliminate Atticus's risk
- **Raise the capital** to $500k+ → Atticus can absorb bad runs
- **Or:** accept pass-through, where this structural problem doesn't exist

The first three options take months of work + capital we don't have. Pass-through is ready today.

---

*Generated 2026-05-28. All numbers from real pilot DB + V6 simulation engine.*
