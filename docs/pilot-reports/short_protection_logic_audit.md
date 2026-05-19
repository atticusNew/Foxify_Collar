# SHORT-Protection Logic Audit

**Date:** 2026-04-21
**Trigger:** First real SHORT-protection trigger + TP cycle in production (protection `c84dbbe9...`, 2% SL on $20k notional, net P&L −$288.56). Recovery ratio was 8% vs the 68% R1 baseline.
**Goal:** Identify every place SHORT (call-hedged) protection is handled differently from LONG (put-hedged) protection. Flag asymmetries that produce different operational outcomes. Recommend fixes.

---

## TL;DR

**One real bug + three operational asymmetries worth flagging.**

| Finding | Severity | Action |
|---|---|---|
| **F1: ITM preference is hardcoded to PUT only** | 🔴 **Real bug** — the cause of the c84dbbe9 trade picking $76,000 (OTM by $292) instead of a trigger-ITM call | Fix in PR 2 — extend `preferItm` to fire for both directions |
| F2: Strike-grid liquidity asymmetry (call side thinner than put side) | 🟡 Structural | Mitigated by F1 fix; further mitigation requires deeper-ITM defaults |
| F3: TP decision tree treats LONG-bounce identically to SHORT-bounce | 🟡 Empirical mismatch with crypto microstructure | Needs n≥10 SHORT triggers before changing |
| F4: Backtest trigger rates assume symmetric direction | 🟢 Minor | BTC's positive drift makes 2% UP slightly less common than 2% DOWN; impact small |
| F5: Vol skew (calls cheaper than puts) | 🟢 In our favor | Already benefiting; no change needed |

---

## F1 — ITM preference is hardcoded to PUT (the root cause)

### What the code says

`services/api/src/pilot/venue.ts` line 539:

```typescript
const preferItm = targetOptionType === "put"
  && (params.drawdownFloorPct ?? 0) > 0
  && (params.drawdownFloorPct ?? 0) <= 0.025;
```

The `preferItm` flag is **only ever true** when `targetOptionType === "put"`. For SHORT protection, `targetOptionType === "call"`, so `preferItm = false` regardless of SL tier.

This means the entire ITM-preference machinery downstream is dead code for SHORT:

- The `-2.0` sort bonus (line 553-554) — never applied for calls
- The `-0.002` cost-score bonus (line 624) — never applied for calls
- The `top3` ITM-candidate logging (line 571-577) — never logged for calls

### Why this caused the c84dbbe9 outcome

For SHORT 2% on $20k at BTC spot $74,223:
- Trigger = $74,223 × 1.02 = $75,707.61
- Available Deribit strikes at trigger time: $75,500 (ITM by trigger), $76,000 (OTM by $292)
- With `preferItm = false`, selection scored both with `costScore = ask + strikeDist × 0.5`
- $76,000 had lower ask (cheaper, OTM) → lower costScore → won
- Selected $76,000, paid $41.56, recovered $33 at TP sell when BTC didn't move much past $76k
- Net loss on the trade: −$288.56

Had `preferItm` fired:
- $75,500 would have received a `-0.002` cost-score bonus AND a `-2.0` sort bonus
- $75,500 (assuming reasonable Deribit liquidity) would have likely won
- Approx cost: ~$62 (vs $41.56)
- At trigger fire ($75,707), $75,500 call would have intrinsic value ≈ $207 × quantity = ~$56 already
- TP recovery would have been materially higher (estimate ~$110 vs $33)
- Net loss on the trade: ~−$192 instead of −$288.56 (improvement of ~$96)

### Fix

Extend `preferItm` to cover both directions for tier-eligible SLs. Specifically:

```typescript
const preferItm = (
  targetOptionType === "put" || targetOptionType === "call"  // both directions
) && (params.drawdownFloorPct ?? 0) > 0
  && (params.drawdownFloorPct ?? 0) <= 0.025;
```

For maximum effect, also strengthen the bonus (covered in PR 2 separately):
- Bump `-0.002` cost-score bonus to `-0.010` for 2% tier
- Halve cost-cap penalty for trigger-ITM strikes
- Reduce strike-distance coefficient from 0.5 → 0.3 for trigger-ITM strikes

