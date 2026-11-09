# BTC pairs: Kalshi and Polymarket US, at the money

A read-only page for a trader who works both venues by hand. It answers one question every ten
seconds: on the Bitcoin above/below contract closing next (hourly) and at 5 PM ET (daily), at the
money and one strike each way, how cleanly do Kalshi and Polymarket US both quote it, and what
does owning both sides cost after fees?

Service: `services/api/scripts/btcPairsService.ts`. Module: `services/api/src/btcCurve/pairs.ts`
(selection, arithmetic, score), `pairsHtml.ts` (page). Render service `atticus-btc-pairs` in
`render-event-demos.yaml`, region Virginia. Nothing here trades: public market data only, no
credentials loaded. The button on the page opens the two venues' own pages.

## Why a pair is one contract

Both venues settle on CF Benchmarks' BRTI, as the 60-second average into the close, and both list
the same strike grid: $100 apart on the hourly, $250 apart on the 5 PM ET daily. Kalshi's KXBTCD
series carries both tenors; Polymarket US lists them as `btc-strike-hourly` and
`btc-strike-daily`. The same strike at the same close is therefore the same contract with two
books. Two listing rules on Polymarket US: no hourly for the 5 PM ET hour (the daily owns it;
Kalshi does list that hour, so it shows Kalshi alone) and no daily on Fridays (the weekly takes
that close).

## What each cycle does

1. Kalshi KXBTCD open markets (one call, paged), the series fee multiplier (cached 10 minutes).
2. Polymarket US events for the two series (ids resolved by slug, cached 10 minutes).
3. BRTI 1-second prints for the last two minutes; the last close is spot.
4. "Hourly" is the contract closing soonest within 90 minutes on either venue; "daily" the one
   closing soonest beyond that within 36 hours. Where both venues share the close, their quotes
   are merged on the same bucket keys; otherwise the one that lists it stands alone and the page
   says so.
5. At the money is the listed strike nearest spot; one strike each way is the ladder's own next
   strike. Books are read for those three strikes on each venue (six calls); the rest of the
   ladder keeps its top of book.
6. Per pair: both legs, Kalshi mid minus Polymarket US mid, both spreads summed, the thinnest of
   the four best levels, the cheaper way to own both sides after fees, the gap's persistence over
   the window, a clean score.
7. Gaps are appended to a day file (`gaps-YYYY-MM-DD.jsonl`) and reloaded within the window on a
   restart; files older than three days are deleted.

A cycle takes well under a second; the interval is the cadence, not a pause.

## The arithmetic

**Both sides, cheapest.** Yes at venue A's ask plus No at 100 minus venue B's Yes bid, plus both
taker fees (`Θ·p·(1−p)` per $1: Kalshi 0.07 times the series multiplier, Polymarket US the
market's own coefficient, 0.095 at Tier 1). Both directions are priced; the cheaper is shown.
Under 100¢ is a cross and locks the difference whichever way BRTI settles. Depth is the thinner of
the two levels taken.

**Clean score, 0 to 100.** 40% how tight (both spreads summed; 0¢ full marks, 10¢ none), 30% how
deep (thinnest of the four best levels; 200 contracts full marks), 30% how closely the two mids
agree (0¢ full marks, 5¢ none). Scored only when both venues show a bid and an ask. It ranks
tradability, not edge: the gap and lock columns carry the edge.

**Persistence.** For the pair's gap over the window (two hours by default): the number of
readings, the share with the current sign (readings inside half a cent count as neither), the
mean, and a sparkline. Persistent gap is a quoting difference; flicker is latency.

## The page

A strip (BRTI, refresh, the two closes), the bundle (the two cleanest pairs as cards with the
plan and an "Open both venues" button, the rest listed), one table per tenor (below / at the money
/ above with both legs, gap, spreads, both-sides cost, gap over the window, score, and a reading
in words), a fold-out of the strikes around the money as mids only, notes and limits, sources and
health. The body re-fetches itself every cycle so the page keeps its place.

## Env

| Var | Default | Meaning |
| --- | --- | --- |
| `BTC_PAIRS_PORT` | 8880 | `PORT` honoured |
| `BTC_PAIRS_INTERVAL_SEC` | 10 | floor 5 |
| `BTC_PAIRS_DATA_DIR` | /tmp/btc-pairs | gap history |
| `BTC_PAIRS_TOKEN` | unset | when set, the page and JSON need `?k=<token>` |
| `BTC_PAIRS_WINDOW_MIN` | 120 | gap history kept |
| `BTC_PAIRS_KALSHI_URL` | `https://kalshi.com/markets/kxbtcd` | link template; `{event}` and `{ticker}` replaced, lower case |
| `BTC_PAIRS_POLY_URL` | `https://polymarket.us/event/{event}` | link template |

Routes: `/` page, `/fragment` the body, `/api/pairs` JSON, `/healthz`.

## Limits

- Two venues read within one cycle, not at one instant; on the hourly a cent of gap can be a few
  seconds of latency. The persistence column is there for that.
- Best level only. A cross or a cost is shown at that size; the next level is wider.
- Kalshi links default to the series page because the event page pattern could not be confirmed
  from the build host; set `BTC_PAIRS_KALSHI_URL` once checked in a browser.
- Order placement is out of scope for the hosted page. A copy run by the trader with his own
  venue keys on his own machine could place the ladder from the same report; the hosted copy
  never holds keys.
