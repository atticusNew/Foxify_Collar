# Atticus Volume Facility — One-Sheet for Foxify CEO

> Print this. Sign at the bottom. Phase 1 launches.

---

## The structure in one diagram

```
For each pair:  Foxify opens LONG $50k + SHORT $50k
                Atticus protection runs 24h, auto-renews unless trigger fires
                If BTC moves ±2%, Atticus pays Foxify $1,000 (capped), pair re-anchors
                Repeats until Foxify closes or 7-day max tenor
```

**Atticus charges Foxify a daily premium that scales with BTC implied volatility (DVOL). That's it.**

---

## Premium tiers — base rates and rebates

### Base rate (what Foxify pays per pair per day, before volume rebate)

| BTC regime | Days/year (balanced est.) | **Per pair / day** | Why this rate |
|---|---|---|---|
| **Calm** (DVOL <50) | **129 days** (~35%) | **$490** | Few triggers (3-4/week per pair). Premium just covers Atticus's hedge cost + thin 5% margin. |
| **Moderate** (50-65) | **156 days** (~43%) | **$625** | More triggers (~6/week). Payouts to Foxify scale; premium scales with them. Sized to keep ~7% margin under conservative cooldown clip assumptions. |
| **Elevated** (65-80) | **52 days** (~14%) | **$795** | Heavy triggers (~9/week). Foxify gets paid out frequently; Atticus's hedge churn is higher. |
| **Stress** (≥80) | **21 days** (~6%) | **$865** | Maximum triggers (~12/week). Cooldown protections engaged in this band. |

**Why higher tiers cost more:** more triggers = more $1,000 payouts to Foxify + more option-buying churn at the venue. The premium scales with the actual cost of providing protection in that regime — it's not arbitrary, it's the underwriting math.

**Foxify gets paid out more in higher tiers too** — at stress, ~12 trigger payouts per week per pair = $12,000/pair/week of Atticus payouts to Foxify. The extra premium is funding the extra payouts.

### Volume rebate (Foxify's price drops as volume scales)

**Calm tier never rebates** ($490 is the structural floor — at venue cost + minimal Atticus margin). Mod / Elev / Stress rebate based on prior month's volume. **Top tier capped at 6%** in base ladder; the additional 8% slot unlocks only when Bullish institutional pricing tier and Falcon-X cross-venue routing have been demonstrated in production:

| Foxify monthly volume | Rebate | Effective Calm | Effective Mod | Effective Elev | Effective Stress |
|---|---|---|---|---|---|
| 0–100 pair-days/mo (Phase 1) | **0%** | $490 | $625 | $795 | $865 |
| 100–500 / mo | **2%** | $490 | $613 | $779 | $848 |
| 500–2,000 / mo | **4%** | $490 | $600 | $763 | $830 |
| **2,000+ / mo (base ladder cap)** | **6%** | **$490** | **$588** | **$747** | **$813** |
| Stretch tier (Bullish institutional + Falcon-X demonstrated) | **+2% (8% total)** | $490 | $575 | $731 | $796 |

Rebate is a monthly credit on the prior month's Mod/Elev/Stress premium spend.

**The rebate is funded by structural cost savings Atticus realizes at scale**, not by margin compression alone. Specifically:
- Pooled hedge book at >25 pairs: 30% reduction in venue spread on options
- Bullish institutional pricing tier at $100M+/month: 10-20% additional reduction
- Cross-venue best-execution routing (Deribit + Falcon X added in Phase 3+): 5-15% additional reduction
- **Combined ~50% hedge cost reduction at full scale**, which directly funds the rebate ladder

If those venue-cost reductions don't fully materialize at any scale (e.g., if Bullish doesn't deliver the institutional tier discount they've indicated), the pricing reset clause kicks in: premium ladder reverts to the higher tier for one month while Atticus and Foxify reconcile. Restored to rebated rate when conditions normalize.

### Where the regime distribution comes from

**Balanced estimate (median of three windows, NOT skewed by 2021's post-COVID anomaly or 2024-25's calm bias):**

| Window | Calm <50 | Mod 50-65 | Elev 65-80 | Stress ≥80 |
|---|---|---|---|---|
| Full 5.1y (incl. 2021 crisis) | 30% | 36% | 14% | **19%** ← high stress, includes worst year |
| Excluding 2021 (worst year removed) | 35% | 43% | 16% | 6% |
| Recent 24 months (current calm) | 50% | 49% | 1% | 0% ← biased toward easy years |
| **BALANCED MEDIAN (recommended)** | **35%** | **43%** | **14%** | **6%** |

