# Atticus → Bullish
**Execution flow brief** · 13 Aug 2026 · for BD + market makers  
Contact: Michael William · michael@atticustrade.com · live tape: https://facility.atticustrade.com/onesheet

---

## What you would be executing

Atticus converts retail 24-hour BTC collars into two-sided institutional options flow.

A holder (or our principal book) accepts a 24h band. We hedge that band on an options venue: **buy the floor, sell the cap.** That is uninformed, mechanical, short-dated, two-sided flow. It is not a directional book and it does not self-match — neutrality spans two perp venues, so each book sees a real one-sided leg.

You are not being asked to distribute a retail product. You are being asked to **price and fill the hedge.**

---

## Live tape (source of truth — not a pitch deck)

Window through 13 Aug 2026. Real venue options pricing. Client settlement in this window is paper. Principal book has **1 live leg**; paper stand-ins are disclosed on the tape.

| | Full window | Product book (neutral pairs only, since 5 Aug) |
|---|---|---|
| Days | 24 | 8 |
| Settled | 69 names | 26 names |
| Notional | $3,450,000 | $1,300,000 |
| Avg hold | 24.13h | ~24h |
| Structure net | $2,544 (credit $2,976 − givebacks $432) | $1,033 |
| Client all-in | **9.33 bps** · 79% of days positive | — |
| Floor breached | **0.0%** | 0 |
| Cap touched | **2.9%** | 0 |
| Halts / manual | 0 / 0 | 0 / 0 |
| Integrity | 100% oracle-signed, 100% reconciled | same |

Quoted credit band is 10–16 bps/day at the smallest execution tier. Realized all-in on the 24-day tape is **9.33 bps**. Scale (netting, rebates, better tier) improves this; it does not rely on a hotter number.

Directional overlay was run, netted ~zero, and is **retired**. Book is neutral pairs only.

---

## Flow spec for market makers

| | |
|---|---|
| Underlying | BTC |
| Structure | 24h asymmetric collar (long floor / short cap) |
| Tenor | ~1 DTE, rolled daily |
| Side mix | Two-sided by construction (put buy + call sell) |
| Typical name | $25k–$100k notional per collar |
| Information | Uninformed / mechanical. Band chosen by the user or by a rules engine, not by a vol desk |
| Adverse selection | Low. We are not picking your stale quotes on news |
| Self-match | None on a single book. Pair is split across two perp venues |
| Unwind | Reduce-only IOC + RFQ/block fallback |
| What fails a fill | Missing 1-DTE strikes outside ~4–5% of spot; thin wings; RFQ timeout |

This is the flow you would take to MMs. They will care about **strike grid, size, two-sidedness, and whether we are mostly taker**. They will not care about a second UI.

---

## What we pay today on OKX (the number you asked for)

**Do not use “OKX is 3 bps.”** Options fees are notional-rated and **premium-capped**.

```
OKX options fee = min( fee_rate × notional , 7% × premium )
```

Public schedule (OKX global fee framework, options):

| Tier | 30d volume (USD) | Maker | Taker |
|---|---|---|---|
| Regular | < $3M | 0.0300% | 0.0300% |
| VIP 1 | ≥ $3M | 0.0280% | 0.0300% |
| VIP 2 | ≥ $5M | 0.0250% | 0.0300% |
| VIP 3 | ≥ $10M | 0.0200% | 0.0300% |
| VIP 4 | ≥ $25M | 0.0200% | 0.0250% |
| VIP 5 | ≥ $50M | 0.0150% | 0.0200% |
| VIP 6 | ≥ $100M | 0.0100% | 0.0200% |
| VIP 7 | ≥ $1.5B | −0.0050% | 0.0150% |
| VIP 8 | ≥ $2B | −0.0100% | 0.0150% |
| VIP 9 | ≥ $20B | −0.0100% | 0.0130% |

Maker rebate only starts VIP 7. Day options have no exercise fee. Combo/RFQ legs can be discounted.

**Worked example on the structure we actually trade**

$100,000 notional · 12 bps option premium = $120 premium

| | Math | Fee | Effective |
|---|---|---|---|
| OKX regular taker | min(3.0 bps × $100k, 7% × $120) = min($30, $8.40) | **$8.40** | **0.84 bps of notional** |
| OKX VIP 5 taker | min(2.0 bps × $100k, 7% × $120) = min($20, $8.40) | **$8.40** | cap still binds |
| Bullish CLOB published | taker 1 bp notional, cap 10% of premium → min($10, $12) | **$10** | **1.0 bp of notional** |

On cheap 24h premium the **OKX 7% cap usually binds**, so headline notional bps overstate what we pay. Bullish does not win this on the published taker rate. Bullish wins if **spread + RFQ/block + rebate program + MM willingness to quote this exact 1-DTE collar** beat OKX all-in.

Our live account VIP tier and last-10 fill tape (premium, fee paid, maker/taker, RFQ vs book) attach on request the same day. Send those two items with this sheet if you have them; do not wait on a second shadow to start the MM conversation.

---

## What “good” looks like vs OKX

All-in, per collar, in this order:

1. Spread paid (ask vs mid on the put we buy, bid vs mid on the call we sell)
2. Fee after premium cap and any rebate
3. Fill rate on 1-DTE strikes at the bands we actually use
4. Size before the book walks
5. RFQ/block vs CLOB for $50k–$250k names

A rebate that looks better on a rate card and a 1-DTE grid that dies outside 4% of spot is a worse venue for this book.

---

## What we are not doing next

We are **not** standing up a second live shadow on Bullish before terms.

What we will run, on request, in 5 business days: a **quote overlay** — replay the last ~25 tape collars against Bullish **mainnet** books (CLOB + RFQ if offered). One table: fillable Y/N, strike used, all-in vs OKX, size that would have walked. That is the MM artifact. Testnet/SimNext prices are not representative and will not be used.

---

## What we need from you to proceed

1. Written rebate / maker program terms for this flow (options CLOB and RFQ/block).
2. Intro to the MM you want to show this to.
3. 1-DTE BTC options: CLOB vs RFQ, USD vs USDC, strike grid and typical top-of-book depth around ±2% / ±5% / ±10%.
4. Onboarding: entity, min size, and how fast an account can trade live.

We can be in an MM meeting with this sheet as soon as you set it. Live routing follows terms, not the other way around.

Live tape (updates every cycle): https://facility.atticustrade.com/onesheet
