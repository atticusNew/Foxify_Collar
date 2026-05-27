# Single-Side Volume Facility — Phase 0 PR Plan

**Status:** Draft, ready for execution. **Updated 2026-05-26 with empirical chain validation findings.**
**Branch parent:** `cursor/-bc-c2468b87-...-6ba4` (currently live VC tracking branch)
**Live platform impact:** zero — Phase 0 builds a fresh single-side path next to the live VC. VC stays untouched until shadow-validated and operator-approved cutover.

## Changelog vs. initial plan (2026-05-25 → 2026-05-26)

Backed by `docs/SINGLE_SIDE_EMPIRICAL_VALIDATION.md` and `docs/SINGLE_SIDE_7PCT_TENOR_BACKTEST.md`:

1. **All 5 cells ship in Phase 0** (not 3) — empirical 10d-tenor backtest of 7% cells shows them at +$1,675 / +$6,064 per cover, **2.6–2.7× more profitable than the original 6d projection.**
2. **No premium uplift on 5% cells** — empirical Bullish ask came in 14% cheaper than BS-modeled cost, so cells are profitable at original matrix prices without uplift.
3. **Multi-venue parallel quote is mandatory** — Bullish primary for 2%/5% (3-day cells), Deribit primary for 7% (10-day cells where Bullish 10d depth is too thin at 2.4 BTC).
4. **Per-cell concurrent caps added** based on observed depth-within-2%-above-ask. Binding constraint: `ss_200k_5pct_10k` at 3 / direction.
5. **Per-cell loss-kill thresholds** for 7% cells (tighter, since per-cover worst is materially larger).
6. **Depth-aware activation gate** added (PR 9) — skip / fallback if observed strike depth < contracts × 1.2.
7. **PR 4.5 still in scope** — intraday harness flagged a cap-fraction tuning issue on 3d cells; needs reconciling before live cutover.

---

## What Phase 0 ships

A production single-side facility at `services/api/src/singleSide/` wired into `server.ts`, with a purpose-built short-tenor TP engine, Bullish-primary execution with Deribit fallback, capital pool + counterparty ledger, Foxify dashboard, and the cell matrix from the comparative backtest. **No Foxify renegotiation required.**

**Out of scope for Phase 0:** X-or-Y pricing, regime-conditional payout, hedge pool re-use, diagonal calendar overlay, butterfly catastrophe overlay. All deferred to Phase 1+.

## Cell matrix decision (post-empirical-validation, 2026-05-26)

Empirical validation against live Bullish + Deribit chains
(`docs/SINGLE_SIDE_EMPIRICAL_VALIDATION.md`) confirmed:
- **All 5 cells' strikes available** on both Bullish and Deribit ($1k grid)
- **Empirical hedge costs match BS within 14%** on 3-day cells
- **6d tenor is not currently listed** — closest available beyond 3.3d is 10.3d
- **10d-tenor 7% cells are 2.6-2.7× MORE profitable** than 6d-projection
  (`docs/SINGLE_SIDE_7PCT_TENOR_BACKTEST.md`) because longer remaining tenor
  on retained options yields larger time-value salvage

**Phase 0 matrix — all 5 cells ship, with cell-specific tenor + venue routing:**

| Cell | Phase 0 base $/day | Tenor (live) | Empirical hedge cost / cover | Variant B EV / cover | Verdict |
|---|---:|---:|---:|---:|---|
| `ss_50k_2pct_1k` | **$310** | 3d (Bullish/Deribit) | $1,001 (Bullish primary) | +$220 | ✅ ship workhorse |
| `ss_50k_5pct_2_5k` | **$140** (no uplift) | 3d | $357 (Bullish primary) | +$50 (no uplift needed; empirical 14% < BS) | ✅ ship at base |
| `ss_200k_5pct_10k` | **$600** (no uplift) | 3d | $1,386 (Bullish primary) | +$200 | ✅ ship with concurrent cap |
| `ss_50k_7pct_3_5k` | **$310** (no uplift) | **10d** (Deribit primary, Bullish fallback) | $1,069 | **+$1,675** at 10d tenor | ✅ **ship — was a "drop" candidate, now a top performer** |
| `ss_200k_7pct_14k` | **$1,250** (no uplift) | **10d** (Deribit primary) | $4,278 | **+$6,064** at 10d tenor | ✅ ship with tighter loss-kill |

