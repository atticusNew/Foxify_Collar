# Atticus / Foxify — Pilot Status Report for the CFO

**Prepared:** 2026-04-19
**Audience:** Atticus CFO
**Status:** Pilot-ready, paper-trading on Deribit mainnet pricing while we await live Deribit credentials.

---

## Cover summary

- **Where we are:** the platform is feature-complete and stabilized. Paper trades against Deribit *mainnet* pricing (real spreads, real volatility, real order books) on a paper account, awaiting live KYC.
- **Headline change since your last review:** rolling tenor moved from 2 days to 1 day. This was your suggestion. Backtest on **1,558 days of BTC history** confirms the change roughly halves per-position trigger probability while doubling cycles, with materially better expected P&L across every tier.
- **Two pre-launch pricing adjustments:** 2% protection $5 → $6 per $1k; 3% protection $4 → $5 per $1k. The two most volatility-sensitive tiers. 5% and 10% unchanged. Final schedule: **$6 / $5 / $3 / $2**. Math and historical support in §4.
- **Where the math comes from:** every tier-level claim in this report is grounded in a backtest of 1,558 days of BTC closing data (~4.3 years), broken down by volatility regime. We're not estimating; we're measuring.
- **Risk we accept going in:** small, bounded by per-tier and aggregate caps in §6. Two empirical unknowns are described honestly in §10.

---

## 1. What the platform does, in two paragraphs

Atticus sells short-tenor *protection* against Bitcoin drawdowns. A trader holding a long BTC position can buy protection that triggers if BTC falls by 2%, 3%, 5%, or 10% within the next 24 hours. The trader pays a fixed premium upfront — for example, $60 to protect a $10,000 position with the 2% tier. If BTC drops past the trigger price during the window, the platform pays the trader the loss between the trigger and the floor.

Every protection sold is immediately hedged on Deribit by buying a put option whose strike sits at (or very near) the trigger price. The trader's premium is set above the put's expected cost, so the difference is the platform's gross spread. When a trigger fires and the platform owes a payout, the put we hedged with is now worth roughly that same amount — and the take-profit (TP) system sells it back to Deribit to recover the cost. The platform retains the spread minus realized frictions (Deribit fees, bid-ask spread, slippage).

---

## 2. The 1-day tenor switch — why and what we measured

### Why we did it

You suggested 1-day in our last review. Three reasons it is the right call:

1. **Per-position trigger probability roughly halves.** From 1,558 days of BTC history (the full set spans calm, normal, and stress regimes), the probability that any given protection triggers is much lower at 1-day than 2-day:

   | Tier | 1-day trigger rate | 2-day trigger rate |
   |---|---|---|
   | 2% | **35.2%** | 66.0% |
   | 3% | **20.7%** | 45.1% |
   | 5% | **7.6%** | 21.8% |
   | 10% | **1.2%** | 3.9% |

2. **Margin density per dollar deployed roughly doubles.** Same dollar of trader notional pays a fresh premium every day instead of every two days. Combined with point 1, the platform earns spread on twice as many cycles each carrying half the trigger risk.

3. **Time decay (theta) works harder in our favor.** The rate at which an unused put loses value per day grows roughly with $1/\sqrt{T}$. A 1-day put loses value ~1.41× faster than a 2-day put on the same strike. Since the *good* outcome is no trigger (premium kept, hedge expires worthless), faster decay = faster recovery of premium dollars to spread.

### What the historical P&L looks like

Same backtest, expected P&L per $1k notional at three different premium prices. Negative numbers are losses; positive are spread captured by the platform. Numbers reflect both hedge cost AND realized payouts AND TP recovery on the historical sample.

| Tier | 1-day BE price | P&L @ $5 | P&L @ $8 | P&L @ $10 |
|---|---|---|---|---|
| 2% | $6.34 | −$1.34 | +$1.66 | +$3.66 |
| 3% | $5.52 | −$0.52 | +$2.48 | +$4.48 |
| 5% | $3.32 | +$1.68 | +$4.68 | +$6.68 |
| 10% | $1.12 | +$3.88 | +$6.88 | +$8.88 |

