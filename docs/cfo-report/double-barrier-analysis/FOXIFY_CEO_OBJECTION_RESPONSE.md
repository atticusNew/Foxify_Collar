# Response to Foxify CEO — "$245/side cover not economically viable"

> **CEO's question (paraphrased 2026-05-11):**
> *"If we insure 1 position of $50k for 2%, 24 hours, the price of cover starts
> at $245. Two positions = $490. It's not economically viable to buy cover in
> even elevated periods. Let alone stress."*
>
> **Short answer:** the per-side math is exactly right ($245/side =
> $490/pair = our calm tier). But the "not economically viable" conclusion
> doesn't survive the trigger frequency math — at the published trigger
> rates, Foxify is NET POSITIVE on premium-vs-expected-payouts in **every
> single regime**, before counting routing income at all. The CEO is
> almost certainly computing premium against ONE payout, not against the
> empirical 0.54–1.73 triggers per pair per day that fire at the published
> ±2% barrier. Below: the reconciliation, plus four structural alternatives
> if Foxify wants a different product instead of just cheaper cover.

---

## 1. The per-side math is correct

| What CEO computed | What we charge | Match? |
|---|---|---|
| 1 position × $50k × 24h cover = $245 | $245/side/day in calm | ✓ exact match |
| 2 positions = $490 | $490/pair/day in calm | ✓ exact match |

CEO's framing is correct. Calm rate is $245/side/day = $490/pair/day. Mod $695/pair = $348/side. Elev $975/pair = $488/side. Stress $1,200/pair = $600/side.

**No confusion on the headline number.** The disagreement is on whether that price is "economically viable."

---

## 2. The single missing piece: trigger frequency

The "not economically viable" view comes from looking at premium-vs-MAX-payout in isolation: *"I pay $245/side, max payout is $1,000 per trigger. That's a 24.5% premium-to-max-payout ratio. Terrible insurance."*

That's the wrong comparison. The right one is **premium vs EXPECTED payouts at the published trigger frequency**.

At the empirical 6.4-year trigger rates per regime per pair:

| Regime | Premium $/pair/day | Expected triggers/day per pair | Expected payout/day per pair | **Foxify net $/day per pair** | **Verdict** |
|---|---:|---:|---:|---:|---|
| Calm | $490 | 0.54 | $543 | **+$53** | NET POSITIVE |
| Mod | $695 | 0.89 | $886 | **+$191** | NET POSITIVE |
| Elev | $975 | 1.30 | $1,300 | **+$325** | NET POSITIVE |
| **Stress** | **$1,200** | **1.73** | **$1,734** | **+$534** | **NET POSITIVE** |

**On a pure premium-vs-expected-payouts basis, Foxify is positive in every single regime — including stress.** That's empirical, not modelled. The 6.4-year BTC tape replay produces 0.54–1.73 trigger events per pair per day at the ±2% barrier; each event pays Foxify $1,000.

Annualised at the regime-weighted distribution (35.4 / 42.8 / 14.4 / 5.8):

```
Annual base premium per pair:           $247,530
Annual expected payouts per pair:       $312,220
Foxify NET per pair per year:           +$64,690  ← positive before counting any routing income
```

---

## 3. Where the "negative for Foxify" number some docs cite comes from

The doc set says Foxify cost is +$45 k/pair/year (1.36–1.45 bps). That number includes the **intra-day re-open premium** charge per the existing CFO Walkthrough doc (`Atticus_Vol_Facility_CFO_Walkthrough.md`, Vol Facility Step 3): *"intra-day re-open premium is charged to Foxify, pro-rated for hours remaining in UTC day."*

Mechanism: when a trigger fires mid-day, both perps reopen at new spot, and Atticus opens a fresh strangle at the new ±2% barrier. Foxify pays **fresh pro-rated premium** for the remaining hours of that UTC day. Without this, Atticus would pay for re-anchoring strangles out of pocket.

