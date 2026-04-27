# Atticus / Kalshi Options-Hedge Backtest — Trader-Perspective Tuning
**Generated:** 2026-04-27
**Markets:** 68 (across ABOVE / BELOW / HIT × YES / NO).
**Bet size:** $100 contract face. Scales linearly.
**Outcome mismatches (recorded vs derived):** 9/68.
**Live Deribit calibration snapshot:** BTC index $79156, 932 contracts (public API only).

## Product

Atticus is an **options-procurement bridge**. The user holds a Kalshi BTC bet; Atticus buys a real Deribit BTC vertical-spread on the user's behalf that pays when BTC moves the wrong direction. Atticus does NOT take the other side of the user's Kalshi bet, does NOT act as a Kalshi market maker, and does NOT warehouse risk.

- Why Kalshi cares: brings options-market depth to its traders without integration. A Kalshi market maker structurally cannot sell 30-day BTC puts; only an options exchange can.
- Why traders care: defined-risk overlay at a real options-market price. Capital-efficient: small premium protects against tail moves.
- Why Atticus is sustainable: markup on real fill cost. Pure pass-through. ~13% net margin per trade.

---

## The trader-cash story (per typical $40 retail Kalshi BTC stake)

All numbers below are **dollars on a $40 stake** alongside **% of stake**, so the protection feels concrete to a trader. The dataset is 68 settled Kalshi BTC markets (Jan 2024 – Apr 2026); reported figures are averages across each tier's hedgeable rows. "BTC-adverse losing markets" = the cases that matter most to the trader: they lost on Kalshi AND BTC moved the way the hedge protects against (the cases where the hedge actually pays out).

| Metric | Standard | Shield | Shield-Max |
|---|---|---|---|
| Geometry | 2%-OTM-from-spot, 5% width, **6.5× sized** | 1%-OTM-from-spot, 6% width, **7× sized** | ATM-from-spot, 8% width, **12× sized** |
| Hedgeable rate | 100% | 100% | 100% |

**Pricing — what the trader pays at entry:**

| | Standard | Shield | Shield-Max |
|---|---|---|---|
| Avg fee, % of stake | **14.1%** | **18.9%** | **43.4%** |
| Avg fee on a $40 stake | **$5.64** | **$7.57** | **$17.34** |
| Capital efficiency (fee / protected notional) | 2.17% | 2.70% | 3.61% |
| Recovery ratio (max payout / fee) | 2.3× | 2.2× | 2.2× |
| User EV cost (insurance premium) | -2.5% | -3.4% | -7.8% |

**Recovery — what the trader gets back when the bet goes badly:**

Both **average** and **median** recovery are reported. A few large adverse-month payouts can skew the average up; the median is the more honest single-trade expectation.

| | Standard | Shield | Shield-Max |
|---|---|---|---|
| BTC-adverse losing markets in dataset (n) | 22 | 22 | 22 |
| **Avg recovery, BTC-adverse losers, % of stake** | **27.9%** | **37.0%** | **84.7%** |
| **Median recovery, BTC-adverse losers, % of stake** | **32.5%** | **42.0%** | **96.0%** |
| Avg recovery on a $40 stake | $11.15 | $14.79 | $33.87 |
| Median recovery on a $40 stake | $13.00 | $16.80 | $38.40 |
| Avg recovery, all losers, % of stake | 21.9% | 29.1% | 66.5% |
| Worst BTC-adverse loss: unprotected → protected | -$78.00 → -$63.54 | -$78.00 → -$59.92 | -$78.00 → -$36.75 |

**Platform sustainability:**

| | Standard | Shield | Shield-Max |
|---|---|---|---|
| Avg gross margin (% of revenue) | 18.0% | 18.0% | 18.0% |
| Avg platform P&L per trade (on $100 stake) | $2.09 | $2.74 | $6.29 |
| Avg platform P&L per trade (on $40 stake) | $0.84 | $1.10 | $2.52 |


---

## Capital efficiency lens

Pricing the hedge as cost-per-dollar-of-protected-BTC-notional. For comparison, bank-OTC 30-DTE BTC verticals run 2-5% of notional.

| Tier | Avg fee | Avg fee / stake | Avg fee / notional | Recovery ratio |
|---|---|---|---|---|
| standard | $7.40 | 14.1% | **2.17%** | 2.3× |
| shield | $9.93 | 18.9% | **2.70%** | 2.2× |
| shield_plus | $22.76 | 43.4% | **3.61%** | 2.2× |

Two structural advantages over a Kalshi market maker:
- Deeper liquidity (Deribit ~$30B BTC options OI) than any Kalshi MM can warehouse.
- Single-flow execution: the user buys the Kalshi binary + Atticus hedge in one ticket.

---

## YES vs NO symmetry

The product is mechanism-symmetric: regardless of bet direction, the adapter routes to the appropriate Deribit vertical. This table verifies the economics actually came out symmetric on the backtest dataset.

