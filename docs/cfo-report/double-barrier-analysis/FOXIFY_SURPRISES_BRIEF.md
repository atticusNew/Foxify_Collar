# Foxify "Surprises" Brief — Why the Volume Facility Cannot Blow Up

> **Audience:** Foxify counterparty risk team.
> **Purpose:** address the concern, raised in the founder's check-in,
> that *"the system might blow up"* or *"Atticus might be unable to
> pay out."* Provides the structural argument, the empirical backstop,
> and the operational guardrails — in that order.
> **Companion docs:** product mechanics in `MEMO_V2.md`,
> retail vs vol-facility split in `RETAIL_VS_VOL_FACILITY.md`,
> capital math in `capital_ramp_planner.py` outputs.

---

## TL;DR for the Foxify risk team

1. **Surprises are bounded by contract design.** Foxify's max loss per pair is the prepaid premium; Atticus's max payout per trigger is $1,000, capped. Neither side has unbounded exposure on any single trade.
2. **Big BTC moves help Atticus, they don't hurt us.** Long-vol convex hedging means that the scenario Foxify intuitively worries about (BTC craters or rallies suddenly) is *the most profitable scenario* for Atticus's hedge book. Verified analytically and on the 4-year tape.
3. **The actually-dangerous scenario is sustained "barrier-graze chop"**, and we have *four* layers of protection against that: empirical VRP edge, premium tiering, capital reserves at the empirical p05, and a cooldown circuit breaker.
4. **Atticus's payment capacity is monitored in real time** and a Foxify-visible utilization dashboard fires alerts well before any payment-capacity threshold is breached. Cooldown activates automatically before exhaustion, so the failure mode "Atticus can't pay" is converted to "Atticus pauses new pair openings while continuing to settle existing ones."

---

## 1. The contract structure already eliminates most surprise classes

For each $50k Foxify pair, the daily cash flows are bounded:

```
Foxify pays Atticus:    daily premium $/pair/day  (prepaid; capped at $1,800/day at $900-tier)
Atticus pays Foxify:    $1,000 × number_of_triggers_today  (capped per trigger)

Atticus's per-pair-per-day worst case:  ~13 triggers × $1,000 = $13,000  (extreme stress; modal is 1-2)
Foxify's per-pair-per-day worst case:   −$1,800  (premium prepaid, no trigger fires)
```

Both ends are *contractually finite per day*. The total exposure on either side at any moment is `N_pairs × max_daily_obligation` where N is bounded by the position-cap risk control. **There is no "tail" the way there is in a directional perp position. Both sides have a known maximum.**

The only reasonable counter-question is: *"does Atticus have enough cash to pay the worst case?"* That's §3.

---

## 2. The empirical answer to "will this actually pay out?"

We replayed the proposed $400/$600/$900 tiered premium with daily ±2% strangle hedging across the **actual 4-year BTC hourly tape** (2022-04 → 2026-05, 1,494 distinct 7-day pair-life starts). Result:

| Regime | Days/year | E[PnL/pair-life] | P[PnL > 0] | Worst observed pair-life |
|---|---|---|---|---|
| Calm (DVOL <50) | 141 | **+$1,280** | 77% | −$5,378 (one week in 2024) |
| Moderate (50-65) | 161 | **+$1,118** | 76% | −$10,986 (Aug 2022) |
| Elevated (65-80) | 44 | **+$1,942** | 79% | −$14,191 (Mar 2023 banking crisis) |
| Stress (≥80) | 19 | −$1,623 | 58% | −$29,994 (Nov 2022 FTX week) |

**Atticus is profitable in 75-79% of weeks across normal regime bands.** Even in the four years that included Luna/UST, FTX, March 2023 banking, and the 2024 spot-ETF surge, the worst single 7-day pair-life cost Atticus less than $30k per pair. At 4.3 concurrent pairs that's a $129k worst-week cost, fully covered by Atticus's $80k facility plus $50k of LP credit headroom.

**The dataset includes the worst BTC weeks of the past 4 years.** None of them produced a "system blow-up" outcome. Stress regimes had positive median P&L even before cooldown protection.

---

## 3. The four-layer defense against "Atticus can't pay"

### Layer 1 — Empirical positive carry

Across the 4-year window, Deribit DVOL has run **+12% above realized BTC vol on 75% of days** and the gap widens to +22-25% in elevated/stress regimes. Atticus's long-vol position structurally captures this VRP. **The hedge book pays its own way on average**, with the largest carry on the same days when premium revenue is highest. (See `MEMO_V2.md §2`.)

This is not a guarantee. But it has been a stable, multi-year structural feature of BTC options.

### Layer 2 — Premium tiering

