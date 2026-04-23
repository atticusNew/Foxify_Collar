# Foxify Protect Pilot

**Effective Date:** _______________

**Between:**
Atticus Strategy, Ltd. ("Atticus")
and
Foxify ("Foxify")

---

## 1. Overview

This document sets out the working commercial terms for the Foxify Protect pilot between Atticus and Foxify.

The purpose of the pilot is to allow Foxify to evaluate a protection feature powered by Atticus across selected trading flows and positions, using the limits, pricing, and settlement process described below.

This pilot is a business-to-business arrangement. It is not an offer of securities, derivatives, insurance, or any other regulated financial product to Foxify users.

---

## 2. Pilot Term

- **Start Date:** the date Foxify receives pilot access and activates the first protection.
- **Pilot Period:** 28 calendar days from the Start Date.
- **Extension:** the pilot may be extended by mutual written agreement, including by email.

---

## 3. Scope

### 3.1 Pacing — Hedge Budget Caps (cumulative)

Atticus's real-money hedge spend during the pilot is capped on a cumulative basis to ensure responsible scale-up:

| Period | Cumulative hedge spend cap (Atticus real cost) |
|---|---|
| Day 1–2 | $100 USD |
| Day 3–7 | $1,000 USD (cumulative from Day 1) |
| Day 8–21 | $10,000 USD (cumulative from Day 1) |
| Day 22–28 | No additional cap (within the position limits below) |

Position limits apply throughout the pilot:

| Parameter | Value |
|---|---|
| Minimum position size | $10,000 USD notional |
| Maximum position size | $50,000 USD notional |
| Maximum aggregate active notional | $200,000 USD |

When a hedge budget cap is reached, new protections may be paused until the next period begins or until existing protections expire. Atticus will notify Foxify when a cap is approached.

Atticus may adjust these limits during the pilot with at least 24 hours' notice to Foxify.

### 3.2 Protection Tiers

Pricing is locked for the duration of the 28-day pilot at the schedule below. All tiers settle on a 1-day tenor.

| Stop-Loss Level | Premium per $1,000 Notional | Payout on Trigger | Tenor |
|---|---|---|---|
| 2% | $7.00 | 2% of notional | 1 day |
| 3% | $5.00 | 3% of notional | 1 day |
| 5% | $3.00 | 5% of notional | 1 day |
| 10% | $2.00 | 10% of notional | 1 day |

### 3.3 Protection Flow

- Foxify selects position type, notional size, and stop-loss tier.
- The applicable premium is charged when protection is activated.
- If the relevant BTC trigger level is reached during the tenor, the protection is triggered.
- If triggered, the payout equals notional × stop-loss percentage.
- If not triggered, the protection expires at the end of the tenor with no payout.
- Each renewal or new activation is a separate protection with its own premium.

---

## 4. Pricing and Settlement

### 4.1 Pricing

The premium schedule in Section 3.2 is locked for the pilot. No other fees apply unless agreed in writing. Atticus's internal hedging strategy and venue economics remain proprietary.

### 4.2 Reconciliation

Atticus will provide a reconciliation statement at the end of each calendar month during the pilot, or at the end of the pilot if earlier. Each statement will show the activation date, notional amount, premium, trigger result, payout amount, and net amount due for each protection.

### 4.3 Settlement

- Net settlement = total premiums owed by Foxify minus total payouts owed by Atticus.
- Settlement is due within 10 business days after Foxify receives the reconciliation statement.
- Settlement is in USDC unless the parties agree otherwise in writing.

### 4.4 Disputes

- Foxify must raise any dispute within 5 business days after receiving a statement.
- Undisputed amounts remain payable on the original timeline.
- Disputes are resolved using platform logs, venue (Deribit) transaction records, and the agreed market reference, in good faith.

---

## 5. Access and Responsibilities

### 5.1 Access

Atticus provides the access credentials. Foxify keeps them secure and notifies Atticus immediately if compromised. Foxify is responsible for activity under its credentials.

### 5.2 Confirmed Protection

A protection is in effect when **both** of the following are true:

1. The platform shows the protection as Protected or Active, AND
2. The hedge order has been confirmed by the execution venue (Deribit).

