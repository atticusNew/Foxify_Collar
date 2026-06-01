# Foxify Pilot — Operator Live-Test Runbook (kill switch + monitoring)

Purpose: execute **one controlled live pair** with the **lowest premium** to prove
the real-money plumbing end-to-end, then roll back. Real money only. Treat every
step as reversible — the kill switch is one curl.

> Shell prereqs: `PILOT_API_BASE`, `RENDER_ADMIN_TOKEN`, `FOXIFY_API_KEY`. All
> curls use `--http1.1`. Admin endpoints take `-H "X-Admin-Token: $RENDER_ADMIN_TOKEN"`.

---

## 0. Golden rules
- **Calm regime can never go live** (hard-disabled, `SS_TWO_SIDED_ALLOW_CALM=false`). A live test requires the market to be in **moderate+**.
- Start with `SS_TWO_SIDED_MAX_PAIRS_PER_DAY=1` and a **single-cell allowlist**.
- Keep a second terminal open with the **kill switch** (§6) ready to paste.
- Lowest premium ≠ best EV — this is a *plumbing* proof. Graduate to the validated
  `pair_150k_3pct_atm_3d` only after the plumbing test passes.

## 1. Pre-flight health (must all be green)
```bash
curl --http1.1 -sS -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" "$PILOT_API_BASE/admin/foxify/v2/diagnostics" \
  | jq '{feed: .feed.health, venues: .liquidChainCache.venue_status}'
# expect feed "healthy"; deribit ok:true (bullish ok:true preferred, but Deribit-only is acceptable for the test)
```
- Confirm current regime is **moderate+** (else stand down and wait):
```bash
curl --http1.1 -sS -H "X-Foxify-Token: $FOXIFY_API_KEY" "$PILOT_API_BASE/foxify/v2/should_activate" | jq '{regime, signal_tier, recommended_structure}'
```
- (Optional) confirm Bullish authed access from the whitelisted IP:
```bash
curl --http1.1 -sS -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" "$PILOT_API_BASE/admin/foxify/v2/bullish-auth-probe" | jq '{ok, whitelist, interpretation}'
```

## 2. Pick the lowest-premium cell + confirm its real cost
Candidates (cheapest first): `pair_25k_5pct_otm_3d` (~$200–300), then `pair_50k_3pct_atm_3d` (~$1.3k, validated ATM).
```bash
curl --http1.1 -sS -X POST -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" -H "Content-Type: application/json" \
  "$PILOT_API_BASE/admin/foxify/v2/scaling-projection" \
  -d '{"cell_id":"pair_25k_5pct_otm_3d","regime":"moderate","budget_usdc":5000}' | jq '.cost_per_pair_usdc'
```

## 3. Arm live execution (Render env), then redeploy
```
SS_TWO_SIDED_LIVE_ENABLED=true
FOXIFY_V2_LIVE_EXECUTION=true
SS_TWO_SIDED_MAX_PAIRS_PER_DAY=1
SS_TWO_SIDED_CELL_ALLOWLIST=pair_25k_5pct_otm_3d     # single cell for the test
SS_TWO_SIDED_BOOT_HALT=true                          # leave true — we clear it explicitly below
```
After redeploy, clear the boot halt:
```bash
curl --http1.1 -sS -X POST -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" -H "Content-Type: application/json" \
  "$PILOT_API_BASE/admin/foxify/v2/resume" -d '{"kind":"atticus","notes":"live test"}'
```

## 4. Fire exactly ONE pair
- Preferred: let the shadow→live path pick it when `should_activate` is green in moderate+.
- Controlled: have Foxify send one activation for the allowlisted cell (or use the
  operator activation path). Confirm only ONE pair opened:
```bash
curl --http1.1 -sS -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" "$PILOT_API_BASE/admin/foxify/v2/diagnostics" \
  | jq '{active_pairs: .active_pairs_count, halted: .halt}'
```

## 5. Monitor to close
```bash
# watch the pair lifecycle (repeat) — replace <PAIR_ID>
curl --http1.1 -sS -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" "$PILOT_API_BASE/admin/foxify/v2/pair/<PAIR_ID>" | jq '{status, exit_mode, foxify_share_usdc, hedge_cost_total_usdc}'
# after it settles, reconcile realized vs MC:
curl --http1.1 -sS -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" "$PILOT_API_BASE/admin/foxify/v2/realized-vs-mc?regime=moderate" \
  | jq '{regime_tagged_pairs, rows:[.rows[]|{cell:.cell_id,n:.realized_n,realized:.realized_mean_net_usdc,mc:.mc_predicted_net_usdc,within15:.within_15pct}]}'
```
Success = pair activates → auto-closes → realized net is sane and within ±15% of MC.

## 6. KILL SWITCH (paste anytime)
```bash
# Halt all Atticus activations immediately:
curl --http1.1 -sS -X POST -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" -H "Content-Type: application/json" \
  "$PILOT_API_BASE/admin/foxify/v2/halt" -d '{"kind":"atticus","reason":"operator_kill","notes":"manual"}'
```
Then in Render set `SS_TWO_SIDED_LIVE_ENABLED=false` (and `FOXIFY_V2_LIVE_EXECUTION=false`) and redeploy. Both gates must be false to fully disable real-money execution.

## 7. Roll back after the test
1. `SS_TWO_SIDED_LIVE_ENABLED=false`, `FOXIFY_V2_LIVE_EXECUTION=false` (redeploy).
2. Confirm no open live pairs (`/diagnostics`).
3. **Rotate `PILOT_ADMIN_TOKEN` + `FOXIFY_API_KEY`** if they were ever pasted into chat/logs.

## 8. Graduation criteria (before scaling past 1 pair)
- ≥10 moderate-regime shadow/live settlements reconciling within ±15% of MC.
- Bullish authed access confirmed (`bullish-auth-probe` ok) OR a deliberate Deribit-only decision.
- Move allowlist to the validated `pair_150k_3pct_atm_3d` and raise `SS_TWO_SIDED_MAX_PAIRS_PER_DAY` incrementally.
- Set `SS_TWO_SIDED_MAX_CAPITAL_AT_RISK_USDC` to the funded ceiling (see RENDER_ENV_REFERENCE capital table).

## Monitoring cadence (while any live pair is open)
- `/diagnostics` every few minutes: feed health, venue status, halt state, active pair count.
- `/admin/foxify/v2/shadow-auto/status` for the auto-loop decisions (if enabled).
- Alert triggers: feed `degraded`, venue `ok:false` sustained, DVOL regime change toward calm (cell should stop activating), any unexpected second activation.
