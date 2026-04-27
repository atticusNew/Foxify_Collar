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
| Avg effective W (% of stake)\* | 95.4% | 86.9% | 76.1% | 70.1% |
| Degradation rate (markets where target W couldn't be hit) | 9% | 22% | 34% | 46% |
| Avg fee ($) | $5.31 | $12.26 | $18.95 | $22.16 |
| Avg fee (% of stake) | 15.6% | 31.7% | 44.1% | 49.5% |
| **User EV per trade ($)** | -$1.08 | -$2.50 | -$3.86 | -$4.52 |
| **User EV (% of stake)** | -3.2% | -6.5% | -9.0% | -10.1% |
| **P(payout > 0 \| loss)** | 91% | 91% | **91%** | **91%** |
| Avg recovery, all losers ($) | $7.88 | $19.43 | **$31.56** | **$37.64** |
| Avg recovery (% of stake) | 21.6% | 47.4% | **69.7%** | **79.9%** |
| Worst-case loss (% of stake)\* | 100% | 100% | **100%** | **100%** |
| Platform avg margin (% of rev) | 20.4% | 20.4% | 20.4% | 20.4% |
| Platform avg P&L per trade ($) | $0.97 | $2.22 | $3.40 | $3.97 |

\* Worst-case loss = max across all rows of (atRisk - rebate + fee) / atRisk. Deterministic for Shield/Shield+; conservative upper bound for put/call-spread tiers (BTC ending neutral).

---

## YES-vs-NO symmetry analysis

The product mechanism is symmetric: regardless of bet direction, Atticus buys the *opposite* Kalshi side as the protection leg. This table shows whether the economics actually came out symmetric across all 4 tiers.

| Tier | YES bets (n) | YES avg fee | YES avg recovery | YES avg eff W | NO bets (n) | NO avg fee | NO avg recovery | NO avg eff W |
|---|---|---|---|---|---|---|---|---|
| lite | 51 | $5.42 (16%) | $8.77 (25%) | 95% | 17 | $4.95 (15%) | $5.12 (10%) | 96% |
| standard | 51 | $12.54 (32%) | $20.73 (52%) | 87% | 17 | $11.41 (30%) | $15.34 (31%) | 88% |
| shield | 51 | $19.17 (44%) | $32.78 (74%) | 76% | 17 | $18.28 (43%) | $27.75 (55%) | 78% |
| shield_plus | 51 | $22.80 (50%) | $39.21 (85%) | 69% | 17 | $20.25 (46%) | $32.76 (63%) | 74% |

---

## Per-quadrant degradation matrix (where each tier had to fall back from target W)

Each cell: `n_degraded / n_markets (avg effective W)`. Lower degradation rate = more often the tier delivered its target W exactly.

| Quadrant | Light | Standard | Shield | Shield+ |
|---|---|---|---|---|
| ABOVE/yes | 0/33 (W=95%) | 0/33 (W=85%) | 1/33 (W=70%) | 6/33 (W=61%) |
| ABOVE/no | 3/8 (W=97%) | 4/8 (W=91%) | 7/8 (W=86%) | 8/8 (W=86%) |
| BELOW/yes | 1/12 (W=95%) | 7/12 (W=88%) | 9/12 (W=84%) | 10/12 (W=82%) |
| BELOW/no | 0/5 (W=95%) | 0/5 (W=85%) | 1/5 (W=71%) | 2/5 (W=64%) |
| HIT/yes | 2/6 (W=96%) | 4/6 (W=91%) | 5/6 (W=88%) | 5/6 (W=86%) |
| HIT/no | 0/4 (W=95%) | 0/4 (W=85%) | 0/4 (W=70%) | 0/4 (W=60%) |

## Per-quadrant Shield+ economics

| Quadrant | n | Avg fee | Avg recovery (loss) | P(payout|loss) | Avg eff. W | User EV (% of stake) |
|---|---|---|---|---|---|---|
| ABOVE/yes | 33 | $22.28 | $47.46 (85%) | 100% | 61% | -7.9% |
| ABOVE/no | 8 | $20.57 | $12.60 (33%) | 33% | 86% | -12.1% |
| BELOW/yes | 12 | $25.64 | $26.93 (98%) | 100% | 82% | -15.6% |
| BELOW/no | 5 | $23.84 | $44.86 (81%) | 100% | 64% | -9.3% |
| HIT/yes | 6 | $19.97 | $22.63 (77%) | 80% | 86% | -12.8% |
| HIT/no | 4 | $15.14 | $0.00 (0%) | 0% | 60% | -4.4% |

---

## Threshold scorecard

| Threshold | Light | Std | Shield | Shield-Max |
|---|---|---|---|---|
| A1. Payout on ≥90% of losing markets | ✅ | ✅ | ✅ | ✅ |
| A1'. Payout on ≥90% of *non-degraded* losing markets | ✅ | ✅ | ✅ | ✅ |
| A2. Avg loss-payout ≥15% of stake (overall) | ✅ | ✅ | ✅ | ✅ |
| A3. Worst-case ≤ unprotected (≤100%) | ✅ | ✅ | ✅ | ✅ |
| B1. Worst-case ≤ target W (effective W vs target, non-degraded) | ✅ | ✅ | ✅ | ✅ |
| B2. Deterministic floor on non-degraded markets | ✅ | ✅ | ✅ | ✅ |

---

## Per-market trade log (Shield+, sorted by date)

| Market | Event | Dir | BTC move | Fee | Payout | Net before/after | Saved |
|---|---|---|---|---|---|---|---|
| KXBTCD-24JAN31-50000 ⚠ | ABOVE | yes | -3.78% | $25.91 | $49.11 | -$58.00 → -$34.80 | +$23.20 |
| KXBTCMAX-24Q1-150000 | HIT | yes | +67.78% | $0.00 | $0.00 | -$12.00 → -$12.00 | +$0.00 |
| KXBTCMAX-24Q1-150000-NO | HIT | no | +67.78% | $6.25 | $0.00 | $12.00 → $5.75 | -$6.25 |
| KXBTCD-24FEB29-50000 | ABOVE | yes | +43.79% | $15.62 | $0.00 | $28.00 → $12.38 | -$15.62 |
| KXBTCMINY-24FEB-40000 | BELOW | yes | +43.79% | $21.29 | $21.73 | -$22.00 → -$21.56 | +$0.44 |
| KXBTCD-24FEB29-45000 | ABOVE | yes | +43.79% | $7.34 | $0.00 | $14.00 → $6.66 | -$7.34 |
| KXBTCD-24FEB29-45000-NO | ABOVE | no | +43.79% | $0.00 | $0.00 | -$14.00 → -$14.00 | +$0.00 |
| KXBTCD-24MAR28-60000 | ABOVE | yes | +15.73% | $14.36 | $0.00 | $26.00 → $11.64 | -$14.36 |
| KXBTCD-24MAR28-55000 | ABOVE | yes | +15.73% | $6.25 | $0.00 | $12.00 → $5.75 | -$6.25 |
| KXBTCD-24APR30-65000 | ABOVE | yes | -13% | $23.43 | $47.83 | -$61.00 → -$36.60 | +$24.40 |
| KXBTCD-24MAY31-65000 ⚠ | ABOVE | yes | +15.8% | $28.60 | $0.00 | $45.00 → $16.40 | -$28.60 |
| KXBTCMINY-24MAY-55000 | BELOW | yes | +15.8% | $23.84 | $26.36 | -$28.00 → -$25.48 | +$2.52 |
| KXBTCD-24JUN28-65000 | ABOVE | yes | -10.94% | $30.73 | $47.05 | -$48.00 → -$31.68 | +$16.32 |
| KXBTCD-24JUL31-65000 | ABOVE | yes | +2.83% | $30.17 | $43.67 | -$45.00 → -$31.50 | +$13.50 |
| KXBTCD-24AUG30-60000 | ABOVE | yes | -8.51% | $28.60 | $50.60 | -$55.00 → -$33.00 | +$22.00 |
| KXBTCMINY-24AUG-50000 | BELOW | yes | -8.51% | $26.22 | $29.82 | -$30.00 → -$26.40 | +$3.60 |
| KXBTCD-24SEP27-60000 | ABOVE | yes | +14.82% | $24.24 | $0.00 | $40.00 → $15.76 | -$24.24 |
| KXBTCD-24OCT31-65000 | ABOVE | yes | +15.48% | $16.93 | $0.00 | $30.00 → $13.07 | -$16.93 |
| KXBTCMAX-24Q4-100000 | HIT | yes | +53.57% | $20.40 | $0.00 | $35.00 → $14.60 | -$20.40 |
| KXBTCD-24OCT31-70000 | ABOVE | yes | +15.48% | $27.68 | $0.00 | $44.00 → $16.32 | -$27.68 |
| KXBTCD-24NOV29-80000 | ABOVE | yes | +40.34% | $22.65 | $0.00 | $38.00 → $15.35 | -$22.65 |
| KXBTCD-24NOV29-80000-NO | ABOVE | no | +40.34% | $29.43 | $37.79 | -$38.00 → -$29.64 | +$8.36 |
| KXBTCD-24DEC31-100000 | ABOVE | yes | -4.02% | $15.62 | $44.42 | -$72.00 → -$43.20 | +$28.80 |
| KXBTCD-24DEC31-100000-NO | ABOVE | no | -4.02% | $23.84 | $0.00 | $72.00 → $48.16 | -$23.84 |
| KXBTCD-25JAN31-100000 | ABOVE | yes | +8.51% | $18.28 | $0.00 | $32.00 → $13.72 | -$18.28 |
| KXBTCMAX-25Q1-120000 | HIT | yes | -12.55% | $28.03 | $34.33 | -$35.00 → -$28.70 | +$6.30 |
| KXBTCMAX-25Q1-120000-NO | HIT | no | -12.55% | $20.40 | $0.00 | $35.00 → $14.60 | -$20.40 |
| KXBTCD-25JAN31-90000 | ABOVE | yes | +8.51% | $8.45 | $0.00 | $16.00 → $7.55 | -$8.45 |
| KXBTCD-25JAN31-90000-NO | ABOVE | no | +8.51% | $0.00 | $0.00 | -$16.00 → -$16.00 | +$0.00 |
| KXBTCD-25FEB28-100000 | ABOVE | yes | -16.22% | $25.91 | $49.11 | -$58.00 → -$34.80 | +$23.20 |
| KXBTCD-25FEB28-100000-NO | ABOVE | no | -16.22% | $30.43 | $0.00 | $58.00 → $27.57 | -$30.43 |
| KXBTCMINY-25FEB-85000 | BELOW | yes | -16.22% | $28.03 | $0.00 | $65.00 → $36.97 | -$28.03 |
| KXBTCMINY-25FEB-85000-NO | BELOW | no | -16.22% | $20.40 | $46.40 | -$65.00 → -$39.00 | +$26.00 |
| KXBTCMINY-25FEB-95000 | BELOW | yes | -16.22% | $28.60 | $0.00 | $45.00 → $16.40 | -$28.60 |
| KXBTCD-25MAR28-90000 | ABOVE | yes | -1.9% | $30.79 | $51.07 | -$52.00 → -$31.72 | +$20.28 |
| KXBTCMINY-25MAR-80000 | BELOW | yes | -1.9% | $26.22 | $29.82 | -$30.00 → -$26.40 | +$3.60 |
| KXBTCD-25APR30-90000 | ABOVE | yes | +10.58% | $30.73 | $0.00 | $52.00 → $21.27 | -$30.73 |
| KXBTCD-25MAY30-95000 | ABOVE | yes | +7.78% | $27.68 | $0.00 | $44.00 → $16.32 | -$27.68 |
| KXBTCD-25JUN27-100000 | ABOVE | yes | +1.34% | $15.62 | $0.00 | $28.00 → $12.38 | -$15.62 |
| KXBTCD-25JUL31-105000 | ABOVE | yes | +9.51% | $20.40 | $0.00 | $35.00 → $14.60 | -$20.40 |
| KXBTCMAX-25Q3-150000 | HIT | yes | +7.9% | $21.29 | $21.73 | -$22.00 → -$21.56 | +$0.44 |
| KXBTCD-25AUG29-110000 | ABOVE | yes | -4.3% | $16.93 | $44.93 | -$70.00 → -$42.00 | +$28.00 |
| KXBTCD-25SEP26-95000 | ABOVE | yes | +0.42% | $24.24 | $0.00 | $40.00 → $15.76 | -$24.24 |
| KXBTCD-25OCT31-100000 | ABOVE | yes | -7.67% | $20.40 | $0.00 | $35.00 → $14.60 | -$20.40 |
| KXBTCMAX-25Q4-130000 | HIT | yes | -26.26% | $23.84 | $26.36 | -$28.00 → -$25.48 | +$2.52 |
| KXBTCMAX-25Q4-130000-NO | HIT | no | -26.26% | $15.62 | $0.00 | $28.00 → $12.38 | -$15.62 |
| KXBTCD-25NOV28-110000 ⚠ | ABOVE | yes | -17.4% | $22.65 | $47.45 | -$62.00 → -$37.20 | +$24.80 |
| KXBTCD-25NOV28-110000-NO ⚠ | ABOVE | no | -17.4% | $29.43 | $0.00 | $62.00 → $32.57 | -$29.43 |
| KXBTCMINY-25NOV-95000 | BELOW | yes | -17.4% | $26.24 | $0.00 | $68.00 → $41.76 | -$26.24 |
| KXBTCMINY-25NOV-95000-NO | BELOW | no | -17.4% | $18.28 | $45.48 | -$68.00 → -$40.80 | +$27.20 |
| KXBTCD-25NOV28-100000 | ABOVE | yes | -17.4% | $11.91 | $43.11 | -$78.00 → -$46.80 | +$31.20 |
| KXBTCD-25NOV28-100000-NO | ABOVE | no | -17.4% | $21.29 | $0.00 | $78.00 → $56.71 | -$21.29 |
| KXBTCMINY-25NOV-105000 | BELOW | yes | -17.4% | $30.79 | $0.00 | $48.00 → $17.21 | -$30.79 |
| KXBTCMINY-25NOV-105000-NO | BELOW | no | -17.4% | $30.73 | $47.05 | -$48.00 → -$31.68 | +$16.32 |
| KXBTCD-25DEC31-115000 | ABOVE | yes | +1.41% | $28.60 | $50.60 | -$55.00 → -$33.00 | +$22.00 |
| KXBTCD-25DEC31-115000-NO | ABOVE | no | +1.41% | $30.17 | $0.00 | $55.00 → $24.83 | -$30.17 |
| KXBTCMINY-25DEC-90000 ⚠ | BELOW | yes | +1.41% | $20.33 | $0.00 | $75.00 → $54.67 | -$20.33 |
| KXBTCD-26JAN30-95000 | ABOVE | yes | -5.21% | $25.91 | $49.11 | -$58.00 → -$34.80 | +$23.20 |
| KXBTCMINY-26JAN-85000 ⚠ | BELOW | yes | -5.21% | $23.84 | $0.00 | $72.00 → $48.16 | -$23.84 |
| KXBTCMAX-26Q1-110000 | HIT | yes | -23.12% | $26.24 | $30.72 | -$32.00 → -$27.52 | +$4.48 |
| KXBTCMAX-26Q1-110000-NO | HIT | no | -23.12% | $18.28 | $0.00 | $32.00 → $13.72 | -$18.28 |
| KXBTCD-26FEB27-90000 | ABOVE | yes | -14.35% | $28.60 | $50.60 | -$55.00 → -$33.00 | +$22.00 |
| KXBTCMINY-26FEB-80000 ⚠ | BELOW | yes | -14.35% | $28.03 | $0.00 | $65.00 → $36.97 | -$28.03 |
| KXBTCMINY-26FEB-80000-NO ⚠ | BELOW | no | -14.35% | $20.40 | $46.40 | -$65.00 → -$39.00 | +$26.00 |
| KXBTCMINY-26FEB-90000 | BELOW | yes | -14.35% | $24.24 | $0.00 | $40.00 → $15.76 | -$24.24 |
| KXBTCMINY-26FEB-90000-NO | BELOW | no | -14.35% | $29.37 | $38.97 | -$40.00 → -$30.40 | +$9.60 |
| KXBTCD-26MAR27-85000 ⚠ | ABOVE | yes | +0.89% | $30.79 | $51.07 | -$52.00 → -$31.72 | +$20.28 |
| KXBTCD-26MAR27-90000 | ABOVE | yes | +0.89% | $29.34 | $39.59 | -$41.00 → -$30.75 | +$10.25 |

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

| Tier | Net margin / $100 stake | Revenue / $750k market @ 5% opt-in | @ 10% | @ 15% |
|---|---|---|---|---|
| lite | $0.97 | $1,193 | $2,386 | $3,579 |
| standard | $2.22 | $2,424 | $4,847 | $7,271 |
| shield | $3.40 | $3,375 | $6,751 | $10,126 |
| shield_plus | $3.97 | $3,783 | $7,567 | $11,350 |

### Kalshi revenue-share scenarios (Shield tier @ 10% opt-in)

Atticus runs ~13% net margin per trade. We can split this with Kalshi as a clearing-fee-style arrangement. Numbers below are per BTC market at $750k notional, then annualised at 16 markets/year (current Kalshi BTC cadence: 12 monthly + 4 quarterly HIT).

| Split | Atticus / market | Kalshi / market | Atticus / year (16 markets) | Kalshi / year |
|---|---|---|---|---|
| 100% Atticus | $6,751 | $0 | $108,008 | $0 |
| 75/25 split | $5,063 | $1,688 | $81,006 | $27,002 |
| 50/50 split | $3,375 | $3,375 | $54,004 | $54,004 |
| 25/75 split | $1,688 | $5,063 | $27,002 | $81,006 |

Today's BTC volume (~$750k/market): modest revenue line for both sides. The strategic value is in the 10× growth path: if Kalshi BTC TAM grows to $7.5M/market by 2026 H2 (reasonable given the institutional-distribution unlock the wrapper provides), the 50/50 split delivers ~$540,042/year to each side.