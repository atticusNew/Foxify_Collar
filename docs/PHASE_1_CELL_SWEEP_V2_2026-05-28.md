# Phase 1 Cell Sweep V2 — LIVE SPREAD-CORRECTED

**Generated:** 2026-05-28T01:56:20.107Z
**Spot anchor:** $74346
**Paths per cell × regime:** 10,000
**Live smile:** a0=33.69% (ATM IV), a1=-0.650 (skew), a2=14.059, R²=0.82, 65 spread observations
**Cost model:** live per-leg ask + observed bid-ask spread + depth-aware slip (NO BS×1.07 fudge)
**Regime markup:** calm 1.00x, moderate 1.15x, elevated 1.35x, stress 1.60x

## Calm regime (σ=0.35)

| Cell | Hedge cost | Put/Call legs | Slip | Trigger | Mean salvage | **Foxify EV** | Atticus EV | %profit | P5 Foxify | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| pair_25k_5pct_otm_short | $308 | $186/$123 | 0.76 | 3.8% | $80 | **-$233** | +$5 | 5.9% | -$308 | ❌ LOSS |
| pair_25k_1pct_atm_micro | $680 | $368/$312 | 0.81 | 45.2% | $326 | **-$354** | +$0 | 0.0% | -$411 | ❌ LOSS |
| pair_50k_3pct_atm | $2,267 | $1,226/$1,041 | 0.81 | 47.4% | $1,770 | **-$514** | +$17 | 39.1% | -$1,365 | ❌ LOSS |
| pair_50k_5pct_otm | $1,264 | $706/$557 | 0.74 | 7.7% | $721 | **-$563** | +$20 | 19.1% | -$1,178 | ❌ LOSS |
| pair_50k_5pct_skew | $1,264 | $706/$557 | 0.74 | 7.7% | $721 | **-$563** | +$20 | 19.1% | -$1,178 | ❌ LOSS |
| pair_50k_4pct_otm_short | $1,264 | $706/$557 | 0.74 | 7.4% | $473 | **-$800** | +$10 | 8.8% | -$1,180 | ❌ LOSS |
| pair_50k_2pct_itm | $5,359 | $2,810/$2,550 | 0.68 | 90.8% | $3,698 | **-$1,662** | +$0 | 0.0% | -$2,483 | ❌ LOSS |
| pair_100k_3pct_itm_short | $6,095 | $2,453/$3,642 | 0.68 | 47.4% | $3,992 | **-$2,106** | +$2 | 2.4% | -$3,333 | ❌ LOSS |

## Moderate regime (σ=0.55)

| Cell | Hedge cost | Put/Call legs | Slip | Trigger | Mean salvage | **Foxify EV** | Atticus EV | %profit | P5 Foxify | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| pair_50k_5pct_otm | $1,453 | $812/$641 | 0.74 | 44.2% | $1,547 | **+$16** | +$78 | 49.2% | -$1,215 | ⚠️ MARGINAL |
| pair_50k_5pct_skew | $1,453 | $812/$641 | 0.74 | 44.2% | $1,547 | **+$16** | +$78 | 49.2% | -$1,215 | ⚠️ MARGINAL |
| pair_50k_3pct_atm | $2,607 | $1,410/$1,197 | 0.81 | 87.0% | $2,524 | **-$105** | +$22 | 59.5% | -$1,475 | ❌ LOSS |
| pair_25k_5pct_otm_short | $355 | $214/$141 | 0.76 | 16.6% | $264 | **-$108** | +$17 | 23.5% | -$342 | ❌ LOSS |
| pair_25k_1pct_atm_micro | $782 | $423/$359 | 0.81 | 90.6% | $394 | **-$388** | +$0 | 0.0% | -$464 | ❌ LOSS |
| pair_50k_4pct_otm_short | $1,453 | $812/$641 | 0.74 | 33.0% | $1,034 | **-$448** | +$28 | 33.8% | -$1,222 | ❌ LOSS |
| pair_50k_2pct_itm | $6,163 | $3,231/$2,932 | 0.68 | 100.0% | $4,579 | **-$1,584** | +$0 | 0.0% | -$1,931 | ❌ LOSS |
| pair_100k_3pct_itm_short | $7,009 | $2,821/$4,189 | 0.68 | 87.0% | $5,093 | **-$1,917** | +$0 | 0.0% | -$4,043 | ❌ LOSS |

## Elevated regime (σ=0.75)

| Cell | Hedge cost | Put/Call legs | Slip | Trigger | Mean salvage | **Foxify EV** | Atticus EV | %profit | P5 Foxify | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| pair_50k_5pct_otm | $1,706 | $953/$753 | 0.74 | 72.3% | $2,260 | **+$432** | +$122 | 73.2% | -$1,281 | ✅ PROFITABLE |
| pair_50k_5pct_skew | $1,706 | $953/$753 | 0.74 | 72.3% | $2,260 | **+$432** | +$122 | 73.2% | -$1,281 | ✅ PROFITABLE |
| pair_50k_3pct_atm | $3,061 | $1,656/$1,405 | 0.81 | 98.3% | $3,237 | **+$138** | +$39 | 78.2% | -$420 | ✅ PROFITABLE |
| pair_25k_5pct_otm_short | $416 | $251/$166 | 0.76 | 40.8% | $510 | **+$56** | +$37 | 44.9% | -$370 | ⚠️ MARGINAL |
| pair_50k_4pct_otm_short | $1,706 | $953/$753 | 0.74 | 60.5% | $1,563 | **-$184** | +$41 | 60.4% | -$1,304 | ❌ LOSS |
| pair_25k_1pct_atm_micro | $918 | $497/$421 | 0.81 | 98.8% | $463 | **-$455** | +$0 | 0.0% | -$530 | ❌ LOSS |
| pair_50k_2pct_itm | $7,235 | $3,793/$3,442 | 0.68 | 100.0% | $5,551 | **-$1,684** | +$0 | 0.0% | -$1,956 | ❌ LOSS |
| pair_100k_3pct_itm_short | $8,228 | $3,311/$4,917 | 0.68 | 98.3% | $6,260 | **-$1,969** | +$0 | 0.0% | -$3,117 | ❌ LOSS |