The 10d-tenor finding is the biggest update from empirical validation. The
7% cells were initially flagged for deferral because we assumed only the
3.3d expiry was usable; the explicit longer-tenor probe found that 10d (5
Jun) is fully available and **economically superior**. Annualized at 25/day:

| Cell | 6d projection | **10d empirical** | Δ annual |
|---|---:|---:|---:|
| `ss_50k_7pct_3_5k` | $5.75M | **$15.29M** | +$9.54M |
| `ss_200k_7pct_14k` | $23.65M | **$55.34M** | +$31.69M |

(Caveat: salvage uses BS at σ=35.2% which over-estimates retained-call MTM
due to vol smile. A 0.82× haircut applied to the salvage component still
leaves both 7% cells with strong positive EV per cover. Verify via shadow
soak before live promotion.)

**Per-cell concurrent caps (empirical depth-within-2%-above-ask):**

| Cell | Per-cover BTC | Bullish 3.3d depth | Deribit 3.3d depth | Bullish 10d depth | Deribit 10d depth | Phase 0 cap (single direction) |
|---|---:|---:|---:|---:|---:|---:|
| `ss_50k_2pct_1k` | 1.4 | 16.7–22.3 | 48–52 | n/a | n/a | **12 (Bullish primary)** |
| `ss_50k_5pct_2_5k` | 1.7 | 24.1–30.2 | 17–33 | n/a | n/a | **14** |
| `ss_200k_5pct_10k` | 6.6 | 24.1–30.2 | 3.5–32.8 | n/a | n/a | **3** |
| `ss_50k_7pct_3_5k` | 2.3 | n/a (cell uses 10d) | n/a | 2.4–2.5 (too thin) | 22.9–197 | **6 (Deribit primary)** |
| `ss_200k_7pct_14k` | 9.2 | n/a (cell uses 10d) | n/a | 2.4–2.5 (too thin) | 22.9–197 | **2–3 (Deribit primary)** |

**Critical routing change for 7% cells:** Bullish 10d depth (2.4 BTC) is
**too thin** for production sizing (need 2.3–9.2 BTC per cover). Deribit
becomes primary for 7% cells; Bullish fallback only useful for 50k/7%
single positions. The original `singleSide/singleSideHedge.ts:209-212` already
routes 7% cells Deribit-primary, so this matches the existing code.

**Aggregate at 25/day target — capacity check:**
- 50k/2% on Bullish: 12/dir × 1d hold ≈ 12/day capacity
- 50k/5% on Bullish: 14/dir ≈ 14/day capacity
- 200k/5% on Bullish: 3/dir ≈ 3/day capacity (premium product, low cadence)
- 50k/7% on Deribit: 6/dir ≈ 6/day capacity
- 200k/7% on Deribit: 2–3/dir ≈ 2–3/day capacity

Sum: ~37–38/day total capacity if Foxify's mix matches, comfortably above
25/day target. **Single-direction concurrent caps must be enforced per
cell in PR 8 / PR 9.**

## PR sequence (10 small PRs)

Each PR is independent, ships green tests, and runs through `tsc --noEmit` once. Target: 10–14 days total. Cutover gates:
- Local + shadow CI green on every PR
- 30-event shadow validation gate before live promotion (PR 11)
- Newborn-trigger review (manual halt for first 3 triggers post-deploy)

