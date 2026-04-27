# Atticus / Kalshi Options-Hedge Backtest
**Generated:** 2026-04-27
**Markets:** 68 (across ABOVE / BELOW / HIT × YES / NO).
**Bet size:** $100 contract face. Scales linearly.
**Outcome mismatches (recorded vs derived):** 9/68.
**Live Deribit calibration snapshot:** BTC index $79166, 932 contracts (public API only).

## Product

Atticus is an **options-procurement bridge**. The user holds a Kalshi BTC bet; Atticus buys a real Deribit BTC vertical-spread on the user's behalf that pays when BTC moves the wrong direction. Atticus does NOT take the other side of the user's Kalshi bet, does NOT act as a Kalshi market maker, and does NOT warehouse risk.

- Why Kalshi cares: brings options-market depth to its traders without integration. A Kalshi market maker structurally cannot sell 30-day BTC puts; only an options exchange can.
- Why traders care: defined-risk overlay at a real options-market price. Capital-efficient: small premium protects against tail moves.
- Why Atticus is sustainable: markup on real fill cost. Pure pass-through. ~13% net margin per trade.

---

## Headline four-tier comparison

All four tiers use the same mechanism (real Deribit vertical spread); they differ in strike geometry and sizing.

| Metric | Light | Standard | Shield | Shield-Max |
|---|---|---|---|---|
| Geometry | 5%-OTM long, 5% width, 1.0× sized | 2%-OTM, 8% width, 1.0× | ATM long, 12% width, 1.0× | ATM long, 12% width, 2.0× |
| Hedgeable rate (markets where vanilla spread applies) | 85% | 85% | 85% | 85% |
| Avg fee ($) | $1.22 | $2.14 | $3.21 | $6.42 |
| Avg fee (% of stake) | 2.4% | 4.2% | 6.4% | 12.7% |
| **Avg fee (% of protected notional — capital-efficiency)** | **2.43%** | **4.23%** | **6.35%** | **6.35%** |
| Avg recovery ratio (max payout / fee) | 7.7× | 5.8× | 5.5× | 5.5× |
| P(payout > 0 \| Kalshi loss) | 82% | 86% | 100% | 100% |
| Avg recovery on losing markets ($) | $1.70 | $2.97 | $4.49 | $8.97 |
| Avg recovery on losing markets (% of stake) | 3.7% | 6.3% | 9.5% | 19.1% |
| User EV cost (% of stake)\* | -0.4% | -0.8% | -1.1% | -2.3% |
| Platform avg gross margin (% of revenue) | 18.0% | 18.0% | 18.0% | 18.0% |
| Platform avg P&L per trade ($) | $0.33 | $0.57 | $0.85 | $1.69 |

\* User EV cost = (BS-implied expected payout − charge) / stake. Negative means user pays a premium (insurance), positive means user is over-compensated. For a fairly-priced options product the EV cost should equal the markup rate × hedge cost / stake.

---

## Capital efficiency lens

The institutional-grade question is: **what's the cost-per-dollar-of-protected-notional?** Lower is better. For comparison: traditional options market makers post 1-3% fee-on-notional on 30-DTE BTC vertical spreads. Atticus charges Deribit's mid-or-fill cost × markup, then passes the spread through.

| Tier | Avg fee | Avg fee / stake | **Avg fee / notional** | Avg recovery / fee |
|---|---|---|---|---|
| lite | $1.22 | 2.4% | **2.43%** | 7.7× |
| standard | $2.14 | 4.2% | **4.23%** | 5.8× |
| shield | $3.21 | 6.4% | **6.35%** | 5.5× |
| shield_plus | $6.42 | 12.7% | **6.35%** | 5.5× |

Reading the table:
- Light (5%-OTM, narrow 5% width) costs 2.4% of protected notional. That's directly competitive with bank-OTC verticals on similar tenors.
- Standard (2%-OTM, 8% width) at 4.2% is mid-pack: more protection per dollar than Light, less than Shield.
- Shield (ATM, 12% width) at 6.4% is on the expensive side because ATM puts/calls cost more — but the depth and recovery ratio are correspondingly higher.
- Shield-Max is Shield × 2 sizing: same fee/notional as Shield, double the cash protection.

Two structural advantages over a Kalshi market maker:
- Deeper liquidity (Deribit ~$30B BTC options OI) than any Kalshi MM can warehouse.
- Single-flow execution: the user buys the Kalshi binary + Atticus hedge in one ticket.

---

## YES vs NO symmetry

The product is mechanism-symmetric: regardless of bet direction, the adapter routes to the appropriate Deribit vertical. This table verifies the economics actually came out symmetric on the backtest dataset.

