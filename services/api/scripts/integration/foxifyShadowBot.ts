/**
 * Foxify shadow bot — drives realistic activation patterns into /foxify/v2/activate
 * in shadow mode (is_shadow=true) for empirical EV validation.
 *
 * Purpose:
 *   The cell sweep MC models (V1/V2/V3) all have known limitations. Real proof
 *   requires running the activation flow against real BTC paths and seeing
 *   actual settled PnL after 14 days.
 *
 * What the bot does:
 *   1. Polls current regime via /foxify/v2/regime
 *   2. Picks the best-EV cell for the current regime (from regime allowlist)
 *   3. Activates a shadow pair via POST /foxify/v2/activate {isShadow: true}
 *   4. Repeats at the configured cadence (e.g., 25/day = ~57 min interval)
 *   5. Stops automatically if Atticus halts (canActivate returns 503)
 *   6. Logs all activity to stdout as JSON (Render/CloudWatch captures)
 *
 * What it proves:
 *   - Foxify-side API integration (Foxify's bot would do exactly this)
 *   - Trigger detection fires on real BTC moves
 *   - TP curve captures actual peaks
 *   - Settlement math matches MC predictions within drift threshold
 *   - Webhook delivery reliability
 *   - Multi-pair concurrency under realistic load
 *
 * Operator runbook:
 *   Set FOXIFY_API_KEY + endpoint env. Run as a background process on Render
 *   or local VM. Let it accumulate 14 days of shadow data. Then query:
 *     GET /foxify/v2/status — daily aggregate
 *     GET /admin/foxify/v2/diagnostics — full state
 *     SELECT * FROM two_sided_pair WHERE is_shadow = TRUE — raw data
 *
 * Usage:
 *   export FOXIFY_API_KEY=<token>
 *   export FOXIFY_API_URL=<atticus-api-base-url>
 *   export SHADOW_BOT_PAIRS_PER_DAY=25
 *   npx tsx scripts/integration/foxifyShadowBot.ts
 */

const FOXIFY_API_URL = process.env.FOXIFY_API_URL ?? "";
const FOXIFY_API_KEY = process.env.FOXIFY_API_KEY ?? "";
const PAIRS_PER_DAY = Number(process.env.SHADOW_BOT_PAIRS_PER_DAY ?? "25");
const POLL_INTERVAL_MS = Math.max(60_000, Math.floor(86_400_000 / PAIRS_PER_DAY));
const MAX_ACCEPTABLE_HEDGE_USD = Number(process.env.SHADOW_BOT_MAX_HEDGE_USD ?? "10000");
const STOP_AFTER_HOURS = Number(process.env.SHADOW_BOT_STOP_AFTER_HOURS ?? "0");

/**
 * Regime → preferred cells (per V3 sweep).
 * Bot tries cells in order; first one that activates wins.
 */
const CELL_PREFERENCE_BY_REGIME: Record<string, string[]> = {
  calm: ["pair_25k_5pct_otm_short"],
  moderate: ["pair_25k_5pct_otm_short", "pair_50k_4pct_otm_short"],
  elevated: ["pair_50k_5pct_otm", "pair_50k_4pct_otm_short", "pair_25k_5pct_otm_short"],
  stress: ["pair_50k_5pct_otm", "pair_50k_4pct_otm_short", "pair_25k_5pct_otm_short"]
};

const log = (msg: string, meta?: Record<string, unknown>): void => {
  const entry = { ts: new Date().toISOString(), svc: "foxify-shadow-bot", msg, ...meta };
  console.log(JSON.stringify(entry));
};

