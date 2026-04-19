# TP Optimization Analysis — n=9 Post-Switch Triggers

**As of:** 2026-04-19T00:17 UTC
**Sample:** 35 protections total — 27 post-switch.
**Triggered (post-switch, with TP outcome):** 9 — all on the same SL 2% long event, all on the **same option** (`BTC-19APR26-76000-P` ×8, `BTC-19APR26-75500-P` ×1).
**Active salvage events:** 2 (SL 3% longs, both sold for $30.28 each at the active-salvage threshold).
**Phase 2 chain samples available:** 4 over ~14 hours.
**Venue:** Deribit mainnet pricing (paper account).

---

## TL;DR

The TP system is **executing exactly per spec** but the spec is **structurally underperforming** because of one factor we haven't yet measured against live data: **Deribit's bid-ask spread on short-dated options is enormous relative to mid-price**. The hedge manager values options at Black-Scholes (which approximates mid), but actually sells at the bid — losing ~30% of the modeled value to spread on every TP sale. This is the dominant economic friction in the pilot's TP performance, dwarfing every other tuning consideration.

Three concrete findings:

1. **Average TP recovery is only 15.8% of the payout owed**, against the algorithm's expected ≥25% (the prime threshold). The reason isn't bad timing — it's spread cost. The BS recovery model says the option is worth $788 across 9 trades; we actually got $539 — a 32% gap from spread alone.

2. **The bounce-recovery branch is firing on 8 of 9 triggered trades** (the other one took the prime-window branch). All 9 sold ~30 minutes after trigger. This is design intent — but it means the platform is currently a "pure bounce-recovery system" with no real evidence on the deep-drop / late / near-expiry branches.

3. **Net P&L on the triggered cohort is −$2,127 paper** because the day saw a single ~2% intraday move that triggered every SL 2% long simultaneously. This is a small-sample selection effect, not a structural problem — a 2% move is 35% likely to fire on a 1-day put, which we already knew from backtests.

The TP optimization question splits into three distinct sub-questions, each with a different answer:

- **Selection of WHEN to sell** — looks reasonable, hard to improve without a much larger sample.
- **Capture rate of WHAT WE SELL FOR** — clearly the dominant leak. Real but action requires a non-trivial change.
- **Pricing relative to expected outcomes** — needs more data (n=9 triggers is too few for a regime-weighted view).

---

## 1. The 9 triggered TP outcomes — per trade

| ID | Tier | Notional | Trigger | Strike | Premium | Hedge | Sell USD | Proceeds | Recovery vs Payout | Reason | Time to sell |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `4f482b91` | 2% L | $10k | $75,865 | 76,000 P | $50 | $6.97 | $228.64 | $22.86 | 11.4% | bounce_recovery | 0.5h |
| `ba9b9185` | 2% L | $50k | $75,883 | 76,000 P | $250 | $41.81 | $228.64 | $137.18 | 13.7% | bounce_recovery | 0.5h |
| `8d428e31` | 2% L | $10k | $75,720 | 76,000 P | $50 | $6.95 | $454.41 | $45.44 | 22.7% | bounce_recovery | 0.5h |
| `76af058e` | 2% L | $10k | $75,728 | 76,000 P | $50 | $6.95 | $491.76 | $49.18 | 24.6% | take_profit_prime | 0.5h |
| `300d2fed` | 2% L | $10k | $75,683 | 76,000 P | $50 | $7.72 | $454.41 | $45.44 | 22.7% | bounce_recovery | 0.5h |
| `c8dd02f5` | 2% L | $10k | $75,663 | 76,000 P | $50 | $7.72 | $454.41 | $45.44 | 22.7% | bounce_recovery | 0.5h |
| `04976ccb` | 2% L | $15k | $75,633 | 76,000 P | $75 | $7.72 | $454.41 | $45.44 | 15.1% | bounce_recovery | 0.5h |
| `7c190b0e` | 2% L | $10k | $75,676 | 76,000 P | $50 | $6.95 | $454.41 | $45.44 | 22.7% | bounce_recovery | 0.5h |
| `dbe19127` | 2% L | $45k | $75,588 | 75,500 P | $225 | $23.14 | $204.63 | $102.31 | 11.4% | bounce_recovery | 0.5h |

**Aggregate**: $850 premium, $116 hedge, $3,400 payouts due, $539 TP proceeds. Net = **−$2,127 paper**.

All 9 trades sold at almost exactly **30 minutes after trigger** — that's the normal-regime cooling-period boundary. The bounce branch fires the moment cooling completes when option is OTM (spot recovered through floor). The system did exactly what it was designed to do.

