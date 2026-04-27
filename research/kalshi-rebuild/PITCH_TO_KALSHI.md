# Atticus → Kalshi: Options-Hedge Bridge

**Date:** April 27, 2026
**Audience:** Kalshi product / partnerships
**Format:** This document is the source content for a 30-minute meeting + a short follow-up deck. Sections are ordered roughly as they should be presented.

---

## 1. The one-line pitch

Atticus is a thin overlay that lets a Kalshi trader buy a BTC bet and a real Deribit BTC put/call vertical-spread hedge **in one ticket**. We don't take the other side of your binary, we don't make a market, we don't warehouse risk. We're a procurement bridge to options-market depth that Kalshi traders can't otherwise access on your platform.

---

## 2. The trader cash story

Two tiers, calibrated for materially different price points and protection depths. The right framing is **stake-size dependent**: the absolute dollar gap between Standard and Shield is small at $40 and grows materially at $100+.

### On a $40 stake (median retail)

| | No protection | Standard | Shield |
|---|---|---|---|
| Premium at entry | $0 | **$5.64** (14% of stake) | **$8.65** (22% of stake) |
| Median BTC-adverse losing month, net P&L | -$40 | -$27 (**saved $13**) | -$20.80 (**saved $19.20**) |
| Worst BTC-adverse month in dataset, net P&L | -$31 | -$25 (saved $5.78) | -$23 (saved $8.26) |

### On a $100 stake

| | No protection | Standard | Shield |
|---|---|---|---|
| Premium at entry | $0 | $14.09 (14%) | $21.62 (22%) |
| Median BTC-adverse losing month, net P&L | -$100 | -$67.50 (**saved $32.50**) | -$52 (**saved $48**) |
| Worst BTC-adverse month in dataset, net P&L | -$78 | -$64 (saved $14) | -$57 (saved $21) |

### On a $250 stake (active retail / desk)

| | No protection | Standard | Shield |
|---|---|---|---|
| Premium at entry | $0 | $35.23 (14%) | $54.05 (22%) |
| Median BTC-adverse losing month, net P&L | -$250 | -$169 (**saved $81**) | -$130 (**saved $120**) |
| Worst BTC-adverse month in dataset, net P&L | -$195 | -$159 (saved $36) | -$143 (saved $52) |

**Reading the table:** at $40, Shield costs only $3 more than Standard for $6 more in median recovery — small absolute dollars. At $250, Shield costs $19 more for $39 more recovery — meaningful real money. **The UX should default Standard for small stakes and dynamically surface Shield's $-saved upgrade math at higher stakes.**

---

## 3. Why two tiers (the tier-differentiation story)

The cleanest evidence that the two tiers do different things is the histogram of recoveries on the BTC-adverse losing months in our backtest:

| Recovery bucket (% of stake paid back on losing month) | Standard | Shield |
|---|---|---|
| 0% (no payout) | 1 | 0 |
| 1-20% of stake | 3 | 1 |
| **20-35% of stake** | **18 ←** | 4 |
| **35-50% of stake** | 0 | **17 ←** |
| ≥ 50% | 0 | 0 |

Standard's modal recovery is 20-35% of stake; Shield's modal recovery is 35-50%. The tier difference shows up in the *typical* trade, not just the outlier.

The tradeoff is concrete:
- Standard ↔ Shield: **+50% fee, +50% recovery**. Roughly 1.5× the cost for 1.5× the protection.
- Both tiers cover the entire ABOVE/BELOW BTC market surface (60 of 68 settled markets in our backtest were ABOVE/BELOW; HIT events are excluded — see Section 9).

---

## 4. Why the trader hasn't seen this before

A Kalshi market maker structurally cannot sell a 30-day BTC put. Only an options exchange can. The closest current alternative for a Kalshi BTC trader who wants downside protection is to:

1. Open a separate Deribit (or CME) account
2. Pass KYC, fund it
3. Manually compute strikes that match their Kalshi exposure
4. Execute on a different platform with different settlement

99% of Kalshi retail won't do that. **Atticus does it for them in one click**, hedged at live Deribit prices, settled inside the Kalshi-flow UX.

---

## 5. Why Kalshi cares (institutional unlock)

Today: institutional desks (corporate treasuries, RIAs, prop trading shops with ESG/risk-policy constraints) can't size meaningfully into Kalshi BTC contracts because the binary 100% loss is unbounded vs their risk policy.

With Atticus Shield: max realized loss on a losing BTC-adverse month drops from −100% of stake to roughly −60% of stake. That moves the wrapped instrument from "binary" to "structured overlay" in a typical risk-policy taxonomy.

**This unlocks ticket sizes that retail-only product can't reach.** Even a 5% capture rate on professional flow above Kalshi's current BTC volume is a multi-million dollar TAM expansion.

---

## 6. How it works (mechanism, in concrete numbers)

Walking through one trade end-to-end. Live Deribit pricing as of this morning: BTC ≈ $79,200.

