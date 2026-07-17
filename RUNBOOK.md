# RUNBOOK — OKX Live Pilot (two weeks, up to 2 × $50k/day)

The validated shadow strategy, live on OKX. One service (`foxify-okx-live`, blueprint
`render-okx-live.yaml`) runs the normal 15-minute cycle; **real orders happen only inside the
08:15–10:00 UTC window, once per day**, behind the kill-switch. The shadow mirror
(`foxify-okx-mirror`) keeps running unchanged as the model-price benchmark — do not touch it.

Product per client perp position: 24h BTC collar. Long perp = SELL call ~+2% + BUY put (floor 6%,
10% on elevated days). Short perp = mirror. Pass-through pricing: collar funds credit (~$80 target,
floats down honestly) + venue fees; Atticus nets ~0 from the trade. Every collar is hedged
back-to-back; the book stays flat.

## Hard invariants (never violated, by construction)

- **Nothing trades unless `LIVE_ENABLED=true`** (master kill-switch, dashboard-managed). Real money
  additionally requires `OKX_EXECUTION_MODE=live` + `OKX_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY`.
- **Both legs of a collar fill or neither stands** (partials are unwound in full). On calm-day
  pairs, **both collars or neither** (a failed sibling unwinds the filled one).
- **Fills cannot exceed the slippage band** — limit prices are capped at model-mid × (1 ± band)
  (`LIVE_SLIPPAGE_BAND_PCT`, 0.25). If the touch is outside the band, the order rests, times out,
  retries once, then the day is skipped.
- **Guardrail rejection (EV/credit/σ-floor) skips the day.** Missed window (after 10:00 UTC) skips
  the day. We never chase.
- **A settlement-reconciliation mismatch halts all new issuance** until investigated and cleared.
- Caps: $50k/position, $100k/day (env-tunable; frozen for the pilot).

## Daily flow (automatic — what humans check)

Everything below happens without intervention. The human job is a 5-minute check after the window
and after settlement.

| UTC | What happens |
|-----|--------------|
| 08:00 | Yesterday's positions expire at the OKX daily fixing. Next cycle settles them on the verified oracle and books outcomes to `/positions`. |
| 08:15–10:00 | First cycle in the window: regime gate decides (calm ⟹ pair · elevated ⟹ one trend single · halt ⟹ skip) → pricer solves strikes → strikes map to listed instruments (drift-checked) → contracts rounded to 0.01 BTC lots → caps checked → both legs placed as band-capped limits → fills booked as venue `okx_live` with **real** premiums/fees. |
| after fixing | Reconciliation: our settlement vs OKX's delivery price + account bills, per position, tolerance $5. Mismatch ⟹ CRITICAL alert + issuance halt. |

**Post-window check (~10:05 UTC):**
1. Service logs show `[okx-live] window executed: …` (or a clean skip reason: halt regime,
   guardrail rejection, band timeout, caps). Skips are normal, not failures.
2. `/positions` shows today's rows as `okx_live` with plausible premiums (SOLD − PAID − fee = net
   credit, roughly the $80 target on calm tape).
3. No `LIVE-ALERT` lines in the logs (`live-alerts.jsonl` on the disk is the audit trail).
4. OKX web UI position tab matches: 2 legs per collar, sizes equal.

**Post-settlement check (~08:20 UTC):**
1. Yesterday's rows moved to settled on `/positions`.
2. Logs show `recon <ref>: MATCHED` for each. `pending venue data` is fine for a cycle or two
   (bills lag); `MISMATCH` is an incident (below).

## Canary (Mon/Tue — the go/no-go artifact)

One tiny real collar end-to-end before pilot size. In the `foxify-okx-live` Render shell:

```bash
# 0) Account readiness (read-only): PM mode, key scope, funding, chain, books
npm --silent --workspace services/api run okx:readiness

# 1) Kill-switch test: with LIVE_ENABLED unset/false, confirm the service logs
#    "live path stays OFF" and no orders ever appear. Then arm for the canary only:
LIVE_ENABLED=true OKX_EXECUTION_MODE=live OKX_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY \
LIVE_CANARY_CONTRACTS=1 \
npm --silent --workspace services/api run okx:live-canary
```

