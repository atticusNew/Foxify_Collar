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

### vc-pos-e41890f  (BTCUSD-poc-177)
- **Cell**: `30k_2pct_600` (will be `shadowOnly` once Track 2 lands — keep alive in live for now)
- **Status**: TRIGGERED (down side) ~ at $75,560
- **Hedges** (Deribit, TIGHT strangle — old design):
  - Put @ $76,500, 0.80 BTC, bought $578.22/BTC — **open, retained as winner**
  - Call @ $78,000, 0.80 BTC, bought $462.58/BTC, sold $7.56/BTC — closed (loser)
- **Action under analysis**: separate triage doc to follow this bookmark

### vc-pos-e4f7f9bd (Bullish test position)
- ARCHIVED. Was test-only; archive endpoint applied; excluded from dashboard/salvage.

## Completed (this session)

- **Track 1: slippage floor** for limit IOC discretionary TP exits — backported to live (commit `1926291` → on `vc-sandbox`).
- **Track 1: archive position endpoint** — live (`8137ba6` + tests `c7fd032`).
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
- Whether to flip `30k_2pct_600` cell back to `shadowOnly: true` immediately (it currently has a live triggered position; can only flip after position closes).

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
