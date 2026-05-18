# Revenue-Split Framework — How to Price the Atticus-Foxify Volume Facility

> **Trigger for this doc:** founder feedback 2026-05-10 that Foxify is
> not a retail trader buying insurance — they're a market-place
> aggregator routing matched LONG/SHORT volume through exchange
> partners. They earn (a) the trigger payout from Atticus, (b) the TP
> on the opposite-leg perp's 2% intrinsic gain when one side fires,
> and (c) exchange rebates/spread on the routed volume. **The
> negotiation is about how the joint economic surplus splits between
> Atticus and Foxify, not about "is the insurance worth it."**

---

## 1. The economic surplus at each trigger event

When a trigger fires on a $50k pair (LONG + SHORT, 2% barrier):

| Cash flow | Beneficiary | Amount |
|---|---|---|
| Atticus pays trigger payout | Foxify | +$1,000 |
| Foxify TPs opposite-leg perp (the leg that gained 2%) | Foxify | +$1,000 |
| Foxify pays new pro-rated premium for re-opened pair | Atticus | +$pro_rated |
| Foxify reopens both perps; pays exchange spread | Venue | −small (rebate offsets) |
| Atticus sells ITM hedge leg to venue | Atticus | +intrinsic+TV |
| Atticus opens fresh strangle at new spot | Atticus | −option_cost |

**Foxify nets ~$2,000 gross per trigger** (Atticus payout + TP), minus the pro-rated premium they pay Atticus, minus modest perp closing slippage. Plus the rebate from the volume they're routing.

This is why Foxify wants the structure: **without Atticus's protection, gap risk would cap their pair count; with Atticus's protection, Foxify can run thousands of concurrent pairs and scale the rebate machine without bounded risk per pair.**

Atticus is the enabler. The pricing question is what fraction of the joint surplus Atticus captures.

---

## 2. Joint surplus per pair-life — empirical 6.4-year average

For each pair-life over 7 days, daily-strangle hedge, V3 economics:

```
Foxify gross income       ≈ E[triggers] × $2,000 + perp rebate (~$35)
Atticus gross income      ≈ premium received − E[payouts] − hedge_net_cost
Joint economic surplus    ≈ E[triggers] × $1,000 + perp rebate − hedge_net_cost
                          ≈ $6,000 per pair-life (blended)
```

The joint surplus is approximately **$6,000 per 7-day pair-life regardless of premium tier** — premium just shifts where the surplus lands.

### 2.1 Surplus split at each tier (blended across regimes)

| Premium tier | Atticus take | Foxify take | Atticus share |
|---|---|---|---|
| V3-A ($425/$600/$900/$1,100) | **$5,571** | **$479** | 92% |
| Option B ($300/$450/$650/$900) | $2,288 | $3,762 | 38% |
| Option C ($250/$400/$600/$850) | $1,320 | $4,730 | 22% |
| **Option E ($245/$375/$550/$800)** | **$762** | **$5,288** | **13%** |
| Option F ($238/$350/$510/$730) | $144 | $5,906 | 2% |
| (Breakeven floor below) | $0 | $6,050 | 0% |

**At V3-A pricing, Atticus takes 92% of the joint surplus** — this is why Foxify pushed back. Foxify wants a more equitable split that lets them deploy serious volume capital.

**At Option F (just above per-band breakeven), Atticus takes essentially nothing.** Volume scales the dollar amount but the margin is razor-thin and any model error or unmodeled cost wipes it out.

**The right zone is Options C-E**, capturing 13-22% of joint surplus for Atticus while leaving 78-87% to Foxify to fund their scale. Pick on volume guarantee.

---

## 3. Annualized P&L at each tier (from `historical/historical_summary.json`)

**Atticus per-pair annual P&L** (assuming pair always operates):

| Tier | $/pair/year | Phase 1 (4.3 pairs) | Phase 5 (1,000 pairs) | Foxify-scale (10,000 pairs) |
|---|---|---|---|---|
| V3-A | $290k | $1.25M | $290M | $2.9B |
| B | $119k | $512k | $119M | $1.19B |
| **C** | **$69k** | **$295k** | **$69M** | **$686M** |
| **E** | **$40k** | **$170k** | **$40M** | **$396M** |
| F | $7.5k | $32k | $7.5M | $75M |

