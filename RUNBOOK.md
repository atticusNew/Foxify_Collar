# RUNBOOK — FalconX Live Pilot (two weeks, up to 2 × $50k/day)

The validated shadow strategy, live at FalconX's OTC options desk. One service
(`foxify-falconx-live`, blueprint `render-falconx-live.yaml`) runs the normal 15-minute cycle;
**real executions happen only inside the 08:15–10:00 UTC window, once per day**, behind the
kill-switch. The shadow mirror (`foxify-okx-mirror`) keeps running unchanged as the model-price
benchmark — do not touch it. OKX stays wired as the fallback venue (appendix).

Product per client perp position: 24h BTC collar. Long perp = SELL call ~+2% + BUY put (floor 6%,
10% on elevated days). Short perp = mirror. Pass-through pricing: collar funds credit (~$80 target,
floats down honestly) + venue costs; Atticus nets ~0 from the trade. Every collar is hedged
back-to-back; the book stays flat.

**Why FalconX changes the risk picture:** the collar is quoted and executed as ONE RFQ structure —
both legs in a single trade with a single net price. **A naked leg from opening is structurally
impossible.** FalconX quotes are all-in (their spread is the fee), fixing on the Deribit 08:00 UTC
print — the same settlement clock as the product.

## Hard invariants (never violated, by construction)

- **Nothing trades unless `LIVE_ENABLED=true`** (master kill-switch, dashboard-managed). FalconX has
  **no demo environment** — every execute is real money, so the hook also requires
  `FALCONX_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY`.
- **Both legs execute as one structure, or nothing.** On calm-day pairs, **both collars or
  neither** — if the second structure can't execute inside the band, the first is unwound (also as
  one reverse structure).
- **No execution outside the slippage band**: the quoted net credit is checked against the model
  MID net before execute; worse than `LIVE_SLIPPAGE_BAND_PCT` (0.25) of the mid ⟹ close the RFQ,
  re-quote once, then the day is skipped. Quotes are firm for ~seconds; we execute immediately or
  not at all. **Never chase.**
- **Guardrail rejection (EV/credit/σ-floor) skips the day.** Missed window (after 10:00 UTC) skips
  the day.
- **A settlement-reconciliation mismatch halts all new issuance** until investigated and cleared.
- Caps: $50k/position, $100k/day (frozen for the pilot).

## Daily flow (automatic — what humans check)

| UTC | What happens |
|-----|--------------|
| 08:00 | Yesterday's positions expire at the Deribit fixing (FalconX's `fixing_source`). Next cycle settles them on the verified oracle and books outcomes to `/positions`. |
| 08:15–10:00 | First cycle in the window: regime gate decides (calm ⟹ pair · elevated ⟹ one trend single · halt ⟹ skip) → pricer solves strikes → strikes map to FalconX's live instrument grid (drift-checked) → qty in plain BTC → caps → RFQ quote → band check vs model mid → execute within validity → booked as venue `falconx_live` with the **real quoted net credit**. |
| after fixing | Reconciliation: our settlement vs FalconX's `settlement_price` (trade transactions) + `Settlement` cash flows, per trade_id, tolerance $5. Mismatch ⟹ CRITICAL alert + issuance halt. |

**Post-window check (~10:05 UTC):**
1. Service logs show `[live] window executed: …` (or a clean skip reason: halt regime, guardrail
   rejection, quote outside band, caps). Skips are normal, not failures.
2. `/positions` shows today's rows as `falconx_live` with a plausible net credit (quoted-vs-model
   column ≈ the $80 target on calm tape; the gap to model IS FalconX's spread — watch it).
3. No `LIVE-ALERT` lines in the logs (`falconx-live-alerts.jsonl` on the disk is the audit trail).
4. FalconX UI/positions match: one collar = two legs, correct qty.

**Post-settlement check (~08:20 UTC):**
1. Yesterday's rows moved to settled on `/positions`.
2. Logs show `recon <ref>: MATCHED`. `pending venue data` is fine for a few cycles (their trade
   transactions/cash flows can lag); `MISMATCH` is an incident (below).

## Canary (Mon/Tue — the go/no-go artifact)

One tiny real collar end-to-end before pilot size. In the `foxify-falconx-live` Render shell:

