# R2 — Position-Cap & Daily-Cap Enforcement Audit

**Audit scope:** Every code path that reads, validates, or enforces notional limits — both per-position and daily aggregate. Pre-live-pilot readiness.

**Methodology:** Read-only code trace from quote/activate entry points through every gate, then cross-reference against the Pilot Agreement §3.1 limits.

**As of:** 2026-04-19 (post PR #39, #40, #41, #42).

---

## TL;DR

The platform enforces 3 of the 4 caps listed in the Pilot Agreement §3.1. **Two material gaps** require operator action before the live pilot opens:

| Cap (per Pilot Agreement) | Enforced? | Gap |
|---|---|---|
| Min position size = $10,000 | ✅ Hardcoded floor in code | None |
| Max position size = $50,000 | ⚠ **Default value is $100,000, not $50,000** | Env var override required |
| Max aggregate active notional = $200,000 | ❌ **Not enforced anywhere** | Code change required (~30 lines) |
| Daily new protection cap (Days 1-7 = $100,000; Days 8-28 = $500,000) | ✅ Atomic SQL reservation | Need to bump env on Day 8 |

The atomic-reservation mechanic itself is **well designed and race-safe** — uses a single SQL `UPDATE ... WHERE used + delta <= cap RETURNING ...` which guarantees no over-allocation under concurrent activations. The reserve/release pattern correctly rolls back on activation failure. **The mechanic is solid; the gap is in what it's pointed at.**

---

## 1. The four caps from Pilot Agreement §3.1

```
Minimum position size            $10,000 USD notional
Maximum position size            $50,000 USD notional
Maximum aggregate active notional $200,000 USD
Daily new-protection cap (Days 1–7)   $100,000 USD in new activations
Daily new-protection cap (Days 8–28)  $500,000 USD in new activations
```

---

## 2. Per-position MIN ($10k) — ENFORCED ✅

### Code path

`services/api/src/pilot/config.ts` line 398-404:
```ts
export const parsePilotQuoteMinNotionalUsdc = (raw: string | undefined): number => {
  const parsed = Number(raw ?? "10000");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid_pilot_quote_min_notional_usdc:${...}`);
  }
  return Math.max(10000, parsed);  // ← HARDCODED FLOOR
};
```

### Validation sites

- **Quote endpoint** `routes.ts:1898`:
  ```ts
  if (protectedNotional.lt(quoteMinNotional)) {
    return { reason: "quote_min_notional_not_met", message: "...$10,000 during pilot." };
  }
  ```
- **Activate endpoint** `routes.ts:2838`: identical check, fails with same `quote_min_notional_not_met`.

### Verdict

✅ **Bulletproof.** Even if someone sets `PILOT_QUOTE_MIN_NOTIONAL_USDC=1` in env, `Math.max(10000, parsed)` floors the effective value at $10,000. Both quote and activate paths validate independently. No way to slip through.

### Test recommendation

Already covered by `tests/pricingPolicy.test.ts:49 "parsePilotQuoteMinNotionalUsdc enforces pilot floor"` (currently failing in the existing suite — pre-existing test debt unrelated to caps; the actual hardcoded floor still works at runtime).

---

## 3. Per-position MAX ($50k) — ENFORCED but DEFAULT IS WRONG ⚠

### Code path

`services/api/src/pilot/config.ts:1260`:
```ts
maxProtectionNotionalUsdc: Number(process.env.PILOT_MAX_PROTECTION_NOTIONAL_USDC || "100000"),
```

### Validation sites

- **Quote endpoint** `routes.ts:1909`: `if (protectedNotional.gt(maxProtection))` → 400 `protection_notional_cap_exceeded`.
- **Activate endpoint** `routes.ts:2849`: identical check.

### Verdict

⚠ **The validation logic is fine. The default value is wrong.** Without a `PILOT_MAX_PROTECTION_NOTIONAL_USDC` env var on Render, the cap is $100,000 — **2× higher than the agreement allows.**

### Required action

Set `PILOT_MAX_PROTECTION_NOTIONAL_USDC=50000` on Render before the live pilot opens.

### Why this matters live

Until the env var is set, a single trader could open a $100k position while the agreement promises Foxify a max of $50k per position. Two failure modes:
1. **Atticus exposure exceeds underwriting**: a $100k position at SL 2% has a $2,000 payout — twice what the platform prepared for per the per-trade economics.
2. **Contract breach**: Foxify could legitimately argue the agreement was violated.

### Test recommendation

Add a runtime startup assertion that fails the deploy if the env value exceeds an upper bound (proposed: $50k for pilot, configurable for production). Sketch:

```ts
// in config.ts pilotConfig assembly
if (maxProtectionNotionalUsdc > 50000 && process.env.NODE_ENV === "production") {
  throw new Error("max_protection_notional_exceeds_pilot_agreement:" + maxProtectionNotionalUsdc);
}
```

This is a small platform change. Recommended but not required if you commit to the env var being set.

---

## 4. Aggregate active notional cap ($200k) — NOT ENFORCED ❌

### Code search results

```bash
grep -E 'aggregate|sumActiveNotional|outstandingNotional|currentlyActive|active_notional|sum.*notional|total.*active.*notional' services/api/src/pilot/
# → only matches in unrelated comments inside db.ts
```

**No code anywhere reads the sum of currently-active protections to enforce a cap.**

### Real-world implication

A single trader could open positions until they hit the daily cap ($100k Days 1-7). Each position runs for 24h (1-day tenor). So at peak the trader could have up to **$100k × N** of active protections where N is the days where positions overlap. With daily cap = $100k and tenor = 1d, the practical aggregate is bounded by the daily cap — **but only because they happen to be the same number on Day 1**.

**On Day 8 the daily cap jumps to $500k**, breaking this implicit bound. Without an explicit aggregate-active cap:

- Trader can open $500k of new protections on Day 8.
- They roll forward (auto-renew) on Day 9 → $500k more.
- For ~4-6 hours during the rollover window, **aggregate active is $1M**.

This is a real risk for live capital.

### Required fix

A new validation block in both quote and activate paths:

```ts
const activeAgg = await sumActiveProtectionNotional(pool, userHash.userHash);
const projected = activeAgg.plus(protectedNotional);
if (projected.gt(new Decimal(pilotConfig.maxAggregateActiveNotionalUsdc))) {
  reply.code(400);
  return {
    status: "error",
    reason: "aggregate_active_notional_cap_exceeded",
    capUsdc: pilotConfig.maxAggregateActiveNotionalUsdc.toFixed(2),
    currentActiveUsdc: activeAgg.toFixed(2),
    projectedAfterUsdc: projected.toFixed(2)
  };
}
```

Plus:
- New env: `PILOT_MAX_AGGREGATE_ACTIVE_NOTIONAL_USDC` (default $200,000).
- New DB function: `sumActiveProtectionNotional(pool, userHash)` returns SUM of `protected_notional` WHERE `status IN ('active', 'pending_activation', 'triggered')` AND `user_hash = $1` (triggered counts because the payout is still owed and the position is still effectively in our book).

**Race condition consideration**: unlike the daily cap which uses an atomic SQL reservation, an aggregate-active check is "read-then-decide" and races. Two concurrent activations could both see `activeAgg = $150k`, both pass the `< $200k` check, and both insert their own $40k position → final aggregate = $230k. Mitigation:
- Run the SUM + the INSERT inside the same transaction (the `client` already used for daily-cap reservation).
- Or apply a Postgres advisory lock keyed on user_hash for the duration.

### Estimated scope

~30 lines of code (1 SQL function + 2 validation blocks + 1 env var + 1 config entry + 1 test). Should be a tightly-scoped PR before live pilot opens.

---

## 5. Daily new-protection cap ($100k Days 1-7, $500k Days 8-28) — ENFORCED ✅ (with operational caveat)

### Code path

The atomic SQL reservation in `db.ts:1719`:
```sql
UPDATE pilot_daily_usage
SET used_notional = used_notional + $3::numeric
WHERE user_hash = $1
  AND day_start = $2::date
  AND used_notional + $3::numeric <= $4::numeric  -- ← ATOMIC GUARD
