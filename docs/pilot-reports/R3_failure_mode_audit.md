# R3 — No-Bid / Deribit-Down / DB-Failure Mode Audit

**Audit scope:** Every code path that touches an external dependency (Deribit, Coinbase, Postgres) during quote, activate, trigger detection, and TP execution. For each, what happens when the dependency fails / hangs / returns degraded data?

**Methodology:** Read-only code trace. Cross-referenced against Pilot Agreement §7.4 (Known Limitations) and §8.2 (Liability Exclusions).

**As of:** 2026-04-19, post PR #44.

---

## TL;DR

The platform handles **most** failure modes correctly. **Two material gaps** worth addressing before live capital flows; **three operational concerns** worth understanding but not necessarily fixing.

| # | Failure mode | Behavior | Severity |
|---|---|---|---|
| 1 | No bid on TP sell | Logged `no_bid`, retry next 60s cycle indefinitely, no escalation | ⚠ Operational gap |
| 2 | Deribit `placeOrder` throws on activate | Tx rollback, daily cap released, status=`activation_failed`, 502 response | ✅ Correct |
| 3 | Deribit `placeOrder` succeeds at venue but response times out / DB write fails | Status flipped to `reconcile_pending`, daily cap kept, 409 response | ✅ Correct |
| 4 | Deribit `placeOrder` hangs (no response) | Bounded by 6s HTTP timeout × 3 retries = ~18s worst case; then thrown as generic error | ⚠ No `venue_execute_timeout` thrown; falls through as generic |
| 5 | Deribit `getOrderBook` fails on TP sell | sellOption returns `failed` (not `no_bid`); cycle continues; retry next cycle | ✅ Correct |
| 6 | Deribit DVOL endpoint down | Cached value (60s TTL) keeps serving; if cache cold, regime defaults to `normal` (sigma 0.50 fallback) | ✅ Correct |
| 7 | Deribit index-price endpoint down (used by hedge cycle for spot) | If `spot ≤ 0`, **entire cycle is silently skipped** | ⚠ Material gap |
| 8 | Coinbase price feed down (primary) | Falls back to Deribit perpetual ticker | ✅ Correct |
| 9 | Both price feeds down | `priceErrors++` per cycle; warns at 10 consecutive; trigger detection paused | ⚠ Pause is silent — no alert |
| 10 | DB unavailable mid-quote | 503 with `storage_unavailable`; client retries | ✅ Correct |
| 11 | DB unavailable mid-activate (after Deribit fill) | Status=`reconcile_pending`; cap NOT released; manual reconciliation needed | ⚠ Operationally heavy |
| 12 | Deribit account out of margin | `placeOrder` returns specific error; surfaces as `execution_failed` 502 | ✅ Correct (but no pre-check) |
| 13 | Deribit rate-limit (429) | No special handling; generic retry 3×; then thrown as generic error | ⚠ Operational gap |
| 14 | Position never gets bid before expiry | Auto-flipped to `expired_settled` at expiry; Deribit auto-settles ITM payout | ✅ Correct (but no platform-side reconciliation of Deribit settlement amount) |

---

## 1. The atomic-operation guarantee for activate (the critical-path verification)

The activate endpoint executes:

```
BEGIN TRANSACTION
  SELECT … FOR UPDATE on quote        ← lock the quote
  SUM active protections              ← R2.B aggregate cap
  SUM today's tier protections        ← R2.D per-tier cap
  reserveDailyActivationCapacity      ← atomic SQL UPDATE
  insertProtection(status='pending_activation')
  consumeVenueQuote                   ← mark quote consumed
COMMIT TRANSACTION

(outside transaction, after commit:)
  venue.execute(quote)                ← Deribit placeOrder

(reopen transaction:)
BEGIN TRANSACTION
  insertVenueExecution
  upsertExecutionQualityIncrement
  insertLedgerEntry
  patchProtection(status='active', execution_price, premium, …)
COMMIT TRANSACTION
```

**This split-transaction design is correct.** The pre-fill transaction commits the cap reservation + the protection record + the quote lock atomically. Then the Deribit fill happens outside any transaction (because Deribit is the source of truth for the order). Then a second transaction persists the fill outcome.

The four real failure points:

| Failure point | What gets persisted | What's reversible |
|---|---|---|
| Pre-fill transaction throws | Nothing committed | All reversed by ROLLBACK |
| Deribit placeOrder throws | `pending_activation` row exists; cap reserved | Catch block patches row to `activation_failed`, releases cap |
| Deribit fills but our second-tx INSERT throws | `pending_activation` row exists; cap reserved; **Deribit position EXISTS** | Catch block patches row to `reconcile_pending`, keeps cap reserved (correct — we DO owe the protection), surfaces 409 to operator for manual reconciliation |
| Deribit fills, second tx commits, then DB pool dies | Activation succeeded fully | n/a |

