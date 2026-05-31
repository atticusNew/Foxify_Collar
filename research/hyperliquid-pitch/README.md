# Atticus → Hyperliquid Pitch (Research Package)

**Standalone analysis. Zero Foxify pilot dependencies. Public APIs only (Coinbase OHLC, Deribit chain).**

## What this is

A backtest + pitch artifact for proposing an options-procurement bridge for Hyperliquid BTC/ETH perp traders.

The pitch has **two product surfaces** that share the same Deribit hedge mechanism:

1. **Drawdown Protection** (the base product, Phase 1-3) — trader pays for a real Deribit-backed put/call spread that pays out on adverse moves. ~50% drawdown reduction, ~95% liquidation prevention. HLP is unaffected.
2. **Leverage Boost** (Phase 4, the adoption driver) — protected positions can run higher leverage at the same margin requirement (e.g., 100x where standard cap is ~50x). Atticus payout treated as deferred collateral by HL's matching engine. This is the framing that drives mass adoption *and* delivers the real revenue step-change for HL via larger protected notionals + zero HLP bad-debt risk on protected flow.

See `PITCH_TO_HYPERLIQUID.md` for the full deck-source, especially §3 (Leverage Boost mechanics).

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
