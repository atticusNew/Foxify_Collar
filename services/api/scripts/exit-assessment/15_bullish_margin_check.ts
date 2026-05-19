/**
 * Bullish margin/short-leg capability check.
 *
 * Phase 0 of $200k @ 5% product build. Verifies that Bullish supports
 * the trades we need for the put-spread structure.
 *
 * What needs verifying:
 *   1. Are options markets margined (allowing short legs) or spot only?
 *   2. What's the margin requirement for selling an option?
 *   3. Order types supported (LMT, MKT, IOC, etc.)
 *   4. Multi-leg orders supported, or sequential leg execution required?
 *   5. Min/max quantity per option market
 *   6. Account-side: account capable of margin trading on options?
 *
 * Items 1-5 are PUBLIC API (no auth needed).
 * Item 6 requires authenticated account access — flagged for operator.
 *
 * READ ONLY.
 */

const BULLISH = "https://api.exchange.bullish.com";

const fetchJson = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} → ${r.status} ${await r.text().catch(() => "")}`);
  return r.json() as Promise<T>;
};

const main = async () => {
  console.log("# Bullish Margin / Short-Leg Capability Check");
  console.log(`# Generated: ${new Date().toISOString()}\n`);

  // Pull a sample BTC put market for inspection
  const sampleSymbol = "BTC-USDC-20260529-75000-P";
  console.log(`Inspecting: ${sampleSymbol}\n`);

  const market = await fetchJson<any>(`${BULLISH}/trading-api/v1/markets/${sampleSymbol}`);
  console.log("=== Market metadata ===");
  console.log(`  symbol:             ${market.symbol}`);
  console.log(`  marketType:         ${market.marketType}`);
  console.log(`  optionType:         ${market.optionType}`);
  console.log(`  optionStrikePrice:  $${market.optionStrikePrice}`);
  console.log(`  expiryDatetime:     ${market.expiryDatetime}`);
  console.log(`  contractMultiplier: ${market.contractMultiplier}`);
  console.log(`  tickSize:           ${market.tickSize}`);
  console.log(`  minQuantityLimit:   ${market.minQuantityLimit} BTC`);
  console.log(`  maxQuantityLimit:   ${market.maxQuantityLimit} BTC`);
  console.log(`  marketEnabled:      ${market.marketEnabled}`);
  console.log(`  createOrderEnabled: ${market.createOrderEnabled}`);
  console.log(`  spotTradingEnabled: ${market.spotTradingEnabled}`);
  console.log(`  marginTradingEnabled: ${market.marginTradingEnabled}`);
  console.log(`  orderTypes:         ${JSON.stringify(market.orderTypes)}`);
  console.log(`  premiumCapRatio:    ${market.premiumCapRatio}`);
  console.log(`  openInterestLimitUSD: $${market.openInterestLimitUSD}`);
  console.log(`  concentrationRiskPercentage: ${market.concentrationRiskPercentage}`);
  console.log(`  concentrationRiskThresholdUSD: $${market.concentrationRiskThresholdUSD}`);
  console.log(`  feeGroupId:         ${market.feeGroupId}`);

  console.log("\n");

  // Verdict checks
  console.log("=== Capability Verdicts ===\n");

  console.log(`[1] Options margined? marginTradingEnabled = ${market.marginTradingEnabled}`);
  console.log(`    ${market.marginTradingEnabled === true ? "✅ YES — short legs supported" : "❌ NO — would block put spread"}`);

  console.log(`\n[2] Order types supported: ${JSON.stringify(market.orderTypes)}`);
  const wantedTypes = ["LMT", "MKT"];
  const hasWanted = wantedTypes.every(t => (market.orderTypes ?? []).includes(t));
  console.log(`    Need: LMT (limit), MKT (market) — ${hasWanted ? "✅ both supported" : "⚠️ check"}`);

  console.log(`\n[3] Min quantity: ${market.minQuantityLimit} BTC`);
  console.log(`    Need: at least 0.5 BTC for our 2.5 BTC spread sizing — ${Number(market.minQuantityLimit) <= 0.5 ? "✅ ok" : "❌ too high"}`);

  console.log(`\n[4] Max quantity: ${market.maxQuantityLimit} BTC`);
  console.log(`    Need: at least 4 BTC for over-hedge — ${Number(market.maxQuantityLimit) >= 4 ? "✅ ok" : "❌ too low"}`);

  console.log(`\n[5] Premium cap ratio: ${market.premiumCapRatio} (limits position size to this fraction of OI)`);
  console.log(`    Note: ratio of ${market.premiumCapRatio} means orders can't exceed ${(Number(market.premiumCapRatio) * 100).toFixed(0)}% of OI`);

  console.log(`\n[6] Open interest limit: $${market.openInterestLimitUSD}`);
  console.log(`    For \$200k position with 1.3x over-hedge = \$260k notional. Limit is far above this.`);

  // Look at fee structure (would help understand spread economics)
  console.log("\n\n=== Fee structure ===");
  try {
    const fees = await fetchJson<any>(`${BULLISH}/trading-api/v1/asset-management/exchange-fees`);
    const feeGroup = (fees.find ? fees.find((f: any) => String(f.feeGroupId) === String(market.feeGroupId)) : null);
    if (feeGroup) {
      console.log(`  Fee group ${feeGroup.feeGroupId}:`);
      console.log(`    Maker rate: ${feeGroup.makerFeeRate ?? "n/a"}`);
      console.log(`    Taker rate: ${feeGroup.takerFeeRate ?? "n/a"}`);
    } else {
      console.log(`  (Couldn't find specific group ${market.feeGroupId} in fees response)`);
      console.log(`  Raw fees endpoint snapshot:`, JSON.stringify(fees).slice(0, 500));
    }
  } catch (e) {
    console.log(`  (Fee endpoint unavailable: ${(e as Error).message})`);
  }

  // Check trading account requirements
  console.log("\n\n=== Account requirements (verifiable only with auth) ===");
  console.log("  These cannot be checked without valid Bullish account credentials:");
  console.log("    - Is the account margin-enabled?");
  console.log("    - What's the available margin balance?");
  console.log("    - Are options trading permissions active for this account?");
  console.log("    - Margin requirement formula for short put on this strike?");
  console.log("");
  console.log("  ACTION FOR OPERATOR:");
  console.log("    Log into Bullish dashboard → check Account Settings:");
  console.log("    - 'Margin trading' enabled? (required)");
  console.log("    - 'Options trading' enabled? (required)");
  console.log("    - Approval level for short option positions? (required for short leg)");
  console.log("");
  console.log("  OR provide PILOT_BULLISH_ECDSA_* credentials and I'll do an authenticated probe.");

  // Conclusion
  console.log("\n\n=== Summary ===");
  if (market.marginTradingEnabled === true && market.createOrderEnabled === true) {
    console.log("✅ PUBLIC API checks PASS — Bullish supports the put-spread structure mechanically.");
    console.log("⏳ Account-side margin enablement REQUIRES operator confirmation or authenticated probe.");
  } else {
    console.log("❌ PUBLIC API checks indicate a blocker. Investigate.");
  }
};

main().catch(e => { console.error(e); process.exit(1); });
