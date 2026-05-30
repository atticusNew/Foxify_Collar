# Phase 1 Cell Sweep V6 — LIVE CROSS-VENUE COSTS

**Generated:** 2026-05-28T21:03:21.397Z
**Live data asOf:** 2026-05-28T21:03:13.778Z
**Spot:** $73485
**Regime at fetch:** calm (DVOL ~37)
**UTC hour:** 21
**Source:** GET <atticus-api-base>/admin/foxify/v2/cell-costs (live cross-venue routing)

## Per-cell live cost + sim

| Cell | Put venue | Call venue | Hedge cost (live) | Actual strikes | Shifted? |
|---|---|---|---:|---|---|
| pair_50k_2pct | deribit | deribit | $2,778 | 73500/73000 | p:Y/c:Y |
| pair_100k_3pct_itm_short | deribit | deribit | $3,968 | 74000/73000 | no |
| pair_50k_3pct_atm | deribit | deribit | $1,984 | 74000/73000 | no |
| pair_50k_5pct_otm | deribit | deribit | $992 | 73000/74000 | no |
| pair_25k_5pct_otm_short | deribit | deribit | $287 | 73000/75000 | no |
| pair_25k_5pct_otm_3d | deribit | deribit | $478 | 73000/75000 | no |
| pair_50k_4pct_otm_short | deribit | deribit | $845 | 73000/74000 | no |
| pair_25k_1pct_atm_micro | deribit | deribit | $408 | 74000/73000 | no |

### Calm regime (σ=0.35, cost×1)

| Cell | Hedge | Trigger rate | Salvage | **Foxify EV** | Atticus EV | %profit | P5 |
|---|---:|---:|---:|---:|---:|---:|---:|
| pair_25k_1pct_atm_micro ❌ | $408 | 33.3% | $310 | **-$99** | +$2 | 6.8% | -$135 |
| pair_25k_5pct_otm_short ❌ | $287 | 3.7% | $161 | **-$135** | +$10 | 17.4% | -$280 |
| pair_25k_5pct_otm_3d ❌ | $478 | 16.7% | $356 | **-$140** | +$19 | 24.5% | -$470 |
| pair_50k_2pct ❌ | $2,778 | 90.9% | $2,632 | **-$167** | +$21 | 45.4% | -$1,694 |
| pair_50k_3pct_atm ❌ | $1,984 | 47.5% | $1,795 | **-$227** | +$38 | 47.6% | -$1,070 |
| pair_50k_5pct_otm ❌ | $992 | 7.5% | $797 | **-$234** | +$38 | 29.7% | -$899 |
| pair_50k_4pct_otm_short ❌ | $845 | 7.3% | $515 | **-$351** | +$21 | 15.9% | -$755 |
| pair_100k_3pct_itm_short ❌ | $3,968 | 47.5% | $3,590 | **-$454** | +$76 | 47.7% | -$2,141 |

### Moderate regime (σ=0.55, cost×1.15)

| Cell | Hedge | Trigger rate | Salvage | **Foxify EV** | Atticus EV | %profit | P5 |
|---|---:|---:|---:|---:|---:|---:|---:|
| pair_50k_2pct ✅ | $3,195 | 99.9% | $3,759 | **+$478** | +$87 | 95.8% | +$48 |
| pair_50k_5pct_otm ✅ | $1,141 | 44.5% | $1,707 | **+$443** | +$123 | 56.8% | -$881 |
| pair_100k_3pct_itm_short ✅ | $4,564 | 87.2% | $5,083 | **+$402** | +$117 | 85.7% | -$2,291 |
| pair_25k_5pct_otm_3d ✅ | $549 | 62.9% | $913 | **+$291** | +$72 | 68.0% | -$496 |
| pair_50k_3pct_atm ✅ | $2,282 | 87.2% | $2,542 | **+$200** | +$59 | 85.3% | -$1,145 |
| pair_50k_4pct_otm_short ⚠️ | $972 | 33.0% | $1,132 | **+$93** | +$67 | 42.9% | -$721 |
| pair_25k_5pct_otm_short ⚠️ | $330 | 16.7% | $409 | **+$48** | +$31 | 38.1% | -$284 |
| pair_25k_1pct_atm_micro ❌ | $469 | 78.9% | $372 | **-$98** | +$1 | 1.4% | -$149 |

### Elevated regime (σ=0.75, cost×1.35)

