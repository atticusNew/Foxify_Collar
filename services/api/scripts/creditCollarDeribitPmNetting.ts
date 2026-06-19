#!/usr/bin/env tsx
/**
 * Deribit PORTFOLIO-MARGIN NETTING measurement — READ-ONLY. Measures the REAL cross-wing netting of
 * a delta-flat collar book by comparing Deribit's portfolio-margin simulation of both short wings
 * (short put + short call) against the sum of their ISOLATED short-leg margins. Places NOTHING.
 *
 * netting factor = portfolio_initial_margin({short put, short call}) / (isoPutSellIM + isoCallSellIM)
 *
 * Plug the result into MODELB_PM_NETTING for the calibrated economics (replaces the 0.45 placeholder).
 *
 *   DERIBIT_CLIENT_ID=... DERIBIT_CLIENT_SECRET=... \
 *   DERIBIT_PM_TENORS=1,2,7 DERIBIT_PM_FLOOR_PCT=0.03 DERIBIT_PM_CAP_PCT=0.02 DERIBIT_PM_SIZE=1 \
 *   npm --silent --workspace services/api run deribit:pm-netting | jq .
 */

import { DeribitExecutionClient, type DeribitMode } from "../src/singleSide/twoSided/creditCollar/execution/deribitExecutionClient";
import { resolveDeribitCollarLegs, portfolioNettingFactor } from "../src/singleSide/twoSided/creditCollar/execution/deribitLegResolver";

