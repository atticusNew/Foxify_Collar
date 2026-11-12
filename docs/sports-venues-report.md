# Sports venues report

A read-only page: the same game's winner market on the five US event venues a
CFTC-only trader can use (Kalshi, Polymarket US, Novig, ProphetX, Crypto.com) side by side, after each
venue's taker fee, for every NFL, NBA and NHL game within three days. It shows where the other side of a
position is cheapest and by how much, what the venues disagree on, what can be locked across
them in dollars, and how the gaps behave over time, pre-game and in play. Nothing on it is a
model. Every number is a venue's price, its published fee, or a difference of them.

Where it lives: `/sports` on the `atticus-btc-curve` Render service (same process, same key, no
second service; see "On the BTC curve service" below). Modules: `services/api/src/sportsVenues/**`
(`collector.ts` is the cycle and the routes) · tests: `services/api/tests/sportsVenues.test.ts`,
`sportsProphetX.test.ts`, `sportsCryptocom.test.ts`, `sportsHolder.test.ts`, `sportsMount.test.ts`, `sportsTapeReplay.test.ts`, `sportsProspectPage.test.ts` · `services/api/scripts/sportsVenuesReportService.ts` serves the same thing
on its own port for a local run. Reader's guide: `docs/sports-venues-study-guide.md`.

The Lock in material (the replay on Crypto.com's real trades, and the lock on a position you
name) is not under this page's key in production. It is served as a page made for one reader,
at its own address under its own key, and the full tables are under an internal key: "Pages
with a key of their own" below. Run on its own port, the
script still serves `/replay` and `/lock` beside the board.

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
fee" before tip-off; ProphetX: "fee 2% of winnings" on NFL and NBA, "fee 3.5%" on NHL; Crypto.com: "fee 2¢ a contract"). Consensus: each venue's two mids scaled to sum to 100, averaged over the
venues two-sided on the game. One gap column per venue: its scaled mid minus that mean. Last
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

**§5 A holder on each venue** (Engine). Someone holds one side of a game on a venue and wants
out. One row per venue as the holder's venue, before the start and in play, with a by-league
fold: readings (sides with a bid, and how many more had none), the cost of selling on that
venue's own book against the consensus, its spread, how often its bid holds 100, 1,000 and 10,000
contracts, how often another venue's other side is cheaper and by how much, and how often a bid
better than its own book would still lock after every fee. Unlike §2 to §4 this is counted over
every snapshot since the count began, not only the window (`holder.ts`).

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

ProphetX (`prophetx.ts`; host `https://www.prophetx.co`, `PROPHETX_PUBLIC_HOST` overrides): the
unsigned reads its own website makes.
`GET /trade/public/api/v1/tournaments/{132 NBA, 31 NFL, 234 NHL}/events` lists a league's events
with the two clubs and the start; an event is matched to the Kalshi game by both clubs (full name,
or the venue's abbreviation where it is one of the template's codes) and the ET date of
`scheduled`, and exactly one event must match. The list's tournament name is checked against the
league, so an id that comes to mean something else shows nothing instead of the wrong games.
`GET /partner/v2/public/get_multiple_markets?event_ids=...&market_types=moneyline` returns, for
the market whose type and subtype are both `moneyline` (the two-way winner; on NHL that includes
overtime, and the regulation-only `moneyline_3_way` is not read), up to five levels per club:
American `odds` and `value`, the dollars a taker can still put on at those odds. Price =
`100/(odds+100)` for positive odds, `-odds/(100-odds)` for negative; contracts at the level =
`value / price`; the best level is the lowest price with at least $1 left (the venue's minimum
order), same odds summed. The odds offered on a club are its ask; its bid is 1 minus the other
club's ask, sizes carried across, the same way the Polymarket US and Novig books are read.
Fee, two models, both read each cycle and neither assumed:
`POST /fre/v1/fees/estimate` (taker, at 50¢ and at 25¢ for each event) names the model. NHL is
maker/taker: `0.035 · p · (1 − p)` per contract at the trade, the Kalshi shape, so it is carried
as a coefficient. NFL and NBA are commission: nothing at the trade and the percentage from
`GET /commission/public/commissions?event_ids=...&sub_types=moneyline` (2) of a market's net
winnings at settlement. The venue's fee schedule states the same two rules. A game whose fee
answer is not one of those two shapes is left off and `/healthz` says how many; if that is every
game the venue is shown as not answering. ProphetX lists the nearest games (18 of the 43 on the
board on 11 November 2026), so its coverage is a subset of the board, like Novig's.

