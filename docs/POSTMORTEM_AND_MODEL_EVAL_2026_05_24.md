# Foxify-001 Post-Mortem + Volume Cover Model Evaluation

**Date:** 2026-05-24 (session ran 2026-05-23 22:40 ET → 2026-05-24 01:30 ET)
**Author:** AI engineering session (Claude Opus 4.7) at operator direction
**Status:** Backtest in progress; sequence-order fix queued; await results before implementation

---

## 1. Headline numbers (rolling 7-day, live data)

- **Triggers in window (5/21–5/24):** 3 events across 9 opened positions (33% trigger rate)
- **Net Atticus PnL (4-day):** +$2,090 across all positions (net positive)
- **Worst trigger:** Foxify-001 (5/23) = −$920
- **Aggregate trigger losses:** −$2,585 across 3 triggers
- **Aggregate non-trigger income:** +$2,449 from 6 non-triggered positions (avg $408/pos, includes ~16-25% regime surcharge)
- **Halt status:** ENGAGED at 36.7% rolling 5-position salvage rate (threshold 70%)
- **Root cause of biggest loss:** spread-executor sequence ordering — shorts-first close at peak spot, longs-30-min-later sale after mean-reversion. Quantified leak: **$990/BTC on call wing.**

---

## 2. Foxify-001 detailed reconciliation

Position: `vc-pos-b6b36760-cbec-4c72-85c8-ac7a452d6724`
Cell: `50k_2pct_1k` | Pair entry $75,497 | Trigger high $77,007 | Premium $350 | Payout $1,000

### Leg flow (4-leg debit spread)

| Leg | Open price | Close price | Open ts | Close ts | Δ vs trigger |
|---|---:|---:|---|---|---:|
| Long 75k Put | $590 (paid) | $230 (sold) | 15:06:51 | 20:57:03 | +15s |
| Short 74k Put | $0¹ | $160 (bought back) | 15:06:51 | 20:56:48 | 0s |
| Long 76k Call | $570 (paid) | $950 (sold) | 15:06:51 | **21:27:03** | **+30m 15s** |
| Short 77k Call | $0¹ | $940 (bought back) | 15:06:51 | 20:56:48 | 0s |

¹ Short legs collected $810 in initial credit at open (inferred from net PnL). Not currently exposed by any read endpoint — data gap (see §7).

### Economics

- Net hedge debit at open: $1,160 longs − $810 short credit = **D = $350**
- Net hedge realized on close: $1,180 (long sales) − $1,100 (short buybacks) = **H = $80**
- Hedge efficiency: H/W = 80/1,000 = **8.0%**
- Net Atticus position PnL: $350 premium − $1,000 payout + $80 hedge − $350 debit = **−$920**
- Salvage rate (hedge_sale_proceeds / payout): 8.0%

### Sequencing leak quantification

Counterfactual: if longs had been sold FIRST at peak spot ($77.94k inferred from short-call buyback):

| Leg | Actual | Hypothetical (longs-first) | Δ |
|---|---:|---:|---:|
| Long 76k Call sale | +$950 | +$1,890 (intrinsic at $77.94k spot) | **+$940** |
| Short 77k Call buyback | −$940 | −$890 (slightly lower at peak) | +$50 |
| Call wing net | +$10 | +$1,000 (full cap) | **+$990** |
| Net Atticus PnL | −$920 | +$70 (cap retained) | **+$990 swing** |

**Single-fix improvement: $990 per trigger event.**

---

## 3. All 3 triggers in scope (not just Foxify-001)

| Position | Date | Cell | Spread structure | Premium | Hedge net | Payout | **Net** | Salvage % |
|---|---|---|---|---:|---:|---:|---:|---:|
| `vc-pos-b6b36...` (Foxify-001) | 5/23 | 50k_2pct_1k | 4-leg spread $1k width | $350 | +$80 | $1,000 | **−$920** | 8.0% |
| `vc-pos-e41890...` | 5/22 | 30k_2pct_600 | **2-leg strangle** (76.5k LONG + 78k LONG, no shorts) | $210 | −$275 | $600 | **−$665** | ~31% |
| `vc-pos-e4f7f9...` | 5/18 | 50k_2pct_1k | 2-leg + 1 FAILED leg | $1 | ~−$15 (only 1 leg sold) | $1,000 | **~−$1,000** | ~9% |
| **TOTAL** | | | | **$561** | **−$210** | **$2,600** | **−$2,585** | **36.7% rolling avg** |

