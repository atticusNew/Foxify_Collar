# Foxify Pilot — Bundle C Production-Hardening

**Status:** Planning complete. Execution in progress on this branch.
**Branch:** `cursor/-bc-3aa2d238-ebb4-479a-98c7-2ade2838103f-6425` (cursor session branch — isolated from production deploy branch `cursor/-bc-c2468b87-...-6ba4`)
**Cutover target:** Day 11 of execution, after Gate 1 (backtest sign-off) and Gate 2 (pre-cutover validation)

## Documents in this folder

1. **[01_PLAN.md](./01_PLAN.md)** — full production-hardening plan (rev 6 lock)
2. **[02_CHANGE_IMPACT_OVERVIEW.md](./02_CHANGE_IMPACT_OVERVIEW.md)** — visual outline of every change and its economic impact
3. **[03_BACKTEST_PROJECTION.md](./03_BACKTEST_PROJECTION.md)** — analytical backtest projection (will be superseded by WS#9 harness output Day 5)
4. **[04_BULLISH_VS_DERIBIT_LIVE_COMPARISON.md](./04_BULLISH_VS_DERIBIT_LIVE_COMPARISON.md)** — live pricing comparison from 2026-05-13 (resolved 10% tier drop decision)
5. **[05_BUNDLE_C_PRICING_TABLE.md](./05_BUNDLE_C_PRICING_TABLE.md)** — user-facing pricing table for the new schedule
6. **[06_FINGERPRINT_FROM_OUR_SIDE.md](./06_FINGERPRINT_FROM_OUR_SIDE.md)** — browser fingerprinting design (no Foxify integration required)
7. **[07_ENV_AUDIT_CHECKLIST.md](./07_ENV_AUDIT_CHECKLIST.md)** — operator deliverable Day 1 (audit deployed Render env)
8. **[08_FOXIFY_LAYER6_INTEGRATION_SPEC.md](./08_FOXIFY_LAYER6_INTEGRATION_SPEC.md)** — operator deliverable Day 1 (forward to Foxify for trader binding integration)

## Quick reference

### Bundle C key changes
- **Pricing:** P3 schedule (TBD between P2/P3 at Gate 1)
- **Tier set:** 2%, 3%, 5%, **7% (new)** — 10% dropped
- **Stress 2%:** lifted to 1.8× trader return ($11/$1k from $13/$1k)
- **Tenor max:** 14 → 7 days
- **Position cap:** 2 × $50k/day = $100k notional/day
- **Atticus capital:** $12k
- **Foxify pre-fund:** $0 starting (architecture supports later top-up)
- **Anti-bot:** Layers 1-4 enforce + browser fingerprinting
- **Multi-venue routing:** Bullish primary 2%/3%, Deribit primary 5%/7%
- **Foxify pool architecture (WS#0):** built but inactive until pre-funded

### Execution gates
- **Gate 1 (Day 5 EOD):** operator reviews WS#9 backtest harness output; signs off on pricing decision
- **Gate 2 (Day 10):** operator + CEO review pre-cutover validation matrix; sign off on production cutover
- **No production cutover** until both gates pass

### Production isolation
Render production auto-deploys from a different branch. Commits to this branch do not trigger production deploys. Cutover (Day 11) = manual merge to production deploy branch + Render env update.
