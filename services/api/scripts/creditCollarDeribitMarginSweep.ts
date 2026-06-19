#!/usr/bin/env tsx
/**
 * Deribit short-leg MARGIN SWEEP — READ-ONLY. Builds the short-call initial-margin curve across
 * sizes / tenors / moneyness using Deribit's get_margins (computes margin for a HYPOTHETICAL order;
 * places NOTHING, moves NO capital). The output is the empirical capital input for reserve sizing:
 * short-option IM as a fraction of notional — measured, not assumed.
 *
 *   DERIBIT_CLIENT_ID=... DERIBIT_CLIENT_SECRET=... \
 *   DERIBIT_SWEEP_SIZES=0.1,0.3,1 DERIBIT_SWEEP_TENORS=1,2,7 DERIBIT_SWEEP_CAP_PCTS=0.01,0.02,0.05 \
 *   npm --silent --workspace services/api run deribit:margin-sweep | jq .
 */

import { DeribitExecutionClient, type DeribitMode } from "../src/singleSide/twoSided/creditCollar/execution/deribitExecutionClient";
import { resolveDeribitCollarLegs } from "../src/singleSide/twoSided/creditCollar/execution/deribitLegResolver";

const nums = (v: string | undefined, d: number[]): number[] => (v ? v.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)) : d);

type SweepPoint = {
  tenorDays: number;
  capPct: number;
  sizeBtc: number;
  callInstrument: string;
  callStrike: number;
  callBidBtc: number | null;
  shortCallImBtc: number | null;
  shortCallImUsd: number | null;
  imPctOfNotional: number | null; // shortCallImBtc / sizeBtc
};

const main = async () => {
  const clientId = process.env.DERIBIT_CLIENT_ID;
  const clientSecret = process.env.DERIBIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("[deribit-margin-sweep] missing DERIBIT_CLIENT_ID / DERIBIT_CLIENT_SECRET");
    process.exit(2);
  }
  const mode: DeribitMode = (process.env.DERIBIT_EXECUTION_MODE ?? "testnet").toLowerCase() === "live" ? "live" : "testnet";
  const client = new DeribitExecutionClient({ clientId, clientSecret, mode });
  console.error(`[deribit-margin-sweep] REST base: ${client.restBase}`);

  const auth = await client.authCheck();
  if (!auth.ok) {
    console.error(`[deribit-margin-sweep] AUTH FAILED: ${auth.message} — run deribit:auth-probe.`);
    process.exit(8);
  }
  console.error("[deribit-margin-sweep] auth ok ✓ (read-only — no orders placed)");

  const idx = await client.getOrderBook("BTC-PERPETUAL").catch(() => null);
  const spot = idx?.result?.best_ask_price != null && idx.result.best_bid_price != null ? (Number(idx.result.best_ask_price) + Number(idx.result.best_bid_price)) / 2 : 0;
  if (!(spot > 0)) {
    console.error("[deribit-margin-sweep] could not get spot");
    process.exit(4);
  }

  const sizes = nums(process.env.DERIBIT_SWEEP_SIZES, [0.1, 0.3, 1]);
  const tenors = nums(process.env.DERIBIT_SWEEP_TENORS, [1, 2, 7]);
  const capPcts = nums(process.env.DERIBIT_SWEEP_CAP_PCTS, [0.01, 0.02, 0.05]);
  const floorPct = Number(process.env.DERIBIT_SWEEP_FLOOR_PCT ?? "0.03");
  const maxCandidates = Number(process.env.DERIBIT_MAX_CANDIDATES ?? "10");

  const points: SweepPoint[] = [];
  for (const tenorDays of tenors) {
    for (const capPct of capPcts) {
      const resolved = await resolveDeribitCollarLegs(
        (currency, kind) => client.getInstruments(currency, kind),
        (name) => client.getOrderBook(name),
        { nowMs: Date.now(), tenorDays, putTarget: spot * (1 - floorPct), callTarget: spot * (1 + capPct), maxCandidates }
      );
      if (!resolved.ok || !resolved.legs) {
        console.error(`[deribit-margin-sweep] skip tenor=${tenorDays} cap=${capPct}: ${resolved.error}`);
        continue;
      }
      const { callInstrument, callStrike, callBidBtc } = resolved.legs;
      const price = callBidBtc ?? 0.001;
      for (const sizeBtc of sizes) {
        const m = await client.getMargins(callInstrument, sizeBtc, price);
        const shortCallImBtc = m.result?.sell != null ? Math.abs(Number(m.result.sell)) : null;
        const shortCallImUsd = shortCallImBtc != null ? +(shortCallImBtc * spot).toFixed(2) : null;
        const imPctOfNotional = shortCallImBtc != null && sizeBtc > 0 ? +((shortCallImBtc / sizeBtc) * 100).toFixed(3) : null;
        points.push({ tenorDays, capPct, sizeBtc, callInstrument, callStrike, callBidBtc, shortCallImBtc, shortCallImUsd, imPctOfNotional });
        console.error(`[deribit-margin-sweep] tenor=${tenorDays}d cap=${(capPct * 100).toFixed(1)}% size=${sizeBtc} ${callInstrument} → IM ${shortCallImBtc}BTC (~$${shortCallImUsd}, ${imPctOfNotional}% of notional)`);
      }
    }
  }

  // Summary: IM% of notional is the reserve-model input. Report the range + a conservative pick.
  const imPcts = points.map((p) => p.imPctOfNotional).filter((x): x is number => x != null);
  const summary = imPcts.length
    ? {
        imPctOfNotional_min: Math.min(...imPcts),
        imPctOfNotional_max: Math.max(...imPcts),
        imPctOfNotional_median: imPcts.slice().sort((a, b) => a - b)[Math.floor(imPcts.length / 2)],
        suggestedReserveFraction: +(Math.max(...imPcts) / 100).toFixed(4) // conservative = worst observed
      }
    : null;

  process.stdout.write(JSON.stringify({ venue: "deribit", mode, spot, sizes, tenors, capPcts, floorPct, points, summary, note: "shortOptionImFraction for the reserve model = suggestedReserveFraction (worst observed IM/notional)" }, null, 2) + "\n");
  if (summary) console.error(`[deribit-margin-sweep] short-call IM/notional: ${summary.imPctOfNotional_min}%–${summary.imPctOfNotional_max}% (median ${summary.imPctOfNotional_median}%). Reserve input ≈ ${summary.suggestedReserveFraction}.`);
};

main().catch((e) => {
  console.error("[deribit-margin-sweep] fatal:", e);
  process.exit(1);
});
