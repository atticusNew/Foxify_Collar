# Atticus / Kalshi Rebuild Backtest
**Generated:** 2026-04-27
**Markets:** 50 (across ABOVE / BELOW / HIT × YES / NO).
**Bet size:** $100 contract face (scales linearly).
**Outcome mismatches (recorded vs derived):** 10 / 50. Economics use derived outcome.

Foxify-clean: this package contains zero Foxify pilot calibration constants in product code paths. See `EVAL_AND_NEXT_STEPS.md` from the prior package for context, and `KAL_V3_DEMO_REVIEW.md` for the rebuild rationale.

---

## Headline four-tier comparison

| Metric | Lite | Standard | Shield | Shield+ |
|---|---|---|---|---|
| Avg fee ($) | $2.26 | $3.98 | $12.85 | $11.89 |
| Avg fee (% of stake) | 4.4% | 7.7% | 29.1% | 26.2% |
| **P(payout > 0 \| loss)** | 79% | 79% | **100%** | **100%** |
| Avg recovery, all losers ($) | $2.18 | $3.70 | **$19.16** | **$16.54** |
| Avg recovery (% of stake) | 4.5% | 7.6% | **40.0%** | **34.5%** |
| Worst-case loss (% of stake)\* | 114% | 124% | **111%** | **112%** |
| Platform avg margin (% of rev) | 28.5% | 31.0% | 30.7% | 30.3% |
| Platform avg P&L per trade ($) | $0.65 | $1.24 | $3.62 | $3.36 |

\* Worst-case loss = max across all rows of (atRisk - rebate + fee) / atRisk. Deterministic for Shield/Shield+; conservative upper bound for put/call-spread tiers (BTC ending neutral).

---

## Per-quadrant breakdown (Shield+ only — most institutional pitch)

| Quadrant | n | Avg fee | Avg recovery (loss) | P(payout|loss) | Worst case |
|---|---|---|---|---|---|
| ABOVE/yes | 27 | $13.39 | $20.18 (35%) | 100% | 101% |
| ABOVE/no | 5 | $10.78 | $14.14 (37%) | 100% | 104% |
| BELOW/yes | 9 | $10.65 | $10.46 (38%) | 100% | 112% |
| BELOW/no | 3 | $11.23 | $22.20 (34%) | 100% | 91% |
| HIT/yes | 6 | $8.30 | $9.70 (30%) | 100% | 108% |
| HIT/no | — | — | — | — | — |

---

## Threshold scorecard

| Threshold | Lite | Std | Shield | Shield+ |
|---|---|---|---|---|
| A1. Payout on ≥90% of losing markets | ❌ | ❌ | ✅ | ✅ |
| A2. Avg loss-payout ≥15% of stake | ❌ | ❌ | ✅ | ✅ |
| A3. Worst-case ≤ unprotected (≤100%) | ❌ | ❌ | ❌ | ❌ |
| B1. Worst-case ≤ 70% of stake | ❌ | ❌ | ❌ | ❌ |
| B2. Deterministic floor (contract) | ❌ | ❌ | ✅ | ✅ |

---

## Per-market trade log (Shield+, sorted by date)

