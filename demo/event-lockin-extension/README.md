# Atticus Earn & Protect: Lock in (browser extension)

One extension, four venues, each in its own skin:

| Venue | Page it draws on | How the venue says a play | Skin |
| --- | --- | --- | --- |
| ProphetX (`prophetx.co`) | **My Trades**, Resting / Filled / Settled | cost, price as the implied chance or American odds, payout | near-black, the venue's green |
| Kalshi (`kalshi.com`) | **Portfolio**, Positions / Orders / History | Yes or No on a club, N contracts at a price in cents | white, near-black type, the venue's green |
| Novig (`novig.com`, `novig.us`) | **Portfolio**, Active / Settled | one card per order: code and multiplier (GB · 1.54x), Winner, MATCHED, Amount and To Pay | black, dark-grey cards, the venue's blue |
| STX (`stxapp.io`) | the **positions block** (our card), on every page of the venue; the page itself is not read | the member's own account, read by the service once the member connects it; N contracts at a price in dollars | near-black, dark-grey panels, the venue's amber |

The host name picks the venue. It sets the colours (CSS variables on every block we draw), the
words ("play", "position", "order") and the reading rules below. Everything else is the same
code: the line, the panel, the lock, the receipt. STX is the one **member venue**: the holder
connects their own STX account to the service once (the venue's own consent screen), the
positions come from that account rather than from the page, and the lock is the holder's own
partial sale into STX's book, in their own account, with nothing hedged anywhere (see **STX**
below).

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
   than one shape, the price shapes offered right now (**Max upside** / **Balanced** / **Max
   floor**, each with its floor, its upside and the cash now: "Floor $0.71 · Upside $9.30 · +$0.21
   now"; a heavy favourite usually gets one or two). Max upside is first and pre-selected: it is
   the shape the service heads the quote with (0.7.30, see "Which shape comes first" below).
   Under them the button, the badge grown to
   the row's width, reading just "Lock in"; then one fine-print line, "Priced live · until kickoff
   Sun 1:00pm ET · how it works", and the disclosure. Nothing in the panel is under 12px. Tapping
   the line again closes it;
3. after the tap, the line fills solid for a beat and settles as a **Protected** pill with "$14.71
   or $25.06 · on ProphetX." (the hedge venue on the line itself; "whichever way it goes" when the
   record carries no routing). Its panel is the same slip with the locked numbers and no
   button ("Texans win $25.06", "Texans lose $14.71", "Paid to you +$1.66"), then one grey line of
   facts ("Locked Sun 11:02am ET · the other side bought in 4.9s") ending in a **receipt** link.
   Tapping it opens four labelled lines in place: the other side ("19.17 contracts No on Kalshi at
   27.4c each with fees"; on any other book, "the other side on Novig"), the cost, the venue's
   order id and time with how the order got there ("through the aggregator" when it went through
   the execution pod, "direct" on our own key; the partner is never named), and the record id; a
   hedge that did not reach the venue reads "priced at ProphetX's book" with an **Order** line
   that says "not sent; covered at the book" (the operator setting adds the rail or fallback that
   held it: "rail ticker: … is not on the live allowlist"). Under those, **Hedged on** names the
   venue the other side went to ("ProphetX", "Kalshi"); the reason ("cheaper all in…", "the venue
   the hedge can be sent to tonight…") follows only with the operator setting on. When two venues
   priced the other side, **Compared** shows the competition as chips, one per venue with what
   its book would have paid for the same protection, the winner filled in the venue's accent with
   the shield, and the edge in dollars ("$0.60 more for you") (0.7.20). **Rules** is a toggle in
   the label column (the same chevron toggle as Details) with the four cases beside it while
   folded ("tie · postponement · called off · corrected result"); open, it is a grid, one case a
   row, "If the game… ends in a tie → Novig pays each side $0.50 · the protection settles on that
   $0.50", read from the routing's rule cells (the treatment per branch); the venue's own
   sentence is the row's tooltip (0.7.32). **Terms** follows: the rule text the record pinned at
   the lock and when, linked to the venue's own page, the sha256 in the tooltip. On Kalshi the pin
   is the market's own text ("pinned Fri 7:12pm ET · checked again at settlement"). On ProphetX
   and Novig, venues with no per-market text, the pin is the holder's venue's published rules
   for the league: the four sentences the Rules grid shows, hashed, with the venue's page and the
   day they were read ("ProphetX rules read Oct 28 · the sentences under Rules; checked again at
   settlement") (0.7.33; the service keeps Kalshi's market text as a second, reference pin on the
   record). A pin of another venue's text names it ("Kalshi's rules pinned…"). After settlement
   it reads "held · read at the lock and again at settlement, same words" or "venue edited its
   rules". The service
   sends it on the tap's answer and on `/api/shadow/receipt` as `rule` (venue, sourceUrl,
   readAtIso, sha256, state, and after settlement checkedAtIso and unchanged; never the text).
   With the operator setting on, the record id and every route the service priced follow, each
   with its cost all in (the books plus the tails) and what it would have paid. The
   public record link
   appears only with the operator setting on. A settled lock reads "Settled" on the
   pill, "Protected outcome $25.06." on the line, and in the panel "Texans won · you end with
   $25.06" over "Unprotected, it would have paid $46.00";
3b. a protected play's open panel ends in a quiet **Leave early** button under the slip, with
   "remove the protection, keep your pick" beside it. Tapping it opens a block under the slip,
   priced live from both books (`GET /api/shadow/unwind/quote`), two rows (0.7.25): "Protection
   settles" with one signed figure and the why in grey ("−$0.57 due back · your pick moved up, so
   the upside you sold is worth more now"; "+$0.41 to you · your pick moved down, so the floor you
   hold is worth more now"), and "Staying $6.95 or $11.90"; a **Leave early** button beside a quiet
   **Stay**; the fine print says it is priced live and until when (the early-close margin, 15
   minutes before the start), that the pick stays open on the venue unprotected, and that the
   credit paid at the lock is theirs with this settlement separate. The tap prices again
   (`POST /api/shadow/unwind`), the service writes the close with source `unwind`, and the line
   settles as **Protection removed** with "−$0.57 due back." (or "+$0.41 to you · on its way."). Its
   panel: "Protection removed · settled −$0.57", "Your pick open on Novig, unprotected", "Cash $0.57
   due back", the facts ("Removed Wed 8:03pm ET"), the receipt with a **Protection removed** cash
   leg. What crossing the books cost against the mid appears only with the operator setting on.
   Nothing is reversed: leaving is a new trade at live prices, the protection alone settling at
   today's price instead of the official result. When the pick is up that settlement is usually a
   charge, because the upside sold at the lock is worth more now; the sheet says so before the tap.
   The pick itself is never touched; the extension never trades. Once the service frees a market
   left early (`onRecord` false on the market), the row goes back to the **Lock in** offer at the
   live quote, with one grey line under the button, "Earlier protection removed Thu 7:58pm ET ·
   −$0.57 due back." (0.7.26); the removed lock stays on the record and the new lock is its next
   generation. A service that still holds the market keeps the row on Protection removed.
   **Which club is the pick** (0.7.27): when the service reads the holder's account on the venue
   (`/api/shadow/positions` answers `configured: true`), the venue's own word on what they hold
   decides the side of a card before anything printed on it; a card that prints both clubs and
   no pick line (Novig's Active card, "CLE … ATL") is read by the position, never by which club's
   letters appear more often. A row the venue says is the other club draws no offer, and the
   service refuses such a lock with `wrong_side` ("Your pick on this game is Cleveland Cavaliers;
   protect it from that card."). Without the read key the card's text alone decides, as before.
   The size follows the same rule (0.7.28, 0.7.29): a position the venue confirms is sized from
   it (contracts, entry, cost, payout) and keeps that size through every redraw of the page and
   through a read of the account that misses it (the service itself carries a position's market
   over a lookup the venue failed), whatever the card's figures read as on a later pass. A page
   that names the same play in two places draws one block, quoted once, from the row the venue
   sized. A figure read from the page's words that cannot be a position on the market (a price
   under a cent, a payout out of all proportion to the multiplier the row prints) is set aside
   rather than offered. A venue's reference for the play ("ID: a49b5764ac7c") is never read as
   a figure. The tiers share the row's width, two or three of them, and a tier's credit drops to
   a second line rather than being cut off.

   **Which shape comes first** (0.7.30, with the service). At the hedge price a collar is
   even-money: every cent of floor costs about a cent of cap, and the credit is cap the holder
   did not keep. So the service now heads the quote with the most upside (`EVENT_X_DEFAULT_TIER`
   defaults to `wide`; the extension pre-selects whatever tier heads the quote rather than
   Balanced), the search grid reaches 45¢ either side of the mark instead of 30 under and 25 over
   (`EVENT_X_FLOOR_OFFSETS`, `EVENT_X_CAP_OFFSETS`, comma lists of cents), and the absolute
   minimum credit is 5¢ (`EVENT_X_MIN_CREDIT_CENTS`; the 0.25%-of-stake line is unchanged, so
   positions over $20 are not affected by it). On a 10-contract pick at 50¢ against a 52¢ other
   side, Max upside moves from floor 20¢ / cap 70¢ to floor 5¢ / cap 90¢: lose $0.71 instead of
   $0, win $9.30 instead of $10.10. The three shapes are named for what they give (Max upside,
   Balanced, Max floor) and listed with the floor, the upside and the cash now.

   **The simple layout** (0.7.31, the default; Options → Layout → Full brings the panel above
   back for an operator demo). The open panel is three rows and one pill, nothing else in view:
   "Packers win $6.88 · of $7.69", "Packers lose $1.88 · instead of $0" (the floor, the one
   coloured figure), "Cash now +$0.42"; then a **Lock in** pill the width of its word, and at the
   right one toggle, **Details** (0.7.32: the label holds still and a chevron turns; the same
   toggle shape serves Details and Rules everywhere, in the offer, under the protected slip and
   inside the receipt). Details opens, under the pill, as five rows in one grammar (0.7.36: a dim
   label on the left, the value on the right, one type size, two tones): **Shape**, a segmented
   control (Max upside / Balanced / Max floor, only when the book funds more than one shape; a
   tap repaints the three rows and the collapsed line with that shape's figures, and the pressed
   one is what the tap locks); **Other side**, one sentence ("Novig · best of 2 venues, venue
   fees included · $0.11 more for you", this page's venue named with its two-word reason when it
   priced nothing; each venue's figure in the tooltip); **Until**, the clock ("tip-off Tue 8:00pm ET · priced live");
   **Rules**, the toggle with the four cases beside it while folded, the grid when open (one case
   a row, what the venue does and what the protection does); **How**, two sentences with no
   figures (the figures are the three rows above). A protected play's panel
   is the same three rows without the "of" column, the quiet **Leave early** button (its meaning
   is the leave sheet's header, not a sentence on the row), the **Details** toggle at the right,
   and the facts line in view under them ("Locked Fri 7:12pm ET · the other side bought in
   1.3s"). Details opens the receipt in place as the same grammar, five rows: **Other side**
   (the venue, the contracts and price, the competition in a dim tail, the order id and the
   rail), **Cost**, **Rules**, **Terms**, **Paid to you** (the cash legs; the record id is the
   operator's). While the book is read, the panel is one line of words ("Pricing from the live
   book…", "Pricing your exit…" in the leave sheet), not bars.
   Nothing is removed: every figure of the full layout is one tap away.
   The other side is sold back through the same executor that bought it: on an armed ticker with
   sending on, a Kalshi order at or over the walked worst bid (immediate or cancel), the close
   written at what the venue paid, the facts line adding "the other side sold on Kalshi" and the
   receipt a **Sold back** row (contracts, price after fees, proceeds, order). A hedge on ProphetX
   is not sold: the venue takes no sell order, so the service buys the pair of the other side (the
   holder's own club's strike) at or under 1 − the walked worst bid, fill or kill, which offsets
   the hedge share for share and settles when the game does; the facts say "the other side offset
   on ProphetX, settles at the game" and the receipt row reads **Offset on** (contracts of the
   pair bought, proceeds at the game, order). The holder's own numbers are the same either way:
   the protection settles between us at today's price; the timing of the writer's hedge cash is
   the writer's. Where the rails hold it (dry run, kill switch, not armed) or the hedge sits on
   Polymarket, the sale is recorded at the book's price (`hedgeSent: false`), the facts say "the
   other side's sale is on the record", and the operator sells by hand.
   Too close to the start, or once settled or already left, the block says so and offers Back;
4. a play protection does not cover gets a muted **Unavailable** pill with the reason after it:
   "Protection covers Moneyline picks." on a spread or total, "Protection waits until the play is
   matched." on a play that is still an open order, or the live refusal from pricing. Tapping it
   says what to do. A muted pill (Unavailable, or Lock in while the price is still being checked)
   carries no shield; the word sits centred (0.7.19; before it a dim outline shield read as an
   empty slot on a dark venue and pushed the word off-centre). The filled shield marks the live
   states only: Lock in with a price, Protected, Settled, Protection removed.

That placement is the only staged pixel. Everything behind the tap is the Atticus event service:
the play is matched to its market, priced from live books at the holder's size, the terms lock,
the record is written, and the hedge is bought on whichever of tonight's venues paid more for
the same protection.

Styled in each venue's own theme, with no brand of ours up top; our name is one line at the foot
of the panel. Every quote and lock names the page's venue (`venue=prophetx|kalshi|novig`), and the
service routes the hedge against that venue's settlement rules: for each book that can take the
other side it checks, branch by branch (tie, postponed, called off, corrected), that the hedge
pays at least what the holder is owed under their own venue's rules, prices any mismatch as a
tail charge in the same bps as the EV cost, applies the hard gates (same game, depth for the
whole size, venue open until the lock, an order rail that can reach it tonight) and takes the
cheapest all in. The receipt says where the hedge went and why, and words the tails in the
holder's venue's own rules. The offer shows the venue pick as its own strip between the slip and
the button (0.7.20): "Other side" followed by one chip per venue that priced it with
its credit ("ProphetX $3.10", "Kalshi $2.40"), the one the hedge goes to filled in the venue's
accent with the shield. Three chips at most (0.7.23): the venue the hedge goes to and this page's
own venue, when it is one of the books in the race, always stay, and the best of the rest fill the
places; the home venue carries no label, since the holder knows where they are, and they see it
win or see that another book paid more. On a venue that is not one of the books (the embed on a
sportsbook, say) the strip is the race alone. The label is two words and the chips are tight so three
venues sit on one row in the panel (0.7.24). With one venue priced, "Other side" and the one chip. When this page's own venue
is in the race but priced nothing, it still appears, last, as a muted dashed chip with the reason in
two words ("ProphetX · not mapped" when the aggregator has no mapping for the game there, "not
listed", "closed", else "no price"), the service's sentence in its tooltip; the holder always sees
the venue they are standing on, and the chips stay the competition, so a missing chip never reads
as a missing venue (0.7.33). The same chip sits in the receipt's **Compared** row. The fine print then keeps
only the notes; without routing it falls back to the competition line ("ProphetX $3.10 vs Kalshi
$2.40, hedged on ProphetX"), else "other side on
Polymarket" when the hedge venue is not the page's own. The venues in the race are Kalshi and
ProphetX, both reached through the aggregator's execution pod, and Novig, reached directly with
the service's own trading key (`EVENT_HEDGE_VENUES=kalshi,prophetx,novig`,
`EVENT_HEDGE_LIVE_VIA=aggregator`); ProphetX's 2% of net gains at settlement is folded into its
book before the walk, and Novig's fee (6% × P × (1 − P) per contract, charged on a game market
only once it is live) is folded in the same way, so every credit on the line is all in.

### The Novig route

Novig is a venue the holder may be sitting on and a hedge venue at once; when its book pays the
most, the HERE chip wins the race. The service reads Novig's book through the same signed
catalog read that serves the price reference (`REFERENCE_BOOK_SIGNED_HOST`, falling back to the
public catalog on `VENUE_API_HOST` when the route is offered), with both outcome ids and the
market's fee rule carried on the listing. The hedge is a buy of the **opposing** outcome, one
order, **fill or kill**, at the walked worst price snapped down to the venue's price grid (0.001
steps to 0.050, 0.005 steps to 0.950, 0.001 steps to 0.999); one of our $1 units is 100 of the
venue's one-cent contracts. The fee rule is re-read at order time, so a game that has gone live
unfolds the fee out of the limit before it is sent. Nothing rests: an order the venue leaves open
is cancelled, and a kill that filled nothing comes back as the venue's own refusal on the receipt
(the rails then record a simulated fill with the reason, as on every route). **Leave early** on a
Novig hedge is an offset: the service buys the holder's own outcome against the hedge at
1 − the walked bid, and the pair settles at the game, so the receipt says the proceeds land then,
not today. The counterfactual re-reads, the early-close quote and the venue columns on `/`
carry Novig like the other routes, and the aggregator is never named.

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
beside the card or after the whole deck. The deck is a wrapping flex row and every card in a
row is stretched to the tallest one (React Native Web's default), so a card grows when a
neighbour's panel is open, and it grows again by our own block. The reader measures a card by
its own rows, not the stretched box, and accepts a deck card up to twice a plain row's height
(640px against 320px); a card that misses one scan keeps its line for six seconds, as long as
the card is still on the page and still names the pick, before the line is taken down (before
0.7.15 a stretched card lost its Lock in button and got it back on the next scan, so the button
blinked). Spread and Total cards get the muted line ("covers
Winner picks"). The card names clubs by code only ("CLE · 7:00 PM Thu · ATL"), and a code can
name two listed games in one week (CLE is the Cavaliers on Thursday and the Browns on Sunday,
ATL the Hawks and the Falcons): the reader pairs the two codes to the one game both can mean,
and a weekday on the card settles a club's game on that day (0.7.16; before it such a card got
no line at all while a code with one listed game, GB, read fine). The card's placement stamp
("Placed: Wed 11:33PM") is not the game's day: the reader takes such stamps out before it looks
for a date or weekday, and the venue's own "Today" / "Tomorrow" on the game line is read first
(0.7.18; before it a Cavaliers card placed on a Wednesday read as the Cavaliers' Wednesday game,
already played, and got no line while the Thursday game it was on went unread). Tabs: **Active** and
**Settled**. The stand-in `preview/novig.html#/portfolio`
is built to this layout from a saved screenshot of a real order (GB at 1.54x, $5.00 to pay
$7.69, Thu 9:15 PM), with the same stretching deck; the first thing to do on the live page is
confirm it reads the same.

### STX

**The hosted page is the STX surface; this extension is optional there.** The service serves
`GET /app` (the record URL plus `/app`), a single page built for a phone in STX's own skin
(near-black, dark-grey panels, amber), with the same Lock in line, panel, Details and Leave
early as the demo embed. A member opens it, taps **Connect STX account**, signs in on STX's own
page in the same tab, approves reading their profile, balance and portfolio and placing orders
in their own account (`profile.read balance.read portfolio.read orders.read orders.write`), and
lands back on the page. Nothing to install, no lock key to paste: the page's session is a cookie
the service sets on the first visit (HttpOnly, SameSite=Lax, Secure behind https, 180 days), and
the member's holder alias is a hash of it (`m-…`), so no secret is in a ledger file name. Cookie
callers are a **member-only lane**: positions come from the connected account and never from our
own venue keys, quote and lock refuse any venue but STX (403 `member_only`), and every POST needs
the page's own `x-member-app: 1` header (a form on another site cannot send it). The page never
sees the login, the authorization code or a token: the service holds the connection (sealed on
its disk, refreshed and revoked by it).

The connect screen says what will happen before the tap: three numbered steps (sign in on STX's
own page; one Allow screen, with the five permissions listed as chips; back here with your
positions), a short **Why place orders?** note (a lock is a sell order for part of your position,
nothing else is ever placed, revocable on STX), then the one button. On return the page shows a
spinner ("Connecting your STX account…"), then a check ("STX connected · Reading your
positions…"), then the portfolio; a refusal on STX's page comes back to the same connect screen
with a red note ("STX didn't connect … Nothing is connected; your account is untouched"). On a
phone's browser (not yet on the home screen) a dismissable note under the balance says how to add
it to the home screen, for one tap back after a buy on STX.

The page is laid out like STX's own app. The top bar carries STX's mark (a link back to STX when
`MEMBER_APP_VENUE_URL` is set), our bird and the word Lock in, the member's avatar and @handle as
STX shows them, Disconnect, and a **Back to STX** pill. Three tabs, each with a count (open locks,
games listed, past locks):

- **Portfolio** mirrors the STX account. A balance strip first (**STX balance $1,250.40**, read
  from `balance.read`; it re-reads after every lock and buy-back and the figure pulses amber when
  it moves; a connection made before the scope was asked says "not shared with this page yet ·
  Reconnect to show it"; the strip says "updated 12s ago" and the words move on their own). Then
  every open long position, laid out as a row: a club mark (the club's initials on a colour of its
  own), **Boston Celtics** to win, the opponent and tip-off ("vs Los Angeles Lakers · Wed 7:30 PM
  ET"), **pays $50.00** on the right, and chips under the name (50 contracts · 30 sold · avg 42¢ ·
  Lock in until 6:45 PM). The protectable ones carry the Lock in line ("Lose, and still get
  $16.18"; when STX's book is thin it adds "· STX's book takes 20 of 30") and the tap opens the
  panel (the two outcomes, the cash row **In your STX balance now**, the Shape control, the Lock in
  pill, Details); the rest sit under **Not protectable right now** with a toned pill and plain
  words: **Too close** (inside the cutoff), **In play** (a red dot), **Parlay** (violet; "3-leg
  Combo", the picks under the name, and the tap opens the legs: each pick, its game and tip-off,
  and where it stands, Pending · Live · Hit · Missed · Void; "protection on the last open leg is
  coming"; a **9.47× payout** chip), a market or a league the service does not cover. STX's own
  combination market carries no leg list: the picks are words (`question: "Broncos, Hawks,
  Texans, Falcons"`, the description naming each with "Won", the specifier counting them) and its
  own start is the last leg's. The service reads the words and places each on the club's game in
  STX's listings (the first game after the ticket was bought, no later than a day past the
  ticket's own date), so a leg has its game, tip-off and state; a pick with no listed game stays
  a word with "Pending" beside it. STX writes a long's average premium negative (cash out), so
  the entry is read as its size. Locked positions come first, then the offers. After a lock a toast says "+$16.18 in your STX balance · 20 riding" and the Protected
  panel's meta line says the balance now.
- **Games** lists the games this service can protect that STX lists right now, by day (**Today**,
  **Tomorrow**, then the weekday; two days at a time, "Show 3 more games on later days" for the
  rest), with filters when there is more than one league and an **In your portfolio** filter when
  any are held. Each game: the league badge, the title, tip-off, the last moment to lock; each
  side as a tile with the club mark, home or away and the opponent, STX's best bid as an amber
  price chip (**54¢**), what a Max floor lock would keep per contract on a loss (**floor ≈ 43¢**),
  and **Buy on STX ↗** (a link to the event on STX; this service never buys for anyone) or **In
  your portfolio** when the member already holds it (held games lead their day, with an amber
  edge). The club names are STX's own, so the row reads as the portfolio does.
- **History** lists every past lock as a row (the club mark, the game, chips: 30 of 50 sold ·
  Balanced · locked Nov 4) with its state on the line (Left early · net −$0.62 · bought back 30 at
  56¢; Settled; Void) and the same Details behind it. Open locks stay on Portfolio.

Nothing on the page repaints wholesale. The frame is drawn once; rows are keyed and patched in
place only when their own words change; the balance and the stamps are touched on their own, so a
poll never reloads an image, closes an open panel or moves the scroll. Pull down at the top on a
phone to re-read everything at once. While the first read lands the rows are skeletons, not
"reading…".

The shape a member picks is remembered on the device (Balanced to start). The page is
installable (a web manifest under `/app/`, icons, standalone display) and re-reads the account
and the positions whenever it comes back into view: after a buy on STX, after a look at the
balance, from the home screen. It can carry its own host: set `MEMBER_APP_HOSTNAME`
(`stx.earnandprotect.xyz`) and add that domain to the same Render service (Settings → Custom
Domains; a CNAME at the registrar to the service's onrender host; Render issues the certificate).
On that host `/` is the page and `/app/*` and `/api/*` answer as always; any other path is sent to
the record URL, so the public record and the embed are never served under a venue's name. STX's
app registration does not change: the callback stays the record URL's. Its foot: "Protection by Atticus, a third party; not a product of
STX", the public record, **How this works** (the sale in plain words, the consent given on STX's
own page and revocable there, what the page never holds), **Privacy** (`/app/privacy`, or
`/privacy` on the page's own host: what the page reads, writes, stores and never holds, in the
same skin; the URL the STX app registration asks for; `MEMBER_APP_CONTACT` names who to write
to), and on a phone Disconnect. Everything
below about the sale, Details, Compared and Leave early is the page's behaviour too; the two
surfaces call the same routes.

The extension still knows STX (`stxapp.io`) for a holder who already runs it on the other venues:
there STX is read through the holder's own account, not its page, and the card (the same card
the other venues fall back to when no row can be read) is the surface, bottom right on every
page of the venue, in STX's skin, dismissable with ×. Before the connection it carries one
thing: **Connect STX account**. The tap asks the service for STX's own authorize page and opens
it in a new tab (with a plain link under it when a popup blocker eats the tab); after the
approval the card updates on its own within a few seconds. The extension never sees a token
either: the connection is keyed to the holder's lock key, and the background worker's lock key
header is the only credential in the extension, as on every venue. On the venue's own portfolio
page the pre-trade pills stay away from the position rows; the card is the only thing we draw
there.

Connected, the card lists the holder's long positions on games the service can protect (one row
per Winner market, sized from the account: 50 contracts at an average 42¢; a $2 contract counts
as two), each with the same Lock in line as a Kalshi row. A short, a Spread or Total market, or a
game the service does not list gets no row or a muted one with the reason.

**The lock is the holder's own sale.** On the other venues the service buys the other side of the
pick on a hedge venue and pays the holder a credit; the floor and the cap are the collar's terms.
On STX nothing is hedged and no one is on the other side: the three shapes sell 40%, 60% or 80% of
the position (Max upside, Balanced, Max floor) into STX's own bids at the walked price, and the
floor is simply the cash the sale pays (the side lost: the holder keeps the cash and the riding
contracts pay $0), the cap that cash plus $1 on every riding contract (the side won). So the cash
row reads **In your STX balance now +$10.80** rather than Cash now; the panel, the Shape control
and the Protected line are otherwise the same. The tap sends one limit sell for the shape's share
at the walked price, waits briefly, cancels the rest and writes the record from the fills, never
from the quote: a partial fill is a smaller sale with more riding, said once on the facts line
("28 of the 30 asked sold; the rest rides"), and no fill writes nothing ("STX's bid moved before
the order reached it; nothing was sold", priced again in a few seconds). Details carries the sale
as STX filled it (**Sold 28 of 50 at 54¢ · STX order 1a2b3c… · 22 still riding**), the cash with
STX's fee when the fills carried one, the riding contracts, and **Compared**: at the moment of
the sale the service priced the same size on the hedge routes (Kalshi, Polymarket, ProphetX,
Novig) against STX's rules and wrote what a hedged lock would have paid, nothing sent anywhere
("Kalshi would have paid $1.20 now, then $20.40 or $40.80 · priced, nothing sent"); the Rules
grid and the Terms row are STX's own rule row, pinned at the lock, and the tails say the sold
contracts stay sold whatever the venue does with the riding ones.

**Leave early is a buy-back.** The block reads "Buy back 30 at 56¢ · costs $16.80", the round
trip's net against the cash the sale paid ("−$0.65 on the round trip: you sold at 54¢, the offers
are higher now"), and what staying holds; the button says the order it sends. The service buys
the sold contracts back from STX's offers in the holder's own account and writes the close from
the fills; the position is whole again, unprotected. A book too thin for the whole buy-back says
so, and the rest stays sold (and protected).

Pre-game only, as everywhere: the service refuses a lock inside 45 minutes of the start. Parlays
are not protected on STX. The public record carries the lock with STX's own route word and no
venue ids; the operator's holders page says "own sale" in the route column. In Details, the
Shape control moves Sale, Compared and the Rules grid together: each tier carries its own
comparison and its own tails, so the row the member reads is the shape they picked.

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
   open http://127.0.0.1:8812/preview/stx.html#/portfolio           # STX: the card is the surface (connect, then positions)
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
- `preview/positions.html`, `preview/kalshi.html`, `preview/novig.html`, `preview/stx.html` are the stand-in boards;
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
| `EVENT_HEDGE_STRATEGY` | `live` | Real orders behind rails. Anything the rails hold is simulated at the book, reason on the receipt. |
| `EVENT_HEDGE_LIVE_VIA` | `aggregator` for tonight | Orders go through the aggregator's execution pod with the TRADE key, which reaches both Kalshi and ProphetX. Unset (`direct`): Kalshi on our own key, and ProphetX prices on paper only. Novig is direct in either mode, on `NOVIG_TRADE_KEY_ID`. |
| `AGGREGATOR_TRADE_KEY_ID`, `AGGREGATOR_TRADE_PRIVATE_KEY_HEX` | from the aggregator | Service only. The DATA key reads books and never sends an order. |
| `EVENT_HEDGE_VENUES` | `kalshi,prophetx,novig` | The hedge venues every quote competes. Unset offers all four (Kalshi, ProphetX, Novig, Polymarket). Polymarket stays out until the aggregator lists Poly US. Shown on `/healthz` with the operator token. |
| `EVENT_HEDGE_SAME_ACCOUNT_VENUES` | leave unset for tonight | Venues where the service's hedge sits in the holder's own account (Novig's subaccount is one), named `novig`. Set, a hedge is not routed to the same venue the holder stands on there: Novig nets the two sides in one account and pays the guarantee out early (Oct 30). Unset by default because for the live parlay test the Novig subaccount is the one funded hedge venue, and Novig cannot net a parlay against a single. |
| `EVENT_PROPHETX_FEE_BPS` | leave unset (`200`) | ProphetX's 2% of net gains at settlement, folded into its book before every walk and provided for on every fill. |
| `NOVIG_TRADE_KEY_ID`, `NOVIG_TRADE_PRIVATE_KEY_PEM` | from `venueReadKey.ts subaccount-open` | Service only. The trading key of the service's own Novig subaccount; its cash funds the Novig hedges, fill or kill, direct (no pod). Unset with `novig` offered: the route prices on paper and the receipt says so. The host is `VENUE_API_HOST` (production `https://api.novig.com`; the Paper environment `https://api.paper.novig.com` runs the whole route on play money with no location check). |
| `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PEM` | from Kalshi | Service only. With `via=aggregator` they serve the account routes and send nothing. |
| `EVENT_HEDGE_LIVE_TICKERS` | the one ticker you will tap; `*` while rehearsing on many games | Allowlist, keyed by the game's Kalshi ticker whichever venue the hedge lands on. Empty allows nothing. `*` arms every market the service lists, so any tap by any holder key sends a real order, still under the caps below. The hourly scan's board positions are paper whatever is armed (their receipts say `scan: the board's positions are paper`); only a holder's tap, leave or an operator resend can send. Listed tickers are skipped by the hourly scan. With one live venue the route is pinned to it; with more (Kalshi and ProphetX through the pod, Novig on our own key) nothing is pinned and the routing competes them on price. |
| `EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_ORDER` | `25` | Per-order cap. |
| `EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_DAY` | `20` for the first live test, then `100` | Per-day cap, counted from the receipt file, so a restart cannot reset it. |
| `EVENT_SHADOW_LOCK_LEDGER_PATH` | leave unset | Locks live in `lock-ledger.jsonl` beside the scan's ledger on the same disk. |
| `EVENT_HEDGE_LIVE_SEND` | `yes` | The only value that sends. Anything else is a dry run. |
| `EVENT_HEDGE_KILL_SWITCH` | `1` to stop | Nothing leaves, whatever else is set. |
| `EVENT_SHADOW_EXT_MIN_VERSION` | e.g. `0.7.0` | Extensions below it draw nothing but "update the extension". Unset: every build draws. |
| `EVENT_SHADOW_EXT_MARKS_OFF` | e.g. `novig` | Venues (comma list) whose pills and slip line are off, with no new build. The plays page keeps its offers. |

### Holder plays from the venue (optional, recommended for the recording)

**Set it for a live hedge.** Without it the extension reads each row's Cost and To Gain from the
page and the numbers are the same, but it also reads **which club is the pick** from the card's
text alone, and a card that prints both clubs with no pick line can be read as the wrong side.
With the key set the venue's own word on what the holder holds decides the side, and the service
refuses a lock on the other club (`wrong_side`). On Novig, that key is the read key below
(`VENUE_API_KEY_ID` + `VENUE_API_PRIVATE_KEY_PEM`, minted with `venueReadKey.ts mint`, host
`https://api.novig.com`); the bearer pair in this section is the previous venue's.

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

**Parlays (0.7.37).** A parlay is protected at its last pick only. With two or more picks open
there is no one market to buy the other side of, and the ticket pays only if every pick hits; once
all but one have hit, the ticket is a single on the last pick, paying To Pay if it hits and
nothing if it misses, and it is locked in like any single for what the ticket pays (one contract
per payout dollar, the entry price the stake over the payout). The extension reads a parlay card
("2 Leg Parlay · 6.62x", the codes "SEA, BAL", MATCHED, Amount and To Pay) as its picks and asks
the service where they stand (`GET /api/shadow/picks?picks=SEA:CHI:Mon,BAL:JAX:Thu`: each pick is
placed on one listed game, open or settled this fortnight, by club code and, when the card's legs
are shown, the opponent and the day; the answer is open, hit, missed, or which game?). The line
follows: **Lock in · Reading your picks…** (muted) while the service answers; **Lock in · Opens
at your last pick · Ravens Thu.** (muted; the panel lists the picks and says why) with two or
more open; nothing at all once a pick has missed or every pick has hit (the ticket is the venue's
to show); **Unavailable · Tap Show Legs so your picks can be read.** when a bare code fits two
games (SEA is the Seahawks and the Mariners). At the last pick the card must have its legs shown,
so the pick's market is certain (**Lock in · Tap Show Legs to price protection on your last pick,
Ravens.** until then), the pick must be a Winner, and the game must not have started; then the
card gets a single's offer on that market, **Lock in · Lose, and still get $20.59.**, with a
**Picks** row in Details (Seahawks · hit, Ravens · Thu 8:15pm ET). The lock carries a `parlay`
block (the picks as read, the stake and payout); the service places the picks again itself and
refuses a lock that is not at the last pick (`parlay_not_last_pick`), on a busted or settled
ticket (`parlay_busted`, `parlay_settled`), on a pick it cannot place (`parlay_pick_unknown`),
after kickoff (`parlay_in_play`) or for more than the ticket pays (`parlay_size`), so a card read
wrong cannot write a record; the record and the Protected panel carry the picks. A ticket's picks
are read again every minute, so a pick that hits turns the card's line on its own. Novig cards
first; the reader is generic (an "N Leg Parlay" head, "CODE Winner" legs over a game bar).

**Featured parlays are not positions (0.7.37).** Novig's Portfolio opens with a carousel of
featured parlays to buy (a themed name and an SGP tag, "Placed This Order", picks "(vs WSH)" and
player props "57+ Rushing Yards", a price and Add to Slip). Each names two clubs and carries money,
so it read as a position, and with one block per game the carousel's Eagles card took the line the
holder's own Eagles card should have had. Those words now skip the row ("row skipped: a featured
parlay to buy, not a position" on the operator console) before any club is counted.

**A tall card in one column, and a game in play (0.7.38).** On the first live night the parlay
card lost its line the moment Show Legs opened it: with the legs shown the card stands over 320px,
and a block that tall is taken for a list unless it is one card of a deck (a wrapping row); on a
narrow window Novig lays its cards in one column, which is no deck, so the card was dropped and
the Eagles card beside it, in play, had no line at all. A block with exactly one "N Leg Parlay"
head and one row's worth of stake labels is now one card up to 1400px wherever it stands. The
Eagles card had a second cause on the service: the horizon pre-filter compared the game's date
with the UTC clock, so from 7pm ET an evening game counted as yesterday's and left
`/api/shadow/markets`; without the market listed, PHI fit two games and the card was skipped. The
filter now compares ET calendar dates, so a game is listed through its own night and the next day
(and the Thursday night Ravens stays listed through its 7:00–7:30pm ET lock window). A started
game is listed as `notProtectable: "in_progress"`, and its card reads **Unavailable · This game is
in play.** rather than "starts too soon".

**The legs as the real card prints them (0.7.39).** With the legs shown, the real Novig card still
read as its bare codes and asked for Show Legs. Its jerseys carry the club's letters as text, so a
leg's bar runs "CHI CHI 8:15 PM Mon SEASEABAL Winner": the home jersey, its label and the next
leg's pick in one run of nine capitals, which no code pattern could take apart, so only the first
leg was read. The legs are now read from the card's words in order: a run of capitals is split
into the clubs it is made of against the clubs known (SEA, SEA, BAL; BAL and the badge), a leg is
a club code and the market word, and its bar is whatever lies between it and the next leg or the
card's own chrome (TRADE CREDIT, Buy More, the id), in any order: the one other club in it is the
opponent, the first weekday the day. The same night the Eagles card, in play, lost its line once
the service listed tonight's game beside next week's: a card that says its game is under way
("Live Q2 4:43") now names the club's game in progress, the listed one the service says has
started, else the earliest.

**STX, through the member's own account (0.7.44).** A fourth venue and the first member venue.
The primary surface is not this extension but the service's own hosted page, `GET /app`, built
for a phone in STX's skin with the demo's Lock in line (connect in the same tab, a cookie
session, a member-only lane; STX's mark and our bird in the bar, the member's handle and STX
balance, Portfolio / Games / History tabs, every position listed with the unprotectable ones
muted with their reason, parlays among them; a web manifest; see **STX** above). In the extension, the host `stxapp.io` picks an amber
skin; no row on the page is read: the card is the surface on every page, with **Connect STX
account** before the connection (the venue's own consent screen in a new tab, a plain link under
it when the tab is blocked; the service holds the tokens, this extension never sees them) and
the account's long positions on protectable games after it, the header saying "10 riding, 40
sold" once a lock is open. The lock is the holder's own partial sale into STX's
bids, nothing hedged: the cash row reads "In your STX balance now", the Protected line "… · on
STX", Details carries the sale as filled (sold, price, STX order, still riding) and the
background comparison on the hedge routes ("priced, nothing sent"), Leave early is "Buy back N at
X¢". Positions from the service now carry their venue, and a page lists only its own venue's.
Telemetry accepts `stx`. See **STX** above.

**The comparison says the fees are in it (0.7.43).** The Other side sentence and the compare
tail on the collapsed line read "best of 3 venues, venue fees included" where they read "best of
3 venues": the service compares the venues all in, each venue's fee schedule folded into its book
before the routes are ranked (Kalshi's 0.07·P·(1−P) at match, ProphetX's 2% of net gains at
settlement, Novig's none pre-game), and the words now say so, the same words as the demo embed.
The operator's per-venue rows say "books with fees" for the book leg of the all-in figure. The
same release puts the fee on the public venue scoreboard (`/api/shadow/scoreboard`, the
`/scoreboard` page) per venue per week. No behaviour changed.

**NHL cards read like NFL and NBA (0.7.42).** The nickname table carries the 32 NHL clubs
(Ducks … Capitals) and the league word reads "NHL", "Pro Hky" and "Hockey", so a Rangers at
Bruins card on any of the three venues resolves to its Kalshi game market
(`KXNHLGAME-…`) the way a Ravens card does, and a parlay with an NHL pick places that pick. The
service maps the league on its side in the same release (Kalshi `KXNHLGAME` to Polymarket
`nhl-<away>-<home>-<date>`, the routing table's NHL rows); the extension has nothing else to
learn. Codes that differ between venues are aliased (LA/LAK, CGY/CAL, MTL/MON, NJ/NJD, SJ/SJS,
TB/TBL, UTA/UTAH, VGK/VEG), and LA now stands for the Rams, the Chargers or the Kings until the
league word decides.

**A parlay's lock heads with the highest floor (0.7.41).** At the last pick the quote is asked
for with `parlay=1`, and the service heads it at **Max floor** instead of Max upside: the holder
has won every other pick, the number they weigh the lock against is the venue's cash-out, and
their stake is small against what the ticket pays, so the shape with the biggest guaranteed figure
is the one that reads right ("Lock in $40" beside a $43 cash-out, with the win still above it).
Singles keep Max upside. The Shape row under Details still lists all three, and a chosen shape is
the one locked; the service applies the same default when a parlay lock arrives without one.

**The parlay's panel as a ticket (0.7.40).** Under a parlay the panel is one heading, the picks
as a list and a Details toggle, as the demo's Parlays tab draws a ticket: a box per pick (empty
while it is open, a check once it hit, a cross when it missed), the club and its market, and at
the right edge the start or how it ended ("Seahawks · Winner … Mon 8:15pm ET"; "Seahawks · Winner
… hit"). The words (why nothing is priced before the last pick, that the picks are read again
every minute) wait behind Details, so the block is as spare as the card above it. A card that
says its game is under way and names a club with two listed games now also takes the game the
service says the holder holds, else the one that tipped in the last four hours; a row whose codes
all fit more than one game says so on the operator console ("row skipped: no side read").

**The hedge's own card on Novig (0.7.35).** The service's Novig hedges are bought in a subaccount
of the holder's own Novig account, so the holder's Portfolio shows them as cards beside their
own picks: the other side of a 76ers lock held on ProphetX appears as a Knicks card on Novig. That
card is not theirs to protect (a lock on it would hedge the hedge, and Novig nets the two sides
in one account and pays the guarantee out early, which is what happened on Oct 30), so on Novig
the extension marks it **Hedge** ("The other side of your 76ers on ProphetX"), muted and with no
button; a tap says what it is and that it settles with that lock. The extension knows it from the
public record alone: an open lock held on another venue whose chosen route is Novig, on the
other club of the card's game. The service refuses such a lock as well (`own_hedge`, 409) should
a stale tab send one. Novig only, for now: on Kalshi and ProphetX the hedges go through the
aggregator and never show as the holder's cards. The line is the confirmation the recording
wants after a ProphetX lock: open Novig's Portfolio and the hedge is there, named for what it is.

**Details as rows (0.7.36).** The Details block had grown five visual grammars stacked under one
pill: a slider with its own heading, a strip of venue chips, a fine-print line, a bulleted
how-it-works that repeated the slip's figures, and a rules row. On the recording it read as a
lot of writing. 0.7.36 makes it five rows in one grammar, label left and value right, with the
shape as a segmented control (the three words were already the slider's stops; a tap repaints
the slip instead of the figures following a thumb) and How reduced to two sentences with no
figures. The receipt follows: Hedged on, Compared and Order fold into the Other side row (the
venue in bold, the race as a dim tail with each venue's figure in the tooltip, the order id and
rail at the end; the lock's timestamp is the facts line's, so it is not repeated), the cash leg
reads **Paid to you** rather than "Credit · owed to you", and a credit not yet marked paid reads
"credited at the lock; settles with the position". The loading skeletons are gone: "Pricing from
the live book…" and "Pricing your exit…" are the one line while the book answers.

**Leave early (0.7.35).** One plain line, `To leave now · You pay $0.30` or `You get $0.30`, then
`Net · −$0.12 after the $0.18 paid to you at the lock`, then `Staying · $1.88 or $18.93`, the two
buttons, and a **Why** toggle that opens the reason (the pick moved up, so the upside sold is
worth more than the floor held, or the reverse) and the standing note that the pick stays open on
the venue unprotected and the credit is theirs either way. "Due back" is gone everywhere: a
leave's settlement reads "you paid $0.30" / "$0.30 paid to you" on the line, in the receipt's
earlier-protection note and in the cash state ("you owe $0.30" for a slice above the cap).

**When a Novig line comes and goes (0.7.34).** On the live Portfolio the button has appeared and
then gone within a few seconds and not come back; DevTools showed no `.ael-host` in the page at
all, so the block was taken down, not hidden. Three readings can take a line down, and 0.7.34
closes each: the page's heading redrawn without its role after hydration turned the page from
the plays page back into a board (now the plays-page verdict holds for a route until the route
itself changes); the tab reader taking **Settled** for the selected tab on a page where the
selected tab is marked by colour alone, which turned every row settled (now a card that wears
its own MATCHED or UNMATCHED badge is what it says, whatever the tabs read); and a React redraw
that replaces a card's children, taking our block out while the card stays (now the block is
put back while the card still names the pick, within the six-second grace). With the operator
setting on (Show hedge: yes), the extension's console (DevTools → Console, context "Lock in")
names every row it skips and why ("row skipped: prices Yes and No, a board"), every line it
takes down and why ("row dropped: reads as settled (tab settled)", "page: no longer the plays
page"), and a state line whenever the picture changes (route, plays-page verdict, tab, the
service's positions, the rows). If a line still goes, that console is what to send.

### Novig: reading needs no subaccount, ordering does

Novig's keys come in two scopes. The **management** key (one per trader, made on the Profile
page) reads every wallet, opens and funds subaccounts and mints other keys; it never places an
order. A **trading** key addresses exactly one **subaccount** and is the only key that can send
`POST /v3/orders`. Reading the holder's plays for the protection (what the service does tonight)
works with the management key or a read key minted from it: the cash wallet's positions come
back under the management key's id and `venuePositions.ts` already reads them. A subaccount is
needed only when the service itself orders on Novig. The management key answers positions for
**every** wallet in the account, the service's hedge subaccount among them, and a hedge bought
there is the other side of the holder's own game: left in, the holder read would carry both
sides (a Texans position and a Jaguars one on the same game) and the extension would misread
the holder's card. So the holder read leaves out the wallet whose key equals or contains
`NOVIG_TRADE_KEY_ID` (the trading key id is the subaccount's address), and any label named in
`VENUE_API_EXCLUDE_WALLETS` (comma-separated); `venueReadKey.ts check` prints the wallets it
read and the one it left out. Set `NOVIG_TRADE_KEY_ID` on the worker and this is automatic.
Before the route is used in anger, the venue's
conditions for an order are worth knowing: the account must be KYC'd, the request may come from a
data-centre IP but not from a VPN or a restricted state (451), and the venue wants a device
location from the holder's own Novig app within the last three days or the order is refused.
Novig has no sell order, so an unwind there would be an offsetting buy of the other outcome, as on
ProphetX.

The subaccount tooling is in `src/eventCollar/crossVenue/novigAccount.ts` and
`scripts/venueReadKey.ts`, run from the operator's machine with the management key (the key never
leaves it; the private PEMs are written mode 600 and nothing prints one):

```
cd services/api
export VENUE_API_HOST=https://api.novig.com VENUE_MGMT_KEY_ID=... VENUE_MGMT_KEY_PEM_PATH=~/novig-mgmt.pem
npx tsx scripts/venueReadKey.ts subaccount-open --out ./novig-trade.pem --label "atticus hedge"
   # mints an Ed25519 keypair, POST /v3/account/subaccounts with the public half, prints the
   # trading key id (also the subaccount's address) and the env lines for the service
npx tsx scripts/venueReadKey.ts subaccounts                       # trading key id, label, balance
npx tsx scripts/venueReadKey.ts fund --key <trading key id> --dollars 50 --id fund-2026-10-28-1
   # POST .../transfer {direction fund, amount "50.00000"}; polls until Applied, prints the balance
npx tsx scripts/venueReadKey.ts fund --key <id> --dollars 50 --id defund-... --defund
npx tsx scripts/venueReadKey.ts transfer --key <id> --transfer <transfer id>
VENUE_API_HOST=https://api.novig.com NOVIG_TRADE_KEY_ID=<id> NOVIG_TRADE_PRIVATE_KEY_PEM_PATH=./novig-trade.pem \
  npx tsx scripts/venueReadKey.ts trade-check
   # the pair as the service will use it: signs the subaccount balance read with the trading key
   # (the pre-flight's read). Passes with the balance, or says why not: a management or read-only
   # key id ("does not reach a subaccount"), a PEM from another key, a PEM that does not parse
```

The service takes `NOVIG_TRADE_KEY_ID` (the printed id) and `NOVIG_TRADE_PRIVATE_KEY_PEM` (the
contents of `--out`), service env only, never the extension; with them set and `novig` in
`EVENT_HEDGE_VENUES` the Novig route is live under the same rails as the others (allowlist by the
game's Kalshi ticker, per-order and per-day caps, `EVENT_HEDGE_LIVE_SEND=yes`). Money on this
API is a five-place decimal string ("50.00000"); the client converts to and from cents. The
venue allows ten live subaccounts. The venue also wants a device geolocation from the Novig app
within the last three days for the account the key belongs to; without one an order is refused
with 451 and the receipt carries that reason.

Pre-flight answers a `novig` field: `{ ok: true, keyId: "…last4", balanceCents }` read from the
subaccount, or `ok: false` with an `error` naming what is missing. Check it before the first live
lock:

```
curl -s -H "x-admin-token: $EVENT_X_ADMIN_TOKEN" \
  "https://<service>/api/shadow/hedges/preflight?ticker=KX...&contracts=26" | jq '{live, venue, novig, ticker, notes}'
```

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
   "rehearsal" on it and the panel offers Reset. **Leave early** is there too (0.7.31): its sheet
   is estimated from the live mark rather than priced from the books (the fine print says so), and
   the tap ends on "Protection removed · rehearsal" with Reset; nothing is sent. Use it to see the
   screens before real money, then turn it Off and reload the venue tab before the recording.
3. On the venue, open the plays page: ProphetX **My Trades** (Cash mode, **Filled** tab), Kalshi
   **Portfolio** (**Positions** tab), Novig **Portfolio** (**Open** tab, cash not points). Each
   matched play gets its line; a resting order's line says it has not matched or filled. If the
   extension cannot find the rows but the service knows your plays, a card bottom-right lists
   them with the same lines.

Operator actions (token in `x-admin-token`), for the recording day:

| Call | What it does |
| --- | --- |
| `GET /api/shadow/hedges/preflight?ticker=KX...&contracts=N` | Balance, rails, and whether the tap would be offered and sent. Reads only. |
| `POST /api/shadow/hedges/resend?ticker=KX...` | Hedges an open lock again when its hedge never reached the venue (simulated fill on the trail). Routed as a tap is now: the one live venue, or the live venues competed on price. `&route=kalshi|prophetx|novig` names the venue instead (a venue with no live client on this ticker is refused). Refuses once a live fill exists unless `&force=1`. |
| `POST /api/shadow/lock/reset?ticker=KX...` | Takes one lock off the record (its lines move to an archive beside the ledger) so the market can be locked again; the row goes back to the offer on the next poll. Names any live fill the venue still holds for the old lock, which is yours to sell or keep. |
| `GET /api/shadow/hedges` | The hedge trail: every receipt, order ids, fills, reasons. Each live fill says `via`: `direct` (our own venue key) or `aggregator` (the execution pod). |
| `GET /holders?token=...` | One page per holder key: their locks, what is owed each way, and the `POST /api/shadow/cash` line to record a payment. The JSON is `GET /api/shadow/holders`. |

## Test steps (five minutes, no money)

1. Open the preview My Trades with the extension loaded. Every row has a line under it: Lock in
   with the floor ("Lose, and still get $x."), Unavailable with a reason, or Protected.
2. Tap a Lock in line. The panel opens under that row; the rows below move down: three rows
   (win, lose, cash now) and the Lock in pill. Tap **Details** and tap **Max floor** on the
   Shape control: the three rows and the line reprice; tap **Max upside**: they return. The
   control is only offered when the book funds more than one shape; a heavy favourite often has
   one. Under it: Other side (the venue and the race), Until (the clock), **Rules**, which opens
   to the grid of the four cases, and How in two sentences.
3. Tap **Lock in**. The pill reports the stages in words (Pricing from the live book, Writing
   the record, Buying the other side) under a slow sheen, with whole seconds only past three; the
   line flashes solid and settles as the Protected pill with "$x or $y · on Kalshi.";
   the panel is the three rows with the locked numbers, the Leave early button and a Details link.
   Tap **Details**: the facts line with how long it took, then Other side (venue, contracts,
   price, the race, the order), Cost, Rules, Terms, Paid to you. Open `/` on the service: the position is there with `source: lock`.
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
   operator records the payment with `POST /api/shadow/cash`). A settled play that was never
   locked here gets no line at all (0.7.17; before it, "Not protected"), and a play the venue
   shows as sold or cashed out reads as settled whatever tab it sits in.

Rules the service enforces, so plan the game around them:

- The lock must be at least 45 minutes before start and inside 7 days.
- One open lock per game per holder, whichever venue the pick sits on: the record is keyed by the
  Kalshi market. A settled or voided lock still holds the market. A lock whose protection was
  removed (Leave early) frees it: the game is offered again, and the next lock is the next
  generation on the record (`generation: 2` on the receipt and the positions list); the removed
  lock stays on the record, closed, with its own settlement and cash legs, and the public record
  counts both. A second tap while a lock is open is refused with "already locked".
  `POST /api/shadow/lock/reset?ticker=` still takes every generation off the record at once. A
  lock belongs to the venue it was made from (`holderVenue` on the record; a lock
  written without one, before 0.7.13, is Kalshi's, the service's default) and draws only on that
  venue's page: an open lock reads "Protected on ProphetX already" on another venue's card of the
  same game, and a lock closed or settled elsewhere says nothing there. Protecting the same game
  on two venues at once would need the record keyed by venue as well; not built.
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