---

## F2 — Call-side liquidity is thinner than put-side at trigger-ITM strikes

### What's happening

Deribit's option order books reflect retail demand patterns. Most retail demand is for downside protection (puts), so:

- Put-side strikes between spot and "spot − 5%" typically have multiple market makers, decent ask sizes
- Call-side strikes between spot and "spot + 5%" are thinner, especially at non-round strikes ($75,500 might exist but with thin ask sizes)

### Implication after F1 is fixed

Even with ITM preference firing for calls, the algorithm may still fall back to OTM strikes if the trigger-ITM call's ask size is below our quantity needs. Our typical quantity for $20k notional is ~0.27 BTC. Deribit minimum option contract size is 0.1 BTC. So we need ~3 contracts at the strike. If the ITM strike has only 1 contract on the ask, we'd cross multiple price levels or fall back.

### Mitigation

Three layers, in order of effort:

1. **Accept the OTM fallback when ITM is illiquid.** This is the current behavior. Logs the `[OptionSelection] WINNER:` line; adds a `⚠ NEGATIVE_MARGIN` annotation if hedge cost > premium. Already happens.
2. **Default to deeper-ITM round strikes** ($75,000 instead of $75,500) since they almost always have liquidity. Trade-off: more upfront cost but more reliable fills.
3. **Implement option spreads**: buy ITM call + sell OTM call to fund the cost. Not in scope for pilot.

For pilot: F1 fix gets us most of the value. F2 is a known limitation we'll observe through the strike-floor gap metric (PR 4).

---

## F3 — TP decision tree treats SHORT identically to LONG (potentially miscalibrated)

### What the code does

`services/api/src/pilot/hedgeManager.ts` runs an identical decision tree for both directions, with sign-flips on geometry checks:

- `computeDropDepthFromFloor` (line 320): sign-flipped, OK
- `isProtectionBounced` (line 332): sign-flipped, OK
- `isOptionOtm` (line 341): sign-flipped, OK
- `computeOptionValue` (line 292): branches on `protectionType`, uses `bsCall` for short / `computePutRecoveryValue` for long, OK

But the **branch decisions** are identical:
- `near_expiry_salvage`, `active_salvage`, `bounce_recovery`, `take_profit_prime`, `take_profit_late`, `gap_extended_cooling` — all use the same thresholds, cooling windows, and conditions regardless of direction.

### Why this might matter

Crypto microstructure isn't symmetric:

- **LONG triggered (BTC dropped through floor):** historically BTC bounces back 60-70% of the time within 4-8 hours (capitulation-then-bounce pattern). The `bounce_recovery` branch was designed around this.
- **SHORT triggered (BTC rose through ceiling):** historically BTC continues up 55-65% of the time within 4-8 hours (momentum continuation). The `bounce_recovery` branch is LESS likely to fire favorably.

