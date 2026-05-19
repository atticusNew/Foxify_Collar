# Retail Platform Spec — Atticus Bitcoin Protection (Foxify Pilot)

> **Status:** ready-to-execute spec. No implementation in this doc — it defines what
> production-ready retail looks like and the gates to get there.
> **Scope:** Retail B2C protection sold via the Foxify widget. Treasury platform
> is specified separately at `docs/platforms/treasury_platform_spec.md`.
> **Last updated:** 2026-05-06

---

## 1. Product definition

A 14-day **Bitcoin price-floor subscription**. The trader picks a floor (2/3/5/10%
below their entry) and a direction (LONG/SHORT). The platform charges a fixed
**per-day rate** while the protection is open and pays a one-time fixed payout
if the price crosses the floor.

| Property | Value |
|---|---|
| Tenor | 14-day maximum, daily subscription |
| Floor tiers | 2%, 3%, 5%, 10% |
| Direction | LONG (downside) and SHORT (upside) |
| Daily rate | Locked at activation; flat across volatility regimes |
| Settlement | Instant on trigger (T+0 via Deribit unwind) |
| Min charge | 1 day (rounded up) |
| Max charge | 14 days × rate × notional/$1k |
| Refund on early close | None |
| Auto-renew | Off by default; opt-in checkbox |
| Payout per trigger | One-time, equal to floor% × notional |
| Position size | $1k–$50k (capped per-position; per-tier daily concentration cap separately) |

The defining principle: **predictability for the trader, time-value capture for
the platform.** The trader sees a single rate at quote time and is charged only
for days held; the platform owns a 14-day option behind every protection and
captures the residual time-value when the protection closes (naturally, by trigger,
or by user action).

---

## 2. Pricing

### 2.1 Ship rates (flat across regimes)

| Floor | $/day per $1k notional | $10k example, full 14d |
|---|---|---|
| 2% | $2.50 | $35/day, max $350 |
| 3% | $2.50 | $35/day, max $350 |
| 5% | $2.00 | $20/day, max $280 |
| 10% | $1.50 | $15/day, max $210 |

Source: `services/api/src/pilot/biweeklyPricing.ts:75-81`. Tunable at runtime
via `PILOT_BIWEEKLY_RATE_<N>PCT` env vars; one-line code revert to the D3
regime-stepped table at `getBiweeklyRatePerDayPer1k`.

**Why flat:** the calm-regime row of the D3 model. Margin compresses to ~20% in
stress (per D3 §3) but the simplicity of one rate per tier dominates the UX
benefit through the pilot. Re-introduce regime stepping after we have ≥10 trades
across ≥2 regimes.

### 2.2 Trader-facing copy (canonical)

> "Protect your $X position against an N% drop. Pay $Y/day. Coverage runs up to
> 14 days. If BTC moves through your floor, you get a one-time payout of $Z and
> protection ends. Close anytime; you'll be billed for days held."

No mention of regime, hedging, or platform mechanics. Predictability is the UX
contract.

### 2.3 Decision: 3-day minimum bill floor

**Status: deferred.** Ship at 1-day minimum. Watch average days held in the
first 5 trades (instrumented per §8). Decision criteria for adding the 3-day
minimum:

| Observation | Action |
|---|---|
| Avg days held ≥ 5 across first 5 trades | Hold at 1-day minimum |
| Avg days held 3–5 | Re-evaluate after 10 trades |
| Avg days held < 3 across first 5 trades | Ship 3-day minimum bill in next deploy |

Rationale: the 3-day minimum solves an adverse-selection edge case (trader opens
before vol, closes 4h later, paid 1 day on $250 of locked hedge cost). If real
behavior puts average hold above 4 days, the floor is unnecessary friction.

---

## 3. Hedging strategy

### 3.1 Current path (per-protection dedicated hedge)

Activation buys a 14-day Deribit option per protection:

| Direction | Hedge instrument | Strike rule | Quantity |
|---|---|---|---|
| LONG | BTC put | At trigger price (ATM-at-trigger), ITM-preferred for floor ≤ 2.5% | notional / spot |
| SHORT | BTC call | At trigger price, ITM-preferred for floor ≤ 2.5% | notional / spot |

Source: `services/api/src/pilot/biweeklyActivate.ts:195-243`,
`services/api/src/pilot/venue.ts:706-832`.

**Strike-band cascade:** ±0.5% → ±1% → ±2% from target. Cost score:
`ask + strikeDist × coef − itmBonus + capPenalty`. ITM bonus 0.010 / dist coef
0.3 for 2% tier; 0.005 / 0.5 for 2.5% tier.

**Tenor drift:** ±4 days from 14d target, accounting for Deribit's 7-day weekly
expiry grid. Asymmetric 3× penalty currently applied to "expiry below target"
on 1-day product is muted at biweekly tenor (theta near-linear at this horizon)
— may be made symmetric in future tuning.

