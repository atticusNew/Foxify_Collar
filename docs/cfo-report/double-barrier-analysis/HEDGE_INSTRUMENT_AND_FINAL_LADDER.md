# Hedge Instrument Switch + Best & Final Ladder

> **Status.** Final commercial ladder for the Atticus Volume Facility,
> derived from (a) empirical replay across the 6.4-year BTC + 5-year DVOL
> tape, (b) live Bullish RFQ from 2026-05-10, and (c) hedge-instrument
> sweep across daily / pooled-daily / 30-day strangles. Two structural
> moves vs PR #135's no-cooldown ladder:
>
> 1. **Switch hedge instrument from daily strangle to 30-day strangle.**
>    Empirically adds **+$362/pair-life blended Atticus margin** (≈ +$18.9 M/yr at 1,000 pairs, +$188.6 M/yr at 10,000 pairs). Live Bullish RFQ confirms 30d strangle is **43 % cheaper per day amortized** ($148/day vs $259/day). Trade-off: 7-8× more peak capital deployed.
> 2. **Pricing ladder rebalanced** to take some of that hedge savings as a Foxify rate cut (Mod under $700, Elev under $1,000, Stress dropped from $1,452 → $1,200) and the rest as Atticus margin uplift.
>
> **Final headline ladder (Phase 4-5 effective):
> `$490 / $695 / $975 / $1,200`** — meets Foxify ask of "Mod under $700,
> Elev under $1,000" and beats stress from $1,452 → $1,200. At 1,000
> pairs: Atticus +$25.3 M/yr, Foxify cost $42.8 M/yr (1.36 bps). At
> 10,000 pairs: Atticus +$253 M/yr, Foxify cost $428 M/yr. **Both sides
> beat the prior published numbers** thanks to the hedge instrument swap.

---

## 1. The two structural moves

### 1.1 Hedge instrument: daily strangle → 30-day strangle

Empirical replay (`historical/historical_summary.json`, 2,328 pair starts × 3 instruments × `tiered_400_600_900` premium schedule). Same product, same premium, same payouts. Only difference is which option Atticus buys to back the pair.

| Instrument | Calm PnL/pl | Mod PnL/pl | Elev PnL/pl | Stress PnL/pl | Blended uplift vs daily |
|---|---:|---:|---:|---:|---:|
| `daily_strangle` (current assumption) | $3,247 | $4,990 | $8,568 | $8,040 | — (baseline) |
| `pooled_daily_strangle` | $3,260 | $5,019 | $8,625 | $8,141 | +$31/pair-life |
| **`straddle_30d`** | **$3,441** | **$5,241** | **$9,223** | **$9,614** | **+$362/pair-life** |

**Live Bullish RFQ from 2026-05-10 (BTC spot $81,112, DVOL 38.71):**

| Strangle tenor | Quoted price | Per-day amortized |
|---|---:|---:|
| 1.5d (daily-strangle proxy) | $388 | **$259/day** |
| 18.5d (30-day-strangle proxy) | $2,743 | **$148/day** |

**30d is 43 % cheaper per day amortized.** Three drivers:

1. **Sub-linear time-decay.** One 30-day strangle has lower per-day amortized premium than 30 daily strangles because BS time-value decay (`Θ`) is sub-linear over time. The "30 days at once" purchase captures this convexity.
2. **Higher residual value at trigger.** When the ITM leg is sold back to the venue on a trigger, a 30d strangle has 29-30 days of remaining time value to capture; a daily strangle has 0-23 hours. The residual cash recovery is meaningfully larger.
3. **No daily-roll friction.** Daily strangle pays 50 bps × 2 legs of venue spread on each daily open AND each daily close. Across 7 days of a pair-life that's ~7 % of the strangle's value lost to spread. 30d strangle pays the spread once at open, once at unwind.

**Trade-off:** 30d strangle requires meaningfully more peak capital deployed.

