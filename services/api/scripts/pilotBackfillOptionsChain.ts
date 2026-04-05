import { pilotConfig } from "../src/pilot/config";
import { ensurePilotSchema, getPilotPool, insertOptionsChainSnapshot } from "../src/pilot/db";

const parseArgs = (argv: string[]): { venue: string; marketId: string; source: string } => {
  const out = { venue: "falconx", marketId: "BTC-USD", source: "manual_backfill" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--venue" && argv[i + 1]) {
      out.venue = String(argv[i + 1]).trim();
      i += 1;
      continue;
    }
    if (token === "--market" && argv[i + 1]) {
      out.marketId = String(argv[i + 1]).trim();
      i += 1;
      continue;
    }
    if (token === "--source" && argv[i + 1]) {
      out.source = String(argv[i + 1]).trim();
      i += 1;
      continue;
    }
  }
  return out;
};

async function main() {
  if (!pilotConfig.postgresUrl) {
    throw new Error("postgres_url_missing");
  }
  const args = parseArgs(process.argv.slice(2));
  const pool = getPilotPool(pilotConfig.postgresUrl);
  await ensurePilotSchema(pool);
  const nowIso = new Date().toISOString();
  await insertOptionsChainSnapshot(pool, {
    venue: args.venue,
    marketId: args.marketId,
    asOfTs: nowIso,
    tenorDays: 7,
    strike: "0",
    optionRight: "P",
    bidPxUsd: "0",
    askPxUsd: "0",
    markPxUsd: "0",
    iv: null,
    delta: null,
    gamma: null,
    vega: null,
    theta: null,
    bidSize: null,
    askSize: null,
    source: args.source,
    metadata: { seeded: true }
  });
  await pool.end();
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      status: "ok",
      script: "pilotBackfillOptionsChain",
      venue: args.venue,
      marketId: args.marketId,
      asOfIso: nowIso
    })
  );
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ status: "error", reason: String(error?.message || error) }));
  process.exit(1);
});
