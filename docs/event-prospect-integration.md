Draft for the founder's review. Not sent. 12 November 2026.

Note to the founder, to delete before sending: send this only after an NDA is signed. A lawyer
reads the NDA and the fee line first. This is not legal advice.

# Lock in on Prospect: what it takes

To: [addressee]
From: Michael, Atticus Trade, Inc.

## What the customer sees

A Lock in line on an open position, during the game, when the price allows it. Three numbers:
the cash now, the total if the team wins, and the share of the stake returned. One tap confirms.

## Who does what

| Step | Prospect | Atticus |
| --- | --- | --- |
| Show the line on a position | Prospect's app | |
| Work out the three numbers and the order | | Atticus, from the contract, the contracts held and the price paid |
| Send the order | Prospect's app, as the customer's own order, the way it sends every order | |
| Hold the account and the money | Prospect's clearing firm, as today | |
| Measure what it does | | Atticus, reported to Prospect |

Atticus never has a customer's login, never holds money and never sends an order.

## Step 1: shadow, 30 days, no change to the platform, no charge

Prospect sends a daily file of fills. Atticus returns the tables of the page already shared,
worked on Prospect's own customers, with one thing added: whether an account that could have
taken its stake back, and one that could not, came back to trade.

One row per fill:

| Field | Meaning |
| --- | --- |
| account | a scrambled account number, the same for the same account every day. No name, no email |
| contract | the exchange's symbol |
| side | buy or sell |
| contracts | the quantity |
| price | the price paid or received |
| time | to the second, UTC |

Delivery: [founder to fill with Prospect: a daily file in a shared folder, or a feed].

## Step 2: live pilot, a small share of customers

Prospect's app asks Atticus for the numbers when it shows a position, and sends the customer's
order on the tap. Atticus needs: where the line goes in the positions list, the app's order
rules (limit orders, fractions of a contract, the smallest order), and one contact on product
and one on compliance. Customers with the button are measured against customers without it.

Length: [founder to fill]. Share of customers: [founder to fill]. Fee: [founder to fill, after
counsel: a flat monthly fee].

## Step 3: rollout

A flat platform fee that steps up with the number of locks a month. [founder to fill, after the
pilot.]

## Open points for Prospect to answer

1. Can a customer close part of a position in the app today, during a game?
2. Does a new feature in the app need the sign-off of the exchange or the clearing firm?
3. Can fills with scrambled account numbers be shared under the NDA?

## Sources

Not for pasting.

- "Their button, their order": the design in the brief, `/lockin/brief` section 9
  (`services/api/src/sportsVenues/briefHtml.ts`). It is level C of
  `docs/event-integration-menu.md` with the order sent by Prospect's app and not by ours.
- The three numbers: `lockTerms` in `services/api/src/sportsVenues/lockMath.ts`; shown today on
  `/lockin/lock`.
- Nothing in steps 1 or 2 is built for Prospect yet: no intake for a fills file, no quote
  service with a partner's key. The replay that step 1 would run exists
  (`services/api/src/sportsVenues/tapeReplay.ts`).
- Flat fee and not a per-trade fee: `docs/event-counsel-questions.md`.