If a discrepancy arises (e.g., the platform shows Protected but the venue has no matching order confirmation), the parties will resolve it using the venue's transaction logs and the platform's audit trail in good faith. Where both records exist and confirm a protection, Atticus stands behind the protection's intended outcome under this pilot.

---

## 6. Platform Operation

### 6.1 Service Basis

The pilot is provided on a best-efforts basis. The service depends on third-party price feeds, infrastructure, and execution venues that may experience outages, delays, or degraded performance.

### 6.2 Market Verification

Whether a trigger event has occurred is determined using the agreed market reference together with platform records and venue transaction logs. Where there is a question about a trigger or settlement outcome, the parties rely on objective market data and transaction records.

### 6.3 Venue Failures

If the execution venue (Deribit) fails to fill, executes incorrectly, or experiences a delay or error during a protection's lifecycle, the protection's settlement outcome is determined by the actual venue execution records (including failed and partial fills). Atticus is not liable for venue-side failures beyond what can be reconstructed from venue logs.

### 6.4 Service Interruptions, Corrections, and Maintenance

If a disruption affects platform operation (including third-party service issues), the parties work in good faith using available platform and venue records to determine the outcome that most accurately reflects the protection's intended behavior under this pilot. Atticus may correct records to reflect what should have happened, or void affected entries that cannot be reasonably reconstructed. Atticus may perform maintenance and may temporarily pause new activations for technical or risk reasons; existing active protections continue to be handled per this pilot.

---

## 7. Liability

Atticus's total liability under this pilot is capped at the total premiums paid by Foxify during the pilot. Atticus is not responsible for trading losses, exchange outages, third-party failures, connectivity issues on Foxify's side, losses on positions that were not actively protected, or indirect, consequential, incidental, or special damages.

---

## 8. Confidentiality

Both parties treat the terms of this pilot, pricing, performance data, and non-public business or technical information shared in connection with the pilot as confidential. Neither party shares that information with third parties unless required by law or agreed by the other party. Confidentiality applies for 12 months after the pilot ends.

---

## 9. Intellectual Property

Atticus retains ownership of its platform, software, models, and algorithms. Foxify retains ownership of its brand, customer relationships, and the Foxify Protect presentation layer. This pilot does not transfer ownership of either party's IP.

---

## 10. Ending the Pilot

- Either party may end the pilot with 24 hours' written notice (email is sufficient).
- No new protections may be activated after termination.
- Active protections continue until expiry; related payout and settlement obligations remain in effect.
- Either party may terminate immediately for material breach not cured within 5 business days after notice.

---

## 11. General

This document is governed by the laws of England and Wales, with exclusive jurisdiction of the courts of England and Wales. Any changes must be agreed in writing (email is sufficient).

---

## Signatures

| Atticus Strategy, Ltd. | Foxify |
|---|---|
| Name: _________________________ | Name: _________________________ |
| Title: _________________________ | Title: _________________________ |
| Date: _________________________ | Date: _________________________ |
| Email: _________________________ | Email: _________________________ |

---

## Schedule A — Pilot Statement

This schedule is a simple summary of pilot activity and settlement for the applicable reconciliation period.

### Pilot Summary

| Item | Value |
|---|---|
| Reconciliation Period | _________________________ |
| Statement Date | _________________________ |
| Settlement Due By | _________________________ |
| Net Amount Due | _________________________ |

### Pilot Activity Summary

| Protection ID | Date | Position | Notional | Premium | Payout | Net Result |
|---|---|---|---|---|---|---|
| __________________ | __________ | __________ | __________ | __________ | __________ | ____________________ |
| __________________ | __________ | __________ | __________ | __________ | __________ | ____________________ |
| __________________ | __________ | __________ | __________ | __________ | __________ | ____________________ |

### Statement Totals

| Item | Amount |
|---|---|
| Total Premiums | _________________________ |
| Total Payouts | _________________________ |
| Net Amount Due | _________________________ |

### Settlement Terms

- Settlement is due within 10 business days after receipt of this statement unless the parties agree otherwise in writing.
- Any dispute should be raised within 5 business days after receipt.
- Undisputed amounts remain payable per the settlement timeline in this pilot.
