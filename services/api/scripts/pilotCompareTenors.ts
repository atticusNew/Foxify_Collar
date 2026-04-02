import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DeribitConnector } from "@foxify/connectors";
import { compareLiveDeribitByTenor } from "../src/pilot/tenorComparison";

type Args = {
  tenors: number[];
  notionals: number[];
  tiers: string[];
  outJsonPath: string | null;
  outCsvPath: string | null;
};

const parseNumberList = (raw: string, fallback: number[]): number[] => {
  const cleaned = String(raw || "")
    .trim()
    .replace(/\s+/g, "");
  if (!cleaned) return fallback.slice();
  const parsed = cleaned
    .split(",")
    .filter(Boolean)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.floor(item));
  return parsed.length ? Array.from(new Set(parsed)).sort((a, b) => a - b) : fallback.slice();
};

const parseStringList = (raw: string, fallback: string[]): string[] => {
  const cleaned = String(raw || "").trim();
  if (!cleaned) return fallback.slice();
  const parsed = cleaned
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length ? parsed : fallback.slice();
};

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    tenors: [14, 21, 28],
    notionals: [5000],
    tiers: ["Pro (Bronze)", "Pro (Silver)", "Pro (Gold)"],
    outJsonPath: null,
    outCsvPath: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--tenors" && argv[i + 1]) {
      args.tenors = parseNumberList(argv[i + 1], args.tenors);
      i += 1;
      continue;
    }
    if (token === "--notionals" && argv[i + 1]) {
      args.notionals = parseNumberList(argv[i + 1], args.notionals);
      i += 1;
      continue;
    }
    if (token === "--tiers" && argv[i + 1]) {
      args.tiers = parseStringList(argv[i + 1], args.tiers);
      i += 1;
      continue;
    }
    if (token === "--out-json" && argv[i + 1]) {
      args.outJsonPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--out-csv" && argv[i + 1]) {
      args.outCsvPath = argv[i + 1];
      i += 1;
      continue;
    }
  }
  return args;
};

const resolveDeribitEnv = (): "testnet" | "live" => {
  const env = String(process.env.DERIBIT_ENV || "live").trim().toLowerCase();
  return env === "testnet" ? "testnet" : "live";
};

const ensureParentDir = async (targetPath: string) => {
  const fs = await import("node:fs/promises");
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
};

const rowsToCsv = (rows: Array<Record<string, unknown>>): string => {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (value: string) =>
    value.includes(",") || value.includes("\"") || value.includes("\n")
      ? `"${value.replace(/"/g, "\"\"")}"`
      : value;
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      headers
        .map((header) => {
          const value = row[header];
          if (value === null || value === undefined) return "";
          return escape(String(value));
        })
        .join(",")
    );
  }
  return lines.join("\n");
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const env = resolveDeribitEnv();
  const deribit = new DeribitConnector(env, true);
  const output = await compareLiveDeribitByTenor({
    deribit,
    env,
    tenorsDays: args.tenors,
    notionalsUsd: args.notionals,
    tiers: args.tiers
  });

  const outJson = args.outJsonPath || "artifacts/pilot-tenor-compare.json";
  const outCsv = args.outCsvPath || "artifacts/pilot-tenor-compare.csv";
  await ensureParentDir(outJson);
  await ensureParentDir(outCsv);
  await writeFile(outJson, JSON.stringify(output, null, 2));
  await writeFile(outCsv, rowsToCsv(output.rows as unknown as Array<Record<string, unknown>>));

  console.log(
    JSON.stringify(
      {
        status: "ok",
        asOfIso: output.asOfIso,
        venue: output.venue,
        env: output.env,
        spotPriceUsd: output.spotPriceUsd,
        tenorsRequestedDays: output.tenorsRequestedDays,
        notionalsUsd: output.notionalsUsd,
        summaryByTenor: output.summaryByTenor,
        outJson,
        outCsv
      },
      null,
      2
    )
  );
};

main().catch((error: any) => {
  console.error(
    JSON.stringify(
      {
        status: "error",
        reason: "compare_tenors_failed",
        message: String(error?.message || error || "unknown_error")
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
