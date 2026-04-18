# Phase 0 — Live Baseline (v3): DVOL Anomaly + 4 New Shorts

**As of:** 2026-04-18T03:14 UTC
**Sample:** 21 active protections — **8 pre-tenor-switch, 13 post-tenor-switch**.
**Δ vs v2:** +4 trades (all SL 2/3/5% shorts), and one log-line ingestion that
surfaced a **material data-source bug**.

> ⚠ **Critical finding ahead of any other analysis: the platform's hedge
> manager is reading DVOL ≈ 133 while the actual Deribit mainnet DVOL is
> ≈ 43.** This is not a market reading — it's a wiring issue. Details in §1.

---

## 1. The DVOL anomaly (most important finding to date)

### What I observed

A single `[HedgeManager]` log line in your paste-in:

```
2026-04-18T03:11:48Z [HedgeManager] Cycle complete: scanned=20 tpSold=0 salvaged=0 expired=0 noBid=0 errors=0 skipped=20 vol=high(133)
```

`vol=high(133)` means the hedge manager classified the regime as **high
volatility** (DVOL > 60) at value `133`. That triggered me to triangulate.

### What's actually true on Deribit mainnet right now

Direct queries to the public Deribit API (no auth, no platform involvement):

| Source | Field | Value |
|---|---|---|
| `https://www.deribit.com/api/v2/public/get_volatility_index_data` (mainnet) | DVOL last 2h | **42.94 – 43.17** (median 43.07) |
| `https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd` (mainnet) | BTC index | **$77,292.10** |
| `https://api.exchange.coinbase.com/products/BTC-USD/ticker` | BTC spot | **$77,291.26** |
| Platform `/pilot/regime` endpoint | DVOL | **133.08** ❌ |
| Platform `/pilot/regime` endpoint | RVOL (fallback) | **41.34** ✅ |

Spot price is correct (Coinbase and Deribit-mainnet agree, platform agrees),
which is why pricing/hedging endpoints behave normally. **Only DVOL is
broken** — and it's broken in one specific way.

### Root cause

I tested the testnet endpoint as a hypothesis:

```
https://test.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC
→ 1000 rows of close=133.08 — flat, synthetic data
```

That matches exactly. The deployed `DeribitConnector` is constructed with
`env = "testnet"`, so its `baseUrl()` returns `https://test.deribit.com/api/v2`.
`getDVOL("BTC")` therefore queries Deribit testnet's volatility-index
endpoint, which returns Deribit's synthetic testnet vol number (~133, flat).

The platform is **operating on a DVOL value that is 3.1× the true mainnet
value, and has been since the testnet connector was deployed.**

### Why this hasn't broken anything visibly until now

Three reasons:
1. Until you fixed the v1 → v2 → v3 selection-test trades, the platform had
   no triggered post-switch positions, so the **DVOL-adaptive TP logic in
   `hedgeManager.ts` had nothing to act on**. The bad DVOL value never
   influenced a TP decision.
2. The **selection algorithm in `venue.ts` doesn't read DVOL** — it scores
   on ask price + strike distance + cost cap. So premium/hedge-cost spreads
   on quoted/activated trades are unaffected.
3. The **premium schedule in V7 is regime-flat** at the user-facing level
   (`$5/4/3/2 per $1k regardless of regime`). DVOL drives the regime label,
   but the user always pays the same. So even with DVOL=133 → regime=stress,
   the user-side pricing didn't change.

### Why this matters going forward

The `[HedgeManager]` cycle log shows `vol=high(133)`. That means whenever a
post-switch position triggers, the TP decision tree will use the **high-vol
adaptive parameters** instead of the **calm/normal-vol parameters** the
real DVOL=43 calls for. Specifically:

| Parameter | True regime (calm/normal at DVOL 43) | What hedge mgr actually uses (DVOL 133 → high) |
|---|---|---|
| Cooling period (h) | 0.25 (calm) / 0.50 (normal) | **1.0** (high) |
| Deep-drop cooling (h) | 0.10 / 0.167 | **0.25** |
| Prime-window threshold × payout | 0.15 / 0.25 | **0.35** |
| Late threshold × payout | 0.05 / 0.10 | **0.15** |
| Prime-window end (h) | 6 / 8 | **10** |

