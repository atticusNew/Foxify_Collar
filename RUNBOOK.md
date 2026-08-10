# RUNBOOK — OKX Live Pilot (two weeks, up to 2 × $50k/day)

The validated shadow strategy, live on OKX. One service runs the normal 15-minute cycle; **real
executions happen only inside the 08:15–10:00 UTC window, once per day**, behind the kill-switch.
The shadow mirror keeps running unchanged as the model-price benchmark — do not touch it.
FalconX is the at-scale venue (appendix): integration built and live-tested; blocked for pilot
size by their ~1 BTC per-structure minimum and full-collateral terms.

Product per client perp position: 24h BTC collar. Long perp = SELL call ~+2% + BUY put (floor 6%).
Short perp = mirror. Pass-through pricing: collar funds credit (~$80 target, floats honestly with
vol — $19–$98/position observed in shadow) + venue costs; Atticus nets ~0 (−$4.68 over $1.3M
settled shadow notional, including through cap-breach givebacks). Every collar is hedged
back-to-back; the book stays flat.

## Hard invariants (never violated, by construction)

- **Nothing trades unless `LIVE_ENABLED=true`** (master kill-switch). Real money additionally
  requires `OKX_EXECUTION_MODE=live` + `OKX_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY`.
- **The partner speaks before anything opens** (`LIVE_DIRECTIONAL_DECISION=partner`, the live
  default): CALM needs the pair ACK (`confirm`), ELEVATED needs an explicit `take [--side]`/`pass`,
  STRESS is a forced pass (notice only). No decision by window close (10:00 UTC) ⟹ day skipped.
  A silent partner bot fails CLOSED — we never lock hedges against a partner who can't open perps.
- **Hedge locks FIRST, partner opens SECOND.** The green-light signal (executed terms attached) is
  emitted only after the venue fill. Nobody acts on an estimate.
- **Both legs execute or neither.** RFQ fills are atomic blocks (all legs or none, by construction).
  Book fills enforce it with the abort-unwind: one-sided/partial fills are unwound immediately.
- **All closes/unwinds are book-priced reduceOnly IOC limits** — OKX options REJECT market orders
  (live-verified by the demo canary; error "instId and ordType don't match"). Empty book ⟹ no safe
  reference ⟹ nothing is placed; the position rides fully hedged and alerts fire.
- **No execution outside the slippage band** (`LIVE_SLIPPAGE_BAND_PCT`, 0.25 of model mid, per
  leg — the same standard for RFQ quotes and book fills). **Never chase.**
- **Guardrail rejection (EV/credit/σ-floor `not_priceable`) skips the day.** Missed window skips
  the day.
- **A settlement-reconciliation mismatch halts all new issuance** until cleared.
- Caps: $50k/position, $100k/day (frozen for the pilot).

## Execution routing (RFQ-first, book fallback — "whichever is better", literally)

At the window, if the package clears OKX's $50k block minimum
(`LIVE_OKX_RFQ_MIN_NOTIONAL_USDC=50000`): the whole collar goes out as ONE anonymous block RFQ to
up to 15 makers (`LIVE_OKX_RFQ_MAX_COUNTERPARTIES` — >15 is rejected with 70107), best quote with
BOTH legs inside the band wins, executes atomically. Any SAFE non-fill (no makers, no banded quote
within `LIVE_OKX_RFQ_WAIT_MS`=15s, execute miss) falls back to band-capped order-book legs
automatically, with an alert naming why. Sub-minimum sizes (the canary) go straight to the book.
`LIVE_OKX_RFQ=false` pins the book path. Unwinds run on the book per OKX's own guidance
(sub-minimum risk-reducing closes → order book), budget-checked against real book tops.

## Partner protocol (transport-agnostic: outbox + decision store)

| Signal (we → partner outbox) | When | Their answer (decision store) |
|---|---|---|
| `day_signal` (pair · directional_proposal · no_open) | once per day at the window | `confirm` / `take [--side long\|short]` / `pass` — before 10:00 UTC |
| `green_light` (refs, strikes, credit, expiry — executed terms) | after the venue fill | they open perps immediately |
| `close_signal` (ref, line, vested credit) | on every confirmed touch — unconditional, deduped | close that perp within the SLA |

Until the partner bot integration is live, decisions are recorded via CLI:
`npx tsx scripts/creditCollarPartnerDecision.ts confirm | take --side short | pass | show`.
Signals outbox: `live-partner-signals.jsonl` · decisions: `live-partner-decisions.jsonl`
(`LIVE_PARTNER_SIGNAL_PATH` / `LIVE_PARTNER_DECISION_PATH`).

