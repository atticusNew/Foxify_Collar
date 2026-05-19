# Hedge Budget Cap Schedule (rev 6 lock)

> **WS#2 of Bundle C cutover.** Sets the cumulative gross hedge spend cap on the Atticus pool ($12k total).

---

## Render env to set at cutover

```bash
PILOT_HEDGE_BUDGET_SCHEDULE_JSON='[{"throughDay":7,"capUsd":3500},{"throughDay":21,"capUsd":8500},{"throughDay":28,"capUsd":12000},{"throughDay":null,"capUsd":null}]'
PILOT_HEDGE_BUDGET_CAP_ENABLED=true
PILOT_LIVE_START_DATE='<ISO timestamp of pilot start, e.g. 2026-05-13T00:00:00Z>'
```

## Schedule rationale (linear ramp to $12k by Day 28)

| Pilot Day | Cap | Daily cap (avg) | Why |
|---|---|---|---|
| Days 1–7 | **$3,500** | $500/day avg | Early ramp; backtest projects $200-300/day under Bundle C |
| Days 8–21 | **$8,500** | $357/day avg | Mid pilot; bumps to support continued operation |
| Days 22–28 | **$12,000** | $215/day avg | Final week to stay within Atticus pool |
| Days 29+ | no cap | n/a | Post-pilot; cap removed |

## Burn rate context (from WS#9 backtest)

Bundle C P3 projection at 2 × $50k/day = $100k notional/day:
- Calm regime: ~$30/day hedge cost
- Normal regime: ~$120/day
- Stress regime: ~$285/day
- Blended expected: ~$110/day (well under cap budget)
- 95th percentile (1 stress week): ~$170/day blended (still under)

Cap is sized to absorb 2× expected burn comfortably. Even in worst-case
all-stress regime (~$430/day on a heavy-2% mix), cap supports 28 days
since cumulative would land near $12k.

## Utilization alerts (new in WS#2)

| Pct used | Level | Action |
|---|---|---|
| < 70% | ok | Normal operation, no alert |
| 70–85% | warn | Telegram info-level alert to operator |
| 85–95% | alert | Telegram warning-level + concentration cap auto-tightens to 40% |
| ≥ 95% | critical | Telegram critical-level + cap will trip on next quote |

These alerts use the existing R7 alert dispatcher (Telegram/Slack/Discord).
Wiring of these alerts into the hedge management cycle is in a follow-up
WS#8 commit.

## Rollback

If burn rate exceeds projection:
1. Lift cap by editing `PILOT_HEDGE_BUDGET_SCHEDULE_JSON` and restarting
2. OR set `PILOT_HEDGE_BUDGET_CAP_ENABLED=false` to disable entirely
3. OR tighten concentration: `PILOT_PER_TIER_DAILY_CAP_PCT=0.4` (was 0.6)
