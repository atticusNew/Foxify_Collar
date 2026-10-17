#!/usr/bin/env tsx
/**
 * THE FLOOR DRILL: the week that has not happened yet, run on the real book.
 *
 * Zero floor saves on the first 548 settled positions means the code path that
 * pays a floor has never run against live data. This re-settles every position
 * in the public CSV (or a ledger file) at spot moved by a shock, prints what the
 * floor would have paid, what users would have ended with, and checks the two
 * things that must hold before a real one arrives: the writer's side equals the
 * take to the cent, and every floor save lands exactly at floor P&L plus credit.
 *
 *   npx tsx services/api/scripts/perpShadowFloorDrill.ts --csv /path/perp-shadow-positions.csv [--shock -0.08]
 *   npx tsx services/api/scripts/perpShadowFloorDrill.ts --url https://atticus-earn-protect-shadow.onrender.com [--shock -0.08]
 *   npx tsx services/api/scripts/perpShadowFloorDrill.ts --ledger /var/data/perp-shadow-ledger.jsonl
 *
 * Default shocks: -8%, -12%, +8% (both wings and both sides). Read-only; prints JSON.
 */

import { readFileSync } from "node:fs";
import { loadPerpShadowRecords, replayPerpShadow } from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowLedger";
import { floorDrill, type DrillPosition } from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowOps";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** The public CSV's columns are enough: ctVal is recovered from notional / (contracts x spot). */
export const positionsFromCsv = (csv: string): DrillPosition[] => {
  const lines = csv.split("\n").filter((l) => l.trim());
  const head = lines[0].split(",");
  const col = (name: string) => head.indexOf(name);
  const idx = { side: col("side"), contracts: col("contracts"), notional: col("notional_c"), spot: col("spot_c"), floor: col("floor_strike_c"), cap: col("cap_strike_c"), credit: col("credit_c"), take: col("take_c") };
  if (Object.values(idx).some((i) => i < 0)) throw new Error(`CSV is missing a column: ${JSON.stringify(idx)}`);
  const out: DrillPosition[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    const contracts = Number(c[idx.contracts]);
    const spotCents = Number(c[idx.spot]);
    const notionalCents = Number(c[idx.notional]);
    if (!(contracts > 0) || !(spotCents > 0) || !(notionalCents > 0)) continue;
    out.push({
      side: c[idx.side] === "short" ? "short" : "long",
      contracts,
      ctValBtc: notionalCents / (contracts * spotCents),
      spotCents,
      floorStrikeCents: Number(c[idx.floor]),
      capStrikeCents: Number(c[idx.cap]),
      creditCents: Number(c[idx.credit]) || 0,
      takeCents: Number(c[idx.take]) || 0,
    });
  }
  return out;
};

async function main(): Promise<void> {
  let positions: DrillPosition[];
  const ledger = arg("ledger");
  const csvPath = arg("csv");
  const url = arg("url");
  if (ledger) positions = replayPerpShadow(loadPerpShadowRecords(ledger)).positions;
  else if (csvPath) positions = positionsFromCsv(readFileSync(csvPath, "utf8"));
  else if (url) {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/shadow/positions.csv`);
    if (!res.ok) throw new Error(`CSV HTTP ${res.status}`);
    positions = positionsFromCsv(await res.text());
  } else throw new Error("give --csv, --url or --ledger");
  const shocks = arg("shock") ? [Number(arg("shock"))] : [-0.08, -0.12, 0.08];
  const results = shocks.map((s) => floorDrill(positions, s));
  process.stdout.write(JSON.stringify({ positions: positions.length, results }, null, 2) + "\n");
  const bad = results.filter((r) => !r.identityHolds || !r.floorClampHolds);
  if (bad.length) {
    console.error(`[floor-drill] FAILED on ${bad.map((r) => `${(r.shockPct * 100).toFixed(0)}%`).join(", ")}: identity or floor clamp broke`);
    process.exit(1);
  }
  console.error(`[floor-drill] ${positions.length} positions · ${results.map((r) => `${(r.shockPct * 100).toFixed(0)}%: ${r.floorSaves} floor saves, floor pays $${(r.floorPayoutCents / 100).toFixed(2)}, gap $${(r.gapCents / 100).toFixed(2)}`).join(" · ")}`);
}

if (process.env.NODE_ENV !== "test") void main();
