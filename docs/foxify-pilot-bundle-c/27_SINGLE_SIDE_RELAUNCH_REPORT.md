# Single-Side Pilot Relaunch — Backtest Report

**Generated:** 2026-05-16T17:21:14.122Z
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
| ss_50k_2pct_1k | 1356 | +$     10 | +$     91 | $   -206 | $   -204 | paused |    32% |    33% |
| ss_50k_5pct_2_5k | 1356 | $   -282 | $   -142 | $   -689 | $   -590 | paused |    42% |    20% |
| ss_50k_7pct_3_5k | 1347 | +$    510 | +$    752 | +$    111 | $   -678 | paused |    72% |    12% |
| ss_200k_5pct_10k | 1356 | $   -924 | $   -386 | $  -1907 | $  -3381 | paused |    48% |    19% |
| ss_200k_7pct_14k | 1347 | +$   1939 | +$   2738 | +$    619 | $  -1961 | paused |    72% |    13% |

## Uplift sensitivity (overall avg P&L vs base price)

| Cell | -25% | -10% | base | +10% | +25% | +50% |
|---|---|---|---|---|---|---|
| ss_50k_2pct_1k | $   -64 | $   -84 | +$     1 | $    -2 | +$    90 | +$   224 |
| ss_50k_5pct_2_5k | $  -429 | $  -376 | $  -287 | $  -187 | $   -91 | $   -26 |
| ss_50k_7pct_3_5k | +$   290 | +$   545 | +$   532 | +$   597 | +$   532 | +$   652 |
| ss_200k_5pct_10k | $ -1812 | $ -1210 | $ -1027 | $  -622 | $  -430 | +$    76 |
| ss_200k_7pct_14k | +$  1113 | +$  1901 | +$  1826 | +$  2275 | +$  2082 | +$  2534 |

## Detailed per-cell sweep

### ss_50k_2pct_1k ($310/day base, 3d tenor)

**Per-regime detail at base price:**

| Regime | Cnt | Triggered | Avg P&L | Median | Worst | Best | %Profit |
|---|---|---|---|---|---|---|---|
| calm | 987 | 300 (   30%) | +$     91 | $   -295 | $  -1945 | +$  15045 |    33% |
| moderate | 255 | 97 (   38%) | $   -206 | $   -591 | $  -2360 | +$   7595 |    29% |
| elevated | 114 | 44 (   39%) | $   -204 | $   -730 | $  -2641 | +$   3723 |    33% |

**Price sensitivity sweep (overall avg P&L per cover):**

| Uplift | Price/day | Avg P&L | Median | Worst | Best | %Profit | Total P&L |
|---|---|---|---|---|---|---|---|
| -25% | $233 | $    -64 | $   -408 | $  -3129 | +$  14949 |    31% | $ -87288 |
| -10% | $279 | $    -84 | $   -384 | $  -2754 | +$   9211 |    30% | $-114270 |
| +0% | $310 | +$      1 | $   -365 | $  -2637 | +$  15045 |    31% | +$   1633 |
| +10% | $341 | $     -2 | $   -321 | $  -2520 | +$  15083 |    31% | $  -2352 |
| +25% | $388 | +$     90 | $   -278 | $  -2344 | +$  15142 |    32% | +$ 121408 |
| +50% | $465 | +$    224 | $   -175 | $  -2058 | +$   9422 |    39% | +$ 303527 |

### ss_50k_5pct_2_5k ($140/day base, 3d tenor)

**Per-regime detail at base price:**

| Regime | Cnt | Triggered | Avg P&L | Median | Worst | Best | %Profit |
|---|---|---|---|---|---|---|---|
| calm | 987 | 176 (   18%) | $   -142 | +$      9 | $  -3041 | +$  14957 |    53% |
| moderate | 255 | 71 (   28%) | $   -689 | $   -391 | $  -3488 | +$   6105 |     8% |
| elevated | 114 | 19 (   17%) | $   -590 | $   -904 | $  -4076 | +$   3294 |    28% |

**Price sensitivity sweep (overall avg P&L per cover):**

| Uplift | Price/day | Avg P&L | Median | Worst | Best | %Profit | Total P&L |
|---|---|---|---|---|---|---|---|
| -25% | $105 | $   -429 | $   -202 | $  -4264 | +$   8337 |    27% | $-581482 |
| -10% | $126 | $   -376 | $   -138 | $  -3998 | +$  14939 |    34% | $-510426 |
| +0% | $140 | $   -287 | $    -70 | $  -4525 | +$  14957 |    42% | $-389793 |
| +10% | $154 | $   -187 | $     -4 | $  -4330 | +$  14974 |    49% | $-253950 |
| +25% | $175 | $    -91 | +$     66 | $  -4287 | +$  15000 |    56% | $-122923 |
| +50% | $210 | $    -26 | +$    186 | $  -4264 | +$  15044 |    68% | $ -35239 |

### ss_50k_7pct_3_5k ($310/day base, 6d tenor)

**Per-regime detail at base price:**

| Regime | Cnt | Triggered | Avg P&L | Median | Worst | Best | %Profit |
|---|---|---|---|---|---|---|---|
| calm | 978 | 118 (   12%) | +$    752 | +$    503 | $  -3975 | +$  23640 |    86% |
| moderate | 255 | 36 (   14%) | +$    111 | $   -258 | $  -4372 | +$   9574 |    34% |
| elevated | 114 | 9 (    8%) | $   -678 | $  -1112 | $  -4680 | +$   4320 |    29% |

**Price sensitivity sweep (overall avg P&L per cover):**

