# Volume Cover Backtest — P2 Revised Harness Report

**Generated:** 2026-05-16T03:06:39.904Z
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
| 50k_2pct_1k | $350 | $350 | $350 | $350 | +$   1074 | +$   1347 | +$   2179 | +$      0 |    73% |    78% |
| 50k_5pct_2_5k | $200 | $200 | $200 | $200 | +$    985 | +$   1142 | +$    255 | +$      0 |    73% |    27% |
| 50k_10pct_5k | $100 | $100 | $100 | $100 | +$    651 | +$    829 | +$    369 | +$      0 |    73% |     7% |
| 200k_5pct_10k | $800 | $800 | $800 | $800 | +$   3738 | +$   5110 | +$   3608 | +$      0 |    71% |    27% |
| 200k_10pct_20k | $400 | $400 | $400 | $400 | +$   2548 | +$   3032 | +$   1908 | +$      0 |    74% |     8% |
| 200k_15pct_30k | $370 | $370 | $370 | $370 | +$   2246 | +$   2165 | +$    404 | +$      0 |    79% |     2% |

## Recommended regime overlay tiers (per cell)

Selection rule: smallest uplift that lands the per-regime avg P&L >= +$50 (light buffer over breakeven).

| Cell | Calm (LOCKED) | Moderate | Elevated | Stress | Calm head-start (hot-fix) |
|---|---|---|---|---|---|
| 50k_2pct_1k | $350 | $420 (avg +$   1582) | $525 (avg +$   1860) | $700 (avg +$      0) | $420 (avg +$   1151) |
| 50k_5pct_2_5k | $200 | $240 (avg +$   1340) | $300 (avg +$   1060) | $400 (avg +$      0) | $240 (avg +$   1118) |
| 50k_10pct_5k | $100 | $120 (avg +$    739) | $150 (avg +$   1293) | $200 (avg +$      0) | $120 (avg +$    635) |
| 200k_5pct_10k | $800 | $960 (avg +$   5021) | $1200 (avg +$   3829) | $1600 (avg +$      0) | $960 (avg +$   4371) |
| 200k_10pct_20k | $400 | $480 (avg +$   3490) | $600 (avg +$   5444) | $800 (avg +$      0) | $480 (avg +$   2732) |
| 200k_15pct_30k | $370 | $444 (avg +$   3136) | $555 (avg +$   2779) | $740 (avg +$      0) | $444 (avg +$   2358) |

*Calm head-start price is the lever for first platform-stop hot-fix per operator's ask 2026-05-16.*

## Detailed uplift sweeps

### 50k_2pct_1k

Base $350/day. Calm distribution (regime samples, BS-priced retained TP).

