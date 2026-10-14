# Atticus Earn & Protect: Lock in (browser extension, demo placement)

Demo-only. Draws on one page of the venue, the **Portfolio** (open positions), and nothing
anywhere else. No shield, badge or icon on the game list, the game page or the order slip; the
holder trades exactly as they do today. Once a position exists, under its row:

1. a **Lock in** line: "Lock in · +$1.66 now", caption "worst case $14.71 instead of $0 · best
   case $25.06". Priced live from the holder's actual size;
2. tapping it opens an **inline panel** under that row (the rows below move down; nothing floats
   over the slip): the headline "Worst case $14.71 instead of $0", three tiles (if they lose,
   paid now, if they win), a segmented control with the price shapes the book offers right now
   (**Most now** / **Even** / **Keep more upside**) and the numbers for each, one button, a
   fine-print line with the kickoff cut-off and "how it works";
3. after the tap, a **Protected** chip on the row: "Protected · +$1.66 paid · ends $14.71 or
   $25.06 · details". Details is the same inline panel: worst case, best case, paid now, settles on
   the game's official result, a link to the public record;
4. a position protection does not cover gets a muted **Protection unavailable** line with the
   reason after it ("covers Winner picks", or the live refusal from pricing). Tapping it says what
   to do: a Winner pick on this game can be locked; or check back, the book moves toward kickoff.

That placement is the only staged pixel. Everything behind the tap is the Atticus event service:
the position is matched to its market, priced from live books at the holder's size, the terms lock,
the record is written, and the hedge is bought on Kalshi.

Styled in the venue's own theme (near-black, white, one blue accent), with no brand of ours up
top; our name is one line at the foot of the panel.

> Disclosure line, shown on every panel and to be read in any published recording:
> *"Third-party protection by Atticus, rendered here for this demo; not a product of this venue.
> Pricing, record and hedge are live."*

What this extension holds: the service URL and a lock key. What it never holds: a venue login,
a Kalshi key, or anything that can move money. The venue's own session is never read or used.
The Kalshi API key lives in the service's environment only.

## Where the size comes from

Two sources, in this order:

1. **The service, from the venue's API** (preferred). A read-only key on the service lists what
   the holder has: market, side, quantity, cost. The service matches each position to our ticker
   and returns contracts, entry price, stake and payout. The extension pairs that with the row on
   the page by team name and amounts. Nothing is guessed.
2. **The page**, when the service has no key or has not heard of the position yet. The row's
   "Wager $20.00" and "Payout $45.40" are read as text: one $1 contract per payout dollar, entry
   price is wager over payout. The panel then says "read from the page". If neither amount can be
   read, the line offers "Price it" with a payout box.

The two agree to the cent on the preview board; the first is the one to use on the recording.

## See it before any deposit or trade

No venue account is needed.

1. Load the extension (below) and set the service URL and lock key in its options.
2. Serve the preview page **from this folder** and open the Portfolio route:

   ```
   cd event-lockin-extension && python3 -m http.server 8812 --bind 127.0.0.1
   open http://127.0.0.1:8812/preview/positions.html#/portfolio
   ```

   If you started the server one folder up, the address is
   `http://127.0.0.1:8812/event-lockin-extension/preview/positions.html#/portfolio`; a 404 means
   the server's folder and the address do not match.

   The board is a generic exchange-style page: league list, game page, order slip, and a Portfolio
   with open positions (Texans Winner $20, 49ers Winner $20, Colts -6.5 Spread $10, Titans Winner
   $5, and so on). Placing an order on the slip adds a row to the Portfolio, which is where the
   extension draws. Prices come from live books; a lock writes to the record and runs the hedge
   path for real (dry run unless the service is set to send). Lock only games you mean to put on
   the record.

## Files

- `manifest.json` runs the content script on the venue's domains (edit `matches` to add one) and on
  the local preview page; grants fetch to the service host and to localhost on any port.
- `content.js` decides it is on the Portfolio page (URL or heading), finds position rows by text
  (a team the service can protect plus two money amounts), inserts our block as a sibling after the
  row, and re-inserts it when the venue re-renders. The venue's DOM is never modified.
- `content.css` the line, the inline panel, the segmented control, the chip. Two-column tiles under
  560px.
- `background.js` is the fetch proxy; it attaches `x-lock-key` from extension storage.
- `options.html` sets the service URL, lock key, and the operator-only hedge line.
- `preview/positions.html` is the stand-in board described above.

## Service side (Render dashboard, never in git)

The lock routes are off until a key is set.