| Market | Event | Dir | BTC move | Fee | Payout | Net before/after | Saved |
|---|---|---|---|---|---|---|---|
| KXBTCD-24JAN31-50000 ⚠ | ABOVE | yes | -3.78% | $17.75 | $23.96 | -$58.00 → -$51.79 | +$6.21 |
| KXBTCMAX-24Q1-150000 | HIT | yes | +67.78% | $4.57 | $3.60 | -$12.00 → -$12.97 | -$0.97 |
| KXBTCD-24FEB29-50000 | ABOVE | yes | +43.79% | $18.72 | $0.00 | $28.00 → $9.28 | -$18.72 |
| KXBTCMINY-24FEB-40000 | BELOW | yes | +43.79% | $9.31 | $9.19 | -$22.00 → -$22.12 | -$0.12 |
| KXBTCD-24MAR28-60000 | ABOVE | yes | +15.73% | $11.46 | $0.00 | $26.00 → $14.54 | -$11.46 |
| KXBTCD-24APR30-65000 | ABOVE | yes | -13% | $12.68 | $22.13 | -$61.00 → -$51.55 | +$9.45 |
| KXBTCD-24MAY31-65000 ⚠ | ABOVE | yes | +15.8% | $15.80 | $0.00 | $45.00 → $29.20 | -$15.80 |
| KXBTCMINY-24MAY-55000 | BELOW | yes | +15.8% | $10.60 | $10.80 | -$28.00 → -$27.80 | +$0.20 |
| KXBTCD-24JUN28-65000 | ABOVE | yes | -10.94% | $12.55 | $17.72 | -$48.00 → -$42.82 | +$5.18 |
| KXBTCD-24JUL31-65000 | ABOVE | yes | +2.83% | $13.38 | $13.78 | -$45.00 → -$44.60 | +$0.40 |
| KXBTCD-24AUG30-60000 | ABOVE | yes | -8.51% | $12.30 | $17.26 | -$55.00 → -$50.04 | +$4.96 |
| KXBTCMINY-24AUG-50000 | BELOW | yes | -8.51% | $12.22 | $11.32 | -$30.00 → -$30.89 | -$0.89 |
| KXBTCD-24SEP27-60000 | ABOVE | yes | +14.82% | $14.76 | $0.00 | $40.00 → $25.24 | -$14.76 |
| KXBTCD-24OCT31-65000 | ABOVE | yes | +15.48% | $14.50 | $0.00 | $30.00 → $15.50 | -$14.50 |
| KXBTCMAX-24Q4-100000 ⚠ | HIT | yes | +53.57% | $9.84 | $19.50 | -$65.00 → -$55.34 | +$9.66 |
| KXBTCD-24NOV29-80000 | ABOVE | yes | +40.34% | $15.89 | $0.00 | $38.00 → $22.11 | -$15.89 |
| KXBTCD-24NOV29-80000-NO | ABOVE | no | +40.34% | $10.53 | $14.14 | -$38.00 → -$34.40 | +$3.60 |
| KXBTCD-24DEC31-100000 | ABOVE | yes | -4.02% | $11.80 | $25.30 | -$72.00 → -$58.49 | +$13.51 |
| KXBTCD-24DEC31-100000-NO | ABOVE | no | -4.02% | $9.46 | $0.00 | $72.00 → $62.54 | -$9.46 |
| KXBTCD-25JAN31-100000 | ABOVE | yes | +8.51% | $12.93 | $0.00 | $32.00 → $19.07 | -$12.93 |
| KXBTCMAX-25Q1-120000 | HIT | yes | -12.55% | $9.84 | $10.50 | -$35.00 → -$34.34 | +$0.66 |
| KXBTCD-25FEB28-100000 | ABOVE | yes | -16.22% | $12.31 | $20.28 | -$58.00 → -$50.03 | +$7.97 |
| KXBTCD-25FEB28-100000-NO | ABOVE | no | -16.22% | $11.84 | $0.00 | $58.00 → $46.16 | -$11.84 |
| KXBTCMINY-25FEB-85000 | BELOW | yes | -16.22% | $12.05 | $0.00 | $65.00 → $52.95 | -$12.05 |
| KXBTCMINY-25FEB-85000-NO | BELOW | no | -16.22% | $10.33 | $19.95 | -$65.00 → -$55.38 | +$9.62 |
| KXBTCD-25MAR28-90000 | ABOVE | yes | -1.9% | $13.52 | $18.62 | -$52.00 → -$46.89 | +$5.11 |
| KXBTCMINY-25MAR-80000 | BELOW | yes | -1.9% | $10.80 | $10.53 | -$30.00 → -$30.27 | -$0.27 |
| KXBTCD-25APR30-90000 | ABOVE | yes | +10.58% | $13.46 | $0.00 | $52.00 → $38.54 | -$13.46 |
| KXBTCD-25MAY30-95000 | ABOVE | yes | +7.78% | $12.46 | $0.00 | $44.00 → $31.54 | -$12.46 |
| KXBTCD-25JUN27-100000 | ABOVE | yes | +1.34% | $9.96 | $0.00 | $28.00 → $18.04 | -$9.96 |
| KXBTCD-25JUL31-105000 | ABOVE | yes | +9.51% | $11.58 | $0.00 | $35.00 → $23.42 | -$11.58 |
| KXBTCMAX-25Q3-150000 | HIT | yes | +7.9% | $7.42 | $6.60 | -$22.00 → -$22.82 | -$0.82 |
| KXBTCD-25AUG29-110000 | ABOVE | yes | -4.3% | $10.30 | $22.00 | -$70.00 → -$58.29 | +$11.71 |
| KXBTCD-25SEP26-95000 | ABOVE | yes | +0.42% | $10.74 | $0.00 | $40.00 → $29.26 | -$10.74 |
| KXBTCD-25OCT31-100000 | ABOVE | yes | -7.67% | $9.98 | $0.00 | $35.00 → $25.02 | -$9.98 |
| KXBTCMAX-25Q4-130000 | HIT | yes | -26.26% | $8.72 | $8.40 | -$28.00 → -$28.32 | -$0.32 |
| KXBTCD-25NOV28-110000 ⚠ | ABOVE | yes | -17.4% | $11.99 | $21.42 | -$62.00 → -$52.58 | +$9.42 |
| KXBTCD-25NOV28-110000-NO ⚠ | ABOVE | no | -17.4% | $11.22 | $0.00 | $62.00 → $50.78 | -$11.22 |
| KXBTCMINY-25NOV-95000 | BELOW | yes | -17.4% | $11.22 | $0.00 | $68.00 → $56.78 | -$11.22 |
| KXBTCMINY-25NOV-95000-NO | BELOW | no | -17.4% | $9.96 | $22.93 | -$68.00 → -$55.02 | +$12.98 |
| KXBTCD-25DEC31-115000 | ABOVE | yes | +1.41% | $15.35 | $19.69 | -$55.00 → -$50.66 | +$4.34 |
| KXBTCD-25DEC31-115000-NO | ABOVE | no | +1.41% | $10.84 | $0.00 | $55.00 → $44.16 | -$10.84 |
| KXBTCMINY-25DEC-90000 ⚠ | BELOW | yes | +1.41% | $8.74 | $0.00 | $75.00 → $66.26 | -$8.74 |
| KXBTCD-26JAN30-95000 | ABOVE | yes | -5.21% | $14.03 | $20.67 | -$58.00 → -$51.37 | +$6.63 |
| KXBTCMINY-26JAN-85000 ⚠ | BELOW | yes | -5.21% | $10.10 | $0.00 | $72.00 → $61.90 | -$10.10 |
| KXBTCMAX-26Q1-110000 | HIT | yes | -23.12% | $9.41 | $9.60 | -$32.00 → -$31.81 | +$0.19 |
| KXBTCD-26FEB27-90000 | ABOVE | yes | -14.35% | $15.34 | $20.08 | -$55.00 → -$50.26 | +$4.74 |
| KXBTCMINY-26FEB-80000 ⚠ | BELOW | yes | -14.35% | $10.78 | $0.00 | $65.00 → $54.22 | -$10.78 |
| KXBTCMINY-26FEB-80000-NO ⚠ | BELOW | no | -14.35% | $13.40 | $23.73 | -$65.00 → -$54.67 | +$10.33 |
| KXBTCD-26MAR27-85000 ⚠ | ABOVE | yes | +0.89% | $15.96 | $19.55 | -$52.00 → -$48.41 | +$3.59 |

---

## Notes

- BTC prices: Coinbase daily closes (Binance fallback). Outcome derived from price-vs-barrier (HIT settled approximately at expiry close — see kalshiEventTypes.ts notes).
- Spread strikes: synthetic Deribit chain ($1k weekly / $5k monthly grid) with offset-ladder selection from kal_v3_demo. Real chain integration is Phase 3.
- Spread pricing: Black-Scholes with explicit `bidAskWidener` (10% of theoretical, parameterized — replaceable with real bid-ask in Phase 3).
- IV proxy: `rvol × 1.18` (vol risk premium scalar; explicit per-tier config). Skew slope: 0.30 vol-pts per unit OTM (parameterized).
- TP recovery on un-triggered hedges: zero (conservative). Demo doesn't model TP either; the prior research package's Foxify TP table is removed.
- HIT settlements approximated from daily close at expiry; for true path-dependent settlement, daily-high/low data is needed (Phase 3+).