# Premium Negotiation — Trader-Side vs Platform-Side Trade-off

> **Trigger for this doc:** founder feedback 2026-05-10 that $425/side
> ($850/pair/day) is too high for Foxify to accept. Retail comparable is
> ~25 bps/$10k notional/day = $125/side equivalent.
> **Goal:** lay out the full trader-vs-platform trade-off so the right
> tier can be picked at negotiation time.

---

## 1. The math the trader actually cares about

For Foxify, the headline pricing isn't "$X/side/day" — it's **net cost of insurance per day after trigger payouts received**, expressed as bps on the protected notional.

For each pair (LONG $50k + SHORT $50k = $100k aggregate notional):

```
trader_net_cost_per_pair_life   = premium_paid - payouts_received
trader_net_cost_per_day         = trader_net_cost_per_pair_life / 7
trader_net_cost_in_bps          = trader_net_cost_per_day / $100,000 × 10,000
trader_implied_APR              = trader_net_cost_in_bps × 365 / 100
```

Note: `premium_paid` includes BOTH the morning premium and all the
intra-day pro-rated re-open premiums, per the V3 model. `payouts_received`
is gross trigger payouts at $1,000 each.

---

## 2. Premium ladder options compared (V3 corrected economics)

Empirical data: 2,328 pair-life samples across 6.4-year tape, daily
strangle hedge, with intra-day re-open + pro-rated premium.

### 2.1 OPTION V3-A — $425 / $600 / $900 / $1,100 per side (V2.1 recommendation)

| Band | Rate $/side | Platform PnL/pair-life | Trader net cost/pair-life | Trader $/day | bps/day | APR |
|---|---|---|---|---|---|---|
| Calm | $425 | **+$3,247** | +$3,500 | $500 | 50.0 | 182% |
| Mod | $600 | +$4,990 | +$5,611 | $802 | 80.2 | 293% |
| Elev | $900 | +$8,568 | +$10,023 | $1,432 | 143.2 | 523% |
| Stress | $1,100 | +$8,040 | +$10,717 | $1,531 | 153.1 | 559% |
| **Blended** | — | **+$5,571** | — | — | — | — |

**Trader's view:** pays a 50-153 bps/day insurance cost for capped protection. **This is what Foxify pushed back on.** Headline insurance cost equates to 180-560% APR on protected notional — too rich for a routine running cost.

### 2.2 OPTION B — $300 / $450 / $650 / $900 per side (moderate cut)

| Band | Rate $/side | Platform PnL/pair-life | Trader net cost/pair-life | Trader $/day | bps/day | APR |
|---|---|---|---|---|---|---|
| Calm | $300 | **+$1,100** | +$1,353 | $193 | 19.3 | 71% |
| Mod | $450 | +$2,038 | +$2,659 | $380 | 38.0 | 139% |
| Elev | $650 | +$3,255 | +$4,710 | $673 | 67.3 | 246% |
| Stress | $900 | +$3,885 | +$6,561 | $937 | 93.7 | 342% |
| **Blended** | — | **+$2,288** | — | — | — | — |

**Trader's view:** ~70-340% implied APR. Still meaningful but tightly bounded — calm regime (most common) is now under 25 bps/day net cost. Probably acceptable to Foxify if they value the operational simplicity.

### 2.3 OPTION C — $250 / $400 / $600 / $850 per side (trader-friendly target)

| Band | Rate $/side | Platform PnL/pair-life | Trader net cost/pair-life | Trader $/day | bps/day | APR |
|---|---|---|---|---|---|---|
| Calm | $250 | **+$241** | +$494 | $71 | 7.1 | 26% |
| Mod | $400 | +$1,054 | +$1,676 | $239 | 23.9 | 87% |
| Elev | $600 | +$2,193 | +$3,648 | $521 | 52.1 | 190% |
| Stress | $850 | +$2,846 | +$5,522 | $789 | 78.9 | 288% |
| **Blended** | — | **+$1,320** | — | — | — | — |

**Trader's view:** $71/day net cost in calm regime — equates to ~7 bps/day on $100k notional. **This is comparable to perp funding rates and well below typical insurance markups.** Foxify almost certainly accepts this.

**Platform's view:** calm regime is razor-thin ($241/pair-life — any model error wipes it out). Strong margin in mod/elev/stress carries the blended P&L. **Recommended baseline tier.**

### 2.4 OPTION D — $200 / $350 / $550 / $800 per side (very aggressive)

| Band | Rate $/side | Platform PnL/pair-life | Trader net cost/pair-life | Trader $/day | bps/day | APR |
|---|---|---|---|---|---|---|
| Calm | $200 | **−$618** | −$365 | −$52 | -5.2 | NEG |
| Mod | $350 | +$71 | +$692 | $99 | 9.9 | 36% |
| Elev | $550 | +$1,130 | +$2,585 | $369 | 36.9 | 135% |
| Stress | $800 | +$1,807 | +$4,484 | $641 | 64.1 | 234% |
| **Blended** | — | **+$352** | — | — | — | — |

**Calm regime is a LOSER for the platform** (-$618/pair-life). The trader actually MAKES money on average in calm because they get more in payouts than they pay in premium. Platform's blended P&L is positive only because elev+stress carry the load. **Don't use this** unless Foxify mandates the floor — the calm regime should never be a money-loser.

---

## 3. Per-band breakeven (platform PnL = $0)

The minimum sustainable rate per side per day:

| Band | Breakeven $/side | Notes |
|---|---|---|
| Calm | **$236** | Below this, Atticus loses money in calm (most common regime) |
| Mod | **$346** | |
| Elev | **$497** | |
| Stress | **$713** | |

