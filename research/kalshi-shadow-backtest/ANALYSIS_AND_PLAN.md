# Kalshi Shadow Backtest — Analysis, Feedback & Re-Backtest Plan

**Author:** Quant research assistant (cloud agent)
**Date:** 2026-04-26
**Scope:** `research/kalshi-shadow-backtest/` only — Foxify pilot is **not touched** in any way.

---

## 1. What I reviewed (and explicitly did NOT touch)

Reviewed (read-only):
- `research/kalshi-shadow-backtest/src/math.ts`
- `research/kalshi-shadow-backtest/src/hedgeModel.ts`
- `research/kalshi-shadow-backtest/src/kalshiMarkets.ts`
- `research/kalshi-shadow-backtest/src/main.ts`
- `research/kalshi-shadow-backtest/src/fetchBtcPrices.ts`
- `research/kalshi-shadow-backtest/output/*` (existing run artifacts)

Did not touch:
- `services/api/**`, `services/hedging/**`, `packages/shared/**`, or anything under the live Foxify pilot tree.
- The original `hedgeModel.ts` / `main.ts` / `math.ts` / `kalshiMarkets.ts` files.

All new code lives in **new** files in this same research directory:
- `src/tieredHedgeModel.ts` (new)
- `src/mainTiered.ts` (new)
- `src/realDataPolicy.ts` (new — small utility, see §6)

The original v1 backtest entry point still works exactly as before.

---

## 2. Why the v1 numbers don't sell

The v1 results are real but structurally undersized for a pitch:

| v1 stat | Value | Pitch problem |
|---|---|---|
| Avg fee | $0.91 / $100 contract | ≈ 1.5% of a typical $58 stake — **invisible** to a trader |
| Best single user save | $2.22 on $0.88 fee | "Pay 88¢, save $2.22" reads as a coupon, not insurance |
| Avg return-on-trigger | 3.3× | Headline is fine, but applies to a tiny absolute fee |
| Payout-to-premium on losing trades | 0.7× | Looks like a bad deal in aggregate ($133k paid, $87k recovered) |
| Worst loser (2025-02) | $-58 → $-55.92 | Protection moved a $58 loss to $55.92 — **not a story** |

### Root cause (mechanical)

`quoteKalshiBundle()` in `hedgeModel.ts` takes the Foxify production schedule (1-day premiums per $1k of full notional at the **5% SL tier**), scales by `√30 × 0.65`, and applies a 1.40 markup. That produces a per-$1k charge in the $5–$10 range (i.e., 0.5–1.0% of full notional, 0.85–1.6% of typical at-risk).

Two things compound:
1. **Premium is too small** because the Foxify 5% tier was designed for 1-day rolling drawdown coverage, not a 30-day Kalshi-style window. The √T × 0.65 scalar tries to bridge it but undershoots the actual 30-day Deribit put-spread cost.
2. **Payout is capped at the SL difference (5%)** because the model uses `SL_PCT["10pct"] − SL_PCT["5pct"] = 0.05` as spread width regardless of the actual strike geometry. A 5%-wide spread on the at-risk amount caps recovery at 5% × at_risk ≈ $2.90 on a $58 stake, no matter how far BTC falls.

So v1 is internally consistent with Foxify's prior, but it's the *wrong product shape* for Kalshi. Kalshi traders aren't buying drawdown protection on a 1-day basis — they're buying a 30-day binary and want 30-day coverage with payouts that materially change the loss number.

### Secondary issue (data sanity)

`kalshiMarkets.ts` has a few comments contradicting the recorded outcome (e.g. KXBTCD-25NOV28-110000 is recorded `outcome: "yes"` but the comment notes BTC ≈ $97k at settle, which is below the $110k strike → should be NO). I'm **not** silently editing these — I flag them in the new run, and the new model derives "Kalshi loss" mechanically from `direction × strike × btcAtSettle` and **also** prints the recorded `outcome` for comparison. That way the agent sales material is auditable.

---

## 3. Feedback on the suggested target user economics

Your suggested targets, summarised:

| Tier | Fee | Recovery in bad states | Cash example ($58 stake, $58 loss) |
|---|---|---|---|
| Lite | +5–7% of stake | 20–30% of loss recovered | Pay ~$3–4, recover ~$12–18 |
| Standard | +10–15% of stake | 40–60% of loss recovered | Pay ~$6–9, recover ~$23–35 |

**Where they are right:**
- 5–7% / 10–15% fee bands are the right zone. v1's 1.5% is too quiet.
- 30-day tenor matched to monthly Kalshi expiry is correct.
- "Closer-to-ATM long leg" is the right lever. v1's 5% OTM trigger means BTC has to fall 5%+ before *any* protection activates.
- 25–40% platform margin is the right margin band — Foxify's 40% is probably the floor for a pure-put-spread Atticus-on-Kalshi product because Deribit fills cost more in 30-day tenors than 1-day.

