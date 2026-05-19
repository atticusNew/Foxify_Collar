# Bitcoin Protection Platform — Pilot Agreement

**Effective Date:** _______________

**Between:**

**Atticus Strategy, Ltd.** ("Provider")
and
**Foxify** ("Client")

---

## 1. Purpose

This Agreement governs a 28-day pilot evaluation of Provider's Bitcoin downside protection platform ("Platform"). The pilot allows Client to evaluate the Platform's protection capabilities on simulated and live trading positions under defined parameters and limits.

This pilot constitutes a business-to-business hedging service arrangement. It does not constitute an offer of securities, derivatives, or insurance products to Client's end users.

---

## 2. Pilot Duration

- **Start Date:** The date on which Client receives Platform access credentials and activates the first protection.
- **Duration:** 28 calendar days from the Start Date.
- **Extension:** The pilot may be extended by mutual written agreement.

---

## 3. Protection Parameters

### 3.1 Position Limits

| Parameter | Value |
|-----------|-------|
| Minimum position size | $10,000 USD notional |
| Maximum position size | $50,000 USD notional |
| Maximum aggregate active notional | $200,000 USD |
| Daily new protection cap (Days 1–7) | $100,000 USD in new activations |
| Daily new protection cap (Days 8–28) | $500,000 USD in new activations |

Provider reserves the right to adjust these limits during the pilot with 24 hours' notice to Client.

### 3.2 Protection Tiers

| Stop-Loss Level | Premium per $1,000 Notional | Payout on Trigger | Tenor |
|-----------------|----------------------------|-------------------|-------|
| 2% | $5.00 | 2% of notional | 2 days |
| 3% | $4.00 | 3% of notional | 2 days |
| 5% | $3.00 | 5% of notional | 2 days |
| 10% | $2.00 | 10% of notional | 2 days |

### 3.3 How Protection Works

- Client selects a position type (long or short), notional size, and stop-loss tier.
- A premium is charged at activation based on the schedule above.
- If BTC spot price breaches the floor price (for longs) or ceiling price (for shorts) at any point during the tenor, the protection is triggered.
- On trigger, Client is entitled to receive a fixed payout equal to the notional multiplied by the stop-loss percentage.
- If the protection is not triggered, it expires at the end of the tenor with no payout.
- Auto-renewal is available at Client's discretion. Each renewal cycle incurs a new premium.

---

## 4. Pricing & Fees

- The premium schedule in Section 3.2 is the sole cost to Client. There are no additional fees, commissions, or hidden charges.
- Premiums are fixed for the duration of the pilot and will not change based on market conditions.
- Provider's internal hedging costs, strategies, and margin economics are proprietary and not disclosed to Client.

---

## 5. Settlement & Reconciliation

### 5.1 Reconciliation Period

- Reconciliation is performed at the end of each calendar month during the pilot, or at pilot termination, whichever comes first.

### 5.2 Reconciliation Statement

- Provider will deliver an itemized reconciliation statement within 3 business days of the reconciliation date.
- The statement will include: each protection's activation date, notional amount, premium charged, trigger status, payout amount (if triggered), and net balance.

### 5.3 Net Settlement

- The reconciliation statement reflects the net amount: total premiums owed by Client minus total payouts owed by Provider.
- Settlement is due within **10 business days** of Client's receipt of the reconciliation statement.
- Settlement method: USDC transfer to a wallet address designated by the receiving party, or an alternative method agreed by both parties in writing.

### 5.4 Disputes

- Client must raise any dispute regarding a reconciliation statement within 5 business days of receipt.
- Undisputed amounts remain due per the original settlement timeline.
- Disputed amounts are resolved by mutual review of Platform logs and records, with a target resolution of 5 business days.

---

## 6. Platform Access & Security

### 6.1 Access Credentials

- Provider will issue Client an access code for the Platform.
- Client is solely responsible for safeguarding the access code and ensuring it is not shared with unauthorized individuals.

### 6.2 Responsibility for Trades

- All protections activated under Client's access credentials are Client's responsibility.
- Provider is not liable for any premiums incurred or positions opened as a result of unauthorized access caused by compromised, shared, or inadequately secured credentials.
- Client agrees to notify Provider immediately upon discovering or suspecting any unauthorized access.

### 6.3 Access Restrictions

- The Platform is for Client's internal evaluation purposes only during the pilot.
- Client shall not sublicense, redistribute, or provide Platform access to third parties.

---

## 7. Platform Reliability

### 7.1 Service Level

- Provider operates the Platform on a best-effort basis during the pilot period.
- The Platform relies on third-party price feeds and execution venues which may experience intermittent outages, latency, or degraded performance beyond Provider's control.

### 7.2 Honored Protections (Bug Clause)

- If the Platform displays a protection as active ("Protected" status) and a qualifying trigger event occurs based on verifiable market data, but the Platform fails to process the trigger or payout due to a software defect:
  - Provider will honor the payout obligation for that specific protection.
  - Client must report the discrepancy to Provider within **48 hours** of the trigger event.
  - Provider will verify the claim against Platform logs and market data. If confirmed as a Platform defect, the payout will be included in the next reconciliation statement.

