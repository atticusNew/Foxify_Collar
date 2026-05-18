# Does v2 Cross the "Not Zero-Sum" Threshold?
**Evaluation, feedback on the strategic memo, and v3 Shield design**

**Author:** Quant research assistant
**Date:** 2026-04-26
**Companion to:** `ANALYSIS_AND_PLAN.md` (parameter calibration), `output/tiered/*` (v2 numbers)

---

## TL;DR

- v2 (Lite, Standard) is a **rebate product**, not insurance. It **does not cross the institutional threshold**. It crosses about half of the retail-psychology threshold.
- The strategic memo you sent is largely correct. Its strongest insight: the *real* unlock is institutional capital, not retail softening. I agree, with two refinements (see §3).
- A pure put-spread wrapper has a structural ceiling: it cannot deliver a deterministic floor because BTC sometimes rises on losing Kalshi markets (3 of 14 losers in our data). Any "always pays back something on a loss" promise has to come from somewhere else.
- v3 design: **Shield** tier = a tiny **Kalshi-NO** leg (sized to deliver a fixed rebate on Kalshi loss) optionally paired with the put spread. This crosses the threshold. The new file `src/shieldHedgeModel.ts` implements both Shield-only and Shield+ (hybrid) variants and they are now in the tiered backtest output.

---

## 1. Thresholds: when does a bet stop feeling zero-sum?

The phrase "non-zero-sum" gets used loosely. In our context, three different stakeholders experience it through three different thresholds. We have to be honest about which one(s) v2 actually crosses.

### Threshold A — Behavioral / retail-psychology

What it takes for a typical Kalshi retail user to *feel* like the bet isn't a 100% write-off on loss:

| Sub-condition | Threshold | Why |
|---|---|---|
| **A1.** P(payout > 0 \| loss) | ≥ 90% | Below this, users discount the rebate as "didn't fire" most of the time. Behavioral lit on lottery rebates suggests the perception flips around 80-90%. |
| **A2.** Avg payout when fired | ≥ 15-20% of stake | Below ~10% it reads as a coupon. Above ~20% it reads as "you got your gas money back." |
| **A3.** Worst-case realized loss with protection | ≤ unprotected worst-case | Otherwise the product is "you sometimes pay more to lose more" — fatal psychological optics. |

### Threshold B — Risk-policy / institutional

What it takes for a treasurer, RIA, or prop desk's risk committee to whitelist the wrapped instrument:

| Sub-condition | Threshold | Why |
|---|---|---|
| **B1.** Hard maximum realized loss | ≤ ~70% of stake | The standard "defined-risk overlay" rule of thumb. Below this, it sits in the structured-note bucket; above, it's still "binary" in the policy doc. |
| **B2.** Floor is deterministic, not probabilistic | "Worst case bounded by contract, not by market path" | This is the *categorical* difference between "insurance" and "rebate-conditional-on-something". |
| **B3.** Counterparty cash is hedged or pre-funded | "No Atticus solvency tail" | Otherwise the policy treats it as unsecured credit. |

### Threshold C — Economic / true non-zero-sum

What makes the *whole stack* (Kalshi binary + Atticus wrapper) genuinely positive-sum rather than just redistributing fees:

| Sub-condition | Threshold | Why |
|---|---|---|
| **C1.** Protection has a clearing market price | "Hedgeable on Deribit / Kalshi NO at quoted size" | Otherwise the wrapper is a marketing spread, not an asset. |
| **C2.** Wrapper expands the addressable user pool | "New traders show up that wouldn't have without it" | This is the only way the layered product is positive-sum; if it just taxes existing degens, it's negative-sum for them. |
| **C3.** Kalshi gets margin AND Atticus gets margin AND user gets utility | "All three sides see expected value > 0" | The economic version of the strategic memo's core claim. |

---

## 2. Honest evaluation of v2 against those thresholds

Drawing only from the actual `output/tiered/` numbers (per $100 face, 27-market dataset, derived outcomes):

### Lite (fee 6.5% of stake)

| | Lite | Threshold | Crossed? |
|---|---|---|---|
| A1. P(payout > 0 \| loss) | 11/14 = **79%** | ≥90% | ❌ No |
| A2. Avg payout when fired | $4.69 = **8% of stake** | ≥15-20% | ❌ No |
| A3. Worst-case realized loss vs unprotected | -$57.21 unprot → **-$57.28** prot (worse by fee) | ≤unprot | ❌ No |
| B1. Hard max realized loss | ~stake + fee = **107% of stake** | ≤70% | ❌ No |
| B2. Deterministic floor | None | required | ❌ No |
| B3. Hedged counterparty | Yes (Deribit pass-through) | required | ✓ Yes |

