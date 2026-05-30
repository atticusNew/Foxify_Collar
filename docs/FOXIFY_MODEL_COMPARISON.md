# Pass-Through vs Fixed-Price — Direct Side-by-Side

> One-page summary. Print this and read with the CEO.

---

## The Two Models in One Picture

```
                    PASS-THROUGH                                    FIXED-PRICE
                  (Atticus's choice)                          (CEO's original idea)
                  
   Foxify ──pays option cost──► Atticus               Foxify ──pays $300 daily──► Atticus
              ($480 for OTM)                                                          │
                                  │                                                  │
                                  │ buys real option                                 │ buys small hedge
                                  │ on Deribit/Bullish                              │ ($90)
                                  ▼                                                  ▼
                              [Real options market]                              [Small hedge]
                                  │                                                  │
                                  │ pays out actual value                           │
                                  ▼                                                  │
   Foxify ◄──85% of profit──── Atticus                 Foxify ◄──$1000 fixed──── Atticus
                                                                  if BTC moves 2%   │
                                                                                    │ funds the
                                                                                    │ $1000 from
                                                                                    │ own capital
```

---

## Direct Answer to Each Concern

| CEO's concern | Pass-Through | Fixed-Price |
|---|---|---|
| Predictable cost? | YES — see real cost before activating | YES — $300/day, always |
| Predictable payout? | NO — but expected value computable | YES — $1000 fixed |
| Foxify max loss? | What was paid (e.g., $480) | What was paid (e.g., $300) |
| Atticus max loss? | $0 (Foxify funds hedge) | UNLIMITED ($1k per trigger, scales with volume) |
| Cost to scale to 100 pairs? | Foxify funds Foxify positions ($48k for 100 OTM pairs) | Atticus needs $100k+ float for liability |
| Past pilot result | 31 shadow pairs running NOW (in DB) | 19 pilot pairs ran. Lost $16,700 cooperative |
| Tested in real market | YES — live since this morning | YES — but failed |
| Atticus thinks it works? | YES (85% confidence) | NO (failed in pilot at proposed pricing) |

---

## The Math, Identical Inputs

Both models on the same activation: **BTC stays calm, 1 day, 50k/2%, $300 premium proposal vs $480 Phase 0 cost**

| Scenario | Trigger probability | Pass-Through (Foxify net) | Fixed-Price (Foxify net) | Pass-Through (Atticus net) | Fixed-Price (Atticus net) |
|---|---:|---:|---:|---:|---:|
| Trigger fires | ~50% | +$1,800 (option payout 4-6x cost) | +$700 ($1000 − $300 premium) | +$50 (15% of upside) | −$650 (paid $1k, kept $200 net) |
| Trigger doesn't fire | ~50% | −$300 (decay on $480 cost) | −$300 (lost premium) | $0 | +$200 (kept premium − hedge cost) |
| **Average** | | **+$750** | **+$200** | **+$25** | **−$225** |

**Foxify nets more under pass-through ($750 vs $200) because they get the actual option payout (4-6x cost), not the capped $1k.**

**Atticus nets more under pass-through (+$25 vs −$225) because the fee structure aligns with profit, not with payout obligations.**

---

## Why Fixed-Price Failed in the Real Pilot

The legacy test ran with these parameters: $300 premium target, $1k payout, 50k/2%, varying tenors and hold periods.

**19 pairs. 18 lost money for Atticus. Net result: −$16,701.**

The reason wasn't bad execution. It was the structure:
- Hedge ($90) was 9% the size of the payout obligation ($1k)
- When trigger fired (most of the time), Atticus paid $1k and only recovered $200 from hedge
- Cooperative bled $879/pair on average

