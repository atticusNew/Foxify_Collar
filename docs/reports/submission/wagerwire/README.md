# WagerWire: your listings, priced

What we hand WagerWire before the first conversation: ten of their own public listings with our lock beside the seller's ask, then, as the legs resolve, what the lock paid against what the ask would have paid.

## Contents

| File | What it is |
|---|---|
| `listings.json` | The listings as a person read them on `wagerwire.com/for-sale/<id>`: book, legs, legs remaining, ask, highest bid, payout, resolution date, the page URL and the time it was read. Hand-entered. The one remaining leg names the Polymarket event slug and outcome it is hedged on. |
| `atticus_wagerwire_listings.md` / `.pdf` | The page: one table, every listing, the quoted ones with the lock beside the ask, the refused ones with the reason in plain words. Built from the JSON and live books. |
| `listings-quoted-<date>.json` | Every row of that run in integer cents: mark, fair, floor, cap, credit, take, carry, hedge shares and outlay, refusal code and detail. |
| `listing_lock_mockup.html` / `.png` | The UI mockup: their listing card with one extra button, the Lock, and the sheet the seller sees after the tap (two endings, cash paid now). Drawn from the lead quoted row of the same run, so its numbers match the page. The caption beside the phones shows the partner the one JSON quote they render the button from. |

## Rebuild before a conversation

From `services/api`:

```
npx tsx scripts/wagerwireListingsQuote.ts
```

then from the repo root:

```
python3 -c "import sys; sys.path.insert(0,'scripts'); from md_to_pdf import convert; convert('docs/reports/submission/wagerwire/atticus_wagerwire_listings.md','docs/reports/submission/wagerwire/atticus_wagerwire_listings.pdf')"
```

and the mockup PNG with the command the script prints (headless Chrome; the `--user-data-dir` keeps it off any open browser profile):

```
google-chrome --headless=new --disable-gpu --hide-scrollbars --user-data-dir=/tmp/chrome-mock-profile --window-size=1240,900 --screenshot=docs/reports/submission/wagerwire/listing_lock_mockup.png file://$PWD/docs/reports/submission/wagerwire/listing_lock_mockup.html
```

The mockup is a picture, not a demo: nothing on it is clickable, and the retail copy on the phone names outcomes and dollars only. Venue names and the hedge appear in the partner caption beside the phones, never on the seller's screen.

Prices move every hour; the page is dated to the minute. Carry is 50 bps per month on the hedge outlay (`EVENT_LISTING_CARRY_BPS_PER_MONTH`); the minimum-credit rule is the live book's (`EVENT_X_MIN_CREDIT_CENTS`, `EVENT_X_MIN_CREDIT_BPS`).

## Adding or refreshing a listing

Open the listing page in a browser, read it, and type it into `listings.json`. Update `readAt`. Every amount is integer cents. If a listing's ask or bid changes, change it here and rerun; the quoted JSON keeps the history by date.

**Nothing reads WagerWire by machine.** Their Terms of Service prohibit automated access and data gathering, and their browse index loads from an `/api/` path their `robots.txt` disallows. The script reads only Polymarket's public APIs. If WagerWire gives us a listing feed, that is the moment this becomes a continuous shadow; until then it is a person and a page.

## When the legs resolve

`settleListing(row, result)` in `src/eventCollar/crossVenue/listingQuote.ts` marks a quoted row against the official result: what the lock paid, what the ask would have paid, what the ticket did naked, and the writer's result (take plus carry, whichever way it went). Dodgers and the Ohtani singles resolve around 2026-11-01; the Super Bowl tickets in February 2027.

## How to check the identity

On any quoted row: `(100 - cap) x contracts - hedgeCost - fees - credit = take + carry`. The writer earns the published take and the stated carry and nothing on the outcome. The test `tests/eventCollarListingQuote.test.ts` asserts it on both results.