## Stress regime (σ=0.95)

| Cell | Hedge cost | Put/Call legs | Slip | Trigger | Mean salvage | **Foxify EV** | Atticus EV | %profit | P5 Foxify | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| pair_50k_5pct_otm | $2,022 | $1,130/$892 | 0.74 | 88.9% | $2,939 | **+$761** | +$156 | 89.0% | -$1,288 | ✅ PROFITABLE |
| pair_50k_5pct_skew | $2,022 | $1,130/$892 | 0.74 | 88.9% | $2,939 | **+$761** | +$156 | 89.0% | -$1,288 | ✅ PROFITABLE |
| pair_50k_3pct_atm | $3,627 | $1,962/$1,665 | 0.81 | 99.9% | $3,935 | **+$256** | +$52 | 88.1% | -$203 | ✅ PROFITABLE |
| pair_25k_5pct_otm_short | $494 | $297/$196 | 0.76 | 61.8% | $755 | **+$206** | +$56 | 63.6% | -$393 | ✅ PROFITABLE |
| pair_50k_4pct_otm_short | $2,022 | $1,130/$892 | 0.74 | 80.6% | $2,069 | **+$2** | +$45 | 73.0% | -$1,426 | ⚠️ MARGINAL |
| pair_25k_1pct_atm_micro | $1,088 | $589/$500 | 0.81 | 99.9% | $536 | **-$552** | +$0 | 0.0% | -$621 | ❌ LOSS |
| pair_50k_2pct_itm | $8,575 | $4,496/$4,079 | 0.68 | 100.0% | $6,544 | **-$2,031** | +$0 | 0.0% | -$2,274 | ❌ LOSS |
| pair_100k_3pct_itm_short | $9,752 | $3,925/$5,828 | 0.68 | 99.9% | $7,418 | **-$2,334** | +$0 | 0.0% | -$3,280 | ❌ LOSS |

## Recommended cell allowlist per regime (V2)

- **calm**: _(NO cell profitable above $100/pair threshold — recommend halt)_
- **moderate**: _(NO cell profitable above $100/pair threshold — recommend halt)_
- **elevated**: pair_50k_5pct_otm (+$432), pair_50k_5pct_skew (+$432), pair_50k_3pct_atm (+$138)
- **stress**: pair_50k_5pct_otm (+$761), pair_50k_5pct_skew (+$761), pair_50k_3pct_atm (+$256), pair_25k_5pct_otm_short (+$206)

## V1 vs V2 comparison (illustrative)

V1 used BS-fair × 1.07 fudge for venue markup; V2 uses live per-strike ask + observed bid-ask spread.
Live verification (separate doc) showed V1 underestimated cost by ~45% for ATM strikes.

| Cell | V1 calm EV | V2 calm EV | V1 stress EV | V2 stress EV |
|---|---:|---:|---:|---:|
| pair_50k_2pct_itm | -$339 | -$1,662 | +$1,576 | -$2,031 |
| pair_100k_3pct_itm_short | -$213 | -$2,106 | +$1,715 | -$2,334 |
| pair_50k_3pct_atm | -$42 | -$514 | +$1,484 | +$256 |
| pair_50k_5pct_otm | -$96 | -$563 | +$1,801 | +$761 |
| pair_25k_5pct_otm_short | -$8 | -$233 | +$693 | +$206 |
| pair_50k_4pct_otm_short | -$49 | -$800 | +$1,310 | +$2 |
| pair_25k_1pct_atm_micro | +$39 | -$354 | +$171 | -$552 |
| pair_50k_5pct_skew | -$96 | -$563 | +$1,801 | +$761 |

## Candidate cell descriptions

- **pair_50k_2pct_itm**: Phase 0 baseline (ITM guts, 3d, ±2%)
- **pair_100k_3pct_itm_short**: Calm scale-up (0.5% ITM, 2d, ±3%)
- **pair_50k_3pct_atm**: ATM, 2d, ±3%
- **pair_50k_5pct_otm**: OTM + wider trigger (1.5/2% OTM, 2d, ±5%)
- **pair_25k_5pct_otm_short**: OTM short tenor (2/2.5% OTM, 1d, ±5%)
- **pair_50k_4pct_otm_short**: OTM 1d (1/1.5% OTM, ±4%)
- **pair_25k_1pct_atm_micro**: Micro (ATM, 6h, ±1%) — corrected tenor from 0.167 to 0.25 to match real 6h Bullish/Deribit expiry
- **pair_50k_5pct_skew**: Skew-asymmetric (same as 5pct_otm)

---
*Generated by services/api/scripts/backtest/singleSide/runCellSweepV2.ts*
*This supersedes PHASE_1_CELL_SWEEP_2026-05-28.md which used BS+1.07 fudge.*