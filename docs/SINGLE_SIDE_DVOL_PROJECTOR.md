# Single-Side Capital & EV Projector — DVOL Regime Sensitivity

**Generated:** 2026-05-26T19:29:51.707Z
**Anchor:** 2026-05-26 empirical chain @ DVOL=35.2, spot $76,619

> Deterministic projector (not a re-backtest). Takes a DVOL value as
> input and emits per-cell capital + EV at the input regime, calibrated
> against the 2026-05-26 live chain empirical hedge cost.

> **Calibration mechanic:** for each cell we computed BS-modeled hedge cost
> at today's DVOL (35.2) and the empirical Bullish/Deribit
> ask. The ratio is locked as the cell's calibration multiplier and applied
> to BS at any other DVOL — preserving the empirical / BS gap that vol smile
> creates at OTM strikes.

## 1. Per-cell calibration multipliers

| Cell | BS @ DVOL=35.2 | Empirical | Multiplier | Tenor |
|---|---:|---:|---:|---:|
| ss_50k_2pct_1k | $958 | $1,001 | **1.044** | 3d |
| ss_50k_5pct_2_5k | $415 | $357 | **0.860** | 3d |
| ss_200k_5pct_10k | $1,612 | $1,386 | **0.860** | 3d |
| ss_50k_7pct_3_5k | $1,193 | $1,069 | **0.896** | 10d |
| ss_200k_7pct_14k | $4,770 | $4,278 | **0.897** | 10d |

## 2. Per-cell projection across DVOL

Hedge cost (USD per cover) at each DVOL level:

| Cell | DVOL=25 (deep calm) | DVOL=35 (today) | DVOL=50 (mod) | DVOL=65 (elev) | DVOL=80 (stress) | DVOL=95 | DVOL=110 |
|---|---:|---:|---:|---:|---:|---:|---:|
| ss_50k_2pct_1k | $588 | $993 | $1,621 | $2,258 | $2,901 | $3,545 | $4,191 |
| ss_50k_5pct_2_5k | $118 | $351 | $828 | $1,377 | $1,962 | $2,566 | $3,182 |
| ss_200k_5pct_10k | $458 | $1,364 | $3,214 | $5,346 | $7,617 | $9,963 | $12,356 |
| ss_50k_7pct_3_5k | $388 | $1,054 | $2,343 | $3,795 | $5,324 | $6,895 | $8,491 |
| ss_200k_7pct_14k | $1,553 | $4,216 | $9,377 | $15,188 | $21,308 | $27,594 | $33,978 |

Per-cover EV (USD) at each DVOL — assumes baseline overlay (calm 1.0× / mod 1.4× / elev 2.0× / stress 3.0×):

| Cell | DVOL=25 | DVOL=35 | DVOL=50 | DVOL=65 | DVOL=80 | DVOL=95 | DVOL=110 |
|---|---:|---:|---:|---:|---:|---:|---:|
| ss_50k_2pct_1k | +$104 | +$169 | +$89 | +$21 | -$11 | -$331 | -$460 |
| ss_50k_5pct_2_5k | -$236 | -$199 | -$323 | -$429 | -$458 | -$820 | -$943 |
| ss_200k_5pct_10k | -$906 | -$761 | -$1,242 | -$1,626 | -$1,740 | -$3,099 | -$3,578 |
| ss_50k_7pct_3_5k | -$65 | +$42 | -$69 | -$277 | -$354 | -$1,253 | -$1,572 |
| ss_200k_7pct_14k | -$249 | +$177 | -$262 | -$1,090 | -$1,396 | -$4,984 | -$6,261 |

## 3. Capital ladder: 50k/2% workhorse at concurrent counts × DVOL

Per-cover capital (option premium debit only) × position count = peak
working capital deployed. Single-direction; total exposure if directions
balance is up to 2× these numbers.

| Concurrent | DVOL=25 | DVOL=35 (today) | DVOL=50 | DVOL=65 | DVOL=80 | DVOL=95 | DVOL=110 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | $588 | $993 | $1,621 | $2,258 | $2,901 | $3,545 | $4,191 |
| 3 | $1,765 | $2,978 | $4,862 | $6,775 | $8,702 | $10,636 | $12,573 |
| 5 | $2,942 | $4,964 | $8,103 | $11,292 | $14,504 | $17,726 | $20,955 |
| 8 | $4,707 | $7,942 | $12,965 | $18,068 | $23,206 | $28,362 | $33,528 |
| 10 | $5,884 | $9,928 | $16,206 | $22,585 | $29,008 | $35,453 | $41,910 |
| 12 | $7,061 | $11,913 | $19,447 | $27,102 | $34,809 | $42,543 | $50,292 |
| 15 | $8,827 | $14,891 | $24,309 | $33,877 | $43,511 | $53,179 | $62,864 |

## 4. Aggregate portfolio capital at concurrent caps (single direction)

Sums per-cell concurrent cap × empirical-calibrated hedge cost. This is
Atticus's peak working capital if every cell hits its single-direction cap.

