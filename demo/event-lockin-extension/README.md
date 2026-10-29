# Atticus Earn & Protect: Lock in (browser extension)

One extension, three venues, each in its own skin:

| Venue | Page it draws on | How the venue says a play | Skin |
| --- | --- | --- | --- |
| ProphetX (`prophetx.co`) | **My Trades**, Resting / Filled / Settled | cost, price as the implied chance or American odds, payout | near-black, the venue's green |
| Kalshi (`kalshi.com`) | **Portfolio**, Positions / Orders / History | Yes or No on a club, N contracts at a price in cents | white, near-black type, the venue's green |
| Novig (`novig.com`, `novig.us`) | **Portfolio**, Active / Settled | one card per order: code and multiplier (GB · 1.54x), Winner, MATCHED, Amount and To Pay | black, dark-grey cards, the venue's blue |

The host name picks the venue. It sets the colours (CSS variables on every block we draw), the
words ("play", "position", "order") and the reading rules below. Everything else is the same
code: the line, the panel, the lock, the receipt.

Before the trade, two quiet things and no more (each can be turned off in Options):

- one **"Lock in" pill** per game the service can lock in right now, on the game list and the
  game page: a filled shield and "Lock in · until 7:35pm ET", in a neutral place on the game's
  card (after its title, else after its time line, else on a line of its own at the foot). The
  service decides which games: `markets[].protectable` is true from seven days out until 45
  minutes before kickoff, for a paired game with odds in range and no lock on it yet. A game under
  way, or about to start, gets no pill. The page is read only to find each game's card (the block
  naming both clubs), so there is one pill per game, never one per team. Hover or tap the pill
  and our own card opens at once, in the skin ("Protection on this game can be locked in from
  Portfolio after your pick fills, until 7:35pm ET (45 minutes before kickoff)."; tip-off on a
  basketball game, first pitch on a baseball game); not a browser
  tooltip, so no delay and no question-mark cursor. The pill swallows its own click so the
  venue's row does not open; a venue that redraws its list gets the same pill back in the same
  place, with an open card moving to it;
- the **same pill in the order slip**, as one line, once a Winner pick on a protectable game sits
  in it: "Lock in available after this is matched · until 7:35pm ET · from Portfolio". No
  figures: the stake typed into a page we do not control is not read; the price is quoted on
  the plays page once the play fills, at the size that filled. Spread and Total picks get no
  line. On Kalshi a **No** pick adds "your No is a pick on the Seahawks".

The holder places the play exactly as they do today. The offer itself is on one page, the list
of open plays. Once a matched play exists, under its row:

1. a **Lock in** line that is the badge: the filled shield and "Lock in" in a pill, then one
   sentence in the row's own type, "Lose, and still get $14.71." Priced live from the holder's
   actual size. One number on the line; the rest is one tap away;
2. tapping it (the chevron at the right end turns) opens an **inline panel** under that row (the
   rows below move down; nothing floats over the slip): the same box grows, no card inside a
   card, never wider than 680px. The panel is a slip, three rows with dividers in the venue's
   type size: "Texans win $25.06 · was $46.00", "Texans lose $14.71 · was $0" (the floor, the one
   coloured figure), "Paid to you now +$1.66 · today". Above them, only when the book funds more
   than one shape, the price shapes offered right now (**Most now** / **Even** / **Keep more
   upside**; a heavy favourite usually gets one or two). Under them the button, the badge grown to
   the row's width, reading just "Lock in"; then one fine-print line, "Priced live · until kickoff
   Sun 1:00pm ET · how it works", and the disclosure. Nothing in the panel is under 12px. Tapping
   the line again closes it;
