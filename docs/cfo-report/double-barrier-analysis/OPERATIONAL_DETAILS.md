# Operational Details — TP, Option Selection, Cooldown, Essentials

> **Audience:** founder + CFO + ops desk.
> **Purpose:** answer the operational-detail questions raised in the V2.1
> review. Companion to `MEMO_V2.md` (strategy), `PREMIUM_RECOMMENDATION.md`
> (pricing), `COOLDOWN_CIRCUIT_BREAKER_SPEC.md` (cooldown spec).

---

## 1. Premium clarification — per side vs per pair

All premium numbers in `MEMO_V2.md`, `PREMIUM_RECOMMENDATION.md`, and the
historical replay are quoted **per side per day**. Foxify pays for two
sides simultaneously (one LONG, one SHORT) on each pair, so:

```
    "premium per side per day"  ×  2  =  premium per pair per day
                                ×  7  =  premium per pair per 7-day life
```

Concrete values for the recommended 4-tier ladder:

| DVOL band | Per side / day | **Per pair / day** | Per pair / 7d life |
|---|---|---|---|
| <50 | $425 | **$850** | $5,950 |
| 50-65 | $600 | **$1,200** | $8,400 |
| 65-80 | $900 | **$1,800** | $12,600 |
| ≥80 | $1,100 | **$2,200** | $15,400 |

Or the simpler 2-tier alternative:

| DVOL band | Per side / day | Per pair / day | Per pair / 7d life |
|---|---|---|---|
| <65 | $525 | **$1,050** | $7,350 |
| ≥65 | $1,000 | **$2,000** | $14,000 |

**Comparison to the original V0 spec ($250/side):** the original ask was
$250 per side ($500 per pair). The recommended schedule moves to $425-$1,100
per side ($850-$2,200 per pair) — a ~70% to ~340% increase, depending on
DVOL band. The empirical analysis showed the $250/side starting point was
short-funded; the new ladder turns ~75% of weeks profitable across the
6.4-year tape including FTX, COVID, and Luna eras.

---

## 2. Hedge instrument — locked in: **daily ±2% strangle**

The recommendation, with reasons in priority order:

1. **Capital efficiency at the founder's stated scale.** $420 of upfront
   option spend per pair vs $5,400 for 30-day straddle. At 4.3 pairs that's
   $1,800 vs $23,000 of working capital tied up in option premium alone.
2. **Cleaner ops.** Daily legs auto-expire each morning; no stub-leg
   accumulation; one-line book-reset routine. The 30d strategy accumulates
   13-15 stub legs over a busy 7-day pair-life that all need MTM unwind.
3. **Better venue liquidity.** Per `PHASE_0_BIWEEKLY_PERDAY_SPEC.md §1`,
   1-day Deribit/Bullish bid-ask is materially tighter than 30-day at our
   notional size. The May-2021 China-ban window in our crisis test (where
   30-day legs would have struggled to unwind) is a representative example.
4. **No theta-carry myth dependency.** Under risk-neutral pricing, hedge
   instrument doesn't matter for E[PnL]; the empirical positive bias of 30d
   over daily comes from VRP capture and is real but not free — 30d ties
   up 13× more capital to harvest ~$610/pair-life of extra spread.

The 30-day straddle's empirical $610/pair-life advantage is real and
worth capturing, but **as a separable book-level vega overlay**, not as
the per-pair hedge:

> *Once Phase 1 is operational, optionally run a single 30-day BTC
> straddle on Atticus's own book (notional ~= total open pair notional /
> 5) as a vega overlay. This captures the VRP carry across the entire
> book without locking up capital per-pair, and is unwound on a
> calendar schedule, not on triggers.*

This is a Phase 3+ optimization, not Phase 1.

**Lock-in for Phase 1:** **daily ±2% strangle as the per-pair hedge.**

---

## 3. Cooldown — always monitoring, only activating when needed

The founder's clarification is exactly the design intent. To make this
unambiguous in production:

| Layer | Status | What it does |
|---|---|---|
| **Trigger-condition monitor** | **Always on** | Polls T1-T4 thresholds every 30 seconds; updates a single `cooldown_state` row in Postgres. Zero customer-visible effect. |
| **Cooldown actions** | **Off by default; activates only when a T1-T4 condition fires** | (a) anchor reset paused on triggers, (b) new pair openings rejected, (c) desk alerted. Existing pairs continue to pay. |

