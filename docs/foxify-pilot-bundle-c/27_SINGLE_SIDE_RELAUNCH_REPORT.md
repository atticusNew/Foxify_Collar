# Single-Side Pilot Relaunch — Backtest Report

**Generated:** 2026-05-17T19:22:47.940Z
**Data:** 486 BTC daily OHLC candles (2025-01-15 → 2026-05-16), Coinbase
**Regime distribution:** 73% calm / 19% moderate / 8% elevated / 0% stress

## Methodology

- **Single-side (single-leg) hedge:** put for long cover, call for short cover (50/50 random)
- **Cell-conditional tenor:** 3-day for 5% trigger cells, 6-day for 7% trigger cells (Bullish liquidity)
- **Vol-buffered sizing:** 1.0× calm / 1.05× moderate / 1.10× elevated / 1.15× stress
- **IV-aware pricing:** base × (current_iv / 33%)^0.7 (continuous adjustment)
- **Regime overlay:** ×1.0 / ×1.4 / ×2.0 / pause for calm/moderate/elevated/stress
- **Bullish bid-ask uplift:** 5-12% above mid (calibrated from live Bullish data 2026-05-16)
- **Retained-TP simulation:** post-exit 12-rule curve (rules 1, 5, 7, 12, W1)
- **Selection-bias trigger multiplier:** 2.0× statistical baseline (Foxify entry-timing)
- **Hold model:** premium-ratio (Foxify holds until premium accrued ≈ 30% of payout)

## Cell base prices (calm regime, anchored to live Bullish)

| Cell | Notional | Trigger | Payout | **Calm $/day** | Tenor |
|---|---|---|---|---|---|
| ss_50k_2pct_1k | $50,000 | ±2% | $1,000 | **$310** | 3d |
| ss_50k_5pct_2_5k | $50,000 | ±5% | $2,500 | **$140** | 3d |
| ss_50k_7pct_3_5k | $50,000 | ±7% | $3,500 | **$310** | 6d |
| ss_200k_5pct_10k | $200,000 | ±5% | $10,000 | **$600** | 3d |
| ss_200k_7pct_14k | $200,000 | ±7% | $14,000 | **$1250** | 6d |

## Per-cell EV at base price (real Bullish, 2.0× trigger bias, premium_ratio hold)

| Cell | Total covers | Avg P&L | Calm avg | Mod avg | Elev avg | Stress | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|---|
| ss_50k_2pct_1k | 1356 | +$     28 | +$     78 | $   -139 | $    -31 | paused |    31% |    36% |
| ss_50k_5pct_2_5k | 1356 | $   -246 | $   -123 | $   -561 | $   -608 | paused |    55% |    19% |
| ss_50k_7pct_3_5k | 1347 | +$    514 | +$    707 | +$     56 | $   -120 | paused |    78% |    11% |
| ss_200k_5pct_10k | 1356 | $   -649 | $   -330 | $   -884 | $  -2888 | paused |    71% |    17% |
| ss_200k_7pct_14k | 1347 | +$   2114 | +$   2922 | +$    621 | $  -1483 | paused |    78% |    12% |

## Uplift sensitivity (overall avg P&L vs base price)

| Cell | -25% | -10% | base | +10% | +25% | +50% |
|---|---|---|---|---|---|---|
| ss_50k_2pct_1k | $  -168 | $   -81 | $    -7 | +$   114 | +$   104 | +$   229 |
| ss_50k_5pct_2_5k | $  -378 | $  -320 | $  -277 | $  -162 | $   -43 | +$     5 |
| ss_50k_7pct_3_5k | +$   320 | +$   474 | +$   497 | +$   647 | +$   656 | +$   588 |
| ss_200k_5pct_10k | $ -1610 | $ -1047 | $  -536 | $  -323 | $  -210 | +$   273 |
| ss_200k_7pct_14k | +$  1331 | +$  2027 | +$  2139 | +$  2210 | +$  2780 | +$  2403 |

## Detailed per-cell sweep

### ss_50k_2pct_1k ($310/day base, 3d tenor)

**Per-regime detail at base price:**

| Regime | Cnt | Triggered | Avg P&L | Median | Worst | Best | %Profit |
|---|---|---|---|---|---|---|---|
| calm | 987 | 334 (   34%) | +$     78 | $   -397 | $  -1646 | +$  15371 |    31% |
| moderate | 255 | 117 (   46%) | $   -139 | $   -620 | $  -2155 | +$   7527 |    31% |
| elevated | 114 | 39 (   34%) | $    -31 | $   -652 | $  -2136 | +$   3835 |    31% |

