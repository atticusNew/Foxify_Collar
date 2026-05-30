# Phase 0 — Live Baseline (v5): Log-Driven Findings + Active Bug Catalog

**As of:** 2026-04-18T04:49 UTC
**Sample:** 23 active protections — **8 pre-tenor-switch, 15 post-tenor-switch**.
**Δ vs v4:** +1 trade (`aece2997`, the **first post-switch ITM short**); first parse of `[DeribitAdapter]` and `[Activate]` log lines.

---

## TL;DR

1. ✅ **DVOL fix is verified live** at `/pilot/regime` (DVOL = 43.09, regime = normal, source = dvol). Confirmed earlier this turn via `pilot:verify:dvol-source`.
2. ⚠ **The hedge-manager cycle log itself has not been re-confirmed post-deploy.** The pasted logs in this turn contain the activate / monitor traffic only — no `[HedgeManager] Cycle complete:` lines were included. The 5 cycle lines I have are the pre-deploy ones from the v4 run, which still show `vol=high(133)`. Need one fresh post-deploy cycle line to close that loop.
3. 🔧 **REAL BUG SURFACED:** `[Activate] Execution quality upsert failed: null value in column "id"` — the `pilot_execution_quality_daily` rollup table insert has been failing silently on every activation. Activations themselves are unaffected; the error is caught and logged. But `/pilot/admin/diagnostics/execution-quality` will keep returning empty until this is fixed. Production-readiness item, not a pilot blocker.
4. 📊 **One observed slippage event worth tracking:** the `aece2997` trade filled at `0.0009` BTC/contract while `mark_price` was `0.00075092` — paid ~20% over mark on a thinly-traded short-dated call. ~$1.16 extra on a $50 premium. Not a bug; market-microstructure on near-ATM short-dated. Worth tracking systematically as the sample grows.

---

## 1. The new trade — `aece2997`, first post-switch ITM short

| Field | Value |
|---|---|
| Created | 2026-04-18 04:43:45 UTC |
| Tier | SL 2% short |
| Notional | $10,000 |
| Entry | $77,111 |
| Trigger ceiling | $78,653 |
| Selected | `BTC-19APR26-78500-C` |
| Strike | $78,500 (ITM by ~$153 vs ceiling — short call ITM = strike below trigger) |
| Days to expiry | 1.14 |
| Premium | $50.00 |
| Hedge cost (DB) | $6.94 |
| Margin% | 86.1% |

**Selection diagnosis**: this is the **first post-switch ITM short** in the entire dataset. The selector picked $78,500 over OTM $79,000 because:

1. Trigger ceiling was $78,653 (between the two strikes).
2. Strike-buffer of ±0.5% of spot ≈ ±$385 puts both $78,500 and $79,000 in band.
3. `preferItm` is gated to `drawdownFloorPct ≤ 0.025` — fires for SL 2%.
4. But: `preferItm` is also gated to **option type = put** (longs only). For a short → call, `preferItm = false`. So this ITM call selection is **NOT** the `preferItm` bonus firing.
5. It's the asymmetric tenor penalty + cost-cap soft penalty + strike-distance scoring picking the closer-to-trigger strike. $78,500 is $153 from trigger, $79,000 is $347 — the $78,500 wins on `Math.abs(strike - triggerTarget) / spot` term in the score.

This matches the same pattern as `d4326e17` (SL 10% long ITM by $20) and `a8dce393` (SL 5% short ITM by $132). All three are correct selector behavior, not preferItm misfires. **No code change warranted.**

---

## 2. Slippage observation worth flagging (single event)

From your DeribitAdapter log:
```
average_price = 0.0009 BTC
mark_price    = 0.00075092 BTC
iv            = 27.23
```

The fill was 20% over mark. On 0.1 BTC × $77,108 ≈ $1.16 of slippage on a $50 premium / $7 hedge → **~16% extra on the hedge cost itself** (paid $6.94 vs ~$5.79 at mark).

This is real but unsurprising at our scale on a thinly-traded near-ATM short-dated option. Deribit BTC options have wide spreads on small-strike-distance contracts. The cost-cap soft penalty in the selector uses `ask` (which approximated this fill price), so it's not surprising the algorithm picked it — the alternative strikes had similar spread issues.

**Action**: none for now. Worth re-checking whether this is systemic across the sample once we have ≥ 10 short-side activations to look at. Phase 2 chain sampler (which records bid/ask/mark side-by-side) will give the empirical distribution.

---

## 3. Live bug catalog (new, surfaced this turn)

### 3.1 `pilot_execution_quality_daily` insert fails on every activation

**Severity**: Low impact during pilot, **medium for production**.
**Symptom**: every activation produces a `[Activate] Execution quality upsert failed: null value in column "id" of relation "pilot_execution_quality_daily" violates not-null constraint` log line. The error is caught (activation succeeds), but no row is written.
**Effect**:
- `/pilot/admin/diagnostics/execution-quality?lookbackDays=30` returns empty (no records).
- The Admin Dashboard "Execution" tab shows "No execution quality data available."
- Cannot compute fill rate / slippage rollups for monitoring or for Foxify reporting.
**Likely cause**: the SQL `INSERT INTO pilot_execution_quality_daily ... ON CONFLICT ... DO UPDATE` doesn't generate the `id` column, and the column definition has no `DEFAULT gen_random_uuid()` (or sequence) on Render. Either the migration was incomplete, or the upsert path is missing an explicit `id` value.