In normal operation (which the empirical replay says is 75% of weeks):

- Cooldown is monitoring continuously.
- Cooldown actions are **idle**.
- Foxify experiences the product exactly as if cooldown didn't exist.
- The Foxify-facing dashboard simply shows `cooldown_active: false`.

In stress operation:

- One of T1 (payout velocity ≥ 25% in 4h), T2 (4× trigger density), T3
  (hedge MTM 1.5σ below 30d expected), or T4 (DVOL spike >100 in 30min) fires.
- Cooldown actions activate for 4 hours (configurable).
- Foxify's dashboard updates: `cooldown_active: true, expected_clear_at: ...`.
- Existing triggered pairs continue to pay — Atticus already owns those
  hedges. Only NEW pair openings are paused, and intra-day re-anchoring
  is suspended.

The crisis-window stress test (`MEMO_V2.md §8`) showed this is not just
a "nice to have" — it's the difference between a survivable COVID-2020
chop window (~−$5-8k/pair with cooldown) and an unsurvivable one
(−$19k/pair without). **It's a defensive control that's invisible
unless and until the platform is at capital-protection risk.**

---

## 4. Essentials checklist — what else needs to ship before Phase 1

Cooldown is one of seven controls the volume facility needs in production.
Here's the full checklist, with status:

| # | Control | Status | Notes |
|---|---|---|---|
| 1 | **Cooldown circuit breaker** | spec'd, not coded | `COOLDOWN_CIRCUIT_BREAKER_SPEC.md`. ~3 days production code. |
| 2 | **Per-pair size cap + total open-pair cap** | partially exists for retail | Hard limit on simultaneously-open pairs. Phase 1: cap at 8 pairs. Phase 2: 25. Phase 3+: scale with capital. |
| 3 | **Max-loss-24h breaker** (separate from cooldown) | exists for retail; needs vol-facility config | Full operational halt when 24h Atticus drawdown exceeds threshold (e.g., $30k Phase 1). Hard stop, manual reset. |
| 4 | **Spot-feed staleness guard** | exists in `services/api/src/pilotMonitoring.ts` | Prevents false trigger detection when BTC feed lags. Reuse retail's monitor. |
| 5 | **Trigger reconciliation** (internal vs venue) | exists in retail trigger monitor | Verifies that Atticus's internal trigger detection matches what the venue's spot reference shows. Resolves grey-zone disputes with Foxify. |
| 6 | **Hedge venue failover** | partial (Deribit + Bullish exist as separate code paths) | If Bullish primary down, route fresh strangles to Deribit/Falcon X. ~1-2 days to wire the failover path into the new vol-facility hedge ladder. |
| 7 | **Settlement timing rules** | needs explicit Foxify contract terms | T+0 vs T+1 for trigger payouts; daily vs weekly netting for premium debits; reserve for the in-flight balance. **This is a Foxify-side commercial term, not engineering.** |
| 8 | **Tier-transition handling** | not yet specified | When DVOL crosses 50/65/80 mid-pair-life: do existing pairs keep their open-day premium tier, or auto-bump? **Recommendation: lock the tier at activation.** Eliminates surprise repricing for Foxify mid-flight. |
| 9 | **Auto-renew rules per pair** | exists in `services/api/scripts/pilotBacktestProposedA24m.ts` style | Foxify-configurable: opt-in/opt-out, per-direction, with cooldown override. Default opt-in (matches CFO doc Step 3). |

Items 1, 2, 7, 8 are the four that need an explicit decision before
Phase 1 activates real Foxify pairs. Items 3, 4, 5, 6, 9 reuse existing
retail-pilot infrastructure with vol-facility-specific config.

---

## 5. Take-profit (TP) on the hedge — how it actually works

### 5.1 What "TP" means in the volume facility

In retail, "TP" refers to the platform deciding *when* to sell a
triggered hedge back to capture remaining time-value. In the volume
facility with daily strangle, **the TP decision is essentially
deterministic and immediate — there's no holding period to optimize.**

### 5.2 Mechanic, step-by-step

