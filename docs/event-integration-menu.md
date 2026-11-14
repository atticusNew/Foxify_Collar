Draft for the founder's review. Not sent. 10 November 2026.

# Earn & Protect: three ways to put Lock in on your venue

All three use one shape. The holder sells part of their position on your venue, in their own account. That cash is the floor. The cap is that cash plus $1 for each contract kept. We hold nothing and fund nothing.

## A. Link to your own sell ticket

Status: not built.

- **You do:** nothing, beyond confirming the link format of your sell ticket.
- **We do:** show floor, cash now and cap, then link the holder to your ticket.
- **The user sees:** our Lock in line, then your ticket, where they confirm the sale.
- **Needs:** a stable link to a market's sell ticket. No account access. We cannot see the fill, so our numbers are a quote, not a receipt.
- **You earn:** the order and your trading fees. **We earn:** nothing, unless you pay a referral fee on a tagged link: [founder to fill: fee].

## B. Connected app (the model we built on STX)

Status: built, working in STX's demo environment, no real money yet.

- **You do:** let a member connect our app to their account, with consent given on your own page.
- **We do:** host the Lock in page in your colours. Read the member's positions. Offer three choices: sell 40%, 60% or 80%. On the tap, place one limit order to sell. Cancel whatever has not filled after about 3 seconds.
- **The user sees:** their positions with floor, cash now and cap, and one tap. Funds stay in their account with you.
- **Needs:** an app agreement. Five permissions: read profile, balance, positions and orders, and place orders. A published privacy notice. Tokens stored sealed, deleted on disconnect.
- **You earn:** the order and your fees. **We earn:** nothing today. A builder fee per order: [founder to fill: fee].

## C. Lock in button on your own page

Status: a demonstration exists (simulated positions, live prices). Your side is not built.

- **You do:** add a Lock in line to each row of your positions list. Ask us for the three numbers. Place the member's sale through your own order path.
- **We do:** price the lock, keep the record, report to you.
- **The user sees:** Lock in inside your page.
- **Needs:** a service agreement, your own product review and disclosures, and terms for our use of your prices. No member login reaches us.
- **You earn:** the order, your fees, and the feature under your brand. **We earn:** a fee per lock or a licence fee: [founder to fill: fee].

Two other shapes need a signed agreement at any level: our bid for the holder's contracts, and a floor, credit and cap on your ledger.

## Sources

Not for pasting.

- Own sale: floor, cap and the 40%, 60%, 80% choices: `SALE_SHARE` in `services/api/src/eventCollar/crossVenue/memberSale.ts`.
- Level B as built: `services/api/src/eventCollar/crossVenue/memberApp.ts` (`MEMBER_DEFAULT_SCOPES`: `profile.read balance.read portfolio.read orders.read orders.write`); `MEMBER_APP_ORDER_WAIT_MS`, default 3000 milliseconds, in `services/api/scripts/eventShadowWorker.ts`; the privacy notice in `services/api/scripts/memberAppHtml.ts` (sealed tokens, deleted on disconnect).
- "Demo environment, no real money": `docs/AGENT_HANDOFF.md` sections 4 and 6.
- Level A not built: no code on the event branch builds a link to a venue's sell ticket. The member page links only to a venue's event page (`services/api/scripts/memberAppHtml.ts`).
- Level C demonstration: `services/api/scripts/eventProtectEmbedHtml.ts`, whose footer reads "Demonstration only. Simulated positions at live prices; nothing is bought."
- "We earn nothing today" under own sale: `docs/AGENT_HANDOFF.md` section 9, "STX member sale: nothing today."
- Naming STX to another venue: the founder should confirm STX is content with that before this is sent.
