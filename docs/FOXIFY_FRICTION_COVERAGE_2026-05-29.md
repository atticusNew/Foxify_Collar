# Foxify Friction Coverage Analysis - 90 Day Projection

Generated: 2026-05-29T20:37:02.803Z | Spot at analysis: $73600 | Bars analyzed: 25926 (90d)

---

## The Question

Foxify runs paired perp positions (long + short on partner venues). The two perps cancel each other on price movement (delta-neutral by design), but each leg incurs friction: trading fees, slippage, funding rates. That friction is the structural drag the option side needs to cover.

**Can the option pass-through model deliver enough positive EV per pair to cover Foxify's perp friction cost?**

---

## The Short Answer

**Yes, with cell-level economics that comfortably clear the friction bar.**

- Average per-pair Foxify P&L on the top-EV cell: **+$482**
- Average per-pair Foxify P&L on the top-3 EV cells: **+$459**
- Even at the highest placeholder friction estimate ($400 per pair), the top-EV cell net-covers it: **+$82**

The conclusion is robust across the realistic friction range we tested ($50-$400 per pair).

---

## Methodology

- **Engine:** Monte Carlo simulation, 4,000 paths per cell
- **Path generator:** Bootstrap from 25,926 historical 5-min BTC bars (90 days of actual market data from Deribit)
- **Regime blending:** Each path samples a regime from the historical distribution (calm 50.0% / moderate 30.0% / elevated 15.0% / stress 5.0%). Costs marked up by regime-specific factor.
- **Costs:** Live asks from Bullish + Deribit at the moment of analysis (current spot $73600)
- **Strike selection:** Actual strikes from the live cross-venue liquid-strike picker
- **Salvage:** Black-Scholes mark at trigger bar (or near-expiry residual if no trigger), times 82% slippage haircut
- **Atticus operator fee:** 10% of profit only, min $25/pair, 0% on losses

---

## Per-Cell Distribution Over 90 Days

| Cell | Cost | Mean P&L | Median (p50) | Worst 5% | Best 95% | Trigger rate | Profitable paths | EV % | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `pair_50k_5pct_otm` | $248 | +$482 | +$172 | -$230 | +$1,970 | 21.7% | 59.2% | +194.4% | GO |
| `pair_50k_4pct_otm_short` | $321 | +$310 | +$67 | -$225 | +$1,532 | 16.1% | 57.0% | +96.3% | GO |
| `pair_100k_3pct_itm_short` | $2780 | +$586 | +$1,018 | -$1,276 | +$2,202 | 60.9% | 64.3% | +21.1% | GO |
| `pair_50k_3pct_atm` | $1390 | +$293 | +$509 | -$638 | +$1,101 | 60.9% | 64.1% | +21.1% | GO |
| `pair_25k_5pct_otm_3d` | $416 | +$43 | -$123 | -$430 | +$766 | 34.1% | 41.5% | +10.4% | GO+ |
| `pair_50k_2pct` | $7474 | -$4,291 | -$4,124 | -$5,907 | -$3,347 | 94.4% | 0.0% | -57.4% | PASS |

### Verdict key

- **GO** - >20% expected return on cost. Activate freely.
- **GO+** - 5-20% expected return. Activate with awareness of tighter margin.
- **HOLD** - within ±5% of break-even. Either side could happen; coin flip.
- **PASS** - negative expected return. Don't activate in current conditions.

### How to read this table

- **Cost** - what Foxify pays upfront for the strangle, at current market asks
- **Mean P&L** - average Foxify net cash flow per pair across all 4,000 simulated outcomes (net of cost AND Atticus operator fee)
- **Median (p50)** - the middle outcome; half of paths better, half worse
- **Worst 5%** - 1-in-20 bad day. Bounded loss (can't lose more than cost paid)
- **Best 95%** - 1-in-20 good day. Captures upside when BTC moves meaningfully
- **Trigger rate** - % of paths where BTC crossed a trigger boundary
- **Profitable paths** - % of paths where Foxify ended above break-even

---

## Friction Coverage Matrix

How much does the option side cover Foxify's per-pair perp friction, under two activation policies?

- **Conservative policy:** Bot only activates when the global signal flips GO. Estimated ~2 pairs/day blended across the regime mix.
- **Opportunistic policy:** Bot activates on any cell with positive EV regardless of global signal. Estimated ~5 pairs/day.

### Per-pair coverage (Foxify net AFTER subtracting friction)

| Per-pair friction | Conservative (uses top-EV cell) | Opportunistic (avg of top-3 cells) |
|---|---:|---:|
| $50 | +$432 | +$409 |
| $100 | +$382 | +$359 |
| $150 | +$332 | +$309 |
| $250 | +$232 | +$209 |
| $400 | +$82 | +$59 |

### 90-day total Foxify net (option payback − friction cost)

| Per-pair friction | Conservative (2 pairs/day × 90d) | Opportunistic (5 pairs/day × 90d) |
|---|---:|---:|
| $50 | +$77,726 | +$184,148 |
| $100 | +$68,726 | +$161,648 |
| $150 | +$59,726 | +$139,148 |
| $250 | +$41,726 | +$94,148 |
| $400 | +$14,726 | +$26,648 |

**Read this as:** "If Foxify's per-pair perp friction averages $X, then after 90 days at policy Y activation cadence, Foxify's NET P&L (option payback minus friction cost) is +$Z."

---

## Coverage Conclusion

Option side covers perp friction under BOTH policies across the entire tested friction range ($50-$400 per pair). The pass-through model delivers consistent positive net P&L for Foxify in the regime mix BTC has shown over the last 90 days.

---

## What This Doesn't Yet Include

- **Foxify's REAL friction number.** We used placeholders ($50-$400/pair). When Foxify shares the actual per-pair friction estimate from their 90-day perp backtest, this analysis updates trivially - the structure already exists; just plug in the real number.
- **Activation cadence sensitivity.** We assumed 2/day conservative and 5/day opportunistic. Actual cadence depends on Foxify's bot polling behavior + the realized regime distribution over the test window. Wide ranges available on request.
- **Correlation with Foxify's perp P&L.** The MC sim is path-independent of Foxify's perp side, which is conservative (assumes no correlation between option payback timing and perp loss timing). In practice, when BTC moves enough to trigger the option, the same move generates real perp friction (rebalancing, funding rate shifts). So the correlation is likely SLIGHTLY positive - the option pays back EXACTLY when friction spikes. This makes the model conservative.
- **Volume tiers.** Atticus operator fee scales DOWN with volume (5-15% range). We used 10% (mid). At high Foxify volume, fee compresses to 5%, which improves Foxify net P&L by ~5% across the board.

---

## Recommended Next Steps

1. **Foxify sends:** 90-day perp simulation output - total friction in dollars, per-pair average, and pair count
2. **We plug in:** the real friction number into this same analysis, regenerate the report
3. **Final deliverable:** confirmed Yes/No on whether the option side covers friction, with full distribution analysis

This is a 1-day turnaround on our side once we have Foxify's data.

---

*Generated by Atticus engineering. Source data: live Bullish + Deribit asks at $73600 spot, 25,926 historical bars over 90 days. Methodology validated against V6 cell-sweep findings.*