Trader buys "BTC > $80k by May 30" YES on Kalshi for $40 (≈$58 face value at 58¢).

**At entry, Atticus simultaneously buys on Deribit:**
- **Standard tier**: Long BTC-29MAY26-78000-P + Short BTC-29MAY26-74000-P (2%-OTM-from-spot put spread, 5% width). Sized at 6.5× user at-risk.
- **Shield tier**: Long BTC-29MAY26-78400-P + Short BTC-29MAY26-73600-P (1%-OTM put spread, 6% width). Sized at 8× user at-risk.

**Net cost from this morning's chain:**
- Standard: ≈ $5.64 → trader pays $5.64 fee
- Shield: ≈ $8.65 → trader pays $8.65 fee

**Settlement scenarios on Standard:**

| BTC at settlement | Kalshi outcome | Deribit spread payoff | Trader's net P&L |
|---|---|---|---|
| ≥ $80k (BTC up, trader right) | Trader wins +$29 | $0 (out of money) | +$23 (Kalshi win, fee paid) |
| $76k (BTC down 4%, trader wrong) | Trader loses -$40 | $0 (still above 78k long-leg) | -$46 (full loss + fee) |
| $73k (BTC down 7.7%) | -$40 | ~$13 (spread paying) | **-$32** (recovered $14 of loss after fee) |
| $66k (BTC down 16.5%, dataset worst) | -$40 | $13 (spread maxed) | **-$32** (capped) |

**Settlement scenarios on Shield (same trade):**

| BTC at settlement | Trader's net P&L (Standard) | Trader's net P&L (Shield) |
|---|---|---|
| ≥ $80k | +$23 | +$20 (fee was higher) |
| $76k | -$46 | -$48 |
| $73k | -$32 | -$28 |
| $66k | -$32 | **-$22** (Shield's wider/larger spread keeps paying) |

In every case, Atticus is procuring a real options trade. The hedge is fully Deribit-funded at entry; we don't warehouse, we don't take the binary's other side.

---

## 7. Capital efficiency (the institutional metric)

For a desk evaluating the wrapper, the question isn't "what fee do I pay" — it's "how much protected BTC notional do I get per dollar of premium":

| Tier | Fee / protected BTC notional |
|---|---|
| Standard | 2.17% |
| Shield | 2.70% |

For comparison, bank-OTC 30-DTE BTC verticals run 2-5% of notional. Both Atticus tiers sit at the bottom of that range — competitive with bank pricing — with a single-flow UX that no bank can offer.

---

## 8. Tier ladder summary

| | Standard | Shield | Shield-Max (institutional only) |
|---|---|---|---|
| Geometry | 2%-OTM-from-spot, 5% width, 6.5× sized | 1%-OTM, 6% width, 8× sized | ATM, 8% width, 12× sized |
| Avg fee (% of stake) | 14% | 22% | 43% |
| Median recovery on BTC-adverse losing months | 33% of stake | 48% of stake | 96% of stake |
| Avg recovery (% of stake) | 28% | 42% | 85% |
| User EV cost | -2.5% | -3.9% | -7.8% |
| Use case | Default retail | Stronger protection / larger stakes / risk-averse | Hide from retail UI; institutional desks only |

**Recommended retail surface:** Standard pre-selected; Shield as a one-toggle upgrade with dynamic $-saved framing based on the user's stake. **Shield-Max should not be in the default trader UI** — surface it only for verified institutional accounts via API or "advanced" settings.

---

## 9. Platform economics (what's in it for both of us)

Atticus runs **13% net margin** on the markup over real Deribit fill cost. Pure pass-through; no warehousing.

**Per-market revenue** (per $750k Kalshi BTC market notional, 16 markets/yr):

| Tier | @ 5% Kalshi opt-in | @ 10% | @ 15% |
|---|---|---|---|
| Standard | $1,024 | $2,048 | $3,073 |
| Shield | $1,460 | $2,919 | $4,378 |
| Shield-Max | $2,926 | $5,852 | $8,778 |

**Annualised:** Shield at 10% Kalshi BTC opt-in = ~$46,704/year today.

The big number isn't today's volume. It's the institutional unlock: at 10× Kalshi BTC TAM growth (driven *by* the wrapper's existence in the desk-flow distribution channel), the same structure delivers ~$467,040/year. **At a 50/50 Atticus/Kalshi revenue split, that's ~$234k/year per side — meaningful, sustainable, and structurally tied to Kalshi's BTC volume growth.**

---

## 10. Common objections (and our answers)

**"Doesn't this cannibalize our market makers?"**
No. Kalshi MMs make markets in the binary. Atticus sells a *different instrument* (a 30-day Deribit vertical) that no Kalshi MM can offer. We're additive flow, not competing flow.

**"What if Deribit goes down on a tail-event day?"**
The hedge is a real Deribit position taken at user entry. Settlement happens at Kalshi expiry against Deribit's settlement. Deribit downtime mid-life affects mark-to-market visibility but not the structural payout — the hedge is already on the books.

