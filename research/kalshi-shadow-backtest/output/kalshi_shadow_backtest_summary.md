# Atticus / Kalshi Shadow Hedge Backtest
**Generated:** 2026-04-26
**Markets analyzed:** 27 settled Kalshi BTC markets (Jan 2024 – Apr 2026)
**Hedge model:** Foxify production prior (Design A) — 5% SL put spread, 30-day tenor
**Bet size:** $100 contract face value (all stats scale linearly)

---

## Key Assumptions

| Assumption | Value | Source |
|---|---|---|
| Hedge instrument | Put spread (5% OTM buy, 10% OTM sell) | Foxify backtest V6 optimal structure |
| Premium markup | 40% above raw hedge cost | Foxify production target margin |
| Tenor scaling | 1-day cost × √30 × 0.65 | Square-root-of-time + term-structure discount |
| TP recovery (calm) | 68% of BS theoretical | Foxify R1 empirical (n=9 trades) |
| TP recovery (normal) | 55% | Estimated from R1 regression |
| TP recovery (stress) | 40% | Estimated; Deribit spreads widen 2-4× |
| Vol skew | +0.35 vol-pts per 1% OTM | Empirical Deribit short-dated surface |
| BTC prices | Coinbase daily close | Binance fallback |

---

## Aggregate Results

| Metric | Value |
|---|---|
| Markets analyzed | 27 |
| Kalshi YES win rate | 55.6% |
| Kalshi NO (losses) | 12 (44.4%) |
| Hedge triggered (BTC fell >5%) | 8 of 27 (30%) |
| Total protection premiums | $24.65 |
| Total hedge cost (Deribit) | $17.64 |
| Total payout to users | $17.99 |
| Platform net P&L | **$11.80** |
| Total user downside saved | **$8.74** |
| Avg return-on-trigger ratio | 3.3× ("pay $X, get $Y") |

---

## Per-Market Breakdown

