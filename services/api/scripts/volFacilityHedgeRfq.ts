/**
 * volFacilityHedgeRfq — Live Bullish RFQ for the volume-facility 30-day
 * ±2% BTC strangle.
 *
 * Resolves the open V1 calibration question: what does Bullish actually
 * quote for the structured-product hedge instrument we plan to use?
 *
 * Reads existing PILOT_BULLISH_* environment variables for auth (same
 * config the live pilot uses), pulls the BTC option chain, picks the
 * nearest-strike CALL and PUT to ±2% of current spot at ~30-day expiry,
 * fetches each leg's orderbook, computes the strangle cost, and writes
 * a structured JSON + markdown report.
 *
 * Usage
 * -----
 *
 *     # Default: 30-day tenor, ±2% strikes, $50k pair notional
 *     pnpm tsx services/api/scripts/volFacilityHedgeRfq.ts
 *
 *     # Custom
 *     pnpm tsx services/api/scripts/volFacilityHedgeRfq.ts \
 *         --notional-usd 50000 --tenor-days 30 --barrier-pct 0.02 \
 *         --out docs/cfo-report/double-barrier-analysis/rfq/
 *
 * Required env vars (same as existing pilotBullishSmokeTest):
 *   PILOT_BULLISH_REST_BASE_URL
 *   PILOT_BULLISH_PUBLIC_WS_URL
 *   PILOT_BULLISH_AUTH_MODE              (ecdsa or hmac)
 *   PILOT_BULLISH_ECDSA_PUBLIC_KEY       (or PILOT_BULLISH_HMAC_PUBLIC_KEY)
 *   PILOT_BULLISH_ECDSA_PRIVATE_KEY      (or PILOT_BULLISH_HMAC_SECRET)
 *   PILOT_BULLISH_AUTHORIZER
 *   PILOT_BULLISH_TRADING_ACCOUNT_ID
 *
 * Output
 * ------
 *   <out>/rfq_<timestamp>.json   Machine-readable
 *   <out>/rfq_<timestamp>.md     Founder-readable
 *
 * Exit codes
 *   0 — quoted successfully
 *   1 — auth failed or no chain available
 *   2 — no candidate strikes within tolerance
 */

import Decimal from "decimal.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BullishTradingClient } from "../src/pilot/bullish";

type Args = {
  notionalUsd: number;
  tenorDays: number;
  barrierPct: number;
  spotSymbol: string;
  outDir: string;
};

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    notionalUsd: 50_000,
    tenorDays: 30,
    barrierPct: 0.02,
    spotSymbol: process.env.VOL_FACILITY_RFQ_SPOT_SYMBOL || "BTCUSDC",
    outDir: process.env.VOL_FACILITY_RFQ_OUT_DIR ||
      "docs/cfo-report/double-barrier-analysis/rfq"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--notional-usd" && argv[i + 1]) { args.notionalUsd = Number(argv[++i]); continue; }
    if (t === "--tenor-days" && argv[i + 1])   { args.tenorDays   = Number(argv[++i]); continue; }
    if (t === "--barrier-pct" && argv[i + 1])  { args.barrierPct  = Number(argv[++i]); continue; }
    if (t === "--spot-symbol" && argv[i + 1])  { args.spotSymbol  = argv[++i]; continue; }
    if (t === "--out" && argv[i + 1])          { args.outDir      = argv[++i]; continue; }
  }
  return args;
};

type OptionSym = {
  symbol: string;
  expiryMs: number;
  strike: number;
  optionType: "CALL" | "PUT";
};

const parseBullishOptionSymbol = (symbol: string): OptionSym | null => {
  const m = String(symbol || "").trim().toUpperCase()
    .match(/^BTC-USDC-(\d{8})-(\d+(?:\.\d+)*)-(C|P)$/);
  if (!m) return null;
  const expiryRaw = m[1];
  const expiryMs = Date.UTC(
    Number(expiryRaw.slice(0, 4)),
    Number(expiryRaw.slice(4, 6)) - 1,
    Number(expiryRaw.slice(6, 8)),
    8, 0, 0, 0
  );
  return {
    symbol,
    expiryMs,
    strike: Number(m[2]),
    optionType: m[3] === "C" ? "CALL" : "PUT"
  };
};

