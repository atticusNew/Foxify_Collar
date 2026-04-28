# Atticus → Hyperliquid Pitch (Research Package)

**Standalone analysis. Zero Foxify pilot dependencies. Public APIs only (Coinbase OHLC, Deribit chain).**

## What this is

A backtest + pitch artifact for proposing an options-procurement bridge for Hyperliquid BTC/ETH perp traders.

Same engine as the SynFutures pitch (PR #93), reshaped for Hyperliquid's:
- **Bigger notional tail** (HL leaderboards show meaningful whale activity alongside retail)
- **More balanced BTC/ETH split** (~60/40 vs typical 70/30)
- **Shorter avg hold** (HL is the scalper's preferred venue)
- **HL-scale venue-revenue scenarios** ($50B-$300B/month perp volume)

**HLP is unaffected.** This product sits orthogonal to the LP vault — it's not a competing AMM or hedging-vault product, it's a pure pass-through to Deribit.

## How to run

```bash
cd research/hyperliquid-pitch
npm install
npm run backtest          # full simulation + reports
npm run smoke-deribit     # quick public-API check
```

## Outputs

- `output/hyperliquid_summary.md` — full methodology + headline numbers + sample P&L scenarios
- `output/hyperliquid_pitch_bullets.md` — drop-in email/deck bullets
- `output/hyperliquid_trades.csv` — per-trade simulation log (1000 rows = 500 trades × 2 tiers)
- `PITCH_TO_HYPERLIQUID.md` — deck-source pitch document

## Key headline numbers

- **52-55% median drawdown reduction** (% of margin) on adverse-move trades
- **94-99% liquidation prevention rate** on trades that would have liquidated unhedged
- **5.55% avg premium / protected notional** (single-premium tier)
- **22% Atticus net margin** on single-premium tier (sustainable)
- **At $150B/month HL volume + 3% adoption:** ~$68M/month incremental venue revenue (50/50 rev-share)

## Pilot integrity

This package is fully isolated from the live Foxify pilot. Verified: zero changes to `services/`, `apps/web/`, `packages/`, `docs/`, `scripts/`, `contracts/`, `configs/`, `env/`.
