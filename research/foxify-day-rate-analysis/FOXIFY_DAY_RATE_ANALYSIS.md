# Foxify Pricing-Model Evolution: Day-Rate Analysis

**Status:** ANALYSIS ONLY. No changes to the live Foxify pilot. No pilot code touched. No imports from any pilot path. Findings here are paper-only and require the user's decision before any implementation discussion.

**Context:** Foxify pilot is currently CEO-only (pre-rollout). CEO is pushing back that the $65 fixed premium is too high. This document evaluates whether to evolve to a day-rate model, and analyzes four candidate paths.

---

## 1. The four candidates evaluated

| | A. Status quo | B. Lower fixed | C. Day-rate (theta) | D. Flat $/k/day |
|---|---|---|---|---|
| Trader sees | $65/day | $35/day | ~$4.64/day, varies with vol | $1/day per $1,000 |
| Mechanism | 1-DTE Deribit, daily roll | Same as A, lower price | 14-DTE spread, theta-following debit | 14-DTE spread, flat-rate debit |
| User UX | Auto-renew toggle | Same as A | Cancel anytime | Cancel anytime |
| Atticus capital deployed/user | $35 | $35 | $50 | $50 |

The simulation is in `src/simulate.ts`. Re-runnable with `npm run sim`. Numbers below are illustrative, with a complete documented assumption stack — replace assumptions with real Foxify data to validate.

---

## 2. Key results from the simulation

### 2.1 Per-cohort economics (3-day avg hold)

| | User pays total | Atticus net | Atticus margin % |
|---|---|---|---|
| A. Status quo ($65/day) | $195 | **$84** | 43% |
| B. Lower fixed ($35/day) | $105 | **−$6** | −6% (loss) |
| C. Day-rate theta-following | $14 | **$1.21** | 9% |
| D. Flat $1/k/day | $15 | **$2.29** | 15% |

### 2.2 Monthly steady-state at 100 active users

| | Atticus monthly rev | Atticus monthly net |
|---|---|---|
| A. Status quo | $195,000 | **$84,000** |
| B. Lower fixed | $105,000 | **−$6,000** |
| C. Day-rate theta | $13,929 | **$1,214** |
| D. Flat $/k/day | $15,000 | **$2,286** |

### 2.3 The headline finding

**Switching from A → C or D drops Atticus monthly net revenue by ~30-50× at the same user count.** That's the elasticity gap. For day-rate to be financially equivalent, one of:
- User count needs to grow ~30-50× (cheap product → many more users opt in)
- Or hold time needs to extend ~30-50× (cheap product → users keep protection on much longer)
- Or both, multiplicatively

This is achievable in principle but requires user behavior data we don't have. **The CEO's "$65 is too high" observation is real, but the fix isn't simply "switch to day-rate" — the fix has to come with a credible adoption-and-retention story.**

---

## 3. The CEO's $65 problem — three honest diagnoses

### Diagnosis 1: Price is too high relative to expected loss
A trader doing the napkin math: 5% SL × $5,000 notional × ~5% daily trigger probability = $12.50 expected payout. Paying $65 for a $12.50 expected payout = 5× markup. That's high, regardless of how it's packaged. **A trader who runs the numbers will balk at $65 per day even if it's renamed "$1/day per $1k."**

The honest fix: **lower the price**, not just change the label.

### Diagnosis 2: Single-day pricing is structurally inefficient

A 1-DTE option has very high theta-as-fraction-of-premium (steepest part of the decay curve). Annualized cost is roughly 3-5× a 30-day option of equivalent strike. By using 14-DTE underlying, day-rate naturally lowers the daily cost.

| | 1-DTE cost | 14-DTE daily theta | Cost ratio |
|---|---|---|---|
| Atticus pays Deribit per day | $35 | $3.57 | **~10× cheaper** |

So day-rate IS structurally cheaper for Atticus to operate, even before pricing changes. **The $30/day Atticus margin under the status quo includes a big inefficiency.**

### Diagnosis 3: The product UX may not match user need

If the typical Foxify user holds 2-3 days, the auto-renew flow on a 1-DTE structure forces them through the renewal decision multiple times per trade. Each renewal is a friction point. Day-rate ("debit until you cancel") removes those friction points entirely.