| Metric | Daily strangle | 30d strangle |
|---|---:|---:|
| Peak hedge book at 1,000 pairs | ~$200 k | ~$1.5 M |
| Peak hedge book at 10,000 pairs | ~$2 M | ~$15 M |
| p05 PnL / pair-life (calm regime) | $1,397 | **$791 (worse tail)** |
| p05 PnL / pair-life (stress regime) | $3,978 | **$5,517 (better tail)** |

**Why the tail-risk pattern is acceptable:** the worse calm-tail case is "calm regime, BTC drifts beyond strikes, residual unwind realises some loss" — a contained, predictable variance. The better stress-tail case is "stress regime, BTC moves big, 30d strangle captures more vega upside" — exactly the kind of optionality Atticus needs in stress.

**ROI on the incremental capital:** ~$1.3 M extra peak capital at 1,000 pairs returns ~$18.9 M/yr in margin — about **12× annual ROI on incremental capital deployed**. Easily worth it.

### 1.2 Empirical breakeven floors drop with 30d hedge

| Band | Daily-hedge breakeven $/day | **30d-hedge breakeven $/day** | Δ |
|---|---:|---:|---:|
| Calm | $472 | **$423** | −$49 |
| Mod | $693 | **$667** | −$26 |
| Elev | $994 | **$932** | −$62 |
| Stress | $1,426 | **$1,043** | **−$383** |

**Stress floor drops from $1,426 → $1,043 — a 27 % reduction.** That's the line-item that opens up the dramatic stress tier reduction in the new ladder ($1,452 → $1,200).

## 2. Calm $525 question — does it help?

Tested four ladders at the daily-hedge baseline (since this is a separate question from the hedge swap):

| Ladder | Atticus margin/pl | Atticus annual @ 1k | Foxify cost @ 1k |
|---|---:|---:|---:|
| A: $490/$696/$996/$1,452 (current best) | +$376 | $19.6 M | $57.1 M |
| **B: $525/$696/$996/$1,452** (calm raise) | **+$489** | **$25.5 M (+$5.9 M)** | $63.0 M (+$5.9 M) |
| C: $525/$685/$985/$1,452 (calm fund tighter mod/elev) | +$426 | $22.2 M | $59.7 M |
| D: $525/$696/$985/$1,452 (calm fund tighter elev only) | +$472 | $24.6 M | $62.2 M |

**Two findings:**

1. **Raising calm to $525 directly transfers ~$5.9 M/yr from Foxify to Atticus** at 1,000 pairs (1:1; calm is 35.4 % of regime weight × $35/day uplift × 49 pair-lives × 1,000 pairs ≈ $5.9 M). It's a discretionary "more buffer for Atticus" decision.
2. **Calm uplift cannot meaningfully fund Mod/Elev tightening** — Mod $681 / Elev $970 are HARD analytical floors (and $693 / $994 are HARD empirical floors). Try to push Mod below $681 with calm subsidising it (Option C above) and Mod posts a per-pair-life loss in 43 % of days; cross-subsidy works on average but exposes Atticus to monthly volatility. Recommended: do NOT use calm to subsidise mod/elev. Use it for buffer or leave it at $490.