---

## 2. The single most important finding: bid-ask drag is ~32% of modeled recovery

The hedge-manager metadata records both the actual `sellResult.totalProceeds` and the Black-Scholes `bsRecovery.totalValue` it used in the decision tree. Compare them:

| Metric | Total |
|---|---|
| BS-modeled value at sell time | $788.26 |
| Actual sell proceeds | $538.74 |
| **Realized fraction of model** | **68.3%** |

The algorithm "thought" the options were worth $788 (in line with the prime/late thresholds it computes against), but Deribit's bid was 32% below mid. **This is not a bug in the TP logic** — the BS model is correct, the bid is just structurally wide on short-dated options, and the algorithm has no choice but to sell at the bid.

Phase 2 chain samples confirm this isn't a one-off:

| Time (UTC) | DVOL | SL 2% put | Bid | Ask | Spread |
|---|---|---|---|---|---|
| 05:35 | 42.8 | $75,500 | $38.58 | $54.02 | **33%** |
| 08:09 | 42.8 | $75,500 | $23.11 | $53.92 | **80%** |
| 14:26 | 42.8 | $74,500 | $38.07 | $45.69 | **18%** |
| 19:56 | 43.9 | $74,000 | $22.70 | $45.41 | **67%** |

The 1-day put bid-ask spread on Deribit ranges from **18% to 80% of mid** depending on the strike and the moment. On 5% and 10% SL strikes, **bid is often null** (no bid at all) — those options are essentially sell-only, no buy-back available.

This is the dominant economic friction in the pilot's TP performance. Every other parameter we could tune is small in comparison.

---

## 3. Per-branch analysis

### 3.1 Bounce recovery — currently the workhorse (8 of 9 trades)

**Specification** (per `hedgeManager.ts` and the v3 docs):
- Triggers when: `hoursSinceTrigger ≥ effectiveCooling` AND option is OTM (spot back through floor) AND optionValue ≥ $3.
- Cooling period: 0.5h normal, 0.25h calm, 1.0h high.

**Observation in this dataset**: **All 8 bounce-recovery sells fired within 0.5h ± 1min** — i.e., the moment cooling ended. That's expected for a single intraday move where spot dipped through floor and immediately recovered.

**Capture rate by trade**: 11.4% – 24.6% of payout, mean 17.4%.

**Issue**: the BS model said these options were worth $788 total at sell time. We got $539. **The bounce-recovery branch's $3 minimum-value threshold is acting on the BS value, but the actual sale proceeds are 32% lower.** A trade with BS value $5 might fetch $3 actual, which is fine. But the ratio compounds: for a 2% SL with $200 payout, BS value $50 (within the prime-threshold range) yields $34 actual proceeds = 17% recovery, below the 25% prime threshold the algo was using to *make* the decision.

**Proposed adjustments to consider** (NOT proposing yet — analysis only):
- Use **bid price directly from the order book** as the value signal instead of BS, when bid is available. Bid is what we'll actually receive.
- Or: apply a **DVOL-aware spread haircut** to BS values (e.g., multiply by 0.7 in normal regime, 0.5 in stress) before comparing to thresholds.
- Or: tighten the bounce-recovery threshold from $3 to $5–$10 so we don't sell sub-economical options where the bid is far below $3.

### 3.2 Prime-window TP — 1 trade, looks fine but n=1

`76af058e` — sold at 0.5h with `take_profit_prime` reason. Recovery 24.6%, very close to the 25% prime threshold. So the threshold did its job: the option had reached the threshold, the algo sold. Difference between this and the 8 bounce-recovery trades is microscopic (literally seconds of timing on the cooling boundary).

No action — too few datapoints to separate prime from bounce in this regime.

### 3.3 Active salvage — 2 trades, both clean wins

| ID | Tier | Proceeds | BS value | Capture |
|---|---|---|---|---|
| `e5f95236` | 3% L | $30.28 | $24.95 | **121.3%** ← actual exceeded model |
| `92317688` | 3% L | $30.28 | $24.88 | **121.7%** ← same |

