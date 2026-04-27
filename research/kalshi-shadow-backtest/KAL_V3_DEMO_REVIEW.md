# `kal_v3_demo` review — methodology comparison and rebuild plan

**Date:** 2026-04-26
**Reviewed branch:** `origin/review/kal_v3_demo` (commit `593192b`, 144 files)
**Reviewer scope:** read-only. No demo files were modified or copied into the Atticus PR.

---

## TL;DR

The demo is **methodologically better than my current research package on five things** and **missing two things I built**. The right path forward is a fresh rebuild of the research package using the demo's event-archetype + chain-driven engine as the substrate, **plus** the threshold framework and Shield NO-leg from my v3, **minus** every Foxify parameter calibration that's been leaking in.

**The Atticus PR (#91) should not change.** This document recommends a separate rebuild as the next research iteration. The Foxify pilot remains untouched (re-verified at the top of this conversation).

---

## What the demo actually is

It's a live service — not a backtest, not a spike. Concretely:

- `connectors/kalshi_connector.py` (1,061 lines): authenticated REST + WebSocket client to live Kalshi. Real `fetch_markets`, `fetch_ticker`, `fetch_trades`.
- `services/kalshi/event_parser.py` + `event_fetcher.py`: pulls live `KXBTCMAXY`, `KXBTCMINY`, `KXBTCMAX150`, `KXBTC2025100` markets and parses them into a canonical `(event_type, threshold, expiry)` triple.
- `services/option_chains/chain_service.py`: fetches real Deribit + OKX option chains for the relevant expiry.
- `services/hedging/{strike_selector, spread_builder, premium_calculator, venue_optimizer}.py`: finds actual strikes that have bid/ask, builds 2-leg spreads, computes real-cost premiums, applies markup, picks best venue, generates Light/Standard/Max tiers.
- `apps/web/src/PilotApp.tsx` + 60+ `.md` analysis files: an actual end-to-end demo UI.

This is roughly the same operational stack the Foxify pilot uses, but **purpose-built for Kalshi events from the start**. The 60+ debug/analysis markdown files are the iteration log of the developer (you) walking through every hedge-modal edge case. That's a lot of real product thinking.

---

## Five things the demo gets right that my research package gets wrong

### 1. Event-archetype taxonomy is correct (mine is incomplete)

Demo `event_parser.py` recognizes three event types:

| Type | Kalshi series example | Question |
|---|---|---|
| `BELOW` | `KXBTCMINY` | "How low will BTC get?" / "Will BTC go below $X?" |
| `ABOVE` | `KXBTCMAXY`, `KXBTC2025100` | "How high?" / "Will BTC be above $X?" |
| `HIT` | `KXBTCMAX150` | "When will BTC hit $X?" (first-to-touch barrier) |

My research package only models `ABOVE` (with a never-used `below` flag in `kalshiMarkets.ts`). That's about **a third** of Kalshi's actual BTC event surface — and arguably the *least* interesting third because `KXBTCMAXY`/`KXBTCMINY` (range bins) and `KXBTCMAX150` (first-to-touch) are higher-volume series.

**Take from demo:** the `(BELOW | ABOVE | HIT)` enum plus the parser regexes and ticker-format extraction.

### 2. Direction-aware hedge mapping (this is the big one, and it's the Foxify lens I had on)

Demo `services/kalshi/adapter.py` has this table:

| Event type | YES bet | NO bet |
|---|---|---|
| BELOW K | call spread | put spread |
| ABOVE K | put spread | call spread |
| HIT K | call spread | call spread |

The user can bet YES *or* NO on any event — and the right hedge instrument **inverts** when direction inverts. Foxify only ever has one direction (user is long BTC drawdown protection), so its entire pricing schedule and hedge stack assumes "PUT spread". I imported that assumption into my v2/v3 — every tier in `tieredHedgeModel.ts` and `shieldHedgeModel.ts` hardcodes a put spread with `K_long = btcAtOpen × (1 - longOtmPct)`. **That's wrong half the time on Kalshi**, and it's wrong specifically because of Foxify-shaped thinking.

**Take from demo:** the `_determine_insurance_type` adapter as the entry point of any pricing call.

### 3. Strikes come from real option chains with bid/ask, not parametric OTM%

Demo `strike_selector.py`:

```226:280:research/kalshi-shadow-backtest/src/tieredHedgeModel.ts
// (research package — current approach)
const K_long = params.btcAtOpen * (1 - cfg.longOtmPct);
const K_short = params.btcAtOpen * (1 - cfg.shortOtmPct);
```

vs demo:

```60:70:/tmp/kal_v3/services/hedging/strike_selector.py
call_strikes = sorted(set(
    c.strike for c in chain.contracts
    if c.option_type == 'C' and c.bid > 0 and c.ask > 0
))
# ... then "first two strikes ≥ K" / "two highest puts ≤ K" with a 0..7 offset-fallback ladder.
```

The demo finds strikes that **actually exist with bid/ask depth** on Deribit/OKX, with an offset ladder (0..7) to widen the spread when the narrow spread fails some economic check. My approach silently assumes the option exists at any OTM% I want — which inflates apparent hedge availability for deep-OTM strikes and is silent about liquidity.

The demo is also explicit about an honest failure mode: `_find_first_two_calls_above` returns `None` when there aren't enough strikes above the barrier. That happens regularly for "BTC above $130k by Dec 31" when BTC is at $90k — Deribit just doesn't list calls that deep. My model would happily price a fictitious option at any K.

**Take from demo:** strike selection from the real chain, with the offset ladder.

### 4. Premium uses real bid-ask, not Black-Scholes theoretical

Demo `premium_calculator.py` line 78:

```python
premium_raw = initial_notional * spot_price * (long_ask - short_bid)
```

That's the actual fill cost: pay the long leg's *ask*, receive the short leg's *bid*. My model uses BS theoretical with a flat IV-from-realized-vol scalar (and the "1.20×/1.18×/1.15× of rvol" scalars are explicitly cited as Foxify-CFO-report calibrations — Foxify carryover).

For a 30-day Deribit BTC put spread, the bid-ask spread is typically 50-100 bps of underlying — not nothing. A BS-theoretical price will systematically *underestimate* hedge cost relative to what Atticus actually pays to fill. My platform-margin numbers in the v2/v3 outputs are too optimistic by ~5-15% as a result.

**Take from demo:** real bid-ask pricing whenever a live chain is available.

### 5. Notional-scaling tier mechanic (cleaner than my strike-shifting approach)

Demo `venue_optimizer.py`:

```108:113:/tmp/kal_v3/services/hedging/venue_optimizer.py
tier_multipliers = [
    ('Light protection',    Decimal('0.5')),   # 50% of budget
    ('Standard protection', Decimal('1.0')),   # 100% of budget
    ('Max protection',      Decimal('1.5'))    # 150% of budget (capped at max_payout)
]
```

All three tiers use **the same strikes**, just scaled notional. Result is a flat ~37% return-on-premium across tiers — same value ratio, just bigger or smaller. My approach uses *different strikes per tier* (Lite is 1% OTM, Standard is ATM, etc.), which means each tier hits a different liquidity bucket on Deribit and the per-tier ratios drift. The demo's approach is simpler, lower-compute, and avoids the "Standard tier had thin liquidity but Lite had thick liquidity, so the ratios diverge" failure mode I'd hit in production.

**Take from demo:** notional-scaling for tiers; pick strikes once.

---

## Two things I built that the demo doesn't have

### A. Threshold-crossing framework

The demo's only economic-validity check is `max_payout / charged_premium ≥ 1.1`. That's a sanity gate, not a product-positioning framework. There's no notion of:

- A1: P(payout > 0 | loss) ≥ 90%?
- A3: protected worst case ≤ unprotected worst case?
- B1: worst-case loss ≤ 70% of stake?
- B2: deterministic floor by contract, not by BTC path?

Without these, you can't tell a Kalshi sales prospect "this crosses the institutional risk-policy bar" because you don't know if it does. My `EVAL_AND_NEXT_STEPS.md` §1 framework is what lets you run a Shield+ tier through the threshold scorecard and say specifically: A1 ✅ A2 ✅ A3 ✅ B2 ✅ B1 ❌. Take that with you.

### B. Shield (Kalshi-NO-leg) deterministic floor

The demo's hedges are 100% Deribit/OKX option spreads. That means it has **the same structural limitation as my v2**: when BTC moves the "wrong" way for the hedge (e.g. BTC rises but Kalshi YES still loses), the put-spread pays $0 and the user is fully exposed to the binary loss. Shield's NO leg is the only mechanism that delivers a *contract-deterministic* floor independent of BTC path — and it's the only thing that crosses B2 in the threshold scorecard. The demo doesn't have it.

The demo has the operational substrate to add it cleanly though: `KalshiConnector.fetch_markets` + `fetch_ticker` already pull NO prices, and Shield is just "buy $R of NO contracts at entry" which is a single Kalshi place-order call.

---

## Foxify carryover audit — what's in the demo vs. mine

Honest comparison:

| Foxify-derived element | In demo? | In my research package? |
|---|---|---|
| Hedge instrument hardcoded as PUT (no CALL or NO-leg path) | ❌ Demo has full call/put adapter | ✅ Yes (v2 + v3 put-spread legs) — wrong |
| 1.20×/1.18×/1.15× IV-from-realized-vol scalars (Foxify CFO §3.2) | ❌ Demo doesn't use BS theoretical | ✅ Yes in `math.ts` |
| 0.7 vol-pts/% OTM skew slope (Foxify empirical) | ❌ | ✅ Yes in `math.ts` |
| 68%/55%/40% TP recovery by regime (Foxify R1 §3.4) | ❌ | ✅ Yes in `math.ts` |
| 1.40×/1.45× markup on cost | ❌ Demo uses min-charge-floor logic instead | ✅ Yes (v2 + v3) |
| 5%/10%/30%-OTM tier strike geometry | ❌ Demo strikes come from chain | ✅ Yes (`tieredHedgeModel.ts`) |
| Calm/normal/stress regime classifier | ❌ | ✅ Yes (`math.ts`) |

**Demo is much cleaner of Foxify than my research package is.** Almost zero Foxify carryover. My package has Foxify calibration constants in five places that should be ripped out in any rebuild.

---

## What the demo is missing relative to a Kalshi pitch deliverable

It's a **live service**, not a backtest. There's no:

- Historical settled-market evaluation across 2024-2026.
- Per-market trade log showing "what would have happened if Atticus had been live."
- Aggregate stats (P(payout|loss), avg recovery, worst-case loss, % of stake recovered).
- Pitch-ready cash numbers calibrated to a typical $58 stake.
- Tier comparison table or threshold scorecard.

So the demo gets you to "we can quote a real hedge on a live Kalshi market right now." It doesn't get you to "across the last 27 settled BTC markets, Shield+ would have returned $X." Both are needed for a Kalshi pitch.

---

## Side-by-side feature comparison

| Capability | Demo (`kal_v3_demo`) | Current research package (this PR) |
|---|---|---|
| Event archetypes (BELOW / ABOVE / HIT) | ✅ all three | ❌ ABOVE only |
| YES/NO direction handling (call vs put per direction) | ✅ | ❌ put only |
| Strikes from real chain w/ bid-ask | ✅ Deribit + OKX | ❌ parametric OTM% |
| Premium = real fill cost | ✅ `(long_ask − short_bid)` | ❌ BS theoretical |
| Multi-venue (Deribit + OKX) | ✅ | ❌ Deribit only |
| Notional-scaled tiers (same strikes) | ✅ Light/Std/Max at 0.5/1.0/1.5× | ❌ different strikes per tier |
| Live Kalshi connector | ✅ | ❌ static dataset |
| **Historical backtest** | ❌ | ✅ 27 settled markets |
| **Threshold-crossing scorecard (A1-B2)** | ❌ | ✅ |
| **Kalshi-NO-leg deterministic floor (Shield)** | ❌ | ✅ |
| **Pitch-ready cash story** | ❌ | ✅ |
| **Foxify-clean** | ✅ mostly | ❌ five carryover points |

---

## Confirmation of your two questions

> **Confirm you are backtesting with the essential events.**

Currently: **No.** The 27-market dataset in `kalshiMarkets.ts` is all `ABOVE`-type ("Will BTC be above $X by date Y"). Missing the BELOW / range / HIT archetypes that the demo correctly identifies as core Kalshi BTC events (and which I noted as a gap in the previous turn). This is a real and acknowledged gap.

> **Confirm you are not developing this based on any Foxify pilot rules or restrictions.**

Currently: **partially compromised.** Specific carryover points (with file:line):
- `src/math.ts` — `impliedVolFromRealized` lines 77-81 cite "Foxify pilot CFO report §3.2" calibration.
- `src/math.ts` — `ivForMoneyness` line 88 cites "Foxify pilot empirical" skew.
- `src/math.ts` — `tpRecoveryRate` line 150 uses "Foxify R1 §3.4" calibrations.
- `src/tieredHedgeModel.ts` — markup defaults `1.40` / `1.45` are explicitly "Foxify-style margin target" (comments lines 18-21, 76-79).
- `src/hedgeModel.ts` (v1) — entire pricing schedule is Foxify Design A.
- The hardcoded "always a put spread" assumption is structurally Foxify-shaped.

The Foxify *operational pattern* (Deribit-hedged, markup-on-cost, Atticus-as-pass-through, fully-hedged-no-warehouse) is reasonable to reuse — that's how options brokerage works in general, not Foxify-specific. But the Foxify *calibration constants* and the hardcoded put-only assumption have to go in any rebuild aimed at Kalshi.

---

## Rebuild plan — best of both, in execution order

This is what I'd recommend doing **next**, after you've reviewed this and agreed. It's a separate iteration on top of PR #91, not a change to it.

### Phase 1 — strip Foxify carryover, generalize event types (read-only refactor, no new features)

1. New file `src/kalshiEventTypes.ts`: port the demo's `(BELOW | ABOVE | HIT) × (YES | NO) → (call | put | barrier)` adapter logic verbatim. Make this the entry point of every hedge-construction call.
2. New file `src/strikeSelector.ts`: port the demo's offset-ladder strike-selection logic. For the backtest, since we don't have live chains 2024-2026 historical, the input is either (a) a synthetic chain generated from the BS surface as fallback, or (b) Deribit historical chain snapshots if accessible (Deribit Insights / Tardis). Document which.
3. Move all Foxify calibration constants (`impliedVolFromRealized` scalars, `ivForMoneyness` skew, `tpRecoveryRate` table) into a clearly-named `foxifyPriorParams.ts` and stop importing it from any Kalshi-product-bound module. Replace with Kalshi-native priors (or BS-theoretical with explicit "approximation" labels) until we have Kalshi-specific calibration data.
4. Delete the hardcoded "put spread" assumption from `tieredHedgeModel.ts` / `shieldHedgeModel.ts`. Replace with the call/put adapter output.
5. Sanity check: re-run all four tiers on the existing 27-market dataset and confirm numbers are within tolerance of v3 results (they should be — these markets are all `ABOVE+YES` which routes to put spread anyway).

### Phase 2 — expand dataset to all three event archetypes

6. Extend `src/kalshiMarkets.ts` from 27 `ABOVE` markets to ~75-100 markets covering:
   - 25-30 `ABOVE` "Will BTC be above $X" (already have these)
   - 20-25 `BELOW` "How low / Will BTC go below $X"
   - 15-20 `KXBTCMAXY` / `KXBTCMINY` range-bin markets
   - 10-15 `HIT` "When will BTC hit $X" first-to-touch markets
   Source: demo's `KalshiConnector.fetch_markets` over the 2024-2026 window, filtered to settled markets.
7. Add a derived field `winningDirection: 'yes' | 'no'` so we can simulate users on either side and run the adapter.

### Phase 3 — replace BS theoretical with real bid/ask where possible

8. If Deribit historical chain snapshots are accessible, pull the chain at each market's open date for the matching expiry. Use `(long_ask − short_bid)` for premium. This is the most honest pricing.
9. Where chain data isn't available, document a BS-theoretical fallback with an explicit "+ avg bid-ask spread" widener calibrated against current chain snapshots (so we're not pretending bid-ask is zero).

