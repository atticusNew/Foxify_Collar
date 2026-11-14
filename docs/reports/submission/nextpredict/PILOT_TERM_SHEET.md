# Pilot term sheet

Atticus protection layer, embedded in [Venue]'s app. Non-binding; a basis for the pilot agreement.

| Term | Proposal |
|---|---|
| Parties | Atticus (William Ting Capital) and [Venue] |
| Product | A **Lock in** action on positions the user already holds on [Venue]: a floor, a cap and a cash credit paid at the tap; on parlays, the lock offered at the last pick only |
| Scope | Pilot on [leagues], [Venue]'s app, [Venue]'s users. Other leagues and markets by written addition |
| Exclusivity | Non-exclusive. Option, at [Venue]'s election within 30 days of go-live: 90-day exclusivity on [one league] against other venues of the same kind, renewable by agreement |
| Fees to [Venue] | None up front. No minimum. No integration fee |
| Revenue share | [50]% of the published take on every protected position originating on [Venue], paid monthly against the record's export. The take is published per position at quote time and never changes after the tap |
| Pricing | Terms (floor, cap, credit, take) quoted live from public books at the moment of the tap and locked at the tap. Atticus quotes; Atticus never changes a locked term |
| Refusals | When the market cannot fund a credit, Atticus refuses the quote and records the refusal. No position is protected at terms the public books do not support |
| Settlement | [Venue]'s official result settles the protection. Rule text pinned at open, re-read at settlement; a rule edit by the listing market is recorded and surfaced |
| Payout pass-through | [Venue] pays the credit to the user on its own ledger at the tap and pays the floor or cap at settlement. Atticus settles the difference with [Venue] net per [day or week]: the credit paid, the floor topped up when the position lost, the cap slice collected when it won. Atticus never holds user funds; there is no custodial rail |
| Outcome risk | Atticus carries no outcome risk and shows it: on the public record, Atticus's P&L on settled positions equals the published take to the cent. [Venue] carries no outcome risk on protected positions either |
| Limits | During the pilot: [250] contracts per position, [$X] credit per user per day, [$Y] open protection across the venue. Raised by written agreement |
| Integration | One JSON quote request in, one receipt out, [Venue]'s brand, [Venue]'s UI shell. Sandbox against the live quote engine first, then production. Target: first lock in production within [10] working days of signature |
| Data | Atticus receives position, side, size and the venue's user reference. No name, email, payment or device data. Atticus publishes aggregates only; [Venue] is named only with written consent |
| Reporting | A slate page for [Venue]: the record cut to its leagues, reachable by a link held by [Venue] alone. Monthly statement: positions, credits paid, take, share due, identity check |
| Term | 90 days from go-live, renewable in 90-day terms by agreement |
| Wind-down | Either party on 30 days' written notice. From notice: no new locks; every open protection runs to settlement at its locked terms; the final net settles within [10] days of the last position settling |
| Liability | Each party liable for its own ledger. Atticus liable for a locked term it fails to honour at settlement; capped at the take earned under the agreement in the prior [12] months, save for fraud or wilful default |
| Regulatory | Atticus provides pricing and hedging software and a settlement statement to [Venue]. [Venue] remains the provider to its users under its licences. Each party bears its own compliance; either may suspend new locks on 24 hours' notice on regulatory grounds, with open protections running to settlement |
| Confidentiality | Mutual. The record's public aggregates are not confidential; [Venue]'s name on them is |
| Governing law | [State], [Venue]'s choice from Delaware, New York or its home state |

Contact: Michael William, michael@atticustrade.com.

Bracketed values are proposals to be filled at the first call. Everything outside brackets is how the product already runs on the public record.
