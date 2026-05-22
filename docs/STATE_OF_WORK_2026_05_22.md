# State of Work — 2026-05-22 19:00 ET (bookmark)

This is a point-in-time snapshot of where the VC sandbox + spread work stands.
Use this as the "go back to here" reference if context is lost.

## Branches

| Branch | Tip | Purpose |
|---|---|---|
| `vc-sandbox` | `7a88d72` | Production-equivalent sandbox. Deployed to **live** + **shadow** Render services. Contains Bullish singleton/caching, slippage floor, archive endpoint, E1 microtest script. |
| `vc-sandbox-spreads` | `394c6c2` (currently checked out) | Track 2 spread scaffolding. Contains everything in `vc-sandbox` PLUS the spread design doc, `spreadHedge.ts`, `matrix.ts` field additions, and the in-progress E2 microtest script. |
| `vc/track1-archive-and-slippage-floor` | `da1b715` | Frozen — predecessor of `vc-sandbox`, kept as recovery point. |

### Branch divergence (vc-sandbox-spreads ahead of vc-sandbox by)
```
08fa146  feat(vc/spread): Track 2 scaffold — matrix fields + [DB] strike/sizing/routing
+ this commit: feat(vc/probes): bullish_short_e2e_microtest (Phase E2 draft)
```

## Render deployments

| Service | Branch tracked | Status | Critical env vars |
|---|---|---|---|
| `foxify-pilot` (LIVE) | `vc-sandbox` | Hosting 1 live Foxify position (see below). Bullish balance tracking DISABLED. | `PILOT_DEPLOYMENT_TIER=live`, `BULLISH_BALANCE_TRACKING_ENABLED=false`, `PILOT_BULLISH_ALLOW_MARGIN=false` |
| `foxify-pilot-shadow-3r1m` (SHADOW) | `vc-sandbox` | Used for E1 (passed). | `PILOT_DEPLOYMENT_TIER=shadow`, `BULLISH_BALANCE_TRACKING_ENABLED=true`, `PILOT_BULLISH_ALLOW_MARGIN=false` ← **needs flip to `true` before E2** |

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

- **Track 1: slippage floor** for limit IOC discretionary TP exits — backported to live (commit `1926291` → on `vc-sandbox`).
- **Track 1: archive position endpoint** — live (`8137ba6` + tests `c7fd032`).
- **vc-pos-e41890f triage** — see "Open positions" above. Force-sold both legs, finalized salvage event, projected −$190 final P&L at pair expiry. Cell to be disabled on live via toggle.
- **Bullish singleton + caching** — pushed to `vc-sandbox` (`a9209cc`). 7 callsites migrated, orderbook+balance caching, negative cache for rate-limit, env gate.
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