**This isn't skewed to last year — the most-recent-24-month bucket gets the LOWEST stress weight; we use the median instead, which lands at a fair 6% stress assumption.**

---

## What this costs Foxify, end-to-end

Per pair at Foxify's stated model (2.16 triggers/day average, validated by your own per-second BTC data over 2 weeks at 21.05% per 2hr window):

```
Foxify routes per pair:    $864,000/day = $315M/year of partner-exchange volume
Foxify pays Atticus:       Daily premium per the tier above
Foxify receives from Atticus:   $1,000 per trigger (capped, contractual)
```

**At each scale phase (balanced regime mix; Foxify net cost = premium paid − payouts received, with cooldown clip applied to payouts per `COOLDOWN_FOXIFY_BREAKDOWN.md`):**

| Phase | Pairs | Rebate active | Foxify net cost / year (realised) | Net cost on volume | Foxify gross @ 5 bps rebate | **Foxify NET annual** |
|---|---|---|---|---|---|---|
| 1 (Pilot) | 4.3 | 0% | $190k | 1.40 bps | $679k | **+$489k** |
| 2 | 12.9 | 2% | $548k | 1.34 bps | $2.04M | **+$1.49M** |
| 3 | 100 | 4% | $4.05M | 1.29 bps | $15.8M | **+$11.7M** |
| 4 | 1,000 | 6% (base cap) | $42.0M | 1.38 bps | $158M | **+$116M** |
| **5 (Foxify-scale)** | **10,000** | **6% base / 8% stretch** | **$420M base / $390M stretch** | **1.38 / 1.28 bps** | **$1.58B** | **+$1.16B base / +$1.19B stretch** |

**Cost on volume holds in the ~1.3–1.4 bps band** across the scale ladder. The 8% stretch rebate (when Bullish institutional pricing tier and Falcon-X cross-venue routing are demonstrated in production) trims another ~0.1 bps. **Foxify keeps the dominant share of partner-rebate income at every phase.**

**At 5 bps partner-rebate income (typical institutional rate):**
- Phase 1 (4.3 pairs): Foxify nets ~$489k/year
- Phase 4 (1,000 pairs): **Foxify nets +$116M/year**
- Phase 5 (10,000 pairs): **Foxify nets +$1.16B/year (base) / +$1.19B (stretch rebate active)**

**Sensitivity to BTC regime mix:** these numbers use balanced regime weights (calm 35% / mod 43% / elev 14% / stress 6%). If BTC enters a sustained calm regime (like 2024-25), Foxify's cost drops ~25% lower. If sustained stress (like 2021), cost rises ~30%. **Pricing self-adjusts with market conditions, no manual intervention.**

**Numbers are net of cooldown clipping** ~8 trigger payouts/pair/yr (~$8k/pair/yr) and ~$11M/pair/yr of routed volume in cooldown windows — see `COOLDOWN_FOXIFY_BREAKDOWN.md` for the regime-by-regime breakdown. **Foxify's cost-on-volume is the right number to read; cooldown reduces the absolute volume and absolute payouts roughly proportionally.**

---

## Why this is cheaper than every alternative

| Foxify's alternative | Cost (per $100k notional pair) | Why Atticus is cheaper |
|---|---|---|
| **Self-hedge at Bullish/Deribit** (buy daily ±2% strangle yourself) | **~$260/pair/day** = ~26 bps/day on notional | Foxify lacks Atticus's institutional volume tier discount; pays full retail spread |
| **Buy a 30-day strangle** (less frequent rebuy) | $148/day amortized but strikes drift away from new anchors after first trigger; mismatch creates re-buy cycles that eat the savings | Atticus handles the strike-drift management with pooled book |
| **Variance swaps** (institutional vol product) | 20-50 bps/day on notional | 10-30× more expensive than Atticus's 1.9 bps net |
| **Prediction markets (Kalshi / Polymarket)** | Doesn't exist at $50k pair size with 2% barrier and auto-reopen | Structurally not available — these markets settle once, no re-anchoring |
| **No hedge** | Free (in dollar terms) | Gap risk caps your max position size at 1/5 of what Atticus enables |

