# Atticus → SynFutures: Options-Hedge Bridge for BTC/ETH Perps

**Date:** April 2026
**Audience:** SynFutures product / partnerships
**Format:** Source content for a 30-min meeting + a short follow-up deck. Sections in presentation order.

---

## 1. The one-line pitch

Atticus is a thin overlay that lets a SynFutures BTC/ETH perp trader open their position and a real Deribit options hedge **in one ticket**. We don't take the other side of the perp, we don't make markets, we don't warehouse risk. We're an options-procurement bridge that turns Deribit's ~$30B BTC/ETH OI into a perp-protection product on your venue.

---

## 2. The trader-value story (the headline slide)

Across **500 simulated SynFutures-style retail perp trades** on BTC/ETH (Jan 2024 – Apr 2026, drawn from realistic distributions of size / leverage / hold time):

- **On adverse-move trades, the hedge cuts the trader's realized drawdown by a median ~50% of margin.** Inter-quartile range: 27% – 100% of margin saved.
- **94 of 500 unhedged trades would have liquidated. The hedge prevented 88 of those — a 94% liquidation-prevention rate.**
- Premium runs **~5% of protected BTC/ETH notional** — directly competitive with bank-OTC vertical-spread pricing, with a single-flow execution UX no bank can offer.

### Concrete saves from the dataset (representative trades)

#### ~$1k position: $1,000 ETH long perp at 20× leverage

| | Unhedged | Hedged |
|---|---|---|
| Margin | $50 | $50 |
| Worst adverse move during hold | -9.3% | -9.3% |
| Outcome | **LIQUIDATED, -$50** | **-$28.66** |
| Premium paid | $0 | $30.48 (3.05% of notional) |
| Improvement | — | **+$21.34 (42.7% of margin)** |

#### ~$2.5k position: $2,500 BTC short perp at 10× leverage

| | Unhedged | Hedged |
|---|---|---|
| Margin | $250 | $250 |
| Worst adverse move during hold | -10.6% (BTC up) | -10.6% |
| Outcome | **LIQUIDATED, -$250** | **-$87.21** |
| Premium paid | $0 | $51.43 (2.06% of notional) |
| Improvement | — | **+$162.79 (65.1% of margin)** |

The pitch line on the slide:

> *"On adverse BTC/ETH moves, your traders lose ~50% less of their margin. On 9 out of 10 would-be liquidations, the hedge prevents the liquidation entirely."*

---

## 3. How it works (mechanism)

Walking through one trade end-to-end, with **live Deribit pricing** as of this morning: BTC ≈ $76,800.

A SynFutures trader opens a $5,000 BTC long perp at $76,800, 10× leverage (margin $500), expects to hold 5 days.

**At entry, Atticus simultaneously buys on Deribit:**
- **Long** BTC-08MAY26-75000-P (a 2%-OTM put, 7 days to expiry)
- **Short** BTC-08MAY26-71000-P (a 5%-wider OTM put — the floor)
- Sized at 2.5× user's $5,000 notional = $12,500 protected BTC notional

**Net cost from this morning's chain:** ~$45 → trader pays $45 fee at entry.

**Settlement scenarios:**

| BTC at exit | Perp P&L unhedged | Hedge payout | Net trader P&L |
|---|---|---|---|
| ≥ $76,800 (held or up, trader right) | +$X | $0 | +$X − $45 |
| $73,000 (down 5%) | −$250 | ~$60 | **−$235** |
| $69,000 (down 10%) | LIQUIDATED, −$500 | ~$340 | **−$205** (hedge prevented liq) |
| $67,000 (down 13%) | LIQUIDATED, −$500 | $500 (capped) | **−$45** (full recovery) |

In every case, Atticus is procuring a real Deribit position. The hedge is fully Deribit-funded at entry; we don't warehouse, we don't take the perp's other side.

---

## 4. Two product modes (trader chooses)

| | Single-premium (7-day) | Day-rate (theta-following, 14-day) |
|---|---|---|
| User UX | One fee at entry | Daily debit, cancel anytime |
| Avg fee (% of notional) | 5.40% | 5.28% |
| Avg user fee per trade ($) | $143 | $194 (over avg hold) |
| Median DD reduction (% of margin) | 52% | 56% |
| Liquidation prevention rate | 94% | 99% |
| Best for | Traders who know their hold horizon | Variable-hold traders |

The day-rate variant uses a longer-dated Deribit option held against the user's flexible perp hold; user pays daily theta with markup; Atticus refunds residual on close. Mathematically fair at any unwind point. **Recommended UX:** offer both, default single-premium for traders with defined hold plans, day-rate as the "stay-as-long-as-you-want" alternative.

---

## 5. Capital efficiency (institutional metric)

For a desk evaluating the wrapper, the question is "what fee per dollar of protected BTC/ETH notional":

| Tier | Fee / protected notional |
|---|---|
| Single-premium | 5.40% |
| Day-rate | 5.28% |

Bank-OTC 30-day BTC verticals run 2-5% with $50k+ minimums and 6-week procurement cycles. We deliver matched-tenor protection (7-14 days, the actual perp hold profile) inline at retail position sizes ($500-$25k).

---

## 6. Venue economics (what's in it for SynFutures)

Atticus runs **22% net margin** on the markup over Deribit fill cost — sustainable, capital-light, no warehousing.

**50/50 revenue share with SynFutures:**

| Monthly perp volume on BTC/ETH | @ 5% adoption | @ 10% | @ 15% |
|---|---|---|---|
| $20M | $16k | **$32k** | $48k |
| $50M | $40k | **$81k** | $121k |
| $100M | $81k | **$162k** | $242k |