### 3.2 Hedge inventory pooling (post-launch optimization)

When a protection closes (trigger or natural expiry) the platform may still own
a Deribit put/call with remaining tenor and time-value. **Today these are sold
to TP recovery; future state allocates them as hedges for incoming protections.**

Mechanic:
- New protection arrives at strike S, tier T, direction D.
- Inventory query: any open hedges with strike within ±0.5% of S, remaining
  tenor ≥ requested coverage, same direction-side instrument (put/call), in
  inventory pool.
- If matched: allocate inventory unit; mark "spoken for"; charge trader full
  subscription rate; skip new Deribit buy.
- If unmatched: fall through to current path (§3.1).

**Variant — floor laddering:** an inventory put with strike S₁ also satisfies a
new request with strike S₂ < S₁ (deeper floor). Same allocator, relaxed strike
constraint.

**Estimated capital efficiency:** 25–40% reduction in fresh-hedge buys at
3+ concurrent positions with overlapping floors; combined with floor laddering,
35–50% reduction. Source: portfolio simulation against Phase 0 D2 cohort.

**Implementation gate:** a separate spec (`docs/platforms/hedge_pooling_design.md`)
will define the allocator module, persistence schema, edge cases, and rollback.
**Pooling activation is gated on ≥10 successful biweekly trades on the dedicated
path** so we have a baseline to measure the gain against.

### 3.3 What we explicitly do NOT do (yet)

| Technique | Why not now | When to revisit |
|---|---|---|
| Net-delta book hedging | Wrong scale (3 concurrent vs needed 20+); failure mode is portfolio-insurance-1987 if undersized | At ≥20 concurrent positions with mixed direction |
| Multi-venue execution | Deribit liquidity confirmed sufficient for biweekly tenor (D1: 3.3% spread); Falcon X stays adapter-ready as backstop | Stage 1 (read-only Falcon X price feeds) post-pilot; Stage 2 (active routing) at $1M+/day notional |
| Calendar-spread rolls on retail hedges | Adds operational complexity for marginal gain at retail size | Treasury-platform technique; not retail |

---

## 4. Take-profit / hedge management

The TP machinery in `services/api/src/pilot/hedgeManager.ts` is biweekly-aware
through tenor scaling: cooling ∝ √T, prime window linear in T, near-expiry
salvage capped at 24h. Three retail-specific tunings:

### 4.1 Threshold tuning for biweekly

| Lever | 1-day product | Biweekly (proposed) | Rationale |
|---|---|---|---|
| Prime threshold multiplier | 0.25× payout | **0.20× payout** | Time-value at trigger ≫ payout under 14d; 20% still captures clear profit earlier |
| Late threshold multiplier | 0.10× payout | **0.08× payout** | Late-window exits sturdy under 14d |
| Bounce recovery min value | $5 | **$5 (hold)** | R1 confirmed indistinguishable on n=9 |
| Near-expiry salvage hours | min(T, 4) × 6h | **24h cap (current)** | Correct |
| `noBidBackstop` | enabled | **disabled (current)** | Correct — backstop was 1-day-product workaround |

Tuning lands as env-driven where available; small `hedgeManager.ts` patch where not.

### 4.2 Gap rules

| Rule | Trigger | Action | State on retail biweekly |
|---|---|---|---|
| Gap 1 (vol-spike) | Adverse move ≥3% in <2h, option ≥$50 | Force exit | **Observe** through trade #5; flip to enforce thereafter |
| Gap 3 (sustained drop, LONG only) | Spot down ≥5% in 24h | Halve cooling | **Observe** — under biweekly we likely want to *invert* (extend cooling on sustained drop, hold deep ITM put through). Decision after first deep-drop trade. |
| Gap 5 (SHORT) | 5a graze < 0.3% past trigger / 5b clear-breakout ≥1% | 5a fast exit / 5b extend cooling 1.5× | **Enforce (current)**, validation gated on ≥5 SHORT triggers |

### 4.3 Retained-for-platform branch

When a biweekly trigger fires, the protection closes for the user but the hedge
stays open under `hedge_retained_for_platform=true`. Hedge manager extends prime
window 1.5×. Source: `hedgeManager.ts:811-822`. **Hold setting; revisit after
n=5 retained-for-platform unwinds.**

---

## 5. Risk controls

