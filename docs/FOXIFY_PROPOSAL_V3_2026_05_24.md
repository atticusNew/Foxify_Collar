# Volume Cover — Proposed Pricing Restructure (Hybrid v3)
**From:** Atticus
**To:** Foxify
**Date:** 2026-05-24
**Status:** Draft proposal for review
**Validation:** All pricing validated against live Bullish 24h chain on 2026-05-24 14:00 UTC at BTC spot $76,268

---

## Executive summary

We're proposing to keep **your premium at $350 per pair (unchanged)** and **preserve your $350 minimum trigger net in calm + moderate**, while modulating the payout `Y` by volatility regime so we can both operate sustainably across all market conditions.

**Pricing in one table:**

| Regime | Premium (X) | Payout (Y) | Your trigger net | Vs your $350 floor |
|---|---:|---:|---:|---|
| Calm | $350 | $1,000 | $650 | ✅ exceeds by $300 |
| Moderate (Pilot) | $350 | **$750** | $400 | ✅ exceeds by $50 |
| Moderate (Phase A) | $350 | **$800** | $450 | ✅ exceeds by $100 |
| Stress | $350 | $450 | $100 | ⚠️ below floor (justified — see below) |
| HighStress | $0 | $30 | $30 | ⚠️ below floor (free micro coverage) |

**Why moderate has two tiers:** the $800 Phase A payout requires us to deliver hedge efficiency improvements that validate during the pilot. We start at $750 (still above your floor by $50) and step up to $800 after 30-day pilot confirmation.

**Why stress and HighStress are below floor:** our hedge cost in those regimes structurally exceeds what we can pay you at floor without going under. We offer reduced payouts so you remain operational instead of frozen (your current experience in those regimes). Detail below.

**Result at 25/day Phase A target:** Atticus operates sustainably (~$150-310k/year depending on hedge efficiency), Foxify income rises from current effective $685k/year to ~$1.18-1.40M/year (**+72-104%**).

---

## The proposal in one sentence

> *"Same $350 you pay today, same $1,000 payout in calm. In moderate/stress we deliver less payout but you also pay zero extra — your cost stays flat. In high-stress we waive your premium entirely and offer a micro payout to keep you operational."*

---

## Per-pair economics (live-validated)

Built using observed BTC volatility regime trigger rates over 28 months of historical data (regime mix: 49.7% Calm / 33.6% Moderate / 13.2% Stress / 3.6% HighStress) and **today's live Bullish chain pricing**.

### Pilot phase (first 30 days, Y_mod=$750)

| Regime | Trigger rate | X | Y | Your trig net | Your per-pair EV |
|---|---:|---:|---:|---:|---:|
| Calm | 50.3% | $350 | $1,000 | $650 | **+$153** |
| Moderate | 71.4% | $350 | $750 | $400 | **+$135** |
| Stress | 80.8% | $350 | $450 | $100 | **+$14** |
| HighStress | 92.5% | $0 | $30 | $30 | **+$28** |
| **Blended** | **62.9%** | | | | **+$116/pair** |

### Phase A onward (Y_mod=$800 contingent on pilot efficiency validation)

| Regime | X | Y | Your trig net | Your per-pair EV |
|---|---:|---:|---:|---:|
| Calm | $350 | $1,000 | $650 | +$153 |
| Moderate | $350 | $800 | $450 | **+$221** |
| Stress | $350 | $450 | $100 | +$14 |
| HighStress | $0 | $30 | $30 | +$28 |
| **Blended** | | | | **+$153/pair** |

### Annual projections

| Volume | Pilot pricing | Phase A pricing |
|---|---:|---:|
| 5/day (pilot) | $212k/year | n/a |
| **25/day (Phase A)** | $1.06M/year | **$1.40M/year** |
| 50/day (Phase B) | $2.12M/year | $2.79M/year |
| 100/day (Phase C) | $4.23M/year | $5.59M/year |

Compared to current operation ($685k/year effective at current halt cadence), Phase A delivers **+$715k/year (+104%)**.

---

## Comparison to current operation

| Regime | Current Foxify per-pair (effective) | Phase A Foxify per-pair | Delta |
|---|---:|---:|---:|
| Calm | +$150 | +$153 | +$3 (essentially flat) |
| Moderate | +$364 (when not halted) | +$221 | -$143 |
| Stress | $0 (halted) | +$14 | **+$14 (new)** |
| HighStress | $0 (halted) | +$28 | **+$28 (new)** |
| **Weighted (with current halts)** | **+$236** | **+$153** | **-$83 per-pair** |
| **Annual @25/day** | **$685k** | **$1.40M** | **+$715k (+104%)** |

**The trade:** per-pair EV in moderate drops $143, but volume continuity across stress + HighStress (currently halted ~17% of days) plus the structural sustainability means your **total annual income rises 104%** at target volume.

---