Crypto.com (`cryptocom.ts`; host `https://api.crypto.com/fcm/v1/public`, `CRYPTOCOM_PUBLIC_HOST`
overrides): the public market-data API of its US exchange (North American Derivatives Exchange,
trading as Crypto.com | Derivatives North America and OG). It is the book behind OG and behind
any broker that introduces customers to that exchange, so it is also the book such a holder
sells into. `GET /get-events?series_symbol={NBA,NFL,NHL}{year}&limit=1000` lists a league's events;
the year before, this year and the next are asked (a series that does not exist answers 400 and is
asked again after 15 minutes), games only (`PREDICT_EVENT_TYPE` "Game"), kept for 5 minutes. An
event is matched to the Kalshi game by both clubs' full names (`AWAY_PARTICIPANT`,
`HOME_PARTICIPANT`, in either order; all 94 club names equal the templates' on 11 November 2026)
and the ET date of `EVENT_DATE`, and exactly one must match.
`GET /get-instruments?event_symbol=...&limit=1000` lists every contract on the game (20 to 900,
props included), paged by cursor; the winner pair is the two with `PREDICT_CONTRACT_TYPE`
"Moneyline" and `PREDICT_PERIOD_TYPE` "Full-Game", one per club by `PARTICIPANT`, of one
`PREDICT_MARKET_ID`. That read is made once per game and the two symbols kept for the life of the
process; a game whose pair is not up yet is asked again after 15 minutes. Each cycle then costs
`GET /get-book?instrument_name=...&depth=1` twice per game: each club has its own $1 contract and
its own book, as on Kalshi, prices to the cent, sizes in contracts to two decimals. The first
cycle after a boot took 9 s for 43 games and the later ones under 2 s. Fee, from the exchange's
fee schedule (effective 1 August 2026): the customer of a broker pays $0.02 per contract to open
and $0.02 to close before expiry, nothing at settlement; "based on the technology" of the broker
the fee can instead be `0.07 · p · (1 − p)`, which is never more than 2¢. Which one a given
broker's customers pay is not public: the page counts the flat 2¢ and
`SPORTS_VENUES_CRYPTOCOM_FEE=weighted` switches it. A broker's own commission is not counted.
Settlement is the official result with overtime and the shootout counted; a game not completed
within 48 hours of its scheduled start settles at the prior week's average price, which no other
venue here does. Crypto.com listed all 43 games on the board on 11 November 2026, with a book
1¢ wide and tens of thousands of contracts at the best level on the day's games.

All five are public, unauthenticated reads. No key is loaded; nothing here can place an order.
ProphetX's are its website's own endpoints, not a documented public API: the venue can change or
close them without notice, and the page then shows ProphetX as not answering and carries on with
the others. The documented route is the aggregator DATA key the event service holds; it is
not loaded on this service.

## Arithmetic

Taker fee per $1 at price p (cents): `c · (p/100) · (1 − p/100) · 100`. All-in ask = ask + fee;
all-in bid = bid − fee. Per-order rounding (Kalshi rounds a fee up to the cent) ignored.

A fee on winnings (ProphetX NFL and NBA, g = 0.02) is counted in full on the buy, as if the
contract wins: all-in ask = ask + g · (100 − ask). That is the most it can cost, and it is what a
lock needs (the leg that wins pays it). All-in bid = bid − g · bid. One simplification: the venue
charges g on a market's net winnings, so buying into a new position pays it only on a win and
closing an existing one pays it on the net of both trades; the page prices every trade as a new
one.

A fixed fee per contract (Crypto.com, f = 2¢): all-in ask = ask + f, all-in bid = bid − f,
whatever the price. It is charged on a sale before expiry and not at settlement, so a holder who
waits for the result pays it once and one who sells pays it twice.

Consensus for a side = mean over venues two-sided on the game of `mid_side / (mid_away + mid_home) · 100`.
With two venues it is their midpoint and the two gaps are symmetric; with more it is a mean. It is
the venues' own agreement, not a sharp line.

Both-sides cost (the game header, §3) = all-in ask(away) + all-in ask(home) − 100.