| Control | Setting | Source | Action |
|---|---|---|---|
| Per-tier daily concentration cap | 60% of daily new-protection notional | CFO §5 lever 2 | Port from legacy 1-day verbatim |
| Hedge budget cap | Day-aware schedule; `[{day:7, $1500}, {day:21, $8000}, {null, null}]` for biweekly | `hedgeBudgetCap.ts` + handoff §7 | Override JSON in Render env at flag flip |
| Circuit breaker | 70% drop / 24h, enforce on, 4h cooldown | `circuitBreaker.ts:50-55` | Hold |
| 1-trade-per-24h guard | Enforced | `biweeklyActivate.ts:495-508` | Hold through trade #5; relax to 3-trade after 5 clean |
| Per-position max | $50k | Existing pilot config | Hold |
| Aggregate active cap | $200k | Existing pilot config | Lift to $500k once 5-trade test passes |

---

## 6. Capital model

Three milestones, each unlocks the next phase. Numbers from Phase 0 D4 with
1.30× operational headroom and recovery compounding. **Recovery compounding
is the single most important variable** — D2 showed 159% mean recovery on
biweekly hedges; in calm regimes triggered-trade settlement flows back into
the working capital within 4 days, dampening the static numbers below.

| Milestone | Working capital | Concurrent trades | Phase |
|---|---|---|---|
| **Smoke test** | $1.5k Deribit | 1 | Validate live biweekly path |
| **Beta** | $5–7.5k Deribit + reserve | 3 | Phase 2: relax 24h guard, run 5-trade validation |
| **Pilot scale** | $20–40k working | 5–8 | Foxify retail rollout |
| **Production** | $150–300k working | 15+ | $1M+/day notional |

For an investor, the readable framing: **the platform's per-trade hedge cost is
its primary capital ask. Recovered hedge proceeds compound. At pilot scale, $40k
of working capital supports a steady-state 5–8 concurrent biweekly positions
across all market regimes; growth is funded by gross spread + recovery flow.**

---

## 7. Ops / API surface

### 7.1 Endpoints (existing, locked for retail)

| Endpoint | Purpose |
|---|---|
| `POST /pilot/biweekly/quote` | Quote — returns per-day rate, max charge, hedge cost preview |
| `POST /pilot/biweekly/activate` | Activate — books hedge, persists protection |
| `POST /pilot/biweekly/:id/close` | Trader-initiated close |
| `GET /pilot/biweekly/:id` | Status |
| `GET /pilot/admin/...` | Admin diagnostics, triggered tab, hedge inventory |

### 7.2 Background workers

| Worker | Cadence | Purpose |
|---|---|---|
| Trigger monitor | 3s polling | Detect floor cross, mark triggered, fire payout |
| Hedge manager | 60s | TP decision tree per §4 |
| Auto-renew | Hourly | Renewal eligibility (off by default per-trader) |
| Circuit breaker watch | 60s | Equity-drop trip detection |
| Daily snapshot | Midnight UTC | Aggregate metrics into `pilot_execution_quality_daily` |

---

## 8. Instrumentation requirements

For pilot validation, the following must be tracked from biweekly day 1 (some
already exist; the new ones listed need a small PR before flag flip):

| Metric | Source | New? |
|---|---|---|
| Days held at close | `biweeklyClose.ts` close event | **NEW — small PR pre-flag-flip** |
| Close reason taxonomy | trader / trigger / natural-expiry | **NEW — small PR pre-flag-flip** |
| Avg slippage USD | `pilot_execution_quality_daily.avg_slippage_usd` | Existing |
| Avg strike-floor gap | `pilot_execution_quality_daily.avg_strike_gap_usd` | Existing |
| TP recovery ratio (per-direction) | Triggered tab admin endpoint | Existing |
| Tier mix concentration | Daily snapshot | Existing |
| Hedge budget cap utilization | `hedgeBudgetCap.ts` ledger | Existing |
| Inventory match rate (post §3.2) | `hedgeAllocator.ts` (future) | Future |

The "days held + close reason" PR is the single instrumentation gap. Estimated
~30 lines: extend the close path to record `days_held`, `close_reason` enum,
and add an admin rollup endpoint. Lands before flag flip so the first biweekly
trade produces clean data.

---

## 9. Validation plan

### 9.1 Pre-flag-flip checklist

| Item | Owner | State |
|---|---|---|
| Schema migration confirmed (7 columns on `pilot_protections`) | Engineering | Done (handoff §7) |
| Hedge budget JSON override set in Render | Ops | Pending |
| Days-held instrumentation merged | Engineering | Pending |
| Deribit balance ≥ $1.5k | CEO funding | Pending |
| Pricing trader-facing copy reviewed | Product | Pending |
| Rollback path tested (`PILOT_BIWEEKLY_ENABLED=false`) | Engineering | Done |

### 9.2 Per-trade validation gates

Each of the first 5 biweekly trades produces a single-page review covering:

1. Trader inputs vs venue fill geometry (strike, expiry, ask vs BS)
2. Hedge cost vs trader maximum projected charge — margin band
3. Outcome (closed natural / triggered / closed early) + days held
4. TP recovery vs Black-Scholes modeled value (if triggered)
5. Slippage and strike-gap roll-up
6. Decision: continue / pause / adjust