| # | PR title | Files touched | Tests | Risk | LOC est |
|---|---|---|---|---|---|
| **1** | feat(ss): schema + lifecycle skeleton | `singleSide/db.ts` (new), `singleSide/migrate.ts`, `singleSide/types.ts` | 6 | Low (additive migration) | ~250 |
| **2** | feat(ss): trigger detector (one-sided 3s tick) | `singleSide/triggerDetector.ts` (new), `scheduler.ts` (wire) | 5 | Low (no execution yet) | ~180 |
| **3** | feat(ss): activate path with Bullish primary + Deribit fallback | `singleSide/positionLifecycle.ts` (new), `singleSide/venueRouter.ts` | 7 | Med (touches venues) | ~350 |
| **4** | feat(ss): theta-aware TP engine (purpose-built short-tenor) | `singleSide/thetaAwareTp.ts` (new), `singleSide/tpScheduler.ts` | 8 | Med (new engine) | ~400 |
| **4.5** | fix(ss/tp): tune cap-fraction for short-tenor cells | `singleSide/thetaAwareTp.ts` (tuning), `scripts/backtest/singleSide/runIntradayComparison.ts` (regression) | 4 | Low (tuning) | ~80 |
| **5** | feat(ss): trigger-fire execution (parallel sell + slippage floor + deep-cross) | `singleSide/triggerExecutor.ts` (new) | 6 | High (real Bullish writes) | ~300 |
| **6** | feat(ss): capital pool + counterparty credit ledger | `singleSide/capitalPool.ts`, `singleSide/counterpartyLedger.ts` (port from VC) | 6 | Low (additive ledgers) | ~280 |
| **7** | feat(ss): Foxify dashboard + admin telemetry | `singleSide/foxifyDashboard.ts`, `singleSide/foxifyReport.ts` | 5 | Low (read-only API) | ~250 |
| **8** | feat(ss): routes + cell matrix configuration + 5% cell pricing | `singleSide/singleSideRoutes.ts`, `singleSide/matrix.ts` (extend) | 5 | Low (config) | ~200 |
| **9** | feat(ss): guardrails (loss kill, salvage tracker, DVOL pause, newborn review) | `singleSide/guardrails.ts` (port from VC patterns) | 6 | Med (kill switches) | ~300 |
| **10** | feat(ss): shadow validation harness + cutover documentation | `scripts/probes/singleside_e2e_shadow.sh`, `docs/SINGLE_SIDE_RUNBOOK.md` | 0 (e2e via probe) | Low | ~150 |
| **(post-soak)** | feat(ss): live cutover behind feature flag | `singleSide/server.ts`, `scripts/cutover/...` | n/a | High (live) | ~50 |

Total LOC: ~2,790. Total new tests: 58. Each PR ≤ 400 LOC, well under the typical 6-large-PRs alternative.

---

## PR-by-PR scope detail

### PR 1 — Schema + lifecycle skeleton
- Tables: `single_side_position`, `single_side_hedge_leg`, `single_side_event`. Mirror VC structure but flat (single leg, single direction).
- State machine: `pending → active → triggered → unwinding → settled` and `pending → active → expired_no_trigger → unwinding → settled`. No paths from `triggered` directly to `settled` (always via `unwinding` so the TP engine can run).
- Migration: idempotent ALTER pattern matching VC.
- **No wiring** — types and tables only.
- **Tests:** schema migration up+down, state transitions valid/invalid.

### PR 2 — Trigger detector
- Reuse VC's 3s tick (`VOLUME_COVER_TRIGGER_DETECTOR_TICK_MS`) but apply to one boundary per position.
- Stale-spot skip if age > 30s.
- Flash-move telemetry only; no halt.
- **No execution** — emits `single_side_event(kind='trigger_detected')` and updates `status='triggered'`.
- Wire into `scheduler.ts` behind `SINGLE_SIDE_TRIGGER_DETECTOR_ENABLED` flag.
- **Tests:** boundary-cross long, boundary-cross short, no-cross, stale-spot skip, paused-position skip.