**Price sensitivity sweep (overall avg P&L per cover):**

| Uplift | Price/day | Avg P&L | Median | Worst | Best | %Profit | Total P&L |
|---|---|---|---|---|---|---|---|
| -25% | $233 | $   -168 | $   -533 | $  -2752 | +$   9304 |    26% | $-227964 |
| -10% | $279 | $    -81 | $   -476 | $  -2589 | +$  15338 |    28% | $-109737 |
| +0% | $310 | $     -7 | $   -437 | $  -2479 | +$  15371 |    31% | $  -9596 |
| +10% | $341 | +$    114 | $   -387 | $  -2398 | +$  15403 |    32% | +$ 154535 |
| +25% | $388 | +$    104 | $   -348 | $  -2201 | +$  15452 |    33% | +$ 141354 |
| +50% | $465 | +$    229 | $   -222 | $  -1992 | +$  15532 |    39% | +$ 310984 |

### ss_50k_5pct_2_5k ($140/day base, 3d tenor)

**Per-regime detail at base price:**

| Regime | Cnt | Triggered | Avg P&L | Median | Worst | Best | %Profit |
|---|---|---|---|---|---|---|---|
| calm | 987 | 170 (   17%) | $   -123 | +$     15 | $  -2723 | +$  15274 |    70% |
| moderate | 255 | 56 (   22%) | $   -561 | $   -395 | $  -3402 | +$   6034 |     5% |
| elevated | 114 | 32 (   28%) | $   -608 | $   -738 | $  -3725 | +$   1467 |    32% |

**Price sensitivity sweep (overall avg P&L per cover):**

| Uplift | Price/day | Avg P&L | Median | Worst | Best | %Profit | Total P&L |
|---|---|---|---|---|---|---|---|
| -25% | $105 | $   -378 | $   -104 | $  -3864 | +$  15237 |     6% | $-511992 |
| -10% | $126 | $   -320 | $    -39 | $  -3688 | +$  15259 |    31% | $-433690 |
| +0% | $140 | $   -277 | +$      5 | $  -3637 | +$  15274 |    54% | $-375821 |
| +10% | $154 | $   -162 | +$     52 | $  -4085 | +$  15288 |    70% | $-220298 |
| +25% | $175 | $    -43 | +$    121 | $  -4063 | +$  15310 |    72% | $ -58685 |
| +50% | $210 | +$      5 | +$    225 | $  -3993 | +$  15346 |    72% | +$   6560 |

### ss_50k_7pct_3_5k ($310/day base, 6d tenor)

**Per-regime detail at base price:**

| Regime | Cnt | Triggered | Avg P&L | Median | Worst | Best | %Profit |
|---|---|---|---|---|---|---|---|
| calm | 978 | 110 (   11%) | +$    707 | +$    445 | $  -3628 | +$  23998 |    92% |
| moderate | 255 | 32 (   13%) | +$     56 | $   -236 | $  -4070 | +$   5969 |    40% |
| elevated | 114 | 9 (    8%) | $   -120 | $   -770 | $  -3878 | +$   4389 |    39% |

**Price sensitivity sweep (overall avg P&L per cover):**

| Uplift | Price/day | Avg P&L | Median | Worst | Best | %Profit | Total P&L |
|---|---|---|---|---|---|---|---|
| -25% | $233 | +$    320 | +$    390 | $  -6271 | +$  11157 |    76% | +$ 430686 |
| -10% | $279 | +$    474 | +$    564 | $  -5694 | +$  11301 |    75% | +$ 638089 |
| +0% | $310 | +$    497 | +$    433 | $  -4464 | +$  23998 |    77% | +$ 670095 |
| +10% | $341 | +$    647 | +$    529 | $  -4477 | +$  12951 |    80% | +$ 871067 |
| +25% | $388 | +$    656 | +$    672 | $  -5307 | +$  24241 |    79% | +$ 883008 |
| +50% | $465 | +$    588 | +$    470 | $  -5033 | +$  11804 |    81% | +$ 792072 |

### ss_200k_5pct_10k ($600/day base, 3d tenor)

**Per-regime detail at base price:**

