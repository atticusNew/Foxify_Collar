# Atticus Pilot — Final Exit Assessment

**Generated:** 2026-05-15
**BTC index at assessment time:** $81,328
**Source of truth:** Production Postgres + Deribit live API (read-only pulls)
**Status:** Read-only assessment complete; awaiting operator approval before any unwind orders execute.

---

## TL;DR

- **3 orphan hedges still open on Deribit** (matches your "two or three"). All ±2% protections; protection rows already cancelled by user; hedges left in market. All expire **May 22 (7 days)**. All OTM.
- **Total live mark value: ~$293** (at mid) or **~$293 at best BID**.
- **If we do nothing**: high probability all 3 expire worthless → **$0 recovered**.
- **Recommendation**: SELL ALL 3 NOW at limit ≥ best BID, recover ~$293, exit clean.
- **Separate finding to flag**: 5 triggered protections owe **$5,700** in user payouts that have not been settled. This is a separate workstream from the orphan unwinds.
- **Pilot life-to-date P&L estimate**: roughly **−$3.4k** (premiums collected $4,005, hedges spent $3,372, payouts owed $5,700, account residual $1,640).

---

## Section 1 — The 3 orphan hedges (action item)

All three are long-volatility positions where the trader-side protection was closed but the Atticus-side hedge was never sold.

### 1.1 BTC-22MAY26-78000-P (PUT)

| | |
|---|---|
| Protection ID | `763d4750-4d93-4a4b-9fff-62913cb20d6c` |
| Tier / SL | SL 2% / $20k notional |
| Closed by | user_close on 2026-05-10 |
| Hedge bought | 0.2 BTC @ 0.01675 BTC ($1,362 per contract = $272 total) on 2026-05-07 |
| Current state | 0.2 BTC long @ 0.0069 BTC mark |
| Best BID | 0.0065 BTC (size 153 BTC available) |
| Best ASK | 0.0075 BTC |
| ITM/OTM | **OTM by 4.09%** (BTC $81,328 vs put strike $78,000) |
| Days to expiry | 7.21 days |
| Sell at BID → | **$105.73 recovered** |
| Sell at MID → | $113.86 |
| Loss vs original cost | -$167 (BID) / -$159 (MID) |

**Recommendation:** SELL at BID immediately. The put needs BTC to drop -4.1% in 7 days to be ATM (still no intrinsic value); more for ITM. Likely outcome at expiry: $0.

### 1.2 BTC-22MAY26-83000-C (CALL)

| | |
|---|---|
| Protection ID | `dfb0810a-dcf7-4f01-acb2-6944b8c66d6d` |
| Tier / SL | SL 2% / $10k notional |
| Closed by | user_close on 2026-05-08 |
| Hedge bought | 0.1 BTC @ 0.024 BTC ($1,952 per contract = $195 total) on 2026-05-05 |
| Current state | 0.1 BTC long @ 0.0104 BTC mark |
| Best BID | 0.01 BTC (size 67.5 BTC available) |
| Best ASK | 0.0105 BTC |
| ITM/OTM | **OTM by 2.06%** (BTC $81,328 vs call strike $83,000) |
| Days to expiry | 7.21 days |
| Sell at BID → | **$81.33 recovered** |
| Sell at MID → | $83.36 |
| Loss vs original cost | -$114 (BID) / -$112 (MID) |

**Recommendation:** SELL at BID immediately. Closest to ITM of the three but still needs +2.1% BTC rally in 7 days for break-even at strike (no intrinsic until above $83k). EV(hold) ≈ $45 vs sell-now $81 — sell wins.

### 1.3 BTC-22MAY26-84000-C (CALL)

| | |
|---|---|
| Protection ID | `0cb9375b-5937-4a71-948e-a67741bdcf9b` |
| Tier / SL | SL 2% / $20k notional |
| Closed by | user_close on 2026-05-12 |
| Hedge bought | 0.2 BTC @ 0.015 BTC ($1,220 per contract = $244 total) on 2026-05-10 |
| Current state | 0.2 BTC long @ 0.0068 BTC mark |
| Best BID | 0.0065 BTC (size 37.1 BTC available) |
| Best ASK | 0.007 BTC |
| ITM/OTM | **OTM by 3.29%** (BTC $81,328 vs call strike $84,000) |
| Days to expiry | 7.21 days |
| Sell at BID → | **$105.73 recovered** |
| Sell at MID → | $109.79 |
| Loss vs original cost | -$138 (BID) / -$134 (MID) |