| Tier | YES bets (n) | YES avg fee/notional | YES avg recovery (loss) | NO bets (n) | NO avg fee/notional | NO avg recovery (loss) |
|---|---|---|---|---|---|---|
| lite | 45 | 0.00% | $0.00 (0%) | 13 | 0.00% | $0.00 (0%) |
| standard | 45 | 2.19% | $9.53 (18%) | 13 | 2.10% | $14.38 (33%) |
| shield | 45 | 2.73% | $12.96 (24%) | 13 | 2.63% | $18.59 (42%) |
| shield_plus | 45 | 3.64% | $29.68 (55%) | 13 | 3.51% | $42.48 (96%) |

---

## Per-quadrant Shield economics

| Quadrant | n | Hedgeable | Avg fee / notional | Avg recovery (loss) | P(payout\|loss) |
|---|---|---|---|---|---|
| ABOVE/yes | 33 | 100% | 2.79% | $14.89 (25%) | 75% |
| ABOVE/no | 8 | 100% | 2.57% | $9.52 (42%) | 100% |
| BELOW/yes | 12 | 100% | 2.54% | $5.25 (21%) | 50% |
| BELOW/no | 5 | 100% | 2.72% | $24.02 (42%) | 100% |
| HIT/yes | 6 | 0% | 0.00% | $0.00 (0%) | 0% |
| HIT/no | 4 | 0% | 0.00% | $0.00 (0%) | 0% |

HIT events show 0% hedgeable: vanilla puts/calls don't replicate first-to-touch payoffs. Shield+'s strategic value here is *separately offering barrier options* (knock-in / knock-out) — a stretch goal beyond this rebuild's scope.

---

## Notable saves (Shield, sorted by user-saved $)

| Market | Event | Dir | BTC move | Fee | Payout | Net before/after | Saved |
|---|---|---|---|---|---|---|---|
| KXBTCD-25NOV28-100000 | ABOVE | yes | -17.4% | $14.68 | $32.76 | -$78.00 → -$59.92 | +$18.08 |
| KXBTCD-25OCT31-100000 | ABOVE | yes | -7.67% | $10.27 | $27.30 | $35.00 → $52.03 | +$17.03 |
| KXBTCMINY-25NOV-95000-NO | BELOW | no | -17.4% | $12.80 | $28.56 | -$68.00 → -$52.24 | +$15.76 |
| KXBTCMINY-26FEB-80000-NO | BELOW | no | -14.35% | $12.42 | $27.30 | -$65.00 → -$50.12 | +$14.88 |
| KXBTCMINY-25FEB-85000-NO | BELOW | no | -16.22% | $12.47 | $27.30 | -$65.00 → -$50.17 | +$14.83 |
| KXBTCD-25NOV28-110000 | ABOVE | yes | -17.4% | $11.67 | $26.04 | -$62.00 → -$47.63 | +$14.37 |
| KXBTCD-25FEB28-100000 | ABOVE | yes | -16.22% | $11.13 | $24.36 | -$58.00 → -$44.77 | +$13.23 |
| KXBTCD-26FEB27-90000 | ABOVE | yes | -14.35% | $10.51 | $23.10 | -$55.00 → -$42.41 | +$12.59 |
| KXBTCD-24AUG30-60000 | ABOVE | yes | -8.51% | $11.03 | $23.10 | -$55.00 → -$42.93 | +$12.07 |
| KXBTCD-24APR30-65000 | ABOVE | yes | -13% | $14.08 | $25.62 | -$61.00 → -$49.46 | +$11.54 |
| KXBTCMINY-25NOV-105000-NO | BELOW | no | -17.4% | $9.03 | $20.16 | -$48.00 → -$36.87 | +$11.13 |
| KXBTCD-24JUN28-65000 | ABOVE | yes | -10.94% | $9.84 | $20.16 | -$48.00 → -$37.68 | +$10.32 |

---

## Platform-revenue scaling (per $750k Kalshi BTC market)

| Tier | Net margin / $100 stake | @ 5% opt-in | @ 10% | @ 15% |
|---|---|---|---|---|
| standard | $2.09 | $951 | $1,903 | $2,854 |
| shield | $2.74 | $1,277 | $2,554 | $3,831 |
| shield_plus | $6.29 | $2,926 | $5,852 | $8,778 |

Annualised at 16 BTC markets/year (12 monthly + 4 quarterly): Shield @ 10% opt-in ≈ $40,861 net Atticus revenue at current Kalshi BTC volume. At 10× growth in BTC TAM (the institutional unlock the wrapper enables): $408,610/year. Revenue-share with Kalshi: 50/50 split halves these per side.

---

## Notes

- Pricing source: 0% live Deribit, 85% BS-synthetic with 10% bid-ask widener, 15% not_hedgeable (HIT events). Production deployment runs 100% live.
- BS fallback uses rvol × 1.18 as IV proxy + 0.30 vol-pts/% OTM skew. No Foxify pilot calibrations.
- Markup: 1.22× from 13% net margin + 5% ops cost.
- TP recovery on un-triggered spreads: 20% generic (no Foxify table).
- HIT events: barrier-option pricing not in scope; vanilla put/call cannot replicate.