### PR 3 — Activate path
- `singleSide/positionLifecycle.openPosition`: quote → snap strike → size by intrinsic → vol-buffer → BS hedge cost via `tightHedge.HedgeExecutor` (already imported).
- Venue routing: Bullish primary for 2%/5%, fallback Deribit; configurable via `SS_VENUE_ROUTING_JSON`.
- Anti-bot Layer 2 jitter (0–300s) on activate response.
- Live chain pickClosestStrike via `venueStrikeGrid.pickClosestStrike` (already used by `singleSide/`).
- Premium accrual scheduled per-day-ceil to capital pool ledger (`premium_in`).
- **Tests:** activate path creates position + leg + ledger entry; venue fallback fires when Bullish 5xx; jitter window respected; pause regime returns 403.

### PR 4 — Theta-aware TP engine
- New module `singleSide/thetaAwareTp.ts`. Curve as designed:
  1. **Trigger fire**: limit-IOC at slippage floor (`BS × 0.85`), 8s poll ceiling, retry up to 3 times with deep-cross.
  2. **Capture window** (first 30 min after trigger): hold to running peak, sell at peak × 0.85 if peak threshold reached.
  3. **30 min – 4h**: trail retracement 15% from running max OR cap-fraction exit at 90% of intrinsic-at-current-spot.
  4. **4h – expiry−4h**: hard floor 10% of payout.
  5. **expiry−4h → expiry**: force limit-IOC at current bid.
- Loser-side path (non-trigger close-out): unchanged baseline 4h grace + day-1 exit.
- **Tests:** trigger-fire snap, capture-window peak, 15% trail, cap-fraction (after PR 4.5 tuning), hard floor, force-expiry, loser-side grace.

### PR 4.5 — Tune cap-fraction for short-tenor cells (intraday-backtest finding)
**This PR exists because the intraday harness flagged a tuning issue:** on the 50k/2% cell (3-day tenor), the cap-fraction rule fired in 90% of triggered exits and ate into the time value too aggressively, washing out the theta-aware lift on 2% cell. Two recommended fixes (pick one based on PR 4.5 backtest):
- (a) **Minimum hold time**: cap-fraction can't fire in the first 60 minutes after trigger.
- (b) **Tenor-conditional threshold**: 95% cap fraction for tenor ≤ 3d, 90% for tenor ≥ 6d.
- (c) **Drop cap-fraction**: rely entirely on capture-window + 15% trail.
- Re-run `runIntradayComparison.ts` to confirm 2% cell intraday EV ≥ +$100/cover and 7% cell intraday EV ≥ +$500/cover.
- **Tests:** the 3 alternatives have different unit tests; ship the winner.

### PR 5 — Trigger-fire execution + multi-venue routing
- **MANDATORY multi-venue parallel quote at activation time.** Quote both
  Bullish and Deribit; route to the venue with depth ≥ contracts × 1.5
  AND the better price. Bullish primary for 2%/5% cells (3-day tenor),
  Deribit primary for 7% cells (10-day tenor where Bullish depth is too
  thin). Empirical depth data justifies this in `SINGLE_SIDE_EMPIRICAL_VALIDATION.md`.
- Existing `singleSide/singleSideHedge.ts:209-212` already routes 7% cells
  Deribit-primary; PR 5 just exercises that path properly.
- New `singleSide/triggerExecutor.ts` calls Bullish IOC limit
  (`bullishIocLimit.executeBullishIocLimit`) OR Deribit IOC depending on
  venue routing for the cell.
- Reuses VC's `fillOptimizer` for improved-price IOC.
- Deep-cross retry up to 3 attempts (port from VC).
- 8s poll ceiling per leg (Foxify-001 lesson).
- Single-leg means no leg-ordering question — the bug class that hit
  Foxify-001 doesn't exist here.
- Phantom-leg cleanup endpoint admin route (port from VC).
- **Tenor-snap logic for 7% cells:** snap to the closest available expiry
  in the 5–14d window, not a fixed target. Live empirical run today shows
  10.3d as the only listable; tomorrow may differ.