Go/no-go = all five: **fill** (both legs, inside band) → **ledger** (`okx_live` row, real
premiums/fees) → **dashboard** (`/positions`) → **next-day settlement** (08:00 fixing) →
**reconciliation MATCHED**. Also note the margin currency OKX charges on the fill (BTC vs
multi-ccy) and the actual IM — confirm PM netting is in effect (~$550/position scale, not ~$7k).

Wednesday launch: set `LIVE_ENABLED=true` (+ live-money gates) in the service env, remove
`LIVE_CANARY_CONTRACTS`, redeploy. The 08:15 window does the rest.

## Early close (agreed client policy)

```bash
npm --silent --workspace services/api run okx:unwind -- list
OKX_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY \
npm --silent --workspace services/api run okx:unwind -- close <ref>
```

Order of operations (automatic): buy back the SHORT leg first → sell the long leg → verify flat via
the venue → vest the credit by time held (clawback of the unvested portion) → book the early-close
outcome to the settlement ledger. **Fail-safe:** if the short-leg buy-back can't execute, nothing is
touched — the position stays fully hedged and rides to expiry. A long-leg residue is bounded risk
(premium already paid) and is alerted for manual completion. Unwind is deliberately NOT blocked by
the kill-switch (the switch stops new positions, never flattening).

## Incidents

| Signal | Response |
|--------|----------|
| Venue down / auth failing / chain missing at the window | The runner already skips the day (alert logged). Do nothing. **Never chase.** Investigate before the next window. |
| Fills timing out repeatedly (band never touched) | Same — day skipped after one retry. If it repeats for days, the band vs OKX daily-option spreads needs review at the NEXT config window, not mid-pilot. |
| **One-sided fill** | The executor flattens automatically (`ONE-SIDED/PARTIAL FILL` alert, `aborted_unwound`). Verify flat on the OKX UI. If the alert says `naked_leg_unresolved`/`CRITICAL`: flatten MANUALLY on OKX immediately (buy back the short leg first), then reconcile the executions ledger. |
| **Reconciliation mismatch** | New issuance halts automatically. Compare the recon record (`live-reconciliations.jsonl`) against OKX bills in the UI. If venue data was just late, the next cycle re-reconciles and clears the halt; if real, resolve with OKX support before re-arming. |
| Service crash/restart mid-window | Safe: the window is consumed before orders are placed, so a restart cannot double-execute. If it crashed between fill and booking, check the OKX UI vs `/positions` and reconcile by hand. |
| Anything confusing | `LIVE_ENABLED=false`, redeploy (stops new issuance; open positions stay hedged and settle normally), investigate. |

## Two-week exit criteria

1. **Execution slippage vs model:** per-leg fill-vs-mid inside the band on every fill; average net
   credit within ~$10 of the model solve (`quotedNetUsdc` vs `modelNetUsdc` on each position).
2. **Credit fundability at real fills:** realized net credit ≥ ~$60 average on calm days (the $80
   target minus honest σ-floor float-downs), never manufactured by tighter caps.
3. **Zero naked-leg incidents** (no `naked_leg_unresolved` in the executions ledger).
4. **Atticus net ≈ 0 ± capital cost** on the settled live cohort (`/api/scorecard` aggregate —
   same flatness bar the shadow already proved).
5. All settlements reconciled (no unresolved mismatches).

## Business launch gates (tracked here, owned by the client)

- [ ] Client's real per-trade fee number → set `FOXIFY_PERP_FEE_USDC` (currently 0 = not modeled;
      `?fee=` URL param models ad hoc).
- [ ] Client's $5k deposit arrangements confirmed.
- [ ] Daily mandate confirmed: "open per signal at the window unless told otherwise."

## Config freeze (canary → pilot end)

Floor 6% / 10% elevated · credit target $80 · ceiling off · σ-floor 1.1× · gate 1.2/3.0 with 0.85
hysteresis · 2/day · $50k/position · $100k/day · band 0.25. All pinned in `render-okx-live.yaml`
(the source of truth — no dashboard edits except the sync:false gates/secrets). Fresh
`/var/data/okx-live-*` stores keep the live track record single-config; the mirror's stores are
untouched.