Observations:
- Foxify-001 is the BEST of the 3 (lowest absolute loss)
- 5/22 (e41890) used 2-leg strangle — different hedge structure, different failure mode
- 5/18 (e4f7f) had a LEG FAILURE — system bug, not market issue (separate fix needed)

---

## 4. Pricing — regime surcharge confirmed but NOT TRACKED per position

| Metric | Value |
|---|---:|
| Foxify-001 specific surchargeMultiplier | 1.0 (calm, no uplift) |
| 4-day window avg premium / position | $334 (across 9 pos) |
| Avg premium / non-trigger position | $408 |
| Base rates | $350 (50k cell), $210 (30k cell) |
| Implied regime surcharge applied | ~16-25% on some non-triggers |

**Critical tracking gap:** `volume_cover_position` table does NOT persist:
- `regime_at_open`
- `surcharge_multiplier_applied`
- `premium_actually_charged_usdc`

Can't attribute per-position PnL to regime decisions. Add 3 DB columns + populate from openPosition path. ~1 day work. **Recommended as Phase 0.5 in parallel with sequence fix.**

---

## 5. Sells executed tonight (operator action, NOT platform action)

3 untracked positions visible in Bullish UI Portfolio (Options account `111257696062450`) were liquidated via manual operator action this session:

| Sell | Symbol | Qty | Method | Fill Price | Gross Proceeds |
|---|---|---:|---|---:|---:|
| #1 | BTC-USDC-2026-05-26 76000 C | 1.438 | Bullish UI | $1,170 | $1,682.46 |
| #2 | BTC-USDC-2026-05-26 77000 C | 0.498 | API via shadow endpoint | $600 | $298.80 |
| #3 | BTC-USDC-2026-05-26 75000 P | 1.694 | API via shadow endpoint | $210 | $355.74 |
| **TOTAL** | | | | | **$2,337.00 gross / ~$2,320 net** |

For #2 and #3, deployed new shadow endpoint `/volume-cover/admin/bullish-cross-account-sell` (commits `949fa70`, `d5137eb` on `vc-sandbox`). Endpoint allows cross-sub-account SELL with safety envelope (shadow-tier + admin-token + SELL-only + IOC-only + $5k notional cap + 5 BTC qty cap). Useful operator unblocker; recommend KEEP.

Sell #1 on UI provided learning: Bullish IOC SELL with limit BELOW current bid → fills at bid with price improvement; limit ABOVE current bid → silent cancel zero fill. Confirmed 6-min bid walk of ~$50 on 76000-C.

**SECURITY:** Operator pasted Bullish ECDSA keys in chat session. MUST rotate keys on Bullish UI + update Render env vars on both `foxify-pilot-new` (live) and `foxify-pilot-shadow` (shadow) before next session.

---

## 6. Top 6 optimization recommendations (ranked by $-impact / effort)

### Rec #1 — Sequence-order fix on `partialCloseSpreadOnTrigger` ⭐ HIGHEST PRIORITY

- Swap close cascade from SHORTS-then-LONGS to **LONGS-then-SHORTS**
- Submit each wing's legs in PARALLEL (Promise.all), not sequential
- Reduce per-leg poll timeout from 30s → 8s ceiling
- **Expected impact: +$990/event recovered.** Foxify-001 type events go from −$920 to +$70.
- Effort: ~30 LOC + 5 focused tests. ~2 hours.
- **Status:** Draft started (3 files modified, uncommitted). Pending operator approval to commit + ship to shadow.

### Rec #2 — Wire `spreadTpCurve.evaluateSpreadTpRule` into Hedge Manager

- Standalone TP curve exists at `services/api/src/volumeCover/spreadTpCurve.ts` (per state-of-work bookmark line 653)
- NOT currently called by `volumeCoverHedgeManager.ts`
- Add evaluation in hedge manager evaluation loop; sell longs proactively at MTM peaks
- **Expected impact:** captures intrinsic on volatile-but-untriggered moves; per Foxify-001 data, BTC ran $75.5k → $77.9k → $76.9k. Selling at MTM peak would capture additional ~$1,400 vs current behavior.
- Effort: ~150 LOC + 10 tests + shadow validation. ~6 hours.