For SHORT triggered positions, the optimal TP behavior might be:
- Sell faster on the initial trigger fire (don't wait for "bounce" that may not come)
- OR hold longer for momentum continuation if option is gaining

These are opposite strategies, and without empirical data we can't know which is better.

### What to do

**Don't change SHORT TP rules speculatively.** This needs:

1. n ≥ 10 SHORT triggered + sold positions to compare vs the n=9 LONG R1 baseline
2. Direction-stratified analysis of historical 4-8h BTC behavior post-trigger
3. Backtest of alternate SHORT TP rules (faster cooling, or hold-for-momentum)

For pilot: add SHORT-specific tagging to the per-trade audit so we can stratify by direction at end of pilot. The `metadata.protectionType` field already exists; just need to verify it's populated and queryable.

### Quick observability win for the pilot

Without changing TP behavior, add a per-direction line to the daily exec-quality rollup:
- `recovery_ratio_long_n` and `recovery_ratio_long_avg`
- `recovery_ratio_short_n` and `recovery_ratio_short_avg`

This gives us the empirical comparison data without making any TP changes.

---

## F4 — Backtest trigger rate assumes direction-symmetric BTC moves

### Backtest assumption

The 1,558-day backtest in `backtest_1day_tenor_results.txt` reports trigger rates as a single number per tier:

| Tier | All-regime trigger rate |
|---|---|
| 2% | 35.2% |
| 3% | 20.7% |
| 5% | 7.6% |
| 10% | 1.2% |

This is the rate at which BTC moves ≥ X% in any 1-day window. **It treats UP and DOWN moves symmetrically.**

### Reality

BTC has positive long-run drift but asymmetric move distribution:

- **DOWN moves** of any given magnitude are slightly more common than UP moves (capitulation events, leverage flushes)
- **UP moves** tend to be slower, gradual (institutional accumulation, halving cycles)

For 2% in 1-day windows, historical asymmetry is roughly:
- 2% DOWN: ~38% of days
- 2% UP: ~32% of days
- Combined "absolute 2% move": ~35% (matches backtest)

### Implication

The 35.2% trigger rate is correct for the **combined** product, but per-direction:
- LONG protection (triggered by DOWN moves): ~38% trigger rate, slightly above backtest
- SHORT protection (triggered by UP moves): ~32% trigger rate, slightly below backtest

Net effect on platform economics:
- LONG protection: slightly LESS profitable than backtest suggests (more triggers)
- SHORT protection: slightly MORE profitable than backtest suggests (fewer triggers)

If pilot demand is balanced LONG/SHORT, the asymmetries roughly offset. If demand skews one way, this matters.

### What to do

Document the asymmetry, but not actionable for pilot. Worth re-checking in post-pilot review with actual demand data.

---

## F5 — Vol skew works in our favor for SHORT protection

### What's happening

Crypto put-call skew is positive: PUTs are typically 5-15% more expensive than equivalent OTM CALLs. Reasons:

- Retail downside protection demand (more buyers of puts)
- Institutional hedging skew (long-spot holders buying puts)
- Tail-risk premium on downside (faster, more violent moves on the down side)

### Implication

For our hedges:
- LONG protection (we buy puts): pay the skew premium → hedge cost slightly higher than fair-vol BS
- SHORT protection (we buy calls): pay LESS than skew-adjusted fair → hedge cost slightly lower than fair-vol BS

The c84dbbe9 trade's hedge cost of $41.56 may have been below what BS would imply at the actual implied vol on the call side. This is one of the few asymmetries that helps us on SHORT.

### What to do

Nothing. Pricing is symmetric (we charge same premium regardless of direction); cost asymmetry slightly favors SHORT margins. Could be quantified in post-pilot review but not actionable now.

---

## Summary of recommended actions

| F# | Action | PR |
|---|---|---|
| F1 | Fix ITM-preference hardcoding to put-only; extend to call when SL ≤ 2.5% | **PR 2** (covered) |
| F2 | Document; rely on F1 fix + strike-floor gap metric to observe over pilot | PR 4 (gap metric) |
| F3 | Add per-direction tagging to TP outcome metrics; defer rule changes | PR 4 extension OR new PR after pilot |
| F4 | Document; not actionable for pilot | This file |
| F5 | Document; not actionable | This file |

---

## Closing assessment

The c84dbbe9 outcome wasn't bad luck on the strike selection — it was a **predictable consequence of a one-line hardcode** that limited ITM preference to PUT-only. The fix is straightforward (PR 2 will land it), and once deployed, the next SHORT 2% trigger should produce a materially better recovery ratio.

The other asymmetries (F2-F5) are real but smaller in magnitude. Of those, F3 (TP rule symmetry) is the most likely to surface as actionable post-pilot, but only with sufficient SHORT-side data to compare against R1's LONG-only baseline.

**Pilot impact:** with PR 2 deployed, the next SHORT 2% trigger should look more like a typical LONG trigger in terms of recovery ratio (~50-70% rather than the 8% we just observed). If after n ≥ 5 SHORT triggers we still see materially lower recovery on SHORT vs LONG, that's the signal to revisit TP rules per F3.
