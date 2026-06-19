#!/usr/bin/env tsx
/**
 * Deribit collar-hedge DRY RUN — validates real execution of the two hedge legs (buy put + sell call)
 * on Deribit TESTNET (test.deribit.com): fills, slippage vs modeled, orphan-leg compensation, and the
 * real short-leg margin. No KYC, no activation gating, datacenter-IP friendly — the path that works
 * when OKX demo activation is blocked.
 *
 * SAFETY: defaults to TESTNET. Real money requires BOTH
 *   DERIBIT_EXECUTION_MODE=live  AND  DERIBIT_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY
 *
 *   DERIBIT_CLIENT_ID=... DERIBIT_CLIENT_SECRET=... \
 *   DERIBIT_EXECUTION_MODE=testnet DERIBIT_SIZE=0.1 \
 *   npm --silent --workspace services/api run deribit:dry-run | jq .
 *
 * Get testnet keys (no KYC): register at https://test.deribit.com → Account → API → add key.
 */

import { DeribitExecutionClient, type DeribitMode } from "../src/singleSide/twoSided/creditCollar/execution/deribitExecutionClient";
import { resolveDeribitCollarLegs } from "../src/singleSide/twoSided/creditCollar/execution/deribitLegResolver";
import { executeCollarHedge, type CollarHedgeSpec } from "../src/singleSide/twoSided/creditCollar/execution/okxCollarExecutor";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

const main = async () => {
  const clientId = process.env.DERIBIT_CLIENT_ID;
  const clientSecret = process.env.DERIBIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("[deribit-dry-run] missing DERIBIT_CLIENT_ID / DERIBIT_CLIENT_SECRET — create testnet keys at https://test.deribit.com");
    process.exit(2);
  }
  const requested = (process.env.DERIBIT_EXECUTION_MODE ?? "testnet").toLowerCase();
  let mode: DeribitMode = "testnet";
  if (requested === "live") {
    if (process.env.DERIBIT_LIVE_CONFIRM !== "I_UNDERSTAND_REAL_MONEY") {
      console.error("[deribit-dry-run] LIVE refused: set DERIBIT_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY to use real money. Staying off.");
      process.exit(3);
    }
    mode = "live";
    console.error("[deribit-dry-run] ⚠️ LIVE (real money) mode — tiny size only.");
  } else {
    console.error("[deribit-dry-run] TESTNET mode (test.deribit.com). Zero capital.");
  }

  const client = new DeribitExecutionClient({ clientId, clientSecret, mode });

  const auth = await client.authCheck();
  if (!auth.ok) {
    console.error(`[deribit-dry-run] AUTH FAILED: ${auth.message}`);
    console.error("  Check: keys created at the matching site (testnet keys → test.deribit.com), client_id/secret correct,");
    console.error("         and the API key has trade scope enabled.");
    process.exit(8);
  }
  console.error("[deribit-dry-run] auth ok ✓");

  // Spot from Deribit index.
  const idx = await client.getOrderBook("BTC-PERPETUAL").catch(() => null);
  const spot = num(process.env.DERIBIT_DRYRUN_SPOT, 0) || (idx?.result?.best_ask_price != null && idx.result.best_bid_price != null ? (Number(idx.result.best_ask_price) + Number(idx.result.best_bid_price)) / 2 : 0);
  if (!(spot > 0)) {
    console.error("[deribit-dry-run] could not get spot");
    process.exit(4);
  }

  const floorPct = num(process.env.DERIBIT_DRYRUN_FLOOR_PCT, 0.05);
  const capPct = num(process.env.DERIBIT_DRYRUN_CAP_PCT, 0.05);
  const tenorDays = num(process.env.DERIBIT_DRYRUN_TENOR_DAYS, 2);
  const size = process.env.DERIBIT_SIZE ?? "0.1"; // Deribit BTC option min is 0.1 contracts

  const resolved = await resolveDeribitCollarLegs(
    (currency, kind) => client.getInstruments(currency, kind),
    (name) => client.getOrderBook(name),
    { nowMs: Date.now(), tenorDays, putTarget: spot * (1 - floorPct), callTarget: spot * (1 + capPct) }
  );
  if (!resolved.ok || !resolved.legs) {
    console.error(`[deribit-dry-run] leg resolution failed: ${resolved.error}`);
    process.exit(5);
  }
  const { putInstrument, callInstrument, putAskBtc, callBidBtc } = resolved.legs;
  const putAsk = putAskBtc ?? num(process.env.DERIBIT_DRYRUN_PUT_PX_BTC, 0.001);
  const callBid = callBidBtc ?? num(process.env.DERIBIT_DRYRUN_CALL_PX_BTC, 0.001);

  // Marketable buffer to cross the book in testnet; modeled px stays the true quote for slippage.
  const buffer = num(process.env.DERIBIT_MARKETABLE_BUFFER_PCT, 0.5);
  // Deribit option ticks are 0.0001 BTC — round to tick.
  const tick = (x: number) => Math.max(0.0001, Math.round(x / 0.0001) * 0.0001);
  const spec: CollarHedgeSpec = {
    putInstId: putInstrument,
    callInstId: callInstrument,
    sizeContracts: size,
    putLimitPx: String(+tick(putAsk * (1 + buffer)).toFixed(4)),
    callLimitPx: String(+tick(Math.max(0.0001, callBid * (1 - buffer))).toFixed(4)),
    modeledPutAskUsd: putAsk,
    modeledCallBidUsd: callBid,
    clOrdPrefix: `cc${Date.now()}`
  };

  console.error(`[deribit-dry-run] spot=${spot} put=${putInstrument}@${putAsk}BTC call=${callInstrument}@${callBid}BTC size=${size} mode=${mode} expiry=${resolved.legs.expiryIso}`);
  const report = await executeCollarHedge(client.asExecClient(), spec, { pollTries: num(process.env.DERIBIT_POLL_TRIES, 6), pollDelayMs: num(process.env.DERIBIT_POLL_DELAY_MS, 700) });

  process.stdout.write(JSON.stringify({ venue: "deribit", mode, spot, spec, report, units: "px + slippage in BTC per contract; margin in BTC" }, null, 2) + "\n");
  console.error(`[deribit-dry-run] outcome=${report.outcome} safe=${report.safe} compensated=${report.compensated} shortLegMargin=${report.shortLegMarginUsd} errors=${report.errors.length}`);
  if (!report.safe) process.exit(7); // naked-leg alarm
};

main().catch((e) => {
  console.error("[deribit-dry-run] fatal:", e);
  process.exit(1);
});
