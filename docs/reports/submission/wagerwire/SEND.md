# Sending the WagerWire sheet: the morning of

Everything in the message is something they can click. Do the four checks, then send.

## 1. The morning rerun (five minutes)

Prices move; the sheet is dated to the minute and the Chiefs leg sits right at the edge of the band we quote (9.8c tonight; under 9.5c it rounds to 9c and both Chiefs rows refuse). Rerun so the numbers are that morning's:

```
cd services/api && npx tsx scripts/wagerwireListingsQuote.ts
```

then from the repo root:

```
python3 -c "import sys; sys.path.insert(0,'scripts'); from md_to_pdf import convert; convert('docs/reports/submission/wagerwire/atticus_wagerwire_listings.md','docs/reports/submission/wagerwire/atticus_wagerwire_listings.pdf')"
```

Read the console summary. Two numbers in the message come from it: the lead row (the one that beats the ask; if a different row does that morning, use it) and "Five of the ten quote" (use the morning's count). If no row beats the ask, the second sentence of paragraph two becomes the morning's best row, worst case and if-it-hits, and the message still stands: a firm number beside an ask nobody is bidding on.

## 2. The listings are still listed

Open the ten `sourceUrl`s in `listings.json`. A listing that has sold or been pulled comes out of the JSON (and the rerun) before sending. A changed ask gets the new number. This is a person opening pages, never a script.

## 3. The demo link goes to their slate

Merge #228 if it is not merged. On Render, `atticus-event-demo-cross-venue` must carry `EVENT_SHADOW_SLATE_KEY` with the same value as `atticus-event-shadow`. Check, without touching the value:

- `https://atticus-event-demo-cross-venue.onrender.com/healthz` shows `"brandRecordLinks":"slate"`.
- Open `https://atticus-event-demo-cross-venue.onrender.com/?brand=WagerWire` in a private window. The partner row reads "WagerWire record" and "Partner console", nothing else. Click "WagerWire record": the page says "prepared for WagerWire" and shows games settled on NFL, NBA, MLB, NHL only. Copy that URL from the address bar; that is the record link for the message. Never paste the key anywhere else.

## 4. The PDF

Open `atticus_wagerwire_listings.pdf`. Page one is the table. The timestamp is this morning's. No bracketed placeholders. Attach it; do not paste it into the body.

## 5. The mockup

The rerun also writes `listing_lock_mockup.html`; make the PNG with the command the script prints (headless Chrome). Open `listing_lock_mockup.png`: the card's numbers (pays, ask, lock, credit) match the lead row of this morning's page, and the phone shows outcomes and dollars only. Attach it as a second file; it is a picture of how the button sits in their UI, not a demo, so do not describe it as live.

## What to send

Four things: the message, the PDF attached, the mockup PNG attached, two links in the body.

- Demo in their brand: `https://atticus-event-demo-cross-venue.onrender.com/?brand=WagerWire`
- Their record (copied from the demo's "WagerWire record" link in step 3)

Do not send the full public record, the receipts page or the full board. They can find them; the point of the branded links is that everything they click has their name on it.

## The message

To Zach Doctor (CEO). If you have a warmer path to Travis Geiger (CXO) or Guy Dotan (COO), send to one and copy none; a cold email to three people is a mailing list.

Subject: Ten of your listings, with a firm number next to each ask

> Zach,
>
> I read ten listings on your public pages last night. All ten show no bid. Eight are a parlay with every leg hit but one, which makes each a single position on one future, and that is the shape we price.
>
> The attached page puts our number beside each ask: what the market says the ticket is worth, what the seller is guaranteed if they tap, what they end with if the leg hits, and the credit paid at the tap. On the DraftKings Chiefs 2-leg, listed at $210 with no bid, the lock pays $233.47 whatever happens and $519.07 if Kansas City wins. Five of the ten quote; the page says plainly why the other five do not.
>
> Every lock is hedged leg for leg on Polymarket or Kalshi in the same second, so we carry no outcome risk and earn a stated take, whichever way the game goes. You said your power users already hedge remaining legs on Kalshi. This is that, inside your app, for every seller who lists and hears nothing.
>
> It runs as JSON endpoints and one button on the listing row; there is nothing to integrate on your side beyond rendering it, and nothing to pay. The hedge, the balance sheet and the liquidity are ours. The second attachment is a picture of how that button and the seller's sheet would sit on one of your listing cards, with the Chiefs numbers on it.
>
> Here it is in your brand, on live prices, with a record of every game we have priced this way since September: [demo link]. Your record: [record link].
>
> Twenty minutes this week or next? If it is useful, a read-only feed of your listings lets us run this on your whole board instead of the ten I could read by hand.
>
> Michael Ting
> Atticus · michael@atticustrade.com

Replace the two bracketed links with the URLs from step 3. Nothing else in the message is a placeholder.

## LinkedIn version (if email bounces)

> Zach, I priced ten of WagerWire's public listings last night, all with no bid. On the DraftKings Chiefs 2-leg listed at $210, our lock pays $233.47 whatever happens, $519.07 if KC wins, hedged on Polymarket in the same second. One page, your brand, live prices: [demo link]. Twenty minutes?

## If they reply

- "How do you make money": the stated take, netted out of every credit, plus a time charge on long-dated hedges; both are on every row of the page. The record shows our settled P&L equals the take we booked, to the cent.
- "Why no bids on those": do not speculate about their marketplace. "A firm floor is what we offer when there is no buyer. It does not replace a sale; it is the number a seller sees while waiting for one."
- "Can you do two legs left": no, and say so. "We hedge one market at a time. Two legs is a product we would be guessing at. We refuse rather than guess; it is on the page."
- "Can we see this on our whole board": yes, with a read-only listing feed. Nothing reads their pages by machine; their terms forbid it and we comply.
- "What about Wire Markets": the same button on an exchange position, which is what the demo already is. `?brand=Wire%20Markets` renders it in that brand with its own record.

## Follow-up dates

- Around 2026-11-01: the Dodgers World Series leg and the Ohtani awards resolve. Mark those rows (`settleListing`) and send what the lock paid against what the ask would have paid.
- February 2027: the Super Bowl rows.

## Other venues

The same sheet for another marketplace is a new `listings.json` and a flag:

```
npx tsx scripts/wagerwireListingsQuote.ts --listings docs/reports/submission/<venue>/listings.json --out docs/reports/submission/<venue> --marketplace "<Venue>"
```

Conditions: the listings are public and read by a person; the remaining leg is a market Polymarket lists (the script reads Polymarket books today; a Kalshi route for the remaining leg is a small addition); one leg left. For an exchange rather than a marketplace (Sporttrade, Novig, Kalshi, Polymarket, Wire Markets when live) the equivalent is already built: the branded demo with `?brand=` and the venue's slate page from `EVENT_SHADOW_SLATES`, plus the last-leg card on the record for parlays.