```
T  +0:00:00  BTC crosses the +2% barrier on a pair.
T  +0:00:01  Trigger detector fires. Pair settles $1,000 to Foxify
             (existing internal accounting; cash leaves Atticus).
T  +0:00:02  Hedge unwind path activates:
             - Identify the in-the-money leg (the call, in this example).
             - Submit market sell order for the full leg notional
               (0.667 BTC of the call) at venue.
             - Receive proceeds = (intrinsic value if any) + remaining
               time value − venue spread.
T  +0:00:05  Order filled. Cash returns to Atticus venue account.

(Optional) Auto-renew: if the pair is set to auto-reform at the new
spot, a new daily strangle is opened for the LONG side at the new spot.
This is configurable per Foxify contract; default is opt-in matching
the existing CFO doc.
```

### 5.3 Where Atticus profits

The platform's per-trigger cash flow:

```
Atticus pays:    $1,000 to Foxify (trigger payout)
Atticus pays:    new option premium for renewed leg  (if auto-renew)
Atticus receives: intrinsic + remaining TV from the in-the-money leg sale
Atticus receives: previously prepaid premium from Foxify (already booked)
```

Because the option strike was set at the +2% barrier, the in-the-money
leg has **intrinsic = (move past barrier) × notional_qty**. On a
barely-graze trigger (BTC crosses +2% by $1), intrinsic ≈ $0 and
proceeds = remaining time value of an ATM 1-day option (typically
$40-$200 in calm regime, more in stress). On a continuation trigger
(BTC moves to +5%), intrinsic = $1,500 + remaining TV — substantially
more than the $1,000 paid out.

**This is the structural source of Atticus's edge:** the option's
upside is **uncapped**, but the trigger payout is **capped at $1,000**.
On large directional moves, the platform makes more on the hedge sale
than it pays out.

### 5.4 Risks on TP