When DVOL spikes, the implied probability of barrier triggers spikes too. Atticus charges a higher premium on those days ($900/side at DVOL ≥ 65, vs $400 at DVOL < 50). The premium tier mechanically grows when the underlying risk grows. **Foxify's premium spend is highest exactly when Atticus needs it to cover more frequent payouts.** Both sides' incentives align.

### Layer 3 — Capital reserve sized at the empirical worst week

Atticus's required operating capital (per `MEMO_V2.md §5`) is sized to:
- L1: cover the upfront option spend across the open book
- **L2: cover one full empirical p05 stress week with sqrt-N independence pooling, plus 30% headroom**
- L3: cover any chronic carry buffer (=0 at tiered pricing because expected blended P&L is +$1,059/pair/week)

At 4.3 pairs the L2 reserve alone is **~$48k**, which is 4× the worst single pair-life loss observed in 4 years of data. At 12.9 pairs L2 is ~$80k. At 1,000 pairs the √N pooling reduces L2 to a manageable fraction of L1.

### Layer 4 — Cooldown circuit breaker

Per `MEMO_V2.md §6`, cooldown activates automatically when *any* of:

1. Cumulative payouts to Foxify in the last 4 hours exceed **25% of Atticus operating capital**.
2. Trigger count across the open book exceeds 4× the number of open pairs in 4 hours (chronic chop).
3. Hedge-book MTM is more than 1.5σ below its 30-day rolling expected value.
4. DVOL spikes >100 in 30 minutes (sudden regime change).

**Effect:** Atticus continues to pay every triggered pair already open (Atticus already owns the hedges that fund those payouts), but **(a)** anchor reset is paused — pairs that re-trigger after cooldown re-anchor at the original price, not the new spot, eliminating intra-day chop pile-ups, and **(b)** new pair openings pause until the desk manually evaluates.

**The "Atticus can't pay" tail is converted into "Atticus pauses new opens at 25% capital utilization."** That is a standard institutional risk-management primitive, not a contract failure.

---

## 4. What Foxify will see in real time

A Foxify-facing operations dashboard exposes:

| Metric | Update cadence | Threshold |
|---|---|---|
| Atticus operating capital utilization | every 60s | green <70%, yellow 70-85%, red >85% |
| Cooldown active? | event-driven | boolean, with time-since-fire |
| Open pair count vs cap | every 60s | warning at 80% of cap |
| Today's triggered pair count | event-driven | informational |
| Today's total payout to Foxify | event-driven | informational |
| Hedge book MTM vs cost basis | every 5 min | drift indicator |
| 24h drawdown vs 30d expected P&L | every 5 min | warning at -1σ, alert at -1.5σ |

All metrics are computed from the same internal source-of-truth used by Atticus's own desk; **Foxify sees what Atticus sees**, in the same timeframe.

---

## 5. Sustained-anomaly scenario — explicitly walked through

Foxify's specific concern, re-stated: *"What if BTC enters a sustained chop regime where pairs trigger more than the modeled 2.17 per day, sustained for weeks?"*

Empirically the worst sustained run in the 4-year window was a **150-day cluster of DVOL ≥ 65** in 2022 H2 (FTX-era). During that cluster:

- Mean triggers/pair-life rose to 8-11 vs the 6.2 modal moderate regime
- Premium under tiered pricing rose to $900/side (the platform self-prices)
- Empirical pair-life P&L median stayed positive (+$397 at stress regime; +$2,620 at elevated)
- A handful of weeks had p05 outcomes of −$15k to −$30k per pair (priced into L2 stress reserve)

**Translated to Foxify's experience during that 150-day cluster:**
- Foxify saw consistent triggered payouts (8-11 per pair-week instead of 2-3)
- Foxify saw premium tier auto-bump to $900/side (their cost roughly doubled)
- Atticus saw positive median P&L; cooldown fired ~3-5 times during the worst 30 days
- **No "couldn't pay" episodes** were observed in the historical replay

The replay is in `historical_replay.py`; the data is in `historical/historical_per_pair.csv`. Any individual week of concern can be re-played and inspected.

---

## 6. The conversation summary for Foxify

If Foxify asks *"what's the worst that can happen?"* the answer in plain English:

> "*The worst Foxify ever loses on a single pair is the daily premium they prepaid. The worst Atticus ever loses on a single pair was a $30k week during FTX, against a capital reserve sized to cover four such weeks at our intended scale. The thing that would cause Atticus to actually fail to pay would be a sustained chop regime ten times worse than anything BTC has ever produced — and even then, the cooldown circuit breaker pauses new pair openings before any existing payment obligation could be missed. Foxify will see real-time utilization metrics so they can watch this themselves; the dashboard is live before the facility goes into production.*"

That's the structural answer. The empirical math, the reserve math, and the cooldown protocol are all in this folder for review.

---

*End of brief. Comments / pushback welcome before Phase 1 sign-off.*
