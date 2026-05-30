# Phase 1 Cell Sweep

**Generated:** 2026-05-28T00:02:44.122Z
**Spot anchor:** $75,000
**Paths per cell × regime:** 10,000
**Smile fit:** a0=33.69% (ATM IV), a1=-0.650 (skew), a2=14.059, R²=0.82

## Calm regime (σ=0.35)

| Cell | Hedge cost | Trigger rate | Mean salvage | **Foxify EV** | Atticus EV | %profitable | P5 Foxify | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| pair_25k_1pct_atm_micro | $128 | 33.5% | $181 | **+$39** | +$14 | 33.7% | +$0 | ⚠️ MARGINAL |
| pair_25k_5pct_otm_short | $169 | 3.8% | $178 | **-$8** | +$16 | 24.2% | -$161 | ❌ LOSS |
| pair_50k_3pct_atm | $1,472 | 47.4% | $1,484 | **-$42** | +$55 | 51.1% | -$1,014 | ❌ LOSS |
| pair_50k_4pct_otm_short | $683 | 7.4% | $675 | **-$49** | +$40 | 33.4% | -$565 | ❌ LOSS |
| pair_50k_5pct_otm | $693 | 7.7% | $642 | **-$96** | +$45 | 32.0% | -$674 | ❌ LOSS |
| pair_50k_5pct_skew | $693 | 7.7% | $642 | **-$96** | +$45 | 32.0% | -$674 | ❌ LOSS |
| pair_100k_3pct_itm_short | $5,384 | 47.4% | $5,231 | **-$213** | +$60 | 49.1% | -$1,347 | ❌ LOSS |
| pair_50k_2pct_itm | $4,183 | 90.8% | $3,849 | **-$339** | +$5 | 13.9% | -$1,297 | ❌ LOSS |

## Moderate regime (σ=0.55)

| Cell | Hedge cost | Trigger rate | Mean salvage | **Foxify EV** | Atticus EV | %profitable | P5 Foxify | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| pair_50k_5pct_otm | $748 | 44.2% | $1,511 | **+$624** | +$140 | 61.3% | -$626 | ✅ PROFITABLE |
| pair_50k_5pct_skew | $748 | 44.2% | $1,511 | **+$624** | +$140 | 61.3% | -$626 | ✅ PROFITABLE |
| pair_50k_3pct_atm | $1,590 | 87.0% | $2,245 | **+$545** | +$110 | 87.5% | -$789 | ✅ PROFITABLE |
| pair_100k_3pct_itm_short | $5,815 | 87.0% | $6,436 | **+$503** | +$118 | 84.2% | -$1,483 | ✅ PROFITABLE |
| pair_50k_4pct_otm_short | $738 | 33.0% | $1,322 | **+$479** | +$105 | 60.8% | -$413 | ✅ PROFITABLE |
| pair_50k_2pct_itm | $4,518 | 100.0% | $4,976 | **+$387** | +$71 | 94.5% | +$0 | ✅ PROFITABLE |
| pair_25k_5pct_otm_short | $183 | 16.6% | $458 | **+$227** | +$48 | 57.4% | -$125 | ✅ PROFITABLE |
| pair_25k_1pct_atm_micro | $138 | 78.9% | $255 | **+$91** | +$26 | 100.0% | +$48 | ⚠️ MARGINAL |

## Elevated regime (σ=0.75)

| Cell | Hedge cost | Trigger rate | Mean salvage | **Foxify EV** | Atticus EV | %profitable | P5 Foxify | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| pair_50k_5pct_otm | $831 | 72.3% | $2,296 | **+$1,234** | +$231 | 80.9% | -$525 | ✅ PROFITABLE |
| pair_50k_5pct_skew | $831 | 72.3% | $2,296 | **+$1,234** | +$231 | 80.9% | -$525 | ✅ PROFITABLE |
| pair_100k_3pct_itm_short | $6,461 | 98.3% | $7,837 | **+$1,164** | +$212 | 95.4% | +$59 | ✅ PROFITABLE |
| pair_50k_3pct_atm | $1,766 | 98.3% | $2,991 | **+$1,040** | +$185 | 98.3% | +$498 | ✅ PROFITABLE |
| pair_50k_2pct_itm | $5,020 | 100.0% | $6,233 | **+$1,031** | +$182 | 100.0% | +$721 | ✅ PROFITABLE |
| pair_50k_4pct_otm_short | $820 | 60.5% | $1,904 | **+$915** | +$169 | 78.1% | -$260 | ✅ PROFITABLE |
| pair_25k_5pct_otm_short | $203 | 40.8% | $760 | **+$470** | +$87 | 75.5% | -$63 | ✅ PROFITABLE |
| pair_25k_1pct_atm_micro | $153 | 95.0% | $314 | **+$133** | +$28 | 100.0% | +$63 | ⚠️ MARGINAL |

