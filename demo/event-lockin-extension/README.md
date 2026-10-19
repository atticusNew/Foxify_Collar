# Atticus Earn & Protect: Lock in (browser extension, demo placement)

Demo-only. Draws on one page of the venue, **My Trades** (the list of open plays; the venue's
word for a play is a trade), and nothing anywhere else. No shield, badge or icon on the game list,
the game page or the order slip; the
holder plays exactly as they do today. Once a matched play exists, under its row:

1. a **Lock in** line that leads with the floor: "Lock in · $14.71 if the Texans lose", caption
   "instead of $0 · $25.06 if they win (was $46.00) · +$1.66 paid now". Priced live from the
   holder's actual size. The floor is the product; the credit is the third number on purpose;
2. tapping it (the chevron at the right end turns) opens an **inline panel** under that row (the
   rows below move down; nothing floats over the slip), a card under the Market column in the
   venue's type size, never wider than 680px: the headline "Worst case $14.71 instead of $0"
   with, to its right, the price shapes the book offers right now (**Most now** / **Even** /
   **Keep more upside**, only the ones that clear the minimum credit; a heavy favourite usually
   gets one or two); three tiles (if they lose, highlighted; paid now; if they win); the button
   under them ("Lock in · worst case $14.71"), as the venue's own slip places it; a fine-print
   line with the kickoff cut-off and "how it works". Tapping the line again closes it;
3. after the tap, a **Protected** chip on the row: "Protected · $14.71 or $25.06 · whichever way
   it goes · +$1.66 paid". Its panel is a receipt, shaped unlike the offer on purpose: a check and
   "Locked in", one sentence with the numbers ("$14.71 if the Texans lose · $25.06 if they win ·
   +$1.66 paid now"), one grey line of facts (settles on the official result, when it was locked,
   how long it took) ending in a **receipt** link. Tapping it opens four labelled lines in place:
   the other side ("19.17 contracts No on Kalshi at 27.4c each with fees"), the cost, the venue's
   order id and time, and the record id; a hedge that did not reach the venue reads "covered at
   the book" with no order line. No tiles, no button. The public record link appears only with
   the operator setting on;
4. a play protection does not cover gets a muted **Protection unavailable** line with the reason
   after it: "covers Moneyline picks" on a spread or total, "waits until the play is matched" on a
   play that is still an open order, or the live refusal from pricing. Tapping it says what to do.

That placement is the only staged pixel. Everything behind the tap is the Atticus event service:
the play is matched to its market, priced from live books at the holder's size, the terms lock,
the record is written, and the hedge is bought on Kalshi.

Styled in the venue's own theme (near-black, white, the venue's green as the one accent), with no
brand of ours up top; our name is one line at the foot of the panel.

> Disclosure line, shown on every panel and to be read in any published recording:
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

Rows in the venue's points mode (play money) are never drawn on.

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
   contract per payout dollar, entry price is cost over payout. The panel then says "read from the
   page". If nothing can be read, the line offers "Price it" with a payout box.

Prices become our units like this: $20 at 74.68% pays $26.78, which is 27 contracts at an entry
of 75 cents. $5 at 25.5% (+292) pays $19.60: 20 contracts at 26 cents. The
two sources agree to the cent on the preview board; the page is enough for the recording, the
service confirms it when the key pair is set.

## See it before any deposit or trade

No venue account is needed.

1. Load the extension (below) and set the service URL and lock key in its options.
2. Serve the preview page **from this folder** and open the My Trades route:

   ```
   cd event-lockin-extension && python3 -m http.server 8812 --bind 127.0.0.1
   open http://127.0.0.1:8812/preview/positions.html#/my-trades
   ```

   If you started the server one folder up, the address is
   `http://127.0.0.1:8812/event-lockin-extension/preview/positions.html#/my-trades`; a 404 means
   the server's folder and the address do not match.

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

- `manifest.json` runs the content script on the venue's domains (edit `matches` to add one) and on
  the local preview page; grants fetch to the service host and to localhost on any port.
