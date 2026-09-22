# White Swan submission: day-of checklist

Internal. Not part of the evidence folder.

## Rule

Send what proves the claim and nothing else. No code, no repo links, no operator views, no fee rule, no counterfactuals, no hedge receipts. The public track record and the public CSV are the evidence; the one sheet is the argument.

## Timing

Deadline Sep 25. Submitting Sep 22: the one sheet and README are filled from the record as of 2026-09-22 20:45 UTC (403 positions, 330 settled, 73 open). Do not reset the book. If you pull the CSV on a later day, refill the one sheet's table from that day's page so the CSV and the PDF agree; the numbers move every settlement.

## Pull the evidence (one pass, same hour)

Run from any folder; this is a plain download.

```
curl -sS -o event-shadow-positions-$(date -u +%F).csv   https://atticus-event-shadow.onrender.com/api/shadow/positions.csv
```

Do not add `?token=` or `?scope=full`. The public CSV is the one we send. Do not send `/api/shadow` (the summary JSON): it carries the counterfactual tiers and fee rules per position, which are not for the folder. The CSV reproduces every number on the one sheet on its own.

Screenshots, desktop width, light background:

- `track_record.png`: `https://atticus-event-shadow.onrender.com/` with the identity card and the settled table in frame.
- `embed_demo.png`: `https://atticus-event-demo-cross-venue.onrender.com/` after tapping Protect on one row so the protected outcome line is visible.

## The one sheet

`atticus_white_swan_onesheet.md` is filled as of 2026-09-22 and `atticus_white_swan_onesheet.pdf` is built from it. To rebuild after a refill:

```
python3 -c "import sys; sys.path.insert(0,'scripts'); from md_to_pdf import convert; convert('docs/reports/submission/white_swan/atticus_white_swan_onesheet.md','docs/reports/submission/white_swan/atticus_white_swan_onesheet.pdf')"
```

## Assemble the folder

```
white_swan/
  README.md
  atticus_white_swan_onesheet.pdf
  track_record.png
  embed_demo.png
  event-shadow-positions-2026-09-22.csv
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
- The CSV opens, has 403 rows plus the header, and `credit_c` sums to $899.33; on settled rows `writer_pnl_c` and `take_c` both sum to $69.39. If the CSV was pulled later and the sums differ, refill the one sheet from that day's page and rebuild the PDF.
- Both live links load without a token.
- Nothing in the folder mentions venues, rules or numbers that are not on the public track record.
