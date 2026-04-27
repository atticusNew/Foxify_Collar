/**
 * Smoke test: verify the Deribit public-API client returns sane data and
 * can find a 30-DTE put spread bracketing a barrier.
 *
 * Run: npx tsx src/_smokeTestDeribit.ts
 */
import { fetchBtcChainSnapshot, findClosestExpiry, findVerticalSpread } from "./deribitClient.js";

async function main() {
  console.log("Fetching live Deribit BTC chain snapshot…");
  const chain = await fetchBtcChainSnapshot();
  if (!chain) { console.error("Failed to fetch."); process.exit(1); }
  console.log(`  underlying=$${chain.underlying.toFixed(0)}, ${chain.rows.length} contracts`);

  const expiry = findClosestExpiry(chain, 30, 8);
  console.log(`  Closest 30-DTE expiry with ≥8 strikes/side: ${expiry}`);
  if (!expiry) process.exit(1);

  // Try a put spread bracketing barrier = $80k (e.g. a Kalshi "BTC > $80k" YES bet)
  const putSpread = findVerticalSpread(chain, expiry, "P", 80_000);
  if (putSpread) {
    const longUsd = (putSpread.longRow.ask ?? 0) * (putSpread.longRow.underlying ?? chain.underlying);
    const shortUsd = (putSpread.shortRow.bid ?? 0) * (putSpread.shortRow.underlying ?? chain.underlying);
    console.log(`  Put spread (Kalshi-YES at K=$80k):`);
    console.log(`    Long  ${putSpread.K_long}P: ask=${putSpread.longRow.ask?.toFixed(4)} BTC ($${longUsd.toFixed(2)})`);
    console.log(`    Short ${putSpread.K_short}P: bid=${putSpread.shortRow.bid?.toFixed(4)} BTC ($${shortUsd.toFixed(2)})`);
    console.log(`    Net cost = $${(longUsd - shortUsd).toFixed(2)} per BTC notional`);
  } else {
    console.log("  No put spread found bracketing $80k.");
  }

  // Try a call spread bracketing barrier = $90k (e.g. a Kalshi "BTC < $90k" YES bet)
  const callSpread = findVerticalSpread(chain, expiry, "C", 90_000);
  if (callSpread) {
    const longUsd = (callSpread.longRow.ask ?? 0) * (callSpread.longRow.underlying ?? chain.underlying);
    const shortUsd = (callSpread.shortRow.bid ?? 0) * (callSpread.shortRow.underlying ?? chain.underlying);
    console.log(`  Call spread (Kalshi-NO at K=$90k):`);
    console.log(`    Long  ${callSpread.K_long}C: ask=${callSpread.longRow.ask?.toFixed(4)} BTC ($${longUsd.toFixed(2)})`);
    console.log(`    Short ${callSpread.K_short}C: bid=${callSpread.shortRow.bid?.toFixed(4)} BTC ($${shortUsd.toFixed(2)})`);
    console.log(`    Net cost = $${(longUsd - shortUsd).toFixed(2)} per BTC notional`);
  } else {
    console.log("  No call spread found bracketing $90k.");
  }
}
main();