In plain English: the hedge manager is running a **more conservative,
slower-to-sell** TP profile than the actual market regime warrants. In a
quiet market, this means the platform will **hold winning hedges longer**,
demand **higher recovery thresholds before selling**, and as a result will
**likely under-recover TP value** when post-switch triggers eventually
happen. Whether the impact is large or small depends on path; the direction
of the bias is unambiguous.

There is also a downstream effect on the **Black-Scholes recovery model**
in `hedgeManager.ts`. `computeOptionValue` uses `sigma = dvol / 100` (i.e.
1.33 instead of 0.43). At sigma = 1.33, the BS model **overstates the
fair value of every put/call** by a substantial margin. So when the TP
decision tree compares "current option value" to "threshold × payout", it
is comparing an inflated value to a threshold that's 40% higher than it
should be. The two errors partially offset, but not symmetrically — and
the direction of the residual depends on path again.

### What I'm NOT proposing right now

Per stabilization mode, I am **not proposing a code change** in this turn.
The fix itself is simple (point the DVOL fetch at mainnet, OR add an env
flag to override the connector base for read-only public-data calls), but
the *decision* to change anything mid-pilot is yours. Three options I see:

**Option A — leave as-is for the rest of the paper pilot.**
- Pro: Zero change risk during pilot stabilization.
- Pro: Selection / pricing / settlement plumbing all unaffected.
- Con: First post-switch TP (if/when one happens) will be made on
  mis-tuned parameters. Paper-only outcome, but it'll mislead anyone
  reading the data after the fact.
- Con: Backtest / live reconciliation in any later phase has to caveat
  that all TP decisions in the live data ran on `DVOL=133`, not the true
  mainnet regime.

**Option B — surgical fix: point only the public-data calls at mainnet.**
- The fix is ~4 lines in `services/connectors/src/deribitConnector.ts`:
  override `baseUrl()` to always use mainnet for the public read-only
  endpoints (`get_volatility_index_data`, `get_historical_volatility`,
  `get_index_price`, `get_instruments`, `get_order_book`). Keep auth /
  trading routes on testnet so paper-account trades remain on testnet.
- Pro: Real DVOL flows through immediately. TP logic now correctly tuned.
  No effect on auth/trading.
- Pro: This is also what production will do (mainnet DVOL is the
  authoritative number even when trading live), so the fix is forward-
  compatible.
- Con: One small code change in a connector file. Mid-pilot.
- Risk: Low — public Deribit read-only endpoints, no secrets, identical
  shape between testnet and mainnet responses.

**Option C — env-var flag and toggle later.**
- Add `DERIBIT_PUBLIC_DATA_ENV=live` (or similar) so the operator can
  toggle. Not great because it adds config surface; the fix in B is
  simpler and the answer is unambiguous (always use mainnet for read-
  only public data).

**My recommendation: Option B**, gated behind your explicit sign-off.
Because the DVOL bug actively miscalibrates the TP decision tree, this is
the one stabilization-mode exception I'd advocate for **before** the first
post-switch trigger fires. If you'd rather wait until post-pilot, that's
also defensible — the trade-off is "TP outcomes during pilot ran on a
biased regime label."

