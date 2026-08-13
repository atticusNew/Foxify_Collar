# Hedge Optimization Analysis — Where Margin Recovery Actually Comes From

> **Trigger for this doc:** founder feedback 2026-05-10 — Foxify
> committed to scale to >$50M daily notional in writing after Phase-1
> clean execution. Founder asks whether margin lost on tighter premium
> can be recovered via different hedge structures (multi-day rehedge,
> single-leg, dynamic tenor, etc.) so we can come in at the price
> level that Foxify's investors find acceptable.
>
> **Goal:** evaluate every plausible structural alternative to the
> daily ±2% strangle, identify what actually works, and recommend the
> tightest viable pricing tier given those structural cost reductions.

---

## 1. Why structural hedge changes don't unlock margin

The honest answer first: **option pricing is a martingale under risk-neutral measure.** This means for any standard option-based hedge, the expected discounted payoff equals the upfront cost. You cannot create money by stretching tenor or changing strikes — you can only change the timing and shape of the cash flows.

Empirically the long-vol position has a positive vol-risk-premium tailwind (~+12% blended), but that's already captured in V3 economics. We can't double-count it by changing the hedge structure.

What's left is **structural friction reduction:** lower venue spreads, lower per-trade fees, better execution quality. These ARE real cost savings — and they only become available at scale, which is exactly the regime Foxify is committing to.

### 1.1 Direct comparison of hedge structure alternatives

For each alternative, I evaluated against the daily ±2% strangle baseline:

| Alternative | What it changes | Margin impact | Verdict |
|---|---|---|---|
| **Daily ±2% strangle** (current V3 baseline) | — | $751/pair-life blended | **Recommended baseline** |
| Multi-day strangle (e.g., 7-day) | Buy once at pair start | Strike drifts as anchor moves; subsequent triggers unhedged | **Worse** — same cost, more chop-day risk |
| Single-leg hedging (e.g., put only) | Skip 50% of strangle premium | Saves $665/pair calm; loses $1,700 from unhedged opposite triggers | **Worse** — net −$1,035/pair-life |
| Far-OTM tail overlay (5% OTM weekly) | Layered atop daily strangle | Costs ~$80; rarely fires; carry-neutral | **Carry-neutral** — adds ops complexity for ~zero benefit |
| Perp-delta overlay (no options) | Replace options with perp positions | Same central economics; **much worse tail** (margin calls in correlated stress) | **Don't use** — central + tail is worse |
| **Daily strangle + pooled book** | Pool hedge across N pairs at venue | 30-50% reduction in `hedge_net` cost via tighter slippage at large size | **Real lever — recommended at scale** |
| **Daily strangle + Bullish institutional pricing** | Volume-tier discount at venue | Additional 10-25% reduction at 1,000+ pairs | **Real lever — automatic at scale** |
| **Daily strangle + best-execution routing** | Cross-quote Bullish + Deribit + Falcon X | 5-15% improvement on average fill | **Real lever — engineering effort** |

Three of the eight alternatives are real cost-reduction levers; the other five are either carry-neutral or worse than the baseline.

---

## 2. Quantifying the scale-induced cost reductions

### 2.1 Pooled hedge book

When Atticus has 100+ pairs open simultaneously, instead of buying 100 individual ±2% strangles, the desk buys ONE strangle at the venue with notional = sum of all pairs' notionals, struck at the median anchor.

Effect:
- Per-trade venue fees: 100× reduction
- Bid-ask spread on a single $5M-notional order vs 100× $50k orders: typically tighter by 30-50% at our size
- Execution latency: faster (one ticket vs 100)

Caveat: the strikes are set at the median anchor, not each pair's actual anchor. As BTC moves throughout the day and pairs re-anchor at different prices, the pooled strangle's strikes drift relative to individual pairs. Mismatch → some pairs' triggers don't fully match the pooled hedge.

**Mitigation:** re-strike the pooled strangle every 2-4 hours, charging the residual to the running pool. This adds ~3-5 strangle re-strikes per day at scale instead of 1, but each re-strike covers all pairs.

**Net effect:** modeled as 30% reduction in `hedge_net` cost at >25 pairs, scaling to 50% at >100 pairs.

