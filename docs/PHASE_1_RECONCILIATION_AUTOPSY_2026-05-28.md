# Reconciliation Autopsy — PR 0b vs V3 (Step 1 of certainty plan)

**Generated:** 2026-05-28T02:47:54.369Z
**Spot:** $74181
**PR 0b anchors:** 2026-05-26T22:32:48.525Z (2 per-leg anchors)
**V3 multi-tenor data:** 2026-05-28T02:02:41.636Z

## Per-cell cost decomposition

For each cell, we run both PR 0b's model and V3's model on the same inputs.
The "Δ" column shows V3 minus PR 0b. Positive Δ = V3 charges more.

### pair_50k_2pct_itm

Strikes: put=$76,000 (2.45% from spot), call=$73,000 (-1.59%)
Contracts: 1.4 BTC/leg, tenor: 3d

| Regime | Leg | σ | BS_fair (USD/BTC) | PR 0b calib | PR 0b regime mkup | **PR 0b cost** | V3 ask (USD/BTC) | V3 regime mkup | **V3 cost** | Δ V3-PR0b |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| calm | put | 0.35 | $2,102 | 0.390 | 1 | **$1,149** | $2,078 | 1 | **$2,909** | +$1,760 |
| calm | call | 0.35 | $1,658 | 1.872 | 1 | **$4,344** | $1,744 | 1 | **$2,441** | -$1,903 |
| calm | **TOTAL** | — | — | — | — | **$5,493** | — | — | **$5,350** | **-$142 (-2.6%)** |
| moderate | put | 0.55 | $2,556 | 0.390 | 1.08 | **$1,509** | $2,244 | 1.08 | **$3,142** | +$1,633 |
| moderate | call | 0.55 | $2,146 | 1.872 | 1.08 | **$6,075** | $1,883 | 1.08 | **$2,637** | -$3,438 |
| moderate | **TOTAL** | — | — | — | — | **$7,583** | — | — | **$5,778** | **-$1,805 (-23.8%)** |
| elevated | put | 0.75 | $3,055 | 0.390 | 1.2 | **$2,004** | $2,493 | 1.2 | **$3,491** | +$1,487 |
| elevated | call | 0.75 | $2,658 | 1.872 | 1.2 | **$8,357** | $2,093 | 1.2 | **$2,930** | -$5,428 |
| elevated | **TOTAL** | — | — | — | — | **$10,361** | — | — | **$6,420** | **-$3,941 (-38.0%)** |
| stress | put | 0.95 | $3,572 | 0.390 | 1.35 | **$2,635** | $2,805 | 1.35 | **$3,927** | +$1,292 |
| stress | call | 0.95 | $3,177 | 1.872 | 1.35 | **$11,241** | $2,354 | 1.35 | **$3,296** | -$7,945 |
| stress | **TOTAL** | — | — | — | — | **$13,876** | — | — | **$7,223** | **-$6,653 (-47.9%)** |

### pair_25k_5pct_otm_3d

Strikes: put=$73,000 (-1.59% from spot), call=$76,000 (2.45%)
Contracts: 0.5 BTC/leg, tenor: 3d

| Regime | Leg | σ | BS_fair (USD/BTC) | PR 0b calib | PR 0b regime mkup | **PR 0b cost** | V3 ask (USD/BTC) | V3 regime mkup | **V3 cost** | Δ V3-PR0b |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| calm | put | 0.35 | $449 | 0.390 | 1 | **$88** | $408 | 1 | **$204** | +$116 |
| calm | call | 0.35 | $312 | 1.872 | 1 | **$292** | $200 | 1 | **$100** | -$191 |
| calm | **TOTAL** | — | — | — | — | **$379** | — | — | **$304** | **-$75 (-19.8%)** |
| moderate | put | 0.55 | $938 | 0.390 | 1.08 | **$198** | $441 | 1.08 | **$220** | +$23 |
| moderate | call | 0.55 | $766 | 1.872 | 1.08 | **$774** | $216 | 1.08 | **$108** | -$666 |
| moderate | **TOTAL** | — | — | — | — | **$972** | — | — | **$329** | **-$643 (-66.2%)** |
| elevated | put | 0.75 | $1,449 | 0.390 | 1.2 | **$339** | $490 | 1.2 | **$245** | -$95 |
| elevated | call | 0.75 | $1,265 | 1.872 | 1.2 | **$1,421** | $240 | 1.2 | **$120** | -$1,300 |
| elevated | **TOTAL** | — | — | — | — | **$1,760** | — | — | **$365** | **-$1,395 (-79.3%)** |
| stress | put | 0.95 | $1,969 | 0.390 | 1.35 | **$519** | $551 | 1.35 | **$275** | -$243 |
| stress | call | 0.95 | $1,782 | 1.872 | 1.35 | **$2,251** | $270 | 1.35 | **$135** | -$2,116 |
| stress | **TOTAL** | — | — | — | — | **$2,770** | — | — | **$411** | **-$2,359 (-85.2%)** |

### pair_25k_5pct_otm_short

Strikes: put=$73,000 (-1.59% from spot), call=$76,000 (2.45%)
Contracts: 0.5 BTC/leg, tenor: 1d

