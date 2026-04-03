import { readFile } from "node:fs/promises";
import path from "node:path";
import { pilotConfig } from "../src/pilot/config";
import { ensurePilotSchema, getPilotPool, upsertExecutionQualityDaily } from "../src/pilot/db";

type Args = {
  inputPath: string;
};

type Row = {
  day: string;
  venue: string;
  hedgeMode: string;
  avgSlippageBps?: number;
  p95SlippageBps?: number;
  fillSuccessRatePct?: number;
  avgSpreadPct?: number;
  avgTopBookDepth?: number;
  sampleCount?: number;
  metadata?: Record<string, unknown>;
};

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    inputPath: "artifacts/backtest/execution_quality_daily.json"
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--input" && argv[i + 1]) {
      args.inputPath = argv[i + 1];
      i += 1;
    }
  }
  return args;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!pilotConfig.postgresUrl) {
    throw new Error("postgres_url_missing");
  }
  const raw = await readFile(path.resolve(args.inputPath), "utf8");
  const payload = JSON.parse(raw);
  const rows: Row[] = Array.isArray(payload) ? payload : [];
  const pool = getPilotPool(pilotConfig.postgresUrl);
  await ensurePilotSchema(pool);
  let written = 0;
  for (const row of rows) {
    if (!row?.day || !row?.venue || !row?.hedgeMode) continue;
    await upsertExecutionQualityDaily(pool, {
      day: String(row.day),
      venue: String(row.venue),
      hedgeMode: String(row.hedgeMode) as "options_native" | "futures_synthetic",
      avgSlippageBps: Number.isFinite(Number(row.avgSlippageBps)) ? String(row.avgSlippageBps) : null,
      p95SlippageBps: Number.isFinite(Number(row.p95SlippageBps)) ? String(row.p95SlippageBps) : null,
      fillSuccessRatePct:
        Number.isFinite(Number(row.fillSuccessRatePct)) ? String(row.fillSuccessRatePct) : null,
      avgSpreadPct: Number.isFinite(Number(row.avgSpreadPct)) ? String(row.avgSpreadPct) : null,
      avgTopBookDepth: Number.isFinite(Number(row.avgTopBookDepth)) ? String(row.avgTopBookDepth) : null,
      sampleCount: Math.max(0, Number(row.sampleCount ?? 0)),
      metadata: row.metadata || {}
    });
    written += 1;
  }
  await pool.end();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ status: "ok", inputPath: args.inputPath, rows: written }));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ status: "error", reason: "pilot_backfill_execution_quality_failed", message: String((error as Error)?.message || error) }));
  process.exit(1);
});