If you say go, I'll send a tightly-scoped PR (`cursor/fix-deribit-dvol-
mainnet-38e5`) with: the connector change, a unit-style verification
script that compares testnet vs mainnet DVOL output, and a note in the
TP code that the regime classification now reflects mainnet vol.

### Side observation: RVOL fallback was already correct

`/pilot/regime` returned `rvol: 41.34` from the same connector. That's
because `get_historical_volatility` on testnet apparently returns mainnet-
ish realized vol (or testnet's implementation isn't synthetic). The
fallback path already in `regimeClassifier.ts` would have produced the
right regime if DVOL had been null. So if you want a zero-code-change
mitigation, an env knob to **disable DVOL** and force the platform to use
RVOL would also work.

---

## 2. Four new short-side trades since v2

| ID | Created (UTC) | Tier | Notional | Entry | Trigger | Strike | vs trigger | Days | Premium | Hedge | Margin% |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `e7d7b14d` | 03:01:33 | SL 2% | $10k | $77,292 | $78,838 | 79,000 C | OTM | 1.21 | $50.00  | $5.41  | 89.2% |
| `a4e1ccbf` | 03:01:46 | SL 3% | $15k | $77,280 | $79,598 | 80,000 C | OTM | 1.21 | $60.00  | $2.32  | 96.1% |
| `a8dce393` | 03:01:57 | SL 5% | $10k | $77,269 | $81,132 | 81,000 C | **ITM** | 1.21 | $30.00  | $2.32  | 92.3% |
| `b269f124` | 03:02:09 | SL 2% | $40k | $77,269 | $78,814 | 79,000 C | OTM | 1.21 | $200.00 | $27.04 | 86.5% |

### Selection observations

- **All 4 picked the 1-day option.** Same pattern as the longs — clean
  trigger-band alignment.
- **`a8dce393` (SL 5% short, ITM strike).** This looks like the same
  "trigger-band lands next to nearest strike" effect we saw on the SL
  10% long earlier. Trigger ceiling = $81,132; nearest call strikes at
  $81,000 and $81,500. Algorithm picked $81,000 (ITM by $132, ~0.16%
  ITM). For a call, ITM means strike < trigger ceiling, so the algorithm
  is paying a slight intrinsic premium for tighter alignment. Cost-cap
  doesn't fire because the absolute hedge cost ($2.32) is tiny.
  **Not a misfire. Same behavior as `d4326e17` long.**
- **Margins all in the 86-96% range** in the current calm vol regime.

### Per-tier coverage now (post-switch only)

| Tier | Long | Short | Total |
|---|---|---|---|
| SL 2%  | 2 | 4 | **6** |
| SL 3%  | 2 | 1 | **3** |
| SL 5%  | 2 | 1 | **3** |
| SL 10% | 1 | 0 | **1** |
| **Total** | **7** | **6** | **13** |

Symmetry check is now possible in the 2% / 3% / 5% tiers. Still need a
short-side 10% trade to complete the matrix, but not urgent.

---

## 3. Refreshed totals (post-switch only, n=13)

| Item | Amount |
|---|---|
| Premium collected | $1,365.00 |
| Hedge cost | $151.61 |
| Spread | $1,213.39 |
| Payouts due | $0.00 |
| TP recovery | $0.00 |
| **Post-switch Net P&L (paper)** | **$1,213.39** |

**Margins by tier:**

| Tier | n | Avg premium | Avg hedge | Margin% |
|---|---|---|---|---|
| SL 2%  | 6 | $108.33 | $19.69 | **81.8%** |
| SL 3%  | 3 | $113.33 | $7.99  | **93.0%** |
| SL 5%  | 3 | $35.00  | $1.81  | **94.8%** |
| SL 10% | 1 | $70.00  | $3.10  | 95.6% |

Same pattern as before — fat margins in calm vol, tightest in 2% (because
hedge is closer to ATM there), wider as SL widens.

---

## 4. Plumbing observations from the request log

The bulk of the paste-in was admin-dashboard polling traffic
(`192.166.246.72`). A few useful signals:

- **API response times look healthy.** Most requests 1-20 ms, occasional
  spikes to 80-260 ms (likely cold paths or DB query bursts). No 5xx-class
  responses seen in the window.
- **Polling cadence ≈ 3s.** Consistent with the admin dashboard's auto-
  refresh.
- **No `ERROR` / `FAILED` lines in the paste.** No `TRIGGERED:` events.
  No `[OptionSelection]` traces (those only print on actual quote/activate
  flows, and the polling traffic is admin-dashboard reads).
- **The single `[HedgeManager] Cycle complete:` line** showed the cycle
  ran cleanly: 20 hedges scanned, 0 sells, 0 errors. Skipped=20 because
  none of the 20 hit any sell-decision branch (all active, no triggers,
  not within active-salvage window of 4h).

---

## 5. Stabilization-mode status

| Item | Status |
|---|---|
| Read-only analysis only | ✅ |
| No platform code changes proposed in this turn | ✅ |
| No parameter changes proposed | ✅ |
| **DVOL anomaly flagged with explicit go/no-go for fix** | ⚠ — your call |

If you say no on the DVOL fix, this finding sits in the report and we
continue observing. If you say yes, I'll prep a tightly-scoped connector
PR with verification and minimum surface area.

---

## 6. Updated 7-day tracking checklist

Same as before, plus:

- [ ] **Decide on DVOL fix (Option A/B/C above)** — highest-priority
      decision in the queue.
- [ ] **Watch `[HedgeManager] Cycle complete:` log lines.** If you can
      paste 24h worth, we'll have continuous regime/cycle visibility.
- [ ] **Place one SL 10% short** to complete the symmetry matrix
      (low priority).
- [ ] **First post-switch trigger** still the highest-value future data
      point, especially with the DVOL bug context now established.

---

_End of Phase 0 v3 findings._