**Foxify's annualized take per pair:**

| Tier | Foxify $/pair/year | Phase 5 ($/year) | Foxify-scale ($/year) |
|---|---|---|---|
| V3-A | $25k | $25M | $250M |
| B | $196k | $196M | $1.96B |
| **C** | **$246k** | **$246M** | **$2.46B** |
| **E** | **$275k** | **$275M** | **$2.75B** |
| F | $307k | $307M | $3.07B |

For Foxify to commit serious capital + ops resources to this product, they probably need at least $200k/pair/year of upside — which lands them in the Option B-E range.

---

## 4. The negotiation logic

### 4.1 Foxify's likely target number

The user said "they have a number in mind that makes this worth it for them." Three reference points to triangulate from:

1. **Foxify's typical desk margin at scale.** A market-making desk on perps usually targets 5-15 bps net per dollar of routed volume. On $100k pair × 365 days × meaningful turnover, that's a few thousand $/pair/year of operating margin. Scaling to 1,000+ pairs requires hundreds of millions of $/year of joint surplus, which lands in Options C-E.

2. **Capital-deployment ROI.** Foxify needs to justify the venue capital deployed for the matched perps + the operational cost. At $10-50k of margin capital per pair × 5-10× ROI requirement, they need $50-500k/pair/year. Option C ($246k Foxify take) and Option E ($275k) both clear this.

3. **Apples-to-apples vs running their own hedge.** If Foxify could buy the equivalent protection at Bullish/Deribit for ~$190/pair/day (raw 2% OTM strangle cost), they'd pay ~$70k/pair/year DIY. But DIY doesn't auto-reset, doesn't include the operational layer Atticus provides. Foxify probably accepts up to 1.5-2× DIY cost = $100-140k/pair/year in Atticus premium net cost. **At Option C, Foxify pays Atticus ~$343/day calm × 365 = $125k/pair/year net** — hits this ceiling.

**The Foxify-acceptable zone is roughly between Option C and Option E.** Closer to E if they're scale-committed; closer to C if they're risk-conservative.

### 4.2 Where Atticus should land

**Lead with Option C ($250/$400/$600/$850 per side)** as the opening offer. It:
- Atticus: thin but positive in every regime (+$241 calm, +$1,320 blended)
- Foxify: 78% of joint surplus, $246k/pair/year take
- Markup over DIY: 2.6× (typical insurance product)

**Be ready to fall to Option E ($245/$375/$550/$800)** in exchange for a **minimum-volume commitment**:
- Atticus: still positive in every regime (+$155 calm, +$762 blended)
- Foxify: 87% of joint surplus, $275k/pair/year take
- Concession demand: Foxify commits to ≥500 pair-day-equivalents per month by Month 4

**Do not go below Option E without restructuring**:
- Below Option E, Atticus's calm-regime margin is so thin that any model error wipes it out.
- If Foxify wants tighter pricing, structure it as **a base rate + pay-per-volume rebate** (see §5) rather than dropping the floor across the board.

---

## 5. Volume-rebate structure (recommended)

**Pricing structure:**

```
Base premium ladder (Option C):
  Calm:    $250/side/day
  Mod:     $400/side/day
  Elev:    $600/side/day
  Stress:  $850/side/day

Volume rebate (paid monthly to Foxify, computed on PRIOR month's volume):
  0–500 pair-days/month:        0% rebate (full Option C rate)
  500–2,000 pair-days/month:    5% rebate on premium
  2,000–10,000 pair-days/month: 10% rebate on premium
  10,000+ pair-days/month:      15% rebate on premium

CRITICAL FLOOR: rebate ONLY applies to mod/elev/stress tiers.
Calm tier stays at $250/side regardless of volume — preserves Atticus's
breakeven floor.
```