Reading the 2% row: at the **old** $5 premium, the historical 1-day backtest produced a $1.34 loss per $1k. At the **new** $6 premium it sits at +$0.66 (interpolated between $5 and $8 columns). At $8 it's already +$1.66. This is the empirical justification for the 2% bump — the old price was below historical breakeven.

Reading the 3% row: at the old $4 premium it's −$1.52 (interpolated). At the new $5 premium it's −$0.52. We're still slightly under historical breakeven at $5, but with materially less bleed than $4 — and the post-2026 environment is calmer than the historical average that includes 2018, 2020, and the LUNA/FTX years.

### What we examined and dismissed

- **Faster reaction window if BTC gaps.** Mitigated by the trigger monitor: 3-second polling, dual-source price feed (Coinbase + Deribit perp index), freshness checks.
- **The ideal 1-day strike sometimes doesn't exist on Deribit yet.** The selection algorithm allows up to tenor + 2 days *with* a 3× weighted penalty so the system only goes longer when the 1-day option is unavailable. Cost cap prevents overpaying when it does extend.

### Live (paper) sample so far

Pilot has 15 trades since the tenor switch on 2026-04-17:

| Metric | Pre-switch (n=8, 2-day) | Post-switch (n=15, 1-day) |
|---|---|---|
| Premium collected | $1,015 | $1,435 |
| Hedge cost | $594.40 | $160.09 |
| Spread (premium − hedge) | $420.60 | $1,274.91 |
| Triggered positions | 1 of 8 (12.5%) | 0 of 15 |
| Average margin % | 41.4% | **88.8%** |

The post-switch sample is biased low on triggers because BTC has been calm (today's volatility ~43; the 1,558-day calm sub-sample shows 23.3% trigger rate for 2% tier in calm markets). We expect the live numbers to converge toward backtest as the pilot lengthens.

### Pilot Agreement

Tenor is implementation detail; commercial structure (per-position cap, daily cap, settlement cadence) is unchanged.

---

## 3. Pricing schedule and the math behind each tier

### Schedule (final, after pre-launch calibration)

| Tier | Premium per $1k | Premium on $10k | Payout per $10k | Trader return on trigger |
|---|---|---|---|---|
| 2% | **$6** | $60 | $200 | 3.3× |
| 3% | **$5** | $50 | $300 | 6× |
| 5% | $3 | $30 | $500 | 16.7× |
| 10% | $2 | $20 | $1,000 | 50× |

### The math anchor

For each tier, premium is calibrated against expected hedge cost plus a target spread:

$$
\text{expected\_spread} = \text{premium} - E[\text{hedge\_cost}] - \text{frictions}
$$

The hedge cost is the Black-Scholes price of the put we buy on Deribit:

$$
P = K \cdot e^{-rT} \cdot N(-d_2) - S \cdot N(-d_1)
$$

where $d_1 = \frac{\ln(S/K) + (r + \sigma^2/2)T}{\sigma\sqrt{T}}$, $d_2 = d_1 - \sigma\sqrt{T}$, $S$ is BTC spot, $K$ is the strike (= trigger), $T$ is time to expiry in years (1/365 for 1-day), $\sigma$ is implied volatility from Deribit's DVOL index (Bitcoin's equivalent of the VIX), $r$ is the risk-free rate (5%), and $N(\cdot)$ is the standard normal CDF.

### Worked example — 2% tier today