| Market | Open | Settle | Kalshi Result | BTC Move | Regime | Fee ($) | Max Payout ($) | Hedge Pay ($) | User Saved ($) | Platform P&L ($) |
|---|---|---|---|---|---|---|---|---|---|---|
| KXBTCD-24JAN31-50000 | 2024-01-01 | 2024-01-31 | ✅ YES | -3.8% | normal | $0.87 | $2.90 | $0 | -$0.87 | +$0.47 |
| KXBTCD-24FEB29-50000 | 2024-01-31 | 2024-02-29 | ✅ YES | +43.8% | normal | $1.06 | $3.60 | $0 | -$1.06 | +$0.57 |
| KXBTCD-24MAR28-60000 | 2024-02-29 | 2024-03-28 | ✅ YES | +15.7% | normal | $1.07 | $3.70 | $0 | -$1.07 | +$0.58 |
| KXBTCD-24APR30-65000 | 2024-04-01 | 2024-04-30 | ❌ NO | -13% | stress | $1.20 | $3.05 | $3.05 | +$1.85 | +$0.34 |
| KXBTCD-24MAY31-65000 | 2024-05-01 | 2024-05-31 | ❌ NO | +15.8% | normal | $0.82 | $2.75 | $0 | -$0.82 | +$0.45 |
| KXBTCD-24JUN28-65000 | 2024-06-01 | 2024-06-28 | ❌ NO | -10.9% | normal | $0.68 | $2.40 | $2.40 | +$1.72 | +$0.19 |
| KXBTCD-24JUL31-65000 | 2024-07-01 | 2024-07-31 | ❌ NO | +2.8% | calm | $0.67 | $2.25 | $0 | -$0.67 | +$0.40 |
| KXBTCD-24AUG30-60000 | 2024-07-31 | 2024-08-30 | ❌ NO | -8.5% | normal | $0.82 | $2.75 | $1.93 | +$1.11 | +$0.23 |
| KXBTCD-24SEP27-60000 | 2024-09-01 | 2024-09-27 | ✅ YES | +14.8% | stress | $0.97 | $3.00 | $0 | -$0.97 | +$0.47 |
| KXBTCD-24OCT31-65000 | 2024-10-01 | 2024-10-31 | ✅ YES | +15.5% | normal | $1.05 | $3.50 | $0 | -$1.05 | +$0.57 |
| KXBTCD-24NOV29-80000 | 2024-11-01 | 2024-11-29 | ✅ YES | +40.3% | calm | $0.90 | $3.10 | $0 | -$0.90 | +$0.54 |
| KXBTCD-24DEC31-100000 | 2024-12-01 | 2024-12-31 | ❌ NO | -4% | normal | $1.26 | $3.60 | $0 | -$1.26 | +$0.68 |
| KXBTCD-25JAN31-100000 | 2025-01-01 | 2025-01-31 | ✅ YES | +8.5% | normal | $1.02 | $3.40 | $0 | -$1.02 | +$0.55 |
| KXBTCD-25FEB28-100000 | 2025-02-01 | 2025-02-28 | ❌ NO | -16.2% | normal | $0.82 | $2.90 | $2.90 | +$2.08 | +$0.24 |
| KXBTCD-25MAR28-90000 | 2025-03-01 | 2025-03-28 | ❌ NO | -1.9% | calm | $0.74 | $2.60 | $0 | -$0.74 | +$0.44 |
| KXBTCD-25APR30-90000 | 2025-04-01 | 2025-04-30 | ✅ YES | +10.6% | normal | $0.82 | $2.40 | $0 | -$0.82 | +$0.45 |
| KXBTCD-25MAY30-95000 | 2025-05-01 | 2025-05-30 | ✅ YES | +7.8% | normal | $0.82 | $2.80 | $0 | -$0.82 | +$0.45 |
| KXBTCD-25JUN27-100000 | 2025-06-01 | 2025-06-27 | ✅ YES | +1.3% | calm | $1.00 | $3.60 | $0 | -$1.00 | +$0.60 |
| KXBTCD-25JUL31-105000 | 2025-07-01 | 2025-07-31 | ✅ YES | +9.5% | calm | $0.97 | $3.25 | $0 | -$0.97 | +$0.58 |
| KXBTCD-25AUG29-110000 | 2025-08-01 | 2025-08-29 | ❌ NO | -4.3% | calm | $1.01 | $3.50 | $0 | -$1.01 | +$0.61 |
| KXBTCD-25SEP26-95000 | 2025-09-01 | 2025-09-26 | ✅ YES | +0.4% | calm | $0.82 | $3.00 | $0 | -$0.82 | +$0.49 |
| KXBTCD-25OCT31-100000 | 2025-10-01 | 2025-10-31 | ✅ YES | -7.7% | calm | $0.97 | $3.25 | $1.74 | +$0.77 | +$0.28 |
| KXBTCD-25NOV28-110000 | 2025-11-01 | 2025-11-28 | ✅ YES | -17.4% | normal | $0.88 | $3.10 | $3.10 | +$2.22 | +$0.25 |
| KXBTCD-25DEC31-115000 | 2025-12-01 | 2025-12-31 | ❌ NO | +1.4% | normal | $0.82 | $2.75 | $0 | -$0.82 | +$0.45 |
| KXBTCD-26JAN30-95000 | 2026-01-01 | 2026-01-30 | ❌ NO | -5.2% | calm | $0.85 | $2.90 | $0.12 | -$0.73 | +$0.24 |
| KXBTCD-26FEB27-90000 | 2026-02-01 | 2026-02-27 | ❌ NO | -14.4% | normal | $0.77 | $2.75 | $2.75 | +$1.98 | +$0.22 |
| KXBTCD-26MAR27-85000 | 2026-03-01 | 2026-03-27 | ✅ YES | +0.9% | stress | $0.97 | $2.60 | $0 | -$0.97 | +$0.46 |

---

## Notable Events

### Largest user save: KXBTCD-25NOV28-110000
- **Market:** Bitcoin above $110,000 on Nov 28, 2025?
- **BTC move:** -17.4% over 27 days
- **Kalshi outcome:** YES
- **Without protection:** $38.00
- **With protection:** $40.22
- **User saved:** $2.22 on a $0.88 fee

### Most painful BTC drawdown (largest miss): KXBTCD-25FEB28-100000
- **Market:** Bitcoin above $100,000 on Feb 28, 2025?
- **BTC move:** -16.2% (entry $100,624 → settle $84,298)
- **Hedge pay:** $2.90
- **User P&L unprotected:** $-58.00
- **User P&L protected:** $-55.92

---

## Regime Distribution

| Regime | Markets | % |
|---|---|---|
| Calm (rvol <40%) | 9 | 33% |
| Normal (40–65%) | 15 | 56% |
| Stress (>65%) | 3 | 11% |

*Regime based on 30-day realized vol at market open date.*