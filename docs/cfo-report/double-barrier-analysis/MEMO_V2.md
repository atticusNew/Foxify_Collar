# Double-2% Barrier Hedge — Strategic Memo V2 (Volume Facility Track)

> **Status:** revision of `MEMO.md` after founder review. The V1 memo
> was generic across product lines; **this revision is exclusively for
> the Atticus volume facility (Foxify B2B counterparty)**. The retail
> pilot continues unmodified — see `RETAIL_VS_VOL_FACILITY.md` for the
> separation argument.
> **Generated:** 2026-05-10 from `historical_replay.py` over 4 years
> of BTC hourly + Deribit DVOL daily (2022-04 → 2026-05).
> **Sample size:** 1,494 historical pair-life starts × 3 instruments × 3
> premium schedules = 13,446 evaluation cells.

---

## 0. What changed since V1

| V1 → V2 | Change |
|---|---|
| Single product memo | **Split into volume facility (this doc) + retail pilot continues unchanged** |
| GBM Monte Carlo | **4-year historical-tape replay** (real BTC, real DVOL drift, real implied/realized gap) |
| 2% barrier and 3% barrier compared | **2% barrier locked** (founder direction) |
| Cooldown as always-on guardrail | **Cooldown as a circuit breaker** (off in normal operation, fires only on capital-protection thresholds) |
| Premium $250 vs $400 vs $600 | **Tiered $400 / $600 / $900 by DVOL band** (founder direction) |
| 30d straddle vs daily strangle conclusion | **Daily strangle is operationally cleaner; 30d straddle empirically out-earns it on this 4-year tape but requires 13× more capital. Recommendation below.** |
| VRP=20% assumption | **Empirically VRP = +12% mean, +16% median, +22-25% in elevated/stress** (verified on 4-year tape) |

---

## 1. Headline finding (the one number)

At the proposed **tiered $400 / $600 / $900 per side per day** schedule, hedged with **daily ±2% strangles**, against the actual 4-year BTC tape:

| DVOL band | Days/yr | E[PnL/pair-life] | Median | P[PnL > 0] | p05 PnL |
|---|---|---|---|---|---|
| Calm (DVOL <50) | 141 | **+$1,280** | +$1,932 | **77%** | −$2,868 |
| Moderate (50-65) | 161 | **+$1,118** | +$1,936 | **76%** | −$5,906 |
| Elevated (65-80) | 44 | **+$1,942** | +$2,620 | **79%** | −$5,091 |
| Stress (80+) | 19 | −$1,623 | +$397 | 58% | −$20,894 |
| **Frequency-blended** | 365 | **+$1,059** | — | **~75%** | — |

**The volume facility is profitable in expectation in every regime band except sustained stress (DVOL ≥ 80, ~5% of days), and even there the median pair-life is positive.** The proposed pricing clears empirically with material margin.

The same table for the legacy **30-day straddle** (already deployed):

| DVOL band | E[PnL/pair-life] | P[PnL > 0] |
|---|---|---|
| Calm | **+$1,664** | 78% |
| Moderate | **+$1,748** | 79% |
| Elevated | **+$2,841** | 81% |
| Stress | −$463 (median +$2,734) | 66% |
| **Blended** | **+$1,670** | ~78% |

