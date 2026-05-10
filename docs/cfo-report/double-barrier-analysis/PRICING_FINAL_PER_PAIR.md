# Final Pricing Recommendation — All in PER-PAIR Daily Terms

> **Per-side vs per-pair clarification:** all prior memos in this folder
> (`MEMO_V2.md`, `PREMIUM_RECOMMENDATION.md`, `REVENUE_SPLIT_FRAMEWORK.md`,
> `HEDGE_OPTIMIZATION_ANALYSIS.md`) quote rates **per side per day**.
> The founder consistently uses **per pair per day** (matching the
> existing `Atticus_Vol_Facility_CFO_Walkthrough.md` convention of
> "$250/pair/day").
>
> **This doc restates everything in per-pair terms** so we're
> definitively on the same number.
> **Per-pair rate = 2 × per-side rate** (each pair has LONG-side and
> SHORT-side legs, both charged).
>
> **Recommended ladder (final): $525 / $750 / $1,200 / $1,600 per pair
> per day.** All numbers below are reproducible from
> `historical_replay.py` outputs.

---

## 1. Per-pair daily breakeven floors

This is the binding constraint. Below these per-pair daily rates, Atticus loses money in that regime regardless of volume:

| DVOL band | Per-pair daily breakeven |
|---|---|
| Calm (DVOL <50) | **$472/pair/day** |
| Moderate (50-65) | **$693/pair/day** |
| Elevated (65-80) | **$994/pair/day** |
| Stress (≥80) | **$1,426/pair/day** |

The user's V0 spec ($250/pair/day flat) is **below the calm breakeven** — it loses money in every regime.

---

## 2. Why $525/pair flat across DVOL <65 doesn't work

User's proposal: $525/pair for DVOL<65, separate higher tier for ≥65.

| Band | Rate | Atticus PnL/pair-life |
|---|---|---|
| Calm @ $525 | $525 | **+$457** ← thin but positive |
| Mod @ $525 | $525 | **−$1,650** ← LOSS |
| Elev @ $900 | $900 | **−$996** ← LOSS |
| Stress @ $900 | $900 | **−$5,465** ← BIG LOSS |
| Blended | — | **−$1,635/pair-life** |

A flat $525/pair across DVOL<65 looks fine in calm (+$457) but loses money in moderate (which is 36% of days). Blended P&L is **−$1,635/pair-life = $85k/pair/year LOSS = $850M/year LOSS at 10,000 pairs.**

The structural reason: trigger frequency scales with vol. Mod regime has 6.2 triggers/pair-week vs calm's 3.8 triggers/pair-week — 60% more $1k payouts to fund. A flat rate across calm+mod under-prices mod.

**Need separate tiers for at least calm vs mod**, and for elev vs stress.

---

## 3. Recommended ladder: 4-tier B ($525 / $750 / $1,200 / $1,600 per pair)

This honors the founder's $525 calm preference AND keeps Atticus profitable in every regime:

| DVOL band | Per-pair daily rate | Atticus PnL/pair-life | Foxify net cost/pair-life | Foxify net $/day | Margin over breakeven |
|---|---|---|---|---|---|
| Calm (<50) | **$525** | +$457 (10% margin) | +$710 | $101 | 11% |
| Mod (50-65) | **$750** | +$564 (8% margin) | +$1,185 | $169 | 8% |
| Elev (65-80) | **$1,200** | +$2,191 (17% margin) | +$3,646 | $521 | 21% |
| Stress (≥80) | **$1,600** | +$1,808 (11% margin) | +$4,485 | $641 | 12% |
| **Blended** | — | **+$990/pair-life** | **+$2,002** | $286 | — |

### 3.1 Atticus annual P&L at this ladder

| Scale | Annual Atticus P&L |
|---|---|
| Phase 1 (4.3 pairs) | $221k |
| Phase 2 (12.9 pairs) | $664k |
| Phase 5 (1,000 pairs) | **$51.5M** |
| At Foxify-scale (10,000 pairs) | **$515M** |

### 3.2 Foxify economics at this ladder