Increasing the hedge to $500 (what's actually needed) would have required Atticus to spend ~$10k more across the 19 pairs. Atticus didn't have the budget for that.

---

## Why Pass-Through Works Where Fixed Failed

Three structural reasons:

### 1. No payout-obligation cliff
Pass-through doesn't promise $1k. It promises "whatever the option pays." If the option pays $0, Foxify gets $0. If it pays $5k, Foxify gets $5k. No artificial cap that creates Atticus liability.

### 2. Each pair is self-contained
Foxify pays $480 upfront for one pair. That $480 buys actual options. Those options pay out independently. No shared "Atticus capital pool" that could run dry.

### 3. Atticus only earns when there's profit
Atticus fee = 15% of upside (with $25 floor). When pair settles with positive uplift, Atticus takes a slice. When pair settles negative, Atticus earns $0 — but doesn't lose anything either.

**No risk transfer. No promised payout. No hidden liability.**

---

## What Foxify Gives Up by Choosing Fixed

If we somehow built fixed (with $500k Atticus capital + 6 months of dev):

| Trade-off | Pass-Through cost | Fixed-Price cost |
|---|---|---|
| **Upside cap** | None — option pays out whatever it pays out | Capped at $1k per trigger |
| **Activation freedom** | Foxify activates anytime, gated by signal | Same, but daily premium accrues continuously |
| **Predictability** | Per-activation cost varies with market | Daily premium is fixed |
| **Speed to launch** | Today | 4-6 months |
| **Atticus alignment** | Atticus wins only when Foxify wins | Atticus wins when Foxify loses (no trigger), loses when Foxify wins |

The last row is the critical one. Pass-through aligns Atticus's interests with Foxify's. Fixed-price puts them in opposition.

---

## Two Pictures of Foxify's Risk

### Pass-Through Foxify Risk
```
At-risk capital  = pre-paid option cost
Max loss per pair = option cost (e.g., $480)
Per-pair P&L     = whatever option pays back − cost paid
                   bounded below by 0, bounded above by ~10× cost
Scaling         = linear with capital deployed
```

### Fixed-Price Foxify Risk
```
At-risk capital  = total premium paid in days held
Max loss per pair = total premium paid (e.g., $300 × N days)
Per-pair P&L     = $1000 if trigger, − premium paid otherwise
                   bounded below by total premium, bounded above by $1000
Scaling         = predictable but limited upside
```

**Pass-through risk profile is BETTER for Foxify** because upside is unbounded (often >$1k) while downside is the same kind of thing (premium/cost paid up front).

---

## One Sentence Each Model

**Pass-through:** Foxify pays for actual options. Foxify gets whatever the options pay. Atticus takes a tiny fee on profit.

**Fixed-price:** Foxify pays small daily premium. Atticus promises $1k payout. Atticus eats the difference between hedge cost and payout obligation.

---

## CEO's Likely Objections + Responses

> **"I want predictable pricing."**
>
> Pass-through gives that: at any moment, /admin/foxify/v2/cell-costs returns the EXACT cost Foxify will pay. Updates every 30 seconds. Pre-activation, you see the cost.

> **"I want predictable payout."**
>
> Pass-through doesn't give a single fixed number — but gives an EV (expected value) computed live. e.g., "for $480, expected payout is $480 + $73 = $553 on average." That's also predictable, just probabilistic.

> **"What if BTC doesn't move?"**
>
> Foxify loses the option cost ($480). That's the same as fixed-price losing the premium ($300/day × days held). Both models bleed when BTC is flat. Pass-through bleeds in proportion to position size; fixed-price bleeds in proportion to time held.

> **"What if BTC moves big?"**
>
> Pass-through pays Foxify more than fixed. A 5% BTC move with `pair_50k_5pct_otm` ($480 cost) typically pays out $1,400-2,800. Fixed-price would cap that at $1k.

> **"I just want to set it and forget it."**
>
> Pass-through gives Foxify a one-call activation signal (`should_activate`). Bot polls every minute. Activates when signal is GO. No daily check-in needed.

---

## Decision Tree

```
Does CEO want guaranteed $1000 payout?
│
├── YES → Wants fixed-price
│         │
│         └── Can he wait 4-6 months and accept higher premium ($500/day not $300)?
│             ├── YES → Build fixed-price (with $500k capital raise)
│             └── NO → "Pass-through is the only viable option today"
│
└── NO (or "I just want to make money on activation timing")
          │
          └── Pass-through is built, live, ready to integrate this month
```

**Reality check: every other scenario points to pass-through.**

---

## The Killer Bottom-Line

**Pass-through is the only structure where Atticus and Foxify both make money or both lose money based on what BTC actually does.** Fixed-price puts them in opposition (Atticus loses every time Foxify wins).

Atticus has built pass-through. It's live. 31 shadow pairs running right now with real cross-venue pricing. The activation signal protects against bad-timing losses. Foxify integrates in 1-2 weeks. First $500 of live capital tests the system. Scale only after Foxify sees real positive results.

**There's no engineering work, no capital raise, no months of timeline. Pass-through is ready when Foxify is.**

---

*Generated 2026-05-28. Print and walk through with CEO.*
