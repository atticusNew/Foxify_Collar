# Two-Sided Strangle Validation — Cooperative Cost-Pass-Through

**Generated:** 2026-05-27T20:37:04.342Z
**Pair config:** 50k/2% with ±2% triggers, 1.4 BTC contracts, 3-day tenor
**Split:** 80/20 (Foxify favor), no op fee
**Spot anchor:** $75,994
**Paths per scenario:** 25,000

## Background

Two-sided pair = Foxify opens long perp + short perp simultaneously.
Either ±2% trigger closes the entire pair. Atticus hedges with a strangle
(long put + long call), splits salvage 80/20 per the cooperative model.

## 0. Live-anchor provenance (per-leg empirical calibration)

**Anchor source:** embedded_default
**Anchor generated at:** 2026-05-26T22:32:48.525Z
**Spot at anchor pull:** $75,994

| Strike | Type | Venue | Ask (USDC/BTC) | Depth (BTC) | σ at pull | Pulled at |
|---:|---|---|---:|---:|---:|---|
| $77,000 | PUT | bullish | $1150.00 | 2.50 | 0.358 | 2026-05-26T22:32:48.525Z |
| $75,000 | CALL | deribit | $1162.86 | 3.10 | 0.358 | 2026-05-26T22:32:48.525Z |

### Per-strangle per-leg cost breakdown (calm regime)

| Strangle | Put leg | Call leg | Total | Put anchor | Call anchor | Regime markup |
|---|---:|---:|---:|---|---|---:|
| OTM ($74k/$78k) | $271 | $299 | $570 | interp from $77,000 | interp from $75,000 | 1.00× |
| ATM ($76k/$76k) | $985 | $1,008 | $1,992 | interp from $77,000 | interp from $75,000 | 1.00× |
| ITM guts ($77k/$75k) | $1,589 | $1,607 | $3,196 | direct $77,000 | direct $75,000 | 1.00× |

### Regime cost markup applied (B2)

| Regime | Cost markup | Source |
|---|---:|---|
| calm | 1.00× | baseline |
| moderate | 1.08× | DVOL band midpoint |
| elevated | 1.20× | DVOL band midpoint |
| stress | 1.35× | DVOL band midpoint |

> **Note:** legs marked "interp from $X" use the calibration multiplier from the nearest
> anchored strike of the same option type. Production strikes ($77k put + $75k call) MUST
> have direct anchors before live cutover. Run `probeTwoSidedAnchors.ts` to refresh.

## 1. Calm regime baseline — three strangle structures

| Structure | Hedge cost | Trigger rate (either) | Mean salvage | Salvage/hedge | **Foxify EV/pair** | **Atticus EV/pair** |
|---|---:|---:|---:|---:|---:|---:|
| OTM ($74k/$78k) | $570 | 91.0% | $774 | 1.36× | **+$148** | **+$56** |
| ATM ($76k/$76k) | $1,992 | 91.0% | $2,483 | 1.25× | **+$373** | **+$118** |
| ITM guts ($77k/$75k) | $3,196 | 91.0% | $3,881 | 1.21× | **+$543** | **+$142** |

### OTM ($74k/$78k)
*Both legs OTM by ~2.6% — cheapest, gap-zone problem*

| Metric | Value |
|---|---:|
| Hedge cost (Foxify deploys) | $570 |
| Trigger rate (down side) | 42.0% |
| Trigger rate (up side) | 48.9% |
| Trigger rate (either) | 91.0% |
| Mean salvage proceeds | $774 |
| % paths where salvage < hedge | 20.9% |
| Mean Foxify EV/pair | **+$148** |
| Foxify 95% CI | [+$144, +$152] |
| Mean Atticus EV/pair | **+$56** |
| Atticus 95% CI | [+$55, +$56] |
| %Foxify-profitable pairs | 79.1% |
| Worst Foxify single pair | -$570 |
| Best Foxify single pair | +$1,426 |

### ATM ($76k/$76k)
*Both legs near-ATM — captures full move at trigger*