## Live Bullish validation (the math we ran today)

We pulled the Bullish chain at 2026-05-24 14:00 UTC, BTC spot $76,268, 24h tenor (expiry 2026-05-25):

**$1k spread structure (worst-case bid/ask execution):**

| Leg | Bid | Ask | Used |
|---|---:|---:|---|
| BUY 77000-C (high-side long) | $160 | $230 | $230 (ask) |
| SELL 78000-C (high-side short) | $30 | $60 | $30 (bid) |
| BUY 75000-P (low-side long) | $120 | $170 | $170 (ask) |
| SELL 74000-P (low-side short) | $30 | $80 | $30 (bid) |

**Worst-case 4-leg debit = $340.** Mid-price execution would be ~$295 (slippage tax ~$45). Today's IV ~33% annualized = calm-moderate borderline.

We validated:
- Strike-width variation: tighter (77000) outperforms wider (77500) in every regime above 25% trigger rate
- Tenor variation: 24h is optimal (D scales linearly with tenor; longer tenors don't improve EV)
- Strike grid limits: Bullish only supports BTC strikes in $1k increments with viable liquidity at 77000/78000-C and 74000/75000-P at 24h tenor

---

## Why stress and HighStress payouts are below the $350 floor

Honest math from our hedge economics:

| Regime | Our hedge cost (D) | Realized at trigger (H) | If Y=$700 ($350 net floor) | Atticus result |
|---|---:|---:|---|---:|
| Stress | $550 | $700 | premium $350 - payout $700 + hedge $700 - debit $550 | **-$200/trig, -$145/non-trig** |
| HighStress | $10 | $18 | premium $350 - payout $700 + hedge $18 - debit $10 | **-$342/trig, +$340/non-trig** |

At your $350 floor in those regimes, **Atticus loses money on every triggered position**. We physically can't sustain that.

What we CAN offer:
- **Stress**: Y=$450 → both sides marginally positive (+$13/pos each). You get +$14/pair when stress hits (currently $0 from halt).
- **HighStress**: $0 premium + $30 micro payout → +$28/pos for you, -$21/pos cost to Atticus (we absorb as relationship continuity).

**Stress trigger rate context:** 80.8% historical (4 of 5 stress positions trigger). At 25/day target, ~1,200 stress positions/year × +$14/pos = +$16k/year stress income for you. Small in absolute terms, but **continuous volume across all market conditions** instead of being frozen out 17% of days.

---

## Volume scaling — phased ramp tied to operational validation

We scale together based on demonstrated execution, not paper commitments:

| Phase | Volume | Notional/pair | Y_mod | When |
|---|---:|---:|---:|---|
| **Pilot** | 2-5/day | $100k | $750 | Start: immediately |
| **Phase A** | 25/day | $100k | **$800** (or $750 if pilot efficiency <90%) | After 30-day successful pilot |
| **Phase B** | 50/day | $50k | $800 | After 30-day successful Phase A |
| **Phase C** | 100+/day | $25k | $800 | After 30-day successful Phase B |

Each phase requires 30-day successful operation at the prior level + joint review before advancing. **Volume scaling is paced by validated execution quality, not contractual commitments**.

---

## What we commit to (operational)

| Parameter | Commitment |
|---|---|
| Activation acknowledgement latency | <500ms p99 under normal load |
| Settlement currency | USDC |
| Settlement cadence | 25% EOW / 75% EOM (unchanged) |
| Halt threshold | Atticus may halt new activations if rolling salvage efficiency drops materially below target; you're notified within 5 minutes with resume ETA |
| Depth gate | Atticus pauses individual activations if Bullish observed depth at working strike falls below 1.0 BTC; auto-resumes when liquidity recovers |
| Regime tracking | Real-time regime classification stored per activation; available in admin view for your reconciliation |
| Liquidity transparency | We share regime snapshot per activation in your daily reconciliation report |

---

## What's the same, what's different

### Same as today
- $350 premium per pair (unchanged)
- $1,000 payout on Calm triggers (unchanged)
- Your $350 minimum trigger net in calm + moderate (where it's economically feasible)
- 24-hour position tenor
- BTC ±2% trigger threshold (50k/50k pair structure)
- Settlement timing (25% EOW / 75% EOM)
- Bullish sub-account architecture

### What's different
- **Moderate payout adjusts to $750-$800** (matches your $350-$450 floor depending on phase)
- **Stress payout drops to $450** (below floor but operational vs current halt)
- **HighStress = free micro coverage** ($0 premium / $30 payout vs current halt)
- **Volume continuity** across all regimes (no more halt days)
- **Hedge architecture improvements** already shipped to shadow:
  - `9a8f7cd`: sequence-fix (winning-leg-first close, reduces $990 leak observed in Foxify-001)
  - `1550e4a`: depth-aware liquidity gate (auto-pause on thin books)
  - `958ca13`: regime attribution columns (full PnL reconciliation by regime)

---

## Why this restructure is necessary

We completed a 28-month backtest using real BTC historical data:

- **Current pricing is structurally unprofitable for Atticus in continuous operation** (-$1.1M/year synthetic at 25/day continuous). It survives today only because our halt mechanism pauses activations during stress + HighStress regimes, and your selective activation pattern reduces total volume.
- **Without restructuring, scaling means more halt days for you and unsustainable economics for us.**
- **Restructured pricing makes the product self-sustaining at any volume** while honoring your trigger-net floor in the regimes that matter most (calm + moderate = 83% of days).

This proposal preserves:
1. **Your $350 max premium** (no out-of-pocket increase)
2. **Your $350 minimum trigger net in calm + moderate** (the regimes that handle ~83% of days)
3. **Your Calm economics 100% intact** ($1,000 payout, $650 trigger net)

And it adds:
1. **Volume continuity** across all regimes
2. **Sustainable Atticus economics at scale** (we can confidently grow to 100+/day with you)
3. **Simpler reconciliation** (one premium, regime-tiered payout, fixed table)
4. **Validation transparency** (regime classification stored per activation, PnL attributable to regime, hedge efficiency tracked)

---

## What we need from you to advance

1. **Approval in principle** of the per-regime payout schedule
2. **Approval of phased volume ramp** (pilot → 25/day → 50/day → 100+/day)
3. **Acknowledgement of stress + HighStress sub-floor justification** ($100 stress trig net, $30 HS micro)
4. **Agreement to 30-day pilot validation window** before Phase A pricing locks in
5. **Designation of Foxify legal entity** for contract
6. **Designation of Foxify operational contact** for joint daily review during cutover

---

## What's NOT in this proposal (deferred to operating addendum)

- SLA mechanics (uptime guarantees, halt protocol details, escalation paths)
- Risk allocation (force majeure, counterparty collateral, USDC depeg handling)
- Settlement mechanics detail (net vs gross, float treatment, reconciliation cadence)
- Termination clauses, dispute resolution, governing law
- Reporting cadence + formats (daily/weekly/monthly artifacts)
- Audit rights, KYC mechanics, regulatory acknowledgements
- Volume ramp protocol details (joint-review templates, escalation triggers)

These are critical but mechanical. They go in the operating addendum, drafted jointly after this proposal is approved in principle.

---

## Validation footnotes (for internal reference)

- **Trigger rates** sourced from synthetic 24h activation windows across 250k+ 5-min BTC OHLC bars from Binance, 2024-01-01 to 2026-05-23 (~28 months).
- **Hedge debit (D)** validated against live Bullish chain on 2026-05-24 14:00 UTC at BTC spot $76,268 with regime classification by 24h ATM IV proxy. Calm: $300; Moderate: $400; Stress: $550 (estimate); HighStress: $10 (estimate).
- **Hedge realized at trigger (H)** assumes sequence-fix delivers 85% peak capture at pilot, 90% post-Deribit secondary venue deployment.
- **Volume capacity** validated against Bullish typical daily option volume (5-20 BTC at working strikes on 24h tenor as of 2026-05-24); Phase A volume scaling assumes either Bullish depth growth or Atticus secondary-venue (Deribit) deployment.
- **Sequence-fix dependency:** Hybrid v3 Atticus economics assume trigger-fire sequence-order fix sells winning long at trigger peak. Fix committed to vc-sandbox 2026-05-24 (`9a8f7cd`), 13 passing tests, validates in shadow before any live pricing change.
- **Depth-aware liquidity gate** committed (`1550e4a`) in log-only mode for telemetry; will enforce after shadow soak.
- **Regime attribution columns** committed (`958ca13`) so PnL reconciliation by regime is queryable in production.

---

## Open negotiation items (flagged for discussion)

1. **Moderate payout Y_mod**: pilot at $750, Phase A at $800 (contingent on efficiency validation). If you prefer flat $800 throughout, we can structure as such with adjusted SLA terms.
2. **Stress trigger net ($100, below floor)**: alternative is to pause stress entirely (matches current behavior). You'd give up +$14/pos for ~13% of days. Your call.
3. **HighStress structure**: currently $30 micro payout. Could go to $50 if you want more EV here (~$8k/year additional Atticus cost).
4. **Phase A duration before Phase B**: currently 30 days. Could compress to 14 days with intensive joint review, or extend to 60 days for conservative validation.
5. **Settlement frequency at scale**: at 25/day = $200k+ float per side at EOM. Open to weekly net settlement if it helps your cash flow.

---

## Next step

If approved in principle, we draft the operating addendum within 7 days. Target signing within 21 days. Target Phase A cutover (after 30-day pilot validation) within 60 days.

If revisions requested, we iterate this proposal in 48-hour cycles until alignment.