**Verdict**: this is one of the cleaner critical-path designs I've audited. No silent dropped writes. Every failure has a defined post-condition.

---

## 2. The no-bid scenario (failure mode #1) — operational gap

### Current behavior

`hedgeManager.ts:241-282` — when `sellOption` returns `{ status: "failed", details: { reason: "no_bid" } }`:

1. Logs `[HedgeManager] No bid for {protectionId} ({instrumentId}) — will retry next cycle`.
2. Returns `"no_bid"` to the cycle loop.
3. Cycle increments `result.noBidRetries` (per-cycle counter, not persisted).
4. Cycle's `Cycle complete: ... noBid=N ...` log line shows the count for that cycle only.
5. Next cycle (60s later), the same hedge is evaluated again, hits the same no-bid response, repeats.

### What's NOT happening

- **No persistence**: the protection's metadata does NOT track that this position has been hitting no-bid for hours.
- **No escalation**: at no point does the algorithm fall back to "sell at any price" or "alert the operator" or "give up and let it expire."
- **No alert**: an operator scrolling through Render logs would see a single `No bid for...` line per cycle but no aggregated "this position has been no-bid for 6 hours" warning.

### Why this matters live

A position that goes deep ITM in a thin-market regime can see its bid disappear entirely. The Phase 2 chain sampler showed 1-day options with `bid: null` in 4 of the 8 tier×side combinations on every snapshot. **For any SL 5%+ short or any SL 10%+ position, a missing bid is the norm, not the exception.**

If the hedge manager wants to TP-sell such a position, it correctly skips. But:

- The position's payout is still owed to the user (already stamped at trigger time).
- We get nothing from the hedge.
- Deribit auto-settles at expiry: ITM means we receive the option's intrinsic value to our account balance (via Deribit's settlement mechanism, NOT via our TP-sell path).

**The implication**: in the no-bid scenario, **the platform's TP recovery is $0, but the actual economic recovery is the option's intrinsic value at expiry, captured at the Deribit account level.** The platform's books show $0 TP recovery, but the Deribit account balance reflects the recovery.

This is fine **economically** but creates a **reconciliation gap**: the platform's exec-quality view will show this position as "no TP sale" while the Deribit account shows a credit. Until manually reconciled, P&L reports diverge.

### Recommended fix scope

Two options, both small:

**Option A — Persist no-bid count + escalate in metadata (~15 lines)**

In `hedgeManager.ts`, when `sellStatus === "no_bid"`:
```ts
await pool.query(
  `UPDATE pilot_protections
   SET metadata = metadata || jsonb_build_object(
     'noBidRetryCount', COALESCE((metadata->>'noBidRetryCount')::int, 0) + 1,
     'lastNoBidAt', $2::text,
     'lastNoBidInstrument', $3::text
   ),
   updated_at = NOW()
   WHERE id = $1`,
  [hedge.protectionId, new Date().toISOString(), hedge.instrumentId]
);
```

This makes "this has been no-bid for hours" visible in admin dashboard + Phase 0 reports.

**Option B — Do A AND log a single-line warning at thresholds (~25 lines)**

Same as A plus log `[HedgeManager] WARN: protection {id} has been no-bid for {N} cycles ({minutes} minutes)` at 30, 60, 120 cycle marks. Single warning per threshold per position to avoid log spam.

Recommend **A or B** before live pilot. **B preferred.**

---

## 3. Deribit getIndexPrice failure (failure mode #7) — material gap

### Current behavior

`routes.ts:4674` — the hedge-management scheduler:

```ts
const spot = await (async () => {
  const ticker = await dataConnector.getIndexPrice("btc_usd");
  return Number((ticker as any)?.result?.index_price ?? 0);
})();
if (!spot || spot <= 0) return;
```

If `getIndexPrice` throws OR returns garbage:
- The hedge manager cycle silently exits via `return`.
- No warning logged.
- Next cycle 60s later tries again.

### Why this matters live

If Deribit mainnet is unreachable for ~5 minutes (rare but happens), the hedge manager produces zero log output for 5 cycles. No `[HedgeManager] Cycle complete` lines. No `[HedgeManager] no spot` warning. **The platform looks healthy in Render logs but is silently doing nothing.**

A triggered position that should have been TP-sold during this window goes unsold.

