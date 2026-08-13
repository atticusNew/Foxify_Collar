# Bullish RFQ Runbook — Calibrating the 30d ±2% Strangle

> **Goal:** resolve the open V1 calibration question — does the
> founder's $1,150 quote match what Bullish actually quotes for the
> volume-facility hedge, or does the BS no-arb $3,700-$5,400 estimate
> hold? This runbook makes the answer ~5 minutes of work.
>
> **Companion script:** `services/api/scripts/volFacilityHedgeRfq.ts`
> **Outputs:** `docs/cfo-report/double-barrier-analysis/rfq/rfq_<timestamp>.{json,md}`

---

## TL;DR

```bash
# from repo root, with the same env vars the live pilot uses:
pnpm tsx services/api/scripts/volFacilityHedgeRfq.ts \
    --notional-usd 50000 --tenor-days 30 --barrier-pct 0.02

# also run for the daily-strangle calibration:
pnpm tsx services/api/scripts/volFacilityHedgeRfq.ts --tenor-days 1
pnpm tsx services/api/scripts/volFacilityHedgeRfq.ts --tenor-days 7
```

Output: a JSON + markdown report with the actual venue ask, vs the founder's $1,150 estimate, vs the CFO doc's $3,700 estimate, vs my $5,400 BS recompute. Whichever is right, the answer is captured.

---

## 1. Prerequisites — what's needed to run the RFQ

The script reuses the **same Bullish credentials the live pilot already uses**. No new account or onboarding is required.

### 1.1 Environment variables (already in your `.env` if pilot is live)

```env
PILOT_BULLISH_REST_BASE_URL=https://api.simnext.bullish-test.com   # or production URL
PILOT_BULLISH_PUBLIC_WS_URL=wss://api.exchange.bullish.com/trading-api/v1/market-data/orderbook
PILOT_BULLISH_AUTH_MODE=ecdsa                                       # or hmac
PILOT_BULLISH_ECDSA_PUBLIC_KEY=<your key>
PILOT_BULLISH_ECDSA_PRIVATE_KEY=<your private key>
PILOT_BULLISH_AUTHORIZER=<your authorizer>
PILOT_BULLISH_TRADING_ACCOUNT_ID=<your account id>
```

If the live pilot is running and `pilotBullishKeyCheck.ts` passes, this script will work as-is. **Read-only request — does not place any orders.**

### 1.2 If you don't have Bullish creds yet

You're requesting a market-data quote, not placing an order, so the requirements are minimal:
- Bullish institutional account (already exists for Atticus pilot)
- ECDSA or HMAC API key with at least *market-data read* permission
- Authorizer + trading account ID

If the live pilot is on Bullish testnet (`api.simnext.bullish-test.com`), the testnet quote is **indicative only** — testnet pricing is typically 2-4× wider than production per `Atticus_Foxify_Balanced_Economic_Analysis.md §3`. **For final calibration, run against production REST URL.**

### 1.3 Falcon X alternative

If you'd rather get the quote from Falcon X (the institutional OTC desk relationship Atticus already has, per `Atticus_Vol_Facility_CFO_Walkthrough.md §1`), the path is:
- Email the Falcon X structurer with the RFQ details below.
- Falcon X typically returns a quote within minutes for a standard BTC strangle at this size.

The exact RFQ to send Falcon X:

```
RFQ: BTC strangle, 30 calendar days
- Pair leg 1 (call): K = $76,500 (assume spot $75k, +2%)
- Pair leg 2 (put):  K = $73,500 (-2%)
- Notional: 0.667 BTC each leg
- Settlement: USD T+1
- Side: Atticus BUYS both legs
- Counterparty: Atticus
- Quote needed: Total ask $ for the two-leg purchase.
```

---

## 2. Running the script

```bash
cd /workspace
pnpm install   # if not already done

# Smoke check that creds work:
pnpm tsx services/api/scripts/pilotBullishKeyCheck.ts

# 30-day strangle RFQ (the V1 calibration question):
pnpm tsx services/api/scripts/volFacilityHedgeRfq.ts

# Daily-strangle calibration (for V2's recommended hedge):
pnpm tsx services/api/scripts/volFacilityHedgeRfq.ts --tenor-days 1

# 7-day variant:
pnpm tsx services/api/scripts/volFacilityHedgeRfq.ts --tenor-days 7
```

