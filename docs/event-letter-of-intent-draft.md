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

## Sources

Not for pasting.

- Own sale: `services/api/src/eventCollar/crossVenue/memberSale.ts`; `docs/AGENT_HANDOFF.md` section 2, "The member-sale shape".
- "Deletes any member connection": the privacy notice in `services/api/scripts/memberAppHtml.ts`.
- Volume left blank: the public record at `https://atticus-event-shadow.onrender.com/api/shadow` (read 10 November 2026, 22:55 UTC) is a simulated scan of public markets plus the founder's own locks. It holds no data on any venue's members.
- Signing entity left blank: `docs/AGENT_HANDOFF.md` section 1 lists two entities (Atticus Trade, Inc. and a Seychelles Ltd); which one signs is a question for counsel (`docs/event-counsel-questions.md`).
- The reporting items in clause 6 exist today for the service's own record (`/api/shadow`, `refusals`); a per-venue report is not built.