### Phase 4 — keep the threshold framework and Shield, drop the rest

10. Keep `EVAL_AND_NEXT_STEPS.md` threshold definitions (A1-B3). Re-run the scorecard on the new four-archetype dataset.
11. Keep Shield NO-leg model from `shieldHedgeModel.ts` — generalize to take any `(event_type, direction)` so the NO leg works on any Kalshi market, not just `ABOVE`.
12. Drop `tieredHedgeModel.ts`'s strike-geometry-per-tier approach. Replace with the demo's notional-scaling-per-tier approach: pick strikes once via `strikeSelector.ts`, then scale notional 0.5×/1.0×/1.5× for tiers.
13. Keep `mainTiered.ts`'s aggregator + report builders. Update column set to handle call/put/barrier-leg/NO-leg payouts.

### Phase 5 — final pitch artifacts

14. Regenerate `kalshi_tiered_summary.md` and pitch snippets across all four archetypes × four tiers. New columns: per-archetype recovery, per-archetype platform margin, per-archetype A1-B2 scorecard.
15. Keep the Shield+-leads-the-email framing — that's still right. But now you can also show "Standard works on every Kalshi event type, not just monthly directional bets."

### Phase 6 — bridge to live operations (optional, if useful for the Kalshi conversation)

16. The demo's live service stack (`api/main.py`, `connectors/`, `services/`) becomes the production target. The research package stays a backtest. Don't merge them.
17. Add a small adapter layer so the production service can pull live Kalshi events and quote *any* of the four tiers (Lite, Standard, Shield, Shield+) using the same strike/premium/payout logic the backtest validated.

---

## Recommendation

**Don't change PR #91.** It's a coherent v2/v3 deliverable on the existing scope (ABOVE-only directional binaries) and the verification at the top of this conversation confirms zero Foxify pilot disruption. Ship it as research artifact #1.

**Open a fresh branch** (`cursor/kalshi-rebuild-from-demo-XXXX`) for the rebuild. Phases 1-3 are mechanical refactor work, low risk. Phases 4-5 are where the new pitch numbers come from. Phase 6 is optional.

**The headline pitch to Kalshi changes only modestly.** The core insight — Shield delivers a deterministic floor that crosses the institutional B2 threshold — is unchanged. What changes is breadth: instead of "this works on monthly directional binaries (~30% of your BTC volume)" it becomes "this works on every BTC event archetype you list (BELOW, ABOVE, HIT, range bins) at any direction the user picks."

If you confirm the rebuild plan I'll create the new branch and start with Phase 1.
