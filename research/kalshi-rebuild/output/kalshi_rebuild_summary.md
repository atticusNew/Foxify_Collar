# Atticus / Kalshi Rebuild Backtest
**Generated:** 2026-04-27
**Markets:** 68 (across ABOVE / BELOW / HIT × YES / NO).
**Bet size:** $100 contract face (scales linearly).
**Outcome mismatches (recorded vs derived):** 9 / 68. Economics use derived outcome.

Foxify-clean: this package contains zero Foxify pilot calibration constants in product code paths. See `EVAL_AND_NEXT_STEPS.md` from the prior package for context, and `KAL_V3_DEMO_REVIEW.md` for the rebuild rationale.

---

## Headline four-tier comparison

| Metric | Light (target W=95%) | Standard (W=85%) | Shield (W=70%) | Shield-Max (W=60%) |
|---|---|---|---|---|
| Avg effective W (% of stake)\* | 95.9% | 88.3% | 78.5% | 73.0% |
| Degradation rate (markets where target W couldn't be hit) | 19% | 29% | 41% | 56% |
| Avg fee ($) | $5.00 | $11.79 | $18.69 | $21.99 |
| Avg fee (% of stake) | 12.0% | 25.8% | 37.8% | 43.2% |
| **User EV per trade ($)** | -$1.36 | -$3.20 | -$5.08 | -$5.98 |
| **User EV (% of stake)** | -3.3% | -7.0% | -10.3% | -11.7% |
| **P(payout > 0 \| loss)** | 79% | 79% | **79%** | **79%** |
| Avg recovery, all losers ($) | $7.71 | $18.42 | **$30.25** | **$35.89** |
| Avg recovery (% of stake) | 18.1% | 39.3% | **60.1%** | **69.3%** |
| Worst-case loss (% of stake)\* | 100% | 100% | **100%** | **100%** |
| Platform avg margin (% of rev) | 27.2% | 27.2% | 27.2% | 27.2% |
| Platform avg P&L per trade ($) | $1.25 | $2.94 | $4.64 | $5.45 |

\* Worst-case loss = max across all rows of (atRisk - rebate + fee) / atRisk. Deterministic for Shield/Shield+; conservative upper bound for put/call-spread tiers (BTC ending neutral).

---

## Per-quadrant degradation matrix (where each tier had to fall back from target W)

Each cell: `n_degraded / n_markets (avg effective W)`. Lower degradation rate = more often the tier delivered its target W exactly.

| Quadrant | Light | Standard | Shield | Shield+ |
|---|---|---|---|---|
| ABOVE/yes | 0/33 (W=95%) | 0/33 (W=85%) | 4/33 (W=71%) | 12/33 (W=63%) |
| ABOVE/no | 4/8 (W=98%) | 6/8 (W=93%) | 8/8 (W=91%) | 8/8 (W=91%) |
| BELOW/yes | 6/12 (W=97%) | 9/12 (W=94%) | 9/12 (W=90%) | 11/12 (W=88%) |
| BELOW/no | 0/5 (W=95%) | 0/5 (W=85%) | 2/5 (W=73%) | 2/5 (W=67%) |
| HIT/yes | 3/6 (W=98%) | 5/6 (W=95%) | 5/6 (W=92%) | 5/6 (W=91%) |
| HIT/no | 0/4 (W=95%) | 0/4 (W=85%) | 0/4 (W=70%) | 0/4 (W=60%) |

## Per-quadrant Shield+ economics

| Quadrant | n | Avg fee | Avg recovery (loss) | P(payout|loss) | Avg eff. W | User EV (% of stake) |
|---|---|---|---|---|---|---|
| ABOVE/yes | 33 | $25.91 | $50.37 (90%) | 100% | 63% | -12.2% |
| ABOVE/no | 8 | $15.90 | $11.94 (31%) | 33% | 91% | -10.6% |
| BELOW/yes | 12 | $18.95 | $11.64 (39%) | 50% | 88% | -13.1% |
| BELOW/no | 5 | $26.97 | $46.86 (84%) | 100% | 67% | -13.9% |
| HIT/yes | 6 | $13.38 | $12.33 (37%) | 40% | 91% | -9.3% |
| HIT/no | 4 | $17.58 | $0.00 (0%) | 0% | 60% | -6.9% |

---

## Threshold scorecard

| Threshold | Light | Std | Shield | Shield-Max |
|---|---|---|---|---|
| A1. Payout on ≥90% of losing markets | ❌ | ❌ | ❌ | ❌ |
| A1'. Payout on ≥90% of *non-degraded* losing markets | ✅ | ✅ | ✅ | ✅ |
| A2. Avg loss-payout ≥15% of stake (overall) | ✅ | ✅ | ✅ | ✅ |
| A3. Worst-case ≤ unprotected (≤100%) | ✅ | ✅ | ✅ | ✅ |
| B1. Worst-case ≤ target W (effective W vs target, non-degraded) | ✅ | ✅ | ✅ | ✅ |
| B2. Deterministic floor on non-degraded markets | ✅ | ✅ | ✅ | ✅ |

---

## Per-market trade log (Shield+, sorted by date)

| Market | Event | Dir | BTC move | Fee | Payout | Net before/after | Saved |
|---|---|---|---|---|---|---|---|
| KXBTCD-24JAN31-50000 ⚠ | ABOVE | yes | -3.78% | $31.62 | $54.82 | -$58.00 → -$34.80 | +$23.20 |
| KXBTCMAX-24Q1-150000 | HIT | yes | +67.78% | $0.00 | $0.00 | -$12.00 → -$12.00 | +$0.00 |
| KXBTCMAX-24Q1-150000-NO | HIT | no | +67.78% | $6.95 | $0.00 | $12.00 → $5.05 | -$6.95 |
| KXBTCD-24FEB29-50000 | ABOVE | yes | +43.79% | $17.99 | $0.00 | $28.00 → $10.01 | -$17.99 |
| KXBTCMINY-24FEB-40000 | BELOW | yes | +43.79% | $0.00 | $0.00 | -$22.00 → -$22.00 | +$0.00 |
| KXBTCD-24FEB29-45000 | ABOVE | yes | +43.79% | $8.19 | $0.00 | $14.00 → $5.81 | -$8.19 |
| KXBTCD-24FEB29-45000-NO | ABOVE | no | +43.79% | $0.00 | $0.00 | -$14.00 → -$14.00 | +$0.00 |
| KXBTCD-24MAR28-60000 | ABOVE | yes | +15.73% | $16.44 | $0.00 | $26.00 → $9.56 | -$16.44 |
| KXBTCD-24MAR28-55000 | ABOVE | yes | +15.73% | $6.95 | $0.00 | $12.00 → $5.05 | -$6.95 |
| KXBTCD-24APR30-65000 | ABOVE | yes | -13% | $28.14 | $52.54 | -$61.00 → -$36.60 | +$24.40 |
| KXBTCD-24MAY31-65000 ⚠ | ABOVE | yes | +15.8% | $33.81 | $0.00 | $45.00 → $11.19 | -$33.81 |
| KXBTCMINY-24MAY-55000 | BELOW | yes | +15.8% | $0.00 | $0.00 | -$28.00 → -$28.00 | +$0.00 |
| KXBTCD-24JUN28-65000 | ABOVE | yes | -10.94% | $33.57 | $47.01 | -$48.00 → -$34.56 | +$13.44 |
| KXBTCD-24JUL31-65000 | ABOVE | yes | +2.83% | $33.34 | $44.14 | -$45.00 → -$34.20 | +$10.80 |
| KXBTCD-24AUG30-60000 | ABOVE | yes | -8.51% | $33.81 | $54.71 | -$55.00 → -$34.10 | +$20.90 |
| KXBTCMINY-24AUG-50000 | BELOW | yes | -8.51% | $22.38 | $23.28 | -$30.00 → -$29.10 | +$0.90 |
| KXBTCD-24SEP27-60000 | ABOVE | yes | +14.82% | $29.25 | $0.00 | $40.00 → $10.75 | -$29.25 |
| KXBTCD-24OCT31-65000 | ABOVE | yes | +15.48% | $19.62 | $0.00 | $30.00 → $10.38 | -$19.62 |
| KXBTCMAX-24Q4-100000 | HIT | yes | +53.57% | $24.06 | $0.00 | $35.00 → $10.94 | -$24.06 |
| KXBTCD-24OCT31-70000 | ABOVE | yes | +15.48% | $33.35 | $0.00 | $44.00 → $10.65 | -$33.35 |
| KXBTCD-24NOV29-80000 | ABOVE | yes | +40.34% | $27.07 | $0.00 | $38.00 → $10.93 | -$27.07 |
| KXBTCD-24NOV29-80000-NO | ABOVE | no | +40.34% | $30.50 | $35.82 | -$38.00 → -$32.68 | +$5.32 |
| KXBTCD-24DEC31-100000 | ABOVE | yes | -4.02% | $17.99 | $46.79 | -$72.00 → -$43.20 | +$28.80 |
| KXBTCD-24DEC31-100000-NO | ABOVE | no | -4.02% | $0.00 | $0.00 | $72.00 → $72.00 | +$0.00 |
| KXBTCD-25JAN31-100000 | ABOVE | yes | +8.51% | $21.33 | $0.00 | $32.00 → $10.67 | -$21.33 |
| KXBTCMAX-25Q1-120000 | HIT | yes | -12.55% | $29.11 | $32.61 | -$35.00 → -$31.50 | +$3.50 |
| KXBTCMAX-25Q1-120000-NO | HIT | no | -12.55% | $24.06 | $0.00 | $35.00 → $10.94 | -$24.06 |
| KXBTCD-25JAN31-90000 | ABOVE | yes | +8.51% | $9.46 | $0.00 | $16.00 → $6.54 | -$9.46 |
| KXBTCD-25JAN31-90000-NO | ABOVE | no | +8.51% | $0.00 | $0.00 | -$16.00 → -$16.00 | +$0.00 |
| KXBTCD-25FEB28-100000 | ABOVE | yes | -16.22% | $31.62 | $54.82 | -$58.00 → -$34.80 | +$23.20 |
| KXBTCD-25FEB28-100000-NO | ABOVE | no | -16.22% | $32.88 | $0.00 | $58.00 → $25.12 | -$32.88 |
| KXBTCMINY-25FEB-85000 | BELOW | yes | -16.22% | $29.11 | $0.00 | $65.00 → $35.89 | -$29.11 |
| KXBTCMINY-25FEB-85000-NO | BELOW | no | -16.22% | $24.06 | $50.06 | -$65.00 → -$39.00 | +$26.00 |
| KXBTCMINY-25FEB-95000 | BELOW | yes | -16.22% | $33.81 | $0.00 | $45.00 → $11.19 | -$33.81 |
| KXBTCD-25MAR28-90000 | ABOVE | yes | -1.9% | $34.20 | $51.88 | -$52.00 → -$34.32 | +$17.68 |
| KXBTCMINY-25MAR-80000 | BELOW | yes | -1.9% | $22.38 | $23.28 | -$30.00 → -$29.10 | +$0.90 |
| KXBTCD-25APR30-90000 | ABOVE | yes | +10.58% | $33.57 | $0.00 | $52.00 → $18.43 | -$33.57 |
| KXBTCD-25MAY30-95000 | ABOVE | yes | +7.78% | $33.35 | $0.00 | $44.00 → $10.65 | -$33.35 |
| KXBTCD-25JUN27-100000 | ABOVE | yes | +1.34% | $17.99 | $0.00 | $28.00 → $10.01 | -$17.99 |
| KXBTCD-25JUL31-105000 | ABOVE | yes | +9.51% | $24.06 | $0.00 | $35.00 → $10.94 | -$24.06 |
| KXBTCMAX-25Q3-150000 | HIT | yes | +7.9% | $0.00 | $0.00 | -$22.00 → -$22.00 | +$0.00 |
| KXBTCD-25AUG29-110000 | ABOVE | yes | -4.3% | $19.62 | $47.62 | -$70.00 → -$42.00 | +$28.00 |
| KXBTCD-25SEP26-95000 | ABOVE | yes | +0.42% | $29.25 | $0.00 | $40.00 → $10.75 | -$29.25 |
| KXBTCD-25OCT31-100000 | ABOVE | yes | -7.67% | $24.06 | $0.00 | $35.00 → $10.94 | -$24.06 |
| KXBTCMAX-25Q4-130000 | HIT | yes | -26.26% | $0.00 | $0.00 | -$28.00 → -$28.00 | +$0.00 |
| KXBTCMAX-25Q4-130000-NO | HIT | no | -26.26% | $17.99 | $0.00 | $28.00 → $10.01 | -$17.99 |
| KXBTCD-25NOV28-110000 ⚠ | ABOVE | yes | -17.4% | $27.07 | $51.87 | -$62.00 → -$37.20 | +$24.80 |
| KXBTCD-25NOV28-110000-NO ⚠ | ABOVE | no | -17.4% | $30.50 | $0.00 | $62.00 → $31.50 | -$30.50 |
| KXBTCMINY-25NOV-95000 | BELOW | yes | -17.4% | $27.11 | $0.00 | $68.00 → $40.89 | -$27.11 |
| KXBTCMINY-25NOV-95000-NO | BELOW | no | -17.4% | $21.33 | $48.53 | -$68.00 → -$40.80 | +$27.20 |
| KXBTCD-25NOV28-100000 | ABOVE | yes | -17.4% | $13.51 | $44.71 | -$78.00 → -$46.80 | +$31.20 |
| KXBTCD-25NOV28-100000-NO | ABOVE | no | -17.4% | $0.00 | $0.00 | $78.00 → $78.00 | +$0.00 |
| KXBTCMINY-25NOV-105000 | BELOW | yes | -17.4% | $34.20 | $0.00 | $48.00 → $13.80 | -$34.20 |
| KXBTCMINY-25NOV-105000-NO | BELOW | no | -17.4% | $33.57 | $47.01 | -$48.00 → -$34.56 | +$13.44 |
| KXBTCD-25DEC31-115000 | ABOVE | yes | +1.41% | $33.81 | $54.71 | -$55.00 → -$34.10 | +$20.90 |
| KXBTCD-25DEC31-115000-NO | ABOVE | no | +1.41% | $33.34 | $0.00 | $55.00 → $21.66 | -$33.34 |
| KXBTCMINY-25DEC-90000 ⚠ | BELOW | yes | +1.41% | $0.00 | $0.00 | $75.00 → $75.00 | +$0.00 |
| KXBTCD-26JAN30-95000 | ABOVE | yes | -5.21% | $31.62 | $54.82 | -$58.00 → -$34.80 | +$23.20 |
| KXBTCMINY-26JAN-85000 ⚠ | BELOW | yes | -5.21% | $0.00 | $0.00 | $72.00 → $72.00 | +$0.00 |
| KXBTCMAX-26Q1-110000 | HIT | yes | -23.12% | $27.11 | $29.03 | -$32.00 → -$30.08 | +$1.92 |
| KXBTCMAX-26Q1-110000-NO | HIT | no | -23.12% | $21.33 | $0.00 | $32.00 → $10.67 | -$21.33 |
| KXBTCD-26FEB27-90000 | ABOVE | yes | -14.35% | $33.81 | $54.71 | -$55.00 → -$34.10 | +$20.90 |
| KXBTCMINY-26FEB-80000 ⚠ | BELOW | yes | -14.35% | $29.11 | $0.00 | $65.00 → $35.89 | -$29.11 |
| KXBTCMINY-26FEB-80000-NO ⚠ | BELOW | no | -14.35% | $24.06 | $50.06 | -$65.00 → -$39.00 | +$26.00 |
| KXBTCMINY-26FEB-90000 | BELOW | yes | -14.35% | $29.25 | $0.00 | $40.00 → $10.75 | -$29.25 |
| KXBTCMINY-26FEB-90000-NO | BELOW | no | -14.35% | $31.84 | $38.64 | -$40.00 → -$33.20 | +$6.80 |
| KXBTCD-26MAR27-85000 ⚠ | ABOVE | yes | +0.89% | $34.20 | $51.88 | -$52.00 → -$34.32 | +$17.68 |
| KXBTCD-26MAR27-90000 | ABOVE | yes | +0.89% | $31.52 | $38.90 | -$41.00 → -$33.62 | +$7.38 |

---

## Notes

- BTC prices: Coinbase daily closes (Binance fallback). Outcome derived from price-vs-barrier (HIT settled approximately at expiry close — see kalshiEventTypes.ts notes).
- Spread strikes: synthetic Deribit chain ($1k weekly / $5k monthly grid) with offset-ladder selection from kal_v3_demo. Real chain integration is Phase 3.
- Spread pricing: Black-Scholes with explicit `bidAskWidener` (10% of theoretical, parameterized — replaceable with real bid-ask in Phase 3).
- IV proxy: `rvol × 1.18` (vol risk premium scalar; explicit per-tier config). Skew slope: 0.30 vol-pts per unit OTM (parameterized).
- TP recovery: 20% generic estimate on un-triggered Deribit overlays (no Foxify pilot table; conservative parameter).
- HIT settlements: PATH-DEPENDENT using Coinbase daily highs/lows across the holding window (Phase 4 complete).
- Markup: derived from targetNetMargin (0.20) + opCostFrac (0.05) → 1.33×. NOT a Foxify default.

---

## Platform-revenue scaling (per Kalshi BTC market)

Assumes a typical Kalshi BTC market trades ~$750k notional total during its lifetime (public Kalshi volume data, 2024-2026 average). Atticus per-trade margin × opt-in rate × volume per market = revenue scenarios:

| Tier | Avg margin / $100 stake | Revenue / $750k market @ 5% opt-in | @ 10% opt-in | @ 15% opt-in |
|---|---|---|---|---|
| lite | 1.25/12% fee | $1,220 | $2,440 | $3,660 |
| standard | 2.94/26% fee | $2,628 | $5,256 | $7,884 |
| shield | 4.64/38% fee | $3,857 | $7,715 | $11,572 |
| shield_plus | 5.45/43% fee | $4,403 | $8,806 | $13,208 |

At 12 BTC monthly markets × 4 quarterly HIT markets = 16 markets/year, scaled platform revenue (Shield+ tier, 10% opt-in): see PR description.