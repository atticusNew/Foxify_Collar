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
import { resolveCollarLegs, isOptionsNotActivatedMsg } from "../src/singleSide/twoSided/creditCollar/execution/okxLegResolver";

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

  const floorPct = num(process.env.OKX_DRYRUN_FLOOR_PCT, 0.03);
  const capPct = num(process.env.OKX_DRYRUN_CAP_PCT, 0.01);
  const tenorDays = num(process.env.OKX_DRYRUN_TENOR_DAYS, 1);
  const sizeContracts = process.env.OKX_SIZE_CONTRACTS ?? "1";

  const client = new OkxExecutionClient({ apiKey, secret, passphrase, mode });

  // Auth preflight — isolate credential problems before any instrument/order work.
  const auth = await client.authCheck();
  if (!auth.ok) {
    console.error(`[okx-dry-run] AUTH FAILED: ${auth.message}`);
    console.error("  Check: (1) key created in OKX DEMO trading (x-simulated-trading needs DEMO keys),");
    console.error("         (2) OK-ACCESS-PASSPHRASE = the API key's passphrase (NOT your login password),");
    console.error("         (3) env quoted, no trailing newline:  printf '%s' \"$OKX_API_PASSPHRASE\" | wc -c");
    console.error("  Tip: run `npm --silent --workspace services/api run okx:auth-probe` to test demo vs live.");
    process.exit(8);
  }
  console.error("[okx-dry-run] auth ok ✓");

  // Activate options trading via API (idempotent) so we don't trip 51198 "…activate trading".
  // This is the API equivalent of clicking the options chain; runs from the whitelisted IP.
  if (process.env.OKX_SKIP_ACTIVATE !== "1") {
    const act = await client.activateOption();
    if (act.ok || act.code === "51199") {
      console.error("[okx-dry-run] options trading active ✓");
    } else {
      console.error(`[okx-dry-run] activate-option returned ${act.code}: ${act.msg} (continuing; set OKX_SKIP_ACTIVATE=1 to skip)`);
    }
  }

  // Discover OKX option instIds + native (BTC) quotes FROM THE ACTIVE ENVIRONMENT (demo and live list
  // different strikes/expiries) so we never submit an instId that doesn't exist in this keystore.
  const resolved = await resolveCollarLegs(
    (instType, uly) => client.getInstruments(instType, uly),
    (instId) => client.getBookTop(instId),
    { nowMs: Date.now(), tenorDays, putTarget: spot * (1 - floorPct), callTarget: spot * (1 + capPct) }
  );
  if (!resolved.ok || !resolved.legs) {
    console.error(`[okx-dry-run] leg resolution failed in ${mode} env: ${resolved.error}`);
    if (resolved.error === "no_matching_instruments_in_env") {
      console.error("  The active environment lists no BTC-USD options near the target tenor/strikes.");
      console.error("  In DEMO this is common — try OKX_DRYRUN_TENOR_DAYS to match a listed demo expiry.");
    }
    process.exit(5);
  }
  const { putInstId, callInstId, putAskBtc, callBidBtc } = resolved.legs;
  // Fall back to a nominal premium if the demo book is empty so we can still test order mechanics.
  const putAsk = putAskBtc ?? num(process.env.OKX_DRYRUN_PUT_PX_BTC, 0.001);
  const callBid = callBidBtc ?? num(process.env.OKX_DRYRUN_CALL_PX_BTC, 0.001);

  // Marketable buffer to actually cross the (wide) option book in demo. Limit px is buffered; the
  // MODELED px stays the true ask/bid so slippage is measured against the real quote.
  const buffer = num(process.env.OKX_MARKETABLE_BUFFER_PCT, 0.5);
  const spec: CollarHedgeSpec = {
    putInstId,
    callInstId,
    sizeContracts,
    putLimitPx: String(+(putAsk * (1 + buffer)).toFixed(6)),                  // cross up to buy
    callLimitPx: String(Math.max(0.0001, +(callBid * (1 - buffer)).toFixed(6))), // cross down to sell
    modeledPutAskUsd: putAsk,         // native BTC units (report slippage in BTC)
    modeledCallBidUsd: callBid,
    tdMode: (process.env.OKX_TD_MODE as "cross" | "isolated" | "cash") ?? "cross",
    clOrdPrefix: `cc${Date.now()}`
  };

  console.error(`[okx-dry-run] spot=${spot} put=${putInstId}@${putAsk}BTC call=${callInstId}@${callBid}BTC size=${sizeContracts} mode=${mode} expiry=${resolved.legs.expiryIso}`);
  const report = await executeCollarHedge(client, spec, { pollTries: num(process.env.OKX_POLL_TRIES, 6), pollDelayMs: num(process.env.OKX_POLL_DELAY_MS, 700) });

  process.stdout.write(JSON.stringify({ mode, spot, spec, report, units: "px + slippage in BTC per contract (OKX native); margin in account ccy" }, null, 2) + "\n");
  console.error(`[okx-dry-run] outcome=${report.outcome} safe=${report.safe} compensated=${report.compensated} shortLegMargin=${report.shortLegMarginUsd} errors=${report.errors.length}`);

  // Surface the account-activation case clearly — orders are rejected until options trading is enabled.
  if (isOptionsNotActivatedMsg(report.putFill.state) || isOptionsNotActivatedMsg(report.callFill.state)) {
    console.error("[okx-dry-run] ⚠️ OPTIONS TRADING NOT ACTIVATED on this account.");
    console.error("  OKX requires a one-time activation before option orders are accepted:");
    console.error("  In the OKX app/site (Demo Trading mode) open Trade → Options, click any contract,");
    console.error("  and complete the 'Activate' prompt. Then re-run this dry-run.");
    process.exit(9);
  }
  if (!report.safe) process.exit(7); // naked-leg alarm
};

main().catch((e) => {
  console.error("[okx-dry-run] fatal:", e);
  process.exit(1);
});
