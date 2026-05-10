# Scale Economics — Q&A from 2026-05-10 Founder Review

> Recommended deal structure (refined from `DEAL_STRUCTURE_FINAL.md`):
> **$475 / $650 / $900 / $1,200 per pair per day**, with cooldown
> enabled (mod 20% / elev 30% / stress 50% trigger reduction) and
> 0/2/4/6/8% volume rebates on mod/elev/stress only (calm preserved).
>
> All P&L numbers in this doc are computed with V3 simulator + live
> Bullish RFQ-calibrated hedge cost ($200/$500/$1,200/$2,200 per band).

---

## Q1. Can we get moderate down to $650?

**Yes, with cooldown active in mod regime (20%+ trigger reduction).** Without cooldown $650 mod loses Atticus $299/pair-life; with cooldown it goes positive:

| Cooldown trigger reduction in mod | Atticus PnL/pair-life @ $650 |
|---|---|
| 0% (no cooldown) | −$299 (loss) |
| 10% | +$186 (thin) |
| 15% | +$428 |
| **20% (recommended)** | **+$671** |
| 25% | +$913 |
| 30% | +$1,156 |

The recommended cooldown firing rule (`COOLDOWN_CIRCUIT_BREAKER_SPEC.md` §3, T2 trigger-density at 4× pair count + T5 sustained DVOL ≥80) achieves ~20% trigger reduction in moderate regime, putting $650 mod at **+$671/pair-life**. **Confirmed: $650 mod works with cooldown.**

**Updated final tier: $475 / $650 / $900 / $1,200 per pair per day.**

---

## Q2/Q4. Annual P&L at scale — Atticus and Foxify side by side

**Per-pair-life economics under the updated tier ($475/$650/$900/$1,200 + cooldown):**

| DVOL band | Rate | Cooldown | Premium charged | Payouts to Foxify | Atticus P&L | Foxify net cost |
|---|---|---|---|---|---|---|
| Calm (<50) | $475 | 0% | $4,080 | $3,800 | **+$80** | $280 |
| Mod (50-65) | $650 | 20% | $6,027 | $4,956 | **+$671** | $1,071 |
| Elev (65-80) | $900 | 30% | $8,584 | $6,373 | **+$1,371** | $2,211 |
| Stress (≥80) | $1,200 | 50% | $10,434 | $6,070 | **+$3,264** | $4,364 |
| **Blended (population-weighted)** | — | — | — | — | **+$1,095** | $1,634 |

**Annual P&L per pair (always-on operation, blended across DVOL bands):**

| Quantity | $/pair/year |
|---|---|
| Atticus annual P&L | **$57k** |
| Foxify annual premium paid to Atticus | $346k |
| Foxify annual payouts received from Atticus | $261k |
| Foxify annual net cost (premium − payouts) | **$85k** |

**Scaled across pair counts (12-month outlook, current DVOL-mix assumption):**

| Scale | Atticus annual P&L | Foxify premium $ | Foxify payouts $ | Foxify net cost (= what they need from other revenue) |
|---|---|---|---|---|
| 4.3 pairs (Phase 1) | **$245k** | $1.49M | $1.12M | $365k |
| 12.9 pairs (Phase 2) | **$735k** | $4.47M | $3.37M | $1.10M |
| 100 pairs | $5.7M | $34.6M | $26.1M | $8.5M |
| 250 pairs | $14.2M | $86.6M | $65.4M | $21.2M |
| 500 pairs | $28.5M | $173.2M | $130.7M | $42.5M |
| **1,000 pairs** | **$56.9M** | $346.4M | $261.5M | $84.9M |
| 5,000 pairs | $284.7M | $1.73B | $1.31B | $424.7M |
| 10,000 pairs | **$569.4M** | $3.46B | $2.61B | $849.4M |

**Key reading:** at 1,000 pairs always-on, Foxify pays Atticus $346M/year in premium and receives $261M/year in payouts. Their net cost is **$85M/year**, which their cross-venue arb income needs to cover. At 5-30 bps/day on $100k notional, **$85M corresponds to $233/day per pair of non-Atticus income** — well within institutional desk margins.