```bash
# 0) Account readiness (read-only; quotes closed, nothing executes)
npm --silent --workspace services/api run falconx:readiness

# 1) Kill-switch test: with LIVE_ENABLED unset/false, confirm the service logs
#    "live path NOT armed" and no RFQ ever fires. Then arm for the canary only:
LIVE_ENABLED=true FALCONX_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY \
LIVE_CANARY_CONTRACTS=1 \
npm --silent --workspace services/api run live:canary -- --side long
```

Go/no-go = all five: **execute** (one structure, inside band) → **ledger** (`falconx_live` row,
real quoted net) → **dashboard** (`/positions`) → **next-day settlement** (08:00 fixing) →
**reconciliation MATCHED**. Also note FalconX's `incremental_im_for_trade` on the quote — that is
their real margin number per trade; confirm it fits the deposit.

Launch: set `LIVE_ENABLED=true` (+ `FALCONX_LIVE_CONFIRM`) in the service env, remove
`LIVE_CANARY_CONTRACTS`, redeploy. The 08:15 window does the rest.

## Early close (agreed client policy)

```bash
npm --silent --workspace services/api run live:unwind -- list
FALCONX_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY \
npm --silent --workspace services/api run live:unwind -- close <ref>
```

The unwind quotes + executes the REVERSE structure (buy back the sold leg, sell the held leg) as
ONE trade — atomic, no leg-ordering hazard. Credit vests by time held (clawback of the unvested
portion); the early-close outcome books to the settlement ledger. **Fail-safe:** if the reverse
structure can't execute, nothing happens — the position stays fully hedged and rides to expiry.
Unwind is deliberately NOT blocked by the kill-switch (the switch stops new positions, never
flattening).

## Incidents

| Signal | Response |
|--------|----------|
| FalconX down / auth failing / no instruments at the window | The runner skips the day (alert logged). Do nothing. **Never chase.** Investigate before the next window. |
| Quotes repeatedly outside the band | Day skipped after one re-quote. If it persists for days, FalconX's spread vs our OKX-book model mid needs a conversation with their desk — NOT a band widening mid-pilot. |
| Execute fails with `QUOTE_EXPIRED` / `NO_VALID_EXECUTABLE_QUOTE` | Automatic: one fresh re-quote, then skip. Persistent ⟹ ask FalconX about quote validity under volatility. |
| **Pair sibling fails** (calm day) | The first collar is unwound automatically as one reverse structure (`pair_sibling_unwound` in the executions ledger). Verify on the FalconX UI. |
| **Reconciliation mismatch** | New issuance halts automatically. Compare the recon record (`falconx-live-reconciliations.jsonl`) against FalconX trade transactions + cash flows in their UI; resolve with their ops desk before re-arming. Venue-data lag clears itself (pending → matched). |
| Service crash/restart mid-window | Safe: the window is consumed before quoting, so a restart cannot double-execute. If it crashed between execute and booking, check FalconX trades vs `/positions` and reconcile by hand (trade_id is in the executions ledger). |
| Anything confusing | `LIVE_ENABLED=false`, redeploy (stops new issuance; open positions stay hedged and settle normally), investigate. |

## Two-week exit criteria

1. **Execution vs model:** every executed net credit inside the band; average quoted-vs-model gap
   (`quotedNetUsdc` − `modelNetUsdc` per position) small and stable — this is FalconX's realized
   spread, the pilot's key execution number.
2. **Credit fundability at real quotes:** realized net credit ≥ ~$60 average on calm days (the $80
   target minus honest σ-floor float-downs), never manufactured by tighter caps.
3. **Zero naked-leg incidents** (structurally guaranteed at FalconX; the executions ledger must
   still show no `pair_unwind_incomplete` alerts).
4. **Atticus net ≈ 0 ± capital cost** on the settled live cohort (`/api/scorecard` aggregate —
   the same flatness bar the shadow proved).
5. All settlements reconciled (no unresolved mismatches).

## Collateral / IA (open with the FalconX desk — updated 2026-07-18)

FalconX's desk (Oliver Sitt, Jul 17) asked for the exact structure/size to set the IA and stated
they would ask for a **prefunded, 100% collateralized position**. Where that lands drives the
funding gate and Atticus's capital line:

| IA outcome | Prefunding needed | Capital cost (12% CoC, 2 weeks) |
|---|---|---|
| Pair margined as a package (defined-risk condor max loss) | ≈ $2k/day | ≈ $9 |
| 100% of short-leg notional on directional days | ≈ $50k | ≈ $230 |
| Full day cap prefunded | ≈ $100k | ≈ $460 |

