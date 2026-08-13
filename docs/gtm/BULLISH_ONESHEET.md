# Atticus → Bullish

**13 Aug 2026** · BD + market makers · Michael William · michael@atticustrade.com  
Tape: https://facility.atticustrade.com/onesheet

**OKX fee on this book: $523 on $3.45M = 1.52 bps.** Regular options tier, on-screen. Institutional KYB, no IM posted, no VIP. Live path: RFQ + portfolio margin. First live flow is uncommitted.

---

## Tape (24 days, through 13 Aug)

Real venue options prices. Client settlement is paper. **1 live principal leg**; paper stand-ins disclosed on the tape. Neutral pairs only since 5 Aug (directional overlay retired).

| | Full window | Product book (since 5 Aug) |
|---|---|---|
| Days | 24 | 8 |
| Settled | 69 names | 26 names |
| Notional | $3,450,000 | $1,300,000 |
| Avg hold | 24.13h | ~24h |
| Structure net | $2,544 (credit $2,976 − givebacks $432) | $1,033 |
| Client all-in | **9.33 bps** · 79% days + | — |
| Floor / cap | **0.0%** / **2.9%** | 0 / 0 |
| Halts / manual | 0 / 0 | 0 / 0 |
| Integrity | 100% signed, 100% reconciled | same |
| Option fees accrued | **$523 · 1.52 bps** | in full window |
| Net after fees + capital (zero ops fee) | **−$12.42 · −0.036 bps** | pass-through |

Quoted credit 10–16 bps/day at smallest tier. Realized **9.33 bps**. Scale improves this.

---

## Flow for MMs

Two-sided 24h BTC collar: **buy the floor, sell the cap.** Uninformed, mechanical, ~1 DTE, rolled daily. Not a directional book. No self-match — pair spans two perp venues.

| | |
|---|---|
| Typical name | $25k–$100k notional |
| Execution now | On-screen / CLOB (shadow) |
| Live | RFQ/block first, sanity-check vs screen, portfolio margin |
| Unwind | Reduce-only IOC + RFQ/block |
| Breaks a fill | No 1-DTE strike past ~4–5% of spot; thin wings; RFQ timeout |

You are pricing and filling the hedge, not distributing a retail product.

---

## OKX fees (the number you asked for)

Accrued at Regular on-screen on real books. Not cash — no IM posted, shadow does not bill. Benchmark for the worst published OKX options tier, before RFQ or VIP.

```
fee = min(rate × notional, 7% × premium)
```

Regular = 3.0 bps maker / 3.0 bps taker, 7% premium cap. Headline 3.0 bps; we realized **1.52 bps across both legs** (~0.76 bps/leg) because the cap binds on cheap 1-DTE premium. ~$7.58 per name. After fees and capital, structure is flat at zero ops fee — no pad. Combo/RFQ can cut OKX fees up to 50%; unused. First live orders are RFQ.

**$100k name, 12 bps premium = $120**

| | Math | Fee | Effective |
|---|---|---|---|
| OKX Regular (us) | min(3.0 bps × $100k, 7% × $120) | **$8.40** | **0.84 bps/leg** |
| OKX VIP 5 taker | same cap still binds | $8.40 | 0.84 bps/leg |
| Bullish CLOB published | min(1 bp notional, 10% of premium) | $10 | 1.0 bp/leg |

Published CLOB taker does not beat this once the cap binds. Bullish wins on **spread + RFQ/block + rebate + MM quotes on this 1-DTE collar + PM**, vs 1.52 bps all-in and current on-screen fills.

---

## Next

Not a second live shadow. On request, 5 business days: **quote overlay** of last ~25 tape collars vs Bullish mainnet (CLOB + RFQ). Table: fillable Y/N, strike, all-in vs OKX, size that walks. No SimNext.

**Need from you**

1. Rebate / maker terms — CLOB and RFQ/block
2. Intro to the MM you want to show this
3. 1-DTE BTC: CLOB vs RFQ, USD vs USDC, strike grid and top-of-book around ±2% / ±5% / ±10%
4. Onboarding: entity, min size, time-to-live, PM on a long-floor / short-cap 1-DTE pair

Live routing follows terms. We can sit with your MM on this sheet as soon as you set it.