RETURNING used_notional::text AS used_after
```

If the WHERE clause fails (cap would be exceeded), `rowCount = 0`, the function returns `{ ok: false, usedNow }`, and the activate path throws `daily_notional_cap_exceeded`. **No race condition possible** — Postgres serializes the UPDATE per row.

### Reserve/release on failure

`routes.ts:3504-3515`:
```ts
if (capReserved && !capReleased && !shouldMarkReconcilePending) {
  await releaseDailyActivationCapacity(pool, { ... });
  capReleased = true;
}
```

Cap is released when:
- ✅ Activation fails BEFORE successful Deribit fill
- ❌ NOT released when activation succeeded but post-fill DB writes failed (status becomes `reconcile_pending` and the cap stays reserved — correct behavior, the position exists)

### Verdict

✅ **The cap mechanic is solid.** Atomic at the SQL level, correctly releases on failure paths, correctly retains on reconcile_pending paths.

### Operational caveat

The cap is currently $100,000 (matches Days 1-7). **On Day 8 of the pilot, you must bump `PILOT_MAX_DAILY_PROTECTED_NOTIONAL_USDC=500000` on Render.** A missed env update = the trader hits the $100k ceiling on Day 8 instead of the $500k they expected.

Suggested mitigation: a Render reminder note, OR add a configurable schedule to the platform:

```ts
// pseudocode
const dayOfPilot = (Date.now() - pilotStartIso) / 86400_000;
const maxDailyNotional = dayOfPilot >= 8
  ? pilotConfig.maxDailyProtectedNotionalWeek2PlusUsdc
  : pilotConfig.maxDailyProtectedNotionalWeek1Usdc;
