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

## Server boot wiring (LiquidChainCache + Bullish + Deribit)

The production `server.ts` should construct the cache with both venues so live
activations get the cheapest tradable strike across Bullish + Deribit. Snippet:

```ts
// At the top of server bootstrap, alongside other singletons:
import { BullishTradingClient } from "./pilot/bullish";
import { LiquidChainCache } from "./singleSide/twoSided/liquidChainCache";
import { fetchFullChainSnapshot } from "../scripts/backtest/singleSide/liquidStrikePicker";
import { fetchBullishChainSnapshot } from "./singleSide/twoSided/bullishChainProvider";

// Reuse the shared Bullish client (same instance used by chain warmer)
const sharedBullishClient = new BullishTradingClient(pilotConfig.bullish);

// Per-cell defaults — adjust based on what cells are in allowlist.
// Centered on whatever the current spot is at refresh time; deribit's spot
// is used since fetchFullChainSnapshot returns it.
const liquidChainCache = new LiquidChainCache({
  ttlMs: 30_000,
  staleMaxAgeMs: 5 * 60_000,
  providers: [
    {
      venue: "deribit",
      fetch: async () => await fetchFullChainSnapshot()
    },
    {
      venue: "bullish",
      fetch: async () => {
        // Need an approximate spot to anchor window; pull from Deribit-side cache
        const lastSnap = liquidChainCache.getCached();
        const centerSpot = lastSnap?.spot ?? 75_000;
        return await fetchBullishChainSnapshot(sharedBullishClient, centerSpot, {
          centerSpot,
          centerTenorDays: 3,      // matches Phase 0 cell tenor — widen if other cells active
          strikeWindowUsdc: 6_000,
          tenorWindowDays: 2,      // covers 1d, 2d, 3d cells
          maxConcurrency: 4,
          timeoutMs: 4_000
        });
      }
    }
  ]
});

// Then wire into routes:
registerFoxifyV2Routes(app, {
  // ...existing deps...
  liquidChainCache
});
```

After deploy, `/admin/foxify/v2/diagnostics` should reflect both venues
quoting (you'll see venue counts in the merged snapshot). If Bullish creds
are wrong / not set, the cache fail-opens to Deribit-only (logged with
`venueStatus.bullish.ok = false`).
