/**
 * Scheduled spread probe — runs at multiple times of day to characterize
 * how Deribit liquidity changes by session.
 *
 * Each invocation:
 *   1. Runs probeChainSpreadDistribution (appends to history JSONL)
 *   2. Runs liquidStrikePicker (appends per-cell costs to history JSONL)
 *   3. Outputs a one-line summary suitable for log scraping
 *
 * Deployment:
 *   Add to Render as a cron job with schedule:
 *     "0 0,4,8,12,14,16,18,20 * * *"  ← every 4h with extra US-session probes
 *
 *   Or as a worker that sleeps + ticks (simpler to operate):
 *     export SPREAD_PROBE_INTERVAL_MIN=240
 *     npx tsx scripts/integration/scheduledSpreadProbe.ts
 *
 * Output JSONL:
 *   /tmp/spread_distribution_history.jsonl (from chain probe)
 *   /tmp/liquid_picker_history.jsonl (from this script)
 *
 * After ~24h of runs, run summarizeProbeHistory.ts to see time-of-day patterns.
 */

import * as fs from "node:fs/promises";
import { fetchFullChainSnapshot, pickLiquidStrike } from "../backtest/singleSide/liquidStrikePicker";
import { execSync } from "node:child_process";

const PROBE_CELLS = [
  { cellId: "pair_50k_2pct_itm", tenorDays: 3, putItmPct: 0.013, callItmPct: 0.013, contractsBtc: 1.4 },
  { cellId: "pair_25k_5pct_otm_3d", tenorDays: 3, putItmPct: -0.020, callItmPct: -0.025, contractsBtc: 0.5 },
  { cellId: "pair_25k_5pct_otm_short", tenorDays: 1, putItmPct: -0.020, callItmPct: -0.025, contractsBtc: 0.5 }
];

const probeOnce = async (): Promise<void> => {
  const startedAt = new Date();
  console.log(JSON.stringify({ ts: startedAt.toISOString(), msg: "probe_started", utcHour: startedAt.getUTCHours() }));

  try {
    // Run chain spread probe (uses existing script via execSync to avoid duplicating code)
    execSync(`npx tsx ${import.meta.dirname}/../backtest/singleSide/probeChainSpreadDistribution.ts`, {
      cwd: process.cwd(), stdio: "inherit", timeout: 60_000
    });
  } catch (e) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "chain_probe_failed", error: (e as Error).message }));
  }

  // Run liquid picker on Phase 0 + key cells, append to history
  try {
    const { spot, quotes } = await fetchFullChainSnapshot();
    const entries: Array<Record<string, unknown>> = [];
    for (const cell of PROBE_CELLS) {
      const putStrike = Math.ceil(spot * (1 + cell.putItmPct) / 1_000) * 1_000;
      const callStrike = Math.floor(spot * (1 - cell.callItmPct) / 1_000) * 1_000;
      const putPick = pickLiquidStrike(quotes, putStrike, cell.tenorDays, "put", spot);
      const callPick = pickLiquidStrike(quotes, callStrike, cell.tenorDays, "call", spot);
      const putAsk = (putPick.picked?.askUsdcPerBtc ?? 0) * cell.contractsBtc;
      const callAsk = (callPick.picked?.askUsdcPerBtc ?? 0) * cell.contractsBtc;
      entries.push({
        runAt: startedAt.toISOString(),
        utcHour: startedAt.getUTCHours(),
        spot,
        cellId: cell.cellId,
        putStrike,
        callStrike,
        pickedPutStrike: putPick.picked?.strike ?? null,
        pickedCallStrike: callPick.picked?.strike ?? null,
        pickedPutInstr: putPick.picked?.instrument_name ?? null,
        pickedCallInstr: callPick.picked?.instrument_name ?? null,
        putAskTotal: putAsk,
        callAskTotal: callAsk,
        hedgeCostTotal: putAsk + callAsk,
        putSpread: putPick.picked?.spreadPct ?? null,
        callSpread: callPick.picked?.spreadPct ?? null,
        putPickerType: putPick.picker,
        callPickerType: callPick.picker
      });
      console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "cell_probed", cellId: cell.cellId, hedgeCost: putAsk + callAsk }));
    }
    const histPath = "/tmp/liquid_picker_history.jsonl";
    for (const e of entries) await fs.appendFile(histPath, JSON.stringify(e) + "\n");
    console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "history_appended", path: histPath, count: entries.length }));
  } catch (e) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "liquid_probe_failed", error: (e as Error).message }));
  }
};

const main = async () => {
  const intervalMin = Number(process.env.SPREAD_PROBE_INTERVAL_MIN ?? "0");
  if (intervalMin === 0) {
    // One-shot mode (cron will invoke this)
    await probeOnce();
    return;
  }
  // Worker mode: loop forever
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "worker_starting", intervalMin }));
  await probeOnce();
  setInterval(() => { void probeOnce(); }, intervalMin * 60_000);
};

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
