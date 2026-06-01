# Foxify Pilot — Operator Live-Test Runbook (kill switch + monitoring)

Purpose: execute **one controlled live pair** with the **lowest premium** to prove
the real-money plumbing end-to-end, then roll back. Real money only. Treat every
step as reversible — the kill switch is one curl.

> Shell prereqs: `PILOT_API_BASE`, `RENDER_ADMIN_TOKEN`, `FOXIFY_API_KEY`. All
> curls use `--http1.1`. Admin endpoints take `-H "X-Admin-Token: $RENDER_ADMIN_TOKEN"`.

---

## 0. Golden rules
- **Calm regime can never go live by default** (hard-disabled, `SS_TWO_SIDED_ALLOW_CALM=false`). A moderate+ live test requires the market to be in **moderate+**. **Exception:** the **calm loss-leader** path (`SS_TWO_SIDED_CALM_LOSS_LEADER=true`) deliberately allows budgeted calm activations ≤ `SS_TWO_SIDED_CALM_MAX_LOSS_USDC` — this is the cheapest way to run a live E2E test *right now* without waiting for a moderate window (see §1.6).
- Start with `SS_TWO_SIDED_MAX_PAIRS_PER_DAY=1` and a **single-cell allowlist**.
- Keep a second terminal open with the **kill switch** (§6) ready to paste.
- Lowest premium ≠ best EV — this is a *plumbing* proof. Graduate to the validated
  `pair_150k_3pct_atm_3d` only after the plumbing test passes.
- **VENUE REALITY (2026-06-01):** Bullish only quotes **near-ATM** strikes; the cheap **5% OTM** loss-leader cells have **no Bullish book**, so they hedge on **Deribit**. To exercise **live Bullish order placement** you must use a **near-ATM** cell (e.g. `pair_50k_3pct_atm_3d`, ~$1.3k, or a small near-ATM cell). You cannot get *both* "lowest premium" *and* "on Bullish" — pick one:
  - **Cheapest E2E (Deribit):** calm loss-leader 1d strangle (~$18) or 2d (~$52). Real plumbing, Deribit hedge.
  - **Bullish E2E (pricier):** near-ATM cell (~$1.3k at 50k, or add a small near-ATM cell for ~$200).

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

## 1.6. Drive the test with the reference bot (recommended)
The reference Foxify bot (`services/api/scripts/integration/foxifyShadowBot.ts`) IS the
production-shaped activation driver — it polls `GET /foxify/v2/should_activate` and fires
exactly what Atticus recommends (`recommended_cells` when good, or a budgeted
`calm_loss_leader` cell), then the server's TP/expiry handlers run the pair to close.
This gives you the full "as-if-Foxify" E2E loop (watch signal → activate → trigger/TP →
settle → reconcile).

**Single controlled live pair via the bot:**
```bash
export FOXIFY_API_URL="$PILOT_API_BASE"
export FOXIFY_API_KEY="$FOXIFY_API_KEY"
export SHADOW_BOT_LIVE=true            # fire is_shadow=false (REAL). Also needs server FOXIFY_V2_LIVE_EXECUTION=true (§3).
export SHADOW_BOT_PAIRS_PER_DAY=1      # ~1 attempt; combined with the server day-cap = at most 1
export SHADOW_BOT_STOP_AFTER_HOURS=1   # bot self-exits after 1h
# (default SHADOW_BOT_LOSS_LEADER=true → in calm it will fire a budgeted loss-leader cell)
npx tsx scripts/integration/foxifyShadowBot.ts
```
- **SHADOW first:** run the exact command with `SHADOW_BOT_LIVE` unset (default shadow) and confirm it fires + settles before flipping live.
- The bot logs every decision as JSON (`signal`, `ACTIVATE OK (LIVE)`, `activate skipped — stand down`, etc.).
- It NEVER fires more than the server allows — `SS_TWO_SIDED_MAX_PAIRS_PER_DAY` + the auto-loop day-cap still bound it.

## 1.7. Which cell will the bot fire? (venue + premium)
- **In calm with loss-leader on:** the bot fires `pair_25k_5otm_strangle_2d` (~$52) or, if over budget, `pair_25k_5otm_strangle_1d` (~$18). **Both hedge on Deribit** (Bullish has no OTM book). Cheapest live proof.
- **In moderate+:** the bot fires from `recommended_cells` (ATM straddle etc.) — these CAN route to Bullish if Bullish is round-trip-competitive (check `venue-probe`).
- **To force a Bullish live fill:** use a near-ATM cell and confirm via `GET /admin/foxify/v2/venue-probe?cell_id=<cell>` that `chosen_venue: "bullish"` on at least one leg BEFORE arming live.

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