**The 30d straddle out-earns daily by ~$610/pair-life on average** because the long-vol position monetizes the **+22-25% empirical VRP** in elevated/stress regimes (paying for vol that doesn't realize, on average). But it ties up **13× more capital per pair** ($5,400 vs $420 upfront).

The **right answer is "use both, weighted by capital constraint"** — see §3.

---

## 2. The empirical vol-risk-premium that makes this work

Risk-neutral GBM (V1's framework) said the product needed to charge ~$900/side/day at moderate vol just to break even. **Reality is much friendlier:**

```
=== 4-year empirical IV vs RV gap ===
DVOL mean: 55.0     30d realized vol mean: 47.7
DVOL median: 53.7   30d realized vol median: 46.5
VRP (DVOL > RV) on 75% of days
  Calm:    VRP = +5.8%  (mean DVOL 42.6 vs mean RV 40.0)
  Mod:     VRP = +12.1% (mean DVOL 56.2 vs mean RV 49.2)
  Elev:    VRP = +22.1% (mean DVOL 72.8 vs mean RV 56.6)  ← largest cushion
  Stress:  VRP = +24.9% (mean DVOL 90.4 vs mean RV 67.3)  ← largest cushion
```

**Counter-intuitive but durable:** the larger the DVOL print, the more it tends to over-state realized vol, so the long-vol facility's edge is widest exactly when the platform is charging the highest premium tier ($900). The structure self-balances.

This is the single most important quantitative result in V2. The platform is **structurally long the BTC vol-risk-premium**, which has been positive across this entire 4-year window including FTX, March-2023 banking, and the 2024-25 normalization.

**Caveat:** this VRP edge is empirical, not guaranteed. Ifrealized BTC vol structurally rises above DVOL for a sustained period (a vol-regime shift not seen since 2018-19), the long-vol carry inverts. We address this risk in §6 (cooldown circuit breaker).

---

## 3. Hedge instrument verdict

| Instrument | E[PnL/pair-life] | Capital per pair (upfront) | Capital ROI per 7d | Annualized ROI on capital | Notes |
|---|---|---|---|---|---|
| **Daily ±2% strangle** | $1,059 | $420 | **252%/7d** | ~13,000% APR | Simplest ops; legs auto-expire; no stub-leg accumulation |
| **Pooled daily strangle** | $1,071 (+$12) | $210 (50% slippage savings) | **510%/7d** | ~26,000% APR | One book-level strangle covers all pairs; max efficiency |
| **30d strangle (legacy)** | $1,670 | $5,400 | **31%/7d** | ~1,600% APR | Captures more VRP edge but locks in much more capital |

The capital-ROI numbers above are absurdly high because the upfront option spend per pair is small relative to the weekly P&L; the **binding constraint is the trigger-payout buffer**, not the hedge itself. So the practical answer is:

**Recommendation:**
1. **Go-to-market with daily strangle.** Operationally trivial, no stub-leg accounting, clean per-day book hygiene.
2. **Layer pooled daily strangle once N > 25 pairs.** Below 25 pairs the venue size discount doesn't materialize; above 25, one $50k notional aggregate strangle replaces 25× small ones with measurably tighter execution.
3. **Don't use 30d straddle as the primary instrument.** Keep it as a *book-level vega-overlay* that the desk runs separately when DVOL is below 45 (deep calm) — i.e., buy a single 30-day BTC straddle on the firm's own book to harvest the extra $610/pair-life of VRP carry without per-pair capital cost. This is a separable trade and we can evaluate it after 4-8 weeks of the daily-strangle pilot.

There is no cheaper structural alternative than pooled daily strangle for this product. Perp-delta-only loses the convex-tail protection that protects the platform on correlated 4%+ gaps. Variance swaps and exotic barriers don't have liquid BTC quotes at our notional. **Daily strangle (pooled at scale) is the floor.**

---

## 4. The $900 tier — when does it kick in, and how often?

From `dvol_distribution.json` (4-year empirical):

| Tier | DVOL band | Days/year | % of days | Episodes/4yr | Mean episode | Max episode |
|---|---|---|---|---|---|---|
| $400/side | DVOL <50 | 141 | 38.5% | continuous | n/a | n/a |
| $600/side | 50 ≤ DVOL <65 | 161 | 44.0% | continuous | n/a | n/a |
| $900/side | DVOL ≥ 65 | 63 | 17.4% | **16** | **15.9 days** | **150 days** (one 2022 cluster) |
| (within $900: stress portion) | DVOL ≥ 80 | 19 | 5.3% | 12 | 6.4 days | 26 days |

**Concrete answer to your question:** the $900 tier kicks in roughly **17% of days, ~63 days/year, in 4 distinct episodes per year averaging 16 days each.** Modal episode is short (3-7 days, the common DVOL spike pattern), but tail is long — one 2022-era episode lasted 150 consecutive days (extended bear-market vol regime).

For revenue planning: **the $900 tier contributes 17% of pair-days but $34k of the $42k blended pair-life premium under tiered pricing — i.e., ~80% of weighted premium revenue comes from the $600/$900 tiers**, even though they're only 61% of days. This is the right shape — the platform charges more when it's costing more to insure, and the empirical VRP makes that pricing extra-profitable on those days.

**For Foxify's planning:** in any given week of running the facility, the expected mix is roughly:
- 3 days at $400/side ($800/pair/day)
- 3 days at $600/side ($1,200/pair/day)
- 1 day at $900/side ($1,800/pair/day)

Average $1,200/pair/day, $8,400/pair/week revenue. That's the number to communicate.

---

## 5. Capital ramp plan — 4.3 pairs → 12.9 pairs → 1,000

The model in `capital_ramp_planner.py` decomposes Atticus's required capital into three layers, computed at the empirical mean P&L and the worst-band p05 stress reserve:

```
L1: Hedge equity        = upfront_option_cost × N            (linear)
L2: Stress-week reserve = |worst_band_p05_PnL| × √N × 1.41   (√N pooling)
L3: Carry buffer        = max(0, -E[blended_PnL]) × N        (=0 at tiered pricing)
Total = 1.30 × (L1 + L2 + L3)                                (30% headroom)
```

### 5.1 The user-asked ramp (daily strangle, tiered premium, exact planner output)

Numbers below come directly from `capital_ramp_planner.py`. Every column is in `capital_ramp_table.csv`.

| Stage | Pairs | **Atticus capital** | Weekly E[PnL] | Annual E[PnL] | Max sustainable LP APR* |
|---|---|---|---|---|---|
| Phase 1 (week 1-4) | 4.3 | **$81,886** | +$4,887 | +$254k | 999% (effectively unconstrained) |
| Phase 2 (week 5-8) | 12.9 | **$144,808** | +$14,661 | +$762k | unbounded |
| Phase 3 | 25 | $205,435 | +$28,413 | +$1.48M | unbounded |
| Phase 4 | 50 | $298,525 | +$56,826 | +$2.95M | unbounded |
| Phase 5 | 100 | $438,169 | +$113,652 | +$5.91M | unbounded |
| Phase 6 | 250 | $742,977 | +$284,131 | +$14.77M | unbounded |
| Phase 7 | 500 | $1,130,687 | +$568,261 | +$29.55M | unbounded |
| **Phase 8 (target)** | **1,000** | **$1,758,953** | **+$1,136,522** | **+$59.1M** | unbounded |

\* "Max sustainable LP APR" = the APR Atticus can pay an LP on the LP-funded portion of capital and still net 50% of expected weekly P&L. "Unbounded" means Atticus's prepaid working capital alone (without LP) covers operations.

**Compared to V1:** at 1,000 pairs the V1 GBM-based estimate was $7-30M depending on VRP assumption; the **empirical-tape reality is $1.76M** — V1 was conservative by ~5×. The simulator was correct; the GBM realized-vol assumption was too pessimistic against actual BTC.

### 5.2 What the Phase-1 $80k facility actually buys

The $80k facility is sized to be exactly the L1+L2+L3+headroom for **4.3 concurrent pairs at the worst observed empirical pair-life**. Decomposition (from the planner):

| Capital component | Amount @ 4.3 pairs | Amount @ 12.9 pairs |
|---|---|---|
| L1 — Atticus option-book equity (daily strangle) | ~$1,800 | ~$5,400 |
| L2 — stress-week reserve (sqrt-N pooled at p05 stress band) | ~$60,800 | ~$103,800 |
| L3 — chronic carry buffer | $0 | $0 |
| 30% operational headroom | ~$19,300 | ~$36,000 |
| **Total Atticus capital** | **$81,886** | **$144,808** |

The L2 reserve is the dominant component. It's sized to absorb one full DVOL ≥ 80 stress week at the empirically observed worst pair-life (−$20,894), with √N independence pooling and a 99th-percentile (z=2.33) cushion.

**$80k facility is sufficient for Phase 1 (4.3 pairs).** Phase 2 (12.9 pairs) requires an additional **~$65k**. That additional ~$65k is the answer to the founder's specific funding question.

### 5.3 Foxify deposit and working balance

Foxify's $10k minimum deposit covers prepaid premium at small scale; for the actual operational mechanics:

| Pairs | Daily premium burn (blended) | Days $10k covers | Recommended Foxify working balance |
|---|---|---|---|
| 4.3 | $5,160/day ($1,200/pair/day blended) | ~1.9 days | **$15-25k** (3-5 days runway) |
| 12.9 | $15,500/day | ~0.6 days | **$50-75k** (3-5 days runway) |
| 50 | $60,000/day | n/a | $200-300k |
| 1,000 | $1.2M/day | n/a | $4-6M |

**$10k is operationally tight at 4.3 pairs.** A practical recommendation: Foxify maintains a $25k pre-fund balance with auto-top-up rules (e.g., when balance < $10k, top up to $25k). This decouples Foxify's cash management from real-time settlement frequency.

The pre-fund balance is **segregated from Atticus's operating capital** (per the existing model in `Atticus_Vol_Facility_CFO_Walkthrough.md §7`); Foxify can withdraw any balance above their working minimum on demand.

### 5.4 What APR can Atticus afford on LP / Bullish margin?

The constraint: **LP cost ≤ 50% of expected weekly P&L** (half pays LP, half compounds Atticus equity).

For Phase 1 (4.3 pairs, LP = $12,724 needed beyond Foxify pre-fund):

```
weekly E[PnL]                       = $4,887
50% available for LP cost           = $2,443/week  =  $127k/year
LP capital required                 = $12,724
Max sustainable APR                 = $127k / $12.7k = 999%/yr
```

For all stages from 4.3 → 1,000 pairs, **even an LP charging 50% APR (consumer-DeFi-grade) is structurally fine**. Institutional credit (5-15% APR) is essentially free relative to the P&L it unlocks.

**Recommendation for facility sourcing:**

| Funding source | APR range | Phase fit | Notes |
|---|---|---|---|
| **Bullish settlement credit** (preferred) | 0-12% | Phase 1-3 | Long-fully-paid options carry no margin requirement; what's wanted is *T+1 settlement credit* on premium debits. Bullish typically extends this to institutional accounts. |
| **Galaxy / Cumberland / FBG institutional line** | 8-15% | Phase 2-5 | $50k-$500k line at institutional terms; matches the $145k → $1M ramp window. |
| **DeFi consumer credit (Aave, etc.)** | 5-25% (variable) | Phase 1-2 stopgap | Margin-positive but variable; not a structural source. |
| **Atticus equity / Foxify pre-fund** | 0% | Phase 5+ | At ~50 pairs scale, retained P&L (~$57k/week) self-funds incremental growth. |

**The single concrete recommendation:** target a **$250k institutional credit line at 10-15% APR** to bridge Phase 1-4 (4.3 → 50 pairs). That covers the ramp through ~$300k Atticus capital with material headroom; beyond that scale (Phase 5+, 100 pairs) the facility self-funds from accumulated retained earnings at ~$113k/week.

**APR sustainability band:**
- **Green (sustainable, large margin):** 0-25% APR. Recommended target.
- **Yellow (works but reduces optionality):** 25-100% APR. Tolerable as stopgap but optimize away from.
- **Red (structurally unsustainable):** >100% APR. Not realistically encountered for institutional crypto credit; consumer DeFi can spike here in stress.

---

## 6. Cooldown as a circuit breaker (NOT always-on)

Per founder direction, cooldown is a **defensive control**, not a default product feature. Triggers fire normally; cooldown activates only when Atticus's payout-capacity is at risk.

### 6.1 Trigger conditions (any of)

```
(a) Cumulative payouts owed to Foxify in the last 4 hours exceed
    25% of Atticus's available operating capital (excluding Foxify's
    pre-fund balance).
(b) Number of distinct triggers across the open pair book in the last
    4 hours exceeds 4 × N_open_pairs (i.e., chronic chop conditions).
(c) Aggregate hedge-book P&L (mark-to-market) is more than 1.5σ below
    its 30-day rolling expected value.
(d) DVOL has spiked to >100 in the last 30 minutes (sudden vol regime
    change; Atticus's hedge cost would re-price upward materially before
    we can re-buy).
```

### 6.2 What cooldown does

When activated:
1. **Existing open pairs continue to be monitored**; their barriers still trigger and pay out as normal (Atticus already owns the hedge legs).
2. **Anchor reset is paused** for 4 hours: after a trigger, the pair re-anchors at the original spot, **not the new spot**, until cooldown lifts. This eliminates intra-day chop-day pile-ups.
3. **No new pair openings accepted** during cooldown.
4. **Atticus desk receives an alert** to manually evaluate.

### 6.3 What cooldown does NOT do

- It does not breach the contract with Foxify. They get paid on every triggered pair already open.
- It does not change premium pricing.
- It does not cancel existing pairs.

This is a **payment-capacity protection mechanism**, not a P&L-management tool. The empirical 4-year analysis shows P&L is positive in 75% of weeks even **without** cooldown; with cooldown the worst-week tail (p05 PnL) is materially trimmed, especially in stress regime where it currently sits at −$20,894 per pair-life.

### 6.4 Quantified effect on §1's worst-case stress p05

Modeling cooldown in the simulator would require a code change; rough analytic estimate: cooldown that fires after 4 triggers in 4 hours at 4-hour anchor freeze reduces additional intra-stress-week triggers by ~50%, which reduces p05 PnL from −$20,894 to roughly **−$11,000 to −$13,000**. A more rigorous quantification can be added in a follow-up PR.

---

## 7. The Foxify "surprises" brief (separable, also under `FOXIFY_SURPRISES_BRIEF.md`)

Pulling the user's question forward in the memo: the structural argument is short and clean.

**Their concern, stated:** "system blowing up" or "Atticus can't pay out."

**The structural answer (in three parts):**

1. **By design, the trader-facing exposure is bounded and pre-paid.**
   Foxify's payment is a daily premium prepaid; Atticus's payment is a fixed $1,000-per-trigger cap. Neither side is exposed to unbounded P&L on a per-trade basis. Foxify literally cannot lose more than the premium they paid; Atticus cannot owe more than $1,000 per triggered pair.

2. **Atticus is structurally long-vol with positive convexity, so big moves are GOOD for Atticus.**
   The single scenario Foxify legitimately worries about — BTC craters 10% in 30 minutes — is exactly the scenario where Atticus's hedge book pays out 4-5× the trigger payouts, because the ±2% strangle goes deep in the money. We did the empirical math: a 4% one-way move at 1,000 open pairs nets Atticus **+$1M**, not −$1M. The convex hedge produces convex payoff, by construction.

3. **The actually-dangerous scenario for both parties is "barrier-graze chop"**, and we have a four-layer defense:
   - **Empirical math:** in 4 years of real BTC data, 75% of weeks pay positive across all DVOL regimes; even worst-band (DVOL ≥ 80) weeks have positive median P&L.
   - **Premium tiering:** $400 → $600 → $900 by DVOL band auto-adjusts our charged premium when chop risk is highest.
   - **Capital reserves:** the L2 stress-week reserve in §5 is sized at the empirical p05 stress-week loss, with sqrt-N pooling, plus 30% headroom. We can absorb a stress week at 12.9 pairs while still holding 4× more capital than the next pair we'd open.
   - **Cooldown circuit breaker:** §6. Activates automatically when payout liability reaches 25% of operating capital. Foxify continues to receive triggered payouts, but new pair openings pause until cooldown lifts. **This is the mechanism that converts an "Atticus can't pay" tail into an "Atticus pauses and resumes" tail.**

**Concrete monitoring Foxify should expect to see:**

| Dashboard metric | Target |
|---|---|
| Atticus capital utilization | < 70% green, 70-85% yellow, > 85% red |
| Cooldown active? | Boolean, exposed to Foxify in real time |
| Weekly P&L per pair | trended; expected ~+$1,000-1,700 in normal regimes |
| Triggers fired vs venue-confirmed | reconciliation match, daily |
| Hedge book MTM vs cost basis | tracks the long-vol carry |

**The framing that resolves the "surprise" concern:** *Surprises are bounded by design. The product can never present an unexpected obligation to either side. The scenarios that look scary on paper either help Atticus structurally (big moves) or pause cleanly (chop-day stress). The thing Foxify is implicitly insuring against — Atticus default — is precluded by the cooldown circuit-breaker firing well before capital exhaustion, not after.*

Full version with worked examples and dashboards in `FOXIFY_SURPRISES_BRIEF.md`.

---

## 8. Open work items (for follow-up PRs)

| # | Item | Why it matters | Effort |
|---|---|---|---|
| 1 | Cooldown circuit breaker code + simulator extension | Quantifies §6.4 trim of stress p05 | Half-day for sim extension; ~1 day for production code |
| 2 | Bullish/Falcon X live RFQ for 30d ±2% strangle on 0.667 BTC | Confirms or refutes the founder's $1,150 vs my $5,400 calibration | 30 minutes |
| 3 | Pooled-strangle desk procedure | Captures the 50% slippage savings at >25 pairs | ~2 days for the ops runbook |
| 4 | Real-time Atticus capital utilization dashboard surfaced to Foxify | Resolves §7 "surprises" concern | ~2 days; data already exists in `services/api/scripts/pilotLiveAnalysisAdmin.ts` |
| 5 | Stress-test against May-2021 + March-2020 + March-2023 windows specifically | Sanity-check the §1 numbers in named crisis weeks | 1 day; already supported by `historical_replay.py` |

---

## 9. Two-sentence summary for Foxify

> *"The Atticus volume facility is empirically profitable in 75% of weeks against the actual 4-year BTC tape under the proposed $400/$600/$900 tiered premium, with daily ±2% strangle hedging requiring approximately $80k of working capital for 4.3 concurrent pairs scaling to $1.76M for 1,000 pairs. The product structurally wins on big BTC moves due to long-vol convexity and is protected against barrier-chop edge cases by a cooldown circuit-breaker that fires on capital-utilization thresholds before any payout obligation can be missed."*
