# White Swan submission: day-of checklist

Internal. Not part of the evidence folder.

## Rule

Send what proves the claim and nothing else. No code, no repo links, no operator views, no fee rule, no counterfactuals, no hedge receipts. The public track record and the public CSV are the evidence; the one sheet is the argument.

## Timing

Deadline Sep 25. Do not reset the book: a fresh book cannot hold an NFL sample by then. Thursday night (Sep 24) settles about 06:30 UTC Sep 25, so pull the evidence the morning of Sep 25 ET and the record has Week 3 settled plus Thursday, with the Week 4 Sunday slate in the open book.

## Pull the evidence (one pass, same hour)

Replace `SHADOW` with the event track record host (`atticus-event-shadow.onrender.com` unless renamed) and `DEMO` with the embed demo host (`atticus-event-demo-cross-venue.onrender.com` unless renamed). Run from any folder; these are plain downloads.

```
curl -sS -o shadow-summary-$(date -u +%F).json          https://SHADOW/api/shadow
curl -sS -o event-shadow-positions-$(date -u +%F).csv   https://SHADOW/api/shadow/positions.csv
```

Do not add `?token=` or `?scope=full` to either. The public CSV is the one we send.

Screenshots, desktop width, light background:

- `track_record.png`: `https://SHADOW/` with the identity card and the settled table in frame.
- `embed_demo.png`: `https://DEMO/` after tapping Protect on one row so the protected outcome line is visible.

## Fill the one sheet

Open `atticus_white_swan_onesheet.md` and replace every `[BRACKET]` from the track record page and the summary JSON. Then build the PDF:

```
python3 -c "import sys; sys.path.insert(0,'scripts'); from md_to_pdf import convert; convert('docs/reports/submission/white_swan/atticus_white_swan_onesheet.md','docs/reports/submission/white_swan/atticus_white_swan_onesheet.pdf')"
```

Fill the same brackets in `README.md` (links, name, email, dates in file names).

## Assemble the folder

```
white_swan/
  README.md
  atticus_white_swan_onesheet.pdf
  track_record.png
  embed_demo.png
  event-shadow-positions-[DATE].csv
  shadow-summary-[DATE].json
  atticus_shadow_facility_report_33d.pdf
```

Zip it. Send to the address on the application, or share a view-only Drive folder and paste the link in the form. Email is the default.

## Form answers (short form)

- Strategy type: market-neutral hedge layer. Not directional.
- Primary market: Kalshi.
- Track record: public, live, append-only. Link the track record.
- Evidence: attached folder.
- Ask: funded balance to run the same layer at size on Kalshi.

## Before hitting send

- Every `[BRACKET]` is gone from the PDF and the README.
- The CSV opens and the credit column sums to the one sheet's figure.
- Both live links load without a token.
- Nothing in the folder mentions venues, rules or numbers that are not on the public track record.
