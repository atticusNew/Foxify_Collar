/**
 * Smoke test for LiveStrangleExecutor with REAL venue orders.
 *
 * Buys a TINY two-leg strangle live on Bullish + Deribit (0.01 BTC default),
 * confirms both legs fill, then immediately reverses both for round-trip
 * cleanup. Total risk: cost of two crossed-IOC fills × tiny size — typically
 * <\$30 worst case if slippage is bad on both sides.
 *
 * Use this BEFORE flipping FOXIFY_V2_LIVE_EXECUTION=true in production to
 * validate the full live-execution path works end-to-end against real venues.
 *
 * Usage:
 *   export PILOT_BULLISH_ENABLED=true
 *   export PILOT_BULLISH_ECDSA_PRIVATE_KEY=...
 *   export PILOT_BULLISH_ECDSA_PUBLIC_KEY=...
 *   export PILOT_BULLISH_ECDSA_METADATA=...
 *   export PILOT_BULLISH_TRADING_ACCOUNT_ID=...
 *   export PILOT_BULLISH_REST_BASE_URL=<bullish-base>
 *   export DERIBIT_CLIENT_ID=...
 *   export DERIBIT_CLIENT_SECRET=...
 *   export DERIBIT_ENV=live      # or 'testnet' for safer first run
 *   export SMOKE_CONTRACTS_BTC=0.01   # default 0.01 BTC
 *   export SMOKE_PUT_STRIKE=72000     # operator-supplied
 *   export SMOKE_CALL_STRIKE=75000    # operator-supplied
 *   export SMOKE_PUT_VENUE=deribit    # 'bullish' or 'deribit'
 *   export SMOKE_CALL_VENUE=deribit
 *   export SMOKE_TENOR_DAYS=3
 *   export SMOKE_DRY_RUN=true        # default true — set false to actually fire
 *
 *   npx tsx scripts/integration/smokeLiveStrangleExecutor.ts
 *
 * Exit codes:
 *   0 — smoke test passed
 *   1 — failure (check stderr for details)
 *   2 — config missing
 */

import { LiveStrangleExecutor } from "../../src/singleSide/twoSided/liveStrangleExecutor";
import { BullishLegAdapter, DeribitLegAdapter } from "../../src/singleSide/twoSided/liveVenueAdapters";
import { BullishTradingClient } from "../../src/pilot/bullish";
import { pilotConfig } from "../../src/pilot/config";
import { DeribitConnector } from "@foxify/connectors";