| Uplift | Price/day | Avg P&L | Median | Worst | Best | %Profit | Total P&L |
|---|---|---|---|---|---|---|---|
| -25% | $233 | +$    290 | +$    350 | $  -6617 | +$  11251 |    68% | +$ 390764 |
| -10% | $279 | +$    545 | +$    538 | $  -4336 | +$  23526 |    69% | +$ 734723 |
| +0% | $310 | +$    532 | +$    435 | $  -6168 | +$  23640 |    73% | +$ 716343 |
| +10% | $341 | +$    597 | +$    543 | $  -5036 | +$  23754 |    74% | +$ 804330 |
| +25% | $388 | +$    532 | +$    646 | $  -4547 | +$  11709 |    70% | +$ 717191 |
| +50% | $465 | +$    652 | +$    520 | $  -4676 | +$  11636 |    78% | +$ 878906 |

### ss_200k_5pct_10k ($600/day base, 3d tenor)

**Per-regime detail at base price:**

| Regime | Cnt | Triggered | Avg P&L | Median | Worst | Best | %Profit |
|---|---|---|---|---|---|---|---|
| calm | 987 | 180 (   18%) | $   -386 | +$    217 | $ -12113 | +$  58861 |    60% |
| moderate | 255 | 59 (   23%) | $  -1907 | $  -1023 | $ -13319 | +$  23569 |    15% |
| elevated | 114 | 17 (   15%) | $  -3381 | $  -4702 | $ -16563 | +$  13329 |    21% |

**Price sensitivity sweep (overall avg P&L per cover):**

| Uplift | Price/day | Avg P&L | Median | Worst | Best | %Profit | Total P&L |
|---|---|---|---|---|---|---|---|
| -25% | $450 | $  -1812 | $   -647 | $ -17133 | +$  58674 |    29% | $-2457540 |
| -10% | $540 | $  -1210 | $   -322 | $ -17810 | +$  58786 |    42% | $-1640987 |
| +0% | $600 | $  -1027 | $   -114 | $ -18054 | +$  58861 |    47% | $-1392935 |
| +10% | $660 | $   -622 | +$    228 | $ -17613 | +$  58936 |    55% | $-842878 |
| +25% | $750 | $   -430 | +$    504 | $ -16644 | +$  59048 |    62% | $-582496 |
| +50% | $900 | +$     76 | +$    977 | $ -16443 | +$  59234 |    71% | +$ 103328 |

### ss_200k_7pct_14k ($1250/day base, 6d tenor)

**Per-regime detail at base price:**

| Regime | Cnt | Triggered | Avg P&L | Median | Worst | Best | %Profit |
|---|---|---|---|---|---|---|---|
| calm | 978 | 135 (   14%) | +$   2738 | +$   1966 | $ -15224 | +$  94597 |    86% |
| moderate | 255 | 31 (   12%) | +$    619 | $   -660 | $ -18580 | +$  36687 |    40% |
| elevated | 114 | 9 (    8%) | $  -1961 | $  -3329 | $ -24731 | +$  17087 |    32% |

**Price sensitivity sweep (overall avg P&L per cover):**

| Uplift | Price/day | Avg P&L | Median | Worst | Best | %Profit | Total P&L |
|---|---|---|---|---|---|---|---|
| -25% | $938 | +$   1113 | +$   1464 | $ -24453 | +$  42802 |    69% | +$1499101 |
| -10% | $1125 | +$   1901 | +$   2200 | $ -23809 | +$  94138 |    70% | +$2560029 |
| +0% | $1250 | +$   1826 | +$   1749 | $ -23050 | +$  94597 |    72% | +$2459922 |
| +10% | $1375 | +$   2275 | +$   2259 | $ -25639 | +$  51520 |    74% | +$3064910 |
| +25% | $1563 | +$   2082 | +$   2542 | $ -24926 | +$  45351 |    71% | +$2804661 |
| +50% | $1875 | +$   2534 | +$   2140 | $ -19887 | +$  46075 |    78% | +$3412734 |

## Honest read

- **Profitable at base price:** ss_50k_2pct_1k, ss_50k_7pct_3_5k, ss_200k_7pct_14k
- **Losing at base price:** ss_50k_5pct_2_5k, ss_200k_5pct_10k — see uplift sweep for breakeven price

Headlines:
- 200k/5%/$10k average P&L per cover at $600/day base: $   -924
- 50k/2%/$1k (legacy comparison) at $310/day base: +$     10

## Sensitivity to assumptions

Run with different selection-bias trigger multipliers + hold models to test robustness:

| Scenario | 200k/5% Avg P&L | Trigger rate |
|---|---|---|
| 1.0× bias, 1d hold | +$     17 |     5% |
| 1.0× bias, 2d hold | +$    124 |    10% |
| 1.0× bias, 3d hold | $   -750 |    16% |
| 1.0× bias, P/Po=0.3 | $   -467 |    13% |
| 2.0× bias, 1d hold | $   -486 |    10% |
| 2.0× bias, 2d hold | $   -209 |    16% |
| 2.0× bias, 3d hold | $  -1083 |    21% |
| 2.0× bias, P/Po=0.3 | $  -1050 |    20% |
| 3.0× bias, 1d hold | $   -969 |    14% |
| 3.0× bias, 2d hold | $   -780 |    20% |
| 3.0× bias, 3d hold | $  -1421 |    25% |
| 3.0× bias, P/Po=0.3 | $  -1410 |    23% |

---
*Generated by services/api/scripts/backtest/singleSide/runReport.ts*
*Pricing anchored to live Bullish data 2026-05-16 (BULLISH_LIVE_PRICING_REPORT.md).*