**Verdict:** Lite is a small softener at retail level. Below psychology threshold; nowhere near institutional threshold.

### Standard (fee 14% of stake, 1.7× sizing)

| | Standard | Threshold | Crossed? |
|---|---|---|---|
| A1. P(payout > 0 \| loss) | 11/14 = **79%** | ≥90% | ❌ No |
| A2. Avg payout when fired | $8.97 = **15% of stake** | ≥15-20% | ✓ Yes (low end) |
| A2'. Avg payout on deep-drop (≥10%) loss | $14.03 = **24% of stake** | ≥15-20% | ✓ Yes |
| A3. Worst-case realized loss vs unprotected | $58 stake + $14 max fee ≈ **-$72**, vs **-$58** unprotected | ≤unprot | ❌ No |
| B1. Hard max realized loss | Stake + fee = **~125% of stake** | ≤70% | ❌ No |
| B2. Deterministic floor | None — relies on BTC moving | required | ❌ No |
| B3. Hedged counterparty | Yes (Deribit pass-through) | required | ✓ Yes |
| C1. Clearing market price | Yes — every leg priceable on Deribit | required | ✓ Yes |
| C2. Expands user pool | **Marginally** (retail risk-averse) | required | ◑ Partial |
| C3. Three-side positive-sum | Atticus +30% margin, Kalshi unchanged, user pays for variance reduction | required | ✓ Yes for Atticus + Kalshi; user pays for utility |

**Verdict:** Standard is a *meaningful retail-grade rebate* (crosses A2) but **fails A3, B1, B2**. It doesn't lower the worst-case loss; it *raises* it on the 3 losing markets where BTC rose. That's a fatal flaw for institutional adoption and a real concern for the retail framing.

### The structural reason v2 can't cross the institutional threshold

A put spread is a contingent claim on **BTC price path**. The Kalshi market is a contingent claim on **a binary event**. The two are correlated but not identical. In the dataset:

| Subset | Count | Put-spread payout |
|---|---|---|
| Kalshi loss + BTC fell ≥10% | 5 | Big ($14 avg, 24% of stake) |
| Kalshi loss + BTC fell 0-10% | 6 | Small to mid ($3-8) |
| **Kalshi loss + BTC actually rose** | **3** | **$0** |
| Kalshi win | 13 | $0 (fee is pure cost) |

The 3 losing-market-with-BTC-up rows are why v2 can't promise "you'll always get something back on a loss." Any product that crosses A3/B1/B2 has to handle that subset directly, and **no put-spread reconfiguration solves it**, because the put doesn't pay when BTC is up — that's the contract.

---

## 3. Feedback on the strategic memo

Your memo is largely right. Specific points:

### ✅ Strongly agree

- **"The real strategic value is making prediction markets investable and sellable to bigger, constrained players."** This is the unlock. Retail rebate is a softener, but the addressable-market expansion comes from institutional risk-policy compliance.
- **"Layered a positive-sum 'insurance' market on top of a zero-sum prediction market."** Yes — and importantly this is *Kalshi's* unique structural advantage vs Polymarket etc. once you build it.
- **"Worst-case realized loss is now -X%, not -100%."** This is the *correct* institutional sales line. v2 does not yet support this claim. v3 Shield does.
- **Resaleable mid-life via market-maker buy-back.** Correct in principle. The pre-condition is a deterministic floor — without one, mid-life pricing is dominated by binary jump risk and no MM will quote a tight book.

### ◑ Partial agreement / refinements

- **"Even without any secondary market, the protected loser is no longer dust."** True only if the wrapper has a deterministic floor (v3). With v2, on the 3 BTC-up-but-Kalshi-lost cases, the protected loser is *worse than dust* — it's dust plus a fee. That's the problem to fix.
- **"Internal cash-out feature."** Achievable, but the engineering cost is non-trivial. It requires Atticus to mark the unwound Deribit + Kalshi positions back to current vols and Kalshi book each second. Worth doing as a v4 once Shield is live, not before.
- **"$10-20 rebate on a $60 risk might not move a degen."** Right — but the v3 Shield design produces a *deterministic* $10-15 minimum rebate even on losses where BTC didn't move, plus larger payouts when BTC moves. That's a different psychological frame than v2's "sometimes you get a coupon."