**Recommendation:** SELL at BID immediately. Needs +3.3% BTC rally in 7 days to be ATM. Likely $0 at expiry.

### 1.4 Combined unwind summary

| | At BID | At MID |
|---|---|---|
| Total recovery | **$293** | $307 |
| Loss vs original cost ($711) | -$418 | -$404 |
| Loss vs do-nothing ($0) | **+$293** | +$307 |

**Liquidity check:** All 3 instruments have ≥37 BTC of bid depth at top of book — way more than our 0.5 BTC total to sell. No slippage risk; we can market-out cleanly OR limit at BID with sub-second fill.

**Sell order plan (when approved):**
- Method: Limit IOC at best BID (or 1 tick above) for instant fill, fall to mid if not filled in 5s
- Sequence: 78000-P → 83000-C → 84000-C (most-OTM first, lock in highest-confidence recovery)
- Total time: <1 minute

---

## Section 2 — Pilot life-to-date economics

| Metric | Value |
|---|---|
| Pilot start | 2026-04-16 |
| Last protection sold | 2026-05-14 |
| Calendar days live | ~29 days |
| Total protections sold | 36 |
| Total premium collected | $4,005.33 |
| Total Deribit hedge spend (BUYs) | $3,372.47 USDC |
| Triggered protections | 5 |
| Payouts SETTLED to users | $0 (none recorded as settled) |
| Payouts OWED unsettled | **$5,700** |
| Cancelled protections | 40 |
| Expired OTM protections | 31 |
| Activation failed | 3 |
| Live Deribit account equity | 0.0119 BTC ≈ $970 |
| Live Deribit USDC available | 670 USDC |
| Net pilot P&L (best estimate) | **≈ −$3,427** |

**Net P&L derivation:** $4,005 collected − $3,372 hedges − $5,700 unsettled payouts + $1,640 account residual + $293 unwind recovery = **−$3,134**. (Approx; settles depend on actual user payout amounts.)

**Why the loss?**  Consistent with our earlier diagnosis (rev 4 plan): the deployed pricing was structurally too thin ($25/$10k for 2% SL vs the $65–100 P1 schedule we recommended). 5 triggers paid out $5,700 against $4,005 of premium collected. The hedges helped offset some of this but couldn't make up the under-pricing gap.

**This is exactly the loss profile the salvage-band stress projected at deployed pricing**, which is why we recommended the P3 Bundle C uplift before continuing.

---

## Section 3 — Other open items found during assessment (FYI / not auto-actionable)

### 3.1 Five triggered protections with unsettled user payouts ($5,700 total owed)
These are NOT the 3 orphans. The hedges for these have already been sold (status `tp_sold` in DB). The user-facing payouts have not been settled.

| Protection ID | Status | Hedge Status | Instrument |
|---|---|---|---|
| 07f5e251-7183-4b6b-a200-350139efa793 | triggered | tp_sold | BTC-29MAY26-82000-C (CONFIRMED SOLD on Deribit, size now 0) |
| 2743e7ac-dfb4-4a5d-ba0a-c0d531b11dc0 | triggered | tp_sold | BTC-29MAY26-79000-P |
| a884b451-c8ab-4636-b6d9-0b6a5aaffb04 | triggered | tp_sold | BTC-15MAY26-81000-C |
| 1c7e17f9-8ca3-44d3-bcd3-782b03599686 | triggered | tp_sold | BTC-15MAY26-79000-C |
| 3df5cfa1-58ac-44d3-9407-f633263b8575 | triggered | expired_settled | BTC-29APR26-77500-C |

**Action needed (separate from orphan unwind):** verify each user actually got their payout (off-chain bank/wallet transfer or in-platform credit). If any are genuinely unpaid, that's a settlement obligation we owe them.

