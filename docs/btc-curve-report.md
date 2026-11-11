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
   28 buckets of $5,000 ("Bitcoin price at the end of 2026"), the same index (BRTI), the same
   instant (Jan 1 2027 05:00 UTC). The settlement statistic differs: Kalshi takes the simple
   average of the last 60 one-second prints, Polymarket US the 20% trimmed mean of the same 60
   (the venues' one-touch ladders both use the trimmed mean). Each bucket: Kalshi bid/ask
   (sub-penny), Polymarket US bid/ask (whole cents), the option-implied probability, Kalshi −
   Poly, each venue − model, and any executable cross net of both venues' taker fees with the
   dollars available at the resting depth. Two notes total it: the executable crosses summed at
   resting depth (the venue-to-venue arb, capped by the thinner book), and each venue's
   resting bids above option-implied value, summed at the venue's own bid depth after taker fee
   and a half-cent wing allowance (the options market as referee, not a hedge venue). The one-touch ladders ("how high / how low this
   year") follow with a model caveat. Polymarket-US-only ladders are listed after.
2. **The hourly ladder** (Kalshi KXBTCD, 120 strikes $100 apart) against the smile from the
   nearest Deribit expiry, with the vol each side is pricing the hour at: a lognormal
   (forward, σ) fit to the ladder's two-sided mids, the Deribit at-the-money mark IV, and the
   index's realised vol over the last hour from one-minute returns. On the first live evening
   the ladder fit at ~72% against ~45% listed and ~62% realised: the venue's makers charge a
   vol premium on the hour, which is what the "Kalshi − model" column shows and what a hedged
   writer collects in §5. "The hourly ladder" is the KXBTCD event closing within 90 minutes;
   the series also lists tomorrow's 5 PM ET contract a day ahead and that one is never used as
   the hourly. Polymarket US lists the same intraday families in production (series
   `btc-strike-hourly`, strikes $100 apart, no 5 PM ET hour; `btc-strike-daily`, 5 PM ET, $250
   apart, none on Fridays; `btc-strike-weekly`, Friday 5 PM ET; and `btc-range-*` twins), all
   settling on BRTI, so the hourly and daily tables carry a Polymarket US column whenever its
   ladder shares the Kalshi close. Until Nov 9 2026 the reader read only the first 200 series
   and missed these (they sit on the second page) and did not parse the production
   `ASSET_PRICE_MARKET_TYPE_ABOVE_BELOW` label; both fixed. Polymarket-US-only ladders (the
   range twins, the weekly) show their two-sided strikes under §1.
3. **Gaps over time.** Per bucket, Kalshi mid − Poly mid across the history window (sparkline,
   mean |gap|, max, last). Persistent gaps are quoting differences; flicker is latency.
4. **What being late costs.** |Δ BRTI| over 1/5/15/60 s from one-second prints over the last
   hour (median, p90, worst), priced on a $1 at-the-money digital of the hourly and the year-end
   tenor via the option-implied digital delta.
5. **Static vs dynamic hedge.** For every hourly ladder seen with 20 minutes to 2 hours left,
   one $1 ATM digital is sold at the venue mid and carried to settlement two ways from the same
   snapshots: a listed call spread bought at the offer and sold back at the bid on the first
   snapshot after the close, and an option-implied delta in spot rebalanced each snapshot at
   2 bps with no cap near the close. Settlement is the simple BRTI 60-second average Kalshi uses.
   In-flight events with a longer horizon (from before the 90-minute rule) are dropped on load.
1b. **Bucket boundaries in vol.** Under §1: each venue's range mids summed above each $5,000 line,
   normalised by the venue's own sum of mids, inverted to vol on the venue's own 50% point (so level
   and shape are kept apart), with a band from the same sum over bids and asks, Deribit's vol at the
   line, listed-vs-band, skew per source, raw tail mass per source (no normalisation), and flags
   for tails fatter than any lognormal and for lines where 0¢-bid buckets dominate a venue's raw
   sum. A 0¢-bid bucket is read as zero mass.
5b. **Strike by strike, in vol.** Under §2: each venue's bid and ask on the hourly and the 5 PM ET
   daily ladder inverted to the vol that reproduces it as a digital on the ladder's own 50¢ centre,
   beside Deribit's vol at that strike; listed-vs-band, skew (below minus above centre) for both,
   and each mid's residual against a one-vol fit. One table per venue quoting the ladder (Kalshi
   today; Polymarket US when its short-dated ladders leave preprod). Strikes within a quarter of a
   standard deviation of the centre are blank (no vega).
6. **Lock in on the daily ladder.** Holder-side terms (floor, cap, credit, upside given up) per
   strike of Kalshi's 5 PM ET daily contract (KXBTCD, 80 strikes $250 apart; the hourly is used
   only when no daily is listed), priced leg-for-leg off OKX option books with the same pricer as
   the public BTC demo. Writer economics (take, legs cost) are omitted unless
   `BTC_CURVE_SHOW_TAKE=1`.

## Data

| Source | Endpoint | Used for |
| --- | --- | --- |
| Kalshi public API | `/markets?series_ticker=` (KXBTCY, KXBTCMAXY, KXBTCMINY, KXBTCD), `/markets/{t}/orderbook`, `/series/{t}` | ladders, depth, fee multiplier |
| Polymarket US Retail API (no key) | `/v1/series`, `/v1/events?seriesId=`, `/v1/markets/{slug}/book`, `/v1/asset-prices/history` | ladders (typed `assetPriceTerms`), depth, `feeCoefficient`, BRTI 1-second candles |
| Deribit public | `/public/get_book_summary_by_currency?currency=BTC&kind=option`, `/public/get_index_price` | smile per expiry, spot fallback |
| OKX public | instruments, `/market/books` | hedge legs for §6 |

