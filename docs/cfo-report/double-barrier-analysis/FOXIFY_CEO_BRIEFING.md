# Atticus Volume Facility — Foxify CEO Briefing

> **Purpose:** clean, plain-English summary of the Atticus volume
> facility deal terms. Designed for a one-shot read by Foxify's CEO.
> No jargon. Numbers grounded in 6.4 years of real BTC data and a
> live Bullish mainnet quote run on May 10, 2026.

---

## 1. The deal in three sentences

Foxify generates routing volume by opening matched LONG/SHORT pairs on partner exchanges. Atticus provides bounded-risk protection on each pair: if BTC moves 2% in either direction, Atticus pays Foxify $1,000 (capped) and the pair re-anchors at new spot. Foxify pays Atticus a daily premium that scales with BTC volatility regime; the premium drops as Foxify's monthly volume grows.

---

## 2. Premium tiers — what Foxify pays Atticus

**Per pair per day, by BTC implied-volatility (DVOL) regime:**

| BTC regime (DVOL band) | Days per year | **Premium per pair per day** |
|---|---|---|
| Calm (DVOL < 50) | ~110 days | **$490** |
| Moderate (50–65) | ~132 days | **$605** |
| Elevated (65–80) | ~53 days | **$795** |
| Stress (≥80) | ~70 days | **$865** |

**On any given day, Foxify will see the rate that matches the published Deribit DVOL.** Foxify pays this rate per pair per day for as long as the pair is open. If a trigger fires mid-day, the rate is pro-rated for hours remaining. **No surprises** — the rate is fully determined by published market data.

---

## 3. Volume rebates — what scales discount the premium

**Calm tier ($490) never rebates** — it's already at the structural floor. **Moderate / Elevated / Stress tiers rebate** based on Foxify's prior-month volume:

| Foxify monthly volume | Rebate on Mod/Elev/Stress | Mod | Elev | Stress |
|---|---|---|---|---|
| 0–100 pair-days/month (Phase 1 launch) | **0%** | $605 | $795 | $865 |
| 100–500 / month | **2%** | $593 | $779 | $848 |
| 500–2,000 / month | **4%** | $581 | $763 | $830 |
| 2,000–10,000 / month | **6%** | $569 | $747 | $813 |
| **10,000+ / month** (Foxify-scale target) | **8%** | **$557** | **$731** | **$796** |

**Rebates are paid monthly on the prior month's volume** — not invoiced mid-month, not surprise-discounted. Foxify gets a clean monthly statement showing the rebate credit.

---

## 4. What Foxify earns at scale

Foxify's economics are driven by partner-exchange rebates on routed volume, **not** by the Atticus premium-vs-payout flow. Per pair at 2.16 triggers/day model:

```
Volume routed per pair per day:    $864,000
                       per year:   $315 million
```

**At 1,000 pairs (steady-state):** Foxify routes **$315 BILLION/year** of partner-exchange volume.

| Foxify scale | Atticus annual cost | Foxify routed volume | Atticus cost as % of volume |
|---|---|---|---|
| Phase 1 (4.3 pairs) | $183k | $1.36B | **0.014%** (1.4 bps) |
| Phase 2 (12.9 pairs) | $549k | $4.07B | 1.4 bps |
| Phase 3 (100 pairs) | $4.26M | $31.5B | 1.4 bps |
| Phase 4 (1,000 pairs) | **$42.6M** | **$315B** | 1.4 bps |
| Phase 5 (10,000 pairs) | **$426M** | **$3.15T** | 1.4 bps |

**Atticus is a fixed 1.4 bps cost on Foxify's routed volume.** Same as a tight exchange fee. Foxify's typical partner rebate income runs 3-10 bps on routed volume, leaving 1.6-8.6 bps of net operating margin.

**At 5 bps partner rebate (typical institutional rate) at 1,000 pairs:**
- Foxify gross: $158M
- Atticus cost: $42.6M
- **Foxify net: +$115M/year**

**At 10,000 pairs:**
- Foxify gross at 5 bps: $1.58B
- Atticus cost: $426M
- **Foxify net: +$1.15B/year**

---

## 5. Why it won't blow up — five concrete reasons

These are the structural protections that prevent runaway losses or surprise obligations on either side. Plain English.

### 5.1 Every payout is capped

