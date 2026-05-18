# Atticus — How It Works

> **Audience:** investors, partners, and sophisticated counterparties evaluating
> the Atticus Bitcoin protection platform.
> **Purpose:** explain the platform's mechanics, edge, and why it operates from
> structural-finance principles rather than directional speculation. Deliberately
> calibrated to be **specific enough to verify, vague enough to not hand over a
> blueprint**.
> **Companion docs:** capital and scaling math in `Atticus_Capital_Scaling.md`.
> **Last updated:** 2026-05-06

---

## 1. What Atticus does

Atticus operates two distinct Bitcoin protection products on top of a shared
risk-management engine:

1. **Retail Protection** — short-tenor B2C price-floor protection sold to
   traders through the Foxify trading interface. The trader pays a small daily
   subscription; if Bitcoin moves through the floor they choose, they receive
   a fixed payout.

2. **Treasury Protection** — institutional-scale structured protection for
   corporate, fund, and DAO BTC holdings. Subscription-priced, hedged using
   a protective collar (a TradFi-standard technique combining long puts and
   short calls), settled T+1.

Both products sit on top of the same:
- Real-time volatility-aware pricing engine
- Multi-stage risk controls (per-tier caps, hedge budget caps, circuit breakers)
- Live hedge management with automated take-profit
- Deribit (and Falcon X) execution layer

The *products* differ; the *engineering* shares.

---

## 2. The economic model

### 2.1 The platform's cash flow per trade

For every protection sold, Atticus engages in three cash flows:

```
Inflow:  trader / treasury subscription premium
Outflow: hedge cost (option bought on Deribit / Falcon X)
Inflow/Outflow: payout obligation (if floor breached) - hedge unwind value (recovered)
```

The platform's gross spread per trade is:

```
Spread = Premium − Hedge Cost − max(0, Payout − Hedge Recovery)
```

This is the same fundamental cash structure that classical insurance, fixed
indemnity contracts, and reinsurance treaties use. The two non-trivial parts
are (a) **what to charge** and (b) **how to manage the hedge** — both addressed
in §3 and §4 below.

### 2.2 Why this is structural, not speculative

Two characteristics distinguish Atticus from directional trading:

- **Every position is hedged at activation.** The platform's economic exposure
  is the spread between premium and hedge cost, not the underlying price
  movement of Bitcoin. We are not betting on direction.
- **Pricing is rule-bound, not discretionary.** No analyst, no human-call. A
  market vol observation maps to a published rate via a deterministic
  function. Identical inputs produce identical prices.

In academic finance terms, the platform earns the *insurance premium spread*
adjusted for the *time-value capture on managed hedges*. The closest TradFi
analogue is a structured-products desk operating short-dated variance swaps
or barrier options against listed-vol hedges — a very long-running and
well-understood business.

---

## 3. The pricing engine

### 3.1 Inputs

The pricing engine consumes:

- BTC spot price (multi-source aggregated, sub-second freshness)
- Deribit DVOL (an implied-volatility index, the BTC analogue of the VIX)
- Tenor (1 day for legacy, 14 days for biweekly retail, 30 days for treasury)
- Tier (stop-loss percentage)
- Direction (LONG/SHORT for retail; LONG-only for treasury)

### 3.2 Output

A daily rate per $1k of protected notional. The rate is locked at activation
for the full tenor of the protection; subsequent vol changes do not modify
existing positions' rates.

### 3.3 The Black-Scholes anchor

The hedge cost is anchored to Black-Scholes valuation:

$$P = K \cdot e^{-rT} \cdot N(-d_2) - S \cdot N(-d_1)$$

where

$$d_1 = \frac{\ln(S/K) + (r + \sigma^2/2)T}{\sigma\sqrt{T}}, \quad d_2 = d_1 - \sigma\sqrt{T}$$

with $S$ = BTC spot, $K$ = strike, $T$ = time-to-expiry, $\sigma$ = implied
volatility from DVOL, $r$ = risk-free rate, and $N(\cdot)$ = standard normal
CDF.

This is **the canonical option-pricing model**, taught in every quantitative
finance program since 1973 and the foundation of every options exchange in
the world. Atticus does not invent pricing; it operationalizes a well-known
model with real-time data feeds.

### 3.4 What's published vs what's internal

