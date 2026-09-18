# Foxify Per-Day Protection — 12-Month Net Revenue Projections
**Generated:** 2026-04-27

Bull / Base / Bear scenarios scaled monthly across the first 12 months. Per-cohort Atticus net economics are **locked from the historical backtest** (PR #95). The three scenarios distinguish themselves on **user growth**, **engagement intensity**, and **tier mix** — which are the real uncertainties.

**Locked per-cohort net to Atticus (per $10k of protected position):**

| Tier | Net per cohort per $10k |
|---|---|
| 2% | $16.00 |
| 3% | $49.50 |
| 5% | $111.15 |
| 10% | $34.50 |

These are the realized Atticus net per protection cycle (entry-to-close), pulled from §0 of the deep analysis.

---

## Scenario assumptions

| | Bear | Base | Bull |
|---|---|---|---|
| Active users (M1 → M12) | 10 → 60 (linear) | 25 → 200 (linear) | 50 → 600 (exponential) |
| Cohorts per user / month (M1 → M12) | 2 → 3 | 3 → 4 | 4 → 6 |
| Avg protected position size | $17,500 | $22,500 | $27,500 |
| Tier mix (2/3/5/10%) | 5% / 20% / 30% / 45% | 10% / 25% / 40% / 25% | 15% / 25% / 45% / 15% |

**Reading the tier mix:**
- Bear: most users on the cheap 10% tier (cautious), few on the high-margin 5% tier.
- Base: balanced; 5% tier dominant (textbook drawdown protection).
- Bull: active traders favor the 5% tier (better trader-margin trade-off, generates the most Atticus margin).

---

## Headline: 12-month net revenue summary

| Scenario | Month 1 net rev | Month 6 net rev | Month 12 net rev | **12-month cumulative** | M12 active users | M12 net cash position |
|---|---|---|---|---|---|---|
| **Bear** | $3,077 | $9,122 | $19k | **$123k** | 60 | $101k |
| **Base** | $18k | $59k | $121k | **$794k** | 200 | $720k |
| **Bull** | $49k | $167k | $693k | **$3.09M** | 600 | $2.86M |

**Net cash position** = cumulative net revenue − required premium-pool reserve (~$374/active-user, from §4 of PR #95). Positive = Atticus has excess cash beyond the reserve buffer.

---

## Bear scenario — monthly breakdown

*Slow ramp, conservative engagement. Users hold longer, open fewer positions, lean on cheaper tiers.*

| Month | Active users | Cohorts opened | Monthly net rev | Cumulative net rev | Reserves required | Net cash position |
|---|---|---|---|---|---|---|
| 1 | 14 | 30 | $3,077 | $3,077 | $5,298 | -$2,222 |
| 2 | 18 | 40 | $4,141 | $7,218 | $6,857 | $361 |
| 3 | 23 | 51 | $5,278 | $12k | $8,415 | $4,080 |
| 4 | 27 | 62 | $6,487 | $19k | $9,973 | $9,008 |
| 5 | 31 | 75 | $7,768 | $27k | $12k | $15k |
| 6 | 35 | 88 | $9,122 | $36k | $13k | $23k |
| 7 | 39 | 101 | $11k | $46k | $15k | $32k |
| 8 | 43 | 116 | $12k | $58k | $16k | $42k |
| 9 | 48 | 131 | $14k | $72k | $18k | $54k |
| 10 | 52 | 146 | $15k | $87k | $19k | $68k |
| 11 | 56 | 163 | $17k | $104k | $21k | $83k |
| 12 | 60 | 180 | $19k | $123k | $22k | $101k |

## Base scenario — monthly breakdown

*Steady growth, normal active-trader engagement, balanced tier mix.*

| Month | Active users | Cohorts opened | Monthly net rev | Cumulative net rev | Reserves required | Net cash position |
|---|---|---|---|---|---|---|
| 1 | 40 | 122 | $18k | $18k | $15k | $3,611 |
| 2 | 54 | 172 | $26k | $44k | $20k | $24k |
| 3 | 69 | 223 | $34k | $78k | $26k | $52k |
| 4 | 83 | 278 | $42k | $120k | $31k | $89k |
| 5 | 98 | 335 | $50k | $170k | $37k | $134k |
| 6 | 113 | 394 | $59k | $230k | $42k | $188k |
| 7 | 127 | 455 | $69k | $299k | $48k | $251k |
| 8 | 142 | 519 | $78k | $377k | $53k | $324k |
| 9 | 156 | 586 | $88k | $465k | $58k | $407k |
| 10 | 171 | 655 | $99k | $564k | $64k | $500k |
| 11 | 185 | 726 | $110k | $674k | $69k | $604k |
| 12 | 200 | 800 | $121k | $794k | $75k | $720k |

## Bull scenario — monthly breakdown

*Strong product-market-fit, viral retail adoption, frequent traders favor the high-margin 5% tier.*

| Month | Active users | Cohorts opened | Monthly net rev | Cumulative net rev | Reserves required | Net cash position |
|---|---|---|---|---|---|---|
| 1 | 62 | 256 | $49k | $49k | $23k | $26k |
| 2 | 76 | 328 | $63k | $112k | $28k | $84k |
| 3 | 93 | 419 | $81k | $193k | $35k | $158k |
| 4 | 114 | 534 | $103k | $296k | $43k | $253k |
| 5 | 141 | 681 | $131k | $427k | $53k | $374k |
| 6 | 173 | 866 | $167k | $593k | $65k | $529k |
| 7 | 213 | 1,101 | $212k | $805k | $80k | $725k |
| 8 | 262 | 1,398 | $269k | $1.07M | $98k | $976k |
| 9 | 322 | 1,773 | $341k | $1.42M | $121k | $1.29M |
| 10 | 397 | 2,247 | $432k | $1.85M | $148k | $1.70M |
| 11 | 488 | 2,845 | $547k | $2.40M | $182k | $2.21M |
| 12 | 600 | 3,600 | $693k | $3.09M | $224k | $2.86M |

---

## Key takeaways

**Sustainability check:**
- All three scenarios become net-cash-positive within the first 12 months (cumulative revenue exceeds the required reserve).
- Bear case turns net-cash-positive by **month 2**.
- Base case turns net-cash-positive by **month 1**.
- Bull case turns net-cash-positive by **month 1**.

**The dominant variable is tier mix.** The 5% tier produces ~7× the per-cohort net of the 2% tier. Scenarios where users gravitate toward the 5% tier (Base/Bull) generate disproportionately more revenue per active user.

**The second variable is engagement.** A user opening 5 protection cohorts per month produces 2.5× the revenue of a user opening 2 cohorts per month — even at the same tier mix.

**Starting reserves required (per the deep analysis, §4):**
- Launch with 50 users: ~$19k reserves
- Launch with 100 users: ~$37k reserves
- Launch with 500 users: ~$187k reserves

If Atticus can fund the starting reserve at the chosen launch user count, the per-day product is self-funding from month 1 (revenue covers ongoing reserve growth as users are added).

---

## Caveats

- **User-growth assumptions are illustrative.** Real growth depends on Foxify's go-to-market, product-market-fit signals, and BTC market context. The three curves bracket plausible outcomes but aren't probabilistic forecasts.
- **Engagement assumptions** (cohorts per user per month) are grounded in publicly observable retail-perp-DEX behavior, not Foxify-specific data.
- **Tier mix is a critical lever** — see takeaways. If actual mix skews more toward 10% tier (catastrophe-only), revenue per user drops materially even at the same user count.
- **Per-cohort net is a 24-month average** from the deep-analysis sim. Actual cohorts in any given month may run higher (calm regimes, 5% tier) or lower (high-vol regimes, 2% tier). Pool absorbs short-term variance.
- **No churn modeled.** Implicit assumption: active-user count grows monotonically. Real product will have churn; replace user-count with net-of-churn count for true projection.