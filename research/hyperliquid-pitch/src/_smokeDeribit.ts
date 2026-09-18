/** Smoke test: confirm BTC + ETH live chains are accessible via public API. */
import { fetchChainSnapshot, findClosestExpiry, findVerticalSpread } from "./deribitClient.js";

async function main() {
  for (const asset of ["BTC", "ETH"] as const) {
    console.log(`Fetching ${asset} chain…`);
    const chain = await fetchChainSnapshot(asset);
    if (!chain) { console.error(`Failed: ${asset}`); continue; }
    console.log(`  ${asset} index: $${chain.underlying.toFixed(0)}, ${chain.rows.length} contracts`);
    const expiry = findClosestExpiry(chain, 7, 6);
    console.log(`  Closest 7-DTE: ${expiry}`);
    if (!expiry) continue;
    const target = chain.underlying * 0.98;
    const sp = findVerticalSpread(chain, expiry, "P", target, chain.underlying * 0.06);
    if (sp) {
      const longUsd = (sp.longRow.ask ?? 0) * (sp.longRow.underlying ?? chain.underlying);
      const shortUsd = (sp.shortRow.bid ?? 0) * (sp.shortRow.underlying ?? chain.underlying);
      console.log(`  Sample 2%-OTM 6%-wide put spread: ${sp.K_long}/${sp.K_short} → net $${(longUsd - shortUsd).toFixed(2)} per ${asset} of notional`);
    }
  }
}
main();
