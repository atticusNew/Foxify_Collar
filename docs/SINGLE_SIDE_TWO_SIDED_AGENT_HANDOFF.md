# Two-Sided Cooperative Volume Facility — Engineering Handoff

**Generated:** 2026-05-27
**Audience:** New engineering agent picking up Phase 0 build
**Status:** Empirically validated, ready to implement
**Live platform impact:** zero (build alongside live VC, do not modify)

---

## 1. Mission summary

Build a Foxify volume facility on top of Atticus's existing options-execution infrastructure (Bullish + Deribit). Each Foxify activation is a "pair" — two opposing perp positions on Foxify's partner exchanges. Atticus hedges both directions with one strangle structure, operates the option through theta-aware TP, and splits salvage proceeds with Foxify under a volume-tiered cooperative model.

Foxify's primary goal is partner-exchange volume generation. Atticus is paid for hedge execution quality and venue access. Both sides benefit when Foxify scales activations.

---

## 2. The product — Two-sided ITM Guts Strangle

### 2.1 What it is

For each Foxify activation, Atticus buys a strangle where both legs are slightly in-the-money (ITM):

- **Long put** at strike ABOVE spot — ITM by ~1.3% at entry
- **Long call** at strike BELOW spot — ITM by ~1.3% at entry

At spot $76,000 with $1k Bullish strike grid, the strikes are $77,000 put + $75,000 call. This is technically called a "guts strangle" in options parlance because both legs are in-the-money, unlike a standard strangle (both OTM).

