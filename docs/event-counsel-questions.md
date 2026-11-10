Draft for the founder's review. Not sent. 10 November 2026.

# Earn & Protect: questions for a lawyer

This is a list of questions for a lawyer. It is not legal advice and it reaches no conclusion. It was written from the code and the company's own documents by someone who is not a lawyer. Where a legal term appears, it is there to help counsel find the point, not to answer it.

**The product in four sentences.** A person holds a position on a regulated event market: a contract that pays $1 if a team wins and $0 if it loses. They tap Lock in. "Win it all or lose it all" becomes a floor and a cap. There are three ways to deliver that, in the order the founder approved them: own sale, better bid, collar.

**Where things stand.** Only the founder is a holder today. Outside users may be added at any time, so these answers are wanted before that. The public record is simulated. A small number of the founder's own locks used real money.

Each question below gives the facts, why it matters, and what we would change depending on the answer.

## 1. Own sale, with a fee per trade

**Facts.** The holder connects their own venue account to our page, with consent given on the venue's page. Our page works out three choices (sell 40%, 60% or 80% of the position), shows one of them first as the default, and on the tap our server places one limit order to sell in the holder's account. We hold no money and take no position. Today we charge nothing. The plan is a referral or builder fee per trade, paid by the venue.

**Questions.**
1. Is this the work of a passive software provider, or is it soliciting or accepting orders for pay, which may need registration (for example as an introducing broker)?
2. We work out the size to sell and show a default. Is that trading advice for pay?
3. Does the answer change with who pays (the venue or the holder), or with how (per trade, flat monthly, share of the venue's fee)?
4. Does it change if the holder types the order into the venue's own ticket from our link, instead of our server placing it with their consent?
5. CFTC Staff Letter 26-25 on passive software providers: does it cover this, and on what conditions?

**Why it matters.** Own sale is the default shape and the per-trade fee is the commercial ask to every venue.

**What we would change.** Charge the venue a flat licence fee instead of a per-trade fee. Show all three choices with no default. Move to a plain link to the venue's ticket. Or let the venue run the button on its own page as its own feature.

## 2. Better bid

**Facts.** Not built. Where another venue prices the other side cheaper, we would bid for the holder's contracts on their venue at a price above the best bid there, and buy the other side on the other venue. One of the two pays $1 at settlement, so our result is the same whichever side wins. We would be trading for our own account on both venues.

**Questions.**
1. We show the holder our bid in our app, then they sell into it. Is that a pre-arranged or non-competitive trade under the CFTC's rules or the venue's?
2. To count as competitive, does the venue need a request-for-quote path, or a minimum time our bid must rest on the open book where anyone can take it?
3. Does trading this way make us a dealer or market maker that must register, or that needs the venue's market-maker agreement?
4. Can we take a fee from the venue on a trade where we are also the buyer?

**Why it matters.** This is the first shape where we earn from the trade itself and put our own money at risk between two venues.

**What we would change.** Use only a venue's request-for-quote path. Rest the bid for whatever time counsel names. Offer the shape only on venues with a signed agreement. Or drop it.

## 3. Collar

**Facts.** Built. We promise the holder a floor, pay a credit at the tap and keep the winnings above the cap. We buy the other side on another venue as our hedge. The code works out who owes what, but it moves no money, and nothing collects the slice above the cap from a winning holder. The founder has decided this shape runs only on a signed venue agreement, with the venue's ledger doing the collecting.

**Questions.**
1. Under a venue agreement, is the collar the venue's product with us as a supplier, or are we the counterparty to the venue's user?
2. If we are the counterparty: what is this contract in law when the user is a retail person, and what would we need to offer it?
3. What must the agreement and the venue's rules say for the venue to be the provider? Does the venue need to file or certify anything?
4. Our draft pilot term sheet says we provide "pricing and hedging software" and the venue "remains the provider to its users". We would also hold the hedge in our own accounts. Is "software" still a fair description?
5. The service can already accept a second holder's key on this path. Should any outside person use it before a venue agreement exists?

**Why it matters.** It is the only shape with a take of our own built in, and the one where we owe a user money.

**What we would change.** Keep it off for anyone but the founder until an agreement is signed. Let the venue hold the hedge. Rewrite the term sheet.

## 4. Accounts and entities

**Facts.** Two companies exist: Atticus Trade, Inc. (US) and a Seychelles Ltd. We have accounts and live keys on four venues. The repo does not say in whose legal name each account stands: [founder to fill: for each venue, the account holder's legal name and whether it is a personal or company account]. On one venue our hedge sits in a subaccount of the holder's own account. That venue netted the two sides in one account and paid the hedge out early. Some hedges go through a routing partner's system using our own trading key.

**Questions.**
1. Which company should hold each hedge account, sign each venue's terms and sign a venue agreement?
2. A hedge account must not sit under a holder's own login. What separation is needed (legal owner, login, funding source) before any outside holder is added?
3. When the holder and the hedge are the same person on the same market, on one venue or across two, is that a wash trade or self-dealing problem, even in a test?
4. Does company trading through a personal account breach a venue's terms?
5. When an order goes through a routing partner with our key, who is the venue's customer?

**Why it matters.** Today the founder is on both sides. That stops being a test the day a second person is added.

**What we would change.** Open company accounts. Move the hedge out of any holder's account. Turn on the setting that refuses to hedge on the venue the holder stands on. Pause real-money tests where the account is personal.

## 5. User terms, privacy and risk disclosure

**Facts.** We have two privacy notices and no terms of use or risk disclosure. The browser extension's notice says it "never acts on the venue: it places no orders" and that "The lock is a contract with the Atticus service; the hedge behind it is the service's own." That describes the collar only. The hosted page does place orders in the member's account, with consent, and its own notice says so. Each page carries one line: "Protection by Atticus, a third party; not a product of" the venue.

**Questions.**
1. What terms of use and risk disclosure are needed before an outside user, for each shape?
2. What must a user be told about the cap, a partial fill, a sale that cannot be undone and the venue's fee?
3. Do the words "Protect", "Protection" and "floor" raise insurance or guarantee questions? The brand is Earn & Protect.
4. Is "a contract with the Atticus service" a sentence we want in public?
5. We store sealed connection tokens, a session cookie kept 180 days and lock records, and we publish each lock in neutral words. Which privacy laws apply and what is missing?

**Why it matters.** These pages are what a user reads. One of them is out of date for the default shape.

**What we would change.** Write the terms and the disclosure. Correct the extension's notice. Change words on the pages.

## 6. Showing venue prices to a third party

**Facts.** Our reports and a "pairs" page put prices from several venues side by side for an outside trading firm. Our public record keeps venue prices and rule text, with links to the source. Prices come from public addresses, from keys issued for our accounts, and from a routing partner's feed. One venue's live stream would run on a key the founder now holds (built, awaiting merge).

**Questions.**
1. Do each venue's data and API terms allow us to show, store or pass on its prices to a third party, for business use?
2. Is the answer different for a public address and for a keyed stream?
3. Are numbers we work out from those prices (a spread, a cost) treated the same as the prices?
4. Do the routing partner's terms allow what we do with its feed?
5. May a key issued to one account holder be used by a company's service, if the two are not the same legal person?

**Why it matters.** The institutional reports are a second line of business and rest on other people's data.

**What we would change.** Show only our own worked-out numbers. Delay prices. Take a data licence. Remove a venue from third-party reports.

## 7. During a game

**Facts.** On the hosted page a member can Lock in during a game, on by default, so far only in a venue's test environment. On the hedged path the same is built and awaiting merge: open from seven days before the start to four hours after it, with our hedge bought first and whole or not at all. It has been tested against a scripted venue only. Once a game has started, a hedged lock cannot be left early.

**Questions.**
1. Do CFTC rules, venue rules or state rules treat orders placed during a game differently?
2. What must the user be told when a price can move within seconds and an order may not fill?
3. If we ever show a score or a game clock, do league data rights apply?
4. Is "cannot be left early once the game has started" a term that needs its own disclosure?

**Why it matters.** It is the feature we lead with to venues.

**What we would change.** Turn it off per venue (`EVENT_X_IN_PLAY=0`, `MEMBER_APP_IN_PLAY=0`). Add disclosure. Shorten the window.

## 8. Parlays by request for quote

**Facts.** On one venue, a member will be able to sell part of a parlay at any leg through the venue's request-for-quote path. Our code asks the venue for a quote and the member accepts it. The venue has not shipped the path yet, so our code is built to an assumed shape, and it switches itself on when the venue ships. On other venues a parlay can be locked only at the last pick.

**Questions.**
1. Is asking for a quote on a member's behalf, and passing on their acceptance, anything more than the own sale in question 1?
2. Do the venue's quote rules need the member to see more than one quote, or a minimum quote life?
3. Should a feature that turns itself on when a venue changes have a person sign it off first?

**Why it matters.** The answer to question 1 may not carry over to a negotiated trade.

**What we would change.** Set `MEMBER_APP_COMBO_RFQ=0` until signed off. Add the venue's required steps.

## 9. State by state

**Facts.** We rely on each venue's own checks of who may trade. Our event pages and services have no location check of their own. An internal note records that states and tribes contest federal authority over these markets.

**Questions.**
1. If a state acts against a venue, does a third-party app that sends orders to it carry its own exposure?
2. Should we check location ourselves, and for which shapes?
3. Does the answer differ between own sale (the user's own order) and the collar (our contract)?

**Why it matters.** It may come up in any venue or investor talk.

**What we would change.** Add a location check. Limit shapes by state.

## 10. The simulated record in sales material

**Facts.** We quote a public record of simulated positions to venues and investors. Each page says what is real (prices, terms, results) and what is simulated (the positions).

**Question.** Carried over from the September map: do performance advertising rules apply, and what wording is required?

## Where this list differs from earlier documents

- `docs/AGENT_HANDOFF.md` section 4 says the business-to-business path "is clean" and the direct-to-consumer path "is a counsel question". This list does not treat the first as settled: questions 1 and 3 ask it.
- `docs/reports/submission/nextpredict/internal/prediction-market-stack-reference.md` tells the founder to know "why we are not soliciting trades". Question 1 asks whether a per-trade fee changes that.
- `docs/REGULATORY_PASSIVITY_MAP.md` (18 September 2026, on the perp branches only, not on the event branch) describes a front-end variant in which the user places their own orders. It says "none of this is proposed for build" and that the variant would never pre-select terms. Own sale is now built, is the default, and does show a default choice. Its five questions for counsel still stand. Questions 1 and 10 here restate two of them.
- `docs/reports/submission/nextpredict/PILOT_TERM_SHEET.md` is written for the collar with a share of our take. Own sale is now the default and has no take. Its "software" wording is question 3.4.
- `demo/event-lockin-extension/PRIVACY.md` is out of date for own sale (question 5).

## Blanks for the founder

- [founder to fill: for each venue, the account holder's legal name and whether it is a personal or company account] (question 4).
- [founder to fill: the lawyer's name and firm, and whether the venues may be named to them].
- [founder to fill: whether the Seychelles company plays any part in the event product].

## Sources

- The three shapes and their order: the founder's brief for this pack, 10 November 2026. Own sale in code: `services/api/src/eventCollar/crossVenue/memberSale.ts` (`SALE_SHARE` 0.4, 0.6, 0.8); the default choice: `defaultTier` in `services/api/scripts/eventShadowWorker.ts`.
- Better bid not built: no code for it on the event branch or on pull requests #398 to #405.
- Collar, what the code does and does not do with money: `cashDue` in `services/api/src/eventCollar/crossVenue/shadowLedger.ts`; `handleCash` in `services/api/scripts/eventShadowWorker.ts`.
- Lock keys for more than one holder: `EVENT_SHADOW_HOLDER_KEYS` in `services/api/src/eventCollar/crossVenue/lockGate.ts`.
- Two companies: `docs/AGENT_HANDOFF.md` section 1. Venue accounts and keys: section 4, and the founder's brief of 10 November 2026.
- Hedge in the holder's own account, netted and paid early (30 October 2026): `demo/event-lockin-extension/README.md`, the row for `EVENT_HEDGE_SAME_ACCOUNT_VENUES`.
- Privacy notices: `demo/event-lockin-extension/PRIVACY.md`; `memberPrivacyHtml` in `services/api/scripts/memberAppHtml.ts` (tokens sealed, cookie 180 days, public record in neutral words). The one-line notice: same file and `demo/event-lockin-extension/content.js`.
- No terms of use or risk disclosure: none found on the event branch.
- During a game: `MEMBER_APP_IN_PLAY` and `EVENT_X_IN_PLAY` in `render-event-demos.yaml`; `lockWindow.ts` on pull request #400 (open); the body of pull request #400 for "tested against a scripted venue".
- Parlays: `MEMBER_APP_COMBO_RFQ` in `render-event-demos.yaml` on pull request #402 (open): auto by default, the venue's path answers "not found" today, shape assumed.
- No location check: a search for one (geofence, geoblock, country headers) in `services/api/scripts/event*.ts`, `services/api/scripts/memberAppHtml.ts` and `services/api/src/eventCollar/` finds nothing.
- States and tribes: `docs/reports/submission/nextpredict/internal/prediction-market-stack-reference.md`.
- Real and simulated wording on the record page: `services/api/scripts/eventShadowHtml.ts`.
- CFTC Staff Letter 26-25: named in `docs/AGENT_HANDOFF.md` section 4 and in the September map. The letter's text was not read for this list.
