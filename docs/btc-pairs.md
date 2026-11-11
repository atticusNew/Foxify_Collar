# BTC pairs: Kalshi and Polymarket US, at the money, with one Launch button per tenor

A minimal UI for a trader who works both venues by hand. Every ten seconds it answers one
question: on the Bitcoin 15-minute up/down window, on the above/below contract closing next and
on the 5 PM ET daily, at the money and one strike each way, how cleanly do Kalshi and Polymarket
US both quote it, what does owning both sides cost after fees, what does the band between two
strikes cost against what the venues and the index's own movement say it is worth, and is the
market contained or expanding right now? Each tenor has one Launch button that hands the picked
pair (the cleanest by default, or the row you chose) to the trader's own engine, by POST or by
opening his page. Nothing here places an order.

Where it lives: `/pairs` on the `atticus-btc-curve` Render service (same process, same token, no
second service). The same service serves the sports venues page at `/sports`
(`BTC_CURVE_SPORTS=off` turns that off; memory with all three pages: 305 MB at the peak of the
512 MB plan, `docs/btc-curve-report.md`); the pages link to each other with the key. Module: `services/api/src/btcCurve/pairs.ts` (selection, arithmetic, score),
`pairsCollector.ts` (the cycle, the routes, the stream), `pairsHtml.ts` (the page).
`services/api/scripts/btcPairsService.ts` serves the same thing on its own port for a local run.
Public market data only, no credentials loaded.

## Why a pair is one contract

Both venues settle on CF Benchmarks' BRTI, as the 60-second average into the close, and both list
the same strike grid: $100 apart on the hourly, $250 apart on the 5 PM ET daily. Kalshi's KXBTCD
series carries both tenors; Polymarket US lists them as `btc-strike-hourly` and
`btc-strike-daily`. The same strike at the same close is therefore the same contract with two
books. Two listing rules on Polymarket US: no hourly for the 5 PM ET hour (the daily owns it;
Kalshi does list that hour, so it shows Kalshi alone) and no daily on Fridays (the weekly takes
that close).

The 15-minute window is the same shape with one strike. Kalshi's `KXBTC15M` and Polymarket US's
`btc-updown-15m` each list one market per quarter hour: Up (Yes) when the BRTI 60-second average
into the close is at or above the price to beat, which is the BRTI 60-second average before the
window opened. Both venues print the same price to beat to the cent (observed: 73,158.07 on both
for the 11:00 to 11:15 ET window on 10 November 2026), so the two markets are one contract with
two books. Each venue lists the next window only when the current one closes, so for about half
a minute every quarter hour the section says no window is open.

## Why public endpoints and not API keys

Both venues publish the order books the trader sees when logged in from unauthenticated
market-data endpoints (Kalshi `/trade-api/v2/markets` and `/orderbook`, Polymarket US
`gateway.polymarket.us/v1/events` and `/markets/{slug}/book`). A key does not change the prices;
it adds rate-limit headroom and access to the account (balance, orders, fills). The page makes
about twenty calls per ten-second cycle, inside the public limits, and the hosted copy never
needs to know what the trader holds. His keys stay with his engine, which is the only thing that
places orders.

What the public read is good for, and what it is not. Polymarket US serves its public book
through a cache that holds each copy up to 30 seconds, so the Poly side of a row can be half a
minute behind Kalshi's. That is fine for a page a person reads: the page prints how old each read
is and says when its own read is too old to judge. It is not enough for an engine trading the
15-minute gap. That engine needs the venue's live authenticated feed, with its own keys, on its
own machine. This page holds no keys and does not use that feed.

## The page

A strip (BRTI, the cleanest pair now, the regime, refresh and health), then three compact
tables: the 15-minute window (one row, the price to beat), next close and the 5 PM ET daily
(three strikes each: below, at the money, above). Per row: strike (with its distance from spot in
dollars and in sigmas), Kalshi Yes bid / ask with sizes, Polymarket US Yes bid / ask with sizes,
K minus P (mids, with a sparkline and the same-sign share over the window), both sides after fees
(locks when under 100¢), a clean score with a short reading, the realized-vol model's probability
with its distance from the venues' mid, and on the ladders a small **use** button that makes that
row the tenor's Launch target. Between the strikes a band row: the range's width in dollars and
sigmas, what the venues' mids imply for settling inside, the model's number, and the cheapest way
to own the band (Yes just below plus No just above, each leg on the venue that sells it cheapest,
after fees) with the premium that costs over the venues' own mids. The cleanest row is tinted
green, the picked row blue.

