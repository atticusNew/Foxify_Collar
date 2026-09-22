# Atticus: a hedge layer for prediction markets

**White Swan Predicts submission · one sheet**

Atticus is not a picks strategy. It is protection that a prediction-market user can add to a position they already hold: a floor on what the position can be worth at settlement, a cap on the upside, and a cash credit paid to the user today for the cap. Atticus prices the protection, hedges it on public prediction venues, and carries no view on the outcome.

## What a user sees

One button on a position row. Tap it and the row shows two things:

- `ends $0 or $150` becomes `ends $79.66 or $91.66 · +$3.81 paid`
- The credit shown is the credit received. Nothing is deducted afterwards.

Settlement uses the venue's official result, the same result that settles the underlying position. When the market cannot fund a credit, Atticus refuses the quote instead of offering a bad one. Refusals are recorded alongside fills.

## What the record shows

Every quote, fill, refusal and settlement is written to an append-only ledger with a receipt. The public track record renders that ledger live and is the source for every number below.

| | Value |
|---|---|
| Record window | 2026-09-12 to 2026-09-22 UTC (10 days, first position opened to last settlement) |
| Positions protected | 403 (28 NFL, 107 MLB, 268 crypto strikes); 330 settled, 73 open |
| Stake protected | $33,321.00 |
| Credit paid to users | $899.33 ($593.86 of it on the 330 settled positions) |
| Floor saves (user finished above the unprotected outcome) | 136 of 330 settled (41%) |
| Realized cost of the floor, settled | $2,281.64, 7.8% of the unprotected payout, against 3.9% quoted at the market's odds |
| Our P&L vs. take booked | $69.39 vs. $69.39 (gap $0.00) |

The last line is the identity the whole product rests on. Our P&L equals the take booked at quote time, to the cent, on every settled position. If it did not, we would be carrying outcome risk. We are not.

Realized cost runs above quoted in this window because strikes on the same coin settle together: a rally caps many positions at once and a drop pays many floors at once. Quoted is the expectation at the market's odds; realized is what this sample did, and the gap closes as the book widens across leagues. NFL is one game day a week, so the NFL sample is one Sunday deep: 4 settled, 24 protected and waiting in the open book for Thursday, Sunday and Monday. The mechanism is the same on a Packers game as on a Bitcoin strike, and the larger MLB and crypto samples are where the percentages have settled. On 2026-09-20 the terms rule was tightened (a minimum credit below which we refuse rather than offer pennies); positions since then also record the alternative terms.

## Why this is a prediction-market submission

- **Market-neutral by construction.** The layer earns a published take on each protected position and nothing on the result. Wins and losses on the outcome pass through to the user and the hedge.
- **Cross-venue.** Protection sold on one venue is hedged with contracts bought on public prediction venues, so the layer's edge is pricing and execution, not forecasting.
- **Auditable.** Every row in the record has a receipt, and the record is public while the book is open.
- **Built to embed.** The same layer runs as one button inside a partner's app: one JSON quote in, one receipt out. The partner keeps the flow, the ledger and the relationship; Atticus prices and hedges.

## How to verify

1. Open the track record: https://atticus-event-shadow.onrender.com/. The identity card at the top shows our P&L against take booked.
2. Download the positions CSV: https://atticus-event-shadow.onrender.com/api/shadow/positions.csv. One row per position, every leg in integer cents. Sum `credit_c` and compare to the figure above; on settled rows, sum `writer_pnl_c` and `take_c` and they match.
3. Open the embedded demo: https://atticus-event-demo-cross-venue.onrender.com/. Tap Protect on any row. Positions are simulated at live prices; nothing is bought.

## What this is not

- Not a forecasting model, a signal, or a trading bot.
- Not custody. Atticus never holds user funds or positions.
- Not exchange-specific. Kalshi is the settlement venue in the record; the layer is venue-agnostic.

---

**Team** · Michael William, founder · michael@atticustrade.com

**Same engine, other market** · A perpetual-futures version of this layer has run as a public shadow facility since July 19, 2026; the 33-day report is attached for reference.