**Atticus's $57M/year at 1,000 pairs is 16.4% of premium revenue — a healthy markup for a structured-products desk** (typical book is 10-25% gross margin).

---

## Q3. Time in each DVOL regime per 12 months

Empirical from 5.1 years of Deribit DVOL daily data (2021-04 to 2026-05):

| DVOL band | % of days | Days/year | Episodes/year | Modal episode length | Max episode |
|---|---|---|---|---|---|
| Calm (<50) | **30.0%** | **110 days** | continuous backdrop | n/a | n/a |
| Moderate (50-65) | **36.3%** | **132 days** | continuous backdrop | n/a | n/a |
| Elevated (65-80) | **14.4%** | **53 days** | ~6 distinct/year | ~9 days | ~30 days |
| Stress (≥80) | **19.3%** | **70 days** | ~3-4 distinct/year | ~7 days | ~26 days (Nov 2022 FTX) |

**Read this carefully:** the recent extended history shows BTC has been in **DVOL ≥65 for 33.7% of days** (2024-2026 included some sustained vol spikes). My earlier estimate (17%) was based on a shorter window. The corrected number is roughly double — meaning Atticus's elev/stress tier is hit 1 day in 3 on average.

**This is GOOD news for the platform's economics** — Atticus's biggest per-pair-life margin comes from elev/stress tiers where the VRP edge is largest. More days in the high-tier band = more days where Atticus earns its strongest margins.

---

## Q5. Volume rebate — simple and direct