- **Tests:** happy path Bullish, happy path Deribit, multi-venue quote
  comparison + routing decision, IOC expired retry, deep-cross fallback,
  poll-ceiling timeout, phantom-leg detection, 7% cell tenor-snap.

### PR 6 — Capital pool + counterparty ledger
- Port `volumeCover/capitalPoolLedger.ts` to `singleSide/capitalPool.ts`. Same entry types: `premium_in`, `hedge_buy_out`, `payout_out`, `hedge_sell_in`.
- Port `volumeCover/counterpartyLedger.ts` to `singleSide/counterpartyLedger.ts`. 25% EOW / 75% EOM schedule.
- Halt-new-activations gate at $114k unpaid Foxify→Atticus (1.5× steady state from backtest at 25/day).
- Settlement crons (Friday 16:00 UTC weekly, last business day 16:00 UTC monthly).
- **Tests:** ledger entries on activate / trigger / close, halt gate trips at threshold, settlement cron computes correctly.

### PR 7 — Foxify dashboard + admin telemetry
- Port VC's `/foxify/positions`, `/foxify/today`, `/foxify/status` field whitelist to single-side endpoints. Reuse the same per-day-ceil billing helpers.
- Admin: `/admin/single-side/positions`, `/admin/single-side/positions/:id`, `/admin/single-side/positions/:id/ledger`, `/admin/single-side/diagnostics`.
- Foxify whitelist excludes salvage, regime, hedge fills.
- **Tests:** Foxify whitelist enforces field exclusion; admin endpoints return full detail; auth via `X-Foxify-Token` and `X-Admin-Token`.

### PR 8 — Routes + cell matrix + per-cell caps
- `singleSide/singleSideRoutes.ts`: `POST /single-side/quote`,
  `POST /single-side/activate`, `POST /single-side/close`,
  `POST /single-side/admin/halt`.
- Cell matrix in `singleSide/matrix.ts` with the **5-cell Phase 0 schedule**
  (per the empirical-validated table above). 7% cells configured with
  `hedgeTenorDays = 10` and Deribit-primary venue.
- **Per-cell concurrent cap (single direction)** enforced at activate time:
  - `ss_50k_2pct_1k`: 12
  - `ss_50k_5pct_2_5k`: 14
  - `ss_200k_5pct_10k`: 3
  - `ss_50k_7pct_3_5k`: 6
  - `ss_200k_7pct_14k`: 3
- Per-cell daily activation cap (default 25, lower for low-depth cells).
- **Tests:** quote returns regime-adjusted premium, activate honors per-cell
  concurrent cap, halt blocks new activations, 7% cell uses 10d tenor.

### PR 9 — Guardrails
- Port VC Guard A (7d loss kill, **per-cell tuned**) — tighter on 7% cells where worst single-cover loss is materially larger:
  - 2%/5% cells: $5k loss kill (matches VC default)
  - **`ss_50k_7pct_3_5k`: $3.5k loss kill** (per-cover worst seen at $-3,569 in 10d backtest)
  - **`ss_200k_7pct_14k`: $14k loss kill** (per-cover worst seen at $-14,226)
- Per-cover hard alert: if any single cover lands worse than 70% of cell's loss-kill threshold, emit alert + manual review.
- Guard B (rolling 5-event salvage throttle), Guard C (>5 triggers/24h surge pause), Guard D (DVOL ≥ 80 stress pause) — same as VC.
- **Depth-aware activation gate:** before opening, query the venue's current depth-within-2%-above-best-ask for the working strike. If observed depth < contracts × 1.2, skip the activation (Foxify gets 503 with retry-after) AND attempt fallback venue. New env: `SS_DEPTH_GATE_ENABLED=true`, `SS_DEPTH_GATE_RATIO=1.2`.
- Newborn-trigger review: manual halt for first 3 triggers post-deploy (`SINGLE_SIDE_NEWBORN_REVIEW_BUDGET=3`).
- Hedge budget cap ramp: Day 1–2 $100, Day 3–7 $1k, Day 8+ $10k (port from `pilot/hedgeBudgetCap.ts`).
- **Tests:** each guard trips and clears correctly; per-cell loss-kill thresholds; depth gate pauses on thin book; budget cap blocks oversized hedges; newborn review counter persists across positions.

