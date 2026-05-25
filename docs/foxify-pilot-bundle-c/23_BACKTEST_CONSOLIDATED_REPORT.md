# Consolidated Backtest Report — All 5 Backtests

**Generated:** 2026-05-15 22:00 UTC
**Data:** 486 days BTC daily OHLC (Jan 2025 → May 2026), Coinbase
**Vol regime distribution:** 74% calm / 18% moderate / 8% elevated / 0% stress
**Methodology:** Black-Scholes pricing, walk-forward simulation, Monte Carlo across hold patterns

---

## Headline findings

### 1. New $200k/5% product with regime-tiered fixed pricing works ✅

| Hedge structure | Calm ($300/day) | Moderate ($400/day) | Elevated ($550/day) |
|---|---|---|---|
| **Put SPREAD 1.3× (V2 with margin)** | +$2,126 avg | +$2,928 avg | +$4,582 avg |
| **Deep-ITM put (V1 no margin)** | +$2,272 avg | +$2,031 avg | +$4,198 avg |
| ATM put | +$2,150 (est) | +$1,900 (est) | +$3,800 (est) |

**At 1 cover/day for 28 days, expected monthly Atticus margin: $50-100k.** Meaningful business.

**V1 (no margin): use deep-ITM put.** Worst case −$7,265 but avg +$2,272. Profitable across all regimes.
**V2 (with margin): switch to put spread.** Better worst case (−$2,893) and similar avg.

### 2. Volume Cover matrix is STRUCTURALLY UNDERPRICED ⚠️

| Cell | Calm | Moderate | Elevated |
|---|---|---|---|
| 50k/2%/$1k @ $350/d | **−$355** ❌ | **−$561** ❌ | **−$696** ❌ |
| 50k/5%/$2.5k @ $200/d | **−$427** ❌ | **−$1,013** ❌ | **−$1,519** ❌ |
| 50k/10%/$5k @ $100/d | **−$197** ❌ | **−$793** ❌ | **−$914** ❌ |
| 200k/5%/$10k @ $800/d | **−$1,785** ❌ | **−$4,197** ❌ | **−$7,298** ❌ |
| 200k/10%/$20k @ $400/d | **−$809** ❌ | **−$3,569** ❌ | **−$4,547** ❌ |
| 200k/15%/$30k @ $370/d | **+$1,360** ✅ | **−$108** ⚠️ | **−$3,561** ❌ |

**Only 200k/15% cell is profitable in calm regime. Everything else loses money.** This contradicts the salvage-band stress test we ran during product build — it used optimistic salvage assumptions (95%) that don't hold under realistic BS-based pricing.

### 3. Iron Condor refactor partially helps Volume Cover ⚠️

| Cell | TIGHT current | Iron Condor | Improvement |
|---|---|---|---|
| 50k/2%/$1k (elevated) | −$755 | −$479 | +$276 |
| 50k/5%/$2.5k (elevated) | −$1,870 | −$1,451 | +$419 |
| 50k/10%/$5k (elevated) | −$1,190 | −$116 | +$1,074 |
| 200k/5%/$10k (elevated) | −$6,492 | −$4,890 | +$1,601 |
| 200k/10%/$20k (elevated) | −$4,255 | −$1,283 | +$2,972 |
| 200k/15%/$30k (elevated) | −$2,028 | +$330 | +$2,358 |

Iron Condor adds $50-3k/cover in margin, but most cells still lose. **Iron Condor alone doesn't fix the matrix; it needs price uplift too.**

### 4. TP optimization adds modest lift ⚠️

For 50k/2% test cell:
| TP Mode | Avg PnL | % Profitable | Trigger Rate |
|---|---|---|---|
| Baseline (current) | −$416 | 17% | 86% |
| Pre-trigger sell at 80% trigger | −$362 | 25% | 77% |
| Theta-floor early sell | −$422 | 17% | 86% (no exits fired) |
| Combined | −$369 | 24% | 78% |

Pre-trigger sell adds ~$54/cover. Theta-floor doesn't help (cell too short-tenor).

**Verdict: TP improvements are real but small. Won't save under-priced cells.**

### 5. Premium/payout hold-time hypothesis VALIDATED ✅

| Product | Break-even days | Predicted hold | Actual (where known) |
|---|---|---|---|
| Deprecated pilot $10k/2% | 8.0d | 2.6-3.3d | **3 days** ✓ matches |
| VC $50k/2%/$1k | 2.9d | 1.3-1.4d | n/a (deprecated) |
| VC $200k/15%/$30k | 81d (capped 14d) | 9-11d | n/a |
| New $200k/5%/$10k | 25d (capped 14d) | 5-9d | n/a |