| Metric | Value |
|---|---:|
| Hedge cost (Foxify deploys) | $1,992 |
| Trigger rate (down side) | 42.0% |
| Trigger rate (up side) | 48.9% |
| Trigger rate (either) | 91.0% |
| Mean salvage proceeds | $2,483 |
| % paths where salvage < hedge | 10.9% |
| Mean Foxify EV/pair | **+$373** |
| Foxify 95% CI | [+$366, +$379] |
| Mean Atticus EV/pair | **+$118** |
| Atticus 95% CI | [+$117, +$119] |
| %Foxify-profitable pairs | 89.1% |
| Worst Foxify single pair | -$1,357 |
| Best Foxify single pair | +$1,960 |

### ITM guts ($77k/$75k)
*Both legs ITM by ~1.3% — intrinsic floor + breach capture*

| Metric | Value |
|---|---:|
| Hedge cost (Foxify deploys) | $3,196 |
| Trigger rate (down side) | 42.0% |
| Trigger rate (up side) | 48.9% |
| Trigger rate (either) | 91.0% |
| Mean salvage proceeds | $3,881 |
| % paths where salvage < hedge | 9.2% |
| Mean Foxify EV/pair | **+$543** |
| Foxify 95% CI | [+$539, +$547] |
| Mean Atticus EV/pair | **+$142** |
| Atticus 95% CI | [+$141, +$143] |
| %Foxify-profitable pairs | 90.8% |
| Worst Foxify single pair | -$371 |
| Best Foxify single pair | +$2,004 |

## 1.5 Slippage sensitivity (B3) — ITM guts, calm regime

Per-leg depth (BTC): put=2.5, call=3.1.
Depth-aware slippage at single-pair unwind (1.4 BTC each leg): 0.85 (production setting).

Sensitivity to varying slippage assumption (forced):

| Slip | Hedge cost | Mean salvage | Salvage/hedge | Foxify EV/pair | Atticus EV/pair | %loss paths |
|---:|---:|---:|---:|---:|---:|---:|
| 0.92 | $3,196 | $4,174 | 1.31× | +$778 | +$201 | 8.8% |
| 0.85 | $3,196 | $3,881 | 1.21× | +$543 | +$142 | 9.2% |
| 0.75 | $3,196 | $3,462 | 1.08× | +$205 | +$61 | 17.6% |
| 0.65 | $3,196 | $3,043 | 0.95× | -$160 | +$6 | 79.0% |

> **Reading:** Slip ≤ 0.75 → multi-pair concurrent unwind (3+ pairs in same minute) hits this band.
> If Foxify EV at slip=0.75 is below operator threshold, concurrent-trigger throttle (PR 9) must enforce
> single-pair-per-minute unwind queueing during high-trigger windows.

## 2. Cross-regime — Foxify EV per pair

| Structure | Calm | Moderate | Elevated | Stress |
|---|---:|---:|---:|---:|
| OTM ($74k/$78k) | +$148 | +$155 | -$34 | -$610 |
| ATM ($76k/$76k) | +$373 | +$261 | -$109 | -$970 |
| ITM guts ($77k/$75k) | +$543 | +$323 | -$165 | -$1,192 |

### Cross-regime — Atticus EV per pair

| Structure | Calm | Moderate | Elevated | Stress |
|---|---:|---:|---:|---:|
| OTM ($74k/$78k) | +$56 | +$47 | +$12 | $0 |
| ATM ($76k/$76k) | +$118 | +$71 | +$7 | $0 |
| ITM guts ($77k/$75k) | +$142 | +$85 | +$4 | $0 |

## 3. Volume scaling 1-25 pairs/day — best structure (calm)

Best Foxify EV at calm: **ITM guts ($77k/$75k)** with **+$543/pair**.
Per-pair hedge cost: **$3,196**.

| Pairs/day | Foxify daily | Atticus daily | **Foxify annual** | **Atticus annual** | Foxify peak capital | Foxify ROI |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | +$543 | +$142 | +$198.1k | +$51.9k | $3,196 | 62× |
| 2 | +$1,086 | +$284 | +$396.3k | +$103.7k | $6,392 | 62× |
| 3 | +$1,629 | +$426 | +$594.4k | +$155.6k | $9,588 | 62× |
| 5 | +$2,714 | +$710 | +$990.7k | +$259.3k | $15,981 | 62× |
| 10 | +$5,428 | +$1,421 | +$1.98M | +$518.6k | $31,961 | 62× |
| 15 | +$8,143 | +$2,131 | +$2.97M | +$777.9k | $47,942 | 62× |
| 20 | +$10,857 | +$2,842 | +$3.96M | +$1.04M | $63,923 | 62× |
| 25 | +$13,571 | +$3,552 | +$4.95M | +$1.30M | $79,904 | 62× |

