# Atticus → Kalshi: Options-Hedge Bridge

**Date:** April 27, 2026
**Audience:** Kalshi product / partnerships
**Format:** This document is the source content for a 30-minute meeting + a short follow-up deck. Sections are ordered roughly as they should be presented.

---

## 1. The one-line pitch

Atticus is a thin overlay that lets a Kalshi trader buy a BTC bet and a real Deribit BTC put/call vertical-spread hedge **in one ticket**. We don't take the other side of your binary, we don't make a market, we don't warehouse risk. We're a procurement bridge to options-market depth that Kalshi traders can't otherwise access on your platform.

---

## 2. The trader cash story (the slide that matters most)

For a typical **$40 retail Kalshi BTC stake**, across all 60 settled monthly ABOVE/BELOW BTC markets we backtested (Jan 2024 – Apr 2026):

| | **No protection** | **Standard tier** | **Shield tier** |
|---|---|---|---|
| Fee at entry | $0 | **$5.64** (14% of stake) | **$7.57** (19% of stake) |
| Worst losing month, before/after | -$31 → -$31 | **-$31 → -$25** | **-$31 → -$24** |
| Median recovery on BTC-adverse losing months | $0 | **$13.00** (33% of stake) | **$16.80** (42% of stake) |
| Best save in dataset (Nov 2025, BTC −17.4%) | -$31 | -$31 → -$24 (saved $7.20) | **-$31 → -$24 (saved $7.20)** |

**The story for a trader:** "Pay $5–8 extra on a $40 BTC bet. When BTC actually moves against you (the bet *is* losing because of price action, not just luck), get back about a third to forty percent of your stake."

(Numbers above use the median, not the average. Average is reported alongside in the appendix; we lead with median because a few big-move months would otherwise inflate the typical-trader expectation.)

---

## 3. Why the trader hasn't seen this before

A Kalshi market maker structurally cannot sell a 30-day BTC put. Only an options exchange can. The closest current alternative for a Kalshi BTC trader who wants downside protection is to:

1. Open a separate Deribit (or CME) account
2. Pass KYC, fund it
3. Manually compute strikes that match their Kalshi exposure
4. Execute on a different platform with different settlement

99% of Kalshi retail won't do that. **Atticus does it for them in one click**, hedged at live Deribit prices, settled inside the Kalshi-flow UX.

---

## 4. Why Kalshi cares (institutional unlock)

Today: institutional desks (corporate treasuries, RIAs, prop trading shops with ESG/risk-policy constraints) can't size meaningfully into Kalshi BTC contracts because the binary 100% loss is unbounded vs their risk policy.

With Atticus Shield: max realized loss on a losing BTC-adverse month drops from −100% of stake to roughly −60% of stake (in our worst observed month: −$31 → −$24 on a $40 stake, 23% saved). That moves the wrapped instrument from "binary" to "structured overlay" in a typical risk-policy taxonomy.

**This unlocks ticket sizes that retail-only product can't reach.** Even a 5% capture rate on professional flow above Kalshi's current BTC volume is a multi-million dollar TAM expansion.

---

## 5. How it works (mechanism, in concrete numbers)

Walking through one trade end-to-end. Live Deribit pricing as of this morning: BTC = $79,200.

A trader buys "BTC > $80k by May 30" YES on Kalshi for $40 (yesPrice ~58¢ on a $69 face value).

At entry, Atticus simultaneously buys on Deribit:
- **Long** BTC-29MAY26-78000-P (a 2%-OTM put, 30 days to expiry)
- **Short** BTC-29MAY26-74000-P (a 5%-wider OTM put — the floor)

Sized at 6.5× the trader's $40 at-risk = $260 protected BTC notional.

**Live cost from this morning's chain**: net spread cost ≈ $5.64 → user pays $5.64 fee.

**Settlement scenarios:**
- BTC ends ≥ $80k: Trader wins on Kalshi (+$29). Deribit spread expires worthless. Atticus keeps fee minus 20% TP-salvage on un-triggered spread.
- BTC ends at $73k (down ~7.7%): Trader loses on Kalshi (−$40). Deribit spread pays $13 (~33% of stake). Atticus passes Deribit fill through. **Trader's net loss: −$32 on the $40 bet, instead of −$40.**
- BTC ends at $66k (down ~16.5%, close to worst observed historical month): Spread maxes out at $13.00 cap. **Trader's net loss: −$32 on the $40 bet, instead of −$40.** Worst-case recovery is bounded by the spread width.

In every case, Atticus is procuring a real options trade. The hedge is fully Deribit-funded at entry; we don't warehouse, we don't take the binary's other side.

---

## 6. Capital efficiency (the institutional metric)

For a desk evaluating the wrapper, the question isn't "what fee do I pay" — it's "how much protected BTC notional do I get per dollar of premium":

