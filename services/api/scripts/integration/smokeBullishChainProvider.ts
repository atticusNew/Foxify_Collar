/**
 * End-to-end smoke test for the Bullish chain provider.
 *
 * Constructs a REAL BullishTradingClient with creds from env, fetches markets +
 * orderbooks, prints the resulting venue-tagged quotes.
 *
 * Use this BEFORE enabling Bullish in the LiquidChainCache to verify creds
 * work and the provider returns sane data.
 *
 * Usage:
 *   export PILOT_BULLISH_ECDSA_PRIVATE_KEY=...   # (or HMAC vars)
 *   export PILOT_BULLISH_ECDSA_PUBLIC_KEY=...
 *   export PILOT_BULLISH_ECDSA_METADATA=...
 *   export PILOT_BULLISH_TRADING_ACCOUNT_ID=...
 *   export PILOT_BULLISH_REST_BASE_URL=https://api.simnext.bullish-test.com
 *   npx tsx scripts/integration/smokeBullishChainProvider.ts
 *
 * Exit codes:
 *   0  success (chain pull worked, at least 1 quote returned)
 *   1  fatal error (creds missing, API unreachable, no quotes)
 */

import { BullishTradingClient } from "../../src/pilot/bullish";
import { fetchBullishChainSnapshot } from "../../src/singleSide/twoSided/bullishChainProvider";
import { pilotConfig } from "../../src/pilot/config";
import { fetchFullChainSnapshot } from "../backtest/singleSide/liquidStrikePicker";

const main = async () => {
  console.log("# Bullish chain provider smoke test\n");

  const cfg = pilotConfig.bullish;
  if (!cfg.enabled) {
    console.error("FAIL: PILOT_BULLISH_ENABLED is false. Set to true and provide creds.");
    process.exit(1);
  }
  console.log(`Config:`);
  console.log(`  restBaseUrl: ${cfg.restBaseUrl}`);
  console.log(`  authMode:    ${cfg.authMode}`);
  console.log(`  tradingAccountId: ${cfg.tradingAccountId ? "(set)" : "(missing)"}`);
  console.log(`  ECDSA private key: ${cfg.ecdsaPrivateKey ? "(set)" : "(missing)"}`);
  console.log("");

  // 1. Use Deribit to anchor the strike + tenor window (we don't yet know spot from Bullish alone)
  console.log("Fetching Deribit spot for window anchor...");
  let centerSpot: number;
  try {
    const d = await fetchFullChainSnapshot();
    centerSpot = d.spot;
    console.log(`  Deribit index price: \$${centerSpot.toFixed(0)}\n`);
  } catch (e) {
    console.error(`FAIL: Deribit index fetch failed: ${(e as Error).message}`);
    process.exit(1);
  }

  const client = new BullishTradingClient(cfg);

  // 2. List markets first (auth smoke check)
  console.log("Fetching Bullish markets list (auth smoke check)...");
  let marketsCount: number;
  try {
    const markets = await client.getMarkets({ cacheTtlMs: 0 });
    marketsCount = markets.length;
    const btcOpts = markets.filter((m) => (m.underlyingBaseSymbol ?? "").toUpperCase() === "BTC" && (m.optionType ?? "").toUpperCase() === "PUT" || (m.optionType ?? "").toUpperCase() === "CALL").length;
    console.log(`  ${marketsCount} markets total, ${btcOpts} BTC options\n`);
  } catch (e) {
    console.error(`FAIL: Bullish getMarkets failed: ${(e as Error).message}`);
    console.error("  Likely cause: bad creds, wrong restBaseUrl, or upstream rate limit.");
    process.exit(1);
  }

  // 3. Run the provider for the expected production windows
  for (const cellTenor of [1, 2, 3]) {
    console.log(`Fetching Bullish chain snapshot (tenor=${cellTenor}d, strike±\$6k from \$${centerSpot.toFixed(0)})...`);
    const start = Date.now();
    try {
      const snap = await fetchBullishChainSnapshot(client, centerSpot, {
        centerSpot,
        centerTenorDays: cellTenor,
        strikeWindowUsdc: 6_000,
        tenorWindowDays: 1,
        maxConcurrency: 4,
        timeoutMs: 4_000
      });
      const elapsed = Date.now() - start;
      console.log(`  Got ${snap.quotes.length} quotes in ${elapsed}ms`);
      if (snap.quotes.length === 0) {
        console.log(`  ⚠ No quotes returned — check market filters or window`);
        continue;
      }
      // Show top 5 by ask
      const sorted = [...snap.quotes].sort((a, b) => a.askUsdcPerBtc - b.askUsdcPerBtc).slice(0, 5);
      console.log(`  Top 5 by ask:`);
      for (const q of sorted) {
        console.log(`    ${q.instrument_name.padEnd(40)} K=${q.strike} ${q.optType.padEnd(4)} bid=\$${q.bidUsdcPerBtc.toFixed(0)} ask=\$${q.askUsdcPerBtc.toFixed(0)} spread=${(q.spreadPct * 100).toFixed(1)}% tenor=${q.tenorHours.toFixed(1)}h`);
      }
      console.log("");
    } catch (e) {
      console.error(`  FAIL: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  console.log("✓ Bullish chain provider smoke test PASSED");
  console.log("");
  console.log("Next step: wire LiquidChainCache with this provider in server.ts");
  console.log("(see docs/SCHEDULED_PROBE_DEPLOY.md for the snippet)");
};

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
}
