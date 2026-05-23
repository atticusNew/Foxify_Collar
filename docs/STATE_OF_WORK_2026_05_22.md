# State of Work — 2026-05-22 19:00 ET (bookmark)

This is a point-in-time snapshot of where the VC sandbox + spread work stands.
Use this as the "go back to here" reference if context is lost.

## Branches

| Branch | Tip | Purpose |
|---|---|---|
| `vc-sandbox` | `01ad919` | Auto-deploys to **shadow** Render only. Contains Bullish singleton/caching, slippage floor, archive endpoint, Foxify premium-math fix, E1 microtest script. |
| `vc-sandbox-spreads` | `ebe94e3` (currently checked out) | Track 2 spread scaffolding. Contains everything in `vc-sandbox` PLUS the spread design doc, `spreadHedge.ts`, `matrix.ts` field additions, E2 microtest script. |
| `cursor/-bc-c2468b87-16cc-4357-84a5-12c8079ff3c2-6ba4` | `b4e7a2b` (post-merge 2026-05-22 23:51 UTC) | **Was the LIVE-tracked branch per stale render.yaml.** Verify in Render dashboard for `foxify-pilot-new` whether it's still tracked. Merge of vc-sandbox just pushed; deploy status pending dashboard check. |
| `vc/track1-archive-and-slippage-floor` | `da1b715` | Source branch for slippage-floor commit `1926291`. Equivalent functionality (different SHA) is in `c3eeb89` on `vc-sandbox` and now in the live cursor branch via merge `b4e7a2b`. |

### CRITICAL: live deploy drift (corrected 2026-05-22 19:25 ET)

Earlier assumption that "vc-sandbox deploys to live" was wrong. Verified via `render.yaml` and `render-shadow.yaml`:
- **Shadow** auto-deploys from `vc-sandbox` (confirmed in render-shadow.yaml line 28).
- **Live** is pinned to `cursor/-bc-c2468b87-16cc-4357-84a5-12c8079ff3c2-6ba4` (per render.yaml). Tip: `9ee5af5` from 2026-05-19.

What's NOT on live but exists on vc-sandbox:

| Commit | Description | Operational impact while undeployed |
|---|---|---|
| `c3eeb89` | slippage floor for limit-IOC discretionary TP exits | All TP-curve sells on live are market — no slippage defense |
| `a9209cc` | shared Bullish singleton + caching | Every Bullish call from live opens fresh JWT → `MAX_SESSION_COUNT_REACHED` risk |
| `f3d3858` | Bullish negative-cache for rate limit | No backoff on Bullish `RATE_LIMIT_EXCEEDED` (96100) |
| `2421c83` | archive position endpoint | Test-position cleanup blocked (404 confirmed 2026-05-22) |
| `01ad919` | Foxify dashboard premium-math fix (F1/F2/F3) | Foxify dashboard shows wrong premium owed + hides triggered positions |
| ~23 others | Bullish admin endpoints + probe scripts + tests | Low impact for live ops (mostly diagnostic tooling) |

### Sync paths available

1. **Merge `vc-sandbox` → live cursor branch + push.** Render auto-deploys (if cursor branch has `autoDeploy: true` in render.yaml). Brings everything at once. Lower-risk than it sounds because the 27 commits are mostly additive endpoints + scripts.
2. **Cherry-pick top-3 highest-impact** (`c3eeb89` slippage floor, `a9209cc` Bullish singleton, `2421c83` archive) to the live cursor branch. Smaller blast radius, requires conflict-resolution.
3. **Re-point `render.yaml` for live to track `vc-sandbox` directly.** Largest change but cleanest going forward.

Until path is chosen, treat live as "frozen at `9ee5af5`" and route critical fixes via cherry-pick.

### Branch divergence (vc-sandbox-spreads ahead of vc-sandbox by)
```
08fa146  feat(vc/spread): Track 2 scaffold — matrix fields + [DB] strike/sizing/routing
+ this commit: feat(vc/probes): bullish_short_e2e_microtest (Phase E2 draft)
```

## Render deployments

