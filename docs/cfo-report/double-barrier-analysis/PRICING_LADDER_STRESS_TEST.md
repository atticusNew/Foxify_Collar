# Pricing Ladder Stress-Test — `$490 / $625 / $795 / $865` (hardened)

> **Status.** Original draft tested the `$490 / $605 / $795 / $865`
> ladder; founder accepted the recommendation to raise Mod $605 → $625
> and cap the top rebate at 6 % base / 8 % stretch. **This doc has
> been updated to reflect the hardened ladder as the new baseline.**
> Original-ladder analysis is preserved in §2.x for reference.
>
> **Purpose.** Independent quant check on the locked ladder
> ($490 calm / **$625** mod / $795 elev / $865 stress) against the
> empirical anchors in `historical_replay.py` outputs and the live
> Bullish RFQ from 2026-05-10. Verifies the ladder is the **lowest
> sustainable** price for Atticus across all four DVOL regimes,
> with and without cooldown reductions, before and after the volume-rebate
> ladder. Companion read: **`COOLDOWN_FOXIFY_BREAKDOWN.md`** for the
> cooldown-firing-frequency-by-regime breakdown.
>
> **Headline (hardened ladder).** Mod $605 → $625 lifts the
> binding-constraint margin from 2.3 % to 7.4 % at full rebate,
> blended Atticus margin from 5.6 % → 7.1 %. Capping rebate at 6 %
> base (with the 8 % slot reserved for "demonstrated Bullish
> institutional + Falcon-X savings") removes ~$15M/yr of rebate
> liability if venue savings under-deliver. **Foxify pays $42M/yr
> at 1,000 pairs (1.38 bps on routed volume) instead of $34M
> (1.08 bps) — ~17 % more than the original ladder, still cheapest
> of every alternative by 4–25×, with the single biggest fragility
> removed.** Cooldown clip estimates retained from FOXIFY_PROFITABILITY
> (20/30/50 % design target); a conservative read of the spec
> thresholds (in `COOLDOWN_FOXIFY_BREAKDOWN.md`) suggests the
> spec as written delivers only ~1/4/12.5 % — so the ladder is
> **conditional on cooldown delivering its design clip**, which may
> require tightening the T1–T4 thresholds during implementation.

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

## 2. Atticus per-pair-life P&L at the hardened ladder ($490/$625/$795/$865)

### 2.1 NO cooldown (worst case)

| Band | Rate | Floor | Δ vs floor | Premium / p-life | Payouts | Hedge | **P&L / p-life** |
|---|---:|---:|---:|---:|---:|---:|---:|
| Calm   | $490 | $466 | **+$24**   | $4,209 | $3,800 | $200 | **+$209** |
| Mod    | $625 | $681 | **−$56**   | $6,150 | $6,195 | $500 | **−$545** |
| Elev   | $795 | $970 | **−$175**  | $8,447 | $9,104 | $1,200 | **−$1,857** |
| Stress | $865 | $1,380 | **−$515** | $8,987 | $12,139 | $2,200 | **−$5,352** |

**Blended (35.4 / 42.8 / 14.4 / 5.8):** `−$737 / pair-life` (vs −$821 on original ladder; +$84/p-life from Mod uplift).

At ~49 pair-lives/year/slot × 1,000 pairs ≈ **−$36 M/year Atticus loss**. Three of four tiers still below their no-cooldown breakeven floors. **Without cooldown the ladder still cannot stand** — confirming cooldown is structurally non-optional, not a discretionary risk control.

### 2.2 WITH cooldown design target (20 % mod / 30 % elev / 50 % stress)

| Band | Rate | Cooldown floor | Margin vs cd-floor | **P&L / p-life** |
|---|---:|---:|---:|---:|
| Calm   | $490 | $466 | +5.2% | **+$209** |
| Mod    | $625 | $544 | +14.9% | **+$794** |
| Elev   | $795 | $679 | +17.1% | **+$1,234** |
| Stress | $865 | $690 | +25.4% | **+$1,817** |

**Blended:** `+$696 / p-life`. At 1,000 pairs ≈ **+$34 M/yr** (no rebate yet).

### 2.3 WITH cooldown AND 6 % capped volume rebate on Mod/Elev/Stress (base ladder)

Effective rates: **$490 / $588 / $747 / $813**.

| Band | Rate (rebated) | **P&L / p-life (cd + 6% rebate)** | Atticus margin on premium |
|---|---:|---:|---:|
| Calm   | $490 | +$209 | 5.0 % |
| Mod    | $588 | **+$430** | **7.4 %** ← binding constraint, hardened from 2.3 % |
| Elev   | $747 | +$724 | 9.1 % |
| Stress | $813 | +$1,277 | 15.1 % |

**Blended Atticus = +$436 / p-life ≈ +$21 M/yr at 1,000 pairs (≈ +$210 M/yr at 10,000 pairs). Blended margin-on-premium ≈ 7.1 %.**

The Mod tier now lands at **7.4 % margin** — 3.2× the original ladder's 2.3 %. The single biggest fragility is removed.

### 2.4 With cooldown AND 8 % stretch rebate (when Bullish institutional + Falcon-X demonstrated)

Effective rates: **$490 / $575 / $731 / $796**.

| Band | Rate (rebated) | **P&L / p-life (cd + 8% stretch)** | Atticus margin on premium |
|---|---:|---:|---:|
| Calm   | $490 | +$209 | 5.0 % |
| Mod    | $575 | **+$303** | 5.4 % |
| Elev   | $731 | +$554 | 7.1 % |
| Stress | $796 | +$1,100 | 13.3 % |

**Blended Atticus at stretch = +$351 / p-life ≈ +$17 M/yr at 1,000 pairs (≈ +$170 M/yr at 10,000 pairs).** The 2 % stretch rebate is funded by venue savings; Atticus retains ~5.4 % Mod margin (still above the original-ladder 2.3 % at 8 %).

### 2.5 Original-ladder context (preserved for reference)

Original `$490/$605/$795/$865 + 8 %`: blended +$272/p-life, Mod margin **2.3 %** (binding fragility). Hardened ladder at base 6 %: blended +$436/p-life (+60 %), Mod margin **7.4 %** (3.2× headroom). Hardened ladder at 8 % stretch: blended +$351/p-life (still +29 % over original), Mod margin **5.4 %** (still +135 % vs original).

---

## 3. Foxify net cost — TWO views and a major doc inconsistency

Foxify will plausibly compute their net cost two different ways. Both must reconcile or the deal generates a month-1 dispute.

### 3.1 "Headline" view (no cooldown clip on payouts) at hardened ladder + 6 % rebate

| Band | Premium (rebated, 6 %) | Payouts (full trig rate) | Foxify net cost / p-life |
|---|---:|---:|---:|
| Calm   | $4,209 | $3,800 | +$409 |
| Mod    | $5,786 | $6,195 | **−$409** (Foxify nets +) |
| Elev   | $7,937 | $9,104 | **−$1,167** (Foxify nets +) |
| Stress | $8,447 | $12,139 | **−$3,692** (Foxify nets +) |

Blended: **−$382 / pair-life Foxify NET REVENUE** (≈ +$19 M at 1,000 pairs).

This view is **structurally impossible while Atticus is profitable** — but it is the view Foxify computes if they multiply `2.16 trig/day × $1,000` and subtract published premium. The CEO_ONE_SHEET and FOXIFY_CEO_BRIEFING have been updated (in this PR) to lead with the realised view and explicitly cite cooldown's effect on Foxify payouts; that mismatch is now closed in the doc set.

### 3.2 "Realised" view at hardened ladder + 6 % rebate, with design-target cooldown clip (20/30/50 %)

| Band | Premium (rebated) | Payouts (after cd) | Foxify net cost / p-life |
|---|---:|---:|---:|
| Calm   | $4,209 | $3,800 | +$409 |
| Mod    | $5,786 | $4,956 | +$830 |
| Elev   | $7,937 | $6,373 | +$1,564 |
| Stress | $8,447 | $6,070 | +$2,377 |

Blended Foxify cost = **+$863 / pair-life ≈ +$42 k/pair/yr ≈ $42 M at 1,000 pairs (≈ $420 M at 10,000 pairs); $390 M at the 8 % stretch slot**.

### 3.3 The doc inconsistency, quantified — and how this PR closes it

| Source | Foxify net cost @ 1,000 pairs | @ 10,000 pairs | Cost on volume |
|---|---:|---:|---:|
| `CEO_ONE_SHEET.md` (PRE-update) | **$23.3 M** | **$192 M** | 0.74 / 0.61 bps |
| `FOXIFY_PROFITABILITY_REALITY.md` §4.2 (PRE-update, old weights) | **$42.6 M** | **$426 M** | 1.35 bps |
| Per-pair-life math, original ladder + 8 % rebate, realised view | $34 M | $340 M | ~1.08 bps |
| **Per-pair-life math, hardened ladder + 6 % base, realised view (NEW canonical)** | **$42 M** | **$420 M** | **~1.38 bps** |
| **Per-pair-life math, hardened ladder + 8 % stretch, realised view** | **$40 M** | **$390 M** | **~1.28 bps** |

**`CEO_ONE_SHEET.md` and `FOXIFY_CEO_BRIEFING.md` have been updated in this PR** to the canonical hardened-ladder realised-view numbers. Single source of truth: **$42 M / $420 M / 1.38 bps base; $390 M / 1.28 bps at the 8 % stretch slot.**

---

## 4. Sustainability verdict on the hardened ladder

**Yes, with one structural dependency that this PR makes explicit:**

1. **Cooldown must deliver its design-target clip (~20/30/50 % trigger reduction in mod/elev/stress).** Without it, Atticus loses ~$36 M/yr at 1,000 pairs and the ladder is below floor in 3 of 4 bands. Conservative read of the spec (in `COOLDOWN_FOXIFY_BREAKDOWN.md`) suggests the spec as written delivers only ~1/4/12.5 % — the gap must be closed during implementation by either (a) tightening the T1–T4 thresholds (e.g., T1 fires at 15 % of capital not 25 %; T2 at 2× pair count not 4×) or (b) extending default cooldown duration from 4h to 6h. **Recommendation: empirically calibrate cooldown clip in `historical_replay.py` before production launch and adjust thresholds to deliver the design-target clip.**
2. **Foxify-facing docs now cite the realised view.** CEO_ONE_SHEET and FOXIFY_CEO_BRIEFING have been updated in this PR to publish the realised cost numbers ($42 M/$420 M, 1.38 bps) and to flag cooldown's effect on Foxify payouts in §5.3 of the briefing.
3. **Volume rebate is now capped at 6 % base** with the 8 % slot reserved for "demonstrated Bullish institutional pricing tier + Falcon-X cross-venue routing live in production for one full month each." Decouples Atticus margin from venue commitments not yet realised.

**Margin headroom at the hardened ladder:** blended ~7.1 % Atticus margin on premium with 6 % rebate + design-target cooldown. Calm (35 % of days, $490 at floor) still has 5 % margin and no rebate buffer. **The hardened Mod tier ($625) gives 7.4 % margin instead of 2.3 %** — the binding fragility of the original ladder is removed. A 20 % cost overrun on the calm-tier hedge anchor ($200 → $240 per pair-life) now compresses calm margin to 3 % and blended to ~6.0 % (vs original ladder 4.5 %) — comfortably above the 2σ pricing-reset threshold in normal months.

---

## 5. Hardening moves adopted in this PR

Three structural moves were adopted by founder direction:

| Change | Why | Cost to Foxify | Atticus impact |
|---|---|---|---|
| **Hold Calm = $490** | At floor; defines the "lowest possible price" narrative | none | accepted (5 % margin) |
| **Raise Mod $605 → $625** | Restores 7.4 % margin at 6 % rebate; survives even if cooldown clips less than design target | +$20/pair/day in mod (~$1.4k/pair/yr added) | +$165/p-life blended, removes single biggest fragility |
| **Cap top rebate at 6 % base; 8 % stretch reserved for demonstrated Bullish institutional + Falcon-X savings** | Decouples rebate from a future Bullish tier we don't fully control; pricing-reset clause becomes redundant | Foxify still gets 4–6 % rebate immediately, 8 % on proof | removes ~$15M/yr of rebate liability if savings underdeliver |
| **Cite cooldown effect on Foxify payouts in CEO docs** (CEO_ONE_SHEET §4 + FOXIFY_CEO_BRIEFING §5.3) | Foxify can't argue surprise; eliminates bait-and-switch risk; closes month-1 dispute window | none in $; transparency cost only | reputational protection |
| **Optional: Atticus excess-profit rebate above $30M/yr (15–25 % share)** | Gives Foxify a "we win when you win" line if CEO needs a profit narrative | only triggers when Atticus is well into the money | aligned, costs nothing in base case |

### Net effect of the adopted hardening (vs original ladder)

| Metric | Original ($490/$605/$795/$865 + 8 % rebate) | **Hardened ($490/$625/$795/$865 + 6 % base / 8 % stretch)** | Δ |
|---|---:|---:|---:|
| Atticus blended margin on premium | 5.6 % | **7.1 %** (8.1 % at 0% rebate) | +1.5 pp |
| Atticus annual @ 1,000 pairs | $13 M | **$21 M** (base) / $17 M (stretch) | +$8 M / +$4 M |
| Foxify cost @ 1,000 pairs | $34 M | **$42 M** (base) / $40 M (stretch) | +$8 M / +$6 M |
| Foxify cost on volume (bps) | 1.08 | **1.38** (base) / **1.28** (stretch) | +0.30 / +0.20 bp |
| Mod-tier margin (binding) | 2.3 % | **7.4 %** | +5.1 pp ← 3.2× headroom |

**Foxify pays ~17 % more in absolute cost (~25 % more bps), Atticus's binding-constraint margin triples.** Foxify is still 4–25× cheaper than every alternative in the comparison table, still under 1.4 bps on routed volume.

### Outstanding follow-up: empirical cooldown calibration

Cooldown's design-target clip (20/30/50 %) is the analytical assumption underpinning the ladder's sustainability. A conservative read of `COOLDOWN_CIRCUIT_BREAKER_SPEC.md` thresholds (in `COOLDOWN_FOXIFY_BREAKDOWN.md` §3) suggests the spec as written delivers only ~1/4/12.5 % — a 4–10× gap. The follow-up engineering task is:

1. Plumb cooldown logic into `scripts/double-barrier/historical_replay.py` (~1 day per spec §9 estimate).
2. Replay the full 6.4-year tape with cooldown active.
3. If empirical clip < design target, tighten T1–T4 thresholds and re-replay until design clip is achieved within ±5 %.
4. Document final calibrated thresholds in `COOLDOWN_CIRCUIT_BREAKER_SPEC.md`.

Until that calibration exists, **the hardened ladder's sustainability has a known dependency on cooldown being tuned to deliver design clip**. This is the single open analytical risk before production launch.

---

## 6. Doc sync status (closed in this PR)

| Doc | Issue | Status |
|---|---|---|
| `CEO_ONE_SHEET.md` | Foxify net cost tables understated realised cost ~1.5×; did not flag cooldown clip on Foxify payouts | **Updated to canonical $42 M @ 1k / $420 M @ 10k (base) / $390 M @ 10k (stretch); added cooldown citation pointing to `COOLDOWN_FOXIFY_BREAKDOWN.md`** |
| `FOXIFY_CEO_BRIEFING.md` §4–§5.3 | Same understatement; cooldown effect not explained | **Updated to balanced-median realised numbers; §5.3 now includes the per-regime cooldown firing table** |
| `FOXIFY_PROFITABILITY_REALITY.md` §4 | Used old 30/36/14/19 weights; quoted original ladder as "tightest sustainable" | **Updated to balanced 35/43/14/6 weights; new tier `$490/$625/$795/$865` adopted as recommendation; original ladder retained for reference comparison** |
| `PRICING_FINAL_PER_PAIR.md` §1 | Per-pair breakeven floors here ($472/$693/$994/$1,426) differ slightly from user's anchors ($466/$681/$970/$1,380); origin is hedge_net rounding | Open — both sets are internally consistent within ±1.5 %; not blocking sign-off |
| `COOLDOWN_FOXIFY_BREAKDOWN.md` | Did not exist | **Created in this PR** — plain-English Foxify-readable explainer; how/when cooldown fires, regime-by-regime probability, per-regime payout-clip estimates, worked stress-day timeline |

---

## 7. Bottom line — direct answer to "do these prices hold?"

> **Yes.** Hardened ladder `$490 / $625 / $795 / $865` with rebate
> capped at 6 % base / 8 % stretch is the lowest sustainable per-pair
> daily ladder Atticus can stand under realistic operating
> assumptions. Blended Atticus margin lands at **7.1 % on premium
> with 6 % rebate active (5.4 % at 8 % stretch)**. Mod-tier margin —
> the binding fragility on the original ladder — is hardened from
> 2.3 % to 7.4 %. Net to Atticus at 1,000 pairs ≈ **+$21 M/yr
> base / +$17 M/yr stretch** (≈ **+$210 M / +$170 M at 10,000 pairs**).
>
> **Net to Foxify after rebate, with cooldown realised at design
> target, balanced-median regime weights, is +$42 M/yr cost at
> 1,000 pairs base (+$40 M stretch), ≈ +$420 M at 10,000 pairs
> base (+$390 M stretch), or ~1.28–1.38 bps on routed volume.**
> All Foxify-facing docs (CEO_ONE_SHEET, FOXIFY_CEO_BRIEFING,
> FOXIFY_PROFITABILITY_REALITY) updated in this PR to lead with
> this canonical realised view.
>
> **One open analytical risk: cooldown's design-target clip
> (20/30/50 %) requires the spec thresholds be calibrated against
> the empirical 6.4-year tape via plumbed `historical_replay.py`.
> If the spec as written delivers materially less clip than design
> target, T1–T4 thresholds need tightening** (specific recommendations
> in `COOLDOWN_FOXIFY_BREAKDOWN.md`). Engineering follow-up; not
> blocking the commercial sign-off but blocking the production
> launch.
