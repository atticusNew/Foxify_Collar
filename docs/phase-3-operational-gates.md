# Phase 3C Operational Gates (Quote Quality -> Activation Decision)

This document defines concrete go/no-go gates for enabling activation after Phase 3A/3B cutover.

## Scope

- Runtime path: Render static web -> VPS API -> broker-bridge -> IBKR
- Quote policy: `PILOT_HEDGE_POLICY=options_only_native`
- User tenor inputs: static chips `3D / 7D / 14D / 21D / 30D`
- Backend still allowed to match nearby liquid expiry within policy constraints

## 1) Required telemetry

Capture by requested tenor and by market window (active vs thin/off-hours):

- quote success count / rate
- reason counts:
  - `quote_liquidity_unavailable:no_liquidity_window`
  - `quote_liquidity_unavailable:no_top_of_book`
  - `quote_generation_timeout`
- latency:
  - p50/p95 total quote latency
- selector diagnostics:
  - `qualifyCalls`, `topCalls`, `depthCalls`
  - `nTotalCandidates`, `nNoTop`, `nTimedOut`, `nPassed`
- tenor drift:
  - requested tenor vs selected tenor
  - drift distribution (p50/p95/max)

## 2) Validation matrix (market-hours run)

Run at least 10 quote attempts per static tenor:

- `3D`
- `7D`
- `14D`
- `21D`
- `30D`

Suggested command skeleton:

```bash
for d in 3 7 14 21 30; do
  for i in $(seq 1 10); do
    curl -sS -X POST "http://127.0.0.1:8000/pilot/protections/quote" \
      -H "Content-Type: application/json" \
      -d "{
        \"protectedNotional\": 25000,
        \"foxifyExposureNotional\": 25000,
        \"instrumentId\": \"BTC-USD-${d}D-P\",
        \"marketId\": \"BTC-USD\",
        \"protectionType\": \"long\",
        \"tierName\": \"Pro (Silver)\",
        \"drawdownFloorPct\": 0.2,
        \"tenorDays\": ${d}
      }" | jq -c '{status,reason,detail,timings:.diagnostics.timingsMs}'
  done
done
```

Fetch selector diagnostics between batches:

```bash
TOKEN=$(docker compose exec -T atticus sh -lc 'printf "%s" "$PILOT_ADMIN_TOKEN"')
curl -s -H "x-admin-token: $TOKEN" -H "x-admin-actor: ops" \
  http://127.0.0.1:8000/pilot/admin/diagnostics/selector | jq
```

## 3) Thin/off-hours behavior checks

Expected behavior in thin/off-market windows:

- deterministic liquidity error (`no_liquidity_window` or `no_top_of_book`)
- bounded probe behavior (no runaway top/depth fanout)
- no repeated client retries on deterministic liquidity errors

## 4) Gate thresholds (recommended)

Set final values with operations, but start with:

- Market-hours quote success rate:
  - >= 60% for at least 2 of 5 tenors
  - >= 40% aggregate across all five tenors
- p95 quote latency during market hours:
  - <= 30s
- Drift behavior:
  - median drift <= 3 days for successful quotes
- Error taxonomy:
  - deterministic liquidity reasons dominate thin windows
  - generic `quote_generation_timeout` remains low and non-dominant
- Stability:
  - no sustained broker-bridge transport degradation in `/pilot/health`

## 5) Activation go/no-go checklist

Mark each item pass/fail:

- [ ] VPS is canonical live API endpoint (Render API not serving pilot live traffic)
- [ ] Static tenor chips deployed (`3/7/14/21/30`) and visible to users
- [ ] Requested vs matched tenor/expiry displayed in quote card
- [ ] Liquidity status badge visible and accurate
- [ ] Validation matrix completed and archived
- [ ] Quote SLO thresholds met
- [ ] On-call/rollback runbook tested
- [ ] Activation flag change plan prepared

If any required gate fails, keep activation disabled and open remediation tickets before re-running.