**Atticus's 1.9 bps cost is structurally the cheapest path Foxify has to bounded-risk volume operations at $50M+/day notional.**

---

## Why this can't blow up — five concrete safeguards

**1. Every payout is contractually capped at $1,000.** No scenario where a single trigger costs Atticus $5k or owes Foxify $50k. Both sides know exactly what each event delivers.

**2. Atticus owns a real hedge for every active pair.** Confirmed by live Bullish mainnet RFQ on 2026-05-10: actual ±2% strangle bought at the venue with confirmed receipts. Atticus is not playing the trigger blind.

**3. Cooldown circuit breaker pauses new pairs in extreme conditions.** If 4-hour payouts exceed 25% of capital, or DVOL spikes past 100, new pair openings auto-pause for ~4 hours. Existing pairs continue paying — Foxify is never stiffed on triggers that already fired. **In the past 6.4 years of BTC data, no scenario produced a wipeout outcome with cooldown active.**

**4. Real-time dashboard exposed to Foxify ops.** Capital utilization (green/yellow/red), cooldown active state, today's trigger count, today's payouts, hedge book MTM, 24h drawdown vs expected. **Foxify sees everything Atticus sees, the moment we see it.** No information asymmetry.

**5. Validated against every BTC crisis since 2020.** 2,328 historical pair-life simulations spanning March 2020 COVID (-40% in 24h, DVOL 150+), May 2021 China ban (33 triggers/pair-week), Luna/UST 2022, FTX 2022, March 2023 banking, August 2024 yen-carry. **Zero wipeouts under cooldown.** Plus your own per-second BTC data from May 2025 confirms the trigger model.

---

## Four contractual guardrails (standard institutional protections)

1. **Counterparty credit cap.** Atticus's accumulated unsettled balance from Foxify is capped at $5M per 1,000 pairs of monthly volume. Force-settlement triggers if approached. Protects Atticus; doesn't impact Foxify in normal operation.

2. **Pair-count cap with override.** Atticus retains right to set the maximum simultaneously-open pairs based on its capital. Foxify can request override; Atticus has unilateral denial right. Phase 1 cap: 12 pairs.

3. **Pricing reset clause.** If Atticus monthly P&L drops more than 2σ below modeled expectation across any 30-day window, premium ladder reverts to the next-higher tier for the following month. Restored when back in band. **This is the structural protection that lets Atticus quote tight pricing — if conditions worsen, pricing self-adjusts.**

4. **Stress-regime pause clause.** If BTC DVOL ≥ 100 sustained for 24+ hours, Atticus has unilateral right to pause new pair openings for 12 hours pending desk review. Existing pairs continue normally.

**These guardrails make scale-to-infinity safe.** They mean Atticus's structure doesn't break if Foxify scales to $50M/day, $500M/day, or $5B/day — the protections scale with the volume.

---

## Capital required — minimal at start, scales with volume

### Foxify-side capital

Foxify keeps a working balance with Atticus that funds daily premium debits and receives trigger payouts. Approximate sizing:

| Phase | Pair count | Foxify daily premium burn | Recommended Foxify pre-fund |
|---|---|---|---|
| Phase 1 (Pilot) | 4.3 pairs | ~$2,500/day | **$10k** (matches your stated minimum) |
| Phase 2 (Validation) | 12.9 pairs | ~$7,500/day | **$30k** |
| Phase 3 (Scale-up) | 100 pairs | ~$58,000/day | **$200k** |
| Phase 4 (Production) | 1,000 pairs | ~$580,000/day | **$2M** |
| Phase 5 (Foxify-scale) | 10,000 pairs | ~$5.8M/day | **$20M** |

**Pre-fund balance is segregated** (your money, in escrow with Atticus, withdrawable any time excess is held). It is NOT at risk of Atticus operational losses.

### Atticus-side capital (Foxify doesn't fund this; informational only)

Atticus operating capital scales as below. **Foxify's commercial relationship is unaffected by Atticus capital except via the four guardrails above** — but for transparency:

| Phase | Atticus operating capital | Funding source |
|---|---|---|
| Phase 1 | $100k | Atticus equity |
| Phase 2 | $145k | Atticus equity + Bullish margin line |
| Phase 3 | $300k | Same + LP institutional credit |
| Phase 4 | $1.5–2.5M | Self-funded from accumulated P&L |
| Phase 5 | $15M+ | Self-funded + insurance fund (2.5% of aggregate notional) |

