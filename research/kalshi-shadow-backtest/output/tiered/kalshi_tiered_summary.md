# Atticus / Kalshi Shadow Hedge Backtest — Tiered (v2 + v3)
**Generated:** 2026-04-26
**Markets analyzed:** 27 settled Kalshi BTC monthly markets (Jan 2024 – Apr 2026)
**Bet size used for cash figures:** $100 contract face value (scales linearly).
**Outcome mismatch flags (recorded vs derived from BTC price):** 4 of 27 — economics use **derived** outcome.

---

## Tier families

Two families of protection products run on the same dataset:

**v2 put-spread tiers (rebate products, BTC-path-dependent):**

| Tier | Long-put OTM | Short-put OTM | Spread width | Sizing | Markup |
|---|---|---|---|---|---|
| lite | 1.0% | 20.0% | 19.0% | 1.00× of at-risk | 1.40× |
| standard | 0.0% | 30.0% | 30.0% | 1.70× of at-risk | 1.45× |

**v3 Shield tiers (deterministic-floor products, contract-bounded):**

| Tier | Mechanism | Floor (% of stake) | Put-spread overlay | Markup |
|---|---|---|---|---|
| shield | Kalshi-NO leg only | 40% guaranteed on Kalshi loss | none | 1.40× |
| shield_plus | NO leg + put spread | 30% guaranteed | ATM long / 25% OTM short, 1.0× sizing | 1.40× |

All option pricing: direct Black-Scholes on actual BTC strikes at each market's open date, using realized-vol-derived IV with skew. NO-leg pricing: $1 face × (100−YES)/100 plus 3% Kalshi fee on NO win.

---

## Headline four-tier comparison (per $100 contract face)

| Metric | Lite | Standard | Shield (v3) | Shield+ (v3) |
|---|---|---|---|---|
| Mechanism | Put spread | Put spread + sizing | Kalshi-NO leg | NO leg + put spread |
| Avg fee ($) | $3.91 | $8.43 | $13.44 | $12.95 |
| Avg fee (% of stake) | 6.5% | 14.1% | 22.9% | 22.0% |
| **P(payout > 0 \| Kalshi loss)** | 79% | 79% | **100%** | **100%** |
| **Avg recovery, all losers ($)** | $3.68 | $7.05 | **$22.89** | **$19.24** |
| **Avg recovery, all losers (% of stake)** | 6.3% | 12.1% | **40.0%** | **33.6%** |
| Avg recovery, BTC-down losers ($) | $4.69 | $8.97 | $23.60 | $20.35 |
| Avg recovery, BTC-down losers (% of stake) | 8.1% | 15.4% | 40.0% | 34.6% |
| Deep-drop subset avg recovery (% of stake) | 13.4% | 24.4% | 40.0% | 39.4% |
| Worst-case realized loss (% of stake)\* | 109% | 122% | **92%** | **99%** |
| Platform avg margin (% of revenue) | 28.6% | 31.0% | 28.6% | 28.6% |
| Platform avg P&L per trade ($) | $1.71 | $3.84 | $3.76 | $3.64 |
| Platform total P&L (scaled, ~$750k/market) | $341,315 | $768,328 | $752,773 | $728,330 |

\* Worst-case realized loss = max across all 27 markets of (stake + fee − total payout) / stake. For Shield tiers this is the *contract-deterministic* upper bound on user loss; for put-spread tiers it's path-dependent (BTC ending at open = no payout = max loss).

---

## Threshold scorecard — does each tier cross the institutional bar?

(Thresholds defined in `EVAL_AND_NEXT_STEPS.md` §1.)

| Threshold | Lite | Standard | Shield | Shield+ |
|---|---|---|---|---|
| A1. P(payout > 0 \| loss) ≥ 90% | ❌ | ❌ | ✅ | ✅ |
| A2. Avg payout on loss ≥ 15% of stake | ❌ | ❌ | ✅ | ✅ |
| A3. Worst-case loss ≤ 100% (better than unprotected) | ❌ | ❌ | ✅ | ✅ |
| B1. Worst-case loss ≤ 70% of stake | ❌ | ❌ | ❌ | ❌ |
| B2. Deterministic floor (contract, not path-dependent) | ❌ | ❌ | ✅ | ✅ |
| B3. Hedged counterparty (no Atticus solvency tail) | ✅ | ✅ | ✅ | ✅ |

---

## Losing-market detail