const nums = (v: string | undefined, d: number[]): number[] => (v ? v.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)) : d);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const clientId = process.env.DERIBIT_CLIENT_ID;
  const clientSecret = process.env.DERIBIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("[deribit-pm-netting] missing DERIBIT_CLIENT_ID / DERIBIT_CLIENT_SECRET");
    process.exit(2);
  }
  const mode: DeribitMode = (process.env.DERIBIT_EXECUTION_MODE ?? "testnet").toLowerCase() === "live" ? "live" : "testnet";
  const client = new DeribitExecutionClient({ clientId, clientSecret, mode });
  console.error(`[deribit-pm-netting] REST base: ${client.restBase}`);

  const auth = await client.authCheck();
  if (!auth.ok) {
    console.error(`[deribit-pm-netting] AUTH FAILED: ${auth.message} — run deribit:auth-probe.`);
    process.exit(8);
  }
  console.error("[deribit-pm-netting] auth ok ✓ (read-only — no orders placed)");

  // Margin model matters: PM netting is only < 1 on a Portfolio Margin account. Report it up front.
  const acct = await client.getAccountSummary("BTC");
  const pmEnabled = acct.result?.portfolio_margining_enabled === true;
  const marginModel = acct.result?.margin_model ?? "unknown";
  console.error(`[deribit-pm-netting] account margin model: ${marginModel} · portfolio_margining_enabled=${pmEnabled}`);
  if (!pmEnabled) {
    console.error("[deribit-pm-netting] ⚠️ account is NOT in Portfolio Margin — netting will read 1.0 (no cross-wing offset).");
    console.error("  To measure real PM savings: on test.deribit.com switch the account to Portfolio Margin (Account → Margin model),");
    console.error("  close leftover test positions, then re-run. Until then MODELB_PM_NETTING=1 (isolated) is the correct conservative input.");
  }

  const idx = await client.getOrderBook("BTC-PERPETUAL").catch(() => null);
  const spot = idx?.result?.best_ask_price != null && idx.result.best_bid_price != null ? (Number(idx.result.best_ask_price) + Number(idx.result.best_bid_price)) / 2 : 0;
  if (!(spot > 0)) {
    console.error("[deribit-pm-netting] could not get spot");
    process.exit(4);
  }

  const tenors = nums(process.env.DERIBIT_PM_TENORS, [1, 2, 7]);
  const floorPct = Number(process.env.DERIBIT_PM_FLOOR_PCT ?? "0.03");
  const capPct = Number(process.env.DERIBIT_PM_CAP_PCT ?? "0.02");
  const sizeBtc = Number(process.env.DERIBIT_PM_SIZE ?? "1");
  const maxCandidates = Number(process.env.DERIBIT_MAX_CANDIDATES ?? "10");

  // Account baseline (existing positions) so we can also report an INCREMENTAL netting that is robust
  // to leftover test positions: incremental IM of adding the collar = withLegs − baseline.
  await sleep(1100);
  const baseline = await client.simulatePortfolio("BTC", {}, true);
  const baselineIm = baseline.result?.projected_initial_margin != null ? Math.abs(Number(baseline.result.projected_initial_margin)) : null;
  console.error(`[deribit-pm-netting] account baseline IM (existing positions): ${baselineIm ?? "n/a"}BTC`);

  const points: Array<Record<string, unknown>> = [];
  const factors: number[] = [];
  for (const tenorDays of tenors) {
    const resolved = await resolveDeribitCollarLegs(
      (currency, kind) => client.getInstruments(currency, kind),
      (name) => client.getOrderBook(name),
      { nowMs: Date.now(), tenorDays, putTarget: spot * (1 - floorPct), callTarget: spot * (1 + capPct), maxCandidates }
    );
    if (!resolved.ok || !resolved.legs) {
      console.error(`[deribit-pm-netting] skip tenor=${tenorDays}: ${resolved.error}`);
      continue;
    }
    const { putInstrument, callInstrument } = resolved.legs;
    // Need short-side prices (bids) for the isolated SELL margins.
    const [pb, cb] = await Promise.all([client.getOrderBook(putInstrument), client.getOrderBook(callInstrument)]);
    const putBid = pb.result?.best_bid_price != null ? Number(pb.result.best_bid_price) : 0.001;
    const callBid = cb.result?.best_bid_price != null ? Number(cb.result.best_bid_price) : 0.001;

    const isoPut = await client.getMargins(putInstrument, sizeBtc, putBid);
    const isoCall = await client.getMargins(callInstrument, sizeBtc, callBid);
    const isoPutSell = isoPut.result?.sell != null ? Math.abs(Number(isoPut.result.sell)) : null;
    const isoCallSell = isoCall.result?.sell != null ? Math.abs(Number(isoCall.result.sell)) : null;

    const legs = { [putInstrument]: -sizeBtc, [callInstrument]: -sizeBtc };
    await sleep(1100); // simulate_portfolio is rate-limited to ~1/s
    const pmIsolated = await client.simulatePortfolio("BTC", legs, false); // simulated set only
    const isoSetIm = pmIsolated.result?.projected_initial_margin != null ? Math.abs(Number(pmIsolated.result.projected_initial_margin)) : null;
    await sleep(1100);
    const pmWith = await client.simulatePortfolio("BTC", legs, true); // account + legs (for incremental)
    const withIm = pmWith.result?.projected_initial_margin != null ? Math.abs(Number(pmWith.result.projected_initial_margin)) : null;
    const incrementalIm = withIm != null && baselineIm != null ? Math.max(0, withIm - baselineIm) : null;

    if (isoPutSell == null || isoCallSell == null) {
      console.error(`[deribit-pm-netting] tenor=${tenorDays}: incomplete isolated margins (isoPut=${isoPutSell} isoCall=${isoCallSell})`);
      continue;
    }
    const isoSum = isoPutSell + isoCallSell;
    // Prefer the isolated-set PM number; fall back to the incremental estimate if the set number looks
    // contaminated (≫ isolated sum ⟹ the account baseline leaked in).
    const setLooksClean = isoSetIm != null && isoSetIm < isoSum * 3;
    const pmForNetting = setLooksClean ? (isoSetIm as number) : incrementalIm;
    const nettingFactor = pmForNetting != null ? portfolioNettingFactor([isoPutSell, isoCallSell], pmForNetting) : null;
    if (nettingFactor != null) factors.push(nettingFactor);
    points.push({
      tenorDays,
      putInstrument,
      callInstrument,
      sizeBtc,
      isoPutSellBtc: +isoPutSell.toFixed(8),
      isoCallSellBtc: +isoCallSell.toFixed(8),
      isolatedSumBtc: +isoSum.toFixed(8),
      pmIsolatedSetImBtc: isoSetIm != null ? +isoSetIm.toFixed(8) : null,
      pmIncrementalImBtc: incrementalIm != null ? +incrementalIm.toFixed(8) : null,
      usedSource: setLooksClean ? "isolated_set" : "incremental",
      nettingFactor: nettingFactor != null ? +nettingFactor.toFixed(4) : null,
      contaminated: !setLooksClean
    });
    console.error(`[deribit-pm-netting] tenor=${tenorDays}d isolated ${isoSum.toFixed(5)}BTC · PM-set ${isoSetIm?.toFixed(5) ?? "n/a"}BTC · PM-incremental ${incrementalIm?.toFixed(5) ?? "n/a"}BTC ⟹ netting ${nettingFactor?.toFixed(4) ?? "n/a"} (${setLooksClean ? "isolated_set" : "incremental"})`);
  }

  const summary = factors.length
    ? {
        nettingFactor_min: +Math.min(...factors).toFixed(4),
        nettingFactor_max: +Math.max(...factors).toFixed(4),
        nettingFactor_median: +factors.slice().sort((a, b) => a - b)[Math.floor(factors.length / 2)].toFixed(4),
        // Conservative: if PM isn't enabled there is NO netting ⟹ 1; else the least netting observed.
        suggestedPmNetting: pmEnabled ? +Math.max(...factors).toFixed(4) : 1
      }
    : null;

  process.stdout.write(
    JSON.stringify(
      { venue: "deribit", mode, spot, marginModel, portfolioMarginingEnabled: pmEnabled, baselineImBtc: baselineIm, floorPct, capPct, sizeBtc, points, summary, note: pmEnabled ? "MODELB_PM_NETTING = suggestedPmNetting" : "Account NOT in Portfolio Margin ⟹ netting=1 (isolated). Enable PM + clean positions to measure savings." },
      null,
      2
    ) + "\n"
  );
  if (summary) console.error(`[deribit-pm-netting] PM netting: ${summary.nettingFactor_min}–${summary.nettingFactor_max} (median ${summary.nettingFactor_median}). Use MODELB_PM_NETTING=${summary.suggestedPmNetting}${pmEnabled ? "" : " (PM not enabled ⟹ isolated)"}.`);
};

main().catch((e) => {
  console.error("[deribit-pm-netting] fatal:", e);
  process.exit(1);
});
