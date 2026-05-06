# Atticus Vol-Execution Facility — CFO Walkthrough

> **Audience:** Atticus CFO and senior finance team.
> **Purpose:** explain the new institutional vol-execution facility — what
> the customer is doing, what we're doing, what every party in the chain
> earns or pays, and how a single trade flows end-to-end.
> **Format:** one concrete example trade walked through step-by-step, then
> aggregated to monthly economics.
> **Last updated:** 2026-05-06

---

## 1. The four parties

| Party | Role | Phase 1 |
|---|---|---|
| **Foxify Inc.** | DeFi perpetuals platform; our institutional B2B customer | Direct customer (CEO testing as treasury) |
| **Atticus** | Structured product issuer + hedge operator + venue customer | Operates the entire facility |
| **Falcon X / Bullish** | Execution venue (OTC desk or regulated exchange) | Holds our hedge positions |
| **End-traders** *(future state)* | Foxify's platform users | N/A in Phase 1; Phase 2+ they're the originating customer |

### Relationship diagram

```
                        BTC SPOT MARKET
                             ↑
                        (price reference)
                             |
                             |
End-traders        Foxify Inc.       Atticus       Falcon X / Bullish
(future Phase 2+)      ↓                 ↓                    ↓
                  Customer of      Customer of           Holds Atticus's
                   Atticus         the venue            hedge positions
                       ↓                ↓
                  Pays daily       Pays venue
                  premium to       for hedges
                  Atticus
                       ↑
                  Receives
                  trigger
                  payouts
```

---

## 2. The product — capped-payout protection on top of a real options hedge

Atticus sells Foxify a **capped-payout protection product**. Foxify pays a
daily premium; if BTC moves through a 2% boundary, Foxify gets a one-time
$1,000 payout per trigger event.

Behind the scenes, Atticus **hedges the obligation by buying a real BTC
straddle** at the venue. The straddle is a long put + long call, both at
2% out-of-money strikes, 30-day tenor.

The economic gap is the source of Atticus's earnings:

```
Foxify pays Atticus:    fixed $250/pair/day      (capped, simple)
Atticus pays venue:     ~$123/pair/day amortized  (30d straddle, calm regime)
                        ────────────────
Atticus theta carry:    ~$127/pair/day before any triggers fire

When trigger fires:     
  Atticus pays Foxify:  $1,000  (capped)
  Atticus sells venue   ~$1,000-2,500  (depends on how far past 2% BTC went)
   leg back to venue:   
                        ────────────────
Atticus residual:       Variable; positive on continuation moves,
                        ~zero on barely-graze moves
```

This is the **Modified-Y product structure** locked from the prior planning
sessions. Atticus is structurally long-vol with positive convexity.

---

## 3. Single trade — concrete walkthrough

We walk one full trade life-cycle with concrete numbers. **All numbers are
illustrative;** real prices vary with BTC spot, DVOL, and venue spread.

### Setup

| Variable | Value |
|---|---|
| Trade timestamp | Day 1, 09:00 UTC |
| BTC spot at activation | $75,000 |
| Foxify position notional (per leg) | $50,000 |
| Trigger floor (LONG side) | $73,500 (−2%) |
| Trigger ceiling (SHORT side) | $76,500 (+2%) |
| Tenor (Foxify-facing) | Daily, billable up to 30 days |
| DVOL regime at activation | Calm (DVOL ~45) |
| Daily premium (per pair, locked at activation) | $250 |
| Trigger payout (per event, locked at activation) | $1,000 |
| Hedge instrument (Atticus side) | 30-day BTC straddle, 2% OTM strikes |
| Hedge cost (per pair, calm regime) | ~$3,700 upfront |
| Foxify pre-fund balance with Atticus | $10,000 |
| Atticus operating capital at venue | $10,000 |
| Venue credit line (Phase 1) | $50,000 |

### Step-by-step

