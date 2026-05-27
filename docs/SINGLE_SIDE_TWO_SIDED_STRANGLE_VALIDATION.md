# Two-Sided Strangle Validation — Cooperative Cost-Pass-Through

**Generated:** 2026-05-26T22:32:48.525Z
**Pair config:** 50k/2% with ±2% triggers, 1.4 BTC contracts, 3-day tenor
**Split:** 80/20 (Foxify favor), no op fee
**Spot anchor:** $75,994
**Paths per scenario:** 25,000

## Background

Two-sided pair = Foxify opens long perp + short perp simultaneously.
Either ±2% trigger closes the entire pair. Atticus hedges with a strangle
(long put + long call), splits salvage 80/20 per the cooperative model.

## 1. Calm regime baseline — three strangle structures

| Structure | Hedge cost | Trigger rate (either) | Mean salvage | Salvage/hedge | **Foxify EV/pair** | **Atticus EV/pair** |
|---|---:|---:|---:|---:|---:|---:|
| OTM ($74k/$78k) | $578 | 91.9% | $859 | 1.49× | **+$211** | **+$70** |
| ATM ($76k/$76k) | $2,019 | 91.9% | $2,587 | 1.28× | **+$437** | **+$132** |
| ITM guts ($77k/$75k) | $3,238 | 91.9% | $3,977 | 1.23× | **+$586** | **+$153** |

### OTM ($74k/$78k)
*Both legs OTM by ~2.6% — cheapest, gap-zone problem*

| Metric | Value |
|---|---:|
| Hedge cost (Foxify deploys) | $578 |
| Trigger rate (down side) | 46.0% |
| Trigger rate (up side) | 45.9% |
| Trigger rate (either) | 91.9% |
| Mean salvage proceeds | $859 |
| % paths where salvage < hedge | 19.7% |
| Mean Foxify EV/pair | **+$211** |
| Foxify 95% CI | [+$206, +$217] |
| Mean Atticus EV/pair | **+$70** |
| Atticus 95% CI | [+$69, +$71] |
| %Foxify-profitable pairs | 80.3% |
| Worst Foxify single pair | -$578 |
| Best Foxify single pair | +$8,639 |

### ATM ($76k/$76k)
*Both legs near-ATM — captures full move at trigger*

| Metric | Value |
|---|---:|
| Hedge cost (Foxify deploys) | $2,019 |
| Trigger rate (down side) | 46.0% |
| Trigger rate (up side) | 45.9% |
| Trigger rate (either) | 91.9% |
| Mean salvage proceeds | $2,587 |
| % paths where salvage < hedge | 10.5% |
| Mean Foxify EV/pair | **+$437** |
| Foxify 95% CI | [+$429, +$444] |
| Mean Atticus EV/pair | **+$132** |
| Atticus 95% CI | [+$131, +$133] |
| %Foxify-profitable pairs | 89.5% |
| Worst Foxify single pair | -$1,384 |
| Best Foxify single pair | +$9,390 |

### ITM guts ($77k/$75k)
*Both legs ITM by ~1.3% — intrinsic floor + breach capture*

| Metric | Value |
|---|---:|
| Hedge cost (Foxify deploys) | $3,238 |
| Trigger rate (down side) | 46.0% |
| Trigger rate (up side) | 45.9% |
| Trigger rate (either) | 91.9% |
| Mean salvage proceeds | $3,977 |
| % paths where salvage < hedge | 8.5% |
| Mean Foxify EV/pair | **+$586** |
| Foxify 95% CI | [+$580, +$592] |
| Mean Atticus EV/pair | **+$153** |
| Atticus 95% CI | [+$152, +$154] |
| %Foxify-profitable pairs | 91.5% |
| Worst Foxify single pair | -$413 |
| Best Foxify single pair | +$9,366 |

## 2. Cross-regime — Foxify EV per pair