| Cell | Hedge | Trigger rate | Salvage | **Foxify EV** | Atticus EV | %profit | P5 |
|---|---:|---:|---:|---:|---:|---:|---:|
| pair_50k_2pct ✅ | $3,750 | 100.0% | $4,973 | **+$1,039** | +$183 | 100.0% | +$711 |
| pair_100k_3pct_itm_short ✅ | $5,357 | 98.3% | $6,505 | **+$967** | +$181 | 94.4% | -$59 |
| pair_50k_5pct_otm ✅ | $1,339 | 72.6% | $2,492 | **+$958** | +$195 | 76.4% | -$874 |
| pair_25k_5pct_otm_3d ✅ | $645 | 86.6% | $1,355 | **+$596** | +$114 | 87.8% | -$466 |
| pair_50k_3pct_atm ✅ | $2,679 | 98.3% | $3,252 | **+$483** | +$91 | 94.1% | -$30 |
| pair_50k_4pct_otm_short ✅ | $1,141 | 60.5% | $1,715 | **+$461** | +$113 | 64.3% | -$703 |
| pair_25k_5pct_otm_short ✅ | $387 | 40.8% | $693 | **+$247** | +$59 | 56.2% | -$276 |
| pair_25k_1pct_atm_micro ❌ | $551 | 95.1% | $431 | **-$120** | +$1 | 1.4% | -$185 |

### Stress regime (σ=0.95, cost×1.6)

| Cell | Hedge | Trigger rate | Salvage | **Foxify EV** | Atticus EV | %profit | P5 |
|---|---:|---:|---:|---:|---:|---:|---:|
| pair_50k_2pct ✅ | $4,445 | 100.0% | $6,185 | **+$1,479** | +$261 | 100.0% | +$1,191 |
| pair_50k_5pct_otm ✅ | $1,587 | 89.0% | $3,234 | **+$1,389** | +$257 | 89.8% | -$786 |
| pair_100k_3pct_itm_short ✅ | $6,349 | 99.9% | $7,908 | **+$1,322** | +$236 | 98.0% | +$456 |
| pair_25k_5pct_otm_3d ✅ | $764 | 96.5% | $1,794 | **+$873** | +$157 | 96.7% | +$366 |
| pair_50k_4pct_otm_short ✅ | $1,352 | 80.5% | $2,273 | **+$767** | +$153 | 81.7% | -$702 |
| pair_50k_3pct_atm ✅ | $3,175 | 99.9% | $3,954 | **+$661** | +$118 | 97.9% | +$228 |
| pair_25k_5pct_otm_short ✅ | $459 | 61.8% | $969 | **+$425** | +$85 | 70.4% | -$266 |
| pair_25k_1pct_atm_micro ❌ | $653 | 99.4% | $489 | **-$164** | +$0 | 0.9% | -$236 |

## Comparison: V5 (Deribit-only, 03 UTC) vs V6 (cross-venue, 21:00 UTC)

| Cell | V5 cost | V6 cost | V5 calm EV | **V6 calm EV** | Calm verdict |
|---|---:|---:|---:|---:|---|
| pair_50k_2pct | $3,343 | $2,778 | -$308 | **-$167** | ❌ LOSS |
| pair_100k_3pct_itm_short | — | $3,968 | — | **-$454** | ❌ LOSS |
| pair_50k_3pct_atm | $2,283 | $1,984 | -$537 | **-$227** | ❌ LOSS |
| pair_50k_5pct_otm | $1,286 | $992 | -$568 | **-$234** | ❌ LOSS |
| pair_25k_5pct_otm_short | $312 | $287 | -$190 | **-$135** | ❌ LOSS |
| pair_25k_5pct_otm_3d | $514 | $478 | -$224 | **-$140** | ❌ LOSS |
| pair_50k_4pct_otm_short | $882 | $845 | -$457 | **-$351** | ❌ LOSS |
| pair_25k_1pct_atm_micro | $412 | $408 | -$145 | **-$99** | ❌ LOSS |

## Recommendation

Calm regime: no cell crosses +$100/pair threshold. System should HALT in calm (existing default is correct).

### Moderate regime winners (5):
- `pair_50k_2pct`: +$478/pair Foxify
- `pair_50k_5pct_otm`: +$443/pair Foxify
- `pair_100k_3pct_itm_short`: +$402/pair Foxify
- `pair_25k_5pct_otm_3d`: +$291/pair Foxify
- `pair_50k_3pct_atm`: +$200/pair Foxify

## Caveats

1. **Single snapshot at 21:00 UTC.** Time-of-day matters significantly. Run again at
   13-21 UTC (US session) to see if costs tighten further OR loosen.
2. **Higher-regime costs are estimated** via REGIME_MARKUP scaling from this calm-regime snapshot.
   When DVOL actually spikes, re-fetch /cell-costs to validate.
3. **Salvage uses V5 slip approximation (0.82).** Real venue slip may differ; the cron probe
   accumulates per-cell spread data for refinement.
4. **One Bullish quote could be transient.** Don't change defaults on a single snapshot.
   Wait for 24h of cron data or run V6 daily for a week.

---
*Generated by services/api/scripts/backtest/singleSide/runCellSweepV6.ts*