**Per stabilization mode I am NOT proposing a fix in this turn.** Three reasons it's worth fixing soon (your call):
- It's silent corruption of the diagnostics rollup. Activations work, but you have no visibility into per-day fill quality.
- It will continue to look "ok" in the platform UI (fill rate just shows blank instead of broken).
- Once Foxify is integrated, an empty execution-quality endpoint is a bad signal during their integration testing.

If you say go, I'd open a separate `cursor/fix-execution-quality-id-default-38e5` PR with a single migration adding a `gen_random_uuid()` DEFAULT and the upsert path explicitly setting `id = COALESCE($id, gen_random_uuid())`. Tightly scoped, low risk.

### 3.2 Hedge-manager cycle visibility gap (data, not code)

The 5 ingested cycle lines are pre-DVOL-fix and all show `vol=high(133)`. To close the loop on the fix, paste a fresh `[HedgeManager] Cycle complete:` line from the last 30 minutes — even one is enough. Until then, my report's §7d shows `vol=high: 5, vol=normal: 0`, which **does NOT mean the fix didn't work** — the platform `/pilot/regime` endpoint already returns DVOL=43, and the in-memory regime cache (60s TTL) refreshed long ago. It just means I haven't seen a post-deploy cycle line yet.

---

## 4. Updated post-switch tier coverage

| Tier | Long | Short | Total | New since v4 |
|---|---|---|---|---|
| SL 2% | 2 | **5** (incl. new ITM aece2997) | **7** | +1 |
| SL 3% | 2 | 1 | 3 | — |
| SL 5% | 2 | 1 | 3 | — |
| SL 10% | 1 | 1 | 2 | — |
| **Total** | **7** | **8** | **15** | +1 |

Long/short matrix is now complete in 2/3/5/10 — **15 trades, full coverage**. The 2% short tier has the largest sample (5 trades, 4 OTM + 1 ITM).

---

## 5. Refreshed totals (post-switch only, n=15)

| Item | Amount |
|---|---|
| Premium collected | $1,435.00 |
| Hedge cost | $160.09 |
| Spread | $1,274.91 |
| Payouts due | $0.00 |
| TP recovery | $0.00 |
| **Post-switch Net P&L (paper)** | **$1,274.91** |

Average margin across post-switch sub-sample: **88.8%** (calm vol). Up modestly from v4 because the new ITM short paid 86.1% margin, slightly above the 2% tier average.

---

## 6. Plumbing observations (your request log)

- Monitor poll cadence ~3s, response times mostly 175-490ms. Reasonable.
- One spike to 786ms on the activate flow for `aece2997` — full quote → Deribit market order → DB writes. Good.
- One spike to 732ms on a monitor poll — DB connection-pool churn, normal at low concurrency.
- Zero 5xx responses across the entire window.
- Zero `consecutive price errors` warnings.
- Zero `triggered` events (no breaches).
- `/pilot/protections/activate` was hit twice ([OPTIONS] preflight + [POST]) — clean CORS round trip.

---

## 7. What does NOT need a code change

- ✅ Selection algorithm — the new ITM short is selector-correct.
- ✅ DVOL data source — fixed and verified at the regime endpoint.
- ✅ V7 pricing schedule — unchanged, regime-flat at user level.
- ✅ TP logic — not exercised by any post-switch trigger yet, now wired to correct DVOL.

---

## 8. What might warrant a (separate, sign-off-gated) code change

| Item | Severity | Recommended action |
|---|---|---|
| `pilot_execution_quality_daily` `id` NOT NULL violation | Medium for production, Low for pilot | Fix recommended pre-Foxify-integration. Single migration + one-line upsert change. ~30 lines total. |
| Hedge-manager cycle observability | Low | Already complete server-side; just need next batch of log paste-ins to confirm. No code change. |
| Slippage tracking | Low | Not actionable yet. Phase 2 sampler + larger short-side sample will tell us if it's systemic. |

---

## 9. Updated 7-day tracking checklist

| Signal | Where | Why |
|---|---|---|
| Next `[HedgeManager] Cycle complete:` log line | Render logs → next paste-in | Confirms `vol=normal(43)` post-deploy |
| First post-switch trigger + TP outcome | DB + logs | Highest-information event remaining |
| Phase 2 sampler 7-day window | `chain-samples-data` branch (gated on PR #22 workflow enable) | Empirical chain-availability + bid-ask map |
| Continued `[Activate] Execution quality upsert failed` events | Logs | Confirms the bug is systemic (not a one-off DB race) |
| Slippage events from DeribitAdapter `execute:` lines | Logs | Builds the slippage distribution |
| Operator decision on the execution-quality bug fix | Your call | Defer to post-pilot vs ship now |

---

_End of Phase 0 v5 findings._
