import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DeribitConnector } from "@foxify/connectors";
import {
  buildLiveDeribitComparisonInputs,
  comparePricingModels,
  comparisonRowsToCsv,
  parseComparisonInputFixture
} from "../src/pilot/modelComparison";

type Args = {
  fixturePath: string | null;
  outJsonPath: string | null;
  outCsvPath: string | null;
  liveDeribit: boolean;
};

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    fixturePath: null,
    outJsonPath: null,
    outCsvPath: null,
    liveDeribit: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--fixture" && argv[i + 1]) {
      args.fixturePath = argv[i + 1];
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
    if (token === "--live-deribit") {
      args.liveDeribit = true;
      continue;
    }
  }
  return args;
};

const resolveDeribitEnv = (): "testnet" | "live" => {
  const env = String(process.env.DERIBIT_ENV || "live").trim().toLowerCase();
  return env === "testnet" ? "testnet" : "live";
};

const loadFixtureInputs = async (fixturePath: string) => {
  const raw = await readFile(fixturePath, "utf8");
  const parsed = JSON.parse(raw);
  return parseComparisonInputFixture(parsed);
};

const loadInputs = async (args: Args) => {
  if (args.fixturePath) {
    return await loadFixtureInputs(args.fixturePath);
  }
  if (!args.liveDeribit) {
    throw new Error("compare_models_requires_fixture_or_live_deribit");
  }
  const scenarioSeed = [
    { scenarioId: "bronze_5k_1k", tierName: "Pro (Bronze)", protectedNotionalUsd: 5000, tenorDays: 7 },
    { scenarioId: "silver_5k_750", tierName: "Pro (Silver)", protectedNotionalUsd: 5000, tenorDays: 7 },
    { scenarioId: "gold_5k_600", tierName: "Pro (Gold)", protectedNotionalUsd: 5000, tenorDays: 7 }
  ];
  const deribit = new DeribitConnector(resolveDeribitEnv(), true);
  return await buildLiveDeribitComparisonInputs({ deribit, scenarios: scenarioSeed });
};

const ensureParentDir = async (targetPath: string) => {
  const fs = await import("node:fs/promises");
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const inputs = await loadInputs(args);
  const comparison = comparePricingModels(inputs);
  const outJson = args.outJsonPath || "artifacts/pilot-model-compare.json";
  const outCsv = args.outCsvPath || "artifacts/pilot-model-compare.csv";
  await ensureParentDir(outJson);
  await ensureParentDir(outCsv);
  await writeFile(outJson, JSON.stringify(comparison, null, 2));
  await writeFile(outCsv, comparisonRowsToCsv(comparison.rows));
  const summary = comparison.summary;
  console.log(
    JSON.stringify(
      {
        status: "ok",
        asOfIso: comparison.asOfIso,
        rows: summary.nRows,
        strictMeanPremiumUsd: summary.strictMeanPremiumUsd,
        hybridMeanPremiumUsd: summary.hybridMeanPremiumUsd,
        meanDeltaUsd: summary.meanDeltaUsd,
        medianDeltaUsd: summary.medianDeltaUsd,
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
        reason: "compare_models_failed",
        message: String(error?.message || error || "unknown_error")
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