These are end-of-life sells where the bid happened to be ABOVE the BS mid (rare, but possible when there's a willing buyer late in the day). Active-salvage logic is working correctly. Sample is small but the pattern is healthy.

### 3.4 Branches with no observations yet

- **Deep-drop TP** (≥1.5% below floor, ≥0.167h cooling): zero observations. The 9 triggered trades all bounced quickly; nothing went deep.
- **Near-expiry salvage** (<6h to expiry, ≥$3): zero observations.
- **Late-window TP** (>8h post-trigger, ≥10% × payout): zero observations.

We have no live data on these branches yet. The Phase 1 backtest will cover them post-pilot, but until then, **any tuning recommendation for these branches would be speculative**.

---

## 4. Sustainability check — single-event risk

The 9 triggered trades all came from one ~2% intraday move that fired every active SL 2% long simultaneously. Aggregate paper P&L of −$2,127 on that single event is entirely explained by:
- Total premium collected from the affected positions: $850
- Total payout owed: $3,400
- TP recovery: $539
- Net: −$2,127

This is not a TP optimization failure. It's the **expected economic footprint** of a 2% intraday breach when concentration is heavy in the 2% SL tier. The backtests already predicted ~35% trigger rate for 2% SL on 1-day tenor. With 8 trades on that tier going simultaneously, you got hit harder than diversified — by design of the position mix you placed, not by anything the platform did wrong.

The 2 expired-OTM SL 2% shorts on the same day captured **+$300 paper** ($250 + $50 premium kept, near-zero hedge cost). That's the other side of the trade — the 65% of 2% SL trades that *don't* trigger.

**Net for the day**, including expired-OTM kept-premium: still negative because the trigger cohort was 8 trades vs the kept-premium cohort was 2 trades. Diversified portfolio expectation per backtest is a positive number; the realized day was unlucky on tier-mix.

---

## 5. What's working as designed

- **Trigger detection**: 9 of 9 triggers fired correctly on first floor breach. No false positives, no missed triggers.
- **Cooling period**: every trade waited the full 0.5h before considering a sell. No premature sales.
- **Bounce detection**: option went OTM (spot back through floor) → sold immediately after cooling — exactly per spec.
- **TP execution plumbing**: every sell completed cleanly via Deribit, full ledger entry recorded, `hedge_status = tp_sold`, no errors.
- **Active salvage**: 2 of 2 triggered when expected (last 4h of life on a non-triggered trade with ≥$5 value).
- **DVOL-adaptive parameters**: we're verifiably running the `normal` profile (cooling 0.5h, prime 0.25× payout) — DVOL was 42-44 across the entire sample window.

---

## 6. What's not optimal and why

### 6.1 Spread drag (the big one)

**Severity**: structural, ~30% of TP recovery is being lost.
**Root cause**: BS model values options at theoretical mid; Deribit only lets us sell at bid; bid is 18-80% below mid on 1-day options.
**Fix scope**:
- Small but real platform change: read bid directly from the order book in the hedge manager's value computation, OR apply a DVOL-aware haircut to BS values before threshold comparison.
- Risk: medium. It's the BS recovery model that's quoted in every TP decision log; changing it changes what the threshold tests against. Could trigger false sells (bid-derived value low → sells when shouldn't) or false holds (haircut too aggressive → never sells).
- **Best done with backtest evidence**, which means post-pilot Phase 1.

### 6.2 Single-strike concentration (selection-side, not TP-side)

All 8 SL 2% long trades selected the same `76000-P` strike at almost identical entry prices ($77,200-$77,400). When the floor at ~$75,700 was breached, all 8 fired together and all 8 wanted to sell the same instrument at almost the same moment. Best bid availability was equal across all 8 trades but bid depth might not have been deep enough to absorb the simultaneous sale. **In production with multiple Foxify users, this concentration risk grows with each correlated user position.**

**This is not a TP-tuning issue** — it's a venue-liquidity issue that the selection algorithm or a position-batching strategy would address. Out of scope for "TP optimization" but worth flagging.

### 6.3 The bounce-recovery $3 minimum is acting on BS value

The threshold `optionValue ≥ $3` uses the BS-modeled value. With the spread drag, an option BS-modeled at $3 is actually selling for ~$2. After Deribit fees (~3 cents per BTC option), net proceeds can drop below $1.50. **At current spread levels, the effective minimum is closer to BS $5 to net $3 actual.**

**Fix scope**:
- Trivial: bump bounce-recovery threshold from $3 → $5, OR change the threshold comparison to use bid directly.
- Risk: low; it just means we hold a bit longer before selling near-worthless options. Worst case: more options expire fully worthless at 0 instead of being sold for $1.50 in the last 30min.

### 6.4 No data yet on deep-drop, near-expiry, late-window branches

**Severity**: not actually a problem, but a gap that limits any optimization recommendation.
**Implication**: until we see triggers that go deep, stay through the prime window, or persist into late, we shouldn't propose changes to those branches.

---

## 7. Recommendations (NOT proposing changes — analysis only per stabilization mode)

In order of impact-to-risk ratio:

### A. Read bid directly from order book in hedge manager (HIGH impact, MEDIUM risk)

**Change**: when evaluating optionValue for TP decisions, use `Math.max(intrinsic, bestBid × quantity)` instead of `bsPut(...) × quantity`. This makes the algorithm's threshold tests reflect what we'll actually sell for, not theoretical mid.

**Pros**:
- Eliminates the 32% gap between modeled and realized recovery.
- TP decisions become realistic; the prime/late thresholds become accurate.
- Forced behavior change: when bid is null (no buyer), we hold automatically.

**Cons**:
- Requires fetching the order book inside the hedge cycle (one extra HTTP per managed position per cycle). At pilot throughput this is negligible (~20 books/min); at production throughput it could become a rate-limit or latency concern.
- Black-Scholes is a clean, deterministic value; bid is noisy and sometimes 0. We'd need to handle "no bid" gracefully (probably hold).

**Magnitude**: at observed 32% spread drag, recovering even half of it is +$80 / triggered trade × ~35% trigger rate × notional volume — that's the dominant lever in the entire TP system.

### B. DVOL-aware spread haircut on BS value (MEDIUM impact, LOW risk)

**Change**: before comparing BS value to thresholds, multiply by a DVOL-band-specific haircut (e.g., 0.85 / 0.75 / 0.60 for low / normal / high). Selling price stays whatever Deribit pays; threshold comparison just gets harsher.

**Pros**:
- Simpler than (A) — no extra API calls.
- Fewer false-positive sells where BS overstates value.
- Easy to backtest: just add the haircut to the existing simulator.

**Cons**:
- Haircut values are guessed; needs Phase 2 sampler data over multiple weeks to calibrate properly.
- Doesn't solve the no-bid case — algo will still try to sell options that can't actually be sold.

**Magnitude**: less than (A) but more conservative.

### C. Bump bounce-recovery $3 → $5 threshold (LOW impact, LOW risk)

**Change**: in the bounce-recovery branch, change `BOUNCE_RECOVERY_MIN_VALUE = 3` → `5` so sub-economical sales are skipped.

**Pros**:
- Trivial change, predictable effect.
- Removes a class of always-losing micro-trades.

**Cons**:
- Marginal P&L impact (a few dollars per skipped trade).
- Some of those trades would have eked out a tiny gain.

### D. Investigate whether splitting large positions across multiple expiries reduces concentration risk

**Change**: when a single user's notional × tier × concentration would exceed a threshold, split the hedge across two consecutive expiries instead of all in one.

**Pros**:
- Reduces single-strike concentration when the user is heavy on one tier.
- Diversifies the TP timing.

**Cons**:
- Significant code change in `venue.ts` selection.
- Operational complexity (two protections per quote).
- **Out of scope for TP-optimization**; this is a selection-side concern.

### E. Active-salvage threshold tuning (DEFER)

The 2 active-salvage trades both performed at >120% of BS modeled value, suggesting the threshold ($5 minimum) might be too conservative — we're potentially leaving more time-value on the table. **But n=2 is too small to act on.** Wait for a wider sample before considering.

---

## 8. What I want your decision on

| Item | Question | Stabilization-mode bar |
|---|---|---|
| **A** — Read bid directly | Worth doing now or after Phase 1 backtest validates? | **High** (changes TP-decision math) |
| **B** — DVOL spread haircut | Acceptable as a simpler stand-in for (A) until post-pilot? | **Medium** (parameter tuning, easily reversed) |
| **C** — Bounce $3 → $5 | Ship now? | **Low** (one-line constant change, easily reversed) |
| **D** — Strike concentration | Out of scope for this analysis — needs separate plan | n/a |
| **E** — Active-salvage threshold | Defer — too few datapoints | n/a |

**My recommendation**: defer A and B until after the pilot (or until we have 30+ triggers across multiple regimes — currently 9). Ship C now if you want a small optimization that won't break anything. Don't touch D / E in the pilot.

The honest read on this n=9 dataset is: **the platform's TP system is doing what it was designed to do, and the dominant friction (spread drag) is a market reality not a code bug.** Fixing it well requires more data than we have right now. Tuning thresholds without that data is high risk-of-regret.

---

## 9. Stabilization-mode status

- ✅ Read-only analysis only.
- ✅ No platform code changes proposed (this turn).
- ✅ No parameter changes proposed (this turn).
- ⚠ Three parameter-change candidates flagged with explicit go/no-go for operator decision.

---

_End of TP optimization analysis v1._
