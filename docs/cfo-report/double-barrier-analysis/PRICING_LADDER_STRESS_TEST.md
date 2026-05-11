# Pricing Ladder Stress-Test — `$490 / $605 / $795 / $865`

> **Purpose.** Independent quant check on the user-locked ladder
> ($490 calm / $605 mod / $795 elev / $865 stress) against the
> empirical anchors in `historical_replay.py` outputs and the live
> Bullish RFQ from 2026-05-10. Verifies whether the ladder is the
> **lowest sustainable** price for Atticus across all four DVOL
> regimes, with and without cooldown reductions, before and after
> the volume-rebate ladder.
>
> **Headline.** The ladder is **at the structural edge** of
> sustainability. It is profitable for Atticus **only with cooldown
> actively clipping ~20/30/50% of triggers in mod/elev/stress** and
> **only at full volume rebate (8%)** if Bullish institutional
> pricing materialises on schedule. With both holding, blended
> Atticus margin is ~5.6% on premium, blended cost to Foxify is
> ~1.1 bps on routed volume — still cheapest of every alternative
> by 4–25×, but with **two presentation gaps in the existing CEO
> docs** that should be closed before sign-off.

---

## 1. Inputs (anchors held constant; not re-derived)

```text
mult_pair        = {calm: 8.59,  mod: 9.84,  elev: 10.625, stress: 10.39}
payouts/pair-life= {calm: 3,800, mod: 6,195, elev: 9,104,  stress: 12,139}
hedge/pair-life  = {calm: 200,   mod: 500,   elev: 1,200,  stress: 2,200}    # before cooldown
breakeven $/day  = {calm: 466,   mod: 681,   elev: 970,    stress: 1,380}    # before cooldown
regime weights   = {calm: 0.354, mod: 0.428, elev: 0.144,  stress: 0.058}    # balanced median
days/year        = {calm: 129,   mod: 156,   elev: 52,     stress: 21}
trigger rate /wk = {calm: 3.8,   mod: 6.2,   elev: 9.1,    stress: 12.1}     # per pair
proposed cooldown = {calm: 0%,   mod: 20%,   elev: 30%,    stress: 50%}      # trigger reduction
proposed rebate top tier = 8% on Mod/Elev/Stress; 0% on Calm
```

Per-pair-life P&L formula (Atticus):

```text
PnL = rate × mult − payouts − hedge
```

With cooldown reduction `r`, both `payouts` and `hedge` scale by `(1 − r)`; `mult` is approximately unchanged (premium is daily, not per-trigger).

---

## 2. Atticus per-pair-life P&L at the proposed ladder

### 2.1 NO cooldown (worst case)

| Band | Rate | Floor | Δ vs floor | Premium / p-life | Payouts | Hedge | **P&L / p-life** |
|---|---:|---:|---:|---:|---:|---:|---:|
| Calm   | $490 | $466 | **+$24**   | $4,209 | $3,800 | $200 | **+$209** |
| Mod    | $605 | $681 | **−$76**   | $5,953 | $6,195 | $500 | **−$742** |
| Elev   | $795 | $970 | **−$175**  | $8,447 | $9,104 | $1,200 | **−$1,857** |
| Stress | $865 | $1,380 | **−$515** | $8,987 | $12,139 | $2,200 | **−$5,352** |

**Blended (35.4 / 42.8 / 14.4 / 5.8):** `−$821 / pair-life`.

At ~49 pair-lives/year/slot × 1,000 pairs ≈ **−$40 M/year Atticus loss**. Three of four tiers are **below** their no-cooldown breakeven floors. **Without cooldown the ladder cannot stand.**

### 2.2 WITH cooldown (20% mod / 30% elev / 50% stress)

| Band | Rate | Cooldown floor | Margin vs cd-floor | **P&L / p-life** |
|---|---:|---:|---:|---:|
| Calm   | $490 | $466 | +5.2% | **+$209** |
| Mod    | $605 | $544 | +11.2% | **+$597** |
| Elev   | $795 | $679 | +17.1% | **+$1,234** |
| Stress | $865 | $690 | +25.4% | **+$1,817** |

**Blended:** `+$613 / p-life`. At 1,000 pairs ≈ **+$30 M/yr** (no rebate yet).

### 2.3 WITH cooldown AND 8% volume rebate on Mod/Elev/Stress

Effective rates: **$490 / $557 / $731 / $796**.

| Band | Rate (rebated) | **P&L / p-life (cd + rebate)** | Atticus margin on premium |
|---|---:|---:|---:|
| Calm   | $490 | +$209 | 5.0% |
| Mod    | $557 | **+$125** | **2.3%** ← binding constraint |
| Elev   | $731 | +$554 | 7.1% |
| Stress | $796 | +$1,100 | 13.3% |

**Blended Atticus = +$272 / p-life ≈ +$13 M/yr at 1,000 pairs (≈ +$133 M/yr at 10,000 pairs). Blended margin-on-premium ≈ 5.6 %.**

