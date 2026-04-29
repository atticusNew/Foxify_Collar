# Agent Handoff — Atticus / Foxify Bitcoin Options Protection Platform

> **For new AI agent sessions.** Read this once, then explore the repo for details before making any changes. Update the "Last Updated" + "Recent Activity" sections after material changes.

**Last Updated:** 2026-04-29
**Active Pilot Day:** 6 of 28
**Pilot Counterparty:** Foxify CEO (B2B retail pilot)

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

---

## Open Questions / Pending Decisions

1. **CEO use case:** speculation or integrated hedging? (asked, awaiting response)
2. **Tenor:** 1-day vs add-2-day-as-option? (CEO question, undecided)
3. **Dynamic pricing vs fixed:** status quo for now; flagged for treasury phase
4. **Recovery rate validation:** need n≥5 SHORT triggers post-Gap-5-enforce
5. **Treasury platform spec:** deferred; Q&A document drafted but CEO answers pending

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
| 2026-04-29 | (this session) | Day-6 platform assessment + ghost-trade investigation. CEO-confirmed ghost was an Open-Without local-only row (no server execution). Two follow-on PRs in-flight: admin filter chip, remove Open Without button. Plus this PR (handoff doc Day-6 refresh + URL redaction). |

All numbered PRs above merged to active branch. The "this session" row's PRs will replace this line once merged.

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