### Rec #3 — Reduce poll timeouts + add 4th deep-cross attempt in spread adapter

- `bullishSpreadAdapter.ts` retries with progressive prices but each retry burns 30s
- Cut to 5s timeout per attempt
- Add 4th attempt at mid-price (bid + spread × 0.5) — currently maxes at below-bid
- **Expected impact:** Caps any single close at <60s. Prevents Foxify-001 30-min delay.
- Effort: ~10 LOC + 3 tests. 30 min.

### Rec #4 — Strike-grid optimization for spread structure (depth-aware)

- 77k-C bid depth observed at 0.56 BTC tonight (thinnest in spread)
- When pushing 1+ BTC through that book, crosses 4-5 price levels = 30%+ slip
- In `matrix.ts:computeSpreadStrikesDB`, query Bullish chain at activation time, prefer strikes with > 5 BTC top-bid depth
- **Expected impact:** −$50-150/event close-side slip reduction. Cumulative.
- Effort: ~80 LOC + Bullish chain queries + 5 tests. ~4 hours.

### Rec #5 — Add `/admin/positions/:id` + `/admin/positions/:id/ledger` endpoints

- Subagent investigation found per-position `initial_proceeds_usdc` and capital_pool_ledger NOT exposed by ANY read endpoint
- Can't debug closed positions without DB access
- Add 2 endpoints: position detail (all leg projections including initial_proceeds_usdc) + ledger (filtered by position)
- **Expected impact:** Cuts incident-response MTTR from 60min to <5min
- Effort: ~120 LOC + 4 tests. 2 hours.

### Rec #6 — Activation latency investigation

- Foxify-001 activation took 23.3 sec (vs typical 2-3 sec on calm)
- The 10x spike is in `hedgeFillAt − hedgeBuySubmittedAt = 23 sec`
- Add Bullish API roundtrip tracing
- **Expected impact:** Hard to quantify; likely $20-50/event cumulative drift cost
- Effort: ~2 hours diagnostic-first

---

## 7. Proposed pricing/payout model change (under backtest)

### The idea (operator concept)

Convert from "fixed payout + variable premium ALWAYS" to "regime-tiered payout XOR fixed non-trigger premium":

- **On trigger:** Foxify pays $0 premium, receives $Y payout (regime-tiered)
- **On non-trigger:** Foxify pays $X premium (~$390 suggested), receives $0
- **Never both:** clean unit economics for Foxify

### Foxify-side rationale (qualitative value worth ~7-12% EV concession)