**Step 0 — Pre-trade state:**

```
Foxify segregated balance @ Atticus:        $10,000
Atticus operating account @ venue:          $10,000
Available venue credit (drawable):          $50,000
Open Foxify positions:                      None
Open Atticus hedge positions:               None
```

**Step 1 — Foxify activates the pair (Day 1, 09:00 UTC):**

Foxify sends API/UI request: "Open LONG-protected $50k + SHORT-protected $50k pair."

Atticus actions:
1. Decrement Foxify balance by $250 (full day prepaid, will reconcile if closed earlier)
2. RFQ the venue for a 30-day straddle: 0.667 BTC notional, 2% OTM strikes
3. Venue quotes ask price ≈ $3,700 (sum of put leg ≈ $2,000 + call leg ≈ $1,700)
4. Atticus accepts; venue executes; position booked under Foxify-attributable sub-account
5. Atticus draws $3,700 from venue credit line

```
Foxify balance:                              $9,750  (−$250 premium)
Atticus venue account:                       $10,000  (unchanged)
Venue credit drawn:                          $3,700 / $50,000
Atticus venue equity at risk on this trade:  $3,700 (the long straddle premium, fully paid)
Open Foxify position:                        1 pair, LONG floor $73,500, SHORT ceiling $76,500
Open Atticus hedge:                          1 × 30-day straddle, 0.667 BTC, K_put=$73,500, K_call=$76,500
```

**Step 2 — Day 1 11:30 UTC: BTC drops to $73,500 (LONG side triggers).**

Atticus actions:
1. Trigger detected via spot feed (Coinbase/Kraken/Binance composite)
2. Credit Foxify balance with $1,000 payout
3. RFQ venue to sell the LONG put leg of the straddle (the call leg stays — SHORT side still open)
4. Venue bids ~$1,200 (intrinsic ~$1,000 + remaining time-value ~$200)
5. Atticus accepts; sells the put
6. $1,200 settles back to Atticus venue account
7. Atticus net residual on this trigger: $1,200 received − $1,000 paid out = **+$200 to Atticus**

```
Foxify balance:                              $10,750  (+$1,000 trigger payout)
Atticus venue account:                       $11,200  (+$1,200 from put unwind)
Venue credit drawn:                          $3,700 (still — call leg still open)
Open Foxify position:                        SHORT side only (LONG closed by trigger)
Open Atticus hedge:                          1 × call leg only (put leg sold)
```

**Step 3 — Day 1 11:31 UTC: LONG side auto-renews at new spot.**

If Foxify enabled auto-renew (his test model does), Atticus immediately re-opens
LONG protection at new spot $73,500, new floor $72,030 (−2% from $73,500).

Atticus actions:
1. Decrement Foxify balance by $125 (½ day premium for remainder of UTC day, per design)
2. RFQ venue for new put leg: 0.681 BTC at K=$72,030, 30-day tenor
3. Venue quotes ~$1,950 (slightly more BTC notional after price drop)
4. Atticus accepts; booked

```
Foxify balance:                              $10,625  (−$125 fresh premium)
Atticus venue account:                       $11,200
Venue credit drawn:                          $5,650 / $50,000
Open Foxify position:                        Pair re-formed (new LONG floor $72,030)
Open Atticus hedge:                          New put leg + original call leg
```

**Step 4 — Day 1 14:00 UTC: BTC rallies to $76,500 (SHORT side triggers).**

Same mechanic as Step 2:
1. Detect trigger
2. Credit Foxify $1,000 payout
3. Sell call leg back to venue, ~$1,250 received
4. Atticus residual: +$250 on this trigger

```
Foxify balance:                              $11,625  (+$1,000)
Atticus venue account:                       $12,450  (+$1,250)
Venue credit drawn:                          $5,650
Open Foxify position:                        LONG only (SHORT closed)
```

**Step 5 — Day 1 14:01 UTC: SHORT auto-renews at new spot $76,500.**

