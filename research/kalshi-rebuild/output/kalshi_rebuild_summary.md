# Atticus / Kalshi Rebuild Backtest
**Generated:** 2026-04-27
**Markets:** 50 (across ABOVE / BELOW / HIT × YES / NO).
**Bet size:** $100 contract face (scales linearly).
**Outcome mismatches (recorded vs derived):** 10 / 50. Economics use derived outcome.

Foxify-clean: this package contains zero Foxify pilot calibration constants in product code paths. See `EVAL_AND_NEXT_STEPS.md` from the prior package for context, and `KAL_V3_DEMO_REVIEW.md` for the rebuild rationale.

---

## Headline four-tier comparison

| Metric | Light (W=95%) | Standard (W=85%) | Shield (W=70%) | Shield+ (W=70% +overlay) |
|---|---|---|---|---|
| Offer rate (% of markets where tier could be priced) | 76% | 66% | 56% | 44% |
| Avg fee ($, offered markets) | $6.84 | $13.59 | $22.95 | $25.94 |
| Avg fee (% of stake) | 15.3% | 24.7% | 38.2% | 41.0% |
| **P(payout > 0 \| loss)** | 100% | 100% | **100%** | **100%** |
| Avg recovery, all losers ($) | $9.04 | $22.49 | **$42.93** | **$46.97** |
| Avg recovery (% of stake) | 18.2% | 39.4% | **72.2%** | **74.9%** |
| Worst-case loss (% of stake)\* | 95% | 85% | **70%** | **70%** |
| Platform avg margin (% of rev) | 30.6% | 30.7% | 30.7% | 30.4% |
| Platform avg P&L per trade ($) | $1.95 | $3.80 | $6.30 | $7.23 |

\* Worst-case loss = max across all rows of (atRisk - rebate + fee) / atRisk. Deterministic for Shield/Shield+; conservative upper bound for put/call-spread tiers (BTC ending neutral).

---

## Per-quadrant offer-rate matrix (which tiers can be priced where)

Each cell shows: offer rate (markets where tier was offerable / total markets in that quadrant).

| Quadrant | Light | Standard | Shield | Shield+ |
|---|---|---|---|---|
| ABOVE/yes | 27/27 (100%) | 27/27 (100%) | 24/27 (89%) | 18/27 (67%) |
| ABOVE/no | 4/5 (80%) | 2/5 (40%) | 0/5 (0%) | 0/5 (0%) |
| BELOW/yes | 2/9 (22%) | 0/9 (0%) | 0/9 (0%) | 0/9 (0%) |
| BELOW/no | 3/3 (100%) | 3/3 (100%) | 3/3 (100%) | 3/3 (100%) |
| HIT/yes | 2/6 (33%) | 1/6 (17%) | 1/6 (17%) | 1/6 (17%) |
| HIT/no | — | — | — | — |

## Per-quadrant Shield+ economics (offered rows only)

| Quadrant | n offered | Avg fee | Avg recovery (loss) | P(payout|loss) | Worst case |
|---|---|---|---|---|---|
| ABOVE/yes | 18 | $26.91 | $49.19 (80%) | 100% | 70% |
| ABOVE/no | 0 | — | — | — | — |
| BELOW/yes | 0 | — | — | — | — |
| BELOW/no | 3 | $22.13 | $44.33 (67%) | 100% | 70% |
| HIT/yes | 1 | $19.87 | $39.37 (61%) | 100% | 70% |
| HIT/no | 0 | — | — | — | — |

---

## Threshold scorecard

| Threshold | Lite | Std | Shield | Shield+ |
|---|---|---|---|---|
| A1. Payout on ≥90% of losing markets | ✅ | ✅ | ✅ | ✅ |
| A2. Avg loss-payout ≥15% of stake | ✅ | ✅ | ✅ | ✅ |
| A3. Worst-case ≤ unprotected (≤100%) | ✅ | ✅ | ✅ | ✅ |
| B1. Worst-case ≤ 70% of stake | ❌ | ❌ | ✅ | ✅ |
| B2. Deterministic floor (contract) | ✅ | ✅ | ✅ | ✅ |

---

## Per-market trade log (Shield+, sorted by date)

