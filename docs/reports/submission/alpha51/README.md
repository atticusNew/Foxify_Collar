# One sheet: Atticus for Alpha51

One Letter page for a visual reader who wants the gist in a skim and the whole thing in two minutes. Every number on it comes from the public record at build time and is saved beside the page, so the PDF can be rebuilt and the figures can be checked against the record.

## Contents

| File | What it is |
|---|---|
| `atticus_onesheet.pdf` | The page. Send this. |
| `atticus_mockup.png` | Three phones on one card (positions list, the Lock in sheet, the Parlays tab) for a message, a slide or a chat where a PDF is clumsy. |
| `atticus_onesheet.html`, `atticus_mockup.html` | The sources the PDF and PNG are printed from. |
| `record-<date>.json` | The `/api/shadow` and `/api/shadow/parlays` summaries the page was built from. |
| `phone_positions.png`, `phone_sheet.png`, `phone_locked.png`, `phone_parlays.png` | Phone-size screenshots of the embedded demo, default brand ("Your Exchange"), light skin, 390 by 800 at 3x. |
| `atticus_wordmark_gold.png` | The wordmark, extracted from the embed's data URI. |
| `build_onesheet.py` | Builds all of the above. |

## What to send

The PDF, plus the two links already printed on it:

- Demo: https://atticus-event-demo-cross-venue.onrender.com/ (add `?tab=parlays` for the parlays tab)
- Track record: https://atticus-event-shadow.onrender.com/

If the conversation is in a chat rather than email, `atticus_mockup.png` carries the same picture without opening a file.

## Rebuild

From the repo root, with headless Chrome installed:

```
python3 docs/reports/submission/alpha51/build_onesheet.py            # pulls live numbers, saves record-<date>.json
python3 docs/reports/submission/alpha51/build_onesheet.py --offline  # last saved snapshot, no network
```

The script refuses to print a page if the identity on the live record does not hold, and refuses any output containing an em dash or the word "wallet".

Retake the phone screenshots only if the embed changes. Run the demo locally (`EVENT_X_SHADOW_URL` pointed at a shadow worker, see `services/api/scripts/eventProtectEmbedHtml.ts`), open it headless at 390 by 800 with device scale 3, and capture: the positions list, the list with one Lock in sheet open, the list after a lock, and `?tab=parlays`. Keep the default brand so no venue is named on the page.

## What the page does and does not claim

- Every figure in "The record" and the parlay line is the live summary at the timestamp in the footer. Reprinting later changes the numbers; the saved snapshot shows what was printed.
- "Gap $0" is the identity on settled positions: writer P&L equals take booked, to the cent. The script asserts it before writing.
- The phones show the demo. Positions and parlay tickets there are simulated at live prices; nothing is bought. The footer says so.
- No venue is named on the phones. Kalshi and Polymarket are named only as the hedging venues of the public record, which is where the record settles.
- Nothing on the page says what a click on the demo or the record would contradict.

## Contact

Michael William, founder · michael@atticustrade.com
