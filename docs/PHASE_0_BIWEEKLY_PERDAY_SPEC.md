# Phase 0 — Biweekly Hedge + Per-Day Pricing Exploration (Analysis Only)

> **Status:** Phase 0 is **analysis only**. No production code changes. No
> live trading impact. The output of Phase 0 is a go/no-go decision document
> with real numbers; we then decide whether to proceed to Phase 1 (shadow
> mode) or revise the plan.

**Owner:** Atticus / Foxify pilot team
**Created:** 2026-04-30
**Decision target:** end of Phase 0 = a clear go/no-go on Phase 1 with real
calibration data, not estimates.

---

## 1. Why we're doing this

The current pilot architecture (1-day-tenor BTC options on Deribit, fixed
premium per tier per regime) has an empirically-confirmed structural
ceiling on triggered-trade recovery (~25% best case at 0.1 BTC hedge size,
avg 18% across 16 historical triggers). The proximate cause is Deribit
liquidity at our trade size on same-day-expiry options — confirmed by
the `3df5cfa1` lifecycle showing 285 consecutive `no_bid` retries over
4h 45min on a routine barely-graze SHORT trigger.

No amount of TP threshold tuning escapes this ceiling. To break it we
have to change either the hedge tenor, the hedge instrument, or both.

This spec scopes the **most promising candidate**: switch to **biweekly
(14-day) BTC option hedges** with a **per-day subscription pricing
model** capped at 14 days max user duration. The 14-day option tenor
matches the max user duration exactly (eliminating roll complexity);
biweekly options on Deribit have ~10x better bid-ask than dailies at
0.1 BTC size.

If the analysis math here works, we expect:
- Trader: ~50% lower per-day cost vs current 1-day pricing
- Trader: close anytime up to 14 days (subscription model, not 24h chunks)
- Platform: trigger recovery rises from 0-25% to 60-90% (per estimate)
- Platform: chronic per-trigger loss (~−$170) becomes roughly breakeven
  or modestly positive

**These are estimates.** Phase 0 turns them into real numbers using actual
Deribit data and a backtest of the 16 historical triggers.

---

## 2. Phase 0 deliverables (in this order)

### Deliverable 1 — Deribit biweekly option pricing dataset

Read-only script that pulls 90 days of Deribit historical option chain data
for biweekly (next-2-week) BTC options, then BS-fits an implied per-day
hedge cost for each of:

- 4 SL tiers (1%, 2%, 3%, 5%, 10%)
- 3 vol regime bands (low DVOL ≤50, moderate 50-65, elevated/high >65)
- Both LONG protection (put hedge) and SHORT protection (call hedge)

**Output:** a JSON/CSV table of `{ tier, regime, direction, biweekly_premium_btc,
implied_per_day_usd_per_1k_notional, sample_count, date_range }` rows,
plus a markdown summary of the pricing surface.

