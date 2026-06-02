# Foxify Pilot — Operator Live-Test Runbook (kill switch + monitoring)

Purpose: execute **one controlled live pair** with the **lowest premium** to prove
the real-money plumbing end-to-end, then roll back. Real money only. Treat every
step as reversible — the kill switch is one curl.

> Shell prereqs: `PILOT_API_BASE`, `RENDER_ADMIN_TOKEN`, `FOXIFY_API_KEY`. All
> curls use `--http1.1`. Admin endpoints take `-H "X-Admin-Token: $RENDER_ADMIN_TOKEN"`.

---

## Safety rails (ENFORCED as of 2026-06-01)
The live path now has hard rails in `handleActivate` (only active when `FOXIFY_V2_LIVE_EXECUTION=true`):
- **`SS_TWO_SIDED_LIVE_ENABLED=true` is required** for any non-shadow activation (else `503 live_flag_disabled`).
- **`SS_TWO_SIDED_CELL_ALLOWLIST` is enforced** — only listed cells fire live (else `503 cell_not_in_allowlist`).
- **`SS_TWO_SIDED_MAX_PAIRS_PER_DAY` is a hard cap** on real pairs/day (else `503 daily_cap_reached`).
- **`is_shadow=true` can never place real orders** — it's force-routed to the shadow executor even when live execution is wired.

So a single-pair live test is bounded by config, not just discipline. (Boot halt + DVOL/newborn guardrails still apply on top.)

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

## 1.8. The two cheapest live tests (copy-paste recipes)

> Both fire EXACTLY ONE real pair, then you revert. The kill switch (§6) works at any point.
> `SS_TWO_SIDED_CELL_ALLOWLIST` is the LIVE cell gate — **CSV, no quotes/brackets** (e.g.
> `pair_a,pair_b`). The jq `[...]` you see in responses is display only.

### A) Deribit cheap test (~$18, simplest — uses the calm loss-leader path)
The 1d loss-leader is in the calm allowlist + under the $55 budget, so calm loss-leader
mode admits it — **no blanket calm-allow needed**.
```
# Render env:
SS_TWO_SIDED_LIVE_ENABLED=true
FOXIFY_V2_LIVE_EXECUTION=true
SS_TWO_SIDED_CALM_LOSS_LEADER=true            # already on
SS_TWO_SIDED_CALM_MAX_LOSS_USDC=55            # already set
SS_TWO_SIDED_CELL_ALLOWLIST=pair_25k_5otm_strangle_1d
SS_TWO_SIDED_MAX_PAIRS_PER_DAY=1
```
Redeploy → clear boot halt (§3 resume curl) → fire ONE pair via the bot:
```bash
export FOXIFY_API_URL="$PILOT_API_BASE" FOXIFY_API_KEY="$FOXIFY_API_KEY"
export SHADOW_BOT_LIVE=true SHADOW_BOT_PAIRS_PER_DAY=1 SHADOW_BOT_STOP_AFTER_HOURS=2
npx tsx scripts/integration/foxifyShadowBot.ts
# It reads should_activate → calm_loss_leader → fires pair_25k_5otm_strangle_1d on DERIBIT.
```