---

## 4. Recommended path

**Mixed strategy in three phases. Run all three only after CEO confirms direction.**

### Phase 1 (immediate, lowest risk): lower the fixed premium

- **Don't go to $35** (Atticus loses money at current cost basis).
- **Pricing-schedule tweak:** lower the calm-regime premium by 25-30% (e.g., $65 → $48 for the typical 5% SL tier). Atticus net margin drops from ~43% to ~25%, still healthy.
- **Zero pilot disruption** — config-level change to the existing schedule.
- **Kept benefit:** existing CEO-test-trades validate the same product structure.
- **Cost:** doesn't fully solve the "$65 feels too high" perception — $48 still feels high to a trader.

### Phase 2 (concurrent, scoping work): build day-rate (mechanism D, flat $/k/day)

- **New product offering** rather than replacement.
- Use 14-DTE Deribit spread underneath (cheaper per-day cost, as analyzed above).
- Trader sees: **"$1/day per $1,000 of protected position"**. Clean mental math, scales with size.
- Atticus margin per active user is much smaller ($2.29/cohort vs $84) — so the volume play matters: this needs to attract significantly more users to be economically meaningful.
- **Crucial open question:** does Foxify's current trader funnel deliver enough users at a $1/$k/day price point to make this profitable? Need the user-acquisition team's input.

### Phase 3 (decision-gated): consolidate to single product

After 4-8 weeks of A/B test data on the two-product surface, choose:
- **Keep both** as a tiered offering ("predictable fixed-premium" vs "pay-as-you-go")
- **Replace fixed with day-rate** if day-rate adoption is materially higher
- **Stay on lowered-fixed** if day-rate doesn't pull enough volume

---

## 5. The flat-$5/day question, answered specifically

**Yes, but it has to scale with position size.** A flat $5/day works for one position size only.

- $1k position → $5/day on a $1k bet is 0.5%/day = 50% annualized. Trader will perceive as expensive for that size.
- $10k position → $5/day on a $10k bet is 0.05%/day = 5% annualized. Trader will perceive as cheap.

**The clean form is: "$1 per day per $1,000 of position notional."** Same digestible $5/day for a $5k position the CEO had in mind, but scales correctly across the size range.

If $1/$1k feels too low for Atticus margin, the cleanest variant is "$1.50 per day per $1,000" — same UX, slightly more margin.

---

## 6. Capital and treasury (your assumption check)

You said: *"i assume atticus payout treasury wouldnt really change bc triggers wouldnt be effected right?"*

**Confirmed. Treasury size: unchanged across all four models.**

- Trigger frequency is determined by BTC price moves and SL thresholds, neither of which change with the pricing model.
- Per active user, ~$300 treasury reserve covers a 30-day rolling SL-payout buffer (5% SL × $5k notional × 4% daily trigger × 30 days = $300).
- At 100 active users: ~$30k total treasury reserve. Same across all four models.

**One nuance:** under day-rate variants (C/D), the underlying Deribit spread is 14-DTE, not 1-DTE. On a trigger event, Atticus must sell the spread back to Deribit at mid-market to extract the in-the-money value (~95% capture after 5% bid-ask haircut). Under 1-DTE, the option settles same-day with no haircut. So **trigger-payout treasury size is unchanged, but capital efficiency on trigger payout drops by ~5%** under day-rate variants. Manageable.

### Capital deployed in active hedges

| Model | Per active user | At 100 users |
|---|---|---|
| A & B (1-DTE) | $35 | $3,500 |
| C & D (14-DTE) | $50 | **$5,000** (43% more) |

Day-rate variants need ~$1,500 more deployed capital at this scale. Modest.

### Total Atticus capital requirement (estimate, 100-user scale)

| Component | Amount |
|---|---|
| Active hedge capital | $5,000 (under day-rate) |
| Trigger payout treasury | $30,000 (unchanged) |
| Working capital (pre-fund Deribit before user fees flow in) | ~$5,000 |
| Tail-event buffer (vol crisis, ~20% of active hedge value) | ~$1,000 |
| Operational reserve | $10,000 |
| **Total** | **~$51,000** at 100-user scale |