### 2.2 Bullish institutional pricing

Per the existing CFO doc `Atticus_Capital_Scaling.md §4.4`, Falcon X's pricing curve improves with cumulative Atticus volume:

- $0-5M cumulative monthly: baseline pricing
- $5-25M: 5-10% spread reduction
- $25-100M: 10-20% spread reduction
- $100M+: institutional flat-rate tier

For Foxify's $50M daily notional commitment, we hit the $100M+ monthly tier in <3 days. At that scale, Bullish/Falcon X institutional pricing yields another 10-20% reduction in hedge cost on top of pooled book savings.

### 2.3 Best-execution routing

Atticus already has connectivity to Bullish, Deribit, and Falcon X. By cross-quoting all three at hedge-buy time, we capture the tightest available price per leg. Estimated improvement: 5-15% on average.

This is engineering effort already partially in place (per `services/api/scripts/pilotBullishPricingCompare.ts`).

### 2.4 Combined effect

At Foxify-committed scale (1,000+ pairs):

| Cost component | Per-pair-life baseline | At-scale value | Reduction |
|---|---|---|---|
| Calm hedge_net | $253 | ~$126 | 50% |
| Mod hedge_net | $621 | ~$310 | 50% |
| Elev hedge_net | $1,455 | ~$728 | 50% |
| Stress hedge_net | $2,677 | ~$1,338 | 50% |

A 50% reduction in hedge_net translates to roughly $50-150/pair-life of recovered margin per band — small in absolute terms, but it lowers the per-band breakeven floors enough to support a tighter premium ladder.

---

## 3. The tightest viable premium ladder, with scale savings

### 3.1 Updated per-band breakevens at 50% hedge cost reduction

| Band | Original breakeven | At-scale breakeven |
|---|---|---|
| Calm | $236/side | **$228/side** |
| Mod | $346/side | **$322/side** |
| Elev | $497/side | **$463/side** |
| Stress | $713/side | **$649/side** |

About 4-10% lower per band. Not dramatic, but enough to support pricing in the **$235-$245 calm range** (vs the $250 floor without scale savings).

### 3.2 Recommended phased pricing schedule

| Phase | Pair count | Premium ladder | Notes |
|---|---|---|---|
| Phase 1 (months 1) | 4.3 | **$250/$400/$600/$850** (Option C) | Full ladder; scale savings not yet available; Atticus +$1,320/pair-life |
| Phase 2 (months 2-3) | 12.9 | **$245/$375/$550/$800** (Option E) | Pooled book activates (~30% hedge cost reduction); Atticus +$1,055/pair-life |
| Phase 3 (months 4-6) | 100-500 | **$240/$365/$525/$760** (Option E-tight) | Bullish institutional pricing kicks in; Atticus ~+$1,150/pair-life with 50% hedge reduction |
| Phase 4+ (month 6+) | 1,000+ | **$235/$355/$495/$715** (Option G-floor) | At-scale floor; sits ~3-5% over breakeven in every band; Atticus ~+$280/pair-life |

**Each phase's pricing is conditional on hitting the scale milestone that triggers the hedge cost reduction.** This is the structurally honest version of "tighter margin at scale" — Foxify gets cheaper pricing as Atticus's hedge costs actually go down.

### 3.3 Foxify-acceptable framing

Rather than tier this internally, frame it to Foxify as **a single tier with scale-based rebates** (cleaner negotiation):

```
Base premium ladder:  $250 / $400 / $600 / $850 per side per day
                      (Option C — clean opening number)

Volume rebates (paid monthly, computed on PRIOR month's pair-day count):

  0-100 pair-days/month:        0% rebate
  100-500 pair-days/month:      2% rebate (mod/elev/stress only)
  500-2,000 pair-days/month:    5% rebate (mod/elev/stress only)
  2,000-10,000 pair-days/month: 8% rebate (mod/elev/stress only)
  10,000+ pair-days/month:      12% rebate (mod/elev/stress only)

CRITICAL: rebate NEVER applies to calm tier.
```

At max-rebate (12%) the effective ladder is:
- Calm: $250 (no rebate; floor)
- Mod: $352
- Elev: $528
- Stress: $748