Each tenor's header carries one **Launch** button, the pick's label, and the last Launch status.
The pick is the cleanest scored pair in that tenor and follows it as the books move, until you
press **use** on a row; your pick holds while that row is listed (when spot walks the three-strike
window past it, the tenor falls back to the cleanest). The body re-fetches itself every cycle and
keeps the picks and the statuses. A row on a stale read or with a book missing is never the
default pick; when no row qualifies, Launch is off and the label says why ("read too old to
judge", "a book is not answering").

Under each venue's quote is a line saying how old that read is. Under each tenor's table is a
line counting the day's lock episodes. Both are described below.

Under the fold "Engine endpoint and the API": the engine URL (kept in the browser, prefilled from
`BTC_PAIRS_LAUNCH_URL`), the mode (**send** or **open**, prefilled from `BTC_PAIRS_LAUNCH_MODE`,
kept in the browser), Save, a Test button, the payload schema, the pull endpoints, and the limits.

## How old each read is

Each book on the page is one HTTP read. Three clocks describe it, and the page keeps them apart:

- **Our fetch time.** When the venue answered our request, on our clock. Measured.
- **The venue's cache age.** The HTTP `Age` header: how many seconds the venue's cache had
  already held that answer when it gave it to us. Reported by the venue. Kalshi's order book
  sends none (it is served live). Polymarket US's book sends one on every answer.
- **The venue's own stamp.** Polymarket US puts `marketData.transactTime` in the book. Kalshi's
  order book carries no time at all, so the page says "venue stamp not given". Kalshi's market
  record has an `updated_time`, but that is when the listing changed, not when the quote did, so
  it is not used.

Under Kalshi's quote the page prints, for example, `read 3s ago · venue stamp not given`. Under
Poly's: `read 1s ago · 18s in the venue's cache · venue stamp 31s old`. Ages are counted to the
moment the pairs were priced (`pricedAt` in the JSON), which is after the last book came back.

The age the page judges by is the copy's age: our fetch age plus the venue's cache age. It is
not the venue's stamp, and here is why. On 10 November 2026 the Poly stamp was checked against
the copy it came in. On a busy book the stamp was within about a second of the copy. On a quiet
book the stamp was 41 to 91 seconds old on a copy under 30 seconds old. So the stamp marks the
book's last change, not the time of the copy. Judging by it would call every quiet book stale.
The stamp is still printed and still in the JSON, because an old stamp on a young copy is itself
information: nothing has traded or moved there.

Two reader changes came with this. Kalshi's price and size now both come from its live order
book. Before, the price came from the market list, which is cached for 15 seconds and was seen up
to 14 seconds behind the order book. And each book is asked once per cycle, with no retry: a
retry held the whole cycle for several seconds, and the next cycle asks again anyway.

## Stale reads

A gap between two books is only a quoting difference if both were read at about the same time.
When one copy is old, part of the gap is just the market having moved since. The page does not
call that edge.

The rule: a row is a **stale read** when either book's copy is older than the tenor's bound.

| Tenor | Bound | Env key |
| --- | --- | --- |
| 15-minute window | 15 seconds | `15m` |
| Hourly, next close | 30 seconds | `1h` |
| Daily, 5 PM ET | 30 seconds | `1d` |

Override with `BTC_PAIRS_STALE_SECONDS`, for example `15m=15,1h=30,1d=30` (any subset).

These bounds are a judgment, not a tested threshold. They come from two short samples of the
live books, not from a study. What the samples showed: Poly's public book is cached up to 30
seconds (copies were seen at every age from 0 to 29), and Kalshi's order book moved several
times within one such copy's life on the 15-minute window. Fifteen seconds keeps the younger half
of Poly's copies on the tenor that moves fastest. Thirty seconds keeps a whole cache life on the
tenors that move less per second. More data may move them.

When a row is stale:

- Both books are still shown, with their read ages.
- K minus P and Both sides are greyed and tagged **stale read**. A lock is not shown in green.
- The reading says which copy is old, for example `stale read: Poly copy 22s old (limit 15s)`.
- The row is not eligible to be the cleanest pick, so Launch does not send it by default. Its
  **use** button still works: sending it is the trader's call, and the payload says
  `"freshness": "stale"`.
- The gap is not added to the window, so it does not accrue persistence, and it is not written
  to the day file.
- It does not count toward a lock episode, and it does not end one that was running: a stale
  read shows nothing either way.

The clean score is not changed by staleness. Score says how tradable the two books are. Edge
is K minus P and Both sides. They stay separate.

A consequence on the 15-minute window: with a 15-second bound, a 30-second cache and a 10-second
cycle, the Poly copy is fresh on about half the cycles. The row will be tagged stale roughly
every other cycle or two. That is the public read's limit, shown instead of hidden.

## A book that does not answer

A book that fails is its own row's problem. The other rows of the tenor, and the other tenors,
are priced as usual. Before this, one failed book failed the whole tenor.

The row says what happened in plain words, with no URL:

- `Poly has listed this contract but is not serving its book yet (usual for a few minutes after
  it opens)`: the book answered 404 within ten minutes of the contract opening. This happens at
  every 15-minute roll. The 404 is itself a cached answer, held up to five minutes. On the two
  rolls watched on 10 November 2026 the new book first answered 97 seconds and about four
  minutes after the window opened.
- `Poly book did not answer (HTTP 500)`, `Kalshi book did not answer (timed out)`,
  `(no connection)`: anything else.

On that row there is no gap, no lock, no score and no Launch (no **use** button, and it is never
the pick). The venue's listing still carries a top-of-book price while its book is missing; the
row may show it, labelled `listing price 47 / 48, no size`. It is never fed to the gap, the lock,
the bands or Launch. A band that needs the missing leg takes it from the other venue or is not
priced.

The URL that was asked is kept for the operator: in the JSON under `errors` (on the pair and
flat at the top of the report) and in the service log, once when the book stops answering and
once when it answers again.

"No window is open" is unchanged: when neither venue lists a 15-minute window, the section says
so.

## Lock episodes

A single cycle showing a lock says little: it may be one odd read. What matters is whether a lock
stands. So the collector follows runs.

**Definition.** A lock episode is a run of cycles in which the same pair (the same contract on
both venues, bought the same way round) shows a lock after fees above zero, on fresh reads. It
counts once two or more cycles have shown it. It ends only when a fresh read shows the lock gone,
or the contract is no longer listed (the market closed). A cycle that cannot be judged (a stale
read, a book that did not answer) is not counted and does not end it. Before this rule a stale
cycle ended the run, so one lock standing for ten minutes on the 15-minute window, read through
Poly's 30-second cache, was counted as twenty episodes. A lock that flips direction (Yes on the
other venue) is a different trade and starts a new run. So does the next 15-minute window. If
the collector goes more than three intervals without a cycle, the run ends: it is no longer
known to have stood.

**What is recorded.** Start (the first cycle that showed the lock), end (the last cycle that
showed it), duration in seconds (end minus start), the number of cycles that showed it, the minimum lock in
cents per contract over the run, the minimum size over the run, and the value: minimum lock times
minimum size. The size is the one the lock is already quoted at, the thinner of the two
top-of-book levels taken. The JSON carries the value in cents (`valueCents`), like every other
price here; the page prints it in dollars.

**What the page shows**, per tenor, for the current UTC day: the number of episodes, the median
and the longest duration, the total dollars, and the latest one. Always with this label:

> measured at the size on the book, after fees, no orders placed; a floor on what was there, not
> what a trader would have captured

Read it literally. The minimum lock and the minimum size were both on the book on every cycle of
the run, so their product was there to take the whole time. It is not a fill, not a profit and
not a forecast. A trader would have paid for latency, queue position and the second leg moving.

An episode belongs to the UTC day of its last cycle. A run still going is counted as open, with
its figures so far.

**Where they are kept.** All of today's episodes and the last 50 per tenor from earlier days are
held in memory. Each finished episode is appended to `episodes-YYYY-MM-DD.jsonl` in the data dir,
next to the gap history, and reloaded on a restart (the last three days). The files themselves
are kept: nothing is deleted unless a retention window is set, and a day that has closed is
gzipped. A clean stop (SIGTERM) ends the open runs and writes them. A hard kill loses the runs
open at that moment.

**Limits.** The cycle is ten seconds, so a duration is known to that grain: a 10-second episode
is a lock seen on two reads ten seconds apart. On the 15-minute window about every third cycle
is on a Poly copy too old to judge. Such a cycle is carried over, so a lock that went and came
back inside it is counted as one episode, and the minimum lock and size are over the cycles
that could be judged.

Cycles inside one cache life read the same Poly copy. So a two-cycle episode is two Kalshi reads
against one Poly snapshot. It shows that Kalshi's side held for ten seconds against a Poly quote
that was true at one moment; it does not show that Poly's quote held. The one 15-minute episode
in the first live run was exactly this: Kalshi 38 / 39 on both cycles, the same Poly copy
(48 / 49) read at 1 and at 11 seconds old, a lock of 4.96 cents on 188 contracts, then the copy
passed 15 seconds (under the rule of that day, that ended the run). Only the venue's live feed
can say how long such a lock really stood.

On the hourly and the daily the 30-second bound admits every copy Poly's cache serves, so the
stale rule rarely ends a run there. In the last minutes before a close the at-the-money contract
moves by cents between cycles. A lock seen then on a Poly copy 20 to 29 seconds old may be
latency and not a standing quote. In the first live run (10 November 2026, the hour closing at
5 PM ET, thirteen to fifteen minutes before the close) four hourly episodes were recorded in two
minutes, 10 to 20 seconds each, 23 cents in total, while K minus P at the money swung between
minus 8 and plus 10 cents from one cycle to the next. Read the hourly count with that in mind,
or lower `1h` in `BTC_PAIRS_STALE_SECONDS`.

## The Launch button and the endpoints

Launch fetches the tenor's picked pair from `/pairs/api/pair?id=<Kalshi ticker>` and then, in
**send** mode, `POST`s it as JSON to the engine URL:

```json
{
  "type": "atticus.btc_pair",
  "version": 1,
  "at": "2026-11-09T21:17:03.000Z",
  "spotUsd": 105412.5,
  "index": "BRTI",
  "pair": {
    "horizon": "hourly",
    "place": "atm",
    "strike": 105500,
    "key": "above:105500",
    "settlesAt": "2026-11-09T22:00:00.000Z",
    "kalshi": { "venue": "kalshi", "id": "KXBTCD-26NOV0917-T105499.99", "bidCents": 48, "askCents": 49, "bidQty": 2400, "askQty": 1800, "feeTheta": 0.07, "url": "https://kalshi.com/markets/kxbtcd",
                "read": { "fetchedAt": "2026-11-09T21:17:03.412Z", "fetchAgeSec": 0.3, "cacheAgeSec": null, "venueAt": null, "venueAgeSec": null, "ageSec": 0.3, "state": null } },
    "poly":   { "venue": "polymarket_us", "id": "btc-above-105500-nov-9-5pm", "bidCents": 47, "askCents": 51, "bidQty": 250, "askQty": 250, "feeTheta": 0.095, "url": "https://polymarket.us/event/...",
                "read": { "fetchedAt": "2026-11-09T21:17:03.530Z", "fetchAgeSec": 0.2, "cacheAgeSec": 18, "venueAt": "2026-11-09T21:16:32.511Z", "venueAgeSec": 31.2, "ageSec": 18.2, "state": "MARKET_STATE_OPEN" } },
    "twoSided": true,
    "gapCents": -0.5,
    "spreadCents": 5,
    "depth": 250,
    "lock": { "yesOn": "kalshi", "noOn": "polymarket_us", "yesAtCents": 49, "noAtCents": 53, "feesCents": 3.5, "costCents": 105.5, "edgeCents": -5.5, "qty": 250 },
    "persistence": { "n": 38, "sameSign": 0.71, "meanGapCents": -0.4, "series": [[1762723000000, -0.5], ...] },
    "score": 62,
    "reading": "Kalshi tighter and deeper; Polymarket US a cent cheaper on Yes",
    "modelCents": 48.2,
    "errors": [],
    "freshness": "fresh",
    "staleAfterSec": 30
  },
  "set": { "horizon": "hourly", "settlesAt": "2026-11-09T22:00:00.000Z", "secondsToClose": 2577, "stepUsd": 100, "sigmaUsd": 368, "pick": "KXBTCD-26NOV0917-T105499.99" },
  "bands": [
    {
      "lower": 105400, "upper": 105500, "widthUsd": 100,
      "impliedKalshiCents": 13.5, "impliedPolyCents": 13, "impliedCents": 13.25, "modelCents": 10.8,
      "cost": {
        "legs": [
          { "venue": "kalshi", "id": "KXBTCD-26NOV0917-T105399.99", "side": "yes", "strike": 105400, "priceCents": 57, "qty": 96, "feeCents": 1.716 },
          { "venue": "kalshi", "id": "KXBTCD-26NOV0917-T105499.99", "side": "no", "strike": 105500, "priceCents": 58, "qty": 2400, "feeCents": 1.706 }
        ],
        "costCents": 18.42, "feesCents": 3.42, "qty": 96
      },
      "edgeCents": -5.17,
      "sigmas": 0.27
    },
    { "lower": 105500, "upper": 105600, "...": "the band above the money" }
  ],
  "regime": {
    "m15": { "minutes": 15, "rangeUsd": 306, "netUsd": -161, "volPct": 62, "n": 15 },
    "m60": { "minutes": 60, "rangeUsd": 1095, "netUsd": -420, "volPct": 68, "n": 60 },
    "label": "steady",
    "reading": "steady: last 15 min: range $306, net −$161, realized 62% · last hour: range $1,095, realized 68%"
  }
}
```

`kalshi.id` is the Kalshi ticker, `poly.id` the Polymarket US market slug; both are what the
venues' order endpoints take. `set` is the tenor the pair sits in; `bands` are that tenor's
ranges with the two legs each (`side` yes or no, the venue, the id the order endpoint takes, the
price, the size at that level, the fee); `regime` is the index's trailing movement. Fields are
only added, never changed in meaning, while `version` stays 1. On the 15-minute window `bands`
is empty and `set.stepUsd` is 0. The Test button posts `{ "type": "atticus.btc_pair.ping", "at" }`.
The engine must answer cross-origin `POST` from the page (CORS), or pull instead.

Fields added with the read ages, the stale rule, the failed-book row and the lock episodes. All
are additions; nothing was renamed or removed.

| Where | Field | Meaning |
| --- | --- | --- |
| each leg (`pair.kalshi`, `pair.poly`) | `read.fetchedAt`, `read.fetchAgeSec` | when the venue answered us (our clock), and seconds from then to the pricing. Measured. |
| | `read.cacheAgeSec` | seconds the venue's cache had held the answer (HTTP `Age`); `null` when the venue sent none. Reported by the venue. |
| | `read.venueAt`, `read.venueAgeSec` | the venue's own stamp and its age; `null` when the venue gives none (Kalshi). On Poly this is the book's last change. |
| | `read.ageSec` | the copy's age: `fetchAgeSec` plus `cacheAgeSec`. This is what the stale rule judges. |
| | `read.state` | the venue's market state where it says (Poly: `MARKET_STATE_OPEN`) |
| each pair | `freshness` | `"fresh"`, `"stale"`, or `null` when a venue is absent |
| | `staleAfterSec` | the bound this row was judged against |
| | `errors[]` | books that did not answer on this row: `venue`, `id`, `kind` (`not_served_yet`, `http`, `timeout`, `unreachable`), `status`, `reason` (the page's words), `url`, `detail`, `cacheAgeSec`, `listing` (`bidCents`, `askCents`, or `null`). That venue's leg is then `null`. |
| each tenor (`fifteen`, `hourly`, `daily`) | `staleAfterSec` | the tenor's bound |
| the report (`/api/pairs`, the stream) | `pricedAt` | when the books had been read and the pairs priced; every age is as of this moment |
| | `staleAfterSec` | the three bounds in force |
| | `errors[]` | every failed book this cycle, flat, each with its `horizon` and `strike` |
| | `lockEpisodes` | `label`, `day` (UTC), `minCycles`, and per tenor `episodes`, `open`, `medianDurationSec`, `longestDurationSec`, `totalValueCents`, `recent[]` (the latest five, newest first) |
| an episode (`recent[]`, `/api/episodes`) | | `horizon`, `settlesAt`, `key`, `strike`, `kalshiId`, `polyId`, `yesOn`, `noOn`, `startedAt`, `endedAt`, `durationSec`, `cycles`, `minLockCents`, `minQty`, `valueCents`, and `open: true` while it runs |

The stream frame is the whole report, so it carries all of the above every cycle. `pair` in the
launch payload is the same pair object, so it carries `read`, `freshness`, `staleAfterSec` and
`errors` too. `bundle` lists pairs on a stale read after every pair that is not.

In **open** mode Launch opens the engine URL in a new tab with the pair in the query string, for
an engine that is a screen the trader drives by hand rather than a service:

```
https://your-engine.example/btc-pair?atticus=btc_pair&id=KXBTCD-26NOV1017-T73499.99&horizon=daily
  &strike=73500&settlesAt=2026-11-10T22:00:00Z&kalshi=KXBTCD-26NOV1017-T73499.99
  &poly=cpc-btc-above-day-2026-11-10-73500&src=https://<curve host>/pairs/api/pair?id=KXBTCD-26NOV1017-T73499.99
```

`src` is this service's URL for the full payload (add `&k=<token>` when the service has one); his
page pulls it. Test in open mode opens the URL with `atticus=ping`.

Pull endpoints, all JSON with `Access-Control-Allow-Origin: *`, all relative to `/pairs` on the
curve service (with `?k=<token>` when the service has one):

| Route | Returns |
| --- | --- |
| `GET /pairs/api/pairs` | the whole report: the three tenors with their pairs and bands, the regime, bundle, health |
| `GET /pairs/api/bundle` | `{ at, spotUsd, index, bundle: LaunchPayload[] }`, cleanest first |
| `GET /pairs/api/pair?horizon=fifteen\|hourly\|daily&place=below\|atm\|above\|pick` | one pair as a launch payload; `pick` is the tenor's default Launch target |
| `GET /pairs/api/pair?id=<Kalshi ticker \| Polymarket US slug>` | the same, by id |
| `GET /pairs/api/episodes` | `{ label, minCycles, keptPerTenorBeforeToday, open: Episode[], episodes: Episode[] }`: every lock episode kept, newest first |
| `GET /pairs/api/replay?edge=1&size=10&lag=0,10,30&days=1` | the replay over the stored cycles, one result per lag (see "The replay"); at most 7 days and 4 lags a request |
| `GET /pairs/api/stream` | server-sent events; one `pairs` event per cycle carrying the whole report |
| `GET /pairs/fragment` | the page body (what the page polls) |

503 with `{ "error": "warming up" }` until the first cycle lands; 404 for a pair that is not
listed this cycle. A pair whose book did not answer is still found by that market's id, so the
caller reads why. `/healthz` on the curve service carries a `pairs` block (cycles, listeners,
index prints held, the regime label, which tenors are listed, books not answering, lock episodes
today per tenor, last error, and `data`: what the pairs files take on disk, the retention in
force, and whether the last write landed).

## The stored cycle

One line per cycle in `gaps-YYYY-MM-DD.jsonl` (the UTC day of the cycle's start), append-only.

Until 11 November 2026 a line was `{ "at": <ms>, "rows": [[settlesAt, key, gapCents], ...] }`:
the cycle's start and, for each pair whose read was not stale, the gap between the two mids.
Nothing else: no prices, no sizes, no fees, no read ages. A cycle with no such pair wrote no
line.

A line now keeps `at` and `rows` exactly as they were and adds:

| Field | Holds |
| --- | --- |
| `v` | `2` |
| `pricedAt` | ms; when the books were in and the pairs priced. Every read age is measured to it |
| `intervalSec` | the collector's cadence |
| `spotUsd` | the BRTI print the strikes were chosen around |
| `pairs` | every pair the cycle priced: `horizon`, `place`, `strike`, `key`, `settlesAt`, `staleAfterSec`, and `kalshi` and `poly`, each `{ id, bidCents, askCents, bidQty, askQty, feeTheta, ageSec, fetchAgeSec, cacheAgeSec, venueAgeSec }` or `null`; `errors` (`[{ venue, kind }]`) when a book did not answer |

A line is written every cycle, pairs or not, so a missing line is a missed cycle. Old lines
are never rewritten and nothing is filled in for them: the restart reload reads both forms,
and the replay counts old lines and says it cannot use them. A line is about 3.9 KB (measured,
seven pairs), 34 MB a day raw and about 2 MB gzipped.

## The replay

The question it answers from the stored cycles: what would this rule have captured, after
fees, if I were N seconds slow? Paper only. The exact semantics are in the header of
`services/api/src/btcCurve/pairsReplay.ts`, and the tests in
`services/api/tests/btcPairsReplay.test.ts` work each case by hand.

**The rule.** `edge`: the least lock that is a signal, cents per $1 pair after both venues'
fees at the size traded (default 1). `size`: the least size at the top of both books (default
10). `trade`: the size traded (default: the same). `lag`: seconds from signal to fill, a list
(default 10). `age`: a read older than this is not acted on (default 30). `horizons`: `15m`,
`1h`, `1d` (default all). `tolerance`: how late past one interval the fill cycle may be
(default 5).

**The trade.** Yes at one venue's ask and No at 100 minus the other venue's Yes bid, top of
book, the same arithmetic as the page's "Both sides" (`lockOneWay` in `pairs.ts`), with the
repo's `takerFeeCents` per contract times the size and each leg's fee for the order rounded up
to the next whole cent. Money is integer milli-cents; every rounding goes against the trader.

**Signal.** The first stored cycle at which the rule holds for a pair one way round, on that
cycle's reads alone: both books read, fresh for the tenor and no older than `age`, the size
there, the edge at the size traded at least `edge`.

**Fill.** The first stored cycle at or after signal time plus lag (`pricedAt` is the cycle's
time). Lag 0 is the signal cycle itself: an upper bound nobody achieves. Then, the way round
it was signalled:

| At the fill cycle | Outcome |
| --- | --- |
| no stored cycle within one interval plus the tolerance (a gap, or the data ends) | `unknown` |
| the pair or a leg is missing, the row is stale, or a read is older than `age` | `unknown` |
| a book's copy was not taken after the signal (`sameRead`) | not the fill; a later cycle inside the same wait is, else `unknown` |
| the top of book holds less than the size traded, or a side is empty | `gone` (size); no "sent anyway" figure, the depth below the top is not stored |
| edge at the size traded is zero or more | `captured`, at the fill cycle's edge |
| edge below zero | `gone` (edge), nothing captured; "sent anyway" carries the negative edge |

`unknown` is never counted as captured, as gone, or as zero.

**A fill needs a read taken after the signal.** A fill cycle counts only if both books' copies
left the venue after the signal cycle: the cycle's time minus the copy's stored age, less one
more second where the venue's cache gave the age (it is in whole seconds), must be later than
the signal. Poly's copy is cached up to 30 seconds, so the cycle 10 seconds after a signal often
prices the very copy the signal was read from; that is not a fill. The trade then waits for a
later cycle inside the same wait (lag plus one interval plus `tolerance`) and is `unknown`
(`sameRead`) if none read both books after the signal. With the default wait of 25 seconds that
is common; `tolerance=25` gives every signal a cycle on a new Poly copy. Lag 0 is exempt: it is
the signal cycle by definition.

**One trade per episode.** A pair one way round is the lock run identity the episodes use
(tenor, close, strike, both venue ids, which venue the Yes is on). After a signal there is no
new one on it until a stored cycle with reads that can be acted on shows the lock gone, the
pair is not in the cycle, or a venue no longer lists it. A stale read, a read older than `age`,
a book that did not answer and a stretch with no stored cycle do not re-arm it: nothing was
seen to be false. Unlike the page's episodes, one cycle is enough for a signal.

**What comes back**, per lag, for all tenors and per tenor: signals, captured, gone (edge,
size), unknown (no cycle, stale read, old read, missing read, same read), captured total, median and
worst captured edge, sent anyway, the share of known outcomes that survived the lag, the
seconds from signal to fill; days covered, cycles replayed, old-form cycles, lines skipped; a
row per day; the rule; and `assumptions`: both legs are assumed to fill together at the fill
cycle's prices, the 10-second cadence resolves a lag only to the next stored cycle, the
Polymarket US public book is an edge-cached copy up to about 30 seconds old (so a gap may be a
stale quote, which is why the read age is a rule input), no queue position, no partial fills,
nothing below the top of book.

**Command line**, no caps, plain or gzipped days:

```
npx tsx services/api/scripts/btcPairsReplay.ts --dir /var/data/btc-curve/pairs \
  --from 2026-11-11 --to 2026-11-17 --edge 1 --size 10 --lag 0,10,30,60
```

`--json` prints the same as JSON, `--trades 20` lists the first trades per lag, `--days 7`
takes the last seven UTC days. A request it cannot read is refused with exit code 2.

**Route.** `GET /pairs/api/replay` takes the same names as query parameters plus `days`
(default 1: today, UTC). One request reads at most 7 days, 4 lags, lags up to 3600 seconds and
125,000 stored cycles, takes at most 30 seconds, and runs one at a time; over a cap, or with a
parameter it cannot read or does not know, it answers 400 with `{ ok: false, refused: true,
error }` in plain words (429 while another replay runs). It is read-only, gives the event loop
back every 250 lines, and sits behind the same token as the rest of `/pairs`.

## What each cycle does

1. Kalshi KXBTCD and KXBTC15M open markets (two paged calls), the series fee multipliers (cached
   10 minutes).
2. Polymarket US events for the three series (ids resolved by slug, cached 10 minutes); the
   up/down family is read as a one-strike ladder at the price to beat (opt-in in the reader, so
   the curve report's strike ladders are untouched).
3. BRTI 1-second prints: the last hour and five minutes on the first cycle, the last two minutes
   after that, kept in memory for the regime gauge; the last close is spot.
4. The 15-minute window is the market closing soonest more than 30 seconds out and within 16
   minutes. "Next close" is the contract closing soonest within 90 minutes on either venue; "daily"
   the one closing soonest beyond that within 36 hours. Where both venues share the close their
   quotes merge on the same bucket keys; otherwise the one that lists it stands alone and the page
   says so.
5. At the money is the listed strike nearest spot; one strike each way is the ladder's own next
   strike. The book is read for each of those strikes on each venue (fourteen calls: seven rows,
   two venues), once each, with no retry. Each read keeps its fetch time, the venue's cache age
   and the venue's stamp, or the reason it failed. Kalshi's price and size both come from this
   read, not from the cached market list.
6. The regime: realized vol from one-minute index samples over the last 15 and 60 minutes, their
   ranges and net moves; one sigma to each close at the hour's vol.
7. Per pair: both legs with their read ages, fresh or stale against the tenor's bound, Kalshi mid
   minus Polymarket US mid, both spreads summed, the thinnest of the four best levels, the
   cheaper way to own both sides after fees, the gap's persistence over the window, a clean
   score, the model probability. Per band: implied, model, cheapest legs, edge, sigmas. Per
   tenor: the pick, from the rows that are not stale and have both books.
8. The cycle is appended as one line to a day file (`gaps-YYYY-MM-DD.jsonl`): the gaps on reads
   that are not stale, which a restart reloads within the window, and every pair's two books
   as they were priced, which the replay reads (see "The stored cycle"). Every day's file is
   kept unless a retention window is set (`BTC_PAIRS_RETAIN_DAYS`, else the curve's
   `BTC_CURVE_RETAIN_DAYS`); a closed day is gzipped to `.jsonl.gz` and read back from that.
9. Lock runs are stepped: extended, opened or ended. Episodes that ended are appended to
   `episodes-YYYY-MM-DD.jsonl`. The report is pushed to every stream listener.

A cycle usually takes well under a second; the interval is the cadence, not a pause. One book
that hangs can hold a cycle for up to its timeout (8 seconds, `EVENT_FETCH_TIMEOUT_MS`).

## The arithmetic

**Both sides, cheapest.** Yes at venue A's ask plus No at 100 minus venue B's Yes bid, plus both
taker fees (`Θ·p·(1−p)` per $1: Kalshi 0.07 times the series multiplier, Polymarket US the
market's own coefficient, 0.095 at Tier 1). Both directions are priced; the cheaper is shown.
Under 100¢ is a cross and locks the difference whichever way BRTI settles. Size is the thinner of
the two levels taken.

**Clean score, 0 to 100.** 40% how tight (both spreads summed; 0¢ full marks, 10¢ none), 30% how
deep (thinnest of the four best levels; 200 contracts full marks), 30% how closely the two mids
agree (0¢ full marks, 5¢ none). Scored only when both venues show a bid and an ask. It ranks
tradability, not edge: K minus P and Both sides carry the edge.

**Persistence.** For the pair's gap over the window (two hours by default): the number of
readings, the share with the current sign (readings inside half a cent count as neither), the
mean, and a sparkline. A persistent gap is a quoting difference; flicker is latency.

**Band.** Between strikes L (lower) and U (upper): buy Yes at L and No at U. If BRTI settles at
or above U, Yes pays; below L, No pays; between, both pay. One leg pays whatever happens, so the
range itself costs `YesAsk(L) + (100 − YesBid(U)) + fees − 100`, which is `YesAsk(L) − YesBid(U)
+ fees`, per $1 paid when it settles inside. Each leg is taken on whichever venue sells it
cheapest (four combinations). What the venues think the range is worth is `mid(L) − mid(U)` on
each; the edge is implied minus cost, negative when the spreads and fees cost more than the mids
give, positive when a cross makes the range free or better. This is the trade a ladder trader
means by "Yes just below plus No just above": a short-volatility, defined-risk range. The venues
already price it as the band's implied probability; the edge, if any, is in reading the regime.

**Model.** A normal move around spot of one sigma, where sigma is spot times the trailing hour's
realized vol times the square root of the time to the close in years. The model probability of
settling at or above a strike is `Φ((spot − strike) / σ)`; a band's is the difference of two.
It is a yardstick from the index's own last hour, not an options smile (the curve report has
that), so it answers "what does recent movement alone say" and nothing more. At 50% on $75,000,
one sigma is about $400 an hour and $200 a quarter hour.

**Regime.** Realized vol over the last 15 minutes against the last 60 (one-minute log returns,
population standard deviation, annualized over 525,600 minutes). Under 0.7 contained, over 1.4
expanding, otherwise steady; the ranges and the net move are shown beside it. A contained market
favours owning the band; an expanding one favours the wings.

## Env

On `atticus-btc-curve` (the mount) or the standalone script:

| Var | Default | Meaning |
| --- | --- | --- |
| `BTC_CURVE_PAIRS` | on | `0` turns the mount off (curve service only) |
| `BTC_PAIRS_INTERVAL_SEC` | 10 | floor 5 |
| `BTC_PAIRS_DATA_DIR` | `<BTC_CURVE_DATA_DIR>/pairs` (mount), `/tmp/btc-pairs` (standalone) | gap history and lock episodes |
| `BTC_PAIRS_RETAIN_DAYS` | unset: every day is kept (on the mount, unset follows `BTC_CURVE_RETAIN_DAYS`) | a whole number of days keeps that window and deletes older day files; `0`, `all`, `none` keep everything; a value that cannot be read keeps everything and says so on `/healthz` |
| `BTC_PAIRS_DISK_BUDGET_MB` | unset | standalone script: `/healthz` warns past 80% of it; deletes nothing. The mount is covered by `BTC_CURVE_DISK_BUDGET_MB` |
| `BTC_PAIRS_STALE_SECONDS` | `15m=15,1h=30,1d=30` | seconds beyond which a book copy makes its row a stale read, per tenor; any subset |
| `BTC_PAIRS_LAUNCH_URL` | unset | the engine endpoint prefilled on the page |
| `BTC_PAIRS_LAUNCH_MODE` | `send` | `send` POSTs the payload; `open` opens the engine URL with the pair in the query; the page can switch locally |
| `BTC_PAIRS_WINDOW_MIN` | 120 | gap history kept |
| `BTC_PAIRS_KALSHI_URL` | `https://kalshi.com/markets/kxbtcd` | link template; `{event}` and `{ticker}` replaced, lower case |
| `BTC_PAIRS_POLY_URL` | `https://polymarket.us/event/{event}` | link template |
| `BTC_PAIRS_PORT`, `BTC_PAIRS_TOKEN` | 8880, unset | standalone script only; the mount uses the curve port and `BTC_CURVE_TOKEN` |

Local run next to an engine: `npx tsx services/api/scripts/btcPairsService.ts` serves the same
routes at the root on `:8880`.

## Limits

- Two venues read within one cycle, not at one instant, and Polymarket US's public book comes
  from a cache up to 30 seconds old. The page prints each read's age and tags the row when it is
  over the bound. Inside the bound a cent of gap can still be a few seconds of latency; the
  persistence column is there for that.
- The cache age is what the venue's cache reports about itself (HTTP `Age`). If a venue stopped
  sending it, the copy's age would fall back to our fetch age alone and the row would read
  fresher than it is. Kalshi's order book sends none today and is served live.
- The stale bounds are a judgment from two short samples, not a tested threshold.
- Lock episodes are measured on the book at ten-second grain with no order placed. They are a
  floor on what was there, not what a trader would have captured.
- Best level only. A cross or a cost is shown at that size; the next level is wider.
- Kalshi links default to the series page because the event page pattern could not be confirmed
  from the build host; set `BTC_PAIRS_KALSHI_URL` once checked in a browser.
- Launch is browser to engine, so in send mode the engine (or a small relay in front of it) must
  accept the `POST` with CORS. An engine that is a page takes open mode. An engine that would
  rather pull can follow `/pairs/api/stream`.
- Depth on the 15-minute window can be a fraction of a contract at the best level on one side;
  the clean score reads that as thin, and the lock's size is the thinner of the two levels taken.
- The regime and the model use the last hour of index prints held in memory; after a restart the
  first cycle backfills them from the BRTI history endpoint, so there is no cold period.
- The pick follows the cleanest pair until a row's **use** is pressed; a chosen row that leaves
  the three-strike window as spot moves hands the pick back to the cleanest.
