# BTC curve report

A standalone, read-only page: Bitcoin strike ladders on the two CFTC-regulated event venues
(Kalshi, Polymarket US) side by side against the distribution the listed option market implies
(Deribit), with the settlement index (CF Benchmarks BRTI) as the hedge reference. It is the
"first pass" deliverable for a counterparty who wants to see the curve, the gaps, the cost of
latency and a static-versus-dynamic hedge comparison before any code or endpoint changes hands.

Service: `services/api/scripts/btcCurveReportService.ts` · modules: `services/api/src/btcCurve/**`
· tests: `services/api/tests/btcCurve.test.ts` · Render: `atticus-btc-curve` in
`render-event-demos.yaml` (region singapore, 3 GB disk).

## What the page shows

1. **The curve.** Year-end 2026 is the one tenor both venues list as the same contract today:
   28 buckets of $5,000 ("Bitcoin price at the end of 2026"), the same BRTI fixing, the same
   instant (Jan 1 2027 05:00 UTC). Each bucket: Kalshi bid/ask (sub-penny), Polymarket US
   bid/ask (whole cents), the option-implied probability, Kalshi − Poly, each venue − model, and
   any executable cross net of both venues' taker fees. The one-touch ladders ("how high / how
   low this year") follow with a model caveat. Polymarket-US-only ladders are listed after.
2. **The hourly ladder** (Kalshi KXBTCD) against the smile from the nearest Deribit expiry.
   Polymarket US's 15-minute, hourly, daily and weekly BTC families are documented but listed
   only in its preprod environment as of Nov 2026; the reader discovers them by series the
   cycle they reach production.
3. **Gaps over time.** Per bucket, Kalshi mid − Poly mid across the history window (sparkline,
   mean |gap|, max, last). Persistent gaps are quoting differences; flicker is latency.
4. **What being late costs.** |Δ BRTI| over 1/5/15/60 s from one-second prints over the last
   hour (median, p90, worst), priced on a $1 at-the-money digital of the hourly and the year-end
   tenor via the option-implied digital delta.
5. **Static vs dynamic hedge.** For every hourly ladder seen, one $1 ATM digital is sold at the
   venue mid and carried to settlement two ways from the same snapshots: a listed call spread
   bought at the offer and sold back at the bid at the close, and an option-implied delta in spot
   rebalanced each snapshot at 2 bps. Settlement is the BRTI 60-second average the venues use.
6. **Lock in along the ladder.** Holder-side terms (floor, cap, credit, upside given up) per
   strike of the current hourly ladder, priced leg-for-leg off OKX option books with the same
   pricer as the public BTC demo. Writer economics (take, legs cost) are omitted unless
   `BTC_CURVE_SHOW_TAKE=1`.

## Data

| Source | Endpoint | Used for |
| --- | --- | --- |
| Kalshi public API | `/markets?series_ticker=` (KXBTCY, KXBTCMAXY, KXBTCMINY, KXBTCD), `/markets/{t}/orderbook`, `/series/{t}` | ladders, depth, fee multiplier |
| Polymarket US Retail API (no key) | `/v1/series`, `/v1/events?seriesId=`, `/v1/markets/{slug}/book`, `/v1/asset-prices/history` | ladders (typed `assetPriceTerms`), depth, `feeCoefficient`, BRTI 1-second candles |
| Deribit public | `/public/get_book_summary_by_currency?currency=BTC&kind=option`, `/public/get_index_price` | smile per expiry, spot fallback |
| OKX public | instruments, `/market/books` | hedge legs for §6 |

Fee formula on both venues: `Θ · C · p · (1 − p)` with the market's own coefficient (Kalshi
KXBTCY has `fee_multiplier 0`; KXBTCD is quadratic Θ = 0.07; Polymarket US publishes
`feeCoefficient` per market, 0.095 on the year-end ladders today).

Bucket keys normalise thresholds to the inclusive side so "strictly above 149,999.99" (Kalshi)
and "at or above 150,000" (Polymarket US) are the same key, `above:150000`.

## Model

Smile per expiry from the out-of-the-money side's mark IV, linear in log-moneyness, flat wings;
Black-76 on the expiry's forward, zero rate. `P(S_T > K) = −∂C/∂K` numerically so the skew is
in the digital; a range is the difference of two. Touch probabilities use the reflection
principle with the smile's IV at the barrier. The year-end option expiry (Dec 25 08:00 UTC) is
six days before the venue settlement; the smile's IV is kept and the bucket's own time to
settlement is used.

## Storage and ops

One JSONL file per UTC day in `BTC_CURVE_DATA_DIR` (options and quotes as tuples, ~55 KB per
snapshot at the 60-second cadence), `replay-state.json` for in-flight hedge replays,
`replays.jsonl` for settled ones, `collecting-since.txt`. Files older than `BTC_CURVE_RETAIN_DAYS`
are deleted hourly. The in-memory history window is 72 hours of compact mids.

Endpoints: `/` (page, auto-refresh), `/api/report` (the page's data), `/api/latest` (full
snapshot), `/api/replays`, `/healthz`. With `BTC_CURVE_TOKEN` set, everything but `/healthz`
needs `?k=<token>`.

Local run:

```
cd services/api
BTC_CURVE_PORT=8860 BTC_CURVE_DATA_DIR=/tmp/btc-curve npx tsx scripts/btcCurveReportService.ts
```

## What it does not do

It does not trade, hold keys, or see an account. It does not read Polymarket US's authenticated
or institutional APIs. It does not use CME futures as the hedge reference (spot BRTI stands in
for the first pass; the production version would reference the CME BTC future).
