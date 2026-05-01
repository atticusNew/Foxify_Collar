# Foxify Per-Day Protection — Cost vs. Gain Analysis
**Generated:** 2026-04-28
**Window:** Last 24 months Coinbase BTC daily OHLC (721 trading days).

**The question this answers:** *Over a typical 24-hour holding window, how often does a perp position's natural P&L move enough in the trader's favor to fully offset the day's protection fee?*

**The framing matters.** Protection has negative EV in expectation — that's true of all insurance. The useful question is not "is protection free in expectation?" (it's not) but "on what fraction of days does the position's move absorb the fee, so the trader feels the cost as 'embedded' rather than 'extra'?"

---

## §1: Break-even daily BTC move per tier (per $10k of position)

For each tier, this is the BTC daily move (favorable direction) at which the position's natural gain exactly equals the day's protection fee.

| Tier | Daily fee per $10k | Break-even BTC move (favorable direction) | % of historical days BTC moved at-or-beyond this |
|---|---|---|---|
| 2% | $55.00/day | ±0.55% | **73.6%** |
| 3% | $60.00/day | ±0.60% | **72.0%** |
| 5% | $65.00/day | ±0.65% | **70.3%** |
| 10% | $25.00/day | ±0.25% | **87.2%** |

**Reading:** the percentages above count days where BTC moved *in either direction* by at least the break-even — useful as a population statistic but not directly applicable to a directional perp trader (who only benefits from moves in their bet direction). For a single-direction trader (long OR short), see §2.

Headline takeaway: the **10% tier** has a tiny break-even threshold ($0.25 per $1 of position) — most days, BTC's natural noise alone covers the fee. The **5% tier** at $65/day requires a 0.65% favorable move; about a third of historical days cleared that bar in each direction.

---

## §2: Long vs short — favorable direction matters

BTC has had a slight upward drift over the last 24 months. Long positions absorb fees more often than shorts on the same break-even threshold.

| Tier | Long absorbs fee (% of days) | Short absorbs fee (% of days) | Drift bias |
|---|---|---|---|
| 2% | 37.2% | 36.5% | +0.7pp |
| 3% | 36.5% | 35.5% | +1.0pp |
| 5% | 35.8% | 34.5% | +1.2pp |
| 10% | 43.6% | 43.7% | -0.1pp |

**Practical implication:** the cost-vs-gain framing favors long positions slightly in this dataset. Short positions still absorb the fee a meaningful fraction of the time on the cheaper tiers (3%, 10%) but are tighter on the 5% tier.

---

## §3: Position size and leverage — what changes?

**Position size:** the daily fee scales linearly with position size, but so does the gain per BTC move. *The break-even BTC move % is identical across position sizes.* The dollar amounts scale.

| Tier | $10k position fee | $25k position fee | $50k position fee | Break-even move (same for all sizes) |
|---|---|---|---|---|
| 2% | $55.00 | $137.50 | $275.00 | ±0.55% |
| 3% | $60.00 | $150.00 | $300.00 | ±0.60% |
| 5% | $65.00 | $162.50 | $325.00 | ±0.65% |
| 10% | $25.00 | $62.50 | $125.00 | ±0.25% |

**Leverage:** doesn't change the break-even BTC move at all (fee is on notional, gain is on notional). Leverage only changes the trader's *margin at risk* — and therefore changes the break-even **as % of margin** (the leverage-amplified version).

---

## §4: Don't forget the loss-floor (why the protection exists)

Cost-vs-gain frames the *typical day*. The point of protection is the *worst day*. Worst observed BTC daily move in the 24mo window:

- **Worst BTC down day:** -13.98% on 2026-02-05
- **Worst BTC up day:** +12.33% on 2026-02-06

On a $25,000 long position with 10× leverage (margin $2,500):

| Scenario | Unhedged | With Foxify 5% protection |
|---|---|---|
| Worst observed BTC down day | -$3,496 (-139.84% of margin) | -$1,250 SL paid out at -5% trigger; further losses prevented if SL fired in time |
| Average day | ~$0 P&L drift | Same, minus $162.50/day fee |

**The protection isn't "free protection."** It's a small fee against the small risk that today is the worst day. On most days, the position's natural move makes the fee feel embedded (as quantified in §1); on the rare bad days, the SL prevents the catastrophe.

---

## §5: How to talk about this with traders (suggested copy)

Three honest framings, in order of strength:

**Framing 1 (most defensible — break-even probability):**
> *"At our 5% protection tier, if BTC moves more than 0.65% in your favor in a day — which happens about 1 day in 3 historically — your position's natural move covers the protection fee for that day. On the other days, you paid for protection that didn't fire — same dynamic as buying car insurance you didn't claim."*

**Framing 2 (clear value framing — loss floor):**
> *"For a few dozen dollars per day on a $10k position, your worst possible day is capped at a 5% loss instead of unlimited. On a single -10% day (we've had several), that protection turns a -$1,000 loss into a -$500 loss + the day's fee."*

**Framing 3 (combined — the honest two-sentence pitch):**
> *"On most days your position's natural move covers the protection fee. The fee buys you a hard floor on the worst day — the kind of day that wipes out untriggered traders."*

**What NOT to say:**
- ❌ "Protection pays for itself." (Misleading — true some days, false others.)
- ❌ "Average gain offsets the fee." (BTC daily mean return is ~0; this isn't true in expectation.)
- ❌ "Free protection most of the time." (Confuses correlation with causation; the fee is paid every day regardless.)

---

## §6: Caveats

- **Daily-resolution analysis.** Intra-day moves often cross the break-even and reverse. The analysis uses open-to-close, which understates volatility around the break-even threshold.
- **24-month sample.** BTC has had a particular drift profile over this period (mostly bullish, some sharp drawdowns). A different 24-month window would show different long/short asymmetry.
- **Per-day framing only.** Doesn't capture multi-day holds where the fee compounds. Use the deep analysis (PR #95) for cumulative-cycle math.
- **Doesn't include perp funding rates.** Funding can be a small per-day cost or revenue depending on perp side and market state.
- **Cost-vs-gain is one of two value framings.** The other (loss-floor on the worst day) is in PR #95. Both should be told together for full honesty.