### Recommended fix scope

Trivial (~5 lines):

```ts
const spot = await (async () => {
  try {
    const ticker = await dataConnector.getIndexPrice("btc_usd");
    return Number((ticker as any)?.result?.index_price ?? 0);
  } catch (err: any) {
    console.warn(`[HedgeManager] getIndexPrice FAILED — skipping cycle: ${err?.message}`);
    return 0;
  }
})();
if (!spot || spot <= 0) {
  console.warn(`[HedgeManager] no spot price available — cycle skipped`);
  return;
}
```

Single warning per skipped cycle. Operator can grep for `[HedgeManager] no spot` to see the gaps.

Recommend **shipping before live pilot.**

---

## 4. Deribit-execute hang (failure mode #4) — minor gap

### Current behavior

`venue.ts:751-758` — `execute()` calls `placeOrder()` directly with no timeout wrapper. The connector itself has a 6s `fetchWithTimeout`, and `withRetry` retries 3 times. So worst case is ~18s of hang before throwing.

The activate-path catch block correctly handles the eventual throw:
- Marks `pending_activation` row as `activation_failed`.
- Releases daily cap.
- Returns 502.

But the user has been waiting ~18s with no response. Bad UX.

### Recommended fix scope

The `venue_execute_timeout` reason string is **already wired into the response mapping** (`routes.ts:3722, 3743, 3810`) but never thrown. Two options:

**Option A — Wrap placeOrder in 8s timeout (~6 lines)**

In `venue.ts execute()`:
```ts
const raw = await Promise.race([
  this.connector.placeOrder({...}),
  new Promise((_, rej) => setTimeout(() => rej(new Error("venue_execute_timeout")), 8000))
]);
```

Net: bounded response time at ~8s; user sees a clear timeout message instead of waiting 18s.

Recommend **shipping before live pilot.** Trivial.

---

## 5. Both price feeds down (failure mode #9) — silent pause concern

### Current behavior

`triggerMonitor.ts:218-225`:
```ts
if (result.priceErrors > 0) {
  consecutivePriceErrors += result.priceErrors;
  if (consecutivePriceErrors >= 10) {
    console.error(`[TriggerMonitor] ⚠ ${consecutivePriceErrors} consecutive price errors — price feeds may be degraded`);
  }
} else {
  consecutivePriceErrors = 0;
}
```

10 consecutive errors at 3s intervals = ~30s of complete price-feed failure before the warning fires. Until then, **trigger detection is silently paused**.

If both Coinbase and Deribit perp are down for 30 seconds during a fast move, a position could move past its floor without being detected as triggered. Once feeds recover, the next cycle sees the new (post-move) spot and may not trigger if spot has bounced back.

### Why this is risky live

Per the Pilot Agreement §7.4: "Price monitoring operates on a polling basis with up to 5-second detection intervals. Extremely rapid price movements (flash crashes recovering within seconds) may not be detected." So this scenario is **explicitly carved out of liability**. But it would still be operationally embarrassing to miss a trigger.

### Recommended fix scope

Already adequate per agreement. **Worth surfacing in R7 alerting layer** — the `consecutivePriceErrors >= 10` warning should also fire a Telegram/email alert. Not required for v1 of pilot.

---

## 6. No-margin pre-check on Deribit account (failure mode #12) — enhancement, not gap

### Current behavior

The platform doesn't pre-check the live Deribit account's available margin before placing an order. If the account ran out, `placeOrder` fails with a Deribit-side error → surfaces as `execution_failed` → 502 → user sees "Activation failed".

User can retry; if the operator has topped up the account in the meantime, the retry succeeds.

### Why it's not strictly a gap

For a single-user pilot with the operator monitoring Deribit balance manually, this is fine. The R8 runbook recommends funding the live account with $500-1000 trial balance and topping up after verification.

### Recommended fix scope (post-pilot)

Add an admin endpoint that pings `/private/get_account_summary` and surfaces available_funds in the admin dashboard. Operator can monitor proactively. **Not required for pilot; recommended for production.**

---

## 7. DB unavailable mid-activate (failure mode #11) — operationally heavy reconciliation

### Current behavior

If Deribit fills but the post-fill DB writes fail (DB pool dies, network blip, unique-constraint violation, etc.):

1. Catch block detects `execution.status === "success"` but transaction rolled back.
2. Sets `shouldMarkReconcilePending = true`.
3. Patches the protection's status to `reconcile_pending`.
4. **Daily cap is NOT released** (correct — we DO owe the protection).
5. Returns 409 with `reason: reconcile_pending` to client.