| DVOL | 50k/2% | 50k/5% | 200k/5% | 50k/7% | 200k/7% | **Total** |
|---:|---:|---:|---:|---:|---:|---:|
| 25 | $7,061 | $1,650 | $1,373 | $2,329 | $4,660 | **$17,073** |
| 35 | $11,913 | $4,920 | $4,093 | $6,322 | $12,649 | **$39,897** |
| 50 | $19,447 | $11,589 | $9,641 | $14,060 | $28,132 | **$82,869** |
| 65 | $27,102 | $19,279 | $16,038 | $22,771 | $45,564 | **$130,754** |
| 80 | $34,809 | $27,466 | $22,850 | $31,947 | $63,923 | **$180,994** |
| 95 | $42,543 | $35,928 | $29,889 | $41,372 | $82,782 | **$232,514** |
| 110 | $50,292 | $44,555 | $37,067 | $50,943 | $101,934 | **$284,790** |

At 2× directional balance: total capital ranges from ~$79,795
(today, both directions full) up to ~$569,580 (DVOL=110 stress, both directions full).

## 5. Stress operation — guardrail variants

The baseline Phase-0 plan PAUSES in stress (DVOL ≥ 80) via Guard D. This
section evaluates what happens if we keep operating in stress with various
guardrail configurations. All variants assume DVOL = **95** (mid-stress).

### no_stress (baseline plan)

Premium multiplier (on top of stress 3.0× overlay): **PAUSED×**.  
Concurrent cap multiplier: **PAUSED×** (of normal cap).

| Cell | Per-cover EV | Cap (positions) | Capital at cap | Annual EV at cap |
|---|---:|---:|---:|---:|
| ss_50k_2pct_1k | (paused) | 0 | $0 | $0 |
| ss_50k_5pct_2_5k | (paused) | 0 | $0 | $0 |
| ss_200k_5pct_10k | (paused) | 0 | $0 | $0 |
| ss_50k_7pct_3_5k | (paused) | 0 | $0 | $0 |
| ss_200k_7pct_14k | (paused) | 0 | $0 | $0 |
| **TOTAL (if every stress day were like this)** | | | **$0** | **$0** |

### stress_full (no extra guards)

Premium multiplier (on top of stress 3.0× overlay): **1×**.  
Concurrent cap multiplier: **1×** (of normal cap).

| Cell | Per-cover EV | Cap (positions) | Capital at cap | Annual EV at cap |
|---|---:|---:|---:|---:|
| ss_50k_2pct_1k | -$331 | 12 | $42,543 | -$1,450,002 |
| ss_50k_5pct_2_5k | -$820 | 14 | $35,928 | -$4,189,670 |
| ss_200k_5pct_10k | -$3,099 | 3 | $29,889 | -$3,393,627 |
| ss_50k_7pct_3_5k | -$1,253 | 6 | $41,372 | -$2,743,799 |
| ss_200k_7pct_14k | -$4,984 | 3 | $82,782 | -$5,457,574 |
| **TOTAL (if every stress day were like this)** | | | **$232,514** | **-$17,234,672** |

### stress_capped (caps × 0.5)

Premium multiplier (on top of stress 3.0× overlay): **1×**.  
Concurrent cap multiplier: **0.5×** (of normal cap).

| Cell | Per-cover EV | Cap (positions) | Capital at cap | Annual EV at cap |
|---|---:|---:|---:|---:|
| ss_50k_2pct_1k | -$331 | 6 | $21,272 | -$725,001 |
| ss_50k_5pct_2_5k | -$820 | 7 | $17,964 | -$2,094,835 |
| ss_200k_5pct_10k | -$3,099 | 1 | $9,963 | -$1,131,209 |
| ss_50k_7pct_3_5k | -$1,253 | 3 | $20,686 | -$1,371,900 |
| ss_200k_7pct_14k | -$4,984 | 1 | $27,594 | -$1,819,191 |
| **TOTAL (if every stress day were like this)** | | | **$97,478** | **-$7,142,136** |

### stress_priced (premium × 1.5)

Premium multiplier (on top of stress 3.0× overlay): **1.5×**.  
Concurrent cap multiplier: **0.5×** (of normal cap).

| Cell | Per-cover EV | Cap (positions) | Capital at cap | Annual EV at cap |
|---|---:|---:|---:|---:|
| ss_50k_2pct_1k | +$134 | 6 | $21,272 | +$293,349 |
| ss_50k_5pct_2_5k | -$610 | 7 | $17,964 | -$1,558,285 |
| ss_200k_5pct_10k | -$2,199 | 1 | $9,963 | -$802,709 |
| ss_50k_7pct_3_5k | -$788 | 3 | $20,686 | -$862,725 |
| ss_200k_7pct_14k | -$3,109 | 1 | $27,594 | -$1,134,816 |
| **TOTAL (if every stress day were like this)** | | | **$97,478** | **-$4,065,186** |