### 3.2 Many older "cancelled" protections with stale hedge_status='active' but expired
Protections from April 18-24 show `hedge_status=active` but their option expiries were 1+ month ago. These hedges expired naturally on Deribit (auto-settled to OTM) — Deribit confirms only 3 positions still open. The DB metadata is stale (tracking gap, not asset gap).

**Action needed:** none for the unwind, but a one-time DB cleanup script could reconcile `hedge_status` against actual venue state. Not urgent.

### 3.3 Sell-side execution recording gap
73 buy executions recorded in `pilot_venue_executions` but 0 sell executions. Deribit shows actual sell trade history (e.g. the May 14 sell of BTC-29MAY26-82000-C at 0.0255). The `tp_sold` status is being set on protections via a different code path that doesn't write back to `pilot_venue_executions`.

**Action needed:** for the final report, we should reconcile by pulling Deribit's full trade history and computing actual sell-side proceeds for each closed hedge.

---

## Section 4 — Deprecation plan (proposed sequence)

### Step A: SAFE BLOCK — disable new activations (5-min env flip, no deploy)

The pilot uses these env flags (confirmed in code):
- `PILOT_ACTIVATION_ENABLED=false` → activate endpoint returns "pilot deprecated" error
- `PILOT_API_ENABLED=false` → master kill (also blocks quote endpoint, more aggressive)

**Recommended:** flip `PILOT_ACTIVATION_ENABLED=false` first (lets users still see their positions, just can't open new ones). If that's not enough, escalate to `PILOT_API_ENABLED=false`.

This is the **first thing we should do** once you approve. Existing live protections (none right now) and the orphan-hedge unwind (separate Deribit calls) are unaffected.

### Step B: Unwind 3 orphan hedges (after Step A)
Per Section 1 above. ~1 minute on Deribit. Recover ~$293.

### Step C: Settle the 5 triggered user payouts (operator decision)
Out of scope for me without your input on user contact / payout method. Flagging for your action.

### Step D: Deprecation banner on widget (next deploy, optional)
Add a "Pilot is being deprecated — no new protections accepted" banner in `apps/web/src/PilotApp.tsx` and `PilotWidget.tsx`. This is cosmetic since Step A already hard-blocks; banner is just better UX.

### Step E: Final reconciliation report
- Pull Deribit trade history (full life of pilot)
- Match sells to buys, compute realized P&L per protection
- Reconcile against DB `pilot_protections.payout_settled_amount`
- Generate one-page final report

### Step F: Disable trigger monitor + auto-renew (after all unwinds)
- `PILOT_TRIGGER_MONITOR_ENABLED=false`
- `PILOT_AUTO_RENEW_ENABLED=false`
- Stop hedge management cycle

### Step G: Archive widget route + final shutdown
- Remove `/pilot` route from web app
- Keep code in repo for audit
- Render service can stay running (handles Volume Cover when that goes live)

---

## Section 5 — What I need from you to proceed

### Decision 1 — Approve unwind of the 3 orphan hedges?
- [ ] **YES** — sell all 3 at limit-IOC on best BID, expected recovery ~$293
- [ ] HOLD — one or more to gamble on a price move (specify which)
- [ ] PARTIAL — sell some, hold others (specify)

### Decision 2 — Approve safe-block on new activations?
- [ ] **YES, flip `PILOT_ACTIVATION_ENABLED=false`** in Render env now
- [ ] WAIT — keep accepting new sales for now (please specify why)

### Decision 3 — How to handle the 5 unsettled user payouts ($5,700 owed)?
- [ ] You'll handle off-platform (bank/wallet transfer to each user)
- [ ] You want me to draft a settlement script that records them as paid in DB
- [ ] Defer — flag for later

### Decision 4 — Run the final Deribit trade reconciliation report?
- [ ] YES — I'll pull life-of-pilot trade history and produce a reconciled P&L report
- [ ] No, the assessment in this doc is enough

### Decision 5 — Touch the frontend banner?
- [ ] YES — add "Pilot deprecated" banner on next deploy
- [ ] NO — env-block is enough; users will see clean error message
