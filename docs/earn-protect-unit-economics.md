# Earn & Protect — Unit Economics

*Copy-paste-ready for the capital-partner email: paragraphs are single lines (no mid-sentence breaks), and numbers are laid out as plain lines rather than tables so they survive any email client. Every figure is labeled MEASURED (real fills or real simulations we ran) or ESTIMATE (theory we verify in week one before anything is promised to a trader).*

## What it is

A trader on Hyperliquid taps one toggle. We put a hard floor under their position using listed BTC options, and the options market pays them a credit for it — real premium, collected daily. If the market can't fund a credit, we refuse and say why. Upside is never capped: if price rips through the cap level, that day's protection cycle simply ends — the trader keeps the position, all gains, and the credit earned so far, and protection re-arms at the new price automatically. No trader ever owes anything, deposits anything, or shares keys.

We keep 20% of every credit we source (10% for the first 50 wallets). That spread is the business.

## How the money moves

1. Trader taps the toggle. We read their position from Hyperliquid's public API — read-only, no keys.

2. We price a protective collar off the live options order book and place both option legs on OKX from our sub-account: sell the cap wing, buy the floor wing. The difference is the credit.

3. The credit unlocks through the day. At the cycle's close it is paid in USDC to the wallet that owns the position — the system cannot pay anyone else.

The trader's money is never touched. Your capital never touches our servers — it sits in the OKX sub-account as options margin, and you get independent read-only OKX API access to verify it any time.

## What the $10k does

It is collateral, not spend. Margin is consumed while a wrap is open and returns when the cycle closes, so the same capital backs a much larger book that recycles daily:

- Capital: $10,000
- Usable as margin (40% always held back as a safety buffer): $6,000
- Margin per $1 of protected position: ~12% (MEASURED before launch with OKX's own margin simulator)
- Working book it supports: ~$50,000, recycling daily

Capital scales the book linearly: $400k supports ~$2M/day of protection; $2M supports ~$10M/day.

## What a position earns

Real fills to date at the smallest possible size and worst pricing tier (MEASURED): $0.04–$0.49 per day on a $650 position. Small on purpose — here is the same position ladder across execution tiers, per day:

- $650 position: $0.04–0.49 today (MEASURED) → ~$0.55 at block execution (MEASURED on our $50k simulation tape at 8.4 bps/day) → $0.65–1.95 theory ceiling (ESTIMATE, 10–30 bps)
- $2,000 position: $0.12–1.47 today → ~$1.70 at block execution → $2–6 theory ceiling
- $15,000 position: $0.90–11 today → ~$12.60 at block execution → $15–45 theory ceiling

What we earn (20% of gross credit, at the measured 8.4 bps tier):

- $50k/day protected (this raise, $10k capital): ~$42/day gross credit → ~$8/day to Atticus
- $2M/day protected (~$400k capital): ~$1,680/day gross → ~$336/day to Atticus (~$120k/yr)
- $10M/day protected (~$2M capital): ~$8,400/day gross → ~$1,680/day to Atticus (~$600k/yr)

$10k is deliberately a traction play, not a revenue story: it proves live demand with real money, measures the real economics, and prices the actual raise from a working book.

## What makes credits bigger

1. Position size — always linear. 23 lots pay ~23× one lot. Credits are based on position size; that never changes.

2. Execution tier — the big jump. At 1-lot size we cross retail spreads and the exchange's minimum price tick eats most of a tiny premium. At block size, market makers quote inside the screen via RFQ and the tick cost disappears: our simulation tape measured ~8.4 bps/day at $50k scale versus the cents that 1-lot fills realize. Same product, 2–5× better per-dollar credit, purely from how the hedge executes.

3. Volume density. More concurrent users means long and short wraps offset and same-strike wraps combine, so our net orders reach block size (~$50k per leg). Volume buys access to the better execution tier — the netting engine that does this is already built.

4. Volatility. Busy days pay multiples of quiet weekends. We measure it; we don't promise it.

Note: portfolio margin does not increase credits — it increases how much book the collateral supports. Credits come from 1–4.

## What protects the capital

- OKX API keys are trade-only with withdrawals disabled at the key level — even a total server compromise cannot move funds off the venue.
- You hold independent read-only access to the sub-account.
- Both option legs fill or the pair auto-unwinds; a fill worse than the quoted credit auto-unwinds (enforced in code, proven on real orders).
- 40% of capital is never allocated; utilization auto-pauses new wraps before the buffer is touched; a kill switch stops new exposure while payouts keep running.
- Book, per-wallet, and per-strike caps bound concentration. The payout wallet is separate, small, and per-day capped — its float is the maximum blast radius.
- Every wrap, fill, and payout is recorded and reconciled against OKX's own records; a public dashboard shows the live book.

## Where it stands

Built and tested end to end: pricing, atomic execution, the daily cycle including cap-touch handling and automatic re-arm, payouts, caps, and the trader apps (web + Telegram, branded for Hyperliquid). 529 automated tests; real-money canary fills already executed on OKX. Week one after funding: measure real margin per wrap (sets the true book size) and run live wraps across a full week of market hours (sets the true credit numbers). Nothing is promised to traders until both are measured — that discipline is the product.