Fee formula on both venues: `Θ · C · p · (1 − p)` with the market's own coefficient (Kalshi
`round up(M × 0.07 × C × P × (1−P))`, KXBTCY has `fee_multiplier 0`, KXBTCD and the touch
series 1; Polymarket US publishes `feeCoefficient` per market, 0.095 on the year-end ladders
today, which is its Tier 1 taker rate; Tier 4 is 0.0695 and rounding is to the nearest cent).
The page shows per-contract fees unrounded and says so.

Bucket keys normalise thresholds to the inclusive side so "strictly above 149,999.99" (Kalshi)
and "at or above 150,000" (Polymarket US) are the same key, `above:150000`.

## Model

Smile per expiry from the out-of-the-money side's mark IV, linear in log-moneyness, flat wings;
Black-76, zero rate. The forward is the expiry's own (Deribit `underlying_price`, which carries the
term basis; shown as a strip above §1) for buckets settling more than a day out, and the BRTI
reading itself for buckets settling within a day: the carry is under a basis point there, the
contract settles on BRTI, and the option forward is read seconds apart from the index and wanders
±5 bps around it cycle to cycle, which near an hourly close is several points of probability at
the money. The replay's delta uses the same spot it marks P&L in. `P(S_T > K) = −∂C/∂K` numerically so the skew is
in the digital; a range is the difference of two. The difference step is capped at a fifth of
one standard deviation of the terminal move, so minutes before an hourly close (when the digital
is nearly a step) the quotient does not smear it; without the cap a $101-in-the-money digital
with four minutes left read 71% instead of 76%. Touch probabilities use the reflection
principle with the smile's IV at the barrier. The year-end option expiry (Dec 25 08:00 UTC) is
six days before the venue settlement; the smile's IV is kept and the bucket's own time to
settlement is used.

## Storage and ops

One JSONL file per UTC day in `BTC_CURVE_DATA_DIR` (`snapshots-YYYY-MM-DD.jsonl`, options and
quotes as tuples), `replay-state.json` for in-flight hedge replays, `replays.jsonl` for settled
ones, `collecting-since.txt`. The in-memory history window is 72 hours of compact mids.

**Every day is kept.** Nothing is deleted unless `BTC_CURVE_RETAIN_DAYS` is set to a whole number
of days; then day files older than that go, hourly. Unset, empty, `0`, `all` and `none` keep
everything. A value that cannot be read (`abc`, `-3`, `2.5`) also keeps everything, and `/healthz`
and the start-up log line say so. The pairs files under `pairs/` follow the same setting unless
`BTC_PAIRS_RETAIN_DAYS` is set.

**Closed days are gzipped.** One hour after a UTC day ends its file is compressed to
`snapshots-YYYY-MM-DD.jsonl.gz`, one file per hourly pass, off the collecting cycle. The copy is
written to a temp name, read back and compared with the original (bytes, line count, sha256)
before it is renamed and the original removed. A pass that fails leaves the original and tries
again an hour later. The boot reload reads both forms; when both exist for a day it reads the
`.jsonl`. The current UTC day is never compressed.

**Size, measured 11 November 2026** on the real service: one snapshot is about 215 KB raw and
31 KB gzipped; at one a minute that is about 310 MB a day raw and 45 MB a day gzipped. One pairs
cycle is about 3.9 KB raw; at one every 10 seconds that is about 34 MB a day raw and 2 MB
gzipped. Together: about 345 MB a day raw, 47 MB gzipped. A 3 GB disk would be full in under 9
days without the gzip step; with it, it holds the current day raw plus about 55 closed days. A
year is about 17 GB. A day-sized snapshot file (312 MB) took about 6 seconds to compress and
verify, with the event loop never held more than 7 ms; a day-sized pairs file (34 MB) took
about 0.3 seconds.

**The disk guard.** `/healthz` carries a `data` block: `bytes` under the data dir, `dayFiles`
(`plain`, `gz`), `oldestDay`, `newestDay`, `retention` (`all` or `N days`), `recording`, and
`compression` (days still waiting, the last one done). With `BTC_CURVE_DISK_BUDGET_MB` set it adds
`budget` (`mb`, `usedPct`) and, past 80%, `warning` in plain words. The budget never deletes
anything: raise the disk or set a window. If a write fails (a full disk) the cycle goes on, the
page keeps serving from memory, and `data.recording` is `false` with `data.notRecording` saying
what failed and why; `data.writesLost` keeps the count after writing resumes.

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
or institutional APIs. It does not use CME futures as the hedge reference: CME market data is
licensed, so spot BRTI is the hedge mark and Deribit's dated future stands in for the term basis.
On an hourly digital the delta notional is ~$50–150 per $1 of contract, so 5 bp of intra-hour
basis is 2–7¢ of zero-mean tracking error that §5 does not carry. The static spread is unwound at
the first snapshot after settlement (up to ~2½ minutes late); the delta is flattened at the
settlement value. Deribit's inverse (BTC-settled) premium is converted at spot each snapshot; the
dropped second-order term is well under a cent.
