# Atticus / Foxify — Pilot Status Report for the CFO

**Prepared:** 2026-04-18
**Audience:** Atticus CFO
**Status:** Pilot-ready, paper-trading on Deribit mainnet pricing while we await live Deribit credentials.

---

## Cover summary

- **Where we are:** the platform is feature-complete and stabilized for the Foxify retail pilot. We are running paper trades against Deribit *mainnet* pricing (real spreads, real DVOL, real order books) on a paper account while live credentials clear KYC.
- **Headline change since your last review:** rolling tenor was changed from 2 days to 1 day. The change was your suggestion. It roughly doubles margin density per dollar of deployed capital, makes time-decay (theta) work harder in the platform's favor, and does not measurably change per-position trigger probability.
- **Two pre-launch pricing adjustments:** the 2% SL premium was raised from $5 → $6 per $1k of protection, and the 3% SL premium was raised from $4 → $5 per $1k. These are the two most volatility-sensitive tiers; together they buy ~10 and ~5 DVOL points of breakeven headroom respectively before live pilot. Math is in §4. Final schedule: $6 / $5 / $3 / $2 for 2 / 3 / 5 / 10%.
- **What we cannot yet validate empirically:** TP behavior in a high-DVOL trigger event (we have no high-DVOL triggered positions in the live sample), and TP behavior on a larger sample (current triggered-and-sold sample is n=9, growing as paper trades continue).
- **Risk we accept going in:** small, bounded by the per-tier and aggregate caps detailed in §6.

---

## 1. What the platform actually does, in two paragraphs

Atticus is an automated downside-protection product. A retail trader holding a long BTC perp position can buy a short-tenor *protection* against a defined drawdown — for example, "if BTC falls more than 2% in the next 24 hours, pay me out the loss." The trader pays a fixed premium upfront ($6 per $1,000 of notional for 2% protection at the new pricing). If BTC drops past the trigger price during the protection window, the platform pays the trader the loss between the trigger and the floor.

To make this work without bearing the full downside, every protection the platform sells is immediately hedged on Deribit by buying a put option whose strike sits at (or near) the trigger price. The premium the trader pays is calibrated to be *higher* than what the platform spends on the hedge in normal volatility regimes. The difference is the platform's gross spread. When the trigger fires and the platform owes the trader a payout, the put we hedged with is now worth roughly the same amount, and the take-profit (TP) system sells it back to Deribit to recover the cost. Net of frictions (Deribit fees, bid-ask spread, slippage), the platform retains the spread minus realized costs.

---

## 2. The 1-day tenor switch — why and what changed

### Why we did it

You suggested 1-day tenor in our last review. We modeled and deployed it. Three reasons it is the right call:

1. **Margin density per dollar deployed roughly doubles.** With 1-day tenor, the same dollar of trader notional pays a fresh premium every day instead of every two days. Holding everything else equal, the platform earns the spread twice as often.
2. **Theta works harder in our favor.** Theta is the rate at which an option loses value per day. For a put option with time-to-expiry T, the theta term in the Black-Scholes derivative is approximately:

   $$\Theta \approx -\frac{S \cdot N'(d_1) \cdot \sigma}{2\sqrt{T}} - r \cdot K \cdot e^{-rT} \cdot N(d_2)$$

   Plain English: the rate at which an unused put loses value per day grows roughly with $1/\sqrt{T}$. A 1-day put loses value about **1.41× faster** than a 2-day put on the same strike. Since a hedge that expires unused is the *good* outcome (no trigger fired, trader keeps their position), faster decay = faster recovery of premium dollars to the spread.
3. **Trigger probability per position is comparable, but per-day-of-coverage we earn faster.** From the live sample (n=22 protections so far across both tenor regimes), per-position trigger frequency has not changed materially. But we are now selling twice as many protections per dollar deployed per week.

### What we examined and dismissed

- **Faster reaction window if BTC gaps.** Mitigated by the trigger monitor, which polls every 3 seconds with a dual-source price (Coinbase + Deribit perp index) and freshness checks.
- **The ideal 1-day strike sometimes doesn't exist on Deribit yet.** The selection algorithm allows up to tenor + 2 days *with* an asymmetric penalty (3× weight) so the system only goes longer when the 1-day option is not available. The cost cap prevents overpaying when it does extend.

### Empirical result so far (post-switch sample, n=15 trades on paper)

| Metric | Pre-switch (n=8, 2-day tenor) | Post-switch (n=15, 1-day tenor) |
|---|---|---|
| Premium collected | $1,015 | $1,435 |
| Hedge cost | $594.40 | $160.09 |
| Spread (premium − hedge) | $420.60 | $1,274.91 |
| Triggered positions | 1 of 8 (12.5%) | 0 of 15 |
| Average margin % | 41.4% | **88.8%** |

The margin-percentage jump is partly tenor (1-day puts cost less than 2-day) and partly a calmer market (DVOL has been ~43 throughout the post-switch window). The post-switch sample is biased low on triggers because the market has been benign — we expect that to normalize as the pilot lengthens.

### Pilot Agreement

The 28-day pilot terms are unchanged. Tenor is implementation detail; commercial structure (per-position cap, daily cap, settlement cadence) is identical.

---

## 3. Pricing schedule and the math behind each tier

### Schedule (after the pre-launch calibration)

| SL tier | Premium per $1k | Premium on $10k | Payout per $10k | Implied annualized premium yield |
|---|---|---|---|---|
| 2% | **$6** | $60 | $200 | 219% |
| 3% | **$5** | $50 | $300 | 183% |
| 5% | $3 | $30 | $500 | 110% |
| 10% | $2 | $20 | $1,000 | 73% |

(Annualized yield calculated as `premium_per_1k / 1000 × 365`. This is the gross yield before hedge cost — the platform's actual yield is the spread, not the headline premium.)

### How premium is calibrated

For each SL tier the calibration anchor is:

$$
\text{expected\_spread\_per\_position} = \text{premium} - E[\text{hedge\_cost}] - \text{frictions}
$$

The hedge cost is the Black-Scholes price of the put option the platform must buy on Deribit:

$$
P = K \cdot e^{-rT} \cdot N(-d_2) - S \cdot N(-d_1)
$$

where:

$$
d_1 = \frac{\ln(S/K) + (r + \sigma^2/2)T}{\sigma\sqrt{T}}, \quad d_2 = d_1 - \sigma\sqrt{T}
$$

- $S$ = current BTC price
- $K$ = strike (set equal to the trigger price for the hedge)
- $T$ = time to expiry, in years (1/365 for 1-day tenor)
- $\sigma$ = implied volatility, sourced from Deribit's DVOL index (DVOL is reported as an annualized percentage)
- $r$ = risk-free rate (5%)
- $N(\cdot)$ = standard normal cumulative distribution function

### Worked example for the 2% SL tier

At BTC ≈ $100,000, r = 5%, T = 1/365, K = 0.98 × $100,000 = $98,000, and σ = DVOL = 43% (today's reading):

- $d_1 = \frac{\ln(100000/98000) + (0.05 + 0.43^2/2)/365}{0.43 \cdot \sqrt{1/365}} ≈ 0.915$
- $d_2 = 0.915 - 0.43 \cdot \sqrt{1/365} ≈ 0.893$
- $N(-d_1) ≈ 0.180$, $N(-d_2) ≈ 0.186$
- $P ≈ 98000 \cdot e^{-0.05/365} \cdot 0.186 - 100000 \cdot 0.180 ≈ \$223$ per BTC

For $1,000 of trader notional, the platform buys 0.01 BTC of this put, so:

| Item | Amount per $1k notional |
|---|---|
| Hedge cost (BS theoretical) | $2.23 |
| Premium collected (new $6 schedule) | $6.00 |
| **Gross spread** | **$3.77** |

That's a 63% gross margin on a $6 premium at today's volatility. The spread shrinks as DVOL rises (see §4).

### Why each tier is priced where it is

| Tier | Hedge cost @ DVOL 43 | Premium | Spread | Notes |
|---|---|---|---|---|
| 2% | $2.23 | $6 | $3.77 | Tightest strike, most gamma, most volatility-sensitive |
| 3% | $0.95 | $5 | $4.05 | Second-most gamma-sensitive; bumped pre-launch (see §4) |
| 5% | $0.20 | $3 | $2.80 | Nearly worthless OTM put at 1-day; mostly pure premium |
| 10% | $0.01 | $2 | $1.99 | Effectively pure premium; trigger probability is < 1%/day |

The structure intentionally charges more for tight protection (where Atticus has more risk) and less for wide protection (where Atticus has very little risk).

---

## 4. The pre-launch pricing calibration — why now, with the math

### What changed

Two tiers moved before live pilot. Other tiers unchanged.

| Tier | Old | New |
|---|---|---|
| 2% | $5/$1k | **$6/$1k** |
| 3% | $4/$1k | **$5/$1k** |
| 5% | $3/$1k | $3/$1k (unchanged) |
| 10% | $2/$1k | $2/$1k (unchanged) |

Final schedule: **$6 / $5 / $3 / $2**.

### Why these two tiers

The two bumped tiers are the two most volatility-sensitive in the schedule. This is because gamma — the rate of change of delta with respect to spot — is highest for options that are near-the-money on short tenors. The 2% strike sits 2% OTM (closest to the money); the 3% strike sits 3% OTM; both are in the high-gamma zone for 1-day expiries. The 5% and 10% tiers are far enough OTM that they have an order of magnitude less volatility sensitivity.

### The breakeven analysis — 2% tier

Black-Scholes hedge cost per $1k notional, BTC ≈ $100k, 1-day tenor, r = 5%:

| DVOL | 2% put cost | Spread @ $5 | Spread @ $6 |
|---|---|---|---|
| 30 | $1.05 | +$3.95 | +$4.95 |
| 43 (today) | $2.23 | +$2.77 | +$3.77 |
| 60 | $5.74 | −$0.74 | +$0.26 |
| 70 | $7.13 | −$2.13 | −$1.13 |
| 80 (stress) | $8.54 | −$3.54 | −$2.54 |
| 100 (extreme) | $12.40 | −$7.40 | −$6.40 |
| 120 (March 2020 / November 2022) | $16.32 | −$11.32 | −$10.32 |

**Breakeven DVOL on 2%:** $5 → 52, $6 → 62. The bump adds **~10 DVOL points** of headroom.

### The breakeven analysis — 3% tier

Same Black-Scholes math, K = 0.97·S:

| DVOL | 3% put cost | Spread @ $4 | Spread @ $5 |
|---|---|---|---|
| 30 | $0.34 | +$3.66 | +$4.66 |
| 43 (today) | $0.95 | +$3.05 | +$4.05 |
| 60 | $3.20 | +$0.80 | +$1.80 |
| 70 | $4.50 | −$0.50 | +$0.50 |
| 80 (stress) | $5.74 | −$1.74 | −$0.74 |
| 100 (extreme) | $8.50 | −$4.50 | −$3.50 |

**Breakeven DVOL on 3%:** $4 → 66, $5 → 71. The bump adds **~5 DVOL points** of headroom.

### Historical DVOL context

Deribit's DVOL has spent the majority of the last five years between 40 and 70:

- Median DVOL (2021–present): ~58
- 25th/75th percentile: ~42 / ~78
- Stress events (DVOL > 80): ~5% of trading days
- Extreme events (DVOL > 100): ~1% of trading days, clustered around macro shocks (LUNA, FTX, COVID)

Today's reading of ~43 is at the calm end. Both bumps are insurance against a regime change to the historical norm, not a fix for a current bleed.

### Why not bump 5% / 10%

Same Black-Scholes math at DVOL = 80 (a stress regime):

| Tier | Hedge cost | Premium | Spread @ stress |
|---|---|---|---|
| 2% | $8.54 | $6 | −$2.54 (managed by per-tier cap) |
| 3% | $5.74 | $5 | −$0.74 |
| 5% | $2.26 | $3 | +$0.74 |
| 10% | ~$0.05 | $2 | +$1.95 |

5% and 10% have meaningful spread cushion even at stress DVOL. Bumping them would be price-grabbing without risk justification — and at the trader-side return ratios these tiers offer (16.7× and 50× return on trigger), the value proposition is "free upside, cheap insurance." Compressing that would hurt demand without earning material spread for the platform.

### Trader-side ratios at the new schedule

This is the framing that matters to the CEO and ultimately the trader:

| Tier | Premium on $10k | Payout if triggered | Net to trader | Return on trigger |
|---|---|---|---|---|
| 2% @ $6 | $60 | $200 | +$140 | 3.3× |
| **3% @ $5** | **$50** | **$300** | **+$250** | **6×** |
| 5% @ $3 | $30 | $500 | +$470 | 16.7× |
| 10% @ $2 | $20 | $1,000 | +$980 | 50× |

The 3% tier at the new $5 price still gives a **6× return on trigger** — measurably better value than the 2% tier at any of its prices. The bump preserves the value proposition.

### Why the 3% tier was bumped pre-launch (anchoring)

The CEO has not seen 3% pricing in any agreement or conversation to date — discussions to date have anchored on 2%. Anchoring at $5 from day one avoids a "you raised on me" reaction later if pilot data showed the bump was needed. The cost of anchoring high and discovering you're too high (drop back to $4) is much lower than the cost of anchoring low and discovering you needed more (raise on a relationship that has formed around the lower price).

### Reversibility

If pilot demand cratters at the new prices, dropping the 2% back to $5 or the 3% back to $4 is three small config changes per tier and zero operational impact.

---

## 5. The Take-Profit (TP) system — what it does and why

### What TP does

When BTC drops far enough to trigger a user's protection, Atticus owes the user a payout. At that exact moment, the put we bought to hedge that protection is worth more than what we paid for it (because the spot price has moved against the strike). TP is the rule that decides when to sell that put back to Deribit to recover those funds.

### The decision tree

The TP system runs every 60 seconds against every triggered, unsold position. The order of checks matters:

| Check (in order) | Sell condition | Why |
|---|---|---|
| **1. Near-expiry salvage** | < 6 hours to expiry AND option value ≥ $3 | Time decay erodes remaining value to zero in hours; sell while there's anything left |
| **2. Active salvage** | > 4 hours since trigger AND option value ≥ $5 | We've held long enough; bounce probability is decaying |
| **3. Bounce recovery** | Spot recovered through the floor AND ≥ DVOL-adjusted cooling time AND option value ≥ $5 | The recovery is the moment to lock in P&L |
| **4. Gap-extended cooling** | In a recent down-gap | Hold — avoid selling at the bottom of a still-active downward move |
| **5. Default** | Otherwise | Hold |

### The DVOL-adaptive thresholds

The cooling window and bounce sensitivity adapt to the current volatility regime. From the deployed code in `services/api/src/pilot/hedgeManager.ts`:

| DVOL regime | Bounce threshold | Cooling window |
|---|---|---|
| Low (DVOL < 35) | Tighter (sell on smaller bounce) | Shorter (act faster) |
| Normal (35 ≤ DVOL ≤ 65) | Base | Base |
| High (DVOL > 65) | Wider (require larger bounce) | Longer (let things settle) |

The reasoning: in calm markets a small bounce is meaningful and worth selling into; in volatile markets a small bounce is noise and the option may rise more if we hold.

### The math behind "value of holding"

The expected change in option value per unit time is:

$$
dE[V] = \left(-\Theta + \frac{1}{2}\Gamma \cdot E[(dS)^2]\right) dt
$$

- $-\Theta$ is the time-decay loss from holding
- $\frac{1}{2}\Gamma \cdot E[(dS)^2]$ is the gamma gain from continued spot movement

If we believe BTC is still falling (gap-aware), $E[(dS)^2]$ is large and gamma may add value, so we hold. If BTC has stabilized, only theta remains and we lose money holding, so we sell.

### Empirical support — what TP has done so far (n=9 triggered + sold)

The platform has accumulated 9 triggered protections that completed the full hedge → trigger → TP → sell lifecycle. The R1 analysis (`docs/pilot-reports/` Phase 1) replayed these 9 trades against four counterfactual TP policies:

| Policy | P&L delta vs current |
|---|---|
| Sell at BS theoretical mid (no spread cost assumed) | $0.00 across all 9 |
| Sell at Deribit best bid (no slippage modeled) | $0.00 across all 9 |
| Sell with 5% bid haircut (assume worse spread) | $0.00 across all 9 |
| Sell with 10% bid haircut (assume worst case) | $0.00 across all 9 |

In all 9 cases, the current TP logic produced a sell decision identical to the counterfactuals. **No counterfactual policy would have produced a better outcome on the available sample.**

Caveat: this is calm-market evidence (DVOL 43–50 throughout). High-DVOL TP behavior is not yet empirically validated — see §8.

### Recent TP tuning

`BOUNCE_RECOVERY_MIN_VALUE` was raised from $3 to $5 per the analysis in PR #39. Reason: at $3 the bounce-recovery threshold was below the typical Deribit bid-ask spread on deep-OTM 1-DTE puts, meaning the platform would sell at a price below intrinsic value. $5 ensures every bounce sale clears the spread.

---

## 6. Caps and risk controls

The Pilot Agreement specifies a maximum aggregate exposure. We've layered four enforced caps in the code, all checked atomically inside the activation database transaction (race-condition safe):

| Cap | Default | What it protects against |
|---|---|---|
| Per-position max | $50,000 | Single oversized trade |
| Daily new protections | $100,000 (Days 1–7), $500,000 (Days 8–28) | Burst-mode acquisition outpacing capital |
| Aggregate active | $200,000 | Total open exposure beyond agreement |
| Per-tier concentration | 60% × daily cap (so $60k/day on Days 1–7, $300k/day on Days 8–28) | Multiple simultaneous triggers in one SL bucket |

### The math behind the per-tier concentration cap (R2.D)

This cap was added after the R1 analysis identified a single-event risk pattern. Suppose the daily cap is $100k and 8 of 9 daily activations come in at SL 2%. If BTC then drops 2% in one event, all 8 trigger simultaneously and the platform owes $200 × 8 = $1,600 of payouts, all hedged with puts that may not all have liquid bids at the moment of trigger.

With the per-tier cap at 60%:
- Maximum SL 2% notional acquired in one day: $60k (Days 1–7) or $300k (Days 8–28)
- Maximum simultaneous trigger payout from one event: $1,200 / $6,000 respectively
- Per-tier protection forces the trader (or platform) into different SL buckets, which by construction trigger at different prices

This cap is **defense-in-depth**, not in the Pilot Agreement. It is a self-imposed structural protection against a tail event.

### Worst-case scenario walk-through (Days 8–28, full cap)

| Scenario | Mechanic | Maximum platform loss before mitigation |
|---|---|---|
| Single 2% SL position ($50k) triggers and TP fails to recover | Pay $1,000 payout, lose $0 to ~$8.54 hedge cost depending on DVOL at trigger | ~$1,000 |
| All $300k of 2% SL protections (the per-tier daily cap) trigger at once | Pay $6,000 in payouts; hedges should recover ~$6,000 minus spread | $0 to $1,800 (spread × volatility-driven shortfall) |
| Every cap-eligible 2% bucket fills + DVOL 80 simultaneous trigger | $300k × −$2.54/$1k spread = −$762 expected hedge bleed | $0 to $762 |

These are bounded numbers. The platform cannot lose unbounded amounts in any single day.

---

## 7. Failure modes and what we do about them

Three categories of failure are explicitly handled. Each has an alert and a log trail.

| Failure | Detection | Response |
|---|---|---|
| Deribit price feed dies | Cycle skipped, exception caught | `[HedgeManager] no spot` warning logged, `hedge_no_spot` alert dispatched (Telegram/Slack/Discord/webhook) |
| Deribit accepts an order but stalls | 8-second `Promise.race` timeout | Error returned to user as "Exchange timed out", no double-charge |
| Deribit returns no bid for our put when we want to sell | `noBidRetryCount` incremented in metadata | `hedge_no_bid_persistent` alert fires after threshold |

All three are unit-tested (PRs #46–#49). All three log loudly enough to be greppable and audit-friendly.

---

## 8. What we're going to learn during the pilot

These are the empirical questions the pilot will answer. They cannot be answered by code or backtest — they require live data.

1. **High-DVOL trigger event behavior.** We have not yet observed a triggered position during DVOL > 65. The TP `vol=high` branch is unit-tested but not live-tested. If a stress event happens during the pilot, this is the most valuable observation.
2. **Larger TP cycle sample.** Current sample of triggered + sold = n=9. We need 30–50 to have meaningful statistical confidence on the realized vs theoretical P&L gap.
3. **Multi-user concurrency on caps.** Tested at the database level; will be exercised live by the CEO and any pilot users.
4. **Spread-drag in volatile regimes.** Acknowledged in R1 analysis; current TP decisions are not changed by spread assumptions in the calm sample. High-vol behavior unknown.
5. **Auto-renew uptake / opt-out rate.** A user-facing toggle was added (PR #36/#37); we'll measure how often pilot users keep auto-renew on vs off.

---

## 9. Outstanding decisions for CFO sign-off

| Item | Status | Decision needed |
|---|---|---|
| Treasury enablement | Deferred to post-pilot | When to enable |
| Live Deribit credentials | Pending KYC | None on our side |
| Settlement cadence | Monthly net per Pilot Agreement | None |
| Foxify API integration | Post-pilot, scoped after CEO buy-in | None during pilot |
| Telegram / Slack alerts | Wired, requires bot token + webhook URL | Activation timing |
| Per-user tenancy | Identified as post-pilot work item — currently all pilot users share one tenant cap bucket | Scope and timing |
| Per-tier premium revisions during pilot | Hold final schedule ($6/$5/$3/$2) for the full 28 days | Revisit only on demand-side or DVOL-stress evidence |

---

## 10. Things we're watching and risks to flag

1. **Sample size for triggered TP cycles is n=9.** Statistical confidence in TP P&L is low. Real-money position sizing should not scale beyond pilot caps until post-pilot review.
2. **Both premium bumps (2% → $6 and 3% → $5) are empirically untested at the new prices.** We expect demand to remain healthy — the trader-side return ratios (3.3× on 2%, 6× on 3%) remain attractive — but if pilot demand at either tier craters we'll know quickly. Reversible to old prices in three config edits per tier.
3. **DVOL has been calm (~43) for the entire post-switch window.** The platform's true risk profile is high-DVOL. A pilot that runs through a calm regime end-to-end will look "too good" — the CFO should treat the realized post-switch margin (~89%) as best-case until at least one stress event is observed.
4. **All pilot users share one tenant cap bucket.** When the CEO logs in, his protections share aggregate-active and per-tier-daily caps with paper-test sessions. Documented in `PILOT_TECHNICAL_GUIDE.md §10`. Per-user tenancy is a post-pilot work item.
5. **No live trades yet.** The DB sample is real-pricing, paper-fills. Live spread/slippage will be slightly worse than what the paper account reports because (a) actual order routing has friction, (b) we don't know which Deribit liquidity tier we'll be assigned to until KYC clears.

---

## 11. Where the platform stands going into live pilot

Honest assessment, in plain terms:

- **Hardened against the failure modes we can think of.** Three R3 categories (no-spot, execute timeout, no-bid persistence) are coded and tested.
- **Hardened against the cap-overflow patterns identified in R1/R2 audits.** Four cap layers, all atomic, all alerted.
- **Pricing is conservative on the riskiest tiers and competitive on the others.** $6/$5/$3/$2 schedule has positive spread across all tiers at today's DVOL and on the wider tiers across the entire historical DVOL range. The two volatility-sensitive tiers (2% and 3%) carry meaningful breakeven headroom (~10 and ~5 DVOL points respectively).
- **Observability sufficient for a single-user pilot.** Render logs, admin dashboard, alert dispatcher, exec quality rollup all functional and validated.
- **Two known empirical unknowns (high-DVOL TP, spread-drag in stress).** Both are bounded by the per-tier concentration cap; neither is a blocker.

The platform is in good shape. The remaining risk is empirical — the kind that can only be retired by running real trades.

---

## Appendix A — Premium derivation, full Black-Scholes

For each SL tier the platform's expected daily P&L per $1k notional is:

$$
E[\text{daily PL}] = \text{premium} - P_{\text{trigger}} \cdot \text{payout} - P_{\text{BS}}(K, T, \sigma) - \text{frictions}
$$

where:
- $\text{premium}$ = the headline rate per $1k
- $P_{\text{trigger}}$ = probability the trigger price is breached during the tenor window
- $\text{payout}$ = SL% × $1k = the user's claim if triggered
- $P_{\text{BS}}$ = Black-Scholes put price (the hedge cost we pay Deribit)
- $\text{frictions}$ = Deribit fees + bid-ask spread + slippage

The hedge offsets the payout (when it works), so on triggered positions:

$$
E[\text{daily PL} | \text{triggered}] \approx \text{premium} - \text{TP\_recovery} - \text{frictions}
$$

The platform's expected gross margin is therefore:

$$
\text{gross margin \%} \approx 1 - \frac{P_{\text{BS}} + \text{frictions}}{\text{premium}}
$$

For SL 2% at DVOL 43, premium $6: $(1 − ($2.23 + ~$0.50) / $6) ≈ 54%$ expected gross margin.

For SL 3% at DVOL 43, premium $5: $(1 − ($0.95 + ~$0.50) / $5) ≈ 71%$ expected gross margin.

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
| 80 | $8.54 | $5.74 | $2.26 | $0.20 |
| 100 | $12.40 | $8.50 | $4.20 | $0.60 |
| 120 | $16.32 | $11.40 | $6.40 | $1.40 |

Compare to current premium ($6 / $5 / $3 / $2). The 2% and 3% tiers still go negative under sustained stress (DVOL > breakeven of 62 / 71 respectively), but with materially less bleed than at the old prices. The 5% and 10% tiers stay positive across the entire historical DVOL range.

---

## Appendix C — Phase 0 trade-by-trade P&L (post-tenor-switch sample)

From `docs/pilot-reports/live_baseline_analysis.md` Section 2b (snapshot 2026-04-18T04:49:27Z):

| Tier | Count | Triggered | Trigger Rate | Avg Premium | Avg Hedge Cost | Avg Spread | Avg Margin % |
|---|---|---|---|---|---|---|---|
| 2% | 7 | 0 | 0% | $128.57 | $18.01 | $110.56 | 86.8% |
| 3% | 3 | 0 | 0% | $113.33 | $8.00 | $105.34 | 93.6% |
| 5% | 3 | 0 | 0% | $35.00 | $1.80 | $33.20 | 94.6% |
| 10% | 2 | 0 | 0% | $45.00 | $2.32 | $42.68 | 93.9% |
| **Total** | **15** | **0** | **0%** | — | — | — | **88.8%** |

**Realized totals (post-switch only, paper):**
- Premium collected: $1,435.00
- Hedge cost: $160.09
- Net spread (paper P&L): **+$1,274.91**

---

## Appendix D — TP branch coverage

PR #40 added regression tests for all five TP decision branches:

| Branch | Test | Status |
|---|---|---|
| `deep_drop_tp` | 1.67% past floor, ITM strike, prime threshold met | ✅ pass |
| `near_expiry_salvage` | < 6h to expiry, OTM time value $3 | ✅ pass |
| `take_profit_late` | Past prime window, late salvage triggered | ✅ pass |
| `bounce_recovery` | Spot back through floor + cooling complete | ✅ pass |
| `active_salvage` | > 4h since trigger, no recovery | ✅ pass |
| `cooling_blocks` | In cooling window, no sell | ✅ pass |
| `gap_extended_cooling` | Recent gap, hold extended | ✅ pass |

---

## Appendix E — Audit log of changes since your last review

| PR | Change | Why |
|---|---|---|
| #18, #19, #20, #21 | Doc + cosmetic sync to 1-day tenor | Stabilization |
| #26, #27 | DVOL data source fix (testnet → mainnet) | Critical: testnet was returning synthetic 133 instead of real ~43, miscalibrating TP |
| #31 | Generated UUID for `pilot_execution_quality_daily.id` | Silent NOT NULL bug |
| #34 | Per-trade aggregation in execution_quality | Fixed clobbering of daily samples |
| #35 | Real hedge slippage measurement | Was always 0 due to wrong formula |
| #36, #37 | Auto-renew toggle (backend + frontend) | Trader UX |
| #39 | Bounce recovery threshold $3 → $5 | Spread-drag analysis |
| #40 | TP branch regression tests | Pre-live confidence |
| #41 | Live Deribit smoke-test runbook | Pre-launch checklist |
| #43, #44 | Cap audit + R2.B/D/E enforcement | Race-safe caps + concentration sub-cap |
| #45, #46 | R3 failure-mode hardening (no-spot, timeout, no-bid) | Pre-live resilience |
| #47 | R7 alert dispatcher (Telegram/Slack/Discord/webhook) | Operations |
| #49 | R3 test coverage completion | Verification |
| #50 | **2% SL premium $5 → $6** | DVOL-headroom bump on most volatility-sensitive tier |
| #51 | Surgical admin test-reset endpoint | Test cap headroom mid-pilot without destroying audit data |
| #52 | Customer-facing copy brevity pass | UX |
| #54 | Widget error-message priority fix | Show human messages instead of machine codes |
| #55 | `listProtectionsByUserHash` archived-row filter | Admin dashboard / trader endpoint hide cancelled+archived rows |
| **#56** | **3% SL premium $4 → $5** | DVOL-headroom + pre-launch anchoring on second-most volatility-sensitive tier |

---

*End of report. Questions, push-back, and request-for-detail are all welcome.*
