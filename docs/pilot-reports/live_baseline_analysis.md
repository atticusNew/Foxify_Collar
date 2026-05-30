# Phase 0 — Live Pilot Baseline Analysis

**Generated:** 2026-04-18T04:49:27.716Z
**API base:** `https://foxify-pilot-new.onrender.com`
**Snapshot directory:** `docs/pilot-reports/raw-pilot-data/2026-04-18T04-49-26-935Z/`
**Tenor in code (current):** 1 day across all launched SL tiers (2 / 3 / 5 / 10).
**Tenor switch deployed at:** `2026-04-17T22:43:00.000Z` (commit `b0bb452` "production pilot: switch to 1-day tenor at $5/4/3/2 per 1k").
**Venue:** `deribit_live` — Deribit mainnet *connector mode* using a paper account; pricing/orderbook data is real, fills are paper. No real capital at risk.

---

## 1. Sample Size & Health

| Field | Value |
|---|---|
| Live API status | `ok` |
| Venue mode (connector) | `deribit_live` (paper account) |
| Monitor healthy | `ok` |
| Consecutive failures | 0 |
| Active protections (from `/pilot/protections`) | 23 |
| All protections (incl. archived from `/pilot/protections/export`) | 23 |
| Pre-tenor-switch | 8 |
| Post-tenor-switch | 15 |
| Earliest `createdAt` | 2026-04-16T17:16:10.000Z |
| Latest `createdAt` | 2026-04-18T04:43:45.000Z |
| Span (days) | 1.5 |

**Fetch errors during snapshot:**
_(none)_

> _Statistical caveat: this report reflects whatever the pilot has accumulated to date on a Deribit paper account. Findings are directional, not statistically conclusive, until the pilot accumulates ≥ 50 trades — and the **post-switch** sub-sample (currently 15 trades) is the only slice that reflects the production 1-day-tenor selection logic._

---

## 2. Per-Tier Outcomes — All Trades (mixed pre/post switch)

| Tier | Count | Triggered | Trig Rate | Avg Prem | Avg Hedge | Avg Spread | Avg Margin% | Neg-Margin | TP Sold | TP Rate | Avg TP $ |
|------|-------|-----------|-----------|----------|-----------|------------|-------------|------------|---------|---------|----------|
| SL 10% | 2 | 0 | 0.0% | $45.00 | $2.32 | $42.68 | 93.9% | 0 | 0 | 0.0% | $0.00 |
| SL 2% | 13 | 1 | 7.7% | $128.85 | $45.45 | $83.39 | 68.1% | 0 | 1 | 100.0% | $45.12 |
| SL 3% | 5 | 0 | 0.0% | $116.00 | $30.71 | $85.29 | 75.8% | 0 | 0 | 0.0% | $0.00 |
| SL 5% | 3 | 0 | 0.0% | $35.00 | $1.80 | $33.20 | 94.6% | 0 | 0 | 0.0% | $0.00 |

**Hedge-status breakdown across all protections:**

- `active`: 22
- `tp_sold`: 1

**Realized totals across the full sample:**

| Item | Amount |
|---|---|
| Premium collected | $2,450.00 |
| Hedge cost | $754.49 |
| Spread (premium − hedge) | $1,695.51 |
| Payouts due | $200.00 |
| Payouts settled | $0.00 |
| TP recovery (proceeds) | $45.12 |
| **Net P&L (realized, paper)** | **$1,540.63** |

---

## 2b. Per-Tier Outcomes — Post-Tenor-Switch Sub-Sample

This is the slice that reflects the **current** 1-day-tenor selection logic and $5/4/3/2 per $1k pricing. Sample size: 15.

| Tier | Count | Triggered | Trig Rate | Avg Prem | Avg Hedge | Avg Spread | Avg Margin% | Neg-Margin | TP Sold | TP Rate | Avg TP $ |
|------|-------|-----------|-----------|----------|-----------|------------|-------------|------------|---------|---------|----------|
| SL 10% | 2 | 0 | 0.0% | $45.00 | $2.32 | $42.68 | 93.9% | 0 | 0 | 0.0% | $0.00 |
| SL 2% | 7 | 0 | 0.0% | $128.57 | $18.01 | $110.56 | 86.8% | 0 | 0 | 0.0% | $0.00 |
| SL 3% | 3 | 0 | 0.0% | $113.33 | $8.00 | $105.34 | 93.6% | 0 | 0 | 0.0% | $0.00 |
| SL 5% | 3 | 0 | 0.0% | $35.00 | $1.80 | $33.20 | 94.6% | 0 | 0 | 0.0% | $0.00 |