| Regime | Cnt | Triggered | Avg P&L | Median | Worst | Best | %Profit |
|---|---|---|---|---|---|---|---|
| calm | 987 | 173 (   18%) | $   -330 | +$    203 | $ -10852 | +$  60099 |    87% |
| moderate | 255 | 53 (   21%) | $   -884 | $  -1389 | $ -13307 | +$  23298 |    29% |
| elevated | 114 | 9 (    8%) | $  -2888 | $  -4801 | $ -14582 | +$  14019 |    21% |

**Price sensitivity sweep (overall avg P&L per cover):**

| Uplift | Price/day | Avg P&L | Median | Worst | Best | %Profit | Total P&L |
|---|---|---|---|---|---|---|---|
| -25% | $450 | $  -1610 | $   -277 | $ -15758 | +$  59943 |     6% | $-2183179 |
| -10% | $540 | $  -1047 | +$      6 | $ -13428 | +$  60036 |    53% | $-1419999 |
| +0% | $600 | $   -536 | +$    197 | $ -16801 | +$  60099 |    71% | $-726425 |
| +10% | $660 | $   -323 | +$    383 | $ -14588 | +$  60161 |    71% | $-437952 |
| +25% | $750 | $   -210 | +$    662 | $ -16290 | +$  60255 |    71% | $-284829 |
| +50% | $900 | +$    273 | +$   1133 | $ -15572 | +$  60412 |    74% | +$ 370579 |

### ss_200k_7pct_14k ($1250/day base, 6d tenor)

**Per-regime detail at base price:**

| Regime | Cnt | Triggered | Avg P&L | Median | Worst | Best | %Profit |
|---|---|---|---|---|---|---|---|
| calm | 978 | 114 (   12%) | +$   2922 | +$   1853 | $ -14482 | +$  96022 |    93% |
| moderate | 255 | 34 (   13%) | +$    621 | $   -571 | $ -17254 | +$  36496 |    41% |
| elevated | 114 | 10 (    9%) | $  -1483 | $  -2760 | $ -23569 | +$  17347 |    34% |

**Price sensitivity sweep (overall avg P&L per cover):**

| Uplift | Price/day | Avg P&L | Median | Worst | Best | %Profit | Total P&L |
|---|---|---|---|---|---|---|---|
| -25% | $938 | +$   1331 | +$   1629 | $ -20363 | +$  42447 |    74% | +$1792702 |
| -10% | $1125 | +$   2027 | +$   2463 | $ -18397 | +$  43032 |    75% | +$2730091 |
| +0% | $1250 | +$   2139 | +$   1819 | $ -17512 | +$  96022 |    77% | +$2880596 |
| +10% | $1375 | +$   2210 | +$   2185 | $ -17294 | +$  51839 |    79% | +$2977507 |
| +25% | $1563 | +$   2780 | +$   2799 | $ -23258 | +$  97000 |    77% | +$3744854 |
| +50% | $1875 | +$   2403 | +$   1999 | $ -22150 | +$  46733 |    81% | +$3236499 |

## Honest read

- **Profitable at base price:** ss_50k_2pct_1k, ss_50k_7pct_3_5k, ss_200k_7pct_14k
- **Losing at base price:** ss_50k_5pct_2_5k, ss_200k_5pct_10k — see uplift sweep for breakeven price

Headlines:
- 200k/5%/$10k average P&L per cover at $600/day base: $   -649
- 50k/2%/$1k (legacy comparison) at $310/day base: +$     28

## Sensitivity to assumptions

Run with different selection-bias trigger multipliers + hold models to test robustness:

| Scenario | 200k/5% Avg P&L | Trigger rate |
|---|---|---|
| 1.0× bias, 1d hold | $    -83 |     5% |
| 1.0× bias, 2d hold | +$    284 |    11% |
| 1.0× bias, 3d hold | $   -451 |    18% |
| 1.0× bias, P/Po=0.3 | $   -187 |    13% |
| 2.0× bias, 1d hold | $   -387 |     8% |
| 2.0× bias, 2d hold | $    -66 |    17% |
| 2.0× bias, 3d hold | $  -1011 |    19% |
| 2.0× bias, P/Po=0.3 | $   -609 |    18% |
| 3.0× bias, 1d hold | $   -713 |    13% |
| 3.0× bias, 2d hold | $   -542 |    19% |
| 3.0× bias, 3d hold | $  -1422 |    26% |
| 3.0× bias, P/Po=0.3 | $   -986 |    22% |

---
*Generated by services/api/scripts/backtest/singleSide/runReport.ts*
*Pricing anchored to live Bullish data 2026-05-16 (BULLISH_LIVE_PRICING_REPORT.md).*