**"How do you handle the timing mismatch between Kalshi binary expiry and Deribit option expiry?"**
We match Deribit expiry to the closest available date ≥ Kalshi settle. Where there's a 1-3 day gap, the Deribit spread is sold back the day after Kalshi settle and the (small) residual P&L is the trader's. We document this in the user disclosure.

**"What if BTC implied vol spikes 2× before user enters?"**
Live Deribit pricing handles this — the fee quoted to the user reflects current IV. They see the higher number and decide. Atticus margin is preserved.

**"Why should Kalshi share revenue rather than just integrate this themselves?"**
We've built the Deribit operational stack already (live keys, capital management, settlement reconciliation). For Kalshi to replicate this from scratch would be a 6-12 month engineering project + Deribit relationship build. Revenue-share gets you the product immediately.

**"What about HIT/barrier markets?"**
Vanilla puts and calls don't replicate first-to-touch payoffs. We're upfront about this: Atticus protection covers ABOVE/BELOW directional binaries (which is most of your BTC volume), not HIT. Barrier-option support is a v2 conversation if there's interest.

**"Why two tiers, not one?"**
Empirically the two tiers cover different recovery distributions (Standard 20-35% modal, Shield 35-50% modal). The choice maps to user preference: cheaper softener vs heavier protection. UX should expose Shield as a one-toggle upgrade with dynamic $-saved framing on the user's actual stake.

---

## 11. Pilot proposal

We propose a **zero-integration shadow pilot** on your next 8-12 BTC monthly markets:

1. We monitor your settled BTC market data (public).
2. For each market, we publish a hypothetical "what if Atticus had been live": fee, hedge structure, settlement outcome.
3. After 4-6 weeks of shadow data, we have a real audit trail of how the product would have performed on *your* flow.
4. If the data supports it, we move to a soft launch: Atticus protection offered to a small slice of your BTC traders via a co-branded UX.

**Atticus side requires:** zero engineering work from Kalshi. We work off your public market data.

**Kalshi side observes:** a clean dataset of "had we offered this, here's what would have happened" before any commercial commitment.

---

## 12. The ask

A 30-minute call with whoever owns institutional product strategy at Kalshi. We'll walk through:

- The mechanism with live Deribit pricing
- The shadow-pilot plan
- The commercial structure options (revenue share, clearing fee, white-label)

We're already live with a related drawdown-protection product on Foxify (a separate pilot). The Kalshi product is technically distinct but operationally similar — Deribit-hedged, pass-through, no warehousing — so onboarding can be fast.

---

## Appendix A: Calibration honesty

Backtest pricing uses Black-Scholes theoretical with explicit bid-ask widener, validated against live Deribit chain quotes. Calibration drift (synthetic vs live, 30-DTE, BTC=$79k):

| Spread | Synth/live ratio |
|---|---|
| Standard put | 1.25× (synth over-prices) |
| Shield put | 1.26× |
| Standard call | 1.10× |
| Shield call | 1.03× |

**Real production fees will be 10-25% lower than the backtest reports.** We over-state our headline numbers, not under-state.

## Appendix B: Per-market trade log

The full trade-by-trade log across 60 settled BTC markets is in `output/kalshi_rebuild_trades.csv`. Best Shield saves (descending):

| Market | BTC move | Fee | Payout | Unprotected → Protected | Saved |
|---|---|---|---|---|---|
| KXBTCD-25NOV28-100000 | −17.4% | $16.78 | $37.44 | -$78 → -$57.34 | +$20.66 |
| KXBTCD-25OCT31-100000 | −7.7% | $11.74 | $31.20 | $35 → $54.46 | +$19.46 |
| KXBTCMINY-25NOV-95000-NO | −17.4% | $14.63 | $32.64 | -$68 → -$49.99 | +$18.01 |
| KXBTCMINY-26FEB-80000-NO | −14.4% | $14.20 | $31.20 | -$65 → -$48.00 | +$17.00 |
| KXBTCD-25FEB28-100000 | −16.2% | $12.72 | $27.84 | -$58 → -$42.88 | +$15.12 |

(Scaled to $40 stake: divide all dollar figures by 2.5.)

## Appendix C: What we explicitly don't claim

- We don't claim to recover *every* losing trade. The hedge pays when BTC moves against the trader's bet direction. On losing months where BTC moved the *right* way (rare but real — ~3 of 60 ABOVE/BELOW markets in the dataset) the spread expires worthless and the trader is out the fee.
- We don't claim a deterministic floor. Our prior product iterations explored a Kalshi-NO-leg "guaranteed rebate" mechanism but rejected it: that approach has Atticus take the other side of the user's binary, which is market-maker behavior and undermines the partnership story.
- We don't claim institutional-grade protection on small (<$30) retail bets. Fee-as-%-of-stake gets uncomfortable at small stakes. The product is designed for the median Kalshi BTC retail trader ($35-60 typical stake) and scales up to institutional from there.
- We don't claim Standard and Shield are equivalent products. They cover different recovery distributions and target different stake sizes. UX should reflect this.