The trader sees one number: "your daily rate is $X." Internally the engine
manages:
- Margin floor over BS hedge cost
- Volatility-regime adjustment factors (currently flat for biweekly retail; live
  for legacy 1-day; planned step-table for stress conditions)
- Tier-specific economics that account for the different gamma and theta
  profiles of near-money vs deep-out-of-money options
- Liquidity-adjusted strike selection logic operating at execution time

We deliberately do not publish the rate function or its adjustment factors.
The rate table for retail biweekly is fixed at activation and visible to the
trader; the *path* by which the engine arrived at that table is proprietary.

### 3.5 Validation

The pricing engine has been backtested against **1,558 days of historical
Bitcoin** (~4.3 years), spanning the 2018 bear market, March 2020 COVID
liquidation, May 2021 China crackdown, and November 2022 FTX collapse.
Aggregate result: positive expected daily P&L per $1k of trader notional
across every tier under the current schedule. Stress-regime days produce
controlled losses; calm-and-normal days produce reliable positive spread.
Approximately **85% of historical days are net-profitable** under a
representative tier-mix demand model.

---

## 4. The hedging engine

### 4.1 What we hedge

Every protection is paired with a Deribit (or Falcon X) options position
sized to cover the trader's notional under the stated stop-loss percentage.
We BUY puts (for LONG protection) and BUY calls (for SHORT protection); we
never SELL options on the retail hedge book, eliminating short-volatility
exposure and option-assignment risk.

For treasury, the hedging is structured differently — see §5.

### 4.2 How we choose the option

Strike selection is a multi-criteria optimization:

- Liquidity at the chosen strike (orderbook depth, bid-ask spread)
- Tenor proximity to target (matched to product duration)
- Cost relative to premium collected (margin discipline)
- In-the-money vs out-of-the-money geometry (we prefer ITM on the tightest
  floors because gamma economics favor it on short-tenor puts)

The selector evaluates a small candidate set against a weighted cost score
and picks the best-balanced. The exact weights and adjustment terms are
internal and subject to ongoing calibration.

### 4.3 Take-profit (TP)