Atticus opens new call leg at K=$78,030, 30-day tenor, 0.654 BTC.

```
Foxify balance:                              $11,500  (−$125)
Atticus venue account:                       $12,450
Venue credit drawn:                          $7,300
```

**Step 6 — Days 2-7: continued operation.**

Assume his model holds: 2.16 triggers/day on average, average move past 2% boundary
of approximately 0.5%. Over 6 more days that's ~13 more triggers, each contributing
approximately +$300 of residual to Atticus and a $1,000 payout to Foxify.

Per day in steady state on this single pair:

```
Foxify balance flow (per day):
  −$250 premium
  +$2,160 trigger payouts (2.16 × $1,000)
  ────
  +$1,910 net to Foxify

Atticus residual flow (per day):
  +$250 premium received
  −$3,700 hedge purchases (estimated 2.16 fresh hedges × ~$1,700 each, calm)
    (note: this number rises with renewals; 30-day theta-carry partially offsets)
  +$3,400 hedge unwinds on triggers (2.16 × ~$1,575 average)
  −$2,160 trigger payouts to Foxify
  ────
  −$210 net to Atticus per day on this pair
   IF average trigger residual is only $300 each.
   
   This is the CHOP-DAY scenario. We accept this as a designed loss.

Atticus's true daily P&L is dominated by trigger residual size, NOT
trigger count. Larger moves past 2% drive substantially higher residual.
At $500 average residual: +$215/day. At $1000 average: +$1,295/day.
```

**Step 7 — Day 7 (Friday EOD UTC): Weekly settlement.**

Per the agreed terms, all daily flows aggregate into a weekly net statement:

```
Foxify weekly statement (illustrative, his model):
  Premium paid:           −$1,750  ($250 × 7)
  Trigger payouts:        +$15,120 ($1,000 × 15.12 triggers)
  ────────
  Net to Foxify balance:  +$13,370
  
Foxify balance at start of week:  $10,000
Foxify balance at end of week:    $23,370
  (Foxify withdraws excess back to operating account, leaving ~$10k working balance)

Atticus weekly statement (illustrative, $300 avg residual):
  Premium received:       +$1,750
  Hedge purchases:        −$23,800 (week of straddle inventory + renewals, regime-dependent)
  Hedge unwinds:          +$23,800 (recovered from triggers, calm regime)
  Trigger payouts paid:   −$15,120
  Residual capture:       +$4,536 (15.12 × $300)
  ────────
  Atticus weekly net:     −$8,834
  
  WAIT — this is the chop-day P&L scenario. Cf. Section 5 for full
  scenario range; this is the worst case with 2.16 triggers all 
  near-graze.
```

### Important note on Step 7's number

The CFO will want to see **both** the chop-day (worst-case) and continuation
(best-case) weekly P&L. **Section 5 covers the full scenario range** so
this single example doesn't mislead. The single-trade walkthrough above
intentionally uses the conservative (chop-day) numbers to set expectations.

---

## 4. Cash flow summary — single trade, single day, single pair

| Party | Inflow today | Outflow today | Net |
|---|---|---|---|
| **Foxify** | +$2,160 (2 triggers @ $1k) | −$500 (premium for day, 2 sides × $250 amortized) | **+$1,660** |
| **Atticus** | +$500 (premium) + ~$2,800 (hedge unwinds) | −$2,160 (Foxify payouts) − ~$1,400 (fresh hedge buys after triggers) | **~−$260 to +$340** depending on trigger residual size |
| **Venue** | +$1,400 (Atticus hedge buys) − $2,800 (paying Atticus on unwinds) | net +$800 to +$2,200 | **Earns spread**: ~$50-150/day per pair on bid/ask |

Atticus's daily P&L per pair is **bounded between approximately −$260 (chop-day worst)
and +$1,300 (continuation-day best)**. Average over typical regime should be
positive but variable.

