# Atticus — Kalshi Rebuild Backtest

**Status:** Research only. Standalone package. Zero imports from any live pilot.

## What this is

A Foxify-clean, multi-archetype backtest of Atticus protection wrappers against settled Kalshi BTC markets.

**Replaces** the prior `research/kalshi-shadow-backtest/` package. The prior package is **kept** as the v2/v3 reference (PR #91) and is not modified by this rebuild.

## What changed vs prior package

| Capability | Prior (`kalshi-shadow-backtest/`) | Rebuild (`kalshi-rebuild/`) |
|---|---|---|
| Event archetypes | ABOVE only | ABOVE + BELOW + HIT |
| User direction | Implicit YES only | Explicit YES & NO |
| Hedge instrument | Hardcoded PUT spread | Adapter-driven CALL **or** PUT spread per archetype |
| Strike selection | Parametric % OTM | Synthetic Deribit grid + offset-ladder fallback (from `kal_v3_demo`) |
| Premium | BS theoretical with Foxify-CFO IV scalars | BS theoretical + explicit bid-ask widener; no Foxify scalars |
| TP recovery | Foxify R1 §3.4 calibration | None (conservative zero) |
| Markup | "Foxify-style margin target" comments | Per-tier explicit, no inheritance |
| Tiers | Lite, Standard, Shield, Shield+ (separated put-spread vs Shield engines) | Same four tiers, unified engine |

## Foxify-clean guarantee

- No imports from `services/api`, `services/hedging`, `packages/shared`, or any other live Foxify pilot path.
- No imports from the prior `research/kalshi-shadow-backtest/` package either.
- All Foxify calibration constants are quarantined in `src/_foxifyPriorParams.ts` (which is a deprecation marker file — not imported by any product module). See its docstring.
- The Foxify *operational pattern* (Deribit pass-through, markup-on-cost, no warehousing) is reused — that's options-brokerage common practice, not Foxify-specific. Calibration values are not.

## Methodology source

This rebuild ports key methodology from the `review/kal_v3_demo` branch (read-only review summarized in `../kalshi-shadow-backtest/KAL_V3_DEMO_REVIEW.md`):

- **Event taxonomy** — `services/kalshi/event_parser.py` (BELOW / ABOVE / HIT)
- **Direction-aware adapter** — `services/kalshi/adapter.py` (call vs put per direction)
- **Strike selector** — `services/hedging/strike_selector.py` (offset-ladder)
- **Tier mechanic** — `services/hedging/venue_optimizer.py` (notional scaling)

## Running

```bash
cd research/kalshi-rebuild
npm install
npm run backtest
```

Outputs in `./output/`:
- `kalshi_rebuild_trades.csv` — per-row trade log
- `kalshi_rebuild_summary.md` — tier comparison + per-quadrant breakdown + threshold scorecard
- `kalshi_rebuild_pitch_snippets.md` — pitch-ready cash story

## Phase status

Per the rebuild plan in `../kalshi-shadow-backtest/KAL_V3_DEMO_REVIEW.md`:

- ✅ **Phase 1.** Foxify-clean substrate: math.ts, event-type adapter, strike selector, multi-archetype dataset, unified hedge engine.
- ⏳ **Phase 2.** Dataset expansion (currently 50 markets across 6 quadrants — could be 75-100 with more curation).
- ⏳ **Phase 3.** Real Deribit chain snapshots replacing synthetic grid + bid-ask widener.
- ⏳ **Phase 4.** Path-dependent HIT settlement using daily highs/lows (currently approximated at expiry close).
- ⏳ **Phase 5.** Final pitch deliverable + comparison vs PR #91 numbers.
- ⏳ **Phase 6.** Optional: bridge to live operations using the demo's connector stack.

## Files

```
src/
  math.ts                — Foxify-clean BS + spread math (call AND put)
  kalshiEventTypes.ts    — (event_type, direction) → instrument adapter
  strikeSelector.ts      — synthetic chain + offset-ladder selection
  kalshiMarkets.ts       — 50-market multi-archetype dataset
  hedgeEngine.ts         — unified quote/settle for all 4 tiers
  fetchBtcPrices.ts      — Coinbase/Binance daily price fetcher
  main.ts                — backtest runner + report builders
  _foxifyPriorParams.ts  — quarantine doc (NOT imported by any product code)
output/
  kalshi_rebuild_*.{csv,md}
```