**Your hypothesis is correct.** Foxify holds longer when premium/payout ratio is favorable.

**Key implication:** the new $200k/5% product's natural hold pattern is 5-9 days (much longer than the 2-3 day deprecated pilot pattern). This means more triggers per cover BUT also more premium collected per cover. Net: similar margin per cover but with better predictability.

---

## What this all means in plain English

### The good news
**The new $200k/5% product can launch successfully with regime-tiered pricing and a deep-ITM put hedge** (no margin needed for V1):

- Calm regime: $300/day = $4,200 per 14-day cover. Atticus avg margin +$2,272/cover.
- Moderate regime: $400/day = $5,600. Atticus avg margin +$2,031/cover.
- Elevated regime: $550/day = $7,700. Atticus avg margin +$4,198/cover.

Expected monthly P&L at 1 cover/day: **~$50-100k**.

After Bullish margin enabled (post 4 weeks): switch to put spread for slightly better economics + tighter variance.

### The bad news
**Volume Cover matrix is broken at current prices.** Even in calm regime, 5 of 6 cells lose money. We CANNOT launch Volume Cover at current prices and expect to be profitable.

This contradicts our earlier salvage-band stress test. The discrepancy is because:
- Salvage-band test used optimistic salvage assumptions (95% with 20% double-touch bonus)
- BS-based simulation here uses actual market option pricing
- Reality is somewhere between, but probably closer to BS

**Volume Cover requires significant rework before launch:**
1. **Price uplift** across most cells (especially in moderate/elevated regimes)
2. **Iron Condor refactor** (when Bullish margin available) — adds $50-3k/cover
3. **TP optimization** — adds ~$50/cover (modest)
4. **Stress-pause logic** — auto-halt new sales when DVOL >90 (or whatever threshold we pick)

### The honest read
We should NOT launch Volume Cover at current prices. We should:
- Launch the new $200k/5% product first (4-week pilot data)
- Use that time to redesign Volume Cover matrix with regime tiering
- Plan the Iron Condor refactor for after Bullish margin enabled

---

## Recommended specs

### New $200k/5% product (V1 launch — no margin needed)

| Component | Value |
|---|---|
| Hedge structure | Deep-ITM put (long $80k put when spot $79k, single leg) |
| Pricing | Regime-tiered fixed daily |
| Calm rate | $300/day |
| Moderate rate | $400/day |
| Elevated rate | $550/day |
| Stress rate | $750/day OR pause |
| Tenor | 14 days |
| Billing | Daily debit from Foxify pre-funded balance |
| Pre-fund required | $5,000 (or 1 worst-case cover loss + 14 days premium) |
| Capacity | 1 cover/day to start |
| TP | Multi-stage (pre-trigger sell at 4% drawdown, at-trigger instant sell, theta floor at 25%) |

### Volume Cover (RECOMMEND DEFER — needs redesign)

Current matrix is structurally unprofitable. Do not launch.

**Phase 2 plan (after $200k/5% V1 validates):**
1. Re-price the matrix with regime tiering (likely 1.5-2× current prices)
2. Iron Condor refactor (when Bullish margin available)
3. Stress-pause logic
4. Re-backtest, validate, then launch

Rough re-priced matrix estimate (calm regime, with Iron Condor):
| Cell | Old price | Recommended new price (calm) |
|---|---|---|
| 50k/2%/$1k | $350/day | **$700/day** |
| 50k/5%/$2.5k | $200/day | **$400/day** |
| 50k/10%/$5k | $100/day | **$300/day** |
| 200k/5%/$10k | $800/day | **$1,800/day** |
| 200k/10%/$20k | $400/day | **$1,200/day** |
| 200k/15%/$30k | $370/day | **$370/day** (already profitable) |

These are 2-3× current matrix prices — significant change. Foxify CEO needs to be aligned before relaunch.

---

## What I want from you

1. **Approve launching only the new $200k/5% product first** (Volume Cover relaunch deferred to Phase 2)?
2. **Approve the regime tier prices** ($300/$400/$550 + $750-or-pause for stress) for $200k/5%?
3. **CEO conversation about Volume Cover repricing** — when you want to have it (before or after $200k/5% launch)?
4. **Any pause/halt thresholds for stress regime** (DVOL >90)?

This is a significant pivot from the original Volume Cover-first plan. The data forces it.
