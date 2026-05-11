# Barrier Width Analysis — 2% vs 3% Empirical

> **CEO question (2026-05-11):** *"How would making 2% to 3% effect pricing?"*
>
> **Short answer:** Going from ±2% to ±3% barrier **cuts trigger
> frequency in HALF** across every regime (calm 3.80 → 1.61 trig/pair-life,
> stress 12.14 → 6.26), and drops the empirical breakeven floor by 30–55%.
> Two structural choices on the payout-cap side:
> - **3% / $1,000 cap (cheapest cover)** — pricing $208/$400/$633/$759, Foxify cost falls from 1.45 bps to **0.68 bps**, but Foxify's payout income halves and they self-bear the first 2% of any gap.
> - **3% / $1,500 cap (matches wider gap)** — pricing $314/$582/$911/$1,093, Foxify cost **0.81 bps** and each trigger pays 50% more to keep the absolute payout volume meaningful.
>
> **Recommended if going wider: 3% / $1,500 cap.** Cleanly maps "wider gap → bigger payout per trigger" and roughly preserves Foxify's per-pair-life payout volume at $219k/yr (vs $312k at 2% / $1k cap).

---

## 1. The empirical replay — trigger frequency at 3% barrier

`scripts/double-barrier/historical_replay.py --barrier-pct 0.03` against the full 6.4-year BTC + 5-year DVOL tape, 2,328 pair starts:

| Band | 2% barrier trig/pair-life | 3% barrier trig/pair-life | **Reduction** |
|---|---:|---:|---:|
| Calm (DVOL <50) | 3.80 | 1.61 | **−58%** |
| Mod (50–65) | 6.20 | 2.86 | **−54%** |
| Elev (65–80) | 9.10 | 4.57 | **−50%** |
| Stress (≥80) | 12.14 | 6.26 | **−48%** |

**Across all regimes: ~50% fewer triggers per pair-life.** This is consistent with BS theory — the probability of breaching a wider barrier is roughly half that of the narrower one at the daily timescale.

## 2. Empirical breakeven floors (with 30d strangle hedge)

Floor = `(payouts/pair-life + hedge_net/pair-life) / mult_pair`. Both payouts and hedge cost change with the wider barrier:

| Band | 2% / $1k cap floor | **3% / $1k cap floor** | **3% / $1.5k cap floor** |
|---|---:|---:|---:|
| Calm | $423 | **$198** (−53%) | $299 (−29%) |
| Mod | $667 | **$380** (−43%) | $553 (−17%) |
| Elev | $932 | **$602** (−35%) | $865 (−7%) |
| Stress | $1,043 | **$721** (−31%) | $1,039 (~equal) |

## 3. Proposed pricing ladders at 5% Atticus margin (rounded)

