# Atticus Earn & Protect: Lock in (browser extension, demo placement)

Demo-only. Renders a **Lock in** button beside each open position on a venue's positions page and
a protection panel when it is tapped. The button's placement is the **only staged pixel**. Everything
behind the tap is the Atticus event service: the game is matched, the position is priced from live
books at the holder's size, the terms lock, the record is written, and the hedge is bought on Kalshi.

The panel is styled in the venue's own theme (near-black, white, one blue accent, red only for a
refusal) with no brand of ours up top, so the eye stays on the venue; our name is one line at the
foot. On a desktop width it docks at the right where the venue keeps its order slip; on a phone it
is a bottom sheet.

> Disclosure line, shown on every panel and to be read in any published recording:
> *"Third-party protection by Atticus. Button and panel rendered locally for this demo; not a
> product of this venue. Pricing, record and hedge are live."*

What this extension holds: the service URL and a lock key. What it never holds: a venue login,
a Kalshi key, or anything that can move money. The venue's own session is never read or used.
The Kalshi API key lives in the service's environment only.

## See it before any deposit or trade

No venue account is needed to see the button and the panel.

1. Load the extension (below) and set the service URL and lock key in its options.
2. Serve the preview page from this folder and open it:

   ```
   cd demo/event-lockin-extension && python3 -m http.server 8812 --bind 127.0.0.1
   open http://127.0.0.1:8812/preview/positions.html
   ```

   The page is a generic exchange-style portfolio with three open positions. The button sits beside
   the rows the service can protect; the panel prices them from live books, and a tap writes to the
   record and runs the hedge path for real (dry run unless the service is set to send). Lock only
   games you mean to put on the record.
3. On the venue itself with no positions yet, the docked **Lock in** pill bottom-right opens the
   picker, which lists every game in the window with live odds. That is the same panel.

## Files

- `manifest.json` runs the content script on the venue's domains (edit `matches` to add one) and on
  the local preview page, and grants fetch to the service host only.
- `content.js` finds position rows by text (a team the service can protect plus a dollar amount),
  places a button beside each, and renders the panel. If no row reads, a docked pill opens a game picker.
- `background.js` is the fetch proxy; it attaches `x-lock-key` from extension storage.
- `options.html` sets the service URL, lock key, default size, and the operator-only hedge line.
- `preview/positions.html` is the stand-in positions page described above.

## Service side (Render dashboard, never in git)

The lock routes are off until a key is set.

| Env | Value | Why |
| --- | --- | --- |
| `EVENT_SHADOW_LOCK_KEY` | 12+ random chars | Opens `/api/shadow/markets`, `/api/shadow/quote`, `/api/shadow/lock` to callers with `x-lock-key`. Unset answers 404. |
| `EVENT_HEDGE_STRATEGY` | `live` | Real Kalshi orders behind rails. Anything the rails hold is simulated at the book, reason on the receipt. |
| `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PEM` | from Kalshi | Service only. |
| `EVENT_HEDGE_LIVE_TICKERS` | the one ticker you will tap | Allowlist. Empty allows nothing. Listed tickers are hedged on Kalshi's own No side and skipped by the hourly scan. |
| `EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_ORDER` | `25` | Per-order cap. |
| `EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_DAY` | `20` for the first live test, then `100` | Per-day cap, counted from the receipt file, so a restart cannot reset it. The smallest lock (20 contracts) hedges about 14 Kalshi contracts; 20 leaves room for the book to move and bounds the day at about $5. |
| `EVENT_SHADOW_LOCK_LEDGER_PATH` | leave unset | Locks live in `lock-ledger.jsonl` beside the scan's ledger on the same disk. |
| `EVENT_HEDGE_LIVE_SEND` | `yes` | The only value that sends. Anything else is a dry run. |
| `EVENT_HEDGE_KILL_SWITCH` | `1` to stop | Nothing leaves, whatever else is set. |

An armed ticker is hedged on Kalshi's own No side (the venue the executor can send to), not on
whichever route was cheaper at the tap. That route is offered on fewer games than the board shows:
in the Oct 14 scan, 2 of 81 games in the window, both heavy favourites around 75c (Colts, 49ers).
So pick the game from the preflight scan, then arm it.

Sizes on that route (Oct 14 books): nothing under 20 contracts is offered (the credit is below the
minimum). At 20 contracts the Colts pay +25c and hedge 14.2 Kalshi contracts at 26c (about $3.70);
the 49ers at 26 contracts pay +32c and hedge 18.7 at 23c (about $4.31). At 50 contracts the credit
is 64c to 66c and the hedge about $9. A $15 bet at 1.33x is 20 contracts; $20 at 1.28x is 26.

Check before recording (operator token):

```
GET /api/shadow/hedges/preflight?scan=1&contracts=26        every game the Kalshi route is offered on right now, with terms
GET /api/shadow/hedges/preflight?ticker=KX...&contracts=26  balance, rails, this game's terms on that route, wouldSend
GET /healthz                                                lock.enabled true, hedge.live.dryRun false, allowlist shows the ticker
```

## Extension setup

1. Chrome, `chrome://extensions`, enable Developer mode, Load unpacked, pick this folder.
2. Open the extension's options. Set the service URL (default is the record service), paste the
   lock key, set the default size used when a row's stake cannot be read. Leave "show hedge line"
   off for a customer-facing recording; turn it on for the operator cut.
3. Open the venue's positions page. A blue **Lock in** sits beside each row the script can read. If
   none reads, a **Lock in** pill sits bottom-right and opens the picker.

## Reading the row

The venue shows a position as the team ("SF 49ers · Winner"), the multiplier ("1.28x"), the amount
and the payout. Two dollar amounts a multiplier apart are the stake and the payout; payout in dollars
is the size in $1 contracts (26 for $20.00 at 1.28x) and stake over payout is the entry price (78c).
American odds and "to win" amounts are read too. The panel shows the size it read, with an edit link
to reprice at another size before locking. After the lock the button reads "Locked · +$x paid" and
reopens the panel with the full terms.

## Recording checklist

Three clips, one tap.

1. **Venue positions page.** The open position, the button on its row. Tap. The panel prices from
   live books at that size: ends-at-worst, paid-now, ends-at-best. Tap **Lock in**. "Locked in"
   with the three numbers.
2. **Record.** `/` on the service a moment later: the position appears with `source: lock`, the
   three numbers match the panel. Operator cut: `/api/shadow/hedges` shows the live attempt, order
   id, fill, cost.
3. **Settlement.** After the game, the position's settled row on the record: the payout the holder
   got, the identity line (position plus hedge equals the terms shown at the tap).

Rules the service enforces, so plan the game around them:

- The lock must be at least 45 minutes before start and inside 7 days.
- One lock per Kalshi market. Locks live in their own ledger, so a market the hourly scan already
  shows on the record can still be locked; the public record then shows both positions. The picker
  greys out markets already locked; the panel refuses a second lock with "already locked".
- The size you hold at the venue should be the size you lock. Position and hedge settle on the
  same official result.

## Local run

```
cd services/api
EVENT_SHADOW_LOCK_KEY=local-demo-key-123 EVENT_HEDGE_STRATEGY=live \
  EVENT_HEDGE_LIVE_TICKERS=KX... npx tsx scripts/eventShadowWorker.ts
```

Point the options page at `http://localhost:8793`. Without Kalshi keys or `EVENT_HEDGE_LIVE_SEND=yes`
the hedge is a dry run; the panel, record and receipts behave the same.