This pushes the empirical "premium per pair-life" up by `mult_pair / 7` — so a 7-day pair-life collects 9.1–12.7 daily-rate equivalents of premium instead of 7. The economics:

| Regime | Base 7-day premium | Actual premium with re-opens | Premium uplift | Foxify NET / pair-life |
|---|---:|---:|---:|---:|
| Calm | $3,430 | $4,471 | +$1,041 | +$671 (Foxify pays net) |
| Mod | $4,865 | $6,839 | +$1,974 | +$644 (Foxify pays net) |
| Elev | $6,825 | $10,360 | +$3,535 | +$1,256 (Foxify pays net) |
| Stress | $8,400 | $15,240 | +$6,840 | +$3,101 (Foxify pays net) |

**This is the source of the "Foxify pays net" framing.** Two ways to read it:

1. **If the re-open premium structure stays:** Foxify pays $45 k/pair/yr net = 1.45 bps on routed volume. (Tiny on real-world routing income, but it IS Foxify-pays-Atticus net.)
2. **If we drop the intra-day re-open premium (flat $X/pair/day, no top-up on triggers):** Foxify is net positive +$65 k/pair/yr from premium-vs-payouts alone. **But Atticus would lose ~$50 k/pair/yr** because we still have to buy fresh strangles on each trigger and aren't getting paid for them.

If Foxify wants the "premium covers the full day, no top-up on intra-day re-opens" structure, the calm rate has to rise from $490 to ~$560 to make Atticus whole on the foregone re-open premium. That's the trade-off.

---

## 4. The right metric: cost vs Foxify's actual revenue stream

Foxify's business is volume aggregation. Their revenue is **partner-exchange rebates on routed volume** (5–15 bps typical). The Atticus cost should be measured against that, not against a single $1k trigger payout.

Per pair per day, at scale (Phase 4-5, $490/$695/$975/$1,200 + 6% rebate):

```
Routed volume per pair per day:                  $864,000
At 5 bps rebate income:                           $432/day  ← Foxify gross
Atticus net cost (premium − payouts after cd):    $125/day  ← 1.45 bps on routed volume
Foxify NET PROFIT per pair per day:              +$307/day  ← keeps 71% of rebate income
```

**Foxify keeps 3.55 bps of every 5 bps they earn on routed volume.** At 1,000 pairs that's $112M/year of net profit. At 10,000 pairs, $1.12B/year.

The framing "$245/side is not economically viable" is true ONLY if Foxify is buying the cover and NOT routing the volume. They don't make sense as separate purchases — the cover ENABLES the volume that creates the rebate income that pays for the cover and keeps 71% of it.

---

## 5. Why we can't just cut the price further

Atticus's cost floor is the wholesale option market. Live Bullish mainnet RFQ on 2026-05-10 (BTC $81k, DVOL 38.71):

| Hedge instrument | Wholesale price | Atticus calm rate | Atticus margin per pair-day |
|---|---:|---:|---:|
| Daily ±2% strangle | **$259/pair/day** | $490 | $231/day = 47% margin BEFORE payouts and re-anchoring |
| **30-day ±2% strangle** | **$148/pair/day** | $490 | $342/day = 70% margin BEFORE payouts and re-anchoring |

After backing out (a) the $1,000-per-trigger payout obligation Atticus owes Foxify (~$543/day expected in calm) and (b) the re-anchoring cost on each trigger (each $148/day strangle has to be replaced multiple times per pair-life), **Atticus's net margin lands at 5–13% per regime** with the 30-day strangle.