Per pair-life, Foxify pays Atticus **$2,002 net of payouts** on average. They make this back from:
- Funding/basis spread on matched perps: ~$50-200/pair-life
- Order-flow rebates: ~$20-50/pair-life
- Reselling to end-users (if applicable): variable markup
- TP on the unwinding-leg perp at trigger time (if matched, this is ~zero net)
- The structural enabling of running market-neutral pairs at scale (without Atticus's protection, gap risk caps how big they can run)

For Foxify to break even at 4-tier B ladder, they need $286/day average across regimes from these alternative income sources. **That's a question to validate with Foxify CEO** — what's their economic model breakdown per pair?

If their model can support $286/day blended (which is plausible for a desk running matched-pair arb), the 4-tier B ladder works.

---

## 4. Alternative ladders if Foxify pushes back

Given the founder's "razor thin margin OK at scale" mandate:

### 4.1 4-tier A: $500 / $700 / $1,100 / $1,500 per pair (Phase 1 minimum-viable)

| Band | Rate | Atticus PnL/pair-life | Foxify net cost/day |
|---|---|---|---|
| Calm | $500 | +$242 (5% margin) | $71 |
| Mod | $700 | +$72 (1% margin — razor) | $99 |
| Elev | $1,100 | +$1,128 | $369 |
| Stress | $1,500 | +$769 | $492 |
| **Blended** | — | **+$403/pair-life** | $202 |

Atticus annual at 1,000 pairs: $20.9M. Tighter for Foxify ($202/day blended), but Atticus's mod-tier margin is dangerously thin (1%) — any model error wipes it out. Not recommended without volume guarantee.

### 4.2 4-tier C: $525 / $800 / $1,300 / $1,700 per pair (richer if Foxify accepts)

| Band | Rate | Atticus PnL/pair-life | Foxify net cost/day |
|---|---|---|---|
| Calm | $525 | +$457 | $101 |
| Mod | $800 | +$1,056 | $240 |
| Elev | $1,300 | +$3,254 | $673 |
| Stress | $1,700 | +$2,847 | $789 |
| **Blended** | — | **+$1,514/pair-life** | $361 |

Atticus annual at 1,000 pairs: $78.7M. Foxify's net cost averages $361/day blended (~36 bps/day on $100k notional). If Foxify finds the higher elev/stress prices acceptable, this is the best Atticus tier.

---

## 5. Direct answers to the founder's questions

### 5.1 "Would $525 flat for DVOL<65 work?"

**No.** Mod regime (50% of <65 days) requires at least $693/pair to break even; a flat $525 loses Atticus $1,650 per pair-life in mod. Need separate calm vs mod tiers. **Recommendation: $525 calm and $750 mod (4-tier B).**

### 5.2 "Why would Foxify pay more for the protection than they're getting paid out?"

This is the right question to ask Foxify directly. Two scenarios:

**Scenario A: Foxify is purely a matched-pair vol harvester.** They hold market-neutral LONG+SHORT perps; the perp pair nets zero on directional moves; Atticus's $1k payout is their only direct income from the structure. In this case the per-pair-life math says they break even when premium ≤ payouts. At calm $525/pair = $4,510 premium vs $3,800 payouts, they need ~$710/pair-life of additional income from funding/basis/rebates to be net positive. That's $101/day, achievable with even modest 10 bps/day funding-spread capture on $100k notional.

**Scenario B: Foxify resells the protection to end-user traders.** Foxify charges retail $X/pair-day, pays Atticus $Y/pair-day, keeps the spread. Their economics depend on $X (which they set), not just on Atticus's payouts. **This is most likely the actual model** — Foxify is "building a vol facility" for their platform users, who are the ones running matched pairs and consuming the protection.

In either scenario, Foxify isn't comparing **(premium paid) vs (Atticus payouts received)** in isolation — they're comparing it to their **total revenue stream from running the strategy at scale.** Frame the conversation that way:

> *"Foxify, the right number isn't 'premium = payouts' — that's risk-neutral
> and would mean Atticus is giving the protection away. The right number
> is 'premium ≤ payouts + your strategy's other income (funding, basis,
> rebates, retail markup if reselling).' What does that other income
> look like per pair-life in your model? Once we know that we can pin
> the premium to leave you a healthy margin."*

### 5.3 "Why is retail cheaper?"

Three structural reasons. The user is right to be confused — it's not the structure that's different, it's the *frequency*:

| Dimension | Retail product | Vol facility product |
|---|---|---|
| Cycle length | 5-7 days | 1 day (intra-day reset on triggers) |
| Trigger floor | 12-20% drawdown | 2% from anchor |
| Trigger probability per cycle | ~5-10% | ~50% per day, with multiple intra-day re-opens |
| E[triggers per pair-life] | ~0.3 (calm) | ~3.8 (calm) to ~12 (stress) |
| Auto-reopen on trigger | NO | YES (Foxify reopens both perps, Atticus opens fresh strangle) |
| E[payout per pair-life] | ~$30 (5% × $200 cap) | ~$3,800-$12,140 |

**Premium per pair must scale with E[payouts].** Retail's $125/pair-day works because expected payout per cycle is ~$30 (essentially nothing — most cycles never trigger). Vol facility's expected payout per pair-life is **100-400× retail's**. So premium must scale similarly.

The Foxify CEO's instinct ("savvy traders would do what I'm doing") was right that the structure is the same — but he missed that **the expected number of payout events per dollar of premium is fundamentally different.** Retail premium is sized for ~5% chance of one $200 payout; vol facility premium is sized for ~75% chance of multiple $1,000 payouts every single day.

Concrete framing for him:

> *"Retail and vol facility are the same protection contract on paper, but
> the daily reset + 2% floor + auto-reopen mean we're processing 30-300×
> more payout events per pair per week than retail. Retail's $125/pair/day
> rate covers ~$30 of expected payout per cycle — that's a ~4× premium-to-
> payout ratio. Vol facility's blended ~$865/pair/day rate covers ~$7,400
> of expected payouts per pair-life — that's a ~1.4× premium-to-payout
> ratio. The vol facility is actually a TIGHTER margin product per dollar
> of payout protection. The headline number looks higher because of the
> compounding trigger frequency, not because we're charging more for the
> same risk."*

### 5.4 "Can we make up margin via TP because option value is more in higher vol?"

**Yes — and we already are**, in the tiered ladder structure.

Empirically, the long-vol position captures more VRP edge in higher-DVOL regimes:
- Calm VRP: +5.8% (small edge)
- Mod VRP: +12.1%
- Elev VRP: **+22.1%** (large edge)
- Stress VRP: **+24.9%** (largest edge)

This shows up in the per-pair-life P&L margins:
- Calm @ $525 ladder: 10% margin (small)
- Elev @ $1,200 ladder: 17% margin (largest, exactly when VRP edge is biggest)
- Stress @ $1,600 ladder: 11% margin

**The reason elev has the highest margin is precisely the VRP capture you intuited.** The 4-tier ladder structure is already designed to exploit this — it charges proportionally more in higher-vol regimes, which is also where the long-vol hedge has the biggest expected edge.

There's no separate "TP optimization" beyond what V3 already captures. The ladder structure IS the TP optimization.

---

## 6. Recommended sequence for the Foxify conversation

1. **Open with 4-tier B ($525/$750/$1,200/$1,600 per pair).** Calm hits the founder's $525 anchor; other tiers reflect actual trigger frequency.

2. **Frame the premium-vs-payout conversation:** "Foxify, your $525 in calm covers $3,800 of expected payouts plus the structural enabler of running pair-volume at scale. The other 47% of days (mod/elev/stress) the cost goes up because trigger frequency goes up — you're getting more payout events for each premium dollar."

3. **Ask the diagnostic question:** "What's your expected income per pair-life from sources other than Atticus payouts? Funding, basis, MM rebates, retail markup if you're reselling. Once we know that we can verify the deal works for you across vol regimes."

4. **If Foxify pushes calm tier below $525:** counter with cooldown threshold tightening, settlement-timing concessions, or volume-rebate trigger thresholds — not a calm-tier price drop. The $472/pair calm breakeven floor is hard.

5. **If Foxify wants ≥65 collapsed into one tier:** offer 3-tier $525/$750/$1,400 per pair (combining elev+stress at $1,400). Atticus blended +$893/pair-life — slightly tighter than 4-tier B but workable.

6. **Lock in pricing for 6-12 months in exchange for written volume commitment.** Foxify has indicated $50M+ daily notional; convert to "≥X pair-days/month by Month Y" in the contract. That's the structural concession Atticus offers in return for tighter pricing.

---

## 7. Quick reference table — per-pair daily rates at every tier discussed

| Tier label | Calm | Mod | Elev | Stress | Atticus blended P&L | Foxify net $/day blended | Recommended use |
|---|---|---|---|---|---|---|---|
| V0 spec | $250 | $250 | $250 | $250 | **−$5,568** | unrealistic | DON'T USE — loses everywhere |
| Founder $525 flat <65 | $525 | $525 | $900 | $900 | **−$1,635** | n/a | DON'T USE — loses in mod & stress |
| 4-tier A (lean) | $500 | $700 | $1,100 | $1,500 | +$403 | $202 | Phase 1 minimum-viable |
| **4-tier B (recommended)** | **$525** | **$750** | **$1,200** | **$1,600** | **+$990** | **$286** | **PRIMARY OFFER** |
| 4-tier C (richer) | $525 | $800 | $1,300 | $1,700 | +$1,514 | $361 | If Foxify accepts |
| 3-tier ($525/$750/$1,400) | $525 | $750 | $1,400 | $1,400 | +$893 | $272 | Simpler ops, slight stress loss |

For each per-pair rate you can plug into the formula:

```
PnL_per_pair_life = rate × mult_pair[band] − payouts[band] − hedge_net[band]

mult_pair  = {calm: 8.59, mod: 9.84, elev: 10.625, stress: 10.39}
payouts    = {calm: 3800, mod: 6195, elev: 9104,  stress: 12139}
hedge_net  = {calm: 253,  mod: 621,  elev: 1455,  stress: 2677}
```

---

## 8. Bottom line

> **Recommend 4-tier B ($525 / $750 / $1,200 / $1,600 per pair per day) as the
> primary offer to Foxify.** Calm hits founder's $525 anchor; other tiers
> price proportionally to trigger frequency × VRP edge by band. Atticus
> earns +$990/pair-life blended, $51M/year at 1,000 pairs scaling to $515M
> at 10,000 pairs. Foxify's blended net cost is $286/day per pair, which
> their funding/basis/rebate income should comfortably cover at scale.
>
> **Don't go flat across DVOL<65** — mod regime requires separate pricing
> ($693 breakeven) or Atticus loses money on 36% of days. **Don't drop
> calm below $472** (per-pair breakeven floor); below that point, no
> volume offsets the per-pair loss.
>
> **The right move if Foxify pushes harder than 4-tier B is structural
> concessions (cooldown, settlement timing, volume rebate triggers), not
> calm-tier price drops.**