After trade #5 a synthesized read-out drives:
- Whether to relax 1-trade/24h to 3-trade
- Whether to ship 3-day minimum bill (§2.3)
- Whether to extend ITM preference cutoff to 3.5% floor
- Whether to flip Gap 1 from observe to enforce

### 9.3 Decision gates beyond trade #5

| Gate | Threshold | Action if met |
|---|---|---|
| Trade #10 review | n≥10 trades, avg recovery within 30% of D2 modeled | Activate hedge inventory pooling design pass |
| Tier mix watch | 2% > 70% over 5-day rolling | Wedge consideration (discount on 3% tier) |
| Stress event | Any DVOL > 65 with active biweekly portfolio | Re-evaluate flat pricing vs D3 regime table |
| 5 SHORT triggers | n≥5 SHORT triggers | Validate Gap 5 enforcement |

---

## 10. Production-ready ship checklist

A retail platform is **production ready** when all of the following are true. Each
item is binary and verifiable; nothing on this list is judgment-call.

### 10.1 Code

- [ ] Biweekly feature flag default `false`; flippable per-environment
- [ ] All 6 cutover PRs (#109–#114) merged and verified on active branch
- [ ] Days-held instrumentation merged
- [ ] TP threshold tuning merged (prime 0.20, late 0.08 on biweekly)
- [ ] Hedge inventory pooling spec accepted (implementation can be Phase 2)
- [ ] No new TS errors introduced (`tsc --noEmit` clean against baseline)
- [ ] Unit tests pass: pricing, activate, close, trigger, TP path, budget cap

### 10.2 Configuration

- [ ] `PILOT_BIWEEKLY_ENABLED=false` set, ready to flip
- [ ] `PILOT_HEDGE_BUDGET_SCHEDULE_JSON` set to biweekly schedule
- [ ] `PILOT_TP_GAP5_ENFORCE=true` (already enforced; confirm)
- [ ] `PILOT_CIRCUIT_BREAKER_ENFORCE=true` (already; confirm)
- [ ] `TREASURY_ENABLED=false` (retail does not enable treasury)
- [ ] Deribit credentials live, paper mode off
- [ ] `PILOT_LIVE_START_DATE` aligned with rollout date

### 10.3 Operational

- [ ] Deribit balance ≥ $1.5k (smoke test floor) confirmed
- [ ] `scripts/pilot-status` returns green
- [ ] Render auto-restart confirmed picks up flag changes within 5 min
- [ ] Admin tab shows triggered protections per-direction recovery
- [ ] Alert dispatcher routes (Slack/Telegram) verified
- [ ] Rollback drill performed: flag-flip-off mid-protection, existing trades render, no new opens

### 10.4 Documentation

- [ ] Trader-facing pricing copy in widget matches §2.2 canonical
- [ ] `docs/AGENT_HANDOFF.md` updated with biweekly-live status
- [ ] `scripts/pilot-trade-investigate <id>` works on biweekly schema
- [ ] `docs/PILOT_DAILY_CHECKLIST.md` updated for biweekly cadence

### 10.5 Validation

- [ ] First smoke trade complete and reviewed (1 trade, $1k notional, full lifecycle)
- [ ] Trade #5 review gate passed
- [ ] Decision documented for: 3-day minimum, 24h-guard relax, ITM cutoff extension

---

## 11. Open levers (future)

Documented for future tuning after pilot data accumulates. No action this round.

| Lever | When to activate | Expected lift |
|---|---|---|
| D3 regime-stepped pricing | After ≥10 trades across ≥2 regimes | +10–15 pp gross margin in moderate, prevents stress losses |
| Hedge inventory pooling | After ≥10 clean dedicated-path trades | 25–40% reduction in fresh hedge buys |
| Floor laddering on inventory | Same gate as pooling | Additional 10–15% reduction |
| ITM cutoff extension to 3.5% floor | After Gap 1 enforcement validated | Cleaner 3% tier hedge geometry |
| Wedge on 3% tier | Tier mix watch trigger fires | Mix rebalancing without surcharge |
| Gap 1 enforcement | After 3 confirmed signal-aligned trades | Catches sharp reversal cases |
| Gap 3 inversion under biweekly | After first deep-drop trade | Holds deep-ITM put through drawdown |
| Falcon X read-only price feed | Post-pilot stabilization | Sanity check on Deribit fills, no execution impact |

---

## 12. Out of scope for this spec

- Treasury platform (separate doc)
- Multi-venue execution beyond Falcon X read-only
- Per-user multi-tenancy (collapses to `tenantScopeId="foxify-pilot"` for now)
- Foxify production API integration beyond pilot widget

---

*End of Retail Platform Spec.*
