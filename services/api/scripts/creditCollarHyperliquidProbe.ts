/**
 * Hyperliquid probe — read-only by default; optional testnet order smoke.
 *
 *   npx tsx scripts/creditCollarHyperliquidProbe.ts
 *     → public data only: BTC mid, asset meta, funding, and (with HL_PRIVATE_KEY) the agent address
 *       + current position. NO orders.
 *
 *   HL_ENV=testnet HL_PRIVATE_KEY=0x... HL_PROBE_ORDER=true npx tsx scripts/creditCollarHyperliquidProbe.ts
 *     → additionally places a tiny far-from-mid ALO order on TESTNET and cancels it — proves the
 *       signing path end to end without risking a fill. Refuses to place orders on mainnet.
 */

import { HyperliquidClient, HL_MAINNET_BASE, HL_TESTNET_BASE, roundPx, roundSz } from "../src/singleSide/twoSided/creditCollar/execution/perpVenues/hyperliquidClient";

const env = String(process.env.HL_ENV ?? "mainnet").toLowerCase();
const isTestnet = env === "testnet";
const key = process.env.HL_PRIVATE_KEY;
const wantOrder = String(process.env.HL_PROBE_ORDER ?? "").toLowerCase() === "true";
const coin = process.env.HL_COIN ?? "BTC";

const main = async () => {
  const client = new HyperliquidClient({
    baseUrl: isTestnet ? HL_TESTNET_BASE : HL_MAINNET_BASE,
    privateKeyHex: key,
    masterAddress: process.env.HL_MASTER_ADDRESS || undefined,
    isMainnet: !isTestnet
  });
  console.log(`[hl-probe] env=${env} base=${isTestnet ? HL_TESTNET_BASE : HL_MAINNET_BASE}`);

  const meta = await client.assetMeta(coin);
  const mid = await client.midPx(coin);
  const funding = await client.fundingBpsPer8h(coin);
  console.log(`[hl-probe] ${coin}: assetIndex=${meta.assetIndex} szDecimals=${meta.szDecimals} maxLev=${meta.maxLeverage}`);
  console.log(`[hl-probe] mid=$${mid} funding=${funding} bps/8h`);
  console.log(`[hl-probe] example rounding @ $50k notional: px=${roundPx(mid, meta.szDecimals)} sz=${roundSz(50_000 / mid, meta.szDecimals)}`);

  if (!key) {
    console.log("[hl-probe] no HL_PRIVATE_KEY — read-only probe complete.");
    return;
  }
  console.log(`[hl-probe] signing (agent) address: ${client.address()}`);
  console.log(`[hl-probe] account address (positions): ${client.accountAddress()}${process.env.HL_MASTER_ADDRESS ? " (from HL_MASTER_ADDRESS)" : " (key's own — set HL_MASTER_ADDRESS if using an API/agent wallet)"}`);
  const pos = await client.positionSz(client.accountAddress(), coin);
  console.log(`[hl-probe] current ${coin} position: ${pos}`);

  if (!wantOrder) {
    console.log("[hl-probe] HL_PROBE_ORDER not set — skipping order smoke.");
    return;
  }
  if (!isTestnet) {
    console.error("[hl-probe] REFUSING to place probe orders on mainnet. Set HL_ENV=testnet.");
    process.exit(1);
  }
  // Far-below-mid ALO buy: post-only, cannot cross, canceled immediately after.
  const px = roundPx(mid * 0.5, meta.szDecimals);
  const sz = roundSz(Math.max(11 / mid, 10 ** -meta.szDecimals), meta.szDecimals); // ≥ $10 min order value
  console.log(`[hl-probe] placing TESTNET ALO buy ${sz} ${coin} @ $${px} (far from mid — should rest)...`);
  const placed = await client.placeOrder({ assetIndex: meta.assetIndex, isBuy: true, pxStr: px, szStr: sz, reduceOnly: false, tif: "Alo" });
  console.log(`[hl-probe] result: ${JSON.stringify(placed)}`);
  if (placed.kind === "resting") {
    const ok = await client.cancelOrder(meta.assetIndex, placed.oid);
    console.log(`[hl-probe] cancel oid=${placed.oid}: ${ok ? "ok" : "FAILED"}`);
  }
  console.log("[hl-probe] signing path validated end to end.");
};

main().catch((e) => {
  console.error(`[hl-probe] FAILED: ${(e as Error).message}`);
  process.exit(1);
});