**Where I push back:**

The 40–60% recovery target for Standard is partially achievable with a put-spread alone, **but** only on BTC-drawdown markets. Concretely:
- A 30-day BTC put spread can deliver, at most, `width × at_risk` in payout, and only when BTC actually falls past the floor.
- In our 27-market sample, **3 out of 12 losing markets had BTC actually rise** (e.g., 24MAY31 BTC +15.8%, 24JUL31 +2.8%, 25DEC31 +1.4%). The strike was wrong, but BTC didn't move down. A put-spread cannot recover those losses no matter how it's priced.
- For the 9 losers where BTC fell, observed drops are: 1.9, 4.0, 4.3, 5.2, 8.5, 10.9, 13.0, 14.4, 16.2 (%). To deliver 50% recovery on a $58 loss, the spread must pay $29 — i.e., width × at_risk ≥ $29 → width ≥ 50%, **and** BTC must fall through the floor. For the typical 10–15% fall, payout is naturally bounded at ~10–15% of at_risk regardless of how wide we make the spread.

So the put-spread alone can credibly hit:
- **Lite:** 5–7% fee, 8–14% of stake avg recovery in BTC-drop losers, peak recovery ~16% of stake. ← Achievable.
- **Standard:** 10–14% fee, 12–22% of stake avg recovery in BTC-drop losers, peak recovery 25–30% of stake. ← Achievable.

To honestly hit the **40–60% recovery on every losing market** target requires a *hybrid* structure (BTC put spread **plus** a small Kalshi-NO position at the same expiry). That hybrid is documented as a "Pitch v3 — Hybrid Wrapper" idea in the new outputs but **not** in the headline numbers, because it depends on Kalshi providing the NO leg at our cost basis (not a unilateral Atticus capability).

I think this is actually a stronger pitch story:
- Headline: "Pure BTC put-spread wrapper, calibrated to your real markets, delivers fee % and recovery % targets X and Y."
- Upgrade hook: "If we can route a small Kalshi NO position alongside, we can promise 40–60% loss recovery deterministically — that's the v2 pilot ask."

This separates "what we can ship today via Deribit" from "what we can ship if Kalshi opens a market-maker / pro-trader API".

---

## 4. Concrete re-backtest design

### 4.1 Pricing approach — direct BS, not Foxify-tier-scaled