### stress_recommended (P 1.5×, C 0.33×)

Premium multiplier (on top of stress 3.0× overlay): **1.5×**.  
Concurrent cap multiplier: **0.33×** (of normal cap).

| Cell | Per-cover EV | Cap (positions) | Capital at cap | Annual EV at cap |
|---|---:|---:|---:|---:|
| ss_50k_2pct_1k | +$134 | 3 | $10,636 | +$146,675 |
| ss_50k_5pct_2_5k | -$610 | 4 | $10,265 | -$890,449 |
| ss_200k_5pct_10k | -$2,199 | 1 | $9,963 | -$802,709 |
| ss_50k_7pct_3_5k | -$788 | 1 | $6,895 | -$287,575 |
| ss_200k_7pct_14k | -$3,109 | 1 | $27,594 | -$1,134,816 |
| **TOTAL (if every stress day were like this)** | | | **$65,353** | **-$2,968,874** |

## 6. Recommended stress guardrails (most-effective without over-engineering)

Stress regime is rare (~3-5% of days historically). The simplest set that
bounds exposure while letting the platform stay live:

| Guardrail | Mechanism | Env var | Setting |
|---|---|---|---|
| **G1: Premium overlay × 3.0** | Built into regime overlay JSON | `SS_REGIME_OVERLAY_JSON` | `{"stress":3.0}` |
| **G2: Concurrent cap × 0.33** | Reduces per-direction cap by 67% | `SS_STRESS_CONCURRENT_CAP_RATIO` | `0.33` |
| **G3: Per-cell loss-kill × 0.5** | Halve the rolling-loss kill threshold | `SS_STRESS_LOSS_KILL_RATIO` | `0.5` |
| **G4: Depth gate × 1.5** | Require depth ≥ contracts × 1.5 (vs 1.2 normal) | `SS_STRESS_DEPTH_GATE_RATIO` | `1.5` |
| **G5: Hedge budget cap × 0.5** | Half the daily hedge spend ceiling | `SS_STRESS_BUDGET_CAP_RATIO` | `0.5` |

Net effect of G1–G5 at DVOL=95: matches the "stress_recommended" row in §5.

## 7. Recommendation — keep stress PAUSED in Phase 0

Stress operation under the recommended guardrails (G1-G5) across the stress range:

| DVOL | Cap (single-dir) | Capital deployed | Annual EV if every day stress | Realistic contribution (3% stress days) |
|---:|---:|---:|---:|---:|
| 80 | 10 | $50,798 | -$622,170 | -$18,665 |
| 95 | 10 | $65,353 | -$2,968,874 | -$89,066 |
| 110 | 10 | $80,127 | -$4,047,343 | -$121,420 |

**Verdict: stress operation is structurally negative-EV** even under the most
conservative guardrail set. The mechanic: at high σ, hedge cost explodes
(~3-4× calm), and even with 1.5× extra premium and 0.33× concurrent cap,
the average cover loses money because trigger rate stays high (~92%) while
salvage degrades.

**Recommendation: keep stress PAUSED for Phase 0** (the current plan).
Re-evaluate after 90+ live triggers in calm/moderate validate the theta-aware
TP engine in production. If salvage performance materially exceeds the 1.16×
backtest baseline (e.g. 1.30× empirical from real Bullish fills), revisit the
stress-on case using updated salvage fractions in this projector.

**If Foxify pushes for "always-on" UX in stress**: implement `stress_recommended`
(G1-G5) but recognize realistic annual cost is **~$60-80k/year** (3% of days × negative EV).
That's "relationship insurance" — pay to keep Foxify always live during BTC chaos days.

## 8. Notes & caveats

1. **Calibration multiplier is locked at 2026-05-26**. Re-run the empirical validator periodically (e.g. weekly) and update `EMPIRICAL_HEDGE_COST`; vol-smile shape can shift.
2. **Trigger rate model anchored to backtest**: 50k/2% calm 30%, 5% calm 17%, 7% calm 11%. Scaling formula: `baseRate × (0.02/triggerPct)^0.7 × 0.6`.
3. **Salvage fractions anchored to Variant B backtest** (theta-aware TP avg salvage / avg hedge cost). Calm 1.16×, moderate 1.05×, elevated 0.95×, stress 0.80× (modeled).
4. **7% cell salvage may be UNDER-estimated** because their 10d tenor gives more time value to capture on retained legs. The dedicated 7% backtest showed avg salvage ~1.8-1.95× hedge cost; this projector uses the same fractions for all cells. EV for 7% cells in §2 is therefore conservative.
5. **Stress projection is model-based, not backtested.** The 16-month Coinbase window had 0 stress days. Live stress validation needed before any cutover.
6. **Capital is upfront option premium only.** Long-only product, no margin. Foxify premium starts paying it back day 1.

---

*Generated by services/api/scripts/backtest/singleSide/dvolProjector.ts*
*Re-run with `npx tsx scripts/backtest/singleSide/dvolProjector.ts` after each empirical chain refresh.*