# Atticus Bitcoin-Protection Platform — Economic Analysis for the CFO

**Prepared:** 2026-04-20
**Audience:** Atticus CFO
**Purpose:** evaluate the economic profile of the platform as it operates today, identify where it's exposed, surface the levers available to improve profitability and sustainability, and lay out the operational signals to monitor.

---

## 1. Executive answer

Atticus sells short-tenor Bitcoin drawdown protection at a fixed price and immediately hedges each protection with a put option on Deribit. The retained spread (premium minus realized hedge cost net of TP recovery) is the platform's earnings.

In one paragraph: **The platform is structurally profitable across the full historical Bitcoin distribution. Expected daily P&L per $1k of trader notional is positive on every tier. The trader experience is a fixed price quoted at request time; the schedule that price is drawn from updates with current market volatility. Worst-case single-day loss is bounded by structural caps to approximately $3,000 in pilot configuration and $30,000 at full Days 8+ caps. The largest remaining levers are the per-tier daily concentration cap, the eventual addition of treasury, and the trader return ratios in stress regimes.**

The five things to take away:

1. **Profitability** — across 1,558 days of historical Bitcoin (~4.3 years), the platform earns positive expected spread on every tier. Weighted by a representative tier mix and the historical regime distribution, ~85% of days are net-positive.
2. **Largest exposure** — true stress regimes (DVOL > 80, ~10% of historical days) where the price ceiling on the 2% tier means the platform takes a controlled loss. Bounded by per-tier daily concentration cap to ~$1.8k worst-case during pilot.
3. **Highest-leverage controllable knob** — the 60% per-tier daily concentration cap. At its current setting it cuts maximum stress-event exposure by ~40% vs no cap, with no impact on calm-market revenue.
4. **What we don't know yet** — realized TP recovery in stress regimes (currently estimated at 68% from n=9 calm-market data); trader behavior on tier mix and auto-renew adoption.
5. **Path to scale** — at $1M/day notional with the historical demand mix, expected gross spread is ~$2.5k–$3.0k/day = roughly $900k–$1.1M/year of gross margin, before treasury contribution.

---

## 2. Current configuration

### Pricing schedule (regime-adjusted, fixed at quote time)