**Post-switch realized totals:**

| Item | Amount |
|---|---|
| Premium collected | $1,435.00 |
| Hedge cost | $160.09 |
| Spread | $1,274.91 |
| Payouts due | $0.00 |
| TP recovery | $0.00 |
| **Post-switch Net P&L (realized, paper)** | **$1,274.91** |


---

## 3. Option Selection — Post-Tenor-Switch Sub-Sample Only

This is the slice that matters for the 1-day-tenor investigation. The ALL-trades view is provided in §3-all below for reference but mixes legacy 2-day-tenor selections.

### 3.1 Expiry bucket of selected instrument vs `createdAt`

| Bucket | Post-switch count | All-trades count |
|---|---|---|
| < ~1 day (≤ 0.85d) | 0 | 0 |
| ~1 day (0.85–1.5d) | 14 | 14 |
| ~2 days (1.5–2.5d) | 1 | 3 |
| ~3 days (2.5–3.5d) | 0 | 6 |
| > 3 days | 0 | 0 |
| Unknown | 0 | 0 |

> _For the post-switch column: the 1-day selector's window is `[now+12h, now+3d]`. A non-trivial count in the 2d / 3d buckets indicates the 1d strike was unavailable at the trigger band when the trade was placed; Phase 2's chain-availability sampling tests this hypothesis empirically._

### 3.2 Strike vs trigger (selected instrument)

| Position | Post-switch count | All-trades count |
|---|---|---|
| ITM (strike beats trigger) | 5 | 6 |
| At trigger (within ±0.05%) | 2 | 4 |
| OTM (strike worse than trigger) | 8 | 13 |
| Unknown | 0 | 0 |

> _The ITM bonus only fires for `drawdownFloorPct ≤ 0.025` (i.e. 2% SL on puts). ITM count concentrated in the 2% put tier confirms the bonus is working as designed; ITM count in 3%/5%/10% tiers, or in any call (short) position, would indicate the algorithm preferred ITM for cost reasons rather than the bonus._

### 3.3 Negative-margin trades observed

DB sample (premium < hedgeCost in completed activations, all trades):

_(none observed in this sample)_

Log paste-ins (last NEGATIVE_MARGIN `WINNER` lines, max 10):

_(no NEGATIVE_MARGIN log lines found in paste-ins; logs may be missing or no events occurred)_

---

## 4. Hedge Manager — TP & Hold Decisions

### 4.1 Outcomes (DB)

(Already covered per-tier in §2 — TP-sold count + avg recovery.)

### 4.2 Decisions (Render logs, paste-ins required)

> _If counts below are 0, either no log files have been pasted into `docs/pilot-reports/raw-logs/` yet, or the events did not occur in the pasted window. Outcome columns above remain authoritative regardless._

**Files ingested:** `2026-04-17-autorenew.log`, `2026-04-17-hedgemanager.log`, `2026-04-17-optionselection.log`, `2026-04-17-triggermonitor.log`, `2026-04-18-mixed-paste.log`
**Lines parsed:** 108 total / 62 unique

**Sell decisions by reason:**
_(none in paste-ins)_

**Sell results by status:**
_(none in paste-ins)_

**Hold decisions:**
- `cooling_period` holds: 0
- `gap_extended_cooling` holds: 0
- Sub-threshold / other holds: 0

**Cycle aggregates (from `Cycle complete:` lines):**
- Cycles seen: 5
- Sum scanned: 60
- Sum tpSold: 0
- Sum salvaged: 0
- Sum expired: 0
- Sum no-bid retries: 0
- Sum errors: 0

---

## 5. Trigger Monitor (Render logs)

- Triggered events seen: 0
- Cycle summaries seen: 0
- Sum price errors: 0
- Consecutive-error warnings: 0

---

## 6. Auto-Renew (Render logs)

- Renewed: 0
- Failed: 0

---

## 7. Option Selection Activity (Render logs)

- `WINNER:` lines: 5
- of which `⚠ NEGATIVE_MARGIN`: 0
- `OVER_PREMIUM` penalty events: 0
- Per-candidate `score:` lines: 0
- `trigger_strike_unavailable` rejections: 0

---

