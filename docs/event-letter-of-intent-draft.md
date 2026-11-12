Draft for the founder's review. Not sent. 10 November 2026.

Note to the founder, to delete before sending: this is not legal advice. A lawyer reviews it before it goes to anyone. Every commercial term is a blank.

# Letter of intent: Lock in pilot (non-binding)

Date: [founder to fill: date]
Between: [founder to fill: our signing entity, after counsel confirms which] ("Atticus") and [addressee: venue's legal name] (the "Venue").

**1. Purpose.** The parties intend to run a small pilot of Lock in for the Venue's members. Lock in lets a member who holds a position swap "win it all or lose it all" for a floor and a cap.

**2. Scope.** Markets: [founder to fill: leagues or markets]. Members: [founder to fill: who may use it, and how many]. Integration level: [founder to fill: A, B or C from the integration menu]. During a game: [founder to fill: allowed or not, per the Venue's rules].

**3. Shape.** The pilot uses own sale. The member sells part of their position on the Venue, in their own account. That cash is the floor. The cap is that cash plus $1 for each contract kept. Atticus holds no member funds, takes no position and funds nothing. Any other shape needs a separate written agreement.

**4. Expected volume.** [founder to fill: range, or delete this line]. Atticus's public record is a simulation, not a forecast of what the Venue's members will do.

**5. Fees.** Fee paid to Atticus on trades it originates: [founder to fill: fee, basis and who pays]. Costs: each party bears its own, unless: [founder to fill].

**6. Data and reporting.** Atticus reports to the Venue [founder to fill: how often]: locks offered, locks taken, contracts sold, cash to members, and requests refused with the reason. Atticus uses Venue data only to price and report the pilot. Pilot locks on Atticus's public record, with no name or account number: [founder to fill: yes or no].

**7. Term and exit.** Start: [founder to fill]. Length: [founder to fill]. Either party may end the pilot by written notice of [founder to fill: notice period]. On exit, Atticus disconnects and deletes any member connection it holds. Under own sale nothing stays open between the parties: each member's sale is already done.

**8. Confidentiality and exclusivity.** [founder to fill, with counsel: whether to include either, and on what terms].

**9. Non-binding.** This letter records intentions only. It creates no obligation on either party to proceed, to pay or to deal only with the other. Neither party is bound until both sign a definitive written agreement. Either may stop talks at any time with no liability to the other.

Signed for Atticus: [founder to fill: name and title]
Signed for the Venue: [addressee: name and title]

## Variant for a broker (Prospect Markets)

Added 12 November 2026. Prospect is not a venue. Its customers trade on Crypto.com's exchange and their accounts are held by a clearing firm. Use the letter above with these clauses in place of the ones of the same number. Every commercial term is still a blank, and a lawyer still reads it first.

Between: [founder to fill: our signing entity] ("Atticus") and [addressee: Prospect's legal name, and whether the registered broker signs too] (the "Platform").

**1. Purpose.** The parties intend to measure, and then to pilot, Lock in for the Platform's customers. Lock in lets a customer who holds a position take back the stake, or part of it, by selling part of the position, and keep the rest.

**2. Scope.** Step one, shadow: for [founder to fill: 30 days], the Platform gives Atticus its customers' fills with account numbers scrambled, and Atticus reports what Lock in would have returned and which accounts traded again. Nothing changes on the Platform. Step two, live pilot: the Platform's app shows Lock in to [founder to fill: share of customers] in [founder to fill: leagues]. During a game: [founder to fill: allowed or not, per the Platform's and the exchange's rules].

**3. Shape.** The customer sells part of their own position on the exchange, in their own account. The Platform's app sends that order as it sends every order. Atticus supplies the numbers shown to the customer and the size of the order. Atticus holds no customer funds, has no customer login, sends no order and takes no position.

**5. Fees.** Step one: none. Step two: a flat fee of [founder to fill] a month. Atticus is paid nothing per trade or per contract. After the pilot: [founder to fill: a flat platform fee in tiers by locks a month, or "to be agreed"].

**6. Data and reporting.** Atticus uses the Platform's data only to produce the reports for the Platform. It receives no customer name or contact detail. Atticus reports to the Platform [founder to fill: how often]: locks offered, locks taken, contracts sold, cash to customers, and whether those accounts traded again against accounts without the button. Either party may publish figures from the pilot only with the other's written consent.

**7. Term and exit.** Start: [founder to fill]. Either party may end by written notice of [founder to fill]. On exit, Atticus deletes the Platform's data within [founder to fill] days. Nothing stays open between the parties: each customer's sale is already done.

**8. Confidentiality, use and exclusivity.** [founder to fill, with counsel. To raise: (a) each party keeps the other's information confidential; (b) the Platform does not use what Atticus discloses about when Lock in is shown and how an order is sized to build or commission the same feature, during the pilot and for [founder to fill] after it; (c) whether the name "Lock in" is licensed for the pilot; (d) exclusivity: none proposed.]

## Sources

Not for pasting.

- Own sale: `services/api/src/eventCollar/crossVenue/memberSale.ts`; `docs/AGENT_HANDOFF.md` section 2, "The member-sale shape".
- "Deletes any member connection": the privacy notice in `services/api/scripts/memberAppHtml.ts`.
- Volume left blank: the public record at `https://atticus-event-shadow.onrender.com/api/shadow` (read 10 November 2026, 22:55 UTC) is a simulated scan of public markets plus the founder's own locks. It holds no data on any venue's members.
- Signing entity left blank: `docs/AGENT_HANDOFF.md` section 1 lists two entities (Atticus Trade, Inc. and a Seychelles Ltd); which one signs is a question for counsel (`docs/event-counsel-questions.md`).
- The broker variant follows the design in the meeting brief (`/lockin/brief`, section 9) and `docs/event-prospect-integration.md`. Its clause 8(b) is the one protection for the method that a contract can give; whether it is enforceable as worded is counsel's call.
- The reporting items in clause 6 exist today for the service's own record (`/api/shadow`, `refusals`); a per-venue report is not built.
