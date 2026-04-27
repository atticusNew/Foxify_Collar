# Atticus → Kalshi Pitch Snippets — Trader-Cash Story

Atticus is an options-procurement bridge: we route real Deribit BTC vertical-spread hedges to Kalshi traders in a single combined-ticket flow. We don't act as a Kalshi market maker, we don't take the other side of bets. Below: trader-perspective economics on a typical $40 retail Kalshi BTC stake.

*Live Deribit calibration: BTC index $78998, 932 listed contracts.*

---

## Intro Email

**Subject:** Options-hedge bridge for your BTC traders — meaningful cash recovery on a $40 stake

**Body:**
```
We built a thin overlay that lets a Kalshi user buy a BTC bet and a real Deribit BTC vertical-spread hedge in one ticket. We don't take the other side of your binary, we don't make a market — we procure a real options trade and pass it through.

On a typical $40 retail Kalshi BTC stake:

  Standard tier:  +$5.64 fee at entry. When BTC moves materially against the trader and they lose,
                  they get back $11.15 on average (28% of stake).

  Shield tier:    +$8.65 fee at entry. On those same BTC-down losing months,
                  they get back $16.90 on average (42% of stake).

That's the difference between a Kalshi bet that's a complete write-off and one where a $40 loss becomes a ~$23 loss after the hedge pays out.

What's structurally unique:
  • A Kalshi MM cannot sell a 30-day BTC put. We can — through Deribit (~$30B BTC options OI).
  • Shield costs 2.7% of protected BTC notional, which is competitive with bank-OTC verticals.
  • Single-flow execution: the user gets it on your platform, no separate options account.

Atticus runs ~13% net margin on markup. Pure pass-through; no warehousing.

We're already live on Foxify with a related drawdown-protection product. We'd like 30 minutes to walk through the mechanism, the per-tier economics, and a zero-integration shadow pilot.
```

---

## Tier Cash Story by Stake Size (drop-in for trader-facing UI)

Shield's value scales with stake. The dollar gap between tiers is small at $40 but grows materially at $100+. The UX should default Standard for small stakes and surface Shield for larger ones.

### On a $40 Kalshi BTC stake:

| | No protection | Standard | Shield |
|---|---|---|---|
| Premium at entry | $0 | **$5.64** (14%) | **$8.65** (22%) |
| Median BTC-adverse loss month: net P&L | -$40.00 | -$27.00 (saved $13.00) | **-$20.80** (saved $19.20) |
| Worst BTC-adverse month in dataset: net P&L | -$31.20 | -$25.42 (saved -$5.78) | -$22.94 (saved -$8.26) |

### On a $100 Kalshi BTC stake:

| | No protection | Standard | Shield |
|---|---|---|---|
| Premium at entry | $0 | **$14.09** (14%) | **$21.62** (22%) |
| Median BTC-adverse loss month: net P&L | -$100.00 | -$67.50 (saved $32.50) | **-$52.00** (saved $48.00) |
| Worst BTC-adverse month in dataset: net P&L | -$78.00 | -$63.54 (saved -$14.46) | -$57.34 (saved -$20.66) |

### On a $250 Kalshi BTC stake:

| | No protection | Standard | Shield |
|---|---|---|---|
| Premium at entry | $0 | **$35.23** (14%) | **$54.05** (22%) |
| Median BTC-adverse loss month: net P&L | -$250.00 | -$168.75 (saved $81.25) | **-$130.00** (saved $120.00) |
| Worst BTC-adverse month in dataset: net P&L | -$195.00 | -$158.85 (saved -$36.15) | -$143.35 (saved -$51.65) |

**Reading the $40 vs $250 tables:**
- At $40 stake, Shield costs only $3.01 more than Standard but gives $6.20 more median recovery — small absolute dollars.
- At $250 stake, Shield costs $18.82 more but gives $38.75 more in median recovery — meaningful real money.
- Recommended UX: Standard pre-selected as default; Shield visible as a one-toggle upgrade, with the $-saved difference dynamically shown on the user's actual stake size.

---

## Mechanic explainer

```
Trader buys "BTC > $80,000 by May 30" YES on Kalshi for $58.

At entry, Atticus simultaneously buys (on Deribit):
  Long  BTC-29MAY26-80000-P  (an ATM put expiring same day as Kalshi)
  Short BTC-29MAY26-71000-P  (a 12%-OTM put — the floor)

Net cost from the live Deribit chain: about ~2.7% of BTC notional.
Atticus charges the trader: cost × 1.22 markup = ~22% of their $58 stake.

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