const buildClient = (): BullishTradingClient => {
  const authMode =
    (process.env.PILOT_BULLISH_AUTH_MODE || "ecdsa").trim().toLowerCase() === "hmac"
      ? "hmac" : "ecdsa";
  return new BullishTradingClient({
    enabled: true,
    restBaseUrl: process.env.PILOT_BULLISH_REST_BASE_URL || "",
    publicWsUrl: process.env.PILOT_BULLISH_PUBLIC_WS_URL || "",
    privateWsUrl: process.env.PILOT_BULLISH_PRIVATE_WS_URL || "",
    authMode,
    hmacPublicKey: process.env.PILOT_BULLISH_HMAC_PUBLIC_KEY || "",
    hmacSecret: process.env.PILOT_BULLISH_HMAC_SECRET || "",
    ecdsaPublicKey: process.env.PILOT_BULLISH_ECDSA_PUBLIC_KEY || "",
    ecdsaPrivateKey: process.env.PILOT_BULLISH_ECDSA_PRIVATE_KEY || "",
    ecdsaMetadata: process.env.PILOT_BULLISH_ECDSA_METADATA || undefined,
    authorizer: process.env.PILOT_BULLISH_AUTHORIZER || "",
    tradingAccountId: process.env.PILOT_BULLISH_TRADING_ACCOUNT_ID || ""
  });
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const client = buildClient();

  // 1. Get spot
  console.log(`[rfq] fetching spot for ${args.spotSymbol} ...`);
  const ob = await client.getHybridOrderBook(args.spotSymbol);
  const bestBid = Number(ob.bids?.[0]?.[0] || 0);
  const bestAsk = Number(ob.asks?.[0]?.[0] || 0);
  if (!bestBid || !bestAsk) throw new Error(`no_spot_orderbook for ${args.spotSymbol}`);
  const spot = (bestBid + bestAsk) / 2;
  console.log(`[rfq] spot mid = $${spot.toFixed(2)}`);

  const targetExpiryMs = Date.now() + args.tenorDays * 86_400_000;
  const targetCallStrike = spot * (1 + args.barrierPct);
  const targetPutStrike  = spot * (1 - args.barrierPct);
  const btcQty = args.notionalUsd / spot;
  console.log(`[rfq] target call strike $${targetCallStrike.toFixed(0)}  put strike $${targetPutStrike.toFixed(0)}`);
  console.log(`[rfq] target expiry ${new Date(targetExpiryMs).toISOString().slice(0, 10)}  qty ${btcQty.toFixed(4)} BTC`);

  // 2. Pull all markets, filter to BTC options
  console.log(`[rfq] pulling option chain ...`);
  const markets = await client.getMarkets({ forceRefresh: true });
  const opts: OptionSym[] = [];
  for (const m of markets) {
    const parsed = parseBullishOptionSymbol(m.symbol);
    if (parsed) opts.push(parsed);
  }
  console.log(`[rfq] ${opts.length} BTC option markets enumerated`);

  // 3. Find nearest-tenor expiry to target
  const tenorDistance = (e: number) => Math.abs(e - targetExpiryMs);
  const expiriesSorted = Array.from(
    new Set(opts.map(o => o.expiryMs))
  ).sort((a, b) => tenorDistance(a) - tenorDistance(b));
  if (!expiriesSorted.length) {
    throw new Error("no_btc_option_markets_found");
  }
  const expiryMs = expiriesSorted[0];
  const tenorActualDays = (expiryMs - Date.now()) / 86_400_000;
  console.log(`[rfq] best matching expiry: ${new Date(expiryMs).toISOString().slice(0, 10)} (${tenorActualDays.toFixed(1)}d)`);

  // 4. Pick best-fit call and put at that expiry
  const candidates = opts.filter(o => o.expiryMs === expiryMs);
  const calls = candidates.filter(o => o.optionType === "CALL")
    .sort((a, b) => Math.abs(a.strike - targetCallStrike) - Math.abs(b.strike - targetCallStrike));
  const puts  = candidates.filter(o => o.optionType === "PUT")
    .sort((a, b) => Math.abs(a.strike - targetPutStrike) - Math.abs(b.strike - targetPutStrike));
  if (!calls.length || !puts.length) {
    throw new Error("no_call_or_put_available_at_target_expiry");
  }
  const call = calls[0];
  const put  = puts[0];
  console.log(`[rfq] call leg: ${call.symbol}  strike $${call.strike}`);
  console.log(`[rfq] put  leg: ${put.symbol}   strike $${put.strike}`);

  // 5. Fetch each leg's orderbook for ask price
  const callOb = await client.getHybridOrderBook(call.symbol);
  const putOb  = await client.getHybridOrderBook(put.symbol);
  const callAsk = Number(callOb.asks?.[0]?.[0] || 0);
  const putAsk  = Number(putOb.asks?.[0]?.[0] || 0);
  const callBid = Number(callOb.bids?.[0]?.[0] || 0);
  const putBid  = Number(putOb.bids?.[0]?.[0] || 0);
  if (!callAsk || !putAsk) {
    console.warn(`[rfq] one or both legs has no ask: callAsk=${callAsk} putAsk=${putAsk}`);
  }

  const callCostUsd = new Decimal(callAsk).mul(btcQty).toNumber();
  const putCostUsd  = new Decimal(putAsk).mul(btcQty).toNumber();
  const totalStrangleUsd = callCostUsd + putCostUsd;

  console.log(`\n=== RFQ RESULT ===`);
  console.log(`spot                        $${spot.toFixed(2)}`);
  console.log(`target tenor / actual       ${args.tenorDays}d / ${tenorActualDays.toFixed(1)}d`);
  console.log(`call ${call.symbol}  ask=${callAsk}  bid=${callBid}  cost=$${callCostUsd.toFixed(2)}`);
  console.log(`put  ${put.symbol}   ask=${putAsk}   bid=${putBid}   cost=$${putCostUsd.toFixed(2)}`);
  console.log(`STRANGLE TOTAL (ask)        $${totalStrangleUsd.toFixed(2)}`);
  console.log(`per-pair-day amortized      $${(totalStrangleUsd / tenorActualDays).toFixed(2)}`);
  console.log(`vs founder's $1,150 quote   ${totalStrangleUsd > 1150 ? "HIGHER" : "LOWER"} (${((totalStrangleUsd / 1150 - 1) * 100).toFixed(0)}%)`);
  console.log(`vs CFO doc $3,700 estimate  ${totalStrangleUsd > 3700 ? "HIGHER" : "LOWER"} (${((totalStrangleUsd / 3700 - 1) * 100).toFixed(0)}%)`);

  // 6. Write outputs
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  await mkdir(args.outDir, { recursive: true });
  const out = {
    timestamp: new Date().toISOString(),
    venue: "bullish",
    base_url: process.env.PILOT_BULLISH_REST_BASE_URL || "",
    spot_usd: spot,
    notional_usd: args.notionalUsd,
    btc_qty: btcQty,
    target_tenor_days: args.tenorDays,
    actual_tenor_days: tenorActualDays,
    target_barrier_pct: args.barrierPct,
    target_call_strike: targetCallStrike,
    target_put_strike:  targetPutStrike,
    call: {
      symbol: call.symbol, strike: call.strike,
      ask_usd_per_btc: callAsk, bid_usd_per_btc: callBid,
      cost_usd_for_qty: callCostUsd
    },
    put: {
      symbol: put.symbol, strike: put.strike,
      ask_usd_per_btc: putAsk, bid_usd_per_btc: putBid,
      cost_usd_for_qty: putCostUsd
    },
    strangle_total_usd: totalStrangleUsd,
    per_pair_day_amortized_usd: totalStrangleUsd / tenorActualDays,
    calibration_check: {
      vs_founder_1150: totalStrangleUsd / 1150,
      vs_cfo_doc_3700: totalStrangleUsd / 3700,
    }
  };
  const jsonPath = path.join(args.outDir, `rfq_${ts}.json`);
  await writeFile(jsonPath, JSON.stringify(out, null, 2), "utf8");

  const md = [
    `# Bullish 30d ±2% BTC Strangle — Live RFQ Snapshot`,
    ``,
    `> Generated by \`services/api/scripts/volFacilityHedgeRfq.ts\` at ${out.timestamp}`,
    ``,
    `## Quote`,
    ``,
    `| Item | Value |`,
    `|---|---|`,
    `| Venue | Bullish (\`${out.base_url}\`) |`,
    `| BTC spot | $${spot.toFixed(2)} |`,
    `| Pair notional | $${args.notionalUsd.toLocaleString()} (${btcQty.toFixed(4)} BTC) |`,
    `| Target tenor / actual | ${args.tenorDays}d / ${tenorActualDays.toFixed(1)}d |`,
    `| Target barrier | ±${(args.barrierPct * 100).toFixed(2)}% |`,
    `| Call leg | \`${call.symbol}\` (K=$${call.strike}) — ask $${callAsk}/BTC, cost $${callCostUsd.toFixed(2)} |`,
    `| Put leg | \`${put.symbol}\` (K=$${put.strike}) — ask $${putAsk}/BTC, cost $${putCostUsd.toFixed(2)} |`,
    `| **Strangle total (ask)** | **$${totalStrangleUsd.toFixed(2)}** |`,
    `| Per-pair-day amortized | $${(totalStrangleUsd / tenorActualDays).toFixed(2)} |`,
    ``,
    `## Calibration check`,
    ``,
    `| Reference | Quote |`,
    `|---|---|`,
    `| Founder's $1,150 estimate | ${(out.calibration_check.vs_founder_1150).toFixed(2)}× |`,
    `| CFO doc $3,700 estimate | ${(out.calibration_check.vs_cfo_doc_3700).toFixed(2)}× |`,
    ``,
    `## Interpretation`,
    ``,
    `- If strangle ≈ $1,150 (founder estimate): venue is materially cheaper than BS no-arb; this is a *positive* finding — capture and document.`,
    `- If strangle ≈ $3,000–$5,500 (CFO doc / BS): everything in MEMO_V2.md stands as written.`,
    `- If strangle > $6,000: venue spread is wider than expected; daily-strangle hedging becomes even more attractive vs 30d straddle.`,
    ``,
    `Re-run this script with daily/weekly tenors to also calibrate \`scripts/double-barrier/historical_replay.py\`'s daily-strangle assumptions:`,
    ``,
    `\`\`\``,
    `pnpm tsx services/api/scripts/volFacilityHedgeRfq.ts --tenor-days 1`,
    `pnpm tsx services/api/scripts/volFacilityHedgeRfq.ts --tenor-days 7`,
    `pnpm tsx services/api/scripts/volFacilityHedgeRfq.ts --tenor-days 30`,
    `\`\`\``,
  ].join("\n");
  const mdPath = path.join(args.outDir, `rfq_${ts}.md`);
  await writeFile(mdPath, md, "utf8");

  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
};

main().catch((err) => {
  console.error("[rfq] failed:", err?.message || err);
  process.exit(1);
});
