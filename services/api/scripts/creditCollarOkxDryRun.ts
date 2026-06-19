#!/usr/bin/env tsx
/**
 * OKX collar-hedge DRY RUN — validates real execution of the two hedge legs (buy put + sell call),
 * fills, slippage vs modeled, the orphan-leg compensation, and the real short-leg margin.
 *
 * SAFETY: defaults to OKX DEMO (x-simulated-trading). Real money requires BOTH
 *   OKX_EXECUTION_MODE=live  AND  OKX_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY
 * and even then it uses a tiny size. Start on demo.
 *
 *   OKX_API_KEY=... OKX_API_SECRET=... OKX_API_PASSPHRASE=... \
 *   OKX_EXECUTION_MODE=demo OKX_SIZE_CONTRACTS=1 \
 *   npm --silent --workspace services/api run okx:dry-run | jq .
 */

import { OkxExecutionClient, type OkxMode } from "../src/singleSide/twoSided/creditCollar/execution/okxExecutionClient";
import { executeCollarHedge, type CollarHedgeSpec } from "../src/singleSide/twoSided/creditCollar/execution/okxCollarExecutor";
import { okxProbe } from "../src/singleSide/twoSided/okxProbe";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

const main = async () => {
  const apiKey = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  if (!apiKey || !secret || !passphrase) {
    console.error("[okx-dry-run] missing OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE — set DEMO keys.");
    process.exit(2);
  }
  const requested = (process.env.OKX_EXECUTION_MODE ?? "demo").toLowerCase();
  let mode: OkxMode = "demo";
  if (requested === "live") {
    if (process.env.OKX_LIVE_CONFIRM !== "I_UNDERSTAND_REAL_MONEY") {
      console.error("[okx-dry-run] LIVE refused: set OKX_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY to use real money. Staying off.");
      process.exit(3);
    }
    mode = "live";
    console.error("[okx-dry-run] ⚠️ LIVE (real money) mode — tiny size only.");
  } else {
    console.error("[okx-dry-run] DEMO mode (x-simulated-trading). Zero capital.");
  }

  const spot = num(process.env.OKX_DRYRUN_SPOT, 0) || (await (async () => {
    const r = (await (await fetch("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT")).json()) as { data?: Array<{ last?: string }> };
    return Number(r.data?.[0]?.last ?? 0);
  })());
  if (!(spot > 0)) {
    console.error("[okx-dry-run] could not get spot");
    process.exit(4);
  }

  const floorPct = num(process.env.OKX_DRYRUN_FLOOR_PCT, 0.05);
  const capPct = num(process.env.OKX_DRYRUN_CAP_PCT, 0.02);
  const tenorDays = num(process.env.OKX_DRYRUN_TENOR_DAYS, 1);
  const sizeContracts = process.env.OKX_SIZE_CONTRACTS ?? "1";

  // Discover real OKX option instIds + native (BTC) quotes near the wing strikes.
  const probe = await okxProbe({ spot, putStrike: spot * (1 - floorPct), callStrike: spot * (1 + capPct), tenorDays });
  if (!probe.ok) {
    console.error(`[okx-dry-run] okx probe failed: ${probe.error}`);
    process.exit(5);
  }
  const put = probe.legs.find((l) => l.opt_type === "put");
  const call = probe.legs.find((l) => l.opt_type === "call");
  if (!put?.instId || !call?.instId || put.ask_btc == null || call.bid_btc == null) {
    console.error("[okx-dry-run] could not resolve put/call legs with quotes", JSON.stringify(probe.legs));
    process.exit(6);
  }

  // px + modeled in OKX NATIVE units (BTC per contract); slippage report is therefore in BTC.
  const spec: CollarHedgeSpec = {
    putInstId: put.instId,
    callInstId: call.instId,
    sizeContracts,
    putLimitPx: String(put.ask_btc),       // marketable buy
    callLimitPx: String(call.bid_btc),     // marketable sell
    modeledPutAskUsd: put.ask_btc,         // native BTC units (report slippage in BTC)
    modeledCallBidUsd: call.bid_btc,
    tdMode: (process.env.OKX_TD_MODE as "cross" | "isolated" | "cash") ?? "cross",
    clOrdPrefix: `cc${Date.now()}`
  };

  console.error(`[okx-dry-run] spot=${spot} put=${put.instId}@${put.ask_btc}BTC call=${call.instId}@${call.bid_btc}BTC size=${sizeContracts} mode=${mode}`);
  const client = new OkxExecutionClient({ apiKey, secret, passphrase, mode });
  const report = await executeCollarHedge(client, spec, { pollTries: num(process.env.OKX_POLL_TRIES, 6), pollDelayMs: num(process.env.OKX_POLL_DELAY_MS, 700) });

  process.stdout.write(JSON.stringify({ mode, spot, spec, report, units: "px + slippage in BTC per contract (OKX native); margin in account ccy" }, null, 2) + "\n");
  console.error(`[okx-dry-run] outcome=${report.outcome} safe=${report.safe} compensated=${report.compensated} shortLegMargin=${report.shortLegMarginUsd} errors=${report.errors.length}`);
  if (!report.safe) process.exit(7); // naked-leg alarm
};

main().catch((e) => {
  console.error("[okx-dry-run] fatal:", e);
  process.exit(1);
});
