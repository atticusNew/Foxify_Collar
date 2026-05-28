# Phase 1 Decision Report — V3 MC + Redesign + Shadow Bot

**Generated:** 2026-05-28
**Author:** Atticus (autonomous build)
**Status:** Production-ready (HALTED in calm, autonomous in moderate+)

---

## TL;DR

Three workstreams ran in parallel to answer the question "what cells actually
work and what proves it":

1. **V3 MC** (multi-tenor live-spread cost model) → proves which cells are
   profitable at which regimes with venue-realistic costs.
2. **Cell redesign sweep** (23 variants × calm + moderate) → proves
   calm-regime is structurally unfixable by parameter tuning.
3. **Shadow bot** (driver + runbook + tests) → 14-day empirical validator.

**Outcome:** System is configured to operate profitably in moderate+ regimes
on V3-proven cells, and to HALT in calm by default. Operator can override.

---

## V3 cell sweep (the new ground truth)

V1 used `BS × 1.07` fudge factor → wildly overstated. V2 used a single 3d-tenor
smile → pessimistic for short-tenor cells. V3 uses per-tenor smile + per-strike
ask + observed bid-ask + depth-aware slip → reality.

`docs/PHASE_1_CELL_SWEEP_V3_2026-05-28.md` contains the full table. Summary:

| Cell                              | Calm    | Moderate | Elevated | Stress  | Verdict          |
|-----------------------------------|--------:|---------:|---------:|--------:|------------------|
| pair_50k_2pct (old Phase 0)       | -$1,834 | -$1,794  | -$1,942  | -$2,337 | ❌ BROKEN        |
| pair_100k_3pct_itm_short          | -$2,335 | -$2,174  | -$2,278  | -$2,696 | ❌ BROKEN        |
| pair_50k_3pct_atm                 | -$597   | -$212    | +$3      | +$94    | elevated+ only  |
| pair_50k_5pct_otm                 | -$561   | -$5      | +$384    | +$692   | elevated+ only  |
| pair_25k_5pct_otm_short           | -$86    | +$41     | +$205    | +$362   | ✅ moderate+    |
| pair_50k_4pct_otm_short           | -$346   | +$39     | +$354    | +$614   | ✅ moderate+    |
| pair_25k_1pct_atm_micro           | -$145   | -$153    | -$180    | -$225   | ❌ BROKEN       |

The +$543/pair calm Foxify EV from PR 0a/0b was wrong by **>$2,300/pair**.
V3 is now the official cost model; V1/V2 are kept for audit only.

---

## Cell redesign sweep (the no-fix proof)

`docs/PHASE_1_CELL_REDESIGN_2026-05-28.md` ran 23 variants around the
best-V3 cell, systematically varying 7 levers:

  putOff · callOff · tenor · split · floor · trigger · notional · combo

**Calm result:** every variant negative. Best variant L1_both_-0.04 (deeper
OTM both legs) reaches -$43/pair. No combination of parameters achieves
breakeven.

**Moderate result:** `L2_tenor_3d` won by 6× over baseline (+$252 vs +$41).
Same strike geometry as pair_25k_5pct_otm_short but 3d tenor instead of 1d.
**Now shipped as `pair_25k_5pct_otm_3d` in `cellConfig.ts`.**

**Mechanism:** in calm, realized vol < implied vol (definition of calm). Hedge
cost (premium + spread + Atticus floor) exceeds expected salvage on most paths.
No amount of strike/tenor/split tuning offsets the implied-vs-realized vol gap.
The only fix is to NOT activate in calm.

---

## Production allowlist (the now-deployed config)

`services/api/src/singleSide/twoSided/cellAllowlist.ts`:

```
calm:     []                                                       ← HALT
moderate: [pair_25k_5pct_otm_3d, pair_25k_5pct_otm_short,
           pair_50k_4pct_otm_short]
elevated: [pair_50k_5pct_otm, pair_50k_4pct_otm_short,
           pair_25k_5pct_otm_3d, pair_25k_5pct_otm_short]
stress:   [pair_50k_5pct_otm, pair_50k_4pct_otm_short,
           pair_25k_5pct_otm_short]
```

Removed from all defaults (V3-proven loss-making):
- pair_50k_2pct (old Phase 0 baseline)
- pair_100k_3pct_itm_short
- pair_25k_1pct_atm_micro

These cells remain in the registry — operator can override-enable per regime
via `/admin/foxify/v2/cell-allowlist` for special testing or to push volume
when partners require it.

**Atticus capital budget impact at $3,500:**