| Band | 2% / $1k cap (current PR #136) | **3% / $1k cap** | **3% / $1.5k cap** |
|---|---:|---:|---:|
| Calm | $490 | **$208** (−58%) | **$314** (−36%) |
| Mod | $695 | **$400** (−42%) | **$582** (−16%) |
| Elev | $975 | **$633** (−35%) | **$911** (−7%) |
| Stress | $1,200 | **$759** (−37%) | **$1,093** (−9%) |

## 4. Foxify economics at the proposed ladders

### Option G — 3% barrier, $1,000 payout cap (cheapest cover)

| Band | Rate $/day | Trig/day | Exp. payout $/day | **Foxify NET $/day** |
|---|---:|---:|---:|---:|
| Calm | $208 | 0.23 | $230 | **+$22** (positive) |
| Mod | $400 | 0.41 | $409 | **+$9** (positive) |
| Elev | $633 | 0.65 | $653 | **+$20** (positive) |
| Stress | $759 | 0.89 | $894 | **+$135** (positive) |

Foxify is net positive on premium-vs-expected-payouts in every regime (same structural property as the 2% ladder).

| Scale | Atticus margin | Foxify cost | Foxify cost on volume |
|---|---:|---:|---:|
| 1,000 pairs | **+$8.3M/yr** | **$21.6M/yr** | **0.68 bps** |
| 10,000 pairs | +$83.5M/yr | $215.6M/yr | 0.68 bps |

**Foxify cost drops from 1.45 bps to 0.68 bps (−53%).** But: trigger payout income drops from $312k/pair/yr to **$146k/pair/yr (−53%)**. The cover is cheaper because Atticus is paying out half as often.

### Option H — 3% barrier, $1,500 payout cap (matches wider gap, recommended)

| Band | Rate $/day | Trig/day | Exp. payout $/day | **Foxify NET $/day** |
|---|---:|---:|---:|---:|
| Calm | $314 | 0.23 | $345 | **+$31** (positive) |
| Mod | $582 | 0.41 | $613 | **+$31** (positive) |
| Elev | $911 | 0.65 | $979 | **+$68** (positive) |
| Stress | $1,093 | 0.89 | $1,341 | **+$248** (positive) |

| Scale | Atticus margin | Foxify cost | Foxify cost on volume |
|---|---:|---:|---:|
| 1,000 pairs | **+$12.2M/yr** | **$25.4M/yr** | **0.81 bps** |
| 10,000 pairs | +$122.4M/yr | $254.5M/yr | 0.81 bps |

**Foxify cost drops from 1.45 bps to 0.81 bps (−44%).** Trigger payout income: $146 trig/yr × $1,500 = **$219k/pair/yr** (vs $312k at 2% / $1k cap, only −30% drop).

## 5. Side-by-side comparison — three barrier/cap options

At 1,000 pairs, blended across regimes (35.4 / 42.8 / 14.4 / 5.8 weights):

| Structure | Annual triggers/pair | Annual payouts received/pair | Foxify cost/yr/pair | Foxify cost on volume | Atticus margin/yr |
|---|---:|---:|---:|---:|---:|
| **2% / $1k cap** (PR #136) | 312 | $312k | $46k | **1.45 bps** | $27M |
| **3% / $1k cap** | 146 | $146k | $22k | **0.68 bps** ↓↓ | $8M |
| **3% / $1.5k cap** | 146 | $219k | $25k | **0.81 bps** ↓ | $12M |

## 6. The trade-off summary

**What Foxify GAINS by going to 3%:**
- 30–55% lower premium per regime
- Cost on routed volume drops to 0.68–0.81 bps
- Less operational churn (half as many trigger events to handle)
- Cleaner P&L tracking (fewer pay-out events per pair-life)

**What Foxify LOSES by going to 3%:**
- Self-bears the first 2% of every gap move (Atticus only kicks in past 2%)
- Trigger payout income drops 30% (with $1.5k cap) or 53% (with $1k cap)
- Less "active feel" for traders if the platform UX shows triggers fire frequently — half as many trigger events per day per pair

**What Atticus loses by going to 3%:**
- Lower total premium volume (~50% lower at $1k cap, ~30% lower at $1.5k cap)
- Margin compression in absolute terms ($27M → $8M or $12M at 1k pairs)
- BUT margin-on-premium (5% Atticus) stays the same — it's a smaller-volume product, not a worse-margin one

## 7. Recommendation

**If the CEO wants meaningfully cheaper cover and is comfortable with Foxify self-bearing the first 2% of any move, the cleanest answer is Option H (3% / $1,500 cap).** Three reasons:

1. **Cap matches the gap.** A 3% barrier on a $50k position has up to $1,500 of gap exposure — paying $1,500 per trigger covers the full new gap distance. Symmetric, clean to explain.
2. **Foxify's payout income only drops 30%** (vs 53% at $1k cap) — cover is still meaningful protection income, not just gap insurance.
3. **Foxify cost on volume drops ~44%** (1.45 → 0.81 bps) — material savings, not a token reduction.

**Customer-facing rebate ladder for Option H (3% / $1.5k cap, 6%-cap rebate at 2,000+ pair-days/mo):**

| Foxify monthly volume | Rebate | Calm | Mod | Elev | Stress |
|---|---|---:|---:|---:|---:|
| 0–100 pair-days/mo | 0% | $314 | $619 | $969 | $1,163 |
| 100–500 / mo | 2% | $314 | $607 | $950 | $1,140 |
| 500–2,000 / mo | 4% | $314 | $594 | $930 | $1,116 |
| **2,000+ / mo (cap)** | **6%** | **$314** | **$582** | **$911** | **$1,093** |

(Phase 1 base = effective ÷ 0.94. Calm doesn't rebate — at structural floor.)

## 8. The diagnostic question for the CEO

Two things to confirm before changing the barrier:

**Q1: Does Foxify use trigger payouts as revenue (e.g., to fund trader rebates), or purely as gap insurance for their own book?**
- If revenue: stay at 2% (more frequent payouts, more cash flow to redistribute) OR move to 3%/$1.5k cap (preserves more payout income than 3%/$1k cap).
- If insurance only: 3% / $1k cap is fine — Foxify cares about the cover, not the cash flow from triggers.

**Q2: Is the trader-facing UX sensitive to how often "triggers" fire?**
- If yes (e.g., dashboard shows "your pair just triggered"): stay at 2% to keep the feel of frequent activity.
- If no: 3% works fine.

If both answers are "insurance only / not UX sensitive," 3% barrier is straight-up better for Foxify economics. If either is "yes," 2% might be the right structure.

## 9. The five-second TL;DR for the CEO

> *"3% barrier cuts your cover cost by 35–55% per regime. Two flavors: (A) keep $1,000 trigger payout — cheapest possible at 0.68 bps on volume, but you get half as many triggers. (B) raise trigger payout to $1,500 to match the wider gap — 0.81 bps on volume (vs current 1.45 bps), trigger payout income falls only 30% instead of 53%. Recommended is (B) — cleaner economics, Foxify pays roughly half the bps cost of the 2% ladder."*
