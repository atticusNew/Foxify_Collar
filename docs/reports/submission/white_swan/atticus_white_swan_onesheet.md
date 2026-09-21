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
| Record window | `[START DATE]` to `[END DATE]` (`[N]` days, fresh book) |
| Positions protected | `[N]` |
| Quotes refused | `[N]` (`[TOP REASON]`) |
| Stake protected | `$[X]` |
| Credit paid to users | `$[X]` |
| Floor saves (user finished above the unprotected outcome) | `[N]` |
| Our P&L vs. take booked | `$[X]` vs. `$[X]` |

The last line is the identity the whole product rests on. Our P&L equals the take booked at quote time, to the cent, on every settled position. If it did not, we would be carrying outcome risk. We are not.

## Why this is a prediction-market submission

- **Market-neutral by construction.** The layer earns a published take on each protected position and nothing on the result. Wins and losses on the outcome pass through to the user and the hedge.
- **Cross-venue.** Protection sold on one venue is hedged with contracts bought on public prediction venues, so the layer's edge is pricing and execution, not forecasting.
- **Auditable.** Every row in the record has a receipt, and the record is public while the book is open.
- **Built to embed.** The same layer runs as one button inside a partner's app: one JSON quote in, one receipt out. The partner keeps the flow, the ledger and the relationship; Atticus prices and hedges.

## How to verify

1. Open the track record: `[TRACK RECORD URL]`. The identity card at the top shows our P&L against take booked.
2. Download the positions CSV linked from the same page. One row per position, every leg in integer cents. Sum the credit column and compare to the figure above.
3. Open the embedded demo: `[DEMO URL]`. Tap Protect on any row. Positions are simulated at live prices; nothing is bought.

## What this is not

- Not a forecasting model, a signal, or a trading bot.
- Not custody. Atticus never holds user funds or positions.
- Not exchange-specific. Kalshi is the settlement venue in the record; the layer is venue-agnostic.

---

**Team** · `[FULL NAME]`, founder · `[EMAIL]` · `[CITY]`

**Same engine, other market** · A perpetual-futures version of this layer has run as a public shadow facility since `[PERP START]`; the 33-day report is attached for reference.