When a protection triggers (the trader's payout is owed), the platform's hedge
typically still has remaining time-value. The TP engine identifies the
optimal moment to sell that hedge back to the venue, recovering capital
that funds the payout obligation.

The TP decision is governed by adaptive parameters that scale with:
- Time elapsed since trigger (cooling window before sale)
- Current market vol regime (more cautious in high vol)
- Remaining time-to-expiry on the held option
- Bid availability on the venue order book

The 14-day biweekly product has a structurally better TP profile than the
1-day product because a fresh 14-day option, even after the price has moved,
retains substantial time-value. Empirical replay of historical triggered
trades shows mean recovery improving from approximately 18% on 1-day to
approximately 159% on 14-day — meaning the recovered hedge value can fully
offset (and sometimes exceed) the payout obligation, depending on the
geometry of the price move and remaining time.

### 4.4 Net-pool and hedge inventory (technique under design)

When a triggered hedge is sold or a protection naturally expires, the
underlying option may still hold value. The platform maintains the design
capacity to allocate that residual inventory against subsequent matching
protection requests, reducing the need for fresh hedge purchases. This is
analogous to how reinsurance pools or prime-broker books reuse inventory.

This is documented as a forthcoming optimization activated after pilot data
confirms baseline hedge behavior.

---

## 5. Treasury structured protection

### 5.1 The protective collar

Treasury hedging uses a **protective collar**:

```
Buy:  out-of-money put  (strike below spot — downside protection)
Sell: out-of-money call (strike above spot — premium income)
```

Both legs sized 1:1 against the protected BTC notional, both at the same
expiry. The call premium income partially offsets the put cost; the residual
is the collar's net cost, which is small relative to either leg in isolation.

This is **a hedging technique in continuous use by every major commodity
producer, equity manager, and corporate treasury since the 1980s.** It is
described in CFA curricula, taught in every derivatives course, and operated
by every TradFi asset manager. It is *not*, however, common in DeFi-native
treasury management, where directional spot-holding remains dominant.

### 5.2 Why it works for treasury

A treasury operator (corporate, DAO, fund) typically:
- Holds BTC inventory for strategic / operational reasons
- Cannot tolerate large drawdowns (board-level risk constraints)
- Does not need unlimited upside — they're storing value, not speculating
- Has predictable cash-flow needs that match a subscription model

A collar exactly matches this profile: it bounds downside, accepts capped
upside, and produces predictable monthly cost. **A standard 12-month
backtest against the last four years of Bitcoin price action demonstrates
that a $1M treasury holding 2% downside-protected via collar produces a
+$1.2M settlement vs an unprotected −$1.9M loss.** Three structural reasons
this gap exists:

1. The lower call premium income subsidizes the put cost, so the running
   cost of protection is small relative to the protected notional.
2. The protection never has to be timed. Continuous always-on coverage
   captures the rare but consequential drawdown events (the small number
   of catastrophic days each year that drive most annual loss).
3. The capped upside is not actually "lost" — it's exchanged for the
   downside protection at a fair price discovered by the options market.

### 5.3 Operational mechanics (deliberately at high level)

Atticus operates the collar on behalf of the treasury:
- Subscription terms set notional, floor, upside cap, tenor, settlement
- Atticus opens both legs at activation via Falcon X primary or Deribit backup
- Position is marked-to-market daily; weekly status report to client
- T+1 settlement at end of subscription period or on trigger
- Calendar rolls (Phase 2) refresh time-value as the position ages

The treasury client sees one monthly cost number. Atticus owns the
operational complexity.

---

## 6. Risk controls

The platform operates inside a multi-layer risk framework. We summarize the
shape; the exact thresholds are internal.

### 6.1 Per-trade

- **Position-size cap** per individual protection
- **Daily new-protection cap** at the aggregate level
- **Per-tier daily concentration cap** preventing all-in exposure in a single
  floor tier
- **Aggregate active cap** bounding total open notional

### 6.2 Per-portfolio

- **Hedge budget cap** scaling with operational maturity (initial floor,
  uncapped only after operational confidence)
- **Per-trade rate-limiting** during pilot phase (relaxes as data accumulates)

### 6.3 Per-platform

- **Maximum-loss circuit breaker** triggered by drawdown over a rolling 24h
  window. New protection sales pause until manual reset or cooldown.
- **Auto-renew freeze** in stress regimes, preventing fresh exposure from
  being added at peak volatility prices.
- **Independent trigger monitor** detecting price crosses on a 3-second
  poll cadence.

These layers are intentionally redundant. No single failure mode bypasses
the bounded-loss invariant.

### 6.4 What we explicitly do NOT do

- **Sell options on the retail hedge book.** No assignment risk, no short-vol
  exposure on retail.
- **Use trader funds as float for other traders.** The platform balance and
  pooled traders' premiums are operationally segregated.
- **Operate naked positions.** Every protection is paired with a hedge
  before it is reported live to the trader.
- **Require directional accuracy to be profitable.** The platform earns on
  the spread, not on price moves.

---

## 7. The edge — three sources

The platform's economic edge comes from three structurally durable sources:

### 7.1 Real-time volatility-aware pricing

Bitcoin implied volatility moves in observable patterns (DVOL data is
published continuously). The pricing engine consumes this and emits a rate
that is current to within seconds. A trader's directional view can be
correct *and the pricing can still be right for the platform* because the
platform charges based on the cost of replicating the protection in the
options market — which is what DVOL prices.

A static price list would mispriced rapidly in a moving market. Atticus does
not have a static price list.

### 7.2 Time-value capture on managed hedges

A 14-day option bought to hedge a 14-day protection retains time-value
even after the trigger fires. Selling it at the right moment recovers
capital that funds the payout. Empirically, on the biweekly product, the
recovered value averages around 1.5× the payout obligation — meaning the
platform's net cost on a triggered trade is positive in a meaningful
fraction of cases. This is structural to the tenor and the time-value
geometry of options, not a forecast.

### 7.3 Volume → pricing flywheel via OTC partnership

Atticus is partnered with Falcon X, an institutional OTC desk. Falcon X
prices improve as Atticus delivers more reliable structured volume.
This creates a flywheel:

```
More clients → more volume → better Falcon X pricing →
tighter spreads passed to clients → more competitive product → more clients
```

Treasury clients particularly benefit because their volume is large,
predictable, and structured. Each new treasury client improves pricing
for all existing clients on the platform.

### 7.4 Why these are durable

| Edge | Replicable by competitor | Defensibility |
|---|---|---|
| DVOL-aware pricing | Yes, with engineering effort | Becomes table stakes; required to operate but not differentiating long-term |
| Time-value capture | Yes, with operational discipline | Requires non-trivial TP engineering; few DeFi operators have built it |
| OTC volume flywheel | Hard — requires accumulated volume + counterparty relationship | The strongest moat once cumulative volume exceeds threshold |

Combined, these create a position that is hard to replicate from a standing
start and harder to displace once established.

---

## 8. What the platform measures

For pilot validation and ongoing operations, the platform tracks signals
that diagnose health independently of P&L. Five categories:

| Category | What we watch |
|---|---|
| **Pricing fidelity** | Realized hedge cost vs Black-Scholes expected; deviation indicates microstructure friction |
| **TP recovery efficacy** | Realized recovery vs theoretical; a structural number that informs all economic projections |
| **Liquidity** | Bid-ask spread at execution time; per-venue, per-tenor, per-strike |
| **Concentration** | Per-tier mix, per-direction mix, per-day flow patterns |
| **Drawdown trajectory** | Account equity vs rolling 24h peak; circuit breaker pre-warning |

These metrics are reported via internal dashboards with daily roll-up snapshots
persisted to a metrics table for post-hoc analysis.

---

## 9. What we don't claim

In the interest of honesty:

- **No platform is invincible.** A multi-sigma Black-Swan move at the wrong
  time, simultaneous with venue downtime and Falcon X dislocation, would
  produce loss beyond the bounded scenarios. We design for resilience, not
  invincibility, and our circuit breakers specifically exist to halt
  exposure before such a scenario can compound.
- **The pilot data is small.** Our 1,558-day backtest is comprehensive, but
  live pilot data is fewer than 50 trades. Live trader behavior may diverge
  from backtest assumptions; we monitor and adjust.
- **Recovery rates in stress regimes are modeled, not yet observed.** A
  single triggered protection during a real DVOL > 65 event will be more
  informative than our entire backtest in some respects.
- **We are early in the relationship between Atticus and Falcon X.** The
  pricing flywheel is real but builds with cumulative volume; near-term
  pricing reflects starting-position rather than steady-state.

---

## 10. Why this is timely

DeFi treasury management today resembles equity investing in 1955 — directional
spot holdings with no protection structure, no risk-budgeting framework, and
no widespread use of derivative overlays. TradFi solved this in the 1970s–1980s
with collars, structured notes, and systematic hedging programs. The
infrastructure to bring those techniques to crypto-native treasuries — Bitcoin
options markets, on-chain settlement primitives, real-time vol indices —
has only become operational in the last 18 months.

Atticus is operating a TradFi-standard protection toolkit on top of recently
matured DeFi-adjacent infrastructure. **The technique isn't novel; the
operational deployment in this market is.** That is the window the platform
is positioned in.

---

## Glossary

For sophisticated readers, this is a quick orientation. For investors new to
the terminology, it's a map for verifying claims independently.

- **DVOL** — Deribit's published implied-volatility index for Bitcoin options.
  The BTC equivalent of the VIX. Annualized percentage.
- **Black-Scholes** — The canonical option-pricing model. Given spot, strike,
  tenor, vol, and risk-free rate, it produces a theoretical option price.
  Used industry-wide as a pricing anchor.
- **Tenor / DTE** — Time-to-expiry of an option or protection contract.
- **ITM / OTM / ATM** — In-the-money, out-of-the-money, at-the-money. For a
  put, ITM means strike *above* spot (intrinsic value); OTM means strike
  *below* spot (no intrinsic value, only time-value).
- **Gamma** — Rate of change of option delta with respect to spot. Highest
  for at-the-money options on short tenors. Drives short-tenor put dynamics.
- **Theta** — Rate at which an option loses value per day from time decay.
  The platform's hedge inventory captures theta on retained positions.
- **Collar** — Combination of long put + short call with strikes equidistant
  around spot, capping both downside and upside. Standard treasury hedge.
- **TP (Take-Profit)** — The platform's logic for selling triggered hedges
  back to the venue to recover capital that funds payout obligations.
- **Circuit breaker** — Automated trading halt triggered by predefined
  drawdown conditions; standard risk management primitive.

---

*End of Atticus — How It Works.*