Each trigger pays Foxify exactly $1,000. There is no scenario where Atticus owes Foxify $5k, $10k, or $50k on a single trigger — the cap is contractual. **Foxify always knows their maximum trigger income; Atticus always knows the maximum daily payout obligation.**

### 5.2 Atticus owns a real hedge for every pair

Atticus buys a real ±2% strangle at Bullish/Deribit/Falcon X for every active pair. When a trigger fires, the matching option leg is sold for cash that funds the $1,000 payout. **Atticus is not playing the trigger blind — every payout is backed by a real options position the venue confirms.**

### 5.3 Cooldown circuit breaker pauses new pairs in extreme conditions

If BTC's volatility spikes above DVOL 100 (rare crisis-level vol), or if trigger payouts in any 4-hour window exceed 25% of Atticus's available capital, the system **pauses new pair openings until conditions normalize** (typically 4 hours). Existing pairs continue paying out normally — Foxify is never stiffed on triggers that already fired. **The cooldown is the structural protection that lets Atticus quote tight pricing without exposure to runaway chop weeks.**

### 5.4 Real-time dashboard — Foxify sees everything Atticus sees

A dashboard exposes in real-time: Atticus capital utilization (green/yellow/red), cooldown active state, today's trigger count, today's running payouts, hedge book mark-to-market, and 24-hour drawdown vs expected. **There is no scenario where Foxify is blindsided** — the metrics are visible to Foxify ops the same moment they're computed on Atticus's side.

### 5.5 Historical replay — 6.4 years of real BTC including every crisis

The pricing has been validated against **2,328 real pair-life simulations** spanning 2020-2026, including:
- March 2020 COVID crash (40%+ drawdown, DVOL 150+)
- May 2021 China-ban cascade (33 triggers/pair-week)
- May-June 2022 Luna/UST collapse
- November 2022 FTX collapse
- March 2023 US banking crisis
- August 2024 yen-carry unwind

**Across all 2,328 simulations, with cooldown active in stress conditions, the platform was profitable in 73-100% of weeks per regime band. No simulation produced a "wipe-out" outcome.** The system is calibrated to absorb every crisis the BTC market has actually produced in modern history.

---

## 6. What Foxify is actually buying

Three things, in plain language:

1. **Bounded gap risk.** Without protection, your matched-pair gap risk forces you to size positions at maybe 1/5 of what you actually deploy. Atticus's protection is the **license to run $50M+/day of routed volume**.

2. **Operational simplification.** Atticus handles the hedge-book management, venue execution, settlement reconciliation, and cooldown logic. Foxify focuses on the perp-side strategy and partner relationships.

3. **Predictable cost.** The premium is determined by published DVOL — Foxify can compute their daily Atticus cost from market data five minutes before they open a pair. **Zero pricing surprises.**

---

## 7. Phased ramp — where Foxify and Atticus end up

| Phase | Timeline | Pair count | Volume / month | Atticus tier active |
|---|---|---|---|---|
| **Phase 1** (Pilot) | Month 1 | 4.3 average | ~30 pair-days | Base ($490/$605/$795/$865) |
| **Phase 2** (Validation) | Month 2-3 | 12.9 average | ~100 pair-days | 2% rebate active |
| **Phase 3** (Scale-up) | Month 4-6 | 50-100 | 1k-3k pair-days | 4-6% rebate active |
| **Phase 4** (Production) | Month 7-12 | 250-1,000 | 5k-30k pair-days | 6-8% rebate active |
| **Phase 5** (Foxify-scale) | Year 2+ | 1,000-10,000 | 30k-300k pair-days | Full 8% rebate active |

**Phase 1 launches at base pricing.** Each subsequent phase has a clear volume threshold that unlocks the next rebate tier. Foxify can audit their tier eligibility from their own routing data.

---

## 8. The four contractual safeguards (for the lawyers)

Standard institutional protections both sides need in writing:

1. **Counterparty credit cap.** Atticus's accumulated unsettled balance from Foxify is capped at $5M per 1,000 pairs of monthly volume. Force-settlement triggers if approached.

2. **Pair-count cap with override.** Atticus retains right to set the maximum simultaneously-open pairs based on capital. Foxify can request override; Atticus has unilateral denial.