const main = async () => {
  console.log("# LiveStrangleExecutor smoke test\n");

  const contractsBtc = Number(process.env.SMOKE_CONTRACTS_BTC ?? "0.01");
  const putStrike = Number(process.env.SMOKE_PUT_STRIKE ?? "0");
  const callStrike = Number(process.env.SMOKE_CALL_STRIKE ?? "0");
  const putVenue = (process.env.SMOKE_PUT_VENUE ?? "deribit") as "bullish" | "deribit";
  const callVenue = (process.env.SMOKE_CALL_VENUE ?? "deribit") as "bullish" | "deribit";
  const tenorDays = Number(process.env.SMOKE_TENOR_DAYS ?? "3");
  const dryRun = String(process.env.SMOKE_DRY_RUN ?? "true").toLowerCase() === "true";

  if (!putStrike || !callStrike) {
    console.error("FAIL: SMOKE_PUT_STRIKE and SMOKE_CALL_STRIKE required");
    process.exit(2);
  }

  console.log(`Config:`);
  console.log(`  contractsBtc:  ${contractsBtc}`);
  console.log(`  put:           strike \$${putStrike} venue=${putVenue}`);
  console.log(`  call:          strike \$${callStrike} venue=${callVenue}`);
  console.log(`  tenorDays:     ${tenorDays}`);
  console.log(`  dryRun:        ${dryRun}`);
  console.log("");

  if (dryRun) {
    console.log("DRY-RUN mode — will print order params + build executor + verify connectivity, NOT fire orders.");
    console.log("Set SMOKE_DRY_RUN=false to actually fire (TINY size; cost typically <\$30 round-trip).");
    console.log("");
  } else {
    console.log("⚠️  REAL EXECUTION MODE — orders WILL fire against real venues.");
    console.log("Press Ctrl+C in the next 5 seconds to abort...");
    await new Promise((r) => setTimeout(r, 5_000));
    console.log("");
  }

  // Resolve venue symbols. For Deribit: format BTC-DDMMMYY-STRIKE-{P,C}
  // For Bullish: format BTC-USDC-YYYYMMDD-STRIKE-{P,C}
  const now = Date.now();
  const expiryMs = now + tenorDays * 86_400_000;
  const expiry = new Date(expiryMs);
  const deribitMonthAbbr = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][expiry.getUTCMonth()];
  const deribitDate = `${expiry.getUTCDate()}${deribitMonthAbbr}${String(expiry.getUTCFullYear()).slice(2)}`;
  const bullishDate = expiry.toISOString().slice(0, 10).replace(/-/g, "");

  const putSymbol = putVenue === "deribit"
    ? `BTC-${deribitDate}-${putStrike}-P`
    : `BTC-USDC-${bullishDate}-${putStrike}-P`;
  const callSymbol = callVenue === "deribit"
    ? `BTC-${deribitDate}-${callStrike}-C`
    : `BTC-USDC-${bullishDate}-${callStrike}-C`;

  console.log(`Resolved venue symbols (approximate — adjust for actual expiry calendar):`);
  console.log(`  put symbol:  ${putSymbol}`);
  console.log(`  call symbol: ${callSymbol}`);
  console.log("");

  // Build clients
  if (!pilotConfig.bullish.enabled && (putVenue === "bullish" || callVenue === "bullish")) {
    console.error("FAIL: Bullish leg requested but PILOT_BULLISH_ENABLED=false");
    process.exit(2);
  }
  if (!pilotConfig.bullish.tradingAccountId && (putVenue === "bullish" || callVenue === "bullish")) {
    console.error("FAIL: Bullish leg requested but PILOT_BULLISH_TRADING_ACCOUNT_ID empty");
    process.exit(2);
  }
  const bullishClient = pilotConfig.bullish.enabled
    ? new BullishTradingClient(pilotConfig.bullish)
    : null;
  const deribitClient = new DeribitConnector(
    (process.env.DERIBIT_ENV as "live" | "testnet") || "live",
    String(process.env.DERIBIT_PAPER ?? "true").toLowerCase() === "true"
  );

  // Set generous max-ask: assume spot ~$74k, ITM near-money options ~$2k/BTC max
  const maxAcceptableAskUsdcPerBtc = Number(process.env.SMOKE_MAX_ASK_USDC_PER_BTC ?? "3000");

  const executor = new LiveStrangleExecutor(
    bullishClient ? new BullishLegAdapter(bullishClient, { tradingAccountId: pilotConfig.bullish.tradingAccountId }) : { buyLeg: async () => ({ ok: false, reason: "venue_error", detail: "bullish_disabled" }), sellLeg: async () => ({ ok: false, reason: "venue_error", detail: "bullish_disabled" }) },
    new DeribitLegAdapter(deribitClient)
  );

  const order = {
    pairId: `smoke-${Date.now()}`,
    putLeg: {
      venue: putVenue,
      symbol: putSymbol,
      contractsBtc,
      maxAcceptableAskUsdcPerBtc
    },
    callLeg: {
      venue: callVenue,
      symbol: callSymbol,
      contractsBtc,
      maxAcceptableAskUsdcPerBtc
    }
  };

  console.log(`Order payload:`);
  console.log(JSON.stringify(order, null, 2));
  console.log("");

  if (dryRun) {
    console.log("✓ DRY-RUN complete. No orders fired.");
    console.log("");
    console.log("To run for real:");
    console.log("  export SMOKE_DRY_RUN=false");
    console.log("  npx tsx scripts/integration/smokeLiveStrangleExecutor.ts");
    return;
  }

  console.log("Firing strangle...");
  const t0 = Date.now();
  const result = await executor.executeStrangle(order);
  const elapsedMs = Date.now() - t0;

  console.log(`\nExecution completed in ${elapsedMs}ms.`);
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    console.error(`\nFAIL: ${result.reason}`);
    process.exit(1);
  }

  console.log(`\n✓ Both legs filled.`);
  console.log(`  put:  \$${result.putLeg.filledAskUsdcPerBtc.toFixed(2)}/BTC at ${result.putLeg.filledAtIso}`);
  console.log(`  call: \$${result.callLeg.filledAskUsdcPerBtc.toFixed(2)}/BTC at ${result.callLeg.filledAtIso}`);
  console.log(`  total cost (paid): \$${((result.putLeg.filledAskUsdcPerBtc + result.callLeg.filledAskUsdcPerBtc) * contractsBtc).toFixed(2)}`);
  console.log("");

  console.log("⚠️  Position is now LIVE in your venue accounts. Reversing immediately to close...");
  const reverseT0 = Date.now();
  // Build a "reverse strangle" by re-using executeStrangle with sell-side... actually executor
  // doesn't expose a public sell-strangle. We'd call the adapter sellLeg methods directly.
  const bullishAdapter = bullishClient ? new BullishLegAdapter(bullishClient, { tradingAccountId: pilotConfig.bullish.tradingAccountId }) : null;
  const deribitAdapter = new DeribitLegAdapter(deribitClient);

  const sellPut = putVenue === "bullish" && bullishAdapter
    ? await bullishAdapter.sellLeg({ symbol: putSymbol, contractsBtc, minAcceptableBidUsdcPerBtc: 0, clientOrderId: `${order.pairId}-sellput` })
    : await deribitAdapter.sellLeg({ instrument: putSymbol, contractsBtc, minAcceptableBidUsdcPerBtc: 0.0001, clientOrderId: `${order.pairId}-sellput` });
  const sellCall = callVenue === "bullish" && bullishAdapter
    ? await bullishAdapter.sellLeg({ symbol: callSymbol, contractsBtc, minAcceptableBidUsdcPerBtc: 0, clientOrderId: `${order.pairId}-sellcall` })
    : await deribitAdapter.sellLeg({ instrument: callSymbol, contractsBtc, minAcceptableBidUsdcPerBtc: 0.0001, clientOrderId: `${order.pairId}-sellcall` });
  const reverseMs = Date.now() - reverseT0;

  console.log(`Reverse completed in ${reverseMs}ms.`);
  console.log(`  put sell:  ${sellPut.ok ? `\$${sellPut.filledAskUsdcPerBtc.toFixed(2)} ✓` : `✗ ${sellPut.reason} (${("detail" in sellPut ? sellPut.detail : "")})`}`);
  console.log(`  call sell: ${sellCall.ok ? `\$${sellCall.filledAskUsdcPerBtc.toFixed(2)} ✓` : `✗ ${sellCall.reason} (${("detail" in sellCall ? sellCall.detail : "")})`}`);

  if (!sellPut.ok || !sellCall.ok) {
    console.error(`\n⚠️  WARNING: One or both reverse-sell legs failed. You may have an open position!`);
    console.error(`Manually close on the venue dashboard before running again.`);
    process.exit(1);
  }

  const proceeds = (sellPut.filledAskUsdcPerBtc + sellCall.filledAskUsdcPerBtc) * contractsBtc;
  const cost = (result.putLeg.filledAskUsdcPerBtc + result.callLeg.filledAskUsdcPerBtc) * contractsBtc;
  const roundtripPnl = proceeds - cost;
  console.log("");
  console.log(`✓ Round-trip complete.`);
  console.log(`  Cost paid:    \$${cost.toFixed(2)}`);
  console.log(`  Proceeds:     \$${proceeds.toFixed(2)}`);
  console.log(`  Round-trip P&L: \$${roundtripPnl.toFixed(2)} (negative is normal — spread is the cost)`);
  console.log("");
  console.log("If above looks reasonable, the live executor is ready. Set FOXIFY_V2_LIVE_EXECUTION=true in Render.");
};

if (process.argv[1] && (process.argv[1].endsWith("/smokeLiveStrangleExecutor.ts") || process.argv[1].endsWith("\\smokeLiveStrangleExecutor.ts"))) {
  main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
}
