# BTC pairs: Kalshi and Polymarket US, at the money, with a Launch button

A minimal UI for a trader who works both venues by hand. Every ten seconds it answers one
question: on the Bitcoin above/below contract closing next and on the 5 PM ET daily, at the money
and one strike each way, how cleanly do Kalshi and Polymarket US both quote it, and what does
owning both sides cost after fees? Each row has a Launch button that posts that pair to the
trader's own engine. Nothing here places an order.

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

## Why public endpoints and not API keys

Both venues publish the order books the trader sees when logged in from unauthenticated
market-data endpoints (Kalshi `/trade-api/v2/markets` and `/orderbook`, Polymarket US
`gateway.polymarket.us/v1/events` and `/markets/{slug}/book`). A key does not change the prices;
it adds rate-limit headroom and access to the account (balance, orders, fills). The page makes
about sixteen calls per ten-second cycle, inside the public limits, and the hosted copy never
needs to know what the trader holds. His keys stay with his engine, which is the only thing that
places orders.

## The page

A strip (BRTI, the cleanest pair now, refresh and health), then two compact tables: next close
and the 5 PM ET daily, three strikes each (below, at the money, above). Per row: strike, Kalshi
Yes bid / ask with sizes, Polymarket US Yes bid / ask with sizes, K minus P (mids, with a
sparkline and the same-sign share over the window), both sides after fees (locks when under
100¢), a clean score with a short reading, and two buttons: **Launch** (posts the pair to the
engine) and **Venues** (opens both venues' pages). The cleanest row is tinted. The body re-fetches
itself every cycle and keeps each row's last Launch status.

Under the fold "Engine endpoint and the API": the engine URL (kept in the browser, prefilled from
`BTC_PAIRS_LAUNCH_URL`), a Test button, the payload schema, the pull endpoints, and the limits.

## The Launch button and the endpoints

Launch fetches the row's current pair from `/pairs/api/pair?id=<Kalshi ticker>` and `POST`s it as
JSON to the engine URL:

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
    "reading": "Kalshi tighter and deeper; Polymarket US a cent cheaper on Yes"
  }
}
```

`kalshi.id` is the Kalshi ticker, `poly.id` the Polymarket US market slug; both are what the
venues' order endpoints take. The Test button posts `{ "type": "atticus.btc_pair.ping", "at" }`.
The engine must answer cross-origin `POST` from the page (CORS), or pull instead.

Pull endpoints, all JSON with `Access-Control-Allow-Origin: *`, all relative to `/pairs` on the
curve service (with `?k=<token>` when the service has one):

| Route | Returns |
| --- | --- |
| `GET /pairs/api/pairs` | the whole report: both tenors, every pair, bundle, health |
| `GET /pairs/api/bundle` | `{ at, spotUsd, index, bundle: LaunchPayload[] }`, cleanest first |
| `GET /pairs/api/pair?horizon=hourly\|daily&place=below\|atm\|above` | one pair as a launch payload |
| `GET /pairs/api/pair?id=<Kalshi ticker \| Polymarket US slug>` | the same, by id |
| `GET /pairs/api/stream` | server-sent events; one `pairs` event per cycle carrying the whole report |
| `GET /pairs/fragment` | the page body (what the page polls) |

503 with `{ "error": "warming up" }` until the first cycle lands; 404 for a pair that is not
listed this cycle. `/healthz` on the curve service carries a `pairs` block (cycles, listeners,
last error).

## What each cycle does

1. Kalshi KXBTCD open markets (one call, paged), the series fee multiplier (cached 10 minutes).
2. Polymarket US events for the two series (ids resolved by slug, cached 10 minutes).
3. BRTI 1-second prints for the last two minutes; the last close is spot.
4. "Next close" is the contract closing soonest within 90 minutes on either venue; "daily" the
   one closing soonest beyond that within 36 hours. Where both venues share the close their quotes
   merge on the same bucket keys; otherwise the one that lists it stands alone and the page says so.
5. At the money is the listed strike nearest spot; one strike each way is the ladder's own next
   strike. Books are read for those three strikes on each venue (six calls).
6. Per pair: both legs, Kalshi mid minus Polymarket US mid, both spreads summed, the thinnest of
   the four best levels, the cheaper way to own both sides after fees, the gap's persistence over
   the window, a clean score.
7. Gaps are appended to a day file (`gaps-YYYY-MM-DD.jsonl`) and reloaded within the window on a
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

## Env

On `atticus-btc-curve` (the mount) or the standalone script:

| Var | Default | Meaning |
| --- | --- | --- |
| `BTC_CURVE_PAIRS` | on | `0` turns the mount off (curve service only) |
| `BTC_PAIRS_INTERVAL_SEC` | 10 | floor 5 |
| `BTC_PAIRS_DATA_DIR` | `<BTC_CURVE_DATA_DIR>/pairs` (mount), `/tmp/btc-pairs` (standalone) | gap history |
| `BTC_PAIRS_LAUNCH_URL` | unset | the engine endpoint prefilled on the page |
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
- Launch is browser to engine, so the engine (or a small relay in front of it) must accept the
  `POST` with CORS. An engine that would rather pull can follow `/pairs/api/stream`.
