# Live Micro Cell Pricing Verification — 2026-05-28

**Purpose:** Verify the MC-predicted hedge cost for `pair_25k_1pct_atm_micro` against live Bullish + Deribit quotes before committing $3,500 Atticus capital to a shadow/microtest run.

**Conditions:** BTC spot ~$74,125 (4-source median), DVOL ~36 (calm regime).

---

## 1. Tenor reality check

Cell design says `hedgeTenorDays: 0.167` (4 hours). **No venue offers a true 4h expiry.** Shortest available:

| Venue | Shortest expiry | Time to expiry now |
|---|---|---|
| Bullish | 2026-05-28 (0d expiry, today end-of-day) | ~6h |
| Deribit | BTC-28MAY26 (today end-of-day) | ~6.3h |

The "4h" cell config snaps to the ~6h same-day expiry in production. Acceptable proxy.

---

## 2. Live per-leg ATM ask (real numbers, just pulled)

At spot $74,125, ATM strike snapping → $74k put + $74k call:

| Venue | Tenor | Put ask ($/BTC) | Call ask ($/BTC) | Strangle ($/BTC) | Spread |
|---|---|---:|---:|---:|---:|
| **Bullish** | 6h (0d) | $250 | $370 | $620 | 22% / 21% |
| **Bullish** | 24h (1d) | $560 | $680 | $1,240 | 9% / 9% |
| **Deribit** | 6.3h | $244.58 | $370.57 | $615.15 | 16% / 15% |
| **Deribit** | 30.3h | (not probed) | (not probed) | | |