| Env | Value | Why |
| --- | --- | --- |
| `EVENT_SHADOW_LOCK_KEY` | 12+ random chars | Opens `/api/shadow/markets`, `/api/shadow/quote`, `/api/shadow/positions`, `/api/shadow/lock` to callers with `x-lock-key`. Unset answers 404. |
| `EVENT_HEDGE_STRATEGY` | `live` | Real Kalshi orders behind rails. Anything the rails hold is simulated at the book, reason on the receipt. |
| `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PEM` | from Kalshi | Service only. |
| `EVENT_HEDGE_LIVE_TICKERS` | the one ticker you will tap | Allowlist. Empty allows nothing. Listed tickers are hedged on Kalshi's own No side and skipped by the hourly scan. |
| `EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_ORDER` | `25` | Per-order cap. |
| `EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_DAY` | `20` for the first live test, then `100` | Per-day cap, counted from the receipt file, so a restart cannot reset it. |
| `EVENT_SHADOW_LOCK_LEDGER_PATH` | leave unset | Locks live in `lock-ledger.jsonl` beside the scan's ledger on the same disk. |
| `EVENT_HEDGE_LIVE_SEND` | `yes` | The only value that sends. Anything else is a dry run. |
| `EVENT_HEDGE_KILL_SWITCH` | `1` to stop | Nothing leaves, whatever else is set. |

### Holder positions from the venue (optional, recommended for the recording)

The service can read what the holder has at the venue with a **read-only** key: it lists
positions and can do nothing else (no orders, no transfers). The key is minted from a management
key that stays on your machine; only the read key goes to Render.

```
cd services/api
VENUE_API_HOST=https://api.<venue host> \
VENUE_MGMT_KEY_ID=<your management key id> \
VENUE_MGMT_KEY_PEM_PATH=~/keys/venue-management.pem \
  npx tsx scripts/venueReadKey.ts mint --out ~/keys/venue-read.pem --name "atticus read"
```

It prints the new key's id and writes the private key to the file (mode 600). Then, in the Render
dashboard for the record service:

| Env | Value |
| --- | --- |
| `VENUE_API_HOST` | the venue's API host (its paper host for a rehearsal) |
| `VENUE_API_KEY_ID` | the id the mint printed |
| `VENUE_API_PRIVATE_KEY_PEM` | the contents of the read key file (`\n` escapes are fine) |
| `EVENT_SHADOW_POSITIONS_TTL_MS` | `20000` (one read reused for 20 seconds) |

Check it from your machine before recording (it prints the positions in our units and the ticker
each one matched):

```
VENUE_API_HOST=... VENUE_API_KEY_ID=... VENUE_API_PRIVATE_KEY_PEM="$(cat ~/keys/venue-read.pem)" \
  npx tsx scripts/venueReadKey.ts check
```

`GET /healthz` on the service shows `lock.holderPositions.configured: true` once the key is set.
Never paste a key into chat, a ticket or a commit. Unset, the extension reads sizes from the page.

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
3. Open the venue's Portfolio. Each open position gets its line. If the extension cannot find the
   rows but the service knows your positions, a card bottom-right lists them with the same lines.

## Test steps (five minutes, no money)

1. Open the preview Portfolio with the extension loaded. Every row has a line under it: Lock in
   with a price, Protection unavailable with a reason, or Protected.
2. Tap a Lock in line. The panel opens under that row; the rows below move down. Tap **Keep more
   upside** or **Most now**: the three tiles and the button reprice. Tap **Even**: they return.
   Only the shapes the book offers for that pick are listed; a heavy favourite often has one.
3. Tap **Lock in · +$x now**. The panel shows "Locked in" with the three numbers; the line reads
   "Protected · +$x paid". Open `/` on the service: the position is there with `source: lock`.
4. Reload the page. The chip is still there (it comes from the record, not from the browser).
5. Tap the Spread row's line: "Protection covers the Winner market." Close it.

## Recording checklist

Three clips, one tap. Shoot on a desktop width; the panel is responsive, but the Portfolio rows
are widest and clearest there.

1. **Venue, after the trade.** The Portfolio with the new position. Tap its Lock in line; the
   panel opens with the terms; tap **Lock in**. "Locked in", the chip on the row.
2. **Record.** `/` on the service a moment later: the position appears with `source: lock`, the
   three numbers match the panel. Operator cut: `/api/shadow/hedges` shows the live attempt, order
   id, fill, cost.
3. **Settlement.** After the game, the position's settled row on the record and the chip's details
   panel: what the holder received, what the position alone would have paid.

Rules the service enforces, so plan the game around them:

- The lock must be at least 45 minutes before start and inside 7 days.
- One lock per Kalshi market. A second tap on the same game is refused with "already locked".
- The size you hold at the venue should be the size you lock. Position and hedge settle on the
  same official result.
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