**Touch handling is decoupled (the wall):** the partner's close signal fires on every confirmed
touch regardless of our hedge economics. OUR hedge unwind is watcher-gated: it executes only when
the REAL venue cost (FalconX quote / OKX book tops) fits inside the unvested credit
(budget = model cost + headroom); over budget ⟹ deferred, the hedge rides behind its wings —
invisible to the partner. A partner perp CLOSED on the position feed ⟹ client side concludes with
vested credit (collar cancels — no payout either direction) and our now-unmirrored hedge unwinds
MANDATORILY (no budget gate; incomplete ⟹ CRITICAL).

**Position feed is REQUIRED for live** (partner bot posts open/close confirms or we poll their
positions endpoint): it drives green-light verification, voluntary-close conclusion, the close-SLA,
and the anti-gaming reconciliation. Without it we are blind on their half.

## Live setup day (rehearsed on demo, 2026-07-28/29 — in this exact order)

1. Create the trading sub-account (name is client-visible). Questionnaire answers: units =
   Contracts, Greeks = BS (dollar), all confirmations ON, click-book-input OFF, net mode.
2. **Fund $10k USDC first** (deposit to main → internal transfer to sub). $10k is OKX's documented
   minimum for BOTH portfolio margin and block/RFQ access.
3. `npm --silent --workspace services/api run okx:activate-option` on the sub-account keys —
   options activation is per-account. Codes 51199/50050 = already active = success.
