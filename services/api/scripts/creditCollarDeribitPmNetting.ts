#!/usr/bin/env tsx
/**
 * Deribit PORTFOLIO-MARGIN NETTING measurement — READ-ONLY. Measures the REAL netting of a STEERED-
 * FLAT collar book: opposing collars at adjacent strikes — long-client collar (short put0, long call0)
 * + short-client collar (long put1, short call1) — whose LONG legs offset the SHORT legs. Compares the
 * book's PM initial margin to the gross sum of the two SHORT legs' isolated margins. Places NOTHING.
 *
 * netting factor = PM_IM(balanced book) / (isoSell(put0) + isoSell(call1))
 *
 * (A short strangle is also reported as a no-offset reference — it raises PM, confirming you must
 * net with opposing flow, not warehouse both short wings.) Plug the BOOK netting into MODELB_PM_NETTING.
 *
 *   DERIBIT_CLIENT_ID=... DERIBIT_CLIENT_SECRET=... \
 *   DERIBIT_PM_TENORS=1,2,7 DERIBIT_PM_FLOOR_PCT=0.03 DERIBIT_PM_CAP_PCT=0.02 DERIBIT_PM_SIZE=1 \
 *   npm --silent --workspace services/api run deribit:pm-netting | jq .
 */

import { DeribitExecutionClient, type DeribitMode } from "../src/singleSide/twoSided/creditCollar/execution/deribitExecutionClient";
import { rankDeribitCollarCandidates, portfolioNettingFactor } from "../src/singleSide/twoSided/creditCollar/execution/deribitLegResolver";

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

  const instr = await client.getInstruments("BTC", "option");
  const names = (instr.result ?? []).filter((d) => d.is_active !== false).map((d) => String(d.instrument_name ?? "")).filter(Boolean);

  const bidOf = async (name: string) => {
    const ob = await client.getOrderBook(name);
    return ob.result?.best_bid_price != null ? Number(ob.result.best_bid_price) : 0.001;
  };
  const incrementalPm = async (positions: Record<string, number>): Promise<number | null> => {
    await sleep(1100); // simulate_portfolio rate-limited ~1/s
    const r = await client.simulatePortfolio("BTC", positions, true);
    const im = r.result?.projected_initial_margin != null ? Math.abs(Number(r.result.projected_initial_margin)) : null;
    return im != null && baselineIm != null ? Math.max(0, im - baselineIm) : null;
  };

  const points: Array<Record<string, unknown>> = [];
  const factors: number[] = [];
  for (const tenorDays of tenors) {
    const cand = rankDeribitCollarCandidates(names, { nowMs: Date.now(), tenorDays, putTarget: spot * (1 - floorPct), callTarget: spot * (1 + capPct) });
    if (!cand || cand.puts.length < 2 || cand.calls.length < 2) {
      console.error(`[deribit-pm-netting] skip tenor=${tenorDays}: need ≥2 put + ≥2 call strikes`);
      continue;
    }
    // Opposing collars at ADJACENT strikes (the steered-flat book): a long-client collar (short put0,
    // long call0) + a short-client collar (long put1, short call1). The long legs offset the shorts.
    const put0 = cand.puts[0], put1 = cand.puts[1], call0 = cand.calls[0], call1 = cand.calls[1];
    const book = { [put0.name]: -sizeBtc, [call0.name]: +sizeBtc, [put1.name]: +sizeBtc, [call1.name]: -sizeBtc };

    // Gross short-leg isolated margins (what the model books at pmNetting=1): the two SHORT legs.
    const [put0Bid, call1Bid] = await Promise.all([bidOf(put0.name), bidOf(call1.name)]);
    const isoPut0 = await client.getMargins(put0.name, sizeBtc, put0Bid);
    const isoCall1 = await client.getMargins(call1.name, sizeBtc, call1Bid);
    const isoPutSell = isoPut0.result?.sell != null ? Math.abs(Number(isoPut0.result.sell)) : null;
    const isoCallSell = isoCall1.result?.sell != null ? Math.abs(Number(isoCall1.result.sell)) : null;
    if (isoPutSell == null || isoCallSell == null) {
      console.error(`[deribit-pm-netting] tenor=${tenorDays}: incomplete isolated margins`);
      continue;
    }
    const grossShortIsolated = isoPutSell + isoCallSell;

    const bookPm = await incrementalPm(book);                                  // balanced/offsetting book
    const stranglePm = await incrementalPm({ [put0.name]: -sizeBtc, [call0.name]: -sizeBtc }); // no-offset reference

    const nettingBook = bookPm != null ? portfolioNettingFactor([isoPutSell, isoCallSell], bookPm) : null;
    const nettingStrangle = stranglePm != null ? portfolioNettingFactor([isoPutSell, isoCallSell], stranglePm) : null;
    if (nettingBook != null) factors.push(nettingBook);

    points.push({
      tenorDays,
      collar: { putShort: put0.name, callLong: call0.name, putLong: put1.name, callShort: call1.name },
      sizeBtc,
      grossShortIsolatedBtc: +grossShortIsolated.toFixed(8),
      balancedBookPmImBtc: bookPm != null ? +bookPm.toFixed(8) : null,
      strangleRefPmImBtc: stranglePm != null ? +stranglePm.toFixed(8) : null,
      nettingFactorBook: nettingBook != null ? +nettingBook.toFixed(4) : null,
      nettingFactorStrangleRef: nettingStrangle != null ? +nettingStrangle.toFixed(4) : null
    });
    console.error(`[deribit-pm-netting] tenor=${tenorDays}d grossShortIso ${grossShortIsolated.toFixed(5)}BTC · balanced-book PM ${bookPm?.toFixed(5) ?? "n/a"}BTC ⟹ netting ${nettingBook?.toFixed(4) ?? "n/a"} (strangle ref ${nettingStrangle?.toFixed(4) ?? "n/a"})`);
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
      { venue: "deribit", mode, spot, marginModel, portfolioMarginingEnabled: pmEnabled, baselineImBtc: baselineIm, floorPct, capPct, sizeBtc, points, summary, note: pmEnabled ? "MODELB_PM_NETTING = suggestedPmNetting (balanced-book PM IM / gross short-leg isolated). Strangle ref ≥1 confirms shorts must be netted with opposing flow." : "Account NOT in Portfolio Margin ⟹ netting=1 (isolated). Enable PM to measure savings." },
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