### What's missing

There's no automated reconciliation job that picks up `reconcile_pending` rows and:
- Verifies the Deribit position exists.
- Re-attempts the post-fill DB writes.
- On success, flips status to `active`.

### Operational impact

Every `reconcile_pending` row requires manual operator intervention. At pilot single-user scale, that's tolerable (rare event, easy to spot). At Foxify-prod multi-user scale this becomes operationally heavy.

### Recommended fix scope (post-pilot)

A new background scheduler `pilot_reconcile_pending_runner.ts` that runs every 5 min, picks up rows older than N seconds, and attempts the recovery. **Not required for pilot.**

---

## 8. Rate-limit handling (failure mode #13) — operational gap at scale

### Current behavior

`deribitConnector.ts:26-36` `withRetry` retries 3 times on any error, no exponential backoff, no 429-specific handling.

### Why this matters

Deribit's documented rate limits are per-IP and per-API-key. Pilot single-user traffic is well below limits. At Foxify-prod scale (especially with the chain sampler running every 6h plus all activate / monitor / TP traffic), a 429 is possible.

### Recommended fix scope (post-pilot)

Add 429-aware retry with exponential backoff in the connector. **Not required for pilot.**

---

## 9. Position never gets bid before expiry (failure mode #14) — economic but not operational gap

### Current behavior

`hedgeManager.ts:311-321` — at expiry:

```ts
if (isExpired) {
  await updateHedgeStatus(params.pool, hedge.protectionId, "expired_settled", {
    hedgeManagerAction: "expired",
    expiredAt: new Date().toISOString()
  });
  result.expired++;
  continue;
}
```

The platform marks the row `expired_settled` with no recorded TP recovery. **Deribit auto-settles the option at expiry**: ITM → cash credit to our account, OTM → zero.

### The reconciliation gap

The platform's `metadata.sellResult.totalProceeds` will be NULL/0 for these positions, so:
- The Phase 0 / admin "TP $" column shows nothing.
- The exec-quality rollup shows nothing.
- But the Deribit account balance has a credit equal to the option's intrinsic value at expiry.

So **economic recovery happened** but **isn't visible in the platform's books**.

For the pilot reconciliation statement (per Pilot Agreement §5.2), the operator would need to manually compare platform records to Deribit account statements to capture this gap.

### Recommended fix scope (post-pilot)

A daily reconciliation job that:
- Pulls Deribit `private/get_settlement_history`.
- For each settlement, finds the matching protection by `external_order_id`.
- Records the settlement amount in metadata as `expirySettlement`.

**Not required for pilot.** Manual reconciliation suffices.

---

## 10. Required actions before live pilot

In priority order:

| # | Action | Effort | Required? |
|---|---|---|---|
| **R3.A** | Wrap `getIndexPrice` failure in hedge-management scheduler with explicit warning | ~5 lines | **Required** |
| **R3.B** | Add `placeOrder` timeout wrapper in `venue.ts execute()` | ~6 lines | **Required** |
| **R3.C** | Persist no-bid retry count + warn at thresholds | ~25 lines | **Recommended** |
| R3.D | DB-pre-check Deribit available margin in admin endpoint | post-pilot | Optional |
| R3.E | Reconcile-pending background recovery job | post-pilot | Optional |
| R3.F | Deribit 429-aware retry with backoff | post-pilot | Optional |
| R3.G | Daily Deribit settlement reconciliation job | post-pilot | Optional |

**Minimum viable for live**: R3.A + R3.B + R3.C.

The R3.A + R3.B fixes are tiny (under 12 lines combined) and low-risk. R3.C is slightly larger but still small (~25 lines) and provides important visibility into the no-bid scenario which we KNOW happens (it's visible in 4 of 8 tier×side combinations on every Phase 2 chain snapshot).

---

## 11. Recommended next PR (subject to operator sign-off)

`feat(api): R3.A + R3.B + R3.C — failure-mode hardening (no-spot guard, execute timeout, no-bid escalation)`

Scope:
- 5-line guard around `getIndexPrice` in hedge-mgmt scheduler.
- 6-line `Promise.race` timeout around `placeOrder` in `venue.ts execute()`.
- ~25 lines persisting no-bid retry count + threshold warnings.
- 1 regression test confirming the timeout fires.
- Documentation update.

Estimated: 40-50 lines net code change. Lower scope than PR #44 (which was 257 net additions).

**Awaiting operator decision** on whether to ship R3.A/B/C now. R3.D-G are all post-pilot.

---

_End of R3 audit._