### PR 10 — Shadow validation harness
- `scripts/probes/singleside_e2e_shadow.sh`: open 0.01 BTC cover at each cell type, hold 60s, force-trigger or expire, validate ledger + cleanup. Reuses `bullish_e2e_microtest.sh` patterns.
- `docs/SINGLE_SIDE_RUNBOOK.md`: cutover steps, env-var matrix, halt protocol, rollback procedure.
- 30-event shadow soak gate before live cutover.

### PR 11 — Live cutover (post-soak only)
- Behind `SINGLE_SIDE_LIVE_ENABLED=true` flag.
- Default OFF; flip per-cell via `SS_LIVE_CELL_ALLOWLIST=ss_50k_2pct_1k`.
- Cutover doc + monitoring checklist.
- VC stays running; if single-side wobbles, flip flag OFF — no impact to VC.

---

## Env var matrix (Phase 0)

| Env var | Default | Purpose |
|---|---|---|
| `SINGLE_SIDE_TRIGGER_DETECTOR_ENABLED` | `false` | Master switch for SS trigger detector |
| `SS_TRIGGER_DETECTOR_TICK_MS` | `3000` | Trigger eval cadence |
| `SS_VENUE_ROUTING_JSON` | (cell-conditional) | Per-cell venue priority |
| `SS_PRICING_FLOOR_USD` | `50` | Minimum quoted daily premium |
| `SS_IV_REFERENCE` | `0.33` | IV elasticity reference |
| `SS_IV_ELASTICITY` | `0.7` | IV scaling exponent |
| `SS_REGIME_OVERLAY_JSON` | `{calm:1.0,mod:1.4,elev:2.0,stress:"pause"}` | Regime price multipliers |
| `SS_GUARD_LOSS_KILL_USDC` | `5000` | 7d rolling loss kill threshold |
| `SS_GUARD_DVOL_PAUSE_THRESHOLD` | `80` | Highstress pause trigger |
| `SS_NEWBORN_REVIEW_BUDGET` | `3` | First-N-triggers manual halt |
| `SS_HEDGE_BUDGET_CAP_DAY1_USDC` | `100` | Day 1–2 hedge cap |
| `SS_HEDGE_BUDGET_CAP_DAY7_USDC` | `1000` | Day 3–7 hedge cap |
| `SS_HEDGE_BUDGET_CAP_DAY30_USDC` | `10000` | Day 8+ hedge cap |
| `SS_COUNTERPARTY_HALT_THRESHOLD_USDC` | `114000` | Halt-new on Foxify→Atticus float |
| `SS_DEPTH_GATE_ENABLED` | `true` | Per-activation depth check on working strike |
| `SS_DEPTH_GATE_RATIO` | `1.2` | Required depth = contracts × this ratio |
| `SS_GUARD_LOSS_KILL_USDC_50K_7PCT` | `3500` | Per-cell loss kill for 50k/7% (tighter) |
| `SS_GUARD_LOSS_KILL_USDC_200K_7PCT` | `14000` | Per-cell loss kill for 200k/7% (tighter) |
| `SS_CONCURRENT_CAP_50K_2PCT` | `12` | Single-direction concurrent cap |
| `SS_CONCURRENT_CAP_50K_5PCT` | `14` | Single-direction concurrent cap |
| `SS_CONCURRENT_CAP_200K_5PCT` | `3` | Single-direction concurrent cap (depth-binding) |
| `SS_CONCURRENT_CAP_50K_7PCT` | `6` | Single-direction concurrent cap |
| `SS_CONCURRENT_CAP_200K_7PCT` | `3` | Single-direction concurrent cap |
| `SS_TENOR_OVERRIDE_50K_7PCT` | `10` | Override hedge tenor (was 6d in cell config) |
| `SS_TENOR_OVERRIDE_200K_7PCT` | `10` | Override hedge tenor (was 6d in cell config) |
| `SS_TP_SLIPPAGE_HAIRCUT` | `0.85` | Limit-IOC floor as fraction of BS |
| `SS_TP_CAPTURE_WINDOW_MIN` | `30` | Post-trigger capture window |
| `SS_TP_CAP_FRACTION_THRESHOLD` | `0.90` | Cap-fraction exit (subject to PR 4.5 tuning) |
| `SS_TP_CAP_FRACTION_MIN_HOLD_MIN` | `60` | (PR 4.5a) min hold before cap-fraction |
| `SS_TP_TRAIL_RETRACE` | `0.85` | Trail retracement (15% pullback) |
| `SS_TP_HARD_FLOOR_PAYOUT_PCT` | `0.10` | Hard floor as fraction of payout |
| `SS_TP_FORCE_EXIT_MIN_BEFORE_EXPIRY` | `240` | Force-exit at expiry−Nmin (4h) |
| `SS_LIVE_ENABLED` | `false` | Live-cutover master |
| `SS_LIVE_CELL_ALLOWLIST` | `""` | Comma-separated live cells |