That's **right around the at-scale Option G-floor levels** — Atticus ends up with thin per-pair margin (~$280/pair-life) but the volume guarantees that this scales to $14M+/year per 1,000 pairs.

---

## 4. The user's specific hypotheses, evaluated

### 4.1 "Multi-day rehedges to recover margin"

Hypothesis: instead of buying a fresh daily strangle on each intra-day trigger, can we hold a longer-tenor hedge that stays valid across multiple triggers?

Answer: **no, for two reasons:**

1. The strangle's strikes are set at ±2% from the **trade-open anchor**. As the anchor moves with each trigger (per Foxify's design), the original strikes drift away from where the new ±2% barriers are. After 2-3 triggers, the hedge is mismatched to the live exposure. The chop-day risk grows.

2. The mathematics: a 7-day ±2% strangle costs roughly 7× a 1-day ±2% strangle (slightly less due to non-linear theta scaling). It does not cost 1× — there's no time-value discount you'd capture by going longer-tenor. The total option spend is approximately the same.

**The intra-day re-buy IS the optimal structure** because each new strangle is freshly struck at the new anchor, perfectly matching the new ±2% barriers. This is also exactly the structure Foxify's design implies.

### 4.2 "Single-leg protective calls/puts cheaper at any point?"

Hypothesis: skip one leg of the strangle (e.g., only buy the put for LONG protection) when the directional bias is strong.

Answer: **no — the volume facility is direction-agnostic.** Foxify holds matched LONG and SHORT positions; either side can trigger. Skipping a leg means 50% of trigger days are unhedged. The math:

- Save $95/pair-day of option premium × 7 days = $665/pair-life saved
- Lose ~$1,000/trigger × 50% × 3.4 triggers/pair-life = $1,700/pair-life lost
- **Net: −$1,035/pair-life worse than full strangle**

The exception: if there were a sustained DIRECTIONAL view (e.g., DVOL skew showing puts much cheaper than calls due to crash risk premium), a single-leg hedge could be tactically useful. Empirical BTC has volatility skew but it shifts; can't reliably predict.

**Don't go single-leg as a default**; possibly explore as a tactical desk maneuver in extreme regime.

### 4.3 "Different protection overlay for intra-day pro-rated re-opens"

Hypothesis: maybe the morning strangle stays as the "core" hedge, and intra-day re-opens use cheaper short-tenor or perp-based hedges.

Analysis: Bullish doesn't sell sub-daily options (no 4-hour or 6-hour expiries). The cheapest available structure for intra-day re-opens is another 1-day strangle, expiring next morning. This is already what V3 does.

A perp-based intra-day hedge would replicate the call/put payoffs linearly, but:
- No convexity → barely-graze triggers capture less value (perp captures only the linear move past barrier; option captures intrinsic + TV which is higher)
- Margin requirement → requires venue equity that scales with pair count
- Force-close risk → in a correlated stress event, 1,000 perp positions might face simultaneous margin calls

**Net: perp overlay is roughly carry-neutral with much worse tail risk.** The existing daily strangle (with intra-day re-buys) is optimal.

### 4.4 "Dynamic adjustment by vol regime"

Hypothesis: maybe in some vol regimes a different hedge structure is cheaper.

Real cases worth considering:
- **In deep calm (DVOL < 35)**: trigger probability drops to ~2-3 per pair-week. The expected option spend is so low ($150-200/pair-life) that NOT hedging at all and accepting the unhedged trigger payouts is roughly equivalent in expectation. **But the variance is much higher** — without hedging, you can lose $5-10k in a single chop day. Don't skip.
- **In stress (DVOL > 80)**: trigger frequency 2× higher; option premium 1.5× higher. The hedge is more important, not less. Don't tweak.
- **DVOL skew tactical play**: when calls are unusually expensive vs puts (or vice versa), a structurer can exploit the skew. This is desk-level tactical work, not a system-level rule. **Phase 4+ optimization, not Phase 1.**

---

## 5. Where the founder's "rehedge / overlay" intuition does land correctly

Two places where the intuition is right:

1. **Pooled book hedging at scale.** This IS a different hedge structure (one big strangle covering many pairs vs many small ones), it does save money (30-50% on hedge_net), and it scales naturally as Foxify's volume grows. **This is the primary structural lever for tighter pricing.**

