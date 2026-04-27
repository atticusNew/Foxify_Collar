# Atticus → Kalshi Pitch Snippets — Trader-Cash Story

Atticus is an options-procurement bridge: we route real Deribit BTC vertical-spread hedges to Kalshi traders in a single combined-ticket flow. We don't act as a Kalshi market maker, we don't take the other side of bets. Below: trader-perspective economics on a typical $40 retail Kalshi BTC stake.

*Live Deribit calibration: BTC index $79156, 932 listed contracts.*

---

## Intro Email

**Subject:** Options-hedge bridge for your BTC traders — meaningful cash recovery on a $40 stake

**Body:**
```
We built a thin overlay that lets a Kalshi user buy a BTC bet and a real Deribit BTC vertical-spread hedge in one ticket. We don't take the other side of your binary, we don't make a market — we procure a real options trade and pass it through.

On a typical $40 retail Kalshi BTC stake:

  Standard tier:  +$5.64 fee at entry. When BTC moves materially against the trader and they lose,
                  they get back $11.15 on average (28% of stake).

  Shield tier:    +$7.57 fee at entry. On those same BTC-down losing months,
                  they get back $14.79 on average (37% of stake).

That's the difference between a Kalshi bet that's a complete write-off and one where a $40 loss becomes a ~$25 loss after the hedge pays out.

What's structurally unique:
  • A Kalshi MM cannot sell a 30-day BTC put. We can — through Deribit (~$30B BTC options OI).
  • Shield costs 2.7% of protected BTC notional, which is competitive with bank-OTC verticals.
  • Single-flow execution: the user gets it on your platform, no separate options account.

Atticus runs ~13% net margin on markup. Pure pass-through; no warehousing.

We're already live on Foxify with a related drawdown-protection product. We'd like 30 minutes to walk through the mechanism, the per-tier economics, and a zero-integration shadow pilot.
```

---

## Tier Cash Story (drop-in for trader-facing UI)

On a typical $40 Kalshi BTC stake:

| | Standard | Shield | Shield-Max |
|---|---|---|---|
| Geometry | 2%-OTM, 8% width, 2.5× sized | 1%-OTM, 10% width, 4× sized | same as Shield, 6× sized |
| Premium at entry | $5.64 (14%) | **$7.57** (19%) | $17.34 (43%) |
| Avg recovery on BTC-down losing months | $11.15 (28%) | **$14.79** (37%) | $33.87 (85%) |
| Worst-month: unprotected → protected | -$0.31 → -$0.25 | **-$0.31 → -$0.24** | -$0.31 → -$0.15 |
| Story | "Pay $0 extra to recover ~$0 when the trade goes badly." | "Pay $0 extra to roughly halve your worst losing months." | "Pay $0 extra for max tail-event cash." |

(Worst-month rows scaled from $100-face dataset numbers down to $40-stake reference.)

---

## Mechanic explainer

```
Trader buys "BTC > $80,000 by May 30" YES on Kalshi for $58.

At entry, Atticus simultaneously buys (on Deribit):
  Long  BTC-29MAY26-80000-P  (an ATM put expiring same day as Kalshi)
  Short BTC-29MAY26-71000-P  (a 12%-OTM put — the floor)

Net cost from the live Deribit chain: about ~2.7% of BTC notional.
Atticus charges the trader: cost × 1.22 markup = ~19% of their $58 stake.

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