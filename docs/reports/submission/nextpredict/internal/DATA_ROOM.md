# Data room, folder structure

Internal. What a serious counterparty asks for after the first meeting, laid out so it can be shared folder by folder. Build it once; refresh the dated exports before each share. Nothing in here carries a token, a key or a venue credential.

```
atticus-data-room/
  00_README.md                  one page: what Atticus is, what is in each folder, as-of date
  01_record/
    record-<date>.json          /api/shadow, the public JSON as served (summary + public positions)
    positions-<date>.csv        /api/shadow/positions.csv, one row per position, integer cents
    ledger-<date>.jsonl         /api/shadow/export, the raw append-only ledger (operator export)
    identity-<date>.md          the identity, written out: P&L, take booked, gap, how it is derived
    perp-record-<date>.json     the perpetuals shadow record (same discipline, since July 2026)
  02_identity_tests/
    README.md                   what each test proves and how to run it (node:test, no network)
    eventCollarShadowLedger.test.ts
    eventCollarShadowCounterfactuals.test.ts
    eventCollarRuleEvidence.test.ts
    eventCollarParlays.test.ts
    test-run-<date>.txt         the test runner's output, pass counts, dated
  03_rule_evidence/
    README.md                   how a rule is pinned at open, re-read at settlement, and what "terms held" means
    sample-<ticker>.json        one settled position with its pinned rule, the settlement re-read, both hashes
    rule-changes-<date>.json    every position where the listing market edited its rules between open and settlement
  04_integration/
    overview.md                 one JSON quote in, one receipt out; the venue's shell, ledger and official result
    quote.md                    the quote: event, position, floor, cap, credit per tier, refusal sentence
    receipt.md                  the receipt: locked terms, time, the row the record will show
    settlement.md               payout pass-through: credit at the tap, floor or cap at settlement, net true-up
    sandbox.md                  how to point a sandbox at the live quote engine before production
    embed-walkthrough.pdf       screenshots of the embed in a placeholder brand, positions to receipt to parlays
  05_timeline/
    timeline.md                 dated: first perp shadow (Jul 2026), first event position (Sep 12 2026), first parlay ticket (Oct 8 2026), each public surface as it went live
    timeline.png                the LinkedIn timeline image (docs/reports/submission/linkedin)
  06_company/
    cap-table.pdf               docs/reports/submission/atticus_cap_table_final.pdf
    financials.pdf              docs/reports/submission/atticus_financial_statements_submit.pdf
    projections.pdf             docs/reports/submission/atticus_projections_submit.pdf
    unit-economics.pdf          docs/reports/submission/atticus_unit_economics_v2.pdf
  07_legal/
    counsel-memo.pdf            founder adds: who is the counterparty to the user; are we soliciting
    pilot-term-sheet.md         docs/reports/submission/nextpredict/PILOT_TERM_SHEET.md
    nda-template.pdf            mutual
```

## Where each file comes from

| File | Source | Notes |
|---|---|---|
| `record-<date>.json` | `curl -s https://atticus-event-shadow.onrender.com/api/shadow` | Public. Carries the summary, settled, open and closed positions as the public sees them. |
| `positions-<date>.csv` | `curl -s https://atticus-event-shadow.onrender.com/api/shadow/positions.csv` | Public columns. The operator's `?scope=full` adds the rule books; do not put that version in a shared folder. |
| `ledger-<date>.jsonl` | `GET /api/shadow/export` with the operator token | Raw ledger. Export with the token on the command line of your own machine, never paste the token into the room. Read it once for anything that must not be shared before copying it in. |
| `identity-<date>.md` | Write from the summary: `identity.writerPnlCents`, `identity.takeBookedCents`, `identity.gapCents`, `identity.holds` | One paragraph, the derivation from `shadowLedger.ts` (`writerPayouts`) in words. |
| `02_identity_tests/*.test.ts` | `services/api/tests/` | Copy as-is. `npx tsx --test tests/eventCollar*.test.ts` from `services/api`; paste the summary lines into `test-run-<date>.txt`. |
| `sample-<ticker>.json` | One settled position from `record-<date>.json` with both `rule` and `ruleCheck` present | The record has 16 such positions as of Oct 12. Pick one where `ruleCheck.unchanged` is true and, if there is one, one where it is false. |
| `rule-changes-<date>.json` | Filter `record-<date>.json` settled positions on `ruleCheck.unchanged === false` | Empty file is a fine answer. |
| `04_integration/*` | Write from the embed service (`services/api/scripts/eventProtectXDemoService.ts`: `/api/showcase`, `/api/close-quote`, `/api/receipts`, `/api/activity`, `/api/parlays`) | The retail payload is what a venue renders; the operator payload is ours. Document the retail one. |
| `embed-walkthrough.pdf` | Screenshots of `https://event.earnandprotect.xyz/` with no `?brand=` (placeholder "Your Exchange") | Positions, the sheet, the receipt, the parlays tab, the record link. |
| `timeline.md` | The record's `firstOpenedAt`, parlays' `firstTicketAt`, the perp record's first date, git history of the public surfaces | Dates only; no plans. |
| `06_company/*` | `docs/reports/submission/` | Already prepared for the alpha51 submission. |
| `counsel-memo.pdf` | Founder | The one document in the room Atticus does not write. |

## What stays out

- Operator tokens, share keys, the slate link keys, venue API keys, Telegram or webhook URLs.
- The full-scope CSV and the operator report (`/report`): the counterfactual rule books are ours.
- Netting measurements, dealer or RFQ material, anything about what ships next.
- Any prospect's name, slate or link. A counterparty sees its own slate and nobody else's.