**IMPORTANT — `render.yaml` is NOT authoritative for live.** The yaml file lists service names `atticus-pilot-api` / `atticus-pilot-web`, but the **actual deployed Render services are `foxify-pilot-new` and `foxify-pilot-new-web`**, configured directly in the Render dashboard. Always check the Render dashboard for branch + autoDeploy + env vars — yaml may be stale.

| Service (Render dashboard name) | URL | Branch tracked | Status | Critical env vars |
|---|---|---|---|---|
| `foxify-pilot-new` (LIVE API) | https://foxify-pilot-new.onrender.com | **CHECK RENDER DASHBOARD** (was `cursor/-bc-c2468b87-...-6ba4` per stale render.yaml; merge `b4e7a2b` pushed to that branch 2026-05-22 23:51 UTC pending deploy verification) | Hosting vc-pos-e41890f0 (triggered, hedges sold, accruing premium to pair close Sun 12:13 UTC). Bullish balance tracking DISABLED. | `PILOT_DEPLOYMENT_TIER=live`, `BULLISH_BALANCE_TRACKING_ENABLED=false`, `PILOT_BULLISH_ALLOW_MARGIN=false`, `VC_TP_SLIPPAGE_FLOOR_ENABLED` (not set → default false) |
| `foxify-pilot-new-web` (LIVE WEB) | (web frontend) | Same as API | Foxify-facing dashboard | (env unknown, check dashboard) |
| `foxify-pilot-shadow` (SHADOW API) | https://foxify-pilot-shadow-3r1m.onrender.com | `vc-sandbox` (autoDeploy per render-shadow.yaml line 28-29) | Used for E1 (passed). Always current with vc-sandbox. | `PILOT_DEPLOYMENT_TIER=shadow`, `BULLISH_BALANCE_TRACKING_ENABLED=true`, `PILOT_BULLISH_ALLOW_MARGIN=false` ← **needs flip to `true` before E2** |

## Open positions (live Foxify)

### vc-pos-e41890f  (BTCUSD-poc-177) — TRIAGED 2026-05-22 23:12 UTC
- **Cell**: `30k_2pct_600`
- **Status**: TRIGGERED (down side, spot crossed $75,560 ~25min before triage)
- **Hedges**: BOTH SOLD
  - Put @ $76,500, 0.80 BTC, bought $578.22/BTC, **sold $757.58/BTC** ($606.07 proceeds, order `156346659079`)
  - Call @ $78,000, 0.80 BTC, bought $462.58/BTC, sold $7.56/BTC ($6.05 proceeds)
- **P&L accounting**:
  ```
  +$297.50  premium income to triage (34h × $210/d)
  +$  6.05  call proceeds
  +$606.07  put proceeds (force-sold via /admin/force-sell-leg)
  −$832.64  hedge premium paid (both legs combined)
  −$600.00  payout obligation (DOWN trigger fired)
  ───────
  −$523.02  P&L at triage
  +$332.50  remaining premium accrual if pair runs to scheduled close (38h × $210/24)
  ───────
  ≈ −$190   PROJECTED FINAL P&L at Foxify pair expiry
  ```
- **Why fill was below estimate**: Dry-run @ IV=0.55 estimated $1,154 MTM; actual fill $606. Three factors compounded:
  1. Spot likely rallied 400–600 USDC in the 6min between dry-run and sell (failed-breakdown bounce off trigger boundary)
  2. Realized IV is lower than 0.55 (env runs IV=0.40; reality may be 0.30–0.35)
  3. `force-sell-leg` uses MARKET sell, not the slippage-floor limit IOC (see Track 1 bug below)
- **Decision quality**: EV-correct. Weighted HOLD EV was −$269 with σ≈$600 (35% probability of −$900 outcome). We're in the better half of the HOLD distribution and locked in our outcome. Selling was right; the fill timing was unlucky.
- **Cell-level takeaway**: `30k_2pct_600` is structurally negative-EV when triggered. Hedge premium ($832) > 3-day premium runrate ($630). Even before payout obligation, the cell is already at −$200. This is exactly the gap Track 2 ([DB] TIGHT-spread, hedge cost ~$186 for 30k) closes.
- **Follow-up action**: Disable `30k_2pct_600` cell on live via `POST /admin/cells/30k_2pct_600/toggle { "enabled": false }` (no deploy required).

