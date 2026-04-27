# Atticus → Kalshi Pitch Snippets — Options-Hedge Bridge

Atticus is an options-procurement bridge between Kalshi traders and Deribit. We don't act as a Kalshi market maker, we don't take the other side of bets. We route real BTC vertical-spread hedges from Deribit (~$30B BTC options OI) to Kalshi traders in a single combined-ticket flow.

*Live Deribit calibration: BTC index $79166, 932 listed contracts.*

---

## Intro Email

**Subject:** Options-hedge bridge for your BTC bettors — Deribit liquidity, single-ticket execution

**Body:**
```
We've built a thin layer that lets a Kalshi user buy a BTC bet and a real Deribit BTC vertical-spread hedge in one ticket. The hedge is procured from the live Deribit chain (we don't take the other side of your binary, we don't make a market) — pure pass-through.

Across 68 settled BTC markets in our backtest:
  • Light tier (5%-OTM long leg): ~2% fee of stake, 2.4% fee of notional, 7.7× recovery ratio.
  • Standard (2%-OTM):              ~4% / 4.2% / 5.8× recovery.
  • Shield (ATM):                   ~6% / 6.4% / 5.5× recovery.
  • Shield-Max (ATM, 2× sized):     ~13% / 6.4% / 5.5× recovery.

What's interesting for Kalshi specifically:
  • A Kalshi MM cannot sell a 30-day BTC put. We can. This is incremental options depth your platform doesn't currently access.
  • At 6.4% of notional on Shield, the cost is competitive with bank-OTC verticals — but your traders get it inline.
  • Capital-policy unlock: institutional users who today can't size into Kalshi BTC contracts (because the binary 100% loss is unbounded) can with this overlay.

Atticus revenue: 13% net margin on the markup. Today's BTC volume scales to a modest revenue line for both sides; the strategic value is the institutional-distribution unlock, which can grow Kalshi's BTC TAM 10×.

We're already live on Foxify with a related drawdown-protection product. We'd like 30 minutes to walk through the mechanism, the per-tier economics, and a zero-integration shadow pilot.
```

---

## Tier Cash Story

On a typical Kalshi BTC contract @ 58¢ YES (≈ $58 at risk on a $100 face):

| | Light | Standard | **Shield** | **Shield-Max** |
|---|---|---|---|---|
| Geometry | 5%-OTM | 2%-OTM | ATM | ATM, 2× sized |
| Premium | $1.22 | $2.14 | **$3.21** | **$6.42** |
| Cost as % of protected notional | 2.43% | 4.23% | **6.35%** | **6.35%** |
| Max payout / premium | 7.7× | 5.8× | 5.5× | 5.5× |
| Avg recovery on losing markets | 4% of stake | 6% | 10% | 19% |
| Best save in dataset | $2.49 | $4.21 | **$5.18** | **$10.36** |

---

## Mechanic explainer

```
Trader buys "BTC > $80,000 by May 30" YES on Kalshi for $58.

At entry, Atticus simultaneously buys (on Deribit):
  Long  BTC-29MAY26-80000-P  (an ATM put expiring same day as Kalshi)
  Short BTC-29MAY26-71000-P  (a 12%-OTM put — the floor)

Net cost from the live Deribit chain: about ~6.4% of BTC notional.
Atticus charges the trader: cost × 1.22 markup = ~6% of their $58 stake.

If BTC ends ≥ $80k:
  Kalshi pays the trader $100. The Deribit spread expires worthless.
  Atticus keeps the markup minus 20% TP-salvage on un-triggered spread.

If BTC ends at $73k:
  Kalshi pays $0 (trader loses $58).
  The Deribit spread pays out: (80000 - 73000)/79000 × notional = ~9% × notional.
  Atticus passes the Deribit fill to trader. Trader's net loss is ~half of unprotected.

In every case, Atticus is just procuring a real options trade. We don't take the binary's other side.
```

---

*Trade-by-trade log: `kalshi_rebuild_trades.csv` | Tier mechanics: `kalshi_rebuild_summary.md`*