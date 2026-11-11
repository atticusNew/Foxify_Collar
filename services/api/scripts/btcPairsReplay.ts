#!/usr/bin/env tsx
/**
 * BTC PAIRS REPLAY, command line: over the stored 10-second pairs cycles, what would a rule
 * have captured after fees if the trader were N seconds slow? The semantics are in the header
 * of src/btcCurve/pairsReplay.ts; this script only reads flags, reads the day files and prints.
 *
 * Read-only and offline: it opens the cycle files (gaps-YYYY-MM-DD.jsonl or .jsonl.gz) and
 * nothing else. No venue is called, nothing is written, no credentials are loaded.
 *
 * Run:  npx tsx services/api/scripts/btcPairsReplay.ts --dir /var/data/btc-curve/pairs --lag 0,10,30,60
 *
 * Flags (each also as --flag=value):
 *   --dir <path>        the pairs data dir, or the curve data dir that holds it as pairs/
 *                       (default BTC_PAIRS_DATA_DIR, else <BTC_CURVE_DATA_DIR>/pairs, else /tmp/btc-pairs)
 *   --from YYYY-MM-DD   first UTC day (default: the oldest day on disk)
 *   --to YYYY-MM-DD     last UTC day (default: the newest day on disk)
 *   --days N            the last N UTC days, today included (instead of --from)
 *   --edge C            least lock that is a signal, cents per $1 pair after both fees (default 1)
 *   --size N            least size at the top of both books for a signal, contracts (default 10)
 *   --trade N           size traded, contracts (default: the same as --size)
 *   --lag S[,S...]      seconds from signal to fill, a list (default 10; 0 is the upper bound)
 *   --age S             a read older than this is not acted on, seconds (default 30)
 *   --horizons LIST     15m, 1h, 1d (default all three)
 *   --tolerance S       how late past one interval the fill cycle may be, seconds (default 5)
 *   --trades N          list the first N trades per lag (default 0)
 *   --json              print the result as JSON instead of the table
 *
 * Exit code 0 with a result, 2 when the request is refused.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { listDayFiles } from "../src/btcCurve/dayFiles";
import { CYCLE_FAMILY, ReplayRefused, firstDayOf, replayDays, replayRequestFrom, replayText } from "../src/btcCurve/pairsReplayLoader";

const FLAGS = new Set(["dir", "from", "to", "days", "edge", "size", "trade", "lag", "age", "horizons", "tolerance", "trades"]);
const MAX_LAGS = 24;
const MAX_LAG_SEC = 86_400;

function readFlags(argv: string[]): { values: Map<string, string>; json: boolean } {
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m || !FLAGS.has(m[1])) throw new ReplayRefused(`"${arg}" is not a flag this replay knows. See the header of scripts/btcPairsReplay.ts.`);
    const value = m[2] ?? argv[(i += 1)];
    if (value === undefined) throw new ReplayRefused(`--${m[1]} needs a value.`);
    if (values.has(m[1])) throw new ReplayRefused(`--${m[1]} is given twice.`);
    values.set(m[1], value);
  }
  return { values, json };
}

/** The dir that holds the cycle files: the one named, or its pairs/ when the curve data dir was named. */
function cycleDir(named: string): string {
  const dir = resolve(named);
  if (!existsSync(dir)) throw new ReplayRefused(`${dir} does not exist.`);
  if (listDayFiles(dir, [CYCLE_FAMILY]).length) return dir;
  const inner = join(dir, "pairs");
  if (existsSync(inner) && listDayFiles(inner, [CYCLE_FAMILY]).length) return inner;
  return dir;
}

async function main(): Promise<void> {
  const { values, json } = readFlags(process.argv.slice(2));
  const req = replayRequestFrom((name) => values.get(name), { maxLags: MAX_LAGS, maxLagSec: MAX_LAG_SEC });
  if (req.days !== null && values.has("from")) throw new ReplayRefused("Give --days or --from, not both.");
  const trades = values.get("trades");
  if (trades !== undefined && !/^[0-9]+$/.test(trades)) throw new ReplayRefused(`--trades is "${trades}", which is not a whole number.`);
  const named = values.get("dir") ?? process.env.BTC_PAIRS_DATA_DIR ?? (process.env.BTC_CURVE_DATA_DIR ? join(process.env.BTC_CURVE_DATA_DIR, "pairs") : "/tmp/btc-pairs");
  const dir = cycleDir(named);
  const run = await replayDays({
    dir,
    fromDay: req.days !== null ? firstDayOf(req.days, Date.now()) : values.get("from"),
    toDay: values.get("to"),
    rules: req.rules,
    keepTrades: trades === undefined ? 0 : Number(trades),
  });
  process.stdout.write(json ? `${JSON.stringify({ ok: true, dir, ...run }, null, 2)}\n` : replayText(run, { dir, trades: trades !== undefined && Number(trades) > 0 }));
}

main().catch((err) => {
  if (err instanceof ReplayRefused) {
    process.stderr.write(`Refused: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
});