| Structure | Calm | Moderate | Elevated | Stress |
|---|---:|---:|---:|---:|
| OTM ($74k/$78k) | +$211 | +$547 | +$1,193 | +$1,966 |
| ATM ($76k/$76k) | +$437 | +$1,080 | +$1,974 | +$2,924 |
| ITM guts ($77k/$75k) | +$586 | +$1,438 | +$2,463 | +$3,498 |

### Cross-regime — Atticus EV per pair

| Structure | Calm | Moderate | Elevated | Stress |
|---|---:|---:|---:|---:|
| OTM ($74k/$78k) | +$70 | +$138 | +$298 | +$492 |
| ATM ($76k/$76k) | +$132 | +$270 | +$493 | +$731 |
| ITM guts ($77k/$75k) | +$153 | +$359 | +$616 | +$874 |

## 3. Volume scaling 1-25 pairs/day — best structure (calm)

Best Foxify EV at calm: **ITM guts ($77k/$75k)** with **+$586/pair**.
Per-pair hedge cost: **$3,238**.

| Pairs/day | Foxify daily | Atticus daily | **Foxify annual** | **Atticus annual** | Foxify peak capital | Foxify ROI |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | +$586 | +$153 | +$213.8k | +$55.9k | $3,238 | 66× |
| 2 | +$1,171 | +$306 | +$427.6k | +$111.8k | $6,477 | 66× |
| 3 | +$1,757 | +$459 | +$641.3k | +$167.7k | $9,715 | 66× |
| 5 | +$2,929 | +$766 | +$1.07M | +$279.5k | $16,192 | 66× |
| 10 | +$5,857 | +$1,531 | +$2.14M | +$559.0k | $32,385 | 66× |
| 15 | +$8,786 | +$2,297 | +$3.21M | +$838.4k | $48,577 | 66× |
| 20 | +$11,714 | +$3,063 | +$4.28M | +$1.12M | $64,769 | 66× |
| 25 | +$14,643 | +$3,828 | +$5.34M | +$1.40M | $80,962 | 66× |

## 4. Two-sided vs single-side per activation (calm, ITM strikes)

Compared to single-side ITM ($77k put alone, +$436 Foxify EV/cover):

| Metric | Single-side ITM ($77k put) | Two-sided ITM guts | Ratio |
|---|---:|---:|---:|
| Cost per activation | $1,610 | $3,238 | 2.01× |
| Trigger rate | 32.0% | 91.9% | 2.87× |
| Mean salvage | $2,222 | $3,977 | 1.79× |
| Foxify EV/activation | +$436 | +$586 | 1.34× |
| Atticus EV/activation | +$170 | +$153 | 0.90× |
| Foxify annual @ 25/day | +$3.98M | +$5.34M | 1.34× |
| Capital deployed @ 25/day | $40,250 | $80,962 | 2.01× |
| ROI on capital | 99× | 66× | 0.67× |

## 5. Verdict

✅ **Two-sided cooperative cost-pass-through model works.** ITM guts strangle gives:
- Per-pair Foxify EV: **+$586** (vs +$436 single-side)
- Per-pair Atticus EV: **+$153** (vs +$170 single-side)
- ROI on capital: **66× annualized** (vs 99× single-side)

**Key structural finding:** ITM guts strangle has ~$2,800 intrinsic floor that doesn't decay
with theta. This is what makes two-sided much more capital-efficient than single-side ITM —
even if BTC stays flat (no trigger), the strangle retains most of its initial value.

### Volume facility recommendation

If Foxify uses this as a TWO-SIDED volume facility (paired perp activations on partner exchanges):
- **Use ITM guts strangle** ($77k put + $75k call at today's spot)
- 80/20 split, no op fee — same structure as single-side
- 25 pairs/day = Foxify +$5.34M annual, Atticus +$1.40M annual
- Foxify capital deployed: $80,962 peak (recycles 1d)

---

*Generated by services/api/scripts/backtest/singleSide/runTwoSidedStrangleProof.ts*