Scales linearly with active user count. **Atticus capital required is dominated by the trigger payout treasury, which is independent of pricing model.**

---

## 7. Risks specific to switching to day-rate (any flavor)

1. **Cannibalization at current user count.** $84k/mo → $1-2k/mo at 100 users is a real revenue cliff. Only viable if user count and/or hold time grow proportionately. Need real adoption-elasticity data.

2. **Pre-rollout context cuts both ways.** Yes, no users to disrupt — so we have UX latitude. But we *also* haven't validated retention/renewal behavior at any price point yet. Switching to day-rate without first establishing baseline retention at the current $65 means no anchor for elasticity assumptions.

3. **Vol regime change behavior under flat-$/k/day.** If BTC IV doubles, Atticus's 14-DTE spread cost roughly doubles, but trader's daily fee stays at $1/$k. **Atticus eats variance until the next position is priced at new IV.** Need a rebate trigger ("daily fee adjusts to current vol regime, capped at +50% from entry") OR accept variance as cost-of-doing-business at scale.

4. **Operational complexity.** Theta-following (C) is operationally simple at the math level but UX-confusing. Flat-$/k/day (D) is UX-clean but requires re-pricing logic for vol regime drift. Both are real engineering work compared to the existing 1-DTE rolling system.

5. **Adverse selection.** Users who see a big move coming will keep protection on; users who don't will close. Average held duration → longer than baseline → option held closer to expiry → less residual to refund. Materially affects per-user margin in mechanism C.

6. **Kalshi-NO-leg trap.** Earlier iterations of this analysis briefly considered giving Atticus the ability to take Kalshi-NO positions (effectively MMing the user's bet). **Rejected.** Same logic applies here: under no circumstance should day-rate be implemented as "Atticus warehouses risk via a pool" (mechanism C in the SynFutures analysis). Pure pass-through preserved.

---

## 8. Decision framework for the CEO conversation

Three questions to answer before committing:

1. **What's the realistic adoption-elasticity?** If Foxify can grow active users 30-50× by switching to day-rate, the math works. If the floor is more like 3-5×, day-rate loses money. **Need user-acquisition data.**

2. **What hold-duration distribution will day-rate produce?** At $1/$k/day, the price-of-cancel is asymmetric: keeping protection on costs the user $5/day, canceling forfeits residual. If users keep protection on longer than 3 days under day-rate, Atticus revenue per user goes up materially. **Need a small-N test.**

3. **What's the right launch sequencing?**
   - **Option X:** Lower fixed premium first → 4-6 weeks of data → introduce day-rate as a second product
   - **Option Y:** Skip lower-fixed, go directly to day-rate at launch
   - **Option Z:** Keep $65 (CEO accepts), launch as-is

X is the safest and recommended.

---

## 9. What I won't do

- Touch any file in `services/`, `apps/web/`, `packages/`, `docs/`, `scripts/`, `contracts/`, `configs/`, `env/`
- Make ANY changes to the live Foxify pilot
- Implement day-rate without explicit user confirmation
- Use real Foxify trade data without explicit handoff (the simulation here uses ASSUMED parameters; replace them with real numbers via a secure file drop to validate)

This is a **paper analysis to inform the CEO conversation**, not a development plan.

---

## 10. What's needed before this becomes implementable

1. Real Foxify pilot data confirming/correcting the four key assumptions:
   - Average hold time (currently assumed: 3 days)
   - Position-size distribution (currently assumed: $5k median)
   - SL trigger rate per day at the 5% tier (currently assumed: 4%)
   - Atticus's actual cost basis on 1-DTE Deribit hedges (currently estimated: $35)

2. CEO direction on which Phase 1 path to pursue (lower fixed, dual-product, or skip to day-rate).

3. If Phase 2 is greenlit, scoping work for the day-rate engine — separate from the live pilot, in `services/foxify-day-rate/` (new isolated module, not modifying existing pilot code paths).

---

## Files

```
research/foxify-day-rate-analysis/
  FOXIFY_DAY_RATE_ANALYSIS.md     this document (the deliverable)
  src/simulate.ts                 four-candidate revenue/margin sim
  package.json, tsconfig.json     standard tsx setup
```

To re-run: `cd research/foxify-day-rate-analysis && npm install && npm run sim`
