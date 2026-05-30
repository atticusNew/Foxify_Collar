# Legacy Pilot Empirical Analysis — REAL PAST DATA

**Generated:** 2026-05-28T03:08:22.015Z
**Source:** `volume_cover_position` JOIN `volume_cover_hedge_leg` (Render production DB)
**Sample size:** 35 positions, 47 hedge legs

## Per-cell realized economics

| Cell | N | TrigRate | Total hedge $ paid | Total hedge $ recovered | **Hedge net** | **Foxify net** | **Coop EV** | Mean coop/pair | Best | Worst |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 50k_2pct_1k | 19 | 10.5% | $1,720 | $2,454 | +$734 | -$17,435 | **-$16,701** | -$879 | +$470 | -$1,259 |
| 1k_2pct_20 | 14 | 0.0% | $1,284 | $866 | -$418 | -$280 | **-$698** | -$50 | -$20 | -$91 |
| 30k_2pct_600 | 2 | 50.0% | $833 | $612 | -$221 | -$990 | **-$1,211** | -$605 | -$600 | -$611 |

## Per-regime realized economics

| Regime | N | TrigRate | **Hedge net** | **Foxify net** | **Coop EV** | Mean coop/pair |
|---|---:|---:|---:|---:|---:|---:|
| unknown | 28 | 10.7% | +$91 | -$12,905 | **-$12,814** | -$458 |
| calm | 7 | 0.0% | +$5 | -$5,800 | **-$5,795** | -$828 |

## Time-of-day distribution (UTC hour at position open)

Reveals whether past pilots were biased to a specific session (e.g., US open = better spreads).

| Hour UTC | Session | N | Mean hedge $ paid | Mean hedge net | Mean coop EV |
|---:|---|---:|---:|---:|---:|
| 00:00 | ASIA | 3 | $150 | -$7 | -$27 |
| 02:00 | ASIA | 1 | $259 | -$259 | -$1,259 |
| 03:00 | ASIA | 1 | $259 | -$139 | -$1,138 |
| 12:00 | EU | 2 | $416 | -$110 | -$805 |
| 13:00 | US | 5 | $4 | +$1 | -$957 |
| 14:00 | US | 3 | $153 | -$4 | -$677 |
| 15:00 | US | 1 | $1,160 | +$1,120 | +$470 |
| 16:00 | US | 1 | $14 | +$5 | -$995 |
| 19:00 | US | 6 | $0 | +$0 | -$867 |
| 20:00 | US | 3 | $34 | -$34 | -$54 |
| 21:00 | ASIA-EVE | 5 | $0 | +$0 | -$292 |
| 22:00 | ASIA-EVE | 3 | $70 | -$70 | -$90 |
| 23:00 | ASIA-EVE | 1 | $70 | -$70 | -$90 |

## All positions (full receipts)