**Venues agree within 1%** at ATM 6h. Either single venue works for this cell. Bullish slightly wider spread but tighter market depth (15-17 BTC top-of-book vs Deribit's 0.8-21 BTC).

---

## 3. Live cost per pair at micro cell contracts (0.3 BTC)

| Venue | Tenor | Hedge cost per pair |
|---|---|---:|
| Bullish | 6h | **$186** |
| Bullish | 24h | $372 |
| Deribit | 6.3h | **$184.55** |
| MC prediction (4h, calm σ) | 4h | $128 |

**Live cost is ~$186 — about 45% higher than MC predicted ($128).**

Reason: MC used a BS-fair calibration with a generic 1.07 fudge factor for venue markup. Real Bullish/Deribit ATM ask carries a ~16-22% bid-ask spread that the MC under-counted.

---

## 4. Revised Foxify EV estimate at live spreads

Using $186 actual hedge cost (vs $128 MC), recomputing the calm-regime mean:

**Per-pair expected outcomes at calm (trigger rate 33.5%):**

| Outcome | Probability | Salvage ≈ | Foxify net per pair |
|---|---:|---:|---:|
| Trigger fires (1% move = $740) | 33.5% | Put intrinsic ≈ $740/BTC × 0.3 = $222 + call residual ≈ $50 → $272 × 0.85 slip = $231 | +$45 uplift → Atticus floor $25 binds → Foxify +$20 |
| No trigger, time decay to expiry | 66.5% | ATM options decay ~75% over 6h = $46 | -$140 |

**Mean Foxify EV per pair (calm, live spreads):**
0.335 × (+$20) + 0.665 × (-$140) = **-$86 per pair** at calm regime.

**This is materially worse than the MC's +$39 prediction.** The micro cell at calm with real Bullish spreads is **negative EV**.

### Higher regimes (rough recalc)

| Regime | Trigger rate | Hedge cost (regime markup) | Salvage ≈ | Foxify EV/pair |
|---|---:|---:|---:|---:|
| Calm σ=0.35 | 33.5% | $186 | (above) | **-$86** ❌ |
| Moderate σ=0.55 | 78.9% | ~$200 | higher-IV-larger-move → $400 × 0.85 = $340 | uplift $140 → Atticus floor $25 binds → Foxify +$95 → mean = 0.79×$95 + 0.21×(-$160) = **+$41** ⚠️ |
| Elevated σ=0.75 | 95% | ~$223 | $550 × 0.85 = $467 | uplift $244 → Foxify +$200 ≈ mean **+$180** ✅ |
| Stress σ=0.95 | 99% | ~$251 | $700 × 0.85 = $595 | uplift $344 → Foxify +$290 ≈ mean **+$285** ✅ |

(Rough — needs proper MC re-run with live spread inputs.)

**Implications:**
- Micro cell at **calm regime is negative-EV with real spreads** — not safe to run.
- Micro cell at **moderate+ is positive but lower than MC suggested** by ~40-50%.
- Today's regime is calm (DVOL ~36) → micro cell would lose money if activated today.

---

## 5. Comparison to longer-tenor variants

The MC sweep ran the micro cell at "4h" but real production = 6h. A 24h variant would be:

| Cell variant | Tenor | Live cost | Comments |
|---|---|---:|---|
| `pair_25k_1pct_atm_micro` (4h) | 6h | $186 | Worse than MC at calm |
| `pair_25k_1pct_atm_24h` (proposed) | 24h | ~$372 | More time to trigger, more time decay |
| `pair_25k_1pct_atm_2d` (proposed) | 48h | ~$500+ | Even more time to trigger |

A 24h variant gets 4x more time for a 1% move to fire. Trigger rate at calm should rise from 33% (4h) to maybe 60-70% (24h). But hedge cost doubles. Need MC re-run with live spread to know.

---

## 6. What we should actually do

Three actions, in order:

### (a) Re-run cell sweep with live spreads — IMMEDIATE
Update `runCellSweep.ts` to use live bid-ask spread per leg (from PR C1 smile model + live orderbook). The current sweep uses BS-fair price with a 1.07 fudge. The 45% gap means several "profitable" cells in the sweep may actually be loss-making.

Estimated work: ~2 hours. Tells us which cells are REALLY profitable today.

### (b) Probe additional cell variants — IMMEDIATE
Specifically probe a 24h-tenor micro variant (`pair_25k_1pct_atm_24h`) since longer tenor may offer better trigger-rate / cost balance with real spreads.

Estimated work: ~1 hour.

### (c) Hold the live cutover until live-spread sweep done
Don't commit Atticus's $3,500 to the current micro cell at calm. Live verification shows it's likely loss-making. Need to either:
- Wait for moderate regime (DVOL > 40)
- Use a different cell that handles current spreads
- Adjust the micro cell parameters (e.g., 24h tenor + 0.5 BTC contracts)

### (d) Run shadow bot regardless
Shadow doesn't spend real money. Even if cell EV is uncertain, shadow data over 14 days against real triggers tells us actual cell performance. Run shadow at micro cell + 50k/2% cell in parallel, see which actually performs.

---

## 7. Bottom line — honest summary

**Good news:** Bullish creds work, Deribit accessible, live pricing pulls cleanly, both venues quote ATM at agreement within 1%. The infrastructure is ready to run.

**Bad news:** the micro cell's MC-predicted +$39/pair calm EV is likely overstated by ~$125. Real EV at live spreads is closer to **-$86/pair at calm**. Running 25 pairs/day of this cell in current calm conditions would burn ~$2,150/day in losses against the $3,500 capital — wiped out in ~36 hours.

**Recommendation:**
- DO NOT activate the micro cell live at current calm regime
- DO run shadow bot to gather 2 weeks of real data (no money risk)
- DO re-run cell sweep with live-spread cost model (Step (a) above)
- DO wait for moderate+ regime OR pick a cell that performs at current spreads

**The whole point of live verification is to catch this kind of MC vs reality gap BEFORE risking capital.** Catching it is a win, not a setback.

---

*Generated via curl-based live probe + manual recalculation. Sources: Coinbase + Deribit public APIs, Bullish via Render-proxied admin endpoint.*
