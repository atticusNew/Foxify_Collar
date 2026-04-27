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
| Hedge instrument | Hardcoded PUT spread (Foxify carryover) | Adapter-driven CALL **or** PUT spread per archetype, OR no overlay |
| Tier design primitive | Fixed strike geometry per tier | **Target worst-case loss (W)** per tier; rebate face solved analytically |
| Offer-rate honesty | Implicit (would silently price infeasible markets) | Explicit `NOT_OFFERED` flag when `q × markup × (1+f) ≥ 1` |
| Strike selection | Parametric % OTM | Synthetic Deribit grid + offset-ladder fallback (from `kal_v3_demo`) |
| Premium | BS theoretical with Foxify-CFO IV scalars | BS theoretical + explicit bid-ask widener; no Foxify scalars |
| TP recovery | Foxify R1 §3.4 calibration | None (conservative zero) |
| Markup | "Foxify-style margin target" comments | Per-tier explicit, no inheritance |
| Tier ladder | Lite/Standard rebate (probabilistic) + Shield/Shield+ (deterministic) | All four tiers deterministic-floor-driven, ladder by W (95% / 85% / 70% / 70%+overlay) |

## Headline design: target-W tier ladder

Each tier picks a target worst-case-loss `W` as % of stake. The Kalshi-NO leg face is solved analytically from W and the actual yesPrice:

```
worstCase = stake - rebate + fee
           = stake - rebate + (rebate × q × (1+f) + spreadCost) × markup
Solving:
  rebate = (stake × (1 - W) + spreadCost × markup) / (1 - q × markup × (1+f))
where q = lossLegPriceFrac (price of Kalshi-NO if user is YES, or YES if user is NO).
```

The denominator must be positive. When `q × markup × (1+f) ≥ 1`, the tier is **NOT_OFFERED** for that market — an honest economic-feasibility flag that surfaces which Kalshi long-shot markets cannot be wrapped.

Default W ladder:

| Tier | W | Rebate (at yes=58¢) | Fee (% of stake) | Crosses |
|---|---|---|---|---|
| Light | 95% | 5% of stake | ~7% | A1 + A2 + A3 |
| Standard | 85% | 15% of stake | ~12% | A1 + A2 + A3 |
| Shield | 70% | 30% of stake | ~25% | A1 + A2 + A3 + B1 + B2 |
| Shield+ | 70% + put/call overlay | 30%+ + tail-up | ~30% | A1 + A2 + A3 + B1 + B2 |

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
