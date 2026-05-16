# Single-Side Pilot Relaunch — Backtest Report

**Generated:** 2026-05-16T17:27:18.339Z
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
| ss_50k_2pct_1k | 1356 | +$     23 | +$    102 | $   -201 | $   -157 | paused |    30% |    35% |
| ss_50k_5pct_2_5k | 1356 | $   -235 | $   -104 | $   -635 | $   -471 | paused |    54% |    21% |
| ss_50k_7pct_3_5k | 1347 | +$    564 | +$    743 | +$    207 | $   -172 | paused |    78% |    10% |
| ss_200k_5pct_10k | 1356 | $   -572 | $   -297 | $  -1138 | $  -1692 | paused |    71% |    17% |
| ss_200k_7pct_14k | 1347 | +$   2092 | +$   2884 | +$     13 | $    -48 | paused |    77% |    12% |

## Uplift sensitivity (overall avg P&L vs base price)

| Cell | -25% | -10% | base | +10% | +25% | +50% |
|---|---|---|---|---|---|---|
| ss_50k_2pct_1k | $  -145 | $   -38 | +$    22 | +$    74 | +$   147 | +$   212 |
| ss_50k_5pct_2_5k | $  -358 | $  -311 | $  -245 | $  -170 | $   -75 | +$    15 |
| ss_50k_7pct_3_5k | +$   369 | +$   528 | +$   528 | +$   631 | +$   752 | +$   610 |
| ss_200k_5pct_10k | $ -1391 | $ -1062 | $  -720 | $  -623 | $  -150 | +$   302 |
| ss_200k_7pct_14k | +$  1248 | +$  2085 | +$  2221 | +$  2536 | +$  2575 | +$  2392 |

## Detailed per-cell sweep

### ss_50k_2pct_1k ($310/day base, 3d tenor)

**Per-regime detail at base price:**

| Regime | Cnt | Triggered | Avg P&L | Median | Worst | Best | %Profit |
|---|---|---|---|---|---|---|---|
| calm | 987 | 313 (   32%) | +$    102 | $   -391 | $  -1646 | +$  15371 |    30% |
| moderate | 255 | 110 (   43%) | $   -201 | $   -620 | $  -2115 | +$   7527 |    30% |
| elevated | 114 | 45 (   39%) | $   -157 | $   -652 | $  -2479 | +$   3835 |    29% |

**Price sensitivity sweep (overall avg P&L per cover):**

| Uplift | Price/day | Avg P&L | Median | Worst | Best | %Profit | Total P&L |
|---|---|---|---|---|---|---|---|
| -25% | $233 | $   -145 | $   -512 | $  -2752 | +$  15290 |    27% | $-196376 |
| -10% | $279 | $    -38 | $   -448 | $  -2474 | +$  15338 |    30% | $ -52050 |
| +0% | $310 | +$     22 | $   -398 | $  -2623 | +$  15371 |    31% | +$  30148 |
| +10% | $341 | +$     74 | $   -388 | $  -2368 | +$  15403 |    31% | +$ 100327 |
| +25% | $388 | +$    147 | $   -312 | $  -2201 | +$  15452 |    35% | +$ 199211 |
| +50% | $465 | +$    212 | $   -230 | $  -2072 | +$  15532 |    39% | +$ 287476 |

### ss_50k_5pct_2_5k ($140/day base, 3d tenor)

**Per-regime detail at base price:**

| Regime | Cnt | Triggered | Avg P&L | Median | Worst | Best | %Profit |
|---|---|---|---|---|---|---|---|
| calm | 987 | 186 (   19%) | $   -104 | +$     14 | $  -2723 | +$  15274 |    69% |
| moderate | 255 | 66 (   26%) | $   -635 | $   -400 | $  -3402 | +$   6034 |     6% |
| elevated | 114 | 35 (   31%) | $   -471 | $   -421 | $  -3611 | +$   1467 |    37% |

**Price sensitivity sweep (overall avg P&L per cover):**

| Uplift | Price/day | Avg P&L | Median | Worst | Best | %Profit | Total P&L |
|---|---|---|---|---|---|---|---|
| -25% | $105 | $   -358 | $   -104 | $  -3472 | +$  15237 |     7% | $-485977 |
| -10% | $126 | $   -311 | $    -38 | $  -3875 | +$  15259 |    31% | $-421782 |
| +0% | $140 | $   -245 | +$      5 | $  -3653 | +$  15274 |    55% | $-331543 |
| +10% | $154 | $   -170 | +$     53 | $  -4134 | +$  15288 |    70% | $-231087 |
| +25% | $175 | $    -75 | +$    116 | $  -4060 | +$  15310 |    71% | $-102114 |
| +50% | $210 | +$     15 | +$    227 | $  -3777 | +$  15346 |    73% | +$  20272 |

### ss_50k_7pct_3_5k ($310/day base, 6d tenor)

**Per-regime detail at base price:**

| Regime | Cnt | Triggered | Avg P&L | Median | Worst | Best | %Profit |
|---|---|---|---|---|---|---|---|
| calm | 978 | 110 (   11%) | +$    743 | +$    449 | $  -3628 | +$  23998 |    93% |
| moderate | 255 | 25 (   10%) | +$    207 | $   -238 | $  -4275 | +$   7933 |    39% |
| elevated | 114 | 4 (    4%) | $   -172 | $   -671 | $  -3878 | +$   4389 |    40% |

**Price sensitivity sweep (overall avg P&L per cover):**

