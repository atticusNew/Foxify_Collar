# Volume Cover Backtest — P2 Revised Harness Report

**Generated:** 2026-05-17T19:21:15.666Z
**Data:** 486 BTC daily OHLC candles (2025-01-15 → 2026-05-16), Coinbase
**Regime distribution:** 73% calm / 19% moderate / 8% elevated / 0% stress

## Methodology — production-faithful (P1a-P1g)

- **Hedge tenor:** 14-day matched (P1a) — single hedge per cover, no rollover
- **Sizing:** payout / intrinsic_at_trigger × vol-buffer (P1c) — 1.00× calm / 1.05× moderate / 1.10× elevated / 1.15× stress
- **Strikes:** snapped toward spot, inside trigger band; Bullish $200 grid (2%/5% cells) + Deribit $1000 grid (10%/15% cells)
- **Premium accrual:** proportional — `dailyPremium × actualDaysHeld` (P1d)
- **Atticus retention:** post-trigger AND post-Foxify-close legs retained (P1b)
- **TP rules (stub):** rule 1 (4h-to-expiry forced exit), rule 7 (loser <20% or 4h grace), rule 12 (10% hard floor), W1 (winner 24h timecap)
- **Ladder netting:** 60% of closes followed by 30-min reopen; matched legs repurposed (≈40% hedge-cost savings on match)
- **Hold model:** exponential mean 3 days, capped at 14

## Locked launch prices (operator commitment 2026-05-16)

| Cell | Notional | Trigger | Payout | **Calm $/day (LOCKED)** |
|---|---|---|---|---|
| 50k_2pct_1k | $50,000 | ±2% | $1,000 | **$350** |
| 50k_5pct_2_5k | $50,000 | ±5% | $2,500 | **$200** |
| 50k_10pct_5k | $50,000 | ±10% | $5,000 | **$100** |
| 200k_5pct_10k | $200,000 | ±5% | $10,000 | **$800** |
| 200k_10pct_20k | $200,000 | ±10% | $20,000 | **$400** |
| 200k_15pct_30k | $200,000 | ±15% | $30,000 | **$370** |

## Per-cell EV at base price (current matrix, all regimes)

Reading: per-cover Atticus net P&L. Negative ⇒ losing money at base price.

| Cell | Calm $ | Moderate | Elevated | Stress | Calm Avg | Mod Avg | Elev Avg | Stress Avg | %Profit calm | Trig calm |
|---|---|---|---|---|---|---|---|---|---|---|
| 50k_2pct_1k | $350 | $350 | $350 | $350 | +$   1055 | +$   1269 | +$   1376 | +$      0 |    73% |    76% |
| 50k_5pct_2_5k | $200 | $200 | $200 | $200 | +$    983 | +$   1169 | +$    995 | +$      0 |    71% |    27% |
| 50k_10pct_5k | $100 | $100 | $100 | $100 | +$    578 | +$    605 | +$    652 | +$      0 |    72% |     9% |
| 200k_5pct_10k | $800 | $800 | $800 | $800 | +$   3872 | +$   4163 | +$   5417 | +$      0 |    71% |    27% |
| 200k_10pct_20k | $400 | $400 | $400 | $400 | +$   2642 | +$   2357 | +$   3850 | +$      0 |    75% |     8% |
| 200k_15pct_30k | $370 | $370 | $370 | $370 | +$   2505 | +$   2732 | +$   2386 | +$      0 |    81% |     2% |

## Recommended regime overlay tiers (per cell)

Selection rule: smallest uplift that lands the per-regime avg P&L >= +$50 (light buffer over breakeven).

| Cell | Calm (LOCKED) | Moderate | Elevated | Stress | Calm head-start (hot-fix) |
|---|---|---|---|---|---|
| 50k_2pct_1k | $350 | $420 (avg +$   1560) | $525 (avg +$   2195) | $700 (avg +$      0) | $420 (avg +$   1101) |
| 50k_5pct_2_5k | $200 | $240 (avg +$   1128) | $300 (avg +$   1567) | $400 (avg +$      0) | $240 (avg +$   1127) |
| 50k_10pct_5k | $100 | $120 (avg +$    764) | $150 (avg +$    946) | $200 (avg +$      0) | $120 (avg +$    718) |
| 200k_5pct_10k | $800 | $960 (avg +$   4509) | $1200 (avg +$   4824) | $1600 (avg +$      0) | $960 (avg +$   4245) |
| 200k_10pct_20k | $400 | $480 (avg +$   3330) | $600 (avg +$   3155) | $800 (avg +$      0) | $480 (avg +$   2783) |
| 200k_15pct_30k | $370 | $444 (avg +$   3316) | $555 (avg +$   2298) | $740 (avg +$      0) | $444 (avg +$   2773) |

*Calm head-start price is the lever for first platform-stop hot-fix per operator's ask 2026-05-16.*

## Detailed uplift sweeps

### 50k_2pct_1k

Base $350/day. Calm distribution (regime samples, BS-priced retained TP).