**Where the script lives:** `scripts/phase0/biweekly_pricing_calibration.{ts|py}`
(read-only; no DB writes; no live API calls beyond Deribit's public history endpoints).

**Definition of done:** runnable on the laptop with `node` or `python3`,
produces the table in `<5 min`, and a quick visual check shows the price
surface is monotone (higher SL → cheaper, longer-dated → cheaper per day,
higher vol regime → more expensive).

### Deliverable 2 — Backtest of the 16 historical triggers under biweekly model

Replay each of the 16 triggered protections from
`/pilot/admin/diagnostics/triggered-protections` against a counterfactual
biweekly hedge:

For each historical trigger:
1. At the original activation time, compute what biweekly option we
   would have bought (strike near trigger, 14-day expiry, ITM-aware).
2. Pull historical Deribit price for that hypothetical option from
   activation through trigger fire through the actual end-of-day-14.
3. Compute hypothetical sell at the trigger fire moment (no cooling
   delay; biweekly hedges have liquid bids so sell-at-trigger is
   feasible).
4. Compare hypothetical recovery to actual recovery.

**Output:** per-trigger comparison table + summary statistics:
- Distribution of hypothetical recovery ratio across 16 triggers
- Distribution of P&L per trigger (premium − hedge − payout + recovery)
- Worst-case trigger under each model
- Capital tied up per concurrent trade

**Where the script lives:** `scripts/phase0/biweekly_backtest_trigger_replay.{ts|py}`

**Definition of done:** the script outputs both the per-trigger table
and a summary; results are committed to `docs/cfo-report/` as a markdown
report with conclusions.

### Deliverable 3 — Per-day pricing model proposal

A short document proposing the actual per-day rate table (the analog of
today's `pricingRegime.ts` REGIME_SCHEDULES). Includes:

- Rate table (4 SL tiers × 4 vol regimes)
- Locked-at-activation vs dynamically-adjusted (recommendation + why)
- Early-close handling (recommend: no refund; subscription mechanics)
- Regime-spike handling on long protections (e.g., user opens at low,
  vol spikes to high mid-protection — we eat the under-pricing)
- Comparison: trader cost-per-day at each tier under biweekly vs current

**Where the doc lives:** `docs/cfo-report/biweekly_perday_pricing_model.md`

**Definition of done:** doc is reviewed by the user and either approved
or revised before any production work proceeds.

### Deliverable 4 — Capital requirements model

Spreadsheet/notebook estimating Deribit account equity needed for N
concurrent biweekly hedges at pilot scale.

Key inputs:
- Avg biweekly hedge cost per trade (from Deliverable 1)
- Concurrent active protections at pilot peak (from current `/pilot/protections/export?scope=active`)
- Margin model on Deribit (we use `cross_sm` per current account config)
- Current Deribit account equity ($319 as of 2026-04-29)

**Output:** "Deribit equity required for X concurrent biweekly trades = $Y,
with headroom assumptions Z."

**Where the doc lives:** `docs/cfo-report/biweekly_capital_requirements.md`

**Definition of done:** clear numeric answer to "is the current $319 of
Deribit equity sufficient for Phase 1 / 2 of biweekly rollout, or do we
need to fund up first?"

### Deliverable 5 — Go/no-go decision document

Short summary that pulls Deliverables 1-4 together into a single yes/no
recommendation on Phase 1.

**Where the doc lives:** `docs/cfo-report/phase0_biweekly_decision.md`

**Definition of done:** the user reads it and either says "go to Phase 1"
or "stop / revise."

---

## 3. Gates between phases

| Gate | Criteria to pass |
|---|---|
| Phase 0 → Phase 1 | Backtest shows positive expected per-trade return at the proposed pricing AND a recovery rate >60% across the 16-trigger replay AND capital requirements within Deribit account scale (or a clear funding plan) |
| Phase 1 → Phase 2 | Shadow mode shows the biweekly model would have outperformed 1-day on >70% of trades, with no individual trade catastrophically worse |
| Phase 2 → Phase 3 | Beta period shows materially better recovery rate AND CEO prefers the new product AND no operational issues (hedge unwind, capital strain, accounting) |

We do not skip a gate.

---

## 4. What Phase 0 does NOT do

- Does not modify any production code or routes.
- Does not change pricing for any existing or new live trade.
- Does not buy biweekly hedges. Pure paper analysis.
- Does not commit to Phase 1; that decision happens after Deliverable 5.
- Does not change the existing 1-day product, the Foxify Pilot Agreement,
  or any current trader-facing UX.

---

## 5. What we need to be honest about

The economic claims in the strategic review (e.g., "trader pays half what
they pay today", "recovery climbs to 60-90%") are **estimates from BS
pricing intuition, not measurements**. Real numbers may differ by ±50%.
Phase 0 exists specifically to replace estimates with measurements
**before** any commit. If the measurements come back disappointing — for
example, if biweekly Deribit bid-ask is worse than expected, or if the
backtest recovery is only marginally better than 1-day — we revise or
abandon the plan.

The acceptable outcomes of Phase 0 are:
1. Numbers confirm the thesis → proceed to Phase 1
2. Numbers partially confirm → revise the plan (different tenor, different
   pricing structure, different hedge instrument)
3. Numbers disconfirm → abandon biweekly path, document why, and pursue
   a different structural fix (e.g., Option D / perp delta hedge, or
   accept the current ceiling and adjust pricing accordingly)

All three outcomes are acceptable; the goal is to know before we ship,
not to confirm a preferred answer.

---

## 6. Sequencing alongside the in-flight pilot

Phase 0 runs entirely in analysis-land. Meanwhile the live pilot continues
on the existing 1-day product. Three small low-risk fixes ship in parallel
to the existing architecture (separate PRs):

- Gap 5a-fix-1: rule that should have caught `3df5cfa1` but missed on a
  logic technicality
- No-bid backstop: stop wasting cycles on Deribit no-bid sells after a
  threshold count of retries
- Expiry autopsy block: capture final option state at hedge expiry so the
  next failure is self-diagnostic

These three are scoped in their own PRs and do not depend on Phase 0
results. They protect the existing pilot for the remaining ~22 days
while Phase 0 figures out whether biweekly is the long-term answer.

---

## 7. How to start Phase 0

1. Open a new branch off the active branch: `cursor/phase0-deliverable-1-pricing-cf38`.
2. Implement Deliverable 1 first (pricing dataset). The other deliverables
   depend on having real per-day cost numbers.
3. Each deliverable is its own PR, reviewed before the next starts.
4. After Deliverable 5 lands, the user makes the Phase 0 → Phase 1
   decision.

Phase 0 is bounded analysis work, not open-ended R&D. If it sprawls past
the time-budget the user sets, we stop and reassess.