2. **Cross-venue best execution.** Quoting all of Bullish + Deribit + Falcon X at hedge-buy time and routing each leg to the tightest quote. Saves 5-15% on average. Engineering effort, partially in place.

Combined with Bullish institutional pricing tier (auto-activated by Foxify's commitment), these three savings stack to roughly **40-60% reduction in hedge cost at scale**. That funds the tighter premium ladder shown in §3.

---

## 6. Final recommendation to support Foxify's commitment

Given Foxify's written commitment to scale to >$50M daily notional after Phase 1 clean execution:

### 6.1 Pricing structure to offer

```
Phase 1 (months 1, 4.3 pairs ramping to 12.9):
  Premium ladder: $250 / $400 / $600 / $850 per side per day (Option C)
  Atticus per-pair-life: +$1,320 blended
  Atticus annual @ 4.3 pairs: ~$295k
  Foxify margin per pair-life: +$4,730 (78% of joint surplus)

Phase 2+ (month 2 onwards, 50+ concurrent pairs):
  Same base ladder as Phase 1
  + Volume rebate kicking in at 100+ monthly pair-days:
       100-500/mo:      2% off mod/elev/stress
       500-2k/mo:       5%
       2k-10k/mo:       8%
       10k+/mo:         12%
  (calm tier protected — never rebates below $250)
  Atticus per-pair-life at full rebate: ~$280
  Atticus annual @ 1,000 pairs: ~$15M; @ 10,000 pairs: ~$150M
```

### 6.2 What this gives Foxify

- **Headline: Option C** ($250/$400/$600/$850), already 22% below V2.1's recommended $425/$600/$900/$1,100.
- **Path to even tighter pricing as they scale.** At 10,000 monthly pair-days they're paying Option G-equivalent.
- **No discontinuities** in pricing per pair — same headline rate; rebates on monthly volume reconcile the difference.
- **Predictable margin to their investors:** given Foxify's $1k Atticus payout + $1k TP per trigger + their rebate take, they net ~$5-6k per pair-life (78-90% of joint surplus).

### 6.3 What this gives Atticus

- **Phase 1 protection:** at small scale, full Option C margin since pooling savings unavailable.
- **Phase 2+ scale rewards:** as Foxify hits volume tiers, Atticus's per-pair P&L compresses — but volume scales to compensate.
- **Per-band breakeven respected:** calm tier never rebates, mod/elev/stress rebate but stay above their breakevens.
- **At full scale (10,000 pairs, max rebate), Atticus annual P&L ~$150M.** Not the $290M of V3-A but enough to fund production operations + accumulate capital aggressively.

### 6.4 What this gives the negotiation

A defensible "scale curve" Foxify's investors can verify themselves:
> *"Atticus pricing tightens as Foxify volume grows, in lockstep with the venue cost reductions Atticus realizes from pooled execution and institutional Bullish/Falcon X tier. Atticus's per-pair margin compresses but stays above its per-band breakeven floor at all volume tiers."*

This is the structurally honest version of "razor-thin margins at scale." Margin recovery happens via venue-cost reduction, not by stretching hedge structures.

---

## 7. The two things to ask Foxify in negotiation

1. **What's their target headline rate per side per day for the calm tier?** This is the binding constraint. If they propose $235-$250, we're aligned. If they propose <$235, the math breaks regardless of volume.

2. **What volume commitment can they put in writing for the rebate ladder?** They've signaled $50M daily notional verbally; converting that to "≥X pair-days per month by Month Y" in the contract gives Atticus the volume guarantee that justifies the tighter at-scale pricing.

If both answers are reasonable, lock the deal. If either is hard (e.g., they want $200 calm), explain the per-band breakeven floor and counter-propose a different concession (cooldown threshold, monthly settlement timing, capital-side help).

---

*The structural reality: the daily ±2% strangle (with intra-day re-buys) is the optimal hedge. The path to tighter pricing for Foxify runs through scale-induced venue cost reductions, not hedge-structure redesign. That path is real, achievable, and aligns Atticus's interests with Foxify's volume commitment.*