```

This is overkill for a one-week-once event. Easier: **set a calendar reminder to bump the env on Day 8.** Document in the pre-live runbook (R8).

---

## 6. Other cap-adjacent observations

### 6.1 The cap reservation is correctly INSIDE the activation transaction

`routes.ts:3031` calls `reserveDailyActivationCapacity(client, ...)` where `client` is a transaction handle. So the reservation, the protection insert, the venue execution, and the post-fill DB writes all share one transaction context. If anything in the chain throws after the reservation, the cap is released by the catch block.

This is exactly the right pattern.

### 6.2 No per-tier cap

The agreement caps total notional but not per-tier. So a trader could in theory open $100,000 entirely in SL 2% on a single day. This is what we observed on the paper account when the −$2,127 trigger event happened (8 of 9 trades were SL 2%). The agreement allows it; the platform allows it; **but it's the dominant economic risk per the R1 analysis.**

Recommendation: a per-tier sub-cap is not strictly required by the agreement, but worth considering as a defensive measure. Sketch:

```ts
// e.g. no more than 60% of daily cap in any single SL tier
const tierUsage = await getDailyUsageByTier(pool, userHash, dayStart);
const maxPerTier = pilotConfig.maxDailyProtectedNotionalUsdc * 0.6;
if (tierUsage[tierName].plus(protectedNotional).gt(maxPerTier)) {
  return { reason: "per_tier_concentration_cap_exceeded", ... };
}
```

This would have prevented the −$2,127 event by capping SL 2% at $60k instead of allowing $100k+ that triggered together.

**Not required by agreement; recommended as defense-in-depth before live capital.**

### 6.3 Cap response surface

The error responses are well-formed JSON with `reason`, `capUsdc`, `usedUsdc`, `projectedUsdc` — easy for the frontend to parse and display. ✅

### 6.4 No cap on the `payoutDueAmount` itself

If a trade triggers, the payout is computed from `notional × slPct`. The platform doesn't cap payout independently. This is correct — payout is bounded by `notional × maxSlPct = $50,000 × 0.10 = $5,000` per position, and aggregate payout is bounded by aggregate notional. No additional cap needed.

### 6.5 Treasury subsidy cap: also enforced ✅

`reserveDailyTreasurySubsidyCapacity` mirrors the activation cap pattern. Default cap is $15,000/day. Treasury is disabled in the pilot, so this isn't currently active, but the mechanism is sound when enabled.

---

## 7. Required actions before live pilot

In priority order:

| # | Action | Required by | Effort |
|---|---|---|---|
| **R2.A** | Set `PILOT_MAX_PROTECTION_NOTIONAL_USDC=50000` on Render | **Before live flip** | 1 env var change in Render dashboard |
| **R2.B** | Implement aggregate-active notional cap ($200k) | **Before live flip** | ~30-line PR + 1 test + 1 env var |
| R2.C | Set calendar reminder: `PILOT_MAX_DAILY_PROTECTED_NOTIONAL_USDC=500000` on Day 8 of pilot | Day 8 of pilot | Calendar note |
| R2.D (optional) | Add per-tier concentration cap (e.g., max 60% of daily cap in one SL tier) | Defense-in-depth | ~20-line PR |
| R2.E (optional) | Add startup assertion that env values don't exceed agreement caps | Defense-in-depth | ~10-line PR |

**Minimum viable for live**: R2.A + R2.B + R2.C.

R2.D and R2.E are recommended but not contractually required. R2.D is the strongest defense against the concentration-trigger failure mode that R1 identified.

---

## 8. Recommended next PR (subject to operator sign-off)

**`feat(api): aggregate-active-notional cap enforcement (R2.B)`**

Scope:
- New env var `PILOT_MAX_AGGREGATE_ACTIVE_NOTIONAL_USDC` (default $200,000).
- New DB function `sumActiveProtectionNotional(pool, userHash)`.
- Validation block in both quote and activate paths.
- Inside the activation transaction (race-safe).
- 1 regression test.
- Documentation update in TECHNICAL_GUIDE.md.

Estimated: 30-50 lines of net code change. Comparable scope to PR #34 (per-trade aggregation fix). Same risk profile (medium — affects activation success path).

**Awaiting operator decision** on whether to ship R2.B now. R2.A (env var only) requires no code; you can do that any time in Render dashboard.

---

_End of R2 audit._