- `content.js` decides it is on the My Trades page (URL or heading) and which tab is open, finds
  play rows by text (a team the service can protect, by nickname or by code, plus the row's money),
  reads the size from the table's columns or the row's labels, inserts our block as a sibling after
  the row (a full-width table row when the row is one), and re-inserts it when the venue re-renders.
  The venue's DOM is never modified.
- `content.css` the line, the inline panel, the segmented control, the chip. Two-column tiles under
  560px.
- `background.js` is the fetch proxy; it attaches `x-lock-key` from extension storage.
- `options.html` sets the service URL, lock key, Rehearsal, and the operator-only hedge line.
- `preview/positions.html` is the stand-in board described above.

## Service side (Render dashboard, never in git)

The lock routes are off until a key is set.

| Env | Value | Why |
| --- | --- | --- |
| `EVENT_SHADOW_LOCK_KEY` | 12+ random chars | Opens `/api/shadow/markets`, `/api/shadow/quote`, `/api/shadow/positions`, `/api/shadow/lock`, `/api/shadow/receipt` to callers with `x-lock-key`. Unset answers 404. |
| `EVENT_HEDGE_STRATEGY` | `live` | Real Kalshi orders behind rails. Anything the rails hold is simulated at the book, reason on the receipt. |
| `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PEM` | from Kalshi | Service only. |
| `EVENT_HEDGE_LIVE_TICKERS` | the one ticker you will tap | Allowlist. Empty allows nothing. Listed tickers are hedged on Kalshi's own No side and skipped by the hourly scan. |
| `EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_ORDER` | `25` | Per-order cap. |
| `EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_DAY` | `20` for the first live test, then `100` | Per-day cap, counted from the receipt file, so a restart cannot reset it. |
| `EVENT_SHADOW_LOCK_LEDGER_PATH` | leave unset | Locks live in `lock-ledger.jsonl` beside the scan's ledger on the same disk. |
| `EVENT_HEDGE_LIVE_SEND` | `yes` | The only value that sends. Anything else is a dry run. |
| `EVENT_HEDGE_KILL_SWITCH` | `1` to stop | Nothing leaves, whatever else is set. |

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
   quote, but calls nothing: nothing is locked, written or bought. The result panel says
   "Locked in (rehearsal)" and offers Reset. Use it to see the screens before real money, then
   turn it Off and reload the venue tab before the recording.
3. On the venue, switch to **Cash** mode (not points) and open **My Trades** (top right), **Filled**
   tab. Each filled play gets its line; on Resting the line says the order has not matched. If the extension cannot find the rows but the service knows your plays, a card
   bottom-right lists them with the same lines.

Operator actions (token in `x-admin-token`), for the recording day:

| Call | What it does |
| --- | --- |
| `GET /api/shadow/hedges/preflight?ticker=KX...&contracts=N` | Balance, rails, and whether the tap would be offered and sent. Reads only. |
| `POST /api/shadow/hedges/resend?ticker=KX...` | Hedges an open lock again when its hedge never reached the venue (simulated fill on the trail). Refuses once a live fill exists unless `&force=1`. |
| `POST /api/shadow/lock/reset?ticker=KX...` | Takes one lock off the record (its lines move to an archive beside the ledger) so the market can be locked again; the row goes back to the offer on the next poll. Names any live fill the venue still holds for the old lock, which is yours to sell or keep. |
| `GET /api/shadow/hedges` | The hedge trail: every receipt, order ids, fills, reasons. |

## Test steps (five minutes, no money)

1. Open the preview My Trades with the extension loaded. Every row has a line under it: Lock in
   with a price, Protection unavailable with a reason, or Protected.
2. Tap a Lock in line. The panel opens under that row; the rows below move down. Tap **Keep more
   upside** or **Most now**: the three tiles and the button reprice. Tap **Even**: they return.
   Only the shapes the book offers for that pick are listed; a heavy favourite often has one.
3. Tap **Lock in · worst case $x**. The button reports the stages in words (Pricing from the live
   book, Writing the record, Buying the other side) under a slow sheen, with whole seconds only
   past three; the panel then turns into the receipt ("Locked in", the sentence with the three
   numbers, the facts line with how long it took); the line reads "Protected · $x or $y".
   Tap **receipt** at the end of the facts line: the other side, the cost, the order, the record
   id. Open `/` on the service: the position is there with `source: lock`.
   With Rehearsal on in the options, the same tap ends on "Locked in (rehearsal)" with a Reset link
   and nothing reaches the service.
4. Reload the page. The chip is still there (it comes from the record, not from the browser).
5. Tap the Spread row's line: "Protection covers the Moneyline market." Close it.
6. Open the **Resting** tab. The Chiefs order's line says "waits until the play is matched"; tap
   it: "This play has not been matched yet." Close it.
7. Back on **Filled**, the Bills row shows the filled $10 of a $20 order: the panel says "pays
   $14.50 if they win · you paid $10.00", the filled part only.
8. Switch the toggle to **Points**: no lines on the rows. Back to **Cash**: they return.

## Recording checklist

Three clips, one tap. Shoot on a desktop width; the panel is responsive, but the My Trades rows
are widest and clearest there.

1. **Venue, after the play.** My Trades, Filled tab, with the new play. Tap its Lock in
   line; the panel opens with the terms; tap **Lock in**. "Locked in", the chip on the row.
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