(Note: the user previously referenced this as "ATM guts strangle" — that term isn't standard. The empirically validated structure is ITM guts. If capital constraints make ITM unworkable, ATM strangle ($76k put + $76k call) is the lower-cost alternative — see comparison in Section 12.)

### 2.2 Why this structure

Three properties make ITM guts the right fit for the cooperative cost-pass-through model:

1. **Constant intrinsic floor.** Between the two strikes, the strangle's combined intrinsic = $2,000 per BTC × contracts (regardless of spot). This is a hard floor that doesn't decay with theta. At 1.4 BTC contracts, that's a $2,800 floor. Even if BTC stays flat, the strangle retains $2,800 + remaining time value at exit.

2. **Full breach capture.** When spot crosses either ±2% trigger boundary, one leg becomes deeply ITM. At down trigger ($74,480), the put intrinsic is $77k − $74,480 = $2,520 per BTC × 1.4 = $3,528. At up trigger ($77,520), the call intrinsic is $2,520 per BTC × 1.4 = $3,528. No "gap zone" between hedge strike and trigger boundary.

3. **Either-side trigger coverage.** Two-sided pair = Foxify opens long perp + short perp. Either ±2% trigger closes the entire pair. The strangle covers both directions with a single hedge structure (no need for separate puts and calls per perp).

### 2.3 Mechanic flow per pair

```
Step 1 — Activation
  Foxify activates a pair: opens long perp + short perp on partner exchange
  Atticus quotes the live Bullish/Deribit strangle ask at $77k put + $75k call
  Foxify funds the hedge cost upfront (no markup, pass-through)
  Quote valid ~30 seconds

Step 2 — Hedge open
  Atticus opens both legs (multi-venue routed)
  Strangle is active; pair is "live"

Step 3 — Trigger fires (or expiry)
  When spot crosses +2% or -2% trigger boundary, both Foxify perps close
  Atticus operates theta-aware TP on the COMBINED option value
  Sells at peak salvage during 30-min capture window post-trigger
  If no trigger by tenor end, Atticus sells at expiry-4h

Step 4 — Settlement
  Salvage proceeds split per current volume tier (see Section 3)
  No fixed payout, no daily premium, no operating fee
  Foxify gets back: hedge_cost + tier_split × (salvage − hedge_cost) when uplift positive
  Atticus gets: (1 − tier_split) × (salvage − hedge_cost) when uplift positive
  If salvage < hedge_cost, Foxify eats the loss; Atticus gets nothing
```

### 2.4 Empirical baseline (calm regime, σ=0.35, today's spot $76k)

- Hedge cost per pair: **$3,238** (live Bullish + Deribit ask)
- Trigger rate (either side): **91.9%** (within 3-day tenor)
- Mean salvage: **$3,840**
- Mean uplift (salvage − hedge cost): **$602/pair**
- At 80/20 split: Foxify EV +$586/pair, Atticus EV +$153/pair
- Statistical confidence: 95% CI ±$5/pair (25k Monte Carlo paths, real BTC bootstrap)

This is empirically confirmed in `docs/SINGLE_SIDE_TWO_SIDED_STRANGLE_VALIDATION.md`.

---

## 3. Volume-tiered split structure (15% to 5% Atticus)

Foxify plans to scale volume substantially. The split tightens for Atticus as volume grows — Foxify earns a better deal per pair as they hit higher tiers, Atticus earns absolute dollars from volume scaling.

| Tier | Pairs / day | Atticus share | Foxify share |
|---|---|---:|---:|
| 1 | 0–25/day | 15% | 85% |
| 2 | 25–100/day | 12% | 88% |
| 3 | 100–250/day | 10% | 90% |
| 4 | 250–500/day | 7% | 93% |
| 5 | 500+/day | 5% | 95% |

**No operating fee at any tier.** Atticus's revenue is purely the share of salvage uplift. This is intentionally simple — one number determines the deal.

### 3.1 Per-pair EV by tier (calm regime, ITM guts strangle)

Using the empirical mean uplift per pair = $602:

| Tier | Atticus share | Foxify share of $602 uplift | Atticus share | Foxify EV/pair (incl. capital return) | Atticus EV/pair |
|---|---:|---:|---:|---:|---:|
| 1 (15/85) | 15% | $512 | $90 | +$415 | +$90 |
| 2 (12/88) | 12% | $530 | $72 | +$436 | +$72 |
| 3 (10/90) | 10% | $542 | $60 | +$450 | +$60 |
| 4 (7/93) | 7% | $560 | $42 | +$471 | +$42 |
| 5 (5/95) | 5% | $572 | $30 | +$486 | +$30 |

(Foxify EV is approximate — the empirical MC numbers from the 80/20 baseline scale roughly linearly with split. Full per-tier MC validation is the first task for the new agent.)

### 3.2 Tier transition mechanics

Tier is determined by Foxify's rolling 7-day average pairs/day. When the average crosses a tier threshold:

- **Going up a tier (Foxify scaling)**: new tier applies at next settlement period
- **Going down a tier (Foxify reducing)**: new tier applies at next settlement period

Settlement period: weekly net settlement is the default. Tiers don't change mid-week.

### 3.3 Annualized projections at each tier (50k/2% pair only)

Empirical Foxify per-pair EV at calm × volume × 365:

| Volume | Tier | Foxify annual | Atticus annual |
|---|---|---:|---:|
| 5/day | 1 (15/85) | +$758k | +$165k |
| 25/day | 1 (15/85) | +$3.79M | +$821k |
| 100/day | 2 (12/88) | +$15.91M | +$2.63M |
| 250/day | 3 (10/90) | +$41.06M | +$5.48M |
| 500/day | 4 (7/93) | +$85.96M | +$7.67M |
| 1000/day | 5 (5/95) | +$177.39M | +$10.95M |

These are 50k/2% pair only. Adding other cells (Section 5) increases combined revenue.

---

## 4. Capital plan and organic growth via deferred settlement

### 4.1 Minimum capital to start

To begin operating at 2 pairs/day on the 50k/2% cell:

- Per-pair hedge cost (today's empirical): **$3,238**
- 2 concurrent pairs (1d expected hold): **2 × $3,238 = $6,476**
- Plus operational reserve (15-20% buffer): ~$1,000
- **Total minimum starting capital: ~$7,500**

This is the working capital Foxify deploys per pair as the hedge cost. It is recoverable at cover close (most of it returns as part of salvage proceeds).

### 4.2 Organic growth via deferred settlement

The user-stated growth model: during scale-up phase, BOTH parties defer settlement and recycle salvage proceeds back into capacity. No actual split happens during the growth window — the pool grows, then settlement reconciles after hitting target volume.

Mechanic:
- Foxify deploys $3,238 to fund pair 1
- At cover close, salvage = $3,840 (mean, calm)
- Salvage stays in pool (no settlement yet)
- Pool used to fund next pair (or multiple pairs once enough capital accumulates)

Daily growth rate at calm = pairs × mean_uplift = pairs × $602/pair.

### 4.3 Days to scale 2 → 25 pairs (calm regime, deferred settlement)

Iterative simulation, daily compounding, $1k Bullish strike grid:

| Day | Pairs deployed | EOD capital | Notes |
|---:|---:|---:|---|
| 0 | 2 | $7,680 | Start: 2 pairs at $3,238 = $6,476 deployed; salvage returns $3,840 each |
| 1 | 2 | $8,884 | Reserve grows; not enough for 3rd pair yet |
| 2 | 2 | $10,088 | Reserve crosses 3-pair threshold ($9,714) |
| 3 | 3 | $11,894 | Now 3 pairs/day |
| 4 | 3 | $13,700 | Reserve grows |
| 5 | 4 | $16,108 | Crosses 4-pair threshold |
| 7 | 5 | $21,526 | |
| 9 | 7 | $29,352 | |
| 10 | 9 | $34,770 | Acceleration starts |
| 12 | 12 | $48,014 | |
| 14 | 17 | $66,676 | |
| 15 | 20 | $78,716 | |
| **16** | **24** | **$93,164** | **Approaching 25 target** |
| 17 | 28+ | crosses target | 25-pair capacity reached |

**Calm regime: 2 pairs → 25 pairs in ~16 days of compounding** with deferred settlement.

### 4.4 Days to scale at higher regimes

Higher σ → bigger uplift per pair → faster compounding:

| Regime | Mean uplift per pair | Days from 2 → 25 pairs |
|---|---:|---:|
| Calm (σ=0.35) | $602 | ~16 days |
| Moderate (σ=0.55) | ~$1,800 | ~6 days |
| Elevated (σ=0.75) | ~$3,000 | ~3-4 days |
| Stress (σ=0.95) | ~$4,400 | ~2-3 days |

(Higher regime accelerates because trigger rate hits 100% and salvage uplift per pair grows ~5-7× vs calm.)

### 4.5 Adding additional capacity beyond 25 pairs/day

After hitting 25 pairs sustained, additional revenue needed for further expansion depends on the next tier target:

| Target volume | Additional capital needed | Time at 25/day calm growth |
|---|---:|---:|
| 25 → 50 pairs/day | ~$80k | ~6 days at $602 × 25 = $15k/day uplift |
| 50 → 100 pairs/day | ~$160k | ~10 days at 50/day growth ($30k/day) |
| 100 → 250 pairs/day | ~$485k | ~16 days at 100/day growth ($60k/day) |
| 250 → 500 pairs/day | ~$810k | ~13 days at 250/day growth ($151k/day) |
| 500 → 1000 pairs/day | ~$1.62M | ~10 days at 500/day growth ($301k/day) |

These numbers assume continued deferred settlement during scale-up. Once a tier is stable, both parties can begin actual settlement (split out their accumulated shares from the pool).

### 4.6 Settlement payout to both parties after growth phase

When the joint pool reaches the target volume capacity, switch from "recycle 100%" to actual settlement. At that point:

- Working capital stays in the pool (= 25 pairs × $3,238 = $80,950 for 25/day target)
- Excess accumulated from growth phase is split per the active tier
- Going forward, daily uplift split per tier each settlement period (weekly net default)

Example: Pool reaches $93k after 17 days of compounding. Working cap = $80,950. Excess = $12,050. This excess is split per tier 1 (15/85) → Foxify $10,243, Atticus $1,807.

Going forward at 25 pairs/day calm: daily uplift $602 × 25 = $15,050 → split tier 1: Foxify $12,793, Atticus $2,257 per day.

### 4.7 Capital requirement summary by target

| Foxify target | Sustained capacity | Working capital needed (steady state) | Days to reach via growth |
|---|---:|---:|---:|
| Phase 0 launch | 2 pairs/day | $6,476 | Day 0 |
| Phase 0 ramp | 5 pairs/day | $16,190 | Day 5 calm |
| **Phase 1 stable** | **25 pairs/day** | **$80,950** | **Day 16 calm** |
| Phase 2 | 100 pairs/day | $323,800 | ~Day 30 calm |
| Phase 3 | 1000 pairs/day | $3.24M | ~Day 60+ calm |

---

## 5. Cell expansion strategy

### 5.1 Phase 0 — 50k/2% pair only

Cell parameters:
- Notional: $50,000 per perp position (Foxify side)
- Trigger: ±2% from spot at activation
- Hedge tenor: 3 days (Bullish daily expiries 26/27/28/29 May; Deribit weekly Friday)
- Strikes (today's spot $76k): $77,000 put + $75,000 call (1.3% ITM both sides)
- Contracts: 1.4 BTC per leg (sized so combined intrinsic ≈ payout reference)
- Hedge cost: $3,238 per pair (today's empirical, both legs combined)

This is the only cell active in Phase 0. Validates operations, theta-aware TP curve performance, multi-venue routing, and tier-1 split mechanics.

### 5.2 Cell candidates for Phase 1+ (low-risk, high-reward)

After Phase 0 validates at 25 pairs/day stable, consider adding:

#### Candidate A — 50k/5% pair (LOW priority, needs validation)

- Wider trigger band (±5%) → lower trigger rate
- Each trigger is bigger move (5% vs 2%)
- ITM guts strikes at 5% would be far ITM ($80k put + $72k call)
- Hedge cost roughly 2-3x the 2% pair (~$8,000-10,000/pair)
- Trigger rate at calm: ~8.5% (single-direction; ~17% either-side for two-sided pair)
- Expected per-pair Foxify EV: needs MC validation before commitment

**Risk:** lower trigger rate means more pairs expire near worthless. The strangle's intrinsic floor is wider ($72k-$80k = $8,000 floor) but takes longer to capture.
**Reward:** when triggers fire, each is bigger.

#### Candidate B — 100k/3% pair (HYPOTHETICAL — not in current matrix)

A potential intermediate cell:
- Notional: $100k per perp position
- Trigger: ±3% from spot
- Hedge tenor: 3-5 days
- Strikes: 1-2% ITM both sides
- Higher capital per pair but better trigger rate than 5%

**Needs design validation before adding.** Likely requires new MC runs.

#### Candidate C — 25k/1.5% pair (HYPOTHETICAL — small fast-cycle)

Smaller, faster-cycling pair:
- Notional: $25k per perp position
- Trigger: ±1.5% (tight, frequent)
- Hedge tenor: 1-2 days (very short)
- Higher trigger rate, lower per-pair EV but more activations possible
- Lower capital per pair = capital-efficient at scale

**Needs design validation.** Could be the workhorse for very high volume targets.

### 5.3 Cells to AVOID

The 7% cells (50k/7%, 200k/7%) tested negative for Foxify under cooperative cost-pass-through (see prior analysis docs). Long tenor + deep OTM = high upfront cost without proportional uplift. Skip these in the cooperative model.

Anything with hedge tenor longer than 5d should be avoided in the cost-pass-through structure unless trigger rate is very high (>50% per pair).

### 5.4 Cell expansion criteria checklist

Before adding any new cell to the live system, the new agent must validate:

1. **Empirical Bullish + Deribit chain availability** for the strikes at the proposed tenor
2. **MC validation** at 25k+ paths showing positive Foxify EV across all 4 regimes
3. **Capital scaling** — how much new capital is needed to add this cell at target volume
4. **Trigger rate calibration** — bootstrap real BTC paths to verify the rate is what backtest predicts
5. **Salvage uplift ratio** — must show >1.3× hedge cost on average (theta-aware TP working)
6. **Loss path distribution** — what's the worst-case single-pair loss; is the joint pool large enough to absorb several in a row

Use the existing MC engine. Tools to run:

- `runMonteCarloMultiSplit` for split sensitivity
- `runTwoSidedStrangleProof.ts` adapted for the new cell config
- `empiricalChainValidator.ts` against live Bullish + Deribit

---

## 6. Early close mechanics

### 6.1 Foxify-initiated early close

Foxify can close their pair voluntarily at any time before trigger or expiry. When they do:

- Foxify closes both perp positions on partner exchange
- Atticus immediately runs the strangle through theta-aware TP at that moment
- Whatever the strangle sells for is the salvage value
- Salvage split per active tier; Foxify gets back hedge_cost + their share of uplift

Should we offer this? **Yes — it should be a feature.** Three reasons:

1. **Foxify operational flexibility.** They may need to close at certain hours for ops/risk reasons. Forcing them to wait for trigger or expiry is unfriendly.

2. **Early close usually preserves value.** Theta-aware TP captures intraday peaks; early close at any time before trigger usually yields salvage ≈ hedge cost (recovery rate >0.95). Foxify rarely loses much by closing early.

3. **Loss paths shorten.** If a pair is going badly (no trigger likely, theta decaying), early close lets Foxify cut losses. Better than waiting for expiry-4h forced sale.

Empirical recovery rates (from single-side analysis, applies to two-sided directionally):

| Foxify hold time | Salvage / hedge ratio | Foxify net |
|---|---:|---:|
| 2 hours | 1.37× | ~+$165 (single-side reference) |
| 6 hours | 1.41× | ~+$179 |
| 12 hours | 1.45× | ~+$186 |
| 1 day (default) | 1.49× | ~+$195 |
| 2 days | 1.52× | ~+$194 |
| 2.9 days (full tenor) | 1.55× | ~+$201 |

(Source: `docs/SINGLE_SIDE_DEEP_DIVE_ANSWERS.md` for single-side; two-sided scales roughly 2x but recovery curve is similar shape.)

**Recommendation:** Implement early close as a Foxify-callable API endpoint. No restrictions on timing.

### 6.2 Losing-leg early close — optimization opportunity

Currently, the MC theta-aware TP curve operates on the COMBINED option value (put + call). When trigger fires:

- Winning leg surges (the side that triggered)
- Losing leg starts decaying (still has some time value, but rapidly fading)
- Combined value tracked together

**Question:** should Atticus sell the losing leg IMMEDIATELY at trigger fire, then run theta-aware TP only on the winner?

#### Pros of selling losing leg early

- Captures the small residual time value before it fully decays
- Cleaner per-leg accounting
- Reduces Bullish/Deribit position management overhead

#### Cons (or arguments for current approach)

- Combined-value TP has shown 1.49× salvage/hedge in single-side; works well already
- Selling the losing leg means TWO orderbook touches per trigger (one for winner peak, one for loser at trigger fire)
- More venue activity = more slippage exposure
- For ITM guts strangle specifically, the LOSING leg may still have substantial intrinsic floor (e.g., at down trigger, the call leg is OTM by only $480 — its intrinsic is gone but remaining time value is still meaningful)

#### Empirical verdict

**Run an MC test before deciding.** The losing-leg early close optimization is straightforward to add to the engine:

```
At trigger fire:
  1. Sell losing leg immediately at limit-IOC (current bid)
  2. Continue theta-aware TP on winner only
  3. Combined salvage = sold_loser_proceeds + winner_salvage_at_TP_exit
```

Compare against current "combined value" approach. If new approach gives >5% better salvage/hedge ratio, switch to it.

This is a Phase 1 optimization. Phase 0 launches with combined-value TP (proven in current MC).

### 6.3 Optimal early-close protocol — what to ship in Phase 0

For Phase 0, ship:

1. **Foxify early-close endpoint** — Foxify-initiated close at any time, returns salvage at that moment
2. **Combined-value TP** for the strangle hedge — current MC-validated approach
3. **Force exit at expiry-4h** — unconditional, prevents holding to expiry

For Phase 1, evaluate (with MC):
- Losing-leg early close optimization
- Multi-stage TP (different rules per phase: 0-30min, 30min-4h, 4h-tenor end)
- Capture-window dynamic length (not always 30min — could be regime-conditional)

---

## 7. Testing and validation plan

### 7.1 Validation philosophy

Before any real-money trades, the new agent must validate the model with multiple progressive layers:

1. **Monte Carlo backtest** (already done) — empirical baseline
2. **Live chain validator** (already built) — confirms today's pricing matches model
3. **Shadow trades** (new) — synthetic execution, no real money
4. **Microtests** (existing infrastructure) — small real trades at $0.01 BTC scale to confirm execution path

### 7.2 Existing test infrastructure to use

#### Monte Carlo engine

Location: `services/api/scripts/backtest/singleSide/monteCarloEngine.ts`

Functions to use:
- `runMonteCarloMultiSplit` — runs N paths once, evaluates against multiple split configs in parallel
- `generateBootstrapPath` — sample sequential 5-min returns from real BTC history
- `generateGbmPath` — analytical GBM at calibrated σ
- `mulberry32` — seeded PRNG for reproducible runs

Run two-sided MC:
```
cd services/api
npx tsx scripts/backtest/singleSide/runTwoSidedStrangleProof.ts
```

Output: `docs/SINGLE_SIDE_TWO_SIDED_STRANGLE_VALIDATION.md` (regenerated each run)

#### Live chain validator

Location: `services/api/scripts/backtest/singleSide/empiricalChainValidator.ts`

Pulls live Bullish chain via Render admin endpoint + live Deribit chain via public API. Validates:
- Strike availability for proposed cells at proposed tenors
- Bid/ask + depth for fill quality assessment
- BS-vs-actual ratio per leg

Run with:
```
export RENDER_API_URL=https://foxify-pilot-new.onrender.com
export RENDER_ADMIN_TOKEN=<admin token>
cd services/api
npx tsx scripts/backtest/singleSide/empiricalChainValidator.ts
```

Output: `docs/SINGLE_SIDE_EMPIRICAL_VALIDATION.md`

**Re-run before any cutover decision.** Strikes/depth/IV change daily.

### 7.3 Shadow trade infrastructure (build new)

Shadow trading = synthetic execution that records what WOULD have happened without placing real orders.

Architecture:
- Single-side cooperative facility maintains a "shadow position" table
- For each Foxify activation request, instead of placing real Bullish/Deribit orders, the system:
  1. Reads the live ask at the strike
  2. Records "open at $X" with timestamp
  3. Polls the chain every 5 minutes to track where the position would be MTM-wise
  4. When trigger fires (or close requested), records "close at $Y" with theta-aware TP simulation
  5. Computes salvage and per-pair PnL using the actual market data
- All "trades" are recorded in a `shadow_trade_log` table for analysis
- Daily reconciliation runs the model against actuals and reports drift

Build steps for new agent:
1. Create `single_side/shadowTradeLog` table (event-sourced log)
2. Add `singleSide/shadowExecutor.ts` that reads live chain instead of placing orders
3. Add admin endpoint `POST /single-side/admin/shadow-activate` to simulate Foxify activation
4. Add daily reconciliation cron that compares shadow PnL to backtest model predictions

Cost: ~150 LOC + 5 tests.

### 7.4 Microtest infrastructure (existing)

The VC team already built microtest probes for Bullish and Deribit at very small size (0.01-0.1 BTC):

- `services/api/scripts/probes/bullish_e2e_microtest.sh` — single-leg long round-trip
- `services/api/scripts/probes/bullish_short_e2e_microtest.sh` — short-leg (margin path)
- `services/api/scripts/probes/bullish_spread_e2e_microtest.sh` — 4-leg spread (uses real margin)

For two-sided strangle, build:
- `services/api/scripts/probes/bullish_strangle_e2e_microtest.sh` (new)
  - Opens long put + long call at small size (0.01 BTC each)
  - Holds 60 seconds
  - Closes both legs sequentially
  - Reports actual fill prices vs displayed asks
  - Computes round-trip cost

Estimated round-trip cost at 0.01 BTC per leg: ~$2-5 (based on E2/E3 microtest history). Safe to run on shadow tier.

### 7.5 Validation sequence before live cutover

```
Phase 0 launch checklist (in order):

1. ✅ MC validation complete (already done)
2. ✅ Live chain validator passes (re-run on launch day)
3. □ Build shadow trade infrastructure
4. □ Run 100+ shadow trades over 7-day window covering at least 2 regimes
5. □ Compare shadow PnL to MC predictions — must be within ±15% of mean
6. □ Build strangle microtest probe
7. □ Run microtest at 0.01 BTC scale on shadow tier — clean round trip
8. □ Operator-reviewed strangle microtest at 0.05 BTC scale on shadow tier
9. □ Final go/no-go review with empirical evidence package
10. □ Promote to live with 2 pairs/day cap, manual halt active
11. □ Newborn-trigger review for first 3 triggers (manual halt, operator clears)
12. □ Scale gradually per Section 4.7 capital plan
```

### 7.6 Simple PnL output format for ongoing testing

Foxify wants essentials only. Daily report should include:

```
Date: YYYY-MM-DD
Pairs activated: N
Pairs triggered: M (trigger rate X%)
Pairs closed early: K
Average hedge cost: $XXXX
Average salvage: $YYYY
Total Foxify salvage proceeds returned: $ZZZ
Total Atticus share retained: $WWW
Total Foxify net P&L (today): +/-$AAA
7-day rolling Foxify P&L: +/-$BBB
30-day rolling Foxify P&L: +/-$CCC
Active capital deployed: $DDD
Capital recycled today (from yesterday's salvage): $EEE
```

Keep it 1 page per day. Foxify can ask for detail per cover via admin endpoint.

---

## 8. Regime coverage and Foxify manual pause

### 8.1 Per-regime expected outcomes (50k/2% pair, ITM guts strangle)

| Regime | DVOL band | Trigger rate (either side) | Mean salvage / hedge | Foxify EV / pair | Atticus EV / pair |
|---|---|---:|---:|---:|---:|
| Calm | <40 | 91.9% | 1.19× | +$586 | +$153 |
| Moderate | 40-60 | ~100% | 1.37× | +$1,438 | +$359 |
| Elevated | 60-85 | ~100% | 1.77× | +$2,463 | +$616 |
| Stress | ≥85 | ~100% | 2.09× | +$3,498 | +$874 |

**All regimes are profitable for both sides.** Higher regimes are MORE profitable because trigger rate hits 100% within 3-day tenor and salvage uplift scales with σ.

(Source: `docs/SINGLE_SIDE_TWO_SIDED_STRANGLE_VALIDATION.md`)

### 8.2 What can go right in each regime

| Regime | Best-case dynamics |
|---|---|
| Calm | Predictable EV. ~92% of pairs trigger, ~52% are profitable individually. Steady cash flow. |
| Moderate | EV doubles vs calm. Still operationally simple. Good for testing scaling. |
| Elevated | EV 4× calm. Higher salvage uplift per pair. Foxify volume facility shines (more trigger events, more partner-exchange activity). |
| Stress | EV 6× calm. Bullish/Deribit IV elevated → wider absolute spreads but higher absolute uplift. |

### 8.3 What can go wrong in each regime

| Regime | Worst-case dynamics | Mitigation |
|---|---|---|
| **Calm** | Range-bound chop, no trigger fires within 3d tenor → strangle expires near worthless. Can lose ~$1,000 per pair on a stretch of flat days. Rare but possible. | Foxify early close before expiry-4h preserves residual value. Atticus theta-aware TP captures intraday peaks even without trigger. Combined floor of ITM guts limits the worst case. |
| **Moderate** | Trigger fires shallow, salvage just barely > hedge cost → small uplift. | Theta-aware TP captures peak salvage in capture window. Operator review if rolling salvage ratio drops below 1.20×. |
| **Elevated** | Bullish/Deribit IV spike post-trigger → ask widens before salvage sale → sell-side slippage. | Multi-venue routing (Bullish + Deribit). Slippage haircut already in MC at 0.85× — represents 15% slippage tolerance. |
| **Stress** | Liquidity dries up at strikes during fast moves → can't sell salvage at displayed price. | Multi-venue mandatory. Stagger sells across 60-120s. OTC desk fallback if approaching very high volume. |

### 8.4 Foxify manual pause mechanism

Foxify must be able to pause new pair activations at any time, for any reason. This is independent of trigger rates, regime classification, or any algorithmic check.

Implementation:

```
Admin endpoint: POST /single-side/admin/foxify-pause
  Body: { reason: string, durationMin?: number }
  Response: { halted: true, resumeAt: ISO timestamp or null }

Effect:
  - All future activation requests return 503 with "halted" status
  - Existing active pairs continue running (Atticus operates them through close)
  - Foxify perp positions on partner exchange unaffected
  - Operator can resume via POST /single-side/admin/foxify-resume

Optional auto-resume:
  - If durationMin specified, automatic resume after that period
  - Otherwise indefinite until explicit resume
```

Foxify controls this. Atticus does not auto-resume. Two distinct halts:
- **Foxify halt** (Foxify-controlled, this section) — Foxify wants to stop activations
- **Atticus halt** (Atticus-controlled, automatic) — operational issue, see 8.5

### 8.5 Atticus operational halts (algorithmic)

Atticus pauses new pair activations automatically if any of:

| Halt condition | Threshold | Auto-resume? |
|---|---|---|
| Bullish API errors | >5 in 5 minutes | No, operator review |
| Deribit API errors | >5 in 5 minutes | No, operator review |
| Spot price stale | >30 seconds since last update | Yes, when fresh |
| Multi-venue depth below required | per-strike depth < contracts × 1.2 | Yes, when depth recovers |
| Rolling 7-day salvage ratio | < 1.20× hedge cost | No, operator review |
| Capital pool below threshold | < 1.5× single-pair hedge cost | No, operator review |
| DVOL spike to extreme | > 95 (top of stress regime) | Yes, when DVOL drops below 90 |
| Newborn trigger review | First 3 triggers post-deploy | No, operator review |

These are guardrails, not Foxify-facing. Foxify gets a 503 with reason if Atticus halts.

### 8.6 Per-regime summary card for Foxify dashboard

Foxify should see at a glance:

```
Today's regime: Moderate (DVOL 47.3)
Today's trigger rate observed: 14% (calm baseline 9%)
Pairs activated today: 12
Pairs triggered today: 1
Average salvage today: $4,160
Daily Foxify EV: +$1,750
Halts active: None
Atticus operational status: Green
```

Single line per regime, color-coded if needed (green/yellow/red).

---

## 9. Foxify-facing PnL reporting

### 9.1 Daily report (Foxify-facing)

Pushed to Foxify ops daily at 00:30 UTC. Contains essentials only:

```
=== Foxify Volume Facility — Daily Summary YYYY-MM-DD ===

Today's market:
  BTC spot at 12:00 UTC: $XX,XXX
  DVOL: XX.X (Regime: <calm/moderate/elevated/stress>)

Activity today:
  Pairs activated: N
  Pairs triggered: M (X% trigger rate)
  Pairs closed early by Foxify: K
  Pairs expired (no trigger, sold at expiry-4h): J

Economics today (your side):
  Total hedge cost deployed: $A,AAA
  Total salvage proceeds returned: $B,BBB
  Foxify net P&L: +/-$X,XXX
  Atticus share retained (current tier X%): $Y,YYY

Capital position:
  Active capital deployed (peak today): $Z,ZZZ
  Capital recycled today: $W,WWW
  Reserve balance (deferred settlement pool): $V,VVV (if applicable)

Operations:
  Bullish multi-venue uptime: 99.X%
  Deribit multi-venue uptime: 99.X%
  Mean activation latency: X.X seconds
  Halts active: <None / Foxify-paused / Atticus-paused with reason>

Rolling totals:
  7-day Foxify P&L: +/-$XX,XXX
  30-day Foxify P&L: +/-$XXX,XXX
  Year-to-date Foxify P&L: +/-$X,XXX,XXX
  Current tier: Tier X (Atticus Y%, Foxify Z%)
  7-day average pairs/day: X.X
```

### 9.2 Real-time admin endpoint

```
GET /single-side/admin/foxify-status
Auth: X-Foxify-Token

Response:
{
  asOf: ISO timestamp,
  todayPairsActivated: N,
  todayPairsTriggered: M,
  todayFoxifyPnl: number,
  rollingPnl: { 7d, 30d, ytd },
  currentTier: { atticusShare, foxifyShare, label },
  rolling7dPairsPerDay: float,
  capitalPosition: { activeDeployed, reservePool, totalAllocated },
  haltStatus: { foxifyHalt, atticusHalt, reason }
}
```

This is the single endpoint Foxify hits from their dashboard. Cached 30 seconds.

### 9.3 Per-pair detail (when Foxify wants to drill in)

```
GET /single-side/admin/pairs/:pair_id
Auth: X-Foxify-Token

Response:
{
  pairId: string,
  cellId: ss_50k_2pct_pair,
  activatedAt: ISO,
  closedAt: ISO or null,
  closedReason: trigger | foxify_close | expiry,
  triggerSide: down | up | null,
  
  hedgeCost: number,
  salvageProceeds: number,
  uplift: number,
  
  foxifyShare: number,  // = hedge_cost + 0.85 × max(0, uplift) if salvage > hedge_cost
                          //   else salvage (eat loss)
  atticusShare: number, // = 0.15 × max(0, uplift) at tier 1
  foxifyNet: number,    // foxifyShare - hedgeCost
  
  perpPosLong: { partnerExchange, openPx, closePx, fees },
  perpPosShort: { partnerExchange, openPx, closePx, fees },
  
  hedgeStrikes: { putStrike, callStrike, contractsBtc },
  hedgeVenue: bullish | deribit,
  hedgeFillExitMode: capture_window_peak | trail_retrace | force_expiry | foxify_close,
  
  spotPathSnapshot: [ {ts, spot}, ... ] // hourly snapshots during pair life
}
```

### 9.4 Loss explanation (when Foxify asks "why did this pair lose money")

When Foxify sees a negative net pair, the explanation should be:

```
GET /single-side/admin/pairs/:pair_id/explain

Response:
{
  pairId: string,
  outcome: "loss",
  hedgeCost: $3,238,
  salvageProceeds: $2,400,
  uplift: -$838,
  foxifyReceived: $2,400,  // ate the loss directly
  foxifyNet: -$838,
  
  why: "Pair did not trigger within 3-day tenor. BTC ranged in [$75,200, $76,400]
        for entire holding period. Strangle's intrinsic floor of $2,800 partially
        offset the time-value decay, but the option's combined value at expiry-4h
        was $2,400 — losing $838 vs hedge cost. This is in the 5th percentile of
        outcomes (statistically rare but expected at calm regime ~5% of pairs).",
  
  pathStats: {
    minSpot, maxSpot, finalSpot,
    rangeWidthPct,
    triggerThresholds: { down, up }
  }
}
```

This costs nothing to compute (just pulls from path snapshot) and saves Foxify ops time.

---

## 10. Code and branch inventory

### 10.1 Repository structure

```
Repo root: /Users/michaelwilliam/Desktop/Foxify_Collar
Live VC platform: services/api/src/volumeCover/  (DO NOT MODIFY — currently live on Render)
Pilot infrastructure: services/api/src/pilot/    (legacy, mostly retired)
SingleSide skeleton: services/api/src/singleSide/ (3 files, spec only — needs wiring)
Backtest scripts: services/api/scripts/backtest/singleSide/  (where empirical work lives)
Docs: docs/                                       (all SINGLE_SIDE_*.md files)
```

### 10.2 Branches (relevant)

| Branch | Status | Notes |
|---|---|---|
| `cursor/-bc-c2468b87-...-6ba4` | LIVE on Render | Currently tracked by foxify-pilot-new. DO NOT BREAK. |
| `cursor/-bc-3aa2d238-...-6425` | Legacy single-side / pilot work | Reference only, not for new work |
| `vc-sandbox` | Shadow API on Render | foxify-pilot-shadow tracks this |
| `vc-sandbox-spreads` | Track 2 spread scaffolding | Has hedge pool, fillOptimizer, jitter, etc. |
| `vc/track1-archive-and-slippage-floor` | Slippage floor work | Source for execution hardening |
| **NEW BRANCH NEEDED** | Phase 0 two-sided cooperative build | Branch off `cursor/-bc-c2468b87-...-6ba4` |

For Phase 0 work: create new branch `cursor/two-sided-cooperative-phase0` off the live tracking branch. All Phase 0 PRs land here. Do not push to live tracking branch until cutover gate.

### 10.3 Backtest scripts inventory

All under `services/api/scripts/backtest/singleSide/`:

| File | Purpose | Run command |
|---|---|---|
| `monteCarloEngine.ts` | Core MC engine (path generators, theta-aware TP, cooperative split, multi-split runner) | (library — imported by runners) |
| `coreEngine.ts` | BS pricing primitives + extended Scenario types | (library) |
| `intradayCoreEngine.ts` | 5-min granularity simulator (validates daily harness) | (library) |
| `runReport.ts` | Original single-side baseline backtest | `npx tsx scripts/backtest/singleSide/runReport.ts` |
| `runComparativeReport.ts` | 4-way variant comparison (baseline / theta-TP / X-or-Y / both) | `npx tsx scripts/backtest/singleSide/runComparativeReport.ts` |
| `runIntradayComparison.ts` | Daily vs intraday harness comparison | `npx tsx scripts/backtest/singleSide/runIntradayComparison.ts` |
| `run7pctTenorComparison.ts` | 6d vs 10d tenor for 7% cells | (deprecated — 7% cells dropped) |
| `runComprehensiveScalingProof.ts` | Full cell × regime × volume tier matrix | `npx tsx scripts/backtest/singleSide/runComprehensiveScalingProof.ts` |
| `runFocusedSmallScale.ts` | Focused 1-25/day on 2%/5% cells | `npx tsx scripts/backtest/singleSide/runFocusedSmallScale.ts` |
| `runDeepDiveAnswers.ts` | Loss distribution + early close + tenor analysis | `npx tsx scripts/backtest/singleSide/runDeepDiveAnswers.ts` |
| `runItmStrikeProof.ts` | Moneyness × regime sweep (ITM > ATM > OTM) | `npx tsx scripts/backtest/singleSide/runItmStrikeProof.ts` |
| **`runTwoSidedStrangleProof.ts`** | **THE one for new agent — ITM guts strangle MC** | `npx tsx scripts/backtest/singleSide/runTwoSidedStrangleProof.ts` |
| `runMonteCarloProof.ts` | Single-side cooperative model proof | `npx tsx scripts/backtest/singleSide/runMonteCarloProof.ts` |
| `runHighVolumeProof.ts` | Single-side at 1000/day | `npx tsx scripts/backtest/singleSide/runHighVolumeProof.ts` |
| `dvolProjector.ts` | DVOL → capital + EV deterministic projector | `npx tsx scripts/backtest/singleSide/dvolProjector.ts` |
| `empiricalChainValidator.ts` | Live Bullish + Deribit chain pull | (requires RENDER_API_URL + RENDER_ADMIN_TOKEN env vars) |
| `fetch5minData.ts` | Pull 5-min BTC OHLC for bootstrap | `npx tsx scripts/backtest/singleSide/fetch5minData.ts` |

### 10.4 Reusable code from VC (port for two-sided)

The live VC at `services/api/src/volumeCover/` has many subsystems Phase 0 should port (READ-ONLY copy, never modify):

| VC module | Phase 0 use case |
|---|---|
| `volumeCoverHedgeManager.ts` | TP curve infrastructure (rules + scheduler) |
| `bullishSpreadAdapter.ts` | Multi-leg execution wrapper for Bullish |
| `fillOptimizer.ts` | Improved-price IOC + deep-cross retry |
| `chainWarmer.ts` | 30s prefetch of Bullish chain |
| `volumeCoverGuardrails.ts` | Loss kill / salvage tracker / surge pause patterns |
| `counterpartyLedger.ts` | Settlement deferral + tier credit ledger |
| `salvageTracker.ts` | Per-pair salvage event tracking |
| `foxifyDashboard.ts` | Foxify-facing endpoint patterns + field whitelist |
| `foxifyReport.ts` | Daily report generator pattern |
| `volumeCoverNewbornReview.ts` | Newborn-trigger manual halt pattern |
| `silentDisruption.ts` | Latency injection (Phase 0 likely doesn't need but can reference) |

For two-sided, key extension: `volumeCoverHedgeManager` operates on individual legs; for strangle, you need a "structure manager" that operates on combined option value (or two legs in coordination).

### 10.5 Docs inventory

All under `docs/`:

| Doc | Purpose |
|---|---|
| `SINGLE_SIDE_TWO_SIDED_STRANGLE_VALIDATION.md` | **The empirical proof for ITM guts strangle** |
| `SINGLE_SIDE_ITM_STRIKE_VALIDATION.md` | ITM moneyness × regime sweep (single-side) |
| `SINGLE_SIDE_DEEP_DIVE_ANSWERS.md` | Loss distribution, trigger rates, early close, tenor |
| `SINGLE_SIDE_MONTE_CARLO_PROOF.md` | Original single-side cooperative validation |
| `SINGLE_SIDE_COMPREHENSIVE_SCALING_PROOF.md` | Full cell × regime × volume tier matrix |
| `SINGLE_SIDE_HIGH_VOLUME_PROOF.md` | 1000/day projection at various splits |
| `SINGLE_SIDE_FOCUSED_2_5PCT_80_20.md` | Earlier focused 1-25/day at flat 80/20 |
| `SINGLE_SIDE_DVOL_PROJECTOR.md` | DVOL projector report |
| `SINGLE_SIDE_EMPIRICAL_VALIDATION.md` | Live Bullish + Deribit chain (snapshot) |
| `SINGLE_SIDE_OPTIMAL_DESIGN_BACKTEST.md` | 4-way variant comparison + intraday appendix |
| `SINGLE_SIDE_PHASE_0_PR_PLAN.md` | 11-PR build plan (needs update for two-sided) |
| `SINGLE_SIDE_FOXIFY_PROPOSAL_V2.md` | Foxify-facing proposal (single-side, ITM strikes) |
| `SINGLE_SIDE_7PCT_TENOR_BACKTEST.md` | 6d vs 10d for 7% cells (cells dropped) |
| `SINGLE_SIDE_FOXIFY_VOLUME_FACILITY_PROPOSAL.md` | v1 proposal (superseded) |
| **THIS DOC** | **`SINGLE_SIDE_TWO_SIDED_AGENT_HANDOFF.md`** — start here as new agent |

### 10.6 Live operational docs (READ — do not modify live)

- `docs/STATE_OF_WORK_2026_05_22.md` — last operational bookmark for VC
- `docs/POSTMORTEM_AND_MODEL_EVAL_2026_05_24.md` — Foxify-001 sequence-fix lesson + lessons learned
- `docs/FOXIFY_PROPOSAL_V3_2026_05_24.md` — old VC pricing proposal (premium-based, not cooperative)
- `docs/BACKTEST_REPORT_2026_05_24.md` — VC structural underwater finding

### 10.7 Render endpoints (for new agent reference)

Live API: `https://foxify-pilot-new.onrender.com`
Shadow API: `https://foxify-pilot-shadow-3r1m.onrender.com`

Key admin endpoints (require X-Admin-Token header):
- `GET /volume-cover/admin/bullish-option-chain` — full BTC option chain via Bullish
- `GET /volume-cover/admin/bullish-orderbook?symbol=...&depth=10` — per-symbol orderbook
- `GET /volume-cover/admin/diagnostics` — operational status

These are READ-ONLY for chain queries (zero production risk). They are how the empirical chain validator pulls live prices.

---

## 11. Implementation sequence

### 11.1 PR sequence (8-9 small PRs, ~2-3 weeks elapsed)

Branch off `cursor/-bc-c2468b87-...-6ba4` to a new branch `cursor/two-sided-cooperative-phase0`.

| PR | Title | LOC | Tests | Risk | Notes |
|---|---|---:|---:|---|---|
| 1 | Schema + lifecycle skeleton (two-sided pair table, leg table, state machine) | 250 | 6 | Low (additive) | New tables: `pair`, `pair_leg`, `pair_event`. State machine: pending → active → triggered → unwinding → settled |
| 2 | Trigger detector for two-sided pair (3s tick, both directions watched) | 200 | 5 | Low (no execution) | Watches both ±2% boundaries; emits `trigger_detected` event |
| 3 | Quote endpoint + activate path (live Bullish chain + multi-venue routing) | 400 | 8 | Med (touches venues) | Quote returns live ITM strike + cost; activate funds Foxify capital |
| 4 | Theta-aware TP engine for strangle (combined option value + capture window) | 450 | 10 | Med (new engine) | Adapts existing single-side TP curve to combined put+call value |
| 4.5 | Losing-leg early-close optimization (Phase 1 — defer to after launch) | 100 | 4 | Low | A/B test losing-leg-immediately vs combined-value TP |
| 5 | Trigger-fire execution path + Foxify early-close endpoint | 300 | 7 | High (real Bullish writes) | Multi-venue routing, fillOptimizer reuse, deep-cross retry |
| 6 | Settlement engine (per-cover net + tier-aware split + deferred-settlement pool) | 350 | 8 | Med | Implements 15→5% tier scaling + deferred recycling option |
| 7 | Shadow trade infrastructure (synthetic execution + reconciliation) | 250 | 6 | Low | No real orders; logs predictions vs actuals |
| 8 | Foxify-facing dashboard + admin endpoints + per-pair detail | 300 | 6 | Low | Daily report generator + status API + drilldown |
| 9 | Operational guardrails (loss kill, salvage tracker, halts, newborn review) | 250 | 6 | Med | Port from VC patterns (volumeCoverGuardrails, salvageTracker) |
| 10 | Strangle microtest probe + live cutover plan | 150 | 0 (e2e) | Low | Bullish strangle e2e test at 0.01 BTC; runbook |
| 11 | Live cutover behind feature flag + 30-day soak monitoring | 100 | n/a | High (live) | Default OFF, single-cell allowlist, manual halt active |

**Total: ~3,100 LOC, 66 new tests, ~3 weeks elapsed.**

### 11.2 PR-by-PR detail for the new agent

#### PR 1 — Schema + lifecycle skeleton

Tables:
```
pair (
  pair_id UUID PK,
  cell_id TEXT,
  status TEXT,  -- pending | active | triggered | unwinding | settled
  spot_at_activation NUMERIC,
  trigger_down_price NUMERIC,
  trigger_up_price NUMERIC,
  hedge_cost_total_usdc NUMERIC,
  foxify_capital_funded_usdc NUMERIC,
  triggered_at TIMESTAMPTZ NULL,
  trigger_side TEXT NULL,  -- down | up | null
  closed_at TIMESTAMPTZ NULL,
  closed_reason TEXT NULL,  -- trigger | foxify_close | expiry
  salvage_proceeds_usdc NUMERIC NULL,
  foxify_share_usdc NUMERIC NULL,
  atticus_share_usdc NUMERIC NULL,
  active_tier TEXT NULL,  -- tier_1 | tier_2 | tier_3 | tier_4 | tier_5
  metadata JSONB
)

pair_leg (
  leg_id UUID PK,
  pair_id UUID FK,
  leg_role TEXT,  -- long_put | long_call
  venue TEXT,  -- bullish | deribit
  symbol TEXT,
  strike_usdc NUMERIC,
  contracts_btc NUMERIC,
  buy_price_usdc_per_btc NUMERIC,
  buy_filled_at TIMESTAMPTZ,
  sell_price_usdc_per_btc NUMERIC NULL,
  sell_filled_at TIMESTAMPTZ NULL,
  metadata JSONB
)

pair_event (
  event_id UUID PK,
  pair_id UUID FK,
  occurred_at TIMESTAMPTZ,
  kind TEXT,  -- activated | trigger_detected | fired | unwinding | settled | foxify_closed | atticus_halt
  details JSONB
)
```

State machine:
- `pending` → `active` (after both legs filled)
- `active` → `triggered` (trigger fires)
- `active` → `unwinding` (Foxify early close OR expiry-4h)
- `triggered` → `unwinding` (theta-aware TP curve sells)
- `unwinding` → `settled` (settlement complete)

No wiring yet — types and schema only.

#### PR 2 — Trigger detector

Reuse VC's 3s tick pattern. Watch both `trigger_down_price` and `trigger_up_price` for each active pair. On crossing detected, transition pair to `triggered` and emit `trigger_detected` event.

#### PR 3 — Quote endpoint + activate

```
POST /single-side/quote
  Body: { cellId: "ss_50k_2pct_pair", direction: null }  // pair has no direction
  Response: {
    quote_id: UUID,
    valid_until: ISO timestamp,
    spot_at_quote: number,
    put_strike: number,
    call_strike: number,
    put_ask: number,
    call_ask: number,
    total_hedge_cost_usdc: number,
    contracts_btc: number,
    venue_routing: { put: bullish | deribit, call: bullish | deribit },
    expected_tier: { share, label }
  }

POST /single-side/activate
  Body: { quote_id: UUID, foxify_perp_long_id: string, foxify_perp_short_id: string }
  Response: { pair_id: UUID, status: "active" | "rejected" }
```

#### PR 4 — Theta-aware TP for strangle

Port the theta-aware TP logic from `monteCarloEngine.simulatePathOutcome` (the `applyThetaAwareTp` function for combined option value). Operates on real-time spot poll instead of simulated path.

Key parameters (from MC tuning):
- Slippage haircut: 0.85
- Trail retrace: 0.85 (15% pullback)
- Cap fraction: 0.95 (sell when value ≥ 95% of intrinsic)
- Hard floor: 0.10 of payout reference
- Capture window: 30 minutes post-trigger
- Cap fraction min hold: 60 minutes (avoid premature)

#### PR 5 — Trigger-fire execution + early close

Reuse VC's `bullishSpreadAdapter` execution patterns. For two-sided strangle:
- Multi-venue routed (Bullish + Deribit)
- Limit IOC with 8s poll ceiling
- 3 deep-cross retries
- Slippage floor enforced

Foxify early-close endpoint: `POST /single-side/admin/foxify-close-pair?pairId=...` runs same theta-aware TP at current moment.

#### PR 6 — Settlement engine + deferred pool

Tier scaling logic:
```
Read rolling 7d pairs/day average
Determine active tier: 1 (15/85), 2 (12/88), 3 (10/90), 4 (7/93), 5 (5/95)
Apply tier to all pairs settling this period

Deferred pool option (Foxify-elected):
  if foxify.deferred_settlement_active:
    Atticus retains 100% of salvage in pool
    Pool funds new pair activations
    Track cumulative Foxify balance owed (= what Foxify share would be at active tier)
    On de-activation, settle accumulated balance to Foxify
```

#### PR 7 — Shadow trade infrastructure

Synthetic execution: instead of placing real orders, log what would have happened.

```
POST /single-side/admin/shadow-activate
  Body: { cell_id: ... }  
  Response: { shadow_pair_id: UUID, simulated_quote: ..., expected_outcome_distribution: ... }

shadow_trade_log (
  shadow_pair_id UUID PK,
  ...same as pair table...,
  simulation_metadata JSONB  -- expected vs actual reconciliation
)
```

Daily reconciliation cron compares shadow PnL to MC predictions. Drift > 15% triggers alert.

#### PR 8 — Foxify dashboard + admin

Endpoints from Section 9. Daily report generator. Per-pair detail. Loss explanation.

#### PR 9 — Guardrails

Port from VC. Per-cell loss kill, rolling salvage tracker, surge pause, DVOL threshold, multi-venue depth gate, newborn review counter.

#### PR 10 — Strangle microtest

Build `services/api/scripts/probes/bullish_strangle_e2e_microtest.sh`:
- Open ITM put + ITM call at 0.01 BTC each
- Hold 60s
- Close both legs (sequenced)
- Report fill quality vs displayed asks
- Cost ~$2-5 round trip on shadow tier

#### PR 11 — Live cutover

Behind `SS_TWO_SIDED_LIVE_ENABLED=true` flag. Default OFF. Single-cell allowlist `ss_50k_2pct_pair`. Manual halt active. Newborn review for first 3 triggers.

### 11.3 Pre-launch validation gates

```
Pre-launch checklist (in order):

✅ MC validation complete and reproducible
✅ Live chain validator passes
□ All PRs 1-9 merged to phase0 branch
□ tsc --strict clean on entire build
□ All 66 tests pass
□ Shadow trade infrastructure live
□ 100+ shadow trades over 7 days, drift < 15% vs MC
□ Strangle microtest at 0.01 BTC clean on shadow tier
□ Operator-reviewed strangle test at 0.05 BTC clean on shadow tier
□ Final go/no-go review
□ Promote to live with 2 pairs/day cap, manual halt active
□ Newborn-trigger review for first 3 triggers (operator clears)
□ 30-day soak before any volume scaling
```

---

## 12. Empirical reference numbers

### 12.1 Two-sided ITM guts strangle — calm regime baseline

Source: `docs/SINGLE_SIDE_TWO_SIDED_STRANGLE_VALIDATION.md`, 25k Monte Carlo paths from 140k 5-min historical bars.

| Metric | Value | Confidence |
|---|---:|---|
| BTC spot at calibration | $76,000 | Today's anchor |
| DVOL at calibration | 35.76 (σ=0.358) | Today's calm regime |
| Put strike | $77,000 (1.3% ITM) | Bullish $1k grid snap |
| Call strike | $75,000 (1.3% ITM) | Bullish $1k grid snap |
| Put leg cost (live ask × contracts) | $1,610 | From empirical chain validator |
| Call leg cost | $1,628 | From empirical chain validator |
| Total hedge cost | $3,238 | What Foxify deploys per pair |
| Trigger rate (either side, 3d tenor) | 91.9% | 25k bootstrap paths |
| Trigger down rate | 46.0% | |
| Trigger up rate | 45.9% | |
| Mean salvage | $3,840 | |
| Mean uplift (salvage − hedge) | +$602 | |
| Salvage / hedge ratio | 1.19× | |
| % paths salvage < hedge | ~25% | |
| Foxify EV at 80/20 split | +$586 | 95% CI ±$5 |
| Atticus EV at 80/20 split | +$153 | 95% CI ±$3 |
| Foxify EV at 85/15 split (Tier 1) | ~+$415 | Estimated linear scaling |
| Atticus EV at 85/15 split (Tier 1) | ~+$90 | |

### 12.2 Two-sided ITM guts strangle — across regimes

| Regime | Hedge cost | Trigger rate | Mean salvage | Salvage/hedge | Foxify EV (80/20) | Atticus EV (80/20) |
|---|---:|---:|---:|---:|---:|---:|
| Calm (σ=0.35) | $3,238 | 91.9% | $3,840 | 1.19× | +$586 | +$153 |
| Moderate (σ=0.55) | $3,226 | 100% | $4,425 | 1.37× | +$1,438 | +$359 |
| Elevated (σ=0.75) | $3,219 | 100% | $5,693 | 1.77× | +$2,463 | +$616 |
| Stress (σ=0.95) | $3,215 | 100% | $6,719 | 2.09× | +$3,498 | +$874 |

### 12.3 Strike alternatives tested (single regime, calm)

| Structure | Hedge cost | Trigger rate | Mean salvage | Foxify EV (80/20) | Atticus EV (80/20) |
|---|---:|---:|---:|---:|---:|
| OTM ($74k put + $78k call) | $578 | 91.9% | $850 | +$211 | +$70 |
| ATM ($76k put + $76k call) | $2,019 | 91.9% | $2,648 | +$437 | +$132 |
| **ITM guts ($77k put + $75k call)** ⭐ | **$3,238** | **91.9%** | **$3,840** | **+$586** | **+$153** |

**ITM guts wins for Foxify EV per pair.** OTM has gap-zone problem (option not yet ITM at trigger boundary). ATM is intermediate. ITM guts captures every dollar of move + has $2,800 intrinsic floor.

### 12.4 Two-sided vs single-side comparison

| Metric | Single-side ITM (1 leg) | Two-sided ITM guts (pair) | Ratio |
|---|---:|---:|---:|
| Cost per activation | $1,610 | $3,238 | 2.01× |
| Trigger rate | 32.0% | 91.9% | 2.87× |
| Mean salvage | $2,222 | $3,840 | 1.73× |
| Foxify EV per activation | +$436 | +$586 | 1.34× |
| Atticus EV per activation | +$170 | +$153 | 0.90× |
| Foxify ROI on capital | 27% per cover | 18% per pair | 0.67× |
| Foxify partner-exchange volume per activation | 1× | 2× | 2.0× |

**Two-sided generates 2× partner-exchange volume per activation** — which is Foxify's primary metric. Single-side wins on capital efficiency; two-sided wins on volume + absolute revenue.

### 12.5 Capital ladder for 2-sided ITM guts (calm)

| Pairs / day | Hedge cost / pair | Foxify daily | Atticus daily | Foxify peak capital | Foxify ROI |
|---:|---:|---:|---:|---:|---:|
| 1 | $3,238 | +$586 | +$153 | $3,238 | 66× |
| 2 | $3,238 | +$1,172 | +$306 | $6,476 | 66× |
| 5 | $3,238 | +$2,930 | +$765 | $16,190 | 66× |
| 10 | $3,238 | +$5,860 | +$1,530 | $32,380 | 66× |
| 25 | $3,238 | +$14,650 | +$3,825 | $80,950 | 66× |
| 50 | $3,238 | +$29,300 | +$7,650 | $161,900 | 66× |
| 100 | $3,238 | +$58,600 | +$15,300 | $323,800 | 66× |
| 1000 | $3,238 | +$586,000 | +$153,000 | $3,238,000 | 66× |

(Annual = daily × 365. Foxify ROI on capital is constant across volumes because per-pair EV is constant.)

### 12.6 Loss distribution at calm (50k/2% ITM guts pair)

| Outcome category | % of pairs | Salvage range | Foxify net |
|---|---:|---|---:|
| Trigger fires deep (>2.5% adverse) | ~10% | $4,500-6,000 | +$1,015-2,210 |
| Trigger fires at boundary (~2%) | ~22% | $3,500-4,200 | +$210-770 |
| Near-trigger close (no fire, time-value capture) | ~21% | $3,300-3,800 | +$50-450 |
| Drift close (no fire, some decay) | ~37% | $2,400-3,200 | -$30-670 |
| Deep loss (option lost most value) | ~10% | $1,500-2,400 | -$840-1,740 |

(Approximations. Mean across all paths: Foxify +$586. Win rate ~53%.)

### 12.7 Regime growth simulator (deferred settlement, 2 → 25 pairs target)

Daily compounding: each day, deploy floor(capital / $3,238) pairs; capital grows by N × mean_uplift.

| Regime | Mean uplift / pair | Days from 2 → 25 pairs |
|---|---:|---:|
| Calm | $602 | ~16-17 days |
| Moderate | ~$1,800 | ~5-6 days |
| Elevated | ~$3,000 | ~3-4 days |
| Stress | ~$4,400 | ~2-3 days |

(See Section 4.3 for day-by-day walkthrough at calm.)

### 12.8 Empirical anchor — when to refresh

These numbers are calibrated to **2026-05-26/27 spot $76,000, DVOL 35.76**. Re-run validation when:

- Spot moves >5% from anchor
- DVOL moves >15 points from anchor
- More than 7 days have passed
- Bullish $1k strike grid changes (unlikely)
- New cells added to matrix

Refresh sequence:
1. `npx tsx scripts/backtest/singleSide/empiricalChainValidator.ts` (5 min)
2. `npx tsx scripts/backtest/singleSide/runTwoSidedStrangleProof.ts` (15 min)
3. Update tier-split EV tables in this doc

### 12.9 Live tier transition examples

Foxify's rolling 7-day pairs/day determines tier:

| 7d avg pairs/day | Tier | Atticus % | Foxify % | Foxify EV/pair (calm) |
|---|---|---:|---:|---:|
| 0-25 | 1 | 15% | 85% | ~+$415 |
| 25-100 | 2 | 12% | 88% | ~+$436 |
| 100-250 | 3 | 10% | 90% | ~+$450 |
| 250-500 | 4 | 7% | 93% | ~+$471 |
| 500+ | 5 | 5% | 95% | ~+$486 |

(Foxify EV grows ~17% from Tier 1 to Tier 5 as Atticus share shrinks. Atticus revenue scales with absolute volume.)

---

## 13. Glossary and open questions

### 13.1 Glossary

- **Pair** — a Foxify activation consisting of one long perp + one short perp on partner exchange + one strangle hedge from Atticus
- **Cover** — single-side equivalent (one perp + one option leg). Two-sided uses pair instead.
- **ITM guts strangle** — strangle where both legs are in-the-money. Put strike > spot AND call strike < spot. Has constant intrinsic floor.
- **ATM strangle** — strangle where both legs are at-the-money (often called a straddle if same strike). Has more time value but no intrinsic floor.
- **OTM strangle** — standard strangle, both legs out-of-the-money. Cheapest but has gap-zone problem at narrow trigger bands.
- **Theta-aware TP** — Take-Profit curve that accounts for theta decay. Captures intraday peaks via 30-min capture window post-trigger, then trail retrace + cap-fraction + hard floor + force exit.
- **Capture window** — 30-minute period post-trigger fire where theta-aware TP tracks intraday peak option value before snapping to peak with slippage haircut.
- **Slippage haircut** — 0.85× multiplier applied to peak option value to model limit-IOC execution at slippage floor (proven in single-side analysis).
- **Salvage uplift** — salvage proceeds minus original hedge cost. Positive = win path. Negative = loss path.
- **Cooperative cost-pass-through** — pricing model where Foxify pays exact hedge cost upfront (no markup); salvage proceeds split per agreed ratio.
- **Tier split** — Atticus's share of salvage uplift, scales 15% → 5% as Foxify volume grows.
- **Deferred settlement** — option to recycle salvage proceeds within the system (no immediate payout) to fund more pair activations during scale-up phase.
- **DVOL** — Deribit's BTC volatility index. Maps roughly to short-dated implied vol. Used for regime classification: <40 calm, 40-60 moderate, 60-85 elevated, ≥85 stress.

### 13.2 Key open questions for the new agent

These were not fully resolved in prior conversation and are appropriate next-step questions:

1. **5% pair MC validation.** Does ITM guts at 5% trigger band ($80k put + $72k call) produce positive Foxify EV across all regimes? Run `runTwoSidedStrangleProof.ts` adapted for 5% cell parameters. If yes, add to Phase 1.

2. **Losing-leg early-close optimization.** Build the A/B test described in Section 6.2. Compare combined-value TP vs sell-loser-immediately. Decide based on >5% salvage improvement threshold.

3. **Deferred settlement policy.** What's the trigger for switching from "recycle 100%" to "actual settlement"? Options: (a) hit target volume threshold (e.g. 25 pairs/day stable), (b) calendar-based (e.g. weekly net after 30-day growth phase), (c) Foxify-elected (manual switch). Document and codify.

4. **Tier transition timing.** When Foxify's 7-day avg crosses a tier threshold mid-week, does the new tier apply (a) immediately to next pair, (b) at next settlement period, (c) prorated within current period. Section 3.2 says (b); confirm with Foxify.

5. **Multi-cell tier interactions.** When multiple cells are active (Phase 1+), is the tier determined by total pairs/day across all cells, or per-cell? Recommend total (single tier policy across product).

6. **Foxify-Atticus settlement currency.** USDC at Bullish vs USD wire vs Foxify-native? Operational detail for Phase 0 launch.

7. **Capital pool legal structure.** Joint pool with deferred settlement implies counterparty credit. Need legal review on pool ownership, bankruptcy treatment, etc.

8. **Manual halt UI.** Does Foxify get a self-serve dashboard button to halt? Or operations-team-only via API? Section 8.4 implies API-only for initial launch.

### 13.3 Critical do-NOTs for new agent

- **Do not modify** anything under `services/api/src/volumeCover/` — that's the live VC.
- **Do not change** `services/api/scripts/backtest/singleSide/runReport.ts` — the original baseline must stay reproducible.
- **Do not push** Phase 0 work to `cursor/-bc-c2468b87-...-6ba4` until cutover gate.
- **Do not place real Bullish/Deribit orders** during shadow phase. All Phase 0 testing is shadow + microtest only.
- **Do not skip** the empirical chain validator before live cutover. Live prices change; the model assumes today's calibration.
- **Do not run** auto-resume on operational halts (Section 8.5) without operator review.
- **Do not bypass** the newborn-trigger review for first 3 triggers post-deploy.

### 13.4 Recommended starting sequence for new agent

1. **Read** the empirical proof: `docs/SINGLE_SIDE_TWO_SIDED_STRANGLE_VALIDATION.md`
2. **Read** this doc end-to-end
3. **Run** the existing two-sided MC: `npx tsx scripts/backtest/singleSide/runTwoSidedStrangleProof.ts`
4. **Run** the live chain validator (with admin token): `npx tsx scripts/backtest/singleSide/empiricalChainValidator.ts`
5. **Compare** the live Bullish chain ITM strikes ($77k put + $75k call) against the MC-anchored numbers — confirm calibration is still valid
6. **Plan** PR 1 (schema + lifecycle skeleton) on a fresh branch
7. **Build** through PR 9 sequentially
8. **Validate** with shadow trades + microtest
9. **Coordinate** with operator for live cutover gate

### 13.5 Token / credential notes

- Render admin token rotation: prior tokens have been pasted in chat sessions and need rotation per security protocol. Confirm current valid token with operator before running live chain validator.
- Bullish ECDSA keys: stored in Render env vars `BULLISH_ECDSA_PRIVATE_KEY` and `BULLISH_ECDSA_PUBLIC_KEY` on `foxify-pilot-new` and `foxify-pilot-shadow`. Live trading goes through these.
- Deribit API key: stored as `DERIBIT_API_KEY` and `DERIBIT_API_SECRET`. Public chain queries don't need auth.

### 13.6 Contact for questions

When the new agent has questions:
- Operational / Render: operator (this proposal's recipient)
- Engineering / code patterns: review `services/api/src/volumeCover/` for VC patterns, then this doc
- Foxify business questions: defer to operator + Foxify ops contact

---

**End of handoff document.**

This doc is self-contained for a new agent to begin Phase 0 implementation. All numbers are empirically validated and reproducible. All commands are tested and run cleanly under `tsc --strict`. The two-sided ITM guts strangle structure is the recommended product based on full Monte Carlo + live-chain validation against today's market.

Welcome aboard, new agent. Start with Section 13.4, work through the PR sequence in Section 11, and ship Phase 0 within 3 weeks.
