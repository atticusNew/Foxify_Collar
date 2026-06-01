/**
 * Foxify integration bot — the REFERENCE implementation of the Foxify-side
 * activation driver. This is what Foxify's bot does (or literally runs): it
 * watches Atticus's canonical signal and opens hedged pairs via the public API.
 *
 * PRODUCTION SIGNAL: it consumes GET /foxify/v2/should_activate (the canonical
 * bot-facing decision), NOT a hardcoded cell list. It fires exactly what Atticus
 * recommends:
 *   - good_to_activate=true  → fire from `recommended_cells` (the regime's live
 *                              allowlist, in order; fall through on per-cell reject)
 *   - calm_loss_leader.enabled → (opt-in) fire a budgeted loss-leader cell from
 *                              `eligible_cells` at <= max_loss_usdc (capped calm volume)
 *   - otherwise              → stand down
 *
 * SHADOW vs LIVE:
 *   Default SHADOW (is_shadow=true) — zero real-money risk; validates the full
 *   lifecycle (trigger detect, TP curve, settlement, webhooks) against real BTC
 *   paths. Set SHADOW_BOT_LIVE=true to fire REAL pairs (is_shadow=false) — this
 *   ALSO requires the server to have FOXIFY_V2_LIVE_EXECUTION=true for real venue
 *   orders to actually place; otherwise the server still shadows. The bot logs a
 *   loud warning on every live fire.
 *
 * Operator runbook: see docs/FOXIFY_LIVE_TEST_RUNBOOK.md.
 *
 * Usage:
 *   export FOXIFY_API_KEY=<token>
 *   export FOXIFY_API_URL=<atticus-api-base-url>
 *   export SHADOW_BOT_PAIRS_PER_DAY=25
 *   # optional live single-pair test:
 *   #   export SHADOW_BOT_LIVE=true SHADOW_BOT_PAIRS_PER_DAY=1 SHADOW_BOT_STOP_AFTER_HOURS=1
 *   npx tsx scripts/integration/foxifyShadowBot.ts
 */

const FOXIFY_API_URL = process.env.FOXIFY_API_URL ?? "";
const FOXIFY_API_KEY = process.env.FOXIFY_API_KEY ?? "";
const PAIRS_PER_DAY = Number(process.env.SHADOW_BOT_PAIRS_PER_DAY ?? "25");
const POLL_INTERVAL_MS = Math.max(60_000, Math.floor(86_400_000 / PAIRS_PER_DAY));
const MAX_ACCEPTABLE_HEDGE_USD = Number(process.env.SHADOW_BOT_MAX_HEDGE_USD ?? "10000");
const STOP_AFTER_HOURS = Number(process.env.SHADOW_BOT_STOP_AFTER_HOURS ?? "0");
/** Fire REAL pairs (is_shadow=false). Default false = shadow. Live venue orders
 *  ALSO require the server FOXIFY_V2_LIVE_EXECUTION=true. */
const LIVE = String(process.env.SHADOW_BOT_LIVE ?? "false").toLowerCase() === "true";
/** Whether to act on the calm loss-leader opt-in (default true; the SERVER gates
 *  whether it's offered at all via SS_TWO_SIDED_CALM_LOSS_LEADER). */
const LOSS_LEADER = String(process.env.SHADOW_BOT_LOSS_LEADER ?? "true").toLowerCase() === "true";

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

type ShouldActivateResp = {
  good_to_activate: boolean;
  reason?: string | null;
  regime: string | null;
  signal_tier?: string;
  recommended_cells?: string[];
  recommended_structure?: string | null;
  calm_loss_leader?: { enabled: boolean; max_loss_usdc?: number; eligible_cells?: string[] };
};

const getSignal = async (): Promise<ShouldActivateResp | null> => {
  const r = await fetchJson<ShouldActivateResp>(`${FOXIFY_API_URL}/foxify/v2/should_activate`, {
    headers: { "X-Foxify-Token": FOXIFY_API_KEY }
  });
  if (!r.ok || !r.body) {
    log("should_activate fetch failed", { status: r.status, raw: r.raw.slice(0, 200) });
    return null;
  }
  return r.body;
};

type ActivateResp = { pair_id: string; status: string; foxify_pair_ref: string };
type ErrResp = { error: string; message?: string; details?: Record<string, unknown>; retry_after_s?: number };