### B) Bullish smoke test (~$100, proves live BULLISH order placement)
Uses the dedicated near-ATM cell `pair_5k_atm_1d_smoke`. Bullish only quotes near-ATM, and
is ~2–7% wider round-trip than Deribit there, so you must (1) allow calm (the smoke cell's
~$100 premium exceeds the $55 loss-leader budget, so it can't go through the loss-leader
path), (2) widen the partner band so Bullish wins, (3) confirm routing first.
```
# Render env:
SS_TWO_SIDED_LIVE_ENABLED=true
FOXIFY_V2_LIVE_EXECUTION=true
SS_TWO_SIDED_ALLOW_CALM=true                  # blanket calm allow FOR THE TEST ONLY (no budget cap)
SS_TWO_SIDED_CELL_ALLOWLIST=pair_5k_atm_1d_smoke
SS_TWO_SIDED_MAX_PAIRS_PER_DAY=1
SS_VENUE_PARTNER=bullish
SS_VENUE_PARTNER_MAX_SPREAD_PCT=0.08          # let Bullish win round-trip at ATM
```
Add the smoke cell to the calm DB allowlist (so the regime check passes), redeploy, resume halt, then **confirm Bullish routing BEFORE firing**:
```bash
# allow the smoke cell in calm:
curl --http1.1 -sS -X POST -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" -H "Content-Type: application/json" \
  "$PILOT_API_BASE/admin/foxify/v2/cell-allowlist" \
  -d '{"regime":"calm","cell_id":"pair_5k_atm_1d_smoke","enabled":true,"reason":"bullish smoke test"}'

# MUST show chosen_venue:"bullish" on at least one leg before you arm:
curl --http1.1 -sS -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" \
  "$PILOT_API_BASE/admin/foxify/v2/venue-probe?cell_id=pair_5k_atm_1d_smoke" \
  | jq '[.legs[]|{leg,chosen_venue,bullish:[.candidates[]|select(.venue=="bullish")][0]}]'

# fire ONE pair:
export FOXIFY_API_URL="$PILOT_API_BASE" FOXIFY_API_KEY="$FOXIFY_API_KEY"
export SHADOW_BOT_LIVE=true SHADOW_BOT_PAIRS_PER_DAY=1 SHADOW_BOT_STOP_AFTER_HOURS=2 SHADOW_BOT_LOSS_LEADER=false
npx tsx scripts/integration/foxifyShadowBot.ts
```
**Revert after:** remove `SS_TWO_SIDED_ALLOW_CALM`, set `SS_TWO_SIDED_LIVE_ENABLED=false` +
`FOXIFY_V2_LIVE_EXECUTION=false`, disable the smoke cell override, redeploy. If `venue-probe`
does NOT show `bullish`, widen `SS_VENUE_PARTNER_MAX_SPREAD_PCT` until it does (or abort —
don't fire a Bullish test that routes to Deribit).

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

## 9. Closing a live pair + reconciling an OUT-OF-BAND (manual venue) close

There are two ways a live pair's legs get sold, and they need **different** tools:

| Situation | Legs still held by us? | Tool |
|-----------|------------------------|------|
| In-system close (let the engine sell) | yes | `POST /foxify/v2/close` (active) or `respawn-close` (stuck unwinding) |
| You closed the legs **directly on the venue** (Bullish/Deribit UI/API) | **no** | `POST /admin/foxify/v2/reconcile-settle` |

⚠️ **Do NOT use `respawn-close` after closing on the venue.** It re-drives the
force-close runtime, which will try to **re-sell legs you no longer hold** (a
real order against a flat position — risks opening a short). Use
`reconcile-settle`, which records the realized proceeds and settles with **zero
orders**.

### 9.1 Find pairs that need reconciling
```bash
# Lists non-terminal pairs; likely_out_of_band=true ⇒ closed on-venue, not synced.
curl --http1.1 -sS -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" \
  "$PILOT_API_BASE/admin/foxify/v2/stuck-pairs" \
  | jq '{total_non_terminal, likely_out_of_band_count, pairs}'
```

### 9.2 Reconcile-settle from the REAL venue proceeds (no orders placed)
Use the actual USDC you received per leg from the venue fills. Per-leg is best
(it also writes each leg's sell record); a single total also works.
```bash
# Per-leg (preferred):
curl --http1.1 -sS -X POST -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" -H "Content-Type: application/json" \
  "$PILOT_API_BASE/admin/foxify/v2/reconcile-settle" \
  -d '{"pair_id":"<PAIR_ID>","put_proceeds_usdc":<PUT_USDC>,"call_proceeds_usdc":<CALL_USDC>,"note":"closed both legs on Deribit UI"}' | jq .

# OR a single total if you only know the combined salvage:
curl --http1.1 -sS -X POST -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" -H "Content-Type: application/json" \
  "$PILOT_API_BASE/admin/foxify/v2/reconcile-settle" \
  -d '{"pair_id":"<PAIR_ID>","salvage_proceeds_usdc":<TOTAL_USDC>,"note":"manual venue close"}' | jq .
```

**MTM-settled venues (Bullish).** Bullish settles options **hourly** (Settlement
History tab), so there is no single sale price — only a net P&L (sum of the
Settled P&L column for both legs). Pass `net_pnl_usdc` instead; salvage is derived
as cost + net P&L:
```bash
curl --http1.1 -sS -X POST -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" -H "Content-Type: application/json" \
  "$PILOT_API_BASE/admin/foxify/v2/reconcile-settle" \
  -d '{"pair_id":"<PAIR_ID>","net_pnl_usdc":<NET_PNL>,"note":"bullish hourly settled P&L"}' | jq .
```

**Correcting the recorded cost.** If the venue filled a different size than we
recorded (e.g. Deribit floors to the 0.1-BTC step, so a 0.35 cell trades 0.3),
add `hedge_cost_override_usdc` with the TRUE gross premium paid — it becomes the
cost basis for the split and is persisted (original kept in metadata):
`-d '{"pair_id":"...","put_proceeds_usdc":...,"call_proceeds_usdc":...,"hedge_cost_override_usdc":<TRUE_FILL_USDC>}'`.
Response shows `status:"settled"`, `stepped_from`, `salvage_proceeds_usdc`,
`uplift_usdc`, `foxify_share_usdc`, `atticus_share_usdc`, `outcome`. The pair is
now terminal and drops out of `bootResurrect` (so a redeploy won't touch it).
`deliver_webhook:true` is opt-in (default off — don't notify Foxify for a test).

### 9.3 See the live (real-money) E2E balance
The loss-leader scorecard is **shadow-only** — live pairs never appear there.
Use `live-pnl` for real-money P&L (includes reconciled pairs, flagged `reconciled:true`):
```bash
curl --http1.1 -sS -H "X-Admin-Token: $RENDER_ADMIN_TOKEN" \
  "$PILOT_API_BASE/admin/foxify/v2/live-pnl" \
  | jq '{overall, pairs:[.pairs[]|{id:.pair_id_short,cell:.cell_id,cost:.hedge_cost_total_usdc,salvage:.salvage_proceeds_usdc,net:.foxify_net_usdc,reconciled,exit_mode}]}'
```

## Monitoring cadence (while any live pair is open)
- `/diagnostics` every few minutes: feed health, venue status, halt state, active pair count.
- `/admin/foxify/v2/shadow-auto/status` for the auto-loop decisions (if enabled).
- Alert triggers: feed `degraded`, venue `ok:false` sustained, DVOL regime change toward calm (cell should stop activating), any unexpected second activation.