The Mod tier compresses to **2.3 % margin** at full rebate. That is the structural fragility.

---

## 3. Foxify net cost — TWO views and a major doc inconsistency

Foxify will plausibly compute their net cost two different ways. Both must reconcile or the deal generates a month-1 dispute.

### 3.1 "Headline" view (no cooldown clip on payouts) — what Foxify sees first

| Band | Premium (rebated, 8%) | Payouts (full trig rate) | Foxify net cost / p-life |
|---|---:|---:|---:|
| Calm   | $4,209 | $3,800 | +$409 |
| Mod    | $5,481 | $6,195 | **−$714** (Foxify nets +) |
| Elev   | $7,767 | $9,104 | **−$1,337** (Foxify nets +) |
| Stress | $8,270 | $12,139 | **−$3,869** (Foxify nets +) |

Blended: **−$483 / pair-life Foxify NET REVENUE** (≈ +$24 M at 1,000 pairs).

This view is **structurally impossible while Atticus is profitable** — but it is the view Foxify computes if they multiply `2.16 trig/day × $1,000` and subtract published premium. **The CEO_ONE_SHEET / FOXIFY_CEO_BRIEFING reinforce this expectation by quoting net cost numbers consistent with this view (0.61–1.13 bps).** That mismatch is the single biggest commercial risk before signature.

### 3.2 "Realised" view — cooldown actually clips payouts (20/30/50%)

| Band | Premium (rebated) | Payouts (after cd) | Foxify net cost / p-life |
|---|---:|---:|---:|
| Calm   | $4,209 | $3,800 | +$409 |
| Mod    | $5,481 | $4,956 | +$525 |
| Elev   | $7,767 | $6,373 | +$1,394 |
| Stress | $8,270 | $6,070 | +$2,200 |

Blended Foxify cost = **+$700 / pair-life ≈ +$34 k/pair/yr ≈ $34 M at 1,000 pairs (≈ $340 M at 10,000 pairs)**.

### 3.3 The doc inconsistency, quantified

| Source | Foxify net cost @ 1,000 pairs | Foxify net cost @ 10,000 pairs | Cost on volume |
|---|---:|---:|---:|
| `CEO_ONE_SHEET.md` (signed-version) | **$23.3 M** | **$192 M** | 0.74 / 0.61 bps |
| Per-pair-life math at this ladder, cd + 8% rebate | **$34 M** | **$340 M** | ~1.08 bps |
| Per-pair-life math at this ladder, no cooldown clip | **+$24 M (Foxify NET +)** | **+$240 M (NET +)** | impossible |

The **CEO_ONE_SHEET understates Foxify's realised cost by ~1.5×** vs the realised view. It is also internally inconsistent with `FOXIFY_PROFITABILITY_REALITY.md §4.2`, which gives **$42.6 M @ 1,000 pairs / $426 M @ 10,000** — closer to the per-pair-life math but still using older 30/36/14/19 regime weights.

**Action:** reconcile to a single Foxify-net-cost table before printing for sign-off. Recommended canonical numbers (balanced 35/43/14/6 weights, cd + 8% rebate, realised view): **$34 M @ 1,000 pairs / $340 M @ 10,000 pairs / 1.05–1.10 bps blended cost on volume**.

---

## 4. Sustainability verdict on the proposed ladder

**Yes, but only under three conditions, all of which need to be made explicit before sign-off:**

1. **Cooldown must actually fire and clip ~20/30/50% of mod/elev/stress triggers.** Without it, Atticus loses ~$40 M/yr at 1,000 pairs and the ladder is below floor in 3 of 4 bands.
2. **Foxify must understand that cooldown reduces THEIR payout count too.** If they price the deal off `2.16 × $1k = $2,160/pair/day` headline payout expectation, cooldown is a one-sided clip on their revenue. The CEO docs do not call this out clearly today.
3. **Volume rebate must be capped at venue-cost realisation.** The 8 % top tier compresses Mod margin to 2.3 %; any cost-savings shortfall (Bullish institutional tier delays, Falcon X integration slips, pooled-book efficiency below 30 %) puts Mod underwater inside the 2σ pricing-reset clause window.

**Margin headroom is thin:** blended ~5.6 % Atticus margin on premium with full rebate + cooldown. Calm (35 % of days, $490 at floor) has 5 % margin and **no rebate buffer to give back**. A 20 % cost overrun on the calm-tier hedge anchor ($200 → $240 per pair-life) compresses calm margin to 3 % and blended to ~4.5 %. That is below the 2σ pricing-reset threshold in some months.

---

## 5. Hardening moves that keep the "lowest sustainable" narrative

Three small structural moves harden the ladder without breaking the headline "$490 calm" anchor Foxify has been shown:

| Change | Why | Cost to Foxify | Atticus impact |
|---|---|---|---|
| **Hold Calm = $490** | At floor; defines the "lowest possible price" narrative | none | accepted (5% margin) |
| **Raise Mod $605 → $625** | Restores 8% margin pre-rebate, ~5% post-rebate; survives even if cooldown clips only 10% | +$20/pair/day in mod (~$1.4k/pair/yr added) | +$200/p-life in mod, removes single biggest fragility |
| **Cap top rebate at 6 %** (or tier 8% to "demonstrated Bullish institutional savings") | Decouples rebate from a future Bullish tier we don't fully control; pricing-reset clause becomes redundant | Foxify still gets 4–6% rebate immediately, 8% on proof | removes ~$15M/yr of rebate liability if savings underdeliver |
| **Make cooldown effect on payouts contractually explicit** | Foxify can't argue surprise; eliminates bait-and-switch risk; closes month-1 dispute window | none in $; transparency cost only | reputational protection |
| **Add Atticus excess-profit rebate above $30M/yr (15–25% share)** | Gives Foxify a "we win when you win" line if CEO needs a profit narrative | only triggers when Atticus is well into the money | aligned, costs nothing in base case |

### Net effect of "hold Calm + raise Mod $20 + cap rebate at 6%"

| Metric | Original ladder | Hardened ladder | Δ |
|---|---:|---:|---:|
| Atticus blended margin on premium | 5.6 % | **8.1 %** | +2.5 pp |
| Atticus annual @ 1,000 pairs | $13 M | **$19 M** | +$6 M |
| Foxify cost @ 1,000 pairs | $34 M | **$36 M** | +$2 M |
| Foxify cost on volume (bps) | 1.08 | **1.14** | +0.06 bp |
| Mod-tier margin (binding) | 2.3 % | **6.7 %** | +4.4 pp |

**Foxify pays ~6 % more, Atticus's binding-constraint margin nearly triples.** Foxify is still 4–25× cheaper than every alternative in the comparison table, still under 1.2 bps on routed volume.

### If founder direction is "absolutely no Calm/Mod increases — keep the headline ladder as printed"

Then the explicit move is two contractual edits, not pricing edits:

1. **Lock cooldown clip levels in writing.** The deal stops being viable without them; they need to be a contractual element, not a discretionary risk control.
2. **Publish the Foxify-net-cost table at the cooldown-realised payout level.** Replace the current $192 M @ 10k figure with the realised $340 M, framed as "before scale-driven cost-on-volume reductions of 0.4–0.5 bps." Prevents month-1 reconciliation dispute.

---

## 6. Where the docs need a sync edit before CEO sign-off

| Doc | Issue | Fix |
|---|---|---|
| `CEO_ONE_SHEET.md` | Foxify net cost tables understate realised cost ~1.5×; do not flag cooldown clip on Foxify payouts | Reconcile to canonical $34 M @ 1k / $340 M @ 10k; add one-line on cooldown reducing trigger count proportionally |
| `FOXIFY_CEO_BRIEFING.md` §4 | Same understatement; uses unstated regime weights | Replace with balanced-median table; add explicit "cooldown reduces your payouts" sentence to §5.3 |
| `FOXIFY_PROFITABILITY_REALITY.md` §4.2 | Uses old 30/36/14/19 weights; per-pair-life numbers approximately right | Update weights to balanced median 35/43/14/6 |
| `PRICING_FINAL_PER_PAIR.md` §1 | Per-pair breakeven floors here ($472/$693/$994/$1,426) differ slightly from user's anchors ($466/$681/$970/$1,380); origin is hedge_net rounding | Document source of difference; both sets are internally consistent within ±1.5% |

---

## 7. Bottom line — direct answer to "do these prices hold?"

> **Yes, conditionally.** `$490 / $605 / $795 / $865` is the lowest
> sustainable per-pair daily ladder Atticus can stand **provided
> cooldown actively clips 20/30/50% of mod/elev/stress triggers
> and the 8% top-tier rebate is funded by realised venue-cost
> reductions (pooled book + Bullish institutional + cross-venue
> routing).** Blended Atticus margin lands at ~5.6% on premium —
> thin but defensible. Net to Atticus at 1,000 pairs ≈ +$13 M/yr
> (≈ +$133 M/yr at 10,000 pairs).
>
> **Net to Foxify after rebate, with cooldown realised, at the
> balanced-median regime weights, is +$34 M/yr cost at 1,000 pairs
> (≈ +$340 M at 10,000 pairs), or ~1.05–1.10 bps on routed volume.**
> This is the right number to put in front of CEO, not the
> current $192 M / 0.61 bps figure in `CEO_ONE_SHEET.md` (which
> implicitly assumes no cooldown clip on Foxify payouts).
>
> **Strongly recommend** raising Mod from $605 to $625 (only $20/pair/day
> change, +6% Foxify cost, removes the single binding fragility) and
> capping the top rebate at 6% pending demonstrated Bullish
> institutional pricing. If those moves are politically off-limits,
> codify cooldown clip levels and the realised Foxify cost table in
> the contract so neither side is surprised in Month 1.