### vc-pos-e4f7f9bd (Bullish test position)
- ARCHIVED. Was test-only; archive endpoint applied; excluded from dashboard/salvage.

## Completed (this session)

- **Track 1: slippage floor** for limit IOC discretionary TP exits — **on `vc-sandbox` ONLY (commit `c3eeb89`); NOT yet on live.** Earlier bookmark statement was incorrect. Live cursor branch is `9ee5af5`, predates this commit by 3 days.
- **Track 1: archive position endpoint** — **on `vc-sandbox` ONLY (`2421c83`); NOT yet on live.** Confirmed via 404 from live admin call 2026-05-22 19:22 ET.
- **Foxify dashboard premium-math fix** — two commits this session:
  - **v1** (`01ad919` vc-sandbox / `637102c` vc-sandbox-spreads): fixed three bugs.
    - F1: `/foxify/positions` sent per-day RATE in `premiumPaidUsdc` → Foxify read as already-paid → "owed = 0".
    - F2: `/foxify/today` summed daily rates of positions opened TODAY, missing yesterday's still-alive positions.
    - F3: `/foxify/positions` hid TRIGGERED positions (used `listActivePositions` which is status='active' only). Added `listLiveFoxifyPositions` (active+triggered).
  - **v4** (`3b9321b` vc-sandbox-spreads / `6e8d281` vc-sandbox / `0c1208c` live): operator-reported three more midnight-rollover panels — Active Protections (status strip): 0, Triggered (today): 0, Net (Foxify-side): −$210. All three were today-only fields that emptied when UTC midnight rolled `vc-pos-e41890f0` into "yesterday" UTC. Fixed:
    - `/foxify/status.activeCount`: changed semantic to `status IN ('active','triggered')` so a triggered position still counts as a live protection (matches the table). Now → 1.
    - `/foxify/today`: added `liveActiveCount`, `liveTriggeredCount`, `liveTotalCount`. Frontend Triggered tile binds to `liveTriggeredCount`. Now → 1.
    - `/foxify/today.foxifyNetUsdc`: changed from today-only flow (`payoutsReceivedToday − premiumBilledToday`) to lifetime (`payoutExpected − premiumBillableLifetime`). Now → +$180 ($600 expected payout − $420 billable premium). `foxifyNetTodayUsdc` retained as the explicit today-only flavour.
    - Frontend retitled the panel "Activity Summary (lifetime + today UTC)" so the mix of lifetime/today fields no longer reads as contradictory.
  - **v3** (`7cdf53c` vc-sandbox-spreads): operator-reported gap after v2 — Foxify dash payout number "disappeared" at UTC midnight. Root cause: `payoutsReceivedUsdc` was today's-window only; the only live trigger (vc-pos-e41890f0 fired Fri 22:44 UTC) moved into the "yesterday" window once the clock crossed midnight UTC. Same midnight-rollover pattern as the original premium F2 bug.
    - Added `payoutExpectedUsdc` (sum of `payout_usdc` across all live active+triggered, non-archived, non-admin-test) — the "Foxify is expecting" headline that never vanishes.
    - Granular splits: `payoutOwedTriggeredUsdc` (will be paid at pair-close) + `payoutPotentialActiveUsdc` (if-trigger-fires exposure).
    - Frontend (`apps/web/src/FoxifyDashboard.tsx`): added Payout column to Active Protections table (per-position `payoutUsdc`); rebound the today panel headline from `payoutsReceivedUsdc` (today only) to `payoutExpectedUsdc` (lifetime, with the owed / if-triggered breakdown shown as a subline).
  - **v2** (`97f0b3c`): operator-reported gap after merge — live dash showed $209 (today's hourly) but never showed yesterday's $210. Root cause: v1 used hourly-precision accrual everywhere, but **Foxify's contract bills per-day round-up** (any portion of a UTC day = 1 full day, per `weeklyReconciler.daysActiveInWindow`).
    - Added `premiumBillableInWindowUsdc` helper (`ceil(overlap_hours/24) × dailyRate`).
    - `/foxify/positions` per-position: `premiumPaidUsdc` is now BILLABLE since open (contract amount). vc-pos-e41890f0 → 2 days × $210 = $420. Hourly view still exposed via `premiumAccruedUsdc`.
    - `/foxify/today` exposes all four views: `premiumBillableLifetime`, `premiumAccruedLifetime`, `premiumBillableToday`, `premiumAccruedToday`. Headline `premiumPaidUsdc` is now lifetime billable (cumulative across all live positions, contract rule).
    - 15 unit tests (9 accrued + 6 billable).
- **render.yaml clarification** (same v2 commit) — added a header comment documenting that yaml service names (`atticus-pilot-api` / `atticus-pilot-web`) are stale; actual live Render services are `foxify-pilot-new` / `foxify-pilot-new-web`. yaml branch + autoDeploy happen to currently match live (verified during the merge auto-deploy), but the Render dashboard is the authoritative source for live config. Always check there before any ops change.
- **vc-pos-e41890f triage** — see "Open positions" above. Force-sold both legs, finalized salvage event, projected −$190 final P&L at pair expiry. Cell to be disabled on live via toggle.
- **Bullish singleton + caching** — pushed to `vc-sandbox` (`a9209cc`). 7 callsites migrated, orderbook+balance caching, negative cache for rate-limit, env gate.
- **Bullish E3 (4-leg [DB] spread atomicity) microtest** — first run on shadow 2026-05-23 ~01:13 UTC. Open partially succeeded (3 of 4 legs filled), 4th leg (SHORT call 80000-C SELL) failed with `Expired` reason — orderbook had **no resting bid** for that strike (bid=null, ask=$30), so the IOC immediately expired with 0 fills. Rollback engaged and **all 3 already-opened legs unwound cleanly in reverse order** with real Bullish fills. Zero stuck positions. Round-trip cost of the failed-open + rollback: ~$1.40 on 0.01 BTC.
  - **Validated**: 4-leg sequenced open under the safety invariant (no naked-short window — the failure happened on the SELL-to-open before any uncovered exposure existed). Failure detection from `finalReason=Expired` + `finalFillQty=0`. Rollback path executes correctly against real Bullish API. Each rollback leg filled.
  - **NOT YET validated** (script exited at rollback as designed): Phase 3 4-leg margin friction snapshot, Phase 5 sequenced close, Phase 7 full round-trip accounting and per-BTC production sizing.
  - **New requirement discovered for Track 2 PR #2**: production strike-selection must verify **resting bid for shorts** and **resting ask for longs** before submitting, not just "is the option listed". Far-OTM near-expiry strikes are routinely listed without bids.
  - **Script hardening (commit `cc9904f`)**: strict per-leg liquidity gate added at Phase 1. Now aborts with exit 3 before any trade if the side we'll cross has no resting order, with the actual bid/ask printed. This change would have saved the ~$1.40 we spent on the failed open + rollback.
  - **Next**: re-run with a SHORT call strike that has bid liquidity (likely 79000-C; needs orderbook check first) paired with a LONG call one strike inside. That run should complete cleanly and give us the missing Phase 3+7 data.
  - Initial draft commit: `b8b1b7f` (now `8ba43e8` after amend backfill).
  - Default structure mirrors `50k_2pct_1k` [DB] tight-spread at 0.01 BTC per leg (1/50th of production size).
  - Strikes (2026-05-26 expiry): LONG put 75000 + SHORT put 74000 (E1/E2 tested), LONG call 78000 + SHORT call 80000.
  - Sequenced open: longs-first-then-shorts, put-pair before call-pair. Invariant: a freshly-opened short is always covered by its long before opening — no naked-short window at any point.
  - Sequenced close: shorts-first-then-longs, reverse order. Same invariant on the way out.
  - Rollback logic: if any open leg fails, reverse the legs already opened in reverse order. Prints manual recovery curl if even rollback fails.
  - Validates four things Track 2 PR #2 will rely on:
    1. 4-leg atomicity (no half-opened spreads sticking around)
    2. Bullish portfolio-margin behaviour at the spread level (does the put/call pair-recognition reduce margin below naked-summed?)
    3. Margin engine batch-release on multi-leg close
    4. Rollback path works under real Bullish error responses
  - Safety rails: hard cap 0.01 BTC/leg, $10 cap per BUY, $30 cap per SELL, requires USDC ≥ $30 to start.
  - macOS bash 3.2 compatible (no `${var,,}` expansion).
- **Bullish E2 (short-leg margin) microtest** — VALIDATED on shadow 2026-05-23 ~00:55 UTC.
  - `PILOT_BULLISH_ALLOW_MARGIN=true` confirmed plumbed end-to-end (`config.allowMargin: true` in test-sell response).
  - SELL-TO-OPEN 0.01 BTC `BTC-USDC-20260526-74000-P` @ $50 limit IOC → filled at bid $360, orderId `978098787586671617`.
  - BUY-TO-CLOSE @ $700 limit IOC → filled at ask $410.
  - Margin observation (the headline finding): Bullish uses a mark-to-market option margin model that nets proceeds against margin.
    - Proceeds credited: $3.60 (0.01 BTC × $360)
    - True margin posted: ~$3.68 (≈ $367.53/BTC)
    - Net cost to operator: ~$0.075 (≈ $7.53/BTC after proceeds offset)
    - `USDC locked` stayed $0 throughout (Bullish handles option margin internally, not via the spot-balance `locked` field)
    - `USDC borrowed` stayed $0 → no borrowing required
  - Round-trip economic cost: $0.15 on 0.01 BTC (script's price-math predicted $0.50; the $0.35 gap is likely Bullish IOC price improvement beyond reported `finalFillPrice`).
  - Margin released cleanly after BUY-TO-CLOSE — no naked exposure or stuck margin.
  - **Decision: GO for Bullish as the short-leg venue for Track 2.** Net cost per spread cell is dominated by the long-leg premium debit (~$300-400), not the short-leg margin (~$7.50/BTC × 1 BTC = ~$8). A `50k_2pct_1k` [DB] spread will need roughly **$370 USDC of capital per cell**.
  - Script `bullish_short_e2e_microtest.sh` updated to report TRUE margin and NET cost separately (commit `11c617e`); prior version's "Implied margin per BTC" label was misleading (it was net cost, not gross margin).
- **Bullish E1 (long round-trip) microtest** — VALIDATED on shadow.
  - Round-trip net cost: $0.40 on 0.01 BTC of `BTC-USDC-20260526-75000-P`
  - Buy filled at $560, sell filled at $520, fees $0.0001
  - Bullish IOC `CLOSED + Executed` lifecycle confirmed; endpoint + script updated to recognize it.
- **Spread feasibility probe v2** (Bullish chain-aware) — confirmed [DB] TIGHT-spread is ~29% cheaper than current Deribit strangle on the 50k_2pct_1k cell (~$310 hedge cost vs ~$435).
- **Track 2 PR #1 (scaffolding)** — pushed to `vc-sandbox-spreads` (`08fa146`).
  - `docs/VOLUME_COVER_SPREAD_DESIGN_2026_05_22.md` design doc
  - `matrix.ts`: `spreadWidthUsdc` + `shadowOnly` fields, `computeSpreadStrikesDB` helper
  - `spreadHedge.ts`: venue routing, sizing, leg construction (12 passing unit tests)

## In-flight (now)

- **Bullish E2 (short-leg margin path) microtest** — drafted at `services/api/scripts/probes/bullish_short_e2e_microtest.sh`.
  - Targets `BTC-USDC-20260526-74000-P`, 0.01 BTC
  - Will measure actual Bullish margin requirement per BTC
  - Blocker: needs `PILOT_BULLISH_ALLOW_MARGIN=true` on shadow Render env

## Pending after E2 passes

1. **Bullish E3** — full 4-leg [DB] spread microtest at small size (~$6 expected net cost).
2. **Track 2 PR #2** — TP adapter for spread groups + DB migration (`spread_group_id`) + sequenced execution + rollback.
3. **Track 2 PR #3** — Bullish/Deribit venue executors for spreads + shadow integration tests.
4. **Track 2 PR #4** — flip `50k_2pct_1k` cell from strangle to spread in shadow, soak, then live.

## Open decision points

- If E2 reveals Bullish margin > $X/BTC such that the production spread can't fit on a reasonable Bullish account size, **fall back to Deribit-primary for short legs** (already designed into `resolveSpreadVenue`).

## Track 1 follow-up bugs surfaced during vc-pos-e41890f triage

### Bug T1-A: `hedge-manager/run?dryRun=true` permanently mutates leg `running_max_value_usdc`
- **File**: `services/api/src/volumeCover/volumeCoverHedgeManager.ts`, line 694–702
- **Symptom**: `updateHedgeLegTpState` is called *unconditionally* before the `dryRun` check at line 797. When an operator runs `?dryRun=true&iv=0.55` on a leg whose live ticks use a lower IV, the higher dry-run MTM is committed to the DB via `GREATEST(prior, current)`. The inflated running_max then causes Rule 5 (trail retracement, 20%) to fire prematurely on subsequent live ticks.
- **Observed impact on vc-pos-e41890f**: Our triage dry-run at IV=0.55 wrote $1,154.27 as the new running_max. Live ticks at IV=0.40 would have produced ~$1,020. Rule 5 threshold moved up $105 → would have fired SELL when spot hit ~$76,000 instead of ~$75,800. Modest impact this time; could be material on other positions.
- **Fix**: Move `updateHedgeLegTpState` call inside an `if (!dryRun)` branch, or pass `dryRun` into the function and have it no-op when set. Add a regression test.

### Bug T1-B: `/admin/force-sell-leg` bypasses the slippage-floor limit-IOC path
- **File**: `services/api/src/volumeCover/volumeCoverRoutes.ts`, line 2915–3048 (handler) → `opts.hedgeExecutor.sellOptionLeg()` (executor)
- **Symptom**: Operator-driven manual unwinds go straight to market sell. The slippage-floor limit-IOC defense (commit `1926291`) is only wired into the hedge manager's TP rule evaluation for rules 5/6/10/11. Manual force-sell eats the full bid-ask spread plus depth.
- **Observed impact on vc-pos-e41890f**: $606 fill on the put vs ~$900–1,000 fair-value estimate. Hard to disentangle from spot-bounce contribution, but reasonable to attribute $50–100/BTC ($40–80 total) to bypassed slippage protection.
- **Fix**: Add an optional `useSlippageFloor?: boolean` body param to `force-sell-leg`, default `true` for live tier; route through the same limit-IOC path the TP curve uses. Backport to vc-sandbox so it lands on live before any future manual unwinds.

## Important commands (reference)

```bash
# Shadow URL + admin token (replace with current values)
export SHADOW_API="https://foxify-pilot-shadow-3r1m.onrender.com"
export SHADOW_ADMIN_TOKEN="..."

# E1 (already passed) — long round-trip
SKIP_ORDERBOOK_CHECK=1 BUY_LIMIT_USDC=700 \
  bash services/api/scripts/probes/bullish_e2e_microtest.sh

# E2 (next) — short-to-open margin path
SKIP_ORDERBOOK_CHECK=1 \
  bash services/api/scripts/probes/bullish_short_e2e_microtest.sh

# Position dashboard
curl -sS "$SHADOW_API/volume-cover/admin/positions" \
  -H "X-Admin-Token: $SHADOW_ADMIN_TOKEN" | jq

# Specific position detail
curl -sS "$SHADOW_API/volume-cover/admin/positions/vc-pos-e41890f" \
  -H "X-Admin-Token: $SHADOW_ADMIN_TOKEN" | jq
```

## How to return to this bookmark

```bash
git checkout vc-sandbox-spreads          # contains everything
git log --oneline -5                     # confirm tip
```

The tag `bookmark-2026-05-22-pre-e2` is pinned to this commit.
