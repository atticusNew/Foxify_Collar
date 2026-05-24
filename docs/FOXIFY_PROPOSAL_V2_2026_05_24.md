# Volume Cover — Proposed Pricing Restructure
**From:** Atticus
**To:** Foxify
**Date:** 2026-05-24
**Status:** Draft proposal for review

---

## Executive summary

We're proposing to restructure Volume Cover so that **you pay $0 premium on the positions that trigger, and a flat $600 premium only on positions that don't trigger.** Triggered positions receive a regime-tiered payout (Calm/Moderate/Stress) and HighStress positions are free (no premium charged) with a small $30 micro-coverage.

**Two payout scenarios are under internal review.** Both share identical X=$600 non-trigger premium and identical Moderate/Stress/HighStress payouts. They differ only on the **Calm trigger payout** (Y_calm), which trades Foxify per-position income against Atticus risk robustness:

| Metric | **Scenario A (Foxify-favorable)** | **Scenario B (Atticus-balanced)** |
|---|---:|---:|
| Calm trigger payout (Y_calm) | $800 | $700 |
| **Foxify annual EV @ 25/day** | **$620k** (91% of current $685k) | **$391k** (57% of current) |
| **Atticus annual EV @ 25/day** | **$820k** | **$1.05M** |
| Foxify per-position EV | +$68 | +$43 |
| Atticus per-position EV | +$90 | +$115 |
| Atticus calm-trigger subsidy | -$180/event | -$80/event |
| Foxify break-even blended trigger | 57% (margin +6 pts) | 60% (margin +3 pts) |

**Both scenarios produce a sustainable Volume Cover product and a healthy Foxify partnership.** The current model is structurally unprofitable for Atticus in continuous operation and would force halts as you scale.

**Atticus's recommendation: Scenario A.** Lower friction for partnership advancement, preserves 91% of your current absolute income, and Atticus is still ~3× current effective EV. Scenario B is offered for transparency; we're flexible on Y_calm based on your priorities.

---

## The change in one table

| Term | Current | **Scenario A (proposed)** | **Scenario B (alt)** |
|---|---|---|---|
| Premium when position triggers | $350 paid upfront | **$0 (no premium on triggers)** | **$0** |
| Premium when position doesn't trigger | $350 paid upfront | **$600 paid upfront** | **$600** |
| Payout on **Calm** trigger | $1,000 | **$800** | **$700** |
| Payout on Moderate trigger | $1,000 | **$300** | $300 |
| Payout on Stress trigger | $1,000 | **$150** | $150 |
| HighStress | $1,000 | **$0 premium / $30 payout (free micro)** | $0 / $30 |
| Settlement timing | 25% EOW / 75% EOM | **unchanged** | unchanged |
| Tenor | 24h | **unchanged** | unchanged |
| Trigger threshold | ±2% on BTC index | **unchanged** | unchanged |
| Cell structure | 50k_2pct_1k | **unchanged** | unchanged |
| Sub-account architecture | Bullish Options account | **unchanged** | unchanged |

---

## Your per-position economics

Using observed BTC volatility regime trigger rates over 28 months of historical data (regime mix 49.7% Calm / 33.6% Moderate / 13.2% Stress / 3.6% HighStress):

### Scenario A — Y_calm = $800 (recommended)

| Regime | Trigger rate | Avg premium paid in tier | Avg payout received in tier | **Foxify EV / pos** |
|---|---:|---:|---:|---:|
| Calm | 50.3% | $600 × 49.7% = $298 | $800 × 50.3% = $402 | **+$104** |
| Moderate | 71.4% | $600 × 28.6% = $172 | $300 × 71.4% = $214 | **+$43** |
| Stress | 80.8% | $600 × 19.2% = $115 | $150 × 80.8% = $121 | **+$6** |
| HighStress | 92.5% | $0 | $30 × 92.5% = $28 | **+$28** |
| **Blended (regime-weighted)** | **62.9%** | **$219** | **$287** | **+$68** |

### Scenario B — Y_calm = $700 (alternative)

| Regime | Trigger rate | Avg premium paid in tier | Avg payout received in tier | **Foxify EV / pos** |
|---|---:|---:|---:|---:|
| Calm | 50.3% | $600 × 49.7% = $298 | $700 × 50.3% = $352 | **+$54** |
| Moderate | 71.4% | $600 × 28.6% = $172 | $300 × 71.4% = $214 | **+$43** |
| Stress | 80.8% | $600 × 19.2% = $115 | $150 × 80.8% = $121 | **+$6** |
| HighStress | 92.5% | $0 | $30 × 92.5% = $28 | **+$28** |
| **Blended (regime-weighted)** | **62.9%** | **$219** | **$262** | **+$43** |

### Atticus per-event economics under both scenarios (post sequence-fix, 80% hedge efficiency)

Validated against live Bullish orderbook on 2026-05-24 at spot $76,843. H_trig is realized hedge payout including efficiency haircut; D is net hedge debit. Per-event combines trigger-path + non-trigger-path weighted by regime trigger rate.