---

## 5. P&L scenario range — what determines whether we win or lose

Atticus's P&L per pair per day depends on **three independent inputs**:

| Input | Range | Effect |
|---|---|---|
| Trigger count | 0–4+/day | More triggers = more residual capture (good) but also more hedge churn (cost) |
| Average trigger move past 2% | 0–4%+ | Larger moves = larger residual (good); barely-graze = thin residual |
| Hedge purchase price (vol regime) | $1,400–$5,500 per straddle | Higher vol = higher hedge cost (bad) but also higher trigger residual (good) |

Three example outcomes per pair per day:

### Scenario A: Calm market, modest triggers (typical day)

```
DVOL 45, 2.16 triggers, average 0.5% past boundary

Hedge cost amortized:     −$130/day
Premium received:         +$250/day
Trigger residuals:        +$648/day  (2.16 × $300)
Trigger payouts:          −$2,160/day
Hedge unwinds:            +$2,200/day  (matches payouts, slight gain on time value)

Net to Atticus per pair:  +$808/day
```

### Scenario B: Choppy market, barely-graze triggers (worst case)

```
DVOL 50, 3 triggers, all barely-graze (~0.05% past boundary)

Hedge cost amortized:     −$160/day
Premium received:         +$250/day
Trigger residuals:        +$150/day  (3 × $50)
Trigger payouts:          −$3,000/day
Hedge unwinds:            +$3,000/day  (just covers payouts)

Net to Atticus per pair:  −$910 → −$760/day  (LOSS)
```

### Scenario C: Trending market, big-move triggers (good case)

```
DVOL 60, 1 trigger, 3% past boundary

Hedge cost amortized:     −$190/day
Premium received:         +$250/day
Trigger residuals:        +$1,500/day  (1 × $1,500)
Trigger payouts:          −$1,000/day
Hedge unwinds:            +$2,500/day  (large intrinsic capture)

Net to Atticus per pair:  +$1,560/day  (STRONG WIN)
```

### Steady-state expectation

Across regimes and trigger patterns, **expected daily P&L per pair ≈ +$300 to +$700**
in calm/moderate; can compress to flat or modestly negative on chop-heavy days;
spike higher on trending days.

The single biggest CFO concern: **chop-day risk**. Mitigations baked into
the design:
- 30-day hedge tenor → highest theta carry → reduces chop-day loss
- Vol-tier pricing (proposed) → covers cost spike in high-vol regimes
- Position cap (5 pairs Phase 1) → bounds worst-day chop loss to ~$5k
- Stress-regime auto-pause → stops new openings if unit economics deteriorate

---

## 6. Phase 1 monthly economics

Aggregating over Phase 1 (Foxify ramp from 4.3 to 24+ trades/day, ~30-day month):

| Item | Amount |
|---|---|
| Average pairs/day across Phase 1 | ~6 (weighted: weeks 1-2 at 2 pairs, weeks 3-4 at 6, weeks 5-8 at 12) |
| Average daily Atticus P&L per pair (across regimes) | ~+$400 (mid-range expected) |
| Atticus total daily P&L (Phase 1 average) | ~+$2,400 |
| **Atticus total Phase 1 monthly P&L (estimated)** | **~+$70,000** |
| Variance | ±$30,000 depending on regime + chop frequency |

Plus Atticus markup revenue (separate stream): ~$1,500-15,000/month
through Phase 1 ramp (per separate Phase 1 plan).

**Combined Phase 1 monthly Atticus revenue + P&L ≈ $70k–$85k.**

This is gross. Operating cost (engineering salaries, venue fees, ops overhead)
is approximately $20-30k/month. **Phase 1 net contribution to Atticus ≈
$45-55k/month** at expected case.

---

## 7. Capital and risk profile

### Capital deployed at Phase 1

