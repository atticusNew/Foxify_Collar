# Agent Handoff — Atticus / Foxify Bitcoin Options Protection Platform

> **For new AI agent sessions.** Read this once, then explore the repo for details before making any changes. Update the "Last Updated" + "Recent Activity" sections after material changes.

**Last Updated:** 2026-04-30
**Active Pilot Day:** 7 of 28
**Pilot Counterparty:** Foxify CEO (B2B retail pilot)
**MAJOR CUTOVER IN PROGRESS:** PRs #109-#114 replace the 1-day product with biweekly per-day subscription pricing. Feature flag `PILOT_BIWEEKLY_ENABLED` controls activation. Read PRs #109 through #114 for full context before touching any pricing/activate/close/hedge-manager code.

---

## Current State

- **Platform:** deployed on Render Singapore. URL: `set in Render dashboard → service settings (env var: PILOT_API_BASE)`
- **Repo:** `github.com/atticusNew/Foxify_Collar`
- **Active development branch:** `cursor/-bc-3aa2d238-ebb4-479a-98c7-2ade2838103f-6425`
- **Pilot started:** 2026-04-23 20:00:00 UTC (Day 1)
- **Pilot ends:** 2026-05-21 (Day 28)
- **Live trading:** ENABLED on Deribit mainnet (DERIBIT_PAPER=false)
- **Open protections:** rotates as trades open/expire (most are 1-day tenor, expire daily)
- **Deribit account:** live mainnet, ~$420 BTC balance, `cross_sm` margin model with `cross_collateral_enabled=true`

---

## Critical Design Decisions (don't second-guess unless data demands it)

### 1. Pricing — Design A regime-adjusted dynamic schedule, locked for 28-day pilot

| Regime | DVOL band | 2% | 3% | 5% | 10% |
|---|---|---|---|---|---|
| Low | ≤ 50 | $6.50 | $5 | $3 | $2 |
| Moderate | 50–65 | $7 | $5.50 | $3 | $2 |
| Elevated | 65–80 | $8 | $6 | $3.50 | $2 |
| High | > 80 | $10 | $7 | $4 | $2 |

All tenors **1 day**. Source: `services/api/src/pilot/pricingRegime.ts`.

### 2. ITM strike preference (PR #76)
Aggressive on 2% tier (`-0.010` cost-score bonus, both LONG and SHORT). Eliminates the strike-grid dead-zone that caused early loss trades.

### 3. SHORT-specific TP rule (Gap 5, PR #80)
Currently **ENFORCED** via `PILOT_TP_GAP5_ENFORCE=true`. Targets barely-graze + clear-breakout patterns. Validation in progress; need 5+ SHORT triggers to confirm 60% recovery target.

### 4. Hedge budget cap (R2.F, PR #85+#86)
Cumulative hedge-spend cap by pilot day:
- Day 1-2: $100
- Day 3-7: $1,000
- Day 8-21: $10,000
- Day 22+: no cap

Enforced. Source: `services/api/src/pilot/hedgeBudgetCap.ts`. Pilot start configured via `PILOT_LIVE_START_DATE=2026-04-23T20:00:00Z`.

### 5. Treasury scheduler — SILENCED
`TREASURY_ENABLED=false` in Render env. **Don't re-enable for retail pilot.** Treasury platform is a separate workstream pending CEO conversation.

### 6. Circuit breaker
Armed. `PILOT_CIRCUIT_BREAKER_MAX_LOSS_PCT=0.7` (70% drop in 24h trips it). Enforce mode on. Source: `services/api/src/pilot/circuitBreaker.ts`.

### 7. Biweekly product cutover (NEW 2026-04-30 — PRs #109-#114)

The 1-day product is being replaced by a per-day subscription model with 14-day max tenor. **Code is fully merged but live trading still runs the 1-day product until the feature flag is flipped on Render.**

**Pre-launch checklist** (in this order, do not skip):

