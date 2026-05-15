# Atticus → SynFutures Pitch Backtest

**Standalone research package.** Foxify-clean: zero imports from any pilot path.
Public APIs only (Coinbase prices, Deribit options) — no API keys used.

## What this is

A perp-protection backtest + pitch deliverable for a SynFutures-style perp DEX
partnership. Demonstrates an options-procurement bridge product where:

- Trader opens a BTC/ETH perp on the venue
- Atticus simultaneously buys a real Deribit put/call vertical-spread hedge
- Pure pass-through: Atticus doesn't take the other side, doesn't make markets,
  doesn't warehouse risk

Two product variants benchmarked:

1. **Single-premium** (7-day Deribit spread, paid once at entry)
2. **Day-rate** (14-day Deribit spread, theta-following daily debit, cancel anytime)

## Running

```bash
cd research/synfutures-pitch
npm install
npm run backtest          # main backtest
npm run smoke-deribit     # confirm live BTC + ETH chains
```

Outputs in `./output/`:
- `synfutures_trades.csv` — per-trade log (1000 rows: 500 trades × 2 tiers)
- `synfutures_summary.md` — methodology + headline numbers + concrete examples
- `synfutures_pitch_bullets.md` — drop-in email bullets organized by topic

The deck-source document is at the top level: `PITCH_TO_SYNFUTURES.md`.

## Headline results

On 500 synthetic retail-perp trades (BTC + ETH, Jan 2024 – Apr 2026):

| Metric | Single-premium | Day-rate |
|---|---|---|
| Median drawdown reduction | 52% of margin | 56% of margin |
| Liquidation prevention rate | 94% | 99% |
| Avg premium | 5.4% of notional | 5.3% of notional |
| Atticus net margin | 22% of revenue | 21% |

## Files

```
src/
  fetchPrices.ts          — Coinbase BTC/ETH daily OHLC
  deribitClient.ts        — Deribit public-API client (no keys)
  math.ts                 — BS + spread math
  syntheticPerpTrades.ts  — synthetic trade generator (seeded RNG)
  perpHedgeEngine.ts      — quote/settle for both product variants
  main.ts                 — runner + report builders
  _smokeDeribit.ts        — quick live-chain test
output/
  synfutures_*.{csv,md}   — generated artifacts
```
