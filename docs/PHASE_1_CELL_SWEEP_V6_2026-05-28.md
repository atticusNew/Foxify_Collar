# Phase 1 Cell Sweep V6 — LIVE CROSS-VENUE COSTS

**Generated:** 2026-05-28T05:25:38.743Z
**Live data asOf:** 2026-05-28T05:25:31.186Z
**Spot:** $72842
**Regime at fetch:** null (DVOL ~37)
**UTC hour:** 5
**Source:** GET <atticus-api-base>/admin/foxify/v2/cell-costs (live cross-venue routing)

## Per-cell live cost + sim

| Cell | Put venue | Call venue | Hedge cost (live) | Actual strikes | Shifted? |
|---|---|---|---:|---|---|
| pair_50k_2pct | deribit | deribit | $2,959 | 73000/72500 | p:Y/c:Y |
| pair_100k_3pct_itm_short | deribit | deribit | $5,977 | 74000/72000 | no |
| pair_50k_3pct_atm | deribit | deribit | $2,296 | 73000/72000 | no |
| pair_50k_5pct_otm | deribit | deribit | $911 | 72000/74000 | no |
| pair_25k_5pct_otm_short | deribit | deribit | $233 | 72000/74000 | no |
| pair_25k_5pct_otm_3d | deribit | deribit | $492 | 72000/74000 | no |
| pair_50k_4pct_otm_short | deribit | deribit | $1,203 | 73000/73000 | no |
| pair_25k_1pct_atm_micro | deribit | deribit | $370 | 73000/72000 | no |

### Calm regime (σ=0.35, cost×1)

| Cell | Hedge | Trigger rate | Salvage | **Foxify EV** | Atticus EV | %profit | P5 |
|---|---:|---:|---:|---:|---:|---:|---:|
| pair_25k_1pct_atm_micro ❌ | $370 | 33.3% | $322 | **-$53** | +$5 | 17.8% | -$93 |
| pair_25k_5pct_otm_short ❌ | $233 | 3.7% | $143 | **-$101** | +$10 | 15.7% | -$227 |
| pair_25k_5pct_otm_3d ❌ | $492 | 16.7% | $356 | **-$156** | +$20 | 23.5% | -$485 |
| pair_50k_2pct ❌ | $2,959 | 90.9% | $2,594 | **-$372** | +$7 | 16.8% | -$1,919 |
| pair_50k_4pct_otm_short ❌ | $1,203 | 7.3% | $848 | **-$377** | +$22 | 18.2% | -$844 |
| pair_50k_5pct_otm ❌ | $911 | 7.5% | $513 | **-$422** | +$23 | 20.3% | -$899 |
| pair_50k_3pct_atm ❌ | $2,296 | 47.5% | $1,842 | **-$478** | +$24 | 31.9% | -$1,375 |
| pair_100k_3pct_itm_short ❌ | $5,977 | 47.5% | $4,626 | **-$1,359** | +$9 | 11.4% | -$2,671 |

### Moderate regime (σ=0.55, cost×1.15)

| Cell | Hedge | Trigger rate | Salvage | **Foxify EV** | Atticus EV | %profit | P5 |
|---|---:|---:|---:|---:|---:|---:|---:|
| pair_50k_2pct ✅ | $3,403 | 99.9% | $3,726 | **+$270** | +$53 | 89.8% | -$139 |
| pair_25k_5pct_otm_3d ✅ | $566 | 62.9% | $891 | **+$258** | +$68 | 66.4% | -$515 |
| pair_50k_5pct_otm ✅ | $1,048 | 44.5% | $1,360 | **+$216** | +$97 | 51.5% | -$956 |
| pair_25k_5pct_otm_short ⚠️ | $268 | 16.7% | $389 | **+$88** | +$33 | 40.9% | -$225 |
| pair_50k_4pct_otm_short ⚠️ | $1,383 | 33.0% | $1,494 | **+$45** | +$65 | 42.5% | -$817 |
| pair_25k_1pct_atm_micro ❌ | $425 | 78.9% | $378 | **-$53** | +$6 | 18.4% | -$136 |
| pair_50k_3pct_atm ❌ | $2,640 | 87.2% | $2,536 | **-$128** | +$24 | 49.1% | -$1,492 |
| pair_100k_3pct_itm_short ❌ | $6,873 | 87.2% | $6,014 | **-$861** | +$2 | 6.6% | -$3,329 |

### Elevated regime (σ=0.75, cost×1.35)

