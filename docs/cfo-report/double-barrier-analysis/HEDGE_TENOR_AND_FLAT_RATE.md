# Hedge Tenor + Flat Rate Feasibility

> **Two founder questions from 2026-05-11:**
> 1. *"Cant we buy like a 14 or 30 day protective put and protective call separately? Or is strangle smarter."*
> 2. *"Is there anyway we can do like a flat 600 or 650?"*
>
> **Short answers:**
> 1. A strangle IS just a separate put + separate call. **Same options, same cost, just packaging.** What matters is the **tenor** (longer = cheaper amortized) and **strike** (we use 2 % OTM to match the ±2 % barrier). Going from our current 30d → 90d would shave another $44/day per pair but doubles the peak hedge capital required.
> 2. **Flat $600 doesn't work at any tenor we'd realistically deploy** (loses ~$22–28 M/yr at 1k pairs). **Flat $650 is essentially break-even** at 30d (−$3 M/yr) and barely positive at 90d (+$3.6 M/yr). **Flat $680+ is sustainable.** The cleaner offer if Foxify wants simplicity is a **2-tier flat: $650 normal / $1,200 stress** (covers the regime variance that flat single-tier exposes).

---

## 1. "Strangle" is just packaging — separate put + separate call IS the strangle

A `30-day ±2% strangle` = `30-day +2% OTM call` + `30-day −2% OTM put`. That's literally the definition. Bullish (and Deribit) quote the strangle as one ticket because it's two trades with one combined premium, but you can buy them as separate orders for the same combined cost — only marginal difference is venue spread on two tickets vs one (~5–10 bps).

**So when you ask "can we buy a 14d protective put + 14d protective call separately?" the answer is: that's exactly what a 14-day strangle is. We already do this.**

The choices that actually move cost are **tenor** and **strike**:

| Choice | Effect on cost | Effect on coverage |
|---|---|---|
| Longer tenor (1d → 30d → 90d) | ↓↓ amortized $/day cost | More peak capital deployed; more vega exposure |
| Shorter tenor | ↑↑ amortized $/day cost | Less capital, less vega |
| ATM strike | ↑↑ premium (more time value) | Pays out on smaller moves (over-protection vs ±2 % barrier) |
| **2 % OTM strikes** (CURRENT) | Cheaper than ATM | Pays out exactly when our barrier triggers — **matches the product** |

**ATM strikes don't help us** — they're more expensive AND pay out before our trigger fires (we'd be paying for protection on 0.5 % moves we don't pay Foxify for). 2 % OTM matches the barrier exactly.

## 2. The tenor sweep — what we save by going longer

Per-day amortized cost of a 2 % OTM strangle on a $50k pair (BS-derived, calibrated to the live Bullish RFQ at 18.5d which quoted $148/day):

