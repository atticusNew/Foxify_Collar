# Sports venues report

A read-only page: the same game's winner market on the three US event venues a
CFTC-only trader can use (Kalshi, Polymarket US, Novig) side by side, after each venue's taker
fee, for every NFL, NBA and NHL game within three days. It shows where the other side of a
position is cheapest and by how much, what the venues disagree on, what can be locked across
them in dollars, and how the gaps behave over time, pre-game and in play. Nothing on it is a
model. Every number is a venue's price, its published fee, or a difference of them.

Where it lives: `/sports` on the `atticus-btc-curve` Render service (same process, same key, no
second service; see "On the BTC curve service" below). Modules: `services/api/src/sportsVenues/**`
(`collector.ts` is the cycle and the routes) · tests: `services/api/tests/sportsVenues.test.ts`,
`sportsMount.test.ts` · `services/api/scripts/sportsVenuesReportService.ts` serves the same thing
on its own port for a local run. Reader's guide: `docs/sports-venues-study-guide.md`.

## What the page shows

The strip: as of, games on the board, snapshots in the window. The key: Reference (what the venues
show on their own) and Engine (what reading every venue's book for the same game at once adds).
Six tiles computed from the data: games with a choice of venue; the tightest book by venue (games
tightest of games listed, so a venue that lists fewer games is not penalised or flattered); the
cheapest other side now (sides routed off Kalshi, mean saving per $1); the same over the window
(share of readings each venue was cheapest, in play split out); executable crosses after fees;
the venue furthest off the consensus.

**§1 The board** (Reference + Engine). One game, two rows. Per venue: bid / ask on that team's
"wins" contract, depth at the best level in $1 shares, and the fee as it applies now (Novig: "no
fee" before tip-off). Consensus: each venue's two mids scaled to sum to 100, averaged over the
venues two-sided on the game. Three gap columns: each venue's scaled mid minus that mean. Last
column, for a holder of this side: the other side's all-in ask (ask plus fee) on every venue, the
cheapest named, the saving against Kalshi's own other side, and the depth at that level. The game
header carries each venue's both-sides cost over 100¢ (its spread plus fees), the tightest, and
the best cross when one exists.

**§2 Executable crosses, in dollars** (Engine). Buy the away side on venue X and the home side on
venue Y at all-in asks; when the two add to less than 100¢ the difference is locked whichever team
wins. Size is the smaller of the two best levels; dollars is edge × size. Over the window: in how
many snapshots a cross was open and the widest one.

**§3 The hedger's view of the venues** (Engine). Per venue: games listed and two-sided, mean
both-sides cost, games where it was the tightest, sides on which it quotes the other side, sides
on which it is the cheapest, the mean saving vs Kalshi's own when it is, and its mean distance
from the consensus. Kalshi is the reference (saving 0 by construction). Over the window: the share
of readings each venue was cheapest and the mean saving when it was not Kalshi, with the in-play
readings split out. A reading is one side of one game in one snapshot where two or more venues
quoted the other side. A coverage line states when a venue lists fewer games than the board.

**§4 Gaps over time** (Reference). Kalshi's mid minus each other venue's mid on the away side, per
game, every snapshot in the window (the home side is the mirror). Strip: mean |gap| per venue
pair, widest game, how many games sit 1¢ or more apart on average (persistent, so a quoting
difference rather than latency). The full table with sparklines is folded.

**Notes and limits** and the footer (sources, health per venue this cycle).

## Data

Kalshi (spine): `GET /markets?series_ticker=KX{NFL,NBA,NHL}GAME&status=open`, one market per team;
the ticker carries league, away and home codes and the ET game date (and a start time on NHL
tickers). A game is on the board when both teams' markets are open and the date is today or within
`SPORTS_VENUES_HORIZON_DAYS`. Depth from `GET /markets/{ticker}/orderbook`. Fee coefficient from the
series (`fee_multiplier` × 0.07), taker.

Polymarket US: `GET https://gateway.polymarket.us/v1/events?slug={league}-{away}-{home}-{date}` with the
venue's own abbreviations tried first (`POLY_US_CODES` in `readers.ts`: gs, no, ny, pho, sa; la,
nas, sj, uta, veg, was, mon, cgy), then the template aliases. The market whose `sportsMarketType`
ends in `_full_game_winner`; the long side must be one of the two teams by abbreviation, the other
side is 1 minus it with sizes carried across. Book from `GET /v1/markets/{slug}/book`. Fee the
market's `feeCoefficient` (0.095 at Tier 1). `gameStartTime` gives the start.

Novig: `GET https://api.novig.com/v3/public/catalog/markets?league={NBA,NFL,NHL}&marketType=MONEY`,
unsigned. Outcomes are the two clubs by code with the best bid and size on each; a bid on one is
the ask on the other. Contracts pay 1¢, so size is `qty / 100` in $1 shares. Fee `0.06`,
`charged: WHEN_LIVE`, so the all-in price carries no fee before `startsTs` and the coefficient
after. Matched to the Kalshi game by both clubs' codes and the ET date of `startsTs`. Novig lists
the day's games, so its coverage is a subset of the board.

All three are public, unauthenticated reads. No key is loaded; nothing here can place an order.

## Arithmetic

Taker fee per $1 at price p (cents): `c · (p/100) · (1 − p/100) · 100`. All-in ask = ask + fee;
all-in bid = bid − fee. Per-order rounding (Kalshi rounds a fee up to the cent) ignored.

Consensus for a side = mean over venues two-sided on the game of `mid_side / (mid_away + mid_home) · 100`.
With two venues it is their midpoint and the two gaps are symmetric; with three it is a mean. It is
the venues' own agreement, not a sharp line.

Both-sides cost (the game header, §3) = all-in ask(away) + all-in ask(home) − 100.

Cross = buy away on X at all-in ask + buy home on Y at all-in ask, X ≠ Y, sum < 100; edge = 100 −
sum; size = min of the two best-level sizes; dollars = edge × size / 100.

Cheapest other side for a holder of side s = min over venues of the all-in ask of ¬s; saving =
Kalshi's all-in ask of ¬s minus that (0 when Kalshi is cheapest). Readings over the window are
recomputed from the stored books with the fee that applied at the time, so Novig's pre-game 0
and live 0.06 are both honoured historically.

## Storage and ops

One JSONL file per UTC day under `SPORTS_VENUES_DATA_DIR`, one line per snapshot (every listing's
two sides, sizes, fee, start; health per venue). The in-memory history keeps
`SPORTS_VENUES_WINDOW_HOURS` (72 on its own, 24 on the BTC curve service) as compact
points (`[awayBid, awayAsk, homeBid, homeAsk, feeTheta, awayBidQty, awayAskQty, homeBidQty, homeAskQty]`
per game and venue, plus starts). A source that does not answer within
`SPORTS_VENUES_SOURCE_DEADLINE_MS` (45 s) is marked down for the cycle and the cycle goes on.

Every day is kept. Nothing is deleted unless `SPORTS_VENUES_RETAIN_DAYS` is set to a whole number
of days; unset, empty, `0`, `all` and `none` keep everything, and a value that cannot be read
keeps everything and says so on `/healthz`. One hour after a UTC day ends its file is gzipped to
`snapshots-YYYY-MM-DD.jsonl.gz` (verified against the original before the original is removed);
the boot reload reads both forms. `/healthz` carries a `data` block (bytes, day files, oldest and
newest day, retention, whether the last write landed) and, with `SPORTS_VENUES_DISK_BUDGET_MB`
set, how full the budget is and a warning past 80%. The budget deletes nothing. The same code
keeps the BTC curve's files; `docs/btc-curve-report.md` has the detail.

Endpoints: `/` (page, auto-refresh at the interval), `/api/report` (the page's data), `/api/latest`
(the raw snapshot), `/healthz` (no token). With `SPORTS_VENUES_TOKEN` set, the page and JSON need
`?k=<token>`.

Env: `SPORTS_VENUES_PORT` (8870), `SPORTS_VENUES_DATA_DIR`, `SPORTS_VENUES_INTERVAL_SEC` (60),
`SPORTS_VENUES_TOKEN`, `SPORTS_VENUES_RETAIN_DAYS` (unset: keep every day),
`SPORTS_VENUES_DISK_BUDGET_MB` (unset: no budget), `SPORTS_VENUES_HORIZON_DAYS` (3),
`SPORTS_VENUES_WINDOW_HOURS` (72), `NOVIG_PUBLIC_HOST`, `POLY_US_REST_BASE`, `KALSHI_REST_BASE`.

The gaps table plots at most 240 points per game and venue, evenly spread over the window; the
mean, the maximum, the last value and `n` are over every snapshot. The report is built once per
snapshot and served from that until the next.

### On the BTC curve service

Production serves this page from the BTC curve service, at `/sports`, with its JSON at
`/sports/api/report` and `/sports/api/latest`, behind `BTC_CURVE_TOKEN` (`?k=<token>`), with a
line of links to the BTC curve and BTC pairs pages. It is on by default; `BTC_CURVE_SPORTS=off`
(or `0`) turns it off. The `SPORTS_VENUES_*` settings above apply, except the port and the token,
which are the curve service's. The files go under `<BTC_CURVE_DATA_DIR>/sports` and follow
`BTC_CURVE_RETAIN_DAYS` unless `SPORTS_VENUES_RETAIN_DAYS` is set. `/healthz` on the curve
service carries a `sports` block: `warm`, `at`, `games`, `cycles`, `historyPoints`,
`windowHours`, `reload`, `venuesNotAnswering`, `lastError`, `data` (the same block as above for
the sports files) and, if the sports part ever fails outside a cycle, `mountError` in words. A
sports fault never reaches the BTC routes: the page answers 500 on that request and the fault
is on `/healthz`.

It holds 24 hours in memory there, not 72, because the process has 512 MB for everything.
Measured 11 November 2026 in a 512 MB, half CPU group: the full BTC window and three gzipped
days plus today of sports snapshots (43 games) reloaded, both loops polling the venues, every
page and JSON route opened in 15 rounds. With 24 hours: 305 MB at the peak, about 250 MB at
rest, nothing killed. With 72 hours: 394 MB at the peak, about 320 MB at rest, and a weekend
slate is larger, so 72 is not the default there. The disk keeps every snapshot either way.

Run locally: `npx tsx services/api/scripts/sportsVenuesReportService.ts` then open
`http://localhost:8870/`.

## What it does not do

- No model, no fair value, no sharp-book reference. The consensus is the venues' own mean.
- No spreads, totals, props or player markets; game winners only.
- No polymarket.com (offshore; not a venue for a CFTC-only trader), no ProphetX (its market data
  needs an account), no aggregator feed, no venue the operator holds a partnership with.
- No depth beyond the best level. A cross or a saving is shown at that size.
- No placement, no credentials, no account state.