### Tier: lite
- Losing markets: **14** of 27
- Losers where BTC fell during the window: **11** of 14
- Avg unprotected loss on losing markets: -$57.21
- Avg net P&L on losing markets WITH protection: -$57.28
- Avg payout on losers: $3.68 (6.3% of stake)
- Best single user save: KXBTCD-25NOV28-110000 (2025-11-01 → 2025-11-28), BTC -17.4%, payout $10.17 on $3.71 fee.
- Most painful BTC move on losing market: KXBTCD-25NOV28-110000 (BTC -17.4%) — unprotected -$62.00 → protected -$55.54.

### Tier: standard
- Losing markets: **14** of 27
- Losers where BTC fell during the window: **11** of 14
- Avg unprotected loss on losing markets: -$57.21
- Avg net P&L on losing markets WITH protection: -$58.30
- Avg payout on losers: $7.05 (12.1% of stake)
- Best single user save: KXBTCD-25NOV28-110000 (2025-11-01 → 2025-11-28), BTC -17.4%, payout $18.34 on $7.76 fee.
- Most painful BTC move on losing market: KXBTCD-25NOV28-110000 (BTC -17.4%) — unprotected -$62.00 → protected -$51.42.

### Tier: shield
- Losing markets: **14** of 27
- Losers where BTC fell during the window: **11** of 14
- Avg unprotected loss on losing markets: -$57.21
- Avg net P&L on losing markets WITH protection: -$48.15
- Avg payout on losers: $22.89 (40.0% of stake)
- Best single user save: KXBTCD-24DEC31-100000 (2024-12-01 → 2024-12-31), BTC -4.02%, payout $28.80 on $11.63 fee.
- Most painful BTC move on losing market: KXBTCD-25NOV28-110000 (BTC -17.4%) — unprotected -$62.00 → protected -$50.79.

### Tier: shield_plus
- Losing markets: **14** of 27
- Losers where BTC fell during the window: **11** of 14
- Avg unprotected loss on losing markets: -$57.21
- Avg net P&L on losing markets WITH protection: -$51.12
- Avg payout on losers: $19.24 (33.6% of stake)
- Best single user save: KXBTCD-25NOV28-110000 (2025-11-01 → 2025-11-28), BTC -17.4%, payout $26.29 on $12.75 fee.
- Most painful BTC move on losing market: KXBTCD-25NOV28-110000 (BTC -17.4%) — unprotected -$62.00 → protected -$48.46.

---

## Per-market trade log (Shield+ tier — most pitch-relevant for institutional)

