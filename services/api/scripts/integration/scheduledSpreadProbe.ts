/**
 * Scheduled spread probe — runs at multiple times of day to characterize
 * how cross-venue liquidity changes by session.
 *
 * Pulls BOTH Deribit and Bullish (when creds configured) per tick, merges,
 * picks the cheaper venue per leg, appends per-cell + per-venue cost to
 * history JSONL for time-of-day analysis.
 *
 * Deployment as Render Background Worker:
 *   export SPREAD_PROBE_INTERVAL_MIN=240
 *   export PILOT_BULLISH_ENABLED=true               (optional — enables Bullish)
 *   export PILOT_BULLISH_ECDSA_PRIVATE_KEY=...      (required if Bullish enabled)
 *   export PILOT_BULLISH_ECDSA_PUBLIC_KEY=...
 *   export PILOT_BULLISH_ECDSA_METADATA=...
 *   export PILOT_BULLISH_TRADING_ACCOUNT_ID=...
 *   export PILOT_BULLISH_REST_BASE_URL=...
 *   npx tsx scripts/integration/scheduledSpreadProbe.ts
 *
 * Or as a Cron Job (one-shot mode, run each scheduled time):
 *   command: npx tsx scripts/integration/scheduledSpreadProbe.ts
 *   (omit SPREAD_PROBE_INTERVAL_MIN)
 *
 * Output JSONL:
 *   /tmp/spread_distribution_history.jsonl (from chain spread probe)
 *   /tmp/liquid_picker_history.jsonl       (from this script — per-cell costs)
 *
 * History columns (per cell × tick):
 *   runAt, utcHour, spot,
 *   cellId, putStrike (target), callStrike (target),
 *   pickedPutStrike, pickedCallStrike, pickedPutInstr, pickedCallInstr,
 *   pickedPutVenue, pickedCallVenue,                ← NEW: which venue won
 *   putAskTotal, callAskTotal, hedgeCostTotal,
 *   putSpread, callSpread,
 *   putPickerType, callPickerType,
 *   deribitOnlyHedgeCostTotal, bullishOnlyHedgeCostTotal,  ← NEW: per-venue cost (when both quote)
 *   bullishQuotesAvailable, deribitQuotesAvailable          ← NEW: venue status
 *
 * After ~24h, run summarizeProbeHistory.ts for per-venue × hour-of-day analysis.
 */

import * as fs from "node:fs/promises";
import {
  fetchFullChainSnapshot,
  mergeChainSnapshots,
  pickLiquidStrike,
  type DeribitQuote
} from "../backtest/singleSide/liquidStrikePicker";
import { execSync } from "node:child_process";

const PROBE_CELLS = [
  { cellId: "pair_50k_2pct_itm", tenorDays: 3, putItmPct: 0.013, callItmPct: 0.013, contractsBtc: 1.4 },
  { cellId: "pair_25k_5pct_otm_3d", tenorDays: 3, putItmPct: -0.020, callItmPct: -0.025, contractsBtc: 0.5 },
  { cellId: "pair_25k_5pct_otm_short", tenorDays: 1, putItmPct: -0.020, callItmPct: -0.025, contractsBtc: 0.5 }
];

const BULLISH_PROBE_CONFIG = {
  strikeWindowUsdc: 6_000,
  tenorWindowDays: 2,    // covers 1d, 2d, 3d cells in one Bullish pull
  centerTenorDays: 3,    // central tenor — Bullish provider expects a focal point
  maxConcurrency: 2,     // reduced from 4 to respect Bullish ~10 req/sec rate limit
  timeoutMs: 5_000
};

/**
 * Pull Bullish chain if creds configured. Returns null if Bullish disabled or
 * fetch fails. Fail-open: probe continues with Deribit-only data.
 */
const tryFetchBullishChain = async (spot: number): Promise<{ spot: number; quotes: DeribitQuote[] } | null> => {
  if (String(process.env.PILOT_BULLISH_ENABLED ?? "").toLowerCase() !== "true") {
    return null;
  }
  try {
    const { BullishTradingClient } = await import("../../src/pilot/bullish");
    const { pilotConfig } = await import("../../src/pilot/config");
    const { fetchBullishChainSnapshot } = await import("../../src/singleSide/twoSided/bullishChainProvider");
    if (!pilotConfig.bullish.enabled) return null;
    const client = new BullishTradingClient(pilotConfig.bullish);
    const snap = await fetchBullishChainSnapshot(client, spot, {
      centerSpot: spot,
      centerTenorDays: BULLISH_PROBE_CONFIG.centerTenorDays,
      strikeWindowUsdc: BULLISH_PROBE_CONFIG.strikeWindowUsdc,
      tenorWindowDays: BULLISH_PROBE_CONFIG.tenorWindowDays,
      maxConcurrency: BULLISH_PROBE_CONFIG.maxConcurrency,
      timeoutMs: BULLISH_PROBE_CONFIG.timeoutMs
    });
    return snap;
  } catch (e) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      msg: "bullish_chain_fetch_failed",
      error: (e as Error).message
    }));
    return null;
  }
};