3. **Pricing reset clause.** If Atticus monthly P&L drops more than 2σ below modeled expectation across any 30-day window, premium ladder reverts to the next-higher tier for the following month. Restored when back in band.

4. **Stress-regime pause clause.** If BTC DVOL ≥ 100 sustained for 24+ hours, Atticus has unilateral right to pause new pair openings for 12 hours pending desk review. Existing pairs continue normally.

---

## 9. Open items both sides need to align on before Phase 1 launch

These are decisions that need a clear answer before pair flow goes live:

| Item | Decision needed | Recommended default |
|---|---|---|
| Settlement timing | T+0 vs T+1 cash flow on net daily balance | T+1 with weekly netting |
| Volume commitment milestone | "X pair-days/month by Month Y" — written | 500 pair-days/month by Month 4 |
| Cooldown auto-firing | Automatic or desk-approved per fire | Automatic at the four T1-T4 thresholds |
| Pair-count Phase 1 cap | Hard cap during pilot | 12 pairs Phase 1; relax in Phase 2 |
| Volume reporting cadence | Daily / weekly / monthly | Weekly to both sides; monthly true-up + rebate calc |
| Insurance fund | 2.5% of aggregate notional in segregated account | Yes; reviewed quarterly |

---

## 10. The two-sentence summary

> **For 1.4 basis points on the volume Foxify routes to partner
> exchanges, Atticus provides bounded-risk protection that lets Foxify
> operate at $50M+/day notional. As Foxify scales to 10,000 pairs, that
> 1.4 bps cost ($426M/year) is paid out of Foxify's $1.58B/year of
> partner rebate income at 5-bps rebate rates — leaving Foxify with
> $1.15B/year of net operating margin and Atticus with $145M of annual
> P&L, both sides scaling together with structural safety mechanisms
> that have been validated against every BTC crisis of the past
> 6.4 years.**

---

## Appendix — FAQ-style answers to expected pushbacks

**Q: Why does Atticus charge more than the trigger payout?**
A: Atticus has to buy a real strangle at the venue to back every pair — that hedge has a cost ($75-$257 per pair per day, market-determined). Atticus's premium covers the hedge cost plus a 5-8% margin. Insurance is structurally a net cost to the buyer; Foxify's profit comes from the partner-rebate income, which is 3-10 bps on routed volume vs Atticus's 1.4 bps cost.

**Q: What if BTC crashes 30% in a day?**
A: Atticus's hedge book pays out 4-5× the trigger payouts on big directional moves (the hedge is uncapped on the upside; the trigger payout is capped at $1k). A one-way 4% move at 1,000 open pairs nets Atticus +$1M, not −$1M. The structural risk is sustained chop, not directional crashes — and cooldown handles sustained chop.

**Q: What if Atticus runs out of capital?**
A: The cooldown circuit breaker fires at 25% of capital being committed to recent payouts, well before exhaustion. New pair openings pause but existing pairs continue to pay normally. Capital reserves are sized to absorb the worst empirical week of the past 6.4 years (FTX November 2022) at the operating scale.

**Q: What if Foxify can't pay the monthly settlement?**
A: Counterparty credit cap (item #1 in §8) limits Atticus's exposure to Foxify's accumulated unpaid balance. If approached, an interim cash settlement is forced.

**Q: What if the Bullish/Deribit/Falcon X venues fail?**
A: Atticus diversifies hedge inventory across at least two venues by Phase 3. Insurance fund (#6 in §9) covers single-venue insolvency at the 2.5%-of-notional level.

**Q: What if DVOL data feed goes down?**
A: Fallback formula: 1.15 × trailing 30-day BTC realized vol (this is the empirical relationship from the 5-year DVOL/realized study). Both sides agree to this fallback in writing.

**Q: How is the "trigger" actually detected?**
A: Multi-source spot price aggregate (Coinbase + Kraken + Bullish + Deribit Index, median'd every 30 seconds). Single-venue gaming risk is eliminated.

**Q: What if our trigger frequency runs HIGHER than 2.16/day?**
A: Premium scales with DVOL band, so higher trigger frequency days come with higher premium tiers automatically. Atticus's economics stay tracked. Foxify's payout income also scales with trigger frequency, so neither side is caught flat-footed.

---

*End of briefing. Roughly 5-7 minutes to read in full.*