| Risk | Mitigation |
|---|---|
| **Venue thin liquidity at trigger time** | (a) Daily strangle uses 1-day options, which have 5-10× tighter spreads than 30-day at our notional. (b) Failover to Deribit/Falcon X if Bullish bid disappears (item #6 in §4). |
| **Multi-pair simultaneous trigger market impact** | At 1,000 pairs in a correlated stress event, all 1,000 hedges hit the venue at once. Cooldown's T1 threshold fires before this concentration matters; for production hardening we'd add **TWAP execution** of large concentrated unwinds, but that's a Phase 3+ optimization. |
| **Stale orderbook quote** | The script polls bid at execution time; we don't market-sell into a yesterday's price. Same protection retail uses. |
| **Venue settlement delay** | Bullish is T+0 USDC settle; Deribit T+0; Falcon X T+1. Atticus needs settlement-bridge cash for T+1 case = sized into the L2 reserve in `MEMO_V2.md §5`. |

### 5.5 Tuning required?

**No.** With daily strangle, TP is mechanical. There's no "should I hold
for more upside" decision because:

- The trader's option has already exercised (they got their $1k payout).
- Atticus's hedge leg's expected residual value at end of day = leg's
  current value minus theta to expiry, which is small and known.
- Holding past the trigger means accepting unhedged short-vega exposure
  (the losing leg might decay further; the winning leg's gamma profile
  shifts as time passes).

For the **30-day straddle alternative**, TP genuinely requires tuning
(retail's TP V2 has multiple parameters in `services/api/scripts/pilotBacktestTpV2.ts`).
Daily strangle eliminates this tuning surface — another reason it's
the right Phase 1 choice.

---

## 6. Option selection — strikes, ATM vs OTM vs ITM

### 6.1 Current proposal: 2% OTM, matching the barrier

For each daily strangle the platform buys on a pair:

- **Call leg:** strike = anchor × 1.02 (the +2% upper barrier)
- **Put leg:** strike = anchor × 0.98 (the −2% lower barrier)
- **Quantity per leg:** notional_per_side / spot ≈ 0.667 BTC at $75k

These strikes are **set deterministically**; there's no per-trade
optimization needed.

### 6.2 Why "barrier-matched" is the right strike choice

| Strike | Cost (rel. to barrier-matched) | Intrinsic at trigger | When it works |
|---|---|---|---|
| ATM (0% OTM) | ~6× more | $1,000 (matches payout) | Risk-free hedge of payout but expensive; capital ROI lower |
| 1% OTM | ~3× more | $500 | Hybrid; partial intrinsic match |
| **2% OTM (barrier-matched)** | **baseline** | **$0 + TV** | **Recommended.** TV pays for the trigger; matches strike physics |
| 3% OTM | ~70% cheaper | $0 (only fires past 3% move) | Insufficient — many triggers wouldn't be covered at all |
| 5% OTM | ~30% of baseline cost | $0 except on 5%+ moves | Only useful as tail-risk hedge, not core |

**The 2% OTM barrier-matched choice is structurally optimal because:**

1. **Cost is minimized for the protection it provides.** Anything more
   ITM is paying for guaranteed-payout coverage we don't need
   (the trigger payout is fixed at $1,000 regardless of how far past
   the barrier BTC moves).
2. **The platform monetizes continuation moves.** When BTC moves 4%
   (well past the 2% barrier), the option is now 2% ITM with $1,000
   of intrinsic plus residual TV. Atticus captures the full upside;
   the trader's payout is still capped at $1,000. This asymmetry is
   the structural edge of the design.
3. **Empirical results bear this out.** The 6.4-year historical replay
   shows daily 2% OTM strangle is profitable in ~75% of weeks with
   blended +$1,059/pair-life E[PnL]. ATM strangles would shift the
   capital required up ~5-6× without proportional P&L lift.

### 6.3 Pros and cons of the chosen design

**Pros:**
- Cheapest hedge that mathematically matches the barrier
- Symmetric (call and put structurally identical, just opposite direction)
- No strike-selection optimization needed at runtime
- Captures continuation P&L via uncapped upside on the option vs capped trigger payout
- Simple to audit: one rule, one strike, one expiry per pair

**Cons:**
- Barely-graze triggers (BTC crosses 2% by < $50) capture mostly TV,
  not intrinsic — vulnerable to chop without VRP edge
- 1-day options need fresh purchase every day (operational cost — ~$2
  per pair per day in slippage)
- Doesn't capture VRP at the 30-day level (mitigated by the optional
  book-level vega overlay in §2)

### 6.4 What would be sub-optimal

- **Selecting strikes dynamically based on DVOL** would over-engineer for
  little benefit. Strike-vol interaction is captured automatically by
  buying at the venue ask each day.
- **Using a single combined strike (straddle, both legs at anchor)**
  instead of strangle would double the upfront cost and create
  asymmetric exposure when one side triggers (the other leg is now ITM
  rather than worthless).
- **OTM calls/puts at 3-5%** would be cheaper but would not pay out at
  the 2% trigger, leaving Atticus structurally short-funded. This is
  what V1's analysis disqualified.

### 6.5 Future optimization: dynamic 1-2% OTM blend

A potentially worth-exploring optimization (not for Phase 1):

> When DVOL is very high (>80) and barely-graze chop is the dominant
> failure mode, switch from 2% OTM to **1.5% OTM** for that day. Cost
> is ~25% higher but each trigger now captures ~$500 of intrinsic plus
> TV, materially closing the trigger-cost gap. Implementable as a
> runtime parameter in the existing hedge selector. Estimated
> contribution to stress-week p05: ~$3,000-$5,000 per pair-life
> improvement.

This is a Phase 3+ optimization on top of the Phase 1 baseline.
**Phase 1 is barrier-matched 2% OTM, full stop.**

---

## 7. One-page summary

| Question | Answer |
|---|---|
| Is $425 per side or per pair? | **Per side. $425 × 2 = $850/pair/day at the calm tier.** |
| What was the original spec? | $250/side ($500/pair) — the new ladder is ~1.7-4.4× higher across DVOL bands; required to clear the empirical breakeven. |
| Median price for DVOL <65? | **$525/side** ($1,050/pair) gives blended +$1,387/pair-life. |
| Daily strangle locked in? | **Yes for Phase 1.** Optional 30-day book-level vega overlay deferred to Phase 3+. |
| Cooldown always-on or only-when-needed? | **Always monitoring; only activates when T1-T4 fires.** Zero impact in normal operation. |
| Anything else essential? | Per-pair size cap, max-loss-24h breaker, settlement timing rules, tier-transition lock, hedge venue failover. Items 1, 2, 7, 8 in §4 need decisions before Phase 1. |
| TP mechanic? | **Mechanical, immediate, no tuning.** Sell the in-the-money leg on trigger; auto-renew if configured. |
| Option selection? | **2% OTM barrier-matched strangle.** Cheapest hedge that mathematically matches the trigger; structurally captures continuation P&L; no per-trade optimization needed. |

---

*End of operational details memo. Open for desk + engineering review.*
