import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  ensurePilotSchema,
  getPilotPool,
  insertRfqFill,
  insertRfqQuote
} from "../src/pilot/db";

type Args = {
  inputPath: string;
};

type RfqHistoryInput = {
  quotes?: Array<Record<string, unknown>>;
  fills?: Array<Record<string, unknown>>;
};

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    inputPath: "artifacts/backtest/ingestion/rfq_history.json"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--input" && argv[i + 1]) {
      args.inputPath = argv[i + 1];
      i += 1;
    }
  }
  return args;
};

const asString = (value: unknown, fallback = ""): string => {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
};

const asNumberString = (value: unknown, fallback = "0"): string => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return String(n);
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const raw = await readFile(args.inputPath, "utf8");
  const payload = JSON.parse(raw) as RfqHistoryInput;
  const quotes = Array.isArray(payload.quotes) ? payload.quotes : [];
  const fills = Array.isArray(payload.fills) ? payload.fills : [];

  const postgresUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
  if (!postgresUrl) throw new Error("postgres_url_missing");
  const pool = getPilotPool(postgresUrl);
  await ensurePilotSchema(pool);

  let insertedQuotes = 0;
  let insertedFills = 0;
  for (const row of quotes) {
    await insertRfqQuote(pool, {
      venue: asString(row.venue, "falconx"),
      quoteId: asString(row.quoteId),
      rfqId: asString(row.rfqId) || null,
      marketId: asString(row.marketId, "BTC-USD"),
      instrumentId: asString(row.instrumentId) || null,
      side: asString(row.side, "buy") as "buy" | "sell",
      quantity: asNumberString(row.quantity),
      quotePxUsd: asNumberString(row.premium),
      quoteTs: asString(row.quoteTs, new Date().toISOString()),
      expiresTs: asString(row.expiresTs) || null,
      source: asString(row.source) || "rfq_backfill",
      metadata: (row.details as Record<string, unknown>) || {}
    });
    insertedQuotes += 1;
  }
  for (const row of fills) {
    await insertRfqFill(pool, {
      venue: asString(row.venue, "falconx"),
      fillId: asString(row.fillId),
      quoteId: asString(row.quoteId) || null,
      rfqId: asString(row.rfqId) || null,
      marketId: asString(row.marketId, "BTC-USD"),
      instrumentId: asString(row.instrumentId) || null,
      side: asString(row.side, "buy") as "buy" | "sell",
      quantity: asNumberString(row.quantity),
      fillPxUsd: asNumberString(row.executionPrice),
      fillTs: asString(row.fillTs, new Date().toISOString()),
      feeUsd: row.feeUsd === undefined ? null : asNumberString(row.feeUsd),
      slippageBps: row.slippageBps === undefined ? null : asNumberString(row.slippageBps),
      source: asString(row.source) || "rfq_backfill",
      metadata: (row.details as Record<string, unknown>) || {}
    });
    insertedFills += 1;
  }

  const outDir = path.dirname(args.inputPath);
  await mkdir(outDir, { recursive: true });
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        status: "ok",
        inputPath: args.inputPath,
        insertedQuotes,
        insertedFills
      },
      null,
      2
    )
  );
  await pool.end();
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify(
      {
        status: "error",
        reason: "pilot_backfill_rfq_failed",
        message: String((error as Error)?.message || error)
      },
      null,
      2
    )
  );
  process.exit(1);
});