| Uplift | Price/day | Avg P&L | Median | Worst | Best | %Profit | Total P&L |
|---|---|---|---|---|---|---|---|
| -25% | $233 | +$    369 | +$    399 | $  -6255 | +$  11157 |    76% | +$ 497475 |
| -10% | $279 | +$    528 | +$    554 | $  -5902 | +$  11301 |    76% | +$ 710951 |
| +0% | $310 | +$    528 | +$    434 | $  -6069 | +$  23998 |    78% | +$ 710959 |
| +10% | $341 | +$    631 | +$    529 | $  -5682 | +$  24095 |    79% | +$ 850309 |
| +25% | $388 | +$    752 | +$    678 | $  -5515 | +$  24241 |    79% | +$1012354 |
| +50% | $465 | +$    610 | +$    486 | $  -5044 | +$  11804 |    82% | +$ 821367 |

### ss_200k_5pct_10k ($600/day base, 3d tenor)

**Per-regime detail at base price:**

| Regime | Cnt | Triggered | Avg P&L | Median | Worst | Best | %Profit |
|---|---|---|---|---|---|---|---|
| calm | 987 | 162 (   16%) | $   -297 | +$    202 | $ -10852 | +$  34261 |    88% |
| moderate | 255 | 58 (   23%) | $  -1138 | $  -1444 | $ -13307 | +$  23298 |    26% |
| elevated | 114 | 8 (    7%) | $  -1692 | $  -3305 | $ -16761 | +$  14019 |    30% |

**Price sensitivity sweep (overall avg P&L per cover):**

| Uplift | Price/day | Avg P&L | Median | Worst | Best | %Profit | Total P&L |
|---|---|---|---|---|---|---|---|
| -25% | $450 | $  -1391 | $   -277 | $ -13608 | +$  59943 |     7% | $-1886429 |
| -10% | $540 | $  -1062 | +$      3 | $ -15056 | +$  60036 |    52% | $-1440325 |
| +0% | $600 | $   -720 | +$    194 | $ -13307 | +$  60099 |    69% | $-975913 |
| +10% | $660 | $   -623 | +$    379 | $ -15446 | +$  60161 |    70% | $-844750 |
| +25% | $750 | $   -150 | +$    664 | $ -15749 | +$  60255 |    72% | $-203741 |
| +50% | $900 | +$    302 | +$   1133 | $ -12707 | +$  60412 |    75% | +$ 409907 |

### ss_200k_7pct_14k ($1250/day base, 6d tenor)

**Per-regime detail at base price:**

| Regime | Cnt | Triggered | Avg P&L | Median | Worst | Best | %Profit |
|---|---|---|---|---|---|---|---|
| calm | 978 | 118 (   12%) | +$   2884 | +$   1853 | $ -14482 | +$  96022 |    92% |
| moderate | 255 | 33 (   13%) | +$     13 | $   -929 | $ -17512 | +$  38083 |    35% |
| elevated | 114 | 9 (    8%) | $    -48 | $   -861 | $ -21562 | +$  17347 |    43% |

**Price sensitivity sweep (overall avg P&L per cover):**

| Uplift | Price/day | Avg P&L | Median | Worst | Best | %Profit | Total P&L |
|---|---|---|---|---|---|---|---|
| -25% | $938 | +$   1248 | +$   1561 | $ -23099 | +$  42447 |    73% | +$1681417 |
| -10% | $1125 | +$   2085 | +$   2344 | $ -22468 | +$  43032 |    76% | +$2808165 |
| +0% | $1250 | +$   2221 | +$   1821 | $ -17739 | +$  96022 |    78% | +$2991218 |
| +10% | $1375 | +$   2536 | +$   2211 | $ -22445 | +$  96412 |    79% | +$3416658 |
| +25% | $1563 | +$   2575 | +$   2786 | $ -18605 | +$  97000 |    78% | +$3468706 |
| +50% | $1875 | +$   2392 | +$   1995 | $ -17595 | +$  46733 |    81% | +$3221665 |

## Honest read

- **Profitable at base price:** ss_50k_2pct_1k, ss_50k_7pct_3_5k, ss_200k_7pct_14k
- **Losing at base price:** ss_50k_5pct_2_5k, ss_200k_5pct_10k — see uplift sweep for breakeven price

Headlines:
- 200k/5%/$10k average P&L per cover at $600/day base: $   -572
- 50k/2%/$1k (legacy comparison) at $310/day base: +$     23

## Sensitivity to assumptions

Run with different selection-bias trigger multipliers + hold models to test robustness:

| Scenario | 200k/5% Avg P&L | Trigger rate |
|---|---|---|
| 1.0× bias, 1d hold | +$    193 |     5% |
| 1.0× bias, 2d hold | +$    286 |    12% |
| 1.0× bias, 3d hold | $   -593 |    16% |
| 1.0× bias, P/Po=0.3 | $   -296 |    12% |
| 2.0× bias, 1d hold | $   -426 |     9% |
| 2.0× bias, 2d hold | $   -103 |    16% |
| 2.0× bias, 3d hold | $   -942 |    22% |
| 2.0× bias, P/Po=0.3 | $   -754 |    18% |
| 3.0× bias, 1d hold | $   -882 |    14% |
| 3.0× bias, 2d hold | $   -616 |    19% |
| 3.0× bias, 3d hold | $  -1543 |    26% |
| 3.0× bias, P/Po=0.3 | $  -1073 |    23% |

---
*Generated by services/api/scripts/backtest/singleSide/runReport.ts*
*Pricing anchored to live Bullish data 2026-05-16 (BULLISH_LIVE_PRICING_REPORT.md).*