3. after the tap, the line fills solid for a beat and settles as a **Protected** pill with "$14.71
   or $25.06, whichever way it goes." Its panel is the same slip with the locked numbers and no
   button ("Texans win $25.06", "Texans lose $14.71", "Paid to you +$1.66"), then one grey line of
   facts ("Locked Sun 11:02am ET · the other side bought in 4.9s") ending in a **receipt** link.
   Tapping it opens four labelled lines in place: the other side ("19.17 contracts No on Kalshi at
   27.4c each with fees"; on any other book, "the other side on Novig"), the cost, the venue's
   order id and time with how the order got there ("through the aggregator" when it went through
   the execution pod, "direct" on our own key; the partner is never named), and the record id; a
   hedge that did not reach the venue reads "covered at the book" with no order line. Under those,
   **Hedged on** names the venue the other side went to and why ("Kalshi · the venue the hedge can
   be sent to tonight…", or "Polymarket · +109 bps all in against +533 bps on Kalshi's own No
   side"), and **If the game** lists the four tails in this venue's own settlement words: a tie, a
   postponement past the venue's window, a game called off, a corrected result, each with what the
   venue pays and how the protection settles on it. With the operator setting on, every route the
   service priced follows with its cost all in (the books plus the tails). The public record link
   appears only with the operator setting on. A settled lock reads "Settled" on the
   pill, "Protected outcome $25.06." on the line, and in the panel "Texans won · you end with
   $25.06" over "Unprotected, it would have paid $46.00";
3b. the facts line of a protected play also ends in **leave early**. Tapping it opens a block
   under the slip, priced live from both books (`GET /api/shadow/unwind/quote`): "Your pick, sold
   now · 15.95 at 61c, after fees $9.45", "Protection settles −$0.57", "You end with · your $0.41
   credit kept $9.29" (the coloured figure), "Staying $6.95 or $11.90"; a **Leave early** button
   beside a quiet **Stay**; the fine print says what leaving costs against the mid and until when
   it is open (the early-close margin, 15 minutes before the start). The tap prices again
   (`POST /api/shadow/unwind`), the service writes the close with source `unwind`, and the line
   settles as **Left early** with "Ended with $9.29 · $0.57 due back." Its panel: "Left early ·
   you ended with $9.29", "Your pick, sold at 61c $9.45", "Protection settled −$0.57", "Cash $0.57
   due back", the facts ("Left Wed 8:03pm ET · leaving cost $0.73 against the mid"), the receipt
   with a **Left early** cash leg. Nothing is reversed: leaving is a new trade at live prices, the
   protection settling at today's price instead of the official result. The pick itself stays the
   holder's to sell on the venue at that price, or to keep unprotected; the extension never trades.
   The other side is sold back through the same executor that bought it: on an armed ticker with
   sending on, a Kalshi order at or over the walked worst bid (immediate or cancel), the close
   written at what the venue paid, the facts line adding "the other side sold on Kalshi" and the
   receipt a **Sold back** row (contracts, price after fees, proceeds, order). Where the rails hold
   it (dry run, kill switch, not armed) or the hedge sits on Polymarket, the sale is recorded at
   the book's price (`hedgeSent: false`), the facts say "the other side's sale is on the record",
   and the operator sells by hand.
   Too close to the start, or once settled or already left, the block says so and offers Back;
4. a play protection does not cover gets a muted **Unavailable** pill with the reason after it:
   "Protection covers Moneyline picks." on a spread or total, "Protection waits until the play is
   matched." on a play that is still an open order, or the live refusal from pricing. Tapping it
   says what to do.

That placement is the only staged pixel. Everything behind the tap is the Atticus event service:
the play is matched to its market, priced from live books at the holder's size, the terms lock,
the record is written, and the hedge is bought on Kalshi.

Styled in each venue's own theme, with no brand of ours up top; our name is one line at the foot
of the panel. Every quote and lock names the page's venue (`venue=prophetx|kalshi|novig`), and the
service routes the hedge against that venue's settlement rules: for each book that can take the
other side it checks, branch by branch (tie, postponed, called off, corrected), that the hedge
pays at least what the holder is owed under their own venue's rules, prices any mismatch as a
tail charge in the same bps as the EV cost, applies the hard gates (same game, depth for the
whole size, venue open until the lock, an order rail that can reach it tonight) and takes the
cheapest all in. The receipt says where the hedge went and why, and words the tails in the
holder's venue's own rules. The offer's fine print adds "other side on Polymarket" when the hedge
venue is not the page's own.

> Disclosure line, shown on every panel and to be read in any published recording (the marker
> and the slip line are a notice that protection exists; nothing is offered until the play fills):
> *"Third-party protection by Atticus, rendered here for this demo; not a product of this venue.
> Pricing, record and hedge are live."*

What this extension holds: the service URL and a lock key. What it never holds: a venue login,
a venue API key, a Kalshi key, or anything that can move money. The venue's own session is never
read or used. The Kalshi API key and the venue API key live in the service's environment only.

## Matched, partially matched, unmatched

On this venue a play rests as an order until another account takes the other side. My Trades splits
them into tabs, **Resting** (orders), **Filled** (positions) and **Settled**; the extension reads
which tab is open and treats the three states differently:

- **Matched**: a position. Priced and lockable.
- **Partially matched**: the matched part is the position. Sized on it (the service reports the
  matched stake; the page reader scales To Gain to the matched share). The rest is still an order.
- **Unmatched**: an order, not a position. Muted line, "waits until the play is matched"; the
  tap explains. Nothing is priced, nothing can be locked. For the recording, place the play as a
  **Market Order** (the slip's default) so it matches at once.

Rows in the venue's points mode (play money) are never drawn on: Prophet Points on ProphetX,
Novig Points on Novig.

### Kalshi

A Kalshi position is **Yes** or **No** on one club, N contracts at an average price in cents.
Those are our units already: N contracts at 59¢ cost $5.90 and pay $10.00. The reader takes the
contract count and the cents price off the row ("10 contracts · Avg 59¢"), or the cents price and
the cost. Kalshi sells fractional contracts ("15.95 shares"); the fraction is kept and the whole
position is covered, so a $15.95 payout is protected as $15.95, never 15 contracts and an odd 95
cents left out. A **No** on a club is read as a **Yes on the other club of the same game**, which is the
market the service protects: "No · DAL Cowboys, 15 contracts at 32¢" becomes 15 contracts of
Philadelphia at 32¢, and the panel says "your No on the Cowboys" so the holder knows which row
it means. Spread markets ("...: Spread") get the muted line. The Portfolio page's tabs are read:
**Positions** are filled, **Orders** are resting ("waits until the order fills"), **History** is
settled.

### Novig

A Novig order is a Winner, Spread or Total at a decimal multiplier. **Take** fills now at the
best price; **Make** rests until another account takes it, and the card says **UNMATCHED** until
then (muted line, "waits until the order is matched"). The Portfolio (Oct 2026) is a deck of
cards, one per order, laid out side by side: the pick's code and multiplier ("GB · 1.54x"),
"Winner" under it, a MATCHED badge, **Amount** and **To Pay** ("$5.00", "$7.69"), the matchup with
its start ("CAR · 9:15 PM Thu · GB"), **Sell** at the live price and **Buy More**, then Share, the
order id and when it was placed. The reader takes Amount as the stake and To Pay as the payout
(To Pay is the venue's own figure, a cent or so off the rounded multiplier, and it is the figure
that is covered); the pick is the club the card names twice (header and matchup). The page is
React Native Web: every run of text sits in its own view with nothing between, which the reader
spaces out before reading ("GB·1.54xWinnerMATCHEDAmount$5.00..."). Because the cards sit side
by side, our block goes **inside** the card as its last row, not after it, where it would land
beside the card or after the whole deck. Spread and Total cards get the muted line ("covers
Winner picks"). Tabs: **Active** and **Settled**. The stand-in `preview/novig.html#/portfolio`
is built to this layout from a saved screenshot of a real order (GB at 1.54x, $5.00 to pay
$7.69, Thu 9:15 PM); the first thing to do on the live page is confirm it reads the same.

## Where the size comes from

Two sources, in this order:

1. **The service, from the venue's API** (preferred). With the venue's API key pair in the
   service env, the service logs in, lists the account's open plays (stake, matched stake, odds,
   market, outcome) and matches each to our ticker, returning contracts, entry price, stake and
   payout. The extension pairs that with the row on the page by team name and amounts. Nothing is
   guessed.
2. **The page**, when the service has no key or has not heard of the play yet. My Trades is a
   table: the row's figures sit under the column headers Cost, Price and Payout, so the reader pairs
   each cell with its header ("$20.00", "74.68%", "$26.78"); a row that labels its own figures
   ("Cost $20.00", "To Gain $6.78") or shows a price as American odds (-300) is read too. One $1
   contract per payout dollar, to the hundredth, entry price is cost over payout. The panel then
   says "read from the page". If nothing can be read, the line offers "Price it" with a payout box.

Prices become our units like this: $20 at 74.68% pays $26.78, which is 26.78 contracts at an entry
of 75 cents. $5 at 25.5% (+292) pays $19.60: 19.60 contracts at 26 cents. Kalshi's own fractions
(15.95 contracts) are the same unit. The whole position is covered, so the slip's figures are the
venue's figures to the cent; a per-contract price times a fractional size rounds the way the
service rounds (a payout line half up, the handback down). The two sources agree to the cent on the
preview board; the page is enough for the recording, the service confirms it when the key pair is
set.

## See it before any deposit or trade (the simulations)

No venue account is needed. Three stand-in boards, one per venue, in that venue's conventions
and colours; the extension treats each exactly as it treats the real site (the board names its
venue in a `<meta name="ael-venue">` tag, since it is served from localhost).

1. Load the extension (below) and set the service URL and lock key in its options.
2. Serve the preview pages **from this folder**, then open the venue you want:

   ```
   cd event-lockin-extension && python3 -m http.server 8812 --bind 127.0.0.1

   open http://127.0.0.1:8812/preview/positions.html#/my-trades    # ProphetX: My Trades
   open http://127.0.0.1:8812/preview/kalshi.html#/portfolio        # Kalshi: Portfolio
   open http://127.0.0.1:8812/preview/novig.html#/portfolio         # Novig: Portfolio
   ```

   If you started the server one folder up, the addresses begin with
   `http://127.0.0.1:8812/event-lockin-extension/preview/...`; a 404 means the server's folder
   and the address do not match.

   **Kalshi board**: an NFL list with this week's games (KC Chiefs vs SEA Seahawks, DAL Cowboys
   vs PHI Eagles, and so on), a market page with Yes/No at a price in cents and an order panel
   in contracts, and a Portfolio with Positions (Yes SEA 10 contracts at 59¢; **No DAL** 15 at
   32¢, which the extension reads as the Eagles; Yes DEN 20 at 80¢; a Spread position), Orders
   (a resting Yes GB at 40¢) and History (a settled play from last week). Placing an order on
   the market page adds a position.

   **Novig board**: the Pro FB list with Spread / Total / Winner at multipliers, an Order Slip with
   Take / Make and the payout net of the fee, the Points toggle, and a Portfolio with Open (SEA
   Winner 1.71x $20 Take, matched; PHI Winner 1.44x; a KC +3.5 Spread; a KC Winner **Make** at
   2.50x still Unmatched) and Settled. Placing a Take adds a matched order; a Make adds an
   unmatched one.

   Both boards name this week's games, so the real service lists them and prices them. Change
   the games in the `GAMES` table at the top of each file when the week turns.

   The board is a generic exchange-style page in the venue's conventions: prices as the implied
   chance (75.9%), a Moneyline market, a Market Order slip with Cost and To Gain, a Cash / Points
   toggle, and a My Trades table (Market, Type, Event/Date, Cost, Price, Payout, Ref ID/Placed)
   under Resting / Filled / Settled tabs: Texans Moneyline 43.5% $20, 49ers 78.1% $20, Colts -6.5
   Spread $10, Titans 25.5% $5, a Bills play filled $10 of $20 (the rest on Resting), a Chiefs
   order still resting, a Broncos row that names the team by code only, and so on. Placing a
   trade on the slip adds a filled row to My Trades,
   which is where the extension draws. Prices come from live books; a lock writes to the record
   and runs the hedge path for real (dry run unless the service is set to send). Lock only games
   you mean to put on the record.

## Files

- `manifest.json` runs the content script on the three venues' domains (edit `matches` to add one)
  and on the local preview pages; grants fetch to the service host and to localhost on any port.
  `node pack.mjs` writes the production build to `dist/` with the local matches and permissions
  stripped and the previews left out (see Production build).
- `content.js` picks the venue from the host name (`VENUES`), decides it is on the plays page (URL
  or heading) and which tab is open, finds play rows by text (a team the service can protect, by
  nickname or by code, plus the row's money), reads the size from the table's columns, the row's
  labels, or Kalshi's contracts and cents, flips a Kalshi No to the other club's market, inserts
  our block as a sibling after the row (a full-width table row when the row is one) with the
  venue's skin class on it, and re-inserts it when the venue re-renders. Off the plays page it
  finds each game's card (`findGames`: from a club's name, the block naming both clubs of exactly
  one game, grown to the card with its time line; a title the venue cuts with an ellipsis, as in
  ProphetX's sidebar and "most active" rail, is a list entry and gets nothing; when no card can
  be told apart the pill goes beside the first club named; a block's words are read with a space
  between its text nodes, since a React Native Web page such as Novig's puts a view, not a space,
  between a club's code, its name and its record), puts one pill on each card the
  service says is protectable (`markGames`, keyed by game so a redraw keeps it; the hover card is
  `showTip`; a pill the page gives no room to, inside a line that cuts its text, moves out of
  that line or to its own line at the card's foot), and the one line in the slip (`findSlip`: the block with the venue's place-order
  button, the pick named most in it; no stake is read). A club listed twice in the window (this
  Sunday and next) is settled by the date on the line, else by the game whose page this is, else
  by the club's next game; a line that prints a game day names the game on that day or none, so
  a row dated three weeks back is never read as a pick on the club's next game. The same two
  clubs listed twice (a back-to-back, a home-and-home) are told apart by the card's own words
  (`settleStems`: a date, a weekday, "today" or a clock time, "tomorrow", or a game under way,
  which is the earlier of the two); words that fit both leave the card unmarked, and one listing
  under a day that is not its own ("Dec 25" over this week's two clubs) is not it either. A board
  that prints no nicknames at all (Novig's Pro BB (M) cards: "BKN BKN at 0-3 BOS BOS 1-1") names
  its games by the matchup line (`MATCHUP_RE`: two listed codes joined by "at", "vs" or "@", a
  record or a second spelling of a code between), and a bare listed code is the way into such a
  card; codes alone with no matchup word (a score strip) still name nothing. A time line printed
  as sibling cells ("Today" | "8:05 PM") takes the pill after its last cell. A row or slip
  whose pick is a club the service lists no game for (`unlistedPick`, over every club the tables
  know) gets nothing, never its opponent's next game. Once per page view it posts the anonymous counts
  (`sendTelemetry`). The venue's DOM is never modified; our pills and line are added beside it.
- `content.css` the line (a pill and a sentence), the inline panel (the slip: rows with
  dividers, the button, the fine print), the segmented control, the receipt. Every colour is a
  variable with the ProphetX values as defaults; `.ael-v-kalshi` and `.ael-v-novig` override them.
  Nothing under 12px; one border around the line and its open panel.
- `background.js` is the fetch proxy; it attaches `x-lock-key` from extension storage.
- `options.html` sets the service URL, lock key, Rehearsal, the two before-the-trade items
  (pill, slip line), the anonymous counts, and the operator-only hedge line.
- `preview/positions.html`, `preview/kalshi.html`, `preview/novig.html` are the stand-in boards;
  `preview/fixtures/` takes saved copies of the real pages (its README says how; not committed).
- `pack.mjs` builds `dist/lock-in-<version>/` and `.zip` for the store. `PRIVACY.md` is the
  privacy policy the store listing links to; it ships inside the build.

## What the service decides, and what it hears back

The extension draws; the service decides. Two things ride with `GET /api/shadow/markets`:

- each market's `startIso`, `protectable`, `protectableUntilIso` and, when not protectable, why
  (`in_progress`, `too_close`, `far_out`, `unpaired`, `mark_out_of_range`, `on_record`). The
  window is one rule for the board, the quote and the pill: `PROTECT_WINDOW_MINUTES` in
  `eventProtectXDemoService.ts`, 45 minutes to 7 days before kickoff;
- `ext`: the switches. `minVersion` (env `EVENT_SHADOW_EXT_MIN_VERSION`): an extension below it
  draws nothing but a notice to update, on every page. `marksOff` (env
  `EVENT_SHADOW_EXT_MARKS_OFF`, comma list of `prophetx,kalshi,novig`): the pills and slip line
  are off on those venues until the switch is cleared, with no new build. `cutoffMinutes`.

When the markets call fails, the notice at the bottom left says why. The service sleeps between
demos and takes up to a minute to wake, and a fresh tab's first call is the one that finds it
asleep: the call is retried at 3s, 8s, 20s and 45s ("Lock in: waking the service…") before the
five-minute poll takes over, and only once those are spent does the notice say unreachable, with
the HTTP status or the error in brackets. A reload of the extension (Load unpacked again, an
update) invalidates the script already running in open tabs; that case is told apart and the
notice says "Lock in was updated. Reload this page." rather than retrying forever. A 403 is the
lock key ("missing or wrong"), a 404 a service with no lock routes.

A service deployed from a build before these fields (markets rows without `protectable`, no `ext`)
still draws: the pill goes on every listed game not already on the record, as 0.6 did, with no
"until" on it, and no telemetry is posted. The service's deploy and the extension's update are
two steps and may land in either order.

Once per page view, the extension posts `POST /api/shadow/ext-telemetry` (lock key): venue, kind
of page (`board`, `game`, `plays`, `other`), extension version, and whole-number counts (markets
listed, protectable, games found, pills drawn, slip seen, slip marked, rows read, offers shown,
rows unread). Fixed vocabularies only; anything else is refused with 400, and no page text or
amount is accepted. `GET /api/shadow/ext-telemetry/summary?token=...` (operator) shows totals
per venue and the last rows, so what drew on a live venue is seen without a screenshot. Off in
Options for anyone who prefers.

## Production build

```
cd demo/event-lockin-extension && node pack.mjs
```

writes `dist/lock-in-<version>/` and `dist/lock-in-<version>.zip`: the same files, `manifest.json`
without the `127.0.0.1` / `localhost` matches and permissions, no previews, `PRIVACY.md` inside.
Upload the zip to the Chrome Web Store developer dashboard; link `PRIVACY.md` (host it on the
service or the site) in the listing's privacy field. Before uploading: bump `version` in
`manifest.json`, set `EVENT_SHADOW_EXT_MIN_VERSION` on the service to the oldest build whose
reading still matches the venues, and keep `EVENT_SHADOW_EXT_MARKS_OFF` at hand for a venue that
changes its page under us.

Words: "protection" and "lock in", never "insurance" or "guarantee"; the cutoff is stated where
the pill is ("until 7:35pm ET"), since that is the first question. The pre-trade line carries no
price on purpose: the quote at placement is the one that binds.

## Service side (Render dashboard, never in git)

The lock routes are off until a key is set.

| Env | Value | Why |
| --- | --- | --- |
| `EVENT_SHADOW_LOCK_KEY` | 12+ random chars | Opens `/api/shadow/markets`, `/api/shadow/quote`, `/api/shadow/positions`, `/api/shadow/lock`, `/api/shadow/receipt`, `/api/shadow/unwind/quote`, `/api/shadow/unwind` to callers with `x-lock-key`. Unset answers 404. |
| `EVENT_HEDGE_STRATEGY` | `live` | Real Kalshi orders behind rails. Anything the rails hold is simulated at the book, reason on the receipt. |
| `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PEM` | from Kalshi | Service only. |
| `EVENT_HEDGE_LIVE_TICKERS` | the one ticker you will tap | Allowlist. Empty allows nothing. Listed tickers are hedged on Kalshi's own No side and skipped by the hourly scan. |
| `EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_ORDER` | `25` | Per-order cap. |
| `EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_DAY` | `20` for the first live test, then `100` | Per-day cap, counted from the receipt file, so a restart cannot reset it. |
| `EVENT_SHADOW_LOCK_LEDGER_PATH` | leave unset | Locks live in `lock-ledger.jsonl` beside the scan's ledger on the same disk. |
| `EVENT_HEDGE_LIVE_SEND` | `yes` | The only value that sends. Anything else is a dry run. |
| `EVENT_HEDGE_KILL_SWITCH` | `1` to stop | Nothing leaves, whatever else is set. |
| `EVENT_SHADOW_EXT_MIN_VERSION` | e.g. `0.7.0` | Extensions below it draw nothing but "update the extension". Unset: every build draws. |
| `EVENT_SHADOW_EXT_MARKS_OFF` | e.g. `novig` | Venues (comma list) whose pills and slip line are off, with no new build. The plays page keeps its offers. |

### Holder plays from the venue (optional, recommended for the recording)

**Not needed for the recording**: without it the extension reads each row's Cost and To Gain
from the page and the numbers are the same. It is a confirmation, not a dependency.

The venue issues API keys from its website: the **menu (top right), API Integration**, create a
token. You get an access key and a secret key; the secret is shown once. Trading API access may
first need an access request approved by the venue (their docs: Requesting API Access). Note what
the keys are: **account keys**. The venue has no read-only
scope, so the same pair could place a play. The service only ever calls login, refresh and four
read routes (open plays, tournaments, events, markets); nothing in it submits or cancels. Still:

- make a **dedicated pair** for the service, named so you know what it is;
- put it in the **Render env only**, never in the extension, never in chat, a ticket or a commit;
- **revoke it** on the website when the recording is done.

| Env | Value |
| --- | --- |
| `VENUE_API_HOST` | the venue's partner API base, with the partner path: production `https://cash.api.<venue domain>/partner`, sandbox `https://api.sandbox.<venue dev domain>/partner` |
| `VENUE_API_ACCESS_KEY` | the access key from the pair |
| `VENUE_API_SECRET_KEY` | the secret key from the pair |
| `EVENT_SHADOW_POSITIONS_TTL_MS` | `20000` (one read reused for 20 seconds) |

The service logs in once, keeps the session alive (the access token lasts about ten minutes and is
refreshed a minute before it lapses; the refresh token lasts three days; a refused refresh logs in
again), and caches the catalog for ten minutes.

Check it from your machine before recording (it prints each open play with its matched stake in
our units and the game and side as the venue names them, or "unmatched"):

```
cd services/api
VENUE_API_HOST=https://cash.api.<venue domain>/partner VENUE_API_ACCESS_KEY=... VENUE_API_SECRET_KEY=... \
  npx tsx scripts/venueReadKey.ts check
```

`GET /healthz` on the service (operator token) shows `lock.holderPositions.configured: true` and
`api: "bearer"` once the pair is set. Unset, the extension reads sizes from the page.

The service also still speaks the signed read-key API of the previous venue
(`VENUE_API_KEY_ID` + `VENUE_API_PRIVATE_KEY_PEM`, minted with `venueReadKey.ts mint`). Whichever
pair of variables is set picks the API; set one, not both.

Pre-flight (operator token):

```
GET /api/shadow/hedges/preflight?scan=1&contracts=26        every game the Kalshi route is offered on right now, with terms
GET /api/shadow/hedges/preflight?ticker=KX...&contracts=26  balance, rails, this game's terms on that route, wouldSend
GET /healthz                                                lock.enabled true, hedge.live.dryRun false, allowlist shows the ticker
```

## Extension setup

1. Chrome, `chrome://extensions`, enable Developer mode, Load unpacked, pick this folder.
2. Open the extension's options. Set the service URL (default is the record service) and paste the
   lock key. Leave "show hedge line" off for a customer-facing recording; turn it on for the
   operator cut.
   **Rehearsal** (same page): with it On, the Lock in button walks the whole flow on the live
   quote, but calls nothing: nothing is locked, written or bought. The line reads Protected with
   "rehearsal" on it and the panel offers Reset. Use it to see the screens before real money, then
   turn it Off and reload the venue tab before the recording.
3. On the venue, open the plays page: ProphetX **My Trades** (Cash mode, **Filled** tab), Kalshi
   **Portfolio** (**Positions** tab), Novig **Portfolio** (**Open** tab, cash not points). Each
   matched play gets its line; a resting order's line says it has not matched or filled. If the
   extension cannot find the rows but the service knows your plays, a card bottom-right lists
   them with the same lines.

Operator actions (token in `x-admin-token`), for the recording day:

| Call | What it does |
| --- | --- |
| `GET /api/shadow/hedges/preflight?ticker=KX...&contracts=N` | Balance, rails, and whether the tap would be offered and sent. Reads only. |
| `POST /api/shadow/hedges/resend?ticker=KX...` | Hedges an open lock again when its hedge never reached the venue (simulated fill on the trail). Refuses once a live fill exists unless `&force=1`. |
| `POST /api/shadow/lock/reset?ticker=KX...` | Takes one lock off the record (its lines move to an archive beside the ledger) so the market can be locked again; the row goes back to the offer on the next poll. Names any live fill the venue still holds for the old lock, which is yours to sell or keep. |
| `GET /api/shadow/hedges` | The hedge trail: every receipt, order ids, fills, reasons. Each live fill says `via`: `direct` (our own venue key) or `aggregator` (the execution pod). |
| `GET /holders?token=...` | One page per holder key: their locks, what is owed each way, and the `POST /api/shadow/cash` line to record a payment. The JSON is `GET /api/shadow/holders`. |

## Test steps (five minutes, no money)

1. Open the preview My Trades with the extension loaded. Every row has a line under it: Lock in
   with the floor ("Lose, and still get $x."), Unavailable with a reason, or Protected.
2. Tap a Lock in line. The panel opens under that row; the rows below move down. Tap **Keep more
   upside** or **Most now**: the three rows reprice. Tap **Even**: they return.
   Only the shapes the book offers for that pick are listed; a heavy favourite often has one.
3. Tap **Lock in**. The button reports the stages in words (Pricing from the live book, Writing
   the record, Buying the other side) under a slow sheen, with whole seconds only past three; the
   line flashes solid and settles as the Protected pill with "$x or $y, whichever way it goes.";
   the panel is the slip with the locked numbers and the facts line with how long it took.
   Tap **receipt** at the end of the facts line: the other side, the cost, the order, the record
   id. Open `/` on the service: the position is there with `source: lock`.
   With Rehearsal on in the options, the same tap ends on a Protected line marked "rehearsal"
   with a Reset link, and nothing reaches the service.
4. Reload the page. The chip is still there (it comes from the record, not from the browser).
5. Tap the Spread row's line: "Protection covers the Moneyline market." Close it.
6. Open the **Resting** tab. The Chiefs order's line says "waits until the play is matched"; tap
   it: "This play has not been matched yet." Close it.
7. Back on **Filled**, the Bills row shows the filled $10 of a $20 order: the panel says "pays
   $14.50 if they win · you paid $10.00", the filled part only.
8. Switch the toggle to **Points**: no lines on the rows. Back to **Cash**: they return.

Before the trade, on any board:

- Open the game list: one "Lock in · until 7:35pm ET" pill per game the service can lock in,
  on the game's time line (Kalshi: after the game's title). Games under way have none. Hover a
  pill and the card opens under it at once; click it and the row does not open. The score strip
  and the futures list have no pills.
- Pick a Winner / Moneyline price: the slip shows "Lock in available after this is matched ·
  until 7:35pm ET · from Portfolio" a second later, with no figures. Pick a Spread: the line goes
  away. Pick a game under way: no line. On Kalshi, pick **No** on a club: the line names the
  other club. Open the plays page: no pills, no slip line, the rows have their offers.

Kalshi board (`kalshi.html#/portfolio`), two minutes more:

9. **Positions**: the Yes SEA row offers "Lock in · $x if the Seahawks lose"; the **No DAL** row
   offers the Eagles, and its panel says "your No on the Cowboys"; the Spread row is muted. Lock
   one; the receipt's Order line names the hedge venue and how the order got there.
10. **Orders**: the resting GB order's line says "waits until the order fills". **History**: a
    settled play from last week has no line (never locked, no longer listed).

Novig board (`novig.html#/portfolio`):

11. **Open**: SEA Winner (Take, matched) offers; the KC +3.5 Spread is muted ("covers Winner
    picks"); the KC Winner **Make** is muted ("waits until the order is matched"). Tap **Points**
    in the header: no lines. Tap it again: they return.

## Recording checklist

Three clips, one tap. Shoot on a desktop width; the panel is responsive, but the My Trades rows
are widest and clearest there.

1. **Venue, before and after the play.** The game list with the shields; pick the Winner price;
   the slip's line with the floor at that stake; place the play. Then My Trades, Filled tab,
   with the new play. Tap its Lock in line; the panel opens with the terms; tap **Lock in**.
   The line settles as Protected.
2. **Record.** `/` on the service a moment later: the position appears with `source: lock`, the
   three numbers match the panel. Operator cut: `/api/shadow/hedges` shows the live attempt, order
   id, fill, cost.
3. **Settlement.** After the game, the position's settled row on the record and, on the venue's
   Settled tab, the chip's details panel: what the holder ends with, what the play alone would
   have paid, and where the money stands ("$8.00 owed to you", then "paid in full" once the
   operator records the payment with `POST /api/shadow/cash`). Settled plays that were never
   locked read "Not protected".

Rules the service enforces, so plan the game around them:

- The lock must be at least 45 minutes before start and inside 7 days.
- One lock per Kalshi market. A second tap on the same game is refused with "already locked".
- The play must be matched. Place it as a Market Order so it fills at once; a limit order that
  rests is refused until it matches.
- The size you hold at the venue should be the size you lock. Play and hedge settle on the same
  official result.
- Protection is priced from the book. A pick the book will not pay for shows "Protection
  unavailable" with the reason; that can change toward kickoff.

## Local run

```
cd services/api
EVENT_SHADOW_LOCK_KEY=local-demo-key-123 EVENT_HEDGE_STRATEGY=live \
  EVENT_HEDGE_LIVE_TICKERS=KX... npx tsx scripts/eventShadowWorker.ts
```

Point the options page at `http://localhost:8793`. Without Kalshi keys or `EVENT_HEDGE_LIVE_SEND=yes`
the hedge is a dry run; the panel, record and receipts behave the same. Without `VENUE_API_*`
the sizes come from the page.