4. Account mode → Portfolio Margin: `OKX_SET_ACCT_LV=4` on the same script; if 51070, do it once
   in the web UI (trade page → account panel gear → Account mode → Portfolio margin + questionnaire).
   PM is required: multi-ccy margin (level 3) BLOCKS buying options ("no net long positions under
   cross margin") — the collar's protective leg.
5. Two API keys on the sub: trading key = Read + Trade, **no Withdraw**, IP-bound to Render
   egress; partner key = **Read only**. NO API key ever gets Withdraw. Set the account withdrawal
   address allowlist to the client's return address (adds a security hold — do it setup day).
6. Render env: `LIVE_EXECUTION_VENUE=okx`, sub-account keys, `OKX_EXECUTION_MODE=demo` until the
   canary day. **Verify all stores are on the persistent disk** (a redeploy wiped gate-state
   hysteresis on 2026-07-26 — ephemeral fallback paths lose state across deploys). Reset live
   stores for a clean pilot track record.
7. Readiness: `npm --silent --workspace services/api run okx:readiness` (auth, chain, fees,
   account config). Confirm RFQ maker list is non-empty on the funded account.

## Canary (the go/no-go artifact)

One tiny real collar (1 × 0.01 BTC — sub-minimum ⟹ book path by design) through the FULL
production path:

```bash
LIVE_ENABLED=true LIVE_EXECUTION_VENUE=okx OKX_EXECUTION_MODE=live \
OKX_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY LIVE_CANARY_CONTRACTS=1 \
npm --silent --workspace services/api run live:canary -- --side long
```

Notes from the demo rehearsal: the canary respects the regime gate (HALT ⟹ refuses — correct; do
not override on live) and the partner gate (record a decision or set
`LIVE_DIRECTIONAL_DECISION=auto` for the canary only). One canary attempt per day
(`live-canary-window.json` is its own lock file).

Go/no-go = all five: **execute** (inside band) → **ledger** (`okx_live` row, real premiums) →
**dashboard** (`/positions`) → **next-day settlement** (08:00 fixing) → **reconciliation MATCHED**
(delivery-exercise history + account bills, tolerance $5). Then a **manual unwind drill** on the
canary (`live:unwind -- close <ref>`) so the exit path is proven before it's needed.

Launch: `LIVE_ENABLED=true` (+ confirm phrase) in the service env, remove `LIVE_CANARY_CONTRACTS`,
redeploy. The 08:15 window does the rest.

## Incidents

| Signal | Response |
|--------|----------|
| Skip reasons in logs (halt regime, awaiting partner decision, `not_priceable`, caps, band) | Normal, not failures. Do nothing. **Never chase.** |
| `RFQ fallback → order book (…)` alert | Normal routing. Persistent no-quotes for days ⟹ ask the BD about maker coverage; the book carries the pilot meanwhile. |
| `ONE-SIDED/PARTIAL FILL … unwinding all fills` | Automatic abort-unwind (IOC closes). Verify the executions ledger shows the closes; check venue positions flat. |
| `naked_leg_unresolved` / `watcher_unwind_incomplete` / `partner_close_unwind_incomplete` (CRITICAL) | Manual: read `detail.unwind.notes` in the executions ledger (exact venue rejection), close the leg by hand (reduceOnly IOC limit priced off the book — never market), investigate before the next window. Rehearsed 2026-07-29 on demo. |
| `EMPTY BOOK — no safe IOC reference` | Nothing was placed (deliberate). Position rides fully hedged. Close manually when the book returns. |
| Partner missed a close signal (SLA breach) | Gap past the line is theirs (gap accountability books it); the anti-gaming detectors flag repeated/selective misses. |
| Reconciliation MISMATCH | Issuance halts automatically. Compare the recon record against OKX delivery history + bills; clear with a matched re-run before re-arming. `pending venue data` for a few cycles is normal lag. |
| Service crash/restart mid-window | Safe: the window is consumed before execution; restarts cannot double-execute. If crashed between fill and booking: reconcile OKX trade history vs `/positions` by hand. |
| Anything confusing | `LIVE_ENABLED=false`, redeploy (stops new issuance; open positions stay hedged and settle normally), investigate. |

## Two-week exit criteria

1. **Execution vs model:** fills inside the band; RFQ improvement over screen tracked per maker
   (the number that picks the bilateral-terms partner at scale).
2. **Credit fundability at real fills:** honest σ-floor float-downs, never manufactured by tighter
   caps.
3. **Zero unresolved naked-leg incidents** (abort-unwinds may fire; they must complete or escalate
   and get resolved).
4. **Atticus net ≈ 0 ± capital cost** on the settled live cohort (the flatness bar the shadow
   proved through real givebacks).
5. All settlements reconciled; partner decisions/signals ledger complete (every open preceded by a
   decision, every touch signaled once).

## Config freeze (canary → pilot end)

Floor 6% (calm AND elevated — aligned to client docs 2026-07-22) · credit target $80 · σ-floor
1.1× · grid $250 · gate 1.2/3.0 with 0.85 hysteresis · pairs calm-only, pair-atomic ·
`LIVE_DIRECTIONAL_DECISION=partner` · 2/day · $50k/position · $100k/day · band 0.25 ·
RFQ ≥ $50k, ≤15 counterparties, 15s wait. Shadow-only dials (not live):
`SHADOW_DIRECTIONAL_PARTICIPATION=0.33`, lock-watcher `SHADOW_LOCK_*`.

## Demo-phase catches (2026-07-28/29 — why the ladder exists)

1. RFQ create rejected addressing >15 counterparties (70107) → capped.
2. Options activation is per-account and blocks all orders until run (51198 family).
3. "Already activated" (50050) false-failed the setup script → treated as success.
4. Multi-ccy margin blocks buying options → PM (level 4) is a hard setup requirement.
5. **OKX options reject market orders** → every close path rewritten to book-priced IOC limits.

## Business launch gates (owned by the client relationship)

- [ ] $10k USDC funded to the sub-account (venue-documented minimum for PM + RFQ).
- [ ] Partner bot: signals transport chosen (poll/webhook), endpoint + auth exchanged.
- [ ] **Partner position feed** (or bot open/close confirms) — required, no workaround.
- [ ] Client's real per-trade fee → `FOXIFY_PERP_FEE_USDC` (currently 0 = not modeled).
- [ ] OKX BD: linear (USDC-settled) vs inverse book for our dailies · named tech contact.
- [ ] Close-signal SLA number agreed with the partner.

---

## Appendix — FalconX (at-scale venue; integration live-tested 2026-07-26/27)

Full RFQ integration built and verified against their production API: auth, entitlement,
instrument mapping, RFQ round-trip all work. Blocked for pilot size by (a) ~1 BTC per-structure
minimum (0.78 BTC clips return MIN_NOTIONAL_PER_TRADE_EXCEEDS_LIMIT; ≥1.07 BTC passes the size
gate) and (b) quoting gated on a funded account (QUOTE_UNAVAILABLE unfunded) with full-collateral
terms (~$40k+/structure vs OKX PM ~$2k). Revisit at $1M+/day when clips clear their minimum
naturally; the at-scale asks, in order: package margining at max loss (~$2k/structure) ·
minimum-exempt risk-reducing unwinds · committed quoting spreads on the daily program ·
pre-agreed (intrinsic+fee) unwind schedule — the term an exchange structurally cannot offer.
Venue switch is one env change: `LIVE_EXECUTION_VENUE=falconx` + `FALCONX_LIVE_CONFIRM` (no demo
environment — every execute is real money). Their unwind executes the reverse structure as ONE
trade and honors the watcher budget via the quoted cost check.
