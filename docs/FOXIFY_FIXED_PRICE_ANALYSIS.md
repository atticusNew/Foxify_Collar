# Fixed-Price Analysis

A simple, factual look at the fixed-price model - what works, what's hard, and where the math breaks down at the proposed $300 premium / $1,000 payout level.

---

## 1. Conceptually, fixed price works

Selling fixed-price options or "insurance-style" products is a real, established business. Traditional market makers and insurance writers do it every day. The core idea - collect a premium up front, pay out a fixed amount if a defined event happens - is sound and well-understood.

So the question isn't whether the model exists. It does. The question is whether the **specific numbers being proposed** ($300 premium, $1,000 payout, 50k notional, 2% trigger) hold up against how the underlying options market actually behaves.

---

## 2. Why fixed-price is hard in practice

Even though the concept is clean, three things make a sustainable fixed-price product genuinely difficult:

**Option prices are a moving target.** The cost to hedge a $1,000 payout obligation is set by the live options market. That cost moves every minute. Bid-ask spreads widen sharply during news events (often 2-5x in seconds). What costs $400 to hedge at 9am can cost $700 by 11am with no warning.

**Hold time is unknown.** A fixed-price product is priced as "$X per day." But the actual time a position stays open is determined by the closer (in this case Foxify's bot). In active markets, positions close within hours. The premium collected over a short hold is only a fraction of one day's quote, while the obligation that was hedged is for the full window.

**The capital requirement is large.** A fixed-price book has to be able to honor every payout instantly across many concurrent positions, including during clusters of triggers in stress days. Without significant working capital sitting in reserve, the book can't survive bad streaks that are mathematically going to happen.

These are structural realities of writing fixed-payout products against a live derivatives market - not implementation details that go away with better engineering.

---

## 3. Why the $300 / $1,000 / 50k / 2% number specifically doesn't work

The proposed structure is $300 daily premium for a $1,000 payout on a 2% BTC move at 50k notional. The math on this specific configuration is the issue:

**The hedge alone costs more than the premium.** On 50k notional, the live cost to fully hedge a $1,000 obligation against a 2% move (using the actual Deribit options market across realistic hold windows) sits in the **$400–$700 range** depending on regime. The $300 premium doesn't cover the hedge by itself, before any expected payout or margin.

**Trigger probability is too high.** A 2% BTC move is not a rare event. Over a multi-day hold:
- Calm regime: ~25–35% probability of triggering
- Moderate regime: ~50–70%
- Stress regime: 85%+ and often 100%

Expected payout cost = trigger probability × $1,000. Even in calm, that's $250–$350 of expected payout owed, against a $300 premium collected. There is no room for hedge cost, slippage, or margin.

**Stress regimes compound the problem.** When markets are active, the 2% move triggers fast and often, and the option hedge required to cover the $1,000 obligation prices up at exactly the same time. Premium collected in those windows is small (short hold), obligation owed is large (high trigger rate), hedge cost is elevated (wide spreads + high IV). All three pressures hit the same configuration simultaneously.

The $300 number was chosen because it's a clean round figure, not because it matches the underlying hedge economics. The hedge math points materially higher to be sustainable, and going there changes the product enough that it stops being the simple product originally requested.

---

## 4. Why the $25 / $200 / 10k notional version was *close* to working

The earlier test of $25 premium for a $200 payout on 10k notional behaved better, and that's worth understanding clearly:

**The premium-to-payout ratio was much more favorable.** $25 → $200 is an 8x ratio. $300 → $1,000 is a 3.3x ratio. The lower the ratio, the more triggers you can absorb before the math breaks. At 8x, the model can survive a ~12% trigger rate. At 3.3x, the model needs trigger rate below ~30%, and the proposed configuration runs well above that.

**Notional doesn't scale linearly.** A 10k notional hedge is not "one-fifth" the cost of a 50k notional hedge. As notional grows, three costs grow disproportionately:
- Bid-ask spreads widen on larger size (less depth at the best price)
- The hedge has to be split across more strikes or venues, which costs more
- Larger positions face more skew / liquidity premium from market makers

You can't take a small-size pricing result and multiply it up. The cost curve bends against you as size increases.

**Those tests were run in calm market conditions.** The favorable results from the $25/$200 configuration came from periods where realized volatility was low and trigger rates were at the low end of the range. The model wasn't stress-tested against the volatility environments it would actually face during real Foxify usage (which is precisely the periods Foxify uses the product for). Performance in calm is not a reliable predictor of performance in active markets.

So the $25 case was close to working in calm at small size - but neither of those conditions are the operating environment for the proposed $300 / $1,000 / 50k structure.

---

## 5. Why fixed-price ultimately isn't worth pursuing for this pilot

Even setting aside the specific numbers, there are structural reasons fixed-price isn't the right vehicle to launch this partnership on:

**It requires near-perfect execution every cycle.** Every position must be hedged on time, at quoted prices, with minimal slippage, every minute the position is open. Any execution miss, any spread widening, any re-hedge that lags, compounds into real loss. There is very little margin for the normal friction that exists in any live system.

**It requires absorbing extended stress periods from reserves.** Stress doesn't come politely spaced - it clusters. A fixed-price book has to survive consecutive stress days from working capital while still meeting payout obligations on time. That requires capital sitting idle waiting to absorb losses that will eventually arrive.

**Capital efficiency is poor.** A large reserve has to back a thin per-pair margin. The same capital deployed in a pass-through model generates volume immediately, with no reserve requirement and no payout obligation sitting against it.

**Margin per pair is thin.** Even when the math works, the per-pair profit on a sustainable fixed-price structure is small. The operational load (continuous re-hedging, treasury management, real-time obligation accounting, daily billing) is the same whether the product is fixed-price or pass-through. The complexity-to-margin ratio is unfavorable.

**The fixed payout doesn't actually serve Foxify better.** On a real move, the live options market typically pays back more than the $1,000 fixed cap. The pass-through model captures that upside for Foxify automatically. Capping it at $1,000 leaves money on the table for both sides.

The model is real, the engineering is buildable, the capital is raisable. But it is a multi-month, capital-heavy undertaking with thin margins to defend a product that the pass-through structure already delivers - with better upside, simpler operations, and no reserve requirement - today.