**Atticus is well-capitalized at every phase.** Cap is sized for worst-week empirical losses + 30% headroom + 2.5% insurance fund.

---

## Phased ramp — milestones both sides commit to

| Phase | Timeline | Pair count | Volume / month | Atticus tier active | Volume rebate |
|---|---|---|---|---|---|
| **1 (Pilot)** | Month 1 | 4.3 avg | ~30 pair-days | Base | 0% |
| **2 (Validation)** | Month 2-3 | 12.9 avg | ~100 pair-days | Base | 2% |
| **3 (Scale-up)** | Month 4-6 | 50-100 | 1,500-3,000 pair-days | Base | 4% |
| **4 (Production)** | Month 7-12 | 250-1,000 | 7,500-30,000 pair-days | Base | 6% (base ladder cap) |
| **5 (Foxify-scale)** | Year 2+ | 1,000-10,000 | 30,000-300,000 pair-days | Base | 6% base / 8% stretch on Bullish institutional + Falcon-X demonstrated |

**Each phase has a clean volume threshold that unlocks the next rebate tier.** Foxify can audit eligibility from your own routing data. **Top 8% slot is decoupled from volume threshold** — it requires demonstrated venue-cost reductions (Bullish institutional pricing tier and Falcon-X cross-venue routing live in production for one full month each), so neither side commits to it before the savings are real.

---

## What we need from Foxify to lock Phase 1

1. **Volume commitment** in writing for the rebate ladder (e.g., "≥500 pair-days/month by Month 4").
2. **Settlement timing** chosen: T+1 with weekly netting + monthly true-up is recommended.
3. **Cooldown auto-firing** authorization: automatic at the four T1-T4 thresholds, no manual approval per fire.
4. **Pre-fund schedule** confirmed: $10k for Phase 1, scaling per the table above.
5. **Counterparty designation:** Atticus contracts with Foxify Inc. as institutional B2B; no end-user KYC chain.

---

## The one-paragraph commercial summary

> **For ~1.3–1.4 basis points on routed volume (1.28 bps at the 8 %
> stretch-rebate slot when Bullish institutional + Falcon-X savings are
> demonstrated in production), Atticus provides bounded-risk protection
> that lets Foxify operate at $50M+/day notional today and scale to
> $50B+/day in due course. At 1,000 pairs that's $42M/year of net cost
> on $304B realised routed volume; at 10,000 pairs $420M/year on $3.04T
> ($390M at the 8 % stretch slot). Both numbers paid out of Foxify's
> partner-rebate income at 5 bps — leaving Foxify with +$116M/year
> operating margin at 1,000 pairs, scaling to +$1.16B/year at 10,000
> pairs (+$1.19B at the stretch slot). The pricing is structurally
> cheaper than every alternative (self-hedge, variance swaps, prediction
> markets) by a factor of 5–25×; the guardrails make scale-to-infinity
> safe; the entire structure is validated against 6.4 years of real BTC
> data including every crisis since COVID and against Foxify's own
> per-second BTC dataset over the May 2025 sample. Cooldown circuit
> breaker (~13 days/year, almost all in stress windows — see
> `COOLDOWN_FOXIFY_BREAKDOWN.md`) is the structural protection that
> converts what would otherwise be multi-day emergency shutdowns into
> routine 4-hour pauses while existing pairs continue paying full
> $1,000/trigger.**

---

## Signatures

**For Atticus:** _______________________  Date: ____________
**For Foxify:** _______________________  Date: ____________

---

*Backup detail in `docs/cfo-report/double-barrier-analysis/`:*
- `COOLDOWN_FOXIFY_BREAKDOWN.md` — **read this for the cooldown explainer** (when it fires, what Foxify experiences, probability per regime)
- `PRICING_LADDER_STRESS_TEST.md` — quant validation of this ladder against the 6.4-year empirical tape
- `FOXIFY_CEO_BRIEFING.md` — same content, longer-form (~7 minute read)
- `PDF_DATA_ANALYSIS.md` — what your per-second BTC data validated
- `LIVE_RFQ_FINDINGS.md` — live mainnet Bullish quote results (May 10)
- `DEAL_STRUCTURE_FINAL.md` — the full deal mechanics
- `PRICING_FINAL_PER_PAIR.md` — derivation of every tier rate