This gives Foxify a clear scale incentive: they pay full rate at small scale (so we're not subsidizing their ramp), but as they hit scale milestones the effective rate drops 10-15% — directly funding Foxify's capital deployment without breaching Atticus's per-pair breakeven.

**Effective rates at the 15%-rebate tier (10,000+ pair-days/month):**

| Band | Base rate | Effective rate (15% rebate) | Atticus PnL/pair-life |
|---|---|---|---|
| Calm | $250 | $250 (no rebate) | +$241 |
| Mod | $400 | $340 | +$172 |
| Elev | $600 | $510 | +$280 |
| Stress | $850 | $723 | +$159 |
| **Blended** | — | — | **+$224/pair-life** |

At max-rebate scale, Atticus per-pair PnL drops to $224/pair-life ($11.6k/pair/year). At 10,000 pairs that's $116M/year Atticus revenue — still excellent, achieved by trading per-pair margin for volume. **This is the explicit "tighter margin at scale" structure the founder mentioned.**

---

## 6. Suggested negotiation sequence

```
Step 1: Open with Option C ($250/$400/$600/$850 per side, no volume rebate).
        Foxify takes $246k/pair/year, Atticus takes $69k.
        Anchor reference: 2.6× markup over DIY raw cost.

Step 2: If Foxify pushes back, offer Option C + volume rebate structure
        (§5 above). Up to 15% rebate at 10,000+ pair-days/month.

Step 3: If Foxify still pushes, offer Option E base rate ($245/$375/$550/$800)
        with same volume rebate. Atticus margin: thin but positive across
        every band.

Step 4: If Foxify wants below Option E, ask "what's the number that makes
        it worth it for you?" and back-calculate. If their number falls
        below $236 calm / $346 mod / $497 elev / $713 stress (the per-band
        breakeven floors), Atticus walks — that's structurally money-losing
        territory that no volume offsets.

Step 5: Lock in pricing for 6-12 months in exchange for Foxify minimum-
        volume commitment ("Atticus locks Option E for 12 months if
        Foxify commits to ≥X pair-days/month by Month Y").
```

---

## 7. Per-band rate sensitivity calculator

For any premium rate Foxify proposes per side per day, plug into:

```python
# Per-band coefficients (V3 corrected economics, daily strangle)
mult       = {'calm': 17.18, 'mod': 19.68, 'elev': 21.25, 'stress': 20.78}
payouts    = {'calm':  3800, 'mod':  6195, 'elev':  9104, 'stress': 12139}
hedge_net  = {'calm':   253, 'mod':   621, 'elev':  1455, 'stress':  2677}
weights    = {'calm':  0.30, 'mod':  0.36, 'elev':  0.14, 'stress':  0.19}

def atticus_pnl(rate_per_side):
    blended = 0.0
    for band, w in weights.items():
        rate = rate_per_side[band]
        premium = rate * mult[band]
        platform_pnl = premium - payouts[band] - hedge_net[band]
        blended += w * platform_pnl
    return blended

# Example:
print(atticus_pnl({'calm': 245, 'mod': 375, 'elev': 550, 'stress': 800}))
# 762.0
```

If Foxify proposes a tier and the formula returns:
- **>$1,000/pair-life** → comfortable margin, accept
- **$500-$1,000** → thin margin, accept with volume commitment
- **$100-$500** → razor margin, accept ONLY with material volume commitment + tight cooldown thresholds
- **<$100** → reject; below this Atticus loses money on any model error

---

## 8. Bottom line

> **The product is profoundly profitable for both sides. Joint surplus
> is ~$6,000 per pair-life (~$300k per pair-year). The pricing decision
> is purely about how that surplus splits between Atticus and Foxify.
> Atticus's V3-A pricing kept 92% — that's why Foxify rejected. Going
> down to Option C or E moves the split to 13-22% Atticus / 78-87%
> Foxify, which is consistent with Foxify being the volume-bringer
> and Atticus being the enabler. Volume rebates let Foxify earn even
> tighter pricing as they scale, without breaching Atticus's per-band
> breakeven floors.**
>
> Open with Option C. Trade volume commitments for Option E. Walk if
> they push below $236/side calm or $346/side mod (the per-band
> floors).