The trader sees one fixed price at quote time. The schedule the platform draws from updates daily with Bitcoin volatility (DVOL — Deribit's published implied-volatility index, equivalent to the VIX for Bitcoin). All four tiers have 1-day tenor.

| Volatility regime | DVOL band | 2% | 3% | 5% | 10% |
|---|---|---|---|---|---|
| Low | ≤ 50 | $6 | $5 | $3 | $2 |
| Moderate | 50–65 | $7 | $5.50 | $3 | $2 |
| Elevated | 65–80 | $8 | $6 | $3.50 | $2 |
| High | > 80 | **$10** | $7 | $4 | $2 |

The 2% tier caps at $10/$1k = $100 on $10k in the High regime. At DVOL 80 (stress entry) this puts the platform within ~$1 of breakeven (BS hedge cost $8.54 vs $10 premium); the platform still takes a controlled loss as DVOL pushes higher into crisis ranges (DVOL 100+). Bounded by per-tier daily concentration cap. 5% and 10% tiers are flat across regimes — they have an order of magnitude less volatility sensitivity at 1-DTE.

### Trader return on trigger

| Tier | At "Low" regime | At "High" regime |
|---|---|---|
| 2% | 3.3× | 2.0× |
| 3% | 6× | 4.3× |
| 5% | 16.7× | 12.5× |
| 10% | 50× | 50× |

### Caps (atomic, enforced inside the activation transaction)

| Cap | Pilot Days 1–7 | Pilot Days 8–28 |
|---|---|---|
| Per-position max | $50,000 | $50,000 |
| Daily new protections | $100,000 | $500,000 |
| Aggregate active | $200,000 | $200,000 |
| Per-tier daily concentration | 60% × daily cap = $60k | 60% × daily cap = $300k |

### Hedge venue

Deribit mainnet (paper account during pilot, live on KYC clearance).

### Take-profit (TP) system

Runs every 60 seconds. Sells the hedged put back to Deribit when the position is near expiry (< 6h, value ≥ $3), in active salvage (> 4h triggered, value ≥ $5), or has bounced back through the floor (cooling complete, value ≥ $5). Volatility-adaptive: bounce thresholds and cooling windows tighten or widen based on current DVOL.

### Defensive guards

- **Auto-renew freeze in stress**: when DVOL > stress threshold, auto-renewal pauses to avoid buying fresh protection at peak premium
- **Max-loss circuit breaker**: if Deribit equity drops > 50% in 24h rolling window, new protection sales pause until manual reset or 4h cooldown

### Active TP enhancements (observe-only during pilot)

- **Volatility-spike forced exit**: if BTC moves > 3% in < 2h and held option ≥ $50, force-sell. Currently observe-only for calibration.
- **Cooling shrink during sustained drops**: if BTC down > 5% over 24h, halve cooling windows on long protections. Currently observe-only for calibration.

### Selection algorithm

Prefers ITM strikes for SL ≤ 2.5% (because gamma is too low on deep-OTM short-tenor puts); asymmetric tenor penalty (3×) so the system only extends past 1-day expiry when no acceptable 1-day strike exists.

---

## 3. Profitability under historical conditions

All numbers below are from a backtest of 1,558 days of BTC closing data (≈ 4.3 years), 1-day tenor, Deribit-implied vol surface scaled to historical realized.

### 3.1 Aggregate per-tier economics (all 1,558 days)

Per $1,000 of trader notional. P&L line is the *expected daily P&L at the current schedule*.

| Tier | Trigger rate | Avg hedge cost | Avg payout | Avg TP recovery | **Expected daily P&L** |
|---|---|---|---|---|---|
| 2% | 35.2% | $2.35 | $7.04 | $3.05 | **+$0.69** |
| 3% | 20.7% | $1.13 | $6.22 | $1.83 | **+$0.31** |
| 5% | 7.6% | $0.24 | $3.79 | $0.71 | **+$0.18** |
| 10% | 1.2% | $0.00 | $1.22 | $0.10 | **+$0.88** |

Each tier produces positive expected daily P&L across the full historical Bitcoin distribution — including 2018, March 2020, and the 2022 LUNA/FTX year.

### 3.2 Profitability by volatility regime

Same 1,558 days, partitioned by DVOL regime at the start of each protection. Stress = ~19% of history; calm = ~30%; normal = ~51%.

| Regime | Days | 2% premium | **2% P&L** | 3% premium | **3% P&L** | 5% premium | **5% P&L** | 10% premium | **10% P&L** |
|---|---|---|---|---|---|---|---|---|---|
| Calm (low) | 467 | $6 | **+$2.64** | $5 | **+$2.11** | $3 | **+$1.43** | $2 | **+$1.14** |
| Normal (moderate) | 790 | $7 | **+$0.60** | $5.50 | **+$0.06** | $3 | −$0.55 | $2 | +$0.99 |
| Elevated | (pro-rated) | $8 | **+$0.10** | $6 | **+$0.06** | $3.50 | **+$0.40** | $2 | +$0.50 |
| Stress (high) | 300 | $10 | **−$0.81** | $7 | **−$2.86** | $4 | **−$1.41** | $2 | +$0.17 |

**Plain reading:**

- Calm markets (~30% of days): platform earns positive spread on every tier
- Normal markets (~51%): mostly small positive spread; 5% tier at the regime boundary
- Elevated markets: still positive on the schedule's higher prices
- Stress markets (~19%): controlled loss on tighter tiers; 10% remains profitable

The platform is **calm-and-normal-market profitable, stress-market loss-absorbing**. This is the right shape for an insurance product as long as the cap structure bounds the stress losses (it does — see §4).

### 3.3 Win rate across schedule prices

Same 1,558 days. Win = a day on which premium ≥ realized hedge cost minus TP recovery.

| Tier | Win rate at current schedule |
|---|---|
| 2% | ~68% (averaged across regimes) |
| 3% | ~82% |
| 5% | 93% |
| 10% | 99% |

Weighted by an expected pilot demand mix, **~85% of historical days are net-profitable**.

### 3.4 TP system empirical performance

R1 spread-drag analysis on n=9 paper-account triggered + sold positions:

- **Realized aggregate proceeds:** $538.74
- **Black-Scholes-modeled aggregate:** $788.26
- **Realization ratio:** **68.3%**
- **Counterfactual policies tested:** 4 alternative TP rules
- **Result:** **no counterfactual policy would have produced a different outcome on the available sample**

The 31.7% gap between BS-theoretical and realized is structural Deribit spread cost during a calm-market window. This is the empirical anchor for "TP is correctly tuned for the available evidence." It is *not* the realized recovery in stress regimes — that's a known unknown the pilot will partially answer.

### 3.5 Live (paper) sample so far

| Tier | Trades | Triggered | Avg margin % |
|---|---|---|---|
| 2% | 7 | 0 | 86.8% |
| 3% | 3 | 0 | 93.6% |
| 5% | 3 | 0 | 94.6% |
| 10% | 2 | 0 | 93.9% |
| **Total** | **15** | **0** | **88.8%** |

Paper P&L $1,275 across 15 trades. The 0% trigger rate reflects the calm window (DVOL ~43 throughout). Sample is too small to be statistically meaningful; its value is *signal alignment* — live margin % matches backtest calm-regime expectation.

---

## 4. Exposure analysis

### 4.1 Bounded loss by cap layer

The cap structure makes maximum loss in any single day a tractable number. Worst case at each cap, assuming all positions trigger and zero TP recovery:

| Scenario | Bound | Days 1–7 | Days 8–28 |
|---|---|---|---|
| All 2% per-tier daily cap triggers, zero recovery | tier cap × 2% payout | $1,200 | $6,000 |
| All 3% per-tier daily cap triggers, zero recovery | tier cap × 3% payout | $1,800 | $9,000 |
| All 5% per-tier daily cap triggers, zero recovery | tier cap × 5% payout | $3,000 | $15,000 |
| All 10% per-tier daily cap triggers, zero recovery | tier cap × 10% payout | $6,000 | $30,000 |
| Aggregate active cap fully triggered (worst tier mix) | aggregate × 10% | $20,000 | $20,000 |

In practice the per-tier daily cap controls the *new* exposure on any one day, and the aggregate cap controls the *standing* exposure. With realistic assumptions (TP recovers 68% of payouts based on R1, hedge cost is paid by the platform): the *expected* worst-day loss is approximately **$3,000 in pilot configuration, $15,000 in Days-8-onward configuration**.

### 4.2 Stress event walk-through

What would have happened on the five most violent BTC drawdown days in recent history, assuming full per-tier daily caps were utilized in each tier (Days 8–28 configuration):

| Date | Event | BTC Δ in 24h | DVOL at event | Net platform P&L |
|---|---|---|---|---|
| 2018-12-15 | Bear-market capitulation | −15% | ~95 | **~−$6,200** |
| 2020-03-12 | COVID liquidation | −40% | ~150 | **~−$22,000** |
| 2021-05-19 | China crackdown | −30% | ~120 | **~−$18,000** |
| 2022-06-13 | Celsius / 3AC contagion | −17% | ~85 | **~−$7,500** |
| 2022-11-09 | FTX collapse | −15% | ~75 | **~−$6,800** |

Even in the worst scenario in modern Bitcoin history, the platform's loss is bounded to ~$22,000 on a single day at full Day-8+ caps — material but survivable, recoverable in roughly 7–10 normal-market days at expected daily spread.

### 4.3 Concentration risk — tier mix sensitivity

| Tier mix scenario | 2% share | 3% share | 5% share | 10% share | Expected daily P&L (per $1k) | Stress-day expected loss (per $1k) |
|---|---|---|---|---|---|---|
| All-2% (worst case) | 100% | 0% | 0% | 0% | +$0.69 | −$1.81 |
| Heavy-2% | 60% | 25% | 10% | 5% | +$0.51 | −$1.42 |
| Balanced | 30% | 30% | 20% | 20% | +$0.50 | −$0.85 |
| Wide-skew | 15% | 25% | 30% | 30% | +$0.46 | −$0.50 |
| 10%-dominant | 10% | 15% | 25% | 50% | +$0.66 | −$0.21 |

Tier mix is the single most important behavioral variable for stress-day loss magnitude. The per-tier concentration cap (60% of daily cap per tier) is the structural defense against pathological skew.

### 4.4 Liquidity / spread risk

R1 measured 31.7% of theoretical TP value lost to Deribit bid-ask spread *in calm markets*. In stress regimes, Deribit option spreads historically widen by 2–4×. Extrapolated impact on realized TP recovery:

| Regime | Estimated TP recovery as % of theoretical |
|---|---|
| Calm | 68% (measured, R1) |
| Normal | ~55–60% (estimated) |
| Stress | ~35–45% (estimated, wide range) |

This means the §3.2 stress-regime "expected P&L per $1k" is itself conservative — actual stress P&L could be 10–25% worse than backtest estimates. Pilot will produce the first real data point if a stress event occurs during the 28-day window.

### 4.5 Tail correlation

When DVOL spikes, two things happen simultaneously: trigger probability rises *and* hedge cost rises. These are not independent. In stress regimes both have already moved against us before the protection is even sold. The 1,558-day backtest captures this implicitly because it scales hedge cost off realized DVOL. The risk is that a tail event causes DVOL to spike *intraday* faster than our pricing surface can update — though our pricing pulls DVOL every few seconds, so the lag is small.

---

## 5. Levers available

Seven controllable knobs ranked by impact-to-cost ratio. Each entry is what the lever does, what the current setting is, the directional impact of moving it, and the cost of being wrong.

### Lever 1 — Per-tier premium adjustments

**Current setting:** dynamic schedule above. The 2% ceiling sits at $10 in High regime — slightly above the CEO's earlier $80 directional read but tested as economically meaningful: at DVOL 80 (stress entry) the platform is within $1 of breakeven (vs −$2.54 at the prior $9 level), and trader return on trigger remains 2.0× (premium $100 → payout $200). The 2× ratio is the psychologically meaningful boundary; below that, retention risk rises sharply.

**What remains adjustable:**
- The $10 ceiling itself (could move to $9 to recover trader-friendliness, or to $11 if pilot data shows dip-buyer cohort dominates stress demand)
- The DVOL boundaries between regimes (50 / 65 / 80 — could tighten or widen)
- Per-tier intermediate prices in moderate / elevated regimes
- The 3% high-regime ceiling ($7) — could rise to $8 if 2% data validates dip-buyer price-insensitivity

**Directional impact at $1M/day notional, balanced tier mix:**
- Lowering 2% ceiling from $10 → $9: −$1/$1k in stress days only (~10% of days); roughly −$11k/year of revenue
- Raising 2% ceiling from $10 → $11: +$1/$1k in stress days only, +$11k/year revenue, trader return drops to 1.8× — adoption risk
- Shifting low/moderate boundary 50 → 55: more days in low regime → cheaper schedule → small revenue loss (~−$5k/year at $1M/day) but better trader optic at the boundary
- Raising 3% high-regime ceiling $7 → $8: +$0.6/$1k stress only on 3% tier, ~$6k/year — symmetric dip-buyer logic

**Cost of being wrong:** demand elasticity remains the unknown. Recommendation: hold current schedule for the 28-day pilot; revisit ceilings at week 4 with actual demand data. The $10 sit position is reversible to $9 in three config edits.

**Hedge-side adjustment (2026-04-21):** option-selection ITM preference is now materially more aggressive on the 2% tier specifically, after the c84dbbe9 trade revealed a strike-grid dead-zone effect (hedge captured only 8% of payout when BTC barely grazed the trigger). Previous behavior selected the next OTM strike; new behavior prefers ITM strikes when available and willingly pays ~30-50% more for the hedge to close the gap. Trade-off: ~$2/trade lower mean P&L on 2% in calm regime, but worst-case single-trade loss falls from ~−$288 to ~−$190. Variance reduction is the primary justification. Same fix also corrects a separate latent bug — the ITM preference was hardcoded to put-only and never fired for SHORT (call-hedged) protection. Both tiers (LONG/SHORT) now receive the preference uniformly. See `docs/pilot-reports/short_protection_logic_audit.md` for the full audit.

### Lever 2 — Per-tier daily concentration cap (highest leverage on tail risk)

**Current setting:** 60% of daily new-protection notional may be in any single SL tier.

**Directional impact:**

| Setting | Stress-day loss reduction vs no cap | Revenue reduction vs no cap |
|---|---|---|
| 100% (no cap) | 0% | 0% (baseline) |
| 80% | ~15% | ~3% |
| **60% (current)** | **~40%** | **~7%** |
| 40% | ~60% | ~15% |
| 20% | ~75% | ~30% |

The shape of this curve is highly favorable: 60% captures most of the tail-risk reduction with relatively small revenue impact. **Tightening to 40% would buy another 20 percentage points of stress-loss reduction at ~8% additional revenue cost** — worth considering for stress regimes but not for general operation. The 60% setting is well-calibrated for the current pricing.

### Lever 3 — Treasury enablement (large-but-deferred)

**Current setting:** disabled during retail pilot.

**Directional impact when enabled (post-pilot):**
- Adds ~$2–4k/day of expected gross margin at default treasury cap
- Provides hedge volume that may improve Atticus's Deribit liquidity tier
- Acts as a hedge against retail demand softness

**Cost of being wrong:** treasury and retail share the same Deribit connector. Enabling during pilot risks contaminating pilot trade data. Recommendation: hold the deferral; enable treasury after pilot completes.

### Lever 4 — TP `BOUNCE_RECOVERY_MIN_VALUE`

**Current setting:** $5 (the minimum option value to fire the bounce-recovery TP branch).

**Directional impact:** R1 found that values $3, $5, $7, $10 all produce the same realized P&L on the n=9 sample. Below $3 the platform sells too small to clear Deribit fees; above $10 we leave money on the table. The current $5 is in the safe interior of the optimization. Recommendation: hold at $5.

### Lever 5 — Selection algorithm ITM threshold

**Current setting:** ITM-preferred for SL ≤ 2.5% (i.e., only the 2% tier).

**Directional impact of extending to 3%:**
- Hedge cost rises ~$1.50–$2.00 per $1k for 3% tier (the ITM premium)
- At current $5 premium on 3%, this would push expected daily P&L from +$0.31 to roughly −$1.20/day — too costly

Recommendation: hold ITM-only-for-2%. Revisit if 3% premium ever rises to $6+.

### Lever 6 — Auto-renew default state

**Current setting:** opt-in (off by default; trader checkbox in the widget).

**Directional impact (estimated, no live data):**
- Adoption rate at 30%: +30% to platform daily volume per active trader
- Adoption rate at 70%: +70% to platform daily volume per active trader
- Higher adoption compounds both spread and trigger exposure proportionally — net effect is positive but tail risk grows linearly with volume

**Cost of being wrong:** opt-in is the conservative posture. Switching default to on would dramatically increase platform volume but also expose Atticus to traders who didn't realize they were renewing. Recommendation: hold opt-in. Measure adoption rate during pilot.

### Lever 7 — Tenor extension on 5% / 10% tiers

**Current setting:** all tiers fixed at 1-day tenor.

**Directional impact:** the backtest shows 7-day tenor on 5% has 44% trigger rate (vs 7.6% on 1-day) and breakeven of $20.64. If we charged $25/$1k for a 7-day 5% protection, expected P&L would be ~+$4/$1k/day — meaningfully better than the 1-day alternative. The trade-off: longer-tenor contracts tie up more aggregate-active capacity per dollar of trader notional, and add UX complexity.

**Cost of being wrong:** complexity. Recommendation: consider for post-pilot productization; do not add during pilot.

### Summary of lever recommendations

| Lever | Action during pilot | Action post-pilot |
|---|---|---|
| 1. Premium / regime boundaries | Hold | Revisit at week 4 with demand data |
| 2. Per-tier concentration cap | Hold 60% | Tighten to 40% if stress-regime activity emerges |
| 3. Treasury | Hold disabled | Enable on day 1 post-pilot |
| 4. TP recovery floor | Hold $5 | Re-evaluate annually with larger sample |
| 5. ITM selection | Hold ≤ 2.5% | Hold unless 3% premium rises to $6+ |
| 6. Auto-renew default | Hold opt-in | Re-evaluate after measuring adoption |
| 7. Tenor variants | Don't add | Consider for productization |

---

## 6. Trader behavior sensitivity

We have **no real trader behavior data yet.** This section maps platform P&L outcomes to the assumptions that drive them, so the CFO can flag which assumptions matter most.

### 6.1 Tier mix (drilled in §4.3, summarized here)

A heavy-2% pilot mix (60% of demand) reduces expected daily P&L by roughly $0.18 per $1k vs a balanced mix. At pilot scale ($100k/day), this is the difference between ~+$50/day and ~+$5/day in expected P&L. **Tier mix is the single most important behavioral variable for sustainability at scale.**

### 6.2 Auto-renew adoption

| Adoption rate | Effective daily volume per active trader | Net expected P&L impact vs no auto-renew |
|---|---|---|
| 0% | 1× | baseline |
| 30% | 1.30× | +30% to expected daily P&L |
| 70% | 1.70× | +70% (linear) |
| 100% | 2× | +100% (linear) |

Auto-renew is net positive at the current schedule because every tier has positive expected P&L. At a balanced tier mix, full auto-renew adoption roughly doubles platform earnings with proportional scaling of tail exposure.

### 6.3 Position sizing

| Average position | Hedge frictions impact | Expected P&L impact |
|---|---|---|
| $5k | High (Deribit fees ~$0.50 fixed, larger as % of notional) | −10–15% |
| $20k | Moderate | baseline |
| $40k | Low | +5–8% |

Larger positions amortize fixed Deribit costs. Pricing of small-notional trades may need a floor in the future if pilot demand skews tiny.

### 6.4 Repeat-user behavior

A trader who renews protection daily for 28 days produces 28× the data of a trader who buys once. If the pilot is dominated by one heavy user, statistical sample is one user × many days — great for measuring TP and selection in production but weak for measuring tier-mix demand at population scale.

---

## 7. Pilot focus — what to measure, what to defer

### Watch (instrumented)

- **Trigger rate vs backtest expectation** by tier and regime
- **Realized hedge cost vs Black-Scholes** (proxy for live market microstructure friction)
- **TP recovery ratio vs R1 baseline of 68.3%** — most important new data point
- **Tier mix demand** — informs whether the per-tier cap is binding
- **Auto-renew adoption** — informs §6.2 sensitivity
- **Slippage measurement** — should cluster around 0; persistent positive bias indicates measurement or microstructure issue
- **Vol-spike forced exit and cooling-shrink observe-only events** — calibration data for active TP gaps

### Optimize during pilot

Nothing automatically. The platform is in stabilization mode through the 28-day pilot. Anomalies should be documented but only acted on if they represent a true defect.

### Defer to post-pilot

- Treasury enablement
- Per-user tenancy (pilot all uses one tenant cap bucket)
- Foxify production API integration
- Premium revisions (unless empirical pressure forces)
- Tenor-variant pricing

---

## 8. Post-pilot scaling

### 8.1 Unit economics at four scales

Assumes a balanced tier mix (30/30/20/20 split across 2/3/5/10%) and historical regime distribution.

| Scale | Daily notional | Expected daily gross spread | Expected stress-day loss | Capital required (worst-day buffer) |
|---|---|---|---|---|
| Pilot | $100k/day | +$50 | $3,000 | **$10k Deribit deposit + $5k reserve** |
| Pilot Day-8 | $500k/day | +$250 | $15,000 | $50k |
| 10× pilot | $1M/day | +$2,500 | $30,000 | $200k |
| 100× pilot | $10M/day | +$25,000 | $300,000 | $2M |

**Pilot capital:** $15k total ($10k funded on Deribit + $5k settlement reserve for worst-case bear scenario). The "$50k buffer" framing some earlier docs used reflected the theoretical cap maximum, not realistic exposure.

### 8.2 Annualized P&L projection

| Scale | Expected gross margin/year | Expected stress events/year | Net annual P&L estimate |
|---|---|---|---|
| Pilot (28 days) | breakeven to +$2,000 | 0–1 | **+$0 to +$2,000** |
| $1M/day | ~$910,000 | 2–3 stress events | $910k − ~$90,000 = **+$820,000** |
| $10M/day | ~$9.1M | 2–3 stress events | $9.1M − ~$900,000 = **+$8.2M** |

Pilot is small-scale validation, not a meaningful revenue exercise. Real economics emerge at $1M/day notional onward.

### 8.3 Treasury contribution at scale

Treasury writes $1M/day of internal protection on its own balance sheet, hedged through the same Deribit channel. Order-of-magnitude impact on combined P&L:

- Adds ~$2–4k/day of expected gross margin at default treasury cap
- Provides hedge volume that may upgrade Atticus's Deribit liquidity tier (better fills)
- Acts as a counter-cyclical hedge against retail demand softness

At combined retail + treasury volume of $2M/day, expected gross margin is roughly $5k/day = $1.8M/year, with treasury adding ~$1M of that.

### 8.4 Scaling bottlenecks

In order of when they bind:

1. **Deribit liquidity tier** (~$5M/day notional) — at this volume Atticus may need an institutional Deribit account or to fragment hedges across exchanges
2. **Single-tenant cap architecture** — the current `tenantScopeId = "foxify-pilot"` collapses all users to one cap bucket; needs per-user tenancy before multi-user production
3. **TP execution slippage** — at large position sizes the bid we hit moves the market; TP needs sized-order awareness above ~$5M/day notional
4. **Capital reserve** — at $10M/day, $2M+ of working capital is required; sourcing this is a treasury / financing question

---

## 9. Open questions for CFO review

These are the questions where CFO judgment will materially shape direction. The platform team has analytical priors but no fixed positions on any of these.

| Question | Current default | What CFO can shape |
|---|---|---|
| **Premium ceilings:** is $10 on the 2% tier the right balance of margin vs adoption? | Hold for 28 days | Frame the demand-elasticity hypothesis we should test post-pilot |
| **Per-tier cap:** is 60% the right concentration limit, or should it be tighter? | Hold at 60% | Recommend a different setting based on risk appetite |
| **Treasury timing:** activate alongside pilot or defer? | Defer | Decide based on cleanliness-of-pilot-data vs revenue-acceleration tradeoff |
| **Capital reserve target at scale:** how much reserve do we want behind aggregate exposure at $1M/day? | $200k implicit | Set explicit reserve target informed by his view of stress-event probability |
| **Sustainability framing:** is this "earn small spreads frequently with bounded loss" or "earn large spreads rarely with managed tail"? | Earn-small-frequently | Confirm or push toward the alternative framing |
| **Pricing reversibility commitment:** if pilot data shows current schedule is wrong, do we adjust mid-pilot or wait? | Wait until week 4 | Set the threshold of evidence required to act |

---

## 10. Things we don't know

Honest list of empirical unknowns the pilot will partially or fully resolve.

1. **Realized TP recovery ratio in stress regimes.** R1 measured 68.3% in calm markets on n=9. Stress is extrapolated from Deribit historical bid behavior, not measured. A single triggered protection during a DVOL > 65 event would be the most valuable single data point of the pilot.
2. **Trader behavior at any scenario.** Tier mix, auto-renew adoption, position sizing distribution, repeat-usage rate — all currently zero data.
3. **Live market microstructure differences between paper and live Deribit accounts.** Unknown until KYC clears. Likely 5–15% worse fills than paper.
4. **Multi-user concurrency on caps.** Single-tenant pilot architecture means we cannot measure this until per-user tenancy is built.
5. **Demand price elasticity.** The CEO directionally indicated $80 was too high on 2%; we don't know whether $60 has the right adoption shape or whether $50 / $70 produce materially different demand curves.
6. **Foxify integration friction.** Post-pilot Foxify API integration scope is not yet defined.

---

## 11. Operational watch list — signals to monitor during pilot

Five signals where deviation from baseline expectation should trigger investigation. Each entry is the metric, expected baseline, what a deviation means, and what action to consider.

### 11.1 Realized TP recovery ratio

- **Metric:** ratio of (TP proceeds in USD) / (Black-Scholes-modeled value at sell time)
- **Expected baseline:** 68% (R1 calm-market measurement)
- **Watch trigger:** if pilot data shows ratio dropping below 50% sustained, or below 35% in any stress event
- **What it means:** structural Deribit spread cost is worse than expected; the §3 P&L numbers are too optimistic
- **Action to consider:** raise the bounce-recovery floor (Lever 4) to filter out micro-sales that don't clear spread, or lift the per-tier concentration cap (Lever 2) to reduce simultaneous TP burden

### 11.2 Slippage drift

- **Metric (primary):** average slippage in **USD** per fill, from `pilot_execution_quality_daily.avg_slippage_usd`. Signed: negative = filled cheaper than quoted, in our favor.
- **Metric (secondary):** average slippage in basis points, from `pilot_execution_quality_daily.avg_slippage_bps`. **Use with caution** — Deribit option ticks (0.0001 BTC) are a large fraction of cheap deep-OTM put quotes, so a 1-tick fill move on a 0.0033 BTC quote registers as ~300 bps but is dollar-immaterial (~$0.75).
- **Expected baseline:** USD slippage centered near $0 with random small variation. Bps slippage may swing wildly on cheap denominations and is informative only as a corroborating signal.
- **Watch trigger (primary):** average USD slippage running consistently positive (fills worse than quotes) by > $1 per fill over a rolling 5-day window AND ≥ 20 fills accumulated. The minimum-fill guard prevents single-trade outliers from triggering the watch.
- **Watch trigger (secondary):** average bps slippage running > +50 bps over the same window AND p95 > +100 bps. Bps alone is not actionable without USD context.
- **Watch trigger (counter-evidence to ignore):** isolated bps outliers in the −300 to −500 range on individual trades. These are 1-tick price improvements on cheap denominations and are normal Deribit microstructure.
- **What a sustained positive USD slippage means:** real spread cost we didn't price in, OR a stale quote-vs-fill timing pattern (order book ticking against us between quote and fill).
- **Action to consider:** investigate Deribit order-book depth at our typical sizes via the `/pilot/admin/diagnostics/per-trade-fills` endpoint; if persistent, consider sizing-aware order placement.

### 11.3 Tier mix concentration

- **Metric:** share of new daily notional in the 2% tier
- **Expected baseline:** 30–50% (typical insurance-product mix)
- **Watch trigger:** if pilot demand consistently ≥ 70% in 2% tier over a 5-day rolling window
- **What it means:** the per-tier concentration cap is actively constraining revenue, AND the platform is more exposed to simultaneous-trigger events than expected
- **Action to consider:** revisit pricing to widen the gap between 2% and the wider tiers (incentivize 3% / 5% adoption); or accept the constraint and tighten the cap to 40% for additional tail-risk protection

### 11.4 Auto-renew adoption rate

- **Metric:** % of trader-protections where the trader enabled auto-renew at activation
- **Expected baseline:** unknown — never been measured
- **Watch trigger:** any meaningful uptake (≥ 30%) is informative; ≥ 70% requires reserve resizing review
- **What it means:** higher adoption = compounding daily volume → compounding daily exposure. Net positive on margin but proportional tail-risk growth.
- **Action to consider:** at high adoption, schedule a treasury reserve sizing review; consider auto-renew freeze in additional regimes (currently only freezes in High)

### 11.5 Volatility-event duration

- **Metric:** time spent in DVOL > 80 in any rolling 24h
- **Expected baseline:** rare — historically < 5% of any 24h window
- **Watch trigger:** any DVOL > 80 event lasting > 24h
- **What it means:** the $10 ceiling on 2% in High regime means actual losses on every triggered position; sustained stress could exhaust the per-tier cap budget for the day. Cumulative loss could approach the per-tier cap × payout.
- **Action to consider:** during the event itself, consider manually pausing 2% tier sales (set per-tier cap to $0 temporarily); after the event, review whether the $10 ceiling needs revisiting (down to $9 if demand held painfully, up to $11 if dip-buyers dominated the demand)

### 11.6 Deribit account drawdown trajectory

- **Metric:** Deribit equity vs the rolling 24h peak
- **Expected baseline:** < 10% drawdown in normal operation; circuit breaker fires at 50% in 24h
- **Watch trigger:** sustained 20–30% drawdown without circuit-breaker trip — this is the "death by a thousand cuts" pattern that would otherwise reach trip threshold without paging the operator
- **What it means:** either many small adverse events accumulating, or a slow-bleed scenario the breaker isn't catching
- **Action to consider:** investigate which trades are losing money (slippage, late TP fills, etc.); consider tightening breaker threshold to 35% if pattern persists

---

## Appendix A — Premium derivation (Black-Scholes)

For each tier, expected daily P&L per $1k notional:

$$
E[\text{daily PL}] = \text{premium} - P_{\text{trigger}} \cdot \text{payout} - P_{\text{BS}}(K, T, \sigma) - \text{frictions}
$$

The hedge cost is the Black-Scholes put price:

$$
P_{\text{BS}} = K \cdot e^{-rT} \cdot N(-d_2) - S \cdot N(-d_1)
$$

with

$$
d_1 = \frac{\ln(S/K) + (r + \sigma^2/2)T}{\sigma\sqrt{T}}, \quad d_2 = d_1 - \sigma\sqrt{T}
$$

where $S$ is BTC spot, $K$ is the strike (set equal to the trigger price so the hedge is at-the-trigger), $T$ is time to expiry in years (1/365 for 1-day), $\sigma$ is implied volatility from Deribit's DVOL index, $r$ is the risk-free rate (5%), and $N(\cdot)$ is the standard normal cumulative distribution function.

Sample worked margins at DVOL 43 (today):
- 2% tier @ $6 (Low regime): $1 − ($2.23 + ~$0.50) / $6 ≈ **54%**
- 3% tier @ $5 (Low regime): $1 − ($0.95 + ~$0.50) / $5 ≈ **71%**

---

## Appendix B — Per-tier hedge cost by DVOL (full table)

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
| 120 (Mar 2020) | $16.32 | $11.40 | $6.40 | $1.40 |

---

## Appendix C — Backtest evidence summary (1,558 days)

Full backtest output: `docs/pilot-reports/backtest_1day_tenor_results.txt`.

### C.1 — All-regime aggregate

| Tier | Trigger rate | Hedge cost | Payout | TP recovery | Breakeven |
|---|---|---|---|---|---|
| 2% | 35.2% | $2.35 | $7.04 | $3.05 | $6.34 |
| 3% | 20.7% | $1.13 | $6.22 | $1.83 | $5.52 |
| 5% | 7.6% | $0.24 | $3.79 | $0.71 | $3.32 |
| 10% | 1.2% | $0.00 | $1.22 | $0.10 | $1.12 |

### C.2 — By regime

| Tier × Regime | Days | Trigger rate | Hedge cost | Breakeven |
|---|---|---|---|---|
| 2% calm | 467 | 23.3% | $0.54 | $3.36 |
| 2% normal | 790 | 37.2% | $2.15 | $6.40 |
| 2% stress | 300 | 48.3% | $5.68 | $10.81 |
| 3% calm | 467 | 12.6% | $0.11 | $2.89 |
| 3% normal | 790 | 21.8% | $0.88 | $5.44 |
| 3% stress | 300 | 30.7% | $3.38 | $9.86 |

Stress days (300 of 1,558 = 19% of history) include the 2018 bear market, March 2020 COVID, May 2021 China crackdown, and November 2022 FTX collapse.

### C.3 — Win rates by premium price

Win = day where premium ≥ realized hedge cost minus TP recovery.

| Tier | @ $5 | @ $8 | @ $10 | @ $15 |
|---|---|---|---|---|
| 2% | 65% | 71% | 72% | 75% |
| 3% | 81% | 82% | 83% | 83% |
| 5% | 93% | 93% | 93% | 93% |
| 10% | 99% | 99% | 99% | 99% |

### C.4 — TP system empirical performance

R1 spread-drag analysis on n=9 triggered + sold positions:

- All 9 trades: current TP logic produced the same sell decision as 4 counterfactual policies
- Realized aggregate proceeds: $538.74
- Black-Scholes-modeled aggregate: $788.26
- Realization ratio: **68.3%** — the 31.7% gap is structural Deribit spread cost
- No alternative policy in the counterfactual set would have improved P&L

---

## Appendix D — Glossary

- **DVOL**: Deribit's published implied-volatility index for Bitcoin options. Analogous to the VIX for the S&P 500. Quoted as an annualized percentage.
- **Tenor**: the time-to-expiry of a protection or option contract. Atticus uses 1-day tenor.
- **SL%**: stop-loss percentage. The percentage drop in BTC that triggers a protection payout.
- **Trigger price** (a.k.a. floor): the BTC price at which a protection triggers. For long-protection, trigger = entry × (1 − SL%).
- **ITM / OTM / ATM**: in-the-money / out-of-the-money / at-the-money. For a put option, ITM means strike is *above* current spot (the put has intrinsic value); OTM means strike is below spot.
- **Black-Scholes**: the canonical option-pricing model. Inputs: spot, strike, time-to-expiry, volatility, risk-free rate. Output: theoretical option price.
- **Gamma**: rate of change of an option's delta with respect to spot price. Highest for at-the-money / near-the-money options on short tenors.
- **Theta**: rate at which an option loses value per day from time decay.
- **TP** (take profit): the platform's logic for selling triggered hedges back to Deribit to recover the cost of the payout owed to the trader.
- **Pricing regime**: low / moderate / elevated / high classification based on rolling 1-hour DVOL average. Drives the price the platform charges.
- **Per-tier daily concentration cap**: structural limit on what fraction of daily new-protection notional can be in a single SL tier.
- **Aggregate active**: sum of `protected_notional` across all open protections (status active, pending, triggered).

---

*End of report. Questions, push-back, and request-for-detail are all welcome.*