## 7b. DeribitAdapter Execution (Render logs)

- `placeOrder raw response` events seen: 1
- `execute:` summary lines parsed: 1
- Fills by instrument:
  - `BTC-19APR26-78500-C`: 1

Sample fills (max 10):
    2026-04-18T04:43:45.500000000Z [DeribitAdapter] execute: instrument=BTC-19APR26-78500-C filled=true qty=0.1 priceBtc=0.0009 priceUsd=69.40 orderId=93797227919

---

## 7c. Activate-Path Errors (Render logs)

- `Execution quality upsert failed` events: 1
- Other `[Activate]` error/warning lines: 0

Sample upsert failures (max 5):
    2026-04-18T04:43:45.600000000Z [Activate] Execution quality upsert failed: null value in column "id" of relation "pilot_execution_quality_daily" violates not-null constraint

> _If Execution quality upsert failures > 0, the `pilot_execution_quality_daily` rollup table is not being populated, which is why `/pilot/admin/diagnostics/execution-quality` returns no records. Activations themselves are unaffected — the error is caught and logged without rolling back the trade. Production-readiness item, not a pilot blocker._

---

## 7d. DVOL Regime Observations from `Cycle complete` lines

Counts per regime band recorded at the end of each hedge-manager cycle:

- `vol=high`:   5
- `vol=normal`: 0
- `vol=low`:    0

Sample bands (chronological): high(133), high(133), high(133), high(133), high(133)

> _After PR #26 deployed (DVOL fix), this distribution should reflect mainnet regime (typically `normal` for current DVOL ≈ 43). If `vol=high` continues to appear post-deploy, investigate cache TTL or connector wiring._

---

## 8. Methodological Notes

1. **Paper account.** `venue.mode = deribit_live` is the *connector mode* — Deribit mainnet endpoints are used for pricing and orderbook data so spreads/IV are real, but the underlying account is paper. No real capital is at risk. Realized P&L figures are paper P&L.
2. **Tenor-switch cutover.** The `tenorSwitchIso` cutover (`2026-04-17T22:43:00.000Z`) splits the dataset. The post-switch sub-sample is the only slice that reflects the current 1-day-tenor selection logic and the $5/4/3/2 per $1k pricing schedule. The all-trades view is provided for historical context but mixes legacy 2-day-tenor selections.
3. **DB visibility = outcomes only.** Hold decisions (cooling, gap-extended, sub-threshold) and rejected activations (`trigger_strike_unavailable`) only appear in Render logs. The §4.2/§5/§6/§7 sections require the operator to paste log lines into `docs/pilot-reports/raw-logs/`.
4. **Expiry bucketing uses `createdAt` vs parsed instrument expiry.** For renewals, `createdAt` is the new protection's creation time, not the original — the bucket reflects what was bought at that moment.
5. **Strike-vs-trigger uses parsed strike from `instrument_id` and `floor_price` from the protection record.** Both are ground truth.
6. **Negative-margin tally counts trades where realized `premium − executionPrice × size < 0`.** Quoted-but-unfilled NEGATIVE_MARGIN warnings live in logs only.
7. **TP recovery is read from `metadata.sellResult.totalProceeds`.** Values denominated in USD as recorded by the platform's sell path.
8. **The script is read-only.** No platform calls produce side effects. Snapshots persist to `docs/pilot-reports/raw-pilot-data/<UTC-timestamp>/`.

---

## 9. Open Questions Surfaced by This Report

_(Fill in after reviewing — left intentionally blank in the auto-generated draft.)_

- [ ] If post-switch §3.1 shows substantial 2d/3d selections: investigate Phase 2 chain-availability data to confirm 1d strike was genuinely unavailable, or recommend tighter window in Phase 4 (deferred).
- [ ] If post-switch §3.2 shows ITM selections in 3%/5%/10% tiers, or in any call (short) position: confirm whether the cost bias is driving these (no behavior change recommended yet).
- [ ] If §3.3 shows persistent negative-margin trades in any tier: flag for pricing review post-pilot (do not adjust during stabilization).
- [ ] If §4.2 cooling-hold count >> sub-threshold-hold count for triggered positions that ultimately did NOT sell: TP threshold may be too restrictive on 1-day tenor (defer to Phase 5, post-pilot).
- [ ] If §5 shows non-zero `consecutive-error warnings`: investigate price-feed reliability before any live-account flip.

---

_End of Phase 0 baseline._