### 7.3 Failed Activations

- If the Platform fails to activate a protection (due to quote error, execution failure, or venue unavailability), no protection is in effect for that position.
- Provider is not liable for losses on positions that were never successfully activated, regardless of Client's intent to protect them.
- Client should verify that each protection shows "Protected" status in the Platform before relying on it.

### 7.4 Known Limitations

- Price monitoring operates on a polling basis with up to 5-second detection intervals. Extremely rapid price movements (flash crashes recovering within seconds) may not be detected.
- Protection trigger prices are based on third-party spot price indexes, which may differ slightly from Client's exchange execution prices.

### 7.5 Maintenance & Updates

- Provider may perform maintenance, deploy updates, or apply critical fixes during the pilot.
- For planned maintenance: Provider will give Client reasonable advance notice.
- For critical fixes (security, data integrity): Provider may deploy without prior notice.
- Provider reserves the right to temporarily suspend new activations for risk management or operational reasons. Active protections will continue to be monitored and honored during any suspension.

---

## 8. Limitations of Liability

### 8.1 Liability Cap

- Provider's maximum aggregate liability under this Agreement shall not exceed the total premiums paid by Client during the pilot period.

### 8.2 Exclusions

Provider is not liable for:

- Losses arising from Client's trading decisions or market movements
- Losses on positions that are not covered by an active, confirmed protection
- Exchange outages, Deribit downtime, or third-party service interruptions
- Internet connectivity failures on Client's side
- Losses exceeding the defined payout amount for any protection (payout is capped at notional × SL%)
- Consequential, indirect, or speculative damages
- Losses caused by unauthorized access due to compromised Client credentials

---

## 9. Confidentiality

- Both parties agree to treat the terms of this Agreement, pricing schedule, Platform performance data, and any proprietary information exchanged during the pilot as confidential.
- Neither party shall disclose confidential information to third parties without prior written consent, except as required by law or regulation.
- This obligation survives termination of this Agreement for a period of 12 months.

---

## 10. Intellectual Property

- All Platform software, algorithms, pricing models, and documentation remain the exclusive intellectual property of Provider.
- This Agreement grants Client a limited, non-transferable, non-exclusive license to access and use the Platform solely for the purposes of this pilot evaluation.
- No rights to Provider's intellectual property are transferred or implied.

---

## 11. Termination

### 11.1 Voluntary Termination

- Either party may terminate this Agreement with **24 hours' written notice** (email is sufficient).

### 11.2 Effect of Termination

- On termination, no new protections may be activated.
- Active protections at the time of termination will run to their natural expiry. Trigger monitoring and payout obligations remain in effect for active protections.
- All outstanding settlement obligations survive termination and remain due per Section 5.

### 11.3 Termination for Cause

- Either party may terminate immediately if the other party materially breaches this Agreement and fails to cure within 5 business days of written notice.

---

## 12. Pilot-to-Production

- This pilot does not constitute a commitment by either party to enter into a production engagement.
- If both parties agree to proceed to production, terms will be negotiated separately. Production terms may include adjusted pricing, expanded limits, SLA commitments, and additional integration requirements.
- Provider may incorporate learnings from the pilot into adjusted production pricing without obligation to maintain pilot rates.

---

## 13. General Provisions

### 13.1 Governing Law

This Agreement shall be governed by and construed in accordance with the laws of _________________.

### 13.2 Entire Agreement

This Agreement constitutes the entire understanding between the parties regarding the pilot and supersedes all prior discussions and agreements.

### 13.3 Amendments

Amendments to this Agreement must be in writing and signed by both parties. Adjustments to position limits (Section 3.1) may be communicated via email with mutual acknowledgment.

### 13.4 Notices

All notices under this Agreement shall be delivered via email to the addresses below and are effective upon confirmed receipt.

### 13.5 Independent Contractors

The parties are independent contractors. Nothing in this Agreement creates a partnership, joint venture, employment, or agency relationship.

---

## Signatures

**Atticus Strategy, Ltd.**

Name: _________________________
Title: _________________________
Date: _________________________
Email: _________________________

**Foxify**

Name: _________________________
Title: _________________________
Date: _________________________
Email: _________________________

---

## Schedule A — Reconciliation Statement Template

| # | Protection ID | Date | Type | Notional | SL% | Premium | Triggered | Payout | Net |
|---|--------------|------|------|----------|-----|---------|-----------|--------|-----|
| 1 | abc123... | Apr 15 | Long | $10,000 | 2% | $50.00 | No | $0.00 | -$50.00 |
| 2 | def456... | Apr 15 | Long | $50,000 | 2% | $250.00 | Yes | $1,000.00 | +$750.00 |
| | | | | **Totals** | | $300.00 | | $1,000.00 | |

**Net Due to Client:** $700.00
**Settlement Due By:** [Date + 10 business days]
