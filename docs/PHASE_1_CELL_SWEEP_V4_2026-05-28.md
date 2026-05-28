# Phase 1 Cell Sweep V4 — LIQUID-STRIKE-PICKER COST MODEL

**Generated:** 2026-05-28T03:33:26.195Z
**Spot:** $73647
**UTC hour:** 3 (ASIA session)
**Chain instruments:** 737
**Cost model:** live liquid pick (preserves moneyness side) → V3 smile fallback

## Per-regime sweep

### Calm (σ=0.35)

| Cell | Picker | Put leg | Call leg | Hedge | Trigger | Salvage | **Foxify EV** | Atticus EV | %profit | P5 |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| pair_50k_2pct_itm | liquid (best_spread, best_spread) | `BTC-31MAY26-74000-P` | `BTC-31MAY26-73500-C` | $2,887 | 90.9% | $4,219 | **+$1,132** | +$200 | 100.0% | +$339 |
| pair_25k_5pct_otm_short | liquid (exact_strike, exact_strike) | `BTC-29MAY26-73000-P` | `BTC-29MAY26-75000-C` | $284 | 3.7% | $144 | **-$148** | +$8 | 14.1% | -$277 |
| pair_25k_5pct_otm_3d | liquid (exact_strike, exact_strike) | `BTC-31MAY26-73000-P` | `BTC-31MAY26-75000-C` | $493 | 16.7% | $340 | **-$171** | +$17 | 22.7% | -$486 |
| pair_50k_4pct_otm_short | liquid (exact_strike, exact_strike) | `BTC-29MAY26-73000-P` | `BTC-29MAY26-74000-C` | $884 | 7.3% | $503 | **-$401** | +$20 | 14.3% | -$798 |
| pair_50k_5pct_otm | liquid (exact_strike, exact_strike) | `BTC-30MAY26-73000-P` | `BTC-30MAY26-75000-C` | $891 | 7.5% | $495 | **-$417** | +$21 | 19.9% | -$878 |
| pair_50k_3pct_atm | liquid (exact_strike, exact_strike) | `BTC-30MAY26-74000-P` | `BTC-30MAY26-73000-C` | $2,283 | 47.5% | $1,730 | **-$567** | +$15 | 29.9% | -$1,412 |

### Moderate (σ=0.55)

| Cell | Picker | Put leg | Call leg | Hedge | Trigger | Salvage | **Foxify EV** | Atticus EV | %profit | P5 |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| pair_50k_2pct_itm | liquid (best_spread, best_spread) | `BTC-31MAY26-74000-P` | `BTC-31MAY26-73500-C` | $3,320 | 99.9% | $5,192 | **+$1,591** | +$281 | 100.0% | +$1,237 |
| pair_25k_5pct_otm_3d | liquid (exact_strike, exact_strike) | `BTC-31MAY26-73000-P` | `BTC-31MAY26-75000-C` | $567 | 62.9% | $865 | **+$234** | +$64 | 66.6% | -$517 |
| pair_50k_5pct_otm | liquid (exact_strike, exact_strike) | `BTC-30MAY26-73000-P` | `BTC-30MAY26-75000-C` | $1,025 | 44.5% | $1,323 | **+$206** | +$93 | 51.9% | -$933 |
| pair_25k_5pct_otm_short | liquid (exact_strike, exact_strike) | `BTC-29MAY26-73000-P` | `BTC-29MAY26-75000-C` | $326 | 16.7% | $382 | **+$28** | +$28 | 36.0% | -$283 |
| pair_50k_4pct_otm_short | liquid (exact_strike, exact_strike) | `BTC-29MAY26-73000-P` | `BTC-29MAY26-74000-C` | $1,017 | 33.0% | $1,084 | **+$9** | +$59 | 40.7% | -$776 |
| pair_50k_3pct_atm | liquid (exact_strike, exact_strike) | `BTC-30MAY26-74000-P` | `BTC-30MAY26-73000-C` | $2,626 | 87.2% | $2,425 | **-$213** | +$13 | 37.3% | -$1,545 |