| Regime | Leg | σ | BS_fair (USD/BTC) | PR 0b calib | PR 0b regime mkup | **PR 0b cost** | V3 ask (USD/BTC) | V3 regime mkup | **V3 cost** | Δ V3-PR0b |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| calm | put | 0.35 | $140 | 0.408 | 1 | **$28** | $215 | 1 | **$108** | +$79 |
| calm | call | 0.35 | $61 | 4.769 | 1 | **$145** | $89 | 1 | **$45** | -$100 |
| calm | **TOTAL** | — | — | — | — | **$173** | — | — | **$152** | **-$21 (-12.1%)** |
| moderate | put | 0.55 | $380 | 0.408 | 1.08 | **$84** | $232 | 1.08 | **$116** | +$33 |
| moderate | call | 0.55 | $243 | 4.769 | 1.08 | **$626** | $96 | 1.08 | **$48** | -$578 |
| moderate | **TOTAL** | — | — | — | — | **$710** | — | — | **$164** | **-$546 (-76.9%)** |
| elevated | put | 0.75 | $654 | 0.408 | 1.2 | **$160** | $258 | 1.2 | **$129** | -$31 |
| elevated | call | 0.75 | $486 | 4.769 | 1.2 | **$1,391** | $107 | 1.2 | **$53** | -$1,337 |
| elevated | **TOTAL** | — | — | — | — | **$1,551** | — | — | **$183** | **-$1,368 (-88.2%)** |
| stress | put | 0.95 | $941 | 0.408 | 1.35 | **$259** | $290 | 1.35 | **$145** | -$114 |
| stress | call | 0.95 | $756 | 4.769 | 1.35 | **$2,434** | $120 | 1.35 | **$60** | -$2,374 |
| stress | **TOTAL** | — | — | — | — | **$2,693** | — | — | **$205** | **-$2,488 (-92.4%)** |

### pair_25k_1pct_atm_micro

Strikes: put=$75,000 (1.10% from spot), call=$74,000 (-0.24%)
Contracts: 0.3 BTC/leg, tenor: 0.25d

| Regime | Leg | σ | BS_fair (USD/BTC) | PR 0b calib | PR 0b regime mkup | **PR 0b cost** | V3 ask (USD/BTC) | V3 regime mkup | **V3 cost** | Δ V3-PR0b |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| calm | put | 0.35 | $855 | 0.408 | 1 | **$105** | $964 | 1 | **$289** | +$185 |
| calm | call | 0.35 | $372 | 27.793 | 1 | **$3,105** | $408 | 1 | **$122** | -$2,983 |
| calm | **TOTAL** | — | — | — | — | **$3,210** | — | — | **$412** | **-$2,798 (-87.2%)** |
| moderate | put | 0.55 | $955 | 0.408 | 1.08 | **$126** | $1,042 | 1.08 | **$312** | +$186 |
| moderate | call | 0.55 | $524 | 27.793 | 1.08 | **$4,715** | $441 | 1.08 | **$132** | -$4,582 |
| moderate | **TOTAL** | — | — | — | — | **$4,841** | — | — | **$445** | **-$4,396 (-90.8%)** |
| elevated | put | 0.75 | $1,081 | 0.408 | 1.2 | **$159** | $1,157 | 1.2 | **$347** | +$188 |
| elevated | call | 0.75 | $677 | 27.793 | 1.2 | **$6,770** | $490 | 1.2 | **$147** | -$6,623 |
| elevated | **TOTAL** | — | — | — | — | **$6,928** | — | — | **$494** | **-$6,434 (-92.9%)** |
| stress | put | 0.95 | $1,219 | 0.408 | 1.35 | **$202** | $1,302 | 1.35 | **$391** | +$189 |
| stress | call | 0.95 | $830 | 27.793 | 1.35 | **$9,346** | $551 | 1.35 | **$165** | -$9,181 |
| stress | **TOTAL** | — | — | — | — | **$9,548** | — | — | **$556** | **-$8,992 (-94.2%)** |

## Methodology comparison

| Aspect | PR 0b | V3 |
|---|---|---|
| Cost source | BS_fair × per-leg anchor calibration multiplier × regime markup | Live ask (direct) OR smile interp + BS + avg ask/mid × regime markup |
| Anchor data freshness | 2026-05-26T22:32:48.525Z (probe of one moment) | 2026-05-28T02:02:41.636Z (multi-tenor probe) |
| Per-tenor smile | NO (single anchor per leg, BS-rescaled to tenor) | YES (separate smile fit at 6h/1d/2d/3d) |
| Bid-ask spread cost | Folded into calibration mult | Explicit — uses ASK side, not mid |
| Salvage slip | Constant 0.85 | Tenor-bucket spread-dependent (0.65-0.95) |
| Atticus floor in sim | YES | YES (same logic) |
| MC paths | bootstrap (calm) / GBM | bootstrap (calm) / GBM (same engine) |

## Diagnostic questions answered

1. **Does V3 systematically charge more than PR 0b?**
   Look at the Δ column in each table. If consistently positive → V3 is more conservative.
   If consistently negative → V3 is more aggressive (unexpected — investigate immediately).

2. **Where does the biggest disagreement live?**
   For pair_50k_2pct_itm (the old Phase 0 cell), look at the calm row.
   PR 0b said this was profitable; V3 says broken. The cost Δ explains the EV flip.

3. **Are V3's ITM put quotes inflated?**
   For ITM put legs in pair_50k_2pct_itm, compare:
     - PR 0b BS_fair × calib × markup
     - V3 ask (direct or smile-interp)
   If V3 ask ≫ BS_fair × 1.3 (typical ITM markup), V3 may be over-paying for ITM puts.
   Cross-check via Step 2 (live probe of these exact strikes).

---
*Generated by services/api/scripts/backtest/singleSide/reconciliationAutopsy.ts*
*Next: Step 2 — live probe of Phase 0 cell strikes (live ask, today, this minute)*