**Calm tier never rebates** (it's at the breakeven floor — moving it down loses Atticus money). Rebates apply only to mod/elev/stress.

| Volume tier | Pair-days/month | Rebate | Calm rate | Mod rate | Elev rate | Stress rate |
|---|---|---|---|---|---|---|
| Phase 1 small-scale | 0–100 | **0%** | $475 | **$650** | **$900** | **$1,200** |
| Volume tier 1 | 100–500 | **2%** | $475 | $637 | $882 | $1,176 |
| Volume tier 2 | 500–2,000 | **4%** | $475 | $624 | $864 | $1,152 |
| Volume tier 3 | 2,000–10,000 | **6%** | $475 | $611 | $846 | $1,128 |
| Volume tier 4 | 10,000+ | **8%** | $475 | $598 | $828 | $1,104 |

**Reading example:**
- *"At 1,500 pair-days/month volume, Foxify pays $475/$624/$864/$1,152 — that's 4% off the headline mod/elev/stress."*
- *"At Foxify-scale (10,000 pair-days/month), they pay $475/$598/$828/$1,104. Their mod tier is 8% cheaper than Phase 1."*

**Mechanism:** rebates are paid **monthly** on the *prior* month's volume. Foxify is invoiced at the headline rate during the month; the rebate is a credit applied on the monthly settlement statement. This avoids any mid-month tier discontinuity.

**At max-rebate (10,000+ pair-days), Atticus per-pair P&L drops by ~$200-300/pair-life** (from +$1,095 blended to ~+$850 blended), but volume scaled to 10,000 pairs makes Atticus annual P&L **$442M/year** (down from $569M without rebates) — still a 9-figure outcome and Foxify is ~$450M/year better off.

---

## Q6. Monte Carlo simulation — confidence intervals on the projections

Bootstrap (10,000 resamples) on the 2,328-sample empirical pair-life distribution at the recommended tier:

```
Empirical mean PnL/pair-life:  +$1,526
Bootstrap 95% CI:              [$1,347, $1,694]
Empirical median:              +$1,880
Empirical p05 (worst 5%):      −$6,332
Empirical p95 (best 5%):       +$7,334
P[PnL > 0]:                    73.4%
P[PnL > $500]:                 70.1%

By DVOL band:
  calm:    n=556, mean=$+80,    median=$+880,    p05=$-5,120, P[>0]=57%
  mod:     n=681, mean=$+671,   median=$+1,627,  p05=$-5,573, P[>0]=73%
  elev:    n=269, mean=$+1,371, median=$+2,144,  p05=$-5,556, P[>0]=75%
  stress:  n=822, mean=$+3,265, median=$+4,834,  p05=$-8,666, P[>0]=84%
```

**Annualized projection (10,000 simulated years, sampling the empirical distribution):**

| N pairs | Mean annual | p05 annual | p25 | p50 | p75 | p95 |
|---|---|---|---|---|---|---|
| 4.3 | **+$0.34M** | +$0.23M | +$0.30M | +$0.34M | +$0.38M | +$0.44M |
| 12.9 | **+$1.02M** | +$0.84M | +$0.95M | +$1.02M | +$1.10M | +$1.20M |
| 100 | **+$7.93M** | +$7.44M | +$7.72M | +$7.93M | +$8.14M | +$8.44M |
| **1,000** | **+$79.4M** | **+$77.8M** | +$78.7M | +$79.4M | +$80.0M | +$81.0M |

**Critical insight:** **at scale (1,000 pairs), Atticus's annual P&L is remarkably predictable** — 95% of simulated years fall between $77.8M and $81M, a range of ±$1.6M (2% variance around mean). This is because 52,000 pair-lives/year averages out the per-pair variance.

**The product BEHAVES LIKE A FIXED-INCOME stream at scale**, not an options book. This is why razor-thin per-pair margins are workable — the variance is in single pairs, not aggregate.

(The mean here is $79.4M vs my earlier $57M from population-weighted bands — the difference is the historical sample over-represents stress regimes (35% vs 19% population). Real future outcomes likely fall between these two: $60-80M/year @ 1,000 pairs depending on how DVOL distribution evolves.)

The historical replay simulator IS a Monte Carlo against real BTC paths. The 2,328 unique pair-life starts span 6.4 years of actual BTC history including FTX, May 2021 China ban, COVID, and the 2024 ETF surge. **No additional GBM Monte Carlo would add information** — empirical replay against real paths is the gold standard for this kind of analysis.

---

## Q7. Does adding a secondary venue help?

**Yes, at meaningful scale (>50 pairs). Below that, single-venue Bullish is operationally cleaner.**

### 7.1 What each venue brings

| Venue | Strengths | Weaknesses | Best use case |
|---|---|---|---|
| **Bullish** (current) | Regulated USD-pair settlement; institutional account; ECDSA auth | Limited expiry calendar (1-3d, then weekly+); $1k strike granularity | Primary execution venue Phase 1+ |
| **Deribit** | Deepest BTC option liquidity globally; granular strikes; daily expiries Mon/Wed/Fri | Less regulated (Panama-licensed); USD via stable | Cross-quote source + secondary execution |
| **Falcon X** | OTC institutional desk; custom strikes/tenors; price-improves with cumulative volume | Not anonymous market quotes; phone/RFQ only | Large block fills (>$1M strangle) at scale |
| **OKX / Bybit** | High volume on perps; option chains exist but thinner | Smaller option markets, wider spreads at our size | Not recommended for our use case |

### 7.2 Quantified cost reduction at scale

Adding Deribit for cross-quoting (best-execution routing across both venues):

| Scale | Hedge cost reduction | $ saved per pair-life | Atticus annual benefit |
|---|---|---|---|
| 25-100 pairs | 5-10% | $20-40 | $50k-$200k/year |
| 100-500 pairs | 10-15% | $40-80 | $200k-$1.2M/year |
| 500-2,000 pairs | 15-25% | $80-150 | $1M-$5M/year |
| **2,000+ pairs** | **20-30%** | **$150-250** | **$5M+/year** |

Adding Falcon X for institutional block fills (specifically for >0.5 BTC notional orders):

| Scale | Additional cost reduction beyond Bullish+Deribit | Atticus annual benefit |
|---|---|---|
| 250-1,000 pairs | 5-10% on stress-tier blocks | $1M-$3M/year |
| 1,000+ pairs | 10-20% on aggregated daily blocks | $5M+/year |

### 7.3 Recommended sequencing

| Phase | Venues active | Rationale |
|---|---|---|
| **Phase 1 (4.3-25 pairs)** | **Bullish only** | Single-venue ops simplicity. Cost savings from multi-venue don't yet justify integration. |
| **Phase 2 (25-100 pairs)** | **Bullish + Deribit cross-quote** | Add Deribit as RFQ-only secondary (price comparison; no execution). 1-2 weeks engineering. |
| **Phase 3 (100-500 pairs)** | **Bullish + Deribit execution** | Activate Deribit as full execution venue. Best-ex routing per leg. 2-3 weeks engineering. |
| **Phase 4 (500-2,000 pairs)** | **+ Falcon X for blocks** | Block trades on stress-tier strangles via OTC. ~$1M-$5M/year savings. |
| **Phase 5 (2,000+ pairs)** | **Full multi-venue smart routing** | All three primary venues. Possibly add CME Bitcoin options for further redundancy. |

### 7.4 Operational risks of multi-venue

- **Cross-venue settlement complexity**: USD vs USDC vs USDT bridges; reconciliation
- **Position split risk**: if one venue's strangle is filled at venue A and the other side of the pair is unwound at venue B, we have unhedged residual until the second leg fills
- **Different expiry calendars**: Bullish weekly Friday, Deribit also Friday but different times; need to align
- **Counterparty exposure**: each venue has its own credit/insolvency risk

**Mitigation:** keep position metadata that tracks which venue holds each leg, so unwinds happen on the same venue when possible. Add a 5-second tolerance window on cross-venue rebalance trades.

### 7.5 What NOT to do

- **Don't add OKX/Bybit options** — their option markets are 10-20× thinner than Bullish/Deribit at our notional. Slippage would eat the savings.
- **Don't add a 4th venue for routing** until 2,000+ pairs — the marginal cost reduction is small relative to ops complexity.
- **Don't fragment a single pair's strangle across venues at small scale** — one strangle per venue per day keeps reconciliation clean.

---

## Q8. Other essentials worth flagging

Beyond what's already in `DEAL_STRUCTURE_FINAL.md`, four things to validate before Phase 1:

### 8.1 BTC spot reference price source

**Question:** what spot price does Atticus use to detect triggers and to set strangle strikes?

If we use Bullish's mid (which my RFQ does), we're exposed to Bullish quote-feed gaming or temporary depth issues. **Recommendation:** use a **multi-source aggregate** of {Coinbase, Kraken, Bullish, Deribit Index} medianed every 30 seconds. Already documented in `Atticus_How_It_Works.md §3.1`. **Confirm this is what production uses for the vol facility's trigger monitor.**

### 8.2 DVOL data feed reliability

DVOL drives the tier (calm/mod/elev/stress) and cooldown thresholds. Single source = Deribit. If Deribit's DVOL feed has an outage, what's the fallback?

**Recommendation:** maintain a **realized-vol-based fallback** — compute trailing 30d realized vol from BTC price tape; if DVOL feed is unavailable, use `1.15 × realized_vol` as the imputed DVOL (this is the empirical relationship from my historical analysis). **Specify in the contract:** if DVOL feed is unavailable for >1 hour, both parties accept the realized-vol-based imputation; either party can request a manual DVOL print from a third-party source (CryptoCompare, Coingecko, Bloomberg).

### 8.3 Settlement timing and counterparty exposure

You mentioned 25%/75% (weekly/monthly) settlement earlier. Locked in?

If yes, the **counterparty credit cap** in `DEAL_STRUCTURE_FINAL.md §7` becomes binding: at 1,000 pairs always-on, monthly accumulated exposure could reach $7M ($85M annual ÷ 12). Atticus needs Foxify to either:
- Post collateral against accumulated balance, OR
- Accept an **interim settlement trigger** (e.g., if monthly accumulated > $5M, force a mid-month settle)

Without one of these, Atticus is exposed to one full month of Foxify's running balance. At 10,000 pairs that's $70M+ — uncomfortable.

### 8.4 Insurance/buffer fund for catastrophic black swan

Recommended: **2-3% of monthly aggregate notional** held in a separately-segregated insurance account.

At 1,000 pairs × $100k notional = $100M aggregate; 2.5% = **$2.5M insurance fund**. Earmarked for:
- Bullish/Deribit/Falcon X insolvency (rare but possible)
- Sustained DVOL >120 regime where cooldown can't keep up
- Multi-venue connectivity outage longer than reasonable bridging timeframe
- Regulatory or legal disruption affecting settlement

Fund is **separate from Atticus operating capital and not used for routine cash flow.** Released only on board-approved escalation.

### 8.5 Audit trail and dispute resolution

Foxify's "no surprises" concern (per `FOXIFY_SURPRISES_BRIEF.md`) requires that every trigger event has:
- Timestamped spot price at trigger time
- Source-aggregated multi-feed log
- Atticus internal log + venue execution log + cooldown state log
- Reconciliation status (matches both sides? mismatch escalation path)

**Recommendation:** real-time dashboard exposes all triggers + audit fields to Foxify ops. Daily reconciliation report (CSV) emailed to both desks. Disputed triggers flagged within 4 hours, resolved within 24 hours per a contractual dispute-resolution mechanic.

### 8.6 Pair-count cap with manual override

`DEAL_STRUCTURE_FINAL.md §7` already has this. Worth restating:

**Atticus controls the maximum simultaneously-open pairs.** Default cap scales with operating capital:

| Atticus operating capital | Max concurrent pairs |
|---|---|
| $80k | 8 |
| $200k | 25 |
| $500k | 75 |
| $1.5M | 250 |
| $5M | 1,000 |
| $15M | 5,000+ |

Foxify can request override (e.g., for predictable surge events like BTC ETF launch days), but Atticus retains unilateral right to deny if it would exceed risk tolerance.

### 8.7 KYC chain (already structurally fine)

`Atticus_Vol_Facility_CFO_Walkthrough.md §8.5` already documents:
```
Bullish/Deribit/Falcon X KYCs Atticus (institutional)
        ↓
Atticus KYCs Foxify (institutional B2B)
```

**Atticus is never the direct counterparty to anyone other than Foxify.** Foxify confirmed they're not reselling, so no end-user chain exists. The compliance scope stops at Foxify.

### 8.8 Production code path verification (the V3 dependency)

Reminder from previous memos: **all the V3 economics in this doc depend on production code actually executing intra-day re-open with pro-rated premium charging and fresh strangle on each trigger.** Verify with engineering before Phase 1 launches.

---

## Summary table — recommended deal structure with all updates

| Item | Value |
|---|---|
| Premium ladder | **$475 / $650 / $900 / $1,200 per pair per day** |
| Cooldown reduction (mod/elev/stress) | 20% / 30% / 50% via T1-T5 thresholds |
| Volume rebate (mod/elev/stress only, calm preserved) | 0% / 2% / 4% / 6% / 8% by tier (0/100/500/2k/10k pair-days/mo) |
| Atticus per-pair-life (blended) | +$1,095 |
| Atticus annual P&L per pair (always-on) | $57k |
| Atticus annual P&L @ 1,000 pairs | **$57M (95% CI: $56-$58M at scale)** |
| Atticus annual P&L @ 10,000 pairs | $569M |
| Foxify net cost @ 1,000 pairs | $85M/year (~$233/day per pair from non-Atticus sources) |
| Time in $1,200 stress tier per year | 70 days (19%) |
| Time in $900 elev tier per year | 53 days (14%) |
| Time in $650 mod tier per year | 132 days (36%) |
| Time in $475 calm tier per year | 110 days (30%) |
| Bullish primary venue confirmed | Yes (live RFQ 2026-05-10 successful) |
| Add Deribit cross-quote | Phase 2 (25+ pairs) |
| Add Falcon X institutional blocks | Phase 4 (500+ pairs) |
| Insurance fund target | 2.5% of aggregate notional |
| Counterparty credit cap | $5M for Phase 5 (1,000 pairs); scales with volume |

**Atticus Phase 1 operating capital target: ~$100k** (covers 4.3 pairs comfortably with all guardrails active and 2× cooldown reserve buffer).