### Elevated (σ=0.75)

| Cell | Picker | Put leg | Call leg | Hedge | Trigger | Salvage | **Foxify EV** | Atticus EV | %profit | P5 |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| pair_50k_2pct_itm | liquid (best_spread, best_spread) | `BTC-31MAY26-74000-P` | `BTC-31MAY26-73500-C` | $3,897 | 100.0% | $6,289 | **+$2,033** | +$359 | 100.0% | +$1,745 |
| pair_50k_5pct_otm | liquid (exact_strike, exact_strike) | `BTC-30MAY26-73000-P` | `BTC-30MAY26-75000-C` | $1,203 | 72.6% | $2,045 | **+$689** | +$153 | 74.8% | -$969 |
| pair_25k_5pct_otm_3d | liquid (exact_strike, exact_strike) | `BTC-31MAY26-73000-P` | `BTC-31MAY26-75000-C` | $666 | 86.6% | $1,288 | **+$521** | +$101 | 87.3% | -$497 |
| pair_50k_4pct_otm_short | liquid (exact_strike, exact_strike) | `BTC-29MAY26-73000-P` | `BTC-29MAY26-74000-C` | $1,193 | 60.5% | $1,639 | **+$347** | +$98 | 63.0% | -$776 |
| pair_25k_5pct_otm_short | liquid (exact_strike, exact_strike) | `BTC-29MAY26-73000-P` | `BTC-29MAY26-75000-C` | $383 | 40.8% | $656 | **+$218** | +$55 | 54.4% | -$277 |
| pair_50k_3pct_atm | liquid (exact_strike, exact_strike) | `BTC-30MAY26-74000-P` | `BTC-30MAY26-73000-C` | $3,082 | 98.3% | $3,100 | **-$5** | +$23 | 58.7% | -$586 |

### Stress (σ=0.95)

| Cell | Picker | Put leg | Call leg | Hedge | Trigger | Salvage | **Foxify EV** | Atticus EV | %profit | P5 |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| pair_50k_2pct_itm | liquid (best_spread, best_spread) | `BTC-31MAY26-74000-P` | `BTC-31MAY26-73500-C` | $4,619 | 100.0% | $7,408 | **+$2,371** | +$418 | 100.0% | +$2,114 |
| pair_50k_5pct_otm | liquid (exact_strike, exact_strike) | `BTC-30MAY26-73000-P` | `BTC-30MAY26-75000-C` | $1,426 | 89.0% | $2,742 | **+$1,106** | +$210 | 89.4% | -$909 |
| pair_25k_5pct_otm_3d | liquid (exact_strike, exact_strike) | `BTC-31MAY26-73000-P` | `BTC-31MAY26-75000-C` | $789 | 96.5% | $1,706 | **+$777** | +$140 | 96.6% | +$340 |
| pair_50k_4pct_otm_short | liquid (exact_strike, exact_strike) | `BTC-29MAY26-73000-P` | `BTC-29MAY26-74000-C` | $1,414 | 80.5% | $2,170 | **+$624** | +$131 | 81.1% | -$793 |
| pair_25k_5pct_otm_short | liquid (exact_strike, exact_strike) | `BTC-29MAY26-73000-P` | `BTC-29MAY26-75000-C` | $454 | 61.8% | $920 | **+$387** | +$79 | 69.1% | -$271 |
| pair_50k_3pct_atm | liquid (exact_strike, exact_strike) | `BTC-30MAY26-74000-P` | `BTC-30MAY26-73000-C` | $3,653 | 99.9% | $3,768 | **+$85** | +$30 | 70.0% | -$398 |

## Comparison vs V3 sweep

Compare to docs/PHASE_1_CELL_SWEEP_V3_2026-05-28.md to see cost-model deltas.
Cells with significant Foxify EV improvement are the ones where the picker found cheaper liquid strikes.

---
*Generated by services/api/scripts/backtest/singleSide/runCellSweepV4.ts*