# Scheduled Spread Probe — Render Deploy

Cron worker that runs `liquidStrikePicker` + `probeChainSpreadDistribution`
every 4 hours, accumulating time-of-day data on `/tmp/liquid_picker_history.jsonl`.

After 24 hours of probes (= 6 data points spanning all sessions), run
`summarizeProbeHistory.ts` to see whether US-session hedge cost is meaningfully
different from Asian-session.

> **Note on render.yaml:** the repo's `render.yaml` is explicitly marked
> historical-only. Live services (`foxify-pilot-new*`) are managed via the
> Render dashboard. Use the dashboard recipe below; the yaml snippets are
> reference only.

---

## Dashboard recipe (5 minutes)

1. **Render Dashboard → New → Cron Job**
2. **Name:** `foxify-spread-probe`
3. **Region:** Singapore (same as foxify-pilot-new for low latency to DB)
4. **Branch:** the same branch foxify-pilot-new is tracking (cursor/...)
5. **Build command:** `npm ci`
6. **Command:** `npm --workspace services/api exec tsx scripts/integration/scheduledSpreadProbe.ts`
7. **Schedule:** `0 0,4,8,12,14,16,18,20 * * *` (8 times/day, weighted to US session)
8. **Plan:** Starter ($7/mo)
9. **Persistent disk:** add 1GB disk mounted at `/tmp` (for history JSONL)
10. **Env vars:** `NODE_ENV=production`
11. **Save** → first run will fire within the next 4h
12. After 24h: run `npm --workspace services/api exec tsx scripts/integration/summarizeProbeHistory.ts` (locally or via render shell) — generates the time-of-day report.

---

## Option A: render.yaml snippet (reference / blueprint)

Add to `render.yaml` (or create via dashboard):

```yaml
services:
  - name: foxify-spread-probe
    type: cron
    env: node
    plan: starter        # ~$7/mo; runs are <1 min each
    buildCommand: cd services/api && npm install
    schedule: "0 0,4,8,12,14,16,18,20 * * *"
    # Schedule = every 4h with 14:00 (US open) and 18:00 (peak US) extras.
    # Times: 00, 04, 08 (Asia/EU), 12 (EU close), 14, 16, 18 (US), 20 (US end)
    startCommand: cd services/api && npx tsx scripts/integration/scheduledSpreadProbe.ts
    envVars:
      - key: NODE_ENV
        value: production
    disk:
      name: probe-history
      mountPath: /tmp
      sizeGB: 1
```

**Limitation:** Render cron jobs don't persist /tmp between runs by default.
The `disk` mount above gives us a persistent 1GB volume. Cost: ~$0.25/mo.

**Alternative if cron + disk feels too heavy:** option B below.

---

## Option B: Background Worker (simpler operationally)

A long-running worker that ticks every 4h. Survives restarts; /tmp survives
within container lifetime.

```yaml
services:
  - name: foxify-spread-probe-worker
    type: worker
    env: node
    plan: starter
    buildCommand: cd services/api && npm install
    startCommand: cd services/api && npx tsx scripts/integration/scheduledSpreadProbe.ts
    envVars:
      - key: SPREAD_PROBE_INTERVAL_MIN
        value: "240"    # 4h
      - key: NODE_ENV
        value: production
```

**Limitation:** if the worker restarts (deploy / crash), in-memory state is lost
and /tmp is reset. Mitigation: ship history to S3 daily, or use a persistent disk.

---

## Local one-shot test

```bash
cd services/api
npx tsx scripts/integration/scheduledSpreadProbe.ts
# expect 3 entries appended to /tmp/liquid_picker_history.jsonl
cat /tmp/liquid_picker_history.jsonl | tail -3
```

---

## Read the data after 24h

```bash
cd services/api
npx tsx scripts/integration/summarizeProbeHistory.ts
# generates docs/PHASE_1_SPREAD_TIMEOFDAY_<date>.md
```

Look for:
1. **Hedge cost for pair_50k_2pct_itm by hour.** If US session (14-21 UTC) is
   meaningfully cheaper than Asian (0-8 UTC), gate ITM activations by hour.
2. **Median spread for ITM put/call by hour.** Confirms our 3am UTC probe was
   in the worst-liquidity window.

---

## What to do with findings

