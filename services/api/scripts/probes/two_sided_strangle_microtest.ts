/**
 * Two-sided strangle microtest probe (PR 10).
 *
 * Pulls live anchors for the ITM guts strangle strikes ($77k put + $75k call)
 * and reports the expected round-trip cost at three operator-reviewed size tiers:
 *   Tier 1: 0.01 BTC per leg — shadow tier, ~$2-5 cost
 *   Tier 2: 0.05 BTC per leg — operator-reviewed, ~$25 cost
 *   Tier 3: 1.4 BTC per leg — full Phase 0 contract size, ~$100+ cost
 *                              (run during calm window only, operator-approved)
 *
 * Default mode: DRY RUN — reports expected costs + go/no-go per tier.
 * No real venue orders placed.
 *
 * Live mode (LIVE_MICROTEST=1): would invoke real Bullish/Deribit buy → 60s hold
 * → sell. NOT IMPLEMENTED in this commit (gated for safety). Operator must wire
 * the real venue path in a follow-up commit once Phase 0 is approved for
 * microtest execution.
 *
 * Usage:
 *   cd services/api
 *   export RENDER_API_URL=... RENDER_ADMIN_TOKEN=...
 *   npx tsx scripts/probes/two_sided_strangle_microtest.ts            # dry-run
 *   LIVE_MICROTEST=1 npx tsx scripts/probes/two_sided_strangle_microtest.ts  # not yet supported
 *
 * Output: per-tier feasibility table + recommended go/no-go.
 */

import * as fs from "node:fs/promises";

const ANCHORS_PATH = process.env.TWO_SIDED_ANCHORS_PATH ?? "/tmp/two_sided_anchors.json";
const LIVE_MODE = process.env.LIVE_MICROTEST === "1";

type LegAnchor = {
  strike: number;
  optionType: "put" | "call";
  venue: "bullish" | "deribit";
  bestAskUsdcPerBtc: number;
  depthWithin2pctBtc: number | null;
  symbol?: string;
  expiry?: string;
};

type LiveAnchors = {
  generatedAt: string;
  spotAtPull: number;
  source: string;
  anchors: LegAnchor[];
};

const SIZE_TIERS = [
  { label: "Tier 1 (shadow)", contractsBtc: 0.01, requiresOperatorReview: false, requiresCalmWindow: false },
  { label: "Tier 2 (operator review)", contractsBtc: 0.05, requiresOperatorReview: true, requiresCalmWindow: false },
  { label: "Tier 3 (full size)", contractsBtc: 1.4, requiresOperatorReview: true, requiresCalmWindow: true }
];

const PUT_STRIKE = 77_000;
const CALL_STRIKE = 75_000;

const loadAnchors = async (): Promise<LiveAnchors | null> => {
  try {
    return JSON.parse(await fs.readFile(ANCHORS_PATH, "utf8")) as LiveAnchors;
  } catch {
    return null;
  }
};

const main = async () => {
  console.log("# Two-Sided Strangle Microtest Probe\n");
  console.log(`Mode: ${LIVE_MODE ? "LIVE (not implemented)" : "DRY RUN"}\n`);

  if (LIVE_MODE) {
    console.error(
      "LIVE_MICROTEST=1 is not supported in this commit. Real Bullish/Deribit\n" +
        "buy/hold/sell wiring is a follow-up that requires credentials + an\n" +
        "operator-signed runbook. Dry-run produces a go/no-go report based on\n" +
        "live anchors that the operator can review before live cutover (PR 11)."
    );
    process.exit(2);
  }

  const anchors = await loadAnchors();
  if (!anchors) {
    console.error(
      `No anchors at ${ANCHORS_PATH}. Run probeTwoSidedAnchors.ts first:\n` +
        `  export RENDER_API_URL=... RENDER_ADMIN_TOKEN=...\n` +
        `  npx tsx scripts/backtest/singleSide/probeTwoSidedAnchors.ts`
    );
    process.exit(1);
  }

  console.log(`Anchors loaded: source=${anchors.source}, generatedAt=${anchors.generatedAt}, spot=\$${anchors.spotAtPull}`);
  console.log("");

  const putAnchor = anchors.anchors.find((a) => a.strike === PUT_STRIKE && a.optionType === "put");
  const callAnchor = anchors.anchors.find((a) => a.strike === CALL_STRIKE && a.optionType === "call");

  if (!putAnchor) {
    console.error(`No put anchor at \$${PUT_STRIKE}. Bullish credentials required for production put leg.`);
    process.exit(1);
  }
  if (!callAnchor) {
    console.error(`No call anchor at \$${CALL_STRIKE}.`);
    process.exit(1);
  }

  console.log(`PUT  \$${PUT_STRIKE} @ ${putAnchor.venue}:  ask=\$${putAnchor.bestAskUsdcPerBtc.toFixed(2)}/BTC, depth=${putAnchor.depthWithin2pctBtc?.toFixed(2) ?? "?"} BTC`);
  console.log(`CALL \$${CALL_STRIKE} @ ${callAnchor.venue}: ask=\$${callAnchor.bestAskUsdcPerBtc.toFixed(2)}/BTC, depth=${callAnchor.depthWithin2pctBtc?.toFixed(2) ?? "?"} BTC`);
  console.log("");

  console.log("Per-tier feasibility (dry-run):");
  console.log("");
  console.log("| Tier | Size (BTC/leg) | Put cost | Call cost | Total roundtrip | Depth OK? | Verdict |");
  console.log("|---|---:|---:|---:|---:|---|---|");

  for (const tier of SIZE_TIERS) {
    const putCost = putAnchor.bestAskUsdcPerBtc * tier.contractsBtc;
    const callCost = callAnchor.bestAskUsdcPerBtc * tier.contractsBtc;
    const total = putCost + callCost;
    // Round-trip cost estimate = 2 × (premium × slip) — typical 5-15% loss in micro probe
    const roundTripCost = total * 0.10; // ~10% lost to bid-ask spread on the round trip
    const putDepthOk = (putAnchor.depthWithin2pctBtc ?? 0) >= tier.contractsBtc * 1.2;
    const callDepthOk = (callAnchor.depthWithin2pctBtc ?? 0) >= tier.contractsBtc * 1.2;
    const depthOk = putDepthOk && callDepthOk;
    let verdict: string;
    if (!depthOk) verdict = "❌ INSUFFICIENT DEPTH";
    else if (tier.requiresCalmWindow) verdict = "⏸ OK (calm window + operator)";
    else if (tier.requiresOperatorReview) verdict = "⏸ OK (operator review)";
    else verdict = "✅ READY (shadow tier)";
    console.log(
      `| ${tier.label} | ${tier.contractsBtc} | \$${putCost.toFixed(2)} | \$${callCost.toFixed(2)} | ~\$${roundTripCost.toFixed(2)} | ${depthOk ? "Y" : "N"} | ${verdict} |`
    );
  }

  console.log("");
  console.log("Recommended sequence before PR 11 live cutover:");
  console.log("  1. Tier 1 (0.01 BTC) on shadow API endpoint — confirm round-trip < \$5");
  console.log("  2. Tier 2 (0.05 BTC) operator-reviewed — confirm pathing + fill quality");
  console.log("  3. Tier 3 (1.4 BTC) in calm window (DVOL < 50) — confirm production depth");
  console.log("");
  console.log("Live execution wiring is in a follow-up commit; this probe is dry-run only.");
};

// Main-guard
import { fileURLToPath } from "node:url";
const isDirect = typeof process !== "undefined" && process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