The new model uses `bsPut()` (already in `math.ts`) to price actual strikes on each market's `btcAtOpen` and the realised-vol-derived IV at that date. This:
- Removes the artificial `× √30 × 0.65` scalar (which underprices 30-day premiums).
- Lets us choose **strike geometry** independent of the Foxify 1-day SL-tier curve (the user's stated lever).
- Keeps the same volatility pipeline (`impliedVolFromRealized` + `ivForMoneyness`) so vol-risk-premium and skew are still applied consistently with v1.

This is the right knob to twist when fitting fee % / recovery % targets — strike OTM-distance and spread width are 1:1 mapped to fee and max payout.

### 4.2 Tier parameters (initial — to be calibrated by run)

| Tier | Long-put OTM | Short-put OTM | Spread width | Markup | Charge target | Max payout |
|---|---|---|---|---|---|---|
| Lite | 2% | 18% | 16% | 1.40 | 5–7% of stake | 16% of at_risk |
| Standard | 0% (ATM) | 30% | 30% | 1.50 | 10–14% of stake | 30% of at_risk |

Solved "backwards" from fee target: given a 30-day BTC put spread at moderate-regime IV (~70% with vol-risk premium), the long ATM put alone is ~8% of notional, and the long-2%-OTM put is ~7% of notional. The short legs at 18% / 30% OTM remove ~3% / ~1% respectively, leaving net spread cost ~4% (Lite) and ~7% (Standard) of notional. With Foxify's 1.4× markup applied to the at-risk amount and a typical $58 at-risk on a $100 face, this puts Lite at ~$3 (5%) and Standard at ~$6 (10%) of stake — at or near the bottom of the target bands. We bump Standard's markup to 1.5× and lift the long leg to ATM to land in the 12% zone.

If the run shows we're under/over the target band, we'll re-tune **strike geometry first, markup second**. The tier params are kept in a single config block at the top of `tieredHedgeModel.ts` so re-tuning is one diff.

### 4.3 What we report per tier

For each tier (Lite, Standard) we'll produce:

1. **Per-market trade log** (CSV): same columns as v1 plus a `tier` column.
2. **Tier comparison table** in the markdown summary:

   | Stat | Lite | Standard |
   |---|---|---|
   | Avg fee (% of stake) | … | … |
   | Avg fee ($) on typical $58 stake | … | … |
   | Avg recovery in **all** losing markets (% of stake, $) | … | … |
   | Avg recovery in **BTC-fell-in-losing-market** subset (% of stake, $) | … | … |
   | Fraction of losing markets with payout > 20% of stake | … | … |
   | Avg user net P&L on losing markets (unprotected vs protected, $) | … | … |
   | Platform avg margin per trade (%) | … | … |
   | Platform total P&L (raw, scaled) | … | … |

3. **Email-ready snippets** (replacing v1's snippets): one block per tier, showing the cash story for a $58 stake.

### 4.4 What stays the same vs v1

- BTC price source (Coinbase → Binance fallback) — unchanged.
- 27 settled Kalshi markets dataset — unchanged.
- `realizedVol30d` / regime classifier — unchanged.
- `tpRecoveryRate` (TP salvage on un-triggered hedges) — unchanged, still applied to platform P&L.
- Volume scaling factor for "real Kalshi volume" reporting — unchanged.

### 4.5 What's new vs v1

- New file `src/tieredHedgeModel.ts` — direct BS pricing, two tiers, configurable strike geometry.
- New file `src/mainTiered.ts` — runs both tiers and produces tier-comparison outputs.
- New output files (do not overwrite v1):
  - `output/tiered/kalshi_tiered_trades.csv`
  - `output/tiered/kalshi_tiered_summary.md`
  - `output/tiered/kalshi_tiered_pitch_snippets.md`
- New npm script: `npm run backtest:tiered`.

---

## 5. Profitability & sustainability check

Before committing to the tiered design, we verify that even at the more user-friendly economics (lower margin in absolute terms because of the higher base premium) the platform stays sustainable:

- **Lite hedge cost per trade (typical):** ~$2.15 (3.7% of $58 at-risk).
- **Lite charge:** ~$3.01 (markup 1.4× → 28.6% gross margin per trade).
- **Lite TP recovery on un-triggered hedges:** ~$0.60 (40–55% of hedge cost × 0.6 spread haircut).
- **Lite expected platform P&L per trade:** charge − hedgeCost + p(no-trigger) × tpRecovery ≈ $3.01 − $2.15 + 0.7 × $0.60 ≈ **+$1.28 / trade**.

- **Standard hedge cost per trade (typical):** ~$4.12 (7.1% of $58 at-risk).
- **Standard charge:** ~$6.18 (markup 1.5× → 33.3% gross margin per trade).
- **Standard TP recovery on un-triggered hedges:** ~$1.15.
- **Standard expected platform P&L per trade:** ≈ $6.18 − $4.12 + 0.7 × $1.15 ≈ **+$2.86 / trade**.

In both cases the platform's structural P&L is positive in expectation, with the fee step from v1 → Standard increasing per-trade revenue ~6–7×. Tail risk (BTC fall through K_low and full max payout) is bounded because the spread is fully hedged on Deribit (cash flows cancel) — Atticus is not warehousing the put. This is the same pass-through structure as the live Foxify pilot, just with different strikes and tenor.

---

## 6. Real-data policy (auditing & honesty)

Two small but important additions:

1. **Recorded-vs-derived outcome flag.** For each market, the new run prints both `kalshiMarkets.outcome` (curated) and `derivedOutcome = (btcAtSettle direction strike)`. Any mismatch is flagged. We don't silently mutate the dataset, but the pitch numbers can be reproduced with whichever convention the prospect trusts.
2. **Volume scaling honesty.** v1 hard-codes `SCALE_FACTOR = 7407` (assumed $750k avg notional × 27 markets / $100 face). The new pitch snippets keep that figure but also report the raw $-per-$58-stake numbers prominently, because that's the number a Kalshi trader can verify against their own account history.

---

## 7. What I'm running next

1. Implement `src/tieredHedgeModel.ts` (direct-BS, two tiers, configurable strikes).
2. Implement `src/mainTiered.ts` (tier comparison report).
3. Add `npm run backtest:tiered` script.
4. Run end-to-end. Inspect tier metrics. If avg fee % is outside the 5–7% / 10–15% bands, adjust strike OTM (primary) and markup (secondary) and re-run.
5. Write final pitch snippets — replacing v1's "0.91¢ avg fee" headline with concrete tier cash numbers.
6. Commit + push + open PR.

The end state: two pitch-ready bundles (Lite, Standard) with cash numbers a Kalshi trader can map to their own positions, plus a documented hybrid v3 idea for the next-stage pilot conversation.
