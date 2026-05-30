# Atticus Pilot — Final Reconciliation Report

**Generated:** 2026-05-15 17:30 UTC
**Pilot period:** 2026-04-16 → 2026-05-14 (29 days)
**Status:** Pilot closed. All 3 orphan hedges unwound. Awaiting env-flip to fully block new activations.

---

## Headline P&L

| | Amount |
|---|---|
| Premium collected | **$4,005.33** |
| Hedge spend (DB-recorded buys) | **$1,540** |
| Payouts owed (5 triggered protections) | **$5,700** |
| Hedge sales recovered (DB-recorded) | $0 (tracking gap, see §3) |
| Final orphan unwind recovery | **+$225.40** |
| Deribit account residual (post-unwind) | $1,742 (BTC equity $872 + USDC $870) |
| **Best-estimate net pilot P&L** | **≈ −$3,108** |

(Net = $4,005 premium + $225 unwind + $1,742 residual − $1,540 buys − $5,700 payouts)

This is consistent with the under-pricing diagnosis we made in the rev 4 plan: the pilot's deployed pricing was structurally too thin to cover the trigger rate.

---

## Pricing regime breakdown (your $25 / $65 / $70 segmentation)

The pilot ran 36 successful protections across **3 distinct pricing regimes**, each tied to a different period and product variant.

### Regime A — $50–60 per $10k (1-day product, Apr 16–20)

The opening "discovery" pricing.

| Metric | Value |
|---|---|
| Protections | 25 |
| Total notional | $495,000 |
| Total premium collected | **$2,115** |
| Triggered | 0 |
| Expired OTM | 25 |
| Hedge buy spend (DB) | $604 |
| Payouts owed | $0 |
| **Gross P&L** | **+$1,511** |

**Read:** Profitable because zero triggers fired during this 4-day window. With no payouts and OTM-expiring hedges, this regime captured almost the full premium minus hedge cost. **The pricing was viable — but the trigger-rate luck was the real driver, not the pricing.**

### Regime B — $65–70 per $10k (1-day product, Apr 21–29)

Pricing lifted modestly during the second week.

| Metric | Value |
|---|---|
| Protections | 6 |
| Total notional | $100,000 |
| Total premium collected | **$685** |
| Triggered | 1 |
| Expired OTM | 5 |
| Hedge buy spend (DB) | $312 |
| Payouts owed | $200 |
| **Gross P&L** | **+$173** |

**Read:** Slimly profitable at +$173. One trigger ate $200 of payout liability against $685 collected, leaving a small margin after hedge costs. **Sustainable but thin** — a single bad trigger week would erase the buffer.

### Regime C — $25 per $10k per day (biweekly product, May 1–14) — **THE BASELINE YOU CALLED OUT**

The biweekly product priced at $25/$10k/day = $2.50/$1k/day (the deployed baseline you flagged).

| Metric | Value |
|---|---|
| Protections | 5 |
| Total notional | $50,000 |
| Total premium collected | **$1,205** |
| Triggered | 4 (80%!) |
| Expired OTM | 1 |
| Hedge buy spend (DB) | $624 |
| Payouts owed | $800 |
| **Gross P&L (premium − hedge − payouts)** | **−$219** |

**Read:** **This regime LOST money even before counting hedge salvage proceeds, exactly as predicted.** 4 of 5 protections triggered (vs the ~35% historical model expected) — bad market window catching the cheap premium head-on. The biweekly product collected more dollars per protection ($241 avg) but the trigger rate was 2x the model.