## 4. Two-sided vs single-side per activation (calm, ITM strikes)

Compared to single-side ITM ($77k put alone, +$436 Foxify EV/cover):

| Metric | Single-side ITM ($77k put) | Two-sided ITM guts | Ratio |
|---|---:|---:|---:|
| Cost per activation | $1,610 | $3,196 | 1.99× |
| Trigger rate | 32.0% | 91.0% | 2.84× |
| Mean salvage | $2,222 | $3,881 | 1.75× |
| Foxify EV/activation | +$436 | +$543 | 1.25× |
| Atticus EV/activation | +$170 | +$142 | 0.84× |
| Foxify annual @ 25/day | +$3.98M | +$4.95M | 1.25× |
| Capital deployed @ 25/day | $40,250 | $79,904 | 1.99× |
| ROI on capital | 99× | 62× | 0.63× |

## 5. Verdict

✅ **Two-sided cooperative cost-pass-through model works.** ITM guts strangle gives:
- Per-pair Foxify EV: **+$543** (vs +$436 single-side)
- Per-pair Atticus EV: **+$142** (vs +$170 single-side)
- ROI on capital: **62× annualized** (vs 99× single-side)

**Key structural finding:** ITM guts strangle has ~$2,800 intrinsic floor that doesn't decay
with theta. This is what makes two-sided much more capital-efficient than single-side ITM —
even if BTC stays flat (no trigger), the strangle retains most of its initial value.

### Volume facility recommendation

If Foxify uses this as a TWO-SIDED volume facility (paired perp activations on partner exchanges):
- **Use ITM guts strangle** ($77k put + $75k call at today's spot)
- 80/20 split, no op fee — same structure as single-side
- 25 pairs/day = Foxify +$4.95M annual, Atticus +$1.30M annual
- Foxify capital deployed: $79,904 peak (recycles 1d)

## 6. Distribution stats — Foxify per-pair P&L + rolling 7d drawdown (B5)

Per-pair P&L percentiles at calm regime, depth-aware slippage:

| Strangle | P5 | P10 | P50 | P90 | P95 |
|---|---:|---:|---:|---:|---:|
| OTM ($74k/$78k) | -$569 | -$505 | +$226 | +$449 | +$534 |
| ATM ($76k/$76k) | -$1,099 | -$60 | +$501 | +$785 | +$884 |
| ITM guts ($77k/$75k) | -$303 | +$67 | +$614 | +$879 | +$975 |

Rolling 7d drawdown (ITM guts, calm; 1000 simulated 365-day years; iid pair sampling):

| Pairs/day | Daily P&L P10 | Daily P&L median | Worst rolling-7d P5 | Worst rolling-7d P10 | Worst rolling-7d median | Annual P&L median |
|---:|---:|---:|---:|---:|---:|---:|
| 2 | +$367 | +$1,176 | +$2,506 | +$2,917 | +$3,885 | +$396.8k |
| 5 | +$1,697 | +$2,785 | +$11,376 | +$11,894 | +$13,222 | +$990.7k |
| 10 | +$4,001 | +$5,489 | +$26,988 | +$27,742 | +$29,947 | +$1.98M |
| 25 | +$11,338 | +$13,631 | +$78,525 | +$79,323 | +$82,488 | +$4.95M |

**Reading:**
- Worst rolling-7d P5 = "1-in-20 chance of a 7-day window this bad or worse" — the kill-switch calibration anchor.
- PR 9 weekly drawdown kill should fire at ~1.5× the rolling-7d P5 magnitude (margin of safety vs hitting the tail).
- Per-pair P5 sets the per-pair kill-switch threshold (the deep-loss outcomes Foxify wants flagged for review).
- iid pair sampling is OPTIMISTIC vs trending markets; real worst-7d may be 1.2-1.5× worse during sustained one-direction drift.

---

*Generated by services/api/scripts/backtest/singleSide/runTwoSidedStrangleProof.ts*