| Market | Open → Settle | BTC move | Recorded | Derived | Fee | Total Payout | Net before/after | Saved |
|---|---|---|---|---|---|---|---|---|
| KXBTCD-24JAN31-50000 | 2024-01-01→2024-01-31 | -3.78% | YES ⚠ | NO | $13.50 | $17.40 | -$58.00 → -$54.10 | +$3.90 |
| KXBTCD-24FEB29-50000 | 2024-01-31→2024-02-29 | +43.79% | YES | YES | $12.97 | $0.00 | $28.00 → $15.03 | -$12.97 |
| KXBTCD-24MAR28-60000 | 2024-02-29→2024-03-28 | +15.73% | YES | YES | $11.89 | $0.00 | $26.00 → $14.11 | -$11.89 |
| KXBTCD-24APR30-65000 | 2024-04-01→2024-04-30 | -13% | NO | NO | $15.11 | $23.18 | -$61.00 → -$52.93 | +$8.07 |
| KXBTCD-24MAY31-65000 | 2024-05-01→2024-05-31 | +15.8% | NO ⚠ | YES | $14.01 | $0.00 | $45.00 → $30.99 | -$14.01 |
| KXBTCD-24JUN28-65000 | 2024-06-01→2024-06-28 | -10.94% | NO | NO | $13.43 | $17.25 | -$48.00 → -$44.19 | +$3.81 |
| KXBTCD-24JUL31-65000 | 2024-07-01→2024-07-31 | +2.83% | NO | NO | $12.17 | $13.50 | -$45.00 → -$43.67 | +$1.33 |
| KXBTCD-24AUG30-60000 | 2024-07-31→2024-08-30 | -8.51% | NO | NO | $13.55 | $18.43 | -$55.00 → -$50.12 | +$4.88 |
| KXBTCD-24SEP27-60000 | 2024-09-01→2024-09-27 | +14.82% | YES | YES | $14.43 | $0.00 | $40.00 → $25.57 | -$14.43 |
| KXBTCD-24OCT31-65000 | 2024-10-01→2024-10-31 | +15.48% | YES | YES | $12.40 | $0.00 | $30.00 → $17.60 | -$12.40 |
| KXBTCD-24NOV29-80000 | 2024-11-01→2024-11-29 | +40.34% | YES | YES | $12.47 | $0.00 | $38.00 → $25.53 | -$12.47 |
| KXBTCD-24DEC31-100000 | 2024-12-01→2024-12-31 | -4.02% | NO | NO | $13.49 | $21.60 | -$72.00 → -$63.89 | +$8.11 |
| KXBTCD-25JAN31-100000 | 2025-01-01→2025-01-31 | +8.51% | YES | YES | $12.70 | $0.00 | $32.00 → $19.30 | -$12.70 |
| KXBTCD-25FEB28-100000 | 2025-02-01→2025-02-28 | -16.22% | NO | NO | $13.09 | $23.91 | -$58.00 → -$47.18 | +$10.82 |
| KXBTCD-25MAR28-90000 | 2025-03-01→2025-03-28 | -1.9% | NO | NO | $12.85 | $15.60 | -$52.00 → -$49.25 | +$2.75 |
| KXBTCD-25APR30-90000 | 2025-04-01→2025-04-30 | +10.58% | YES | YES | $13.95 | $0.00 | $52.00 → $38.05 | -$13.95 |
| KXBTCD-25MAY30-95000 | 2025-05-01→2025-05-30 | +7.78% | YES | YES | $13.97 | $0.00 | $44.00 → $30.03 | -$13.97 |
| KXBTCD-25JUN27-100000 | 2025-06-01→2025-06-27 | +1.34% | YES | YES | $11.11 | $0.00 | $28.00 → $16.89 | -$11.11 |
| KXBTCD-25JUL31-105000 | 2025-07-01→2025-07-31 | +9.51% | YES | YES | $11.88 | $0.00 | $35.00 → $23.12 | -$11.88 |
| KXBTCD-25AUG29-110000 | 2025-08-01→2025-08-29 | -4.3% | NO | NO | $10.52 | $21.00 | -$70.00 → -$59.52 | +$10.48 |
| KXBTCD-25SEP26-95000 | 2025-09-01→2025-09-26 | +0.42% | YES | YES | $12.34 | $0.00 | $40.00 → $27.66 | -$12.34 |
| KXBTCD-25OCT31-100000 | 2025-10-01→2025-10-31 | -7.67% | YES | YES | $11.45 | $1.74 | $35.00 → $25.29 | -$9.71 |
| KXBTCD-25NOV28-110000 | 2025-11-01→2025-11-28 | -17.4% | YES ⚠ | NO | $12.75 | $26.29 | -$62.00 → -$48.46 | +$13.54 |
| KXBTCD-25DEC31-115000 | 2025-12-01→2025-12-31 | +1.41% | NO | NO | $13.50 | $16.50 | -$55.00 → -$52.00 | +$3.00 |
| KXBTCD-26JAN30-95000 | 2026-01-01→2026-01-30 | -5.21% | NO | NO | $11.99 | $17.52 | -$58.00 → -$52.47 | +$5.53 |
| KXBTCD-26FEB27-90000 | 2026-02-01→2026-02-27 | -14.35% | NO | NO | $13.08 | $21.64 | -$55.00 → -$46.44 | +$8.56 |
| KXBTCD-26MAR27-85000 | 2026-03-01→2026-03-27 | +0.89% | YES ⚠ | NO | $14.99 | $15.60 | -$52.00 → -$51.39 | +$0.61 |

---

## Notes & caveats

- "Outcome mismatch" rows mark cases where the curated dataset's recorded outcome disagrees with the outcome derived from BTC daily-close at settle. 4 flagged. The economics in this report use **derived** outcomes for self-consistency.
- Put-spread pricing (Lite, Standard, Shield+ overlay): direct Black-Scholes on actual BTC strikes, realized-vol-derived IV with empirical skew.
- Shield NO-leg pricing: $1 face × NO probability ((100 − YES)/100) plus 3% Kalshi fee on NO settlement.
- Spread payouts: Atticus owns a fully-hedged Deribit put spread per user position (cash-flow pass-through on triggered trades).
- Shield NO-leg payouts: Atticus buys NO contracts on Kalshi sized to the user's rebate floor (cash-flow pass-through on Kalshi loss).
- Shield is the only tier that delivers a contract-deterministic floor. v2 tiers' worst case is unbounded by protection (BTC-path-dependent); Shield's is bounded by the rebate floor.
- Volume scaling factor `7407` matches v1 (assumes ~$750k notional × 27 markets ≈ $20M dataset).

**See `EVAL_AND_NEXT_STEPS.md` for the threshold framework, full v2 evaluation, and Shield design rationale.**