Cross = buy away on X at all-in ask + buy home on Y at all-in ask, X ≠ Y, sum < 100; edge = 100 −
sum; size = min of the two best-level sizes; dollars = edge × size / 100.

Cheapest other side for a holder of side s = min over venues of the all-in ask of ¬s; saving =
Kalshi's all-in ask of ¬s minus that (0 when Kalshi is cheapest). Readings over the window are
recomputed from the stored books with the fee that applied at the time, so Novig's pre-game 0
and live 0.06 are both honoured historically, and so are ProphetX's fee on winnings and
Crypto.com's fixed fee (stored with the reading).

The holder's view (§5), per reading (one side s of one game in one snapshot, counted while the
consensus on s is between 5¢ and 95¢), for venue H as the holder's venue, with the fees stored
with the snapshot:
sale cost = consensus(s) − (H's bid on s − H's fee to sell at it);
saving = H's own all-in ask on ¬s − the cheapest all-in ask on ¬s on any venue, counted when
another venue is cheaper (a tie is not a saving);
room = 100 − that cheapest all-in ask − H's bid on s − H's fee to buy at that bid: what is left
if someone takes the holder's contract at H's bid, pays H's fee on it and buys the other side on
the cheapest venue. Above zero a bid better than H's own book locks after every fee, and the
room is the most it can add, to be split between the holder and whoever makes the bid. Before
the start and in play are split by the venue-published start; a game with only a date counts as
before the start.

## Lock in on the trade tape

Crypto.com's exchange publishes every trade on a contract: the time, the size, the price, and
whether the taker bought or sold. A taker's buy on a club's winner contract is a real position
someone opened, through whichever broker or app sends orders to that exchange. The service keeps
that tape for every game on the board and, once a game is over, follows each position to the
result and works out what a lock (the holder's own sale of part of it) would have been at bids
that were really there. No position is simulated. Code: `tape.ts` (the record), `tapeReplay.ts`
(the replay, a pure function of one game's file), `lockMath.ts` (the arithmetic, whole
micro-dollars), `lockNow.ts`, `replayHtml.ts`, and for the reader's page `audiences.ts` and
`prospectHtml.ts`.

**What counts as a position.** Every taker buy at 5¢ to 95¢, taken as held to the result. The
tape has no account on it: one person's three buys are three positions, a buy that closed a
short counts, and a holder who sold by hand is still followed to the end. It is the whole
exchange, not one broker's customers.

**A bid that was really there.** A lock is priced only at the best bid of the book as the
collector read it that minute (with its size), or at a taker's sale on the tape (someone sold
that many at that price then). Never from a buy, and only between 5¢ and 95¢.

**Before the start.** A position opened before the scheduled start, locked at the last bid of
the hour before it, in the product's three sizes: Max upside sells 40%, Balanced 60%, Max floor
80% (`SALE_SHARE_PERCENT` in `eventCollar/crossVenue/memberSale.ts`). The sale's cash after the
fee is the floor; the cap adds $1 on each contract kept.

**In play.** Every position, from the scheduled start or from when it was opened, whichever is
later. Each option is taken at the first bid that makes it possible, which is a rule and not
hindsight:

| Option | Rule |
| --- | --- |
| Max upside, half back | sell 40% the first time that returns 50% of the stake or more |
| Stake back, 20% or more rides | sell the fewest contracts whose cash covers the whole stake, the first time that is 80% of the position or less |
| Stake back, 40% or more rides | the same, at 60% or less |
| Stake back, 60% or more rides | the same, at 40% or less |

The first two happen at the same bid (a quarter above what was paid, after both fees): two
choices at one moment.

"The stake" a sale returns is what the holder was charged: the price and the fee to open, up to
a whole cent (`stakeCharged`). The sale's cash is paid down to a whole cent, so the cents back
are never fewer than the cents paid, even on a ticket of a fraction of a contract.

**Ahead at some point.** A position counts as ahead if any bid after it was opened would have
sold all of it for more than it cost with both fees. The replay counts those, and those whose
side then lost with what they had paid.

**How long the chance lasted.** For each in-play lock, the minutes from the bid it was taken at
to the next bid seen below what the option needs, or to the last bid between 5¢ and 95¢ when
none was. Summed per option, with the count that lasted ten minutes or more.

**Tickets told.** Per game, one real position that took stake back and lost and one that took
it and won: cost $20 to $100, bought at 25¢ to 75¢, the one nearest $50. The report lists them
latest game first.

