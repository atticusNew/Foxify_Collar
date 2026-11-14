# NEXTPredict kit

What goes to a prospect, what stays with us, and how to rebuild the pages before a conversation. Prospects: DraftKings, Underdog, Novig, ProphetX, PrizePicks.

## Send

| File | What it is |
|---|---|
| `atticus_leavebehind.pdf` | One Letter page: the three-word pitch, six numbers to carry, the identity, why a venue adds the button, parlays, the phone, the record QR and both URLs. Every number from the live record. |
| `atticus_leavebehind_phone.png` | The same at 1080x1920 for sending from a phone. |
| `PILOT_TERM_SHEET.md` | Non-exclusive, rev share on the published take, nothing up front, 90-day league exclusivity option, payout pass-through, wind-down clause, integration in days. Bracketed values are filled at the first call. |
| `DEMO_SCRIPT_60S.md` | The phone demo, timed, with the answers to the five questions that come up. For us, not for them; here because it is the spoken form of the leave-behind. |
| `LINKEDIN_DRAFTS.md` | Three posts for days 3, 6 and 9: the record milestone, the parlay moment, what cash-out costs. Refresh the numbers the morning each goes out. |

Rules on every prospect page: no em dash; "address", never "wallet"; no venue other than the public record named; no dealers, no netting, nothing about what ships next; one flow total, no venue split. `build_leavebehind.py` refuses to write a page that breaks them.

## Keep

`internal/`: the meeting crib sheet (one row per prospect: what they are, where their orders go, why they fit, the opener, the ask, what to watch for, the links), the notes template, the data room folder structure, and the stack reference chart. Not for prospects.

## Rebuild the pages

From the repo root, with headless Chrome installed and `pip install segno` for the QR:

```
python3 docs/reports/submission/nextpredict/build_leavebehind.py            # live numbers
python3 docs/reports/submission/nextpredict/build_leavebehind.py --offline  # last saved record-<date>.json
```

Writes `atticus_leavebehind.html`, prints it to `atticus_leavebehind.pdf`, writes `atticus_leavebehind_phone.html` and screenshots it to `atticus_leavebehind_phone.png`, and saves the record snapshot beside them. The build asserts the identity holds on the live record before it prints a page that says so.

The phone pictures (`phone_*.png`) are screenshots of the embed with the placeholder brand; retake them if the product changes.

## The slates

Each prospect gets the record cut to its leagues with its name on the page, reachable only by a link we send. Configured on the shadow service (`render-event-demos.yaml`, `EVENT_SHADOW_SLATES`); this is the exact value in force:

```
wiremarkets=Wire Markets:nfl,nba,mlb,nhl,epl,ucl,mls;wagerwire=WagerWire:nfl,nba,mlb,nhl;sporttrade=Sporttrade:nfl,nba,mlb,nhl;novig=Novig:nfl,nba,mlb,nhl;draftkings=DraftKings:nfl,nba,mlb,nhl;underdog=Underdog:nfl,nba,mlb,nhl;prophetx=ProphetX:nfl,nba,mlb,nhl,epl,ucl,mls;prizepicks=PrizePicks:nfl,nba,mlb,nhl
```

Render picks up the YAML on deploy. If the dashboard value was set by hand it wins over the YAML; paste the string above into the dashboard in that case.

The links, per slate:

| | Form |
|---|---|
| Slate page | `https://atticus-event-shadow.onrender.com/slate/<slug>?k=<link key>` |
| Slate CSV | `https://atticus-event-shadow.onrender.com/slate/<slug>.csv?k=<link key>` |
| Demo in their brand | `https://event.earnandprotect.xyz/?brand=<Name>` |

The link key is derived per slate from the share key (HMAC, first 24 hex characters), so a link opens that one slate and no other. Read the ready-made links from the operator health body rather than deriving them:

```
curl -s "https://atticus-event-shadow.onrender.com/healthz?token=<operator token>" | python3 -c "import json,sys; [print(s['name'], s['shareUrl'], s['demoUrl']) for s in json.load(sys.stdin)['slates']['configured']]"
```

The public health body does not list slates. Slugs: `draftkings`, `underdog`, `novig`, `prophetx`, `prizepicks`.