const activatePair = async (
  cellId: string,
  maxCostUsdc: number,
  mode: "signal" | "loss_leader"
): Promise<{ success: boolean; pairId?: string; reason?: string; details?: unknown }> => {
  const foxifyPairRef = `foxify-bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const r = await fetchJson<ActivateResp | ErrResp>(`${FOXIFY_API_URL}/foxify/v2/activate`, {
    method: "POST",
    headers: { "X-Foxify-Token": FOXIFY_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      cellId,
      maxAcceptableHedgeCostUsdc: maxCostUsdc,
      foxifyPairRef,
      // is_shadow=false ONLY in explicit LIVE mode. Real venue orders also require
      // the SERVER to have FOXIFY_V2_LIVE_EXECUTION=true.
      isShadow: !LIVE,
      metadata: { source: LIVE ? "foxify_bot_live" : "foxify_bot_shadow", mode, bot_version: "2.0.0" }
    })
  });
  if (r.status === 201 && r.body && "pair_id" in r.body) {
    return { success: true, pairId: r.body.pair_id };
  }
  const err = (r.body as ErrResp | null)?.error ?? "unknown_error";
  return { success: false, reason: err, details: r.body };
};

// Reject reasons that mean "try the next candidate cell" (vs a hard stop).
const FALLTHROUGH_REASONS = new Set(["cell_disabled_in_regime", "price_exceeded", "calm_loss_exceeds_budget"]);

let tickCount = 0;
let successCount = 0;
let blockedCount = 0;
const blockReasonCounts: Record<string, number> = {};
const startMs = Date.now();

const tick = async (): Promise<void> => {
  tickCount++;
  const sig = await getSignal();
  if (!sig) {
    log("tick skipped — signal fetch failed");
    return;
  }
  log("signal", {
    regime: sig.regime, good_to_activate: sig.good_to_activate, tier: sig.signal_tier,
    reason: sig.reason, recommended_cells: sig.recommended_cells,
    loss_leader: sig.calm_loss_leader?.enabled ? { budget: sig.calm_loss_leader.max_loss_usdc, cells: sig.calm_loss_leader.eligible_cells } : false
  });

  // Halt → stand down (should_activate sets reason=halt_active:* and good_to_activate=false).
  if (typeof sig.reason === "string" && sig.reason.startsWith("halt_active")) {
    blockedCount++;
    blockReasonCounts[sig.reason] = (blockReasonCounts[sig.reason] ?? 0) + 1;
    log("activate skipped — halt active", { reason: sig.reason });
    return;
  }

  // Decide the candidate cells + per-pair cost cap from the canonical signal.
  let candidates: string[] = [];
  let maxCost = MAX_ACCEPTABLE_HEDGE_USD;
  let mode: "signal" | "loss_leader" = "signal";
  if (sig.good_to_activate && (sig.recommended_cells?.length ?? 0) > 0) {
    candidates = sig.recommended_cells!;
    mode = "signal";
  } else if (LOSS_LEADER && sig.calm_loss_leader?.enabled && (sig.calm_loss_leader.eligible_cells?.length ?? 0) > 0) {
    // Budgeted calm volume: cap the bid at the loss-leader budget so we never pay
    // above max_loss_usdc (the server also enforces this).
    candidates = sig.calm_loss_leader.eligible_cells!;
    maxCost = sig.calm_loss_leader.max_loss_usdc ?? MAX_ACCEPTABLE_HEDGE_USD;
    mode = "loss_leader";
  } else {
    blockedCount++;
    log("activate skipped — stand down", { regime: sig.regime, good: sig.good_to_activate, loss_leader: sig.calm_loss_leader?.enabled ?? false });
    return;
  }

  if (LIVE) log("⚠️  LIVE MODE — firing REAL pair (is_shadow=false)", { mode, maxCost });

  for (const cellId of candidates) {
    const r = await activatePair(cellId, maxCost, mode);
    if (r.success) {
      successCount++;
      log(LIVE ? "ACTIVATE OK (LIVE)" : "ACTIVATE OK", { cellId, pairId: r.pairId, mode });
      return;
    }
    const reasonStr = String(r.reason);
    blockReasonCounts[reasonStr] = (blockReasonCounts[reasonStr] ?? 0) + 1;
    log("activate rejected", { cellId, reason: r.reason, mode, details: r.details });
    if (FALLTHROUGH_REASONS.has(reasonStr)) continue; // try the next candidate
    break; // hard error (feed_unavailable, depth, halt, etc.) — stop this tick
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
  log(LIVE ? "⚠️  Foxify bot starting in LIVE mode (REAL pairs)" : "Foxify bot starting (SHADOW mode)", {
    api_url: FOXIFY_API_URL,
    mode: LIVE ? "LIVE" : "shadow",
    loss_leader_enabled: LOSS_LEADER,
    pairs_per_day: PAIRS_PER_DAY,
    poll_interval_ms: POLL_INTERVAL_MS,
    max_acceptable_hedge_usd: MAX_ACCEPTABLE_HEDGE_USD,
    stop_after_hours: STOP_AFTER_HOURS,
    signal_source: "/foxify/v2/should_activate"
  });
  if (LIVE) {
    log("⚠️  LIVE: is_shadow=false on every fire. Real venue orders also require server FOXIFY_V2_LIVE_EXECUTION=true. Use SHADOW_BOT_PAIRS_PER_DAY=1 + SHADOW_BOT_STOP_AFTER_HOURS for a single controlled test.");
  }

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
