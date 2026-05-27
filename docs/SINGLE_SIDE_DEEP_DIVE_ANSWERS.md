# Deep Dive — Loss Distribution, Trigger Rates, Early Close, Moneyness

**Generated:** 2026-05-26T21:27:53.400Z
**Cells:** 50k/2%, 50k/5%, 200k/5%
**Split:** 80/20 (Foxify favor) — flat, no operating fee
**Hedge cost source:** Today's live Bullish (calm) + BS scaling for higher regimes
**Paths per scenario:** 25,000

## Q1+Q2 — When is salvage less than hedge cost? Trigger rates per cell × regime

Loss = paths where salvage < hedge cost (Foxify takes a hit on that cover, since the option
didn't recover its purchase price by the time it was sold).

### ss_50k_2pct_1k

| Regime | Hedge cost | Trigger rate | % loss paths | Avg salvage on loss | Avg loss severity ($) | Avg uplift on win paths |
|---|---:|---:|---:|---:|---:|---:|
| calm | $567 | 32.0% | 47.5% | $267 | $300 | $802 |
| moderate | $1,110 | 49.5% | 41.0% | $494 | $615 | $946 |
| elevated | $1,668 | 61.9% | 33.5% | $725 | $943 | $1,142 |
| stress | $2,233 | 69.1% | 28.1% | $948 | $1,284 | $1,303 |

**Path-outcome quadrant (calm regime, ss_50k_2pct_1k):**

| Path category | % of paths |
|---|---:|
| Triggered AND salvage > hedge cost (Foxify wins on a triggered cover) | 32.0% |
| Triggered BUT salvage < hedge cost (rare — trigger fired but option didn't capture enough) | 0.0% |
| Not triggered AND salvage > hedge cost (option's time value alone exceeded entry cost) | 20.6% |
| Not triggered AND salvage < hedge cost (no trigger, theta decay ate the cost) | 47.5% |

### ss_50k_5pct_2_5k

| Regime | Hedge cost | Trigger rate | % loss paths | Avg salvage on loss | Avg loss severity ($) | Avg uplift on win paths |
|---|---:|---:|---:|---:|---:|---:|
| calm | $357 | 8.5% | 65.4% | $102 | $255 | $1,247 |
| moderate | $930 | 15.6% | 59.9% | $299 | $631 | $1,550 |
| elevated | $1,574 | 30.3% | 54.9% | $520 | $1,054 | $2,165 |
| stress | $2,245 | 41.9% | 49.2% | $728 | $1,517 | $2,559 |

**Path-outcome quadrant (calm regime, ss_50k_5pct_2_5k):**

| Path category | % of paths |
|---|---:|
| Triggered AND salvage > hedge cost (Foxify wins on a triggered cover) | 8.5% |
| Triggered BUT salvage < hedge cost (rare — trigger fired but option didn't capture enough) | 0.0% |
| Not triggered AND salvage > hedge cost (option's time value alone exceeded entry cost) | 26.1% |
| Not triggered AND salvage < hedge cost (no trigger, theta decay ate the cost) | 65.4% |

### ss_200k_5pct_10k

| Regime | Hedge cost | Trigger rate | % loss paths | Avg salvage on loss | Avg loss severity ($) | Avg uplift on win paths |
|---|---:|---:|---:|---:|---:|---:|
| calm | $1,386 | 8.5% | 65.4% | $395 | $991 | $4,841 |
| moderate | $3,612 | 15.6% | 59.9% | $1,162 | $2,450 | $6,017 |
| elevated | $6,110 | 30.3% | 54.9% | $2,019 | $4,092 | $8,407 |
| stress | $8,717 | 41.9% | 49.2% | $2,827 | $5,890 | $9,936 |

**Path-outcome quadrant (calm regime, ss_200k_5pct_10k):**

| Path category | % of paths |
|---|---:|
| Triggered AND salvage > hedge cost (Foxify wins on a triggered cover) | 8.5% |
| Triggered BUT salvage < hedge cost (rare — trigger fired but option didn't capture enough) | 0.0% |
| Not triggered AND salvage > hedge cost (option's time value alone exceeded entry cost) | 26.1% |
| Not triggered AND salvage < hedge cost (no trigger, theta decay ate the cost) | 65.4% |

## Q3 — Early close recovery curve (50k/2% calm)

Foxify "early close" mechanic: after Foxify holds the cover for X days, they decide to
close. Atticus continues operating the option through the theta-aware TP curve over the
remaining tenor and sells whenever the curve fires (or at expiry−4h). The question:
how much of the original hedge cost does Foxify recover, depending on when they close?

| Foxify hold time | Trigger rate before hold-end | Avg salvage | Salvage / hedge ratio | Foxify EV/cover | % recover ≥ hedge cost |
|---|---:|---:|---:|---:|---:|
| 2 hours | 2.6% | $778 | 1.37× | +$165 | 86.1% |
| 6 hours | 9.3% | $802 | 1.42× | +$179 | 72.7% |
| 12 hours | 18.3% | $821 | 1.45× | +$186 | 62.1% |
| 1.0 days | 32.0% | $846 | 1.49× | +$195 | 52.5% |
| 1.5 days | 41.1% | $859 | 1.51× | +$196 | 50.4% |
| 2.0 days | 47.2% | $864 | 1.52× | +$194 | 50.9% |
| 2.9 days | 55.3% | $880 | 1.55× | +$201 | 55.4% |

**Reading:** Foxify's "recovery rate" depends on when they close AND market path:
- **Very early close (2h)**: salvage ≈ hedge cost (option still has full time value).
  Foxify gets back ~100% on average. They've barely paid theta yet.
- **Mid-hold (1d)**: salvage averages 1.5-1.7× hedge cost (theta-aware TP captures intraday).
  Foxify gets back original cost + their share of the uplift.
- **Late close (2d+)**: lower trigger rate within hold (closer to expiry), but salvage ratio
  on retained option also accumulates. Net Foxify EV continues to grow.

## Q4 — What tenor is the hedge being bought at?

Today's Bullish + Deribit chain availability (live):

| Cell | Configured tenor | Bullish nearest expiry | Deribit nearest expiry | Empirical hedge cost |
|---|---:|---:|---:|---:|
| ss_50k_2pct_1k | **3 days** | 2026-05-29 (3.3d) | 2026-05-29 (3.3d) | $567 |
| ss_50k_5pct_2_5k | **3 days** | 2026-05-29 (3.3d) | 2026-05-29 (3.3d) | $357 |
| ss_200k_5pct_10k | **3 days** | 2026-05-29 (3.3d) | 2026-05-29 (3.3d) | $1,386 |

**Bullish today lists daily expiries:** 26/27/28/29 May (1d, 2d, 3d, 4d) + 5 Jun (10d) + 12 Jun (17d).
**3-day default** is the optimal balance:
- Long enough for Foxify's typical 1-1.5d hold + Atticus salvage tail (1.5-2d remaining)
- Short enough that theta decay is captured by triggered option intrinsic
- Matches Foxify's rational hold-time per the premium/payout breakeven

Alternative tenors (not currently used):
- **1-day**: too short for theta-aware TP curve to capture intraday peaks past day 1
- **5-day (when listed)**: longer tail = more salvage, but Foxify holds the same ~1d so excess theta wasted
- **10-day (5 Jun expiry)**: only viable for 7% cells (different product)

## Q5+Q6 — What is the moneyness? Are we using the best strike selection?

Current default for 50k/2%: **1% OTM** (strike at spot × 0.99 for long-cover puts, snapped to
nearest $1k Bullish grid). Tested alternatives:

| Strike choice | Hedge cost | Avg salvage | Salvage/Hedge ratio | Foxify EV/cover | Atticus EV/cover | %loss paths |
|---|---:|---:|---:|---:|---:|---:|
| 1% ITM | $1,610 | $2,215 | 1.38× | +$436 | +$170 | 34.6% |
| ATM | $1,003 | $1,427 | 1.42× | +$300 | +$124 | 40.8% |
| 0.5% OTM | $1,003 | $1,427 | 1.42× | +$300 | +$124 | 40.8% |
| 1% OTM | $567 | $846 | 1.49× | +$195 | +$84 | 47.5% |
| 1.5% OTM | $567 | $846 | 1.49× | +$195 | +$84 | 47.5% |
| 2% OTM | $287 | $458 | 1.60× | +$119 | +$52 | 53.4% |

### Verdict on strike selection

- **Best Foxify EV:** 1% ITM (+$436/cover)
- **Best salvage/hedge ratio:** 2% OTM (1.60×)
- **Current default (1% OTM):** +$195/cover

⚠️ **Strike change opportunity:** Switching from 1% OTM to 1% ITM would change
Foxify's EV from +$195/cover to +$436/cover.
Worth considering before launch.

### Why 1% OTM is the design point

The cell was sized so that:

```
contracts = payout / (entry × (triggerPct − hedgePct))
        = $1,000 / ($76,000 × (0.02 − 0.01))
        = $1,000 / $760
        ≈ 1.32 → rounded to 1.4 BTC
```

At the trigger boundary, intrinsic = (entry × triggerPct) − (entry × hedgePct) = entry × 0.01
per BTC. With 1.4 BTC contracts, total intrinsic = ~$1,064 ≈ payout. **By design.**

Going closer to ATM (e.g. 0.5% OTM):
- Hedge cost goes UP (more time value)
- Intrinsic at trigger goes UP (overpays for trigger event — over-hedge)
- Foxify's 80% share of the EXCESS intrinsic captures more on triggers, but the upfront cost is higher
- Net effect depends on path; backtest decides

Going further OTM (e.g. 1.5% / 2% OTM):
- Hedge cost goes DOWN (less time value)
- Intrinsic at trigger goes DOWN (under-hedges — option may not pay enough on shallow triggers)
- More loss paths (option expires worthless more often)
- Foxify's net depends on whether the cost reduction outweighs the salvage reduction

## Summary — direct answers

### ss_50k_2pct_1k
- **Trigger rate (calm):** 32.0% (real BTC paths)
- **% paths where salvage < hedge cost:** 47.5%
- **Avg loss severity when in loss:** $300 (Foxify's tail)
- **Tenor:** 3d (Bullish/Deribit nearest available expiry)
- **Moneyness:** 1% OTM (snapped to $1k grid)

### ss_50k_5pct_2_5k
- **Trigger rate (calm):** 8.5% (real BTC paths)
- **% paths where salvage < hedge cost:** 65.4%
- **Avg loss severity when in loss:** $255 (Foxify's tail)
- **Tenor:** 3d (Bullish/Deribit nearest available expiry)
- **Moneyness:** 3% OTM (snapped to $1k grid)

### ss_200k_5pct_10k
- **Trigger rate (calm):** 8.5% (real BTC paths)
- **% paths where salvage < hedge cost:** 65.4%
- **Avg loss severity when in loss:** $991 (Foxify's tail)
- **Tenor:** 3d (Bullish/Deribit nearest available expiry)
- **Moneyness:** 3% OTM (snapped to $1k grid)

### Early close recovery (50k/2% calm)

Yes Foxify can close early. Recovery depends on when:
- **Close after 2h:** salvage averages $778 (1.37× hedge cost), Foxify EV +$165
- **Close after 6h:** salvage averages $802 (1.42× hedge cost), Foxify EV +$179
- **Close after 12h:** salvage averages $821 (1.45× hedge cost), Foxify EV +$186
- **Close after 1.0d:** salvage averages $846 (1.49× hedge cost), Foxify EV +$195
- **Close after 1.5d:** salvage averages $859 (1.51× hedge cost), Foxify EV +$196
- **Close after 2.0d:** salvage averages $864 (1.52× hedge cost), Foxify EV +$194
- **Close after 2.9d:** salvage averages $880 (1.55× hedge cost), Foxify EV +$201

---

*Generated by services/api/scripts/backtest/singleSide/runDeepDiveAnswers.ts*