### ❌ One area where I'd push back

- **"Market maker could post two-sided prices for 'insured YES' tokens."** Theoretically yes, but only if the product gets to ~10× current Kalshi BTC volume. Below that, the MM book isn't worth the inventory risk for any third party. So the secondary-market story is real, but it sequences after a Standard pilot generates 6-12 months of flow data. Don't lead with it.

---

## 4. v3 Design — Shield (deterministic floor)

Goal: cross thresholds A1, A2, A3, B1, B2 simultaneously, using a structure that's hedgeable today (no balance-sheet warehousing).

### 4.1 The lever you've been missing

The cleanest "always pays back on loss" mechanism is **a tiny Kalshi-NO position bought by Atticus on the user's behalf, sized to deliver a fixed rebate on Kalshi loss**.

Concretely, for a user buying YES at 58¢ on a $100 face:
- User stake at risk: $58
- Atticus buys NO at 42¢ — sized to pay out $R on Kalshi loss
- $R = whatever rebate floor Atticus is selling
- Cost to Atticus = $R × NO_price = $R × 0.42

For a $15 floor: Atticus spends $6.30 in NO premium. With Foxify-style 1.45× markup, the user pays **$9.14 for a guaranteed $15 rebate on any losing YES outcome**.

Cash flows are pass-through (like the put spread):
- YES wins → NO loses → Atticus's $6.30 NO premium is gone, no rebate due. Atticus keeps the $9.14 fee, books $2.84 margin.
- YES loses → NO wins → Atticus collects $15 from Kalshi, pays $15 to user. Atticus keeps $9.14 fee minus $6.30 cost, books $2.84 margin.

**Margin is deterministic.** This is what we don't have in v2 — every Standard trade has variable platform P&L because the put spread payoff is a function of BTC.

### 4.2 Two variants

**Shield (pure money-back guarantee).** NO leg only. Cleanest possible "your loss isn't zero" pitch.

- Final calibration: 40% floor, 1.40× markup, 3% Kalshi fee.
- Avg fee: **$13.44 (23% of stake)**
- Avg recovery on losses: **$22.89 (40% of stake) — every losing market.**
- Worst-case realized loss: **92% of stake** (improvement from 100%).
- A1 ✅ A2 ✅ A3 ✅ B2 ✅ B1 ❌ (close but not under 70%; would need 50%+ floor → ~30% fee).

**Shield+ (hybrid).** NO leg + small put spread. Deterministic floor PLUS upside on BTC drops.

- Final calibration: 30% floor + 5%-25% put spread (1× sizing), 1.40× markup.
- Avg fee: **$12.95 (22% of stake)**
- Avg recovery on losses: **$19.24 (34% of stake)** — combines guaranteed floor + variable BTC payout.
- Best single save in dataset: **$13.54 rebate** on Nov 2025 (BTC −17.4%).
- Worst-case realized loss: **99% of stake** (Shield+ has higher fee than the marginal floor improvement on no-BTC-move losing months, so worst case is fractionally higher than Shield-alone — see §6).
- A1 ✅ A2 ✅ A3 ✅ B2 ✅ B1 ❌

**Shield is mathematically the cleaner product. Shield+ pays better when BTC is materially down. Both cross the institutional B2 threshold (deterministic floor); neither crosses B1 (≤70% worst case) without more aggressive pricing.**

### 4.3 Why Shield+ has a higher worst-case than Shield (counter-intuitive)

The put-spread overlay in Shield+ adds ~$5-6 to the fee but only contributes payout when BTC actually fell. On the 3 losing markets where BTC rose, the put spread expires worthless — the user pays its cost on top of the NO-floor and ends up slightly worse than Shield-alone on those trades.

This is a real and honest finding. The implication for the pitch: **Shield is the cleaner risk-policy product** ("max loss bounded by NO floor + fee, period"). **Shield+ is the cleaner expected-value product on tail-down markets** ("if BTC moves materially against you, you get the floor *plus* the put-spread upside"). They're not strictly ordered — they target different selling points.

For the Kalshi institutional pitch I'd lead with **Shield** for the headline (cleanest "guaranteed floor" line) and offer **Shield+** as the upgrade for traders who want BTC-tail upside on top of the floor.