| Cell | Hedge | Trigger rate | Salvage | **Foxify EV** | Atticus EV | %profit | P5 |
|---|---:|---:|---:|---:|---:|---:|---:|
| pair_50k_2pct ✅ | $3,995 | 100.0% | $4,932 | **+$796** | +$141 | 99.8% | +$492 |
| pair_50k_5pct_otm ✅ | $1,230 | 72.6% | $2,113 | **+$722** | +$161 | 74.6% | -$993 |
| pair_25k_5pct_otm_3d ✅ | $664 | 86.6% | $1,332 | **+$560** | +$108 | 87.2% | -$498 |
| pair_50k_4pct_otm_short ✅ | $1,624 | 60.5% | $2,084 | **+$357** | +$103 | 63.3% | -$849 |
| pair_25k_5pct_otm_short ✅ | $315 | 40.8% | $675 | **+$296** | +$64 | 58.9% | -$208 |
| pair_50k_3pct_atm ⚠️ | $3,099 | 98.3% | $3,235 | **+$98** | +$37 | 69.4% | -$545 |
| pair_25k_1pct_atm_micro ❌ | $499 | 95.1% | $435 | **-$68** | +$4 | 12.9% | -$167 |
| pair_100k_3pct_itm_short ❌ | $8,068 | 98.3% | $7,390 | **-$681** | +$2 | 5.8% | -$1,865 |

### Stress regime (σ=0.95, cost×1.6)

| Cell | Hedge | Trigger rate | Salvage | **Foxify EV** | Atticus EV | %profit | P5 |
|---|---:|---:|---:|---:|---:|---:|---:|
| pair_50k_2pct ✅ | $4,735 | 100.0% | $6,135 | **+$1,191** | +$210 | 100.0% | +$927 |
| pair_50k_5pct_otm ✅ | $1,458 | 89.0% | $2,837 | **+$1,159** | +$220 | 89.3% | -$937 |
| pair_25k_5pct_otm_3d ✅ | $787 | 96.5% | $1,766 | **+$830** | +$149 | 96.6% | +$392 |
| pair_50k_4pct_otm_short ✅ | $1,925 | 80.5% | $2,642 | **+$589** | +$129 | 80.9% | -$925 |
| pair_25k_5pct_otm_short ✅ | $373 | 61.8% | $949 | **+$484** | +$92 | 72.3% | -$187 |
| pair_50k_3pct_atm ✅ | $3,673 | 99.9% | $3,926 | **+$206** | +$46 | 80.3% | -$313 |
| pair_25k_1pct_atm_micro ❌ | $591 | 99.4% | $492 | **-$102** | +$2 | 6.9% | -$199 |
| pair_100k_3pct_itm_short ❌ | $9,563 | 99.9% | $8,762 | **-$801** | +$1 | 2.5% | -$1,790 |

## Comparison: V5 (Deribit-only, 03 UTC) vs V6 (cross-venue, 5:00 UTC)

| Cell | V5 cost | V6 cost | V5 calm EV | **V6 calm EV** | Calm verdict |
|---|---:|---:|---:|---:|---|
| pair_50k_2pct | $3,343 | $2,959 | -$308 | **-$372** | ❌ LOSS |
| pair_100k_3pct_itm_short | — | $5,977 | — | **-$1,359** | ❌ LOSS |
| pair_50k_3pct_atm | $2,283 | $2,296 | -$537 | **-$478** | ❌ LOSS |
| pair_50k_5pct_otm | $1,286 | $911 | -$568 | **-$422** | ❌ LOSS |
| pair_25k_5pct_otm_short | $312 | $233 | -$190 | **-$101** | ❌ LOSS |
| pair_25k_5pct_otm_3d | $514 | $492 | -$224 | **-$156** | ❌ LOSS |
| pair_50k_4pct_otm_short | $882 | $1,203 | -$457 | **-$377** | ❌ LOSS |
| pair_25k_1pct_atm_micro | $412 | $370 | -$145 | **-$53** | ❌ LOSS |

## Recommendation

Calm regime: no cell crosses +$100/pair threshold. System should HALT in calm (existing default is correct).

### Moderate regime winners (3):
- `pair_50k_2pct`: +$270/pair Foxify
- `pair_25k_5pct_otm_3d`: +$258/pair Foxify
- `pair_50k_5pct_otm`: +$216/pair Foxify

## Caveats

1. **Single snapshot at 5:00 UTC.** Time-of-day matters significantly. Run again at
   13-21 UTC (US session) to see if costs tighten further OR loosen.
2. **Higher-regime costs are estimated** via REGIME_MARKUP scaling from this calm-regime snapshot.
   When DVOL actually spikes, re-fetch /cell-costs to validate.
3. **Salvage uses V5 slip approximation (0.82).** Real venue slip may differ; the cron probe
   accumulates per-cell spread data for refinement.
4. **One Bullish quote could be transient.** Don't change defaults on a single snapshot.
   Wait for 24h of cron data or run V6 daily for a week.

---
*Generated by services/api/scripts/backtest/singleSide/runCellSweepV6.ts*