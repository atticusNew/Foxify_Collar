# Evidence folder: Atticus for White Swan Predicts

This folder is what we send with the application. Read the one sheet first; everything else is the evidence behind its numbers.

## Contents

| File | What it is |
|---|---|
| `atticus_white_swan_onesheet.pdf` | One page: what the product is, what the record shows, how to verify it. |
| `track_record.png` | Screenshot of the public track record at the end of the record window, identity card visible. |
| `embed_demo.png` | Screenshot of the embedded demo with one protected row. |
| `event-shadow-positions-2026-09-22.csv` | The public positions export, 403 rows. One row per position: what was quoted, what was hedged, what settled. Every amount in integer cents. |
| `atticus_shadow_facility_report_33d.pdf` | The perpetual-futures version of the same layer, for reference. Same identity, different market. |

## How to read the CSV

- One row per protected position. `status` is `open` or `settled`. Every `_c` column is integer cents.
- `contracts` and `mark_c` are the position as held before protection; `contracts × mark_c` is the stake.
- `floor_c` and `cap_c` are the protected outcomes at settlement, per contract. `credit_c` is what the user was paid at quote time.
- Settled rows carry `result`, `holder_protected_c` (what the user ended with), `holder_naked_c` (what they would have ended with unprotected) and `holder_delta_c` (the difference).
- Sum `credit_c` over all rows to reproduce "Credit paid to users" on the one sheet ($899.33 on 2026-09-22). Sum `contracts × mark_c` to reproduce the stake protected ($33,321.00).

## How to check the identity

On settled rows, sum `writer_pnl_c` and sum `take_c`. They are equal ($69.39 and $69.39 on the 330 rows settled by 2026-09-22). That is the whole claim: the layer earns its published take and nothing on the outcome. The take is already netted out of every credit a user sees.

## One disclosure

The terms rule was tightened on 2026-09-20: a minimum credit was added, below which a quote is refused rather than offered. Positions before that date were quoted under the earlier rule and are marked as such in the record. Every position, before and after, settled against the official result under the terms it was quoted at; the identity holds across both.

## Live links

- Track record: https://atticus-event-shadow.onrender.com/
- Positions CSV: https://atticus-event-shadow.onrender.com/api/shadow/positions.csv
- Embedded demo: https://atticus-event-demo-cross-venue.onrender.com/

All are public while the book is open. Positions in the demo are simulated at live prices; nothing is bought.

## Contact

Michael William · michael@atticustrade.com