| pos_id (8) | cell | opened (UTC) | regime | entry BTC | trig? | dir | legs | hedge BUY | hedge SELL | hedge net | Foxify net | Coop EV | close reason |
|---|---|---|---|---:|---|---|---:|---:|---:|---:|---:|---:|---|
| `vc-pos-b` | 50k_2pct_1k | 2026-05-25T21:49 | calm | $77,260 | N | — | 0 | $0 | $0 | +$0 | -$800 | **-$800** | spread_open_failed: leg_put_long_Reached max leverage (failedAt=put_long) |
| `vc-pos-d` | 50k_2pct_1k | 2026-05-25T19:45 | calm | $77,341 | N | — | 1 | $0 | $0 | +$0 | -$800 | **-$800** | spread_open_failed: leg_call_long_Reached max leverage (failedAt=call_long) |
| `vc-pos-3` | 50k_2pct_1k | 2026-05-25T19:31 | calm | $77,417 | N | — | 0 | $0 | $0 | +$0 | -$800 | **-$800** | hedge_execution_failed:spread_liquidity_gate_failed |
| `vc-pos-8` | 50k_2pct_1k | 2026-05-25T19:22 | calm | $77,408 | N | — | 0 | $0 | $0 | +$0 | -$800 | **-$800** | hedge_execution_failed:spread_liquidity_gate_failed |
| `vc-pos-4` | 50k_2pct_1k | 2026-05-25T19:21 | calm | $77,402 | N | — | 0 | $0 | $0 | +$0 | -$800 | **-$800** | hedge_execution_failed:spread_liquidity_gate_failed |
| `vc-pos-4` | 50k_2pct_1k | 2026-05-25T13:12 | calm | $77,294 | N | — | 0 | $0 | $0 | +$0 | -$800 | **-$800** | spread_open_failed: leg_put_short_Reached max leverage (failedAt=put_short) |
| `vc-pos-f` | 50k_2pct_1k | 2026-05-24T16:38 | calm | $76,500 | N | — | 4 | $14 | $19 | +$5 | -$1,000 | **-$995** | admin: smoke_test_complete |
| `vc-pos-b` | 50k_2pct_1k | 2026-05-23T15:06 | unknown | $75,497 | Y | high | 4 | $1,160 | $2,280 | +$1,120 | -$650 | **+$470** | — |
| `vc-pos-f` | 50k_2pct_1k | 2026-05-23T14:53 | unknown | $75,371 | N | — | 0 | $0 | $0 | +$0 | -$1,000 | **-$1,000** | spread_open_failed: leg_put_long_Expired (failedAt=put_long) |
| `vc-pos-5` | 50k_2pct_1k | 2026-05-23T14:49 | unknown | $76,000 | N | — | 4 | $8 | $12 | +$4 | -$1,000 | **-$996** | admin: deploy_verify_cleanup |
| `vc-pos-1` | 50k_2pct_1k | 2026-05-23T13:45 | unknown | $76,000 | N | — | 4 | $10 | $12 | +$2 | -$1,000 | **-$998** | admin: live_smoke_clean |
| `vc-pos-2` | 50k_2pct_1k | 2026-05-23T13:44 | unknown | $76,000 | N | — | 4 | $10 | $12 | +$1 | -$987 | **-$986** | admin: ghost_position_cleanup_smoke_003 |
| `vc-pos-6` | 50k_2pct_1k | 2026-05-23T13:32 | unknown | $76,000 | N | — | 0 | $0 | $0 | +$0 | -$1,000 | **-$1,000** | spread_open_failed: leg_put_long_poll_timeout (lastStatus=OPEN) (failedAt=put_long) |
| `vc-pos-2` | 50k_2pct_1k | 2026-05-23T13:24 | unknown | $76,000 | N | — | 0 | $0 | $0 | +$0 | -$1,000 | **-$1,000** | spread_open_failed: leg_put_long_poll_timeout (failedAt=put_long) |
| `vc-pos-f` | 50k_2pct_1k | 2026-05-23T12:43 | unknown | $74,649 | N | — | 0 | $0 | $0 | +$0 | -$1,000 | **-$1,000** | spread_open_failed: leg_put_long_submit_error: bullish_http_400:{"message":"Unauthorized to execute command","raw":null,"errorCode":6105,"errorCodeName":"UNAUTHORIZED_COMMAND"} (failedAt=put_long) |
| `vc-pos-e` | 30k_2pct_600 | 2026-05-21T12:13 | unknown | $77,102 | Y | low | 2 | $833 | $612 | -$221 | -$390 | **-$611** | — |
| `vc-pos-c` | 30k_2pct_600 | 2026-05-20T21:27 | unknown | $77,575 | N | — | 0 | $0 | $0 | +$0 | -$600 | **-$600** | hedge_execution_failed: Volume Cover hedge execution failed for put leg: venue_execute_failed:deribit:deribit_error_code=10039|deribit_error=not_enough_funds_in_currency|orderState=unknown|fillRatio=0 |
| `vc-pos-d` | 50k_2pct_1k | 2026-05-20T19:53 | unknown | $77,588 | N | — | 0 | $0 | $0 | +$0 | -$1,000 | **-$1,000** | hedge_execution_failed: Volume Cover hedge execution failed for put leg: venue_execute_failed:deribit:orderState=unknown|fillRatio=0 |
| `vc-pos-b` | 50k_2pct_1k | 2026-05-20T19:30 | unknown | $77,523 | N | — | 0 | $0 | $0 | +$0 | -$1,000 | **-$1,000** | hedge_execution_failed: Volume Cover hedge execution failed for put leg: venue_execute_failed:deribit:unknown_reason |
| `vc-pos-0` | 1k_2pct_20 | 2026-05-19T14:18 | unknown | $76,510 | N | — | 2 | $451 | $436 | -$16 | -$20 | **-$36** | admin: smoke test complete — system validation |
| `vc-pos-3` | 1k_2pct_20 | 2026-05-19T00:41 | unknown | $77,122 | N | — | 2 | $447 | $431 | -$17 | -$20 | **-$37** | foxify_dashboard_close: live_validation_close_test |
| `vc-pos-2` | 1k_2pct_20 | 2026-05-19T00:28 | unknown | $77,219 | N | — | 0 | $0 | $0 | +$0 | -$20 | **-$20** | hedge_execution_failed: Volume Cover hedge execution failed for put leg: deribit_quote_unavailable:tenor_drift_exceeded |
| `vc-pos-7` | 1k_2pct_20 | 2026-05-19T00:05 | unknown | $76,947 | N | — | 2 | $3 | $0 | -$3 | -$20 | **-$23** | admin: wrong_strike_actual_69k87k_pre_storage_fix |
| `vc-pos-a` | 1k_2pct_20 | 2026-05-18T23:57 | unknown | $76,968 | N | — | 2 | $70 | $0 | -$70 | -$20 | **-$90** | admin: phantom_routing_misconfig |
| `vc-pos-2` | 1k_2pct_20 | 2026-05-18T22:29 | unknown | $77,120 | N | — | 2 | $69 | $0 | -$69 | -$20 | **-$89** | admin: deribit_pivot_cleanup_phantom_bullish_rejected |
| `vc-pos-f` | 1k_2pct_20 | 2026-05-18T22:25 | unknown | $77,154 | N | — | 2 | $70 | $0 | -$70 | -$20 | **-$90** | admin: phantom_cleanup_pre_retry |
| `vc-pos-5` | 1k_2pct_20 | 2026-05-18T22:02 | unknown | $77,056 | N | — | 2 | $71 | $0 | -$71 | -$20 | **-$91** | admin: insufficient_balance_phantom_hedge |
| `vc-pos-c` | 1k_2pct_20 | 2026-05-18T21:39 | unknown | $76,996 | N | — | 0 | $0 | $0 | +$0 | -$20 | **-$20** | hedge_execution_failed: Volume Cover hedge execution failed for put leg: venue_execute_failed:bullish:unknown_reason |
| `vc-pos-3` | 1k_2pct_20 | 2026-05-18T21:27 | unknown | $76,960 | N | — | 0 | $0 | $0 | +$0 | -$20 | **-$20** | hedge_execution_failed: Volume Cover hedge execution failed for put leg: venue_execute_failed:bullish:unknown_reason |
| `vc-pos-a` | 1k_2pct_20 | 2026-05-18T21:07 | unknown | $76,803 | N | — | 0 | $0 | $0 | +$0 | -$20 | **-$20** | hedge_execution_failed: Volume Cover hedge execution failed for put leg: venue_execute_failed:bullish:unknown_reason |
| `vc-pos-d` | 1k_2pct_20 | 2026-05-18T20:51 | unknown | $76,856 | N | — | 2 | $3 | $0 | -$3 | -$20 | **-$23** | admin: deribit_paper_fallback_no_real_hedge |
| `vc-pos-3` | 1k_2pct_20 | 2026-05-18T20:36 | unknown | $77,059 | N | — | 2 | $52 | $0 | -$52 | -$20 | **-$72** | admin: silent_failure_no_real_hedge_pre_fix |
| `vc-pos-d` | 1k_2pct_20 | 2026-05-18T20:06 | unknown | $76,885 | N | — | 2 | $47 | $0 | -$47 | -$20 | **-$67** | admin: mock_test_cleanup_no_real_hedge |
| `vc-pos-e` | 50k_2pct_1k | 2026-05-18T03:06 | unknown | $72,965 | Y | high | 2 | $259 | $120 | -$139 | -$999 | **-$1,138** | — |
| `vc-pos-3` | 50k_2pct_1k | 2026-05-18T02:59 | unknown | $76,777 | N | — | 2 | $259 | $0 | -$259 | -$1,000 | **-$1,259** | foxify_dashboard_close: manual_close_via_dashboard |

## Key empirical conclusions

- **Total positions analyzed:** 35
- **Total hedge premium PAID (Atticus out):** $3,837
- **Total hedge salvage RECEIVED (Atticus in):** $3,932
- **Net hedge P&L (Atticus side):** +$96
- **Net Foxify P&L (premium − payout to users):** -$18,705
- **Cooperative EV total (Atticus + Foxify):** -$18,609
- **Profitable pair rate:** 1/35 = 2.9%
- **Mean coop EV per pair:** -$532

### Answer to "did past 50k/2% actually pay out net of hedge?"

Most-traded ITM-style cell was `50k_2pct_1k` (19 positions).
- Total hedge paid: $1,720
- Total hedge recovered: $2,454
- **Net hedge P&L: +$734**
- **Net cooperative EV: -$16,701 (mean -$879/pair)**
- **Verdict: NOT PROFITABLE empirically.** Confirms V3 was correct to flag this as broken.

---
*Generated by services/api/scripts/integration/legacyPilotAnalysis.ts*