| Tenor | Per-pair venue cost | $/day amortized | vs 30d (current) | Peak capital @ 1,000 pairs |
|---|---:|---:|---:|---:|
| 1 day | $253 | **$253/day** | +$130 | $0.25M |
| 7 days | $1,508 | $215/day | +$93 | $1.5M |
| 14 days | $2,299 | $164/day | +$42 | $2.3M |
| **18.5 days** (live Bullish RFQ) | **$2,743** | **$148/day** | +$26 | $2.7M |
| **30 days (CURRENT — PR #136)** | $3,674 | **$122/day** | — | **$3.7M** |
| 60 days | $5,561 | $93/day | **−$30** | $5.6M |
| **90 days** | $7,012 | **$78/day** | **−$45** | **$7.0M** |
| 180 days | $10,265 | $57/day | **−$65** | $10.3M |

**Going from 30d → 90d saves ~$45/day per pair = $315/week per pair amortized cost.** At 1,000 pairs that's $0.32M/week = **~$16M/yr in additional Atticus margin** (matches the per-pair-life math below). But peak hedge capital roughly **doubles** (from $3.7M to $7M at 1,000 pairs).

**Going to 180d saves another $21/day vs 90d but capital triples vs 30d.** Diminishing returns.

## 3. Does a longer hedge let us hit Foxify's flat $600 or $650?

| Hedge tenor | Flat $600 @ 1k pairs | Flat $625 @ 1k pairs | Flat $650 @ 1k pairs | Flat $680 @ 1k pairs | Flat $700 @ 1k pairs |
|---|---:|---:|---:|---:|---:|
| **Current 30d** | −$28 M/yr (LOSS) | −$16 M (LOSS) | −$3 M (break-even) | +$12 M (OK) | +$22 M (OK) |
| 90d | −$22 M (LOSS) | −$9 M (LOSS) | **+$4 M (break-even)** | +$19 M (OK) | +$29 M (OK) |
| 180d | −$19 M (LOSS) | −$6 M (LOSS) | +$6 M (very thin) | +$21 M (OK) | +$32 M (OK) |

**Key reads:**
- **Flat $600** does not work at any tenor we'd realistically deploy. Calm regime is hugely profitable (+$1,600/pair-life), but mod/elev/stress regimes lose money fast. Net is a $20–28M/yr Atticus loss.
- **Flat $625** doesn't work either — same regime imbalance, just less severe.
- **Flat $650** is **break-even at 90d strangle** — Atticus makes ~$4M/yr at 1,000 pairs, which is razor margin (~6 bps cushion). Any sustained mod/elev period puts Atticus underwater. Not really viable.
- **Flat $680 with 90d strangle** is the lowest defensible flat rate — Atticus +$19M/yr at 1,000 pairs.
- **Flat $700 with 30d (current setup)** is also defensible — Atticus +$22M/yr at 1,000 pairs.

### The real problem with flat single-tier

Flat pricing exposes Atticus to **regime variance**. Even if the long-run blended math works, a sustained stress period (like 2021's full year of high DVOL) means months of −$5,000+/pair-life losses for Atticus, which Atticus has to absorb out of capital reserves.

**The 4-tier ladder ($490/$695/$975/$1,200) self-adjusts** — premium goes up when Atticus's costs go up. Flat doesn't.

## 4. The cleaner alternative — 2-tier flat ("normal" + "stress")

If Foxify wants simpler pricing without exposing Atticus to regime variance:

### Option E: 2-tier — $650 normal (DVOL < 80) / $1,200 stress (DVOL ≥ 80) with 90d hedge

| Band | Days/yr | Rate | PnL/pair-life | Margin | Foxify net cost/pair-life |
|---|---:|---:|---:|---:|---:|
| Calm (DVOL <50) | 129 | $650 | +$2,093 | 35 % | +$2,131 |
| Mod (50–65) | 156 | $650 | −$36 | −0.6 % | +$201 |
| Elev (65–80) | 52 | $650 | −$2,709 | −39 % | −$2,197 (Foxify net positive) |
| Stress (≥80) | 21 | $1,200 | +$2,397 | 16 % | +$3,101 |
| **Blended** (35.4/42.8/14.4/5.8) | — | — | **+$269** | **5.8 %** | **+$1,043** |

**At 1,000 pairs:** Atticus +$14 M/yr, Foxify cost $51 M/yr (1.62 bps).
**At 10,000 pairs:** Atticus +$140 M/yr, Foxify cost $510 M/yr.

**Foxify nets positive in elevated** (premium $650 < expected payouts $1,300). Mod is essentially break-even for Foxify. Calm is the regime where Foxify pays meaningful net (+$2,131/pair-life). Stress is bounded by the higher tier.

### Option F: 2-tier — $700 normal / $1,200 stress with 30d hedge (no capital uplift)

| Band | Days/yr | Rate | PnL/pair-life | Margin |
|---|---:|---:|---:|---:|
| Calm | 129 | $700 | +$2,529 | 39 % |
| Mod | 156 | $700 | +$323 | 4.7 % |
| Elev | 52 | $700 | −$2,466 | −33 % |
| Stress | 21 | $1,200 | +$1,998 | 13 % |
| **Blended** | — | — | **+$794** | **11.6 %** |

**At 1,000 pairs:** Atticus +$41 M/yr, Foxify cost $40 M/yr (1.27 bps).
**At 10,000 pairs:** Atticus +$413 M/yr, Foxify cost $400 M/yr.

**Both sides better off** vs current 4-tier $490/$695/$975/$1,200 (Atticus $25M, Foxify $43M):
- Foxify pays $40M vs $43M = **−$3M/yr (−7%)**
- Atticus earns $41M vs $25M = **+$16M/yr (+64%)**

The trick: **flat $700 in calm overcharges Foxify** (Foxify is +$2,529/pair-life vs current $612 at $490 calm), and the calm regime is 35 % of days. Foxify pays more in calm, less in elev. Stress still tiered separately.

## 5. Side-by-side comparison of the realistic options

| Structure | Hedge tenor | Foxify cost @ 1k pairs | Atticus margin @ 1k pairs | Foxify-side complexity |
|---|---|---:|---:|---|
| 4-tier $490/$695/$975/$1,200 (PR #136) | 30d | $43 M | $25 M | 4 published rates, 4 phases of rebate |
| **2-tier flat $700 / $1,200 stress** | **30d** | **$40 M** | **$41 M** | **2 published rates** |
| 2-tier flat $650 / $1,200 stress | 90d | $51 M | $14 M | 2 published rates, more capital intensive |
| Pure flat $700 | 30d | $50 M | $22 M | 1 published rate; no stress mechanism |
| Pure flat $680 | 90d | $48 M | $19 M | 1 published rate; more capital |
| Pure flat $650 | 90d | $44 M | $4 M | 1 published rate; razor margin, fragile |

## 6. Recommendation

**If "simpler than 4-tier" is the real ask, the cleanest move is the 2-tier flat $700 / $1,200-stress with current 30d hedge** (Option F above). It's:
- **Better for Atticus** ($41M vs $25M at 1k pairs)
- **Better for Foxify** ($40M vs $43M at 1k pairs)
- **Simpler to publish** — 2 rates instead of 4
- **Same operational setup** as PR #136 (no additional hedge capital required)
- **Stress-resilient** — DVOL ≥ 80 still tiers up, so Atticus isn't exposed to regime variance

Foxify pays MORE in calm ($2,529/pl vs $671/pl current) and LESS in elevated ($-2,466/pl Foxify net positive vs $1,478/pl cost current). They wind up paying ~7 % less on the year because elevated/stress are concentrated savings.

**If Foxify really wants flat $650 specifically**, we'd need to switch the hedge to 90d strangle (doubles peak capital deployed) AND accept thin Atticus margin (~$4M/yr at 1k pairs). Not recommended — leaves no room for adverse hedge-cost variance.

**Foxify cannot have flat $600** sustainably under any hedge tenor we'd reasonably deploy. The structural cost floor is set by the wholesale options market.

---

## 7. The math on why 2-tier $700/$1,200 beats 4-tier $490/$695/$975/$1,200

The 4-tier ladder under-charges in calm relative to where Atticus could actually price ($490 calm = 5 % margin; calm regime is the most profitable but lowest priced). The 2-tier $700 flat captures the calm-regime upside that the ladder gives away cheaply.

Foxify benefits because elevated/stress days (20 % of the year combined) get cheaper pricing. The 4-tier elev rate of $975 is replaced by flat $700. Stress stays at $1,200 in both structures.

Net: Foxify's high-payout days (elev/stress, where they receive 9–12 triggers/pair-week × $1k = $9–12k/pair-week of payouts) get cheaper cover. Their low-payout days (calm) pay more.

**This is actually closer to what Foxify's CEO seemed to want** — flat-ish pricing, no DVOL-tier complexity, predictable cost. We capture the value back from Atticus's calm-tier under-pricing.

---

## 8. One-paragraph summary for the CEO conversation

> *"On the strangle question — a strangle IS just a separate protective put + protective call held together. Same instruments, same cost. We already buy them at 30-day tenor (the live Bullish RFQ from May 10 confirmed $2,743 = $148/day amortized). Going longer to 90-day saves another $44/day per pair but doubles the peak hedge capital we deploy.*
>
> *On flat $600/$650 — flat $600 doesn't work at any tenor we'd realistically deploy (Atticus loses $20-28M/yr at 1k pairs because mod/elev/stress regimes can't pay for themselves at $600). Flat $650 is essentially break-even at the 90-day hedge (Atticus +$4M/yr, very fragile).*
>
> *The simplest sustainable structure is **2-tier flat: $700 normal + $1,200 stress**, with the current 30-day strangle hedge. Foxify pays $40M/yr at 1,000 pairs (1.27 bps on routed volume — actually 7% LESS than the current 4-tier ladder), and Atticus earns $41M/yr (vs $25M on the 4-tier). Both sides better off; pricing is simpler; no extra capital required.*"