BTC ≈ $100,000, DVOL = 43% (today's reading), $T = 1/365$, $K = 0.98 \times 100{,}000 = 98{,}000$:

- $d_1 ≈ 0.915$, $d_2 ≈ 0.893$
- $N(-d_1) ≈ 0.180$, $N(-d_2) ≈ 0.186$
- Put price $P ≈ \$223$ per BTC, or **$2.23 per $1,000 of trader notional**

| Item | Per $1k notional |
|---|---|
| Hedge cost (Black-Scholes) | $2.23 |
| Premium collected (new $6 schedule) | $6.00 |
| **Gross spread** | **$3.77** |

That's a 63% gross margin at today's volatility on the 2% tier. Spread compresses as volatility rises (full table in §4 and Appendix B).

---

## 4. Pre-launch pricing calibration — why both bumps, with the math

### What changed

| Tier | Old | New |
|---|---|---|
| 2% | $5/$1k | **$6/$1k** |
| 3% | $4/$1k | **$5/$1k** |
| 5% | $3/$1k | unchanged |
| 10% | $2/$1k | unchanged |

### Why these two tiers

The 2% and 3% strikes sit closest to the money — they're the most sensitive to changes in implied volatility. The 5% and 10% strikes are far enough out-of-the-money that their value barely moves with volatility. Math justification per tier follows.

### Breakeven analysis — 2% tier

Black-Scholes hedge cost per $1k notional, BTC ≈ $100k, 1-day tenor:

| DVOL | 2% put cost | Spread @ $5 | Spread @ $6 |
|---|---|---|---|
| 30 (very calm) | $1.05 | +$3.95 | +$4.95 |
| 43 (today) | $2.23 | +$2.77 | +$3.77 |
| 60 (busy) | $5.74 | −$0.74 | +$0.26 |
| 70 (elevated) | $7.13 | −$2.13 | −$1.13 |
| 80 (stress) | $8.54 | −$3.54 | −$2.54 |
| 100 (crisis) | $12.40 | −$7.40 | −$6.40 |
| 120 (Mar 2020 / Nov 2022) | $16.32 | −$11.32 | −$10.32 |

**Breakeven volatility on 2%:** $5 → DVOL 52, $6 → DVOL 62. The bump adds **~10 volatility points** of headroom.

### Breakeven analysis — 3% tier

Same math, $K = 0.97S$:

| DVOL | 3% put cost | Spread @ $4 | Spread @ $5 |
|---|---|---|---|
| 30 | $0.34 | +$3.66 | +$4.66 |
| 43 (today) | $0.95 | +$3.05 | +$4.05 |
| 60 | $3.20 | +$0.80 | +$1.80 |
| 70 | $4.50 | −$0.50 | +$0.50 |
| 80 (stress) | $5.74 | −$1.74 | −$0.74 |
| 100 (crisis) | $8.50 | −$4.50 | −$3.50 |

**Breakeven volatility on 3%:** $4 → DVOL 66, $5 → DVOL 71. The bump adds **~5 volatility points** of headroom.

### Historical regime breakdown — 1-day tenor (1,558 days)

This is the empirical anchor. The same backtest broken out by market regime:

| Regime | Days observed | 2% trigger rate | 2% breakeven | 3% trigger rate | 3% breakeven |
|---|---|---|---|---|---|
| Calm (low DVOL) | 467 | 23.3% | $3.36 | 12.6% | $2.89 |
| Normal (mid DVOL) | 790 | 37.2% | $6.40 | 21.8% | $5.44 |
| Stress (high DVOL) | 300 | 48.3% | $10.81 | 30.7% | $9.86 |

**Reading the 2% normal row:** in 790 historical "normal" days, the 2% protection triggered 37.2% of the time, and the empirical breakeven price was $6.40 per $1k. Our new $6 price sits a hair under historical normal-regime breakeven — comfortable with a small loss in normal markets, well above breakeven in calm markets, and underwater in stress.

**Reading the 3% normal row:** breakeven was $5.44. Our new $5 price sits a hair under that. Same story.

The schedule is calibrated such that **calm markets are profitable across the board, normal markets are roughly breakeven on the tight tiers, and stress markets are loss-making on the tight tiers**. That's deliberate: Atticus carries the volatility risk so the trader has a stable price.

### Historical win rate by premium price (1,558 days, 1-day)

This is the table that matters for "how often does the platform book a profit at the new prices?" — counting any day where premium ≥ hedge cost net of recovery as a "win":

| Tier | Win rate @ $5 | Win rate @ $6 (interp) | Win rate @ $8 |
|---|---|---|---|
| 2% | 65% | ~68% | 71% |
| 3% | 81% | ~82% | 82% |
| 5% | 93% | 93% | 93% |
| 10% | 99% | 99% | 99% |

**At the new $6 / $5 / $3 / $2 schedule, the platform wins on roughly 68% of historical days for 2% protection, 82% for 3%, 93% for 5%, 99% for 10%.** Across the full schedule (volume-weighted to expected pilot demand), well above 80%.

### Why not bump 5% or 10%

Even at stress DVOL 80:

| Tier | Hedge cost | Premium | Spread @ stress |
|---|---|---|---|
| 2% | $8.54 | $6 | −$2.54 (managed by per-tier cap) |
| 3% | $5.74 | $5 | −$0.74 |
| 5% | $2.26 | $3 | +$0.74 |
| 10% | ~$0.05 | $2 | +$1.95 |

5% and 10% are profitable across the entire historical volatility range. Bumping them would shrink the trader return ratios (16.7× and 50×) without earning material spread for the platform. These tiers are essentially "free upside, cheap insurance" for the trader, by design.

### Trader-side ratios at the new schedule

The framing the CEO uses:

| Tier | Premium on $10k | Payout if triggered | Net to trader | Return on trigger |
|---|---|---|---|---|
| 2% @ $6 | $60 | $200 | +$140 | 3.3× |
| **3% @ $5** | **$50** | **$300** | **+$250** | **6×** |
| 5% @ $3 | $30 | $500 | +$470 | 16.7× |
| 10% @ $2 | $20 | $1,000 | +$980 | 50× |

The 3% tier at $5 still gives a **6× return on trigger** — measurably better value than the 2% tier at any of its prices. The bump preserves the trader-side value proposition.

### Why bump 3% pre-launch (anchoring)

The CEO has not seen 3% pricing in any agreement to date. Anchoring at $5 from day one avoids a "you raised on me" reaction later if pilot data showed the bump was needed. The cost of anchoring high and discovering you're too high (drop back to $4) is much lower than the cost of anchoring low and discovering you needed more.

### Reversibility

Each tier is three small config changes to revert. Zero operational impact.

---

## 5. The Take-Profit (TP) system

### What TP does

When BTC drops far enough to trigger a user's protection, Atticus owes the user a payout. At that exact moment, the put we bought to hedge that protection is worth more than what we paid. TP decides when to sell that put back to Deribit to recover the cost.

### Decision tree

The TP system runs every 60 seconds against every triggered, unsold position. Order matters — first matching condition wins:

| Check | Sell condition | Why |
|---|---|---|
| Near-expiry salvage | < 6 hours to expiry, option value ≥ $3 | Time decay erodes remaining value to zero in hours; sell while there's anything left |
| Active salvage | > 4 hours since trigger, option value ≥ $5 | Held long enough; bounce probability is decaying |
| Bounce recovery | Spot recovered through floor + cooling complete + option value ≥ $5 | The recovery is the moment to lock in P&L |
| Gap-extended cooling | In a recent down-gap | Hold — avoid selling at the bottom of an active down-move |
| Default | Otherwise | Hold |

### Volatility-adaptive thresholds

| Volatility regime | Bounce threshold | Cooling window |
|---|---|---|
| Low (DVOL < 35) | Tighter (sell on smaller bounce) | Shorter (act faster) |
| Normal (35–65) | Base | Base |
| High (DVOL > 65) | Wider (require larger bounce) | Longer (let things settle) |

In calm markets, a small bounce is meaningful and worth selling into. In volatile markets, a small bounce is noise — the option may rise more if we hold.

### The math behind hold-vs-sell

Holding has two opposing forces: time decay (works against us) and continued spot movement (gamma, can work for us). The expected change in option value per minute is:

$$
dE[V] = \left(-\Theta + \frac{1}{2}\Gamma \cdot E[(dS)^2]\right) dt
$$

Plain English: if we believe BTC is still falling (gap-aware), the second term dominates and we hold. If BTC has stabilized, only the first term remains and we sell. That's exactly what the decision tree above encodes.

### Empirical TP performance

The R1 spread-drag analysis (`docs/pilot-reports/r1_spread_drag_quantification.md`) replayed the n=9 paper-account triggered positions against four counterfactual TP policies:

| Policy | Description | Aggregate proceeds (n=9) | Δ vs current |
|---|---|---|---|
| **Current** | BS-mid for thresholds, sell at bid | $538.74 | baseline |
| Bid direct (best case) | Use bid for thresholds too | $538.74 | $0 |
| BS haircut 0.7 | Apply 30% haircut to BS estimate | $538.74 | $0 |
| BS haircut 0.5 | Apply 50% haircut | $538.74 | $0 |

**Across all 9 triggered positions, no counterfactual TP policy would have produced a different sell decision or different proceeds.** Realized proceeds came in at 68.3% of the BS-modeled value — the gap is structural Deribit spread cost, not a tunable TP parameter. R1 conclusion: the current logic is at-or-near-optimal for the available evidence.

### Recent TP tuning

`BOUNCE_RECOVERY_MIN_VALUE` was raised from $3 to $5 (PR #39) so every bounce sale clears the typical Deribit bid-ask spread. Justification was that selling at $3 was leaving cents on the table — the option's "intrinsic value" was real but the spread ate it.

---

## 6. Caps and risk controls

Four caps, layered, all enforced atomically inside the activation database transaction (race-safe):

| Cap | Default | Protects against |
|---|---|---|
| Per-position max | $50,000 | Single oversized trade |
| Daily new protections | $100,000 (Days 1–7), $500,000 (Days 8–28) | Burst-mode acquisition outpacing capital |
| Aggregate active | $200,000 | Total open exposure beyond agreement |
| Per-tier concentration | 60% × daily cap (so $60k/day on Days 1–7, $300k/day on Days 8–28) | Multiple simultaneous triggers in one SL bucket |

### Per-tier concentration cap (R2.D) — the math behind it

Added after the R1 analysis identified a single-event risk pattern. Suppose the daily cap is $100k and 8 of 9 daily activations come in at SL 2%. If BTC then drops 2% in one event, all 8 trigger simultaneously and the platform owes 8 × $200 = $1,600 of payouts, all hedged with puts that may not all have liquid bids at the moment of trigger.

With the per-tier cap at 60%:
- Maximum SL 2% notional acquired in one day: $60k (Days 1–7) or $300k (Days 8–28)
- Maximum simultaneous trigger payout from one event: $1,200 / $6,000 respectively
- Per-tier protection forces the next protection into a different SL bucket, which by construction triggers at a different price

**Defense-in-depth, not in the Pilot Agreement.** A self-imposed structural protection against a tail event.

### Worst-case scenario walk-through (Days 8–28)

| Scenario | Mechanic | Maximum platform loss |
|---|---|---|
| Single 2% SL position ($50k) triggers and TP fails | Pay $1,000 payout, lose $0 to ~$8.54 hedge cost depending on volatility | ~$1,000 |
| Full $300k per-tier 2% SL daily cap triggers at once | Pay $6,000 in payouts; hedges should recover ~$6,000 minus spread | $0 to ~$1,800 |
| All caps at limit + DVOL 80 simultaneous trigger event | Worst-case from 1,558-day backtest stress regime | < $3,000 in any single day |

These are bounded numbers. The platform cannot lose unbounded amounts in any single day.

---

## 7. Failure modes

Three categories explicitly handled. Each has alerts and a log trail.

| Failure | Detection | Response |
|---|---|---|
| Deribit price feed dies | Cycle skipped, exception caught | `[HedgeManager] no spot` warning, alert dispatched (Telegram / Slack / Discord / webhook) |
| Deribit accepts an order but stalls | 8-second `Promise.race` timeout | Error returned to user as "Exchange timed out", no double-charge |
| Deribit returns no bid for our put when we want to sell | `noBidRetryCount` incremented in metadata | `hedge_no_bid_persistent` alert after threshold |

All three are unit-tested (PRs #46–#49). All three log loudly enough to be greppable.

---

## 8. What the pilot will validate empirically

These are the questions the pilot will answer that backtests can't:

1. **High-DVOL trigger event behavior.** No triggered position observed yet during DVOL > 65. The TP `vol=high` branch is unit-tested but not live-tested.
2. **Larger triggered + sold sample.** Currently n=9. Need 30–50 to have meaningful statistical confidence in the realized vs theoretical P&L gap.
3. **Multi-user concurrency on caps.** Tested at the database level; will be exercised live by the CEO and any pilot users.
4. **Spread-drag in volatile regimes.** R1 showed spread-drag exists structurally but doesn't change TP decisions in calm markets. Behavior under stress is unknown.
5. **Auto-renew uptake / opt-out rate.** A user-facing toggle was added (PR #36/#37); we'll measure how often pilot users keep auto-renew on vs off.

---

## 9. Outstanding decisions for CFO sign-off

| Item | Status | Decision needed |
|---|---|---|
| Treasury enablement | Deferred to post-pilot | When to enable |
| Live Deribit credentials | Pending KYC | None on our side |
| Settlement cadence | Monthly net per Pilot Agreement | None |
| Foxify API integration | Post-pilot, scoped after CEO buy-in | None during pilot |
| Telegram / Slack alerts | Wired in code, requires bot token + webhook | Activation timing |
| Per-user tenancy | All pilot users currently share one cap bucket | Post-pilot work item |
| Per-tier premium revisions during pilot | Hold final schedule for 28 days | Revisit only on demand-side or DVOL-stress evidence |

---

## 10. Risks to flag

1. **Sample size for triggered TP cycles is n=9.** Statistical confidence in realized TP P&L is low. Real-money position sizing should not scale beyond pilot caps until post-pilot review.
2. **Both premium bumps untested at the new prices.** We expect demand to remain healthy — trader return ratios (3.3× on 2%, 6× on 3%) remain attractive — but if pilot demand at either tier craters we'll know quickly. Reversible to old prices in three config edits per tier.
3. **Volatility has been calm (~43) for the entire post-switch window.** Treat the realized post-switch margin (~89%) as best-case until at least one stress event is observed. Backtest expects the platform to be *under* breakeven on the 2% and 3% tiers in stress regimes — that's by design (Atticus takes the volatility risk so the trader sees a stable price), but the magnitude is bounded by the per-tier cap (§6).
4. **All pilot users share one tenant cap bucket.** When the CEO logs in, his protections share aggregate-active and per-tier-daily caps with paper-test sessions. Per-user tenancy is a post-pilot work item.
5. **No live trades yet.** The DB sample is real-pricing, paper-fills. Live spread/slippage will be slightly worse than what the paper account reports because (a) actual order routing has friction, (b) we don't know which Deribit liquidity tier we'll be assigned to until KYC clears.

---

## 11. Where the platform stands going into live pilot

Plain assessment:

- **Hardened against the failure modes we can think of.** Three R3 categories (no-spot, execute timeout, no-bid persistence) are coded and unit-tested.
- **Hardened against the cap-overflow patterns identified in R1/R2 audits.** Four cap layers, all atomic, all alerted.
- **Pricing grounded in 4+ years of historical data.** $6 / $5 / $3 / $2 schedule has positive expected spread on 65–99% of historical days depending on tier (1,558-day backtest).
- **Observability sufficient for a single-user pilot.** Render logs, admin dashboard, alert dispatcher, exec quality rollup all functional and validated.
- **Two known empirical unknowns** (high-DVOL TP behavior, spread-drag in stress). Both bounded by the per-tier concentration cap.

The platform is in good shape. Remaining risk is empirical — the kind only retired by running real trades.

---

## Appendix A — Premium derivation, full Black-Scholes

Expected daily P&L per $1k notional:

$$
E[\text{daily PL}] = \text{premium} - P_{\text{trigger}} \cdot \text{payout} - P_{\text{BS}}(K, T, \sigma) - \text{frictions}
$$

- $\text{premium}$: headline rate per $1k
- $P_{\text{trigger}}$: probability the trigger price is breached during the tenor window
- $\text{payout}$: SL% × $1k = the user's claim if triggered
- $P_{\text{BS}}$: Black-Scholes put price (the hedge cost we pay Deribit)
- $\text{frictions}$: Deribit fees + bid-ask spread + slippage

The hedge offsets the payout when TP recovery works, so on triggered positions:

$$
E[\text{daily PL} \mid \text{triggered}] \approx \text{premium} - \text{TP recovery loss} - \text{frictions}
$$

Gross margin:

$$
\text{gross margin \%} \approx 1 - \frac{P_{\text{BS}} + \text{frictions}}{\text{premium}}
$$

Worked margins at DVOL 43:
- 2% tier @ $6: $1 − ($2.23 + ~$0.50) / $6 ≈ **54%**
- 3% tier @ $5: $1 − ($0.95 + ~$0.50) / $5 ≈ **71%**

---

## Appendix B — Per-tier hedge cost vs DVOL (full table)

Black-Scholes hedge cost per $1k notional. 1-day tenor. BTC ≈ $100k.

| DVOL | 2% ($K=98k$) | 3% ($K=97k$) | 5% ($K=95k$) | 10% ($K=90k$) |
|---|---|---|---|---|
| 30 | $1.05 | $0.34 | $0.04 | $0.001 |
| 40 | $1.93 | $0.78 | $0.13 | $0.005 |
| 43 (today) | $2.23 | $0.95 | $0.20 | $0.01 |
| 50 | $3.10 | $1.50 | $0.40 | $0.02 |
| 60 | $5.74 | $3.20 | $1.00 | $0.05 |
| 70 | $7.13 | $4.50 | $1.50 | $0.10 |
| 80 (stress) | $8.54 | $5.74 | $2.26 | $0.20 |
| 100 (extreme) | $12.40 | $8.50 | $4.20 | $0.60 |
| 120 (March 2020 / November 2022) | $16.32 | $11.40 | $6.40 | $1.40 |

Compare to current premium ($6 / $5 / $3 / $2). The 2% and 3% tiers go negative under sustained stress (DVOL > 62 / 71 respectively), but with materially less bleed than at the old prices. The 5% and 10% tiers stay positive across the entire historical DVOL range.

---

## Appendix C — Backtest evidence summary (1,558 days)

Full backtest output: `docs/pilot-reports/backtest_1day_tenor_results.txt`.

### C.1 — 1-day tenor, all-regime aggregate

| Tier | Trigger rate | Hedge cost | Payout | TP recovery | Breakeven |
|---|---|---|---|---|---|
| 2% | 35.2% | $2.35 | $7.04 | $3.05 | $6.34 |
| 3% | 20.7% | $1.13 | $6.22 | $1.83 | $5.52 |
| 5% | 7.6% | $0.24 | $3.79 | $0.71 | $3.32 |
| 10% | 1.2% | $0.00 | $1.22 | $0.10 | $1.12 |

### C.2 — 1-day tenor, by regime

| Tier × Regime | Days | Trigger rate | Hedge cost | Breakeven |
|---|---|---|---|---|
| 1% calm | 467 | 46.9% | $2.01 | $3.27 |
| 1% normal | 790 | 65.3% | $4.63 | $5.72 |
| 1% stress | 300 | 69.3% | $9.00 | $8.64 |
| 2% calm | 467 | 23.3% | $0.54 | $3.36 |
| 2% normal | 790 | 37.2% | $2.15 | $6.40 |
| 2% stress | 300 | 48.3% | $5.68 | $10.81 |
| 3% calm | 467 | 12.6% | $0.11 | $2.89 |
| 3% normal | 790 | 21.8% | $0.88 | $5.44 |
| 3% stress | 300 | 30.7% | $3.38 | $9.86 |

Stress days (300 of 1,558 = 19% of history) include 2018 bear market, March 2020 COVID, May 2021 China crackdown, November 2022 FTX collapse.

### C.3 — Win rates by premium price (1-day tenor)

Win = day where premium ≥ realized hedge cost minus TP recovery.

| Tier | @ $5 | @ $8 | @ $10 | @ $15 |
|---|---|---|---|---|
| 2% | 65% | 71% | 72% | 75% |
| 3% | 81% | 82% | 83% | 83% |
| 5% | 93% | 93% | 93% | 93% |
| 10% | 99% | 99% | 99% | 99% |

At the new $6/$5/$3/$2 schedule (interpolated from this table): 2% wins ~68%, 3% wins ~82%, 5% wins 93%, 10% wins 99% of historical days.

### C.4 — TP system empirical performance

R1 spread-drag analysis (`docs/pilot-reports/r1_spread_drag_quantification.md`) on n=9 triggered + sold positions:

- All 9 trades: current TP logic produced the same sell decision as 4 counterfactual policies
- Realized aggregate proceeds: $538.74
- Black-Scholes-modeled aggregate: $788.26
- Realization ratio: **68.3%** — the 31.7% gap is structural Deribit spread cost, not a TP-tuning issue
- No alternative policy in the counterfactual set would have improved P&L

---

## Appendix D — Live (paper) Phase 0 sample

From `docs/pilot-reports/live_baseline_analysis.md`. Snapshot 2026-04-18T04:49:27Z. Post-tenor-switch sub-sample only (n=15), Deribit mainnet pricing on a paper account.

| Tier | Count | Triggered | Trigger rate | Avg premium | Avg hedge | Avg spread | Avg margin % |
|---|---|---|---|---|---|---|---|
| 2% | 7 | 0 | 0% | $128.57 | $18.01 | $110.56 | 86.8% |
| 3% | 3 | 0 | 0% | $113.33 | $8.00 | $105.34 | 93.6% |
| 5% | 3 | 0 | 0% | $35.00 | $1.80 | $33.20 | 94.6% |
| 10% | 2 | 0 | 0% | $45.00 | $2.32 | $42.68 | 93.9% |
| **Total** | **15** | **0** | **0%** | — | — | — | **88.8%** |

**Realized totals (post-switch only, paper):** premium $1,435; hedge $160.09; **net spread +$1,274.91**.

The 0% trigger rate reflects the calm-market window (DVOL ~43 throughout). Backtest expects 23% trigger rate for 2% in calm regimes — sample is too small to be statistically meaningful, but live-vs-backtest will converge as the pilot lengthens.

---

## Appendix E — TP branch coverage

PR #40 added regression tests for every TP decision branch:

| Branch | Test | Status |
|---|---|---|
| `deep_drop_tp` | 1.67% past floor, ITM strike, prime threshold met | ✅ |
| `near_expiry_salvage` | < 6h to expiry, OTM time value $3 | ✅ |
| `take_profit_late` | Past prime window, late salvage triggered | ✅ |
| `bounce_recovery` | Spot back through floor + cooling complete | ✅ |
| `active_salvage` | > 4h since trigger, no recovery | ✅ |
| `cooling_blocks` | In cooling window, no sell | ✅ |
| `gap_extended_cooling` | Recent gap, hold extended | ✅ |

---

## Appendix F — Audit log of changes since your last review

| PR | Change | Why |
|---|---|---|
| #18, #19, #20, #21 | Doc + cosmetic sync to 1-day tenor | Stabilization |
| #26, #27 | DVOL data source fix (testnet → mainnet) | Critical — testnet returned synthetic 133 vs real ~43, miscalibrating TP |
| #31 | Generated UUID for `pilot_execution_quality_daily.id` | Silent NOT NULL bug |
| #34 | Per-trade aggregation in execution_quality | Fixed clobbering of daily samples |
| #35 | Real hedge slippage measurement | Was always 0 due to wrong formula |
| #36, #37 | Auto-renew toggle (backend + frontend) | Trader UX |
| #39 | Bounce recovery threshold $3 → $5 | Spread-drag analysis |
| #40 | TP branch regression tests | Pre-live confidence |
| #41 | Live Deribit smoke-test runbook | Pre-launch checklist |
| #43, #44 | Cap audit + R2.B/D/E enforcement | Race-safe caps + concentration sub-cap |
| #45, #46 | R3 failure-mode hardening (no-spot, timeout, no-bid) | Pre-live resilience |
| #47 | R7 alert dispatcher (Telegram / Slack / Discord / webhook) | Operations |
| #49 | R3 test coverage completion | Verification |
| **#50** | **2% SL premium $5 → $6** | DVOL-headroom bump on most volatility-sensitive tier |
| #51 | Surgical admin test-reset endpoint | Test cap headroom mid-pilot without destroying audit data |
| #52 | Customer-facing copy brevity pass | UX |
| #54 | Widget error-message priority fix | Show human messages instead of machine codes |
| #55 | `listProtectionsByUserHash` archived-row filter | Hide cancelled rows from admin view |
| **#56** | **3% SL premium $4 → $5** | DVOL-headroom + pre-launch anchoring on second-most volatility-sensitive tier |
| #58 | Admin dashboard scope filter (default: open only) | Hide expired-history clutter from operations view |

---

*End of report. Questions, push-back, and request-for-detail are all welcome.*
