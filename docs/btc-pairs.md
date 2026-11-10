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
second service). Module: `services/api/src/btcCurve/pairs.ts` (selection, arithmetic, score),
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
about sixteen calls per ten-second cycle, inside the public limits, and the hosted copy never
needs to know what the trader holds. His keys stay with his engine, which is the only thing that
places orders.

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
keeps the picks and the statuses.

Under the fold "Engine endpoint and the API": the engine URL (kept in the browser, prefilled from
`BTC_PAIRS_LAUNCH_URL`), the mode (**send** or **open**, prefilled from `BTC_PAIRS_LAUNCH_MODE`,
kept in the browser), Save, a Test button, the payload schema, the pull endpoints, and the limits.

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
    "kalshi": { "venue": "kalshi", "id": "KXBTCD-26NOV0917-T105499.99", "bidCents": 48, "askCents": 49, "bidQty": 2400, "askQty": 1800, "feeTheta": 0.07, "url": "https://kalshi.com/markets/kxbtcd" },
    "poly":   { "venue": "polymarket_us", "id": "btc-above-105500-nov-9-5pm", "bidCents": 47, "askCents": 51, "bidQty": 250, "askQty": 250, "feeTheta": 0.095, "url": "https://polymarket.us/event/..." },
    "twoSided": true,
    "gapCents": -0.5,
    "spreadCents": 5,
    "depth": 250,
    "lock": { "yesOn": "kalshi", "noOn": "polymarket_us", "yesAtCents": 49, "noAtCents": 53, "feesCents": 3.5, "costCents": 105.5, "edgeCents": -5.5, "qty": 250 },
    "persistence": { "n": 38, "sameSign": 0.71, "meanGapCents": -0.4, "series": [[1762723000000, -0.5], ...] },
    "score": 62,
    "reading": "Kalshi tighter and deeper; Polymarket US a cent cheaper on Yes",
    "modelCents": 48.2
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
| `GET /pairs/api/stream` | server-sent events; one `pairs` event per cycle carrying the whole report |
| `GET /pairs/fragment` | the page body (what the page polls) |

503 with `{ "error": "warming up" }` until the first cycle lands; 404 for a pair that is not
listed this cycle. `/healthz` on the curve service carries a `pairs` block (cycles, listeners,
index prints held, the regime label, which tenors are listed, last error).

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
   strike. Books are read for those strikes on each venue (eight calls).
6. The regime: realized vol from one-minute index samples over the last 15 and 60 minutes, their
   ranges and net moves; one sigma to each close at the hour's vol.
7. Per pair: both legs, Kalshi mid minus Polymarket US mid, both spreads summed, the thinnest of
   the four best levels, the cheaper way to own both sides after fees, the gap's persistence over
   the window, a clean score, the model probability. Per band: implied, model, cheapest legs,
   edge, sigmas. Per tenor: the pick.
8. Gaps are appended to a day file (`gaps-YYYY-MM-DD.jsonl`) and reloaded within the window on a
   restart; files older than three days are deleted. The report is pushed to every stream listener.

A cycle takes well under a second; the interval is the cadence, not a pause.

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
| `BTC_PAIRS_DATA_DIR` | `<BTC_CURVE_DATA_DIR>/pairs` (mount), `/tmp/btc-pairs` (standalone) | gap history |
| `BTC_PAIRS_LAUNCH_URL` | unset | the engine endpoint prefilled on the page |
| `BTC_PAIRS_LAUNCH_MODE` | `send` | `send` POSTs the payload; `open` opens the engine URL with the pair in the query; the page can switch locally |
| `BTC_PAIRS_WINDOW_MIN` | 120 | gap history kept |
| `BTC_PAIRS_KALSHI_URL` | `https://kalshi.com/markets/kxbtcd` | link template; `{event}` and `{ticker}` replaced, lower case |
| `BTC_PAIRS_POLY_URL` | `https://polymarket.us/event/{event}` | link template |
| `BTC_PAIRS_PORT`, `BTC_PAIRS_TOKEN` | 8880, unset | standalone script only; the mount uses the curve port and `BTC_CURVE_TOKEN` |

Local run next to an engine: `npx tsx services/api/scripts/btcPairsService.ts` serves the same
routes at the root on `:8880`.

## Limits

- Two venues read within one cycle, not at one instant; on the hourly a cent of gap can be a few
  seconds of latency. The persistence column is there for that.
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