**The result** is read from the tape once a game is over (four and a half hours after its start
and half an hour with no trade): the side whose last trade printed at 97¢ or more while the
other's was at 50¢ or less, or whose opponent's last trade printed at 3¢ or less while its own
was at 50¢ or more (on a thin game only the loser's contract prints after the whistle). A game
with no such result 30 hours after its start is closed, listed, and not counted.

**The replay page** (`/replay` on its own port, `/lockin` under the internal key in production): the strip and six tiles; §1 the positions by league; §2 before
the start; §3 in play; §4 what it adds in orders (every lock is a sell order on the exchange's
book that would not otherwise be placed; shown for every holder who could and scaled to 10 in
100); §5 the same for stakes of $500 or less, by league, and game by game. "Kept less given
up" is what losers kept minus what winners gave up: over enough games it tends to the fees and
the spread, and over a few nights it swings with which sides won.

**Lock in now** (`/lock` on its own port; the same card is on the reader's page): pick a game and side, a number of contracts and the price
paid (blank: the ask now). It shows the floor, the cash now and the cap for each option at the
bid on Crypto.com's book this minute: the three sizes before the start, with stake back first
once the game is in play and the bid is high enough. Stake back is shown whenever it leaves
something riding. The replay counts it only once it sells 80% or less, so a card that sells
more says so and gives the bid at which the replay would count it; when stake back cannot be
shown, the page gives the bid at which it appears and the bid at which it is counted. Quotes only.

**A lock at a moment of a finished game** (`lockPast`, `pastMoments`): the same card on a closed
game's own file, at a bid that was there then (a book reading, or a taker's sale with the size
of that sale), with how the side finished beside each option. The moments offered are the last
bid of each five minutes, from an hour before the start. With no price given the position is
taken at the last buy on the tape before the start; with no moment given, at the first bid in
play that returns the stake from 80% or less.

### Pages with a key of their own

`audiences.ts` lists the pages that have their own address and their own key, read from the
environment. Two entries:

| Address | Key | For | What it serves |
| --- | --- | --- | --- |
| `/prospect` | `PROSPECT_PAGE_KEY` | one reader outside the company | one page: results, held back as below |
| `/lockin` | `LOCK_IN_INTERNAL_KEY` | the company | `/lockin` every replay table and the method, `/lockin/lock` the lock card with its order, `/lockin/api` the report as JSON |

- An entry is on only when its key is set, is 16 characters or more, and is not `BTC_CURVE_TOKEN`,
  `SPORTS_VENUES_TOKEN` or the other entry's key. Otherwise every address under it answers 404,
  and `/healthz` says why under `sports.audiencePages` (by position, without a name: `/healthz`
  needs no key).
- A key opens its own entry and nothing else. The service's own key opens neither. The host
  checks these addresses before its own key.
- The internal key is never given to a reader.
- Neither refreshes itself except the internal lock card. Answers carry
  `Referrer-Policy: no-referrer`, since the key is in the address.

**What the reader's page shows** (`prospectHtml.ts`), retail-size tickets ($500 or less) first:
where customers are lost (finished at $0; of those, ahead at some point); what Lock in is for
the customer and that nobody takes the other side; two real tickets off the tape, and the lock
as a customer would see it for any game and moment; the replay's three main rows; a calculator
(how many lock in 100, the reader's share of the exchange, what the reader earns per contract: three
boxes that scale counts already on the page); one line on the depth behind the exchange's best
price; what a pilot would answer; notes and limits. It is one address: no tables behind it, no
JSON, no link off it.

**What the reader's page holds back, on purpose.** It shows results, not how they are produced.

- It says what a lock gives the customer (cash now, the total if their side wins, the share of
  the stake back), and that it is done on the exchange from the customer's own account with
  nobody on the other side. It does not say what order does it, how that order is sized, or at
  what threshold. The words "sell", "sale", "sold" and "bid" are not on it, nor the tiers'
  percentages. Each figure is defined by what the customer ends up with ("the whole stake back
  with a fifth of the position or more still riding"), which is enough to check it.
- It names no other venue and says nothing of comparing or covering across venues. Of the
  holder count it is given one figure: how often the exchange's own best price had 1,000
  contracts or more behind it.
- It says the source is the exchange's public trade tape. It does not name the feed, say how or
  how often it is read, how a result is read, or that games are being recorded.
- It does not describe what Atticus does in the flow or how it is paid.
- It names the reader ("Prospect", from the entry's `short`; "Prospect Markets" on the title
  line and the footer) and never calls it a broker or addresses it as "you". "Broker" is the
  licence of one of its subsidiaries, not what it calls itself, and the word reads as a third
  party. It does not say how the reader is paid on an order, which is not public: a lock is
  "one more order", and what it earns per contract is a box the reader fills in.

None of that is denied if asked. The page does not volunteer it. `tests/sportsProspectPage.test.ts`
fails if those words come back. Anything added to the page should pass the same test: does the
reader need it to believe a number, or does it only tell them how to make the number themselves?

"Guide" walks six stops with a short note at each for what the number means to the reader; "Show
all notes" opens every note at once; "Print or save as PDF" prints the page as it stands, notes
included when they are open. The only script on the page is that and the calculator.

A page for another reader is a new "broker" entry in `audiences.ts` (its `name`, its `short`)
and a key. The words of `prospectHtml.ts` are written for a company whose customers trade on
Crypto.com's exchange through it. A reader that is itself the exchange (its own book, its own
fee) needs its own page and figures from its own trades.

**Layout.** The page carries its own style over the shared one: text held to a readable line,
the five headline figures large, numbered sections, the lock's four choices two by two, and a
print style that fits a letter page (five pages). Check a change at desktop width, at phone
width and in print.

**The record.** `<data dir>/tape/<event>.tape.jsonl`, one file per game, append-only: a header
(the game, its start, the two contracts), one line per trade as the venue gave it, then, when
the game is closed, the book's best bid from every snapshot in the window and the result. A
closed file is never written again. `tape/replay.json` is derived (each closed game's replay)
and is worked out again when missing, unreadable, or made under another fee. About 200 KB a
game. Games close to their start or in play are read every cycle; the others every 20 minutes.

**Games shipped with the code.** `src/sportsVenues/tapeSeed/` holds the games captured before
the service kept the tape (9 to 11 November 2026: 16 NBA, 14 NHL, 1 NFL; trades only, so their
locks are priced at takers' sales). On start-up any of them not already on the disk is copied
there. Their results were checked against the same games' settled markets on Kalshi.

**Wire facts** (read 12 November 2026). `GET /get-trades?instrument_name=&count=150&start_ts=1[&end_ts=]`,
newest first, 150 at most. `start_ts` must be sent: without it the venue looks back 24 hours
from `end_ts` (or from now) and answers a short page although older trades exist. The trade id
is the match time in nanoseconds. Both contracts of a finished game were still readable 40
hours after its start; for games four days old one of the two was gone, so a tape is collected
while the game is listed and cannot be rebuilt later.

**Limits.** Not a count of how many holders would lock, nor of what a lock does to whether they
come back: the first needs the product in front of them, the second a broker's account data. A
large ticket would walk the book; the page's fold leaves tickets over $500 out. A broker's own
commission is not public and is not counted.

## Storage and ops

One JSONL file per UTC day under `SPORTS_VENUES_DATA_DIR`, one line per snapshot (every listing's
two sides, sizes, fee, start; health per venue). The in-memory history keeps
`SPORTS_VENUES_WINDOW_HOURS` (72 on its own, 24 on the BTC curve service) as compact
points (`[awayBid, awayAsk, homeBid, homeAsk, feeTheta, awayBidQty, awayAskQty, homeBidQty, homeAskQty]`
per game and venue, then the share of winnings and the fixed fee where a venue charges them, plus starts). A source that does not answer within
`SPORTS_VENUES_SOURCE_DEADLINE_MS` (45 s) is marked down for the cycle and the cycle goes on.

The holder's count (§5) is a running total, not a window: `holder-count.json` beside the day
files, a few KB, rewritten (to a temporary name, then renamed) after every snapshot. It holds,
per venue, league and phase, the sums the section's means are made of, and the time of the last
snapshot counted, so a snapshot is never counted twice. On a boot it is read back and any
snapshot in the reloaded window newer than its last is added, which also fills it from snapshots
taken before it existed. It is derived data: the day files are the record. If the file is lost
or unreadable it starts again from the window and `/healthz` says so.

Every day is kept. Nothing is deleted unless `SPORTS_VENUES_RETAIN_DAYS` is set to a whole number
of days; unset, empty, `0`, `all` and `none` keep everything, and a value that cannot be read
keeps everything and says so on `/healthz`. One hour after a UTC day ends its file is gzipped to
`snapshots-YYYY-MM-DD.jsonl.gz` (verified against the original before the original is removed);
the boot reload reads both forms. `/healthz` carries a `data` block (bytes, day files, oldest and
newest day, retention, whether the last write landed) and, with `SPORTS_VENUES_DISK_BUDGET_MB`
set, how full the budget is and a warning past 80%. The budget deletes nothing. The same code
keeps the BTC curve's files; `docs/btc-curve-report.md` has the detail.

Endpoints: `/` (page, auto-refresh at the interval), `/api/report` (the page's data), `/api/latest`
(the raw snapshot), `/replay` and `/api/replay`, `/lock` and `/api/lock` (`game=<key>|away` or
`|home`, `n=` contracts, `paid=` cents), `/healthz` (no token). With `SPORTS_VENUES_TOKEN` set, the page and JSON need
`?k=<token>`. `/prospect` needs `?k=<PROSPECT_PAGE_KEY>`; `/lockin`, `/lockin/lock` and `/lockin/api` need `?k=<LOCK_IN_INTERNAL_KEY>`
(`game=past:<event>|away` or `|home` with `at=<ms>` for a finished game).

Env: `SPORTS_VENUES_PORT` (8870), `SPORTS_VENUES_DATA_DIR`, `SPORTS_VENUES_INTERVAL_SEC` (60),
`SPORTS_VENUES_TOKEN`, `SPORTS_VENUES_RETAIN_DAYS` (unset: keep every day),
`SPORTS_VENUES_DISK_BUDGET_MB` (unset: no budget), `SPORTS_VENUES_HORIZON_DAYS` (3),
`SPORTS_VENUES_WINDOW_HOURS` (72), `SPORTS_VENUES_CRYPTOCOM_FEE` (`flat`, or `weighted`),
`PROSPECT_PAGE_KEY` (unset: the reader's page is off), `LOCK_IN_INTERNAL_KEY` (unset: the internal pages are off),
`NOVIG_PUBLIC_HOST`, `PROPHETX_PUBLIC_HOST`, `CRYPTOCOM_PUBLIC_HOST`, `POLY_US_REST_BASE`, `KALSHI_REST_BASE`.

The gaps table plots at most 240 points per game and venue, evenly spread over the window; the
mean, the maximum, the last value and `n` are over every snapshot. The report is built once per
snapshot and served from that until the next.

### On the BTC curve service

Production serves this page from the BTC curve service, at `/sports`, with its JSON at
`/sports/api/report` and `/sports/api/latest`, behind `BTC_CURVE_TOKEN` (`?k=<token>`), with a
line of links to the BTC curve and BTC pairs pages. The replay and the lock are not served under
that key and the board does not link to them: whoever holds the curve key sees the board only.
The reader's page is at `/prospect` under `PROSPECT_PAGE_KEY` and the full tables at `/lockin`
under `LOCK_IN_INTERNAL_KEY`, on the same service ("Pages with a key of their own"
above). It is on by default; `BTC_CURVE_SPORTS=off`
(or `0`) turns it off. The `SPORTS_VENUES_*` settings above apply, except the port and the token,
which are the curve service's. The files go under `<BTC_CURVE_DATA_DIR>/sports` and follow
`BTC_CURVE_RETAIN_DAYS` unless `SPORTS_VENUES_RETAIN_DAYS` is set. `/healthz` on the curve
service carries a `sports` block: `warm`, `at`, `games`, `cycles`, `historyPoints`,
`windowHours`, `reload`, `venuesNotAnswering`, `venueNotes` (a venue that answered but left
games off, and why), `listed` (games each venue is on in the latest snapshot), `lastError`,
`holderCount` (snapshots counted in §5, since when, the last one, and a note if its file could not be used), `tape` (games being recorded and their trades, games closed, how many with a result, how many were copied in from the code, the last pass, and any fault in words), `data` (the same block as above for
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
- No polymarket.com (offshore; not a venue for a CFTC-only trader), no aggregator feed, no venue
  that needs an account or a key to read.
- No depth beyond the best level. A cross or a saving is shown at that size.
- No placement, no credentials, no account state.