**Moderate uplift sweep (P&L per cover, moderate regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +20% | $420 | +$   1560 | +$   2152 | $  -1298 | +$   7437 |    66% |    82% |
| +30% | $455 | +$   1657 | +$   2219 | $  -1263 | +$   8482 |    70% |    85% |
| +40% | $490 | +$   1706 | +$   2292 | $  -1228 | +$   7647 |    68% |    82% |

**Elevated uplift sweep (P&L per cover, elevated regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +50% | $525 | +$   2195 | +$   3518 | $  -1505 | +$   5068 |    64% |    83% |
| +75% | $613 | +$   2237 | +$   3624 | $  -1417 | +$   5091 |    63% |    84% |
| +100% | $700 | +$   2389 | +$   3711 | $  -1330 | +$   5418 |    67% |    85% |

*No stress regime samples in 487-day window (BTC didn't cross 90% annualized vol).*

**Calm head-start sweep — what calm SHOULD be (operator hot-fix lever):**

| Uplift | Price/day | Avg | Median | Worst | %Profit | Trigger rate |
|---|---|---|---|---|---|---|
| +20% | $420 | +$   1101 | +$   1128 | $  -2801 |    74% |    76% |
| +40% | $490 | +$   1326 | +$   1321 | $  -2731 |    80% |    77% |
| +60% | $560 | +$   1353 | +$   1390 | $  -2661 |    80% |    78% |

### 50k_5pct_2_5k

Base $200/day. Calm distribution (regime samples, BS-priced retained TP).

**Moderate uplift sweep (P&L per cover, moderate regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +20% | $240 | +$   1128 | +$   1117 | $  -3619 | +$   7507 |    65% |    38% |
| +30% | $260 | +$   1155 | +$   1210 | $  -4533 | +$   7916 |    64% |    37% |
| +40% | $280 | +$   1329 | +$   1434 | $  -3459 | +$   7827 |    70% |    37% |

**Elevated uplift sweep (P&L per cover, elevated regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +50% | $300 | +$   1567 | +$   2112 | $  -4669 | +$   7254 |    67% |    46% |
| +75% | $350 | +$   1009 | +$   1580 | $  -3808 | +$   5486 |    60% |    54% |
| +100% | $400 | +$   1330 | +$   2006 | $  -3608 | +$   5936 |    61% |    48% |

*No stress regime samples in 487-day window (BTC didn't cross 90% annualized vol).*

**Calm head-start sweep — what calm SHOULD be (operator hot-fix lever):**

| Uplift | Price/day | Avg | Median | Worst | %Profit | Trigger rate |
|---|---|---|---|---|---|---|
| +20% | $240 | +$   1127 | +$   1331 | $  -4213 |    74% |    27% |
| +40% | $280 | +$   1273 | +$   1429 | $  -3259 |    78% |    25% |
| +60% | $320 | +$   1132 | +$   1450 | $  -3840 |    77% |    28% |

### 50k_10pct_5k

Base $100/day. Calm distribution (regime samples, BS-priced retained TP).

**Moderate uplift sweep (P&L per cover, moderate regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +20% | $120 | +$    764 | +$   1218 | $  -6911 | +$   5680 |    65% |    10% |
| +30% | $130 | +$    633 | +$    928 | $  -6217 | +$   5690 |    61% |    11% |
| +40% | $140 | +$    796 | +$    913 | $  -6133 | +$   5873 |    63% |     7% |

**Elevated uplift sweep (P&L per cover, elevated regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +50% | $150 | +$    946 | +$   1648 | $  -6359 | +$   4907 |    62% |     4% |
| +75% | $175 | +$    637 | +$    503 | $  -6567 | +$   4346 |    50% |     4% |
| +100% | $200 | +$   1257 | +$   2236 | $  -4908 | +$   4371 |    67% |     2% |

*No stress regime samples in 487-day window (BTC didn't cross 90% annualized vol).*

**Calm head-start sweep — what calm SHOULD be (operator hot-fix lever):**

| Uplift | Price/day | Avg | Median | Worst | %Profit | Trigger rate |
|---|---|---|---|---|---|---|
| +20% | $120 | +$    718 | +$    677 | $  -5921 |    75% |     8% |
| +40% | $140 | +$    726 | +$    679 | $  -5901 |    74% |     9% |
| +60% | $160 | +$    776 | +$    741 | $  -5881 |    78% |     8% |

### 200k_5pct_10k

Base $800/day. Calm distribution (regime samples, BS-priced retained TP).

**Moderate uplift sweep (P&L per cover, moderate regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +20% | $960 | +$   4509 | +$   4645 | $ -14827 | +$  28880 |    63% |    35% |
| +30% | $1040 | +$   5278 | +$   7308 | $ -16635 | +$  30450 |    70% |    36% |
| +40% | $1120 | +$   4257 | +$   4462 | $ -13835 | +$  33442 |    65% |    40% |

**Elevated uplift sweep (P&L per cover, elevated regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +50% | $1200 | +$   4824 | +$   7357 | $ -17509 | +$  23319 |    68% |    53% |
| +75% | $1400 | +$   5288 | +$   8024 | $ -17285 | +$  23519 |    60% |    41% |
| +100% | $1600 | +$   4742 | +$   8275 | $ -16502 | +$  23585 |    58% |    51% |

*No stress regime samples in 487-day window (BTC didn't cross 90% annualized vol).*

**Calm head-start sweep — what calm SHOULD be (operator hot-fix lever):**

| Uplift | Price/day | Avg | Median | Worst | %Profit | Trigger rate |
|---|---|---|---|---|---|---|
| +20% | $960 | +$   4245 | +$   5206 | $ -16722 |    72% |    27% |
| +40% | $1120 | +$   4444 | +$   5513 | $ -15840 |    75% |    26% |
| +60% | $1280 | +$   5047 | +$   5792 | $ -16402 |    79% |    28% |

### 200k_10pct_20k

Base $400/day. Calm distribution (regime samples, BS-priced retained TP).

**Moderate uplift sweep (P&L per cover, moderate regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +20% | $480 | +$   3330 | +$   5645 | $ -27011 | +$  21865 |    65% |     9% |
| +30% | $520 | +$   3668 | +$   4971 | $ -16287 | +$  26594 |    69% |     9% |
| +40% | $560 | +$   3256 | +$   4896 | $ -33302 | +$  21574 |    67% |     9% |

**Elevated uplift sweep (P&L per cover, elevated regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +50% | $600 | +$   3155 | +$   6601 | $ -22716 | +$  16063 |    56% |     4% |
| +75% | $700 | +$   3989 | +$   8355 | $ -24885 | +$  16689 |    67% |     4% |
| +100% | $800 | +$   4561 | +$   6640 | $ -12364 | +$  22705 |    60% |     4% |

*No stress regime samples in 487-day window (BTC didn't cross 90% annualized vol).*

**Calm head-start sweep — what calm SHOULD be (operator hot-fix lever):**

| Uplift | Price/day | Avg | Median | Worst | %Profit | Trigger rate |
|---|---|---|---|---|---|---|
| +20% | $480 | +$   2783 | +$   2611 | $ -23597 |    76% |     8% |
| +40% | $560 | +$   2680 | +$   2707 | $ -23517 |    74% |     9% |
| +60% | $640 | +$   3098 | +$   2917 | $ -21409 |    78% |     8% |

### 200k_15pct_30k

Base $370/day. Calm distribution (regime samples, BS-priced retained TP).

**Moderate uplift sweep (P&L per cover, moderate regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +20% | $444 | +$   3316 | +$   3641 | $  -9388 | +$  23866 |    72% |     0% |
| +30% | $481 | +$   3180 | +$   3922 | $ -31820 | +$  24695 |    68% |     0% |
| +40% | $518 | +$   3135 | +$   3711 | $  -8510 | +$  19329 |    71% |     0% |

**Elevated uplift sweep (P&L per cover, elevated regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +50% | $555 | +$   2298 | +$   4583 | $ -12614 | +$  12990 |    58% |     0% |
| +75% | $648 | +$   3348 | +$   6284 | $ -18715 | +$  14240 |    63% |     0% |
| +100% | $740 | +$   3256 | +$   4803 | $ -13246 | +$  13492 |    64% |     0% |

*No stress regime samples in 487-day window (BTC didn't cross 90% annualized vol).*

**Calm head-start sweep — what calm SHOULD be (operator hot-fix lever):**

| Uplift | Price/day | Avg | Median | Worst | %Profit | Trigger rate |
|---|---|---|---|---|---|---|
| +20% | $444 | +$   2773 | +$   1645 | $ -22901 |    82% |     2% |
| +40% | $518 | +$   2611 | +$   1819 | $ -25740 |    84% |     2% |
| +60% | $592 | +$   2841 | +$   2032 | $ -25592 |    86% |     2% |

## Honest read

At LOCKED calm-base prices (no overlays applied):

- **Profitable in calm:** 50k_2pct_1k, 50k_5pct_2_5k, 50k_10pct_5k, 200k_5pct_10k, 200k_10pct_20k, 200k_15pct_30k

Phase 1 retention + ladder netting + production-faithful sizing materially change economics vs the deprecated harnesses #21/#22 which:
- Used immediate-sell-at-trigger-spot (no retained TP capture)
- Sized hedge at 1× notional instead of payout/intrinsic
- Did not model ladder netting savings

The operator's calm head-start prices (above) are the lever to keep ready for the first platform-stop event so the hot-fix is data-driven, not reactive.

## Next steps

1. Operator + CEO review recommended overlay prices (moderate/elevated/stress).
2. Approved overlays deployed via env at Hour 48-72.
3. Calm head-start values stay armed for first platform-stop hot-fix.
4. Re-run this harness post-launch with real Day-1 trade data; compare to projection.

---
*Generated by services/api/scripts/backtest/volumeCover/runReport.ts*