# Earn & Protect — Unit Economics, Plainly

*Prepared for the capital-partner conversation. Every number below is labeled: MEASURED (real
fills or real simulations we ran) or ESTIMATE (theory we will verify in week one before anything
is promised to a trader).*

## What it is

A trader on Hyperliquid taps one toggle. We put a hard floor under their position using listed
BTC options, and the options market pays *them* a credit for it — real premium, collected daily.
If the market can't fund a credit, we refuse and say why. The trader's upside is never capped:
if price rips through the cap level, that day's protection cycle simply ends — they keep the
position, all gains, and the credit earned so far, and protection re-arms at the new price
automatically. No trader ever owes anything, deposits anything, or shares keys.

We keep 20% of every credit we source (10% for the first 50 wallets). That spread is the business.

## How the money moves

```
trader taps toggle → we read their position (read-only, public API)
                   → we price a collar off the LIVE options book
                   → we place both option legs on OKX from OUR sub-account
                     (sell the cap wing, buy the floor wing — the difference is the credit)
                   → credit unlocks through the day
                   → at the cycle's close, the trader's share is paid in USDC
                     to the wallet that owns the position — no other payee is possible
```

The trader's money is never touched. Your capital never touches our servers — it sits in the OKX
sub-account as options margin, and you get **read-only OKX API access** to verify it directly,
any time, without asking us.

## What the $10k does

It is **collateral, not spend**. Options margin gets consumed while a wrap is open and comes back
when the cycle closes — the same $10k backs a much larger book that recycles every day:

| | |
|---|---|
| Capital | $10,000 |
| Usable as margin (we always hold 40% back as a safety buffer) | $6,000 |
| Margin consumed per $1 of protected position (MEASURED before launch via OKX's own margin simulator) | ~12% |
| **Working book it supports** | **~$50,000, recycling daily** |

Raising capital raises the book linearly: $400k supports ~$2M/day of protection; $2M supports
~$10M/day.

## What a position earns (and what we earn)

Real fills to date, smallest possible size, worst pricing tier — MEASURED:
**$0.04–$0.49 per day on a $650 position.** Small on purpose. Here is what changes it:

| Position | Today (retail order-book fills, MEASURED range) | At institutional block execution (8.4 bps/day, MEASURED on our $50k simulation tape) | Theory ceiling (10–30 bps, ESTIMATE) |
|---|---|---|---|
| $650 | $0.04–0.49/day | ~$0.55/day | $0.65–1.95/day |
| $2,000 | $0.12–1.47/day | ~$1.70/day | $2–6/day |
| $15,000 | $0.90–11/day | ~$12.60/day | $15–45/day |

**Atticus revenue at scale** (20% of gross credit, at the measured 8.4 bps tier):

| Daily protected volume | Gross credit sourced/day | Atticus/day | Atticus/year | Capital needed |
|---|---|---|---|---|
| $50k (this raise) | ~$42 | ~$8 | ~$3k | $10k |
| $2M | ~$1,680 | ~$336 | ~$120k | ~$400k |
| $10M | ~$8,400 | ~$1,680 | ~$600k | ~$2M |

$10k is deliberately a traction play, not a revenue story: it proves live demand with real money,
measures the real economics, and prices the actual raise from a working book.

## What makes credits bigger — the honest mechanics

1. **Position size** — always linear. 23 lots pay ~23× one lot. Credits are and will stay based
   on position size; that is the correct way to run it.
2. **Execution tier — the big jump.** At 1-lot size we cross retail spreads and the exchange's
   minimum price tick eats most of a tiny premium. At block size, market makers quote inside the
   screen via RFQ and the tick cost disappears — our simulation tape measured ~8.4 bps/day at
   $50k scale vs the cents the 1-lot fills realize. Same product, 2–5× better per-dollar credit,
   purely from how the hedge executes.
3. **Volume density.** More concurrent users means long and short wraps offset and same-strike
   wraps combine — our net orders get big enough to qualify for block execution (~$50k/leg).
   Volume doesn't change the market's price of risk; it buys access to the better tier. The
   netting engine that does this is already built.
4. **Volatility.** Busy days pay multiples of quiet weekends. We measure it; we don't promise it.

Note: portfolio margin does **not** increase credits — it increases how much book the collateral
supports. Credits come from 1–4.

## What protects the capital

- OKX API keys are **trade-only with withdrawals disabled at the key level** — a total server
  compromise cannot move funds off the venue.
- You hold **independent read-only access** to the sub-account.
- Both option legs fill or the pair is automatically unwound; a fill worse than the quoted credit
  is automatically unwound (enforced in code, proven on real orders).
- 40% of capital is never allocated; utilization auto-pauses new wraps before the buffer is
  touched; a kill switch stops new exposure while payouts keep running.
- Book, per-wallet, and per-strike caps bound concentration. The payout wallet is separate,
  small, and per-day capped — its float is the maximum blast radius.
- Every wrap, fill, and payout is recorded and reconciled against OKX's own records; a public
  dashboard shows the live book.

## Where it stands

Built and tested end-to-end: pricing, atomic execution, the daily cycle (including cap-touch
handling and automatic re-arm), payouts, caps, and the trader apps (web + Telegram, branded for
Hyperliquid). 529 automated tests; real-money canary fills already executed on OKX. Week one
after funding: measure real margin per wrap (sets the true book size) and run live wraps across a
full week of market hours (sets the true credit numbers). Nothing is promised to traders until
both are measured — that discipline is the product.