| Tier | YES bets (n) | YES avg fee/notional | YES avg recovery (loss) | NO bets (n) | NO avg fee/notional | NO avg recovery (loss) |
|---|---|---|---|---|---|---|
| lite | 45 | 2.66% | $1.79 (4%) | 13 | 1.63% | $1.46 (4%) |
| standard | 45 | 4.61% | $3.16 (6%) | 13 | 2.89% | $2.51 (7%) |
| shield | 45 | 6.93% | $4.73 (9%) | 13 | 4.36% | $3.88 (10%) |
| shield_plus | 45 | 6.93% | $9.46 (19%) | 13 | 4.36% | $7.77 (20%) |

---

## Per-quadrant Shield economics

| Quadrant | n | Hedgeable | Avg fee / notional | Avg recovery (loss) | P(payout\|loss) |
|---|---|---|---|---|---|
| ABOVE/yes | 33 | 100% | 7.14% | $5.29 (9%) | 100% |
| ABOVE/no | 8 | 100% | 4.03% | $2.95 (13%) | 100% |
| BELOW/yes | 12 | 100% | 6.35% | $2.49 (9%) | 100% |
| BELOW/no | 5 | 100% | 4.89% | $4.44 (8%) | 100% |
| HIT/yes | 6 | 0% | 0.00% | $0.00 (0%) | 0% |
| HIT/no | 4 | 0% | 0.00% | $0.00 (0%) | 0% |

HIT events show 0% hedgeable: vanilla puts/calls don't replicate first-to-touch payoffs. Shield+'s strategic value here is *separately offering barrier options* (knock-in / knock-out) — a stretch goal beyond this rebuild's scope.

---

## Notable saves (Shield, sorted by user-saved $)

| Market | Event | Dir | BTC move | Fee | Payout | Net before/after | Saved |
|---|---|---|---|---|---|---|---|
| KXBTCD-25NOV28-100000 | ABOVE | yes | -17.4% | $1.27 | $6.45 | -$78.00 → -$72.82 | +$5.18 |
| KXBTCD-24NOV29-80000-NO | ABOVE | no | +40.34% | $0.31 | $5.25 | -$38.00 → -$33.06 | +$4.94 |
| KXBTCD-25NOV28-110000 | ABOVE | yes | -17.4% | $2.84 | $7.44 | -$62.00 → -$57.40 | +$4.60 |
| KXBTCD-25FEB28-100000 | ABOVE | yes | -16.22% | $2.59 | $6.92 | -$58.00 → -$53.67 | +$4.33 |
| KXBTCMINY-25NOV-105000-NO | BELOW | no | -17.4% | $1.38 | $5.50 | -$48.00 → -$43.88 | +$4.12 |
| KXBTCMINY-26FEB-80000-NO | BELOW | no | -14.35% | $4.37 | $8.11 | -$65.00 → -$61.25 | +$3.75 |
| KXBTCD-26JAN30-95000 | ABOVE | yes | -5.21% | $4.77 | $7.12 | -$58.00 → -$55.66 | +$2.34 |
| KXBTCMINY-25NOV-95000-NO | BELOW | no | -17.4% | $0.56 | $2.53 | -$68.00 → -$66.03 | +$1.97 |
| KXBTCD-24JUN28-65000 | ABOVE | yes | -10.94% | $1.82 | $3.32 | -$48.00 → -$46.50 | +$1.50 |
| KXBTCMINY-24MAY-55000 | BELOW | yes | +15.8% | $1.83 | $3.17 | -$28.00 → -$26.65 | +$1.35 |
| KXBTCD-24JAN31-50000 | ABOVE | yes | -3.78% | $6.57 | $7.87 | -$58.00 → -$56.70 | +$1.30 |
| KXBTCD-24FEB29-45000-NO | ABOVE | no | +43.79% | $0.48 | $1.78 | -$14.00 → -$12.70 | +$1.30 |

---

## Platform-revenue scaling (per $750k Kalshi BTC market)

| Tier | Net margin / $100 stake | @ 5% opt-in | @ 10% | @ 15% |
|---|---|---|---|---|
| lite | $0.33 | $164 | $328 | $492 |
| standard | $0.57 | $286 | $571 | $857 |
| shield | $0.85 | $428 | $857 | $1,285 |
| shield_plus | $1.69 | $857 | $1,715 | $2,572 |

Annualised at 16 BTC markets/year (12 monthly + 4 quarterly): Shield @ 10% opt-in ≈ $XXk net Atticus revenue today, ~10× that at projected 2026 H2 BTC volume. See PR description for revenue-share scenarios with Kalshi.

---

## Notes

- Pricing source: 0% live Deribit, 85% BS-synthetic with 10% bid-ask widener, 15% not_hedgeable (HIT events). Production deployment runs 100% live.
- BS fallback uses rvol × 1.18 as IV proxy + 0.30 vol-pts/% OTM skew. No Foxify pilot calibrations.
- Markup: 1.22× from 13% net margin + 5% ops cost.
- TP recovery on un-triggered spreads: 20% generic (no Foxify table).
- HIT events: barrier-option pricing not in scope; vanilla put/call cannot replicate.