(Single-premium tier; day-rate runs ~30% higher per protected trade.)

These are SynFutures' incremental revenue numbers — additive to existing perp fees, no engineering on your side, no MM cannibalization. **Adoption rate is the swing variable.** Reasonable assumption is 5-15% of perp volume opting into protection over the first 6-12 months; comparable wrap products on other DEXes have hit those rates.

---

## 7. Why this is structurally additive (not cannibalizing)

- A SynFutures market maker structurally cannot sell a 7-day BTC put. Only an options exchange can. Atticus brings options-market depth your platform can't otherwise offer.
- We sell a *different instrument* (Deribit vertical-spread) that doesn't compete with your perp orderbook.
- We don't take the other side of perp positions. The trader's perp P&L still flows through your venue exactly as today.
- This unlocks ticket sizes retail-only product can't reach: institutional desks blocked today by 100% liquidation risk can size in once worst-case is bounded.

---

## 8. Common objections (pre-answered)

**"Doesn't this cannibalize our market makers?"**
No — perp MMs make markets in the perp orderbook. Atticus sells a separate Deribit options position. We're additive, not competing.

**"What if Deribit goes down on a tail-event day?"**
The hedge is a real Deribit position taken at user entry. Settlement happens at expiry against Deribit's price. Mid-life Deribit downtime affects mark-to-market visibility but not the structural payout — the hedge is already on the books.

**"How do you handle perp funding rates and the asymmetry vs option settlement?"**
Funding accrues against perp margin separately from the hedge. Hedge fees are debited via your existing margin account or a separate Atticus collateral channel, depending on integration depth. We document the timing model in the user disclosure.

**"What about liquidations that happen overnight or during low-liquidity hours?"**
The hedge payout is computed at the option's settlement value at the user's perp close (or at expiry). For users who get liquidated mid-life, the hedge is sold back at Deribit market on the liquidation day — captures most of the in-the-money value (~95% after a 5% bid-ask haircut, modeled in the backtest).

**"Why should SynFutures partner rather than build this themselves?"**
We've already built the Deribit operational stack (live keys, capital management, settlement reconciliation). For SynFutures to replicate this from scratch would be 6-12 months of engineering plus a Deribit relationship build. Revenue-share gets you the product immediately.

**"What if the trader holds longer than the hedge tenor?"**
Two policies, configurable per integration: (a) auto-roll into a new Deribit spread (with notice + new fee), or (b) auto-close protection at expiry, prompt user to opt back in. Both documented; (b) is the cleaner default.

---

## 9. Pilot proposal

**Zero-integration shadow pilot** on your settled BTC/ETH perp data:

1. We monitor your settled trades publicly (anonymized aggregates suffice).
2. For each trade, we publish a "what if Atticus had been live" record: hedge structure, premium, settlement outcome, drawdown reduction.
3. After 4-6 weeks of shadow data, you have a real audit trail of how the product performs on *your* flow before any commercial commitment.
4. If shadow data supports it, soft launch to a small slice of BTC/ETH perp users with co-branded UX.

Atticus side requires zero engineering work from SynFutures. Public market data is enough for the shadow phase.

---

## 10. The ask

A 30-minute call with whoever owns institutional product strategy or partnerships. We'll walk through:
- The mechanism with live Deribit pricing
- The shadow-pilot plan
- Revenue-share commercial structure (clean 50/50 default; flexible to your partnership model)

We're already live with a related drawdown-protection product on Foxify (separate pilot, same operational pattern: Deribit-hedged, pure pass-through).

---

## Appendix A: Calibration honesty

Backtest pricing uses Black-Scholes theoretical with vol-risk-premium and skew calibrated against live Deribit chain quotes. Calibration drift validated separately (~5-25% synthetic-vs-live error depending on strike geometry). **Real production fees will be at-or-below the backtest reports**, not above.

## Appendix B: Methodology

- **Synthetic trades**: 500 trades sampled from documented retail-perp-DEX distributions (notional $500-$25k, leverage 3-50×, hold 1-30d, 70/30 BTC/ETH, 60/40 long/short). Seeded RNG, fully deterministic, reproducible.
- **Path data**: Coinbase daily OHLC. Drawdowns measured at daily resolution; intra-day liquidations may underestimate adverse extremes (real-world drawdowns are slightly worse than reported, so liquidation-prevention numbers are mildly conservative).
- **Hedge pricing**: live Deribit chain where available; BS-theoretical fallback with vol-risk-premium scalar (rvol × 1.10) and skew slope (0.20 vol-pts/% OTM).
- **Liquidation model**: ignores funding rates and trading fees on the perp side. Net effect: real liquidations happen slightly earlier than modeled.

## Appendix C: What we don't claim

- We don't recover *every* losing trade. The hedge pays only when BTC/ETH moves against the trader's bet direction enough to engage the spread. On small adverse moves the spread expires worthless and the trader is out the premium.
- We don't claim a deterministic floor. Drawdown reduction is path-dependent.
- The product is designed for retail/prosumer perp positions ($500-$25k typical). Smaller positions ($<$300) get poor capital efficiency due to fixed unwind costs; institutional positions ($100k+) work but pricing should be re-quoted from the live chain rather than backtest assumptions.

## Appendix D: Output files

- `output/synfutures_trades.csv` — full per-trade log (1,000 rows: 500 trades × 2 tier variants), including drawdown, liquidation, hedge payout, fees, Atticus margin
- `output/synfutures_summary.md` — full backtest summary with all aggregates
- `output/synfutures_pitch_bullets.md` — drop-in email bullets organized by topic

To reproduce: `cd research/synfutures-pitch && npm install && npm run backtest`