**Moderate uplift sweep (P&L per cover, moderate regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +20% | $420 | +$   1582 | +$   2161 | $  -1481 | +$   7458 |    66% |    84% |
| +30% | $455 | +$   1884 | +$   2381 | $  -1446 | +$   8393 |    73% |    85% |
| +40% | $490 | +$   1590 | +$   2261 | $  -1411 | +$   6841 |    66% |    84% |

**Elevated uplift sweep (P&L per cover, elevated regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +50% | $525 | +$   1860 | +$   3597 | $  -1639 | +$   5230 |    54% |    88% |
| +75% | $613 | +$   2248 | +$   3796 | $  -1551 | +$   5318 |    61% |    89% |
| +100% | $700 | +$   2621 | +$   4085 | $  -1464 | +$   5640 |    66% |    85% |

*No stress regime samples in 487-day window (BTC didn't cross 90% annualized vol).*

**Calm head-start sweep — what calm SHOULD be (operator hot-fix lever):**

| Uplift | Price/day | Avg | Median | Worst | %Profit | Trigger rate |
|---|---|---|---|---|---|---|
| +20% | $420 | +$   1151 | +$   1151 | $  -3034 |    75% |    76% |
| +40% | $490 | +$   1255 | +$   1260 | $  -2964 |    77% |    77% |
| +60% | $560 | +$   1319 | +$   1330 | $  -2894 |    78% |    78% |

### 50k_5pct_2_5k

Base $200/day. Calm distribution (regime samples, BS-priced retained TP).

**Moderate uplift sweep (P&L per cover, moderate regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +20% | $240 | +$   1340 | +$   1827 | $  -4217 | +$   7811 |    68% |    35% |
| +30% | $260 | +$   1118 | +$   1258 | $  -4135 | +$   8509 |    60% |    41% |
| +40% | $280 | +$   1262 | +$   1237 | $  -5742 | +$   7350 |    69% |    42% |

**Elevated uplift sweep (P&L per cover, elevated regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +50% | $300 | +$   1060 | +$   1689 | $  -4312 | +$   6155 |    58% |    49% |
| +75% | $350 | +$   1471 | +$   2374 | $  -4428 | +$   6205 |    62% |    47% |
| +100% | $400 | +$   1426 | +$   2252 | $  -4800 | +$   6255 |    59% |    44% |

*No stress regime samples in 487-day window (BTC didn't cross 90% annualized vol).*

**Calm head-start sweep — what calm SHOULD be (operator hot-fix lever):**

| Uplift | Price/day | Avg | Median | Worst | %Profit | Trigger rate |
|---|---|---|---|---|---|---|
| +20% | $240 | +$   1118 | +$   1191 | $  -4521 |    74% |    24% |
| +40% | $280 | +$   1234 | +$   1240 | $  -3763 |    78% |    27% |
| +60% | $320 | +$   1324 | +$   1407 | $  -4441 |    80% |    27% |

### 50k_10pct_5k

Base $100/day. Calm distribution (regime samples, BS-priced retained TP).

**Moderate uplift sweep (P&L per cover, moderate regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +20% | $120 | +$    739 | +$   1194 | $  -6459 | +$   5663 |    68% |     9% |
| +30% | $130 | +$   1047 | +$   1484 | $  -6073 | +$   5673 |    71% |     9% |
| +40% | $140 | +$    659 | +$   1087 | $  -6419 | +$   4591 |    64% |    10% |

**Elevated uplift sweep (P&L per cover, elevated regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +50% | $150 | +$   1293 | +$   1900 | $  -8023 | +$   6303 |    65% |     2% |
| +75% | $175 | +$   1025 | +$   1267 | $  -5634 | +$   6353 |    54% |     2% |
| +100% | $200 | +$   1179 | +$   2093 | $ -10341 | +$   6403 |    61% |     2% |

*No stress regime samples in 487-day window (BTC didn't cross 90% annualized vol).*

**Calm head-start sweep — what calm SHOULD be (operator hot-fix lever):**

| Uplift | Price/day | Avg | Median | Worst | %Profit | Trigger rate |
|---|---|---|---|---|---|---|
| +20% | $120 | +$    635 | +$    619 | $  -6155 |    74% |     8% |
| +40% | $140 | +$    690 | +$    659 | $  -6135 |    75% |     8% |
| +60% | $160 | +$    797 | +$    774 | $  -6115 |    79% |     8% |

### 200k_5pct_10k

Base $800/day. Calm distribution (regime samples, BS-priced retained TP).

**Moderate uplift sweep (P&L per cover, moderate regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +20% | $960 | +$   5021 | +$   5632 | $ -16861 | +$  30299 |    69% |    40% |
| +30% | $1040 | +$   4611 | +$   4588 | $ -23688 | +$  31246 |    65% |    42% |
| +40% | $1120 | +$   3698 | +$   3312 | $ -20878 | +$  30459 |    60% |    38% |

**Elevated uplift sweep (P&L per cover, elevated regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +50% | $1200 | +$   3829 | +$   4603 | $ -19807 | +$  24619 |    54% |    41% |
| +75% | $1400 | +$   6068 | +$   8298 | $ -20177 | +$  24819 |    61% |    44% |
| +100% | $1600 | +$   5827 | +$   8550 | $ -17807 | +$  24779 |    63% |    46% |

*No stress regime samples in 487-day window (BTC didn't cross 90% annualized vol).*

**Calm head-start sweep — what calm SHOULD be (operator hot-fix lever):**

| Uplift | Price/day | Avg | Median | Worst | %Profit | Trigger rate |
|---|---|---|---|---|---|---|
| +20% | $960 | +$   4371 | +$   4689 | $ -17933 |    73% |    26% |
| +40% | $1120 | +$   4541 | +$   4963 | $ -17773 |    76% |    25% |
| +60% | $1280 | +$   4994 | +$   5378 | $ -17613 |    79% |    26% |

### 200k_10pct_20k

Base $400/day. Calm distribution (regime samples, BS-priced retained TP).

**Moderate uplift sweep (P&L per cover, moderate regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +20% | $480 | +$   3490 | +$   4741 | $ -26139 | +$  26476 |    64% |     8% |
| +30% | $520 | +$   3229 | +$   5131 | $ -25365 | +$  28985 |    67% |    10% |
| +40% | $560 | +$   2798 | +$   3987 | $ -25942 | +$  17943 |    65% |     9% |

**Elevated uplift sweep (P&L per cover, elevated regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +50% | $600 | +$   5444 | +$   8978 | $ -25722 | +$  19807 |    68% |     4% |
| +75% | $700 | +$   1549 | $   -277 | $ -29738 | +$  16864 |    48% |     5% |
| +100% | $800 | +$   5370 | +$   9786 | $ -32771 | +$  19195 |    63% |     5% |

*No stress regime samples in 487-day window (BTC didn't cross 90% annualized vol).*

**Calm head-start sweep — what calm SHOULD be (operator hot-fix lever):**

| Uplift | Price/day | Avg | Median | Worst | %Profit | Trigger rate |
|---|---|---|---|---|---|---|
| +20% | $480 | +$   2732 | +$   2520 | $ -24513 |    76% |     8% |
| +40% | $560 | +$   2572 | +$   2492 | $ -24433 |    77% |     8% |
| +60% | $640 | +$   3085 | +$   2906 | $ -23103 |    78% |     9% |

### 200k_15pct_30k

Base $370/day. Calm distribution (regime samples, BS-priced retained TP).

**Moderate uplift sweep (P&L per cover, moderate regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +20% | $444 | +$   3136 | +$   3609 | $  -8238 | +$  21464 |    66% |     0% |
| +30% | $481 | +$   3401 | +$   3764 | $ -28758 | +$  22319 |    68% |     0% |
| +40% | $518 | +$   3464 | +$   3885 | $ -31817 | +$  26022 |    70% |     1% |

**Elevated uplift sweep (P&L per cover, elevated regime only):**

| Uplift | Price/day | Avg | Median | Worst | Best | %Profit | Trigger rate |
|---|---|---|---|---|---|---|---|
| +50% | $555 | +$   2779 | +$   4600 | $ -25010 | +$  21385 |    56% |     0% |
| +75% | $648 | +$   2424 | +$   3915 | $ -19884 | +$  21571 |    61% |     0% |
| +100% | $740 | +$   3792 | +$   5654 | $ -19015 | +$  21755 |    65% |     0% |

*No stress regime samples in 487-day window (BTC didn't cross 90% annualized vol).*

**Calm head-start sweep — what calm SHOULD be (operator hot-fix lever):**

| Uplift | Price/day | Avg | Median | Worst | %Profit | Trigger rate |
|---|---|---|---|---|---|---|
| +20% | $444 | +$   2358 | +$   1702 | $ -28676 |    82% |     3% |
| +40% | $518 | +$   2734 | +$   1934 | $ -28528 |    85% |     2% |
| +60% | $592 | +$   3066 | +$   2171 | $ -26800 |    88% |     2% |

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