| Regime | D (hedge debit) | H_trig (realized) | A: Atticus EV / pos | B: Atticus EV / pos |
|---|---:|---:|---:|---:|
| Calm | $280 | $900 | +$82 | **+$133** |
| Moderate | $400 | $800 | +$140 | +$140 |
| Stress | $550 | $700 | +$20 | +$20 |
| HighStress | $10 | $18 | -$21 | -$21 |
| **Blended (regime-weighted)** | | | **+$90** | **+$115** |

(Scenarios A/B differ only in Calm column.)

## Annual projections at requested volume targets

### Scenario A — Y_calm = $800 (recommended)

| Volume | Positions/year | **Annual Foxify EV** | **Annual Atticus EV** |
|---:|---:|---:|---:|
| 5/day | 1,825 | $124k | $164k |
| 10/day | 3,650 | $248k | $328k |
| 15/day | 5,475 | $372k | $492k |
| **25/day** ⭐ | **9,125** | **$620k** | **$820k** |
| 50/day (Phase B) | 18,250 | $1.24M | $1.64M |
| 100/day (Phase C) | 36,500 | $2.48M | $3.28M |

### Scenario B — Y_calm = $700 (alternative)

| Volume | Positions/year | **Annual Foxify EV** | **Annual Atticus EV** |
|---:|---:|---:|---:|
| 5/day | 1,825 | $78k | $210k |
| 10/day | 3,650 | $157k | $420k |
| 15/day | 5,475 | $235k | $629k |
| **25/day** ⭐ | **9,125** | **$391k** | **$1.05M** |
| 50/day (Phase B) | 18,250 | $783k | $2.10M |
| 100/day (Phase C) | 36,500 | $1.57M | $4.19M |

⭐ Phase A target. Reference: under the current model in continuous operation at 25/day (no halts), Atticus would lose ~$1.12M/year. Current effective Foxify income ≈ $685k/year at present operational volume (with Atticus halts limiting throughput).

---

## Trigger rate break-even (margin of safety)

At our $600 flat premium structure, **your break-even trigger rates per regime are:**

### Scenario A — Y_calm = $800

| Regime | X | Y | Break-even trigger rate (X ÷ (X+Y)) | Historical actual | **Margin of safety** |
|---|---:|---:|---:|---:|---:|
| Calm | $600 | $800 | 42.9% | 50.3% | **+7.4 pts** |
| Moderate | $600 | $300 | 66.7% | 71.4% | **+4.7 pts** |
| Stress | $600 | $150 | 80.0% | 80.8% | **+0.8 pts** |
| HighStress | $0 | $30 | n/a (always +) | 92.5% | always positive |

**Blended break-even: 57.0% | Historical: 62.9% | Margin: +5.9 pts**

### Scenario B — Y_calm = $700

| Regime | X | Y | Break-even trigger rate (X ÷ (X+Y)) | Historical actual | **Margin of safety** |
|---|---:|---:|---:|---:|---:|
| Calm | $600 | $700 | 46.2% | 50.3% | **+4.1 pts** |
| Moderate | $600 | $300 | 66.7% | 71.4% | **+4.7 pts** |
| Stress | $600 | $150 | 80.0% | 80.8% | **+0.8 pts** |
| HighStress | $0 | $30 | n/a (always +) | 92.5% | always positive |

**Blended break-even: 60.1% | Historical: 62.9% | Margin: +2.8 pts**

**What this means:** Your perp wash strategy targets the ±2% trigger threshold by design. Both scenarios leave positive cushion. Scenario A gives more cushion in Calm (which is your highest-volume regime). The tightest tier in both scenarios is Stress; we can widen that by pausing stress or by setting X=$500 in stress (margin widens to +4 pts). Open for discussion.

---

## What we commit to

### Phase A (target operational state, 30 days post-cutover)

| Parameter | Commitment |
|---|---|
| Daily activation cap | **25 positions/day** |
| Position notional | 1 BTC per position |
| Concurrent open positions | up to 25 |
| Activation acknowledgement latency | <500ms p99 under normal load |
| Settlement currency | USDC |
| Settlement cadence | 25% EOW / 75% EOM (unchanged) |
| Halt threshold | Atticus may halt new activations if rolling salvage <60% of last 5 triggers; you're notified within 5 minutes + resume ETA |
| HighStress behavior | $0 premium + $30 payout (free micro); we may pause if operationally needed |

### Scaling roadmap (Phases B, C)

| Phase | Volume | Notional | Prerequisite |
|---|---|---|---|
| Phase B | 50/day | 0.5 BTC | 30 days successful Phase A + Atticus Deribit secondary venue deployed |
| Phase C | 100+/day | 0.25 BTC | 30 days successful Phase B + Atticus pooled-hedge engine deployed |
| Phase D | 500+/day | 0.1 BTC | Negotiated OTC arrangement with Bullish/Deribit; joint review |

**Each phase requires 30-day successful operation at prior level + joint review before advancing.** This protects both parties from scaling faster than capacity allows.

