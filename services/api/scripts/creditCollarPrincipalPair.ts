/**
 * Principal-pair CLI — opens/closes Atticus's own cross-venue delta-neutral pairs.
 *
 * DRY-RUN IS THE DEFAULT: both legs paper, fills simulated at the live Hyperliquid mid.
 *
 *   npx tsx scripts/creditCollarPrincipalPair.ts                     → open one paper pair (if due)
 *   PRINCIPAL_CLOSE=pp-... npx tsx scripts/...                       → close that pair
 *   PRINCIPAL_LIST=true npx tsx scripts/...                          → list the ledger
 *
 * Going hybrid/live (EXPLICIT, never default):
 *   PRINCIPAL_LONG_VENUE=hyperliquid HL_PRIVATE_KEY=0x... [HL_ENV=testnet]
 *     → real long leg on Hyperliquid, paper short (labeled "paper" in every record) until a second
 *       real adapter lands. PRINCIPAL_SHORT_VENUE=hyperliquid is REFUSED by the runner (self-match).
 *
 * Env: PRINCIPAL_COIN (BTC) · PRINCIPAL_NOTIONAL (1000) · PRINCIPAL_PAIRS_PER_DAY (1)
 *      PRINCIPAL_SLIPPAGE (0.005) · PRINCIPAL_PAIRS_PATH (./logs/principal-pairs.jsonl)
 */

import { HyperliquidClient, HL_MAINNET_BASE, HL_TESTNET_BASE } from "../src/singleSide/twoSided/creditCollar/execution/perpVenues/hyperliquidClient";
import { HyperliquidPerpExecutor } from "../src/singleSide/twoSided/creditCollar/execution/perpVenues/hyperliquidPerpExecutor";
import { PaperPerpExecutor } from "../src/singleSide/twoSided/creditCollar/execution/perpVenues/paperPerpExecutor";
import type { PerpLegExecutor } from "../src/singleSide/twoSided/creditCollar/execution/perpVenues/perpLegExecutor";
import { runPrincipalPairCycle, closePrincipalPair, loadPrincipalPairs } from "../src/singleSide/twoSided/creditCollar/execution/principalPairRunner";

const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && v !== undefined && v !== "" ? Number(v) : d);

const coin = process.env.PRINCIPAL_COIN ?? "BTC";
const notional = num(process.env.PRINCIPAL_NOTIONAL, 1_000);
const isTestnet = String(process.env.HL_ENV ?? "").toLowerCase() === "testnet";

const hlClient = new HyperliquidClient({
  baseUrl: isTestnet ? HL_TESTNET_BASE : HL_MAINNET_BASE,
  privateKeyHex: process.env.HL_PRIVATE_KEY,
  masterAddress: process.env.HL_MASTER_ADDRESS || undefined, // required for position queries under API/agent wallets
  isMainnet: !isTestnet
});
const liveMid = (c: string) => hlClient.midPx(c); // paper legs fill at the LIVE mid

const buildVenue = (name: string | undefined, fallback: string): PerpLegExecutor => {
  const v = (name ?? fallback).toLowerCase();
  if (v === "hyperliquid") {
    if (!process.env.HL_PRIVATE_KEY) throw new Error("PRINCIPAL_*_VENUE=hyperliquid requires HL_PRIVATE_KEY");
    return new HyperliquidPerpExecutor(hlClient);
  }
  if (v === "paper" || v === "paper2") return new PaperPerpExecutor(liveMid, { venueName: v });
  throw new Error(`unknown venue '${v}' (hyperliquid | paper | paper2)`);
};

const main = async () => {
  const venueLong = buildVenue(process.env.PRINCIPAL_LONG_VENUE, "paper");
  const venueShort = buildVenue(process.env.PRINCIPAL_SHORT_VENUE, "paper2");
  const dryRun = venueLong.venue.startsWith("paper") && venueShort.venue.startsWith("paper");
  console.log(`[principal] coin=${coin} notional=$${notional}/leg long=${venueLong.venue} short=${venueShort.venue} ${dryRun ? "(DRY RUN)" : "(REAL LEG(S) — check config)"}`);

  if (String(process.env.PRINCIPAL_LIST ?? "").toLowerCase() === "true") {
    for (const r of loadPrincipalPairs(process.env.PRINCIPAL_PAIRS_PATH)) {
      console.log(`  ${r.ref} ${r.status} ${r.coin} $${r.notionalUsdcPerLeg}/leg long=${r.long?.venue ?? "-"} short=${r.short?.venue ?? "-"} ${r.abortReason ?? ""}`);
    }
    return;
  }

  const closeRef = process.env.PRINCIPAL_CLOSE;
  if (closeRef) {
    const rec = await closePrincipalPair(closeRef, venueLong, venueShort, { coin, slippagePct: num(process.env.PRINCIPAL_SLIPPAGE, 0.005), pairsPath: process.env.PRINCIPAL_PAIRS_PATH });
    console.log(rec ? `[principal] ${rec.ref} → ${rec.status}${rec.abortReason ? ` (${rec.abortReason})` : ""}` : `[principal] no record ${closeRef}`);
    return;
  }

  const res = await runPrincipalPairCycle(venueLong, venueShort, {
    coin,
    notionalUsdcPerLeg: notional,
    slippagePct: num(process.env.PRINCIPAL_SLIPPAGE, 0.005),
    pairsPerDayUtc: num(process.env.PRINCIPAL_PAIRS_PER_DAY, 1),
    dryRun,
    pairsPath: process.env.PRINCIPAL_PAIRS_PATH
  });
  if (res.action === "skipped") {
    console.log(`[principal] skipped: ${res.reason}`);
  } else {
    const r = res.record;
    console.log(`[principal] ${res.action.toUpperCase()} ${r.ref}`);
    if (r.long) console.log(`  long : ${r.long.venue} ${r.long.sz} ${coin} @ $${r.long.avgPx}`);
    if (r.short) console.log(`  short: ${r.short.venue} ${r.short.sz} ${coin} @ $${r.short.avgPx}`);
    for (const n of r.notes) console.log(`  note : ${n}`);
    if (r.abortReason) console.log(`  abort: ${r.abortReason}`);
    if (res.action === "critical_naked_leg") process.exit(2);
  }
};

main().catch((e) => {
  console.error(`[principal] FAILED: ${(e as Error).message}`);
  process.exit(1);
});