**Recommendation: leave Calm at $490** unless founder wants to take an extra ~$5.9 M/yr at 1,000 pairs of Atticus margin (it's defensible — calm is 35 % of days and $490 is right at the breakeven floor with thin 5 % margin). If you want extra Atticus margin, the cleaner move is the hedge instrument swap (§1.1) which gives ~$18.9 M/yr at 1,000 pairs with **no Foxify cost increase**.

## 3. Best & final ladder with both moves: `$490 / $695 / $975 / $1,200`

### 3.1 Per-band economics (with 30d strangle hedge, empirical mults & hedge costs)

| Band | Rate | Premium / pl | Payouts / pl | Hedge / pl | **PnL / pl** | **Margin %** |
|---|---:|---:|---:|---:|---:|---:|
| Calm | $490 | $4,471 | $3,800 | $59 | **+$612** | **13.7 %** |
| Mod | $695 | $6,839 | $6,195 | $370 | **+$274** | **4.0 %** |
| Elev | $975 | $10,360 | $9,104 | $800 | **+$456** | **4.4 %** |
| Stress | $1,200 | $15,240 | $12,139 | $1,103 | **+$1,998** | **13.1 %** |
| **Blended** (35.4/42.8/14.4/5.8) | — | $7,194 | — | — | **+$516** | **~7.3 %** |

### 3.2 Foxify cost / pair-life by tier

| Band | Premium / pl | Payouts / pl | **Foxify net cost / pl** | Foxify $/day |
|---|---:|---:|---:|---:|
| Calm | $4,471 | $3,800 | $671 | $96 |
| Mod | $6,839 | $6,195 | $644 | $92 |
| Elev | $10,360 | $9,104 | $1,256 | $179 |
| Stress | $15,240 | $12,139 | $3,101 | $443 |
| **Blended** | — | — | **$874** | **$125** |

### 3.3 Annual economics at scale

| Scale | Atticus annual | Foxify cost annual | Cost on volume |
|---|---:|---:|---:|
| 1,000 pairs | **+$25.3 M** | **$42.8 M** | **1.36 bps** |
| 10,000 pairs | **+$253 M** | **$428 M** | **1.36 bps** |

### 3.4 Comparison vs prior published ladders

| Ladder | Hedge | Atticus @ 1k | Foxify @ 1k | Foxify bps |
|---|---|---:|---:|---:|
| Original $490/$605/$795/$865 + 8 % rebate (PR #133/#134) | daily | **−$49 M** (LOSS — assumed cooldown clip didn't materialise) | $42 M (assumed) | 1.38 (assumed) |
| Hardened $490/$625/$795/$865 + 6 % rebate (PR #134) | daily | $13 M (assumed cd clip) / **−$49 M** (empirical) | $42 M / $42 M | 1.38 |
| No-cooldown $490/$720/$1,025/$1,455 (PR #135) | daily | +$18 M | $47 M | 1.49 |
| **THIS PR — $490/$695/$975/$1,200 + 30d hedge** | **30d** | **+$25 M** | **$43 M** | **1.36** |

**Final ladder beats every prior version on both sides:**
- Lower Foxify cost than no-cooldown ladder (1.36 vs 1.49 bps; $43 M vs $47 M at 1k pairs)
- Higher Atticus margin than no-cooldown ladder ($25 M vs $18 M at 1k pairs)
- Hits Foxify "Mod under $700, Elev under $1,000" target
- Drops Stress dramatically ($1,200 vs $1,455) — most visible CFO-facing improvement

## 4. Customer-facing rebate ladder

Phase 4-5 effective rates land at **$490 / $695 / $975 / $1,200**; Phase 1 base is ladder/0.94 to fund Atticus margin during scale-up.

| Foxify monthly volume | Rebate on Mod/Elev/Stress | Calm | Mod | Elev | Stress |
|---|---|---:|---:|---:|---:|
| 0–100 pair-days/mo (Phase 1) | 0 % | $490 | $740 | $1,037 | $1,277 |
| 100–500 / mo (Phase 2) | 2 % | $490 | $725 | $1,016 | $1,251 |
| 500–2,000 / mo (Phase 3) | 4 % | $490 | $710 | $995 | $1,226 |
| **2,000+ / mo (Phase 4-5, cap)** | **6 %** | **$490** | **$695** | **$975** | **$1,200** |

(Calm $490 never rebates — at structural floor with 13.7 % margin available to absorb venue cost variance. Cap at 6 %; no 8 % stretch needed since the 30d hedge swap already delivers the venue savings.)

## 5. Risk register for the 30d hedge swap

| Risk | Magnitude | Mitigant |
|---|---|---|
| Higher peak capital deployment ($1.3 M extra at 1k pairs) | Material — ~$15 M extra at 10k pairs | ROI ~12× per year on incremental capital; capital is recoverable on unwind. Add explicit capital allocation in capital ramp plan (`capital_ramp_table.csv` to be updated). |
| Worse calm-regime p05 PnL ($1,397 → $791 per pair-life) | Modest — affects calm-regime tail only | 13.7 % calm margin on the new ladder absorbs the worse tail comfortably. Also: blended mean PnL is much higher, so capital reserve adequacy is unchanged or improved. |
| Strike drift after first trigger (30d strangle's strikes don't reset) | Modest — addressed by anchor-reset on each trigger in product economics (Foxify reopens both perps; the 30d strangle continues to bracket the original anchor zone) | Any "drift loss" is captured in the empirical PnL — the +$362/pair-life uplift is NET of this effect. |
| Vega exposure (longer-dated options have higher implied-vol sensitivity) | Modest — DVOL movements affect 30d strangle MTM more than daily | Atticus's natural position is long-vol, so vega exposure is consistent with the structural hedge thesis. T3 cooldown trigger (hedge MTM drift) catches the rare adverse vega scenarios. |
| Greater capital required for Phase 1 launch | Mild — Phase 1 is 4.3 pairs avg = ~$6,500 peak hedge book even at 30d | Trivial at Phase 1 scale; affects Phase 4-5 (1k+ pairs) where Atticus is well-capitalised anyway. |

## 6. Implementation steps

1. **Live RFQ confirmation.** Re-run `services/api/scripts/volFacilityHedgeRfq.ts` with `--tenor-days 30 --notional-usd 50000` to get current Bullish quote at the next pair-open. Should match the May-10 RFQ within 20 % (vol-regime dependent).
2. **Capital allocation.** Update `capital_ramp_table.csv` to reflect 30d peak capital ($1,500/pair vs $200/pair for daily). Approximate: Phase 4 (1,000 pairs) needs $1.5 M peak hedge capital allocation (was $200 k); Phase 5 (10,000 pairs) needs $15 M (was $2 M).
3. **Production hedge logic.** `services/api/src/volFacility/hedgeBook.ts` (or equivalent) should default `tenor_days = 30` and roll on pair-open, not daily. Daily-strangle path retained as fallback if 30d Bullish quotes time out or come in worse than 1.4× the empirical model.
4. **Empirical re-validation post-launch.** After 30 days of live trading, run a back-test of realised hedge cost vs the empirical `straddle_30d` PnL distribution. If realised hedge cost is within 30 % of model (the same band the May-10 RFQ landed in), confirm 30d as production default. If outside that band, fall back to daily strangle and re-quote pricing.

## 7. Bottom line

> **Final commercial ladder: $490 / $695 / $975 / $1,200 per pair per day**
> with 30-day strangle hedge instrument and a 6 %-cap rebate ladder
> (Phase 1 base $490/$740/$1,037/$1,277; Phase 4-5 effective
> $490/$695/$975/$1,200). At 1,000 pairs: Atticus +$25 M/yr, Foxify
> cost $43 M/yr (1.36 bps). At 10,000 pairs: Atticus +$253 M/yr,
> Foxify cost $428 M/yr.
>
> **The 30d strangle hedge swap is the single biggest economic
> improvement in this engagement** — empirically adds $18.9 M/yr at
> 1,000 pairs and $188.6 M/yr at 10,000 pairs vs the daily strangle
> baseline that all prior pricing analysis assumed. Live Bullish RFQ
> confirms 30d is 43 % cheaper per day amortized. The trade-off (7-8×
> more peak hedge capital) returns ~12× annual ROI on the incremental
> capital, easily worth it.
>
> **Calm $490 stays at floor.** Raising to $525 transfers ~$5.9 M/yr
> 1:1 from Foxify to Atticus and does NOT structurally allow Mod/Elev
> to go below their hard breakeven floors. Discretionary; recommend
> hold at $490 since the hedge swap already delivers the Atticus
> margin uplift cleanly.

---

*Reproducible:* hedge instrument PnL via `historical/historical_summary.json` from `python3 scripts/double-barrier/historical_replay.py`. Live Bullish RFQ via `pnpm tsx services/api/scripts/volFacilityHedgeRfq.ts --notional-usd 50000 --tenor-days 30`.