| Market | Event | Dir | BTC move | Fee | Payout | Net before/after | Saved |
|---|---|---|---|---|---|---|---|
| KXBTCD-24JAN31-50000 ⚠ | ABOVE | yes | -3.78% | $0.00 | $0.00 | -$58.00 → -$58.00 | +$0.00 |
| KXBTCMAX-24Q1-150000 | HIT | yes | +67.78% | $0.00 | $0.00 | -$12.00 → -$12.00 | +$0.00 |
| KXBTCD-24FEB29-50000 | ABOVE | yes | +43.79% | $31.39 | $0.00 | $28.00 → -$3.39 | -$31.39 |
| KXBTCMINY-24FEB-40000 | BELOW | yes | +43.79% | $0.00 | $0.00 | -$22.00 → -$22.00 | +$0.00 |
| KXBTCD-24MAR28-60000 | ABOVE | yes | +15.73% | $18.34 | $0.00 | $26.00 → $7.66 | -$18.34 |
| KXBTCD-24APR30-65000 | ABOVE | yes | -13% | $28.97 | $51.11 | -$61.00 → -$38.87 | +$22.13 |
| KXBTCD-24MAY31-65000 ⚠ | ABOVE | yes | +15.8% | $0.00 | $0.00 | $45.00 → $45.00 | +$0.00 |
| KXBTCMINY-24MAY-55000 | BELOW | yes | +15.8% | $0.00 | $0.00 | -$28.00 → -$28.00 | +$0.00 |
| KXBTCD-24JUN28-65000 | ABOVE | yes | -10.94% | $0.00 | $0.00 | -$48.00 → -$48.00 | +$0.00 |
| KXBTCD-24JUL31-65000 | ABOVE | yes | +2.83% | $0.00 | $0.00 | -$45.00 → -$45.00 | +$0.00 |
| KXBTCD-24AUG30-60000 | ABOVE | yes | -8.51% | $35.02 | $52.28 | -$55.00 → -$37.74 | +$17.26 |
| KXBTCMINY-24AUG-50000 | BELOW | yes | -8.51% | $0.00 | $0.00 | -$30.00 → -$30.00 | +$0.00 |
| KXBTCD-24SEP27-60000 | ABOVE | yes | +14.82% | $34.88 | $0.00 | $40.00 → $5.12 | -$34.88 |
| KXBTCD-24OCT31-65000 | ABOVE | yes | +15.48% | $25.56 | $0.00 | $30.00 → $4.44 | -$25.56 |
| KXBTCMAX-24Q4-100000 ⚠ | HIT | yes | +53.57% | $19.87 | $39.37 | -$65.00 → -$45.50 | +$19.50 |
| KXBTCD-24NOV29-80000 | ABOVE | yes | +40.34% | $35.16 | $0.00 | $38.00 → $2.84 | -$35.16 |
| KXBTCD-24NOV29-80000-NO | ABOVE | no | +40.34% | $0.00 | $0.00 | -$38.00 → -$38.00 | +$0.00 |
| KXBTCD-24DEC31-100000 | ABOVE | yes | -4.02% | $19.78 | $45.08 | -$72.00 → -$46.70 | +$25.30 |
| KXBTCD-24DEC31-100000-NO | ABOVE | no | -4.02% | $0.00 | $0.00 | $72.00 → $72.00 | +$0.00 |
| KXBTCD-25JAN31-100000 | ABOVE | yes | +8.51% | $24.02 | $0.00 | $32.00 → $7.98 | -$24.02 |
| KXBTCMAX-25Q1-120000 | HIT | yes | -12.55% | $0.00 | $0.00 | -$35.00 → -$35.00 | +$0.00 |
| KXBTCD-25FEB28-100000 | ABOVE | yes | -16.22% | $31.22 | $51.50 | -$58.00 → -$37.72 | +$20.28 |
| KXBTCD-25FEB28-100000-NO | ABOVE | no | -16.22% | $0.00 | $0.00 | $58.00 → $58.00 | +$0.00 |
| KXBTCMINY-25FEB-85000 | BELOW | yes | -16.22% | $0.00 | $0.00 | $65.00 → $65.00 | +$0.00 |
| KXBTCMINY-25FEB-85000-NO | BELOW | no | -16.22% | $20.85 | $40.81 | -$65.00 → -$45.05 | +$19.95 |
| KXBTCD-25MAR28-90000 | ABOVE | yes | -1.9% | $0.00 | $0.00 | -$52.00 → -$52.00 | +$0.00 |
| KXBTCMINY-25MAR-80000 | BELOW | yes | -1.9% | $0.00 | $0.00 | -$30.00 → -$30.00 | +$0.00 |
| KXBTCD-25APR30-90000 | ABOVE | yes | +10.58% | $0.00 | $0.00 | $52.00 → $52.00 | +$0.00 |
| KXBTCD-25MAY30-95000 | ABOVE | yes | +7.78% | $34.10 | $0.00 | $44.00 → $9.90 | -$34.10 |
| KXBTCD-25JUN27-100000 | ABOVE | yes | +1.34% | $16.70 | $0.00 | $28.00 → $11.30 | -$16.70 |
| KXBTCD-25JUL31-105000 | ABOVE | yes | +9.51% | $23.38 | $0.00 | $35.00 → $11.62 | -$23.38 |
| KXBTCMAX-25Q3-150000 | HIT | yes | +7.9% | $0.00 | $0.00 | -$22.00 → -$22.00 | +$0.00 |
| KXBTCD-25AUG29-110000 | ABOVE | yes | -4.3% | $18.15 | $40.15 | -$70.00 → -$48.00 | +$22.00 |
| KXBTCD-25SEP26-95000 | ABOVE | yes | +0.42% | $25.38 | $0.00 | $40.00 → $14.62 | -$25.38 |
| KXBTCD-25OCT31-100000 | ABOVE | yes | -7.67% | $20.15 | $0.00 | $35.00 → $14.85 | -$20.15 |
| KXBTCMAX-25Q4-130000 | HIT | yes | -26.26% | $0.00 | $0.00 | -$28.00 → -$28.00 | +$0.00 |
| KXBTCD-25NOV28-110000 ⚠ | ABOVE | yes | -17.4% | $26.54 | $47.95 | -$62.00 → -$40.58 | +$21.42 |
| KXBTCD-25NOV28-110000-NO ⚠ | ABOVE | no | -17.4% | $0.00 | $0.00 | $62.00 → $62.00 | +$0.00 |
| KXBTCMINY-25NOV-95000 | BELOW | yes | -17.4% | $0.00 | $0.00 | $68.00 → $68.00 | +$0.00 |
| KXBTCMINY-25NOV-95000-NO | BELOW | no | -17.4% | $18.49 | $41.42 | -$68.00 → -$45.07 | +$22.93 |
| KXBTCD-25DEC31-115000 | ABOVE | yes | +1.41% | $0.00 | $0.00 | -$55.00 → -$55.00 | +$0.00 |
| KXBTCD-25DEC31-115000-NO | ABOVE | no | +1.41% | $0.00 | $0.00 | $55.00 → $55.00 | +$0.00 |
| KXBTCMINY-25DEC-90000 ⚠ | BELOW | yes | +1.41% | $0.00 | $0.00 | $75.00 → $75.00 | +$0.00 |
| KXBTCD-26JAN30-95000 | ABOVE | yes | -5.21% | $35.59 | $56.25 | -$58.00 → -$37.33 | +$20.67 |
| KXBTCMINY-26JAN-85000 ⚠ | BELOW | yes | -5.21% | $0.00 | $0.00 | $72.00 → $72.00 | +$0.00 |
| KXBTCMAX-26Q1-110000 | HIT | yes | -23.12% | $0.00 | $0.00 | -$32.00 → -$32.00 | +$0.00 |
| KXBTCD-26FEB27-90000 | ABOVE | yes | -14.35% | $0.00 | $0.00 | -$55.00 → -$55.00 | +$0.00 |
| KXBTCMINY-26FEB-80000 ⚠ | BELOW | yes | -14.35% | $0.00 | $0.00 | $65.00 → $65.00 | +$0.00 |
| KXBTCMINY-26FEB-80000-NO ⚠ | BELOW | no | -14.35% | $27.05 | $50.77 | -$65.00 → -$41.27 | +$23.73 |
| KXBTCD-26MAR27-85000 ⚠ | ABOVE | yes | +0.89% | $0.00 | $0.00 | -$52.00 → -$52.00 | +$0.00 |

---

## Notes

- BTC prices: Coinbase daily closes (Binance fallback). Outcome derived from price-vs-barrier (HIT settled approximately at expiry close — see kalshiEventTypes.ts notes).
- Spread strikes: synthetic Deribit chain ($1k weekly / $5k monthly grid) with offset-ladder selection from kal_v3_demo. Real chain integration is Phase 3.
- Spread pricing: Black-Scholes with explicit `bidAskWidener` (10% of theoretical, parameterized — replaceable with real bid-ask in Phase 3).
- IV proxy: `rvol × 1.18` (vol risk premium scalar; explicit per-tier config). Skew slope: 0.30 vol-pts per unit OTM (parameterized).
- TP recovery on un-triggered hedges: zero (conservative). Demo doesn't model TP either; the prior research package's Foxify TP table is removed.
- HIT settlements approximated from daily close at expiry; for true path-dependent settlement, daily-high/low data is needed (Phase 3+).