**The premium ladder must be ABOVE these breakeven floors to keep every regime profitable.** Option C is the most aggressive ladder that respects all four floors with margin.

---

## 4. Comparing to the user's reference points

### 4.1 Retail comparable — "25 bps / $10k notional / day"

User recall: retail charges $25/$10k notional per day = ~$125/side for $50k.

**Why retail can charge less:**
- Retail product has weekly/biweekly cycles, not daily
- Retail trigger frequency is much lower (1-2 per week, not 4-12)
- Retail uses different drawdown floor (10-20%, not 2%)
- Retail per-trade payouts are smaller and don't auto-reset

The volume facility's daily ±2% reset structure means **3-5× higher trigger frequency than retail**, which mechanically requires 3-5× higher premium per side per day to break even. The user's recall ($125/side from retail) is below the volume facility's calm-regime breakeven ($236).

**This is not Atticus over-charging — it's the structural cost of a more reactive product.**

### 4.2 Trader DIY alternative

A Foxify trader could replicate the protection by buying daily ±2% OTM strangles directly at Bullish/Deribit:

- Cost: ~$190/pair/day for a 2% OTM strangle in calm regime
- Trader gets the option payoff (uncapped on continuation moves)
- Trader has to actively manage rolls, intra-day re-anchoring, settlement

**Atticus's markup over DIY raw cost:**

| Option | Atticus charge calm | DIY cost | Markup ratio |
|---|---|---|---|
| V3-A ($425/side) | $850/pair/day | $190/pair/day | **4.5×** ← too rich |
| Option B ($300/side) | $600/pair/day | $190/pair/day | 3.2× |
| **Option C ($250/side)** | **$500/pair/day** | $190/pair/day | **2.6×** ← typical insurance markup |
| Option D ($200/side) | $400/pair/day | $190/pair/day | 2.1× |

A 2.5-3× markup over raw hedge cost is a typical insurance-product margin. Anything above 4× is hard to justify when the trader has a DIY alternative. **Option C lands in the comfortable zone.**

---

## 5. Recommendation

### 5.1 Lead-with offer to Foxify: **Option C ($250 / $400 / $600 / $850 per side)**

This is the **competitive but profitable** ladder. Specifically:

| DVOL band | Per side | Per pair | Trader net cost (calm) | Platform margin |
|---|---|---|---|---|
| <50 (calm) | **$250** | $500 | $71/day net | +$241/pair-life (thin) |
| 50-65 (mod) | **$400** | $800 | $239/day net | +$1,054 |
| 65-80 (elev) | **$600** | $1,200 | $521/day net | +$2,193 |
| ≥80 (stress) | **$850** | $1,700 | $789/day net | +$2,846 |

- Blended platform: **+$1,320/pair-life** (~$190/day per pair)
- At 1,000 pairs: **+$190k/week = ~$10M/year P&L**
- Trader's calm regime cost: 26% APR on protected notional — competitive vs DIY alternatives
- Platform's calm margin is razor-thin — first sign of model error or sustained adverse VRP triggers re-pricing

### 5.2 Negotiation backstop if Foxify pushes lower: Option B ($300 / $450 / $650 / $900)

**Recommended NOT to go below Option C in calm/moderate** — Option D ($200/$350/...) makes the calm regime a structural loser, which is unacceptable risk.

If Foxify wants the V0 spec rate of $250/pair/day total ($125/side), explain that the platform mathematically can't sustain that at 2% daily-reset triggers. The retail product's $125/side rate works because of much lower trigger frequency from weekly cycles.

### 5.3 What to NOT compromise on

- **Don't drop calm below $236/side** — that's the platform breakeven floor.
- **Don't flatten the tier ladder** — DVOL-driven trigger frequency makes flat pricing structurally lose money in elev/stress.
- **Don't drop the auto-renew + intra-day re-open** — that's the V3 economics. Without it, all numbers in this doc revert to V2 (much worse).

---

## 6. Annual P&L summary at each tier (1,000 pairs scale)

For founder/CFO partner conversations:

| Tier | Annual P&L | Trader cost (calm) | Foxify acceptance prob |
|---|---|---|---|
| V3-A ($425/$600/$900/$1,100) | **$290M** | $500/day | Low — too rich |
| Option B ($300/$450/$650/$900) | **$119M** | $193/day | Medium — possible push |
| **Option C ($250/$400/$600/$850)** | **$69M** | **$71/day** | **High — likely accept** |
| Option D ($200/$350/$550/$800) | $18M | -$52/day (gain!) | Highest — but calm regime loses money |

**These annualized numbers assume 1,000 always-on pairs at the empirical regime mix. Phase 1-2 P&L scales linearly.**

---

## 7. Bottom line

> **Lead with Option C.** Platform earns ~$70M/year at scale (Phase 5);
> Phase 1 (4.3 pairs) earns ~$300k/year P&L. Trader pays a competitive
> 7-25 bps/day net cost across calm/mod regimes. Both sides can defend
> the deal externally.
>
> Be ready to fall back to Option B if Foxify pushes calm to $300+,
> but **do not go below Option C in calm** without extracting an
> offsetting concession (e.g., longer auto-renew default, lower
> Foxify pre-fund minimum, or a stop-the-bleeding cooldown trigger
> at lower thresholds).
>
> All numbers in this doc are conditioned on V3's intra-day re-open
> + pro-rated premium logic actually executing in production. If
> production code matches V2 (no intra-day re-open premium), tier
> Option C falls back to V2's marginal economics and we'd need
> Option B to maintain the same blended P&L. **Engineering walkthrough
> remains the gating item.**