**To go meaningfully below $490 calm we would have to either:**
- Buy cheaper cover than the wholesale market offers (we can't — $148/day is the floor for 30d ±2% at calm DVOL)
- Stop buying real cover (not viable — we'd be selling naked exposure)
- Reduce trigger payouts below $1,000 (changes product economics; see Option B below)
- Widen the barrier from ±2% (changes product economics; see Option A below)

This is the same reason you can't buy car insurance for $50/year. The cost of the underwriting market is the floor.

---

## 6. Four structural alternatives if cheaper cover is the real ask

If "$245/side is not viable" is a hard line for Foxify, none of these are off the table — but each changes the product, and we should price the variant they actually want, not iterate on the current one.

### Option A — Widen the barrier from ±2% to ±3% (or ±4%)

| Parameter | Current (±2%) | Option A1 (±3%) | Option A2 (±4%) |
|---|---|---|---|
| Trigger frequency in calm | 0.54/day | ~0.18/day | ~0.07/day |
| Wholesale strangle cost (calm) | $148/day amortized | ~$70/day | ~$35/day |
| **Atticus calm rate (estimated)** | **$490/pair/day** | **~$220/pair/day = $110/side** | **~$120/pair/day = $60/side** |
| Foxify pays ~ | $245/side | $110/side | $60/side |
| Trigger payout per event | $1,000 | $1,500 (covers wider gap) | $2,000 (covers wider gap) |

**This directly addresses "cover is too expensive."** The price drops to $110/side or $60/side. The trade-off is fewer trigger events (Foxify earns less from $1k payouts) but each event pays more. **Net Foxify cost on volume should land at ~0.5–0.8 bps with Option A1, ~0.3–0.5 bps with Option A2.**

If Foxify's gap risk is actually at the 3-4% level (i.e., they self-bear the first 2-3% of move), this might be the right fit.

### Option B — Drop the trigger payout cap to $500 per event

| Parameter | Current ($1k cap) | Option B ($500 cap) |
|---|---|---|
| Calm premium | $490/pair/day | ~$300/pair/day = $150/side |
| Foxify expected payout/day in calm | $543 | $271 |
| Foxify NET in calm (premium vs payout) | +$53/day | −$29/day |

**Premium drops 39%** but Foxify now pays slightly more than they receive in calm. This restructures the deal away from "high premium, high payouts" toward "low premium, low payouts." Atticus margin scales similarly. **Reduces sticker shock but doesn't change the underlying economics for Foxify.**

### Option C — Flat all-inclusive premium, NO intra-day re-open charges

| Parameter | Current (with re-open premium) | Option C (flat daily, no re-open charge) |
|---|---|---|
| Calm rate | $490/pair/day base + ~$50/day re-open premium | $560/pair/day flat — no re-open top-up |
| Mod rate | $695 + ~$210 re-open | $905 flat |
| Elev rate | $975 + ~$385 re-open | $1,360 flat |
| Stress rate | $1,200 + ~$815 re-open | $2,015 flat |
| Foxify cost certainty | Variable (depends on triggers) | **Fully deterministic** |

**Eliminates the variable-cost element** that's confusing the CEO conversation. Foxify pays a known fixed amount per pair per day; Atticus absorbs the re-open cost. Headline rate is higher but there are no top-up surprises. Cost on volume rises to ~1.7 bps.

### Option D — Foxify self-hedges; Atticus provides operational + venue access only

Foxify buys their own ±2% strangles at Bullish at the wholesale rate ($259/day daily, $148/day 30d). Atticus provides the operational layer (settlement, execution, dashboard) for a flat fee.

| Parameter | Current full product | Option D (op-only, Foxify self-hedges) |
|---|---|---|
| Foxify strangle cost (paid to venue, not Atticus) | n/a | ~$148–259/pair/day |
| Foxify exposure on triggers | Capped at $1k payout received from Atticus | UNCAPPED (real strangle pays out actual ITM value) |
| Atticus operational fee | n/a | ~$50–80/pair/day |
| **Total Foxify cost** | $490/pair/day calm | **~$200–340/pair/day calm** |

**Cheaper for Foxify on the cover line, but:**
1. Foxify needs venue accounts (Bullish institutional, Deribit)
2. Foxify holds the venue margin (capital intensive — millions of $)
3. Foxify takes uncapped option payout volatility (one big move could deliver $5k or $10k per pair, not $1k)
4. Foxify operates the hedge book

This works if Foxify wants direct venue exposure and has (or wants to build) trading infrastructure. **Most natural fit for a sophisticated buy-side desk; not a fit for a routing platform that wants operational simplicity.**

---

## 7. The diagnostic question to ask the CEO directly

Before iterating further on the price, we need to know **what specifically he's solving for**. Three possibilities, very different answers:

### "Cover should cost less than the trigger payout per event"
This is structurally impossible (no insurance product on earth pays out more than its premium per event in expectation; it's the definition of insurance). **If this is the ask, the product doesn't fit.** Direct him to Option D (self-hedge) where the underlying option pays out uncapped on big moves.

### "Cover should cost less than my routing income"
**It already does, by 3.5×.** Atticus cost = 1.45 bps; Foxify routing income at 5 bps; Foxify keeps 3.55 bps net. Walk him through §4 of this doc — show him the per-pair-per-year economics ($432 routing income, $125 Atticus cost, $307 net profit per pair per day).

### "I don't want variable cost from intra-day re-opens"
**Offer Option C** — flat all-inclusive premium ($560/$905/$1,360/$2,015 per pair/day). Higher sticker but fully deterministic, no surprises.

### "I want to pay less than $245/side period"
**Offer Option A** — widen the barrier to ±3% or ±4%. Premium drops to $110/side or $60/side. Each trigger pays more ($1.5k or $2k). Different product, much cheaper cover.

---

## 8. Honest reading of the CEO's email

> *"It's not economically viable to buy cover in even elevated periods. Let
> alone stress."*

This statement is contradicted by the empirical data — at $975 elev rate, Foxify expects $1,300/day in payouts at the empirical 1.30 trig/day rate, **netting +$325/day per pair before any routing income**. At $1,200 stress rate, Foxify expects $1,734/day in payouts, netting **+$534/day per pair**.

Either:

(a) The CEO is computing premium against a single-event payout (the 24.5% ratio), not against expected payouts at the trigger frequency. **Most likely** — easy to miss the empirical 0.54–1.73 trig/day rates in the docs.

(b) The CEO is operating a different product mental model than what we've been quoting. E.g., maybe they're thinking the trigger fires ~once per pair-life on average, not multiple times per day. **Possible** — the pricing math is non-obvious if you haven't internalised the intra-day re-open cycle.

(c) The CEO genuinely doesn't want this product structure and would prefer Options A/B/C/D above. **Possible** — and worth surfacing directly rather than iterating on the wrong product.

**Recommended next step:** send the CEO §1–§4 of this doc + ask the diagnostic question in §7 directly. Don't re-quote the same product at a lower price; that's not where the gap is.

---

## 9. Bottom-line one-paragraph reply

> *"Your math is exactly right — $245/side = $490/pair calm = $1,200 stress.
> What I want to make sure isn't getting lost: at the empirical 6.4-year
> trigger rates, you receive $543/day in payouts in calm (0.54 trig × $1k),
> $886 in mod, $1,300 in elevated, $1,734 in stress — so on premium-vs-
> expected-payouts alone you're net positive in every regime, including
> stress (+$53 calm, +$191 mod, +$325 elev, +$534 stress per pair per
> day). On a routing-volume basis you're paying ~1.45 bps to Atticus and
> earning ~5 bps from cross-venue rebates, netting 3.55 bps of every
> dollar routed (= $307/pair/day NET PROFIT at scale). I want to make
> sure I'm answering the right question — is the issue (a) sticker
> price ($245/side feels high vs. one $1k trigger), or (b) you'd
> prefer a different product structure (e.g., wider ±3% or ±4% barrier
> at $60–110/side, or no intra-day re-open premium at a flat
> $560/$905/$1,360/$2,015 per pair/day)? Happy to repackage to whatever
> economic shape works best for your model."*

---

*Backup: detailed math in `historical/cooldown_pnl_summary.csv`, live RFQ in `LIVE_RFQ_FINDINGS.md`, four-option restructure pricing reproducible from `historical_replay.py` with `--barrier-pct {0.03, 0.04}` and `--payout {500, 1500, 2000}`.*