## Stress regime (σ=0.95)

| Cell | Hedge cost | Trigger rate | Mean salvage | **Foxify EV** | Atticus EV | %profitable | P5 Foxify | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| pair_50k_5pct_otm | $935 | 88.9% | $3,058 | **+$1,801** | +$322 | 92.5% | -$279 | ✅ PROFITABLE |
| pair_50k_5pct_skew | $935 | 88.9% | $3,058 | **+$1,801** | +$322 | 92.5% | -$279 | ✅ PROFITABLE |
| pair_100k_3pct_itm_short | $7,269 | 99.9% | $9,287 | **+$1,715** | +$304 | 98.9% | +$797 | ✅ PROFITABLE |
| pair_50k_2pct_itm | $5,647 | 100.0% | $7,502 | **+$1,576** | +$278 | 100.0% | +$1,304 | ✅ PROFITABLE |
| pair_50k_3pct_atm | $1,987 | 99.9% | $3,733 | **+$1,484** | +$262 | 99.9% | +$1,017 | ✅ PROFITABLE |
| pair_50k_4pct_otm_short | $922 | 80.6% | $2,465 | **+$1,310** | +$233 | 90.9% | -$91 | ✅ PROFITABLE |
| pair_25k_5pct_otm_short | $228 | 61.8% | $1,047 | **+$693** | +$125 | 91.6% | +$0 | ✅ PROFITABLE |
| pair_25k_1pct_atm_micro | $172 | 99.4% | $374 | **+$171** | +$31 | 100.0% | +$95 | ⚠️ MARGINAL |

## Recommended cell allowlist per regime

- **calm**: _(no cell profitable — recommend halt)_
- **moderate**: pair_50k_5pct_otm, pair_50k_5pct_skew, pair_50k_3pct_atm, pair_100k_3pct_itm_short, pair_50k_4pct_otm_short, pair_50k_2pct_itm, pair_25k_5pct_otm_short
- **elevated**: pair_50k_5pct_otm, pair_50k_5pct_skew, pair_100k_3pct_itm_short, pair_50k_3pct_atm, pair_50k_2pct_itm, pair_50k_4pct_otm_short, pair_25k_5pct_otm_short
- **stress**: pair_50k_5pct_otm, pair_50k_5pct_skew, pair_100k_3pct_itm_short, pair_50k_2pct_itm, pair_50k_3pct_atm, pair_50k_4pct_otm_short, pair_25k_5pct_otm_short

## Candidate cell descriptions

- **pair_50k_2pct_itm**: Phase 0 baseline — ITM guts, 3d, ±2% trigger
- **pair_100k_3pct_itm_short**: Calm scale-up — 0.5% ITM, 2d, ±3% trigger, $100k notional
- **pair_50k_3pct_atm**: Calm-moderate transition — ATM, 2d, ±3%
- **pair_50k_5pct_otm**: Moderate-elevated — 1.5/2% OTM, 2d, ±5% (per OTM analysis)
- **pair_25k_5pct_otm_short**: Elevated — 2/2.5% OTM, 1d, ±5%, sized small
- **pair_50k_4pct_otm_short**: Moderate alt — 1/1.5% OTM, 1d, ±4%
- **pair_25k_1pct_atm_micro**: Stress micro — ATM, 4h, ±1%, very small
- **pair_50k_5pct_skew**: Skew-asymmetric variant

---
*Generated by services/api/scripts/backtest/singleSide/runCellSweep.ts*