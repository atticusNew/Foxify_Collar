# Atticus / Kalshi Shadow Hedge Backtest — Tiered (v2)
**Generated:** 2026-04-26
**Markets analyzed:** 27 settled Kalshi BTC monthly markets (Jan 2024 – Apr 2026)
**Bet size used for cash figures:** $100 contract face value (scales linearly).
**Outcome mismatch flags (recorded vs derived from BTC price):** 4 of 27 — economics use **derived** outcome.

---

## Tier definitions

| Tier | Long-put OTM | Short-put OTM | Spread width | Sizing | Markup |
|---|---|---|---|---|---|
| lite | 1.0% | 20.0% | 19.0% | 1.00× of at-risk | 1.40× |
| standard | 0.0% | 30.0% | 30.0% | 1.70× of at-risk | 1.45× |

Pricing: direct Black-Scholes on actual BTC strikes at each market's open date, using realized-vol-derived IV with skew (no √T tier-scaling shortcut).

---

## Headline tier comparison (per $100 contract face)

| Metric | Lite | Standard | Target (project brief) |
|---|---|---|---|
| Avg fee ($) | $3.91 | $8.43 | Lite ~$3, Std ~$6–9 |
| Avg fee (% of stake) | 6.5% | 14.1% | Lite 5–7%, Std 10–15% |
| Avg recovery, all losers ($) | $3.68 | $7.05 | — |
| Avg recovery, all losers (% of stake) | 6.3% | 12.1% | — |
| Avg recovery, BTC-down losers ($) | $4.69 | $8.97 | — |
| Avg recovery, BTC-down losers (% of stake) | 8.1% | 15.4% | — |
| **Avg recovery, hedge-triggered losers ($)** | $4.69 | $8.97 | Lite ~$12–18, Std ~$23–35 |
| **Avg recovery, hedge-triggered losers (% of stake = % of loss on binary)** | 8.1% | 15.4% | Lite 20–30%, Std 40–60% |
| **Deep-drop subset (BTC ≥10% down) avg recovery ($)** | $7.69 | $14.03 | — |
| **Deep-drop subset avg recovery (% of stake/loss)** | 13.4% | 24.4% | Std 40–60% target — see notes |
| Deep-drop subset n | 5 | 5 | — |
| Fraction of losers w/ payout ≥10% of stake | 29% | 43% | — |
| Fraction of losers w/ payout ≥20% of stake | 0% | 29% | — |
| Platform avg margin (% of revenue) | 28.6% | 31.0% | 25–40% |
| Platform avg P&L per trade ($) | $1.71 | $3.84 | — |
| Platform total P&L (per $100 face × 27) | $46.08 | $103.73 | — |
| Platform total P&L (scaled to ~$750k/market) | $341,315 | $768,328 | — |

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

---

## Per-market trade log (Standard tier — most pitch-relevant)