const fetchJson = async <T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8_000
): Promise<{ ok: boolean; status: number; body: T | null; raw: string }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const raw = await res.text();
    let body: T | null = null;
    try { body = JSON.parse(raw) as T; } catch { /* keep raw */ }
    return { ok: res.ok, status: res.status, body, raw };
  } catch (e) {
    return { ok: false, status: 0, body: null, raw: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
};

type RegimeResp = { regime: string; dvol: number | null; halt: { atticus: boolean; foxify: boolean; reason: string | null } };

const getCurrentRegime = async (): Promise<RegimeResp | null> => {
  const r = await fetchJson<RegimeResp>(`${FOXIFY_API_URL}/foxify/v2/regime`, {
    headers: { "X-Foxify-Token": FOXIFY_API_KEY }
  });
  if (!r.ok || !r.body) {
    log("regime fetch failed", { status: r.status, raw: r.raw.slice(0, 200) });
    return null;
  }
  return r.body;
};

type ActivateResp = { pair_id: string; status: string; foxify_pair_ref: string };
type ErrResp = { error: string; message?: string; details?: Record<string, unknown>; retry_after_s?: number };

const activateShadowPair = async (cellId: string): Promise<{ success: boolean; pairId?: string; reason?: string; details?: unknown }> => {
  const foxifyPairRef = `shadow-bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const r = await fetchJson<ActivateResp | ErrResp>(`${FOXIFY_API_URL}/foxify/v2/activate`, {
    method: "POST",
    headers: { "X-Foxify-Token": FOXIFY_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      cellId,
      maxAcceptableHedgeCostUsdc: MAX_ACCEPTABLE_HEDGE_USD,
      foxifyPairRef,
      isShadow: true,
      metadata: { source: "shadow_bot", bot_version: "1.0.0" }
    })
  });
  if (r.status === 201 && r.body && "pair_id" in r.body) {
    return { success: true, pairId: r.body.pair_id };
  }
  const err = (r.body as ErrResp | null)?.error ?? "unknown_error";
  return { success: false, reason: err, details: r.body };
};

let tickCount = 0;
let successCount = 0;
let blockedCount = 0;
const blockReasonCounts: Record<string, number> = {};
const startMs = Date.now();

const tick = async (): Promise<void> => {
  tickCount++;
  const regime = await getCurrentRegime();
  if (!regime) {
    log("tick skipped — regime fetch failed");
    return;
  }
  log("regime", { regime: regime.regime, dvol: regime.dvol, halt: regime.halt });

  if (regime.halt.atticus || regime.halt.foxify) {
    blockedCount++;
    const reason = `halt:${regime.halt.atticus ? "atticus" : "foxify"}:${regime.halt.reason ?? "unknown"}`;
    blockReasonCounts[reason] = (blockReasonCounts[reason] ?? 0) + 1;
    log("activate skipped — halt active", { reason });
    return;
  }

  const preferred = CELL_PREFERENCE_BY_REGIME[regime.regime] ?? [];
  if (preferred.length === 0) {
    blockedCount++;
    log("activate skipped — no cells preferred for regime", { regime: regime.regime });
    return;
  }

  for (const cellId of preferred) {
    const r = await activateShadowPair(cellId);
    if (r.success) {
      successCount++;
      log("ACTIVATE OK", { cellId, pairId: r.pairId });
      return;
    }
    const reasonStr = String(r.reason);
    blockReasonCounts[reasonStr] = (blockReasonCounts[reasonStr] ?? 0) + 1;
    log("activate rejected", { cellId, reason: r.reason, details: r.details });
    if (reasonStr === "cell_disabled_in_regime" || reasonStr === "price_exceeded") {
      continue;
    }
    break;
  }
  blockedCount++;
};

const printStats = (): void => {
  const runtimeMin = Math.round((Date.now() - startMs) / 60_000);
  log("STATS", {
    tickCount, successCount, blockedCount, runtimeMin,
    successRatePct: tickCount > 0 ? (100 * successCount / tickCount).toFixed(1) : "0",
    blockReasonCounts
  });
};

const main = async (): Promise<void> => {
  if (!FOXIFY_API_KEY) {
    console.error("FOXIFY_API_KEY env var required");
    process.exit(1);
  }
  if (!FOXIFY_API_URL) {
    console.error("FOXIFY_API_URL env var required (e.g. https://<your-render-host>)");
    process.exit(1);
  }
  log("Foxify shadow bot starting", {
    api_url: FOXIFY_API_URL,
    pairs_per_day: PAIRS_PER_DAY,
    poll_interval_ms: POLL_INTERVAL_MS,
    max_acceptable_hedge_usd: MAX_ACCEPTABLE_HEDGE_USD,
    stop_after_hours: STOP_AFTER_HOURS
  });

  await tick().catch((e) => log("tick error", { error: (e as Error).message }));

  const interval = setInterval(() => {
    void tick().catch((e) => log("tick error", { error: (e as Error).message }));
    if (tickCount % 10 === 0) printStats();
  }, POLL_INTERVAL_MS);

  setInterval(printStats, 30 * 60_000);

  if (STOP_AFTER_HOURS > 0) {
    setTimeout(() => {
      log("stop-after-hours reached; shutting down");
      clearInterval(interval);
      printStats();
      process.exit(0);
    }, STOP_AFTER_HOURS * 3_600_000);
  }

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      log(`received ${sig}; shutting down`);
      clearInterval(interval);
      printStats();
      process.exit(0);
    });
  }
};

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