| Tier | Fee / protected BTC notional |
|---|---|
| Standard | 2.17% |
| Shield | 2.70% |
| Shield-Max | 3.61% |

For comparison, bank-OTC 30-DTE BTC verticals run 2-5% of notional. Atticus Standard sits at the bottom of that range — competitive with bank pricing — with a single-flow UX that no bank can offer.

---

## 7. Tier ladder

We propose a clean two-tier retail surface plus an institutional Shield-Max:

| Tier | Geometry | Avg fee | Median recovery on BTC-adverse losers | Use case |
|---|---|---|---|---|
| **Standard** | 2%-OTM put/call, 5% width, 6.5× sized | 14% of stake | 32.5% of stake | Default retail |
| **Shield** | 1%-OTM, 6% width, 7× sized | 19% | 42% | Strong protection / bigger-stake retail |
| Shield-Max | ATM, 8% width, 12× sized | 43% | 96% | Hidden behind "Advanced/Desk Size" toggle. Institutional / treasury accounts only. |

Retail UX should default to **Standard** with **Shield** as a one-toggle upgrade. Shield-Max should not be in the default trader UI.

---

## 8. Platform economics (what's in it for both of us)

Atticus runs **13% net margin** on the markup over real Deribit fill cost. Pure pass-through; no warehousing.

**Per-market revenue** (per $750k Kalshi BTC market notional, 16 markets/yr):

| Tier | @ 5% Kalshi opt-in | @ 10% | @ 15% |
|---|---|---|---|
| Standard | $1,024 | $2,048 | $3,073 |
| Shield | $1,277 | $2,554 | $3,831 |
| Shield-Max | $2,926 | $5,852 | $8,778 |

**Annualised:** Shield at 10% Kalshi BTC opt-in = $40,861/year today.

The big number isn't today's volume. It's the institutional unlock: at 10× Kalshi BTC TAM growth (driven *by* the wrapper's existence in the desk-flow distribution channel), the same structure delivers ~$408,610/year. **At a 50/50 Atticus/Kalshi revenue split, that's ~$205k/year per side — meaningful, sustainable, and structurally tied to Kalshi's BTC volume growth.**

---

## 9. Common objections (and our answers)

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

---

## 10. Pilot proposal

We propose a **zero-integration shadow pilot** on your next 8-12 BTC monthly markets:

1. We monitor your settled BTC market data (public).
2. For each market, we publish a hypothetical "what if Atticus had been live": fee, hedge structure, settlement outcome.
3. After 4-6 weeks of shadow data, we have a real audit trail of how the product would have performed on *your* flow.
4. If the data supports it, we move to a soft launch: Atticus protection offered to a small slice of your BTC traders via a co-branded UX.

**Atticus side requires:** zero engineering work from Kalshi. We work off your public market data.

**Kalshi side observes:** a clean dataset of "had we offered this, here's what would have happened" before any commercial commitment.

---

## 11. The ask

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

The full trade-by-trade log across 60 settled BTC markets (8 mismatched outcomes flagged, economics use derived outcomes) is in `output/kalshi_rebuild_trades.csv`. Best saves on Shield tier (descending):

| Market | BTC move | Fee | Payout | Unprotected → Protected | Saved |
|---|---|---|---|---|---|
| KXBTCD-25NOV28-100000 | −17.4% | $14.68 | $32.76 | -$78 → -$59.92 | +$18.08 |
| KXBTCD-25OCT31-100000 | −7.7% | $10.27 | $27.30 | $35 → $52.03 | +$17.03 |
| KXBTCMINY-25NOV-95000-NO | −17.4% | $12.80 | $28.56 | -$68 → -$52.24 | +$15.76 |
| KXBTCMINY-26FEB-80000-NO | −14.4% | $12.42 | $27.30 | -$65 → -$50.12 | +$14.88 |
| KXBTCD-25FEB28-100000 | −16.2% | $11.13 | $24.36 | -$58 → -$44.77 | +$13.23 |

(Scaled to $40 stake: divide all dollar figures above by 2.5.)

## Appendix C: What we explicitly don't claim

- We don't claim to recover *every* losing trade. The hedge pays when BTC moves against the trader's bet direction. On losing months where BTC moved the *right* way (rare but real — see HIT events) the spread expires worthless and the trader is out the fee.
- We don't claim a deterministic floor. Our prior product iterations explored a Kalshi-NO-leg "guaranteed rebate" mechanism but rejected it: that approach has Atticus take the other side of the user's binary, which is market-maker behavior and undermines the partnership story.
- We don't claim institutional-grade protection on small (<$30) retail bets. Fee-as-%-of-stake gets uncomfortable at small stakes. The product is designed for the median Kalshi BTC retail trader ($35-60 typical stake) and scales up to institutional from there.