| Regime    | Best cell                  | Hedge cost | Max concurrent | Daily EV (25 pairs)  |
|-----------|----------------------------|-----------:|---------------:|---------------------:|
| calm      | _(no cell)_                | —          | 0              | $0                   |
| moderate  | pair_25k_5pct_otm_3d       | $458       | 7 concurrent   | +$6,300 Fox / +$1,500 Att |
| elevated  | pair_50k_5pct_otm          | $1,653     | 2 concurrent   | +$9,600 Fox / +$2,800 Att |
| stress    | pair_50k_5pct_otm          | $1,959     | 1 concurrent   | +$17,300 Fox / +$3,600 Att |

(Moderate-regime hedge cost rough — $458 = avg of 25k cells × markup. Pair
size and concurrent count are budget-bounded, not throughput-bounded.)

---

## Shadow bot (the empirical validator)

`services/api/scripts/integration/foxifyShadowBot.ts` simulates Foxify's bot
hitting `/foxify/v2/activate` in shadow mode. Runbook in
`docs/SHADOW_BOT_RUNBOOK.md`.

Bot polls regime, picks best preferred cell, activates shadow pair, repeats
on configurable cadence (default 25/day). Logs structured JSON.

**Deploy:** add as a Render background worker (yaml in runbook), set
`FOXIFY_API_URL` + `FOXIFY_API_KEY`, let it run 14 days.

**Validate:** after 14d, run shadow reconciliation:
```
SELECT cell_id, COUNT(*), AVG(foxify_pnl_usdc)
FROM two_sided_pair
WHERE is_shadow = TRUE AND closed_at > NOW() - INTERVAL '14 days'
GROUP BY cell_id;
```

If realized shadow EV within ±15% of V3 MC EV → live cutover safe (flip
`SS_TWO_SIDED_LIVE_ENABLED=1`).

If drift > 15% → re-run multi-tenor probe with fresh data, recalibrate
`REGIME_COST_MARKUP`, re-test.

---

## Files added/changed this session

```
NEW:
  services/api/scripts/backtest/singleSide/probeDeribitSmileMultiTenor.ts
  services/api/scripts/backtest/singleSide/liveCellPricingV3.ts
  services/api/scripts/backtest/singleSide/runCellSweepV3.ts
  services/api/scripts/backtest/singleSide/runCellRedesignSweep.ts
  services/api/scripts/integration/foxifyShadowBot.ts
  services/api/tests/twoSidedShadowBot.test.ts
  docs/PHASE_1_CELL_SWEEP_V3_2026-05-28.md
  docs/PHASE_1_CELL_REDESIGN_2026-05-28.md
  docs/PHASE_1_DECISION_REPORT_2026-05-28.md (this file)
  docs/SHADOW_BOT_RUNBOOK.md

CHANGED:
  services/api/src/singleSide/twoSided/cellConfig.ts
    + pair_25k_5pct_otm_3d (new moderate winner)
  services/api/src/singleSide/twoSided/cellAllowlist.ts
    - V3-aware default allowlist (empty calm + broken cells removed)
  services/api/tests/twoSidedCellAllowlist.test.ts
    - 10/10 tests rewritten against new defaults
  services/api/tests/twoSidedCellAllowlistAdmin.test.ts
    - moderate-regime query path
  services/api/tests/twoSidedRoutes.test.ts
    - moderate DVOL + moderate-allowed cell
  services/api/tests/twoSidedShipReadiness.test.ts
    - moderate ledger test, registry sanity
```

---

## Operator next steps

1. **Rotate the admin token** that was pasted earlier (immediately).
2. Decide whether to deploy shadow bot:
   - **YES**: add the Render worker, accept 14d of nothing-but-data
   - **NO**: skip shadow, go straight to live cutover on smallest cell —
     ONLY if you trust V3 MC enough
3. Confirm V3 cost model on live `pair_25k_5pct_otm_3d` via probe:
   ```
   npx tsx services/api/scripts/backtest/singleSide/probeTwoSidedAnchors.ts \
     --tenor 3 --offset -0.020,-0.025
   ```
4. When ready to flip live: set `SS_TWO_SIDED_LIVE_ENABLED=1` with
   `SS_TWO_SIDED_CELL_ALLOWLIST=pair_25k_5pct_otm_3d` (start single-cell).
5. Watch metrics endpoint + ops runbook procedures.

---

## What this report does NOT change

- Wave A/B/C engineering work is shipped and unaffected
- The MC engine still computes correctly; only the cost model layer changed
- All existing tests (chaos, e2e, dashboards, webhooks, etc.) still pass
- Atticus $3,500 budget remains the binding scaling constraint until Foxify
  prefunds downstream (or LP arrives)