If US-session hedge cost drops Phase 0 from $3,343 → $2,500:
  - Re-run V5 sweep — Phase 0 calm EV moves from -$308 → +$200 (calm becomes viable)
  - Add `pair_50k_2pct` to calm allowlist BUT gated by `utcHour ∈ [13, 21]`
  - Implementation: add `UTC_HOUR_GATE` constraint to `canActivate` in guardrails.ts

If costs are flat all day:
  - Spreads are structural, not session-dependent
  - Calm halt stays
  - Phase 0 stays moderate+ only (the V5 default)

---

## Stop / disable

To pause: in Render dashboard, suspend the service (no cost).
To delete: dashboard → settings → delete service.

---

## Server boot wiring (DONE in server.ts as of this commit)

`src/server.ts` now constructs the cache + registers routes when env flag
is set:

```bash
FOXIFY_V2_ENABLED=true
```

When enabled, server boot does:
1. Construct `LiquidChainCache` with Deribit provider always, Bullish provider
   if `PILOT_BULLISH_ENABLED=true` and creds are set
2. Construct `liquidChainAnchorProvider(cache)` so `buildQuote` reuses cache
3. Start `FeedService` + `DvolService` (5s + 60s polling)
4. Instantiate `ShadowStrangleExecutor` (no real orders by default)
5. Call `registerFoxifyV2Routes(app, {...deps})` mounting `/foxify/v2/*` +
   `/admin/foxify/v2/*`

Boot log will print:
```
[FoxifyV2] Routes registered at /foxify/v2/* and /admin/foxify/v2/* (bullish_quotes=true)
```

If `PILOT_BULLISH_ENABLED=false`, you'll see:
```
[FoxifyV2] Bullish disabled (PILOT_BULLISH_ENABLED=false). Cache will run Deribit-only.
```

---

## Pre-deploy smoke test (run BEFORE flipping FOXIFY_V2_ENABLED=true)

Verifies real Bullish creds work end-to-end against the actual API:

```bash
cd services/api
# Set all four Bullish env vars from Render dashboard (do NOT paste into chat).
export PILOT_BULLISH_ENABLED=true
export PILOT_BULLISH_ECDSA_PRIVATE_KEY="...from Render..."
export PILOT_BULLISH_ECDSA_PUBLIC_KEY="...from Render..."
export PILOT_BULLISH_ECDSA_METADATA="...from Render..."
export PILOT_BULLISH_TRADING_ACCOUNT_ID="...from Render..."
export PILOT_BULLISH_REST_BASE_URL="https://api.simnext.bullish-test.com"

npx tsx scripts/integration/smokeBullishChainProvider.ts
```

Expected output (success):
```
# Bullish chain provider smoke test
Config:
  restBaseUrl: https://api.simnext.bullish-test.com
  authMode:    ecdsa
  tradingAccountId: (set)
  ECDSA private key: (set)
...
Fetching Bullish markets list (auth smoke check)...
  N markets total, M BTC options
Fetching Bullish chain snapshot (tenor=1d, ...)
  Got X quotes in Yms
  Top 5 by ask: ...
✓ Bullish chain provider smoke test PASSED
```

Failure modes:
- "FAIL: PILOT_BULLISH_ENABLED is false" → set the env var
- "FAIL: Bullish getMarkets failed: ..." → bad creds or wrong base URL
- "Got 0 quotes" → strike/tenor window misses your venue's chain
  (adjust centerSpot, strikeWindowUsdc, tenorWindowDays)

---

## Production rollout sequence

1. **Verify smoke test passes locally** (with Render env vars copied to local shell, then unset).
2. **Set `FOXIFY_V2_ENABLED=true` in Render dashboard**, redeploy.
3. **Boot log check:** look for `[FoxifyV2] Routes registered` with `bullish_quotes=true`.
4. **Sanity check `/foxify/v2/regime`:** should return current DVOL.
5. **Shadow activation test:** POST `/foxify/v2/activate` with `isShadow=true`. Verify pair lands in `two_sided_pair` table.
6. **Diagnostics:** GET `/admin/foxify/v2/diagnostics` should show per-venue
   status under `liquid_chain_cache.venueStatus.bullish` and `.deribit`.

Only after 14 days of shadow data validates V5 predictions, set
`FOXIFY_V2_LIVE_EXECUTION=true` (follow-up — live wiring not in this commit).