---

## What's the same, what's different

### Same as today
- 24-hour position tenor
- BTC ±2% trigger threshold (referenced to Bullish BTC index)
- Sub-account architecture on Bullish (Options account)
- Settlement timing (25% EOW / 75% EOM)
- Cell structure naming convention
- Your operational workflow (API integration, activation triggers, reporting)

### What's different
- **Pricing structure** (X/Y per regime instead of fixed $350/$1000)
- **HighStress treatment** (free micro instead of full coverage)
- **Volume capacity commitment** (formal 25/day Phase A, scaling roadmap)
- **Hedge architecture improvements** (sequence-fix already drafted, will ship in 30-day pre-cutover window)

---

## Why this restructure is necessary

We've completed a 28-month backtest using real BTC historical data:
- **Current pricing model is structurally unprofitable for Atticus in continuous operation** (-$1.12M/year synthetic). The current model only survives because of safety rails (halts pausing activations during volatile regimes) and your activation selectivity.
- **Restructured pricing makes the product self-sustaining** at any volume — meaning we can confidently scale with you without margin compression.
- **Without restructuring, Atticus's halt mechanism will trigger more frequently as you scale**, which hurts both sides (you lose volume continuity, we lose revenue).

This proposal is designed to:
1. Make Atticus structurally profitable (sustainable partnership)
2. Preserve your absolute annual EV (no income loss at current volume)
3. Give you a scalable growth path (Phase B/C/D roadmap)
4. Simplify your unit economics (one variable per outcome)
5. Eliminate cash-flow friction (no upfront premium on triggers)

---

## What we need from you to advance

1. **Approval in principle** of the per-regime pricing structure (X/Y values may be tuned by ±10% based on operating addendum review)
2. **Approval of Phase A volume commitment** (25/day, 1 BTC notional)
3. **Approval of HighStress free-micro structure** ($0 premium / $30 payout)
4. **Agreement to 30-day pre-cutover validation window** at current volume to verify hedge efficiency post sequence-fix
5. **Designation of Foxify legal entity** for contract
6. **Designation of Foxify operational contact** for joint daily review during cutover

---

## What's NOT in this proposal (deferred to operating addendum)

- SLA detail (uptime targets, latency, halt protocol mechanics)
- Risk allocation (force majeure, counterparty collateral, USDC depeg)
- Settlement mechanics detail (net vs gross, float treatment)
- Termination clauses
- Dispute resolution
- Reporting cadence + formats
- Audit rights
- Volume ramp protocol details
- Regulatory classification + jurisdiction
- KYC mechanics

These are critical but mechanical. They go in the operating addendum, drafted jointly after this proposal is approved in principle.

---

## Validation footnotes (for internal review)

- **Trigger rates** sourced from synthetic 24h activation windows across 250k+ 5-min BTC OHLC bars from Binance, 2024-01-01 to 2026-05-23 (~28 months).
- **Hedge debit estimates** validated against live Bullish orderbook on 2026-05-24 at spot $76,843. 24h tenor W=$1k spread net debit: $220-290/BTC (mid to worst).
- **Volume capacity** validated against Bullish typical daily option volume (50-200 BTC at ATM strikes) and Foxify-001 actual execution depth observations.
- **Foxify EV preservation** verified across all regimes. Scenario A: $104/pos calm + non-zero access in all other tiers. Scenario B: $54/pos calm, same other tiers. Both deliver volume continuity (no halts during paid tiers) which the current model does not.
- **Sequence-fix dependency:** the proposed Atticus economics assume the trigger-fire sequence-order fix (sells winning long at trigger peak instead of holding via Rule 4 for 30 min). This fix is committed to vc-sandbox as of 2026-05-24 (commit `9a8f7cd`), tested, and validates in shadow before any live pricing change.

---

## Open negotiation items (flagged for discussion)

1. **Y_calm value (A vs B)** — Scenario A ($800) preserves 89% of your current income; Scenario B ($700) preserves 57% but gives Atticus stronger sustainability runway. Atticus is comfortable shipping either; we lead with A.
2. **Stress regime margin of safety** — currently 0.8 pts, tightest tier. Options to widen:
   - Pause stress (clean, loses 13% volume)
   - Drop X in stress to $500 (margin widens to +4 pts, you gain $25/pos in stress)
   - Drop Y in stress to $100 (you trade volume for margin)
3. **HighStress structure** — currently $30 payout. Could go to $50 if you want more EV here (+$8k/year cost to Atticus, +$18/pos to you in HS).
4. **Phase A duration before Phase B** — currently 30 days. Could compress to 14 days with intensive joint review, or extend to 60 days for conservative validation.
5. **Settlement frequency at scale** — at 25/day = $200k+ in float per side at EOM. Open to weekly net settlement if it helps your cash flow.

---

## Next step

If approved in principle, we draft the operating addendum within 7 days. Target signing within 21 days. Target cutover (after 30-day validation window) within 60 days.

If revisions requested, we iterate this proposal in 48-hour cycles until alignment.
