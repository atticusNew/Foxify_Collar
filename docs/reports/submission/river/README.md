# One sheet: Atticus for River Markets

One Letter page for an execution layer, not a venue and not a holder: what the other side of retail protection looks like by venue and by week, where the screens cannot fund it, and how a relationship with River would run in sequence (now, next, later). Every number comes from the public record at build time and is saved beside the page, so the PDF can be rebuilt and each figure checked against the record.

Oscar Levy (CEO) asked, after the first note, whether the trader executes an OTC trade with us. The answer sent: no; the holder keeps the position on the exchange, the lock is a term on it, we buy the other side on the exchange's book. This page is the follow-up he asked for in place of a deck.

## Contents

| File | What it is |
|---|---|
| `atticus_river_onesheet.pdf` | The page. Send this. |
| `atticus_river_onesheet.png` | The same page as an image, for a chat where a PDF is clumsy. |
| `atticus_river_onesheet.html` | The source the PDF is printed from. |
| `record-<date>.json` | The `/api/shadow`, `/api/shadow/parlays` and `/api/shadow/scoreboard?weeks=4` bodies the page was built from. |
| `phone_positions.png` | The live demo's positions list at phone size, default brand ("Your Exchange"), 390 by 800 at 3x. |
| `atticus_wordmark_gold.png` | The wordmark. |
| `build_onesheet.py` | Builds the page, the PDF and the preview, and refuses to print when a rule below fails. |
| `SEND.md` | The covering email. |

## Rebuild

From the repo root, with headless Chrome installed:

```
python3 docs/reports/submission/river/build_onesheet.py            # pulls live numbers, saves record-<date>.json
python3 docs/reports/submission/river/build_onesheet.py --offline  # last saved snapshot, no network
```

Rebuild on the day you send so the numbers match the record that day. Retake `phone_positions.png` only if the demo changes (headless Chrome at 390 by 800, device scale 3, on https://event.earnandprotect.xyz/).

## What the script refuses to print

- A page whose identity does not hold on the live record (singles: writer P&L equals take booked; parlays: the settled identity), so the "Gap" figure is never asserted on a day it is false.
- An em dash, or the word "wallet".
- A venue named within sixty characters of "partner", and any of the promise words: "will route", "committed", "commit to", "guarantee", "exclusive". The page offers a sequence, not a commitment.
- A "Now" step that names River. We route through our own router today; River appears in "Next" and "Later" only. The RFQ is the "Later" step.
- A page that runs past 11 inches. The preview is rendered on a tall canvas with the clip off and measured; the build fails if content sits below the page edge.

## What the page does and does not claim

- The venue table is the last full New York week on the scoreboard (the current week is partial). Kalshi prices 100% of the time because the positions are Kalshi markets, so its own book is always there; the caption says so. Polymarket is priced on the older two-book path, which records the winner and no per-venue asks, so its availability cell is n/a and the caption says why.
- "N had one book able to price the other side" is the positions put to every venue less those with a priced runner-up (availability n minus edge n). It names no venue as thin; the table carries the per-venue figures for the reader who wants them.
- No dollar P&L or take figure is on the page; the identity is stated as the gap on settled positions. The cost of the floor is given as a percentage of stake (realized, with quoted beside it). Tap counts are not on the page; the footer says the record is simulated except the taps.
- The parlays column is drawn only when a venue won a parlay lock that week; parlay locks priced before the router recorded a venue show in the count and not in the table.
- "Positions on the record are simulated at live prices except the taps" is the footer's disclaimer, and the record's own methodology says the same.
- Venues are named in the open, as on the public scoreboard, because the reader is an execution layer. No venue is called a partner.
- Nothing on the page says what a click on the record, the scoreboard or the demo would contradict.

## Contact

Michael William, founder · michael@atticustrade.com