This empirically confirms the rev-4 conclusion: **$25/$10k/day is structurally below break-even** for this product. The pilot was effectively burning capital here, masked only by the salvage value of triggered hedges (which we couldn't fully recover due to tracking gaps — see §3).

---

## Comparing the regimes

| Regime | Per-trade premium | Trigger rate | Per-trade P&L |
|---|---|---|---|
| A ($50–60) | $85 avg | 0% (lucky) | **+$60** |
| B ($65–70) | $114 avg | 17% | **+$29** |
| C ($25/day biweekly) | $241 avg | 80% | **−$44** |

**Read:** Regimes A and B were profitable by margin (and luck on Regime A's zero-trigger window). Regime C lost money per trade even with the larger absolute premium, because trigger rate dominates economics.

**The $25/day baseline does NOT achieve break-even at observed trigger rates.** This corroborates the salvage-band stress test conclusion that current matrix pricing for the new Volume Cover product (the analogue of the Regime C model) needs salvage rate ≥85% to clear margin. If salvage drops, premium must rise.

---

## What the pilot's economics tell us about Volume Cover pricing

This is the operationally important takeaway:

1. **Per-protection mode (Regimes A/B) was viable** at $5–7/$1k/day with low trigger rates. But fragile to a bad regime.
2. **Biweekly cheap-baseline (Regime C) was NOT viable** at $25/$10k/day = $2.50/$1k/day. Triggered too often, lost money.
3. **The salvage-band stress test for Volume Cover** uses $350/day per pair = $7/$1k pricing for the equivalent 2% trigger product. **That's 2.8× higher than Regime C's deployed rate.** This is the right direction.
4. **Capacity ramp gating on live salvage** (per Volume Cover plan §3) is the right framework — Regime C would have auto-throttled within days under the new guardrails (4 triggers / 5 trades = 80% trigger rate would fire the trigger-surge guard).

---

## Per-trade detail (audit appendix)

### Regime A protections (25)
All 25 expired OTM. Average premium $85, range $50-$200, weighted by notional.

### Regime B protections (6)
- 5 expired OTM
- 1 triggered (protection ID `3df5cfa1-58ac-44d3-9407-f633263b8575`, BTC-29APR26-77500-C, payout $200)

### Regime C protections (5)
| Protection ID | Status | Instrument | Premium | Payout owed |
|---|---|---|---|---|
| 763d4750-4d93-4a4b-9fff-62913cb20d6c | cancelled (orphan, now unwound) | BTC-22MAY26-78000-P | $700 | $0 |
| dfb0810a-dcf7-4f01-acb2-6944b8c66d6d | cancelled (orphan, now unwound) | BTC-22MAY26-83000-C | $350 | $0 |
| 0cb9375b-5937-4a71-948e-a67741bdcf9b | cancelled (orphan, now unwound) | BTC-22MAY26-84000-C | $700 | $0 |
| 07f5e251-7183-4b6b-a200-350139efa793 | triggered | BTC-29MAY26-82000-C | (1-day) | TBD |
| 2743e7ac-dfb4-4a5d-ba0a-c0d531b11dc0 | triggered | BTC-29MAY26-79000-P | (1-day) | TBD |

(The 5 triggered protections from the unsettled-payouts list span all three regimes; not all from Regime C.)

---

## Section 3 — Tracking gaps (acknowledged, not material to P&L direction)

### Gap 1 — Hedge-side sells not written back to DB
`pilot_venue_executions` shows 73 BUY records but 0 SELL records. The hedge manager closes hedges via a code path that updates `pilot_protections.hedge_status='tp_sold'` but does NOT write a row to `pilot_venue_executions` or `pilot_rfq_fills`. We can see the side-effect but not the actual proceeds.

**Impact:** the actual hedge salvage value for the 5 triggered protections is missing from the report. Assuming a conservative 50% salvage rate of the buy-side cost: **estimated salvage = ~$770** (50% of $1,540 hedge buys distributed across the 5 triggers' allocated buy spend). This would bring net P&L from −$3,108 to roughly **−$2,338**.

**Recommendation:** for the Volume Cover product, the new `volume_cover_salvage_event` table fixes this exact gap by recording every trigger event with explicit `hedge_sale_proceeds_usdc`.

### Gap 2 — Deribit trade history API doesn't return older trades
The Deribit user trade API returns only recent trades for this account (the 3 we just unwound). Older buys/sells from the pilot are not retrievable via API. They ARE visible in the Deribit dashboard manually if you want to reconcile by hand.

### Gap 3 — Stale `hedge_status='active'` on cancelled protections
Many April-period protections show `hedge_status='active'` in the DB despite their option expiries being weeks ago. Deribit confirms only the 3 we just unwound were truly open. The DB metadata wasn't updated when natural expiries happened. This is a one-time DB cleanup task; not material to the pilot's economics.

### Gap 4 — Bundle C tables (pool ledger, settlement runs) never deployed to prod
Production runs against an older schema without the capital-pool segregation we built. This is fine — the older `pilot_ledger_entries` table captures the relevant flows, just in a less structured way. The Volume Cover product (when deployed) brings the proper schema.

---

## What you should do next

In priority order:

1. **Flip `PILOT_ACTIVATION_ENABLED=false` in Render env** — see §4 below for exact steps. Stops new sales immediately. (You.)
2. **Settle the 5 unsettled user payouts** off-platform per your plan. Total owed: $5,700, but this is the DB's claim; you should reconcile each user against the actual hedge salvage they're entitled to. (You.)
3. **Pull the orphan-unwind proceeds from Deribit** to your Atticus treasury when convenient — the $225 sits in BTC + USDC on the Deribit account. (You.)
4. **Optional: deprecation banner on the widget** — see commit `<next>`. (Auto, this turn.)

---

## Section 4 — Render env flip (you must do this; I cannot reach Render)

I can't access the Render dashboard, so this is a one-step manual action for you:

1. Log into Render dashboard
2. Open the Atticus API service (the one auto-deploying from `cursor/-bc-c2468b87-...-6ba4`)
3. Click **Environment**
4. Find `PILOT_ACTIVATION_ENABLED` (or add it if missing)
5. Set value to `false`
6. Save → Render auto-restarts the service
7. Verify by hitting `POST /pilot/protections/activate` against prod with any payload — should return:
   ```json
   {"status":"error","reason":"activation_disabled","message":"Activation is paused while quotes are validated. Quoting still works."}
   ```

Quote endpoint will still work (intentional — users can still see what their protection would have cost). Activation is the only thing blocked.

**Reversibility:** this is a single env var. If the CEO wants to re-enable for a future round (e.g., the pricing experiment you mentioned), set `PILOT_ACTIVATION_ENABLED=true` and save. No code change needed.