Each run takes ~10-20 seconds and produces:
- `docs/cfo-report/double-barrier-analysis/rfq/rfq_<UTC-timestamp>.json`
- `docs/cfo-report/double-barrier-analysis/rfq/rfq_<UTC-timestamp>.md`

---

## 3. What the output tells you

The script reports:

| Metric | Why it matters |
|---|---|
| **Strangle total (ask)** | The actual cost of buying ±2% strangle at Bullish *right now*. This is the number to compare against $1,150 / $3,700 / $5,400. |
| **Per-pair-day amortized** | Strangle total ÷ days to expiry. Useful for the "what does the hedge cost per day" intuition. |
| **Vs founder $1,150** | If <1.0×, founder's estimate held. If 3-5×, BS no-arb is right. |
| **Vs CFO doc $3,700** | Sanity check against the existing internal calibration. |

Three possible outcomes and what each means:

### Outcome A: Strangle ≈ $1,150 (founder's estimate is right)

**Interpretation:** Bullish is quoting materially below BS no-arb — likely a bid/ask asymmetry or testnet artifact. Run on **production**, not testnet.

If production confirms ~$1,150:
- The platform has 4-5× cheaper hedging than my V2 numbers assume.
- All P&L numbers in `MEMO_V2.md §1` go up by ~$3-4k per pair-life.
- Capital ramp at 1,000 pairs drops from $1.76M to ~$0.5M.
- This is the rare *positive surprise* — capture it by writing a Falcon X / Bullish lock-in on the pricing.

### Outcome B: Strangle ≈ $3,000–$5,500 (BS no-arb / CFO doc is right)

**Interpretation:** Everything in MEMO_V2.md stands as written. The empirical historical-tape replay was already calibrated against this range.

Action: file the RFQ artifact for documentation; no MEMO_V2 changes required.

### Outcome C: Strangle > $6,000

**Interpretation:** Venue spread is wider than expected. Possible reasons:
- Bullish is testnet-only at our notional (production has tighter spreads).
- The expiry cycle we hit doesn't have liquid quoting.
- DVOL spike at quote time made the strangle expensive.

Re-run during a calmer window, on production, and compare. If still >$6k, **daily strangle hedging becomes even more attractive vs 30d** (per V2 §3) — the V2 recommendation already directs us there.

---

## 4. What to do with the result

### 4.1 If quote is consistent with V2 assumptions ($3,000-$5,500)

Nothing changes. File the RFQ JSON in `rfq/` for the audit trail. Phase 1 launch on the V2 plan is unblocked.

### 4.2 If quote is materially below ($1,000-$2,000)

Update `MEMO_V2.md §1` and `capital_ramp_planner.py`'s `initial_hedge` constant from $5,400 → quoted_value. Re-run `capital_ramp_planner.py`. Capital required at 1,000 pairs will drop ~5×. **Communicate to Foxify** as a positive economic finding.

### 4.3 If quote is materially above ($6,000+)

Don't panic. The V2 recommendation is **daily strangle**, where the per-leg cost is ~$420 and the cost-disparity to 30d compounds in our favor. Re-run with `--tenor-days 1` to confirm the daily strangle quote is reasonable (~$300-$500). If that holds, V2 is unaffected; we just rule out the 30d straddle as an alternative more decisively.

---

## 5. Why this matters in one sentence

> **The V1/V2 analysis is robust to a wide range of hedge cost calibrations because option payoffs are martingales — what matters more is the IV/RV gap (which we measured empirically at +12-25%) than the absolute hedge price. But knowing the venue's actual quote tightens the capital ladder by ~3-5× in either direction and is a 5-minute job, so we should do it before scaling any pilot capital.**

---

## 6. Frequency

Run this RFQ:
- **Once** before Phase 1 launch (calibration).
- **Weekly** during Phase 1-2 (capture any DVOL-regime drift).
- **On every DVOL band transition** (calm → mod → elev) during Phase 3+.
- **Real-time** continuously once the volume facility is in production (already supported by the existing `pilotBullishPricingCompare.ts` pattern; this script adds the strangle-specific aggregation).

---

*End of runbook. Reach me with the quote output and we can update `MEMO_V2.md` numbers in <30 minutes.*
