# Atticus → Kalshi Pitch Snippets
*Ultra-concise data hooks for the follow-up email and meeting.*
*Raw figures: $100 contract face value. Scaled figures: ~$750k avg market notional (real Kalshi BTC volume).*
*Full assumptions in kalshi_shadow_backtest_summary.md*

---

## Intro Email — Pitch #1 (Protection Wrapper)

**Subject line:**
> Atticus shadow test on your BTC markets — 44.4% loss rate, 3× recovery ratio

**Email body (4 sentences):**
```
We ran Atticus's downside-protection model over your last 27 settled BTC markets (Jan 2024–Apr 2026).
44.4% of those expired against the YES buyer — and in 30% of cases, BTC also fell more than 5% during the holding period.
On the worst month (2025-11, BTC −17.4%), a protection bundle costing ~$6,518 per $100k of contracts would have returned ~$22,962 — a 3.5× recovery ratio.
Atticus is already live with Foxify; we'd like to show you the same API applied to your platform — happy to do a 30-minute walkthrough next week.
```

---

## Meeting Framing — Pitch #4 (Shadow Reporting Pilot)

**Zero-integration ask:**
```
We can run a live shadow on your next 11 BTC markets — no integration,
just your public settlement feed. At the end of 30 days, every user who held
a losing YES position will see: "You lost $X. Atticus protection would have
returned $Y." That's the opt-in funnel.

What the data says about value: across 12 losing markets in our backtest,
protection would have returned $133,252 in aggregate to users who had paid
$182,583 in premiums — a 0.7× payout-to-premium ratio on losing trades.
```

---

## Strategic Close — Pitch #5 (Institutional Wrapper)

**Why this matters for Kalshi's institutional roadmap:**
```
In 8 of 27 markets (30%), the binary bet loss AND a >5% BTC drawdown
happened simultaneously. That's the tail risk institutional desks can't
take with a naked binary. Atticus wraps the binary in a put spread:
the client pays a known premium, gets a defined floor. The bet goes
from 'binary' to 'structured' — compliant with institutional risk policy.
That's the unlock for your Tradeweb and FIS distribution.
```

---

## Key Numbers at a Glance

| Stat | Per $100 contract | At real Kalshi volume (~$750k/market) |
|---|---|---|
| Markets analyzed | 27 | 27 |
| Kalshi YES loss rate | 44.4% | — |
| Hedge triggered (BTC >5% drawdown concurrent) | 30% | — |
| Avg Atticus fee | $0.91 | ~$7k per market |
| Avg return-on-trigger | 3.3× | — |
| Total user downside recovered | $8.74 | ~$64,737 across dataset |
| Platform gross P&L (shadow) | $11.80 | ~$87,403 |
| Platform win rate | 100% | — |
| Best single save | $2.22 | ~$16,444 (2025-11) |
| Worst single-market BTC fall | -16.2% | — (2025-02) |

*Volume scaling: 27 monthly markets × ~$750k avg Kalshi BTC market notional = ~$20M total.*
*Scale linearly. Actual Kalshi BTC volumes are publicly available from their API.*

---

*Full assumptions and trade-by-trade log: kalshi_shadow_backtest_summary.md | kalshi_shadow_backtest_trades.csv*