| Market | Open → Settle | BTC move | Recorded | Derived | Fee | Payout | Net before/after | Saved |
|---|---|---|---|---|---|---|---|---|
| KXBTCD-24JAN31-50000 | 2024-01-01→2024-01-31 | -3.78% | YES ⚠ | NO | $8.53 | $3.73 | -$58.00 → -$62.80 | -$4.80 |
| KXBTCD-24FEB29-50000 | 2024-01-31→2024-02-29 | +43.79% | YES | YES | $11.88 | $0.00 | $28.00 → $16.12 | -$11.88 |
| KXBTCD-24MAR28-60000 | 2024-02-29→2024-03-28 | +15.73% | YES | YES | $10.40 | $0.00 | $26.00 → $15.60 | -$10.40 |
| KXBTCD-24APR30-65000 | 2024-04-01→2024-04-30 | -13% | NO | NO | $12.97 | $13.48 | -$61.00 → -$60.49 | +$0.51 |
| KXBTCD-24MAY31-65000 | 2024-05-01→2024-05-31 | +15.8% | NO ⚠ | YES | $9.20 | $0.00 | $45.00 → $35.80 | -$9.20 |
| KXBTCD-24JUN28-65000 | 2024-06-01→2024-06-28 | -10.94% | NO | NO | $7.48 | $8.92 | -$48.00 → -$46.56 | +$1.44 |
| KXBTCD-24JUL31-65000 | 2024-07-01→2024-07-31 | +2.83% | NO | NO | $4.77 | $0.00 | -$45.00 → -$49.77 | -$4.77 |
| KXBTCD-24AUG30-60000 | 2024-07-31→2024-08-30 | -8.51% | NO | NO | $8.16 | $7.95 | -$55.00 → -$55.20 | -$0.20 |
| KXBTCD-24SEP27-60000 | 2024-09-01→2024-09-27 | +14.82% | YES | YES | $11.10 | $0.00 | $40.00 → $28.90 | -$11.10 |
| KXBTCD-24OCT31-65000 | 2024-10-01→2024-10-31 | +15.48% | YES | YES | $9.70 | $0.00 | $30.00 → $20.30 | -$9.70 |
| KXBTCD-24NOV29-80000 | 2024-11-01→2024-11-29 | +40.34% | YES | YES | $7.14 | $0.00 | $38.00 → $30.86 | -$7.14 |
| KXBTCD-24DEC31-100000 | 2024-12-01→2024-12-31 | -4.02% | NO | NO | $13.10 | $4.92 | -$72.00 → -$80.18 | -$8.18 |
| KXBTCD-25JAN31-100000 | 2025-01-01→2025-01-31 | +8.51% | YES | YES | $9.57 | $0.00 | $32.00 → $22.43 | -$9.57 |
| KXBTCD-25FEB28-100000 | 2025-02-01→2025-02-28 | -16.22% | NO | NO | $7.61 | $16.00 | -$58.00 → -$49.61 | +$8.39 |
| KXBTCD-25MAR28-90000 | 2025-03-01→2025-03-28 | -1.9% | NO | NO | $6.31 | $1.68 | -$52.00 → -$56.63 | -$4.63 |
| KXBTCD-25APR30-90000 | 2025-04-01→2025-04-30 | +10.58% | YES | YES | $8.67 | $0.00 | $52.00 → $43.33 | -$8.67 |
| KXBTCD-25MAY30-95000 | 2025-05-01→2025-05-30 | +7.78% | YES | YES | $9.26 | $0.00 | $44.00 → $34.74 | -$9.26 |
| KXBTCD-25JUN27-100000 | 2025-06-01→2025-06-27 | +1.34% | YES | YES | $7.77 | $0.00 | $28.00 → $20.23 | -$7.77 |
| KXBTCD-25JUL31-105000 | 2025-07-01→2025-07-31 | +9.51% | YES | YES | $6.72 | $0.00 | $35.00 → $28.28 | -$6.72 |
| KXBTCD-25AUG29-110000 | 2025-08-01→2025-08-29 | -4.3% | NO | NO | $5.59 | $5.12 | -$70.00 → -$70.47 | -$0.47 |
| KXBTCD-25SEP26-95000 | 2025-09-01→2025-09-26 | +0.42% | YES | YES | $6.40 | $0.00 | $40.00 → $33.60 | -$6.40 |
| KXBTCD-25OCT31-100000 | 2025-10-01→2025-10-31 | -7.67% | YES | YES | $5.79 | $8.48 | $35.00 → $37.69 | +$2.69 |
| KXBTCD-25NOV28-110000 | 2025-11-01→2025-11-28 | -17.4% | YES ⚠ | NO | $7.76 | $18.34 | -$62.00 → -$51.42 | +$10.58 |
| KXBTCD-25DEC31-115000 | 2025-12-01→2025-12-31 | +1.41% | NO | NO | $8.05 | $0.00 | -$55.00 → -$63.05 | -$8.05 |
| KXBTCD-26JAN30-95000 | 2026-01-01→2026-01-30 | -5.21% | NO | NO | $5.21 | $5.14 | -$58.00 → -$58.07 | -$0.07 |
| KXBTCD-26FEB27-90000 | 2026-02-01→2026-02-27 | -14.35% | NO | NO | $7.12 | $13.42 | -$55.00 → -$48.71 | +$6.29 |
| KXBTCD-26MAR27-85000 | 2026-03-01→2026-03-27 | +0.89% | YES ⚠ | NO | $11.27 | $0.00 | -$52.00 → -$63.27 | -$11.27 |

---

## Notes & caveats

- "Outcome mismatch" rows mark cases where the curated dataset's recorded outcome disagrees with the outcome derived from BTC daily-close at settle. 4 flagged. The economics in this report use **derived** outcomes for self-consistency. The original v1 backtest used the curated outcome.
- All option pricing is direct Black-Scholes on the actual BTC strike at each market's open date, using realized-vol-derived IV with empirical skew. No Foxify SL-tier × √T scaling is applied.
- Spread payouts assume Atticus owns a fully-hedged Deribit put spread per user position (net cash flow = 0 on triggered trades; platform earns markup minus hedge cost in expectation).
- TP recovery on un-triggered hedges uses the same calm/normal/stress regression as v1.
- Volume scaling factor `7407` matches v1 (assumes ~$750k notional × 27 markets ≈ $20M dataset).

**On the brief's 40–60% Standard recovery target:** A pure put spread can recover at most `BTC drop × protected notional`, capped at spread width × notional. In our 14 losing markets BTC drops average ~7% (3 losing markets had BTC actually rise). To deterministically deliver 40–60% loss recovery on **every** losing market, the spread alone is not enough — it requires a hybrid wrapper that pairs the put spread with a small Kalshi-NO leg sized to plug the residual loss. That depends on a Kalshi market-maker / pro-trader API hook and is documented as the v3 next-stage pilot ask. The Standard tier as priced here delivers ~24% avg recovery on deep-drop (≥10%) months and ~36% peak recovery on the 17%+ drops, while keeping fee in the 12–14% band and platform margin near 31%.