Negotiating facts (send with the structure): a **calm-day pair nets to an iron condor** — short
±2% strangle, long −6%/+6% wings — so the worst possible settlement obligation is the 4% wing
width: ≈ 4% × spot × 0.8 BTC ≈ **$2k per $100k pair**, and we are net premium receivers on every
structure. Directional (elevated) days carry one cash-settled short leg with a −10% protective
long on the other side; ask whether a far-OTM long wing (a defined-risk spread, costs a few dollars
of credit — needs product sign-off, NOT a unilateral config change) would materially cut the IA.

Single-structure stress numbers (what the short leg owes at settlement, ~$50k protection): a 5%
adverse move ≈ $1.1–1.3k · 10% ≈ $3.6–3.8k · 15% ≈ $6.1–6.3k · 20% ≈ $8.7k. **A $2k IA covers a
lone structure only to ~6.6% past the reference** — sufficient for netted-pair days, NOT for
directional single days. FRAMING with the desk: we present as PROTECTION of client perp positions
(one or two positions protected per day) — never as a volume/flow facility.

**HARD CONSTRAINT: total collateral stays at the ~$2k envelope** (the OKX-PM equivalent: ~$546 per
position ⟹ ~$1.1k for a two-position day). An OTC desk will not match exchange portfolio margin
from a standing start — the decision tree to hold the line:

1. **Pair days:** push package margining (defined-risk condor, max loss ≈ $1,984 per ~$100k) —
   $2k genuinely covers every calm day. Lead with this.
2. **Single (directional) days:** either add one cheap far-OTM long wing ~4% beyond the cap
   (defines max loss ≈ $2k; costs a few dollars of credit — PRODUCT SIGN-OFF REQUIRED, not a
   config change), or route single days to OKX (PM margin ≈ $546; path fully built,
   `LIVE_EXECUTION_VENUE=okx`). Both keep total collateral ≈ $2–3k.
3. **If FalconX's pair-day answer is also far above $2k:** run the pilot on OKX entirely and
   revisit FalconX later.

Also confirm: collateral currency (USDC?) · posted once and recycled daily vs per-trade · release
timing after the 08:00 fixing (we re-issue 15 minutes later at 08:15) · whether the net premium
owed to us offsets the IA. Until confirmed, `falconx:readiness` gates funding at the FULL day cap
($100k) and the dashboard reports capital costs at the conservative prefunded level
(`SHADOW_SHORT_OPTION_IM_FRACTION=1.0`); set `FALCONX_READINESS_MIN_BALANCE_USD` and relax the
capital inputs only after the desk's number is in writing.

## Business launch gates (tracked here, owned by the client)

- [ ] **IA agreed with FalconX + prefunding posted** (see the Collateral/IA section — this replaced
      the old $5k deposit gate and is the critical path: no collateral ⟹ no executes). Verify with
      `falconx:readiness`.
- [ ] Derivatives/options entitlement live on the account (instruments + quote checks PASS).
- [ ] Client's real per-trade fee number → `FOXIFY_PERP_FEE_USDC` (currently 0 = not modeled).
- [ ] Daily mandate confirmed: "open per signal at the window unless told otherwise."

## Config freeze (canary → pilot end)

Floor 6% / 10% elevated · credit target $80 · ceiling off · σ-floor 1.1× · gate 1.2/3.0 with 0.85
hysteresis · 2/day · $50k/position · $100k/day · band 0.25. All pinned in `render-falconx-live.yaml`
(the source of truth — no dashboard edits except the sync:false gates/secrets). Fresh
`/var/data/falconx-live-*` stores keep the live track record single-config; the mirror's stores are
untouched. Model prices stay anchored to the OKX book (`SHADOW_HEDGE_VENUE=okx`) so quoted-vs-model
is an apples-to-apples benchmark against the shadow.

---

## Appendix — OKX fallback venue

The full OKX CLOB execution path remains built, tested, and deployable (`render-okx-live.yaml`,
`LIVE_EXECUTION_VENUE=okx`): band-capped limit legs, unwind-on-partial, delivery/bills
reconciliation, `okx:readiness`. Differences to remember if falling back: two legs on screen (the
executor unwinds partials — `naked_leg_unresolved` alerts exist there), OKX portfolio-margin
approval is the critical path ($546 vs $7k per position), premiums/margin are BTC-denominated, and
real money needs `OKX_EXECUTION_MODE=live` + `OKX_LIVE_CONFIRM` (a demo environment exists for
rehearsal). Same window, caps, ledgers, dashboards, and runbook discipline.