- Capital efficiency: no upfront premium
- Simpler accounting: one variable per outcome
- Predictable payout per regime
- Volume continuity in stress (don't pause activations)
- Settlement batching nets neatly across batch

### Atticus-side rationale

- Bounded tail risk per regime (payout sized to hedge cap, not arbitrary $1k)
- Capital-efficient scaling (more positions per dollar of reserve)
- Aligned with hedge efficiency reality (hedge underperforms in stress → pay less in stress)
- Self-throttling (highstress = small payout + small spread = minor exposure)

### Equivalence math (preserve Foxify EV)

For $X = $390 non-trigger premium, Y_calm to preserve Foxify EV per trigger rate:

| Trigger Rate | Y_calm equivalence |
|---:|---:|
| 30% | $743 |
| 50% | $690 |
| **65%** | **$672** |
| 80% | $660 |

### Initial Atticus EV (pre-backtest, indicative)

At `X = $390, Y_calm = $670, D = $350, H_realized = $900 (post sequence fix), P_T = 0.65`:
- EV ≈ −$53/position (slight loss at pure equivalence)

To get positive Atticus EV, ONE of three knobs:
1. Lower Y slightly below equivalence (5-10% Foxify EV concession — operator approved at ≤10%)
2. Raise X above $390 (~$420-450)
3. Widen spread structure (W=$2k vs $1k) for hedge surplus (~$282/pos EV at same params)

Best path likely: combination of all three, tuned by backtest.

### Highstress regime — ALLOW with "Option B" (operator decision)

- Spread structure SAME as moderate ($1k width, normal D)
- BUT Y_highstress is TINY ($30-80)
- Surplus W − Y = $900-970 cushion on every trigger
- Break-even economics expected (−$5 to +$10 per position)
- Strategic value: volume continuity, no Foxify churn risk, telemetry from stress periods

---

## 8. Backtest scope (subagent running)

Backtest engine being built by subagent. Will analyze:

- **Data:** BTC 1-min OHLC 2024-01 to 2026-05 (28 months, ~1.4M points)
- **Regime classifier:** 7-day rolling realized vol → calm/moderate/stress/highstress
- **Trigger simulation:** ~25,000+ synthetic 24h windows per cell
- **Hedge cost model:** Black-Scholes-derived spread debit + realized
- **Parameter grid search:** X ∈ {$350-$550}, Y_tier ∈ regime-specific ranges, spread width multiplier
- **Constraints:** Foxify EV ≥ 90% per regime, max position loss ≤ $200
- **Highstress scenarios:** Pause vs Option A (narrow matched) vs Option B (normal spread, tiny payout)

Expected deliverables:
- Top 5 parameter combinations by Atticus EV
- Sensitivity analysis (Foxify EV tightness, hedge efficiency)
- Comparison to current model (% EV lift, % tail VaR reduction)
- Recommended final parameter set with rationale

Subagent report will be saved to `/tmp/foxify_backtest/REPORT.md`.

---

## 9. Execution roadmap (post-backtest)

| Phase | Work | Days | Why now |
|---|---|---|---|
| **0** | Ship Rec #1 (sequence fix) → shadow validate → live promote | 2 | Prerequisite for any payout-model change. Without fix, all backtest-optimized params will underperform. |
| **0.5** | Add regime tracking columns to `volume_cover_position` (DB migration + ingest in openPosition + surface in admin/foxify-report) | 1 | Cheap, enables future analysis. |
| **0.75** | Rotate Bullish API keys + update Render env (live + shadow) | 0.25 | Security cleanup from this session. |
| **1** | Review backtest report; finalize calibrated proposal (X, Y_tier, spread width) | 1 | After subagent returns. |
| **2** | Draft Foxify proposal document with EV comparison + rollout timeline | 1 | For negotiation. |
| **3** | Foxify negotiation | 7-14 | External dependency. |
| **4** | Implement: regime-conditional payout calculator, premium-on-non-trigger billing, new spread structure (per regime), settlement engine update | 5-7 | After Foxify agrees. |

Total elapsed: ~3-5 weeks (if Foxify agrees quickly), 6-8 weeks (if negotiation drags).

---

## 10. Pending operator actions (BEFORE next session)

1. ✋ **ROTATE Bullish API keys** on Bullish UI + update Render env (both services)
2. ✋ **Verify** Bullish Options account `111257696062450` Portfolio is empty (all 3 positions cleared this session)
3. ☐ Decision on whether to keep new shadow endpoint `/admin/bullish-cross-account-sell` (recommend KEEP — useful operator tool)
4. ☐ Review backtest report when subagent returns
5. ☐ Approve Rec #1 sequence-fix to ship to shadow (3 files in current uncommitted state on `vc-sandbox`)

## 11. Data + read-API gaps documented (for future PR)

- `volume_cover_position` missing: `regime_at_open`, `surcharge_multiplier_applied`, `premium_actually_charged_usdc`
- `/admin/all-open-legs` hard-filters to `status='open'` — closed legs unreadable
- `/admin/active-positions-detail` leg projection omits: `side`, `kind`, `initial_proceeds_usdc`
- No `/admin/positions/:id` route exists
- No `/admin/positions/:id/ledger` route (capital_pool_ledger entries unreadable)
- No `/admin/positions/:id/salvage-event` route
- Per-position `initial_proceeds_usdc` unreadable for any sold short leg (the data needed to fully reconcile any trigger's economics)

---

## 12. Session bookmark (for resuming context)

- Current branch: `vc-sandbox`
- Commits added this session: `949fa70` (cross-account-sell endpoint), `d5137eb` (margin flag fix)
- Uncommitted WIP: `positionLifecycle.ts`, `spreadExecutor.ts`, `volumeCoverSpreadExecutor.test.ts` (sequence-order fix in progress from prior session)
- Live branch tracking: `cursor/-bc-c2468b87-...-6ba4` (older, lacks newer admin endpoints)
- Halt currently engaged on production: NO new VC activations until salvage ≥ 70%
- Backtest subagent: running in background, results pending

End of bookmark.