| Pool | Amount | Purpose |
|---|---|---|
| Foxify pre-fund balance | $10,000 | Customer's working balance (not Atticus capital) |
| Atticus operating account at venue | $10,000 | Bridge between weekly settlements |
| Venue credit line (drawable) | $50,000 | Hedge inventory funding |
| **Total effective capital pool** | **$70,000** | Phase 1 operations |

### Maximum loss scenarios

| Scenario | Approximate Atticus loss | Mitigations |
|---|---|---|
| Chop-day across 5 pairs | $4,000–$5,000 | Daily monitoring; escalates to position-cap reduction if sustained |
| Stress regime hedge spike | $3,000–$8,000 over 3 days | Vol-tier pricing kicks in; auto-pause new opens |
| Crisis regime (DVOL 100+) | $10,000–$20,000 over 5 days | Auto-pause new opens entirely; existing hedges continue |
| Venue execution failure mid-trigger | <$5,000 (single-trade max) | Backup venue executes |
| Foxify default on balance | $0 (segregated, won't impact Atticus) | Cancel-anytime, withdraw balance |
| Atticus internal failure | Triggers continue; positions safe at venue | Manual operations runbook |

**Maximum bounded loss across all scenarios ≈ $20,000.** Recoverable in
3-4 weeks of expected operations.

---

## 8. Phase 2 / Phase 3 future state — who originates trades

Phase 1 has **Foxify CEO directly** opening pairs as a treasury / vol-harvest
test. Phase 2 onwards expands to **Foxify's end-traders**.

### Phase 2+ end-trader flow

```
Alice (Foxify end-trader) opens a long perp position on Foxify
       ↓
Alice clicks "Add 2% downside protection" in the Foxify UI
       ↓
Foxify routes API call to Atticus: "Open LONG protection, $X notional, 2% floor"
       ↓
Atticus executes: opens hedge at venue, records protection in our DB
       ↓
Foxify charges Alice the daily premium (e.g., $25/$10k/day)
       ↓
Foxify pays Atticus a slightly lower wholesale rate (Foxify keeps margin)
       ↓
If Alice's perp moves through 2%, Atticus pays Foxify the trigger payout
       ↓
Foxify credits Alice's account with the payout
       ↓
Alice's perp position can be closed normally on Foxify
```

### Key economics in Phase 2+

| Layer | Daily revenue (illustrative) |
|---|---|
| Alice pays Foxify (retail rate) | $25 per $10k/day |
| Foxify pays Atticus (wholesale rate) | $20 per $10k/day |
| **Foxify margin per trade** | $5 per $10k/day |
| Atticus pays venue (hedge cost) | ~$8 per $10k/day amortized |
| Atticus revenue per trade | $20 − $8 = $12 per $10k/day before triggers |

**Foxify becomes a re-seller**, taking margin between retail and wholesale.
Atticus gets predictable wholesale flow. Alice (end-user) sees a simple,
fast protection product on Foxify's platform.

This is a **standard institutional structured-products distribution model**
(retailer → wholesaler → executing entity). It maps cleanly onto how
exchange-traded products are sold via prime brokers.

### KYC chain in Phase 2+

```
Bullish/Falcon X KYCs Atticus (institutional account)
       ↓
Atticus KYCs Foxify Inc. (institutional B2B customer)
       ↓
Foxify KYCs Alice and all end-users (their existing platform KYC)
```

**Atticus is never the direct counterparty to Alice.** This is structurally
critical — it means our compliance scope stops at Foxify, not at Foxify's
millions of potential end-users.

---

## 9. What the CFO should track monthly

| Metric | Target |
|---|---|
| Net Atticus P&L from facility | +$45-55k/month Phase 1, scaling to +$200k+/month Phase 2 |
| Maximum drawdown in any week | <$10k Phase 1 |
| Foxify balance utilization | 30-70% of pre-fund average |
| Venue credit utilization | 30-70% Phase 1 |
| Per-pair P&L distribution | Median +$400/day, p10 −$200, p90 +$1,200 |
| Trigger residual average | $300+ (below this is chop-day red flag) |
| Position cap utilization | 60-80% of cap (room to scale) |
| Settlement reconciliation drift | <0.5% per week |

**Monthly review cadence**: full P&L breakdown by trade, regime distribution,
trigger residual distribution, capital utilization. This becomes the basis
for any Phase 2 capital decisions.

---

## 10. The CFO question we don't yet have a clean answer for

**Open question (honest):** what's our actual realized average trigger
residual? Phase 0 backtests modeled it indirectly via D2's 159% recovery
ratio, but **for vol-harvest pattern usage (his test model), we have not
empirically observed average trigger residual size on biweekly pricing.**

**Phase 1 measures this directly.** First 30 trades produce real data on:
- Distribution of trigger move sizes (barely-graze vs continuation)
- Realized residual per trigger after FX execution costs
- Per-regime variance

**This is the single empirical unknown of the design.** Modified-Y is
expected to be profitable across regimes IF average trigger residual
holds at $300+. If Phase 1 data shows it consistently at $100 or less,
we move to vol-tier pricing immediately and / or shift to wholesale-rate
pricing for Foxify.

The CFO should be aware: **Phase 1 is a data-gathering exercise as much
as a revenue exercise.** Position cap of 5 pairs limits the cost of
discovering a pessimistic answer.

---

## 11. Summary for the CFO

In one paragraph for the CFO's exec memo:

> *Atticus has launched an institutional vol-execution facility with Foxify
> as the anchor customer. Foxify pays a fixed daily premium for capped-payout
> protection; Atticus hedges with 30-day BTC straddles at Falcon X or Bullish.
> Phase 1 deploys ~$70k of working capital ($10k Foxify pre-fund segregated,
> $10k Atticus operating account at venue, $50k venue credit line). Expected
> Phase 1 monthly net contribution: $45-55k against operating costs.
> Maximum bounded downside: ~$20k in extreme scenarios. The product
> structure — selling capped protection while hedging with full
> straddles — produces structural long-vol exposure with positive convexity
> on continuation moves. Phase 1 is a 60-day data-gathering window;
> outcomes drive Phase 2 capital and pricing decisions.*

---

## Appendix A — Black-Scholes pricing for reference

Hedge cost (30-day straddle, 2% OTM strikes, $50k pair, BTC $75k):

| DVOL | Put leg | Call leg | Total straddle | Daily amortized |
|---|---|---|---|---|
| 35 (calm) | ~$1,650 | ~$1,400 | ~$3,050 | ~$102/day |
| 45 (calm-mod) | ~$2,000 | ~$1,700 | ~$3,700 | ~$123/day |
| 55 (moderate) | ~$2,400 | ~$2,000 | ~$4,400 | ~$147/day |
| 65 (elevated) | ~$2,800 | ~$2,400 | ~$5,200 | ~$173/day |
| 80 (stress) | ~$3,800 | ~$3,200 | ~$7,000 | ~$233/day |
| 100 (crisis) | ~$5,400 | ~$4,500 | ~$9,900 | ~$330/day |

Black-Scholes formula reference:

$$P = K \cdot e^{-rT} \cdot N(-d_2) - S \cdot N(-d_1)$$

$$C = S \cdot N(d_1) - K \cdot e^{-rT} \cdot N(d_2)$$

with $d_1 = \frac{\ln(S/K) + (r + \sigma^2/2)T}{\sigma\sqrt{T}}$, $d_2 = d_1 - \sigma\sqrt{T}$.

Inputs: $S$ = BTC spot, $K$ = strike, $T$ = years to expiry (30/365 here),
$\sigma$ = implied vol from DVOL, $r$ = 5% risk-free.

Anyone with a derivatives background can verify our pricing claims against
these formulas independently.

---

*End of CFO walkthrough.*