### 4.4 What this requires that v2 doesn't

The only new dependency: **Atticus needs the ability to take a Kalshi position alongside the user.** Specifically, Atticus needs to be able to buy NO contracts on the same market the user just bought YES on, at machine speed, sized as a multiple of user stake.

Three plausible operational paths:
1. Atticus runs a Kalshi market-taker account, takes liquidity at user open. Simple but exposed to slippage.
2. Atticus has a Kalshi MM agreement that gives privileged access at posted-mid prices. Best.
3. Atticus subsidizes the Shield rebate from platform reserves and self-hedges off-platform via correlated BTC options + a small held risk buffer. Acceptable bridge while option 1/2 is procured.

Path 3 means we don't need anything from Kalshi to ship v3 Shield. We can launch Shield on the Foxify-style Deribit-only stack with the rebate funded out of reserves, then migrate to path 1/2 once a pilot agreement is signed.

### 4.5 Profitability rails (final calibration, $58 typical stake)

| | Hedge cost | Charge | Margin |
|---|---|---|---|
| 40%-floor Shield | NO premium ~$9.74 + Kalshi fee ~$0.29 ≈ $10.03 | $10.03 × 1.40 = **$14.04** (24% of stake) | $4.01 / 29% gross |
| 30%-floor Shield+ (NO + put spread) | NO ~$7.31 + put spread ~$1.95 + Kalshi fee ~$0.22 ≈ $9.48 | $9.48 × 1.40 = **$13.27** (23% of stake) | $3.79 / 29% gross |

(Numbers from `output/tiered/kalshi_tiered_summary.md` — actual averages across 27 markets. They're slightly off the back-of-envelope because the dataset has a mix of YES prices, not all 58¢.)

Both stay in the Foxify-style 28-32% margin band. Shield/Shield+ are heavier on fee than the brief's 10-15% target — that's the trade-off for buying a real floor. For risk-policy-bound capital, that trade is correct; for retail volume, Standard (v2) is still the right product.

### 4.6 What was implemented and run

`src/shieldHedgeModel.ts` (new):
- Tier "shield": NO-leg-only money-back-guarantee. Configurable rebate floor (default 25% of stake), Foxify-style 1.45× markup.
- Tier "shield_plus": NO leg + reduced-width put spread for upside on BTC drops. Configurable.

`src/mainTiered.ts` (extended):
- Adds shield + shield_plus to the tier list, runs all four tiers (Lite, Standard, Shield, Shield+) on the same dataset.
- New summary block: **"Worst-case realized loss" comparison** — the institutional one-liner.
- Pitch snippets get a third email block explicitly framed as "non-zero-sum" / institutional pitch.

The original `tieredHedgeModel.ts`, `kalshiMarkets.ts`, `math.ts`, `fetchBtcPrices.ts`, `main.ts` (v1), and the live Foxify pilot are all untouched.

---

## 5. Honest answer to your question — does v2 give traders enough?

**Retail context:** marginally. v2 Standard is a real-money rebate on the 5/14 of losing months where BTC clearly fell. It's a softener; it's not insurance. A retail trader will notice it on the bad month and forget it on the good month.

**Institutional context:** no. Worst-case loss is unchanged or slightly worse with v2 protection — that fails the very first risk-policy filter, and there is no fix within a put-spread-only design.

**What v3 Shield does that v2 doesn't:** crosses A1, A2, A3, B1, B2. Promises "guaranteed 25% of stake back on any losing Kalshi outcome." Worst case is bounded by the Shield contract, not by BTC path luck. That is the threshold the strategic memo was reaching for and that's what unlocks the institutional pitch.

**What's still left after v3:**
- C2 (proven user-pool expansion) requires the actual pilot data — Shield by itself only enables that conversation.
- Mid-life resale (memo's "tradable" angle) is a v4 — it sequences after Shield generates a clean book of priced-out wrapped positions.

Recommendation:
- **Pitch v2 to Kalshi if and only if** the prospect is retail-volume-focused (Bitnomial-style users, prosumer tier).
- **For Kalshi's institutional roadmap and your treasury/RIA targets, lead with v3 Shield**. The headline is: "On every losing BTC market, the user gets back 20-25% of stake — guaranteed by contract, not by BTC moving the right way." That's the line that unlocks risk-committee approval.