---

## Risk register

| Risk | Mitigation | Severity |
|---|---|---|
| Bullish IOC margin behavior differs from VC measurement | Re-run E2 microtest pattern against single-side strike grid before PR 5 | Med |
| TP curve over/under-tunes on intraday | PR 4.5 reserves space for tuning; require backtest regression pass before ship | Med |
| Counterparty float at 25/day hits $114k halt prematurely | Pre-compute float at 5/day pilot vol; if low, raise threshold incrementally | Low |
| Bullish bid depth drops mid-fire-storm | Deribit fallback already in routing; cap concurrent positions per direction | High |
| Shadow probe doesn't reveal regression | 30-event soak gate (PR 10) before any live activation | Med |
| 5% cell uplift unacceptable to Foxify | Drop 5% cells; ship 3-cell matrix; revisit Phase 1 | Low |

---

## Backtest dependencies

The numbers above come from:
- `docs/SINGLE_SIDE_OPTIMAL_DESIGN_BACKTEST.md` (daily harness, all cells × variants)
- `docs/SINGLE_SIDE_OPTIMAL_DESIGN_BACKTEST.md` Appendix (intraday harness, 5-min lift on 2% / 7% workhorse cells)
- `docs/foxify-pilot-bundle-c/27_SINGLE_SIDE_RELAUNCH_REPORT.md` (the original baseline)
- `docs/POSTMORTEM_AND_MODEL_EVAL_2026_05_24.md` Foxify-001 sequence-fix lesson (informs PR 4 trigger-fire path)

If any backtest assumption changes (Bullish IV, Coinbase data window, regime classifier cuts), re-run `tsx services/api/scripts/backtest/singleSide/runComparativeReport.ts` and `tsx services/api/scripts/backtest/singleSide/runIntradayComparison.ts` to refresh.

---

## What's NOT in Phase 0 (deferred to Phase 1+)

- **X-or-Y pricing** — backtest shows it's value-destructive on single-side at full Y_calm; needs Foxify negotiation to reduce Y_calm before adopting.
- **Hedge pool re-use** across direction-aligned re-opens — additive to ladder netting, ship after netting validates.
- **Diagonal calendar overlay** — requires Bullish margin enabled, which is currently `false`.
- **Far-OTM butterfly catastrophe overlay** for highstress — nice-to-have for "always-on" UX, not required for sustainability.
- **Direction-asymmetric pricing** — adverse-selection defense; needs 30+ live triggers of data first.
- **Diagonal margin** — same as above; pending Bullish margin policy.
- **Regime-conditional payout** — VC postmortem proposal; revisit after Phase 0 data.