1. **All 6 PRs merged** to active branch (#109 #110 #111 #112 #113 #114).
2. **Schema migration confirmed.** PR 2 added 7 columns to `pilot_protections` via `ensurePilotSchema` (runs on every server startup). After Render restart, verify:
   ```sql
   SELECT column_name FROM information_schema.columns
   WHERE table_name='pilot_protections'
     AND column_name IN ('tenor_days','daily_rate_usd_per_1k','accumulated_charge_usd','days_billed','closed_at','closed_by','hedge_retained_for_platform');
   -- expect 7 rows
   ```
3. **Hedge budget cap raised.** Default schedule of $100 day-1-2 trips on the very first biweekly trade (~$258 cost). Set in Render env:
   ```
   PILOT_HEDGE_BUDGET_SCHEDULE_JSON='[{"throughDay":7,"capUsd":1500},{"throughDay":21,"capUsd":8000},{"throughDay":null,"capUsd":null}]'
   ```
4. **Deribit funded.** Need ≥ $1,500 added (~$1,800 total) for the 3-trade pilot test per D4. CEO confirmed funding plan 2026-04-30.
5. **Flip the feature flag.** In Render env: `PILOT_BIWEEKLY_ENABLED=true`. Render auto-restarts within ~5 min.
6. **CEO opens first biweekly trade.** Verify Deribit shows the 14-day option.

**Pricing (locked per CEO direction 2026-04-30, deliberately aggressive starting baseline):**

| Tier | Per-day rate per $1k | $10k position |
|---|---|---|
| 2% SL | $2.50/day | $25/day, max $350 over 14d |
| 3% SL | $2.50/day | $25/day, max $350 over 14d |
| 5% SL | $2.00/day | $20/day, max $280 over 14d |
| 10% SL | $1.50/day | $15/day, max $210 over 14d |

Flat across volatility regimes. Tunable via `PILOT_BIWEEKLY_RATE_<N>PCT` env vars without a deploy. Re-enabling regime-variable pricing is a 1-line change in `biweeklyPricing.ts:getBiweeklyRatePerDayPer1k`.

**Architecture:**
- `services/api/src/pilot/biweeklyPricing.ts` — rate table, helpers, feature flag
- `services/api/src/pilot/biweeklyActivate.ts` — quote + activate handlers (called from `routes.ts` early-return branches when `product:"biweekly"` in body)
- `services/api/src/pilot/biweeklyClose.ts` — close handler (used by the new `POST /:id/close` endpoint, by triggerMonitor close-on-trigger, and by the natural-expiry sweep)
- `pilot_protections` table — 7 new columns, all back-compat (legacy 1-day rows default to `tenor_days=1` and the rest null/0/false)
- Hedge manager TP timing — tenor-aware (legacy 1-day behavior unchanged; biweekly gets √14× longer cooling, 14× longer prime window, 4×-capped near-expiry salvage)
- Per CEO direction: when biweekly trigger fires, protection closes for user but hedge stays open for platform (`hedge_retained_for_platform=true`). Hedge manager's TP logic owns disposition.

**Rollback:** set `PILOT_BIWEEKLY_ENABLED=false` (or unset) — instant fallback to legacy 1-day path. All biweekly code is dormant. Existing biweekly protections continue to render and can be closed; no new ones can open.

**1-trade-per-24h guard:** enforced in `biweeklyActivate.handleBiweeklyActivate`. Per CEO direction (one trade per day during baseline-discovery phase). Removable in a follow-up PR when CEO is ready to scale.

---

## Open Questions / Pending Decisions

1. **CEO use case:** speculation or integrated hedging? (asked, awaiting response)
2. **Tenor:** 1-day product replaced by 14-day biweekly subscription per PRs #109-#114 (pending feature-flag flip on Render — see Critical Design Decisions §7).
3. **Dynamic pricing vs fixed:** biweekly launches with FLAT rates across regimes (per CEO 2026-04-30: "absolute baseline"). Re-enabling regime-variable pricing is a 1-line change in `biweeklyPricing.ts` after we collect enough data.
4. **Recovery rate validation under biweekly:** D2 modeled 159% recovery (BS) vs 18% on 1-day. Need n≥3 live biweekly triggers to validate.
5. **Treasury platform spec:** deferred; Q&A document drafted but CEO answers pending.
6. **Capital scaling beyond 3-trade test:** D4 sized $1,500 added for 3 concurrent biweekly trades. After 3-trade test passes, plan funding for 5 (~$7,500 floor) and 10 (~$18,000 floor) before lifting the 1-trade-per-24h guard.

---

## Recent Activity (last 5-7 days)

| Date | PR | Summary |
|---|---|---|
| 2026-04-22 | #82 | Triggered tab filter bug — exclude naturally-expired |
| 2026-04-23 | #83 | Triggered recovery/ITM display + widget archive sync + SHORT 2% strike-grid hardening |
| 2026-04-23 | #84 | Foxify Pilot Agreement v2 (4-page PDF) |
| 2026-04-23 | #85 | Hedge-budget cap (R2.F) initial implementation |
| 2026-04-23 | #86 | Hedge-budget cap correctness fix (sum execution_price × quantity, exclude paper fills) |
| 2026-04-23 | #87 | Check Balance button now hits Deribit (was hitting dead Bullish endpoint) |
| 2026-04-25 | #88 | Lower low-regime 2% $7 → $6.50 (CEO feedback on calm-regime price weight) |
| 2026-04-29 | #89 | Restore AGENT_HANDOFF.md on active branch (was on a side branch, never merged) |
| 2026-04-29 | #98-#100 | Day-6 platform assessment + ghost-trade investigation. CEO-confirmed ghost was an Open-Without local-only row. Three follow-on PRs: handoff doc Day-6 refresh + URL redaction, admin filter chip, remove Open Without button. |
| 2026-04-30 | #101-#108 | **Phase 0 analysis complete.** Five deliverables across 4 PRs (D1 #105 pricing dataset, D2 #106 trigger replay, D3 #108 per-day pricing model, D4 #107 capital requirements). Verdict: biweekly product is materially better than 1-day in every regime tested. Per-day rate table proposed and validated. |
| 2026-04-30 | #109-#114 | **Biweekly cutover (6 PRs, chained sequence).** Replaces the 1-day product with biweekly per-day subscription pricing. PR 1 (#109) pricing module + feature flag, PR 2 (#110) schema + ledger, PR 3 (#111) activate path + 14-day hedge buy + 1-trade/24h, PR 4 (#112) close endpoint + trigger close-handling + natural-expiry sweep, PR 5 (#113) widget UX subscription model, PR 6 (#114) hedge manager TP retuning for 14-day options. **Feature flag `PILOT_BIWEEKLY_ENABLED=false` by default; live trading still on 1-day until flag flipped.** See "Critical Design Decisions" §7 below for the full launch checklist. |

All numbered PRs above merged to active branch.

---

## Operating Principles (the user's preferences, learned)

- **Plan first, get confirmation, THEN implement.** User dislikes "I'll just do it" approach without a clear plan/analysis step.
- **Be pragmatic with credit/time.** Don't over-engineer or write excessive tests.
- **Honest assessment over optimism.** User repeatedly asks "honest read?" — give the real answer including downsides.
- **Separate PRs for separate logical changes.** No batched mega-PRs.
- **Always create a PR for changes;** user uses `gh pr merge X -R atticusNew/Foxify_Collar --squash --delete-branch` to merge.
- **Branch naming:** `cursor/<short-description>-38e5` (the `-38e5` suffix is required).
- **ALL financial calculations use `Decimal` type, NEVER float.**
- **Don't touch treasury system without explicit user request.**
- **Don't change open protections' economics retroactively** (premium is locked at activation time).
- **Stress regime pricing must stay high** — that's the buffer keeping weighted EV positive across cycles.

---

## Key Docs in Repo

| Doc | Purpose |
|---|---|
| `docs/PILOT_TECHNICAL_GUIDE.md` | Full architecture, all components, env vars |
| `docs/cfo-report/Atticus_Foxify_Pilot_CFO_Report.md` | Economics, levers, regime breakdowns, watch list |
| `docs/FOXIFY_PILOT_AGREEMENT_v2.md` | Current pilot agreement (PDF: `docs/pilot-agreement/Foxify_Protect_Pilot_v2.pdf`) |
| `docs/pilot-reports/short_protection_logic_audit.md` | PR #75 audit; reference for SHORT-vs-LONG asymmetry decisions |
| `docs/PILOT_DAILY_CHECKLIST.md` | Operational runbook |
| `scripts/pilot-status` | 30-second daily health check |
| `scripts/pilot-trade-investigate <id>` | Per-trade lifecycle deep-dive |

---

## Critical Tech Details

- **Stack:** Node.js + Fastify (`services/api`), TypeScript + React + Vite (`apps/web`), PostgreSQL on Render
- **Deribit connector:** `services/connectors/src/deribitConnector.ts`
- **Hedge manager:** `services/api/src/pilot/hedgeManager.ts` (runs every 60s)
- **Trigger monitor:** `services/api/src/pilot/triggerMonitor.ts` (polls every 3s)
- **Auto-renew:** `services/api/src/pilot/autoRenew.ts`
- **Tests:** use `node:test` + `pg-mem` for DB simulation
- **TS errors:** ~30 pre-existing in `routes.ts`/`db.ts`/`types.ts`. Do **NOT** introduce new ones. Verify with stash+rerun before committing.

### Render Environment Variables (production set)

```
DERIBIT_ENV=live
DERIBIT_PAPER=false
DERIBIT_CLIENT_ID=<set>
DERIBIT_CLIENT_SECRET=<set>
PILOT_VENUE_MODE=deribit_live
PILOT_LIVE_START_DATE=2026-04-23T20:00:00Z
PILOT_HEDGE_BUDGET_CAP_ENABLED=true
PILOT_CIRCUIT_BREAKER_ENFORCE=true
PILOT_CIRCUIT_BREAKER_MAX_LOSS_PCT=0.7
PILOT_TP_GAP5_ENFORCE=true
TREASURY_ENABLED=false
PILOT_API_ENABLED=true
PILOT_ADMIN_TOKEN=<set>
```

---

## What the User Likely Needs Next

Pilot is in **observe-and-collect mode**. Real work is gated on:
- CEO responses to outstanding questions (use case, tenor preference)
- More live trade data (need n≥5 SHORT triggers, n≥10 LONG triggers)
- Treasury platform launch (separate workstream)

**Don't initiate new architecture without user direction.** If asked for analysis on something: give honest assessment, identify trade-offs, propose options, ask user to choose. **Don't decide unilaterally on anything financial.**

---

## When Starting a Session

```bash
# 1. Sync to active branch
cd /workspace
git fetch origin --prune
git checkout origin/cursor/-bc-3aa2d238-ebb4-479a-98c7-2ade2838103f-6425 -B cursor/-bc-3aa2d238-ebb4-479a-98c7-2ade2838103f-6425

# 2. (User-side) Run platform health check
./scripts/pilot-status

# 3. Read docs/PILOT_TECHNICAL_GUIDE.md §1-3 for fast architecture context
```

**Always wait for user to specify today's focus before starting code work.** If unsure about anything, ask the user. Don't guess on financial product decisions.

---

## Update Protocol

When this file becomes stale, update these sections:
1. **Last Updated** date at the top
2. **Active Pilot Day** counter
3. **Recent Activity** table (add new PRs, drop entries older than ~7 days if list grows past 15)
4. **Critical Design Decisions** if any are revised (preserve old ones — strike through, don't delete)
5. **Open Questions** — add new ones, remove resolved ones

Goal: keep this under ~3 pages. If it grows past that, we're carrying history that should live in the repo commits/docs instead.