const probeOnce = async (): Promise<void> => {
  const startedAt = new Date();
  console.log(JSON.stringify({
    ts: startedAt.toISOString(),
    msg: "probe_started",
    utcHour: startedAt.getUTCHours()
  }));

  // Run the chain spread distribution probe (Deribit-only; existing script)
  try {
    execSync(`npx tsx ${import.meta.dirname}/../backtest/singleSide/probeChainSpreadDistribution.ts`, {
      cwd: process.cwd(), stdio: "inherit", timeout: 60_000
    });
  } catch (e) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      msg: "chain_probe_failed",
      error: (e as Error).message
    }));
  }

  // Liquid picker on each cell — now using merged Deribit + Bullish chain
  try {
    const deribitSnap = await fetchFullChainSnapshot();
    const spot = deribitSnap.spot;
    const bullishSnap = await tryFetchBullishChain(spot);
    const merged = mergeChainSnapshots([deribitSnap, bullishSnap]);
    const bullishCount = bullishSnap?.quotes.length ?? 0;
    const deribitCount = deribitSnap.quotes.length;

    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      msg: "chains_fetched",
      spot,
      deribit_quotes: deribitCount,
      bullish_quotes: bullishCount,
      merged_quotes: merged.quotes.length
    }));

    const entries: Array<Record<string, unknown>> = [];

    for (const cell of PROBE_CELLS) {
      const putStrike = Math.ceil(spot * (1 + cell.putItmPct) / 1_000) * 1_000;
      const callStrike = Math.floor(spot * (1 - cell.callItmPct) / 1_000) * 1_000;

      // Cross-venue pick (the real "what would production pay")
      const putPick = pickLiquidStrike(merged.quotes, putStrike, cell.tenorDays, "put", spot);
      const callPick = pickLiquidStrike(merged.quotes, callStrike, cell.tenorDays, "call", spot);
      const putAsk = (putPick.picked?.askUsdcPerBtc ?? 0) * cell.contractsBtc;
      const callAsk = (callPick.picked?.askUsdcPerBtc ?? 0) * cell.contractsBtc;
      const totalCost = putAsk + callAsk;

      // Per-venue separate picks for venue-comparison columns
      // (lets summarizeProbeHistory show "if we'd been Deribit-only vs Bullish-only vs cross")
      const deribitPutPick = pickLiquidStrike(
        deribitSnap.quotes, putStrike, cell.tenorDays, "put", spot
      );
      const deribitCallPick = pickLiquidStrike(
        deribitSnap.quotes, callStrike, cell.tenorDays, "call", spot
      );
      const deribitOnlyCost =
        ((deribitPutPick.picked?.askUsdcPerBtc ?? 0) + (deribitCallPick.picked?.askUsdcPerBtc ?? 0)) *
        cell.contractsBtc;

      const bullishOnlyCost = bullishSnap
        ? (() => {
            const bp = pickLiquidStrike(bullishSnap.quotes, putStrike, cell.tenorDays, "put", spot);
            const bc = pickLiquidStrike(bullishSnap.quotes, callStrike, cell.tenorDays, "call", spot);
            return ((bp.picked?.askUsdcPerBtc ?? 0) + (bc.picked?.askUsdcPerBtc ?? 0)) * cell.contractsBtc;
          })()
        : null;

      entries.push({
        runAt: startedAt.toISOString(),
        utcHour: startedAt.getUTCHours(),
        spot,
        cellId: cell.cellId,

        // Target strike (cell config-derived)
        putStrike,
        callStrike,

        // Cross-venue (production-equivalent) pick
        pickedPutStrike: putPick.picked?.strike ?? null,
        pickedCallStrike: callPick.picked?.strike ?? null,
        pickedPutInstr: putPick.picked?.instrument_name ?? null,
        pickedCallInstr: callPick.picked?.instrument_name ?? null,
        pickedPutVenue: putPick.picked?.venue ?? null,        // NEW
        pickedCallVenue: callPick.picked?.venue ?? null,      // NEW
        putAskTotal: putAsk,
        callAskTotal: callAsk,
        hedgeCostTotal: totalCost,
        putSpread: putPick.picked?.spreadPct ?? null,
        callSpread: callPick.picked?.spreadPct ?? null,
        putPickerType: putPick.picker,
        callPickerType: callPick.picker,

        // Per-venue breakouts for comparison analysis (NEW)
        deribitOnlyHedgeCostTotal: deribitOnlyCost,
        bullishOnlyHedgeCostTotal: bullishOnlyCost,
        bullishQuotesAvailable: bullishCount,
        deribitQuotesAvailable: deribitCount,

        // Savings vs Deribit-only baseline (NEW)
        crossVenueSavingsUsdc: deribitOnlyCost - totalCost,
        crossVenueSavingsPct: deribitOnlyCost > 0 ? (deribitOnlyCost - totalCost) / deribitOnlyCost : null
      });

      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        msg: "cell_probed",
        cellId: cell.cellId,
        hedgeCost: totalCost,
        deribitOnlyCost,
        bullishOnlyCost,
        winningVenues: `${putPick.picked?.venue ?? "—"}/${callPick.picked?.venue ?? "—"}`,
        savingsVsDeribit: Number((deribitOnlyCost - totalCost).toFixed(2))
      }));
    }

    const histPath = "/tmp/liquid_picker_history.jsonl";
    for (const e of entries) await fs.appendFile(histPath, JSON.stringify(e) + "\n");
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      msg: "history_appended",
      path: histPath,
      count: entries.length,
      bullish_active: bullishSnap != null
    }));
  } catch (e) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      msg: "liquid_probe_failed",
      error: (e as Error).message
    }));
  }
};

const main = async () => {
  const intervalMin = Number(process.env.SPREAD_PROBE_INTERVAL_MIN ?? "0");
  if (intervalMin === 0) {
    // One-shot mode (Cron Job invocation)
    await probeOnce();
    return;
  }
  // Worker mode: loop forever
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    msg: "worker_starting",
    intervalMin,
    bullish_configured: String(process.env.PILOT_BULLISH_ENABLED ?? "").toLowerCase() === "true"
  }));
  await probeOnce();
  setInterval(() => { void probeOnce(); }, intervalMin * 60_000);
};

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
